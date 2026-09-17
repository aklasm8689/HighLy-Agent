export * from './types';
export * from './patternEngine';
export * from './userProfileEngine';
export * from './multiLangEngine';
export * from './variableResolver';
export * from './conversationRetention';
export * from './feedbackEngine';
export * from './cacheEngine';
export * from './contextChecker';

import { conversationRetentionScheduler } from './conversationRetention';

// Automatically bootstrap background workers
conversationRetentionScheduler.start();
