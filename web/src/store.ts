import { useSyncExternalStore } from "react";
import {
  AUDIO_BITRATES, AUDIO_FORMATS, DEFAULT_INSTANCE, DEFAULT_SETTINGS, HISTORY_KEY, HISTORY_LIMIT,
  LEGACY_HISTORY_KEYS, LEGACY_SETTINGS_KEYS, SETTINGS_KEY, VIDEO_QUALITIES, type Settings,
} from "./constants";

/* ------------------------------------------------------------------ */
/* a tiny store: plain state, a subscribe, and a hook                  */
/* ------------------------------------------------------------------ */

export interface Store<T> {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      const value = typeof next === "function" ? (next as (p: T) => T)(state) : next;
      if (Object.is(value, state)) return;
      state = value;
      listeners.forEach((l) => l());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useStore<T>(store: Store<T>): T;
export function useStore<T, S>(store: Store<T>, select: (s: T) => S): S;
export function useStore<T, S>(store: Store<T>, select?: (s: T) => S): T | S {
  const read = () => (select ? select(store.get()) : store.get());
  return useSyncExternalStore(store.subscribe, read, read);
}

/* ------------------------------------------------------------------ */
/* storage that never throws (private mode, blocked site data)         */
/* ------------------------------------------------------------------ */

export const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* full or blocked: settings simply do not persist */
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      /* nothing to do */
    }
  },
};

function migrateLegacy(fromKeys: string[], toKey: string): string | null {
  for (const key of fromKeys) {
    const value = storage.get(key);
    if (value) {
      storage.set(toKey, value);
      fromKeys.forEach((old) => storage.remove(old));
      return value;
    }
  }
  return null;
}

const clampIn = <T extends readonly string[]>(list: T, value: unknown, fallback: string) =>
  list.includes(String(value) as T[number]) ? String(value) : fallback;

export const clampQuality = (v: unknown) => clampIn(VIDEO_QUALITIES, v, "1080");
export const clampBitrate = (v: unknown) => clampIn(AUDIO_BITRATES, v, "128");
export const clampFormat = (v: unknown) => clampIn(AUDIO_FORMATS, v, "mp3");

/** read settings, running the same schema steps the old page ran */
export function loadSettings(): Settings {
  const raw = storage.get(SETTINGS_KEY) || migrateLegacy(LEGACY_SETTINGS_KEYS, SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_SETTINGS, instance: DEFAULT_INSTANCE };
  try {
    const parsed = JSON.parse(raw) as Partial<Settings> & Record<string, unknown>;
    const hadSchema = !!(parsed && typeof parsed === "object" && parsed.schema);
    const merged = { ...DEFAULT_SETTINGS, ...(parsed && typeof parsed === "object" ? parsed : {}) } as Settings & {
      downloadMode: string;
    };
    if (!merged.instance && DEFAULT_INSTANCE) merged.instance = DEFAULT_INSTANCE;
    if (!merged.schema || merged.schema < 2) {
      if (!merged.subtitleLang || merged.subtitleLang === "none") merged.subtitleLang = "en";
      merged.schema = 2;
    }
    if (hadSchema && merged.schema < 6) {
      if (merged.savingMethod === "ask") merged.savingMethod = "download";
      merged.schema = 6;
    }
    if (!merged.schema || merged.schema < 4) {
      if ((merged.downloadMode as string) === "mute") {
        merged.downloadMode = "video";
        merged.muteVideo = true;
      }
      merged.schema = 4;
    }
    if (!["auto", "audio", "video"].includes(merged.downloadMode)) merged.downloadMode = "auto";
    merged.muteVideo = !!merged.muteVideo;
    if (merged.schema < 3) {
      merged.youtubeBetterAudio = false;
      merged.youtubeHLS = false;
      merged.schema = 3;
    }
    merged.videoQuality = clampQuality(merged.videoQuality);
    merged.audioBitrate = clampBitrate(merged.audioBitrate);
    merged.audioFormat = clampFormat(merged.audioFormat);
    const c = Number(merged.concurrency);
    merged.concurrency = Number.isFinite(c) ? Math.min(5, Math.max(1, Math.round(c))) : 3;
    if (!["auto", "light", "dark"].includes(merged.theme)) merged.theme = "auto";
    if (!["ask", "download", "share", "copy"].includes(merged.savingMethod)) merged.savingMethod = "download";
    if (!merged.schema || merged.schema < 6) merged.schema = 6;
    storage.set(SETTINGS_KEY, JSON.stringify(merged));
    return merged as Settings;
  } catch {
    return { ...DEFAULT_SETTINGS, instance: DEFAULT_INSTANCE };
  }
}

