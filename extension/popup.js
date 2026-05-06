document.addEventListener('DOMContentLoaded', () => {
    const runBtn = document.getElementById('runBtn');
    const promptInput = document.getElementById('promptInput');
    const statusDiv = document.getElementById('status');
  
    runBtn.addEventListener('click', () => {
      const prompt = promptInput.value.trim();
      if (!prompt) {
        statusDiv.innerText = "Please enter a task.";
        statusDiv.style.color = "#f87171";
        return;
      }
  
      statusDiv.innerText = "Starting agent...";
      statusDiv.style.color = "#737373";
      runBtn.disabled = true;
  
      // Send message to background script to start the loop
      chrome.runtime.sendMessage({ 
          type: 'START_AGENT', 
          payload: { prompt: prompt } 
      }, (response) => {
          if (chrome.runtime.lastError) {
              statusDiv.innerText = "Error: " + chrome.runtime.lastError.message;
              statusDiv.style.color = "#f87171";
              runBtn.disabled = false;
          } else if (response && response.status === 'started') {
              statusDiv.innerText = "✓ Agent running — check side panel for logs";
              statusDiv.style.color = "#34d399";
          } else if (response && response.status === 'already_running') {
              statusDiv.innerText = "Agent is already running.";
              statusDiv.style.color = "#fbbf24";
              runBtn.disabled = false;
          }
      });
    });

    // Re-enable button when agent finishes
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'AGENT_DONE') {
            runBtn.disabled = false;
            statusDiv.innerText = "✓ Agent completed.";
            statusDiv.style.color = "#34d399";
        }
    });
});
