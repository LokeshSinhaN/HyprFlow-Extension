<?php

namespace App\Services;

use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Cache;

/**
 * SiteKnowledgeService — Cross-session learning for site-specific patterns.
 *
 * After each agent run, extracts interaction patterns (what worked, what failed)
 * and stores them keyed by domain. On future runs on the same domain, these
 * patterns are injected as hints to prevent repeating past mistakes.
 *
 * This is Gap C: Site-Specific Knowledge Base for frontier-level learning.
 */
class SiteKnowledgeService
{
    private const CACHE_PREFIX = 'hyprflow_site_knowledge:';
    private const MAX_PATTERNS_PER_DOMAIN = 20;
    private const CACHE_TTL_HOURS = 168; // 7 days

    /**
     * Extract and store patterns from a completed agent run.
     */
    public function learnFromRun(string $url, array $history, string $prompt): void
    {
        $domain = $this->extractDomain($url);
        if (!$domain) return;

        $patterns = $this->extractPatterns($history, $prompt);
        if (empty($patterns)) return;

        // Merge with existing knowledge
        $existing = $this->getKnowledge($domain);
        $merged = $this->mergePatterns($existing, $patterns);

        // Store (limit to max patterns)
        $merged = array_slice($merged, 0, self::MAX_PATTERNS_PER_DOMAIN);
        Cache::put(
            self::CACHE_PREFIX . $domain,
            $merged,
            now()->addHours(self::CACHE_TTL_HOURS)
        );

        Log::debug('Site knowledge updated', [
            'domain' => $domain,
            'patterns_count' => count($merged),
            'new_patterns' => count($patterns),
        ]);
    }

    /**
     * Retrieve site-specific knowledge for a domain.
     */
    public function getKnowledgeForUrl(string $url): array
    {
        $domain = $this->extractDomain($url);
        if (!$domain) return [];

        return $this->getKnowledge($domain);
    }

    /**
     * Build a prompt block with site-specific hints.
     */
    public function buildKnowledgeBlock(string $url): string
    {
        $patterns = $this->getKnowledgeForUrl($url);
        if (empty($patterns)) return '';

        $domain = $this->extractDomain($url);
        $block = "\n# SITE-SPECIFIC KNOWLEDGE (learned from previous runs on {$domain}):\n";
        $block .= "These patterns were discovered in past interactions with this site:\n";

        foreach ($patterns as $pattern) {
            $type = $pattern['type'] ?? 'info';
            $icon = match ($type) {
                'success_pattern' => '✅',
                'failure_pattern' => '⚠️',
                'interaction_hint' => '💡',
                'element_type' => '🔧',
                default => 'ℹ️',
            };
            $block .= "{$icon} {$pattern['description']}\n";
        }

        $block .= "\nUse these hints to avoid repeating past mistakes and leverage known working patterns.\n";

        return $block;
    }

