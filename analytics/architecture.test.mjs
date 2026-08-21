import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSnapshot } from "./snapshot.mjs";
import {
  PRIMARY_ROLE_CONFIDENCE_THRESHOLD,
  analyzeArchitecture,
  analyzeExecution,
} from "./architecture.mjs";

function snapshot(reverse = false) {
  const runs = [
    {
      id: "child-run-secret",
      sessionId: "child-session-secret",
      parentId: "root-run-secret",
      createdAt: 30,
      updatedAt: 60,
      agent: "implementor",
      model: "model-b",
      tokens: { input: 10, output: 20, total: 30 },
      cost: 0.2,
      toolEvents: [
        { tool: "write", createdAt: 35, updatedAt: 40 },
        { tool: "mcp:docs", createdAt: 41, updatedAt: 45, count: 2 },
      ],
    },
    {
      id: "root-run-secret",
      sessionId: "root-session-secret",
      createdAt: 0,
      updatedAt: 100,
      agent: "orchestrator",
      model: "model-a",
      tokens: { input: 100, output: 50, total: 150 },
      cost: 1,
      toolEvents: [
        { tool: "task", createdAt: 10, updatedAt: 15 },
        { tool: "mystery", createdAt: 16, updatedAt: 20 },
      ],
    },
  ];
  return normalizeSnapshot({
    range: { from: 0, to: 100 },
    runs: reverse ? [...runs].reverse() : runs,
    sessions: [
      { id: "root-session-secret", createdAt: 0, updatedAt: 100, agent: "orchestrator", model: "model-a" },
      { id: "child-session-secret", parentId: "root-session-secret", createdAt: 30, updatedAt: 60, agent: "implementor", model: "model-b" },
    ],
  });
}

test("architecture is deterministic, frozen, and conserves observed edge weights", () => {
  const first = analyzeArchitecture(snapshot());
  const second = analyzeArchitecture(snapshot(true));
  assert.deepEqual(first, second);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.nodes));
  assert.equal(first.provenance.aliasing, "privacy-safe-deterministic");
  assert.equal(first.nodes.some((node) => node.id.includes("secret")), false);
  assert.deepEqual(first.nodes.filter((node) => node.type).map((node) => node.type), ["agent", "agent", "model", "model", "tool", "tool", "tool", "tool"]);
  assert.doesNotMatch(JSON.stringify(first), /run-\d{3}/);

  const toolEdges = first.edges.filter((edge) => edge.type === "calls-tool");
  assert.equal(toolEdges.reduce((sum, edge) => sum + edge.weight.calls, 0), 5);
  assert.equal(first.edges.filter((edge) => edge.type === "uses-model").reduce((sum, edge) => sum + edge.weight.calls, 0), 2);
  assert.equal(first.edges.filter((edge) => edge.type === "delegates-to").reduce((sum, edge) => sum + edge.weight.calls, 0), 1);
  assert.equal(first.edges.some((edge) => edge.source.startsWith("run-") || edge.target.startsWith("run-")), false);
  assert.equal(first.toolRouting.find((tool) => tool.tool === "mcp:docs").classification, "mcp");
  assert.equal(first.toolRouting.find((tool) => tool.tool === "mystery").classification, "unknown");
  const route = first.toolRouting.find((tool) => tool.tool === "mcp:docs").routes[0];
  assert.deepEqual({ numerator: route.numerator, denominator: route.denominator, share: route.share }, { numerator: 2, denominator: 2, share: 1 });
  assert.equal(first.delegation.delegations, 1);
  assert.equal(first.delegation.maxDepth, 1);
  assert.equal(first.delegation.parentChildTokenRatio, 30 / 150);
});

test("execution aggregates depth, agent, and model without per-run aliases", () => {
  const result = analyzeExecution(snapshot());
  assert.equal(result.provenance.aliasing, "privacy-safe-deterministic");
  assert.deepEqual(result.runs.map((run) => [run.depth, run.agent, run.model, run.count]), [[0, "orchestrator", "model-a", 1], [1, "implementor", "model-b", 1]]);
  assert.equal(result.runs.some((run) => Object.hasOwn(run, "alias") || Object.hasOwn(run, "parentAlias")), false);
  assert.doesNotMatch(JSON.stringify(result), /run-\d{3}/);
  assert.equal(result.runs.some((run) => /secret/i.test(JSON.stringify(run))), false);
  assert.deepEqual(result.summary, {
    roots: 1,
    children: 1,
    maxDepth: 1,
    fanOut: 1,
    approximateCriticalPathMs: 130,
  });

  const cyclic = normalizeSnapshot({ runs: [
    { id: "a", parentId: "b", createdAt: 0, updatedAt: 2, agent: "a" },
    { id: "b", parentId: "a", createdAt: 2, updatedAt: 4, agent: "b" },
    { id: "orphan", parentId: "missing", agent: "orphan" },
  ] });
  assert.doesNotThrow(() => analyzeExecution(cyclic));
  assert.equal(analyzeExecution(normalizeSnapshot({})).summary.approximateCriticalPathMs, 0);
});

