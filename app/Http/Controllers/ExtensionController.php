<?php

namespace App\Http\Controllers;

use App\Services\AiService;
use App\Services\ApiService;
use App\Services\ReflexionService;
use App\Services\SeleniumService;
use App\Services\SiteKnowledgeService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

class ExtensionController extends Controller
{
    public function __construct(
        private readonly AiService $ai,
        private readonly SeleniumService $selenium,
        private readonly ReflexionService $reflexion,
        private readonly SiteKnowledgeService $siteKnowledge,
        private readonly ApiService $apiService
    ) {}

    public function loop(Request $request): JsonResponse
    {
        set_time_limit(120);

        $prompt = $request->input('prompt');
        if (!$prompt) {
            return response()->json(['error' => 'Prompt is required'], 400);
        }

        $history = $request->input('history', []);
        $elements = $request->input('elements', []);
        $imageBase64 = $request->input('image');
        $somMap = $request->input('somMap', []);
        $dropdownStates = $request->input('dropdownStates', []);
        $validationErrors = $request->input('validationErrors', []);
        $quickFillState = $request->input('quickFillState', []);
        $sopProgress = $request->input('sopProgress', []);
        $agentMode = (bool) $request->input('agentMode', false);
        $url = (string) $request->input('url', '');

        $historyJson = $this->buildCompressedHistory($history);
        $apiCatalogBlock = $this->getApiCatalog();
        $systemPrompt = config('automation.system_prompt_separation', true) ? $this->buildSystemPrompt() : null;

        if ($systemPrompt) {
            $systemPrompt = str_replace('{{API_CATALOG_PLACEHOLDER}}', $apiCatalogBlock, $systemPrompt);
            if ($agentMode) {
                $systemPrompt .= "\n\n# AGENT MODE ACTIVE: Do NOT generate strict CSS selectors. Rely EXCLUSIVELY on plain-text instructions using the `text_match`, `role_hint`, and `conversational_message` fields to target elements semantically based on their visible text.";
            }
        }

        $visionModeActive = !empty($imageBase64) && strlen($imageBase64) > 1000;

        // Element Payload Compression: cap size + strip heavy keys for DOM-only mode.
        $compressedElements = is_array($elements) ? array_slice($elements, 0, 45) : [];
        if (!$visionModeActive) {
            $heavyKeys = ['boundingBox', 'xpath', 'outerHTML', 'cssPath'];

            foreach ($compressedElements as $i => $element) {
                if (!is_array($element)) {
                    continue;
                }

                foreach ($heavyKeys as $k) {
                    unset($compressedElements[$i][$k]);
                }

                // Ensure text-only model fields remain (do not remove if present).
                $requiredTextOnlyKeys = ['selector', 'text', 'tagName', 'attributes'];
                foreach ($compressedElements[$i] as $key => $_v) {
                    if (!in_array($key, $requiredTextOnlyKeys, true) && !in_array($key, $heavyKeys, true)) {
                        unset($compressedElements[$i][$key]);
                    }
                }
            }
        }

        $modeIndicator = $visionModeActive
            ? 'MODE: VISION (screenshot + DOM data)'
            : 'MODE: DOM-ONLY (element selectors, IDs, values)';

        $userPrompt = $modeIndicator . "\nGoal: {$prompt}\n\n# CURRENT STATE\nURL: {$url}\nElements: " . json_encode($compressedElements) . "\n\n# ACTION HISTORY\n{$historyJson}\n";

        try {
            $response = null;

            // Best-effort vision; if it fails, fall back to text-only.
            $triedVision = false;
            if (!empty($imageBase64) && strlen($imageBase64) > 1000) {
                $triedVision = true;
                try {
                    $visionPrompt = $systemPrompt ? ($systemPrompt . "\n\n" . $userPrompt) : $userPrompt;
                    if (!empty(config('openai.api_key'))) {
                        $response = $this->ai->generateVision($visionPrompt, $imageBase64, 'openai');
                    }
                    if (!$response && !empty(config('gemini.api_key'))) {
                        $response = $this->ai->generateVision($visionPrompt, $imageBase64, 'gemini');
                    }
                } catch (\Throwable $e) {
                    Log::warning('Vision failed', ['error' => $e->getMessage()]);
                }

                if ($response && (str_contains($response, 'Cannot read') || str_contains($response, 'does not support image'))) {
                    $response = null;
                }
            }

            if ($response === null) {
                $provider = $triedVision ? null : config('automation.primary_ai', 'gemini');
                $response = $this->ai->generate($userPrompt, $provider, $systemPrompt);
            }

            if ($response === null) {
                return response()->json(['error' => $this->ai->getLastError() ?: 'AI failed'], 500);
            }

            $cleanJson = $this->extractJsonObject($response);
            $decision = json_decode(trim($cleanJson), true);

            if (!$decision || !isset($decision['action'])) {
                return response()->json([
                    'error' => 'Invalid AI response format',
                    'retry' => true,
                    'suggestion' => 'Return exactly one JSON object with an action field and no markdown or prose.',
                ]);
            }

            if (empty($decision['conversational_message'])) {
                $decision['conversational_message'] = $decision['thought'] ?? 'Executing action...';
            }

            if (empty($decision['status'])) {
                $decision['status'] = ($decision['action'] === 'ask_user') ? 'awaiting_human' : 'executing';
            }

            return response()->json($decision);
        } catch (\Throwable $e) {
            Log::error('Extension Loop Error: ' . $e->getMessage());
            return response()->json(['error' => $e->getMessage()], 500);
        }
    }

