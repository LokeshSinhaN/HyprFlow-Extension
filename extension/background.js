// Hyprflow Extension Background Worker — the "Brain Coordinator".
// ENHANCED: Plan-Aware Execution, Post-Action Verification, Multi-Action Chaining,
// Scroll Verification, Site Knowledge Learning, Coordinate Click support.

const API_URL = "http://127.0.0.1:8001/api/extension/loop";
const GENERATE_URL = "http://127.0.0.1:8001/api/extension/generate-selenium";
const PLAN_URL = "http://127.0.0.1:8001/api/extension/plan";
const LEARN_URL = "http://127.0.0.1:8001/api/extension/learn";
const CALL_API_URL = "http://127.0.0.1:8001/api/extension/call-api";
const CONFIG_URL = "http://127.0.0.1:8001/api/extension/config";

// ─── AGENT CONFIG ──────────────────────────────────────────────
// Mirrors backend config/automation.php. Fetched from /config at run start so
// feature flags and timeouts have a single source of truth; falls back to these
// defaults if the backend is unreachable. Replaces the old hard-coded 90s AI
// timeout, 15s content timeout and 5 content retries.
const AGENT_CONFIG_DEFAULTS = {
    localVerify: true,
    localRecovery: true,
    taskQueue: true,
    pageGraph: true,
    radixAdapters: true,
    crossFrame: true,
    cdpEnabled: false,
    targetScorer: 'heuristic',
    targetConfidenceThreshold: 0.85,
    aiTimeoutMs: 45000,
    contentTimeoutMs: 8000,
    contentRetries: 3,
    multiActionMaxChain: 5
};
let AGENT_CONFIG = { ...AGENT_CONFIG_DEFAULTS };

async function loadAgentConfig() {
    try {
        const res = await fetch(CONFIG_URL, { headers: { 'Accept': 'application/json' } });
        if (res.ok) {
            const cfg = await res.json();
            AGENT_CONFIG = { ...AGENT_CONFIG_DEFAULTS, ...cfg };
            if (chrome.storage.session) {
                chrome.storage.session.set({ agentConfig: AGENT_CONFIG }).catch(() => { });
            }
        }
    } catch (e) {
        // Backend down — keep defaults; the loop surfaces connection errors itself.
    }
    return AGENT_CONFIG;
}

// Enable side panel on icon click
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// ─── STATE ─────────────────────────────────────────────────────
let isRunning = false;
let currentTabId = null;
let isAgentMode = false;

// Persisted after each agent run so "Generate Code" can use them
let lastAgentHistory = [];
let lastAgentPrompt = '';
let lastAgentStartUrl = '';
let currentPlanSteps = []; // Enhancement 1: Plan steps for tracking

// ─── HUMAN-IN-THE-LOOP STATE ───────────────────────────────────
let humanResponseResolver = null;   // Promise resolver for awaiting human input
let isAwaitingHuman = false;        // Whether the agent is paused waiting for human response
let lastAskUserContext = null;      // Context of the last ask_user action (for resuming)

// Load persisted state on startup (Manifest V3 service worker may have restarted)
chrome.storage.local.get(['lastAgentHistory', 'lastAgentPrompt', 'lastAgentStartUrl'], (result) => {
    if (result.lastAgentHistory) lastAgentHistory = result.lastAgentHistory;
    if (result.lastAgentPrompt) lastAgentPrompt = result.lastAgentPrompt;
    if (result.lastAgentStartUrl) lastAgentStartUrl = result.lastAgentStartUrl;
});

// ─── DURABLE RUN STATE (survives MV3 service-worker restarts) ──
// The MV3 service worker can be torn down at any time, wiping in-memory globals
// and the agent-loop's local variables. We snapshot the active run to
// chrome.storage.session (whose lifetime matches the browser session — the right
// scope for an in-flight automation) and restore/resume when the worker wakes.
const RUN_STATE_KEY = 'hyprflowRunState';
let runStateSaveTimer = null;
let pendingResumeState = null;   // Hydrated into agentLoop when resuming after a restart

function persistRunState(loopState = {}, immediate = false) {
    if (!chrome.storage.session) return;
    const write = () => {
        const snapshot = {
            isRunning,
            isAgentMode,
            currentTabId,
            prompt: lastAgentPrompt,
            startUrl: lastAgentStartUrl,
            planSteps: currentPlanSteps,
            updatedAt: Date.now(),
            loop: loopState   // step, actionHistory, counters, quickFillState, taskQueue, ...
        };
        chrome.storage.session.set({ [RUN_STATE_KEY]: snapshot }).catch(() => { });
    };
    if (immediate) {
        if (runStateSaveTimer) { clearTimeout(runStateSaveTimer); runStateSaveTimer = null; }
        write();
        return;
    }
    // Throttle rapid writes within a single step.
    if (runStateSaveTimer) clearTimeout(runStateSaveTimer);
    runStateSaveTimer = setTimeout(() => { runStateSaveTimer = null; write(); }, 250);
}

async function loadRunState() {
    if (!chrome.storage.session) return null;
    try {
        const data = await chrome.storage.session.get([RUN_STATE_KEY]);
        return data[RUN_STATE_KEY] || null;
    } catch (e) { return null; }
}

function clearRunState() {
    if (runStateSaveTimer) { clearTimeout(runStateSaveTimer); runStateSaveTimer = null; }
    if (!chrome.storage.session) return;
    chrome.storage.session.remove(RUN_STATE_KEY).catch(() => { });
}

// ─── DURABLE TASK QUEUE / STATE MACHINE (Phase 3) ──────────────
// A restartable state machine layered over the plan. Each plan step becomes a
// task that moves planned -> queued -> executing -> verifying -> complete, with
// retrying / needs_llm / needs_user / failed branches, an idempotency key and a
// retry budget. The queue is persisted inside the run snapshot so it survives
// service-worker restarts. The LLM still chooses concrete actions; the queue
// governs step lifecycle, progress, and retry accounting.
const TASK_STATES = ['planned', 'queued', 'executing', 'verifying', 'complete', 'retrying', 'needs_llm', 'needs_user', 'failed'];

function seedTaskQueue(planSteps) {
    return (planSteps || []).map((step, i) => ({
        id: 'task_' + i,
        index: i,
        description: typeof step === 'string' ? step : (step && step.description ? step.description : String(step)),
        state: i === 0 ? 'queued' : 'planned',
        idempotencyKey: 'step-' + i,
        retryBudget: 3,
        attempts: 0,
        timeoutMs: 120000,
        updatedAt: Date.now()
    }));
}

function taskTransition(queue, index, state, note) {
    if (!Array.isArray(queue) || index < 0 || index >= queue.length) return queue;
    const t = queue[index];
    if (!t || !TASK_STATES.includes(state)) return queue;
    t.state = state;
    if (state === 'retrying') t.attempts = (t.attempts || 0) + 1;
    if (note) t.note = String(note).slice(0, 200);
    t.updatedAt = Date.now();
    // Advance the next task to 'queued' when this one completes.
    if (state === 'complete' && queue[index + 1] && queue[index + 1].state === 'planned') {
        queue[index + 1].state = 'queued';
    }
    // Surface progress to the panel (best-effort).
    chrome.runtime.sendMessage({ type: 'TASK_QUEUE_UPDATE', payload: { queue } }).catch(() => { });
    return queue;
}

