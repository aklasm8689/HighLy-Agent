import crypto from 'crypto';
import { getPgPool, ensureProjectInDb } from '../../db';
import { store } from '../../state';
import {
  UserProfileRecord,
  UserPreferenceRecord,
  UserFactRecord,
  UserBehaviorPatternRecord,
} from './types';

export class UserProfileEngine {
  // In-memory cache for ultra-fast access
  private profiles = new Map<string, UserProfileRecord>(); // key: `${projectId}:${userId}`
  private preferences = new Map<string, Map<string, UserPreferenceRecord>>(); // profileId -> (key -> record)
  private facts = new Map<string, Map<string, UserFactRecord>>(); // profileId -> (key -> record)
  private behaviors = new Map<string, Map<string, UserBehaviorPatternRecord>>(); // profileId -> (type -> record)

  private userKey(projectId: string, userId: string): string {
    return `${projectId}:${userId}`;
  }

  purgeProjectData(projectId: string) {
    const prefix = `${projectId}:`;
    for (const key of this.profiles.keys()) {
      if (key.startsWith(prefix)) {
        const profile = this.profiles.get(key);
        if (profile) {
          this.preferences.delete(profile.id);
          this.facts.delete(profile.id);
          this.behaviors.delete(profile.id);
        }
        this.profiles.delete(key);
      }
    }
  }

  /**
   * Get or create permanent user profile
   */
  async getOrCreateProfile(
    projectId: string,
    userId: string,
    initialData: Partial<UserProfileRecord> = {}
  ): Promise<UserProfileRecord> {
    const key = this.userKey(projectId, userId);
    let profile = this.profiles.get(key);

    if (profile) {
      profile.last_seen_at = new Date().toISOString();
      profile.total_messages += 1;
      profile.user_state = profile.total_conversations > 1 ? 'returning' : 'active';
      return profile;
    }

    const pool = getPgPool();
    const now = new Date().toISOString();

    if (pool) {
      try {
        await ensureProjectInDb(projectId);
        const res = await pool.query(
          `SELECT * FROM user_profiles WHERE project_id = $1 AND user_id = $2 LIMIT 1`,
          [projectId, userId]
        );
        if (res.rows.length > 0) {
          const row = res.rows[0];
          profile = {
            id: row.id,
            project_id: row.project_id,
            user_id: row.user_id,
            display_name: row.display_name,
            preferred_language: row.preferred_language || 'bn',
            timezone: row.timezone || 'Asia/Dhaka',
            user_role: row.user_role || 'user',
            user_state: row.user_state || 'returning',
            first_seen_at: row.first_seen_at ? new Date(row.first_seen_at).toISOString() : now,
            last_seen_at: now,
            total_conversations: row.total_conversations || 0,
            total_messages: (row.total_messages || 0) + 1,
            is_active: row.is_active !== false,
            metadata: row.metadata || {},
            created_at: row.created_at ? new Date(row.created_at).toISOString() : now,
            updated_at: now,
          };
          this.profiles.set(key, profile);
          // Async update in DB
          pool.query(
            `UPDATE user_profiles SET last_seen_at = NOW(), total_messages = total_messages + 1 WHERE id = $1`,
            [profile.id]
          ).catch(() => {});
          return profile;
        }
      } catch (err: any) {
        console.warn('[UserProfileEngine] DB read error:', err.message);
      }
    }

    // Create new permanent profile
    const newId = crypto.randomUUID();
    profile = {
      id: newId,
      project_id: projectId,
      user_id: userId,
      display_name: initialData.display_name || (userId.includes('@') ? userId.split('@')[0] : userId),
      preferred_language: initialData.preferred_language || 'bn',
      timezone: initialData.timezone || 'Asia/Dhaka',
      user_role: initialData.user_role || 'user',
      user_state: 'new',
      first_seen_at: now,
      last_seen_at: now,
      total_conversations: 1,
      total_messages: 1,
      is_active: true,
      metadata: initialData.metadata || {},
      created_at: now,
      updated_at: now,
    };

    this.profiles.set(key, profile);

    if (pool) {
      try {
        await ensureProjectInDb(projectId);
        await pool.query(
          `INSERT INTO user_profiles (id, project_id, user_id, display_name, preferred_language, timezone, user_role, user_state, first_seen_at, last_seen_at, total_conversations, total_messages, is_active, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT (project_id, user_id) DO UPDATE SET last_seen_at = NOW(), total_messages = user_profiles.total_messages + 1`,
          [
            profile.id,
            profile.project_id,
            profile.user_id,
            profile.display_name,
            profile.preferred_language,
            profile.timezone,
            profile.user_role,
            profile.user_state,
            profile.first_seen_at,
            profile.last_seen_at,
            profile.total_conversations,
            profile.total_messages,
            profile.is_active,
            JSON.stringify(profile.metadata),
          ]
        );
      } catch (e: any) {
        console.warn('[UserProfileEngine] DB insert error:', e.message);
      }
    }

    return profile;
  }

