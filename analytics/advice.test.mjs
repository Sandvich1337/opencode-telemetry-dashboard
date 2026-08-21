import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSnapshot } from "./snapshot.mjs";
import { analyzeArchitecture, analyzeExecution } from "./architecture.mjs";
import { buildAdvice } from "./advice.mjs";

function runFixture(count = 1, withError = false) {
  const runs = Array.from({ length: count }, (_, index) => ({
    id: `run-${index}`,
    createdAt: index * 10,
    updatedAt: index * 10 + 5,
    agent: index === 0 ? "orchestrator" : "worker",
    model: "model",
    errors: withError && index === 0 ? [{ kind: "failed", count: 1 }] : [],
    toolEvents: [{ tool: "mystery", createdAt: index * 10, updatedAt: index * 10 + 1, count: 1 }],
  }));
  return normalizeSnapshot({ runs, provenance: { capabilities: { parts: { available: false, basis: "unavailable", reason: "missing" } } } });
}

test("ordinary advice is sample-gated while hard failures are not", () => {
  const small = runFixture(2);
  const smallAdvice = buildAdvice(small, { architecture: analyzeArchitecture(small), execution: analyzeExecution(small) });
  assert.equal(smallAdvice.items.some((entry) => entry.code === "tool-classification-unknown"), false);
  assert.equal(smallAdvice.items.some((entry) => entry.code === "capability-unavailable"), true);
  assert.equal(smallAdvice.items.every((entry) => entry.evidence.length > 0), true);
  assert.equal(smallAdvice.provenance.method, "deterministic-local-rules");
  assert.ok(Object.isFrozen(smallAdvice));

  const errorAdvice = buildAdvice(runFixture(1, true));
  assert.equal(errorAdvice.items.some((entry) => entry.code === "execution-errors"), true);
  assert.equal(errorAdvice.items.some((entry) => entry.code === "tool-classification-unknown"), false);
});

test("advice ordering and output are deterministic for a sufficiently large sample", () => {
  const first = runFixture(20);
  const second = runFixture(20);
  const firstAdvice = buildAdvice(first);
  const secondAdvice = buildAdvice(second);
  assert.deepEqual(firstAdvice, secondAdvice);
  assert.ok(firstAdvice.items.some((entry) => entry.code === "tool-classification-unknown"));
  assert.equal(firstAdvice.items.every((entry) => entry.sample.count >= 1), true);
  assert.equal(firstAdvice.items.some((entry) => entry.code === "tool-classification-unknown" && entry.sample.count < 20), false);
  assert.equal(firstAdvice.items.every((entry) => entry.reasoning.length < 160), true);
  assert.equal(firstAdvice.items.every((entry) => !entry.reasoning.includes("…")), true);
  assert.equal(firstAdvice.items.every((entry) => !/^Because .*?,/i.test(entry.reasoning)), true);
  assert.match(firstAdvice.items.find((entry) => entry.code === "tool-classification-unknown").reasoning, /Provider metadata/);
  assert.match(firstAdvice.summary, /deterministic advice item/);
});

