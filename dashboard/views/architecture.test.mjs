import assert from "node:assert/strict";
import test from "node:test";

import { createArchitectureView, renderArchitectureView } from "./architecture.mjs";

function payload(overrides = {}) {
  return {
    analytics: {
      architecture: {
        availability: { available: true, basis: "observed", reason: "present", sample: { count: 2, observed: 2, denominator: 2 } },
        sample: { count: 2, observed: 2, denominator: 2 },
        confidence: { value: 0.8, basis: "derived", reason: "limited-sample", sample: { count: 2, observed: 2, denominator: 2 } },
        summary: "2 agents across 2 runs; 1 delegation; 2 tool calls across 1 tool.",
        nodes: [
          { id: "agent-001", type: "agent", label: "implementor", calls: 1, tokens: 30, estimatedUsd: 0.2, durationMs: 30 },
          { id: "agent-002", type: "agent", label: "orchestrator", calls: 2, tokens: 150, estimatedUsd: 1, durationMs: 100 },
          { id: "model-001", type: "model", label: "model-a", calls: 1, tokens: 150, estimatedUsd: 1, durationMs: 100 },
          { id: "model-002", type: "model", label: "model-b", calls: 1, tokens: 30, estimatedUsd: 0.2, durationMs: 30 },
          { id: "tool-001", type: "tool", label: "mcp:docs", calls: 2, tokens: 0, estimatedUsd: 0, durationMs: 20 },
        ],
        edges: [
          { type: "delegates-to", source: "agent-002", target: "agent-001", weight: { calls: 1, tokens: 30, estimatedUsd: 0.2, durationMs: 30 } },
          { type: "uses-model", source: "agent-002", target: "model-001", weight: { calls: 1, tokens: 150, estimatedUsd: 1, durationMs: 100 } },
          { type: "uses-model", source: "agent-001", target: "model-002", weight: { calls: 1, tokens: 30, estimatedUsd: 0.2, durationMs: 30 } },
          { type: "calls-tool", source: "agent-002", target: "tool-001", weight: { calls: 2, tokens: 0, estimatedUsd: 0, durationMs: 20 } },
        ],
        roles: [{
          agent: "orchestrator", agentAlias: "agent-001", primaryRole: "orchestrator",
          scores: { orchestrator: 0.9, implementor: 0.1 },
          confidence: { value: 0.8, reason: "limited-sample" }, sample: { count: 2, observed: 2, denominator: 2 },
          reasoning: "Coordination and parent fan-out contributed; reviewer outcomes are missing.",
          evidence: [{ signal: "root-share", numerator: 1, denominator: 2, value: 0.5 }],
        }],
        toolRouting: [{
          tool: "mcp:docs", toolAlias: "tool-001", classification: "mcp", calls: 2,
          confidence: { value: 0.98, reason: "explicit-prefix" },
          routes: [{ agent: "orchestrator", agentAlias: "agent-001", numerator: 2, denominator: 2, share: 1 }],
        }],
        delegation: { availability: { available: true, reason: "parent-links" }, delegations: 1, fanOut: 1, maxFanOut: 1, maxDepth: 1, parentChildTokenRatio: 0.5, approximateCriticalPathMs: 130 },
      },
      execution: {
        availability: { available: true, reason: "present" },
        summary: { roots: 1, children: 2, maxDepth: 1, fanOut: 2, approximateCriticalPathMs: 130 },
        summaryText: "1 root, 2 child runs, maximum depth 1, average fan-out 2.",
        runs: [
          { agent: "orchestrator", model: "model-a", depth: 0, durationMs: 100, tokens: 150, estimatedUsd: 1, toolCalls: 1, errors: 0 },
          { agent: "implementor", model: "model-b", depth: 1, durationMs: 30, tokens: 30, estimatedUsd: 0.2, toolCalls: 1, errors: 0 },
          { agent: "implementor", model: "model-b", depth: 1, durationMs: 20, tokens: 20, estimatedUsd: 0.1, toolCalls: 2, errors: 0 },
        ],
      },
      advice: {
        availability: { available: true, basis: "derived", reason: "actionable-findings" },
        summary: "1 deterministic advice item.",
        items: [{ code: "delegation-fanout", severity: "warning", title: "Delegation fan-out is high", suggestion: "Review coordinator boundaries.", reasoning: "Fan-out exceeded the observed threshold.", evidence: ["average-fan-out:4"], sample: { count: 10, observed: 10, denominator: 10 }, confidence: { value: 0.8, reason: "sampled" } }],
      },
    },
  };
}

test("metric controls deterministically switch topology and execution values", () => {
  const calls = renderArchitectureView({ payload: payload() }, { metric: "calls" });
  const tokens = renderArchitectureView({ payload: payload() }, { metric: "tokens" });
  assert.match(calls, /data-selected-metric="calls"/);
  assert.match(calls, /aria-pressed="true">Calls/);
  assert.match(tokens, /data-selected-metric="tokens"/);
  assert.match(tokens, /aria-pressed="true">Tokens/);
  assert.notEqual(calls, tokens);
  assert.match(tokens, />150<\/span>/);
});

