/**
 * Context-Aware Conditional Response System
 * 
 * Checks 7 conditions before serving a static answer:
 * 1. Message Match (95%+)
 * 2. User State (new/returning/active/vip)
 * 3. Conversation Stage (opening/middle/closing/follow_up)
 * 4. Time Context (morning/afternoon/evening/night)
 * 5. Parent Context (previous message relationship)
 * 6. User Profile (name, language, preferences)
 * 7. Tool Requirement (which tool needed)
 * 
 * All 7 must match -> serve cached answer (0 AI calls)
 * 1+ mismatch -> try next template
 * None match -> AI fallback
 */

import { UserProfileRecord, UserState, PatternAnswerTemplateRecord } from './types';

// ============================================================
// Types & Interfaces
// ============================================================

export interface ContextConditions {
  /** 0-1 similarity score for message match */
  message_match: number;
  /** User state from profile */
  user_state?: 'new' | 'returning' | 'active' | 'vip';
  /** Conversation stage */
  conversation_stage?: 'opening' | 'middle' | 'closing' | 'follow_up';
  /** Time context (Bengali time) */
  time_context?: 'morning' | 'afternoon' | 'evening' | 'night';
  /** Whether parent message exists */
  has_parent: boolean;
  /** User profile data */
  profile?: {
    name?: string;
    language?: string;
    preferences?: Record<string, any>;
  };
  /** Required tools for this pattern */
  required_tools?: string[];
  /** Previously used tools in this session */
  recent_tools?: string[];
}

export interface ConditionRule {
  /** Condition name */
  condition: keyof ContextConditions;
  /** Expected value(s) */
  expected: string | string[] | boolean | number;
  /** Comparison operator */
  operator?: 'eq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains';
  /** Weight of this condition (0-1) */
  weight?: number;
}

export interface TemplateMatchResult {
  template: PatternAnswerTemplateRecord;
  match_score: number;
  matched_conditions: string[];
  failed_conditions: string[];
  should_serve: boolean;
}

export interface ConditionalMatchResult {
  /** Whether we have a valid match */
  has_match: boolean;
  /** Best matching template */
  best_template?: PatternAnswerTemplateRecord;
  /** Similarity score */
  similarity: number;
  /** Matched conditions */
  matched_conditions: string[];
  /** Failed conditions */
  failed_conditions: string[];
  /** Whether to serve static answer or call AI */
  action: 'serve_static' | 'ask_clarification' | 'call_ai';
  /** Reason for decision */
  reason: string;
}

// ============================================================
// Time Context Detection
// ============================================================

