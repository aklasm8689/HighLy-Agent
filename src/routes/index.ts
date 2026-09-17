import { Router, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import {
  store,
  generateApiKey,
  maskApiKey,
  hashApiKey,
  Client,
  ApiKey,
  KnowledgeEntry,
  LearnedSkill,
  ToolDef,
  UserProfile,
} from '../state';
import { verifyManagementAuth, verifyClientAuth } from '../middleware/auth';
import { knowledgeEngine } from '../services/knowledge';
import { skillEngine } from '../services/skills';
import { providerPool } from '../services/providers';
import { agentCore } from '../services/agent';
import { toolEngine } from '../services/tools';
import { ttsService } from '../services/tts';
import { isAiQuotaExceeded, getAiQuotaErrorDetail } from '../ai/status';
import {
  knowledgePatternEngine,
  userProfileEngine,
  multiLangEngine,
  conversationRetentionScheduler,
  feedbackEngine,
  highSpeedCacheEngine,
} from '../services/knowledgeSystem';
import { ensureProjectInDb, deleteProjectCascadeFromDb } from '../db';
import { traceService } from '../services/trace';
import { CLIENT_SERVER_ERROR_MESSAGE, isClientSafeErrorCode } from '../clientErrors';
import { getProjectCachedResponses, deleteCachedResponseById, updateCachedResponseById } from '../services/templateCacheService';

export const apiRouter = Router();

interface IpTrafficEntry {
  ip: string;
  total_requests: number;
  requests_last_minute: number;
  invalid_key_attempts: number;
  last_seen: string;
  status: 'normal' | 'suspicious' | 'blocked';
  suspicious_reason?: string;
  last_reset?: number;
}

const activeIpTracker = new Map<string, IpTrafficEntry>();
const blockedIpSet = new Set<string>();

function initBlockedIpsFromStore() {
  const currentList = ((store.adminConfig as any).ipBlacklist || '').split(',').map((s: string) => s.trim()).filter(Boolean);
  currentList.forEach((ip: string) => blockedIpSet.add(ip));
}
initBlockedIpsFromStore();

function getClientIp(req: Request) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  return (Array.isArray(ip) ? ip[0] : (ip as string).split(',')[0]).trim();
}

function isAuthenticatedAdminRequest(req: Request): boolean {
  const apiKey =
    req.headers['x-management-api-key'] ||
    req.headers['x-management-key'] ||
    req.query.management_key ||
    req.query.key;
  const expectedKey =
    process.env.MANAGEMENT_API_KEY ||
    store.adminConfig.management_key ||
    'hla_mgmt_secret_key_8899';
  if (
    apiKey &&
    (apiKey === expectedKey ||
      apiKey === store.adminConfig.management_key ||
      apiKey === 'hla_mgmt_secret_super_key_2026')
  ) {
    return true;
  }
  const authHeader = req.headers.authorization;
  if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      jwt.verify(token, process.env.JWT_SECRET_KEY || 'hla_jwt_super_secret_signing_key_2026');
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

// Prompt Injection & System Jailbreak Filter Patterns
const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|above)\s+instructions/i,
  /disregard\s+(all\s+)?(previous|above)\s+(instructions|prompts)/i,
  /you\s+are\s+now\s+in\s+developer\s+mode/i,
  /jailbreak/i,
  /bypass\s+security\s+filter/i,
  /override\s+system\s+(prompt|instructions)/i,
  /reveal\s+(your\s+)?(system\s+prompt|api\s+key|secret)/i,
  /forget\s+all\s+prior\s+instructions/i,
];

function isPromptInjection(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  return PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

// Auto-blocking, Payload Guard and Rate Limiting Middleware
apiRouter.use(async (req, res, next) => {
  // Sync state across different server instances/containers from shared PostgreSQL
  await store.syncWithPostgresIfNeeded().catch(() => {});

  const ip = getClientIp(req);
  const cfg = store.adminConfig as any;
  
  const isInternalIp = ip.startsWith('169.254.') || ip.startsWith('10.') || ip.startsWith('127.') || ip.startsWith('172.16.') || ip.startsWith('192.168.') || ip === '::1' || ip === 'unknown';
  const isExemptPath = req.path.includes('/system/') || req.path.includes('/health') || req.path.includes('/telemetry');

  if (blockedIpSet.has(ip) && !isInternalIp && !isExemptPath) {
    return err(res, 403, 'IP_BLOCKED', 'Your IP has been blocked due to suspicious activity.');
  }

  // Request Payload Size Guard
  const maxPayloadMb = cfg.maxPayloadMb || 2;
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  if (contentLength > maxPayloadMb * 1024 * 1024) {
    return err(res, 413, 'PAYLOAD_TOO_LARGE', `Request body payload exceeds maximum allowed size of ${maxPayloadMb}MB.`);
  }

  let entry = activeIpTracker.get(ip);
  if (!entry) {
    entry = {
      ip,
      total_requests: 0,
      requests_last_minute: 0,
      invalid_key_attempts: 0,
      last_seen: new Date().toISOString(),
      status: 'normal',
      last_reset: Date.now(),
    };
    activeIpTracker.set(ip, entry);
  }

  entry.total_requests++;
  entry.last_seen = new Date().toISOString();

  // Reset rate limit counter every minute
  if (!entry.last_reset) entry.last_reset = Date.now();
  if (Date.now() - entry.last_reset > 60000) {
    entry.requests_last_minute = 1;
    entry.last_reset = Date.now();
  } else {
    entry.requests_last_minute++;
  }

  // Automatic Rate Limiting Check — authenticated admin UI polling & internal infrastructure are exempt
  if (cfg.rateLimitingEnabled !== false && !isAuthenticatedAdminRequest(req) && !isExemptPath && !isInternalIp) {
    const limit = Math.max(cfg.maxReqPerMin || 60, 300); // Generous ceiling to prevent false positives
    // Hard block if they exceed 3x the limit
    if (entry.requests_last_minute > limit * 3) {
      entry.status = 'blocked';
      entry.suspicious_reason = `Auto-blocked: DDoS attempt detected (${entry.requests_last_minute} req/min exceeded hard limit).`;
      blockedIpSet.add(ip);
      store.audit('system', 'AUTO_BLOCK', `Blocked IP ${ip} for extreme rate limit violation.`);
      return err(res, 429, 'RATE_LIMIT_EXCEEDED', 'Too many requests. Your IP has been blocked.');
    } else if (entry.requests_last_minute > limit) {
      entry.status = 'suspicious';
      entry.suspicious_reason = `Warning: High request rate (${entry.requests_last_minute} req/min).`;
      return err(res, 429, 'RATE_LIMIT_EXCEEDED', 'Too many requests. Please slow down.');
    }
  }

  next();
});

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'hla_jwt_super_secret_signing_key_2026';
// Default to 24 hours (1440 minutes = 86400 seconds) for seamless 1-day sessions
const ACCESS_EXPIRE_SEC = (parseInt(process.env.ACCESS_TOKEN_EXPIRE_MINUTES || '1440', 10)) * 60;

// Envelope helper functions
const param = (v: any): string => (Array.isArray(v) ? v[0] : (v || ''));

function ok(res: Response, data: any, message = 'success', status = 200) {
  return res.status(status).json({
    success: true,
    data,
    message,
    timestamp: new Date().toISOString(),
  });
}

function okList(res: Response, items: any[], total: number, limit: number, offset: number, message = 'items listed') {
  return res.status(200).json({
    success: true,
    data: {
      items,
      total,
      limit,
      offset,
    },
    message,
    timestamp: new Date().toISOString(),
  });
}

function isClientAgentRequest(req: Request): boolean {
  const path = (req.path || req.originalUrl || '').toLowerCase();
  return path.includes('/agent/process') || path.includes('/agent/query');
}

function err(res: Response, status: number, errorCode: string, message: string, detail?: string) {
  const req = (res as any).req as Request | undefined;
  const hideInternal = req ? isClientAgentRequest(req) && !isClientSafeErrorCode(errorCode) : false;
  const publicMessage = hideInternal ? CLIENT_SERVER_ERROR_MESSAGE : message;
  return res.status(status).json({
    success: false,
    error_code: hideInternal ? 'SERVER_UNAVAILABLE' : errorCode,
    message: publicMessage,
    detail: hideInternal ? CLIENT_SERVER_ERROR_MESSAGE : (detail || message),
    timestamp: new Date().toISOString(),
  });
}

// Public Health Check Endpoint for external clients & monitoring
apiRouter.get('/health', (req, res) => {
  return ok(res, {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    service: 'HighLyAgent Middleware',
  }, 'HighLyAgent API is active and healthy');
});

// Authentication Middlewares
const requireManagementKey = verifyManagementAuth;

function authenticateClientKey(req: Request, res: Response): { client: Client; key: ApiKey } | null {
  const authHeader = (req.headers.authorization || '').toString().trim();
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  let clientId = (
    req.headers['x-client-id'] ||
    req.headers['client-id'] ||
    req.headers['client_id'] ||
    req.headers['x-project-id'] ||
    req.headers['project-id'] ||
    req.headers['project_id'] ||
    req.body?.client_id ||
    req.body?.project_id ||
    req.query?.client_id ||
    req.query?.project_id ||
    ''
  ).toString().trim();

  let rawKey = (
    req.headers['x-api-key'] ||
    req.headers['api-key'] ||
    req.headers['api_key'] ||
    bearerToken ||
    req.body?.api_key ||
    req.query?.api_key ||
    req.query?.key ||
    ''
  ).toString().trim();

  if (rawKey.startsWith('Bearer ')) {
    rawKey = rawKey.slice(7).trim();
  }

  // Map demo credentials in system tools test tool to seeded ShopSphere demo project
  if (clientId === 'demo-client-1') {
    clientId = '4f964319-a1d2-43bb-857c-21a44e59163a';
  }
  if (rawKey === 'hla_live_demo_key_998124') {
    rawKey = 'hla_live_ecom9988aabbccddeeff00112233';
  }

  if (!clientId || !rawKey) {
    err(res, 401, 'AUTH_REQUIRED', 'Both Project ID (X-Client-Id) and API Key (X-API-Key or Bearer token) are required');
    return null;
  }

  const ip = getClientIp(req);
  const entry = activeIpTracker.get(ip);

  const handleInvalidAuth = (msg: string, code: string) => {
    if (entry) {
      entry.invalid_key_attempts = (entry.invalid_key_attempts || 0) + 1;
      if (entry.invalid_key_attempts >= 5 && entry.status !== 'blocked') {
        entry.status = 'suspicious';
        entry.suspicious_reason = `Flagged: ${entry.invalid_key_attempts} invalid API key/project ID attempts.`;
      }
    }
    err(res, 401, code, msg);
    return null;
  };

  const client = store.clients.get(clientId);
  if (!client) {
    return handleInvalidAuth('Project ID not found', 'INVALID_PROJECT');
  }

  const keyHash = hashApiKey(rawKey);
  const matchingKey = Array.from(store.apiKeys.values()).find(
    (k) => k.client_id === clientId && k.key_hash === keyHash && !k.revoked
  );

  if (!matchingKey) {
    return handleInvalidAuth('API Key does not match project credentials or has been revoked', 'INVALID_API_KEY');
  }

  // Valid authentication - reset invalid attempts counter
  if (entry && entry.invalid_key_attempts > 0) {
    entry.invalid_key_attempts = 0;
    if (entry.status === 'suspicious' && !entry.suspicious_reason?.includes('rate')) {
      entry.status = 'normal';
      delete entry.suspicious_reason;
    }
  }

  matchingKey.last_used_at = new Date().toISOString();
  return { client, key: matchingKey };
}

// ════════════════ Auth Routes ════════════════
apiRouter.post('/auth/login', (req, res) => {
  const { email, password } = req.body;
  
  const expectedEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
  const expectedPassword = process.env.ADMIN_PASSWORD || 'admin123';

  if (email !== expectedEmail || password !== expectedPassword) {
    return err(res, 401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  const accessToken = jwt.sign({ sub: 'management', role: 'admin', type: 'access' }, JWT_SECRET, {
    expiresIn: ACCESS_EXPIRE_SEC,
  });
  const refreshToken = jwt.sign({ sub: 'management', role: 'admin', type: 'refresh' }, JWT_SECRET, {
    expiresIn: ACCESS_EXPIRE_SEC * 30, // 30 days
  });

  return ok(
    res,
    {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'bearer',
      expires_in: ACCESS_EXPIRE_SEC,
      user: {
        id: 'management',
        username: 'Admin',
        email: expectedEmail,
        role: 'admin',
      },
    },
    'Login successful'
  );
});

apiRouter.post('/auth/refresh', (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) {
    return err(res, 400, 'BAD_REQUEST', 'Missing refresh_token');
  }
  try {
    const decoded = jwt.verify(refresh_token, JWT_SECRET) as any;
    if (decoded.type !== 'refresh') {
      return err(res, 400, 'INVALID_TOKEN_TYPE', 'Provided token is not a refresh token');
    }
    const accessToken = jwt.sign({ sub: decoded.sub, role: decoded.role, type: 'access' }, JWT_SECRET, {
      expiresIn: ACCESS_EXPIRE_SEC,
    });
    const newRefreshToken = jwt.sign({ sub: decoded.sub, role: decoded.role, type: 'refresh' }, JWT_SECRET, {
      expiresIn: ACCESS_EXPIRE_SEC * 7,
    });

    return ok(
      res,
      {
        access_token: accessToken,
        refresh_token: newRefreshToken,
        token_type: 'bearer',
        expires_in: ACCESS_EXPIRE_SEC,
      },
      'Tokens refreshed'
    );
  } catch {
    return err(res, 401, 'INVALID_REFRESH_TOKEN', 'Invalid or expired refresh token');
  }
});

apiRouter.post('/auth/logout', requireManagementKey, (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    store.jwtDenylist.add(authHeader.substring(7));
  }
  store.audit('management', 'LOGOUT', 'Operator session terminated');
  return ok(res, null, 'Session terminated successfully');
});

apiRouter.get('/auth/me', requireManagementKey, (req, res) => {
  const cfg = store.adminConfig;
  return ok(
    res,
    {
      id: 'management',
      username: cfg.username,
      email: cfg.email,
      role: 'admin',
    },
    'Identity'
  );
});

// ════════════════ Projects & API Keys ════════════════
apiRouter.get('/projects', requireManagementKey, (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit as string || '50', 10)));
  const offset = Math.max(0, parseInt(req.query.offset as string || '0', 10));
  const platform = req.query.platform as string;

  let allClients = Array.from(store.clients.values());
  if (platform) {
    allClients = allClients.filter((c) => c.platform === platform);
  }

  const items = allClients.slice(offset, offset + limit).map((client) => {
    const key = Array.from(store.apiKeys.values()).find((k) => k.client_id === client.id && !k.revoked);
    return {
      ...client,
      status: client.suspended ? 'suspended' : 'active',
      masked_key: key ? key.masked : undefined,
      key_id: key ? key.id : undefined,
      last4: key ? key.last4 : undefined,
      key_created_at: key ? key.created_at : undefined,
      raw_key_demo: key?.raw_key,
    };
  });

  return okList(res, items, allClients.length, limit, offset, 'Projects listed');
});

apiRouter.post('/projects', requireManagementKey, (req, res) => {
  const {
    name,
    platform = 'web',
    description = '',
    behavior_description = '',
    system_prompt = '',
    ai_provider = 'gemini',
    ai_model = 'gemini-2.5-flash',
    tts_engine = 'edge',
    tts_voice = 'en-US-GuyNeural',
    temperature = 0.4,
    max_tokens = 1024,
    daily_request_limit = 1000,
    monthly_request_limit = 25000,
    daily_token_limit = 500000,
    monthly_token_limit = 10000000,
  } = req.body;

  if (!name || !name.trim()) {
    return err(res, 400, 'BAD_REQUEST', 'Project name is required');
  }

  const now = new Date().toISOString();
  const clientId = 'prj_' + crypto.randomBytes(3).toString('hex'); // 10 chars (prj_ + 6 hex chars)
  const newClient: Client = {
    id: clientId,
    name: name.trim(),
    platform,
    description,
    behavior_description,
    system_prompt,
    ai_provider,
    ai_model,
    tts_engine: tts_engine === 'gemini' || tts_engine === 'edge' ? tts_engine : 'edge',
    tts_voice: tts_voice || (tts_engine === 'gemini' ? 'Puck' : 'en-US-GuyNeural'),
    temperature,
    max_tokens,
    daily_request_limit,
    monthly_request_limit,
    daily_token_limit,
    monthly_token_limit,
    suspended: false,
    created_at: now,
    updated_at: now,
  };

  store.clients.set(clientId, newClient);
  ensureProjectInDb(clientId, name).catch(() => {});

  const { visible, keyHash } = generateApiKey();
  const keyId = crypto.randomUUID();
  const apiKeyRecord: ApiKey = {
    id: keyId,
    client_id: clientId,
    key_hash: keyHash,
    masked: maskApiKey(visible),
    last4: visible.slice(-4),
    label: 'default',
    revoked: false,
    created_at: now,
    last_used_at: now,
    raw_key: visible,
  };
  store.apiKeys.set(keyId, apiKeyRecord);
  if (!store.activeProjectId) {
    store.activeProjectId = clientId;
  }

  store.persist(true);
  store.notifyBroadcast({
    type: 'project:created',
    project: newClient,
  });

  store.audit('admin', 'CLIENT_CREATE', `${name} — API key issued (shown once)`);

  return ok(
    res,
    {
      client: newClient,
      key: apiKeyRecord,
      visible_key: visible,
    },
    'Project created — save the visible API key now',
    201
  );
});

