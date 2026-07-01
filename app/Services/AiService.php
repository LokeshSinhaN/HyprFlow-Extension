<?php

namespace App\Services;

use Gemini\Data\Blob;
use Gemini\Data\Content;
use Gemini\Data\GenerationConfig;
use Gemini\Enums\MimeType;
use Gemini\Enums\ResponseMimeType;
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
     * @param  string  $prompt  The user/main prompt content.
     * @param  string|null  $provider  Preferred AI provider (gemini, openai, mistral).
     * @param  string|null  $systemPrompt  Optional system-level instructions sent separately
     *                                     so they are not repeated in every user turn and can
     *                                     be cached by the provider (Gemini systemInstruction,
     *                                     OpenAI/Mistral system role).
     */
    public function generate(string $prompt, ?string $provider = null, ?string $systemPrompt = null): ?string
    {
        $this->lastError = null;
        $chain = $this->getProviderChain($provider);
        $maxRetries = max(1, (int) config('automation.provider_max_retries', 2));

        // Walk the provider chain; each provider gets bounded retries with backoff
        // before we fall through to the next configured provider.
        foreach ($chain as $currentProvider) {
            for ($attempt = 1; $attempt <= $maxRetries; $attempt++) {
                try {
                    return $this->generateWithProvider($currentProvider, $prompt, $systemPrompt);
                } catch (\Throwable $e) {
                    $this->lastError = $e->getMessage();

                    Log::warning("AI provider '{$currentProvider}' attempt {$attempt}/{$maxRetries} failed", [
                        'provider' => $currentProvider,
                        'error' => $this->lastError,
                        'attempt' => $attempt,
                    ]);

                    // Exponential backoff between retries of the SAME provider (1s, 2s, 4s)
                    if ($attempt < $maxRetries) {
                        usleep((int) (pow(2, $attempt - 1) * 1000000));
                    }
                }
            }
        }

        Log::error('All AI providers failed', [
            'chain' => $chain,
            'last_error' => $this->lastError,
        ]);

        return null;
    }

    /**
     * Generate text with vision capabilities using the selected UI provider.
     */
    public function generateVision(string $prompt, string $imageBase64, ?string $provider = null, ?string $systemPrompt = null): ?string
    {
        $this->lastError = null;

        // Only vision-capable providers participate (Mistral has no vision support here).
        $chain = array_values(array_filter(
            $this->getProviderChain($provider),
            fn ($p) => in_array($p, ['gemini', 'openai'], true)
        ));
        if (empty($chain)) {
            $chain = ['gemini'];
        }
        $maxRetries = max(1, (int) config('automation.provider_max_retries', 2));

        foreach ($chain as $currentProvider) {
            for ($attempt = 1; $attempt <= $maxRetries; $attempt++) {
                try {
                    return $this->generateVisionWithProvider($currentProvider, $prompt, $imageBase64, $systemPrompt);
                } catch (\Throwable $e) {
                    $this->lastError = $e->getMessage();

                    Log::warning("AI vision provider '{$currentProvider}' attempt {$attempt}/{$maxRetries} failed", [
                        'provider' => $currentProvider,
                        'error' => $this->lastError,
                        'attempt' => $attempt,
                    ]);

                    if ($attempt < $maxRetries) {
                        usleep((int) (pow(2, $attempt - 1) * 1000000));
                    }
                }
            }
        }

        Log::error('All AI vision providers failed', [
            'chain' => $chain,
            'last_error' => $this->lastError,
        ]);

        return null;
    }

    /**
     * Build the provider order using the selected provider, then OpenAI, then Mistral.
     */
    private function getProviderChain(?string $provider = null): array
    {
        $fallbackEnabled = (bool) config('automation.provider_fallback_enabled', true);
        $primary = $provider ?: config('automation.primary_ai', $this->primary);

        // Fallback disabled → behave like before: only the requested/primary provider.
        if (! $fallbackEnabled) {
            return [$primary];
        }

        // Ordered, de-duplicated preference list: requested/primary → secondary → tertiary.
        $ordered = array_values(array_unique(array_filter([
            $primary,
            config('automation.secondary_ai', $this->secondary),
            config('automation.tertiary_ai', $this->tertiary),
        ])));

        // Keep only providers that actually have an API key configured.
        $withKeys = array_values(array_filter($ordered, fn ($p) => $this->providerHasKey($p)));

        // If nothing is configured, still return the primary so a meaningful
        // "API key not configured" error surfaces to the caller.
        return ! empty($withKeys) ? $withKeys : [$primary];
    }

    /**
     * Whether the given provider has an API key configured.
     */
    private function providerHasKey(string $provider): bool
    {
        return match ($provider) {
            'gemini' => ! empty(config('gemini.api_key')),
            'openai' => ! empty(config('openai.api_key')),
            'mistral' => ! empty(config('mistral.api_key')),
            default => false,
        };
    }

    /**
     * Generate with a specific provider.
     */
    private function generateWithProvider(string $provider, string $prompt, ?string $systemPrompt = null): string
    {
        return match ($provider) {
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
        return match ($provider) {
            'gemini' => $this->generateVisionWithGemini($prompt, $imageBase64, $systemPrompt),
            'mistral' => throw new \RuntimeException('Mistral vision not fully supported yet, falling back'),
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
            $geminiClient = (new Factory)
                ->withHttpClient($guzzleClient)
                ->withApiKey($apiKey)
                ->make();

            // FORCE STRICT JSON RESPONSE via generationConfig
            // This prevents Gemini from wrapping JSON in Markdown code fences
            // (```json ... ```) which causes downstream JSON parsing crashes
            // in ReflexionService.php and ExtensionController.php
            $generativeModel = $geminiClient->generativeModel($model)
                ->withGenerationConfig(new GenerationConfig(
                    responseMimeType: ResponseMimeType::APPLICATION_JSON,
                ));

            $fullPrompt = $systemPrompt ? $systemPrompt."\n\n".$prompt : $prompt;
            $result = $generativeModel->generateContent($fullPrompt);

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
            $geminiClient = (new Factory)
                ->withHttpClient($guzzleClient)
                ->withApiKey($apiKey)
                ->make();

            $generativeModel = $geminiClient->generativeModel($model);

            $b64Data = preg_replace('#^data:image/[^;]+;base64,#', '', $imageBase64);
            $blob = new Blob(MimeType::IMAGE_JPEG, $b64Data);

            if ($systemPrompt) {
                // Combine system prompt with user prompt for vision
                $fullPrompt = $systemPrompt."\n\n".$prompt;
                $result = $generativeModel->generateContent(Content::parse([$fullPrompt, $blob]));
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

            // FORCE STRICT JSON OBJECT response format for Mistral
            // Prevents Markdown-wrapped JSON that crashes downstream parsing
            $response = $guzzleClient->post('https://api.mistral.ai/v1/chat/completions', [
                'json' => [
                    'model' => $model,
                    'messages' => $messages,
                    'response_format' => ['type' => 'json_object'],
                ],
                'headers' => [
                    'Authorization' => 'Bearer '.$apiKey,
                    'Content-Type' => 'application/json',
                ],
            ]);

            $body = json_decode((string) $response->getBody(), true);

            if (isset($body['error'])) {
                throw new \RuntimeException('Mistral API error: '.($body['error']['message'] ?? json_encode($body['error'])));
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
            $sslVerifyDisabled = filter_var(env('CURL_SSL_VERIFY_DISABLED', true), FILTER_VALIDATE_BOOLEAN);
            if ($sslVerifyDisabled) {
                $httpClient = $this->getGuzzleClient(['base_uri' => 'https://api.openai.com/v1']);
                $client = OpenAI::factory()
                    ->withApiKey($apiKey)
                    ->withHttpClient($httpClient)
                    ->make();
            } else {
                $client = OpenAI::client($apiKey);
            }

            $messages = [];
            if ($systemPrompt) {
                $messages[] = ['role' => 'system', 'content' => $systemPrompt];
            }
            $messages[] = ['role' => 'user', 'content' => $prompt];

            // FORCE STRICT JSON OBJECT response format
            // This prevents OpenAI from wrapping JSON in Markdown code fences
            // (```json ... ```) which causes downstream JSON parsing crashes.
            // OpenAI's json_object mode guarantees valid JSON output.
            $response = $client->chat()->create([
                'model' => $model,
                'messages' => $messages,
                'response_format' => ['type' => 'json_object'],
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
            $sslVerifyDisabled = filter_var(env('CURL_SSL_VERIFY_DISABLED', true), FILTER_VALIDATE_BOOLEAN);
            if ($sslVerifyDisabled) {
                $httpClient = $this->getGuzzleClient(['base_uri' => 'https://api.openai.com/v1']);
                $client = OpenAI::factory()
                    ->withApiKey($apiKey)
                    ->withHttpClient($httpClient)
                    ->make();
            } else {
                $client = OpenAI::client($apiKey);
            }

            $dataUri = $imageBase64;
            if (! str_starts_with($imageBase64, 'data:image')) {
                $dataUri = 'data:image/jpeg;base64,'.$imageBase64;
            }

            $messages = [];
            if ($systemPrompt) {
                $messages[] = ['role' => 'system', 'content' => $systemPrompt];
            }
            $messages[] = [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => $prompt],
                    ['type' => 'image_url', 'image_url' => ['url' => $dataUri]],
                ],
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

    /**
     * Compact conversation history to prevent token context explosion.
     *
     * When the message array exceeds a threshold (default: 6 turns), this method
     * iterates through older messages (excluding the system prompt and the latest
     * 2 interactions) and strips out heavy Base64 image payloads, retaining only
     * the text/thought reasoning content.
     *
     * This ensures the payload sent to the AI provider remains within token limits
     * and is strict application/json (no binary blobs inflating the request).
     *
     * @param  array  $messages  The full conversation message array.
     * @param  int  $maxTurns  Threshold after which compaction triggers (default: 6).
     * @param  int  $preserveRecent  Number of recent interactions to preserve fully (default: 2).
     * @return array The compacted message array with Base64 payloads stripped from older turns.
     */
    public function compactHistory(array $messages, int $maxTurns = 6, int $preserveRecent = 2): array
    {
        // No compaction needed if under threshold
        if (count($messages) <= $maxTurns) {
            return $messages;
        }

        $compacted = [];
        $totalMessages = count($messages);

        // Determine boundaries:
        // - Index 0 is typically the system prompt (always preserve fully)
        // - Last $preserveRecent * 2 messages are the most recent interactions (preserve fully)
        // - Everything in between gets compacted (images stripped)
        $preserveFromEnd = $preserveRecent * 2; // Each "interaction" = user + assistant message
        $compactionEndIndex = $totalMessages - $preserveFromEnd;

        Log::debug('Compacting conversation history', [
            'total_messages' => $totalMessages,
            'compaction_threshold' => $maxTurns,
            'preserve_recent' => $preserveRecent,
            'compaction_range' => "1 to {$compactionEndIndex}",
        ]);

        $strippedCount = 0;

        foreach ($messages as $index => $message) {
            // Always preserve the system prompt (first message) and recent messages fully
            if ($index === 0 || $index >= $compactionEndIndex) {
                $compacted[] = $message;

                continue;
            }

            // For older messages in the compaction range: strip Base64 image data
            $compacted[] = $this->stripImagePayloads($message, $strippedCount);
        }

        if ($strippedCount > 0) {
            Log::info('Context compaction complete', [
                'stripped_images' => $strippedCount,
                'original_count' => $totalMessages,
                'compacted_count' => count($compacted),
            ]);
        }

        return $compacted;
    }

    /**
     * Strip Base64 image payloads from a single message while preserving text content.
     *
     * Handles multiple message content formats:
     * - OpenAI multi-part content (array with type: 'image_url')
     * - Inline base64 strings in content fields
     * - Image data in nested tool/function results
     *
     * @param  array  $message  A single message from the conversation.
     * @param  int  &$strippedCount  Counter incremented for each stripped image.
     * @return array The message with image payloads replaced by placeholders.
     */
    private function stripImagePayloads(array $message, int &$strippedCount): array
    {
        // Handle OpenAI-style multi-part content arrays
        if (isset($message['content']) && is_array($message['content'])) {
            $filteredContent = [];
            foreach ($message['content'] as $part) {
                if (is_array($part)) {
                    // Strip image_url parts entirely, keep text parts
                    if (isset($part['type']) && $part['type'] === 'image_url') {
                        $strippedCount++;
                        $filteredContent[] = [
                            'type' => 'text',
                            'text' => '[IMAGE STRIPPED FOR CONTEXT COMPACTION]',
                        ];
                    } else {
                        $filteredContent[] = $part;
                    }
                } else {
                    $filteredContent[] = $part;
                }
            }
            $message['content'] = $filteredContent;

            // If only one text part remains, flatten to string for cleaner JSON
            if (count($filteredContent) === 1 && isset($filteredContent[0]['type']) && $filteredContent[0]['type'] === 'text') {
                $message['content'] = $filteredContent[0]['text'];
            }
        }

        // Handle inline base64 strings in content (e.g., "data:image/jpeg;base64,...")
        if (isset($message['content']) && is_string($message['content'])) {
            $originalLength = strlen($message['content']);

            // Strip data URI base64 images (data:image/...;base64,XXXX)
            $stripped = preg_replace(
                '/data:image\/[a-zA-Z]+;base64,[A-Za-z0-9+\/=]{100,}/',
                '[BASE64_IMAGE_STRIPPED]',
                $message['content']
            );

            if ($stripped !== $message['content']) {
                $strippedCount++;
                $message['content'] = $stripped;
                Log::debug('Stripped inline base64 from message', [
                    'original_length' => $originalLength,
                    'new_length' => strlen($stripped),
                ]);
            }
        }

        // Handle image data in nested structures (e.g., tool results with screenshots)
        if (isset($message['image']) && is_string($message['image'])) {
            if (strlen($message['image']) > 200) {
                $strippedCount++;
                $message['image'] = '[IMAGE_STRIPPED_FOR_COMPACTION]';
            }
        }

        // Handle Gemini-style blob content
        if (isset($message['parts']) && is_array($message['parts'])) {
            $filteredParts = [];
            foreach ($message['parts'] as $part) {
                if (is_array($part) && isset($part['inline_data'])) {
                    $strippedCount++;
                    $filteredParts[] = ['text' => '[IMAGE STRIPPED FOR CONTEXT COMPACTION]'];
                } else {
                    $filteredParts[] = $part;
                }
            }
            $message['parts'] = $filteredParts;
        }

        return $message;
    }
}