  /**
   * Permanently update user preferred language in memory and PostgreSQL
   */
  async setPreferredLanguage(projectId: string, userId: string, language: string): Promise<void> {
    const profile = await this.getOrCreateProfile(projectId, userId);
    profile.preferred_language = language;
    profile.updated_at = new Date().toISOString();

    const pool = getPgPool();
    if (pool) {
      try {
        await pool.query(
          `UPDATE user_profiles SET preferred_language = $1, updated_at = NOW() WHERE project_id = $2 AND user_id = $3`,
          [language, projectId, userId]
        );
      } catch (err: any) {
        console.warn('[UserProfileEngine] setPreferredLanguage DB error:', err.message);
      }
    }
  }

  /**
   * Set or update a permanent user fact
   */
  async setFact(
    profileId: string,
    projectId: string,
    factKey: string,
    factValue: any,
    category = 'personal',
    confidence = 1.0,
    sourceMessageId?: string
  ): Promise<UserFactRecord> {
    const now = new Date().toISOString();
    let userFactsMap = this.facts.get(profileId);
    if (!userFactsMap) {
      userFactsMap = new Map();
      this.facts.set(profileId, userFactsMap);
    }

    const existing = userFactsMap.get(factKey);
    const factRecord: UserFactRecord = {
      id: existing?.id || crypto.randomUUID(),
      user_profile_id: profileId,
      project_id: projectId,
      fact_key: factKey,
      fact_value: typeof factValue === 'object' ? factValue : { value: factValue },
      fact_category: category,
      confidence,
      source_message_id: sourceMessageId,
      is_verified: true,
      is_active: true,
      created_at: existing?.created_at || now,
      updated_at: now,
    };

    userFactsMap.set(factKey, factRecord);

    const pool = getPgPool();
    if (pool) {
      (async () => {
        try {
          await ensureProjectInDb(projectId);
          const check = await pool.query(`SELECT id FROM user_profiles WHERE id = $1 LIMIT 1`, [factRecord.user_profile_id]);
          if (check.rows.length === 0) {
            await pool.query(
              `INSERT INTO user_profiles (id, project_id, user_id, display_name, preferred_language, timezone, user_role, user_state, first_seen_at, last_seen_at, total_conversations, total_messages, is_active, metadata)
               VALUES ($1, $2, $3, $4, 'bn', 'Asia/Dhaka', 'user', 'active', NOW(), NOW(), 1, 1, TRUE, '{}'::jsonb)
               ON CONFLICT (project_id, user_id) DO NOTHING`,
              [factRecord.user_profile_id, projectId, factRecord.user_profile_id, factRecord.user_profile_id]
            );
          }
          await pool.query(
            `INSERT INTO user_facts (id, user_profile_id, project_id, fact_key, fact_value, fact_category, confidence, source_message_id, is_verified, is_active, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (id) DO UPDATE SET fact_value = $5, confidence = $7, updated_at = NOW()`,
            [
              factRecord.id,
              factRecord.user_profile_id,
              factRecord.project_id,
              factRecord.fact_key,
              JSON.stringify(factRecord.fact_value),
              factRecord.fact_category,
              factRecord.confidence,
              factRecord.source_message_id || null,
              factRecord.is_verified,
              factRecord.is_active,
              factRecord.created_at,
              factRecord.updated_at,
            ]
          );
        } catch (e: any) {
          console.warn('[UserProfileEngine] Fact DB error:', e.message);
        }
      })();
    }

    return factRecord;
  }

