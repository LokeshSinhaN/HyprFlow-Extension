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
    ) {
    }

    /**
     * POST /api/extension/loop
     * Enhanced with: Reflexion, System Prompt Separation, History Compression,
     * Plan-Aware Execution, CSS Validator, Site Knowledge, Multi-Action.
     */
    public function loop(Request $request): JsonResponse
    {
        // Prevent PHP from killing the request while waiting for AI model response
        // AI models (especially with vision/large context) can take 30-90s to respond
        set_time_limit(120);

        $prompt = $request->input('prompt');
        $agentMode = (bool) $request->input('agentMode', false);
        $url = $request->input('url');
        $elements = $request->input('elements', []);
        $imageBase64 = $request->input('image');
        $somMap = $request->input('somMap', []);
        $dropdownStates = $request->input('dropdownStates', []);
        $validationErrors = $request->input('validationErrors', []);
        $quickFillState = $request->input('quickFillState', []);
        $sopProgress = $request->input('sopProgress', []);

        if (!$prompt) {
            return response()->json(['error' => 'Prompt is required'], 400);
        }

        $history = $request->input('history', []);
        $clickedSelectors = $request->input('clickedSelectors', []);
        $toggledOptions = $request->input('toggledOptions', []);
        $postPopupDirective = $request->input('postPopupDirective', '');
        $consecutiveListTabsCount = (int) $request->input('consecutiveListTabsCount', 0);
        $lastActionFailed = (bool) $request->input('lastActionFailed', false);
        $lastActionError = (string) ($request->input('lastActionError') ?? '');
        $planSteps = $request->input('planSteps', []);
        $currentPlanStepIndex = (int) $request->input('currentPlanStepIndex', 0);

        // Build all context blocks
        $historyJson = $this->buildCompressedHistory($history);
        $clickedList = $this->buildClickedList($clickedSelectors);
        $blockedList = $this->buildBlockedList($clickedSelectors);
        $toggleStateInfo = !empty($toggledOptions) ? json_encode($toggledOptions, JSON_UNESCAPED_UNICODE) : 'None yet';
        $dropdownStatesBlock = $this->buildDropdownStatesBlock($dropdownStates);
        $validationErrorsBlock = $this->buildValidationErrorsBlock($validationErrors);
        $quickFillStateBlock = $this->buildQuickFillStateBlock($quickFillState);
        $comboboxStatesBlock = $this->buildComboboxStatesBlock($elements);
        $formFieldStatus = $this->buildFormFieldStatus($elements);
        $sopProgressBlock = $this->buildSopProgressBlock($sopProgress, $history);
        $planContext = $this->buildPlanContext($planSteps, $currentPlanStepIndex);
        $workflowProtocolBlock = $this->buildWorkflowProtocolBlock($prompt);

        // Gap C: Site Knowledge
        $siteKnowledgeBlock = '';
        if (config('automation.site_knowledge_enabled', true) && $url) {
            $siteKnowledgeBlock = $this->siteKnowledge->buildKnowledgeBlock($url);
        }

        // API Catalog Intelligence
        $apiCatalogBlock = $this->getApiCatalog();

        // Enhancement 2: Reflexion
        $reflexionBlock = '';
        if (config('automation.reflexion_enabled', true)) {
            if ($this->reflexion->shouldActivate($history, $lastActionFailed, $lastActionError)) {
                $reflexionBlock = $this->reflexion->buildReflexionBlock($history, $lastActionError, $elements);
                Log::info('Reflexion mode activated', ['step' => count($history) + 1]);
            }
        }

        // Vision / SoM
        $somDescription = '';
        $hasVision = !empty($imageBase64) && strlen($imageBase64) > 1000;
        if (!empty($somMap) && $hasVision) {
            $somDescription = "\n# SET-OF-MARK (SoM) LABELS\nThe screenshot shows numbered red boxes. Use \"somIndex\" to reference them.\nSoM Map: " . json_encode($somMap) . "\n";
        }
        $modeIndicator = $hasVision
            ? "MODE: VISION (screenshot + DOM data)"
            : "MODE: DOM-ONLY (element selectors, IDs, values)";

        $popupDirectiveBlock = $postPopupDirective !== '' ? "\n⚠️ DIRECTIVE:\n{$postPopupDirective}\n" : '';

        // Multi-action block (Gap B)
        $multiActionBlock = config('automation.multi_action_enabled', true) ? $this->buildMultiActionBlock() : '';

        // Page state
        $sliceCount = min(max(count($elements), 60), count($elements));
        $pageInfo = json_encode([
            'url' => $url,
            'elements' => array_slice($elements, 0, $sliceCount),
            'elementCount' => count($elements)
        ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

        // Gap A: System prompt (static, cacheable)
        $systemPrompt = config('automation.system_prompt_separation', true) ? $this->buildSystemPrompt() : null;
        if ($systemPrompt) {
            $systemPrompt = str_replace('{{API_CATALOG_PLACEHOLDER}}', $apiCatalogBlock, $systemPrompt);
            if ($agentMode) {
                $systemPrompt .= "\n\n# AGENT MODE ACTIVE: Do NOT generate strict CSS selectors. Rely EXCLUSIVELY on plain-text instructions using the `text_match`, `role_hint`, and `conversational_message` fields to target elements semantically based on their visible text.";
            }
        }

        // Dynamic user prompt
        $userPrompt = "{$modeIndicator}\n{$somDescription}\nGoal: {$prompt}\n{$planContext}\n{$workflowProtocolBlock}\n{$popupDirectiveBlock}\n{$reflexionBlock}\n{$siteKnowledgeBlock}\n{$dropdownStatesBlock}\n{$validationErrorsBlock}\n{$quickFillStateBlock}\n{$comboboxStatesBlock}\n{$formFieldStatus}\n{$sopProgressBlock}\n{$multiActionBlock}\n\n# CURRENT STATE\nURL: {$url}\nElements:\n{$pageInfo}\n\n# ACTION HISTORY\n{$historyJson}\n\n# CLICKED ELEMENTS:\n{$clickedList}\n\n# BLOCKED SELECTORS:\n{$blockedList}\n\n# TOGGLE STATE:\n{$toggleStateInfo}";

        try {
            $response = null;
            $triedVision = false;

            if ($hasVision) {
                $triedVision = true;
                $visionPrompt = $systemPrompt ? ($systemPrompt . "\n\n" . $userPrompt) : $userPrompt;
                try {
                    if (!empty(config('openai.api_key'))) {
                        $response = $this->ai->generateVision($visionPrompt, $imageBase64, 'openai');
                    }
                    if (!$response && !empty(config('gemini.api_key'))) {
                        $response = $this->ai->generateVision($visionPrompt, $imageBase64, 'gemini');
                    }
                } catch (\Exception $e) {
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

            // Parse response
            $cleanJson = preg_replace('/```(?:json)?\s*(.*?)\s*```/s', '$1', $response);
            $decision = json_decode(trim($cleanJson), true);

            if (!$decision || !isset($decision['action'])) {
                Log::warning('Failed to parse AI decision', ['raw' => substr($response, 0, 500)]);
                return response()->json(['error' => 'Invalid AI response format'], 500);
            }

            // ── Enrich response with human-in-the-loop defaults ──
            // Ensure conversational_message is always present (fallback to thought)
            if (empty($decision['conversational_message'])) {
                $decision['conversational_message'] = $decision['thought'] ?? 'Executing action...';
            }

            // Ensure status field is always present
            if (empty($decision['status'])) {
                $decision['status'] = ($decision['action'] === 'ask_user') ? 'awaiting_human' : 'executing';
            }

            // Force awaiting_human status when ask_user action is used
            if ($decision['action'] === 'ask_user') {
                $decision['status'] = 'awaiting_human';
                Log::info('Agent entering awaiting_human state', [
                    'message' => substr($decision['conversational_message'] ?? '', 0, 200),
                    'ask_user_prompt' => $decision['ask_user_prompt'] ?? '',
                    'has_api_payload' => !empty($decision['api_endpoint']),
                ]);
            }

            if ($decision['action'] === 'call_api') {
                Log::info('Agent requesting back-office API call', [
                    'api_endpoint' => $decision['api_endpoint'] ?? 'NONE',
                    'api_method' => $decision['api_method'] ?? 'GET',
                    'api_params' => $decision['api_params'] ?? [],
                    'message' => substr($decision['conversational_message'] ?? '', 0, 200),
                ]);
            }

            // Resolve SoM index
            if (!empty($decision['somIndex']) && !empty($somMap)) {
                $somIndex = (string) $decision['somIndex'];
                if (isset($somMap[$somIndex])) {
                    $decision['selector'] = $somMap[$somIndex];
                }
            }

            // Enhancement 4: CSS Selector Validator
            // Skip validation for actions that don't need selectors
            $action = $decision['action'] ?? '';
            $selectorFreeActions = ['ask_user', 'call_api', 'finish', 'navigate', 'extract', 'scroll_down', 'scroll_up', 'action_sequence', 'batch_fill'];

            if (!$agentMode && in_array($action, ['click', 'type', 'hover', 'select_option', 'keyboard_event']) && !empty($decision['selector'])) {
                $validation = $this->validateCssSelector($decision['selector']);
                if (!$validation['valid']) {
                    return response()->json([
                        'error' => "INVALID_SELECTOR: {$validation['reason']}",
                        'suggestion' => $validation['suggestion'],
                        'retry' => true,
                    ]);
                }
            }

            // Validate selector presence (only for actions that require selectors)
            if (in_array($action, ['click', 'type', 'hover', 'select_option']) && empty($decision['selector'])) {
                if (!empty($decision['field'])) {
                    // Dynamic field-intent targeting is resolved in the content script.
                } elseif (!empty($decision['text_match']) || !empty($decision['role_hint'])) {
                    // Agent Mode semantic targeting (by visible text / role) is resolved in the content script.
                } elseif (!empty($decision['somIndex']) && !empty($somMap) && isset($somMap[(string)$decision['somIndex']])) {
                    $decision['selector'] = $somMap[(string)$decision['somIndex']];
                } elseif (!in_array($action, $selectorFreeActions)) {
                    return response()->json(['error' => 'Empty selector for ' . $action, 'retry' => true], 500);
                }
            }

            return response()->json($decision);

        } catch (\Exception $e) {
            Log::error('Extension Loop Error: ' . $e->getMessage());
            return response()->json(['error' => $e->getMessage()], 500);
        }
    }

    /**
     * POST /api/extension/call-api
     * Executes the back-office REST API call approved by the human supervisor.
     */
    public function handleApiCall(Request $request): JsonResponse
    {
        $method = $request->input('method', 'GET');
        $endpoint = $request->input('endpoint', '');
        $params = $request->input('params', []);

        if (empty($endpoint)) {
            return response()->json(['success' => false, 'error' => 'Endpoint path is required.'], 400);
        }

        $result = $this->apiService->executeCall($method, $endpoint, $params);
        return response()->json($result);
    }

    /**
     * POST /api/extension/generate-selenium
     */
    public function generateSelenium(Request $request): JsonResponse
    {
        $history = $request->input('history', []);
        $goal = $request->input('goal', '');
        $startUrl = $request->input('startUrl', '');

        if (empty($history)) {
            return response()->json(['success' => false, 'message' => 'No history provided.'], 400);
        }

        if (!$goal) $goal = 'Automate the recorded actions.';
        if ($startUrl && !preg_match('#https?://#i', $goal)) {
            $goal = "Go to {$startUrl} and then: " . $goal;
        }

        // Gap C: Learn from run
        if (config('automation.site_knowledge_enabled', true) && $startUrl) {
            try { $this->siteKnowledge->learnFromRun($startUrl, $history, $goal); } catch (\Exception $e) {}
        }

        try {
            return response()->json($this->selenium->generateSelenium($history, $goal, $startUrl));
        } catch (\Exception $e) {
            Log::error('Selenium generation error: ' . $e->getMessage());
            return response()->json(['success' => false, 'message' => $e->getMessage()], 500);
        }
    }

    /**
     * GET /api/extension/health
     */
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

    /**
     * POST /api/extension/plan
     */
    public function plan(Request $request): JsonResponse
    {
        $prompt = $request->input('prompt');
        $isRejected = $request->input('rejected', false);
        if (!$prompt) return response()->json(['error' => 'Prompt is required'], 400);

        $rejectionNote = $isRejected ? "\nCRITICAL: User REJECTED previous plan. Generate a COMPLETELY DIFFERENT approach." : "";
        
        $isNewProfessionalClaim = $this->isNewProfessionalClaimPrompt($prompt);
        $patientName = $this->extractPatientNameFromCreateClaimPrompt($prompt);
        $patientFirstName = $this->extractFirstName($patientName);
        $patientLastName = $this->extractLastName($patientName);

        if ($isNewProfessionalClaim) {
            $claimProtocol = "If the user goal is to create, open, or start a New Professional Claim, your plan MUST strictly consist of these 8 steps:\n"
                . "Step 1: NAVIGATION - On the Claims page, click the 'New Professional Claim' option.\n"
                . "Step 2: QUICK FILL - Open the claim form and locate 'Quick Fill from patient record'.\n"
                . "Step 3: PATIENT SEARCH - Search using ONLY the patient first name from the prompt (e.g., 'Dev' for 'Dev Aica'), then select the matching patient result.\n"
                . "Step 4: VERIFY AUTO-POPULATION - Confirm whether patient details populated the claim form.\n"
                . "Step 5: API-DRIVEN COMPLETION - If details are missing, call the back-office API and fill required columns one-by-one.\n"
                . "Step 6: FIRST SAVE - Click 'Save Claim' and wait for validation errors or redirect.\n"
                . "Step 7: ERROR RESOLUTION - If validation errors remain, call the back-office API and fill the exact failing fields, including dropdowns, DOBs, and searchable dropdowns.\n"
                . "Step 8: FINAL SAVE AND REPORT - Click 'Save Claim' again; only finish after redirect to /claims, then report the displayed success or error message to the user.\n";
        } else {
            $claimProtocol = "If the user goal involves 'claim', 'rejected', 'approve', or 'fix', your plan MUST strictly consist of these 6 steps:\n"
                . "Step 1: INSPECTION - Click action menu and select 'View Errors' on the claim row.\n"
                . "Step 2: ESCAPE POPUP - Read errors and close the modal.\n"
                . "Step 3: INITIATION - Click action menu and select 'Edit'.\n"
                . "Step 4: AUTO-POPULATE - Search patient in 'QUICK FILL' section and select from the dropdown.\n"
                . "Step 5: RESOLUTION - Fix validation errors using back-office API lookups and human-in-the-loop (ask_user).\n"
                . "Step 6: PERSISTENCE - Click 'Save Claim' and handle any post-save errors.\n";
        }

        $patientContext = $isNewProfessionalClaim && $patientName
            ? "\nPatient context extracted from the prompt: full name='{$patientName}', first_name='{$patientFirstName}', last_name='{$patientLastName}'. Use '{$patientFirstName}' as the Quick Fill search term.\n"
            : '';

        $aiPrompt = "You are a workflow planner for a browser automation agent.\nUser Goal: {$prompt}{$patientContext}{$rejectionNote}\n\n{$claimProtocol}\n\n# RADIX UI & MODERN COMPONENT RULES (CRITICAL)\n- Radix UI elements use custom primitive wrappers instead of native HTML tags.\n- CUSTOM SELECTS & POPUP DROPDOWNS: Radix dropdowns render options inside a dynamic Portal container appended to the bottom of the body tree.\n- ANTI-DISMISS SELECTION RULE: When selecting an item from an open dropdown list, you MUST target the specific interactive leaf node element. NEVER use generic compound selectors like `div` or `span` alongside item roles (e.g., do NOT emit `[role=\"option\"], div, span`). Doing so matches outer layout containers or backdrop overlays, which triggers a Radix \"click-outside\" dismiss event that closes the entire form workspace.\n- SELECTOR PRECISION: To select a dropdown choice, target the item precisely using `[role=\"option\"]`, `[data-radix-collection-item]`, or an explicit class like `.rtIn` / `.k-in`. Combine it with the exact `text_match` property.\n\n# PERMUTATION & DATA VARIATION TOLERANCE (CRITICAL)\n- Real-world database records may contain typographical variations or inverted name structures (e.g., the user requests \"Wayne Brue\", but the system dropdown displays \"Wayne, Bruce\").\n- Always evaluate the actual visible options present in the element snapshot before failing. If an option matches the primary keyword (e.g., \"Wayne\") and contains similar matching elements, you MUST target that specific option using its exact visible text string in the `text_match` property, rather than rigidly forcing the user's literal prompt string.\n\n# STRICT PARAMETER CONSTRAINTS (Prevents System Crash)\n- When choosing \"action\": \"type\", the `selector` property MUST be a valid, non-empty CSS selector pointing directly to a text input field (`input`), a textarea (`textarea`), or an element with `contenteditable`.\n- NEVER emit an empty, null, or missing selector string when the chosen action is \"type\" or \"click\". Doing so causes a critical system 500 failure. If you cannot find a clear input selector, locate its container or labels first.\nRespond with ONE JSON object:\n{\"plan\":[\"Step 1: ...\",\"Step 2: ...\"]}\n\nMake steps concise, actionable, max 10 steps. Be specific about clicks, typing, verification.";

        try {
            $response = $this->ai->generate($aiPrompt, config('automation.primary_ai', 'gemini'));
            if (!$response) return response()->json(['error' => $this->ai->getLastError() ?: 'Planning failed'], 500);

            $cleanJson = preg_replace('/```(?:json)?\s*(.*?)\s*```/s', '$1', $response);
            $planData = json_decode(trim($cleanJson), true);
            if (!$planData || !isset($planData['plan'])) return response()->json(['error' => 'Invalid plan format'], 500);

            return response()->json(['plan' => $planData['plan']]);
        } catch (\Exception $e) {
            return response()->json(['error' => $e->getMessage()], 500);
        }
    }

    /**
     * POST /api/extension/learn — Site knowledge endpoint
     */
    public function learn(Request $request): JsonResponse
    {
        $url = $request->input('url', '');
        $history = $request->input('history', []);
        $prompt = $request->input('prompt', '');
        if (empty($history) || empty($url)) return response()->json(['success' => false], 400);

        try {
            $this->siteKnowledge->learnFromRun($url, $history, $prompt);
            return response()->json(['success' => true]);
        } catch (\Exception $e) {
            return response()->json(['success' => false, 'message' => $e->getMessage()], 500);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // PRIVATE HELPERS
    // ═══════════════════════════════════════════════════════════════

    private function buildSystemPrompt(): string
    {
        return <<<'SYSTEM'
You are an intelligent, collaborative AI agent for browser-based medical claims processing. You are NOT a silent automation script — you are a human-in-the-loop assistant that communicates every action to your human supervisor. Your goal is to resolve rejected claims accurately by navigating the claims form lifecycle, asking for human help when needed, and handling post-save exceptions gracefully.

# ═══════════════════════════════════════════════════════════════════════
# RESPONSE FORMAT (MANDATORY)
# ═══════════════════════════════════════════════════════════════════════
# Every response MUST be EXACTLY ONE valid JSON object with these fields:
{
  "thought": "Your internal reasoning (brief)",
  "action": "<action_type>",
  "selector": "#valid-css-selector",
  "text": "...",
  "conversational_message": "Human-readable status message explaining what you see and what you are doing — ALWAYS REQUIRED",
  "status": "executing|awaiting_human",
  "somIndex": 1,
  "actions": [],
  "fields": [],
  "api_endpoint": "/api/v1/...",
  "api_method": "GET|POST",
  "api_params": {},
  "ask_user_prompt": "Question for the human (only for ask_user action)"
}
# CRITICAL: The "conversational_message" field is MANDATORY in every single response. Never omit it.
# CRITICAL: The "status" field defaults to "executing". Set to "awaiting_human" ONLY when using "ask_user" action.
# CRITICAL: For "call_api" actions, always provide "api_endpoint", "api_method", and "api_params".

# ═══════════════════════════════════════════════════════════════════════
# BACK-OFFICE API CATALOG
# ═══════════════════════════════════════════════════════════════════════
{{API_CATALOG_PLACEHOLDER}}

# ═══════════════════════════════════════════════════════════════════════
# CRITICAL SELECTOR RULES (STOP HALLUCINATING PSEUDO-SELECTORS)
# ═══════════════════════════════════════════════════════════════════════
- NEVER generate pseudo-selectors like `:has-text()`, `:text()`, or `:contains()` inside the "selector" field. This is INVALID CSS syntax and breaks the browser driver execution.
- If you need to click or interact with an element based on its visual text string (e.g., "View Errors", "Edit", "Close"), you MUST structure your JSON like this:
  {
    "action": "click",
    "selector": "button, div, li, span, [role=\"menuitem\"]",
    "text_match": "View Errors"
  }
- Let the extension handle text filtering safely using the "text_match" field instead of creating compound selector strings.

# ═══════════════════════════════════════════════════════════════════════
# MANDATORY NEW PROFESSIONAL CLAIM PROTOCOL (CREATE NEW CLAIM)
# ═══════════════════════════════════════════════════════════════════════
When the user goal asks to create, open, start, or submit a "New Professional Claim", execute this workflow without deviation:

1. NAVIGATION: On the Claims page, click the "New Professional Claim" option. Do not enter the rejected-claim Edit flow unless the form is already open.
2. QUICK FILL PATIENT SEARCH: Locate the "Quick Fill from patient record" section at the top of the claim form.
   - Extract the patient name from the user prompt.
   - Search using ONLY the patient FIRST NAME in the Quick Fill search field. Example: for "Dev Aica", type exactly "Dev", not "Dev Aica", not "Aica, Dev".
   - Wait for the patient result dropdown. Select the matching patient result. If the result appears as "Lastname, Firstname", click the row that contains the supplied first name and last name.
3. VERIFY AUTO-POPULATION: After selection, confirm whether patient details populated the form.
4. BACK-OFFICE API COMPLETION: If patient details are missing or required columns remain empty, do not guess. Use `call_api` with the catalog endpoints to retrieve patient, organization, eligibility, or claim context, then fill required columns one-by-one.
5. FIRST SAVE: Click "Save Claim" and wait for validation errors or redirect to /claims.
6. POST-SAVE ERROR RESOLUTION: If validation errors remain, summarize all errors, call the back-office API for missing values, and fill the exact failing fields. This includes text fields, DOBs, dropdowns, and searchable dropdowns.
7. FINAL SAVE: Click "Save Claim" again after errors are resolved.
8. REPORT RESULT: Finish only after the page redirects to /claims or a final success/error message is visible. Report the displayed message to the user.

# ═══════════════════════════════════════════════════════════════════════
# MANDATORY REJECTED CLAIMS PROTOCOL (DEFAULT STEPS)
# ═══════════════════════════════════════════════════════════════════════
When processing tasks regarding fixing or approving rejected claims, you MUST execute this workflow without deviation:

1. INSPECTION & MEMORY CAPTURE: Locate the targeted claim row. Read and globally REMEMBER the Patient's full name from the "Patient" table column. Click the row action button (three dots), choose "View Errors", extract the rejection text string, and immediately close the modal.
2. ESCAPE POPUP: Extract the text inside the rejection alert box, then immediately close the modal view. Do not linger trying to fill elements here.
3. INITIATION: Click the claim row action dots again, and select "Edit" via text matching to enter the form playground.
4. AUTO-POPULATE (SPLIT SEARCH STRATEGY): Locate the "QUICK FILL FORM PATIENT RECORD" section at the top of the form.
   - Step A: Click the framework trigger component displaying the text "Search patient..." to reveal the inner portal search menu.
   - Step B: Take the Patient Name you remembered in Step 1 and extract ONLY the Last Name (e.g., if the patient is "Abigail Santos", extract exactly "Santos").
   - Step C: Identify the real input field box with the placeholder "Search name, MRN, or ID...". Execute your "type" action on this box using ONLY the Last Name string. DO NOT type the first name or a comma.
   - Step D: Look at the filtered selection dropdown menu list. Now, execute a targeted click action matching the exact "Lastname, Firstname" string (e.g., "Santos, Abigail") to trigger full form state auto-population.
5. RESOLUTION (AUTONOMOUS API FIRST): Scan the form for ALL validation errors.
   - DO NOT ask the human for permission first.
   - Autonomously use `call_api` to retrieve missing values for ALL flagged fields at once using the catalog endpoints.
   - If the API response returns data, autonomously fill the fields.
   - ONLY if the API retrieval fails, returns empty, or if you exhaust your search options, should you halt and use `ask_user` to request the missing data from the human.
6. PERSISTENCE: Click "Save Claim" to pass back to the primary claim dashboard, verify execution bounds, and trigger "finish".

# ═══════════════════════════════════════════════════════════════════════
# SECTION 2: AUTONOMOUS ERROR RESOLUTION & HUMAN-IN-THE-LOOP
# ═══════════════════════════════════════════════════════════════════════

## 2A. AUTONOMOUS API-FIRST DATA RESOLUTION PROTOCOL
- When you detect missing form validation data (e.g. missing Patient metadata, Organization NPI, or Claims History mappings), do NOT guess.
- IMMEDIATELY initiate an internal data retrieval process via the back-office API using the "action": "call_api" mechanism.
- Draft your payload targeting the specific endpoint string documented in the catalog block.
- Example for checking missing validation details for a patient named Abigail Santos:
  {
    "thought": "The Patient demographic record contains incomplete metadata. I will invoke the back-office lookups to pull correct values.",
    "action": "call_api",
    "api_endpoint": "/api/v1/patients",
    "api_method": "GET",
    "api_params": { "last_name": "Santos" }
  }

## 2B. CONSOLIDATED HUMAN-IN-THE-LOOP (ask_user)
- You must ONLY use the `ask_user` action if your `call_api` data retrieval sequences fail, return no matching indices, or if the parameter is completely absent from back-office records.
- BULK GATHERING: If multiple fields are failing (e.g., NPI, Phone, and Procedure Code), DO NOT ask for them one by one. You MUST consolidate them into a single `ask_user` request.
- Example:
  {
    "thought": "My API lookups failed to find the NPI and Procedure code. I will ask the human for both.",
    "action": "ask_user",
    "status": "awaiting_human",
    "conversational_message": "I could not find the missing data through the back-office API. Please provide the following: 1) Billing Provider NPI, 2) Procedure Code (CPT).",
    "ask_user_prompt": "Please type the values for NPI and Procedure Code."
  }

## 2C. PRECISION TARGETING (ANTI-CONFUSION)
- When fixing errors in complex forms, adjacent dropdowns look similar in the DOM (e.g., "Procedure" vs "Diagnosis Pointer").
- DO NOT guess CSS selectors based on visual proximity.
- You MUST use strict `text_match` targeting based on the exact label of the failing field.
- If the error is "Procedure code is missing", your action MUST target `text_match: "CPT/HCPCS"` or `text_match: "PROCEDURE"`. Do not click random nearby comboboxes.

# ═══════════════════════════════════════════════════════════════════════
# SECTION 3: POST-SAVE EXCEPTION HANDLING (BULK MODE)
# ═══════════════════════════════════════════════════════════════════════

## 3A. POST-SAVE ERROR RECOVERY
1. After clicking "Save Claim", observe the page for new or unresolved verification error tags.
2. If the system provides validation targets, fill those exact fields first using `field` intent when available.
3. If errors exist, DO NOT call "finish".
4. Read ALL new error messages simultaneously.
5. Execute `call_api` autonomously to try and resolve all new errors at once.
6. If the back-office API lacks the answers, emit a single, consolidated `ask_user` action listing every remaining error that requires human input.

# ═══════════════════════════════════════════════════════════════════════
# SECTION 4: CORE AUTOMATION RULES
# ═══════════════════════════════════════════════════════════════════════

## 4A. JSON ONLY
- Output EXACTLY ONE valid JSON object per turn. No markdown fences, no conversational text outside JSON.
- If you must communicate, use the "conversational_message" field inside the JSON.

## 4B. PRECISION
- Only interact with elements explicitly listed in the DOM state. Do NOT hallucinate or guess CSS selectors.
- If an element is not in the elements list, it does not exist on the page.
- Prefer semantic `field` intent over brittle CSS selectors for form fields. Supported intents: `patient_search`, `insured_id`, `state`, `procedure`, `diagnosis_pointer`, `charges`.

## 4C. EFFICIENCY
- Use "action_sequence" to chain up to 5 simple, independent actions (e.g., filling obvious fields).
- Use "batch_fill" to fill multiple standard text inputs at once. You may use `field` intent for dynamic field resolution, but do NOT use batch_fill for searchable dropdowns unless each dropdown has a clear `field` intent and the value is already known.
- NEVER use action_sequence or batch_fill for fields that were flagged with errors — those MUST go through the ask_user flow.

## 4D. ANTI-LOOP
- If an action fails or the page doesn't change, try a DIFFERENT approach (different selector, keyboard navigation, etc.).
- If you've tried 3 different approaches on the same element, ask the user for help via ask_user.

## 4E. AVAILABLE ACTIONS
- Standard DOM: click, type, hover, select_option, scroll_down, scroll_up, extract, navigate
- Form Speed: action_sequence, batch_fill
- Fallback: keyboard_event, click_coordinate
- Human-in-the-Loop: ask_user (pauses for human input), call_api (back-office REST lookup)
- Termination: finish (ONLY when task is truly complete or human says stop)

## 4F. RADIX UI & MODERN ECOSYSTEM RULES (ANTI-COLLAPSE PROTOCOL)
- Radix UI elements abstract standard HTML behaviors; dropdowns, popovers, and comboboxes do not render inline and use custom primitive containers.
- STRICT SINGLE SELECTOR CONSTRAINT: You MUST choose EXACTLY ONE explicit CSS selector string from the provided elements list context. NEVER emit comma-separated compound fallback strings (e.g., NEVER combine selectors like `[role="option"], button, li, div, span`). Compound strings cause document.querySelector to hit accidental elements at the top of the DOM, triggering a blur event that collapses the volatile form workspace.
- ANTI-DISMISS RULE: When selecting an item from an open dropdown list, target the exact interactive leaf node option element. Clicking parent wrappers, layout divs, or backdrop overlays will fire a Radix "click-outside" sequence that destroys the current form state.
- THE MULTI-TURN COMBOBOX PATTERN:
  1. Trigger Turn: Identify and click the anchor wrapper button containing the literal text "Search patient...". Do NOT attempt to type directly into a <button> tag; this causes an "Illegal invocation" error.
  2. Input Turn: Once the portal expands, locate the newly mounted text input element (e.g., `input[placeholder="Search name, MRN, or ID..."]`) and issue a "type" action using ONLY the patient's first name (for new claims) or last name (for editing rejected claims).
  3. Selection Turn: Locate the exact item row from the refreshed elements list. Inspect the visible text within that option and execute a direct "click" action on that single selector.
- DATA PERMUTATION TOLERANCE: Database and interface layers routinely invert or truncate user records (e.g., a prompt request for "Wayne Bruce" matches a dropdown item displaying "Wayne, Bruce" or "Bruce, Wayne").
  - Do NOT fail the action or look for a rigid literal match if typographical variations exist. Extract the primary semantic token ("Wayne") and locate the row element that contains this text substring. Use the exact selector associated with that record row from the element snapshot to commit your click action.
- Quick Fill Failure Rule: If `textMatchFailed` is true, the option was NOT selected. Do NOT treat the click as successful. Do NOT click "New Professional Claim" again. Keep the current form/dropdown context and select the exact visible patient option.
- Procedure vs Diagnosis Pointer Rule: Procedure/CPT and Diagnosis Pointer are separate fields. When filling procedure code `97161`, target the field labeled Procedure, CPT, or HCPCS. Do NOT click Diagnosis Pointer for the procedure code. If "No options found" appears in the Diagnosis Pointer dropdown, interpret it as a Diagnosis Pointer issue, not a Procedure failure.

## 4G. SCROLLING
- If scrolled=0, the container cannot scroll further. Try a different container, use Tab, or interact directly.
- Do NOT scroll endlessly — if you've scrolled 3+ times without finding the target, use a different approach.
- Prefer `field` intent targeting and the validation target list over blind scrolling. Scroll to the exact failing field when validation targets are provided.

## 4H. FIELD-INTENT TARGETING
- Use `field` intent when the label is clear but the CSS selector is brittle:
  - `patient_search` for the Quick Fill patient search box.
  - `insured_id` for Insured/Subscribers/Member ID.
  - `state` for patient State/Province.
  - `procedure` for Procedure/CPT/HCPCS.
  - `diagnosis_pointer` for Diagnosis Pointer/DX Pointer.
  - `charges` for Charges/Amount/Fee.
- Do NOT use structural selectors like `div:nth-of-type(...)` for service-line fields when a `field` intent can resolve the label dynamically.

## 4I. POST-ACTION VERIFICATION
- After submitting forms: verify success/error messages before calling finish.
- After Quick Fill: verify which fields got populated and which remain empty.
- After typing into combobox: verify the dropdown appeared and option was selected.
SYSTEM;
    }

    private function buildCompressedHistory(array $history): string
    {
        if (empty($history)) return "No previous actions. First step.";

        $count = count($history);
        $threshold = config('automation.history_compression_threshold', 10);
        $keep = config('automation.history_recent_keep', 5);

        if (!config('automation.history_compression_enabled', true) || $count <= $threshold) {
            return json_encode($history, JSON_PRETTY_PRINT);
        }

        $older = array_slice($history, 0, $count - $keep);
        $recent = array_slice($history, -$keep);

        $successCount = count(array_filter($older, fn($h) => $h['actionSuccess'] ?? false));
        $actions = array_count_values(array_filter(array_column($older, 'action')));

        $summary = "# COMPRESSED (steps 1-" . count($older) . "): {$successCount}/" . count($older) . " succeeded\n";
        $summary .= "Actions: " . json_encode($actions) . "\n";

        // Milestones
        $milestones = [];
        foreach ($older as $e) {
            if (($e['actionSuccess'] ?? false) && in_array($e['action'] ?? '', ['click', 'navigate', 'batch_fill', 'select_option', 'type'])) {
                $milestones[] = "S{$e['step']}: {$e['action']} " . substr($e['selector'] ?? '', 0, 40);
            }
        }
        if ($milestones) $summary .= "Milestones: " . implode(' | ', array_slice($milestones, -6)) . "\n";

        // Failed selectors
        $failed = array_unique(array_filter(array_column(
            array_filter($older, fn($h) => !($h['actionSuccess'] ?? true)), 'selector'
        )));
        if ($failed) $summary .= "FAILED selectors: " . implode(', ', array_slice($failed, 0, 8)) . "\n";

        $summary .= "\n# RECENT (last {$keep} steps):\n" . json_encode($recent, JSON_PRETTY_PRINT);
        return $summary;
    }

    private function buildPlanContext(array $planSteps, int $currentIndex): string
    {
        if (empty($planSteps)) return '';
        $block = "\n# PLAN (focus on current step):\n";
        foreach ($planSteps as $i => $step) {
            $m = $i < $currentIndex ? '✅' : ($i === $currentIndex ? '👉' : '⬜');
            $block .= "{$m} {$step}\n";
        }
        $block .= "→ Currently on step " . ($currentIndex + 1) . ". Complete it, then set \"planStepCompleted\":true.\n";
        return $block;
    }

    private function buildWorkflowProtocolBlock(string $prompt): string
    {
        if (!$this->isNewProfessionalClaimPrompt($prompt)) {
            return '';
        }

        $patientName = $this->extractPatientNameFromCreateClaimPrompt($prompt);
        $firstName = $this->extractFirstName($patientName);
        $lastName = $this->extractLastName($patientName);
        $patientLine = $patientName
            ? "Patient name supplied: '{$patientName}'. Use first_name='{$firstName}' for Quick Fill search. Expected matching result may contain last_name='{$lastName}' and first_name='{$firstName}'.\n"
            : "No quoted patient name was detected. Extract the patient name from the user goal, then use only the first name for the Quick Fill search.\n";

        return <<<WORKFLOW

# MANDATORY NEW PROFESSIONAL CLAIM WORKFLOW
The current goal is to create a New Professional Claim. Follow this protocol instead of the rejected-claim Edit flow:
1. Click "New Professional Claim" from the Claims page.
2. Open "Quick Fill from patient record".
3. Search using ONLY the patient first name. {$patientLine}4. Select the matching patient result and verify patient details auto-populated.
5. If required fields remain empty, call the back-office API and fill required columns using dynamic field intents (`insured_id`, `state`, `procedure`, `diagnosis_pointer`, `charges`) instead of brittle structural selectors.
6. Click "Save Claim".
7. If validation errors remain, call the back-office API for the missing values and fill each failing field exactly, including dropdowns, DOBs, and searchable dropdowns.
8. Click "Save Claim" again.
9. Finish only after redirect to /claims or a final success/error message appears, then report that displayed message to the user.
WORKFLOW;
    }

    private function isNewProfessionalClaimPrompt(string $prompt): bool
    {
        return (bool) preg_match('/\b(create|open|start)\b.*\b(new\s+professional\s+claim|professional\s+claim|new\s+claim)\b|\bnew\s+professional\s+claim\b/i', $prompt);
    }

    private function extractPatientNameFromCreateClaimPrompt(string $prompt): string
    {
        $normalized = str_replace(['“', '”'], '"', $prompt);
        $normalized = str_replace(['‘', '’'], "'", $normalized);

        if (preg_match('/\bpatient\b\s*(?:named|name|is)?\s*["\']?([^"\'.,;:]+(?:\s+[^"\'.,;:]+){0,3})["\']?/i', $normalized, $matches)) {
            return $this->cleanExtractedName($matches[1]);
        }

        if (preg_match('/\bfor\s+patient\b\s*["\']?([^"\'.,;:]+(?:\s+[^"\'.,;:]+){0,3})["\']?/i', $normalized, $matches)) {
            return $this->cleanExtractedName($matches[1]);
        }

        return '';
    }

    private function cleanExtractedName(string $name): string
    {
        return trim(preg_replace('/\s+/', ' ', str_replace(['"', "'"], '', $name)));
    }

    private function extractFirstName(string $patientName): string
    {
        if (!$patientName) {
            return '';
        }

        $parts = preg_split('/\s+/', trim($patientName));
        return $parts[0] ?? '';
    }

    private function extractLastName(string $patientName): string
    {
        if (!$patientName) {
            return '';
        }

        if (str_contains($patientName, ',')) {
            $parts = explode(',', $patientName, 2);
            return $this->cleanExtractedName($parts[0]);
        }

        $parts = preg_split('/\s+/', trim($patientName));
        return $parts[count($parts) - 1] ?? '';
    }

    private function buildMultiActionBlock(): string
    {
        $max = config('automation.multi_action_max_chain', 5);
        return "\n# ACTION SEQUENCE (optional speed boost):\nWhen you're confident about {$max}+ simple steps (e.g., filling obvious fields), use:\n{\"action\":\"action_sequence\",\"actions\":[{\"action\":\"type\",\"selector\":\"#f1\",\"text\":\"v1\"},{\"action\":\"click\",\"selector\":\"#btn\"}]}\nMax {$max} actions per sequence. Only for simple, independent actions.\n";
    }

    private function buildClickedList(array $clickedSelectors): string
    {
        $normal = array_filter($clickedSelectors, fn($s) => !str_starts_with($s, 'BLOCKED:'));
        return !empty($normal) ? implode("\n", array_map(fn($s, $i) => ($i + 1) . ". " . $s, array_values($normal), array_keys(array_values($normal)))) : 'None yet';
    }

    private function buildBlockedList(array $clickedSelectors): string
    {
        $blocked = array_filter($clickedSelectors, fn($s) => str_starts_with($s, 'BLOCKED:'));
        return !empty($blocked) ? implode("\n", array_map(fn($s) => "🚫 " . str_replace('BLOCKED:', '', $s), $blocked)) : 'None';
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
        $block .= "Rules: Placeholder=NOT SET→must select. Already correct→SKIP. Use select_option for <select>.\n";
        return $block;
    }

    private function buildValidationErrorsBlock(array $validationErrors): string
    {
        if (empty($validationErrors)) return '';
        $block = "\n# VALIDATION TARGETS (TRUTH SOURCE):\n";
        foreach ($validationErrors as $i => $e) {
            $field = $e['field'] || $e['fieldIntent'] || 'Unknown field';
            $selector = $e['selector'] ? " selector={$e['selector']}" : '';
            $type = !empty($e['isCombobox']) ? ' combobox/searchable dropdown' : ($e['type'] ? " {$e['type']}" : '');
            $block .= ($i + 1) . ". {$field}{$type}: {$e['text']}.{$selector}\n";
        }
        $block .= "Rules: Fill these exact failing fields first. Use field intents for Procedure/CPT, Diagnosis Pointer, Charges, State, and Insured ID. Do NOT scroll randomly.\n";
        return $block;
    }

    private function buildQuickFillStateBlock(array $quickFillState): string
    {
        if (empty($quickFillState) || empty($quickFillState['active'])) return '';
        $searched = !empty($quickFillState['searched']) ? 'searched' : 'not searched';
        $optionClicked = !empty($quickFillState['optionClicked']) ? 'option clicked' : 'option not clicked';
        $selected = !empty($quickFillState['selected']) ? 'selected' : 'not selected';
        $restarts = (int) ($quickFillState['restartCount'] ?? 0);
        $patient = $quickFillState['patientName'] ?? '';
        $block = "\n# QUICK FILL STATE:\nactive=true, {$searched}, {$optionClicked}, {$selected}, restarts={$restarts}";
        if ($patient) $block .= ", patient={$patient}";
        $block .= "\nRules: If the patient dropdown is open, click the exact matching patient option. Do NOT click New Professional Claim again while still on /claims. If the option click failed, retry exact option selection before continuing.\n";
        return $block;
    }

    private function buildComboboxStatesBlock(array $elements): string
    {
        $combos = array_filter($elements, fn($el) => !empty($el['comboboxState']['isCombobox']));
        if (empty($combos)) return '';
        $block = "\n# COMBOBOX FIELDS (type→auto-select):\n";
        foreach ($combos as $cb) {
            $label = $cb['ariaLabel'] ?? $cb['name'] ?? $cb['id'] ?? $cb['selector'] ?? '?';
            $val = $cb['currentValue'] ?? '(empty)';
            $hasChip = !empty($cb['comboboxState']['hasSelectedChip']);
            $status = ($val && $val !== '(empty)') || $hasChip ? '✓ HAS VALUE' : '⚠️ EMPTY';
            $block .= "- \"{$label}\" ({$cb['selector']}): \"{$val}\" [{$status}]" . ($hasChip ? ' [chip]' : '') . "\n";
        }
        return $block;
    }

    private function buildFormFieldStatus(array $elements): string
    {
        $inputs = array_filter($elements, fn($el) => in_array($el['tagName'] ?? '', ['input', 'textarea', 'select']));
        if (empty($inputs)) return '';
        $empty = []; $filled = [];
        foreach ($inputs as $f) {
            $id = $f['id'] ?? $f['name'] ?? $f['selector'] ?? '?';
            $val = $f['currentValue'] ?? $f['selectedOptionText'] ?? '';
            $isP = !empty($f['isPlaceholderSelected']);
            if ($val && !$isP) { $filled[] = $id; } else { $empty[] = $id; }
        }
        if (empty($empty)) return '';
        $block = "\n# FORM STATUS:\nEMPTY: " . implode(', ', array_slice($empty, 0, 12)) . "\n";
        if ($filled) $block .= "FILLED: " . implode(', ', array_slice($filled, 0, 12)) . "\n";
        return $block;
    }

    private function buildSopProgressBlock(array $sopProgress, array $history): string
    {
        if (empty($sopProgress) || empty($history)) return '';
        $step = count($history);
        $unique = $sopProgress['uniqueFieldsInteracted'] ?? 0;
        $rate = round(($sopProgress['recentNewFieldRate'] ?? 1) * 100);
        $stag = $sopProgress['isStagnating'] ?? false;
        $block = "\n# PROGRESS (step {$step}): {$unique} unique fields, {$rate}% new-field rate\n";
        if ($stag) $block .= "⚠️ STAGNATING: No new progress. SUBMIT NOW or call finish.\n";
        elseif ($rate == 0 && $step > 5) $block .= "⚠️ No new fields recently. Consider submitting.\n";
        return $block;
    }

    private function getApiCatalog(): string
    {
        return <<<'CATALOG'
# ═══════════════════════════════════════════════════════════════════════
# BACK-OFFICE BACKEND API SPECIFICATIONS (RESTful JSON)
# ═══════════════════════════════════════════════════════════════════════
Use this catalog to construct your "action": "call_api" parameters.
Do NOT invent endpoints or parameters. Explicitly follow these routes:

**1. Patients Module (Ability: patients:read)**
- GET /api/v1/patients  -> List patients for the active organization. Optional query filters: ?first_name=STRING, ?last_name=STRING, or both.
- GET /api/v1/patients/{id} -> Retrieve a single patient profile by their unique ID.

**2. Claims Module (Ability: claims:read)**
- GET /api/v1/claims    -> List claims for the active organization.
- GET /api/v1/claims/{id} -> Retrieve a single detailed claim record.

**3. Eligibility Verification (EV) Requests & Results**
- POST /api/v1/eligibility/requests -> Submit a realtime eligibility verification request.
- GET /api/v1/eligibility/requests/{id} -> Retrieve a single EV request configuration.
- GET /api/v1/eligibility/results/by-dos/{dos} -> List EV results on a date of service (YYYY-MM-DD).
- GET /api/v1/eligibility/results/{id} -> Retrieve a single verification record details by ID.

**4. Organizations & Infrastructure**
- GET /api/v1/organizations -> List organizations the authenticated user belongs to.
- GET /api/v1/organizations/{id} -> Retrieve a single organization metadata profile.
- GET /api/v1/auth/me -> Return the active user profile identity context and organizational assignment mapping.

**5. New Professional Claim Test Results**
- GET /test-results -> Return fixed sample claim result data for new professional claim creation. No parameters required.

**USAGE PARAMS RULES:**
- Paths containing `{id}` or `{dos}` placeholders MUST be passed dynamically as path variables. Your parameter block should separate path mapping keys cleanly.
- Example: For `/api/v1/patients/45`, pass: "api_endpoint": "/api/v1/patients/{id}" and "api_params": {"id": 45}
CATALOG;
    }

    /**
     * Enhancement 4: Pre-flight CSS Selector Validator
     */
    private function validateCssSelector(string $selector): array
    {
        // Check for known invalid patterns
        if (str_contains($selector, ':contains(')) {
            return ['valid' => false, 'reason' => ':contains() is NOT valid CSS. Use [aria-label], text matching, or data attributes.', 'suggestion' => 'Use attribute selectors like [aria-label="text"] or element IDs'];
        }
        if (str_contains($selector, ':has(') && !str_contains($selector, ':not(')) {
            return ['valid' => false, 'reason' => ':has() has limited browser support. Avoid it.', 'suggestion' => 'Target the element directly with ID, class, or attribute selector'];
        }
        if (preg_match('/\$\(/', $selector)) {
            return ['valid' => false, 'reason' => 'jQuery syntax ($()) is not valid CSS.', 'suggestion' => 'Use standard CSS: #id, .class, tag[attr="val"]'];
        }
        if (str_contains($selector, '//') || str_contains($selector, 'xpath')) {
            return ['valid' => false, 'reason' => 'XPath is not CSS. Use CSS selectors only.', 'suggestion' => 'Convert XPath to CSS: //div[@id="x"] → #x'];
        }
        if (preg_match('/[^\\\\][\[\(]\s*$/', $selector)) {
            return ['valid' => false, 'reason' => 'Unclosed bracket in selector.', 'suggestion' => 'Check bracket matching'];
        }
        if (empty(trim($selector))) {
            return ['valid' => false, 'reason' => 'Empty selector.', 'suggestion' => 'Provide a valid CSS selector from the elements list'];
        }

        // Try to validate syntax (basic check — real validation happens in content script)
        // Check for obviously malformed selectors
        if (preg_match('/^[^a-zA-Z#.\[\*:@]/', trim($selector))) {
            return ['valid' => false, 'reason' => 'Selector starts with invalid character.', 'suggestion' => 'Start with tag, #id, .class, or [attr]'];
        }

        return ['valid' => true, 'reason' => '', 'suggestion' => ''];
    }
}
