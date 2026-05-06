<?php

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // Extension API is fully stateless — no CSRF, no sessions, no cookies
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        // Always return JSON for API errors (never HTML error pages)
        $exceptions->shouldRenderJsonWhen(function ($request, \Throwable $e) {
            return true;
        });
    })->create();
