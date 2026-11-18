import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { checkInstance, fetchProbe, probeKey, probeSupported, ProbeError, readProbe, type ProbeData } from "../api";
import { AUDIO_FIRST, DRM_SERVICES, HIDDEN_SERVICES } from "../constants";
import { effectiveMode, submitUrls } from "../queue";
import {
  composerStore, historyStore, instanceStore, settingsStore, toast, uiStore, useStore,
} from "../store";
import { onNav } from "../routing";
import { BrandMark, IconCheck, IconClose, IconGet, IconMoon, IconNote, IconPaste, IconRemux, IconSliders, IconSubs, IconVideo } from "../icons";
import { Mark, useMark } from "./Queue";
import { loadMarks } from "../service-marks";
import { clockTime, copyText, cx, detectService, formatBytes, hostOf, IS_TOUCH, parseUrls } from "../util";
import { Board } from "./Board";

function setText(text: string) {
  composerStore.set((s) => ({ ...s, text }));
}

function modeSummary(mode: string): string {
  const s = settingsStore.get();
  if (mode === "audio") {
    if (s.audioFormat === "best") return "source";
    if (s.audioFormat === "wav") return "wav";
    return s.audioFormat + " · " + s.audioBitrate + "k";
  }
  const container = s.youtubeVideoContainer === "auto" ? "mp4" : s.youtubeVideoContainer;
  if (mode === "mute") return container + " · " + s.videoQuality + "p · no sound";
  return container + " · " + s.videoQuality + "p";
}

/* ------------------------------------------------------------------ */
/* the mode row: one pill that slides between auto, audio and video    */
/* ------------------------------------------------------------------ */

