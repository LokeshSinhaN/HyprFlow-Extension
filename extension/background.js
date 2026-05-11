// Hyprflow Extension Background Worker — the "Brain Coordinator".
// Orchestrates the agent loop between the local browser and the cloud AI brain (PHP).
// Mirrors AutomationService.php intelligence: loop detection, rich history,
// tab auto-detection, post-popup directives, and stability waiting.

const API_URL = "http://127.0.0.1:8001/api/extension/loop";
const GENERATE_URL = "http://127.0.0.1:8001/api/extension/generate-selenium";

// Enable side panel on icon click
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// ─── STATE ─────────────────────────────────────────────────────
let isRunning = false;
let currentTabId = null;

// Persisted after each agent run so "Generate Code" can use them
let lastAgentHistory = [];
let lastAgentPrompt = '';
let lastAgentStartUrl = '';

// Load persisted state on startup (Manifest V3 service worker may have restarted)
chrome.storage.local.get(['lastAgentHistory', 'lastAgentPrompt', 'lastAgentStartUrl'], (result) => {
    if (result.lastAgentHistory) lastAgentHistory = result.lastAgentHistory;
    if (result.lastAgentPrompt) lastAgentPrompt = result.lastAgentPrompt;
    if (result.lastAgentStartUrl) lastAgentStartUrl = result.lastAgentStartUrl;
});

// Tab auto-detection: track newly created tabs so we can detect popups
let recentlyCreatedTabs = [];
const TAB_DETECTION_WINDOW_MS = 5000;

// ─── TAB AUTO-DETECTION LISTENERS ──────────────────────────────
// When a click triggers window.open or target="_blank", Chrome creates a new tab.
// We track these so the agent can detect and switch to them.
chrome.tabs.onCreated.addListener((tab) => {
    recentlyCreatedTabs.push({
        id: tab.id,
        windowId: tab.windowId,
        url: tab.pendingUrl || tab.url || '',
        timestamp: Date.now()
    });
    // Prune old entries
    recentlyCreatedTabs = recentlyCreatedTabs.filter(
        t => (Date.now() - t.timestamp) < TAB_DETECTION_WINDOW_MS
    );
});

// ─── MESSAGE HANDLER ───────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'START_AGENT') {
        if (isRunning) {
            sendResponse({ status: 'already_running' });
            return true;
        }
        isRunning = true;
        const prompt = message.payload.prompt;

        chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
            if (tabs.length === 0) return;
            currentTabId = tabs[0].id;
            await injectContentScript(currentTabId);
            sendResponse({ status: 'started' });
            agentLoop(prompt, currentTabId);
        });

        return true;
    }

    if (message.type === 'STOP_AGENT') {
        isRunning = false;
        sendResponse({ status: 'stopped' });
        return true;
    }

    // ─── GENERATE SELENIUM CODE ─────────────────────────────────
    if (message.type === 'GENERATE_SELENIUM') {
        // Try to recover from global or storage
        if (!lastAgentHistory.length) {
            chrome.storage.local.get(['lastAgentHistory', 'lastAgentPrompt', 'lastAgentStartUrl'], (result) => {
                if (result.lastAgentHistory && result.lastAgentHistory.length) {
                    lastAgentHistory = result.lastAgentHistory;
                    lastAgentPrompt = result.lastAgentPrompt || '';
                    lastAgentStartUrl = result.lastAgentStartUrl || '';
                    performGeneration(sendResponse);
                } else {
                    sendResponse({ success: false, message: 'No agent history. Run the agent first.' });
                }
            });
            return true;
        }

        performGeneration(sendResponse);
        return true; // keep message channel open for async
    }
});

/**
 * Actual generation logic pulled out to handle both sync and async storage recovery
 */
async function performGeneration(sendResponse) {
    sendLogToPanel('Generating Selenium code...', 'info');
    try {
        const res = await fetch(GENERATE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({
                history: lastAgentHistory,
                goal: lastAgentPrompt,
                startUrl: lastAgentStartUrl
            })
        });
        if (!res.ok) {
            const text = await res.text();
            sendResponse({ success: false, message: `Server error ${res.status}: ${text.slice(0, 300)}` });
            sendLogToPanel(`Code generation failed: ${res.status}`, 'error');
            return;
        }
        const result = await res.json();
        sendResponse(result);
        if (result.success) {
            sendLogToPanel('Selenium code generated successfully.', 'success');
        } else {
            sendLogToPanel(`Code generation failed: ${result.message || 'Unknown error'}`, 'error');
        }
    } catch (e) {
        sendResponse({ success: false, message: e.message });
        sendLogToPanel(`Code generation error: ${e.message}`, 'error');
    }
}

