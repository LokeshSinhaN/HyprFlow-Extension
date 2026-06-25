// Hyprflow Extension Content Script — runs in user's webpage context.
// Acts as the "Hands" and "Eyes". Mirrors BrowserService.php intelligence.
// CDP-based Accessibility Tree + Vision + SoM implementation for enterprise-grade AI agent.

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

    // ─── ACCESSIBILITY TREE ─────────────────────────────────────────
    // Maps interactive DOM elements to stable ref IDs with absolute coordinates.
    // Used by the AI agent to deterministically target elements via CDP clicks.
    // Replaces flat CSS extraction with a semantic, coordinate-based approach.

    /** @type {WeakMap<Element, string>} */
    const _elementRefMap = new WeakMap();
    /** @type {Map<string, Element>} */
    const _refToElement = new Map();
    let _refCounter = 0;

    /**
     * Builds a lightweight Accessibility Tree of all interactive elements on the page.
     * Each element gets a stable ref_id (e.g., ref_1, ref_2) mapped to its semantic role,
     * accessible name, and absolute X/Y center coordinates.
     *
     * Handles dynamic React/Radix UI elements that may unmount between calls by
     * re-scanning the DOM each invocation and only reusing refs for elements still in DOM.
     *
     * @returns {{ tree: Array<{ref_id: string, role: string, name: string, x: number, y: number, tag: string, enabled: boolean, checked: boolean|null, value: string|null}>, elementCount: number }}
     */
    function buildAccessibilityTree() {
        // Clear stale refs (elements that have been unmounted by React)
        for (const [refId, el] of _refToElement.entries()) {
            if (!document.contains(el)) {
                _refToElement.delete(refId);
                // WeakMap auto-cleans when element is GC'd
            }
        }

        const INTERACTIVE_SELECTORS = [
            'button', 'a[href]', 'input:not([type="hidden"])', 'textarea', 'select',
            '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="menuitemcheckbox"]',
            '[role="menuitemradio"]', '[role="option"]', '[role="switch"]', '[role="tab"]',
            '[role="checkbox"]', '[role="radio"]', '[role="combobox"]', '[role="searchbox"]',
            '[role="slider"]', '[role="spinbutton"]', '[role="textbox"]',
            '[aria-haspopup]', '[contenteditable="true"]',
            '[tabindex]:not([tabindex="-1"])',
            '[data-radix-collection-item]', '[cmdk-item]'
        ].join(', ');

        const elements = document.querySelectorAll(INTERACTIVE_SELECTORS);
        const tree = [];

        for (const el of elements) {
            try {
                // Skip invisible/zero-size elements
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) continue;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden') continue;
                if (parseFloat(style.opacity) === 0) continue;

                // Get or assign a stable ref_id
                let refId = _elementRefMap.get(el);
                if (!refId) {
                    _refCounter++;
                    refId = `ref_${_refCounter}`;
                    _elementRefMap.set(el, refId);
                    _refToElement.set(refId, el);
                }

                // Compute absolute center coordinates (viewport + scroll offset)
                const x = Math.round(rect.left + rect.width / 2 + window.scrollX);
                const y = Math.round(rect.top + rect.height / 2 + window.scrollY);

                // Determine semantic role
                const tag = el.tagName.toLowerCase();
                let role = el.getAttribute('role') || '';
                if (!role) {
                    if (tag === 'button' || el.type === 'submit' || el.type === 'button') role = 'button';
                    else if (tag === 'a') role = 'link';
                    else if (tag === 'input') {
                        const inputType = (el.type || 'text').toLowerCase();
                        if (inputType === 'checkbox') role = 'checkbox';
                        else if (inputType === 'radio') role = 'radio';
                        else if (inputType === 'range') role = 'slider';
                        else role = 'textbox';
                    }
                    else if (tag === 'textarea') role = 'textbox';
                    else if (tag === 'select') role = 'combobox';
                    else role = 'generic';
                }

                // Determine accessible name (priority: aria-label > aria-labelledby > label[for] > text > placeholder > name)
                let name = el.getAttribute('aria-label') || '';
                if (!name) {
                    const labelledBy = el.getAttribute('aria-labelledby');
                    if (labelledBy) {
                        const labelEl = document.getElementById(labelledBy);
                        if (labelEl) name = (labelEl.textContent || '').trim();
                    }
                }
                if (!name && el.id) {
                    const labelEl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
                    if (labelEl) name = (labelEl.textContent || '').trim();
                }
                if (!name) {
                    name = (el.textContent || '').trim().slice(0, 80);
                }
                if (!name) {
                    name = el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title') || '';
                }

                // Element state
                const isDisabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
                let isChecked = null;
                if (role === 'checkbox' || role === 'radio' || role === 'switch') {
                    isChecked = el.checked ?? (el.getAttribute('aria-checked') === 'true');
                }

                // Current value for inputs
                let value = null;
                if (tag === 'input' || tag === 'textarea') {
                    value = el.value || null;
                } else if (tag === 'select' && el.selectedIndex >= 0) {
                    value = el.options[el.selectedIndex]?.text || null;
                }

                tree.push({
                    ref_id: refId,
                    role: role,
                    name: name.slice(0, 120),
                    tag: tag,
                    x: x,
                    y: y,
                    enabled: !isDisabled,
                    checked: isChecked,
                    value: value
                });
            } catch (e) {
                // Skip elements that throw during inspection (e.g., cross-origin iframes)
                continue;
            }
        }

        return { tree, elementCount: tree.length };
    }

    /**
     * Resolves a ref_id back to its DOM element for coordinate retrieval.
     * Returns null if the element has been unmounted (React re-render).
     * @param {string} refId
     * @returns {Element|null}
     */
    function resolveRefElement(refId) {
        const el = _refToElement.get(refId);
        if (el && document.contains(el)) {
            return el;
        }
        // Element was unmounted — clean up
        _refToElement.delete(refId);
        return null;
    }

    /**
     * Gets the current absolute center coordinates for a ref_id.
     * Handles elements that may have moved due to scroll or layout changes.
     * @param {string} refId
     * @returns {{ x: number, y: number } | null}
     */
    function getRefCoordinates(refId) {
        const el = resolveRefElement(refId);
        if (!el) return null;

        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;

        return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2)
        };
    }

    // ─── SEMANTIC TARGET RESOLUTION ENGINE ────────────────────────
    // Allows AI to target elements by visible text or accessible name,
    // bypassing brittle CSS selectors entirely.

    /**
     * Dispatches the full Universal Event Dispatcher click sequence on an element.
     * Extracted for reuse across CSS-based clicks, semantic clicks, and coordinate clicks.
     * Sequences: focus → PointerEvents → MouseEvents → click
     * This bypasses Radix UI's synthetic event blockers which require the full
     * pointer lifecycle to register interactions.
     *
     * @param {Element} target - The DOM element to click
     * @returns {void}
     */
    function dispatchUniversalClick(target) {
        // 1. Focus is critical for Radix/HeadlessUI accessibility wrappers
        try { target.focus(); } catch(e) {}

        // 2. Compute center coordinates for realistic event positioning
        const rect = target.getBoundingClientRect();
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };

        // 3. Full pointer + mouse lifecycle (required by Radix UI)
        target.dispatchEvent(new PointerEvent('pointerover', opts));
        target.dispatchEvent(new PointerEvent('pointerenter', { ...opts, bubbles: false }));
        target.dispatchEvent(new PointerEvent('pointerdown', { ...opts, button: 0 }));
        target.dispatchEvent(new MouseEvent('mousedown', { ...opts, button: 0 }));
        target.dispatchEvent(new MouseEvent('mouseup', { ...opts, button: 0 }));
        target.dispatchEvent(new PointerEvent('pointerup', { ...opts, button: 0 }));

        // 4. Standard click (some frameworks only listen to this)
        target.click();
    }

    function normalizeText(value) {
        return (value || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
    }

    function getAccessibleLabel(el) {
        if (!el) return '';
        const ariaLabel = el.getAttribute('aria-label') || '';
        const ariaLabelledBy = el.getAttribute('aria-labelledby');
        if (ariaLabel) return ariaLabel.trim();
        if (ariaLabelledBy) {
            const labelEl = document.getElementById(ariaLabelledBy);
            if (labelEl) return (labelEl.textContent || '').trim();
        }
        const placeholder = el.getAttribute('placeholder') || '';
        if (placeholder) return placeholder.trim();
        const name = el.getAttribute('name') || '';
        if (name) return name.trim();
        const id = el.id || '';
        if (id) {
            try {
                const labelEl = document.querySelector('label[for="' + CSS.escape(id) + '"]');
                if (labelEl) return (labelEl.textContent || '').trim();
            } catch (e) { }
        }
        return (el.textContent || '').trim().slice(0, 120);
    }

    function getNearbySectionText(el, maxDepth = 6) {
        let current = el;
        const parts = [];
        while (current && current !== document.body && maxDepth-- > 0) {
            const tag = current.tagName ? current.tagName.toLowerCase() : '';
            if (['section', 'form', 'main', 'div', 'article', 'fieldset', 'table'].includes(tag)) {
                const heading = current.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]');
                if (heading) parts.push((heading.textContent || '').trim());
                const ariaLabel = current.getAttribute('aria-label');
                if (ariaLabel) parts.push(ariaLabel.trim());
            }
            current = current.parentElement;
        }
        return parts.filter(Boolean).join(' | ');
    }

    function isElementVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 5 || rect.height < 5) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0;
    }

    function isComboboxElement(el) {
        if (!el) return false;
        const role = (el.getAttribute('role') || '').toLowerCase();
        const ariaHasPopup = (el.getAttribute('aria-haspopup') || '').toLowerCase();
        const ariaAutocomplete = (el.getAttribute('aria-autocomplete') || '').toLowerCase();
        return role === 'combobox' || role === 'searchbox' ||
            ariaHasPopup === 'listbox' || ariaHasPopup === 'true' ||
            ariaAutocomplete === 'list' || ariaAutocomplete === 'both' ||
            !!el.getAttribute('aria-controls') || !!el.getAttribute('aria-owns') ||
            !!el.closest('[class*="combobox"]') || !!el.closest('[class*="autocomplete"]') ||
            !!el.closest('[class*="searchable"]') || !!el.closest('[class*="react-select"]') ||
            !!el.closest('[data-radix-combobox-input]');
    }

    function getInteractiveCandidates() {
        const selectors = [
            'input:not([type="hidden"])', 'textarea', 'select',
            '[role="combobox"]', '[role="searchbox"]', '[role="textbox"]',
            '[role="button"]', 'button',
            '[aria-haspopup]', '[aria-controls]',
            '[class*="combobox"] input', '[class*="autocomplete"] input',
            '[class*="react-select"] input'
        ].join(', ');
        return Array.from(document.querySelectorAll(selectors)).filter(isElementVisible);
    }

    function scoreFieldIntent(el, intent) {
        const label = getAccessibleLabel(el);
        const nearby = getNearbySectionText(el);
        const combined = normalizeText([label, nearby, el.getAttribute('placeholder'), el.getAttribute('name'), el.getAttribute('aria-label')].filter(Boolean).join(' '));
        const aliasMap = {
            patient_search: ['search patient', 'patient search', 'quick fill patient'],
            insured_id: ['insured', 'subscriber', 'member id', 'memberid', 'insurance id'],
            state: ['state', 'province'],
            procedure: ['procedure', 'cpt', 'hcpcs', 'cpt/hcps'],
            diagnosis_pointer: ['diagnosis pointer', 'diagnosis', 'dx pointer', 'pointer'],
            charges: ['charges', 'charge', 'amount', 'fee', 'payment']
        };
        const aliases = aliasMap[intent] || [];
        let score = 0;
        for (const alias of aliases) {
            const n = normalizeText(alias);
            if (combined === n) score = Math.max(score, 100);
            else if (combined.includes(n)) score = Math.max(score, 85);
            else if (n.split(/\s+/).every(w => w && combined.includes(w))) score = Math.max(score, 65);
        }
        if (intent === 'procedure' && combined.includes('diagnosis')) score -= 35;
        if (intent === 'diagnosis_pointer' && combined.includes('procedure')) score -= 20;
        if (intent === 'charges' && combined.includes('diagnosis')) score -= 20;
        return score;
    }

    function resolveFieldByIntent(intent) {
        const normalizedIntent = normalizeText(intent || '').replace(/[^a-z0-9_]/g, '_');
        if (!['patient_search', 'insured_id', 'state', 'procedure', 'diagnosis_pointer', 'charges'].includes(normalizedIntent)) return null;

        let bestEl = null;
        let bestScore = 0;
        let bestContext = '';
        for (const el of getInteractiveCandidates()) {
            const score = scoreFieldIntent(el, normalizedIntent);
            if (score > bestScore) {
                bestScore = score;
                bestEl = el;
                bestContext = getNearbySectionText(el);
            }
        }
        if (!bestEl || bestScore < 50) return null;

        try {
            bestEl.scrollIntoView({ behavior: 'instant', block: 'center' });
        } catch (e) { }
        const rect = bestEl.getBoundingClientRect();
        return {
            el: bestEl,
            selector: generateCss(bestEl),
            label: getAccessibleLabel(bestEl),
            section: bestContext,
            score: bestScore,
            boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        };
    }

    function parsePatientSearchText(text) {
        const raw = normalizeText(text || '');
        const firstLine = (text || '').split('\n')[0].trim();
        const comma = firstLine.match(/^([^,]+),\s*(.+)$/);
        const tokens = { raw, first: '', last: '', terms: [] };
        if (comma) {
            tokens.last = normalizeText(comma[1]);
            tokens.first = normalizeText(comma[2].split(/\s+/)[0]);
            tokens.terms = [tokens.first, tokens.last, `${tokens.last}, ${tokens.first}`, `${tokens.first} ${tokens.last}`];
        } else {
            const words = raw.split(' ').filter(Boolean);
            tokens.first = words[0] || raw;
            tokens.last = words.length > 1 ? words[words.length - 1] : '';
            tokens.terms = raw ? [raw, ...words] : [];
        }
        return tokens;
    }

    function scorePatientOption(optionText, searchText) {
        const tokens = parsePatientSearchText(searchText);
        const opt = normalizeText(optionText);
        const firstLine = normalizeText((optionText || '').split('\n')[0]);
        if (!opt || !searchText) return 0;

        const comma = firstLine.match(/^([^,]+),\s*(.+)$/);
        if (comma) {
            const optLast = normalizeText(comma[1]);
            const optFirst = normalizeText(comma[2].split(/\s+/)[0]);
            if (tokens.first && tokens.last) {
                if (optFirst === tokens.first && optLast === tokens.last) return 100;
                if (optFirst.startsWith(tokens.first) && optLast.startsWith(tokens.last)) return 92;
            }
            if (tokens.first && optFirst === tokens.first) return tokens.last ? 0 : 78;
            if (tokens.last && optLast === tokens.last) return 70;
        }

        if (tokens.last && !opt.includes(tokens.last)) return 0;
        if (tokens.raw && opt === tokens.raw) return 96;
        if (tokens.raw && firstLine === tokens.raw) return 94;
        if (tokens.first && firstLine.startsWith(tokens.first)) return tokens.last ? 82 : 68;
        if (tokens.terms.some(t => t && opt.includes(t))) return tokens.last ? 74 : 58;
        if (tokens.last && opt.includes(tokens.last)) return 45;
        if (tokens.first && opt.includes(tokens.first)) return tokens.last ? 35 : 42;
        return 0;
    }

    function collectVisibleDropdownOptions() {
        const selectors = [
            '[role="option"]', '[role="menuitem"]', '[cmdk-item]', '[data-radix-collection-item]',
            '[data-value]', '[class*="option"]:not([class*="optional"])', '[class*="item"]:not([class*="form-item"])',
            '.dropdown-item', '.MuiMenuItem-root', '.MuiAutocomplete-option', '.ant-select-item-option',
            '[data-radix-popper-content-wrapper] > div > div', '[data-radix-popper-content-wrapper] > div > div > div',
            'div[tabindex]', 'div[data-index]'
        ].join(', ');
        const out = [];
        for (const opt of Array.from(document.querySelectorAll(selectors))) {
            if (!isElementVisible(opt)) continue;
            const text = (opt.textContent || '').trim();
            const firstLine = text.split('\n')[0].trim();
            if (!firstLine || firstLine.length > 120) continue;
            if (!out.some(o => o.text === text)) out.push({ el: opt, text, firstLine, selector: generateCss(opt) });
            if (out.length >= 20) break;
        }
        return out;
    }

    function resolveQuickFillOption(action) {
        const searchText = action.text_match || action.text || action.option || '';
        const visibleOptions = collectVisibleDropdownOptions();
        let best = null;
        let bestScore = 0;
        for (const opt of visibleOptions) {
            const score = scorePatientOption(opt.text, searchText);
            if (score > bestScore) {
                bestScore = score;
                best = opt;
            }
        }
        const tokens = parsePatientSearchText(searchText);
        const hasLastToken = Boolean(tokens.last && tokens.last !== tokens.first);
        if (!best || bestScore < (hasLastToken ? 70 : 55)) {
            return {
                found: false,
                searchedFor: searchText,
                visibleOptions: visibleOptions.map(o => o.firstLine),
                bestScore
            };
        }
        return { found: true, el: best.el, selector: best.selector, text: best.text, score: bestScore, visibleOptions: visibleOptions.map(o => o.firstLine) };
    }

    // Click a dropdown/combobox OPTION reliably. CRITICAL: never call focus() here —
    // focusing the option blurs the search input, which makes Radix/cmdk/React-Select close
    // the list BEFORE the click registers (the click then lands on the backdrop and can
    // dismiss the whole modal — exactly the "form closed, restart" bug). We dispatch hover +
    // a mousedown-FIRST pointer/mouse lifecycle so the option is selected while the list is
    // still open.
    async function clickOptionElement(optEl) {
        try { optEl.scrollIntoView({ block: 'center' }); } catch (e) { }
        await new Promise(r => setTimeout(r, 50));
        const rect = optEl.getBoundingClientRect();
        const opts = {
            bubbles: true, cancelable: true, view: window,
            clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, button: 0
        };
        // Hover first — many lists only attach selection handlers to the highlighted item.
        optEl.dispatchEvent(new PointerEvent('pointerover', opts));
        optEl.dispatchEvent(new MouseEvent('mouseover', opts));
        optEl.dispatchEvent(new PointerEvent('pointermove', opts));
        optEl.dispatchEvent(new MouseEvent('mousemove', opts));
        // mousedown BEFORE any blur can close the list — this is what commits the selection.
        optEl.dispatchEvent(new PointerEvent('pointerdown', opts));
        optEl.dispatchEvent(new MouseEvent('mousedown', opts));
        optEl.dispatchEvent(new PointerEvent('pointerup', opts));
        optEl.dispatchEvent(new MouseEvent('mouseup', opts));
        optEl.click();
        await new Promise(r => setTimeout(r, 300));
    }

    function findNearestScrollableAncestor(el) {
        let current = el;
        while (current && current !== document.body) {
            const style = window.getComputedStyle(current);
            const scrollable = /(auto|scroll|overlay)/.test(style.overflowY + style.overflow) && current.scrollHeight > current.clientHeight + 10;
            if (scrollable) return current;
            current = current.parentElement;
        }
        return document.scrollingElement || document.documentElement;
    }

    async function scrollToField(field) {
        if (!field || !field.el) return;
        try {
            const container = findNearestScrollableAncestor(field.el);
            const rect = field.el.getBoundingClientRect();
            if (rect.top < 80 || rect.bottom > window.innerHeight - 80) {
                container.scrollBy({ top: rect.top + container.scrollTop - window.innerHeight / 2, behavior: 'smooth' });
                await new Promise(r => setTimeout(r, 350));
            }
            field.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await new Promise(r => setTimeout(r, 250));
        } catch (e) { }
    }

    function extractFieldIntentFromElement(el) {
        const label = getAccessibleLabel(el);
        const section = getNearbySectionText(el);
        const combined = normalizeText([label, section, el.getAttribute('placeholder'), el.getAttribute('name')].filter(Boolean).join(' '));
        if (combined.includes('procedure') || combined.includes('cpt') || combined.includes('hcpcs')) return 'procedure';
        if (combined.includes('diagnosis') || combined.includes('pointer') || combined.includes('dx')) return 'diagnosis_pointer';
        if (combined.includes('charge') || combined.includes('amount') || combined.includes('fee')) return 'charges';
        if (combined.includes('insured') || combined.includes('subscriber') || combined.includes('member id')) return 'insured_id';
        if (combined.includes('state') || combined.includes('province')) return 'state';
        if (combined.includes('search patient')) return 'patient_search';
        return '';
    }

    function findNearestFieldForError(errorEl) {
        const field = errorEl.closest('input, textarea, select, [role="combobox"], [role="searchbox"]') ||
            errorEl.querySelector('input, textarea, select, [role="combobox"], [role="searchbox"]');
        if (field) return field;

        const parent = errorEl.closest('[class*="field"], [class*="form"], section, form, [role="dialog"]') || errorEl.parentElement;
        if (parent) {
            const nearby = parent.querySelector('input, textarea, select, [role="combobox"], [role="searchbox"]');
            if (nearby) return nearby;
        }

        const rect = errorEl.getBoundingClientRect();
        const candidates = getInteractiveCandidates()
            .map(el => {
                const r = el.getBoundingClientRect();
                const distance = Math.abs((r.top + r.height / 2) - (rect.top + rect.height / 2)) + Math.abs((r.left + r.width / 2) - (rect.left + rect.width / 2));
                return { el, distance };
            })
            .filter(item => item.distance < 900)
            .sort((a, b) => a.distance - b.distance);
        return candidates[0]?.el || null;
    }

    function extractValidationErrors() {
        const errorSelector = [
            '[role="alert"]', '[aria-invalid="true"]', '[data-invalid="true"]',
            '[class*="error" i]', '[class*="invalid" i]', '[class*="validation" i]',
            '.text-danger', '.error-message', '.field-error', '.invalid-feedback'
        ].join(', ');
        const out = [];
        for (const errorEl of Array.from(document.querySelectorAll(errorSelector))) {
            if (!isElementVisible(errorEl)) continue;
            const text = (errorEl.textContent || '').trim();
            if (!text || text.length > 250) continue;
            if (!/\b(required|error|invalid|must|cannot|select|choose|missing)\b/i.test(text)) continue;
            const field = findNearestFieldForError(errorEl);
            const rect = errorEl.getBoundingClientRect();
            out.push({
                text,
                field: field ? getAccessibleLabel(field) : '',
                fieldIntent: field ? extractFieldIntentFromElement(field) : '',
                selector: field ? generateCss(field) : '',
                type: field ? field.tagName.toLowerCase() : '',
                isCombobox: field ? isComboboxElement(field) : false,
                boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            });
            if (out.length >= 20) break;
        }
        return out;
    }

    /**
     * Resolves a DOM element by visible text content or accessible name.
     * Iterates all interactive elements in the DOM and scores them based on
     * textContent and aria-label matching against the given text_match.
     *
     * SMART CONTEXT SCOPING: When action.scope_hint is provided, elements
     * within the matching scope (modal, form, dropdown, etc.) receive a
     * large score bonus, and elements at a higher z-index are prioritized.
     * This prevents clicking background "Add Patient" when the modal's
     * "Add Patient" submit button is the intended target.
     *
     * @param {{ text_match: string, role_hint?: string, scope_hint?: string }} action
     * @returns {Element|null} The best-matching DOM element or null
     */
    function resolveSemanticTarget(action) {
        if (!action.text_match) return null;

        const searchText = action.text_match.toLowerCase().trim();
        const roleHint = (action.role_hint || '').toLowerCase().trim();
        const scopeHint = (action.scope_hint || '').toLowerCase().trim();
        if (!searchText) return null;

        // ── SCOPE RESOLUTION ──────────────────────────────────────
        // Map scope_hint keywords to DOM container selectors.
        // When a scope_hint is active, elements INSIDE the scope get
        // a +40 bonus; elements OUTSIDE get a -30 penalty.
        const SCOPE_MAP = {
            'modal':    '[role="dialog"], [data-state="open"][class*="dialog"], [class*="modal"]:not([style*="display: none"]), [class*="Modal"]',
            'dialog':   '[role="dialog"], [data-state="open"][class*="dialog"], [class*="dialog"]',
            'form':     'form, [role="form"]',
            'dropdown': '[role="listbox"], [role="menu"], [data-radix-popper-content-wrapper], [data-radix-menu-content], [data-radix-select-content]',
            'popover':  '[data-radix-popover-content], [data-radix-popper-content-wrapper], [data-popper-placement], [class*="popover"]',
            'sidebar':  'aside, nav, [role="navigation"], [class*="sidebar"], [class*="drawer"]',
            'header':   'header, [role="banner"], [class*="header"], [class*="navbar"]',
            'main':     'main, [role="main"], [class*="content"]:not([role="dialog"])'
        };

        let scopeContainers = [];
        if (scopeHint && SCOPE_MAP[scopeHint]) {
            scopeContainers = Array.from(document.querySelectorAll(SCOPE_MAP[scopeHint])).filter(c => {
                const s = window.getComputedStyle(c);
                return s.display !== 'none' && s.visibility !== 'hidden';
            });
        }

        const INTERACTIVE_SELECTORS = [
            'button', 'a[href]', 'input:not([type="hidden"])', 'textarea', 'select',
            '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="menuitemcheckbox"]',
            '[role="menuitemradio"]', '[role="option"]', '[role="switch"]', '[role="tab"]',
            '[role="checkbox"]', '[role="radio"]', '[role="combobox"]', '[role="searchbox"]',
            '[role="textbox"]', '[aria-haspopup]', '[contenteditable="true"]',
            '[tabindex]:not([tabindex="-1"])',
            '[data-radix-collection-item]', '[cmdk-item]',
            'li', 'span', 'div[role]', 'label'
        ].join(', ');

        const candidates = document.querySelectorAll(INTERACTIVE_SELECTORS);
        let bestEl = null;
        let bestScore = 0;

        for (const el of candidates) {
            try {
                // Skip invisible/zero-size elements
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) continue;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden') continue;
                if (parseFloat(style.opacity) === 0) continue;

                // Compute text sources
                const textContent = (el.textContent || '').trim().toLowerCase();
                const firstLine = textContent.split('\n')[0].trim();
                const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase().trim();
                const elRole = (el.getAttribute('role') || '').toLowerCase();
                const tag = el.tagName.toLowerCase();

                // Derive implicit role for role_hint matching
                let impliedRole = elRole;
                if (!impliedRole) {
                    if (tag === 'button') impliedRole = 'button';
                    else if (tag === 'a') impliedRole = 'link';
                    else if (tag === 'input') impliedRole = 'textbox';
                    else if (tag === 'select') impliedRole = 'combobox';
                }

                // Score the element
                let score = 0;

                // Exact match on first line of text content (highest confidence)
                if (firstLine === searchText) score = 100;
                else if (ariaLabel === searchText) score = 95;
                else if (textContent === searchText) score = 90;
                // Starts-with match
                else if (firstLine.startsWith(searchText)) score = 75;
                else if (ariaLabel.startsWith(searchText)) score = 70;
                // Contains match
                else if (firstLine.includes(searchText)) score = 55;
                else if (ariaLabel.includes(searchText)) score = 50;
                else if (textContent.includes(searchText)) score = 30;

                if (score === 0) continue;

                // Penalize elements with very long text (likely containers, not targets)
                if (textContent.length > 200 && firstLine.length > 80) {
                    score -= 20;
                }

                // Bonus for shorter/more precise text (less container noise)
                if (firstLine.length < 40) score += 5;

                // Bonus for role_hint match
                if (roleHint && impliedRole === roleHint) {
                    score += 15;
                } else if (roleHint && impliedRole !== roleHint && impliedRole) {
                    score -= 10; // Mild penalty for role mismatch
                }

                // Bonus for interactive elements (buttons, links, menuitems)
                if (['button', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'switch', 'tab', 'link'].includes(impliedRole)) {
                    score += 5;
                }

                // ── SMART CONTEXT SCOPING ──────────────────────────
                // When scope_hint is active, heavily boost elements inside
                // the scoped container and penalize those outside.
                if (scopeHint && scopeContainers.length > 0) {
                    const isInScope = scopeContainers.some(c => c.contains(el));
                    if (isInScope) {
                        score += 40; // Strong boost for in-scope elements
                    } else {
                        score -= 30; // Heavy penalty for out-of-scope elements
                    }
                }

                // Z-INDEX PRIORITIZATION: Even without scope_hint,
                // elements in higher stacking contexts (modals, popovers)
                // get a bonus. This naturally prefers modal buttons over
                // background buttons when text matches are identical.
                if (!scopeHint || scopeContainers.length === 0) {
                    // Check if element is inside a dialog/modal/popover
                    const inModal = el.closest('[role="dialog"], [data-state="open"][class*="dialog"], [class*="modal"]:not([style*="display: none"]), [data-radix-popper-content-wrapper]');
                    if (inModal) {
                        score += 20; // Modals/popovers get natural priority
                    }
                }

                if (score > bestScore) {
                    bestScore = score;
                    bestEl = el;
                }
            } catch (e) {
                continue;
            }
        }

        // Require a minimum confidence score
        return bestScore >= 25 ? bestEl : null;
    }

    /**
     * Polling wrapper for resolveSemanticTarget that handles late-binding
     * API-delayed content (e.g., waiting for "Aetna" to appear in a
     * network-delayed combobox).
     *
     * @param {{ text_match: string, role_hint?: string }} action
     * @param {number} [timeoutMs=1500] - Max time to wait
     * @returns {Promise<Element|null>}
     */
    async function waitForSemanticTarget(action, timeoutMs = 1500) {
        const POLL_INTERVAL = 150;
        let elapsed = 0;

        // First try immediately
        const immediate = resolveSemanticTarget(action);
        if (immediate) return immediate;

        // Poll until timeout
        while (elapsed < timeoutMs) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL));
            elapsed += POLL_INTERVAL;
            const found = resolveSemanticTarget(action);
            if (found) return found;
        }

        return null;
    }

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

        // ─── BUILD ACCESSIBILITY TREE ────────────────────────────
        if (message.type === 'BUILD_A11Y_TREE') {
            try {
                const result = buildAccessibilityTree();
                sendResponse({
                    success: true,
                    url: window.location.href,
                    title: document.title,
                    tree: result.tree,
                    elementCount: result.elementCount
                });
            } catch (e) {
                sendResponse({ success: false, error: e.message, tree: [], elementCount: 0 });
            }
            return true;
        }

        // ─── GET REF COORDINATES (for CDP click targeting) ───────
        if (message.type === 'GET_REF_COORDINATES') {
            const refId = message.payload?.ref_id;
            if (!refId) {
                sendResponse({ success: false, error: 'No ref_id provided' });
                return true;
            }
            const coords = getRefCoordinates(refId);
            if (coords) {
                sendResponse({ success: true, ...coords, ref_id: refId });
            } else {
                // Element may have been unmounted by React — rebuild tree and retry
                buildAccessibilityTree();
                const retryCoords = getRefCoordinates(refId);
                if (retryCoords) {
                    sendResponse({ success: true, ...retryCoords, ref_id: refId, rebuilt: true });
                } else {
                    sendResponse({ success: false, error: `Element ${refId} not found or unmounted`, ref_id: refId });
                }
            }
            return true;
        }

        // ─── OBSERVE ─────────────────────────────────────────────
        if (message.type === 'OBSERVE') {
            const elements = extractClickableElements();
            sendResponse({
                url: window.location.href,
                title: document.title,
                elements: elements,
                validationErrors: extractValidationErrors()
            });
            return true;
        }

        if (message.type === 'GET_VALIDATION_ERRORS') {
            sendResponse({
                success: true,
                url: window.location.href,
                errors: extractValidationErrors()
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

        // ─── RESOLVE SEMANTIC TARGET (message handler for background.js) ──
        if (message.type === 'RESOLVE_SEMANTIC_TARGET') {
            const action = message.payload || {};
            (async () => {
                try {
                    const el = await waitForSemanticTarget(action, action.timeout || 1500);
                    if (el) {
                        const rect = el.getBoundingClientRect();
                        sendResponse({
                            success: true,
                            found: true,
                            text_match: action.text_match,
                            tag: el.tagName.toLowerCase(),
                            text: (el.textContent || '').trim().slice(0, 100),
                            x: Math.round(rect.left + rect.width / 2),
                            y: Math.round(rect.top + rect.height / 2)
                        });
                    } else {
                        sendResponse({
                            success: true,
                            found: false,
                            text_match: action.text_match
                        });
                    }
                } catch (e) {
                    sendResponse({ success: false, error: e.message });
                }
            })();
            return true;
        }

        // ─── EXECUTE ACTION ──────────────────────────────────────
        if (message.type === 'EXECUTE_ACTION') {
            let action = message.payload || {};
            (async () => {
                let success = false;
                let extraData = {};
                try {
                    if (action.field) {
                        // For TYPE actions, an explicit selector that already points to a
                        // visible, typable input wins over field-intent — field-intent often
                        // resolves to a combobox TRIGGER (div/button), not the inner text
                        // input, which would make typing fail with "Illegal invocation".
                        const explicitTypable = (action.action === 'type' && action.selector)
                            ? document.querySelector(action.selector) : null;
                        if (explicitTypable && isTypableElement(explicitTypable) && isElementVisible(explicitTypable)) {
                            extraData.keptExplicitSelector = action.selector;
                        } else {
                            const resolvedField = resolveFieldByIntent(action.field);
                            if (resolvedField) {
                                action = { ...action, selector: resolvedField.selector };
                                extraData.resolvedFieldIntent = {
                                    field: action.field,
                                    label: resolvedField.label,
                                    section: resolvedField.section,
                                    score: resolvedField.score
                                };
                                await scrollToField(resolvedField);
                            } else if (!action.selector) {
                                throw new Error(`Field intent "${action.field}" not found`);
                            }
                        }
                    }

                    // ── PATIENT / SEARCHABLE-DROPDOWN RESULT SELECTION ──
                    // Any click that is NOT the search trigger may be a result-option selection.
                    // We DOM-check the open dropdown: if a visible option matches the requested
                    // text, select it via the robust mousedown-first path (clickOptionElement),
                    // which avoids blurring the search input (that blur closes the list and can
                    // dismiss the whole modal). If nothing matches, fall through to a normal click
                    // — so non-option clicks (e.g. "Save Claim") are unaffected.
                    const qfOptionText = (action.text_match || action.text || action.option || '');
                    const isSearchTriggerLabel = /search\s*patient|patient\s*search|quick\s*fill|search name|mrn|search\.\.\./i.test(qfOptionText);
                    // A genuine patient result is "Last, First" (has a comma) or an explicit
                    // patient_option. Requiring that avoids misrouting ordinary clicks like
                    // "Save Claim". Other dropdown options (no comma) are still handled robustly
                    // by the option-aware generic click path further below.
                    const looksLikePatientResult = action.field === 'patient_option' || /,/.test(qfOptionText);
                    const maybeQuickFillOption = action.action === 'click' &&
                        action.field !== 'patient_search' &&
                        !isSearchTriggerLabel &&
                        looksLikePatientResult;
                    if (maybeQuickFillOption) {
                        const quickResult = resolveQuickFillOption(action);
                        if (quickResult.found) {
                            const semanticEl = quickResult.el;
                            extraData.quickFillOptionMatched = true;
                            extraData.quickFillOptionText = quickResult.text;
                            extraData.clickedText = quickResult.text;
                            extraData.quickFillMatchScore = quickResult.score;
                            extraData.quickFillVisibleOptions = quickResult.visibleOptions || [];
                            action = { ...action, selector: quickResult.selector };
                            window.__hyprflow_popupOpened = false;
                            await clickOptionElement(semanticEl);
                            if (window.__hyprflow_popupOpened) {
                                extraData.windowOpenDetected = true;
                                extraData.windowOpenUrl = window.__hyprflow_popupUrl;
                                window.__hyprflow_popupOpened = false;
                                window.__hyprflow_popupUrl = '';
                            }
                            success = true;
                            sendResponse({ success, ...extraData });
                            return;
                        }
                        // Only hard-fail when the AI EXPLICITLY targeted a patient option but none
                        // matched; otherwise fall through to the generic click handler below.
                        if (action.field === 'patient_option') {
                            extraData.quickFillOptionMatched = false;
                            extraData.quickFillSearchText = quickResult.searchedFor;
                            extraData.quickFillVisibleOptions = quickResult.visibleOptions || [];
                            extraData.quickFillBestScore = quickResult.bestScore || 0;
                            extraData.error = `Quick Fill option not found for "${quickResult.searchedFor}". Visible options: ${(quickResult.visibleOptions || []).join(', ')}`;
                            sendResponse({ success: false, ...extraData });
                            return;
                        }
                    }

                    // ── SEMANTIC TARGET RESOLUTION ──
                    // If the AI provides text_match, resolve by visible text/accessible name
                    // BEFORE falling back to CSS selector lookup.
                    let semanticEl = null;
                    if (action.text_match) {
                        semanticEl = await waitForSemanticTarget(action, 1500);
                        if (semanticEl) {
                            extraData.resolvedViaTextMatch = true;
                            extraData.matchedText = (semanticEl.textContent || '').trim().slice(0, 80);
                            extraData.matchedTag = semanticEl.tagName.toLowerCase();
                        } else {
                            extraData.textMatchFailed = true;
                            extraData.searchedFor = action.text_match;
                        }
                    }

                    // Enhancement 4: Pre-flight CSS Selector Validation
                    if (action.selector && !action.text_match && !['navigate', 'extract', 'scroll_down', 'scroll_up'].includes(action.action)) {
                        try { document.createDocumentFragment().querySelector(action.selector); }
                        catch (syntaxErr) {
                            extraData.error = `INVALID_SELECTOR_SYNTAX: "${action.selector}" — ${syntaxErr.message}. Use valid CSS only.`;
                            sendResponse({ success: false, ...extraData });
                            return;
                        }
                    }

                    // Resolve element: semantic target takes priority over CSS selector
                    let el = semanticEl || (action.selector ? document.querySelector(action.selector) : null);
                    // Actions that can work WITHOUT a selector
                    const selectorOptionalActions = ['navigate', 'extract', 'scroll_down', 'scroll_up', 'click_coordinate', 'keyboard_event'];
                    if (!el && !selectorOptionalActions.includes(action.action)) {
                        if (action.text_match) {
                            throw new Error(`Semantic target not found: text_match="${action.text_match}"${action.role_hint ? ' role_hint="' + action.role_hint + '"' : ''}`);
                        }
                        throw new Error(`Selector not found: ${action.selector}`);
                    }

                    if (el) {
                        try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { }
                    }

                    // ── TYPABLE TARGET RESOLUTION (combobox / searchable dropdowns) ──
                    // If we're about to TYPE but the resolved element isn't directly typable
                    // (it's a combobox trigger/wrapper), drill in / open it to find the real
                    // <input>. Prevents "Illegal invocation" and makes API-backed searchable
                    // dropdowns actually receive the typed text.
                    if (action.action === 'type' && el && !isTypableElement(el)) {
                        const typable = await resolveTypableTarget(el);
                        if (typable) {
                            extraData.retargetedToInput = generateCss(typable);
                            el = typable;
                            try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { }
                        }
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

                        // ─── OPTION-AWARE CLICK ───────────────────────────────
                        // If the target is (or sits inside) an OPEN dropdown/combobox list,
                        // select it with the mousedown-first, NO-focus sequence. Focusing an
                        // option blurs the search input → Radix/cmdk closes the list before the
                        // click lands (dismissing the selection and sometimes the whole modal).
                        // This generalises to EVERY searchable dropdown, not just patient search.
                        const optionAncestor = clickTarget.closest(
                            '[role="option"], [role="menuitem"], [cmdk-item], [data-radix-collection-item], ' +
                            '.MuiAutocomplete-option, .ant-select-item-option, .dropdown-item'
                        );
                        const inOpenPopup = !!clickTarget.closest(
                            '[role="listbox"], [role="menu"], [data-radix-popper-content-wrapper], ' +
                            '[cmdk-list], .MuiAutocomplete-popper, .ant-select-dropdown'
                        );
                        if (optionAncestor || inOpenPopup) {
                            extraData.clickedAsDropdownOption = true;
                            await clickOptionElement(optionAncestor || clickTarget);
                        } else {
                            // Full pointer + mouse lifecycle via reusable dispatchUniversalClick.
                            // Bypasses Radix UI's synthetic event blockers.
                            dispatchUniversalClick(clickTarget);
                        }
                        extraData.clickedText = ((optionAncestor || clickTarget).textContent || '').trim().slice(0, 80);

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

                        // Enhancement 6: ContentEditable Support (YouTube comments, rich text editors)
                        const isContentEditable = el.getAttribute('contenteditable') === 'true' ||
                            el.getAttribute('contenteditable') === '' ||
                            el.isContentEditable ||
                            (el.closest && !!el.closest('[contenteditable="true"]'));

                        if (isContentEditable) {
                            extraData.isContentEditable = true;
                            el.focus();
                            await new Promise(r => setTimeout(r, 100));

                            // Select all and delete existing content
                            const selection = window.getSelection();
                            const range = document.createRange();
                            range.selectNodeContents(el);
                            selection.removeAllRanges();
                            selection.addRange(range);
                            document.execCommand('delete', false, null);
                            await new Promise(r => setTimeout(r, 50));

                            // Insert text using execCommand (triggers framework listeners)
                            document.execCommand('insertText', false, action.text);

                            // Dispatch events
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));

                            await new Promise(r => setTimeout(r, 100));
                            const actualContent = (el.textContent || el.innerText || '').trim();
                            extraData.finalValue = actualContent;
                            success = actualContent.includes(action.text);

                            if (!success) {
                                // Fallback: direct textContent + keyboard simulation
                                el.textContent = '';
                                await simulateTyping(el, action.text);
                                el.dispatchEvent(new Event('input', { bubbles: true }));
                                extraData.fallbackToSimulateTyping = true;
                                success = true;
                                extraData.finalValue = (el.textContent || el.innerText || '').trim();
                            }
                        } else if (tag === 'select') {
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
                            // ENHANCED: Combobox-aware — detects if field is a searchable dropdown
                            // and ensures the dropdown option is actually clicked, not just typed.
                            el.focus();

                            // Detect if this is a combobox/searchable dropdown
                            const isCombobox = el.getAttribute('role') === 'combobox' ||
                                el.getAttribute('aria-haspopup') === 'listbox' ||
                                el.getAttribute('aria-haspopup') === 'true' ||
                                el.getAttribute('aria-autocomplete') === 'list' ||
                                el.getAttribute('aria-autocomplete') === 'both' ||
                                !!el.getAttribute('aria-controls') ||
                                !!el.getAttribute('aria-owns') ||
                                !!el.closest('[class*="combobox"]') ||
                                !!el.closest('[class*="autocomplete"]') ||
                                !!el.closest('[class*="searchable"]') ||
                                !!el.closest('[class*="react-select"]') ||
                                !!el.closest('[data-radix-combobox-input]');

                            if (isCombobox) {
                                extraData.isCombobox = true;
                            }

                            // Clear existing value first
                            setNativeValue(el, '');
                            await new Promise(r => setTimeout(r, 50));

                            // Strategy 1: Try native setter
                            setNativeValue(el, action.text);
                            await new Promise(r => setTimeout(r, 100));

                            // Strategy 2: If value didn't persist, use keyboard simulation
                            // For comboboxes, ALWAYS use keyboard simulation (triggers search/filter)
                            if (el.value !== action.text || isCombobox) {
                                if (el.value !== action.text) {
                                    extraData.fallbackToKeyboard = true;
                                }
                                // Clear again before keyboard sim for comboboxes
                                if (isCombobox) {
                                    setNativeValue(el, '');
                                    await new Promise(r => setTimeout(r, 50));
                                }
                                await simulateTyping(el, action.text);
                            }

                            // INTELLIGENT: Dropdown detection — ONLY for combobox/searchable fields
                            // Regular text inputs (name, email, address, etc.) should NEVER trigger
                            // dropdown detection — it wastes time and causes false positives.
                            let dropdownResult = { found: false, dropdownVisible: false, visibleOptionTexts: [] };

                            if (isCombobox) {
                                // For comboboxes, wait for API response and detect dropdown
                                await new Promise(r => setTimeout(r, 600));
                                dropdownResult = await detectAndSelectDropdownOption(el, action.text);
                                if (dropdownResult.found) {
                                    extraData.autoSelectedDropdown = true;
                                    extraData.selectedDropdownText = dropdownResult.selectedText;
                                    if (dropdownResult.matchScore) {
                                        extraData.matchScore = dropdownResult.matchScore;
                                    }
                                }
                            }

                            // POST-ACTION VERIFICATION: Check if value actually persisted
                            await new Promise(r => setTimeout(r, 100));
                            const currentVal = el.value;
                            if (currentVal === '' && !dropdownResult.found) {
                                // Value was cleared by framework — try one more time with execCommand
                                extraData.valueCleared = true;
                                await simulateTyping(el, action.text);
                                await new Promise(r => setTimeout(r, 300));

                                // Only retry dropdown detection for combobox fields
                                if (isCombobox) {
                                    const retryDropdown = await detectAndSelectDropdownOption(el, action.text);
                                    if (retryDropdown.found) {
                                        extraData.autoSelectedDropdown = true;
                                        extraData.selectedDropdownText = retryDropdown.selectedText;
                                        if (retryDropdown.matchScore) {
                                            extraData.matchScore = retryDropdown.matchScore;
                                        }
                                    } else if (retryDropdown.dropdownVisible && retryDropdown.visibleOptionTexts.length > 0) {
                                        extraData.dropdownDetectedButNotSelected = true;
                                        extraData.visibleOptionTexts = retryDropdown.visibleOptionTexts;
                                    }
                                }
                            }

                            // Flag dropdown-visible-but-not-selected ONLY for combobox fields
                            if (isCombobox && !dropdownResult.found && dropdownResult.dropdownVisible &&
                                dropdownResult.visibleOptionTexts.length > 0) {
                                extraData.dropdownDetectedButNotSelected = true;
                                extraData.visibleOptionTexts = dropdownResult.visibleOptionTexts;
                            }

                            // ENHANCED: For comboboxes, verify selection actually happened
                            // A properly selected combobox usually changes the input value or
                            // hides the input and shows a chip/tag
                            if (isCombobox && !dropdownResult.found) {
                                await new Promise(r => setTimeout(r, 200));
                                // Check if the input is now hidden (replaced by chip/tag)
                                const postStyle = window.getComputedStyle(el);
                                const postRect = el.getBoundingClientRect();
                                const inputHidden = postStyle.display === 'none' ||
                                    postStyle.visibility === 'hidden' ||
                                    postRect.height === 0;

                                if (inputHidden) {
                                    // Input was replaced by a selection chip — success
                                    extraData.autoSelectedDropdown = true;
                                    extraData.selectionConfirmedByHiddenInput = true;
                                } else {
                                    // Input still visible — check if aria-expanded is now false
                                    // (dropdown closed = selection might have happened)
                                    const expanded = el.getAttribute('aria-expanded');
                                    if (expanded === 'false' && el.value !== action.text) {
                                        // Dropdown closed and value changed — likely selected
                                        extraData.autoSelectedDropdown = true;
                                        extraData.selectionConfirmedByAriaState = true;
                                    } else if (!extraData.dropdownDetectedButNotSelected) {
                                        // Combobox but no dropdown appeared at all
                                        extraData.comboboxNoDropdownAppeared = true;
                                    }
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

                        // ENHANCED: Smart scroll container detection
                        // CRITICAL FIX: When a modal/dialog is open, ALWAYS prefer scrolling
                        // the modal content — even if the AI explicitly said "body" or "html".
                        // The AI doesn't know the correct scrollable element inside the modal.
                        let scrollContainer = null;

                        // First, check if a modal/dialog is currently open
                        const openDialog = document.querySelector('[role="dialog"]') ||
                            document.querySelector('[data-state="open"][class*="dialog"]') ||
                            document.querySelector('[class*="modal"][class*="open"]') ||
                            document.querySelector('[class*="modal"]:not([style*="display: none"])');

                        // Determine if the explicit target is a page-level element (body, html, documentElement)
                        const isPageLevelTarget = scrollTarget &&
                            (scrollTarget === document.body ||
                                scrollTarget === document.documentElement ||
                                scrollTarget.tagName === 'HTML' ||
                                scrollTarget.tagName === 'BODY');

                        if (openDialog && (!scrollTarget || isPageLevelTarget)) {
                            // Modal is open — find the scrollable content INSIDE the modal
                            // Priority: Radix scroll area > overflow:auto/scroll child > dialog itself

                            // 1. Radix UI scroll areas
                            const radixScroll = openDialog.querySelector('[data-radix-scroll-area-viewport]') ||
                                document.querySelector('[data-radix-scroll-area-viewport]');
                            if (radixScroll && radixScroll.scrollHeight > radixScroll.clientHeight) {
                                scrollContainer = radixScroll;
                            }

                            // 2. Any child with overflow-y: auto/scroll that is actually scrollable
                            if (!scrollContainer) {
                                const scrollableChildren = Array.from(openDialog.querySelectorAll('div, section, main, [class*="content"], [class*="body"]'));
                                for (const child of scrollableChildren) {
                                    const cs = window.getComputedStyle(child);
                                    if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflow === 'auto' || cs.overflow === 'scroll') &&
                                        child.scrollHeight > child.clientHeight + 10) {
                                        scrollContainer = child;
                                        break;
                                    }
                                }
                            }

                            // 3. The dialog itself (if it's scrollable)
                            if (!scrollContainer) {
                                const dialogStyle = window.getComputedStyle(openDialog);
                                if ((dialogStyle.overflowY === 'auto' || dialogStyle.overflowY === 'scroll') &&
                                    openDialog.scrollHeight > openDialog.clientHeight + 10) {
                                    scrollContainer = openDialog;
                                }
                            }

                            // 4. Last resort: find the largest child div that could be scrollable
                            if (!scrollContainer) {
                                let largestChild = null;
                                let largestHeight = 0;
                                for (const child of openDialog.querySelectorAll('div')) {
                                    if (child.scrollHeight > largestHeight && child.scrollHeight > child.clientHeight) {
                                        largestHeight = child.scrollHeight;
                                        largestChild = child;
                                    }
                                }
                                scrollContainer = largestChild || openDialog;
                            }

                            extraData.modalScrollOverride = true;
                        } else if (scrollTarget && !isPageLevelTarget) {
                            // Explicit non-page-level target provided — use it
                            scrollContainer = scrollTarget;
                        } else {
                            // No modal open, no specific target — scroll the page
                            scrollContainer = document.scrollingElement || document.documentElement;
                        }

                        // Enhancement 7: Scroll Verification + Auto-Recovery
                        const scrollBefore = scrollContainer.scrollTop;
                        const scrollAmount = Math.round(scrollContainer.clientHeight * 0.7);
                        scrollContainer.scrollBy({ top: direction * scrollAmount, behavior: 'smooth' });
                        await new Promise(r => setTimeout(r, 500));
                        const actualScrolled = scrollContainer.scrollTop - scrollBefore;

                        if (Math.abs(actualScrolled) < 5) {
                            // Scroll didn't move — try alternative containers
                            const alternatives = [
                                document.querySelector('[role="main"]'),
                                document.querySelector('main'),
                                document.querySelector('#content'),
                                document.querySelector('[class*="content"]:not([role="dialog"])'),
                                document.querySelector('[class*="scroll"]'),
                                document.scrollingElement || document.documentElement
                            ].filter(c => c && c !== scrollContainer && c.scrollHeight > c.clientHeight + 10);

                            let recovered = false;
                            for (const alt of alternatives) {
                                const altBefore = alt.scrollTop;
                                alt.scrollBy({ top: direction * Math.round(alt.clientHeight * 0.7), behavior: 'smooth' });
                                await new Promise(r => setTimeout(r, 300));
                                const altScrolled = alt.scrollTop - altBefore;
                                if (Math.abs(altScrolled) > 5) {
                                    extraData.scrollRecovery = true;
                                    extraData.recoveredContainer = alt.tagName + (alt.id ? '#' + alt.id : '');
                                    extraData.scrolled = altScrolled;
                                    extraData.scrollTarget = alt.tagName + '.' + (alt.className || '').split(' ')[0];
                                    recovered = true;
                                    success = true;
                                    break;
                                }
                            }
                            if (!recovered) {
                                extraData.scrolled = 0;
                                extraData.scrollFailed = true;
                                extraData.scrollTarget = scrollContainer.tagName;
                                extraData.hint = 'No scrollable container found. Click elements directly or use Tab.';
                                success = true; // Don't count as failure, but signal zero movement
                            }
                        } else {
                            success = true;
                            extraData.scrolled = actualScrolled;
                            extraData.scrollTarget = scrollContainer.tagName + (scrollContainer.className ? '.' + scrollContainer.className.split(' ')[0] : '');
                        }
                    }
                    // ── KEYBOARD EVENT (Enhancement 3b: for complex widgets) ──
                    else if (action.action === 'keyboard_event') {
                        const keys = action.keys || [action.key || 'Enter'];
                        const targetEl = el || document.activeElement || document.body;
                        targetEl.focus();
                        await new Promise(r => setTimeout(r, 50));

                        const keyMap = {
                            'Enter': { key: 'Enter', code: 'Enter', keyCode: 13 },
                            'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
                            'Tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
                            'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
                            'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
                            'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
                            'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
                            'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
                            'Space': { key: ' ', code: 'Space', keyCode: 32 },
                            'Delete': { key: 'Delete', code: 'Delete', keyCode: 46 },
                        };

                        const dispatched = [];
                        for (const keyName of keys) {
                            const ki = keyMap[keyName] || { key: keyName, code: keyName, keyCode: keyName.charCodeAt(0) };
                            targetEl.dispatchEvent(new KeyboardEvent('keydown', { key: ki.key, code: ki.code, keyCode: ki.keyCode, which: ki.keyCode, bubbles: true, cancelable: true }));
                            targetEl.dispatchEvent(new KeyboardEvent('keypress', { key: ki.key, code: ki.code, keyCode: ki.keyCode, which: ki.keyCode, bubbles: true, cancelable: true }));
                            targetEl.dispatchEvent(new KeyboardEvent('keyup', { key: ki.key, code: ki.code, keyCode: ki.keyCode, which: ki.keyCode, bubbles: true, cancelable: true }));
                            dispatched.push(keyName);
                            await new Promise(r => setTimeout(r, 100));
                        }
                        success = true;
                        extraData.keysDispatched = dispatched;
                    }
                    // ── CLICK COORDINATE (Enhanced: fallback visual click with Universal Event Dispatcher) ──
                    else if (action.action === 'click_coordinate') {
                        // Click by SoM bounding box center coordinates, direct x/y, or element center
                        let clickX, clickY, clickedEl;
                        if (action.somIndex && action.boundingBox) {
                            const bb = action.boundingBox;
                            clickX = bb.x + bb.width / 2;
                            clickY = bb.y + bb.height / 2;
                        } else if (action.x !== undefined && action.y !== undefined) {
                            // Direct coordinate click (AI provides x, y directly)
                            clickX = action.x;
                            clickY = action.y;
                        } else if (el) {
                            const rect = el.getBoundingClientRect();
                            clickX = rect.x + rect.width / 2;
                            clickY = rect.y + rect.height / 2;
                        } else {
                            throw new Error('click_coordinate requires somIndex with boundingBox, x/y coordinates, or a valid selector');
                        }

                        // Scroll element into view if coordinates are off-screen
                        if (clickY < 0 || clickY > window.innerHeight || clickX < 0 || clickX > window.innerWidth) {
                            window.scrollBy({ top: clickY - window.innerHeight / 2, behavior: 'smooth' });
                            await new Promise(r => setTimeout(r, 400));
                            // Recalculate if we had a bounding box (it's relative to viewport)
                            if (el) {
                                const newRect = el.getBoundingClientRect();
                                clickX = newRect.x + newRect.width / 2;
                                clickY = newRect.y + newRect.height / 2;
                            }
                        }

                        clickedEl = document.elementFromPoint(clickX, clickY);
                        if (clickedEl) {
                            // Universal Event Dispatcher for coordinate clicks
                            dispatchUniversalClick(clickedEl);
                            success = true;
                            extraData.clickedTag = clickedEl.tagName;
                            extraData.clickedText = (clickedEl.textContent || '').trim().slice(0, 50);
                            extraData.coordinates = { x: clickX, y: clickY };
                        } else {
                            throw new Error(`No element at coordinates (${clickX}, ${clickY})`);
                        }
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

        // ─── FIND AND CLICK SUBMIT BUTTON (direct recovery) ────
        if (message.type === 'FIND_AND_CLICK_SUBMIT') {
            (async () => {
                try {
                    const submitSelectors = [
                        'button[type="submit"]',
                        'input[type="submit"]',
                        '[role="dialog"] button[type="submit"]',
                        '[role="dialog"] form button:last-of-type',
                        'form button[type="submit"]',
                        'button[class*="submit" i]',
                        'button[class*="save" i]',
                    ];
                    const submitTexts = ['add patient', 'save', 'submit', 'create', 'add', 'register', 'confirm', 'update'];
                    let clicked = false;
                    let clickedSelector = '';
                    let clickedText = '';

                    // Strategy 1: Direct CSS selectors
                    for (const sel of submitSelectors) {
                        try {
                            const buttons = document.querySelectorAll(sel);
                            for (const btn of buttons) {
                                const style = window.getComputedStyle(btn);
                                if (style.display === 'none' || style.visibility === 'hidden') continue;
                                const rect = btn.getBoundingClientRect();
                                if (rect.width === 0 || rect.height === 0) continue;
                                const btnText = (btn.textContent || '').trim().toLowerCase();
                                if (btnText.includes('cancel') || btnText.includes('close') || btnText.includes('reset')) continue;
                                btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                await new Promise(r => setTimeout(r, 300));
                                btn.click();
                                btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                                btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                                clicked = true;
                                clickedSelector = generateCss(btn);
                                clickedText = (btn.textContent || '').trim();
                                break;
                            }
                        } catch (e) { /* ignore */ }
                        if (clicked) break;
                    }

                    // Strategy 2: Search all buttons by text content
                    if (!clicked) {
                        const allButtons = document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]');
                        for (const btn of allButtons) {
                            const btnText = (btn.textContent || btn.value || '').trim().toLowerCase();
                            const style = window.getComputedStyle(btn);
                            if (style.display === 'none' || style.visibility === 'hidden') continue;
                            if (btnText.includes('cancel') || btnText.includes('close') || btnText.includes('reset')) continue;
                            for (const word of submitTexts) {
                                if (btnText.includes(word)) {
                                    btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                    await new Promise(r => setTimeout(r, 300));
                                    btn.click();
                                    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                                    btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                                    clicked = true;
                                    clickedSelector = generateCss(btn);
                                    clickedText = (btn.textContent || '').trim();
                                    break;
                                }
                            }
                            if (clicked) break;
                        }
                    }

                    // Strategy 3: Last button inside form in dialog
                    if (!clicked) {
                        const form = document.querySelector('[role="dialog"] form') || document.querySelector('form');
                        if (form) {
                            const formButtons = form.querySelectorAll('button');
                            if (formButtons.length > 0) {
                                const lastBtn = formButtons[formButtons.length - 1];
                                const btnText = (lastBtn.textContent || '').trim().toLowerCase();
                                if (!btnText.includes('cancel') && !btnText.includes('close')) {
                                    lastBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                    await new Promise(r => setTimeout(r, 300));
                                    lastBtn.click();
                                    clicked = true;
                                    clickedSelector = generateCss(lastBtn);
                                    clickedText = (lastBtn.textContent || '').trim();
                                }
                            }
                        }
                    }

                    sendResponse({ success: clicked, clickedSelector, clickedText, method: 'FIND_AND_CLICK_SUBMIT' });
                } catch (e) {
                    sendResponse({ success: false, error: e.message });
                }
            })();
            return true;
        }

        // ─── BATCH FILL FORM FIELDS ──────────────────────────────
        if (message.type === 'BATCH_FILL') {
            const fields = message.payload?.fields || [];
            (async () => {
                const results = [];
                for (const field of fields) {
                    try {
                        let selector = field.selector;
                        if (!selector && field.field) {
                            const resolvedField = resolveFieldByIntent(field.field);
                            if (!resolvedField) {
                                results.push({ field: field.field, selector: null, success: false, error: 'Field not found' });
                                continue;
                            }
                            selector = resolvedField.selector;
                            field.resolvedFieldIntent = { label: resolvedField.label, section: resolvedField.section, score: resolvedField.score };
                        }
                        const el = document.querySelector(selector);
                        if (!el) { results.push({ selector, success: false, error: 'Not found' }); continue; }
                        el.scrollIntoView({ behavior: 'instant', block: 'center' });
                        el.focus();
                        const tag = el.tagName.toLowerCase();
                        const inputType = (el.getAttribute('type') || '').toLowerCase();
                        if (tag === 'select') {
                            const options = Array.from(el.options);
                            const optText = (field.text || field.option || '').trim();
                            const targetOpt = options.find(o => o.text.trim().toLowerCase() === optText.toLowerCase() || o.value.toLowerCase() === optText.toLowerCase())
                                || options.find(o => o.text.trim().toLowerCase().includes(optText.toLowerCase()));
                            if (targetOpt) { setNativeValue(el, targetOpt.value); results.push({ selector, success: true, value: targetOpt.text.trim() }); }
                            else { results.push({ selector, success: false, error: 'Option not found' }); }
                        } else if (inputType === 'date') {
                            const dateValue = parseDateToISO(field.text);
                            setNativeValue(el, dateValue || field.text);
                            results.push({ selector, success: true, value: dateValue || field.text });
                        } else {
                            const isCombobox = el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox' || !!el.getAttribute('aria-controls');
                            setNativeValue(el, '');
                            await new Promise(r => setTimeout(r, 30));
                            setNativeValue(el, field.text);
                            await new Promise(r => setTimeout(r, 50));
                            if (el.value !== field.text || isCombobox) {
                                if (isCombobox) setNativeValue(el, '');
                                await simulateTyping(el, field.text);
                            }
                            if (isCombobox) {
                                await new Promise(r => setTimeout(r, 600));
                                const dropResult = await detectAndSelectDropdownOption(el, field.text);
                                results.push({ selector, success: true, value: el.value, isCombobox: true, autoSelected: dropResult.found });
                            } else {
                                results.push({ selector, success: true, value: el.value });
                            }
                        }
                        await new Promise(r => setTimeout(r, 80));
                    } catch (e) { results.push({ selector: selector || field.selector, success: false, error: e.message }); }
                }
                sendResponse({ success: true, results, filledCount: results.filter(r => r.success).length });
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

    // ─── HEURISTIC SELECTOR GENERATOR ───────────────────────────
    // Prioritizes stable accessibility attributes and filters dynamic
    // framework-generated IDs from Radix UI, MUI, and HeadlessUI.
    // This prevents selectors like #radix-_r_6m_ that change on every render.

    /**
     * Detects whether an element ID is dynamically generated by a UI framework.
     * Matches patterns: radix-:r1:, radix-_r_6m_, mui-2938, headlessui-dialog-1,
     * react-select-*, random hex hashes, purely numeric IDs, etc.
     */
    function isDynamicId(id) {
        if (!id) return true;
        // Radix UI patterns: radix-:rXX:, radix-_r_XX_, :rXX:, contains colons with alphanumeric
        if (/^:r[0-9a-z_]+:/i.test(id)) return true;
        if (/radix-/i.test(id)) return true;
        // MUI patterns: mui-XXXXX (digits)
        if (/^mui-\d+/i.test(id)) return true;
        // HeadlessUI patterns: headlessui-TYPE-NUMBER
        if (/^headlessui-/i.test(id)) return true;
        // React-Select patterns: react-select-*
        if (/^react-select-/i.test(id)) return true;
        // Purely numeric IDs (often auto-generated)
        if (/^\d+$/.test(id)) return true;
        // IDs that are mostly hex characters (webpack/vite hashes)
        if (/^[0-9a-f]{6,}$/i.test(id)) return true;
        // IDs with random-looking patterns (mix of letters/numbers/underscores with no semantic meaning)
        if (/^[a-z]{1,3}[-_][0-9a-z_]{3,}$/i.test(id) && id.length > 8) return true;
        return false;
    }

    function generateCss(el) {
        // 1. HIGHEST PRIORITY: Stable accessibility & testing attributes
        // These survive UI re-renders and framework updates
        const stableAttributes = ['data-testid', 'data-cy', 'data-test', 'aria-label', 'name'];
        for (const attr of stableAttributes) {
            const val = el.getAttribute(attr);
            if (val && val.trim() !== '') {
                const selector = `${el.tagName.toLowerCase()}[${attr}="${escapeCss(val)}"]`;
                try {
                    if (document.querySelectorAll(selector).length === 1) return selector;
                } catch (e) { /* invalid selector, skip */ }
            }
        }

        // 2. Role-based selectors (stable across renders for Radix/MUI/HeadlessUI)
        const role = el.getAttribute('role');
        if (role) {
            const ariaLabel = el.getAttribute('aria-label');
            if (ariaLabel) {
                const selector = `[role="${role}"][aria-label="${escapeCss(ariaLabel)}"]`;
                try {
                    if (document.querySelectorAll(selector).length === 1) return selector;
                } catch (e) { /* skip */ }
            }
        }

        // 3. Stable IDs only (filter out framework-generated dynamic IDs)
        if (el.id && !isDynamicId(el.id)) {
            return '#' + escapeCss(el.id);
        }

        // 4. Name attribute (forms)
        if (el.name) {
            const nameSel = el.tagName.toLowerCase() + '[name="' + escapeCss(el.name) + '"]';
            try {
                if (document.querySelectorAll(nameSel).length === 1) return nameSel;
            } catch (e) { /* skip */ }
        }

        // 5. Placeholder attribute (inputs)
        if (el.placeholder) {
            const phSel = el.tagName.toLowerCase() + '[placeholder="' + escapeCss(el.placeholder) + '"]';
            try {
                if (document.querySelectorAll(phSel).length === 1) return phSel;
            } catch (e) { /* skip */ }
        }

        // 6. FALLBACK: Structural hierarchy (nth-of-type chain)
        // Only uses stable IDs as anchor points in the chain
        const path = [];
        let current = el;
        while (current && current.nodeType === 1) {
            let selector = current.tagName.toLowerCase();
            if (current.id && !isDynamicId(current.id)) {
                selector = '#' + escapeCss(current.id);
                path.unshift(selector);
                break;
            }
            // Use stable attributes as anchor if available
            const stableAttr = current.getAttribute('data-testid') || current.getAttribute('aria-label');
            if (stableAttr && current !== el) {
                const anchorSel = `[data-testid="${escapeCss(stableAttr)}"]`;
                try {
                    if (document.querySelectorAll(anchorSel).length === 1) {
                        path.unshift(anchorSel);
                        break;
                    }
                } catch (e) { /* skip */ }
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

    // ─── HELPER: Is this element directly typable? ───
    function isTypableElement(el) {
        if (!el || !el.tagName) return false;
        const tag = el.tagName.toLowerCase();
        if (tag === 'input') {
            const t = (el.getAttribute('type') || 'text').toLowerCase();
            return !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color'].includes(t);
        }
        if (tag === 'textarea') return true;
        if (el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '') return true;
        return false;
    }

    // ─── HELPER: Resolve the real typable <input> for a combobox/searchable control ───
    // Field-intent (e.g. patient_search) and some selectors resolve to a combobox
    // TRIGGER (a div/button) instead of the inner text input. Typing into a non-input
    // throws "Illegal invocation" and nothing is entered. This finds (or opens to reveal)
    // the actual input so ALL API-backed searchable dropdowns become typable.
    async function resolveTypableTarget(el) {
        const findInside = (root) => {
            if (!root || !root.querySelectorAll) return null;
            const cands = Array.from(root.querySelectorAll(
                'input:not([type="hidden"]), textarea, [contenteditable="true"], [contenteditable=""]'
            ));
            return cands.find(c => isTypableElement(c) && isElementVisible(c)) || null;
        };

        const container = el.closest(
            '[class*="combobox"], [class*="autocomplete"], [class*="searchable"], ' +
            '[class*="react-select"], [class*="select"], [role="combobox"]'
        ) || el.parentElement || el;

        // 1. Input already present inside the control/container.
        let inner = findInside(el) || findInside(container);
        if (inner) return inner;

        // 2. Not present yet — open the control, then look again.
        try { dispatchUniversalClick(el); } catch (e) { try { el.click(); } catch (e2) { /* ignore */ } }
        await new Promise(r => setTimeout(r, 350));

        // 2a. The opened control usually focuses its search input.
        const active = document.activeElement;
        if (isTypableElement(active) && isElementVisible(active)) return active;

        // 2b. Re-scan the control/container.
        inner = findInside(el) || findInside(container);
        if (inner) return inner;

        // 2c. Last resort — scan freshly opened popups/portals (not the whole body).
        const popupSelectors = [
            '[data-radix-popper-content-wrapper]', '[role="dialog"]', '[role="listbox"]',
            '[class*="popover"]', '[class*="dropdown"]', '[class*="menu"]', '[class*="popup"]'
        ];
        for (const sel of popupSelectors) {
            for (const root of document.querySelectorAll(sel)) {
                const cand = findInside(root);
                if (cand) return cand;
            }
        }
        return null;
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

        // Guard each native setter with an instanceof check. Calling a prototype value
        // setter on an element it does not belong to (e.g. a <div role="combobox"> trigger)
        // throws "Illegal invocation". The try/catch guarantees we never surface that error
        // to the caller and always fall back to a safe assignment.
        try {
            if (tag === 'select' && nativeSelectValueSetter && el instanceof window.HTMLSelectElement) {
                nativeSelectValueSetter.call(el, value);
            } else if (tag === 'textarea' && nativeTextareaValueSetter && el instanceof window.HTMLTextAreaElement) {
                nativeTextareaValueSetter.call(el, value);
            } else if (nativeInputValueSetter && el instanceof window.HTMLInputElement) {
                nativeInputValueSetter.call(el, value);
            } else if ('value' in el) {
                el.value = value;
            }
        } catch (e) {
            try { if ('value' in el) el.value = value; } catch (e2) { /* ignore */ }
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
    // CMS-1500 forms use MM/DD/YYYY format. This parser handles all common formats
    // and defaults to US format (MM/DD/YYYY) since that's the healthcare standard.
    function parseDateToISO(dateStr) {
        if (!dateStr) return null;
        const str = dateStr.trim();

        // Already in YYYY-MM-DD format (ISO)
        if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

        // YYYY/MM/DD
        let match = str.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
        if (match) {
            const [, year, month, day] = match;
            return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        }

        // Two-part date with 4-digit year at end: XX/XX/YYYY
        match = str.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
        if (match) {
            const [, part1, part2, year] = match;
            const p1 = parseInt(part1);
            const p2 = parseInt(part2);

            // If part1 > 12, it MUST be day (DD/MM/YYYY format)
            if (p1 > 12) {
                return `${year}-${part2.padStart(2, '0')}-${part1.padStart(2, '0')}`;
            }
            // If part2 > 12, it MUST be day (MM/DD/YYYY format)
            if (p2 > 12) {
                return `${year}-${part1.padStart(2, '0')}-${part2.padStart(2, '0')}`;
            }
            // Both <= 12: Default to MM/DD/YYYY (US healthcare standard for CMS-1500)
            return `${year}-${part1.padStart(2, '0')}-${part2.padStart(2, '0')}`;
        }

        // Two-part date with 2-digit year: XX/XX/YY
        match = str.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2})$/);
        if (match) {
            const [, part1, part2, shortYear] = match;
            const year = parseInt(shortYear) > 50 ? '19' + shortYear : '20' + shortYear;
            const p1 = parseInt(part1);
            const p2 = parseInt(part2);
            if (p1 > 12) return `${year}-${part2.padStart(2, '0')}-${part1.padStart(2, '0')}`;
            if (p2 > 12) return `${year}-${part1.padStart(2, '0')}-${part2.padStart(2, '0')}`;
            // Default: MM/DD/YY (US format)
            return `${year}-${part1.padStart(2, '0')}-${part2.padStart(2, '0')}`;
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
    // ENHANCED: Polling-based detection with expanded selectors and fuzzy matching.
    // Handles API-backed searchable dropdowns, comboboxes, Radix UI, shadcn/ui,
    // CMDK, React-Select, Headless UI, and any custom dropdown pattern dynamically.
    async function detectAndSelectDropdownOption(inputEl, searchText) {
        const result = { found: false, selectedText: '', dropdownVisible: false, visibleOptionTexts: [] };

        // Comprehensive dropdown container selectors covering all major UI libraries
        const dropdownSelectors = [
            // ARIA standard patterns (most reliable)
            '[role="listbox"]', '[role="menu"]',
            '.dropdown-menu.show', '.autocomplete-results', '.suggestions',

            // Radix UI / shadcn/ui (used by Medora, modern React apps)
            '[data-radix-popper-content-wrapper]',
            '[data-radix-menu-content]',
            '[data-radix-select-content]',
            '[data-radix-combobox-content]',
            '[data-radix-popover-content]',

            // CMDK (Command Menu — popular in modern apps)
            '[cmdk-list]', '[cmdk-group]',

            // React-Select
            '[class*="react-select__menu"]',
            '[class*="-menu"][id*="react-select"]',

            // Headless UI (Tailwind ecosystem)
            '[data-headless-state="open"]',
            '[data-headlessui-state*="open"]',

            // Material UI / MUI
            '.MuiAutocomplete-popper', '.MuiAutocomplete-listbox',
            '.MuiMenu-list', '.MuiPopover-paper',
            '.MuiPopper-root',

            // Ant Design
            '.ant-select-dropdown', '.ant-cascader-dropdown',
            '.ant-select-dropdown-menu',

            // PrimeReact / PrimeFaces
            '.p-autocomplete-panel', '.p-dropdown-panel',
            '.p-listbox', '.p-multiselect-panel',

            // Chakra UI
            '[class*="chakra-menu__menu-list"]',
            '[class*="chakra-popover__content"]',

            // Custom patterns (common in healthcare/enterprise apps)
            '[class*="dropdown"][class*="open"]', '[class*="dropdown"][class*="show"]',
            '[class*="dropdown"][class*="visible"]', '[class*="dropdown"][class*="active"]',
            '[class*="autocomplete"]', '[class*="suggestion"]',
            '[class*="listbox"]', '[class*="combobox"][class*="list"]', '[class*="typeahead"]',
            '[class*="search-results"]', '[class*="search-dropdown"]',

            // Portal-based dropdowns (rendered at body level — common in React)
            // NOTE: Removed overly broad 'body > div[style*="position"]' selectors
            // as they match modals/dialogs and cause false positives
            'body > [role="listbox"]',
            'body > [class*="popover"]:not([role="dialog"])',

            // Floating UI (used by many modern libs)
            '[data-floating-ui-portal]',
            '[data-popper-placement]',
            '[data-popper-reference-hidden="false"]'
        ];

        // Option element selectors (what to look for INSIDE containers)
        // NOTE: Removed bare 'li', 'a', 'button' — too broad, matches modal/form elements
        // Only match elements that are clearly dropdown options
        const optionSelectors = [
            '[role="option"]',
            '[cmdk-item]',
            '[data-radix-collection-item]',
            '[data-value]',
            '[class*="react-select__option"]',
            '[class*="option"]:not([class*="optional"])',
            '[class*="item"]:not([class*="item-group"]):not([class*="form-item"]):not([class*="nav-item"])',
            '[class*="result"]',
            'li[role="option"]', 'li[data-value]', 'li[class*="option"]', 'li[class*="item"]',
            'div[tabindex]', 'div[data-index]',
            'div[class*="cursor-pointer"]', 'div[class*="hover"]',
            '.ant-select-item-option',
            '.MuiAutocomplete-option', '.MuiMenuItem-root',
            '.p-autocomplete-item', '.p-dropdown-item',
            '.dropdown-item',
            // Radix popper children — often plain divs acting as options
            '[data-radix-popper-content-wrapper] > div > div',
            '[data-radix-popper-content-wrapper] > div > div > div'
        ].join(', ');

        // Fallback: for containers where standard selectors don't match,
        // look for any visible div/span children that have text and look clickable
        const fallbackOptionSelector = 'div, span, li, a';

        // Elements that should NEVER be considered dropdown containers
        const excludeContainerSelectors = '[role="dialog"], [role="form"], form, [class*="modal"], [class*="dialog"], [class*="drawer"]';

        // ENHANCED: Fuzzy text matching function
        function textMatches(optText, searchText) {
            if (!optText || !searchText) return false;
            const optLower = optText.toLowerCase().trim();
            const searchLower = searchText.toLowerCase().trim();
            const firstLine = optLower.split('\n')[0].trim();

            // Exact match
            if (optLower === searchLower) return true;
            if (firstLine === searchLower) return true;

            // First line starts with search text
            if (firstLine.startsWith(searchLower)) return true;

            // Search text is contained in option (or first line)
            if (optLower.includes(searchLower)) return true;
            if (firstLine.includes(searchLower)) return true;

            // Option text starts with search text (common for autocomplete)
            if (optLower.startsWith(searchLower)) return true;

            // Prefer patient-style "Lastname, Firstname" options when the search term is the first name.
            const commaMatch = firstLine.match(/^([^,]+),\s*(.+)$/);
            if (commaMatch) {
                const first = commaMatch[2].trim().split(/\s+/)[0].toLowerCase();
                if (first === searchLower) return true;
                if (first.startsWith(searchLower)) return true;
            }

            // Search text contains the option's first line (reverse containment)
            if (searchLower.includes(firstLine) && firstLine.length > 2) return true;

            // Word-boundary match: search text matches a word in the option
            const words = firstLine.split(/[\s,;|]+/);
            if (words.some(w => w === searchLower || w.startsWith(searchLower))) return true;

            return false;
        }

        // ENHANCED: Score-based matching for best option selection
        function matchScore(optText, searchText) {
            if (!optText || !searchText) return 0;
            const optLower = optText.toLowerCase().trim();
            const searchLower = searchText.toLowerCase().trim();
            const firstLine = optLower.split('\n')[0].trim();

            if (firstLine === searchLower) return 100;  // Perfect first-line match
            if (optLower === searchLower) return 95;    // Perfect full-text match
            if (firstLine.startsWith(searchLower)) return 80;  // Starts with
            if (optLower.startsWith(searchLower)) return 75;
            if (firstLine.includes(searchLower)) return 60;    // Contains in first line
            if (optLower.includes(searchLower)) return 40;     // Contains anywhere

            // Patient-style "Lastname, Firstname" match when the search term is the first name.
            const commaMatch = firstLine.match(/^([^,]+),\s*(.+)$/);
            if (commaMatch) {
                const first = commaMatch[2].trim().split(/\s+/)[0].toLowerCase();
                if (first === searchLower) return 92;
                if (first.startsWith(searchLower)) return 86;
            }

            if (searchLower.includes(firstLine) && firstLine.length > 2) return 30;
            return 0;
        }

        // ENHANCED: Polling loop — wait up to 1500ms for dropdown to appear
        // API-backed dropdowns (like insurance payer search) need time to fetch results
        const MAX_DROPDOWN_WAIT_MS = 1500;
        const POLL_INTERVAL_MS = 150;
        let totalElapsed = 0;

        while (totalElapsed < MAX_DROPDOWN_WAIT_MS) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
            totalElapsed += POLL_INTERVAL_MS;

            // Scan all dropdown container selectors
            for (const sel of dropdownSelectors) {
                try {
                    const containers = document.querySelectorAll(sel);
                    for (const container of containers) {
                        const style = window.getComputedStyle(container);
                        if (style.display === 'none' || style.visibility === 'hidden') continue;
                        if (parseFloat(style.opacity) === 0) continue;
                        const rect = container.getBoundingClientRect();
                        if (rect.width < 10 || rect.height < 10) continue;

                        // CRITICAL: Skip containers that are clearly NOT dropdowns
                        // (modals, dialogs, forms, drawers — these match broad selectors)
                        // BUT: Never skip known dropdown containers (Radix popper, listbox, etc.)
                        const isDefinitelyDropdown = container.matches(
                            '[data-radix-popper-content-wrapper], [data-radix-menu-content], ' +
                            '[data-radix-select-content], [data-radix-combobox-content], ' +
                            '[role="listbox"], [cmdk-list], [data-floating-ui-portal], ' +
                            '[data-popper-placement], .MuiAutocomplete-popper, .MuiAutocomplete-listbox, ' +
                            '.ant-select-dropdown, [class*="react-select__menu"]'
                        );
                        if (!isDefinitelyDropdown) {
                            if (container.matches(excludeContainerSelectors)) continue;
                            if (container.closest('[role="dialog"]') && !container.closest('[role="listbox"]')) continue;
                        }

                        // Skip containers that are too large to be a dropdown
                        // (dropdowns are typically < 500px tall; modals are larger)
                        if (rect.height > 600 && rect.width > 500) continue;

                        // Found a visible dropdown container — look for options inside
                        let options = container.querySelectorAll(optionSelectors);

                        // FALLBACK: If standard selectors find nothing in a known dropdown container,
                        // try the fallback selector (any div/span/li children with text)
                        // This handles custom components like Medora's payer dropdown where
                        // options are plain divs without role="option" or class*="option"
                        if (options.length === 0) {
                            const isKnownDropdown = container.matches(
                                '[data-radix-popper-content-wrapper], [data-radix-menu-content], ' +
                                '[data-radix-select-content], [data-radix-combobox-content], ' +
                                '[role="listbox"], [cmdk-list], [data-floating-ui-portal], ' +
                                '[data-popper-placement], .MuiAutocomplete-popper'
                            );
                            if (isKnownDropdown) {
                                // Use fallback: get all direct-ish children that could be options
                                options = container.querySelectorAll(fallbackOptionSelector);
                            }
                            if (options.length === 0) continue;
                        }

                        // Count actually visible options with text content
                        let visibleOptionCount = 0;
                        for (const opt of options) {
                            const os = window.getComputedStyle(opt);
                            if (os.display === 'none' || os.visibility === 'hidden') continue;
                            const or = opt.getBoundingClientRect();
                            if (or.width < 5 || or.height < 5) continue;
                            const ot = (opt.textContent || '').trim();
                            if (ot && ot.length > 0 && ot.length < 500) visibleOptionCount++;
                            if (visibleOptionCount >= 1) break; // At least 1 real option needed
                        }
                        if (visibleOptionCount === 0) continue;

                        // Mark that we found a REAL visible dropdown with actual options
                        result.dropdownVisible = true;

                        // Collect visible option texts for AI feedback
                        let bestMatch = null;
                        let bestScore = 0;

                        for (const opt of options) {
                            const optStyle = window.getComputedStyle(opt);
                            if (optStyle.display === 'none' || optStyle.visibility === 'hidden') continue;
                            if (parseFloat(optStyle.opacity) === 0) continue;
                            const optRect = opt.getBoundingClientRect();
                            if (optRect.width < 5 || optRect.height < 5) continue;

                            const optText = (opt.textContent || '').trim();
                            if (!optText || optText.length > 500) continue;

                            // Collect for AI feedback (first line only, limit to 10)
                            const firstLine = optText.split('\n')[0].trim();
                            if (result.visibleOptionTexts.length < 10 && firstLine.length < 100) {
                                if (!result.visibleOptionTexts.includes(firstLine)) {
                                    result.visibleOptionTexts.push(firstLine);
                                }
                            }

                            // Score this option
                            const score = matchScore(optText, searchText);
                            if (score > bestScore) {
                                bestScore = score;
                                bestMatch = opt;
                            }
                        }

                        // If we found a good match (score >= 30), click it
                        if (bestMatch && bestScore >= 30) {
                            bestMatch.scrollIntoView({ block: 'center' });
                            await new Promise(r => setTimeout(r, 50));

                            // Multi-event click for maximum framework compatibility
                            bestMatch.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                            bestMatch.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                            bestMatch.click();

                            // Some frameworks need pointer events
                            bestMatch.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
                            bestMatch.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));

                            await new Promise(r => setTimeout(r, 300));

                            result.found = true;
                            result.selectedText = (bestMatch.textContent || '').trim().split('\n')[0].trim();
                            result.matchScore = bestScore;
                            return result;
                        }
                    }
                } catch (e) { /* ignore selector errors */ }
            }

            // Also check ARIA-linked dropdown (via aria-controls on the input)
            const ariaControls = inputEl.getAttribute('aria-controls') || inputEl.getAttribute('aria-owns');
            if (ariaControls) {
                try {
                    const linkedContainer = document.getElementById(ariaControls);
                    if (linkedContainer) {
                        const lcStyle = window.getComputedStyle(linkedContainer);
                        const lcRect = linkedContainer.getBoundingClientRect();
                        if (lcStyle.display !== 'none' && lcStyle.visibility !== 'hidden' &&
                            lcRect.width > 0 && lcRect.height > 0) {

                            result.dropdownVisible = true;
                            const options = linkedContainer.querySelectorAll(optionSelectors);
                            let bestMatch = null;
                            let bestScore = 0;

                            for (const opt of options) {
                                const optStyle = window.getComputedStyle(opt);
                                if (optStyle.display === 'none' || optStyle.visibility === 'hidden') continue;
                                const optRect = opt.getBoundingClientRect();
                                if (optRect.width < 5 || optRect.height < 5) continue;
                                const optText = (opt.textContent || '').trim();
                                if (!optText || optText.length > 500) continue;

                                const firstLine = optText.split('\n')[0].trim();
                                if (result.visibleOptionTexts.length < 10 && firstLine.length < 100) {
                                    if (!result.visibleOptionTexts.includes(firstLine)) {
                                        result.visibleOptionTexts.push(firstLine);
                                    }
                                }

                                const score = matchScore(optText, searchText);
                                if (score > bestScore) {
                                    bestScore = score;
                                    bestMatch = opt;
                                }
                            }

                            if (bestMatch && bestScore >= 30) {
                                bestMatch.scrollIntoView({ block: 'center' });
                                await new Promise(r => setTimeout(r, 50));
                                bestMatch.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                                bestMatch.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                                bestMatch.click();
                                bestMatch.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
                                bestMatch.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
                                await new Promise(r => setTimeout(r, 300));
                                result.found = true;
                                result.selectedText = (bestMatch.textContent || '').trim().split('\n')[0].trim();
                                result.matchScore = bestScore;
                                return result;
                            }
                        }
                    }
                } catch (e) { /* ignore */ }
            }

            // If dropdown is visible but no match yet, keep polling (API might still be loading)
            // If no dropdown visible at all after 600ms, stop early
            if (!result.dropdownVisible && totalElapsed > 600) break;
        }

        // Final attempt: check for options that are direct siblings or nearby the input
        const parentContainers = [
            inputEl.closest('[class*="combobox"]'),
            inputEl.closest('[class*="select"]'),
            inputEl.closest('[class*="search"]'),
            inputEl.closest('[class*="autocomplete"]'),
            inputEl.closest('.form-group'),
            inputEl.closest('.field'),
            inputEl.parentElement?.parentElement,
            inputEl.parentElement
        ].filter(Boolean);

        for (const parent of parentContainers) {
            const nearbyOptions = parent.querySelectorAll(optionSelectors);
            let bestMatch = null;
            let bestScore = 0;

            for (const opt of nearbyOptions) {
                if (opt === inputEl) continue; // Skip the input itself
                const style = window.getComputedStyle(opt);
                if (style.display === 'none' || style.visibility === 'hidden') continue;
                const rect = opt.getBoundingClientRect();
                if (rect.width < 5 || rect.height < 5) continue;
                const optText = (opt.textContent || '').trim();
                if (!optText || optText.length > 500) continue;

                const firstLine = optText.split('\n')[0].trim();
                if (result.visibleOptionTexts.length < 10 && firstLine.length < 100) {
                    if (!result.visibleOptionTexts.includes(firstLine)) {
                        result.visibleOptionTexts.push(firstLine);
                    }
                }

                const score = matchScore(optText, searchText);
                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = opt;
                }
            }

            if (bestMatch && bestScore >= 30) {
                bestMatch.scrollIntoView({ block: 'center' });
                await new Promise(r => setTimeout(r, 50));
                bestMatch.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                bestMatch.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                bestMatch.click();
                bestMatch.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
                bestMatch.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
                await new Promise(r => setTimeout(r, 300));
                result.found = true;
                result.selectedText = (bestMatch.textContent || '').trim().split('\n')[0].trim();
                result.matchScore = bestScore;
                return result;
            }
        }

        return result;
    }

    // ─── HELPER: Simulate keyboard typing character by character ───
    // HUMAN-DELAY TYPING: Introduces realistic 50-100ms inter-keystroke delays
    // to trigger React/Radix debounced onChange handlers and API-backed combobox
    // search endpoints that ignore robotic-speed input.
    // After the final character, waits 800ms for network requests to resolve
    // (e.g., fetching "Aetna" insurance payer results from an API).
    async function simulateTyping(el, text) {
        el.focus();

        // Clear existing content using select-all + delete
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true }));
        document.execCommand('selectAll', false, null);
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', bubbles: true }));
        document.execCommand('delete', false, null);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 80));

        // Type each character with realistic human-speed delays
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

            // Human-speed delay: 50-100ms between keystrokes
            // This ensures debounced React onChange and API search handlers fire correctly
            const delay = 50 + Math.floor(Math.random() * 50);
            await new Promise(r => setTimeout(r, delay));
        }

        // Dispatch input event after each character is done to ensure frameworks see final value
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));

        // POST-TYPING NETWORK SETTLE: Wait 800ms for API-backed comboboxes
        // to fetch results and populate the dropdown DOM.
        // This is critical for searchable fields like insurance payer lookups
        // where the server needs time to return matching results.
        await new Promise(r => setTimeout(r, 800));

        // Final blur to close any transient UI states
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

                // ENHANCED: Detect combobox/searchable dropdown elements
                // These require type-then-select interaction (not just type or select_option)
                const elRole = el.getAttribute('role') || '';
                const ariaHasPopup = el.getAttribute('aria-haspopup') || '';
                const ariaAutocomplete = el.getAttribute('aria-autocomplete') || '';
                const ariaExpanded = el.getAttribute('aria-expanded');
                const ariaControls = el.getAttribute('aria-controls') || el.getAttribute('aria-owns') || '';

                let isCombobox = false;
                if (elRole === 'combobox' || elRole === 'searchbox' ||
                    ariaHasPopup === 'listbox' || ariaHasPopup === 'true' ||
                    ariaAutocomplete === 'list' || ariaAutocomplete === 'both' ||
                    ariaControls !== '' ||
                    !!el.closest('[class*="combobox"]') ||
                    !!el.closest('[class*="autocomplete"]') ||
                    !!el.closest('[class*="searchable"]') ||
                    !!el.closest('[class*="react-select"]') ||
                    !!el.closest('[data-radix-combobox-input]')) {
                    isCombobox = true;
                    roleHint = 'combobox'; // Override roleHint for AI understanding
                }

                const text = (el.textContent || el.value || label || '').trim().slice(0, 200);

                let priority = 0;
                if (tag === 'input' || tag === 'textarea') priority = 10;
                if (isCombobox) priority = 11; // Comboboxes get highest priority (need special handling)
                if (tag === 'select' || roleHint === 'listbox') priority = 5;
                if (tag === 'button' || roleHint === 'button') priority = 3;
                if (tag === 'a' || roleHint === 'link') priority = 2;

                // BOOST: Submit/Save/Add buttons get highest priority so they're always
                // included in the elements list — prevents "can't find submit button" problem
                if (roleHint === 'button' || tag === 'button' || inputType === 'submit') {
                    const buttonText = (el.textContent || el.value || '').trim().toLowerCase();
                    if (inputType === 'submit' || el.type === 'submit' ||
                        /\b(submit|save|add|create|register|confirm|update|next|continue)\b/.test(buttonText)) {
                        priority = 12;
                    }
                }

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

                // ENHANCED: Build combobox state info for AI decision-making
                let comboboxState = null;
                if (isCombobox) {
                    comboboxState = {
                        isCombobox: true,
                        expanded: ariaExpanded === 'true',
                        hasPopup: ariaHasPopup || 'listbox',
                        autocomplete: ariaAutocomplete || null,
                        controls: ariaControls || null,
                        // Check if a value is already selected (chip/tag visible nearby)
                        hasSelectedChip: !!el.closest('[class*="select"], [class*="combobox"]')
                            ?.querySelector('[class*="chip"], [class*="tag"], [class*="badge"], [class*="value"][class*="container"] > div, [data-radix-select-value]')
                    };
                    // For comboboxes, also check if there's a displayed value
                    if (!currentValue) {
                        const chipEl = el.closest('[class*="select"], [class*="combobox"]')
                            ?.querySelector('[class*="singleValue"], [class*="chip"], [class*="tag"], [class*="selected-value"]');
                        if (chipEl) {
                            currentValue = (chipEl.textContent || '').trim() || null;
                        }
                    }
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
                    fieldIntent: extractFieldIntentFromElement(el) || null,
                    section: getNearbySectionText(el) || null,
                    currentValue,
                    comboboxState: comboboxState,
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