function Modes() {
  const mode = useStore(settingsStore, (s) => s.downloadMode);
  const group = useRef<HTMLDivElement>(null);
  const placed = useRef(false);
  useLayoutEffect(() => {
    const place = () => {
      const node = group.current;
      const active = node?.querySelector<HTMLElement>('.mode[aria-checked="true"]');
      if (!node || !active) return;
      if (!placed.current) {
        placed.current = true;
        node.classList.add("no-glide");
        requestAnimationFrame(() => node.classList.remove("no-glide"));
      }
      node.style.setProperty("--mx", active.offsetLeft + "px");
      node.style.setProperty("--mw", active.offsetWidth + "px");
      node.classList.add("has-glider");
    };
    place();
    addEventListener("resize", place);
    return () => removeEventListener("resize", place);
  }, [mode]);
  const pick = (m: "auto" | "audio" | "video") => {
    settingsStore.set((s) => ({ ...s, downloadMode: m }));
  };
  const items: { m: "auto" | "audio" | "video"; title: string; icon: React.ReactNode }[] = [
    { m: "auto", title: "pick what suits the link", icon: <IconMoon /> },
    { m: "audio", title: "audio only", icon: <IconNote /> },
    { m: "video", title: "video with sound", icon: <IconVideo /> },
  ];
  return (
    <div className="mode-group">
      <div className="modes" role="radiogroup" aria-label="Download mode" id="modes" ref={group}>
        <span className="mode-glider" aria-hidden="true" />
        {items.map(({ m, title, icon }) => (
          <button key={m} type="button" className="mode" data-mode={m} role="radio" aria-checked={mode === m} title={title} onClick={() => pick(m)}>
            {icon}
            <span className="mode-name">{m}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* the composer                                                         */
/* ------------------------------------------------------------------ */

function Composer() {
  const { text, busy, nudge } = useStore(composerStore);
  const settings = useStore(settingsStore);
  const inst = useStore(instanceStore);
  const input = useRef<HTMLTextAreaElement>(null);
  const composer = useRef<HTMLElement>(null);
  const [probe, setProbe] = useState<ProbeData | null>(null);
  const [probeError, setProbeError] = useState(0);
  const [dropping, setDropping] = useState(false);
  // a pasted link is complete: resolve it now, so the server has the answer
  // ready by the time the download button is pressed
  const pastedAt = useRef(0);
  const [shaking, setShaking] = useState(false);

  const urls = parseUrls(text);
  const first = urls[0] || "";
  const detected = first ? detectService(first) : null;
  const service = detected?.id || null;
  const serviceMark = useMark(service);
  useEffect(() => {
    if (service) void loadMarks();
  }, [service]);

  // auto stays auto: what it will fetch for this link is shown in the format
  // note ("soundcloud · mp3 · 128k"). It used to switch the saved setting to
  // audio, which outlived the link and turned the next video into an mp3.

  // the field grows with what is pasted, up to a limit
  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = Math.min(node.scrollHeight, 168) + "px";
  }, [text]);

  useEffect(() => {
    if (!nudge) return;
    setShaking(true);
    const t = setTimeout(() => setShaking(false), 1400);
    return () => clearTimeout(t);
  }, [nudge]);

  // what the file will be, debounced, thrown away if the field moved on
  const mode = first ? effectiveMode(first, settings.downloadMode) : "auto";
  useEffect(() => {
    setProbeError(0);
    if (urls.length !== 1 || !probeSupported()) {
      setProbe(null);
      return;
    }
    const cached = readProbe(probeKey(first, mode));
    if (cached) {
      setProbe(cached);
      return;
    }
    setProbe(null);
    let live = true;
    const t = setTimeout(() => {
      fetchProbe(first, mode)
        .then((data) => live && setProbe(data))
        .catch((err) => live && err instanceof ProbeError && setProbeError(err.status));
    }, Date.now() - pastedAt.current < 400 ? 0 : 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first, urls.length, mode, inst.info?.probe, settings.videoQuality, settings.audioFormat, settings.audioBitrate]);

  let hint = "";
  let tone = "";
  if (text.trim()) {
    if (!urls.length) [hint, tone] = ["not a link", "err"];
    else if (urls.length > 1) hint = urls.length + " links";
    else if (service && HIDDEN_SERVICES.has(service)) [hint, tone] = [service + " isn't supported", "warn"];
    else if (service && DRM_SERVICES.has(service)) [hint, tone] = ["encrypted · can't download", "warn"];
    else if (service) {
      const known = inst.info?.services;
      if (known?.length && !known.includes(service)) [hint, tone] = ["not on this API", "warn"];
      else if (settings.downloadMode === "auto" && AUDIO_FIRST.has(service)) hint = "audio only";
    } else hint = detected?.host || "";
  }
  const probeText: Record<number, string> = {
    403: "the server refused this request. reload and try again.",
    404: "this link does not work. check the link, or try audio only.",
    422: "this link does not work. check the link, or try audio only.",
    429: "too many requests. wait a minute and try again.",
  };
  if (probeError && !hint) [hint, tone] = [probeText[probeError] || "the server did not respond.", "warn"];

  const armed = urls.length >= 1;
  // the spinner only for a wait you would notice: a quick answer must not flash it
  const [busyShown, setBusyShown] = useState(false);
  useEffect(() => {
    if (!busy) {
      setBusyShown(false);
      return;
    }
    const t = setTimeout(() => setBusyShown(true), 250);
    return () => clearTimeout(t);
  }, [busy]);
  const submit = () => void submitUrls(text);

  const paste = async () => {
    if (armed) return submit();
    const blocked = IS_TOUCH ? "Clipboard is blocked here. Tap and hold the field to paste." : "Clipboard is blocked here. Press ⌘V to paste.";
    const focusForPaste = () => {
      input.current?.focus();
      input.current?.select();
    };
    if (!navigator.clipboard?.readText) {
      toast(blocked, "warn");
      return focusForPaste();
    }
    try {
      const clip = await navigator.clipboard.readText();
      if (!clip) return toast("Clipboard is empty.", "warn");
      pastedAt.current = Date.now();
      setText(clip);
      input.current?.focus();
    } catch {
      toast(blocked, "warn");
      focusForPaste();
    }
  };

  // dropping a link anywhere on the page puts it in the field
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (uiStore.get().view !== "download") return;
      e.preventDefault();
      setDropping(true);
    };
    const leave = (e: DragEvent) => e.relatedTarget === null && setDropping(false);
    const drop = async (e: DragEvent) => {
      if (uiStore.get().view !== "download") return;
      e.preventDefault();
      setDropping(false);
      const dt = e.dataTransfer;
      if (!dt) return;
      let dropped = dt.getData("text/plain") || dt.getData("text/uri-list") || "";
      const file = dt.files?.[0];
      if (!dropped && file && /\.(txt|csv|json|md)$/i.test(file.name) && file.size < 512 * 1024) dropped = await file.text();
      if (dropped) setText(dropped.trim());
    };
    document.addEventListener("dragover", over);
    document.addEventListener("dragleave", leave);
    document.addEventListener("drop", drop);
    return () => {
      document.removeEventListener("dragover", over);
      document.removeEventListener("dragleave", leave);
      document.removeEventListener("drop", drop);
    };
  }, []);

  const setup = inst.state === "empty" ? "empty" : inst.state === "down" ? "unreachable" : "";
  const openSettings = (section?: string) =>
    uiStore.set((s) => ({ ...s, panel: "none", settingsOpen: true, settingsSection: section || s.settingsSection }));

  return (
    <>
      <section className={cx("composer", shaking && "is-nudging is-error", dropping && "is-dropping")} id="composer" ref={composer}>
        <form id="fetch-form" noValidate onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}>
          <div className="composer-main">
            <span className="service-badge" id="service-badge" data-empty={service ? "false" : "true"} role="status"
              aria-label={service ? "detected: " + service : undefined} title={service || undefined}>
              <span className="service-mark" id="service-mark" aria-hidden="true" dangerouslySetInnerHTML={{ __html: serviceMark }} />
              <span className="service-name" hidden={!service}>{service}</span>
            </span>
            <label className="sr-only" htmlFor="url-input">Media link</label>
            <textarea id="url-input" ref={input} rows={1} placeholder="paste a link" spellCheck={false} autoComplete="off"
              autoCapitalize="off" autoCorrect="off" inputMode="url" enterKeyHint="go" value={text}
              onChange={(e) => setText(e.target.value)}
              onPaste={() => (pastedAt.current = Date.now())}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }} />
            <div className="composer-tools">
              <button type="button" className="icon-btn" id="clear-btn" title="Clear" aria-label="Clear input" hidden={!text}
                onClick={() => {
                  setText("");
                  input.current?.focus();
                }}>
                <IconClose />
              </button>
              <button type="button" className="ghost-btn" id="paste-btn" data-state={armed ? "get" : "paste"}
                data-busy={busyShown ? "true" : "false"} aria-busy={busy} aria-disabled={busy}
                aria-label={armed ? "download" : "paste from clipboard"} title={armed ? "download" : "paste"} onClick={() => void paste()}>
                <span className="pb-spin" aria-hidden="true" />
                <span className="pb-icons" aria-hidden="true">
                  <IconPaste className="pb-paste" />
                  <IconGet className="pb-get" />
                </span>
                <span className="pb-label">{armed ? "download" : "paste"}</span>
              </button>
            </div>
          </div>
          <div className="composer-foot">
            <Modes />
            <div className="composer-cta">
              <span className="format-note" id="format-note">{first ? (service ? service + " · " : "") + modeSummary(mode) : ""}</span>
              <button type="button" className="icon-btn tune" id="tune-mode" title="format settings" aria-label="format settings"
                onClick={() => openSettings(settings.downloadMode === "audio" ? "audio" : "video")}>
                <IconSliders />
              </button>
              <p className="hint" id="composer-hint" role="status" aria-live="polite" data-tone={tone}>
                {hint}
                {probeError >= 500 && !hint.includes("refused") && <> <a href="status.html">status page</a></>}
              </p>
            </div>
          </div>
        </form>
        {setup && <ServerNote kind={setup} onSettings={() => openSettings("instance")} />}
      </section>
      <CopyNote />
      <ProbePreview data={probe} />
    </>
  );
}