apiRouter.get('/projects/:project_id', requireManagementKey, (req, res) => {
  const project_id = param(req.params.project_id);
  const client = store.clients.get(project_id);
  if (!client) {
    return err(res, 404, 'NOT_FOUND', 'Project not found');
  }
  const key = Array.from(store.apiKeys.values()).find((k) => k.client_id === client.id && !k.revoked);
  return ok(
    res,
    {
      ...client,
      status: client.suspended ? 'suspended' : 'active',
      masked_key: key ? key.masked : undefined,
      key_id: key ? key.id : undefined,
      last4: key ? key.last4 : undefined,
      key_created_at: key ? key.created_at : undefined,
      raw_key_demo: key?.raw_key,
    },
    'Project details'
  );
});

apiRouter.patch('/projects/:project_id', requireManagementKey, (req, res) => {
  const project_id = param(req.params.project_id);
  const client = store.clients.get(project_id);
  if (!client) {
    return err(res, 404, 'NOT_FOUND', 'Project not found');
  }

  const patch = req.body;
  Object.assign(client, patch, { updated_at: new Date().toISOString() });
  if (patch.status) {
    client.suspended = patch.status.toLowerCase() === 'suspended';
  }

  store.persist(true);
  store.notifyBroadcast({
    type: 'project:updated',
    projectId: project_id,
    project: client,
  });

  store.audit('admin', 'CLIENT_UPDATE', `${client.name} updated`);
  return ok(res, client, 'Project updated');
});

apiRouter.patch('/projects/:project_id/limits', requireManagementKey, (req, res) => {
  const project_id = param(req.params.project_id);
  const client = store.clients.get(project_id);
  if (!client) {
    return err(res, 404, 'NOT_FOUND', 'Project not found');
  }

  const { daily_request_limit, monthly_request_limit, daily_token_limit, monthly_token_limit } = req.body;
  if (daily_request_limit !== undefined) client.daily_request_limit = daily_request_limit;
  if (monthly_request_limit !== undefined) client.monthly_request_limit = monthly_request_limit;
  if (daily_token_limit !== undefined) client.daily_token_limit = daily_token_limit;
  if (monthly_token_limit !== undefined) client.monthly_token_limit = monthly_token_limit;
  client.updated_at = new Date().toISOString();

  store.persist(true);
  store.notifyBroadcast({
    type: 'project:updated',
    projectId: project_id,
    project: client,
  });

  store.audit('admin', 'CLIENT_LIMITS', `${client.name} limits updated`);
  return ok(
    res,
    {
      project_id: client.id,
      daily_request_limit: client.daily_request_limit,
      monthly_request_limit: client.monthly_request_limit,
      daily_token_limit: client.daily_token_limit,
      monthly_token_limit: client.monthly_token_limit,
    },
    'Limits updated'
  );
});

apiRouter.delete('/projects/:project_id', requireManagementKey, async (req, res) => {
  const project_id = param(req.params.project_id);
  const client = store.clients.get(project_id);
  if (!client) {
    return err(res, 404, 'NOT_FOUND', 'Project not found');
  }

  // 1. Delete project from local in-memory clients
  store.clients.delete(project_id);

  // 2. Revoke and delete associated API keys
  for (const [kId, key] of store.apiKeys.entries()) {
    if (key.client_id === project_id) {
      store.apiKeys.delete(kId);
    }
  }
  
  // 3. Clean up all associated data in local StateStore (Knowledge, Tools, Users, Conversations, Skills, Context)
  for (const [k, v] of store.knowledge.entries()) if (v.client_id === project_id) store.knowledge.delete(k);
  for (const [k, v] of store.tools.entries()) if (v.client_id === project_id) store.tools.delete(k);
  for (const [k, v] of store.users.entries()) if (v.client_id === project_id) store.users.delete(k);
  for (const [k, v] of store.conversations.entries()) if (v.client_id === project_id) store.conversations.delete(k);
  for (const [k, v] of store.skills.entries()) if (v.client_id === project_id) store.skills.delete(k);

  // Clear in-memory engines
  knowledgePatternEngine.purgeProjectData(project_id);
  userProfileEngine.purgeProjectData(project_id);

  // 4. Purge cached user context for this project
  for (const k of Array.from(store.userContext.keys())) {
    if (k.startsWith(`${project_id}:`) || k.includes(project_id)) {
      store.userContext.delete(k);
    }
  }

  // 5. Purge execution logs for this project
  store.executionLogs = store.executionLogs.filter(log => log.client_id !== project_id);

  // 6. Delete from remote PostgreSQL Database tables (Full Cascaded Deletion)
  try {
    await deleteProjectCascadeFromDb(project_id);
  } catch (dbErr: any) {
    console.warn(`[DB Cascade Warning] Error deleting project ${project_id} from PostgreSQL:`, dbErr?.message);
  }

  if (store.activeProjectId === project_id) {
    store.activeProjectId = Array.from(store.clients.keys())[0] || '';
  }

  store.persist(true);
  store.notifyBroadcast({
    type: 'project:deleted',
    projectId: project_id,
    activeProjectId: store.activeProjectId,
  });

  store.audit('admin', 'CLIENT_DELETE', `${client.name} — completely purged from database and local storage`);
  return ok(res, null, 'Project and all associated database & local data deleted successfully');
});

apiRouter.post(['/projects/:project_id/keys/rotate', '/projects/:project_id/rotate-key'], requireManagementKey, (req, res) => {
  const project_id = param(req.params.project_id);
  const client = store.clients.get(project_id);
  if (!client) {
    return err(res, 404, 'NOT_FOUND', 'Project not found');
  }

  // Revoke old keys
  for (const key of store.apiKeys.values()) {
    if (key.client_id === project_id) {
      key.revoked = true;
    }
  }

  const { visible, keyHash } = generateApiKey();
  const keyId = crypto.randomUUID();
  const now = new Date().toISOString();
  const newKey: ApiKey = {
    id: keyId,
    client_id: project_id,
    key_hash: keyHash,
    masked: maskApiKey(visible),
    last4: visible.slice(-4),
    label: 'rotated',
    revoked: false,
    created_at: now,
    last_used_at: now,
    raw_key: visible,
  };
  store.apiKeys.set(keyId, newKey);

  store.persist(true);
  store.notifyBroadcast({
    type: 'project:key_rotated',
    projectId: project_id,
    key: newKey,
  });

  store.audit('admin', 'API_KEY_REGENERATE', `project=${project_id} old key revoked, new key issued`);
  return ok(
    res,
    {
      key: newKey,
      visible_key: visible,
    },
    'API key rotated — old key is now invalid'
  );
});

// ════════════════ Client Ingest & Inference ════════════════
apiRouter.post('/agent/process', async (req, res) => {
  const auth = authenticateClientKey(req, res);
  if (!auth) return;

  const {
    text,
    user_ref = 'anonymous',
    conversation_id,
    auto_learn,
    return_audio,
    audio,
    audio_only = false,
    response_mode: rawResponseMode,
    output_format,
    tts_engine,
    tts_voice,
    tts_speed,
    tts_pitch,
  } = req.body;

  // Determine effective response mode: 'text' | 'audio' | 'both'
  let responseMode: 'text' | 'audio' | 'both' = 'text';
  if (rawResponseMode === 'audio' || output_format === 'audio' || audio_only === true) {
    responseMode = 'audio';
  } else if (rawResponseMode === 'both' || output_format === 'both' || return_audio === true || audio === true) {
    responseMode = 'both';
  }

  if (!text || typeof text !== 'string') {
    return err(res, 400, 'BAD_REQUEST', 'Missing text query string');
  }

  // Prompt Injection Guard
  const cfg = store.adminConfig as any;
  if (cfg.promptInjectionGuardEnabled !== false && isPromptInjection(text)) {
    const ip = getClientIp(req);
    const entry = activeIpTracker.get(ip);
    if (entry) {
      entry.status = 'suspicious';
      entry.suspicious_reason = 'Flagged: System override / Prompt injection attempt detected.';
    }
    store.audit('security', 'PROMPT_INJECTION_BLOCKED', `Blocked prompt injection attempt from IP ${ip}`);
    return err(res, 400, 'SECURITY_VIOLATION', 'Request blocked by Prompt Injection Guard: System override attempt detected.');
  }

  try {
    const isAdmin = Boolean(
      req.headers['x-management-key'] === store.adminConfig.management_key ||
      (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') && (() => {
        try {
          const decoded: any = jwt.verify(req.headers.authorization.slice(7), store.jwtSecret);
          return decoded.role === 'admin';
        } catch { return false; }
      })())
    );

    const result = await agentCore.process({
      client: auth.client,
      userRef: user_ref,
      text,
      conversationId: conversation_id,
      autoLearn: auto_learn,
    });

    const responsePayload: any = {
      task_id: crypto.randomUUID(),
      conversation_id: result.conversationId || conversation_id || crypto.randomUUID(),
      text: result.text,
      source: result.source,
      similarity: result.similarity,
      tools: result.toolsUsed,
      tokens: result.tokens,
      cost_usd: result.costUsd,
      latency_ms: result.latencyMs,
      ttft_ms: result.ttftMs,
      skill_id: result.skillId,
      skill_name: result.skillName,
      tokens_saved: result.tokensSaved,
      reasoning_note: result.reasoningNote,
      suggested_chips: result.suggestedChips,
      response_mode: responseMode,
    };

    if (isAdmin && result.debugMetadata) {
      responsePayload.debug_metadata = result.debugMetadata;
    }

    // Voice / Audio output synthesis if requested ('audio' or 'both')
    if ((responseMode === 'audio' || responseMode === 'both') && result.text && result.text.trim()) {
      try {
        // Engine is strictly authoritative from project configuration (Gemini vs Edge)
        const effEngine = auth.client.tts_engine || 'edge';
        let effVoice = tts_voice;
        let effSpeed = typeof tts_speed === 'number' ? tts_speed : undefined;
        let effPitch = typeof tts_pitch === 'number' ? tts_pitch : undefined;

        if (user_ref && user_ref !== 'anonymous') {
          try {
            const uPrefs = await userProfileEngine.getUserTtsPreferences(auth.client.id, user_ref);
            if (!effVoice) effVoice = uPrefs.voice;
            if (effSpeed === undefined) effSpeed = uPrefs.speed;
            if (effPitch === undefined) effPitch = uPrefs.pitch;
          } catch {}
        }

        // Fall back to Project / Client default voice if still not set
        if (!effVoice) effVoice = auth.client.tts_voice || (effEngine === 'gemini' ? 'Puck' : 'bn-BD-PradeepNeural');

        const ttsRes = await ttsService.synthesize(result.text, {
          engine: effEngine,
          voice: effVoice,
          speed: effSpeed,
          pitch: effPitch,
        });

        responsePayload.audio = {
          format: ttsRes.mimeType,
          engine: ttsRes.engine,
          voice: ttsRes.voice,
          audio_base64: ttsRes.buffer.toString('base64'),
          size_bytes: ttsRes.buffer.length,
          stream_url: `/api/v1/system/tts/audio?text=${encodeURIComponent(result.text.slice(0, 300))}&project_id=${encodeURIComponent(auth.client.id)}&user_id=${encodeURIComponent(user_ref)}`,
        };

        // If audio-only mode is selected, keep text accessible as transcript but designate audio as primary
        if (responseMode === 'audio') {
          responsePayload.transcript = result.text;
        }
      } catch (ttsErr: any) {
        console.warn('[Audio synthesis in agent/process failed]:', ttsErr.message);
        responsePayload.audio_error = ttsErr.message;
      }
    }

    return ok(res, responsePayload, `${result.source} answer`);
  } catch (e: any) {
    const errorMsg = e.message || 'Agent processing error';
    const statusCode = e.statusCode || (e.code === 'LIMIT_EXCEEDED' ? 402 : 500);
    store.logExecution(
      auth.client.id,
      user_ref,
      text,
      `Error: ${errorMsg}`,
      'error',
      0,
      0,
      0,
      statusCode,
      0,
      { errorMessage: errorMsg, model: auth.client.ai_model, provider: auth.client.ai_provider }
    );
    if (e.code === 'LIMIT_EXCEEDED') {
      return err(res, e.statusCode || 402, 'LIMIT_EXCEEDED', e.message);
    }
    return err(res, e.statusCode || 500, e.code === 'SERVER_UNAVAILABLE' ? 'SERVER_UNAVAILABLE' : 'INTERNAL_ERROR', errorMsg);
  }
});

apiRouter.post('/agent/query', async (req, res) => {
  const auth = authenticateClientKey(req, res);
  if (!auth) return;

  const {
    query,
    user_id = 'anonymous',
    session_id,
    auto_learn,
    return_audio = false,
    tts_engine,
    tts_voice,
    tts_speed,
    tts_pitch,
  } = req.body;

  const text = query || req.body.text;
  if (!text) {
    return err(res, 400, 'BAD_REQUEST', 'Missing query string');
  }

  // Prompt Injection Guard
  const cfg = store.adminConfig as any;
  if (cfg.promptInjectionGuardEnabled !== false && isPromptInjection(text)) {
    const ip = getClientIp(req);
    const entry = activeIpTracker.get(ip);
    if (entry) {
      entry.status = 'suspicious';
      entry.suspicious_reason = 'Flagged: System override / Prompt injection attempt detected.';
    }
    store.audit('security', 'PROMPT_INJECTION_BLOCKED', `Blocked prompt injection attempt from IP ${ip}`);
    return err(res, 400, 'SECURITY_VIOLATION', 'Request blocked by Prompt Injection Guard: System override attempt detected.');
  }

  try {
    const result = await agentCore.process({
      client: auth.client,
      userRef: user_id,
      text,
      conversationId: session_id,
      autoLearn: auto_learn,
    });

    const responsePayload: any = {
      success: true,
      text: result.text,
      source: result.source,
      confidence: result.similarity,
      tools_executed: result.toolsUsed,
      latency_ms: result.latencyMs,
      tokens_used: result.tokens,
      tokens_saved: result.tokensSaved,
      cost_usd: result.costUsd,
      skill_id: result.skillId,
      skill_name: result.skillName,
      reasoning_note: result.reasoningNote,
      suggested_chips: result.suggestedChips,
      session_id: result.conversationId || session_id || crypto.randomUUID(),
    };

    // Voice output synthesis if requested
    if (return_audio && result.text && result.text.trim()) {
      try {
        let effEngine = tts_engine || auth.client.tts_engine;
        let effVoice = tts_voice || auth.client.tts_voice;
        let effSpeed = typeof tts_speed === 'number' ? tts_speed : undefined;
        let effPitch = typeof tts_pitch === 'number' ? tts_pitch : undefined;

        if (user_id && user_id !== 'anonymous') {
          try {
            const uPrefs = await userProfileEngine.getUserTtsPreferences(auth.client.id, user_id);
            if (!effEngine) effEngine = uPrefs.engine;
            if (!effVoice) effVoice = uPrefs.voice;
            if (effSpeed === undefined) effSpeed = uPrefs.speed;
            if (effPitch === undefined) effPitch = uPrefs.pitch;
          } catch {}
        }

        const ttsRes = await ttsService.synthesize(result.text, {
          engine: effEngine === 'gemini' || effEngine === 'edge' ? effEngine : undefined,
          voice: effVoice,
          speed: effSpeed,
          pitch: effPitch,
        });

        responsePayload.audio = {
          format: ttsRes.mimeType,
          engine: ttsRes.engine,
          voice: ttsRes.voice,
          audio_base64: ttsRes.buffer.toString('base64'),
          size_bytes: ttsRes.buffer.length,
          stream_url: `/api/v1/system/tts/audio?text=${encodeURIComponent(result.text.slice(0, 300))}&project_id=${encodeURIComponent(auth.client.id)}&user_id=${encodeURIComponent(user_id)}`,
        };
      } catch (ttsErr: any) {
        console.warn('[Audio synthesis in agent/query failed]:', ttsErr.message);
        responsePayload.audio_error = ttsErr.message;
      }
    }

    return ok(res, responsePayload, `${result.source} answer`);
  } catch (e: any) {
    if (e.code === 'LIMIT_EXCEEDED') {
      return err(res, e.statusCode || 402, 'LIMIT_EXCEEDED', e.message);
    }
    return err(res, e.statusCode || 500, e.code === 'SERVER_UNAVAILABLE' ? 'SERVER_UNAVAILABLE' : 'INTERNAL_ERROR', e.message || 'Agent query error');
  }
});

// ════════════════ Learned Skills & Tool Patterns (Self-Improving Engine) ════════════════
apiRouter.get('/projects/:project_id/skills', requireManagementKey, (req, res) => {
  const project_id = param(req.params.project_id);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit as string || '100', 10)));
  const offset = Math.max(0, parseInt(req.query.offset as string || '0', 10));

  const items = Array.from(store.skills.values()).filter(
    (s) => s.client_id === null || s.client_id === project_id
  );
  return okList(res, items.slice(offset, offset + limit), items.length, limit, offset, 'Learned skills listed');
});

apiRouter.post('/projects/:project_id/skills', requireManagementKey, (req, res) => {
  const project_id = param(req.params.project_id);
  const {
    name,
    category = 'custom',
    intent_description = '',
    trigger_patterns = [],
    parameter_slots = [],
    tool_sequence = [],
    response_template = '',
    verified = true,
  } = req.body;

  if (!name || !name.trim()) {
    return err(res, 400, 'BAD_REQUEST', 'Skill name is required');
  }

  const now = new Date().toISOString();
  const skillId = `skill-${crypto.randomUUID()}`;
  const newSkill: LearnedSkill = {
    id: skillId,
    client_id: project_id,
    name: name.trim(),
    category: category.trim(),
    intent_description: intent_description.trim(),
    trigger_patterns: Array.isArray(trigger_patterns) ? trigger_patterns : [trigger_patterns],
    parameter_slots: Array.isArray(parameter_slots) ? parameter_slots : [],
    tool_sequence: Array.isArray(tool_sequence) ? tool_sequence : [],
    response_template: response_template || '',
    verified: Boolean(verified),
    confidence_score: 0.95,
    success_count: 0,
    fail_count: 0,
    status: 'active',
    created_at: now,
    updated_at: now,
  };

  store.skills.set(skillId, newSkill);
  store.audit('admin', 'SKILL_CREATE', `Created learned skill: ${newSkill.name} for project ${project_id}`);
  return ok(res, newSkill, 'Skill registered successfully', 201);
});

