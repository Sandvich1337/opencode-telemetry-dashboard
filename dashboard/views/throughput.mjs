import { createViewLifecycle } from "../core/views.mjs";

const RATE_LABEL = "Workflow throughput";
const TREND_TITLE_ID = "throughput-trend-title";
const TREND_DESCRIPTION_ID = "throughput-trend-description";
const EMPTY = Object.freeze({});

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : EMPTY;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function escapeHtml(value) {
  return String(value ?? "—").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function formatNumber(value, digits = 2) {
  const number = finite(value);
  if (number === null) return "—";
  const normalized = Object.is(number, -0) ? 0 : number;
  return normalized.toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
    useGrouping: true,
  });
}

function formatSigned(value, digits = 2) {
  const number = finite(value);
  if (number === null) return "—";
  if (number === 0) return "0";
  return `${number > 0 ? "+" : "−"}${formatNumber(Math.abs(number), digits)}`;
}

function formatDuration(value) {
  const number = finite(value);
  return number === null ? "—" : `${formatNumber(number)} ms`;
}

function formatMoney(value) {
  const number = finite(value);
  return number === null ? "—" : `$${formatNumber(number, 4)}`;
}

function formatFraction(value) {
  const number = finite(value);
  return number === null ? "—" : `${formatNumber(number * 100)}%`;
}

function formatSample(value) {
  const sample = record(value);
  const observed = finite(sample.observed) ?? finite(sample.valid) ?? 0;
  const denominator = finite(sample.denominator) ?? finite(sample.count) ?? finite(sample.total);
  if (denominator !== null) return `${formatNumber(observed, 0)}/${formatNumber(denominator, 0)} samples`;
  if (finite(sample.count) !== null) return `${formatNumber(observed, 0)} samples`;
  return "sample unavailable";
}

function reasonOf(value, fallback = "unavailable") {
  const reason = record(value).reason ?? value;
  return typeof reason === "string" && reason.trim() ? reason : fallback;
}

function availabilityOf(value, fallback = {}) {
  const source = record(value);
  return {
    available: source.available === true,
    reason: reasonOf(source, fallback.reason ?? "unavailable"),
    sample: source.sample ?? fallback.sample ?? null,
  };
}

function metricInfo(value, fallbackReason = "unavailable") {
  const source = record(value);
  const candidate = source.rate !== undefined ? source.rate : value;
  return {
    value: finite(candidate),
    reason: reasonOf(source.reason, fallbackReason),
    numerator: finite(source.numerator),
    denominator: finite(source.denominator),
    sample: source.sample ?? null,
  };
}

function unavailableMarkup(reason) {
  const reasonText = reasonOf(reason);
  return `<span class="throughput-unavailable" aria-label="Unavailable: ${escapeHtml(reasonText)}" title="${escapeHtml(reasonText)}">Unavailable</span> <span class="throughput-reason">(${escapeHtml(reasonText)})</span>`;
}

function metricMarkup(value, { format = formatNumber, suffix = "", reason = "unavailable" } = {}) {
  const info = metricInfo(value, reason);
  if (info.value === null) return unavailableMarkup(info.reason);
  return `${escapeHtml(format(info.value))}${suffix ? ` ${escapeHtml(suffix)}` : ""}`;
}

function infoDetails({ numerator, denominator, basis, sample }) {
  const sampleText = sample ? ` Sample: ${formatSample(sample)}.` : "";
  return `Numerator: ${numerator}. Denominator: ${denominator}. Basis: ${basis}.${sampleText}`;
}

function helpMarkup(label, details) {
  const accessibleLabel = `${label}. ${details}`;
  return `<details class="throughput-help"><summary aria-label="${escapeHtml(accessibleLabel)}" title="${escapeHtml(details)}">?</summary><p>${escapeHtml(details)}</p></details>`;
}