// ─── LOGGING ───────────────────────────────────────────────────
function sendLogToPanel(text, level = 'info') {
    chrome.runtime.sendMessage({ type: 'LOG', text, level }).catch(() => { });
    if (level === 'error') console.error(text);
    else console.log(text);
}

// ─── CONTENT SCRIPT INJECTION ──────────────────────────────────
async function injectContentScript(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content.js']
        });
    } catch (e) {
        console.log("Script inject skipped:", e.message);
    }
}

// ─── CONTENT SCRIPT COMMUNICATION WITH RETRIES ────────────────
async function executeContentScript(tabId, actionType, payload = null, retries = 5) {
    for (let i = 0; i < retries; i++) {
        const result = await new Promise((resolve) => {
            chrome.tabs.sendMessage(tabId, { type: actionType, payload }, (response) => {
                if (chrome.runtime.lastError) resolve(null);
                else resolve(response);
            });
        });
        if (result) return result;

        console.log(`Message failed, retrying (${i + 1}/${retries})...`);
        await sleep(1000);
        await injectContentScript(tabId);
    }
    return null;
}

// ─── STABILITY WAIT ────────────────────────────────────────────
// Instead of a flat 2s delay, ask the content script to watch for DOM stability.
// Falls back to a timed wait if the content script doesn't respond.
async function waitForStability(tabId, timeoutMs = 3000) {
    const result = await executeContentScript(tabId, 'WAIT_FOR_STABILITY', { timeout: timeoutMs }, 2);
    if (!result) {
        // Fallback: simple delay
        await sleep(2000);
    }
}

// ─── TAB MANAGEMENT ────────────────────────────────────────────
// Queries ALL windows (not just currentWindow) to find tabs in popup windows.
async function handleTabManagement(decision) {
    if (decision.action === 'list_tabs') {
        return new Promise((resolve) => {
            // Query ALL windows to catch popup windows
            chrome.tabs.query({}, (tabs) => {
                const tabsList = tabs.map(t => ({
                    index: t.index, id: t.id, windowId: t.windowId,
                    url: t.url, title: t.title
                }));
                resolve({ success: true, tabs: tabsList });
            });
        });
    }

    if (decision.action === 'switch_tab') {
        return new Promise((resolve) => {
            const targetIndex = parseInt(decision.index);
            // First try current window
            chrome.tabs.query({}, (allTabs) => {
                // Find by global index across all windows
                const target = allTabs.find((t, i) => i === targetIndex) ||
                    allTabs.find(t => t.index === targetIndex);
                if (target) {
                    currentTabId = target.id;
                    chrome.tabs.update(currentTabId, { active: true }, async () => {
                        // Focus the window too
                        chrome.windows.update(target.windowId, { focused: true });
                        await injectContentScript(currentTabId);
                        resolve({ success: true });
                    });
                } else {
                    resolve({ success: false, message: "Tab index not found" });
                }
            });
        });
    }

    if (decision.action === 'new_tab') {
        return new Promise((resolve) => {
            chrome.tabs.create({ url: decision.url || '' }, async (tab) => {
                currentTabId = tab.id;
                await sleep(1000);
                await injectContentScript(currentTabId);
                resolve({ success: true });
            });
        });
    }

    if (decision.action === 'close_tab') {
        return new Promise((resolve) => {
            const closingId = currentTabId;
            chrome.tabs.remove(closingId, () => {
                chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
                    if (tabs.length > 0) {
                        currentTabId = tabs[0].id;
                        await injectContentScript(currentTabId);
                    }
                    resolve({ success: true });
                });
            });
        });
    }

    return { success: false, message: "Unknown tab action" };
}

