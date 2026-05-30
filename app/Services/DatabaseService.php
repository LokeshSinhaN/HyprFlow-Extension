<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * DatabaseService — Read-only SQL executor for AI-driven EHR data lookups.
 *
 * The AI agent dynamically writes PostgreSQL queries to fetch missing patient
 * demographics, payer info, and claim data from the Supabase database.
 * Strictly read-only: INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE are rejected.
 */
class DatabaseService
{
    /**
     * Dangerous SQL keywords that indicate write/DDL operations.
     * Checked case-insensitively against the full query string.
     */
    private const FORBIDDEN_KEYWORDS = [
        'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE',
        'CREATE', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE', 'CALL',
    ];

    /**
     * Execute a read-only SQL query against the PostgreSQL (Supabase) database.
     *
     * @param string $sqlQuery Raw SQL SELECT query written by the AI agent.
     * @return array{success: bool, data?: array, error?: string, rowCount?: int}
     */
    public function executeQuery(string $sqlQuery): array
    {
        $sqlQuery = trim($sqlQuery);

        if (empty($sqlQuery)) {
            return ['success' => false, 'error' => 'Empty SQL query provided.'];
        }

        // ── SAFETY GATE: Reject any write/DDL operations ──
        $upperSql = strtoupper($sqlQuery);
        foreach (self::FORBIDDEN_KEYWORDS as $keyword) {
            // Match keyword at word boundary to avoid false positives
            // (e.g., "SELECTED" should not match "SELECT")
            if (preg_match('/\b' . $keyword . '\b/', $upperSql)) {
                Log::warning('DatabaseService: Blocked forbidden SQL operation', [
                    'keyword' => $keyword,
                    'sql' => substr($sqlQuery, 0, 200),
                ]);
                return [
                    'success' => false,
                    'error' => "FORBIDDEN: {$keyword} operations are not allowed. Only SELECT queries are permitted.",
                ];
            }
        }

        // Ensure query starts with SELECT or WITH (CTE)
        if (!preg_match('/^\s*(SELECT|WITH)\b/i', $sqlQuery)) {
            return [
                'success' => false,
                'error' => 'Only SELECT queries (or WITH/CTE) are allowed. Your query must start with SELECT or WITH.',
            ];
        }

        try {
            $results = DB::connection('pgsql')->select($sqlQuery);

            // Convert stdClass objects to arrays for clean JSON serialization
            $data = array_map(fn($row) => (array) $row, $results);

            Log::info('DatabaseService: Query executed', [
                'sql' => substr($sqlQuery, 0, 300),
                'rowCount' => count($data),
            ]);

            return [
                'success' => true,
                'data' => $data,
                'rowCount' => count($data),
            ];
        } catch (\Exception $e) {
            Log::warning('DatabaseService: Query failed', [
                'sql' => substr($sqlQuery, 0, 300),
                'error' => $e->getMessage(),
            ]);

            // Return the error message so the AI can self-heal its SQL syntax
            return [
                'success' => false,
                'error' => 'SQL_ERROR: ' . $e->getMessage(),
            ];
        }
    }
}
