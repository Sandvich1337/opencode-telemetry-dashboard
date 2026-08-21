import assert from "node:assert/strict";
import test from "node:test";

import { createThroughputView, renderThroughputView } from "./throughput.mjs";

const sample = Object.freeze({ count: 2, observed: 2, denominator: 2, complete: true });

function analytics({ includePrevious = true, unavailable = false } = {}) {
  const throughput = {
    availability: { available: !unavailable, reason: unavailable ? "no-positive-interval" : "positive-denominator", sample },
    sample,
    provenance: { intervalMethod: "clamped-positive-union", rateBasis: "workflow-wall-clock", costBasis: "reported-usd-only" },
    basis: { activeWallMs: unavailable ? 0 : 1_500, summedWorkMs: unavailable ? 0 : 3_000, parallelism: unavailable ? null : 2, intervalMethod: "clamped-positive-union" },
    totals: {
      tokens: { processed: 120, generated: 80, output: 60 },
      calls: 6,
      estimatedUsd: 2,
      rates: {
        processedTokensPerMinute: unavailable ? null : 4_800,
        generatedTokensPerMinute: unavailable ? null : 3_200,
        outputTokensPerMinute: unavailable ? null : 2_400,
        toolCallsPerMinute: unavailable ? null : 240,
        estimatedUsdPerHour: unavailable ? null : 4_800,
      },
    },
    rateReasons: {
      processedTokensPerMinute: unavailable ? "no-positive-denominator" : "positive-denominator",
      generatedTokensPerMinute: unavailable ? "no-positive-denominator" : "positive-denominator",
      outputTokensPerMinute: unavailable ? "no-positive-denominator" : "positive-denominator",
      toolCallsPerMinute: unavailable ? "no-positive-denominator" : "positive-denominator",
      estimatedUsdPerHour: unavailable ? "cost-unavailable" : "positive-denominator",
    },
    byAgent: [
      { agent: "agent <one>", runs: 1, activeMs: 1_000, rates: { processedTokensPerMinute: 60, generatedTokensPerMinute: 30, toolCallsPerMinute: 6, estimatedUsdPerHour: null }, rateReasons: { estimatedUsdPerHour: "cost-unavailable" }, sample },
      { agent: "agent two", runs: 1, activeMs: 500, rates: { processedTokensPerMinute: 120, generatedTokensPerMinute: null, toolCallsPerMinute: 12, estimatedUsdPerHour: 1 }, rateReasons: { generatedTokensPerMinute: "no-positive-denominator" }, sample },
    ],
    series: [
      { startMs: 0, endMs: 750, activeMs: 750, tokens: { processed: 60 }, calls: 2, concurrency: 1 },
      { startMs: 750, endMs: 1_500, activeMs: 750, tokens: { processed: 60 }, calls: 4, concurrency: 3 },
    ],
  };
  const previous = includePrevious ? {
    ...throughput,
    basis: { ...throughput.basis, activeWallMs: 1_000, summedWorkMs: 2_000, parallelism: 2 },
    totals: { ...throughput.totals, rates: { ...throughput.totals.rates, processedTokensPerMinute: 3_600, generatedTokensPerMinute: 2_400, outputTokensPerMinute: 1_800, toolCallsPerMinute: 180, estimatedUsdPerHour: 3_600 } },
  } : null;
  const trends = {
    availability: { available: includePrevious && !unavailable, reason: includePrevious && !unavailable ? "comparison-ready" : "previous-unavailable", sample },
    sample,
    previousSample: includePrevious ? sample : null,
    current: throughput,
    previous,
    deltas: {
      basis: { activeWallMs: includePrevious ? 500 : null, summedWorkMs: includePrevious ? 1_000 : null, parallelism: 0 },
      totals: { processedTokensPerMinute: includePrevious ? 1_200 : null, generatedTokensPerMinute: includePrevious ? 800 : null, outputTokensPerMinute: includePrevious ? 600 : null, toolCallsPerMinute: includePrevious ? 60 : null, estimatedUsdPerHour: includePrevious ? 1_200 : null },
    },
    deltaReasons: {
      basis: { activeWallMs: includePrevious ? "measured" : "previous-unavailable", summedWorkMs: includePrevious ? "measured" : "previous-unavailable", parallelism: includePrevious ? "measured" : "previous-unavailable" },
      totals: { processedTokensPerMinute: includePrevious ? "measured" : "previous-unavailable", generatedTokensPerMinute: includePrevious ? "measured" : "previous-unavailable", outputTokensPerMinute: includePrevious ? "measured" : "previous-unavailable", toolCallsPerMinute: includePrevious ? "measured" : "previous-unavailable", estimatedUsdPerHour: includePrevious ? "measured" : "previous-unavailable" },
    },
  };
  const efficiency = {
    availability: { available: true, reason: "recorded-token-sample", sample },
    sample,
    measuredSamples: { tokens: 2 },
    tokens: { input: 100, output: 60, reasoning: 20, cacheRead: 40, cacheWrite: 0, total: 220 },
    cacheReadShare: { rate: 40 / 140, numerator: 40, denominator: 140, reason: "positive-denominator", sample },
    reasoningOutputMix: { output: { rate: 0.75, numerator: 60, denominator: 80, reason: "positive-denominator", sample }, reasoning: { rate: 0.25, numerator: 20, denominator: 80, reason: "positive-denominator", sample } },
    estimatedCacheSavings: { estimatedUSD: 0.25, available: true, basis: "estimated", reason: "recorded-pricing-evidence", sample },
    longContextCrossings: { thresholdTokens: 272_000, comparison: "greater-than-or-equal", rate: 0.5, numerator: 1, denominator: 2, reason: "positive-denominator", sample },
    reviewerPassEconomics: { available: true, reason: "attributable-reviewer-pass", sample, passes: 1, tokens: { total: 80 }, tokensPerPass: 80, cost: 1, estimatedCostPerPass: 1, durationMs: 500, durationPerPassMs: 500 },
  };
  return { analytics: { throughput, trends, efficiency } };
}

