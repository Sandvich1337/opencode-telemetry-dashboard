const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const moneyFormat = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const record = (value) => isRecord(value) ? value : {};
const list = (value) => Array.isArray(value) ? value : [];
const hasValue = (value) => value !== null && value !== undefined && value !== "";
const nonEmptyRecord = (value) => isRecord(value) && Object.keys(value).length ? value : null;

const escapeHtml = (value) => String(value ?? "—").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[character]));

const finite = (value) => {
  const result = typeof value === "number" ? value : Number(value);
  return hasValue(value) && Number.isFinite(result) ? result : null;
};

const first = (...values) => values.find(hasValue);

const scalar = (value, fallback = null) => {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return fallback;
};

const text = (value, fallback = "—") => {
  const result = scalar(value);
  return result === null ? fallback : String(result);
};

const numberText = (value) => {
  const result = finite(value);
  return result === null ? "—" : numberFormat.format(result);
};

const moneyText = (value) => {
  const result = finite(value);
  return result === null ? "—" : `$${moneyFormat.format(result)}`;
};

const durationText = (value) => {
  const result = finite(value);
  if (result === null) return "—";
  if (result < 1000) return `${numberText(result)} ms`;
  if (result < 60_000) return `${numberText(result / 1000)} s`;
  return `${numberText(result / 60_000)} min`;
};

const percentText = (value) => {
  const result = finite(value);
  return result === null ? "—" : `${numberText(result * 100)}%`;
};

const labelText = (value) => text(value, "unknown");

const sampleObject = (value) => record(value);

function sampleText(value, fallbackDenominator = null) {
  const sample = sampleObject(value);
  const observed = finite(first(sample.observed, sample.valid, sample.included, sample.count));
  const denominator = finite(first(sample.denominator, sample.total, sample.population, fallbackDenominator));
  if (observed === null && denominator === null) return "sample —";
  if (denominator === null) return `sample ${numberText(observed)}`;
  return `sample ${numberText(observed)} / ${numberText(denominator)}`;
}

function samplePair(value, denominator) {
  const sample = sampleObject(value);
  const observed = finite(first(sample.observed, sample.valid, sample.included, sample.count, value));
  const total = finite(first(sample.denominator, sample.total, sample.population, denominator));
  if (observed === null && total === null) return "—";
  return `${numberText(observed)} / ${numberText(total)}`;
}

function availabilityText(source, fallback = "unavailable") {
  const sourceRecord = record(source);
  const availability = record(sourceRecord.availability);
  const available = availability.available;
  const reason = text(availability.reason, fallback);
  if (available === true) return `Available · ${reason}`;
  if (available === false) return `Unavailable · ${reason}`;
  if (!Object.keys(sourceRecord).length) return `Unavailable · ${fallback}`;
  return `Partial · availability not declared${reason && reason !== fallback ? ` · ${reason}` : ""}`;
}

function evidenceText(source, fallback = "unavailable") {
  const sourceRecord = record(source);
  const availability = record(sourceRecord.availability);
  const sample = first(availability.sample, sourceRecord.sample);
  const confidence = record(sourceRecord.confidence);
  const confidenceValue = finite(confidence.value);
  const confidenceText = confidenceValue === null ? "" : ` · confidence ${percentText(confidenceValue)}`;
  return `${availabilityText(sourceRecord, fallback)} · ${sampleText(sample)}${confidenceText}`;
}

function availabilityState(source) {
  const sourceRecord = record(source);
  const available = record(sourceRecord.availability).available;
  if (available === true) return "available";
  if (available === false || !Object.keys(sourceRecord).length) return "unavailable";
  return "partial";
}

function statusMarkup(source, fallback) {
  const state = availabilityState(source);
  return `<span class="investigate-status investigate-status-${state}" data-availability="${state}">${escapeHtml(availabilityText(source, fallback))}</span>`;
}

function analyticsOf(payload) {
  const root = record(payload);
  const analytics = record(root.analytics);
  return Object.keys(analytics).length ? analytics : root;
}

function measuredText(row, key) {
  const source = record(row);
  const runs = finite(source.runs);
  return samplePair(record(source.measuredSamples)[key], runs);
}