    public function handleApiCall(Request $request): JsonResponse
    {
        $method = $request->input('method', 'GET');
        $endpoint = (string) $request->input('endpoint', '');
        $params = $request->input('params', []);

        if (empty($endpoint)) {
            return response()->json(['success' => false, 'error' => 'Endpoint path is required.'], 400);
        }

        return response()->json($this->apiService->executeCall($method, $endpoint, $params));
    }

    public function generateSelenium(Request $request): JsonResponse
    {
        $history = $request->input('history', []);
        $goal = (string) $request->input('goal', '');
        $startUrl = (string) $request->input('startUrl', '');

        if (empty($history)) {
            return response()->json(['success' => false, 'message' => 'No history provided.'], 400);
        }

        if (!$goal) {
            $goal = 'Automate the recorded actions.';
        }
        if ($startUrl && !preg_match('#https?://#i', $goal)) {
            $goal = "Go to {$startUrl} and then: " . $goal;
        }

        try {
            if (config('automation.site_knowledge_enabled', true) && $startUrl) {
                try {
                    $this->siteKnowledge->learnFromRun($startUrl, $history, $goal);
                } catch (\Throwable $e) {}
            }

            return response()->json($this->selenium->generateSelenium($history, $goal, $startUrl));
        } catch (\Throwable $e) {
            Log::error('Selenium generation error: ' . $e->getMessage());
            return response()->json(['success' => false, 'message' => $e->getMessage()], 500);
        }
    }

    public function health(): JsonResponse
    {
        return response()->json([
            'status' => 'ok',
            'service' => 'hyprflow-ce',
            'port' => (int) env('EXTENSION_PORT', 8001),
            'ai_configured' => empty($this->ai->validateConfig()),
            'primary_ai' => config('automation.primary_ai'),
            'enhancements' => [
                'reflexion' => config('automation.reflexion_enabled'),
                'history_compression' => config('automation.history_compression_enabled'),
                'site_knowledge' => config('automation.site_knowledge_enabled'),
                'multi_action' => config('automation.multi_action_enabled'),
            ],
            'timestamp' => now()->toIso8601String(),
        ]);
    }