function kpiCard({
  id,
  label,
  value,
  format = formatNumber,
  suffix = "",
  reason,
  basis,
  denominator,
  numerator,
  sample,
  delta,
  deltaReason,
  deltaFormat = formatNumber,
  deltaSuffix = "",
}) {
  const details = infoDetails({ numerator, denominator, basis, sample });
  const deltaValue = finite(delta);
  const deltaTone = deltaValue === null ? "unavailable" : deltaValue > 0 ? "positive" : deltaValue < 0 ? "negative" : "neutral";
  const deltaText = deltaValue === null
    ? `Unavailable (${reasonOf(deltaReason ?? "previous-unavailable")})`
    : `${formatSigned(deltaValue)}${deltaSuffix ? ` ${deltaSuffix}` : ""}`;
  const deltaMarkup = deltaValue === null
    ? `<p class="throughput-delta unavailable" aria-label="Change versus previous: ${escapeHtml(deltaText)}"><span>Δ vs previous:</span> ${unavailableMarkup(deltaReason ?? "previous-unavailable")}</p>`
    : `<p class="throughput-delta ${deltaTone}" aria-label="Change versus previous: ${escapeHtml(deltaText)}"><span>Δ vs previous:</span> ${escapeHtml(formatSigned(deltaValue))}${deltaSuffix ? ` ${escapeHtml(deltaSuffix)}` : ""}</p>`;
  return `<article class="throughput-kpi" data-metric="${escapeHtml(id)}">
    <div class="throughput-kpi-heading"><h3>${escapeHtml(label)}</h3>${helpMarkup(label, details)}</div>
    <p class="throughput-kpi-value">${metricMarkup(value, { format, suffix, reason })}</p>
    <div class="throughput-kpi-evidence" aria-label="${escapeHtml(`${label} evidence`)}">
      <p class="throughput-kpi-basis"><strong>Basis:</strong> ${escapeHtml(basis)}</p>
      <p class="throughput-kpi-denominator"><strong>Denominator:</strong> ${escapeHtml(denominator)}</p>
      ${sample ? `<p class="throughput-kpi-sample"><strong>Sample:</strong> ${escapeHtml(formatSample(sample))}</p>` : ""}
    </div>
    ${deltaMarkup}
  </article>`;
}

function analyticsOf(context) {
  const contextRecord = record(context);
  const payload = record(contextRecord.payload);
  const source = Object.keys(payload).length ? payload : contextRecord;
  const analytics = record(source.analytics);
  const previousPayload = record(contextRecord.previousPayload);
  const previousSource = record(previousPayload.payload);
  const previousRoot = Object.keys(previousSource).length ? previousSource : previousPayload;
  const previousAnalytics = record(previousRoot.analytics);
  const previousTrends = record(previousAnalytics.trends ?? previousRoot.trends);
  return {
    throughput: record(analytics.throughput ?? source.throughput),
    trends: record(analytics.trends ?? source.trends),
    efficiency: record(analytics.efficiency ?? source.efficiency),
    previousThroughput: record(previousAnalytics.throughput ?? previousRoot.throughput ?? previousTrends.current),
  };
}

function currentData(analytics) {
  const trends = analytics.trends;
  return Object.keys(record(trends.current)).length ? trends.current : analytics.throughput;
}

function previousData(analytics) {
  return Object.keys(record(analytics.trends.previous)).length ? analytics.trends.previous : null;
}

function trendDelta(trends, section, key) {
  return record(record(trends.deltas)[section])[key];
}

function trendReason(trends, section, key) {
  return record(record(trends.deltaReasons)[section])[key]
    ?? trends.availability?.reason
    ?? "previous-unavailable";
}

function difference(current, previous) {
  const left = finite(current);
  const right = finite(previous);
  return left === null || right === null ? null : left - right;
}

function fallbackTrends(analytics) {
  const supplied = record(analytics.trends);
  const current = currentData(analytics);
  const previous = analytics.previousThroughput;
  if (!Object.keys(previous).length || Object.keys(record(supplied.previous)).length) return supplied;
  const basisKeys = ["activeWallMs", "summedWorkMs", "parallelism"];
  const rateKeys = [
    "processedTokensPerMinute",
    "generatedTokensPerMinute",
    "outputTokensPerMinute",
    "toolCallsPerMinute",
    "estimatedUsdPerHour",
  ];
  const deltas = {
    ...supplied.deltas,
    basis: Object.fromEntries(basisKeys.map((key) => [key, difference(current.basis?.[key], previous.basis?.[key])])),
    totals: Object.fromEntries(rateKeys.map((key) => [key, difference(current.totals?.rates?.[key], previous.totals?.rates?.[key])])),
  };
  const deltaReasons = {
    ...supplied.deltaReasons,
    basis: Object.fromEntries(basisKeys.map((key) => [key, deltas.basis[key] === null ? "unavailable" : "measured"])),
    totals: Object.fromEntries(rateKeys.map((key) => [key, deltas.totals[key] === null ? "unavailable" : "measured"])),
  };
  const currentAvailable = current.availability?.available === true;
  const previousAvailable = previous.availability?.available === true;
  const reason = currentAvailable && previousAvailable
    ? "comparison-ready"
    : !currentAvailable ? (current.availability?.reason ?? "current-unavailable") : "previous-unavailable";
  return {
    ...supplied,
    availability: { ...record(supplied.availability), available: currentAvailable && previousAvailable, basis: supplied.availability?.basis ?? "derived", reason, sample: supplied.availability?.sample ?? current.sample },
    sample: supplied.sample ?? current.sample,
    previousSample: supplied.previousSample ?? previous.sample ?? null,
    current: supplied.current ?? current,
    previous,
    deltas,
    deltaReasons,
  };
}

