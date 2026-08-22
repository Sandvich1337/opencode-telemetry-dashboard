import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeMetrics,
  openReadOnlyDatabase,
  resolveDatabasePath,
} from "./metrics.mjs";
import { buildSessionExport, isExportHeader } from "./session-export.mjs";

const DASHBOARD_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 4173;
const MAX_CACHE_ENTRIES = 16;
const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Pragma": "no-cache",
  "Expires": "0",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};
const ASSET_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
]);

function isLoopbackHost(host) {
  if (typeof host !== "string") return false;
  return /^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/i.test(host)
    || /^\[::1\](?::\d{1,5})?$/i.test(host);
}

function bodyResponse(response, status, body, contentType, head = false) {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(head ? undefined : body);
}

function jsonResponse(response, status, value, head = false) {
  const body = JSON.stringify(value);
  bodyResponse(response, status, body, "application/json; charset=utf-8", head);
}

function genericError(response, status, message, head = false) {
  jsonResponse(response, status, { error: message }, head);
}

function sameOriginExportRequest(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const host = String(request.headers.host ?? "").toLowerCase();
    return parsed.protocol === "http:" && isLoopbackHost(parsed.host) && parsed.host.toLowerCase() === host;
  } catch {
    return false;
  }
}

function isContained(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function assetPathFromRequest(pathname, rawPathname) {
  if (rawPathname.includes("%") || rawPathname.includes("\\") || pathname.includes("%") || pathname.includes("\\")) {
    return null;
  }
  const isIndex = pathname === "/" || pathname === "/index.html";
  const isDashboardAsset = pathname.startsWith("/dashboard/") && pathname !== "/dashboard/";
  if (!isIndex && !isDashboardAsset) return undefined;
  const relativePath = isIndex ? "index.html" : pathname.slice(1);
  const parts = relativePath.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || !/^[A-Za-z0-9._-]+$/.test(part))) return null;
  if (!ASSET_TYPES.has(extname(relativePath).toLowerCase())) return null;
  return relativePath;
}

async function readStaticAsset(staticRoot, pathname, rawPathname) {
  const relativePath = assetPathFromRequest(pathname, rawPathname);
  if (relativePath === undefined || relativePath === null) return null;
  try {
    const canonicalRoot = await realpath(resolve(staticRoot));
    const candidate = resolve(canonicalRoot, relativePath);
    if (!isContained(canonicalRoot, candidate)) return null;
    const canonicalCandidate = await realpath(candidate);
    if (!isContained(canonicalRoot, canonicalCandidate)) return null;
    const details = await stat(canonicalCandidate);
    if (!details.isFile()) return null;
    return {
      body: await readFile(canonicalCandidate),
      contentType: ASSET_TYPES.get(extname(relativePath).toLowerCase()),
    };
  } catch {
    return null;
  }
}

export function requestOptions(url) {
  const options = {};
  const range = url.searchParams.get("range");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const session = url.searchParams.get("session");
  const includeSessionTitles = url.searchParams.get("includeSessionTitles");
  const includeEnvironment = url.searchParams.get("includeEnvironment");
  if (range) options.range = range;
  if (from) options.from = from;
  if (to) options.to = to;
  if (session) options.session = session;
  if (includeSessionTitles === "1") options.includeSessionTitles = true;
  if (includeEnvironment === "1") options.includeEnvironment = true;
  return options;
}

export function createDashboardServer({ dbPath, staticRoot = DASHBOARD_DIR, inspectEnvironment = false, environmentOptions, environment } = {}) {
  let db;
  let cachedDataVersion;
  const metricsCache = new Map();

  const server = createServer(async (request, response) => {
    if (!isLoopbackHost(request.headers.host)) {
      return genericError(response, 403, "Loopback requests only");
    }

    const head = request.method === "HEAD";
    if (request.method !== "GET" && !head) {
      response.setHeader("Allow", "GET, HEAD");
      return genericError(response, 405, "GET or HEAD only");
    }

    let url;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      return genericError(response, 400, "Bad request");
    }

    if (url.pathname === "/health") {
      return jsonResponse(response, 200, { ok: true }, head);
    }

    if (url.pathname === "/api/metrics") {
      try {
        if (!db) db = openReadOnlyDatabase(resolveDatabasePath(dbPath));

        const options = {
          ...requestOptions(url),
          inspectEnvironment: inspectEnvironment === true,
          environmentOptions: environmentOptions ?? environment,
        };
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
          options.includeEnvironment === true,
        ]);
        const cached = metricsCache.get(cacheKey);
        if (cached !== undefined) return jsonResponse(response, 200, cached, head);

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
        return jsonResponse(response, 200, value, head);
      } catch {
        return genericError(response, 503, "Database unavailable", head);
      }
    }

    if (url.pathname === "/api/session-export") {
      if (!sameOriginExportRequest(request) || !isExportHeader(request.headers["x-opencode-export"])) {
        return genericError(response, 403, "Export confirmation required", head);
      }
      const roots = url.searchParams.getAll("root");
      if (roots.length !== 1 || !roots[0]) return genericError(response, 400, "Root selection required", head);
      const requestedRoot = roots[0];
      try {
        if (!db) db = openReadOnlyDatabase(resolveDatabasePath(dbPath));
        const value = buildSessionExport(db, requestedRoot);
        return jsonResponse(response, 200, value, head);
      } catch {
        return genericError(response, 400, "Session export unavailable", head);
      }
    }

    const rawPathname = (request.url ?? "/").split(/[?#]/, 1)[0];
    const asset = await readStaticAsset(staticRoot, url.pathname, rawPathname);
    if (asset) {
      return bodyResponse(response, 200, asset.body, asset.contentType, head);
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return genericError(response, 404, "Dashboard unavailable", head);
    }

    return genericError(response, 404, "Not found", head);
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
    else if (argument === "--inspect-environment") options.inspectEnvironment = true;
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