function tokenText(row) {
  const tokens = record(row.tokens);
  const fields = ["input", "output", "reasoning", "cacheRead", "cacheWrite"];
  const detail = fields
    .filter((key) => finite(tokens[key]) !== null)
    .map((key) => `${key} ${numberText(tokens[key])}`)
    .join(" · ");
  const total = finite(tokens.total);
  if (total === null && !detail) return "—";
  return total === null ? detail : `${numberText(total)}${detail ? ` · ${detail}` : ""}`;
}

function reviewerText(row) {
  const reviewer = record(row.reviewerOutcomes);
  const counts = record(reviewer.counts);
  const sample = sampleText(reviewer.sample, finite(row.runs));
  const passRate = percentText(reviewer.passRate);
  const hasOutcomes = finite(reviewer.attributable) !== null && finite(reviewer.attributable) > 0;
  if (reviewer.available === false || !hasOutcomes) {
    return `Unavailable · ${sample}${reviewer.reason ? ` · ${text(reviewer.reason)}` : ""}`;
  }
  return `PASS ${numberText(counts.PASS)} · ISSUE ${numberText(counts.ISSUE)} · UNKNOWN ${numberText(counts.UNKNOWN)} · pass ${passRate} · ${sample}`;
}

function reviewerState(row) {
  const reviewer = record(row.reviewerOutcomes);
  const attributable = finite(reviewer.attributable);
  return reviewer.available === false || attributable === null || attributable <= 0 ? "unavailable" : "available";
}

function comparisonRows(source, dimension) {
  const key = dimension === "model" ? "model" : "agent";
  return list(record(source)[dimension === "model" ? "byModel" : "byAgent"])
    .filter(isRecord)
    .slice()
    .sort((left, right) => {
      const leftLabel = labelText(left[key]);
      const rightLabel = labelText(right[key]);
      return leftLabel < rightLabel ? -1 : leftLabel > rightLabel ? 1 : 0;
    });
}

function comparisonTable(source, dimension) {
  const key = dimension === "model" ? "model" : "agent";
  const title = dimension === "model" ? "Model comparison matrix" : "Agent comparison matrix";
  const rows = comparisonRows(source, dimension);
  const headings = ["Runs", "Samples", "Tokens", "Cost", "Duration", "Calls", "Error rate", "Cache share", "Reviewer outcomes"];
  const body = rows.map((row) => {
    const samples = [
      `tokens ${measuredText(row, "tokens")}`,
      `cost ${measuredText(row, "cost")}`,
      `duration ${measuredText(row, "duration")}`,
      `calls ${measuredText(row, "calls")}`,
      `reviewer ${samplePair(record(row.reviewerOutcomes).sample, finite(row.runs))}`,
    ].join(" · ");
    const cells = [
      numberText(row.runs),
      samples,
      tokenText(row),
      moneyText(row.estimatedCost),
      durationText(row.duration),
      numberText(row.calls),
      percentText(row.errorRate),
      percentText(row.cacheShare),
      reviewerText(row),
    ];
    return `<tr><th scope="row" data-label="${escapeHtml(dimension)}">${escapeHtml(labelText(row[key]))}</th>${cells.map((value, index) => {
      const reviewerClass = index === cells.length - 1 ? ` class="investigate-reviewer-cell investigate-reviewer-${reviewerState(row)}"` : "";
      const valueClass = index === cells.length - 1 ? "investigate-reviewer-summary" : "investigate-table-value";
      return `<td${reviewerClass} data-label="${escapeHtml(headings[index])}"><span class="${valueClass}">${escapeHtml(value)}</span></td>`;
    }).join("")}</tr>`;
  }).join("");
  const header = [`<th scope="col" aria-sort="ascending">${escapeHtml(dimension)}</th>`, ...headings.map((heading) => `<th scope="col">${escapeHtml(heading)}</th>`)].join("");
  const empty = `Unavailable — no ${escapeHtml(dimension)} comparison rows.`;
  return `<div class="investigate-table-block" data-sort-order="identity-ascending"><div class="investigate-table-meta"><span>${escapeHtml(rows.length ? `${numberText(rows.length)} rows` : "No recorded rows")}</span><span>Sorted A–Z</span></div><div class="investigate-table-scroll"><table class="investigate-table investigate-comparison-table"><caption>${escapeHtml(title)}</caption><thead><tr>${header}</tr></thead><tbody>${body || `<tr><td class="investigate-empty" colspan="${headings.length + 1}">${empty}</td></tr>`}</tbody></table></div></div>`;
}