test("decision support reports workflow heuristics, access channels, and bounded soft conclusions", () => {
  const runs = Array.from({ length: 20 }, (_, index) => {
    const worker = index < 2;
    return {
      id: `run-${index}`,
      createdAt: index * 100,
      updatedAt: index * 100 + 50,
      agent: worker ? "worker" : "orchestrator",
      model: worker ? "worker-model" : "coordinator-model",
      ...(worker ? { parentId: "worker-parent" } : {}),
      cost: worker ? 0.1 : 1,
      tokens: { input: 100, output: 20, reasoning: 5, cacheRead: 10, cacheWrite: 1 },
      toolEvents: worker
        ? [{ tool: "bash", count: 2, createdAt: index * 100 + 1, updatedAt: index * 100 + 2 }]
        : [
          { tool: "read", count: 1, createdAt: index * 100 + 1, updatedAt: index * 100 + 2 },
          { tool: "search", count: 2, createdAt: index * 100 + 3, updatedAt: index * 100 + 4 },
          { tool: "read", count: 2, createdAt: index * 100 + 4, updatedAt: index * 100 + 5 },
          { tool: "argus_search_web", count: 1, createdAt: index * 100 + 5, updatedAt: index * 100 + 6 },
          { tool: "memory_search", count: 1, createdAt: index * 100 + 7, updatedAt: index * 100 + 8 },
          { tool: "mcp:docs", count: 1, createdAt: index * 100 + 9, updatedAt: index * 100 + 10 },
          { tool: "task", count: 1, createdAt: index * 100 + 11, updatedAt: index * 100 + 12 },
        ],
      ...(worker && index === 0 ? { errors: [{ kind: "failed", count: 1 }] } : {}),
    };
  });
  const snapshot = normalizeSnapshot({ runs });
  const advice = buildAdvice(snapshot);
  const support = advice.decisionSupport;
  assert.deepEqual(support.principles.map((row) => row.key), ["intelligence", "cost", "speed"]);
  assert.equal(support.principles.find((row) => row.key === "intelligence").score !== null, true);
  assert.equal(support.principles.find((row) => row.key === "cost").score !== null, true);
  assert.equal(support.principles.find((row) => row.key === "speed").score !== null, true);
  assert.ok(support.conclusions.some((entry) => entry.code === "coordinator-read-search-cost"));
  assert.ok(support.conclusions.some((entry) => entry.code === "worker-relaunch-pressure"));
  assert.ok(support.conclusions.some((entry) => entry.code === "reviewer-evidence-missing"));
  const channels = new Map(support.accessChannels.map((row) => [row.key, row]));
  assert.equal(channels.get("web").tools.find((tool) => tool.tool === "argus_search_web").provider, "argus");
  assert.equal(channels.get("memory").calls, 18);
  assert.equal(channels.get("other").tools.find((tool) => tool.tool === "mcp:docs").provider, "mcp");
  assert.match(support.conclusions.find((entry) => entry.code === "worker-relaunch-pressure").suggestion, /proxy/);
  assert.match(support.conclusions.find((entry) => entry.code === "worker-relaunch-pressure").evidence.join(" "), /same-parent-runs-after-error:1/);
  assert.match(support.conclusions.find((entry) => entry.code === "worker-relaunch-pressure").reasoning, /Ordered same-parent post-error runs show relaunch pressure/);
  assert.match(support.conclusions.find((entry) => entry.code === "reviewer-evidence-missing").reasoning, /quality unobservable/);
  assert.equal(support.conclusions.every((entry) => entry.reasoning.length < 160 && !entry.reasoning.includes("…")), true);
  assert.doesNotMatch(JSON.stringify(support.conclusions.find((entry) => entry.code === "worker-relaunch-pressure")), /max-step|retry/i);
  for (const row of support.principles) {
    if (row.score !== null) assert.ok(row.score >= 0 && row.score <= 100);
    assert.ok(row.evidence.length > 0);
  }
});

test("decision support consumes supplied throughput and efficiency evidence", () => {
  const snapshot = normalizeSnapshot({ runs: Array.from({ length: 20 }, (_, index) => ({
    id: `run-${index}`,
    createdAt: index * 100,
    updatedAt: index * 100 + 50,
    agent: "worker",
    toolEvents: [{ tool: "task", count: 20 }],
  })) });
  const advice = buildAdvice(snapshot, {
    throughput: {
      basis: { activeWallMs: 1_000, summedWorkMs: 2_000, parallelism: 2 },
      totals: { estimatedUsd: 2 },
      costAvailability: { available: true },
    },
    efficiency: {
      measuredSamples: { tokens: 20, cost: 20 },
      tokens: { input: 1_000, output: 400, reasoning: 100, cacheRead: 200, cacheWrite: 20 },
      timing: { durationMs: 2_000 },
      cost: { estimatedUSD: 2 },
    },
  });
  const byKey = new Map(advice.decisionSupport.principles.map((row) => [row.key, row]));
  assert.notEqual(byKey.get("cost").score, null);
  assert.notEqual(byKey.get("speed").score, null);
  assert.match(byKey.get("cost").evidence.join(" "), /token-input:1000/);
  assert.match(byKey.get("speed").evidence.join(" "), /active-wall-ms:1000/);
  assert.match(byKey.get("speed").evidence.join(" "), /parallelism:2/);
});

