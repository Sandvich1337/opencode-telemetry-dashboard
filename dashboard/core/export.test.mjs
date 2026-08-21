import assert from "node:assert/strict";
import test from "node:test";

import {
  CSV_MIME,
  EXPORT_SCHEMA_VERSION,
  JSON_MIME,
  createDownloadDescriptor,
  createJsonExport,
  csvEscape,
  diffEnvironmentBaseline,
  diffValues,
  makeExportFilename,
  principalRows,
  redactAggregatePayload,
  serializeCsv,
  serializeEnvironmentCsv,
  serializeJsonExport,
  serializePrincipalCsv,
  stableStringify,
} from "./export.mjs";

function inventoryEntry(type, name, sampleCount = 1, extra = {}) {
  return {
    type,
    name,
    version: "v1",
    available: true,
    capabilities: { stable: true },
    sample: { count: sampleCount, observed: sampleCount, denominator: sampleCount },
    provenance: "observed",
    ...extra,
  };
}

function payload({ configured = [], observed = [], extra = {}, analyticsExtra = {} } = {}) {
  return {
    summary: { runs: observed.length + configured.length, status: "loaded" },
    groups: [{ name: "builder", runs: observed.length }],
    toolUsage: { total: observed.length, rows: [] },
    ...extra,
    analytics: {
      environment: {
        observed: { mode: "observed", available: observed.length > 0, agents: observed, models: [], tools: [], capabilities: [] },
        configured: { mode: "configured", available: configured.length > 0, agents: configured, models: [], tools: [], capabilities: [] },
      },
      ...analyticsExtra,
    },
  };
}

test("redaction is allow-listed and strips adversarial source-like values", () => {
  const result = redactAggregatePayload(payload({
    observed: [inventoryEntry("agent", "<script>alert(1)</script>", 1, {
      path: "C:\\private\\source",
      command: "node --token secret",
      headers: { authorization: "Bearer hidden" },
      env: { SECRET: "hidden" },
    })],
    configured: [inventoryEntry("agent", "https://example.test/private", 1)],
  }));
  const serialized = stableStringify(result);
  assert.equal(result.observed.agents[0].name, "unknown");
  assert.equal(result.configured.agents[0].name, "unknown");
  assert.doesNotMatch(serialized, /script|example\.test|private|authorization|Bearer|hidden|command|headers|env/i);
  assert.deepEqual(Object.keys(result.observed.agents[0]).sort(), ["available", "capabilities", "name", "provenance", "sample", "type", "version"]);
});

test("JSON exports carry version one and deterministic redacted payload", () => {
  const source = payload({ observed: [inventoryEntry("agent", "build")] });
  const first = serializeJsonExport(source);
  const second = serializeJsonExport({
    toolUsage: source.toolUsage,
    analytics: source.analytics,
    summary: source.summary,
    groups: source.groups,
  });
  assert.equal(first, second);
  const parsed = JSON.parse(first);
  assert.equal(parsed.exportSchemaVersion, EXPORT_SCHEMA_VERSION);
  assert.equal(parsed.payload.analytics.environment.observed.mode, "observed");
  assert.equal(parsed.payload.analytics.environment.configured.mode, "configured");
  assert.deepEqual(parsed.payload.analytics.environment.observed.agents[0].name, "build");
  assert.equal(parsed.payload.analytics.environment.configured.available, false);
  assert.deepEqual(parsed.payload.summary, source.summary);
  assert.deepEqual(parsed.payload.groups, source.groups);
  assert.deepEqual(parsed.payload.toolUsage, source.toolUsage);
  assert.deepEqual(createJsonExport(source).payload, parsed.payload);
});

test("JSON preserves public aggregate analytics while removing dangerous keys and values", () => {
  const source = payload({
    observed: [inventoryEntry("agent", "build", 1, {
      path: "C:\\private\\source",
      command: "node --token secret",
      headers: { authorization: "Bearer hidden" },
      env: { SECRET: "hidden" },
    })],
    configured: [inventoryEntry("tool", "reader")],
    extra: {
      secret: "hidden",
      path: "C:\\private\\aggregate",
      url: "https://example.test/private",
      command: "powershell -Command hidden",
      headers: { cookie: "hidden" },
      env: { PRIVATE_VALUE: "hidden" },
      envValue: "hidden",
      environmentValue: "hidden",
    },
    analyticsExtra: {
      architecture: { nodes: [{ id: "run-001", label: "builder" }], privatePath: "C:\\private" },
      throughput: { totals: { calls: 3, rates: { toolCallsPerMinute: 2 } }, command: "rm -rf /" },
    },
  });
  const exported = createJsonExport(source);
  assert.deepEqual(exported.payload.summary, source.summary);
  assert.deepEqual(exported.payload.groups, source.groups);
  assert.deepEqual(exported.payload.toolUsage, source.toolUsage);
  assert.equal(exported.payload.analytics.architecture.nodes[0].id, "run-001");
  assert.equal(exported.payload.analytics.throughput.totals.calls, 3);
  assert.equal(exported.payload.secret, undefined);
  assert.equal(exported.payload.envValue, undefined);
  assert.equal(exported.payload.environmentValue, undefined);
  assert.equal(exported.payload.analytics.architecture.privatePath, undefined);
  assert.doesNotMatch(stableStringify(exported), /private|example\.test|powershell|hidden|authorization|cookie|PRIVATE_VALUE/i);

  const withoutConfigured = createJsonExport(source, { includeConfigured: false }).payload;
  assert.deepEqual(withoutConfigured.summary, source.summary);
  assert.equal(withoutConfigured.analytics.architecture.nodes[0].id, "run-001");
  assert.equal(withoutConfigured.analytics.environment.configured.available, false);
  assert.equal(withoutConfigured.analytics.environment.configured.mode, "configured");
  assert.equal(withoutConfigured.analytics.environment.observed.agents[0].name, "build");
});