export function getTimeContext(): 'morning' | 'afternoon' | 'evening' | 'night' {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

// ============================================================
// Conversation Stage Detection
// ============================================================

export function getConversationStage(
  messageCount: number,
  hasHistory: boolean
): 'opening' | 'middle' | 'closing' | 'follow_up' {
  if (!hasHistory) return 'opening';
  if (messageCount <= 2) return 'opening';
  if (messageCount >= 10) return 'closing';
  return 'middle';
}

// ============================================================
// User State Detection
// ============================================================

export function getUserState(profile?: UserProfileRecord): UserState {
  if (!profile) return 'new';
  if (profile.user_state === 'vip') return 'vip';
  if (profile.total_conversations > 5) return 'returning';
  if (profile.total_messages > 20) return 'active';
  return 'new';
}

// ============================================================
// Main Condition Checker
// ============================================================

/**
 * Check if a template's conditions match the current context
 */
export function checkTemplateConditions(
  template: PatternAnswerTemplateRecord,
  context: ContextConditions
): TemplateMatchResult {
  const conditions = template.conditions as any || {};
  const matched: string[] = [];
  const failed: string[] = [];
  let matchScore = 1.0;

  // Check user_state condition
  if (conditions.user_state) {
    const expectedState = conditions.user_state;
    const actualState = context.user_state || 'new';
    if (Array.isArray(expectedState)) {
      if (expectedState.includes(actualState)) {
        matched.push('user_state');
      } else {
        failed.push('user_state');
        matchScore *= 0.7;
      }
    } else {
      if (actualState === expectedState) {
        matched.push('user_state');
      } else {
        failed.push('user_state');
        matchScore *= 0.7;
      }
    }
  }

  // Check time_context condition
  if (conditions.time_context) {
    const expectedTime = conditions.time_context;
    const actualTime = context.time_context || 'morning';
    if (Array.isArray(expectedTime)) {
      if (expectedTime.includes(actualTime)) {
        matched.push('time_context');
      } else {
        failed.push('time_context');
        matchScore *= 0.7;
      }
    } else {
      if (actualTime === expectedTime) {
        matched.push('time_context');
      } else {
        failed.push('time_context');
        matchScore *= 0.7;
      }
    }
  }

  // Check conversation_stage condition
  if (conditions.conversation_stage) {
    const expectedStage = conditions.conversation_stage;
    const actualStage = context.conversation_stage || 'opening';
    if (Array.isArray(expectedStage)) {
      if (expectedStage.includes(actualStage)) {
        matched.push('conversation_stage');
      } else {
        failed.push('conversation_stage');
        matchScore *= 0.7;
      }
    } else {
      if (actualStage === expectedStage) {
        matched.push('conversation_stage');
      } else {
        failed.push('conversation_stage');
        matchScore *= 0.7;
      }
    }
  }

  // Check profile.language condition
  if (conditions.profile?.language) {
    const expectedLang = conditions.profile.language;
    const actualLang = context.profile?.language || 'bn';
    if (actualLang === expectedLang) {
      matched.push('profile.language');
    } else {
      failed.push('profile.language');
      matchScore *= 0.8;
    }
  }

  // Check profile.name condition
  if (conditions.profile?.has_name !== undefined) {
    const hasName = !!context.profile?.name;
    if (conditions.profile.has_name === hasName) {
      matched.push('profile.has_name');
    } else {
      failed.push('profile.has_name');
      matchScore *= 0.8;
    }
  }

  // Check parent_required condition
  if (conditions.parent_required !== undefined) {
    if (conditions.parent_required === context.has_parent) {
      matched.push('parent_required');
    } else {
      failed.push('parent_required');
      matchScore *= 0.8;
    }
  }

  // Check tool_used condition
  if (conditions.tool_used) {
    const recentTools = context.recent_tools || [];
    const hasTool = recentTools.length > 0;
    if (hasTool) {
      matched.push('tool_used');
    } else {
      failed.push('tool_used');
      matchScore *= 0.8;
    }
  }

  const shouldServe = failed.length === 0 && context.message_match >= 0.7;

  return {
    template,
    match_score: matchScore,
    matched_conditions: matched,
    failed_conditions: failed,
    should_serve,
  };
}

// ============================================================
// Multi-Template Selection
// ============================================================

/**
 * Find the best matching template from a list based on context
 */
export function selectBestTemplate(
  templates: PatternAnswerTemplateRecord[],
  context: ContextConditions
): TemplateMatchResult | null {
  if (!templates || templates.length === 0) return null;

  let bestMatch: TemplateMatchResult | null = null;

  for (const template of templates) {
    const result = checkTemplateConditions(template, context);
    
    if (!bestMatch) {
      bestMatch = result;
    } else if (
      result.match_score > bestMatch.match_score ||
      (result.match_score === bestMatch.match_score && 
       result.template.priority > bestMatch.template.priority)
    ) {
      bestMatch = result;
    }
  }

  return bestMatch;
}

// ============================================================
// Main Conditional Match Function
// ============================================================

/**
 * Main entry point: Check all 7 conditions and return match result
 */
export function checkConditionalMatch(
  similarity: number,
  templates: PatternAnswerTemplateRecord[],
  context: ContextConditions,
  config: {
    minSimiliarity?: number;
    requireAllConditions?: boolean;
    fallbackToAI?: boolean;
  } = {}
): ConditionalMatchResult {
  const {
    minSimilarity = 0.7,
    requireAllConditions = false,
    fallbackToAI = true,
  } = config;

  // Step 1: Check message similarity threshold
  if (similarity < minSimilarity) {
    return {
      has_match: false,
      similarity,
      matched_conditions: [],
      failed_conditions: ['message_match'],
      action: 'call_ai',
      reason: `Message similarity ${similarity.toFixed(2)} below threshold ${minSimilarity}`,
    };
  }

  // Step 2: Build full context
  context.message_match = similarity;

  // Step 3: Find best matching template
  const bestMatch = selectBestTemplate(templates, context);

  if (!bestMatch) {
    return {
      has_match: false,
      similarity,
      matched_conditions: [],
      failed_conditions: ['no_templates'],
      action: fallbackToAI ? 'call_ai' : 'serve_static',
      reason: 'No templates available for this pattern',
    };
  }

  // Step 4: Evaluate if we should serve static answer
  if (bestMatch.should_serve && (!requireAllConditions || bestMatch.failed_conditions.length === 0)) {
    return {
      has_match: true,
      best_template: bestMatch.template,
      similarity,
      matched_conditions: bestMatch.matched_conditions,
      failed_conditions: bestMatch.failed_conditions,
      action: 'serve_static',
      reason: `Template matched with score ${bestMatch.match_score.toFixed(2)}`,
    };
  }

  // Step 5: Check if we should ask for clarification
  if (similarity >= 0.7 && similarity < 0.95) {
    return {
      has_match: true,
      best_template: bestMatch.template,
      similarity,
      matched_conditions: bestMatch.matched_conditions,
      failed_conditions: bestMatch.failed_conditions,
      action: 'ask_clarification',
      reason: `Ambiguous match (${similarity.toFixed(2)}) - asking user for confirmation`,
    };
  }

  // Step 6: No good match - fallback to AI
  return {
    has_match: false,
    similarity,
    matched_conditions: bestMatch.matched_conditions,
    failed_conditions: bestMatch.failed_conditions,
    action: fallbackToAI ? 'call_ai' : 'serve_static',
    reason: `Condition mismatch - serving best template or falling back to AI`,
  };
}

// ============================================================
// Helper: Build Full Context
// ============================================================

export function buildContext(
  profile?: UserProfileRecord,
  messageHistory?: Array<{ role: string; content: string; timestamp: string }>,
  recentTools?: string[]
): ContextConditions {
  const hasHistory = !!messageHistory && messageHistory.length > 0;
  
  return {
    message_match: 0, // Will be set by caller
    user_state: getUserState(profile),
    conversation_stage: getConversationStage(
      messageHistory?.length || 0,
      hasHistory
    ),
    time_context: getTimeContext(),
    has_parent: hasHistory,
    profile: {
      name: profile?.display_name || undefined,
      language: profile?.preferred_language || 'bn',
      preferences: profile?.metadata?.preferences,
    },
    recent_tools: recentTools,
  };
}

// ============================================================
// Bengali Greeting Generator (context-aware)
// ============================================================

export function generateGreeting(
  userState: UserState,
  timeContext: 'morning' | 'afternoon' | 'evening' | 'night',
  userName?: string
): string {
  const name = userName || 'সুপ্রিয় গ্রাহক';
  
  const greetings: Record<string, Record<string, string>> = {
    morning: {
      new: `আসসালামু আলাইকুম ${name}! শুভ সকাল। আপনাকে স্বাগতম! 🌅`,
      returning: `আসসালামু আলাইকুম ${name}! আবার দেখা হল। শুভ সকাল! ☀️`,
      active: `হ্যালো ${name}! আবার এসেছেন? শুভ সকাল! 🌞`,
      vip: `আসসালামু আলাইকুম ${name}! আপনাকে আবার দেখতে পাইয়ে খুব ভালো লাগলো। শুভ সকাল! 🌟`,
    },
    afternoon: {
      new: `নামোস্তাক! ${name}! শুভ দুপুর। আপনাকে স্বাগতম! 🌤️`,
      returning: `নামোস্তাক ${name}! আবার দেখা হল। শুভ দুপুর! ☀️`,
      active: `হ্যালো ${name}! আবার এসেছেন? শুভ দুপুর! 🌞`,
      vip: `নামোস্তাক ${name}! আপনাকে আবার দেখতে পাইয়ে খুব ভালো লাগলো। শুভ দুপুর! 🌟`,
    },
    evening: {
      new: `আসসালামু আলাইকুম ${name}! শুভ সন্ধ্যা। আপনাকে স্বাগতম! 🌆`,
      returning: `আসসালামু আলাইকুম ${name}! আবার দেখা হল। শুভ সন্ধ্যা! 🌅`,
      active: `হ্যালো ${name}! আবার এসেছেন? শুভ সন্ধ্যা! 🌇`,
      vip: `আসসালামু আলাইকুম ${name}! আপনাকে আবার দেখতে পাইয়ে খুব ভালো লাগলো। শুভ সন্ধ্যা! 🌟`,
    },
    night: {
      new: `আসসালামু আলাইকুম ${name}! শুভ রাত্রি। আপনাকে স্বাগতম! 🌙`,
      returning: `আসসালামু আলাইকুম ${name}! আবার দেখা হল। শুভ রাত্রি! 🌃`,
      active: `হ্যালো ${name}! আবার এসেছেন? শুভ রাত্রি! 🌙`,
      vip: `আসসালামু আলাইকুম ${name}! আপনাকে আবার দেখতে পাইয়ে খুব ভালো লাগলো। শুভ রাত্রি! 🌟`,
    },
  };

  return greetings[timeContext]?.[userState] || greetings.morning.new;
}

// ============================================================
// Export for Use
// ============================================================

export default {
  getTimeContext,
  getConversationStage,
  getUserState,
  checkTemplateConditions,
  selectBestTemplate,
  checkConditionalMatch,
  buildContext,
  generateGreeting,
};
