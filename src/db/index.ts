import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
const { Pool } = pg;
import * as schema from './schema';
import dotenv from 'dotenv';
import path from 'path';

// Load .env from root and /server directory
dotenv.config();
dotenv.config({ path: path.join(process.cwd(), 'server', '.env') });

let poolInstance: pg.Pool | null = null;
let isInitialized = false;
let schemaInitPromise: Promise<boolean> | null = null;

export function isPostgresConfigured(): boolean {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (connectionString && (connectionString.startsWith('postgres://') || connectionString.startsWith('postgresql://'))) {
    return true;
  }
  const host = process.env.PGHOST || process.env.SQL_HOST;
  const database = process.env.PGDATABASE || process.env.SQL_DB_NAME;
  const user = process.env.PGUSER || process.env.SQL_USER;
  return Boolean(host && database && user);
}

export function getPgPool(): pg.Pool | null {
  if (poolInstance) return poolInstance;

  const connectionString = process.env.DATABASE_URL?.trim();
  const host = process.env.PGHOST || process.env.SQL_HOST;
  const database = process.env.PGDATABASE || process.env.SQL_DB_NAME;
  const user = process.env.PGUSER || process.env.SQL_USER;
  const password = process.env.PGPASSWORD || process.env.SQL_PASSWORD;

  try {
    if (connectionString && (connectionString.startsWith('postgres://') || connectionString.startsWith('postgresql://'))) {
      console.log('[PostgreSQL] Initializing Pool with DATABASE_URL (source of truth)...');
      const needsSsl = connectionString.includes('sslmode=require')
        || connectionString.includes('neon.tech')
        || connectionString.includes('supabase')
        || connectionString.includes('amazonaws.com')
        || connectionString.includes('azure');
      poolInstance = new Pool({
        connectionString,
        max: 10,
        connectionTimeoutMillis: 10000,
        ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
      });
    } else if (host && database && user) {
      console.log(`[PostgreSQL] Initializing Pool with host: ${host}, database: ${database}...`);
      poolInstance = new Pool({
        host,
        port: parseInt(process.env.PGPORT || '5432', 10),
        database,
        user,
        password,
        max: 10,
        connectionTimeoutMillis: 10000,
        ssl: host.includes('neon.tech') || host.includes('aws') || host.includes('supabase')
          ? { rejectUnauthorized: false }
          : undefined,
      });
    } else {
      return null;
    }

    poolInstance.on('error', (err) => {
      console.error('[PostgreSQL Pool Background Error]:', err.message);
      poolInstance = null;
      isInitialized = false;
      schemaInitPromise = null;
    });

    if (!isInitialized) {
      isInitialized = true;
      schemaInitPromise = initializeDatabaseTables(poolInstance).catch((err) => {
        console.warn('[PostgreSQL] Async schema verification deferred:', err?.message);
        return false;
      });
    }

    return poolInstance;
  } catch (err: any) {
    console.error('[PostgreSQL Init Exception]:', err?.message);
    return null;
  }
}

export async function waitForPgSchema(): Promise<boolean> {
  if (!getPgPool()) return false;
  if (schemaInitPromise) return schemaInitPromise;
  return false;
}

/**
 * Automatically create tables if connected to PostgreSQL (Auto-migration)
 */