    public function config(): JsonResponse
    {
        return response()->json([
            'localVerify' => (bool) config('automation.local_verify_enabled', true),
            'localRecovery' => (bool) config('automation.local_recovery_enabled', true),
            'taskQueue' => (bool) config('automation.task_queue_enabled', true),
            'pageGraph' => (bool) config('automation.page_graph_enabled', true),
            'radixAdapters' => (bool) config('automation.radix_adapters_enabled', true),
            'crossFrame' => (bool) config('automation.cross_frame_enabled', true),
            'cdpEnabled' => (bool) config('automation.cdp_enabled', false),
            'targetScorer' => config('automation.target_scorer', 'heuristic'),
            'targetConfidenceThreshold' => (float) config('automation.target_confidence_threshold', 0.85),
            'aiTimeoutMs' => (int) config('automation.ai_timeout_ms', 45000),
            'contentTimeoutMs' => (int) config('automation.content_timeout_ms', 8000),
            'contentRetries' => (int) config('automation.content_retries', 3),
            'multiActionMaxChain' => (int) config('automation.multi_action_max_chain', 5),
        ]);
    }

    public function plan(Request $request): JsonResponse
    {
        $prompt = (string)$request->input('prompt', '');
        $isRejected = (bool)$request->input('rejected', false);

        if (!$prompt) {
            return response()->json(['error' => 'Prompt is required'], 400);
        }

        $rejectionNote =$isRejected
            ? "\nCRITICAL: User REJECTED previous plan. Generate a COMPLETELY DIFFERENT approach."
            : '';

        // Fetch the strict system protocols to serve as cached System Instructions
        $systemRules = $this->buildSystemPrompt();$apiCatalog = $this->getApiCatalog();$systemRules = str_replace('{{API_CATALOG_PLACEHOLDER}}', $apiCatalog,$systemRules);

        // Keep the user prompt extremely lightweight
        $aiPrompt = "You are a workflow planner for a browser automation agent processing medical claims.\n"
            . "CRITICAL: You MUST base your plan EXACTLY on the system instructions provided to you. Do not make up generic steps.\n\n"
            . "User Goal: {$prompt}{$rejectionNote}\n"
            . "Respond with EXACTLY ONE JSON object: {\"plan\":[\"Step 1: ...\", \"Step 2: ...\"]}\n";

        try {
            // PASS SYSTEM RULES AS THE 3RD PARAMETER TO UTILIZE CONTEXT CACHING
            $response =$this->ai->generate($aiPrompt, config('automation.primary_ai', 'gemini'),$systemRules);
            
            if (!$response) {
                return response()->json(['error' => $this->ai->getLastError() ?: 'Planning failed'], 500);
            }

            $cleanJson = preg_replace('/```(?:json)?\s*(.*?)\s*```/s', '$1',$response);
            $planData = json_decode(trim($cleanJson), true);

            if (!$planData || !isset($planData['plan'])) {
                return response()->json(['error' => 'Invalid plan format'], 500);
            }

            return response()->json(['plan' => $planData['plan']]);
        } catch (\Throwable $e) {
            return response()->json(['error' => $e->getMessage()], 500);
        }
    }


    public function learn(Request $request): JsonResponse
    {
        $url = (string) $request->input('url', '');
        $history = $request->input('history', []);
        $prompt = (string) $request->input('prompt', '');

        if (empty($history) || empty($url)) {
            return response()->json(['success' => false], 400);
        }

        try {
            $this->siteKnowledge->learnFromRun($url, $history, $prompt);
            return response()->json(['success' => true]);
        } catch (\Throwable $e) {
            return response()->json(['success' => false, 'message' => $e->getMessage()], 500);
        }
    }