// ─── NEW TAB DETECTION (after a click) ─────────────────────────
// Like BrowserService::click() waitForPopup pattern — polls for new tabs
// that appeared across ANY window after a click action.
async function detectNewTabAfterClick(tabCountBefore) {
    // Wait a moment for browser to process the popup
    await sleep(1500);

    // Check if any new tabs were created during the click window
    const recentNew = recentlyCreatedTabs.filter(
        t => (Date.now() - t.timestamp) < TAB_DETECTION_WINDOW_MS
    );

    if (recentNew.length > 0) {
        const newest = recentNew[recentNew.length - 1];
        // Get current tab info
        return new Promise((resolve) => {
            chrome.tabs.get(newest.id, async (tab) => {
                if (chrome.runtime.lastError || !tab) {
                    resolve(null);
                    return;
                }
                const url = tab.url || tab.pendingUrl || '';
                const isNavigable = /^https?:\/\//i.test(url);

                resolve({
                    tabId: tab.id,
                    windowId: tab.windowId,
                    url,
                    title: tab.title || '',
                    isNavigable
                });
            });
        });
    }

    // Extended polling: wait up to 3 more seconds
    for (let poll = 0; poll < 6; poll++) {
        await sleep(500);
        const lateNew = recentlyCreatedTabs.filter(
            t => (Date.now() - t.timestamp) < TAB_DETECTION_WINDOW_MS
        );
        if (lateNew.length > 0) {
            const newest = lateNew[lateNew.length - 1];
            return new Promise((resolve) => {
                chrome.tabs.get(newest.id, (tab) => {
                    if (chrome.runtime.lastError || !tab) { resolve(null); return; }
                    resolve({
                        tabId: tab.id,
                        windowId: tab.windowId,
                        url: tab.url || tab.pendingUrl || '',
                        title: tab.title || '',
                        isNavigable: /^https?:\/\//i.test(tab.url || '')
                    });
                });
            });
        }
    }

    return null;
}

// ─── LOOP DETECTION (ported from AutomationService::checkForLoop) ──
function checkForLoop(decision, actionRetryCount, lastActionKey) {
    const actionType = decision.action || '';
    let actionId = '';

    if (['click', 'type', 'hover'].includes(actionType)) {
        actionId = decision.selector || '';
    } else if (actionType === 'select_option') {
        actionId = decision.option || '';
    } else if (actionType === 'navigate') {
        actionId = decision.url || '';
    }

    const actionKey = actionType + '_' + actionId;
    const MAX_RETRIES = 3;

    if (actionKey === lastActionKey) {
        const count = (actionRetryCount[actionKey] || 0) + 1;
        actionRetryCount[actionKey] = count;

        if (count >= MAX_RETRIES) {
            return {
                isLoop: true,
                message: `⚠️ LOOP DETECTED: "${actionType}" repeated ${count} times on same target. Breaking loop.`,
                actionKey
            };
        }
    } else {
        actionRetryCount[actionKey] = 1;
    }

    return { isLoop: false, message: '', actionKey };
}

// ─── RESOLVE ELEMENT FROM OBSERVE DATA ─────────────────────────
// Enriches history entries with xpath, id, text from the observation snapshot
function resolveElementInfo(selector, observedElements) {
    if (!observedElements || !selector) return { css: selector, xpath: '', id: '', text: '' };

    for (const el of observedElements) {
        if (el.selector === selector || (el.id && selector === '#' + el.id)) {
            return {
                css: el.selector || selector,
                xpath: el.xpath || '',
                id: el.id || '',
                text: el.text || ''
            };
        }
    }
    return { css: selector, xpath: '', id: '', text: '' };
}

