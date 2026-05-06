<?php

namespace App\Services;

use Gemini\Data\Blob;
use Gemini\Data\Content;
use Gemini\Enums\MimeType;
use Gemini\Factory;
use GuzzleHttp\Client as GuzzleClient;
use Illuminate\Support\Facades\Log;
use OpenAI;

/**
 * AI for automation: Gemini primary, Mistral secondary, OpenAI third.
 * Models are configured dynamically via .env file using:
 * - GEMINI_MODEL
 * - MISTRAL_MODEL  
 * - OPENAI_MODEL
 */
class AiService
{
    private ?string $lastError = null;

    public function __construct(
        private readonly string $primary = 'gemini',
        private readonly string $secondary = 'mistral',
        private readonly string $tertiary = 'openai'
    ) {}

    /**
     * Last error message from generate() when it returns null (e.g. missing API key, quota, network).
     */
    public function getLastError(): ?string
    {
        return $this->lastError;
    }

    /**
     * Generate text using the selected UI provider first, then OpenAI, then Mistral.
     *
     * @param  string       $prompt        The user/main prompt content.
     * @param  string|null  $provider      Preferred AI provider (gemini, openai, mistral).
     * @param  string|null  $systemPrompt  Optional system-level instructions sent separately
     *                                     so they are not repeated in every user turn and can
     *                                     be cached by the provider (Gemini systemInstruction,
     *                                     OpenAI/Mistral system role).
     */
    public function generate(string $prompt, ?string $provider = null, ?string $systemPrompt = null): ?string
    {
        $this->lastError = null;
        $providers = $this->getProviderChain($provider);

        foreach ($providers as $index => $currentProvider) {
            try {
                return $this->generateWithProvider($currentProvider, $prompt, $systemPrompt);
            } catch (\Throwable $e) {
                $this->lastError = $e->getMessage();

                if ($index === 0) {
                    Log::warning('Automation AI primary failed', [
                        'provider' => $currentProvider,
                        'error' => $this->lastError,
                    ]);
                } elseif ($index === 1) {
                    Log::warning('Automation AI secondary fallback failed', [
                        'provider' => $currentProvider,
                        'error' => $this->lastError,
                    ]);
                } else {
                    Log::error('Automation AI tertiary fallback failed', [
                        'provider' => $currentProvider,
                        'error' => $this->lastError,
                    ]);
                }
            }
        }

        return null;
    }

    /**
     * Generate text with vision capabilities using the selected UI provider.
     */
    public function generateVision(string $prompt, string $imageBase64, ?string $provider = null, ?string $systemPrompt = null): ?string
    {
        $this->lastError = null;
        $providers = $this->getProviderChain($provider);

        foreach ($providers as $index => $currentProvider) {
            try {
                return $this->generateVisionWithProvider($currentProvider, $prompt, $imageBase64, $systemPrompt);
            } catch (\Throwable $e) {
                $this->lastError = $e->getMessage();

                if ($index === 0) {
                    Log::warning('Automation AI Vision primary failed', [
                        'provider' => $currentProvider,
                        'error' => $this->lastError,
                    ]);
                } else {
                    Log::error('Automation AI Vision fallback failed', [
                        'provider' => $currentProvider,
                        'error' => $this->lastError,
                    ]);
                }
            }
        }

        return null;
    }

    /**
     * Build the provider order using the selected provider, then OpenAI, then Mistral.
     */
    private function getProviderChain(?string $provider = null): array
    {
        $supported = ['gemini', 'mistral', 'openai'];
        $selectedProvider = $provider ?? config('automation.primary_ai', 'gemini');

        $ordered = array_filter([
            $selectedProvider,
            'openai',
            'mistral',
            'gemini',
        ], fn ($value) => is_string($value) && $value !== '');

        $providers = [];
        foreach ($ordered as $candidate) {
            if (in_array($candidate, $supported, true) && ! in_array($candidate, $providers, true)) {
                $providers[] = $candidate;
            }
        }

        return $providers;
    }

