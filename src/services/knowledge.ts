import crypto from 'crypto';
import { store, KnowledgeEntry } from '../state';

export interface SearchResult {
  entry: KnowledgeEntry;
  similarity: number;
}

// Common small-talk and conversational intent patterns in Bengali/Banglish and English
const BUILTIN_INTENT_MAP: Array<{
  triggers: string[];
  response: string;
  category: string;
}> = [
  {
    triggers: [
      'kemon acho',
      'kemon achen',
      'kemon asen',
      'kmn asen',
      'kmn acho',
      'apni kemon achen',
      'tumi kemon acho',
      'how are you',
      'how are you doing',
      'how r u',
      'kemon cholche',
      'ki obstha',
      'ki obosta',
      'ki khobor',
    ],
    response: 'আমি ভালো আছি, ধন্যবাদ! আজ আপনাকে কীভাবে সাহায্য করতে পারি?',
    category: 'greetings',
  },
  {
    triggers: [
      'apni ke',
      'tumi ke',
      'who are you',
      'what are you',
      'apnar nam ki',
      'what is your name',
      'tomar nam ki',
      'introduce yourself',
    ],
    response: 'আমি আপনার শপ ও কাস্টমার কেয়ার সহায়ক ভার্চুয়াল এজেন্ট। আপনার অর্ডার, পলিসি, প্রোডাক্ট এবং যেকোনো প্রশ্নের উত্তর দিতে পারি।',
    category: 'identity',
  },
  {
    triggers: [
      'dhonnobad',
      'onek dhonnobad',
      'thank you',
      'thanks',
      'thx',
      'thank you so much',
      'shukriya',
    ],
    response: 'আপনাকে অনেক ধন্যবাদ! আপনার আর কোনো সাহায্য লাগলে নির্দ্বিধায় বলুন।',
    category: 'politeness',
  },
  {
    triggers: [
      'assalamu alaikum',
      'salam',
      'assalamualaikum',
      'shuvo shokal',
      'shuvo ratri',
      'good morning',
      'good evening',
      'good afternoon',
    ],
    response: 'ওয়ালাইকুম আসসালাম! আপনাকে স্বাগতম। আজ আপনাকে কীভাবে সাহায্য করতে পারি?',
    category: 'greetings',
  },
  {
    triggers: [
      'ki koren',
      'ki korte paren',
      'what can you do',
      'how can you help me',
      'apnar kaj ki',
    ],
    response: 'আমি আপনার পণ্যের তথ্য, অর্ডারের অবস্থান ট্র্যাকিং, রিটার্ন ও ডেলিভারি পলিসি এবং সাধারণ যেকোনো জিজ্ঞাসার দ্রুত উত্তর দিতে প্রস্তুত।',
    category: 'help',
  },
];

export class KnowledgeEngine {
  private hotCache = new Map<string, { entryId: string; cachedAt: number }>();
  private readonly CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

