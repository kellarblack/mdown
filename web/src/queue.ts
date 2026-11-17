import { apiEndpoint, authHeaders, fetchProbe, friendlyError, getTurnstileToken, probeKey, probeSupported, readProbe, type ProbeData } from "./api";
import {
  AUDIO_FIRST, DRM_SERVICES, ERROR_TEXT, LARGE_FILE_BYTES, MAX_CONCURRENT, MAX_URLS_PER_SUBMIT, MUSIC_FIRST, XL_BYTES,
} from "./constants";
import {
  addHistory, clampBitrate, clampFormat, clampQuality, composerStore, createStore, instanceStore, nudgeComposer,
  settingsStore, toast,
} from "./store";
import {
  copyText, detectService, filenameFromDisposition, formatBytes, hostOf, IS_IOS, IS_TOUCH, parseUrls, resolveUrl,
  safeFilename, safeImageUrl, SAVED_WHERE,
} from "./util";

export type ItemStatus = "queued" | "working" | "downloading" | "ready" | "done" | "error" | "cancelled" | "picker" | "local";
export type ItemMode = "auto" | "audio" | "mute";

export interface PickerEntry {
  type?: string;
  url: string;
  thumb?: string;
  name?: string;
}

export interface QueueItem {
  id: string;
  url: string;
  direct: boolean;
  directUrl: string;
  service: string;
  host: string;
  mode: ItemMode;
  status: ItemStatus;
  detail: string;
  filename: string;
  indeterminate: boolean;
  size: number;
  received: number;
  speed: number;
  error: string;
  /** the API's short id for this failure, so a report can quote one string */
  ref: string;
  sourceUrl: string;
  blobUrl: string;
  blob: Blob | null;
  controller: AbortController | null;
  running: boolean;
  started: number;
  thumb: string;
  estimate: ProbeData["estimate"] | null;
  previewTitle: string;
  duration: number;
  picker?: { entries: PickerEntry[]; audio?: string; audioFilename?: string };
  local?: { tunnels: string[]; type: string; command: string };
  saving?: boolean;
  sharing?: boolean;
  fresh: number;
}

export interface QueueState {
  items: QueueItem[];
  v: number;
}

export const queueStore = createStore<QueueState>({ items: [], v: 0 });

/* modal requests: the Modal component renders whichever is set */
export type ModalSpec =
  | { kind: "confirm"; entries: { title: string; bytes: number }[]; resolve: (ok: boolean) => void }
  | { kind: "picker"; itemId: string }
  | { kind: "local"; itemId: string }
  | { kind: "report"; service: string };

export const modalStore = createStore<ModalSpec | null>(null);

let idCounter = 0;
let active = 0;
let rateRemaining: number | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

/* one repaint per frame, however many bytes arrive */
let frame = 0;
function bump(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    queueStore.set((s) => ({ items: s.items, v: s.v + 1 }));
    ensureTicker();
  });
}
function bumpNow(): void {
  if (frame) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
  queueStore.set((s) => ({ items: s.items, v: s.v + 1 }));
  ensureTicker();
}