    /**
     * Generate with a specific provider.
     */
    private function generateWithProvider(string $provider, string $prompt, ?string $systemPrompt = null): string
    {
        return match($provider) {
            'gemini' => $this->generateWithGemini($prompt, $systemPrompt),
            'mistral' => $this->generateWithMistral($prompt, $systemPrompt),
            'openai' => $this->generateWithOpenAI($prompt, $systemPrompt),
            default => throw new \RuntimeException("Unknown provider: {$provider}"),
        };
    }

    /**
     * Generate vision with a specific provider.
     */
    private function generateVisionWithProvider(string $provider, string $prompt, string $imageBase64, ?string $systemPrompt = null): string
    {
        return match($provider) {
            'gemini' => $this->generateVisionWithGemini($prompt, $imageBase64, $systemPrompt),
            'mistral' => throw new \RuntimeException("Mistral vision not fully supported yet, falling back"),
            'openai' => $this->generateVisionWithOpenAI($prompt, $imageBase64, $systemPrompt),
            default => throw new \RuntimeException("Unknown provider: {$provider}"),
        };
    }

    /**
     * Validate that required configuration is present before making API calls.
     */
    public function validateConfig(?string $provider = null): array
    {
        $errors = [];
        $providers = $this->getProviderChain($provider);

        foreach ($providers as $currentProvider) {
            match ($currentProvider) {
                'gemini' => $this->appendProviderErrors(
                    $errors,
                    'GEMINI_API_KEY is not configured',
                    config('gemini.api_key'),
                    'GEMINI_MODEL is not configured in .env',
                    config('automation.gemini_model')
                ),
                'mistral' => $this->appendProviderErrors(
                    $errors,
                    'MISTRAL_API_KEY is not configured',
                    config('mistral.api_key'),
                    'MISTRAL_MODEL is not configured in .env',
                    config('automation.mistral_model')
                ),
                'openai' => $this->appendProviderErrors(
                    $errors,
                    'OPENAI_API_KEY is not configured',
                    config('openai.api_key'),
                    'OPENAI_MODEL is not configured in .env',
                    config('automation.openai_model')
                ),
                default => null,
            };
        }

        return $errors;
    }

    /**
     * Append provider validation errors to the given error list.
     */
    private function appendProviderErrors(
        array &$errors,
        string $missingKeyMessage,
        mixed $apiKey,
        string $missingModelMessage,
        mixed $model
    ): void {
        if (empty($apiKey)) {
            $errors[] = $missingKeyMessage;
        }

        if (empty($model)) {
            $errors[] = $missingModelMessage;
        }
    }

    /**
     * Get a configured Guzzle client with SSL verification settings.
     */
    private function getGuzzleClient(array $extraOptions = []): GuzzleClient
    {
        $sslVerifyDisabled = filter_var(env('CURL_SSL_VERIFY_DISABLED', true), FILTER_VALIDATE_BOOLEAN);

        $timeout = config('gemini.request_timeout', 30);
        $options = [];
        if ($timeout > 0) {
            $options['timeout'] = $timeout;
        }

        if ($sslVerifyDisabled) {
            $options['verify'] = false;
        }

        return new GuzzleClient(array_merge($options, $extraOptions));
    }

