#!/bin/bash
# Smithery CLI submission — simplest approach
# Requires: SMITHERY_API_KEY env var
# Get your key at: https://smithery.ai/account/api-keys

export SMITHERY_API_KEY="${SMITHERY_API_KEY}"
if [ -z "$SMITHERY_API_KEY" ]; then
  echo "ERROR: Set SMITHERY_API_KEY first"
  echo "Get it at: https://smithery.ai/account/api-keys"
  exit 1
fi

NAMESPACE="mdfifty50-boop"

for SERVER in gcc-intelligence-mcp agent-security-mcp domain-expertise-mcp agent-observability-mcp; do
  echo ""
  echo "=== Publishing ${NAMESPACE}/${SERVER} ==="
  npx @smithery/cli mcp publish \
    "https://github.com/${NAMESPACE}/${SERVER}" \
    -n "${NAMESPACE}/${SERVER}" \
    2>&1
  echo "Registry page: https://smithery.ai/server/${NAMESPACE}/${SERVER}"
done