// On service-worker wake, restore cached config and resume an interrupted run.
(async function restoreOnStartup() {
    if (chrome.storage.session) {
        try {
            const cached = await chrome.storage.session.get(['agentConfig']);
            if (cached.agentConfig) AGENT_CONFIG = { ...AGENT_CONFIG_DEFAULTS, ...cached.agentConfig };
        } catch (e) { /* ignore */ }
    }
    const state = await loadRunState();
    if (!state || !state.isRunning) return;
    // A run was in flight when the worker died — restore globals and continue it.
    isAgentMode = !!state.isAgentMode;
    currentTabId = state.currentTabId;
    lastAgentPrompt = state.prompt || '';
    lastAgentStartUrl = state.startUrl || '';
    currentPlanSteps = state.planSteps || [];
    let tabAlive = false;
    try {
        const tab = await new Promise(r => chrome.tabs.get(currentTabId, t => { if (chrome.runtime.lastError) r(null); else r(t); }));
        tabAlive = !!tab;
    } catch (e) { tabAlive = false; }
    if (!tabAlive) { clearRunState(); return; }
    pendingResumeState = state.loop || {};
    await loadAgentConfig();
    isRunning = true;
    sendLogToPanel('🔄 Resuming interrupted run after extension restart...', 'info');
    chrome.runtime.sendMessage({ type: 'RUN_RESUMED', payload: { prompt: lastAgentPrompt } }).catch(() => { });
    try { await injectContentScript(currentTabId); } catch (e) { /* content script auto-injects too */ }
    agentLoop(lastAgentPrompt, currentTabId, currentPlanSteps, pendingResumeState);
})();

// ─── FRAME REGISTRY (cross-origin iframe support) ──────────────
// content.js now injects into all frames (manifest all_frames:true). We track
// every frame per tab so the agent can observe/act inside iframes, and so
// main-frame messages target frameId 0 explicitly (avoids ambiguous responses
// now that multiple frames could each reply to a broadcast sendMessage).
const frameRegistry = new Map(); // tabId -> Map(frameId -> {frameId, parentFrameId, url})

function registerFrame(tabId, frameId, parentFrameId, url) {
    if (!frameRegistry.has(tabId)) frameRegistry.set(tabId, new Map());
    frameRegistry.get(tabId).set(frameId, { frameId, parentFrameId, url: url || '', ts: Date.now() });
}

if (chrome.webNavigation) {
    chrome.webNavigation.onCommitted.addListener((d) => registerFrame(d.tabId, d.frameId, d.parentFrameId, d.url));
    chrome.webNavigation.onCompleted.addListener((d) => registerFrame(d.tabId, d.frameId, d.parentFrameId, d.url));
}
chrome.tabs.onRemoved.addListener((tabId) => frameRegistry.delete(tabId));

// Send a message to a SPECIFIC frame (frameId 0 = main/top frame).
function sendMessageToFrame(tabId, frameId, message) {
    return new Promise((resolve) => {
        try {
            chrome.tabs.sendMessage(tabId, message, { frameId }, (response) => {
                if (chrome.runtime.lastError) resolve(null);
                else resolve(response);
            });
        } catch (e) { resolve(null); }
    });
}

// Observe every frame and aggregate elements, tagging each with its frameId so
// the executor can route the action back to the right frame. Returns null when
// only the main frame exists (caller falls back to the legacy single-frame path).
async function observeAllFrames(tabId) {
    if (!AGENT_CONFIG.crossFrame || !chrome.webNavigation) return null;
    let frames = [];
    try {
        frames = await new Promise((resolve) => {
            chrome.webNavigation.getAllFrames({ tabId }, (f) => {
                if (chrome.runtime.lastError || !f) resolve([]); else resolve(f);
            });
        });
    } catch (e) { frames = []; }
    if (!frames || frames.length <= 1) return null; // only main frame

    const aggregated = [];
    let mainResult = null;
    for (const fr of frames) {
        const resp = await sendMessageToFrame(tabId, fr.frameId, { type: 'OBSERVE', payload: { frameId: fr.frameId } });
        if (resp && Array.isArray(resp.elements)) {
            for (const el of resp.elements) {
                el.frameId = fr.frameId;
                el.frameUrl = fr.url;
                aggregated.push(el);
            }
            if (fr.frameId === 0) mainResult = resp;
        }
    }
    if (aggregated.length === 0) return null;
    if (!mainResult) mainResult = { url: '', title: '', validationErrors: [] };
    return {
        url: mainResult.url,
        title: mainResult.title,
        elements: aggregated,
        validationErrors: mainResult.validationErrors || [],
        multiFrame: true,
        frameCount: frames.length
    };
}

// ─── CDP MODULE (guarded, best-effort) ─────────────────────────
// For frames/elements the content script cannot reach, chrome.debugger drives
// input and reads the accessibility tree via the DevTools Protocol. Off by
// default (AGENT_CONFIG.cdpEnabled) since attaching shows a "being debugged"
// banner; coordinate input works regardless of frame origin.
const _cdpAttached = new Set();

