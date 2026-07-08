<?php

namespace App\Services;

use Illuminate\Support\Facades\Log;

/**
 * ReflexionService — Frontier-grade self-healing module.
 *
 * When the agent fails 2+ times on the same target, this service generates
 * a specialized "Reflexion Prompt" that forces the AI into a debugging mindset
 * with a different persona and constrained action space.
 *
 * Based on the Reflexion framework (Shinn et al., 2023) used by frontier agents.
 */
class ReflexionService
{
    /**
     * Determine if reflexion mode should be activated.
     */
    public function shouldActivate(array $history, bool $lastActionFailed, ?string $lastActionError): bool
    {
        if (empty($history) || count($history) < 2) {
            return false;
        }

        // ── Semantic Reflexion: outcome-based loop detection ──
        // Detect repeated UI error messages (e.g., "Maximum Quantity Reached") even when selectors differ.
        // We approximate "sequentially across different elements" using sequential failure entries that
        // share the same normalized error message.
        $recent = array_slice($history, -8);

        $normalizedErrors = [];
        foreach ($recent as $entry) {
            $actionSuccess = $entry['actionSuccess'] ?? true;
            if ($actionSuccess) {
                continue;
            }

            $candidates = [];

            $err = $entry['error'] ?? '';
            if (is_string($err) && trim($err) !== '') {
                $candidates[] = $err;
            }

            // Some flows pass lastActionError separately, but keep compatibility if it is present in history.
            $lastErr = $entry['lastActionError'] ?? '';
            if (is_string($lastErr) && trim($lastErr) !== '') {
                $candidates[] = $lastErr;
            }

            // If the extension captures post-save errors, they may appear as a string/array.
            $postErrors = $entry['postSaveErrors'] ?? ($entry['post_errors'] ?? null);
            if (is_string($postErrors) && trim($postErrors) !== '') {
                $candidates[] = $postErrors;
            } elseif (is_array($postErrors)) {
                foreach ($postErrors as $pe) {
                    if (is_string($pe) && trim($pe) !== '') {
                        $candidates[] = $pe;
                    }
                }
            }

            if (empty($candidates)) {
                continue;
            }

            // Take the first non-empty candidate as the message signal.
            $msg = (string) $candidates[0];
            $normalizedErrors[] = $this->normalizeErrorMessage($msg);
        }

        // Count sequential occurrences of the same normalized error.
        $semanticConsecutiveSameError = 0;
        $lastNorm = '';
        for ($i = count($normalizedErrors) - 1; $i >= 0; $i--) {
            $norm = $normalizedErrors[$i];
            if ($norm === '' || $norm === $lastNorm) {
                $semanticConsecutiveSameError++;
                $lastNorm = $norm;
                continue;
            }
            break;
        }

        // Trigger if the same UI error message repeats 2+ times sequentially.
        if ($semanticConsecutiveSameError >= 2) {
            return true;
        }

        // ── Backward-compatible legacy loops: selector and action repetition ──

        // Check last 3 actions for repeated failures on same target selector
        $recentHistory = array_slice($history, -3);
        $lastSelector = end($recentHistory)['selector'] ?? '';

        if (!empty($lastSelector)) {
            $consecutiveFailures = 0;
            foreach (array_reverse($recentHistory) as $entry) {
                if (($entry['selector'] ?? '') === $lastSelector && !($entry['actionSuccess'] ?? true)) {
                    $consecutiveFailures++;
                } else {
                    break;
                }
            }

            if ($consecutiveFailures >= 2) {
                return true;
            }
        }

        // Also activate if same action type failed 3+ times (even on different selectors)
        $lastAction = end($recentHistory)['action'] ?? '';
        if (!empty($lastAction)) {
            $sameActionFailures = 0;
            foreach (array_reverse(array_slice($history, -5)) as $entry) {
                if (($entry['action'] ?? '') === $lastAction && !($entry['actionSuccess'] ?? true)) {
                    $sameActionFailures++;
                }
            }

            return $sameActionFailures >= 3;
        }

        // Final fallback: if last action failed with an error and the same error persists twice in a row
        if ($lastActionFailed && is_string($lastActionError) && trim($lastActionError) !== '') {
            return $this->countSequentialErrorMatches($history, $lastActionError) >= 2;
        }

        return false;
    }

    /**
     * Normalize UI error message text for semantic-loop detection.
     */
    private function normalizeErrorMessage(string $message): string
    {
        $m = mb_strtolower(trim($message));
        // Collapse whitespace
        $m = preg_replace('/\s+/', ' ', $m) ?? $m;
        // Remove common punctuation noise
        $m = preg_replace('/[^\p{L}\p{N}\s]/u', '', $m) ?? $m;
        return trim($m);
    }

    /**
     * Count sequential matches for an error string near the end of history.
     */
    private function countSequentialErrorMatches(array $history, string $error): int
    {
        $target = $this->normalizeErrorMessage($error);
        if ($target === '') return 0;

        $count = 0;
        $lastNorm = null;
        for ($i = count($history) - 1; $i >= 0; $i--) {
            $entry = $history[$i];
            if (($entry['actionSuccess'] ?? true)) {
                continue;
            }

            $msg = (string) ($entry['error'] ?? $entry['lastActionError'] ?? '');
            if (trim($msg) === '') {
                continue;
            }

            $norm = $this->normalizeErrorMessage($msg);
            if ($norm === '' || $norm !== $target) {
                break;
            }

            $count++;
            $lastNorm = $norm;
        }

        return (int) $count;
    }

