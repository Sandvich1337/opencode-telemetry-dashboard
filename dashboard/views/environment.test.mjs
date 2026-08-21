import assert from "node:assert/strict";
import test from "node:test";

import { createEnvironmentView, renderEnvironmentView } from "./environment.mjs";

function entry(type, name) {
  return {
    type,
    name,
    version: "v1",
    available: true,
    capabilities: { "safe-capability": true },
    sample: { count: 1, observed: 1, denominator: 1 },
    provenance: type === "model" ? "configured" : "observed",
  };
}

function payload(configuredAvailable = true) {
  return {
    analytics: {
      environment: {
        observed: {
          mode: "observed",
          available: true,
          availability: { available: true, basis: "observed", reason: "inventory-present" },
          agents: [entry("agent", "build")],
          models: [],
          tools: [entry("tool", "read")],
          capabilities: [],
        },
        configured: {
          mode: "configured",
          available: configuredAvailable,
          availability: {
            available: configuredAvailable,
            basis: configuredAvailable ? "reported" : "unavailable",
            reason: configuredAvailable ? "explicit" : "startup-opt-in-required",
          },
          agents: configuredAvailable ? [entry("model", "configured-model")] : [],
          models: [],
          tools: [],
          capabilities: [],
        },
      },
    },
  };
}

test("rendering distinguishes always-observed and both configured opt-in gates", () => {
  const hidden = renderEnvironmentView({ payload: payload(true), state: { environmentOptIn: false } });
  assert.match(hidden, /Always-observed inventory/);
  assert.match(hidden, /build/);
  assert.doesNotMatch(hidden, /configured-model/);
  assert.match(hidden, /local opt-in/);
  assert.match(hidden, /Basis/);
  assert.match(hidden, /Confidence/);

  const serverUnavailable = renderEnvironmentView({ payload: payload(false), state: { environmentOptIn: true } });
  assert.match(serverUnavailable, /server was not started with environment inspection enabled/i);
  assert.doesNotMatch(serverUnavailable, /configured-model/);

  const visible = renderEnvironmentView({ payload: payload(true), state: { environmentOptIn: true } });
  assert.match(visible, /configured-model/);
  assert.match(visible, /Show configured inventory/);
  assert.match(visible, /Explicit caller-provided inventory/);
});

test("pure rendering escapes adversarial labels and handles unavailable payloads", () => {
  const markup = renderEnvironmentView({
    payload: { analytics: { environment: { observed: { available: true, agents: [{ type: "agent", name: "<img src=x onerror=1>", version: "v1" }] } } } },
    state: { environmentOptIn: false },
  });
  assert.doesNotMatch(markup, /<img|onerror=/i);
  assert.match(markup, /unknown/);
  assert.match(renderEnvironmentView({}), /No environment inventory was included/);
});

test("semantic hierarchy keeps opt-in, table, diff, and export controls discoverable", () => {
  const markup = renderEnvironmentView({ payload: payload(true), state: { environmentOptIn: false } });
  assert.match(markup, /class="environment-inventory-grid"/);
  assert.match(markup, /role="note"/);
  assert.match(markup, /class="environment-table-wrap table-scroll"/);
  assert.match(markup, /aria-label="Environment baseline and export actions"/);
  assert.match(markup, /aria-label="Show configured inventory"/);
  assert.match(markup, /data-environment-action="download-json"/);
  assert.match(markup, /data-environment-action="download-csv"/);
});

class FakeHost {
  constructor() {
    this.innerHTML = "";
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  emit(type, target) {
    this.listeners.get(type)?.({ target });
  }
}

test("lifecycle binds and cleans listeners, with safe optional actions", () => {
  const host = new FakeHost();
  const calls = [];
  const downloads = [];
  const view = createEnvironmentView(host);
  view.mount({ payload: payload(true), state: { environmentOptIn: false }, actions: { setEnvironmentOptIn: (enabled) => calls.push(["opt-in", enabled]) } });
  assert.equal(host.listeners.size, 2);
  host.emit("change", { dataset: { environmentOptIn: "true" }, checked: true });
  assert.deepEqual(calls, [["opt-in", true]]);
  view.update({ payload: payload(true), state: { environmentOptIn: true }, actions: { download: (descriptor) => downloads.push(descriptor) } });
  assert.equal(host.listeners.size, 2);
  host.emit("click", { dataset: { environmentAction: "download-json" } });
  host.emit("click", { dataset: { environmentAction: "download-csv" } });
  host.emit("click", { dataset: { environmentAction: "save-baseline" } });
  assert.equal(downloads.length, 2);
  assert.match(downloads[0].content, /"exportSchemaVersion":1/);
  assert.match(downloads[0].content, /analytics/);
  assert.match(downloads[1].content, /^inventory,type,name,/);
  view.destroy();
  assert.equal(host.listeners.size, 0);
});

test("lifecycle rebinds when the registry supplies a new host", () => {
  const first = new FakeHost();
  const second = new FakeHost();
  const view = createEnvironmentView(first);
  view.mount({ payload: payload(true), state: { environmentOptIn: false } });
  view.update({ root: second, payload: payload(true), state: { environmentOptIn: true } });
  assert.equal(first.listeners.size, 0);
  assert.equal(second.listeners.size, 2);
  view.destroy();
  assert.equal(second.listeners.size, 0);
});