function renderStatus(throughput, trends, efficiency) {
  const trendAvailability = availabilityOf(trends.availability, {
    reason: throughput.availability?.reason,
    sample: trends.sample ?? throughput.sample,
  });
  const currentAvailability = availabilityOf(throughput.availability, {
    reason: "throughput-unavailable",
    sample: throughput.sample,
  });
  const efficiencyAvailability = availabilityOf(efficiency.availability, { reason: "efficiency-unavailable" });
  const current = currentAvailability.available ? "Available" : "Unavailable";
  const comparison = trendAvailability.available ? "Available" : "Unavailable";
  const efficiencyText = efficiencyAvailability.available ? "available" : `unavailable (${efficiencyAvailability.reason})`;
  const previous = trends.previous ? formatSample(trends.previousSample ?? trends.previous.sample) : "unavailable";
  return `<p class="throughput-status ${trendAvailability.available ? "available" : "unavailable"}" role="status" aria-live="polite">
    Current: ${escapeHtml(current)} (${escapeHtml(currentAvailability.reason)}; sample ${escapeHtml(formatSample(currentAvailability.sample))}).
    Trend comparison: ${escapeHtml(comparison)} (${escapeHtml(trendAvailability.reason)}; current sample ${escapeHtml(formatSample(trends.sample ?? throughput.sample))}; previous sample ${escapeHtml(previous)}).
    Efficiency: ${escapeHtml(efficiencyText)}.
  </p>`;
}

function renderKpis(throughput, trends) {
  const basis = record(throughput.basis);
  const totals = record(throughput.totals);
  const tokens = record(totals.tokens);
  const rates = record(totals.rates);
  const rateReasons = record(throughput.rateReasons);
  const provenance = record(throughput.provenance);
  const sample = throughput.sample;
  const intervalBasis = provenance.intervalMethod ?? basis.intervalMethod ?? "clamped positive interval union";
  const costBasis = provenance.costBasis ?? throughput.costAvailability?.basis ?? "reported cost evidence";
  const activeWall = finite(basis.activeWallMs);
  const summedWork = finite(basis.summedWorkMs);
  const cards = [
    {
      id: "active-wall-ms",
      label: "Active wall time",
      value: activeWall,
      format: formatDuration,
      basis: intervalBasis,
      denominator: "Union of positive clipped run intervals (timing basis)",
      numerator: activeWall === null ? "unavailable" : `${formatDuration(activeWall)} union duration`,
      sample,
      delta: trendDelta(trends, "basis", "activeWallMs"),
      deltaReason: trendReason(trends, "basis", "activeWallMs"),
      deltaFormat: formatDuration,
      deltaSuffix: "ms",
    },
    {
      id: "summed-work-ms",
      label: "Summed work",
      value: summedWork,
      format: formatDuration,
      basis: "sum of positive clipped run intervals",
      denominator: "None (total work basis)",
      numerator: summedWork === null ? "unavailable" : `${formatDuration(summedWork)} summed work`,
      sample,
      delta: trendDelta(trends, "basis", "summedWorkMs"),
      deltaReason: trendReason(trends, "basis", "summedWorkMs"),
      deltaSuffix: "ms",
    },
    {
      id: "parallelism",
      label: "Concurrency",
      value: basis.parallelism,
      suffix: "×",
      reason: basis.activeWallMs > 0 ? "positive-denominator" : "no-positive-denominator",
      basis: "summed work ÷ active wall time",
      denominator: "Active wall time (union of positive intervals)",
      numerator: summedWork === null ? "summed work unavailable" : formatDuration(summedWork),
      sample,
      delta: trendDelta(trends, "basis", "parallelism"),
      deltaReason: trendReason(trends, "basis", "parallelism"),
      deltaSuffix: "×",
    },
    {
      id: "processed-tokens-per-minute",
      label: `${RATE_LABEL} · processed tokens/min`,
      value: rates.processedTokensPerMinute,
      suffix: "tokens/min",
      reason: rateReasons.processedTokensPerMinute,
      basis: "workflow wall-clock rate",
      denominator: "Active wall time in minutes",
      numerator: tokens.processed === undefined ? "processed tokens unavailable" : formatNumber(tokens.processed, 0),
      sample,
      delta: trendDelta(trends, "totals", "processedTokensPerMinute"),
      deltaReason: trendReason(trends, "totals", "processedTokensPerMinute"),
      deltaSuffix: "tokens/min",
    },
    {
      id: "generated-tokens-per-minute",
      label: `${RATE_LABEL} · generated tokens/min`,
      value: rates.generatedTokensPerMinute,
      suffix: "tokens/min",
      reason: rateReasons.generatedTokensPerMinute,
      basis: "workflow wall-clock rate",
      denominator: "Active wall time in minutes",
      numerator: tokens.generated === undefined ? "generated tokens unavailable" : formatNumber(tokens.generated, 0),
      sample,
      delta: trendDelta(trends, "totals", "generatedTokensPerMinute"),
      deltaReason: trendReason(trends, "totals", "generatedTokensPerMinute"),
      deltaSuffix: "tokens/min",
    },
    {
      id: "output-tokens-per-minute",
      label: `${RATE_LABEL} · output tokens/min`,
      value: rates.outputTokensPerMinute,
      suffix: "tokens/min",
      reason: rateReasons.outputTokensPerMinute,
      basis: "workflow wall-clock rate",
      denominator: "Active wall time in minutes",
      numerator: tokens.output === undefined ? "output tokens unavailable" : formatNumber(tokens.output, 0),
      sample,
      delta: trendDelta(trends, "totals", "outputTokensPerMinute"),
      deltaReason: trendReason(trends, "totals", "outputTokensPerMinute"),
      deltaSuffix: "tokens/min",
    },
    {
      id: "tool-calls-per-minute",
      label: `${RATE_LABEL} · tool calls/min`,
      value: rates.toolCallsPerMinute,
      suffix: "calls/min",
      reason: rateReasons.toolCallsPerMinute,
      basis: "workflow wall-clock rate",
      denominator: "Active wall time in minutes",
      numerator: finite(totals.calls) === null ? "tool calls unavailable" : formatNumber(totals.calls, 0),
      sample,
      delta: trendDelta(trends, "totals", "toolCallsPerMinute"),
      deltaReason: trendReason(trends, "totals", "toolCallsPerMinute"),
      deltaSuffix: "calls/min",
    },
    {
      id: "estimated-usd-per-hour",
      label: `${RATE_LABEL} · estimated USD/hour`,
      value: rates.estimatedUsdPerHour,
      format: formatMoney,
      suffix: "/hour",
      reason: rateReasons.estimatedUsdPerHour ?? throughput.costAvailability?.reason,
      basis: costBasis,
      denominator: "Active wall time in hours and reported USD only",
      numerator: totals.estimatedUsd === null || totals.estimatedUsd === undefined
        ? "reported USD unavailable"
        : formatMoney(totals.estimatedUsd),
      sample: throughput.costAvailability?.sample ?? sample,
      delta: trendDelta(trends, "totals", "estimatedUsdPerHour"),
      deltaReason: trendReason(trends, "totals", "estimatedUsdPerHour"),
      deltaSuffix: "USD/hour",
    },
  ];
  return `<section class="throughput-section" aria-labelledby="throughput-kpis-heading">
    <h2 id="throughput-kpis-heading">Workflow throughput basis and KPIs</h2>
    <div class="throughput-kpi-grid">${cards.map(kpiCard).join("")}</div>
  </section>`;
}

