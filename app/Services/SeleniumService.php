<?php

namespace App\Services;

use Illuminate\Support\Facades\Log;

/**
 * Generates production-ready Python Selenium scripts from the Chrome Extension's
 * action history trace. Ported from hyprflow-webapp AutomationService::doGenerateSelenium.
 *
 * Pipeline:
 *   1. Filter out tab-management housekeeping actions
 *   2. Annotate each click/hover with pre-built Python find_one() code
 *   3. Build a step codebook (ready-to-copy Python lines per step)
 *   4. Send the annotated trace + codebook to the LLM with strict selector-fidelity rules
 *   5. Return { success: true, code: "..." } or { success: false, message: "..." }
 */
class SeleniumService
{
    public function __construct(
        private readonly AiService $ai
    ) {}

    /**
     * Generate a Selenium script from the extension's action history.
     *
     * @param  array  $history   Rich action history from background.js
     * @param  string $goal      The SOP / user prompt
     * @param  string $startUrl  The URL the agent was running on when it started
     * @return array  { success: bool, code?: string, message?: string }
     */
    public function generateSelenium(array $history, string $goal, string $startUrl = ''): array
    {
        // ── 1. EXTRACT TARGET URL ──────────────────────────────────────
        $targetUrl = $startUrl;
        if (!$targetUrl) {
            // Try to find the first URL from history
            foreach ($history as $entry) {
                $url = $entry['url'] ?? '';
                if ($url && preg_match('#^https?://#i', $url)) {
                    $targetUrl = $url;
                    break;
                }
            }
        }

        // ── 2. FILTER OUT TAB-MANAGEMENT ACTIONS ───────────────────────
        $tabActions = ['switch_tab', 'switch_to_newest_tab', 'close_tab', 'list_tabs'];
        $trace = array_values(array_filter($history, function ($entry) use ($tabActions) {
            $action = $entry['action'] ?? '';
            // Keep only real SOP actions, skip tab management and loop-detected entries
            return !in_array($action, $tabActions, true) && empty($entry['loopDetected']);
        }));

        if (empty($trace)) {
            return ['success' => false, 'message' => 'No actionable steps in history after filtering.'];
        }

        // ── 3. ANNOTATE EACH ENTRY WITH PRE-BUILT PYTHON CODE ─────────
        $stepCodebookLines = [];
        $annotatedTrace = [];

        foreach ($trace as $idx => $entry) {
            $action = $entry['action'] ?? '';
            $css = $entry['selectors']['css'] ?? ($entry['selector'] ?? '');
            $xpath = $entry['selectors']['xpath'] ?? '';
            $id = $entry['selectors']['id'] ?? '';
            $text = $entry['selectors']['text'] ?? '';

            $hasCss = $css !== '';
            $hasId = $id !== '';
            $hasXpath = $xpath !== '';

            // Build find_one() Python call
            $pyCandidates = [];
            if ($hasCss) $pyCandidates[] = '(By.CSS_SELECTOR, ' . json_encode($css) . ')';
            if ($hasId) $pyCandidates[] = '(By.ID, ' . json_encode($id) . ')';
            if ($hasXpath) $pyCandidates[] = '(By.XPATH, ' . json_encode($xpath) . ')';

            $pyCode = null;
            if (!empty($pyCandidates)) {
                $pyList = implode(",\n        ", $pyCandidates);
                $pyCode = "find_one(driver, [\n        {$pyList}\n    ])";
            } elseif ($css) {
                $pyCode = 'driver.find_element(By.CSS_SELECTOR, ' . json_encode($css) . ')';
            }

            $entry['_pyCode'] = $pyCode;
            $entry['_index'] = $idx;

            // Build codebook line for click/hover entries
            if ($action === 'hover' && $pyCode) {
                $stepCodebookLines[] = "step_{$idx} [HOVER]:\n    elem = {$pyCode}\n    # dispatch: if elem: ActionChains(driver).move_to_element(elem).perform()";
            } elseif ($action === 'click' && $pyCode) {
                $popupOpened = !empty($entry['popup_opened']);
                $dispatch = $popupOpened
                    ? 'ctx, h = click_and_wait_for_new_window(driver, elem)'
                    : 'safe_click(driver, elem)';
                $stepCodebookLines[] = "step_{$idx} [CLICK]:\n    elem = {$pyCode}\n    # dispatch: {$dispatch}";
            } elseif ($action === 'type' && $pyCode) {
                $value = $entry['text'] ?? '';
                $stepCodebookLines[] = "step_{$idx} [TYPE]:\n    elem = {$pyCode}\n    # dispatch: elem.clear(); elem.send_keys(" . json_encode($value) . ")";
            } elseif ($action === 'select_option' && $pyCode) {
                $optVal = $entry['option'] ?? '';
                $stepCodebookLines[] = "step_{$idx} [SELECT]:\n    elem = {$pyCode}\n    # dispatch: Select(elem).select_by_visible_text(" . json_encode($optVal) . ")";
            }

            $annotatedTrace[] = $entry;
        }

        $stepCodebook = implode("\n\n", $stepCodebookLines);

        // ── 4. BUILD AUTOMATION SPEC JSON ──────────────────────────────
        $specJson = json_encode([
            'sop' => ['raw' => $goal],
            'targetUrl' => $targetUrl,
            'executionTrace' => $annotatedTrace,
        ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);

        $escapedTargetUrl = addslashes($targetUrl);

        // ── 5. BUILD LLM PROMPT ────────────────────────────────────────
        $prompt = <<<PROMPT
ROLE: You are a Senior Python Automation Architect.

TASK:
Generate ONE single-file, production-ready Python Selenium script that follows the SOP exactly.
- Use ONLY the selectors from the executionTrace entries (css/xpath/id).
- Detect repetition patterns and emit loops (do NOT duplicate blocks).
- The script must start by navigating to TARGET_URL.

TARGET_URL = "{$escapedTargetUrl}"

## STEP CODEBOOK — copy these find_one() calls VERBATIM into your script ##
{$stepCodebook}
## END OF STEP CODEBOOK ##

ABSOLUTE RULES:
- NEVER modify or substitute any selector from the STEP CODEBOOK.
- NEVER replace a recorded CSS/ID with text-based selectors like [value='...'] or By.LINK_TEXT.
- NEVER skip any step from the STEP CODEBOOK.
- For each step: use the elem assignment exactly as shown in the codebook.
- Choose dispatch based on the trace entry:
    popup_opened == true  → ctx, h = click_and_wait_for_new_window(driver, elem)
    popup_opened == false → safe_click(driver, elem)

REQUIREMENTS:
1) Selenium setup:
- Use webdriver_manager (ChromeDriverManager) and ChromeOptions.
- Use WebDriverWait + expected_conditions; minimize arbitrary sleeps.
- Import ActionChains, Select, Keys as needed.
- Add these Chrome options for PDF printing:
  options.add_argument("--kiosk-printing")

2) REQUIRED HELPER FUNCTIONS — include ALL:

def find_one(driver, candidates):
    \"\"\"Multi-strategy element finder. Tries each (By.X, selector) tuple.\"\"\"
    for by, sel in candidates:
        try:
            from selenium.webdriver.support.ui import WebDriverWait
            from selenium.webdriver.support import expected_conditions as EC
            return WebDriverWait(driver, 5).until(EC.element_to_be_clickable((by, sel)))
        except:
            try:
                return WebDriverWait(driver, 3).until(EC.presence_of_element_located((by, sel)))
            except:
                continue
    return None

def safe_click(driver, element):
    \"\"\"Click with scroll + JS fallback.\"\"\"
    if element is None: return
    try:
        driver.execute_script("arguments[0].scrollIntoView({block:'center'});", element)
        import time; time.sleep(0.3)
        element.click()
    except:
        try: driver.execute_script("arguments[0].click();", element)
        except: pass

def click_and_wait_for_new_window(driver, element, timeout=15):
    \"\"\"Click and wait for new window/tab or same-tab navigation.\"\"\"
    if element is None: return None, None
    original_handles = set(driver.window_handles)
    original_url = driver.current_url
    safe_click(driver, element)
    import time as _t; end = _t.time() + timeout
    while _t.time() < end:
        new_h = set(driver.window_handles) - original_handles
        if new_h:
            h = list(new_h)[0]
            driver.switch_to.window(h)
            return 'new_window', h
        if driver.current_url != original_url:
            return 'same_tab', driver.current_window_handle
        _t.sleep(0.5)
    return None, None

3) DYNAMIC ITERATION:
When the SOP mentions repeating for multiple items, use dynamic element discovery with
a configurable limit variable (e.g., max_items = 3).