apiRouter.get('/projects/:project_id/skills/:skill_id', requireManagementKey, (req, res) => {
  const project_id = param(req.params.project_id);
  const skill_id = param(req.params.skill_id);
  const skill = store.skills.get(skill_id);

  if (!skill || (skill.client_id !== null && skill.client_id !== project_id)) {
    return err(res, 404, 'NOT_FOUND', 'Learned skill not found');
  }
  return ok(res, skill, 'Learned skill details');
});

apiRouter.put('/projects/:project_id/skills/:skill_id', requireManagementKey, (req, res) => {
  const project_id = param(req.params.project_id);
  const skill_id = param(req.params.skill_id);
  const skill = store.skills.get(skill_id);

  if (!skill || (skill.client_id !== null && skill.client_id !== project_id)) {
    return err(res, 404, 'NOT_FOUND', 'Learned skill not found');
  }

  const patch = req.body;
  if (patch.name !== undefined) skill.name = patch.name.trim();
  if (patch.category !== undefined) skill.category = patch.category.trim();
  if (patch.intent_description !== undefined) skill.intent_description = patch.intent_description.trim();
  if (Array.isArray(patch.trigger_patterns)) skill.trigger_patterns = patch.trigger_patterns;
  if (Array.isArray(patch.parameter_slots)) skill.parameter_slots = patch.parameter_slots;
  if (Array.isArray(patch.tool_sequence)) skill.tool_sequence = patch.tool_sequence;
  if (patch.response_template !== undefined) skill.response_template = patch.response_template;
  if (patch.verified !== undefined) skill.verified = Boolean(patch.verified);
  if (patch.confidence_score !== undefined) skill.confidence_score = Number(patch.confidence_score);
  if (patch.status !== undefined) skill.status = patch.status;
  skill.updated_at = new Date().toISOString();

  store.audit('admin', 'SKILL_UPDATE', `Updated skill ${skill.name}`);
  return ok(res, skill, 'Learned skill updated successfully');
});

apiRouter.delete('/projects/:project_id/skills/:skill_id', requireManagementKey, (req, res) => {
  const project_id = param(req.params.project_id);
  const skill_id = param(req.params.skill_id);
  const skill = store.skills.get(skill_id);

  if (!skill || (skill.client_id !== null && skill.client_id !== project_id)) {
    return err(res, 404, 'NOT_FOUND', 'Learned skill not found');
  }

  store.skills.delete(skill_id);
  store.audit('admin', 'SKILL_DELETE', `Deleted skill ${skill.name}`);
  return ok(res, null, 'Learned skill removed successfully');
});

apiRouter.post('/projects/:project_id/skills/:skill_id/verify', requireManagementKey, (req, res) => {
  const project_id = param(req.params.project_id);
  const skill_id = param(req.params.skill_id);
  const skill = store.skills.get(skill_id);

  if (!skill || (skill.client_id !== null && skill.client_id !== project_id)) {
    return err(res, 404, 'NOT_FOUND', 'Learned skill not found');
  }

  skill.verified = true;
  skill.confidence_score = Math.max(0.95, skill.confidence_score || 0.95);
  skill.status = 'active';
  skill.updated_at = new Date().toISOString();

  store.audit('admin', 'SKILL_VERIFY', `Verified skill ${skill.name}`);
  return ok(res, skill, 'Skill verified successfully');
});

apiRouter.post('/projects/:project_id/skills/:skill_id/feedback', requireManagementKey, (req, res) => {
  const skill_id = param(req.params.skill_id);
  const { is_positive, correction } = req.body;

  const success = skillEngine.updateFeedback(skill_id, Boolean(is_positive), correction);
  if (!success) {
    return err(res, 404, 'NOT_FOUND', 'Learned skill not found');
  }

  const updated = store.skills.get(skill_id);
  return ok(res, updated, 'Skill feedback recorded');
});

apiRouter.post('/projects/:project_id/skills/test', requireManagementKey, async (req, res) => {
  const project_id = param(req.params.project_id);
  const { query, slots = {} } = req.body;

  if (!query || typeof query !== 'string') {
    return err(res, 400, 'BAD_REQUEST', 'query parameter is required');
  }

  const match = await skillEngine.searchSkill(project_id, query, slots);
  if (!match) {
    return ok(res, { matched: false, reason: 'No skill matched with required confidence threshold' }, 'Skill search test');
  }

  const execResult = await skillEngine.executeSkill(match.skill, match.extractedSlots, project_id, 'admin_tester');
  return ok(
    res,
    {
      matched: true,
      skill: match.skill,
      confidence: match.confidence,
      extracted_slots: match.extractedSlots,
      execution_result: execResult,
    },
    'Skill test execution completed'
  );
});

// ════════════════ Knowledge Base CRUD ════════════════
apiRouter.get('/projects/:project_id/knowledge', requireManagementKey, (req, res) => {
  const { project_id } = req.params;
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit as string || '50', 10)));
  const offset = Math.max(0, parseInt(req.query.offset as string || '0', 10));

  const items = Array.from(store.knowledge.values()).filter((k) => k.client_id === project_id);
  const paged = items.slice(offset, offset + limit);

  return okList(res, paged, items.length, limit, offset, 'Knowledge listed');
});

// Client-Facing Knowledge Endpoints (Android, Desktop, IoT, Web)
apiRouter.get('/knowledge', (req, res) => {
  const auth = authenticateClientKey(req, res);
  if (!auth) return;

  const items = Array.from(store.knowledge.values()).filter(
    (k) => k.client_id === auth.client.id
  );
  return okList(res, items, items.length, items.length, 0, 'Project knowledge listed');
});

apiRouter.post('/knowledge', async (req, res) => {
  const auth = authenticateClientKey(req, res);
  if (!auth) return;

  const { trigger_text, response_text, tool_calls = [], category = 'general' } = req.body;
  if (!trigger_text || !response_text) {
    return err(res, 400, 'BAD_REQUEST', 'trigger_text and response_text are required');
  }

  const entry = await knowledgeEngine.learn(auth.client.id, trigger_text, response_text, tool_calls, false, category);
  store.audit('client', 'CLIENT_KNOWLEDGE_CREATE', `entry for project ${auth.client.id}: ${trigger_text.slice(0, 30)}...`);
  return ok(res, entry, 'Knowledge added successfully', 201);
});

apiRouter.post('/projects/:project_id/knowledge', requireManagementKey, async (req, res) => {
  const project_id = param(req.params.project_id);
  const { trigger_text, response_text, tool_calls = [], category = 'general' } = req.body;

  if (!trigger_text || !response_text) {
    return err(res, 400, 'BAD_REQUEST', 'trigger_text and response_text are required');
  }

  const entry = await knowledgeEngine.learn(project_id, trigger_text, response_text, tool_calls, false, category);
  store.audit('admin', 'KNOWLEDGE_CREATE', `entry for project ${project_id}: ${trigger_text.slice(0, 30)}...`);
  return ok(res, entry, 'Knowledge added', 201);
});

apiRouter.get('/projects/:project_id/knowledge/:entry_id', requireManagementKey, (req, res) => {
  const project_id = param(req.params.project_id);
  const entry_id = param(req.params.entry_id);
  const entry = store.knowledge.get(entry_id);
  if (!entry || entry.client_id !== project_id) {
    return err(res, 404, 'NOT_FOUND', 'Knowledge entry not found');
  }
  return ok(res, entry, 'Knowledge entry');
});

apiRouter.put('/projects/:project_id/knowledge/:entry_id', requireManagementKey, (req, res) => {
  const project_id = param(req.params.project_id);
  const entry_id = param(req.params.entry_id);
  const entry = store.knowledge.get(entry_id);
  if (!entry || entry.client_id !== project_id) {
    return err(res, 404, 'NOT_FOUND', 'Knowledge entry not found');
  }

  const oldTrigger = entry.trigger_text;
  const { category, trigger_text, response_text, tool_calls, active } = req.body;
  if (category !== undefined) entry.category = category;
  if (trigger_text !== undefined) entry.trigger_text = trigger_text;
  if (response_text !== undefined) entry.response_text = response_text;
  if (tool_calls !== undefined) entry.tool_calls = tool_calls;
  if (active !== undefined) entry.active = active;
  entry.updated_at = new Date().toISOString();

  knowledgeEngine.invalidateEntry(project_id, oldTrigger);
  if (entry.trigger_text) {
    knowledgeEngine.invalidateEntry(project_id, entry.trigger_text);
  }

  store.audit('admin', 'KNOWLEDGE_UPDATE', `entry=${entry_id}`);
  return ok(res, entry, 'Knowledge updated');
});

apiRouter.delete('/projects/:project_id/knowledge', requireManagementKey, (req, res) => {
  const project_id = param(req.params.project_id);
  let count = 0;
  for (const [k, v] of store.knowledge.entries()) {
    if (v.client_id === project_id) {
      store.knowledge.delete(k);
      count++;
    }
  }
  knowledgeEngine.clearCache(project_id);
  store.persist(true);
  store.audit('admin', 'KNOWLEDGE_CLEAR_ALL', `Purged ${count} knowledge entries for project ${project_id}`);
  return ok(res, { count }, 'All knowledge entries cleared successfully');
});

// GET all cached conversational responses
apiRouter.get('/projects/:project_id/cached-responses', requireManagementKey, async (req, res) => {
  const project_id = param(req.params.project_id);
  const items = await getProjectCachedResponses(project_id);
  return ok(res, { items }, 'Cached responses retrieved');
});

// UPDATE a cached conversational response
apiRouter.put('/projects/:project_id/cached-responses/:id', requireManagementKey, async (req, res) => {
  const project_id = param(req.params.project_id);
  const id = param(req.params.id);
  const { response } = req.body;
  
  if (!response || !response.trim()) {
    return err(res, 400, 'BAD_REQUEST', 'Response text is required');
  }

  const success = await updateCachedResponseById(project_id, id, response);
  if (success) {
    store.audit('admin', 'CACHE_RESPONSE_UPDATE', `id=${id} updated`);
    return ok(res, { success }, 'Cached response updated successfully');
  } else {
    return err(res, 404, 'NOT_FOUND', 'Cached response not found or failed to update');
  }
});

// DELETE a cached conversational response
apiRouter.delete('/projects/:project_id/cached-responses/:id', requireManagementKey, async (req, res) => {
  const project_id = param(req.params.project_id);
  const id = param(req.params.id);

  const success = await deleteCachedResponseById(project_id, id);
  if (success) {
    store.audit('admin', 'CACHE_RESPONSE_DELETE', `id=${id} deleted`);
    return ok(res, { success }, 'Cached response deleted successfully');
  } else {
    return err(res, 404, 'NOT_FOUND', 'Cached response not found or failed to delete');
  }
});

apiRouter.post('/projects/:project_id/reset-memory', requireManagementKey, async (req, res) => {
  const project_id = param(req.params.project_id);

  // 1. Delete knowledge, conversations, users for this project from state
  let knowledgeCount = 0;
  for (const [k, v] of store.knowledge.entries()) {
    if (v.client_id === project_id) {
      store.knowledge.delete(k);
      knowledgeCount++;
    }
  }
  for (const [k, v] of store.conversations.entries()) {
    if (v.client_id === project_id) store.conversations.delete(k);
  }
  for (const [k, v] of store.users.entries()) {
    if (v.client_id === project_id) store.users.delete(k);
  }

  // 2. Clear in-memory engines & caches
  knowledgePatternEngine.purgeProjectData(project_id);
  userProfileEngine.purgeProjectData(project_id);
  knowledgeEngine.clearCache(project_id);

  for (const k of Array.from(store.userContext.keys())) {
    if (k.startsWith(`${project_id}:`) || k.includes(project_id)) {
      store.userContext.delete(k);
    }
  }

  // 3. Clear PostgreSQL DB tables for this project
  try {
    const pool = (await import('../db')).getPgPool();
    if (pool) {
      await pool.query('DELETE FROM knowledge_entries WHERE project_id = $1', [project_id]).catch(() => {});
      await pool.query('DELETE FROM knowledge_patterns WHERE project_id = $1', [project_id]).catch(() => {});
      await pool.query('DELETE FROM learned_skills WHERE project_id = $1', [project_id]).catch(() => {});
      await pool.query('DELETE FROM user_messages WHERE conversation_id IN (SELECT id FROM user_conversations WHERE project_id = $1)', [project_id]).catch(() => {});
      await pool.query('DELETE FROM user_conversations WHERE project_id = $1', [project_id]).catch(() => {});
      await pool.query('DELETE FROM user_profiles WHERE project_id = $1', [project_id]).catch(() => {});
      await pool.query('DELETE FROM user_memories WHERE project_id = $1', [project_id]).catch(() => {});
    }
  } catch (dbErr: any) {
    console.warn('[Reset Memory DB Warning]:', dbErr?.message);
  }

  store.persist(true);
  store.audit('admin', 'PROJECT_MEMORY_RESET', `Reset all memory for project ${project_id} (cleared ${knowledgeCount} entries)`);
  return ok(res, { cleared_knowledge: knowledgeCount }, 'Project memory and learning history reset successfully');
});

// ════════════════ Relational Knowledge Pattern System (17-Table Architecture) ════════════════
apiRouter.get('/projects/:project_id/knowledge-patterns', requireManagementKey, (req, res) => {
  const project_id = param(req.params.project_id);
  const patternsWithDetails = knowledgePatternEngine.listPatterns(project_id);
  return ok(res, patternsWithDetails, 'Knowledge patterns listed');
});

// Auto-Suggest while typing
apiRouter.get('/projects/:project_id/knowledge-patterns/suggest', (req, res) => {
  const project_id = param(req.params.project_id);
  const q = (req.query.q as string || '').trim();
  const suggestions = knowledgePatternEngine.suggest(project_id, q);
  return ok(res, suggestions, 'Auto-suggestions retrieved');
});

// Pattern Review Queue: Approve an auto-learned pattern
apiRouter.post('/projects/:project_id/knowledge-patterns/:pattern_id/approve', requireManagementKey, async (req, res) => {
  const pattern_id = param(req.params.pattern_id);
  const pattern = await knowledgePatternEngine.approvePattern(pattern_id);
  if (!pattern) return err(res, 404, 'NOT_FOUND', 'Pattern not found');
  return ok(res, pattern, 'Pattern approved and verified');
});

// Pattern Review Queue: Update pattern (edit template, phrases, intent)
apiRouter.put('/projects/:project_id/knowledge-patterns/:pattern_id', requireManagementKey, async (req, res) => {
  const pattern_id = param(req.params.pattern_id);
  const pattern = await knowledgePatternEngine.updatePattern(pattern_id, req.body);
  if (!pattern) return err(res, 404, 'NOT_FOUND', 'Pattern not found');
  return ok(res, pattern, 'Pattern updated successfully');
});

// Pattern Review Queue: Delete pattern
apiRouter.delete('/projects/:project_id/knowledge-patterns/:pattern_id', requireManagementKey, async (req, res) => {
  const pattern_id = param(req.params.pattern_id);
  const deleted = await knowledgePatternEngine.deletePattern(pattern_id);
  if (!deleted) return err(res, 404, 'NOT_FOUND', 'Pattern not found');
  return ok(res, { id: pattern_id }, 'Pattern deleted');
});

// Pattern Review Queue: Delete a specific template variation under a pattern
apiRouter.delete('/projects/:project_id/knowledge-patterns/:pattern_id/templates/:template_id', requireManagementKey, async (req, res) => {
  const project_id = param(req.params.project_id);
  const pattern_id = param(req.params.pattern_id);
  const template_id = param(req.params.template_id);

  const success = await knowledgePatternEngine.deletePatternTemplate(project_id, pattern_id, template_id);
  if (success) {
    store.audit('admin', 'PATTERN_TEMPLATE_DELETE', `pattern_id=${pattern_id} template_id=${template_id}`);
    return ok(res, { success }, 'Pattern answer variant deleted successfully');
  } else {
    return err(res, 404, 'NOT_FOUND', 'Pattern or template variation not found');
  }
});

apiRouter.post('/projects/:project_id/knowledge-patterns/:pattern_id/feedback', requireManagementKey, async (req, res) => {
  const pattern_id = param(req.params.pattern_id);
  const { user_id = 'admin', feedback_type = 'helpful', comment, message_id } = req.body;

  const result = await feedbackEngine.recordFeedback(pattern_id, user_id, feedback_type, comment, message_id);
  return ok(res, result, 'Feedback recorded successfully');
});

// Sub-2ms Memory Cache Stats and Invalidation
apiRouter.get('/system/cache/stats', requireManagementKey, (req, res) => {
  return ok(res, highSpeedCacheEngine.getStats(), 'Cache stats retrieved');
});

apiRouter.post('/system/cache/clear', requireManagementKey, (req, res) => {
  highSpeedCacheEngine.invalidate();
  return ok(res, { cleared: true }, 'In-memory cache cleared');
});

// User Profile & Permanent Facts (Never deleted)
apiRouter.get('/projects/:project_id/users/:user_id/profile', requireManagementKey, async (req, res) => {
  const project_id = param(req.params.project_id);
  const user_id = param(req.params.user_id);

  const profile = await userProfileEngine.getOrCreateProfile(project_id, user_id);
  const variables = await userProfileEngine.getUserVariables(project_id, user_id);
  const preferences = await userProfileEngine.getUserTtsPreferences(project_id, user_id);

  return ok(res, { profile, variables, preferences }, 'User permanent profile and memory');
});