    public function generateWithGemini(string $prompt, ?string $systemPrompt = null): string
    {
        $apiKey = config('gemini.api_key');
        if (empty($apiKey)) {
            throw new \RuntimeException('GEMINI_API_KEY is not configured or empty');
        }

        $model = config('automation.gemini_model');
        Log::debug('Calling Gemini API', [
            'model' => $model,
            'prompt_length' => strlen($prompt),
            'system_prompt_length' => $systemPrompt ? strlen($systemPrompt) : 0,
        ]);

        try {
            $guzzleClient = $this->getGuzzleClient();
            $geminiClient = (new Factory())
                ->withHttpClient($guzzleClient)
                ->withApiKey($apiKey)
                ->make();

            $generativeModel = $geminiClient->generativeModel($model);
            if ($systemPrompt) {
                $result = $generativeModel->generateContent([
                    Content::part($systemPrompt),
                    Content::part($prompt),
                ]);
            } else {
                $result = $generativeModel->generateContent($prompt);
            }

            $text = $result->text();
            Log::debug('Gemini API response received', ['response_length' => strlen($text)]);
            return $text;
        } catch (\Exception $e) {
            $errorMsg = $e->getMessage();
            if (str_contains($errorMsg, 'SSL certificate problem') ||
                str_contains($errorMsg, 'cURL error 60') ||
                str_contains($errorMsg, 'unable to get local issuer') ||
                str_contains($errorMsg, 'curl error')) {
                Log::error('SSL Certificate Error', ['error' => $errorMsg]);
                throw new \RuntimeException('SSL certificate error: '.$errorMsg.'. Set CURL_SSL_VERIFY_DISABLED=true in .env for development.');
            }
            Log::error('Gemini API call failed', [
                'model' => $model,
                'error' => $errorMsg,
                'exception_class' => get_class($e),
            ]);
            throw $e;
        }
    }

    public function generateVisionWithGemini(string $prompt, string $imageBase64, ?string $systemPrompt = null): string
    {
        $apiKey = config('gemini.api_key');
        if (empty($apiKey)) {
            throw new \RuntimeException('GEMINI_API_KEY is not configured or empty');
        }

        $model = config('automation.gemini_model');
        Log::debug('Calling Gemini Vision API', ['model' => $model, 'prompt_length' => strlen($prompt)]);

        try {
            $guzzleClient = $this->getGuzzleClient();
            $geminiClient = (new Factory())
                ->withHttpClient($guzzleClient)
                ->withApiKey($apiKey)
                ->make();

            $generativeModel = $geminiClient->generativeModel($model);
            
            $b64Data = preg_replace('#^data:image/[^;]+;base64,#', '', $imageBase64);
            $blob = new Blob(MimeType::IMAGE_JPEG, $b64Data);

            if ($systemPrompt) {
                $result = $generativeModel->generateContent([
                    Content::part($systemPrompt),
                    Content::parse([$prompt, $blob]),
                ]);
            } else {
                $result = $generativeModel->generateContent(Content::parse([$prompt, $blob]));
            }

            $text = $result->text();
            Log::debug('Gemini Vision API response received', ['response_length' => strlen($text)]);
            return $text;
        } catch (\Exception $e) {
            Log::error('Gemini Vision API call failed', ['model' => $model, 'error' => $e->getMessage()]);
            throw $e;
        }
    }

    public function generateWithMistral(string $prompt, ?string $systemPrompt = null): string
    {
        $apiKey = config('mistral.api_key');
        if (empty($apiKey)) {
            throw new \RuntimeException('MISTRAL_API_KEY is not configured or empty');
        }

        $model = config('automation.mistral_model');
        Log::debug('Calling Mistral API', [
            'model' => $model,
            'prompt_length' => strlen($prompt),
            'system_prompt_length' => $systemPrompt ? strlen($systemPrompt) : 0,
        ]);

        try {
            $guzzleClient = $this->getGuzzleClient();

            $messages = [];
            if ($systemPrompt) {
                $messages[] = ['role' => 'system', 'content' => $systemPrompt];
            }
            $messages[] = ['role' => 'user', 'content' => $prompt];

            $response = $guzzleClient->post('https://api.mistral.ai/v1/chat/completions', [
                'json' => [
                    'model' => $model,
                    'messages' => $messages,
                ],
                'headers' => [
                    'Authorization' => 'Bearer ' . $apiKey,
                    'Content-Type' => 'application/json',
                ],
            ]);

            $body = json_decode((string) $response->getBody(), true);

            if (isset($body['error'])) {
                throw new \RuntimeException('Mistral API error: ' . ($body['error']['message'] ?? json_encode($body['error'])));
            }

            $content = $body['choices'][0]['message']['content'] ?? '';
            return is_string($content) ? $content : '';
        } catch (\Exception $e) {
            $errorMsg = $e->getMessage();
            if (str_contains($errorMsg, 'SSL certificate problem') ||
                str_contains($errorMsg, 'cURL error 60') ||
                str_contains($errorMsg, 'unable to get local issuer') ||
                str_contains($errorMsg, 'curl error')) {
                Log::error('SSL Certificate Error', ['error' => $errorMsg]);
                throw new \RuntimeException('SSL certificate error: '.$errorMsg.'. Set CURL_SSL_VERIFY_DISABLED=true in .env for development.');
            }
            Log::error('Mistral API call failed', [
                'model' => $model,
                'error' => $errorMsg,
                'exception_class' => get_class($e),
            ]);
            throw $e;
        }
    }

