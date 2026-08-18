import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { parseArgs, requestOptions, startDashboardServer } from "./server.mjs";

function get(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const requestHandle = request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
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

  const health = await get(started.port, "/health");
  assert.equal(health.response.statusCode, 200);
  assert.deepEqual(JSON.parse(health.body), { ok: true });

  const metrics = await get(started.port, "/api/metrics");
  assert.equal(metrics.response.statusCode, 503);
  assert.deepEqual(JSON.parse(metrics.body), { error: "Database unavailable" });
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
});

test("forwards range, bounds, and session metrics options", () => {
  const url = new URL("http://127.0.0.1/api/metrics?range=day&from=2026-08-01&to=2026-08-02&session=abc&includeSessionTitles=1");
  assert.deepEqual(requestOptions(url), {
    range: "day",
    from: "2026-08-01",
    to: "2026-08-02",
    session: "abc",
    includeSessionTitles: true,
  });
});

test("does not opt into session titles for other query values", () => {
  assert.deepEqual(requestOptions(new URL("http://127.0.0.1/api/metrics?includeSessionTitles=0")), {});
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
