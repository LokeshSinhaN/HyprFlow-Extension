document.addEventListener('DOMContentLoaded', () => {
    const runBtn = document.getElementById('runBtn');
    const generateBtn = document.getElementById('generateBtn');
    const stopBtn = document.getElementById('stopBtn');
    const promptInput = document.getElementById('promptInput');
    const logsDiv = document.getElementById('logs');
    const statusBar = document.getElementById('statusBar');
    const statusText = document.getElementById('statusText');

    const collapseAllBtn = document.getElementById('collapseAllBtn');
    const expandAllBtn = document.getElementById('expandAllBtn');

    const planApprovalContainer = document.getElementById('planApprovalContainer');
    const approvePlanBtn = document.getElementById('approvePlanBtn');
    const rejectPlanBtn = document.getElementById('rejectPlanBtn');

    const codeBanner = document.getElementById('codeBanner');
    const codeBannerHeader = document.getElementById('codeBannerHeader');
    const codeBannerArrow = document.getElementById('codeBannerArrow');
    const codeBannerBody = document.getElementById('codeBannerBody');
    const codeContent = document.getElementById('codeContent');
    const copyCodeBtn = document.getElementById('copyCodeBtn');

    // ── STATE ──
    let agentRunning = false;
    let currentStepNumber = 0;
    let steps = [];           // Array of { number, status, element, logs, summary }
    let isCompactMode = true; // Default: collapsed completed steps

    // ── WATCHDOG ──
    let lastLogTimestamp = 0;
    let agentStartTime = 0;
    let watchdogInterval = null;
    const STALL_THRESHOLD_MS = 30000;
    const WARN_THRESHOLD_MS = 15000;

    // ── STEP TRACKING ──
    function startStep(stepNum) {
        // Complete previous step with inferred status
        const prevStep = steps.find(s => s.number === currentStepNumber && s.status === 'running');
        if (prevStep) {
            completeStep(prevStep);
        }

        currentStepNumber = stepNum;
        const stepData = {
            number: stepNum,
            status: 'running',
            element: null,
            logs: [],
            summaryAction: ''
        };
        steps.push(stepData);
        renderStep(stepData);
        ensureCurrentStepExpanded();
        // Scroll to show new step
        logsDiv.scrollTop = logsDiv.scrollHeight;
        lastLogTimestamp = Date.now();
    }

    function appendToCurrentStep(message, level = 'info') {
        const step = steps.find(s => s.number === currentStepNumber);
        if (!step) return;

        step.logs.push({ message, level, time: Date.now() });
        updateStepDetails(step);

        // Extract action from "AI decided:" lines for summary
        const decidedMatch = message.match(/^AI decided:\s*(.+?)\s*$/i);
        if (decidedMatch) {
            step.summaryAction = decidedMatch[1];
            renderStep(step);
        }

        lastLogTimestamp = Date.now();

        // Auto-scroll to bottom
        logsDiv.scrollTop = logsDiv.scrollHeight;
    }

    function determineStepStatus(step) {
        if (!step || !step.logs.length) return 'success';
        if (step.logs.some(l => l.level === 'error')) return 'failed';
        if (step.logs.some(l => l.level === 'warn' || l.level === 'warning')) return 'warning';
        return 'success';
    }

    function completeStep(step, status = null, summaryAction = '') {
        if (!step) return;
        step.status = status || determineStepStatus(step);
        if (summaryAction) step.summaryAction = summaryAction;
        renderStep(step);
        // Auto-expand failures and warnings regardless of compact mode
        if (step.status === 'failed' || step.status === 'warning') {
            expandStep(step);
        } else if (isCompactMode) {
            collapseStep(step);
        }
    }

    function completeCurrentStep(status = null, summaryAction = '') {
        const step = steps.find(s => s.number === currentStepNumber);
        completeStep(step, status, summaryAction);
    }

    // ── DOM RENDERING ──
    function getOrCreateStepElement(step) {
        let el = document.querySelector(`.step-group[data-step="${step.number}"]`);
        if (!el) {
            el = document.createElement('div');
            el.className = 'step-group';
            el.dataset.step = step.number;
            el.innerHTML = `
                <div class="step-summary" tabindex="0">
                    <span class="step-number">${step.number}</span>
                    <span class="step-action">...</span>
                    <span class="step-status status-pending">●</span>
                </div>
                <div class="step-details">
                    <div class="step-details-inner"></div>
                </div>
            `;
            el.querySelector('.step-summary').addEventListener('click', () => {
                el.classList.toggle('expanded');
            });
            logsDiv.appendChild(el);
        }
        return el;
    }

    function renderStep(step) {
        const el = getOrCreateStepElement(step);
        const summary = el.querySelector('.step-summary');
        const actionSpan = summary.querySelector('.step-action');
        const statusSpan = summary.querySelector('.step-status');

        if (step.status === 'running') {
            el.classList.add('current');
            el.classList.remove('completed', 'failed');
            actionSpan.textContent = step.summaryAction || 'Processing...';
            statusSpan.textContent = 'RUN';
            statusSpan.className = 'step-status status-running';
        } else if (step.status === 'success') {
            el.classList.remove('current');
            el.classList.add('completed');
            actionSpan.textContent = step.summaryAction || 'Completed';
            statusSpan.textContent = 'OK';
            statusSpan.className = 'step-status status-success';
        } else if (step.status === 'failed') {
            el.classList.remove('current');
            el.classList.add('failed');
            actionSpan.textContent = step.summaryAction || 'Failed';
            statusSpan.textContent = 'FAIL';
            statusSpan.className = 'step-status status-failed';
        } else if (step.status === 'warning') {
            el.classList.remove('current');
            el.classList.add('completed');
            actionSpan.textContent = step.summaryAction || 'Warning';
            statusSpan.textContent = 'WARN';
            statusSpan.className = 'step-status status-warning';
        }
    }

    function updateStepDetails(step) {
        const el = document.querySelector(`.step-group[data-step="${step.number}"] .step-details-inner`);
        if (!el) return;

        const logHtml = step.logs.map(l => {
            const levelClass = l.level === 'error' ? 'log-error' :
                               l.level === 'success' ? 'log-success' :
                               l.level === 'decision' ? 'log-decision' :
                               l.level === 'step' ? 'log-step' :
                               l.level === 'info' ? 'log-info' : '';
            return `<div class="log-entry ${levelClass}">${escapeHtml(l.message)}</div>`;
        }).join('');
        el.innerHTML = logHtml;
    }

    function collapseStep(step) {
        const el = document.querySelector(`.step-group[data-step="${step.number}"] .step-details`);
        if (el) el.style.maxHeight = '0px';
    }

    function expandStep(step) {
        const el = document.querySelector(`.step-group[data-step="${step.number}"] .step-details`);
        if (el) el.style.maxHeight = '500px';
    }

    function ensureCurrentStepExpanded() {
        steps.forEach(s => {
            if (s.number === currentStepNumber) expandStep(s);
            else collapseStep(s);
        });
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ── CLEAR UI ──
    function clearLogs() {
        logsDiv.innerHTML = '';
        steps = [];
        currentStepNumber = 0;
        lastLogTimestamp = Date.now();
    }

    // ── APPEND LOG LEGACY (fallback) ──
    let isFirstLog = true;
    function appendLog(message, type = 'info') {
        if (isFirstLog) {
            logsDiv.innerHTML = '';
            isFirstLog = false;
        }
        const div = document.createElement('div');
        div.className = `log-entry log-${type}`;
        div.innerText = message;
        logsDiv.appendChild(div);
        logsDiv.scrollTop = logsDiv.scrollHeight;
    }

    // ── SET RUNNING STATE ──
    function setRunning(running) {
        agentRunning = running;
        runBtn.disabled = running;
        stopBtn.style.display = running ? 'block' : 'none';
        statusBar.classList.toggle('active', running);
        if (running) {
            agentStartTime = Date.now();
            lastLogTimestamp = Date.now();
            currentStepNumber = 0;
            statusText.textContent = 'Agent running...';
            generateBtn.disabled = true;
            startWatchdog();
        } else {
            stopWatchdog();
            statusText.textContent = 'Ready';
        }
    }

    // ── WATCHDOG ──
    function startWatchdog() {
        stopWatchdog();
        watchdogInterval = setInterval(() => {
            if (!agentRunning) {
                stopWatchdog();
                return;
            }

            const sinceLastLog = Date.now() - lastLogTimestamp;
            const totalElapsed = ((Date.now() - agentStartTime) / 1000).toFixed(0);
            const stepNum = currentStepNumber || 0;

            if (sinceLastLog > STALL_THRESHOLD_MS) {
                const stallSec = Math.round(sinceLastLog / 1000);
                statusText.textContent = `No response for ${stallSec}s — agent may be stuck (${totalElapsed}s total, step ${stepNum})`;
                statusBar.style.backgroundColor = '#ff4444';
                if (sinceLastLog < STALL_THRESHOLD_MS + 3000) {
                    appendLog(`Agent has been silent for ${stallSec}s. It may be waiting for AI response or stuck. Try "Stop" if it doesn't respond soon.`, 'error');
                }
            } else if (sinceLastLog > WARN_THRESHOLD_MS) {
                const waitSec = Math.round(sinceLastLog / 1000);
                statusText.textContent = `Working... (${waitSec}s since last update, ${totalElapsed}s total, step ${stepNum})`;
                statusBar.style.backgroundColor = '#ff8800';
            } else {
                statusText.textContent = `Agent running — step ${stepNum} (${totalElapsed}s elapsed)`;
                statusBar.style.backgroundColor = '';
            }
        }, 2000);
    }

    function stopWatchdog() {
        if (watchdogInterval) clearInterval(watchdogInterval);
        watchdogInterval = null;
        statusBar.style.backgroundColor = '';
    }

    // ── CODE BANNER ──
    codeBannerHeader.addEventListener('click', () => {
        codeBannerBody.classList.toggle('collapsed');
        codeBannerArrow.classList.toggle('collapsed');
        codeBannerArrow.textContent = codeBannerBody.classList.contains('collapsed') ? '[+]' : '[-]';
    });

    copyCodeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const code = codeContent.textContent;
        if (!code) return;
        navigator.clipboard.writeText(code).then(() => {
            const orig = copyCodeBtn.textContent;
            copyCodeBtn.textContent = 'Copied!';
            setTimeout(() => copyCodeBtn.textContent = orig, 1500);
        }).catch(() => {
            const ta = document.createElement('textarea');
            ta.value = code;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            copyCodeBtn.textContent = 'Copied!';
            setTimeout(() => copyCodeBtn.textContent = 'Copy', 1500);
        });
    });

    function showCodeBanner(code) {
        codeContent.textContent = code;
        codeBanner.classList.add('visible');
        codeBannerBody.classList.remove('collapsed');
        codeBannerArrow.classList.remove('collapsed');
        codeBannerArrow.textContent = '[-]';
    }

    function hideCodeBanner() {
        codeBanner.classList.remove('visible');
        codeContent.textContent = '';
    }

    // ── MESSAGE HANDLER ──
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'LOG') {
            const stepMatch = message.text.match(/^--- Step (\d+) ---$/);
            if (stepMatch) {
                startStep(parseInt(stepMatch[1]));
            } else {
                // Route to step group if active; otherwise flat log
                if (currentStepNumber > 0 && steps.some(s => s.number === currentStepNumber)) {
                    appendToCurrentStep(message.text, message.level);
                } else {
                    appendLog(message.text, message.level);
                }
            }
            return;
        }

        if (message.type === 'PLAN_GENERATED') {
            stopWatchdog();
            statusText.textContent = 'Waiting for plan approval...';
            stopBtn.style.display = 'none';
            planApprovalContainer.style.display = 'flex';
            if (message.payload?.plan) lastGeneratedPlan = message.payload.plan;
        }

        if (message.type === 'AGENT_DONE') {
            setRunning(false);

            // Complete any running step
            const current = steps.find(s => s.number === currentStepNumber && s.status === 'running');
            if (current) {
                completeStep(current, 'success', 'Finished');
            }

            // Add a completion summary as a new entry
            const totalSteps = steps.length;
            const totalTime = agentStartTime ? ((Date.now() - agentStartTime) / 1000).toFixed(0) + 's' : '';
            const summaryDiv = document.createElement('div');
            summaryDiv.style.cssText = 'margin-top: 12px; padding: 10px; background: #0d1117; border: 1px solid #262626; border-radius: 8px; text-align: center; font-size: 12px; color: #737373;';
            summaryDiv.innerHTML = `<strong>Agent completed</strong> — ${totalSteps} step${totalSteps !== 1 ? 's' : ''} in ${totalTime}`;
            logsDiv.appendChild(summaryDiv);
            logsDiv.scrollTop = logsDiv.scrollHeight;

            if (message.hasHistory) generateBtn.disabled = false;
        }
    });

    // ── RUN AGENT ──
    runBtn.addEventListener('click', () => {
        const prompt = promptInput.value.trim();
        if (!prompt) {
            appendLog('Please enter a task.', 'error');
            return;
        }

        clearLogs();
        hideCodeBanner();
        generateBtn.disabled = true;
        setRunning(true);
        appendLog('Starting agent...', 'info');

        chrome.runtime.sendMessage({
            type: 'START_AGENT',
            payload: { prompt }
        }, (response) => {
            if (chrome.runtime.lastError) {
                appendLog('Error: ' + chrome.runtime.lastError.message, 'error');
                setRunning(false);
            } else if (response?.status === 'started') {
                appendLog('Agent running in background...', 'info');
            } else if (response?.status === 'already_running') {
                appendLog('Agent is already running.', 'error');
                setRunning(false);
            } else {
                appendLog('Agent failed to start.', 'error');
                setRunning(false);
            }
        });
    });

    // ── STOP AGENT ──
    stopBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'STOP_AGENT' }, (response) => {
            if (response?.status === 'stopped') {
                // Mark current step as stopped
                const current = steps.find(s => s.number === currentStepNumber && s.status === 'running');
                if (current) {
                    completeStep(current, 'failed', 'Stopped by user');
                }
                appendLog('Agent stopped by user.', 'error');
                setRunning(false);
                planApprovalContainer.style.display = 'none';
                generateBtn.disabled = false;
            }
        });
    });

    // ── PLAN APPROVAL ──
    let lastGeneratedPlan = [];
    approvePlanBtn.addEventListener('click', () => {
        const prompt = promptInput.value.trim();
        planApprovalContainer.style.display = 'none';
        stopBtn.style.display = 'block';
        statusText.textContent = 'Agent is running...';
        startWatchdog();
        appendLog('Plan approved by user. Executing actions...', 'success');
        chrome.runtime.sendMessage({
            type: 'APPROVE_PLAN',
            payload: { prompt, plan: lastGeneratedPlan }
        });
    });

    rejectPlanBtn.addEventListener('click', () => {
        const prompt = promptInput.value.trim();
        planApprovalContainer.style.display = 'none';
        stopBtn.style.display = 'block';
        statusText.textContent = 'Requesting alternative plan...';
        appendLog('Plan rejected. Requesting alternative workflow...', 'error');
        chrome.runtime.sendMessage({
            type: 'REJECT_PLAN',
            payload: { prompt }
        });
    });

    // ── VIEW TOGGLE ──
    collapseAllBtn.addEventListener('click', () => {
        isCompactMode = true;
        steps.forEach(step => collapseStep(step));
    });

    expandAllBtn.addEventListener('click', () => {
        isCompactMode = false;
        steps.forEach(step => expandStep(step));
    });

    // ── GENERATE CODE ──
    generateBtn.addEventListener('click', () => {
        generateBtn.disabled = true;
        generateBtn.textContent = 'Generating...';
        appendLog('Requesting Selenium code generation...', 'info');

        chrome.runtime.sendMessage({ type: 'GENERATE_SELENIUM' }, (response) => {
            generateBtn.textContent = 'Generate Code';
            generateBtn.disabled = false;

            if (chrome.runtime.lastError) {
                appendLog('Generation error: ' + chrome.runtime.lastError.message, 'error');
                return;
            }

            if (response?.success && response.code) {
                showCodeBanner(response.code);
                appendLog('Selenium code ready — see banner above logs.', 'success');
            } else {
                const msg = response?.message || 'Unknown error';
                appendLog('Code generation failed: ' + msg, 'error');
            }
        });
    });
});
