export type Auth = { apiKey: string; baseUrl?: string };

export type RenderItem =
  | { kind: "text"; text: string }
  | { kind: "pct"; pct: number; metric?: string }
  | { kind: "balance"; value: number; currency: string; metric?: string }
  | { kind: "annotation"; text: string };

export type FetchPayload = {
  kind: "balance" | "quota";
  items: RenderItem[];
  metrics: Record<string, number>;
  currency?: string;

  resetAt?: Record<string, number>;
};

export type Fetcher = (auth: Auth, signal: AbortSignal) => Promise<FetchPayload>;

const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 500;
const DEFAULT_BOOST_PERMILLE = 1000;

export class QuotaError extends Error {
  readonly category: string;
  readonly status?: number;

  constructor(category: string, status?: number) {
    super(category);
    this.name = "QuotaError";
    this.category = category;
    this.status = status !== undefined && Number.isFinite(status) ? status : undefined;
  }
}

export function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function requiredNumber(value: unknown, label: string): number {
  const n = finiteNumber(value);
  if (n === null) throw new Error(`invalid ${label}`);
  return n;
}

export function requiredPercent(value: unknown, label: string): number {
  const n = requiredNumber(value, label);
  if (n < 0 || n > 100) throw new Error(`invalid ${label}`);
  return n;
}

