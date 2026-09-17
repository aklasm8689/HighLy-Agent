import { getAIClient } from './router';
import { getRelevantTools } from './tools/retriever';

export class AIOrchestrator {
  
  /**
   * Main entry point for processing a user's message.
   * Demonstrates retrieving ONLY relevant tools before calling the AI.
   */
  static async handleUserMessage(projectId: string, message: string) {
    // 1. Semantic Tool Retrieval: 
    // Instead of passing 100+ tools, we ask the database: 
    // "Give me the top 3 tools that match this user's message context."
    const relevantTools = await getRelevantTools(projectId, message, 3);
    
    // Now we pass ONLY these 3 tools to the intent router or AI.
    // This saves massive amounts of tokens and prevents the "लाल বাতি" problem.
    // const intent = await determineIntent(message, relevantTools);
    
    // ... rest of the orchestration logic (looping, tool execution, etc.)
  }

  /**
   * Generates the final dynamic response based on Raw Data / Tool Output.
   * This is where we ensure the AI doesn't hallucinate, it just formats the provided facts.
   */
  static async generateFinalResponse(
    userMessage: string, 
    toolResults: any[], 
    model: string = 'gemini-2.5-flash'
  ): Promise<string> {
    const client = getAIClient();
    
    const systemInstruction = `
      You are an intelligent, helpful agent.
      The system has executed background tools to fulfill the user's request.
      
      RULES:
      1. ONLY base your answer on the provided TOOL RESULTS.
      2. Do NOT invent or hallucinate data.
      3. If the tool result says "Not found" or "Error", explain that politely to the user.
      4. Be concise but conversational. Keep a human-like tone.
      
      TOOL RESULTS:
      ${JSON.stringify(toolResults, null, 2)}
    `;

    try {
      const response = await client.models.generateContent({
        model: model,
        contents: userMessage,
        config: {
          systemInstruction,
          temperature: 0.7, // Higher temp for more natural/dynamic human-like variation
        }
      });
      return response.text || 'I have completed the task, but could not generate a response.';
    } catch (error: any) {
      console.error('[Orchestrator Finalizing Error]:', error);
      return 'Sorry, there was an issue processing the final response.';
    }
  }
}
