<?php

use App\Http\Controllers\ExtensionController;

/**
 * buildValidationErrorsBlock() is private and pure (no injected services used),
 * so we instantiate without the constructor and invoke it via reflection.
 */
function validationBlock(array $errors): string
{
    $ref = new ReflectionClass(ExtensionController::class);
    $controller = $ref->newInstanceWithoutConstructor();
    $method = $ref->getMethod('buildValidationErrorsBlock');
    $method->setAccessible(true);

    return $method->invoke($controller, $errors);
}

it('renders the real field label, not a boolean (regression for the || bug)', function () {
    $block = validationBlock([
        ['field' => 'Procedure Code', 'text' => 'Procedure is required', 'type' => 'input'],
    ]);

    // Before the fix, `$e['field'] || ...` collapsed to boolean true → "1".
    expect($block)->toContain('1. Procedure Code')
        ->and($block)->toContain('Procedure is required')
        ->and($block)->not->toContain('1. 1:');
});

it('falls back to fieldIntent, then to "Unknown field"', function () {
    $block = validationBlock([
        ['fieldIntent' => 'procedure', 'text' => 'err-a'],
        ['text' => 'err-b'],
    ]);

    expect($block)->toContain('procedure')
        ->and($block)->toContain('Unknown field');
});

it('handles missing selector/type/text without raising warnings', function () {
    $block = validationBlock([
        ['field' => 'State'],
    ]);

    expect($block)->toContain('State')
        ->and($block)->toBeString();
});

it('labels combobox validation targets', function () {
    $block = validationBlock([
        ['field' => 'Payer', 'text' => 'required', 'isCombobox' => true],
    ]);

    expect($block)->toContain('combobox/searchable dropdown');
});

it('returns an empty string when there are no errors', function () {
    expect(validationBlock([]))->toBe('');
});