export function sanitizeMs(ms: unknown): number | null {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function formatRemaining(ms: unknown): string {
  const v = sanitizeMs(ms);
  if (v === null) return "";
  const totalMin = Math.floor(v / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

export function formatDays(ms: unknown): string {
  const v = sanitizeMs(ms);
  if (v === null) return "";
  const totalH = Math.floor(v / 3600000);
  const d = Math.floor(totalH / 24);
  const h = totalH % 24;
  return `${d}d${h}h`;
}

export function clampPct(pct: unknown): number {
  const n = Number(pct);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

export function usedPct(limit: unknown, remaining: unknown): number {
  const lim = Number(limit ?? 0);
  const rem = Number(remaining ?? 0);
  if (!Number.isFinite(lim) || !Number.isFinite(rem) || lim <= 0) return 0;
  return clampPct(((lim - rem) / lim) * 100);
}

export function tier(prefix: string, label: string, pct: number, reset: string): RenderItem[] {
  return [
    { kind: "text", text: prefix + label },
    { kind: "pct", pct, metric: label.trim() },
    { kind: "text", text: reset ? ` (${reset})` : "" },
  ];
}

export function resetAtFromISO(iso: string): number | null {
  const resetAt = new Date(iso).getTime();
  return Number.isFinite(resetAt) && resetAt > Date.now() ? resetAt : null;
}

export function formatResetFromISO(iso: string): string {
  const resetAt = resetAtFromISO(iso);
  if (resetAt === null) return "";
  const diff = resetAt - Date.now();
  return diff >= 24 * 3600000 ? formatDays(diff) : formatRemaining(diff);
}

export function bearerHeaders(apiKey: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, ...extra };
}

export function quotaUrl(customBaseUrl: string | undefined, defaultBaseUrl: string, path: string): string {
  const raw = customBaseUrl?.trim() || defaultBaseUrl;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new QuotaError("invalid_base_url");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    throw new QuotaError("insecure_base_url");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new QuotaError("unsafe_base_url");
  }
  const basePath = parsed.pathname.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${parsed.origin}${basePath}${suffix}`;
}

export function makeSignal(timeoutMs: number, external: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(timeoutMs), external]);
}

export async function jsonFetch<T = any>(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  const r = await fetch(url, {
    headers,
    signal: makeSignal(timeoutMs, signal),
    redirect: "error",
  });
  if (!r.ok) throw new QuotaError("http", r.status);
  const raw = await r.text();
  try {
    return JSON.parse(raw) as T;
  } catch {

    throw new QuotaError("invalid_json");
  }
}

export async function fetchWithRetry<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RETRY_COUNT; attempt++) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    try {
      return await fn();
    } catch (err) {
      if (signal.aborted) throw err instanceof Error ? err : new Error(String(err));
      lastErr = err;
      if (attempt < RETRY_COUNT - 1) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export const EXTERNAL_QUOTA_PROVIDERS: ReadonlySet<string> = new Set(["codex-account-pool"]);

export const PROVIDER_FETCHERS: Record<string, Fetcher> = {
  minimax: fetchMinimaxGlobal,
  "minimax-cn": fetchMinimaxCn,
  moonshotai: fetchMoonshotGlobal,
  "moonshotai-cn": fetchMoonshotCn,
  "kimi-coding": fetchKimi,
  zai: fetchZhipuBalance,
  "zai-coding-cn": fetchZhipuCoding,
  deepseek: fetchDeepseek,
  openrouter: fetchOpenrouter,
  "opencode-go": fetchOpencodeGo,
  "openai-codex": fetchOpenaiCodex,
};

export const UN_PROVIDERS: ReadonlySet<string> = new Set([
  "volcengine",
  "doubao",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "qwen-token-plan-individual",
  "xiaomi",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-sgp",
]);

export function normalizeProvider(provider: string | undefined): string | null {
  return provider ?? null;
}

export function isUnProvider(provider: string): boolean {
  return UN_PROVIDERS.has(provider) || (!EXTERNAL_QUOTA_PROVIDERS.has(provider) && !Object.hasOwn(PROVIDER_FETCHERS, provider));
}

export function isExternalQuotaProvider(provider: string): boolean {
  return EXTERNAL_QUOTA_PROVIDERS.has(provider);
}

export async function fetchProviderQuota(
  providerId: string,
  auth: Auth,
  signal: AbortSignal,
): Promise<FetchPayload | null> {

  if (isUnProvider(providerId)) return null;
  const fetcher = PROVIDER_FETCHERS[providerId];
  if (!fetcher) return null;
  return fetcher(auth, signal);
}

async function fetchMinimaxBase(auth: Auth, signal: AbortSignal, defaultBase: string): Promise<FetchPayload> {
  const url = quotaUrl(auth.baseUrl, defaultBase, "/v1/token_plan/remains");
  const j = await jsonFetch<any>(
    url,
    bearerHeaders(auth.apiKey, { "Content-Type": "application/json" }),
    15_000,
    signal,
  );
  const baseResp = j.base_resp;
  if (baseResp?.status_code !== undefined && baseResp.status_code !== 0) {
    throw new QuotaError("provider_rejected", finiteNumber(baseResp.status_code) ?? undefined);
  }
  const general = j.model_remains?.find((m: any) => m.model_name === "general");
  if (!general) throw new Error("general model not found");

  const fiveHourRemaining = requiredPercent(
    general.current_interval_remaining_percent,
    "MiniMax 5h remaining percent",
  );
  const fiveHourPct = 100 - fiveHourRemaining;
  const weeklyStatus = general.current_weekly_status;
  const weeklyRaw = general.current_weekly_remaining_percent;
  const weeklyRemaining = weeklyRaw === undefined || weeklyRaw === null
    ? null
    : requiredPercent(weeklyRaw, "MiniMax 7d remaining percent");

  const weeklyBoostRaw = general.weekly_boost_permille;
  const weeklyBoostPermille = weeklyBoostRaw === undefined || weeklyBoostRaw === null
    ? DEFAULT_BOOST_PERMILLE
    : requiredNumber(weeklyBoostRaw, "MiniMax weekly boost");
  if (weeklyBoostPermille < 0) throw new Error("invalid MiniMax weekly boost");
  const weeklyBoost = weeklyBoostPermille / 1000;
  const weeklyPct = weeklyRemaining === null ? 0 : (100 - weeklyRemaining) * weeklyBoost;
  const fiveHourResetMs = sanitizeMs(general.remains_time);
  const weeklyResetMs = sanitizeMs(general.weekly_remains_time);
  const fiveHourReset = fiveHourResetMs === null ? "" : formatRemaining(fiveHourResetMs);
  const weeklyReset = weeklyResetMs === null ? "" : formatDays(weeklyResetMs);
  const resetAt: Record<string, number> = {};
  if (fiveHourResetMs !== null) resetAt["5h"] = Date.now() + fiveHourResetMs;

  const items = tier("Usage: ", "5h ", fiveHourPct, fiveHourReset);
  const metrics: Record<string, number> = { "5h": fiveHourPct };
  if (weeklyStatus === 1 && weeklyRemaining !== null) {
    items.push(...tier(" / ", "7d ", weeklyPct, weeklyReset));
    metrics["7d"] = weeklyPct;
    if (weeklyResetMs !== null) resetAt["7d"] = Date.now() + weeklyResetMs;
  }
  return {
    kind: "quota",
    items,
    metrics,
    resetAt: Object.keys(resetAt).length > 0 ? resetAt : undefined,
  };
}

export async function fetchMinimaxGlobal(auth: Auth, signal: AbortSignal): Promise<FetchPayload> {
  return fetchMinimaxBase(auth, signal, "https://api.minimax.io");
}

export async function fetchMinimaxCn(auth: Auth, signal: AbortSignal): Promise<FetchPayload> {
  return fetchMinimaxBase(auth, signal, "https://api.minimaxi.com");
}

async function fetchMoonshotBase(auth: Auth, signal: AbortSignal, defaultBase: string, currency: string): Promise<FetchPayload> {
  const url = quotaUrl(auth.baseUrl, defaultBase, "/users/me/balance");
  const j = await jsonFetch<any>(url, bearerHeaders(auth.apiKey), 10_000, signal);
  const data = j?.data ?? j;
  const balance = requiredNumber(data.available_balance ?? data.balance, "Moonshot available balance");
  return {
    kind: "balance",
    items: [
      { kind: "text", text: "Balance: " },
      { kind: "balance", value: balance, currency, metric: "balance" },
    ],
    metrics: { balance },
    currency,
  };
}

export async function fetchMoonshotGlobal(auth: Auth, signal: AbortSignal): Promise<FetchPayload> {
  return fetchMoonshotBase(auth, signal, "https://api.moonshot.ai/v1", "$");
}

export async function fetchMoonshotCn(auth: Auth, signal: AbortSignal): Promise<FetchPayload> {
  return fetchMoonshotBase(auth, signal, "https://api.moonshot.cn/v1", "¥");
}

function kimiWindowPct(detail: { limit?: unknown; remaining?: unknown; used?: unknown }, label: string): number {
  const limit = requiredNumber(detail.limit, `Kimi ${label} limit`);
  if (limit <= 0) throw new Error(`invalid Kimi ${label} limit`);
  const remaining = finiteNumber(detail.remaining);
  if (remaining !== null) return usedPct(limit, remaining);
  const used = finiteNumber(detail.used);
  if (used !== null) return clampPct((used / limit) * 100);
  throw new Error(`no Kimi ${label} usage fields`);
}

export async function fetchKimi(auth: Auth, signal: AbortSignal): Promise<FetchPayload> {
  const url = quotaUrl(auth.baseUrl, "https://api.kimi.com/coding", "/v1/usages");
  const j = await jsonFetch<any>(url, bearerHeaders(auth.apiKey), 10_000, signal);

  const items: RenderItem[] = [];
  const metrics: Record<string, number> = {};
  const resetAt: Record<string, number> = {};

  const fiveHour = j.limits?.[0]?.detail;
  if (fiveHour) {
    const pct = kimiWindowPct(fiveHour, "5h");
    items.push(...tier("Usage: ", "5h ", pct, formatResetFromISO(fiveHour.resetTime ?? "")));
    metrics["5h"] = pct;
    const fiveHourResetAt = resetAtFromISO(fiveHour.resetTime ?? "");
    if (fiveHourResetAt !== null) resetAt["5h"] = fiveHourResetAt;
  }

  const weekly = j.usage;
  if (weekly) {
    const pct = kimiWindowPct(weekly, "7d");
    items.push(...tier(" / ", "7d ", pct, formatResetFromISO(weekly.resetTime ?? "")));
    metrics["7d"] = pct;
    const weeklyResetAt = resetAtFromISO(weekly.resetTime ?? "");
    if (weeklyResetAt !== null) resetAt["7d"] = weeklyResetAt;
  }
  if (items.length === 0) throw new Error("no quota data");
  return {
    kind: "quota",
    items,
    metrics,
    resetAt: Object.keys(resetAt).length > 0 ? resetAt : undefined,
  };
}

export async function fetchZhipuBalance(auth: Auth, signal: AbortSignal): Promise<FetchPayload> {
  const j = await jsonFetch<any>(
    "https://www.bigmodel.cn/api/biz/account/query-customer-account-report",
    { Authorization: auth.apiKey },
    10_000,
    signal,
  );
  if (j.code !== undefined && j.code !== 0 && j.code !== 200) {
    throw new QuotaError("provider_rejected", finiteNumber(j.code) ?? undefined);
  }
  const data = j.data;
  if (!data || typeof data !== "object") throw new Error("no Zhipu account data");

  const balance = requiredNumber(data.availableBalance ?? data.balance, "Zhipu available balance");
  return {
    kind: "balance",
    items: [
      { kind: "text", text: "Balance: " },
      { kind: "balance", value: balance, currency: "¥", metric: "balance" },
    ],
    metrics: { balance },
    currency: "¥",
  };
}

export async function fetchZhipuCoding(auth: Auth, signal: AbortSignal): Promise<FetchPayload> {
  const j = await jsonFetch<any>(
    "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
    { Authorization: auth.apiKey },
    10_000,
    signal,
  );
  if (j.code !== undefined && j.code !== 0 && j.code !== 200) {
    throw new QuotaError("provider_rejected", finiteNumber(j.code) ?? undefined);
  }
  const limits: any[] = j.data?.limits ?? j.data ?? [];
  if (!Array.isArray(limits) || limits.length === 0) throw new Error("no limits");
  const l = limits[0];
  const used = requiredNumber(l.usage ?? l.currentUsage ?? l.used, "Zhipu usage");
  const total = requiredNumber(l.quota ?? l.total, "Zhipu quota");
  if (total <= 0) throw new Error("invalid Zhipu quota");
  const pct = clampPct((used / total) * 100);
  return {
    kind: "quota",
    items: [
      { kind: "text", text: `Usage: ${used}/${total} (` },
      { kind: "pct", pct, metric: "used" },
      { kind: "text", text: ")" },
    ],
    metrics: { used: pct },
  };
}

export async function fetchDeepseek(auth: Auth, signal: AbortSignal): Promise<FetchPayload> {
  const j = await jsonFetch<any>(
    "https://api.deepseek.com/user/balance",
    bearerHeaders(auth.apiKey),
    10_000,
    signal,
  );
  const info = j.balance_infos?.[0];
  if (!info) throw new Error("no balance");
  const total = requiredNumber(info.total_balance, "DeepSeek balance");

  const cur = info.currency;
  const currency = cur === "USD" ? "$" : cur === "CNY" ? "¥" : String(cur ?? "?");
  return {
    kind: "balance",
    items: [
      { kind: "text", text: "Balance: " },
      { kind: "balance", value: total, currency, metric: "balance" },
    ],
    metrics: { balance: total },
    currency,
  };
}

export async function fetchOpenrouter(auth: Auth, signal: AbortSignal): Promise<FetchPayload> {
  const j = await jsonFetch<any>(
    "https://openrouter.ai/api/v1/credits",
    bearerHeaders(auth.apiKey),
    10_000,
    signal,
  );
  const credits = requiredNumber(j.data?.total_credits, "OpenRouter credits");
  const usage = requiredNumber(j.data?.total_usage, "OpenRouter usage");
  const remaining = credits - usage;
  return {
    kind: "balance",
    items: [
      { kind: "text", text: "Balance: " },
      { kind: "balance", value: remaining, currency: "$", metric: "balance" },
    ],
    metrics: { balance: remaining },
    currency: "$",
  };
}

export async function fetchOpencodeGo(auth: Auth, signal: AbortSignal): Promise<FetchPayload> {
  const j = await jsonFetch<any>(
    "https://opencode.ai/zen/go/v1/usage",
    bearerHeaders(auth.apiKey),
    10_000,
    signal,
  );

  const usageRoot = j?.usage && typeof j.usage === "object" && !Array.isArray(j.usage)
    ? j.usage
    : j?.data && typeof j.data === "object" && !Array.isArray(j.data)
      ? j.data
      : j;
  const windows = [
    { keys: ["rolling", "rollingUsage"], label: "5h ", longReset: false },
    { keys: ["weekly", "weeklyUsage"], label: "7d ", longReset: true },
    { keys: ["monthly", "monthlyUsage"], label: "mo ", longReset: true },
  ] as const;
  const items: RenderItem[] = [];
  const metrics: Record<string, number> = {};
  const resetAtByMetric: Record<string, number> = {};

  for (const [index, window] of windows.entries()) {
    const usage = window.keys
      .map((key) => usageRoot?.[key])
      .find((value) => value && typeof value === "object" && !Array.isArray(value));
    if (!usage) {
      throw new Error(`missing OpenCode Go ${window.keys[0]}`);
    }
    const status = usage.status ?? "ok";
    if (status !== "ok" && status !== "rate-limited") {
      throw new Error(`invalid OpenCode Go ${window.keys[0]} status`);
    }
    const pct = requiredPercent(
      usage.usagePercent ?? usage.percent ?? usage.percentage,
      `OpenCode Go ${window.keys[0]} usage percent`,
    );
    const resetsAt = usage.resetsAt;
    let resetAt: number | null = null;
    let reset = "";
    if (typeof resetsAt === "string") {
      const resetTime = new Date(resetsAt).getTime();
      if (Number.isNaN(resetTime)) throw new Error(`invalid OpenCode Go ${window.keys[0]} reset`);
      const remainingMs = resetTime - Date.now();
      if (remainingMs > 0) {
        resetAt = resetTime;
        reset = window.longReset ? formatDays(remainingMs) : formatRemaining(remainingMs);
      }
    } else if (usage.resetInSec === undefined && usage.resetSeconds === undefined) {
      throw new Error(`missing OpenCode Go ${window.keys[0]} reset`);
    } else {
      const resetMs = requiredNumber(
        usage.resetInSec ?? usage.resetSeconds,
        `OpenCode Go ${window.keys[0]} reset`,
      ) * 1000;
      if (resetMs > 0) {
        resetAt = Date.now() + resetMs;
        reset = window.longReset ? formatDays(resetMs) : formatRemaining(resetMs);
      }
    }
    items.push(...tier(index === 0 ? "Usage: " : " / ", window.label, pct, reset));
    metrics[window.label.trim()] = pct;
    if (resetAt !== null) resetAtByMetric[window.label.trim()] = resetAt;
  }

  return {
    kind: "quota",
    items,
    metrics,
    resetAt: Object.keys(resetAtByMetric).length > 0 ? resetAtByMetric : undefined,
  };
}

const CODEX_JWT_CLAIM_PATH = "https://api.openai.com/auth";
const CODEX_DEFAULT_BASE = "https://chatgpt.com/backend-api";

export function extractChatGptAccountId(token: string | undefined): string | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64").toString("utf8"));
    const accountId = payload?.[CODEX_JWT_CLAIM_PATH]?.chatgpt_account_id;
    return typeof accountId === "string" && accountId !== "" ? accountId : null;
  } catch {
    return null;
  }
}

function codexWindowLabel(windowSeconds: number | null): string {
  if (windowSeconds === null || !Number.isFinite(windowSeconds) || windowSeconds <= 0) return "5h ";
  if (windowSeconds >= 86_400) return `${Math.round(windowSeconds / 86_400)}d `;
  return `${Math.round(windowSeconds / 3_600)}h `;
}

export async function fetchOpenaiCodex(auth: Auth, signal: AbortSignal): Promise<FetchPayload> {
  const url = quotaUrl(auth.baseUrl, CODEX_DEFAULT_BASE, "/wham/usage");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.apiKey}`,
    Accept: "application/json",
  };
  const accountId = extractChatGptAccountId(auth.apiKey);
  if (accountId) headers["chatgpt-account-id"] = accountId;
  const j = await jsonFetch<any>(url, headers, 15_000, signal);

  const rateLimit = j?.rate_limit;
  if (!rateLimit || typeof rateLimit !== "object" || Array.isArray(rateLimit)) {
    throw new Error("no OpenAI Codex rate_limit");
  }
  const windows = [
    { key: "primary_window", defaultLabel: "5h " },
    { key: "secondary_window", defaultLabel: "7d " },
  ] as const;
  const items: RenderItem[] = [];
  const metrics: Record<string, number> = {};
  const resetAt: Record<string, number> = {};
  let pushed = 0;
  let planText = "";
  const planType = j?.plan_type;

  if (typeof planType === "string") {
    const safePlanType = planType.trim();
    if (/^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/.test(safePlanType)) {
      planText = ` (${safePlanType})`;
    }
  }

  for (const w of windows) {
    const win = rateLimit[w.key];
    if (!win || typeof win !== "object" || Array.isArray(win)) continue;
    const pct = requiredPercent(win.used_percent, `OpenAI Codex ${w.key} used_percent`);
    const seconds = finiteNumber(win.limit_window_seconds);
    const label = seconds !== null ? codexWindowLabel(seconds) : w.defaultLabel;
    const resetAtSec = finiteNumber(win.reset_at);
    const resetAfter = finiteNumber(win.reset_after_seconds);
    let resetAtMs: number | null = null;
    if (resetAtSec !== null && resetAtSec > 0) {
      const ms = resetAtSec * 1000;
      if (ms > Date.now()) resetAtMs = ms;
    }
    if (resetAtMs === null && resetAfter !== null && resetAfter > 0) resetAtMs = Date.now() + resetAfter * 1000;
    const reset = resetAtMs === null ? "" : seconds !== null && seconds >= 86_400
      ? formatDays(resetAtMs - Date.now())
      : formatRemaining(resetAtMs - Date.now());
    const metric = label.trim();
    items.push(...tier(items.length === 0 ? "Usage: " : " / ", label, pct, reset));
    metrics[metric] = pct;
    if (resetAtMs !== null) resetAt[metric] = resetAtMs;
    pushed++;
  }
  if (pushed === 0) throw new Error("no OpenAI Codex usage windows");
  if (planText) items.push({ kind: "text", text: planText });
  return {
    kind: "quota",
    items,
    metrics,
    resetAt: Object.keys(resetAt).length > 0 ? resetAt : undefined,
  };
}
