import { pgTable, text, timestamp, boolean, integer, jsonb, uuid, varchar, real, unique } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

/**
 * 1. Projects / Clients Table (Root Scope)
 */
export const projects = pgTable('projects', {
  id: varchar('id', { length: 64 }).primaryKey(), // e.g. 'client_crm_01'
  name: varchar('name', { length: 255 }).notNull(),
  platform: varchar('platform', { length: 64 }).default('Web App'),
  webhookUrl: text('webhook_url'),
  systemPrompt: text('system_prompt'),
  aiProvider: varchar('ai_provider', { length: 64 }).default('gemini-2.5-flash'),
  temperature: integer('temperature').default(7), // Scaled x10 (0.7)
  maxTokens: integer('max_tokens').default(2048),
  dailyRequestLimit: integer('daily_request_limit').default(5000),
  monthlyRequestLimit: integer('monthly_request_limit').default(150000),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * 2. API Keys Table
 */
export const apiKeys = pgTable('api_keys', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: varchar('project_id', { length: 64 })
    .references(() => projects.id, { onDelete: 'cascade' })
    .notNull(),
  keyHash: varchar('key_hash', { length: 255 }).notNull().unique(),
  maskedKey: varchar('masked_key', { length: 32 }).notNull(),
  label: varchar('label', { length: 128 }).notNull(),
  revoked: boolean('revoked').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at'),
});

/**
 * 3. End-Users / Legacy User Profiles Scoped to Project
 */
export const projectUsers = pgTable('project_users', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: varchar('project_id', { length: 64 })
    .references(() => projects.id, { onDelete: 'cascade' })
    .notNull(),
  externalUserId: varchar('external_user_id', { length: 128 }).notNull(),
  name: varchar('name', { length: 128 }),
  email: varchar('email', { length: 255 }),
  plan: varchar('plan', { length: 64 }).default('free'),
  blocked: boolean('blocked').default(false).notNull(),
  tokensToday: integer('tokens_today').default(0).notNull(),
  tokensMonth: integer('tokens_month').default(0).notNull(),
  requestsToday: integer('requests_today').default(0).notNull(),
  requestsMonth: integer('requests_month').default(0).notNull(),
  contextVariables: jsonb('context_variables').$type<Record<string, any>>().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  lastActive: timestamp('last_active').defaultNow().notNull(),
});

/**
 * 4. User Long-Term Memory (Scoped by Project + User)
 */