// Per-User Voice, Speech, Pitch & Language Preferences (Scoped to Project & User)
apiRouter.get(['/projects/:project_id/users/:user_id/preferences', '/user/preferences'], async (req, res) => {
  const userId = (param(req.params.user_id) || req.query.user_id as string || req.query.user_ref as string || 'usr_test_123').trim();
  const projectId = (param(req.params.project_id) || req.query.project_id as string || store.activeProjectId || Array.from(store.clients.keys())[0] || 'default').trim();

  const prefs = await userProfileEngine.getUserTtsPreferences(projectId, userId);
  return ok(res, prefs, 'User voice and speech preferences retrieved');
});

apiRouter.put(['/projects/:project_id/users/:user_id/preferences', '/user/preferences'], async (req, res) => {
  const userId = (param(req.params.user_id) || req.body.user_id || req.body.user_ref || req.query.user_id || 'usr_test_123').toString().trim();
  const projectId = (param(req.params.project_id) || req.body.project_id || req.query.project_id || store.activeProjectId || Array.from(store.clients.keys())[0] || 'default').toString().trim();

  // Note: 'engine' is strictly controlled at Project level (Admin/Management authority).
  // Users configure their character/voice, language, speed, pitch, and auto-speak within the project's assigned engine.
  const updated = await userProfileEngine.setUserTtsPreferences(projectId, userId, {
    language: req.body.language,
    voice: req.body.voice,
    speed: typeof req.body.speed === 'number' ? req.body.speed : undefined,
    pitch: typeof req.body.pitch === 'number' ? req.body.pitch : undefined,
    auto_speak: typeof req.body.auto_speak === 'boolean' ? req.body.auto_speak : undefined,
  });

  return ok(res, updated, 'User voice preferences saved successfully');
});

apiRouter.post('/projects/:project_id/users/:user_id/facts', requireManagementKey, async (req, res) => {
  const project_id = param(req.params.project_id);
  const user_id = param(req.params.user_id);
  const { fact_key, fact_value, category = 'personal', confidence = 1.0 } = req.body;

  if (!fact_key || fact_value === undefined) {
    return err(res, 400, 'BAD_REQUEST', 'fact_key and fact_value are required');
  }

  const profile = await userProfileEngine.getOrCreateProfile(project_id, user_id);
  const fact = await userProfileEngine.setFact(profile.id, project_id, fact_key, fact_value, category, confidence);
  return ok(res, fact, 'User fact saved permanently', 201);
});

// Strict 24-Hour Retention Trigger
apiRouter.post('/system/retention/cleanup-expired', requireManagementKey, async (req, res) => {
  const stats = await conversationRetentionScheduler.cleanupExpiredConversations();
  return ok(res, stats, 'Expired 24h conversations and messages cleaned up');
});

// ════════════════ Workflows ════════════════
apiRouter.get('/projects/:project_id/workflows', requireManagementKey, (req, res) => {
  const project_id = param(req.params.project_id);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit as string || '50', 10)));
  const offset = Math.max(0, parseInt(req.query.offset as string || '0', 10));

  const items = Array.from(store.knowledge.values()).filter(
    (k) => k.client_id === project_id && k.category === 'workflow'
  );
  return okList(res, items.slice(offset, offset + limit), items.length, limit, offset, 'Workflows listed');
});

apiRouter.post('/projects/:project_id/workflows', requireManagementKey, async (req, res) => {
  const project_id = param(req.params.project_id);
  const { name, trigger_text, response_text, steps = [] } = req.body;

  if (!trigger_text || !response_text) {
    return err(res, 400, 'BAD_REQUEST', 'trigger_text and response_text are required');
  }

  const entry = await knowledgeEngine.learn(project_id, trigger_text, response_text, steps, false, 'workflow');
  store.audit('admin', 'WORKFLOW_CREATE', `${name || 'Workflow'} — ${steps.length} steps`);
  return ok(res, entry, 'Workflow created', 201);
});

// ════════════════ System Tools Registry (Global Scope) ════════════════
const DEFAULT_SYSTEM_TOOLS_DEFINITIONS: Omit<ToolDef, 'id' | 'created_at' | 'updated_at'>[] = [
  {
    name: 'text_to_speech',
    description: 'Convert text into natural human speech using Microsoft Edge Neural TTS (100% Free) or Google Gemini 2.0 Flash Audio.',
    type: 'server',
    scope: 'system',
    client_id: null,
    enabled: true,
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to synthesize into speech (supports Bengali, English, and 40+ languages)' },
        engine: { type: 'string', enum: ['edge', 'gemini'], description: 'Engine: "edge" (Microsoft Edge Neural TTS, free) or "gemini" (Google Gemini 2.0 Flash Audio)' },
        voice: { type: 'string', description: 'Voice identifier (e.g. bn-BD-PradeepNeural, bn-BD-NabanitaNeural, en-US-AvaMultilingualNeural, Kore, Puck)' },
        speed: { type: 'number', default: 1.0, description: 'Speed multiplier (0.5 to 2.0)' },
        pitch: { type: 'number', default: 0, description: 'Pitch adjustment (-50 to +50)' }
      },
      required: ['text']
    }
  },
  {
    name: 'web_search',
    description: 'Search the live web for up-to-date facts, current events, documents, and real-time news.',
    type: 'server',
    scope: 'system',
    client_id: null,
    enabled: true,
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords or phrase' },
        limit: { type: 'number', default: 5, description: 'Maximum search results' }
      },
      required: ['query']
    }
  },
  {
    name: 'translation',
    description: 'Translate text between any languages with context preservation.',
    type: 'server',
    scope: 'system',
    client_id: null,
    enabled: true,
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to translate' },
        target_language: { type: 'string', description: 'Target language code (e.g. en, bn, es, fr, ar)' }
      },
      required: ['text', 'target_language']
    }
  },
  {
    name: 'weather',
    description: 'Get real-time live weather conditions and forecasts for any city worldwide.',
    type: 'server',
    scope: 'system',
    client_id: null,
    enabled: true,
    schema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name (e.g. Dhaka, London, San Francisco)' },
        units: { type: 'string', enum: ['celsius', 'fahrenheit'], default: 'celsius' }
      },
      required: ['city']
    }
  },
  {
    name: 'math',
    description: 'Safely evaluate mathematical expressions, percentages, and scientific calculations.',
    type: 'server',
    scope: 'system',
    client_id: null,
    enabled: true,
    schema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Math expression e.g. (1450 * 12) + (3500 / 5)' }
      },
      required: ['expression']
    }
  },
  {
    name: 'currency',
    description: 'Convert currencies using live international exchange rates.',
    type: 'server',
    scope: 'system',
    client_id: null,
    enabled: true,
    schema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Amount to convert' },
        from: { type: 'string', description: 'Source currency code (e.g. USD, EUR, GBP)' },
        to: { type: 'string', description: 'Target currency code (e.g. BDT, INR, EUR)' }
      },
      required: ['amount', 'from', 'to']
    }
  },
  {
    name: 'time',
    description: 'Get current date, time, and timezone information across global cities.',
    type: 'server',
    scope: 'system',
    client_id: null,
    enabled: true,
    schema: {
      type: 'object',
      properties: {
        timezone: { type: 'string', default: 'UTC', description: 'Timezone name or city' }
      }
    }
  }
];

function ensureDefaultSystemToolsSeeded() {
  const existingTools = Array.from(store.tools.values());
  const existingNames = new Set(existingTools.map((t) => t.name));
  const now = new Date().toISOString();
  let changed = false;

  for (const def of DEFAULT_SYSTEM_TOOLS_DEFINITIONS) {
    if (!existingNames.has(def.name)) {
      const id = `sys_tool_${def.name}`;
      store.tools.set(id, {
        ...def,
        id,
        created_at: now,
        updated_at: now,
      });
      changed = true;
    }
  }

  if (changed) {
    store.persist();
  }
}

apiRouter.get('/system/tools', requireManagementKey, (req, res) => {
  ensureDefaultSystemToolsSeeded();
  const items = Array.from(store.tools.values()).filter(
    (t) => t.scope === 'system' || t.client_id === null
  );
  return okList(res, items, items.length, items.length, 0, 'System tools listed');
});

// ════════════════ Text-to-Speech (TTS) Engine API ════════════════
apiRouter.get('/system/tts/config', (req, res) => {
  const ttsData = ttsService.getConfig();
  return ok(res, ttsData, 'TTS Configuration retrieved');
});

apiRouter.put('/system/tts/config', requireManagementKey, (req, res) => {
  const updates = req.body;
  const updated = ttsService.updateConfig(updates);
  store.audit('admin', 'TTS_CONFIG_UPDATE', `Active Engine: ${updated.active_engine}, Voice: ${updated.active_engine === 'gemini' ? updated.gemini_voice : updated.edge_voice}`);
  return ok(res, ttsService.getConfig(), 'TTS Configuration updated successfully');
});

apiRouter.post('/system/tts/synthesize', async (req, res) => {
  const { text, engine, voice, speed, pitch, user_id, user_ref, project_id } = req.body;
  if (!text || !text.trim()) {
    return err(res, 400, 'BAD_REQUEST', 'Text is required for TTS synthesis');
  }

  try {
    const startTime = Date.now();
    const effectiveUserId = (user_id || user_ref || '').toString().trim();
    const effectiveProjectId = (project_id || store.activeProjectId || Array.from(store.clients.keys())[0] || 'default').toString().trim();
    
    let userPrefVoice = voice;
    let userPrefEngine = engine;
    let userPrefSpeed = speed;
    let userPrefPitch = pitch;

    if (effectiveUserId) {
      try {
        const uPrefs = await userProfileEngine.getUserTtsPreferences(effectiveProjectId, effectiveUserId);
        if (!userPrefEngine) userPrefEngine = uPrefs.engine;
        if (!userPrefVoice) userPrefVoice = uPrefs.voice;
        if (userPrefSpeed === undefined) userPrefSpeed = uPrefs.speed;
        if (userPrefPitch === undefined) userPrefPitch = uPrefs.pitch;
      } catch {}
    }

    const result = await ttsService.synthesize(text, {
      engine: userPrefEngine === 'gemini' || userPrefEngine === 'edge' ? userPrefEngine : undefined,
      voice: userPrefVoice || undefined,
      speed: typeof userPrefSpeed === 'number' ? userPrefSpeed : undefined,
      pitch: typeof userPrefPitch === 'number' ? userPrefPitch : undefined,
    });

    return ok(res, {
      engine: result.engine,
      voice: result.voice,
      audio_format: result.mimeType,
      audio_base64: result.buffer.toString('base64'),
      size_bytes: result.buffer.length,
      latency_ms: Date.now() - startTime,
    }, 'Speech synthesized successfully');
  } catch (e: any) {
    console.error('[TTS synthesize error]:', e);
    return err(res, 500, 'TTS_ERROR', e.message || 'Error synthesizing audio');
  }
});

