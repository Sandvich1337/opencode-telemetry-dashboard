import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeMetrics,
  openReadOnlyDatabase,
  resolveDatabasePath,
} from "./metrics.mjs";

const DASHBOARD_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 4173;
const MAX_CACHE_ENTRIES = 16;
const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function isLoopbackHost(host) {
  if (typeof host !== "string") return false;
  return /^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/i.test(host)
    || /^\[::1\](?::\d{1,5})?$/i.test(host);
}

function jsonResponse(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function htmlResponse(response, body) {
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function genericError(response, status, message) {
  jsonResponse(response, status, { error: message });
}

export function requestOptions(url) {
  const options = {};
  const range = url.searchParams.get("range");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const session = url.searchParams.get("session");
  const includeSessionTitles = url.searchParams.get("includeSessionTitles");
  if (range) options.range = range;
  if (from) options.from = from;
  if (to) options.to = to;
  if (session) options.session = session;
  if (includeSessionTitles === "1") options.includeSessionTitles = true;
  return options;
}

export function createDashboardServer({ dbPath, staticRoot = DASHBOARD_DIR } = {}) {
  let db;
  let cachedDataVersion;
  const metricsCache = new Map();

  const server = createServer(async (request, response) => {
    if (!isLoopbackHost(request.headers.host)) {
      return genericError(response, 403, "Loopback requests only");
    }

    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      return genericError(response, 405, "GET only");
    }

    let url;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      return genericError(response, 400, "Bad request");
    }

    if (url.pathname === "/health") {
      return jsonResponse(response, 200, { ok: true });
    }

    if (url.pathname === "/api/metrics") {
      try {
        if (!db) db = openReadOnlyDatabase(resolveDatabasePath(dbPath));

        const options = requestOptions(url);
        const dataVersion = db.prepare("PRAGMA data_version").get().data_version;
        if (cachedDataVersion !== dataVersion) {
          metricsCache.clear();
          cachedDataVersion = dataVersion;
        }

        const cacheKey = JSON.stringify([
          options.range ?? null,
          options.from ?? null,
          options.to ?? null,
          options.session ?? null,
          options.includeSessionTitles === true,
        ]);
        const cached = metricsCache.get(cacheKey);
        if (cached !== undefined) return jsonResponse(response, 200, cached);

        let transactionStarted = false;
        let value;
        try {
          db.exec("BEGIN");
          transactionStarted = true;
          value = {
            ...computeMetrics(db, options),
            generatedAt: new Date().toISOString(),
            dataVersion,
          };
          db.exec("COMMIT");
          transactionStarted = false;
        } finally {
          if (transactionStarted) {
            try {
              db.exec("ROLLBACK");
            } catch {
              // Rollback is best effort after a failed read.
            }
          }
        }

        metricsCache.set(cacheKey, value);
        if (metricsCache.size > MAX_CACHE_ENTRIES) {
          metricsCache.delete(metricsCache.keys().next().value);
        }
        return jsonResponse(response, 200, value);
      } catch {
        return genericError(response, 503, "Database unavailable");
      }
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      try {
        const body = await readFile(resolve(staticRoot, "index.html"), "utf8");
        return htmlResponse(response, body);
      } catch {
        return genericError(response, 404, "Dashboard unavailable");
      }
    }

    return genericError(response, 404, "Not found");
  });

  server.on("close", () => {
    metricsCache.clear();
    cachedDataVersion = undefined;
    try {
      db?.close();
    } catch {
      // Closing the persistent read-only connection is best effort.
    }
    db = undefined;
  });

  return server;
}

export function parseArgs(argv) {
  const options = {
    dbPath: undefined,
    port: Number(process.env.METRICS_DASHBOARD_PORT ?? DEFAULT_PORT),
    open: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--db") options.dbPath = argv[++index];
    else if (argument.startsWith("--db=")) options.dbPath = argument.slice(5);
    else if (argument === "--port") options.port = Number(argv[++index]);
    else if (argument.startsWith("--port=")) options.port = Number(argument.slice(7));
    else if (argument === "--open") options.open = true;
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("invalid port");
  }
  return options;
}

function openBrowser(url) {
  const command = process.platform === "win32"
    ? process.env.ComSpec || "cmd.exe"
    : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    execFile(command, args, { windowsHide: true }, () => {});
  } catch {
    // Opening a browser is best effort; the dashboard remains available by URL.
  }
}

export function startDashboardServer(options = {}) {
  const server = createDashboardServer(options);
  const port = options.port ?? DEFAULT_PORT;
  return new Promise((resolvePromise, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise({ server, port: server.address().port });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const started = await startDashboardServer(options);
  const dashboardUrl = `http://127.0.0.1:${started.port}`;
  console.log(`Telemetry dashboard listening on ${dashboardUrl}`);
  if (options.open) openBrowser(dashboardUrl);
  const stop = () => started.server.close(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(() => {
    console.error("Unable to start the loopback dashboard.");
    process.exitCode = 1;
  });
}
