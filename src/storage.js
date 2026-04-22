/**
 * In-memory storage for agent observability data.
 * Structured for easy swap to Redis/Postgres in v2.
 */

// Session traces: session_id -> { traces: [], created_at, last_activity }
const sessions = new Map();

// Token usage: session_id -> { calls: [], totals: { input_tokens, output_tokens, cost } }
const tokenUsage = new Map();

// Tool calls: session_id -> { calls: [], stats: { total, successes, failures, avg_latency } }
const toolCalls = new Map();

/**
 * Get or create a session container.
 */
function ensureSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      traces: [],
      created_at: new Date().toISOString(),
      last_activity: new Date().toISOString(),
    });
  }
  if (!tokenUsage.has(sessionId)) {
    tokenUsage.set(sessionId, {
      calls: [],
      totals: { input_tokens: 0, output_tokens: 0, cost: 0 },
    });
  }
  if (!toolCalls.has(sessionId)) {
    toolCalls.set(sessionId, {
      calls: [],
      stats: { total: 0, successes: 0, failures: 0, total_latency: 0 },
    });
  }
  return {
    session: sessions.get(sessionId),
    tokens: tokenUsage.get(sessionId),
    tools: toolCalls.get(sessionId),
  };
}

function generateTraceId() {
  return `tr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// --- Trace operations ---

export function addTrace(sessionId, trace) {
  const { session } = ensureSession(sessionId);
  const traceId = generateTraceId();
  const entry = {
    trace_id: traceId,
    session_id: sessionId,
    ...trace,
    timestamp: trace.timestamp || new Date().toISOString(),
  };
  session.traces.push(entry);
  session.last_activity = entry.timestamp;
  return entry;
}

// --- Token usage operations ---

export function addTokenUsage(sessionId, usage) {
  const { tokens } = ensureSession(sessionId);
  const cost = (usage.input_tokens * usage.cost_per_input_token) +
    (usage.output_tokens * usage.cost_per_output_token);

  const entry = {
    session_id: sessionId,
    model: usage.model,
    provider: usage.provider,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cost,
    timestamp: new Date().toISOString(),
  };

  tokens.calls.push(entry);
  tokens.totals.input_tokens += usage.input_tokens;
  tokens.totals.output_tokens += usage.output_tokens;
  tokens.totals.cost += cost;

  // Update session last_activity
  const { session } = ensureSession(sessionId);
  session.last_activity = entry.timestamp;

  return {
    cost,
    running_session_total: tokens.totals.cost,
    model_breakdown: getModelBreakdown(sessionId),
  };
}

function getModelBreakdown(sessionId) {
  const { tokens } = ensureSession(sessionId);
  const breakdown = {};
  for (const call of tokens.calls) {
    if (!breakdown[call.model]) {
      breakdown[call.model] = { calls: 0, input_tokens: 0, output_tokens: 0, cost: 0 };
    }
    breakdown[call.model].calls++;
    breakdown[call.model].input_tokens += call.input_tokens;
    breakdown[call.model].output_tokens += call.output_tokens;
    breakdown[call.model].cost += call.cost;
  }
  return breakdown;
}

// --- Tool call operations ---

export function addToolCall(sessionId, call) {
  const { tools, session } = ensureSession(sessionId);
  const entry = {
    session_id: sessionId,
    ...call,
    timestamp: new Date().toISOString(),
  };

  tools.calls.push(entry);
  tools.stats.total++;
  if (call.success) tools.stats.successes++;
  else tools.stats.failures++;
  tools.stats.total_latency += call.latency_ms;

  session.last_activity = entry.timestamp;

  return {
    tool_call_count: tools.stats.total,
    success_rate: tools.stats.total > 0
      ? (tools.stats.successes / tools.stats.total * 100).toFixed(1) + '%'
      : 'N/A',
    avg_latency_ms: tools.stats.total > 0
      ? Math.round(tools.stats.total_latency / tools.stats.total)
      : 0,
  };
}

// --- Session summary ---

export function getSessionSummary(sessionId) {
  const { session, tokens, tools } = ensureSession(sessionId);

  const toolBreakdown = {};
  for (const call of tools.calls) {
    const key = `${call.server_name}/${call.tool_name}`;
    if (!toolBreakdown[key]) {
      toolBreakdown[key] = { calls: 0, successes: 0, failures: 0, avg_latency_ms: 0, total_latency: 0 };
    }
    toolBreakdown[key].calls++;
    if (call.success) toolBreakdown[key].successes++;
    else toolBreakdown[key].failures++;
    toolBreakdown[key].total_latency += call.latency_ms;
  }
  for (const key of Object.keys(toolBreakdown)) {
    toolBreakdown[key].avg_latency_ms = Math.round(
      toolBreakdown[key].total_latency / toolBreakdown[key].calls
    );
    delete toolBreakdown[key].total_latency;
  }

  const errors = [
    ...session.traces.filter(t => t.action_type === 'error'),
    ...tools.calls.filter(c => !c.success),
  ];

  const durationMs = session.traces.length > 0 || tokens.calls.length > 0 || tools.calls.length > 0
    ? new Date(session.last_activity) - new Date(session.created_at)
    : 0;

  return {
    session_id: sessionId,
    created_at: session.created_at,
    last_activity: session.last_activity,
    duration_seconds: Math.round(durationMs / 1000),
    total_cost: parseFloat(tokens.totals.cost.toFixed(6)),
    total_input_tokens: tokens.totals.input_tokens,
    total_output_tokens: tokens.totals.output_tokens,
    total_tokens: tokens.totals.input_tokens + tokens.totals.output_tokens,
    total_llm_calls: tokens.calls.length,
    total_tool_calls: tools.stats.total,
    tool_success_rate: tools.stats.total > 0
      ? (tools.stats.successes / tools.stats.total * 100).toFixed(1) + '%'
      : 'N/A',
    avg_tool_latency_ms: tools.stats.total > 0
      ? Math.round(tools.stats.total_latency / tools.stats.total)
      : 0,
    total_traces: session.traces.length,
    error_count: errors.length,
    model_breakdown: getModelBreakdown(sessionId),
    tool_breakdown: toolBreakdown,
  };
}

// --- Anomaly detection ---

export function detectAnomalies(sessionId, checkTypes) {
  const { session, tokens, tools } = ensureSession(sessionId);
  const anomalies = [];

  for (const check of checkTypes) {
    switch (check) {
      case 'cost_spike': {
        if (tokens.totals.cost > 1.0) {
          anomalies.push({
            type: 'cost_spike',
            severity: tokens.totals.cost > 5.0 ? 'critical' : 'warning',
            message: `Session cost $${tokens.totals.cost.toFixed(4)} exceeds threshold`,
            value: tokens.totals.cost,
            threshold: 1.0,
          });
        }
        // Check for individual expensive calls
        for (const call of tokens.calls) {
          if (call.cost > 0.5) {
            anomalies.push({
              type: 'cost_spike',
              severity: 'warning',
              message: `Single LLM call cost $${call.cost.toFixed(4)} (model: ${call.model})`,
              value: call.cost,
              threshold: 0.5,
            });
          }
        }
        break;
      }

      case 'error_rate': {
        if (tools.stats.total >= 3) {
          const errorRate = tools.stats.failures / tools.stats.total;
          if (errorRate > 0.3) {
            anomalies.push({
              type: 'error_rate',
              severity: errorRate > 0.6 ? 'critical' : 'warning',
              message: `Tool error rate ${(errorRate * 100).toFixed(0)}% exceeds 30% threshold`,
              value: errorRate,
              threshold: 0.3,
            });
          }
        }
        break;
      }

      case 'latency_spike': {
        const slowCalls = tools.calls.filter(c => c.latency_ms > 10000);
        if (slowCalls.length > 0) {
          anomalies.push({
            type: 'latency_spike',
            severity: slowCalls.some(c => c.latency_ms > 30000) ? 'critical' : 'warning',
            message: `${slowCalls.length} tool call(s) exceeded 10s latency`,
            slow_calls: slowCalls.map(c => ({
              tool: `${c.server_name}/${c.tool_name}`,
              latency_ms: c.latency_ms,
            })),
            threshold_ms: 10000,
          });
        }
        break;
      }

      case 'loop_detection': {
        // Detect repeated tool calls with same params
        const recent = tools.calls.slice(-20);
        const signatures = recent.map(c => `${c.server_name}/${c.tool_name}:${JSON.stringify(c.params)}`);
        const counts = {};
        for (const sig of signatures) {
          counts[sig] = (counts[sig] || 0) + 1;
        }
        const loops = Object.entries(counts).filter(([, n]) => n >= 3);
        if (loops.length > 0) {
          anomalies.push({
            type: 'loop_detection',
            severity: loops.some(([, n]) => n >= 5) ? 'critical' : 'warning',
            message: `Detected ${loops.length} repeated tool call pattern(s)`,
            repeated_patterns: loops.map(([sig, count]) => ({
              pattern: sig.split(':')[0],
              repetitions: count,
            })),
          });
        }
        break;
      }

      case 'token_explosion': {
        // Check if any single call used excessive tokens
        for (const call of tokens.calls) {
          const totalTokens = call.input_tokens + call.output_tokens;
          if (totalTokens > 100000) {
            anomalies.push({
              type: 'token_explosion',
              severity: totalTokens > 500000 ? 'critical' : 'warning',
              message: `Single call used ${totalTokens.toLocaleString()} tokens (model: ${call.model})`,
              value: totalTokens,
              threshold: 100000,
            });
          }
        }
        // Check session total
        const sessionTotal = tokens.totals.input_tokens + tokens.totals.output_tokens;
        if (sessionTotal > 500000) {
          anomalies.push({
            type: 'token_explosion',
            severity: sessionTotal > 2000000 ? 'critical' : 'warning',
            message: `Session total ${sessionTotal.toLocaleString()} tokens exceeds threshold`,
            value: sessionTotal,
            threshold: 500000,
          });
        }
        break;
      }
    }
  }

  return {
    session_id: sessionId,
    checks_performed: checkTypes,
    anomalies_found: anomalies.length,
    anomalies,
    checked_at: new Date().toISOString(),
  };
}

// --- Cost report across sessions ---

export function getCostReport({ sessionIds, timeRange, groupBy }) {
  const targetSessions = sessionIds || [...tokenUsage.keys()];
  const allCalls = [];

  for (const sid of targetSessions) {
    if (!tokenUsage.has(sid)) continue;
    const { calls } = tokenUsage.get(sid);
    for (const call of calls) {
      if (timeRange) {
        const ts = new Date(call.timestamp);
        if (timeRange.start && ts < new Date(timeRange.start)) continue;
        if (timeRange.end && ts > new Date(timeRange.end)) continue;
      }
      allCalls.push({ ...call, session_id: sid });
    }
  }

  const groups = {};
  for (const call of allCalls) {
    let key;
    switch (groupBy) {
      case 'model': key = call.model; break;
      case 'provider': key = call.provider; break;
      case 'session': key = call.session_id; break;
      case 'tool': key = 'llm_call'; break;  // token usage is always LLM
      default: key = call.model;
    }
    if (!groups[key]) {
      groups[key] = { calls: 0, input_tokens: 0, output_tokens: 0, cost: 0 };
    }
    groups[key].calls++;
    groups[key].input_tokens += call.input_tokens;
    groups[key].output_tokens += call.output_tokens;
    groups[key].cost += call.cost;
  }

  // Round costs
  for (const key of Object.keys(groups)) {
    groups[key].cost = parseFloat(groups[key].cost.toFixed(6));
  }

  const totalCost = allCalls.reduce((sum, c) => sum + c.cost, 0);
  const totalTokens = allCalls.reduce((sum, c) => sum + c.input_tokens + c.output_tokens, 0);

  return {
    group_by: groupBy,
    sessions_analyzed: targetSessions.length,
    total_calls: allCalls.length,
    total_cost: parseFloat(totalCost.toFixed(6)),
    total_tokens: totalTokens,
    breakdown: groups,
    generated_at: new Date().toISOString(),
  };
}

// --- List all session IDs (for admin) ---

export function listSessions() {
  return [...sessions.keys()];
}
