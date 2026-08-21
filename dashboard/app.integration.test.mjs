import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

class FakeElement {
  constructor(id, dataset = {}) {
    this.id = id;
    this.dataset = dataset;
    this.innerHTML = "";
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.checked = false;
    this.open = false;
    this.style = { setProperty() {} };
    this.listeners = new Map();
    const classes = new Set();
    this.classList = {
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : force;
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      },
      contains(name) { return classes.has(name); },
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
    };
  }

  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }
  setAttribute(name, value) { this[name] = String(value); if (name.startsWith("data-")) this.dataset[name.slice(5)] = String(value); }
  getAttribute(name) { return this[name] ?? null; }
  removeAttribute(name) { delete this[name]; }
  contains() { return true; }
  replaceChildren() { this.innerHTML = ""; }
  closest() { return null; }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() {}
  querySelectorAll() { return []; }
  emit(type, target = this, detail = {}) { this.listeners.get(type)?.({ target, currentTarget: this, preventDefault() {}, ...detail }); }
}

function dashboardDocument() {
  const ids = [
    "status", "featureStatus", "featureStatusMessage", "refreshCountdown", "refresh", "session", "showSessionTitles", "currentViewContext",
    "cards", "groups", "toolUsage", "reviewers", "schema", "pricing", "topology",
    "architectureViewPanel", "throughputViewPanel", "investigateViewPanel", "environmentViewPanel",
    "architectureViewMount", "throughputViewMount", "investigateViewMount", "environmentViewMount",
    "appSidebar", "mobileMenuToggle", "mobileDrawerClose", "mobileDrawerBackdrop", "sidebarToggle",
    "themeMode", "commandPaletteToggle", "commandPalette", "commandPaletteClose", "commandPaletteInput",
    "commandPaletteList", "commandPaletteStatus", "retryLoad",
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  const ranges = ["24h", "7d", "30d", "all"].map((range) => new FakeElement(`range-${range}`, { range }));
  const views = ["overview", "architecture", "throughput", "investigate", "environment"]
    .map((view) => new FakeElement(`view-${view}`, { view }));
  const documentRef = {
    hidden: false,
    activeElement: null,
    body: new FakeElement("body"),
    documentElement: new FakeElement("documentElement"),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement(id));
      const element = elements.get(id);
      element.ownerDocument = documentRef;
      return element;
    },
    querySelectorAll(selector) {
      if (selector === "[data-range]") return ranges;
      if (selector === "[data-view]") return views;
      return [];
    },
    querySelector(selector) { return selector.includes("theme-color") ? new FakeElement("theme-color") : null; },
    listeners: new Map(),
    addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); },
    emit(type, detail = {}) { for (const listener of this.listeners.get(type) || []) listener({ target: this, preventDefault() {}, ...detail }); },
    elements,
    ranges,
    views,
  };
  for (const element of elements.values()) element.ownerDocument = documentRef;
  documentRef.activeElement = elements.get("refresh");
  return documentRef;
}

function response(payload) {
  return { ok: true, async json() { return payload; } };
}

function metricsPayload(from, to, marker = "") {
  return {
    range: { from, to, label: "Custom range" },
    generatedAt: "2026-08-19T00:00:00.000Z",
    sessionOptions: [],
    summary: {},
    analytics: {},
    ...(marker ? { marker } : {}),
  };
}

function configuredMetricsPayload(from, to) {
  const payload = metricsPayload(from, to);
  payload.analytics = {
    environment: {
      observed: {
        available: true,
        availability: { available: true, reason: "inventory-present" },
        agents: [], models: [], tools: [], capabilities: [], unknown: [],
      },
      configured: {
        available: true,
        availability: { available: true, reason: "explicit" },
        agents: [{ type: "agent", name: "configured-agent", version: "v1", available: true, capabilities: {}, sample: { count: 1, observed: 1 } }],
        models: [], tools: [], capabilities: [], unknown: [],
      },
    },
  };
  return payload;
}