test("topology SVG and execution tree expose the selected metric", () => {
  const html = renderArchitectureView({ payload: payload() }, { metric: "tokens" });
  assert.match(html, /class="architecture-topology-svg"/);
  assert.match(html, /role="img" aria-labelledby="architecture-topology-svg-title architecture-topology-svg-description"/);
  assert.match(html, /Accessible topology table/);
  assert.match(html, /class="architecture-execution-tree" role="tree"/);
  assert.match(html, /data-value-metric="tokens">150<\/strong>/);
  assert.match(html, /aria-level="2"/);
});

test("unavailable evidence stays reasoned instead of becoming zero", () => {
  const html = renderArchitectureView({ payload: { analytics: {
    architecture: { availability: { available: false, basis: "unavailable", reason: "no-runs", sample: { count: 0, observed: 0, denominator: 0 } } },
    execution: { availability: { available: false, reason: "missing" } },
    advice: { availability: { available: false, reason: "no-runs" } },
  } } });
  assert.match(html, /Architecture topology evidence unavailable/);
  assert.match(html, /Reason: no-runs/);
  assert.match(html, /Execution evidence unavailable/);
  assert.match(html, /Advice unavailable/);
  assert.match(html, /—/);
});

test("markup escapes labels, evidence, and advice text", () => {
  const unsafe = payload();
  unsafe.analytics.architecture.summary = "<script>alert(1)</script>";
  unsafe.analytics.architecture.nodes[0].label = "<img src=x onerror=alert(1)>";
  unsafe.analytics.advice.items[0].title = "<b>unsafe</b>";
  unsafe.analytics.advice.items[0].evidence = ["<secret>value</secret>"];
  const html = renderArchitectureView({ payload: unsafe });
  assert.doesNotMatch(html, /<script>|<img|<b>unsafe|<secret>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("topology, confidence, routing, advice, and bottlenecks are represented", () => {
  const html = renderArchitectureView({ payload: payload() });
  assert.match(html, /Layered topology/);
  assert.match(html, /Agents use models and tools/);
  assert.doesNotMatch(html, /Agents coordinate runs/);
  assert.equal((html.match(/class="architecture-topology-layer"/g) ?? []).length, 3);
  assert.match(html, /class="architecture-edge-source"/);
  assert.match(html, /class="architecture-edge-target"/);
  assert.match(html, /class="architecture-edge-metric"/);
  assert.doesNotMatch(html, /run-\d{3}/);
  assert.match(html, /Role evidence/);
  assert.match(html, /Reasoning:/);
  assert.match(html, /Tool routing shares/);
  assert.match(html, /mcp:docs/);
  assert.match(html, /Delegation bottlenecks/);
  assert.match(html, /Approximate/);
  assert.match(html, /Advice/);
  assert.match(html, /Delegation fan-out is high/);
  assert.match(html, /Nonvisual semantic equivalent/);
});

test("routing evidence stays bounded and uses privacy-safe stable aliases", () => {
  const source = payload();
  const route = source.analytics.architecture.toolRouting[0].routes[0];
  route.agentAlias = "builder";
  route.agent = "private-agent-name";
  route.share = 2;
  source.analytics.architecture.toolRouting[0].classificationEvidence = ["prefix:mcp"];
  const html = renderArchitectureView({ payload: source });
  assert.match(html, /Routing evidence/);
  assert.match(html, /prefix:mcp/);
  assert.match(html, /agent-unknown/);
  assert.doesNotMatch(html, /private-agent-name/);
  assert.doesNotMatch(html, /value="2"/);
});

test("execution renders compact deterministic aggregates without run aliases", () => {
  const html = renderArchitectureView({ payload: payload() });
  assert.match(html, /Execution aggregates grouped by depth, agent, and model/);
  assert.match(html, /<th scope="col">Depth<\/th>/);
  assert.equal((html.match(/class="architecture-summary-tile"/g) ?? []).length, 5);
  assert.match(html, /model-b<\/td>\s*<td>2<\/td>/);
  assert.doesNotMatch(html, /data-run-alias|run-\d{3}/);
  assert.doesNotMatch(html, /secret|root-run/);
  assert.match(html, /nested duration estimate; not wall-clock/);
});

test("lifecycle attaches one delegated listener and removes it on destroy", () => {
  const listeners = new Map();
  const root = {
    innerHTML: "",
    addEventListener(type, listener) { listeners.set(type, (listeners.get(type) ?? 0) + 1); this.listener = listener; },
    removeEventListener(type) { listeners.set(type, Math.max(0, (listeners.get(type) ?? 1) - 1)); },
    contains() { return true; },
    replaceChildren() { this.innerHTML = ""; },
  };
  const view = createArchitectureView();
  view.mount({ root, payload: payload() });
  view.update({ root, payload: payload() });
  assert.equal(listeners.get("click"), 1);
  view.destroy();
  assert.equal(listeners.get("click"), 0);
  assert.equal(root.innerHTML, "");
});