    /**
     * Build the Reflexion prompt block that replaces the standard action prompt.
     * This uses a DIFFERENT persona (debugger) to break the AI out of pattern repetition.
     */
    public function buildReflexionBlock(array $history, ?string $lastActionError, array $elements): string
    {
        $recentHistory = array_slice($history, -5);
        $failedAttempts = array_filter($recentHistory, fn($h) => !($h['actionSuccess'] ?? true));

        // Extract failure patterns
        $failedSelectors = array_unique(array_column($failedAttempts, 'selector'));
        $failedActions = array_column($failedAttempts, 'action');
        $failedErrors = array_filter(array_column($failedAttempts, 'error'));

        $failedSelectorsStr = implode(', ', array_filter($failedSelectors));
        $failedActionsStr = implode(', ', $failedActions);
        $failedErrorsStr = implode(' | ', array_slice($failedErrors, -3));

        // Find alternative selectors for the same logical element
        $lastFailedSelector = end($failedAttempts)['selector'] ?? '';
        $alternatives = $this->findAlternativeSelectors($lastFailedSelector, $elements);
        $alternativesStr = !empty($alternatives)
            ? "Alternative selectors for similar elements:\n" . implode("\n", array_map(fn($a) => "  - {$a['selector']} (text: \"{$a['text']}\")", array_slice($alternatives, 0, 5)))
            : "No obvious alternatives found in current DOM.";

        // Build the reflexion block
        $block = <<<REFLEXION

# 🔴 REFLEXION MODE — MANDATORY STRATEGY CHANGE
═══════════════════════════════════════════════════════════════
You are now in DEBUGGING MODE. Your previous approach FAILED REPEATEDLY.
You MUST analyze the failure and propose a FUNDAMENTALLY DIFFERENT strategy.

## FAILURE ANALYSIS:
- Failed selectors: {$failedSelectorsStr}
- Failed actions: {$failedActionsStr}
- Error messages: {$failedErrorsStr}
- Last error: {$lastActionError}

## {$alternativesStr}

## MANDATORY DIAGNOSTIC (include in your "thought" field):
1. ROOT CAUSE: Why did the previous approach fail? (wrong selector? wrong action type? element not ready? wrong container?)
2. WHAT'S DIFFERENT: How is your new approach fundamentally different? (not just a minor tweak)
3. FALLBACK PLAN: If this also fails, what's your backup strategy?

## STRATEGY CHANGE RULES (MUST FOLLOW):
- If "type" failed on a field → Try: click to focus first, OR use keyboard_event, OR check if it's contenteditable
- If "click" failed → Try: scroll element into view first, OR use click_coordinate with bounding box, OR try parent/child selector
- If "scroll" returned scrolled:0 → The scroll target is WRONG. Try different container (main, #content, [role="main"])
- If "keyboard_event" failed → The field may not be focused. Click it first, wait 500ms, then retry keyboard
- If "select_option" failed → The dropdown may be a combobox. Use "type" to search, then click the option
- If selector not found → Element may be: inside shadow DOM, dynamically loaded, or behind a different CSS path

## BANNED APPROACHES (DO NOT USE):
- DO NOT retry any selector listed in "Failed selectors" above
- DO NOT use the same action type that failed 3+ times
- DO NOT use :contains() or :has() pseudo-selectors (not valid in querySelector)

## AVAILABLE RECOVERY ACTIONS:
1. "click_coordinate" — click by visual position (somIndex bounding box)
2. "keyboard_event" — send Tab/Enter/ArrowDown to focused element
3. "scroll_down"/"scroll_up" with a DIFFERENT container selector
4. "type" with a DIFFERENT, shorter search term
5. Skip this field entirely and move to the NEXT SOP step (if non-critical)
═══════════════════════════════════════════════════════════════
REFLEXION;

        return $block;
    }

    /**
     * Find alternative selectors for elements that might be the same logical target.
     */
    private function findAlternativeSelectors(string $failedSelector, array $elements): array
    {
        if (empty($failedSelector) || empty($elements)) {
            return [];
        }

        $alternatives = [];

        // Extract identifying parts from the failed selector
        $idMatch = preg_match('/#([a-zA-Z0-9_-]+)/', $failedSelector, $matches);
        $failedId = $idMatch ? $matches[1] : '';

        foreach ($elements as $el) {
            $elSelector = $el['selector'] ?? '';
            if ($elSelector === $failedSelector) continue;

            // Find elements with similar IDs, names, or aria-labels
            $elId = $el['id'] ?? '';
            $elName = $el['name'] ?? '';
            $elLabel = $el['ariaLabel'] ?? '';

            if ($failedId && $elId && (
                str_contains($elId, $failedId) ||
                str_contains($failedId, $elId) ||
                similar_text($elId, $failedId) > strlen($failedId) * 0.6
            )) {
                $alternatives[] = $el;
                continue;
            }

            // Same tag + similar position (nearby in DOM)
            if (!empty($el['tagName']) && str_contains($failedSelector, $el['tagName'])) {
                $alternatives[] = $el;
            }
        }

        return array_slice($alternatives, 0, 5);
    }

    /**
     * Compress history for reflexion context (only show relevant failures).
     */
    public function compressHistoryForReflexion(array $history): string
    {
        $relevant = array_slice($history, -5);
        $compressed = [];

        foreach ($relevant as $entry) {
            $status = ($entry['actionSuccess'] ?? false) ? '✓' : '✗';
            $action = $entry['action'] ?? 'unknown';
            $selector = $entry['selector'] ?? '';
            $error = $entry['error'] ?? '';
            $thought = substr($entry['thought'] ?? '', 0, 80);

            $line = "[{$status}] {$action} on \"{$selector}\"";
            if ($error) $line .= " — ERROR: {$error}";
            if ($thought) $line .= " (thought: {$thought})";
            $compressed[] = $line;
        }

        return implode("\n", $compressed);
    }
}