/* elapsed seconds on a working row keep counting with nothing arriving */
function ensureTicker(): void {
  const live = queueStore.get().items.some((i) => i.status === "working" || i.status === "downloading");
  if (live && !ticker) ticker = setInterval(bump, 1000);
  else if (!live && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

export function getItem(id: string): QueueItem | undefined {
  return queueStore.get().items.find((i) => i.id === id);
}

function setStatus(item: QueueItem, status: ItemStatus, detail?: string): void {
  item.status = status;
  if (detail != null) item.detail = detail;
  bumpNow();
}

/* ------------------------------------------------------------------ */
/* what is asked for                                                    */
/* ------------------------------------------------------------------ */

export function effectiveMode(url: string, mode?: string): ItemMode {
  const s = settingsStore.get();
  const wanted = mode || s.downloadMode;
  if (wanted === "audio") return "audio";
  if (wanted === "mute") return "mute";
  const detected = detectService(url);
  if (wanted === "auto" && detected?.id && MUSIC_FIRST.has(detected.id)) return "audio";
  return s.muteVideo ? "mute" : "auto";
}

export function buildBody(url: string, mode: ItemMode): Record<string, unknown> {
  const s = settingsStore.get();
  const body: Record<string, unknown> = {
    url,
    downloadMode: mode,
    videoQuality: clampQuality(s.videoQuality),
    audioFormat: clampFormat(s.audioFormat),
    audioBitrate: clampBitrate(s.audioBitrate),
    audioCovers: s.audioCovers !== false,
    filenameStyle: s.filenameStyle,
    disableMetadata: !!s.disableMetadata,
    alwaysProxy: !!s.alwaysProxy,
    localProcessing: s.localProcessing,
    youtubeVideoCodec: s.youtubeVideoCodec,
    youtubeVideoContainer: s.youtubeVideoContainer,
    convertGif: !!s.convertGif,
    allowH265: !!s.allowH265,
    tiktokFullAudio: !!s.tiktokFullAudio,
  };
  if (s.subtitleLang && s.subtitleLang !== "none") body.subtitleLang = s.subtitleLang;
  if (s.youtubeDubLang && s.youtubeDubLang !== "original") body.youtubeDubLang = s.youtubeDubLang;
  return body;
}

export function audioExt(): string {
  const f = settingsStore.get().audioFormat;
  return f === "best" ? "m4a" : f;
}

function guessFilename(url: string, mode: ItemMode): string {
  const host = hostOf(url) || "download";
  return mode === "audio" ? host + "." + audioExt() : host + ".mp4";
}

/* ------------------------------------------------------------------ */
/* queue model                                                          */
/* ------------------------------------------------------------------ */

function attachProbe(item: QueueItem, data: ProbeData): void {
  item.thumb = safeImageUrl(data.thumbnail || "", apiEndpoint());
  item.estimate = data.estimate || null;
  item.previewTitle = data.title || "";
  item.duration = data.duration || 0;
  bump();
}

export function enqueue(url: string, mode?: string): QueueItem {
  const detected = detectService(url);
  const item: QueueItem = {
    id: "q" + ++idCounter,
    url,
    direct: false,
    directUrl: "",
    service: detected?.id || detected?.host || "link",
    host: detected ? detected.host : hostOf(url),
    mode: effectiveMode(url, mode),
    status: "queued",
    detail: "queued",
    filename: "",
    indeterminate: true,
    size: 0,
    received: 0,
    speed: 0,
    error: "",
    ref: "",
    sourceUrl: "",
    blobUrl: "",
    blob: null,
    controller: null,
    running: false,
    started: 0,
    thumb: "",
    estimate: null,
    previewTitle: "",
    duration: 0,
    fresh: Date.now(),
  };
  queueStore.set((s) => ({ items: [...s.items, item], v: s.v + 1 }));
  const probed = readProbe(probeKey(item.url, item.mode));
  if (probed) attachProbe(item, probed);
  else if (probeSupported()) {
    fetchProbe(item.url, item.mode)
      .then((data) => {
        if (data && getItem(item.id)) attachProbe(item, data);
      })
      .catch(() => {});
  }
  return item;
}

/** a file that already is a tunnel or media URL: never POSTed back */
function enqueueDirect(url: string, filename: string, parent?: QueueItem): QueueItem {
  const item = enqueue(url);
  item.direct = true;
  item.directUrl = url;
  item.filename = filename || "";
  if (parent) {
    item.url = parent.url;
    item.service = parent.service;
    item.host = parent.host;
    item.mode = parent.mode;
  }
  return item;
}

/* ------------------------------------------------------------------ */
/* submit                                                               */
/* ------------------------------------------------------------------ */

const recentSubmits = new Map<string, number>();
const pendingSubmits = new Set<string>();

function admitSubmit(url: string): boolean {
  const now = Date.now();
  for (const [key, at] of recentSubmits) if (now - at > 4000) recentSubmits.delete(key);
  if (now - (recentSubmits.get(url) || 0) < 1500) return false;
  recentSubmits.set(url, now);
  return true;
}

function confirmLarge(entries: { title: string; bytes: number }[]): Promise<boolean> {
  return new Promise((resolve) => modalStore.set({ kind: "confirm", entries, resolve }));
}

export async function submitUrls(text: string, mode?: string): Promise<void> {
  const urls = parseUrls(text);
  if (!urls.length) {
    toast(text.trim() ? "That doesn't look like a link." : "Paste a link first.", "warn");
    nudgeComposer();
    return;
  }
  if (!apiEndpoint()) {
    toast("Connect a server first.", "warn");
    nudgeComposer();
    return;
  }
  const usable = urls.filter((url) => {
    const id = detectService(url)?.id;
    if (id && DRM_SERVICES.has(id)) {
      toast(DRM_SERVICES.get(id)!, "warn");
      return false;
    }
    return true;
  });
  const living = (url: string) =>
    queueStore.get().items.some((i) => i.url === url && ["queued", "working", "downloading"].includes(i.status));
  const fresh = usable.filter((url) => !pendingSubmits.has(url) && !living(url) && admitSubmit(url));
  if (!fresh.length) {
    if (usable.length) {
      toast(usable.some((u) => pendingSubmits.has(u)) ? "Already starting. One second." : "Already queued. Wait for it to finish.", "warn");
      nudgeComposer();
    }
    return;
  }
  const batch = fresh.slice(0, MAX_URLS_PER_SUBMIT);
  fresh.forEach((u) => pendingSubmits.add(u));
  composerStore.set((s) => ({ ...s, busy: true }));
  try {
    const big: { title: string; bytes: number }[] = [];
    for (const url of batch) {
      const known = readProbe(probeKey(url, effectiveMode(url, mode)));
      if (known?.estimate && known.estimate.bytes >= XL_BYTES) big.push({ title: known.title || "", bytes: known.estimate.bytes });
    }
    if (!big.length && batch.length === 1 && probeSupported()) {
      const data = await fetchProbe(batch[0]!, effectiveMode(batch[0]!, mode)).catch(() => null);
      if (data?.estimate && data.estimate.bytes >= XL_BYTES) big.push({ title: data.title || "", bytes: data.estimate.bytes });
    }
    if (big.length && !(await confirmLarge(big))) return;
    batch.forEach((url) => {
      enqueue(url, mode);
      addHistory(url);
    });
    if (fresh.length > batch.length) toast("Only the first " + batch.length + " links were queued.", "warn");
    composerStore.set((s) => ({ ...s, text: "" }));
    if (IS_TOUCH && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    pump();
  } finally {
    fresh.forEach((u) => pendingSubmits.delete(u));
    composerStore.set((s) => ({ ...s, busy: false }));
  }
}

/* ------------------------------------------------------------------ */
/* network                                                              */
/* ------------------------------------------------------------------ */

export function pump(): void {
  const limit = Math.max(1, Math.min(MAX_CONCURRENT, Number(settingsStore.get().concurrency) || 3));
  for (const item of queueStore.get().items) {
    if (active >= limit) return;
    if (item.status === "queued" && !item.running) {
      item.running = true;
      active++;
      void runItem(item).finally(() => {
        active--;
        item.running = false;
        pump();
      });
    }
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException ? err.name === "AbortError" : (err as Error | null)?.name === "AbortError";
}

async function runItem(item: QueueItem): Promise<void> {
  const controller = new AbortController();
  item.controller = controller;
  item.indeterminate = true;
  if (!item.started) item.started = Date.now();
  try {
    if (item.direct) {
      setStatus(item, "working", "starting transfer");
      await downloadTunnel(item, item.directUrl, item.filename || guessFilename(item.url, item.mode));
      return;
    }
    setStatus(item, "working", "requesting");
    const token = await getTurnstileToken();
    const payload = buildBody(item.url, item.mode);
    if (token) payload.turnstileToken = token;
    const res = await fetch(apiEndpoint(), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const remaining = res.headers.get("ratelimit-remaining");
    if (remaining) {
      const n = Number(remaining);
      if (!Number.isNaN(n)) rateRemaining = n;
    }
    const text = await res.text();
    let data: Record<string, any> | null = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok && !data) throw new Error(`The API answered HTTP ${res.status} without a body.`);
    if (!data || typeof data !== "object") throw new Error("Unexpected response from the API.");
    if (data.status === "error") {
      handleApiError(item, data.error?.code || "", data.error?.context, data.error?.ref);
      return;
    }
    switch (data.status) {
      case "tunnel":
      case "redirect": {
        const filename = safeFilename(data.filename, guessFilename(item.url, item.mode));
        const source = resolveUrl(data.url, apiEndpoint());
        if (!source) {
          item.error = "The server sent a link this page will not open.";
          setStatus(item, "error", "failed");
          return;
        }
        item.filename = filename;
        item.sourceUrl = source;
        if (typeof data.size === "number" && data.size > 0 && !item.estimate) {
          item.estimate = { bytes: data.size, height: null, exact: data.exact === true };
        }
        if (data.status === "redirect" || settingsStore.get().savingMethod === "copy") {
          item.indeterminate = false;
          setStatus(item, "ready", data.status === "redirect" ? "direct link" : "link ready");
          await afterReady(item, null);
          return;
        }
        await downloadTunnel(item, source, filename);
        return;
      }
      case "picker":
        handlePicker(item, data);
        return;
      case "local-processing":
        handleLocalProcessing(item, data);
        return;
      default:
        throw new Error("Unrecognised status: " + String(data.status));
    }
  } catch (err) {
    if (isAbort(err)) setStatus(item, "cancelled", "cancelled");
    else {
      item.error = friendlyError(err);
      setStatus(item, "error", "failed");
    }
  } finally {
    item.controller = null;
  }
}

function handleApiError(item: QueueItem, code: string, context?: Record<string, unknown>, ref?: string): void {
  let text = ERROR_TEXT[code] ||
    (code ? code.replace(/^api\./, "").replace(/\./g, " ").replace(/^./, (c) => c.toUpperCase()) : "The instance returned an error.");
  if (context?.service && context.service !== item.service) text += " (" + String(context.service) + ")";
  if (context?.limit) {
    const seconds = Number(context.limit);
    if (/too_long/.test(code) && Number.isFinite(seconds) && seconds >= 60) {
      text = "Longer than the " + Math.round(seconds / 60) + "-minute limit on this instance.";
    } else text += " Limit: " + String(context.limit) + ".";
  }
  if (code === "api.content.video.unavailable") {
    /* the job decides the wording, not the service: youtube is audio-first by
       default, so a youtube *video* failure was being told it might be Go+ */
    const audioWanted = item.mode === "audio";
    text = audioWanted
      ? "This track isn't available to the API. It may be private, region-locked, Go+ only, or the uploader turned off app playback."
      : "This video isn't available. It may be private, region-locked or age-gated.";
  }
  if (code === "api.instance.not_ready" && context?.reason === "disk") text = "This instance is out of disk space. Try again later.";
  if (code === "api.rate_limit") {
    const reason = String(context?.reason || "");
    if (reason === "daily_cap") text = "This instance has hit its daily download limit. Try again tomorrow.";
    else if (reason === "too_many_downloads") text = "That's a lot of downloads in a row. Give it a minute and retry.";
    else if (reason === "queue_full") text = "The queue is full right now. Try again in a moment.";
    else if (rateRemaining != null) text += " Remaining: " + rateRemaining + ".";
  }
  /* the id goes on the row, not in the toast: it is for the person pasting it
     into a message later, and a toast is gone before they can select it */
  item.ref = ref || "";
  item.error = ref ? text + " · ref " + ref : text;
  setStatus(item, "error", "failed");
  toast(text, "err");
}

async function downloadTunnel(item: QueueItem, url: string, filename: string): Promise<void> {
  item.indeterminate = true;
  item.received = 0;
  item.size = 0;
  item.speed = 0;
  setStatus(item, "downloading", "connecting");
  const controller = item.controller || new AbortController();
  item.controller = controller;
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (isAbort(err)) throw err;
    item.sourceUrl = url;
    item.filename = filename;
    setStatus(item, "ready", "direct link (open manually)");
    return;
  }
  if (!res.ok) {
    // the tunnel answers JSON errors with a cobalt code: show the real reason
    let code = "";
    try {
      code = ((await res.json()) as { error?: { code?: string } })?.error?.code || "";
    } catch {
      code = "";
    }
    if (code) {
      handleApiError(item, code);
      return;
    }
    item.sourceUrl = url;
    item.filename = filename;
    setStatus(item, "ready", "direct link (HTTP " + res.status + ")");
    return;
  }
  const exact = Number(res.headers.get("content-length") || 0);
  const estimated = Number(res.headers.get("estimated-content-length") || 0);
  item.size = exact > 0 ? exact : estimated > 0 ? estimated : item.estimate?.bytes || 0;
  const sizeIsExact = exact > 0;
  item.indeterminate = !item.size;
  const named = safeFilename(filenameFromDisposition(res.headers.get("content-disposition") || ""), "") || filename;
  setStatus(item, "downloading", "downloading");

  const handOff = async (note: string) => {
    try {
      await res.body?.cancel();
    } catch {
      /* the browser owns the file from here */
    }
    item.sourceUrl = url;
    item.filename = named;
    item.received = 0;
    handOffToBrowser(item, note);
  };
  // iOS keeps a blob in memory and never reaches Files: Safari's own download
  // manager takes the tunnel instead
  if (IS_IOS && settingsStore.get().savingMethod === "download") return handOff("Safari is saving it");
  if (item.size > LARGE_FILE_BYTES) return handOff("large file (" + formatBytes(item.size) + ")");

  const chunks: Uint8Array[] = [];
  let lastTime = performance.now();
  let lastBytes = 0;
  try {
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        if (!step.value) continue;
        chunks.push(step.value);
        item.received += step.value.length;
        if (!sizeIsExact && item.received > item.size) item.size = Math.round(item.received * 1.08);
        if (item.received > LARGE_FILE_BYTES) {
          chunks.length = 0;
          try {
            await reader.cancel();
          } catch {
            /* gone */
          }
          item.sourceUrl = url;
          item.filename = named;
          item.size = item.received;
          handOffToBrowser(item, "large file (over " + formatBytes(LARGE_FILE_BYTES) + ")");
          return;
        }
        const now = performance.now();
        const seconds = (now - lastTime) / 1000;
        if (seconds > 0.35) {
          const instant = (item.received - lastBytes) / seconds;
          item.speed = item.speed ? item.speed * 0.55 + instant * 0.45 : instant;
          lastTime = now;
          lastBytes = item.received;
        }
        bump();
      }
    } else {
      const buffer = new Uint8Array(await res.arrayBuffer());
      chunks.push(buffer);
      item.received = buffer.byteLength;
    }
  } catch (err) {
    if (isAbort(err)) throw err;
    item.sourceUrl = url;
    item.filename = named;
    item.error = "The transfer was interrupted. Retry, or open the link.";
    setStatus(item, "error", "interrupted");
    return;
  }
  const blob = new Blob(chunks as BlobPart[], { type: res.headers.get("content-type") || "application/octet-stream" });
  if (item.blobUrl) URL.revokeObjectURL(item.blobUrl);
  item.blob = blob;
  item.blobUrl = URL.createObjectURL(blob);
  item.filename = named;
  item.size = blob.size;
  item.indeterminate = false;
  setStatus(item, "ready", "ready");
  await afterReady(item, blob);
}

async function afterReady(item: QueueItem, blob: Blob | null): Promise<void> {
  const method = settingsStore.get().savingMethod;
  if (method === "download") {
    if (blob) saveBlob(item);
    else if (item.sourceUrl) handOffToBrowser(item, "direct link");
    return;
  }
  if (method === "share" && blob) {
    if (!(await shareItem(item, true))) saveBlob(item);
  } else if (method === "copy" && item.sourceUrl) {
    if (await copyText(item.sourceUrl)) toast("Link copied", "info");
  }
}

let toldWhere = false;
function tellWhereItWent(): void {
  if (toldWhere) return;
  toldWhere = true;
  toast("Saved to " + SAVED_WHERE, "ok");
}

function clickDownload(href: string, filename: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = safeFilename(filename, "download");
  link.rel = "noopener";
  link.dataset.ignoreDock = "true";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function handOffToBrowser(item: QueueItem, note: string): void {
  item.blob = null;
  if (item.blobUrl) {
    URL.revokeObjectURL(item.blobUrl);
    item.blobUrl = "";
  }
  item.indeterminate = false;
  const method = settingsStore.get().savingMethod;
  if (method === "ask") return setStatus(item, "ready", note + ", open to save");
  if (method === "copy") {
    void copyText(item.sourceUrl).then((ok) => ok && toast("Link copied", "info"));
    return setStatus(item, "done", "link copied");
  }
  if (!item.sourceUrl) return setStatus(item, "ready", note + ", no direct link");
  clickDownload(item.sourceUrl, item.filename);
  setStatus(item, "done", "saved · " + SAVED_WHERE);
  tellWhereItWent();
}

export function saveBlob(item: QueueItem): void {
  if (!item.blob || !item.blobUrl || item.saving) return;
  item.saving = true;
  setTimeout(() => (item.saving = false), 900);
  clickDownload(item.blobUrl, item.filename);
  setStatus(item, "done", "saved · " + SAVED_WHERE);
  tellWhereItWent();
}

export function openSource(item: QueueItem): void {
  if (item.sourceUrl) clickDownload(item.sourceUrl, item.filename);
}

export async function shareItem(item: QueueItem, silentFallback = false): Promise<boolean> {
  if (item.sharing) return false;
  item.sharing = true;
  setTimeout(() => (item.sharing = false), 900);
  if (item.blob && navigator.canShare) {
    const file = new File([item.blob], item.filename || "download", { type: item.blob.type || "application/octet-stream" });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: item.filename });
        setStatus(item, "done", "shared");
        return true;
      } catch (err) {
        if (isAbort(err)) return true;
      }
    }
  }
  if (!silentFallback) {
    if (item.sourceUrl && (await copyText(item.sourceUrl))) toast("Sharing isn't supported here, so the link was copied instead.", "info");
    else toast("Sharing isn't available in this browser.", "warn");
  }
  return false;
}