function renderComparisons(comparisons) {
  const source = record(comparisons);
  return `<section class="investigate-panel investigate-panel-wide" aria-labelledby="investigate-comparisons-title">
    <div class="investigate-section-heading"><div><p class="investigate-kicker">Comparative evidence</p><h3 id="investigate-comparisons-title">Agent and model comparisons</h3><p class="investigate-evidence">${escapeHtml(evidenceText(source, "comparison-data-missing"))}</p></div>${statusMarkup(source, "comparison-data-missing")}</div>
    <p class="investigate-section-note">Rows stay sorted by identity. Metric samples remain attached to each reported value.</p>
    <div class="investigate-comparison-grid"><section class="investigate-table-card" aria-labelledby="investigate-agents-title"><div class="investigate-table-heading"><h4 id="investigate-agents-title">Agents</h4><span class="investigate-table-kind">Identity comparison</span></div>${comparisonTable(source, "agent")}</section><section class="investigate-table-card" aria-labelledby="investigate-models-title"><div class="investigate-table-heading"><h4 id="investigate-models-title">Models</h4><span class="investigate-table-kind">Identity comparison</span></div>${comparisonTable(source, "model")}</section></div>
  </section>`;
}

const hotspotOrder = Object.freeze([
  ["toolHotspots", "Tool error hotspots", "tool"],
  ["agentHotspots", "Agent error hotspots", "agent"],
  ["modelHotspots", "Model error hotspots", "model"],
]);

function hotspotRows(source, key, identity) {
  return list(record(source)[key]).filter(isRecord).slice().sort((left, right) => {
    const errorDifference = (finite(right.errors) ?? 0) - (finite(left.errors) ?? 0);
    const callDifference = (finite(right.calls) ?? 0) - (finite(left.calls) ?? 0);
    const leftLabel = labelText(left[identity]);
    const rightLabel = labelText(right[identity]);
    return errorDifference || callDifference || (leftLabel < rightLabel ? -1 : leftLabel > rightLabel ? 1 : 0);
  });
}

function hotspotTable(source, key, identity, title) {
  const rows = hotspotRows(source, key, identity);
  const body = rows.map((row) => `<tr><th scope="row" data-label="${escapeHtml(identity)}">${escapeHtml(labelText(row[identity]))}</th><td data-label="Runs">${escapeHtml(numberText(row.runs))}</td><td data-label="Calls">${escapeHtml(numberText(row.calls))}</td><td data-label="Errors">${escapeHtml(numberText(row.errors))}</td><td data-label="Error rate">${escapeHtml(percentText(row.errorRate ?? row.rate))}</td><td data-label="Samples">${escapeHtml(samplePair(row.sample, row.runs))}</td></tr>`).join("");
  return `<div class="investigate-table-block" data-sort-order="errors-desc-calls-desc-identity-ascending"><div class="investigate-table-meta"><span>${escapeHtml(rows.length ? `${numberText(rows.length)} hotspots` : "No recorded hotspots")}</span><span>Sorted by errors</span></div><div class="investigate-table-scroll"><table class="investigate-table investigate-hotspot-table"><caption>${escapeHtml(title)}</caption><thead><tr><th scope="col">${escapeHtml(identity)}</th><th scope="col">Runs</th><th scope="col">Calls</th><th scope="col" aria-sort="descending">Errors</th><th scope="col">Error rate</th><th scope="col">Samples</th></tr></thead><tbody>${body || `<tr><td class="investigate-empty" colspan="6">Unavailable — no recorded hotspot rows.</td></tr>`}</tbody></table></div></div>`;
}