    /**
     * Extract actionable patterns from agent history.
     */
    private function extractPatterns(array $history, string $prompt): array
    {
        $patterns = [];

        // Pattern 1: ContentEditable fields
        foreach ($history as $entry) {
            if (($entry['action'] ?? '') === 'type' && !($entry['actionSuccess'] ?? true)) {
                $error = $entry['error'] ?? '';
                if (str_contains($error, 'Illegal invocation') || str_contains($error, 'contenteditable')) {
                    $selector = $entry['selector'] ?? '';
                    $patterns[] = [
                        'type' => 'element_type',
                        'description' => "Element \"{$selector}\" is contenteditable (not a standard input). Use insertText/execCommand approach.",
                        'selector_pattern' => $selector,
                        'confidence' => 0.9,
                    ];
                }
            }
        }

        // Pattern 2: Successful combobox interactions
        foreach ($history as $entry) {
            if (($entry['autoSelectedDropdown'] ?? false) && ($entry['actionSuccess'] ?? false)) {
                $selector = $entry['selector'] ?? '';
                $text = $entry['text'] ?? '';
                $patterns[] = [
                    'type' => 'success_pattern',
                    'description' => "Combobox \"{$selector}\" works with type-then-auto-select pattern. Search text: \"{$text}\".",
                    'selector_pattern' => $selector,
                    'confidence' => 0.85,
                ];
            }
        }

        // Pattern 3: Scroll containers that worked
        foreach ($history as $entry) {
            if (in_array($entry['action'] ?? '', ['scroll_down', 'scroll_up'])) {
                $scrolled = $entry['scrolled'] ?? 0;
                if (abs($scrolled) > 100) {
                    $selector = $entry['selector'] ?? 'page';
                    $patterns[] = [
                        'type' => 'interaction_hint',
                        'description' => "Scrollable container: \"{$selector}\" (scrolled {$scrolled}px successfully).",
                        'selector_pattern' => $selector,
                        'confidence' => 0.8,
                    ];
                }
            }
        }

        // Pattern 4: Failed selectors (to avoid in future)
        $failedSelectors = [];
        foreach ($history as $entry) {
            if (!($entry['actionSuccess'] ?? true) && !empty($entry['selector'])) {
                $error = $entry['error'] ?? '';
                if (str_contains($error, 'not found') || str_contains($error, 'querySelector')) {
                    $failedSelectors[] = $entry['selector'];
                }
            }
        }
        $failedSelectors = array_unique($failedSelectors);
        if (count($failedSelectors) > 0) {
            $patterns[] = [
                'type' => 'failure_pattern',
                'description' => "These selectors were NOT found in DOM (may be dynamic/generated): " . implode(', ', array_slice($failedSelectors, 0, 5)),
                'confidence' => 0.7,
            ];
        }

        // Pattern 5: Keyboard events that resolved stuck states
        foreach ($history as $entry) {
            if (($entry['action'] ?? '') === 'keyboard_event' && ($entry['actionSuccess'] ?? false)) {
                $keys = $entry['keys'] ?? $entry['keysDispatched'] ?? [];
                $selector = $entry['selector'] ?? '';
                if (!empty($keys)) {
                    $keysStr = is_array($keys) ? implode('+', $keys) : $keys;
                    $patterns[] = [
                        'type' => 'interaction_hint',
                        'description' => "Keyboard shortcut [{$keysStr}] on \"{$selector}\" resolved interaction.",
                        'selector_pattern' => $selector,
                        'confidence' => 0.75,
                    ];
                }
            }
        }

        // Pattern 6: Modals/dialogs scroll behavior
        foreach ($history as $entry) {
            if (!empty($entry['modalScrollOverride'])) {
                $patterns[] = [
                    'type' => 'interaction_hint',
                    'description' => "This site uses modal dialogs. Scroll inside the modal container, not the page body.",
                    'confidence' => 0.9,
                ];
                break; // Only need one
            }
        }

        // Deduplicate by description
        $seen = [];
        $unique = [];
        foreach ($patterns as $p) {
            $key = $p['description'];
            if (!isset($seen[$key])) {
                $seen[$key] = true;
                $unique[] = $p;
            }
        }

        return $unique;
    }

    /**
     * Merge new patterns with existing ones, preferring higher confidence.
     */
    private function mergePatterns(array $existing, array $new): array
    {
        $merged = $existing;

        foreach ($new as $newPattern) {
            $found = false;
            foreach ($merged as &$existingPattern) {
                if ($existingPattern['description'] === $newPattern['description']) {
                    // Update confidence (increase if seen again)
                    $existingPattern['confidence'] = min(1.0, ($existingPattern['confidence'] ?? 0.5) + 0.1);
                    $existingPattern['last_seen'] = now()->toIso8601String();
                    $found = true;
                    break;
                }
            }
            unset($existingPattern);

            if (!$found) {
                $newPattern['last_seen'] = now()->toIso8601String();
                $merged[] = $newPattern;
            }
        }

        // Sort by confidence (highest first)
        usort($merged, fn($a, $b) => ($b['confidence'] ?? 0) <=> ($a['confidence'] ?? 0));

        return $merged;
    }

    /**
     * Get stored knowledge for a domain.
     */
    private function getKnowledge(string $domain): array
    {
        return Cache::get(self::CACHE_PREFIX . $domain, []);
    }

    /**
     * Extract domain from URL.
     */
    private function extractDomain(string $url): string
    {
        $parsed = parse_url($url);
        return $parsed['host'] ?? '';
    }
}