    private function buildSystemPrompt(): string
    {
        return <<<'SYSTEM'
You are an intelligent, high-speed AI agent for browser-based automation processing medical claims. Your goal is to execute tasks as efficiently as a human expert. You operate in a continuous loop where speed and accuracy are paramount.

# 1. RESPONSE FORMAT (EXACTLY ONE JSON OBJECT)
You must respond with EXACTLY ONE valid JSON object per turn. No markdown fences, no conversational text outside JSON.
{
  "thought": "Brief internal reasoning. If a previous action failed, state how your recovery strategy differs.",
  "action": "<action_type>", 
  "selector": "#valid-css-selector",
  "text": "...",
  "fields": [ {"selector": "#id1", "text": "val1"}, {"field": "insured_id", "text": "val2"} ],
  "actions": [ {"action": "type", "selector": "#id1", "text": "val"}, {"action": "click", "selector": "#btn"} ],
  "api_endpoint": "/api/v1/...",
  "api_method": "GET|POST",
  "api_params": {},
  "ask_user_prompt": "Question for human",
  "conversational_message": "Human-readable status explaining what you are doing (MANDATORY).",
  "status": "executing|awaiting_human",
  "working_memory": {
    "current_status": "Brief summary of current form/task state"
  }
}

# 2. CRITICAL SPEED & BATCHING RULES (MANDATORY)
- AGGRESSIVE BATCHING: For every step, batch as many actions as possible. 
- INDEPENDENT FIELDS: If you need to type into multiple standard inputs or select options, use the `batch_fill` action. Do NOT use multiple separate `type` actions.
- DEPENDENCY CHAINS: If you must perform a predictable sequence (e.g., click a search bar → type a query → click search), use the `action_sequence` capability (Max 5 actions).
- SINGLE ACTIONS: Use single actions ONLY for dynamic or uncertain interactions, such as opening a modal, triggering a searchable dropdown, or handling validation errors.

# 3. ANTI-LOOP & RECOVERY PROTOCOL
If an action fails or the DOM does not change, you MUST attempt a fundamentally different approach. Do not retry the same strategy. Use this recovery hierarchy:
  - Recovery 1: Use a different CSS selector for the same intent.
  - Recovery 2: Use field-intent targeting (the `field` property instead of `selector`).
  - Recovery 3: Use `keyboard_event` (Tab/Enter).
  - Recovery 4: If stuck in a scrolling loop, stop scrolling and attempt to find/click the Submit/Save button.

# 4. DROPDOWN & COMBOBOX HANDLING
- NEVER use `batch_fill` for searchable dropdowns/comboboxes unless the exact value is verifiably available. 
- For complex comboboxes, use an `action_sequence` to open, type, and click the option, OR use single actions (first `type` to filter, then explicitly `click` the target `[role="option"]`).
- If the system warns you that a "dropdown appeared but option not auto-selected," your immediate next action MUST be to `click` the correct visible option.

# 5. HUMAN-IN-THE-LOOP (HITL) & AUTONOMOUS API
- If you detect missing form validation data, do NOT guess. IMMEDIATELY use `call_api` to retrieve missing values.
- If you exhaust your autonomous retrieval methods (like `call_api`) and are missing required data (e.g., Procedure Code, Provider NPI), stop guessing and use `ask_user`. 
- Set `"status": "awaiting_human"` and provide a clear `"ask_user_prompt"`.

# 6. TERMINATION
When you detect a terminal success state (a success toast, a draft warning message, a dashboard redirect, or all validation errors clear after saving), immediately execute the `finish` action with a concise summary.

# ═══════════════════════════════════════════════════════════════════════
# BACK-OFFICE API CATALOG
# ═══════════════════════════════════════════════════════════════════════
{{API_CATALOG_PLACEHOLDER}}

# ═══════════════════════════════════════════════════════════════════════
# MANDATORY NEW PROFESSIONAL CLAIM PROTOCOL (CREATE NEW CLAIM)
# ═══════════════════════════════════════════════════════════════════════
When the user goal asks to create, open, start, or submit a "New Professional Claim", execute this workflow without deviation:
1. NAVIGATION: On the Claims page, click the "New Professional Claim" option. Do not enter the rejected-claim Edit flow unless the form is already open.
2. QUICK FILL PATIENT SEARCH: Locate the "Quick Fill from patient record" section at the top of the claim form.
   - Extract the patient name from the user prompt.
   - Search using ONLY the patient FIRST NAME in the Quick Fill search field. Example: for "Dev Aica", type exactly "Dev".
   - Wait for the patient result dropdown. Select the matching patient result.
3. VERIFY AUTO-POPULATION: After selection, confirm whether patient details populated the form.
4. BACK-OFFICE API COMPLETION: If patient details are missing or required columns remain empty, do not guess. Use `call_api` with the catalog endpoints.
5. FIRST SAVE: Click "Save Claim" and wait for validation errors or redirect to /claims.
6. POST-SAVE ERROR RESOLUTION: If validation errors remain, summarize all errors, call the back-office API for missing values, and fill the exact failing fields.
7. FINAL SAVE: Click "Save Claim" again after errors are resolved.
8. REPORT RESULT: Finish only after the page redirects to /claims or a final success/error message is visible. If the page redirects to the dashboard and displays a warning like "Draft claims missing encounter notes", THIS IS A SUCCESSFUL TERMINAL STATE.

# ═══════════════════════════════════════════════════════════════════════
# MANDATORY REJECTED CLAIMS PROTOCOL (DEFAULT STEPS)
# ═══════════════════════════════════════════════════════════════════════
When processing tasks regarding fixing or approving rejected claims, you MUST execute this workflow without deviation:
1. INSPECTION & MEMORY CAPTURE: Locate the targeted claim row. Read and globally REMEMBER the Patient's full name from the "Patient" table column. Click the row action button, choose "View Errors", extract the rejection text, and close the modal.
2. ESCAPE POPUP: Extract the text inside the rejection alert box, then immediately close the modal view.
3. INITIATION: Click the claim row action dots again, and select "Edit" via text matching.
4. AUTO-POPULATE: Locate the "QUICK FILL FORM PATIENT RECORD" section at the top of the form. Use the Patient Last Name to search and click the exact "Lastname, Firstname" result.
5. RESOLUTION (AUTONOMOUS API FIRST): Scan the form for ALL validation errors. Autonomously use `call_api` to retrieve missing values for ALL flagged fields at once. ONLY if the API retrieval fails should you use `ask_user`.
6. PERSISTENCE: Click "Save Claim" to pass back to the primary claim dashboard, verify execution bounds, and trigger "finish".
SYSTEM;
    }