  /**
   * Set or update a user preference (e.g. answer_style, formality, short_answers)
   */
  async setPreference(
    profileId: string,
    projectId: string,
    key: string,
    value: any,
    confidence = 1.0,
    source: 'explicit' | 'inferred' = 'explicit'
  ): Promise<UserPreferenceRecord> {
    const now = new Date().toISOString();
    let prefsMap = this.preferences.get(profileId);
    if (!prefsMap) {
      prefsMap = new Map();
      this.preferences.set(profileId, prefsMap);
    }

    const existing = prefsMap.get(key);
    const prefRecord: UserPreferenceRecord = {
      id: existing?.id || crypto.randomUUID(),
      user_profile_id: profileId,
      project_id: projectId,
      preference_key: key,
      preference_value: typeof value === 'object' ? value : { value },
      confidence,
      source,
      is_active: true,
      created_at: existing?.created_at || now,
      updated_at: now,
    };

    prefsMap.set(key, prefRecord);

    const pool = getPgPool();
    if (pool) {
      (async () => {
        try {
          await ensureProjectInDb(projectId);
          const check = await pool.query(`SELECT id FROM user_profiles WHERE id = $1 LIMIT 1`, [prefRecord.user_profile_id]);
          if (check.rows.length === 0) {
            await pool.query(
              `INSERT INTO user_profiles (id, project_id, user_id, display_name, preferred_language, timezone, user_role, user_state, first_seen_at, last_seen_at, total_conversations, total_messages, is_active, metadata)
               VALUES ($1, $2, $3, $4, 'bn', 'Asia/Dhaka', 'user', 'active', NOW(), NOW(), 1, 1, TRUE, '{}'::jsonb)
               ON CONFLICT (project_id, user_id) DO NOTHING`,
              [prefRecord.user_profile_id, projectId, prefRecord.user_profile_id, prefRecord.user_profile_id]
            );
          }
          await pool.query(
            `INSERT INTO user_preferences (id, user_profile_id, project_id, preference_key, preference_value, confidence, source, is_active, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (user_profile_id, preference_key) DO UPDATE SET preference_value = $5, confidence = $6, updated_at = NOW()`,
            [
              prefRecord.id,
              prefRecord.user_profile_id,
              prefRecord.project_id,
              prefRecord.preference_key,
              JSON.stringify(prefRecord.preference_value),
              prefRecord.confidence,
              prefRecord.source,
              prefRecord.is_active,
              prefRecord.created_at,
              prefRecord.updated_at,
            ]
          );
        } catch (e: any) {
          console.warn('[UserProfileEngine] Preference DB error:', e.message);
        }
      })();
    }

    return prefRecord;
  }

