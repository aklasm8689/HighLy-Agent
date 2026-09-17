import crypto from 'crypto';
import { getPgPool } from '../../db';
import {
  PatternTranslationRecord,
  AnswerTranslationRecord,
  LanguageRecord,
} from './types';

function isUuid(id: any): boolean {
  if (!id || typeof id !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export class MultiLanguageEngine {
  private languages = new Map<string, LanguageRecord>();
  private patternTranslations = new Map<string, Map<string, PatternTranslationRecord>>(); // patternId -> (lang -> record)
  private answerTranslations = new Map<string, Map<string, AnswerTranslationRecord>>(); // templateId -> (lang -> record)

  constructor() {
    this.seedDefaultLanguages();
    this.loadTranslationsFromDb().catch(() => {});
  }

  /**
   * Load persisted translations from PostgreSQL into memory
   */
  async loadTranslationsFromDb(): Promise<void> {
    const pool = getPgPool();
    if (!pool) return;
    try {
      // 1. Load pattern translations
      const ptRes = await pool.query(`SELECT * FROM pattern_translations`);
      for (const row of ptRes.rows) {
        let pMap = this.patternTranslations.get(row.pattern_id);
        if (!pMap) {
          pMap = new Map();
          this.patternTranslations.set(row.pattern_id, pMap);
        }
        let phrases: string[] = [];
        try {
          phrases = typeof row.example_phrases === 'string' ? JSON.parse(row.example_phrases) : (row.example_phrases || []);
        } catch {
          phrases = [];
        }
        pMap.set(row.language, {
          id: row.id,
          pattern_id: row.pattern_id,
          language: row.language,
          example_phrases: phrases,
          description: row.description,
          is_default: Boolean(row.is_default),
          confidence_score: Number(row.confidence_score || 0.95),
          usage_count: Number(row.usage_count || 0),
          created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
          updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
        });
      }

      // 2. Load answer translations
      const atRes = await pool.query(`SELECT * FROM answer_translations`);
      for (const row of atRes.rows) {
        let aMap = this.answerTranslations.get(row.template_id);
        if (!aMap) {
          aMap = new Map();
          this.answerTranslations.set(row.template_id, aMap);
        }
        let varsMap: Record<string, string> = {};
        try {
          varsMap = typeof row.variables_mapping === 'string' ? JSON.parse(row.variables_mapping) : (row.variables_mapping || {});
        } catch {
          varsMap = {};
        }
        aMap.set(row.language, {
          id: row.id,
          template_id: row.template_id,
          language: row.language,
          template: row.template,
          variables_mapping: varsMap,
          confidence_score: Number(row.confidence_score || 0.95),
          is_default: Boolean(row.is_default),
          usage_count: Number(row.usage_count || 0),
          created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
          updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
        });
      }
    } catch (err: any) {
      console.warn('[MultiLangEngine] DB load translations error:', err.message);
    }
  }

  private seedDefaultLanguages() {
    const defaults: LanguageRecord[] = [
      { id: '1', code: 'bn', name: 'Bengali', native_name: 'বাংলা', direction: 'ltr', is_active: true, created_at: new Date().toISOString() },
      { id: '2', code: 'en', name: 'English', native_name: 'English', direction: 'ltr', is_active: true, created_at: new Date().toISOString() },
      { id: '3', code: 'banglish', name: 'Banglish', native_name: 'Banglish', direction: 'ltr', is_active: true, created_at: new Date().toISOString() },
      { id: '4', code: 'hi', name: 'Hindi', native_name: 'हिन्दी', direction: 'ltr', is_active: true, created_at: new Date().toISOString() },
      { id: '5', code: 'ar', name: 'Arabic', native_name: 'العربية', direction: 'rtl', is_active: true, created_at: new Date().toISOString() },
      { id: '6', code: 'es', name: 'Spanish', native_name: 'Español', direction: 'ltr', is_active: true, created_at: new Date().toISOString() },
      { id: '7', code: 'fr', name: 'French', native_name: 'Français', direction: 'ltr', is_active: true, created_at: new Date().toISOString() },
      { id: '8', code: 'de', name: 'German', native_name: 'Deutsch', direction: 'ltr', is_active: true, created_at: new Date().toISOString() },
      { id: '9', code: 'ur', name: 'Urdu', native_name: 'اردو', direction: 'rtl', is_active: true, created_at: new Date().toISOString() },
    ];
    for (const l of defaults) {
      this.languages.set(l.code, l);
    }
  }

  /**
   * Check if user explicitly asked to speak in a specific language
   */
  detectLanguageRequest(text: string): string | null {
    if (!text) return null;
    const clean = text.trim().toLowerCase();

    // Direct match for language codes or names (Never match "hi" as Hindi, because "hi" is the standard English greeting!)
    if (/^(english|ingreji|angrezi)$/i.test(clean)) return 'en';
    if (/^(bangla|bengali|বাংলা|বাংলায়)$/i.test(clean)) return 'bn';
    if (/^(banglish|banglis|banglaish|bangleesh)$/i.test(clean)) return 'banglish';
    if (/^(hindi|hindi\s+bhasha|hindi\s+language|हिंदी|हिन्दी)$/i.test(clean)) return 'hi';
    if (/^(arabic|arabi|عربي|العربية)$/i.test(clean)) return 'ar';
    if (/^(spanish|espanol|español)$/i.test(clean)) return 'es';
    if (/^(french|francais|français)$/i.test(clean)) return 'fr';
    if (/^(german|deutsch)$/i.test(clean)) return 'de';
    if (/^(urdu|اردو)$/i.test(clean)) return 'ur';

    // Banglish explicit request (e.g., "banglis bolo", "banglish bolo amar jono", "banglish e kotha bolo", "speak in banglish")
    if (
      /\b(banglish|banglis|banglaish|bangleesh)\b/i.test(clean) &&
      (/\b(bolba|bolo|bolben|bolte|bolchen|kotha|speak|talk|chat|reply|answer|use|akhn|akhon|now|please|chai|jonno|jono|amar|amr|korba|koro|bol)\b/i.test(clean) ||
       /\b(in\s+banglish|in\s+banglis|banglish\s+please|banglis\s+please|speak\s+banglish|talk\s+banglish)\b/i.test(clean))
    ) {
      return 'banglish';
    }

    // Bengali explicit request (e.g., "bangla te kotha bolo", "akhon banglay bolba", "বাংলায় কথা বলুন", "bangla bolo")
    if (
      /\b(bangla|bengali|banglay|বাংলা|বাংলায়)\b/i.test(clean) &&
      (/\b(bolba|bolo|bolben|bolte|bolchen|kotha|kothopokothon|bhasha|speak|talk|chat|reply|answer|say|use|akhn|akhon|please|now|chai|jonno|jono|bolchi|বলুন|বলেন|কথা|চাই|বলো|বলা|করুন)\b/i.test(clean) ||
       /\b(in\s+bangla|in\s+bengali|bangla\s+please|বাংলায়\s+বলুন|বাংলায়\s+বলুন|speak\s+bangla|talk\s+in\s+bangla)\b/i.test(clean))
    ) {
      return 'bn';
    }

    // English explicit request (e.g., "akhn english bolba", "english bolar jo0no bolchi", "speak english", "english please")
    if (
      /\b(english|ingreji|angrezi)\b/i.test(clean) &&
      (/\b(bolba|bolo|bolben|bolte|bolchen|kotha|kothopokothon|bhasha|bhasa|speak|talk|chat|reply|answer|say|use|akhn|akhon|now|please|shikhe|chai|jonno|jono|jo0no|bolchi|boltechi|prefer|in)\b/i.test(clean) ||
       /\b(in\s+english|speak\s+english|english\s+please|prefer\s+english|talk\s+english)\b/i.test(clean))
    ) {
      return 'en';
    }

    // Hindi explicit request
    if (
      /\b(hindi|हिन्दी|हिंदी)\b/i.test(clean) &&
      (/\b(bolo|bolba|boliye|baat|bhasha|speak|talk|chat|reply|me|mein|में|बोलिए|बोलो)\b/i.test(clean) ||
       /\b(in\s+hindi|hindi\s+please)\b/i.test(clean))
    ) {
      return 'hi';
    }

    // Arabic explicit request
    if (
      /\b(arabic|arabi|عربي|العربية)\b/i.test(clean) &&
      (/\b(bolo|bolba|speak|talk|chat|reply|te|e|تكلم|بالعربي)\b/i.test(clean) ||
       /\b(in\s+arabic|arabic\s+please)\b/i.test(clean))
    ) {
      return 'ar';
    }

    // Spanish explicit request
    if (
      /\b(spanish|espanol|español)\b/i.test(clean) &&
      (/\b(speak|talk|chat|habla|en|bolo)\b/i.test(clean) ||
       /\b(in\s+spanish|spanish\s+please)\b/i.test(clean))
    ) {
      return 'es';
    }

    // French explicit request
    if (
      /\b(french|francais|français)\b/i.test(clean) &&
      (/\b(speak|talk|chat|parle|en|bolo)\b/i.test(clean) ||
       /\b(in\s+french|french\s+please)\b/i.test(clean))
    ) {
      return 'fr';
    }

    // German explicit request
    if (
      /\b(german|deutsch)\b/i.test(clean) &&
      (/\b(speak|talk|chat|sprich|auf|bolo)\b/i.test(clean) ||
       /\b(in\s+german|german\s+please)\b/i.test(clean))
    ) {
      return 'de';
    }

    // Urdu explicit request
    if (
      /\b(urdu|اردو)\b/i.test(clean) &&
      (/\b(speak|talk|chat|bolo|me|mein|بولیں)\b/i.test(clean) ||
       /\b(in\s+urdu|urdu\s+please)\b/i.test(clean))
    ) {
      return 'ur';
    }

    return null;
  }

  /**
   * Fast script, request, & keyword-based language detector
   */
  detectLanguage(text: string, defaultPreference = 'bn'): string {
    const clean = text.trim();
    if (!clean) return defaultPreference || 'bn';

    // 1. Check explicit language switch request first
    const explicitReq = this.detectLanguageRequest(clean);
    if (explicitReq) {
      return explicitReq;
    }

    // 2. Check Bengali Unicode block [\u0980-\u09FF]
    if (/[\u0980-\u09FF]/.test(clean)) {
      return 'bn';
    }

    // 3. Check Arabic/Urdu Unicode block [\u0600-\u06FF]
    if (/[\u0600-\u06FF]/.test(clean)) {
      return 'ar';
    }

    // 4. Check Devanagari (Hindi) Unicode block [\u0900-\u097F]
    if (/[\u0900-\u097F]/.test(clean)) {
      return 'hi';
    }

    // 5. Check Banglish keywords (Bengali phonetically typed in English alphabet)
    const banglishWords = [
      'kemon', 'achen', 'acho', 'asen', 'aso', 'amar', 'amr', 'tomar', 'tmr', 'apnar', 'shunte', 'parchen', 'dhonnobad',
      'ki', 'khobor', 'obosta', 'obstha', 'bhai', 'apni', 'tumi', 'ami', 'lagbe', 'chai', 'kothay', 'koto',
      'kobe', 'dorkar', 'pari', 'bolo', 'korben', 'bolen', 'shikhe', 'rakhbe', 'bolchi', 'boltechi',
      'ken', 'keno', 'akta', 'ekta', 'onujayi', 'bivinno', 'thakbe', 'dei', 'jono', 'jonno', 'bujlam', 'bujhi',
      'bujhte', 'parchi', 'bolte', 'kotha', 'shuno', 'shuncho', 'dekho', 'dekhte', 'hobe', 'hobey', 'korbo',
      'korchi', 'koro', 'valo', 'bhalo', 'kichu', 'kisu', 'sob', 'somoy', 'ditache', 'diteso', 'dicche', 'jani', 'janen',
      'shob', 'shomoy', 'banglis', 'banglish', 'bangla', 'bangle', 'tahole', 'amni', 'chole', 'kintu', 'suru', 'shuru',
      'dile', 'eta', 'oita', 'diba', 'dibe', 'bujhlam', 'jodi', 'chalu', 'hoye', 'pabar', 'parar', 'abar', 'amon',
      'emne', 'korle', 'deya', 'dei', 'apnader', 'amader', 'koro', 'kori', 'korsi'
    ];
    
    // Hinglish keywords (Hindi phonetically typed in English alphabet)
    const hinglishWords = [
      'kaise', 'kya', 'haal', 'mera', 'tera', 'apka', 'hum', 'tum', 'karo', 'karna', 'chahiye',
      'bhai', 'namaste', 'shukriya', 'theek', 'hai', 'hain', 'mujhe', 'batao', 'boliye', 'karein',
      'aap', 'tumhara', 'apna', 'hoga', 'hogi', 'kuch', 'bataiye'
    ];

    const lower = clean.toLowerCase();
    const words = lower.split(/[\s,?.!;:()_\-]+/).filter(Boolean);

    // Common pure English greetings/commands
    const englishExactTriggers = ['hi', 'hello', 'hey', 'help', 'test', 'ping', 'who are you', 'how are you', 'good morning', 'good afternoon', 'good evening', 'thanks', 'thank you'];
    if (englishExactTriggers.includes(lower)) {
      return 'en';
    }

    const hasBanglish = words.some((w) => banglishWords.includes(w));
    if (hasBanglish) {
      return 'bn'; // Map Banglish directly to native Bengali target
    }

    const hasHinglish = words.some((w) => hinglishWords.includes(w));
    if (hasHinglish) {
      return 'hi'; // Map Hinglish directly to native Hindi target
    }

    // 6. Check Latin characters (English)
    // If text has Latin characters, no Bengali Unicode, and no Banglish keywords, it is English!
    if (/[a-zA-Z]/.test(clean)) {
      return 'en';
    }

    return defaultPreference || 'en';
  }

  /**
   * Register or update a pattern translation
   */
  async setPatternTranslation(
    patternId: string,
    language: string,
    examplePhrases: string[],
    description?: string,
    isDefault = false
  ): Promise<PatternTranslationRecord> {
    const now = new Date().toISOString();
    let pMap = this.patternTranslations.get(patternId);
    if (!pMap) {
      pMap = new Map();
      this.patternTranslations.set(patternId, pMap);
    }

    const existing = pMap.get(language);
    const record: PatternTranslationRecord = {
      id: existing?.id || crypto.randomUUID(),
      pattern_id: patternId,
      language,
      example_phrases: examplePhrases,
      description,
      is_default: isDefault,
      confidence_score: 0.95,
      usage_count: existing?.usage_count || 0,
      created_at: existing?.created_at || now,
      updated_at: now,
    };

    pMap.set(language, record);

    const pool = getPgPool();
    if (pool && isUuid(record.pattern_id)) {
      (async () => {
        try {
          const check = await pool.query(`SELECT id FROM knowledge_patterns WHERE id = $1 LIMIT 1`, [record.pattern_id]);
          if (check.rows.length === 0) return;

          await pool.query(
            `INSERT INTO pattern_translations (id, pattern_id, language, example_phrases, description, is_default, confidence_score, usage_count, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (pattern_id, language) DO UPDATE SET example_phrases = $4, description = $5, updated_at = NOW()`,
            [
              record.id,
              record.pattern_id,
              record.language,
              JSON.stringify(record.example_phrases),
              record.description || null,
              record.is_default,
              record.confidence_score,
              record.usage_count,
              record.created_at,
              record.updated_at,
            ]
          );
        } catch (e: any) {
          console.warn('[MultiLangEngine] DB write error:', e.message);
        }
      })();
    }

    return record;
  }

  /**
   * Register or update an answer translation
   */
  async setAnswerTranslation(
    templateId: string,
    language: string,
    templateText: string,
    variablesMapping: Record<string, string> = {},
    isDefault = false
  ): Promise<AnswerTranslationRecord> {
    const now = new Date().toISOString();
    let aMap = this.answerTranslations.get(templateId);
    if (!aMap) {
      aMap = new Map();
      this.answerTranslations.set(templateId, aMap);
    }

    const existing = aMap.get(language);
    const record: AnswerTranslationRecord = {
      id: existing?.id || crypto.randomUUID(),
      template_id: templateId,
      language,
      template: templateText,
      variables_mapping: variablesMapping,
      confidence_score: 0.95,
      is_default: isDefault,
      usage_count: existing?.usage_count || 0,
      created_at: existing?.created_at || now,
      updated_at: now,
    };

    aMap.set(language, record);

    const pool = getPgPool();
    if (pool && isUuid(record.template_id)) {
      (async () => {
        try {
          const check = await pool.query(`SELECT id FROM pattern_answer_templates WHERE id = $1 LIMIT 1`, [record.template_id]);
          if (check.rows.length === 0) return;

          await pool.query(
            `INSERT INTO answer_translations (id, template_id, language, template, variables_mapping, confidence_score, is_default, usage_count, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (template_id, language) DO UPDATE SET template = $4, variables_mapping = $5, updated_at = NOW()`,
            [
              record.id,
              record.template_id,
              record.language,
              record.template,
              JSON.stringify(record.variables_mapping),
              record.confidence_score,
              record.is_default,
              record.usage_count,
              record.created_at,
              record.updated_at,
            ]
          );
        } catch (e: any) {
          console.warn('[MultiLangEngine] Answer translation DB write error:', e.message);
        }
      })();
    }

    return record;
  }

  /**
   * Automatic high-accuracy template localizer / translator
   * Translates template text to target language while preserving {{var | fallback}} placeholders
   */
  autoTranslateTemplate(template: string, targetLanguage: string): string {
    if (!template || targetLanguage === 'bn') return template;

    // Translation dictionary for core phrase blocks & fallbacks
    const phrases: Record<string, Record<string, string>> = {
      // General Greeting / Status
      'হ্যালো': {
        en: 'Hello', banglish: 'Hello', hi: 'नमस्ते', ar: 'مرحبا', es: '¡Hola', fr: 'Bonjour', de: 'Hallo', ur: 'سلام',
      },
      'আমি আপনার সহায়ক AI। আজ আপনাকে কীভাবে সাহায্য করতে পারি?': {
        en: 'I am your AI assistant. How can I help you today?',
        banglish: 'Ami apnar shohayok AI. Aj apnake kivabe shahajjo korte pari?',
        hi: 'मैं आपका AI सहायक हूँ। आज मैं आपकी कैसे मदद कर सकता हूँ?',
        ar: 'أنا مساعدك الذكي. كيف يمكنني مساعدتك اليوم؟',
        es: 'Soy tu asistente de IA. ¿Cómo puedo ayudarte hoy?',
        fr: 'Je suis votre assistant IA. Comment puis-je vous aider aujourd\'hui?',
        de: 'Ich bin Ihr KI-Assistent. Wie kann ich Ihnen heute helfen?',
        ur: 'میں آپ کا AI اسسٹنٹ ہوں۔ آج میں آپ کی کیسے مدد کر سکتا ہوں؟',
      },
      'আমি আপনার এআই এসিস্ট্যান্ট। কীভাবে আপনাকে সাহায্য করতে পারি জানান।': {
        en: 'I am your AI assistant. Please let me know how I can help you.',
        banglish: 'Ami apnar AI assistant. Kivabe apnake shahajjo korte pari janan.',
        hi: 'मैं आपका AI सहायक हूँ। कृपया बताएं कि मैं आपकी कैसे मदद कर सकता हूँ।',
        ar: 'أنا مساعدك الذكي. يرجى إخباري كيف يمكنني مساعدتك.',
      },
      'আলহামদুলিল্লাহ্‌ আমি ভালো আছি। আজ আপনাকে কীভাবে সাহায্য করতে পারি?': {
        en: 'Alhamdulillah, I am doing well. How can I help you today?',
        banglish: 'Alhamdulillah ami bhalo achi. Aj apnake kivabe shahajjo korte pari?',
        hi: 'अल्हम्दुलिल्लाह, मैं ठीक हूँ। आज मैं आपकी कैसे मदद कर सकता हूँ?',
        ar: 'الحمد لله، أنا بخير. كيف يمكنني مساعدتك اليوم؟',
        es: 'Alhamdulillah, estoy bien. ¿Cómo puedo ayudarte hoy?',
        fr: 'Alhamdulillah, je vais bien. Comment puis-je vous aider aujourd\'hui?',
      },
      'হ্যাঁ বলুন, আমি শুনছি! আপনার কোনো নির্দিষ্ট তথ্যের প্রয়োজন হলে নির্দ্বিধায় জানান।': {
        en: 'Yes please, I am listening! Feel free to let me know if you need any specific information.',
        banglish: 'Hae bolun, ami shunchi! Apnar kono nirdishto tothyer proyojon hole nirdidhay janan.',
        hi: 'हाँ बोलिए, मैं सुन रहा हूँ! यदि आपको कोई विशिष्ट जानकारी चाहिए तो बेझिझक बताएं।',
        ar: 'نعم تفضل، أنا أستمع! لا تتردد في إخباري إذا كنت بحاجة إلى أي معلومات محددة.',
      },
      'ওয়ালাইকুম আসসালাম!': {
        en: 'Wa Alaikum Assalam!', banglish: 'Wa Alaikum Assalam!', hi: 'वालेकुम अस्सलाम!', ar: 'وعليكم السلام!', es: 'Wa Alaikum Assalam!', fr: 'Wa Alaikum Assalam!',
      },
      'ওয়ালাইকুম আসসালাম ওয়া রহমাতুল্লাহ!': {
        en: 'Wa Alaikum Assalam wa Rahmatullah!', banglish: 'Wa Alaikum Assalam wa Rahmatullah!', hi: 'वालेकुम अस्सलाम व रहमतुल्लाह!', ar: 'وعليكم السلام ورحمة الله!',
      },
      'অবশ্যই! আমি এখন থেকে বাংলায় কথা বলব। আপনাকে কীভাবে সাহায্য করতে পারি?': {
        en: 'Sure! I will speak with you in English now. How can I help you today?',
        banglish: 'Oboshoy! Ami ekhon theke Banglish e kotha bolbo. Apnake kivabe shahajjo korte pari?',
        hi: 'ज़रूर! मैं अब आपसे हिंदी में बात करूँगा। आज मैं आपकी कैसे मदद कर सकता हूँ?',
        ar: 'بالتأكيد! سأتحدث معك باللغة العربية الآن. كيف يمكنني مساعدتك اليوم؟',
        es: '¡Por supuesto! Hablaré contigo en español ahora. ¿Cómo puedo ayudarte hoy?',
        fr: 'Bien sûr! Je vais parler avec vous en français maintenant. Comment puis-je vous aider aujourd\'hui?',
      },
      // Order tracking
      'এর বর্তমান স্ট্যাটাস:': {
        en: 'current status is:', banglish: 'er bortoman status:', hi: 'की वर्तमान स्थिति:', ar: 'الحالة الحالية:', es: 'el estado actual es:', fr: 'le statut actuel est:',
      },
      'আনুমানিক ডেলিভারি সময়:': {
        en: 'Estimated delivery time:', banglish: 'Anumanik delivery somoy:', hi: 'अनुमानित डिलीवरी समय:', ar: 'وقت التسليم المقدر:', es: 'Tiempo estimado de entrega:', fr: 'Heure de livraison estimée:',
      },
      'আপনার অর্ডারটির ট্র্যাকিং তথ্য পেতে সহায়কের কাছে যেকোনো সময় অনুসন্ধান পাঠাতে পারেন।': {
        en: 'You can send an inquiry to the assistant anytime to get your order tracking information.',
        banglish: 'Apnar order er tracking tothyo pete shohayok er kache jekono somoy inquery pathate paren.',
        hi: 'आप अपने ऑर्डर ट्रैकिंग जानकारी प्राप्त करने के लिए किसी भी समय सहायक को पूछताछ भेज सकते हैं।',
        ar: 'يمكنك إرسال استفسار إلى المساعد في أي وقت للحصول على معلومات تتبع طلبك.',
      },
      // Return policy & customer care
      'আমাদের রিটার্ন ও রিফান্ড নীতি অনুযায়ী, পণ্য প্রাপ্তির ৭ দিনের মধ্যে ত্রুটিপূর্ণ বা ক্ষতিগ্রস্ত পণ্য ফেরত দিয়ে সম্পূর্ণ রিফান্ড গ্রহণ করা যায়।': {
        en: 'According to our return and refund policy, defective or damaged products can be returned within 7 days of receipt for a full refund.',
        banglish: 'Amader return o refund niti onujayi, ponno praptir 7 diner moddhe trutipurno ba khotigrostho ponno ferot diye sompurno refund grohon kora jay.',
        hi: 'हमारी वापसी और धनवापसी नीति के अनुसार, प्राप्ति के 7 दिनों के भीतर दोषपूर्ण या क्षतिग्रस्त उत्पादों को पूर्ण रिफंड के लिए वापस किया जा सकता है।',
        ar: 'وفقًا لسياسة الإرجاع والاسترداد الخاصة بنا، يمكن إرجاع المنتجات المعيبة أو التالفة في غضون 7 أيام من الاستلام للحصول على استرداد كامل.',
      },
      'আমাদের কাস্টমার সাপোর্ট এক্সিকিউটিভের সাথে সরাসরি যোগাযোগের নম্বর: +8801700000000। সপ্তাহের ৭ দিন সকাল ৯টা থেকে রাত ১০টা পর্যন্ত সার্ভিস খোলা থাকে।': {
        en: 'Direct contact number for our customer support executive: +8801700000000. Service is open 7 days a week from 9 AM to 10 PM.',
        banglish: 'Amader customer support executive er sathe shorasori jogajog er number: +8801700000000. Soptah er 7 din sokal 9ta theke rat 10ta porjonto service khola thake.',
        hi: 'हमारे ग्राहक सेवा कार्यकारी से सीधे संपर्क का नंबर: +8801700000000। सेवा सप्ताह के 7 दिन सुबह 9 बजे से रात 10 बजे तक खुली है।',
        ar: 'رقم الاتصال المباشر لمسؤول دعم العملاء لدينا: +8801700000000. الخدمة متاحة 7 أيام في الأسبوع من 9 صباحًا حتى 10 مساءً.',
      },
      // Word/fallback translations
      'সুপ্রিয় গ্রাহক': {
        en: 'Valued Customer', banglish: 'Supriyo Grahok', hi: 'प्रिय ग्राहक', ar: 'عزيزي العميل', es: 'Estimado cliente', fr: 'Cher client',
      },
      'প্রিয় গ্রাহক': {
        en: 'Valued Customer', banglish: 'Priyograhok', hi: 'प्रिय ग्राहक', ar: 'عزيزي العميل', es: 'Estimado cliente', fr: 'Cher client',
      },
      'গ্রাহক': {
        en: 'Customer', banglish: 'Grahok', hi: 'ग्राहक', ar: 'العميل', es: 'Cliente', fr: 'Client',
      },
      'ডেলিভারির জন্য তৈরি': {
        en: 'Out for delivery', banglish: 'Out for delivery', hi: 'डिलीवरी के लिए तैयार', ar: 'جاهز للتسليم',
      },
      '২৪-৪৮ ঘণ্টার মধ্যে': {
        en: 'within 24-48 hours', banglish: 'within 24-48 hours', hi: '24-48 घंटे के भीतर', ar: 'خلال 24-48 ساعة',
      },
      'আপনার অর্ডার': {
        en: 'Your order', banglish: 'Apnar order', hi: 'आपका অর্ডার', ar: 'طلبك', es: 'Tu pedido', fr: 'Votre commande',
      },
    };

    let result = template;

    // First replace full sentences if exact match
    for (const [bng, map] of Object.entries(phrases)) {
      if (map[targetLanguage] && result.includes(bng)) {
        result = result.split(bng).join(map[targetLanguage]);
      }
    }

    // Next handle placeholders {{ variable | fallback }}
    result = result.replace(/\{\{\s*([a-zA-Z0-9_.]+)(?:\s*\|\s*([^}]+))?\s*\}\}/g, (match, varPath, fallback) => {
      if (!fallback) return match;
      const cleanFallback = fallback.trim();
      let translatedFallback = cleanFallback;

      if (phrases[cleanFallback] && phrases[cleanFallback][targetLanguage]) {
        translatedFallback = phrases[cleanFallback][targetLanguage];
      } else {
        if (cleanFallback.includes('সুপ্রিয় গ্রাহক') || cleanFallback.includes('গ্রাহক')) {
          translatedFallback = targetLanguage === 'en' ? 'Valued Customer' : targetLanguage === 'banglish' ? 'Grahok' : targetLanguage === 'hi' ? 'प्रिय ग्राहक' : targetLanguage === 'ar' ? 'عزيزي العميل' : cleanFallback;
        } else if (cleanFallback.includes('২৪-৪৮ ঘণ্টা')) {
          translatedFallback = targetLanguage === 'en' ? 'within 24-48 hours' : targetLanguage === 'hi' ? '24-48 घंटे में' : cleanFallback;
        } else if (cleanFallback.includes('ডেলিভারি')) {
          translatedFallback = targetLanguage === 'en' ? 'Out for delivery' : cleanFallback;
        }
      }

      return `{{${varPath} | ${translatedFallback}}}`;
    });

    return result;
  }

  /**
   * Check if a template has an authentic translation for a target language
   */
  hasExactTranslation(templateId: string, language: string): boolean {
    if (!language || language === 'bn') return true;
    const aMap = this.answerTranslations.get(templateId);
    if (!aMap) return false;
    const target = aMap.get(language);
    return Boolean(target && target.template && target.template.trim().length > 0);
  }

  /**
   * Get direct answer translation
   */
  getAnswerTranslation(templateId: string, language: string): string | null {
    if (!language || language === 'bn') return null;
    const aMap = this.answerTranslations.get(templateId);
    if (!aMap) return null;
    const target = aMap.get(language);
    return target?.template || null;
  }

  /**
   * Multi-language Resolution Logic:
   * Level 1: Exact translation for target language
   * Level 2: Template already in target language
   * If not found: isExact = false, so agent can call AI API to respond in user's language and learn for future!
   */
  resolveLocalizedAnswer(
    templateId: string,
    defaultTemplate: string,
    preferredLanguage: string
  ): { template: string; languageUsed: string; isExact: boolean } {
    if (!preferredLanguage || preferredLanguage === 'bn') {
      return { template: defaultTemplate, languageUsed: 'bn', isExact: true };
    }

    const aMap = this.answerTranslations.get(templateId);
    if (aMap) {
      const target = aMap.get(preferredLanguage);
      if (target && target.template && target.template.trim().length > 0) {
        target.usage_count += 1;
        return { template: target.template, languageUsed: preferredLanguage, isExact: true };
      }
    }

    // Check if the defaultTemplate itself is already in the requested language
    const detectedTemplateLang = this.detectLanguage(defaultTemplate);
    if (detectedTemplateLang === preferredLanguage) {
      return { template: defaultTemplate, languageUsed: preferredLanguage, isExact: true };
    }

    // Try autoTranslate only if it actually translated something (not just returning Bengali text)
    const autoTranslated = this.autoTranslateTemplate(defaultTemplate, preferredLanguage);
    const translatedLang = this.detectLanguage(autoTranslated);
    if (translatedLang === preferredLanguage && autoTranslated !== defaultTemplate) {
      return { template: autoTranslated, languageUsed: preferredLanguage, isExact: true };
    }

    // No exact translation in knowledge base for preferredLanguage
    return { template: defaultTemplate, languageUsed: 'bn', isExact: false };
  }

  /**
   * Get all translation phrases for a pattern across all languages
   */
  getPatternPhrasesWithLang(patternId: string): Array<{ phrase: string; lang: string }> {
    const results: Array<{ phrase: string; lang: string }> = [];
    const pMap = this.patternTranslations.get(patternId);
    if (pMap) {
      for (const [lang, rec] of pMap.entries()) {
        for (const p of rec.example_phrases) {
          results.push({ phrase: p, lang });
        }
      }
    }
    return results;
  }
}

export const multiLangEngine = new MultiLanguageEngine();
