import { getPgPool } from '../../db';
import { getAIClient } from '../router';

/**
 * Tool Retriever
 * Cross-Lingual Semantic Tool Retrieval
 */
export async function getRelevantTools(projectId: string, userMessage: string, limit: number = 3) {
  const pool = getPgPool();
  if (!pool) return [];

  try {
    // STEP 1: Cross-Language Intent & Keyword Extraction (Using High-Speed LLM)
    // Since userMessage can be in Bengali, Hindi, Spanish, etc., simple SQL text search will fail.
    // We use the cheap/fast model to translate the intent into English search keywords.
    const ai = getAIClient();
    let searchKeywords = '';

    try {
      if (ai) {
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: userMessage,
          config: {
            systemInstruction: 'You are a translation and keyword extraction tool. Read the user message in any language. Extract 2-3 main English keywords that describe the action the user wants to perform (e.g. "weather location", "add money", "search file"). Output ONLY the English keywords, separated by spaces.',
            temperature: 0.1,
          }
        });
        searchKeywords = (response.text || '').trim();
      } else {
        searchKeywords = userMessage;
      }
    } catch (e: any) {
      console.warn('[Tool Retriever] Keyword extraction failed, falling back to original message:', e.message);
      try {
        const { handleAiError } = require('../status');
        handleAiError(e);
      } catch {}
      searchKeywords = userMessage; // Fallback
    }

    // STEP 2: Database Search using extracted English Keywords
    // We use PostgreSQL Full-Text Search (to_tsvector) combined with ILIKE for fuzzy matching.
    const searchTerms = searchKeywords.split(' ').filter(k => k.length > 2);
    
    let query = `
      SELECT name, description, parameters, returns_description 
      FROM project_tools 
      WHERE project_id = $1 AND is_active = true
    `;

    const queryParams: any[] = [projectId];

    if (searchTerms.length > 0) {
      // Build a dynamic ILIKE condition for the keywords to match tool name or description
      const likeConditions = searchTerms.map((_, i) => `(name ILIKE $${i + 3} OR description ILIKE $${i + 3})`).join(' OR ');
      query += ` AND (${likeConditions})`;
      
      searchTerms.forEach(term => queryParams.push(`%${term}%`));
    }

    query += ` LIMIT $2`;
    queryParams.splice(1, 0, limit); // Insert limit at $2

    const result = await pool.query(query, queryParams);

    // STEP 3: Fallback if no specific tools matched the keywords
    // If the keyword search failed, we just return the most commonly used tools or a general set.
    if (result.rows.length === 0) {
       const fallbackResult = await pool.query(
        `SELECT name, description, parameters, returns_description 
         FROM project_tools 
         WHERE project_id = $1 AND is_active = true
         LIMIT $2`,
        [projectId, limit]
      );
      return fallbackResult.rows;
    }

    return result.rows;
  } catch (error) {
    console.error('[Tool Retriever Error]:', error);
    return [];
  }
}
