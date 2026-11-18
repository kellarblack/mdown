import { APP_PATHS, AUDIO_FIRST, HIDDEN_SERVICES, SERVICE_ALIASES, SERVICE_HOSTS } from "./constants";

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return (value < 10 && i > 0 ? value.toFixed(1) : Math.round(value)) + " " + units[i];
}

export function etaText(seconds: number): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.max(1, Math.round(seconds));
  if (total < 60) return total + "s left";
  const mins = Math.floor(total / 60);
  const rest = total % 60;
  if (mins < 60) return mins + "m" + (rest ? " " + rest + "s" : "") + " left";
  return Math.floor(mins / 60) + "h " + (mins % 60) + "m left";
}

export function clockTime(seconds: number): string {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export interface Detected {
  id: string | null;
  host: string;
  hidden: boolean;
}

export function detectService(url: string): Detected | null {
  const host = hostOf(url);
  if (!host) return null;
  for (const [suffix, id] of SERVICE_HOSTS) {
    if (host === suffix || host.endsWith("." + suffix)) return { id, host, hidden: HIDDEN_SERVICES.has(id) };
  }
  return { id: null, host, hidden: false };
}

/** auto mode takes audio from a music link: an audio-only site, or YouTube
 *  Music. A plain YouTube link is a video, so auto keeps the picture. */
export function prefersAudio(url: string): boolean {
  const detected = detectService(url);
  if (!detected?.id) return false;
  if (AUDIO_FIRST.has(detected.id)) return true;
  return detected.id === "youtube" && /^music\./.test(detected.host);
}

export function normalizeInstance(value: string): string {
  let raw = String(value || "").trim();
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) {
    const hostPart = raw.split("/")[0]!.replace(/:\d+$/, "").toLowerCase();
    const isLocal =
      hostPart === "localhost" || hostPart === "127.0.0.1" || hostPart === "[::1]" ||
      hostPart.endsWith(".local") || /^10\./.test(hostPart) || /^192\.168\./.test(hostPart) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostPart);
    raw = (isLocal ? "http://" : "https://") + raw;
  }
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    const path = u.pathname.replace(/\/+$/, "");
    return u.origin + path;
  } catch {
    return "";
  }
}

/** every distinct http(s) link in a blob of pasted text */
export function parseUrls(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const chunk of String(text || "").split(/[\s,]+/)) {
    let candidate = chunk.trim();
    if (!candidate) continue;
    if (!/^https?:\/\//i.test(candidate) && /^[\w.-]+\.[a-z]{2,}\//i.test(candidate)) candidate = "https://" + candidate;
    try {
      const u = new URL(candidate);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      if (seen.has(u.href)) continue;
      seen.add(u.href);
      out.push(u.href);
    } catch {
      /* not a link */
    }
  }
  return out;
}

/**
 * A link can arrive three ways:
 *   mdown.cc/https://youtube.com/watch?v=x
 *   mdown.cc/?url=https://youtube.com/watch?v=x
 *   a lookalike host, e.g. yout.cc/watch?v=x
 */
export function targetFromLocation(loc: Pick<Location, "hostname" | "pathname" | "search">): string {
  const host = loc.hostname.toLowerCase();
  let path: string;
  try {
    path = decodeURIComponent(loc.pathname.replace(/^\/+/, ""));
  } catch {
    path = loc.pathname.replace(/^\/+/, "");
  }
  const search = loc.search || "";
  const alias = SERVICE_ALIASES[host];
  if (alias) {
    const rest = path + search;
    return rest ? "https://" + alias + "/" + rest : "";
  }
  const params = new URLSearchParams(search);
  const fromQuery = (params.get("url") || params.get("u") || "").trim();
  if (fromQuery) return fromQuery;
  if (path.startsWith("u/")) return path.slice(2);
  if (APP_PATHS.has(path) || path === "donate" || path === "donate.html" || path.startsWith("tests/") || path.startsWith("assets/")) return "";
  if (/^https?:\/\//i.test(path)) return path + search;
  // "https:/x" after a host collapsed the double slash
  if (/^https?:\/[^/]/i.test(path)) return path.replace(/^(https?):\//i, "$1://") + search;
  if (/^(?:[\w-]+\.)+[a-z]{2,}(?:\/|$)/i.test(path)) return "https://" + path + search;
  return "";
}

/** only http(s) survives: an href of javascript: would run in this origin */
export function resolveUrl(url: string, base: string): string {
  if (!url) return "";
  try {
    const resolved = new URL(url, base || location.href);
    return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.href : "";
  } catch {
    return "";
  }
}

export function safeImageUrl(value: string, base: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(raw)) return raw;
  return resolveUrl(raw, base);
}

/** no separators, no control characters, no dotfiles */
export function safeFilename(value: string, fallback: string): string {
  const raw = String(value || "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, "")
    .replace(/[\\/]+/g, "-")
    .trim()
    .slice(0, 120)
    .replace(/^\.+/, "");
  return raw || fallback;
}

export function filenameFromDisposition(disposition: string): string {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim());
    } catch {
      return star[1]!.trim();
    }
  }
  const quoted = /filename="([^"]+)"/i.exec(disposition);
  if (quoted) return quoted[1]!;
  const bare = /filename=([^;]+)/i.exec(disposition);
  return bare ? bare[1]!.trim() : "";
}

export function isIOS(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  if (/iP(hone|ad|od)/.test(userAgent || "")) return true;
  return (platform || "") === "MacIntel" && (maxTouchPoints || 0) > 1;
}

export const IS_IOS = typeof navigator !== "undefined" && isIOS(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
export const IS_TOUCH = typeof window !== "undefined" && ((navigator.maxTouchPoints || 0) > 0 || "ontouchstart" in window);
export const IS_ANDROID = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
export const SAVED_WHERE = IS_IOS ? "Files → Downloads" : IS_ANDROID ? "Downloads" : "your downloads folder";

export const reducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}
