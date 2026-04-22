/**
 * Tests for pricing.js — PRICING_TABLE and getDefaultPricing.
 * Uses node:test and node:assert/strict (no npm deps).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PRICING_TABLE, getDefaultPricing } from './pricing.js';

// ─────────────────────────────────────────────
// PRICING_TABLE structure
// ─────────────────────────────────────────────

describe('PRICING_TABLE structure', () => {
  test('has required top-level fields', () => {
    assert.ok(typeof PRICING_TABLE.last_updated === 'string', 'last_updated should be a string');
    assert.equal(PRICING_TABLE.prices_per_token, true, 'prices_per_token should be true');
    assert.ok(typeof PRICING_TABLE.providers === 'object', 'providers should be an object');
  });

  test('has all required providers', () => {
    const expected = ['anthropic', 'openai', 'google', 'mistral', 'local'];
    for (const p of expected) {
      assert.ok(p in PRICING_TABLE.providers, `Provider ${p} should exist`);
    }
  });

  test('every model entry has input and output fields as numbers', () => {
    for (const [provider, models] of Object.entries(PRICING_TABLE.providers)) {
      for (const [model, pricing] of Object.entries(models)) {
        assert.ok(typeof pricing.input === 'number', `${provider}/${model}.input should be a number`);
        assert.ok(typeof pricing.output === 'number', `${provider}/${model}.output should be a number`);
        assert.ok(pricing.input >= 0, `${provider}/${model}.input should be >= 0`);
        assert.ok(pricing.output >= 0, `${provider}/${model}.output should be >= 0`);
      }
    }
  });

  test('output tokens are more expensive than input for paid models', () => {
    // Standard industry pattern: output is always >= input cost
    for (const [provider, models] of Object.entries(PRICING_TABLE.providers)) {
      if (provider === 'local') continue;  // local model has 0 costs
      for (const [model, pricing] of Object.entries(models)) {
        assert.ok(
          pricing.output >= pricing.input,
          `${provider}/${model}: output cost (${pricing.output}) should be >= input cost (${pricing.input})`
        );
      }
    }
  });

  test('local model has zero cost', () => {
    const localModel = PRICING_TABLE.providers.local['local-model'];
    assert.equal(localModel.input, 0);
    assert.equal(localModel.output, 0);
  });

  test('Anthropic models exist and have positive prices', () => {
    const anthropic = PRICING_TABLE.providers.anthropic;
    assert.ok('claude-opus-4' in anthropic);
    assert.ok('claude-sonnet-4' in anthropic);
    assert.ok('claude-haiku-4' in anthropic);
    assert.ok(anthropic['claude-opus-4'].input > 0);
    assert.ok(anthropic['claude-sonnet-4'].input > 0);
    assert.ok(anthropic['claude-haiku-4'].input > 0);
  });

  test('haiku is cheaper than sonnet which is cheaper than opus (Anthropic)', () => {
    const { 'claude-haiku-4': haiku, 'claude-sonnet-4': sonnet, 'claude-opus-4': opus } = PRICING_TABLE.providers.anthropic;
    assert.ok(haiku.input < sonnet.input, 'haiku should be cheaper than sonnet');
    assert.ok(sonnet.input < opus.input, 'sonnet should be cheaper than opus');
  });
});

// ─────────────────────────────────────────────
// getDefaultPricing
// ─────────────────────────────────────────────

describe('getDefaultPricing', () => {
  test('returns exact match for known model', () => {
    const pricing = getDefaultPricing('claude-sonnet-4', 'anthropic');
    assert.ok(pricing !== null);
    assert.equal(pricing.input, PRICING_TABLE.providers.anthropic['claude-sonnet-4'].input);
    assert.equal(pricing.output, PRICING_TABLE.providers.anthropic['claude-sonnet-4'].output);
  });

  test('returns exact match for gpt-4o', () => {
    const pricing = getDefaultPricing('gpt-4o', 'openai');
    assert.ok(pricing !== null);
    assert.equal(pricing.input, PRICING_TABLE.providers.openai['gpt-4o'].input);
  });

  test('returns null for unknown provider', () => {
    const pricing = getDefaultPricing('claude-sonnet-4', 'unknown-provider');
    assert.equal(pricing, null);
  });

  test('returns null when model does not match any known key', () => {
    const pricing = getDefaultPricing('some-random-model-xyz', 'anthropic');
    assert.equal(pricing, null);
  });

  test('fuzzy match: model string containing known key', () => {
    // Model name includes 'claude-sonnet-4' as substring
    const pricing = getDefaultPricing('my-finetuned-claude-sonnet-4-v2', 'anthropic');
    assert.ok(pricing !== null, 'Should fuzzy-match claude-sonnet-4');
    assert.equal(pricing.input, PRICING_TABLE.providers.anthropic['claude-sonnet-4'].input);
  });

  test('fuzzy match: model name with different casing', () => {
    // The fuzzy match uses .toLowerCase() — test that it handles mixed case
    const pricing = getDefaultPricing('Claude-Haiku-4', 'anthropic');
    assert.ok(pricing !== null, 'Should fuzzy-match claude-haiku-4 case-insensitively');
    assert.equal(pricing.input, PRICING_TABLE.providers.anthropic['claude-haiku-4'].input);
  });

  test('returns local pricing for local-model', () => {
    const pricing = getDefaultPricing('local-model', 'local');
    assert.ok(pricing !== null);
    assert.equal(pricing.input, 0);
    assert.equal(pricing.output, 0);
  });

  test('returns gemini pricing for google provider', () => {
    const pricing = getDefaultPricing('gemini-2.5-pro', 'google');
    assert.ok(pricing !== null);
    assert.equal(pricing.input, PRICING_TABLE.providers.google['gemini-2.5-pro'].input);
  });

  test('returns mistral-large pricing for mistral provider', () => {
    const pricing = getDefaultPricing('mistral-large', 'mistral');
    assert.ok(pricing !== null);
    assert.equal(pricing.input, PRICING_TABLE.providers.mistral['mistral-large'].input);
  });

  test('each provider lookup is independent (no cross-provider bleed)', () => {
    // claude-sonnet-4 is not in openai's table
    const pricing = getDefaultPricing('claude-sonnet-4', 'openai');
    assert.equal(pricing, null, 'claude-sonnet-4 should not match any openai model');
  });

  test('returns { input, output } shape for all known models', () => {
    const knownModels = [
      ['claude-opus-4', 'anthropic'],
      ['claude-sonnet-4', 'anthropic'],
      ['claude-haiku-4', 'anthropic'],
      ['claude-3.5-sonnet', 'anthropic'],
      ['claude-3.5-haiku', 'anthropic'],
      ['gpt-4o', 'openai'],
      ['gpt-4o-mini', 'openai'],
      ['o1', 'openai'],
      ['gemini-2.5-pro', 'google'],
      ['gemini-2.5-flash', 'google'],
      ['mistral-large', 'mistral'],
      ['codestral', 'mistral'],
      ['local-model', 'local'],
    ];
    for (const [model, provider] of knownModels) {
      const pricing = getDefaultPricing(model, provider);
      assert.ok(pricing !== null, `${provider}/${model} should return pricing`);
      assert.ok('input' in pricing, `${provider}/${model} should have input`);
      assert.ok('output' in pricing, `${provider}/${model} should have output`);
    }
  });
});
