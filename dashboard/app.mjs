import { display, firstDefined, formatDateTime, fmt, objectOrEmpty } from "./core/format.mjs";
import { downloadText } from "./core/export.mjs";
import { createRenderers } from "./core/renderers.mjs";
import { createDashboardState } from "./core/state.mjs";
import { createViewRegistry } from "./core/views.mjs";
import { createArchitectureView } from "./views/architecture.mjs";
import { createEnvironmentView } from "./views/environment.mjs";
import { createInvestigateView } from "./views/investigate.mjs";
import { createThroughputView } from "./views/throughput.mjs";

export const REFRESH_MS = 60 * 1000;
export const dashboardState = createDashboardState();
export const dashboardViews = createViewRegistry(document);

const byId = (id) => document.getElementById(id);
const renderers = createRenderers(document);
const viewFactories = Object.freeze({
  architecture: createArchitectureView,
  throughput: createThroughputView,
  investigate: createInvestigateView,
  environment: createEnvironmentView,
});
const viewMounts = Object.freeze({
  architecture: "architectureViewMount",
  throughput: "throughputViewMount",
  investigate: "investigateViewMount",
  environment: "environmentViewMount",
});
const viewPanels = Object.freeze({
  architecture: "architectureViewPanel",
  throughput: "throughputViewPanel",
  investigate: "investigateViewPanel",
  environment: "environmentViewPanel",
});

let inFlight = null;
let queuedReload = false;
let loadSequence = 0;
let lastCheckedAt = null;
let nextRefreshAt = null;
let currentSessionOptions = [];
let activeView = "overview";
let architectureMetric = "calls";

const VIEW_LABELS = Object.freeze({
  overview: "Overview",
  architecture: "Architecture",
  throughput: "Throughput",
  investigate: "Investigate",
  environment: "Environment",
});

const THEME_STORAGE_KEY = "opencode-telemetry-theme";
const SIDEBAR_STORAGE_KEY = "opencode-telemetry-sidebar-collapsed";
const THEME_COLORS = Object.freeze({ light: "#f5f8fc", dark: "#06101d" });
const COMMANDS = Object.freeze([
  { id: "view-overview", group: "Navigate", label: "Go to Overview", hint: "Summary and current telemetry", keywords: "home summary", action: () => activateView("overview") },
  { id: "view-architecture", group: "Navigate", label: "Go to Architecture", hint: "Trace agents, models, and topology", keywords: "graph", action: () => activateView("architecture") },
  { id: "view-throughput", group: "Navigate", label: "Go to Throughput", hint: "Inspect volume and efficiency", keywords: "rate", action: () => activateView("throughput") },
  { id: "view-investigate", group: "Navigate", label: "Go to Investigate", hint: "Compare telemetry dimensions", keywords: "compare", action: () => activateView("investigate") },
  { id: "view-environment", group: "Navigate", label: "Go to Environment", hint: "Review observed inventory", keywords: "config", action: () => activateView("environment") },
  { id: "range-24h", group: "Time range", label: "Use last 24 hours", hint: "Set reporting range to 24h", keywords: "range today", action: () => load("24h", true) },
  { id: "range-7d", group: "Time range", label: "Use last 7 days", hint: "Set reporting range to 7d", keywords: "range week", action: () => load("7d", true) },
  { id: "range-30d", group: "Time range", label: "Use last 30 days", hint: "Set reporting range to 30d", keywords: "range month", action: () => load("30d", true) },
  { id: "range-all", group: "Time range", label: "Use all available data", hint: "Set reporting range to all", keywords: "range history", action: () => load("all", true) },
  { id: "refresh", group: "Actions", label: "Refresh metrics", hint: "Request current and previous periods", keywords: "reload update", action: () => load(dashboardState.snapshot.range, true) },
  { id: "theme-system", group: "Appearance", label: "Use system theme", hint: "Follow the operating system", keywords: "theme automatic", action: () => persistTheme("system") },
  { id: "theme-light", group: "Appearance", label: "Use light theme", hint: "Bright navy-accented surfaces", keywords: "theme day", action: () => persistTheme("light") },
  { id: "theme-dark", group: "Appearance", label: "Use dark theme", hint: "Deep navy surfaces", keywords: "theme night", action: () => persistTheme("dark") },
]);

