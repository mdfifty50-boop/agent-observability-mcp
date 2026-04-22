/**
 * Tests for storage.js — the core in-memory observability data layer.
 * Uses node:test and node:assert/strict (no npm deps).
 *
 * NOTE: Each test uses a unique session_id to avoid cross-test contamination
 * since the module holds global in-memory state.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  addTrace,
  addTokenUsage,
  addToolCall,
  getSessionSummary,
  detectAnomalies,
  getCostReport,
  listSessions,
} from './storage.js';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

let _uid = 0;
function uid(prefix = 'sess') {
  return `${prefix}_${++_uid}_${Date.now()}`;
}

// ─────────────────────────────────────────────
// addTrace
// ─────────────────────────────────────────────

describe('addTrace', () => {
  test('returns an entry with a trace_id and session_id', () => {
    const sid = uid();
    const entry = addTrace(sid, {
      action_type: 'tool_call',
      description: 'Called search tool',
    });

    assert.ok(entry.trace_id.startsWith('tr_'), 'trace_id should start with tr_');
    assert.equal(entry.session_id, sid);
    assert.equal(entry.action_type, 'tool_call');
    assert.equal(entry.description, 'Called search tool');
    assert.ok(typeof entry.timestamp === 'string', 'timestamp should be a string');
  });

  test('uses provided timestamp when supplied', () => {
    const sid = uid();
    const ts = '2026-01-15T10:00:00.000Z';
    const entry = addTrace(sid, {
      action_type: 'decision',
      description: 'Route to department A',
      timestamp: ts,
    });

    assert.equal(entry.timestamp, ts);
  });

  test('auto-generates timestamp when not supplied', () => {
    const sid = uid();
    const before = new Date().toISOString();
    const entry = addTrace(sid, {
      action_type: 'llm_request',
      description: 'GPT call',
    });
    const after = new Date().toISOString();

    assert.ok(entry.timestamp >= before);
    assert.ok(entry.timestamp <= after);
  });

  test('each trace gets a unique trace_id', () => {
    const sid = uid();
    const a = addTrace(sid, { action_type: 'error', description: 'A' });
    const b = addTrace(sid, { action_type: 'error', description: 'B' });
    assert.notEqual(a.trace_id, b.trace_id);
  });

  test('metadata passthrough', () => {
    const sid = uid();
    const entry = addTrace(sid, {
      action_type: 'tool_call',
      tool_name: 'search',
      description: 'Search op',
      metadata: { query: 'Kuwait weather', limit: 10 },
    });
    assert.deepEqual(entry.metadata, { query: 'Kuwait weather', limit: 10 });
    assert.equal(entry.tool_name, 'search');
  });
});

// ─────────────────────────────────────────────
// addTokenUsage
// ─────────────────────────────────────────────

describe('addTokenUsage', () => {
  test('calculates cost correctly from explicit per-token costs', () => {
    const sid = uid();
    const result = addTokenUsage(sid, {
      model: 'claude-sonnet-4',
      provider: 'anthropic',
      input_tokens: 1000,
      output_tokens: 500,
      cost_per_input_token: 0.000003,
      cost_per_output_token: 0.000015,
    });

    // 1000 * 0.000003 + 500 * 0.000015 = 0.003 + 0.0075 = 0.0105
    assert.ok(Math.abs(result.cost - 0.0105) < 1e-9, `Expected 0.0105, got ${result.cost}`);
    assert.ok(Math.abs(result.running_session_total - 0.0105) < 1e-9);
  });

  test('running_session_total accumulates across multiple calls', () => {
    const sid = uid();

    const r1 = addTokenUsage(sid, {
      model: 'claude-haiku-4',
      provider: 'anthropic',
      input_tokens: 100,
      output_tokens: 50,
      cost_per_input_token: 0.0000008,
      cost_per_output_token: 0.000004,
    });
    // 100*0.0000008 + 50*0.000004 = 0.00008 + 0.0002 = 0.00028
    const cost1 = 0.00028;
    assert.ok(Math.abs(r1.cost - cost1) < 1e-9, `r1.cost: expected ${cost1}, got ${r1.cost}`);

    const r2 = addTokenUsage(sid, {
      model: 'claude-sonnet-4',
      provider: 'anthropic',
      input_tokens: 200,
      output_tokens: 100,
      cost_per_input_token: 0.000003,
      cost_per_output_token: 0.000015,
    });
    // 200*0.000003 + 100*0.000015 = 0.0006 + 0.0015 = 0.0021
    const cost2 = 0.0021;
    assert.ok(Math.abs(r2.cost - cost2) < 1e-9, `r2.cost: expected ${cost2}, got ${r2.cost}`);
    assert.ok(Math.abs(r2.running_session_total - (cost1 + cost2)) < 1e-9,
      `running_session_total: expected ${cost1 + cost2}, got ${r2.running_session_total}`);
  });

  test('model_breakdown tracks per-model stats', () => {
    const sid = uid();

    addTokenUsage(sid, {
      model: 'gpt-4o',
      provider: 'openai',
      input_tokens: 300,
      output_tokens: 100,
      cost_per_input_token: 0.0000025,
      cost_per_output_token: 0.00001,
    });

    addTokenUsage(sid, {
      model: 'gpt-4o',
      provider: 'openai',
      input_tokens: 200,
      output_tokens: 80,
      cost_per_input_token: 0.0000025,
      cost_per_output_token: 0.00001,
    });

    addTokenUsage(sid, {
      model: 'gpt-4o-mini',
      provider: 'openai',
      input_tokens: 500,
      output_tokens: 200,
      cost_per_input_token: 0.00000015,
      cost_per_output_token: 0.0000006,
    });

    const result = addTokenUsage(sid, {
      model: 'gpt-4o',
      provider: 'openai',
      input_tokens: 100,
      output_tokens: 50,
      cost_per_input_token: 0.0000025,
      cost_per_output_token: 0.00001,
    });

    const bd = result.model_breakdown;
    assert.ok('gpt-4o' in bd, 'gpt-4o should appear in breakdown');
    assert.ok('gpt-4o-mini' in bd, 'gpt-4o-mini should appear in breakdown');
    assert.equal(bd['gpt-4o'].calls, 3);
    assert.equal(bd['gpt-4o-mini'].calls, 1);
    assert.equal(bd['gpt-4o'].input_tokens, 300 + 200 + 100);
    assert.equal(bd['gpt-4o'].output_tokens, 100 + 80 + 50);
  });

  test('zero cost for local model', () => {
    const sid = uid();
    const result = addTokenUsage(sid, {
      model: 'local-model',
      provider: 'local',
      input_tokens: 50000,
      output_tokens: 20000,
      cost_per_input_token: 0,
      cost_per_output_token: 0,
    });
    assert.equal(result.cost, 0);
    assert.equal(result.running_session_total, 0);
  });
});

// ─────────────────────────────────────────────
// addToolCall
// ─────────────────────────────────────────────

describe('addToolCall', () => {
  test('tracks total, successes, failures, and latency', () => {
    const sid = uid();

    const s1 = addToolCall(sid, {
      server_name: 'search-mcp',
      tool_name: 'web_search',
      params: { query: 'AI news' },
      latency_ms: 350,
      success: true,
    });
    assert.equal(s1.tool_call_count, 1);
    assert.equal(s1.success_rate, '100.0%');
    assert.equal(s1.avg_latency_ms, 350);

    const s2 = addToolCall(sid, {
      server_name: 'search-mcp',
      tool_name: 'web_search',
      params: { query: 'GCC market' },
      latency_ms: 650,
      success: false,
      error: 'Timeout',
    });
    assert.equal(s2.tool_call_count, 2);
    assert.equal(s2.success_rate, '50.0%');
    assert.equal(s2.avg_latency_ms, Math.round((350 + 650) / 2));
  });

  test('100% success rate with all successes', () => {
    const sid = uid();
    for (let i = 0; i < 5; i++) {
      addToolCall(sid, {
        server_name: 'fs-mcp',
        tool_name: 'read_file',
        params: { path: `/tmp/file${i}` },
        latency_ms: 10,
        success: true,
      });
    }
    const stats = addToolCall(sid, {
      server_name: 'fs-mcp',
      tool_name: 'write_file',
      params: { path: '/tmp/out' },
      latency_ms: 20,
      success: true,
    });
    assert.equal(stats.success_rate, '100.0%');
    assert.equal(stats.tool_call_count, 6);
  });

  test('avg_latency_ms rounds correctly', () => {
    const sid = uid();
    addToolCall(sid, { server_name: 's', tool_name: 't', params: {}, latency_ms: 100, success: true });
    addToolCall(sid, { server_name: 's', tool_name: 't', params: {}, latency_ms: 101, success: true });
    const r = addToolCall(sid, { server_name: 's', tool_name: 't', params: {}, latency_ms: 102, success: true });
    // avg = (100+101+102)/3 = 101
    assert.equal(r.avg_latency_ms, 101);
  });
});

// ─────────────────────────────────────────────
// getSessionSummary
// ─────────────────────────────────────────────

describe('getSessionSummary', () => {
  test('returns correct totals after mixed operations', () => {
    const sid = uid();

    addTrace(sid, { action_type: 'decision', description: 'Route to search' });
    addTrace(sid, { action_type: 'tool_call', description: 'Run web search' });

    addTokenUsage(sid, {
      model: 'claude-sonnet-4',
      provider: 'anthropic',
      input_tokens: 1000,
      output_tokens: 400,
      cost_per_input_token: 0.000003,
      cost_per_output_token: 0.000015,
    });

    addToolCall(sid, { server_name: 'web', tool_name: 'search', params: {}, latency_ms: 200, success: true });
    addToolCall(sid, { server_name: 'web', tool_name: 'search', params: {}, latency_ms: 300, success: false, error: 'Timeout' });

    const summary = getSessionSummary(sid);

    assert.equal(summary.session_id, sid);
    assert.equal(summary.total_traces, 2);
    assert.equal(summary.total_llm_calls, 1);
    assert.equal(summary.total_tool_calls, 2);
    assert.equal(summary.total_input_tokens, 1000);
    assert.equal(summary.total_output_tokens, 400);
    assert.equal(summary.total_tokens, 1400);

    // cost: 1000*0.000003 + 400*0.000015 = 0.003 + 0.006 = 0.009
    assert.ok(Math.abs(summary.total_cost - 0.009) < 1e-9, `cost: ${summary.total_cost}`);

    assert.equal(summary.tool_success_rate, '50.0%');
    assert.equal(summary.avg_tool_latency_ms, 250);

    // error_count: 1 error trace + 1 failed tool call = 2
    assert.equal(summary.error_count, 1, 'only failed tool calls count as errors (no error-type trace)');
  });

  test('empty session returns sane defaults', () => {
    const sid = uid();
    const summary = getSessionSummary(sid);

    assert.equal(summary.session_id, sid);
    assert.equal(summary.total_cost, 0);
    assert.equal(summary.total_tokens, 0);
    assert.equal(summary.total_llm_calls, 0);
    assert.equal(summary.total_tool_calls, 0);
    assert.equal(summary.tool_success_rate, 'N/A');
    assert.equal(summary.error_count, 0);
    assert.equal(summary.total_traces, 0);
  });

  test('tool_breakdown groups by server/tool key', () => {
    const sid = uid();

    addToolCall(sid, { server_name: 'search', tool_name: 'web_search', params: {}, latency_ms: 100, success: true });
    addToolCall(sid, { server_name: 'search', tool_name: 'web_search', params: {}, latency_ms: 200, success: true });
    addToolCall(sid, { server_name: 'search', tool_name: 'image_search', params: {}, latency_ms: 300, success: false });

    const summary = getSessionSummary(sid);
    const bd = summary.tool_breakdown;

    assert.ok('search/web_search' in bd, 'search/web_search should be in tool_breakdown');
    assert.ok('search/image_search' in bd, 'search/image_search should be in tool_breakdown');
    assert.equal(bd['search/web_search'].calls, 2);
    assert.equal(bd['search/web_search'].successes, 2);
    assert.equal(bd['search/web_search'].failures, 0);
    assert.equal(bd['search/web_search'].avg_latency_ms, 150);
    assert.equal(bd['search/image_search'].failures, 1);
  });

  test('error_count includes both error-type traces and failed tool calls', () => {
    const sid = uid();

    addTrace(sid, { action_type: 'error', description: 'Auth failed' });
    addTrace(sid, { action_type: 'error', description: 'Parse failed' });
    addToolCall(sid, { server_name: 's', tool_name: 't', params: {}, latency_ms: 10, success: false });

    const summary = getSessionSummary(sid);
    assert.equal(summary.error_count, 3);
  });
});

// ─────────────────────────────────────────────
// detectAnomalies
// ─────────────────────────────────────────────

describe('detectAnomalies', () => {
  // cost_spike
  test('cost_spike: no anomaly when cost is under $1.00', () => {
    const sid = uid();
    addTokenUsage(sid, {
      model: 'claude-haiku-4',
      provider: 'anthropic',
      input_tokens: 100,
      output_tokens: 50,
      cost_per_input_token: 0.000001,
      cost_per_output_token: 0.000002,
    });

    const result = detectAnomalies(sid, ['cost_spike']);
    assert.equal(result.anomalies_found, 0);
    assert.equal(result.anomalies.length, 0);
  });

  test('cost_spike: warning when session total is between $1 and $5', () => {
    const sid = uid();
    // Cost = 100000 * 0.000015 = 1.5  (warning threshold: >$1)
    addTokenUsage(sid, {
      model: 'claude-opus-4',
      provider: 'anthropic',
      input_tokens: 100000,
      output_tokens: 0,
      cost_per_input_token: 0.000015,
      cost_per_output_token: 0.000075,
    });

    const result = detectAnomalies(sid, ['cost_spike']);
    const spike = result.anomalies.find(a => a.type === 'cost_spike' && a.value > 1);
    assert.ok(spike, 'Should detect a cost_spike anomaly');
    assert.equal(spike.severity, 'warning');
    assert.equal(spike.threshold, 1.0);
  });

  test('cost_spike: critical when session total exceeds $5', () => {
    const sid = uid();
    // Cost = 400000 * 0.000015 = 6.0  (critical threshold: >$5)
    addTokenUsage(sid, {
      model: 'claude-opus-4',
      provider: 'anthropic',
      input_tokens: 400000,
      output_tokens: 0,
      cost_per_input_token: 0.000015,
      cost_per_output_token: 0.000075,
    });

    const result = detectAnomalies(sid, ['cost_spike']);
    const critical = result.anomalies.find(a => a.severity === 'critical' && a.type === 'cost_spike');
    assert.ok(critical, 'Should detect a critical cost_spike');
  });

  test('cost_spike: warns on individual expensive call (>$0.50)', () => {
    const sid = uid();
    // Single call cost = 50000 * 0.000015 = 0.75 → per-call warning
    addTokenUsage(sid, {
      model: 'claude-opus-4',
      provider: 'anthropic',
      input_tokens: 50000,
      output_tokens: 0,
      cost_per_input_token: 0.000015,
      cost_per_output_token: 0.000075,
    });

    const result = detectAnomalies(sid, ['cost_spike']);
    const perCallSpike = result.anomalies.find(a => a.threshold === 0.5);
    assert.ok(perCallSpike, 'Should detect per-call cost spike');
    assert.equal(perCallSpike.severity, 'warning');
  });

  // error_rate
  test('error_rate: no anomaly with fewer than 3 tool calls', () => {
    const sid = uid();
    addToolCall(sid, { server_name: 's', tool_name: 't', params: {}, latency_ms: 10, success: false });
    addToolCall(sid, { server_name: 's', tool_name: 't', params: {}, latency_ms: 10, success: false });

    const result = detectAnomalies(sid, ['error_rate']);
    assert.equal(result.anomalies_found, 0);
  });

  test('error_rate: warning when 4/5 calls fail (80%)', () => {
    const sid = uid();
    addToolCall(sid, { server_name: 's', tool_name: 't', params: {}, latency_ms: 10, success: true });
    for (let i = 0; i < 4; i++) {
      addToolCall(sid, { server_name: 's', tool_name: 't', params: {}, latency_ms: 10, success: false });
    }

    const result = detectAnomalies(sid, ['error_rate']);
    assert.equal(result.anomalies_found, 1);
    // 80% > 60% → critical
    assert.equal(result.anomalies[0].severity, 'critical');
    assert.equal(result.anomalies[0].type, 'error_rate');
  });

  test('error_rate: warning severity when rate is 40%', () => {
    const sid = uid();
    // 3 success, 2 fail → 40%
    for (let i = 0; i < 3; i++) {
      addToolCall(sid, { server_name: 's', tool_name: 't', params: {}, latency_ms: 10, success: true });
    }
    for (let i = 0; i < 2; i++) {
      addToolCall(sid, { server_name: 's', tool_name: 't', params: {}, latency_ms: 10, success: false });
    }

    const result = detectAnomalies(sid, ['error_rate']);
    assert.equal(result.anomalies_found, 1);
    assert.equal(result.anomalies[0].severity, 'warning');
  });

  test('error_rate: no anomaly when error rate is under 30%', () => {
    const sid = uid();
    // 4 success, 1 fail → 20%
    for (let i = 0; i < 4; i++) {
      addToolCall(sid, { server_name: 's', tool_name: 't', params: {}, latency_ms: 10, success: true });
    }
    addToolCall(sid, { server_name: 's', tool_name: 't', params: {}, latency_ms: 10, success: false });

    const result = detectAnomalies(sid, ['error_rate']);
    assert.equal(result.anomalies_found, 0);
  });

  // latency_spike
  test('latency_spike: no anomaly when all calls are fast', () => {
    const sid = uid();
    addToolCall(sid, { server_name: 'web', tool_name: 'search', params: {}, latency_ms: 500, success: true });
    addToolCall(sid, { server_name: 'web', tool_name: 'search', params: {}, latency_ms: 9999, success: true });

    const result = detectAnomalies(sid, ['latency_spike']);
    assert.equal(result.anomalies_found, 0);
  });

  test('latency_spike: warning when a call exceeds 10s', () => {
    const sid = uid();
    addToolCall(sid, { server_name: 'db', tool_name: 'query', params: {}, latency_ms: 15000, success: true });

    const result = detectAnomalies(sid, ['latency_spike']);
    assert.equal(result.anomalies_found, 1);
    assert.equal(result.anomalies[0].type, 'latency_spike');
    assert.equal(result.anomalies[0].severity, 'warning');
    assert.equal(result.anomalies[0].threshold_ms, 10000);
  });

  test('latency_spike: critical when a call exceeds 30s', () => {
    const sid = uid();
    addToolCall(sid, { server_name: 'db', tool_name: 'slow_query', params: {}, latency_ms: 35000, success: true });

    const result = detectAnomalies(sid, ['latency_spike']);
    assert.equal(result.anomalies[0].severity, 'critical');
    assert.equal(result.anomalies[0].slow_calls[0].latency_ms, 35000);
  });

  // loop_detection
  test('loop_detection: no anomaly when patterns appear fewer than 3 times', () => {
    const sid = uid();
    const params = { query: 'news' };
    addToolCall(sid, { server_name: 'web', tool_name: 'search', params, latency_ms: 200, success: true });
    addToolCall(sid, { server_name: 'web', tool_name: 'search', params, latency_ms: 200, success: true });

    const result = detectAnomalies(sid, ['loop_detection']);
    assert.equal(result.anomalies_found, 0);
  });

  test('loop_detection: warning when same tool+params appears 3 times', () => {
    const sid = uid();
    const params = { query: 'stuck query' };
    for (let i = 0; i < 3; i++) {
      addToolCall(sid, { server_name: 'web', tool_name: 'search', params, latency_ms: 100, success: true });
    }

    const result = detectAnomalies(sid, ['loop_detection']);
    assert.equal(result.anomalies_found, 1);
    assert.equal(result.anomalies[0].type, 'loop_detection');
    assert.equal(result.anomalies[0].severity, 'warning');
    assert.equal(result.anomalies[0].repeated_patterns[0].repetitions, 3);
  });

  test('loop_detection: critical when same tool+params appears 5+ times', () => {
    const sid = uid();
    const params = { path: '/stuck/file' };
    for (let i = 0; i < 5; i++) {
      addToolCall(sid, { server_name: 'fs', tool_name: 'read', params, latency_ms: 50, success: false });
    }

    const result = detectAnomalies(sid, ['loop_detection']);
    assert.equal(result.anomalies[0].severity, 'critical');
    assert.equal(result.anomalies[0].repeated_patterns[0].repetitions, 5);
  });

  // token_explosion
  test('token_explosion: no anomaly when tokens are within limits', () => {
    const sid = uid();
    addTokenUsage(sid, {
      model: 'claude-sonnet-4',
      provider: 'anthropic',
      input_tokens: 50000,
      output_tokens: 10000,
      cost_per_input_token: 0.000003,
      cost_per_output_token: 0.000015,
    });

    const result = detectAnomalies(sid, ['token_explosion']);
    assert.equal(result.anomalies_found, 0);
  });

  test('token_explosion: warning when single call exceeds 100K tokens', () => {
    const sid = uid();
    addTokenUsage(sid, {
      model: 'claude-opus-4',
      provider: 'anthropic',
      input_tokens: 90000,
      output_tokens: 20000,
      cost_per_input_token: 0.000015,
      cost_per_output_token: 0.000075,
    });

    const result = detectAnomalies(sid, ['token_explosion']);
    const singleCallAnomaly = result.anomalies.find(a => a.threshold === 100000);
    assert.ok(singleCallAnomaly, 'Should detect single-call token explosion');
    assert.equal(singleCallAnomaly.value, 110000);
    assert.equal(singleCallAnomaly.severity, 'warning');
  });

  test('token_explosion: critical when single call exceeds 500K tokens', () => {
    const sid = uid();
    addTokenUsage(sid, {
      model: 'gemini-2.5-pro',
      provider: 'google',
      input_tokens: 400000,
      output_tokens: 150000,
      cost_per_input_token: 0.00000125,
      cost_per_output_token: 0.00001,
    });

    const result = detectAnomalies(sid, ['token_explosion']);
    const critAnomaly = result.anomalies.find(a => a.severity === 'critical' && a.threshold === 100000);
    assert.ok(critAnomaly, 'Should detect critical token explosion');
    assert.equal(critAnomaly.value, 550000);
  });

  test('token_explosion: session total warning when over 500K', () => {
    const sid = uid();
    // Multiple small calls summing to >500K
    for (let i = 0; i < 6; i++) {
      addTokenUsage(sid, {
        model: 'claude-sonnet-4',
        provider: 'anthropic',
        input_tokens: 70000,
        output_tokens: 15000,
        cost_per_input_token: 0.000003,
        cost_per_output_token: 0.000015,
      });
    }
    // 6 * 85000 = 510000 total tokens → session threshold warning

    const result = detectAnomalies(sid, ['token_explosion']);
    const sessionAnomaly = result.anomalies.find(a => a.threshold === 500000);
    assert.ok(sessionAnomaly, 'Should detect session-level token explosion');
  });

  // multiple check types simultaneously
  test('multiple checks can be run in a single call', () => {
    const sid = uid();

    const result = detectAnomalies(sid, ['cost_spike', 'error_rate', 'loop_detection', 'latency_spike', 'token_explosion']);
    assert.deepEqual(result.checks_performed, ['cost_spike', 'error_rate', 'loop_detection', 'latency_spike', 'token_explosion']);
    assert.equal(result.anomalies_found, 0);
    assert.ok(typeof result.checked_at === 'string');
    assert.equal(result.session_id, sid);
  });
});

// ─────────────────────────────────────────────
// getCostReport
// ─────────────────────────────────────────────

describe('getCostReport', () => {
  test('group_by model aggregates correctly', () => {
    const sid = uid();

    addTokenUsage(sid, {
      model: 'claude-sonnet-4',
      provider: 'anthropic',
      input_tokens: 1000,
      output_tokens: 500,
      cost_per_input_token: 0.000003,
      cost_per_output_token: 0.000015,
    });

    addTokenUsage(sid, {
      model: 'claude-haiku-4',
      provider: 'anthropic',
      input_tokens: 2000,
      output_tokens: 1000,
      cost_per_input_token: 0.0000008,
      cost_per_output_token: 0.000004,
    });

    addTokenUsage(sid, {
      model: 'claude-sonnet-4',
      provider: 'anthropic',
      input_tokens: 500,
      output_tokens: 200,
      cost_per_input_token: 0.000003,
      cost_per_output_token: 0.000015,
    });

    const report = getCostReport({ sessionIds: [sid], groupBy: 'model' });

    assert.ok('claude-sonnet-4' in report.breakdown);
    assert.ok('claude-haiku-4' in report.breakdown);
    assert.equal(report.breakdown['claude-sonnet-4'].calls, 2);
    assert.equal(report.breakdown['claude-haiku-4'].calls, 1);
    assert.equal(report.breakdown['claude-sonnet-4'].input_tokens, 1500);
    assert.equal(report.group_by, 'model');
    assert.equal(report.total_calls, 3);
  });

  test('group_by provider aggregates across providers', () => {
    const sid = uid();

    addTokenUsage(sid, {
      model: 'claude-sonnet-4',
      provider: 'anthropic',
      input_tokens: 1000,
      output_tokens: 500,
      cost_per_input_token: 0.000003,
      cost_per_output_token: 0.000015,
    });

    addTokenUsage(sid, {
      model: 'gpt-4o',
      provider: 'openai',
      input_tokens: 2000,
      output_tokens: 1000,
      cost_per_input_token: 0.0000025,
      cost_per_output_token: 0.00001,
    });

    const report = getCostReport({ sessionIds: [sid], groupBy: 'provider' });

    assert.ok('anthropic' in report.breakdown);
    assert.ok('openai' in report.breakdown);
    assert.equal(report.breakdown['anthropic'].calls, 1);
    assert.equal(report.breakdown['openai'].calls, 1);
  });

  test('group_by session creates one entry per session', () => {
    const sid1 = uid();
    const sid2 = uid();

    addTokenUsage(sid1, {
      model: 'claude-haiku-4', provider: 'anthropic',
      input_tokens: 100, output_tokens: 50,
      cost_per_input_token: 0.0000008, cost_per_output_token: 0.000004,
    });

    addTokenUsage(sid2, {
      model: 'claude-haiku-4', provider: 'anthropic',
      input_tokens: 200, output_tokens: 100,
      cost_per_input_token: 0.0000008, cost_per_output_token: 0.000004,
    });

    const report = getCostReport({ sessionIds: [sid1, sid2], groupBy: 'session' });

    assert.ok(sid1 in report.breakdown);
    assert.ok(sid2 in report.breakdown);
    assert.equal(report.sessions_analyzed, 2);
    assert.equal(report.total_calls, 2);
  });

  test('time_range filtering excludes calls outside range', () => {
    const sid = uid();
    const past = '2020-01-01T00:00:00.000Z';
    const future = '2099-01-01T00:00:00.000Z';

    addTokenUsage(sid, {
      model: 'gpt-4o', provider: 'openai',
      input_tokens: 500, output_tokens: 200,
      cost_per_input_token: 0.0000025, cost_per_output_token: 0.00001,
    });

    // Filter to a window entirely in the past — should exclude current calls
    const report = getCostReport({
      sessionIds: [sid],
      groupBy: 'model',
      timeRange: { start: past, end: '2021-01-01T00:00:00.000Z' },
    });

    assert.equal(report.total_calls, 0);
    assert.equal(report.total_cost, 0);
    assert.equal(Object.keys(report.breakdown).length, 0);

    // Filter with wide range — should include current calls
    const report2 = getCostReport({
      sessionIds: [sid],
      groupBy: 'model',
      timeRange: { start: past, end: future },
    });

    assert.equal(report2.total_calls, 1);
    assert.ok(report2.total_cost > 0);
  });

  test('total_cost and total_tokens are correct', () => {
    const sid = uid();

    addTokenUsage(sid, {
      model: 'claude-haiku-4', provider: 'anthropic',
      input_tokens: 1000, output_tokens: 500,
      cost_per_input_token: 0.0000008, cost_per_output_token: 0.000004,
    });
    // cost = 1000*0.0000008 + 500*0.000004 = 0.0008 + 0.002 = 0.0028

    const report = getCostReport({ sessionIds: [sid], groupBy: 'model' });

    assert.ok(Math.abs(report.total_cost - 0.0028) < 1e-9, `total_cost: ${report.total_cost}`);
    assert.equal(report.total_tokens, 1500);
  });

  test('group_by tool always uses llm_call key', () => {
    const sid = uid();

    addTokenUsage(sid, {
      model: 'claude-sonnet-4', provider: 'anthropic',
      input_tokens: 100, output_tokens: 50,
      cost_per_input_token: 0.000003, cost_per_output_token: 0.000015,
    });

    const report = getCostReport({ sessionIds: [sid], groupBy: 'tool' });
    assert.ok('llm_call' in report.breakdown);
  });
});

// ─────────────────────────────────────────────
// listSessions
// ─────────────────────────────────────────────

describe('listSessions', () => {
  test('returns all sessions that have been created', () => {
    const sid1 = uid('list');
    const sid2 = uid('list');

    addTrace(sid1, { action_type: 'decision', description: 'start' });
    addTokenUsage(sid2, {
      model: 'claude-haiku-4', provider: 'anthropic',
      input_tokens: 10, output_tokens: 5,
      cost_per_input_token: 0, cost_per_output_token: 0,
    });

    const sessions = listSessions();
    assert.ok(sessions.includes(sid1), 'sid1 should be in listSessions');
    assert.ok(sessions.includes(sid2), 'sid2 should be in listSessions');
  });
});

// ─────────────────────────────────────────────
// Full integration scenario: simulated agent run
// ─────────────────────────────────────────────

describe('Integration: simulated agent run', () => {
  test('tracks a realistic multi-step agent session end-to-end', () => {
    const sid = uid('integration');

    // Step 1 — decision trace
    addTrace(sid, { action_type: 'decision', description: 'Route query to search department', metadata: { routing: 'search' } });

    // Step 2 — two LLM calls
    addTokenUsage(sid, {
      model: 'claude-haiku-4', provider: 'anthropic',
      input_tokens: 500, output_tokens: 150,
      cost_per_input_token: 0.0000008, cost_per_output_token: 0.000004,
    });
    addTokenUsage(sid, {
      model: 'claude-sonnet-4', provider: 'anthropic',
      input_tokens: 2000, output_tokens: 800,
      cost_per_input_token: 0.000003, cost_per_output_token: 0.000015,
    });

    // Step 3 — three tool calls (2 success, 1 fail)
    addToolCall(sid, { server_name: 'web', tool_name: 'search', params: { q: 'GCC economy' }, latency_ms: 400, success: true });
    addToolCall(sid, { server_name: 'web', tool_name: 'fetch', params: { url: 'https://example.com' }, latency_ms: 1200, success: true });
    addToolCall(sid, { server_name: 'db', tool_name: 'query', params: { table: 'deals' }, latency_ms: 200, success: false, error: 'Connection refused' });

    // Step 4 — error trace
    addTrace(sid, { action_type: 'error', description: 'DB connection refused, falling back to cached data' });

    // Assertions on summary
    const summary = getSessionSummary(sid);
    assert.equal(summary.total_traces, 2);  // decision + error
    assert.equal(summary.total_llm_calls, 2);
    assert.equal(summary.total_tool_calls, 3);
    assert.equal(summary.total_input_tokens, 2500);
    assert.equal(summary.total_output_tokens, 950);
    assert.equal(summary.error_count, 2);  // 1 error trace + 1 failed tool
    assert.ok(summary.total_cost > 0, 'should have non-zero cost');

    // Check anomalies — no major issues expected
    const anomalies = detectAnomalies(sid, ['cost_spike', 'error_rate', 'loop_detection', 'latency_spike', 'token_explosion']);
    // error_rate: 1/3 failures = 33% → warning (just over 30% threshold)
    const errAnomaly = anomalies.anomalies.find(a => a.type === 'error_rate');
    assert.ok(errAnomaly, 'Should detect error rate anomaly (33% > 30%)');

    // Cost report
    const report = getCostReport({ sessionIds: [sid], groupBy: 'model' });
    assert.ok('claude-haiku-4' in report.breakdown);
    assert.ok('claude-sonnet-4' in report.breakdown);
    assert.equal(report.total_calls, 2);
  });
});