function seriesRate(bucket) {
  const source = record(bucket);
  const tokens = record(source.tokens);
  const activeMs = finite(source.activeMs);
  const output = finite(tokens.output);
  return activeMs !== null && activeMs > 0 && output !== null && output >= 0 ? output / (activeMs / 60_000) : null;
}

function seriesReason(bucket) {
  const source = record(bucket);
  const activeMs = finite(source.activeMs);
  if (activeMs === null || activeMs <= 0) return "no-positive-denominator";
  const output = finite(record(source.tokens).output);
  if (output === null) return "output-tokens-unavailable";
  if (output < 0) return "invalid-output-tokens";
  return "positive-denominator";
}

function usableTrendSeries(series) {
  return series.filter((bucket) => seriesRate(bucket) !== null);
}

function svgNumber(value) {
  const number = finite(value);
  return number === null ? "0" : number.toFixed(2);
}

function renderTrendSvg(series, suppliedCount = series.length) {
  const sorted = series.map((bucket, index) => ({ bucket: record(bucket), index }))
    .sort((left, right) => (finite(left.bucket.startMs) ?? left.index) - (finite(right.bucket.startMs) ?? right.index));
  const rates = sorted.map(({ bucket }) => seriesRate(bucket));
  const observed = rates.filter((value) => value !== null);
  const maxRate = observed.length ? Math.max(...observed, 1) : 1;
  const width = 720;
  const height = 240;
  const left = 42;
  const right = 14;
  const top = 22;
  const bottom = 28;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const xFor = (index) => sorted.length <= 1 ? left + chartWidth / 2 : left + (chartWidth * index) / (sorted.length - 1);
  const yFor = (value) => top + chartHeight - (value / maxRate) * chartHeight;
  const points = rates.map((rate, index) => rate === null ? null : `${svgNumber(xFor(index))},${svgNumber(yFor(rate))}`);
  const segments = [];
  let segment = [];
  for (const point of points) {
    if (point === null) {
      if (segment.length) segments.push(segment);
      segment = [];
    } else {
      segment.push(point);
    }
  }
  if (segment.length) segments.push(segment);
  const grid = [0, 0.5, 1].map((fraction) => {
    const y = yFor(maxRate * fraction);
    return `<line class="throughput-trend-gridline" x1="${svgNumber(left)}" y1="${svgNumber(y)}" x2="${svgNumber(width - right)}" y2="${svgNumber(y)}"></line><text class="throughput-trend-axis-label" x="${svgNumber(left - 7)}" y="${svgNumber(y + 4)}" text-anchor="end">${escapeHtml(formatNumber(maxRate * fraction))}</text>`;
  }).join("");
  const lines = segments.filter((pointsInSegment) => pointsInSegment.length > 1)
    .map((pointsInSegment) => `<polyline class="throughput-trend-line" points="${escapeHtml(pointsInSegment.join(" "))}"></polyline>`).join("");
  const circles = points.map((point, index) => point === null ? "" : `<circle class="throughput-trend-point" cx="${svgNumber(xFor(index))}" cy="${svgNumber(yFor(rates[index]))}" r="3"></circle>`).join("");
  const description = observed.length
    ? `${formatNumber(observed.length, 0)} of ${formatNumber(suppliedCount, 0)} supplied intervals have a positive active-wall denominator and recorded output tokens; values are output tokens per minute.`
    : "No supplied interval has both a positive active-wall denominator and recorded output tokens, so output token rates are unavailable.";
  const emptyLabel = observed.length ? "" : `<text class="throughput-trend-empty" x="${svgNumber(width / 2)}" y="${svgNumber(height / 2)}" text-anchor="middle">No output-rate evidence</text>`;
  return `<svg class="throughput-trend-svg" role="img" aria-label="${escapeHtml(description)}" aria-labelledby="${TREND_TITLE_ID} ${TREND_DESCRIPTION_ID}" data-supplied-count="${escapeHtml(suppliedCount)}" viewBox="0 0 ${width} ${height}" focusable="false">
    <title id="${TREND_TITLE_ID}">Workflow throughput trend</title>
    <desc id="${TREND_DESCRIPTION_ID}">${escapeHtml(description)}</desc>
    <g aria-hidden="true">${grid}${lines}${circles}${emptyLabel}</g>
  </svg>`;
}

