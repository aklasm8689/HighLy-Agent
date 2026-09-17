import { GoogleGenAI } from '@google/genai';
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
 * Summarizes tool execution output if it exceeds a certain length.
 * Extremely effective in reducing input token bloat from verbose raw JSON tools.
 */
export async function summarizeToolOutputIfLarge(toolName: string, output: string): Promise<string> {
  const cleanOutput = output.trim();
  
  // If the output is small or compact (under 800 chars), there's no need to summarize.
  if (cleanOutput.length <= 800) {
    return cleanOutput;
  }

  const apiKey = getActiveGeminiKey();
  if (!apiKey) {
    // If no key is set yet, return a simple sliced string
    return cleanOutput.slice(0, 800) + '\n... [truncated due to size constraints]';
  }

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    });

    // Use a cheap, fast, low-latency model for the task
    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: cleanOutput,
      config: {
        systemInstruction: `Summarize tool execution output for the tool named '${toolName}'. Extract key facts, numbers, attributes, statuses, and critical user-facing details into a highly concise summary. Avoid verbose narrative or nesting. Maximize direct semantic informational value in as few words as possible.`,
        temperature: 0.2,
      },
    });

    if (response.text) {
      const summary = response.text.trim();
      console.log(`[ToolSummary] Successfully compressed verbose tool '${toolName}' output from ${cleanOutput.length} to ${summary.length} characters.`);
      return `[Summarized ${toolName} Output]: ${summary}`;
    }
  } catch (err: any) {
    console.warn(`[ToolSummary] Failed to summarize tool '${toolName}' output, falling back to truncation:`, err.message);
  }

  return cleanOutput.slice(0, 800) + '\n... [truncated due to size constraints]';
}
