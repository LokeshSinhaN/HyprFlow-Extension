<?php

namespace App\Http\Controllers;

use App\Services\AiService;
use App\Services\SeleniumService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

class ExtensionController extends Controller
{
    public function __construct(
        private readonly AiService $ai,
        private readonly SeleniumService $selenium
    ) {
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
        $imageBase64 = $request->input('image');
        $somMap = $request->input('somMap', []);
        $dropdownStates = $request->input('dropdownStates', []);
        $sopProgress = $request->input('sopProgress', []);

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

        // Build clicked-elements list for the AI (filter out BLOCKED: prefixed ones)
        $normalClicked = array_filter($clickedSelectors, fn($s) => !str_starts_with($s, 'BLOCKED:'));
        $clickedList = !empty($normalClicked)
            ? implode("\n", array_map(fn($s, $i) => ($i + 1) . ". " . $s, array_values($normalClicked), array_keys(array_values($normalClicked))))
            : 'None yet';

        // Build blocked selectors list (dynamically populated when loops are detected)
        $blockedSelectors = array_filter($clickedSelectors, fn($s) => str_starts_with($s, 'BLOCKED:'));
        $blockedList = !empty($blockedSelectors)
            ? implode("\n", array_map(fn($s) => "🚫 " . str_replace('BLOCKED:', '', $s), $blockedSelectors))
            : 'None (no fields have been blocked yet)';

        // Build toggle state info
        $toggleStateInfo = !empty($toggledOptions)
            ? json_encode($toggledOptions, JSON_UNESCAPED_UNICODE)
            : 'None yet';

        // Build dropdown states block
        $dropdownStatesBlock = '';
        if (!empty($dropdownStates)) {
            $dropdownStatesBlock = "\n# CURRENT DROPDOWN VALUES (AUTHORITATIVE SOURCE OF TRUTH — DO NOT ASSUME!)\n";
            $dropdownStatesBlock .= "⚠️ WARNING: These are the ACTUAL current values read from the DOM. Do NOT hallucinate or assume different values.\n";
            foreach ($dropdownStates as $dropdown) {
                $label = $dropdown['label'] ?? $dropdown['text'] ?? 'unknown';
                $currentValue = $dropdown['currentValue'] ?? '(empty)';
                $isPlaceholder = !empty($dropdown['isPlaceholder']);
                $status = $isPlaceholder ? '⚠️ NOT SET (placeholder/default)' : '✓ SET';
                $dropdownStatesBlock .= "- \"{$label}\" (selector: {$dropdown['selector']}): currently = \"{$currentValue}\" [{$status}]\n";
            }
            $dropdownStatesBlock .= "\nDROPDOWN RULES:\n";
            $dropdownStatesBlock .= "1. If a dropdown shows a PLACEHOLDER (e.g., 'Select gender', 'Choose...', '--'), it is NOT set. You MUST select the correct value.\n";
            $dropdownStatesBlock .= "2. If a dropdown ALREADY shows the desired value (e.g., shows 'Male' and task says Male), SKIP it.\n";
            $dropdownStatesBlock .= "3. NEVER assume a dropdown is set without checking the values above.\n";
            $dropdownStatesBlock .= "4. Use 'select_option' action for <select> dropdowns, NOT 'type'.\n";
        }

        // Build combobox states block (searchable dropdowns that need type-then-select)
        $comboboxStatesBlock = '';
        $comboboxElements = array_filter($elements, fn($el) =>
            !empty($el['comboboxState']) && ($el['comboboxState']['isCombobox'] ?? false)
        );
        if (!empty($comboboxElements)) {
            $comboboxStatesBlock = "\n# COMBOBOX / SEARCHABLE DROPDOWN FIELDS (require type → then click option):\n";
            $comboboxStatesBlock .= "⚠️ These fields are NOT regular inputs. They are searchable dropdowns.\n";
            $comboboxStatesBlock .= "Pattern: type search text → wait for dropdown → click the matching option.\n";
            $comboboxStatesBlock .= "The system auto-detects and clicks options when possible, but verify in history.\n\n";
            foreach ($comboboxElements as $cbEl) {
                $cbLabel = $cbEl['ariaLabel'] ?? $cbEl['name'] ?? $cbEl['id'] ?? $cbEl['selector'] ?? 'unknown';
                $cbValue = $cbEl['currentValue'] ?? '(empty)';
                $cbState = $cbEl['comboboxState'];
                $hasChip = !empty($cbState['hasSelectedChip']);
                $status = ($cbValue && $cbValue !== '(empty)') || $hasChip ? '✓ HAS VALUE' : '⚠️ EMPTY (needs selection)';
                $comboboxStatesBlock .= "- \"{$cbLabel}\" (selector: {$cbEl['selector']}): value=\"{$cbValue}\" [{$status}]";
                if ($hasChip) {
                    $comboboxStatesBlock .= " [has selection chip]";
                }
                $comboboxStatesBlock .= "\n";
            }
            $comboboxStatesBlock .= "\nCOMBOBOX RULES:\n";
            $comboboxStatesBlock .= "1. Use \"type\" action to search, then the system auto-selects the matching option.\n";
            $comboboxStatesBlock .= "2. If auto-selection fails, you'll get a directive to manually click the option.\n";
            $comboboxStatesBlock .= "3. A combobox is ONLY properly set when it shows a chip/tag (not raw text).\n";
            $comboboxStatesBlock .= "4. If the combobox already has a chip with the correct value, SKIP it.\n";
        }

        // Build SoM map description (only when vision/image is provided)
        $somDescription = '';
        $hasVision = !empty($imageBase64) && strlen($imageBase64) > 1000;
        if (!empty($somMap) && $hasVision) {
            $somDescription = "\n# SET-OF-MARK (SoM) LABELS\n";
            $somDescription .= "The screenshot shows numbered red boxes around elements.\n";
            $somDescription .= "Use \"somIndex\" in your response to reference elements by their number.\n";
            $somDescription .= "SoM Map: " . json_encode($somMap) . "\n";
        }
        
        // Mode indicator for the AI
        $modeIndicator = $hasVision
            ? "MODE: VISION (screenshot provided — use visual + DOM data)"
            : "MODE: DOM-ONLY (no screenshot — rely on element selectors, IDs, values, and field status)";

        // Build form field status summary (helps AI see what's filled vs empty)
        $formFieldStatus = '';
        $inputFields = array_filter($elements, fn($el) =>
            in_array($el['tagName'] ?? '', ['input', 'textarea', 'select'])
        );
        if (!empty($inputFields)) {
            $filledFields = [];
            $emptyFields = [];
            foreach ($inputFields as $field) {
                $fieldId = $field['id'] ?? $field['name'] ?? $field['selector'] ?? 'unknown';
                $fieldType = $field['type'] ?? $field['tagName'] ?? '';
                $currentVal = $field['currentValue'] ?? $field['selectedOptionText'] ?? '';
                $isPlaceholder = !empty($field['isPlaceholderSelected']);
                
                if ($currentVal && !$isPlaceholder && $currentVal !== '') {
                    $filledFields[] = "{$fieldId} ({$fieldType}): \"{$currentVal}\"";
                } else {
                    $emptyFields[] = "{$fieldId} ({$fieldType}): EMPTY";
                }
            }
            if (!empty($emptyFields)) {
                $formFieldStatus = "\n# FORM FIELD STATUS (EMPTY fields need to be filled!):\n";
                $formFieldStatus .= "EMPTY/UNFILLED: " . implode(', ', array_slice($emptyFields, 0, 15)) . "\n";
                if (!empty($filledFields)) {
                    $formFieldStatus .= "ALREADY FILLED: " . implode(', ', array_slice($filledFields, 0, 15)) . "\n";
                }
            }
        }

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
            $popupDirectiveBlock = "\n\n⚠️ NAVIGATION/STATE DIRECTIVE:\n{$postPopupDirective}\n";
        }

