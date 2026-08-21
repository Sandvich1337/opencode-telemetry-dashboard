import assert from "node:assert/strict";
import test from "node:test";

import { analyzeArchitecture, analyzeExecution } from "../../analytics/architecture.mjs";
import { analyzeComparisons } from "../../analytics/comparisons.mjs";
import { analyzeEfficiency } from "../../analytics/efficiency.mjs";
import { analyzeFailures } from "../../analytics/failures.mjs";
import { analyzeThroughput } from "../../analytics/throughput.mjs";
import { analyzeTrends } from "../../analytics/trends.mjs";
import { buildAdvice } from "../../analytics/advice.mjs";
import { collectObservedEnvironment } from "../../environment.mjs";
import { createViewRegistry } from "../core/views.mjs";
import { createArchitectureView, renderArchitectureView } from "./architecture.mjs";
import { createEnvironmentView, renderEnvironmentView } from "./environment.mjs";
import { createInvestigateView, renderInvestigateView } from "./investigate.mjs";
import { createThroughputView, renderThroughputView } from "./throughput.mjs";

function snapshot() {
  return {
    range: { from: 0, to: 2_000 },
    runs: [
      {
        id: "run-root",
        sessionId: "session-root",
        parentId: null,
        identity: { agent: "builder", model: "model-a" },
        interval: { start: 0, end: 1_000 },
        tokens: { input: 10, output: 20, reasoning: 5, cacheRead: 2, cacheWrite: 0 },
        cost: { reported: true, usd: 0.25 },
        toolEvents: [{ tool: "read", count: 1, interval: { start: 100, end: 200 } }],
        errors: [],
        reviewer: { agent: "reviewer", verdict: "PASS" },
      },
      {
        id: "run-child",
        sessionId: "session-child",
        parentId: "run-root",
        identity: { agent: "builder", model: "model-a" },
        interval: { start: 500, end: 1_500 },
        tokens: { input: 5, output: 10, reasoning: 2, cacheRead: 0, cacheWrite: 0 },
        cost: { reported: true, usd: 0.1 },
        toolEvents: [{ tool: "read", count: 1, interval: { start: 600, end: 700 } }],
        errors: [],
        reviewer: { agent: "reviewer", verdict: "UNKNOWN" },
      },
    ],
  };
}

function payload() {
  const source = snapshot();
  const architecture = analyzeArchitecture(source);
  const execution = analyzeExecution(source);
  return {
    analytics: {
      schemaVersion: 1,
      availability: {
        architecture: architecture.availability,
        throughput: analyzeThroughput(source).availability,
      },
      architecture,
      execution,
      advice: buildAdvice(source, { architecture, execution }),
      throughput: analyzeThroughput(source),
      trends: analyzeTrends(source, source),
      efficiency: analyzeEfficiency(source),
      comparisons: analyzeComparisons(source),
      failures: analyzeFailures(source),
      environment: { observed: collectObservedEnvironment(source) },
    },
  };
}

class FakeHost {
  constructor() {
    this.innerHTML = "";
    this.hidden = true;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? 0) + 1);
  }

  removeEventListener(type) {
    this.listeners.set(type, Math.max(0, (this.listeners.get(type) ?? 1) - 1));
  }

  replaceChildren() {
    this.innerHTML = "";
  }

  contains() {
    return true;
  }
}

test("all Wave 4 views consume actual analyzer envelopes deterministically", () => {
  const loaded = payload();
  const context = { payload: loaded, previousPayload: loaded, state: { environmentOptIn: true }, actions: {} };
  const renderers = [renderArchitectureView, renderThroughputView, renderInvestigateView, renderEnvironmentView];
  for (const render of renderers) {
    const first = render(context);
    assert.equal(first, render(context));
    assert.ok(first.length > 0);
    assert.doesNotMatch(first, /run-root|session-root/);
  }
});