test("relaunch pressure rejects independent root runs", () => {
  const snapshot = normalizeSnapshot({ runs: Array.from({ length: 20 }, (_, index) => ({
    id: `root-worker-${index}`,
    createdAt: index * 100,
    updatedAt: index * 100 + 50,
    parentId: null,
    agent: "worker",
    toolEvents: [{ tool: "bash", count: 2 }],
    ...(index === 0 ? { errors: [{ kind: "failed", count: 1 }] } : {}),
  })) });
  const advice = buildAdvice(snapshot);
  assert.equal(advice.decisionSupport.conclusions.some((entry) => entry.code === "worker-relaunch-pressure"), false);
});

test("intelligence allocation uses the coordinator's own read share", () => {
  const snapshot = normalizeSnapshot({ runs: Array.from({ length: 20 }, (_, index) => ({
    id: `role-${index}`,
    createdAt: index * 100,
    updatedAt: index * 100 + 50,
    agent: index < 10 ? "orchestrator" : "worker",
    toolEvents: index < 10 ? [{ tool: "task", count: 2 }] : [{ tool: "read", count: 20 }],
  })) });
  const intelligence = buildAdvice(snapshot).decisionSupport.principles.find((row) => row.key === "intelligence");
  assert.match(intelligence.evidence.join(" "), /coordinator-read-share:0/);
});

test("intelligence components use fixed target coverage and explain missing evidence", () => {
  const make = (count) => normalizeSnapshot({ runs: Array.from({ length: count }, (_, index) => ({
    id: `scaled-${count}-${index}`,
    agent: "orchestrator",
    model: "gpt-5.6-sol",
    tokens: { input: 10, output: 5 },
    cost: { usd: 1, basis: "estimated", reported: false },
    toolEvents: [{ tool: "graphify_query", count: 20 }],
  })) });
  const small = buildAdvice(make(10)).decisionSupport.principles.find((row) => row.key === "intelligence");
  const large = buildAdvice(make(20)).decisionSupport.principles.find((row) => row.key === "intelligence");
  assert.equal(large.score, small.score);
  assert.match(large.reasoning, /navigation 30%/);
  assert.match(large.reasoning, /Contributions:/);
  assert.match(large.reasoning, /Missing evidence:.*delegation target/);
  assert.doesNotMatch(large.reasoning, /model intelligence/i);
});

test("low nonzero Graphify/AFT share remains actionable and provider names stay explicit", () => {
  const runs = Array.from({ length: 20 }, (_, index) => ({
    id: `run-${index}`,
    createdAt: index * 100,
    updatedAt: index * 100 + 50,
    agent: "orchestrator",
    cost: 1,
    tokens: { input: 100, output: 20, reasoning: 5, cacheRead: 10, cacheWrite: 1 },
    toolEvents: [
      { tool: "read", count: 8 },
      ...(index === 0 ? [{ tool: "graphify_query", count: 1 }] : []),
      { tool: "websearch", count: 1 },
      { tool: "webfetch", count: 1 },
      { tool: "openchamber-web", count: 1 },
      { tool: "mcp/docs", count: 1 },
      { tool: "mcp.docs", count: 1 },
      { tool: "mcp@docs", count: 1 },
    ],
  }));
  const advice = buildAdvice(normalizeSnapshot({ runs }));
  const finding = advice.decisionSupport.conclusions.find((entry) => entry.code === "coordinator-read-search-cost");
  assert.ok(finding);
  assert.match(finding.evidence.join(" "), /graphify-aft-calls:1/);
  const webTools = new Map(advice.decisionSupport.accessChannels.find((row) => row.key === "web").tools.map((tool) => [tool.tool, tool]));
  assert.equal(webTools.get("websearch").provider, "websearch");
  assert.equal(webTools.get("webfetch").provider, "webfetch");
  assert.equal(webTools.get("openchamber-web").provider, "openchamber-web");
  const mcpTools = advice.decisionSupport.accessChannels.flatMap((row) => row.tools).filter((tool) => tool.tool.startsWith("mcp"));
  assert.equal(mcpTools.every((tool) => tool.provider === "mcp" && tool.classification === "mcp"), true);
});

