import { DEFAULT_INSTANCE } from "./constants";
import { clampBitrate, clampFormat, clampQuality, instanceStore, settingsStore, type InstanceInfo } from "./store";
import { hostOf, normalizeInstance } from "./util";

export function apiEndpoint(): string {
  const base = normalizeInstance(settingsStore.get().instance);
  return base ? base.replace(/\/+$/, "") + "/" : "";
}

export function authHeaders(): Record<string, string> {
  const key = String(settingsStore.get().apiKey || "").trim();
  return key ? { Authorization: "Api-Key " + key } : {};
}

export function usingDefaultInstance(): boolean {
  return normalizeInstance(settingsStore.get().instance) === normalizeInstance(DEFAULT_INSTANCE);
}

export function friendlyError(err: unknown): string {
  const message = err instanceof Error && err.message ? err.message : "Unknown error";
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
    return "The API didn't answer. Check the address in settings, then retry.";
  }
  return message;
}

export function formatUptime(startTime: string | number): string {
  // an ISO date, or epoch milliseconds as a number or a string of digits
  const start = typeof startTime === "number" ? startTime : /^\d+$/.test(startTime) ? Number(startTime) : Date.parse(startTime);
  const diff = Date.now() - start;
  if (!Number.isFinite(diff) || diff < 0) return "unknown";
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return days + "d " + (hours % 24) + "h";
  if (hours > 0) return hours + "h " + (minutes % 60) + "m";
  return Math.max(1, minutes) + "m";
}

/* ------------------------------------------------------------------ */
/* instance check: one quiet retry, then keep asking in the background */
/* ------------------------------------------------------------------ */

let seq = 0;
let fails = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

async function askInstance(base: string): Promise<{ cobalt?: InstanceInfo & { limits?: unknown }; limits?: InstanceView["limits"] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await fetch(base.replace(/\/+$/, "") + "/", {
      headers: { Accept: "application/json", ...authHeaders() },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`The API refused the request (HTTP ${res.status}). Add or check the API key in Settings → Server.`);
    }
    if (!res.ok) throw new Error(`The API answered HTTP ${res.status}.`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

type InstanceView = ReturnType<typeof instanceStore.get>;

export async function checkInstance(opts: { silent?: boolean } = {}): Promise<boolean> {
  const stamp = ++seq;
  const base = normalizeInstance(settingsStore.get().instance);
  clearTimeout(retryTimer);
  if (!base) {
    instanceStore.set({ state: "empty", info: null, limits: null, error: "", checkedAt: Date.now() });
    return false;
  }
  if (!opts.silent) instanceStore.set((s) => ({ ...s, state: "checking", error: "" }));
  try {
    let data;
    try {
      data = await askInstance(base);
    } catch {
      if (stamp !== seq) return false;
      // a deploy restarts the service for a second: one quiet retry
      await new Promise((r) => setTimeout(r, 900));
      data = await askInstance(base);
    }
    if (stamp !== seq) return false;
    const cobalt = (data && data.cobalt) || {};
    const info: InstanceInfo = {
      services: Array.isArray(cobalt.services) ? cobalt.services.filter((s) => typeof s === "string") : [],
      version: typeof cobalt.version === "string" ? cobalt.version : "",
      startTime: typeof cobalt.startTime === "string" ? cobalt.startTime : "",
      probe: cobalt.probe === true,
      board: cobalt.board === true,
      inbox: cobalt.inbox === true,
      streaming: cobalt.streaming === true,
      apiKeyRequired: cobalt.apiKeyRequired === true,
      turnstileSitekey: typeof (cobalt.turnstileSitekey || cobalt.turnstileSiteKey) === "string"
        ? (cobalt.turnstileSitekey || cobalt.turnstileSiteKey) : "",
    };
    fails = 0;
    const limits = data && typeof data.limits === "object" ? data.limits : null;
    instanceStore.set({ state: "ok", info, limits, error: "", checkedAt: Date.now() });
    recordHealth(true);
    return true;
  } catch (err) {
    if (stamp !== seq) return false;
    fails += 1;
    recordHealth(false);
    const message = err instanceof Error && err.name === "AbortError"
      ? "The API didn't answer within nine seconds."
      : friendlyError(err);
    // a visitor gets one silent miss before the page says anything
    instanceStore.set({ state: !opts.silent || fails >= 2 ? "down" : "warn", info: null, limits: null, error: message, checkedAt: Date.now() });
    if (fails <= 15) retryTimer = setTimeout(() => void checkInstance({ silent: true }), 20000);
    return false;
  }
}

export function instanceHost(): string {
  const base = normalizeInstance(settingsStore.get().instance);
  return hostOf(base) || base;
}

/* ------------------------------------------------------------------ */
/* the header's health strip remembers the last checks in this browser */
/* ------------------------------------------------------------------ */

const HEALTH_KEY = "mdown.uptime";
export interface HealthSample {
  t: number;
  ok: boolean;
}

export function readHealth(): HealthSample[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HEALTH_KEY) || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((x): x is HealthSample => !!x && typeof x.t === "number" && typeof x.ok === "boolean").slice(-48)
      : [];
  } catch {
    return [];
  }
}

