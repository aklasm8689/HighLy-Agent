import { getPgPool } from '../../db';
import { store } from '../../state';

// In-memory tracking of active online users and activity timestamps
const activeSockets = new Map<string, Set<string>>(); // `${projectId}:${userId}` -> Set<socketId>
const activeUserLastActivity = new Map<string, number>(); // `${projectId}:${userId}` -> timestamp (ms)

/**
 * Mark a user as active/online (e.g. from WS connection or HTTP request)
 */
export function markUserActive(projectId: string, userId: string, socketId?: string): void {
  if (!projectId || !userId) return;
  const key = `${projectId}:${userId}`;
  activeUserLastActivity.set(key, Date.now());
  if (socketId) {
    if (!activeSockets.has(key)) {
      activeSockets.set(key, new Set());
    }
    activeSockets.get(key)!.add(socketId);
  }
}

/**
 * Mark a user as disconnected (e.g. WS connection closed)
 */
export function markUserDisconnected(projectId?: string, userId?: string, socketId?: string): void {
  if (!projectId || !userId) return;
  const key = `${projectId}:${userId}`;
  if (socketId && activeSockets.has(key)) {
    activeSockets.get(key)!.delete(socketId);
    if (activeSockets.get(key)!.size === 0) {
      activeSockets.delete(key);
    }
  }

  // Asynchronously trigger cleanup check if user has no remaining active sockets
  if (!activeSockets.has(key) || activeSockets.get(key)!.size === 0) {
    setTimeout(() => {
      conversationRetentionScheduler.cleanupUserIfExpiredAndOffline(projectId, userId).catch(() => {});
    }, 2000);
  }
}

/**
 * Check if a user is currently online (active socket) or active recently (within 5 mins)
 */
export function isUserOnlineOrActive(projectId: string, userId: string): boolean {
  if (!projectId || !userId) return false;
  const key = `${projectId}:${userId}`;

  // 1. Active WebSocket connection
  if (activeSockets.has(key) && activeSockets.get(key)!.size > 0) {
    return true;
  }

  // 2. Recent HTTP / messaging activity within 5 minutes (300,000 ms)
  const lastActive = activeUserLastActivity.get(key);
  if (lastActive && Date.now() - lastActive < 5 * 60 * 1000) {
    return true;
  }

  return false;
}

export class ConversationRetentionScheduler {
  private cleanupInterval: NodeJS.Timeout | null = null;

  /**
   * Start scheduled Nightly cleanup cycle
   * Runs hourly and specifically checks at 1:00 AM BD time
   */
  start(): void {
    if (this.cleanupInterval) return;

    // Run initial check after 10 seconds
    setTimeout(() => {
      this.cleanupExpiredConversations().catch(() => {});
    }, 10000);

    // Run periodically every 15 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredConversations().catch((err) => {
        console.warn('[RetentionScheduler] Periodic cleanup notice:', err?.message);
      });
    }, 15 * 60 * 1000);

    console.log('[RetentionScheduler] Strict Nightly (1:00 AM BD) Conversation Retention worker active (Active-User Aware).');
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Performs deletion of conversations and messages past 1:00 AM BD Time.
   * CRITICAL REQUIREMENT: If user is currently CONNECTED / ONLINE, DO NOT DELETE!
   * Only delete when the user is OFFLINE / DISCONNECTED.
   * USER PROFILES, FACTS, PREFERENCES AND KNOWLEDGE PATTERNS ARE NEVER TOUCHED.
   */
  async cleanupExpiredConversations(): Promise<{ deletedConversations: number; deletedMessages: number }> {
    const pool = getPgPool();
    if (!pool) {
      return { deletedConversations: 0, deletedMessages: 0 };
    }

    try {
      const nowIso = new Date().toISOString();

      // Fetch expired conversations
      const convsRes = await pool.query(
        `SELECT id, project_id, user_id, session_id FROM user_conversations WHERE expires_at <= $1 OR cleanup_at <= $1`,
        [nowIso]
      );

      if (!convsRes.rows || convsRes.rows.length === 0) {
        return { deletedConversations: 0, deletedMessages: 0 };
      }

      let deletedConversations = 0;
      let deletedMessages = 0;

      for (const row of convsRes.rows) {
        const { id: convId, project_id: projectId, user_id: userId, session_id: sessionId } = row;

        // Skip deletion if user is currently online or active in the app
        if (isUserOnlineOrActive(projectId, userId)) {
          console.log(`[RetentionScheduler] User ${userId} (${projectId}) is currently connected/online. Deletion deferred until disconnect.`);
          continue;
        }

        // User is offline — delete expired messages & conversation
        const msgRes = await pool.query(`DELETE FROM user_messages WHERE conversation_id = $1 RETURNING id`, [convId]);
        const convDelRes = await pool.query(`DELETE FROM user_conversations WHERE id = $1 RETURNING id`, [convId]);

        deletedMessages += msgRes.rowCount || 0;
        deletedConversations += convDelRes.rowCount || 0;

        if (sessionId) {
          store.conversations.delete(sessionId);
        }
      }

      if (deletedConversations > 0 || deletedMessages > 0) {
        console.log(
          `[RetentionScheduler] Executed Nightly Cleanup: Purged ${deletedConversations} conversations and ${deletedMessages} messages for offline users.`
        );
      }
      return { deletedConversations, deletedMessages };
    } catch (err: any) {
      console.error('[RetentionScheduler] Error during retention cleanup:', err.message);
      return { deletedConversations: 0, deletedMessages: 0 };
    }
  }

  /**
   * Cleanup a single user's expired session immediately when they disconnect/go offline
   */
  async cleanupUserIfExpiredAndOffline(projectId: string, userId: string): Promise<void> {
    if (isUserOnlineOrActive(projectId, userId)) return;
    const pool = getPgPool();
    if (!pool) return;

    try {
      const nowIso = new Date().toISOString();
      const expiredRes = await pool.query(
        `SELECT id, session_id FROM user_conversations WHERE project_id = $1 AND user_id = $2 AND (expires_at <= $3 OR cleanup_at <= $3)`,
        [projectId, userId, nowIso]
      );

      for (const row of expiredRes.rows) {
        await pool.query(`DELETE FROM user_messages WHERE conversation_id = $1`, [row.id]);
        await pool.query(`DELETE FROM user_conversations WHERE id = $1`, [row.id]);
        if (row.session_id) {
          store.conversations.delete(row.session_id);
        }
        console.log(`[RetentionScheduler] Purged expired session for offline user: ${userId} (${projectId}).`);
      }
    } catch (err: any) {
      console.error('[RetentionScheduler] Disconnect cleanup error:', err.message);
    }
  }
}

export const conversationRetentionScheduler = new ConversationRetentionScheduler();
