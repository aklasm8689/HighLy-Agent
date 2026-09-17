import { GoogleGenAI } from '@google/genai';

/**
 * AI Model Router & Orchestrator
 * This module is responsible for deciding WHICH model to use and HOW to handle the intent.
 */

// Initialize Gemini SDK (Will use process.env.GEMINI_API_KEY by default)
let ai: GoogleGenAI | null = null;

export const getAIClient = () => {
  if (!ai) {
    if (!process.env.GEMINI_API_KEY) {
      console.warn('[AI Router] GEMINI_API_KEY is missing. AI features will fail.');
    }
    ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return ai;
};

export type IntentType = 'GREETING' | 'TOOL_EXECUTION' | 'COMPLEX_REASONING' | 'UNKNOWN';

export interface RouteDecision {
  intent: IntentType;
  recommendedModel: string;
  extractedTools?: any[];
}

/**
 * The "Front Desk" Router
 * Uses the fastest, cheapest model to quickly classify the user's message.
 */
export async function determineIntent(message: string, availableTools: any[]): Promise<RouteDecision> {
  const client = getAIClient();
  
  // If it's a very simple greeting, we don't even need an AI call sometimes, 
  // but for dynamic responses, we use the fast Flash model.
  const fastModel = 'gemini-2.5-flash';

  const systemInstruction = `
    You are an intelligent Intent Router for an enterprise API middleware.
    Your job is to analyze the user's message and determine what they want.
    
    Categories:
    - GREETING: Simple hellos, how are you, thanks.
    - TOOL_EXECUTION: The user wants to perform an action (e.g., search file, add money, check balance).
    - COMPLEX_REASONING: The user is asking a deep analytical question or asking to write complex code/reports.
    
    Respond strictly in JSON format: { "intent": "CATEGORY", "reason": "why" }
  `;

  try {
    const response = await client.models.generateContent({
      model: fastModel,
      contents: message,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        temperature: 0.1, // Low temp for deterministic routing
      }
    });

    const result = JSON.parse(response.text || '{}');
    
    // Programmatic Model Selection based on Intent
    let recommendedModel = fastModel;
    if (result.intent === 'COMPLEX_REASONING') {
      recommendedModel = 'gemini-3.1-pro-preview'; // Upgrade to smarter model for heavy tasks
    }

    return {
      intent: result.intent as IntentType || 'UNKNOWN',
      recommendedModel,
    };
  } catch (error) {
    console.error('[AI Router Error]:', error);
    try {
      const { handleAiError } = require('./status');
      handleAiError(error);
    } catch {}
    return { intent: 'UNKNOWN', recommendedModel: fastModel };
  }
}
