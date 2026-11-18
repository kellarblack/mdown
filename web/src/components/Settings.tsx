import { useEffect, useRef, useState } from "react";
import { checkInstance, formatUptime, instanceHost } from "../api";
import { DEFAULT_SETTINGS, type Settings } from "../constants";
import { buildBody, clearAll, effectiveMode, queueStore, audioExt } from "../queue";
import { historyStore, instanceStore, setSetting, settingsStore, toast, uiStore, useStore } from "../store";
import { IconClose, IconFile, NavIcons } from "../icons";
import { Mark } from "./Queue";
import { cx, normalizeInstance } from "../util";
import { useFocusTrap } from "./Modal";

type Key = keyof Settings;

function Seg({ k, label, options, wrap, suffix, disabled }: {
  k: Key; label: string; options: [string, string][]; wrap?: boolean; suffix?: string; disabled?: boolean;
}) {
  const value = String(useStore(settingsStore, (s) => s[k]));
  return (
    <div className={cx("seg", wrap && "wrap", disabled && "is-disabled")} data-setting={k} role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" data-value={v} role="radio" aria-checked={value === v} disabled={disabled} aria-disabled={disabled}
          onClick={() => {
            const next = k === "concurrency" ? Number(v) : v;
            setSetting(k, next as never);
          }}>{text}</button>
      ))}
      {suffix && <span className="seg-suffix">{suffix}</span>}
    </div>
  );
}

function Switch({ k, id, label, help }: { k: Key; id: string; label: string; help: string }) {
  const value = !!useStore(settingsStore, (s) => s[k]);
  return (
    <div className="field">
      <label className="switch-row" htmlFor={id}>
        <span>
          <span className="field-label">{label}</span>
          <span className="field-help">{help}</span>
        </span>
        <input type="checkbox" id={id} className="switch" data-setting={k} checked={value} onChange={(e) => setSetting(k, e.target.checked as never)} />
      </label>
    </div>
  );
}