let lastDrawerTrigger = null;
let lastCommandTrigger = null;
let commandSelection = 0;
let commandMatches = [...COMMANDS];

function localStorageSafe() {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function systemPrefersDark() {
  try { return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches === true; } catch { return false; }
}

function updateThemeColor(mode = document.documentElement?.getAttribute?.("data-theme") || "system") {
  const actual = mode === "dark" || (mode === "system" && systemPrefersDark()) ? "dark" : "light";
  try { document.querySelector?.('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[actual]); } catch { /* optional DOM */ }
}

function setTheme(mode) {
  const next = ["light", "dark", "system"].includes(mode) ? mode : "system";
  const root = document.documentElement;
  if (root?.setAttribute) root.setAttribute("data-theme", next);
  const control = byId("themeMode");
  if (control) control.value = next;
  try { root?.style?.setProperty("color-scheme", next === "system" ? "light dark" : next); } catch { /* fake DOM */ }
  updateThemeColor(next);
  return next;
}

function persistTheme(mode) {
  const next = setTheme(mode);
  try { localStorageSafe()?.setItem(THEME_STORAGE_KEY, next); } catch { /* storage is optional */ }
  return next;
}

function setupThemeControl() {
  const storage = localStorageSafe();
  let mode = "system";
  try {
    const stored = storage?.getItem(THEME_STORAGE_KEY);
    if (["light", "dark", "system"].includes(stored)) mode = stored;
  } catch { /* storage is optional */ }
  setTheme(mode);
  const control = byId("themeMode");
  if (control?.addEventListener) {
    control.addEventListener("change", () => {
      persistTheme(control.value);
    });
  }
  try {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const update = () => { if (document.documentElement?.getAttribute?.("data-theme") === "system") updateThemeColor("system"); };
    media?.addEventListener?.("change", update);
    media?.addListener?.(update);
  } catch { /* optional browser API */ }
}

function setDrawerState(open) {
  const isOpen = open === true;
  document.body?.classList?.toggle("drawer-open", isOpen);
  const sidebar = byId("appSidebar");
  const toggle = byId("mobileMenuToggle");
  const backdrop = byId("mobileDrawerBackdrop");
  sidebar?.setAttribute?.("data-drawer-state", isOpen ? "open" : "closed");
  backdrop?.setAttribute?.("data-drawer-state", isOpen ? "open" : "closed");
  toggle?.setAttribute?.("aria-expanded", isOpen ? "true" : "false");
  if (backdrop) backdrop.hidden = !isOpen;
  const mobile = (() => { try { return window.matchMedia?.("(max-width: 760px)")?.matches === true; } catch { return false; } })();
  if (mobile) {
    sidebar?.setAttribute?.("aria-hidden", isOpen ? "false" : "true");
    if (sidebar) sidebar.inert = !isOpen;
  }
  if (isOpen) {
    const close = byId("mobileDrawerClose");
    try { (close || sidebar?.querySelector?.("button, a"))?.focus?.(); } catch { /* optional focus */ }
  } else if (lastDrawerTrigger && lastDrawerTrigger !== sidebar) {
    try { lastDrawerTrigger.focus?.(); } catch { /* optional focus */ }
    lastDrawerTrigger = null;
  }
}

function setSidebarState(collapsed) {
  const isCollapsed = collapsed === true;
  document.body?.classList?.toggle("sidebar-collapsed", isCollapsed);
  const toggle = byId("sidebarToggle");
  toggle?.setAttribute?.("aria-expanded", isCollapsed ? "false" : "true");
  toggle?.setAttribute?.("aria-label", isCollapsed ? "Expand navigation" : "Collapse navigation");
  toggle?.setAttribute?.("title", isCollapsed ? "Expand navigation" : "Collapse navigation");
}

function setupShellControls() {
  setupThemeControl();
  const storage = localStorageSafe();
  let collapsed = false;
  try { collapsed = storage?.getItem(SIDEBAR_STORAGE_KEY) === "true"; } catch { /* storage is optional */ }
  setSidebarState(collapsed);
  byId("sidebarToggle")?.addEventListener?.("click", () => {
    const next = !document.body?.classList?.contains?.("sidebar-collapsed");
    setSidebarState(next);
    try { storage?.setItem(SIDEBAR_STORAGE_KEY, String(next)); } catch { /* storage is optional */ }
  });
  byId("mobileMenuToggle")?.addEventListener?.("click", (event) => {
    lastDrawerTrigger = event?.currentTarget || byId("mobileMenuToggle");
    setDrawerState(true);
  });
  byId("mobileDrawerClose")?.addEventListener?.("click", () => setDrawerState(false));
  byId("mobileDrawerBackdrop")?.addEventListener?.("click", () => setDrawerState(false));
  document.addEventListener?.("keydown", (event) => {
    if (event.key === "Escape") {
      if (isCommandPaletteOpen()) closeCommandPalette();
      else setDrawerState(false);
      return;
    }
    if (event.key === "Tab" && document.body?.classList?.contains?.("drawer-open")) {
      const focusable = [...(byId("appSidebar")?.querySelectorAll?.("button, a, select, input, [tabindex]:not([tabindex=\"-1\"])") || [])]
        .filter((element) => !element.disabled && !element.hidden);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault?.(); last.focus?.(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault?.(); first.focus?.(); }
    }
  });
}

function isCommandPaletteOpen() {
  const dialog = byId("commandPalette");
  return dialog?.open === true || document.body?.classList?.contains?.("command-open") === true;
}

function commandFocusable() {
  const dialog = byId("commandPalette");
  return [byId("commandPaletteInput"), ...(dialog?.querySelectorAll?.("button, input, [tabindex]:not([tabindex=\"-1\"])") || [])]
    .filter((element, index, list) => element && !element.disabled && !element.hidden && list.indexOf(element) === index);
}

function renderCommandList(query = "") {
  const list = byId("commandPaletteList");
  if (!list) return;
  const needle = String(query).trim().toLowerCase();
  commandMatches = COMMANDS.filter((command) => !needle || `${command.label} ${command.hint} ${command.keywords}`.toLowerCase().includes(needle));
  commandSelection = Math.min(commandSelection, Math.max(0, commandMatches.length - 1));
  if (!commandMatches.length) {
    list.innerHTML = '<div class="command-empty">No commands match that search.</div>';
    byId("commandPaletteStatus")?.replaceChildren?.();
    if (byId("commandPaletteStatus")) byId("commandPaletteStatus").textContent = "No commands match that search.";
    return;
  }
  let previousGroup = "";
  list.innerHTML = commandMatches.map((command, index) => {
    const group = command.group !== previousGroup ? `<div class="command-group-label" role="presentation">${command.group}</div>` : "";
    previousGroup = command.group;
    return `${group}<button class="command-item" type="button" role="option" data-command-id="${command.id}" aria-selected="${index === commandSelection}"><span class="command-item-copy"><strong>${command.label}</strong><small>${command.hint}</small></span>${command.id.startsWith("theme-") ? `<span class="badge">${command.id.slice(6)}</span>` : ""}</button>`;
  }).join("");
  const status = byId("commandPaletteStatus");
  if (status) status.textContent = `${commandMatches.length} command${commandMatches.length === 1 ? "" : "s"} available.`;
}

function setCommandSelection(index) {
  if (!commandMatches.length) return;
  commandSelection = (index + commandMatches.length) % commandMatches.length;
  byId("commandPaletteList")?.querySelectorAll?.("[data-command-id]")?.forEach?.((item, itemIndex) => {
    item.setAttribute("aria-selected", itemIndex === commandSelection ? "true" : "false");
  });
  byId("commandPaletteList")?.querySelectorAll?.("[data-command-id]")?.[commandSelection]?.scrollIntoView?.({ block: "nearest" });
}

export function openCommandPalette(trigger = byId("commandPaletteToggle")) {
  const dialog = byId("commandPalette");
  if (!dialog) return;
  lastCommandTrigger = trigger || document.activeElement;
  commandSelection = 0;
  renderCommandList(byId("commandPaletteInput")?.value || "");
  document.body?.classList?.add?.("command-open");
  try {
    if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
    else { dialog.open = true; dialog.setAttribute?.("open", ""); }
  } catch { dialog.open = true; }
  byId("commandPaletteInput")?.focus?.();
}

export function closeCommandPalette() {
  const dialog = byId("commandPalette");
  document.body?.classList?.remove?.("command-open");
  try { if (typeof dialog?.close === "function" && dialog.open) dialog.close(); } catch { /* optional DOM */ }
  if (dialog && typeof dialog.close !== "function") { dialog.open = false; dialog.removeAttribute?.("open"); }
  const trigger = lastCommandTrigger;
  lastCommandTrigger = null;
  try { trigger?.focus?.(); } catch { /* optional focus */ }
}

function runCommand(id) {
  const command = COMMANDS.find((entry) => entry.id === id);
  if (!command) return;
  closeCommandPalette();
  command.action();
}

function setupCommandPalette() {
  byId("commandPaletteToggle")?.addEventListener?.("click", (event) => openCommandPalette(event.currentTarget));
  byId("commandPaletteClose")?.addEventListener?.("click", closeCommandPalette);
  byId("commandPaletteInput")?.addEventListener?.("input", (event) => {
    commandSelection = 0;
    renderCommandList(event.target?.value || "");
  });
  byId("commandPaletteInput")?.addEventListener?.("keydown", (event) => {
    if (event.key === "ArrowDown") { event.preventDefault?.(); setCommandSelection(commandSelection + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault?.(); setCommandSelection(commandSelection - 1); }
    else if (event.key === "Enter" && commandMatches[commandSelection]) { event.preventDefault?.(); runCommand(commandMatches[commandSelection].id); }
    else if (event.key === "Escape") { event.preventDefault?.(); closeCommandPalette(); }
    else if (event.key === "Tab") {
      const focusable = commandFocusable();
      if (focusable.length && event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault?.(); focusable.at(-1)?.focus?.(); }
      else if (focusable.length && !event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault?.(); focusable[0]?.focus?.(); }
    }
  });
  byId("commandPalette")?.addEventListener?.("keydown", (event) => {
    if (event.key !== "Tab" || event.target === byId("commandPaletteInput")) return;
    const focusable = commandFocusable();
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault?.(); last.focus?.(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault?.(); first.focus?.(); }
  });
  document.addEventListener?.("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault?.();
      if (isCommandPaletteOpen()) closeCommandPalette(); else openCommandPalette(document.activeElement);
    }
  });
  document.addEventListener?.("click", (event) => {
    const command = event.target?.closest?.("[data-command-id]");
    if (command) runCommand(command.dataset.commandId);
  });
}

const rangeLabel = (payload) => {
  const range = objectOrEmpty(objectOrEmpty(payload).range);
  return display(firstDefined(range.label, range.value, objectOrEmpty(payload).range));
};

const scopeCount = (payload) => {
  const record = objectOrEmpty(payload);
  return firstDefined(record.scopeCount, objectOrEmpty(record.scope).count, objectOrEmpty(record.scope).total, objectOrEmpty(record.summary).scopeCount);
};

const finiteNumber = (value) => {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/** Build the same-origin metrics query for either the current or prior period. */
export function buildMetricsQuery({ range = "24h", sessionScope = "", titleOptIn = false, environmentOptIn = false, bounds = null } = {}) {
  const params = new URLSearchParams();
  const from = finiteNumber(bounds?.from);
  const to = finiteNumber(bounds?.to);
  if (from !== null && to !== null) {
    params.set("from", String(from));
    params.set("to", String(to));
  } else {
    params.set("range", range);
  }
  if (sessionScope) params.set("session", sessionScope);
  if (titleOptIn === true) params.set("includeSessionTitles", "1");
  if (environmentOptIn === true) params.set("includeEnvironment", "1");
  return params;
}

/** Return the equal-length period immediately preceding a finite current range. */
export function previousPeriodBounds(payload) {
  const range = objectOrEmpty(objectOrEmpty(payload).range);
  const from = finiteNumber(range.from);
  const to = finiteNumber(range.to);
  if (from === null || to === null || to <= from) return null;
  const duration = to - from;
  return { from: from - duration, to: from };
}

function renderStatus(payload = {}, error = "", previousPayload = null, previousError = "") {
  const prefix = error ? `Error: ${display(error)}` : `${rangeLabel(payload)} · generatedAt ${formatDateTime(payload.generatedAt)}`;
  const comparison = error
    ? "previous period unavailable"
    : previousPayload ? "previous period ready" : `previous period unavailable${previousError ? ` (${display(previousError)})` : ""}`;
  byId("status").textContent = `${prefix} · ${comparison} · last checked ${formatDateTime(lastCheckedAt)} · scope count ${fmt(scopeCount(payload))}`;
  byId("status").className = error ? "status error" : "status";
}

function renderFeatureState(kind, detail = "") {
  const status = byId("featureStatus");
  if (!status) return;
  status.className = `view-status ${kind}`;
  status.setAttribute("aria-busy", kind === "loading" ? "true" : "false");
  const message = kind === "loading"
    ? "Loading current metrics and the equal-length previous period…"
    : kind === "error"
      ? `Metrics unavailable: ${detail || "Database unavailable"}`
      : detail || "Metrics loaded. Views show unavailable evidence explicitly when a metric is not reported.";
  const messageTarget = byId("featureStatusMessage");
  if (messageTarget) messageTarget.textContent = message;
  else status.textContent = message;
  const retry = byId("retryLoad");
  if (retry) retry.hidden = kind !== "error";
}

function clearData() {
  ["cards", "groups", "toolUsage", "reviewers", "schema", "pricing", "topology"].forEach((id) => {
    byId(id).innerHTML = "";
  });
  // Clear both slots so an error cannot make the last successful payload look
  // like a valid comparison period in an active view.
  dashboardState.clearPayload();
  dashboardState.clearPayload();
}

function featureContext() {
  const snapshot = dashboardState.snapshot;
  return {
    payload: snapshot.currentPayload ?? {},
    previousPayload: snapshot.previousPayload ?? null,
    state: { ...snapshot, architectureMetric },
    actions: viewActions,
  };
}

function updateActiveView() {
  if (activeView !== "overview") dashboardViews.update(activeView, featureContext());
}

function hasCurrentPayload() {
  const payload = dashboardState.snapshot.currentPayload;
  return payload !== null && typeof payload === "object" && !Array.isArray(payload) && Object.keys(payload).length > 0;
}

const viewActions = {
  setArchitectureMetric(metric) {
    architectureMetric = String(metric || "calls");
  },
  setEnvironmentOptIn(enabled) {
    dashboardState.setEnvironmentOptIn(enabled);
    // Hide configured data immediately when the local opt-in is withdrawn;
    // the follow-up request may still be waiting behind an in-flight request.
    updateActiveView();
    load(dashboardState.snapshot.range, true);
  },
  saveBaseline(payload) {
    if (!hasCurrentPayload() || !payload || typeof payload !== "object" || Array.isArray(payload) || !Object.keys(payload).length) return;
    dashboardState.saveRedactedBaseline(payload);
    updateActiveView();
  },
  download(descriptor) {
    if (hasCurrentPayload()) downloadText(descriptor);
  },
};

function setNavigationState(name) {
  document.querySelectorAll("[data-view]").forEach((button) => {
    const selected = button.dataset.view === name;
    button.classList.toggle("active", selected);
    if (selected) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  Object.entries(viewPanels).forEach(([view, id]) => {
    const panel = byId(id);
    if (panel) panel.hidden = view !== name;
  });
  const context = byId("currentViewContext");
  if (context) context.textContent = VIEW_LABELS[name] || VIEW_LABELS.overview;
  document.documentElement?.setAttribute?.("data-active-view", name);
  setDrawerState(false);
}

function setRangeState(range) {
  document.querySelectorAll("[data-range]").forEach((button) => {
    const selected = button.dataset.range === range;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  });
}

export function activateView(name) {
  const next = name === "overview" || viewFactories[name] ? name : "overview";
  if (activeView !== "overview" && activeView !== next) dashboardViews.destroy(activeView);
  activeView = next;
  setNavigationState(next);
  if (next !== "overview") {
    const mountPoint = byId(viewMounts[next]);
    if (mountPoint && !dashboardViews.update(next, featureContext())) {
      dashboardViews.mount(next, viewFactories[next](), mountPoint, featureContext());
    }
  }
  return activeView;
}

function updateRefreshCountdown() {
  const countdown = byId("refreshCountdown");
  if (document.hidden) {
    countdown.textContent = "Auto-refresh paused while hidden";
    return;
  }
  if (inFlight) {
    countdown.textContent = "Refreshing…";
    return;
  }
  if (!lastCheckedAt || !nextRefreshAt) {
    countdown.textContent = "Refresh in 60s";
    return;
  }
  const remaining = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
  countdown.textContent = `Refresh in ${remaining}s`;
  if (remaining <= 0) load(dashboardState.snapshot.range, true);
}

async function fetchMetrics(params, signal) {
  const response = await fetch(`/api/metrics?${params.toString()}`, { cache: "no-store", signal });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(response.ok ? "Invalid metrics response" : "Database unavailable");
  }
  if (!response.ok) throw new Error(display(payload?.error) === "—" ? "Database unavailable" : display(payload?.error));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid metrics response");
  return payload;
}

function commitPayloads(payload, previousPayload) {
  // The state API advances current -> previous. Reset both slots first, then
  // advance through the prior response so it cannot retain an older request.
  dashboardState.clearPayload();
  if (previousPayload !== null && previousPayload !== undefined) dashboardState.setPayload(previousPayload);
  dashboardState.setPayload(payload);
}

export function load(range = dashboardState.snapshot.range, queueIfBusy = false) {
  const selectedRange = dashboardState.setRange(range);
  setRangeState(selectedRange);
  if (inFlight) {
    if (queueIfBusy) {
      queuedReload = true;
      renderFeatureState("loading");
    }
    return inFlight.promise;
  }

  const requested = dashboardState.snapshot;
  const requestKey = JSON.stringify([
    requested.range,
    requested.sessionScope,
    requested.titleOptIn,
    requested.environmentOptIn,
  ]);
  const sequence = ++loadSequence;
  const isCurrentRequest = () => sequence === loadSequence && JSON.stringify([
    dashboardState.snapshot.range,
    dashboardState.snapshot.sessionScope,
    dashboardState.snapshot.titleOptIn,
    dashboardState.snapshot.environmentOptIn,
  ]) === requestKey;
  const controller = new AbortController();
  byId("refresh").disabled = true;
  byId("status").textContent = `Loading… · last checked ${formatDateTime(lastCheckedAt)} · scope count —`;
  byId("status").className = "status";
  renderers.renderLoadingState();
  renderFeatureState("loading");

  const promise = (async () => {
    let payload = {};
    let previousPayload = null;
    let failure = null;
    let previousFailure = "";
    try {
      const currentQuery = buildMetricsQuery({
        range: requested.range,
        sessionScope: requested.sessionScope,
        titleOptIn: requested.titleOptIn,
        environmentOptIn: requested.environmentOptIn,
      });
      payload = await fetchMetrics(currentQuery, controller.signal);
      if (!isCurrentRequest()) return payload;
      const bounds = previousPeriodBounds(payload);
      if (bounds) {
        try {
          const previousQuery = buildMetricsQuery({
            sessionScope: requested.sessionScope,
            titleOptIn: requested.titleOptIn,
            environmentOptIn: requested.environmentOptIn,
            bounds,
          });
          previousPayload = await fetchMetrics(previousQuery, controller.signal);
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          previousFailure = error?.message || "previous request failed";
        }
      }
      if (!isCurrentRequest()) return payload;
      currentSessionOptions = Array.isArray(payload.sessionOptions) ? payload.sessionOptions : [];
      renderers.renderSessionOptions(currentSessionOptions, requested.sessionScope);
      renderers.renderTopology(currentSessionOptions, requested.sessionScope);
      renderers.clearTableModels();
      renderers.renderCards(payload.summary);
      renderers.renderGroups(payload.groups);
      renderers.renderToolUsage(payload.toolUsage);
      renderers.renderReviewers(payload.reviewerSummary);
      renderers.renderSchema(payload.schema);
      const pricing = payload.pricing ?? payload.pricingMetadata ?? (payload.pricingComponents ? { components: payload.pricingComponents } : {});
      renderers.renderPricing(pricing, payload.toolUsage);
      commitPayloads(payload, previousPayload);
      updateActiveView();
      renderFeatureState("ready", previousPayload
        ? "Current and equal-length previous-period metrics loaded."
        : previousFailure ? `Current metrics loaded; previous period unavailable (${previousFailure}).` : "Current metrics loaded; previous period is unavailable for this range.");
    } catch (error) {
      if (error?.name === "AbortError" || !isCurrentRequest()) return payload;
      failure = error?.message || "Unable to load metrics.";
      clearData();
      renderers.renderUnavailableState(failure);
      updateActiveView();
      renderFeatureState("error", failure);
    }
    lastCheckedAt = Date.now();
    nextRefreshAt = lastCheckedAt + REFRESH_MS;
    renderStatus(payload, failure, previousPayload, previousFailure);
    return payload;
  })();

  inFlight = { promise, controller, sequence };
  promise.then(() => {
    if (inFlight?.sequence !== sequence) return;
    inFlight = null;
    byId("refresh").disabled = false;
    updateRefreshCountdown();
    if (queuedReload && !document.hidden) {
      queuedReload = false;
      load(dashboardState.snapshot.range, true);
    }
  }, () => {
    if (inFlight?.sequence !== sequence) return;
    inFlight = null;
    byId("refresh").disabled = false;
    updateRefreshCountdown();
  });
  return promise;
}

document.addEventListener("click", (event) => {
  const target = event.target;
  const sortButton = target?.closest?.("button[data-sort-table]");
  if (sortButton) renderers.toggleSort(sortButton.dataset.sortTable, sortButton.dataset.sortColumn);
  const viewButton = target?.closest?.("button[data-view]");
  if (viewButton) activateView(viewButton.dataset.view);
});

setupShellControls();
setupCommandPalette();

document.querySelectorAll("[data-range]").forEach((button) => {
  button.addEventListener("click", () => {
    load(button.dataset.range, true);
  });
});

byId("session").addEventListener("change", () => {
  dashboardState.setSessionScope(byId("session").value || "");
  renderers.renderSessionOptions(currentSessionOptions, dashboardState.snapshot.sessionScope);
  renderers.renderTopology(currentSessionOptions, dashboardState.snapshot.sessionScope);
  load(dashboardState.snapshot.range, true);
});

byId("showSessionTitles").addEventListener("change", () => {
  dashboardState.setTitleOptIn(byId("showSessionTitles").checked);
  if (!dashboardState.snapshot.titleOptIn) {
    renderers.renderSessionOptions(currentSessionOptions, dashboardState.snapshot.sessionScope);
    renderers.renderTopology(currentSessionOptions, dashboardState.snapshot.sessionScope);
  }
  load(dashboardState.snapshot.range, true);
});

byId("topology").addEventListener("click", (event) => {
  const node = event.target?.closest?.("button[data-session]");
  if (!node) return;
  dashboardState.setSessionScope(node.dataset.session);
  renderers.renderSessionOptions(currentSessionOptions, dashboardState.snapshot.sessionScope);
  renderers.renderTopology(currentSessionOptions, dashboardState.snapshot.sessionScope);
  load(dashboardState.snapshot.range, true);
});

byId("refresh").addEventListener("click", () => load(dashboardState.snapshot.range, true));
byId("retryLoad")?.addEventListener?.("click", () => load(dashboardState.snapshot.range, true));
document.addEventListener("visibilitychange", () => {
  updateRefreshCountdown();
  if (!document.hidden && (queuedReload || !lastCheckedAt || Date.now() - lastCheckedAt >= REFRESH_MS)) load(dashboardState.snapshot.range, true);
});
window.setInterval(updateRefreshCountdown, 1000);
activateView("overview");
load(dashboardState.snapshot.range);
