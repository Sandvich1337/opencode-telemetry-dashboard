import {
  deepFreeze,
  durationMs,
  finiteNumber,
  safeRate,
  timestampMs,
} from "./contract.mjs";

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;
export const FORTY_FIVE_DAYS_MS = 45 * DAY_MS;

export const BUCKET_WIDTHS_MS = Object.freeze({
  day: 15 * MINUTE_MS,
  week: HOUR_MS,
  month: DAY_MS,
  long: WEEK_MS,
});

const RANGE_DURATIONS = Object.freeze({ "24h": DAY_MS, "7d": WEEK_MS, "30d": 30 * DAY_MS });

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function read(value, keys) {
  const source = object(value);
  if (!source) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  }
  return undefined;
}

/** A deterministic range normalizer; relative ranges require an explicit now. */
export function normalizeRange(options = {}) {
  const source = object(options) ?? {};
  const requested = String(read(source, ["range"]) ?? "all").trim().toLowerCase();
  const now = timestampMs(read(source, ["now"]));
  let from = timestampMs(read(source, ["from", "start"]));
  let to = timestampMs(read(source, ["to", "end"]));
  const explicit = from !== null || to !== null;
  const knownDuration = RANGE_DURATIONS[requested];

  if (!explicit && knownDuration !== undefined && now !== null) {
    from = now - knownDuration;
    to = now;
  }
  if (from !== null && to !== null && to < from) [from, to] = [to, from];
  return deepFreeze({
    key: explicit ? "custom" : knownDuration === undefined ? "all" : requested,
    from,
    to,
    now,
  });
}

export function rangeDurationMs(range) {
  const source = object(range) ?? {};
  const explicit = durationMs(read(source, ["durationMs", "duration"]));
  if (explicit !== null) return explicit;
  const from = timestampMs(read(source, ["from", "start"]));
  const to = timestampMs(read(source, ["to", "end"]));
  return from === null || to === null || to < from ? null : to - from;
}

export function normalizeInterval(value) {
  const outer = object(value);
  const nested = outer && object(read(outer, ["interval"]));
  const source = Array.isArray(value)
    ? { start: value[0], end: value[1] }
    : nested ?? outer ?? {};
  const start = timestampMs(read(source, ["start", "from", "createdAt", "startedAt"]));
  let end = timestampMs(read(source, ["end", "to", "updatedAt", "endedAt"]));
  const duration = durationMs(read(source, ["durationMs", "duration"]));
  if (end === null && start !== null && duration !== null) end = start + duration;
  if (start === null || end === null || end < start) return null;
  return Object.freeze({ start, end, durationMs: end - start });
}

/** Clip one interval to an optional range. Invalid and reversed intervals fail closed. */
export function clampInterval(value, range = null) {
  const interval = normalizeInterval(value);
  if (!interval) return null;
  const source = object(range) ?? {};
  const from = timestampMs(read(source, ["from", "start"]));
  const to = timestampMs(read(source, ["to", "end"]));
  if (from !== null && to !== null && to < from) return null;
  const start = from === null ? interval.start : Math.max(interval.start, from);
  const end = to === null ? interval.end : Math.min(interval.end, to);
  if (end < start) return null;
  return Object.freeze({ start, end, durationMs: end - start });
}

export function clampRange(first, second = null) {
  const firstObject = object(first);
  const firstLooksLikeRange = firstObject && (read(firstObject, ["from"]) !== undefined || read(firstObject, ["to"]) !== undefined) &&
    read(firstObject, ["start"]) === undefined && read(firstObject, ["end"]) === undefined;
  return firstLooksLikeRange ? clampInterval(second, first) : clampInterval(first, second);
}

export const clampIntervalToRange = clampInterval;

export function clampIntervals(values, range = null) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => clampInterval(value, range)).filter(Boolean);
}

/** Return the positive union, merging overlap, nesting, and adjacency. */
export function positiveIntervalUnion(values, range = null) {
  const intervals = clampIntervals(values, range)
    .filter((interval) => interval.end > interval.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const result = [];
  for (const interval of intervals) {
    const previous = result[result.length - 1];
    if (!previous || interval.start > previous.end) {
      result.push({ ...interval });
    } else if (interval.end > previous.end) {
      previous.end = interval.end;
      previous.durationMs = previous.end - previous.start;
    }
  }
  return result.map((interval) => Object.freeze(interval));
}

export const intervalUnion = positiveIntervalUnion;

export function unionDurationMs(values, range = null) {
  return positiveIntervalUnion(values, range).reduce((total, interval) => total + interval.durationMs, 0);
}

export const activeWallMs = unionDurationMs;

export function summedWorkMs(values, range = null) {
  if (!Array.isArray(values)) return 0;
  return values.reduce((total, value) => total + (clampInterval(value, range)?.durationMs ?? 0), 0);
}

export const summedWork = summedWorkMs;

export function parallelism(values, range = null) {
  return safeRate(summedWorkMs(values, range), unionDurationMs(values, range));
}

export function timingSummary(values, range = null) {
  const workMs = summedWorkMs(values, range);
  const wallMs = unionDurationMs(values, range);
  return deepFreeze({ workMs, activeWallMs: wallMs, parallelism: safeRate(workMs, wallMs) });
}

function agentOf(value) {
  const source = object(value);
  const identity = object(read(source, ["identity"]));
  const agent = read(source, ["agent", "agentId", "agentAlias"]) ?? read(identity, ["agent"]);
  return agent === null || agent === undefined || agent === "" ? "unknown" : String(agent);
}

/**
 * Union intervals independently for each agent. The array form avoids relying
 * on object insertion order and is stable for analyzers and tests.
 */
export function perAgentUnion(values, range = null) {
  const groups = new Map();
  if (Array.isArray(values)) {
    for (const value of values) {
      const interval = value?.interval ?? value;
      const normalized = clampInterval(interval, range);
      if (!normalized || normalized.end <= normalized.start) continue;
      const agent = agentOf(value);
      if (!groups.has(agent)) groups.set(agent, []);
      groups.get(agent).push(normalized);
    }
  }
  return [...groups.keys()].sort((left, right) => left.localeCompare(right)).map((agent) => {
    const intervals = positiveIntervalUnion(groups.get(agent));
    return Object.freeze({ agent, intervals, activeWallMs: unionDurationMs(intervals) });
  });
}

export const unionIntervalsByAgent = perAgentUnion;
export const unionByAgent = perAgentUnion;

export function bucketWidthMsForRange(rangeOrDuration) {
  const duration = typeof rangeOrDuration === "number"
    ? durationMs(rangeOrDuration)
    : rangeDurationMs(rangeOrDuration);
  if (duration !== null && duration <= DAY_MS) return BUCKET_WIDTHS_MS.day;
  if (duration !== null && duration <= WEEK_MS) return BUCKET_WIDTHS_MS.week;
  if (duration !== null && duration <= FORTY_FIVE_DAYS_MS) return BUCKET_WIDTHS_MS.month;
  return BUCKET_WIDTHS_MS.long;
}

export const bucketWidthMs = bucketWidthMsForRange;

export function bucketIntervals(range, widthMs = null) {
  const normalized = normalizeRange(range);
  if (normalized.from === null || normalized.to === null || normalized.to <= normalized.from) return [];
  const width = durationMs(widthMs) ?? bucketWidthMsForRange(normalized);
  if (width === null || width <= 0) return [];
  const buckets = [];
  for (let start = normalized.from; start < normalized.to; start += width) {
    const end = Math.min(normalized.to, start + width);
    buckets.push(Object.freeze({ start, end, durationMs: end - start }));
  }
  return buckets;
}