function renderTrendTable(series) {
  const sorted = series.map((bucket, index) => ({ bucket: record(bucket), index }))
    .sort((left, right) => (finite(left.bucket.startMs) ?? left.index) - (finite(right.bucket.startMs) ?? right.index));
  const rows = sorted.map(({ bucket }, index) => {
    const rate = seriesRate(bucket);
    const reason = seriesReason(bucket);
    const calls = finite(bucket.calls);
    return `<tr>
      <th scope="row">Interval ${escapeHtml(formatNumber(index + 1, 0))}</th>
      <td data-label="Output tokens/min">${rate === null ? unavailableMarkup(reason) : `${escapeHtml(formatNumber(rate))} tokens/min`}</td>
      <td data-label="Active wall">${escapeHtml(formatDuration(bucket.activeMs))}</td>
      <td data-label="Concurrency">${metricMarkup(bucket.concurrency, { suffix: "×", reason })}</td>
      <td data-label="Tool calls">${calls === null ? unavailableMarkup("calls-unavailable") : escapeHtml(formatNumber(calls))}</td>
    </tr>`;
  }).join("");
  return `<div class="throughput-table-scroll" role="region" aria-label="Output token trend interval table" tabindex="0">
    <table class="throughput-table throughput-trend-table">
      <caption>Semantic interval data for the workflow throughput trend</caption>
      <thead><tr>
        <th scope="col">Interval</th>
         <th scope="col" title="Numerator: output tokens. Denominator: active wall time in minutes.">Output tokens/min</th>
        <th scope="col" title="Union of positive clipped intervals in this interval.">Active wall</th>
        <th scope="col" title="Summed work divided by active wall time.">Concurrency</th>
        <th scope="col">Tool calls</th>
      </tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="throughput-empty">No trend intervals available.</td></tr>`}</tbody>
    </table>
  </div>`;
}

function renderTrendSection(throughput) {
  const suppliedSeries = Array.isArray(throughput.series) ? throughput.series : [];
  const series = usableTrendSeries(suppliedSeries);
  return `<section class="throughput-section" aria-labelledby="throughput-trend-heading">
    <h2 id="throughput-trend-heading">Output tokens/min trend</h2>
    <p class="throughput-section-note">Only intervals with positive active wall time and recorded output tokens are plotted. The table is the accessible source of the output tokens/min values and denominator.</p>
    <div class="throughput-trend-visual">
      ${renderTrendSvg(series, suppliedSeries.length)}
      <p class="throughput-chart-alternative">The semantic interval table below is the mobile and non-visual alternative to this chart.</p>
    </div>
    ${renderTrendTable(series)}
  </section>`;
}

function renderAgentTable(throughput) {
  const agents = Array.isArray(throughput.byAgent) ? throughput.byAgent.slice().sort((left, right) => String(left?.agent ?? "").localeCompare(String(right?.agent ?? ""))) : [];
  const rows = agents.map((agent) => {
    const source = record(agent);
    const rates = record(source.rates);
    const reasons = record(source.rateReasons);
    return `<tr>
      <th scope="row">${escapeHtml(source.agent ?? "unknown")}</th>
      <td data-label="Runs">${escapeHtml(formatNumber(source.runs, 0))}</td>
      <td data-label="Active wall">${escapeHtml(formatDuration(source.activeMs))}</td>
      <td data-label="Processed tokens/min">${metricMarkup(rates.processedTokensPerMinute, { suffix: "tokens/min", reason: reasons.processedTokensPerMinute })}</td>
      <td data-label="Generated tokens/min">${metricMarkup(rates.generatedTokensPerMinute, { suffix: "tokens/min", reason: reasons.generatedTokensPerMinute })}</td>
      <td data-label="Output tokens/min">${metricMarkup(rates.outputTokensPerMinute, { suffix: "tokens/min", reason: reasons.outputTokensPerMinute })}</td>
      <td data-label="Tool calls/min">${metricMarkup(rates.toolCallsPerMinute, { suffix: "calls/min", reason: reasons.toolCallsPerMinute })}</td>
      <td data-label="Estimated USD/hour">${metricMarkup(rates.estimatedUsdPerHour, { format: formatMoney, suffix: "/hour", reason: reasons.estimatedUsdPerHour })}</td>
    </tr>`;
  }).join("");
  return `<section class="throughput-section" aria-labelledby="throughput-agent-heading">
    <h2 id="throughput-agent-heading">Per-agent ${RATE_LABEL.toLowerCase()}</h2>
    <div class="throughput-table-scroll" role="region" aria-label="Per-agent throughput table" tabindex="0">
      <table class="throughput-table throughput-agent-table">
        <caption>Per-agent workflow throughput rates; every rate uses that agent's active wall time.</caption>
        <thead><tr>
          <th scope="col">Agent</th><th scope="col">Runs</th><th scope="col" title="Union of positive intervals for this agent.">Active wall</th>
          <th scope="col" title="Numerator: processed tokens. Denominator: agent active wall time in minutes.">${RATE_LABEL} · processed tokens/min</th>
          <th scope="col" title="Numerator: generated tokens. Denominator: agent active wall time in minutes.">${RATE_LABEL} · generated tokens/min</th>
          <th scope="col" title="Numerator: output tokens. Denominator: agent active wall time in minutes.">${RATE_LABEL} · output tokens/min</th>
          <th scope="col" title="Numerator: tool calls. Denominator: agent active wall time in minutes.">${RATE_LABEL} · tool calls/min</th>
          <th scope="col" title="Numerator: reported USD. Denominator: agent active wall time in hours.">${RATE_LABEL} · estimated USD/hour</th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="8" class="throughput-empty">No per-agent rows available.</td></tr>`}</tbody>
      </table>
    </div>
  </section>`;
}

