<?php

declare(strict_types=1);

return [
    'api_key' => env('MISTRAL_API_KEY'),
    'base_url' => env('MISTRAL_BASE_URL'),
    'request_timeout' => env('MISTRAL_REQUEST_TIMEOUT', 30),
];
