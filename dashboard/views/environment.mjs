import {
  createDownloadDescriptor,
  diffEnvironmentBaseline,
  principalRows,
  redactAggregatePayload,
} from "../core/export.mjs";

const ENVIRONMENT_ROOT_CLASS = "environment-view";

function escapeHtml(value) {
  return String(value ?? "—").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character]));
}

function number(value) {
  const result = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(result) ? String(result) : "—";
}

function sampleText(value) {
  const sample = value && typeof value === "object" ? value : {};
  const observed = number(sample.observed);
  const denominator = sample.denominator === null || sample.denominator === undefined
    ? "—" : number(sample.denominator);
  return `${observed} / ${denominator}`;
}

function confidenceText(value) {
  const confidence = value && typeof value === "object" ? Number(value.value) : NaN;
  return Number.isFinite(confidence) ? `${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}%` : "Unavailable";
}

function reasonText(reason, fallback = "unavailable") {
  const labels = {
    "client-opt-in-required": "Enable the local opt-in to show configured inventory.",
    "startup-opt-in-required": "The server was not started with environment inspection enabled.",
    "request-opt-in-required": "This request did not opt in to configured inventory.",
    disabled: "Configured inventory collection is disabled.",
    missing: "No environment inventory was included in this payload.",
    "inventory-present": "Inventory is available for this aggregate.",
    explicit: "Explicit caller-provided inventory.",
    snapshot: "Inventory observed in the loaded snapshot.",
    unavailable: "Inventory is unavailable for this aggregate.",
  };
  return labels[reason] ?? labels[fallback] ?? "Inventory is unavailable for this aggregate.";
}

function availabilityText(inventory) {
  const availability = inventory?.availability ?? {};
  return inventory?.available === true
    ? `Available — ${reasonText(availability.reason, "inventory-present")}`
    : `Unavailable — ${reasonText(availability.reason)}`;
}

function renderInventoryEvidence(inventory) {
  const availability = inventory?.availability ?? {};
  const provenance = inventory?.provenance ?? {};
  const basis = availability.basis ?? provenance.basis ?? "unavailable";
  return `<dl class="environment-evidence" aria-label="Inventory evidence"><div><dt>Basis</dt><dd>${escapeHtml(basis)}</dd></div><div><dt>Sample</dt><dd>${escapeHtml(sampleText(availability.sample ?? inventory?.sample))}</dd></div><div><dt>Confidence</dt><dd>${escapeHtml(confidenceText(inventory?.confidence))}</dd></div></dl>`;
}

