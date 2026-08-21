import assert from "node:assert/strict";
import test from "node:test";

import { createSnapshot } from "./snapshot.mjs";
import { analyzeTrends } from "./trends.mjs";

function snapshot(total) {
  return createSnapshot({
    range: { from: 0, to: 60_000 },
    runs: [{
      id: `run-${total}`,
      agent: "agent",
      interval: { start: 0, end: 60_000 },
      tokens: { total, output: total },
      toolEvents: [{ count: 1, interval: { start: 0, end: 60_000 } }],
    }],
  });
}

test("trends expose stable current/previous throughput and absolute deltas", () => {
  const result = analyzeTrends(snapshot(20), snapshot(10));
  assert.equal(result.availability.available, true);
  assert.equal(result.current.totals.tokens.processed, 20);
  assert.equal(result.previous.totals.tokens.processed, 10);
  assert.equal(result.deltas.tokens.processed, 10);
  assert.equal(result.deltas.calls, 0);
  assert.equal(result.deltas.totals.processedTokensPerMinute, 10);
  assert.equal(result.deltaReasons.availability, "comparison-ready");
  assert.equal(result.provenance.method, "current-minus-previous");
  assert.ok(result.confidence.sample);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.deltas));
});

test("trends remain unavailable without a previous period", () => {
  const result = analyzeTrends(snapshot(10));
  assert.equal(result.previous, null);
  assert.equal(result.availability.available, false);
  assert.equal(result.availability.reason, "previous-unavailable");
  assert.equal(result.deltas.tokens.processed, null);
  assert.equal(result.deltaReasons.tokens.processed, "previous-unavailable");
});
