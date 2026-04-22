/**
 * LLM pricing table — current as of April 2026.
 * Prices are per token (not per 1K tokens).
 */

export const PRICING_TABLE = {
  last_updated: '2026-04-22',
  prices_per_token: true,
  providers: {
    anthropic: {
      'claude-opus-4': { input: 0.000015, output: 0.000075 },
      'claude-sonnet-4': { input: 0.000003, output: 0.000015 },
      'claude-haiku-4': { input: 0.0000008, output: 0.000004 },
      'claude-3.5-sonnet': { input: 0.000003, output: 0.000015 },
      'claude-3.5-haiku': { input: 0.0000008, output: 0.000004 },
      'claude-3-opus': { input: 0.000015, output: 0.000075 },
    },
    openai: {
      'gpt-4o': { input: 0.0000025, output: 0.00001 },
      'gpt-4o-mini': { input: 0.00000015, output: 0.0000006 },
      'gpt-4-turbo': { input: 0.00001, output: 0.00003 },
      'o1': { input: 0.000015, output: 0.00006 },
      'o1-mini': { input: 0.000003, output: 0.000012 },
      'o3-mini': { input: 0.0000011, output: 0.0000044 },
    },
    google: {
      'gemini-2.5-pro': { input: 0.00000125, output: 0.00001 },
      'gemini-2.5-flash': { input: 0.00000015, output: 0.000001 },
      'gemini-2.0-flash': { input: 0.0000001, output: 0.0000004 },
      'gemini-1.5-pro': { input: 0.00000125, output: 0.000005 },
    },
    mistral: {
      'mistral-large': { input: 0.000002, output: 0.000006 },
      'mistral-medium': { input: 0.0000027, output: 0.0000081 },
      'mistral-small': { input: 0.0000002, output: 0.0000006 },
      'codestral': { input: 0.0000003, output: 0.0000009 },
    },
    local: {
      'local-model': { input: 0, output: 0 },
    },
  },
};

/**
 * Look up default pricing for a model. Returns { input, output } per-token costs.
 */
export function getDefaultPricing(model, provider) {
  const providerPrices = PRICING_TABLE.providers[provider];
  if (!providerPrices) return null;

  // Direct match
  if (providerPrices[model]) return providerPrices[model];

  // Fuzzy match — find the first key that the model string contains
  for (const [key, prices] of Object.entries(providerPrices)) {
    if (model.toLowerCase().includes(key.toLowerCase())) return prices;
  }

  return null;
}