4) The script MUST start with:
   TARGET_URL = "{$escapedTargetUrl}"
   and navigate to it: driver.get(TARGET_URL)

5) Output MUST be valid Python only. No markdown fences. No explanatory text.

INPUT_SPEC_JSON:
{$specJson}
PROMPT;

        // ── 6. CALL LLM ───────────────────────────────────────────────
        Log::info('[SeleniumGen] Calling AI', [
            'traceSteps' => count($annotatedTrace),
            'codebookSteps' => count($stepCodebookLines),
            'targetUrl' => $targetUrl,
        ]);

        $response = $this->ai->generate($prompt);

        if ($response === null) {
            $error = $this->ai->getLastError() ?? 'AI generation returned null';
            Log::error('[SeleniumGen] AI failed', ['error' => $error]);
            return ['success' => false, 'message' => 'AI code generation failed: ' . $error];
        }

        // ── 7. CLEAN RESPONSE ──────────────────────────────────────────
        // Strip markdown code fences if the LLM wrapped the output
        $code = preg_replace('/^```(?:python)?\s*/m', '', $response);
        $code = preg_replace('/\s*```\s*$/m', '', $code);
        $code = trim($code);

        if (empty($code)) {
            return ['success' => false, 'message' => 'AI returned empty code.'];
        }

        Log::info('[SeleniumGen] Code generated', ['codeLength' => strlen($code)]);

        return [
            'success' => true,
            'code' => $code,
            'message' => 'Selenium script generated successfully.',
        ];
    }
}
