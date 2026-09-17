import crypto from 'crypto';
import { WebSocket } from 'ws';
import { store } from '../state';

export type TraceStepType =
  | 'analysis'
  | 'ai'
  | 'tool'
  | 'condition'
  | 'success'
  | 'error'
  | 'skip'
  | 'auth'
  | 'ratelimit'
  | 'profile'
  | 'knowledge'
  | 'response'
  | 'learning';

export type TraceEdgeType =
  | 'normal'
  | 'condition_true'
  | 'condition_false'
  | 'skip'
  | 'ai_call'
  | 'tool_call';

export interface TraceStepNode {
  step_number: number;
  step_name: string;
  step_type: TraceStepType;
  status: 'running' | 'success' | 'failed' | 'skipped';
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
  input_summary?: any;
  output_summary?: any;
  error?: string;
  tool_name?: string;
  tool_type?: string;
  args_summary?: any;
}

export interface TraceEdge {
  from_step: number;
  to_step: number;
  edge_type: TraceEdgeType;
  label?: string;
}

export interface TraceSession {
  trace_id: string;
  user_ref: string;
  project_id: string;
  project_name?: string;
  started_at: string;
  completed_at?: string;
  status: 'running' | 'completed' | 'failed';
  total_duration_ms?: number;
  total_steps: number;
  was_ai_called: boolean;
  cache_hit: boolean;
  nodes: TraceStepNode[];
  edges: TraceEdge[];
  summary?: {
    query_preview?: string;
    response_preview?: string;
    tokens_used?: number;
    tokens_saved?: number;
    source?: string;
  };
}

export interface TraceMetrics {
  activeRequests: number;
  completedToday: number;
  errorsToday: number;
  averageResponseTimeMs: number;
  cacheHitRatePercent: number;
  totalTracesInMemory: number;
}

/**
 * In-Memory Trace Service for Real-Time Agent Flow Visualizer
 * - Zero database queries (100% In-Memory RAM storage)
 * - Auto-cleanup background worker every 5 minutes (removes traces > 1 hour)
 * - Non-blocking async event broadcast via WebSocket
 */
