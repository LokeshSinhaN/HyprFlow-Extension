chrome.runtime.onInstalled.addListener(() => {
  console.log('HyperFlow Extension Installed');
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'USER_COMMAND') {
    console.log('Received command:', message.payload);
    // TODO: Phase 3 - Orchestrate Multi-Agent logic here
  }
});