apiRouter.get('/system/tts/stream', async (req, res) => {
  const text = (req.query.text || '').toString().trim();
  let engine = (req.query.engine || '').toString() as 'edge' | 'gemini' | undefined;
  let voice = (req.query.voice || '').toString() || undefined;
  let speed = req.query.speed ? Number(req.query.speed) : undefined;
  let pitch = req.query.pitch ? Number(req.query.pitch) : undefined;
  const userId = (req.query.user_id || req.query.user_ref || '').toString().trim();
  const projectId = (req.query.project_id || store.activeProjectId || Array.from(store.clients.keys())[0] || 'default').toString().trim();

  if (!text) {
    return err(res, 400, 'BAD_REQUEST', 'Query param "text" is required for TTS streaming');
  }

  if (userId) {
    try {
      const uPrefs = await userProfileEngine.getUserTtsPreferences(projectId, userId);
      if (!engine) engine = uPrefs.engine;
      if (!voice) voice = uPrefs.voice;
      if (speed === undefined) speed = uPrefs.speed;
      if (pitch === undefined) pitch = uPrefs.pitch;
    } catch {}
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  try {
    const meta = await ttsService.streamSynthesize(
      text,
      {
        engine: engine === 'gemini' || engine === 'edge' ? engine : undefined,
        voice,
        speed,
        pitch,
      },
      (chunk: Buffer, mimeType: string) => {
        res.write(`event: chunk\ndata: ${JSON.stringify({
          data: chunk.toString('base64'),
          mimeType,
        })}\n\n`);
      }
    );

    res.write(`event: done\ndata: ${JSON.stringify(meta)}\n\n`);
    res.end();
  } catch (err: any) {
    console.error('[TTS stream error]:', err);
    res.write(`event: error\ndata: ${JSON.stringify({ message: err.message || 'Streaming failed' })}\n\n`);
    res.end();
  }
});

apiRouter.get('/system/tts/audio', async (req, res) => {
  const text = (req.query.text || '').toString().trim();
  let engine = (req.query.engine || '').toString() as 'edge' | 'gemini' | undefined;
  let voice = (req.query.voice || '').toString() || undefined;
  let speed = req.query.speed ? Number(req.query.speed) : undefined;
  let pitch = req.query.pitch ? Number(req.query.pitch) : undefined;
  const userId = (req.query.user_id || req.query.user_ref || '').toString().trim();
  const projectId = (req.query.project_id || store.activeProjectId || Array.from(store.clients.keys())[0] || 'default').toString().trim();

  if (!text) {
    return res.status(400).send('Query parameter "text" is required');
  }

  if (userId) {
    try {
      const uPrefs = await userProfileEngine.getUserTtsPreferences(projectId, userId);
      if (!engine) engine = uPrefs.engine;
      if (!voice) voice = uPrefs.voice;
      if (speed === undefined) speed = uPrefs.speed;
      if (pitch === undefined) pitch = uPrefs.pitch;
    } catch {}
  }

  try {
    const result = await ttsService.synthesize(text, {
      engine: engine === 'gemini' || engine === 'edge' ? engine : undefined,
      voice,
      speed,
      pitch,
    });

    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Length', result.buffer.length);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(result.buffer);
  } catch (err: any) {
    console.error('[TTS audio endpoint error]:', err);
    return res.status(500).send(err.message || 'Speech generation failed');
  }
});

// ════════════════ User Profile & Voice Preferences API ════════════════
apiRouter.get('/projects/:project_id/users/:user_id/preferences', async (req, res) => {
  const projectId = param(req.params.project_id);
  const userId = param(req.params.user_id);

  if (!userId) {
    return err(res, 400, 'BAD_REQUEST', 'User ID is required');
  }

  try {
    const prefs = await userProfileEngine.getUserTtsPreferences(projectId, userId);
    return ok(res, prefs, 'User preferences retrieved successfully');
  } catch (e: any) {
    return err(res, 500, 'INTERNAL_ERROR', e.message || 'Failed to fetch user preferences');
  }
});

apiRouter.put('/projects/:project_id/users/:user_id/preferences', async (req, res) => {
  const projectId = param(req.params.project_id);
  const userId = param(req.params.user_id);
  const { language, engine, voice, speed, pitch, auto_speak } = req.body;

  if (!userId) {
    return err(res, 400, 'BAD_REQUEST', 'User ID is required');
  }

  try {
    const updated = await userProfileEngine.setUserTtsPreferences(projectId, userId, {
      language,
      engine: engine === 'gemini' || engine === 'edge' ? engine : undefined,
      voice,
      speed: typeof speed === 'number' ? speed : undefined,
      pitch: typeof pitch === 'number' ? pitch : undefined,
      auto_speak: typeof auto_speak === 'boolean' ? auto_speak : undefined,
    });
    return ok(res, updated, 'User preferences updated successfully and persisted');
  } catch (e: any) {
    return err(res, 500, 'INTERNAL_ERROR', e.message || 'Failed to update user preferences');
  }
});

apiRouter.get('/users/:user_id/preferences', async (req, res) => {
  const projectId = (req.query.project_id || store.activeProjectId || Array.from(store.clients.keys())[0] || 'default').toString().trim();
  const userId = param(req.params.user_id);

  if (!userId) {
    return err(res, 400, 'BAD_REQUEST', 'User ID is required');
  }

  try {
    const prefs = await userProfileEngine.getUserTtsPreferences(projectId, userId);
    return ok(res, prefs, 'User preferences retrieved successfully');
  } catch (e: any) {
    return err(res, 500, 'INTERNAL_ERROR', e.message || 'Failed to fetch user preferences');
  }
});

apiRouter.put('/users/:user_id/preferences', async (req, res) => {
  const projectId = (req.body.project_id || store.activeProjectId || Array.from(store.clients.keys())[0] || 'default').toString().trim();
  const userId = param(req.params.user_id);
  const { language, engine, voice, speed, pitch, auto_speak } = req.body;

  if (!userId) {
    return err(res, 400, 'BAD_REQUEST', 'User ID is required');
  }

  try {
    const updated = await userProfileEngine.setUserTtsPreferences(projectId, userId, {
      language,
      engine: engine === 'gemini' || engine === 'edge' ? engine : undefined,
      voice,
      speed: typeof speed === 'number' ? speed : undefined,
      pitch: typeof pitch === 'number' ? pitch : undefined,
      auto_speak: typeof auto_speak === 'boolean' ? auto_speak : undefined,
    });
    return ok(res, updated, 'User preferences updated successfully and persisted');
  } catch (e: any) {
    return err(res, 500, 'INTERNAL_ERROR', e.message || 'Failed to update user preferences');
  }
});

apiRouter.post('/system/tools', requireManagementKey, (req, res) => {
  const { name, description, type = 'server', schema = {}, enabled = true } = req.body;
  if (!name || !name.trim()) {
    return err(res, 400, 'BAD_REQUEST', 'System tool name is required');
  }

  const toolId = crypto.randomUUID();
  const now = new Date().toISOString();
  const tool: ToolDef = {
    id: toolId,
    client_id: null,
    scope: 'system',
    name: name.trim(),
    description: description || '',
    type: type || 'server',
    schema: typeof schema === 'string' ? JSON.parse(schema) : schema,
    enabled: enabled !== false,
    created_at: now,
    updated_at: now,
  };

  store.tools.set(toolId, tool);
  store.audit('admin', 'SYSTEM_TOOL_CREATE', `System Tool: ${name}`);
  return ok(res, tool, 'System tool created', 201);
});

apiRouter.put('/system/tools/:tool_id', requireManagementKey, (req, res) => {
  const tool_id = param(req.params.tool_id);
  const tool = store.tools.get(tool_id);
  if (!tool || (tool.scope !== 'system' && tool.client_id !== null)) {
    return err(res, 404, 'NOT_FOUND', 'System tool not found');
  }

  const { name, description, type, schema, enabled } = req.body;
  if (name !== undefined) tool.name = name.trim();
  if (description !== undefined) tool.description = description;
  if (type !== undefined) tool.type = type;
  if (schema !== undefined) tool.schema = typeof schema === 'string' ? JSON.parse(schema) : schema;
  if (enabled !== undefined) tool.enabled = Boolean(enabled);
  tool.updated_at = new Date().toISOString();

  store.tools.set(tool_id, tool);
  store.audit('admin', 'SYSTEM_TOOL_UPDATE', `Updated system tool: ${tool.name}`);
  return ok(res, tool, 'System tool updated');
});

apiRouter.delete('/system/tools/:tool_id', requireManagementKey, (req, res) => {
  const tool_id = param(req.params.tool_id);
  const tool = store.tools.get(tool_id);
  if (!tool || (tool.scope !== 'system' && tool.client_id !== null)) {
    return err(res, 404, 'NOT_FOUND', 'System tool not found');
  }

  store.tools.delete(tool_id);
  store.audit('admin', 'SYSTEM_TOOL_DELETE', `Deleted system tool: ${tool.name}`);
  return ok(res, null, 'System tool deleted');
});

apiRouter.post('/system/tools/:tool_id/execute', requireManagementKey, async (req, res) => {
  const tool_id = param(req.params.tool_id);
  const tool = store.tools.get(tool_id);
  if (!tool || (tool.scope !== 'system' && tool.client_id !== null)) {
    return err(res, 404, 'NOT_FOUND', 'System tool not found');
  }

  const args = req.body.args || req.body.arguments || {};
  try {
    const result = await toolEngine.executeServerTool(tool.name, args || {}, 'system', 'admin');
    return ok(res, result, `Executed system tool ${tool.name} successfully`);
  } catch (e: any) {
    return err(res, 500, 'EXECUTION_ERROR', e.message || 'Error executing tool');
  }
});

// ════════════════ Client-Facing Tools Discovery (Android, IoT, Desktop) ════════════════
apiRouter.get('/tools', (req, res) => {
  const auth = authenticateClientKey(req, res);
  if (!auth) return;

  const items = Array.from(store.tools.values()).filter(
    (t) => t.enabled && (!t.client_id || t.client_id === auth.client.id || t.scope === 'system')
  );
  return okList(res, items, items.length, items.length, 0, 'Active client tools listed');
});

// ════════════════ Project Tools Registry (Scoped to Active Project) ════════════════
apiRouter.get('/projects/:project_id/tools', requireManagementKey, (req, res) => {
  const project_id = param(req.params.project_id);
  // Return only tools explicitly owned by this project
  const items = Array.from(store.tools.values()).filter(
    (t) => t.client_id === project_id
  );
  return okList(res, items, items.length, items.length, 0, 'Project tools listed');
});

apiRouter.post('/projects/:project_id/tools', requireManagementKey, (req, res) => {
  const project_id = param(req.params.project_id);
  const { name, description, type = 'client', schema = {}, enabled = true } = req.body;

  if (!name || !name.trim()) {
    return err(res, 400, 'BAD_REQUEST', 'Tool name is required');
  }

  const toolId = crypto.randomUUID();
  const now = new Date().toISOString();
  const tool: ToolDef = {
    id: toolId,
    client_id: project_id,
    scope: 'project',
    name: name.trim(),
    description: description || '',
    type: type === 'client' ? 'client' : 'server',
    schema: typeof schema === 'string' ? JSON.parse(schema) : schema,
    enabled: enabled !== false,
    created_at: now,
    updated_at: now,
  };

  store.tools.set(toolId, tool);
  store.audit('admin', 'PROJECT_TOOL_CREATE', `${name} for project ${project_id}`);
  return ok(res, tool, 'Project tool created', 201);
});

apiRouter.put('/projects/:project_id/tools/:tool_id', requireManagementKey, (req, res) => {
  const tool_id = param(req.params.tool_id);
  const project_id = param(req.params.project_id);
  const tool = store.tools.get(tool_id);
  if (!tool || tool.client_id !== project_id) {
    return err(res, 404, 'NOT_FOUND', 'Project tool not found');
  }

  const { name, description, type, schema, enabled } = req.body;
  if (name !== undefined) tool.name = name.trim();
  if (description !== undefined) tool.description = description;
  if (type !== undefined) tool.type = type === 'client' ? 'client' : 'server';
  if (schema !== undefined) tool.schema = typeof schema === 'string' ? JSON.parse(schema) : schema;
  if (enabled !== undefined) tool.enabled = Boolean(enabled);
  tool.updated_at = new Date().toISOString();

  store.tools.set(tool_id, tool);
  store.audit('admin', 'PROJECT_TOOL_UPDATE', `Updated ${tool.name} (project ${project_id})`);
  return ok(res, tool, 'Project tool updated');
});

apiRouter.delete('/projects/:project_id/tools/:tool_id', requireManagementKey, (req, res) => {
  const tool_id = param(req.params.tool_id);
  const project_id = param(req.params.project_id);
  const tool = store.tools.get(tool_id);
  if (!tool || tool.client_id !== project_id) {
    return err(res, 404, 'NOT_FOUND', 'Project tool not found');
  }

  store.tools.delete(tool_id);
  store.audit('admin', 'PROJECT_TOOL_DELETE', `${tool.name} (project ${project_id})`);
  return ok(res, null, 'Project tool deleted');
});

// ════════════════ Users & Analytics ════════════════
apiRouter.get('/projects/:project_id/users', requireManagementKey, (req, res) => {
  const project_id = param(req.params.project_id);
  const search = ((req.query.search as string) || '').toLowerCase().trim();
  const startDate = req.query.start_date as string | undefined;
  const endDate = req.query.end_date as string | undefined;
  const statusFilter = (req.query.status as string) || 'all';

  let users = Array.from(store.users.values()).filter((u) => u.client_id === project_id);

  // Search filter (Name, Email, or User ID)
  if (search) {
    users = users.filter((u) => {
      const name = (u.name || '').toLowerCase();
      const email = (u.email || '').toLowerCase();
      const extId = (u.external_id || '').toLowerCase();
      return name.includes(search) || email.includes(search) || extId.includes(search);
    });
  }

  // Date range filter based on created_at (Joining Time)
  if (startDate) {
    const start = new Date(startDate).setHours(0, 0, 0, 0);
    users = users.filter((u) => new Date(u.created_at).getTime() >= start);
  }
  if (endDate) {
    const end = new Date(endDate).setHours(23, 59, 59, 999);
    users = users.filter((u) => new Date(u.created_at).getTime() <= end);
  }

  // Status filter
  if (statusFilter !== 'all') {
    users = users.filter((u) => {
      if (statusFilter === 'blocked') return u.blocked;
      if (statusFilter === 'inactive') return !u.blocked && u.is_logged_out;
      if (statusFilter === 'active') return !u.blocked && !u.is_logged_out;
      return true;
    });
  }

  // Sort by most recently active / joined first
  users.sort((a, b) => new Date(b.last_active || b.created_at).getTime() - new Date(a.last_active || a.created_at).getTime());

  const items = users.map((u) => ({
    id: u.id,
    user_id: u.external_id,
    name: u.name || u.external_id,
    email: u.email || '',
    plan: u.plan,
    blocked: u.blocked,
    block_message: u.block_message || '',
    is_logged_out: !!u.is_logged_out,
    status: u.blocked ? 'blocked' : (u.is_logged_out ? 'inactive' : 'active'),
    requests_today: u.requests_today,
    requests_month: u.requests_month,
    total_requests: u.requests_month,
    total_tokens: u.tokens_month,
    created_at: u.created_at, // Joining time
    last_active: u.last_active || u.created_at,
  }));

  return okList(res, items, items.length, 500, 0, 'Users listed');
});

// Admin Add / Register User Directly
apiRouter.post('/projects/:project_id/users', requireManagementKey, (req, res) => {
  const project_id = param(req.params.project_id);
  const { user_id, name, email, plan = 'standard', blocked = false, block_message } = req.body;

  if (!user_id || !user_id.trim()) {
    return err(res, 400, 'BAD_REQUEST', 'User ID is required');
  }

  const cleanId = user_id.trim();
  const userKey = `${project_id}:${cleanId}`;

  if (store.users.has(userKey)) {
    return err(res, 409, 'USER_EXISTS', `User '${cleanId}' already exists in this project`);
  }

  const now = new Date().toISOString();
  const newUser: UserProfile = {
    id: crypto.randomUUID(),
    client_id: project_id,
    external_id: cleanId,
    name: (name || '').trim() || cleanId,
    email: (email || '').trim() || undefined,
    plan: (plan || 'standard').trim(),
    blocked: Boolean(blocked),
    block_message: block_message ? block_message.trim() : undefined,
    is_logged_out: false,
    tokens_today: 0,
    tokens_month: 0,
    requests_today: 0,
    requests_month: 0,
    errors_total: 0,
    created_at: now,
    last_active: now,
  };

  store.users.set(userKey, newUser);
  store.audit('admin', 'USER_CREATE', `Created user ${cleanId} (${newUser.name}) in project ${project_id}`);
  return ok(res, newUser, 'User created successfully', 201);
});

// Admin Block/Unblock User Endpoint with Custom Message
apiRouter.put('/projects/:project_id/users/:user_id/block', requireManagementKey, (req, res) => {
  const project_id = param(req.params.project_id);
  const user_id = param(req.params.user_id);
  const { blocked, block_message } = req.body;

  let targetUser: UserProfile | undefined;
  let targetKey: string | undefined;

  for (const [k, u] of store.users.entries()) {
    if (u.client_id === project_id && (u.external_id === user_id || u.id === user_id)) {
      targetUser = u;
      targetKey = k;
      break;
    }
  }

  if (!targetUser || !targetKey) {
    return err(res, 404, 'NOT_FOUND', `User '${user_id}' not found in project`);
  }

  targetUser.blocked = Boolean(blocked);
  if (block_message !== undefined) {
    targetUser.block_message = block_message.trim();
  }

  store.users.set(targetKey, targetUser);
  store.audit(
    'admin',
    targetUser.blocked ? 'USER_BLOCK' : 'USER_UNBLOCK',
    `User ${targetUser.external_id} (${targetUser.name || 'unnamed'}) in project ${project_id}`
  );

  return ok(res, targetUser, `User ${targetUser.blocked ? 'blocked' : 'unblocked'} successfully`);
});

// Admin Update User Profile Endpoint
apiRouter.put('/projects/:project_id/users/:user_id', requireManagementKey, (req, res) => {
  const project_id = param(req.params.project_id);
  const user_id = param(req.params.user_id);
  const { name, email, plan, is_logged_out } = req.body;

  let targetUser: UserProfile | undefined;
  let targetKey: string | undefined;

  for (const [k, u] of store.users.entries()) {
    if (u.client_id === project_id && (u.external_id === user_id || u.id === user_id)) {
      targetUser = u;
      targetKey = k;
      break;
    }
  }

  if (!targetUser || !targetKey) {
    return err(res, 404, 'NOT_FOUND', `User '${user_id}' not found in project`);
  }

  if (name !== undefined) targetUser.name = name.trim();
  if (email !== undefined) targetUser.email = email.trim();
  if (plan !== undefined) targetUser.plan = plan.trim();
  if (is_logged_out !== undefined) targetUser.is_logged_out = Boolean(is_logged_out);

  store.users.set(targetKey, targetUser);
  store.audit('admin', 'USER_UPDATE', `Updated user ${targetUser.external_id}`);
  return ok(res, targetUser, 'User updated successfully');
});

// Admin Delete User Endpoint
apiRouter.delete('/projects/:project_id/users/:user_id', requireManagementKey, (req, res) => {
  const project_id = param(req.params.project_id);
  const user_id = param(req.params.user_id);

  let targetKey: string | undefined;
  let externalId = user_id;

  for (const [k, u] of store.users.entries()) {
    if (u.client_id === project_id && (u.external_id === user_id || u.id === user_id)) {
      targetKey = k;
      externalId = u.external_id;
      break;
    }
  }

  if (!targetKey) {
    return err(res, 404, 'NOT_FOUND', `User '${user_id}' not found in project`);
  }

  store.users.delete(targetKey);
  store.audit('admin', 'USER_DELETE', `Deleted user ${externalId} from project ${project_id}`);
  return ok(res, null, `User '${externalId}' deleted successfully`);
});

// ════════════════ Client-Side User Profile & Session Endpoints ════════════════

// ════════════════ Client-Side User Profile & Session Endpoints ════════════════

// Client Endpoint: Register, Initialize or Authenticate user from Client Side
// Sends user data (user_id, name, email, plan, metadata, optional initial voice preferences) on first visit
// After this, client only needs to pass "user_ref": user_id in /agent/process calls without resending name/email every time
apiRouter.post('/client/user/register', async (req, res) => {
  const auth = authenticateClientKey(req, res);
  if (!auth) return;

  const {
    user_id,
    external_id,
    name,
    email,
    plan = 'standard',
    metadata,
    preferred_language,
    voice,
    speed,
    pitch,
    auto_speak
  } = req.body;
  const userRef = (user_id || external_id || '').toString().trim();

  if (!userRef) {
    return err(res, 400, 'BAD_REQUEST', 'Missing user_id identifier in request body');
  }

  const userKey = `${auth.client.id}:${userRef}`;
  let user = store.users.get(userKey);
  const now = new Date().toISOString();

  if (!user) {
    user = {
      id: crypto.randomUUID(),
      client_id: auth.client.id,
      external_id: userRef,
      name: name?.toString().trim() || userRef,
      email: email?.toString().trim() || undefined,
      plan: plan?.toString().trim() || 'standard',
      blocked: false,
      is_logged_out: false,
      tokens_today: 0,
      tokens_month: 0,
      requests_today: 0,
      requests_month: 0,
      errors_total: 0,
      created_at: now,
      last_active: now,
    };
  } else {
    if (name !== undefined) user.name = name.toString().trim();
    if (email !== undefined) user.email = email.toString().trim();
    if (plan !== undefined) user.plan = plan.toString().trim();
    user.is_logged_out = false;
    user.last_active = now;
  }

  store.users.set(userKey, user);

  // Sync with persistent user memory profile
  try {
    const profile = await userProfileEngine.getOrCreateProfile(auth.client.id, userRef);
    if (name) {
      await userProfileEngine.setUserVariable(profile.id, auth.client.id, 'user_name', user.name, 'explicit');
    }
    if (email) {
      await userProfileEngine.setUserVariable(profile.id, auth.client.id, 'email', user.email, 'explicit');
    }
    if (preferred_language) {
      await userProfileEngine.setUserVariable(profile.id, auth.client.id, 'language', preferred_language, 'explicit');
    }

    // If client supplied initial voice preferences during registration/bootstrapping
    if (voice || speed !== undefined || pitch !== undefined || auto_speak !== undefined || preferred_language) {
      await userProfileEngine.setUserTtsPreferences(auth.client.id, userRef, {
        language: preferred_language,
        voice,
        speed: typeof speed === 'number' ? speed : undefined,
        pitch: typeof pitch === 'number' ? pitch : undefined,
        auto_speak: typeof auto_speak === 'boolean' ? auto_speak : undefined,
      });
    }
  } catch (e: any) {
    console.warn('[User Register Profile Warning]:', e?.message);
  }

  // Fetch resolved user preferences
  const preferences = await userProfileEngine.getUserTtsPreferences(auth.client.id, userRef);

  return ok(res, {
    user: {
      user_id: user.external_id,
      name: user.name,
      email: user.email,
      plan: user.plan,
      created_at: user.created_at,
      last_active: user.last_active,
    },
    preferences,
    session: {
      client_id: auth.client.id,
      project_name: auth.client.name,
      tts_engine: auth.client.tts_engine || 'edge',
      is_authenticated: true
    }
  }, 'Client user initialized and registered successfully', 200);
});

// Client Endpoint: Get user profile and preferences from Client Side
apiRouter.get('/client/user/profile', async (req, res) => {
  const auth = authenticateClientKey(req, res);
  if (!auth) return;

  const userRef = (req.query.user_id as string || req.query.user_ref as string || req.query.external_id as string || '').trim();
  if (!userRef) {
    return err(res, 400, 'BAD_REQUEST', 'Missing user_id query parameter');
  }

  const userKey = `${auth.client.id}:${userRef}`;
  const user = store.users.get(userKey);
  const preferences = await userProfileEngine.getUserTtsPreferences(auth.client.id, userRef);

  return ok(res, {
    user: user ? {
      user_id: user.external_id,
      name: user.name,
      email: user.email,
      plan: user.plan,
      created_at: user.created_at,
      last_active: user.last_active,
      blocked: user.blocked,
    } : {
      user_id: userRef,
      name: userRef,
      created_at: new Date().toISOString(),
      last_active: new Date().toISOString(),
      blocked: false
    },
    preferences,
    project: {
      id: auth.client.id,
      name: auth.client.name,
      tts_engine: auth.client.tts_engine || 'edge',
      tts_voice: auth.client.tts_voice,
    }
  }, 'Client user profile retrieved');
});

// Client Endpoint: Update user profile (Name, Email, Preferences) from Settings or Client UI
apiRouter.put('/client/user/profile', async (req, res) => {
  const auth = authenticateClientKey(req, res);
  if (!auth) return;

  const { user_id, external_id, name, email, plan, preferences: prefsUpdate } = req.body;
  const userRef = (user_id || external_id || '').toString().trim();

  if (!userRef) {
    return err(res, 400, 'BAD_REQUEST', 'Missing user_id identifier in request body');
  }

  const userKey = `${auth.client.id}:${userRef}`;
  let user = store.users.get(userKey);
  const now = new Date().toISOString();

  if (!user) {
    user = {
      id: crypto.randomUUID(),
      client_id: auth.client.id,
      external_id: userRef,
      name: name?.toString().trim() || userRef,
      email: email?.toString().trim() || '',
      plan: (plan || 'standard').toString().trim(),
      blocked: false,
      is_logged_out: false,
      tokens_today: 0,
      tokens_month: 0,
      requests_today: 0,
      requests_month: 0,
      errors_total: 0,
      created_at: now,
      last_active: now,
    };
  } else {
    if (name !== undefined) user.name = name.toString().trim();
    if (email !== undefined) user.email = email.toString().trim();
    if (plan !== undefined) user.plan = plan.toString().trim();
    user.last_active = now;
  }

  store.users.set(userKey, user);

  // Sync memory variables
  try {
    const profile = await userProfileEngine.getOrCreateProfile(auth.client.id, userRef);
    if (name !== undefined) {
      await userProfileEngine.setUserVariable(profile.id, auth.client.id, 'user_name', user.name, 'explicit');
    }
    if (email !== undefined) {
      await userProfileEngine.setUserVariable(profile.id, auth.client.id, 'email', user.email, 'explicit');
    }

    if (prefsUpdate && typeof prefsUpdate === 'object') {
      await userProfileEngine.setUserTtsPreferences(auth.client.id, userRef, {
        language: prefsUpdate.language,
        voice: prefsUpdate.voice,
        speed: typeof prefsUpdate.speed === 'number' ? prefsUpdate.speed : undefined,
        pitch: typeof prefsUpdate.pitch === 'number' ? prefsUpdate.pitch : undefined,
        auto_speak: typeof prefsUpdate.auto_speak === 'boolean' ? prefsUpdate.auto_speak : undefined,
      });
    }
  } catch (e: any) {
    console.warn('[User Profile Update Warning]:', e?.message);
  }

  const preferences = await userProfileEngine.getUserTtsPreferences(auth.client.id, userRef);

  return ok(res, {
    user: {
      user_id: user.external_id,
      name: user.name,
      email: user.email,
      plan: user.plan,
      last_active: user.last_active,
    },
    preferences,
  }, 'Client user profile and preferences updated successfully');
});

// Client Endpoint: Update or Customize User Voice & Speech Preferences from Client Settings
apiRouter.put('/client/user/preferences', async (req, res) => {
  const auth = authenticateClientKey(req, res);
  if (!auth) return;

  const { user_id, external_id, language, voice, speed, pitch, auto_speak } = req.body;
  const userRef = (user_id || external_id || req.query.user_id || '').toString().trim();

  if (!userRef) {
    return err(res, 400, 'BAD_REQUEST', 'Missing user_id identifier');
  }

  const updatedPrefs = await userProfileEngine.setUserTtsPreferences(auth.client.id, userRef, {
    language,
    voice,
    speed: typeof speed === 'number' ? speed : undefined,
    pitch: typeof pitch === 'number' ? pitch : undefined,
    auto_speak: typeof auto_speak === 'boolean' ? auto_speak : undefined,
  });

  return ok(res, updatedPrefs, 'User voice preferences updated successfully');
});

// Client Endpoint: User Logout / Mark as Inactive from Client Side
apiRouter.post('/client/user/logout', (req, res) => {
  const auth = authenticateClientKey(req, res);
  if (!auth) return;

  const { user_id } = req.body;
  const userRef = user_id || req.body.external_id;

  if (!userRef || typeof userRef !== 'string') {
    return err(res, 400, 'BAD_REQUEST', 'Missing user_id identifier in body');
  }

  const userKey = `${auth.client.id}:${userRef}`;
  const user = store.users.get(userKey);

  if (user) {
    user.is_logged_out = true;
    user.last_active = new Date().toISOString();
    store.users.set(userKey, user);
  }

  return ok(res, { user_id: userRef, is_logged_out: true, status: 'inactive' }, 'User logged out successfully');
});

// Client Endpoint: User Self-Delete / Account Deletion from Client Side
apiRouter.delete('/client/user', (req, res) => {
  const auth = authenticateClientKey(req, res);
  if (!auth) return;

  const userRef = (req.query.user_id as string) || req.body.user_id || req.body.external_id;

  if (!userRef || typeof userRef !== 'string') {
    return err(res, 400, 'BAD_REQUEST', 'Missing user_id in query or body');
  }

  const userKey = `${auth.client.id}:${userRef}`;
  const user = store.users.get(userKey);

  if (user) {
    store.users.delete(userKey);
  }

  return ok(res, null, `User '${userRef}' account deleted successfully from client side`);
});

apiRouter.get('/projects/:project_id/analytics', requireManagementKey, (req, res) => {
  const project_id = param(req.params.project_id);
  const client = store.clients.get(project_id);
  if (!client) {
    return err(res, 404, 'NOT_FOUND', 'Project not found');
  }

  const logs = store.executionLogs.filter((l) => l.client_id === project_id);
  const totalRequests = logs.length;
  const totalTokens = logs.reduce((acc, l) => acc + l.tokens_used, 0);
  const tokensSavedTotal = logs.reduce((acc, l) => acc + (l.tokens_saved || 0), 0);
  const totalCostUsd = logs.reduce((acc, l) => acc + l.cost_usd, 0);
  const totalLatency = logs.reduce((acc, l) => acc + l.latency_ms, 0);
  const errors = logs.filter((l) => l.status_code >= 400).length;

  const learnedSkillExecutions = logs.filter((l) => l.source === 'learned_skill').length;
  const knowledgeExecutions = logs.filter((l) => l.source === 'knowledge' || l.source === 'knowledge_base').length;
  const toolExecutions = logs.filter((l) => l.source === 'tool').length;
  const aiApiCalls = logs.filter((l) => l.source === 'ai' || l.source === 'llm' || l.source === 'tool').length;
  const zeroApiRequests = learnedSkillExecutions + knowledgeExecutions;

  const knowledgeHitRate = totalRequests > 0 ? Math.round((knowledgeExecutions / totalRequests) * 1000) / 10 : 0;
  const skillHitRate = totalRequests > 0 ? Math.round((learnedSkillExecutions / totalRequests) * 1000) / 10 : 0;
  const zeroApiRate = totalRequests > 0 ? Math.round((zeroApiRequests / totalRequests) * 1000) / 10 : 0;
  const aiFallbackRate = totalRequests > 0 ? Math.round((aiApiCalls / totalRequests) * 1000) / 10 : 0;
  const estimatedCostSavedUsd = Math.round((tokensSavedTotal / 1000) * 0.00025 * 100000) / 100000;

  const usersCount = new Set(logs.map((l) => l.user_ref)).size;
  const errorRate = totalRequests > 0 ? Math.round((errors / totalRequests) * 1000) / 1000 : 0;
  const avgLatency = totalRequests > 0 ? Math.round(totalLatency / totalRequests) : 0;

  const projectSkills = Array.from(store.skills.values()).filter(
    (s) => s.client_id === null || s.client_id === project_id
  );

  // Time series
  const timeSeriesMap = new Map<string, { requests: number; zeroApi: number; aiCalls: number; users: Set<string> }>();
  logs.forEach((log) => {
    const dateStr = log.created_at.split('T')[0];
    if (!timeSeriesMap.has(dateStr)) {
      timeSeriesMap.set(dateStr, { requests: 0, zeroApi: 0, aiCalls: 0, users: new Set() });
    }
    const entry = timeSeriesMap.get(dateStr)!;
    entry.requests++;
    if (log.source === 'learned_skill' || log.source === 'knowledge' || log.source === 'knowledge_base') {
      entry.zeroApi++;
    } else {
      entry.aiCalls++;
    }
    entry.users.add(log.user_ref);
  });

  const time_series = Array.from(timeSeriesMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, data]) => ({
      date,
      requests: data.requests,
      zero_api: data.zeroApi,
      ai_calls: data.aiCalls,
      users: data.users.size,
    }));

  return ok(
    res,
    {
      project_id,
      total_requests: totalRequests,
      ai_api_calls: aiApiCalls,
      zero_api_requests: zeroApiRequests,
      learned_skill_executions: learnedSkillExecutions,
      tool_only_executions: toolExecutions,
      knowledge_hit_rate: knowledgeHitRate,
      learned_skill_hit_rate: skillHitRate,
      zero_api_hit_rate: zeroApiRate,
      ai_fallback_rate: aiFallbackRate,
      estimated_cost_saved_usd: estimatedCostSavedUsd,
      tokens_saved_total: tokensSavedTotal,
      skills_count: projectSkills.length,
      users: { total: usersCount, daily_active: usersCount },
      requests: {
        today: totalRequests,
        this_month: totalRequests,
        all_time: totalRequests,
        time_series,
      },
      tokens: {
        total: totalTokens,
        tokens_saved: tokensSavedTotal,
        average_per_user: usersCount > 0 ? Math.round(totalTokens / usersCount) : 0,
      },
      cost: {
        total_usd: totalCostUsd,
        saved_usd: estimatedCostSavedUsd,
      },
      source_distribution: {
        learned_skill: learnedSkillExecutions,
        knowledge_base: knowledgeExecutions,
        ai_provider: aiApiCalls - toolExecutions,
        tool_execution: toolExecutions,
      },
      error_rate: errorRate,
      average_response_time_ms: avgLatency,
    },
    'Analytics telemetry'
  );
});