export class TraceService {
  private traces = new Map<string, TraceSession>();
  private adminSubscribers = new Set<WebSocket>();
  private completedCountToday = 0;
  private errorsCountToday = 0;
  private responseTimes: number[] = [];
  private cacheHitsCount = 0;
  private totalRequestsCount = 0;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Background Auto-Cleanup Task: runs every 5 minutes, removes traces > 1 hour
    this.cleanupInterval = setInterval(() => {
      this.runAutoCleanup();
    }, 5 * 60 * 1000);
  }

  /**
   * Register an admin WebSocket connection for live trace streaming
   */
  public registerSubscriber(ws: WebSocket) {
    this.adminSubscribers.add(ws);
    ws.on('close', () => this.adminSubscribers.delete(ws));
    ws.on('error', () => this.adminSubscribers.delete(ws));

    // Send initial synchronization snapshot of recent active/completed traces
    try {
      if (ws.readyState === WebSocket.OPEN) {
        const recentTraces = Array.from(this.traces.values())
          .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
          .slice(0, 30);

        ws.send(
          JSON.stringify({
            type: 'trace_sync',
            traces: recentTraces,
            metrics: this.getMetrics(),
            server_time: new Date().toISOString(),
          })
        );
      }
    } catch (e) {
      console.warn('[TraceService] Error sending initial sync:', e);
    }
  }

  /**
   * Broadcast real-time trace events to all subscribed admin clients
   */
  public broadcastEvent(event: any) {
    const payload = JSON.stringify({
      ...event,
      server_time: new Date().toISOString(),
    });

    for (const ws of this.adminSubscribers) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(payload);
        } catch (err) {
          this.adminSubscribers.delete(ws);
        }
      } else {
        this.adminSubscribers.delete(ws);
      }
    }

    // Also notify global store broadcast so any connected manager tabs catch it
    store.notifyBroadcast({
      type: 'trace_event',
      event,
    });
  }

  /**
   * Start a new request trace session
   */
  public startTrace(
    projectId: string,
    userRef: string,
    metadata?: { query?: string; projectName?: string }
  ): string {
    const traceId = `trc_${crypto.randomUUID().slice(0, 8)}`;
    const anonymizedUser = this.anonymizeUser(userRef);
    const projectName = metadata?.projectName || store.clients.get(projectId)?.name || projectId;

    const session: TraceSession = {
      trace_id: traceId,
      user_ref: anonymizedUser,
      project_id: projectId,
      project_name: projectName,
      started_at: new Date().toISOString(),
      status: 'running',
      total_steps: 0,
      was_ai_called: false,
      cache_hit: false,
      nodes: [],
      edges: [],
      summary: {
        query_preview: metadata?.query ? this.sanitizePreview(metadata.query) : undefined,
      },
    };

    this.traces.set(traceId, session);
    this.totalRequestsCount++;

    this.broadcastEvent({
      type: 'trace_started',
      trace_id: traceId,
      user_ref: anonymizedUser,
      project_id: projectId,
      project_name: projectName,
      started_at: session.started_at,
      query_preview: session.summary?.query_preview,
    });

    return traceId;
  }

  /**
   * Start a step within a trace session
   */
  public traceStepStart(
    traceId: string,
    stepNumber: number,
    stepName: string,
    stepType: TraceStepType,
    inputSummary?: any
  ) {
    const trace = this.traces.get(traceId);
    if (!trace) return;

    const node: TraceStepNode = {
      step_number: stepNumber,
      step_name: stepName,
      step_type: stepType,
      status: 'running',
      started_at: new Date().toISOString(),
      input_summary: inputSummary ? this.sanitizeSummary(inputSummary) : undefined,
    };

    // Replace if step with same number exists, otherwise push
    const existingIdx = trace.nodes.findIndex((n) => n.step_number === stepNumber);
    if (existingIdx >= 0) {
      trace.nodes[existingIdx] = node;
    } else {
      trace.nodes.push(node);
    }
    trace.total_steps = Math.max(trace.total_steps, stepNumber);

    if (stepType === 'ai') {
      trace.was_ai_called = true;
    }

    this.broadcastEvent({
      type: 'step_started',
      trace_id: traceId,
      step_number: stepNumber,
      step_name: stepName,
      step_type: stepType,
      started_at: node.started_at,
      input_summary: node.input_summary,
    });
  }

  /**
   * Complete a step with duration and output summary
   */
  public traceStepComplete(
    traceId: string,
    stepNumber: number,
    status: 'success' | 'skipped' = 'success',
    durationMs?: number,
    outputSummary?: any
  ) {
    const trace = this.traces.get(traceId);
    if (!trace) return;

    const node = trace.nodes.find((n) => n.step_number === stepNumber);
    if (!node) return;

    const now = new Date().toISOString();
    const duration =
      typeof durationMs === 'number'
        ? durationMs
        : Math.max(1, Date.now() - new Date(node.started_at).getTime());

    node.status = status;
    node.completed_at = now;
    node.duration_ms = duration;
    if (outputSummary) {
      node.output_summary = this.sanitizeSummary(outputSummary);
    }

    if (outputSummary?.cache_hit) {
      trace.cache_hit = true;
      this.cacheHitsCount++;
    }

    this.broadcastEvent({
      type: 'step_completed',
      trace_id: traceId,
      step_number: stepNumber,
      step_name: node.step_name,
      step_type: node.step_type,
      status,
      duration_ms: duration,
      output_summary: node.output_summary,
    });
  }

  /**
   * Record a tool execution step
   */
  public traceToolCalled(
    traceId: string,
    stepNumber: number,
    toolName: string,
    toolType: 'server' | 'client' | 'system' = 'server',
    argsSummary?: any
  ) {
    const trace = this.traces.get(traceId);
    if (!trace) return;

    const node = trace.nodes.find((n) => n.step_number === stepNumber);
    if (node) {
      node.tool_name = toolName;
      node.tool_type = toolType;
      node.args_summary = argsSummary ? this.sanitizeSummary(argsSummary) : undefined;
    }

    this.broadcastEvent({
      type: 'tool_called',
      trace_id: traceId,
      step_number: stepNumber,
      tool_name: toolName,
      tool_type: toolType,
      args_summary: argsSummary ? this.sanitizeSummary(argsSummary) : undefined,
    });
  }

  /**
   * Record a failed step
   */
  public traceStepFailed(
    traceId: string,
    stepNumber: number,
    stepName: string,
    errorMessage: string
  ) {
    const trace = this.traces.get(traceId);
    if (!trace) return;

    let node = trace.nodes.find((n) => n.step_number === stepNumber);
    if (!node) {
      node = {
        step_number: stepNumber,
        step_name: stepName,
        step_type: 'error',
        status: 'failed',
        started_at: new Date().toISOString(),
      };
      trace.nodes.push(node);
    }

    node.status = 'failed';
    node.completed_at = new Date().toISOString();
    node.duration_ms = Math.max(1, Date.now() - new Date(node.started_at).getTime());
    node.error = errorMessage;

    this.broadcastEvent({
      type: 'step_failed',
      trace_id: traceId,
      step_number: stepNumber,
      step_name: stepName,
      error: errorMessage,
    });
  }

  /**
   * Add a directed relationship arrow between two steps
   */
  public traceEdge(
    traceId: string,
    fromStep: number,
    toStep: number,
    edgeType: TraceEdgeType = 'normal',
    label?: string
  ) {
    const trace = this.traces.get(traceId);
    if (!trace) return;

    // Avoid duplicate edges
    const exists = trace.edges.some(
      (e) => e.from_step === fromStep && e.to_step === toStep && e.edge_type === edgeType
    );
    if (!exists) {
      trace.edges.push({ from_step: fromStep, to_step: toStep, edge_type: edgeType, label });
    }

    this.broadcastEvent({
      type: 'edge_created',
      trace_id: traceId,
      from_step: fromStep,
      to_step: toStep,
      edge_type: edgeType,
      label,
    });
  }

  /**
   * Complete the entire request trace session
   */
  public completeTrace(
    traceId: string,
    status: 'success' | 'failed' = 'success',
    durationMs?: number,
    summaryData?: {
      response?: string;
      tokensUsed?: number;
      tokensSaved?: number;
      source?: string;
    }
  ) {
    const trace = this.traces.get(traceId);
    if (!trace) return;

    const now = new Date().toISOString();
    const duration =
      typeof durationMs === 'number'
        ? durationMs
        : Math.max(1, Date.now() - new Date(trace.started_at).getTime());

    trace.status = status === 'success' ? 'completed' : 'failed';
    trace.completed_at = now;
    trace.total_duration_ms = duration;

    if (summaryData) {
      trace.summary = {
        ...trace.summary,
        response_preview: summaryData.response ? this.sanitizePreview(summaryData.response) : undefined,
        tokens_used: summaryData.tokensUsed,
        tokens_saved: summaryData.tokensSaved,
        source: summaryData.source,
      };
    }

    if (status === 'success') {
      this.completedCountToday++;
      this.responseTimes.push(duration);
      if (this.responseTimes.length > 200) this.responseTimes.shift();
    } else {
      this.errorsCountToday++;
    }

    this.broadcastEvent({
      type: 'trace_completed',
      trace_id: traceId,
      status: trace.status,
      total_duration_ms: duration,
      total_steps: trace.nodes.length,
      was_ai_called: trace.was_ai_called,
      summary: trace.summary,
      metrics: this.getMetrics(),
    });
  }

  /**
   * Return aggregated live status metrics for the header/panel
   */
  public getMetrics(projectId?: string): TraceMetrics {
    let active = 0;
    let completed = 0;
    let errors = 0;
    let projectCount = 0;

    for (const t of this.traces.values()) {
      if (projectId && projectId !== 'all' && t.project_id !== projectId) {
        continue;
      }
      projectCount++;
      if (t.status === 'running') active++;
      if (t.status === 'completed') completed++;
      if (t.status === 'failed') errors++;
    }

    const avgTime =
      this.responseTimes.length > 0
        ? Math.round(
            this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length
          )
        : 0;

    const hitRate =
      this.totalRequestsCount > 0
        ? Math.round((this.cacheHitsCount / this.totalRequestsCount) * 100)
        : 0;

    return {
      activeRequests: active,
      completedToday: projectId && projectId !== 'all' ? completed : this.completedCountToday,
      errorsToday: projectId && projectId !== 'all' ? errors : this.errorsCountToday,
      averageResponseTimeMs: avgTime,
      cacheHitRatePercent: Math.min(100, Math.max(0, hitRate)),
      totalTracesInMemory: projectId && projectId !== 'all' ? projectCount : this.traces.size,
    };
  }

  /**
   * Get all in-memory traces with optional filtering
   */
  public getTraces(filters?: {
    projectId?: string;
    status?: string;
    limit?: number;
    search?: string;
  }): TraceSession[] {
    let list = Array.from(this.traces.values());

    if (filters?.projectId && filters.projectId !== 'all') {
      list = list.filter((t) => t.project_id === filters.projectId);
    }

    if (filters?.status && filters.status !== 'all') {
      list = list.filter((t) => t.status === filters.status);
    }

    if (filters?.search) {
      const q = filters.search.toLowerCase();
      list = list.filter(
        (t) =>
          t.trace_id.toLowerCase().includes(q) ||
          t.user_ref.toLowerCase().includes(q) ||
          (t.project_name && t.project_name.toLowerCase().includes(q)) ||
          (t.summary?.query_preview && t.summary.query_preview.toLowerCase().includes(q))
      );
    }

    // Sort newest first
    list.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());

    const limit = filters?.limit || 50;
    return list.slice(0, limit);
  }

  public getTrace(traceId: string): TraceSession | null {
    return this.traces.get(traceId) || null;
  }

  /**
   * Clear in-memory traces (Admin action)
   */
  public clearTraces() {
    this.traces.clear();
    this.broadcastEvent({
      type: 'traces_cleared',
      metrics: this.getMetrics(),
    });
  }

  /**
   * Background Auto-Cleanup: deletes traces whose started_at is older than 1 hour (3600000ms)
   */
  public runAutoCleanup(): number {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    let purged = 0;

    for (const [id, trace] of this.traces.entries()) {
      const startTime = new Date(trace.started_at).getTime();
      if (startTime < oneHourAgo) {
        this.traces.delete(id);
        purged++;
      }
    }

    if (purged > 0) {
      console.log(`[TraceService Auto-Cleanup] Purged ${purged} in-memory traces older than 1 hour.`);
      this.broadcastEvent({
        type: 'traces_purged',
        purged_count: purged,
        remaining_count: this.traces.size,
      });
    }

    return purged;
  }

  /**
   * Anonymize user reference (e.g. req_001 or user_***)
   */
  private anonymizeUser(userRef: string): string {
    if (!userRef || userRef === 'anonymous') return 'Request #1';
    if (userRef.startsWith('req_')) return userRef;
    if (userRef.includes('@')) {
      const parts = userRef.split('@');
      return `${parts[0].slice(0, 2)}***@${parts[1]}`;
    }
    if (userRef.length > 8) {
      return `usr_${userRef.slice(-4)}`;
    }
    return `usr_${userRef}`;
  }

  /**
   * Sanitize text preview to keep UI light & avoid leaking sensitive keys
   */
  private sanitizePreview(text: string): string {
    if (!text) return '';
    // Strip api keys, auth bearer tokens, or passwords if present
    const cleaned = text
      .replace(/Bearer\s+[a-zA-Z0-9_\-\.]+/gi, 'Bearer [REDACTED]')
      .replace(/AIza[0-9A-Za-z-_]{35}/g, '[GEMINI_KEY_REDACTED]')
      .replace(/sk-[a-zA-Z0-9]{32,}/g, '[API_KEY_REDACTED]');
    return cleaned.length > 180 ? cleaned.slice(0, 180) + '...' : cleaned;
  }

  /**
   * Deep sanitize object summaries to prevent serializing circular or huge objects
   */
  private sanitizeSummary(obj: any): any {
    if (!obj) return undefined;
    try {
      const clone = JSON.parse(JSON.stringify(obj));
      return clone;
    } catch {
      return { note: String(obj).slice(0, 120) };
    }
  }

  /**
   * Simulate a realistic multi-step live trace for testing & demonstration
   */
  public async simulateTrace(
    scenario: 'pattern_match' | 'ai_tool' | 'ai_direct' | 'error' = 'ai_tool',
    targetProjectId?: string
  ): Promise<string> {
    const pId = targetProjectId || Array.from(store.clients.keys())[0] || 'default';
    const traceId = this.startTrace(pId, `req_${Math.floor(100 + Math.random() * 900)}`, {
      query: scenario === 'pattern_match'
        ? 'আপনার সাপোর্ট সেন্টারের কাজের সময় কত?'
        : scenario === 'error'
        ? 'Fetch external database user logs'
        : 'অর্ডার #ORD-9842 এর বর্তমান ডেলিভারি স্ট্যাটাস চেক করুন',
    });

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    (async () => {
      try {
        // Step 1: Request Received
        this.traceStepStart(traceId, 1, 'Request Received', 'analysis', { protocol: 'HTTP/2', client_platform: 'web' });
        await sleep(40);
        this.traceStepComplete(traceId, 1, 'success', 40, { status: 'parsed', length: 48 });

        // Step 2: Auth Validated
        this.traceEdge(traceId, 1, 2, 'normal');
        this.traceStepStart(traceId, 2, 'Auth Validated', 'auth', { auth_type: 'Bearer API Key' });
        await sleep(35);
        this.traceStepComplete(traceId, 2, 'success', 35, { client_verified: true, quota_tier: 'enterprise' });

        // Step 3: Rate Limit Check
        this.traceEdge(traceId, 2, 3, 'normal');
        this.traceStepStart(traceId, 3, 'Rate Limit Check', 'ratelimit', { window: '1m', bucket_remaining: 58 });
        await sleep(20);
        this.traceStepComplete(traceId, 3, 'success', 20, { allowed: true });

        // Step 4: Message Analysis
        this.traceEdge(traceId, 3, 4, 'normal');
        this.traceStepStart(traceId, 4, 'Message Analysis', 'analysis', { language: 'bn', intent_detected: 'query' });
        await sleep(65);
        this.traceStepComplete(traceId, 4, 'success', 65, { language: 'bn', sentiment: 'neutral', entities: ['order_id'] });

        // Step 5: User Profile Load
        this.traceEdge(traceId, 4, 5, 'normal');
        this.traceStepStart(traceId, 5, 'User Profile Load', 'profile', { profile_sync: 'relational' });
        await sleep(45);
        this.traceStepComplete(traceId, 5, 'success', 45, { user_new: false, total_interactions: 14 });

        // Step 6: Knowledge Search
        this.traceEdge(traceId, 5, 6, 'normal');
        this.traceStepStart(traceId, 6, 'Knowledge Search', 'knowledge', { vector_similarity: 'enabled' });
        await sleep(80);

        if (scenario === 'pattern_match') {
          this.traceStepComplete(traceId, 6, 'success', 80, { match_found: true, confidence: 0.98, pattern: 'business_hours' });
          // Branch: Pattern Match >= 95%
          this.traceEdge(traceId, 6, 7, 'condition_true', 'Match ≥95% (Yes)');
          this.traceStepStart(traceId, 7, 'Pattern Match Check', 'condition', { confidence: 0.98 });
          await sleep(30);
          this.traceStepComplete(traceId, 7, 'success', 30, { direct_execute: true, zero_api: true });

          // Mark AI Provider Call as Skipped (Bypassed due to Cache Hit)
          this.traceStepStart(traceId, 8, 'AI Provider Call', 'ai', {
            skipped: true,
            reason: 'Cache Hit (≥95% Pattern Match)',
            provider: 'gemini',
            model: 'gemini-2.5-flash',
          });
          this.traceStepComplete(traceId, 8, 'skipped', 0, {
            skipped: true,
            reason: 'Cache Hit (0-API)',
            tokens_saved: 240,
          });

          // Direct Execution via Curved Green Arc
          this.traceEdge(traceId, 7, 15, 'skip', 'Skipped (Cache Hit)');
          this.traceStepStart(traceId, 15, 'Response Generation', 'response', { source: 'knowledge_pattern' });
          await sleep(50);
          this.traceStepComplete(traceId, 15, 'success', 50, { output_text: 'আমাদের সাপোর্ট সেন্টার প্রতিদিন সকাল ৯টা থেকে রাত ১০টা পর্যন্ত খোলা থাকে।' });

          this.traceEdge(traceId, 15, 16, 'normal');
          this.traceStepStart(traceId, 16, 'Response Sent', 'success');
          await sleep(25);
          this.traceStepComplete(traceId, 16, 'success', 25, { delivered: true });

          this.completeTrace(traceId, 'success', 365, {
            response: 'আমাদের সাপোর্ট সেন্টার প্রতিদিন সকাল ৯টা থেকে রাত ১০টা পর্যন্ত খোলা থাকে।',
            tokensUsed: 0,
            tokensSaved: 240,
            source: 'knowledge',
          });
          return;
        }

        if (scenario === 'error') {
          this.traceStepComplete(traceId, 6, 'success', 80, { match_found: false, confidence: 0.42 });
          this.traceEdge(traceId, 6, 7, 'condition_false', 'Match <95% (No)');
          this.traceStepStart(traceId, 7, 'Pattern Match Check', 'condition', { confidence: 0.42 });
          await sleep(30);
          this.traceStepComplete(traceId, 7, 'success', 30, { fallback_to_ai: true });

          this.traceEdge(traceId, 7, 8, 'ai_call', 'AI Fallback');
          this.traceStepStart(traceId, 8, 'AI Provider Call', 'ai', { provider: 'gemini', model: 'gemini-3.8-flash' });
          await sleep(150);
          this.traceStepFailed(traceId, 8, 'AI Provider Call', 'Connection timeout after 15s to remote endpoint');

          this.completeTrace(traceId, 'failed', 420);
          return;
        }

        // Scenario: ai_tool
        this.traceStepComplete(traceId, 6, 'success', 80, { match_found: false, confidence: 0.61 });
        this.traceEdge(traceId, 6, 7, 'condition_false', 'Match <95% (No)');
        this.traceStepStart(traceId, 7, 'Pattern Match Check', 'condition', { confidence: 0.61 });
        await sleep(30);
        this.traceStepComplete(traceId, 7, 'success', 30, { proceed_to_ai: true });

        // Step 8: AI Provider Call
        this.traceEdge(traceId, 7, 8, 'ai_call', 'Call Gemini');
        this.traceStepStart(traceId, 8, 'AI Provider Call', 'ai', { provider: 'gemini', model: 'gemini-3.8-flash' });
        await sleep(180);
        this.traceStepComplete(traceId, 8, 'success', 180, { tool_plan_generated: true, function_call: 'get_order_status' });

        // Step 10: Tool Sequence Plan
        this.traceEdge(traceId, 8, 10, 'normal');
        this.traceStepStart(traceId, 10, 'Tool Sequence Plan', 'tool', { planned_tools: ['get_order_status'] });
        await sleep(40);
        this.traceStepComplete(traceId, 10, 'success', 40, { executable: true });

        // Step 11: Missing Input Check
        this.traceEdge(traceId, 10, 11, 'condition_true', 'Inputs Present');
        this.traceStepStart(traceId, 11, 'Missing Input Check', 'condition', { required: ['order_id'], found: ['order_id'] });
        await sleep(25);
        this.traceStepComplete(traceId, 11, 'success', 25, { all_inputs_available: true });

        // Step 12: Tool Execution
        this.traceEdge(traceId, 11, 12, 'tool_call', 'Execute Tool');
        this.traceStepStart(traceId, 12, 'Tool: get_order_status', 'tool', { order_id: 'ORD-9842' });
        this.traceToolCalled(traceId, 12, 'get_order_status', 'server', { order_id: 'ORD-9842' });
        await sleep(120);
        this.traceStepComplete(traceId, 12, 'success', 120, { status: 'Out for Delivery', courier: 'Steadfast', eta: 'Today 4:00 PM' });

        // Step 13: Tool Result Processing
        this.traceEdge(traceId, 12, 13, 'normal');
        this.traceStepStart(traceId, 13, 'Tool Result Processing', 'analysis');
        await sleep(35);
        this.traceStepComplete(traceId, 13, 'success', 35, { formatted: true });

        // Step 15: Response Generation
        this.traceEdge(traceId, 13, 15, 'normal');
        this.traceStepStart(traceId, 15, 'Response Generation', 'response', { provider: 'gemini' });
        await sleep(110);
        this.traceStepComplete(traceId, 15, 'success', 110, {
          output_text: 'আপনার অর্ডার #ORD-9842 বর্তমানে ডেলিভারির জন্য বের হয়েছে। আনুমানিক ডেলিভারি সময় আজ বিকাল ৪:০০ টা।',
        });

        // Step 16: Response Sent
        this.traceEdge(traceId, 15, 16, 'normal');
        this.traceStepStart(traceId, 16, 'Response Sent', 'success');
        await sleep(20);
        this.traceStepComplete(traceId, 16, 'success', 20, { latency_total_ms: 780 });

        // Step 17: Learning Save
        this.traceEdge(traceId, 16, 17, 'normal');
        this.traceStepStart(traceId, 17, 'Learning Save', 'learning', { candidate: 'order_status_query' });
        await sleep(30);
        this.traceStepComplete(traceId, 17, 'success', 30, { skill_synthesized: false });

        this.completeTrace(traceId, 'success', 810, {
          response: 'আপনার অর্ডার #ORD-9842 বর্তমানে ডেলিভারির জন্য বের হয়েছে। আনুমানিক ডেলিভারি সময় আজ বিকাল ৪:০০ টা।',
          tokensUsed: 148,
          tokensSaved: 0,
          source: 'tool',
        });
      } catch (simErr: any) {
        this.completeTrace(traceId, 'failed', 500);
      }
    })();

    return traceId;
  }
}

export const traceService = new TraceService();