/* why nothing can download right now, and the two things that fix it */
function ServerNote({ kind, onSettings }: { kind: "empty" | "unreachable"; onSettings: () => void }) {
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    const ok = await checkInstance();
    setBusy(false);
    toast(ok ? "Connected." : "Still not answering.", ok ? "ok" : "warn");
  };
  const down = kind === "unreachable";
  return (
    <div className="setup-note sn2" id="setup-note" role="status" data-kind={kind}>
      <span className="sn2-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          {down ? (
            <><path d="M5 12.6a10 10 0 0 1 5.2-2.7" /><path d="M14.2 10a10 10 0 0 1 4.8 2.6" /><path d="M8.5 16a5 5 0 0 1 7 0" /><path d="M12 19.6h.01" /><path d="m3 3 18 18" /></>
          ) : (
            <><circle cx="12" cy="12" r="8.6" /><path d="M12 8v4.6" /><path d="M12 16h.01" /></>
          )}
        </svg>
      </span>
      <span className="sn2-copy">
        <b>{down ? "Can't reach the download server" : "No download server set"}</b>
        <span>{down ? "Trying again every 20 seconds. Downloads work again as soon as it answers." : "Add a server in settings to start downloading."}</span>
      </span>
      <span className="sn2-actions">
        {down && <button type="button" className="ghost-btn small" disabled={busy} aria-busy={busy} onClick={() => void retry()}>{busy ? "checking…" : "retry now"}</button>}
        <button type="button" className="ghost-btn small" onClick={onSettings}>{down ? "server settings" : "add server"}</button>
      </span>
    </div>
  );
}

