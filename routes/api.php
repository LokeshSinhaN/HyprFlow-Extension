<?php

use App\Http\Controllers\ExtensionController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Hyprflow Chrome Extension API Routes
|--------------------------------------------------------------------------
| All routes are prefixed with /api/ automatically.
| These endpoints are stateless and CSRF-exempt (API middleware group).
|--------------------------------------------------------------------------
*/

// Health check
Route::get('/extension/health', [ExtensionController::class, 'health'])
    ->name('extension.health');

// Extension loop — AI brain endpoint
Route::post('/extension/loop', [ExtensionController::class, 'loop'])
    ->name('extension.loop');

// Generate Selenium code from action history
Route::post('/extension/generate-selenium', [ExtensionController::class, 'generateSelenium'])
    ->name('extension.generateSelenium');

// Plan workflow before execution
Route::post('/extension/plan', [ExtensionController::class, 'plan'])
    ->name('extension.plan');

// Site-specific knowledge learning endpoint (Gap C)
Route::post('/extension/learn', [ExtensionController::class, 'learn'])
    ->name('extension.learn');
