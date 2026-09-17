/**
 * Context-Aware Conditional Response System Migration
 * 
 * Adds new columns to support 7-condition checking:
 * - knowledge_patterns: reason, user_state, conversation_stage, time_context, parent_required, profile_required
 * - pattern_answer_templates: variant_type (if not exists)
 */

import { getPgPool } from './db';

export async function migrateContextAwareColumns(): Promise<boolean> {
  const pool = getPgPool();
  if (!pool) {
    console.log('[Migration] No PostgreSQL pool available, skipping...');
    return false;
  }

  try {
    console.log('[Migration] Starting context-aware conditional response migration...');

    // 1. Add columns to knowledge_patterns table
    await pool.query(`
      ALTER TABLE knowledge_patterns 
      ADD COLUMN IF NOT EXISTS reason VARCHAR(100) DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS user_state VARCHAR(50) DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS conversation_stage VARCHAR(50) DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS time_context VARCHAR(50) DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS parent_required BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS profile_required JSONB DEFAULT NULL
    `);
    console.log('[Migration] Added context columns to knowledge_patterns');

    // 2. Add variant_type column to pattern_answer_templates if not exists
    await pool.query(`
      ALTER TABLE pattern_answer_templates 
      ADD COLUMN IF NOT EXISTS variant_type VARCHAR(50) DEFAULT 'default'
    `);
    console.log('[Migration] Added variant_type to pattern_answer_templates');

    // 3. Update existing patterns with sensible defaults
    await pool.query(`
      UPDATE knowledge_patterns 
      SET reason = COALESCE(reason, 'static_response'),
          user_state = COALESCE(user_state, 'any'),
          conversation_stage = COALESCE(conversation_stage, 'any'),
          time_context = COALESCE(time_context, 'any'),
          parent_required = COALESCE(parent_required, FALSE),
          profile_required = COALESCE(profile_required, '{}')::jsonb
      WHERE reason IS NULL OR user_state IS NULL
    `);
    console.log('[Migration] Updated existing patterns with defaults');

    console.log('[Migration] Context-aware migration completed successfully!');
    return true;
  } catch (error: any) {
    console.error('[Migration] Migration error:', error.message);
    return false;
  }
}

// Export for direct use
export default migrateContextAwareColumns;