export function cancelItem(item: QueueItem, silent = false): void {
  try {
    item.controller?.abort();
  } catch {
    /* already done */
  }
  if (item.running) return;
  if (!silent && ["queued", "working", "downloading"].includes(item.status)) setStatus(item, "cancelled", "cancelled");
  if (silent) item.status = "cancelled";
}

export function retryItem(item: QueueItem): void {
  Object.assign(item, { error: "", ref: "", received: 0, speed: 0, indeterminate: true, filename: "", started: 0 });
  setStatus(item, "queued", "queued");
  pump();
}

export function removeItem(item: QueueItem): void {
  cancelItem(item, true);
  if (item.blobUrl) URL.revokeObjectURL(item.blobUrl);
  queueStore.set((s) => ({ items: s.items.filter((q) => q !== item), v: s.v + 1 }));
}

export const FINISHED: ItemStatus[] = ["done", "error", "cancelled", "ready"];

export function clearFinished(): void {
  queueStore.set((s) => {
    s.items.filter((q) => FINISHED.includes(q.status)).forEach((q) => q.blobUrl && URL.revokeObjectURL(q.blobUrl));
    return { items: s.items.filter((q) => !FINISHED.includes(q.status)), v: s.v + 1 };
  });
}

export function clearAll(): void {
  queueStore.get().items.forEach((q) => {
    cancelItem(q, true);
    if (q.blobUrl) URL.revokeObjectURL(q.blobUrl);
  });
  queueStore.set({ items: [], v: queueStore.get().v + 1 });
}