function renderHotspots(failures) {
  const source = record(failures);
  const total = record(source.totals);
  const available = source.availability?.available === true;
  const totalText = available
    ? `Recorded totals: ${numberText(total.errors)} errors / ${numberText(total.calls)} calls · error rate ${percentText(total.errorRate)} · ${sampleText(source.sample)}`
    : `Recorded totals unavailable · ${availabilityText(source, "failure-data-missing")} · ${sampleText(source.sample)}`;
  const totalValue = (value) => available ? numberText(value) : "—";
  return `<section class="investigate-panel investigate-panel-wide" aria-labelledby="investigate-failures-title">
    <div class="investigate-section-heading"><div><p class="investigate-kicker">Failure evidence</p><h3 id="investigate-failures-title">Failure investigation</h3><p class="investigate-evidence">${escapeHtml(evidenceText(source, "failure-data-missing"))}</p><p class="investigate-subtle">${escapeHtml(totalText)}</p></div>${statusMarkup(source, "failure-data-missing")}</div>
    <dl class="investigate-summary-list" aria-label="Failure totals"><div><dt>Errors</dt><dd>${escapeHtml(totalValue(total.errors))}</dd></div><div><dt>Calls</dt><dd>${escapeHtml(totalValue(total.calls))}</dd></div><div><dt>Error rate</dt><dd>${escapeHtml(available ? percentText(total.errorRate) : "—")}</dd></div><div><dt>Evidence sample</dt><dd>${escapeHtml(sampleText(source.sample))}</dd></div></dl>
    <div class="investigate-hotspot-grid">${hotspotOrder.map(([key, title, identity]) => `<div><h4>${escapeHtml(title)}</h4>${hotspotTable(source, key, identity, title)}</div>`).join("")}</div>
    ${renderRepeatAfterError(source)}
  </section>`;
}

function renderRepeatAfterError(failures) {
  const rows = list(failures.repeatAfterError)
    .filter((row) => isRecord(row) && row.label === "repeat-after-error")
    .slice()
    .sort((left, right) => {
      const repeatDifference = (finite(right.repeats ?? right.numerator) ?? 0) - (finite(left.repeats ?? left.numerator) ?? 0);
      const leftTool = labelText(left.tool);
      const rightTool = labelText(right.tool);
      const leftAgent = labelText(left.agent);
      const rightAgent = labelText(right.agent);
      const leftModel = labelText(left.model);
      const rightModel = labelText(right.model);
      return repeatDifference || (leftTool < rightTool ? -1 : leftTool > rightTool ? 1 : 0) ||
        (leftAgent < rightAgent ? -1 : leftAgent > rightAgent ? 1 : 0) ||
        (leftModel < rightModel ? -1 : leftModel > rightModel ? 1 : 0);
    });
  const evidence = record(failures.repeatAfterErrorRate);
  const body = rows.map((row) => `<tr><th scope="row" data-label="Label">${escapeHtml("repeat-after-error")}</th><td data-label="Tool">${escapeHtml(labelText(row.tool))}</td><td data-label="Agent">${escapeHtml(labelText(row.agent))}</td><td data-label="Model">${escapeHtml(labelText(row.model))}</td><td data-label="Observed repeats">${escapeHtml(numberText(row.repeats ?? row.numerator))}</td><td data-label="Eligible samples">${escapeHtml(numberText(row.denominator))}</td><td data-label="Rate">${escapeHtml(percentText(row.rate))}</td><td data-label="Samples">${escapeHtml(samplePair(row.sample, row.denominator))}</td></tr>`).join("");
  return `<div class="investigate-repeat" aria-labelledby="investigate-repeat-title"><div class="investigate-section-heading"><div><p class="investigate-kicker">Ordered event evidence</p><h4 id="investigate-repeat-title">Repeat-after-error</h4><p class="investigate-evidence">${escapeHtml(rows.length ? `Observed ordered events · ${sampleText(evidence.sample)} · rate ${percentText(evidence.rate)}` : "Unavailable — no strictly named repeat-after-error rows.")}</p></div><span class="investigate-event-status ${rows.length ? "investigate-event-observed" : "investigate-event-unavailable"}">${rows.length ? "Observed" : "Unavailable"}</span></div><p class="investigate-section-note">Only rows carrying the reported event label are shown.</p><div class="investigate-table-block" data-sort-order="repeats-desc-tool-agent-model-ascending"><div class="investigate-table-meta"><span>${escapeHtml(rows.length ? `${numberText(rows.length)} event rows` : "No recorded event rows")}</span><span>Sorted by observed repeats</span></div><div class="investigate-table-scroll"><table class="investigate-table investigate-repeat-table"><caption>Repeat-after-error rows</caption><thead><tr><th scope="col">Label</th><th scope="col">Tool</th><th scope="col">Agent</th><th scope="col">Model</th><th scope="col" aria-sort="descending">Observed repeats</th><th scope="col">Eligible samples</th><th scope="col">Rate</th><th scope="col">Samples</th></tr></thead><tbody>${body || `<tr><td class="investigate-empty" colspan="8">Unavailable — no strictly named repeat-after-error rows.</td></tr>`}</tbody></table></div></div></div>`;
}

