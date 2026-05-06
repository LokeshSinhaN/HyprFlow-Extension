<?php

namespace App\Providers;

use GuzzleHttp\Client as GuzzleClient;
use Illuminate\Support\ServiceProvider;
use OpenAI\Client;
use OpenAI\Contracts\ClientContract;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        //
    }

    /**
     * Bootstrap any application services.
     * Re-bind OpenAI client so our SSL verify option is used.
     */
    public function boot(): void
    {
        $this->registerOpenAiClientWithSslOption();
    }

    /**
     * Re-bind OpenAI client with configurable SSL verification.
     * Fixes cURL error 60 on Windows/local dev environments.
     */
    protected function registerOpenAiClientWithSslOption(): void
    {
        // Only re-bind if the OpenAI API key is configured
        $apiKey = config('openai.api_key');
        if (empty($apiKey)) {
            return;
        }

        $this->app->singleton(ClientContract::class, function () {
            $apiKey = config('openai.api_key');
            $organization = config('openai.organization');
            $project = config('openai.project');
            $baseUri = config('openai.base_uri');

            $verify = config('openai.verify_ssl', true);
            $client = \OpenAI::factory()
                ->withApiKey($apiKey)
                ->withOrganization($organization)
                ->withHttpClient(new GuzzleClient([
                    'timeout' => config('openai.request_timeout', 30),
                    'verify' => $verify,
                ]));

            if (is_string($project)) {
                $client = $client->withProject($project);
            }
            if (is_string($baseUri)) {
                $client = $client->withBaseUri($baseUri);
            }

            return $client->make();
        });
    }
}
