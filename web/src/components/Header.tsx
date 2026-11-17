import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { apiEndpoint, authHeaders, formatUptime, readHealth } from "../api";
import { isPhone } from "../constants";
import { queueStore, queueSummary } from "../queue";
import { instanceStore, setPanel, togglePanel, uiStore, useStore, type Panel } from "../store";
import { navigate, onNav } from "../routing";
import { BrandMark, IconBack, IconClose, IconDownloads, IconGear, IconHeart, IconHelp, IconPlus } from "../icons";
import { Mark, QueueList, QueuePanelHead } from "./Queue";
import { loadMarks } from "../service-marks";
import { cx } from "../util";

/* ------------------------------------------------------------------ */
/* panels: one open at a time, closed by Escape or a press outside     */
/* ------------------------------------------------------------------ */

/** a desktop dropdown hangs from the middle of its button, kept on screen */
function usePlaceUnder(open: boolean, pop: RefObject<HTMLElement | null>, anchor: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const node = pop.current;
      const button = anchor.current;
      if (!node || !button) return;
      if (isPhone()) {
        node.style.left = node.style.right = node.style.top = "";
        return;
      }
      const rect = button.getBoundingClientRect();
      const width = node.getBoundingClientRect().width;
      const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), Math.max(8, innerWidth - width - 8));
      node.style.top = Math.round(rect.bottom + 8) + "px";
      node.style.left = Math.round(left) + "px";
      node.style.right = "auto";
    };
    place();
    addEventListener("resize", place);
    return () => removeEventListener("resize", place);
  }, [open, pop, anchor]);
}

/** keeps a closing panel mounted long enough for its exit animation */
function useClosing(open: boolean, ms: number): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const t = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(t);
  }, [open, ms]);
  return { mounted: open || mounted, closing: !open && mounted };
}

export function usePanelDismiss(panel: Panel, ...inside: RefObject<HTMLElement | null>[]) {
  const open = useStore(uiStore, (s) => s.panel === panel);
  const insideRef = useRef(inside);
  insideRef.current = inside;
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (insideRef.current.some((r) => r.current?.contains(target))) return;
      if ((target as Element).closest?.("[data-ignore-dock], .mobile-bar, .modal, .sheet")) return;
      setPanel("none");
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setPanel("none");
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return open;
}

/* ------------------------------------------------------------------ */
/* sources                                                              */
/* ------------------------------------------------------------------ */

const SOURCES: Record<string, string> = {
  "9gag": "https://9gag.com", audiomack: "https://audiomack.com", bandcamp: "https://bandcamp.com",
  bilibili: "https://www.bilibili.com", bluesky: "https://bsky.app", coub: "https://coub.com",
  dailymotion: "https://www.dailymotion.com", douyin: "https://www.douyin.com", facebook: "https://www.facebook.com",
  hearthis: "https://hearthis.at", imgur: "https://imgur.com", instagram: "https://www.instagram.com",
  kick: "https://kick.com", loom: "https://www.loom.com", mixcloud: "https://www.mixcloud.com",
  newgrounds: "https://www.newgrounds.com", odysee: "https://odysee.com", ok: "https://ok.ru",
  reddit: "https://www.reddit.com", rumble: "https://rumble.com", rutube: "https://rutube.ru",
  snapchat: "https://www.snapchat.com", soundcloud: "https://soundcloud.com", streamable: "https://streamable.com",
  threads: "https://www.threads.net", tiktok: "https://www.tiktok.com", tumblr: "https://www.tumblr.com",
  twitch: "https://www.twitch.tv", twitter: "https://x.com", vimeo: "https://vimeo.com", vk: "https://vk.com",
  xiaohongshu: "https://www.xiaohongshu.com", youtube: "https://www.youtube.com",
};
const SOURCE_NOTES: Record<string, string> = {
  audiomack: "audio", bandcamp: "audio", hearthis: "audio", mixcloud: "audio", soundcloud: "audio", youtube: "4k",
};
const FEATURED = ["youtube", "soundcloud", "tiktok", "instagram", "reddit", "twitter", "facebook", "vimeo", "twitch",
  "dailymotion", "bilibili", "bluesky", "threads", "tumblr", "bandcamp", "mixcloud", "rumble", "odysee", "streamable", "snapchat"];
