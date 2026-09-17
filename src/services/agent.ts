import crypto from 'crypto';
import { store, Client, UserProfile, ConversationSession, ConversationMessage } from '../state';
import { knowledgeEngine } from './knowledge';
import { toolEngine } from './tools';
import { providerPool } from './providers';
import { skillEngine } from './skills';
import {
  knowledgePatternEngine,
  userProfileEngine,
  multiLangEngine,
  highSpeedCacheEngine,
  markUserActive,
} from './knowledgeSystem';
import { traceService } from './trace';
import { clientServerError } from '../clientErrors';
import { isPostgresConfigured, getPgPool } from '../db';

// HighLyAgent Dynamic Token Optimization System Imports
import { classifyIntent } from './intentClassifier';
import { getCachedResponse, saveCachedResponse, invalidateCacheByTriggerText } from './templateCacheService';
import { getSemanticTools } from './toolEmbeddingService';
import { summarizeToolOutputIfLarge } from './toolSummaryService';

export interface ProcessInputOptions {
  client: Client;
  userRef: string;
  text: string;
  conversationId?: string;
  autoLearn?: boolean;
  stream?: boolean;
  traceId?: string;
  onChunk?: (delta: string) => void;
  onProgress?: (step: string, message: string, data?: any) => void;
}

/**
 * Detects if a user query is a simple conversational greeting.
 * Greetings are highly context-dependent and conversational, so they should bypass static Q&A
 * cache and be handled by the AI to give rich, varied, and polite responses.
 */