export const settingsStore = createStore<Settings>(loadSettings());
settingsStore.subscribe(() => storage.set(SETTINGS_KEY, JSON.stringify(settingsStore.get())));

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  settingsStore.set((s) => (s[key] === value ? s : { ...s, [key]: value }));
}

function loadHistory(): string[] {
  const raw = storage.get(HISTORY_KEY) || migrateLegacy(LEGACY_HISTORY_KEYS, HISTORY_KEY);
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === "string").slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

export const historyStore = createStore<string[]>(loadHistory());
historyStore.subscribe(() => storage.set(HISTORY_KEY, JSON.stringify(historyStore.get())));

export function addHistory(url: string): void {
  historyStore.set((list) => [url, ...list.filter((u) => u !== url)].slice(0, HISTORY_LIMIT));
}

/* ------------------------------------------------------------------ */
/* what the connected server said about itself                         */
/* ------------------------------------------------------------------ */

export interface InstanceInfo {
  version?: string;
  url?: string;
  startTime?: string;
  services?: string[];
  probe?: boolean;
  board?: boolean;
  inbox?: boolean;
  streaming?: boolean;
  turnstileSitekey?: string | null;
  turnstileSiteKey?: string | null;
  apiKeyRequired?: boolean;
}

export type InstanceState = "unknown" | "checking" | "ok" | "warn" | "down" | "empty";

export interface InstanceView {
  state: InstanceState;
  info: InstanceInfo | null;
  limits: { maxHeight?: number; maxDuration?: number } | null;
  error: string;
  checkedAt: number;
}

export const instanceStore = createStore<InstanceView>({ state: "unknown", info: null, limits: null, error: "", checkedAt: 0 });

/* ------------------------------------------------------------------ */
/* page-level UI state                                                 */
/* ------------------------------------------------------------------ */

export type View = "download" | "remux" | "subs" | "clean" | "donate";
export type Panel = "none" | "queue" | "sources" | "health" | "tip";

export interface UIState {
  view: View;
  panel: Panel;
  settingsOpen: boolean;
  settingsSection: string;
  helpOpen: boolean;
}

export const uiStore = createStore<UIState>({
  view: "download",
  panel: "none",
  settingsOpen: false,
  settingsSection: "appearance",
  helpOpen: false,
});

export function setPanel(panel: Panel): void {
  uiStore.set((s) => ({ ...s, panel }));
}

export function togglePanel(panel: Panel): void {
  uiStore.set((s) => ({ ...s, panel: s.panel === panel ? "none" : panel }));
}

/* ------------------------------------------------------------------ */
/* toasts: at most three, a repeat extends the one already showing     */
/* ------------------------------------------------------------------ */

export type Tone = "info" | "ok" | "warn" | "err";
export interface ToastItem {
  id: number;
  text: string;
  tone: Tone;
  pulse: number;
  leaving: boolean;
}

export const toastStore = createStore<ToastItem[]>([]);
let toastSeq = 0;
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();

function dismissToast(id: number): void {
  toastStore.set((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
  setTimeout(() => toastStore.set((list) => list.filter((t) => t.id !== id)), 200);
  toastTimers.delete(id);
}

export function toast(text: string, tone: Tone = "info"): void {
  const life = tone === "err" ? 6000 : 3800;
  const list = toastStore.get();
  const last = list[list.length - 1];
  if (last && !last.leaving && last.text === text && last.tone === tone) {
    clearTimeout(toastTimers.get(last.id));
    toastTimers.set(last.id, setTimeout(() => dismissToast(last.id), life));
    toastStore.set(list.map((t) => (t.id === last.id ? { ...t, pulse: t.pulse + 1 } : t)));
    return;
  }
  const id = ++toastSeq;
  toastStore.set([...list.slice(-2), { id, text, tone, pulse: 0, leaving: false }]);
  toastTimers.set(id, setTimeout(() => dismissToast(id), life));
}

/* ------------------------------------------------------------------ */
/* the composer's text lives here so other parts can read and set it   */
/* ------------------------------------------------------------------ */

export interface ComposerState {
  text: string;
  busy: boolean;
  nudge: number;
  modePicked: boolean;
  autoAudio: boolean;
}

export const composerStore = createStore<ComposerState>({ text: "", busy: false, nudge: 0, modePicked: false, autoAudio: false });

let lastNudge = 0;
export function nudgeComposer(): void {
  const now = Date.now();
  if (now - lastNudge < 500) return;
  lastNudge = now;
  composerStore.set((s) => ({ ...s, nudge: s.nudge + 1 }));
}
