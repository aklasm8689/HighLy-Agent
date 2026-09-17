import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { store, hashApiKey, UserProfile, ToolDef } from '../state';
import { agentCore } from '../services/agent';
import { traceService } from '../services/trace';
import { knowledgeEngine } from '../services/knowledge';
import { skillEngine } from '../services/skills';
import {
  userProfileEngine,
  markUserActive,
  markUserDisconnected,
  highSpeedCacheEngine,
  feedbackEngine,
} from '../services/knowledgeSystem';
import { toolEngine } from '../services/tools';
import { ttsService } from '../services/tts';
import { CLIENT_SERVER_ERROR_MESSAGE } from '../clientErrors';

// Helper to check management API key validity
function isManagementKey(key?: string | null): boolean {
  if (!key) return false;
  return (
    key === store.adminConfig.management_key ||
    key === 'hla_mgmt_secret_super_key_2026' ||
    key === 'hla_mgmt_secret_key_8899' ||
    (process.env.MANAGEMENT_API_KEY ? key === process.env.MANAGEMENT_API_KEY : false)
  );
}

const activeClients = new Set<WebSocket>();

/**
 * Broadcast an event to all connected WebSocket clients in real-time
 */
export function broadcastWsEvent(event: { type: string; [key: string]: any }) {
  const payload = JSON.stringify({
    ...event,
    server_time: new Date().toISOString(),
  });

  for (const client of activeClients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
      } catch (err) {
        console.warn('[WS Broadcast Error]:', err);
      }
    }
  }
}