function isConversationalQuery(text: string): boolean {
  const clean = text
    .toLowerCase()
    .replace(/[?!.,;:'"()_\-–]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const chatWords = [
    'assalamu alaikum', 'assalamualaikum', 'salam', 'slam', 'slm', 'shuvo shokal', 'shuvo ratri',
    'good morning', 'good evening', 'good afternoon', 'hi', 'hello', 'hey', 'hej', 'hola',
    'আসসালামু আলাইকুম', 'আসসালামুআলাইকুম', 'সালাম', 'সালামু আলাইকুম', 'শুভ সকাল', 'শুভ রাত্রি', 'হাই', 'হ্যালো', 'হে',
    'thanks', 'thank you', 'ok', 'okay', 'bye', 'goodbye', 'ভালো', 'ধন্যবাদ', 'কেমন আছ'
  ];

  return chatWords.some(
    (g) => clean === g || clean.startsWith(g + ' ') || clean.endsWith(' ' + g)
  );
}

/**
 * Detects if a user query contains personal profile requests or highly dynamic/temporal terms.
 * Bypassing static caches for these prevents Q&A cache poisoning and guarantees personalized dynamic answers.
 */
function isPersonalOrDynamicQuery(text: string): boolean {
  const clean = text.toLowerCase().trim();

  // Personal / Identity triggers
  const personalKeywords = [
    'আমার নাম', 'আমার পরিচয়', 'আমার বাড়ি', 'আমি কে', 'আমার প্রোফাইল', 'আমার অ্যাকাউন্ট',
    'my name', 'who am i', 'about me', 'my account', 'my profile', 'my city', 'আমার শহর',
    'আমার ফোন', 'আমার ইমেইল', 'my phone', 'my email'
  ];
  if (personalKeywords.some(k => clean.includes(k))) return true;

  // Dynamic status / Temporal triggers
  const dynamicKeywords = [
    'order', 'tracking', 'status', 'balance', 'weather', 'forecast', 'time', 'date', 'news', 'search',
    'অর্ডার', 'স্ট্যাটাস', 'ট্র্যাকিং', 'ব্যালেন্স', 'টাকা', 'আবহাওয়া', 'সময়', 'তারিখ', 'খবর'
  ];
  if (dynamicKeywords.some(k => clean.includes(k))) return true;

  return false;
}

/**
 * Detects if a user query is context-dependent, follow-up, pronoun-based, or correction feedback.
 * When true, standard static 1-to-1 Q&A / cached response matching should be bypassed so AI model
 * can evaluate full conversation history and context.
 */
function isContextDependentQuery(text: string, hasHistory: boolean): boolean {
  const clean = text.toLowerCase().trim();

  // Correction or retry signals
  const correctionTriggers = [
    'wrong', 'incorrect', 'not right', 'try again', 'retry', 'fix', 'bad answer', 'different answer',
    'ভুল', 'ভুল হয়েছে', 'সঠিক না', 'ভুল উত্তর', 'আবার বল', 'সঠিক উত্তর দাও', 'আরেকটা উত্তর দাও', 'সঠিক কি',
    'এটা ভুল', 'ভুল হইছে', 'ভুল আনসার', 'উত্তর দেও নাই', 'উত্তর দাও নাই', 'উত্তর দিতে হবে'
  ];
  if (correctionTriggers.some((t) => clean.includes(t))) {
    return true;
  }

  // Relative pronouns and context continuation words
  const relativeWords = [
    'it', 'this', 'that', 'these', 'those', 'he', 'she', 'them', 'their', 'his', 'her',
    'previous', 'earlier', 'before', 'again', 'why', 'how come', 'what about', 'what else',
    'instead', 'change', 'cancel',
    'প্রথমটা', 'দ্বিতীয়টা', 'ওটা', 'এটা', 'ঐটা', 'আমারটা', 'তারটা', 'তাদেরটা',
    'কেন', 'তাহলে', 'আগেরটা', 'তারপর', 'আবার', 'অন্যটা', 'আরেকটা', 'বদলাও'
  ];

  if (hasHistory) {
    const tokens = clean.split(/\s+/);
    if (relativeWords.some((w) => tokens.includes(w))) return true;
  }

  return false;
}

/**
 * Checks if user is repeating a recent question or requesting a retry/correction.
 */
function checkUserRepetitionOrRetry(sessionMessages: any[], currentText: string): { isRepeating: boolean; isCorrection: boolean } {
  if (!sessionMessages || sessionMessages.length === 0) return { isRepeating: false, isCorrection: false };

  const clean = currentText.toLowerCase().trim();

  const correctionTriggers = [
    'wrong', 'incorrect', 'not right', 'try again', 'retry', 'fix', 'bad answer', 'different answer',
    'ভুল', 'ভুল হয়েছে', 'সঠিক না', 'ভুল উত্তর', 'আবার বল', 'সঠিক উত্তর দাও', 'আরেকটা উত্তর দাও',
    'এটা ভুল', 'ভুল হইছে', 'ভুল আনসার', 'উত্তর দেও নাই', 'উত্তর দাও নাই', 'উত্তর দিতে হবে'
  ];
  const isCorrection = correctionTriggers.some((t) => clean.includes(t));

  const recentUserMsgs = sessionMessages
    .filter((m: any) => m.role === 'user')
    .slice(-5);

  let isRepeating = false;
  for (const m of recentUserMsgs) {
    const prevClean = (m.content || '').toLowerCase().trim();
    if (prevClean === clean && clean.length > 2) {
      isRepeating = true;
      break;
    }
  }

  return { isRepeating, isCorrection };
}

/**
 * Strict quality gate for auto-learning:
 * Never save errors, fallbacks, short answers, or context-dependent dynamic responses into static Q&A.
 */
function isValidForAutoLearning(triggerText: string, responseText: string, isRetryOrCorrection: boolean): boolean {
  if (isRetryOrCorrection) return false;
  if (!triggerText || triggerText.trim().length < 2) return false;
  if (!responseText || responseText.trim().length < 10) return false;

  // Prevent auto-learning personal or highly dynamic query contexts
  if (isPersonalOrDynamicQuery(triggerText)) return false;
  
  // Prevent auto-learning simple greetings as static Q&A
  if (isConversationalQuery(triggerText)) return false;

  const respLower = responseText.toLowerCase();

  const errorOrFallbackKeywords = [
    'error', 'failed', 'unable to', "sorry, i couldn't", "sorry, i can't", 'rate limit',
    'api key', 'quota', 'something went wrong', 'try again later', 'internal error',
    '[error', 'error:', 'unauthorized', 'exception', 'service unavailable', 'timeout',
    'technical difficulties', 'provider error',
    'দুঃখিত', 'সমস্যা', 'এরর', 'চেষ্টা করুন', 'উত্তর দিতে পারছি না', 'ব্যর্থ'
  ];

  if (errorOrFallbackKeywords.some((k) => respLower.includes(k))) return false;

  const uncertaintyKeywords = [
    "i'm not sure", 'i am not sure', 'i do not have information', "i don't know",
    'as an ai', 'consult customer service', 'জানি না', 'নিশ্চিত নই'
  ];

  if (uncertaintyKeywords.some((k) => respLower.includes(k))) return false;

  return true;
}

export interface ProcessResult {
  text: string;
  source: 'learned_skill' | 'knowledge' | 'ai' | 'tool' | 'knowledge_base' | 'llm' | 'fallback';
  similarity: number;
  toolsUsed: string[];
  tokens: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd: number;
  latencyMs: number;
  ttftMs?: number;
  skillId?: string;
  skillName?: string;
  conversationId?: string;
  tokensSaved?: number;
  reasoningNote?: string;
  suggestedChips?: string[];
  debugMetadata?: {
    provider: string;
    model: string;
    requestStartTime: string;
    ttftMs: number;
    totalLatencyMs: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    streamingStatus: 'streaming' | 'completed' | 'fallback';
    executedTools: Array<{ name: string; status: string; resultSummary?: string }>;
    completionDetails?: string;
  };
}

export class AgentCore {
  /**
   * Resolve or initialize conversation session for multi-turn continuity
   */
  private async getOrCreateSession(clientId: string, userRef: string, conversationId?: string): Promise<ConversationSession> {
    const sessionId = conversationId || `conv_${clientId}_${userRef.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    let session = store.conversations.get(sessionId);

    if (!session) {
      session = {
        id: sessionId,
        client_id: clientId,
        user_id: userRef,
        title: 'New Conversation',
        messages: [],
        context: {
          entities: {},
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      // Hydrate from PostgreSQL database to persist conversational memory
      const pool = getPgPool();
      if (pool) {
        try {
          // Check for specific session or latest active session for this user
          let dbConvId: string | null = null;
          
          if (conversationId) {
            const convRes = await pool.query(
              `SELECT id FROM user_conversations WHERE project_id = $1 AND user_id = $2 AND session_id = $3 LIMIT 1`,
              [clientId, userRef, sessionId]
            );
            if (convRes.rows.length > 0) dbConvId = convRes.rows[0].id;
          } else {
            const latestConvRes = await pool.query(
              `SELECT id, session_id FROM user_conversations WHERE project_id = $1 AND user_id = $2 ORDER BY last_message_at DESC LIMIT 1`,
              [clientId, userRef]
            );
            if (latestConvRes.rows.length > 0) {
              dbConvId = latestConvRes.rows[0].id;
              session.id = latestConvRes.rows[0].session_id; // update to the actual latest session id
            }
          }

          if (dbConvId) {
            const msgRes = await pool.query(
              `SELECT id, role, content, created_at FROM user_messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 10`,
              [dbConvId]
            );
            if (msgRes.rows.length > 0) {
              session.messages = msgRes.rows.reverse().map((row: any) => ({
                id: row.id,
                role: row.role as 'user' | 'assistant' | 'system' | 'tool',
                content: row.content,
                timestamp: new Date(row.created_at).toISOString()
              }));
            }
          }
        } catch (err) {
          console.error('[AgentCore] Failed to hydrate conversation session from Postgres:', err);
        }
      }

      store.conversations.set(session.id, session);
    }

    return session;
  }

  /**
   * Main multi-stage processing pipeline:
   * 1. Multi-turn Session & Context Memory Lookup
   * 2. Learned Skill / Tool Strategy Matching (Zero AI API Call)
   * 3. Knowledge Base Semantic Search (Zero AI API Call)
   * 4. AI Teacher & Reasoning Engine (Tool Execution + Response + Autonomous Skill Synthesis)
   */
  async process(options: ProcessInputOptions): Promise<ProcessResult> {
    const started = Date.now();
    const { client, userRef, text, conversationId } = options;

    // 1. Sanitize text & check project suspension
    if (client.suspended) {
      throw new Error('Project is currently suspended');
    }

    const cleanText = text.trim();
    if (!cleanText) {
      throw new Error('Input text cannot be empty');
    }

    if (isPostgresConfigured()) {
      const pool = getPgPool();
      if (!pool) {
        store.pgReady = false;
        throw clientServerError();
      }
      try {
        await pool.query('SELECT 1');
        store.pgReady = true;
      } catch {
        store.pgReady = false;
        knowledgeEngine.clearCache(client.id);
        highSpeedCacheEngine.invalidate(client.id);
        throw clientServerError();
      }
    }

    const traceId = options.traceId || traceService.startTrace(client.id, userRef, {
      query: cleanText,
      projectName: client.name,
    });

    // Step 1: Request Received
    traceService.traceStepStart(traceId, 1, 'Request Received', 'analysis', { text_length: cleanText.length });
    traceService.traceStepComplete(traceId, 1, 'success', 2, { query: cleanText.slice(0, 60) });

    // Step 2: Auth Validated
    traceService.traceEdge(traceId, 1, 2, 'normal');
    traceService.traceStepStart(traceId, 2, 'Auth Validated', 'auth', { client_id: client.id });
    traceService.traceStepComplete(traceId, 2, 'success', 1, { client_name: client.name });

    // Step 3: Rate Limit Check
    traceService.traceEdge(traceId, 2, 3, 'normal');
    traceService.traceStepStart(traceId, 3, 'Rate Limit Check', 'ratelimit');

    // 2. Fetch or create user quota profile
    const userKey = `${client.id}:${userRef}`;
    let user = store.users.get(userKey);
    if (!user) {
      user = {
        id: crypto.randomUUID(),
        client_id: client.id,
        external_id: userRef,
        name: userRef.includes('@') ? userRef.split('@')[0] : userRef,
        email: userRef.includes('@') ? userRef : undefined,
        plan: 'standard',
        blocked: false,
        is_logged_out: false,
        tokens_today: 0,
        tokens_month: 0,
        requests_today: 0,
        requests_month: 0,
        errors_total: 0,
        created_at: new Date().toISOString(),
        last_active: new Date().toISOString(),
      };
      store.users.set(userKey, user);
    }

    // Check if user is blocked - return admin specified block message directly
    if (user.blocked) {
      const blockMessage = user.block_message || 'Your account is suspended by administrator. Access restricted.';
      traceService.traceStepFailed(traceId, 3, 'Rate Limit & User Check', 'User is blocked');
      traceService.completeTrace(traceId, 'failed');
      return {
        text: blockMessage,
        source: 'fallback',
        similarity: 1.0,
        toolsUsed: [],
        tokens: 0,
        costUsd: 0,
        latencyMs: Date.now() - started,
      };
    }

    // Reactivate user if previously logged out
    if (user.is_logged_out) {
      user.is_logged_out = false;
    }

    // 3. Enforce per-project user limits
    if (client.daily_request_limit && user.requests_today >= client.daily_request_limit) {
      const err: any = new Error(`Daily request limit of ${client.daily_request_limit} reached for user '${userRef}'`);
      err.code = 'LIMIT_EXCEEDED';
      err.statusCode = 402;
      traceService.traceStepFailed(traceId, 3, 'Rate Limit Check', err.message);
      traceService.completeTrace(traceId, 'failed');
      throw err;
    }
    if (client.monthly_request_limit && user.requests_month >= client.monthly_request_limit) {
      const err: any = new Error(`Monthly request limit of ${client.monthly_request_limit} reached for user '${userRef}'`);
      err.code = 'LIMIT_EXCEEDED';
      err.statusCode = 402;
      traceService.traceStepFailed(traceId, 3, 'Rate Limit Check', err.message);
      traceService.completeTrace(traceId, 'failed');
      throw err;
    }

    user.requests_today += 1;
    user.requests_month += 1;
    user.last_active = new Date().toISOString();
    markUserActive(client.id, userRef);
    traceService.traceStepComplete(traceId, 3, 'success', 1, { requests_today: user.requests_today });

    // 4. Retrieve multi-turn conversation session & context
    const session = await this.getOrCreateSession(client.id, userRef, conversationId);

    // Context & Repetition Analysis
    const hasHistory = session.messages.length > 0;
    const { isRepeating, isCorrection } = checkUserRepetitionOrRetry(session.messages, cleanText);
    const isContextual = isContextDependentQuery(cleanText, hasHistory);
    const isPersonalOrDynamic = isPersonalOrDynamicQuery(cleanText);
    const isGreeting = isConversationalQuery(cleanText);
    const shouldBypassStaticCache = isRepeating || isCorrection || isPersonalOrDynamic || isGreeting;

    if (isRepeating || isCorrection || isPersonalOrDynamic || isGreeting) {
      // 1. Purge standard static Q&A cached entries for this current message
      knowledgeEngine.invalidateEntry(client.id, cleanText);
      for (const [k, v] of store.knowledge.entries()) {
        if (v.client_id === client.id && v.learned && (v.trigger_text.toLowerCase() === cleanText.toLowerCase() || isPersonalOrDynamicQuery(v.trigger_text))) {
          store.knowledge.delete(k);
        }
      }

      // 2. SELF-CORRECTION PROTOCOL (When user flags a mistake)
      // If user corrects the AI (e.g. saying "ভুল হয়েছে"), find the PREVIOUS trigger text that caused the mistake
      // and purge that wrong learned knowledge/cache/pattern so it is never repeated.
      if (isCorrection && session.messages.length >= 2) {
        let previousUserTrigger: string | null = null;
        let lastAssistantIdx = -1;
        
        // Find the last response index from Assistant
        for (let i = session.messages.length - 1; i >= 0; i--) {
          if (session.messages[i].role === 'assistant') {
            lastAssistantIdx = i;
            break;
          }
        }
        
        if (lastAssistantIdx > 0) {
          // Find the User message immediately preceding that Assistant response
          for (let i = lastAssistantIdx - 1; i >= 0; i--) {
            if (session.messages[i].role === 'user') {
              previousUserTrigger = session.messages[i].content;
              break;
            }
          }
        }

        if (previousUserTrigger) {
          console.log(`[Self-Correction] Purging incorrect patterns & cache for trigger: "${previousUserTrigger}"`);
          
          // Invalidate standard knowledgeEngine
          knowledgeEngine.invalidateEntry(client.id, previousUserTrigger);
          for (const [k, v] of store.knowledge.entries()) {
            if (v.client_id === client.id && v.learned && v.trigger_text.toLowerCase() === previousUserTrigger.toLowerCase()) {
              store.knowledge.delete(k);
            }
          }

          // Invalidate template cached responses (conversational template cache)
          await invalidateCacheByTriggerText(client.id, previousUserTrigger);

          // Invalidate relational patterns
          await knowledgePatternEngine.invalidatePatternByTriggerText(client.id, previousUserTrigger);

          // Broadcast state update to real-time clients so UI lists refresh immediately
          store.notifyBroadcast({
            type: 'knowledge:updated',
            projectId: client.id,
            data: {
              trigger_text: previousUserTrigger,
              response_text: '',
              deleted: true,
            },
          });
        }
      }
    }

    // 4.1 Update User Profile, extract permanent facts & preferences (Never deleted)
    userProfileEngine.extractAndStoreUserData(client.id, userRef, cleanText).catch(() => {});
    const userVars = await userProfileEngine.getUserVariables(client.id, userRef);
    const requestedLang = multiLangEngine.detectLanguageRequest(cleanText);

    if (requestedLang) {
      await userProfileEngine.setPreferredLanguage(client.id, userRef, requestedLang);
      userVars.language = requestedLang;
    }

    let detectedLang = requestedLang;
    if (!detectedLang) {
      detectedLang = multiLangEngine.detectLanguage(cleanText, userVars.language || 'bn');
    }

    // Smart Language Retention & Continuity:
    // Prevent accidental English language switching when users write short English phrases (like "ok", "yes", "api", "thank you", "error", "next", "what about tomorrow")
    // during a predominantly Bengali/Banglish conversational session.
    if (detectedLang === 'en' && !requestedLang) {
      const recentUserMessages = session.messages.filter(m => m.role === 'user');
      let bnCount = 0;
      let enCount = 0;

      for (const msg of recentUserMessages.slice(-8)) {
        const lang = multiLangEngine.detectLanguage(msg.content, 'bn');
        if (lang === 'bn' || lang === 'banglish') bnCount++;
        else if (lang === 'en') enCount++;
      }

      // If user profile preference is Bengali OR past messages are mostly Bengali, keep Bengali!
      const userPreferredBn = !userVars.language || userVars.language === 'bn' || userVars.language === 'auto';
      const wordCount = cleanText.split(/\s+/).filter(Boolean).length;
      const isShortOrMixed = wordCount <= 12;

      if ((bnCount > 0 || userPreferredBn) && (isShortOrMixed || bnCount >= enCount)) {
        detectedLang = 'bn';
      }
    }

    // ==========================================
    // STAGE 0.1: HIGH-SPEED INTENT CLASSIFICATION
    // ==========================================
    options.onProgress?.('intent_classification', 'Running dynamic intent classification...');
    const classificationResult = await classifyIntent(client.id, cleanText);

    // Log the classification result in the trace service for visibility
    traceService.traceStepStart(traceId, 39, 'Dynamic Intent Classification', 'analysis', { query: cleanText });
    traceService.traceStepComplete(traceId, 39, 'success', Date.now() - started, classificationResult);

    // If intent is conversational chat, check the template cache for a zero-API instant execution
    if (classificationResult.intent === 'chat' && !shouldBypassStaticCache) {
      options.onProgress?.('cache_lookup', 'Checking conversational template cache...');
      const cachedResponseText = await getCachedResponse(client.id, cleanText, detectedLang);

      if (cachedResponseText) {
        const latencyMs = Date.now() - started;
        const ttftMs = Math.min(latencyMs, 10);
        // Estimate saved tokens: ~400 tokens system instructions + prompt size + answer size
        const tokensSaved = Math.max(150, Math.ceil((cleanText.length + cachedResponseText.length) / 3.2) + 400);

        if (options.onChunk) {
          options.onChunk(cachedResponseText);
        }

        const nowIso = new Date().toISOString();
        session.messages.push(
          { id: crypto.randomUUID(), role: 'user', content: cleanText, timestamp: nowIso },
          { id: crypto.randomUUID(), role: 'assistant', content: cachedResponseText, timestamp: nowIso, source: 'knowledge_base' }
        );
        if (session.messages.length > 10) session.messages.splice(0, session.messages.length - 10);
        session.updated_at = nowIso;

        // Log to conversation history relational DB
        knowledgePatternEngine.logConversationMessage({
          projectId: client.id,
          userId: userRef,
          sessionId: session.id,
          role: 'assistant',
          content: cachedResponseText,
          wasAiCalled: false,
          executionTimeMs: latencyMs,
          tokensUsed: 0,
          language: detectedLang,
          savedTokens: tokensSaved,
        }).catch(() => {});

        store.logExecution(
          client.id,
          userRef,
          cleanText,
          cachedResponseText,
          'knowledge',
          0,
          0.0,
          latencyMs,
          200,
          tokensSaved
        );

        return {
          text: cachedResponseText,
          source: 'knowledge',
          similarity: 1.0,
          toolsUsed: [],
          tokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0.0,
          latencyMs,
          ttftMs,
          conversationId: session.id,
          tokensSaved,
          reasoningNote: `Retrieved from conversational template cache with 100% token savings (0 AI API call).`,
          debugMetadata: {
            provider: 'template_cache_engine',
            model: 'fast-local-cache',
            requestStartTime: new Date(started).toISOString(),
            ttftMs,
            totalLatencyMs: latencyMs,
            inputTokens: 0,
            outputTokens: Math.ceil(cachedResponseText.length / 4),
            totalTokens: 0,
            estimatedCostUsd: 0.0,
            streamingStatus: 'completed',
            executedTools: [],
            completionDetails: `Returned pre-rendered chat greeting response with zero latency & zero API cost.`,
          },
        };
      }
    }

    // Log user message to 24-hour retention database
    knowledgePatternEngine.logConversationMessage({
      projectId: client.id,
      userId: userRef,
      sessionId: session.id,
      role: 'user',
      content: cleanText,
      wasAiCalled: false,
      executionTimeMs: 0,
      tokensUsed: 0,
      language: detectedLang,
    }).catch(() => {});

    // Step 4: Message Analysis
    traceService.traceEdge(traceId, 3, 4, 'normal');
    traceService.traceStepStart(traceId, 4, 'Message Analysis', 'analysis');
    traceService.traceStepComplete(traceId, 4, 'success', 2, { language: detectedLang });

    // Step 5: User Profile Load
    traceService.traceEdge(traceId, 4, 5, 'normal');
    traceService.traceStepStart(traceId, 5, 'User Profile Load', 'profile');
    traceService.traceStepComplete(traceId, 5, 'success', 1, { user_plan: user.plan });

    // Step 6: Knowledge Search
    traceService.traceEdge(traceId, 5, 6, 'normal');
    traceService.traceStepStart(traceId, 6, 'Knowledge Search', 'knowledge');

    // 4.2 STAGE 0: HighLyAgent Relational Knowledge Pattern System (Tables 1-17 with Anti-Repetition Rotation)
    let patternMatch: any = null;
    if (!shouldBypassStaticCache) {
      options.onProgress?.('pattern_matching', 'Scanning relational knowledge patterns (0-API)...');
      const isOngoing = session.messages.length > 0;
      patternMatch = await knowledgePatternEngine.matchPattern(client.id, cleanText, detectedLang, userRef, isOngoing);
    }

    if (patternMatch) {
      // Direct Execution (Confidence >= 95%)
      if (patternMatch.decision === 'DIRECT_EXECUTION') {
        options.onProgress?.('pattern_execution', `Executing verified knowledge pattern "${patternMatch.pattern.intent}" (0-API)...`, {
          intent: patternMatch.pattern.intent,
          confidence: patternMatch.confidence,
        });

        traceService.traceStepComplete(traceId, 6, 'success', 5, {
          match_found: true,
          confidence: patternMatch.confidence,
          intent: patternMatch.pattern.intent,
        });
        traceService.traceEdge(traceId, 6, 7, 'condition_true', `Match ≥95% (${(patternMatch.confidence * 100).toFixed(0)}%)`);
        traceService.traceStepStart(traceId, 7, 'Pattern Match Check', 'condition', { match: true, confidence: patternMatch.confidence });
        traceService.traceStepComplete(traceId, 7, 'success', 1, { direct_execute: true });

        const patternExec = await knowledgePatternEngine.executePattern(patternMatch, client.id, userRef);

        const latencyMs = Date.now() - started;
        const ttftMs = Math.min(latencyMs, 10);
        const tokensSaved = Math.max(150, Math.ceil((cleanText.length + patternExec.text.length) / 3.2));

        if (options.onChunk) {
          options.onChunk(patternExec.text);
        }

        // Mark AI Provider Call as Skipped
        traceService.traceStepStart(traceId, 8, 'AI Provider Call', 'ai', {
          skipped: true,
          reason: 'Cache Hit (≥95% Pattern Match)',
          provider: 'gemini',
          model: 'gemini-2.5-flash',
        });
        traceService.traceStepComplete(traceId, 8, 'skipped', 0, {
          skipped: true,
          reason: '0-API Cache Hit',
          tokens_saved: tokensSaved,
        });

        traceService.traceEdge(traceId, 7, 15, 'skip', 'Skipped (Cache Hit)');
        traceService.traceStepStart(traceId, 15, 'Response Generation', 'response', { source: 'knowledge_pattern' });
        traceService.traceStepComplete(traceId, 15, 'success', 4, { length: patternExec.text.length });

        traceService.traceEdge(traceId, 15, 16, 'normal');
        traceService.traceStepStart(traceId, 16, 'Response Sent', 'success');
        traceService.traceStepComplete(traceId, 16, 'success', 1);

        traceService.traceEdge(traceId, 16, 17, 'normal');
        traceService.traceStepStart(traceId, 17, 'Learning Save', 'learning');
        traceService.traceStepComplete(traceId, 17, 'success', 2);

        traceService.traceEdge(traceId, 17, 18, 'normal');
        traceService.traceStepStart(traceId, 18, 'History Save', 'success');
        traceService.traceStepComplete(traceId, 18, 'success', 1);

        traceService.completeTrace(traceId, 'success', latencyMs, {
          response: patternExec.text,
          tokensUsed: 0,
          tokensSaved,
          source: 'knowledge',
        });

        const nowIso = new Date().toISOString();
        session.messages.push(
          { id: crypto.randomUUID(), role: 'user', content: cleanText, timestamp: nowIso },
          { id: crypto.randomUUID(), role: 'assistant', content: patternExec.text, timestamp: nowIso, source: 'knowledge_base' }
        );
        if (session.messages.length > 10) session.messages.splice(0, session.messages.length - 10);
        session.updated_at = nowIso;

        // Log to 24-hour retention database
        knowledgePatternEngine.logConversationMessage({
          projectId: client.id,
          userId: userRef,
          sessionId: session.id,
          role: 'assistant',
          content: patternExec.text,
          detectedPatternId: patternMatch.pattern.id,
          detectedIntent: patternMatch.pattern.intent,
          confidenceScore: patternMatch.confidence,
          executedSteps: patternExec.toolsUsed,
          finalAnswer: patternExec.text,
          wasAiCalled: false,
          executionTimeMs: latencyMs,
          tokensUsed: 0,
          language: detectedLang,
          savedTokens: tokensSaved,
        }).catch(() => {});

        store.logExecution(
          client.id,
          userRef,
          cleanText,
          patternExec.text,
          'knowledge',
          0,
          0.0,
          latencyMs,
          200,
          tokensSaved
        );

        const directResult: ProcessResult = {
          text: patternExec.text,
          source: 'knowledge',
          similarity: patternMatch.confidence,
          toolsUsed: patternExec.toolsUsed,
          tokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0.0,
          latencyMs,
          ttftMs,
          conversationId: session.id,
          tokensSaved,
          suggestedChips: patternExec.suggestedChips,
          reasoningNote: `Matched Knowledge Pattern "${patternMatch.pattern.intent}" with ${(patternMatch.confidence * 100).toFixed(0)}% confidence (0 AI API call, dynamic rotation).`,
          debugMetadata: {
            provider: 'knowledge_pattern_system',
            model: 'relational-pattern-v2',
            requestStartTime: new Date(started).toISOString(),
            ttftMs,
            totalLatencyMs: latencyMs,
            inputTokens: 0,
            outputTokens: Math.ceil(patternExec.text.length / 4),
            totalTokens: 0,
            estimatedCostUsd: 0.0,
            streamingStatus: 'completed',
            executedTools: patternExec.toolsUsed.map((t) => ({ name: t, status: 'success' })),
            completionDetails: `Executed knowledge pattern (${patternMatch.pattern.intent}) with 100% token savings and dynamic anti-repetition rotation.`,
          },
        };

        return directResult;
      } else if (patternMatch.decision === 'ASK_CONFIRMATION') {
        // 70% - 94% Confidence: Ask user confirmation or request missing input
        const patternExec = await knowledgePatternEngine.executePattern(patternMatch, client.id, userRef);
        let clarificationText = patternExec.text;

        if (!patternExec.isClarification) {
          clarificationText = detectedLang === 'bn'
            ? `আপনি কি "${patternMatch.pattern.description || patternMatch.pattern.intent}" সম্পর্কে জানতে চাচ্ছেন? দয়া করে নিশ্চিত করুন।`
            : `Are you asking about "${patternMatch.pattern.description || patternMatch.pattern.intent}"? Please confirm.`;
        }

        const latencyMs = Date.now() - started;
        if (options.onChunk) {
          options.onChunk(clarificationText);
        }

        const nowIso = new Date().toISOString();
        session.messages.push(
          { id: crypto.randomUUID(), role: 'user', content: cleanText, timestamp: nowIso },
          { id: crypto.randomUUID(), role: 'assistant', content: clarificationText, timestamp: nowIso, source: 'knowledge_base' }
        );

        knowledgePatternEngine.logConversationMessage({
          projectId: client.id,
          userId: userRef,
          sessionId: session.id,
          role: 'assistant',
          content: clarificationText,
          detectedPatternId: patternMatch.pattern.id,
          detectedIntent: patternMatch.pattern.intent,
          confidenceScore: patternMatch.confidence,
          wasAiCalled: false,
          executionTimeMs: latencyMs,
          tokensUsed: 0,
          language: detectedLang,
        }).catch(() => {});

        const chips = patternExec.suggestedChips || [
          'হ্যাঁ, নিশ্চিত করুন',
          'না, অন্য কিছু জানতে চাই',
          'কাস্টমার সাপোর্টে কথা বলতে চাই',
        ];

        return {
          text: clarificationText,
          source: 'knowledge',
          similarity: patternMatch.confidence,
          toolsUsed: [],
          tokens: 0,
          costUsd: 0.0,
          latencyMs,
          conversationId: session.id,
          suggestedChips: chips,
          reasoningNote: `Confidence at ${(patternMatch.confidence * 100).toFixed(0)}% - Clarifying user intent before execution.`,
        };
      }
    }

    // 5. STAGE 1: Check Learned Skill & Tool Strategy Engine (Zero AI API Call)
    let skillMatch: any = null;
    if (!shouldBypassStaticCache) {
      options.onProgress?.('skill_matching', 'Scanning learned skill patterns & tool strategies...');
      skillMatch = await skillEngine.searchSkill(client.id, cleanText, session.context.entities);
    }

    if (skillMatch && skillMatch.isExactOrHighConfidence) {
      options.onProgress?.('skill_execution', `Executing verified learned skill "${skillMatch.skill.name}" (0-API)...`, {
        skill_id: skillMatch.skill.id,
        skill_name: skillMatch.skill.name,
      });

      const skillExec = await skillEngine.executeSkill(
        skillMatch.skill,
        skillMatch.extractedSlots,
        client.id,
        userRef
      );

      if (skillExec.success) {
        const latencyMs = Date.now() - started;
        const ttftMs = Math.min(latencyMs, 12);
        const tokensSaved = Math.max(120, Math.ceil((cleanText.length + skillExec.text.length) / 3.2));

        // If streaming requested, emit chunks
        if (options.onChunk) {
          options.onChunk(skillExec.text);
        }

        // Update multi-turn context memory
        Object.assign(session.context.entities, skillMatch.extractedSlots);
        if (skillExec.toolsUsed.length > 0) {
          session.context.last_tool = skillExec.toolsUsed[0];
          session.context.last_result = skillExec.results;
        }

        // Add to session history
        const nowIso = new Date().toISOString();
        session.messages.push(
          { id: crypto.randomUUID(), role: 'user', content: cleanText, timestamp: nowIso },
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: skillExec.text,
            timestamp: nowIso,
            source: 'learned_skill',
            skill_id: skillMatch.skill.id,
          }
        );
        if (session.messages.length > 10) session.messages.splice(0, session.messages.length - 10);
        session.updated_at = nowIso;

        knowledgePatternEngine.logConversationMessage({
          projectId: client.id,
          userId: userRef,
          sessionId: session.id,
          role: 'assistant',
          content: skillExec.text,
          wasAiCalled: false,
          executionTimeMs: latencyMs,
          tokensUsed: 0,
          language: detectedLang,
        }).catch(() => {});

        // Log execution as zero-cost learned skill
        store.logExecution(
          client.id,
          userRef,
          cleanText,
          skillExec.text,
          'learned_skill',
          0,
          0.0,
          latencyMs,
          200,
          tokensSaved
        );

        return {
          text: skillExec.text,
          source: 'learned_skill',
          similarity: skillMatch.confidence,
          toolsUsed: skillExec.toolsUsed,
          tokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0.0,
          latencyMs,
          ttftMs,
          skillId: skillMatch.skill.id,
          skillName: skillMatch.skill.name,
          conversationId: session.id,
          tokensSaved,
          reasoningNote: `Executed learned skill "${skillMatch.skill.name}" with ${(skillMatch.confidence * 100).toFixed(0)}% confidence without AI API call.`,
          debugMetadata: {
            provider: 'learned_skill_engine',
            model: 'zero-api-deterministic',
            requestStartTime: new Date(started).toISOString(),
            ttftMs,
            totalLatencyMs: latencyMs,
            inputTokens: 0,
            outputTokens: Math.ceil(skillExec.text.length / 4),
            totalTokens: 0,
            estimatedCostUsd: 0.0,
            streamingStatus: 'completed',
            executedTools: skillExec.toolsUsed.map((t) => ({ name: t, status: 'success' })),
            completionDetails: `Executed local skill strategy (${skillMatch.skill.name}) with 100% token savings.`,
          },
        };
      }
    }

    // 6. STAGE 2: Search Manual Knowledge Base to inject as AI context (Zero AI Bypass/Direct Answering)
    let manualKnowledgeContext = '';
    try {
      options.onProgress?.('knowledge_matching', 'Looking up relevant project manual knowledge...');
      const kbMatch = await knowledgeEngine.search(client.id, cleanText, 0.70);
      if (kbMatch && kbMatch.entry) {
        manualKnowledgeContext = `\n--- RELEVANT VERIFIED REFERENCE FACTS ---\nQuestion/Trigger: "${kbMatch.entry.trigger_text}"\nVerified Answer/Information: "${kbMatch.entry.response_text}"\n\nINSTRUCTION: The above facts are verified for the project. You MUST use this verified answer/information to construct a natural, warm, and highly accurate response for the user. Do NOT repeat old incorrect behaviors or generate raw formatting.`;
        console.log(`[Agent] Injecting verified knowledge context for query "${cleanText}": ${kbMatch.entry.trigger_text}`);
      }
    } catch (err: any) {
      console.warn('[Agent] Knowledge context injection search failed:', err.message);
    }

    // 7. STAGE 3: AI Teacher & Reasoning Engine Mode
    // Here AI API is engaged as the reasoning intelligence: understanding the task, choosing tools, executing, answering, and teaching HighLyAgent!
    traceService.traceStepComplete(traceId, 6, 'success', 6, { match_found: false });
    traceService.traceEdge(traceId, 6, 7, 'condition_false', 'Match <95% (No)');
    traceService.traceStepStart(traceId, 7, 'Pattern Match Check', 'condition');
    traceService.traceStepComplete(traceId, 7, 'success', 1, { fallback_to_ai: true });

    const toolsUsed: string[] = [];
    const toolResultsList: any[] = [];
    let toolsContext = '';
    let plannedTools: any[] = [];

    // Selective dynamic tool retrieval based on classified intent & needs_tools
    let relevantSemanticTools: any[] = [];
    let compactToolsSchema = '';

    if (classificationResult.needs_tools) {
      options.onProgress?.('tool_search', 'Performing semantic search for top matching tools...');
      relevantSemanticTools = await getSemanticTools(client.id, cleanText, 2);

      if (relevantSemanticTools.length > 0) {
        compactToolsSchema = '\n\n--- COMPACT AVAILABLE TOOLS SCHEMA ---\n' +
          relevantSemanticTools.map(t => `- Tool: ${t.name}\n  Schema: ${t.compact_schema || t.description}`).join('\n') +
          '\n--- END TOOLS SCHEMA ---';

        // Filter standard trigger detection to only run if the tool name is in the semantic matches
        const rawPlanned = toolEngine.detectToolsForQuery(cleanText);
        plannedTools = rawPlanned.filter(pt => relevantSemanticTools.some(rst => rst.name === pt.name));
      }
    }

    if (plannedTools.length > 0) {
      traceService.traceEdge(traceId, 7, 10, 'normal');
      traceService.traceStepStart(traceId, 10, 'Tool Sequence Plan', 'tool', { planned_tools: plannedTools.map((t) => t.name) });
      traceService.traceStepComplete(traceId, 10, 'success', 2);
      traceService.traceEdge(traceId, 10, 11, 'condition_true', 'Inputs Ready');
      traceService.traceStepStart(traceId, 11, 'Missing Input Check', 'condition');
      traceService.traceStepComplete(traceId, 11, 'success', 1);

      options.onProgress?.('tool_planning', `Detected required tools: ${plannedTools.map((t) => t.name).join(', ')}`);
      for (const t of plannedTools) {
        const isInternalContext = ['get_user_context', 'set_user_context', 'get_user_profile'].includes(t.name);
        const registeredTool = Array.from(store.tools.values()).find(
          (pt) => pt.name.toLowerCase() === t.name.toLowerCase() && (pt.client_id === client.id || pt.client_id === null || !pt.client_id || pt.scope === 'system')
        );

        if (isInternalContext || (registeredTool && registeredTool.enabled)) {
          options.onProgress?.('tool_execution', `Executing tool: ${t.name}(${JSON.stringify(t.args)})...`, {
            tool: t.name,
            args: t.args,
          });
          const toolStart = Date.now();
          traceService.traceEdge(traceId, 11, 12, 'tool_call', `Tool: ${t.name}`);
          traceService.traceStepStart(traceId, 12, `Tool: ${t.name}`, 'tool', t.args);
          traceService.traceToolCalled(traceId, 12, t.name, 'server', t.args);

          const res = await toolEngine.executeServerTool(t.name, t.args, client.id, userRef);
          
          // Dynamically summarize verbose tool outputs to optimize input token sizes
          let resultString = res.result ? (typeof res.result === 'object' ? JSON.stringify(res.result) : String(res.result)) : '';
          if (resultString.length > 800) {
            options.onProgress?.('tool_summarization', `Summarizing large output from tool ${t.name}...`);
            resultString = await summarizeToolOutputIfLarge(t.name, resultString);
          }

          toolsUsed.push(t.name);
          toolResultsList.push(res.result);
          traceService.traceStepComplete(traceId, 12, 'success', Date.now() - toolStart, res.result);

          traceService.traceEdge(traceId, 12, 13, 'normal');
          traceService.traceStepStart(traceId, 13, 'Tool Result Processing', 'analysis');
          traceService.traceStepComplete(traceId, 13, 'success', 2);

          if (resultString) {
            toolsContext += `Tool '${t.name}' Summary/Execution Output: ${resultString}\n`;
          }
        }
      }
    }

    // Assemble conversation context from previous turns with smart token-saving logic
    let recentHistory = '';
    const wordCount = (cleanQ: string) => cleanQ.split(/\s+/).filter(Boolean).length;
    const cleanWordCount = wordCount(cleanText);

    // We only load previous chat history IF:
    // 1. Intent classifier suggests history is needed
    // 2. The query is contextual (depends on prior pronouns/context)
    // 3. The query is a repetition/correction
    // 4. The query is extremely short (<= 4 words, which might be continuation/feedback like "ok", "yes", "how", "why")
    // Otherwise, for standalone questions/independent queries, we bypass history to save huge input tokens!
    const needsHistory = classificationResult.needs_history || isContextual || isCorrection || isRepeating || cleanWordCount <= 4;

    if (hasHistory && needsHistory) {
      // Limit to last 3 messages to preserve immediate context while saving substantial token costs
      const recent = session.messages.slice(-3);
      recentHistory = recent.map((m) => {
        // Trim individual historical messages to avoid huge block copy tokens
        const trimmedContent = m.content.length > 120 ? m.content.slice(0, 120) + '...' : m.content;
        return `${m.role.toUpperCase()}: ${trimmedContent}`;
      }).join('\n');
    }

    let contextNotice = '';
    if (isRepeating || isCorrection) {
      contextNotice = `\n--- REASONING NOTICE ---\nThe user is repeating their question or requesting a correction/variation. Their previous message may have received an unsatisfactory or incorrect response. DO NOT repeat previous output verbatim. Provide a fresh, accurate, refined, and helpful response.`;
    } else if (isContextual && hasHistory) {
      contextNotice = `\n--- CONTEXT NOTICE ---\nThis user message depends on prior context. Pay close attention to previous conversation messages, user intent, pronouns, and references.`;
    }

    let languageDirective = `CRITICAL NATIVE SCRIPT & TTS COMPLIANCE DIRECTIVE:
1. If the user communicated in BENGALI (বাংলা) OR BANGLISH (Romanized Bengali, e.g. "kemon acho", "apnar ki kaj", "bujhte parlam na"), you MUST ALWAYS respond in standard, fluent BENGALI SCRIPT (বাংলা লিপি). NEVER output Romanized Banglish. This ensures that Text-to-Speech (TTS) voice synthesis sounds crisp, natural, and human.
2. If the user communicated in HINDI or HINGLISH, you MUST ALWAYS respond in standard DEVANAGARI HINDI (हिन्दी). NEVER output Romanized Hinglish.
3. If the user writes a short English word or technical term (e.g. "ok", "error", "api", "thanks", "done") in an ongoing Bengali conversation, DO NOT switch to English! Continue responding in fluent Bengali (বাংলা).
4. ONLY switch completely to English if the user explicitly asks to speak in English (e.g. "please speak in English", "ইংলিশে বলো", "english please") or if the conversation is conducted in English.`;

    if (detectedLang === 'en') {
      languageDirective = 'CRITICAL LANGUAGE DIRECTIVE: The user explicitly communicated in or requested ENGLISH. Respond completely, naturally, and fluently in ENGLISH.';
    } else if (detectedLang === 'bn' || detectedLang === 'banglish') {
      languageDirective = 'CRITICAL LANGUAGE DIRECTIVE: The user communicated in BENGALI (বাংলা) or BANGLISH. You MUST respond completely, naturally, and fluently in standard BENGALI (বাংলা লিপি). NEVER output Romanized Banglish so Text-to-Speech (TTS) audio output is natural and clear.';
    } else if (detectedLang === 'hi') {
      languageDirective = 'CRITICAL LANGUAGE DIRECTIVE: The user communicated in HINDI (हिन्दी) or HINGLISH. You MUST respond in standard DEVANAGARI HINDI (हिन्दी).';
    } else if (detectedLang === 'ar') {
      languageDirective = 'CRITICAL LANGUAGE DIRECTIVE: Respond in standard Arabic (العربية).';
    }

    const isSystemUserVal = (name: string | undefined): boolean => {
      if (!name) return true;
      const clean = name.toLowerCase().trim();
      return (
        clean.startsWith('usr_') ||
        clean.startsWith('req_') ||
        clean.startsWith('conv_') ||
        clean === 'anonymous' ||
        clean === 'test_user' ||
        clean === 'test' ||
        /^[a-f0-9-]{36}$/i.test(clean) ||
        /^[0-9a-fA-F]+$/.test(clean)
      );
    };

    const actualUserName = isSystemUserVal(user.name) ? '' : user.name;
    const userGreetingDirective = actualUserName
      ? `The user's real name is "${actualUserName}". Address them politely using their name when greeting or replying.`
      : `The user's identity is system-generated or anonymous (ID: ${userRef}). NEVER address them by this system ID (e.g., do NOT say "usr_test_123" or similar in your greeting or response). Instead, address them politely as a customer or friend, such as "সুপ্রিয় গ্রাহক", "প্রিয় গ্রাহক", or "বন্ধু" in Bengali, or "valued customer" or "friend" in English.`;

    // Format saved user facts and preferences for the AI model
    let savedUserFactsNotice = '';
    if (userVars) {
      const activeName = userVars.user_name || actualUserName;
      const isPersonalOrDynamicText = isPersonalOrDynamicQuery(cleanText);
      const factEntries = Object.entries(userVars).filter(
        ([key]) => !['user_id', 'user_name', 'user_role', 'user_state', 'language', 'timezone'].includes(key) && !key.startsWith('pref_')
      );
      const prefEntries = Object.entries(userVars).filter(([key]) => key.startsWith('pref_'));

      if (activeName || factEntries.length > 0 || prefEntries.length > 0) {
        savedUserFactsNotice = `\n--- RETRIEVED USER PROFILE & MEMORIES ---`;
        if (activeName) {
          savedUserFactsNotice += `\nName: ${activeName}`;
        }
        if (prefEntries.length > 0) {
          savedUserFactsNotice += `\nUser Preferences (Saved Permanently):\n` + 
            prefEntries.map(([k, v]) => `- ${k.replace(/^pref_/, '')}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n');
        }
        if (factEntries.length > 0 && isPersonalOrDynamicText) {
          savedUserFactsNotice += `\nFacts learned about the user in past conversations:\n` + 
            factEntries.map(([k, v]) => `- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n');
        }
        savedUserFactsNotice += `\nUse these saved user preferences and learned facts to personalize your responses, talk in their preferred style/voice/language, and answer questions seamlessly.`;
      } else if (activeName) {
        savedUserFactsNotice = `\n--- USER IDENTITY ---\nActive User Name: ${activeName}\nGreeting: Greet them warmly and politely using this name when appropriate.`;
      }
    }

    const activeProjectName = client.name || 'HighLyAgent';
    const projectIdentityDirective = `\n--- PROJECT & AGENT IDENTITY DIRECTIVE ---
1. You are the official AI Assistant for the project named "${activeProjectName}".
2. When the user greets you or asks about your identity, who you are, what your name is, or what project you belong to (e.g. "তুমি কে?", "আপনি কে?", "তোমার নাম কি?", "আপনার নাম কি?", "who are you?", "what is your name?", "introduce yourself"):
   - You MUST introduce yourself clearly as the official AI assistant of "${activeProjectName}".
   - Example Bengali response: "আমি ${activeProjectName}-এর ভার্চুয়াল এআই অ্যাসিস্ট্যান্ট। আজ আপনাকে কীভাবে সাহায্য করতে পারি?"
   - Example English response: "I am the official AI assistant for ${activeProjectName}. How can I help you today?"
3. NEVER introduce yourself with default generic names such as "Google Assistant", "ChatGPT", "Gemini", or "HighLyAgent" unless the project name itself is HighLyAgent. Always state "${activeProjectName}".
4. CRITICAL SALAM / GREETING DIRECTIVE:
   If the user greets you with "আসসালামু আলাইকুম", "সালাম", "salam", "assalamualaikum", or any variation:
   - You MUST ALWAYS first answer the Salam politely and beautifully. For example, in Bengali: "ওয়ালাইকুম আসসালাম ওয়া রাহমাতুল্লাহি ওয়া বারাকাতুহু।".
   - Follow it up warmly, and ask how you can help them today.
   - You MUST vary your phrasing and wording naturally across different turns rather than repeating the exact same sentence every single time. For example: "কেমন আছেন? আজ আপনাকে কীভাবে সাহায্য করতে পারি?", "শুভ সকাল! আপনার দিনটি কেমন যাচ্ছে? আজ আপনার জন্য কী করতে পারি?", "আশা করি ভালো আছেন। আজ কোনো বিষয়ে সহযোগিতা লাগবে?", "ওয়ালাইকুম আসসালাম! আশা করি আল্লাহর রহমতে ভালো আছেন। আজ কীভাবে আপনার পাশে থাকতে পারি?" etc. This ensures conversational naturalness, warmth, and variety.`;

    const directivesList = [
      'Answer the user clearly, conversationally, and accurately.',
      toolsUsed.length > 0
        ? `When tool execution outputs are provided below (from '${toolsUsed.join("', '")}'), summarize their factual numbers and details into a natural, conversational response for the user. NEVER output raw JSON objects, debugging tags, or tool execution code. Output only the clean, helpful human answer.`
        : '',
      'Keep responses structured, concise, and factual.',
      `${languageDirective} DO NOT append redundant translations in parentheses or asterisks at the end.`
    ].filter(Boolean);

    const reasoningDirectives = `\n--- REASONING DIRECTIVES ---\n` + 
      directivesList.map((d, i) => `${i + 1}. ${d}`).join('\n');

    const teacherSystemPrompt = [
      client.system_prompt || `You are the helpful AI assistant for ${activeProjectName}.`,
      client.behavior_description,
      projectIdentityDirective,
      `\n--- USER IDENTITY DIRECTIVE ---\n${userGreetingDirective}`,
      savedUserFactsNotice,
      manualKnowledgeContext, // Inject matched manual Q&A items as high-priority reference facts for the AI
      compactToolsSchema, // Include the compact semantic tool schemas
      recentHistory ? `\n--- PREVIOUS CONVERSATION CONTEXT ---\n${recentHistory}\n--- END CONTEXT ---` : '',
      contextNotice,
      reasoningDirectives,
    ]
      .filter(Boolean)
      .join('\n\n');

    // Dynamically resolve provider & model
    // Prioritize system-wide primary provider if set, otherwise project settings, otherwise fallback
    const sysPrimary = store.fallbackConfig.primary_provider;
    const sysPrimaryModel = store.fallbackConfig.primary_model;
    
    // If project explicitly has a different provider that is enabled, and we don't want to force system primary, 
    // actually, let's prefer the system's active primary provider if the user set it.
    let configuredProvider = sysPrimary || client.ai_provider || 'gemini';
    
    if (!store.providers.has(configuredProvider) || store.providers.get(configuredProvider)?.enabled === false) {
      configuredProvider = client.ai_provider && store.providers.has(client.ai_provider) && store.providers.get(client.ai_provider)?.enabled !== false
        ? client.ai_provider
        : 'gemini';
    }

    const providerRecord = store.providers.get(configuredProvider);
    let configuredModel = client.ai_model || sysPrimaryModel || providerRecord?.model || providerRecord?.models?.[0] || 'gemini-2.5-flash';
    
    // If the selected model doesn't belong to the provider, fix it
    if (providerRecord && providerRecord.models && providerRecord.models.length > 0 && !providerRecord.models.includes(configuredModel) && configuredModel !== providerRecord.model) {
       configuredModel = providerRecord.model || providerRecord.models[0];
    }

    const providerToUse = configuredProvider;
    const modelToUse = configuredModel;

    options.onProgress?.('ai_inference', `Streaming response from provider (${providerToUse} - ${modelToUse})...`, {
      provider: providerToUse,
      model: modelToUse,
    });

    traceService.traceEdge(traceId, toolsUsed.length > 0 ? 13 : 7, 8, 'ai_call', 'AI Provider Call');
    // Note: Trace calls for individual provider attempts are now handled inside providers.ts streamComplete()
    // which logs each attempt with its own step number (8, 9, 10, etc.)

    const completion = await providerPool.streamComplete(
      {
        provider: providerToUse,
        model: modelToUse,
        systemPrompt: teacherSystemPrompt,
        prompt: cleanText,
        temperature: client.temperature ?? 0.4,
        maxTokens: client.max_tokens ?? 1024,
        toolsContext: toolsContext || undefined,
        traceId, // Pass traceId to providers.ts for internal tracing
      },
      options.onChunk
    );

    const latencyMs = Date.now() - started;
    // providers.ts already traces all provider attempts (step 8, 9, 10, etc.)
    // Update user token limits
    user.tokens_today += completion.tokens;
    user.tokens_month += completion.tokens;

    // 8. AUTONOMOUS SKILL & KNOWLEDGE SYNTHESIS
    const isQualityResponse = isValidForAutoLearning(cleanText, completion.text, shouldBypassStaticCache);
    const isSubstantialQuery = cleanText.trim().length >= 3;
    const shouldAutoLearn = options.autoLearn !== false && process.env.AUTO_LEARN !== 'false';

    let learnedSkillObj: any = null;
    if (shouldAutoLearn && isSubstantialQuery && isQualityResponse) {
      // 1. Auto-learn into Relational Knowledge Pattern Engine (Q&A and Tool Workflows)
      knowledgePatternEngine.autoLearnPattern(
        client.id,
        cleanText,
        completion.text,
        toolsUsed,
        toolResultsList,
        userRef,
        plannedTools
      ).catch((err) => {
        console.warn('[AgentCore] Auto-learn pattern error:', err?.message || err);
      });

      // 2. Auto-learn into Knowledge Base (store.knowledge) so Knowledge Base UI displays it
      knowledgeEngine.learn(
        client.id,
        cleanText,
        completion.text,
        toolsUsed.map(t => ({ name: t })),
        true,
        toolsUsed.length > 0 ? 'workflow' : 'general_faq'
      ).catch((err) => {
        console.warn('[AgentCore] Knowledge base learn error:', err?.message || err);
      });

      // 3. Notify UI via WebSocket broadcast so UI updates real-time
      store.notifyBroadcast({
        type: 'knowledge:updated',
        projectId: client.id,
        data: {
          trigger_text: cleanText,
          response_text: completion.text,
          tools_used: toolsUsed,
        },
      });

      // 4. Synthesize reusable skill if tools were used
      if (toolsUsed.length > 0) {
        options.onProgress?.('skill_synthesis', 'AI Teacher completed task. Synthesizing new reusable skill...');
        learnedSkillObj = await skillEngine.synthesizeSkillFromAI(
          client.id,
          cleanText,
          toolsUsed,
          toolResultsList,
          completion.text
        ).catch(() => null);
      }
    }

    // Append to conversation session
    const nowIso = new Date().toISOString();
    session.messages.push(
      { id: crypto.randomUUID(), role: 'user', content: cleanText, timestamp: nowIso },
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: completion.text,
        timestamp: nowIso,
        source: toolsUsed.length > 0 ? 'tool' : 'ai',
      }
    );
    if (session.messages.length > 10) session.messages.splice(0, session.messages.length - 10);
    session.updated_at = nowIso;

    if (classificationResult.intent === 'chat' && !shouldBypassStaticCache) {
      saveCachedResponse(client.id, cleanText, completion.text, detectedLang).catch(() => {});
    }

    let computedTokensSaved = 0;
    if (!classificationResult.needs_tools) {
      computedTokensSaved += 1200; // average schemas saved
    }
    if (!needsHistory && hasHistory) {
      const historyLength = session.messages.map(m => m.content.length).reduce((a, b) => a + b, 0);
      computedTokensSaved += Math.ceil(historyLength / 3.8);
    }

    // Log message to 24-hour retention relational table
    knowledgePatternEngine.logConversationMessage({
      projectId: client.id,
      userId: userRef,
      sessionId: session.id,
      role: 'assistant',
      content: completion.text,
      wasAiCalled: true,
      executionTimeMs: latencyMs,
      tokensUsed: completion.tokens,
      language: detectedLang,
    }).catch(() => {});

    traceService.traceEdge(traceId, 8, 15, 'normal');
    traceService.traceStepStart(traceId, 15, 'Response Generation', 'response', { provider: providerToUse });
    traceService.traceStepComplete(traceId, 15, 'success', 3, { length: completion.text.length });

    traceService.traceEdge(traceId, 15, 16, 'normal');
    traceService.traceStepStart(traceId, 16, 'Response Sent', 'success');
    traceService.traceStepComplete(traceId, 16, 'success', 1);

    traceService.traceEdge(traceId, 16, 17, 'normal');
    traceService.traceStepStart(traceId, 17, 'Learning Save', 'learning');
    traceService.traceStepComplete(traceId, 17, 'success', 2);

    traceService.traceEdge(traceId, 17, 18, 'normal');
    traceService.traceStepStart(traceId, 18, 'History Save', 'success');
    traceService.traceStepComplete(traceId, 18, 'success', 1);

    traceService.completeTrace(traceId, 'success', latencyMs, {
      response: completion.text,
      tokensUsed: completion.tokens,
      tokensSaved: computedTokensSaved,
      source: toolsUsed.length > 0 ? 'tool' : 'ai',
    });


    const source = toolsUsed.length > 0 ? 'tool' : 'ai';
    store.logExecution(
      client.id,
      userRef,
      cleanText,
      completion.text,
      source,
      completion.tokens,
      completion.costUsd,
      latencyMs,
      200,
      computedTokensSaved
    );

    return {
      text: completion.text,
      source,
      similarity: 0.98,
      toolsUsed,
      tokens: completion.tokens,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      costUsd: completion.costUsd,
      latencyMs,
      ttftMs: completion.ttftMs,
      conversationId: session.id,
      skillId: learnedSkillObj?.id,
      skillName: learnedSkillObj?.name,
      reasoningNote:
        toolsUsed.length > 0
          ? `AI Teacher reasoned through task and executed tools: [${toolsUsed.join(', ')}]. Strategy synthesized for future zero-API executions.`
          : `AI Teacher reasoned and answered user query directly.`,
      debugMetadata: {
        provider: completion.provider,
        model: completion.model,
        apiKeyName: completion.apiKeyName,
        requestStartTime: new Date(started).toISOString(),
        ttftMs: completion.ttftMs || 0,
        totalLatencyMs: latencyMs,
        inputTokens: completion.inputTokens || Math.ceil(((teacherSystemPrompt || '') + cleanText).length / 4),
        outputTokens: completion.outputTokens || Math.ceil(completion.text.length / 4),
        totalTokens: completion.tokens,
        estimatedCostUsd: completion.costUsd,
        streamingStatus: completion.streamingStatus || 'streaming',
        executedTools: toolsUsed.map((t, idx) => ({
          name: t,
          status: 'success',
          resultSummary: typeof toolResultsList[idx] === 'object' ? JSON.stringify(toolResultsList[idx]).slice(0, 120) : String(toolResultsList[idx] || ''),
        })),
        completionDetails: `Executed via ${completion.provider} (${completion.model})${completion.fallbackUsed ? ' [Fallback Used]' : ''}${completion.apiKeyName ? ` using key [${completion.apiKeyName}]` : ''} in ${latencyMs}ms (TTFT: ${completion.ttftMs || 0}ms)`,
      },
    };
  }
}

export const agentCore = new AgentCore();