export async function initializeDatabaseTables(pool: pg.Pool | null): Promise<boolean> {
  if (!pool) return false;

  try {
    const client = await pool.connect();
    try {
      console.log('[PostgreSQL] Checking and provisioning schema tables on PostgreSQL DB...');
      
      await client.query(`
        CREATE TABLE IF NOT EXISTS server_state_dump (
          id INT PRIMARY KEY DEFAULT 1,
          data JSONB NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS projects (
          id VARCHAR(64) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          description TEXT,
          platform VARCHAR(64) DEFAULT 'Web App',
          webhook_url TEXT,
          system_prompt TEXT,
          ai_provider VARCHAR(64) DEFAULT 'gemini-2.5-flash',
          temperature INT DEFAULT 7,
          max_tokens INT DEFAULT 2048,
          daily_request_limit INT DEFAULT 5000,
          monthly_request_limit INT DEFAULT 150000,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        ALTER TABLE projects ADD COLUMN IF NOT EXISTS description TEXT;

        CREATE TABLE IF NOT EXISTS api_keys (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id VARCHAR(64) REFERENCES projects(id) ON DELETE CASCADE,
          key_hash VARCHAR(255) NOT NULL UNIQUE,
          masked_key VARCHAR(32) NOT NULL,
          label VARCHAR(128) NOT NULL,
          revoked BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          last_used_at TIMESTAMP WITH TIME ZONE
        );

        CREATE TABLE IF NOT EXISTS project_users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id VARCHAR(64) REFERENCES projects(id) ON DELETE CASCADE,
          external_user_id VARCHAR(128) NOT NULL,
          name VARCHAR(128),
          email VARCHAR(255),
          plan VARCHAR(64) DEFAULT 'free',
          blocked BOOLEAN DEFAULT FALSE,
          tokens_today INT DEFAULT 0,
          tokens_month INT DEFAULT 0,
          requests_today INT DEFAULT 0,
          requests_month INT DEFAULT 0,
          context_variables JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          last_active TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS user_memories (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id VARCHAR(64) REFERENCES projects(id) ON DELETE CASCADE,
          user_id VARCHAR(128) NOT NULL,
          key VARCHAR(128) NOT NULL,
          value TEXT NOT NULL,
          category VARCHAR(64) DEFAULT 'general',
          source VARCHAR(64) DEFAULT 'conversation',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS knowledge_entries (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id VARCHAR(64) REFERENCES projects(id) ON DELETE CASCADE,
          title VARCHAR(255) NOT NULL,
          content TEXT NOT NULL,
          category VARCHAR(64) DEFAULT 'general',
          tags JSONB DEFAULT '[]'::jsonb,
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS learned_skills (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id VARCHAR(64) REFERENCES projects(id) ON DELETE CASCADE,
          trigger_phrase VARCHAR(255) NOT NULL,
          solution_template TEXT NOT NULL,
          tool_action VARCHAR(128),
          confidence INT DEFAULT 95,
          times_used INT DEFAULT 0,
          tokens_saved INT DEFAULT 0,
          cost_saved_usd INT DEFAULT 0,
          status VARCHAR(32) DEFAULT 'active',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS conversations (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id VARCHAR(64) REFERENCES projects(id) ON DELETE CASCADE,
          user_id VARCHAR(128) NOT NULL,
          title VARCHAR(255) DEFAULT 'New Conversation',
          call_mode VARCHAR(32) DEFAULT 'ws',
          total_tokens INT DEFAULT 0,
          messages JSONB DEFAULT '[]'::jsonb,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS analytics_logs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id VARCHAR(64) REFERENCES projects(id) ON DELETE CASCADE,
          protocol VARCHAR(32) NOT NULL,
          duration_ms INT DEFAULT 0,
          tokens_used INT DEFAULT 0,
          tokens_saved INT DEFAULT 0,
          source VARCHAR(64) DEFAULT 'ai',
          status_code INT DEFAULT 200,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS project_tools (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id VARCHAR(64) REFERENCES projects(id) ON DELETE CASCADE,
          name VARCHAR(128) NOT NULL,
          description TEXT NOT NULL,
          parameters JSONB DEFAULT '{"type": "object", "properties": {}, "required": []}'::jsonb,
          returns_description TEXT DEFAULT 'Returns data or status of the action.',
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        -- PART A: KNOWLEDGE PATTERN SYSTEM (Tables 1-10)
        CREATE TABLE IF NOT EXISTS knowledge_patterns (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id VARCHAR(64) REFERENCES projects(id) ON DELETE CASCADE,
          intent VARCHAR(100) NOT NULL,
          pattern_type VARCHAR(50) NOT NULL,
          example_phrases JSONB DEFAULT '[]'::jsonb NOT NULL,
          embedding JSONB,
          description TEXT,
          category VARCHAR(50) DEFAULT 'general' NOT NULL,
          source VARCHAR(50) DEFAULT 'manual' NOT NULL,
          confidence_score REAL DEFAULT 0.95 NOT NULL,
          usage_count INT DEFAULT 0 NOT NULL,
          success_count INT DEFAULT 0 NOT NULL,
          failure_count INT DEFAULT 0 NOT NULL,
          is_active BOOLEAN DEFAULT TRUE NOT NULL,
          is_verified BOOLEAN DEFAULT FALSE NOT NULL,
          learning_stage VARCHAR(32) DEFAULT 'learning',
          target_variants INT DEFAULT 3,
          quality_score REAL DEFAULT 1.0,
          -- Context-Aware Conditional Response System columns
          reason VARCHAR(100) DEFAULT 'static_response',
          user_state VARCHAR(50) DEFAULT 'any',
          conversation_stage VARCHAR(50) DEFAULT 'any',
          time_context VARCHAR(50) DEFAULT 'any',
          parent_required BOOLEAN DEFAULT FALSE,
          profile_required JSONB DEFAULT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
          last_used_at TIMESTAMP WITH TIME ZONE,
          CONSTRAINT uq_knowledge_pattern UNIQUE (project_id, intent, pattern_type)
        );

        -- Context-Aware Conditional Response System columns (added via ALTER for safety)
        ALTER TABLE knowledge_patterns ADD COLUMN IF NOT EXISTS reason VARCHAR(100) DEFAULT 'static_response';
        ALTER TABLE knowledge_patterns ADD COLUMN IF NOT EXISTS user_state VARCHAR(50) DEFAULT 'any';
        ALTER TABLE knowledge_patterns ADD COLUMN IF NOT EXISTS conversation_stage VARCHAR(50) DEFAULT 'any';
        ALTER TABLE knowledge_patterns ADD COLUMN IF NOT EXISTS time_context VARCHAR(50) DEFAULT 'any';
        ALTER TABLE knowledge_patterns ADD COLUMN IF NOT EXISTS parent_required BOOLEAN DEFAULT FALSE;
        ALTER TABLE knowledge_patterns ADD COLUMN IF NOT EXISTS profile_required JSONB DEFAULT NULL;
        -- Ensure pattern_answer_templates has conditions and priority
        ALTER TABLE pattern_answer_templates ADD COLUMN IF NOT EXISTS conditions JSONB DEFAULT NULL;
        ALTER TABLE pattern_answer_templates ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 1;
        ALTER TABLE pattern_answer_templates ADD COLUMN IF NOT EXISTS variant_type VARCHAR(50) DEFAULT 'default';

        CREATE TABLE IF NOT EXISTS pattern_tool_sequences (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          pattern_id UUID REFERENCES knowledge_patterns(id) ON DELETE CASCADE NOT NULL,
          step_number INT NOT NULL,
          tool_name VARCHAR(100) NOT NULL,
          tool_type VARCHAR(20) DEFAULT 'server' NOT NULL,
          input_mapping JSONB DEFAULT '{}'::jsonb NOT NULL,
          output_key VARCHAR(100),
          is_optional BOOLEAN DEFAULT FALSE NOT NULL,
          condition JSONB,
          depends_on_step INT,
          on_error VARCHAR(50) DEFAULT 'stop' NOT NULL,
          max_retries INT DEFAULT 0 NOT NULL,
          timeout_seconds INT DEFAULT 60 NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pattern_answer_templates (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          pattern_id UUID REFERENCES knowledge_patterns(id) ON DELETE CASCADE NOT NULL,
          template_type VARCHAR(50) DEFAULT 'success' NOT NULL,
          variant_name VARCHAR(50) DEFAULT 'short' NOT NULL,
          template TEXT NOT NULL,
          conditions JSONB,
          priority INT DEFAULT 1 NOT NULL,
          usage_count INT DEFAULT 0 NOT NULL,
          is_active BOOLEAN DEFAULT TRUE NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pattern_missing_inputs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          pattern_id UUID REFERENCES knowledge_patterns(id) ON DELETE CASCADE NOT NULL,
          field_name VARCHAR(100) NOT NULL,
          field_type VARCHAR(50) DEFAULT 'text' NOT NULL,
          question_template TEXT NOT NULL,
          validation_regex VARCHAR(255),
          fetch_from VARCHAR(50) DEFAULT 'client' NOT NULL,
          fetch_tool VARCHAR(100),
          fuzzy_match_enabled BOOLEAN DEFAULT FALSE NOT NULL,
          fuzzy_match_source VARCHAR(100),
          fuzzy_threshold INT DEFAULT 80 NOT NULL,
          ask_priority INT DEFAULT 1 NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pattern_relationships (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          parent_pattern_id UUID REFERENCES knowledge_patterns(id) ON DELETE CASCADE NOT NULL,
          child_pattern_id UUID REFERENCES knowledge_patterns(id) ON DELETE CASCADE NOT NULL,
          relationship_type VARCHAR(50) NOT NULL,
          conditions JSONB,
          weight REAL DEFAULT 1.0 NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_conversations (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id VARCHAR(64) REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
          user_id VARCHAR(255) NOT NULL,
          session_id VARCHAR(255) UNIQUE NOT NULL,
          started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
          last_message_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
          message_count INT DEFAULT 0 NOT NULL,
          user_state VARCHAR(50) DEFAULT 'new' NOT NULL,
          device_type VARCHAR(50) DEFAULT 'web' NOT NULL,
          language VARCHAR(10) DEFAULT 'bn' NOT NULL,
          is_active BOOLEAN DEFAULT TRUE NOT NULL,
          closed_at TIMESTAMP WITH TIME ZONE,
          expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
          cleanup_at TIMESTAMP WITH TIME ZONE
        );

        CREATE TABLE IF NOT EXISTS user_messages (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          conversation_id UUID REFERENCES user_conversations(id) ON DELETE CASCADE NOT NULL,
          project_id VARCHAR(64) REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
          user_id VARCHAR(255) NOT NULL,
          role VARCHAR(20) NOT NULL,
          content TEXT NOT NULL,
          detected_pattern_id UUID REFERENCES knowledge_patterns(id) ON DELETE SET NULL,
          detected_intent VARCHAR(100),
          confidence_score REAL,
          executed_steps JSONB DEFAULT '[]'::jsonb,
          final_answer TEXT,
          was_ai_called BOOLEAN DEFAULT FALSE NOT NULL,
          execution_time_ms INT DEFAULT 0 NOT NULL,
          tokens_used INT DEFAULT 0 NOT NULL,
          status VARCHAR(50) DEFAULT 'completed' NOT NULL,
          parent_message_id UUID,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
          expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
          cleanup_at TIMESTAMP WITH TIME ZONE
        );

        CREATE TABLE IF NOT EXISTS pattern_learning_log (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          pattern_id UUID REFERENCES knowledge_patterns(id) ON DELETE CASCADE NOT NULL,
          learned_from_message_id UUID,
          learned_from_user_id VARCHAR(255),
          learned_from_conversation_id UUID,
          learning_method VARCHAR(50) DEFAULT 'ai_synthesis' NOT NULL,
          ai_provider VARCHAR(100),
          ai_model VARCHAR(100),
          previous_version JSONB,
          new_version JSONB,
          verified_by_admin BOOLEAN DEFAULT FALSE NOT NULL,
          admin_notes TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pattern_feedback (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          pattern_id UUID REFERENCES knowledge_patterns(id) ON DELETE CASCADE NOT NULL,
          message_id UUID,
          user_id VARCHAR(255) NOT NULL,
          feedback_type VARCHAR(50) NOT NULL,
          comment TEXT,
          action_taken VARCHAR(50) DEFAULT 'none' NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS intent_types (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          code VARCHAR(50) UNIQUE NOT NULL,
          name VARCHAR(100) NOT NULL,
          description TEXT,
          default_action VARCHAR(50) DEFAULT 'pattern_match' NOT NULL,
          requires_tools BOOLEAN DEFAULT FALSE NOT NULL,
          requires_ai BOOLEAN DEFAULT FALSE NOT NULL,
          priority INT DEFAULT 1 NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
        );

        -- PART B: USER PROFILE SYSTEM (Tables 11-14)
        CREATE TABLE IF NOT EXISTS user_profiles (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id VARCHAR(64) REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
          user_id VARCHAR(255) NOT NULL,
          display_name VARCHAR(255),
          preferred_language VARCHAR(10) DEFAULT 'bn' NOT NULL,
          timezone VARCHAR(50) DEFAULT 'Asia/Dhaka' NOT NULL,
          user_role VARCHAR(50) DEFAULT 'user' NOT NULL,
          user_state VARCHAR(50) DEFAULT 'new' NOT NULL,
          first_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
          last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
          total_conversations INT DEFAULT 0 NOT NULL,
          total_messages INT DEFAULT 0 NOT NULL,
          is_active BOOLEAN DEFAULT TRUE NOT NULL,
          metadata JSONB DEFAULT '{}'::jsonb NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
          CONSTRAINT uq_user_project UNIQUE (project_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS user_preferences (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_profile_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE NOT NULL,
          project_id VARCHAR(64) REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
          preference_key VARCHAR(100) NOT NULL,
          preference_value JSONB NOT NULL,
          confidence REAL DEFAULT 1.0 NOT NULL,
          source VARCHAR(50) DEFAULT 'explicit' NOT NULL,
          is_active BOOLEAN DEFAULT TRUE NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
          CONSTRAINT uq_user_preference UNIQUE (user_profile_id, preference_key)
        );

        CREATE TABLE IF NOT EXISTS user_facts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_profile_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE NOT NULL,
          project_id VARCHAR(64) REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
          fact_key VARCHAR(100) NOT NULL,
          fact_value JSONB NOT NULL,
          fact_category VARCHAR(50) DEFAULT 'personal' NOT NULL,
          confidence REAL DEFAULT 1.0 NOT NULL,
          source_message_id UUID,
          is_verified BOOLEAN DEFAULT FALSE NOT NULL,
          is_active BOOLEAN DEFAULT TRUE NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_behavior_patterns (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_profile_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE NOT NULL,
          project_id VARCHAR(64) REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
          pattern_type VARCHAR(50) NOT NULL,
          pattern_data JSONB NOT NULL,
          confidence REAL DEFAULT 1.0 NOT NULL,
          observation_count INT DEFAULT 1 NOT NULL,
          last_observed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
        );

        -- PART C: MULTI-LANGUAGE SUPPORT (Tables 15-17)
        CREATE TABLE IF NOT EXISTS pattern_translations (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          pattern_id UUID REFERENCES knowledge_patterns(id) ON DELETE CASCADE NOT NULL,
          language VARCHAR(10) NOT NULL,
          example_phrases JSONB DEFAULT '[]'::jsonb NOT NULL,
          embedding JSONB,
          description TEXT,
          is_default BOOLEAN DEFAULT FALSE NOT NULL,
          confidence_score REAL DEFAULT 0.95 NOT NULL,
          usage_count INT DEFAULT 0 NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
          CONSTRAINT uq_pattern_translation UNIQUE (pattern_id, language)
        );

        CREATE TABLE IF NOT EXISTS answer_translations (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          template_id UUID REFERENCES pattern_answer_templates(id) ON DELETE CASCADE NOT NULL,
          language VARCHAR(10) NOT NULL,
          template TEXT NOT NULL,
          variables_mapping JSONB DEFAULT '{}'::jsonb NOT NULL,
          confidence_score REAL DEFAULT 0.95 NOT NULL,
          is_default BOOLEAN DEFAULT FALSE NOT NULL,
          usage_count INT DEFAULT 0 NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
          CONSTRAINT uq_template_translation UNIQUE (template_id, language)
        );

        CREATE TABLE IF NOT EXISTS languages (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          code VARCHAR(10) UNIQUE NOT NULL,
          name VARCHAR(100) NOT NULL,
          native_name VARCHAR(100) NOT NULL,
          direction VARCHAR(5) DEFAULT 'ltr' NOT NULL,
          is_active BOOLEAN DEFAULT TRUE NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
        );

        -- Pre-populate default Intent Types
        INSERT INTO intent_types (code, name, description, default_action, requires_tools, requires_ai, priority)
        VALUES 
          ('question', 'Informational Question', 'User asking for information, FAQ or status', 'pattern_match', FALSE, FALSE, 1),
          ('command', 'Action / Command', 'User requesting an operation or action to be performed', 'execute_sequence', TRUE, FALSE, 2),
          ('information', 'Fact / Statement', 'User providing information, context or statement', 'save_user_data', FALSE, FALSE, 3),
          ('chat', 'Conversational Smalltalk', 'Smalltalk, greeting or identity conversation', 'quick_reply', FALSE, FALSE, 4),
          ('feedback', 'User Feedback', 'User rating or reviewing an answer or action', 'record_feedback', FALSE, FALSE, 5)
        ON CONFLICT (code) DO NOTHING;

        -- Pre-populate supported Languages
        INSERT INTO languages (code, name, native_name, direction, is_active)
        VALUES
          ('bn', 'Bengali', 'বাংলা', 'ltr', TRUE),
          ('en', 'English', 'English', 'ltr', TRUE),
          ('hi', 'Hindi', 'हिन्दी', 'ltr', TRUE),
          ('ar', 'Arabic', 'العربية', 'rtl', TRUE),
          ('ur', 'Urdu', 'اردو', 'rtl', TRUE)
        ON CONFLICT (code) DO NOTHING;

        -- Indexes for high-speed sub-millisecond retrieval
        CREATE INDEX IF NOT EXISTS idx_kp_project_intent ON knowledge_patterns(project_id, intent);
        CREATE INDEX IF NOT EXISTS idx_kp_active ON knowledge_patterns(is_active);
        CREATE INDEX IF NOT EXISTS idx_pts_pattern_step ON pattern_tool_sequences(pattern_id, step_number);
        CREATE INDEX IF NOT EXISTS idx_pat_pattern_prio ON pattern_answer_templates(pattern_id, priority);
        CREATE INDEX IF NOT EXISTS idx_uconv_project_user ON user_conversations(project_id, user_id);
        CREATE INDEX IF NOT EXISTS idx_uconv_expires ON user_conversations(expires_at);
        CREATE INDEX IF NOT EXISTS idx_umsg_conv ON user_messages(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_umsg_expires ON user_messages(expires_at);
        CREATE INDEX IF NOT EXISTS idx_uprof_project_user ON user_profiles(project_id, user_id);
        CREATE INDEX IF NOT EXISTS idx_upref_profile ON user_preferences(user_profile_id);
        CREATE INDEX IF NOT EXISTS idx_ufacts_profile ON user_facts(user_profile_id);
        CREATE INDEX IF NOT EXISTS idx_ptran_pattern_lang ON pattern_translations(pattern_id, language);
        CREATE INDEX IF NOT EXISTS idx_atran_template_lang ON answer_translations(template_id, language);

        -- ALTER project_tools with new dynamic token-saving columns if not exists
        ALTER TABLE project_tools ADD COLUMN IF NOT EXISTS embedding JSONB;
        ALTER TABLE project_tools ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb;
        ALTER TABLE project_tools ADD COLUMN IF NOT EXISTS short_description VARCHAR(100);
        ALTER TABLE project_tools ADD COLUMN IF NOT EXISTS compact_schema TEXT;
        ALTER TABLE project_tools ADD COLUMN IF NOT EXISTS tier INTEGER DEFAULT 1;

        -- Create cached_responses Table
        CREATE TABLE IF NOT EXISTS cached_responses (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id VARCHAR(64) REFERENCES projects(id) ON DELETE CASCADE,
          message_hash VARCHAR(64) NOT NULL,
          trigger_text TEXT,
          response TEXT NOT NULL,
          language VARCHAR(10),
          usage_count INT DEFAULT 0,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        ALTER TABLE cached_responses ADD COLUMN IF NOT EXISTS trigger_text TEXT;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_cached_resp_hash ON cached_responses(project_id, message_hash);

        -- Create intent_cache Table
        CREATE TABLE IF NOT EXISTS intent_cache (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id VARCHAR(64) REFERENCES projects(id) ON DELETE CASCADE,
          message_hash VARCHAR(64) NOT NULL,
          intent VARCHAR(50) NOT NULL,
          topic VARCHAR(100),
          confidence REAL,
          expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_intent_cache_hash ON intent_cache(project_id, message_hash);
      `);

      console.log('[PostgreSQL] Schema initialization complete! All tables (including cached_responses, intent_cache, and updated project_tools) ready.');
      return true;
    } finally {
      client.release();
    }
  } catch (error: any) {
    console.error('[PostgreSQL Schema Init Error]:', error?.message);
    return false;
  }
}

