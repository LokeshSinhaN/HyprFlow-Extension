// Hyprflow Extension Background Worker — the "Brain Coordinator".
// ENHANCED: CDP Hardware Clicks, Network Listening, Plan-Aware Execution,
// Post-Action Verification, Multi-Action Chaining, Scroll Verification,
// Site Knowledge Learning, Coordinate Click support.

const API_URL = "http://127.0.0.1:8001/api/extension/loop";
const GENERATE_URL = "http://127.0.0.1:8001/api/extension/generate-selenium";
const PLAN_URL = "http://127.0.0.1:8001/api/extension/plan";
const LEARN_URL = "http://127.0.0.1:8001/api/extension/learn";

// ─── CDP HARDWARE CLICK IMPLEMENTATION ─────────────────────────────
// Uses Chrome DevTools Protocol to simulate real hardware mouse events.
// This bypasses all JavaScript event listeners and synthetic event blockers
// (Radix UI, HeadlessUI, etc.) by dispatching at the browser compositor level.

/** @type {Set<number>} Tabs currently attached to debugger */
const _debuggerAttachedTabs = new Set();

/**
 * Attaches chrome.debugger to a tab if not already attached.
 * Handles the case where the debugger is already attached by another extension.
 * @param {number} tabId
 * @returns {Promise<boolean>} true if attached successfully
 */
async function attachDebugger(tabId) {
    if (_debuggerAttachedTabs.has(tabId)) return true;

    return new Promise((resolve) => {
        chrome.debugger.attach({ tabId }, '1.3', () => {
            if (chrome.runtime.lastError) {
                const errMsg = chrome.runtime.lastError.message || '';
                // Already attached is OK
                if (errMsg.includes('Already attached')) {
                    _debuggerAttachedTabs.add(tabId);
                    resolve(true);
                } else {
                    console.error(`[CDP] Failed to attach debugger to tab ${tabId}: ${errMsg}`);
                    resolve(false);
                }
            } else {
                _debuggerAttachedTabs.add(tabId);
                resolve(true);
            }
        });
    });
}

/**
 * Detaches chrome.debugger from a tab safely.
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function detachDebugger(tabId) {
    if (!_debuggerAttachedTabs.has(tabId)) return;

    return new Promise((resolve) => {
        chrome.debugger.detach({ tabId }, () => {
            _debuggerAttachedTabs.delete(tabId);
            if (chrome.runtime.lastError) {
                // Tab may have been closed — ignore
                console.log(`[CDP] Detach warning for tab ${tabId}: ${chrome.runtime.lastError.message}`);
            }
            resolve();
        });
    });
}

/**
 * Sends a CDP command to a tab via chrome.debugger.
 * @param {number} tabId
 * @param {string} method - CDP method (e.g., 'Input.dispatchMouseEvent')
 * @param {object} params - CDP method parameters
 * @returns {Promise<object|null>}
 */
async function sendCDPCommand(tabId, method, params = {}) {
    return new Promise((resolve) => {
        chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
            if (chrome.runtime.lastError) {
                console.error(`[CDP] Command ${method} failed: ${chrome.runtime.lastError.message}`);
                resolve(null);
            } else {
                resolve(result || {});
            }
        });
    });
}

/**
 * Executes a full hardware click lifecycle at the given X/Y viewport coordinates.
 * Simulates: mouseMoved → mousePressed → mouseReleased
 * This is the same event sequence a real user generates with a physical mouse.
 *
 * @param {number} tabId - Target tab ID
 * @param {number} x - X coordinate (viewport-relative)
 * @param {number} y - Y coordinate (viewport-relative)
 * @param {object} [options] - Optional click configuration
 * @param {number} [options.clickCount=1] - Number of clicks (2 for double-click)
 * @param {string} [options.button='left'] - Mouse button ('left', 'right', 'middle')
 * @param {number} [options.delay=50] - Delay between press and release in ms
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function executeHardwareClick(tabId, x, y, options = {}) {
    const { clickCount = 1, button = 'left', delay = 50 } = options;

    try {
        // 1. Attach debugger
        const attached = await attachDebugger(tabId);
        if (!attached) {
            return { success: false, error: 'Failed to attach debugger to tab' };
        }

        // 2. Move mouse to target position (generates mouseover/mouseenter events)
        const moveResult = await sendCDPCommand(tabId, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: Math.round(x),
            y: Math.round(y),
            button: 'none',
            clickCount: 0
        });
        if (moveResult === null) {
            return { success: false, error: 'CDP mouseMoved failed' };
        }

        // Small delay to let hover effects register
        await sleep(20);

        // 3. Press mouse button
        const pressResult = await sendCDPCommand(tabId, 'Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: Math.round(x),
            y: Math.round(y),
            button: button,
            clickCount: clickCount,
            buttons: 1 // Left button bitmask
        });
        if (pressResult === null) {
            return { success: false, error: 'CDP mousePressed failed' };
        }

        // Delay between press and release (simulates human finger speed)
        await sleep(delay);

        // 4. Release mouse button
        const releaseResult = await sendCDPCommand(tabId, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: Math.round(x),
            y: Math.round(y),
            button: button,
            clickCount: clickCount,
            buttons: 0
        });
        if (releaseResult === null) {
            return { success: false, error: 'CDP mouseReleased failed' };
        }

        return { success: true };
    } catch (e) {
        console.error(`[CDP] Hardware click error:`, e);
        return { success: false, error: e.message };
    }
}

/**
 * Executes a CDP hardware click on an element identified by ref_id.
 * Resolves the ref_id to viewport coordinates via the content script,
 * then dispatches CDP mouse events at those coordinates.
 *
 * @param {number} tabId - Target tab ID
 * @param {string} refId - Element reference ID from the accessibility tree
 * @returns {Promise<{success: boolean, x?: number, y?: number, error?: string}>}
 */
async function executeRefClick(tabId, refId) {
    // 1. Get coordinates from content script
    const coordResult = await executeContentScript(tabId, 'GET_REF_COORDINATES', { ref_id: refId }, 3);

    if (!coordResult || !coordResult.success) {
        return {
            success: false,
            error: coordResult?.error || `Could not resolve coordinates for ${refId}`
        };
    }

    const { x, y } = coordResult;

    // 2. Execute CDP hardware click at those coordinates
    const clickResult = await executeHardwareClick(tabId, x, y);

    return {
        ...clickResult,
        x,
        y,
        ref_id: refId
    };
}

// Clean up debugger on tab close/navigation
chrome.tabs.onRemoved.addListener((tabId) => {
    _debuggerAttachedTabs.delete(tabId);
});