function CopyNote() {
  const [done, setDone] = useState(false);
  const onClick = async () => {
    const ok = await copyText(location.origin + location.pathname.replace(/[^/]*$/, ""));
    if (!ok) return toast("Couldn't copy the link.", "warn");
    setDone(true);
    setTimeout(() => setDone(false), 1600);
  };
  return (
    <>
      <button type="button" className={cx("composer-note", done && "is-copied")} id="composer-note" title="copy the link to this site" onClick={() => void onClick()}>
        <span className="cn-text">
          paste a link, or prefix it:{" "}
          <span className="cn-swap">
            <b className="cn-link">mdown.cc/&lt;link&gt;</b>
            <span className="cn-done" aria-hidden="true"><IconCheck /> link copied</span>
          </span>
          <span className="sr-only">. pressing this copies the site link</span>
        </span>
      </button>
      <span className="sr-only" role="status" aria-live="polite">{done ? "link copied" : ""}</span>
    </>
  );
}

function ProbePreview({ data }: { data: ProbeData | null }) {
  const on = !!(data && data.status === "ok");
  const est = data?.estimate;
  const bits: string[] = [];
  if (data?.tooLong) bits.push("too long for this server");
  if (est?.bytes) bits.push((est.exact ? "~" : "≈") + " " + formatBytes(est.bytes));
  if (data?.duration) bits.push(clockTime(data.duration));
  if (est?.height) bits.push(est.height + "p");
  const thumb = data?.thumbnail && /^data:image\//.test(data.thumbnail) ? data.thumbnail : "";
  return (
    <div className={cx("probe-preview", on && "is-on")} id="probe-preview" aria-hidden={!on}>
      <div className="probe-inner">
        <span className="probe-thumb" data-empty={thumb ? "false" : "true"} aria-hidden="true"
          style={thumb ? { backgroundImage: `url("${thumb}")` } : undefined} />
        <span className="probe-title" title={data?.title || ""}>{data?.title || ""}</span>
        <span className="probe-meta">{bits.join(" · ")}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* a deep link to YouTube asks what kind of download was meant          */
/* ------------------------------------------------------------------ */

let setQuick: ((v: { url: string; host: string } | null) => void) | null = null;
export function askWhatToDownload(url: string, host: string) {
  setQuick?.({ url, host });
}

function QuickPick() {
  const [pick, setPick] = useState<{ url: string; host: string } | null>(null);
  setQuick = setPick;
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (pick) first.current?.focus();
    if (!pick) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPick(null);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pick]);
  if (!pick) return null;
  const music = /^music\./i.test(pick.host);
  const choose = (mode: string) => {
    setPick(null);
    void submitUrls(pick.url, mode);
  };
  const options: [string, string][] = [["audio", "audio only"], ["auto", "video + audio"], ["mute", "video only"]];
  return (
    <div className="quickpick" id="quickpick">
      <p className="quickpick-q"><b>{music ? "YouTube Music link" : "YouTube link"}</b>: download as</p>
      <div className="quickpick-actions" role="group" aria-label="Choose what to download">
        {options.map(([mode, label]) => {
          const isDefault = mode === (music ? "audio" : "auto");
          return (
            <button key={mode} ref={isDefault ? first : undefined} type="button" className="quickpick-btn" data-pick={mode}
              data-default={isDefault ? "true" : "false"} onClick={() => choose(mode)}>{label}</button>
          );
        })}
      </div>
      <button type="button" className="quickpick-close" aria-label="dismiss" onClick={() => setPick(null)}>
        <span className="kbd-only">esc</span><span className="tap-only">close</span>
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* recent links                                                         */
/* ------------------------------------------------------------------ */

function Recent() {
  const list = useStore(historyStore);
  if (!list.length) return null;
  const seen = new Set<string>();
  const shown = list.filter((url) => {
    const host = hostOf(url) || url;
    if (seen.has(host) || seen.size >= 4) return false;
    seen.add(host);
    return true;
  });
  return (
    <p className="recent-line" id="recent">
      <span className="recent-label">recent</span>
      {shown.map((url) => (
        <button key={url} type="button" className="recent-item" title={url} onClick={() => {
          setText(url);
          document.getElementById("url-input")?.focus();
        }}>
          <Mark className="recent-mark" service={detectService(url)?.id} />
          <span>{hostOf(url) || url}</span>
        </button>
      ))}
      <button type="button" className="recent-clear" aria-label="clear recent links" onClick={() => {
        historyStore.set([]);
        toast("Recent links cleared", "ok");
      }}>clear</button>
    </p>
  );
}

export function DownloadView({ hidden }: { hidden: boolean }) {
  return (
    <main className="wrap" data-view-panel="download" id="download-view" hidden={hidden}>
      <div className="hero">
        <h1 className="hero-logo">
          <span className="hero-mark" aria-hidden="true"><BrandMark /></span>
          <span className="hero-word"><span className="hero-type"><span className="hero-word-m">m</span><span className="hero-word-down">down</span><span className="hero-word-dot">.</span><span className="hero-word-sub">cc</span></span></span>
          <span className="sr-only">, a media downloader for video and audio</span>
        </h1>
        <Composer />
        <QuickPick />
      </div>
      <nav className="tool-strip" aria-label="Tools that run in your browser">
        <a className="tool-card" href="#remux" data-view="remux" onClick={onNav("remux")}>
          <span className="tool-card-icon" aria-hidden="true"><IconRemux /></span>
          <span className="tool-card-body"><b>remux</b><span>fix what won't play</span></span>
        </a>
        <a className="tool-card" href="#subs" data-view="subs" onClick={onNav("subs")}>
          <span className="tool-card-icon" aria-hidden="true"><IconSubs /></span>
          <span className="tool-card-body"><b>subtitles</b><span>export .srt</span></span>
        </a>
        <a className="tool-card" href="#clean" data-view="clean" onClick={onNav("clean")}>
          <span className="tool-card-icon" aria-hidden="true"><IconSliders /></span>
          <span className="tool-card-body"><b>metadata</b><span>strip tags</span></span>
        </a>
      </nav>
      <Recent />
      <Board />
    </main>
  );
}