function cdpSend(tabId, method, params) {
    return new Promise((resolve, reject) => {
        try {
            chrome.debugger.sendCommand({ tabId }, method, params || {}, (res) => {
                if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
                else resolve(res);
            });
        } catch (e) { reject(e); }
    });
}
async function cdpAttach(tabId) {
    if (!AGENT_CONFIG.cdpEnabled || !chrome.debugger) return false;
    if (_cdpAttached.has(tabId)) return true;
    try {
        await new Promise((resolve, reject) => chrome.debugger.attach({ tabId }, '1.3', () => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve()));
        _cdpAttached.add(tabId);
        for (const domain of ['DOM.enable', 'Runtime.enable', 'Accessibility.enable']) {
            try { await cdpSend(tabId, domain, {}); } catch (e) { /* domain optional */ }
        }
        return true;
    } catch (e) {
        return false;
    }
}
async function cdpDetach(tabId) {
    if (!_cdpAttached.has(tabId)) return;
    try { await new Promise((resolve) => chrome.debugger.detach({ tabId }, () => resolve())); } catch (e) { /* ignore */ }
    _cdpAttached.delete(tabId);
}
// Click at absolute viewport coordinates (works across origins).
async function cdpClickAtPoint(tabId, x, y) {
    if (!(await cdpAttach(tabId))) return { success: false, error: 'CDP attach failed/disabled' };
    try {
        await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
}
// Coordinate click fallback from an element's bounding box (viewport-relative).
async function cdpClickElementFallback(tabId, bbox) {
    if (!bbox || typeof bbox.x !== 'number') return { success: false, error: 'No bbox' };
    return cdpClickAtPoint(tabId, Math.round(bbox.x + bbox.width / 2), Math.round(bbox.y + bbox.height / 2));
}
// Read the full accessibility tree of a frame (best-effort, for inaccessible frames).
async function cdpGetAxTree(tabId) {
    if (!(await cdpAttach(tabId))) return null;
    try { return await cdpSend(tabId, 'Accessibility.getFullAXTree', {}); }
    catch (e) { return null; }
}
chrome.tabs.onRemoved.addListener((tabId) => { if (_cdpAttached.has(tabId)) cdpDetach(tabId); });

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
        isAgentMode = message.payload.agentMode;

        chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
            if (tabs.length === 0) return;
            currentTabId = tabs[0].id;
            // Pull the latest feature flags / timeouts before doing anything.
            await loadAgentConfig();
            lastAgentPrompt = prompt;
            persistRunState({}, true); // recoverable even if the worker dies during planning
            await injectContentScript(currentTabId);
            sendResponse({ status: 'started' });

            await generatePlan(prompt, false);
            // Wait for APPROVE_PLAN message from panel before starting loop
        });

        return true;
    }

    if (message.type === 'STOP_AGENT') {
        isRunning = false;
        // If agent is awaiting human input, resolve the promise to unblock the loop
        if (humanResponseResolver) {
            humanResponseResolver('stop');
            humanResponseResolver = null;
        }
        isAwaitingHuman = false;
        lastAskUserContext = null;
        clearRunState(); // user-initiated stop is not resumable
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

    // ─── HUMAN-IN-THE-LOOP RESPONSE ────────────────────────────────
    // When the user provides a response to an ask_user prompt from the panel
    if (message.type === 'HUMAN_RESPONSE') {
        const responseText = message.payload?.response || '';
        sendLogToPanel(`👤 Human response: ${responseText}`, 'success');

        if (humanResponseResolver) {
            // Resolve the pending promise in the agent loop
            humanResponseResolver(responseText);
            humanResponseResolver = null;
            isAwaitingHuman = false;
        } else {
            sendLogToPanel('Warning: Received human response but agent was not waiting.', 'warn');
        }
        sendResponse({ status: 'received' });
        return true;
    }

// ─── MAIN WORLD EVENT SIMULATION ───
    // Content scripts run in an ISOLATED world where dispatched events have
    // isTrusted:false. React/CMDK/Radix ignores these. This handler uses
    // chrome.scripting.executeScript with world:'MAIN' to run code in the
    // page's own JS context — CSP-proof and framework-compatible.
    if (message.type === 'SIMULATE_KEY_MAIN_WORLD') {
        const tabId = sender.tab?.id;
        if (!tabId) { sendResponse({ success: false }); return true; }

        const { selector, key, code, keyCode } = message.payload;
        chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: (sel, k, c, kc) => {
                try {
                    const el = sel ? document.querySelector(sel) : document.activeElement;
                    if (!el) return false;
                    el.focus();
                    el.dispatchEvent(new KeyboardEvent('keydown', {
                        key: k, code: c, keyCode: kc, which: kc,
                        bubbles: true, cancelable: true, composed: true
                    }));
                    el.dispatchEvent(new KeyboardEvent('keypress', {
                        key: k, code: c, keyCode: kc, which: kc,
                        bubbles: true, cancelable: true, composed: true
                    }));
                    el.dispatchEvent(new KeyboardEvent('keyup', {
                        key: k, code: c, keyCode: kc, which: kc,
                        bubbles: true, cancelable: true, composed: true
                    }));
                    return true;
                } catch (e) { return false; }
            },
            args: [selector, key, code, keyCode]
        }).then(results => {
            sendResponse({ success: results?.[0]?.result === true });
        }).catch(err => {
            sendResponse({ success: false, error: err.message });
        });
        return true;
    }

    if (message.type === 'SIMULATE_CLICK_MAIN_WORLD') {
        const tabId = sender.tab?.id;
        if (!tabId) { sendResponse({ success: false }); return true; }

        const { selector } = message.payload;
        chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: (sel) => {
                try {
                    const el = sel ? document.querySelector(sel) : null;
                    if (!el) return false;
                    const rect = el.getBoundingClientRect();
                    const x = rect.x + rect.width / 2;
                    const y = rect.y + rect.height / 2;
                    const opts = {
                        bubbles: true, cancelable: true, composed: true, view: window,
                        clientX: x, clientY: y, screenX: x, screenY: y,
                        button: 0, buttons: 1
                    };
                    el.dispatchEvent(new PointerEvent('pointerdown', opts));
                    el.dispatchEvent(new MouseEvent('mousedown', opts));
                    el.dispatchEvent(new PointerEvent('pointerup', opts));
                    el.dispatchEvent(new MouseEvent('mouseup', opts));
                    el.dispatchEvent(new MouseEvent('click', opts));
                    return true;
                } catch (e) { return false; }
            },
            args: [selector]
        }).then(results => {
            sendResponse({ success: results?.[0]?.result === true });
        }).catch(err => {
            sendResponse({ success: false, error: err.message });
        });
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
// Agent Mode should read like a plain-English narrative of WHAT is happening —
// not raw selectors / internal execution traces. These patterns are suppressed in
// Agent Mode so the panel only shows the user-facing story. Record mode is unchanged.
const AGENT_MODE_SUPPRESSED_LOG_PATTERNS = [
    /^AI decided:/, /^AI thought:/, /^Executing:/, /^Action result:/, /^Tab Action result:/,
    /^Waiting for page stability/, /^Vision mode activated/, /^Captured SoM screenshot/,
    /^Observing page elements/, /^Page: http/, /^Thinking\.\.\./, /^Step \d+ completed/,
    /^--- Step \d+ ---$/, /^API Endpoint:/, /^API Params:/, /^Action failed \(/,
    /^Scroll returned/, /^Stale state detected/, /^Plan step \d+ completed/
];

function isAgentVisibleLog(text) {
    // Always show explicitly user-facing lines (emoji-prefixed narrative & prompts).
    if (/^(🗣️|👤|⏸️|⚠️|🔍|✅|🚫)/.test(text)) return true;
    // Otherwise hide known-technical lines.
    return !AGENT_MODE_SUPPRESSED_LOG_PATTERNS.some(re => re.test(text));
}

function sendLogToPanel(text, level = 'info') {
    // Agent Mode: keep the panel readable — only forward the user-facing narrative.
    if (isAgentMode && !isAgentVisibleLog(text)) {
        console.log('[agent-mode hidden]', text);
        return;
    }
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
async function executeContentScript(tabId, actionType, payload = null, retries = null, frameId = 0) {
    const maxRetries = retries != null ? retries : (AGENT_CONFIG.contentRetries || 3);
    const timeoutMs = AGENT_CONFIG.contentTimeoutMs || 8000;
    for (let i = 0; i < maxRetries; i++) {
        const result = await Promise.race([
            new Promise((resolve) => {
                // Target a specific frame (default: main frame 0). With all_frames
                // injection an untargeted sendMessage would race replies from every
                // frame, so we always pin the frame explicitly.
                chrome.tabs.sendMessage(tabId, { type: actionType, payload }, { frameId }, (response) => {
                    if (chrome.runtime.lastError) resolve(null);
                    else resolve(response);
                });
            }),
            // Timeout: prevent infinite hang if content script never responds
            new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
        ]);
        if (result) return result;

        console.log(`Message failed, retrying (${i + 1}/${maxRetries})...`);
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

// ─── FRAME ROUTING ─────────────────────────────────────────────
// Determine which frame an action targets, from the matched element's frameId
// in the aggregated cross-frame observation. Defaults to the main frame (0).
function resolveActionFrameId(decision, elements) {
    if (!decision || !AGENT_CONFIG.crossFrame) return 0;
    const sel = decision.selector;
    if (!sel || !Array.isArray(elements)) return 0;
    const match = elements.find(e => e && e.selector === sel && typeof e.frameId === 'number');
    return match ? match.frameId : 0;
}

// ─── LOCAL VERIFIER + RECOVERY (Phase 2) ───────────────────────
// A mutating action is "verified" when its post-condition holds (value changed,
// option/chip selected, dialog opened/closed, DOM/URL changed). Verification is
// a cheap content-script round-trip — NOT an LLM call — so confirming locally
// avoids burning an LLM turn just to notice an action silently failed, and lets
// the recovery engine retry deterministically before we escalate.
const VERIFIABLE_ACTIONS = ['click', 'type', 'select_option', 'hover', 'keyboard_event'];

async function verifyActionLocally(tabId, decision, frameId) {
    if (!AGENT_CONFIG.localVerify || !VERIFIABLE_ACTIONS.includes(decision.action)) {
        return { verified: true, skipped: true };
    }
    const res = await executeContentScript(tabId, 'VERIFY_ACTION', {
        action: decision.action,
        selector: decision.selector || null,
        field: decision.field || null,
        text: decision.text || null,
        option: decision.option || null,
        text_match: decision.text_match || null
    }, 1, frameId);
    // If the verifier is unavailable (older content script), don't block the loop.
    if (!res) return { verified: true, unavailable: true };
    return res;
}

async function attemptLocalRecovery(tabId, decision, frameId) {
    if (!AGENT_CONFIG.localRecovery) return null;
    // Ask the content script to retry with alternate deterministic strategies
    // (universal click -> coordinate click -> keyboard nav; reopen portal; next candidate).
    return executeContentScript(tabId, 'EXECUTE_ACTION', { ...decision, _recovery: true }, 1, frameId);
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
                    if (chrome.runtime.lastError) resolve(null);
                    else resolve(tab);
                });
            });
            windowId = tabInfo ? tabInfo.windowId : null;
        } catch (e) {
            sendLogToPanel(`Failed to get tab info: ${e.message}`, 'warn');
        }

        if (!windowId) {
            sendLogToPanel('Could not determine windowId for screenshot, using text-only mode', 'warn');
            // Cleanup best-effort even if we can't capture
            try { await executeContentScript(tabId, 'CLEANUP_SOM', null, 1); } catch (e) { }
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

        // IMMEDIATELY cleanup SoM overlay after the first capture attempt resolves
        // (success or failure), so the user can interact normally.
        try { await executeContentScript(tabId, 'CLEANUP_SOM', null, 1); } catch (e) { }

        // If first attempt failed, retry once after a short delay
        let finalScreenshot = screenshot;
        if (!finalScreenshot) {
            await sleep(500);

            // Re-draw overlay for retry (because it was cleaned up above).
            // This ensures boxes are present in the retry screenshot too.
            try { await executeContentScript(tabId, 'CAPTURE_SOM', visionConfig, 1); } catch (e) { }

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

            // Cleanup after retry as well
            try { await executeContentScript(tabId, 'CLEANUP_SOM', null, 1); } catch (e) { }
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
        // Best-effort cleanup on exception
        try { await executeContentScript(tabId, 'CLEANUP_SOM', null, 1); } catch (e2) { }
    }
    return null;
}