// Handle debugger detach events (user closed DevTools, etc.)
chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId) {
        _debuggerAttachedTabs.delete(source.tabId);
        console.log(`[CDP] Debugger detached from tab ${source.tabId}: ${reason}`);
    }
});


// ─── NETWORK LISTENING (HTTP Error Capture) ────────────────────────
// Monitors medoraos.com/api requests for HTTP errors (status >= 400).
// Stores the latest error so the AI can query it via read_network_status tool.

/** @type {{ url: string, statusCode: number, method: string, timestamp: number, statusLine: string, type: string } | null} */
let _latestNetworkError = null;

/** @type {Array<{ url: string, statusCode: number, method: string, timestamp: number, statusLine: string }>} */
let _networkErrorLog = [];
const MAX_NETWORK_ERROR_LOG = 20;

// Listen for completed requests with error status codes on medoraos.com API
chrome.webRequest.onCompleted.addListener(
    (details) => {
        if (details.statusCode >= 400) {
            const errorEntry = {
                url: details.url,
                statusCode: details.statusCode,
                method: details.method,
                timestamp: Date.now(),
                statusLine: details.statusLine || `HTTP ${details.statusCode}`,
                type: details.type || 'unknown',
                tabId: details.tabId
            };

            _latestNetworkError = errorEntry;
            _networkErrorLog.push(errorEntry);

            // Keep log bounded
            if (_networkErrorLog.length > MAX_NETWORK_ERROR_LOG) {
                _networkErrorLog = _networkErrorLog.slice(-MAX_NETWORK_ERROR_LOG);
            }

            console.warn(`[Network] HTTP ${details.statusCode} on ${details.method} ${details.url}`);
            sendLogToPanel(
                `Network Error: ${details.method} ${details.url.split('?')[0]} → ${details.statusCode}`,
                'warn'
            );
        }
    },
    { urls: ['*://*.medoraos.com/api/*', '*://*.medoraos.com/api*'] },
    []
);

// Also listen for request errors (network failures, DNS errors, etc.)
chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
        const errorEntry = {
            url: details.url,
            statusCode: 0,
            method: details.method,
            timestamp: Date.now(),
            statusLine: details.error || 'Network Error',
            type: details.type || 'unknown',
            tabId: details.tabId,
            networkError: true
        };

        _latestNetworkError = errorEntry;
        _networkErrorLog.push(errorEntry);

        if (_networkErrorLog.length > MAX_NETWORK_ERROR_LOG) {
            _networkErrorLog = _networkErrorLog.slice(-MAX_NETWORK_ERROR_LOG);
        }

        console.warn(`[Network] Request failed: ${details.method} ${details.url} — ${details.error}`);
        sendLogToPanel(
            `Network Failure: ${details.method} ${details.url.split('?')[0]} — ${details.error}`,
            'error'
        );
    },
    { urls: ['*://*.medoraos.com/api/*', '*://*.medoraos.com/api*'] },
    []
);

/**
 * Returns the current network error status for the AI's read_network_status tool.
 * @returns {{ hasError: boolean, latestError: object|null, recentErrors: Array, errorCount: number }}
 */
function getNetworkStatus() {
    return {
        hasError: _latestNetworkError !== null,
        latestError: _latestNetworkError,
        recentErrors: _networkErrorLog.slice(-5),
        errorCount: _networkErrorLog.length
    };
}

/**
 * Clears the network error state (called after AI acknowledges the error).
 */
function clearNetworkErrors() {
    _latestNetworkError = null;
    _networkErrorLog = [];
}


// Enable side panel on icon click
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// ─── STATE ─────────────────────────────────────────────────────
let isRunning = false;
let currentTabId = null;

// Persisted after each agent run so "Generate Code" can use them
let lastAgentHistory = [];
let lastAgentPrompt = '';
let lastAgentStartUrl = '';
let currentPlanSteps = []; // Enhancement 1: Plan steps for tracking

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

            await generatePlan(prompt, false);
            // Wait for APPROVE_PLAN message from panel before starting loop
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

    if (message.type === 'APPROVE_PLAN') {
        const prompt = message.payload.prompt;
        const plan = message.payload.plan || currentPlanSteps;
        agentLoop(prompt, currentTabId, plan);
        return true;
    }

    if (message.type === 'REJECT_PLAN') {
        const prompt = message.payload.prompt;
        generatePlan(prompt, true);
        return true;
    }

    // ─── CDP HARDWARE CLICK (via ref_id from accessibility tree) ──
    if (message.type === 'CDP_CLICK') {
        const { ref_id, x, y, tabId: targetTabId } = message.payload || {};
        const clickTabId = targetTabId || currentTabId;

        (async () => {
            try {
                let result;
                if (ref_id) {
                    // Click by ref_id — resolve coordinates from content script
                    result = await executeRefClick(clickTabId, ref_id);
                } else if (x !== undefined && y !== undefined) {
                    // Direct coordinate click via CDP
                    result = await executeHardwareClick(clickTabId, x, y);
                } else {
                    result = { success: false, error: 'CDP_CLICK requires ref_id or x/y coordinates' };
                }
                sendResponse(result);
            } catch (e) {
                sendResponse({ success: false, error: e.message });
            }
        })();
        return true;
    }

    // ─── CDP DETACH (cleanup debugger from tab) ──────────────────
    if (message.type === 'CDP_DETACH') {
        const targetTabId = message.payload?.tabId || currentTabId;
        (async () => {
            await detachDebugger(targetTabId);
            sendResponse({ success: true });
        })();
        return true;
    }

    // ─── READ NETWORK STATUS (AI tool: read_network_status) ──────
    if (message.type === 'READ_NETWORK_STATUS') {
        const status = getNetworkStatus();
        sendResponse(status);
        return true;
    }

    // ─── CLEAR NETWORK ERRORS ────────────────────────────────────
    if (message.type === 'CLEAR_NETWORK_ERRORS') {
        clearNetworkErrors();
        sendResponse({ success: true });
        return true;
    }

    // ─── BUILD ACCESSIBILITY TREE (proxy to content script) ──────
    if (message.type === 'GET_A11Y_TREE') {
        const targetTabId = message.payload?.tabId || currentTabId;
        (async () => {
            try {
                await injectContentScript(targetTabId);
                const result = await executeContentScript(targetTabId, 'BUILD_A11Y_TREE', null, 3);
                sendResponse(result || { success: false, error: 'No response from content script' });
            } catch (e) {
                sendResponse({ success: false, error: e.message });
            }
        })();
        return true;
    }
});

