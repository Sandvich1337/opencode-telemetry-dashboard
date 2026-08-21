import { createViewLifecycle } from "../core/views.mjs";

const UNAVAILABLE = "Unavailable — harness outcome data is not connected";

const SUPPORTING_METRICS = Object.freeze([
  ["Eligible task volume", "All eligible attempted work in scope, including unsuccessful attempts."],
  ["Unique verified accepted changes", "Unique changes reaching authoritative acceptance with every route-required check passing on the same current contract/change lineage."],
  ["Verification/review/gate coverage", "Complete coverage of the verification, independent review, and gate checks required for eligible attempts."],
  ["Repair loops per accepted change", "Repair loops attributable to eligible work divided by unique changes that reach authoritative acceptance."],
  ["Route-tier/escalation mix", "The eventual mix of evidenced route tiers and risk re-escalations for eligible work."],
]);

const ROUTING_GUARANTEES = Object.freeze([
  "Any critical, expensive-to-be-wrong, destructive/irreversible, security-sensitive, migratory, or externally contractual condition routes to T5.",
  "T5 requires Sol Architect Max, independent review, Sol Gate, and one bounded writer.",
  "Ambiguity that could increase risk must re-escalate and must not downgrade.",
]);

const PASS_RATE_DIMENSIONS = Object.freeze([
  "task category",
  "difficulty",
  "risk",
  "oracle quality",
]);

function elementLike(value) {
  return value && typeof value === "object" && (
    typeof value.innerHTML === "string" || typeof value.replaceChildren === "function"
  );
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function invocation(first, second) {
  if (elementLike(first)) return { ...record(second), element: first };
  return record(first);
}

function targetOf(context, fallback) {
  return context.element ?? context.root ?? context.container ?? context.state?.element ?? context.state?.root ?? fallback;
}

function writeMarkup(target, markup) {
  if (!target) return;
  if (typeof target.innerHTML === "string") target.innerHTML = markup;
  else if (typeof target.replaceChildren === "function" && target.ownerDocument?.createElement) {
    const wrapper = target.ownerDocument.createElement("div");
    wrapper.innerHTML = markup;
    target.replaceChildren(...wrapper.childNodes);
  }
}

function unavailableValue() {
  return `<span class="harness-unavailable" role="status">${UNAVAILABLE}</span>`;
}

function supportingMetricMarkup() {
  return SUPPORTING_METRICS.map(([label, definition]) => `<div class="harness-definition">
    <dt>${label}</dt>
    <dd><p>${definition}</p><p>${unavailableValue()}</p></dd>
  </div>`).join("");
}

function routingMarkup() {
  return `<div class="harness-table-scroll" role="region" aria-label="Evidenced T5 routing guarantees" tabindex="0">
    <table class="harness-table harness-routing-table">
      <caption>Evidenced T5 routing guarantees</caption>
      <thead><tr><th scope="col">Guarantee</th><th scope="col">Current evidence state</th></tr></thead>
      <tbody>${ROUTING_GUARANTEES.map((guarantee) => `<tr><th scope="row">${guarantee}</th><td>Evidence documented; lower-tier policy unavailable</td></tr>`).join("")}</tbody>
    </table>
  </div>`;
}

function passRateMarkup() {
  const requirements = "Unknown observations retained; eventual rows require numerator, denominator, rate, sample/coverage, basis, and policy/schema version.";
  return `<div class="harness-table-scroll" role="region" aria-label="Future pass-rate dimensions" tabindex="0">
    <table class="harness-table harness-pass-rate-table">
      <caption>Future pass-rate dimensions</caption>
      <thead><tr><th scope="col">Dimension</th><th scope="col">Future row requirements</th></tr></thead>
      <tbody>${PASS_RATE_DIMENSIONS.map((dimension) => `<tr data-harness-dimension="${dimension}"><th scope="row">${dimension}</th><td>${requirements}</td></tr>`).join("")}</tbody>
    </table>
  </div>
  <p class="harness-section-note">These are four independent dimensions only; no Cartesian or cross-dimension rates are claimed.</p>`;
}

/** Pure, deterministic renderer for the frontend-only Harness view. */
export function renderHarnessView() {
  return `<div class="harness-view" data-view="harness">
    <header class="harness-header">
      <div><span class="harness-kicker">Frontend-only policy view</span><h2 id="harness-view-title">Harness</h2><p>Acceptance, attribution, and routing guarantees are presented without backend outcome data.</p></div>
      <span class="harness-state">Unavailable data</span>
    </header>

    <section class="harness-section harness-primary" aria-labelledby="harness-primary-heading">
      <div class="harness-section-heading"><div><span class="harness-eyebrow">Primary metric</span><h3 id="harness-primary-heading">Cost per verified accepted change</h3></div><span class="harness-badge">Planned formula</span></div>
      <p class="harness-formula"><code>total attributable harness cost in scope / unique verified accepted changes in scope</code></p>
      <p class="harness-primary-description">The numerator covers all eligible attempted work in scope, including evidence, implementation, repair, verification, review, gate, and unsuccessful attempts. The denominator counts unique changes that reach authoritative acceptance with all route-required checks passing on the same current contract/change lineage. Attempts, commits, checks, and repairs never multiply the denominator.</p>
      <p class="harness-value-label">Current value</p>
      <p class="harness-value">${unavailableValue()}</p>
    </section>

    <section class="harness-section" aria-labelledby="harness-supporting-heading">
      <div class="harness-section-heading"><div><span class="harness-eyebrow">Supporting definitions</span><h3 id="harness-supporting-heading">Evidence required before measurement</h3></div></div>
      <dl class="harness-definitions">${supportingMetricMarkup()}</dl>
    </section>

    <section class="harness-section" aria-labelledby="harness-routing-heading">
      <div class="harness-section-heading"><div><span class="harness-eyebrow">Evidenced guarantees</span><h3 id="harness-routing-heading">T5 routing guarantees</h3></div><span class="harness-badge">T5</span></div>
      <p class="harness-section-note">The current evidence supports the guarantees below. No complete T0–T4 matrix is claimed; lower-tier policy is unavailable.</p>
      ${routingMarkup()}
    </section>

    <section class="harness-section" aria-labelledby="harness-pass-rate-heading">
      <div class="harness-section-heading"><div><span class="harness-eyebrow">Future measurement model</span><h3 id="harness-pass-rate-heading">Future pass-rate breakdown</h3></div><span class="harness-badge">Not connected</span></div>
      <p class="harness-section-note">Unknown observations remain retained in the future model. No current pass rate, sample, or task record is rendered.</p>
      ${passRateMarkup()}
    </section>
  </div>`;
}

/** DOM lifecycle adapter for the deterministic Harness view. */
export function createHarnessView() {
  let mountedTarget = null;
  const mount = (first = {}, second) => {
    const context = invocation(first, second);
    mountedTarget = targetOf(context, mountedTarget);
    const markup = renderHarnessView();
    writeMarkup(mountedTarget, markup);
    return markup;
  };
  const update = (first = {}, second) => {
    const context = invocation(first, second);
    mountedTarget = targetOf(context, mountedTarget);
    const markup = renderHarnessView();
    writeMarkup(mountedTarget, markup);
    return markup;
  };
  const destroy = (first = {}) => {
    const context = elementLike(first) ? { element: first } : record(first);
    const target = targetOf(context, mountedTarget);
    if (target?.replaceChildren) target.replaceChildren();
    else if (target && typeof target.innerHTML === "string") target.innerHTML = "";
    if (target === mountedTarget) mountedTarget = null;
  };
  return createViewLifecycle({ mount, update, destroy });
}