test("decision support leaves unavailable principle scores null without reported cost", () => {
  const snapshot = normalizeSnapshot({ runs: Array.from({ length: 20 }, (_, index) => ({
    id: `run-${index}`,
    createdAt: index,
    updatedAt: index + 1,
    agent: "worker",
    toolEvents: [{ tool: "read", count: 1 }],
  })) });
  const support = buildAdvice(snapshot).decisionSupport;
  assert.equal(support.principles.find((row) => row.key === "cost").score, null);
  assert.equal(support.principles.find((row) => row.key === "intelligence").score, null);
});

test("live-sized call volume uses fixed intelligence targets and run-cost basis", () => {
  const runs = [];
  for (let index = 0; index < 10; index += 1) {
    runs.push({
      id: `sol-${index}`,
      agent: "sol-build",
      model: "gpt-5.6-sol",
      createdAt: index * 100,
      updatedAt: index * 100 + 50,
      cost: { usd: 3.95, basis: "estimated", reported: false },
      tokens: { input: 1_000, output: 500, reasoning: 100 },
      toolEvents: [{ tool: "graphify_query", count: 2 }, { tool: "task", count: 1 }],
    });
    runs.push({
      id: `luna-${index}`,
      parentId: `sol-${index}`,
      agent: "luna-worker",
      model: "gpt-5.6-luna",
      createdAt: index * 100 + 10,
      updatedAt: index * 100 + 60,
      cost: { usd: 3.95, basis: "estimated", reported: false },
      tokens: { input: 1_000, output: 500, reasoning: 100 },
      toolEvents: [{ tool: "graphify_query", count: 2 }, { tool: "bash", count: 779 }],
    });
  }
  const support = buildAdvice(normalizeSnapshot({ runs }), {
    throughput: { totals: { estimatedUsd: 0 }, costAvailability: { available: true, basis: "reported" } },
    efficiency: {
      measuredSamples: { tokens: 20 },
      tokens: { input: 20_000, output: 10_000, reasoning: 2_000, cacheRead: 0, cacheWrite: 0 },
      timing: { durationMs: 1_000 },
    },
  }).decisionSupport;
  const intelligence = support.principles.find((row) => row.key === "intelligence");
  const cost = support.principles.find((row) => row.key === "cost");
  assert.equal(runs.reduce((sum, run) => sum + run.toolEvents[0].count + (run.toolEvents[1]?.count ?? 0), 0), 7_840);
  assert.ok(intelligence.score >= 70);
  assert.match(intelligence.reasoning, /navigation 30%.*delegation 25%.*coordinator 20%/);
  assert.ok(intelligence.reasoning.length < 160);
  assert.match(cost.evidence.join(" "), /run-cost-usd:79/);
  assert.match(cost.evidence.join(" "), /cost-basis:estimated/);
  assert.notEqual(cost.score, null);
  assert.ok(support.conclusions.every((entry) => entry.reasoning.length < 160 && entry.reasoning !== entry.evidence.join("; ")));
  const roles = analyzeArchitecture(normalizeSnapshot({ runs })).roles;
  assert.equal(roles.find((role) => role.agent === "sol-build").primaryRole, "orchestrator");
  assert.equal(roles.find((role) => role.agent === "luna-worker").primaryRole, "implementor");
  assert.ok(roles.every((role) => role.reasoning.length < 160));
});
