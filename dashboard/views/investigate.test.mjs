import assert from "node:assert/strict";
import test from "node:test";

import { createInvestigateView, renderInvestigateView } from "./investigate.mjs";

const comparisonRow = (identity, label, overrides = {}) => ({
  [identity]: label,
  runs: 3,
  measuredSamples: { tokens: 2, cost: 1, duration: 2, calls: 3, reviewer: 1 },
  tokens: { input: 10, output: 5, reasoning: 2, cacheRead: 3, cacheWrite: 0, total: 20 },
  estimatedCost: 1.25,
  duration: 1250,
  calls: 6,
  errorRate: 0.25,
  cacheShare: 0.3,
  reviewerOutcomes: {
    available: true,
    attributable: 1,
    counts: { PASS: 1, ISSUE: 0, UNKNOWN: 0 },
    passRate: 1,
    sample: { count: 1, observed: 1, denominator: 3, complete: false },
  },
  ...overrides,
});

function fixture() {
  return {
    payload: {
      analytics: {
        comparisons: {
          availability: { available: true, reason: "recorded-runs", sample: { count: 6, observed: 6, denominator: 6 } },
          sample: { count: 6, observed: 6, denominator: 6 },
          confidence: { value: 0.8 },
          byAgent: [comparisonRow("agent", "zeta"), comparisonRow("agent", "alpha", {
            reviewerOutcomes: {
              available: true,
              attributable: 1,
              counts: { PASS: 0, ISSUE: 1, UNKNOWN: 0 },
              passRate: 0,
              sample: { count: 1, observed: 1, denominator: 3 },
            },
          })],
          byModel: [comparisonRow("model", "model-z"), comparisonRow("model", "model-a")],
        },
        failures: {
          availability: { available: true, reason: "recorded-error-or-tool-events", sample: { count: 3, observed: 2, denominator: 3 } },
          sample: { count: 3, observed: 2, denominator: 3 },
          totals: { runs: 3, calls: 9, errors: 3, errorRate: 1 / 3 },
          toolHotspots: [{ tool: "build", runs: 2, calls: 4, errors: 2, errorRate: 0.5, sample: { count: 2, observed: 2, denominator: 3 } }],
          agentHotspots: [{ agent: "alpha", runs: 2, calls: 4, errors: 2, errorRate: 0.5, sample: { count: 2, observed: 2, denominator: 3 } }],
          modelHotspots: [{ model: "model-a", runs: 2, calls: 4, errors: 2, errorRate: 0.5, sample: { count: 2, observed: 2, denominator: 3 } }],
          repeatAfterError: [{ label: "repeat-after-error", tool: "build", agent: "alpha", model: "model-a", repeats: 1, denominator: 2, rate: 0.5, sample: { count: 2, observed: 2, denominator: 3 } }],
          repeatAfterErrorRate: { rate: 0.5, sample: { count: 2, observed: 2, denominator: 3 } },
        },
        architecture: {
          provenance: { aliasing: "privacy-safe-deterministic" },
          delegation: {
            availability: { available: true, reason: "parent-links", sample: { count: 4, observed: 2, denominator: 4 } },
            sample: { count: 4, observed: 2, denominator: 4 },
            delegations: 2,
            parentCount: 1,
            fanOut: 2,
            maxFanOut: 2,
            maxDepth: 2,
            parentChildTokenRatio: 0.4,
            parallelism: 2,
            parallelismRatio: 0.5,
            approximateCriticalPathMs: 2500,
          },
        },
        execution: { summary: { roots: 1, children: 3, maxDepth: 2, fanOut: 2, approximateCriticalPathMs: 2500 } },
      },
    },
  };
}

test("renders deterministic agent and model comparison rows with metric samples", () => {
  const html = renderInvestigateView(fixture());
  assert.ok(html.indexOf(">alpha<") < html.indexOf(">zeta<"));
  assert.ok(html.indexOf(">model-a<") < html.indexOf(">model-z<"));
  assert.match(html, /Comparative evidence/);
  assert.match(html, /data-sort-order="identity-ascending"/);
  assert.match(html, /aria-sort="ascending"/);
  assert.match(html, /tokens 2 \/ 3/);
  assert.match(html, /cost 1 \/ 3/);
  assert.match(html, /Reviewer outcomes/);
  assert.match(html, /PASS 0 · ISSUE 1 · UNKNOWN 0 · pass 0% · sample 1 \/ 3/);
});

test("renders tool, agent, and model error hotspot groups", () => {
  const html = renderInvestigateView(fixture());
  assert.match(html, /Tool error hotspots/);
  assert.match(html, /Agent error hotspots/);
  assert.match(html, /Model error hotspots/);
  assert.match(html, /build/);
  assert.match(html, /alpha/);
  assert.match(html, /model-a/);
  assert.match(html, /Failure totals/);
  assert.match(html, /data-sort-order="errors-desc-calls-desc-identity-ascending"/);
  assert.match(html, /aria-sort="descending"/);
});