    private function buildCompressedHistory(array $history): string
    {
        if (empty($history)) {
            return "No previous actions. First step.";
        }

        return json_encode($history, JSON_PRETTY_PRINT);
    }

    private function buildPlanContext(array $planSteps, int $currentIndex): string
    {
        if (empty($planSteps)) {
            return '';
        }

        $block = "\n# PLAN (focus on current step):\n";
        foreach ($planSteps as $i => $step) {
            $m = $i < $currentIndex ? '✅' : ($i === $currentIndex ? '👉' : '⬜');
            $block .= "{$m} {$step}\n";
        }
        $block .= "→ Currently on step " . ($currentIndex + 1) . ". Complete it.\n";

        return $block;
    }

    private function buildWorkflowProtocolBlock(string $prompt): string
    {
        return $this->isNewProfessionalClaimPrompt($prompt)
            ? "\n# WORKFLOW: New Professional Claim protocol"
            : "\n# WORKFLOW: Rejected Claims protocol";
    }

    private function isNewProfessionalClaimPrompt(string $prompt): bool
    {
        return (bool) preg_match('/\b(create|open|start)\b.*\b(new\s+professional\s+claim|professional\s+claim|new\s+claim)\b|\bnew\s+professional\s+claim\b/i', $prompt);
    }

    private function extractPatientNameFromCreateClaimPrompt(string $prompt): string
    {
        return '';
    }

    private function extractFirstName(string $patientName): string
    {
        if (!$patientName) return '';
        $parts = preg_split('/\s+/', trim($patientName));
        return $parts[0] ?? '';
    }

