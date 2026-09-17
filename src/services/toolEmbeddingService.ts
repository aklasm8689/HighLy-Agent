import { GoogleGenAI } from '@google/genai';
import { getPgPool } from '../db/index';
import { store } from '../state/index';

function getActiveGeminiKey(): string | undefined {
  const record = store.providers.get('gemini');
  if (record?.api_key) return record.api_key;
  if (record?.keys) {
    const activeKey = record.keys.find(k => k.enabled)?.api_key;
    if (activeKey) return activeKey;
  }
  return process.env.GEMINI_API_KEY;
}

/**
 * Generate embedding vector using gemini-embedding-2-preview
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  const apiKey = getActiveGeminiKey();
  if (!apiKey) return null;

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    });

    const response = await ai.models.embedContent({
      model: 'gemini-embedding-2-preview',
      contents: text,
    });

    // In @google/genai, embedContent returns standard structure:
    // response.embedding.values or response.embeddings[0].values
    const values = response.embedding?.values || (response as any).embeddings?.[0]?.values;
    if (Array.isArray(values)) {
      return values;
    }
    return null;
  } catch (err: any) {
    console.warn('[ToolEmbedding] Failed to generate embedding vector:', err.message);
    return null;
  }
}

/**
 * Compute cosine similarity between two numeric vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Sync and populate missing metadata (embeddings, tags, short_description, compact_schema, tier)
 * for all tools of a project in both `store` and PostgreSQL.
 */
export async function initializeAndBackfillTools(projectId: string): Promise<void> {
  const pool = getPgPool();
  if (!pool) return;

  try {
    // 1. Fetch all tools for the project
    const res = await pool.query(
      `SELECT id, name, description, parameters, returns_description, embedding, tags, short_description, compact_schema, tier 
       FROM project_tools 
       WHERE project_id = $1`,
      [projectId]
    );

    const tools = res.rows;
    const apiKey = getActiveGeminiKey();

    for (const tool of tools) {
      let updated = false;
      const updates: Record<string, any> = {};

      // Auto-populate tags from description/name if empty
      let tags: string[] = tool.tags || [];
      if (tags.length === 0) {
        const words = `${tool.name} ${tool.description}`.toLowerCase()
          .replace(/[^a-z0-9 ]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length > 3 && !['with', 'your', 'this', 'that', 'from', 'each', 'into'].includes(w));
        tags = Array.from(new Set(words)).slice(0, 5);
        updates.tags = JSON.stringify(tags);
        updated = true;
      }

      // Auto-populate short description if empty
      let shortDesc: string = tool.short_description || '';
      if (!shortDesc) {
        shortDesc = tool.description.length > 80 ? tool.description.slice(0, 77) + '...' : tool.description;
        updates.short_description = shortDesc;
        updated = true;
      }

      // Auto-populate compact schema if empty
      let compactSchema: string = tool.compact_schema || '';
      if (!compactSchema) {
        const params = tool.parameters?.properties || {};
        const compactKeys = Object.entries(params).map(([k, v]: [string, any]) => {
          return `${k}: ${v.type}${v.description ? ` (${v.description})` : ''}`;
        }).join(', ');
        compactSchema = `${tool.name}(${compactKeys}) -> ${tool.returns_description || 'data'}`;
        updates.compact_schema = compactSchema;
        updated = true;
      }

      // Generate embedding if empty and API key is available
      let embedding: number[] | null = tool.embedding ? (typeof tool.embedding === 'string' ? JSON.parse(tool.embedding) : tool.embedding) : null;
      if (!embedding && apiKey) {
        const textToEmbed = `Tool Name: ${tool.name}. Short description: ${shortDesc}. Tags: ${tags.join(', ')}. Details: ${tool.description}`;
        embedding = await generateEmbedding(textToEmbed);
        if (embedding) {
          updates.embedding = JSON.stringify(embedding);
          updated = true;
        }
      }

      if (updated && Object.keys(updates).length > 0) {
        const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
        const queryParams = [tool.id, ...Object.values(updates)];
        await pool.query(
          `UPDATE project_tools SET ${setClauses}, updated_at = NOW() WHERE id = $1`,
          queryParams
        );

        // Also update the in-memory state store if it's there
        const storeTool = store.tools.get(tool.id);
        if (storeTool) {
          if (updates.tags) storeTool.tags = tags;
          if (updates.short_description) storeTool.short_description = shortDesc;
          if (updates.compact_schema) storeTool.compact_schema = compactSchema;
          if (embedding) storeTool.embedding = embedding;
          store.tools.set(tool.id, storeTool);
        }
      }
    }
  } catch (err: any) {
    console.warn('[ToolEmbedding] Backfill tools error:', err.message);
  }
}

/**
 * Semantic retrieval of tools matching the user message.
 * Returns only matching top-K enabled tools.
 */
export async function getSemanticTools(projectId: string, userMessage: string, limit: number = 3): Promise<any[]> {
  const pool = getPgPool();
  if (!pool) return [];

  try {
    // Backfill in the background to ensure embeddings are hydrated
    initializeAndBackfillTools(projectId).catch(() => {});

    // Fetch all active tools for the project
    const res = await pool.query(
      `SELECT id, name, description, parameters, returns_description, embedding, tags, short_description, compact_schema, tier 
       FROM project_tools 
       WHERE project_id = $1 AND is_active = true`,
      [projectId]
    );

    const tools = res.rows;
    if (tools.length === 0) return [];

    // If query has no embedding, generate it
    const queryEmbedding = await generateEmbedding(userMessage);
    if (!queryEmbedding) {
      // Return first few active tools if embedding generation fails
      return tools.slice(0, limit);
    }

    // Rank tools by cosine similarity
    const toolsWithScore = tools.map(t => {
      const tEmbedding = t.embedding ? (typeof t.embedding === 'string' ? JSON.parse(t.embedding) : t.embedding) : null;
      const score = tEmbedding ? cosineSimilarity(queryEmbedding, tEmbedding) : 0;
      return { ...t, score };
    });

    // Sort descending and return top-K
    toolsWithScore.sort((a, b) => b.score - a.score);

    // Keep only tools with positive or reasonable similarity score (e.g. >= 0.1)
    const filtered = toolsWithScore.filter(t => t.score >= 0.1);
    const selected = filtered.length > 0 ? filtered : toolsWithScore;

    return selected.slice(0, limit);
  } catch (err: any) {
    console.warn('[ToolEmbedding] Semantic tool search error:', err.message);
    return [];
  }
}
