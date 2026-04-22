#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  addTrace,
  addTokenUsage,
  addToolCall,
  getSessionSummary,
  detectAnomalies,
  getCostReport,
} from './storage.js';
import { PRICING_TABLE, getDefaultPricing } from './pricing.js';

const server = new McpServer({
  name: 'agent-observability-mcp',
  version: '0.1.0',
  description: 'AI agent observability — tracing, cost tracking, performance monitoring, and audit trails',
});

// ═══════════════════════════════════════════
// TRACING TOOLS
// ═══════════════════════════════════════════

server.tool(
  'trace_agent_action',
  'Log an agent action with metadata for audit trails and debugging. Supports tool calls, LLM requests, decisions, and errors.',
  {
    session_id: z.string().describe('Unique session identifier'),
    action_type: z.enum(['tool_call', 'llm_request', 'decision', 'error']).describe('Type of action being traced'),
    tool_name: z.string().optional().describe('Name of the tool (for tool_call actions)'),
    description: z.string().describe('Human-readable description of the action'),
    metadata: z.record(z.any()).optional().describe('Additional key-value metadata'),
    timestamp: z.string().optional().describe('ISO 8601 timestamp (defaults to now)'),
  },
  async (params) => {
    const entry = addTrace(params.session_id, {
      action_type: params.action_type,
      tool_name: params.tool_name,
      description: params.description,
      metadata: params.metadata || {},
      timestamp: params.timestamp,
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          trace_id: entry.trace_id,
          session_id: entry.session_id,
          action_type: entry.action_type,
          logged: true,
          timestamp: entry.timestamp,
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// TOKEN USAGE & COST TRACKING
// ═══════════════════════════════════════════

server.tool(
  'track_token_usage',
  'Track token usage and cost for an LLM call. Auto-calculates cost from built-in pricing table if per-token costs are not provided.',
  {
    session_id: z.string().describe('Unique session identifier'),
    model: z.string().describe('Model name (e.g., claude-sonnet-4, gpt-4o)'),
    provider: z.enum(['anthropic', 'openai', 'google', 'mistral', 'local']).describe('LLM provider'),
    input_tokens: z.number().int().min(0).describe('Number of input/prompt tokens'),
    output_tokens: z.number().int().min(0).describe('Number of output/completion tokens'),
    cost_per_input_token: z.number().min(0).optional().describe('Cost per input token (overrides built-in pricing)'),
    cost_per_output_token: z.number().min(0).optional().describe('Cost per output token (overrides built-in pricing)'),
  },
  async (params) => {
    // Resolve pricing: explicit > built-in > zero
    let inputCost = params.cost_per_input_token;
    let outputCost = params.cost_per_output_token;

    if (inputCost === undefined || outputCost === undefined) {
      const defaults = getDefaultPricing(params.model, params.provider);
      if (defaults) {
        if (inputCost === undefined) inputCost = defaults.input;
        if (outputCost === undefined) outputCost = defaults.output;
      } else {
        if (inputCost === undefined) inputCost = 0;
        if (outputCost === undefined) outputCost = 0;
      }
    }

    const result = addTokenUsage(params.session_id, {
      model: params.model,
      provider: params.provider,
      input_tokens: params.input_tokens,
      output_tokens: params.output_tokens,
      cost_per_input_token: inputCost,
      cost_per_output_token: outputCost,
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          call_cost: parseFloat(result.cost.toFixed(6)),
          running_session_total: parseFloat(result.running_session_total.toFixed(6)),
          model: params.model,
          provider: params.provider,
          input_tokens: params.input_tokens,
          output_tokens: params.output_tokens,
          pricing_used: { input: inputCost, output: outputCost },
          model_breakdown: result.model_breakdown,
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// TOOL CALL LOGGING
// ═══════════════════════════════════════════

server.tool(
  'log_tool_call',
  'Log an MCP tool call with performance data including latency, success/failure, and error details.',
  {
    session_id: z.string().describe('Unique session identifier'),
    server_name: z.string().describe('Name of the MCP server'),
    tool_name: z.string().describe('Name of the tool called'),
    params: z.record(z.any()).describe('Parameters passed to the tool'),
    result_summary: z.string().optional().describe('Brief summary of the result'),
    latency_ms: z.number().int().min(0).describe('Call latency in milliseconds'),
    success: z.boolean().describe('Whether the call succeeded'),
    error: z.string().optional().describe('Error message if call failed'),
  },
  async (params) => {
    const stats = addToolCall(params.session_id, {
      server_name: params.server_name,
      tool_name: params.tool_name,
      params: params.params,
      result_summary: params.result_summary,
      latency_ms: params.latency_ms,
      success: params.success,
      error: params.error,
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          logged: true,
          server_name: params.server_name,
          tool_name: params.tool_name,
          success: params.success,
          latency_ms: params.latency_ms,
          session_stats: stats,
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// SESSION SUMMARY
// ═══════════════════════════════════════════

server.tool(
  'get_session_summary',
  'Get a comprehensive cost and performance summary for an agent session, including token usage, tool call stats, and model breakdown.',
  {
    session_id: z.string().describe('Session ID to get summary for'),
  },
  async ({ session_id }) => {
    const summary = getSessionSummary(session_id);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(summary, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// ANOMALY DETECTION
// ═══════════════════════════════════════════

server.tool(
  'detect_anomaly',
  'Flag unusual patterns in agent behavior: cost spikes, high error rates, latency issues, infinite loops, and token explosions.',
  {
    session_id: z.string().describe('Session ID to check for anomalies'),
    check_types: z.array(
      z.enum(['cost_spike', 'error_rate', 'latency_spike', 'loop_detection', 'token_explosion'])
    ).describe('Types of anomaly checks to run'),
  },
  async ({ session_id, check_types }) => {
    const result = detectAnomalies(session_id, check_types);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// COST REPORT
// ═══════════════════════════════════════════

server.tool(
  'get_cost_report',
  'Get cost breakdown across multiple sessions, grouped by model, provider, tool, or session. Supports time range filtering.',
  {
    session_ids: z.array(z.string()).optional().describe('Specific session IDs to include (defaults to all)'),
    time_range: z.object({
      start: z.string().optional().describe('Start of time range (ISO 8601)'),
      end: z.string().optional().describe('End of time range (ISO 8601)'),
    }).optional().describe('Filter by time range'),
    group_by: z.enum(['model', 'provider', 'tool', 'session']).describe('How to group the cost breakdown'),
  },
  async (params) => {
    const report = getCostReport({
      sessionIds: params.session_ids,
      timeRange: params.time_range,
      groupBy: params.group_by,
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(report, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// RESOURCES
// ═══════════════════════════════════════════

server.resource(
  'llm-pricing',
  'observability://pricing',
  async () => ({
    contents: [{
      uri: 'observability://pricing',
      mimeType: 'application/json',
      text: JSON.stringify(PRICING_TABLE, null, 2),
    }],
  })
);

server.resource(
  'best-practices',
  'observability://best-practices',
  async () => ({
    contents: [{
      uri: 'observability://best-practices',
      mimeType: 'text/markdown',
      text: `# Agent Observability Best Practices

## 1. Session Management
- Generate a unique \`session_id\` at the start of each agent run (UUID v4 or similar)
- Reuse the same session ID across all tool calls in a single run
- Use descriptive session IDs when possible: \`agent-name_YYYYMMDD_HHMMSS\`

## 2. Trace Everything
- Log every LLM call with \`track_token_usage\` — this is your cost foundation
- Log every MCP tool call with \`log_tool_call\` — track latency and errors
- Use \`trace_agent_action\` for decisions, state changes, and custom events
- Always include the \`error\` field when \`success: false\`

## 3. Cost Control
- Set cost alerts with \`detect_anomaly\` (check_types: ["cost_spike"]) after every N calls
- Use the built-in pricing table — override only when using custom/fine-tuned models
- Route to cheaper models for simple tasks (haiku/flash for classification, opus/gpt-4 for reasoning)
- Monitor \`running_session_total\` in track_token_usage responses

## 4. Performance Monitoring
- Track latency for every tool call — slow tools compound across agent loops
- Run \`detect_anomaly\` with "latency_spike" after tool-heavy operations
- Set up periodic health checks with \`get_session_summary\`

## 5. Loop Detection
- Run \`detect_anomaly\` with "loop_detection" periodically during long agent runs
- An agent calling the same tool with the same params 3+ times is likely stuck
- Implement circuit breakers: if loop detected, force a different approach or halt

## 6. Error Tracking
- Monitor error rates with \`detect_anomaly\` (check_types: ["error_rate"])
- An error rate above 30% indicates a systemic issue, not random failures
- Log error details in trace metadata for post-mortem analysis

## 7. Token Budget Management
- Check for token explosions periodically: \`detect_anomaly\` with "token_explosion"
- Single calls over 100K tokens usually indicate accidentally large contexts
- Set hard limits per session and abort if exceeded

## 8. Reporting
- Use \`get_cost_report\` grouped by model to identify optimization opportunities
- Group by provider to compare costs across vendors
- Group by session to find expensive workflows that need optimization

## 9. Audit Trail
- Every \`trace_agent_action\` with type "decision" creates an audit record
- Include the reasoning in the description field for compliance
- Store metadata with relevant context (user ID, document ID, etc.)

## 10. Alerting Thresholds (Recommended Defaults)
| Metric | Warning | Critical |
|--------|---------|----------|
| Session cost | > $1.00 | > $5.00 |
| Single call cost | > $0.50 | > $2.00 |
| Error rate | > 30% | > 60% |
| Tool latency | > 10s | > 30s |
| Single call tokens | > 100K | > 500K |
| Session total tokens | > 500K | > 2M |
| Loop repetitions | >= 3 | >= 5 |
`,
    }],
  })
);

// ═══════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Agent Observability MCP Server running on stdio');
}

main().catch(console.error);