async function generatePlan(prompt, rejected = false) {
    sendLogToPanel(rejected ? 'Drafting Alternative Workflow Plan...' : 'Drafting Workflow Plan...', 'info');
    try {
        const res = await fetch(PLAN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ prompt, rejected })
        });
        if (!res.ok) {
            sendLogToPanel(`Plan generation failed: ${res.status}`, 'warn');
            return;
        }
        const result = await res.json();
        if (result.plan && Array.isArray(result.plan)) {
            currentPlanSteps = result.plan; // Enhancement 1: Store for plan-aware execution
            sendLogToPanel('Plan of Action:', 'info');
            result.plan.forEach(step => sendLogToPanel(step, 'step'));
            chrome.runtime.sendMessage({ type: 'PLAN_GENERATED', payload: { plan: result.plan } }).catch(() => { });
        }
    } catch (e) {
        sendLogToPanel(`Plan generation error: ${e.message}`, 'warn');
    }
}

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

// ─── CONTENT SCRIPT COMMUNICATION WITH RETRIES + TIMEOUT ────────
async function executeContentScript(tabId, actionType, payload = null, retries = 5) {
    for (let i = 0; i < retries; i++) {
        const result = await Promise.race([
            new Promise((resolve) => {
                chrome.tabs.sendMessage(tabId, { type: actionType, payload }, (response) => {
                    if (chrome.runtime.lastError) resolve(null);
                    else resolve(response);
                });
            }),
            // Timeout: prevent infinite hang if content script never responds
            new Promise((resolve) => setTimeout(() => resolve(null), 15000))
        ]);
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
// ENHANCED: Scroll actions now include their selector in the key so different
// scroll targets are tracked independently. Scroll also gets a higher retry
// threshold since scrolling multiple times in long forms is normal.
function checkForLoop(decision, actionRetryCount, lastActionKey) {
    const actionType = decision.action || '';
    let actionId = '';

    if (['click', 'type', 'hover'].includes(actionType)) {
        actionId = decision.selector || '';
    } else if (actionType === 'select_option') {
        actionId = decision.option || '';
    } else if (actionType === 'navigate') {
        actionId = decision.url || '';
    } else if (actionType === 'scroll_down' || actionType === 'scroll_up') {
        // FIXED: Include selector so different scroll targets are tracked separately
        // scroll_down on form ≠ scroll_down on body ≠ scroll_down on modal
        actionId = decision.selector || 'default';
    }

    const actionKey = actionType + '_' + actionId;

    // Dynamic retry threshold: scroll actions get more retries since
    // long forms/modals legitimately need multiple scrolls to reach the bottom
    const MAX_RETRIES = (actionType === 'scroll_down' || actionType === 'scroll_up') ? 5 : 3;

    if (actionKey === lastActionKey) {
        const count = (actionRetryCount[actionKey] || 0) + 1;
        actionRetryCount[actionKey] = count;

        if (count >= MAX_RETRIES) {
            return {
                isLoop: true,
                message: `LOOP DETECTED: "${actionType}" repeated ${count} times on same target. Breaking loop.`,
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

// ─── VISION: Capture SoM Screenshot ───────────────────────────
async function captureSoMScreenshot(tabId) {
    const visionConfig = {
        enabled: true,
        maxWidth: 1024,
        quality: 60, // Must be integer (0-100), not float
        maxElements: 60,
        somEnabled: true
    };

    try {
        // First get element positions and SoM mapping from content script
        const result = await executeContentScript(tabId, 'CAPTURE_SOM', visionConfig, 3);

        if (!result || !result.success) {
            sendLogToPanel(`SoM preparation failed: ${result?.error || 'Unknown error'}`, 'warn');
            return null;
        }

        // Get the tab's windowId FIRST (must be done outside the Promise constructor)
        let windowId = null;
        try {
            const tabInfo = await new Promise((resolve) => {
                chrome.tabs.get(tabId, (tab) => {
                    if (chrome.runtime.lastError) {
                        resolve(null);
                    } else {
                        resolve(tab);
                    }
                });
            });
            windowId = tabInfo ? tabInfo.windowId : null;
        } catch (e) {
            sendLogToPanel(`Failed to get tab info: ${e.message}`, 'warn');
        }

        if (!windowId) {
            sendLogToPanel('Could not determine windowId for screenshot, using text-only mode', 'warn');
            return {
                success: true,
                image: null,
                somMap: result.somMap,
                elements: result.elements,
                elementCount: result.elementCount,
                pageUrl: result.pageUrl,
                pageTitle: result.pageTitle
            };
        }

        // Ensure the tab is active/focused before capturing
        try {
            await new Promise((resolve) => {
                chrome.tabs.update(tabId, { active: true }, () => {
                    if (chrome.runtime.lastError) resolve(null);
                    else resolve(true);
                });
            });
            await new Promise((resolve) => {
                chrome.windows.update(windowId, { focused: true }, () => {
                    if (chrome.runtime.lastError) resolve(null);
                    else resolve(true);
                });
            });
            // Small delay to let the tab become visible
            await sleep(150);
        } catch (e) {
            // Non-critical, continue with capture attempt
        }

        // Capture the actual screenshot from the tab using the correct windowId
        // Note: quality must be an integer (0-100), not a decimal
        const screenshot = await new Promise((resolve) => {
            chrome.tabs.captureVisibleTab(windowId, {
                format: 'jpeg',
                quality: 60 // Integer between 0 and 100
            }, (dataUrl) => {
                if (chrome.runtime.lastError) {
                    sendLogToPanel(`Screenshot capture error: ${chrome.runtime.lastError.message}`, 'warn');
                    resolve(null);
                } else {
                    resolve(dataUrl);
                }
            });
        });

        // If first attempt failed, retry once after a short delay
        let finalScreenshot = screenshot;
        if (!finalScreenshot) {
            await sleep(500);
            finalScreenshot = await new Promise((resolve) => {
                chrome.tabs.captureVisibleTab(windowId, {
                    format: 'jpeg',
                    quality: 60
                }, (dataUrl) => {
                    if (chrome.runtime.lastError) {
                        sendLogToPanel(`Screenshot retry failed: ${chrome.runtime.lastError.message}`, 'warn');
                        resolve(null);
                    } else {
                        resolve(dataUrl);
                    }
                });
            });
        }

        if (finalScreenshot) {
            sendLogToPanel(`Captured SoM screenshot with ${Object.keys(result.somMap || {}).length} labeled elements`, 'info');

            return {
                success: true,
                image: finalScreenshot,
                somMap: result.somMap,
                elements: result.elements,
                elementCount: result.elementCount,
                pageUrl: result.pageUrl,
                pageTitle: result.pageTitle
            };
        } else {
            sendLogToPanel('Screenshot capture returned null after retry, using text-only mode', 'warn');
            // Fall back to text-only mode but still return elements
            return {
                success: true,
                image: null,
                somMap: result.somMap,
                elements: result.elements,
                elementCount: result.elementCount,
                pageUrl: result.pageUrl,
                pageTitle: result.pageTitle
            };
        }
    } catch (e) {
        sendLogToPanel(`SoM capture failed: ${e.message}`, 'warn');
    }
    return null;
}

// ─── MAIN AGENT LOOP ───────────────────────────────────────────
async function agentLoop(prompt, tabId, planSteps = []) {
    const maxSteps = 50; // Increased from default to handle complex SOPs
    let actionHistory = [];           // Full rich history for Selenium code gen
    let currentPlanStepIndex = 0;     // Enhancement 1: Track current plan step

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
    let totalScrollAttempts = 0;     // Track ALL scroll attempts across targets
    let failedActionCount = 0;       // Consecutive failures
    const maxFailedActions = 3;
    let lastObservedElements = [];    // Cache for element resolution
    let lastSomMap = {};              // SoM index to selector mapping
    let lastActionFailed = false;     // Did the previous action fail?
    let lastActionError = '';         // Error message from last failed action
    let recentFingerprints = [];      // Last 3 page fingerprints for stale detection
    let staleStateCount = 0;          // Consecutive steps with identical fingerprints
    let lastPageUrl = '';             // Track URL changes for vision triggering

    try { // ── OUTER TRY: guarantees AGENT_DONE fires even on unhandled crash ──
        for (let step = 0; step < maxSteps && isRunning; step++) {
            try { // ── PER-STEP TRY-CATCH: prevents silent crashes ──
                const stepStartTime = Date.now();
                sendLogToPanel(`--- Step ${step + 1} ---`, 'step');

                // Check consecutive failure limit
                if (failedActionCount >= maxFailedActions) {
                    sendLogToPanel(`Stopped: ${maxFailedActions} consecutive action failures.`, 'error');
                    break;
                }

                // 1. Wait for page stability (DOM + network)
                // SPEED: Reduce wait for form-filling steps (type/select don't change DOM structure)
                const prevAction = actionHistory.length > 0 ? actionHistory[actionHistory.length - 1] : null;
                const isFormFilling = prevAction && ['type', 'select_option'].includes(prevAction.action) && prevAction.actionSuccess;
                sendLogToPanel('Waiting for page stability...', 'info');
                await waitForStability(currentTabId, isFormFilling ? 500 : 2000);

                // 2. HYBRID MODE: DOM-primary with Vision-on-demand
                // Vision is only triggered when the agent is confused/stuck
                let observeResult = null;
                let useVision = shouldUseVision(step, failedActionCount, lastActionFailed, actionHistory, lastPageUrl);

                // Get current tab URL
                let currentTabUrl = '';
                try {
                    const tabInfo = await new Promise(resolve => chrome.tabs.get(currentTabId, resolve));
                    currentTabUrl = tabInfo?.url || '';
                } catch (e) { }

                // Track page changes for vision triggering
                const pageChanged = currentTabUrl !== lastPageUrl && lastPageUrl !== '';
                if (currentTabUrl) lastPageUrl = currentTabUrl;

                // Also trigger vision on page navigation
                if (pageChanged) useVision = true;

                if (useVision) {
                    // VISION MODE: Capture screenshot + elements (slower but visual)
                    sendLogToPanel('Vision mode activated', 'info');
                    const somData = await captureSoMScreenshot(currentTabId);
                    if (somData && somData.success) {
                        observeResult = {
                            url: somData.pageUrl || currentTabUrl || '',
                            title: somData.pageTitle || '',
                            elements: somData.elements,
                            image: somData.image,
                            somMap: somData.somMap
                        };
                        lastSomMap = somData.somMap || {};
                        lastObservedElements = somData.elements;
                    }
                }

                // DOM-ONLY MODE (default): Fast, reliable, no screenshot
                if (!observeResult) {
                    sendLogToPanel('Observing page elements...', 'info');
                    observeResult = await executeContentScript(currentTabId, 'OBSERVE');
                    if (!observeResult || !observeResult.elements) {
                        sendLogToPanel("Failed to observe page. Retrying...", 'error');
                        await sleep(2000);
                        await injectContentScript(currentTabId);
                        continue;
                    }
                    observeResult.url = currentTabUrl || observeResult.url;
                    observeResult.image = null; // No image in DOM-only mode
                    observeResult.somMap = null;
                    lastObservedElements = observeResult.elements;
                }

                sendLogToPanel(`Page: ${observeResult.url}`, 'info');

                // Clear recently created tabs before the AI decision (so we can detect new ones after a click)
                recentlyCreatedTabs = [];

                // --- FINGERPRINT-BASED STALE-STATE DETECTION ---
                // Dynamically detects when the agent is truly stuck (not just filling a form)
                // Only triggers for NON-form-filling actions that should change the page
                const fingerprint = await executeContentScript(currentTabId, 'GET_FINGERPRINT', null, 2);
                if (fingerprint && fingerprint.contentHash && step > 5) {
                    recentFingerprints.push(fingerprint.contentHash);
                    if (recentFingerprints.length > 4) recentFingerprints.shift();

                    // Only check if last 4 fingerprints are ALL identical
                    if (recentFingerprints.length === 4 &&
                        recentFingerprints[0] === recentFingerprints[1] &&
                        recentFingerprints[1] === recentFingerprints[2] &&
                        recentFingerprints[2] === recentFingerprints[3]) {

                        // Dynamically check: are recent actions form-filling or navigation?
                        const recentActions = actionHistory.slice(-4).map(h => h.action);
                        const formFillingActions = ['type', 'select_option', 'scroll_down', 'scroll_up'];
                        const allFormFilling = recentActions.every(a => formFillingActions.includes(a));

                        // Only trigger stale state if recent actions are NOT form-filling
                        // (form filling on same page is normal — page fingerprint won't change)
                        if (!allFormFilling) {
                            staleStateCount++;
                            if (staleStateCount >= 3 && !postPopupDirective) {
                                postPopupDirective = 'STALE STATE: The page has NOT changed for 4+ non-form steps. '
                                    + 'Your previous click/navigation actions had NO visible effect. '
                                    + 'Try a completely different approach or scroll to find new elements.';
                                sendLogToPanel('Stale state detected — page unchanged for 4+ steps', 'error');
                            }
                        } else {
                            // Form filling on same page is normal — don't count as stale
                            staleStateCount = 0;
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

                // --- DYNAMIC SOP PROGRESS DETECTION ---
                // Analyze action history to detect when the agent has completed all SOP steps
                // and is stagnating (no new unique fields being interacted with)
                if (!postPopupDirective && actionHistory.length > 5) {
                    const progressInfo = analyzeSopProgress(actionHistory, observeResult.elements);
                    if (progressInfo.isStagnating) {
                        postPopupDirective = progressInfo.directive;
                    }
                }

                // 3. Build state payload for backend brain
                const sliceCount = Math.min(Math.max(observeResult.elements.length, 60), observeResult.elements.length);

                // Build dropdown state info for the AI
                // CRITICAL: Include ALL select elements, even those with placeholder/default values
                let dropdownStates = [];
                for (const el of observeResult.elements) {
                    if (el.tagName === 'select') {
                        const currentVal = el.selectedOptionText || el.text || '(empty/unset)';
                        // Use the content script's isPlaceholderSelected if available, otherwise detect from text
                        const isPlaceholder = el.isPlaceholderSelected ||
                            currentVal.toLowerCase().includes('select') ||
                            currentVal.toLowerCase().includes('choose') ||
                            currentVal.toLowerCase().includes('pick') ||
                            currentVal.toLowerCase().includes('--') ||
                            currentVal === '(empty/unset)' ||
                            currentVal === '';
                        dropdownStates.push({
                            selector: el.selector,
                            label: el.ariaLabel || el.name || el.id || el.text || 'unknown',
                            currentValue: currentVal,
                            isPlaceholder: isPlaceholder
                        });
                    }
                }

                // Compute dynamic SOP progress for the AI
                const sopProgress = analyzeSopProgress(actionHistory, observeResult.elements);

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
                    lastActionError,
                    // Vision data
                    image: observeResult.image || null,
                    somMap: observeResult.somMap || {},
                    // Dropdown states
                    dropdownStates: dropdownStates,
                    // Dynamic SOP progress
                    sopProgress: {
                        uniqueFieldsInteracted: sopProgress.uniqueFieldsInteracted,
                        totalSuccessfulActions: sopProgress.totalSuccessfulActions,
                        recentNewFieldRate: sopProgress.recentNewFieldRate,
                        isStagnating: sopProgress.isStagnating
                    },
                    // Enhancement 1: Plan-aware execution
                    planSteps: planSteps,
                    currentPlanStepIndex: currentPlanStepIndex
                };

                // 4. Ask the backend brain (AI) for the next action
                let aiDecision;
                try {
                    sendLogToPanel('Thinking... (waiting for AI response)', 'info');
                    const controller = new AbortController();
                    const apiTimeout = setTimeout(() => controller.abort(), 60000); // 60s timeout
                    const response = await fetch(API_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                        body: JSON.stringify(statePayload),
                        signal: controller.signal
                    });
                    clearTimeout(apiTimeout);

                    if (!response.ok) {
                        const text = await response.text();
                        sendLogToPanel(`Brain API error ${response.status}: ${text.slice(0, 200)}`, 'error');
                        failedActionCount++;
                        lastActionFailed = true;
                        lastActionError = `HTTP ${response.status}`;
                        actionHistory.push({
                            step: step + 1,
                            action: 'api_error',
                            error: `HTTP ${response.status}`,
                            actionSuccess: false
                        });
                        await waitForStability(currentTabId, 1500);
                        continue;
                    }

                    const responseData = await response.json();

                    // Check if we got an error response (e.g., empty selector)
                    if (responseData.error) {
                        sendLogToPanel(`AI Error: ${responseData.error}`, 'error');
                        if (responseData.retry) {
                            // Force a retry by not counting this as a proper step
                            postPopupDirective = 'CRITICAL: You MUST provide a valid CSS selector. The previous response had an empty selector which is invalid. Look at the elements list and pick the correct selector.';
                            failedActionCount++;
                            // Re-observe and try again
                            await waitForStability(currentTabId, 1500);
                            continue;
                        }
                    }

                    aiDecision = responseData;
                } catch (error) {
                    if (error.name === 'AbortError') {
                        sendLogToPanel('AI API timed out after 60s. Retrying...', 'error');
                        failedActionCount++;
                        actionHistory.push({ step: step + 1, action: 'api_timeout', error: 'API call timed out', actionSuccess: false });
                        continue;
                    }
                    sendLogToPanel(`Error connecting to brain API: ${error.message}`, 'error');
                    break;
                }

                // Consume post-popup directive (one-shot)
                postPopupDirective = '';

                sendLogToPanel(`AI thought: ${aiDecision.thought}`, 'info');
                sendLogToPanel(`AI decided: ${aiDecision.action} on ${aiDecision.selector || ''}`, 'decision');

                // Enhancement 1: Plan step tracking
                if (aiDecision.planStepCompleted && currentPlanStepIndex < planSteps.length) {
                    currentPlanStepIndex++;
                    sendLogToPanel(`Plan step ${currentPlanStepIndex} completed`, 'success');
                }

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

                // 6. Loop detection — FRONTIER APPROACH: blacklist + force forward
                const loopResult = checkForLoop(aiDecision, actionRetryCount, lastActionKey);
                lastActionKey = loopResult.actionKey;
                if (loopResult.isLoop) {
                    sendLogToPanel(loopResult.message, 'error');
                    historyEntry.loopDetected = true;
                    historyEntry.actionSuccess = false;
                    actionHistory.push(historyEntry);

                    const actionType = aiDecision.action || '';
                    const blockedSelector = aiDecision.selector || '';

                    // BLACKLIST this selector
                    if (blockedSelector && !clickedSelectors.includes('BLOCKED:' + blockedSelector)) {
                        clickedSelectors.push('BLOCKED:' + blockedSelector);
                    }

                    // ── SMART RECOVERY: If loop was on scroll, auto-attempt submit button ──
                    if (actionType === 'scroll_down' || actionType === 'scroll_up') {
                        sendLogToPanel('Scroll loop detected — auto-attempting to find and click submit button...', 'info');
                        const submitResult = await executeContentScript(currentTabId, 'FIND_AND_CLICK_SUBMIT', null, 3);

                        if (submitResult && submitResult.success) {
                            sendLogToPanel(`Auto-clicked submit: "${submitResult.clickedText}" (${submitResult.clickedSelector})`, 'success');
                            actionHistory.push({
                                step: actionHistory.length + 1,
                                thought: 'Auto-recovery: Found and clicked submit button after scroll loop',
                                action: 'click',
                                selector: submitResult.clickedSelector,
                                actionSuccess: true,
                                autoSubmit: true,
                                buttonText: submitResult.clickedText
                            });
                            await waitForStability(currentTabId, 3000);
                            postPopupDirective = 'AUTO-SUBMIT ATTEMPTED: The system found and clicked "'
                                + submitResult.clickedText + '". Check if the form submitted successfully. '
                                + 'If the modal closed or success message appeared, call "finish". '
                                + 'If validation errors appeared, fix them and re-submit.';
                            continue;
                        } else {
                            sendLogToPanel('Auto-submit not found. Directing AI to try direct selectors...', 'warn');
                            postPopupDirective = 'SCROLL LOOP BROKEN: The submit button was never found in the elements list. '
                                + 'CRITICAL: Try clicking with these selectors in order: '
                                + '1) button[type="submit"] '
                                + '2) [role="dialog"] form button:last-of-type '
                                + '3) Any button containing "Add", "Save", or "Submit" text. '
                                + 'Use "click" action with these selectors directly.';
                            continue;
                        }
                    }

                    // For non-scroll loops: keep existing behavior
                    postPopupDirective = `LOOP BROKEN: The field "${blockedSelector}" has been BLOCKED. `
                        + `You CANNOT interact with this selector anymore. `
                        + `IMMEDIATELY move to the NEXT unfilled field or click the SUBMIT/SAVE button.`;

                    await executeContentScript(currentTabId, 'EXECUTE_ACTION', {
                        action: 'scroll_down',
                        selector: null
                    });

                    continue;
                }

                // 7. Handle FINISH
                if (aiDecision.action === 'finish') {
                    sendLogToPanel(`Agent finished: ${aiDecision.summary}`, 'decision');
                    actionHistory.push(historyEntry);
                    break;
                }

                // 7a. Handle ACTION_SEQUENCE (Gap B: Multi-Action Chaining)
                if (aiDecision.action === 'action_sequence' && aiDecision.actions && aiDecision.actions.length > 0) {
                    sendLogToPanel(`Action sequence (${aiDecision.actions.length} actions)...`, 'info');
                    let seqSuccess = 0;
                    const seqResults = [];
                    for (const subAction of aiDecision.actions.slice(0, 5)) {
                        const subResult = await executeContentScript(currentTabId, 'EXECUTE_ACTION', subAction);
                        if (subResult && subResult.success) {
                            seqSuccess++;
                            if (subAction.selector) clickedSelectors.push(subAction.selector);
                            seqResults.push({ action: subAction.action, selector: subAction.selector, success: true });
                        } else {
                            seqResults.push({ action: subAction.action, selector: subAction.selector, success: false, error: subResult?.error });
                            sendLogToPanel(`Sequence step failed: ${subAction.action} on ${subAction.selector}`, 'warn');
                            break;
                        }
                        await sleep(200);
                    }
                    historyEntry.actionSuccess = seqSuccess > 0;
                    historyEntry.sequenceResults = seqResults;
                    historyEntry.sequenceCompleted = seqSuccess;
                    sendLogToPanel(`Sequence: ${seqSuccess}/${aiDecision.actions.length}`, seqSuccess > 0 ? 'success' : 'error');
                    failedActionCount = seqSuccess > 0 ? 0 : failedActionCount + 1;
                    lastActionFailed = seqSuccess === 0;
                    lastActionError = seqSuccess === 0 ? 'Action sequence failed' : '';
                    actionHistory.push(historyEntry);
                    await waitForStability(currentTabId, 1000);
                    continue;
                }

                // 7b. Handle BATCH_FILL — fill multiple form fields in one step
                if (aiDecision.action === 'batch_fill' && aiDecision.fields && aiDecision.fields.length > 0) {
                    sendLogToPanel(`Batch filling ${aiDecision.fields.length} fields...`, 'info');
                    const batchResult = await executeContentScript(currentTabId, 'BATCH_FILL', { fields: aiDecision.fields }, 3);

                    if (batchResult && batchResult.success) {
                        sendLogToPanel(`Batch filled ${batchResult.filledCount}/${aiDecision.fields.length} fields`, 'success');
                        historyEntry.actionSuccess = true;
                        historyEntry.batchResults = batchResult.results;
                        historyEntry.filledCount = batchResult.filledCount;
                        failedActionCount = 0;
                        lastActionFailed = false;
                        lastActionError = '';

                        // Track each filled field in clickedSelectors
                        for (const r of (batchResult.results || [])) {
                            if (r.success && r.selector) {
                                clickedSelectors.push(r.selector);
                            }
                        }
                    } else {
                        historyEntry.actionSuccess = false;
                        historyEntry.error = 'Batch fill failed';
                        failedActionCount++;
                        lastActionFailed = true;
                        lastActionError = 'Batch fill returned no result';
                    }

                    actionHistory.push(historyEntry);
                    await waitForStability(currentTabId, 800);
                    continue;
                }

                // 8. Execute the action
                let actionResult = null;
                let actionSuccess = false;
                sendLogToPanel(`Executing: ${aiDecision.action} on ${aiDecision.selector || '(page)'}...`, 'info');

                // ── Tab management actions ──
                if (['switch_tab', 'new_tab', 'list_tabs', 'close_tab'].includes(aiDecision.action)) {
                    // Track consecutive list_tabs calls
                    if (aiDecision.action === 'list_tabs') {
                        consecutiveListTabsCount++;
                        if (consecutiveListTabsCount >= 3) {
                            sendLogToPanel('list_tabs called 3+ times. Forcing agent to proceed.', 'error');
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

                    // Track total scroll attempts across ALL targets
                    if (aiDecision.action === 'scroll_down' || aiDecision.action === 'scroll_up') {
                        totalScrollAttempts++;
                        // If excessive scrolling (across any targets), auto-attempt submit
                        if (totalScrollAttempts > 10) {
                            sendLogToPanel(`${totalScrollAttempts} total scroll attempts — auto-attempting submit...`, 'warn');
                            const submitResult = await executeContentScript(currentTabId, 'FIND_AND_CLICK_SUBMIT', null, 3);
                            if (submitResult && submitResult.success) {
                                sendLogToPanel(`Auto-clicked submit: "${submitResult.clickedText}"`, 'success');
                                actionHistory.push({
                                    step: actionHistory.length + 1,
                                    thought: 'Auto-recovery: Excessive scroll attempts, clicked submit',
                                    action: 'click',
                                    selector: submitResult.clickedSelector,
                                    actionSuccess: true,
                                    autoSubmit: true
                                });
                                await waitForStability(currentTabId, 3000);
                                postPopupDirective = 'AUTO-SUBMIT: Clicked "' + submitResult.clickedText + '" after excessive scrolling. Check result and call finish if successful.';
                                continue;
                            }
                        }
                    } else {
                        // Reset scroll counter when a non-scroll action happens
                        if (aiDecision.action !== 'scroll_down' && aiDecision.action !== 'scroll_up') {
                            totalScrollAttempts = 0;
                        }
                    }

                    actionResult = await executeContentScript(currentTabId, 'EXECUTE_ACTION', aiDecision);
                    sendLogToPanel(`Action result: ${JSON.stringify(actionResult)}`, 'info');

                    if (actionResult) {
                        actionSuccess = actionResult.success;

                        // Enhancement 7: Scroll Verification — detect zero-scroll and inject directive
                        if ((aiDecision.action === 'scroll_down' || aiDecision.action === 'scroll_up') && actionResult.success) {
                            if (actionResult.scrollFailed || (actionResult.scrolled === 0 && !actionResult.scrollRecovery)) {
                                postPopupDirective = `SCROLL FAILED: scrolled=0 on "${actionResult.scrollTarget || 'unknown'}". `
                                    + `Container cannot scroll further. STOP scrolling. Instead: `
                                    + `1) Click target element directly from elements list. `
                                    + `2) Use keyboard Tab/Enter. `
                                    + `3) Try different scroll container.`;
                                sendLogToPanel('Scroll returned 0 — injecting recovery directive', 'warn');
                            }
                        }

                        // Enhancement 8: Post-Action Verification for critical clicks
                        if (aiDecision.action === 'click' && actionResult.success) {
                            // Check if this was an "Add to Cart" or similar critical action
                            const clickedEl = lastObservedElements.find(e => e.selector === aiDecision.selector);
                            const clickedText = (clickedEl?.text || '').toLowerCase();
                            if (clickedText.includes('add to cart') || clickedText.includes('add to bag') || clickedText.includes('buy now')) {
                                historyEntry.isCartAction = true;
                                postPopupDirective = 'VERIFY: You clicked "Add to Cart". Next step: check if cart confirmation appeared (popup, badge, redirect). If cart empty or no confirmation, the action FAILED — retry differently.';
                            }
                        }

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

                        // ── ENHANCED: DROPDOWN DETECTION FEEDBACK ──
                        // When the content script detects a dropdown appeared after typing
                        // but couldn't auto-select an option, inject a directive for the AI
                        // to manually click the correct option in the next step.
                        if (actionResult.dropdownDetectedButNotSelected && aiDecision.action === 'type' &&
                            actionResult.visibleOptionTexts && actionResult.visibleOptionTexts.length > 0) {
                            const optionsList = actionResult.visibleOptionTexts.slice(0, 5).join('", "');
                            postPopupDirective = `DROPDOWN VISIBLE BUT NOT AUTO-SELECTED: After typing "${aiDecision.text}" into the field "${aiDecision.selector}", `
                                + `a dropdown/autocomplete list appeared with visible options: ["${optionsList}"]. `
                                + `You MUST click the correct matching option from this dropdown in your NEXT action. `
                                + `Use "click" action targeting the option element (look for [role="option"], li, or similar). `
                                + `Do NOT call "finish" — the value is NOT properly selected until you click the dropdown option. `
                                + `Do NOT re-type the value. The dropdown should still be visible.`;
                            sendLogToPanel('Dropdown appeared but option not auto-selected — AI must click it next step', 'warn');
                            historyEntry.dropdownVisibleNotSelected = true;
                            historyEntry.visibleOptions = actionResult.visibleOptionTexts;
                        }

                        // ── ENHANCED: Track successful auto-selection for history ──
                        if (actionResult.autoSelectedDropdown) {
                            historyEntry.autoSelectedDropdown = true;
                            historyEntry.selectedDropdownText = actionResult.selectedDropdownText;
                            sendLogToPanel(`Auto-selected dropdown option: "${actionResult.selectedDropdownText}"`, 'success');
                        }

                        // ── ENHANCED: Combobox with no dropdown appeared ──
                        if (actionResult.comboboxNoDropdownAppeared && aiDecision.action === 'type') {
                            postPopupDirective = `COMBOBOX WARNING: The field "${aiDecision.selector}" is a searchable combobox, `
                                + `but no dropdown appeared after typing "${aiDecision.text}". Possible causes: `
                                + `1) The search term didn't match any options. Try a shorter/different search term. `
                                + `2) The field needs a click first to activate it before typing. `
                                + `3) There may be a loading delay. Try clicking the field's dropdown arrow/chevron button. `
                                + `Do NOT call "finish" — the combobox value is NOT set.`;
                            sendLogToPanel('Combobox field — no dropdown appeared after typing', 'warn');
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

                                    sendLogToPanel('Non-navigable popup detected and closed. Continuing on main page.', 'info');
                                } else if (windowOpenDetected) {
                                    // window.open was called but we couldn't find the tab via Chrome API
                                    // The tab might be in a different window — try to find it
                                    sendLogToPanel('window.open detected, scanning for new tab...', 'info');
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
                                        sendLogToPanel(`Late tab detection: ${lateDetect.url}`, 'success');
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
                        sendLogToPanel(`Action failed (${failedActionCount}/${maxFailedActions} before stop)`, 'error');
                    }
                }

                actionHistory.push(historyEntry);

                // 10. Wait for UI to settle before next iteration
                // SPEED: Shorter wait for form-filling actions
                const justFilledField = aiDecision && ['type', 'select_option'].includes(aiDecision.action) && actionSuccess;
                await waitForStability(currentTabId, justFilledField ? 500 : 1500);

                // Log step duration for performance tracking
                const stepDuration = ((Date.now() - stepStartTime) / 1000).toFixed(1);
                sendLogToPanel(`Step ${step + 1} completed in ${stepDuration}s`, 'info');

            } catch (stepError) {
                // ── PER-STEP ERROR CATCH: log and continue instead of silently dying ──
                sendLogToPanel(`Step ${step + 1} crashed: ${stepError.message}`, 'error');
                console.error('Step crash:', stepError);
                failedActionCount++;
                actionHistory.push({
                    step: step + 1,
                    action: 'step_crash',
                    error: stepError.message,
                    actionSuccess: false
                });
                if (failedActionCount >= maxFailedActions) {
                    sendLogToPanel(`Stopped: ${maxFailedActions} consecutive failures (including crashes).`, 'error');
                    break;
                }
                // Continue to next step instead of dying silently
                continue;
            } // end per-step try-catch
        }

    } finally {
        // ── GUARANTEE: AGENT_DONE always fires, even on crash ──
        isRunning = false;
        lastAgentHistory = actionHistory;
        chrome.storage.local.set({
            lastAgentHistory: actionHistory,
            lastAgentPrompt: lastAgentPrompt,
            lastAgentStartUrl: lastAgentStartUrl
        });

        // Gap C: Site Knowledge Learning — submit to backend after run
        if (lastAgentStartUrl && actionHistory.length > 2) {
            try {
                fetch(LEARN_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: lastAgentStartUrl, history: actionHistory, prompt: lastAgentPrompt })
                }).catch(() => { });
            } catch (e) { /* non-critical */ }
        }

        sendLogToPanel('Loop ended.', 'info');
        chrome.runtime.sendMessage({ type: 'AGENT_DONE', hasHistory: actionHistory.length > 0 }).catch(() => { });
    }
}

// ─── HYBRID VISION: Dynamically decide when to use vision ──────
// DOM-only is default (fast, reliable). Vision is triggered only when:
// 1. First step (need to understand initial page layout)
// 2. Page URL changed (navigated to new page)
// 3. Multiple consecutive failures (agent is confused)
// 4. After a click that might have changed page structure significantly
// This is fully dynamic — no hardcoded step numbers.
function shouldUseVision(step, failedActionCount, lastActionFailed, actionHistory, lastPageUrl) {
    // First step — need to see the page layout
    if (step === 0) return true;

    // Multiple consecutive failures — agent is confused, needs visual context
    if (failedActionCount >= 2) return true;

    // Page URL changed — new page, need visual understanding
    // (This is checked by the caller comparing currentTabUrl !== lastPageUrl)

    // After 2+ loop detections in recent history — agent is stuck
    const recentLoops = actionHistory.slice(-5).filter(h => h.loopDetected).length;
    if (recentLoops >= 2) return true;

    // If last action was a click and it succeeded — page might have changed visually
    // (new modal, new section revealed, etc.)
    if (actionHistory.length > 0) {
        const lastAction = actionHistory[actionHistory.length - 1];
        if (lastAction.action === 'click' && lastAction.actionSuccess) {
            // Only use vision after clicks that likely changed the page
            // (not after clicking form fields)
            const clickedFormField = lastAction.selector &&
                (lastAction.selector.includes('input') ||
                    lastAction.selector.includes('textarea') ||
                    lastAction.selector.includes('select'));
            if (!clickedFormField) return true;
        }
    }

    // Default: DOM-only (fast mode for form filling)
    return false;
}

// ─── DYNAMIC SOP PROGRESS ANALYSIS ────────────────────────────
// Analyzes action history to determine if the agent has completed all meaningful
// actions and is now stagnating (repeating same patterns, no new fields being filled).
// This is fully dynamic — no hardcoded step thresholds.
function analyzeSopProgress(actionHistory, currentElements) {
    const result = {
        isStagnating: false,
        directive: '',
        uniqueFieldsInteracted: 0,
        totalSuccessfulActions: 0,
        recentNewFieldRate: 0
    };

    if (!actionHistory || actionHistory.length < 3) return result;

    // 1. Count unique selectors that were successfully interacted with
    const successfulSelectors = new Set();
    const successfulActions = [];
    const failedSelectors = new Set();
    let loopDetections = 0;

    for (const entry of actionHistory) {
        if (entry.loopDetected) loopDetections++;
        if (entry.actionSuccess && entry.selector) {
            successfulSelectors.add(entry.selector);
            successfulActions.push(entry);
        }
        if (!entry.actionSuccess && entry.selector) {
            failedSelectors.add(entry.selector);
        }
    }

    result.uniqueFieldsInteracted = successfulSelectors.size;
    result.totalSuccessfulActions = successfulActions.length;

    // 2. Analyze the RECENT history window (last 5 actions)
    // Check if any NEW unique selectors are being interacted with
    const recentWindow = actionHistory.slice(-5);
    const olderSelectors = new Set(
        actionHistory.slice(0, -5)
            .filter(e => e.actionSuccess && e.selector)
            .map(e => e.selector)
    );
    const recentNewSelectors = recentWindow.filter(e =>
        e.actionSuccess && e.selector && !olderSelectors.has(e.selector)
    );
    result.recentNewFieldRate = recentNewSelectors.length / Math.max(recentWindow.length, 1);

    // 3. Count how many form fields on the current page are EMPTY vs FILLED
    let emptyFormFields = 0;
    let filledFormFields = 0;
    let totalFormFields = 0;
    if (currentElements) {
        for (const el of currentElements) {
            if (['input', 'textarea', 'select'].includes(el.tagName)) {
                totalFormFields++;
                const hasValue = el.currentValue && el.currentValue.trim() !== '';
                const isSelectFilled = el.tagName === 'select' && el.selectedOptionText && !el.isPlaceholderSelected;
                if (hasValue || isSelectFilled) {
                    filledFormFields++;
                } else {
                    emptyFormFields++;
                }
            }
        }
    }

    // 4. Determine stagnation dynamically:
    // - No new fields being interacted with in last 5 steps
    // - OR: Most form fields are filled and agent keeps repeating
    // - OR: Multiple loop detections have occurred
    const noNewProgress = result.recentNewFieldRate === 0 && actionHistory.length > 8;
    const mostFieldsFilled = totalFormFields > 0 && (filledFormFields / totalFormFields) > 0.7;
    const multipleLoops = loopDetections >= 2;
    const lastActionsAreRepeats = recentWindow.length >= 3 &&
        new Set(recentWindow.map(e => e.selector)).size <= 2;

    if (noNewProgress && (mostFieldsFilled || multipleLoops || lastActionsAreRepeats)) {
        result.isStagnating = true;

        // Build a dynamic directive based on actual state
        const filledPct = totalFormFields > 0 ? Math.round((filledFormFields / totalFormFields) * 100) : 0;
        const emptyFieldNames = currentElements
            ? currentElements
                .filter(el => ['input', 'textarea', 'select'].includes(el.tagName) &&
                    !el.currentValue && (el.tagName !== 'select' || el.isPlaceholderSelected))
                .map(el => el.id || el.name || el.ariaLabel || el.selector)
                .slice(0, 5)
            : [];

        let directive = `PROGRESS ANALYSIS: You have successfully interacted with ${result.uniqueFieldsInteracted} unique fields. `;
        directive += `Form completion: ${filledPct}% (${filledFormFields}/${totalFormFields} fields filled). `;

        if (emptyFieldNames.length > 0 && emptyFieldNames.length <= 3) {
            directive += `Remaining empty fields: ${emptyFieldNames.join(', ')}. Fill these if possible, then submit. `;
        } else if (emptyFieldNames.length > 3) {
            directive += `${emptyFieldNames.length} fields still empty but you appear stuck. `;
        }

        if (multipleLoops) {
            directive += `${loopDetections} loop detections occurred — some fields may not be fillable with current approach. `;
        }

        directive += `ACTION REQUIRED: If you have attempted all SOP steps, click the submit/save button NOW. `;
        directive += `Do NOT keep retrying fields that already failed. After submission, call "finish".`;

        result.directive = directive;
    }

    return result;
}

// ─── UTILITY ───────────────────────────────────────────────────
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
