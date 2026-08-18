const MILLION = 1_000_000;

export const PRICING_DATE = "2026-08-17";
export const LONG_CONTEXT_THRESHOLD = 272_000;

function rates(input, cacheRead, cacheWrite, output) {
  return Object.freeze({ input, cacheRead, cacheWrite, output });
}

function modelRates(short, long, multiplier = 1) {
  return Object.freeze({
    short: rates(...short.map((value) => value * multiplier)),
    long: rates(...long.map((value) => value * multiplier)),
  });
}

const MODEL_RATES = Object.freeze({
  luna: {
    short: [0.2, 0.02, 0.25, 1.2],
    long: [0.4, 0.04, 0.5, 1.8],
  },
  terra: {
    short: [2, 0.2, 2.5, 12],
    long: [4, 0.4, 5, 18],
  },
  sol: {
    short: [5, 0.5, 6.25, 30],
    long: [10, 1, 12.5, 45],
  },
});

export const PRICING_CATALOG = Object.freeze({
  provider: "openai",
  source: "https://platform.openai.com/docs/pricing",
  currency: "USD",
  unit: "per-million-tokens",
  date: PRICING_DATE,
  longContextThreshold: LONG_CONTEXT_THRESHOLD,
  models: Object.freeze(Object.fromEntries(
    Object.entries(MODEL_RATES).flatMap(([model, values]) => [
      [model, modelRates(values.short, values.long)],
      [`${model}-fast`, modelRates(values.short, values.long, 2)],
    ]),
  )),
});

export const OPENAI_PRICING_CATALOG = PRICING_CATALOG;

function modelKey(model) {
  if (typeof model !== "string") return null;
  const value = model.trim().toLowerCase();
  const unqualified = value.startsWith("openai/") ? value.slice("openai/".length) : value;
  if (Object.hasOwn(PRICING_CATALOG.models, unqualified)) return unqualified;

  const alias = unqualified.match(/^gpt-5\.6-(luna|terra|sol)(-fast)?$/);
  if (alias) return `${alias[1]}${alias[2] ?? ""}`;
  const qualifiedAlias = value.match(/^[^/]+\/gpt-5\.6-(luna|terra|sol)(-fast)?$/);
  return qualifiedAlias ? `${qualifiedAlias[1]}${qualifiedAlias[2] ?? ""}` : null;
}

export function pricingForModel(model) {
  const key = modelKey(model);
  return key === null ? null : { model: key, ...PRICING_CATALOG.models[key] };
}

function nonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function estimateMessageCost(model, tokens, options = {}) {
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return null;
  const pricing = pricingForModel(model);
  if (!pricing) return null;

  const input = nonNegative(tokens.input);
  const cacheRead = nonNegative(tokens.cacheRead);
  const cacheWrite = nonNegative(tokens.cacheWrite);
  const output = nonNegative(tokens.output);
  const reasoning = nonNegative(tokens.reasoning);
  const requestedContext = options && typeof options === "object" ? options.context : null;
  const long = requestedContext === "long" || (requestedContext !== "short" &&
    input + cacheRead + cacheWrite > LONG_CONTEXT_THRESHOLD);
  const rate = pricing[long ? "long" : "short"];
  const components = {
    input: input * rate.input / MILLION,
    cacheRead: cacheRead * rate.cacheRead / MILLION,
    cacheWrite: cacheWrite * rate.cacheWrite / MILLION,
    output: (output + reasoning) * rate.output / MILLION,
  };
  return {
    model: pricing.model,
    context: long ? "long" : "short",
    usd: Object.values(components).reduce((total, value) => total + value, 0),
    components,
  };
}