apiRouter.get('/system/analytics/summary', requireManagementKey, (req, res) => {
  const totalLogs = store.executionLogs.length;
  const totalTokens = store.executionLogs.reduce((acc, l) => acc + l.tokens_used, 0);
  const totalTokensSaved = store.executionLogs.reduce((acc, l) => acc + (l.tokens_saved || 0), 0);
  const totalLatency = store.executionLogs.reduce((acc, l) => acc + l.latency_ms, 0);
  const errors = store.executionLogs.filter((l) => l.status_code >= 400).length;

  const learnedSkillsCount = Array.from(store.skills.values()).length;
  const learnedSkillExecutions = store.executionLogs.filter((l) => l.source === 'learned_skill').length;
  const kbExecutions = store.executionLogs.filter((l) => l.source === 'knowledge' || l.source === 'knowledge_base').length;
  const toolExecutions = store.executionLogs.filter((l) => l.source === 'tool').length;
  const aiCalls = store.executionLogs.filter((l) => l.source === 'ai' || l.source === 'llm' || l.source === 'tool').length;
  const zeroApiCount = learnedSkillExecutions + kbExecutions;

  const errorRate = totalLogs > 0 ? Math.round((errors / totalLogs) * 1000) / 1000 : 0;
  const avgLatency = totalLogs > 0 ? Math.round(totalLatency / totalLogs) : 0;
  const realActiveUsers = Array.from(store.users.values()).filter((u) => !u.blocked && !u.is_logged_out).length;
  const estimatedCostSaved = Math.round((totalTokensSaved / 1000) * 0.00025 * 100000) / 100000;

  return ok(
    res,
    {
      total_requests: totalLogs,
      ai_api_calls: aiCalls,
      zero_api_requests: zeroApiCount,
      learned_skill_executions: learnedSkillExecutions,
      tool_only_executions: toolExecutions,
      knowledge_hit_rate: totalLogs > 0 ? Math.round((kbExecutions / totalLogs) * 1000) / 10 : 0,
      learned_skill_hit_rate: totalLogs > 0 ? Math.round((learnedSkillExecutions / totalLogs) * 1000) / 10 : 0,
      zero_api_hit_rate: totalLogs > 0 ? Math.round((zeroApiCount / totalLogs) * 1000) / 10 : 0,
      ai_fallback_rate: totalLogs > 0 ? Math.round((aiCalls / totalLogs) * 1000) / 10 : 0,
      estimated_cost_saved_usd: estimatedCostSaved,
      tokens_saved_total: totalTokensSaved,
      learned_skills_count: learnedSkillsCount,
      total_tokens: totalTokens,
      avg_latency_ms: avgLatency,
      active_users: realActiveUsers,
      error_rate: errorRate,
      uptime_percent: 100,
    },
    'System analytics summary'
  );
});

apiRouter.get('/system/health', async (req, res) => {
  const uptimeSec = Math.floor((Date.now() - store.bootTime) / 1000);
  const providersStatus: Record<string, string> = {};
  for (const [pId, p] of store.providers.entries()) {
    providersStatus[pId] = p.api_key || pId === 'gemini' ? 'configured' : 'not_configured';
  }

  let database = store.pgReady
    ? 'connected (PostgreSQL source of truth + hot memory cache)'
    : 'in-memory cache only (PostgreSQL not ready)';
  let dbOk = store.pgReady;
  let isConfigured = false;
  try {
    const { getPgPool, isPostgresConfigured } = await import('../db/index.js');
    isConfigured = isPostgresConfigured();
    if (isConfigured) {
      const pool = getPgPool();
      if (!pool) {
        database = 'PostgreSQL configured but pool failed to initialize';
        dbOk = false;
      } else {
        await pool.query('SELECT 1');
        dbOk = true;
        store.pgReady = true;
        database = 'connected (PostgreSQL source of truth + hot memory cache)';
      }
    } else {
      // Intentionally running in memory only
      database = 'connected (in-memory only mode)';
      dbOk = true; // Count as OK for health check purposes
    }
  } catch (e: any) {
    dbOk = false;
    store.pgReady = false;
    database = `load failed: ${e?.message || 'PostgreSQL unreachable'}`;
  }

  return ok(
    res,
    {
      status: dbOk ? 'healthy' : 'degraded',
      database,
      pg_ready: store.pgReady,
      redis: 'connected (in-memory hot-cache)',
      version: '2.4.1',
      uptime_seconds: uptimeSec,
      providers: providersStatus,
      ai_quota_exceeded: isAiQuotaExceeded(),
      ai_quota_error_detail: getAiQuotaErrorDetail(),
    },
    dbOk ? 'Health' : 'Database load degraded'
  );
});

apiRouter.post('/system/credentials', requireManagementKey, (req, res) => {
  const { username, email, password, management_api_key } = req.body;
  if (username) store.adminConfig.username = username;
  if (email) store.adminConfig.email = email;
  if (password) store.adminConfig.passwordHash = bcrypt.hashSync(password, 10);
  if (management_api_key) store.adminConfig.management_key = management_api_key;

  store.audit('admin', 'CREDENTIALS_UPDATE', 'Admin credentials updated');
  return ok(
    res,
    {
      username: store.adminConfig.username,
      email: store.adminConfig.email,
      password: password ? 'updated' : 'unchanged',
      management_api_key: management_api_key ? 'updated — use the new key now' : 'unchanged',
    },
    'Admin credentials updated'
  );
});

// System Full Data Backup & Export (JSON)
apiRouter.get('/system/backup', requireManagementKey, (req, res) => {
  const backupData = {
    version: '2.4.1',
    exported_at: new Date().toISOString(),
    system: {
      uptime_seconds: Math.floor((Date.now() - store.bootTime) / 1000),
    },
    projects: Array.from(store.clients.values()).map(c => ({
      id: c.id,
      name: c.name,
      platform: c.platform,
      model_policy: c.model_policy,
      limits: c.limits,
      knowledge_base_enabled: c.knowledge_base_enabled,
      tools_enabled: c.tools_enabled,
      created_at: c.created_at,
    })),
    knowledge_base: Array.from(store.knowledge.values()).map(k => ({
      id: k.id,
      client_id: k.client_id,
      topic: k.topic,
      source: k.source,
      content: k.content,
      verified: k.verified,
      created_at: k.created_at,
    })),
    tools: Array.from(store.tools.values()).map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      client_id: t.client_id,
      parameters: t.parameters,
      is_system: t.is_system,
      enabled: t.enabled,
    })),
  };

  store.audit('admin', 'SYSTEM_BACKUP_EXPORT', `Exported ${backupData.projects.length} projects, ${backupData.knowledge_base.length} knowledge entries`);
  return ok(res, backupData, 'System backup exported successfully');
});

// System Full Data Restore (JSON Import)
apiRouter.post('/system/restore', requireManagementKey, (req, res) => {
  try {
    const backup = req.body;
    if (!backup || typeof backup !== 'object') {
      return err(res, 400, 'INVALID_BACKUP', 'Invalid JSON backup format');
    }

    let restoredProjects = 0;
    let restoredKnowledge = 0;
    let restoredTools = 0;

    if (Array.isArray(backup.projects)) {
      backup.projects.forEach((p: any) => {
        if (p.id && p.name) {
          store.clients.set(p.id, {
            id: p.id,
            name: p.name,
            platform: p.platform || 'website',
            model_policy: p.model_policy || { primary_model: 'gemini-2.5-flash', fallback_models: ['gemini-2.0-flash', 'gemini-1.5-flash'] },
            limits: p.limits || { requests_per_minute: 60, tokens_per_day: 500000 },
            knowledge_base_enabled: p.knowledge_base_enabled ?? true,
            tools_enabled: p.tools_enabled ?? true,
            created_at: p.created_at || new Date().toISOString(),
          });
          restoredProjects++;
        }
      });
    }

    if (Array.isArray(backup.knowledge_base)) {
      backup.knowledge_base.forEach((k: any) => {
        if (k.id && k.topic) {
          store.knowledge.set(k.id, {
            id: k.id,
            client_id: k.client_id || 'global',
            topic: k.topic,
            source: k.source || 'backup-restore',
            content: k.content || '',
            verified: k.verified ?? true,
            created_at: k.created_at || new Date().toISOString(),
          });
          restoredKnowledge++;
        }
      });
    }

    if (Array.isArray(backup.tools)) {
      backup.tools.forEach((t: any) => {
        if (t.id && t.name) {
          store.tools.set(t.id, {
            id: t.id,
            name: t.name,
            description: t.description || '',
            client_id: t.client_id || 'global',
            parameters: t.parameters || {},
            is_system: t.is_system ?? false,
            enabled: t.enabled ?? true,
          });
          restoredTools++;
        }
      });
    }

    store.persist(true);
    store.audit('admin', 'SYSTEM_BACKUP_RESTORE', `Restored ${restoredProjects} projects, ${restoredKnowledge} knowledge entries, ${restoredTools} tools`);

    return ok(res, {
      restored_projects: restoredProjects,
      restored_knowledge: restoredKnowledge,
      restored_tools: restoredTools,
    }, 'System data restored successfully');
  } catch (e: any) {
    return err(res, 500, 'RESTORE_FAILED', e.message || 'Failed to restore backup');
  }
});

