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
                    // Gemini-only vision (with built-in retry)
                    $response = $this->ai->generateVision($visionPrompt, $imageBase64, 'gemini');
                } catch (\Exception $e) {
                    Log::warning('Gemini Vision failed', ['error' => $e->getMessage()]);
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

            // Resolve SoM index
            if (!empty($decision['somIndex']) && !empty($somMap)) {
                $somIndex = (string) $decision['somIndex'];
                if (isset($somMap[$somIndex])) {
                    $decision['selector'] = $somMap[$somIndex];
                }
            }

            // Enhancement 4: CSS Selector Validator (skip validation when text_match is the primary target)
            $action = $decision['action'] ?? '';
            if (in_array($action, ['click', 'type', 'hover', 'select_option', 'keyboard_event']) && !empty($decision['selector']) && empty($decision['text_match'])) {
                $validation = $this->validateCssSelector($decision['selector']);
                if (!$validation['valid']) {
                    return response()->json([
                        'error' => "INVALID_SELECTOR: {$validation['reason']}",
                        'suggestion' => $validation['suggestion'],
                        'retry' => true,
                    ]);
                }
            }

            // Validate selector presence — text_match is an acceptable alternative to selector
            if (in_array($action, ['click', 'type', 'hover', 'select_option']) && empty($decision['selector']) && empty($decision['text_match'])) {
                if (!empty($decision['somIndex']) && !empty($somMap) && isset($somMap[(string)$decision['somIndex']])) {
                    $decision['selector'] = $somMap[(string)$decision['somIndex']];
                } else {
                    return response()->json(['error' => 'Empty selector for ' . $action . '. Provide selector or text_match.', 'retry' => true], 500);
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
        $aiPrompt = "You are a workflow planner for a browser automation agent.\nUser Goal: {$prompt}{$rejectionNote}\n\nRespond with ONE JSON object:\n{\"plan\":[\"Step 1: ...\",\"Step 2: ...\"]}\n\nMake steps concise, actionable, max 10 steps. Be specific about clicks, typing, verification.";

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
You are an advanced autonomous browser agent in a Chrome Extension.
You observe page state (DOM elements + optional screenshot) and decide the next action.

# RESPONSE FORMAT — EXACTLY ONE JSON object, no markdown, no extra text:
{"thought":"...","action":"click|type|hover|select_option|scroll_down|scroll_up|extract|navigate|batch_fill|keyboard_event|click_coordinate|action_sequence|finish|switch_tab|new_tab|list_tabs|close_tab","selector":"CSS selector","text_match":"visible text to match","role_hint":"button|menuitem|option|link|switch|tab|checkbox","somIndex":"number","text":"","option":"","keys":[],"fields":[],"actions":[],"url":"","index":"","summary":"","planStepCompleted":false}

# TARGETING ELEMENTS (CRITICAL RULES):
- PREFER text_match: If an element has clear visible text (e.g., "Add to Cart", "Teal", "Edit"), use "text_match": "Edit" instead of guessing CSS selectors. You may combine it with "role_hint": "menuitem" for precision.
- NEVER guess nth-child positions for dropdowns, menus, or lists. Always use text_match to click the exact option.
- NEVER use :has-text() or Playwright syntax in CSS selectors. Use the native text_match JSON key instead.
- NEVER use :contains() or :has() — NOT valid in querySelector.
- When both text_match and selector are provided, text_match takes priority.
- Use "selector" only when text_match is ambiguous (e.g., multiple "Edit" buttons) and you have a reliable CSS selector from the elements list.

# RULES:
- "selector" OR "text_match" MUST be provided for click/type/hover/select_option. Both may be provided.
- One action per response (unless action_sequence).
- If goal complete: {"action":"finish","summary":"..."}

# ACTIONS:
- click, type, hover, select_option, scroll_down/up, extract, navigate, batch_fill
- keyboard_event: {"action":"keyboard_event","selector":"#el","keys":["ArrowDown","Enter"]}
- click_coordinate: {"action":"click_coordinate","somIndex":5} — fallback when CSS fails
- action_sequence: {"action":"action_sequence","actions":[{...},{...}]} — multi-step chain
- finish, switch_tab, new_tab, list_tabs, close_tab

# DROPDOWN RULES:
- Check CURRENT DROPDOWN VALUES before acting
- PLACEHOLDER shown → MUST select value via select_option
- Already correct → SKIP
- <select> → use select_option. Combobox → use type (system auto-selects)

# COMBOBOX (searchable dropdown):
- roleHint="combobox" = searchable input, NOT <select>
- Type search → system auto-clicks match → verify "autoSelectedDropdown":true in history
- If "dropdownVisibleNotSelected" → click the option element next step
- Only set when chip/tag visible (not raw text)

# KEYBOARD EVENT:
- Keys: Enter, Escape, Tab, ArrowDown, ArrowUp, Backspace, Space, Delete
- Use for: confirming selections, closing modals, menu navigation

# CLICK COORDINATE (fallback):
- Uses SoM bounding box center. Only when CSS click fails 2+ times.

# CONTENTEDITABLE:
- YouTube comments, rich editors use contenteditable divs
- System handles automatically — just use "type" action

# SCROLL:
- "scrolled":0 = container can't scroll further. Try different container.
- "scrollFailed":true = wrong target. Use keyboard Tab or click directly.
- After 2-3 failed scrolls, click elements directly.

# FAILURE HANDLING:
- actionSuccess:false → MUST retry with DIFFERENT approach
- Never skip failed step. Never finish after failure.
- After submit: if form still visible → submission FAILED

# LOOP PREVENTION:
- Don't re-click same selector if page unchanged
- Check CLICKED/BLOCKED lists
- If stuck → different selector, different action type, or skip

# BATCH FILL: {"action":"batch_fill","fields":[{"selector":"#f","text":"v"},...]}
- Fast multi-field fill. Don't include comboboxes.

# ACTION SEQUENCE (Gap B): {"action":"action_sequence","actions":[{"action":"type","selector":"#a","text":"x"},{"action":"click","text_match":"Submit"}]}
- Chain up to 5 confident actions. Use when multiple simple steps are obvious.
- Each action in sequence must be independent (no conditional logic).

# POST-ACTION VERIFICATION (SELF-HEALING):
- After clicking a menu item or button, you MUST observe the next DOM state to verify the expected modal, page, or dropdown opened.
- If you clicked "Edit" but a "View Details" modal opened, your click failed. You MUST click "Cancel"/close the modal, and retry using a more specific text_match or ref_id.
- DO NOT call "action": "finish" unless you have positively verified the final success state on the screen (e.g., "Added to Cart" confirmation, or modal disappeared after submit).
- After "Add to Cart" → verify confirmation badge/popup
- After form submit → verify modal closed or success message appeared

# PLAN STEP TRACKING:
- Set "planStepCompleted":true when current plan step is done
- Focus on ONE plan step at a time
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
            return ['valid' => false, 'reason' => ':contains() is NOT valid CSS. Use text_match JSON key instead.', 'suggestion' => 'Use "text_match": "visible text" to target elements by their visible text'];
        }
        if (str_contains($selector, ':has-text(') || str_contains($selector, ':has-text (')) {
            return ['valid' => false, 'reason' => ':has-text() is Playwright syntax, NOT valid CSS. Use text_match JSON key instead.', 'suggestion' => 'Use "text_match": "visible text" instead of :has-text() pseudo-class'];
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