function delegationSources(analytics) {
  const architecture = record(analytics.architecture);
  const execution = record(analytics.execution);
  const delegation = record(architecture.delegation);
  if (Object.keys(delegation).length && delegation.availability?.available === false) return [];
  return [
    record(analytics.delegation),
    delegation,
    architecture,
    record(execution.delegation),
    record(execution.summary),
    execution,
  ];
}

function delegationValue(sources, keys) {
  for (const source of sources) {
    const value = first(...keys.map((key) => source[key]));
    if (hasValue(value)) return value;
  }
  return null;
}

function delegationMetricText(metric, value) {
  if (!hasValue(value)) return "—";
  if (metric.kind === "duration") return durationText(value);
  if (metric.kind === "percent") return percentText(value);
  if (metric.kind === "money") return moneyText(value);
  return numberText(value);
}

function renderDelegation(analytics) {
  const architecture = record(analytics.architecture);
  const execution = record(analytics.execution);
  const sources = delegationSources(analytics);
  const source = sources.length
    ? nonEmptyRecord(analytics.delegation) || nonEmptyRecord(architecture.delegation) ||
      nonEmptyRecord(execution.delegation) || nonEmptyRecord(execution.summary) || execution
    : {};
  const metrics = [
    { label: "Delegations", keys: ["delegations"], kind: "number" },
    { label: "Parent count", keys: ["parentCount"], kind: "number" },
    { label: "Average fan-out", keys: ["fanOut", "averageFanOut"], kind: "number" },
    { label: "Maximum fan-out", keys: ["maxFanOut", "maximumFanOut"], kind: "number" },
    { label: "Maximum depth", keys: ["maxDepth", "maximumDepth", "depth"], kind: "number" },
    { label: "Child / parent token ratio", keys: ["parentChildTokenRatio", "childParentTokenRatio", "tokenRatio"], kind: "percent" },
    { label: "Parallelism", keys: ["parallelism", "averageParallelism", "maxParallelism", "peakParallelism"], kind: "number" },
    { label: "Parallelism ratio", keys: ["parallelismRatio"], kind: "percent" },
    { label: "Approximate critical path", keys: ["approximateCriticalPathMs", "criticalPathMs", "criticalPath"], kind: "duration" },
  ].map((metric) => ({ ...metric, value: delegationValue(sources, metric.keys) })).filter((metric) => hasValue(metric.value));
  const metricMarkup = metrics.map((metric) => `<div class="investigate-metric" data-metric="${escapeHtml(metric.label)}"><dt>${escapeHtml(metric.label)}</dt><dd>${escapeHtml(delegationMetricText(metric, metric.value))}</dd></div>`).join("");
  const empty = `<div class="investigate-empty">Unavailable — no delegation-health metrics were reported.</div>`;
  return `<section class="investigate-panel" aria-labelledby="investigate-delegation-title"><div class="investigate-section-heading"><div><p class="investigate-kicker">Execution topology</p><h3 id="investigate-delegation-title">Delegation health</h3><p class="investigate-evidence">${escapeHtml(evidenceText(source, "delegation-data-missing"))}</p></div>${statusMarkup(source, "delegation-data-missing")}</div><p class="investigate-section-note">Reported parent-child and parallel execution metrics only.</p><dl class="investigate-metrics">${metricMarkup || empty}</dl></section>`;
}

const decisionPrincipleOrder = Object.freeze(["intelligence", "cost", "speed"]);

function decisionConfidenceText(value) {
  const source = record(value);
  const confidenceValue = finite(source.value);
  return confidenceValue === null ? "confidence unavailable" : `confidence ${percentText(confidenceValue)}`;
}

function decisionEvidenceText(source) {
  const value = record(source);
  return `${availabilityText(value, "decision-support-missing")} · ${sampleText(value.sample)} · ${decisionConfidenceText(value.confidence)}`;
}

