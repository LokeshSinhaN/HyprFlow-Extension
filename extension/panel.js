document.addEventListener('DOMContentLoaded', () => {
    const runBtn = document.getElementById('runBtn');
    const generateBtn = document.getElementById('generateBtn');
    const stopBtn = document.getElementById('stopBtn');
    const promptInput = document.getElementById('promptInput');
    const logsDiv = document.getElementById('logs');
    const statusBar = document.getElementById('statusBar');
    const statusText = document.getElementById('statusText');

    // Code banner elements
    const codeBanner = document.getElementById('codeBanner');
    const codeBannerHeader = document.getElementById('codeBannerHeader');
    const codeBannerArrow = document.getElementById('codeBannerArrow');
    const codeBannerBody = document.getElementById('codeBannerBody');
    const codeContent = document.getElementById('codeContent');
    const copyCodeBtn = document.getElementById('copyCodeBtn');

    let isFirstLog = true;
    let isCodeBannerCollapsed = false;

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

    function setRunning(running) {
        runBtn.disabled = running;
        stopBtn.style.display = running ? 'block' : 'none';
        statusBar.classList.toggle('active', running);
        if (running) {
            statusText.textContent = 'Agent is running...';
            // Disable generate while running
            generateBtn.disabled = true;
        }
    }

    // ─── CODE BANNER: toggle collapse/expand ────────────────────
    codeBannerHeader.addEventListener('click', () => {
        isCodeBannerCollapsed = !isCodeBannerCollapsed;
        codeBannerBody.classList.toggle('collapsed', isCodeBannerCollapsed);
        codeBannerArrow.classList.toggle('collapsed', isCodeBannerCollapsed);
    });

    // ─── CODE BANNER: copy to clipboard ─────────────────────────
    copyCodeBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // don't toggle the banner
        const code = codeContent.textContent;
        if (!code) return;
        navigator.clipboard.writeText(code).then(() => {
            const origText = copyCodeBtn.textContent;
            copyCodeBtn.textContent = '\u2705 Copied!';
            setTimeout(() => { copyCodeBtn.textContent = origText; }, 1500);
        }).catch(() => {
            // Fallback for non-HTTPS contexts
            const ta = document.createElement('textarea');
            ta.value = code;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            copyCodeBtn.textContent = '\u2705 Copied!';
            setTimeout(() => { copyCodeBtn.textContent = '\ud83d\udccb Copy'; }, 1500);
        });
    });

    function showCodeBanner(code) {
        codeContent.textContent = code;
        codeBanner.classList.add('visible');
        // Expand if collapsed
        isCodeBannerCollapsed = false;
        codeBannerBody.classList.remove('collapsed');
        codeBannerArrow.classList.remove('collapsed');
    }

    function hideCodeBanner() {
        codeBanner.classList.remove('visible');
        codeContent.textContent = '';
    }

    // ─── Listen for messages from background.js ─────────────────
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'LOG') {
            appendLog(message.text, message.level);
        }
        if (message.type === 'AGENT_DONE') {
            setRunning(false);
            appendLog('\u2705 Agent completed.', 'success');
            // Enable Generate Code button once agent run finishes (whether success or not)
            if (message.hasHistory) {
                generateBtn.disabled = false;
            }
        }
    });

    // ─── RUN AGENT ──────────────────────────────────────────────
    runBtn.addEventListener('click', () => {
        const prompt = promptInput.value.trim();
        if (!prompt) {
            appendLog("Please enter a task.", "error");
            return;
        }

        // Reset state for new run
        logsDiv.innerHTML = '';
        isFirstLog = false;
        hideCodeBanner();
        generateBtn.disabled = true;
        appendLog("Starting agent...", "info");
        setRunning(true);

        chrome.runtime.sendMessage({
            type: 'START_AGENT',
            payload: { prompt: prompt }
        }, (response) => {
            if (chrome.runtime.lastError) {
                appendLog("Error: " + chrome.runtime.lastError.message, "error");
                setRunning(false);
            } else if (response && response.status === 'started') {
                appendLog("Agent running in background...", "info");
            } else if (response && response.status === 'already_running') {
                appendLog("Agent is already running.", "error");
            } else {
                appendLog("Agent failed to start.", "error");
                setRunning(false);
            }
        });
    });

    // ─── STOP AGENT ─────────────────────────────────────────────
    stopBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'STOP_AGENT' }, (response) => {
            if (response && response.status === 'stopped') {
                appendLog("\u23f9 Agent stopped by user.", "error");
                setRunning(false);
                // Still enable generate — partial history is usable
                generateBtn.disabled = false;
            }
        });
    });

    // ─── GENERATE SELENIUM CODE ─────────────────────────────────
    generateBtn.addEventListener('click', () => {
        generateBtn.disabled = true;
        generateBtn.textContent = '\u23f3 Generating...';
        appendLog(' Requesting Selenium code generation...', 'info');

        chrome.runtime.sendMessage({ type: 'GENERATE_SELENIUM' }, (response) => {
            generateBtn.textContent = '\u26a1 Generate Code';
            generateBtn.disabled = false;

            if (chrome.runtime.lastError) {
                appendLog('\u274c Generation error: ' + chrome.runtime.lastError.message, 'error');
                return;
            }

            if (response && response.success && response.code) {
                showCodeBanner(response.code);
                appendLog('\u2705 Selenium code ready — see banner above logs.', 'success');
            } else {
                const msg = (response && response.message) || 'Unknown error';
                appendLog('\u274c Code generation failed: ' + msg, 'error');
            }
        });
    });
});
