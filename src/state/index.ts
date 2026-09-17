import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface Client {
  id: string;
  name: string;
  platform: string;
  description?: string;
  behavior_description?: string;
  system_prompt?: string;
  ai_provider?: string;
  ai_model?: string;
  tts_engine?: 'gemini' | 'edge';
  tts_voice?: string;
  temperature?: number;
  max_tokens?: number;
  daily_request_limit?: number | null;
  monthly_request_limit?: number | null;
  daily_token_limit?: number | null;
  monthly_token_limit?: number | null;
  suspended: boolean;
  created_at: string;
  updated_at: string;
}

export interface ApiKey {
  id: string;
  client_id: string;
  key_hash: string;
  masked: string;
  last4: string;
  label: string;
  revoked: boolean;
  created_at: string;
  last_used_at?: string;
  raw_key?: string; // stored for demo project reference
}

export interface KnowledgeEntry {
  id: string;
  client_id: string;
  category: string;
  trigger_text: string;
  response_text: string;
  tool_calls?: any[];
  active: boolean;
  learned: boolean;
  hit_count: number;
  created_at: string;
  updated_at: string;
  embedding?: number[];
}

export interface ToolDef {
  id: string;
  client_id?: string | null;
  name: string;
  description: string;
  type: 'server' | 'client';
  scope?: 'system' | 'project';
  schema: Record<string, any>;
  enabled: boolean;
  embedding?: number[];
  tags?: string[];
  short_description?: string;
  compact_schema?: string;
  tier?: number;
  created_at: string;
  updated_at: string;
}

export interface UserProfile {
  id: string;
  client_id: string;
  external_id: string;
  name?: string;
  email?: string;
  plan: string;
  blocked: boolean;
  block_message?: string;
  is_logged_out?: boolean;
  tokens_today: number;
  tokens_month: number;
  requests_today: number;
  requests_month: number;
  errors_total: number;
  created_at: string;
  last_active?: string;
}

export interface SkillParameterSlot {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum';
  description?: string;
  required?: boolean;
  default_value?: any;
  extraction_regex?: string;
}

export interface SkillToolStep {
  tool_name: string;
  args_template: Record<string, any>;
  description?: string;
}

export interface LearnedSkill {
  id: string;
  client_id: string | null; // null = global system skill, or project-specific ID
  name: string;
  category: string;
  intent_description: string;
  trigger_patterns: string[];
  parameter_slots: SkillParameterSlot[];
  tool_sequence: SkillToolStep[];
  response_template?: string;
  verified: boolean;
  confidence_score: number;
  success_count: number;
  fail_count: number;
  last_executed_at?: string;
  created_at: string;
  updated_at: string;
  learned_from_query?: string;
  status: 'active' | 'learning' | 'needs_review' | 'disabled';
}

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: string;
  source?: 'ai' | 'learned_skill' | 'tool' | 'knowledge' | 'fallback';
  tool_calls?: any[];
  tool_results?: any[];
  skill_id?: string;
}

export interface ConversationSession {
  id: string;
  client_id: string;
  user_id: string;
  title?: string;
  messages: ConversationMessage[];
  context: {
    active_topic?: string;
    entities: Record<string, any>;
    last_tool?: string;
    last_result?: any;
  };
  created_at: string;
  updated_at: string;
}

export interface ExecutionLog {
  id: string;
  client_id: string;
  user_ref: string;
  query_text: string;
  response_text: string;
  source: 'knowledge' | 'ai' | 'tool' | 'learned_skill' | 'error' | 'fallback' | 'knowledge_base' | 'llm';
  tokens_used: number;
  tokens_saved?: number;
  cost_usd: number;
  latency_ms: number;
  status_code: number;
  error_message?: string;
  model?: string;
  provider?: string;
  tools_used?: string[];
  started_at?: string;
  ended_at?: string;
  logic_steps?: string[];
  created_at: string;
}

export interface AuditLog {
  id: string;
  level: string;
  source: string;
  actor: string;
  message: string;
  created_at: string;
}

