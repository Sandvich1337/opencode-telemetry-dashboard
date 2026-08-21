const METRICS = Object.freeze([
  { key: "calls", label: "Calls", field: "calls" },
  { key: "tokens", label: "Tokens", field: "tokens" },
  { key: "estimated-cost", label: "Estimated cost", field: "estimatedUsd" },
  { key: "duration", label: "Duration", field: "durationMs" },
]);

const TYPE_ORDER = Object.freeze(["agent", "model", "tool"]);
const EDGE_ORDER = Object.freeze(["delegates-to", "uses-model", "calls-tool"]);
const SEVERITY_ORDER = Object.freeze({ error: 0, warning: 1, info: 2 });

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function text(value, fallback = "unknown") {
  if (value === null || value === undefined || typeof value === "object") return fallback;
  const result = String(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 160);
  return result || fallback;
}

function escapeHtml(value) {
  return String(value ?? "—").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character]));
}

function finite(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function positiveOrZero(value) {
  const result = finite(value);
  return result === null || result < 0 ? null : result;
}

function numberText(value) {
  const result = positiveOrZero(value);
  if (result === null) return "—";
  return result.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function moneyText(value) {
  const result = positiveOrZero(value);
  if (result === null) return "—";
  return `$${result.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

function durationText(value) {
  const result = positiveOrZero(value);
  if (result === null) return "—";
  if (result < 1000) return `${numberText(result)}ms`;
  if (result < 60000) return `${numberText(result / 1000)}s`;
  return `${numberText(result / 60000)}m`;
}

function percentText(value) {
  const result = finite(value);
  if (result === null || result < 0 || result > 1) return "—";
  return `${numberText(result * 100)}%`;
}

function metricText(metric, value) {
  if (metric === "estimated-cost") return moneyText(value);
  if (metric === "duration") return durationText(value);
  return numberText(value);
}

function metricLabel(metric) {
  return METRICS.find((entry) => entry.key === metric)?.label ?? "Calls";
}

function normalizeMetric(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "tokens" || normalized === "token") return "tokens";
  if (["estimated-cost", "estimatedcost", "estimatedusd", "cost", "usd"].includes(normalized)) return "estimated-cost";
  if (["duration", "durationms", "time"].includes(normalized)) return "duration";
  return "calls";
}

function metricField(metric) {
  return METRICS.find((entry) => entry.key === metric)?.field ?? "calls";
}

function metricValue(value, metric) {
  const source = record(value);
  return source ? positiveOrZero(source[metricField(metric)]) : null;
}

function alias(value, fallback = "unknown") {
  const candidate = text(value, "");
  return /^(?:agent|model|tool)-\d{3}$/.test(candidate) || candidate.endsWith("-unknown") ? candidate : fallback;
}

function orderedIndex(order, value) {
  const index = order.indexOf(value);
  return index < 0 ? order.length : index;
}

function fraction(value) {
  const result = finite(value);
  return result === null || result < 0 || result > 1 ? null : result;
}

function nodeType(value) {
  return TYPE_ORDER.includes(value) ? value : "other";
}

function nodeDataId(node, index = 0) {
  const source = record(node) ?? {};
  const type = nodeType(source.type);
  return alias(source.id, `node-${type}-${index + 1}`);
}

function evidenceText(value) {
  if (record(value)) {
    const signal = text(value.signal ?? value.name, "evidence");
    const numerator = positiveOrZero(value.numerator);
    const denominator = positiveOrZero(value.denominator);
    if (numerator !== null || denominator !== null) {
      return `${signal}: ${numberText(numerator)} / ${numberText(denominator)}`;
    }
    return signal;
  }
  return text(value, "evidence");
}

function availability(source, fallbackReason = "missing") {
  const value = record(source);
  if (!value) return { available: false, basis: "unavailable", reason: fallbackReason, sample: null };
  const evidence = record(value.availability);
  if (evidence?.available === false) {
    return {
      available: false,
      basis: text(evidence.basis, "unavailable"),
      reason: text(evidence.reason, fallbackReason),
      sample: record(evidence.sample) ?? record(value.sample),
    };
  }
  if (evidence?.available === null) {
    return {
      available: false,
      basis: text(evidence.basis, "unknown"),
      reason: text(evidence.reason, "unknown"),
      sample: record(evidence.sample) ?? record(value.sample),
    };
  }
  if (!evidence) {
    const knownEvidence = ["nodes", "edges", "roles", "toolRouting", "runs", "items", "summary", "delegations", "fanOut", "maxDepth"];
    const hasEvidence = knownEvidence.some((key) => Array.isArray(value[key]) ? value[key].length > 0 : value[key] !== undefined && value[key] !== null);
    if (!hasEvidence) return { available: false, basis: "unknown", reason: fallbackReason, sample: record(value.sample) };
  }
  return {
    available: true,
    basis: text(evidence?.basis, "observed"),
    reason: text(evidence?.reason, "present"),
    sample: record(evidence?.sample) ?? record(value.sample),
  };
}

function sampleText(value) {
  const sample = record(value);
  if (!sample) return "Sample unavailable";
  const count = positiveOrZero(sample.count);
  const observed = positiveOrZero(sample.observed);
  const denominator = positiveOrZero(sample.denominator);
  if (denominator === null) return `Sample ${numberText(count)} · observed ${numberText(observed)}`;
  return `Sample ${numberText(observed)} / ${numberText(denominator)}`;
}

function confidenceText(value) {
  const confidence = record(value);
  if (!confidence) return "Confidence unavailable";
  const score = percentText(confidence.value);
  return score === "—" ? `Confidence unavailable · ${text(confidence.reason, "unknown")}` :
    `${score} confidence · ${text(confidence.reason, "derived")}`;
}

function analyticsParts(payload) {
  const root = record(payload) ?? {};
  const analytics = record(root.analytics) ?? root;
  return {
    architecture: record(analytics.architecture) ?? record(root.architecture),
    execution: record(analytics.execution) ?? record(root.execution),
    advice: record(analytics.advice) ?? record(root.advice),
  };
}

function unavailableMarkup(label, state) {
  return `<div class="architecture-unavailable" role="note">
    <strong>${escapeHtml(label)} unavailable</strong>
    <span>Reason: ${escapeHtml(state.reason)} · basis: ${escapeHtml(state.basis)}</span>
    <span>${escapeHtml(sampleText(state.sample))}</span>
    <span>Metric values: —</span>
  </div>`;
}

function sectionHeading(id, title, description = "") {
  return `<div class="architecture-section-heading"><div><h3 id="${escapeHtml(id)}">${escapeHtml(title)}</h3>${description ? `<p>${escapeHtml(description)}</p>` : ""}</div></div>`;
}

function metricControls(metric) {
  return `<fieldset class="architecture-metric-controls">
    <legend>Topology and execution metric</legend>
    <div class="architecture-metric-buttons" role="group" aria-label="Metric controls">
      ${METRICS.map((entry) => `<button type="button" class="architecture-metric-button" data-architecture-metric="${entry.key}" data-metric="${entry.key}" aria-controls="architecture-topology-heading architecture-execution-heading" aria-pressed="${entry.key === metric}">${entry.label}</button>`).join("")}
    </div>
    <p class="architecture-metric-status" aria-live="polite">Showing ${escapeHtml(metricLabel(metric).toLowerCase())} across topology and execution.</p>
  </fieldset>`;
}

function nodeLabel(node) {
  const source = record(node) ?? {};
  const kind = text(source.type, "node");
  const label = text(source.label, alias(source.id, `${kind} node`));
  const nodeAlias = alias(source.id, "");
  return `<strong>${escapeHtml(label)}</strong>${nodeAlias ? `<span class="architecture-alias">${escapeHtml(nodeAlias)}</span>` : ""}`;
}

function nodeMarkup(node, metric, index = 0) {
  const source = record(node) ?? {};
  const type = nodeType(source.type);
  const stableId = nodeDataId(source, index);
  return `<li class="architecture-node" data-node-id="${escapeHtml(stableId)}" data-node-type="${escapeHtml(type)}">
    <div class="architecture-node-title">${nodeLabel(source)}</div>
    <span class="architecture-node-metric" data-value-metric="${metric}">${escapeHtml(metricText(metric, metricValue(source, metric)))}</span>
    <span class="architecture-node-detail">${escapeHtml(numberText(source.calls))} calls · ${escapeHtml(numberText(source.tokens))} tokens</span>
  </li>`;
}

function svgLabel(value, limit = 28) {
  const candidate = text(value, "unknown");
  return candidate.length > limit ? `${candidate.slice(0, limit - 1)}…` : candidate;
}

function topologyGeometry(architecture) {
  const nodes = list(architecture?.nodes).filter((node) => record(node) && TYPE_ORDER.includes(node.type)).slice().sort((left, right) =>
    (orderedIndex(TYPE_ORDER, left.type) - orderedIndex(TYPE_ORDER, right.type)) ||
    text(left.label, "").localeCompare(text(right.label, "")) ||
    text(left.id, "").localeCompare(text(right.id, "")));
  const layers = TYPE_ORDER.map((type) => nodes.filter((node) => node.type === type));
  const nodeWidth = 248;
  const nodeHeight = 66;
  const rowHeight = 84;
  const top = 54;
  const positions = new Map();
  layers.forEach((layer, layerIndex) => layer.forEach((node, rowIndex) => positions.set(text(node.id, ""), {
    x: 20 + layerIndex * 310,
    y: top + rowIndex * rowHeight,
    width: nodeWidth,
    height: nodeHeight,
  })));
  return {
    nodes,
    positions,
    width: 950,
    height: Math.max(218, top + Math.max(1, ...layers.map((layer) => layer.length)) * rowHeight + 12),
  };
}

function topologySvg(architecture, metric) {
  const geometry = topologyGeometry(architecture);
  if (!geometry.nodes.length) return `<div class="architecture-topology-visual architecture-empty" role="note">No observed nodes for the topology diagram.</div>`;
  const edges = topologyEdges(architecture).filter((edge) => geometry.positions.has(text(edge.source, "")) && geometry.positions.has(text(edge.target, "")));
  const edgeLines = edges.map((edge) => {
    const source = geometry.positions.get(text(edge.source, ""));
    const target = geometry.positions.get(text(edge.target, ""));
    const sourceX = source.x === target.x ? source.x + source.width / 2 : source.x + (source.x < target.x ? source.width : 0);
    const targetX = target.x === source.x ? target.x + target.width / 2 : target.x + (target.x < source.x ? target.width : 0);
    const relation = EDGE_ORDER.includes(edge.type) ? edge.type : "other";
    return `<line class="architecture-svg-edge architecture-svg-edge-${escapeHtml(relation)}" data-edge-type="${escapeHtml(relation)}" x1="${sourceX}" y1="${source.y + source.height / 2}" x2="${targetX}" y2="${target.y + target.height / 2}" marker-end="url(#architecture-topology-arrow)" />`;
  }).join("");
  const nodes = geometry.nodes.map((node, index) => {
    const position = geometry.positions.get(text(node.id, ""));
    const type = nodeType(node.type);
    const label = text(node.label, alias(node.id, `${type} node`));
    const nodeAlias = alias(node.id, "unknown");
    return `<g class="architecture-svg-node architecture-svg-node-${type}" data-node-id="${escapeHtml(nodeDataId(node, index))}" data-node-type="${type}">
      <title>${escapeHtml(`${label} (${nodeAlias}), ${metricText(metric, metricValue(node, metric))}`)}</title>
      <rect x="${position.x}" y="${position.y}" width="${position.width}" height="${position.height}" rx="8" />
      <text class="architecture-svg-node-type" x="${position.x + 14}" y="${position.y + 17}">${escapeHtml(type)}</text>
      <text class="architecture-svg-node-label" x="${position.x + 14}" y="${position.y + 38}">${escapeHtml(svgLabel(label))}</text>
      <text class="architecture-svg-node-metric" x="${position.x + position.width - 14}" y="${position.y + 38}" text-anchor="end">${escapeHtml(metricText(metric, metricValue(node, metric)))}</text>
      <text class="architecture-svg-node-alias" x="${position.x + 14}" y="${position.y + 56}">${escapeHtml(svgLabel(nodeAlias, 34))}</text>
    </g>`;
  }).join("");
  return `<div class="architecture-topology-visual">
    <div class="architecture-topology-visual-heading"><span class="architecture-eyebrow">Diagram</span><span>${escapeHtml(metricLabel(metric))} weight · ${escapeHtml(numberText(edges.length))} relationships</span></div>
    <svg class="architecture-topology-svg" viewBox="0 0 ${geometry.width} ${geometry.height}" role="img" aria-labelledby="architecture-topology-svg-title architecture-topology-svg-description" focusable="false">
      <title id="architecture-topology-svg-title">Layered agent topology</title>
      <desc id="architecture-topology-svg-description">Agents connect to models and tools. Node and relationship weights show ${escapeHtml(metricLabel(metric).toLowerCase())}.</desc>
      <defs><marker id="architecture-topology-arrow" markerHeight="7" markerWidth="7" orient="auto" refX="6" refY="3.5" viewBox="0 0 7 7"><path d="M0 0L7 3.5L0 7z" /></marker></defs>
      <g class="architecture-svg-edges" aria-hidden="true">${edgeLines}</g>
      <g class="architecture-svg-nodes">${nodes}</g>
    </svg>
    <div class="architecture-topology-layer-labels" aria-hidden="true">${TYPE_ORDER.map((type) => `<span>${type[0].toUpperCase()}${type.slice(1)} layer</span>`).join("")}</div>
  </div>`;
}

function topologyNodes(architecture, metric) {
  const nodes = list(architecture?.nodes).filter((node) => record(node));
  const ordered = nodes.slice().sort((left, right) =>
    (orderedIndex(TYPE_ORDER, left.type) - orderedIndex(TYPE_ORDER, right.type)) ||
    text(left.label, "").localeCompare(text(right.label, "")) ||
    text(left.id, "").localeCompare(text(right.id, "")));
  return TYPE_ORDER.map((type) => {
    const entries = ordered.filter((node) => node.type === type);
    const title = `${type[0].toUpperCase()}${type.slice(1)}s`;
    return `<section class="architecture-topology-layer" aria-labelledby="architecture-layer-${type}">
      <h4 id="architecture-layer-${type}">${title}</h4>
      ${entries.length ? `<ul class="architecture-node-list" aria-label="${escapeHtml(title)}" role="list">${entries.map((node, index) => nodeMarkup(node, metric, index)).join("")}</ul>` : `<p class="architecture-empty">No observed ${type} nodes.</p>`}
    </section>`;
  }).join("");
}

function edgeMarkup(edge, metric) {
  const source = record(edge) ?? {};
  const weight = record(source.weight) ?? {};
  const sourceAlias = alias(source.source, "unknown-source");
  const targetAlias = alias(source.target, "unknown-target");
  const relation = text(source.type, "relates-to");
  const edgeId = `${relation}-${sourceAlias}-${targetAlias}`;
  return `<li class="architecture-edge" data-edge-id="${escapeHtml(edgeId)}">
    <span class="architecture-edge-source">${escapeHtml(sourceAlias)}</span><span class="architecture-edge-arrow" aria-hidden="true">→</span><span class="architecture-edge-target">${escapeHtml(targetAlias)}</span>
    <span class="architecture-edge-type">${escapeHtml(relation)}</span>
    <strong class="architecture-edge-metric">${escapeHtml(metricText(metric, metricValue(weight, metric)))}</strong>
  </li>`;
}

function topologyEdges(architecture) {
  return list(architecture?.edges).filter((edge) => record(edge)).slice().sort((left, right) =>
    (orderedIndex(EDGE_ORDER, left.type) - orderedIndex(EDGE_ORDER, right.type)) ||
    text(left.source, "").localeCompare(text(right.source, "")) ||
    text(left.target, "").localeCompare(text(right.target, "")));
}

function semanticTopology(architecture, metric) {
  const nodes = list(architecture?.nodes).filter((node) => record(node)).slice().sort((left, right) =>
    text(left.id, "").localeCompare(text(right.id, "")));
  const edges = topologyEdges(architecture);
  const rows = [
    ...nodes.map((node) => `<tr><th scope="row">Node</th><td>${escapeHtml(alias(node.id, "unknown"))}</td><td>${escapeHtml(text(node.type, "unknown"))}</td><td>${escapeHtml(text(node.label, "unknown"))}</td><td>${escapeHtml(metricText(metric, metricValue(node, metric)))}</td></tr>`),
    ...edges.map((edge) => `<tr><th scope="row">Edge</th><td>${escapeHtml(alias(edge.source, "unknown"))} → ${escapeHtml(alias(edge.target, "unknown"))}</td><td>${escapeHtml(text(edge.type, "unknown"))}</td><td>relationship</td><td>${escapeHtml(metricText(metric, metricValue(edge.weight, metric)))}</td></tr>`),
  ].join("");
  return `<details class="architecture-semantic-fallback">
    <summary>Accessible topology table</summary>
    <table class="architecture-semantic-equivalent">
      <caption>Nonvisual semantic equivalent of the layered architecture topology</caption>
      <thead><tr><th scope="col">Kind</th><th scope="col">Alias</th><th scope="col">Type</th><th scope="col">Label</th><th scope="col">${escapeHtml(metricLabel(metric))}</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5">No topology evidence.</td></tr>`}</tbody>
    </table>
  </details>`;
}

function renderTopology(architecture, metric) {
  const state = availability(architecture, "missing-architecture");
  const edges = topologyEdges(architecture);
  return `${sectionHeading("architecture-topology-heading", "Layered topology", "Agents use models and tools; values show the selected metric.")}
    ${state.available ? `${topologySvg(architecture, metric)}
      <div class="architecture-topology-layers">${topologyNodes(architecture, metric)}</div>
      <div class="architecture-edge-summary"><h4>Observed relationships</h4>${edges.length ? `<ul class="architecture-edge-list">${edges.map((edge) => edgeMarkup(edge, metric)).join("")}</ul>` : `<p class="architecture-empty">No relationship evidence.</p>`}</div>
      ${semanticTopology(architecture, metric)}` : `${unavailableMarkup("Architecture topology evidence", state)}${semanticTopology({}, metric)}`}`;
}

function roleMarkup(role) {
  const source = record(role) ?? {};
  const evidence = list(source.evidence).filter((entry) => record(entry));
  const scores = record(source.scores) ?? {};
  const agentAlias = alias(source.agentAlias, "agent-unknown");
  return `<article class="architecture-role-card" data-agent-id="${escapeHtml(agentAlias)}">
    <header><h4>${escapeHtml(agentAlias)}</h4><span>${escapeHtml(text(source.agent, "unknown"))}</span></header>
    <p class="architecture-primary-role">Primary role: <strong>${escapeHtml(text(source.primaryRole, "not established"))}</strong></p>
    <p class="architecture-role-reasoning"><strong>Reasoning:</strong> ${escapeHtml(text(source.reasoning, "No role reasoning reported."))}</p>
    <dl class="architecture-definition-list">
      <div><dt>Confidence</dt><dd>${escapeHtml(confidenceText(source.confidence))}</dd></div>
      <div><dt>Sample</dt><dd>${escapeHtml(sampleText(source.sample))}</dd></div>
      ${Object.keys(scores).sort().map((key) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(percentText(scores[key]))}</dd></div>`).join("")}
    </dl>
    <details class="architecture-evidence"><summary>Role evidence (${evidence.length})</summary>
      ${evidence.length ? `<ul>${evidence.map((item) => `<li><span>${escapeHtml(text(item.signal, "signal"))}</span><span>${escapeHtml(numberText(item.numerator))} / ${escapeHtml(numberText(item.denominator))} · ${escapeHtml(percentText(item.value))}</span></li>`).join("")}</ul>` : `<p class="architecture-empty">Evidence unavailable.</p>`}
    </details>
  </article>`;
}

function routingMarkup(tool) {
  const source = record(tool) ?? {};
  const routes = list(source.routes).filter((route) => record(route)).slice().sort((left, right) =>
    text(left.agentAlias, left.agent).localeCompare(text(right.agentAlias, right.agent)));
  const toolName = text(source.tool, alias(source.toolAlias, "unknown tool"));
  const classificationEvidence = list(source.classificationEvidence).map(evidenceText);
  return `<article class="architecture-routing-card">
    <header><h4>${escapeHtml(toolName)}</h4><span>${escapeHtml(text(source.classification, "unknown"))}</span></header>
    <p>${escapeHtml(numberText(source.calls))} calls · ${escapeHtml(confidenceText(source.confidence))}</p>
    ${routes.length ? `<ul class="architecture-route-list">${routes.map((route) => {
      const share = fraction(route.share);
      const agent = alias(route.agentAlias, "agent-unknown");
       return `<li><span>${escapeHtml(agent)}</span><progress max="1"${share === null ? "" : ` value="${share}"`} aria-label="${escapeHtml(`${agent} routing share`)}">${escapeHtml(percentText(share))}</progress><span>${escapeHtml(percentText(share))} · ${escapeHtml(numberText(route.numerator))}/${escapeHtml(numberText(route.denominator))}</span></li>`;
     }).join("")}</ul>` : `<p class="architecture-empty">Routing share unavailable.</p>`}
    ${classificationEvidence.length ? `<details class="architecture-routing-evidence"><summary>Routing evidence</summary><ul>${classificationEvidence.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")}</ul></details>` : ""}
  </article>`;
}

function renderEvidence(architecture) {
  const state = availability(architecture, "missing-architecture");
  if (!state.available) return `${sectionHeading("architecture-evidence-heading", "Role confidence and routing shares", "Signals remain paired with their sample and evidence basis.")}${unavailableMarkup("Role and routing evidence", state)}`;
  return `${sectionHeading("architecture-evidence-heading", "Role confidence and routing shares", "Signals remain paired with their sample and evidence basis.")}
    <div class="architecture-role-grid">${list(architecture.roles).filter((role) => record(role)).map(roleMarkup).join("") || `<p class="architecture-empty">No role evidence.</p>`}</div>
    <div class="architecture-routing"><h4>Tool routing shares</h4><div class="architecture-routing-grid">${list(architecture.toolRouting).filter((tool) => record(tool)).map(routingMarkup).join("") || `<p class="architecture-empty">No tool routing evidence.</p>`}</div></div>`;
}

function delegationCard(label, value, formatter = numberText, approximate = false) {
  return `<div class="architecture-bottleneck-card"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(formatter(value))}${approximate ? `<span class="architecture-approximate">Approximate</span>` : ""}</dd></div>`;
}

function renderBottlenecks(architecture) {
  const state = availability(architecture, "missing-architecture");
  const delegation = record(architecture?.delegation);
  const delegationState = availability(delegation, "missing-delegation-evidence");
  if (!state.available || !delegationState.available) return `${sectionHeading("architecture-bottleneck-heading", "Delegation bottlenecks", "Derived coordination indicators; unavailable values remain unavailable rather than zero.")}${unavailableMarkup("Delegation bottlenecks", !state.available ? state : delegationState)}`;
  return `${sectionHeading("architecture-bottleneck-heading", "Delegation bottlenecks", "Derived coordination indicators; unavailable values remain unavailable rather than zero.")}
    <dl class="architecture-bottleneck-grid">
      ${delegationCard("Delegations", delegation.delegations)}
      ${delegationCard("Average fan-out", delegation.fanOut)}
      ${delegationCard("Maximum fan-out", delegation.maxFanOut)}
      ${delegationCard("Maximum depth", delegation.maxDepth)}
      ${delegationCard("Child / parent tokens", delegation.parentChildTokenRatio, percentText)}
      ${delegationCard("Approximate critical path", delegation.approximateCriticalPathMs, durationText, true)}
    </dl>`;
}

function adviceMarkup(item) {
  const source = record(item) ?? {};
  const severity = ["error", "warning", "info"].includes(source.severity) ? source.severity : "info";
  return `<article class="architecture-advice-card" data-severity="${severity}">
    <header><span class="architecture-severity">${escapeHtml(severity)}</span><h4>${escapeHtml(text(source.title, "Advice"))}</h4></header>
    <p>${escapeHtml(text(source.suggestion, "Review the available evidence."))}</p>
    <p class="architecture-advice-reasoning"><strong>Reasoning:</strong> ${escapeHtml(text(source.reasoning, "Evidence details are listed below."))}</p>
    <div class="architecture-advice-meta"><span>${escapeHtml(confidenceText(source.confidence))}</span><span>${escapeHtml(sampleText(source.sample))}</span></div>
    ${list(source.evidence).length ? `<ul class="architecture-advice-evidence">${list(source.evidence).map((entry) => `<li>${escapeHtml(evidenceText(entry))}</li>`).join("")}</ul>` : ""}
  </article>`;
}

function renderAdvice(architecture, advice) {
  const state = availability(advice, "missing-advice");
  if (!state.available) return `${sectionHeading("architecture-advice-heading", "Advice", "Deterministic recommendations grounded in the observed sample.")}${unavailableMarkup("Advice", state)}`;
  const items = list(advice.items).filter((item) => record(item)).slice().sort((left, right) =>
    (SEVERITY_ORDER[left.severity] ?? 9) - (SEVERITY_ORDER[right.severity] ?? 9) || text(left.code, "").localeCompare(text(right.code, "")) || text(left.title, "").localeCompare(text(right.title, "")));
  return `${sectionHeading("architecture-advice-heading", "Advice", text(advice.summary, "Deterministic advice from the observed sample."))}
    <div class="architecture-advice-grid">${items.length ? items.map(adviceMarkup).join("") : `<p class="architecture-empty">No actionable advice for the observed sample.</p>`}</div>`;
}

function executionRows(execution) {
  const aggregates = new Map();
  const addBuckets = (target, source) => {
    for (const key of ["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"]) {
      target[key] += positiveOrZero(source?.[key]) ?? 0;
    }
  };
  for (const source of list(execution?.runs).filter((run) => record(run))) {
    const depth = Math.max(0, Math.floor(positiveOrZero(source.depth) ?? 0));
    const agent = text(source.agent, "unknown");
    const model = text(source.model, "unknown");
    const key = `${depth}\u0000${agent}\u0000${model}`;
    if (!aggregates.has(key)) aggregates.set(key, {
      depth,
      agent,
      model,
      count: 0,
      durationMs: 0,
      tokens: 0,
      tokenBuckets: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      estimatedUsd: 0,
      costBasisCounts: {},
      toolCalls: 0,
      errors: 0,
    });
    const row = aggregates.get(key);
    row.count += positiveOrZero(source.count ?? source.runs) ?? 1;
    row.durationMs += positiveOrZero(source.durationMs) ?? 0;
    row.tokens += positiveOrZero(source.tokens) ?? 0;
    addBuckets(row.tokenBuckets, source.tokenBuckets);
    row.estimatedUsd += positiveOrZero(source.estimatedUsd) ?? 0;
    const basis = text(source.costBasis, "unavailable");
    if (basis !== "unavailable") row.costBasisCounts[basis] = (row.costBasisCounts[basis] ?? 0) + (positiveOrZero(source.count ?? source.runs) ?? 1);
    row.toolCalls += positiveOrZero(source.toolCalls) ?? 0;
    row.errors += positiveOrZero(source.errors) ?? 0;
  }
  return [...aggregates.values()].map((row) => {
    const bases = Object.keys(row.costBasisCounts).sort();
    const costBasis = bases.length === 1 ? bases[0] : bases.length > 1 ? "mixed" : "unavailable";
    const { costBasisCounts: ignored, ...publicRow } = row;
    return { ...publicRow, costBasis };
  }).sort((left, right) => left.depth - right.depth || left.agent.localeCompare(right.agent) || left.model.localeCompare(right.model));
}

function executionTree(rows, metric) {
  if (!rows.length) return `<p class="architecture-empty">No execution tree evidence.</p>`;
  return `<ol class="architecture-execution-tree" role="tree" aria-label="Privacy-safe execution tree" aria-setsize="${rows.length}">
    ${rows.map((row, index) => {
      const depth = Math.min(6, Math.max(0, row.depth));
      const selectedValue = metric === "calls" ? row.toolCalls : row[metric === "estimated-cost" ? "estimatedUsd" : metric === "duration" ? "durationMs" : "tokens"];
      return `<li class="architecture-execution-tree-row architecture-execution-depth-${depth}" role="treeitem" aria-level="${row.depth + 1}" aria-posinset="${index + 1}" aria-setsize="${rows.length}" data-tree-depth="${row.depth}">
        <div class="architecture-execution-tree-heading"><span class="architecture-tree-branch" aria-hidden="true">${depth ? "↳" : "•"}</span><strong>${escapeHtml(text(row.agent, "unknown"))}</strong><span class="architecture-tree-model">${escapeHtml(text(row.model, "unknown"))}</span><strong class="architecture-tree-value" data-value-metric="${metric}">${escapeHtml(metricText(metric, selectedValue))}</strong></div>
        <span class="architecture-execution-tree-detail">${escapeHtml(numberText(row.count))} runs · depth ${escapeHtml(numberText(row.depth))} · ${escapeHtml(numberText(row.toolCalls))} tool calls · ${escapeHtml(numberText(row.errors))} errors</span>
      </li>`;
    }).join("")}
  </ol>`;
}

function executionAggregateTable(rows, metric) {
  return `<div class="architecture-table-scroll"><table class="architecture-execution-table">
    <caption>Execution aggregates grouped by depth, agent, and model</caption>
    <thead><tr><th scope="col">Depth</th><th scope="col">Agent</th><th scope="col">Model</th><th scope="col">Runs</th><th scope="col">Calls</th><th scope="col">Tokens</th><th scope="col">Estimated cost</th><th scope="col">Duration</th><th scope="col">Errors</th><th scope="col">Selected metric</th></tr></thead>
    <tbody>${rows.length ? rows.map((row) => `<tr>
      <th scope="row">${escapeHtml(numberText(row.depth))}</th>
      <td>${escapeHtml(text(row.agent, "unknown"))}</td>
      <td>${escapeHtml(text(row.model, "unknown"))}</td>
      <td>${escapeHtml(numberText(row.count))}</td>
      <td>${escapeHtml(numberText(row.toolCalls))}</td>
      <td>${escapeHtml(numberText(row.tokens))}</td>
       <td>${escapeHtml(moneyText(row.estimatedUsd))} · ${escapeHtml(text(row.costBasis, "unavailable"))}</td>
      <td>${escapeHtml(durationText(row.durationMs))}</td>
      <td>${escapeHtml(numberText(row.errors))}</td>
      <td><strong>${escapeHtml(metricText(metric, metric === "calls" ? row.toolCalls : metric === "tokens" ? row.tokens : metric === "estimated-cost" ? row.estimatedUsd : row.durationMs))}</strong></td>
    </tr>`).join("") : `<tr><td colspan="10" class="architecture-empty">No execution aggregates.</td></tr>`}</tbody>
  </table></div>`;
}

function renderExecution(execution, metric) {
  const state = availability(execution, "missing-execution");
  if (!state.available) return `${sectionHeading("architecture-execution-heading", "Execution aggregates", "Compact deterministic aggregates grouped by depth, agent, and model.")}${unavailableMarkup("Execution evidence", state)}`;
  const summary = record(execution.summary) ?? {};
  const rows = executionRows(execution);
  const criticalPath = positiveOrZero(summary.approximateCriticalPathMs);
  return `${sectionHeading("architecture-execution-heading", "Execution aggregates", "Compact deterministic aggregates grouped by depth, agent, and model.")}
     <div class="architecture-execution-summary">
      <div class="architecture-summary-tile"><strong>${escapeHtml(numberText(summary.roots))}</strong><span>root runs</span></div>
      <div class="architecture-summary-tile"><strong>${escapeHtml(numberText(summary.children))}</strong><span>child runs</span></div>
      <div class="architecture-summary-tile"><strong>${escapeHtml(numberText(summary.maxDepth))}</strong><span>maximum depth</span></div>
      <div class="architecture-summary-tile"><strong>${escapeHtml(numberText(summary.fanOut))}</strong><span>average fan-out</span></div>
       <div class="architecture-summary-tile"><strong>${escapeHtml(durationText(criticalPath))}</strong><span>approximate critical path</span></div>
     </div>
     <div class="architecture-execution-tree-panel"><div class="architecture-section-heading"><div><h4>Execution tree</h4><p>Aggregate levels preserve depth without exposing run identifiers.</p></div></div>${executionTree(rows, metric)}</div>
     <p class="architecture-critical-path"><span>Approximate critical path</span>: ${escapeHtml(durationText(criticalPath))} <em>(nested duration estimate; not wall-clock)</em></p>
    ${execution.summaryText ? `<p class="architecture-execution-description">${escapeHtml(text(execution.summaryText, ""))}</p>` : ""}
    ${executionAggregateTable(rows, metric)}`;
}

function shortDescription(architecture) {
  const state = availability(architecture, "missing-architecture");
  if (!state.available) return `Architecture evidence unavailable: ${state.reason}.`;
  const summary = text(architecture.summary, "");
  if (summary) return summary;
  const nodes = list(architecture.nodes);
  const agents = nodes.filter((node) => node?.type === "agent").length;
  const models = nodes.filter((node) => node?.type === "model").length;
  const tools = nodes.filter((node) => node?.type === "tool").length;
  return `${numberText(agents)} agent${agents === 1 ? "" : "s"}, ${numberText(models)} model${models === 1 ? "" : "s"}, and ${numberText(tools)} tool${tools === 1 ? "" : "s"} represented in the observed topology.`;
}

/** Render a deterministic, dependency-free architecture view to markup. */
export function renderArchitectureView(context = {}, options = {}) {
  const source = record(context) ?? {};
  const metric = normalizeMetric(options.metric ?? source.metric ?? source.state?.architectureMetric ?? source.state?.metric);
  const parts = analyticsParts(source.payload ?? source);
  return `<div class="architecture-view" data-component="architecture" data-selected-metric="${metric}">
    <header class="architecture-header">
      <div><p class="architecture-kicker">Architecture / execution</p><h2>Agent topology</h2><p class="architecture-description">${escapeHtml(shortDescription(parts.architecture))}</p></div>
      ${metricControls(metric)}
    </header>
    <div class="architecture-content">
      <section class="architecture-section architecture-topology-section" aria-labelledby="architecture-topology-heading">${renderTopology(parts.architecture, metric)}</section>
      <section class="architecture-section architecture-evidence-section" aria-labelledby="architecture-evidence-heading">${renderEvidence(parts.architecture)}</section>
      <section class="architecture-section architecture-bottleneck-section" aria-labelledby="architecture-bottleneck-heading">${renderBottlenecks(parts.architecture)}</section>
      <section class="architecture-section architecture-advice-section" aria-labelledby="architecture-advice-heading">${renderAdvice(parts.architecture, parts.advice)}</section>
      <section class="architecture-section architecture-execution-section" aria-labelledby="architecture-execution-heading">${renderExecution(parts.execution, metric)}</section>
    </div>
  </div>`;
}

function mountable(value) {
  return value !== null && typeof value === "object" && ("innerHTML" in value || typeof value.replaceChildren === "function");
}

function rootFrom(context, configuredRoot) {
  if (mountable(context)) return context;
  const source = record(context) ?? {};
  return [source.mountPoint, source.element, source.root, source.container, source.el, configuredRoot].find(mountable) ?? null;
}

function invocation(first, second) {
  if (mountable(first)) return { ...record(second), element: first };
  return record(first) ?? {};
}

/** Create a reusable, listener-safe architecture view lifecycle. */
export function createArchitectureView(configuredRoot = null) {
  let root = mountable(configuredRoot) ? configuredRoot : mountable(configuredRoot?.root) ? configuredRoot.root : null;
  let metric = "calls";
  let context = { payload: {}, previousPayload: null, state: {}, actions: {} };
  let listener = null;

  const render = () => {
    if (!root) return;
    const markup = renderArchitectureView(context, { metric });
    if ("innerHTML" in root) root.innerHTML = markup;
    else if (typeof root.replaceChildren === "function" && root.ownerDocument?.createElement) {
      const wrapper = root.ownerDocument.createElement("div");
      wrapper.innerHTML = markup;
      root.replaceChildren(...wrapper.childNodes);
    }
  };

  const onMetricClick = (event) => {
    const target = event?.target;
    const button = target?.closest?.("[data-architecture-metric]");
    if (!button || (typeof root.contains === "function" && !root.contains(button))) return;
    metric = normalizeMetric(button.dataset?.architectureMetric ?? button.getAttribute?.("data-architecture-metric"));
    const actions = record(context.actions) ?? {};
    const action = actions.setArchitectureMetric ?? actions.onArchitectureMetricChange ?? actions.setMetric ?? actions.onMetricChange;
    if (typeof action === "function") action(metric);
    render();
  };

  const attach = () => {
    if (!root || listener || typeof root.addEventListener !== "function") return;
    listener = onMetricClick;
    root.addEventListener("click", listener);
  };

  const saveContext = (next = {}) => {
    const source = record(next) ?? {};
    context = {
      ...context,
      ...source,
      payload: Object.prototype.hasOwnProperty.call(source, "payload") ? source.payload : context.payload,
      previousPayload: Object.prototype.hasOwnProperty.call(source, "previousPayload") ? source.previousPayload : context.previousPayload,
      state: record(source.state) ?? context.state,
      actions: record(source.actions) ?? context.actions,
    };
    const requestedMetric = source.metric ?? context.state?.architectureMetric ?? context.state?.metric;
    if (requestedMetric !== undefined) metric = normalizeMetric(requestedMetric);
  };

  const mount = (first = {}, second) => {
    const next = invocation(first, second);
    const nextRoot = rootFrom(next, root);
    if (nextRoot && nextRoot !== root && listener && typeof root?.removeEventListener === "function") {
      root.removeEventListener("click", listener);
      listener = null;
    }
    root = nextRoot;
    saveContext(next);
    render();
    attach();
    return root;
  };

  const update = (first = {}, second) => {
    const next = invocation(first, second);
    const nextRoot = rootFrom(next, root);
    if (nextRoot && nextRoot !== root && listener && typeof root?.removeEventListener === "function") {
      root.removeEventListener("click", listener);
      listener = null;
    }
    root = nextRoot;
    saveContext(next);
    render();
    attach();
    return root;
  };

  const destroy = (element) => {
    if (mountable(element) && element !== root && listener && typeof root?.removeEventListener === "function") {
      root.removeEventListener("click", listener);
      listener = null;
    }
    if (mountable(element)) root = element;
    if (listener && typeof root?.removeEventListener === "function") root.removeEventListener("click", listener);
    listener = null;
    if (root && typeof root.replaceChildren === "function") root.replaceChildren();
    else if (root && "innerHTML" in root) root.innerHTML = "";
    root = null;
  };

  return Object.freeze({ mount, update, destroy });
}
