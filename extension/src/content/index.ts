import { buildDomTree } from './buildDomTree';

console.log('HyperFlow content script loaded.');

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_DOM_TREE') {
    const { tree, interactables } = buildDomTree();
    // In a real scenario, we might store `interactables` globally in the content script
    // to map IDs for execution.
    (window as any).__hyperflow_interactables = interactables;
    
    sendResponse({ tree });
  } else if (message.type === 'EXECUTE_ACTION') {
    // TODO: Phase 4 - Execution Engine
  }
});