function renderEfficiencyCard({ id, label, value, format, suffix, reason, basis, denominator, numerator, sample }) {
  const details = infoDetails({ numerator, denominator, basis, sample });
  return `<article class="throughput-efficiency-card" data-metric="${escapeHtml(id)}">
    <div class="throughput-kpi-heading"><h3>${escapeHtml(label)}</h3>${helpMarkup(label, details)}</div>
    <p class="throughput-kpi-value">${metricMarkup(value, { format, suffix, reason })}</p>
    <p class="throughput-kpi-basis"><strong>Basis:</strong> ${escapeHtml(basis)}</p>
    <p class="throughput-kpi-denominator"><strong>Denominator:</strong> ${escapeHtml(denominator)}</p>
    ${sample ? `<p class="throughput-kpi-sample"><strong>Sample:</strong> ${escapeHtml(formatSample(sample))}</p>` : ""}
  </article>`;
}

function renderEfficiency(efficiency) {
  const source = record(efficiency);
  const tokens = record(source.tokens);
  const cacheShare = metricInfo(source.cacheReadShare, source.reasons?.[0] ?? "cache-share-unavailable");
  const reasoning = metricInfo(record(source.reasoningOutputMix).reasoning, "reasoning-mix-unavailable");
  const longContext = metricInfo(source.longContextCrossings, "long-context-unavailable");
  const savings = record(source.estimatedCacheSavings);
  const reviewer = record(source.reviewerPassEconomics);
  const inputTokens = finite(tokens.input);
  const cacheReadTokens = finite(tokens.cacheRead);
  const contextTokens = tokens === EMPTY || (inputTokens === null && cacheReadTokens === null)
    ? null
    : (inputTokens ?? 0) + (cacheReadTokens ?? 0);
  const contextReason = source.availability?.reason ?? "token-sample-missing";
  const contextSample = source.measuredSamples?.tokens ? { observed: source.measuredSamples.tokens, denominator: source.sample?.denominator ?? source.sample?.count } : source.sample;
  const savingsValue = finite(savings.estimatedUSD);
  const cards = [
    {
      id: "context-tokens",
      label: "Context tokens observed",
      value: contextTokens,
      format: (value) => formatNumber(value, 0),
      suffix: "tokens",
      reason: contextReason,
      basis: "input tokens + cache-read tokens",
      denominator: "Measured token samples",
      numerator: contextTokens === null ? "context token evidence unavailable" : formatNumber(contextTokens, 0),
      sample: contextSample,
    },
    {
      id: "cache-read-share",
      label: "Cache read share of context",
      value: source.cacheReadShare,
      format: formatFraction,
      suffix: "of context",
      reason: cacheShare.reason,
      basis: "recorded cache-read token evidence",
      denominator: "Input tokens + cache-read tokens",
      numerator: cacheShare.numerator === null ? "cache-read tokens unavailable" : formatNumber(cacheShare.numerator, 0),
      sample: cacheShare.sample ?? source.sample,
    },
    {
      id: "reasoning-share",
      label: "Reasoning share of generated output",
      value: record(source.reasoningOutputMix).reasoning,
      format: formatFraction,
      suffix: "of output + reasoning",
      reason: reasoning.reason,
      basis: "recorded output and reasoning token buckets",
      denominator: "Output tokens + reasoning tokens",
      numerator: reasoning.numerator === null ? "reasoning tokens unavailable" : formatNumber(reasoning.numerator, 0),
      sample: reasoning.sample ?? source.sample,
    },
    {
      id: "long-context-crossings",
      label: "Long-context crossings",
      value: source.longContextCrossings,
      format: formatFraction,
      suffix: "of evidenced runs",
      reason: longContext.reason,
      basis: `recorded-input-token threshold ${formatNumber(source.longContextCrossings?.thresholdTokens, 0)} (${source.longContextCrossings?.comparison ?? "explicit"})`,
      denominator: "Runs with recorded token evidence",
      numerator: longContext.numerator === null ? "threshold crossings unavailable" : formatNumber(longContext.numerator, 0),
      sample: longContext.sample ?? source.sample,
    },
    {
      id: "cache-savings",
      label: "Estimated cache savings",
      value: savingsValue,
      format: formatMoney,
      suffix: "estimated USD",
      reason: savings.reason ?? "pricing-evidence-missing",
      basis: savings.basis ?? "recorded pricing evidence",
      denominator: "Cache-read tokens with complete pricing evidence",
      numerator: savingsValue === null ? "cache savings unavailable" : formatMoney(savingsValue),
      sample: savings.sample ?? source.sample,
    },
    {
      id: "reviewer-pass-tokens",
      label: "Reviewer-linked PASS tokens / pass",
      value: reviewer.tokensPerPass,
      format: (value) => formatNumber(value, 0),
      suffix: "tokens/pass",
      reason: reviewer.reason ?? "no-attributable-reviewer-pass",
      basis: "tokens attributed only to reviewer-linked PASS runs",
      denominator: "Attributable reviewer-linked PASS runs",
      numerator: reviewer.tokens?.total === undefined ? "PASS tokens unavailable" : formatNumber(reviewer.tokens.total, 0),
      sample: reviewer.sample ?? source.sample,
    },
    {
      id: "reviewer-pass-cost",
      label: "Reviewer-linked PASS cost / pass",
      value: reviewer.estimatedCostPerPass,
      format: formatMoney,
      suffix: "USD/pass",
      reason: reviewer.reason ?? "no-attributable-reviewer-pass",
      basis: "reported cost attributed only to reviewer-linked PASS runs",
      denominator: "PASS runs with reported cost",
      numerator: reviewer.cost === null || reviewer.cost === undefined ? "PASS cost unavailable" : formatMoney(reviewer.cost),
      sample: reviewer.sample ?? source.sample,
    },
    {
      id: "reviewer-pass-duration",
      label: "Reviewer-linked PASS duration / pass",
      value: reviewer.durationPerPassMs,
      format: formatDuration,
      suffix: "ms/pass",
      reason: reviewer.reason ?? "no-attributable-reviewer-pass",
      basis: "duration attributed only to reviewer-linked PASS runs",
      denominator: "PASS runs with timing evidence",
      numerator: reviewer.durationMs === null || reviewer.durationMs === undefined ? "PASS duration unavailable" : formatDuration(reviewer.durationMs),
      sample: reviewer.sample ?? source.sample,
    },
  ];
  return `<section class="throughput-section" aria-labelledby="throughput-efficiency-heading">
    <h2 id="throughput-efficiency-heading">Efficiency evidence</h2>
    <p class="throughput-section-note">Efficiency is reported only from the supplied token, pricing, timing, long-context, and reviewer evidence; missing evidence stays unavailable.</p>
    <div class="throughput-efficiency-grid">${cards.map(renderEfficiencyCard).join("")}</div>
  </section>`;
}