        // Build dynamic SOP progress block
        $sopProgressBlock = '';
        if (!empty($sopProgress) && !empty($history)) {
            $uniqueFields = $sopProgress['uniqueFieldsInteracted'] ?? 0;
            $totalActions = $sopProgress['totalSuccessfulActions'] ?? 0;
            $recentRate = $sopProgress['recentNewFieldRate'] ?? 1;
            $isStagnating = $sopProgress['isStagnating'] ?? false;
            $stepCount = count($history);
            
            $sopProgressBlock = "\n# TASK PROGRESS (DYNAMIC — step {$stepCount}):\n";
            $sopProgressBlock .= "- Unique fields interacted: {$uniqueFields}\n";
            $sopProgressBlock .= "- Total successful actions: {$totalActions}\n";
            $sopProgressBlock .= "- Recent new-field rate: " . round($recentRate * 100) . "% (0% = no new fields being touched)\n";
            
            if ($isStagnating) {
                $sopProgressBlock .= "⚠️ STAGNATION DETECTED: You are no longer making progress on new fields.\n";
                $sopProgressBlock .= "→ If all SOP steps have been attempted, SUBMIT the form and call 'finish'.\n";
                $sopProgressBlock .= "→ Do NOT keep retrying fields that already failed multiple times.\n";
            } elseif ($recentRate == 0 && $stepCount > 5) {
                $sopProgressBlock .= "⚠️ WARNING: No new fields in recent steps. Consider if you've completed all SOP steps.\n";
            }
        }