function recordHealth(ok: boolean): void {
  const list = readHealth();
  list.push({ t: Date.now(), ok });
  try {
    localStorage.setItem(HEALTH_KEY, JSON.stringify(list.slice(-48)));
  } catch {
    /* no history then */
  }
}

/* ------------------------------------------------------------------ */
/* turnstile, only when the instance asks for it                       */
/* ------------------------------------------------------------------ */

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  execute(id: string): void;
  reset(id: string): void;
  ready?(cb: () => void): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let widget = "";
let token = "";

function loadTurnstile(): Promise<boolean> {
  if (window.turnstile) return Promise.resolve(true);
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
}

export async function getTurnstileToken(): Promise<string> {
  const key = instanceStore.get().info?.turnstileSitekey;
  if (!key) return "";
  try {
    if (!(await loadTurnstile()) || !window.turnstile) return "";
    const ts = window.turnstile;
    await new Promise<void>((resolve) => {
      let done = false;
      const ready = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      setTimeout(ready, 1500);
      if (typeof ts.ready === "function") ts.ready(ready);
      else ready();
    });
    if (!widget) {
      const holder = document.createElement("div");
      holder.id = "turnstile-holder";
      holder.style.cssText = "position:fixed;bottom:14px;right:14px;z-index:90;width:300px;height:70px;opacity:0;pointer-events:none";
      document.body.appendChild(holder);
      widget = ts.render(holder, {
        sitekey: key,
        appearance: "interaction-only",
        execution: "execute",
        callback: (t: string) => (token = t),
        "error-callback": () => (token = ""),
        "expired-callback": () => (token = ""),
      });
    }
    token = "";
    try {
      ts.execute(widget);
    } catch {
      /* waited on below */
    }
    for (let i = 0; i < 200 && !token; i++) await new Promise((r) => setTimeout(r, 50));
    const out = token;
    token = "";
    try {
      ts.reset(widget);
    } catch {
      /* fine */
    }
    return out;
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/* probe: what the file will be before it is fetched                   */
/* ------------------------------------------------------------------ */

export interface ProbeData {
  status: "ok";
  title?: string;
  uploader?: string;
  duration?: number;
  thumbnail?: string;
  estimate?: { bytes: number; height: number | null; exact: boolean };
  isLive?: boolean;
  isPlaylist?: boolean;
  tooLong?: boolean;
  service?: string;
}

const PROBE_CACHE = new Map<string, ProbeData>();
const PROBE_KEEP = 24;
const inflight = new Map<string, Promise<ProbeData | null>>();

export function probeKey(url: string, mode: string): string {
  const s = settingsStore.get();
  return [url, mode, s.videoQuality, s.audioFormat, s.audioBitrate].join("|");
}

export function probeSupported(): boolean {
  return !!(instanceStore.get().info?.probe && apiEndpoint());
}

export function readProbe(key: string): ProbeData | null {
  const hit = PROBE_CACHE.get(key);
  if (!hit) return null;
  PROBE_CACHE.delete(key);
  PROBE_CACHE.set(key, hit);
  return hit;
}

export class ProbeError extends Error {
  constructor(public status: number) {
    super("probe failed");
  }
}

export function fetchProbe(url: string, mode: string): Promise<ProbeData | null> {
  const key = probeKey(url, mode);
  const cached = readProbe(key);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(key);
  if (pending) return pending;
  const endpoint = apiEndpoint();
  if (!endpoint) return Promise.resolve(null);
  const s = settingsStore.get();
  const body = JSON.stringify({
    url,
    downloadMode: mode,
    videoQuality: clampQuality(s.videoQuality),
    audioFormat: clampFormat(s.audioFormat),
    audioBitrate: clampBitrate(s.audioBitrate),
  });
  const request = () =>
    fetch(endpoint + "probe", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...authHeaders() },
      body,
    });
  const job = (async () => {
    let res = await request();
    if (res.status === 403) {
      await new Promise((r) => setTimeout(r, 400));
      res = await request();
    }
    if (!res.ok) throw new ProbeError(res.status);
    const data = (await res.json()) as ProbeData;
    if (!data || data.status !== "ok") throw new ProbeError(422);
    PROBE_CACHE.set(key, data);
    while (PROBE_CACHE.size > PROBE_KEEP) PROBE_CACHE.delete(PROBE_CACHE.keys().next().value!);
    return data;
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}
