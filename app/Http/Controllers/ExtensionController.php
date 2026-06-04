<?php

namespace App\Http\Controllers;

use App\Services\AiService;
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
        private readonly SiteKnowledgeService $siteKnowledge
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
        $url = $request->input('url');
        $elements = $request->input('elements', []);
        $imageBase64 = $request->input('image');
        $somMap = $request->input('somMap', []);
        $dropdownStates = $request->input('dropdownStates', []);
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
        $comboboxStatesBlock = $this->buildComboboxStatesBlock($elements);
        $formFieldStatus = $this->buildFormFieldStatus($elements);
        $sopProgressBlock = $this->buildSopProgressBlock($sopProgress, $history);
        $planContext = $this->buildPlanContext($planSteps, $currentPlanStepIndex);

        // Gap C: Site Knowledge
        $siteKnowledgeBlock = '';
        if (config('automation.site_knowledge_enabled', true) && $url) {
            $siteKnowledgeBlock = $this->siteKnowledge->buildKnowledgeBlock($url);
        }

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

        // Dynamic user prompt
        $userPrompt = "{$modeIndicator}\n{$somDescription}\nGoal: {$prompt}\n{$planContext}\n{$popupDirectiveBlock}\n{$reflexionBlock}\n{$siteKnowledgeBlock}\n{$dropdownStatesBlock}\n{$comboboxStatesBlock}\n{$formFieldStatus}\n{$sopProgressBlock}\n{$multiActionBlock}\n\n# CURRENT STATE\nURL: {$url}\nElements:\n{$pageInfo}\n\n# ACTION HISTORY\n{$historyJson}\n\n# CLICKED ELEMENTS:\n{$clickedList}\n\n# BLOCKED SELECTORS:\n{$blockedList}\n\n# TOGGLE STATE:\n{$toggleStateInfo}";

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
                    'has_sql_query' => !empty($decision['sql_query']),
                ]);
            }

            // Log query_database actions for audit trail
            if ($decision['action'] === 'query_database') {
                Log::info('Agent requesting database query', [
                    'sql_query' => $decision['sql_query'] ?? 'NONE',
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
            $selectorFreeActions = ['ask_user', 'query_database', 'finish', 'navigate', 'extract', 'scroll_down', 'scroll_up', 'action_sequence', 'batch_fill'];

            if (in_array($action, ['click', 'type', 'hover', 'select_option', 'keyboard_event']) && !empty($decision['selector'])) {
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
                if (!empty($decision['somIndex']) && !empty($somMap) && isset($somMap[(string)$decision['somIndex']])) {
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
        
        $claimProtocol = "If the user goal involves 'claim', 'rejected', 'approve', or 'fix', your plan MUST strictly consist of these 6 steps:\n"
            . "Step 1: INSPECTION - Click action menu and select 'View Errors' on the claim row.\n"
            . "Step 2: ESCAPE POPUP - Read errors and close the modal.\n"
            . "Step 3: INITIATION - Click action menu and select 'Edit'.\n"
            . "Step 4: AUTO-POPULATE - Search patient in 'QUICK FILL' section and select from the dropdown.\n"
            . "Step 5: RESOLUTION - Fix validation errors using human-in-the-loop (ask_user) or database queries.\n"
            . "Step 6: PERSISTENCE - Click 'Save Claim' and handle any post-save errors.\n";

        $aiPrompt = "You are a workflow planner for a browser automation agent.\nUser Goal: {$prompt}{$rejectionNote}\n\n{$claimProtocol}\nRespond with ONE JSON object:\n{\"plan\":[\"Step 1: ...\",\"Step 2: ...\"]}\n\nMake steps concise, actionable, max 10 steps. Be specific about clicks, typing, verification.";

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
  "sql_query": "SELECT ... (optional, only for query_database)",
  "ask_user_prompt": "Question for the human (only for ask_user action)"
}
# CRITICAL: The "conversational_message" field is MANDATORY in every single response. Never omit it.
# CRITICAL: The "status" field defaults to "executing". Set to "awaiting_human" ONLY when using "ask_user" action.

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
# MANDATORY REJECTED CLAIMS PROTOCOL (DEFAULT STEPS)
# ═══════════════════════════════════════════════════════════════════════
When processing tasks regarding fixing or approving rejected claims, you MUST execute this workflow without deviation:

1. INSPECTION: Target the claims row action button (three dots), click it, and use a valid "text_match" parameter of "View Errors" or "View Details" to locate the reason string.
2. ESCAPE POPUP: Extract the text inside the rejection alert box, then immediately use a clean selector or an Escape key token to close the modal view. Do not linger trying to fill elements here.
3. INITIATION: Click the claim row action dots again, and select "Edit" via text matching to enter the form playground.
4. AUTO-POPULATE: Select the "Search Patient..." text field located specifically in the "QUICK FILL FORM PATIENT RECORD" card block. Input the patient name, wait for the drop-down option to pop up, and select it to trigger automatic form state population.
5. CONVERSATIONAL HUMAN-IN-THE-LOOP RESOLUTION: Scan the fields with validation errors. Stop automation loops immediately. Return an "ask_user" payload stating the precise required missing context (e.g., missing NPI), offering either a specific database lookup query recommendation or text box input option.
6. PERSISTENCE: Click "Save Claim" to pass back to the primary claim dashboard, verify execution bounds, and trigger "finish".

# ═══════════════════════════════════════════════════════════════════════
# SECTION 2: CONVERSATIONAL HUMAN-IN-THE-LOOP STATE RULES
# ═══════════════════════════════════════════════════════════════════════
# You are a COLLABORATIVE agent. You must communicate with your human supervisor at every step.

## 2A. STATUS REPORTING (Every Turn)
- Your "conversational_message" MUST explain what you currently see and what you intend to do next.
- Good examples:
  * "I see that claim XYZCLM is rejected because of an invalid Billing Provider NPI. I am opening the Edit form now."
  * "Quick Fill has populated most fields. The 'Billing Provider NPI' and 'Service Facility Phone' fields remain empty — these match the rejection errors. I need to ask for the correct values."
  * "I have filled the NPI field with the value you provided. Now clicking 'Save Claim'."
- Bad examples (DO NOT DO THIS):
  * "" (empty — NEVER leave conversational_message blank)
  * "Clicking button" (too vague — explain WHY and WHAT you see)

## 2B. TRIGGERING THE HUMAN-IN-THE-LOOP PAUSE (ask_user Action)
- When you arrive at a field that was flagged with an error during Phase A (e.g., Missing NPI, invalid phone format, incorrect provider info), you MUST STOP your automatic execution loop.
- Change your response to:
  {
    "thought": "The Billing Provider NPI field is empty and was flagged in the rejection. I need the correct value from the human.",
    "action": "ask_user",
    "status": "awaiting_human",
    "conversational_message": "I found that the Billing Provider NPI field is empty, which caused the claim rejection. I have drafted a database look-up query to find the valid NPI. Should I execute this query, or would you prefer to type the NPI manually?",
    "ask_user_prompt": "Please provide the Billing Provider NPI, or type 'run query' to execute the suggested SQL lookup.",
    "sql_query": "SELECT npi_number FROM billing_providers WHERE provider_name LIKE '%Santos%' AND provider_type = 'billing' LIMIT 5;"
  }
- The "ask_user" action PAUSES the automation loop and waits for the human to respond.
- DO NOT continue executing actions after emitting ask_user — the system will halt and wait.

## 2C. HANDLING DATA RESOLUTION FORMATS (After Human Responds)
- When the human provides a response, it will appear in your next turn's context.
- If the human provides a direct value (e.g., "1234567890"):
  → Use "batch_fill" or "type" action to fill the value into the correct field(s).
  → Report: "Thank you. I am entering NPI 1234567890 into the Billing Provider NPI field now."
- If the human approves a SQL query (e.g., "run query" or "yes, execute"):
  → Use "query_database" action with the sql_query field on your VERY NEXT turn.
  → Report: "Executing the database lookup query to retrieve the valid NPI..."
- If the human provides multiple values for multiple fields:
  → Use "batch_fill" to fill all provided values at once.
  → Example: {"action":"batch_fill","fields":[{"selector":"#npi","text":"1234567890"},{"selector":"#phone","text":"555-0123"}]}

## 2D. QUERY DATABASE ACTION
- When the human approves your SQL query, execute it:
  {
    "thought": "Human approved the SQL query. Executing database lookup.",
    "action": "query_database",
    "sql_query": "SELECT npi_number FROM billing_providers WHERE provider_name LIKE '%Santos%' LIMIT 1;",
    "conversational_message": "Executing database query to retrieve the valid data..."
  }
- Once the database returns results, you MUST evaluate the target field type:
  * If the target is a standard input box: Use "batch_fill" or "type".
  * If the target is a SEARCHABLE COMBOBOX (e.g., Payer dropdown): You MUST use "type" to enter the value, wait for the dropdown to appear, and then use "click" to select the option in the subsequent turn.

# ═══════════════════════════════════════════════════════════════════════
# SECTION 3: POST-SAVE EXCEPTION HANDLING
# ═══════════════════════════════════════════════════════════════════════
# After clicking "Save Claim" or any submit button, DO NOT assume success.

## 3A. POST-SAVE VERIFICATION
1. After clicking Save, observe the page for 2-3 seconds.
2. Check for: success messages, error banners, validation error tags, modal closures, URL changes.
3. If the page shows a success message or the modal closes → report success and call "finish".

## 3B. POST-SAVE ERROR RECOVERY
1. If NEW or UNRESOLVED verification error tags appear after saving:
   - DO NOT call "finish".
   - Read ALL new error messages carefully.
   - Transition back into the conversational loop:
     {
       "thought": "Save failed with new validation errors. I need to ask the user how to proceed.",
       "action": "ask_user",
       "status": "awaiting_human",
       "conversational_message": "The claim save failed. New error: 'Diagnosis Code A (Primary) is required'. Should I run a database query to find this code, or will you type it?",
       "ask_user_prompt": "Please provide Diagnosis Code A, or type 'run query'.",
       "sql_query": "SELECT diagnosis_code_primary FROM claims WHERE ..."
     }
   - After receiving human input, fill the fields and attempt Save again.
   - Repeat this cycle until Save succeeds or the human explicitly instructs you to stop.

## 3C. CRITICAL: NEVER ABANDON ON ERROR
- If save fails, you MUST re-enter the ask_user loop. Never silently call "finish" when errors exist.
- The only valid ways to end the workflow:
  (a) Save succeeds with no errors → call "finish" with a success summary.
  (b) Human explicitly says "stop", "cancel", or "abort" → call "finish" with a cancellation summary.

# ═══════════════════════════════════════════════════════════════════════
# SECTION 4: CORE AUTOMATION RULES
# ═══════════════════════════════════════════════════════════════════════

## 4A. JSON ONLY
- Output EXACTLY ONE valid JSON object per turn. No markdown fences, no conversational text outside JSON.
- If you must communicate, use the "conversational_message" field inside the JSON.

## 4B. PRECISION
- Only interact with elements explicitly listed in the DOM state. Do NOT hallucinate or guess CSS selectors.
- If an element is not in the elements list, it does not exist on the page.

## 4C. EFFICIENCY
- Use "action_sequence" to chain up to 5 simple, independent actions (e.g., filling obvious non-error fields).
- Use "batch_fill" to fill multiple standard text inputs at once. Do NOT use batch_fill for dropdowns.
- NEVER use action_sequence or batch_fill for fields that were flagged with errors — those MUST go through the ask_user flow.

## 4D. ANTI-LOOP
- If an action fails or the page doesn't change, try a DIFFERENT approach (different selector, keyboard navigation, etc.).
- If you've tried 3 different approaches on the same element, ask the user for help via ask_user.

## 4E. AVAILABLE ACTIONS
- Standard DOM: click, type, hover, select_option, scroll_down, scroll_up, extract, navigate
- Form Speed: action_sequence, batch_fill
- Fallback: keyboard_event, click_coordinate
- Human-in-the-Loop: ask_user (pauses for human input), query_database (SQL lookup)
- Termination: finish (ONLY when task is truly complete or human says stop)

## 4F. DROPDOWNS & COMBOBOXES
- Static <select>: Use "select_option" with selector and option text.
- Searchable Comboboxes (role="combobox"): Use "type" action on the trigger element — the system handles open→type→select automatically.
- Static Framework Selects (Radix/shadcn): Use "click" to open, then "click" the option, or "keyboard_event" with ArrowDown+Enter.

## 4G. SCROLLING
- If scrolled=0, the container cannot scroll further. Try a different container, use Tab, or interact directly.
- Do NOT scroll endlessly — if you've scrolled 3+ times without finding the target, use a different approach.

## 4H. POST-ACTION VERIFICATION
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