function renderInventoryTable(inventory, heading, { emptyReason = "unavailable" } = {}) {
  const rows = principalRows({ analytics: { environment: { observed: inventory, configured: { available: false } } } }, { includeConfigured: false })
    .map((row) => ({ ...row, inventory: undefined }));
  if (!inventory?.available || !rows.length) {
    return `<div class="environment-inventory-empty" role="status"><strong>${escapeHtml(inventory?.available ? "No inventory was observed in this aggregate." : reasonText(inventory?.availability?.reason, emptyReason))}</strong></div>`;
  }
  return `<div class="environment-table-wrap table-scroll"><table class="environment-table">
    <caption>${escapeHtml(heading)}</caption>
    <thead><tr><th scope="col">Type</th><th scope="col">Name</th><th scope="col">Version</th><th scope="col">Available</th><th scope="col">Sample</th><th scope="col">Capabilities</th></tr></thead>
    <tbody>${rows.map((row) => `<tr>
      <td>${escapeHtml(row.type)}</td>
      <td>${escapeHtml(row.name)}</td>
      <td>${escapeHtml(row.version)}</td>
      <td>${row.available ? "Yes" : "No"}</td>
       <td>${escapeHtml(`${number(row.sampleObserved)} / ${number(row.sampleCount)}`)}</td>
      <td>${escapeHtml(row.capabilities)}</td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function renderConfiguredTable(environment, optIn, visible) {
  if (!optIn) {
    return `<aside class="environment-opt-in-banner environment-gated" role="note" aria-describedby="environment-opt-in-help"><strong>Configured inventory is hidden until you opt in.</strong><span>${escapeHtml(reasonText("client-opt-in-required"))} The server request must also explicitly provide configured inventory.</span></aside>`;
  }
  if (!visible) return `<p class="environment-availability unavailable" role="status">${escapeHtml(availabilityText(environment.configured))}</p>${renderInventoryEvidence(environment.configured)}<aside class="environment-state environment-gated" role="status"><strong>Configured inventory is unavailable.</strong><span>${escapeHtml(reasonText(environment.configured?.availability?.reason))}</span></aside>`;
  return `<p class="environment-availability available" role="status">${escapeHtml(availabilityText(environment.configured))}</p>${renderInventoryEvidence(environment.configured)}${renderInventoryTable(environment.configured, "Configured inventory", { emptyReason: "request-opt-in-required" })}`;
}

function renderDiff(current, baseline, includeConfigured) {
  if (baseline === null || baseline === undefined) {
    return `<p class="environment-diff-empty" role="status">No saved baseline yet. Save the current redacted inventory to compare later.</p>`;
  }
  const diff = diffEnvironmentBaseline(current, baseline, { includeConfigured });
  if (!diff.hasChanges) return `<p class="environment-diff-empty" role="status">No changes from the saved redacted baseline.</p>`;
  const itemLabel = (item) => item.after?.name ?? item.before?.name ?? item.key;
  const changedFields = (item) => ["available", "sampleCount", "sampleObserved", "sampleDenominator", "capabilities"]
    .filter((field) => item.before?.[field] !== item.after?.[field]);
  const list = (title, items, className) => items.length
    ? `<div class="environment-diff-group ${className}"><h4>${escapeHtml(title)} <span>(${items.length})</span></h4><ul>${items.map((item) => `<li>${escapeHtml(itemLabel(item))}${className === "changed" ? ` <span class="environment-diff-fields">(${escapeHtml(changedFields(item).join(", "))})</span>` : ""}</li>`).join("")}</ul></div>`
    : "";
  return `<div class="environment-diff-summary" aria-label="Baseline changes"><p class="environment-diff-counts"><span><strong>${escapeHtml(String(diff.counts.added))}</strong> added</span><span><strong>${escapeHtml(String(diff.counts.removed))}</strong> removed</span><span><strong>${escapeHtml(String(diff.counts.changed))}</strong> changed</span></p>${list("Added", diff.added, "added")}${list("Removed", diff.removed, "removed")}${list("Changed", diff.changed, "changed")}</div>`;
}

/** Pure renderer: it reads only the public analytics.environment payload. */
export function renderEnvironmentView(context = {}) {
  const payload = context?.payload ?? context;
  const state = context?.state ?? {};
  const includeConfigured = state.environmentOptIn === true;
  const environment = redactAggregatePayload(payload, { includeConfigured: true });
  const configuredVisible = includeConfigured && environment.configured.available === true;
  const baseline = state.savedRedactedBaseline ?? null;
  const currentForExport = redactAggregatePayload(payload, { includeConfigured });
  const observedCount = principalRows(payload, { includeConfigured: false }).length;
  const configuredCount = principalRows(payload, { includeConfigured }).filter((row) => row.inventory === "configured").length;

  return `<section class="${ENVIRONMENT_ROOT_CLASS}" data-component="environment" aria-labelledby="environment-view-title">
    <header class="environment-header"><div class="environment-header-copy"><p class="environment-kicker">Privacy-aware telemetry</p><h2 id="environment-view-title">Environment inventory</h2><p>Aggregate identities and capabilities only; source paths, commands, URLs, headers, environment values, and configuration values are not displayed or exported.</p></div><div class="environment-header-meta"><span class="environment-count" aria-label="Inventory totals">${escapeHtml(`${observedCount} observed · ${configuredCount} configured`)}</span><span class="environment-header-note">Redacted aggregate view</span></div></header>
    <div class="environment-inventory-grid">
      <section class="environment-panel environment-observed" aria-labelledby="environment-observed-title">
        <header class="environment-section-header"><div><p class="environment-kicker">Telemetry evidence</p><h3 id="environment-observed-title">Always-observed inventory</h3></div><span class="environment-mode-badge">observed</span></header>
         <p class="environment-availability ${environment.observed?.available ? "available" : "unavailable"}" role="status">${escapeHtml(availabilityText(environment.observed))}</p>
         ${renderInventoryEvidence(environment.observed)}
        ${renderInventoryTable(environment.observed, "Always-observed inventory")}
      </section>
      <section class="environment-panel environment-configured" aria-labelledby="environment-configured-title">
        <header class="environment-section-header"><div><p class="environment-kicker">Caller-provided evidence</p><h3 id="environment-configured-title">Configured inventory <span class="environment-opt-in-badge">opt-in</span></h3></div><span class="environment-mode-badge">configured</span></header>
        <p id="environment-opt-in-help" class="environment-section-note">Configured inventory is caller-provided metadata and is never collected implicitly. It requires both this local display opt-in and a request/server opt-in.</p>
        <fieldset class="environment-opt-in-fieldset"><legend class="sr-only">Configured inventory display opt-in</legend><label class="environment-opt-in-label" for="environment-opt-in"><input id="environment-opt-in" type="checkbox" data-environment-opt-in="true" aria-label="Show configured inventory" aria-describedby="environment-opt-in-help"${includeConfigured ? " checked" : ""}> <span>Show configured inventory</span></label></fieldset>
        <div class="environment-configured-content" aria-live="polite">${renderConfiguredTable(environment, includeConfigured, configuredVisible)}</div>
      </section>
    </div>
    <section class="environment-panel environment-baseline" aria-labelledby="environment-baseline-title">
      <header class="environment-section-header"><div><p class="environment-kicker">Local comparison</p><h3 id="environment-baseline-title">Redacted local baseline</h3></div><span class="environment-mode-badge">local only</span></header>
      <p class="environment-section-note">Baseline comparisons use the same allow-listed aggregate data as exports and remain in local dashboard state.</p>
      <p id="environment-export-help" class="environment-section-note">Downloads contain redacted aggregate data only. Spreadsheet values are protected from formula evaluation.</p>
      <div class="environment-actions" role="group" aria-label="Environment baseline and export actions" aria-describedby="environment-export-help"><button class="button-primary" type="button" data-environment-action="save-baseline">Save current baseline</button><button type="button" data-environment-action="download-json">Download JSON</button><button type="button" data-environment-action="download-csv">Download principal CSV</button></div>
      <div class="environment-diff" aria-live="polite">${renderDiff(currentForExport, baseline, includeConfigured)}</div>
    </section>
  </section>`;
}

function isElement(value) {
  return value !== null && typeof value === "object" && (typeof value.addEventListener === "function" || "innerHTML" in value || typeof value.replaceChildren === "function");
}

function rootFrom(value) {
  if (isElement(value)) return value;
  if (value && isElement(value.root)) return value.root;
  return null;
}

/**
 * Lifecycle wrapper. It supports both the dashboard registry signature
 * (mount(element, context)) and direct use (createEnvironmentView(element).
 * mount(context)).
 */
export function createEnvironmentView(initialRoot = null) {
  let host = rootFrom(initialRoot);
  let context = { payload: {}, previousPayload: null, state: {}, actions: {} };
  let boundHost = null;
  let onChange = null;
  let onClick = null;

  const detach = () => {
    const target = boundHost || host;
    if (target && onChange && typeof target.removeEventListener === "function") target.removeEventListener("change", onChange);
    if (target && onClick && typeof target.removeEventListener === "function") target.removeEventListener("click", onClick);
    boundHost = null;
    onChange = null;
    onClick = null;
  };

  const renderIntoHost = () => {
    const markup = renderEnvironmentView(context);
    if (host && "innerHTML" in host) host.innerHTML = markup;
    else if (host && typeof host.replaceChildren === "function" && host.ownerDocument?.createElement) {
      const wrapper = host.ownerDocument.createElement("div");
      wrapper.innerHTML = markup;
      host.replaceChildren(...wrapper.childNodes);
    }
    return markup;
  };

  const bind = () => {
    if (!host || typeof host.addEventListener !== "function") return;
    onChange = (event) => {
      const target = event?.target;
      if (!target || !target.dataset?.environmentOptIn) return;
      context.actions?.setEnvironmentOptIn?.(target.checked === true);
    };
    onClick = (event) => {
      let target = event?.target;
      if (target && typeof target.closest === "function") target = target.closest("[data-environment-action]");
      if (!target?.dataset?.environmentAction || (typeof host.contains === "function" && !host.contains(target))) return;
      const action = target.dataset.environmentAction;
      if (action === "save-baseline") {
        context.actions?.saveBaseline?.(redactAggregatePayload(context.payload, { includeConfigured: context.state?.environmentOptIn === true }));
      } else if (action === "download-json" || action === "download-csv") {
        const kind = action === "download-csv" ? "csv" : "json";
        const descriptor = createDownloadDescriptor(kind, context.payload, {
          includeConfigured: context.state?.environmentOptIn === true,
          filename: kind === "csv" ? "environment-principals" : "environment",
        });
        context.actions?.download?.(descriptor);
      }
    };
    host.addEventListener("change", onChange);
    host.addEventListener("click", onClick);
    boundHost = host;
  };

  const normalizeArgs = (first, second) => {
    if (isElement(first)) {
      host = first;
      return second && typeof second === "object" ? second : {};
    }
    if (first && typeof first === "object") {
      const candidateRoot = rootFrom(first.root);
      if (candidateRoot) host = candidateRoot;
      return first;
    }
    return {};
  };

  const saveContext = (next = {}) => {
    const source = next && typeof next === "object" && !Array.isArray(next) ? next : {};
    context = {
      ...context,
      ...source,
      state: source.state && typeof source.state === "object" && !Array.isArray(source.state) ? source.state : context.state,
      actions: source.actions && typeof source.actions === "object" && !Array.isArray(source.actions) ? source.actions : context.actions,
    };
  };

  const mount = (first = {}, second) => {
    detach();
    const next = normalizeArgs(first, second);
    saveContext(next);
    const markup = renderIntoHost();
    bind();
    return markup;
  };

  const update = (first = {}, second) => {
    detach();
    const next = normalizeArgs(first, second);
    saveContext(next);
    const markup = renderIntoHost();
    bind();
    return markup;
  };

  const destroy = (element) => {
    const requestedHost = rootFrom(element);
    detach();
    const targets = requestedHost && requestedHost !== host ? [host, requestedHost] : [host];
    for (const target of targets) {
      if (target && typeof target.replaceChildren === "function") target.replaceChildren();
      else if (target && "innerHTML" in target) target.innerHTML = "";
    }
    host = null;
    context = { payload: {}, previousPayload: null, state: {}, actions: {} };
  };

  return Object.freeze({ mount, update, destroy });
}
