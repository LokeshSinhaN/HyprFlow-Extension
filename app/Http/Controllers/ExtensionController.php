<?php

namespace App\Http\Controllers;

use App\Services\AiService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

class ExtensionController extends Controller
{
    public function __construct(private readonly AiService $ai)
    {
    }

    /**
     * POST /api/extension/loop
     *
     * Receives the current page state from the Chrome Extension,
     * builds a ReAct prompt, calls the AI brain, and returns the
     * next action as JSON.
     */
    public function loop(Request $request): JsonResponse
    {
        // 1. Receive data from the Chrome Extension
        $prompt = $request->input('prompt');
        $url = $request->input('url');
        $elements = $request->input('elements', []);

        if (!$prompt) {
            return response()->json(['error' => 'Prompt is required'], 400);
        }

        $history = $request->input('history', []);
        $historyJson = empty($history) ? "No previous actions. This is the first step." : json_encode($history, JSON_PRETTY_PRINT);

        // Extension-tracked state for smarter decisions
        $clickedSelectors = $request->input('clickedSelectors', []);
        $toggledOptions = $request->input('toggledOptions', []);
        $postPopupDirective = $request->input('postPopupDirective', '');
        $consecutiveListTabsCount = (int) $request->input('consecutiveListTabsCount', 0);
        $lastActionFailed = (bool) $request->input('lastActionFailed', false);
        $lastActionError = $request->input('lastActionError', '');

        // Build clicked-elements list for the AI
        $clickedList = !empty($clickedSelectors)
            ? implode("\n", array_map(fn($s, $i) => ($i + 1) . ". " . $s, $clickedSelectors, array_keys($clickedSelectors)))
            : 'None yet';

        // Build toggle state info
        $toggleStateInfo = !empty($toggledOptions)
            ? json_encode($toggledOptions, JSON_UNESCAPED_UNICODE)
            : 'None yet';

        // Limit elements to prevent massive payloads
        $sliceCount = min(max(count($elements), 60), count($elements));
        $pageInfo = json_encode([
            'url' => $url,
            'elements' => array_slice($elements, 0, $sliceCount),
            'elementCount' => count($elements)
        ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

        // Build post-popup directive block (injected by background.js after non-navigable popups)
        $popupDirectiveBlock = '';
        if ($postPopupDirective !== '') {
            $popupDirectiveBlock = "\n\n⚠️ SYSTEM DIRECTIVE (HIGHEST PRIORITY):\n{$postPopupDirective}\n";
        }

        // 2. Build the full ReAct AI Prompt (ported from AutomationService::doAi)
        $aiPrompt = <<<PROMPT
You are an advanced autonomous browser agent using the ReAct (Reason + Act) framework.
Goal: {$prompt}
{$popupDirectiveBlock}

# CURRENT STATE
URL: {$url}
Clickable Elements (JSON):
{$pageInfo}

# ACTION HISTORY (CRITICAL MEMORY)
You must review this history to understand what you have already tried.
{$historyJson}

# CLICKED ELEMENTS (do NOT re-click the SAME selector — but elements with DEEPER or DIFFERENT CSS paths are always NEW):
{$clickedList}

# HIERARCHICAL ELEMENT RULE:
When you click an element that reveals additional nested elements (e.g. expand → child inside → next action inside), every revealed element is a DISTINCT element with its own deeper selector. You MUST click each one in sequence as directed by the SOP. These are never "re-clicks" of a previous element.

# RESPONSE FORMAT
You MUST respond with EXACTLY ONE JSON object, no markdown blocks, no extra text.
{
    "thought": "1. Analyze current page state. 2. Verify what happened after last step. 3. Decide the exact next action.",
    "action": "click|type|hover|select_option|extract|navigate|finish|switch_tab|new_tab|list_tabs|close_tab",
    "selector": "exact css selector from the elements list",
    "text": "text to type (if type action)",
    "option": "exact text of the option to select (if select_option action)",
    "unselect": false,
    "url": "url to navigate to (if navigate action)",
    "index": "tab index integer (if switch_tab action)",
    "summary": "brief summary of completion (if finish action)"
}

- If the goal is complete: {"thought":"...", "action":"finish", "summary":"brief summary"}
- To extract data: {"thought":"...", "action":"extract", "selector":"optional container selector"}
- For DROPDOWN menus with unselect: {"thought":"...", "action":"select_option", "selector":"...", "option":"value", "unselect":true}
- For text input fields: {"thought":"...", "action":"type", "selector":"...", "text":"value"}
- CRITICAL: When the target element is a <select> dropdown, use "select_option" instead of "type".

# FAILURE HANDLING (CRITICAL — prevents silent failure passthrough):
- Each action in the history has an "actionSuccess" field (true/false).
- If the LAST action has "actionSuccess": false, you MUST retry that SOP step with a DIFFERENT selector or approach.
- Do NOT skip to the next SOP step after a failure. Do NOT call "finish" if the previous step failed.
- After a form submission (clicking Add/Save/Submit), verify the result: if the form/modal is STILL visible with the same fields, the submission FAILED. Retry with a different approach.
- Only move forward in the SOP when the previous step has genuinely succeeded.

# TREE NODE CLICK RULE (CRITICAL — Telerik RadTreeView, jsTree, Kendo):
- When clicking tree node items, ALWAYS target the innermost text element (e.g., the element with class "rtIn", ".jstree-anchor", ".k-in") — NOT the outer wrapper "div".
- The system automatically resolves outer wrappers to inner nodes, but you should prefer selectors that target span.rtIn or similar from the elements list.
- After clicking a tree node, wait for AJAX content to load. The "Full View" link or document preview may take 2-3 seconds to appear.
- If a document item doesn't show expected links after clicking, re-observe the page — the content may have loaded into a different panel.

# POST-ACTION VERIFICATION:
- After submitting a form (clicking Add/Save/Submit/OK), visually verify the outcome before calling "finish".
- If a modal/dialog is still open with the same form fields, the submission likely failed — do NOT call finish.
- If an error message or validation warning appeared, report it in your thought and retry.
- Only call "finish" when you can confirm the task completed (modal closed, success message appeared, or page navigated away).

# LOOP PREVENTION RULES (CRITICAL)
1. DO NOT repeatedly click the exact same selector if the page URL hasn't changed.
2. If your last action was a click and you are still on the same page with the same elements, the CLICK FAILED. Choose a DIFFERENT selector or action.
3. If you are stuck in a menu, try clicking a parent element or a different trigger.
4. DO NOT re-select the exact same dropdown option from history. If the page didn't change, the selection was already applied. Move forward.
5. If you have already interacted with an element, ALWAYS progress forward. Never go backward in the SOP.
6. Check the CLICKED ELEMENTS list above — do NOT click any selector already listed there UNLESS it is at a deeper CSS nesting level (child element).

# TAB/WINDOW MANAGEMENT:
- The extension AUTOMATICALLY detects and switches to new tabs/windows after every click.
- If a click opened a new tab, focus is ALREADY switched — proceed directly to the next SOP step.
- Use {"action":"list_tabs"} to see all open tabs (searches ALL windows, not just current).
- Use {"action":"switch_tab","index":N} to switch to a specific tab.
- Use {"action":"close_tab"} to close the current tab when finished.
- When a button/link opens content in the SAME page (inline viewer, panel, report), proceed to the next SOP step without any tab-switch actions.

# NON-NAVIGABLE POPUP RULE (CRITICAL — PDF viewers, document streams):
- When a click opens a non-navigable tab (PDF, document stream), the system AUTOMATICALLY closes it and keeps you on the main page.
- After such a click, you are STILL on the main page. Do NOT call list_tabs.
- Do NOT re-click the same button. Do NOT try to switch tabs.
- IMMEDIATELY proceed to the NEXT SOP step (e.g., next iteration).

# HOVER MENUS (CRITICAL):
- Elements with "hiddenInHoverMenu": true are HIDDEN inside dropdown menus.
- To interact with them, you MUST FIRST use a "hover" action on the element's "hoverTriggerSelector".
- In the NEXT step, use a "click" action on the now-visible target element.
- NEVER use a "click" action on the hover trigger itself! Clicking a hover trigger often navigates away. Use ONLY "hover" for triggers.

# TREE VIEW / EXPANDABLE NODES (CRITICAL):
- Some elements have "isTreeExpandButton": true — these are expand/collapse buttons for tree nodes.
- Some elements have "isTreeNode": true — these are tree node folders that may need expansion.
- If a folder has child items you need to access, you MUST first click the expand button to reveal children.
- Elements with "hasExpandButton": true have an "expandButtonSelector" property. Use it!
- Check "isExpanded": false/true to know if the node is collapsed or expanded.
- Two-step pattern: (1) Click expand button, (2) Click desired child item.

# DROPDOWN HANDLING:
- When you want to unselect an item: {"action":"select_option", "selector":"...", "option":"...", "unselect":true}
- The system checks if the item is already unselected and skips if so.

# TOGGLE TRACKING (prevents re-toggling loop):
- Previously toggled options: {$toggleStateInfo}
- Do NOT re-toggle any option listed above.

# DYNAMIC PATTERN LEARNING (AUTOMATIC):
- TRACK which elements have been processed: maintain a list of clicked selectors.
- AFTER completing any action, choose the NEXT unprocessed element.
- How to find next element:
  1. Get all clickable elements matching the pattern (e.g., similar ID pattern)
  2. Filter out elements already clicked (check against CLICKED ELEMENTS list)
  3. Click the first remaining unclicked element
- NEVER click an element already clicked in this session — always progress forward.

Only one action per response.
PROMPT;

        try {
            // 3. Ask the Brain (Gemini/OpenAI)
            $response = $this->ai->generate($aiPrompt);

            if ($response === null) {
                return response()->json(['error' => 'AI generation failed'], 500);
            }

            // 4. Parse JSON from AI response (strip markdown if any)
            $cleanJson = preg_replace('/```(?:json)?\s*(.*?)\s*```/s', '$1', $response);
            $decision = json_decode(trim($cleanJson), true);

            if (!$decision || !isset($decision['action'])) {
                Log::warning('Failed to parse AI decision', ['raw' => $response]);
                return response()->json(['error' => 'Invalid AI response format'], 500);
            }

            // 5. Return decision to Extension
            return response()->json($decision);

        } catch (\Exception $e) {
            Log::error('Extension Loop Error: ' . $e->getMessage());
            return response()->json(['error' => $e->getMessage()], 500);
        }
    }

    /**
     * GET /api/extension/health
     *
     * Health check endpoint — verifies the backend is running
     * and AI providers are configured.
     */
    public function health(): JsonResponse
    {
        $configErrors = $this->ai->validateConfig();

        return response()->json([
            'status' => 'ok',
            'service' => 'hyprflow-ce',
            'port' => (int) env('EXTENSION_PORT', 8001),
            'ai_configured' => empty($configErrors),
            'ai_errors' => $configErrors,
            'primary_ai' => config('automation.primary_ai'),
            'timestamp' => now()->toIso8601String(),
        ]);
    }
}