        // 2. Build the full ReAct AI Prompt with Vision + SoM + Enhanced State Checking
        $aiPrompt = <<<PROMPT
You are an advanced autonomous browser agent. {$modeIndicator}
{$somDescription}
Goal: {$prompt}
{$popupDirectiveBlock}
{$dropdownStatesBlock}
{$comboboxStatesBlock}
{$formFieldStatus}
{$sopProgressBlock}

# CURRENT STATE
URL: {$url}
Clickable Elements (JSON):
{$pageInfo}

# ACTION HISTORY (CRITICAL MEMORY)
You must review this history to understand what you have already tried.
{$historyJson}

# CLICKED ELEMENTS (do NOT re-click the SAME selector — but elements with DEEPER or DIFFERENT CSS paths are always NEW):
{$clickedList}

# BLOCKED SELECTORS (ABSOLUTE BAN — these fields FAILED repeatedly and are permanently blocked):
{$blockedList}
⚠️ If a selector appears in BLOCKED SELECTORS, you MUST NOT interact with it. Skip it entirely and move to the next SOP step.

# SCROLLING (use when elements are not visible in the viewport):
- Use {"action":"scroll_down"} to scroll down and reveal hidden elements (like submit buttons at bottom of forms)
- Use {"action":"scroll_up"} to scroll back up
- If you cannot see a submit/save button in the screenshot, scroll down first
- IMPORTANT: If scrolling fails to reveal the submit button after 2-3 attempts, try clicking directly:
  1) button[type="submit"]
  2) [role="dialog"] form button:last-of-type
  3) Any button containing "Add", "Save", or "Submit" text
- The system will auto-attempt to find and click submit buttons if scroll loops are detected

# HIERARCHICAL ELEMENT RULE:
When you click an element that reveals additional nested elements (e.g. expand → child inside → next action inside), every revealed element is a DISTINCT element with its own deeper selector. You MUST click each one in sequence as directed by the SOP. These are never "re-clicks" of a previous element.

# RESPONSE FORMAT
You MUST respond with EXACTLY ONE JSON object, no markdown blocks, no extra text.
{
    "thought": "1. Analyze the SCREENSHOT and current page state. 2. Check CURRENT DROPDOWN VALUES section - if status shows 'NOT SET (placeholder/default)' you MUST select the value; if already correct, SKIP. 3. Verify what happened after last step. 4. Decide the exact next action.",
    "action": "click|type|hover|select_option|scroll_down|scroll_up|extract|navigate|batch_fill|finish|switch_tab|new_tab|list_tabs|close_tab",
    "somIndex": "number from red box on screenshot (if available, prefer this over selector)",
    "selector": "MUST BE PROVIDED. exact css selector from the elements list (fallback if somIndex not available). NEVER leave this empty!",
    "text": "text to type (if type action)",
    "option": "exact text of the option to select (if select_option action)",
    "fields": [{"selector":"#field_id","text":"value"}, ...],
    "unselect": false,
    "url": "url to navigate to (if navigate action)",
    "index": "tab index integer (if switch_tab action)",
    "summary": "brief summary of completion (if finish action)"
}

CRITICAL: The "selector" field MUST contain a valid CSS selector. NEVER respond with an empty or undefined selector. Always pick the most specific selector from the elements list.

- If the goal is complete: {"thought":"...", "action":"finish", "summary":"brief summary"}
- To extract data: {"thought":"...", "action":"extract", "selector":"optional container selector"}
- For DROPDOWN menus with unselect: {"thought":"...", "action":"select_option", "selector":"...", "option":"value", "unselect":true}
- For text input fields: {"thought":"...", "action":"type", "selector":"...", "text":"value"}
- CRITICAL: When the target element is a <select> dropdown, use "select_option" instead of "type".

