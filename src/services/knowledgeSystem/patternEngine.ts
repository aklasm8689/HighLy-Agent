import crypto from 'crypto';
import { getPgPool, ensureProjectInDb } from '../../db';
import { store } from '../../state';
import { toolEngine } from '../tools';
import { userProfileEngine } from './userProfileEngine';
import { multiLangEngine } from './multiLangEngine';
import { variableResolver } from './variableResolver';
import { feedbackEngine } from './feedbackEngine';
import { highSpeedCacheEngine } from './cacheEngine';
import {
  KnowledgePatternRecord,
  PatternToolSequenceRecord,
  PatternAnswerTemplateRecord,
  PatternMissingInputRecord,
  PatternMatchResult,
  ConfidenceDecision,
  UserConversationRecord,
  UserMessageRecord,
} from './types';

export function isUuid(id: any): boolean {
  if (!id || typeof id !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

const GENERIC_DEFAULT_INTENTS = new Set(['greeting', 'salam_greeting', 'language_change', 'agent_identity']);

export function isPatternAllowedForProject(patternProjectId: string, patternIntent: string, activeProjectId: string): boolean {
  if (patternProjectId === activeProjectId) return true;
  if (patternProjectId === 'default') {
    if (activeProjectId === 'default') return true;
    return GENERIC_DEFAULT_INTENTS.has(patternIntent);
  }
  return false;
}

export class KnowledgePatternEngine {
  private patterns = new Map<string, KnowledgePatternRecord>(); // patternId -> record
  private toolSequences = new Map<string, PatternToolSequenceRecord[]>(); // patternId -> sequences
  private answerTemplates = new Map<string, PatternAnswerTemplateRecord[]>(); // patternId -> templates
  private missingInputs = new Map<string, PatternMissingInputRecord[]>(); // patternId -> inputs
  // User context tracking for diverse variation selection and repetition prevention
  private userRecentPatternHits = new Map<string, { lastPatternId: string; lastVariantIndex: number; consecutiveCount: number; timestamp: number }>();

  constructor() {
    this.seedDefaultPatterns();
    this.initDbAndLoad().catch(() => {});
  }

  /**
   * Ensure schema columns exist and load all persisted patterns from PostgreSQL
   */
  private async initDbAndLoad() {
    const pool = getPgPool();
    if (!pool) return;
    try {
      // 1. Ensure columns exist idempotently
      await pool.query(`
        ALTER TABLE knowledge_patterns ADD COLUMN IF NOT EXISTS learning_stage VARCHAR(32) DEFAULT 'learning';
        ALTER TABLE knowledge_patterns ADD COLUMN IF NOT EXISTS target_variants INTEGER DEFAULT 3;
        ALTER TABLE knowledge_patterns ADD COLUMN IF NOT EXISTS quality_score REAL DEFAULT 1.0;
      `).catch(() => {});

      // 2. Sync seed patterns
      await this.syncSeedPatternsToDb();

      // 3. Load persisted patterns and templates from DB
      await this.loadPatternsFromDb();
    } catch (err: any) {
      console.warn('[KnowledgePatternEngine] DB init/load error:', err.message);
    }
  }

  /**
   * Sync in-memory baseline seed patterns to PostgreSQL
   */
  private async syncSeedPatternsToDb() {
    const pool = getPgPool();
    if (!pool) return;
    try {
      await ensureProjectInDb('default');
      for (const p of this.patterns.values()) {
        if (!isUuid(p.id)) continue;
        await pool.query(
          `INSERT INTO knowledge_patterns (id, project_id, intent, pattern_type, example_phrases, description, category, source, confidence_score, usage_count, success_count, failure_count, is_active, is_verified, learning_stage, target_variants, quality_score, created_at, updated_at, last_used_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
           ON CONFLICT DO NOTHING`,
          [
            p.id,
            p.project_id,
            p.intent,
            p.pattern_type,
            JSON.stringify(p.example_phrases),
            p.description,
            p.category,
            p.source,
            p.confidence_score,
            p.usage_count,
            p.success_count,
            p.failure_count,
            p.is_active,
            p.is_verified,
            p.learning_stage || 'learning',
            p.target_variants || 3,
            p.quality_score || 1.0,
            p.created_at,
            p.updated_at,
            p.last_used_at || p.created_at,
          ]
        );

        // Sync initial templates with UPSERT so existing database entries get updated
        const templates = this.answerTemplates.get(p.id) || [];
        for (const t of templates) {
          if (!isUuid(t.id)) continue;
          await pool.query(
            `INSERT INTO pattern_answer_templates (id, pattern_id, template_type, variant_name, template, priority, usage_count, is_active, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO UPDATE SET template = EXCLUDED.template, variant_name = EXCLUDED.variant_name`,
            [t.id, t.pattern_id, t.template_type, t.variant_name, t.template, t.priority, t.usage_count, t.is_active, t.created_at]
          ).catch(() => {});
        }
      }
    } catch {}
  }

  /**
   * Load persisted patterns, templates, and tool sequences from PostgreSQL into memory
   */
  async loadPatternsFromDb(): Promise<void> {
    const pool = getPgPool();
    if (!pool) return;
    try {
      const pRes = await pool.query(`SELECT * FROM knowledge_patterns WHERE is_active = TRUE`);
      for (const row of pRes.rows) {
        let examplePhrases: string[] = [];
        try {
          examplePhrases = typeof row.example_phrases === 'string' ? JSON.parse(row.example_phrases) : (row.example_phrases || []);
        } catch {
          examplePhrases = [];
        }

        const patRecord: KnowledgePatternRecord = {
          id: row.id,
          project_id: row.project_id,
          intent: row.intent,
          pattern_type: row.pattern_type || 'question',
          example_phrases: examplePhrases,
          description: row.description,
          category: row.category || 'general',
          source: row.source || 'auto_learned',
          confidence_score: Number(row.confidence_score || 0.95),
          usage_count: Number(row.usage_count || 0),
          success_count: Number(row.success_count || 0),
          failure_count: Number(row.failure_count || 0),
          is_active: Boolean(row.is_active),
          is_verified: Boolean(row.is_verified),
          learning_stage: row.learning_stage || 'learning',
          target_variants: Number(row.target_variants || 3),
          quality_score: Number(row.quality_score || 1.0),
          created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
          updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
          last_used_at: row.last_used_at ? new Date(row.last_used_at).toISOString() : undefined,
        };
        this.patterns.set(row.id, patRecord);
      }

      const tRes = await pool.query(`SELECT * FROM pattern_answer_templates WHERE is_active = TRUE ORDER BY priority ASC`);
      for (const row of tRes.rows) {
        const list = this.answerTemplates.get(row.pattern_id) || [];
        // Avoid duplicate by id
        if (!list.some(existing => existing.id === row.id)) {
          list.push({
            id: row.id,
            pattern_id: row.pattern_id,
            template_type: row.template_type || 'success',
            variant_name: row.variant_name || 'short',
            template: row.template,
            priority: Number(row.priority || 1),
            usage_count: Number(row.usage_count || 0),
            is_active: Boolean(row.is_active),
            created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
          });
          this.answerTemplates.set(row.pattern_id, list);
        }
      }
    } catch (err: any) {
      console.warn('[KnowledgePatternEngine] Load patterns from DB error:', err.message);
    }
  }

  /**
   * Seed default baseline patterns for immediate zero-API production readiness
   */
  private seedDefaultPatterns() {
    const defaultProject = 'default';

    // 1. Order Tracking Pattern
    const p1Id = 'a1111111-1111-4111-8111-111111111101';
    const p1: KnowledgePatternRecord = {
      id: p1Id,
      project_id: defaultProject,
      intent: 'order_tracking',
      pattern_type: 'command',
      example_phrases: [
        'order track korte chai',
        'amar order kothay',
        'track my order',
        'order status ki',
        'kothay ache amar parcel',
        'where is my order',
        'order track {order_id}',
        'আমার অর্ডার কোথায়',
        'অর্ডার ট্র্যাক করতে চাই',
        'অর্ডার স্ট্যাটাস কি',
      ],
      description: 'Track customer order status and delivery updates',
      category: 'ecommerce',
      source: 'manual',
      confidence_score: 0.98,
      usage_count: 12,
      success_count: 12,
      failure_count: 0,
      is_active: true,
      is_verified: true,
      learning_stage: 'matured',
      target_variants: 3,
      quality_score: 1.0,
      suggested_chips: ['আমার অর্ডার ট্র্যাক করুন', 'ডেলিভারি কবে পাব?', 'কাস্টমার কেয়ার'],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.patterns.set(p1Id, p1);

    // Missing input definition for Order ID
    this.missingInputs.set(p1Id, [
      {
        id: crypto.randomUUID(),
        pattern_id: p1Id,
        field_name: 'order_id',
        field_type: 'text',
        question_template: 'আপনার অর্ডারের স্ট্যাটাস জানতে দয়া করে আপনার অর্ডার আইডি (Order ID) প্রদান করুন।',
        validation_regex: '^(?:ORD-)?\\d{3,}$',
        fetch_from: 'client',
        fuzzy_match_enabled: true,
        fuzzy_threshold: 80,
        ask_priority: 1,
        created_at: new Date().toISOString(),
      },
    ]);

    // Tool sequence for Order Tracking
    this.toolSequences.set(p1Id, [
      {
        id: crypto.randomUUID(),
        pattern_id: p1Id,
        step_number: 1,
        tool_name: 'track_order',
        tool_type: 'server',
        input_mapping: { order_id: '{{order_id}}' },
        output_key: 'tracking_info',
        is_optional: false,
        on_error: 'ask_user',
        max_retries: 1,
        timeout_seconds: 30,
        created_at: new Date().toISOString(),
      },
    ]);

    // Answer template for Order Tracking
    const t1Id = crypto.randomUUID();
    this.answerTemplates.set(p1Id, [
      {
        id: t1Id,
        pattern_id: p1Id,
        template_type: 'success',
        variant_name: 'short',
        template: 'প্রিয় {{user_name | সম্মানিত গ্রাহক}}, আপনার অর্ডার #{{order_id}} এর বর্তমান স্ট্যাটাস: {{tracking_info.status | ডেলিভারির পথে}}। সম্ভাব্য ডেলিভারি তারিখ: {{tracking_info.estimated_delivery | আগামী ২৪-৪৮ ঘণ্টার মধ্যে}}।',
        priority: 1,
        usage_count: 5,
        is_active: true,
        created_at: new Date().toISOString(),
      },
    ]);

    // Seed localized translation for English
    multiLangEngine.setAnswerTranslation(
      t1Id,
      'en',
      'Dear {{user_name | Customer}}, the current status of your order #{{order_id}} is: {{tracking_info.status | Out for delivery}}. Estimated delivery date: {{tracking_info.estimated_delivery | within 24-48 hours}}.'
    );

    // 2. Greeting / Identity Pattern (General: Hi, Hello, How are you)
    const p2Id = 'b2222222-2222-4222-8222-222222222202';
    const p2: KnowledgePatternRecord = {
      id: p2Id,
      project_id: defaultProject,
      intent: 'greeting',
      pattern_type: 'chat',
      example_phrases: [
        'kemon acho',
        'kemon achen',
        'kmn asen',
        'hello',
        'hi',
        'hey',
        'how are you',
        'হাই',
        'হ্যালো',
        'কেমন আছো',
        'কেমন আছেন',
        'শুভ সকাল',
        'শুভ সন্ধ্যা',
      ],
      description: 'Polite greeting and reception',
      category: 'general',
      source: 'manual',
      confidence_score: 0.99,
      usage_count: 50,
      success_count: 50,
      failure_count: 0,
      is_active: true,
      is_verified: true,
      learning_stage: 'matured',
      target_variants: 4,
      quality_score: 1.0,
      suggested_chips: ['অর্ডার ট্র্যাক করুন', 'রিটার্ন পলিসি', 'প্রোডাক্ট ক্যাটাগরি', 'কাস্টমার কেয়ার'],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.patterns.set(p2Id, p2);

    const t2Id_1 = 'b2222222-2222-4222-8222-2222222222a1';
    const t2Id_2 = 'b2222222-2222-4222-8222-2222222222a2';
    const t2Id_3 = 'b2222222-2222-4222-8222-2222222222a3';
    const t2Id_4 = 'b2222222-2222-4222-8222-2222222222a4';

    this.answerTemplates.set(p2Id, [
      {
        id: t2Id_1,
        pattern_id: p2Id,
        template_type: 'success',
        variant_name: 'warm_polite',
        template: 'হ্যালো {{user_name | সুপ্রিয় গ্রাহক}}! আলহামদুলিল্লাহ্‌ আমি ভালো আছি। আজ আপনাকে কীভাবে সাহায্য করতে পারি?',
        priority: 1,
        usage_count: 50,
        is_active: true,
        created_at: new Date().toISOString(),
      },
      {
        id: t2Id_2,
        pattern_id: p2Id,
        template_type: 'success',
        variant_name: 'friendly_active',
        template: 'হ্যালো {{user_name | প্রিয় গ্রাহক}}! আশা করি ভালো আছেন। আজ আপনাকে কীভাবে সহযোগিতা করতে পারি?',
        priority: 2,
        usage_count: 30,
        is_active: true,
        created_at: new Date().toISOString(),
      },
      {
        id: t2Id_3,
        pattern_id: p2Id,
        template_type: 'success',
        variant_name: 'quick_assist',
        template: 'স্বাগতম {{user_name | আপনাকে}}! আমি প্রস্তুত, কী বিষয়ে তথ্য বা সেবা প্রয়োজন বলুন।',
        priority: 3,
        usage_count: 20,
        is_active: true,
        created_at: new Date().toISOString(),
      },
      {
        id: t2Id_4,
        pattern_id: p2Id,
        template_type: 'success',
        variant_name: 'repetition_followup',
        template: 'হ্যাঁ বলুন {{user_name | সুপ্রিয় গ্রাহক}}, আমি শুনছি! আপনার কোনো নির্দিষ্ট তথ্যের প্রয়োজন হলে নির্দ্বিধায় জানান।',
        priority: 4,
        usage_count: 10,
        is_active: true,
        created_at: new Date().toISOString(),
      },
    ]);

    multiLangEngine.setAnswerTranslation(
      t2Id_1,
      'en',
      'Hello {{user_name | valued customer}}! I am doing great. How can I assist you today?'
    );
    multiLangEngine.setAnswerTranslation(
      t2Id_2,
      'en',
      'Hey {{user_name | friend}}! Great to hear from you. What can I do for you right now?'
    );
    multiLangEngine.setAnswerTranslation(
      t2Id_3,
      'en',
      'Hi {{user_name | there}}! I am ready to help. What is on your mind?'
    );
    multiLangEngine.setAnswerTranslation(
      t2Id_4,
      'en',
      'Hello again {{user_name | there}}! Still right here. Looking for order tracking, policies, or general info? Just let me know!'
    );

    // 2b. Salam Greeting Pattern
    const pSalamId = 'b2222222-2222-4222-8222-222222222299';
    const pSalam: KnowledgePatternRecord = {
      id: pSalamId,
      project_id: defaultProject,
      intent: 'salam_greeting',
      pattern_type: 'chat',
      example_phrases: [
        'assalamu alaikum',
        'salam',
        'assalamu alaikom',
        'slam',
        'slm',
        'সালাম',
        'আসসালামু আলাইকুম',
        'আসসালামু',
      ],
      description: 'Islamic greeting with Salam response',
      category: 'general',
      source: 'manual',
      confidence_score: 0.99,
      usage_count: 50,
      success_count: 50,
      failure_count: 0,
      is_active: true,
      is_verified: true,
      learning_stage: 'matured',
      target_variants: 2,
      quality_score: 1.0,
      suggested_chips: ['অর্ডার ট্র্যাক করুন', 'রিটার্ন পলিসি', 'প্রোডাক্ট ক্যাটাগরি', 'কাস্টমার কেয়ার'],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.patterns.set(pSalamId, pSalam);

    const tSalamId_1 = 'b2222222-2222-4222-8222-2222222222b1';
    const tSalamId_2 = 'b2222222-2222-4222-8222-2222222222b2';
    const tSalamId_3 = 'b2222222-2222-4222-8222-2222222222b3';

    this.answerTemplates.set(pSalamId, [
      {
        id: tSalamId_1,
        pattern_id: pSalamId,
        template_type: 'success',
        variant_name: 'salam_response_1',
        template: 'ওয়ালাইকুম আসসালাম! {{user_name | সুপ্রিয় গ্রাহক}}, আমি আপনার সহায়ক AI। আজ আপনাকে কীভাবে সাহায্য করতে পারি?',
        priority: 1,
        usage_count: 50,
        is_active: true,
        created_at: new Date().toISOString(),
      },
      {
        id: tSalamId_2,
        pattern_id: pSalamId,
        template_type: 'success',
        variant_name: 'salam_response_2',
        template: 'ওয়ালাইকুম আসসালাম ওয়া রহমাতুল্লাহ! {{user_name | প্রিয় গ্রাহক}}, আশা করি ভালো আছেন। কীভাবে সাহায্য করতে পারি?',
        priority: 2,
        usage_count: 30,
        is_active: true,
        created_at: new Date().toISOString(),
      },
      {
        id: tSalamId_3,
        pattern_id: pSalamId,
        template_type: 'success',
        variant_name: 'repetition_followup',
        template: 'ওয়ালাইকুম আসসালাম! হ্যাঁ বলুন {{user_name | প্রিয় গ্রাহক}}, আমি শুনছি। নতুন আর কোনো বিষয়ে সহযোগিতা করতে পারি?',
        priority: 3,
        usage_count: 10,
        is_active: true,
        created_at: new Date().toISOString(),
      },
    ]);

    multiLangEngine.setAnswerTranslation(
      tSalamId_1,
      'en',
      'Wa Alaikum Assalam! Hello {{user_name | valued customer}}, how can I assist you today?'
    );
    multiLangEngine.setAnswerTranslation(
      tSalamId_2,
      'en',
      'Wa Alaikum Assalam Wa Rahmatullah! {{user_name | friend}}, hope you are doing well. How can I assist you?'
    );
    multiLangEngine.setAnswerTranslation(
      tSalamId_3,
      'en',
      'Wa Alaikum Assalam! Yes, tell me {{user_name | there}}, I am listening. Is there anything else I can help you with?'
    );
    multiLangEngine.setAnswerTranslation(
      tSalamId_2,
      'en',
      'Wa Alaikum Assalam wa Rahmatullah! Welcome {{user_name | friend}}, how may I help you?'
    );

    // 2c. Language Change Request Pattern
    const pLangId = 'b2222222-2222-4222-8222-222222222288';
    const pLang: KnowledgePatternRecord = {
      id: pLangId,
      project_id: defaultProject,
      intent: 'language_change',
      pattern_type: 'chat',
      example_phrases: [
        'speak in english',
        'talk in english',
        'english e kotha bolo',
        'english a bolo',
        'english e',
        'english',
        'banglay bolo',
        'bangla te bolo',
        'speak in bangla',
        'bangla',
        'banglish e bolo',
        'speak in banglish',
        'banglish',
        'hindi me bolo',
        'speak in hindi',
        'hindi',
        'arabic e bolo',
        'speak in arabic',
        'arabic',
      ],
      description: 'Language change request handler',
      category: 'general',
      source: 'manual',
      confidence_score: 0.99,
      usage_count: 50,
      success_count: 50,
      failure_count: 0,
      is_active: true,
      is_verified: true,
      learning_stage: 'matured',
      target_variants: 1,
      quality_score: 1.0,
      suggested_chips: ['অর্ডার ট্র্যাক করুন', 'রিটার্ন পলিসি', 'কাস্টমার কেয়ার'],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.patterns.set(pLangId, pLang);

    const tLangId_1 = 'b2222222-2222-4222-8222-2222222222c1';

    this.answerTemplates.set(pLangId, [
      {
        id: tLangId_1,
        pattern_id: pLangId,
        template_type: 'success',
        variant_name: 'lang_switch_response',
        template: 'অবশ্যই! আমি এখন থেকে আপনার পছন্দের ভাষায় কথা বলব। {{user_name | সুপ্রিয় গ্রাহক}}, আজ আপনাকে কীভাবে সাহায্য করতে পারি?',
        priority: 1,
        usage_count: 50,
        is_active: true,
        created_at: new Date().toISOString(),
      },
    ]);

    multiLangEngine.setAnswerTranslation(
      tLangId_1,
      'en',
      'Sure! I will speak with you in English from now on. {{user_name | Valued Customer}}, how can I assist you today?'
    );
    multiLangEngine.setAnswerTranslation(
      tLangId_1,
      'banglish',
      'Oboshoy! Ami ekhon theke apnar pochonder bhashay kotha bolbo. {{user_name | Supriyo Grahok}}, aj apnake kivabe shahajjo korte pari?'
    );
    multiLangEngine.setAnswerTranslation(
      tLangId_1,
      'hi',
      'ज़रूर! मैं अब से आपकी पसंदीदा भाषा में बात करूँगा। {{user_name | प्रिय ग्राहक}}, आज मैं आपकी कैसे मदद कर सकता हूँ?'
    );
    multiLangEngine.setAnswerTranslation(
      tLangId_1,
      'ar',
      'بالتأكيد! سأتحدث معك باللغة التي تفضلها من الآن فصاعدًا. {{user_name | عزيزي العميل}}، كيف يمكنني مساعدتك اليوم؟'
    );

    // 2d. Agent Identity Pattern (Who are you / What is your name)
    const pIdentId = 'b2222222-2222-4222-8222-222222222277';
    const pIdent: KnowledgePatternRecord = {
      id: pIdentId,
      project_id: defaultProject,
      intent: 'agent_identity',
      pattern_type: 'question',
      example_phrases: [
        'who are you',
        'what is your name',
        'what are you',
        'introduce yourself',
        'tumi ke',
        'apni ke',
        'apnar nam ki',
        'tomar nam ki',
        'কে তুমি',
        'আপনি কে',
        'তোমার নাম কি',
        'আপনার নাম কি',
        'নিজের পরিচয় দাও',
        'তোমার পরিচয় কি',
      ],
      description: 'Agent identity and introduction with project name',
      category: 'general',
      source: 'manual',
      confidence_score: 0.99,
      usage_count: 50,
      success_count: 50,
      failure_count: 0,
      is_active: true,
      is_verified: true,
      learning_stage: 'matured',
      target_variants: 2,
      quality_score: 1.0,
      suggested_chips: ['অর্ডার ট্র্যাক করুন', 'রিটার্ন পলিসি', 'কাস্টমার কেয়ার'],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.patterns.set(pIdentId, pIdent);

    const tIdentId_1 = 'b2222222-2222-4222-8222-2222222222d1';
    const tIdentId_2 = 'b2222222-2222-4222-8222-2222222222d2';

    this.answerTemplates.set(pIdentId, [
      {
        id: tIdentId_1,
        pattern_id: pIdentId,
        template_type: 'success',
        variant_name: 'identity_polite_bn',
        template: 'আমি {{project_name | HighLyAgent}}-এর একজন ভার্চুয়াল এআই অ্যাসিস্ট্যান্ট। {{user_name | প্রিয় গ্রাহক}}, আপনার অর্ডার, তথ্য বা যেকোনো প্রশ্নের উত্তর দিতে আমি এখানে আছি।',
        priority: 1,
        usage_count: 50,
        is_active: true,
        created_at: new Date().toISOString(),
      },
      {
        id: tIdentId_2,
        pattern_id: pIdentId,
        template_type: 'success',
        variant_name: 'identity_direct_bn',
        template: 'আমার নাম {{project_name | HighLyAgent}} এআই অ্যাসিস্ট্যান্ট। আমি আপনার সেবায় সর্বদা নিয়োজিত। আজ আপনাকে কীভাবে সাহায্য করতে পারি?',
        priority: 2,
        usage_count: 30,
        is_active: true,
        created_at: new Date().toISOString(),
      },
    ]);

    multiLangEngine.setAnswerTranslation(
      tIdentId_1,
      'en',
      'I am the official AI assistant for {{project_name | HighLyAgent}}. {{user_name | Valued Customer}}, I am here to help answer your questions, track orders, or assist with services!'
    );
    multiLangEngine.setAnswerTranslation(
      tIdentId_2,
      'en',
      'My name is the {{project_name | HighLyAgent}} AI Assistant. How can I assist you today?'
    );

    // 3. Return & Refund Policy Pattern
    const p3Id = 'c3333333-3333-4333-8333-333333333303';
    const p3: KnowledgePatternRecord = {
      id: p3Id,
      project_id: defaultProject,
      intent: 'return_policy',
      pattern_type: 'question',
      example_phrases: [
        'return policy ki',
        'kivabe return korbo',
        'taka ferot pabo kivabe',
        'refund policy',
        'how to return product',
      ],
      description: '7-day product return and refund policy',
      category: 'support',
      source: 'manual',
      confidence_score: 0.98,
      usage_count: 20,
      success_count: 20,
      failure_count: 0,
      is_active: true,
      is_verified: true,
      suggested_chips: ['রিটার্ন করার নিয়ম কি?', 'রিফান্ডের টাকা কত দিনে পাব?', 'অর্ডার পরিবর্তন করতে চাই'],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.patterns.set(p3Id, p3);

    const t3Id = crypto.randomUUID();
    this.answerTemplates.set(p3Id, [
      {
        id: t3Id,
        pattern_id: p3Id,
        template_type: 'success',
        variant_name: 'detailed',
        template: 'আমাদের পণ্য গ্রহণের ৭ দিনের মধ্যে কোনো ত্রুটি থাকলে সহজে রিটার্ন করতে পারেন। প্রোডাক্টটি অবিকৃত প্যাকেজিংসহ নিকটস্থ কুরিয়ার বা আমাদের হটলাইনে যোগাযোগ করুন। রিফান্ড সাধারণত ৩-৫ কার্যদিবসের মধ্যে আপনার প্রদত্ত মাধ্যমে সম্পন্ন হয়।',
        priority: 1,
        usage_count: 20,
        is_active: true,
        created_at: new Date().toISOString(),
      },
    ]);

    multiLangEngine.setAnswerTranslation(
      t3Id,
      'en',
      'You can easily return any item within 7 days of delivery if there are any defects. Please keep the original packaging intact. Refunds are processed within 3-5 business days.'
    );
  }

  /**
   * Text normalization for robust fuzzy and semantic matching
   */
  private normalize(text: string): string {
    return text
      .toLowerCase()
      .replace(/[?!.,;:'"()_\-–]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Calculate string similarity (Token Overlap Jaccard + Bigram Dice Coefficient)
   * High accuracy to prevent false-positive matching on complex/compound queries.
   */
  private calculateSimilarity(s1: string, s2: string): number {
    const a = this.normalize(s1);
    const b = this.normalize(s2);
    if (!a || !b) return 0;
    if (a === b) return 1.0;

    const wordsA = a.split(/\s+/).filter(Boolean);
    const wordsB = b.split(/\s+/).filter(Boolean);
    if (wordsA.length === 0 || wordsB.length === 0) return 0;

    const stopWords = new Set([
      'আমাদের', 'আপনার', 'আমার', 'এর', 'কে', 'তে', 'কি', 'কী', 'একটি', 'বলুন', 'জানতে', 'চাই', 'একটু', 'দয়া', 'করে', 'হলো', 'হয়', 'আছে', 'আছ', 'আসুন', 'is', 'are', 'the', 'a', 'an', 'what', 'how', 'please', 'can', 'you', 'tell', 'me', 'do', 'does'
    ]);

    const sigA = wordsA.filter(w => !stopWords.has(w));
    const sigB = wordsB.filter(w => !stopWords.has(w));

    const setA = new Set(wordsA);
    const setB = new Set(wordsB);

    let tokenIntersection = 0;
    for (const w of setA) {
      if (setB.has(w)) tokenIntersection++;
    }
    const tokenUnion = new Set([...wordsA, ...wordsB]).size;
    const jaccard = tokenUnion > 0 ? tokenIntersection / tokenUnion : 0;

    // Significant token coverage check for high-fidelity semantic matching
    if (sigA.length > 0 && sigB.length > 0) {
      const sigSetA = new Set(sigA);
      const sigSetB = new Set(sigB);
      let sigIntersect = 0;
      for (const w of sigSetA) {
        if (sigSetB.has(w)) sigIntersect++;
      }
      const covA = sigIntersect / sigSetA.size;
      const covB = sigIntersect / sigSetB.size;

      if (covA >= 0.99 && covB >= 0.99) {
        return 0.98;
      }
      if (covA >= 0.8 && covB >= 0.8) {
        return Math.max(0.95, (covA + covB) / 2);
      }
    }

    // Character Bigram Dice Coefficient
    const getBigrams = (str: string): Map<string, number> => {
      const bigrams = new Map<string, number>();
      for (let i = 0; i < str.length - 1; i++) {
        const bg = str.substring(i, i + 2);
        bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
      }
      return bigrams;
    };

    const bg1 = getBigrams(a);
    const bg2 = getBigrams(b);
    let intersection = 0;

    for (const [bg, count] of bg1.entries()) {
      if (bg2.has(bg)) {
        intersection += Math.min(count, bg2.get(bg)!);
      }
    }

    const total = (a.length - 1) + (b.length - 1);
    const dice = total > 0 ? (2.0 * intersection) / total : 0;

    const lenRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
    const combined = Math.max(jaccard * 0.5 + dice * 0.5, dice * 0.9) * Math.sqrt(lenRatio);

    return Math.min(1.0, combined);
  }

  /**
   * Extract dynamic variable values from user query
   */
  private extractSlotValues(query: string, pattern: KnowledgePatternRecord): Record<string, any> {
    const slots: Record<string, any> = {};

    // 1. Order ID extraction (e.g. #12345, ORD-9921, 99812)
    const orderMatch = query.match(/(?:#|ord-?|order\s*(?:id|no)?\s*[:=]?\s*)(\d{3,})/i);
    if (orderMatch && orderMatch[1]) {
      slots.order_id = orderMatch[1].trim();
    }

    // 2. Email extraction
    const emailMatch = query.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    if (emailMatch) {
      slots.email = emailMatch[1].trim();
    }

    // 3. Phone extraction
    const phoneMatch = query.match(/(?:\+?88)?01[3-9]\d{8}/);
    if (phoneMatch) {
      slots.phone = phoneMatch[0];
    }

    // 4. Extract regex patterns defined in example phrases
    for (const phrase of pattern.example_phrases) {
      if (phrase.includes('{') && phrase.includes('}')) {
        const paramNames: string[] = [];
        const regexStr = phrase.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name) => {
          paramNames.push(name);
          return '([A-Za-z0-9.\\-+*/%# ]+?)';
        });

        try {
          const match = query.match(new RegExp(regexStr, 'i'));
          if (match) {
            paramNames.forEach((name, idx) => {
              const val = match[idx + 1]?.trim();
              if (val) slots[name] = val;
            });
          }
        } catch {}
      }
    }

    return slots;
  }

  /**
   * Find matching knowledge pattern and compute confidence decision
   * Includes dynamic anti-repetition rotation and user-context awareness
   */
  async matchPattern(
    projectId: string,
    query: string,
    userLang = 'bn',
    userId?: string,
    isOngoingConversation = false
  ): Promise<PatternMatchResult | null> {
    const cleanQ = this.normalize(query);
    if (!cleanQ) return null;

    let bestPattern: KnowledgePatternRecord | null = null;
    let highestSimilarity = 0;
    let matchedPhrase = '';
    let matchedLanguage = userLang;

    // Search active patterns
    for (const pattern of this.patterns.values()) {
      if (!pattern.is_active) continue;
      if (!isPatternAllowedForProject(pattern.project_id, pattern.intent, projectId)) continue;

      // 1. Check primary example phrases
      for (const phrase of pattern.example_phrases) {
        const cleanP = this.normalize(phrase.replace(/\{[a-zA-Z0-9_]+\}/g, ''));
        const sim = this.calculateSimilarity(cleanQ, cleanP);
        if (sim > highestSimilarity) {
          highestSimilarity = sim;
          bestPattern = pattern;
          matchedPhrase = phrase;
          matchedLanguage = 'bn';
        }
      }

      // 2. Check multi-lingual translation phrases
      const translations = multiLangEngine.getPatternPhrasesWithLang(pattern.id);
      for (const t of translations) {
        const cleanP = this.normalize(t.phrase.replace(/\{[a-zA-Z0-9_]+\}/g, ''));
        const sim = this.calculateSimilarity(cleanQ, cleanP);
        if (sim > highestSimilarity) {
          highestSimilarity = sim;
          bestPattern = pattern;
          matchedPhrase = t.phrase;
          matchedLanguage = t.lang;
        }
      }
    }

    if (!bestPattern) {
      return null;
    }

    // Weight similarity with pattern's historic confidence score
    const combinedConfidence = Number(
      Math.min(1.0, highestSimilarity * (bestPattern.confidence_score || 0.95)).toFixed(2)
    );

    const extractedVariables = this.extractSlotValues(query, bestPattern);
    const missingInputsList = this.missingInputs.get(bestPattern.id) || [];
    const toolSeqs = this.toolSequences.get(bestPattern.id) || [];
    const templates = this.answerTemplates.get(bestPattern.id) || [];

    const targetVariants = bestPattern.target_variants || 3;
    const isMatured = bestPattern.learning_stage === 'matured' || bestPattern.is_verified || templates.length >= targetVariants;

    // Decision Logic
    let decision: ConfidenceDecision = 'AI_EXECUTION';
    if (combinedConfidence >= 0.90) {
      if (isMatured) {
        // Fully matured pattern: 100% Zero-API Direct Execution with rotation!
        decision = 'DIRECT_EXECUTION';
      } else {
        // Progressive multi-user learning stage (< targetVariants templates collected):
        // To build a rich, human-like repository of multiple varied answers without repetitive robot-speech,
        // we alternate:
        // If we have at least 1 template, 50% of the time we give an existing template immediately,
        // and 50% of the time we delegate to AI so autoLearnPattern captures another natural variation.
        // This stops permanently once targetVariants (e.g. 3) distinct variations are acquired!
        const exploreNewVariant = Math.random() < 0.50 && templates.length < targetVariants;
        decision = exploreNewVariant ? 'AI_EXECUTION' : 'DIRECT_EXECUTION';
      }
    } else if (combinedConfidence >= 0.70) {
      decision = 'ASK_CONFIRMATION';
    } else {
      decision = 'AI_EXECUTION';
    }

    // Dynamic Variation Selection (Anti-Repetition & Context-Aware Rotation)
    const hasSalamInQuery = /\b(salam|assalam|salem|slam|slm|সালাম|আসসালামু)\b/i.test(query);
    let selectableTemplates = templates;
    if (!hasSalamInQuery && templates.length > 1) {
      const nonSalam = templates.filter(t => !/ওয়ালাইকুম\s*আসসালাম|ওয়ালাইকুম\s*আসসালাম|wa\s*alaikum/i.test(t.template));
      if (nonSalam.length > 0) {
        selectableTemplates = nonSalam;
      }
    }

    // Filter templates by target language if user requested a non-Bengali language (e.g. English)
    if (userLang && userLang !== 'bn') {
      const matchingLang = selectableTemplates.filter(t =>
        multiLangEngine.hasExactTranslation(t.id, userLang) ||
        multiLangEngine.detectLanguage(t.template) === userLang
      );
      if (matchingLang.length > 0) {
        selectableTemplates = matchingLang;
      }
    }

    let selectedTemplate: PatternAnswerTemplateRecord | undefined = selectableTemplates[0];
    let selectedTemplateIndex = 0;

    if (selectableTemplates.length > 1) {
      if (userId) {
        const trackerKey = `${userId}_${bestPattern.id}`;
        const prevHit = this.userRecentPatternHits.get(trackerKey);
        const now = Date.now();

        // 1. If ongoing conversation & greeting/salam pattern, prioritize repetition/followup templates
        const isGreetingPattern = bestPattern.intent === 'greeting' || bestPattern.intent === 'salam_greeting';
        let forcedFollowupIndex = -1;
        if (isOngoingConversation && isGreetingPattern) {
          forcedFollowupIndex = selectableTemplates.findIndex(t => 
            t.variant_name === 'repetition_followup' || 
            t.variant_name === 'followup' || 
            t.variant_name.includes('followup')
          );
        }

        if (forcedFollowupIndex !== -1) {
          selectedTemplateIndex = forcedFollowupIndex;
          this.userRecentPatternHits.set(trackerKey, {
            lastPatternId: bestPattern.id,
            lastVariantIndex: selectedTemplateIndex,
            consecutiveCount: prevHit ? prevHit.consecutiveCount + 1 : 1,
            timestamp: now,
          });
        } else if (prevHit && (now - prevHit.timestamp) < 180000) {
          // Repeated / consecutive hit within 3 minutes
          const consecutiveCount = prevHit.consecutiveCount + 1;
          
          // If consecutive >= 2, prefer repetition_followup variant if available
          const followupIndex = selectableTemplates.findIndex(t => t.variant_name === 'repetition_followup' || t.variant_name === 'followup');
          if (consecutiveCount >= 2 && followupIndex !== -1 && prevHit.lastVariantIndex !== followupIndex) {
            selectedTemplateIndex = followupIndex;
          } else {
            // Rotate to next variation so it's not the same answer back to back
            selectedTemplateIndex = (prevHit.lastVariantIndex + 1) % selectableTemplates.length;
          }

          this.userRecentPatternHits.set(trackerKey, {
            lastPatternId: bestPattern.id,
            lastVariantIndex: selectedTemplateIndex,
            consecutiveCount,
            timestamp: now,
          });
        } else {
          // Fresh hit for this user - select a random template distinct from last seen
          // If ongoing conversation & greeting, avoid welcoming template at index 0 and 1
          let availableIndices = selectableTemplates.map((_, i) => i).filter(i => !prevHit || i !== prevHit.lastVariantIndex);
          if (isOngoingConversation && isGreetingPattern && availableIndices.length > 1) {
            const nonWelcomeIndices = availableIndices.filter(i => i > 1);
            if (nonWelcomeIndices.length > 0) {
              availableIndices = nonWelcomeIndices;
            }
          }

          selectedTemplateIndex = availableIndices.length > 0
            ? availableIndices[Math.floor(Math.random() * availableIndices.length)]
            : Math.floor(Math.random() * selectableTemplates.length);

          this.userRecentPatternHits.set(trackerKey, {
            lastPatternId: bestPattern.id,
            lastVariantIndex: selectedTemplateIndex,
            consecutiveCount: 1,
            timestamp: now,
          });
        }
      } else {
        // Different / anonymous users: randomized distribution across all template variations
        selectedTemplateIndex = Math.floor(Math.random() * selectableTemplates.length);
      }
      selectedTemplate = selectableTemplates[selectedTemplateIndex] || selectableTemplates[0];
    }

    let localizedTemplate = selectedTemplate?.template;
    let isExactTranslation = true;
    if (selectedTemplate) {
      const loc = multiLangEngine.resolveLocalizedAnswer(
        selectedTemplate.id,
        selectedTemplate.template,
        userLang
      );
      localizedTemplate = loc.template;
      isExactTranslation = loc.isExact;
    }

    // User Directive: "English na thakle ai api theke response korbe ar arekbar jono shikhe rakhbe english ami chai"
    // If the active user language is not Bengali (e.g. English), and the knowledge base lacks an authentic translation
    // for this pattern:
    // DO NOT serve a Bengali response! Delegate to AI Execution so AI responds in user's language,
    // and autoLearnPattern will learn the translation for the next time!
    if (userLang && userLang !== 'bn') {
      if (!isExactTranslation || !selectedTemplate) {
        decision = 'AI_EXECUTION';
      } else if (combinedConfidence >= 0.95) {
        // High confidence and authentic translation available: execute directly with 100% token savings!
        decision = 'DIRECT_EXECUTION';
      }
    }

    // Context-aware Quick Suggestion Chips
    let suggestedChips: string[] = [];
    if (decision === 'ASK_CONFIRMATION') {
      suggestedChips = [
        'হ্যাঁ, নিশ্চিত করুন',
        'না, অন্য কিছু জানতে চাই',
        'কাস্টমার সাপোর্টে কথা বলতে চাই',
      ];
    } else if (missingInputsList.length > 0) {
      suggestedChips = [
        'আমার অর্ডার আইডি ORD-1029',
        'আইডি মনে নেই',
        'কাস্টমার কেয়ার',
      ];
    } else if (bestPattern.suggested_chips && bestPattern.suggested_chips.length > 0) {
      suggestedChips = bestPattern.suggested_chips;
    }

    if (userLang && userLang !== 'bn') {
      suggestedChips = suggestedChips.map(chip => {
        if (chip === 'অর্ডার ট্র্যাক করুন') {
          return userLang === 'en' ? 'Track Order' : userLang === 'banglish' ? 'Order Track Korun' : userLang === 'hi' ? 'ऑर्डर ट्रैक करें' : userLang === 'ar' ? 'تتبع الطلب' : chip;
        }
        if (chip === 'রিটার্ন পলিসি') {
          return userLang === 'en' ? 'Return Policy' : userLang === 'banglish' ? 'Return Policy' : userLang === 'hi' ? 'वापसी नीति' : userLang === 'ar' ? 'سياسة الإرجاع' : chip;
        }
        if (chip === 'প্রোডাক্ট ক্যাটাগরি') {
          return userLang === 'en' ? 'Product Categories' : userLang === 'banglish' ? 'Product Category' : userLang === 'hi' ? 'उत्पाद श्रेणियां' : userLang === 'ar' ? 'فئات المنتجات' : chip;
        }
        if (chip === 'কাস্টমার কেয়ার') {
          return userLang === 'en' ? 'Customer Care' : userLang === 'banglish' ? 'Customer Care' : userLang === 'hi' ? 'ग्राहक सेवा' : userLang === 'ar' ? 'خدمة العملاء' : chip;
        }
        return chip;
      });
    }

    return {
      pattern: bestPattern,
      confidence: combinedConfidence,
      decision,
      matchedPhrase,
      matchedLanguage,
      extractedVariables,
      missingInputs: missingInputsList,
      toolSequences: toolSeqs,
      selectedTemplate,
      localizedTemplate,
      suggestedChips,
    };
  }

  /**
   * Execute the full pattern pipeline:
   * 1. Check & fetch missing inputs
   * 2. Execute tool sequences in order
   * 3. Interpolate answer template with variables
   * 4. Update usage statistics
   */
  async executePattern(
    match: PatternMatchResult,
    projectId: string,
    userId: string
  ): Promise<{
    text: string;
    toolsUsed: string[];
    isClarification: boolean;
    executedSuccessfully: boolean;
    suggestedChips?: string[];
  }> {
    const { pattern, extractedVariables, missingInputs, toolSequences, localizedTemplate, suggestedChips } = match;

    // 1. Check if required inputs are missing
    const userVars = await userProfileEngine.getUserVariables(projectId, userId);
    const clientRecord = store.clients.get(projectId);
    const projectName = clientRecord?.name || 'HighLyAgent';
    const combinedContext: Record<string, any> = {
      project_name: projectName,
      ...userVars,
      ...extractedVariables,
    };

    for (const reqInput of missingInputs) {
      if (!combinedContext[reqInput.field_name]) {
        // Try auto-fetching
        if (reqInput.fetch_from === 'user_memory' || reqInput.fetch_from === 'user_facts') {
          if (userVars[reqInput.field_name]) {
            combinedContext[reqInput.field_name] = userVars[reqInput.field_name];
          }
        }

        // If still missing, ask the user!
        if (!combinedContext[reqInput.field_name]) {
          return {
            text: reqInput.question_template,
            toolsUsed: [],
            isClarification: true,
            executedSuccessfully: false,
            suggestedChips: ['আমার কোনো আইডি নেই', 'কাস্টমার কেয়ারে কথা বলুন'],
          };
        }
      }
    }

    // 2. Execute tool sequences
    const toolsUsed: string[] = [];
    const toolResults: Record<string, any> = {};

    for (const seq of toolSequences) {
      // Map inputs
      const resolvedInputs: Record<string, any> = {};
      for (const [k, v] of Object.entries(seq.input_mapping)) {
        if (typeof v === 'string' && v.includes('{{')) {
          const interp = variableResolver.interpolate(v, combinedContext);
          resolvedInputs[k] = interp.result;
        } else {
          resolvedInputs[k] = v;
        }
      }

      toolsUsed.push(seq.tool_name);
      try {
        const res = await toolEngine.executeServerTool(seq.tool_name, resolvedInputs, projectId, userId);
        if (seq.output_key) {
          combinedContext[seq.output_key] = res.result;
          toolResults[seq.output_key] = res.result;
        }
      } catch (err: any) {
        if (seq.on_error === 'stop') {
          return {
            text: `দুঃখিত, অনুরোধটি সম্পন্ন করতে একটি ত্রুটি দেখা দিয়েছে: ${err.message}`,
            toolsUsed,
            isClarification: false,
            executedSuccessfully: false,
          };
        }
      }
    }

    // 3. Interpolate final answer template
    const rawTemplate = localizedTemplate || 'আপনার অনুরোধ সফলভাবে সম্পন্ন হয়েছে।';
    const finalAnswer = variableResolver.interpolate(rawTemplate, combinedContext);

    // 4. Update pattern and template usage metrics
    pattern.usage_count += 1;
    pattern.success_count += 1;
    pattern.last_used_at = new Date().toISOString();

    const pool = getPgPool();
    if (pool && isUuid(pattern.id)) {
      pool.query(
        `UPDATE knowledge_patterns 
         SET usage_count = usage_count + 1, success_count = success_count + 1, last_used_at = NOW() 
         WHERE id = $1`,
        [pattern.id]
      ).catch(() => {});
    }

    if (match.selectedTemplate) {
      match.selectedTemplate.usage_count = (match.selectedTemplate.usage_count || 0) + 1;
      if (pool && isUuid(match.selectedTemplate.id)) {
        pool.query(
          `UPDATE pattern_answer_templates SET usage_count = usage_count + 1 WHERE id = $1`,
          [match.selectedTemplate.id]
        ).catch(() => {});
      }
    }

    let textResult = finalAnswer.result;
    const hasSalam = /\b(salam|assalam|salem|slam|slm|সালাম|আসসালামু)\b/i.test(match.matchedPhrase || '');
    if (!hasSalam) {
      textResult = textResult.replace(/^(ওয়ালাইকুম\s*আসসালাম!|ওয়ালাইকুম\s*আসসালাম!|Wa\s*Alaikum\s*Assalam!?)\s*/i, '');
    }

    return {
      text: textResult,
      toolsUsed,
      isClarification: false,
      executedSuccessfully: true,
      suggestedChips: pattern.suggested_chips || match.suggestedChips,
    };
  }

  /**
   * Auto-learn a newly observed pattern from an AI Teacher execution
   */
  async autoLearnPattern(
    projectId: string,
    query: string,
    aiAnswer: string,
    toolsUsed: string[],
    toolResults: any[],
    userId?: string,
    plannedTools?: Array<{ name: string; args: Record<string, any> }>
  ): Promise<KnowledgePatternRecord> {
    const pool = getPgPool();
    const patternId = crypto.randomUUID();
    const now = new Date().toISOString();

    const cleanQ = this.normalize(query);

    // Check if query is already covered by an existing pattern
    for (const pat of this.patterns.values()) {
      if (isPatternAllowedForProject(pat.project_id, pat.intent, projectId)) {
        for (const phr of pat.example_phrases) {
          const sim = this.calculateSimilarity(cleanQ, this.normalize(phr));
          if (sim >= 0.88) {
            // Add query as alternative example phrase
            if (!pat.example_phrases.includes(query)) {
              pat.example_phrases.push(query);
              pat.updated_at = now;
            }
            pat.usage_count = (pat.usage_count || 0) + 1;
            pat.success_count = (pat.success_count || 0) + 1;
            pat.last_used_at = now;

            if (pool) {
              pool.query(
                `UPDATE knowledge_patterns SET example_phrases = $1, usage_count = $2, success_count = $3, last_used_at = $4, updated_at = $5 WHERE id = $6`,
                [JSON.stringify(pat.example_phrases), pat.usage_count, pat.success_count, now, now, pat.id]
              ).catch(() => {});
            }

            // Learn new answer template variation if distinct
            if (aiAnswer && aiAnswer.trim().length >= 8 && !aiAnswer.toLowerCase().includes('error')) {
              const existingTemplates = this.answerTemplates.get(pat.id) || [];
              const isDuplicate = existingTemplates.some(t => {
                const s = this.calculateSimilarity(this.normalize(t.template), this.normalize(aiAnswer));
                return s >= 0.85;
              });

              if (!isDuplicate && existingTemplates.length < 6) {
                const newVarId = crypto.randomUUID();
                const newVar: PatternAnswerTemplateRecord = {
                  id: newVarId,
                  pattern_id: pat.id,
                  template_type: 'success',
                  variant_name: `variation_${existingTemplates.length + 1}`,
                  template: aiAnswer,
                  priority: existingTemplates.length + 1,
                  usage_count: 1,
                  is_active: true,
                  created_at: now,
                };
                existingTemplates.push(newVar);
                this.answerTemplates.set(pat.id, existingTemplates);

                // If variations reach target_variants, mark pattern as matured
                if (existingTemplates.length >= (pat.target_variants || 3)) {
                  pat.learning_stage = 'matured';
                  if (pool) {
                    pool.query(
                      `UPDATE knowledge_patterns SET learning_stage = 'matured', updated_at = NOW() WHERE id = $1`,
                      [pat.id]
                    ).catch(() => {});
                  }
                }

                if (pool) {
                  pool.query(
                    `INSERT INTO pattern_answer_templates (id, pattern_id, template_type, variant_name, template, priority, usage_count, is_active, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
                    [newVar.id, newVar.pattern_id, newVar.template_type, newVar.variant_name, newVar.template, newVar.priority, newVar.usage_count, newVar.is_active, newVar.created_at]
                  ).catch(() => {});
                }

                if (multiLangEngine.detectLanguage(aiAnswer) === 'en') {
                  multiLangEngine.setAnswerTranslation(newVarId, 'en', aiAnswer);
                }
              }
            }

            const aiLang = multiLangEngine.detectLanguage(aiAnswer);
            if (aiLang && aiLang !== 'bn') {
              multiLangEngine.setPatternTranslation(pat.id, aiLang, [query], pat.description);
              const allTemplates = this.answerTemplates.get(pat.id) || [];
              for (const t of allTemplates) {
                if (!multiLangEngine.hasExactTranslation(t.id, aiLang)) {
                  multiLangEngine.setAnswerTranslation(t.id, aiLang, aiAnswer);
                }
              }
            }
            
            // Broadcast live update
            store.notifyBroadcast({
              type: 'pattern:learned',
              project_id: projectId,
              data: {
                pattern: pat,
                is_existing_updated: true,
                query,
              },
            });
            return pat;
          }
        }
      }
    }

    // Derive intent name from query keywords (with full Unicode/Bengali support)
    const unicodeWords = query
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .trim()
      .split(/\s+/)
      .filter(w => w.length > 0)
      .slice(0, 3)
      .join('_');

    const intentSlug = unicodeWords || `auto_query_${Date.now().toString().slice(-4)}`;
    const category = toolsUsed.length > 0 ? 'workflow' : 'general_faq';

    const newPattern: KnowledgePatternRecord = {
      id: patternId,
      project_id: projectId,
      intent: `${intentSlug}_${Date.now().toString().slice(-4)}`,
      pattern_type: toolsUsed.length > 0 ? 'command' : 'question',
      example_phrases: [query],
      description: `Auto-learned pattern from user query: "${query.slice(0, 60)}"`,
      category,
      source: 'auto_learned',
      confidence_score: 0.98,
      usage_count: 1,
      success_count: 1,
      failure_count: 0,
      is_active: true,
      is_verified: false,
      learning_stage: 'learning',
      target_variants: 3,
      quality_score: 1.0,
      created_at: now,
      updated_at: now,
      last_used_at: now,
    };

    this.patterns.set(patternId, newPattern);

    // Save answer template
    const templateId = crypto.randomUUID();
    const newTemplate: PatternAnswerTemplateRecord = {
      id: templateId,
      pattern_id: patternId,
      template_type: 'success',
      variant_name: 'variation_1',
      template: aiAnswer,
      priority: 1,
      usage_count: 1,
      is_active: true,
      created_at: now,
    };
    this.answerTemplates.set(patternId, [newTemplate]);

    // Save tool sequence if tools were executed
    if (toolsUsed.length > 0) {
      const seqList: PatternToolSequenceRecord[] = toolsUsed.map((tName, idx) => {
        const matchingPlan = plannedTools && plannedTools.find(pt => pt.name === tName);
        const inputMapping = matchingPlan?.args ? { ...matchingPlan.args } : {};
        return {
          id: crypto.randomUUID(),
          pattern_id: patternId,
          step_number: idx + 1,
          tool_name: tName,
          tool_type: 'server',
          input_mapping: inputMapping,
          output_key: `result_${idx + 1}`,
          is_optional: false,
          on_error: 'stop',
          max_retries: 0,
          timeout_seconds: 60,
          created_at: now,
        };
      });
      this.toolSequences.set(patternId, seqList);
    }

    // Persist to Postgres if available
    if (pool) {
      try {
        await ensureProjectInDb(projectId);
        await pool.query(
          `INSERT INTO knowledge_patterns (id, project_id, intent, pattern_type, example_phrases, description, category, source, confidence_score, usage_count, success_count, failure_count, is_active, is_verified, learning_stage, target_variants, quality_score, created_at, updated_at, last_used_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
           ON CONFLICT DO NOTHING`,
          [
            newPattern.id,
            newPattern.project_id,
            newPattern.intent,
            newPattern.pattern_type,
            JSON.stringify(newPattern.example_phrases),
            newPattern.description,
            newPattern.category,
            newPattern.source,
            newPattern.confidence_score,
            newPattern.usage_count,
            newPattern.success_count,
            newPattern.failure_count,
            newPattern.is_active,
            newPattern.is_verified,
            newPattern.learning_stage,
            newPattern.target_variants,
            newPattern.quality_score,
            newPattern.created_at,
            newPattern.updated_at,
            newPattern.last_used_at,
          ]
        );

        await pool.query(
          `INSERT INTO pattern_answer_templates (id, pattern_id, template_type, variant_name, template, priority, usage_count, is_active, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT DO NOTHING`,
          [
            newTemplate.id,
            newTemplate.pattern_id,
            newTemplate.template_type,
            newTemplate.variant_name,
            newTemplate.template,
            newTemplate.priority,
            newTemplate.usage_count,
            newTemplate.is_active,
            newTemplate.created_at,
          ]
        );
      } catch (err: any) {
        console.warn('[KnowledgePatternEngine] Auto-learn DB write error:', err.message);
      }
    }

    const aiLang = multiLangEngine.detectLanguage(aiAnswer);
    if (aiLang && aiLang !== 'bn') {
      multiLangEngine.setAnswerTranslation(templateId, aiLang, aiAnswer);
      multiLangEngine.setPatternTranslation(patternId, aiLang, [query], newPattern.description);
    }

    // Log learning event
    feedbackEngine.logPatternLearning({
      pattern_id: patternId,
      learned_from_user_id: userId,
      learning_method: 'ai_teacher_synthesis',
      previous_version: null,
      new_version: { pattern: newPattern, template: newTemplate },
      verified_by_admin: false,
    }).catch(() => {});

    // Broadcast real-time live learning event to frontend UI via WebSocket
    store.notifyBroadcast({
      type: 'pattern:learned',
      project_id: projectId,
      data: {
        pattern: newPattern,
        template: newTemplate,
        tools_used: toolsUsed,
        query,
      },
    });

    return newPattern;
  }

  /**
   * Save a conversation message with strict 24-hour expiration
   */
  async logConversationMessage(params: {
    projectId: string;
    userId: string;
    sessionId: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    detectedPatternId?: string;
    detectedIntent?: string;
    confidenceScore?: number;
    executedSteps?: any[];
    finalAnswer?: string;
    wasAiCalled: boolean;
    executionTimeMs: number;
    tokensUsed: number;
    language?: string;
  }): Promise<void> {
    const pool = getPgPool();
    if (!pool) return;

    try {
      await ensureProjectInDb(params.projectId);
      const now = new Date();
      // Calculate next 1:00 AM in Asia/Dhaka timezone
      const dhakaTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }));
      const expiresAt = new Date(now);
      
      // Calculate how many hours to add to reach next 1 AM Dhaka time
      let hoursToAdd = 0;
      if (dhakaTime.getHours() < 1) {
          hoursToAdd = 1 - dhakaTime.getHours();
      } else {
          hoursToAdd = 24 - dhakaTime.getHours() + 1;
      }
      expiresAt.setHours(expiresAt.getHours() + hoursToAdd);
      expiresAt.setMinutes(0);
      expiresAt.setSeconds(0);
      expiresAt.setMilliseconds(0); 
      
      const nowIso = now.toISOString();
      const expiresAtIso = expiresAt.toISOString();

      // Upsert conversation session with 24h expiration
      const convRes = await pool.query(
        `INSERT INTO user_conversations (id, project_id, user_id, session_id, started_at, last_message_at, message_count, language, is_active, expires_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 1, $6, TRUE, $7)
         ON CONFLICT (session_id) 
         DO UPDATE SET last_message_at = $5, message_count = user_conversations.message_count + 1, expires_at = $7
         RETURNING id`,
        [
          params.projectId,
          params.userId,
          params.sessionId,
          nowIso,
          nowIso,
          params.language || 'bn',
          expiresAtIso,
        ]
      );

      const conversationId = convRes.rows[0]?.id;
      if (conversationId) {
        let validPatternId: string | null = null;
        if (params.detectedPatternId && isUuid(params.detectedPatternId)) {
          const patCheck = await pool.query(`SELECT id FROM knowledge_patterns WHERE id = $1 LIMIT 1`, [params.detectedPatternId]);
          if (patCheck.rows.length > 0) {
            validPatternId = params.detectedPatternId;
          }
        }

        await pool.query(
          `INSERT INTO user_messages (id, conversation_id, project_id, user_id, role, content, detected_pattern_id, detected_intent, confidence_score, executed_steps, final_answer, was_ai_called, execution_time_ms, tokens_used, status, created_at, expires_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'completed', $14, $15)`,
          [
            conversationId,
            params.projectId,
            params.userId,
            params.role,
            params.content,
            validPatternId,
            params.detectedIntent || null,
            params.confidenceScore || null,
            JSON.stringify(params.executedSteps || []),
            params.finalAnswer || null,
            params.wasAiCalled,
            params.executionTimeMs,
            params.tokensUsed,
            nowIso,
            expiresAtIso,
          ]
        );
      }
    } catch (err: any) {
      console.warn('[KnowledgePatternEngine] Message log DB error:', err.message);
    }
  }

  /**
   * List all knowledge patterns with their tool sequences and answer templates
   */
  listPatterns(projectId?: string): Array<KnowledgePatternRecord & {
    pattern: KnowledgePatternRecord;
    sequences: PatternToolSequenceRecord[];
    templates: Array<PatternAnswerTemplateRecord & { template_text: string }>;
    missingInputs: PatternMissingInputRecord[];
  }> {
    const list: any[] = [];
    for (const p of this.patterns.values()) {
      if (projectId && !isPatternAllowedForProject(p.project_id, p.intent, projectId)) {
        continue;
      }
      const rawTemplates = this.answerTemplates.get(p.id) || [];
      const normalizedTemplates = rawTemplates.map(t => ({
        ...t,
        template_text: (t as any).template_text || t.template || '',
      }));
      list.push({
        ...p,
        pattern: p,
        sequences: this.toolSequences.get(p.id) || [],
        templates: normalizedTemplates,
        missingInputs: this.missingInputs.get(p.id) || [],
      });
    }
    return list;
  }

  purgeProjectData(projectId: string) {
    for (const [id, p] of this.patterns.entries()) {
      if (p.project_id === projectId) {
        this.patterns.delete(id);
        this.toolSequences.delete(id);
        this.answerTemplates.delete(id);
        this.missingInputs.delete(id);
      }
    }
  }

  /**
   * Search matching example phrases across active patterns for auto-suggest while typing

   */
  suggest(projectId: string, query: string, limit = 6): Array<{ phrase: string; intent: string; category: string }> {
    if (!query || query.trim().length < 1) return [];
    const cleanQ = query.trim().toLowerCase();
    const suggestions: Array<{ phrase: string; intent: string; category: string }> = [];
    const seen = new Set<string>();

    for (const pattern of this.patterns.values()) {
      if (!pattern.is_active) continue;
      // Match patterns belonging to this project only
      if (pattern.project_id !== projectId) {
        continue;
      }

      for (const phrase of pattern.example_phrases) {
        const cleanPhrase = phrase.toLowerCase();
        if (cleanPhrase.includes(cleanQ) && !seen.has(cleanPhrase)) {
          seen.add(cleanPhrase);
          suggestions.push({
            phrase,
            intent: pattern.intent,
            category: pattern.category,
          });
          if (suggestions.length >= limit) break;
        }
      }
      if (suggestions.length >= limit) break;
    }

    return suggestions;
  }

  /**
   * Approve an auto-learned pattern (verify and boost confidence)
   */
  async approvePattern(patternId: string): Promise<KnowledgePatternRecord | null> {
    const pattern = this.patterns.get(patternId);
    if (!pattern) return null;

    pattern.is_verified = true;
    pattern.confidence_score = Math.max(0.95, pattern.confidence_score);
    pattern.updated_at = new Date().toISOString();

    const pool = getPgPool();
    if (pool && isUuid(patternId)) {
      try {
        await pool.query(
          `UPDATE knowledge_patterns 
           SET is_verified = TRUE, confidence_score = $1, updated_at = NOW() 
           WHERE id = $2`,
          [pattern.confidence_score, patternId]
        );
      } catch (err: any) {
        console.warn('[KnowledgePatternEngine] Approve DB error:', err.message);
      }
    }

    highSpeedCacheEngine.invalidate(pattern.project_id);
    return pattern;
  }

  /**
   * Update an existing pattern (intent, phrases, description, template)
   */
  async updatePattern(
    patternId: string,
    updates: {
      intent?: string;
      description?: string;
      category?: string;
      example_phrases?: string[];
      is_active?: boolean;
      template?: string;
      suggested_chips?: string[];
    }
  ): Promise<KnowledgePatternRecord | null> {
    const pattern = this.patterns.get(patternId);
    if (!pattern) return null;

    if (updates.intent !== undefined) pattern.intent = updates.intent;
    if (updates.description !== undefined) pattern.description = updates.description;
    if (updates.category !== undefined) pattern.category = updates.category;
    if (updates.example_phrases !== undefined) pattern.example_phrases = updates.example_phrases;
    if (updates.is_active !== undefined) pattern.is_active = updates.is_active;
    if (updates.suggested_chips !== undefined) pattern.suggested_chips = updates.suggested_chips;
    pattern.updated_at = new Date().toISOString();

    if (updates.template) {
      const templates = this.answerTemplates.get(patternId) || [];
      if (templates.length > 0) {
        templates[0].template = updates.template;
      } else {
        const newT: PatternAnswerTemplateRecord = {
          id: crypto.randomUUID(),
          pattern_id: patternId,
          template_type: 'success',
          variant_name: 'short',
          template: updates.template,
          priority: 1,
          usage_count: 0,
          is_active: true,
          created_at: new Date().toISOString(),
        };
        this.answerTemplates.set(patternId, [newT]);
      }
    }

    const pool = getPgPool();
    if (pool && isUuid(patternId)) {
      try {
        await pool.query(
          `UPDATE knowledge_patterns 
           SET intent = $1, description = $2, category = $3, example_phrases = $4, is_active = $5, updated_at = NOW() 
           WHERE id = $6`,
          [
            pattern.intent,
            pattern.description,
            pattern.category,
            pattern.example_phrases,
            pattern.is_active,
            patternId,
          ]
        );
      } catch (err: any) {
        console.warn('[KnowledgePatternEngine] Update DB error:', err.message);
      }
    }

    highSpeedCacheEngine.invalidate(pattern.project_id);
    return pattern;
  }

  /**
   * Delete a pattern from memory and DB
   */
  async deletePattern(patternId: string): Promise<boolean> {
    const pattern = this.patterns.get(patternId);
    if (!pattern) return false;

    const projectId = pattern.project_id;
    this.patterns.delete(patternId);
    this.toolSequences.delete(patternId);
    this.answerTemplates.delete(patternId);
    this.missingInputs.delete(patternId);

    const pool = getPgPool();
    if (pool && isUuid(patternId)) {
      try {
        await pool.query(`DELETE FROM knowledge_patterns WHERE id = $1`, [patternId]);
        await pool.query(`DELETE FROM pattern_answer_templates WHERE pattern_id = $1`, [patternId]);
        await pool.query(`DELETE FROM pattern_tool_sequences WHERE pattern_id = $1`, [patternId]);
      } catch (err: any) {
        console.warn('[KnowledgePatternEngine] Delete DB error:', err.message);
      }
    }

    highSpeedCacheEngine.invalidate(projectId);
    return true;
  }

  /**
   * Delete a specific answer template variation from a pattern
   */
  async deletePatternTemplate(projectId: string, patternId: string, templateId: string): Promise<boolean> {
    const templates = this.answerTemplates.get(patternId) || [];
    const filtered = templates.filter(t => t.id !== templateId);
    this.answerTemplates.set(patternId, filtered);

    const pool = getPgPool();
    if (pool && isUuid(templateId)) {
      try {
        await pool.query(
          `DELETE FROM pattern_answer_templates WHERE id = $1 AND pattern_id = $2`,
          [templateId, patternId]
        );
      } catch (err: any) {
        console.warn('[KnowledgePatternEngine] Delete template DB error:', err.message);
      }
    }

    highSpeedCacheEngine.invalidate(projectId);
    return true;
  }

  /**
   * Find and delete any patterns matching a trigger text (used during user corrections)
   */
  async invalidatePatternByTriggerText(projectId: string, triggerText: string): Promise<void> {
    const cleanTrigger = this.normalize(triggerText);
    if (!cleanTrigger) return;

    const toDelete: string[] = [];

    for (const pat of this.patterns.values()) {
      if (isPatternAllowedForProject(pat.project_id, pat.intent, projectId)) {
        for (const phr of pat.example_phrases) {
          const sim = this.calculateSimilarity(cleanTrigger, this.normalize(phr));
          if (sim >= 0.85) {
            toDelete.push(pat.id);
            break;
          }
        }
      }
    }

    for (const id of toDelete) {
      console.log(`[KnowledgePatternEngine] Invalidating pattern ${id} due to user correction feedback`);
      await this.deletePattern(id);
    }
  }
}

export const knowledgePatternEngine = new KnowledgePatternEngine();