test("dashboard integration preserves shared privacy filters and requests a prior period", async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const documentRef = dashboardDocument();
  const calls = [];
  const responses = [
    metricsPayload(1_000, 2_000), metricsPayload(0, 1_000),
    metricsPayload(2_000, 3_000), metricsPayload(1_000, 2_000),
    configuredMetricsPayload(3_000, 4_000), configuredMetricsPayload(2_000, 3_000),
  ];
  globalThis.document = documentRef;
  globalThis.window = { setInterval() {} };
  globalThis.fetch = async (url) => {
    calls.push(new URL(url, "http://127.0.0.1"));
    return response(responses.shift() ?? metricsPayload(0, 1));
  };

  try {
    const app = await import(`./app.mjs?integration=${Date.now()}`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(app.dashboardState.snapshot.range, "24h");
    assert.equal(calls[0].searchParams.get("range"), "24h");
    await app.load("7d");

    assert.equal(calls.length, 4);
    const current = calls[2];
    const previous = calls[3];
    assert.equal(current.searchParams.get("range"), "7d");
    app.dashboardState.setSessionScope("session-alias");
    app.dashboardState.setTitleOptIn(true);
    app.dashboardState.setEnvironmentOptIn(true);
    await app.load("7d");
    const filteredCurrent = calls[4];
    const filteredPrevious = calls[5];
    assert.equal(filteredCurrent.searchParams.get("session"), "session-alias");
    assert.equal(filteredCurrent.searchParams.get("includeSessionTitles"), "1");
    assert.equal(filteredCurrent.searchParams.get("includeEnvironment"), "1");
    assert.equal(filteredPrevious.searchParams.get("session"), "session-alias");
    assert.equal(filteredPrevious.searchParams.get("includeSessionTitles"), "1");
    assert.equal(filteredPrevious.searchParams.get("includeEnvironment"), "1");
    assert.equal(current.searchParams.get("session"), null);
    assert.equal(previous.searchParams.get("from"), "1000");
    assert.equal(previous.searchParams.get("to"), "2000");
    assert.equal(previous.searchParams.get("range"), null);

    const query = app.buildMetricsQuery({
      sessionScope: "session-alias",
      titleOptIn: true,
      environmentOptIn: true,
      bounds: { from: 4_000, to: 5_000 },
    });
    assert.equal(query.toString(), "from=4000&to=5000&session=session-alias&includeSessionTitles=1&includeEnvironment=1");
    assert.equal(app.buildMetricsQuery({ range: "7d", bounds: { from: 4_000 } }).toString(), "range=7d");
    assert.deepEqual(app.previousPeriodBounds({ range: { from: 4_000, to: 5_000 } }), { from: 3_000, to: 4_000 });

    app.activateView("architecture");
    assert.notEqual(documentRef.elements.get("architectureViewMount").innerHTML, "");
    app.activateView("environment");
    assert.equal(documentRef.elements.get("architectureViewMount").listeners.size, 0);
    assert.notEqual(documentRef.elements.get("environmentViewMount").innerHTML, "");
    assert.match(documentRef.elements.get("environmentViewMount").innerHTML, /configured-agent/);
    documentRef.elements.get("environmentViewMount").emit("change", { dataset: { environmentOptIn: "true" }, checked: false });
    await app.load("7d");
    assert.doesNotMatch(documentRef.elements.get("environmentViewMount").innerHTML, /configured-agent/);
    assert.equal(documentRef.elements.get("environmentViewMount").innerHTML.includes("No saved baseline yet"), true);
    documentRef.elements.get("environmentViewMount").emit("click", { dataset: { environmentAction: "save-baseline" } });
    assert.ok(app.dashboardState.snapshot.savedRedactedBaseline);
    assert.equal(documentRef.elements.get("environmentViewMount").innerHTML.includes("No saved baseline yet"), false);
    assert.equal(documentRef.ranges.find((element) => element.dataset.range === "7d").getAttribute("aria-pressed"), "true");
    assert.equal(documentRef.views.find((element) => element.dataset.view === "environment").getAttribute("aria-current"), "page");
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});

test("fresh dashboard selects 24h and keeps pricing as the final page section", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /data-range="24h" class="active" aria-pressed="true"/);
  assert.match(html, /data-range="30d" aria-pressed="false"/);
  assert.ok(html.indexOf("id=\"featureViews\"") < html.indexOf("id=\"pricingSection\""));
  assert.ok(html.indexOf("id=\"environmentViewPanel\"") < html.indexOf("id=\"pricingSection\""));
  assert.ok(html.indexOf("id=\"pricingSection\"") < html.indexOf("</main>"));
});