function Select({ k, id, options }: { k: Key; id: string; options: [string, string][] }) {
  const value = String(useStore(settingsStore, (s) => s[k]));
  return (
    <select id={id} className="select" data-setting={k} value={value} onChange={(e) => setSetting(k, e.target.value as never)}>
      {options.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
    </select>
  );
}

const SECTIONS: [string, string][] = [
  ["appearance", "appearance"], ["video", "video"], ["audio", "audio"], ["output", "files"],
  ["privacy", "privacy"], ["advanced", "advanced"], ["instance", "server"],
];

const DUBS: [string, string][] = [["original", "original"], ["en", "English"], ["es", "español"], ["pt", "português"], ["fr", "français"], ["de", "Deutsch"], ["ru", "русский"], ["zh", "中文"], ["ja", "日本語"], ["ko", "한국어"], ["hi", "हिन्दी"], ["ar", "العربية"], ["uk", "українська"]];
const SUBS: [string, string][] = [["none", "none"], ["en", "English"], ["es", "español"], ["pt", "português"], ["fr", "français"], ["de", "Deutsch"], ["it", "italiano"], ["nl", "Nederlands"], ["pl", "polski"], ["ru", "русский"], ["uk", "українська"], ["tr", "Türkçe"], ["ar", "العربية"], ["he", "עברית"], ["hi", "हिन्दी"], ["bn", "বাংলা"], ["ja", "日本語"], ["ko", "한국어"], ["zh", "中文"], ["vi", "Tiếng Việt"], ["id", "Indonesia"], ["th", "ไทย"]];

function FilePreview() {
  const s = useStore(settingsStore);
  const mode = s.downloadMode;
  const quality = s.videoQuality + "p";
  const codec = s.youtubeVideoCodec;
  const container = s.youtubeVideoContainer === "auto" ? (codec === "h264" ? "mp4" : mode === "auto" ? "webm" : "mkv") : s.youtubeVideoContainer;
  const names: Record<string, string> = {
    classic: "Video Title." + container,
    basic: "Video Title - Video Author (" + quality + ")." + container,
    pretty: "Video Title (" + quality + ")." + container,
    nerdy: "Video Title_" + quality + "_" + codec + "_Video Author." + container,
  };
  const isAudio = mode === "audio";
  const mute = s.muteVideo;
  return (
    <div className="file-preview" id="file-preview" aria-live="polite">
      <span className="fp-icon" aria-hidden="true"><IconFile /></span>
      <span className="fp-body">
        <b>{isAudio ? "Audio Title - Audio Author." + audioExt() : names[s.filenameStyle] || names.basic}</b>
        <span className="fp-meta">
          {isAudio
            ? s.audioFormat === "best" ? "source · untouched" : s.audioFormat + " · " + s.audioBitrate + " kb/s" + (s.audioCovers ? " · cover art" : "")
            : container + " · " + quality + " · " + (mute ? "no sound" : codec)}
        </span>
      </span>
      <span className="fp-tag">{isAudio ? "audio" : mute ? "silent" : "video"}</span>
    </div>
  );
}

function InstancePane() {
  const instance = useStore(settingsStore, (s) => s.instance);
  const apiKey = useStore(settingsStore, (s) => s.apiKey);
  const inst = useStore(instanceStore);
  const [draft, setDraft] = useState(instance);
  useEffect(() => setDraft(instance), [instance]);
  const commit = () => {
    const normalized = normalizeInstance(draft);
    setSetting("instance", normalized || draft.trim());
    if (normalized) void checkInstance();
  };
  const base = normalizeInstance(instance);
  const services = inst.info?.services || [];
  const cardState = inst.state === "ok" ? "ok" : inst.state === "checking" ? "checking" : inst.state === "empty" ? "empty" : inst.state === "unknown" ? "empty" : "bad";
  const title = { ok: "Connected", checking: "Contacting instance…", empty: base ? "Not checked" : "Not connected", bad: "Can't reach this instance" }[cardState];
  return (
    <section className="pane is-active" data-pane="instance">
      <p className="pane-lede">Downloads happen on a server.</p>
      <div className="field">
        <label className="field-label" htmlFor="instance-url">Server</label>
        <div className="field-row">
          <input type="url" id="instance-url" className="text-input" placeholder="https://api.example.com" spellCheck={false} autoComplete="off"
            value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              }
            }} />
          <button type="button" className="ghost-btn" onClick={commit}>Check</button>
        </div>
        <p className="field-help">The default one comes with the site. Change it only if you run your own.</p>
      </div>
      <div className="instance-card" data-state={cardState} title={inst.info?.version ? "version " + inst.info.version : undefined}>
        <div className="instance-card-head"><span className="dot" /><strong>{title}</strong></div>
        <dl className="instance-meta">
          {cardState === "ok" && (
            <>
              <div><dt>server</dt><dd>{instanceHost()}</dd></div>
              <div><dt>services</dt><dd>{(services.length || "unknown") + " · up " + (inst.info?.startTime ? formatUptime(inst.info.startTime) : "unknown")}</dd></div>
              {inst.info?.streaming && <div><dt>transfer</dt><dd>streams while it fetches</dd></div>}
            </>
          )}
        </dl>
        <p className="instance-error" hidden={!inst.error}>{inst.error}</p>
        <p className="instance-links">
          <a href="status.html" target="_blank" rel="noopener">status page</a>
          <span aria-hidden="true">·</span>
          <a href={base ? base.replace(/\/+$/, "") + "/health" : "#"} target="_blank" rel="noopener">health</a>
        </p>
      </div>
      <details className="pane-more">
        <summary>API key</summary>
        <div className="field">
          <label className="field-label" htmlFor="api-key">Key <span className="optional">only if the server asks</span></label>
          <input type="password" id="api-key" className="text-input" placeholder={apiKey ? "saved" : "paste instance api key"} spellCheck={false}
            autoComplete="off" value={apiKey} onChange={(e) => setSetting("apiKey", e.target.value.trim())} />
          <p className="field-help">Stored in this browser. Sent with each download.</p>
        </div>
      </details>
      {services.length > 0 && (
        <details className="pane-more" id="services-card">
          <summary>Services <span className="count">{services.length}</span></summary>
          <div className="chips">
            {services.map((service) => (
              <span key={service} className="chip" title={service}>
                <Mark service={service} />
                <span className="chip-name">{service}</span>
              </span>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function AdvancedPane() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [armed, setArmed] = useState(false);
  const settings = useStore(settingsStore);
  const { items } = useStore(queueStore);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  const sample = items.length ? items[items.length - 1]!.url : "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const preview = JSON.stringify(buildBody(sample, effectiveMode(sample, settings.downloadMode)), null, 2);
  const bookmarklet = "javascript:(()=>{location.href='" + location.origin + location.pathname.replace(/(index|donate)\.html$/, "") +
    "?url='+encodeURIComponent(location.href)})()";

  const exportSettings = () => {
    const blob = new Blob([JSON.stringify(settingsStore.get(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "mdown-settings.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast("Settings exported", "ok");
  };
  const importSettings = async (file: File) => {
    try {
      if (file.size > 64 * 1024) throw new Error();
      const parsed = JSON.parse(await file.text());
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      const clean: Partial<Settings> = {};
      for (const key of Object.keys(DEFAULT_SETTINGS) as Key[]) {
        if (key in parsed && typeof parsed[key] === typeof DEFAULT_SETTINGS[key]) (clean as Record<string, unknown>)[key] = parsed[key];
      }
      settingsStore.set({ ...DEFAULT_SETTINGS, ...clean, schema: 6 });
      void checkInstance();
      toast("Settings imported", "ok");
    } catch {
      toast("That file isn't valid settings JSON.", "err");
    }
  };
  return (
    <section className="pane is-active" data-pane="advanced">
      <p className="pane-lede">Rarely needed. Safe to leave alone.</p>
      <div className="field">
        <span className="field-label">Send the page you're on</span>
        <a className="ghost-btn" id="bookmarklet" href={bookmarklet} draggable onClick={(e) => {
          e.preventDefault();
          toast("Drag it to the bookmarks bar.", "info");
        }}>drag me to the bookmarks bar</a>
        <p className="field-help">Click it on any media page and the link lands here, already fetching.</p>
      </div>
      <div className="field">
        <span className="field-label">Downloads at once</span>
        <Seg k="concurrency" label="Parallel downloads" options={[["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"], ["5", "5"]]} />
        <p className="field-help">Higher is faster for batches, heavier on the server.</p>
      </div>
      <div className="field">
        <span className="field-label">Your data</span>
        <div className="field-row wrap-row">
          <button type="button" className="ghost-btn" onClick={exportSettings}>export</button>
          <button type="button" className="ghost-btn" onClick={() => fileInput.current?.click()}>import</button>
          <button type="button" className="ghost-btn danger" onClick={() => {
            if (!armed) return setArmed(true);
            setArmed(false);
            settingsStore.set({ ...DEFAULT_SETTINGS, instance: DEFAULT_SETTINGS.instance || "https://api.mdown.cc", theme: settingsStore.get().theme, schema: 6 });
            void checkInstance();
            toast("Settings reset", "ok");
          }}>{armed ? "sure?" : "reset all"}</button>
          <input type="file" ref={fileInput} accept="application/json,.json" hidden onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importSettings(file);
            e.target.value = "";
          }} />
        </div>
        <div className="field-row wrap-row">
          <button type="button" className="ghost-btn" onClick={() => {
            historyStore.set([]);
            toast("Recent links cleared", "ok");
          }}>clear recent</button>
          <button type="button" className="ghost-btn" onClick={() => {
            clearAll();
            toast("Queue cleared", "ok");
          }}>clear queue</button>
        </div>
        <p className="field-help">Settings and history live in this browser only.</p>
      </div>
      <details className="pane-more">
        <summary>What gets sent</summary>
        <pre className="code-block">{preview}</pre>
        <p className="field-help">Exactly what is POSTed to the server. No secrets are shown.</p>
      </details>
      <details className="pane-more">
        <summary>About</summary>
        <dl className="instance-meta">
          <div><dt>build</dt><dd>mdown.cc · react + go</dd></div>
          <div><dt>protocol</dt><dd>cobalt v11</dd></div>
          <div><dt>storage</dt><dd>localStorage</dd></div>
        </dl>
      </details>
    </section>
  );
}

function Pane({ name }: { name: string }) {
  const audioFormat = useStore(settingsStore, (s) => s.audioFormat);
  switch (name) {
    case "appearance":
      return (
        <section className="pane is-active" data-pane="appearance">
          <p className="pane-lede">How the site looks.</p>
          <div className="field">
            <span className="field-label">Theme</span>
            <Seg k="theme" label="Theme" options={[["auto", "system"], ["light", "light"], ["dark", "dark"]]} />
          </div>
        </section>
      );
    case "video":
      return (
        <section className="pane is-active" data-pane="video">
          <p className="pane-lede">What you get from a video link.</p>
          <div className="field">
            <span className="field-label">Default</span>
            <Seg k="downloadMode" label="Default download mode" options={[["auto", "auto"], ["audio", "audio"], ["video", "video"]]} />
            <p className="field-help"><b>auto</b> takes audio from a music link and video from everything else.</p>
          </div>
          <div className="field">
            <span className="field-label">Quality</span>
            <Seg k="videoQuality" label="Video quality" wrap options={[["4320", "8k"], ["2160", "4k"], ["1440", "1440p"], ["1080", "1080p"], ["720", "720p"], ["480", "480p"], ["360", "360p"], ["240", "240p"], ["144", "144p"]]} />
            <p className="field-help">The server gives you the closest it can serve. 1080p is the default.</p>
          </div>
          <Switch k="muteVideo" id="mute-video" label="No sound" help="Video mode without the audio track, for loops and b-roll." />
        </section>
      );
    case "audio":
      return (
        <section className="pane is-active" data-pane="audio">
          <p className="pane-lede">What you get from an audio link.</p>
          <div className="field">
            <span className="field-label">Format</span>
            <Seg k="audioFormat" label="Audio format" wrap options={[["best", "source"], ["mp3", "mp3"], ["ogg", "ogg"], ["opus", "opus"], ["wav", "wav"]]} />
            <p className="field-help"><code>source</code> keeps the original file. The rest are re-encoded by the server.</p>
          </div>
          <div className="field">
            <span className="field-label">Bitrate</span>
            <Seg k="audioBitrate" label="Audio bitrate" wrap suffix="kb/s" disabled={audioFormat === "wav" || audioFormat === "best"}
              options={[["128", "128"], ["96", "96"], ["64", "64"], ["8", "8"]]} />
            <p className="field-help">128 is already more than most sources serve.</p>
          </div>
          <Switch k="audioCovers" id="audio-covers" label="Cover art" help="Adds the thumbnail to mp3, ogg and opus." />
          <details className="pane-more">
            <summary>Dubs and TikTok sound</summary>
            <div className="field">
              <label className="field-label" htmlFor="dub-lang">Preferred audio track</label>
              <div className="field-row"><Select k="youtubeDubLang" id="dub-lang" options={DUBS} /></div>
              <p className="field-help">Used when the source has a dub. Otherwise you get the original.</p>
            </div>
            <Switch k="tiktokFullAudio" id="tiktok-audio" label="TikTok: original sound" help="The clip's own sound, not the reused track." />
          </details>
        </section>
      );
    case "output":
      return (
        <section className="pane is-active" data-pane="output">
          <p className="pane-lede">How files are named and handed over.</p>
          <div className="field">
            <span className="field-label">File name</span>
            <Seg k="filenameStyle" label="Filename style" options={[["classic", "classic"], ["basic", "basic"], ["pretty", "pretty"], ["nerdy", "nerdy"]]} />
            <FilePreview />
          </div>
          <div className="field">
            <span className="field-label">Saving</span>
            <Seg k="savingMethod" label="Saving method" wrap options={[["ask", "ask"], ["download", "download"], ["share", "share"], ["copy", "copy link"]]} />
            <p className="field-help"><b>ask</b> leaves the finished file on the row until you press save; the others save it straight away.</p>
          </div>
          <Switch k="disableMetadata" id="disable-metadata" label="Strip metadata" help="No title, artist or tags written into the file." />
          <details className="pane-more">
            <summary>Subtitles</summary>
            <div className="field">
              <label className="field-label" htmlFor="subtitle-lang">Language</label>
              <div className="field-row"><Select k="subtitleLang" id="subtitle-lang" options={SUBS} /></div>
              <p className="field-help">Added as a subtitle track when the source has one for that language.</p>
            </div>
          </details>
        </section>
      );
    case "privacy":
      return (
        <section className="pane is-active" data-pane="privacy">
          <p className="pane-lede">What leaves this tab.</p>
          <Switch k="alwaysProxy" id="always-proxy" label="Always use the server" help="The file never touches the source directly, but the thumbnail still does." />
          <div className="field">
            <span className="field-label">Split streams</span>
            <Seg k="localProcessing" label="Local processing" options={[["disabled", "server merges"], ["preferred", "ask me"], ["forced", "give me the command"]]} />
            <p className="field-help">Some videos arrive as separate picture and sound. The server can join them, or this page hands you a ready ffmpeg command and you do it yourself.</p>
          </div>
          <div className="field">
            <span className="field-label">On the server</span>
            <div className="notice"><strong>Not written down.</strong> The link, the file name and your address are not logged or stored, and there is no history to look up. A finished file exists on the server only long enough to hand it over, then it is deleted. The page and the file travel over HTTPS.</div>
          </div>
          <div className="field">
            <span className="field-label">Tracking</span>
            <div className="notice"><strong>None.</strong> Requests for links and files go to the server above. Thumbnails are loaded from the source, so that host sees your address. Nothing else does.</div>
          </div>
        </section>
      );
    case "advanced":
      return <AdvancedPane />;
    default:
      return <InstancePane />;
  }
}

export function SettingsSheet() {
  const { settingsOpen, settingsSection } = useStore(uiStore);
  const sheet = useRef<HTMLElement>(null);
  const nav = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const close = () => uiStore.set((s) => ({ ...s, settingsOpen: false }));
  useFocusTrap(settingsOpen, sheet, close);

  useEffect(() => {
    if (!settingsOpen) return;
    body.current?.scrollTo({ top: 0 });
    const button = nav.current?.querySelector<HTMLElement>(".sheet-nav-item.is-active");
    button?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [settingsOpen, settingsSection]);

  if (!settingsOpen) return null;
  return (
    <aside className="sheet" id="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title" ref={sheet}>
      <div className="sheet-backdrop" onClick={close} />
      <div className="sheet-panel">
        <header className="sheet-head">
          <div>
            <p className="sheet-tag">v2.0</p>
            <h2 id="settings-title">Settings</h2>
            <p className="sheet-sub">Stored in this browser only.</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close settings" onClick={close}><IconClose /></button>
        </header>
        <nav className="sheet-nav" aria-label="Settings sections" ref={nav}>
          {SECTIONS.map(([id, label]) => {
            const Icon = NavIcons[id]!;
            return (
              <button key={id} type="button" className={cx("sheet-nav-item", settingsSection === id && "is-active")} data-section={id}
                aria-current={settingsSection === id ? "true" : undefined}
                onClick={() => uiStore.set((s) => ({ ...s, settingsSection: id }))}>
                <span className="nav-ico" aria-hidden="true"><Icon /></span>
                <span className="nav-label">{label}</span>
              </button>
            );
          })}
        </nav>
        <div className="sheet-body" id="sheet-body" ref={body}>
          <Pane name={settingsSection} />
        </div>
      </div>
    </aside>
  );
}