    public function generateWithOpenAI(string $prompt, ?string $systemPrompt = null): string
    {
        $apiKey = config('openai.api_key');
        if (empty($apiKey)) {
            throw new \RuntimeException('OPENAI_API_KEY is not configured or empty');
        }

        $model = config('automation.openai_model');
        Log::debug('Calling OpenAI API', [
            'model' => $model,
            'prompt_length' => strlen($prompt),
            'system_prompt_length' => $systemPrompt ? strlen($systemPrompt) : 0,
        ]);

        try {
            $client = OpenAI::client($apiKey);

            $messages = [];
            if ($systemPrompt) {
                $messages[] = ['role' => 'system', 'content' => $systemPrompt];
            }
            $messages[] = ['role' => 'user', 'content' => $prompt];

            $response = $client->chat()->create([
                'model' => $model,
                'messages' => $messages,
            ]);

            $content = $response->choices[0]->message->content;
            return is_string($content) ? $content : '';
        } catch (\Exception $e) {
            $errorMsg = $e->getMessage();
            if (str_contains($errorMsg, 'SSL certificate problem') ||
                str_contains($errorMsg, 'cURL error 60') ||
                str_contains($errorMsg, 'unable to get local issuer') ||
                str_contains($errorMsg, 'curl error')) {
                Log::error('SSL Certificate Error', ['error' => $errorMsg]);
                throw new \RuntimeException('SSL certificate error: '.$errorMsg.'. Set CURL_SSL_VERIFY_DISABLED=true in .env for development.');
            }
            Log::error('OpenAI API call failed', [
                'model' => $model,
                'error' => $errorMsg,
                'exception_class' => get_class($e),
            ]);
            throw $e;
        }
    }

    public function generateVisionWithOpenAI(string $prompt, string $imageBase64, ?string $systemPrompt = null): string
    {
        $apiKey = config('openai.api_key');
        if (empty($apiKey)) {
            throw new \RuntimeException('OPENAI_API_KEY is not configured or empty');
        }

        $model = config('automation.openai_model');
        Log::debug('Calling OpenAI Vision API', ['model' => $model, 'prompt_length' => strlen($prompt)]);

        try {
            $client = OpenAI::client($apiKey);
            
            $dataUri = $imageBase64;
            if (!str_starts_with($imageBase64, 'data:image')) {
                $dataUri = 'data:image/jpeg;base64,' . $imageBase64;
            }

            $messages = [];
            if ($systemPrompt) {
                $messages[] = ['role' => 'system', 'content' => $systemPrompt];
            }
            $messages[] = [
                'role' => 'user', 
                'content' => [
                    ['type' => 'text', 'text' => $prompt],
                    ['type' => 'image_url', 'image_url' => ['url' => $dataUri]]
                ]
            ];

            $response = $client->chat()->create([
                'model' => $model,
                'messages' => $messages,
            ]);

            $content = $response->choices[0]->message->content;
            return is_string($content) ? $content : '';
        } catch (\Exception $e) {
            Log::error('OpenAI Vision API call failed', ['model' => $model, 'error' => $e->getMessage()]);
            throw $e;
        }
    }
}