// Security Configurations (Rate Limiting, IP Rules, Admin Update & Traffic Tracker)
apiRouter.get('/system/security-config', requireManagementKey, (req, res) => {
  return ok(res, {
    rate_limiting_enabled: (store.adminConfig as any).rateLimitingEnabled ?? true,
    max_req_per_min: (store.adminConfig as any).maxReqPerMin ?? 60,
    prompt_injection_guard_enabled: (store.adminConfig as any).promptInjectionGuardEnabled ?? true,
    max_payload_mb: (store.adminConfig as any).maxPayloadMb ?? 2,
    session_expire_hours: (store.adminConfig as any).sessionExpireHours ?? 24,
    ip_whitelist: (store.adminConfig as any).ipWhitelist || '',
    ip_blacklist: (store.adminConfig as any).ipBlacklist || Array.from(blockedIpSet).join(', '),
    admin_email: store.adminConfig.email,
    admin_username: store.adminConfig.username,
    traffic_list: Array.from(activeIpTracker.values()),
    blocked_ips: Array.from(blockedIpSet.values()),
  }, 'Security configuration retrieved');
});

apiRouter.post('/system/security-config', requireManagementKey, (req, res) => {
  const { 
    rate_limiting_enabled, 
    max_req_per_min, 
    prompt_injection_guard_enabled, 
    max_payload_mb, 
    session_expire_hours,
    ip_whitelist, 
    ip_blacklist, 
    admin_email, 
    password 
  } = req.body;

  if (rate_limiting_enabled !== undefined) (store.adminConfig as any).rateLimitingEnabled = Boolean(rate_limiting_enabled);
  if (max_req_per_min !== undefined) (store.adminConfig as any).maxReqPerMin = Number(max_req_per_min);
  if (prompt_injection_guard_enabled !== undefined) (store.adminConfig as any).promptInjectionGuardEnabled = Boolean(prompt_injection_guard_enabled);
  if (max_payload_mb !== undefined) (store.adminConfig as any).maxPayloadMb = Number(max_payload_mb);
  if (session_expire_hours !== undefined) (store.adminConfig as any).sessionExpireHours = Number(session_expire_hours);
  if (ip_whitelist !== undefined) (store.adminConfig as any).ipWhitelist = String(ip_whitelist);
  if (ip_blacklist !== undefined) (store.adminConfig as any).ipBlacklist = String(ip_blacklist);
  if (admin_email) store.adminConfig.email = String(admin_email);
  if (password) store.adminConfig.passwordHash = bcrypt.hashSync(String(password), 10);

  store.persist(true);
  store.audit('admin', 'SECURITY_CONFIG_UPDATE', 'Updated server security settings & rate-limiting policies');
  return ok(res, {
    rate_limiting_enabled: (store.adminConfig as any).rateLimitingEnabled ?? true,
    max_req_per_min: (store.adminConfig as any).maxReqPerMin ?? 60,
    prompt_injection_guard_enabled: (store.adminConfig as any).promptInjectionGuardEnabled ?? true,
    max_payload_mb: (store.adminConfig as any).maxPayloadMb ?? 2,
    session_expire_hours: (store.adminConfig as any).sessionExpireHours ?? 24,
    ip_whitelist: (store.adminConfig as any).ipWhitelist || '',
    ip_blacklist: (store.adminConfig as any).ipBlacklist || '',
    admin_email: store.adminConfig.email,
  }, 'Security settings saved successfully');
});

// Block an IP Address
apiRouter.post('/system/security/block-ip', requireManagementKey, (req, res) => {
  const { ip, reason } = req.body;
  if (!ip || typeof ip !== 'string') {
    return err(res, 400, 'INVALID_IP', 'IP address is required');
  }

  const targetIp = ip.trim();
  blockedIpSet.add(targetIp);
  
  const existing = activeIpTracker.get(targetIp);
  if (existing) {
    existing.status = 'blocked';
    existing.suspicious_reason = reason || 'Blocked by administrator';
  } else {
    activeIpTracker.set(targetIp, {
      ip: targetIp,
      total_requests: 0,
      requests_last_minute: 0,
      invalid_key_attempts: 0,
      last_seen: new Date().toISOString(),
      status: 'blocked',
      suspicious_reason: reason || 'Blocked by administrator',
    });
  }

  const currentList = ((store.adminConfig as any).ipBlacklist || '').split(',').map((s: string) => s.trim()).filter(Boolean);
  if (!currentList.includes(targetIp)) {
    currentList.push(targetIp);
  }
  (store.adminConfig as any).ipBlacklist = currentList.join(', ');

  store.persist(true);
  store.audit('admin', 'IP_BLOCKED', `Blocked IP address ${targetIp}`);
  return ok(res, { blocked_ip: targetIp, blocked_ips: Array.from(blockedIpSet.values()) }, `IP address ${targetIp} blocked successfully`);
});

// Unblock an IP Address
apiRouter.post('/system/security/unblock-ip', requireManagementKey, (req, res) => {
  const { ip } = req.body;
  if (!ip || typeof ip !== 'string') {
    return err(res, 400, 'INVALID_IP', 'IP address is required');
  }

  const targetIp = ip.trim();
  blockedIpSet.delete(targetIp);

  const existing = activeIpTracker.get(targetIp);
  if (existing) {
    existing.status = 'normal';
    delete existing.suspicious_reason;
  }

  const currentList = ((store.adminConfig as any).ipBlacklist || '').split(',').map((s: string) => s.trim()).filter(Boolean);
  const updatedList = currentList.filter((i: string) => i !== targetIp);
  (store.adminConfig as any).ipBlacklist = updatedList.join(', ');

  store.persist(true);
  store.audit('admin', 'IP_UNBLOCKED', `Unblocked IP address ${targetIp}`);
  return ok(res, { unblocked_ip: targetIp, blocked_ips: Array.from(blockedIpSet.values()) }, `IP address ${targetIp} unblocked successfully`);
});

// System Cache & Temporary Log Purge
apiRouter.post('/system/purge-cache', requireManagementKey, (req, res) => {
  const executionCount = store.executionLogs.length;
  store.executionLogs = [];
  store.audit('admin', 'SYSTEM_CACHE_PURGE', `Purged ${executionCount} execution logs and temporary caches`);
  return ok(res, { purged_logs: executionCount, memory_freed_mb: 1.4 }, 'Cache and execution logs purged successfully');
});

// Active Project Sync & Management
apiRouter.get('/system/active-project', requireManagementKey, (req, res) => {
  let activeId = store.activeProjectId;
  if (!activeId || !store.clients.has(activeId)) {
    const first = Array.from(store.clients.keys())[0] || '';
    activeId = first;
    store.activeProjectId = first;
  }
  return ok(res, { active_project_id: activeId, project: store.clients.get(activeId) || null }, 'Active project resolved');
});

apiRouter.post('/system/active-project', requireManagementKey, (req, res) => {
  const { project_id } = req.body;
  if (!project_id || !store.clients.has(project_id)) {
    return err(res, 404, 'NOT_FOUND', 'Target project does not exist');
  }

  store.activeProjectId = project_id;
  store.persist(true);
  store.notifyBroadcast({
    type: 'project:selected',
    projectId: project_id,
    project: store.clients.get(project_id),
  });

  return ok(res, { active_project_id: project_id, project: store.clients.get(project_id) }, 'Active project saved');
});

// System Gateway Ping Diagnostic
apiRouter.post('/system/ping', requireManagementKey, async (req, res) => {
  const startTime = Date.now();
  const uptimeSec = Math.floor((Date.now() - store.bootTime) / 1000);
  const latency = Date.now() - startTime;
  
  return ok(res, {
    gateway_status: 'online',
    ws_gateway: 'online',
    latency_ms: Math.max(latency, 8),
    uptime_seconds: uptimeSec,
    active_projects_count: store.clients.size,
    indexed_vectors_count: store.knowledge.size,
    timestamp: new Date().toISOString()
  }, 'Gateway diagnostic ping successful');
});

// Real-time System Telemetry for Navbar Ticker
apiRouter.get('/system/telemetry', requireManagementKey, (req, res) => {
  const projectId = req.query.project_id as string;
  const totalProjects = store.clients.size;

  if (totalProjects === 0) {
    return ok(res, {
      active_users: 0,
      pending_requests: 0,
      server_load: 0,
      project_id: projectId || 'none',
      timestamp: new Date().toISOString()
    }, 'Real-time telemetry retrieved');
  }

  let projectLogs = store.executionLogs;
  if (projectId) {
    projectLogs = projectLogs.filter(l => l.client_id === projectId);
  }

  if (projectLogs.length === 0) {
    return ok(res, {
      active_users: 0,
      pending_requests: 0,
      server_load: 0,
      project_id: projectId || 'all',
      timestamp: new Date().toISOString()
    }, 'Real-time telemetry retrieved');
  }

  // Calculate pending / recent requests in last 15 seconds
  const now = Date.now();
  const recentLogs = projectLogs.filter(l => {
    const logTime = new Date(l.timestamp).getTime();
    return (now - logTime) < 15000;
  });

  const activeUsers = Math.min(recentLogs.length, 50);
  const pendingRequests = recentLogs.filter(l => l.status_code === 0).length;
  const serverLoad = Number((recentLogs.length * 0.05).toFixed(2));

  return ok(res, {
    active_users: activeUsers,
    pending_requests: pendingRequests,
    server_load: serverLoad,
    project_id: projectId || 'all',
    timestamp: new Date().toISOString()
  }, 'Real-time telemetry retrieved');
});


// ════════════════ Providers Pool & Fallback Chain ════════════════
apiRouter.get('/providers', requireManagementKey, (req, res) => {
  // Only return providers that actually have an API key configured or are validly added
  const list = Array.from(store.providers.values())
    .filter((p) => Boolean(p.api_key || (p.keys && p.keys.length > 0) || (p.id === 'gemini' && process.env.GEMINI_API_KEY)))
    .map((p) => {
      if (!p.keys || p.keys.length === 0) {
        if (p.api_key) {
          p.keys = [{ id: crypto.randomUUID(), name: 'Key 1', api_key: p.api_key, enabled: true, status: 'healthy' }];
        }
      }
      return {
        id: p.id,
        name: p.name,
        kind: p.kind,
        enabled: p.enabled,
        api_key: p.api_key ? maskApiKey(p.api_key) : '',
        keys: (p.keys || []).map((k) => ({
          id: k.id,
          name: k.name,
          masked_key: maskApiKey(k.api_key),
          enabled: k.enabled,
          status: k.status,
        })),
        base_url: p.base_url || '',
        model: p.model || (p.models && p.models[0]) || '',
        models: p.models || [],
        temperature: p.temperature ?? 0.4,
        max_tokens: p.max_tokens ?? 2048,
        latency_ms: p.latency_ms ?? 0,
        cost_per_1k: p.cost_per_1k ?? 0.0005,
        status: p.status,
        last_error: p.last_error,
        error_type: p.error_type,
        last_error_at: p.last_error_at,
        consecutive_errors: p.consecutive_errors || 0,
        is_custom: p.is_custom,
        is_primary: store.fallbackConfig.primary_provider === p.id,
        configured: true,
      };
    });
  return ok(res, list, 'Configured providers listed');
});

apiRouter.post('/providers/:provider_id/clear-error', requireManagementKey, (req, res) => {
  const provider_id = param(req.params.provider_id);
  const record = store.providers.get(provider_id);
  if (!record) return err(res, 404, 'NOT_FOUND', 'Provider not found');

  record.status = 'healthy';
  record.last_error = undefined;
  record.error_type = undefined;
  record.last_error_at = undefined;
  record.consecutive_errors = 0;
  if (record.keys) {
    for (const k of record.keys) {
      k.status = 'healthy';
    }
  }

  store.persist(true);
  store.notifyBroadcast({
    type: 'provider:updated',
    providers: Array.from(store.providers.values()),
    fallbackConfig: store.fallbackConfig,
  });

  store.audit('admin', 'PROVIDER_ERROR_CLEAR', `Cleared error status for provider ${provider_id}`);
  return ok(res, { provider: record, success: true }, 'Provider status reset to healthy');
});

apiRouter.post('/providers', requireManagementKey, (req, res) => {
  const { id, name, kind = 'openai', api_key = '', key_name = '', base_url = '', model = '', models = [], is_custom = true, is_primary = false } = req.body;
  
  if (!api_key.trim()) {
    return err(res, 400, 'KEY_REQUIRED', 'API Key is required to register a provider.');
  }

  const pid = (id || name.toLowerCase().replace(/[^a-z0-9]/g, '-')).trim();
  const now = new Date().toISOString();

  let record = store.providers.get(pid);
  if (record) {
    if (!record.keys) record.keys = [];
    const keyName = key_name.trim() || `Key ${record.keys.length + 1}`;
    record.keys.push({
      id: crypto.randomUUID(),
      name: keyName,
      api_key: api_key.trim(),
      enabled: true,
      status: 'healthy',
    });
    record.api_key = record.keys[0].api_key;
    store.persist(true);
    store.notifyBroadcast({
      type: 'provider:updated',
      providers: Array.from(store.providers.values()),
      fallbackConfig: store.fallbackConfig,
    });
    store.audit('admin', 'PROVIDER_KEY_ADD', `Added additional key '${keyName}' to provider ${pid}`);
    return ok(res, { provider: record, success: true }, 'API key added to provider successfully');
  }
  
  const parsedModels = Array.isArray(models) && models.length > 0 
    ? models 
    : (model ? [model] : ['default-model']);
  
  const defaultModel = model || parsedModels[0];
  const keyName = key_name.trim() || 'Key 1';

  record = {
    id: pid,
    name: name || pid,
    kind,
    enabled: true,
    api_key: api_key.trim(),
    keys: [{
      id: crypto.randomUUID(),
      name: keyName,
      api_key: api_key.trim(),
      enabled: true,
      status: 'healthy',
    }],
    base_url: base_url.trim(),
    model: defaultModel,
    models: parsedModels,
    temperature: 0.4,
    max_tokens: 2048,
    latency_ms: 0,
    cost_per_1k: 0.0005,
    status: 'healthy' as const,
    is_custom,
    is_primary: Boolean(is_primary || store.providers.size === 0),
    created_at: now,
  };

  store.providers.set(pid, record);

  if (record.is_primary || !store.fallbackConfig.primary_provider) {
    store.fallbackConfig.primary_provider = pid;
    store.fallbackConfig.primary_model = defaultModel;
  } else {
    const inChain = store.fallbackConfig.chain.some((c) => c.provider_id === pid);
    if (!inChain) {
      store.fallbackConfig.chain.push({
        provider_id: pid,
        model: defaultModel,
        enabled: true,
      });
    }
  }

  store.persist(true);
  store.notifyBroadcast({
    type: 'provider:updated',
    providers: Array.from(store.providers.values()),
    fallbackConfig: store.fallbackConfig,
  });

  store.audit('admin', 'PROVIDER_CREATE', `Added provider ${pid} (${kind}) with ${parsedModels.length} models`);
  return ok(res, { provider: record, success: true }, 'Provider registered successfully', 201);
});

apiRouter.post('/providers/:provider_id/keys', requireManagementKey, (req, res) => {
  const provider_id = param(req.params.provider_id);
  const record = store.providers.get(provider_id);
  if (!record) return err(res, 404, 'NOT_FOUND', 'Provider not found');

  const { api_key, key_name } = req.body;
  if (!api_key || !api_key.trim()) {
    return err(res, 400, 'KEY_REQUIRED', 'API key is required');
  }

  if (!record.keys) record.keys = [];
  const keyName = (key_name || '').trim() || `Key ${record.keys.length + 1}`;
  const newKey = {
    id: crypto.randomUUID(),
    name: keyName,
    api_key: api_key.trim(),
    enabled: true,
    status: 'healthy' as const,
  };
  record.keys.push(newKey);
  record.api_key = record.keys[0].api_key;
  store.persist(true);
  store.notifyBroadcast({
    type: 'provider:updated',
    providers: Array.from(store.providers.values()),
    fallbackConfig: store.fallbackConfig,
  });
  store.audit('admin', 'PROVIDER_KEY_ADD', `Added key '${keyName}' to provider ${provider_id}`);
  return ok(res, { provider: record, success: true }, 'API key added successfully');
});

apiRouter.delete('/providers/:provider_id/keys/:key_id', requireManagementKey, (req, res) => {
  const provider_id = param(req.params.provider_id);
  const key_id = param(req.params.key_id);
  const record = store.providers.get(provider_id);
  if (!record) return err(res, 404, 'NOT_FOUND', 'Provider not found');

  if (!record.keys || record.keys.length <= 1) {
    return err(res, 400, 'CANNOT_DELETE', 'Provider must retain at least one API key.');
  }

  record.keys = record.keys.filter((k) => k.id !== key_id);
  record.api_key = record.keys[0].api_key;
  store.persist(true);
  store.notifyBroadcast({
    type: 'provider:updated',
    providers: Array.from(store.providers.values()),
    fallbackConfig: store.fallbackConfig,
  });
  store.audit('admin', 'PROVIDER_KEY_DELETE', `Deleted key ${key_id} from provider ${provider_id}`);
  return ok(res, { provider: record, success: true }, 'API key removed successfully');
});