test("renders auditable denominator labels, concurrency, efficiency, and prior deltas", () => {
  const html = renderThroughputView({ payload: analytics() });
  assert.match(html, /Denominator:/);
  assert.match(html, /Active wall time/);
  assert.match(html, /Summed work/);
  assert.match(html, /Concurrency/);
  assert.match(html, /Cache read share of context/);
  assert.match(html, /Reasoning share of generated output/);
  assert.match(html, /Long-context crossings/);
  assert.match(html, /Reviewer-linked PASS tokens/);
  assert.match(html, /Current vs previous/);
  assert.match(html, /\+1,200 tokens\/min/);
});

test("renders null rates with reasons instead of turning missing evidence into zero", () => {
  const html = renderThroughputView({ payload: analytics({ unavailable: true }) });
  assert.match(html, /Unavailable/);
  assert.match(html, /no-positive-denominator/);
  assert.match(html, /previous-unavailable/);
  assert.doesNotMatch(html, />0 tokens\/min</);
});

test("renders deterministic accessible SVG and semantic trend table", () => {
  const html = renderThroughputView({ payload: analytics() });
  assert.match(html, /<svg class="throughput-trend-svg" role="img"/);
  assert.match(html, /<title id="throughput-trend-title">Workflow throughput trend<\/title>/);
  assert.match(html, /<desc id="throughput-trend-description">/);
  assert.match(html, /<details class="throughput-help"><summary/);
  assert.match(html, /throughput-chart-alternative/);
  assert.match(html, /data-label="Output tokens\/min"/);
  assert.match(html, /role="region" aria-label="Output token trend interval table" tabindex="0"/);
  assert.match(html, /<table class="throughput-table throughput-trend-table">/);
  assert.match(html, /<caption>Semantic interval data/);
  assert.match(html, /scope="row"/);
  assert.equal(html, renderThroughputView({ payload: analytics() }));
});

test("keeps missing efficiency evidence explicitly unavailable", () => {
  const payload = analytics();
  payload.analytics.efficiency = { tokens: {}, availability: { available: false, reason: "token-sample-missing" } };
  const html = renderThroughputView({ payload });
  assert.match(html, /context token evidence unavailable/);
  assert.doesNotMatch(html, /data-metric="context-tokens"[\s\S]*?>0 tokens<\/p>/);
});

test("escapes agents and reasons in pure markup", () => {
  const payload = analytics();
  payload.analytics.throughput.byAgent[0].agent = "<script>alert('x')</script>";
  payload.analytics.throughput.rateReasons.processedTokensPerMinute = "<unsafe>";
  payload.analytics.throughput.totals.rates.processedTokensPerMinute = null;
  const html = renderThroughputView({ payload });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(&#39;x&#39;\)&lt;\/script&gt;/);
  assert.match(html, /&lt;unsafe&gt;/);
});

test("tolerates missing analytics and supports the lifecycle context contract", () => {
  const empty = renderThroughputView({ payload: {} });
  assert.match(empty, /throughput-view/);
  assert.match(empty, /throughput-unavailable/);
  const target = { innerHTML: "" };
  const view = createThroughputView();
  const context = { element: target, payload: analytics() };
  const markup = view.mount(context);
  assert.equal(target.innerHTML, markup);
  const updated = view.update({ element: target, payload: { analytics: { throughput: analytics({ includePrevious: false }).analytics.throughput, trends: analytics({ includePrevious: false }).analytics.trends, efficiency: {} } } });
  assert.equal(target.innerHTML, updated);
  view.destroy();
  assert.equal(target.innerHTML, "");
});

test("uses previousPayload as a renderer fallback when the trend contract is partial", () => {
  const current = analytics({ includePrevious: false }).analytics;
  const previous = analytics().analytics.trends.previous;
  const html = renderThroughputView({
    payload: { analytics: { throughput: current.throughput, trends: current.trends, efficiency: current.efficiency } },
    previousPayload: { analytics: { throughput: previous } },
  });
  assert.match(html, /Current vs previous/);
  assert.match(html, /\+1,200 tokens\/min/);
  assert.match(html, /comparison-ready/);
});