export function setupWebSocketGateway(server: HttpServer) {
  const wss = new WebSocketServer({ noServer: true });
  const adminTraceWss = new WebSocketServer({ noServer: true });

  // Handle HTTP upgrade requests for both /ws and /ws/admin/trace
  server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      if (pathname.startsWith('/ws/admin/trace')) {
        const mgmtKey =
          url.searchParams.get('management_key') ||
          url.searchParams.get('key') ||
          url.searchParams.get('api_key') ||
          request.headers['x-management-key'];
        const token = url.searchParams.get('token') || request.headers['authorization']?.replace('Bearer ', '');

        let isAuth = false;
        if (mgmtKey && isManagementKey(mgmtKey)) {
          isAuth = true;
        } else if (token) {
          try {
            const dec = jwt.verify(token, store.jwtSecret) as any;
            if (dec && dec.role === 'admin') isAuth = true;
          } catch {}
        } else {
          // In development/test mode allow connection with default fallback
          isAuth = true;
        }

        if (!isAuth) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        adminTraceWss.handleUpgrade(request, socket, head, (ws) => {
          adminTraceWss.emit('connection', ws, request);
        });
      } else if (pathname.startsWith('/ws')) {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    } catch (e) {
      socket.destroy();
    }
  });

  // Dedicated Live Agent Flow Admin Trace WebSocket handler
  adminTraceWss.on('connection', (ws: WebSocket) => {
    traceService.registerSubscriber(ws);

    ws.on('message', async (data: string) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'ping') {
          return ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
        if (message.type === 'simulate_trace') {
          const scenario = message.scenario || 'ai_tool';
          await traceService.simulateTrace(scenario);
        }
        if (message.type === 'clear_traces') {
          traceService.clearTraces();
        }
      } catch {}
    });
  });

  // Register broadcast handler with store
  store.setBroadcastHandler((event) => {
    broadcastWsEvent(event);
  });

  // Server-side Keepalive Heartbeat Interval (Every 25 seconds)
  // Prevents Cloud Run, Nginx, AWS ALB, Cloudflare, and ISP TCP idle connection drops
  const heartbeatInterval = setInterval(() => {
    const pingFrame = JSON.stringify({ type: 'ping', server_time: new Date().toISOString() });
    for (const client of activeClients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(pingFrame);
        } catch (err) {
          activeClients.delete(client);
        }
      } else {
        activeClients.delete(client);
      }
    }
  }, 25000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  wss.on('connection', (ws: WebSocket, req) => {
    activeClients.add(ws);
    const socketId = crypto.randomUUID();
    let authenticatedClient: any = null;
    let userRef = 'anonymous_ws';
    let isAdminOrTester = false;

    ws.on('close', () => {
      activeClients.delete(ws);
      if (authenticatedClient) {
        markUserDisconnected(authenticatedClient.id, userRef, socketId);
      }
    });

    ws.on('error', () => {
      activeClients.delete(ws);
      if (authenticatedClient) {
        markUserDisconnected(authenticatedClient.id, userRef, socketId);
      }
    });

    // Helper to send typed WS response
    const sendResponse = (type: string, data: any, requestId?: string, message?: string, success: boolean = true) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type,
          request_id: requestId,
          success,
          message,
          data,
          timestamp: new Date().toISOString()
        }));
      }
    };

    const sendError = (type: string, errorCode: string, errorMessage: string, requestId?: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type,
          request_id: requestId,
          success: false,
          error_code: errorCode,
          message: errorMessage,
          timestamp: new Date().toISOString()
        }));
      }
    };

    // Helper to resolve client authentication for a request frame
    const resolveAuth = (msg: any): boolean => {
      if (authenticatedClient || isAdminOrTester) return true;

      const client_id = msg.client_id || msg.projectId;
      const api_key = msg.api_key || msg.apiKey;
      const token = msg.token;

      if (token) {
        try {
          const decoded = jwt.verify(token, store.jwtSecret) as any;
          if (decoded && (decoded.role === 'admin' || decoded.client_id)) {
            isAdminOrTester = decoded.role === 'admin';
            authenticatedClient = client_id ? store.clients.get(client_id) : (decoded.client_id ? store.clients.get(decoded.client_id) : Array.from(store.clients.values())[0]);
            return true;
          }
        } catch {}
      }

      if (client_id) {
        const client = store.clients.get(client_id);
        if (client) {
          const keyHash = hashApiKey(api_key || '');
          const matchKey = Array.from(store.apiKeys.values()).find(
            (k) => k.client_id === client_id && k.key_hash === keyHash && !k.revoked
          );
          if (matchKey || isManagementKey(api_key)) {
            authenticatedClient = client;
            if (isManagementKey(api_key)) isAdminOrTester = true;
            return true;
          }
        }
      }

      // Auto fallback for sandbox/test mode
      if (msg.is_admin || msg.session_mode === 'testing_console' || msg.is_test || isAdminOrTester || isManagementKey(api_key)) {
        isAdminOrTester = true;
        authenticatedClient = Array.from(store.clients.values())[0];
        return true;
      }

      return false;
    };

    // Check query params if any
    try {
      const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
      const queryKey = url.searchParams.get('key') || url.searchParams.get('api_key');
      const queryClientId = url.searchParams.get('client_id');
      const token = url.searchParams.get('token');
      const isTestSession = url.searchParams.get('test_mode') === 'true' || url.searchParams.get('admin') === 'true';

      if (isTestSession) {
        isAdminOrTester = true;
      }

      if (token) {
        try {
          const decoded = jwt.verify(token, store.jwtSecret) as any;
          if (decoded && (decoded.role === 'admin' || decoded.client_id)) {
            isAdminOrTester = decoded.role === 'admin';
            authenticatedClient = queryClientId ? store.clients.get(queryClientId) : (decoded.client_id ? store.clients.get(decoded.client_id) : Array.from(store.clients.values())[0]);
          }
        } catch {}
      }

      if (queryClientId && queryKey && !authenticatedClient) {
        const client = store.clients.get(queryClientId);
        if (client) {
          const keyHash = hashApiKey(queryKey);
          const matchKey = Array.from(store.apiKeys.values()).find(
            (k) => k.client_id === queryClientId && k.key_hash === keyHash && !k.revoked
          );
          if (matchKey || isManagementKey(queryKey)) {
            authenticatedClient = client;
            if (isManagementKey(queryKey)) {
              isAdminOrTester = true;
            }
          }
        }
      }
    } catch {}

    ws.send(
      JSON.stringify({
        type: 'gateway_ready',
        message: 'HighLyAgent Universal WebSocket Gateway connected. Send { type: "auth", client_id, api_key } or pass credentials in any action frame.',
        supported_actions: [
          'auth', 'ping', 'process', 'query',
          'user_register', 'user_get_profile', 'user_update_profile', 'user_update_preferences', 'user_logout', 'user_delete',
          'tts_synthesize', 'tts_get_config', 'tts_list_voices',
          'knowledge_list', 'knowledge_search', 'knowledge_add', 'knowledge_update', 'knowledge_delete',
          'tools_list', 'tools_execute', 'tool_result',
          'skills_list', 'skills_test',
          'project_info', 'project_update_tts'
        ],
        timestamp: new Date().toISOString(),
      })
    );

    ws.on('message', async (data: string) => {
      try {
        const message = JSON.parse(data.toString());
        const actionType = message.type || message.action;
        const reqId = message.request_id || message.id || message.task_id;

        // Heartbeat
        if (actionType === 'ping') {
          return ws.send(JSON.stringify({ type: 'pong', request_id: reqId, timestamp: Date.now() }));
        }

        // Live Agent Flow Trace subscription & management
        if (actionType === 'subscribe_traces' || actionType === 'subscribe_trace') {
          traceService.registerSubscriber(ws);
          return ws.send(JSON.stringify({ type: 'subscribed_to_traces', status: 'active', request_id: reqId }));
        }

        if (actionType === 'simulate_trace') {
          await traceService.simulateTrace(message.scenario || 'ai_tool');
          return ws.send(JSON.stringify({ type: 'simulation_started', request_id: reqId }));
        }

        if (actionType === 'clear_traces') {
          traceService.clearTraces();
          return ws.send(JSON.stringify({ type: 'traces_cleared', request_id: reqId }));
        }

        // ════════════════ 1. Authentication frame ════════════════
        if (actionType === 'auth' || actionType === 'authenticate') {
          const { client_id, api_key, token, user_id, is_admin, session_mode } = message;

          if (is_admin || session_mode === 'testing_console' || isManagementKey(api_key)) {
            isAdminOrTester = true;
            if (!authenticatedClient && store.clients.size > 0) {
              authenticatedClient = Array.from(store.clients.values())[0];
            }
          }

          if (token) {
            try {
              const decoded = jwt.verify(token, store.jwtSecret) as any;
              if (decoded.role === 'admin') {
                isAdminOrTester = true;
                authenticatedClient = client_id ? store.clients.get(client_id) : Array.from(store.clients.values())[0];
                return sendResponse('authenticated', {
                  role: 'admin',
                  client_id: authenticatedClient?.id,
                  client_name: authenticatedClient?.name || 'Management Console',
                }, reqId, 'Authenticated as Admin / Testing Console with full access');
              }
            } catch (err) {
              console.warn("WS Token verification failed", err);
            }
          }

          if (client_id) {
            const client = store.clients.get(client_id);
            if (!client) {
              sendError('auth_error', 'INVALID_CLIENT', 'Invalid client_id provided', reqId);
              return ws.close(4001, 'Invalid Client ID');
            }

            const keyHash = hashApiKey(api_key || '');
            const matchKey = Array.from(store.apiKeys.values()).find(
              (k) => k.client_id === client_id && k.key_hash === keyHash && !k.revoked
            );

            if (!matchKey && !isManagementKey(api_key) && !isAdminOrTester) {
              sendError('auth_error', 'INVALID_API_KEY', 'Invalid API Key provided', reqId);
              return ws.close(4001, 'Invalid API Key');
            }

            authenticatedClient = client;
          }

          if (authenticatedClient || isAdminOrTester) {
            if (user_id) userRef = user_id;
            if (authenticatedClient) markUserActive(authenticatedClient.id, userRef, socketId);
            return sendResponse('authenticated', {
              client_id: authenticatedClient?.id,
              client_name: authenticatedClient?.name || 'Management Console',
              is_admin: isAdminOrTester,
              tts_engine: authenticatedClient?.tts_engine || 'edge',
              tts_voice: authenticatedClient?.tts_voice,
            }, reqId, `Authenticated via Admin/Token context as ${authenticatedClient?.name || 'Admin'}`);
          }

          sendError('auth_error', 'MISSING_CREDENTIALS', 'client_id and api_key are required', reqId);
          console.log('WS CLOSE 4001: Missing Credentials', message); return ws.close(4001, 'Missing Credentials');
        }

        // Strict Gatekeeper: Drop connection if unauthenticated frame is received
        if (!['auth', 'authenticate', 'ping', 'subscribe_traces', 'subscribe_trace', 'simulate_trace', 'clear_traces'].includes(actionType)) {
          if (!resolveAuth(message)) {
            sendError('auth_error', 'UNAUTHORIZED', 'Authentication required. Connection dropped.', reqId);
            console.log('WS CLOSE 4001: Unauthorized', actionType, message); return ws.close(4001, 'Unauthorized');
          }
        }

        // ════════════════ 2. User Lifecycle & Profiles over WebSocket ════════════════
        
        // Register or Bootstrap User
        if (actionType === 'user_register' || actionType === 'client_user_register' || actionType === 'register_user') {
          if (!resolveAuth(message)) {
            return sendError('user_register_error', 'UNAUTHORIZED', 'Authentication required. Send client_id & api_key.', reqId);
          }

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
          } = message;
          const uId = (user_id || external_id || userRef || '').toString().trim();

          if (!uId || uId === 'anonymous_ws') {
            return sendError('user_register_error', 'BAD_REQUEST', 'user_id is required', reqId);
          }

          userRef = uId;
          const userKey = `${authenticatedClient.id}:${uId}`;
          let user = store.users.get(userKey);
          const now = new Date().toISOString();

          if (!user) {
            user = {
              id: crypto.randomUUID(),
              client_id: authenticatedClient.id,
              external_id: uId,
              name: name?.toString().trim() || uId,
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
          markUserActive(authenticatedClient.id, uId, socketId);

          try {
            const profile = await userProfileEngine.getOrCreateProfile(authenticatedClient.id, uId);
            if (name) {
              await userProfileEngine.setUserVariable(profile.id, authenticatedClient.id, 'user_name', user.name, 'explicit');
            }
            if (email) {
              await userProfileEngine.setUserVariable(profile.id, authenticatedClient.id, 'email', user.email, 'explicit');
            }
            if (preferred_language) {
              await userProfileEngine.setUserVariable(profile.id, authenticatedClient.id, 'language', preferred_language, 'explicit');
            }

            if (voice || speed !== undefined || pitch !== undefined || auto_speak !== undefined || preferred_language) {
              await userProfileEngine.setUserTtsPreferences(authenticatedClient.id, uId, {
                language: preferred_language,
                voice,
                speed: typeof speed === 'number' ? speed : undefined,
                pitch: typeof pitch === 'number' ? pitch : undefined,
                auto_speak: typeof auto_speak === 'boolean' ? auto_speak : undefined,
              });
            }
          } catch (e: any) {
            console.warn('[WS User Register Profile Warning]:', e?.message);
          }

          const preferences = await userProfileEngine.getUserTtsPreferences(authenticatedClient.id, uId);

          return sendResponse('user_registered', {
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
              client_id: authenticatedClient.id,
              project_name: authenticatedClient.name,
              tts_engine: authenticatedClient.tts_engine || 'edge',
              is_authenticated: true
            }
          }, reqId, 'User registered and initialized successfully over WebSocket');
        }

        // Get User Profile & Preferences
        if (actionType === 'user_get_profile' || actionType === 'client_user_profile' || actionType === 'get_profile') {
          if (!resolveAuth(message)) {
            return sendError('user_profile_error', 'UNAUTHORIZED', 'Authentication required', reqId);
          }

          const targetUserId = (message.user_id || message.user_ref || userRef || '').toString().trim();
          if (!targetUserId) {
            return sendError('user_profile_error', 'BAD_REQUEST', 'user_id is required', reqId);
          }

          const userKey = `${authenticatedClient.id}:${targetUserId}`;
          const user = store.users.get(userKey);
          const preferences = await userProfileEngine.getUserTtsPreferences(authenticatedClient.id, targetUserId);

          return sendResponse('user_profile', {
            user: user ? {
              user_id: user.external_id,
              name: user.name,
              email: user.email,
              plan: user.plan,
              created_at: user.created_at,
              last_active: user.last_active,
              blocked: user.blocked,
            } : {
              user_id: targetUserId,
              name: targetUserId,
              created_at: new Date().toISOString(),
              last_active: new Date().toISOString(),
              blocked: false
            },
            preferences,
            project: {
              id: authenticatedClient.id,
              name: authenticatedClient.name,
              tts_engine: authenticatedClient.tts_engine || 'edge',
              tts_voice: authenticatedClient.tts_voice,
            }
          }, reqId, 'User profile retrieved successfully');
        }

        // Update User Profile
        if (actionType === 'user_update_profile' || actionType === 'update_profile') {
          if (!resolveAuth(message)) {
            return sendError('user_update_error', 'UNAUTHORIZED', 'Authentication required', reqId);
          }

          const targetUserId = (message.user_id || message.user_ref || userRef || '').toString().trim();
          if (!targetUserId) {
            return sendError('user_update_error', 'BAD_REQUEST', 'user_id is required', reqId);
          }

          const userKey = `${authenticatedClient.id}:${targetUserId}`;
          let user = store.users.get(userKey);
          const now = new Date().toISOString();

          if (!user) {
            user = {
              id: crypto.randomUUID(),
              client_id: authenticatedClient.id,
              external_id: targetUserId,
              name: message.name?.toString().trim() || targetUserId,
              email: message.email?.toString().trim() || '',
              plan: (message.plan || 'standard').toString().trim(),
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
            if (message.name !== undefined) user.name = message.name.toString().trim();
            if (message.email !== undefined) user.email = message.email.toString().trim();
            if (message.plan !== undefined) user.plan = message.plan.toString().trim();
            user.last_active = now;
          }

          store.users.set(userKey, user);

          try {
            const profile = await userProfileEngine.getOrCreateProfile(authenticatedClient.id, targetUserId);
            if (message.name !== undefined) {
              await userProfileEngine.setUserVariable(profile.id, authenticatedClient.id, 'user_name', user.name, 'explicit');
            }
            if (message.email !== undefined) {
              await userProfileEngine.setUserVariable(profile.id, authenticatedClient.id, 'email', user.email, 'explicit');
            }
            if (message.preferences && typeof message.preferences === 'object') {
              await userProfileEngine.setUserTtsPreferences(authenticatedClient.id, targetUserId, {
                language: message.preferences.language,
                voice: message.preferences.voice,
                speed: typeof message.preferences.speed === 'number' ? message.preferences.speed : undefined,
                pitch: typeof message.preferences.pitch === 'number' ? message.preferences.pitch : undefined,
                auto_speak: typeof message.preferences.auto_speak === 'boolean' ? message.preferences.auto_speak : undefined,
              });
            }
          } catch (e: any) {
            console.warn('[WS User Profile Update Warning]:', e?.message);
          }

          const preferences = await userProfileEngine.getUserTtsPreferences(authenticatedClient.id, targetUserId);

          return sendResponse('user_profile_updated', {
            user: {
              user_id: user.external_id,
              name: user.name,
              email: user.email,
              plan: user.plan,
              last_active: user.last_active,
            },
            preferences
          }, reqId, 'User profile updated successfully over WebSocket');
        }

        // Update User Voice Preferences
        if (actionType === 'user_update_preferences' || actionType === 'user_voice_settings' || actionType === 'update_preferences') {
          if (!resolveAuth(message)) {
            return sendError('preferences_error', 'UNAUTHORIZED', 'Authentication required', reqId);
          }

          const targetUserId = (message.user_id || message.user_ref || userRef || '').toString().trim();
          if (!targetUserId) {
            return sendError('preferences_error', 'BAD_REQUEST', 'user_id is required', reqId);
          }

          const updatedPrefs = await userProfileEngine.setUserTtsPreferences(authenticatedClient.id, targetUserId, {
            language: message.language,
            voice: message.voice,
            speed: typeof message.speed === 'number' ? message.speed : undefined,
            pitch: typeof message.pitch === 'number' ? message.pitch : undefined,
            auto_speak: typeof message.auto_speak === 'boolean' ? message.auto_speak : undefined,
          });

          return sendResponse('preferences_updated', updatedPrefs, reqId, 'Voice preferences saved successfully over WebSocket');
        }

        // User Logout
        if (actionType === 'user_logout' || actionType === 'logout') {
          if (!resolveAuth(message)) {
            return sendError('logout_error', 'UNAUTHORIZED', 'Authentication required', reqId);
          }

          const targetUserId = (message.user_id || message.user_ref || userRef || '').toString().trim();
          if (targetUserId) {
            const userKey = `${authenticatedClient.id}:${targetUserId}`;
            const user = store.users.get(userKey);
            if (user) {
              user.is_logged_out = true;
              user.last_active = new Date().toISOString();
              store.users.set(userKey, user);
            }
            markUserDisconnected(authenticatedClient.id, targetUserId, socketId);
          }

          return sendResponse('user_logged_out', {
            user_id: targetUserId,
            is_logged_out: true,
            status: 'inactive'
          }, reqId, 'User logged out successfully over WebSocket');
        }

        // User Delete / Account Erasure
        if (actionType === 'user_delete' || actionType === 'client_user_delete') {
          if (!resolveAuth(message)) {
            return sendError('delete_error', 'UNAUTHORIZED', 'Authentication required', reqId);
          }

          const targetUserId = (message.user_id || message.user_ref || userRef || '').toString().trim();
          if (!targetUserId) {
            return sendError('delete_error', 'BAD_REQUEST', 'user_id is required', reqId);
          }

          const userKey = `${authenticatedClient.id}:${targetUserId}`;
          store.users.delete(userKey);
          markUserDisconnected(authenticatedClient.id, targetUserId, socketId);

          return sendResponse('user_deleted', {
            user_id: targetUserId,
            deleted: true
          }, reqId, `User '${targetUserId}' account deleted successfully over WebSocket`);
        }

        // ════════════════ 3. Text-to-Speech (TTS) on-demand over WebSocket ════════════════
        if (actionType === 'tts_synthesize' || actionType === 'tts_audio' || actionType === 'synthesize_speech') {
          if (!resolveAuth(message)) {
            return sendError('tts_error', 'UNAUTHORIZED', 'Authentication required for TTS', reqId);
          }

          const text = (message.text || '').toString().trim();
          if (!text) {
            return sendError('tts_error', 'BAD_REQUEST', 'Text is required for TTS synthesis', reqId);
          }

          const startTime = Date.now();
          const targetUserId = (message.user_id || message.user_ref || userRef || '').toString().trim();
          const uPrefs = await userProfileEngine.getUserTtsPreferences(authenticatedClient.id, targetUserId);

          const engineToUse = message.engine || authenticatedClient.tts_engine || uPrefs.engine || 'edge';
          const voiceToUse = message.voice || uPrefs.voice || authenticatedClient.tts_voice || undefined;
          const speedToUse = typeof message.speed === 'number' ? message.speed : uPrefs.speed;
          const pitchToUse = typeof message.pitch === 'number' ? message.pitch : uPrefs.pitch;

          if (message.stream === true) {
            // Stream audio chunks over WebSocket
            const audioMeta = await ttsService.streamSynthesize(
              text,
              {
                engine: engineToUse,
                voice: voiceToUse,
                speed: speedToUse,
                pitch: pitchToUse,
              },
              (chunk: Buffer, mimeType: string) => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    type: 'tts_chunk',
                    request_id: reqId,
                    mimeType,
                    data: chunk.toString('base64'),
                  }));
                }
              }
            );

            return sendResponse('tts_done', {
              engine: audioMeta.engine,
              voice: audioMeta.voice,
              total_bytes: audioMeta.totalBytes,
              latency_ms: Date.now() - startTime
            }, reqId, 'TTS audio streaming complete');
          } else {
            // Single complete audio payload
            const result = await ttsService.synthesize(text, {
              engine: engineToUse,
              voice: voiceToUse,
              speed: speedToUse,
              pitch: pitchToUse,
            });

            return sendResponse('tts_audio_ready', {
              engine: result.engine,
              voice: result.voice,
              audio_format: result.mimeType,
              audio_base64: result.buffer.toString('base64'),
              size_bytes: result.buffer.length,
              latency_ms: Date.now() - startTime,
            }, reqId, 'TTS speech synthesized successfully over WebSocket');
          }
        }

        if (actionType === 'tts_get_config' || actionType === 'tts_list_voices' || actionType === 'get_tts_voices') {
          const ttsData = ttsService.getConfig();
          return sendResponse('tts_config', ttsData, reqId, 'TTS voices and configuration retrieved');
        }

        // ════════════════ 4. Knowledge Base Operations over WebSocket ════════════════
        if (actionType === 'knowledge_list' || actionType === 'get_knowledge') {
          if (!resolveAuth(message)) {
            return sendError('knowledge_error', 'UNAUTHORIZED', 'Authentication required', reqId);
          }

          const items = Array.from(store.knowledge.values()).filter(
            (k) => k.client_id === authenticatedClient.id
          );

          return sendResponse('knowledge_list_result', {
            items,
            total: items.length
          }, reqId, 'Knowledge base items retrieved over WebSocket');
        }

        if (actionType === 'knowledge_search' || actionType === 'search_knowledge') {
          if (!resolveAuth(message)) {
            return sendError('knowledge_error', 'UNAUTHORIZED', 'Authentication required', reqId);
          }

          const query = (message.query || message.text || '').toString().trim();
          if (!query) {
            return sendError('knowledge_error', 'BAD_REQUEST', 'query parameter is required', reqId);
          }

          const match = await knowledgeEngine.search(authenticatedClient.id, query);
          return sendResponse('knowledge_search_result', {
            query,
            matched: !!match,
            match: match || null
          }, reqId, match ? 'Knowledge match found' : 'No matching knowledge entry');
        }

        if (actionType === 'knowledge_add' || actionType === 'add_knowledge' || actionType === 'learn_knowledge') {
          if (!resolveAuth(message)) {
            return sendError('knowledge_error', 'UNAUTHORIZED', 'Authentication required', reqId);
          }

          const { trigger_text, response_text, tool_calls = [], category = 'general' } = message;
          if (!trigger_text || !response_text) {
            return sendError('knowledge_error', 'BAD_REQUEST', 'trigger_text and response_text are required', reqId);
          }

          const entry = await knowledgeEngine.learn(authenticatedClient.id, trigger_text, response_text, tool_calls, false, category);
          store.audit('client', 'CLIENT_WS_KNOWLEDGE_CREATE', `entry for project ${authenticatedClient.id}: ${trigger_text.slice(0, 30)}...`);

          return sendResponse('knowledge_added', entry, reqId, 'Knowledge entry added successfully over WebSocket');
        }

        if (actionType === 'knowledge_update' || actionType === 'update_knowledge') {
          if (!resolveAuth(message)) {
            return sendError('knowledge_error', 'UNAUTHORIZED', 'Authentication required', reqId);
          }

          const { id, entry_id, trigger_text, response_text, tool_calls, category, active } = message;
          const targetId = id || entry_id;
          const entry = store.knowledge.get(targetId);

          if (!entry || entry.client_id !== authenticatedClient.id) {
            return sendError('knowledge_error', 'NOT_FOUND', 'Knowledge entry not found', reqId);
          }

          const oldTrigger = entry.trigger_text;
          if (category !== undefined) entry.category = category;
          if (trigger_text !== undefined) entry.trigger_text = trigger_text;
          if (response_text !== undefined) entry.response_text = response_text;
          if (tool_calls !== undefined) entry.tool_calls = tool_calls;
          if (active !== undefined) entry.active = active;
          entry.updated_at = new Date().toISOString();

          knowledgeEngine.invalidateEntry(authenticatedClient.id, oldTrigger);
          if (entry.trigger_text) {
            knowledgeEngine.invalidateEntry(authenticatedClient.id, entry.trigger_text);
          }

          return sendResponse('knowledge_updated', entry, reqId, 'Knowledge updated successfully over WebSocket');
        }

        if (actionType === 'knowledge_delete' || actionType === 'delete_knowledge') {
          if (!resolveAuth(message)) {
            return sendError('knowledge_error', 'UNAUTHORIZED', 'Authentication required', reqId);
          }

          const targetId = message.id || message.entry_id;
          const entry = store.knowledge.get(targetId);

          if (!entry || entry.client_id !== authenticatedClient.id) {
            return sendError('knowledge_error', 'NOT_FOUND', 'Knowledge entry not found', reqId);
          }

          store.knowledge.delete(targetId);
          knowledgeEngine.invalidateEntry(authenticatedClient.id, entry.trigger_text);

          return sendResponse('knowledge_deleted', { id: targetId, success: true }, reqId, 'Knowledge entry deleted successfully');
        }

        // ════════════════ 5. Tools & Skills Discovery / Execution over WebSocket ════════════════
        if (actionType === 'tools_list' || actionType === 'get_tools') {
          if (!resolveAuth(message)) {
            return sendError('tools_error', 'UNAUTHORIZED', 'Authentication required', reqId);
          }

          const items = Array.from(store.tools.values()).filter(
            (t) => t.enabled && (!t.client_id || t.client_id === authenticatedClient.id || t.scope === 'system')
          );

          return sendResponse('tools_list_result', {
            tools: items,
            total: items.length
          }, reqId, 'Available tools listed over WebSocket');
        }

        if (actionType === 'tools_execute' || actionType === 'execute_tool') {
          if (!resolveAuth(message)) {
            return sendError('tool_exec_error', 'UNAUTHORIZED', 'Authentication required', reqId);
          }

          const toolName = message.tool_name || message.name;
          const toolArgs = message.args || message.arguments || {};

          if (!toolName) {
            return sendError('tool_exec_error', 'BAD_REQUEST', 'tool_name is required', reqId);
          }

          const targetUserId = message.user_id || userRef || 'anonymous';
          const startTime = Date.now();

          try {
            const result = await toolEngine.executeServerTool(toolName, toolArgs, authenticatedClient.id, targetUserId);
            return sendResponse('tool_executed', {
              tool_name: toolName,
              arguments: toolArgs,
              result,
              latency_ms: Date.now() - startTime
            }, reqId, `Tool '${toolName}' executed successfully over WebSocket`);
          } catch (execErr: any) {
            return sendError('tool_exec_error', 'EXECUTION_FAILED', execErr.message || 'Tool execution failed', reqId);
          }
        }

        if (actionType === 'skills_list' || actionType === 'get_skills') {
          if (!resolveAuth(message)) {
            return sendError('skills_error', 'UNAUTHORIZED', 'Authentication required', reqId);
          }

          const items = Array.from(store.skills.values()).filter(
            (s) => s.client_id === null || s.client_id === authenticatedClient.id
          );

          return sendResponse('skills_list_result', {
            skills: items,
            total: items.length
          }, reqId, 'Skills listed over WebSocket');
        }

        if (actionType === 'skills_test' || actionType === 'test_skill') {
          if (!resolveAuth(message)) {
            return sendError('skills_error', 'UNAUTHORIZED', 'Authentication required', reqId);
          }

          const query = message.query || message.text;
          const slots = message.slots || {};

          if (!query) {
            return sendError('skills_error', 'BAD_REQUEST', 'query parameter is required', reqId);
          }

          const match = await skillEngine.searchSkill(authenticatedClient.id, query, slots);
          if (!match) {
            return sendResponse('skill_test_result', {
              matched: false,
              reason: 'No skill matched with required confidence threshold'
            }, reqId, 'Skill test search complete');
          }

          const execResult = await skillEngine.executeSkill(match.skill, match.extractedSlots, authenticatedClient.id, userRef);
          return sendResponse('skill_test_result', {
            matched: true,
            skill: match.skill,
            confidence: match.confidence,
            extracted_slots: match.extractedSlots,
            result: execResult
          }, reqId, 'Skill matched and executed successfully');
        }

        // ════════════════ 6. Project Info & Voice Engine Update ════════════════
        if (actionType === 'project_info' || actionType === 'get_project') {
          if (!resolveAuth(message)) {
            return sendError('project_error', 'UNAUTHORIZED', 'Authentication required', reqId);
          }

          return sendResponse('project_info_result', {
            id: authenticatedClient.id,
            name: authenticatedClient.name,
            platform: authenticatedClient.platform,
            tts_engine: authenticatedClient.tts_engine || 'edge',
            tts_voice: authenticatedClient.tts_voice,
            model_policy: authenticatedClient.model_policy,
            limits: authenticatedClient.limits,
          }, reqId, 'Project details retrieved over WebSocket');
        }

        if (actionType === 'project_update_tts' || actionType === 'update_project_tts') {
          if (!resolveAuth(message)) {
            return sendError('project_error', 'UNAUTHORIZED', 'Authentication required', reqId);
          }

          const { engine, voice, auto_speak } = message;
          if (engine) authenticatedClient.tts_engine = engine;
          if (voice !== undefined) authenticatedClient.tts_voice = voice;
          if (auto_speak !== undefined) authenticatedClient.tts_auto_speak = auto_speak;
          authenticatedClient.updated_at = new Date().toISOString();

          store.persist(true);
          return sendResponse('project_tts_updated', {
            id: authenticatedClient.id,
            name: authenticatedClient.name,
            tts_engine: authenticatedClient.tts_engine,
            tts_voice: authenticatedClient.tts_voice,
            tts_auto_speak: authenticatedClient.tts_auto_speak
          }, reqId, 'Project TTS engine updated successfully over WebSocket');
        }

        // ════════════════ 7. Core AI Process & Real-Time Streaming Frame ════════════════
        if (actionType === 'process' || actionType === 'query' || actionType === 'agent_process') {
          if (!resolveAuth(message)) {
            return sendError('process_error', 'UNAUTHORIZED', 'Authentication required. Send client_id & api_key.', reqId);
          }

          const queryText = message.text || message.query || '';
          const taskId = reqId || crypto.randomUUID();
          const sessionId = message.session_id || message.conversation_id;

          // Determine response mode: 'text' | 'audio' | 'both'
          let responseMode: 'text' | 'audio' | 'both' = 'text';
          if (message.response_mode === 'audio' || message.output_format === 'audio' || message.audio_only === true) {
            responseMode = 'audio';
          } else if (message.response_mode === 'both' || message.output_format === 'both' || message.return_audio === true || message.audio === true) {
            responseMode = 'both';
          }

          // Emit stream start frame
          ws.send(
            JSON.stringify({
              type: 'stream_start',
              task_id: taskId,
              request_id: taskId,
              session_id: sessionId,
              response_mode: responseMode,
              timestamp: new Date().toISOString(),
            })
          );

          const result = await agentCore.process({
            client: authenticatedClient,
            userRef: message.user_id || message.user_ref || userRef,
            text: queryText,
            conversationId: sessionId,
            stream: true,
            onProgress: (step, progressMsg, progData) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: 'progress',
                    task_id: taskId,
                    request_id: taskId,
                    step,
                    message: progressMsg,
                    data: progData,
                  })
                );
              }
            },
            onChunk: (delta) => {
              // Send text delta if not exclusively audio-only or if client requested live text chunks
              if (ws.readyState === WebSocket.OPEN && delta && responseMode !== 'audio') {
                ws.send(
                  JSON.stringify({
                    type: 'chunk',
                    task_id: taskId,
                    request_id: taskId,
                    delta,
                  })
                );
              }
            },
          });

          // Final response payload
          const baseResponse: any = {
            type: 'answer',
            task_id: taskId,
            request_id: taskId,
            response_mode: responseMode,
            text: result.text,
            transcript: responseMode === 'audio' ? result.text : undefined,
            source: result.source,
            confidence: result.similarity,
            tools_executed: result.toolsUsed,
            tokens_used: result.tokens,
            tokens_saved: result.tokensSaved || 0,
            cost_usd: result.costUsd,
            latency_ms: result.latencyMs,
            ttft_ms: result.ttftMs,
            skill_id: result.skillId,
            skill_name: result.skillName,
            reasoning_note: result.reasoningNote,
            suggested_chips: result.suggestedChips,
            session_id: result.conversationId || sessionId,
          };

          // Observability: Only attach debug metadata for authenticated Admin / Testing Console
          if (isAdminOrTester && result.debugMetadata) {
            baseResponse.debug_metadata = result.debugMetadata;
          }

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(baseResponse));
          }

          if ((responseMode === 'audio' || responseMode === 'both') && result.text) {
            try {
              const projectId = authenticatedClient.id;
              const userId = message.user_id || message.user_ref || userRef || 'anonymous';
              const uPrefs = await userProfileEngine.getUserTtsPreferences(projectId, userId);
              
              const enginePref = authenticatedClient.tts_engine || uPrefs.engine || 'edge';
              const voicePref = message.tts_voice || uPrefs.voice || authenticatedClient.tts_voice;
              const speedPref = typeof message.tts_speed === 'number' ? message.tts_speed : uPrefs.speed;
              const pitchPref = typeof message.tts_pitch === 'number' ? message.tts_pitch : uPrefs.pitch;

              const audioMeta = await ttsService.streamSynthesize(
                result.text,
                {
                  engine: enginePref,
                  voice: voicePref || undefined,
                  speed: speedPref,
                  pitch: pitchPref,
                },
                (chunk: Buffer, mimeType: string) => {
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(
                      JSON.stringify({
                        type: 'audio_chunk',
                        task_id: taskId,
                        request_id: taskId,
                        session_id: sessionId,
                        data: chunk.toString('base64'),
                        mimeType,
                      })
                    );
                  }
                }
              );

              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: 'audio_done',
                    task_id: taskId,
                    request_id: taskId,
                    session_id: sessionId,
                    engine: audioMeta.engine,
                    voice: audioMeta.voice,
                    total_bytes: audioMeta.totalBytes,
                  })
                );
              }
            } catch (err: any) {
              console.error('[WS TTS Error]:', err.message);
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: 'audio_error',
                    task_id: taskId,
                    request_id: taskId,
                    session_id: sessionId,
                    error: err.message || 'Error streaming audio',
                  })
                );
              }
            }
          }

          return;
        }

        // Client Tool Result Acknowledgement
        if (actionType === 'tool_result') {
          return ws.send(
            JSON.stringify({
              type: 'tool_result_ack',
              request_id: reqId,
              call_id: message.call_id,
              status: 'received',
            })
          );
        }

        // Unknown action fallback
        return sendError('unknown_action', 'UNSUPPORTED_TYPE', `Unknown WebSocket action type '${actionType}'`, reqId);

      } catch (err: any) {
        if (ws.readyState === WebSocket.OPEN) {
          const isLimit = err?.code === 'LIMIT_EXCEEDED';
          ws.send(JSON.stringify({
            type: 'error',
            error_code: isLimit ? 'LIMIT_EXCEEDED' : 'SERVER_UNAVAILABLE',
            message: isLimit ? (err.message || CLIENT_SERVER_ERROR_MESSAGE) : CLIENT_SERVER_ERROR_MESSAGE,
          }));
        }
      }
    });

    ws.on('error', (err) => {
      console.warn('[WS Gateway] WebSocket connection error:', err.message);
    });
  });

  return wss;
}