test("uses strictly named repeat-after-error wording without inferring a retry", () => {
  const html = renderInvestigateView(fixture());
  assert.match(html, /Repeat-after-error/);
  assert.match(html, /repeat-after-error/);
  assert.match(html, /Ordered event evidence/);
  assert.match(html, /data-sort-order="repeats-desc-tool-agent-model-ascending"/);
  assert.doesNotMatch(html.toLowerCase(), /retry/);
});

test("renders delegation health metrics only when reported", () => {
  const html = renderInvestigateView(fixture());
  for (const label of ["Average fan-out", "Maximum depth", "Child / parent token ratio", "Parallelism", "Parallelism ratio", "Approximate critical path"]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /50%/);
  assert.match(html, /2\.5 s/);
});

test("keeps unavailable and partial analytics explicit", () => {
  const html = renderInvestigateView({ payload: {
    analytics: {
      comparisons: { availability: { available: false, reason: "no-runs", sample: { count: 0, observed: 0, denominator: 0 } } },
      failures: { availability: { available: null, reason: "missing", sample: { count: 4, observed: 1, denominator: 4 } } },
      architecture: { delegation: { availability: { available: false, reason: "no-delegations", sample: { count: 4, observed: 0, denominator: 4 } } } },
    },
  } });
  assert.match(html, /Unavailable · no-runs/);
  assert.match(html, /Partial · availability not declared/);
  assert.match(html, /Unavailable — no delegation-health metrics were reported/);
  assert.match(html, /sample 1 \/ 4/);
});

test("escapes semantic labels and lifecycle methods render and clear a mount", () => {
  const html = renderInvestigateView({ payload: { analytics: {
    comparisons: { byAgent: [comparisonRow("agent", "<script>alert('x')</script>")] },
  } } });
  assert.match(html, /&lt;script&gt;alert\(&#39;x&#39;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);

  const root = { innerHTML: "", replaceChildren() { this.innerHTML = ""; } };
  const view = createInvestigateView();
  view.mount(root, fixture());
  assert.match(root.innerHTML, /data-investigate-view/);
  view.update(root, fixture());
  assert.match(root.innerHTML, /Delegation health/);
  view.destroy(root);
  assert.equal(root.innerHTML, "");
});

test("renders decision-support bars, conclusions, and explicit access channels safely", () => {
  const context = fixture();
  context.payload.analytics.advice = {
    decisionSupport: {
      availability: { available: true, reason: "workflow-decision-support", sample: { count: 20, observed: 20, denominator: 20 } },
      sample: { count: 20, observed: 20, denominator: 20 },
      confidence: { value: 0.9 },
      principles: [
        { key: "speed", label: "Speed efficiency", score: null, conclusion: "No duration.", reasoning: "Missing duration evidence.", evidence: ["duration-ms:0"], sample: { count: 20, observed: 20, denominator: 20 }, confidence: { value: null } },
        { key: "cost", label: "Cost efficiency", score: 75, conclusion: "Observed allocation.", reasoning: "Cost rate contributed.", evidence: ["reported-cost-usd:2"], sample: { count: 20, observed: 20, denominator: 20 }, confidence: { value: 0.8 } },
        { key: "intelligence", label: "Intelligence allocation", score: 60, conclusion: "Workflow only.", reasoning: "Navigation contributed; reviewer outcomes are missing.", evidence: ["indexed-navigation-calls:4"], sample: { count: 20, observed: 20, denominator: 20 }, confidence: { value: 0.7 } },
      ],
      conclusions: [{ code: "safe", severity: "warning", title: "<unsafe conclusion>", suggestion: "Use observed evidence.", evidence: ["tool:<script>alert(1)</script>"], sample: { count: 20, observed: 20, denominator: 20 }, confidence: { value: 0.6 } }],
      accessChannels: [{ key: "web", label: "Web access", calls: 20, tools: [{ tool: "argus_search_web", calls: 20, classification: "unknown", provider: "argus" }], evidence: ["calls:20", "providers:argus"] }],
    },
  };
  const html = renderInvestigateView(context);
  assert.match(html, /Advice &amp; conclusions/);
  assert.match(html, /Principle bars/);
  assert.match(html, /<progress class="investigate-principle-track"[^>]+value="75"/);
  assert.match(html, /aria-valuenow="75"/);
  assert.match(html, /Score unavailable/);
  assert.doesNotMatch(html, /style="width:/);
  assert.match(html, /Observed access channels/);
  assert.match(html, /Reasoning:/);
  assert.match(html, /provider argus/);
  assert.match(html, /&lt;unsafe conclusion&gt;/);
  assert.doesNotMatch(html, /<unsafe conclusion>/);
  assert.doesNotMatch(html, /<script>alert/);
});