export interface FallbackItem {
  provider_id: string;
  model: string;
  enabled: boolean;
}

export interface FallbackConfig {
  primary_provider: string;
  primary_model: string;
  auto_fallback: boolean;
  max_retries_per_step: number;
  chain: FallbackItem[];
}

export interface AiProviderKeyRecord {
  id: string;
  name: string;
  api_key: string;
  enabled: boolean;
  status: 'healthy' | 'error' | 'rate_limited';
}

export interface AiProviderRecord {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  api_key: string;
  keys: AiProviderKeyRecord[];
  base_url?: string;
  model?: string;
  models: string[];
  temperature: number;
  max_tokens: number;
  latency_ms: number;
  cost_per_1k: number;
  status: 'healthy' | 'unconfigured' | 'error' | 'degraded';
  last_error?: string;
  error_type?: string;
  last_error_at?: string;
  consecutive_errors?: number;
  is_custom: boolean;
  is_primary?: boolean;
  created_at: string;
}

export interface AdminConfig {
  username: string;
  email: string;
  passwordHash: string; // bcrypt or fallback
  management_key: string;
}

export function hashApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

export function maskApiKey(rawKey: string): string {
  if (rawKey.length <= 8) return 'hla_live_****';
  const prefix = rawKey.slice(0, 8);
  const suffix = rawKey.slice(-4);
  return `${prefix}****…${suffix}`;
}

export function generateApiKey(): { visible: string; keyHash: string } {
  const random = crypto.randomBytes(32).toString('hex'); // 64 chars long
  const visible = `hla_live_${random}`;
  return { visible, keyHash: hashApiKey(visible) };
}

// Persistent Storage State Store
const DATA_DIR = path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'state_store.json');

class StateStore {
  clients = new Map<string, Client>();
  apiKeys = new Map<string, ApiKey>();
  knowledge = new Map<string, KnowledgeEntry>();
  tools = new Map<string, ToolDef>();
  users = new Map<string, UserProfile>();
  executionLogs: ExecutionLog[] = [];
  auditLogs: AuditLog[] = [];
  providers = new Map<string, AiProviderRecord>();
  userContext = new Map<string, Record<string, any>>();
  conversations = new Map<string, ConversationSession>();
  skills = new Map<string, LearnedSkill>();
  jwtDenylist = new Set<string>();
  activeProjectId: string = '';
  jwtSecret: string = process.env.JWT_SECRET_KEY || 'hla_jwt_super_secret_signing_key_2026';
  isLoadedFromPg: boolean = false;
  pgReady: boolean = false;
  lastLoadedTimestamp: string | null = null;

  private broadcastHandler: ((event: any) => void) | null = null;
  private saveTimeout: NodeJS.Timeout | null = null;
  private pgSaveQueue: Promise<void> = Promise.resolve();
  private pendingPersist = false;

  fallbackConfig: FallbackConfig = {
    primary_provider: 'gemini',
    primary_model: 'gemini-2.5-flash',
    auto_fallback: true,
    max_retries_per_step: 1,
    chain: [],
  };

  adminConfig: AdminConfig = {
    username: process.env.MANAGEMENT_USERNAME || 'admin',
    email: process.env.MANAGEMENT_EMAIL || 'admin@highlyagent.io',
    passwordHash: '$2a$10$vI8aWBnW3fID.ZQ4/zo1G.q1qgW1h7mF4yOQdE26hVUkN.N5OqD2O', // default 'admin123'
    management_key: process.env.MANAGEMENT_API_KEY || 'hla_mgmt_secret_key_8899',
  };

  bootTime = Date.now();

  constructor() {
    const loaded = this.loadFromDisk();
    if (!loaded) {
      this.seedDefaults();
    } else {
      this.mergeEnvironmentProviders();
    }
  }

  setBroadcastHandler(handler: (event: any) => void) {
    this.broadcastHandler = handler;
  }

  notifyBroadcast(event: any) {
    if (this.broadcastHandler) {
      try {
        this.broadcastHandler(event);
      } catch (err) {
        console.warn('[StateStore Broadcast Error]:', err);
      }
    }
  }

