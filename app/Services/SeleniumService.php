<?php

namespace App\Services;

use Illuminate\Support\Facades\Log;

/**
 * Full-fidelity Selenium code generation — ported from hyprflow-webapp
 * AutomationService::doGenerateSelenium (lines 2281-4436) + helper methods.
 *
 * Pipeline:
 *  1. Filter tab-management actions
 *  2. SOP-based trace pruning (extract target count, truncate extra iterations)
 *  3. Structural deduplication (ordinal-stripped shapes, keep 1 canonical example)
 *  4. Redundant click-after-hover filter
 *  5. Annotate each entry (selectorPresence, treeNodeRole, _pyCode, _selectorRule)
 *  6. Build traceSelectorsIndex
 *  7. Build step codebook (pre-built Python find_one calls)
 *  8. Build mandatory loop body scaffold (actual Python code)
 *  9. Build fallback flat-pattern scaffold (CSS wildcard iteration)
 * 10. Assemble the full LLM prompt with all rules
 * 11. Call AI, validate output, repair if needed, normalize
 */
class SeleniumService
{
    public function __construct(
        private readonly AiService $ai
    ) {}

    // ═══════════════════════════════════════════════════════════════
    //  PUBLIC: generateSelenium
    // ═══════════════════════════════════════════════════════════════
    public function generateSelenium(array $history, string $goal, string $startUrl = ''): array
    {
        if (empty($history)) {
            return ['success' => false, 'message' => 'No actions recorded. Run the AI agent first.'];
        }
        if (!$goal) {
            $goal = 'Automate the actions performed in the recorded trace.';
        }

        $targetUrl = $startUrl ?: ($this->extractUrlFromPrompt($goal) ?? '');
        if (!$targetUrl) {
            foreach ($history as $e) {
                $u = $e['url'] ?? '';
                if ($u && preg_match('#^https?://#i', $u)) { $targetUrl = $u; break; }
            }
        }
        $wantsGDriveUpload = (bool) preg_match('/upload.*(?:google|g)\s*drive|(?:google|g)\s*drive.*upload/i', $goal);

        // ── 1. COLLECT ALLOWED SELECTORS ────────────────────────────
        $allowedSelectors = $this->collectAllowedSelectors($history);

        // ── 2. BUILD RAW TRACE (filter tab-management) ─────────────
        $TAB_ACTIONS = ['switch_tab', 'switch_to_tab', 'switch_to_newest_tab', 'close_tab', 'list_tabs'];
        $rawTrace = array_values(array_filter(
            array_map(function (array $cmd) {
                $entry = [
                    'action'      => $cmd['action'] ?? '',
                    'target'      => $cmd['target'] ?? ($cmd['selector'] ?? ''),
                    'value'       => $cmd['value'] ?? ($cmd['text'] ?? null),
                    'option'      => $cmd['option'] ?? null,
                    'description' => $cmd['description'] ?? ($cmd['thought'] ?? ''),
                    'selectors'   => $cmd['selectors'] ?? null,
                    'url'         => $cmd['url'] ?? '',
                    'elementMeta' => $cmd['elementMeta'] ?? null,
                    'hoverTarget' => $cmd['hoverTarget'] ?? null,
                ];
                if (($cmd['action'] ?? '') === 'click') {
                    $entry['popup_opened'] = $cmd['popup_opened'] ?? null;
                }
                if (($cmd['action'] ?? '') === 'extract' || ($cmd['action'] ?? '') === 'scrape_data') {
                    $entry['extractedText'] = $cmd['extractedText'] ?? ($cmd['data']['extractedText'] ?? null);
                    $entry['domStructure']  = $cmd['domStructure'] ?? null;
                }
                return $entry;
            }, $history),
            fn ($e) => !in_array($e['action'] ?? '', $TAB_ACTIONS, true)
                    && empty($e['loopDetected'])
        ));

        if (empty($rawTrace)) {
            return ['success' => false, 'message' => 'No actionable steps after filtering.'];
        }

        // ── 3. SOP-BASED TRACE PRUNING ─────────────────────────────
        $targetCount = $this->extractTargetCountFromGoal($goal);
        if ($targetCount > 0) {
            $iterCount = 0;
            $pruneAt = count($rawTrace);
            for ($k = 0; $k < count($rawTrace); $k++) {
                if (in_array($rawTrace[$k]['action'] ?? '', ['hover', 'navigate'], true)) {
                    $iterCount++;
                    if ($iterCount > ($targetCount + 1)) { $pruneAt = $k; break; }
                }
            }
            $rawTrace = array_slice($rawTrace, 0, $pruneAt);
        }

        // ── 4. STRUCTURAL DEDUPLICATION ─────────────────────────────
        $shapeOf = function (string $s): string {
            $s = preg_replace('/:\s*nth-(?:of-type|child)\s*\(\s*\d+\s*\)/', ':nth-TYPE', $s);
            $s = preg_replace('/ctl\d{2,}/', 'ctlNN', $s);
            return $s;
        };
        $selectorOf = function (array $e) use ($shapeOf): string {
            $css = ($e['selectors']['css'] ?? '') !== '' ? $e['selectors']['css'] : ($e['target'] ?? '');
            return $shapeOf($css);
        };

        $seenShapes = [];
        $blockPos = 0;
        $RESET_ACTIONS = ['navigate', 'hover'];
        $filteredTrace = [];
        $deduplicatedShapes = [];

        foreach ($rawTrace as $entry) {
            $action = $entry['action'] ?? '';
            $shape  = $selectorOf($entry);
            $key    = "{$blockPos}:{$action}:{$shape}";

            if (in_array($action, $RESET_ACTIONS, true)) {
                if (!isset($seenShapes[$key])) {
                    $seenShapes[$key] = true;
                    $blockPos = 0;
                    $filteredTrace[] = $entry;
                }
                continue;
            }

            // Iteration-boundary fallback
            $shapeKey = "{$action}:{$shape}";
            $foundEarlier = false;
            foreach ($seenShapes as $ek => $v) {
                $parts = explode(':', $ek, 2);
                if (count($parts) === 2 && $parts[1] === $shapeKey && $parts[0] !== (string) $blockPos) {
                    $foundEarlier = true; break;
                }
            }
            if ($foundEarlier && $blockPos > 0) {
                $blockPos = 0;
                $key = "{$blockPos}:{$action}:{$shape}";
            }

            if (!isset($seenShapes[$key])) {
                $seenShapes[$key] = true;
                $filteredTrace[] = $entry;
                $blockPos++;
            } else {
                $origCss = ($entry['selectors']['css'] ?? '') !== '' ? $entry['selectors']['css'] : ($entry['target'] ?? '');
                if ($origCss && in_array($action, ['click', 'double_click'])) {
                    $deduplicatedShapes[$shape][] = $origCss;
                }
            }
        }
        $rawTrace = array_values($filteredTrace);

        // ── 5. FILTER REDUNDANT CLICKS AFTER HOVER ─────────────────
        $cleanedTrace = [];
        foreach ($rawTrace as $entry) {
            $action = $entry['action'] ?? '';
            $css    = $entry['selectors']['css'] ?? ($entry['target'] ?? '');
            if ($action === 'click' && count($cleanedTrace) > 0) {
                $last = end($cleanedTrace);
                $lastCss = $last['selectors']['css'] ?? ($last['target'] ?? '');
                if (($last['action'] ?? '') === 'hover' && $css !== '' && $css === $lastCss) {
                    continue;
                }
            }
            $cleanedTrace[] = $entry;
        }
        $rawTrace = $cleanedTrace;

        // ── 6. ANNOTATE ENTRIES ─────────────────────────────────────
        $traceForPrompt = [];
        for ($i = 0; $i < count($rawTrace); $i++) {
            $entry  = $rawTrace[$i];
            $action = $entry['action'] ?? '';

            // Hover annotation
            if ($action === 'hover') {
                $css   = $entry['selectors']['css'] ?? ($entry['target'] ?? '');
                $xpath = $entry['selectors']['xpath'] ?? '';
                $id    = $entry['selectors']['id'] ?? '';
                $pc = $this->buildPyCandidates($css, $xpath, $id);
                if ($pc) {
                    $entry['_pyCode'] = $pc;
                    $entry['_hoverDispatch'] = 'ActionChains(driver).move_to_element(elem).perform()';
                }
                $traceForPrompt[] = $entry;
                continue;
            }

            if ($action === 'click') {
                $css   = $entry['selectors']['css'] ?? ($entry['target'] ?? '');
                $xpath = $entry['selectors']['xpath'] ?? '';
                $id    = $entry['selectors']['id'] ?? '';
                $hasCss = $css !== '';  $hasId = $id !== '';  $hasXpath = $xpath !== '';
                $hasAny = $hasCss || $hasId || $hasXpath;

                $entry['selectorPresence'] = [
                    'hasCSS' => $hasCss, 'hasId' => $hasId, 'hasXpath' => $hasXpath,
                    'hasRecordedSelectors' => $hasAny,
                    'preferredStrategy' => $hasCss ? 'By.CSS_SELECTOR' : ($hasId ? 'By.ID' : ($hasXpath ? 'By.XPATH' : 'none')),
                ];

                // Tree detection
                $isTreeParent = $hasCss
                    && (bool) preg_match('/ul\s*>\s*li[^>]*>\s*\S+\s*>\s*\S+/', $css)
                    && !(bool) preg_match('/ul\s*>\s*li[^>]*>\s*ul\s*>\s*li/', $css);
                $isTreeChild = $hasCss
                    && (bool) preg_match('/ul\s*>\s*li[^>]*>\s*ul\s*>\s*li[^>]*>\s*\S+\s*>\s*\S+/', $css);

                if ($isTreeParent && $i + 1 < count($rawTrace)) {
                    $nx = $rawTrace[$i + 1];
                    if (($nx['action'] ?? '') === 'click') {
                        $nxCss = $nx['selectors']['css'] ?? ($nx['target'] ?? '');
                        $base = (string) preg_replace('/\s*>\s*\w+\s*>\s*\w+\s*$/', '', $css);
                        if ($base !== '' && str_starts_with(trim($nxCss), trim($base))
                            && (bool) preg_match('/ul\s*>\s*li/', substr($nxCss, strlen($base)))) {
                            $isTreeParent = true;
                        }
                    }
                }

                $entry['treeNodeRole'] = null;
                if ($isTreeParent) {
                    $entry['treeNodeRole'] = 'tree_parent_expand';
                    $entry['_note'] = 'EXPAND: clicking reveals nested child elements. The NEXT trace entry is inside the expanded container. Add time.sleep(1.5) between expand and child click.';
                }
                if ($isTreeChild) {
                    $entry['treeNodeRole'] = 'tree_child_document';
                    $entry['_note'] = 'NESTED ELEMENT: click immediately after parent-expand. Use exact recorded CSS/XPath. Wrap in: if nested_elem: safe_click(driver, nested_elem)';
                }

                if ($hasAny) {
                    $strategies = array_filter([$hasCss ? 'By.CSS_SELECTOR' : null, $hasId ? 'By.ID' : null, $hasXpath ? 'By.XPATH' : null]);
                    $entry['_selectorRule'] = 'RECORDED_SELECTORS_PRESENT: use ' . implode(' or ', $strategies) . '. By.LINK_TEXT FORBIDDEN.';
                    $entry['_pyCode'] = $this->buildPyCandidates($css, $xpath, $id);
                } else {
                    $entry['_selectorRule'] = 'NO_RECORDED_SELECTORS: use exact selector from execution.';
                    $exact = $css ?: ($entry['target'] ?? '');
                    $entry['_pyCode'] = $exact ? 'driver.find_element(By.CSS_SELECTOR, ' . json_encode($exact) . ')' : null;
                }
            }

            // type / select_option annotation
            if (in_array($action, ['type', 'select_option']) && !isset($entry['_pyCode'])) {
                $css   = $entry['selectors']['css'] ?? ($entry['target'] ?? '');
                $xpath = $entry['selectors']['xpath'] ?? '';
                $id    = $entry['selectors']['id'] ?? '';
                $entry['_pyCode'] = $this->buildPyCandidates($css, $xpath, $id);
            }

            $traceForPrompt[] = $entry;
        }

        // ── 7. BUILD TRACE SELECTORS INDEX ─────────────────────────
        $traceSelectorsIndex = [];
        foreach ($traceForPrompt as $idx => $entry) {
            $css   = $entry['selectors']['css'] ?? ($entry['target'] ?? '');
            $xpath = $entry['selectors']['xpath'] ?? '';
            $id    = $entry['selectors']['id'] ?? '';
            if ($css !== '' || $xpath !== '' || $id !== '') {
                $traceSelectorsIndex["step_{$idx}"] = [
                    'action' => $entry['action'], 'css' => $css, 'xpath' => $xpath, 'id' => $id,
                    'treeNodeRole' => $entry['treeNodeRole'] ?? null,
                    '_pyCode' => $entry['_pyCode'] ?? null,
                    'exactSelector' => $css,
                ];
            }
        }

        // ── 8. BUILD STEP CODEBOOK ─────────────────────────────────
        $stepCodebookLines = [];
        foreach ($traceForPrompt as $idx => $entry) {
            $action = $entry['action'] ?? '';
            if ($action === 'hover' && ($entry['_pyCode'] ?? null)) {
                $stepCodebookLines[] = "step_{$idx} [HOVER]:\n    elem = {$entry['_pyCode']}\n    # dispatch: if elem: ActionChains(driver).move_to_element(elem).perform()\n    # time.sleep(0.5)";
                continue;
            }
            if ($action === 'click') {
                $pyCode = $entry['_pyCode'] ?? null;
                $exact  = $entry['exactSelector'] ?? '';
                if (!$pyCode && !$exact) continue;
                $role = !empty($entry['treeNodeRole']) ? " [{$entry['treeNodeRole']}]" : '';
                $note = isset($entry['_note']) ? ' // ' . mb_substr($entry['_note'], 0, 80) : '';
                $code = $pyCode ? "elem = {$pyCode}" : "elem = driver.find_element(By.CSS_SELECTOR, \"{$exact}\")";
                $stepCodebookLines[] = "step_{$idx}{$role}:\n    {$code}\n    # dispatch: safe_click(driver, elem)  OR  ctx, h = click_and_wait_for_new_window(driver, elem){$note}";
            }
            if ($action === 'type' && ($entry['_pyCode'] ?? null)) {
                $val = json_encode($entry['value'] ?? ($entry['text'] ?? ''));
                $stepCodebookLines[] = "step_{$idx} [TYPE]:\n    elem = {$entry['_pyCode']}\n    # dispatch: elem.clear(); elem.send_keys({$val})";
            }
            if ($action === 'select_option' && ($entry['_pyCode'] ?? null)) {
                $opt = json_encode($entry['option'] ?? '');
                $stepCodebookLines[] = "step_{$idx} [SELECT]:\n    elem = {$entry['_pyCode']}\n    # dispatch: Select(elem).select_by_visible_text({$opt})";
            }
        }
        $stepCodebook = implode("\n\n", $stepCodebookLines);

        // ── 9. BUILD LOOP BODY SCAFFOLD ────────────────────────────
        $loopBodyLines = [];
        $selectorChecklist = [];
        $inLoopBody = false;
        $loopBodyStepNum = 0;

        foreach ($traceForPrompt as $idx => $entry) {
            $action = $entry['action'] ?? '';
            if (in_array($action, ['hover', 'navigate'], true)) {
                if (!$inLoopBody) {
                    $inLoopBody = true;
                    if ($action === 'hover') {
                        $hSel = $entry['selectors']['css'] ?? '';
                        if ($hSel) {
                            $loopBodyLines[] = '        # Loop iteration anchor: hover to reveal menu';
                            $loopBodyLines[] = '        hover_elem = find_one(driver, [(By.CSS_SELECTOR, ' . json_encode($hSel) . ')])';
                            $loopBodyLines[] = '        if hover_elem: ActionChains(driver).move_to_element(hover_elem).perform()';
                            $loopBodyLines[] = '        time.sleep(1)';
                        }
                    }
                    continue;
                } else { break; }
            }
            if (!$inLoopBody) continue;
            if ($action === 'hover') {
                $hSel = $entry['selectors']['css'] ?? '';
                if ($hSel) {
                    $loopBodyLines[] = '';
                    $loopBodyLines[] = '        # Hover to reveal submenu';
                    $loopBodyLines[] = '        hover_sub = find_one(driver, [(By.CSS_SELECTOR, ' . json_encode($hSel) . ')])';
                    $loopBodyLines[] = '        if hover_sub: ActionChains(driver).move_to_element(hover_sub).perform()';
                    $loopBodyLines[] = '        time.sleep(0.5)';
                }
                continue;
            }
            if ($action !== 'click') continue;

            $loopBodyStepNum++;
            $pyCode = $entry['_pyCode'] ?? null;
            $css = $entry['selectors']['css'] ?? ($entry['target'] ?? '');
            $popupOpened = $entry['popup_opened'] ?? false;
            $treeRole = $entry['treeNodeRole'] ?? null;
            if (!$pyCode && !$css) continue;
            if ($css) $selectorChecklist[] = $css;
            $findCall = $pyCode ?? 'find_one(driver, [(By.CSS_SELECTOR, ' . json_encode($css) . ')])';
            $label = "# Step {$loopBodyStepNum} (step_{$idx})";

            if ($treeRole === 'tree_parent_expand') {
                $loopBodyLines[] = '';
                $loopBodyLines[] = "        {$label} — EXPAND tree parent";
                $loopBodyLines[] = "        expand_elem = {$findCall}";
                $loopBodyLines[] = '        if not expand_elem:';
                $loopBodyLines[] = '            expand_elem = find_tree_folder_by_text(driver, TREE_SELECTOR, FOLDER_TEXT)';
                $loopBodyLines[] = '        safe_click(driver, expand_elem)';
                $loopBodyLines[] = '        time.sleep(3)';
            } elseif ($treeRole === 'tree_child_document') {
                $loopBodyLines[] = '';
                $loopBodyLines[] = "        {$label} — CLICK child document";
                $loopBodyLines[] = "        child_doc = {$findCall}";
                $loopBodyLines[] = '        if child_doc is None:';
                $loopBodyLines[] = '            child_doc = find_first_child_document(driver, TREE_SELECTOR, FOLDER_TEXT)';
                $loopBodyLines[] = '        if child_doc:';
                $loopBodyLines[] = '            safe_click(driver, child_doc)';
                $loopBodyLines[] = '            time.sleep(4)';
                $loopBodyLines[] = '        else:';
                $loopBodyLines[] = "            print(f'[!] No child document found')";
            } elseif ($popupOpened) {
                $wantsScraping = (bool) preg_match('/extract|scrape|information|excel|data/i', $goal);
                $wantsDownload = (bool) preg_match('/download\s*(pdf|via|file)|print\s*to\s*pdf|ctrl\s*\+?\s*p|save\s*as\s*pdf/i', $goal);
                $useScraping = $wantsScraping && !$wantsDownload;
                $loopBodyLines[] = '';
                $loopBodyLines[] = "        {$label} — CLICK (opens new tab/popup)";
                $loopBodyLines[] = "        popup_elem = {$findCall}";
                $loopBodyLines[] = '        if popup_elem:';
                $loopBodyLines[] = '            ctx, handle = click_and_wait_for_new_window(driver, popup_elem)';
                $loopBodyLines[] = '            if ctx:';
                $loopBodyLines[] = '                time.sleep(2)';
                if ($useScraping) {
                    $loopBodyLines[] = '                try:';
                    $loopBodyLines[] = "                    tables = driver.find_elements(By.TAG_NAME, 'table')";
                    $loopBodyLines[] = '                    if tables:';
                    $loopBodyLines[] = "                        html = tables[0].get_attribute('outerHTML')";
                    $loopBodyLines[] = '                        df = pd.read_html(StringIO(html))[0]';
                    $loopBodyLines[] = '                    else:';
                    $loopBodyLines[] = "                        body_text = driver.find_element(By.TAG_NAME, 'body').text";
                    $loopBodyLines[] = "                        lines = [l.strip() for l in body_text.split('\\n') if l.strip()]";
                    $loopBodyLines[] = "                        df = pd.DataFrame(lines, columns=['Information'])";
                    $loopBodyLines[] = '                    all_scraped_data.append(df)';
                    $loopBodyLines[] = '                except Exception as scrape_err:';
                    $loopBodyLines[] = "                    print(f'Scraping error: {scrape_err}')";
                } else {
                    $loopBodyLines[] = '                try:';
                    $loopBodyLines[] = "                    driver.find_element(By.TAG_NAME, 'body').send_keys(Keys.CONTROL, 'p')";
                    $loopBodyLines[] = '                except:';
                    $loopBodyLines[] = "                    try: driver.execute_script('window.print();')";
                    $loopBodyLines[] = '                    except: pass';
                    $loopBodyLines[] = '                time.sleep(2)';
                    $loopBodyLines[] = "                pdf_path = wait_and_rename_pdf(f'document_{count}')";
                    $loopBodyLines[] = "                if pdf_path: print(f'[+] Saved: {pdf_path}')";
                }
                $loopBodyLines[] = "                if ctx == 'new_window':";
                $loopBodyLines[] = '                    try: driver.close()';
                $loopBodyLines[] = '                    except: pass';
                $loopBodyLines[] = '                    main_window = recover_main_window(driver, main_window, TARGET_URL)';
                $loopBodyLines[] = '                else:';
                $loopBodyLines[] = '                    driver.back()';
                $loopBodyLines[] = '                    time.sleep(2)';
            } else {
                $loopBodyLines[] = '';
                $loopBodyLines[] = "        {$label} — CLICK (inline)";
                $loopBodyLines[] = "        elem_{$loopBodyStepNum} = {$findCall}";
                $loopBodyLines[] = "        safe_click(driver, elem_{$loopBodyStepNum})";
                $loopBodyLines[] = '        time.sleep(2)';
            }
        }
        $loopBodyScaffold = implode("\n", $loopBodyLines);

        // ── 10. FALLBACK FLAT-PATTERN SCAFFOLD ─────────────────────
        if (empty($loopBodyLines)) {
            $clickShapes = [];
            foreach ($traceForPrompt as $idx => $entry) {
                if (($entry['action'] ?? '') !== 'click') continue;
                $css = $entry['selectors']['css'] ?? ($entry['target'] ?? '');
                if (!$css) continue;
                $clickShapes[] = ['idx' => $idx, 'css' => $css, 'shape' => $shapeOf($css), 'pyCode' => $entry['_pyCode'] ?? null, 'popupOpened' => $entry['popup_opened'] ?? false];
            }
            $shapeCounts = [];
            foreach ($clickShapes as $cs) { $shapeCounts[$cs['shape']] = ($shapeCounts[$cs['shape']] ?? 0) + 1; }
            foreach ($deduplicatedShapes as $shape => $vals) { $shapeCounts[$shape] = ($shapeCounts[$shape] ?? 0) + count($vals); }

            $repeatingShape = null; $maxCount = 1;
            foreach ($shapeCounts as $s => $c) { if ($c > $maxCount) { $repeatingShape = $s; $maxCount = $c; } }

            if ($repeatingShape !== null && $maxCount >= 2) {
                $repCss = [];
                foreach ($clickShapes as $cs) { if ($cs['shape'] === $repeatingShape) $repCss[] = $cs['css']; }
                if (isset($deduplicatedShapes[$repeatingShape])) $repCss = array_merge($repCss, $deduplicatedShapes[$repeatingShape]);

                $cssWildcard = '';
                $firstCss = $repCss[0];
                if (preg_match_all('/_ctl\d{2,}_/', $firstCss, $am, PREG_OFFSET_CAPTURE)) {
                    $last = end($am[0]);
                    $after = substr($firstCss, $last[1] + strlen($last[0]));
                    if ($after) $cssWildcard = "[id*='" . $after . "']";
                }
                if (!$cssWildcard && preg_match('/([.#][a-zA-Z][\w-]+)$/', $firstCss, $m)) $cssWildcard = $m[1];
                if (!$cssWildcard && count($repCss) >= 2) {
                    $common = $this->longestCommonSubstring(ltrim($repCss[0], '#'), ltrim($repCss[1], '#'));
                    if (strlen($common) > 5) $cssWildcard = "[id*='" . $common . "']";
                }

                if ($cssWildcard) {
                    $firstRepIdx = null;
                    foreach ($clickShapes as $ci => $cs) { if ($cs['shape'] === $repeatingShape) { $firstRepIdx = $ci; break; } }
                    $setupLines = [];
                    for ($si = 0; $si < $firstRepIdx; $si++) {
                        $cs = $clickShapes[$si];
                        $fc = $cs['pyCode'] ?? 'find_one(driver, [(By.CSS_SELECTOR, ' . json_encode($cs['css']) . ')])';
                        $setupLines[] = "    setup_elem = {$fc}";
                        $setupLines[] = '    safe_click(driver, setup_elem)';
                        $setupLines[] = '    time.sleep(2)';
                        $setupLines[] = '';
                        $selectorChecklist[] = $cs['css'];
                    }
                    $wantsScraping = (bool) preg_match('/extract|scrape|information|excel|data/i', $goal);
                    $wantsDownload = (bool) preg_match('/download\s*(pdf|via|file)|print\s*to\s*pdf/i', $goal);
                    $useScraping = $wantsScraping && !$wantsDownload;

                    $loopBodyLines = ['    # ── SETUP STEPS ──'];
                    $loopBodyLines = array_merge($loopBodyLines, $setupLines);
                    $loopBodyLines[] = '    item_wildcard = ' . json_encode($cssWildcard);
                    $loopBodyLines[] = '    main_window = driver.current_window_handle';
                    if ($useScraping) $loopBodyLines[] = '    all_scraped_data = []';
                    $loopBodyLines[] = '';
                    $loopBodyLines[] = '    processed = 0';
                    $loopBodyLines[] = '    while processed < MAX_ITEMS_TO_PROCESS:';
                    $loopBodyLines[] = '        current_items = driver.find_elements(By.CSS_SELECTOR, item_wildcard)';
                    $loopBodyLines[] = '        if processed >= len(current_items): break';
                    $loopBodyLines[] = '        link_elem = current_items[processed]';
                    $loopBodyLines[] = '        safe_click(driver, link_elem)';
                    $loopBodyLines[] = '        time.sleep(2)';
                    $loopBodyLines[] = '        processed += 1';
                    $loopBodyLines[] = '        new_windows = [w for w in driver.window_handles if w != main_window]';
                    $loopBodyLines[] = '        if new_windows:';
                    $loopBodyLines[] = '            driver.switch_to.window(new_windows[0])';
                    $loopBodyLines[] = "            WebDriverWait(driver, 15).until(lambda d: d.execute_script('return document.readyState') == 'complete')";
                    if ($useScraping) {
                        $loopBodyLines[] = '            try:';
                        $loopBodyLines[] = "                tables = driver.find_elements(By.TAG_NAME, 'table')";
                        $loopBodyLines[] = '                if tables:';
                        $loopBodyLines[] = "                    html = tables[0].get_attribute('outerHTML')";
                        $loopBodyLines[] = '                    df = pd.read_html(StringIO(html))[0]';
                        $loopBodyLines[] = '                else:';
                        $loopBodyLines[] = "                    body_text = driver.find_element(By.TAG_NAME, 'body').text";
                        $loopBodyLines[] = "                    df = pd.DataFrame([l.strip() for l in body_text.split('\\n') if l.strip()], columns=['Information'])";
                        $loopBodyLines[] = '                all_scraped_data.append(df)';
                        $loopBodyLines[] = '            except Exception as e:';
                        $loopBodyLines[] = "                print(f'Scraping error: {e}')";
                    } else {
                        $loopBodyLines[] = '            try:';
                        $loopBodyLines[] = "                driver.find_element(By.TAG_NAME, 'body').send_keys(Keys.CONTROL, 'p')";
                        $loopBodyLines[] = '            except: pass';
                        $loopBodyLines[] = '            time.sleep(2)';
                    }
                    $loopBodyLines[] = '            driver.close()';
                    $loopBodyLines[] = '            driver.switch_to.window(main_window)';
                    if ($useScraping) {
                        $loopBodyLines[] = '';
                        $loopBodyLines[] = '    if all_scraped_data:';
                        $loopBodyLines[] = "        with pd.ExcelWriter(OUTPUT_EXCEL, engine='openpyxl') as writer:";
                        $loopBodyLines[] = '            for idx, df in enumerate(all_scraped_data):';
                        $loopBodyLines[] = "                df.to_excel(writer, sheet_name=f'Sheet_{idx+1}', index=False)";
                        $loopBodyLines[] = "        print(f'Saved to {OUTPUT_EXCEL}')";
                    }
                    $selectorChecklist[] = $cssWildcard;
                    $loopBodyScaffold = implode("\n", $loopBodyLines);
                }
            }
        }

        // Selector checklist
        $selectorChecklistStr = '';
        if (!empty($selectorChecklist)) {
            $selectorChecklistStr = implode("\n", array_map(fn ($s, $i) => '  ' . ($i + 1) . '. ' . json_encode($s), $selectorChecklist, array_keys($selectorChecklist)));
        }

        // ── 11. BUILD AUTOMATION SPEC ──────────────────────────────
        $automationSpec = [
            'preferences' => ['selectorSource' => 'trace-entries-only', 'output' => ['singlePythonFile' => true]],
            'sop' => ['raw' => $goal],
            'targetUrl' => $targetUrl,
            'traceSelectorsIndex' => $traceSelectorsIndex,
            'executionTrace' => $traceForPrompt,
        ];
        if ($wantsGDriveUpload) $automationSpec['preferences']['output']['googleDriveUpload'] = ['method' => 'service_account'];
        $specJson = json_encode($automationSpec, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        $escapedTargetUrl = addslashes($targetUrl);

        $gdriveSection = $wantsGDriveUpload
            ? "5) Google Drive: use google.oauth2.service_account + googleapiclient. Add supportsAllDrives=True. Read GDRIVE_UPLOAD_FOLDER_ID from env."
            : "5) Google Drive: NOT REQUESTED. Do NOT include any GDrive code.";

        // ── 12. BUILD FULL LLM PROMPT ──────────────────────────────
        $prompt = $this->buildFullPrompt(
            $stepCodebook, $loopBodyScaffold, $selectorChecklistStr,
            $escapedTargetUrl, $specJson, $gdriveSection
        );

        // ── 13. CALL AI ────────────────────────────────────────────
        Log::info('[SeleniumGen] Calling AI', ['traceSteps' => count($traceForPrompt), 'codebookSteps' => count($stepCodebookLines)]);
        $code = $this->ai->generate($prompt);
        if (!$code) {
            return ['success' => false, 'message' => 'AI code generation failed: ' . ($this->ai->getLastError() ?? 'null')];
        }

        // ── 14. VALIDATE + REPAIR ──────────────────────────────────
        $cleanedCode = trim(preg_replace('/```python|```/', '', $code));
        $issues = $this->validatePythonOutput($cleanedCode, $allowedSelectors, $wantsGDriveUpload, $targetUrl);
        if (!empty($issues)) {
            $issuesList = implode("\n", array_map(fn ($i) => "- {$i}", $issues));
            $repairPrompt = "{$prompt}\n\nVALIDATION_ERRORS:\n{$issuesList}\n\nREPAIR: Fix ALL errors. Output only Python.";
            $repaired = $this->ai->generate($repairPrompt);
            if ($repaired) $cleanedCode = trim(preg_replace('/```python|```/', '', $repaired));
        }

        // ── 15. NORMALIZE ──────────────────────────────────────────
        $finalCode = $this->normalizeOutput($cleanedCode, $targetUrl);

        return ['success' => true, 'code' => $finalCode, 'message' => 'Selenium script generated successfully.'];
    }

    // ═══════════════════════════════════════════════════════════════
    //  PRIVATE HELPERS
    // ═══════════════════════════════════════════════════════════════

    private function buildPyCandidates(string $css, string $xpath, string $id): ?string
    {
        $cands = [];
        if ($css !== '') $cands[] = '(By.CSS_SELECTOR, ' . json_encode($css) . ')';
        if ($id !== '')  $cands[] = '(By.ID, ' . json_encode($id) . ')';
        if ($xpath !== '') $cands[] = '(By.XPATH, ' . json_encode($xpath) . ')';
        if (empty($cands)) return null;
        $list = implode(",\n        ", $cands);
        return "find_one(driver, [\n        {$list}\n    ])";
    }

    private function buildFullPrompt(string $stepCodebook, string $loopBodyScaffold, string $selectorChecklistStr, string $escapedTargetUrl, string $specJson, string $gdriveSection): string
    {
        return <<<PROMPT
ROLE: You are a Senior Python Automation Architect.

TASK:
Generate ONE single-file, production-ready Python Selenium script that follows the SOP exactly.
- Use ONLY the selectors from executionTrace entries (css/xpath/id) and traceSelectorsIndex.
- Detect repetition patterns and emit loops (do NOT duplicate blocks).
- Implement non-web steps only if explicitly required by the SOP.

# TRACE-FAITHFUL CODE GENERATION (ABSOLUTE REQUIREMENT)
The executionTrace is the SINGLE SOURCE OF TRUTH.

## STEP CODEBOOK — copy these find_one() calls VERBATIM ##
{$stepCodebook}
## END OF STEP CODEBOOK ##

## MANDATORY LOOP BODY SCAFFOLD — EMBED VERBATIM ##
"""  # ── BEGIN MANDATORY LOOP BODY ──
{$loopBodyScaffold}
"""  # ── END MANDATORY LOOP BODY ──

## REQUIRED IMPORTS ##
If the scaffold uses: StringIO → from io import StringIO; pandas → import pandas as pd
Define: OUTPUT_EXCEL = "output.xlsx"; MAX_ITEMS_TO_PROCESS = 100

## SELECTOR VALIDATION CHECKLIST ##
These CSS selectors MUST appear VERBATIM in your code:
{$selectorChecklistStr}

ABSOLUTE RULES:
- NEVER modify/substitute selectors from STEP CODEBOOK.
- NEVER replace CSS/ID with [value='...'] or By.LINK_TEXT.
- NEVER skip any step. Every step_N MUST appear in code.
- popup_opened == true → ctx, h = click_and_wait_for_new_window(driver, elem)
- popup_opened == false → safe_click(driver, elem)

# MANDATORY SELECTOR FIDELITY
For EVERY click entry with selectors.css or selectors.id non-empty:
  FIRST candidate in find_one() MUST be the EXACT recorded selector.
  By.LINK_TEXT and By.PARTIAL_LINK_TEXT are UNCONDITIONALLY FORBIDDEN when recorded selectors exist.

# TREE-NODE CLICK SEQUENCE RULE
When trace has tree_parent_expand followed by tree_child_document:
Include find_tree_folder_by_text() and find_first_child_document() helpers.
Emit BOTH expand + child click. Use time.sleep(3) between them.

# DYNAMIC ITERATION — USE CONFIGURABLE LIMITS
max_items_to_process = 3  # Change this to process more
Use find_elements() + while loop. NEVER hardcode range(N, M).

TARGET_URL = "{$escapedTargetUrl}"

INPUT_SPEC_JSON:
{$specJson}

REQUIREMENTS:
1) Use webdriver_manager, WebDriverWait, ActionChains, Select, Keys.
   options.add_argument("--kiosk-printing")

2) REQUIRED HELPERS: find_one(), safe_click(), click_and_wait_for_new_window(),
   recover_main_window(), wait_and_rename_pdf(), handle_menu_navigation(),
   handle_dropdown_submenu(), select_from_dropdown(), scrape_table_data()

3) CLICK DISPATCH:
   popup_opened==true → click_and_wait_for_new_window (returns ctx, handle)
     ctx=='new_window' → driver.close() + recover_main_window()
     ctx=='same_tab' → driver.back() (NEVER driver.close())
   popup_opened==false → safe_click() only