function renderComparison(throughput, trends) {
  const current = record(trends.current).totals ? record(trends.current) : throughput;
  const previous = previousData({ trends });
  const currentTotals = record(current.totals);
  const previousTotals = record(previous?.totals);
  const currentRates = record(currentTotals.rates);
  const previousRates = record(previousTotals.rates);
  const rows = [
    [`${RATE_LABEL} · processed tokens/min`, currentRates.processedTokensPerMinute, previousRates.processedTokensPerMinute, "totals", "processedTokensPerMinute", "tokens/min"],
    [`${RATE_LABEL} · generated tokens/min`, currentRates.generatedTokensPerMinute, previousRates.generatedTokensPerMinute, "totals", "generatedTokensPerMinute", "tokens/min"],
    [`${RATE_LABEL} · output tokens/min`, currentRates.outputTokensPerMinute, previousRates.outputTokensPerMinute, "totals", "outputTokensPerMinute", "tokens/min"],
    [`${RATE_LABEL} · tool calls/min`, currentRates.toolCallsPerMinute, previousRates.toolCallsPerMinute, "totals", "toolCallsPerMinute", "calls/min"],
    [`${RATE_LABEL} · estimated USD/hour`, currentRates.estimatedUsdPerHour, previousRates.estimatedUsdPerHour, "totals", "estimatedUsdPerHour", "USD/hour"],
    ["Concurrency", current.basis?.parallelism, previous?.basis?.parallelism, "basis", "parallelism", "×"],
  ].map(([label, currentValue, previousValue, section, key, suffix]) => {
    const currentReason = current.rateReasons?.[key] ?? "unavailable";
    const previousReason = previous?.rateReasons?.[key] ?? "previous-unavailable";
    const delta = trendDelta(trends, section, key);
    const deltaReason = trendReason(trends, section, key);
    const format = key === "estimatedUsdPerHour" ? formatMoney : formatNumber;
    return `<tr>
      <th scope="row">${escapeHtml(label)}</th>
      <td data-label="Current">${metricMarkup(currentValue, { format, suffix, reason: currentReason })}</td>
      <td data-label="Previous">${previous ? metricMarkup(previousValue, { format, suffix, reason: previousReason }) : unavailableMarkup("previous-unavailable")}</td>
      <td data-label="Delta">${finite(delta) === null ? unavailableMarkup(deltaReason) : `${escapeHtml(formatSigned(delta))} ${escapeHtml(suffix)}`}</td>
      <td data-label="Delta evidence">${escapeHtml(deltaReason)}</td>
    </tr>`;
  }).join("");
  return `<section class="throughput-section" aria-labelledby="throughput-comparison-heading">
    <h2 id="throughput-comparison-heading">Current vs previous</h2>
    <p class="throughput-section-note">Deltas are current minus previous. A missing period, denominator, or cost sample is shown as unavailable rather than zero.</p>
    <div class="throughput-table-scroll" role="region" aria-label="Current versus previous throughput table" tabindex="0">
      <table class="throughput-table throughput-comparison-table">
        <caption>Current and previous workflow throughput values with auditable delta reasons</caption>
        <thead><tr><th scope="col">Metric</th><th scope="col">Current</th><th scope="col">Previous</th><th scope="col">Delta</th><th scope="col">Delta evidence</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

/** Pure, deterministic renderer for the throughput/trends/efficiency view. */
export function renderThroughputView(context = {}) {
  const analytics = analyticsOf(context);
  const trends = fallbackTrends(analytics);
  const throughput = currentData({ ...analytics, trends });
  const efficiency = analytics.efficiency;
  return `<div class="throughput-view" data-view="throughput">
    <header class="throughput-view-header">
      <span class="throughput-kicker">Wave 2B · audited analytics</span>
      <h1>Throughput, trends, and efficiency</h1>
      <p>Auditable workflow throughput based on interval unions, supplied token evidence, and reviewer-linked economics.</p>
    </header>
    ${renderStatus(throughput, trends, efficiency)}
    ${renderKpis(throughput, trends)}
    ${renderTrendSection(throughput)}
    ${renderAgentTable(throughput)}
    ${renderComparison(throughput, trends)}
    ${renderEfficiency(efficiency)}
  </div>`;
}

function elementLike(value) {
  return value && typeof value === "object" && (
    typeof value.innerHTML === "string" || typeof value.replaceChildren === "function"
  );
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

/** DOM lifecycle adapter. It also accepts the registry's (element, context) form. */
export function createThroughputView() {
  let mountedTarget = null;
  const mount = (first = {}, second) => {
    const context = invocation(first, second);
    mountedTarget = targetOf(context, mountedTarget);
    const markup = renderThroughputView(context);
    writeMarkup(mountedTarget, markup);
    return markup;
  };
  const update = (first = {}, second) => {
    const context = invocation(first, second);
    mountedTarget = targetOf(context, mountedTarget);
    const markup = renderThroughputView(context);
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
