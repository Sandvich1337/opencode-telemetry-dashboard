import {
  cacheWriteText,
  display,
  duration,
  estimatedUsdValue,
  escapeHtml,
  fieldText,
  firstDefined,
  fmt,
  formatDateTime,
  hasValue,
  moneyValue,
  numeric,
  objectOrEmpty,
  percent,
  scalarValue,
  tokenValues,
} from "./format.mjs";
import { createTableRenderer } from "./tables.mjs";

function sessionTimestamp(value) {
  const numericValue = numeric(value);
  if (numericValue !== null) return numericValue;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function recentEntryCompare(left, right) {
  const leftTimestamp = sessionTimestamp(left.timestamp);
  const rightTimestamp = sessionTimestamp(right.timestamp);
  if (leftTimestamp !== null && rightTimestamp !== null && leftTimestamp !== rightTimestamp) return rightTimestamp - leftTimestamp;
  if (leftTimestamp !== null && rightTimestamp === null) return -1;
  if (leftTimestamp === null && rightTimestamp !== null) return 1;
  return left.value.localeCompare(right.value);
}

export function createRenderers(root = document) {
  const byId = (id) => root.getElementById(id);
  const tables = createTableRenderer();
  const numericColumn = tables.numericColumn;

  const filesSortValue = (row) => {
    const files = objectOrEmpty(row.files);
    const additions = numeric(files.additions);
    const deletions = numeric(files.deletions);
    return additions === null && deletions === null ? null : [additions, deletions];
  };
  const filesDisplay = (value) => `${fmt(value?.[0])} / ${fmt(value?.[1])}`;
  const groupColumns = [
    { key: "agent", label: "Agent", value: (row) => tables.textSortValue(row.agent) },
    { key: "model", label: "Model", value: (row) => tables.textSortValue(row.model) },
    numericColumn("runs", "Runs", (row) => row.runs),
    numericColumn("subagents", "Subagents", (row) => row.subagents),
    numericColumn("input", "Input", (row) => tokenValues(row).input),
    numericColumn("output", "Output", (row) => tokenValues(row).output),
    numericColumn("reasoning", "Reasoning", (row) => tokenValues(row).reasoning),
    numericColumn("cacheRead", "Cache R", (row) => tokenValues(row).cacheRead),
    { key: "cacheWrite", label: "Cache W", className: "num", value: (row) => numeric(tokenValues(row).cacheWrite), format: (value, row) => cacheWriteText(row, tokenValues(row)) },
    numericColumn("total", "Total", (row) => tokenValues(row).total),
    numericColumn("estimatedUsd", "Estimated API $", (row) => estimatedUsdValue(row), moneyValue),
    numericColumn("tools", "Tools", (row) => row.tools),
    numericColumn("reads", "Reads", (row) => row.reads),
    numericColumn("errors", "Errors", (row) => row.errors),
    numericColumn("durationMs", "Duration", (row) => row.durationMs, duration),
    { key: "files", label: "Files + / -", className: "num", value: filesSortValue, format: filesDisplay },
  ];
  const toolColumns = [
    { key: "tool", label: "Tool", value: (row) => tables.textSortValue(firstDefined(row.tool, row.name, row.toolName)) },
    numericColumn("calls", "Calls", (row) => firstDefined(row.calls, row.count)),
    numericColumn("errors", "Errors", (row) => row.errors),
    numericColumn("input", "Input", (row) => tokenValues(row).input),
    numericColumn("output", "Output", (row) => tokenValues(row).output),
    numericColumn("reasoning", "Reasoning", (row) => tokenValues(row).reasoning),
    numericColumn("cacheRead", "Cache R", (row) => tokenValues(row).cacheRead),
    { key: "cacheWrite", label: "Cache W", className: "num", value: (row) => numeric(tokenValues(row).cacheWrite), format: (value, row) => cacheWriteText(row, tokenValues(row)) },
    numericColumn("total", "Total", (row) => tokenValues(row).total),
    numericColumn("estimatedUsd", "Estimated USD", (row) => estimatedUsdValue(row), moneyValue),
  ];
  const pricingColumns = [
    { key: "component", label: "Cost component", value: (row) => row.name },
    numericColumn("amount", "Estimated API $", (row) => row.amount, moneyValue),
  ];

  const recordHasData = (record) => Object.values(objectOrEmpty(record)).some((value) => {
    if (value === null || value === undefined || value === "") return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
  });

  const stateMarkup = (title, detail) => `<div class="overview-state-card card"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(detail)}</p></div>`;

  function renderLoadingState() {
    byId("cards").innerHTML = Array.from({ length: 8 }, () =>
      '<div class="card skeleton-card"><div class="skeleton skeleton-line short"></div><div class="skeleton skeleton-line"></div></div>').join("");
    ["groups", "toolUsage", "reviewers", "schema", "pricing", "topology"].forEach((id) => {
      byId(id).innerHTML = '<div class="empty"><span class="skeleton skeleton-line" aria-hidden="true"></span></div>';
    });
  }

  function renderUnavailableState(detail = "Metrics are unavailable for this range.") {
    byId("cards").innerHTML = stateMarkup("Metrics unavailable", detail);
    ["groups", "toolUsage", "reviewers", "schema", "pricing", "topology"].forEach((id) => {
      byId(id).innerHTML = `<div class="empty-state"><strong>Unavailable</strong><span>${escapeHtml(detail)}</span></div>`;
    });
  }

  function renderCards(summary) {
    const record = objectOrEmpty(summary);
    if (!recordHasData(record)) {
      byId("cards").innerHTML = stateMarkup("No metrics in this range", "The local store reported an empty aggregate for the current filters.");
      return;
    }
    const tokens = tokenValues(record);
    const files = objectOrEmpty(record.files);
    const cards = [
      ["Runs", fmt(record.runs)], ["Subagents", fmt(record.subagents)],
      ["Input tokens", fmt(tokens.input)], ["Output tokens", fmt(tokens.output)],
      ["Reasoning", fmt(tokens.reasoning)],
      ["Cache R / W", `${fmt(tokens.cacheRead)} / ${cacheWriteText(record, tokens)}`],
      ["Total tokens", fmt(tokens.total)], ["Estimated API $", moneyValue(estimatedUsdValue(record))],
      ["Tools", fmt(record.tools)], ["Reads", fmt(record.reads)],
      ["Errors", fmt(record.errors)], ["Duration", duration(record.durationMs)],
      ["Files + / -", `${fmt(files.additions)} / ${fmt(files.deletions)}`],
    ];
    byId("cards").innerHTML = cards.map(([label, value]) =>
      `<div class="card"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`).join("");
  }

  function renderGroups(groups) {
    const rowsForGroups = Array.isArray(groups) ? groups : [];
    byId("groups").innerHTML = tables.renderDataTable("groups", rowsForGroups, groupColumns, "No aggregate rows for this range.");
  }

  const toolTokenKeys = ["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"];
  const toolTotalsFromRows = (rows) => rows.reduce((totals, entry) => {
    const row = objectOrEmpty(entry);
    for (const key of toolTokenKeys) totals[key] += numeric(row[key]) ?? numeric(tokenValues(row)[key]) ?? 0;
    totals.calls += numeric(firstDefined(row.calls, row.count)) ?? 0;
    totals.errors += numeric(row.errors) ?? 0;
    return totals;
  }, { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, calls: 0, errors: 0 });
  const toolTotals = (record, rows) => {
    const source = objectOrEmpty(record);
    const fallback = toolTotalsFromRows(rows);
    const tokens = tokenValues(source);
    return {
      input: numeric(tokens.input) ?? fallback.input,
      output: numeric(tokens.output) ?? fallback.output,
      reasoning: numeric(tokens.reasoning) ?? fallback.reasoning,
      cacheRead: numeric(tokens.cacheRead) ?? fallback.cacheRead,
      cacheWrite: numeric(tokens.cacheWrite) ?? fallback.cacheWrite,
      total: numeric(tokens.total) ?? fallback.total,
      calls: numeric(firstDefined(source.calls, source.count)) ?? fallback.calls,
      errors: numeric(source.errors) ?? fallback.errors,
    };
  };
  const toolTableKey = (block, index) => {
    const identity = [
      scalarValue(block.id, block.key), scalarValue(block.agent, block.name), scalarValue(block.model, block.modelName),
    ].filter((value) => hasValue(value)).join("|");
    return `tool:${identity || index}`;
  };

  function renderToolUsage(toolUsage = {}) {
    const usage = objectOrEmpty(toolUsage);
    const source = Array.isArray(usage.rows) ? usage.rows : [];
    const conservation = objectOrEmpty(usage.conservation);
    const globalTotals = toolTotals(firstDefined(usage.totals, conservation.summary) || {}, source);
    const globalExact = conservation.exact === true || conservation.ok === true;
    const globalCacheWrite = cacheWriteText(usage, globalTotals);
    const blocks = Array.isArray(usage.byAgent) && usage.byAgent.length
      ? usage.byAgent
      : source.length ? [{ agent: "All agents", rows: source }] : [];
    if (!blocks.length) { byId("toolUsage").innerHTML = '<div class="empty">No tool usage data.</div>'; return; }
    const globalDelta = objectOrEmpty(conservation.delta);
    const deltaText = toolTokenKeys.map((key) => `${key}: ${fmt(globalDelta[key])}`).join(" · ");
    const blockKeys = new Map();
    const blockMarkup = blocks.map((sourceBlock, index) => {
      const block = objectOrEmpty(sourceBlock);
      const rows = Array.isArray(block.rows) ? block.rows : [];
      const totals = toolTotals(block.totals, rows);
      const blockConservation = objectOrEmpty(block.conservation);
      const blockExact = blockConservation.exact === true || blockConservation.ok === true;
      const model = scalarValue(block.model, block.modelName);
      const title = [scalarValue(block.agent, block.name) || "Agent", model].filter(Boolean).join(" · ");
      const baseTableKey = toolTableKey(block, index);
      const occurrence = blockKeys.get(baseTableKey) || 0;
      blockKeys.set(baseTableKey, occurrence + 1);
      const tableKey = occurrence ? `${baseTableKey}:${occurrence}` : baseTableKey;
      return `<details class="agent-tools"${blocks.length === 1 ? " open" : ""}>
        <summary><strong>${escapeHtml(title)}</strong><span class="muted">${escapeHtml(fmt(totals.calls))} calls · ${escapeHtml(fmt(totals.errors))} errors · ${escapeHtml(fmt(totals.total))} tokens</span></summary>
        <div class="agent-tool-body">
          <div class="muted">Input ${escapeHtml(fmt(totals.input))} · output ${escapeHtml(fmt(totals.output))} · reasoning ${escapeHtml(fmt(totals.reasoning))} · cache R ${escapeHtml(fmt(totals.cacheRead))} · cache W ${escapeHtml(cacheWriteText(block, totals))}</div>
          ${tables.renderDataTable(tableKey, rows, toolColumns, "No tool usage rows.")}
          <div class="conservation ${blockExact ? "good" : "bad"}"><strong>Agent tool-token conservation:</strong> ${blockExact ? "exact" : "not exact"}</div>
        </div>
      </details>`;
    }).join("");
    byId("toolUsage").innerHTML = `<div class="tool-summary">
      <div><strong>Global totals:</strong> ${escapeHtml(fmt(globalTotals.calls))} calls · ${escapeHtml(fmt(globalTotals.errors))} errors · input ${escapeHtml(fmt(globalTotals.input))} · output ${escapeHtml(fmt(globalTotals.output))} · reasoning ${escapeHtml(fmt(globalTotals.reasoning))} · cache R ${escapeHtml(fmt(globalTotals.cacheRead))} · cache W ${escapeHtml(globalCacheWrite)} · total ${escapeHtml(fmt(globalTotals.total))}</div>
      <div class="conservation ${globalExact ? "good" : "bad"}"><strong>Global tool-token conservation:</strong> ${globalExact ? "exact" : "not exact"}${Object.keys(globalDelta).length ? ` · delta ${escapeHtml(deltaText)}` : ""}</div>
    </div>${blockMarkup}`;
  }

  function renderReviewers(reviewerSummary = {}) {
    const summaryRecord = objectOrEmpty(reviewerSummary);
    const bySlot = summaryRecord.bySlot || {};
    const entries = Array.isArray(bySlot)
      ? bySlot.map((summary, index) => [objectOrEmpty(summary).slot ?? index + 1, summary])
      : Object.entries(objectOrEmpty(bySlot));
    if (!entries.length) { byId("reviewers").innerHTML = '<div class="empty">No reviewer slot data.</div>'; return; }

    entries.sort(([left], [right]) => Number(left) - Number(right));
    const slotTotal = (summary) => numeric(firstDefined(objectOrEmpty(summary).total, objectOrEmpty(summary).count)) ?? 0;
    const slotRate = (summary, verdict) => {
      const record = objectOrEmpty(summary);
      const rates = objectOrEmpty(record.rates || record.percentages);
      const rate = firstDefined(rates[verdict], rates[verdict.toLowerCase()]);
      if (rate !== undefined) return numeric(rate) ?? 0;
      const counts = objectOrEmpty(record.counts || record.verdicts || record);
      const count = numeric(firstDefined(counts[verdict], counts[verdict.toLowerCase()])) ?? 0;
      const total = slotTotal(record);
      return total ? count / total : 0;
    };
    const rows = entries.map(([slot, summary]) => ({ slot, summary }));
    const reviewerColumns = [
      { key: "slot", label: "Slot", value: (row) => numeric(row.slot) ?? row.slot },
      numericColumn("total", "Total", (row) => slotTotal(row.summary)),
      numericColumn("issue", "ISSUE", (row) => slotRate(row.summary, "ISSUE"), percent),
      numericColumn("pass", "PASS", (row) => slotRate(row.summary, "PASS"), percent),
      numericColumn("unknown", "UNKNOWN", (row) => slotRate(row.summary, "UNKNOWN"), percent),
    ];
    const second = objectOrEmpty(summaryRecord.secondAfterFirstPass);
    const secondIssueRate = firstDefined(second.issueRate, objectOrEmpty(second.rates).ISSUE, second.rate);
    const rateLine = `<div class="reviewer-rate-line muted">Second after first PASS ISSUE: ${escapeHtml(percent(secondIssueRate))} (${escapeHtml(fmt(second.eligible))} eligible)</div>`;
    byId("reviewers").innerHTML = `${rateLine}${tables.renderDataTable("reviewers", rows, reviewerColumns, "No reviewer slot data.")}`;
  }

  function renderSchema(schema) {
    const tableNames = ["session", "message", "part"];
    const record = objectOrEmpty(schema);
    const tablesRecord = objectOrEmpty(record.tables);
    byId("schema").innerHTML = `<div class="schema">${tableNames.map((name) =>
      `<span class="${tablesRecord[name]?.usable ? "ok" : ""}">${name}: ${tablesRecord[name]?.usable ? "ready" : "missing"}</span>`).join("")}</div>
      <p>${record.ok ? "All required capabilities are available." : "Required schema capabilities are unavailable; showing an empty aggregate."}</p>`;
  }

  function renderPricing(pricing = {}, toolUsage = {}) {
    const rootRecord = objectOrEmpty(pricing);
    const components = objectOrEmpty(rootRecord.components);
    const coverage = objectOrEmpty(rootRecord.coverage);
    const priced = numeric(coverage.priced) ?? 0;
    const unpriced = numeric(coverage.unpriced) ?? 0;
    const coverageRate = priced + unpriced ? priced / (priced + unpriced) : null;
    const conservation = objectOrEmpty(objectOrEmpty(toolUsage).conservation);
    const conserved = conservation.exact === true || conservation.ok === true;
    const componentRows = [
      ["Input", components.input],
      ["Cached input read", components.cacheRead],
      ["Cache writes", components.cacheWrite],
      ["Output + reasoning", components.output],
    ].map(([name, amount]) => ({ name, amount }));
    byId("pricing").innerHTML = `<div class="pricing-note">
      <div><strong>Estimated API-equivalent total:</strong> ${escapeHtml(moneyValue(rootRecord.estimatedUSD))}</div>
      <div class="muted">Current public OpenAI API rates as of ${escapeHtml(display(rootRecord.date))}; not billed cost. Formula: uncached input + cached reads + cache writes + (output + reasoning). Requests above ${escapeHtml(fmt(rootRecord.longContextThreshold))} prompt tokens use long-context rates.</div>
      <div class="muted">Tool tokens are attributed evenly per tool call within each model step. This is an allocation estimate, not causal per-tool metering; no-tool usage remains explicit as Unattributed.</div>
      <div>Pricing coverage: ${escapeHtml(coverageRate === null ? "—" : percent(coverageRate))} (${escapeHtml(fmt(priced))} priced · ${escapeHtml(fmt(unpriced))} unpriced) · ${escapeHtml(display(rootRecord.currency))} ${escapeHtml(display(rootRecord.unit))}</div>
      <div>Source: ${escapeHtml(display(rootRecord.source))}</div>
      <div class="conservation ${conserved ? "good" : "bad"}"><strong>Tool-token conservation:</strong> ${conserved ? "exact" : "not exact"}</div>
    </div>${tables.renderDataTable("pricing", componentRows, pricingColumns, "No pricing components.")}`;
  }

  function sessionOptionEntries(sessionOptions) {
    if (!Array.isArray(sessionOptions)) return [];
    const showTitles = byId("showSessionTitles").checked;
    const seen = new Set();
    return sessionOptions.map((source) => objectOrEmpty(source)).map((option) => {
      const key = scalarValue(option.alias, option.id, option.sessionId, option.session, option.value, option.key);
      if (!hasValue(key)) return null;
      const value = String(key);
      if (seen.has(value)) return null;
      seen.add(value);
      const timestamp = firstDefined(option.timestamp, option.createdAt, option.updatedAt);
      const title = showTitles ? scalarValue(option.title, option.sessionTitle) : null;
      const parent = objectOrEmpty(option.parent);
      const parentAlias = scalarValue(option.parentAlias, option.parentSessionAlias, option.parentSession, parent.alias, parent.sessionAlias);
      const kind = scalarValue(option.kind, option.type) || (parentAlias ? "child" : "root");
      const aliasLabel = `Session ${value.slice(0, 8)}`;
      const label = [title, aliasLabel, formatDateTime(timestamp), fieldText(kind), fieldText(option.agent), fieldText(option.model)]
        .filter((part) => hasValue(part) && part !== "—").join(" · ") || aliasLabel;
      return { value, label, title, parentAlias, kind, timestamp };
    }).filter(Boolean);
  }

  function latestRootEntries(entries) {
    return entries.filter((entry) => entry.kind === "root").slice().sort(recentEntryCompare);
  }

  function rootSessionValue(value, entries) {
    const byValue = new Map(entries.map((entry) => [entry.value, entry]));
    let current = byValue.get(value);
    if (!current) return "";
    const visited = new Set([current.value]);
    while (current.parentAlias && byValue.has(current.parentAlias) && !visited.has(current.parentAlias)) {
      current = byValue.get(current.parentAlias);
      visited.add(current.value);
    }
    return current.kind === "root" ? current.value : "";
  }

  function renderSessionOptions(sessionOptions, selectedSessionAlias = "") {
    if (!Array.isArray(sessionOptions)) return;
    const select = byId("session");
    const entries = sessionOptionEntries(sessionOptions);
    const selectedRoot = rootSessionValue(selectedSessionAlias, entries);
    const options = latestRootEntries(entries);
    const showTitles = byId("showSessionTitles").checked;
    const optionMarkup = showTitles
      ? [...options.reduce((groups, option) => {
        const group = option.title || "Untitled root sessions";
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(option);
        return groups;
      }, new Map())].map(([group, groupOptions]) => `<optgroup label="${escapeHtml(group)}">${groupOptions.map((option) =>
        `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join("")}</optgroup>`).join("")
      : options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join("");
    select.innerHTML = `<option value="">All sessions</option>${optionMarkup}`;
    select.value = options.some((option) => option.value === selectedRoot) ? selectedRoot : "";
  }

  function renderTopology(sessionOptions, selectedSessionAlias = "") {
    const entries = sessionOptionEntries(sessionOptions);
    if (!entries.length) { byId("topology").innerHTML = ""; return; }
    const byValue = new Map(entries.map((entry) => [entry.value, entry]));
    const children = new Map();
    for (const entry of entries) {
      if (entry.parentAlias && byValue.has(entry.parentAlias) && entry.parentAlias !== entry.value) {
        if (!children.has(entry.parentAlias)) children.set(entry.parentAlias, []);
        children.get(entry.parentAlias).push(entry);
      }
    }
    const renderNode = (entry, level, path = new Set()) => {
      if (path.has(entry.value)) return "";
      const nextPath = new Set(path).add(entry.value);
      const childEntries = (children.get(entry.value) || []).filter((child) => !nextPath.has(child.value));
      const selected = selectedSessionAlias === entry.value;
      return `<li role="treeitem" aria-level="${level}"${childEntries.length ? ' aria-expanded="true"' : ""}>
        <button class="scope-node" type="button" data-session="${escapeHtml(entry.value)}" aria-pressed="${selected}">${escapeHtml(entry.label)}</button>
        ${childEntries.length ? `<ul role="group">${childEntries.map((child) => renderNode(child, level + 1, nextPath)).join("")}</ul>` : ""}
      </li>`;
    };
    const selectedRoot = rootSessionValue(selectedSessionAlias, entries);
    let visibleRoots;
    let description;
    if (selectedRoot && byValue.has(selectedRoot)) {
      visibleRoots = [byValue.get(selectedRoot)];
      description = "Showing the selected session's spawn tree.";
    } else {
      const spawnRoots = latestRootEntries(entries).filter((entry) => (children.get(entry.value) || []).length);
      visibleRoots = spawnRoots;
      description = `Showing ${visibleRoots.length} root session${visibleRoots.length === 1 ? "" : "s"} that spawned subagents.`;
    }
    if (!visibleRoots.length) {
      byId("topology").innerHTML = '<h3>Spawn topology</h3><div class="empty">No parent-child session links in this scope.</div>';
      return;
    }
    const rootMarkup = visibleRoots.map((entry) => renderNode(entry, 1)).join("");
    byId("topology").innerHTML = `<h3>Spawn topology</h3><div class="muted">${escapeHtml(description)} Select a node to scope all metrics.</div><ul class="topology-tree" role="tree" aria-label="Session spawn topology">${rootMarkup}</ul>`;
  }

  return Object.freeze({
    renderLoadingState,
    renderUnavailableState,
    renderCards,
    renderGroups,
    renderToolUsage,
    renderReviewers,
    renderSchema,
    renderPricing,
    renderSessionOptions,
    renderTopology,
    toggleSort(tableKey, column) {
      tables.toggleSort(tableKey, column);
      tables.rerenderDataTable(tableKey, root);
    },
    clearTableModels: tables.clear,
  });
}