  /**
   * Snapshot of hot in-memory cache. PostgreSQL is the source of truth;
   * this JSON is only a local fast cache for boot / frequently used data.
   */
  private serializeState() {
    return {
      version: '2.5.0',
      saved_at: new Date().toISOString(),
      activeProjectId: this.activeProjectId,
      clients: Array.from(this.clients.entries()),
      apiKeys: Array.from(this.apiKeys.entries()),
      knowledge: Array.from(this.knowledge.entries()),
      tools: Array.from(this.tools.entries()),
      users: Array.from(this.users.entries()),
      providers: Array.from(this.providers.entries()),
      skills: Array.from(this.skills.entries()),
      fallbackConfig: this.fallbackConfig,
      adminConfig: this.adminConfig,
      executionLogs: this.executionLogs.slice(0, 2000),
      auditLogs: this.auditLogs.slice(0, 500),
    };
  }

  /**
   * Persist hot cache to disk and write the canonical dump to PostgreSQL.
   * Memory is updated immediately by callers; this keeps disk + PG in sync
   * so a later GET never serves stale data.
   */
  persist(immediate = false) {
    if (!this.isLoadedFromPg) {
      this.pendingPersist = true;
      return;
    }
    if (immediate) {
      if (this.saveTimeout) {
        clearTimeout(this.saveTimeout);
        this.saveTimeout = null;
      }
      this.writeToDisk();
      return;
    }

    if (this.saveTimeout) return;
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      this.writeToDisk();
    }, 80);
  }

  private writeLocalCache(serialized: ReturnType<StateStore['serializeState']>) {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const tempFile = `${STATE_FILE}.tmp.${Date.now()}`;
    fs.writeFileSync(tempFile, JSON.stringify(serialized, null, 2), 'utf-8');
    fs.renameSync(tempFile, STATE_FILE);
  }

  private writeToDisk() {
    if (!this.isLoadedFromPg) {
      console.log('[StateStore] Skipping persist: PostgreSQL source of truth is not yet loaded.');
      return;
    }
    try {
      const serialized = this.serializeState();
      this.writeLocalCache(serialized);
      this.enqueuePostgresDump(serialized);
    } catch (err: any) {
      console.error('[StateStore Persist Error]:', err?.message);
    }
  }

  private enqueuePostgresDump(serialized: ReturnType<StateStore['serializeState']>) {
    this.pgSaveQueue = this.pgSaveQueue
      .then(() => this.writeToPostgres(serialized))
      .catch((e) => {
        console.warn('[Postgres State Persist Error]:', e);
      });
  }

  private async writeToPostgres(serialized: ReturnType<StateStore['serializeState']>) {
    const dbModule = await import('../db/index.js');
    const pool = dbModule.getPgPool();
    if (!pool) return;
    await pool.query(
      `
      INSERT INTO server_state_dump (id, data, updated_at)
      VALUES (1, $1::jsonb, NOW())
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW();
    `,
      [JSON.stringify(serialized)]
    );
    const res = await pool.query('SELECT updated_at FROM server_state_dump WHERE id = 1');
    if (res.rows.length > 0) {
      this.lastLoadedTimestamp = res.rows[0].updated_at ? new Date(res.rows[0].updated_at).toISOString() : null;
    }
  }

  private applySerializedData(data: any) {
    if (data.activeProjectId) this.activeProjectId = data.activeProjectId;
    if (Array.isArray(data.clients)) this.clients = new Map(data.clients);
    if (Array.isArray(data.apiKeys)) this.apiKeys = new Map(data.apiKeys);
    if (Array.isArray(data.knowledge)) this.knowledge = new Map(data.knowledge);
    if (Array.isArray(data.tools)) this.tools = new Map(data.tools);
    if (Array.isArray(data.users)) this.users = new Map(data.users);
    if (Array.isArray(data.providers)) this.providers = new Map(data.providers);
    if (Array.isArray(data.skills)) this.skills = new Map(data.skills);
    if (data.fallbackConfig) this.fallbackConfig = data.fallbackConfig;
    if (data.adminConfig) this.adminConfig = { ...this.adminConfig, ...data.adminConfig };
    if (Array.isArray(data.executionLogs)) this.executionLogs = data.executionLogs;
    if (Array.isArray(data.auditLogs)) this.auditLogs = data.auditLogs;

    // Migrate any deprecated or invalid Gemini model names to gemini-2.5-flash
    for (const [, client] of this.clients.entries()) {
      if (!client.ai_model || ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-flash-latest'].includes(client.ai_model)) {
        client.ai_model = 'gemini-2.5-flash';
      }
    }

    const geminiProv = this.providers.get('gemini');
    if (geminiProv) {
      if (!geminiProv.model || ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-flash-latest'].includes(geminiProv.model)) {
        geminiProv.model = 'gemini-2.5-flash';
      }
      geminiProv.models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-2.5-pro'];
    }

    if (this.fallbackConfig) {
      if (!this.fallbackConfig.primary_model || ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-flash-latest'].includes(this.fallbackConfig.primary_model)) {
        this.fallbackConfig.primary_model = 'gemini-2.5-flash';
      }
    }
  }

  async loadFromPostgres() {
    try {
      const dbModule = await import('../db/index.js');
      if (!dbModule.isPostgresConfigured()) {
        console.warn('[StateStore] DATABASE_URL is not set. Hot cache is in-memory only until PostgreSQL is configured.');
        return;
      }

      const pool = dbModule.getPgPool();
      if (!pool) {
        console.warn('[StateStore] PostgreSQL pool failed to initialize.');
        return;
      }

      await dbModule.waitForPgSchema();
      await pool.query('SELECT 1');
      this.pgReady = true;

      const res = await pool.query(`SELECT data, updated_at FROM server_state_dump WHERE id = 1`);
      if (res.rows.length > 0 && res.rows[0].data) {
        this.lastLoadedTimestamp = res.rows[0].updated_at ? new Date(res.rows[0].updated_at).toISOString() : null;
        this.applySerializedData(res.rows[0].data);
        this.mergeEnvironmentProviders();
        console.log(`[StateStore] PostgreSQL is source of truth. Hot cache hydrated (${this.clients.size} projects, ${this.users.size} users, dump ${res.rows[0].updated_at}).`);
      } else {
        console.log('[StateStore] Empty PostgreSQL dump — keeping schema only, not copying disk/Neon cache into the database.');
        this.clients.clear();
        this.apiKeys.clear();
        this.knowledge.clear();
        this.users.clear();
        this.skills.clear();
        this.conversations.clear();
        this.userContext.clear();
        this.executionLogs = [];
        this.activeProjectId = '';
        this.seedDefaults();
        await this.writeToPostgres(this.serializeState());
      }
    } catch (e: any) {
      console.warn('[Postgres State Load Error]:', e?.message);
      this.pgReady = false;
    } finally {
      this.isLoadedFromPg = true;
      try {
        this.writeLocalCache(this.serializeState());
      } catch (err: any) {
        console.warn('[StateStore Post-PG Load Cache Save Failed]:', err?.message);
      }
      if (this.pendingPersist) {
        this.pendingPersist = false;
        this.writeToDisk();
      }
    }
  }

  /**
   * Re-read canonical state from PostgreSQL into the hot memory cache.
   * Use after an external write, or when stale cache is suspected.
   */
  async refreshHotCacheFromPostgres(): Promise<boolean> {
    try {
      const dbModule = await import('../db/index.js');
      const pool = dbModule.getPgPool();
      if (!pool) return false;
      const res = await pool.query(`SELECT data, updated_at FROM server_state_dump WHERE id = 1`);
      if (res.rows.length > 0 && res.rows[0].data) {
        this.lastLoadedTimestamp = res.rows[0].updated_at ? new Date(res.rows[0].updated_at).toISOString() : null;
        this.applySerializedData(res.rows[0].data);
        this.mergeEnvironmentProviders();
        this.writeLocalCache(this.serializeState());
        return true;
      }
      return false;
    } catch (e: any) {
      console.warn('[StateStore] Hot cache refresh failed:', e?.message);
      return false;
    }
  }

  private lastPgSyncTime = 0;

  async syncWithPostgresIfNeeded(): Promise<void> {
    const now = Date.now();
    // Throttle checks to once every 12 seconds to avoid overloading PostgreSQL
    if (now - this.lastPgSyncTime < 12000) {
      return;
    }
    this.lastPgSyncTime = now;
    
    try {
      const dbModule = await import('../db/index.js');
      if (!dbModule.isPostgresConfigured()) return;
      const pool = dbModule.getPgPool();
      if (!pool) return;

      // STEP 1: FAST-PATH CHECK. Fetch only the lightweight updated_at timestamp.
      // This is extremely light (sub-millisecond indexed check) and has virtually zero DB overhead.
      const timeRes = await pool.query(`SELECT updated_at FROM server_state_dump WHERE id = 1`);
      if (timeRes.rows.length > 0) {
        const dbTime = timeRes.rows[0].updated_at ? new Date(timeRes.rows[0].updated_at).toISOString() : null;
        
        // STEP 2: Only fetch the heavy 'data' JSON if the DB has actually changed externally!
        if (dbTime !== this.lastLoadedTimestamp) {
          const res = await pool.query(`SELECT data, updated_at FROM server_state_dump WHERE id = 1`);
          if (res.rows.length > 0 && res.rows[0].data) {
            this.lastLoadedTimestamp = res.rows[0].updated_at ? new Date(res.rows[0].updated_at).toISOString() : null;
            this.applySerializedData(res.rows[0].data);
            this.mergeEnvironmentProviders();
            this.writeLocalCache(this.serializeState());
            console.log(`[StateStore] Auto-synced server state from PostgreSQL (New dump date: ${this.lastLoadedTimestamp}).`);
          }
        }
      }
    } catch (e: any) {
      console.warn('[StateStore Auto PG Sync Failed]:', e?.message);
    }
  }

  private loadFromDisk(): boolean {
    try {
      if (!fs.existsSync(STATE_FILE)) return false;
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      if (!raw || raw.trim().length === 0) return false;

      const data = JSON.parse(raw);
      this.applySerializedData(data);

      console.log(`[StateStore] Successfully loaded persistent state from ${STATE_FILE} (${this.clients.size} projects, ${this.providers.size} providers).`);
      return true;
    } catch (err: any) {
      console.warn('[StateStore Load Error]:', err?.message);
      return false;
    }
  }

  /**
   * Merge any newly provided API keys from environment into persistent providers
   */
  private mergeEnvironmentProviders() {
    const geminiKey = process.env.GEMINI_API_KEY || '';
    const openAiKey = process.env.OPENAI_API_KEY || '';
    const anthropicKey = process.env.ANTHROPIC_API_KEY || '';
    const deepseekKey = process.env.DEEPSEEK_API_KEY || '';
    const now = new Date().toISOString();

    if (geminiKey && !this.providers.has('gemini')) {
      this.providers.set('gemini', {
        id: 'gemini',
        name: 'Google Gemini',
        kind: 'gemini',
        enabled: true,
        api_key: geminiKey,
        keys: [{ id: crypto.randomUUID(), name: 'Key 1', api_key: geminiKey, enabled: true, status: 'healthy' }],
        model: 'gemini-2.5-flash',
        models: ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-2.5-pro'],
        temperature: 0.4,
        max_tokens: 2048,
        latency_ms: 120,
        cost_per_1k: 0.00015,
        status: 'healthy',
        is_custom: false,
        is_primary: true,
        created_at: now,
      });
    }

    if (openAiKey && !this.providers.has('openai')) {
      this.providers.set('openai', {
        id: 'openai',
        name: 'OpenAI GPT',
        kind: 'openai',
        enabled: true,
        api_key: openAiKey,
        keys: [{ id: crypto.randomUUID(), name: 'Key 1', api_key: openAiKey, enabled: true, status: 'healthy' }],
        model: 'gpt-4o-mini',
        models: ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'],
        temperature: 0.4,
        max_tokens: 2048,
        latency_ms: 180,
        cost_per_1k: 0.0006,
        status: 'healthy',
        is_custom: false,
        is_primary: !geminiKey,
        created_at: now,
      });
    }

    if (anthropicKey && !this.providers.has('claude')) {
      this.providers.set('claude', {
        id: 'claude',
        name: 'Anthropic Claude',
        kind: 'claude',
        enabled: true,
        api_key: anthropicKey,
        keys: [{ id: crypto.randomUUID(), name: 'Key 1', api_key: anthropicKey, enabled: true, status: 'healthy' }],
        model: 'claude-3-5-sonnet-20241022',
        models: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022'],
        temperature: 0.4,
        max_tokens: 2048,
        latency_ms: 210,
        cost_per_1k: 0.003,
        status: 'healthy',
        is_custom: false,
        created_at: now,
      });
    }

    if (deepseekKey && !this.providers.has('deepseek')) {
      this.providers.set('deepseek', {
        id: 'deepseek',
        name: 'DeepSeek AI',
        kind: 'deepseek',
        enabled: true,
        api_key: deepseekKey,
        keys: [{ id: crypto.randomUUID(), name: 'Key 1', api_key: deepseekKey, enabled: true, status: 'healthy' }],
        model: 'deepseek-chat',
        models: ['deepseek-chat', 'deepseek-reasoner'],
        temperature: 0.4,
        max_tokens: 2048,
        latency_ms: 240,
        cost_per_1k: 0.00028,
        status: 'healthy',
        is_custom: false,
        created_at: now,
      });
    }

    // Ensure fallbackConfig has a primary provider
    if (!this.fallbackConfig.primary_provider && this.providers.size > 0) {
      const first = Array.from(this.providers.values())[0];
      this.fallbackConfig.primary_provider = first.id;
      this.fallbackConfig.primary_model = first.model || first.models[0] || '';
      first.is_primary = true;
    }
  }

  audit(actor: string, action: string, message: string, level = 'INFO') {
    this.auditLogs.unshift({
      id: crypto.randomUUID(),
      level,
      source: 'admin',
      actor,
      message: `${action} — ${message}`,
      created_at: new Date().toISOString(),
    });
    if (this.auditLogs.length > 500) {
      this.auditLogs.pop();
    }
    this.persist();
  }

  logExecution(
    clientId: string,
    userRef: string,
    query: string,
    response: string,
    source: ExecutionLog['source'],
    tokens: number,
    costUsd: number,
    latencyMs: number,
    statusCode: number,
    tokensSaved = 0,
    meta?: { errorMessage?: string; model?: string; provider?: string; toolsUsed?: string[]; startedAt?: string; endedAt?: string }
  ) {
    const now = new Date();
    const startedAt = meta?.startedAt || new Date(now.getTime() - latencyMs).toISOString();
    const endedAt = meta?.endedAt || now.toISOString();
    const logItem: ExecutionLog = {
      id: crypto.randomUUID(),
      client_id: clientId,
      user_ref: userRef,
      query_text: query,
      response_text: response,
      source,
      tokens_used: tokens,
      tokens_saved: tokensSaved,
      cost_usd: costUsd,
      latency_ms: latencyMs,
      status_code: statusCode,
      created_at: endedAt,
      error_message: meta?.errorMessage,
      model: meta?.model,
      provider: meta?.provider,
      tools_used: meta?.toolsUsed,
      started_at: startedAt,
      ended_at: endedAt,
    };

    this.executionLogs.unshift(logItem);
    if (this.executionLogs.length > 2000) {
      this.executionLogs.pop();
    }

    this.persist();

    // Broadcast real-time hit notification via WebSocket
    const client = this.clients.get(clientId);
    this.notifyBroadcast({
      type: 'request:hit',
      data: logItem,
      client_name: client?.name || clientId,
      provider: client?.ai_provider || this.fallbackConfig.primary_provider || 'gemini',
      model: client?.ai_model || this.fallbackConfig.primary_model || 'gemini-2.5-flash',
    });
  }

  seedDefaults() {
    const now = new Date().toISOString();

    // 1. Configure AI Providers based on environment variables
    const geminiKey = process.env.GEMINI_API_KEY || '';
    const openAiKey = process.env.OPENAI_API_KEY || '';
    const anthropicKey = process.env.ANTHROPIC_API_KEY || '';
    const deepseekKey = process.env.DEEPSEEK_API_KEY || '';

    if (geminiKey) {
      this.providers.set('gemini', {
        id: 'gemini',
        name: 'Google Gemini',
        kind: 'gemini',
        enabled: true,
        api_key: geminiKey,
        keys: [{ id: crypto.randomUUID(), name: 'Key 1', api_key: geminiKey, enabled: true, status: 'healthy' }],
        model: 'gemini-2.5-flash',
        models: ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-2.5-pro'],
        temperature: 0.4,
        max_tokens: 2048,
        latency_ms: 120,
        cost_per_1k: 0.00015,
        status: 'healthy',
        is_custom: false,
        is_primary: true,
        created_at: now,
      });
    }

    if (openAiKey) {
      this.providers.set('openai', {
        id: 'openai',
        name: 'OpenAI GPT',
        kind: 'openai',
        enabled: true,
        api_key: openAiKey,
        keys: [{ id: crypto.randomUUID(), name: 'Key 1', api_key: openAiKey, enabled: true, status: 'healthy' }],
        model: 'gpt-4o-mini',
        models: ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'],
        temperature: 0.4,
        max_tokens: 2048,
        latency_ms: 180,
        cost_per_1k: 0.0006,
        status: 'healthy',
        is_custom: false,
        is_primary: !geminiKey,
        created_at: now,
      });
    }

    if (anthropicKey) {
      this.providers.set('claude', {
        id: 'claude',
        name: 'Anthropic Claude',
        kind: 'claude',
        enabled: true,
        api_key: anthropicKey,
        keys: [{ id: crypto.randomUUID(), name: 'Key 1', api_key: anthropicKey, enabled: true, status: 'healthy' }],
        model: 'claude-3-5-sonnet-20241022',
        models: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022'],
        temperature: 0.4,
        max_tokens: 2048,
        latency_ms: 210,
        cost_per_1k: 0.003,
        status: 'healthy',
        is_custom: false,
        created_at: now,
      });
    }

    if (deepseekKey) {
      this.providers.set('deepseek', {
        id: 'deepseek',
        name: 'DeepSeek AI',
        kind: 'deepseek',
        enabled: true,
        api_key: deepseekKey,
        keys: [{ id: crypto.randomUUID(), name: 'Key 1', api_key: deepseekKey, enabled: true, status: 'healthy' }],
        model: 'deepseek-chat',
        models: ['deepseek-chat', 'deepseek-reasoner'],
        temperature: 0.4,
        max_tokens: 2048,
        latency_ms: 240,
        cost_per_1k: 0.00028,
        status: 'healthy',
        is_custom: false,
        created_at: now,
      });
    }

    const allAdded = Array.from(this.providers.values());
    if (allAdded.length > 0) {
      const primary = allAdded.find((p) => p.is_primary) || allAdded[0];
      const others = allAdded.filter((p) => p.id !== primary.id);
      this.fallbackConfig = {
        primary_provider: primary.id,
        primary_model: primary.model || primary.models[0] || 'gemini-2.5-flash',
        auto_fallback: true,
        max_retries_per_step: 1,
        chain: others.map((p) => ({
          provider_id: p.id,
          model: p.model || p.models[0] || '',
          enabled: true,
        })),
      };
    }

    // Zero pre-seeded default skills or demo data. Projects start cleanly with 0 skills.
    this.audit('system', 'INITIALIZE', 'HighLyAgent engine booted cleanly with zero demo data. Ready for real user projects.');
  }
}

export const store = new StateStore();
store.loadFromPostgres().then(() => {
  store.persist(true);
});
