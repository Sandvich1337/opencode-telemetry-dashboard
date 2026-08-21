import assert from "node:assert/strict";
import test from "node:test";

import { createSnapshot } from "./snapshot.mjs";
import { analyzeComparisons } from "./comparisons.mjs";

function fixture() {
  return createSnapshot({ sessions: [
    { id: "z", createdAt: 20, updatedAt: 40, agent: "zeta", model: "model-z", tokens: { input: 10, output: 4 }, cost: 2, reviewer: { agent: "r", verdict: "PASS" }, toolEvents: [{ tool: "build", count: 2, interval: { start: 21, end: 22 } }] },
    { id: "a", createdAt: 0, updatedAt: 10, agent: "alpha", model: "model-a", tokens: { input: 5, output: 5 }, cost: 1, reviewer: { agent: "r", verdict: "ISSUE" }, toolEvents: [{ tool: "build", count: 1, interval: { start: 1, end: 2 }, error: true }] },
    { id: "unknown", agent: "alpha", model: "model-a" },
  ] });
}

test("comparisons expose stable agent/model rows and conserved tokens", () => {
  const result = analyzeComparisons(fixture());
  assert.deepEqual(result.byAgent.map((row) => row.agent), ["alpha", "zeta"]);
  assert.deepEqual(result.byModel.map((row) => row.model), ["model-a", "model-z"]);
  const alpha = result.byAgent[0];
  assert.equal(alpha.runs, 2);
  assert.equal(alpha.estimatedCost, 1);
  assert.equal(alpha.tokens.total, alpha.tokens.input + alpha.tokens.output + alpha.tokens.reasoning + alpha.tokens.cacheRead + alpha.tokens.cacheWrite);
  assert.equal(alpha.calls, 1);
  assert.equal(alpha.errorRate, 1);
  assert.equal(alpha.reviewerOutcomes.counts.PASS, 0);
  assert.equal(alpha.reviewerOutcomes.counts.ISSUE, 1);
});

test("comparisons keep unknown cost and timing null instead of manufacturing zeroes", () => {
  const result = analyzeComparisons({ runs: [{ identity: { agent: "a", model: "m" }, interval: { start: null, end: null }, tokens: null, cost: { usd: 0, reported: false }, toolEvents: [], errors: [], reviewer: null }] });
  const row = result.byAgent[0];
  assert.equal(row.estimatedCost, null);
  assert.equal(row.duration, null);
  assert.equal(row.cacheShare, null);
  assert.equal(row.errorRate, null);
  assert.equal(row.tokens, null);
});

test("comparison ties use lexical labels, not input order", () => {
  const first = analyzeComparisons({ runs: [
    { identity: { agent: "b", model: "y" }, tokens: null, cost: { reported: false }, interval: { start: null, end: null }, toolEvents: [], errors: [], reviewer: null },
    { identity: { agent: "a", model: "x" }, tokens: null, cost: { reported: false }, interval: { start: null, end: null }, toolEvents: [], errors: [], reviewer: null },
  ] });
  const second = analyzeComparisons({ runs: [
    { identity: { agent: "a", model: "x" }, tokens: null, cost: { reported: false }, interval: { start: null, end: null }, toolEvents: [], errors: [], reviewer: null },
    { identity: { agent: "b", model: "y" }, tokens: null, cost: { reported: false }, interval: { start: null, end: null }, toolEvents: [], errors: [], reviewer: null },
  ] });
  assert.deepEqual(first, second);
});