test("topology and execution conserve weights while collapsing repeated runs", () => {
  const repeated = normalizeSnapshot({ runs: [
    { id: "first-secret", createdAt: 0, updatedAt: 2, agent: "worker", model: "model-a", tokens: { total: 4 }, cost: 0.1 },
    { id: "second-secret", createdAt: 3, updatedAt: 5, agent: "worker", model: "model-a", tokens: { total: 6 }, cost: 0.2 },
  ] });
  const architecture = analyzeArchitecture(repeated);
  const execution = analyzeExecution(repeated);
  assert.deepEqual(architecture.nodes.map((node) => node.type), ["agent", "model"]);
  assert.equal(architecture.edges.length, 1);
  assert.deepEqual(architecture.edges[0].weight, { calls: 2, tokens: 10, estimatedUsd: 0.30000000000000004, durationMs: 4 });
  assert.deepEqual(execution.runs.map((run) => [run.depth, run.agent, run.model, run.count, run.tokens]), [[0, "worker", "model-a", 2, 10]]);
});

test("role scores stay bounded and primary roles require the documented threshold", () => {
  const result = analyzeArchitecture(snapshot());
  for (const role of result.roles) {
    for (const score of Object.values(role.scores)) assert.ok(score >= 0 && score <= 1);
    if (role.primaryRole !== null) assert.ok(role.confidence.value >= PRIMARY_ROLE_CONFIDENCE_THRESHOLD);
    assert.ok(role.sample.count >= 1);
    assert.ok(role.evidence.length >= 4);
  }
});

test("role inference uses topology, child status, reviewer attribution, names, and tool mix", () => {
  const runs = [];
  for (let index = 0; index < 10; index += 1) {
    runs.push({
      id: `root-${index}`,
      createdAt: index * 100,
      updatedAt: index * 100 + 20,
      agent: "orchestrator",
      model: "coord-model",
      toolEvents: [{ tool: "task", count: 2, createdAt: index * 100 + 1, updatedAt: index * 100 + 2 }],
    });
    runs.push({
      id: `child-${index}`,
      parentId: `root-${index}`,
      createdAt: index * 100 + 30,
      updatedAt: index * 100 + 50,
      agent: "worker",
      model: "worker-model",
      toolEvents: [{ tool: "write", count: 2, createdAt: index * 100 + 31, updatedAt: index * 100 + 32 }],
      reviewer: { agent: "reviewer", verdict: "PASS" },
    });
  }
  const result = analyzeArchitecture(normalizeSnapshot({ runs }));
  const orchestrator = result.roles.find((role) => role.agent === "orchestrator");
  const worker = result.roles.find((role) => role.agent === "worker");
  const reviewer = result.roles.find((role) => role.agent === "reviewer");
  assert.ok(orchestrator);
  assert.ok(worker);
  assert.ok(reviewer);
  assert.ok(orchestrator.evidence.some((entry) => entry.signal === "parent-run-share" && entry.value > 0));
  assert.ok(orchestrator.evidence.some((entry) => entry.signal === "average-parent-fan-out" && entry.value > 0));
  assert.ok(orchestrator.evidence.some((entry) => entry.signal === "successful-child-share" && entry.value === 1));
  assert.ok(worker.evidence.some((entry) => entry.signal === "modifying-tool-share" && entry.value === 1));
  assert.equal(worker.scores.reviewer, 0);
  assert.notEqual(worker.primaryRole, "reviewer");
  assert.ok(reviewer.evidence.some((entry) => entry.signal === "reviewer-attribution-share" && entry.value > 0));
  assert.ok(reviewer.evidence.some((entry) => entry.signal === "explicit-role-name" && entry.value === 1));
  assert.equal(orchestrator.primaryRole, "orchestrator");
  assert.equal(reviewer.primaryRole, "reviewer");
});

test("execution is not mutation evidence and verification-only runs are review-shaped", () => {
  const runs = Array.from({ length: 10 }, (_, index) => ({
    id: `verify-${index}`,
    createdAt: index * 10,
    updatedAt: index * 10 + 5,
    agent: "reviewer",
    model: "gpt-5.6-sol",
    toolEvents: [{ tool: "bash", count: 1 }, { tool: "test", count: 1 }],
  }));
  const role = analyzeArchitecture(normalizeSnapshot({ runs })).roles.find((entry) => entry.agent === "reviewer");
  assert.equal(role.evidence.find((entry) => entry.signal === "modifying-tool-share").value, 0);
  assert.equal(role.evidence.find((entry) => entry.signal === "execution-tool-share").value, 0.5);
  assert.ok(role.evidence.find((entry) => entry.signal === "review-shaped-verification-runs").value > 0);
  assert.match(role.reasoning, /orch/);

  const nameOnly = analyzeArchitecture(normalizeSnapshot({ runs: [{ id: "name-only", agent: "reviewer", model: "gpt-5.6-sol" }] })).roles[0];
  assert.equal(nameOnly.primaryRole, null);
  assert.equal(nameOnly.scores.reviewer, 0);
});
