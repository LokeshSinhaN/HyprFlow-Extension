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

    /*
    |--------------------------------------------------------------------------
    | Provider Fallback (Phase 1)
    | When true, generate()/generateVision() walk primary -> secondary ->
    | tertiary providers (filtered to those with a configured API key) instead
    | of Gemini-only. When false, behaves as before (primary with retries).
    |--------------------------------------------------------------------------
    */
    'provider_fallback_enabled' => (bool) env('AUTOMATION_PROVIDER_FALLBACK', true),

    'tertiary_ai' => env('AUTOMATION_TERTIARY_AI', 'mistral'),

    'provider_max_retries' => (int) env('AUTOMATION_PROVIDER_MAX_RETRIES', 2), // attempts per provider before falling through

    /*
    |--------------------------------------------------------------------------
    | Local-First Execution (Phase 2)
    | Verifier + deterministic confidence resolver + local recovery reduce the
    | number of LLM round-trips. The scorer is pluggable so a trained model can
    | be added later without touching call sites.
    |--------------------------------------------------------------------------
    */
    'local_verify_enabled' => (bool) env('AUTOMATION_LOCAL_VERIFY', true),

    'local_recovery_enabled' => (bool) env('AUTOMATION_LOCAL_RECOVERY', true),

    'target_scorer' => env('AUTOMATION_TARGET_SCORER', 'heuristic'), // heuristic | <future-model-id>

    'target_confidence_threshold' => (float) env('AUTOMATION_TARGET_CONFIDENCE_THRESHOLD', 0.85),

    /*
    |--------------------------------------------------------------------------
    | Durable Task Queue & Page Graph (Phase 3)
    |--------------------------------------------------------------------------
    */
    'task_queue_enabled' => (bool) env('AUTOMATION_TASK_QUEUE', true),

    'page_graph_enabled' => (bool) env('AUTOMATION_PAGE_GRAPH', true),

    /*
    |--------------------------------------------------------------------------
    | Framework Adapters, Timeouts & Cross-Origin (Phase 4)
    | Timeouts are configurable with lower defaults than the legacy hard-coded
    | values (AI 90s, content 15s, 5 retries).
    |--------------------------------------------------------------------------
    */
    'radix_adapters_enabled' => (bool) env('AUTOMATION_RADIX_ADAPTERS', true),

    'ai_timeout_ms' => (int) env('AUTOMATION_AI_TIMEOUT_MS', 45000),

    'content_timeout_ms' => (int) env('AUTOMATION_CONTENT_TIMEOUT_MS', 8000),

    'content_retries' => (int) env('AUTOMATION_CONTENT_RETRIES', 3),

    'cross_frame_enabled' => (bool) env('AUTOMATION_CROSS_FRAME', true),

    'cdp_enabled' => (bool) env('AUTOMATION_CDP_ENABLED', false), // guarded chrome.debugger fallback for unreachable frames

];