  /**
   * Extract all known variables (profile, facts, preferences) into a flat map for template interpolation
   */
  async getUserVariables(projectId: string, userId: string): Promise<Record<string, any>> {
    const profile = await this.getOrCreateProfile(projectId, userId);

    const isSystemId = (name: string | undefined): boolean => {
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

    const finalDisplayName = isSystemId(profile.display_name) ? '' : profile.display_name;

    const vars: Record<string, any> = {
      user_id: profile.user_id,
      user_name: finalDisplayName,
      user_role: profile.user_role,
      user_state: profile.user_state,
      language: profile.preferred_language,
      timezone: profile.timezone,
    };

    // Add facts
    const factsMap = this.facts.get(profile.id);
    if (factsMap) {
      for (const [k, f] of factsMap.entries()) {
        vars[k] = f.fact_value?.value !== undefined ? f.fact_value.value : f.fact_value;
      }
    }

    // Add preferences
    const prefsMap = this.preferences.get(profile.id);
    if (prefsMap) {
      for (const [k, p] of prefsMap.entries()) {
        vars[`pref_${k}`] = p.preference_value?.value !== undefined ? p.preference_value.value : p.preference_value;
      }
    }

    return vars;
  }

  /**
   * Scan user message and extract implicit/explicit facts and preferences
   */
  async extractAndStoreUserData(
    projectId: string,
    userId: string,
    text: string,
    messageId?: string
  ): Promise<void> {
    const profile = await this.getOrCreateProfile(projectId, userId);
    const lower = text.toLowerCase();

    // 1. Name detection
    // e.g. "amar nam Rahim", "my name is Alex", "ami Hasan"
    const nameMatch =
      text.match(/(?:amar\s+nam|my\s+name\s+is|amar\s+naam|ami|i\s+am)\s+([A-Za-z\u0980-\u09FF]+)/i);
    if (nameMatch && nameMatch[1] && !['ki', 'kemon', 'valo', 'not', 'here'].includes(nameMatch[1].toLowerCase())) {
      const extractedName = nameMatch[1].trim();
      profile.display_name = extractedName;
      await this.setFact(profile.id, projectId, 'name', extractedName, 'personal', 0.95, messageId);

      // Keep central store in sync
      const userKey = `${projectId}:${userId}`;
      const userObj = store.users.get(userKey);
      if (userObj) {
        userObj.name = extractedName;
        store.persist();
      }
    }

    // 2. City / Location detection
    // e.g. "amar shohor Dhaka", "ami Chittagong thaki", "i live in London"
    const cityMatch = text.match(/(?:shohor|live\s+in|thaki|bari)\s+([A-Za-z\u0980-\u09FF]+)/i);
    if (cityMatch && cityMatch[1]) {
      await this.setFact(profile.id, projectId, 'city', cityMatch[1].trim(), 'personal', 0.9, messageId);
    }

    // 3. Email detection
    const emailMatch = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    if (emailMatch) {
      await this.setFact(profile.id, projectId, 'email', emailMatch[1].trim(), 'personal', 1.0, messageId);
    }

    // 4. Phone detection
    const phoneMatch = text.match(/(?:\+?88)?01[3-9]\d{8}/);
    if (phoneMatch) {
      await this.setFact(profile.id, projectId, 'phone', phoneMatch[0], 'personal', 1.0, messageId);
    }

    // 5. Tone / preference detection
    if (lower.includes('short answer') || lower.includes('choto kore') || lower.includes('briefly')) {
      await this.setPreference(profile.id, projectId, 'answer_style', 'short', 0.95, 'explicit');
    } else if (lower.includes('detail') || lower.includes('bistarito')) {
      await this.setPreference(profile.id, projectId, 'answer_style', 'detailed', 0.95, 'explicit');
    }

    // 6. Voice Character / Gender preference detection
    if (
      lower.includes('মেয়ের গলায়') ||
      lower.includes('মেয়ের কণ্ঠে') ||
      lower.includes('মেয়ের কন্ঠে') ||
      lower.includes('মেয়ে গলায়') ||
      lower.includes('মেয়ে কন্ঠ') ||
      lower.includes('মেয়ে ভয়েস') ||
      lower.includes('মেয়ের ভয়েস') ||
      lower.includes('মেয়ের ভয়েস') ||
      lower.includes('মেয়ে ভয়েস') ||
      lower.includes('female voice') ||
      lower.includes('female speaker') ||
      lower.includes('girl voice')
    ) {
      await this.setUserTtsPreferences(projectId, userId, { voice: 'bn-BD-NabanitaNeural' });
    } else if (
      lower.includes('ছেলের গলায়') ||
      lower.includes('ছেলের কণ্ঠে') ||
      lower.includes('ছেলের কন্ঠে') ||
      lower.includes('ছেলে গলায়') ||
      lower.includes('ছেলে কন্ঠ') ||
      lower.includes('ছেলে ভয়েস') ||
      lower.includes('ছেলের ভয়েস') ||
      lower.includes('ছেলের ভয়েস') ||
      lower.includes('ছেলে ভয়েস') ||
      lower.includes('male voice') ||
      lower.includes('male speaker') ||
      lower.includes('boy voice')
    ) {
      await this.setUserTtsPreferences(projectId, userId, { voice: 'bn-BD-PradeepNeural' });
    }

    // 7. Voice Speed / Regulation preference detection
    const speedNumMatch = text.match(/(?:speed|স্পিড|গতি)\s*(?:হবে|করো|রাখো|set\s+to|is)?\s*([0-2](?:\.\d+)?)/i);
    if (speedNumMatch && speedNumMatch[1]) {
      const parsedSpeed = parseFloat(speedNumMatch[1]);
      if (!isNaN(parsedSpeed) && parsedSpeed >= 0.5 && parsedSpeed <= 2.0) {
        await this.setUserTtsPreferences(projectId, userId, { speed: parsedSpeed });
      }
    } else if (
      lower.includes('তাড়াতাড়ি বলো') ||
      lower.includes('দ্রুত বলো') ||
      lower.includes('স্পিড বাড়াও') ||
      lower.includes('কথা স্পিডে বলো') ||
      lower.includes('speak faster') ||
      lower.includes('fast voice')
    ) {
      await this.setUserTtsPreferences(projectId, userId, { speed: 1.35 });
    } else if (
      lower.includes('আস্তে বলো') ||
      lower.includes('ধীরে বলো') ||
      lower.includes('স্পিড কমাও') ||
      lower.includes('কথা আস্তে বলো') ||
      lower.includes('speak slower') ||
      lower.includes('slow voice')
    ) {
      await this.setUserTtsPreferences(projectId, userId, { speed: 0.8 });
    } else if (lower.includes('স্বাভাবিক স্পিড') || lower.includes('normal speed') || lower.includes('স্পিড নরমাল')) {
      await this.setUserTtsPreferences(projectId, userId, { speed: 1.0 });
    }

    // 8. Voice Pitch regulation detection
    if (lower.includes('পিচ বাড়াও') || lower.includes('high pitch') || lower.includes('চিকন গলা')) {
      await this.setUserTtsPreferences(projectId, userId, { pitch: 15 });
    } else if (lower.includes('পিচ কমাও') || lower.includes('low pitch') || lower.includes('ভারী গলা')) {
      await this.setUserTtsPreferences(projectId, userId, { pitch: -15 });
    } else if (lower.includes('normal pitch') || lower.includes('পিচ নরমাল')) {
      await this.setUserTtsPreferences(projectId, userId, { pitch: 0 });
    }

    // 9. Output & Input Language preference detection
    if (
      lower.includes('বাংলায় বলো') ||
      lower.includes('কথা বাংলায় বলো') ||
      lower.includes('বাংলা ভয়েস') ||
      lower.includes('speak in bangla') ||
      lower.includes('bangla language')
    ) {
      await this.setUserTtsPreferences(projectId, userId, { language: 'bn' });
      await this.setPreferredLanguage(projectId, userId, 'bn');
    } else if (
      lower.includes('ইংলিশে বলো') ||
      lower.includes('ইংরেজিতে বলো') ||
      lower.includes('ইংরেজি ভয়েস') ||
      lower.includes('speak in english') ||
      lower.includes('english language')
    ) {
      await this.setUserTtsPreferences(projectId, userId, { language: 'en' });
      await this.setPreferredLanguage(projectId, userId, 'en');
    }
  }

  /**
   * Get User specific Voice, Speech, Pitch, and Language Preferences
   * Hierarchy & Authority:
   * 1. Engine is strictly controlled at Project level (Admin/Management authority).
   * 2. Voice Character, Language, Speed, Pitch, Auto-Speak can be customized per User.
   * 3. Fallbacks respect Project defaults then System defaults.
   */
  async getUserTtsPreferences(projectId: string, userId: string): Promise<{
    user_id: string;
    project_id: string;
    language: string;
    engine: 'edge' | 'gemini';
    voice: string;
    speed: number;
    pitch: number;
    auto_speak: boolean;
  }> {
    const profile = await this.getOrCreateProfile(projectId, userId);
    const prefsMap = this.preferences.get(profile.id) || new Map();

    // Check client / project configuration for defaults
    const client = store.clients.get(projectId);
    // Project defines the system/engine (Gemini vs Edge) to control infrastructure & costs
    const projectEngine: 'edge' | 'gemini' = client?.tts_engine || 'edge';
    const projectDefaultVoice = client?.tts_voice || (projectEngine === 'gemini' ? 'Puck' : 'bn-BD-PradeepNeural');

    const langPref = prefsMap.get('tts_language')?.preference_value?.value || profile.preferred_language || 'bn';
    
    // Engine is project authoritative
    const enginePref = projectEngine;
    
    // Voice selection: If user explicitly picked a voice within the allowed engine, use it. Otherwise use project default voice.
    let voicePref = prefsMap.get('tts_voice')?.preference_value?.value || projectDefaultVoice;

    // Safety fallback for engine/voice compatibility
    if (enginePref === 'gemini' && voicePref.includes('Neural')) {
      voicePref = 'Puck';
    } else if (enginePref === 'edge' && !voicePref.includes('Neural')) {
      voicePref = langPref === 'en' ? 'en-US-GuyNeural' : 'bn-BD-PradeepNeural';
    }

    const speedPref = typeof prefsMap.get('tts_speed')?.preference_value?.value === 'number'
      ? prefsMap.get('tts_speed')!.preference_value.value
      : 1.0;
    const pitchPref = typeof prefsMap.get('tts_pitch')?.preference_value?.value === 'number'
      ? prefsMap.get('tts_pitch')!.preference_value.value
      : 0;
    const autoSpeakPref = Boolean(prefsMap.get('tts_auto_speak')?.preference_value?.value);

    return {
      user_id: userId,
      project_id: projectId,
      language: langPref,
      engine: enginePref,
      voice: voicePref,
      speed: speedPref,
      pitch: pitchPref,
      auto_speak: autoSpeakPref,
    };
  }

  /**
   * Set User specific Voice, Speech, Pitch, and Language Preferences
   */
  async setUserTtsPreferences(
    projectId: string,
    userId: string,
    updates: {
      language?: string;
      engine?: 'edge' | 'gemini';
      voice?: string;
      speed?: number;
      pitch?: number;
      auto_speak?: boolean;
    }
  ) {
    const profile = await this.getOrCreateProfile(projectId, userId);

    if (updates.language !== undefined) {
      await this.setPreference(profile.id, projectId, 'tts_language', updates.language, 1.0, 'explicit');
      profile.preferred_language = updates.language;
    }
    if (updates.engine !== undefined) {
      await this.setPreference(profile.id, projectId, 'tts_engine', updates.engine, 1.0, 'explicit');
    }
    if (updates.voice !== undefined) {
      await this.setPreference(profile.id, projectId, 'tts_voice', updates.voice, 1.0, 'explicit');
    }
    if (typeof updates.speed === 'number') {
      const clampedSpeed = Math.max(0.5, Math.min(2.0, updates.speed));
      await this.setPreference(profile.id, projectId, 'tts_speed', clampedSpeed, 1.0, 'explicit');
    }
    if (typeof updates.pitch === 'number') {
      const clampedPitch = Math.max(-50, Math.min(50, updates.pitch));
      await this.setPreference(profile.id, projectId, 'tts_pitch', clampedPitch, 1.0, 'explicit');
    }
    if (typeof updates.auto_speak === 'boolean') {
      await this.setPreference(profile.id, projectId, 'tts_auto_speak', updates.auto_speak, 1.0, 'explicit');
    }

    return this.getUserTtsPreferences(projectId, userId);
  }
}

export const userProfileEngine = new UserProfileEngine();