test("command palette filters and activates existing navigation paths", async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const documentRef = dashboardDocument();
  globalThis.document = documentRef;
  globalThis.window = { setInterval() {}, matchMedia() { return { matches: false }; } };
  globalThis.fetch = async (url) => {
    const request = new URL(url, "http://127.0.0.1");
    return response(request.searchParams.has("from") ? metricsPayload(0, 1) : metricsPayload(1, 2));
  };
  try {
    const app = await import(`./app.mjs?commands=${Date.now()}`);
    await new Promise((resolve) => setImmediate(resolve));
    const commandTrigger = documentRef.elements.get("commandPaletteToggle");
    commandTrigger.focus();
    commandTrigger.emit("click");
    assert.equal(documentRef.elements.get("commandPalette").getAttribute("open"), "");
    const input = documentRef.elements.get("commandPaletteInput");
    input.value = "throughput";
    input.emit("input");
    assert.match(documentRef.elements.get("commandPaletteList").innerHTML, /Go to Throughput/);
    input.emit("keydown", input, { key: "Enter" });
    assert.equal(documentRef.elements.get("currentViewContext").textContent, "Throughput");
    assert.equal(documentRef.body.classList.contains("command-open"), false);
    app.openCommandPalette(commandTrigger);
    documentRef.emit("keydown", { key: "Escape" });
    assert.equal(documentRef.body.classList.contains("command-open"), false);
    assert.equal(documentRef.activeElement, commandTrigger);
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});