# DROPDOWN STATE CHECKING (CRITICAL - MUST FOLLOW EXACTLY):
- ALWAYS check the "CURRENT DROPDOWN VALUES" section above BEFORE deciding on any dropdown
- If a dropdown shows a PLACEHOLDER like "Select gender", "Choose...", or "--", it is NOT SET. You MUST use select_option to set it.
- If a dropdown ALREADY shows the exact desired value (e.g., shows "Male" and task says Male), SKIP it - proceed to next step
- NEVER assume a dropdown is already set without verifying against the CURRENT DROPDOWN VALUES section
- If the CURRENT DROPDOWN VALUES section shows "⚠️ NOT SET (placeholder/default)" for a dropdown, you MUST select the correct value
- Use "select_option" action (NOT "type") for all <select> dropdowns
- The "option" field must contain the exact text of the option to select (e.g., "Male", not "male")

# SEARCHABLE DROPDOWN / COMBOBOX HANDLING (CRITICAL — type-then-select pattern):
- Some dropdowns are NOT <select> elements — they are searchable input fields (comboboxes/autocomplete)
- These elements have roleHint="combobox" or comboboxState in the elements list
- PATTERN: You type text into the search field → a dropdown list appears → you MUST click the matching option
- After typing into a combobox, the system AUTOMATICALLY attempts to detect and click the dropdown option
- If the action result shows "autoSelectedDropdown": true in history, the selection succeeded — move to next step
- If the action result shows "dropdownVisibleNotSelected": true, a dropdown appeared but wasn't auto-clicked
  → You MUST observe the page and click the correct option element in your NEXT action
  → Look for elements with [role="option"], li items, or similar that contain the desired text
  → Use "click" action on the matching option — do NOT re-type or call "finish"
- The field is ONLY properly set when it shows a "chip", "tag", or formatted value (e.g., "Aetna (60054) ×")
- If after typing the field still shows raw text without a chip/tag, the selection may have FAILED
- For combobox fields: NEVER call "finish" after just typing — verify the selection was confirmed
- If no dropdown appeared after typing (comboboxNoDropdownAppeared), try:
  1. Click the dropdown arrow/chevron button next to the field
  2. Try a shorter search term (e.g., "Aet" instead of "Aetna")
  3. Click the field first, wait, then type

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

# SoM (Set-of-Mark) USAGE:
- Look at the SCREENSHOT: red numbered boxes show interactive elements
- Prefer using "somIndex" (the number in the box) over CSS selectors when available
- The somIndex maps to exact selectors automatically
- Example: "somIndex": "5" means click the element with box #5

# DATE INPUT HANDLING (CRITICAL — prevents typing failures):
- HTML5 date inputs (type="date") show "dd-mm-yyyy" or "mm/dd/yyyy" as placeholder
- You MUST type dates in DD-MM-YYYY format (e.g., "18-05-2001") — the system auto-converts to the correct format
- If a date field still shows the placeholder after typing, the system handles the conversion internally
- Do NOT try different date formats yourself — just use the format from the SOP (e.g., "18-05-2001")
- The system will automatically parse and convert any date format to what the browser needs

# VISUAL VERIFICATION PRIORITY (CRITICAL — prevents hallucination):
- The SCREENSHOT is the GROUND TRUTH of the page state
- If the screenshot shows "Select gender" in a dropdown but some text says it's "Male", TRUST THE SCREENSHOT
- NEVER assume a field is filled if the screenshot shows it empty/placeholder
- After each action, visually verify in the NEXT screenshot that the action actually took effect
- If a field still shows its placeholder in the screenshot, the previous action FAILED — retry it

# BATCH FILL (SPEED OPTIMIZATION — fill multiple form fields in ONE step):
- When you see multiple empty text/date fields on the same form, use "batch_fill" action to fill them all at once
- This is MUCH faster than filling one field per step (saves 1-2 seconds per field)
- Format: {"action":"batch_fill","fields":[{"selector":"#field1","text":"value1"},{"selector":"#field2","text":"value2"}]}
- Use batch_fill for regular text inputs, date inputs, and simple selects
- Do NOT include combobox/searchable dropdown fields in batch_fill (they need individual handling)
- Example: Fill name fields together: {"action":"batch_fill","fields":[{"selector":"#first_name","text":"John"},{"selector":"#last_name","text":"Doe"},{"selector":"#email","text":"john@example.com"}]}