test("all Wave 4 factories satisfy the registry lifecycle and context contract", () => {
  const loaded = payload();
  const context = { payload: loaded, previousPayload: loaded, state: { environmentOptIn: true }, actions: {} };
  const factories = [createArchitectureView, createThroughputView, createInvestigateView, createEnvironmentView];
  const hosts = new Map();
  const documentRef = {
    getElementById(name) {
      if (!hosts.has(name)) hosts.set(name, new FakeHost());
      return hosts.get(name);
    },
    querySelector() {
      return null;
    },
  };
  const registry = createViewRegistry(documentRef);

  factories.forEach((factory, index) => {
    const name = `wave4-${index}`;
    const host = documentRef.getElementById(name);
    const view = factory();
    assert.deepEqual(Object.keys(view).sort(), ["destroy", "mount", "update"]);
    registry.mount(name, view, name, context);
    assert.notEqual(host.innerHTML, "");
    assert.equal(registry.update(name, context), true);
    registry.destroy(name);
    assert.equal(host.innerHTML, "");
    assert.equal(host.hidden, true);
  });
});

test("architecture remounts detach the prior delegated listener", () => {
  const first = new FakeHost();
  const second = new FakeHost();
  const view = createArchitectureView();
  view.mount(first, { payload: payload() });
  view.mount(second, { payload: payload() });
  assert.equal(first.listeners.get("click"), 0);
  assert.equal(second.listeners.get("click"), 1);
  view.destroy();
  assert.equal(second.listeners.get("click"), 0);
});

test("architecture execution exposes compact aggregate metrics and routing layout hooks", () => {
  const markup = renderArchitectureView({ payload: payload() });
  assert.match(markup, /class="architecture-routing-grid"/);
  assert.match(markup, /class="architecture-route-list"/);
  assert.match(markup, /<th scope="col">Agent<\/th>/);
  assert.match(markup, /<th scope="col">Model<\/th>/);
  assert.match(markup, /<th scope="col">Tokens<\/th>/);
  assert.match(markup, /<th scope="col">Estimated cost<\/th>/);
  assert.match(markup, /<th scope="col">Duration<\/th>/);
  assert.doesNotMatch(markup, /run-\d{3}|data-run-alias/);
});

test("throughput trend plots only usable output-token buckets and preserves zero output", () => {
  const source = snapshot();
  const throughput = analyzeThroughput(source);
  const current = {
    ...throughput,
    series: [
      { startMs: 0, endMs: 1_000, activeMs: 0, tokens: { output: 99 } },
      { startMs: 1_000, endMs: 2_000, activeMs: 1_000, tokens: { output: 0 } },
      { startMs: 2_000, endMs: 3_000, activeMs: 1_000, tokens: {} },
      { startMs: 3_000, endMs: 4_000, activeMs: 1_000, tokens: { output: 10 } },
    ],
  };
  const markup = renderThroughputView({
    payload: { analytics: { throughput: current, trends: { current, previous: throughput }, efficiency: {} } },
  });
  const trend = markup.slice(markup.indexOf('aria-labelledby="throughput-trend-heading"'), markup.indexOf('</section>', markup.indexOf('aria-labelledby="throughput-trend-heading"')));
  assert.match(trend, /Output tokens\/min/);
  assert.match(trend, /2 of 4 supplied intervals/);
  assert.match(trend, /0 tokens\/min/);
  assert.doesNotMatch(trend, /processed tokens|min.*generated tokens/);
  assert.doesNotMatch(trend, /Interval 3|Interval 4/);
});

test("throughput efficiency renders pricing and long-context evidence", () => {
  const source = {
    range: { from: 0, to: 2_000 },
    runs: [{
      id: "priced-run",
      sessionId: "priced-session",
      parentId: null,
      identity: { agent: "builder", model: "model-priced" },
      interval: { start: 0, end: 1_000 },
      tokens: { input: 272_000, output: 10, reasoning: 0, cacheRead: 100, cacheWrite: 0 },
      cost: { reported: true, usd: 0.25, pricing: { inputPerToken: 0.00001, cacheReadPerToken: 0.000001 } },
      toolEvents: [],
      errors: [],
      reviewer: { agent: "reviewer", verdict: "PASS" },
    }],
  };
  const throughput = analyzeThroughput(source);
  const current = { ...throughput, series: throughput.series };
  const markup = renderThroughputView({
    payload: { analytics: { throughput: current, trends: { current, previous: current }, efficiency: analyzeEfficiency(source) } },
  });
  assert.match(markup, /Long-context crossings/);
  assert.match(markup, /Estimated cache savings/);
  assert.match(markup, /\$0\.0009/);
  assert.match(markup, /greater-than-or-equal/);
});