export const getDrizzleDb = () => {
  const p = getPgPool();
  return p ? drizzle(p, { schema }) : null;
};

// Aliases for compatibility
export const pool = getPgPool();
export const pgDb = getDrizzleDb();
export const isPgConnected = !!getPgPool();

/**
 * Ensures that a project exists in the PostgreSQL projects table
 * so that any foreign key references from user_profiles, user_conversations,
 * knowledge_patterns, etc. will succeed seamlessly.
 */
export async function ensureProjectInDb(projectId: string, name?: string): Promise<boolean> {
  if (!projectId) return false;
  const p = getPgPool();
  if (!p) return false;
  try {
    await p.query(
      `INSERT INTO projects (id, name, platform, created_at, updated_at)
       VALUES ($1, $2, 'web', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [projectId, name || `Project ${projectId}`]
    );
    return true;
  } catch (err: any) {
    console.warn('[PostgreSQL] ensureProjectInDb error:', err?.message);
    return false;
  }
}

/**
 * Permanently deletes a project and cascades deletion across all database tables
 * (api_keys, project_users, user_memories, knowledge_entries, learned_skills,
 * conversations, analytics_logs, project_tools, user_messages, user_conversations,
 * user_behavior_patterns, user_profiles, knowledge_patterns, etc.)
 */
export async function deleteProjectCascadeFromDb(projectId: string): Promise<boolean> {
  if (!projectId) return false;
  const p = getPgPool();
  if (!p) return false;

  try {
    const client = await p.connect();
    try {
      await client.query('BEGIN');

      // Explicitly remove all child records for this project
      await client.query('DELETE FROM api_keys WHERE project_id = $1', [projectId]).catch(() => {});
      await client.query('DELETE FROM project_users WHERE project_id = $1', [projectId]).catch(() => {});
      await client.query('DELETE FROM user_memories WHERE project_id = $1', [projectId]).catch(() => {});
      await client.query('DELETE FROM knowledge_entries WHERE project_id = $1', [projectId]).catch(() => {});
      await client.query('DELETE FROM learned_skills WHERE project_id = $1', [projectId]).catch(() => {});
      await client.query('DELETE FROM conversations WHERE project_id = $1', [projectId]).catch(() => {});
      await client.query('DELETE FROM analytics_logs WHERE project_id = $1', [projectId]).catch(() => {});
      await client.query('DELETE FROM project_tools WHERE project_id = $1', [projectId]).catch(() => {});

      // Knowledge Pattern System tables
      await client.query('DELETE FROM user_messages WHERE conversation_id IN (SELECT id FROM user_conversations WHERE project_id = $1)', [projectId]).catch(() => {});
      await client.query('DELETE FROM user_conversations WHERE project_id = $1', [projectId]).catch(() => {});
      await client.query('DELETE FROM user_behavior_patterns WHERE project_id = $1', [projectId]).catch(() => {});
      await client.query('DELETE FROM user_profiles WHERE project_id = $1', [projectId]).catch(() => {});
      await client.query('DELETE FROM knowledge_patterns WHERE project_id = $1', [projectId]).catch(() => {});

      // Delete project root row
      await client.query('DELETE FROM projects WHERE id = $1', [projectId]);

      await client.query('COMMIT');
      console.log(`[PostgreSQL] Cascaded hard deletion completed for project: ${projectId}`);
      return true;
    } catch (e: any) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[PostgreSQL] Error in deleteProjectCascadeFromDb: ${e?.message}`);
      return false;
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.error(`[PostgreSQL Pool Error] deleteProjectCascadeFromDb: ${err?.message}`);
    return false;
  }
}
