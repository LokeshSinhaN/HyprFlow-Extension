<?php

namespace App\Services;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

class ApiService
{
    private function sslVerifyOption(): bool|string
    {
        $caBundlePath = env('SSL_CA_BUNDLE_PATH', '');
        if (! is_string($caBundlePath)) {
            return true;
        }

        $caBundlePath = trim($caBundlePath, "\"' \t\r\n");
        $caBundlePath = str_replace('\\', '/', $caBundlePath);
        $caBundlePath = preg_replace('#/+#', '/', $caBundlePath) ?: $caBundlePath;

        if ($caBundlePath === '') {
            return true;
        }

        $resolvedCaBundlePath = preg_match('#^(?:[A-Za-z]:/|/)#', $caBundlePath)
            ? $caBundlePath
            : base_path($caBundlePath);

        if (! is_file($resolvedCaBundlePath) || ! is_readable($resolvedCaBundlePath)) {
            throw new \RuntimeException("SSL_CA_BUNDLE_PATH is set but file was not found or not readable: {$resolvedCaBundlePath}");
        }

        return $resolvedCaBundlePath;
    }

    /**
     * Executes an outbound back-office API request with credential formatting
     * and route parameter interpolation.
     *
     * @param string $method HTTP Verb (GET, POST, etc.)
     * @param string $endpoint The template string from the API catalog (e.g., /api/v1/patients/{id})
     * @param array $params Payload parameters and route tokens combined
     * @return array{success: bool, data?: array, rowCount?: int, error?: string}
     */
    public function executeCall(string $method, string $endpoint, array $params = []): array
    {
        $baseUrl = rtrim(env('BACKOFFICE_API_BASE_URL', 'http://localhost:8000'), '/');
        $token = env('BACKOFFICE_API_TOKEN', '');

        // 1. Process and interpolate path templates (e.g., /api/v1/patients/{id} -> /api/v1/patients/5)
        $processedUrl = $endpoint;
        if (preg_match_all('/\{([a-zA-Z0-9_]+)\}/', $endpoint, $matches)) {
            foreach ($matches[1] as $placeholder) {
                if (isset($params[$placeholder])) {
                    $processedUrl = str_replace('{' . $placeholder . '}', $params[$placeholder], $processedUrl);
                    // Remove from array payload so it doesn't get repeated in the body/query string
                    unset($params[$placeholder]);
                }
            }
        }

        $fullUrl = $baseUrl . '/' . ltrim($processedUrl, '/');
        $method = strtoupper(trim($method));

        try {
            // 2. Instantiate authenticated request wrapper with development SSL resilience overrides
            $client = Http::withToken($token)
                ->acceptJson()
                ->withOptions([
                    'verify' => $this->sslVerifyOption(),
                    'timeout' => 30
                ]);

            // 3. Dispatch based on verb mapping
            $response = match ($method) {
                'GET'  => $client->get($fullUrl, $params),
                'POST' => $client->post($fullUrl, $params),
                default => throw new \InvalidArgumentException("Unsupported API Method: {$method}")
            };

            if ($response->failed()) {
                Log::warning('Back-office API call failed', [
                    'url' => $fullUrl,
                    'status' => $response->status(),
                    'body' => $response->body()
                ]);
                return [
                    'success' => false,
                    'error' => 'API_ERROR (HTTP ' . $response->status() . '): ' . ($response->json('message') ?? 'Request failed')
                ];
            }

            $responseData = $response->json();

            // Normalize wrapper format so downstream AI loop code processes arrays cleanly
            $normalizedData = isset($responseData['data']) ? $responseData['data'] : $responseData;
            $rowCount = is_array($normalizedData) ? (isset($normalizedData[0]) ? count($normalizedData) : 1) : 0;

            Log::info('Back-office API request executed successfully', [
                'url' => $fullUrl,
                'rows' => $rowCount
            ]);

            return [
                'success' => true,
                'data' => $normalizedData,
                'rowCount' => $rowCount
            ];

        } catch (\Exception $e) {
            Log::error('Back-office API Connection Failure', [
                'url' => $fullUrl,
                'error' => $e->getMessage()
            ]);
            return [
                'success' => false,
                'error' => 'API_TRANSPORT_CONNECTION_ERROR: ' . $e->getMessage()
            ];
        }
    }
}
