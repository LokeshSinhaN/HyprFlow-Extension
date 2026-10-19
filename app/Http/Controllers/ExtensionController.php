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
        $systemPrompt = config('automation.system_prompt_separation', true) ? $this->buildSystemPrompt($prompt) : null;
        if ($systemPrompt) {
            $systemPrompt = str_replace('{{API_CATALOG_PLACEHOLDER}}', $apiCatalogBlock, $systemPrompt);
            if ($agentMode) {
                $systemPrompt .= "\n\n# AGENT MODE ACTIVE: Do NOT generate strict CSS selectors. Rely EXCLUSIVELY on plain-text instructions using the `text_match`, `role_hint`, and `conversational_message` fields to target elements semantically based on their visible text.";
            }
        }

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

            // If goal_satisfied is set by the model, complete the task immediately
            if (!empty($decision['goal_satisfied'])) {
                $decision['action'] = 'finish';
                $decision['status'] = 'completed';
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
        
        $guidance = "For browser automation workflows (forms, portals, creation, e-commerce, search, dashboards):\n"
            . "- Make steps concise, actionable, and logical (max 6-8 steps).\n"
            . "- Break the goal down naturally based on the target website and interface.\n"
            . "- For form filling or record creation tasks: Navigate -> Locate form/creation trigger -> Fill required fields -> Submit -> Verify success.\n"
            . "- Always conclude with a step to verify goal completion.\n";

        $aiPrompt = "You are an intelligent workflow planner for a browser automation agent.\nUser Goal: {$prompt}{$rejectionNote}\n\n{$guidance}\nRespond with ONE JSON object:\n{\"plan\":[\"Step 1: ...\",\"Step 2: ...\"]}\n\nMake steps concise, actionable, max 8 steps. Be specific about clicks, typing, and verification.";

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

    private function buildSystemPrompt(string $prompt = ''): string
    {
        return $this->buildUniversalSystemPrompt();
    }

    private function buildUniversalSystemPrompt(): string
    {
        return <<<'SYSTEM'
You are an intelligent, autonomous AI browser automation agent. You operate directly on live web applications across ANY website and tech stack (forms, portals, creation workflows, e-commerce, video/media, SaaS, productivity tools, search engines, dashboards).

You perceive the web page through screenshots with numbered bounding boxes (Set-of-Mark / SoM indexes) and structured interactive DOM elements.

# ═══════════════════════════════════════════════════════════════════════
# MANDATORY RESPONSE FORMAT
# ═══════════════════════════════════════════════════════════════════════
Output EXACTLY ONE valid JSON object per turn. No markdown fences outside JSON, no conversational text outside JSON:
{
  "thought": "Brief step-by-step reasoning: 1) Is goal satisfied? 2) Are modals/drawers open? 3) What is next logical action?",
  "goal_satisfied": false,
  "action": "click|type|select_option|hover|scroll_down|scroll_up|action_sequence|batch_fill|navigate|ask_user|finish",
  "selector": "valid CSS selector, e.g. #add-to-cart-button or button",
  "text": "text to type (if action is type)",
  "text_match": "visible text to match (if clicking element by text)",
  "somIndex": 1,
  "conversational_message": "Human-readable status update explaining what you see and what you are doing (ALWAYS REQUIRED)",
  "status": "executing|awaiting_human"
}

# ═══════════════════════════════════════════════════════════════════════
# CRITICAL OPERATIONAL PROTOCOLS
# ═══════════════════════════════════════════════════════════════════════

## 1. FIRST-CLASS GOAL SATISFACTION (ZERO LAG COMPLETION)
- On EVERY turn, evaluate: "Has the user's primary goal already been accomplished?"
- Examples:
  - If the goal is record/item creation or submission: If confirmation banner or created item details are displayed -> finish.
  - If the goal is "add X to cart": If on Cart page with item listed, or "Added to Cart" confirmation banner is visible -> finish.
  - If the goal is to play a video or audio: If video is playing on watch page -> finish.
  - If the goal is to submit a comment or form: If the submission is verified -> finish.
- NEVER perform redundant actions or restart from scratch once the goal has been achieved!

## 2. INTERSTITIALS, UPSELLS & MODALS
- Dismiss optional popups, cookies, or upsells autonomously by clicking "No thanks", "Skip", "Close", "Dismiss", or "Continue".
- Do not mistake optional modals or banners for task failures.

## 3. MACRO-LOOP & CYCLE AVOIDANCE
- DO NOT repeat multi-step loops.
- If an action fails or the page doesn't change, try a DIFFERENT approach (different selector, keyboard navigation, etc.).

## 4. ACCURATE SELECTOR & TEXT TARGETING
- NEVER generate pseudo-selectors like `:has-text()`, `:contains()`, or `:text()`. These are invalid CSS syntax.
- When clicking elements by visible text or label, use `text_match`:
  {"action": "click", "selector": "button, a, div", "text_match": "Create"}
- If using Set-of-Marks (SoM), provide "somIndex" corresponding to the red numbered box on the screenshot.

## 5. AVAILABLE ACTIONS
- click: Click element (specify selector, text_match, or somIndex).
- type: Type text into an input or textarea (specify selector and text).
- select_option: Choose option in native <select> (specify selector and option).
- scroll_down / scroll_up: Scroll page or container.
- action_sequence: Chain up to 5 simple, independent actions (e.g., fill fields, click next).
- batch_fill: Fill multiple text inputs at once.
- ask_user: Pause agent and ask human supervisor when genuinely stuck or missing required information.
- finish: Complete task when goal is achieved (or goal_satisfied=true).
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

    private function getApiCatalog(): string
    {
        return <<<'CATALOG'
# ═══════════════════════════════════════════════════════════════════════
# BACK-OFFICE BACKEND API SPECIFICATIONS (RESTful JSON)
# ═══════════════════════════════════════════════════════════════════════
Use this catalog to construct your "action": "call_api" parameters.
Do NOT invent endpoints or parameters. Explicitly follow these routes:

**1. Patients Module (Ability: patients:read)**
- GET /api/v1/patients  -> List patients for the active organization. Optional query filters: ?last_name=STRING
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