const REFUSED = new Set(["spotify", "deezer", "tidal", "apple_music", "applemusic"]);

function Sources() {
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const open = usePanelDismiss("sources", wrap);
  const { mounted, closing } = useClosing(open, 220);
  // centred under its own button by the stylesheet; no measuring needed
  useEffect(() => {
    if (open) void loadMarks();
  }, [open]);
  const services = useStore(instanceStore, (s) => s.info?.services);
  const all = new Set(Object.keys(SOURCES));
  (services || []).forEach((name) => typeof name === "string" && name && !REFUSED.has(name.toLowerCase()) && all.add(name));
  const shown = FEATURED.filter((id) => all.has(id));
  return (
    <div className="sources-wrap" id="sources-wrap" ref={wrap}>
      <button type="button" ref={button} className={cx("sources-toggle", open && "is-open")} id="open-sources"
        aria-expanded={open} aria-controls="sources-panel" aria-label="sources" title="sources"
        onClick={() => togglePanel("sources")}>
        <IconPlus className="sources-glyph" />
        <span className="sources-label">sources</span>
      </button>
      {mounted && <div className={cx("sources-veil", open && "is-on")} id="sources-veil" onClick={() => setPanel("none")} />}
      {mounted && (
        <div className={cx("sources-panel", closing && "is-closing")} id="sources-panel" ref={panelRef}>
          <div className="sources">
            <span className="sources-handle" aria-hidden="true" />
            <div className="sources-head">
              <span className="sources-title">sources</span>
              <span className="sources-count">{all.size} services</span>
            </div>
            <div className="source-chips">
              {shown.map((id) => {
                const home = SOURCES[id] || "";
                const host = home.replace(/^https?:\/\/(?:www\.)?/, "").replace(/\/$/, "");
                const note = SOURCE_NOTES[id];
                return home ? (
                  <a key={id} className="source-chip" href={home} target="_blank" rel="noopener noreferrer"
                    title={id + (host ? " · " + host : "") + (note ? " · " + note : "")} aria-label={id + ", open " + host}
                    onClick={() => setPanel("none")}><Mark className="source-mark" service={id} /><span className="source-name">{id}</span></a>
                ) : <span key={id} className="source-chip"><Mark className="source-mark" service={id} /><span className="source-name">{id}</span></span>;
              })}
            </div>
            <p className="sources-note"><b>download</b> compatibility only, no affiliation or endorsement</p>
            <a className="sources-more" href="sources.html">all {all.size} sources<span className="sources-more-go" aria-hidden="true" /></a>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* health                                                               */
/* ------------------------------------------------------------------ */

interface Bar {
  key: string;
  ok?: "true" | "false" | "partial";
  empty?: boolean;
  live?: boolean;
  title: string;
}

const compact = (n: number) => (n < 1000 ? String(n) : (n / 1000).toFixed(1).replace(/\.0$/, "") + "k");
const shortDay = (d: string) => {
  const p = d.split("-");
  return p.length === 3 ? p[2] + "." + p[1] : d;
};

function Health() {
  const box = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const open = usePanelDismiss("health", box);
  const { mounted, closing } = useClosing(open, 150);
  // centred on the dot by the stylesheet (margin-left: -width/2)
  const inst = useStore(instanceStore);
  const [state, setState] = useState<{ s: string; label: string; up: string; bars: Bar[]; pct: string; checks: string; scope: string }>({
    s: "unknown", label: "checking…", up: "", bars: [], pct: "—", checks: "", scope: "last 7 days",
  });

  const refresh = useCallback(async () => {
    const endpoint = apiEndpoint();
    if (!endpoint) {
      setState((p) => ({ ...p, s: "bad", label: "not connected", up: "" }));
      return;
    }
    let body: { status?: string; uptimeSeconds?: number } | null = null;
    let responded = false;
    let ok = false;
    for (let attempt = 0; attempt < 2 && !responded; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1200));
      try {
        const res = await fetch(endpoint + "health", { headers: { Accept: "application/json", ...authHeaders() }, cache: "no-store" });
        responded = true;
        body = await res.json().catch(() => null);
        ok = res.status === 429 || (res.ok && body?.status !== "degraded");
      } catch {
        responded = false;
      }
    }
    let bars: Bar[] = [];
    let pct = "—";
    let checks = "";
    try {
      const res = await fetch(endpoint + "uptime", { headers: { Accept: "application/json" }, cache: "no-store" });
      const data = res.ok ? await res.json() : null;
      const days: { date: string; up: number | null; total: number | null }[] = Array.isArray(data?.days) ? data.days.slice(-7) : [];
      if (days.some((d) => d && d.total)) {
        bars = days.map((d, i) => {
          if (!d || !d.total) return { key: d?.date || String(i), empty: true, title: (d?.date ? shortDay(d.date) + " · " : "") + "no checks" };
          const ratio = (d.up || 0) / d.total;
          return {
            key: d.date, live: i === days.length - 1,
            ok: ratio >= 0.995 ? "true" : ratio >= 0.97 ? "partial" : "false",
            title: shortDay(d.date) + " · " + Math.round(ratio * 1000) / 10 + "% of " + d.total.toLocaleString() + " checks",
          };
        });
        pct = data.uptime == null ? "—" : Number(data.uptime).toFixed(1) + "%";
        checks = compact(Number(data.checks) || 0) + " check" + (Number(data.checks) === 1 ? "" : "s");
      }
    } catch {
      /* the local samples below */
    }
    let scope = "last 7 days";
    if (!bars.length) {
      // the server keeps no log: show what this browser saw, and say so
      scope = "recent checks";
      const seen = readHealth();
      const okCount = seen.filter((x) => x.ok).length;
      if (seen.length) {
        pct = Math.round((okCount / seen.length) * 1000) / 10 + "%";
        checks = compact(seen.length) + " check" + (seen.length === 1 ? "" : "s");
      }
      const local = seen.slice(-7);
      bars = [
        ...Array.from({ length: 7 - local.length }, (_, i) => ({ key: "pad" + i, empty: true, title: "no sample yet" })),
        ...local.map((x, i) => ({ key: String(x.t), ok: (x.ok ? "true" : "false") as Bar["ok"], live: i === local.length - 1, title: new Date(x.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })),
      ];
    }
    const up = body?.uptimeSeconds ? "up " + formatUptime(Date.now() - Number(body.uptimeSeconds) * 1000) : "";
    setState({
      s: !responded ? "bad" : ok ? "ok" : "bad",
      label: !responded ? "unreachable" : ok ? "online" : "down",
      up, bars, pct, checks, scope,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const t = setInterval(() => !document.hidden && void refresh(), 60000);
    return () => clearInterval(t);
  }, [open, refresh]);

  const pillState = inst.state === "ok" ? "ok" : inst.state === "checking" ? "checking" : inst.state === "unknown" || inst.state === "empty" ? "unknown" : "bad";
  const label = inst.state === "ok" ? "online" : inst.state === "empty" ? "not connected" : inst.state === "checking" || inst.state === "unknown" ? "checking" : "unreachable";
  return (
    <div className="health" id="health" ref={box}>
      <button ref={pill} className="instance-pill" id="instance-pill" type="button" data-state={pillState}
        title={inst.error || "connection: click for health"} aria-label={"server: " + label}
        aria-expanded={open} aria-controls="health-pop" onClick={() => togglePanel("health")}>
        <span className="dot" aria-hidden="true" />
        <span className="instance-pill-label sr-only">{label}</span>
      </button>
      {mounted && (
        <div ref={pop} className={cx("health-pop hp2", closing && "is-closing")} id="health-pop" data-state={state.s} aria-label="server health">
          <div className="hp2-head">
            <span className="hp2-state"><span className="hp2-dot" aria-hidden="true" /><b>{state.label}</b></span>
            {state.up && <span className="hp2-up">{state.up}</span>}
          </div>
          <div className="hp2-graph">
            <div className="hp2-label"><span>{state.scope}</span><span>{state.checks}</span></div>
            <div className="hp2-bars" aria-hidden="true">
              {state.bars.map((b) => (
                <span key={b.key} className="hp2-bar" data-ok={b.ok} data-empty={b.empty ? "true" : undefined} title={b.title} />
              ))}
            </div>
          </div>
          <div className="hp2-stat"><b>{state.pct}</b><span>uptime</span></div>
          <div className="hp2-foot">
            <a href="status.html" className="hp2-link">status page</a>
            <button type="button" className="hp2-link" onClick={() => uiStore.set((s) => ({ ...s, panel: "none", settingsOpen: true, settingsSection: "instance" }))}>server settings</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* downloads dock                                                       */
/* ------------------------------------------------------------------ */

function Dock() {
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const open = usePanelDismiss("queue", box);
  const { mounted, closing } = useClosing(open, 120);
  usePlaceUnder(open, panel, button);
  const { items } = useStore(queueStore);
  const { activeCount, finished } = queueSummary(items);
  const show = activeCount > 0 || finished > 0;

  // a new job opens the list on a desktop; on a phone the mini dock says it
  const count = useRef(items.length);
  useEffect(() => {
    if (items.length > count.current && !isPhone() && uiStore.get().panel === "none") setPanel("queue");
    count.current = items.length;
  }, [items.length]);

  return (
    <div className={cx("dock", open && "is-open")} id="queue-dock" ref={box}>
      <button ref={button} className="icon-btn dock-btn" id="queue-toggle" type="button" aria-expanded={open}
        aria-controls="queue-panel" aria-label="downloads" title="downloads" onClick={() => togglePanel("queue")}>
        <IconDownloads />
        <span className={cx("dock-badge", activeCount === 0 && show && "is-dot")} id="queue-badge" hidden={!show}>
          {activeCount > 0 ? activeCount : "•"}
        </span>
      </button>
      {mounted && (
        <div ref={panel} className={cx("dock-panel", closing && "is-closing")} id="queue-panel">
          <QueuePanelHead />
          <QueueList />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* the bar                                                              */
/* ------------------------------------------------------------------ */

export function Header() {
  const view = useStore(uiStore, (s) => s.view);
  const raised = useStore(uiStore, (s) => s.panel === "sources");
  return (
    <header className={cx("topbar", raised && "is-raised")}>
      <a className="brand" href="./" draggable={false} title="mdown.cc: media downloader, cc for closed captions" onClick={onNav("download")}>
        <span className="brand-mark" aria-hidden="true"><BrandMark /></span>
        <span className="brand-text">mdown<span className="brand-dot">.</span><span className="brand-sub">cc</span></span>
      </a>
      <nav className="nav" aria-label="Sections">
        <a className={cx("nav-link nav-download", view === "download" && "is-active")} href="./" data-view="download"
          title="back to the downloader" aria-label="back to the downloader" onClick={onNav("download")}>
          <IconBack className="nav-back-arrow" />
        </a>
      </nav>
      <div className="topbar-actions">
        <Sources />
        <Health />
        <Dock />
        <a className="icon-btn labeled donate-btn" id="open-donate-top" href="donate.html" title="leave a tip" onClick={onNav("donate")}
          aria-current={view === "donate" ? "page" : undefined}>
          <IconHeart /><span>tip</span>
        </a>
        <button className="icon-btn help-btn" id="open-help-top" type="button" aria-haspopup="dialog" aria-label="how it works" title="how it works"
          onClick={() => uiStore.set((s) => ({ ...s, panel: "none", helpOpen: true }))}>
          <IconHelp />
        </button>
        <button className="icon-btn labeled" id="open-settings" type="button" aria-haspopup="dialog"
          onClick={() => uiStore.set((s) => ({ ...s, panel: "none", settingsOpen: true }))}>
          <IconGear /><span>settings</span>
        </button>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* the phone's tab bar                                                  */
/* ------------------------------------------------------------------ */

export function MobileBar() {
  const ui = useStore(uiStore);
  const { items } = useStore(queueStore);
  const { activeCount, finished } = queueSummary(items);
  const bar = useRef<HTMLElement>(null);
  const [glide, setGlide] = useState<{ x: number; y: number; w: number; h: number; instant: boolean } | null>(null);

  const active =
    ui.settingsOpen ? "settings" : ui.view === "donate" ? "donate" : ui.panel === "queue" ? "queue" : ui.view === "remux" ? "remux" : ui.view === "download" ? "queue" : "";

  useLayoutEffect(() => {
    const place = (instant: boolean) => {
      const node = bar.current?.querySelector<HTMLElement>(`[data-tab="${active}"]`);
      if (!bar.current || !node) return setGlide(null);
      const b = bar.current.getBoundingClientRect();
      const r = node.getBoundingClientRect();
      setGlide((prev) => ({ x: r.left - b.left - bar.current!.clientLeft, y: r.top - b.top - bar.current!.clientTop, w: r.width, h: r.height, instant: instant || !prev }));
    };
    place(false);
    const onResize = () => place(true);
    addEventListener("resize", onResize);
    return () => removeEventListener("resize", onResize);
  }, [active]);

  const closeAll = { panel: "none" as Panel, settingsOpen: false, helpOpen: false };
  return (
    <nav className="mobile-bar" aria-label="Quick actions" ref={bar}>
      <span className={cx("mbar-glider", glide && "is-on", glide?.instant && "is-instant")} id="mbar-glider" aria-hidden="true"
        style={glide ? ({ "--x": glide.x + "px", "--y": glide.y + "px", "--w": glide.w + "px", "--h": glide.h + "px" } as React.CSSProperties) : undefined} />
      <button type="button" className={cx("mbar-item", ui.view === "download" && "is-active")} data-tab="queue"
        data-front={active === "queue" ? "true" : undefined} aria-haspopup="dialog" aria-expanded={ui.panel === "queue"} aria-controls="queue-panel"
        onClick={() => {
          if (ui.view !== "download") return navigate("download");
          uiStore.set((s) => ({ ...s, ...closeAll, panel: s.panel === "queue" ? "none" : "queue" }));
        }}>
        <span className="mbar-badge" hidden={!(activeCount > 0 || finished > 0)}>{activeCount > 0 ? activeCount : "•"}</span>
        <IconDownloads />
        <span>downloads</span>
      </button>
      <a className={cx("mbar-item", ui.view === "remux" && "is-active")} href="#remux" data-tab="remux" data-front={active === "remux" ? "true" : undefined}
        aria-current={ui.view === "remux" ? "page" : undefined} onClick={onNav("remux")}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 9h11" /><path d="m7 6-3 3 3 3" /><path d="M20 15H9" /><path d="m17 12 3 3-3 3" /></svg>
        <span>remux</span>
      </a>
      <button type="button" className="mbar-item" data-tab="settings" data-front={active === "settings" ? "true" : undefined}
        aria-haspopup="dialog" aria-expanded={ui.settingsOpen}
        onClick={() => uiStore.set((s) => ({ ...s, ...closeAll, settingsOpen: !s.settingsOpen }))}>
        <IconGear />
        <span>settings</span>
      </button>
      <a className={cx("mbar-item", ui.view === "donate" && "is-active")} href="donate.html" data-tab="donate" id="mbar-donate"
        data-front={active === "donate" ? "true" : undefined} aria-current={ui.view === "donate" ? "page" : undefined} onClick={onNav("donate")}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20s-7-4.4-7-9a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 4.6-7 9-7 9z" /></svg>
        <span>donate</span>
      </a>
    </nav>
  );
}

export { IconClose };
