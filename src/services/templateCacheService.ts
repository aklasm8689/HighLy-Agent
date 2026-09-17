import crypto from 'crypto';
import { getPgPool } from '../db/index';

// Simple in-memory hot cache for ultra-fast, zero-latency template response lookup
const localTemplateCache = new Map<string, string>();

/**
 * Look up a cached response in local memory or the PostgreSQL database
 */
export async function getCachedResponse(projectId: string, userMessage: string, language: string): Promise<string | null> {
  const cleanMessage = userMessage.trim();
  if (!cleanMessage) return null;

  const messageHash = crypto.createHash('sha256').update(cleanMessage).digest('hex');
  const cacheKey = `${projectId}:${messageHash}:${language || 'all'}`;

  // 1. Check in-memory cache
  if (localTemplateCache.has(cacheKey)) {
    const cachedResponse = localTemplateCache.get(cacheKey)!;
    // Log usage count increment in PostgreSQL in the background
    incrementCacheUsage(projectId, messageHash).catch(() => {});
    return cachedResponse;
  }

  // 2. Check PostgreSQL database cache
  const pool = getPgPool();
  if (!pool) return null;

  try {
    const res = await pool.query(
      `SELECT id, response 
       FROM cached_responses 
       WHERE project_id = $1 AND message_hash = $2 AND (language = $3 OR language IS NULL OR $3 = '')`,
      [projectId, messageHash, language || '']
    );

    if (res.rows.length > 0) {
      const responseText = res.rows[0].response;
      // Store in hot memory
      localTemplateCache.set(cacheKey, responseText);
      // Increment usage
      incrementCacheUsage(projectId, messageHash).catch(() => {});
      return responseText;
    }
  } catch (e: any) {
    console.warn('[TemplateCache] Select error:', e.message);
  }

  return null;
}

/**
 * Increment the usage counter of a cached response in the background
 */
async function incrementCacheUsage(projectId: string, messageHash: string): Promise<void> {
  const pool = getPgPool();
  if (!pool) return;
  try {
    await pool.query(
      `UPDATE cached_responses 
       SET usage_count = usage_count + 1 
       WHERE project_id = $1 AND message_hash = $2`,
      [projectId, messageHash]
    );
  } catch (e: any) {
    console.warn('[TemplateCache] Failed to increment usage count:', e.message);
  }
}

/**
 * Store a newly generated response in the cache
 */
export async function saveCachedResponse(projectId: string, userMessage: string, responseText: string, language: string): Promise<void> {
  const cleanMessage = userMessage.trim();
  const cleanResponse = responseText.trim();
  if (!cleanMessage || !cleanResponse) return;

  const messageHash = crypto.createHash('sha256').update(cleanMessage).digest('hex');
  const cacheKey = `${projectId}:${messageHash}:${language || 'all'}`;

  // Store in hot memory
  localTemplateCache.set(cacheKey, cleanResponse);

  // Store in PostgreSQL database cache
  const pool = getPgPool();
  if (!pool) return;

  try {
    await pool.query(
      `INSERT INTO cached_responses (project_id, message_hash, trigger_text, response, language, usage_count, created_at)
       VALUES ($1, $2, $3, $4, $5, 1, NOW())
       ON CONFLICT (project_id, message_hash) 
       DO UPDATE SET response = EXCLUDED.response, trigger_text = EXCLUDED.trigger_text, language = EXCLUDED.language, usage_count = cached_responses.usage_count + 1`,
      [projectId, messageHash, cleanMessage, cleanResponse, language || null]
    );
  } catch (e: any) {
    console.warn('[TemplateCache] Save error:', e.message);
  }
}

/**
 * Get all cached responses for a project
 */
export async function getProjectCachedResponses(projectId: string): Promise<any[]> {
  const pool = getPgPool();
  if (!pool) return [];

  try {
    const res = await pool.query(
      `SELECT id, message_hash, trigger_text, response, language, usage_count, created_at
       FROM cached_responses
       WHERE project_id = $1
       ORDER BY created_at DESC`,
      [projectId]
    );
    return res.rows;
  } catch (err: any) {
    console.warn('[TemplateCache] getProjectCachedResponses error:', err.message);
    return [];
  }
}

/**
 * Delete a specific cached response and invalidate local in-memory cache
 */
export async function deleteCachedResponseById(projectId: string, id: string): Promise<boolean> {
  const pool = getPgPool();
  if (!pool) return false;

  try {
    // 1. Fetch details to invalidate local cache
    const checkRes = await pool.query(
      `SELECT message_hash, language FROM cached_responses WHERE id = $1 AND project_id = $2`,
      [id, projectId]
    );

    if (checkRes.rows.length === 0) return false;
    const { message_hash, language } = checkRes.rows[0];

    // 2. Delete from DB
    await pool.query(
      `DELETE FROM cached_responses WHERE id = $1 AND project_id = $2`,
      [id, projectId]
    );

    // 3. Clear from local in-memory cache
    const cacheKey = `${projectId}:${message_hash}:${language || 'all'}`;
    localTemplateCache.delete(cacheKey);
    // Invalidate standard generic language key too to be sure
    localTemplateCache.delete(`${projectId}:${message_hash}:all`);

    return true;
  } catch (err: any) {
    console.warn('[TemplateCache] deleteCachedResponseById error:', err.message);
    return false;
  }
}

/**
 * Update a specific cached response and sync local in-memory cache
 */
export async function updateCachedResponseById(projectId: string, id: string, responseText: string): Promise<boolean> {
  const cleanResponse = responseText.trim();
  if (!cleanResponse) return false;

  const pool = getPgPool();
  if (!pool) return false;

  try {
    // 1. Fetch details
    const checkRes = await pool.query(
      `SELECT message_hash, language FROM cached_responses WHERE id = $1 AND project_id = $2`,
      [id, projectId]
    );

    if (checkRes.rows.length === 0) return false;
    const { message_hash, language } = checkRes.rows[0];

    // 2. Update DB
    await pool.query(
      `UPDATE cached_responses 
       SET response = $1, created_at = NOW() 
       WHERE id = $2 AND project_id = $3`,
      [cleanResponse, id, projectId]
    );

    // 3. Sync local hot memory cache
    const cacheKey = `${projectId}:${message_hash}:${language || 'all'}`;
    localTemplateCache.set(cacheKey, cleanResponse);

    return true;
  } catch (err: any) {
    console.warn('[TemplateCache] updateCachedResponseById error:', err.message);
    return false;
  }
}

/**
 * Invalidate a cached response by project and original trigger text
 */
export async function invalidateCacheByTriggerText(projectId: string, triggerText: string): Promise<void> {
  const cleanTrigger = triggerText.trim();
  if (!cleanTrigger) return;

  const messageHash = crypto.createHash('sha256').update(cleanTrigger).digest('hex');
  
  // Clear from local memory
  for (const k of localTemplateCache.keys()) {
    if (k.startsWith(`${projectId}:${messageHash}:`)) {
      localTemplateCache.delete(k);
    }
  }
  localTemplateCache.delete(`${projectId}:${messageHash}:all`);

  // Delete from DB
  const pool = getPgPool();
  if (!pool) return;
  try {
    await pool.query(
      `DELETE FROM cached_responses WHERE project_id = $1 AND message_hash = $2`,
      [projectId, messageHash]
    );
  } catch (err: any) {
    console.warn('[TemplateCache] invalidateCacheByTriggerText error:', err.message);
  }
}

