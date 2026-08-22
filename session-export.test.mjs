import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildSessionExport, canonicalJson } from "./session-export.mjs";
import { sessionAlias } from "./metrics.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "opencode-session-export-"));
  const path = join(directory, "fixture.db");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      time_created INTEGER,
      time_updated REAL,
      title TEXT,
      extra BLOB
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      message_id TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT
    );
  `);
  const session = db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)");
  const message = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
  const part = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
  session.run("root", null, 1_700_000_000_000, -0, "Root title", Buffer.from([0, 255]));
  session.run("child", "root", 1_700_000_000_100, 1_700_000_000_200, "Child", null);
  session.run("grandchild", "child", 1_700_000_000_300, 1_700_000_000_400, "Grandchild", null);
  session.run("unrelated", null, 1_700_000_000_500, 1_700_000_000_600, "Unrelated", null);
  session.run("orphan", "missing-parent", 1_700_000_000_700, 1_700_000_000_800, "Orphan", null);
  message.run("root-message", "root", 1_700_000_000_010, 1_700_000_000_020, JSON.stringify({ role: "user", text: "Keep exact" }));
  message.run("child-message", "child", 1_700_000_000_110, 1_700_000_000_120, JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Response" }] }));
  message.run("unrelated-message", "unrelated", 1_700_000_000_510, 1_700_000_000_520, JSON.stringify({ role: "user", text: "Excluded" }));
  part.run("root-part", "root", "root-message", 1_700_000_000_030, 1_700_000_000_040, JSON.stringify({ type: "tool", tool: "read", state: { status: "completed" } }));
  part.run("child-part", "child", "child-message", 1_700_000_000_130, 1_700_000_000_140, JSON.stringify({ type: "text", text: "Part text" }));
  part.run("unattached-part", "grandchild", null, 1_700_000_000_330, 1_700_000_000_340, JSON.stringify({ type: "unknown" }));
  db.close();
  return { directory, path };
}

test("builds a deterministic, raw-fidelity snapshot without changing SQLite", () => {
  const created = fixture();
  const alias = sessionAlias("root");
  const before = new DatabaseSync(created.path);
  const beforeVersion = before.prepare("PRAGMA data_version").get().data_version;
  const beforeSchema = before.prepare("SELECT sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const beforeRows = before.prepare("SELECT * FROM session ORDER BY id").all();
  before.close();
  const db = new DatabaseSync(created.path, { readOnly: true });
  try {
    const first = buildSessionExport(db, alias);
    const second = buildSessionExport(db, alias);
    assert.deepEqual(first, second);
    assert.deepEqual(first.files.map((file) => file.path), [
      "manifest.json", "raw/sessions.json", "raw/messages.json", "raw/parts.json", "timeline.json", "metrics.json", "transcript.json",
    ]);
    const rawSessions = JSON.parse(first.files[1].content);
    assert.equal(rawSessions.rows.length, 3);
    assert.deepEqual(rawSessions.rows[2][5], { type: "blob", value: "AP8=" });
    assert.equal(rawSessions.rows[2][3].type, "real");
    assert.deepEqual(rawSessions.rows[0][5], { type: "null", value: null });
    assert.equal(rawSessions.rows[2][4].value, "Root title");
    const manifest = JSON.parse(first.files[0].content);
    assert.equal(manifest.coverage.mode, "snapshot-only");
    assert.equal(manifest.coverage.runtimeSnapshot.consistency, "single-sqlite-read-transaction");
    assert.equal(manifest.counts.sessions, 3);
    assert.equal(manifest.counts.messages, 2);
    assert.equal(manifest.counts.parts, 3);
    assert.equal(JSON.parse(first.files[4].content).events.length, 8);
    const transcript = JSON.parse(first.files[6].content);
    assert.equal(transcript.messages.length, 2);
    assert.equal(transcript.unattachedParts.length, 1);
  } finally {
    db.close();
  }
  const after = new DatabaseSync(created.path);
  try {
    assert.equal(after.prepare("PRAGMA data_version").get().data_version, beforeVersion);
    assert.deepEqual(after.prepare("SELECT sql FROM sqlite_master WHERE type='table' ORDER BY name").all(), beforeSchema);
    assert.deepEqual(after.prepare("SELECT * FROM session ORDER BY id").all(), beforeRows);
  } finally {
    after.close();
    rmSync(created.directory, { recursive: true, force: true });
  }
});

test("preserves SQLite big integers and records unsupported content without inventing text", () => {
  const created = fixture();
  const writer = new DatabaseSync(created.path);
  writer.exec("ALTER TABLE session ADD COLUMN big_value INTEGER;");
  writer.prepare("UPDATE session SET big_value = ? WHERE id = 'root'").run(9007199254740993123n);
  writer.prepare("UPDATE part SET time_created = NULL, time_updated = NULL, data = ? WHERE id = 'unattached-part'").run(Buffer.from([0xff, 0xfe]));
  writer.close();

  const db = new DatabaseSync(created.path, { readOnly: true });
  try {
    const exported = buildSessionExport(db, sessionAlias("root"));
    const rawSessions = JSON.parse(exported.files[1].content);
    const root = rawSessions.rows.find((row) => row[0].value === "root");
    assert.deepEqual(root.at(-1), { type: "integer", value: "9007199254740993123" });
    const manifest = JSON.parse(exported.files[0].content);
    assert.ok(manifest.anomalies.includes("data-invalid-utf8"));
    assert.ok(manifest.anomalies.includes("time-missing"));
    const transcript = JSON.parse(exported.files.at(-1).content);
    const unsupported = transcript.unattachedParts.find((part) => part.id === "unattached-part");
    assert.deepEqual(unsupported.segments, []);
    assert.ok(unsupported.anomalies.includes("data-invalid-utf8"));
  } finally {
    db.close();
    rmSync(created.directory, { recursive: true, force: true });
  }
});

test("canonical JSON has sorted keys and one trailing LF", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: true, x: null } }), '{"a":{"x":null,"y":true},"z":1}\n');
});

test("rejects child selection and unknown aliases without falling back to all sessions", () => {
  const created = fixture();
  const db = new DatabaseSync(created.path, { readOnly: true });
  try {
    assert.throws(() => buildSessionExport(db, sessionAlias("child")), /selected session is not a root/);
    assert.throws(() => buildSessionExport(db, "0000000000000000"), /unknown root selection/);
    assert.throws(() => buildSessionExport(db, sessionAlias("ROOT")), /unknown root selection/);
    assert.throws(() => buildSessionExport(db, `${sessionAlias("root")}x`), /invalid root selection/);
  } finally {
    db.close();
    rmSync(created.directory, { recursive: true, force: true });
  }
});

test("fails closed for a part whose direct session and message point across trees", () => {
  const created = fixture();
  const writer = new DatabaseSync(created.path);
  writer.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
    "cross-tree-part",
    "root",
    "unrelated-message",
    1,
    2,
    JSON.stringify({ type: "tool", tool: "task" }),
  );
  writer.close();
  const db = new DatabaseSync(created.path, { readOnly: true });
  try {
    assert.throws(() => buildSessionExport(db, sessionAlias("root")), /cross-tree part relation/);
  } finally {
    db.close();
    rmSync(created.directory, { recursive: true, force: true });
  }
});