/* ------------------------------------------------------------------ */
/* picker and local processing                                          */
/* ------------------------------------------------------------------ */

function handlePicker(item: QueueItem, data: Record<string, any>): void {
  const entries: PickerEntry[] = Array.isArray(data.picker)
    ? data.picker.filter((e: unknown): e is PickerEntry => !!e && typeof (e as PickerEntry).url === "string")
    : [];
  item.filename = "";
  item.picker = { entries, audio: typeof data.audio === "string" ? data.audio : "", audioFilename: data.audioFilename };
  setStatus(item, "picker", entries.length + " items available");
  modalStore.set({ kind: "picker", itemId: item.id });
}

export function confirmPicker(item: QueueItem, picked: number[], withAudio: boolean): void {
  const entries = item.picker?.entries || [];
  const chosen = entries.filter((_, i) => picked.includes(i));
  if (!chosen.length && !withAudio) {
    toast("Nothing selected.", "warn");
    return;
  }
  chosen.forEach((entry, index) => {
    const url = resolveUrl(entry.url, apiEndpoint());
    if (!url) return;
    if (entry.type === "link") {
      enqueue(url, item.mode);
      addHistory(url);
      return;
    }
    enqueueDirect(url, (item.host || "media") + "-" + (index + 1) + "-" + (entry.type || "item"), item);
  });
  if (withAudio && item.picker?.audio) {
    const audio = enqueueDirect(resolveUrl(item.picker.audio, apiEndpoint()), item.picker.audioFilename || (item.host || "audio") + ".mp3", item);
    audio.mode = "audio";
  }
  setStatus(item, "done", "handled");
  pump();
}

