/**
 * SQLite-backed storage for agent observability data.
 * All exported function signatures are identical to the original in-memory version.
 * DB is managed by src/db.js — WAL mode, indexes on session_id.
 */

import { stmts } from './db.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateTraceId() {
  return `tr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Ensure a session row exists. Returns the session row.
 */
function ensureSession(sessionId) {
  let row = stmts.getSession.get(sessionId);
  if (!row) {
    const now = new Date().toISOString();
    stmts.insertSession.run(sessionId, now, now);
    row = stmts.getSession.get(sessionId);
  }
  return row;
}

function updateActivity(sessionId, timestamp) {
  stmts.updateLastActivity.run(timestamp, sessionId);
}

// ─── Trace operations ─────────────────────────────────────────────────────────

export function addTrace(sessionId, trace) {
  ensureSession(sessionId);

  const traceId = generateTraceId();
  const timestamp = trace.timestamp || new Date().toISOString();

  const entry = {
    trace_id: traceId,
    session_id: sessionId,
    action_type: trace.action_type,
    tool_name: trace.tool_name,
    description: trace.description,
    metadata: trace.metadata || {},
    timestamp,
  };

  stmts.insertTrace.run(traceId, sessionId, timestamp, JSON.stringify(entry));
  updateActivity(sessionId, timestamp);

  return entry;
}

// ─── Token usage operations ───────────────────────────────────────────────────

export function addTokenUsage(sessionId, usage) {
  ensureSession(sessionId);

  const cost =
    usage.input_tokens * usage.cost_per_input_token +
    usage.output_tokens * usage.cost_per_output_token;

  const timestamp = new Date().toISOString();

  stmts.insertTokenCall.run(
    sessionId,
    usage.model,
    usage.provider,
    usage.input_tokens,
    usage.output_tokens,
    cost,
    timestamp
  );

  updateActivity(sessionId, timestamp);

  // Compute running session total from DB
  const allCalls = stmts.getTokenCallsBySession.all(sessionId);
  const runningTotal = allCalls.reduce((sum, r) => sum + r.cost, 0);

  return {
    cost,
    running_session_total: runningTotal,
    model_breakdown: _getModelBreakdown(sessionId),
  };
}

function _getModelBreakdown(sessionId) {
  const calls = stmts.getTokenCallsBySession.all(sessionId);
  const breakdown = {};
  for (const call of calls) {
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

// ─── Tool call operations ─────────────────────────────────────────────────────

export function addToolCall(sessionId, call) {
  ensureSession(sessionId);

  const timestamp = new Date().toISOString();

  stmts.insertToolCall.run(
    sessionId,
    call.server_name,
    call.tool_name,
    JSON.stringify(call.params || {}),
    call.result_summary || null,
    call.latency_ms,
    call.success ? 1 : 0,
    call.error || null,
    timestamp
  );

  updateActivity(sessionId, timestamp);

  // Compute stats from DB
  const allCalls = stmts.getToolCallsBySession.all(sessionId);
  const total = allCalls.length;
  const successes = allCalls.filter(c => c.success === 1).length;
  const failures = total - successes;
  const totalLatency = allCalls.reduce((sum, c) => sum + c.latency_ms, 0);

  return {
    tool_call_count: total,
    success_rate:
      total > 0
        ? ((successes / total) * 100).toFixed(1) + '%'
        : 'N/A',
    avg_latency_ms: total > 0 ? Math.round(totalLatency / total) : 0,
  };
}

// ─── Session summary ──────────────────────────────────────────────────────────

export function getSessionSummary(sessionId) {
  const session = ensureSession(sessionId);

  const traces = stmts.getTracesBySession.all(sessionId).map(r => JSON.parse(r.data_json));
  const tokenCalls = stmts.getTokenCallsBySession.all(sessionId);
  const toolCalls = stmts.getToolCallsBySession.all(sessionId);

  // Token totals
  const totalInputTokens = tokenCalls.reduce((s, r) => s + r.input_tokens, 0);
  const totalOutputTokens = tokenCalls.reduce((s, r) => s + r.output_tokens, 0);
  const totalCost = tokenCalls.reduce((s, r) => s + r.cost, 0);

  // Tool stats
  const totalToolCalls = toolCalls.length;
  const toolSuccesses = toolCalls.filter(c => c.success === 1).length;
  const toolFailures = totalToolCalls - toolSuccesses;
  const totalToolLatency = toolCalls.reduce((s, c) => s + c.latency_ms, 0);

  // Tool breakdown by server/tool key
  const toolBreakdown = {};
  for (const call of toolCalls) {
    const key = `${call.server_name}/${call.tool_name}`;
    if (!toolBreakdown[key]) {
      toolBreakdown[key] = { calls: 0, successes: 0, failures: 0, avg_latency_ms: 0, total_latency: 0 };
    }
    toolBreakdown[key].calls++;
    if (call.success === 1) toolBreakdown[key].successes++;
    else toolBreakdown[key].failures++;
    toolBreakdown[key].total_latency += call.latency_ms;
  }
  for (const key of Object.keys(toolBreakdown)) {
    toolBreakdown[key].avg_latency_ms = Math.round(
      toolBreakdown[key].total_latency / toolBreakdown[key].calls
    );
    delete toolBreakdown[key].total_latency;
  }

  // Error count: error-type traces + failed tool calls
  const errorTraces = traces.filter(t => t.action_type === 'error');
  const errorCount = errorTraces.length + toolFailures;

  // Duration
  const hasActivity = traces.length > 0 || tokenCalls.length > 0 || toolCalls.length > 0;
  const durationMs = hasActivity
    ? new Date(session.last_activity) - new Date(session.created_at)
    : 0;

  return {
    session_id: sessionId,
    created_at: session.created_at,
    last_activity: session.last_activity,
    duration_seconds: Math.round(durationMs / 1000),
    total_cost: parseFloat(totalCost.toFixed(6)),
    total_input_tokens: totalInputTokens,
    total_output_tokens: totalOutputTokens,
    total_tokens: totalInputTokens + totalOutputTokens,
    total_llm_calls: tokenCalls.length,
    total_tool_calls: totalToolCalls,
    tool_success_rate:
      totalToolCalls > 0
        ? ((toolSuccesses / totalToolCalls) * 100).toFixed(1) + '%'
        : 'N/A',
    avg_tool_latency_ms:
      totalToolCalls > 0 ? Math.round(totalToolLatency / totalToolCalls) : 0,
    total_traces: traces.length,
    error_count: errorCount,
    model_breakdown: _getModelBreakdown(sessionId),
    tool_breakdown: toolBreakdown,
  };
}

// ─── Anomaly detection ────────────────────────────────────────────────────────

export function detectAnomalies(sessionId, checkTypes) {
  ensureSession(sessionId);

  const tokenCalls = stmts.getTokenCallsBySession.all(sessionId);
  const toolCalls = stmts.getToolCallsBySession.all(sessionId);

  const totalCost = tokenCalls.reduce((s, r) => s + r.cost, 0);
  const totalToolCalls = toolCalls.length;
  const toolFailures = toolCalls.filter(c => c.success === 0).length;

  const anomalies = [];

  for (const check of checkTypes) {
    switch (check) {
      case 'cost_spike': {
        if (totalCost > 1.0) {
          anomalies.push({
            type: 'cost_spike',
            severity: totalCost > 5.0 ? 'critical' : 'warning',
            message: `Session cost $${totalCost.toFixed(4)} exceeds threshold`,
            value: totalCost,
            threshold: 1.0,
          });
        }
        for (const call of tokenCalls) {
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
        if (totalToolCalls >= 3) {
          const errorRate = toolFailures / totalToolCalls;
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
        const slowCalls = toolCalls.filter(c => c.latency_ms > 10000);
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
        // Use last 20 tool calls — same params means same JSON signature
        const recent = toolCalls.slice(-20);
        const signatures = recent.map(
          c => `${c.server_name}/${c.tool_name}:${c.params_json || '{}'}`
        );
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
        for (const call of tokenCalls) {
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
        const sessionTotal = tokenCalls.reduce(
          (s, c) => s + c.input_tokens + c.output_tokens,
          0
        );
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

// ─── Cost report across sessions ──────────────────────────────────────────────

export function getCostReport({ sessionIds, timeRange, groupBy }) {
  // Build the full set of calls across requested sessions
  let allCalls = [];

  if (sessionIds && sessionIds.length > 0) {
    for (const sid of sessionIds) {
      const rows = stmts.getTokenCallsBySession.all(sid);
      allCalls.push(...rows.map(r => ({ ...r })));
    }
  } else {
    // All sessions
    const allSessions = stmts.listSessions.all().map(r => r.session_id);
    for (const sid of allSessions) {
      const rows = stmts.getTokenCallsBySession.all(sid);
      allCalls.push(...rows.map(r => ({ ...r })));
    }
  }

  // Time range filter
  if (timeRange) {
    allCalls = allCalls.filter(call => {
      const ts = new Date(call.timestamp);
      if (timeRange.start && ts < new Date(timeRange.start)) return false;
      if (timeRange.end && ts > new Date(timeRange.end)) return false;
      return true;
    });
  }

  // Group
  const groups = {};
  for (const call of allCalls) {
    let key;
    switch (groupBy) {
      case 'model':    key = call.model; break;
      case 'provider': key = call.provider; break;
      case 'session':  key = call.session_id; break;
      case 'tool':     key = 'llm_call'; break;
      default:         key = call.model;
    }
    if (!groups[key]) {
      groups[key] = { calls: 0, input_tokens: 0, output_tokens: 0, cost: 0 };
    }
    groups[key].calls++;
    groups[key].input_tokens += call.input_tokens;
    groups[key].output_tokens += call.output_tokens;
    groups[key].cost += call.cost;
  }

  for (const key of Object.keys(groups)) {
    groups[key].cost = parseFloat(groups[key].cost.toFixed(6));
  }

  const totalCost = allCalls.reduce((sum, c) => sum + c.cost, 0);
  const totalTokens = allCalls.reduce((sum, c) => sum + c.input_tokens + c.output_tokens, 0);

  const targetSessions = sessionIds || stmts.listSessions.all().map(r => r.session_id);

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

// ─── List all session IDs (for admin) ────────────────────────────────────────

export function listSessions() {
  return stmts.listSessions.all().map(r => r.session_id);
}
