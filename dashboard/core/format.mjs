const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const money = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });

export const hasValue = (value) => value !== null && value !== undefined && value !== "";

export const escapeHtml = (value) => String(value ?? "—").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));

export const numeric = (value) => {
  const result = Number(value);
  return hasValue(value) && Number.isFinite(result) ? result : null;
};

export const display = (value) => hasValue(value) && typeof value !== "object" ? String(value) : "—";
export const firstDefined = (...values) => values.find((value) => hasValue(value));
export const scalarValue = (...values) => values.find((value) =>
  (typeof value === "string" || typeof value === "number") && String(value).trim() !== "");
export const objectOrEmpty = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

export const fmt = (value) => {
  const result = numeric(value);
  return result === null ? "—" : number.format(result);
};

export const percent = (value) => {
  const result = numeric(value);
  return result === null ? "—" : `${fmt(result * 100)}%`;
};

export const moneyValue = (value) => {
  const result = numeric(value);
  return result === null ? "—" : `$${money.format(result)}`;
};

export const duration = (value) => {
  const result = numeric(value);
  if (result === null) return "—";
  const seconds = result / 1000;
  if (seconds < 60) return `${fmt(seconds)}s`;
  return `${fmt(seconds / 60)}m`;
};

export const cell = (value, className = "") =>
  `<td class="${escapeHtml(className)}">${escapeHtml(display(value))}</td>`;

export const fieldText = (value) => {
  if (!value || typeof value !== "object") return display(value);
  return display(firstDefined(value.name, value.label, value.url));
};

export const tokenValues = (source = {}) => {
  const record = objectOrEmpty(source);
  const tokens = objectOrEmpty(record.tokens);
  const pick = (...keys) => firstDefined(...keys.flatMap((key) => [record[key], tokens[key]]));
  return {
    input: pick("input", "inputTokens"),
    output: pick("output", "outputTokens"),
    reasoning: pick("reasoning", "reasoningTokens"),
    cacheRead: pick("cacheRead", "cache_read", "cacheR"),
    cacheWrite: pick("cacheWrite", "cache_write", "cacheW"),
    total: pick("total", "totalTokens"),
  };
};

export const estimatedUsdValue = (record, allowLegacy = false) => {
  const value = objectOrEmpty(record).estimatedCost;
  return firstDefined(
    value && typeof value === "object" ? value.usd : value,
    objectOrEmpty(record).estimatedUSD,
    allowLegacy ? objectOrEmpty(record).cost : undefined,
  );
};

export const formatDateTime = (value) => {
  if (!hasValue(value)) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? display(value) : date.toLocaleString();
};

export const cacheWriteText = (record, tokens = tokenValues(record)) => {
  const reporting = objectOrEmpty(objectOrEmpty(record).cacheWriteReporting);
  if (numeric(reporting.observed) === 0 || !hasValue(tokens.cacheWrite)) return "Not reported";
  return fmt(tokens.cacheWrite);
};
