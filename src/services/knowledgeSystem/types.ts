export type IntentCategory = 'question' | 'command' | 'information' | 'chat' | 'feedback' | 'general';
export type PatternSource = 'manual' | 'auto_learned';
export type ToolType = 'server' | 'client' | 'ai';
export type OnErrorAction = 'stop' | 'skip' | 'retry' | 'ask_user';
export type TemplateType = 'success' | 'partial' | 'error' | 'fallback' | 'ask_input';
export type FetchSource = 'user_memory' | 'user_facts' | 'tool' | 'client';
export type RelationshipType = 'follows' | 'triggers' | 'alternative' | 'sub_intent';
export type FeedbackType = 'helpful' | 'not_helpful' | 'wrong' | 'incomplete';
export type UserRole = 'admin' | 'user' | 'guest';
export type UserState = 'new' | 'active' | 'returning' | 'vip';
export type PatternLearningStage = 'learning' | 'matured' | 'verified';

export interface KnowledgePatternRecord {
  id: string;
  project_id: string;
  intent: string;
  pattern_type: string;
  example_phrases: string[];
  embedding?: number[] | null;
  description?: string;
  category: string;
  source: PatternSource;
  confidence_score: number;
  usage_count: number;
  success_count: number;
  failure_count: number;
  is_active: boolean;
  is_verified: boolean;
  learning_stage?: PatternLearningStage;
  target_variants?: number;
  quality_score?: number;
  suggested_chips?: string[];
  // Context-Aware Conditional Response System fields
  reason?: string;
  user_state?: 'new' | 'returning' | 'active' | 'vip' | 'any';
  conversation_stage?: 'opening' | 'middle' | 'closing' | 'follow_up' | 'any';
  time_context?: 'morning' | 'afternoon' | 'evening' | 'night' | 'any';
  parent_required?: boolean;
  profile_required?: Record<string, any>;
  created_at: string;
  updated_at: string;
  last_used_at?: string;
}

export interface PatternToolSequenceRecord {
  id: string;
  pattern_id: string;
  step_number: number;
  tool_name: string;
  tool_type: ToolType;
  input_mapping: Record<string, any>;
  output_key?: string;
  is_optional: boolean;
  condition?: Record<string, any> | null;
  depends_on_step?: number;
  on_error: OnErrorAction;
  max_retries: number;
  timeout_seconds: number;
  created_at: string;
}

export interface PatternAnswerTemplateRecord {
  id: string;
  pattern_id: string;
  template_type: TemplateType;
  variant_name: string; // 'short' | 'detailed'
  template: string;
  conditions?: Record<string, any> | null;
  priority: number;
  usage_count: number;
  is_active: boolean;
  created_at: string;
}

export interface PatternMissingInputRecord {
  id: string;
  pattern_id: string;
  field_name: string;
  field_type: 'text' | 'number' | 'date' | 'select';
  question_template: string;
  validation_regex?: string;
  fetch_from: FetchSource;
  fetch_tool?: string;
  fuzzy_match_enabled: boolean;
  fuzzy_match_source?: string;
  fuzzy_threshold: number;
  ask_priority: number;
  created_at: string;
}

export interface PatternRelationshipRecord {
  id: string;
  parent_pattern_id: string;
  child_pattern_id: string;
  relationship_type: RelationshipType;
  conditions?: Record<string, any> | null;
  weight: number;
  created_at: string;
}

export interface UserConversationRecord {
  id: string;
  project_id: string;
  user_id: string;
  session_id: string;
  started_at: string;
  last_message_at: string;
  message_count: number;
  user_state: UserState;
  device_type: string;
  language: string;
  is_active: boolean;
  closed_at?: string;
  expires_at: string; // Strict 24 hours
  cleanup_at?: string;
}

export interface UserMessageRecord {
  id: string;
  conversation_id: string;
  project_id: string;
  user_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  detected_pattern_id?: string;
  detected_intent?: string;
  confidence_score?: number;
  executed_steps?: any[];
  final_answer?: string;
  was_ai_called: boolean;
  execution_time_ms: number;
  tokens_used: number;
  status: string;
  parent_message_id?: string;
  created_at: string;
  expires_at: string; // Strict 24 hours
  cleanup_at?: string;
}

export interface PatternLearningLogRecord {
  id: string;
  pattern_id: string;
  learned_from_message_id?: string;
  learned_from_user_id?: string;
  learned_from_conversation_id?: string;
  learning_method: string;
  ai_provider?: string;
  ai_model?: string;
  previous_version?: any;
  new_version?: any;
  verified_by_admin: boolean;
  admin_notes?: string;
  created_at: string;
}

export interface PatternFeedbackRecord {
  id: string;
  pattern_id: string;
  message_id?: string;
  user_id: string;
  feedback_type: FeedbackType;
  comment?: string;
  action_taken: string;
  created_at: string;
}

export interface IntentTypeRecord {
  id: string;
  code: string;
  name: string;
  description?: string;
  default_action: string;
  requires_tools: boolean;
  requires_ai: boolean;
  priority: number;
  created_at: string;
}

// User Profile System (Permanent)
export interface UserProfileRecord {
  id: string;
  project_id: string;
  user_id: string;
  display_name?: string;
  preferred_language: string;
  timezone: string;
  user_role: UserRole;
  user_state: UserState;
  first_seen_at: string;
  last_seen_at: string;
  total_conversations: number;
  total_messages: number;
  is_active: boolean;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface UserPreferenceRecord {
  id: string;
  user_profile_id: string;
  project_id: string;
  preference_key: string;
  preference_value: Record<string, any>;
  confidence: number;
  source: 'explicit' | 'inferred';
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserFactRecord {
  id: string;
  user_profile_id: string;
  project_id: string;
  fact_key: string;
  fact_value: Record<string, any>;
  fact_category: 'personal' | 'professional' | 'preference' | string;
  confidence: number;
  source_message_id?: string;
  is_verified: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserBehaviorPatternRecord {
  id: string;
  user_profile_id: string;
  project_id: string;
  pattern_type: string;
  pattern_data: Record<string, any>;
  confidence: number;
  observation_count: number;
  last_observed_at: string;
  created_at: string;
  updated_at: string;
}

// Multi-Language Support
export interface PatternTranslationRecord {
  id: string;
  pattern_id: string;
  language: string;
  example_phrases: string[];
  embedding?: number[] | null;
  description?: string;
  is_default: boolean;
  confidence_score: number;
  usage_count: number;
  created_at: string;
  updated_at: string;
}

export interface AnswerTranslationRecord {
  id: string;
  template_id: string;
  language: string;
  template: string;
  variables_mapping: Record<string, string>;
  confidence_score: number;
  is_default: boolean;
  usage_count: number;
  created_at: string;
  updated_at: string;
}

export interface LanguageRecord {
  id: string;
  code: string;
  name: string;
  native_name: string;
  direction: 'ltr' | 'rtl';
  is_active: boolean;
  created_at: string;
}

export type ConfidenceDecision = 'DIRECT_EXECUTION' | 'ASK_CONFIRMATION' | 'AI_EXECUTION';

export interface PatternMatchResult {
  pattern: KnowledgePatternRecord;
  confidence: number;
  decision: ConfidenceDecision;
  matchedPhrase?: string;
  matchedLanguage: string;
  extractedVariables: Record<string, any>;
  missingInputs: PatternMissingInputRecord[];
  toolSequences: PatternToolSequenceRecord[];
  selectedTemplate?: PatternAnswerTemplateRecord;
  localizedTemplate?: string;
  suggestedChips?: string[];
}