function renderDecisionPrinciples(source) {
  const rows = decisionPrincipleOrder.map((key) => list(source.principles).find((row) => row?.key === key)).filter(Boolean);
  if (!rows.length) return '<div class="investigate-empty">Unavailable — no principle scores were reported.</div>';
  return `<div class="investigate-principles" role="list">${rows.map((row) => {
    const score = finite(row.score);
    const scoreLabel = score === null ? "Unavailable" : `${numberText(score)} / 100`;
    const boundedScore = score === null ? null : Math.min(100, Math.max(0, score));
    const track = boundedScore === null
      ? '<div class="investigate-principle-track" aria-label="Score unavailable"></div>'
      : `<progress class="investigate-principle-track" aria-label="${escapeHtml(labelText(row.label))}" max="100" value="${boundedScore}" aria-valuenow="${boundedScore}">${boundedScore}</progress>`;
    const evidence = list(row.evidence).map((entry) => `<li>${escapeHtml(entry)}</li>`).join("");
     return `<article class="investigate-principle" role="listitem"><div class="investigate-principle-heading"><h4>${escapeHtml(labelText(row.label))}</h4><strong>${escapeHtml(scoreLabel)}</strong></div>${track}<p>${escapeHtml(text(row.conclusion, "No conclusion reported."))}</p><p class="investigate-reasoning"><strong>Reasoning:</strong> ${escapeHtml(text(row.reasoning, "No contribution reasoning reported."))}</p><div class="investigate-decision-meta">${escapeHtml(sampleText(row.sample))} · ${escapeHtml(decisionConfidenceText(row.confidence))}</div>${evidence ? `<ul class="investigate-evidence-list">${evidence}</ul>` : ""}</article>`;
  }).join("")}</div>`;
}

function renderDecisionConclusions(source) {
  const rows = list(source.conclusions).filter(isRecord).slice(0, 8);
  if (!rows.length) return '<div class="investigate-empty">No actionable conclusions for the observed sample.</div>';
  return `<div class="investigate-conclusions" role="list">${rows.map((row) => {
    const evidence = list(row.evidence).map((entry) => `<li>${escapeHtml(entry)}</li>`).join("");
     return `<article class="investigate-conclusion" role="listitem"><div class="investigate-conclusion-heading"><h4>${escapeHtml(text(row.title, "Untitled conclusion"))}</h4><span class="investigate-table-kind">${escapeHtml(text(row.severity, "info"))}</span></div><p>${escapeHtml(text(row.suggestion, "No suggestion reported."))}</p><p class="investigate-reasoning"><strong>Reasoning:</strong> ${escapeHtml(text(row.reasoning, "No contribution reasoning reported."))}</p>${evidence ? `<ul class="investigate-evidence-list">${evidence}</ul>` : ""}<div class="investigate-decision-meta">${escapeHtml(sampleText(row.sample))} · ${escapeHtml(decisionConfidenceText(row.confidence))}</div></article>`;
  }).join("")}</div>`;
}

function renderAccessChannels(source) {
  const rows = list(source.accessChannels).filter(isRecord);
  if (!rows.length) return '<div class="investigate-empty">Unavailable — no observed access-channel calls.</div>';
  const body = rows.map((row) => {
    const tools = list(row.tools).filter(isRecord).map((tool) => `<li><span>${escapeHtml(text(tool.tool, "unknown"))}</span><span>${escapeHtml(numberText(tool.calls))} calls · ${escapeHtml(text(tool.classification, "unknown"))} · provider ${escapeHtml(text(tool.provider, "unknown"))}</span></li>`).join("");
    const evidence = list(row.evidence).map((entry) => `<li>${escapeHtml(entry)}</li>`).join("");
    return `<article class="investigate-channel" role="listitem"><div class="investigate-channel-heading"><h4>${escapeHtml(text(row.label, row.key || "unknown"))}</h4><strong>${escapeHtml(numberText(row.calls))} calls</strong></div><ul class="investigate-channel-tools">${tools || "<li>Unavailable — no named tools.</li>"}</ul>${evidence ? `<ul class="investigate-evidence-list">${evidence}</ul>` : ""}</article>`;
  }).join("");
  return `<div class="investigate-channels" role="list">${body}</div>`;
}