4) Start with: driver.get(TARGET_URL)

{$gdriveSection}

OUTPUT: Return ONLY valid Python code. No markdown.
PROMPT;
    }

    private function extractUrlFromPrompt(string $prompt): ?string
    {
        if (preg_match('#https?://\S+#', $prompt, $m)) {
            return rtrim(trim($m[0], '.,;'), "\"'\"\xe2\x80\x9d\xe2\x80\x9c");
        }
        if (preg_match('#\b(?:go to|navigate to|open)\s+([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})#i', $prompt, $m)) {
            return 'https://' . $m[1];
        }
        return null;
    }

    private function extractTargetCountFromGoal(string $goal): int
    {
        if (preg_match('/(?:upto|up to|process|for|each)\s*(\d+)\s*(?:patients?|items?|records?|hyperlinks?|elements?|iterations?)/i', $goal, $m)) return (int) $m[1];
        if (preg_match('/(\d+)\s*(?:patients?|items?|iterations?|hyperlinks?)/i', $goal, $m)) return (int) $m[1];
        return 0;
    }

    private function collectAllowedSelectors(array $history): array
    {
        $css = []; $xpath = []; $ids = [];
        foreach ($history as $cmd) {
            $sel = $cmd['selectors'] ?? [];
            if (!empty($sel['css']))   $css[]   = trim($sel['css']);
            if (!empty($sel['xpath'])) $xpath[] = trim($sel['xpath']);
            if (!empty($sel['id']))    $ids[]   = trim($sel['id']);
            $target = $cmd['target'] ?? ($cmd['selector'] ?? '');
            if ($target && preg_match('/^(#|\.|\\[|[a-zA-Z])/', trim($target))) $css[] = trim($target);
        }
        foreach ($css as $sel) {
            if (preg_match_all('/#([a-zA-Z0-9_-]+)/', $sel, $matches)) {
                foreach ($matches[1] as $id) $css[] = '#' . $id;
            }
        }
        return [
            'css'   => array_values(array_unique(array_slice($css, 0, 500))),
            'xpath' => array_values(array_unique(array_slice($xpath, 0, 150))),
            'id'    => array_values(array_unique(array_slice($ids, 0, 150))),
        ];
    }

    private function validatePythonOutput(string $python, array $allowed, bool $wantsGDrive, string $expectedUrl): array
    {
        $issues = [];
        if (!$wantsGDrive && preg_match('/googleapiclient|google\.oauth2|service_account\.credentials/i', $python)) {
            $issues[] = 'Google Drive code detected but SOP does not request upload.';
        }
        if ($expectedUrl) {
            if (!preg_match('/^\s*TARGET_URL\s*=\s*[\'"]([^\'"]+)[\'"]\s*$/m', $python, $um)) {
                $issues[] = 'Missing TARGET_URL assignment.';
            } elseif ($um[1] !== $expectedUrl) {
                $issues[] = "TARGET_URL mismatch: expected \"{$expectedUrl}\".";
            }
            if (!preg_match('/driver\.get\(\s*TARGET_URL\s*\)/', $python)) {
                $issues[] = 'Script does not use driver.get(TARGET_URL).';
            }
        }
        if (preg_match('/def\s+find_one\s*\(/', $python)) {
            if (str_contains($python, 'element_to_be_clickable') && !str_contains($python, 'presence_of_element_located')) {
                $issues[] = 'find_one() must fall back to presence_of_element_located.';
            }
        }
        if (preg_match('/for\s+i\s+in\s+range\s*\(\s*\d+\s*,.*\)/', $python)) {
            $issues[] = 'Found hardcoded range(N, M). Use configurable limit.';
        }
        return $issues;
    }

    private function normalizeOutput(string $code, string $targetUrl): string
    {
        $code = trim(preg_replace('/```python|```/', '', $code));
        if (!$targetUrl) return $code;

        if (preg_match('/^\s*TARGET_URL\s*=/m', $code)) {
            $code = preg_replace('/^\s*TARGET_URL\s*=\s*[\'"][^\'"]*[\'"]\s*$/m', 'TARGET_URL = "' . $targetUrl . '"', $code);
        } else {
            $lines = explode("\n", $code);
            $insertAt = 0;
            foreach ($lines as $i => $line) {
                if (preg_match('/^\s*(import|from)\s+/', $line)) { $insertAt = $i + 1; continue; }
                if ($insertAt > 0 && trim($line) !== '') break;
            }
            array_splice($lines, $insertAt, 0, ['', 'TARGET_URL = "' . $targetUrl . '"', '']);
            $code = implode("\n", $lines);
        }
        $esc = preg_quote($targetUrl, '/');
        $code = preg_replace('/driver\.get\(\s*[\'"]' . $esc . '[\'"]\s*\)/', 'driver.get(TARGET_URL)', $code);
        if ($targetUrl !== 'https://example.com') {
            $code = preg_replace('/driver\.get\(\s*[\'"]https:\/\/example\.com[\'"]\s*\)/', 'driver.get(TARGET_URL)', $code);
        }
        return $code;
    }

    private function longestCommonSubstring(string $a, string $b): string
    {
        $lenA = strlen($a); $lenB = strlen($b); $longest = '';
        for ($i = 0; $i < $lenA; $i++) {
            for ($j = 0; $j < $lenB; $j++) {
                $len = 0;
                while (($i + $len < $lenA) && ($j + $len < $lenB) && $a[$i + $len] === $b[$j + $len]) $len++;
                if ($len > strlen($longest)) $longest = substr($a, $i, $len);
            }
        }
        return $longest;
    }
}
