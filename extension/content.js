// Hyprflow Extension Content Script — runs in user's webpage context.
// Acts as the "Hands" and "Eyes". Mirrors BrowserService.php intelligence.
// Vision + SoM (Set-of-Mark) implementation for enhanced AI understanding

if (typeof window.hyprflowListenerAdded === 'undefined') {
    window.hyprflowListenerAdded = true;

    // --- Vision Configuration ---
    const VISION_CONFIG = {
        enabled: true,
        maxWidth: 1024,
        quality: 60, // Must be integer (0-100) for Chrome API
        maxElements: 60,
        somEnabled: true
    };

    // --- Window.open Interception ---
    // Monkey-patch window.open to detect when clicks trigger new windows.
    // The background script reads this flag after click actions.
    window.__hyprflow_popupOpened = false;
    window.__hyprflow_popupUrl = '';
    const _originalWindowOpen = window.open;
    window.open = function (...args) {
        window.__hyprflow_popupOpened = true;
        window.__hyprflow_popupUrl = args[0] || '';
        return _originalWindowOpen.apply(this, args);
    };

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

        // ─── OBSERVE ─────────────────────────────────────────────
        if (message.type === 'OBSERVE') {
            const elements = extractClickableElements();
            sendResponse({
                url: window.location.href,
                title: document.title,
                elements: elements
            });
            return true;
        }

        // ─── GET FINGERPRINT (state-change detection) ────────────
        if (message.type === 'GET_FINGERPRINT') {
            try {
                const interactive = document.querySelectorAll('button, a, input, select, textarea');
                const contentSample = (document.body.innerText || '').slice(0, 1000);
                const raw = window.location.href + '|' + document.title + '|' + interactive.length + '|' + contentSample;
                let hash = 0;
                for (let i = 0; i < raw.length; i++) {
                    hash = ((hash << 5) - hash) + raw.charCodeAt(i);
                    hash |= 0;
                }
                sendResponse({
                    url: window.location.href,
                    title: document.title,
                    elementCount: interactive.length,
                    contentHash: hash.toString(16)
                });
            } catch (e) {
                sendResponse({ url: window.location.href, title: '', elementCount: 0, contentHash: '' });
            }
            return true;
        }

        // ─── WAIT FOR STABILITY (MutationObserver + fallback timer) ───────────
        // Uses MutationObserver to detect when DOM stops changing (catches AJAX-loaded
        // content like "Full View" links in tree views). Falls back to timer.
        if (message.type === 'WAIT_FOR_STABILITY') {
            const timeout = (message.payload && message.payload.timeout) || 3000;
            const start = Date.now();
            let settled = false;
            let mutationTimer = null;
            const SETTLE_MS = 400; // consider stable after 400ms of no mutations

            const observer = new MutationObserver(() => {
                // Reset settle timer on every mutation
                if (mutationTimer) clearTimeout(mutationTimer);
                mutationTimer = setTimeout(() => {
                    if (!settled) {
                        settled = true;
                        observer.disconnect();
                        sendResponse({ stable: true, elapsed: Date.now() - start });
                    }
                }, SETTLE_MS);
            });

            observer.observe(document.body, {
                childList: true, subtree: true, attributes: true, characterData: true
            });

            // Start the initial settle timer (for pages with no mutations at all)
            mutationTimer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    observer.disconnect();
                    sendResponse({ stable: true, elapsed: Date.now() - start });
                }
            }, SETTLE_MS);

            // Hard timeout fallback
            setTimeout(() => {
                if (!settled) {
                    settled = true;
                    observer.disconnect();
                    sendResponse({ stable: true, elapsed: Date.now() - start });
                }
            }, timeout);

            return true;
        }

        // ─── CHECK POPUP FLAG ────────────────────────────────────
        if (message.type === 'CHECK_POPUP_FLAG') {
            const opened = window.__hyprflow_popupOpened;
            const url = window.__hyprflow_popupUrl;
            window.__hyprflow_popupOpened = false;
            window.__hyprflow_popupUrl = '';
            sendResponse({ popupOpened: opened, popupUrl: url });
            return true;
        }

        // ─── CAPTURE SCREENSHOT WITH SoM (Set-of-Mark) ──────────
        if (message.type === 'CAPTURE_SOM') {
            const config = message.payload || VISION_CONFIG;
            captureScreenshotWithSoM(config).then(result => {
                sendResponse(result);
            }).catch(err => {
                sendResponse({ error: err.message, success: false });
            });
            return true;
        }

        // ─── EXECUTE ACTION ──────────────────────────────────────
        if (message.type === 'EXECUTE_ACTION') {
            const action = message.payload;

            (async () => {
                let success = false;
                let extraData = {};
                try {
                    const el = action.selector ? document.querySelector(action.selector) : null;
                    if (!el && action.action !== 'navigate' && action.action !== 'extract') {
                        throw new Error(`Selector not found: ${action.selector}`);
                    }

                    if (el) {
                        try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { }
                    }

                    // ── CLICK ──
                    if (action.action === 'click' && el) {
                        // --- INNERMOST-NODE TARGETING ---
                        // When clicking a tree-node wrapper (div/span inside a tree li),
                        // drill down to the actual interactive text element that the
                        // framework (Telerik, jsTree, Kendo) listens on.
                        let clickTarget = el;
                        const isInsideTree = !!el.closest(
                            '[id*="TreeView"], [id*="treeview"], [class*="RadTreeView"], ' +
                            '.jstree, [class*="k-treeview"], [class*="x-tree"]'
                        );
                        if (isInsideTree) {
                            const innerNode = el.querySelector(
                                '.rtIn, .jstree-anchor, .k-in, .x-tree-node-text, ' +
                                'span[class*="rtIn"], a[class*="rtIn"]'
                            );
                            if (innerNode) {
                                clickTarget = innerNode;
                                extraData.resolvedInnerNode = generateCss(innerNode);
                            }
                        }

                        // Smart Hover: if element hidden, hover parent trigger first
                        const style = window.getComputedStyle(clickTarget);
                        const rect = clickTarget.getBoundingClientRect();
                        if (style.visibility === 'hidden' || style.display === 'none' || rect.height === 0 || rect.width === 0) {
                            let parent = clickTarget.parentElement;
                            while (parent && parent !== document.body) {
                                if (parent.tagName === 'LI' || parent.getAttribute('role') === 'menuitem' ||
                                    parent.classList.contains('dropdown') || parent.getAttribute('aria-haspopup')) {
                                    parent.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
                                    parent.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                                    await new Promise(r => setTimeout(r, 500));
                                    extraData.autoHoverSelector = generateCss(parent);
                                    break;
                                }
                                parent = parent.parentElement;
                            }
                        }

                        window.__hyprflow_popupOpened = false;
                        clickTarget.click();
                        clickTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                        clickTarget.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

                        // --- POST-CLICK TREE AJAX WAIT ---
                        // Tree views often load content via AJAX after clicking a node.
                        // Wait up to 3s for DOM mutations (e.g., "Full View" link appearing).
                        if (isInsideTree) {
                            await new Promise((resolve) => {
                                let done = false;
                                let mutTimer = null;
                                const obs = new MutationObserver(() => {
                                    if (mutTimer) clearTimeout(mutTimer);
                                    mutTimer = setTimeout(() => {
                                        if (!done) { done = true; obs.disconnect(); resolve(); }
                                    }, 500);
                                });
                                // Observe the tree container or body for new content
                                const treeContainer = el.closest(
                                    '[id*="TreeView"], [id*="treeview"], [class*="RadTreeView"], .jstree'
                                ) || document.body;
                                obs.observe(treeContainer, { childList: true, subtree: true });
                                // Start initial timer
                                mutTimer = setTimeout(() => {
                                    if (!done) { done = true; obs.disconnect(); resolve(); }
                                }, 500);
                                // Hard timeout
                                setTimeout(() => {
                                    if (!done) { done = true; obs.disconnect(); resolve(); }
                                }, 3000);
                            });
                            extraData.treeAjaxWaited = true;
                        } else {
                            await new Promise(r => setTimeout(r, 300));
                        }

                        if (window.__hyprflow_popupOpened) {
                            extraData.windowOpenDetected = true;
                            extraData.windowOpenUrl = window.__hyprflow_popupUrl;
                            window.__hyprflow_popupOpened = false;
                            window.__hyprflow_popupUrl = '';
                        }
                        success = true;
                    }
                    // ── HOVER ──
                    else if (action.action === 'hover' && el) {
                        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true, view: window }));
                        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
                        el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window }));
                        await new Promise(r => setTimeout(r, 1000));
                        success = true;
                    }
                    // ── TYPE ──
                    else if (action.action === 'type' && el) {
                        el.focus();
                        const inputType = (el.getAttribute('type') || '').toLowerCase();
                        const tag = el.tagName.toLowerCase();

                        if (tag === 'select') {
                            // If AI uses "type" on a select, treat it as select_option
                            const optionText = (action.text || '').trim();
                            const options = Array.from(el.options);
                            const targetOpt = options.find(o =>
                                o.text.trim().toLowerCase() === optionText.toLowerCase() ||
                                o.value.toLowerCase() === optionText.toLowerCase()
                            );
                            if (targetOpt) {
                                setNativeValue(el, targetOpt.value);
                                success = true;
                            }
                        } else if (inputType === 'date') {
                            // SPECIAL: HTML5 date inputs require YYYY-MM-DD format
                            // and need native setter to work with React/Vue/Angular
                            const dateValue = parseDateToISO(action.text);
                            if (dateValue) {
                                setNativeValue(el, dateValue);
                                success = true;
                                extraData.parsedDate = dateValue;
                            } else {
                                // Fallback: try direct assignment
                                setNativeValue(el, action.text);
                                success = true;
                            }
                        } else {
                            // INTELLIGENT TYPE: Multi-strategy with auto-dropdown detection
                            el.focus();

                            // Clear existing value first
                            setNativeValue(el, '');
                            await new Promise(r => setTimeout(r, 50));

                            // Strategy 1: Try native setter
                            setNativeValue(el, action.text);
                            await new Promise(r => setTimeout(r, 100));

                            // Strategy 2: If value didn't persist, use keyboard simulation
                            if (el.value !== action.text) {
                                extraData.fallbackToKeyboard = true;
                                await simulateTyping(el, action.text);
                            }

                            // INTELLIGENT: Wait and check if typing triggered a dropdown/autocomplete
                            await new Promise(r => setTimeout(r, 400));
                            const dropdownResult = await detectAndSelectDropdownOption(el, action.text);
                            if (dropdownResult.found) {
                                extraData.autoSelectedDropdown = true;
                                extraData.selectedDropdownText = dropdownResult.selectedText;
                            }

                            // POST-ACTION VERIFICATION: Check if value actually persisted
                            await new Promise(r => setTimeout(r, 100));
                            const currentVal = el.value;
                            if (currentVal === '' && !dropdownResult.found) {
                                // Value was cleared by framework — try one more time with execCommand
                                extraData.valueCleared = true;
                                await simulateTyping(el, action.text);
                                await new Promise(r => setTimeout(r, 200));
                                // Check for dropdown again after retry
                                const retryDropdown = await detectAndSelectDropdownOption(el, action.text);
                                if (retryDropdown.found) {
                                    extraData.autoSelectedDropdown = true;
                                    extraData.selectedDropdownText = retryDropdown.selectedText;
                                }
                            }

                            success = true;
                            extraData.finalValue = el.value;
                        }
                    }
                    // ── SELECT OPTION ──
                    else if (action.action === 'select_option' && el) {
                        const optionText = (action.option || action.text || '').trim();
                        const unselect = action.unselect || false;
                        let optionSelected = false;

                        if (el.tagName.toLowerCase() === 'select') {
                            const options = Array.from(el.options);
                            // Try exact match first, then partial/case-insensitive
                            let targetOpt = options.find(o =>
                                o.text.trim().toLowerCase() === optionText.toLowerCase() ||
                                o.value.toLowerCase() === optionText.toLowerCase()
                            );
                            // Also try partial match (e.g., "Male" matching "Male (M)")
                            if (!targetOpt) {
                                targetOpt = options.find(o =>
                                    o.text.trim().toLowerCase().includes(optionText.toLowerCase()) ||
                                    optionText.toLowerCase().includes(o.text.trim().toLowerCase())
                                );
                            }
                            if (targetOpt) {
                                if (unselect) { targetOpt.selected = false; }
                                else {
                                    // Use native setter for React/Vue/Angular compatibility
                                    setNativeValue(el, targetOpt.value);
                                }
                                optionSelected = true;
                                extraData.selectedValue = targetOpt.value;
                                extraData.selectedText = targetOpt.text.trim();
                            }
                        }

                        // Fallback: click-based dropdown interaction (custom dropdowns)
                        if (!optionSelected) {
                            el.click();
                            await new Promise(r => setTimeout(r, 500));
                            const regex = new RegExp(optionText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
                            const allElements = Array.from(document.querySelectorAll(
                                '[role="option"], [role="menuitem"], [role="listbox"] > *, ' +
                                '.dropdown-item, .MuiMenuItem-root, .ant-select-item, ' +
                                'li[data-value], li, a, span, label, div[role="option"]'
                            ));
                            for (const optEl of allElements) {
                                const st = window.getComputedStyle(optEl);
                                if (st.display === 'none' || st.visibility === 'hidden') continue;
                                const rect = optEl.getBoundingClientRect();
                                if (rect.width === 0 || rect.height === 0) continue;
                                const txt = (optEl.textContent || '').trim();
                                if (regex.test(txt) && txt.length < 150) {
                                    optEl.scrollIntoView({ block: 'center' });
                                    optEl.click();
                                    optEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                                    optEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                                    optionSelected = true;
                                    extraData.selectedViaClick = true;
                                    extraData.selectedText = txt;
                                    break;
                                }
                            }
                        }

                        success = optionSelected;
                        if (success) {
                            extraData.toggleAction = unselect ? 'unselected' : 'selected';
                            extraData.optionText = optionText;
                        } else {
                            extraData.error = `Option "${optionText}" not found in dropdown`;
                        }
                    }
                    // ── EXTRACT ──
                    else if (action.action === 'extract') {
                        let extractedText = '';
                        const target = action.selector ? document.querySelector(action.selector) : null;
                        if (target) {
                            extractedText = target.innerText || target.textContent || '';
                        } else {
                            extractedText = document.body.innerText || document.body.textContent || '';
                        }
                        success = true;
                        sendResponse({ success: true, extractedText: extractedText.trim().substring(0, 5000), ...extraData });
                        return;
                    }
                    // ── SCROLL ──
                    else if (action.action === 'scroll_down' || action.action === 'scroll_up') {
                        const direction = action.action === 'scroll_down' ? 1 : -1;
                        const scrollTarget = action.selector ? document.querySelector(action.selector) : null;
                        const scrollContainer = scrollTarget ||
                            document.querySelector('[class*="modal"]') ||
                            document.querySelector('[role="dialog"]') ||
                            document.querySelector('[class*="drawer"]') ||
                            document.scrollingElement ||
                            document.documentElement;
                        const scrollAmount = Math.round(scrollContainer.clientHeight * 0.7);
                        scrollContainer.scrollBy({ top: direction * scrollAmount, behavior: 'smooth' });
                        await new Promise(r => setTimeout(r, 500));
                        success = true;
                        extraData.scrolled = direction * scrollAmount;
                        extraData.scrollTarget = scrollContainer.tagName + (scrollContainer.className ? '.' + scrollContainer.className.split(' ')[0] : '');
                    }
                    // ── NAVIGATE ──
                    else if (action.action === 'navigate' && action.url) {
                        window.location.href = action.url;
                        success = true;
                    }
                } catch (e) {
                    console.error("Action failed:", e);
                    extraData.error = e.message;
                }

                sendResponse({ success, ...extraData });
            })();

            return true;
        }
    });

    // ─── SELECTOR GENERATION UTILITIES ─────────────────────────

    function getXPath(el) {
        if (!el || el.nodeType !== 1) return null;
        const parts = [];
        while (el && el.nodeType === 1) {
            let idx = 1;
            let sib = el.previousElementSibling;
            while (sib) { idx++; sib = sib.previousElementSibling; }
            const tag = el.tagName.toLowerCase();
            const part = idx > 1 ? tag + '[' + idx + ']' : tag;
            parts.unshift(part);
            el = el.parentElement;
        }
        return '/' + parts.join('/');
    }

    function escapeCss(str) {
        try { return CSS.escape(str); } catch (e) { return str.replace(/([\\x00-\\x1F\\x7F]|^[0-9])/g, '\\$1'); }
    }

    function generateCss(el) {
        if (el.id) return '#' + escapeCss(el.id);
        if (el.name) {
            const nameSel = el.tagName.toLowerCase() + '[name="' + escapeCss(el.name) + '"]';
            if (document.querySelectorAll(nameSel).length === 1) return nameSel;
        }
        if (el.placeholder) {
            const phSel = el.tagName.toLowerCase() + '[placeholder="' + escapeCss(el.placeholder) + '"]';
            if (document.querySelectorAll(phSel).length === 1) return phSel;
        }
        const path = [];
        let current = el;
        while (current && current.nodeType === 1) {
            let selector = current.tagName.toLowerCase();
            if (current.id) {
                selector = '#' + escapeCss(current.id);
                path.unshift(selector);
                break;
            }
            let sibling = current;
            let nth = 1;
            while (sibling && (sibling = sibling.previousElementSibling)) {
                if (sibling.tagName.toLowerCase() === selector) nth++;
            }
            if (nth > 1) selector += ':nth-of-type(' + nth + ')';
            path.unshift(selector);
            current = current.parentElement;
        }
        return path.join(' > ');
    }

    // ─── HELPER: Set value using native input setter (React/Vue/Angular compatible) ───
    function setNativeValue(el, value) {
        const tag = el.tagName.toLowerCase();
        const inputType = (el.getAttribute('type') || '').toLowerCase();

        // Use Object.getOwnPropertyDescriptor to get the native setter
        // This bypasses React/Vue/Angular's synthetic event system
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
        )?.set;
        const nativeSelectValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLSelectElement.prototype, 'value'
        )?.set;
        const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
        )?.set;

        if (tag === 'select' && nativeSelectValueSetter) {
            nativeSelectValueSetter.call(el, value);
        } else if (tag === 'textarea' && nativeTextareaValueSetter) {
            nativeTextareaValueSetter.call(el, value);
        } else if (nativeInputValueSetter) {
            nativeInputValueSetter.call(el, value);
        } else {
            el.value = value;
        }

        // Dispatch events that React/Vue/Angular listen to
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));

        // For React specifically, also dispatch a native input event
        const nativeEvent = new Event('input', { bubbles: true });
        Object.defineProperty(nativeEvent, 'target', { writable: false, value: el });
        el.dispatchEvent(nativeEvent);

        // For date inputs, also try setting via keyboard simulation as last resort
        if (inputType === 'date' && el.value !== value) {
            try {
                // Some frameworks need the element to be focused first
                el.focus();
                el.setAttribute('value', value);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            } catch (e) { /* ignore */ }
        }
    }

    // ─── HELPER: Parse various date formats to ISO YYYY-MM-DD ───
    function parseDateToISO(dateStr) {
        if (!dateStr) return null;
        const str = dateStr.trim();

        // Already in YYYY-MM-DD format
        if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

        // DD-MM-YYYY or DD/MM/YYYY
        let match = str.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
        if (match) {
            const [, day, month, year] = match;
            return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        }

        // MM-DD-YYYY or MM/DD/YYYY (US format) — try if day > 12
        match = str.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
        if (match) {
            const [, part1, part2, year] = match;
            // If part1 > 12, it must be DD-MM-YYYY
            if (parseInt(part1) > 12) {
                return `${year}-${part2.padStart(2, '0')}-${part1.padStart(2, '0')}`;
            }
            // Default: assume DD-MM-YYYY (most common in non-US)
            return `${year}-${part2.padStart(2, '0')}-${part1.padStart(2, '0')}`;
        }

        // YYYY/MM/DD
        match = str.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
        if (match) {
            const [, year, month, day] = match;
            return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        }

        // Try native Date parsing as last resort
        try {
            const d = new Date(str);
            if (!isNaN(d.getTime())) {
                return d.toISOString().split('T')[0];
            }
        } catch (e) { /* ignore */ }

        return null;
    }

    // ─── HELPER: Detect and select dropdown/autocomplete options after typing ───
    // This makes the agent intelligent enough to handle searchable dropdowns,
    // autocomplete fields, comboboxes, etc. without explicit instructions.
    async function detectAndSelectDropdownOption(inputEl, searchText) {
        const result = { found: false, selectedText: '' };

        // Look for dropdown/autocomplete popups that appeared after typing
        // These are dynamically rendered elements near the input or in portals
        const dropdownSelectors = [
            // Generic dropdown patterns
            '[role="listbox"]', '[role="menu"]', '[role="option"]',
            '.dropdown-menu.show', '.autocomplete-results', '.suggestions',
            // React/Material UI patterns
            '.MuiAutocomplete-popper', '.MuiMenu-list', '.MuiPopover-paper',
            // Ant Design patterns
            '.ant-select-dropdown', '.ant-cascader-dropdown',
            // Custom patterns (common in healthcare/enterprise apps)
            '[class*="dropdown"][class*="open"]', '[class*="dropdown"][class*="show"]',
            '[class*="autocomplete"]', '[class*="suggestion"]', '[class*="results"]',
            '[class*="listbox"]', '[class*="options"]', '[class*="menu"][class*="open"]',
            // Portal-based dropdowns (rendered at body level)
            'body > [class*="dropdown"]', 'body > [class*="popover"]',
            'body > [role="listbox"]', '[data-radix-popper-content-wrapper]',
            // Generic visible list items that appeared
            'ul[style*="display: block"]', 'ul[style*="opacity: 1"]',
            'div[style*="display: block"] li', '.visible[role="option"]'
        ];

        // Wait a moment for dropdown to render
        await new Promise(r => setTimeout(r, 200));

        // Find all potential dropdown containers
        for (const sel of dropdownSelectors) {
            try {
                const containers = document.querySelectorAll(sel);
                for (const container of containers) {
                    const style = window.getComputedStyle(container);
                    if (style.display === 'none' || style.visibility === 'hidden') continue;
                    const rect = container.getBoundingClientRect();
                    if (rect.width === 0 || rect.height === 0) continue;

                    // Look for clickable options inside this container
                    const options = container.querySelectorAll(
                        '[role="option"], li, a, div[class*="option"], div[class*="item"], ' +
                        'span[class*="option"], button, [data-value]'
                    );

                    for (const opt of options) {
                        const optStyle = window.getComputedStyle(opt);
                        if (optStyle.display === 'none' || optStyle.visibility === 'hidden') continue;
                        const optRect = opt.getBoundingClientRect();
                        if (optRect.width === 0 || optRect.height === 0) continue;

                        const optText = (opt.textContent || '').trim();
                        // Match: exact, starts-with, or contains the search text
                        if (optText && (
                            optText.toLowerCase() === searchText.toLowerCase() ||
                            optText.toLowerCase().includes(searchText.toLowerCase()) ||
                            searchText.toLowerCase().includes(optText.toLowerCase())
                        )) {
                            // Found a match — click it
                            opt.scrollIntoView({ block: 'center' });
                            opt.click();
                            opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                            opt.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                            await new Promise(r => setTimeout(r, 200));
                            result.found = true;
                            result.selectedText = optText;
                            return result;
                        }
                    }
                }
            } catch (e) { /* ignore selector errors */ }
        }

        // Also check for options that are direct siblings or nearby the input
        const parent = inputEl.closest('.form-group, .field, [class*="input"], [class*="select"], [class*="search"]') || inputEl.parentElement;
        if (parent) {
            const nearbyOptions = parent.querySelectorAll(
                '[role="option"], li, [class*="option"], [class*="item"], [class*="result"]'
            );
            for (const opt of nearbyOptions) {
                const style = window.getComputedStyle(opt);
                if (style.display === 'none' || style.visibility === 'hidden') continue;
                const rect = opt.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) continue;
                const optText = (opt.textContent || '').trim();
                if (optText && optText.toLowerCase().includes(searchText.toLowerCase())) {
                    opt.click();
                    opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                    opt.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                    await new Promise(r => setTimeout(r, 200));
                    result.found = true;
                    result.selectedText = optText;
                    return result;
                }
            }
        }

        return result;
    }

    // ─── HELPER: Simulate keyboard typing character by character ───
    // This is the most reliable way to fill React/Vue/Angular controlled inputs
    // that reject programmatic value changes. It mimics real user typing.
    async function simulateTyping(el, text) {
        el.focus();

        // Clear existing content using select-all + delete
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true }));
        document.execCommand('selectAll', false, null);
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', bubbles: true }));
        document.execCommand('delete', false, null);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 50));

        // Type each character using insertText (works with contentEditable and input fields)
        for (let i = 0; i < text.length; i++) {
            const char = text[i];

            // Dispatch keydown
            el.dispatchEvent(new KeyboardEvent('keydown', {
                key: char, code: `Key${char.toUpperCase()}`,
                charCode: char.charCodeAt(0), keyCode: char.charCodeAt(0),
                bubbles: true, cancelable: true
            }));

            // Use execCommand insertText — this triggers React's onChange
            document.execCommand('insertText', false, char);

            // Dispatch keyup
            el.dispatchEvent(new KeyboardEvent('keyup', {
                key: char, code: `Key${char.toUpperCase()}`,
                charCode: char.charCodeAt(0), keyCode: char.charCodeAt(0),
                bubbles: true, cancelable: true
            }));
        }

        // Final events to ensure framework picks up the change
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    // ─── VISION: Screenshot Capture with SoM Annotation ───────
    async function captureScreenshotWithSoM(config) {
        try {
            // Get viewport dimensions
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;

            // Get page URL and title
            const pageUrl = window.location.href;
            const pageTitle = document.title;

            // Extract elements with bounding boxes
            const elements = extractClickableElements();
            const topElements = elements.slice(0, config.maxElements || 60);

            let index = 1;
            const somMap = {};

            for (const el of topElements) {
                const domEl = document.querySelector(el.selector);
                if (!domEl) continue;

                const rect = domEl.getBoundingClientRect();
                if (rect.width < 5 || rect.height < 5) continue;

                el.boundingBox = {
                    x: rect.x + window.scrollX,
                    y: rect.y + window.scrollY,
                    width: rect.width,
                    height: rect.height
                };

                // Store mapping for SoM
                somMap[index.toString()] = el.selector;
                el.somIndex = index;

                index++;
                if (index > 99) break;
            }

            // Return success with elements - background will capture screenshot
            sendLogToContent('SoM prepared: ' + Object.keys(somMap).length + ' elements labeled');

            return {
                success: true,
                elements: topElements,
                elementCount: elements.length,
                somMap: somMap,
                viewportWidth: viewportWidth,
                viewportHeight: viewportHeight,
                pageUrl: pageUrl,
                pageTitle: pageTitle,
                needsImageCapture: true
            };
        } catch (error) {
            console.error('SoM preparation failed:', error);
            return { success: false, error: error.message, needsImageCapture: false };
        }
    }

    // Helper to log from content script
    function sendLogToContent(message) {
        console.log('[Hyprflow SoM]', message);
    }

    // ─── MAIN OBSERVATION FUNCTION ─────────────────────────────
    function extractClickableElements() {
        const out = [];
        try {
            const sel = [
                'button', 'a', 'input:not([type=hidden])', 'textarea', 'select',
                '[role=button]', '[role=link]', '[role="checkbox"]', '[role="switch"]',
                '[role="menuitem"]', '[role="option"]', '[role="listbox"]', '[role="menu"]',
                '[role="combobox"]', '[role="searchbox"]',
                '[onclick]', '[class*="btn" i]', '[class*="button" i]',
                '[class*="dropdown" i]', '[class*="menu" i]', '[class*="option" i]',
                '[class*="select" i]', '[class*="filter" i]', '[class*="sort" i]',
                '[class*="download" i]', '[class*="save" i]', '[class*="export" i]',
                '[class*="view" i]', '[class*="open" i]',
                '.dropdown-item', '.MuiMenuItem-root', '.ant-select-item-option-content',
                'li', 'div[role="button"]', 'span[role="button"]', 'div[onclick]', 'span[onclick]',
                '[contenteditable]', '[tabindex]:not([tabindex="-1"])',
                'input[type="submit"]', 'input[type="button"]'
            ].join(', ');

            const nodes = document.querySelectorAll(sel);

            for (const el of nodes) {
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) continue;
                const style = window.getComputedStyle(el);
                if (style.visibility === 'hidden' || style.display === 'none') continue;

                const tag = el.tagName.toLowerCase();
                const inputType = (tag === 'input' ? (el.type || '').toLowerCase() : '');

                let label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '';
                if (!label && el.id) {
                    try {
                        const labelEl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
                        if (labelEl) label = (labelEl.textContent || '').trim();
                    } catch (e) { }
                }
                if (!label && (tag === 'input' || tag === 'select')) {
                    let sib = el.previousElementSibling;
                    while (sib && sib.tagName === 'BR') sib = sib.previousElementSibling;
                    if (sib && sib.textContent && sib.textContent.length < 50) {
                        label = sib.textContent.trim();
                    }
                }

                let roleHint = 'other';
                if (tag === 'input' || tag === 'textarea') roleHint = 'input';
                else if (tag === 'select' || el.getAttribute('role') === 'listbox') roleHint = 'listbox';
                else if (tag === 'button' || el.getAttribute('role') === 'button') roleHint = 'button';
                else if (tag === 'a') roleHint = 'link';
                else if (tag === 'option') roleHint = 'option';

                const text = (el.textContent || el.value || label || '').trim().slice(0, 200);

                let priority = 0;
                if (tag === 'input' || tag === 'textarea') priority = 10;
                if (tag === 'select' || roleHint === 'listbox') priority = 5;
                if (tag === 'button' || roleHint === 'button') priority = 3;
                if (tag === 'a' || roleHint === 'link') priority = 2;

                const isChecked = (inputType === 'checkbox' || inputType === 'radio')
                    ? el.checked : (el.getAttribute('aria-checked') === 'true');
                const isSelected = tag === 'option'
                    ? el.selected : (el.getAttribute('aria-selected') === 'true');

                // Enhanced select/dropdown state detection
                let selectedOptionText = null;
                let isPlaceholderSelected = false;
                if (tag === 'select' && el.options && el.selectedIndex >= 0) {
                    const selectedOpt = el.options[el.selectedIndex];
                    selectedOptionText = (selectedOpt.text || '').trim();
                    // Detect if the selected option is a placeholder (disabled, empty value, or common placeholder text)
                    isPlaceholderSelected = selectedOpt.disabled ||
                        selectedOpt.value === '' ||
                        /^(select|choose|pick|--)/i.test(selectedOptionText);
                }

                // Get current value for input/textarea/select elements
                let currentValue = null;
                if (tag === 'input' || tag === 'textarea') {
                    currentValue = el.value || null;
                }

                out.push({
                    tagName: tag, text: text || null,
                    selector: generateCss(el), xpath: getXPath(el),
                    id: el.id || null, ariaLabel: label || null,
                    type: inputType || null, name: el.getAttribute('name') || null,
                    roleHint, priority,
                    checked: isChecked || null, selected: isSelected || null,
                    selectedOptionText,
                    isPlaceholderSelected: isPlaceholderSelected || null,
                    currentValue,
                    visible: true,
                    boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
                });
            }

            out.sort((a, b) => b.priority - a.priority);

            // ── PASS 2: Hidden submenu items (hover-triggered) ──
            const navContainers = document.querySelectorAll(
                'nav, [role="navigation"], [role="menubar"], .navbar, .main-menu, #masthead, ' +
                '[id*="RadMenu"], [class*="RadMenu"], [class*="telerik"], ' +
                '[role="menuitem"], [aria-haspopup], .dropdown'
            );
            navContainers.forEach(navRoot => {
                const parentItems = navRoot.querySelectorAll('li, [role="menuitem"], [aria-haspopup], .dropdown');
                parentItems.forEach(parentLi => {
                    const submenu = parentLi.querySelector(
                        ':scope > ul, :scope > ol, :scope > [role="menu"], ' +
                        ':scope > div[class*="sub"], :scope > div[class*="dropdown"], :scope > .dropdown-menu'
                    );
                    if (!submenu) return;
                    const submenuStyle = window.getComputedStyle(submenu);
                    const submenuRect = submenu.getBoundingClientRect();
                    const isHidden = submenuStyle.display === 'none' || submenuStyle.visibility === 'hidden'
                        || submenuRect.height === 0 || submenuRect.width === 0
                        || parseFloat(submenuStyle.opacity) === 0;
                    if (!isHidden) return;

                    const trigger = parentLi.querySelector(':scope > a, :scope > button, :scope > [role="button"], :scope > span');
                    if (!trigger) return;
                    const triggerCss = generateCss(trigger);
                    const triggerText = (trigger.textContent || '').trim().slice(0, 100);

                    submenu.querySelectorAll('a, button, [role="menuitem"], [role="link"]').forEach(child => {
                        const childText = (child.textContent || '').trim().slice(0, 200);
                        if (!childText) return;
                        const childCss = generateCss(child);
                        if (out.some(o => o.selector === childCss)) return;
                        out.push({
                            tagName: child.tagName.toLowerCase(), text: childText,
                            selector: childCss, xpath: getXPath(child),
                            roleHint: child.tagName.toLowerCase() === 'a' ? 'link' : 'button',
                            priority: 1, visible: false,
                            hiddenInHoverMenu: true,
                            hoverTriggerSelector: triggerCss,
                            hoverTriggerText: triggerText
                        });
                    });
                });
            });

            // ── PASS 3: Tree-view expand buttons ──
            const treeExpandSelectors = [
                '.rtIn', '[class*="rtPlus"]', '[class*="rtMinus"]',
                '[class*="rtdExpand"]', '[class*="rtdCollapse"]',
                '.jqtree-toggler', '.jstree-anchor > .jstree-themeicon',
                '[class*="jstree-closed"]', '[class*="jstree-open"]',
                '.k-item > .k-icon', '[class*="k-treeview"] .k-icon',
                '.x-tree-elbow-plus', '.x-tree-elbow-minus',
                '[class*="tree-node"] [class*="expand"]',
                '[class*="treeview"] [class*="expand"]',
                '[class*="mat-tree"] button', '.p-tree .p-tree-toggleable-content'
            ];
            treeExpandSelectors.forEach(expandSel => {
                try {
                    document.querySelectorAll(expandSel).forEach(btn => {
                        const rect = btn.getBoundingClientRect();
                        if (rect.width === 0 || rect.height === 0) return;
                        const style = window.getComputedStyle(btn);
                        if (style.visibility === 'hidden' || style.display === 'none') return;
                        const btnCss = generateCss(btn);
                        if (out.some(o => o.selector === btnCss)) return;

                        let parentNodeText = '';
                        const parentLi = btn.closest('li');
                        if (parentLi) {
                            const anchor = parentLi.querySelector(':scope > a, :scope > span:not([class*="toggler"]), :scope > .rtIn');
                            if (anchor && anchor !== btn) parentNodeText = (anchor.textContent || '').trim().slice(0, 100);
                        }
                        const isExpanded = btn.classList.contains('rtMinus') ||
                            btn.classList.contains('jstree-open') ||
                            btn.getAttribute('aria-expanded') === 'true';

                        out.push({
                            tagName: btn.tagName.toLowerCase(),
                            text: parentNodeText || (btn.textContent || '').trim().slice(0, 100) || 'expand/collapse',
                            selector: btnCss, xpath: getXPath(btn),
                            roleHint: 'treeExpand', priority: 4, visible: true,
                            isTreeExpandButton: true, treeNodeText: parentNodeText, isExpanded
                        });
                    });
                } catch (e) { /* ignore */ }
            });

            // ── PASS 4: Tree node items ──
            const treeNodeSelectors = ['.rtIn', '.rtTop', '.rtMid', '.rtBot', '.jstree-anchor', '.k-in', '.x-tree-node-text'];
            treeNodeSelectors.forEach(nodeSel => {
                try {
                    document.querySelectorAll(nodeSel).forEach(nodeEl => {
                        const rect = nodeEl.getBoundingClientRect();
                        if (rect.width === 0 || rect.height === 0) return;
                        const nodeCss = generateCss(nodeEl);
                        if (out.some(o => o.selector === nodeCss)) return;
                        const parentLi = nodeEl.closest('li');
                        if (!parentLi) return;

                        const expandBtn = parentLi.querySelector(
                            '.rtPlus, .rtMinus, .jqtree-toggler, .jstree-ocl, .k-icon, ' +
                            '.x-tree-elbow-plus, .x-tree-elbow-minus, [class*="expand"], [aria-expanded]'
                        );
                        const hasChildren = parentLi.querySelector(':scope > ul, :scope > ol') !== null;

                        out.push({
                            tagName: nodeEl.tagName.toLowerCase(),
                            text: (nodeEl.textContent || '').trim().slice(0, 100),
                            selector: nodeCss, xpath: getXPath(nodeEl),
                            roleHint: 'treeNode', priority: 3, visible: true,
                            isTreeNode: true, hasChildren,
                            hasExpandButton: !!expandBtn,
                            expandButtonSelector: expandBtn ? generateCss(expandBtn) : null,
                            isExpanded: expandBtn ? (
                                expandBtn.classList.contains('rtMinus') ||
                                expandBtn.classList.contains('jstree-open') ||
                                expandBtn.getAttribute('aria-expanded') === 'true'
                            ) : null
                        });
                    });
                } catch (e) { /* ignore */ }
            });

            return out.slice(0, 150);
        } catch (e) {
            console.error("Observe error:", e);
            return [];
        }
    }
}
