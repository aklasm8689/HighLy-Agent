import crypto from 'crypto';
import { getPgPool } from '../../db';
import { PatternFeedbackRecord, PatternLearningLogRecord, FeedbackType } from './types';

function isUuid(id: any): boolean {
  if (!id || typeof id !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export class FeedbackEngine {
  /**
   * Record user feedback and adaptively recalibrate confidence
   */
  async recordFeedback(
    patternId: string,
    userId: string,
    feedbackType: FeedbackType,
    comment?: string,
    messageId?: string
  ): Promise<{ feedback: PatternFeedbackRecord; newConfidence: number }> {
    const pool = getPgPool();
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    let actionTaken = 'none';
    let confidenceDelta = 0;

    if (feedbackType === 'helpful') {
      confidenceDelta = 0.02; // Boost confidence
      actionTaken = 'confidence_boosted';
    } else if (feedbackType === 'wrong') {
      confidenceDelta = -0.15; // Significant penalty
      actionTaken = 'relearn_scheduled';
    } else if (feedbackType === 'not_helpful' || feedbackType === 'incomplete') {
      confidenceDelta = -0.05;
      actionTaken = 'confidence_penalized';
    }

    const feedbackRecord: PatternFeedbackRecord = {
      id,
      pattern_id: patternId,
      user_id: userId,
      message_id: messageId,
      feedback_type: feedbackType,
      comment,
      action_taken: actionTaken,
      created_at: now,
    };

    let newConfidence = 0.95;

    if (pool && isUuid(patternId)) {
      try {
        const patternCheck = await pool.query(`SELECT id FROM knowledge_patterns WHERE id = $1 LIMIT 1`, [patternId]);
        if (patternCheck.rows.length > 0) {
          const validMessageId = messageId && isUuid(messageId) ? messageId : null;
          await pool.query(
            `INSERT INTO pattern_feedback (id, pattern_id, user_id, message_id, feedback_type, comment, action_taken, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              feedbackRecord.id,
              feedbackRecord.pattern_id,
              feedbackRecord.user_id,
              validMessageId,
              feedbackRecord.feedback_type,
              feedbackRecord.comment || null,
              feedbackRecord.action_taken,
              feedbackRecord.created_at,
            ]
          );

          // Update pattern statistics and confidence score
          const successIncrement = feedbackType === 'helpful' ? 1 : 0;
          const failureIncrement = feedbackType !== 'helpful' ? 1 : 0;

          const updateRes = await pool.query(
            `UPDATE knowledge_patterns 
             SET 
               success_count = success_count + $1,
               failure_count = failure_count + $2,
               confidence_score = GREATEST(0.40, LEAST(1.0, confidence_score + $3)),
               updated_at = NOW()
             WHERE id = $4
             RETURNING confidence_score`,
            [successIncrement, failureIncrement, confidenceDelta, patternId]
          );

          if (updateRes.rows.length > 0) {
            newConfidence = updateRes.rows[0].confidence_score;
          }
        }
      } catch (err: any) {
        console.warn('[FeedbackEngine] DB feedback error:', err.message);
      }
    }

    return { feedback: feedbackRecord, newConfidence };
  }

  /**
   * Log an AI or manual pattern learning modification
   */
  async logPatternLearning(log: Omit<PatternLearningLogRecord, 'id' | 'created_at'>): Promise<PatternLearningLogRecord> {
    const pool = getPgPool();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const record: PatternLearningLogRecord = {
      id,
      ...log,
      created_at: now,
    };

    if (pool && isUuid(record.pattern_id)) {
      (async () => {
        try {
          const patCheck = await pool.query(`SELECT id FROM knowledge_patterns WHERE id = $1 LIMIT 1`, [record.pattern_id]);
          if (patCheck.rows.length === 0) {
            // Pattern not in DB yet - skip DB insert to avoid foreign key violation
            return;
          }
          const validMessageId = record.learned_from_message_id && isUuid(record.learned_from_message_id) ? record.learned_from_message_id : null;
          const validConvId = record.learned_from_conversation_id && isUuid(record.learned_from_conversation_id) ? record.learned_from_conversation_id : null;

          await pool.query(
            `INSERT INTO pattern_learning_log (id, pattern_id, learned_from_message_id, learned_from_user_id, learned_from_conversation_id, learning_method, ai_provider, ai_model, previous_version, new_version, verified_by_admin, admin_notes, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [
              record.id,
              record.pattern_id,
              validMessageId,
              record.learned_from_user_id || null,
              validConvId,
              record.learning_method,
              record.ai_provider || null,
              record.ai_model || null,
              JSON.stringify(record.previous_version || {}),
              JSON.stringify(record.new_version || {}),
              record.verified_by_admin,
              record.admin_notes || null,
              record.created_at,
            ]
          );
        } catch (e: any) {
          console.warn('[FeedbackEngine] Learning log DB error:', e.message);
        }
      })();
    }

    return record;
  }
}

export const feedbackEngine = new FeedbackEngine();