    private function extractLastName(string $patientName): string
    {
        if (!$patientName) return '';
        if (str_contains($patientName, ',')) {
            $parts = explode(',', $patientName, 2);
            return $this->cleanExtractedName($parts[0]);
        }
        $parts = preg_split('/\s+/', trim($patientName));
        return $parts[count($parts) - 1] ?? '';
    }

    private function cleanExtractedName(string $name): string
    {
        return trim(preg_replace('/\s+/', ' ', str_replace(['"', "'"], '', $name)));
    }

    private function buildMultiActionBlock(): string
    {
        $max = config('automation.multi_action_max_chain', 5);
        return "\n# ACTION SEQUENCE (optional speed boost):\nUse at most {$max} simple independent steps.\n";
    }

    private function buildClickedList(array $clickedSelectors): string
    {
        $normal = array_filter($clickedSelectors, fn($s) => !str_starts_with($s, 'BLOCKED:'));
        return !empty($normal)
            ? implode("\n", array_map(fn($s, $i) => ($i + 1) . '. ' . $s, array_values($normal), array_keys(array_values($normal))))
            : 'None yet';
    }

    private function buildBlockedList(array $clickedSelectors): string
    {
        $blocked = array_filter($clickedSelectors, fn($s) => str_starts_with($s, 'BLOCKED:'));
        return !empty($blocked)
            ? implode("\n", array_map(fn($s) => '🚫 ' . str_replace('BLOCKED:', '', $s), $blocked))
            : 'None';
    }

    private function extractJsonObject(string $response): string
    {
        $clean = trim(preg_replace('/```(?:json)?\s*(.*?)\s*```/s', '$1', $response) ?? $response);

        $start = strpos($clean, '{');
        $end = strrpos($clean, '}');
        if ($start !== false && $end !== false && $end > $start) {
            return substr($clean, $start, $end - $start + 1);
        }

        return $clean;
    }

    private function buildDropdownStatesBlock(array $dropdownStates): string
    {
        if (empty($dropdownStates)) return '';
        $block = "\n# DROPDOWN VALUES (TRUTH SOURCE):\n";
        foreach ($dropdownStates as $d) {
            $label = $d['label'] ?? $d['text'] ?? 'unknown';
            $val = $d['currentValue'] ?? '(empty)';
            $status = !empty($d['isPlaceholder']) ? '⚠️ NOT SET' : '✓ SET';
            $block .= "- \"{$label}\": \"{$val}\" [{$status}]\n";
        }
        return $block;
    }

    private function buildValidationErrorsBlock(array $validationErrors): string
    {
        if (empty($validationErrors)) return '';
        $block = "\n# VALIDATION TARGETS (TRUTH SOURCE):\n";
        foreach ($validationErrors as $i => $e) {
            $field = $e['field'] ?? $e['fieldIntent'] ?? 'Unknown field';
            $text = $e['text'] ?? '';
            $block .= ($i + 1) . ". {$field}: {$text}\n";
        }
        return $block;
    }

    private function buildQuickFillStateBlock(array $quickFillState): string
    {
        if (empty($quickFillState) || empty($quickFillState['active'])) return '';
        return "\n# QUICK FILL STATE:\n";
    }

    private function buildComboboxStatesBlock(array $elements): string
    {
        return '';
    }

    private function buildFormFieldStatus(array $elements): string
    {
        return '';
    }

    private function buildSopProgressBlock(array $sopProgress, array $history): string
    {
        return '';
    }

    private function getApiCatalog(): string
    {
        return <<<'CATALOG'
# BACK-OFFICE BACKEND API SPECIFICATIONS (RESTful JSON)
CATALOG;
    }

    private function validateCssSelector(string $selector): array
    {
        if (empty(trim($selector))) {
            return ['valid' => false, 'reason' => 'Empty selector.', 'suggestion' => 'Provide a valid CSS selector from the elements list'];
        }
        return ['valid' => true, 'reason' => '', 'suggestion' => ''];
    }
}
