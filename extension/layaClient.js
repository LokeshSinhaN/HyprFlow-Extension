/**
 * HyprFlow Extension — Local Laya Decision Model Client (System 1 Fast Gate)
 *
 * Connects directly to the local Laya decision engine (running locally on http://127.0.0.1:8000
 * via `laya-serve` or `python -m laya.serve`).
 *
 * Laya is an open-source, non-autoregressive decision model (421M parameter ModernBERT/mmBERT)
 * that performs choice, score, and binary (noul) classifications with calibrated confidence
 * distributions in ~30ms. It decides discrete actions and classifies states without LLM parsing loops.
 */

(function (global) {
    'use strict';

    // ─── DEFAULT CONFIGURATION ─────────────────────────────────────────
    const DEFAULT_LAYA_URL = 'http://127.0.0.1:8000';
    const CANDIDATE_LAYA_URLS = [
        'http://127.0.0.1:8000',
        'http://localhost:8000'
    ];
    const DEFAULT_TIMEOUT_MS = 25000; // Allows comfortable CPU inference on local machines (30-100ms with GPU, 2-15s on CPU)
    const HIGH_CONFIDENCE_THRESHOLD = 0.85;

    /**
     * Reusable Domain Question Schemas & Dynamic Question Builders
     * Tailored for Travel, E-commerce, RCM triage, and Generic Web Automation.
     */
    const LayaQuestionSchemas = {
        /**
         * Flight Booking / Travel Domain Schemas
         */
        flightBooking: {
            buildStepRoutingQuestion: () => ({
                task_step: {
                    type: 'choice',
                    instructions: 'Which flight booking step does the current page or action correspond to?',
                    criteria: {
                        select_date: 'Selecting departure, return, or flexible travel dates on a calendar',
                        choose_flight: 'Browsing flight search results, selecting fares, departure times, or airlines',
                        baggage_selection: 'Selecting carry-on bags, checked luggage, seat assignments, or add-ons',
                        payment: 'Entering payment details, billing address, or finalizing ticket purchase',
                        review: 'Reviewing itinerary summary, traveler details, or flight policies'
                    }
                }
            }),

            buildConfirmationSafetyQuestion: () => ({
                is_final_confirmation: {
                    type: 'noul',
                    instructions: 'Does this element trigger the final non-reversible booking confirmation?'
                }
            }),

            buildFullWorkflowQuestions: () => ({
                task_step: {
                    type: 'choice',
                    instructions: 'Which flight booking step does the current page or action correspond to?',
                    criteria: {
                        select_date: 'Selecting departure, return, or flexible travel dates on a calendar',
                        choose_flight: 'Browsing flight search results, selecting fares, departure times, or airlines',
                        baggage_selection: 'Selecting carry-on bags, checked luggage, seat assignments, or add-ons',
                        payment: 'Entering payment details, billing address, or finalizing ticket purchase',
                        review: 'Reviewing itinerary summary, traveler details, or flight policies'
                    }
                },
                is_final_confirmation: {
                    type: 'noul',
                    instructions: 'Does this element trigger the final non-reversible booking confirmation?'
                }
            })
        },

        /**
         * Product Search / E-commerce Domain Schemas
         */
        ecommerce: {
            buildRelevanceQuestion: (targetCriteria = 'target product query') => ({
                product_relevance: {
                    type: 'choice',
                    instructions: `Match product relevance against target criteria: "${targetCriteria}"`,
                    criteria: {
                        exact_match: 'Product matches all specified brand, model, specifications, and search intent',
                        alternative: 'Product is a related or alternative option that partially matches criteria',
                        irrelevant: 'Product is unrelated, sponsored noise, accessory only, or does not match search intent'
                    }
                }
            }),

            buildFitnessScoreQuestion: (rubricDescription = 'quality and price fitness') => ({
                fitness_rating: {
                    type: 'score',
                    instructions: `Rate the ${rubricDescription} relative to user budget and requirements`,
                    criteria: ['poor', 'fair', 'good', 'excellent']
                }
            }),

            buildProductEvaluationQuestions: (targetCriteria = 'target product query') => ({
                product_relevance: {
                    type: 'choice',
                    instructions: `Match product relevance against target criteria: "${targetCriteria}"`,
                    criteria: {
                        exact_match: 'Product matches all specified brand, model, specifications, and search intent',
                        alternative: 'Product is a related or alternative option that partially matches criteria',
                        irrelevant: 'Product is unrelated, sponsored noise, accessory only, or does not match search intent'
                    }
                },
                fitness_rating: {
                    type: 'score',
                    instructions: 'Rate the quality/price fitness rating of this product on a 4-tier scale',
                    criteria: ['poor', 'fair', 'good', 'excellent']
                }
            })
        },

        /**
         * RCM / Healthcare Portal Domain Schemas
         */
        rcmPortal: {
            buildClaimStatusQuestion: () => ({
                claim_status: {
                    type: 'choice',
                    instructions: 'Categorize the medical claim status or adjudication outcome on the portal',
                    criteria: {
                        paid: 'Claim has been fully or partially paid, settled, or approved',
                        denied: 'Claim has been denied, rejected, or disputed with reason codes',
                        pending: 'Claim is in process, under review, or awaiting initial adjudication',
                        requires_info: 'Claim requires medical records, proof of service, or additional documentation',
                        appealed: 'Claim is currently undergoing formal dispute or appeal'
                    }
                }
            }),

            buildInterventionQuestion: () => ({
                requires_manual_intervention: {
                    type: 'noul',
                    instructions: 'Does this claim status or error code require manual human intervention?'
                }
            }),

            buildClaimTriageQuestions: () => ({
                claim_status: {
                    type: 'choice',
                    instructions: 'Categorize the medical claim status or adjudication outcome on the portal',
                    criteria: {
                        paid: 'Claim has been fully or partially paid, settled, or approved',
                        denied: 'Claim has been denied, rejected, or disputed with reason codes',
                        pending: 'Claim is in process, under review, or awaiting initial adjudication',
                        requires_info: 'Claim requires medical records, proof of service, or additional documentation',
                        appealed: 'Claim is currently undergoing formal dispute or appeal'
                    }
                },
                requires_manual_intervention: {
                    type: 'noul',
                    instructions: 'Does this claim status or error code require manual human intervention?'
                }
            })
        },

        /**
         * Generic Web Automation & Action Classification Schemas
         */
        genericAutomation: {
            buildIntentRoutingQuestion: (candidateIntents = []) => {
                let criteria = {};
                if (Array.isArray(candidateIntents)) {
                    candidateIntents.forEach(intent => {
                        criteria[intent] = `Action or state corresponding to ${intent.replace(/_/g, ' ')}`;
                    });
                } else if (candidateIntents && typeof candidateIntents === 'object') {
                    criteria = candidateIntents;
                } else {
                    criteria = {
                        navigate: 'Navigating to a different URL or section',
                        fill_form: 'Entering text or numbers into input fields',
                        select_item: 'Choosing an item or dropdown option',
                        submit: 'Submitting a form or triggering primary action',
                        inspect: 'Reading or extracting information from the page'
                    };
                }

                return {
                    intent: {
                        type: 'choice',
                        instructions: 'Which candidate intent best matches the observed context?',
                        criteria: criteria
                    }
                };
            },

            buildActionSafetyQuestion: (actionDescription = '') => ({
                is_irreversible_or_destructive: {
                    type: 'noul',
                    instructions: `Does this action trigger an irreversible or destructive operation (e.g. final booking, payment, delete data)? Action: ${actionDescription}`
                }
            }),

            buildFastGateDecisionQuestions: (candidateActions = {}) => ({
                selected_action: {
                    type: 'choice',
                    instructions: 'Select the optimal deterministic next action to advance toward the user goal',
                    criteria: candidateActions
                },
                is_safe_to_execute: {
                    type: 'noul',
                    instructions: 'Is this action safe to execute deterministically without generative LLM reasoning or human confirmation?'
                }
            })
        }
    };

    /**
     * LayaClient class for direct extension-to-Laya bridge
     */
    class LayaClient {
        constructor(options = {}) {
            this.baseUrl = options.baseUrl || DEFAULT_LAYA_URL;
            this.isExplicitUrl = !!options.baseUrl;
            this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
            this.lastKnownOnline = null;
            this.lastResolvedUrl = null;
        }

        /**
         * Dynamically resolves the active Laya server URL (127.0.0.1:8000 or localhost:8000)
         * @param {boolean} forceRefresh
         * @returns {Promise<string|null>}
         */
        async resolveBaseUrl(forceRefresh = false) {
            if (this.lastResolvedUrl && !forceRefresh) {
                return this.lastResolvedUrl;
            }

            const candidateUrls = this.isExplicitUrl
                ? [this.baseUrl]
                : [this.baseUrl, ...CANDIDATE_LAYA_URLS];
            const uniqueUrls = [...new Set(candidateUrls)];

            for (const url of uniqueUrls) {
                try {
                    const isOnline = await this.ping(url);
                    if (isOnline) {
                        this.lastResolvedUrl = url;
                        this.lastKnownOnline = true;
                        return url;
                    }
                } catch (e) {
                    // Continue probing candidates
                }
            }

            this.lastKnownOnline = false;
            return null;
        }

        /**
         * Pings a Laya server candidate by probing /health (standard laya-serve endpoint)
         * or fallback endpoints (/v1/systemone, /predict)
         * @param {string} targetUrl
         * @returns {Promise<boolean>}
         */
        async ping(targetUrl = this.baseUrl) {
            const cleanUrl = targetUrl.replace(/\/+$/, '');
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 1500);

            try {
                // 1. Primary check: GET /health (Standard laya-serve FastAPI endpoint)
                const healthRes = await fetch(`${cleanUrl}/health`, {
                    method: 'GET',
                    signal: controller.signal
                }).catch(() => null);

                if (healthRes && (healthRes.ok || healthRes.status === 200)) {
                    clearTimeout(timeoutId);
                    return true;
                }

                // 2. Secondary check: Probe POST /v1/systemone (TypeSafe Jev wire protocol)
                const sysOneRes = await fetch(`${cleanUrl}/v1/systemone`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        state: { body: 'ping' },
                        questions: {
                            is_active: {
                                type: 'noul',
                                instructions: 'Is server active?'
                            }
                        }
                    }),
                    signal: controller.signal
                }).catch(() => null);

                if (sysOneRes && (sysOneRes.ok || sysOneRes.status === 422 || sysOneRes.status === 400)) {
                    clearTimeout(timeoutId);
                    return true;
                }

                // 3. Backward compatibility / mock server fallback: /predict
                const predictRes = await fetch(`${cleanUrl}/predict`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        state: { body: 'ping' },
                        questions: {
                            is_active: {
                                type: 'noul',
                                instructions: 'Is server active?'
                            }
                        }
                    }),
                    signal: controller.signal
                }).catch(() => null);

                clearTimeout(timeoutId);
                return !!(predictRes && (predictRes.ok || predictRes.status === 422 || predictRes.status === 400));
            } catch (err) {
                clearTimeout(timeoutId);
                return false;
            }
        }

        /**
         * Checks health of local Laya server and returns detailed status
         * @returns {Promise<{online: boolean, url: string|null, message: string}>}
         */
        async checkHealth() {
            const activeUrl = await this.resolveBaseUrl(true);
            if (activeUrl) {
                return {
                    online: true,
                    url: activeUrl,
                    message: `Laya decision engine online at ${activeUrl}`
                };
            }

            return {
                online: false,
                url: null,
                message: 'Local Laya server is offline. Please run: laya-serve --host 0.0.0.0 --port 8000'
            };
        }

        /**
         * Normalizes state input to the format expected by Laya (object with body/text/fields)
         * @param {string|object} state
         * @returns {object}
         */
        normalizeState(state) {
            if (typeof state === 'string') {
                return { body: state };
            }
            if (state && typeof state === 'object') {
                return state;
            }
            return { body: String(state || '') };
        }

        /**
         * Normalizes questions dictionary to match Laya's strict schema requirements:
         * - 'instructions' field is required on all questions
         * - 'score' question expects 'criteria' as an array of string level descriptions
         * - 'choice' question expects 'criteria' as an object or dictionary
         * @param {object} questions
         * @returns {object}
         */
        normalizeQuestions(questions) {
            if (!questions || typeof questions !== 'object') {
                return {};
            }

            const normalized = {};
            for (const [key, q] of Object.entries(questions)) {
                if (!q || typeof q !== 'object') continue;
                const copy = { ...q };

                // Ensure 'instructions' is populated
                if (!copy.instructions) {
                    copy.instructions = copy.text || copy.prompt || copy.title || key;
                }

                // Normalise score questions: criteria must be an array of level descriptions
                if (copy.type === 'score') {
                    if (!copy.criteria && Array.isArray(copy.levels)) {
                        copy.criteria = copy.levels;
                    }
                    if (!Array.isArray(copy.criteria)) {
                        copy.criteria = ['poor', 'fair', 'good', 'excellent'];
                    }
                }

                // Normalise choice questions: criteria should be an object mapping choice -> description
                if (copy.type === 'choice' && Array.isArray(copy.criteria)) {
                    const criteriaObj = {};
                    copy.criteria.forEach((c) => { criteriaObj[c] = null; });
                    copy.criteria = criteriaObj;
                }

                normalized[key] = copy;
            }

            return normalized;
        }

        /**
         * Direct predict request to local Laya server
         * Uses TypeSafe Jev protocol (/v1/systemone) with automatic fallback to /predict
         * Evaluates a state against structured questions in a single forward pass (~30ms)
         *
         * @param {string|object} state - Text, DOM context, or state dictionary
         * @param {object} questions - Typed questions dictionary (choice, noul, score)
         * @param {object} options - Optional request overrides
         * @returns {Promise<{success: boolean, model?: string, answers?: object, error?: string, offline?: boolean, raw?: any}>}
         */
        async predict(state, questions, options = {}) {
            const activeUrl = await this.resolveBaseUrl();
            if (!activeUrl) {
                const offlineMsg = 'Local Laya server is offline at http://127.0.0.1:8000. '
                    + 'Please start it in your terminal: pip install -U laya && laya-serve --host 0.0.0.0 --port 8000';
                return {
                    success: false,
                    offline: true,
                    error: offlineMsg
                };
            }

            const cleanBase = activeUrl.replace(/\/+$/, '');
            const normalizedState = this.normalizeState(state);
            const normalizedQuestions = this.normalizeQuestions(questions);
            const payload = {
                state: normalizedState,
                questions: normalizedQuestions
            };

            const timeoutMs = options.timeoutMs || this.timeoutMs;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            const startTime = Date.now();

            try {
                // Try TypeSafe Jev endpoint (/v1/systemone) first
                let response = await fetch(`${cleanBase}/v1/systemone`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    body: JSON.stringify(payload),
                    signal: controller.signal
                });

                // Fallback to /predict if /v1/systemone returned 404 Not Found (e.g. custom mock server)
                if (response.status === 404) {
                    response = await fetch(`${cleanBase}/predict`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'application/json'
                        },
                        body: JSON.stringify(payload),
                        signal: controller.signal
                    });
                }

                clearTimeout(timeoutId);
                const latencyMs = Date.now() - startTime;

                if (!response.ok) {
                    const errText = await response.text().catch(() => '');
                    return {
                        success: false,
                        offline: false,
                        status: response.status,
                        latencyMs,
                        error: `Laya predict returned HTTP ${response.status}: ${errText.slice(0, 300)}`
                    };
                }

                const data = await response.json();
                this.lastKnownOnline = true;

                // Process answers and enrich with calibrated confidence helpers
                const enrichedAnswers = this.enrichAnswers(data.answers || {});

                return {
                    success: true,
                    model: data.model || 'modernbert',
                    latencyMs,
                    answers: enrichedAnswers,
                    raw: data
                };
            } catch (err) {
                clearTimeout(timeoutId);
                const latencyMs = Date.now() - startTime;

                if (err.name === 'AbortError') {
                    return {
                        success: false,
                        offline: false,
                        timeout: true,
                        latencyMs,
                        error: `Laya predict request timed out after ${timeoutMs}ms.`
                    };
                }

                // Network disconnect or connection refused
                this.lastKnownOnline = false;
                return {
                    success: false,
                    offline: true,
                    latencyMs,
                    error: `Cannot connect to Laya server at ${activeUrl}. Ensure laya-serve is running: laya-serve --host 0.0.0.0 --port 8000 (${err.message})`
                };
            }
        }

        /**
         * Enriches raw Laya question answers with standardized convenience getters
         * @param {object} answersMap
         * @returns {object}
         */
        enrichAnswers(answersMap) {
            const result = {};
            for (const [key, ans] of Object.entries(answersMap)) {
                if (!ans) continue;

                // Choice question
                if (ans.choice !== undefined) {
                    const probs = ans.probabilities || {};
                    const choiceProb = probs[ans.choice] !== undefined ? probs[ans.choice] : (ans.answer_confidence || ans.confidence || 0);
                    result[key] = {
                        type: 'choice',
                        choice: ans.choice,
                        confidence: choiceProb,
                        probabilities: probs,
                        raw: ans
                    };
                }
                // Noul (binary) question
                else if (ans.noul !== undefined || (ans.probabilities && (ans.probabilities.true !== undefined || ans.probabilities['true'] !== undefined))) {
                    const noulVal = typeof ans.noul === 'number'
                        ? ans.noul
                        : (ans.probabilities ? (ans.probabilities.true || ans.probabilities['true'] || 0) : 0);
                    const isTrue = noulVal >= 0.5;
                    const confidence = Math.max(noulVal, 1.0 - noulVal);
                    result[key] = {
                        type: 'noul',
                        value: isTrue,
                        probability: noulVal,
                        confidence: ans.confidence !== undefined ? ans.confidence : confidence,
                        probabilities: ans.probabilities || { true: noulVal, false: 1.0 - noulVal },
                        raw: ans
                    };
                }
                // Score question
                else if (ans.score !== undefined || ans.expected_level !== undefined) {
                    result[key] = {
                        type: 'score',
                        score: ans.score !== undefined ? ans.score : ans.expected_level,
                        confidence: ans.confidence || 0.8,
                        probabilities: ans.probabilities || {},
                        raw: ans
                    };
                }
                // General/unknown
                else {
                    result[key] = ans;
                }
            }
            return result;
        }

        /**
         * Intent classification helper
         * Classifies context text against candidate intents in ~30ms
         *
         * @param {string|object} contextText - Text or context state to evaluate
         * @param {Array<string>|object} candidateIntents - Array of intent names or map of intent -> criteria
         * @param {object} options
         * @returns {Promise<{success: boolean, intent?: string, confidence?: number, probabilities?: object, isHighConfidence?: boolean, error?: string, offline?: boolean}>}
         */
        async classifyIntent(contextText, candidateIntents, options = {}) {
            const questionDef = LayaQuestionSchemas.genericAutomation.buildIntentRoutingQuestion(candidateIntents);
            const predictResult = await this.predict(contextText, questionDef, options);

            if (!predictResult.success) {
                return {
                    success: false,
                    error: predictResult.error,
                    offline: predictResult.offline
                };
            }

            const intentAns = predictResult.answers?.intent;
            if (!intentAns) {
                return {
                    success: false,
                    error: 'No intent answer returned by Laya model'
                };
            }

            const confidence = intentAns.confidence || 0;
            const threshold = options.threshold || HIGH_CONFIDENCE_THRESHOLD;

            return {
                success: true,
                intent: intentAns.choice,
                confidence: confidence,
                isHighConfidence: confidence >= threshold,
                probabilities: intentAns.probabilities || {},
                latencyMs: predictResult.latencyMs,
                model: predictResult.model
            };
        }

        /**
         * Action safety verification helper
         * Fast Gate to check if an action or DOM interaction is safe vs. irreversible
         *
         * @param {string|object} domContext - Context of the target element (text, role, tag, form)
         * @param {string} actionDescription - Description of proposed action (e.g. 'click Submit Payment button')
         * @param {object} options
         * @returns {Promise<{success: boolean, isSafe: boolean, isIrreversible: boolean, confidence: number, requiresConfirmation: boolean, error?: string, offline?: boolean}>}
         */
        async verifyActionSafety(domContext, actionDescription, options = {}) {
            const questions = {
                is_destructive: {
                    type: 'noul',
                    instructions: `Does this action execute a non-reversible booking, payment, irreversible deletion, or high-risk submission? Action: ${actionDescription}`
                },
                safety_category: {
                    type: 'choice',
                    instructions: 'Categorize the risk level of this browser action',
                    criteria: {
                        safe_navigation: 'Navigating, viewing, scrolling, reading information',
                        safe_form_input: 'Typing text, filling intermediate form fields, selecting options',
                        reversible_click: 'Clicking regular buttons, tabs, accordions, links',
                        critical_confirmation: 'Submitting final payment, non-reversible booking confirmation, or permanent deletion'
                    }
                }
            };

            const state = typeof domContext === 'object'
                ? { ...domContext, actionDescription }
                : { domContext: String(domContext || ''), actionDescription };

            const predictResult = await this.predict(state, questions, options);

            if (!predictResult.success) {
                return {
                    success: false,
                    isSafe: false, // Default to cautious if verification fails
                    error: predictResult.error,
                    offline: predictResult.offline
                };
            }

            const destructiveAns = predictResult.answers?.is_destructive;
            const categoryAns = predictResult.answers?.safety_category;

            const isDestructive = destructiveAns ? destructiveAns.value : false;
            const destructiveConfidence = destructiveAns ? destructiveAns.confidence : 0;
            const category = categoryAns?.choice || 'safe_navigation';

            const isCriticalCategory = category === 'critical_confirmation';
            const isIrreversible = isDestructive || isCriticalCategory;
            const isSafe = !isIrreversible;

            return {
                success: true,
                isSafe: isSafe,
                isIrreversible: isIrreversible,
                confidence: destructiveConfidence,
                category: category,
                requiresConfirmation: isIrreversible && destructiveConfidence >= 0.70,
                latencyMs: predictResult.latencyMs
            };
        }

        /**
         * Domain evaluation: Flight Booking Step & Safety Gate
         */
        async evaluateFlightBooking(state, options = {}) {
            const questions = LayaQuestionSchemas.flightBooking.buildFullWorkflowQuestions();
            return await this.predict(state, questions, options);
        }

        /**
         * Domain evaluation: Product Search Relevance & Fitness Score
         */
        async evaluateProduct(productState, targetCriteria, options = {}) {
            const questions = LayaQuestionSchemas.ecommerce.buildProductEvaluationQuestions(targetCriteria);
            return await this.predict(productState, questions, options);
        }

        /**
         * Domain evaluation: RCM Claim Status & Manual Intervention Flag
         */
        async evaluateRcmClaim(claimState, options = {}) {
            const questions = LayaQuestionSchemas.rcmPortal.buildClaimTriageQuestions();
            return await this.predict(claimState, questions, options);
        }
    }

    // Singleton instance for convenience
    const defaultInstance = new LayaClient();

    // Export schemas and class universally
    const LayaBundle = {
        LayaClient,
        LayaQuestionSchemas,
        default: defaultInstance,
        HIGH_CONFIDENCE_THRESHOLD,
        DEFAULT_LAYA_URL
    };

    // Attach to global (self for ServiceWorker, window for content/panel scripts)
    if (typeof self !== 'undefined') {
        self.LayaClient = LayaClient;
        self.LayaQuestionSchemas = LayaQuestionSchemas;
        self.layaClient = defaultInstance;
        self.LayaBundle = LayaBundle;
    }
    if (typeof window !== 'undefined') {
        window.LayaClient = LayaClient;
        window.LayaQuestionSchemas = LayaQuestionSchemas;
        window.layaClient = defaultInstance;
        window.LayaBundle = LayaBundle;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = LayaBundle;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