test("principal rows and CSV are deterministic, quoted, and formula safe", () => {
  const source = payload({ observed: [inventoryEntry("agent", "build")], configured: [inventoryEntry("tool", "reader")] });
  const rows = principalRows(source);
  assert.deepEqual(rows.map((row) => `${row.inventory}:${row.type}:${row.name}`), ["configured:tool:reader", "observed:agent:build"]);
  const csv = serializePrincipalCsv(source);
  assert.match(csv, /^inventory,type,name,version,available,sampleCount,sampleObserved,sampleDenominator,capabilities\r\n/);
  assert.match(csv, /"\{""stable"":true\}"/);
  assert.equal(csvEscape("=SUM(A1:A2)"), "'=SUM(A1:A2)");
  assert.equal(csvEscape("a,b"), '"a,b"');
  assert.equal(csv.endsWith("\r\n"), true);
  assert.equal(serializeEnvironmentCsv(source), csv);
});

test("generic CSV accepts explicit rows and columns instead of environment payloads", () => {
  const rows = [
    { value: "=SUM(A1:A2)", label: "a,b" },
    { value: "plain", label: "line\nvalue" },
  ];
  assert.equal(serializeCsv(rows, ["label", "value"]), "label,value\r\n\"a,b\",'=SUM(A1:A2)\r\n\"line\nvalue\",plain\r\n");
});

test("baseline diff reports add, remove, and change in stable order", () => {
  const before = payload({ observed: [inventoryEntry("agent", "build", 1), inventoryEntry("tool", "read")] });
  const after = payload({ observed: [inventoryEntry("agent", "build", 2), inventoryEntry("model", "new-model")] });
  const result = diffEnvironmentBaseline(after, before);
  assert.deepEqual(result.counts, { added: 1, removed: 1, changed: 1 });
  assert.equal(result.added[0].after.name, "new-model");
  assert.equal(result.removed[0].before.name, "read");
  assert.equal(result.changed[0].before.sampleCount, 1);
  assert.equal(result.changed[0].after.sampleCount, 2);
  assert.deepEqual(diffEnvironmentBaseline(after, null).counts, { added: 2, removed: 0, changed: 0 });
});

test("generic diff and filenames remain deterministic and safe", () => {
  assert.deepEqual(diffValues({ b: 1, removed: true }, { a: 2, b: 3 }), {
    added: [{ path: "a", value: 2 }],
    removed: [{ path: "removed", value: true }],
    changed: [{ path: "b", before: 1, after: 3 }],
    hasChanges: true,
  });
  assert.equal(makeExportFilename("../<evil>\\environment", ".json"), "environment.json");
  assert.equal(makeExportFilename("report.csv", ".json"), "report.json");
  const json = createDownloadDescriptor("json", payload());
  const csv = createDownloadDescriptor("csv", payload());
  assert.equal(json.mime, JSON_MIME);
  assert.equal(csv.mime, CSV_MIME);
  assert.equal(json.filename, "environment.json");
  assert.equal(csv.filename, "environment-principals.csv");
});

test("partial and unavailable payloads serialize without throwing", () => {
  const result = redactAggregatePayload({ analytics: { environment: { observed: null } } });
  assert.equal(result.observed.available, false);
  assert.equal(result.configured.available, false);
  assert.doesNotThrow(() => serializeJsonExport(undefined));
  assert.match(serializePrincipalCsv({}), /^inventory,type,name/);
});

test("configured CSV rows remain gated by the explicit export opt-in", () => {
  const source = payload({ observed: [inventoryEntry("agent", "build")], configured: [inventoryEntry("tool", "reader")] });
  const hidden = serializeEnvironmentCsv(source, { includeConfigured: false });
  const visible = serializeEnvironmentCsv(source, { includeConfigured: true });
  assert.doesNotMatch(hidden, /configured,tool,reader/);
  assert.match(visible, /configured,tool,reader/);
});
