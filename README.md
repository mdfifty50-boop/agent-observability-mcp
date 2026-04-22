# agentic-observability-mcp

AI agent observability for MCP. Tracing, cost tracking, performance monitoring, anomaly detection, and audit trails — all via Model Context Protocol.

[![npm version](https://img.shields.io/npm/v/agentic-observability-mcp)](https://www.npmjs.com/package/agentic-observability-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Why This Exists

AI agents burn tokens, call tools, make decisions, and sometimes get stuck in loops. You need to know what they're doing, what it costs, and when something goes wrong. No existing MCP server provides unified agent observability. This one does.

**Track every LLM call, every tool invocation, every decision — with automatic cost calculation and anomaly detection.**

## What It Does

### Tracing
- `trace_agent_action` — Log any agent action (tool calls, LLM requests, decisions, errors) with metadata and timestamps

### Cost Tracking
- `track_token_usage` — Track token usage per LLM call with automatic cost calculation from built-in pricing tables (Claude, GPT, Gemini, Mistral)
- `get_cost_report` — Aggregate cost breakdown across sessions, grouped by model, provider, tool, or session

### Performance Monitoring
- `log_tool_call` — Log MCP tool calls with latency, success/failure, and error details
- `get_session_summary` — Full session report: cost, tokens, tool stats, error count, model breakdown, duration

### Anomaly Detection
- `detect_anomaly` — Flag unusual patterns:
  - **cost_spike** — Session or single-call cost exceeds thresholds
  - **error_rate** — Tool failure rate above 30%
  - **latency_spike** — Tool calls exceeding 10s
  - **loop_detection** — Same tool called with same params 3+ times (agent stuck)
  - **token_explosion** — Single call or session using excessive tokens

### Resources (Static Knowledge)
- `observability://pricing` — Current LLM pricing table (per-token costs for all major models)
- `observability://best-practices` — Agent observability best practices guide

## Installation

### Claude Desktop / Claude Code

Add to your MCP configuration (`~/.claude/settings.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "agent-observability": {
      "command": "npx",
      "args": ["agentic-observability-mcp"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "agent-observability": {
      "command": "npx",
      "args": ["agentic-observability-mcp"]
    }
  }
}
```

### Windsurf / VS Code

Same pattern — add the server to your MCP configuration file.

## Use Cases

**For agent framework developers:**
Instrument your agent loop with `track_token_usage` and `log_tool_call` to get real-time cost and performance data without building your own telemetry.

**For teams running agents in production:**
Use `detect_anomaly` to catch stuck agents (loop detection), runaway costs (cost spike), and degraded tool performance (latency spike) before they become incidents.

**For cost optimization:**
Use `get_cost_report` grouped by model to identify which models are eating your budget. Switch expensive reasoning calls to cheaper models where quality allows.

**For compliance and audit:**
Every `trace_agent_action` with type "decision" creates an audit record. Include reasoning in the description for full traceability.

## Example

```
Agent: "Track that I just used 1,500 input tokens and 800 output tokens
        with claude-sonnet-4 on Anthropic for session agent_run_001"

--> Returns:
  {
    "call_cost": 0.016500,
    "running_session_total": 0.016500,
    "model": "claude-sonnet-4",
    "provider": "anthropic",
    "pricing_used": { "input": 0.000003, "output": 0.000015 },
    "model_breakdown": {
      "claude-sonnet-4": {
        "calls": 1,
        "input_tokens": 1500,
        "output_tokens": 800,
        "cost": 0.016500
      }
    }
  }

Agent: "Check session agent_run_001 for anomalies — cost spike and loop detection"

--> Returns:
  {
    "anomalies_found": 0,
    "anomalies": [],
    "checks_performed": ["cost_spike", "loop_detection"]
  }
```

## Built-in Pricing Table

Automatically calculates costs for these models (override with custom pricing if needed):

| Provider | Models |
|----------|--------|
| Anthropic | Claude Opus 4, Sonnet 4, Haiku 4, 3.5 Sonnet, 3.5 Haiku, 3 Opus |
| OpenAI | GPT-4o, GPT-4o Mini, GPT-4 Turbo, o1, o1-mini, o3-mini |
| Google | Gemini 2.5 Pro, 2.5 Flash, 2.0 Flash, 1.5 Pro |
| Mistral | Large, Medium, Small, Codestral |
| Local | Zero cost (self-hosted models) |

## Pricing

| Tier | Price | Agents | Retention | Events/Month |
|------|-------|--------|-----------|--------------|
| Free | $0 | 1 | 7 days | 10,000 |
| Starter | $59/month | 5 | 30 days | 100,000 |
| Pro | $299/month | 25 | 90 days | 1,000,000 |
| Enterprise | $999/month | Unlimited | 1 year | Unlimited + SOC2 reporting |

## Architecture

v1 uses in-memory storage (Maps). Data is lost on server restart. The storage layer (`src/storage.js`) is structured for easy swap to Redis or Postgres in v2.

## Requirements

- Node.js 18+
- No API keys needed
- No external dependencies beyond MCP SDK and Zod

## License

MIT

## Keywords

mcp, mcp-server, observability, agent-tracing, cost-tracking, token-usage, ai-agent, performance-monitoring, audit-trail, model-context-protocol