function handleLocalProcessing(item: QueueItem, data: Record<string, any>): void {
  const tunnels = (Array.isArray(data.tunnel) ? data.tunnel : []).map((u: string) => resolveUrl(u, apiEndpoint())).filter(Boolean) as string[];
  const filename = safeFilename(data.output?.filename, guessFilename(item.url, item.mode));
  item.filename = filename;
  item.sourceUrl = tunnels[0] || "";
  let command = "";
  if (tunnels.length) {
    if (data.type === "merge" && tunnels.length >= 2) command = `ffmpeg -i "stream1" -i "stream2" -c copy -map 0:v:0 -map 1:a:0 "${filename}"`;
    else if (["audio", "mute", "gif", "remux"].includes(data.type)) command = `ffmpeg -i "stream1" -c copy "${filename}"`;
  }
  item.local = { tunnels, type: String(data.type || "unknown"), command };
  setStatus(item, "local", "needs merging locally");
  modalStore.set({ kind: "local", itemId: item.id });
  toast("This media needs local merging. The streams and a ready ffmpeg command are in this dialog.", "warn");
}

export function saveLocalPart(item: QueueItem, index: number): void {
  const url = item.local?.tunnels[index];
  if (!url) return;
  const base = item.filename.replace(/(\.[a-z0-9]+)$/i, "");
  const ext = (/(\.[a-z0-9]+)$/i.exec(item.filename) || [""])[0];
  enqueueDirect(url, base + "-part" + (index + 1) + ext, item);
  pump();
}

/** the rows a phone's mini dock and the header badge summarise */
export function queueSummary(items: QueueItem[]) {
  const live = items.find((i) => ["downloading", "working", "queued"].includes(i.status));
  const ready = items.find((i) => i.status === "ready");
  const activeCount = items.filter((i) => ["queued", "working", "downloading"].includes(i.status)).length;
  const finished = items.filter((i) => ["done", "error", "cancelled"].includes(i.status)).length;
  const saved = items.filter((i) => i.status === "done");
  const failed = items.filter((i) => i.status === "error").length;
  const bytes = saved.reduce((t, i) => t + (i.size || 0), 0);
  const stats = [saved.length ? saved.length + " saved" : "", bytes ? formatBytes(bytes) : "", failed ? failed + " failed" : ""]
    .filter(Boolean).join(" · ");
  return { live, ready, focus: live || ready, activeCount, finished, stats };
}

export function reportable(item: QueueItem): boolean {
  const info = instanceStore.get().info;
  if (item.status !== "error" || !info?.inbox) return false;
  return queueStore.get().items.filter((n) => n.service === item.service && n.status === "error").length >= 2;
}

export { AUDIO_FIRST };