function renderDecisionSupport(analytics) {
  const advice = record(analytics.advice);
  const source = record(advice.decisionSupport);
  const available = Object.keys(source).length > 0;
  const detail = available ? decisionEvidenceText(source) : "Unavailable · decision-support-missing · sample — · confidence unavailable";
  return `<section class="investigate-panel investigate-panel-wide investigate-advice" aria-labelledby="investigate-advice-title"><div class="investigate-section-heading"><div><p class="investigate-kicker">Decision support</p><h3 id="investigate-advice-title">Advice &amp; conclusions</h3><p class="investigate-evidence">${escapeHtml(detail)}</p></div>${statusMarkup(source, "decision-support-missing")}</div><p class="investigate-section-note">Scores describe observed workflow allocation and efficiency only; they do not rate provider or model intelligence.</p>${available ? `<div class="investigate-advice-grid"><section aria-labelledby="investigate-principles-title"><h4 id="investigate-principles-title">Principle bars</h4>${renderDecisionPrinciples(source)}</section><section aria-labelledby="investigate-conclusions-title"><h4 id="investigate-conclusions-title">Top conclusions</h4>${renderDecisionConclusions(source)}</section></div><section class="investigate-channel-section" aria-labelledby="investigate-channels-title"><div class="investigate-table-heading"><h4 id="investigate-channels-title">Observed access channels</h4><span class="investigate-table-kind">Explicit names only</span></div>${renderAccessChannels(source)}</section>` : '<div class="investigate-empty">Unavailable — no decision-support evidence was reported.</div>'}</section>`;
}

function renderInvestigationNote(analytics) {
  const provenance = record(record(analytics.architecture).provenance);
  const aliasing = provenance.aliasing === "privacy-safe-deterministic";
  return `<p class="investigate-note">${escapeHtml(aliasing ? "Aggregate analytics only; architecture identifiers use privacy-safe deterministic aliases." : "Aggregate analytics only; raw session content and identifiers are not rendered here.")}</p>`;
}

export function renderInvestigateView(context = {}) {
  const source = analyticsOf(record(context).payload ?? context);
  const comparisons = record(source.comparisons);
  const failures = record(source.failures);
  return `<div class="investigate-view" data-investigate-view>
    <header class="investigate-header"><div><p class="investigate-kicker">Evidence review</p><h2>Investigation</h2><p>Comparable performance, failure hotspots, and delegation health from accepted analytics evidence.</p></div><div class="investigate-header-status"><span class="investigate-header-label">Data scope</span><strong>Aggregate only</strong><small>Read-only analytics</small></div></header>
    ${renderInvestigationNote(source)}
    <div class="investigate-grid">${renderComparisons(comparisons)}${renderHotspots(failures)}${renderDelegation(source)}</div>
    ${renderDecisionSupport(source)}
  </div>`;
}

function contextArgs(rootOrContext, maybeContext, mountedRoot) {
  const looksLikeContext = maybeContext === undefined && isRecord(rootOrContext) && (
    Object.prototype.hasOwnProperty.call(rootOrContext, "payload") ||
    Object.prototype.hasOwnProperty.call(rootOrContext, "previousPayload") ||
    Object.prototype.hasOwnProperty.call(rootOrContext, "state") ||
    Object.prototype.hasOwnProperty.call(rootOrContext, "actions")
  );
  return looksLikeContext
    ? { root: mountedRoot, context: rootOrContext }
    : { root: rootOrContext, context: isRecord(maybeContext) ? maybeContext : {} };
}

function writeView(root, context) {
  if (!root || typeof root !== "object") return renderInvestigateView(context);
  const markup = renderInvestigateView(context);
  if ("innerHTML" in root) {
    root.innerHTML = markup;
  } else if (typeof root.replaceChildren === "function" && root.ownerDocument?.createElement) {
    const wrapper = root.ownerDocument.createElement("div");
    wrapper.innerHTML = markup;
    root.replaceChildren(...wrapper.childNodes);
  }
  return "innerHTML" in root ? root.innerHTML : markup;
}

export function createInvestigateView() {
  let mountedRoot = null;
  return Object.freeze({
    mount(rootOrContext, maybeContext) {
      const args = contextArgs(rootOrContext, maybeContext, mountedRoot);
      mountedRoot = args.root || mountedRoot;
      return writeView(args.root, args.context);
    },
    update(rootOrContext, maybeContext) {
      const args = contextArgs(rootOrContext, maybeContext, mountedRoot);
      mountedRoot = args.root || mountedRoot;
      return writeView(args.root || mountedRoot, args.context);
    },
    destroy(root) {
      const target = root || mountedRoot;
      if (target && typeof target.replaceChildren === "function") target.replaceChildren();
      else if (target && typeof target === "object" && "innerHTML" in target) target.innerHTML = "";
      if (!root || root === mountedRoot) mountedRoot = null;
    },
  });
}
