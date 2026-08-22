import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { parseArgs, requestOptions, startDashboardServer } from "./server.mjs";
import { sessionAlias } from "./metrics.mjs";

function requestHttp(port, pathname, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const requestHandle = request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ response, body }));
    });
    requestHandle.on("error", reject);
    requestHandle.end();
  });
}

function get(port, pathname, headers = {}) {
  return requestHttp(port, pathname, { headers });
}

async function createDatabase(setup = "") {
  const directory = await mkdtemp(join(tmpdir(), "metrics-dashboard-test-"));
  const dbPath = join(directory, "metrics.db");
  const database = new DatabaseSync(dbPath);
  try {
    if (setup) database.exec(setup);
  } finally {
    database.close();
  }
  return { directory, dbPath };
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function waitForNextTimestamp() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

test("serves the dashboard, health check, and metrics endpoint", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "metrics-dashboard-missing-"));
  const dbPath = join(directory, "missing-opencode.db");
  const started = await startDashboardServer({ port: 0, dbPath });
  t.after(async () => {
    await new Promise((resolve) => started.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const root = await get(started.port, "/");
  assert.equal(root.response.statusCode, 200);
  assert.match(root.response.headers["content-type"], /^text\/html/);
  assert.equal(root.response.headers["x-content-type-options"], "nosniff");
  assert.equal(root.response.headers["x-frame-options"], "DENY");
  assert.match(root.response.headers["content-security-policy"], /script-src 'self'/);
  assert.match(root.response.headers["content-security-policy"], /style-src 'self'/);
  assert.doesNotMatch(root.response.headers["content-security-policy"], /unsafe-inline/);
  assert.match(root.body, /rel="stylesheet" href="\/dashboard\/styles\.css"/);
  assert.match(root.body, /script type="module" src="\/dashboard\/app\.mjs"/);

  const health = await get(started.port, "/health");
  assert.equal(health.response.statusCode, 200);
  assert.deepEqual(JSON.parse(health.body), { ok: true });

  const metrics = await get(started.port, "/api/metrics");
  assert.equal(metrics.response.statusCode, 503);
  assert.deepEqual(JSON.parse(metrics.body), { error: "Database unavailable" });
});

test("serves allowlisted dashboard assets with their MIME types", async (t) => {
  const started = await startDashboardServer({ port: 0 });
  t.after(() => new Promise((resolve) => started.server.close(resolve)));

  const css = await get(started.port, "/dashboard/styles.css");
  assert.equal(css.response.statusCode, 200);
  assert.match(css.response.headers["content-type"], /^text\/css/);
  assert.match(css.body, /--accent/);

  const module = await get(started.port, "/dashboard/app.mjs");
  assert.equal(module.response.statusCode, 200);
  assert.match(module.response.headers["content-type"], /^text\/javascript/);
  assert.match(module.body, /createDashboardState/);
});

test("supports HEAD for dashboard assets without a response body", async (t) => {
  const started = await startDashboardServer({ port: 0 });
  t.after(() => new Promise((resolve) => started.server.close(resolve)));

  const getResult = await get(started.port, "/dashboard/styles.css");
  const headResult = await requestHttp(started.port, "/dashboard/styles.css", { method: "HEAD" });
  assert.equal(headResult.response.statusCode, 200);
  assert.equal(headResult.body, "");
  assert.equal(headResult.response.headers["content-type"], getResult.response.headers["content-type"]);
  assert.equal(headResult.response.headers["content-length"], getResult.response.headers["content-length"]);
});

test("rejects traversal, encoding tricks, directories, and unsupported assets", async (t) => {
  const started = await startDashboardServer({ port: 0 });
  t.after(() => new Promise((resolve) => started.server.close(resolve)));

  for (const pathname of [
    "/dashboard/../server.mjs",
    "/dashboard/%2e%2e/server.mjs",
    "/dashboard/%252e%252e%252fserver.mjs",
    "/dashboard/..%5cserver.mjs",
    "/dashboard/..\\server.mjs",
    "/dashboard/core/",
    "/dashboard/package.json",
    "/dashboard/missing.mjs",
  ]) {
    const result = await get(started.port, pathname);
    assert.equal(result.response.statusCode, 404, pathname);
  }
});

test("rejects a dashboard symlink that escapes staticRoot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "metrics-dashboard-static-"));
  const outside = await mkdtemp(join(tmpdir(), "metrics-dashboard-outside-"));
  await mkdir(join(root, "dashboard"));
  const outsideAsset = join(outside, "secret.mjs");
  await writeFile(outsideAsset, "export const secret = true;\n");
  try {
    await symlink(outsideAsset, join(root, "dashboard", "escape.mjs"));
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    t.skip(`symlinks unavailable: ${error.code || error.message}`);
    return;
  }

  const started = await startDashboardServer({ port: 0, staticRoot: root });
  t.after(async () => {
    await new Promise((resolve) => started.server.close(resolve));
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const result = await get(started.port, "/dashboard/escape.mjs");
  assert.equal(result.response.statusCode, 404);
});

test("rejects non-GET methods consistently while allowing HEAD", async (t) => {
  const started = await startDashboardServer({ port: 0 });
  t.after(() => new Promise((resolve) => started.server.close(resolve)));

  const result = await requestHttp(started.port, "/dashboard/app.mjs", { method: "POST" });
  assert.equal(result.response.statusCode, 405);
  assert.equal(result.response.headers.allow, "GET, HEAD");
  assert.deepEqual(JSON.parse(result.body), { error: "GET or HEAD only" });
});

test("rejects non-loopback Host headers", async (t) => {
  const started = await startDashboardServer({ port: 0 });
  t.after(() => new Promise((resolve) => started.server.close(resolve)));

  const result = await get(started.port, "/health", { host: "example.test" });
  assert.equal(result.response.statusCode, 403);
  assert.deepEqual(JSON.parse(result.body), { error: "Loopback requests only" });
});

test("parses the browser launch flag", () => {
  assert.deepEqual(parseArgs(["--open", "--port", "4174", "--db=telemetry.db"]), {
    open: true,
    port: 4174,
    dbPath: "telemetry.db",
  });
  assert.equal(parseArgs(["--inspect-environment"]).inspectEnvironment, true);
});

test("forwards range, bounds, and session metrics options", () => {
  const url = new URL("http://127.0.0.1/api/metrics?range=day&from=2026-08-01&to=2026-08-02&session=abc&includeSessionTitles=1&includeEnvironment=1");
  assert.deepEqual(requestOptions(url), {
    range: "day",
    from: "2026-08-01",
    to: "2026-08-02",
    session: "abc",
    includeSessionTitles: true,
    includeEnvironment: true,
  });
});

test("does not opt into session titles for other query values", () => {
  assert.deepEqual(requestOptions(new URL("http://127.0.0.1/api/metrics?includeSessionTitles=0")), {});
});

test("requires startup and request opt-in for configured environment inventory", async (t) => {
  const { directory, dbPath } = await createDatabase(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, time_created INTEGER, time_updated INTEGER, agent TEXT, model TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    INSERT INTO session VALUES ('PRIVATE-SERVER-SESSION-ID', NULL, 1, 100, 'server-agent', 'server-model');
    INSERT INTO message VALUES ('PRIVATE-SERVER-MESSAGE-ID', 'PRIVATE-SERVER-SESSION-ID', 1, 100, '{"role":"assistant","tokens":{"input":2},"text":"PRIVATE PAYLOAD"}');
    INSERT INTO part VALUES ('PRIVATE-SERVER-PART-ID', 'PRIVATE-SERVER-SESSION-ID', 'PRIVATE-SERVER-MESSAGE-ID', 10, 20, '{"type":"tool","tool":"read"}');
  `);
  const started = await startDashboardServer({
    port: 0,
    dbPath,
    inspectEnvironment: true,
    environmentOptions: { candidates: [{ type: "agent", name: "configured-agent", version: "v1.0.0" }] },
  });
  t.after(async () => {
    await closeServer(started.server);
    await rm(directory, { recursive: true, force: true });
  });

  const withoutRequestOptIn = JSON.parse((await get(started.port, "/api/metrics")).body);
  assert.equal(withoutRequestOptIn.analytics.schemaVersion, 1);
  assert.equal(withoutRequestOptIn.analytics.environment.configured.available, false);
  assert.equal(withoutRequestOptIn.analytics.environment.configured.availability.reason, "request-opt-in-required");

  const withRequestOptIn = JSON.parse((await get(started.port, "/api/metrics?includeEnvironment=1")).body);
  assert.equal(withRequestOptIn.analytics.environment.configured.available, true);
  assert.deepEqual(withRequestOptIn.analytics.environment.configured.agents.map(({ name }) => name), ["configured-agent"]);
  assert.equal(withRequestOptIn.analytics.environment.observed.tools[0].name, "read");
  for (const forbidden of ["PRIVATE-SERVER-SESSION-ID", "PRIVATE-SERVER-MESSAGE-ID", "PRIVATE-SERVER-PART-ID", "PRIVATE PAYLOAD"]) {
    assert.equal(JSON.stringify(withRequestOptIn.analytics).includes(forbidden), false, `leaked ${forbidden}`);
  }
});

test("keeps endpoint responses consistent for a same-version cache hit", async (t) => {
  const { directory, dbPath } = await createDatabase();
  const started = await startDashboardServer({ port: 0, dbPath });
  t.after(async () => {
    await closeServer(started.server);
    await rm(directory, { recursive: true, force: true });
  });

  const first = await get(started.port, "/api/metrics?session=abc");
  const second = await get(started.port, "/api/metrics?session=abc");
  assert.equal(first.response.statusCode, 200);
  assert.equal(second.response.statusCode, 200);

  const firstValue = JSON.parse(first.body);
  const secondValue = JSON.parse(second.body);
  assert.match(firstValue.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(secondValue.generatedAt, firstValue.generatedAt);
  assert.equal(secondValue.dataVersion, firstValue.dataVersion);
  assert.deepEqual(secondValue, firstValue);
});

test("invalidates cached metrics after writer insert, update, and delete", async (t) => {
  const { directory, dbPath } = await createDatabase(
    "CREATE TABLE writer_probe (id INTEGER PRIMARY KEY, value TEXT);",
  );
  const writer = new DatabaseSync(dbPath);
  const started = await startDashboardServer({ port: 0, dbPath });
  t.after(async () => {
    await closeServer(started.server);
    writer.close();
    await rm(directory, { recursive: true, force: true });
  });

  const readMetrics = async () => JSON.parse((await get(started.port, "/api/metrics")).body);
  const initial = await readMetrics();
  const hit = await readMetrics();
  assert.equal(hit.generatedAt, initial.generatedAt);
  assert.equal(hit.dataVersion, initial.dataVersion);

  writer.exec("INSERT INTO writer_probe (value) VALUES ('inserted');");
  await waitForNextTimestamp();
  const inserted = await readMetrics();
  assert.notEqual(inserted.dataVersion, initial.dataVersion);
  assert.notEqual(inserted.generatedAt, initial.generatedAt);

  writer.exec("UPDATE writer_probe SET value = 'updated' WHERE id = 1;");
  await waitForNextTimestamp();
  const updated = await readMetrics();
  assert.notEqual(updated.dataVersion, inserted.dataVersion);
  assert.notEqual(updated.generatedAt, inserted.generatedAt);

  writer.exec("DELETE FROM writer_probe WHERE id = 1;");
  await waitForNextTimestamp();
  const deleted = await readMetrics();
  assert.notEqual(deleted.dataVersion, updated.dataVersion);
  assert.notEqual(deleted.generatedAt, updated.generatedAt);
});

test("requires the exact export header and serves a read-only deterministic snapshot", async (t) => {
  const { directory, dbPath } = await createDatabase(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, time_created INTEGER, time_updated INTEGER, agent TEXT, model TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    INSERT INTO session VALUES ('server-root', NULL, 1, 2, 'agent', 'model');
    INSERT INTO session VALUES ('server-child', 'server-root', 2, 3, 'child', 'model');
    INSERT INTO message VALUES ('server-message', 'server-root', 2, 3, '{"role":"user","text":"raw"}');
    INSERT INTO part VALUES ('server-part', 'server-root', 'server-message', 3, 4, '{"type":"tool","tool":"read"}');
  `);
  const writer = new DatabaseSync(dbPath);
  const started = await startDashboardServer({ port: 0, dbPath });
  t.after(async () => {
    await closeServer(started.server);
    writer.close();
    await rm(directory, { recursive: true, force: true });
  });
  const alias = sessionAlias("server-root");
  const beforeVersion = writer.prepare("PRAGMA data_version").get().data_version;
  const beforeSchema = writer.prepare("SELECT sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const denied = await get(started.port, `/api/session-export?root=${alias}`);
  assert.equal(denied.response.statusCode, 403);
  assert.deepEqual(JSON.parse(denied.body), { error: "Export confirmation required" });
  const crossOrigin = await get(started.port, `/api/session-export?root=${alias}`, {
    "X-OpenCode-Export": "session-contents-v1",
    origin: "http://localhost:9999",
  });
  assert.equal(crossOrigin.response.statusCode, 403);
  const exported = await get(started.port, `/api/session-export?root=${alias}`, { "X-OpenCode-Export": "session-contents-v1" });
  assert.equal(exported.response.statusCode, 200);
  assert.equal(exported.response.headers["cache-control"], "no-store");
  const model = JSON.parse(exported.body);
  assert.equal(model.bundleSchemaVersion, 1);
  assert.equal(model.files.length, 7);
  assert.equal(JSON.parse(model.files[0].content).coverage.mode, "snapshot-only");
  assert.equal(writer.prepare("PRAGMA data_version").get().data_version, beforeVersion);
  assert.deepEqual(writer.prepare("SELECT sql FROM sqlite_master WHERE type='table' ORDER BY name").all(), beforeSchema);
});
