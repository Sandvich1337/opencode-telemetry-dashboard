import assert from "node:assert/strict";
import test from "node:test";

import { createSnapshot } from "./snapshot.mjs";
import { analyzeThroughput } from "./throughput.mjs";

function snapshot(runs, range = { from: 0, to: 1_800_000 }) {
  return createSnapshot({ range, runs });
}

function run(id, agent, start, end, tokens, cost = null, toolEvents = []) {
  return {
    id,
    agent,
    interval: { start, end },
    tokens,
    ...(cost === null ? {} : { cost }),
    toolEvents,
  };
}

test("throughput unions wall time but sums parallel work and conserves buckets", () => {
  const result = analyzeThroughput(snapshot([
    run("a", "alpha", 0, 1_000_000, { total: 10, output: 4, reasoning: 2 }, 0.5, [{ tool: "compile", count: 2, interval: { start: 0, end: 1_000_000 } }]),
    run("b", "beta", 500_000, 1_500_000, { total: 20, output: 8, reasoning: 2 }, 1.5, [{ tool: "test", count: 1, interval: { start: 500_000, end: 1_500_000 } }]),
  ]));

  assert.equal(result.basis.activeWallMs, 1_500_000);
  assert.equal(result.basis.summedWorkMs, 2_000_000);
  assert.equal(result.basis.parallelism, 2_000_000 / 1_500_000);
  assert.deepEqual(result.totals.tokens, { processed: 30, generated: 16, output: 12 });
  assert.equal(result.totals.calls, 3);
  assert.equal(result.totals.rates.processedTokensPerMinute, 30 / 25);
  assert.equal(result.totals.estimatedUsd, 2);
  assert.equal(result.totals.rates.estimatedUsdPerHour, 2 / (1_500_000 / 3_600_000));
  assert.deepEqual(Object.keys(result.totals), ["tokens", "calls", "estimatedUsd", "rates"]);
  assert.equal(result.tokens, undefined);
  assert.equal(result.calls, undefined);
  assert.equal(result.estimatedUsd, undefined);
  assert.equal(result.provenance.source, "normalized-snapshot");
  assert.ok(result.confidence.sample);
  assert.equal(result.byAgent[0].agent, "alpha");
  assert.equal(result.byAgent[0].activeMs, 1_000_000);
  assert.equal(result.series.length, 2);
  assert.deepEqual(result.series.reduce((total, bucket) => total + bucket.tokens.processed, 0), result.totals.tokens.processed);
  assert.equal(result.series.reduce((total, bucket) => total + bucket.calls, 0), result.totals.calls);
  assert.equal(result.series[0].concurrency, 1_300_000 / 900_000);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.series[0]));
});

test("clamps intervals, splits cross-bucket work, and keeps cost unavailable explicit", () => {
  const result = analyzeThroughput(snapshot([
    run("cross", "agent", -100_000, 1_900_000, { total: 10, output: 6, reasoning: 2 }),
    run("invalid", "ignored", 10, 10, { total: 100 }),
    run("bad", "ignored", 20, 10, { total: 100 }),
  ], { from: 0, to: 1_800_000 }));

  assert.equal(result.basis.activeWallMs, 1_800_000);
  assert.equal(result.basis.summedWorkMs, 1_800_000);
  assert.equal(result.series.length, 2);
  assert.deepEqual(result.series.map((bucket) => bucket.tokens.processed), [5, 5]);
  assert.equal(result.series[0].estimatedUsd, null);
  assert.equal(result.totals.estimatedUsd, null);
  assert.equal(result.totals.rates.estimatedUsdPerHour, null);
  assert.equal(result.rateReasons.estimatedUsdPerHour, "cost-unavailable");
  assert.equal(result.sample.count, 3);
  assert.equal(result.sample.observed, 1);
});

test("zero-duration timing makes every rate null while preserving deterministic evidence", () => {
  const result = analyzeThroughput(snapshot([
    run("zero", "agent", 5, 5, { total: 4, output: 1 }),
  ], { from: 0, to: 10 }));
  assert.equal(result.availability.available, false);
  assert.equal(result.availability.reason, "no-positive-interval");
  assert.equal(result.totals.rates.processedTokensPerMinute, null);
  assert.equal(result.totals.rates.toolCallsPerMinute, null);
  assert.equal(result.series.length, 1);
  assert.equal(result.series[0].activeMs, 0);
});
