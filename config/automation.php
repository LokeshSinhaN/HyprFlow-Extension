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

    /*
    |--------------------------------------------------------------------------
    | Reflexion Module (Enhancement 2)
    | Activates a specialized debugging prompt after repeated failures
    |--------------------------------------------------------------------------
    */
    'reflexion_enabled' => (bool) env('AUTOMATION_REFLEXION_ENABLED', true),

    'reflexion_threshold' => (int) env('AUTOMATION_REFLEXION_THRESHOLD', 2), // failures before activation

    /*
    |--------------------------------------------------------------------------
    | History Compression (Enhancement 5)
    | Summarizes older history entries to prevent context window pollution
    |--------------------------------------------------------------------------
    */
    'history_compression_enabled' => (bool) env('AUTOMATION_HISTORY_COMPRESSION', true),

    'history_compression_threshold' => (int) env('AUTOMATION_HISTORY_COMPRESSION_THRESHOLD', 10), // steps before compressing

    'history_recent_keep' => (int) env('AUTOMATION_HISTORY_RECENT_KEEP', 5), // recent steps to keep in full

    /*
    |--------------------------------------------------------------------------
    | Site Knowledge Base (Gap C)
    | Cross-session learning for site-specific interaction patterns
    |--------------------------------------------------------------------------
    */
    'site_knowledge_enabled' => (bool) env('AUTOMATION_SITE_KNOWLEDGE', true),

    'site_knowledge_ttl_hours' => (int) env('AUTOMATION_SITE_KNOWLEDGE_TTL', 168), // 7 days

    /*
    |--------------------------------------------------------------------------
    | System Prompt Separation (Gap A)
    | Separates static rules from dynamic state for caching efficiency
    |--------------------------------------------------------------------------
    */
    'system_prompt_separation' => (bool) env('AUTOMATION_SYSTEM_PROMPT_SEPARATION', true),

    /*
    |--------------------------------------------------------------------------
    | Multi-Action Chaining (Gap B)
    | Allows AI to return action sequences for faster form filling
    |--------------------------------------------------------------------------
    */
    'multi_action_enabled' => (bool) env('AUTOMATION_MULTI_ACTION', true),

    'multi_action_max_chain' => (int) env('AUTOMATION_MULTI_ACTION_MAX', 5), // max actions in one response

];