# FORM COMPLETION & SUBMISSION (DYNAMIC — driven by TASK PROGRESS above):
- Check the "TASK PROGRESS" section above to understand your completion state
- If "STAGNATION DETECTED" appears, you MUST submit the form immediately
- If "Recent new-field rate: 0%" and you've interacted with many fields, you're likely done — submit
- After attempting all SOP steps (check your ACTION HISTORY), click the submit/save button
- If some fields couldn't be filled (loop detected), proceed to submit anyway — form validation will guide you
- After clicking submit: if page changes or modal closes → call "finish"
- If validation errors appear after submit → fix ONLY those errors, then re-submit
- NEVER get stuck retrying a field that already failed 3+ times — move forward
- If the FORM FIELD STATUS shows most fields are filled and you've been running many steps, SUBMIT NOW

Only one action per response.
PROMPT;

        try {
            // 3. Ask the Brain (Gemini/OpenAI) - Use Vision if image provided and valid
            $response = null;
            $visionFailed = false;
            $triedVision = false;

            if ($imageBase64 && strlen($imageBase64) > 1000) {
                $triedVision = true;
                try {
                    // Try OpenAI first for vision (better vision support)
                    if (!empty(config('openai.api_key'))) {
                        Log::info('Using OpenAI Vision for extension agent', ['image_size' => strlen($imageBase64)]);
                        $response = $this->ai->generateVision($aiPrompt, $imageBase64, 'openai');
                    }

                    // If OpenAI failed, try Gemini
                    if (!$response && !empty(config('gemini.api_key'))) {
                        Log::info('Trying Gemini Vision for extension agent', ['image_size' => strlen($imageBase64)]);
                        $response = $this->ai->generateVision($aiPrompt, $imageBase64, 'gemini');
                    }
                } catch (\Exception $visionError) {
                    Log::warning('Vision failed, falling back to text-only', ['error' => $visionError->getMessage()]);
                    $visionFailed = true;
                }

                // Check if vision response indicates an error
                if ($response && (str_contains($response, 'Cannot read') || str_contains($response, 'does not support image') || str_contains($response, 'image input'))) {
                    Log::warning('Vision model does not support images, using text-only');
                    $visionFailed = true;
                    $response = null;
                }
            } else {
                $visionFailed = true;
            }

            // Fallback to text-only ONLY if we don't have a valid response
            // (vision succeeded = $response is not null, so don't override it)
            if ($response === null) {
                $provider = $triedVision ? null : config('automation.primary_ai', 'gemini');
                Log::info('Using text-only AI mode' . ($provider ? " with {$provider}" : ""), [
                    'vision_tried' => $triedVision,
                    'vision_failed' => $visionFailed,
                    'had_image' => !empty($imageBase64)
                ]);
                $response = $this->ai->generate($aiPrompt, $provider);
            } else {
                Log::info('Vision AI response received successfully', ['response_length' => strlen($response)]);
            }

            if ($response === null) {
                $errorMsg = $this->ai->getLastError() ?: 'AI generation failed';
                Log::error('AI generation failed', ['error' => $errorMsg]);
                return response()->json(['error' => $errorMsg], 500);
            }

            // 4. Parse JSON from AI response (strip markdown if any)
            $cleanJson = preg_replace('/```(?:json)?\s*(.*?)\s*```/s', '$1', $response);
            $decision = json_decode(trim($cleanJson), true);

            if (!$decision || !isset($decision['action'])) {
                Log::warning('Failed to parse AI decision', ['raw' => substr($response, 0, 500)]);
                return response()->json(['error' => 'Invalid AI response format'], 500);
            }

            // 5. Resolve SoM index to selector if provided
            if (!empty($decision['somIndex']) && !empty($somMap)) {
                $somIndex = (string) $decision['somIndex'];
                if (isset($somMap[$somIndex])) {
                    $decision['selector'] = $somMap[$somIndex];
                    Log::info("Resolved SoM index {$somIndex} to selector: {$decision['selector']}");
                }
            }

            // 6. Validate selector is present and not empty
            $action = $decision['action'] ?? '';
            if (in_array($action, ['click', 'type', 'hover', 'select_option']) && empty($decision['selector'])) {
                // If no selector, try to use somIndex, or return error
                if (!empty($decision['somIndex']) && !empty($somMap) && isset($somMap[(string)$decision['somIndex']])) {
                    $decision['selector'] = $somMap[(string)$decision['somIndex']];
                    Log::info("Used somIndex to resolve missing selector: {$decision['selector']}");
                } else {
                    Log::warning('AI returned empty selector', ['action' => $action, 'decision' => $decision]);
                    return response()->json([
                        'error' => 'AI returned empty selector. Must provide CSS selector for ' . $action . ' action.',
                        'retry' => true
                    ], 500);
                }
            }

            // 7. Return decision to Extension
            return response()->json($decision);

        } catch (\Exception $e) {
            Log::error('Extension Loop Error: ' . $e->getMessage());
            return response()->json(['error' => $e->getMessage()], 500);
        }
    }

    /**
     * POST /api/extension/generate-selenium
     *
     * Receives the action history from the Chrome Extension after an agent run,
     * processes the trace, and generates a production-ready Python Selenium script.
     */
    public function generateSelenium(Request $request): JsonResponse
    {
        $history = $request->input('history', []);
        $goal = $request->input('goal', '');
        $startUrl = $request->input('startUrl', '');

        if (empty($history)) {
            return response()->json([
                'success' => false,
                'message' => 'No action history provided. Run the AI agent first.',
            ], 400);
        }

        if (!$goal) {
            $goal = 'Automate the actions performed in the recorded trace.';
        }

        // If the SOP doesn't mention a URL, inject the startUrl the agent was running on
        // so the generated Selenium code navigates to the correct website.
        if ($startUrl && !preg_match('#https?://#i', $goal)) {
            $goal = "Go to {$startUrl} and then: " . $goal;
        }

        try {
            $result = $this->selenium->generateSelenium($history, $goal, $startUrl);
            return response()->json($result);
        } catch (\Exception $e) {
            Log::error('Selenium generation error: ' . $e->getMessage());
            return response()->json([
                'success' => false,
                'message' => $e->getMessage(),
            ], 500);
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

    /**
     * POST /api/extension/plan
     *
     * Receives the user prompt and generates a structured Plan of Action (Workflow/SOP)
     * before the agent starts executing tasks.
     */
    public function plan(Request $request): JsonResponse
    {
        $prompt = $request->input('prompt');
        $isRejected = $request->input('rejected', false);

        if (!$prompt) {
            return response()->json(['error' => 'Prompt is required'], 400);
        }

        $rejectionNote = $isRejected 
            ? "CRITICAL: The user REJECTED your previous plan. You MUST generate a COMPLETELY DIFFERENT plan of action. Propose an alternative workflow." 
            : "";

        $aiPrompt = <<<PROMPT
You are a master workflow planner for an autonomous browser agent.
Your task is to analyze the user's goal and break it down into a clear, step-by-step Standard Operating Procedure (SOP).

User Goal: {$prompt}
{$rejectionNote}

# RESPONSE FORMAT
You MUST respond with EXACTLY ONE JSON object, containing an array of steps.
{
    "plan": [
        "Step 1: Navigate to the appropriate section.",
        "Step 2: Fill out the necessary fields.",
        "Step 3: Click save and verify the result."
    ]
}

Make the steps concise and actionable. Limit to maximum 10 steps.
PROMPT;

        try {
            $provider = config('automation.primary_ai', 'gemini');
            $response = $this->ai->generate($aiPrompt, $provider);

            if ($response === null) {
                $errorMsg = $this->ai->getLastError() ?: 'AI planning failed';
                Log::error('AI planning failed', ['error' => $errorMsg]);
                return response()->json(['error' => $errorMsg], 500);
            }

            $cleanJson = preg_replace('/```(?:json)?\s*(.*?)\s*```/s', '$1', $response);
            $planData = json_decode(trim($cleanJson), true);

            if (!$planData || !isset($planData['plan'])) {
                Log::warning('Failed to parse AI plan', ['raw' => substr($response, 0, 500)]);
                return response()->json(['error' => 'Invalid AI response format'], 500);
            }

            return response()->json(['plan' => $planData['plan']]);
        } catch (\Exception $e) {
            Log::error('Plan Generation Error: ' . $e->getMessage());
            return response()->json(['error' => $e->getMessage()], 500);
        }
    }
}
