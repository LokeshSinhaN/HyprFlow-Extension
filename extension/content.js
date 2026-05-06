// Hyprflow Extension Content Script — runs in user's webpage context.
// Acts as the "Hands" and "Eyes". Mirrors BrowserService.php intelligence.

if (typeof window.hyprflowListenerAdded === 'undefined') {
    window.hyprflowListenerAdded = true;

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
                        try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
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
                        if (el.tagName.toLowerCase() === 'select') {
                            const optionText = (action.text || '').trim();
                            const options = Array.from(el.options);
                            const targetOpt = options.find(o =>
                                o.text.trim().toLowerCase() === optionText.toLowerCase() ||
                                o.value.toLowerCase() === optionText.toLowerCase()
                            );
                            if (targetOpt) {
                                el.value = targetOpt.value;
                                el.dispatchEvent(new Event('change', { bubbles: true }));
                                success = true;
                            }
                        } else {
                            el.value = action.text;
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                            success = true;
                        }
                    }
                    // ── SELECT OPTION ──
                    else if (action.action === 'select_option' && el) {
                        const optionText = (action.option || action.text || '').trim();
                        const unselect = action.unselect || false;
                        let optionSelected = false;

                        if (el.tagName.toLowerCase() === 'select') {
                            const options = Array.from(el.options);
                            const targetOpt = options.find(o =>
                                o.text.trim().toLowerCase() === optionText.toLowerCase() ||
                                o.value.toLowerCase() === optionText.toLowerCase()
                            );
                            if (targetOpt) {
                                if (unselect) { targetOpt.selected = false; }
                                else { el.value = targetOpt.value; }
                                el.dispatchEvent(new Event('change', { bubbles: true }));
                                optionSelected = true;
                            }
                        }

                        if (!optionSelected) {
                            el.click();
                            await new Promise(r => setTimeout(r, 300));
                            const regex = new RegExp(optionText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
                            const allElements = Array.from(document.querySelectorAll(
                                '[role="option"], [role="menuitem"], .dropdown-item, li, a, span, label'
                            ));
                            for (const optEl of allElements) {
                                const st = window.getComputedStyle(optEl);
                                if (st.display === 'none' || st.visibility === 'hidden') continue;
                                const txt = (optEl.textContent || '').trim();
                                if (regex.test(txt) && txt.length < 150) {
                                    optEl.scrollIntoView({ block: 'center' });
                                    optEl.click();
                                    optEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                                    optEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                                    optionSelected = true;
                                    break;
                                }
                            }
                        }

                        success = optionSelected;
                        if (success) {
                            extraData.toggleAction = unselect ? 'unselected' : 'selected';
                            extraData.optionText = optionText;
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
                    } catch(e) {}
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
                const selectedOptionText = tag === 'select' && el.options && el.selectedIndex >= 0
                    ? (el.options[el.selectedIndex].text || '').trim() : null;

                out.push({
                    tagName: tag, text: text || null,
                    selector: generateCss(el), xpath: getXPath(el),
                    id: el.id || null, ariaLabel: label || null,
                    type: inputType || null, name: el.getAttribute('name') || null,
                    roleHint, priority,
                    checked: isChecked || null, selected: isSelected || null,
                    selectedOptionText, visible: true
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
