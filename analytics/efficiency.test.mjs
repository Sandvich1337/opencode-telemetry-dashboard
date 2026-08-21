import assert from "node:assert/strict";
import test from "node:test";

import { createSnapshot } from "./snapshot.mjs";
import { LONG_CONTEXT_THRESHOLD_TOKENS, analyzeEfficiency } from "./efficiency.mjs";

function snapshot(sessions) {
  return createSnapshot({
    sessions,
    provenance: { capabilities: { messages: true, parts: true } },
  });
}

test("efficiency conserves token buckets and attributes PASS economics only", () => {
  const result = analyzeEfficiency(snapshot([
    {
      id: "pass",
      createdAt: 0,
      updatedAt: 20,
      agent: "builder",
      model: "model-a",
      tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 15, write: 1 } },
      cost: 2,
      reviewer: { agent: "reviewer", verdict: "PASS" },
    },
    {
      id: "issue",
      createdAt: 30,
      updatedAt: 50,
      agent: "builder",
      model: "model-a",
      tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 3,
      reviewer: { agent: "reviewer", verdict: "ISSUE" },
    },
  ]));

  assert.equal(result.tokens.total, result.tokens.input + result.tokens.output + result.tokens.reasoning + result.tokens.cacheRead + result.tokens.cacheWrite);
  assert.equal(result.cacheReadShare.numerator, 15);
  assert.equal(result.cacheReadShare.denominator, 45);
  assert.equal(result.estimatedCacheSavings.estimatedUSD, null);
  assert.equal(result.reviewerPassEconomics.passes, 1);
  assert.equal(result.reviewerPassEconomics.tokensPerPass, 51);
  assert.equal(result.reviewerPassEconomics.estimatedCostPerPass, 2);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.tokens));
});

test("efficiency does not turn missing cost, timing, or tokens into zero", () => {
  const result = analyzeEfficiency(snapshot([{ id: "empty", reviewer: null }]));
  assert.equal(result.tokens, null);
  assert.equal(result.cost.estimatedUSD, null);
  assert.equal(result.timing.durationMs, null);
  assert.equal(result.availability.available, false);
  assert.equal(result.reasoningOutputMix.output.rate, null);
  assert.equal(result.longContextCrossings.thresholdTokens, LONG_CONTEXT_THRESHOLD_TOKENS);
});

test("cache savings requires recorded pricing evidence and long-context threshold is explicit", () => {
  const result = analyzeEfficiency({ runs: [{
    identity: { agent: "a", model: "m" },
    interval: { start: 0, end: 1 },
    tokens: { input: LONG_CONTEXT_THRESHOLD_TOKENS, output: 1, reasoning: 0, cacheRead: 10, cacheWrite: 0, total: LONG_CONTEXT_THRESHOLD_TOKENS + 11, cacheWriteReporting: { samples: 1 } },
    cost: { usd: 1, reported: true, basis: "reported", pricing: { inputPerToken: 0.002, cacheReadPerToken: 0.0005 } },
    reviewer: null,
    toolEvents: [],
    errors: [],
  }] });
  assert.equal(result.estimatedCacheSavings.estimatedUSD, 0.015);
  assert.equal(result.longContextCrossings.numerator, 1);
  assert.equal(result.longContextCrossings.denominator, 1);
});