  // Normalize text for flexible multi-language & Banglish phonetic matching
  private normalizeText(text: string): string {
    return text
      .toLowerCase()
      .replace(/[?!.,;:'"()_-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Calculate high-fidelity similarity score between 0.0 and 1.0
  calculateSimilarity(query: string, target: string): number {
    const qClean = this.normalizeText(query);
    const tClean = this.normalizeText(target);

    if (qClean === tClean) return 1.0;

    const tokenize = (text: string) =>
      text
        .split(/\s+/)
        .filter((w) => w.length > 0);

    const qTokens = tokenize(qClean);
    const tTokens = tokenize(tClean);

    if (qTokens.length === 0 || tTokens.length === 0) return 0;

    // Single-word or short query exact token match check
    if (qTokens.length === 1 && tTokens.length === 1) {
      if (qTokens[0] === tTokens[0]) return 1.0;
      // 1-char difference typo allowance for words length > 3
      if (qTokens[0].length > 3 && tTokens[0].length > 3) {
        if (qTokens[0].slice(0, 3) === tTokens[0].slice(0, 3)) return 0.85;
      }
      return 0.0;
    }

    const qSet = new Set(qTokens);
    const tSet = new Set(tTokens);

    // Stop words to downweight generic terms
    const STOP_WORDS = new Set(['is', 'are', 'a', 'an', 'the', 'of', 'in', 'to', 'for', 'your', 'my', 'our', 'what', 'how', 'do', 'does', 'can', 'you', 'er', 'ki', 'eta']);

    let matchedTokens = 0;
    let totalSignificantTokens = 0;

    for (const token of qSet) {
      const weight = STOP_WORDS.has(token) ? 0.25 : 1.0;
      totalSignificantTokens += weight;
      if (tSet.has(token)) {
        matchedTokens += weight;
      } else {
        // Partial/stem matching
        for (const t of tSet) {
          if ((t.length >= 4 && token.startsWith(t.slice(0, 4))) || (token.length >= 4 && t.startsWith(token.slice(0, 4)))) {
            matchedTokens += weight * 0.8;
            break;
          }
        }
      }
    }

    if (totalSignificantTokens === 0) return 0;

    const tokenCoverage = matchedTokens / totalSignificantTokens;
    const jaccard = matchedTokens / (qSet.size + tSet.size - matchedTokens);

    // 3-gram character similarity
    const getTriGrams = (str: string) => {
      const s = `  ${str}  `;
      const trigrams = new Set<string>();
      for (let i = 0; i < s.length - 2; i++) {
        trigrams.add(s.slice(i, i + 3));
      }
      return trigrams;
    };

    const qTri = getTriGrams(qClean);
    const tTri = getTriGrams(tClean);

    let triIntersect = 0;
    for (const tri of qTri) {
      if (tTri.has(tri)) triIntersect++;
    }
    const triSim = (2.0 * triIntersect) / (qTri.size + tTri.size);

    // Weighted blend favoring token coverage
    const score = tokenCoverage * 0.55 + jaccard * 0.25 + triSim * 0.2;
    return Math.round(score * 1000) / 1000;
  }

  async search(clientId: string, query: string, threshold = 0.60): Promise<SearchResult | null> {
    const qClean = this.normalizeText(query);
    const cacheKey = `${clientId}:${qClean}`;
    const cached = this.hotCache.get(cacheKey);

    if (store.pgReady && cached && Date.now() - cached.cachedAt < this.CACHE_TTL_MS) {
      const entry = store.knowledge.get(cached.entryId);
      if (entry && entry.active && entry.client_id === clientId && !entry.learned) {
        entry.hit_count = (entry.hit_count || 0) + 1;
        return { entry, similarity: 0.99 };
      }
    }

    // Search stored knowledge base entries for this client ONLY (manual admin/console entries)
    let bestMatch: KnowledgeEntry | null = null;
    let highestSim = 0;

    for (const entry of store.knowledge.values()) {
      if (entry.client_id !== clientId || !entry.active) continue;
      // Auto-learned knowledge is handled dynamically via KnowledgePatternEngine with multi-variant templates
      if (entry.learned) continue;

      const sim = this.calculateSimilarity(qClean, entry.trigger_text);
      if (sim > highestSim) {
        highestSim = sim;
        bestMatch = entry;
      }
    }

    if (bestMatch && highestSim >= threshold) {
      bestMatch.hit_count = (bestMatch.hit_count || 0) + 1;
      this.hotCache.set(cacheKey, { entryId: bestMatch.id, cachedAt: Date.now() });
      return { entry: bestMatch, similarity: highestSim };
    }

    return null;
  }

  async learn(
    clientId: string,
    triggerText: string,
    responseText: string,
    toolCalls: any[] = [],
    learned = true,
    category = 'general'
  ): Promise<KnowledgeEntry> {
    const now = new Date().toISOString();
    const entryId = crypto.randomUUID();

    const entry: KnowledgeEntry = {
      id: entryId,
      client_id: clientId,
      category,
      trigger_text: triggerText.trim(),
      response_text: responseText.trim(),
      tool_calls: toolCalls,
      active: true,
      learned,
      hit_count: 0,
      created_at: now,
      updated_at: now,
    };

    store.knowledge.set(entryId, entry);
    const cacheKey = `${clientId}:${this.normalizeText(triggerText)}`;
    this.hotCache.set(cacheKey, { entryId, cachedAt: Date.now() });

    return entry;
  }

  clearCache(clientId?: string): void {
    if (clientId) {
      for (const [k] of this.hotCache.entries()) {
        if (k.startsWith(`${clientId}:`)) {
          this.hotCache.delete(k);
        }
      }
    } else {
      this.hotCache.clear();
    }
  }

  invalidateEntry(clientId: string, triggerText: string): void {
    const cacheKey = `${clientId}:${this.normalizeText(triggerText)}`;
    this.hotCache.delete(cacheKey);
  }
}

export const knowledgeEngine = new KnowledgeEngine();
