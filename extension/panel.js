document.addEventListener('DOMContentLoaded', () => {
    const runBtn = document.getElementById('runBtn');
    const stopBtn = document.getElementById('stopBtn');
    const promptInput = document.getElementById('promptInput');
    const logsDiv = document.getElementById('logs');
    const statusBar = document.getElementById('statusBar');
    const statusText = document.getElementById('statusText');
    let isFirstLog = true;
  
    function appendLog(message, type = 'info') {
        // Clear empty state on first log
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
        }
    }

    // Listen for logs from background.js
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'LOG') {
            appendLog(message.text, message.level);
        }
        if (message.type === 'AGENT_DONE') {
            setRunning(false);
            appendLog('✅ Agent completed.', 'success');
        }
    });
  
    runBtn.addEventListener('click', () => {
        const prompt = promptInput.value.trim();
        if (!prompt) {
            appendLog("Please enter a task.", "error");
            return;
        }
    
        // Reset logs
        logsDiv.innerHTML = '';
        isFirstLog = false;
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

    stopBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'STOP_AGENT' }, (response) => {
            if (response && response.status === 'stopped') {
                appendLog("⏹ Agent stopped by user.", "error");
                setRunning(false);
            }
        });
    });
});
