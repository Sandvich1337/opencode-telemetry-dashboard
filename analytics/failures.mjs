import {
  deepFreeze,
  finiteNumber,
  makeAvailability,
  normalizeConfidence,
  normalizeSampleEvidence,
  rateWithEvidence,
} from "./contract.mjs";

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function number(value) {
  const result = finiteNumber(value);
  return result === null ? null : Math.max(0, result);
}

function valuesOf(snapshot) {
  return Array.isArray(snapshot?.runs) ? snapshot.runs : [];
}

function sample(count, observed, denominator = count) {
  return normalizeSampleEvidence({ count, observed, denominator });
}

function verdict(run) {
  const value = String(run?.reviewer?.verdict ?? "UNKNOWN").trim().toUpperCase();
  return value === "PASS" ? "PASS" : value === "ISSUE" || value === "FAIL" ? "ISSUE" : "UNKNOWN";
}

function callsOf(run) {
  return Array.isArray(run?.toolEvents)
    ? run.toolEvents.reduce((total, event) => total + (number(event?.count) ?? 0), 0)
    : 0;
}

function intervalKey(interval) {
  return `${interval?.start ?? "?"}:${interval?.end ?? "?"}`;
}

/** Errors are taken once from the normalized error stream; tool events are attribution only. */
function errorsOf(run) {
  const source = Array.isArray(run?.errors) && run.errors.length
    ? run.errors
    : Array.isArray(run?.toolEvents)
      ? run.toolEvents.filter((event) => event?.error).map((event) => ({
        kind: "error",
        count: event.count,
        interval: event.interval,
      }))
      : [];
  const seen = new Set();
  const result = [];
  for (const error of source) {
    const count = number(error?.count) ?? 0;
    const signature = `${String(error?.kind ?? "error")}:${intervalKey(error?.interval)}:${count}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    result.push({ count, interval: error?.interval });
  }
  return result;
}

function rate(numerator, denominator, evidence, reason) {
  const result = rateWithEvidence(numerator, denominator, {
    basis: "derived",
    reason,
    sample: evidence,
  });
  return {
    rate: result.rate,
    numerator,
    denominator,
    basis: result.basis,
    reason: result.reason,
    sample: result.sample,
    minimumSample: { required: 1, observed: denominator, met: denominator >= 1 },
  };
}

function aggregateHotspot(values, identity, totalRuns) {
  const calls = values.reduce((total, value) => total + value.calls, 0);
  const errors = values.reduce((total, value) => total + value.errors, 0);
  const runs = values.reduce((total, value) => total + value.runs, 0);
  const evidence = sample(runs, runs, totalRuns);
  const errorRate = rate(errors, calls, evidence, "recorded-tool-calls");
  return {
    ...identity,
    runs,
    calls,
    errors,
    numerator: errors,
    denominator: calls,
    rate: errorRate.rate,
    errorRate: errorRate.rate,
    sample: evidence,
    minimumSample: errorRate.minimumSample,
    errorRateEvidence: errorRate,
  };
}

function buildToolHotspots(runs, totalRuns) {
  const groups = new Map();
  for (const run of runs) {
    const seenInRun = new Set();
    for (const event of Array.isArray(run.toolEvents) ? run.toolEvents : []) {
      const tool = String(event?.tool ?? "unknown");
      if (!groups.has(tool)) groups.set(tool, { calls: 0, errors: 0, runCount: 0 });
      const group = groups.get(tool);
      group.calls += number(event?.count) ?? 0;
      group.errors += event?.error ? number(event?.count) ?? 0 : 0;
      if (!seenInRun.has(tool)) {
        group.runCount += 1;
        seenInRun.add(tool);
      }
    }
  }
  return [...groups.entries()]
    .map(([tool, group]) => aggregateHotspot([{ ...group, runs: group.runCount }], { tool }, totalRuns))
    .sort((left, right) => right.errors - left.errors || right.calls - left.calls || (left.tool < right.tool ? -1 : left.tool > right.tool ? 1 : 0));
}

function buildIdentityHotspots(runs, dimension, totalRuns) {
  const groups = new Map();
  for (const run of runs) {
    const identity = object(run.identity);
    const label = identity?.[dimension] === null || identity?.[dimension] === undefined || identity?.[dimension] === ""
      ? "unknown"
      : String(identity[dimension]);
    if (!groups.has(label)) groups.set(label, { calls: 0, errors: 0, runs: 0 });
    const group = groups.get(label);
    group.calls += callsOf(run);
    group.errors += errorsOf(run).reduce((total, error) => total + error.count, 0);
    if (callsOf(run) > 0 || group.errors > 0) group.runs += 1;
  }
  return [...groups.entries()]
    .filter(([, group]) => group.runs > 0)
    .map(([label, group]) => aggregateHotspot([{ ...group }], { [dimension]: label }, totalRuns))
    .sort((left, right) => right.errors - left.errors || right.calls - left.calls || (left[dimension] < right[dimension] ? -1 : left[dimension] > right[dimension] ? 1 : 0));
}

function orderedAfterError(run) {
  const events = (Array.isArray(run?.toolEvents) ? run.toolEvents : [])
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const leftStart = finiteNumber(left.event?.interval?.start) ?? Number.MAX_SAFE_INTEGER;
      const rightStart = finiteNumber(right.event?.interval?.start) ?? Number.MAX_SAFE_INTEGER;
      return leftStart - rightStart || left.index - right.index;
    })
    .map(({ event }) => event);
  const repeats = [];
  const eligible = [];
  for (let index = 0; index < events.length; index += 1) {
    const error = events[index];
    const errorStart = finiteNumber(error?.interval?.start);
    const errorEnd = finiteNumber(error?.interval?.end);
    const tool = String(error?.tool ?? "unknown");
    if (!error?.error || number(error?.count) !== 1) continue;
    if (errorStart === null || errorEnd === null || errorEnd <= errorStart) continue;
    eligible.push(tool);
    for (let nextIndex = index + 1; nextIndex < events.length; nextIndex += 1) {
      const next = events[nextIndex];
      if (String(next?.tool ?? "unknown") !== tool || number(next?.count) !== 1) continue;
      const nextStart = finiteNumber(next?.interval?.start);
      const nextEnd = finiteNumber(next?.interval?.end);
      if (nextStart === null || nextEnd === null || nextEnd <= nextStart || nextStart < errorEnd) continue;
      repeats.push(tool);
      break;
    }
  }
  return { repeats, eligible };
}

function repeatRows(runs, totalRuns) {
  const groups = new Map();
  let repeats = 0;
  let eligible = 0;
  for (const run of runs) {
    const identity = object(run.identity) ?? {};
    const agent = identity.agent === null || identity.agent === undefined || identity.agent === "" ? "unknown" : String(identity.agent);
    const model = identity.model === null || identity.model === undefined || identity.model === "" ? "unknown" : String(identity.model);
    const result = orderedAfterError(run);
    repeats += result.repeats.length;
    eligible += result.eligible.length;
    for (const tool of result.eligible) {
      const key = `${tool}\u0000${agent}\u0000${model}`;
      if (!groups.has(key)) groups.set(key, { tool, agent, model, repeats: 0, eligible: 0 });
      groups.get(key).eligible += 1;
    }
    for (const tool of result.repeats) {
      const key = `${tool}\u0000${agent}\u0000${model}`;
      if (!groups.has(key)) groups.set(key, { tool, agent, model, repeats: 0, eligible: 0 });
      groups.get(key).repeats += 1;
    }
  }
  const rows = [...groups.values()]
    .filter((group) => group.repeats > 0)
    .map((group) => {
      const evidence = sample(group.eligible, group.eligible, totalRuns);
      const repeatRate = rate(group.repeats, group.eligible, evidence, "ordered-recorded-events");
      return {
        label: "repeat-after-error",
        tool: group.tool,
        agent: group.agent,
        model: group.model,
        repeats: group.repeats,
        numerator: group.repeats,
        denominator: group.eligible,
        rate: repeatRate.rate,
        sample: evidence,
        minimumSample: repeatRate.minimumSample,
      };
    })
    .sort((left, right) => right.repeats - left.repeats || left.tool.localeCompare(right.tool) || left.agent.localeCompare(right.agent) || left.model.localeCompare(right.model));
  return {
    rows,
    evidence: rate(repeats, eligible, sample(eligible, eligible, totalRuns), "ordered-recorded-events"),
  };
}

export function analyzeFailures(snapshot = {}) {
  const runs = valuesOf(snapshot);
  const observedRuns = runs.filter((run) => (Array.isArray(run.toolEvents) && run.toolEvents.length > 0) || errorsOf(run).length > 0).length;
  const rootSample = sample(runs.length, observedRuns, runs.length);
  const calls = runs.reduce((total, run) => total + callsOf(run), 0);
  const errors = runs.reduce((total, run) => total + errorsOf(run).reduce((sum, error) => sum + error.count, 0), 0);
  const totalRate = rate(errors, calls, rootSample, "recorded-tool-calls");
  const repeats = repeatRows(runs, runs.length);
  const available = observedRuns > 0;
  const reason = available ? "recorded-error-or-tool-events" : runs.length ? "failure-events-missing" : "no-runs";
  const result = {
    availability: makeAvailability(available, { basis: available ? "observed" : "unavailable", reason, sample: rootSample }),
    sample: rootSample,
    confidence: normalizeConfidence(available ? 1 : null, { basis: available ? "derived" : "unavailable", reason, sample: rootSample }),
    provenance: { source: "normalized-snapshot", basis: "derived", sample: rootSample },
    reasons: [reason, repeats.evidence.reason].filter((value, index, list) => list.indexOf(value) === index).sort(),
    totals: { runs: runs.length, calls, errors, numerator: errors, denominator: calls, errorRate: totalRate.rate, errorRateEvidence: totalRate },
    toolHotspots: buildToolHotspots(runs, runs.length),
    agentHotspots: buildIdentityHotspots(runs, "agent", runs.length),
    modelHotspots: buildIdentityHotspots(runs, "model", runs.length),
    repeatAfterError: repeats.rows,
    repeatAfterErrorCount: repeats.evidence.numerator,
    repeatAfterErrorRate: repeats.evidence,
  };
  return deepFreeze(result);
}
