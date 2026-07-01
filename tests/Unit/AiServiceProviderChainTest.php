<?php

use App\Services\AiService;

/**
 * getProviderChain() is private; invoke it via reflection so we can assert the
 * fallback ordering/filtering logic without making real network calls.
 */
function providerChain(?string $provider = null): array
{
    $method = new ReflectionMethod(AiService::class, 'getProviderChain');
    $method->setAccessible(true);

    return $method->invoke(new AiService, $provider);
}

beforeEach(function () {
    config()->set('automation.provider_fallback_enabled', true);
    config()->set('automation.primary_ai', 'gemini');
    config()->set('automation.secondary_ai', 'openai');
    config()->set('automation.tertiary_ai', 'mistral');
    config()->set('gemini.api_key', 'g-key');
    config()->set('openai.api_key', 'o-key');
    config()->set('mistral.api_key', 'm-key');
});

it('orders providers primary -> secondary -> tertiary when all have keys', function () {
    expect(providerChain())->toBe(['gemini', 'openai', 'mistral']);
});

it('filters out providers without a configured API key', function () {
    config()->set('openai.api_key', null);
    expect(providerChain())->toBe(['gemini', 'mistral']);
});

it('places an explicitly requested provider first', function () {
    expect(providerChain('openai')[0])->toBe('openai');
});

it('returns only the primary provider when fallback is disabled', function () {
    config()->set('automation.provider_fallback_enabled', false);
    expect(providerChain())->toBe(['gemini']);
});

it('falls back to the primary provider when no keys are configured', function () {
    config()->set('gemini.api_key', null);
    config()->set('openai.api_key', null);
    config()->set('mistral.api_key', null);
    expect(providerChain())->toBe(['gemini']);
});

it('deduplicates when primary and secondary are the same provider', function () {
    config()->set('automation.secondary_ai', 'gemini');
    expect(providerChain())->toBe(['gemini', 'mistral']);
});