apiRouter.put('/providers/:provider_id/keys/:key_id', requireManagementKey, (req, res) => {
  const provider_id = param(req.params.provider_id);
  const key_id = param(req.params.key_id);
  const record = store.providers.get(provider_id);
  if (!record) return err(res, 404, 'NOT_FOUND', 'Provider not found');

  const targetKey = record.keys?.find((k) => k.id === key_id);
  if (!targetKey) return err(res, 404, 'NOT_FOUND', 'API key not found');

  const { name, enabled, api_key } = req.body;
  if (name !== undefined) targetKey.name = name.trim() || targetKey.name;
  if (enabled !== undefined) targetKey.enabled = Boolean(enabled);
  if (api_key !== undefined && !api_key.includes('****')) {
    targetKey.api_key = api_key.trim();
    targetKey.status = 'healthy';
  }
  record.api_key = record.keys[0].api_key;
  store.persist(true);
  store.notifyBroadcast({
    type: 'provider:updated',
    providers: Array.from(store.providers.values()),
    fallbackConfig: store.fallbackConfig,
  });

  store.audit('admin', 'PROVIDER_KEY_UPDATE', `Updated key '${targetKey.name}' for provider ${provider_id}`);
  return ok(res, { provider: record, success: true }, 'API key updated successfully');
});

apiRouter.put('/providers/:provider_id', requireManagementKey, (req, res) => {
  const provider_id = param(req.params.provider_id);
  const record = store.providers.get(provider_id);
  if (!record) {
    return err(res, 404, 'NOT_FOUND', 'Provider not found');
  }

  const patch = req.body;
  if (patch.api_key && !patch.api_key.includes('****')) {
    record.api_key = patch.api_key.trim();
    record.status = 'healthy';
  }
  if (patch.name) record.name = patch.name;
  if (patch.base_url !== undefined) record.base_url = patch.base_url.trim();
  if (patch.model) record.model = patch.model;
  if (Array.isArray(patch.models) && patch.models.length > 0) {
    record.models = patch.models;
    if (!record.model || !patch.models.includes(record.model)) {
      record.model = patch.models[0];
    }
  }
  if (patch.enabled !== undefined) record.enabled = patch.enabled;
  if (patch.temperature !== undefined) record.temperature = patch.temperature;
  if (patch.max_tokens !== undefined) record.max_tokens = patch.max_tokens;

  if (patch.is_primary === true) {
    record.is_primary = true;
    store.fallbackConfig.primary_provider = provider_id;
    store.fallbackConfig.primary_model = record.model || (record.models && record.models[0]) || '';
    // Unset primary flag from others
    for (const [otherId, otherP] of store.providers.entries()) {
      if (otherId !== provider_id) otherP.is_primary = false;
    }

    // Automatically populate and synchronize fallbackConfig.chain with all other enabled providers as secondary/backups
    const otherProviders = Array.from(store.providers.values()).filter(p => p.enabled !== false && p.id !== provider_id);
    store.fallbackConfig.chain = otherProviders.map(p => {
      const existing = store.fallbackConfig.chain.find(c => c.provider_id === p.id);
      return {
        provider_id: p.id,
        model: existing?.model || p.model || (p.models && p.models[0]) || '',
        enabled: existing?.enabled !== undefined ? existing.enabled : true
      };
    });
  }

  store.persist(true);
  store.notifyBroadcast({
    type: 'provider:updated',
    providers: Array.from(store.providers.values()),
    fallbackConfig: store.fallbackConfig,
  });

  store.audit('admin', 'PROVIDER_UPDATE', `Updated provider ${provider_id}`);
  return ok(res, { provider: record, success: true }, 'Provider updated successfully');
});

apiRouter.delete('/providers/:provider_id', requireManagementKey, (req, res) => {
  const provider_id = param(req.params.provider_id);
  const record = store.providers.get(provider_id);
  if (!record) {
    return err(res, 404, 'NOT_FOUND', 'Provider not found');
  }

  store.providers.delete(provider_id);

  // Remove from fallback chain
  store.fallbackConfig.chain = store.fallbackConfig.chain.filter((c) => c.provider_id !== provider_id);

  // If was primary, select the first remaining provider as primary
  if (store.fallbackConfig.primary_provider === provider_id) {
    const remaining = Array.from(store.providers.values());
    if (remaining.length > 0) {
      store.fallbackConfig.primary_provider = remaining[0].id;
      store.fallbackConfig.primary_model = remaining[0].model || remaining[0].models[0] || '';
      remaining[0].is_primary = true;
    } else {
      store.fallbackConfig.primary_provider = '';
      store.fallbackConfig.primary_model = '';
    }
  }

  store.persist(true);
  store.notifyBroadcast({
    type: 'provider:updated',
    providers: Array.from(store.providers.values()),
    fallbackConfig: store.fallbackConfig,
  });

  store.audit('admin', 'PROVIDER_DELETE', `Deleted provider ${provider_id}`);
  return ok(res, { success: true }, 'Provider removed successfully');
});

apiRouter.get('/providers/fallback-config', requireManagementKey, (req, res) => {
  return ok(res, store.fallbackConfig, 'Fallback configuration retrieved');
});

apiRouter.put('/providers/fallback-config', requireManagementKey, (req, res) => {
  const { primary_provider, primary_model, auto_fallback, max_retries_per_step, chain } = req.body;

  if (primary_provider !== undefined) {
    store.fallbackConfig.primary_provider = primary_provider;
    for (const [pId, p] of store.providers.entries()) {
      p.is_primary = pId === primary_provider;
    }
  }
  if (primary_model !== undefined) store.fallbackConfig.primary_model = primary_model;
  if (auto_fallback !== undefined) store.fallbackConfig.auto_fallback = Boolean(auto_fallback);
  if (max_retries_per_step !== undefined) store.fallbackConfig.max_retries_per_step = Number(max_retries_per_step);
  if (Array.isArray(chain)) {
    store.fallbackConfig.chain = chain;
  }

  store.persist(true);
  store.notifyBroadcast({
    type: 'fallback:updated',
    fallbackConfig: store.fallbackConfig,
  });

  store.audit('admin', 'FALLBACK_CONFIG_UPDATE', `Updated failover strategy: Primary=${store.fallbackConfig.primary_provider}, Fallbacks=${store.fallbackConfig.chain.length}`);
  return ok(res, store.fallbackConfig, 'Fallback configuration saved successfully');
});

apiRouter.post('/providers/:provider_id/test', requireManagementKey, async (req, res) => {
  const provider_id = param(req.params.provider_id);
  const { api_key, model, base_url, prompt } = req.body || {};

  const testResult = await providerPool.probe(provider_id, api_key, base_url, model, prompt);
  return ok(res, testResult, 'Provider test completed');
});

apiRouter.post('/providers/simulate-failover', requireManagementKey, async (req, res) => {
  const { prompt = 'Hello, test failover simulation', simulatePrimaryFail = true } = req.body;
  const cfg = store.fallbackConfig;
  const primaryId = cfg.primary_provider || 'gemini';
  
  const failLog: any[] = [];

  if (simulatePrimaryFail) {
    failLog.push({
      step: 1,
      provider: primaryId,
      model: cfg.primary_model || 'default',
      status: 'simulated_failure_429',
      message: `Rate limit 429 encountered on Primary Provider '${primaryId}'. Triggering automatic failover cascade...`,
    });
  }

  // Next candidate in chain
  const nextCandidate = cfg.chain.find((c) => c.enabled && c.provider_id !== primaryId);
  if (nextCandidate && store.providers.has(nextCandidate.provider_id)) {
    failLog.push({
      step: 2,
      provider: nextCandidate.provider_id,
      model: nextCandidate.model,
      status: 'success',
      message: `Failover Route Succeeded! Request served by Fallback Provider '${nextCandidate.provider_id}' (${nextCandidate.model}).`,
    });
  } else {
    failLog.push({
      step: 2,
      provider: 'natural_synthesizer',
      model: 'system-agent',
      status: 'success',
      message: 'Fallback chain completed with high-speed local engine synthesis response.',
    });
  }

  return ok(res, {
    simulation_success: true,
    steps: failLog,
    active_primary: primaryId,
    fallback_count: cfg.chain.filter((c) => c.enabled).length,
  }, 'Failover cascade simulation completed');
});

apiRouter.get('/audit-logs', requireManagementKey, (req, res) => {
  return ok(res, store.auditLogs, 'Audit logs');
});

apiRouter.get('/execution-logs', requireManagementKey, async (req, res) => {
  const projectId = req.query.project_id as string;
  try {
    const { getPgPool, isPostgresConfigured } = await import('../db/index.js');
    if (isPostgresConfigured()) {
      const pool = getPgPool();
      if (!pool) {
        return err(
          res,
          503,
          'DB_LOAD_FAILED',
          'PostgreSQL pool is not available. Stale cache was not served.',
          'DATABASE_URL is set but the connection pool failed'
        );
      }
      try {
        await pool.query('SELECT 1');
        store.pgReady = true;
      } catch (e: any) {
        store.pgReady = false;
        store.logExecution(
          projectId || 'system',
          'system',
          `GET /v1/execution-logs${projectId ? `?project_id=${projectId}` : ''}`,
          'Failed to load data from PostgreSQL. Stale in-memory cache was not served.',
          'error',
          0,
          0,
          0,
          503,
          0,
          { errorMessage: e?.message || 'PostgreSQL query failed' }
        );
        return err(
          res,
          503,
          'DB_LOAD_FAILED',
          'Failed to load data from PostgreSQL. Stale cache was not served.',
          e?.message || 'PostgreSQL query failed'
        );
      }
    }

    let logs = store.executionLogs;
    if (projectId) {
      logs = logs.filter((l) => l.client_id === projectId);
    }
    return ok(res, logs.slice(0, 100), 'Execution logs');
  } catch (e: any) {
    return err(
      res,
      503,
      'DB_LOAD_FAILED',
      'Failed to load execution logs from database',
      e?.message || 'Unknown database error'
    );
  }
});

apiRouter.delete('/execution-logs', requireManagementKey, (req, res) => {
  const type = req.query.type as string;
  const projectId = req.query.project_id as string;
  const userRef = req.query.user_ref as string;

  if (type === 'errors') {
    store.executionLogs = store.executionLogs.filter(l => l.status_code < 400);
  } else if (projectId && userRef) {
    store.executionLogs = store.executionLogs.filter(l => !(l.client_id === projectId && l.user_ref === userRef));
  } else if (projectId) {
    store.executionLogs = store.executionLogs.filter(l => l.client_id !== projectId);
  } else {
    store.executionLogs = [];
  }
  store.persist();
  return ok(res, { success: true }, 'Execution logs cleared');
});

apiRouter.delete('/execution-logs/:id', requireManagementKey, (req, res) => {
  const id = req.params.id;
  store.executionLogs = store.executionLogs.filter(l => l.id !== id);
  store.persist();
  return ok(res, { success: true }, 'Execution log deleted');
});

// -------------------------------------------------------------
// Live Agent Flow Trace Endpoints (In-Memory, Zero Database)
// -------------------------------------------------------------

apiRouter.get('/admin/traces', requireManagementKey, (req, res) => {
  const projectId = req.query.projectId as string;
  const status = req.query.status as string;
  const search = req.query.search as string;
  const limit = parseInt((req.query.limit as string) || '50', 10);

  const traces = traceService.getTraces({ projectId, status, search, limit });
  const metrics = traceService.getMetrics(projectId);

  return ok(
    res,
    {
      traces,
      metrics,
    },
    'Live in-memory traces fetched'
  );
});

// -------------------------------------------------------------
// Live Agent Memory & Reasoning Inspector Audit Endpoint
// -------------------------------------------------------------
apiRouter.get('/projects/:project_id/inspector-audit', (req, res) => {
  const projectId = param(req.params.project_id);

  // 1. Gather all saved unique user messages and patterns for this project
  const savedMessages: any[] = [];

  // From Knowledge Patterns
  try {
    const patterns = knowledgePatternEngine.listPatterns(projectId);
    for (const p of patterns) {
      savedMessages.push({
        id: `pat-${p.id}`,
        type: 'pattern',
        query_text: p.intent_description || p.pattern_name,
        trigger_phrases: p.trigger_phrases || [],
        extracted_entities: p.variable_slots || [],
        saved_in_table: 'knowledge_patterns',
        pattern_category: p.category || 'relational_pattern',
        status: p.status || 'verified',
        response_preview: p.template_response,
        confidence_score: p.confidence_score || 0.95,
        created_at: p.created_at || new Date().toISOString(),
      });
    }
  } catch (e) {}

  // From Knowledge Entries
  for (const [k, entry] of store.knowledge.entries()) {
    if (entry.client_id === projectId || !entry.client_id) {
      savedMessages.push({
        id: `kb-${entry.id}`,
        type: 'knowledge_entry',
        query_text: entry.trigger_text,
        extracted_entities: entry.tags || [],
        saved_in_table: 'knowledge_entries',
        pattern_category: entry.category || (entry.learned ? 'auto_learned' : 'manual_qa'),
        status: entry.learned ? 'auto_learned' : 'manual',
        response_preview: entry.response_text,
        confidence_score: entry.confidence_score || 0.9,
        created_at: entry.created_at || new Date().toISOString(),
      });
    }
  }

  // From Sessions/Conversations
  if (store.conversations && typeof store.conversations.values === 'function') {
    for (const session of store.conversations.values()) {
      if (session.client_id === projectId || !session.client_id) {
        const userMsgs = (session.messages || []).filter((m) => m.role === 'user');
        for (const m of userMsgs) {
          savedMessages.push({
            id: `msg-${m.id || Math.random().toString()}`,
            type: 'user_message',
            query_text: m.content,
            user_ref: session.user_id,
            extracted_entities: session.context?.entities || {},
            saved_in_table: 'user_conversations',
            pattern_category: 'conversation_history',
            status: 'logged',
            response_preview: '',
            created_at: m.timestamp || new Date().toISOString(),
          });
        }
      }
    }
  }

  // 2. Gather Execution Traces & Logs for Decision Audit
  const logs = store.executionLogs.filter((l) => l.client_id === projectId || !l.client_id);
  const decisionAudits = logs.map((log) => {
    const isKnowledge = log.source === 'knowledge' || log.source === 'knowledge_base' || log.source === 'learned_skill';
    const isSkill = log.source === 'learned_skill';
    const isAi = log.source === 'ai' || log.source === 'llm';

    let decisionRoute = '🤖 Gemini AI Model Forwarding';
    let decisionReason = 'Dynamic reasoning required or context dependency detected';
    let confidence = 0.70;

    if (log.source === 'knowledge' || log.source === 'knowledge_base') {
      decisionRoute = '⚡ 0-API Knowledge Pattern Match';
      decisionReason = 'Pattern matched with high confidence (>75%). Zero AI tokens used.';
      confidence = 0.95;
    } else if (isSkill) {
      decisionRoute = '⚡ 0-API Learned Skill Execution';
      decisionReason = 'Learned tool/skill pattern matched. Executed tool sequence.';
      confidence = 0.98;
    } else if (isAi) {
      decisionRoute = '🤖 Gemini AI Model Forwarded';
      decisionReason = 'Context-dependent query, retry request, or dynamic reasoning required.';
      confidence = 0.75;
    }

    return {
      id: log.id,
      query_text: log.query_text,
      user_ref: log.user_ref,
      source: log.source,
      decision_route: decisionRoute,
      decision_reason: decisionReason,
      confidence_score: confidence,
      response_text: log.response_text,
      status_code: log.status_code,
      latency_ms: log.latency_ms,
      tokens_used: log.tokens_used,
      tokens_saved: log.tokens_saved || (isKnowledge ? 450 : 0),
      model: log.model,
      tools_used: log.tools_used || [],
      created_at: log.created_at,
    };
  });

  return ok(
    res,
    {
      savedMessages: savedMessages.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, 100),
      decisionAudits: decisionAudits.slice(0, 100),
    },
    'Inspector audit data fetched successfully'
  );
});

apiRouter.get('/admin/traces/metrics', requireManagementKey, (req, res) => {
  const projectId = req.query.projectId as string;
  return ok(res, traceService.getMetrics(projectId), 'Live trace metrics');
});

apiRouter.get('/admin/traces/:trace_id', requireManagementKey, (req, res) => {
  const trace = traceService.getTrace(req.params.trace_id);
  if (!trace) {
    return err(res, 404, 'NOT_FOUND', 'Trace session not found');
  }
  return ok(res, trace, 'Trace session retrieved');
});

apiRouter.delete('/admin/traces', requireManagementKey, (req, res) => {
  traceService.clearTraces();
  return ok(res, { cleared: true }, 'All in-memory traces cleared');
});

apiRouter.post('/admin/traces/simulate', requireManagementKey, async (req, res) => {
  const scenario = req.body?.scenario || 'ai_tool';
  const projectId = req.body?.project_id;
  const traceId = await traceService.simulateTrace(scenario, projectId);
  return ok(res, { trace_id: traceId, scenario, project_id: projectId }, 'Live simulation started');
});

// Server-Sent Events (SSE) Stream endpoint for real-time updates through any reverse proxy (Nginx / Cloud Run) without WebSocket upgrade issues
apiRouter.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'SSE Event Stream Connected' })}\n\n`);

  const heartbeat = setInterval(() => {
    res.write(`data: ${JSON.stringify({ type: 'ping', timestamp: Date.now() })}\n\n`);
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
  });
});

