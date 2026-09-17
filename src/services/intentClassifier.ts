import crypto from 'crypto';
import { GoogleGenAI, Type } from '@google/genai';
import { getPgPool } from '../db/index';
import { store } from '../state/index';

export interface IntentResult {
  intent: 'chat' | 'question' | 'tool_needed' | 'unknown';
  topic: string;
  needs_history: boolean;
  needs_tools: boolean;
  confidence: number;
}

// Simple in-memory cache for ultra-fast, zero-latency intent lookup
const localIntentCache = new Map<string, { result: IntentResult; expiresAt: number }>();

function getActiveGeminiKey(): string | undefined {
  const record = store.providers.get('gemini');
  if (record?.api_key) return record.api_key;
  if (record?.keys) {
    const activeKey = record.keys.find(k => k.enabled)?.api_key;
    if (activeKey) return activeKey;
  }
  return process.env.GEMINI_API_KEY;
}

/**
 * Classifies a user query to determine the intent, topic, history requirement, and tool requirement.
 * Utilizes multi-layer caching (in-memory + PostgreSQL) to achieve maximum performance and token savings.
 */
export async function classifyIntent(projectId: string, userMessage: string): Promise<IntentResult> {
  const cleanMessage = userMessage.trim();
  if (!cleanMessage) {
    return {
      intent: 'unknown',
      topic: 'empty',
      needs_history: false,
      needs_tools: false,
      confidence: 1.0,
    };
  }

  // Create a stable cache key based on projectId and message text
  const messageHash = crypto.createHash('sha256').update(cleanMessage).digest('hex');
  const cacheKey = `${projectId}:${messageHash}`;
  const now = Date.now();

  // 1. Check in-memory cache
  const cachedLocal = localIntentCache.get(cacheKey);
  if (cachedLocal && cachedLocal.expiresAt > now) {
    return cachedLocal.result;
  }

  // 2. Check PostgreSQL database cache
  const pool = getPgPool();
  if (pool) {
    try {
      const res = await pool.query(
        `SELECT intent, topic, confidence, expires_at 
         FROM intent_cache 
         WHERE project_id = $1 AND message_hash = $2 AND expires_at > NOW()`,
        [projectId, messageHash]
      );

      if (res.rows.length > 0) {
        const row = res.rows[0];
        // Deduce needs_history and needs_tools logically from intent and topic
        const isToolNeeded = row.intent === 'tool_needed';
        const result: IntentResult = {
          intent: row.intent as any,
          topic: row.topic || 'general',
          needs_history: row.intent === 'chat' || ['follow_up', 'contextual'].includes(row.topic),
          needs_tools: isToolNeeded || row.topic === 'tools',
          confidence: Number(row.confidence) || 0.9,
        };

        // Populate local cache
        const expiresMs = new Date(row.expires_at).getTime();
        localIntentCache.set(cacheKey, { result, expiresAt: expiresMs });
        return result;
      }
    } catch (e: any) {
      // Suppress noisy postgres error logs for cache misses
    }
  }

  // Fast-path heuristics for very simple queries to save API calls
  const qLower = cleanMessage.toLowerCase();
  const chatWords = ['hi', 'hello', 'hey', 'thanks', 'thank you', 'ok', 'okay', 'bye', 'goodbye', 'ভালো', 'ধন্যবাদ', 'কেমন আছ', 'হ্যালো'];
  const toolWords = ['weather', 'time', 'calculate', 'convert', 'usd', 'eur', 'bdt', 'math', 'expense', 'balance', 'সময়', 'আবহাওয়া', 'টাকা', 'যোগ', 'বিয়োগ'];
  
  if (chatWords.includes(qLower) || cleanMessage.length <= 4) {
    return {
      intent: 'chat',
      topic: 'greeting',
      needs_history: true,
      needs_tools: false,
      confidence: 0.9,
    };
  }

  // 3. Fallback to AI-based classification
  const apiKey = getActiveGeminiKey();
  if (!apiKey) {
    // If no key is set yet, return safe defaults
    return {
      intent: 'question',
      topic: 'general',
      needs_history: true,
      needs_tools: true,
      confidence: 0.5,
    };
  }

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    });

    // Use a fast, highly optimized 3.8-flash model for near-instant response
    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: cleanMessage,
      config: {
        systemInstruction: `Classify the user message into one of four intents:
- 'chat': Simple greetings, conversational feedback, general chit-chat, or pleasantries (e.g., "hi", "how are you", "thanks", "ok").
- 'question': Factual, general knowledge, or informational queries that can be answered from static text or general reasoning (e.g., "why is the sky blue", "who is Einstein").
- 'tool_needed': Queries requiring real-time facts, calculations, conversions, profiles, database retrievals, or external actions (e.g., weather, time, exchange rates, math calculations, "my profile", "add expense").
- 'unknown': Ambiguous or completely uninterpretable messages.

Return ONLY a structured JSON output conforming strictly to the requested schema. Do not include markdown tags.`,
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            intent: {
              type: Type.STRING,
              description: "Must be 'chat', 'question', 'tool_needed', or 'unknown'",
            },
            topic: {
              type: Type.STRING,
              description: "A short, descriptive topic tag/category (e.g., 'greeting', 'weather', 'time', 'finance', 'math', 'general')",
            },
            needs_history: {
              type: Type.BOOLEAN,
              description: "True if answering this requires previous conversation context (e.g., follow-ups, pronouns like 'it', 'he', 'them')",
            },
            needs_tools: {
              type: Type.BOOLEAN,
              description: "True if answering requires real-time data or functional tools (e.g. weather, time, currency converter, database search)",
            },
            confidence: {
              type: Type.NUMBER,
              description: "Confidence score between 0.0 and 1.0",
            },
          },
          required: ['intent', 'topic', 'needs_history', 'needs_tools', 'confidence'],
        },
      },
    });

    if (response.text) {
      const parsed = JSON.parse(response.text.trim());
      const result: IntentResult = {
        intent: ['chat', 'question', 'tool_needed', 'unknown'].includes(parsed.intent) ? parsed.intent : 'question',
        topic: parsed.topic || 'general',
        needs_history: Boolean(parsed.needs_history),
        needs_tools: Boolean(parsed.needs_tools),
        confidence: Number(parsed.confidence) || 0.9,
      };

      // Expiry: 1 hour for local, 24 hours for database cache
      const localExpiryTime = now + 1000 * 60 * 60; // 1 hour
      localIntentCache.set(cacheKey, { result, expiresAt: localExpiryTime });

      // Save into PostgreSQL intent_cache table
      if (pool) {
        try {
          const expiresAtStr = new Date(now + 1000 * 60 * 60 * 24).toISOString(); // 24 hours
          await pool.query(
            `INSERT INTO intent_cache (project_id, message_hash, intent, topic, confidence, expires_at, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             ON CONFLICT (project_id, message_hash) 
             DO UPDATE SET intent = EXCLUDED.intent, topic = EXCLUDED.topic, confidence = EXCLUDED.confidence, expires_at = EXCLUDED.expires_at`,
            [projectId, messageHash, result.intent, result.topic, result.confidence, expiresAtStr]
          );
        } catch (dbErr: any) {
          console.warn('[IntentClassifier] PostgreSQL intent_cache insert failed:', dbErr.message);
        }
      }

      return result;
    }
  } catch (err: any) {
    const errorString = err.message || '';
    if (!errorString.includes('503') && !errorString.includes('429') && !errorString.includes('quota') && !errorString.includes('high demand')) {
      console.warn('[IntentClassifier] AI intent classification failed, falling back to heuristics:', errorString);
    }
  }

  // Fallback heuristics if API call fails
  const isChat = chatWords.some(w => qLower.includes(w));
  const isTool = toolWords.some(w => qLower.includes(w));

  return {
    intent: isChat ? 'chat' : (isTool ? 'tool_needed' : 'question'),
    topic: isChat ? 'greeting' : (isTool ? 'utility' : 'general'),
    needs_history: isChat || cleanMessage.length < 8,
    needs_tools: isTool,
    confidence: 0.6,
  };
}
