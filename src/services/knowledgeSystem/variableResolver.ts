/**
 * Variable Resolver & Template Interpolation Engine
 * Strictly guarantees NO hardcoded user facts or tool outputs.
 */
export class VariableResolver {
  /**
   * Resolve template string by substituting {{var_name}} or {{var_name | default_value}}
   */
  interpolate(
    template: string,
    contextVariables: Record<string, any>,
    fallbackDefaults: Record<string, string> = {}
  ): { result: string; unresolvedVariables: string[] } {
    if (!template) return { result: '', unresolvedVariables: [] };

    const unresolved: string[] = [];
    const now = new Date();

    // Default global system variables
    const enrichedVars: Record<string, any> = {
      current_date: now.toLocaleDateString('bn-BD', { year: 'numeric', month: 'long', day: 'numeric' }),
      current_time: now.toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' }),
      date: now.toISOString().split('T')[0],
      ...contextVariables,
    };

    // Regex to match {{ variable_name }} or {{ variable_name | fallback }}
    const result = template.replace(/\{\{\s*([a-zA-Z0-9_.]+)(?:\s*\|\s*([^}]+))?\s*\}\}/g, (match, varPath, fallback) => {
      const val = this.getNestedValue(enrichedVars, varPath);
      if (val !== undefined && val !== null && val !== '') {
        if (typeof val === 'object') {
          return JSON.stringify(val);
        }
        return String(val);
      }

      if (fallback !== undefined) {
        return fallback.trim();
      }

      if (fallbackDefaults[varPath] !== undefined) {
        return fallbackDefaults[varPath];
      }

      unresolved.push(varPath);
      return match; // keep unresolved placeholder so missing input detector can see it
    });

    return {
      result,
      unresolvedVariables: unresolved,
    };
  }

  /**
   * Safely traverse nested objects like 'user.address.city' or 'order.items.0.name'
   */
  private getNestedValue(obj: Record<string, any>, path: string): any {
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
      if (current === undefined || current === null) return undefined;
      current = current[part];
    }
    return current;
  }
}

export const variableResolver = new VariableResolver();
