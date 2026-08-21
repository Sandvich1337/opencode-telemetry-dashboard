import assert from "node:assert/strict";
import test from "node:test";

import { createSnapshot } from "./snapshot.mjs";
import { analyzeFailures } from "./failures.mjs";

function run(toolEvents, extra = {}) {
  return {
    id: extra.id ?? "run",
    createdAt: 0,
    updatedAt: 100,
    agent: extra.agent ?? "agent",
    model: extra.model ?? "model",
    toolEvents,
    ...extra,
  };
}

test("failures reports tool, agent, and model hotspots without double counting errors", () => {
  const snapshot = createSnapshot({ sessions: [run([
    { tool: "build", count: 1, error: true, interval: { start: 10, end: 20 } },
    { tool: "build", count: 1, interval: { start: 30, end: 40 } },
    { tool: "test", count: 1, interval: { start: 50, end: 60 } },
  ], { id: "one", agent: "a", model: "m" })] });
  const result = analyzeFailures(snapshot);
  assert.equal(result.totals.calls, 3);
  assert.equal(result.totals.errors, 1);
  assert.equal(result.toolHotspots[0].tool, "build");
  assert.equal(result.toolHotspots[0].numerator, 1);
  assert.equal(result.toolHotspots[0].denominator, 2);
  assert.equal(result.agentHotspots[0].agent, "a");
  assert.equal(result.modelHotspots[0].model, "m");
  assert.equal(result.repeatAfterError.length, 1);
  assert.equal(result.repeatAfterError[0].label, "repeat-after-error");
  assert.equal(result.repeatAfterError[0].rate, 1);
});

test("aggregate counts and missing order cannot imply repeat-after-error", () => {
  const raw = { runs: [
    {
      identity: { agent: "a", model: "m" },
      toolEvents: [
        { tool: "build", count: 2, error: true, interval: { start: 10, end: 20 } },
        { tool: "build", count: 1, interval: { start: 30, end: 40 } },
      ],
      errors: [{ kind: "error", count: 2, interval: { start: 10, end: 20 } }],
    },
    {
      identity: { agent: "a", model: "m" },
      toolEvents: [
        { tool: "test", count: 1, error: true, interval: { start: null, end: null } },
        { tool: "test", count: 1, interval: { start: null, end: null } },
      ],
      errors: [],
    },
  ] };
  const result = analyzeFailures(raw);
  assert.deepEqual(result.repeatAfterError, []);
  assert.equal(result.repeatAfterErrorCount, 0);
  assert.equal(result.repeatAfterErrorRate.rate, null);
});

test("failure rates expose denominator and minimum-sample evidence", () => {
  const result = analyzeFailures({ runs: [{
    identity: { agent: "a", model: "m" },
    toolEvents: [{ tool: "x", count: 1, error: true, interval: { start: 1, end: 2 } }],
    errors: [{ kind: "error", count: 1, interval: { start: 1, end: 2 } }],
  }] });
  assert.equal(result.totals.errorRateEvidence.numerator, 1);
  assert.equal(result.totals.errorRateEvidence.denominator, 1);
  assert.deepEqual(result.totals.errorRateEvidence.minimumSample, { required: 1, observed: 1, met: true });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.toolHotspots[0]));
});
