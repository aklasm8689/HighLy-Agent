import crypto from 'crypto';
import { store, LearnedSkill, SkillParameterSlot, SkillToolStep } from '../state';
import { toolEngine } from './tools';
import { knowledgeEngine } from './knowledge';

export interface SkillMatchResult {
  skill: LearnedSkill;
  confidence: number;
  extractedSlots: Record<string, any>;
  isExactOrHighConfidence: boolean;
  missingRequiredSlots: string[];
}

export interface SkillExecutionResult {
  text: string;
  toolsUsed: string[];
  results: Record<string, any>;
  success: boolean;
  error?: string;
  latencyMs: number;
}

export class SkillEngine {
  private normalize(text: string): string {
    return text
      .toLowerCase()
      .replace(/[?!.,;:'"()_-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Search for a matching learned skill or tool execution strategy
   */
  async searchSkill(
    clientId: string,
    query: string,
    contextEntities: Record<string, any> = {}
  ): Promise<SkillMatchResult | null> {
    const qClean = this.normalize(query);
    if (!qClean) return null;

    let bestMatch: SkillMatchResult | null = null;
    let highestConfidence = 0;

    const availableSkills = Array.from(store.skills.values()).filter(
      (s) => s.client_id === clientId && s.status !== 'disabled'
    );

    for (const skill of availableSkills) {
      let patternMatchScore = 0;
      let matchedSlots: Record<string, any> = {};

      for (const pattern of skill.trigger_patterns) {
        const slotNames: string[] = [];
        // Convert pattern like "what is the weather in {city}" into regex
        const regexStr = pattern
          .replace(/[?!.,;:'"()_-]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name) => {
            slotNames.push(name);
            return '([A-Za-z0-9.\\-+*/% ]+?)';
          });

        try {
          const regex = new RegExp(`^${regexStr}$`, 'i');
          const match = qClean.match(regex);
          if (match) {
            patternMatchScore = 0.98;
            slotNames.forEach((name, idx) => {
              const val = match[idx + 1]?.trim();
              if (val) matchedSlots[name] = val;
            });
            break;
          }
        } catch {
          // ignore invalid regex construction
        }

        // Semantic similarity check against raw trigger pattern
        const cleanPattern = pattern.replace(/\{[a-zA-Z0-9_]+\}/g, '').trim();
        const sim = knowledgeEngine.calculateSimilarity(qClean, cleanPattern);
        if (sim > patternMatchScore) {
          patternMatchScore = sim;
        }
      }

      // Slot extraction from query using slot definitions
      for (const slot of skill.parameter_slots) {
        if (!matchedSlots[slot.name]) {
          if (slot.extraction_regex) {
            try {
              const r = new RegExp(slot.extraction_regex, 'i');
              const m = query.match(r);
              if (m) {
                // capture group 1 or 2 or full match
                const val = m[1] || m[2] || m[0];
                if (val && val.trim()) {
                  matchedSlots[slot.name] = slot.type === 'number' ? parseFloat(val) || val.trim() : val.trim();
                }
              }
            } catch {
              // fallback
            }
          }

          // Fallback: If not found in query, resolve from multi-turn context memory!
          if (!matchedSlots[slot.name]) {
            if (contextEntities[slot.name] !== undefined) {
              matchedSlots[slot.name] = contextEntities[slot.name];
            } else if (contextEntities[`last_${slot.name}`] !== undefined) {
              matchedSlots[slot.name] = contextEntities[`last_${slot.name}`];
            } else if (slot.default_value !== undefined) {
              matchedSlots[slot.name] = slot.default_value;
            }
          }
        }
      }

      // Verify required slots
      const missingRequired = skill.parameter_slots
        .filter((s) => s.required && matchedSlots[s.name] === undefined)
        .map((s) => s.name);

      // Adjust confidence based on matched parameters and verification status
      let finalConfidence = patternMatchScore * (skill.confidence_score || 0.85);
      if (skill.verified) finalConfidence = Math.min(1.0, finalConfidence * 1.05);
      if (missingRequired.length > 0) finalConfidence *= 0.6; // penalty for missing slots

      if (finalConfidence > highestConfidence && finalConfidence >= 0.70) {
        highestConfidence = finalConfidence;
        bestMatch = {
          skill,
          confidence: Math.round(finalConfidence * 100) / 100,
          extractedSlots: matchedSlots,
          isExactOrHighConfidence: finalConfidence >= 0.78 && missingRequired.length === 0,
          missingRequiredSlots: missingRequired,
        };
      }
    }

    return bestMatch;
  }

  /**
   * Execute learned tool sequence and format response template without AI API call
   */
  async executeSkill(
    skill: LearnedSkill,
    slots: Record<string, any>,
    clientId: string,
    userRef: string
  ): Promise<SkillExecutionResult> {
    const started = Date.now();
    const toolsUsed: string[] = [];
    const resultsMap: Record<string, any> = {};
    let lastResult: any = null;

    try {
      for (const step of skill.tool_sequence) {
        // Interpolate arguments template with extracted slots
        const resolvedArgs: Record<string, any> = {};
        for (const [k, v] of Object.entries(step.args_template)) {
          if (typeof v === 'string') {
            if (v.startsWith('$')) {
              const slotKey = v.slice(1);
              resolvedArgs[k] = slots[slotKey] !== undefined ? slots[slotKey] : v;
            } else {
              resolvedArgs[k] = v.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
                return slots[key] !== undefined ? slots[key] : `{${key}}`;
              });
            }
          } else {
            resolvedArgs[k] = v;
          }
        }

        const tRes = await toolEngine.executeServerTool(step.tool_name, resolvedArgs, clientId, userRef);
        toolsUsed.push(step.tool_name);
        lastResult = tRes.result;
        resultsMap[step.tool_name] = tRes.result;

        if (tRes.error) {
          skill.fail_count = (skill.fail_count || 0) + 1;
          return {
            text: `Tool execution failed: ${tRes.error}`,
            toolsUsed,
            results: resultsMap,
            success: false,
            error: tRes.error,
            latencyMs: Date.now() - started,
          };
        }
      }

      // Render response using template or default synthesis
      let responseText = skill.response_template || '';
      if (responseText) {
        // Replace slot placeholders
        for (const [k, v] of Object.entries(slots)) {
          responseText = responseText.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
        }
        // Replace tool result properties e.g. {result.temperature}, {result.result}
        if (lastResult && typeof lastResult === 'object') {
          for (const [rk, rv] of Object.entries(lastResult)) {
            const valStr = typeof rv === 'object' ? JSON.stringify(rv, null, 2) : String(rv);
            responseText = responseText.replace(new RegExp(`\\{result\\.${rk}\\}`, 'g'), valStr);
          }
        }
      } else {
        // Automatic natural format
        responseText = `Task completed using learned skill "${skill.name}". Result: ${JSON.stringify(lastResult)}`;
      }

      // Update skill success metrics
      skill.success_count = (skill.success_count || 0) + 1;
      skill.last_executed_at = new Date().toISOString();
      if (skill.confidence_score < 0.98) {
        skill.confidence_score = Math.min(0.99, skill.confidence_score + 0.01);
      }

      return {
        text: responseText,
        toolsUsed,
        results: resultsMap,
        success: true,
        latencyMs: Date.now() - started,
      };
    } catch (err: any) {
      skill.fail_count = (skill.fail_count || 0) + 1;
      return {
        text: `Error executing skill: ${err.message}`,
        toolsUsed,
        results: resultsMap,
        success: false,
        error: err.message,
        latencyMs: Date.now() - started,
      };
    }
  }

  /**
   * AI Teacher / Reasoning engine synthesis: learn a new reusable skill pattern from a successful interaction
   */
  async synthesizeSkillFromAI(
    clientId: string,
    query: string,
    toolsUsed: string[],
    toolResults: any[],
    finalResponse: string,
    extractedIntent?: {
      name?: string;
      category?: string;
      description?: string;
      slots?: SkillParameterSlot[];
      responseTemplate?: string;
    }
  ): Promise<LearnedSkill | null> {
    if (!toolsUsed || toolsUsed.length === 0) {
      return null;
    }

    const now = new Date().toISOString();
    const primaryTool = toolsUsed[0];

    // Derive name and category
    const skillName = extractedIntent?.name || `${primaryTool.replace(/_/g, ' ')} skill`;
    const category = extractedIntent?.category || 'workflow';
    const description = extractedIntent?.description || `Auto-learned skill for ${primaryTool} executions`;

    // Check if an existing skill matches this tool & pattern
    const existing = Array.from(store.skills.values()).find(
      (s) =>
        (s.client_id === clientId || s.client_id === null) &&
        s.tool_sequence.some((t) => toolsUsed.includes(t.tool_name))
    );

    if (existing) {
      // Add query as an additional trigger pattern
      const cleanQ = query.trim();
      if (!existing.trigger_patterns.includes(cleanQ)) {
        existing.trigger_patterns.push(cleanQ);
        if (existing.trigger_patterns.length > 20) {
          existing.trigger_patterns.shift();
        }
      }
      existing.success_count = (existing.success_count || 0) + 1;
      existing.updated_at = now;
      return existing;
    }

    // Formulate parameter slots
    const slots: SkillParameterSlot[] = extractedIntent?.slots || [
      {
        name: 'query_text',
        type: 'string',
        description: 'User query parameter',
        required: true,
        default_value: query,
      },
    ];

    // Formulate tool steps
    const toolSteps: SkillToolStep[] = toolsUsed.map((toolName) => ({
      tool_name: toolName,
      args_template: { query: '$query_text' },
      description: `Execute ${toolName}`,
    }));

    const skillId = `skill-${crypto.randomUUID()}`;
    const newSkill: LearnedSkill = {
      id: skillId,
      client_id: clientId,
      name: skillName,
      category,
      intent_description: description,
      trigger_patterns: [query.trim()],
      parameter_slots: slots,
      tool_sequence: toolSteps,
      response_template: extractedIntent?.responseTemplate || finalResponse,
      verified: false,
      confidence_score: 0.85,
      success_count: 1,
      fail_count: 0,
      learned_from_query: query,
      status: 'active',
      created_at: now,
      updated_at: now,
    };

    store.skills.set(skillId, newSkill);
    store.audit('agent', 'LEARNED_SKILL_CREATED', `Synthesized new skill '${skillName}' for project ${clientId}`);

    return newSkill;
  }

  /**
   * Update skill feedback or admin verification
   */
  updateFeedback(skillId: string, isPositive: boolean, correction?: string): boolean {
    const skill = store.skills.get(skillId);
    if (!skill) return false;

    if (isPositive) {
      skill.success_count += 1;
      skill.confidence_score = Math.min(1.0, (skill.confidence_score || 0.85) + 0.05);
      skill.status = 'active';
    } else {
      skill.fail_count += 1;
      skill.confidence_score = Math.max(0.1, (skill.confidence_score || 0.85) - 0.15);
      if (skill.confidence_score < 0.6) {
        skill.status = 'needs_review';
      }
      if (correction) {
        skill.response_template = correction;
      }
    }
    skill.updated_at = new Date().toISOString();
    return true;
  }
}

export const skillEngine = new SkillEngine();