test("theme persistence, system changes, and mobile drawer retain their contracts", async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const documentRef = dashboardDocument();
  const store = new Map();
  let systemChange;
  globalThis.document = documentRef;
  globalThis.window = {
    setInterval() {},
    localStorage: { getItem(key) { return store.get(key) ?? null; }, setItem(key, value) { store.set(key, value); } },
    matchMedia() { return { matches: false, addEventListener(_type, listener) { systemChange = listener; } }; },
  };
  globalThis.fetch = async (url) => {
    const request = new URL(url, "http://127.0.0.1");
    return response(request.searchParams.has("from") ? metricsPayload(0, 1) : metricsPayload(1, 2));
  };
  try {
    const app = await import(`./app.mjs?theme=${Date.now()}`);
    await new Promise((resolve) => setImmediate(resolve));
    const theme = documentRef.elements.get("themeMode");
    theme.value = "dark";
    theme.emit("change");
    assert.equal(documentRef.documentElement.getAttribute("data-theme"), "dark");
    assert.equal(store.get("opencode-telemetry-theme"), "dark");
    theme.value = "system";
    theme.emit("change");
    systemChange?.();
    assert.equal(documentRef.documentElement.getAttribute("data-theme"), "system");

    globalThis.window.matchMedia = () => ({ matches: true });
    documentRef.elements.get("mobileMenuToggle").emit("click");
    assert.equal(documentRef.elements.get("appSidebar").getAttribute("data-drawer-state"), "open");
    assert.equal(documentRef.elements.get("appSidebar").getAttribute("aria-hidden"), "false");
    assert.equal(documentRef.body.classList.contains("drawer-open"), true);
    documentRef.elements.get("mobileDrawerClose").emit("click");
    assert.equal(documentRef.body.classList.contains("drawer-open"), false);
    documentRef.elements.get("sidebarToggle").emit("click");
    assert.equal(documentRef.body.classList.contains("sidebar-collapsed"), true);
    assert.equal(store.get("opencode-telemetry-sidebar-collapsed"), "true");
    documentRef.elements.get("sidebarToggle").emit("click");
    assert.equal(documentRef.body.classList.contains("sidebar-collapsed"), false);
    assert.equal(app.dashboardState.snapshot.range, "24h");
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("dashboard ignores a superseded request before it can render stale data", async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const documentRef = dashboardDocument();
  const calls = [];
  const oldCurrent = deferred();
  globalThis.document = documentRef;
  globalThis.window = { setInterval() {} };
  globalThis.fetch = async (url) => {
    const request = new URL(url, "http://127.0.0.1");
    calls.push(request);
    const session = request.searchParams.get("session");
    if (session === "old" && !request.searchParams.has("from")) return oldCurrent.promise;
    if (session === "old") throw new Error("superseded prior request should not run");
    if (session === "latest") {
      return response(request.searchParams.has("from")
        ? metricsPayload(0, 1_000, "latest-previous")
        : metricsPayload(1_000, 2_000, "latest"));
    }
    return response(request.searchParams.has("from") ? metricsPayload(0, 1) : metricsPayload(1, 2));
  };

  try {
    const app = await import(`./app.mjs?race=${Date.now()}`);
    await new Promise((resolve) => setImmediate(resolve));
    app.dashboardState.setSessionScope("old");
    const oldLoad = app.load("7d");
    app.dashboardState.setSessionScope("latest");
    app.load("7d", true);
    oldCurrent.resolve(response(metricsPayload(1_000, 2_000, "old")));
    await oldLoad;
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.some((request) => request.searchParams.get("session") === "old" && request.searchParams.has("from")), false);
    assert.equal(app.dashboardState.snapshot.currentPayload.marker, "latest");
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});

test("dashboard exposes current-request failures as an unavailable state", async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const documentRef = dashboardDocument();
  let requestCount = 0;
  let retryAllowed = false;
  globalThis.document = documentRef;
  globalThis.window = { setInterval() {} };
  globalThis.fetch = async (url) => {
    requestCount += 1;
    if (requestCount <= 2) {
      const request = new URL(url, "http://127.0.0.1");
      return response(request.searchParams.has("from") ? metricsPayload(0, 1) : metricsPayload(1, 2));
    }
    if (retryAllowed) {
      const request = new URL(url, "http://127.0.0.1");
      return response(request.searchParams.has("from") ? metricsPayload(0, 1) : metricsPayload(1, 2));
    }
    return { ok: false, async json() { return { error: "Database unavailable" }; } };
  };

  try {
    const app = await import(`./app.mjs?error=${Date.now()}`);
    await new Promise((resolve) => setImmediate(resolve));
    await app.load("24h");
    assert.equal(documentRef.elements.get("featureStatus").className, "view-status error");
    assert.match(documentRef.elements.get("featureStatusMessage").textContent, /Database unavailable/);
    assert.equal(documentRef.elements.get("featureStatus").getAttribute?.("aria-busy") ?? documentRef.elements.get("featureStatus").ariaBusy, "false");
    assert.equal(app.dashboardState.snapshot.currentPayload, null);
    assert.equal(app.dashboardState.snapshot.previousPayload, null);
    assert.equal(documentRef.elements.get("refresh").disabled, false);
    assert.equal(documentRef.elements.get("retryLoad").hidden, false);
    retryAllowed = true;
    await documentRef.elements.get("retryLoad").listeners.get("click")();
    assert.equal(app.dashboardState.snapshot.currentPayload.range.from, 1);
    assert.equal(documentRef.elements.get("retryLoad").hidden, true);
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});
