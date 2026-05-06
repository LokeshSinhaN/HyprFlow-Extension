<?php

return [

    /*
    |--------------------------------------------------------------------------
    | AI Provider Configuration
    |--------------------------------------------------------------------------
    */
    'primary_ai' => env('AUTOMATION_PRIMARY_AI', 'gemini'),

    'secondary_ai' => env('AUTOMATION_SECONDARY_AI', 'openai'),

    /*
    |--------------------------------------------------------------------------
    | Model names (configurable per-provider via .env)
    |--------------------------------------------------------------------------
    */
    'gemini_model' => env('GEMINI_MODEL', 'gemini-2.0-flash'),

    'mistral_model' => env('MISTRAL_MODEL', 'mistral-small-latest'),

    'openai_model' => env('OPENAI_MODEL', 'gpt-4o'),

    /*
    |--------------------------------------------------------------------------
    | Agent limits
    |--------------------------------------------------------------------------
    */
    'agent_max_steps' => (int) env('AUTOMATION_AGENT_MAX_STEPS', 50),

    'agent_max_retries_per_action' => (int) env('AUTOMATION_AGENT_MAX_RETRIES', 3),

];