// ─── MAIN AGENT LOOP ───────────────────────────────────────────
async function agentLoop(prompt, tabId, planSteps = [], resumeState = null) {
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
    let apiTimeoutCount = 0;         // Separate counter for API timeouts (not agent logic failures)
    const maxFailedActions = 3;
    const maxApiTimeouts = 5;        // Allow more retries for API timeouts (infrastructure issue)
    let lastObservedElements = [];    // Cache for element resolution
    let lastSomMap = {};              // SoM index to selector mapping
    let lastActionFailed = false;     // Did the previous action fail?
    let lastActionError = '';         // Error message from last failed action
    let recentFingerprints = [];      // Last 3 page fingerprints for stale detection
    let staleStateCount = 0;          // Consecutive steps with identical fingerprints
    let lastPageUrl = '';             // Track URL changes for vision triggering
    let apiCallCounts = {};           // call_api attempts per endpoint (loop + fallback detection)
    let consecutiveApiFailures = 0;   // consecutive failed API calls → triggers human-input fallback
// Quick Fill state — single source of truth for THIS agent run.
    // Declared locally (per-run) so it resets cleanly between runs. It is passed BY
    // REFERENCE into updateQuickFillState() (a module-level helper) which mutates its
    // properties. The helper cannot see this local binding via scope, so it MUST receive
    // quickFillState as a parameter — otherwise it throws "quickFillState is not defined".
    let quickFillState = {
        active: false,
        searched: false,
        optionClicked: false,
        selected: false,
        patientName: '',
        restartCount: 0,
        lastSearch: ''
    };
    // Phase 3: durable task queue seeded from the plan (one task per step).
    let taskQueue = AGENT_CONFIG.taskQueue ? seedTaskQueue(planSteps) : [];

    // ── RESUME HYDRATION ──
    // When the service worker restarts mid-run, restoreOnStartup() re-enters this
    // function with the persisted loop state so we continue instead of restarting.
    let startStep = 0;
    if (resumeState && typeof resumeState === 'object') {
        if (Array.isArray(resumeState.actionHistory)) actionHistory = resumeState.actionHistory;
        if (typeof resumeState.currentPlanStepIndex === 'number') currentPlanStepIndex = resumeState.currentPlanStepIndex;
        if (Array.isArray(resumeState.clickedSelectors)) clickedSelectors = resumeState.clickedSelectors;
        if (resumeState.toggledOptions) toggledOptions = resumeState.toggledOptions;
        if (resumeState.actionRetryCount) actionRetryCount = resumeState.actionRetryCount;
        if (typeof resumeState.lastActionKey === 'string') lastActionKey = resumeState.lastActionKey;
        if (typeof resumeState.failedActionCount === 'number') failedActionCount = resumeState.failedActionCount;
        if (resumeState.quickFillState) quickFillState = resumeState.quickFillState;
        if (resumeState.apiCallCounts) apiCallCounts = resumeState.apiCallCounts;
        if (typeof resumeState.lastPageUrl === 'string') lastPageUrl = resumeState.lastPageUrl;
        if (typeof resumeState.step === 'number') startStep = resumeState.step;
        if (Array.isArray(resumeState.taskQueue)) taskQueue = resumeState.taskQueue;
        lastAgentHistory = actionHistory;
        sendLogToPanel(`Resumed at step ${startStep + 1} with ${actionHistory.length} prior actions.`, 'info');
    }

    try { // ── OUTER TRY: guarantees AGENT_DONE fires even on unhandled crash ──
        for (let step = startStep; step < maxSteps && isRunning; step++) {
            try { // ── PER-STEP TRY-CATCH: prevents silent crashes ──
                const stepStartTime = Date.now();
                sendLogToPanel(`--- Step ${step + 1} ---`, 'step');

                // Durable snapshot at each step boundary (survives SW restarts).
                persistRunState({
                    step,
                    currentPlanStepIndex,
                    actionHistory,
                    clickedSelectors,
                    toggledOptions,
                    actionRetryCount,
                    lastActionKey,
                    failedActionCount,
                    quickFillState,
                    apiCallCounts,
                    lastPageUrl,
                    taskQueue
                }, true);

                // Task queue: mark the current step's task as executing.
                if (AGENT_CONFIG.taskQueue) taskTransition(taskQueue, currentPlanStepIndex, 'executing');

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
                // IMPORTANT: After API timeouts, skip vision to reduce payload size
                let observeResult = null;
                let useVision = apiTimeoutCount === 0 && shouldUseVision(step, failedActionCount, lastActionFailed, actionHistory, lastPageUrl);

                // Get current tab URL
                let currentTabUrl = '';
                try {
                    const tabInfo = await new Promise(resolve => chrome.tabs.get(currentTabId, resolve));
                    currentTabUrl = tabInfo?.url || '';
                } catch (e) { }

                // Track page changes for vision triggering
                const pageChanged = currentTabUrl !== lastPageUrl && lastPageUrl !== '';
                if (currentTabUrl) lastPageUrl = currentTabUrl;

                // Also trigger vision on page navigation (but NOT if we're retrying after API timeout)
                if (pageChanged && apiTimeoutCount === 0) useVision = true;

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
                    // Cross-frame: aggregate elements from all iframes when present;
                    // falls back to the main frame when there is only one frame.
                    observeResult = AGENT_CONFIG.crossFrame ? await observeAllFrames(currentTabId) : null;
                    if (observeResult && observeResult.multiFrame) {
                        sendLogToPanel(`Observed ${observeResult.elements.length} elements across ${observeResult.frameCount} frames`, 'info');
                    } else {
                        observeResult = await executeContentScript(currentTabId, 'OBSERVE');
                    }
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
                // Fix: Properly limit to a maximum of 60 elements to prevent API timeouts
                const MAX_ELEMENTS = 60;
                const sliceCount = Math.min(observeResult.elements.length, MAX_ELEMENTS);

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
                    // Quick Fill state
                    quickFillState: quickFillState,
                    // Validation errors with field context when available
                    validationErrors: observeResult.validationErrors || [],
                    // Enhancement 1: Plan-aware execution
                    planSteps: planSteps,
                    currentPlanStepIndex: currentPlanStepIndex,
                    agentMode: isAgentMode
                };

                // 4. Ask the backend brain (AI) for the next action
                let aiDecision;
                try {
                    sendLogToPanel('Thinking... (waiting for AI response)', 'info');
                    const controller = new AbortController();
                    const aiTimeoutMs = AGENT_CONFIG.aiTimeoutMs || 45000; // configurable (was hard-coded 90s)
                    const apiTimeout = setTimeout(() => controller.abort(), aiTimeoutMs);
                    const response = await fetch(API_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                        body: JSON.stringify(statePayload),
                        signal: controller.signal
                    });
                    clearTimeout(apiTimeout);
                    apiTimeoutCount = 0; // Reset timeout counter on successful response

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
                        apiTimeoutCount++;
                        sendLogToPanel(`AI API timed out after ${Math.round((AGENT_CONFIG.aiTimeoutMs || 45000) / 1000)}s. Retry ${apiTimeoutCount}/${maxApiTimeouts}...`, 'error');
                        // API timeouts are infrastructure issues — use separate counter
                        // Only count toward main failure counter if we've exhausted timeout retries
                        if (apiTimeoutCount >= maxApiTimeouts) {
                            failedActionCount = maxFailedActions; // Force stop
                            sendLogToPanel(`AI API timed out ${maxApiTimeouts} times. Stopping agent.`, 'error');
                        }
                        actionHistory.push({ step: step + 1, action: 'api_timeout', error: 'API call timed out', actionSuccess: false });

                        // SMART RETRY: After first timeout, strip the image from the payload
                        // to reduce processing time. The AI can still work with DOM elements alone.
                        if (observeResult && observeResult.image && apiTimeoutCount >= 1) {
                            observeResult.image = null;
                            sendLogToPanel('Stripped image from payload for faster retry (DOM-only mode)', 'info');
                        }
                        continue;
                    }
                    sendLogToPanel(`Error connecting to brain API: ${error.message}`, 'error');
                    break;
                }

                // Consume post-popup directive (one-shot)
                postPopupDirective = '';

                // ── CONVERSATIONAL MESSAGE DISPLAY ──
                // Always surface the agent's conversational message to the user
                if (aiDecision.conversational_message) {
                    sendLogToPanel(`🗣️ ${aiDecision.conversational_message}`, 'info');
                    // Also send as a dedicated conversational message to the panel
                    chrome.runtime.sendMessage({
                        type: 'CONVERSATIONAL_MESSAGE',
                        conversational_message: aiDecision.conversational_message,
                        action: aiDecision.action,
                        status: aiDecision.status || 'executing'
                    }).catch(() => { });
                }

                sendLogToPanel(`AI thought: ${aiDecision.thought}`, 'info');
                sendLogToPanel(`AI decided: ${aiDecision.action} on ${aiDecision.selector || ''}`, 'decision');

                // Enhancement 1: Plan step tracking
                if (aiDecision.planStepCompleted && currentPlanStepIndex < planSteps.length) {
                    if (AGENT_CONFIG.taskQueue) taskTransition(taskQueue, currentPlanStepIndex, 'complete');
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

                // 6. Handle CALL_API — Autonomous back-office API call with human-input fallback
                if (aiDecision.action === 'call_api') {
                    const apiEndpoint = aiDecision.api_endpoint || aiDecision.endpoint || '';
                    const apiMethod = (aiDecision.api_method || aiDecision.method || 'GET').toUpperCase();
                    const apiParams = aiDecision.api_params || aiDecision.params || {};

                    if (!apiEndpoint) {
                        sendLogToPanel('Back-office API call skipped: no endpoint provided.', 'error');
                        historyEntry.actionSuccess = false;
                        historyEntry.error = 'Missing API endpoint';
                        postPopupDirective = 'CALL_API FAILED: No endpoint was provided. Either retry with a valid catalog endpoint or use `ask_user` to request the missing values from the human.';
                        failedActionCount++;
                        lastActionFailed = true;
                        lastActionError = 'Missing API endpoint';
                        actionHistory.push(historyEntry);
                        continue;
                    }

                    // Track repeated calls to the same endpoint (prevents infinite API loops).
                    apiCallCounts[apiEndpoint] = (apiCallCounts[apiEndpoint] || 0) + 1;
                    sendLogToPanel(`🔍 Calling back-office API: ${apiEndpoint}`, 'decision');

                    // Autonomous execution — the agent calls the API on its own (no manual approval).
                    let apiResult = null;
                    try {
                        const apiResponse = await fetch(CALL_API_URL, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                            body: JSON.stringify({ method: apiMethod, endpoint: apiEndpoint, params: apiParams })
                        });
                        apiResult = await apiResponse.json();
                    } catch (e) {
                        apiResult = { success: false, error: e.message };
                    }

                    // Did the API actually return usable details (not just a 200 with empty data)?
                    const apiData = apiResult ? (apiResult.data ?? apiResult) : null;
                    const hasUsefulData = !!(apiResult && apiResult.success && apiData &&
                        !(Array.isArray(apiData) && apiData.length === 0) &&
                        !(typeof apiData === 'object' && !Array.isArray(apiData) && Object.keys(apiData).length === 0));

                    if (hasUsefulData) {
                        consecutiveApiFailures = 0;
                        historyEntry.actionSuccess = true;
                        historyEntry.apiResult = apiData;
                        historyEntry.apiEndpoint = apiEndpoint;
                        historyEntry.apiParams = apiParams;
                        historyEntry.apiRowCount = apiResult.rowCount || 0;

                        postPopupDirective = 'BACK-OFFICE API SUCCESS:\n'
                            + JSON.stringify(apiData, null, 2)
                            + '\nApply this data to the matching form fields now. Target the correct field type (combobox vs text). Do NOT call the same endpoint again.';

                        failedActionCount = 0;
                        lastActionFailed = false;
                        lastActionError = '';
                    } else {
                        consecutiveApiFailures++;
                        const apiError = (apiResult && apiResult.error) || 'API returned no usable data';
                        sendLogToPanel(`🔍 Back-office API could not provide the details (${apiError}).`, 'error');
                        historyEntry.actionSuccess = false;
                        historyEntry.apiEndpoint = apiEndpoint;
                        historyEntry.apiParams = apiParams;
                        historyEntry.error = apiError;

                        // Human-input fallback: after repeated failures or repeated calls to the
                        // same endpoint, STOP guessing and ask the human for the exact values.
                        if (consecutiveApiFailures >= 2 || apiCallCounts[apiEndpoint] >= 3) {
                            postPopupDirective = `BACK-OFFICE API CANNOT PROVIDE THE DETAILS (failed ${consecutiveApiFailures}x). `
                                + `Do NOT call_api again for this. Your NEXT action MUST be "ask_user": clearly list the exact `
                                + `missing values you still need (e.g., Procedure/CPT code, State, Insurance Payer, Panel Group, DOB) `
                                + `and ask the human to provide them.`;
                        } else {
                            postPopupDirective = `BACK-OFFICE API FAILED: ${apiError}. `
                                + `Try ONE different catalog endpoint if clearly relevant; otherwise use "ask_user" to get the values from the human.`;
                        }

                        lastActionFailed = true;
                        lastActionError = apiError;
                    }

                    actionHistory.push(historyEntry);
                    continue;
                }

                // 6-HITL. Handle ASK_USER — Human-in-the-Loop Pause
                if (aiDecision.action === 'ask_user') {
                    if (AGENT_CONFIG.taskQueue) taskTransition(taskQueue, currentPlanStepIndex, 'needs_user');
                    sendLogToPanel(`AI asks: ${aiDecision.conversational_message}`, 'warn');
                    sendLogToPanel(`⏸️ Agent paused — waiting indefinitely for human input...`, 'warn');

                    // Pause the loop indefinitely and wait for user response from the UI panel
                    const keepAliveInterval = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
                    const userChoice = await new Promise(resolve => {
                        const listener = (msg) => {
                            // FIX: Must match the exact string sent by panel.js
                            if (msg.type === 'HITL_RESPONSE') {
                                chrome.runtime.onMessage.removeListener(listener);
                                resolve(msg.payload);
                            }
                        };
                        chrome.runtime.onMessage.addListener(listener);

                        // Command panel to display the chat UI and buttons
                        chrome.runtime.sendMessage({
                            type: 'SHOW_HITL_UI', // FIX: Must match the exact string expected by panel.js
                            payload: {
                                message: aiDecision.conversational_message,
                                ask_user_prompt: aiDecision.ask_user_prompt
                            }
                        }).catch(() => { });
                    });
                    clearInterval(keepAliveInterval);

                    // Resume loop with the human's response
                    historyEntry.actionSuccess = true;
                    historyEntry.userReply = userChoice.reply;
                    sendLogToPanel(`👤 Human replied: ${userChoice.reply}`, 'success');

                    postPopupDirective = `HUMAN RESPONSE TO YOUR QUESTION: "${userChoice.reply}". `
                        + `If the human provided data manually, use 'batch_fill' or 'type' to enter it into the form.`;

                    actionHistory.push(historyEntry);
                    continue;
                }

                // 7a. Reject legacy SQL action — back-office API is the supported data source
                if (aiDecision.action === 'query_database') {
                    sendLogToPanel('Legacy SQL action rejected; use call_api with the back-office API catalog.', 'error');
                    historyEntry.actionSuccess = false;
                    historyEntry.error = 'Legacy SQL action rejected';
                    postPopupDirective = 'LEGACY SQL ACTION REJECTED: This workflow now uses the back-office REST API. Retry with `call_api` using an endpoint from the catalog.';
                    failedActionCount++;
                    lastActionFailed = true;
                    lastActionError = 'Legacy SQL action rejected';
                    actionHistory.push(historyEntry);
                    continue;
                }

                // 7b. Handle FINISH
                if (aiDecision.action === 'finish') {
                    if (AGENT_CONFIG.taskQueue) taskTransition(taskQueue, currentPlanStepIndex, 'complete');
                    sendLogToPanel(`Agent finished: ${aiDecision.summary}`, 'decision');
                    actionHistory.push(historyEntry);
                    break;
                }

                // 7c. Handle ACTION_SEQUENCE (Gap B: Multi-Action Chaining)
                if (aiDecision.action === 'action_sequence' && aiDecision.actions && aiDecision.actions.length > 0) {
                    sendLogToPanel(`Action sequence (${aiDecision.actions.length} actions)...`, 'info');
                    let seqSuccess = 0;
                    const seqResults = [];
                    for (const subAction of aiDecision.actions.slice(0, 5)) {
                        // Guard: skip sub-actions with missing selectors (except navigate/extract/scroll)
                        const selectorOptional = ['navigate', 'extract', 'scroll_down', 'scroll_up', 'keyboard_event'];
                        if (!subAction.selector && !subAction.field && !selectorOptional.includes(subAction.action)) {
                            seqResults.push({ action: subAction.action, selector: null, success: false, error: 'Missing selector' });
                            sendLogToPanel(`Sequence step skipped: ${subAction.action} has no selector`, 'warn');
                            break;
                        }
                        const subResult = await executeContentScript(currentTabId, 'EXECUTE_ACTION', subAction);
                        if (subResult && subResult.success) {
                            seqSuccess++;
                            if (subAction.selector) clickedSelectors.push(subAction.selector);
                            seqResults.push({ action: subAction.action, selector: subAction.selector, success: true, extraData: subResult });
                        } else {
                            seqResults.push({ action: subAction.action, selector: subAction.selector, success: false, error: subResult?.error });
                            sendLogToPanel(`Sequence step failed: ${subAction.action} on ${subAction.selector}`, 'warn');
                            break;
                        }
                        // ═══ FIX: Dynamic wait between sequence actions ═══
                        // Combobox/dropdown interactions need much more time because the content
                        // script now performs the full cycle: open → type → wait → click option → wait for close.
                        // Using a short 200ms wait caused cross-contamination between dropdowns.
                        const isDropdownAction = ['type', 'select_option'].includes(subAction.action) &&
                            (subResult?.isComboboxTrigger || subResult?.isCombobox || subResult?.autoSelectedDropdown);
                        const interActionDelay = isDropdownAction ? 800 : 300;
                        await sleep(interActionDelay);
                        // Additionally wait for page stability after dropdown actions
                        if (isDropdownAction) {
                            await waitForStability(currentTabId, 1000);
                        }
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

                // 7d. Handle BATCH_FILL — fill multiple form fields in one step
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

                    // Route to the element's frame (cross-origin iframe support); default main frame.
                    const actionFrameId = resolveActionFrameId(aiDecision, lastObservedElements);
                    actionResult = await executeContentScript(currentTabId, 'EXECUTE_ACTION', aiDecision, null, actionFrameId);

                    // Phase 2: verify the action locally and recover deterministically
                    // BEFORE spending another LLM round-trip on a silent failure.
                    if (actionResult && actionResult.success && AGENT_CONFIG.localVerify) {
                        const verification = await verifyActionLocally(currentTabId, aiDecision, actionFrameId);
                        if (verification && verification.verified === false) {
                            sendLogToPanel(`Verify: not confirmed (${verification.reason || 'no post-condition'}) — local recovery...`, 'warn');
                            const recovered = await attemptLocalRecovery(currentTabId, aiDecision, actionFrameId);
                            if (recovered && recovered.success) {
                                const reVerify = await verifyActionLocally(currentTabId, aiDecision, actionFrameId);
                                actionResult = recovered;
                                actionResult.verified = !(reVerify && reVerify.verified === false);
                                actionResult.recovered = true;
                                sendLogToPanel(`Local recovery ${actionResult.verified ? 'succeeded' : 'attempted (unconfirmed)'}.`, actionResult.verified ? 'success' : 'warn');
                            } else {
                                actionResult.success = false;
                                actionResult.verified = false;
                                actionResult.error = verification.reason || 'Action not verified';
                            }
                        } else if (verification) {
                            actionResult.verified = verification.verified !== false;
                        }
                    }

                    // Last-resort CDP coordinate click for unreachable/obscured targets
                    // (guarded by AGENT_CONFIG.cdpEnabled; default off).
                    if (AGENT_CONFIG.cdpEnabled && aiDecision.action === 'click' && actionResult && actionResult.success === false) {
                        const matchEl = lastObservedElements.find(e => e && e.selector === aiDecision.selector);
                        if (matchEl && matchEl.boundingBox) {
                            sendLogToPanel('Attempting CDP coordinate-click fallback...', 'warn');
                            const cdpRes = await cdpClickElementFallback(currentTabId, matchEl.boundingBox);
                            if (cdpRes.success) { actionResult.success = true; actionResult.cdpFallback = true; }
                        }
                    }
                    sendLogToPanel(`Action result: ${JSON.stringify(actionResult)}`, 'info');

                    if (actionResult) {
                        actionSuccess = actionResult.success;

                        if (isTextMatchFailure(aiDecision, actionResult)) {
                            actionSuccess = false;
                            actionResult.error = `Text match failed for "${actionResult.searchedFor || aiDecision.text_match || ''}". Do not treat this as a successful click.`;
                            postPopupDirective = `TEXT MATCH FAILED: The previous click did not actually match "${actionResult.searchedFor || aiDecision.text_match || ''}". Retry with the exact visible option or field. Do NOT continue as if the click succeeded.`;
                        }

                        const quickFillDirective = updateQuickFillState(quickFillState, aiDecision, actionResult, currentTabUrl, lastObservedElements);
                        if (quickFillDirective && !postPopupDirective) {
                            postPopupDirective = quickFillDirective;
                        }

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

                            // ── POST-SAVE EXCEPTION HANDLING ──
                            // Detect clicks on Save/Submit buttons and check for new validation errors
                            const isSaveClick = clickedText.includes('save') || clickedText.includes('submit')
                                || clickedText.includes('update') || clickedText.includes('confirm');
                            if (isSaveClick) {
                                historyEntry.isSaveAction = true;
                                sendLogToPanel('Save/Submit button clicked — checking for post-save errors...', 'info');

                                // Wait for potential error messages to render
                                await waitForStability(currentTabId, 3000);

                                // Re-observe the page and extract validation errors with nearby field context
                                const postSaveObserve = await executeContentScript(currentTabId, 'OBSERVE');
                                const validationErrors = await executeContentScript(currentTabId, 'GET_VALIDATION_ERRORS', null, 3);
                                const errors = (validationErrors && validationErrors.success ? validationErrors.errors : []) || [];
                                const fallbackErrorElements = postSaveObserve && postSaveObserve.elements ? postSaveObserve.elements.filter(el => {
                                    const text = (el.text || '').toLowerCase();
                                    const cls = (el.className || '').toLowerCase();
                                    const role = (el.role || '').toLowerCase();
                                    return (
                                        text.includes('error') || text.includes('invalid') ||
                                        text.includes('required') || text.includes('must be') ||
                                        text.includes('cannot be') || text.includes('is not valid') ||
                                        cls.includes('error') || cls.includes('invalid') ||
                                        cls.includes('validation') || cls.includes('alert-danger') ||
                                        role === 'alert'
                                    );
                                }) : [];

                                // Draft warning terminal state detection (SUCCESS) — must be checked before standard validation fallbacks
                                const pageText = (postSaveObserve && postSaveObserve.elements
                                    ? postSaveObserve.elements.map(e => [e.text, e.ariaLabel, e.currentValue, e.selectedOptionText].filter(Boolean).join(' ')).join(' ')
                                    : '').toLowerCase();

                                const isDraftWarningTerminal =
                                    pageText.includes('draft claims missing encounter notes') ||
                                    pageText.includes('claim is in draft') ||
                                    pageText.includes('draft claims') && pageText.includes('encounter notes');

                                if (isDraftWarningTerminal) {
                                    historyEntry.actionSuccess = true;
                                    sendLogToPanel('Claim saved as draft (missing encounter note). This is a terminal state.', 'success');

                                    postPopupDirective =
                                        'TERMINAL STATE REACHED: The claim was successfully saved but placed in Draft status due to missing encounter notes. '
                                        + 'DO NOT attempt to open the draft. DO NOT attempt to fix the encounter note. '
                                        + 'Your task is complete. Call "finish" immediately and report that the claim was saved as a draft.';
                                } else if (errors.length > 0 || fallbackErrorElements.length > 0) {
                                    const errorTexts = errors.length > 0
                                        ? errors.map(e => `${e.field || e.fieldIntent || 'Unknown field'}: ${e.text}`).slice(0, 10).join('; ')
                                        : fallbackErrorElements.map(el => el.text || el.ariaLabel || '').filter(t => t.length > 0).slice(0, 10).join('; ');

                                    historyEntry.postSaveErrors = errorTexts;
                                    historyEntry.validationTargets = errors;
                                    sendLogToPanel(`⚠️ Post-save errors detected (${errors.length || fallbackErrorElements.length}): ${errorTexts.slice(0, 200)}`, 'error');

                                    const validationDirective = buildValidationDirective(errors);
                                    postPopupDirective = `POST-SAVE ERROR DETECTED: After clicking Save/Submit, ${errors.length || fallbackErrorElements.length} error(s) appeared on the page: `
                                        + `"${errorTexts.slice(0, 500)}". `
                                        + (validationDirective ? validationDirective + ' ' : '')
                                        + `DO NOT call finish. DO NOT ignore these errors. `
                                        + `You MUST re-enter the conversational loop, summarize these new errors to the user, call the back-office API for missing values, fill the exact failing fields, and save again.`;
                                } else {
                                        // No errors detected — check if page changed (success indicator)
                                        const pageUrlNow = postSaveObserve.url || '';
                                        sendLogToPanel('No post-save errors detected. Save may have succeeded.', 'success');
                                        postPopupDirective = `SAVE CLICKED SUCCESSFULLY: No visible error messages after saving. `
                                            + `Verify: (1) Did a success toast/message appear? (2) Did the modal close? (3) Did the URL change? `
                                            + `If confirmed successful, call finish with a summary. If unsure, observe one more turn.`;
                                    }
                                }
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
                                + `Use field-intent targeting: Procedure/CPT must target the field labeled Procedure/CPT/HCPCS, not Diagnosis Pointer. `
                                + `If "No options found" appears in Diagnosis Pointer, do not treat it as a Procedure failure unless the Procedure field itself is empty. `
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
                + `If this is Procedure/CPT, first verify the Procedure field is the active field before blaming the CPT code. `
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
        // Run completed/stopped normally → not resumable. (If the worker is killed
        // mid-run this finally never executes, so the snapshot survives for resume.)
        clearRunState();
        // Reset human-in-the-loop state
        if (humanResponseResolver) {
            humanResponseResolver('stop');
            humanResponseResolver = null;
        }
        isAwaitingHuman = false;
        lastAskUserContext = null;
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

// ─── QUICK FILL STATE HELPERS ───────────────────────────────
function isClaimsListUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.pathname === '/claims' || parsed.pathname.endsWith('/claims');
    } catch (e) {
        return false;
    }
}

function hasPatientSelectionEvidence(elements) {
    if (!elements || elements.length === 0) return false;
    const textBlob = elements.map(e => [e.text, e.ariaLabel, e.currentValue, e.selectedOptionText].filter(Boolean).join(' ')).join(' ').toLowerCase();
    return textBlob.includes('save claim') ||
        textBlob.includes('dev, aica') ||
        textBlob.includes('aica, dev') ||
        textBlob.includes('749416') ||
        textBlob.includes('jan 01, 1900') ||
        textBlob.includes('jan 1, 1900');
}

function isPatientSearchType(action, observedElements) {
    if (!action || action.action !== 'type') return false;
    // Field-intent typing into the patient search counts directly.
    if (action.field === 'patient_search') return true;
    const selector = action.selector || '';
    return (observedElements || []).some(el => {
        if (el.selector !== selector) return false;
        const text = [el.text, el.ariaLabel, el.currentValue, el.selectedOptionText].filter(Boolean).join(' ').toLowerCase();
        return text.includes('search patient') || text.includes('patient search') || text.includes('quick fill') || text.includes('search name');
    });
}

function updateQuickFillState(quickFillState, aiDecision, actionResult, currentTabUrl, observedElements) {
    const action = aiDecision || {};
    const result = actionResult || {};
    // The click result may expose the clicked label as clickedText OR matchedText (semantic
    // click); fall back to what the AI asked to click. This is what lets us reliably detect
    // repeated "New Professional Claim" clicks and block the restart loop.
    const clickedText = (result.clickedText || result.matchedText || action.text_match || action.text || action.option || '').toLowerCase();

    if (action.action === 'click' && clickedText.includes('new professional claim')) {
        quickFillState.active = true;
        quickFillState.restartCount++;
        // The claim form is a MODAL on /claims, so the URL never changes — block any repeat
        // open. The first click opens the form; a second means the agent is wrongly restarting.
        if (quickFillState.restartCount > 1) {
            return 'QUICK FILL RESTART BLOCKED: You already opened a New Professional Claim form. Do NOT click "New Professional Claim" again. The patient search and the claim form are on the SAME page — if the form looks closed, the patient option selection just needs to be re-done. Continue the current form and click the exact patient option from the open dropdown.';
        }
    }

    const typedPatientSearch = isPatientSearchType(action, observedElements) ||
        (action.action === 'type' && result.resolvedFieldIntent && result.resolvedFieldIntent.field === 'patient_search');
    if (typedPatientSearch) {
        quickFillState.active = true;
        quickFillState.searched = true;
        quickFillState.lastSearch = action.text || quickFillState.lastSearch;
    }

    if (result.quickFillOptionMatched === true) {
        quickFillState.active = true;
        quickFillState.optionClicked = true;
        quickFillState.selected = true;
        quickFillState.patientName = result.quickFillOptionText || quickFillState.patientName;
    }

    if (quickFillState.active && quickFillState.searched && !quickFillState.optionClicked && isClaimsListUrl(currentTabUrl)) {
        return 'QUICK FILL SELECTION REQUIRED: The patient dropdown opened after typing, but no exact patient option was selected. Do NOT click "New Professional Claim" again. Click the visible option that matches the patient name before continuing.';
    }

    if (quickFillState.active && quickFillState.optionClicked && !hasPatientSelectionEvidence(observedElements) && isClaimsListUrl(currentTabUrl)) {
        return 'QUICK FILL DID NOT OPEN FORM: You clicked a patient option, but the page is still the Claims list and no patient/form evidence appeared. Do NOT restart from the Claims list. Re-open the current form if available, then select the exact patient option again.';
    }

    return '';
}

function buildValidationDirective(errors) {
    if (!errors || errors.length === 0) return '';
    const lines = errors.slice(0, 10).map((err, i) => {
        const field = err.field || err.fieldIntent || 'Unknown field';
        const selector = err.selector ? ` Selector: ${err.selector}` : '';
        const type = err.isCombobox ? ' combobox/searchable dropdown' : (err.type ? ` ${err.type}` : '');
        return `${i + 1}. ${field}${type} is required/invalid: "${err.text}".${selector}`;
    });
    return 'VALIDATION TARGETS DETECTED: ' + lines.join(' ') + ' Fill these exact fields using field-intent targeting. Do NOT scroll randomly. Do NOT confuse Procedure/CPT with Diagnosis Pointer.';
}

function isTextMatchFailure(action, result) {
    if (!result || !result.textMatchFailed) return false;
    return action && (action.action === 'click' || action.action === 'select_option');
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