export const userMemories = pgTable('user_memories', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: varchar('project_id', { length: 64 })
    .references(() => projects.id, { onDelete: 'cascade' })
    .notNull(),
  userId: varchar('user_id', { length: 128 }).notNull(),
  key: varchar('key', { length: 128 }).notNull(),
  value: text('value').notNull(),
  category: varchar('category', { length: 64 }).default('general'),
  source: varchar('source', { length: 64 }).default('conversation'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * Legacy Knowledge Base Entries
 */
export const knowledgeEntries = pgTable('knowledge_entries', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: varchar('project_id', { length: 64 })
    .references(() => projects.id, { onDelete: 'cascade' })
    .notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  content: text('content').notNull(),
  category: varchar('category', { length: 64 }).default('general'),
  tags: jsonb('tags').$type<string[]>().default([]),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * Legacy Learned Skills
 */
export const learnedSkills = pgTable('learned_skills', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: varchar('project_id', { length: 64 })
    .references(() => projects.id, { onDelete: 'cascade' })
    .notNull(),
  triggerPhrase: varchar('trigger_phrase', { length: 255 }).notNull(),
  solutionTemplate: text('solution_template').notNull(),
  toolAction: varchar('tool_action', { length: 128 }),
  confidence: integer('confidence').default(95),
  timesUsed: integer('times_used').default(0).notNull(),
  tokensSaved: integer('tokens_saved').default(0).notNull(),
  costSavedUsd: integer('cost_saved_usd').default(0).notNull(),
  status: varchar('status', { length: 32 }).default('active').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * Legacy Conversations
 */
export const conversations = pgTable('conversations', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: varchar('project_id', { length: 64 })
    .references(() => projects.id, { onDelete: 'cascade' })
    .notNull(),
  userId: varchar('user_id', { length: 128 }).notNull(),
  title: varchar('title', { length: 255 }).default('New Conversation'),
  callMode: varchar('call_mode', { length: 32 }).default('ws'),
  totalTokens: integer('total_tokens').default(0),
  messages: jsonb('messages').$type<Array<{
    id: string;
    role: 'user' | 'agent' | 'system' | 'tool';
    content: string;
    timestamp: string;
    callMode?: 'post' | 'ws';
    rawResult?: any;
    debugMetadata?: any;
  }>>().default([]),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * Telemetry & Analytics Logs
 */
export const analyticsLogs = pgTable('analytics_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: varchar('project_id', { length: 64 })
    .references(() => projects.id, { onDelete: 'cascade' })
    .notNull(),
  protocol: varchar('protocol', { length: 32 }).notNull(), // 'POST' | 'WS'
  durationMs: integer('duration_ms').default(0),
  tokensUsed: integer('tokens_used').default(0),
  tokensSaved: integer('tokens_saved').default(0),
  source: varchar('source', { length: 64 }).default('ai'),
  statusCode: integer('status_code').default(200),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * Project Tools (Client-side and Server-side execution tools)
 */
export const projectTools = pgTable('project_tools', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: varchar('project_id', { length: 64 })
    .references(() => projects.id, { onDelete: 'cascade' })
    .notNull(),
  name: varchar('name', { length: 128 }).notNull(),
  description: text('description').notNull(),
  parameters: jsonb('parameters').$type<{
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required: string[];
  }>().default({ type: 'object', properties: {}, required: [] }),
  returnsDescription: text('returns_description').default('Returns data or status of the action.'),
  isActive: boolean('is_active').default(true).notNull(),
  embedding: jsonb('embedding').$type<number[] | null>(),
  tags: jsonb('tags').$type<string[]>().default([]).notNull(),
  shortDescription: varchar('short_description', { length: 100 }),
  compactSchema: text('compact_schema'),
  tier: integer('tier').default(1).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ══════════════════════════════════════════════════════════════════════
// PART A: KNOWLEDGE PATTERN SYSTEM (Tables 1 - 10)
// ══════════════════════════════════════════════════════════════════════

/**
 * Table 1: knowledge_patterns
 * Saves unique intent patterns across all users for zero-API instant execution.
 */
export const knowledgePatterns = pgTable(
  'knowledge_patterns',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: varchar('project_id', { length: 64 })
      .references(() => projects.id, { onDelete: 'cascade' })
      .notNull(),
    intent: varchar('intent', { length: 100 }).notNull(), // e.g., 'order_tracking'
    patternType: varchar('pattern_type', { length: 50 }).notNull(), // 'question' | 'command' | 'info' | 'chat'
    examplePhrases: jsonb('example_phrases').$type<string[]>().default([]).notNull(),
    embedding: jsonb('embedding').$type<number[] | null>(),
    description: text('description'),
    category: varchar('category', { length: 50 }).default('general').notNull(),
    source: varchar('source', { length: 50 }).default('manual').notNull(), // 'manual' | 'auto_learned'
    confidenceScore: real('confidence_score').default(0.95).notNull(),
    usageCount: integer('usage_count').default(0).notNull(),
    successCount: integer('success_count').default(0).notNull(),
    failureCount: integer('failure_count').default(0).notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    isVerified: boolean('is_verified').default(false).notNull(),
    learningStage: varchar('learning_stage', { length: 32 }).default('learning').notNull(), // 'learning' | 'matured' | 'verified'
    targetVariants: integer('target_variants').default(3).notNull(),
    qualityScore: real('quality_score').default(1.0).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at'),
  },
  (table) => ({
    unqPattern: unique().on(table.projectId, table.intent, table.patternType),
  })
);

/**
 * Table 2: pattern_tool_sequences
 * Defines tool execution order and conditional dependency pipelines.
 */
export const patternToolSequences = pgTable('pattern_tool_sequences', {
  id: uuid('id').defaultRandom().primaryKey(),
  patternId: uuid('pattern_id')
    .references(() => knowledgePatterns.id, { onDelete: 'cascade' })
    .notNull(),
  stepNumber: integer('step_number').notNull(),
  toolName: varchar('tool_name', { length: 100 }).notNull(),
  toolType: varchar('tool_type', { length: 20 }).default('server').notNull(), // 'server' | 'client' | 'ai'
  inputMapping: jsonb('input_mapping').$type<Record<string, any>>().default({}).notNull(),
  outputKey: varchar('output_key', { length: 100 }),
  isOptional: boolean('is_optional').default(false).notNull(),
  condition: jsonb('condition').$type<Record<string, any> | null>(),
  dependsOnStep: integer('depends_on_step'),
  onError: varchar('on_error', { length: 50 }).default('stop').notNull(), // 'stop' | 'skip' | 'retry' | 'ask_user'
  maxRetries: integer('max_retries').default(0).notNull(),
  timeoutSeconds: integer('timeout_seconds').default(60).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * Table 3: pattern_answer_templates
 * Multi-scenario dynamic response templates.
 */
export const patternAnswerTemplates = pgTable('pattern_answer_templates', {
  id: uuid('id').defaultRandom().primaryKey(),
  patternId: uuid('pattern_id')
    .references(() => knowledgePatterns.id, { onDelete: 'cascade' })
    .notNull(),
  templateType: varchar('template_type', { length: 50 }).default('success').notNull(), // 'success' | 'partial' | 'error' | 'fallback' | 'ask_input'
  variantName: varchar('variant_name', { length: 50 }).default('short').notNull(), // 'short' | 'detailed'
  template: text('template').notNull(),
  conditions: jsonb('conditions').$type<Record<string, any> | null>(),
  priority: integer('priority').default(1).notNull(),
  usageCount: integer('usage_count').default(0).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * Table 4: pattern_missing_inputs
 * Handles missing required parameters with auto-fetching or user prompts.
 */
export const patternMissingInputs = pgTable('pattern_missing_inputs', {
  id: uuid('id').defaultRandom().primaryKey(),
  patternId: uuid('pattern_id')
    .references(() => knowledgePatterns.id, { onDelete: 'cascade' })
    .notNull(),
  fieldName: varchar('field_name', { length: 100 }).notNull(),
  fieldType: varchar('field_type', { length: 50 }).default('text').notNull(), // 'text' | 'number' | 'date' | 'select'
  questionTemplate: text('question_template').notNull(),
  validationRegex: varchar('validation_regex', { length: 255 }),
  fetchFrom: varchar('fetch_from', { length: 50 }).default('client').notNull(), // 'user_memory' | 'tool' | 'client'
  fetchTool: varchar('fetch_tool', { length: 100 }),
  fuzzyMatchEnabled: boolean('fuzzy_match_enabled').default(false).notNull(),
  fuzzyMatchSource: varchar('fuzzy_match_source', { length: 100 }),
  fuzzyThreshold: integer('fuzzy_threshold').default(80).notNull(),
  askPriority: integer('ask_priority').default(1).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * Table 5: pattern_relationships
 * Parent-child multi-turn pattern chaining and flow relations.
 */
export const patternRelationships = pgTable('pattern_relationships', {
  id: uuid('id').defaultRandom().primaryKey(),
  parentPatternId: uuid('parent_pattern_id')
    .references(() => knowledgePatterns.id, { onDelete: 'cascade' })
    .notNull(),
  childPatternId: uuid('child_pattern_id')
    .references(() => knowledgePatterns.id, { onDelete: 'cascade' })
    .notNull(),
  relationshipType: varchar('relationship_type', { length: 50 }).notNull(), // 'follows' | 'triggers' | 'alternative' | 'sub_intent'
  conditions: jsonb('conditions').$type<Record<string, any> | null>(),
  weight: real('weight').default(1.0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * Table 6: user_conversations (24h retention)
 * Conversation sessions that expire automatically after 24 hours.
 */
export const userConversations = pgTable('user_conversations', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: varchar('project_id', { length: 64 })
    .references(() => projects.id, { onDelete: 'cascade' })
    .notNull(),
  userId: varchar('user_id', { length: 255 }).notNull(),
  sessionId: varchar('session_id', { length: 255 }).notNull().unique(),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  lastMessageAt: timestamp('last_message_at').defaultNow().notNull(),
  messageCount: integer('message_count').default(0).notNull(),
  userState: varchar('user_state', { length: 50 }).default('new').notNull(), // 'new' | 'active' | 'returning'
  deviceType: varchar('device_type', { length: 50 }).default('web').notNull(),
  language: varchar('language', { length: 10 }).default('bn').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  closedAt: timestamp('closed_at'),
  expiresAt: timestamp('expires_at').notNull(),
  cleanupAt: timestamp('cleanup_at'),
});

/**
 * Table 7: user_messages (24h retention)
 * Individual user and agent messages with 24-hour expiration.
 */
export const userMessages = pgTable('user_messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  conversationId: uuid('conversation_id')
    .references(() => userConversations.id, { onDelete: 'cascade' })
    .notNull(),
  projectId: varchar('project_id', { length: 64 })
    .references(() => projects.id, { onDelete: 'cascade' })
    .notNull(),
  userId: varchar('user_id', { length: 255 }).notNull(),
  role: varchar('role', { length: 20 }).notNull(), // 'user' | 'assistant' | 'system' | 'tool'
  content: text('content').notNull(),
  detectedPatternId: uuid('detected_pattern_id')
    .references(() => knowledgePatterns.id, { onDelete: 'set null' }),
  detectedIntent: varchar('detected_intent', { length: 100 }),
  confidenceScore: real('confidence_score'),
  executedSteps: jsonb('executed_steps').$type<any[]>().default([]),
  finalAnswer: text('final_answer'),
  wasAiCalled: boolean('was_ai_called').default(false).notNull(),
  executionTimeMs: integer('execution_time_ms').default(0).notNull(),
  tokensUsed: integer('tokens_used').default(0).notNull(),
  status: varchar('status', { length: 50 }).default('completed').notNull(),
  parentMessageId: uuid('parent_message_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  cleanupAt: timestamp('cleanup_at'),
});

/**
 * Table 8: pattern_learning_log
 * Historical versioning and audit trails for newly learned patterns.
 */
export const patternLearningLog = pgTable('pattern_learning_log', {
  id: uuid('id').defaultRandom().primaryKey(),
  patternId: uuid('pattern_id')
    .references(() => knowledgePatterns.id, { onDelete: 'cascade' })
    .notNull(),
  learnedFromMessageId: uuid('learned_from_message_id'),
  learnedFromUserId: varchar('learned_from_user_id', { length: 255 }),
  learnedFromConversationId: uuid('learned_from_conversation_id'),
  learningMethod: varchar('learning_method', { length: 50 }).default('ai_synthesis').notNull(),
  aiProvider: varchar('ai_provider', { length: 100 }),
  aiModel: varchar('ai_model', { length: 100 }),
  previousVersion: jsonb('previous_version'),
  newVersion: jsonb('new_version'),
  verifiedByAdmin: boolean('verified_by_admin').default(false).notNull(),
  adminNotes: text('admin_notes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * Table 9: pattern_feedback
 * End-user feedback for adaptive learning and confidence recalibration.
 */
export const patternFeedback = pgTable('pattern_feedback', {
  id: uuid('id').defaultRandom().primaryKey(),
  patternId: uuid('pattern_id')
    .references(() => knowledgePatterns.id, { onDelete: 'cascade' })
    .notNull(),
  messageId: uuid('message_id'),
  userId: varchar('user_id', { length: 255 }).notNull(),
  feedbackType: varchar('feedback_type', { length: 50 }).notNull(), // 'helpful' | 'not_helpful' | 'wrong' | 'incomplete'
  comment: text('comment'),
  actionTaken: varchar('action_taken', { length: 50 }).default('none').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * Table 10: intent_types
 * Pre-populated intent catalog defining operational behaviors.
 */
export const intentTypes = pgTable('intent_types', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: varchar('code', { length: 50 }).notNull().unique(), // 'question', 'command', 'information', 'chat', 'feedback'
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  defaultAction: varchar('default_action', { length: 50 }).default('pattern_match').notNull(),
  requiresTools: boolean('requires_tools').default(false).notNull(),
  requiresAi: boolean('requires_ai').default(false).notNull(),
  priority: integer('priority').default(1).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ══════════════════════════════════════════════════════════════════════
// PART B: USER PROFILE SYSTEM (Permanent Data, Tables 11 - 14)
// ══════════════════════════════════════════════════════════════════════

/**
 * Table 11: user_profiles (PERMANENT - Never auto-deleted)
 * Long-term user identity, language, and operational role.
 */
export const userProfiles = pgTable(
  'user_profiles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: varchar('project_id', { length: 64 })
      .references(() => projects.id, { onDelete: 'cascade' })
      .notNull(),
    userId: varchar('user_id', { length: 255 }).notNull(), // Client-provided user ID
    displayName: varchar('display_name', { length: 255 }),
    preferredLanguage: varchar('preferred_language', { length: 10 }).default('bn').notNull(),
    timezone: varchar('timezone', { length: 50 }).default('Asia/Dhaka').notNull(),
    userRole: varchar('user_role', { length: 50 }).default('user').notNull(), // 'admin' | 'user' | 'guest'
    userState: varchar('user_state', { length: 50 }).default('new').notNull(), // 'new' | 'active' | 'returning' | 'vip'
    firstSeenAt: timestamp('first_seen_at').defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
    totalConversations: integer('total_conversations').default(0).notNull(),
    totalMessages: integer('total_messages').default(0).notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    metadata: jsonb('metadata').$type<Record<string, any>>().default({}).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    unqUserProject: unique().on(table.projectId, table.userId),
  })
);

/**
 * Table 12: user_preferences (PERMANENT)
 * User styling, tone, and delivery preferences.
 */
export const userPreferences = pgTable(
  'user_preferences',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userProfileId: uuid('user_profile_id')
      .references(() => userProfiles.id, { onDelete: 'cascade' })
      .notNull(),
    projectId: varchar('project_id', { length: 64 })
      .references(() => projects.id, { onDelete: 'cascade' })
      .notNull(),
    preferenceKey: varchar('preference_key', { length: 100 }).notNull(), // 'answer_style', 'formality', etc.
    preferenceValue: jsonb('preference_value').$type<Record<string, any>>().notNull(),
    confidence: real('confidence').default(1.0).notNull(),
    source: varchar('source', { length: 50 }).default('explicit').notNull(), // 'explicit' | 'inferred'
    isActive: boolean('is_active').default(true).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    unqUserPref: unique().on(table.userProfileId, table.preferenceKey),
  })
);

/**
 * Table 13: user_facts (PERMANENT)
 * Explicit and learned facts about the user.
 */
export const userFacts = pgTable('user_facts', {
  id: uuid('id').defaultRandom().primaryKey(),
  userProfileId: uuid('user_profile_id')
    .references(() => userProfiles.id, { onDelete: 'cascade' })
    .notNull(),
  projectId: varchar('project_id', { length: 64 })
    .references(() => projects.id, { onDelete: 'cascade' })
    .notNull(),
  factKey: varchar('fact_key', { length: 100 }).notNull(), // e.g., 'city', 'occupation', 'has_children'
  factValue: jsonb('fact_value').$type<Record<string, any>>().notNull(),
  factCategory: varchar('fact_category', { length: 50 }).default('personal').notNull(), // 'personal' | 'professional' | 'preference'
  confidence: real('confidence').default(1.0).notNull(),
  sourceMessageId: uuid('source_message_id'),
  isVerified: boolean('is_verified').default(false).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * Table 14: user_behavior_patterns (PERMANENT)
 * Behavioral patterns, activity hours, topic interests.
 */
export const userBehaviorPatterns = pgTable('user_behavior_patterns', {
  id: uuid('id').defaultRandom().primaryKey(),
  userProfileId: uuid('user_profile_id')
    .references(() => userProfiles.id, { onDelete: 'cascade' })
    .notNull(),
  projectId: varchar('project_id', { length: 64 })
    .references(() => projects.id, { onDelete: 'cascade' })
    .notNull(),
  patternType: varchar('pattern_type', { length: 50 }).notNull(), // 'question_style', 'time_pattern', 'topic_interests'
  patternData: jsonb('pattern_data').$type<Record<string, any>>().notNull(),
  confidence: real('confidence').default(1.0).notNull(),
  observationCount: integer('observation_count').default(1).notNull(),
  lastObservedAt: timestamp('last_observed_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ══════════════════════════════════════════════════════════════════════
// PART C: MULTI-LANGUAGE SUPPORT (Tables 15 - 17)
// ══════════════════════════════════════════════════════════════════════

/**
 * Table 15: pattern_translations
 * Cross-lingual trigger representations for a single intent pattern.
 */
export const patternTranslations = pgTable(
  'pattern_translations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    patternId: uuid('pattern_id')
      .references(() => knowledgePatterns.id, { onDelete: 'cascade' })
      .notNull(),
    language: varchar('language', { length: 10 }).notNull(), // 'bn' | 'en' | 'ar' | 'hi' | 'ur'
    examplePhrases: jsonb('example_phrases').$type<string[]>().default([]).notNull(),
    embedding: jsonb('embedding').$type<number[] | null>(),
    description: text('description'),
    isDefault: boolean('is_default').default(false).notNull(),
    confidenceScore: real('confidence_score').default(0.95).notNull(),
    usageCount: integer('usage_count').default(0).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    unqPatternLang: unique().on(table.patternId, table.language),
  })
);

/**
 * Table 16: answer_translations
 * Language-specific localized answer template variants.
 */
export const answerTranslations = pgTable(
  'answer_translations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    templateId: uuid('template_id')
      .references(() => patternAnswerTemplates.id, { onDelete: 'cascade' })
      .notNull(),
    language: varchar('language', { length: 10 }).notNull(),
    template: text('template').notNull(),
    variablesMapping: jsonb('variables_mapping').$type<Record<string, string>>().default({}).notNull(),
    confidenceScore: real('confidence_score').default(0.95).notNull(),
    isDefault: boolean('is_default').default(false).notNull(),
    usageCount: integer('usage_count').default(0).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    unqTemplateLang: unique().on(table.templateId, table.language),
  })
);

/**
 * Table 17: languages
 * Supported system languages catalog.
 */
export const languages = pgTable('languages', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: varchar('code', { length: 10 }).notNull().unique(), // 'bn', 'en', 'hi', 'ar', 'ur'
  name: varchar('name', { length: 100 }).notNull(),
  nativeName: varchar('native_name', { length: 100 }).notNull(),
  direction: varchar('direction', { length: 5 }).default('ltr').notNull(), // 'ltr' | 'rtl'
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ══════════════════════════════════════════════════════════════════════
// ORM Relations
// ══════════════════════════════════════════════════════════════════════

export const projectsRelations = relations(projects, ({ many }) => ({
  apiKeys: many(apiKeys),
  users: many(projectUsers),
  memories: many(userMemories),
  knowledge: many(knowledgeEntries),
  skills: many(learnedSkills),
  conversations: many(conversations),
  analytics: many(analyticsLogs),
  tools: many(projectTools),
  knowledgePatterns: many(knowledgePatterns),
  userProfiles: many(userProfiles),
  userConversations: many(userConversations),
}));

export const knowledgePatternsRelations = relations(knowledgePatterns, ({ one, many }) => ({
  project: one(projects, {
    fields: [knowledgePatterns.projectId],
    references: [projects.id],
  }),
  toolSequences: many(patternToolSequences),
  answerTemplates: many(patternAnswerTemplates),
  missingInputs: many(patternMissingInputs),
  translations: many(patternTranslations),
  learningLogs: many(patternLearningLog),
  feedbackList: many(patternFeedback),
}));

export const patternToolSequencesRelations = relations(patternToolSequences, ({ one }) => ({
  pattern: one(knowledgePatterns, {
    fields: [patternToolSequences.patternId],
    references: [knowledgePatterns.id],
  }),
}));

export const patternAnswerTemplatesRelations = relations(patternAnswerTemplates, ({ one, many }) => ({
  pattern: one(knowledgePatterns, {
    fields: [patternAnswerTemplates.patternId],
    references: [knowledgePatterns.id],
  }),
  translations: many(answerTranslations),
}));

export const userProfilesRelations = relations(userProfiles, ({ one, many }) => ({
  project: one(projects, {
    fields: [userProfiles.projectId],
    references: [projects.id],
  }),
  preferences: many(userPreferences),
  facts: many(userFacts),
  behaviorPatterns: many(userBehaviorPatterns),
}));

export const userConversationsRelations = relations(userConversations, ({ one, many }) => ({
  project: one(projects, {
    fields: [userConversations.projectId],
    references: [projects.id],
  }),
  messages: many(userMessages),
}));

export const cachedResponses = pgTable(
  'cached_responses',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: varchar('project_id', { length: 64 })
      .references(() => projects.id, { onDelete: 'cascade' })
      .notNull(),
    messageHash: varchar('message_hash', { length: 64 }).notNull(),
    triggerText: text('trigger_text'),
    response: text('response').notNull(),
    language: varchar('language', { length: 10 }),
    usageCount: integer('usage_count').default(0).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  }
);

export const intentCache = pgTable(
  'intent_cache',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: varchar('project_id', { length: 64 })
      .references(() => projects.id, { onDelete: 'cascade' })
      .notNull(),
    messageHash: varchar('message_hash', { length: 64 }).notNull(),
    intent: varchar('intent', { length: 50 }).notNull(),
    topic: varchar('topic', { length: 100 }),
    confidence: real('confidence'),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  }
);

