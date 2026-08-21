const REDACTED_KEYS = new Set([
  "title", "sessionTitle", "environment", "env", "cwd", "directory", "home", "path",
]);

const cloneValue = (value) => {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

const redactValue = (value) => {
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !REDACTED_KEYS.has(key))
    .map(([key, entry]) => [key, redactValue(entry)]));
};

export const redactPayload = (payload) => redactValue(cloneValue(payload ?? {}));

export function createDashboardState(initial = {}) {
  const state = {
    range: initial.range || "24h",
    sessionScope: initial.sessionScope || "",
    titleOptIn: initial.titleOptIn === true,
    environmentOptIn: initial.environmentOptIn === true,
    currentPayload: null,
    previousPayload: null,
    savedRedactedBaseline: null,
  };

  const api = {
    get snapshot() {
      return cloneValue(state);
    },
    setRange(range) {
      state.range = range || state.range;
      return state.range;
    },
    setSessionScope(sessionScope) {
      state.sessionScope = sessionScope || "";
      return state.sessionScope;
    },
    setTitleOptIn(enabled) {
      state.titleOptIn = enabled === true;
      return state.titleOptIn;
    },
    setEnvironmentOptIn(enabled) {
      state.environmentOptIn = enabled === true;
      return state.environmentOptIn;
    },
    setPayload(payload) {
      state.previousPayload = state.currentPayload;
      state.currentPayload = payload && typeof payload === "object" ? payload : {};
      return state.currentPayload;
    },
    saveRedactedBaseline(payload = state.currentPayload) {
      state.savedRedactedBaseline = redactPayload(payload);
      return state.savedRedactedBaseline;
    },
    clearPayload() {
      state.previousPayload = state.currentPayload;
      state.currentPayload = null;
    },
  };
  return Object.freeze(api);
}