// ─── MAIN AGENT LOOP ───────────────────────────────────────────
async function agentLoop(prompt, tabId) {
    const maxSteps = 50;
    let actionHistory = [];           // Full rich history for Selenium code gen

    // Capture the starting URL for Selenium TARGET_URL
    lastAgentPrompt = prompt;
    lastAgentHistory = [];
    lastAgentStartUrl = '';
    try {
        const tab = await new Promise(r => chrome.tabs.get(tabId, r));
        if (tab && tab.url) lastAgentStartUrl = tab.url;
    } catch (e) { }
    let clickedSelectors = [];        // Track clicked selectors to prevent re-clicks
    let toggledOptions = {};          // Track toggled dropdown options
    let postPopupDirective = '';      // Injected directive after non-navigable popups
    let consecutiveListTabsCount = 0; // Detect list_tabs loops
    let actionRetryCount = {};        // Loop detection counters
    let lastActionKey = '';           // Last action key for loop detection
    let failedActionCount = 0;       // Consecutive failures
    const maxFailedActions = 3;
    let lastObservedElements = [];    // Cache for element resolution
    let lastActionFailed = false;     // Did the previous action fail?
    let lastActionError = '';         // Error message from last failed action
    let recentFingerprints = [];      // Last 3 page fingerprints for stale detection
    let staleStateCount = 0;          // Consecutive steps with identical fingerprints

    for (let step = 0; step < maxSteps && isRunning; step++) {
        sendLogToPanel(`--- Step ${step + 1} ---`, 'step');

        // Check consecutive failure limit
        if (failedActionCount >= maxFailedActions) {
            sendLogToPanel(`🛑 Stopped: ${maxFailedActions} consecutive action failures.`, 'error');
            break;
        }

        // 1. Wait for page stability (DOM + network)
        await waitForStability(currentTabId, 2000);

        // 2. OBSERVE the page
        const observeResult = await executeContentScript(currentTabId, 'OBSERVE');
        if (!observeResult || !observeResult.elements) {
            sendLogToPanel("Failed to observe page. Retrying...", 'error');
            await sleep(2000);
            await injectContentScript(currentTabId);
            continue;
        }
        lastObservedElements = observeResult.elements;

        // Clear recently created tabs before the AI decision (so we can detect new ones after a click)
        recentlyCreatedTabs = [];

        // --- FINGERPRINT-BASED STALE-STATE DETECTION ---
        const fingerprint = await executeContentScript(currentTabId, 'GET_FINGERPRINT', null, 2);
        if (fingerprint && fingerprint.contentHash) {
            recentFingerprints.push(fingerprint.contentHash);
            if (recentFingerprints.length > 3) recentFingerprints.shift();

            // If last 3 fingerprints are identical, the page hasn't changed
            if (recentFingerprints.length === 3 &&
                recentFingerprints[0] === recentFingerprints[1] &&
                recentFingerprints[1] === recentFingerprints[2]) {
                staleStateCount++;
                if (staleStateCount >= 2 && !postPopupDirective) {
                    postPopupDirective = 'STALE STATE: The page has NOT changed for the last 3+ steps. '
                        + 'Your previous actions had NO visible effect. '
                        + 'You MUST try a completely different approach: different selector, different action type, or skip this step.';
                    sendLogToPanel('⚠️ Stale state detected — page unchanged for 3+ steps', 'error');
                }
            } else {
                staleStateCount = 0;
            }
        }

        // --- INJECT FAILURE DIRECTIVE ---
        // If the previous action failed, tell the AI about it so it retries
        if (lastActionFailed && !postPopupDirective) {
            postPopupDirective = `ACTION FAILED: The last action returned success=false` +
                (lastActionError ? ` (error: ${lastActionError})` : '') +
                `. You MUST retry this step with a DIFFERENT selector or approach. ` +
                `Do NOT skip to the next SOP step. Do NOT call finish.`;
        }

        // 3. Build state payload for backend brain
        const sliceCount = Math.min(Math.max(observeResult.elements.length, 60), observeResult.elements.length);
        const statePayload = {
            prompt,
            url: observeResult.url,
            elements: observeResult.elements.slice(0, sliceCount),
            elementCount: observeResult.elements.length,
            history: actionHistory,
            // Extension-specific state for smarter AI decisions
            clickedSelectors,
            toggledOptions,
            postPopupDirective,
            consecutiveListTabsCount,
            lastActionFailed,
            lastActionError
        };

        // 4. Ask the backend brain (AI) for the next action
        let aiDecision;
        try {
            const response = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify(statePayload)
            });

            if (!response.ok) {
                const text = await response.text();
                sendLogToPanel(`Brain API error ${response.status}: ${text.slice(0, 200)}`, 'error');
                failedActionCount++;
                continue;
            }

            aiDecision = await response.json();
        } catch (error) {
            sendLogToPanel(`Error connecting to brain API: ${error.message}`, 'error');
            break;
        }

        // Consume post-popup directive (one-shot)
        postPopupDirective = '';

        sendLogToPanel(`AI thought: ${aiDecision.thought}`, 'info');
        sendLogToPanel(`AI decided: ${aiDecision.action} on ${aiDecision.selector || ''}`, 'decision');

        // 5. Build rich history entry
        const selectors = resolveElementInfo(aiDecision.selector, lastObservedElements);
        let historyEntry = {
            step: step + 1,
            thought: aiDecision.thought,
            action: aiDecision.action,
            selector: aiDecision.selector || null,
            selectors: selectors,
            url: observeResult.url
        };
        if (aiDecision.option) historyEntry.option = aiDecision.option;
        if (aiDecision.text) historyEntry.text = aiDecision.text;
        if (aiDecision.url) historyEntry.url = aiDecision.url;
        if (aiDecision.index !== undefined) historyEntry.index = aiDecision.index;
        if (aiDecision.unselect) historyEntry.unselect = true;

        // 6. Loop detection
        const loopResult = checkForLoop(aiDecision, actionRetryCount, lastActionKey);
        lastActionKey = loopResult.actionKey;
        if (loopResult.isLoop) {
            sendLogToPanel(loopResult.message, 'error');
            historyEntry.loopDetected = true;
            actionHistory.push(historyEntry);
            // Force the AI to try something different next iteration
            postPopupDirective = 'LOOP DETECTED. Your last action was repeated too many times without progress. '
                + 'You MUST choose a completely DIFFERENT action or selector. Do NOT repeat the same action.';
            continue;
        }

        // 7. Handle FINISH
        if (aiDecision.action === 'finish') {
            sendLogToPanel(`Agent finished: ${aiDecision.summary}`, 'decision');
            actionHistory.push(historyEntry);
            break;
        }

        // 8. Execute the action
        let actionResult = null;
        let actionSuccess = false;

        // ── Tab management actions ──
        if (['switch_tab', 'new_tab', 'list_tabs', 'close_tab'].includes(aiDecision.action)) {
            // Track consecutive list_tabs calls
            if (aiDecision.action === 'list_tabs') {
                consecutiveListTabsCount++;
                if (consecutiveListTabsCount >= 3) {
                    sendLogToPanel('⚠️ list_tabs called 3+ times. Forcing agent to proceed.', 'error');
                    postPopupDirective = 'STOP calling list_tabs. There is NO hidden tab. '
                        + 'You are on the main page. IMMEDIATELY proceed to the next SOP step.';
                    actionHistory.push(historyEntry);
                    continue;
                }
            } else {
                consecutiveListTabsCount = 0;
            }

            actionResult = await handleTabManagement(aiDecision);
            sendLogToPanel(`Tab Action result: ${JSON.stringify(actionResult)}`, 'info');

            if (aiDecision.action === 'switch_tab' && actionResult.success) {
                // Re-inject content script into the new tab
                await injectContentScript(currentTabId);
            }

            historyEntry.tabResult = actionResult;
            actionSuccess = actionResult.success;
        }
        // ── Regular DOM actions ──
        else {
            consecutiveListTabsCount = 0;

            actionResult = await executeContentScript(currentTabId, 'EXECUTE_ACTION', aiDecision);
            sendLogToPanel(`Action result: ${JSON.stringify(actionResult)}`, 'info');

            if (actionResult) {
                actionSuccess = actionResult.success;

                // Handle extracted text
                if (actionResult.extractedText) {
                    historyEntry.extractedText = actionResult.extractedText;
                    sendLogToPanel(`Extracted ${actionResult.extractedText.length} characters.`, 'info');
                }

                // Handle auto-hover detection
                if (actionResult.autoHoverSelector) {
                    historyEntry.hoverTarget = actionResult.autoHoverSelector;
                }

                // Track clicked selectors
                if (aiDecision.action === 'click' && aiDecision.selector) {
                    clickedSelectors.push(aiDecision.selector);
                }

                // Track toggled options
                if (actionResult.toggleAction && actionResult.optionText) {
                    const key = (aiDecision.selector || '') + '::' + actionResult.optionText;
                    toggledOptions[key] = actionResult.toggleAction;
                }

                // ── NEW TAB DETECTION AFTER CLICK ──
                // Like BrowserService waitForPopup — detect if the click opened a new tab
                if (aiDecision.action === 'click') {
                    const windowOpenDetected = actionResult.windowOpenDetected || false;

                    // Also check Chrome API for new tabs
                    const newTabInfo = await detectNewTabAfterClick();

                    if (newTabInfo || windowOpenDetected) {
                        historyEntry.popup_opened = true;

                        if (newTabInfo && newTabInfo.isNavigable) {
                            // Switch to the new tab
                            currentTabId = newTabInfo.tabId;
                            chrome.windows.update(newTabInfo.windowId, { focused: true });
                            chrome.tabs.update(currentTabId, { active: true });
                            await injectContentScript(currentTabId);
                            await waitForStability(currentTabId, 3000);

                            historyEntry.popup_url = newTabInfo.url;
                            historyEntry.popup_title = newTabInfo.title;
                            historyEntry.auto_switched = true;

                            sendLogToPanel(`New tab detected and switched: ${newTabInfo.title} (${newTabInfo.url})`, 'success');
                        } else if (newTabInfo && !newTabInfo.isNavigable) {
                            // Non-navigable popup (PDF, document stream) — close it and stay
                            try {
                                chrome.tabs.remove(newTabInfo.tabId);
                            } catch (e) { }
                            historyEntry.popup_navigable = false;
                            postPopupDirective = 'The last click opened a non-navigable document/PDF tab. '
                                + 'The system auto-closed it. You are on the MAIN page. '
                                + 'Do NOT call list_tabs or re-click the same button. '
                                + 'IMMEDIATELY proceed to the next SOP step.';

                            sendLogToPanel('📄 Non-navigable popup detected and closed. Continuing on main page.', 'info');
                        } else if (windowOpenDetected) {
                            // window.open was called but we couldn't find the tab via Chrome API
                            // The tab might be in a different window — try to find it
                            sendLogToPanel('🔍 window.open detected, scanning for new tab...', 'info');
                            await sleep(2000);
                            const lateDetect = await detectNewTabAfterClick();
                            if (lateDetect && lateDetect.isNavigable) {
                                currentTabId = lateDetect.tabId;
                                chrome.windows.update(lateDetect.windowId, { focused: true });
                                chrome.tabs.update(currentTabId, { active: true });
                                await injectContentScript(currentTabId);
                                await waitForStability(currentTabId, 3000);
                                historyEntry.popup_url = lateDetect.url;
                                historyEntry.auto_switched = true;
                                sendLogToPanel(`🆕 Late tab detection: ${lateDetect.url}`, 'success');
                            }
                        }
                    }
                }
            } else {
                actionSuccess = false;
            }
        }

        // 9. Update failure counter and record success/failure in history
        historyEntry.actionSuccess = actionSuccess;
        if (actionSuccess) {
            failedActionCount = 0;
            lastActionFailed = false;
            lastActionError = '';
        } else {
            failedActionCount++;
            lastActionFailed = true;
            lastActionError = (actionResult && actionResult.error) || '';
            if (failedActionCount > 0 && failedActionCount < maxFailedActions) {
                sendLogToPanel(`⚠️ Action failed (${failedActionCount}/${maxFailedActions} before stop)`, 'error');
            }
        }

        actionHistory.push(historyEntry);

        // 10. Wait for UI to settle before next iteration
        await waitForStability(currentTabId, 1500);
    }

    isRunning = false;
    // Persist history for "Generate Code" button
    lastAgentHistory = actionHistory;
    
    // Save to storage for Manifest V3 persistence
    chrome.storage.local.set({ 
        lastAgentHistory: actionHistory,
        lastAgentPrompt: lastAgentPrompt,
        lastAgentStartUrl: lastAgentStartUrl
    });

    sendLogToPanel("Loop ended.", 'info');
    // Re-enable buttons in the panel — include hasHistory so panel knows code gen is available
    chrome.runtime.sendMessage({ type: 'AGENT_DONE', hasHistory: actionHistory.length > 0 }).catch(() => { });
}

// ─── UTILITY ───────────────────────────────────────────────────
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
