/* ============================================================
   mdown — front-end for the media-downloader API contract
   plain JavaScript, no build step, no dependencies.

   API contract: POST / with {url, downloadMode, videoQuality, audioFormat},
   answers {status:"tunnel", url, filename} or {status:"picker", ...}.
   ============================================================ */
(function () {
  "use strict";

  /* ----------------------------------------------------------
     constants
     ---------------------------------------------------------- */
  const SETTINGS_KEY = "mdown.settings";
  const HISTORY_KEY = "mdown.history";
  /* these held the previous name of this UI; read once, then drop */
  const LEGACY_SETTINGS_KEYS = ["mget.settings", "mediadownload.settings", "trawl.settings", "spool.settings", "cobalt.studio.settings"];
  const LEGACY_HISTORY_KEYS = ["mget.history", "mediadownload.history", "trawl.history", "spool.history", "cobalt.studio.history"];
  const MAX_CONCURRENT = 5;
  const MAX_URLS_PER_SUBMIT = 10;
  const HISTORY_LIMIT = 8;

  /* When you deploy, put your own API base URL here so visitors don't have to
     connect one themselves. Leave empty to require it. */
  const DEFAULT_INSTANCE = "https://api.mdown.cc";

  /* deliberate ceilings: the top tiers are the ones services paywall */
  const VIDEO_QUALITIES = ["4320", "2160", "1440", "1080", "720", "480", "360", "240", "144"];
  const AUDIO_BITRATES = ["128", "96", "64", "8"];
  const AUDIO_FORMATS = ["best", "mp3", "ogg", "wav", "opus"];
  const clampQuality = (value) => (VIDEO_QUALITIES.includes(String(value)) ? String(value) : "1080");
  const clampBitrate = (value) => (AUDIO_BITRATES.includes(String(value)) ? String(value) : "128");
  const clampFormat = (value) => (AUDIO_FORMATS.includes(String(value)) ? String(value) : "mp3");

  const DEFAULT_SETTINGS = {
    instance: "",
    apiKey: "",
    downloadMode: "auto",
    videoQuality: "1080",
    audioFormat: "mp3",
    audioBitrate: "128",
    audioCovers: true,
    filenameStyle: "basic",
    disableMetadata: false,
    alwaysProxy: false,
    localProcessing: "disabled",
    subtitleLang: "en",
    youtubeVideoCodec: "h264",
    youtubeVideoContainer: "auto",
    youtubeDubLang: "original",
    youtubeBetterAudio: false,
    youtubeHLS: false,
    convertGif: true,
    allowH265: false,
    tiktokFullAudio: false,
    savingMethod: "download",
    concurrency: 3,
    theme: "auto"
  };

  /* hostname → service id. wider than any single instance: this only drives
     detection and hints, the instance still decides what it can actually fetch. */
  const SERVICE_HOSTS = [
    ["youtube.com", "youtube"], ["youtu.be", "youtube"], ["youtube-nocookie.com", "youtube"],
    ["music.youtube.com", "youtube"],
    ["twitter.com", "twitter"], ["x.com", "twitter"],
    ["instagram.com", "instagram"], ["instagr.am", "instagram"],
    ["tiktok.com", "tiktok"], ["vt.tiktok.com", "tiktok"], ["douyin.com", "douyin"],
    ["reddit.com", "reddit"], ["redd.it", "reddit"],
    ["soundcloud.com", "soundcloud"], ["snd.sc", "soundcloud"],
    /* encrypted streaming: detected only so the UI can say why it won't work */
    ["spotify.com", "spotify"], ["deezer.com", "deezer"],
    ["tidal.com", "tidal"], ["music.apple.com", "apple-music"],
    ["bandcamp.com", "bandcamp"], ["mixcloud.com", "mixcloud"],
    ["audiomack.com", "audiomack"], ["hearthis.at", "hearthis"],
    ["bilibili.com", "bilibili"], ["b23.tv", "bilibili"],
    ["vimeo.com", "vimeo"], ["dailymotion.com", "dailymotion"], ["dai.ly", "dailymotion"],
    ["twitch.tv", "twitch"], ["clips.twitch.tv", "twitch"],
    ["kick.com", "kick"], ["rumble.com", "rumble"], ["odysee.com", "odysee"],
    ["streamable.com", "streamable"], ["coub.com", "coub"],
    ["facebook.com", "facebook"], ["fb.watch", "facebook"],
    ["threads.net", "threads"], ["threads.com", "threads"],
    ["snapchat.com", "snapchat"], ["rutube.ru", "rutube"],
    ["ok.ru", "ok"], ["vk.com", "vk"], ["vkvideo.ru", "vk"],
    ["loom.com", "loom"], ["tumblr.com", "tumblr"], ["bsky.app", "bluesky"],
    ["newgrounds.com", "newgrounds"], ["pixiv.net", "pixiv"],
    ["pinterest.com", "pinterest"], ["pin.it", "pinterest"],
    ["xiaohongshu.com", "xiaohongshu"], ["imgur.com", "imgur"],
    ["giphy.com", "giphy"], ["tenor.com", "tenor"], ["9gag.com", "9gag"]
  ];

  /* services this UI deliberately does not offer */
  const HIDDEN_SERVICES = new Set(["pinterest"]);

  /* If you ever own one of these lookalike hosts, a link typed into it is
     rewritten to the real service: yout.cc/watch?v=x -> youtube.com/watch?v=x */
  const SERVICE_ALIASES = {
    "yout.cc": "youtube.com",
    "youtu.cc": "youtube.com",
    "sound.cc": "soundcloud.com",
    "insta.cc": "instagram.com",
    "tiktok.cc": "tiktok.com",
    "twitch.cc": "twitch.tv",
    "vimeo.cc": "vimeo.com",
    "reddit.cc": "reddit.com"
  };

  /* paths that are this app, never a link */
  const APP_PATHS = new Set(["", "index.html"]);

  /* services that are almost always wanted as audio */
  /* services that carry no video worth downloading — these queue as audio */
  const AUDIO_FIRST = new Set(["soundcloud", "bandcamp", "mixcloud", "audiomack", "hearthis"]);

  /* DRM-protected services. Nothing here can download from them, and pretending
     otherwise would be a lie, so they get a straight answer instead. */
  const DRM_SERVICES = new Map([
    ["spotify", "Spotify audio is encrypted — this can't download from it. The same track is usually on YouTube or SoundCloud."],
    ["deezer", "Deezer audio is encrypted — this can't download from it. Try the same track on YouTube or SoundCloud."],
    ["tidal", "Tidal audio is encrypted — this can't download from it. Try the same track on YouTube or SoundCloud."],
    ["apple-music", "Apple Music audio is encrypted — this can't download from it. Try the same track on YouTube or SoundCloud."]
  ]);

  const ERROR_TEXT = {
    "api.url.invalid": "That link isn't valid for any supported service.",
    "api.url.unsupported": "This service isn't supported by the instance.",
    "api.url.missing": "No link was sent.",
    "api.url.invalid_input": "The instance rejected that input.",
    "api.service.unsupported": "This service isn't supported by the instance.",
    "api.service.disabled": "This service is disabled on the instance.",
    "api.service.not_implemented": "This service isn't implemented yet.",
    "api.content.video.unavailable": "The video is unavailable.",
    "api.content.video.live": "Live streams can't be downloaded.",
    "api.content.video.private": "The video is private.",
    "api.content.video.age": "The video is age-restricted; the instance can't access it.",
    "api.content.video.region": "The video is region-locked.",
    "api.content.video.payment": "The video requires a paid subscription.",
    "api.content.too_long": "The media is longer than this instance allows.",
    "api.content.video.too_long": "The video is longer than this instance allows.",
    "api.content.post.unavailable": "The post is unavailable.",
    "api.content.post.private": "The post is private.",
    "api.content.post.age": "The post is age-restricted.",
    "api.content.post.region": "The post is region-locked.",
    "api.content.short_link.unsupported": "Short links from this service aren't supported.",
    "api.rate_limit": "Rate limit reached. Try again in a moment.",
    "api.auth.apikey.missing": "This instance needs an API key — add it in Settings → Server.",
    "api.auth.apikey.invalid": "That API key was rejected. Check it in Settings → Server.",
    "api.auth.bearer.missing": "This instance requires a session token.",
    "api.auth.bearer.invalid": "The session token was rejected.",
    "api.auth.turnstile.missing": "This instance requires a turnstile challenge.",
    "api.auth.turnstile.invalid": "The turnstile challenge failed.",
    "api.instance.version_mismatch": "This API version isn't supported.",
    "api.instance.not_ready": "The instance is still starting up.",
    "api.instance.timed_out": "The instance took too long and gave up. Try a shorter link.",
    "api.auth.origin": "This instance only answers its own site.",
    "api.content.too_large": "The file would be bigger than this instance allows.",
    "api.content.video.unavailable": "The video is unavailable."
  };

  /* ----------------------------------------------------------
     state
     ---------------------------------------------------------- */
  let settings = loadSettings();
  let recentLinks = loadHistory();
  let queue = [];
  let active = 0;
  let rateRemaining = null;
  let instanceInfo = null;
  let lastService = null;
  let queueTicker = null;
  let idCounter = 0;

  /* ----------------------------------------------------------
     tiny helpers
     ---------------------------------------------------------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function el(tag, attrs, html) {
    const node = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === "class") node.className = attrs[k];
      else if (k === "text") node.textContent = attrs[k];
      else node.setAttribute(k, attrs[k]);
    }
    if (html != null) node.innerHTML = html;
    return node;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function formatBytes(bytes) {
    if (!bytes || bytes < 0) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
    return (value < 10 && i > 0 ? value.toFixed(1) : Math.round(value)) + " " + units[i];
  }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); }
    catch { return ""; }
  }

  function detectService(url) {
    const host = hostOf(url);
    if (!host) return null;
    for (const [suffix, id] of SERVICE_HOSTS) {
      if (host === suffix || host.endsWith("." + suffix)) {
        return { id, host, hidden: HIDDEN_SERVICES.has(id) };
      }
    }
    return { id: null, host, hidden: false };
  }

  function normalizeInstance(value) {
    let raw = String(value || "").trim();
    if (!raw) return "";
    if (!/^https?:\/\//i.test(raw)) {
      const hostPart = raw.split("/")[0].replace(/:\d+$/, "").toLowerCase();
      const isLocal =
        hostPart === "localhost" ||
        hostPart === "127.0.0.1" ||
        hostPart === "[::1]" ||
        hostPart.endsWith(".local") ||
        /^10\./.test(hostPart) ||
        /^192\.168\./.test(hostPart) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostPart);
      raw = (isLocal ? "http://" : "https://") + raw;
    }
    try {
      const u = new URL(raw);
      if (u.protocol !== "http:" && u.protocol !== "https:") return "";
      const path = u.pathname.replace(/\/+$/, "");
      return u.origin + (path === "" ? "" : path);
    } catch { return ""; }
  }

  function apiEndpoint() {
    const base = normalizeInstance(settings.instance);
    return base ? base.replace(/\/+$/, "") + "/" : "";
  }

  function authHeaders() {
    const key = String(settings.apiKey || "").trim();
    return key ? { Authorization: "Api-Key " + key } : {};
  }

  /* ----------------------------------------------------------
     persistence
     ---------------------------------------------------------- */
  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY) || migrateLegacy(LEGACY_SETTINGS_KEYS, SETTINGS_KEY);
      if (!raw) {
        // first visit, and the only case where the built-in instance matters:
        // without this line the default never applies to anyone new
        const fresh = Object.assign({}, DEFAULT_SETTINGS);
        if (DEFAULT_INSTANCE) fresh.instance = DEFAULT_INSTANCE;
        return fresh;
      }
      const parsed = JSON.parse(raw);
      const merged = Object.assign({}, DEFAULT_SETTINGS, parsed && typeof parsed === "object" ? parsed : {});
      if (!merged.instance && DEFAULT_INSTANCE) merged.instance = DEFAULT_INSTANCE;

      /* v2: subtitles now default to English instead of "none" */
      if (!merged.schema || merged.schema < 2) {
        if (!merged.subtitleLang || merged.subtitleLang === "none") merged.subtitleLang = "en";
        merged.schema = 2;
      }

      /* v3: 1080p / 128 kb/s ceilings, no untouched-source audio */
      if (!merged.schema || merged.schema < 3) {
        merged.videoQuality = clampQuality(merged.videoQuality);
        merged.audioBitrate = clampBitrate(merged.audioBitrate);
        merged.audioFormat = clampFormat(merged.audioFormat);
        merged.youtubeBetterAudio = false;
        merged.youtubeHLS = false;
        merged.schema = 3;
      }

      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged)); } catch (e) {}
      return merged;
    } catch { return Object.assign({}, DEFAULT_SETTINGS); }
  }

  /* copy the first surviving old key into the current name, then drop the rest */
  function migrateLegacy(fromKeys, toKey) {
    try {
      for (const key of fromKeys) {
        const value = localStorage.getItem(key);
        if (value) {
          localStorage.setItem(toKey, value);
          fromKeys.forEach((old) => localStorage.removeItem(old));
          return value;
        }
      }
      return null;
    } catch { return null; }
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
  }

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY) || migrateLegacy(LEGACY_HISTORY_KEYS, HISTORY_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((u) => typeof u === "string").slice(0, HISTORY_LIMIT) : [];
    } catch { return []; }
  }

  function saveHistory() {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(recentLinks)); } catch {}
  }

  /* ----------------------------------------------------------
     theme
     ---------------------------------------------------------- */
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

  function resolveTheme() {
    if (settings.theme === "light" || settings.theme === "dark") return settings.theme;
    return darkQuery.matches ? "dark" : "light";
  }

  function applyTheme() {
    document.documentElement.setAttribute("data-theme", resolveTheme());
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", resolveTheme() === "dark" ? "#0a0a0b" : "#ffffff");
  }

  darkQuery.addEventListener("change", () => { if (settings.theme === "auto") applyTheme(); });

  /* ----------------------------------------------------------
     dom refs
     ---------------------------------------------------------- */
  const dom = {
    form: $("#fetch-form"),
    input: $("#url-input"),
    clearBtn: $("#clear-btn"),
    pasteBtn: $("#paste-btn"),
    fetchBtn: $("#fetch-btn"),
    modes: $$(".mode"),
    formatNote: $("#format-note"),
    hint: $("#composer-hint"),
    badge: $("#service-badge"),
    serviceMark: $("#service-mark"),
    serviceName: $("#service-name"),
    composer: $("#composer"),
    probePreview: $("#probe-preview"),
    probeThumb: $("#probe-thumb"),
    probeTitle: $("#probe-title"),
    probeMeta: $("#probe-meta"),
    setupNote: $("#setup-note"),
    setupLead: $("#setup-lead"),
    setupTail: $("#setup-tail"),
    setupButton: $("#setup-open-settings"),
    donateLink: $("#donate-link"),
    openHealth: $("#open-health"),
    openSources: $("#open-sources"),
    sourcesPanel: $("#sources-panel"),
    sourcesCount: $("#sources-count"),
    sourcesWrap: $("#sources-wrap"),
    donateWrap: $("#donate-wrap"),
    setupOpenSettings: $("#setup-open-settings"),
    quickpick: $("#quickpick"),
    quickpickService: $("#quickpick-service"),
    quickpickButtons: $$("#quickpick [data-pick]"),
    quickpickCancel: $("#quickpick-cancel"),
    recent: $("#recent"),
    queueList: $("#queue-list"),
    queueDock: $("#queue-dock"),
    queueToggle: $("#queue-toggle"),
    queuePanel: $("#queue-panel"),
    queueBadge: $("#queue-badge"),
    queueCount: $("#queue-count"),
    queueStats: $("#queue-stats"),
    emptyState: $("#empty-state"),
    clearFinished: $("#clear-finished"),
    servicesCard: $("#services-card"),
    servicesChips: $("#services-chips"),
    servicesCount: $("#services-count"),
    refreshInstance: $("#refresh-instance"),
    instancePill: $("#instance-pill"),
    instancePillLabel: $("#instance-pill-label"),
    healthPop: $("#health-pop"),
    hpState: $("#hp-state"),
    hpUptime: $("#hp-uptime"),
    hpStrip: $("#hp-strip"),
    hpPct: $("#hp-pct"),
    hpSettings: $("#hp-settings"),
    sheet: $("#settings"),
    sheetBody: $("#sheet-body"),
    instanceUrl: $("#instance-url"),
    apiKey: $("#api-key"),
    checkInstance: $("#check-instance"),
    instanceDetail: $("#instance-detail"),
    instanceDetailTitle: $("#instance-detail-title"),
    instanceMeta: $("#instance-meta"),
    instanceError: $("#instance-error"),
    previewVideo: $("#preview-video"),
    previewMeta: $("#preview-meta"),
    previewTag: $("#preview-tag"),
    requestPreview: $("#request-preview"),
    modal: $("#modal"),
    modalTitle: $("#modal-title"),
    modalBody: $("#modal-body"),
    modalFoot: $("#modal-foot"),
    modalClose: $("#modal-close"),
    toasts: $("#toasts"),
    footerVersion: $("#footer-version")
  };

  /* ----------------------------------------------------------
     toasts
     ---------------------------------------------------------- */
  /* Toasts are a queue with a ceiling, not a log. The same message twice in a
     row is one message that lasts longer; the stack never exceeds three; and a
     message that keeps arriving cannot outlive its welcome. */
  const TOAST_LIMIT = 3;
  const TOAST_REPEAT_MS = 2400;
  const toastState = { key: "", at: 0, node: null, timer: null };

  function dismissToast(node) {
    if (!node || !node.isConnected) return;
    node.classList.add("is-leaving");
    setTimeout(() => node.remove(), 200);
  }

  function toast(message, tone) {
    const kind = tone || "info";
    const key = kind + "|" + message;
    const now = Date.now();
    const life = kind === "err" ? 6000 : 3800;

    if (key === toastState.key && now - toastState.at < TOAST_REPEAT_MS &&
        toastState.node && toastState.node.isConnected) {
      toastState.at = now;
      const node = toastState.node;
      node.classList.remove("is-pulse");
      void node.offsetWidth;  /* restart the pulse without a timer */
      node.classList.add("is-pulse");
      clearTimeout(toastState.timer);
      toastState.timer = setTimeout(() => dismissToast(node), life);
      return;
    }

    while (dom.toasts.children.length >= TOAST_LIMIT) {
      dom.toasts.firstElementChild.remove();
    }

    const node = el("div", { class: "toast", "data-tone": kind });
    node.appendChild(el("span", { class: "dot" }));
    node.appendChild(el("span", { text: message }));
    dom.toasts.appendChild(node);

    toastState.key = key;
    toastState.at = now;
    toastState.node = node;
    clearTimeout(toastState.timer);
    toastState.timer = setTimeout(() => dismissToast(node), life);
  }

  /* The field says no without a crowd: one short shake, never two at once. */
  let nudgeAt = 0;
  function nudgeComposer() {
    if (!dom.composer) return;
    const now = Date.now();
    if (now - nudgeAt < 500) return;
    nudgeAt = now;
    dom.composer.classList.remove("is-nudging");
    void dom.composer.offsetWidth;
    dom.composer.classList.add("is-nudging");
    setTimeout(() => dom.composer.classList.remove("is-nudging"), 300);
  }

  /* ----------------------------------------------------------
     composer
     ---------------------------------------------------------- */
  function autosize() {
    dom.input.style.height = "auto";
    dom.input.style.height = Math.min(dom.input.scrollHeight, 168) + "px";
  }

  function parseUrls(text) {
    const seen = new Set();
    const out = [];
    String(text || "")
      .split(/[\s,]+/)
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .forEach((chunk) => {
        let candidate = chunk;
        if (!/^https?:\/\//i.test(candidate) && /^[\w.-]+\.[a-z]{2,}\//i.test(candidate)) {
          candidate = "https://" + candidate;
        }
        try {
          const u = new URL(candidate);
          if (u.protocol !== "http:" && u.protocol !== "https:") return;
          const key = u.href;
          if (seen.has(key)) return;
          seen.add(key);
          out.push(u.href);
        } catch { /* ignore non-links */ }
      });
    return out;
  }

  function updateComposerState() {
    const text = dom.input.value;
    scheduleProbe();
    dom.clearBtn.hidden = text.length === 0;
    autosize();

    const urls = parseUrls(text);
    const first = urls[0] || "";
    const detected = first ? detectService(first) : null;
    const service = detected && detected.id ? detected.id : null;

    /* the arrow stays quiet until there is something to fetch. it never
       appears or disappears, only arms, so the footer does not move */
    const armed = urls.length >= 1;
    if (dom.fetchBtn) {
      if (dom.fetchBtn.dataset.armed !== String(armed)) {
        dom.fetchBtn.dataset.armed = armed ? "true" : "false";
        dom.fetchBtn.setAttribute("aria-label", armed ? "fetch" : "paste a link first");
        /* an invisible control must not be a tab stop */
        dom.fetchBtn.tabIndex = armed ? 0 : -1;
        dom.fetchBtn.setAttribute("aria-hidden", armed ? "false" : "true");
      }
    }
    if (service && service !== lastService && dom.serviceMark) {
      lastService = service;
      if (typeof dom.serviceMark.animate === "function") {
        dom.serviceMark.animate(
          [{ transform: "scale(.72)", opacity: 0.35 }, { transform: "none", opacity: 1 }],
          { duration: 220, easing: "cubic-bezier(.22,.8,.3,1)" }
        );
      }
    } else if (!service) {
      lastService = null;
    }

    dom.badge.dataset.empty = service ? "false" : "true";
    if (dom.serviceMark) {
      const mark = markForService(service);
      if (dom.serviceMark.innerHTML !== mark) dom.serviceMark.innerHTML = mark;
    }
    if (dom.serviceName) {
      dom.serviceName.hidden = !service;
      dom.serviceName.textContent = service || "";
    }
    /* a bare span cannot take aria-label; role=status makes the announcement
       legal and stops it reading "unknown" before anything is pasted */
    dom.badge.setAttribute("role", "status");
    if (service) dom.badge.setAttribute("aria-label", "detected: " + service);
    else dom.badge.removeAttribute("aria-label");
    dom.hint.dataset.action = "";
    dom.hint.dataset.tone = "";
    dom.hint.textContent = "";

    if (!text.trim()) {
      if (urls.length > 1) dom.hint.textContent = urls.length + " links";
      return;
    }
    if (!urls.length) {
      dom.hint.textContent = "not a link";
      dom.hint.dataset.tone = "err";
      return;
    }
    if (urls.length > 1) {
      dom.hint.textContent = urls.length + " links";
      return;
    }
    if (service && HIDDEN_SERVICES.has(service)) {
      dom.hint.textContent = service + " isn't supported";
      dom.hint.dataset.tone = "warn";
      return;
    }
    if (service && DRM_SERVICES.has(service)) {
      dom.hint.textContent = "encrypted · can't download";
      dom.hint.dataset.tone = "warn";
      return;
    }
    if (service) {
      const known = instanceInfo && Array.isArray(instanceInfo.services) ? instanceInfo.services : null;
      if (known && known.length && !known.includes(service)) {
        dom.hint.textContent = "not on this API";
        dom.hint.dataset.tone = "warn";
        return;
      }
      if (settings.downloadMode === "auto" && AUDIO_FIRST.has(service)) {
        dom.hint.textContent = "audio only";
      }
      return;
    }
    dom.hint.textContent = detected.host || "";
  }

  function qualityLabel() {
    return settings.videoQuality + "p";
  }

  function audioExt() {
    /* the untouched stream keeps whatever container the source used */
    return settings.audioFormat === "best" ? "m4a" : settings.audioFormat;
  }

  function audioLabel() {
    if (settings.audioFormat === "best") return "source";
    if (settings.audioFormat === "wav") return "wav";
    return settings.audioFormat + " · " + settings.audioBitrate + "k";
  }

  function modeSummary(mode) {
    if (mode === "audio") return audioLabel();
    const container = settings.youtubeVideoContainer === "auto" ? "mp4" : settings.youtubeVideoContainer;
    if (mode === "mute") return container + " · no audio";
    return container + " · " + qualityLabel();
  }

  function renderModes() {
    dom.modes.forEach((btn) => {
      const mode = btn.dataset.mode;
      const on = mode === settings.downloadMode;
      btn.setAttribute("aria-checked", on ? "true" : "false");
      
    });
    if (dom.formatNote) dom.formatNote.textContent = modeSummary(settings.downloadMode);
    updateFileNamePreview();
    $$('[data-setting="downloadMode"] button').forEach((btn) => {
      btn.setAttribute("aria-checked", btn.dataset.value === settings.downloadMode ? "true" : "false");
    });
  }

  /* bitrate only means something for lossy output */
  function syncAudioControls() {
    const off = settings.audioFormat === "wav" || settings.audioFormat === "best";
    $$('[data-setting="audioBitrate"] button').forEach((btn) => {
      btn.disabled = off;
      btn.setAttribute("aria-disabled", off ? "true" : "false");
    });
    const seg = $('[data-setting="audioBitrate"]');
    if (seg) seg.classList.toggle("is-disabled", off);
  }

  /**
   * A link can arrive three ways:
   *   mdown.cc/https://youtube.com/watch?v=x
   *   mdown.cc/?url=https://youtube.com/watch?v=x
   *   a lookalike host, e.g. yout.cc/watch?v=x
   */
  function targetFromLocation() {
    const host = location.hostname.toLowerCase();
    const path = decodeURIComponent(location.pathname.replace(/^\/+/, ""));
    const search = location.search || "";
    const alias = SERVICE_ALIASES[host];

    if (alias) {
      const rest = path + search;
      return rest ? "https://" + alias + "/" + rest : "";
    }

    const params = new URLSearchParams(search);
    const fromQuery = (params.get("url") || params.get("u") || "").trim();
    if (fromQuery) return fromQuery;

    if (path.startsWith("u/")) return path.slice(2);
    if (APP_PATHS.has(path) || path.startsWith("tests/") || path.startsWith("assets/")) return "";
    if (/^https?:\/\//i.test(path)) return path + search;
    if (/^(?:[\w-]+\.)+[a-z]{2,}(?:\/|$)/i.test(path)) return "https://" + path + search;
    return "";
  }

  function takeDeepLink() {
    const raw = targetFromLocation();
    if (!raw) return false;
    const urls = parseUrls(raw);
    if (!urls.length) return false;
    dom.input.value = urls[0];
    updateComposerState();
    /* drop the link from the address bar so a refresh doesn't fetch twice */
    try {
      const base = location.pathname.replace(/index\.html$/, "").replace(/\/+$/, "/");
      window.history.replaceState(null, "", base || "/");
    } catch (e) {}

    /* YouTube could be a song or a video, so ask instead of guessing.
       Everything else keeps the old one-tap behaviour. */
    const detected = detectService(urls[0]);
    if (apiEndpoint() && detected && detected.id === "youtube") {
      askWhatToDownload(urls[0], detected.host);
      return true;
    }
    submitUrls(urls[0]);
    return true;
  }

  /* ----------------------------------------------------------
     deep link: which kind of download did they mean?
     ---------------------------------------------------------- */
  let pendingDeepLink = "";

  function askWhatToDownload(url, host) {
    pendingDeepLink = url;
    const music = /^music\./i.test(host || "");
    if (dom.quickpickService) dom.quickpickService.textContent = music ? "YouTube Music link" : "YouTube link";
    dom.quickpickButtons.forEach((btn) => {
      btn.dataset.default = btn.dataset.pick === (music ? "audio" : "auto") ? "true" : "false";
    });
    dom.quickpick.hidden = false;
    const first = dom.quickpickButtons.find((b) => b.dataset.default === "true") || dom.quickpickButtons[0];
    if (first) first.focus();
  }

  function hideQuickPick(keepLink) {
    if (!keepLink) pendingDeepLink = "";
    dom.quickpick.hidden = true;
  }

  function resolveQuickPick(mode) {
    const url = pendingDeepLink;
    pendingDeepLink = "";
    dom.quickpick.hidden = true;
    if (url) submitUrls(url, mode);
  }

  function submitUrls(text, mode) {
    const urls = parseUrls(text);
    if (!urls.length) {
      if (text.trim()) toast("That doesn't look like a link.", "warn");
      else toast("Paste a link first.", "warn");
      nudgeComposer();
      dom.input.focus();
      return;
    }
    if (!apiEndpoint()) {
      toast("Connect a server first.", "warn");
      nudgeComposer();
      return;
    }
    const usable = [];
    urls.forEach((url) => {
      const detected = detectService(url);
      if (detected && DRM_SERVICES.has(detected.id)) {
        toast(DRM_SERVICES.get(detected.id), "warn");
        return;
      }
      usable.push(url);
    });
    if (!usable.length) {
      dom.input.value = "";
      updateComposerState();
      return;
    }

    const batch = usable.slice(0, MAX_URLS_PER_SUBMIT);
    batch.forEach((url) => {
      enqueue(url, mode);
      addHistory(url);
    });
    if (usable.length > batch.length) toast("Only the first " + batch.length + " links were queued.", "warn");

    dom.input.value = "";
    updateComposerState();
    dom.input.focus();
    renderQueue();
    const firstQueued = queue.find((item) => item.status === "queued");
    if (firstQueued && firstQueued.node) firstQueued.node.scrollIntoView({ behavior: "smooth", block: "nearest" });
    pump();
  }

  /* ----------------------------------------------------------
     request body
     ---------------------------------------------------------- */
  function buildBody(url, mode) {
    const body = {
      url,
      downloadMode: mode || settings.downloadMode,
      videoQuality: clampQuality(settings.videoQuality),
      audioFormat: clampFormat(settings.audioFormat),
      audioBitrate: clampBitrate(settings.audioBitrate),
      audioCovers: settings.audioCovers !== false,
      filenameStyle: settings.filenameStyle,
      disableMetadata: !!settings.disableMetadata,
      alwaysProxy: !!settings.alwaysProxy,
      localProcessing: settings.localProcessing,
      youtubeVideoCodec: settings.youtubeVideoCodec,
      youtubeVideoContainer: settings.youtubeVideoContainer,
      convertGif: !!settings.convertGif,
      allowH265: !!settings.allowH265,
      tiktokFullAudio: !!settings.tiktokFullAudio
    };
    if (settings.subtitleLang && settings.subtitleLang !== "none") body.subtitleLang = settings.subtitleLang;
    if (settings.youtubeDubLang && settings.youtubeDubLang !== "original") body.youtubeDubLang = settings.youtubeDubLang;
    return body;
  }

  function updateRequestPreview() {
    if (!dom.requestPreview) return;
    const sample = queue.length ? queue[queue.length - 1].url : "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    dom.requestPreview.textContent = JSON.stringify(buildBody(sample, settings.downloadMode), null, 2);
  }

  /* ----------------------------------------------------------
     queue: model
     ---------------------------------------------------------- */
  function enqueue(url, mode) {
    const detected = detectService(url);
    /* audio-first services default to audio unless a mode was chosen explicitly */
    if (!mode && settings.downloadMode === "auto" && detected && AUDIO_FIRST.has(detected.id)) {
      mode = "audio";
    }
    const item = {
      id: "q" + ++idCounter,
      url,
      direct: false,
      directUrl: "",
      service: detected && detected.id ? detected.id : (detected ? detected.host : "link"),
      host: detected ? detected.host : hostOf(url),
      mode: mode || settings.downloadMode,
      status: "queued",
      detail: "queued",
      filename: "",
      progress: 0,
      indeterminate: true,
      size: 0,
      received: 0,
      error: "",
      sourceUrl: "",
      blobUrl: "",
      blob: null,
      controller: null,
      running: false,
      started: 0,
      node: null,
      thumb: "",
      estimate: null,
      previewTitle: "",
      duration: 0,
      modalOpener: null
    };
    queue.push(item);
    const probed = readProbe(probeKey(item.url, item.mode));
    if (probed) attachProbe(item, probed);
    else if (probeSupported()) {
      fetchProbe(item.url, item.mode)
        .then((data) => { if (data && queue.indexOf(item) >= 0) attachProbe(item, data); })
        .catch(() => {});
    }
    return item;
  }

  /**
   * Queue a file that is already a direct/tunnel URL (picker entries and
   * local-processing streams). These must never be POSTed back to the API.
   */
  function enqueueDirect(url, filename, parent) {
    const item = enqueue(url);
    item.direct = true;
    item.directUrl = url;
    item.filename = filename || "";
    item.url = (parent && parent.url) || url;
    if (parent) {
      item.service = parent.service;
      item.host = parent.host;
      item.mode = parent.mode;
    }
    return item;
  }

  function setStatus(item, status, detail) {
    item.status = status;
    if (detail != null) item.detail = detail;
    updateItem(item);
    updateQueueMeta();
  }

  /* ----------------------------------------------------------
     queue: rendering
     ---------------------------------------------------------- */
  const ICONS = {
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 1 0-5.7-5.7L11.4 6.4"/><path d="M14 10.5a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 1 0 5.7 5.7l1.3-1.3"/></svg>',
    working: '<span class="spinner"></span>',
    ready: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4.5 4.5L19 7"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 7v7"/><path d="M12 17.5h.01"/><circle cx="12" cy="12" r="9"/></svg>',
    local: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16v10H4z"/><path d="M8 11h8M8 14h5"/></svg>',
    picker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>'
  };

  /* ------------------------------------------------------------
     One monochrome mark per service. Same 24x24 box and 1.7px
     stroke as every other icon here, so a YouTube link and a
     Reddit link look like they belong to the same site.
     ---------------------------------------------------------- */
  const _mark = (inner) =>
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';

  const MARK_AUDIO = _mark('<path d="M4 12v2M7 9v6M10 6v12M13 9v6M16 7v10M19 10v4"/>');
  const MARK_VIDEO = _mark('<rect x="3" y="6.5" width="13" height="11" rx="2.6"/><path d="M16 10.6l4.6-2.7v8.2L16 13.4z"/>');
  const MARK_IMAGE = _mark('<rect x="3.5" y="5.5" width="17" height="13" rx="2.6"/><path d="M6.5 16l4-5 3 3.4 2.4-2.6 3.6 4.2"/><circle cx="9" cy="9.4" r="1.1"/>');

  const SERVICE_MARKS = {
    youtube: _mark('<rect x="3" y="6" width="18" height="12" rx="3.4"/><path d="M10.4 9.4v5.2l4.4-2.6z" fill="currentColor" stroke="none"/>'),
    twitter: _mark('<path d="M5.5 5.5l13 13M18.5 5.5l-13 13"/>'),
    instagram: _mark('<rect x="4" y="4" width="16" height="16" rx="4.6"/><circle cx="12" cy="12" r="3.6"/><path d="M16.7 7.4h.01"/>'),
    tiktok: _mark('<path d="M14.2 4v10.4a3.4 3.4 0 1 1-3-3.36"/><path d="M14.2 4c.5 2.3 1.9 3.7 4.2 4"/>'),
    douyin: _mark('<path d="M13.8 4.4v9.8a3.1 3.1 0 1 1-2.7-3.08"/><path d="M13.8 4.4c.5 2.1 1.7 3.4 3.9 3.7"/><path d="M6 19.6c3.4 1 8.6 1 12 0"/>'),
    reddit: _mark('<circle cx="12" cy="13.2" r="7.2"/><path d="M9.7 12.8h.01M14.3 12.8h.01"/><path d="M9.5 15.6c1.4 1.1 3.6 1.1 5 0"/><path d="M12 6c0-1.2 1-2 2.2-1.7"/><circle cx="15.2" cy="4.4" r="1.1"/>'),
    soundcloud: _mark('<path d="M6.6 17.6h9a3.4 3.4 0 0 0 .2-6.8 5.2 5.2 0 0 0-9.9-1.4 3.4 3.4 0 0 0 .7 8.2z"/><path d="M9.8 11.6v6M12.2 11v6.6"/>'),
    bandcamp: _mark('<path d="M9 5.5L4.5 18.5H10l4.5-13z"/><path d="M14.5 5.5H20l-4.5 13"/>'),
    mixcloud: _mark('<path d="M6.6 17.6h9a3.3 3.3 0 0 0 .2-6.6 5 5 0 0 0-9.6-1.3 3.3 3.3 0 0 0 .4 7.9z"/><circle cx="11" cy="13.6" r="1.3"/><path d="M12.3 13.6V8.9l2.6-.7v4.2"/>'),
    audiomack: _mark('<path d="M4 12v3M7 9v9M10 6.5v12M13 9.5v8M16 7v11M19 10.5v6"/>'),
    hearthis: _mark('<path d="M4 13v-2M7.5 15V9M11 17V7M14.5 14.5v-5M18 16V8M20.5 13v-2"/>'),
    bilibili: _mark('<rect x="3.5" y="7.5" width="17" height="11.5" rx="3"/><path d="M7.5 7.5L5.5 4.5M16.5 7.5l2-3"/><path d="M9.6 12.2v1.8M14.4 12.2v1.8"/>'),
    vimeo: _mark('<path d="M5 8.4l6.6 8.2L19 8.4"/>'),
    twitch: _mark('<path d="M4 4.6h16v9.4l-4.5 4.5H12l-3.5 3v-3H4z"/><path d="M11 8.6v4M15.5 8.6v4"/>'),
    dailymotion: _mark('<circle cx="12" cy="12" r="8.2"/><path d="M10.4 8.8h1.2a3.3 3.3 0 0 1 0 6.6h-1.2z"/>'),
    facebook: _mark('<circle cx="12" cy="12" r="8.2"/><path d="M14.2 7.9h-1.5c-1 0-1.6.6-1.6 1.7V17"/><path d="M9.7 12.1h4.3"/>'),
    pinterest: _mark('<circle cx="12" cy="12" r="8.2"/><path d="M10.4 18.6l1.7-6.4"/><path d="M10.1 12.5c0-2.3 1.6-3.5 3.1-3.5 1.7 0 2.9 1.1 2.9 2.9 0 2.1-1.3 3.7-2.9 3.7-.9 0-1.5-.6-1.3-1.5"/>'),
    tumblr: _mark('<path d="M14 4.6v4.1h3.2"/><path d="M14 8.7v6.1a2.2 2.2 0 0 0 2.2 2.2h1.1"/><path d="M9.7 13.4h5.1"/>'),
    vk: _mark('<path d="M6.4 7.4l4.3 9.2 4.3-9.2"/><path d="M17.6 7.4v9.2"/><path d="M21 7.4l-3.4 4.6L21 16.6"/>'),
    ok: _mark('<circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="2.7"/>'),
    rutube: _mark('<rect x="3.5" y="6.5" width="17" height="11" rx="3"/><path d="M9.6 10.4v3.2l3-1.6z" fill="currentColor" stroke="none"/><path d="M14.6 10.1v3.8"/>'),
    rumble: _mark('<path d="M4.5 12l5.5-3.6v7.2z"/><path d="M13.5 8.6c2.3 1.6 2.3 5.2 0 6.8M17 6.2c3.8 3 3.8 8.6 0 11.6"/>'),
    odysee: _mark('<circle cx="12" cy="12" r="8.2"/><path d="M10.2 9.2v5.6l4.4-2.8z" fill="currentColor" stroke="none"/>'),
    kick: _mark('<path d="M7 5v14"/><path d="M17.4 5L9.4 12l8 7"/>'),
    snapchat: _mark('<path d="M12 4.2c2.4 0 3.9 1.7 3.9 4.2v2c0 .6.5 1 1.2 1.2l1.2.4-1.5 1.2c-.4.3-.4.6-.2 1l.9 1.5-1.9.4c-.3 0-.5.3-.6.6l-.4 1.4-1.9-.6h-.6l-1.9.6-.4-1.4c-.1-.3-.3-.6-.6-.6l-1.9-.4.9-1.5c.2-.4.2-.7-.2-1L5.7 12l1.2-.4c.7-.2 1.2-.6 1.2-1.2v-2c0-2.5 1.5-4.2 3.9-4.2z"/>'),
    threads: _mark('<circle cx="12" cy="12" r="8.2"/><path d="M8.8 12.6c0-2.7 1.5-4.4 3.5-4.4 2.2 0 3.6 1.6 3.6 4.2 0 2.5-1.4 4.4-3.4 4.4-1.5 0-2.6-1-2.6-2.3 0-1.6 1.4-2.6 3.3-2.6 1.5 0 2.8.5 3.6 1.4"/>'),
    bluesky: _mark('<path d="M12 11.2c-1.2-2.6-3.2-4.4-5-4.4-1.3 0-2.1.9-2.1 2.4 0 2.9 2.6 5.4 4.6 6.2 1 .4 2 .4 2.5.1"/><path d="M12 11.2c1.2-2.6 3.2-4.4 5-4.4 1.3 0 2.1.9 2.1 2.4 0 2.9-2.6 5.4-4.6 6.2-1 .4-2 .4-2.5.1"/>'),
    streamable: _mark('<rect x="3.5" y="6.5" width="17" height="11" rx="3"/><path d="M9.8 9.8v4.4l3.9-2.2z" fill="currentColor" stroke="none"/><path d="M15.6 10.3h1.8M15.6 13.7h1.8"/>'),
    loom: _mark('<circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="3.1"/>'),
    coub: _mark('<path d="M6.2 9.6a6.4 6.4 0 0 1 11.3-1.7"/><path d="M17.9 4.4v3.6h-3.6"/><path d="M17.8 14.4A6.4 6.4 0 0 1 6.5 16.1"/><path d="M6.1 19.6V16h3.6"/>'),
    newgrounds: _mark('<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M9 16.2V7.8l6 8.4V7.8"/>'),
    "9gag": _mark('<rect x="4" y="4" width="16" height="16" rx="4"/><circle cx="11" cy="10.3" r="2.4"/><path d="M13.4 8.1v7.8"/>'),
    imgur: MARK_IMAGE,
    giphy: _mark('<rect x="3.5" y="5.5" width="17" height="13" rx="2.6"/><path d="M10 9.6v4.8l3.9-2.4z" fill="currentColor" stroke="none"/>'),
    tenor: _mark('<rect x="3.5" y="5.5" width="17" height="13" rx="2.6"/><path d="M8.6 9.4h6.8M12 9.4v5.6"/>'),
    pixiv: _mark('<rect x="3.5" y="5.5" width="17" height="13" rx="2.6"/><path d="M9.4 16.2V8.4h2.4a2.6 2.6 0 0 1 0 5.2H9.4"/>'),
    xiaohongshu: _mark('<rect x="4.5" y="4" width="15" height="16" rx="3"/><path d="M8.6 4v16"/><path d="M12.6 9.4c.6-1 1.8-1.3 2.6-.6 1 .8 1 2.2.2 3.1l-2.8 3-2.8-3c-.8-.9-.8-2.3.2-3.1.8-.7 2-.4 2.6.6z"/>'),
    spotify: _mark('<circle cx="12" cy="12" r="8.2"/><path d="M7.9 9.7c2.8-.8 5.7-.5 8.2.9"/><path d="M8.7 12.4c2.2-.6 4.5-.3 6.5.8"/><path d="M9.5 15c1.6-.4 3.2-.2 4.8.6"/>'),
    deezer: _mark('<path d="M4 17.4h3.2v-3.1H4zM8.7 17.4h3.2v-6.2H8.7zM13.4 17.4h3.2V8H13.4zM18.1 17.4H21V5.7h-2.9z"/>'),
    tidal: _mark('<path d="M12 3.8l2.8 2.8-2.8 2.8L9.2 6.6z"/><path d="M6.6 9.2l2.8 2.8-2.8 2.8L3.8 12z"/><path d="M17.4 9.2L20.2 12l-2.8 2.8L14.6 12z"/><path d="M12 14.6l2.8 2.8L12 20.2l-2.8-2.8z"/>'),
    "apple-music": _mark('<circle cx="9.4" cy="16" r="2.4"/><circle cx="16.6" cy="14.4" r="2.4"/><path d="M11.8 16V6.6l7.2-1.6v9.4"/>')
  };

  const IMAGE_SERVICES = new Set(["imgur", "giphy", "tenor", "pixiv"]);

  function markForService(service) {
    if (!service) return ICONS.link;
    if (SERVICE_MARKS[service]) return SERVICE_MARKS[service];
    if (AUDIO_FIRST.has(service)) return MARK_AUDIO;
    if (IMAGE_SERVICES.has(service)) return MARK_IMAGE;
    return MARK_VIDEO;
  }

  function iconFor(item) {
    switch (item.status) {
      case "working": return ICONS.working;
      case "downloading": return ICONS.working;
      case "ready": return ICONS.ready;
      case "done": return ICONS.ready;
      case "error": return ICONS.error;
      case "cancelled": return ICONS.error;
      case "local": return ICONS.local;
      case "picker": return ICONS.picker;
      default: return ICONS.link;
    }
  }

  function titleFor(item) {
    if (item.filename) return item.filename;
    if (item.previewTitle) return item.previewTitle;
    if (item.status === "local") return "Local processing required";
    if (item.status === "picker") return "Multiple items found";
    if (item.url) return item.host || item.url;
    return "Untitled";
  }

  const MODE_NAMES = { auto: "video", audio: "audio", mute: "silent" };

  function metaFor(item) {
    const parts = [];
    if (item.service) parts.push(item.service);
    if (item.mode) parts.push(MODE_NAMES[item.mode] || item.mode);
    if (item.status === "downloading") {
      if (item.received) {
        const pct = item.size ? Math.round((item.received / item.size) * 100) + "%" : "";
        const of = item.size ? " / " + formatBytes(item.size) : "";
        if (pct) parts.push(pct);
        parts.push(formatBytes(item.received) + of);
        if (item.speed) parts.push(formatBytes(item.speed) + "/s");
        if (item.speed && item.size > item.received) {
          parts.push(Math.max(1, Math.ceil((item.size - item.received) / item.speed)) + "s left");
        }
      } else {
        parts.push("connecting");
      }
    } else if (item.error) {
      parts.push("• " + item.error);
    } else if (item.detail) {
      parts.push(item.detail);
      if (item.started && (item.status === "working" || item.status === "downloading")) {
        parts.push(Math.max(1, Math.round((Date.now() - item.started) / 1000)) + "s");
      }
      const estimate = item.estimate;
      if (estimate && estimate.bytes && !item.size) {
        parts.push((estimate.exact ? "~" : "≈") + " " + formatBytes(estimate.bytes));
      }
      if (item.duration) parts.push(clockTime(item.duration));
    }
    return parts;
  }

  function buildNode(item) {
    const node = el("div", { class: "qitem", "data-status": item.status, id: item.id });
    const icon = el("div", { class: "q-icon", "aria-hidden": "true" });
    const thumb = el("div", { class: "q-thumb", "aria-hidden": "true" });
    const body = el("div", { class: "q-body" });
    const title = el("div", { class: "q-title" });
    const meta = el("div", { class: "q-meta" });
    const actions = el("div", { class: "q-actions" });
    const progress = el("div", { class: "q-progress" });
    const fill = el("div", { class: "q-progress-fill" });

    body.appendChild(title);
    body.appendChild(meta);
    progress.appendChild(fill);
    node.appendChild(icon);
    node.appendChild(thumb);
    node.appendChild(body);
    node.appendChild(actions);
    node.appendChild(progress);

    item.node = node;
    item.refs = { icon, thumb, title, meta, actions, fill };
    updateItem(item);
    return node;
  }

  function updateItem(item) {
    const node = item.node;
    if (!node) return;

    node.setAttribute("data-status", item.status);
    node.setAttribute("data-indeterminate", item.indeterminate ? "true" : "false");

    const { icon, thumb, title, meta, actions, fill } = item.refs;
    if (icon.innerHTML !== iconFor(item)) icon.innerHTML = iconFor(item);

    const picture = item.thumb || "";
    if (thumb.dataset.src !== picture) {
      thumb.dataset.src = picture;
      thumb.style.backgroundImage = picture ? 'url("' + picture + '")' : "";
    }
    thumb.hidden = !picture;
    icon.hidden = !!picture;

    const nextTitle = titleFor(item);
    if (title.textContent !== nextTitle) title.textContent = nextTitle;

    const parts = metaFor(item);
    const metaKey = parts.join("|");
    if (meta.dataset.key !== metaKey) {
      meta.dataset.key = metaKey;
      meta.innerHTML = parts.map((part, index) => {
        const isError = part.indexOf("• ") === 0;
        const text = isError ? part.slice(2) : part;
        if (index === 0) return '<span' + (isError ? ' class="q-err"' : "") + '>' + escapeHtml(text) + "</span>";
        return '<span class="sep"></span><span' + (isError ? ' class="q-err"' : "") + ">" + escapeHtml(text) + "</span>";
      }).join("");
    }

    let pct = item.size ? Math.min(100, (item.received / item.size) * 100) : 0;
    if (item.status === "done" || item.status === "ready") pct = 100;
    fill.style.transform = "scaleX(" + (pct / 100).toFixed(4) + ")";

    const actionsKey = item.status + "|" + item.error + "|" + (item.blob ? "blob" : "noblob") + (item.sourceUrl ? "|src" : "");
    if (item.refs.actionsKey !== actionsKey) {
      item.refs.actionsKey = actionsKey;
      renderActions(item, actions);
    }
  }

  function renderActions(item, container) {
    const buttons = [];
    const iconBtn = (svg, label, handler, cls) => {
      const b = el("button", { type: "button", class: "icon-btn" + (cls ? " " + cls : ""), title: label, "aria-label": label }, svg);
      b.addEventListener("click", handler);
      return b;
    };

    if (item.status === "working" || item.status === "downloading" || item.status === "queued") {
      buttons.push(iconBtn(
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
        "Cancel",
        () => cancelItem(item)
      ));
    }
    if (item.status === "error" || item.status === "cancelled") {
      buttons.push(iconBtn(
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.6 6"/><path d="M20 5v6h-6"/></svg>',
        "Retry",
        () => retryItem(item)
      ));
    }
    if ((item.status === "ready" || item.status === "done") && item.blob) {
      buttons.push(iconBtn(
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 19h14"/></svg>',
        "Save file",
        () => saveBlob(item)
      ));
      if (navigator.share) {
        buttons.push(iconBtn(
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4"/><path d="m8 8 4-4 4 4"/><path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/></svg>',
          "Share",
          () => shareItem(item)
        ));
      }
    }
    if (item.status === "ready" && !item.blob && item.sourceUrl) {
      buttons.push(iconBtn(
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>',
        "Open link",
        () => window.open(item.sourceUrl, "_blank", "noopener")
      ));
    }
    if (item.status === "local" || item.status === "picker") {
      buttons.push(iconBtn(
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="6" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="18" r="1.4"/></svg>',
        "Details",
        () => (item.modalOpener ? item.modalOpener() : null)
      ));
    }
    if (item.sourceUrl && (item.status === "ready" || item.status === "done")) {
      buttons.push(iconBtn(
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
        "Copy link",
        () => copyText(item.sourceUrl, "Link copied")
      ));
    }
    if (item.status === "done" || item.status === "error" || item.status === "cancelled") {
      buttons.push(iconBtn(
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
        "Remove",
        () => removeItem(item)
      ));
    }

    container.innerHTML = "";
    buttons.forEach((b) => container.appendChild(b));
  }

  function renderQueue() {
    dom.queueList.innerHTML = "";
    queue.forEach((item) => dom.queueList.appendChild(item.node || buildNode(item)));
    updateQueueMeta();
  }

  let lastQueueCount = 0;
  let dockOpen = false;

  let dockTimer = null;

  function setDock(open) {
    if (!dom.queueDock || !dom.queuePanel) return;
    dockOpen = open;
    clearTimeout(dockTimer);
    if (open) {
      dom.queuePanel.hidden = false;
      dom.queuePanel.classList.remove("is-closing");
    } else if (!dom.queuePanel.hidden) {
      dom.queuePanel.classList.add("is-closing");
      dockTimer = setTimeout(() => {
        dom.queuePanel.hidden = true;
        dom.queuePanel.classList.remove("is-closing");
      }, 120);
    }
    dom.queueToggle.setAttribute("aria-expanded", open ? "true" : "false");
    dom.queueDock.classList.toggle("is-open", open);
  }

  function ensureTicker() {
    const active = queue.some((i) => i.status === "working" || i.status === "downloading");
    if (active && !queueTicker) {
      queueTicker = setInterval(() => {
        queue.forEach((item) => {
          if (item.status === "working" || item.status === "downloading") updateItem(item);
        });
      }, 1000);
    } else if (!active && queueTicker) {
      clearInterval(queueTicker);
      queueTicker = null;
    }
  }

  function updateQueueMeta() {
    ensureTicker();
    const count = queue.length;
    const active = queue.filter((i) => ["queued", "working", "downloading"].includes(i.status)).length;

    if (dom.queueBadge) {
      const finished = queue.filter((i) => ["done", "error", "cancelled"].includes(i.status)).length;
      const show = active > 0 || finished > 0;
      dom.queueBadge.textContent = active > 0 ? String(active) : "•";
      dom.queueBadge.hidden = !show;
      dom.queueBadge.classList.toggle("is-dot", active === 0 && show);
    }
    // Any screen: a download with no visible feedback reads as a broken button.
    // Opening on every *new* item (not just the first) matters because clicking
    // fetch counts as an outside click, which closes the dock first.
    if (count > lastQueueCount && !dockOpen) setDock(true);
    lastQueueCount = count;

    dom.queueCount.textContent = String(count);
    dom.queueCount.hidden = count === 0;
    dom.emptyState.hidden = count > 0;
    dom.clearFinished.hidden = !queue.some((i) => ["done", "error", "cancelled"].includes(i.status));

    const saved = queue.filter((i) => i.status === "done");
    const bytes = saved.reduce((total, i) => total + (i.size || 0), 0);
    const failed = queue.filter((i) => i.status === "error").length;
    const bits = [];
    if (saved.length) bits.push(saved.length + " saved");
    if (bytes) bits.push(formatBytes(bytes));
    if (failed) bits.push(failed + " failed");
    if (dom.queueStats) dom.queueStats.textContent = bits.join(" · ");
  }

  function removeItem(item) {
    cancelItem(item, true);
    if (item.blobUrl) URL.revokeObjectURL(item.blobUrl);
    if (item.node) item.node.remove();
    queue = queue.filter((q) => q !== item);
    updateQueueMeta();
  }

  function clearFinished() {
    queue.filter((q) => ["done", "error", "cancelled"].includes(q.status)).forEach((item) => {
      if (item.blobUrl) URL.revokeObjectURL(item.blobUrl);
      if (item.node) item.node.remove();
    });
    queue = queue.filter((q) => !["done", "error", "cancelled"].includes(q.status));
    updateQueueMeta();
  }

  /* ----------------------------------------------------------
     queue: network
     ---------------------------------------------------------- */
  function pump() {
    const limit = Math.max(1, Math.min(MAX_CONCURRENT, Number(settings.concurrency) || 3));
    queue.forEach((item) => {
      if (active >= limit) return;
      if (item.status === "queued" && !item.running) {
        item.running = true;
        active++;
        runItem(item).finally(() => {
          active--;
          item.running = false;
          pump();
        });
      }
    });
  }

  function resolveUrl(url) {
    if (!url) return "";
    try { return new URL(url, apiEndpoint() || window.location.href).href; }
    catch { return url; }
  }

  function readRateLimit(res) {
    const remaining = res.headers.get("ratelimit-remaining");
    if (remaining != null && remaining !== "") {
      const num = Number(remaining);
      if (!Number.isNaN(num)) rateRemaining = num;
    }
  }

  async function runItem(item) {
    const controller = new AbortController();
    item.controller = controller;
    item.indeterminate = true;

    if (item.direct) {
      try {
        if (!item.started) item.started = Date.now();
        setStatus(item, "working", "starting transfer");
        await downloadTunnel(item, item.directUrl, item.filename || guessFilename(item.url, item.mode));
      } catch (err) {
        if (err && err.name === "AbortError") setStatus(item, "cancelled", "cancelled");
        else {
          item.error = friendlyError(err);
          setStatus(item, "error", "failed");
        }
      } finally {
        item.controller = null;
      }
      return;
    }

    if (!item.started) item.started = Date.now();
    setStatus(item, "working", "requesting");

    try {
      const token = await getTurnstileToken();
      const payload = buildBody(item.url, item.mode);
      if (token) payload.turnstileToken = token;

      const res = await fetch(apiEndpoint(), {
        method: "POST",
        headers: Object.assign({
          Accept: "application/json",
          "Content-Type": "application/json"
        }, authHeaders()),
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      readRateLimit(res);
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }

      if (!res.ok && !data) {
        throw new Error("The API answered HTTP " + res.status + " without a body.");
      }
      if (!data || typeof data !== "object") {
        throw new Error("Unexpected response from the API.");
      }

      if (data.status === "error") {
        const code = data.error && data.error.code ? data.error.code : "";
        handleApiError(item, code, data.error && data.error.context);
        return;
      }

      switch (data.status) {
        case "tunnel":
        case "redirect": {
          const filename = data.filename || guessFilename(item.url, item.mode);
          const source = resolveUrl(data.url);
          item.filename = filename;
          item.sourceUrl = source;

          if (data.status === "redirect" || settings.savingMethod === "copy") {
            setStatus(item, "ready", data.status === "redirect" ? "direct link" : "link ready");
            item.indeterminate = false;
            afterReady(item, null);
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
      if (err && err.name === "AbortError") {
        setStatus(item, "cancelled", "cancelled");
      } else {
        item.error = friendlyError(err);
        setStatus(item, "error", "failed");
      }
    } finally {
      item.controller = null;
    }
  }

  function friendlyError(err) {
    const message = err && err.message ? String(err.message) : "Unknown error";
    if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
      return "Can't reach the API — check the address, that it's running, and that CORS is allowed.";
    }
    return message;
  }

  function handleApiError(item, code, context) {
    let text = ERROR_TEXT[code];
    if (!text) {
      text = code
        ? code.replace(/^api\./, "").replace(/\./g, " ").replace(/^./, (c) => c.toUpperCase())
        : "The instance returned an error.";
    }
    if (context && context.service && context.service !== item.service) text += " (" + context.service + ")";
    if (context && context.limit) {
      const seconds = Number(context.limit);
      if (/too_long/.test(code) && Number.isFinite(seconds) && seconds >= 60) {
        const minutes = Math.round(seconds / 60);
        text = "Longer than the " + minutes + "-minute limit on this instance.";
      } else {
        text += " Limit: " + context.limit + ".";
      }
    }

    if (code === "api.instance.not_ready" && context && context.reason === "disk") {
      text = "This instance is out of disk space. Try again later.";
    }
    if (code === "api.rate_limit") {
      const reason = context && context.reason ? String(context.reason) : "";
      if (reason === "daily_cap") {
        text = "This instance has hit its daily download limit. Try again tomorrow.";
      } else if (reason === "too_many_downloads") {
        text = "That's a lot of downloads in a row — give it a minute and retry.";
      } else if (reason === "queue_full") {
        text = "The queue is full right now. Try again in a moment.";
      } else if (rateRemaining != null) {
        text += " Remaining: " + rateRemaining + ".";
      }
    }
    item.error = text;
    setStatus(item, "error", "failed");
    toast(text, "err");
  }

  function guessFilename(url, mode) {
    const host = hostOf(url) || "download";
    return mode === "audio" ? host + "." + audioExt() : host + ".mp4";
  }

  async function downloadTunnel(item, url, filename) {
    item.indeterminate = true;
    item.received = 0;
    item.size = 0;
    setStatus(item, "downloading", "connecting");

    const controller = item.controller || new AbortController();
    item.controller = controller;

    let res;
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      item.sourceUrl = url;
      item.filename = filename;
      setStatus(item, "ready", "direct link (open manually)");
      return;
    }

    if (!res.ok) {
      item.sourceUrl = url;
      item.filename = filename;
      setStatus(item, "ready", "direct link (HTTP " + res.status + ")");
      return;
    }

    const lengthHeader = res.headers.get("content-length") || res.headers.get("estimated-content-length");
    const total = lengthHeader ? Number(lengthHeader) : 0;
    item.size = Number.isFinite(total) && total > 0 ? total : 0;
    item.indeterminate = !item.size;
    setStatus(item, "downloading", "downloading");

    if (IS_IOS && settings.savingMethod === "download") {
      try {
        if (res.body) await res.body.cancel();
      } catch (err) { /* Safari owns it now */ }
      item.sourceUrl = url;
      item.filename = filenameFromHeaders(res) || filename;
      item.received = 0;
      handOffToBrowser(item, "Safari is saving it");
      return;
    }

    if (item.size > LARGE_FILE_BYTES) {
      try {
        if (res.body) await res.body.cancel();
      } catch (err) { /* the browser owns the file from here */ }
      item.sourceUrl = url;
      item.filename = filenameFromHeaders(res) || filename;
      item.received = 0;
      handOffToBrowser(item, "large file (" + formatBytes(item.size) + ")");
      return;
    }

    const chunks = [];
    let lastPaint = 0;
    let lastTime = window.performance ? performance.now() : Date.now();
    let lastBytes = 0;
    const paint = () => {
      const now = window.performance ? performance.now() : Date.now();
      const seconds = (now - lastTime) / 1000;
      if (seconds > 0.35) {
        const instant = (item.received - lastBytes) / seconds;
        item.speed = item.speed ? item.speed * 0.55 + instant * 0.45 : instant;
        lastTime = now;
        lastBytes = item.received;
      }
      if (now - lastPaint < 60) return;
      lastPaint = now;
      updateItem(item);
    };
    try {
      if (res.body && typeof res.body.getReader === "function") {
        const reader = res.body.getReader();
        for (;;) {
          const step = await reader.read();
          if (step.done) break;
          const value = step.value;
          if (!value) continue;
          chunks.push(value);
          item.received += value.length;
          if (item.received > LARGE_FILE_BYTES) {
            chunks.length = 0;
            try {
              await reader.cancel();
            } catch (err) { /* already gone */ }
            item.sourceUrl = url;
            item.filename = filenameFromHeaders(res) || filename;
            item.size = item.received;
            handOffToBrowser(item, "large file (over " + formatBytes(LARGE_FILE_BYTES) + ")");
            return;
          }
          paint();
        }
      } else {
        const buffer = await res.arrayBuffer();
        chunks.push(new Uint8Array(buffer));
        item.received = buffer.byteLength;
        updateItem(item);
      }
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      // streaming failed but the URL is still useful
      item.sourceUrl = url;
      item.filename = filename;
      setStatus(item, "ready", "stream interrupted — open manually");
      return;
    }

    const type = res.headers.get("content-type") || "application/octet-stream";
    const blob = new Blob(chunks, { type });
    if (item.blobUrl) URL.revokeObjectURL(item.blobUrl);
    item.blob = blob;
    item.blobUrl = URL.createObjectURL(blob);
    item.filename = filenameFromHeaders(res) || filename;
    item.size = blob.size;
    item.indeterminate = false;
    setStatus(item, "ready", "ready");

    await afterReady(item, blob);
  }

  function filenameFromHeaders(res) {
    const disposition = res.headers.get("content-disposition") || "";
    const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    if (star) {
      try { return decodeURIComponent(star[1].trim()); } catch { return star[1].trim(); }
    }
    const quoted = /filename="([^"]+)"/i.exec(disposition);
    if (quoted) return quoted[1];
    const bare = /filename=([^;]+)/i.exec(disposition);
    if (bare) return bare[1].trim();
    return "";
  }

  async function afterReady(item, blob) {
    if (settings.savingMethod === "download" && blob) {
      saveBlob(item);
    } else if (settings.savingMethod === "share" && blob) {
      const shared = await shareItem(item, true);
      if (!shared) saveBlob(item);
    } else if (settings.savingMethod === "copy" && item.sourceUrl) {
      copyText(item.sourceUrl, "Link copied");
    } else if (settings.savingMethod === "ask") {
      toast("Ready — use the buttons on the queue item to save.", "ok");
    }
  }

  /* A file this big must never be buffered in the JS heap: streaming a 1 GB
     video into an array of Uint8Arrays means ~1 GB of live memory, and the tab
     is killed long before it finishes. Past this size the tunnel URL goes
     straight to the browser, which streams to disk and can resume. */
  const LARGE_FILE_BYTES = 200 * 1024 * 1024;

  /* iOS has no "save this blob" affordance: a blob URL opens in a viewer and
     the file never reaches Files. Handing the tunnel URL to Safari uses its
     download manager instead. Share is different — that path needs the blob,
     so it keeps the normal flow (with the size cap above). */
  /* Pure, so it can be tested without an iPhone: iPadOS reports itself as a
     Mac, which is why the touch-point check exists. */
  function isIOS(userAgent, platform, maxTouchPoints) {
    if (/iP(hone|ad|od)/.test(userAgent || "")) return true;
    return (platform || "") === "MacIntel" && (maxTouchPoints || 0) > 1;
  }

  const IS_IOS = isIOS(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
  const IS_TOUCH = (navigator.maxTouchPoints || 0) > 0 || "ontouchstart" in window;
  const IS_ANDROID = /Android/i.test(navigator.userAgent);

  /* "saved" is useless on a phone if you do not know where. iOS puts downloads
     behind the toolbar button (Files → Downloads); Android drops a notification
     and the file lands in Downloads; desktop has a Downloads folder. */
  const SAVED_WHERE = IS_IOS ? "Files → Downloads"
    : IS_ANDROID ? "Downloads"
    : "your downloads folder";
  let toldWhere = false;

  function tellWhereItWent() {
    if (toldWhere) return;
    toldWhere = true;
    toast("Saved to " + SAVED_WHERE, "ok");
  }

  function handOffToBrowser(item, note) {
    item.blob = null;
    if (item.blobUrl) {
      URL.revokeObjectURL(item.blobUrl);
      item.blobUrl = "";
    }
    item.indeterminate = false;
    const label = note || "large file";

    if (settings.savingMethod === "ask") {
      setStatus(item, "ready", label + " — open to save");
      return;
    }
    if (settings.savingMethod === "copy") {
      copyText(item.sourceUrl, "Link copied");
      setStatus(item, "done", "link copied");
      return;
    }
    if (!item.sourceUrl) {
      setStatus(item, "ready", label + " — no direct link");
      return;
    }

    const link = document.createElement("a");
    link.href = item.sourceUrl;
    link.download = item.filename || "download";
    link.rel = "noopener";
    link.dataset.ignoreDock = "true";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setStatus(item, "done", "saved · " + SAVED_WHERE);
    tellWhereItWent();
  }

  function saveBlob(item) {
    if (!item.blob || !item.blobUrl) return;
    const link = document.createElement("a");
    link.href = item.blobUrl;
    link.download = item.filename || "download";
    link.dataset.ignoreDock = "true";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setStatus(item, "done", "saved · " + SAVED_WHERE);
    tellWhereItWent();
    setTimeout(() => { if (item.status === "done") updateItem(item); }, 1200);
  }

  async function shareItem(item, silentFallback) {
    if (item.blob && navigator.canShare) {
      const file = new File([item.blob], item.filename || "download", { type: item.blob.type || "application/octet-stream" });
      if (navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: item.filename });
          setStatus(item, "done", "shared");
          return true;
        } catch (err) {
          if (err && err.name === "AbortError") return true;
        }
      }
    }
    if (!silentFallback) {
      if (item.sourceUrl) await copyText(item.sourceUrl, "Sharing isn't supported here — link copied instead.");
      else toast("Sharing isn't available in this browser.", "warn");
    }
    return false;
  }

  function cancelItem(item, silent) {
    if (item.controller) {
      try { item.controller.abort(); } catch {}
    }
    if (item.running) return;
    if (!silent && ["queued", "working", "downloading"].includes(item.status)) {
      setStatus(item, "cancelled", "cancelled");
    }
    if (silent) item.status = "cancelled";
  }

  function retryItem(item) {
    item.error = "";
    item.received = 0;
    item.progress = 0;
    item.indeterminate = true;
    item.filename = "";
    item.detail = "queued";
    setStatus(item, "queued", "queued");
    pump();
  }

  /* ----------------------------------------------------------
     picker / local processing
     ---------------------------------------------------------- */
  function handlePicker(item, data) {
    const entries = Array.isArray(data.picker) ? data.picker : [];
    item.filename = "";
    setStatus(item, "picker", entries.length + " items available");

    const opener = () => {
      const selected = new Set(entries.map((_, i) => i));
      const body = el("div");
      const grid = el("div", { class: "picker-grid" });
      const cells = [];

      const paint = () => {
        cells.forEach((cell, index) => {
          cell.setAttribute("data-selected", selected.has(index) ? "true" : "false");
        });
      };

      if (!entries.length) {
        body.appendChild(el("p", { class: "picker-empty", text: "The API returned an empty picker." }));
      } else {
        /* the two answers people actually want: one of them, or everything */
        const bulk = el("div", { class: "picker-bulk" });
        const one = el("button", { type: "button", class: "ghost-btn small", text: "just the first" });
        const all = el("button", { type: "button", class: "ghost-btn small", text: "all " + entries.length });
        one.addEventListener("click", () => {
          selected.clear();
          selected.add(0);
          paint();
        });
        all.addEventListener("click", () => {
          entries.forEach((_, index) => selected.add(index));
          paint();
        });
        bulk.appendChild(one);
        bulk.appendChild(all);
        bulk.appendChild(el("span", { class: "picker-bulk-note", text: "or tick them below" }));
        body.appendChild(bulk);
      }

      entries.forEach((entry, index) => {
        const cell = el("button", { type: "button", class: "picker-cell", "data-selected": "true" });
        const img = el("img", { alt: "", loading: "lazy" });
        if (entry.thumb) img.src = resolveUrl(entry.thumb);
        else img.style.background = "linear-gradient(135deg, rgba(47,129,247,.22), rgba(63,185,80,.18))";
        cell.appendChild(img);
        const label = (entry.name || "").trim() || entry.type || "item";
        cell.appendChild(el("span", { class: "picker-type", text: label.length > 42 ? label.slice(0, 40) + "…" : label }));
        img.addEventListener("error", () => { img.style.visibility = "hidden"; });
        cell.addEventListener("click", () => {
          if (selected.has(index)) selected.delete(index);
          else selected.add(index);
          cell.setAttribute("data-selected", selected.has(index) ? "true" : "false");
        });
        cells.push(cell);
        grid.appendChild(cell);
      });

      body.appendChild(grid);

      let audioToggle = null;
      if (data.audio) {
        const row = el("label", { class: "switch-row", style: "margin-top:16px" });
        const text = el("span", { html: '<span class="field-label">Also download background audio</span><span class="field-help">Some slideshows carry a single audio track.</span>' });
        audioToggle = el("input", { type: "checkbox", class: "switch" });
        row.appendChild(text);
        row.appendChild(audioToggle);
        body.appendChild(row);
      }

      const cancel = el("button", { type: "button", class: "ghost-btn", text: "Cancel" });
      cancel.addEventListener("click", () => closeModal());
      const confirm = el("button", { type: "button", class: "primary-btn" });
      confirm.appendChild(el("span", { text: "Download selected" }));
      confirm.addEventListener("click", () => {
        const picked = entries.filter((_, i) => selected.has(i));
        closeModal();
        if (!picked.length && !(audioToggle && audioToggle.checked)) {
          toast("Nothing selected.", "warn");
          return;
        }
        picked.forEach((entry, index) => {
          /* "link" entries are pages, not files: send them back through the API
             like any other link. Anything else is already a media URL. */
          if (entry.type === "link") {
            const queued = enqueue(resolveUrl(entry.url), item.mode);
            queued.detail = "queued";
            addHistory(entry.url);
            return;
          }
          const directUrl = resolveUrl(entry.url);
          const child = enqueueDirect(directUrl, (item.host || "media") + "-" + (index + 1) + "-" + (entry.type || "item"), item);
          child.status = "queued";
          child.detail = "queued";
        });
        if (audioToggle && audioToggle.checked && data.audio) {
          const audioItem = enqueueDirect(resolveUrl(data.audio), data.audioFilename || (item.host || "audio") + ".mp3", item);
          audioItem.mode = "audio";
          audioItem.detail = "queued";
        }
        setStatus(item, "done", "handled");
        renderQueue();
        pump();
      });

      openModal("Choose items", body, [cancel, confirm]);
    };

    item.modalOpener = opener;
    updateItem(item);
    opener();
  }

  function handleLocalProcessing(item, data) {
    const tunnels = Array.isArray(data.tunnel) ? data.tunnel.map(resolveUrl) : [];
    const output = data.output || {};
    const filename = output.filename || guessFilename(item.url, item.mode);
    item.filename = filename;
    item.sourceUrl = tunnels[0] || "";
    setStatus(item, "local", "needs merging locally");

    const ffmpeg = buildFfmpegCommand(data, tunnels, filename);
    const opener = () => {
      const body = el("div");
      body.appendChild(el("p", {
        class: "field-help",
        style: "margin-bottom:14px",
        text: "The API served this media as separate streams (" + (data.type || "unknown") + "). Merge them on your machine — the streams are temporary and expire."
      }));

      const list = el("ul", { class: "step-list" });
      tunnels.forEach((url, index) => {
        const li = el("li");
        li.appendChild(el("code", { text: "stream " + (index + 1) }));
        const btn = el("button", { type: "button", class: "ghost-btn", text: "Save" });
        btn.addEventListener("click", () => {
          const base = filename.replace(/(\.[a-z0-9]+)$/i, "");
          const ext = (/(\.[a-z0-9]+)$/i.exec(filename) || [""])[0];
          enqueueDirect(url, base + "-part" + (index + 1) + ext, item);
          renderQueue();
          pump();
        });
        li.appendChild(btn);
        list.appendChild(li);
      });
      body.appendChild(list);

      if (ffmpeg) {
        const block = el("pre", { class: "code-block", style: "margin-top:16px", text: ffmpeg });
        body.appendChild(block);
      }

      const copy = el("button", { type: "button", class: "ghost-btn", text: "Copy all links" });
      copy.addEventListener("click", () => copyText(tunnels.join("\n"), "Links copied"));
      const close = el("button", { type: "button", class: "primary-btn", text: "Got it" });
      close.addEventListener("click", () => closeModal());

      openModal("Merge locally", body, [copy, close]);
    };

    item.modalOpener = opener;
    updateItem(item);
    opener();
    toast("This media needs local merging — the streams and a ready ffmpeg command are in this dialog.", "warn");
  }

  function buildFfmpegCommand(data, tunnels, filename) {
    if (!tunnels.length) return "";
    if (data.type === "merge" && tunnels.length >= 2) {
      return 'ffmpeg -i "stream1" -i "stream2" -c copy -map 0:v:0 -map 1:a:0 "' + filename + '"';
    }
    if (data.type === "audio" || data.type === "mute" || data.type === "gif" || data.type === "remux") {
      return 'ffmpeg -i "stream1" -c copy "' + filename + '"';
    }
    return "";
  }

  /* ----------------------------------------------------------
     modal
     ---------------------------------------------------------- */
  let modalReturnFocus = null;

  function openModal(title, bodyNode, footButtons) {
    const panel = dom.modal.querySelector(".modal-inner");
    if (panel) panel.classList.remove("is-sources");
    dom.modalTitle.textContent = title;
    dom.modalBody.innerHTML = "";
    dom.modalBody.appendChild(bodyNode);
    dom.modalFoot.innerHTML = "";
    (footButtons || []).forEach((btn) => dom.modalFoot.appendChild(btn));

    modalReturnFocus = document.activeElement;
    dom.modal.hidden = false;
    document.body.style.overflow = "hidden";
    setTimeout(() => { if (!dom.modal.hidden) dom.modalClose.focus(); }, 40);
  }

  /* ----------------------------------------------------------
     turnstile: only if the instance advertises a sitekey
     ---------------------------------------------------------- */
  let turnstileWidget = null;
  let turnstileToken = "";

  function loadTurnstile() {
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

  async function getTurnstileToken() {
    const key = instanceInfo && instanceInfo.turnstileSiteKey;
    if (!key) return "";
    try {
      const loaded = await loadTurnstile();
      if (!loaded) return "";
      if (!turnstileWidget) {
        const holder = document.createElement("div");
        holder.hidden = true;
        holder.id = "turnstile-holder";
        document.body.appendChild(holder);
        // current Turnstile has no "invisible" size: the widget stays out of
        // the way until it is executed, and only shows itself if it must ask
        turnstileWidget = window.turnstile.render(holder, {
          sitekey: key,
          appearance: "interaction-only",
          execution: "execute",
          callback: (token) => { turnstileToken = token; },
          "error-callback": () => { turnstileToken = ""; }
        });
      }
      turnstileToken = "";
      window.turnstile.execute(turnstileWidget);
      for (let i = 0; i < 200 && !turnstileToken; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const token = turnstileToken;
      turnstileToken = "";
      try { window.turnstile.reset(turnstileWidget); } catch (e) { /* fine */ }
      return token;
    } catch (e) {
      return "";
    }
  }

  /* ----------------------------------------------------------
     probe: what the file will be, before fetching it
     ---------------------------------------------------------- */
  const PROBE_CACHE = new Map();
  const PROBE_KEEP = 24;
  let probeTimer = null;
  let probeSeq = 0;

  function probeKey(url, mode) {
    return [url, mode || settings.downloadMode, settings.videoQuality,
      settings.audioFormat, settings.audioBitrate].join("|");
  }

  function probeSupported() {
    return !!(instanceInfo && instanceInfo.probe && apiEndpoint());
  }

  function readProbe(key) {
    const hit = PROBE_CACHE.get(key);
    if (!hit) return null;
    // refresh its position so the map behaves as a small LRU
    PROBE_CACHE.delete(key);
    PROBE_CACHE.set(key, hit);
    return hit;
  }

  function storeProbe(key, data) {
    PROBE_CACHE.set(key, data);
    while (PROBE_CACHE.size > PROBE_KEEP) {
      PROBE_CACHE.delete(PROBE_CACHE.keys().next().value);
    }
  }

  async function fetchProbe(url, mode) {
    const key = probeKey(url, mode);
    const cached = readProbe(key);
    if (cached) return cached;
    const endpoint = apiEndpoint();
    if (!endpoint) return null;
    const res = await fetch(endpoint + "probe", {
      method: "POST",
      headers: Object.assign({
        "Content-Type": "application/json",
        Accept: "application/json"
      }, authHeaders()),
      body: JSON.stringify({
        url,
        downloadMode: mode || settings.downloadMode,
        videoQuality: clampQuality(settings.videoQuality),
        audioFormat: clampFormat(settings.audioFormat),
        audioBitrate: clampBitrate(settings.audioBitrate)
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.status !== "ok") return null;
    storeProbe(key, data);
    return data;
  }

  function clockTime(seconds) {
    const total = Math.round(Number(seconds) || 0);
    if (!total) return "";
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = total % 60;
    if (hours) return hours + ":" + String(minutes).padStart(2, "0") + ":" + String(rest).padStart(2, "0");
    return minutes + ":" + String(rest).padStart(2, "0");
  }

  function renderProbe(data) {
    if (!dom.probePreview) return;
    const on = !!(data && data.status === "ok");
    dom.probePreview.classList.toggle("is-on", on);
    dom.probePreview.setAttribute("aria-hidden", on ? "false" : "true");
    if (!on) return;

    const estimate = data.estimate || {};
    const bits = [];
    if (data.tooLong) bits.push("too long for this server");
    if (estimate.bytes) bits.push((estimate.exact ? "~" : "≈") + " " + formatBytes(estimate.bytes));
    if (data.duration) bits.push(clockTime(data.duration));
    if (estimate.height) bits.push(estimate.height + "p");
    dom.probeMeta.textContent = bits.join(" · ");
    dom.probeTitle.textContent = data.title || "";
    dom.probeTitle.title = data.title || "";

    if (data.thumbnail) {
      dom.probeThumb.style.backgroundImage = 'url("' + data.thumbnail + '")';
      dom.probeThumb.dataset.empty = "false";
    } else {
      dom.probeThumb.style.backgroundImage = "";
      dom.probeThumb.dataset.empty = "true";
    }
  }

  /* Debounced: only one link, only when the instance advertises the endpoint,
     and the answer is thrown away if the field has moved on since. */
  function scheduleProbe(delay) {
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = null;
    const text = dom.input.value.trim();
    const urls = text ? parseUrls(text) : [];
    if (!probeSupported() || urls.length !== 1) {
      renderProbe(null);
      return;
    }
    const url = urls[0];
    const cached = readProbe(probeKey(url));
    if (cached) { renderProbe(cached); return; }
    renderProbe(null);
    probeTimer = setTimeout(() => {
      const stamp = ++probeSeq;
      fetchProbe(url).then((data) => {
        if (stamp !== probeSeq) return;
        if (dom.input.value.trim() !== text) return;
        renderProbe(data);
      }).catch(() => {});
    }, delay || 550);
  }

  function attachProbe(item, data) {
    if (!data || !item) return;
    item.thumb = data.thumbnail || "";
    item.estimate = data.estimate || null;
    item.previewTitle = data.title || "";
    item.duration = data.duration || 0;
    if (item.node) updateItem(item);
  }

  /* ----------------------------------------------------------
     sources: what this instance can actually reach
     ---------------------------------------------------------- */

  /* One flat alphabetical list of what mdown accepts. It is the union of this
     list and whatever instance you are connected to advertises, so a service
     the backend gains shows up without a release, and nothing that a server can
     actually fetch is ever missing from the panel. The encrypted services are
     not here on purpose: they cannot be downloaded, and listing them made the
     panel a wall of explanation nobody needs. */
  const SOURCES = [
    ["9gag", ""], ["audiomack", "audio"], ["bandcamp", "audio"], ["bilibili", ""],
    ["bluesky", ""], ["coub", ""], ["dailymotion", ""], ["douyin", ""],
    ["facebook", ""], ["hearthis", "audio"], ["imgur", ""], ["instagram", ""], ["kick", ""],
    ["loom", ""], ["mixcloud", "audio"], ["newgrounds", ""], ["odysee", ""],
    ["ok", ""], ["reddit", ""], ["rumble", ""], ["rutube", ""], ["snapchat", ""],
    ["soundcloud", "audio"], ["streamable", ""], ["threads", ""], ["tiktok", ""],
    ["tumblr", ""], ["twitch", ""], ["twitter", ""], ["vimeo", ""], ["vk", ""],
    ["xiaohongshu", ""], ["youtube", "4k"]
  ];

  let sourcesOpen = false;

  function closeSources() {
    if (!sourcesOpen) return;
    sourcesOpen = false;
    dom.openSources.setAttribute("aria-expanded", "false");
    const panel = dom.sourcesPanel;
    if (!panel || panel.hidden) return;
    panel.classList.add("is-closing");
    const done = () => {
      panel.classList.remove("is-closing");
      panel.hidden = true;
    };
    panel.addEventListener("animationend", done, { once: true });
    setTimeout(done, 220);   // if the animation is off (reduced motion)
  }

  /* The panel hangs from the top of the page and the wordmark sits a short
     drop below it. Rather than guess a height that overlaps on one screen and
     wastes space on another, measure the gap and cap to it. */
  function fitSources() {
    const panel = dom.sourcesPanel;
    if (!panel || panel.hidden) return;
    const logo = document.querySelector(".hero-logo");
    const top = panel.getBoundingClientRect().top;
    const stop = logo ? logo.getBoundingClientRect().top : window.innerHeight;
    const room = Math.round(Math.min(200, Math.max(88, stop - top - 14)));
    panel.style.maxHeight = room + "px";
  }

  function toggleSources() {
    if (sourcesOpen) { closeSources(); return; }
    sourcesOpen = true;
    dom.sourcesPanel.classList.remove("is-closing");
    renderSources();
    dom.openSources.setAttribute("aria-expanded", "true");
    dom.sourcesPanel.hidden = false;
    fitSources();
    const field = dom.sourcesPanel.querySelector("#sources-search");
    if (field) setTimeout(() => field.focus(), 40);
    requestAnimationFrame(fitSources);
  }

  const REFUSED_SOURCES = ["spotify", "deezer", "tidal", "apple_music", "applemusic"];

  function sourceList() {
    const known = new Map(SOURCES);
    ((instanceInfo && instanceInfo.services) || []).forEach((name) => {
      if (typeof name !== "string" || !name) return;
      if (REFUSED_SOURCES.indexOf(name.toLowerCase()) >= 0) return;
      if (!known.has(name)) known.set(name, "");
    });
    return Array.from(known.entries());
  }

  function renderSources() {
    const shown = sourceList().sort((a, b) => a[0].localeCompare(b[0]));

    const wrap = el("div", { class: "sources" });

    const search = el("input", {
      type: "search",
      class: "text-input sources-search",
      id: "sources-search",
      placeholder: "filter",
      autocomplete: "off",
      "aria-label": "filter supported sources"
    });
    wrap.appendChild(search);

    const row = el("div", { class: "source-chips" });
    const chips = shown.map(([id, note]) => {
      const chip = el("span", { class: "source-chip" });
      chip.textContent = id;
      chip.dataset.search = (id + " " + note).toLowerCase();
      if (note) chip.title = id + " — " + note;
      row.appendChild(chip);
      return chip;
    });
    wrap.appendChild(row);

    const empty = el("p", { class: "sources-empty", text: "nothing matches that" });
    empty.hidden = true;
    wrap.appendChild(empty);


    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      let hits = 0;
      chips.forEach((chip) => {
        const hit = !q || chip.dataset.search.indexOf(q) >= 0;
        chip.hidden = !hit;
        if (hit) hits++;
      });
      empty.hidden = hits > 0;
    });

    dom.sourcesPanel.innerHTML = "";
    dom.sourcesPanel.appendChild(wrap);
  }

  /* ----------------------------------------------------------
     donations: identity-free by construction
     ---------------------------------------------------------- */
  function donateConfig() {
    const cfg = window.MDOWN_DONATE;
    if (!cfg || cfg.enabled !== true) return null;
    const methods = Array.isArray(cfg.methods)
      ? cfg.methods.filter((m) => m && typeof m === "object" && (m.value || m.href))
      : [];
    return methods.length ? { methods, note: typeof cfg.note === "string" ? cfg.note : "" } : null;
  }

  function renderDonate() {
    const cfg = donateConfig();
    /* a nav link to a closed tip jar is just a dead end */
    document.querySelectorAll(".nav-donate").forEach((link) => {
      link.hidden = !cfg;
    });
    if (!dom.donateLink || !dom.donateWrap) return;
    /* the wrapper carries the leading separator, so hide that rather than
       leaving a dangling " · " when donations are off */
    dom.donateWrap.hidden = !cfg;
    if (!cfg) return;
    if (dom.donateLink.dataset.bound === "1") return;
    dom.donateLink.dataset.bound = "1";
    dom.donateLink.addEventListener("click", (event) => {
      event.preventDefault();
      openDonate();
    });
    /* the link may have been rendered before the config existed */
    dom.donateLink.removeAttribute("aria-disabled");
  }

  function openDonate() {
    const cfg = donateConfig();
    if (!cfg) return;

    const wrap = el("div", { class: "donate" });
    wrap.appendChild(el("p", {
      class: "donate-lede",
      text: "mdown is free, has no ads, and keeps nothing about you. Nothing here unlocks anything — it is just a tip jar."
    }));
    if (cfg.note) wrap.appendChild(el("p", { class: "donate-note", text: cfg.note }));

    const list = el("div", { class: "donate-list" });
    cfg.methods.forEach((method) => {
      const row = el("div", { class: "donate-row" });
      const left = el("div", { class: "donate-id" });
      left.appendChild(el("span", { class: "donate-label", text: String(method.label || method.id || "tip") }));

      if (method.href) {
        const link = el("a", {
          class: "donate-value",
          href: String(method.href),
          text: String(method.href).replace(/^https?:\/\//, ""),
          rel: "noopener noreferrer",
          target: "_blank"
        });
        left.appendChild(link);
      } else {
        left.appendChild(el("code", { class: "donate-value", text: String(method.value) }));
      }
      if (method.note) left.appendChild(el("span", { class: "donate-hint", text: String(method.note) }));
      row.appendChild(left);

      if (!method.href && method.value) {
        row.appendChild(el("button", {
          type: "button",
          class: "ghost-btn small",
          text: "copy",
          onclick: () => copyText(String(method.value), "Address copied")
        }));
      }
      list.appendChild(row);
    });
    wrap.appendChild(list);

    wrap.appendChild(el("p", {
      class: "donate-fine",
      text: "No receipts, no accounts, no tracking, and donating does not buy priority. If a tip page is listed, it shows whatever name that account uses."
    }));

    const close = el("button", { type: "button", class: "ghost-btn small", text: "close", onclick: () => closeModal() });
    openModal("Donate", wrap, [close]);
  }

  function closeModal() {
    if (dom.modal.hidden) return;
    dom.modal.hidden = true;
    if (dom.sheet.hidden) document.body.style.overflow = "";
    if (modalReturnFocus && typeof modalReturnFocus.focus === "function") {
      modalReturnFocus.focus();
    }
    modalReturnFocus = null;
  }

  $$("[data-close-modal]", dom.modal).forEach((node) => {
    node.addEventListener("click", () => closeModal());
  });
  dom.modal.addEventListener("click", (event) => {
    if (event.target === dom.modal) closeModal();
  });

  /* ----------------------------------------------------------
     clipboard
     ---------------------------------------------------------- */
  async function copyText(text, message) {
    try {
      await navigator.clipboard.writeText(text);
      toast(message || "Copied", "ok");
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); toast(message || "Copied", "ok"); return true; }
      catch { toast("Copy failed — select the text manually.", "err"); return false; }
      finally { ta.remove(); }
    }
  }

  /* ----------------------------------------------------------
     instance
     ---------------------------------------------------------- */
  function setInstancePill(state, label, title) {
    dom.instancePill.dataset.state = state;
    dom.instancePillLabel.textContent = label;
    dom.instancePill.setAttribute("aria-label", "server: " + label);
    if (title) dom.instancePill.title = title;
  }

  function setInstanceDetail(state, title, meta, errorText) {
    dom.instanceDetail.dataset.state = state;
    dom.instanceDetailTitle.textContent = title;
    dom.instanceMeta.innerHTML = "";
    (meta || []).forEach(([key, value]) => {
      const row = el("div");
      row.appendChild(el("dt", { text: key }));
      row.appendChild(el("dd", { text: value }));
      dom.instanceMeta.appendChild(row);
    });
    dom.instanceError.hidden = !errorText;
    dom.instanceError.textContent = errorText || "";
  }

  /* The note under the composer answers one question: why can't I download?
     "not set up" and "configured but down" look identical to a visitor, so
     they must not look identical on screen. */
  function setSetupNote(kind) {
    if (!dom.setupNote) return;
    if (!kind) {
      dom.setupNote.hidden = true;
      return;
    }
    dom.setupNote.hidden = false;
    if (kind === "unreachable") {
      dom.setupLead.textContent = "Can't reach the API — ";
      dom.setupButton.textContent = "check the address";
      dom.setupTail.textContent = " or try again in a moment.";
    } else {
      dom.setupLead.textContent = "Not connected — ";
      dom.setupButton.textContent = "connect an API";
      dom.setupTail.textContent = " to download.";
    }
  }

  async function checkInstance(options) {
    const opts = options || {};
    const base = normalizeInstance(settings.instance);
    setSetupNote(base ? null : "empty");

    if (!base) {
      instanceInfo = null;
      setInstancePill("unknown", "not connected", "No API connected");
      setInstanceDetail("empty", "Not connected", []);
      dom.servicesCard.hidden = true;
      return false;
    }

    if (!opts.silent) {
      setInstancePill("checking", "checking…", base);
      setInstanceDetail("checking", "Contacting instance…", []);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);

    try {
      const res = await fetch(base.replace(/\/+$/, "") + "/", {
        method: "GET",
        headers: Object.assign({ Accept: "application/json" }, authHeaders()),
        signal: controller.signal
      });
      if (res.status === 401 || res.status === 403) {
        throw new Error("The API refused the request (HTTP " + res.status + "). Add or check the API key in Settings → Server.");
      }
      if (!res.ok) throw new Error("The API answered HTTP " + res.status + ".");
      const data = await res.json();
      const cobalt = data && data.cobalt ? data.cobalt : {};
      const git = data && data.git ? data.git : {};

      instanceInfo = {
        services: Array.isArray(cobalt.services) ? cobalt.services : [],
        version: cobalt.version || "",
        // honest capability flag: only an instance that answers /probe gets a
        // size estimate and a thumbnail, everything else looks exactly as before
        probe: cobalt.probe === true,
        limits: cobalt.limits && typeof cobalt.limits === "object" ? cobalt.limits : null,
        turnstileSiteKey: typeof cobalt.turnstileSitekey === "string" ? cobalt.turnstileSitekey : ""
      };
      // keep the trigger and an open panel agreeing about the count
      if (dom.sourcesCount) dom.sourcesCount.textContent = String(sourceList().length);
      if (sourcesOpen) renderSources();
      if (dom.footerVersion) dom.footerVersion.textContent = "mdown.cc · api " + (cobalt.version || "v11");
      const host = hostOf(base) || base;
      // keep the Server pane's health link pointing at the live instance
      if (dom.openHealth) dom.openHealth.href = base.replace(/\/+$/, "") + "/health";
      const usingDefault = normalizeInstance(settings.instance) === normalizeInstance(DEFAULT_INSTANCE);
      const detail = base + (cobalt.version ? " · api " + cobalt.version : "");
      setInstancePill("ok", usingDefault ? "online" : host, detail);
      recordHealth(true);

      const uptime = cobalt.startTime ? formatUptime(Number(cobalt.startTime)) : "unknown";
      setInstanceDetail("ok", "Connected", [
        ["server", hostOf(base) || base],
        ["services", String(instanceInfo.services.length || "unknown")],
        ["up", uptime],
        ["version", cobalt.version || "unknown"]
      ]);

      setSetupNote(null);
      renderServices(instanceInfo.services);
      updateComposerState();
      return true;
    } catch (err) {
      recordHealth(false);
      const message = err && err.name === "AbortError"
        ? "The API didn't respond within 12 seconds."
        : friendlyError(err);
      instanceInfo = null;
      setInstancePill("bad", "unreachable", message);
      setInstanceDetail("bad", "Can't reach this instance", [], message);
      setSetupNote("unreachable");
      dom.servicesCard.hidden = true;
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  function formatUptime(startTime) {
    const diff = Date.now() - startTime;
    if (!Number.isFinite(diff) || diff < 0) return "unknown";
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return days + "d " + (hours % 24) + "h";
    if (hours > 0) return hours + "h " + (minutes % 60) + "m";
    return Math.max(1, minutes) + "m";
  }

  function renderServices(services) {
    dom.servicesChips.innerHTML = "";
    dom.servicesCount.textContent = String(services.length);
    dom.servicesCard.hidden = !services.length;
    services.forEach((service) => {
      const chip = el("button", { type: "button", class: "chip", title: "Open a " + service + " link" });
      chip.innerHTML = markForService(service) + '<span class="chip-name"></span>';
      chip.querySelector(".chip-name").textContent = service;
      chip.addEventListener("click", () => {
        dom.input.focus();
        dom.input.value = "";
        dom.input.placeholder = "Paste a " + service + " link…";
      });
      dom.servicesChips.appendChild(chip);
    });
  }

  /* ----------------------------------------------------------
     settings: reflect + bind
     ---------------------------------------------------------- */
  function reflectSettings() {
    if (document.activeElement !== dom.instanceUrl) dom.instanceUrl.value = settings.instance || "";
    if (document.activeElement !== dom.apiKey) dom.apiKey.value = settings.apiKey || "";

    $$("[data-setting]").forEach((node) => {
      const key = node.dataset.setting;
      const value = settings[key];

      if (node.tagName === "SELECT") {
        node.value = String(value);
        return;
      }
      if (node.classList.contains("seg")) {
        $$("button", node).forEach((btn) => {
          btn.setAttribute("aria-checked", String(btn.dataset.value) === String(value) ? "true" : "false");
        });
        return;
      }
      if (node.type === "checkbox") {
        node.checked = !!value;
      }
    });

    if (dom.apiKey) dom.apiKey.placeholder = settings.apiKey ? "saved" : "paste instance api key";
    renderModes();
    syncAudioControls();
    updateFileNamePreview();
    updateRequestPreview();
    applyTheme();
    setSetupNote(normalizeInstance(settings.instance) ? null : "empty");
  }

  /* The preview is the file, not a label for it: same name the queue will
     show, the same container and the same quality, for the mode in force. */
  function updateFileNamePreview() {
    const mode = settings.downloadMode;
    const quality = settings.videoQuality + "p";
    const codec = settings.youtubeVideoCodec;
    const container = mode === "auto"
      ? (settings.youtubeVideoContainer === "auto" ? (codec === "h264" ? "mp4" : "webm") : settings.youtubeVideoContainer)
      : (settings.youtubeVideoContainer === "auto" ? (codec === "h264" ? "mp4" : "mkv") : settings.youtubeVideoContainer);

    const videoName = {
      classic: "Video Title." + container,
      basic: "Video Title - Video Author (" + quality + ")." + container,
      pretty: "Video Title (" + quality + ")." + container,
      nerdy: "Video Title_" + quality + "_" + codec + "_Video Author." + container
    }[settings.filenameStyle] || ("Video Title - Video Author (" + quality + ")." + container);

    const audioName = "Audio Title - Audio Author." + audioExt();
    const isAudio = mode === "audio";

    if (dom.previewVideo) dom.previewVideo.textContent = isAudio ? audioName : videoName;
    if (dom.previewMeta) {
      dom.previewMeta.textContent = isAudio
        ? (settings.audioFormat === "best"
            ? "source · untouched"
            : settings.audioFormat + " · " + settings.audioBitrate + " kb/s" + (settings.audioCovers ? " · cover art" : ""))
        : (container + " · " + quality + " · " + (mode === "mute" ? "no sound" : codec));
    }
    if (dom.previewTag) dom.previewTag.textContent = isAudio ? "audio" : (mode === "mute" ? "silent" : "video");
  }

  function bindSettings() {
    $$("[data-setting]").forEach((node) => {
      if (node.classList.contains("seg")) {
        node.addEventListener("click", (event) => {
          const btn = event.target.closest("button[data-value]");
          if (!btn) return;
          const key = node.dataset.setting;
          settings[key] = btn.dataset.value;
          saveSettings();
          if (key === "theme") applyTheme();
          reflectSettings();
          updateComposerState();
        });
        return;
      }
      node.addEventListener("change", () => {
        const key = node.dataset.setting;
        if (node.type === "checkbox") settings[key] = node.checked;
        else settings[key] = node.value;
        saveSettings();
        updateFileNamePreview();
        updateRequestPreview();
        updateComposerState();
        scheduleProbe(150);
      });
    });

    dom.instanceUrl.addEventListener("input", () => {
      settings.instance = dom.instanceUrl.value.trim();
      saveSettings();
      setSetupNote(normalizeInstance(settings.instance) ? null : "empty");
      updateComposerState();
    });
    dom.instanceUrl.addEventListener("blur", () => {
      const normalized = normalizeInstance(settings.instance);
      if (normalized && normalized !== settings.instance) {
        settings.instance = normalized;
        dom.instanceUrl.value = normalized;
        saveSettings();
      }
      if (normalized) checkInstance({ silent: false });
    });
    dom.instanceUrl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); checkInstance(); }
    });
    dom.apiKey.addEventListener("input", () => {
      settings.apiKey = dom.apiKey.value.trim();
      saveSettings();
    });
    dom.checkInstance.addEventListener("click", () => checkInstance());
    dom.refreshInstance.addEventListener("click", () => checkInstance());

    $("#export-settings").addEventListener("click", () => {
      const payload = JSON.stringify(settings, null, 2);
      const blob = new Blob([payload], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "mdown-settings.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast("Settings exported", "ok");
    });

    $("#import-settings").addEventListener("click", () => $("#import-file").click());
    $("#import-file").addEventListener("change", async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object") throw new Error("not an object");
        settings = Object.assign({}, DEFAULT_SETTINGS, parsed);
        saveSettings();
        reflectSettings();
        checkInstance();
        toast("Settings imported", "ok");
      } catch {
        toast("That file isn't valid settings JSON.", "err");
      }
      event.target.value = "";
    });

    $("#reset-settings").addEventListener("click", () => {
      const theme = settings.theme;
      settings = Object.assign({}, DEFAULT_SETTINGS, { theme });
      saveSettings();
      reflectSettings();
      checkInstance();
      toast("Settings reset", "ok");
    });

    $("#clear-history").addEventListener("click", () => {
      recentLinks = [];
      saveHistory();
      renderHistory();
      toast("Recent links cleared", "ok");
    });

    $("#clear-queue-all").addEventListener("click", () => {
      queue.forEach((item) => {
        cancelItem(item, true);
        if (item.blobUrl) URL.revokeObjectURL(item.blobUrl);
      });
      queue = [];
      renderQueue();
      toast("Queue cleared", "ok");
    });
  }

  /* ----------------------------------------------------------
     help
     ---------------------------------------------------------- */
  function openHelp() {
    const template = $("#help-template");
    if (!template) return;
    const body = template.content.cloneNode(true);
    const close = el("button", { type: "button", class: "primary-btn", text: "got it" });
    close.addEventListener("click", () => closeModal());
    openModal("How it works", body, [close]);
  }

  /* ----------------------------------------------------------
     settings sheet
     ---------------------------------------------------------- */
  let lastFocused = null;

  function openSettings(section) {
    if (healthOpen) closeHealthPop();
    lastFocused = document.activeElement;
    dom.sheet.hidden = false;
    document.body.style.overflow = "hidden";
    if (section) showSettingsSection(section);
    reflectSettings();
    setTimeout(() => {
      const pane = $('.pane.is-active [data-setting], .pane.is-active input, .pane.is-active select');
      const target = section === "instance" ? dom.instanceUrl : pane;
      if (target && typeof target.focus === "function") target.focus();
    }, 60);
  }

  function closeSettings() {
    dom.sheet.hidden = true;
    document.body.style.overflow = "";
    if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
  }

  function showSettingsSection(name) {
    $$(".sheet-nav-item").forEach((btn) => btn.classList.toggle("is-active", btn.dataset.section === name));
    $$(".pane").forEach((pane) => pane.classList.toggle("is-active", pane.dataset.pane === name));
    dom.sheetBody.scrollTop = 0;
    updateRequestPreview();
  }

  /* ----------------------------------------------------------
     health: the dot opens a miniature of the status page
     ---------------------------------------------------------- */
  const HEALTH_KEY = "mdown.uptime";
  const HEALTH_BARS = 36;
  let healthOpen = false;
  let healthTimer = null;
  let healthCloseTimer = null;

  function readHealth() {
    try {
      const parsed = JSON.parse(localStorage.getItem(HEALTH_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.filter((x) => x && typeof x.ok === "boolean") : [];
    } catch (e) {
      return [];
    }
  }

  /* a successful instance check is a health sample too, so the graph fills in
     over visits without a single extra request. One sample a minute is enough. */
  function recordHealth(ok) {
    const history = readHealth();
    const last = history[history.length - 1];
    if (last && Date.now() - last.t < 60000 && last.ok === !!ok) return history;
    return pushHealth(ok);
  }

  function pushHealth(ok) {
    const history = readHealth();
    history.push({ t: Date.now(), ok: !!ok });
    while (history.length > 480) history.shift();
    try { localStorage.setItem(HEALTH_KEY, JSON.stringify(history)); } catch (e) {}
    return history;
  }

  function renderHealthBars(history) {
    const strip = dom.hpStrip;
    if (!strip) return;
    const recent = history.slice(-HEALTH_BARS);
    const pad = Math.max(0, HEALTH_BARS - recent.length);
    strip.innerHTML = "";
    for (let i = 0; i < pad; i += 1) {
      strip.appendChild(el("span", { class: "hp-bar", "data-empty": "true" }));
    }
    recent.forEach((entry, i) => {
      const bar = el("span", { class: "hp-bar" });
      bar.dataset.ok = entry.ok ? "true" : "false";
      if (typeof bar.animate === "function") {
        bar.animate(
          [{ transform: "scaleY(0.25)", opacity: 0 }, { transform: "scaleY(1)", opacity: 1 }],
          { duration: 280, delay: Math.min(i, 10) * 14, easing: "cubic-bezier(.22,.8,.3,1)", fill: "both" }
        );
      }
      strip.appendChild(bar);
    });

    const total = history.length;
    const up = history.filter((x) => x.ok).length;
    if (dom.hpPct) {
      dom.hpPct.textContent = total
        ? Math.round((up / total) * 1000) / 10 + "% up · " + total + " check" + (total === 1 ? "" : "s")
        : "no checks yet";
    }
  }

  function setHealthState(state, label, uptime) {
    if (!dom.healthPop) return;
    dom.healthPop.dataset.state = state;
    if (dom.hpState) dom.hpState.textContent = label;
    if (dom.hpUptime && uptime !== undefined) dom.hpUptime.textContent = uptime || "";
    if (dom.instancePill && (state === "ok" || state === "bad" || state === "checking")) {
      dom.instancePill.dataset.state = state;
    }
  }

  async function checkHealth() {
    const endpoint = apiEndpoint();
    if (!endpoint) {
      setHealthState("bad", "not connected", "");
      renderHealthBars(readHealth());
      return;
    }
    setHealthState("checking", "checking…", "");
    try {
      const res = await fetch(endpoint + "health", {
        headers: Object.assign({ Accept: "application/json" }, authHeaders()),
        cache: "no-store"
      });
      const body = await res.json().catch(() => null);
      const ok = res.ok && (!body || body.status !== "degraded");
      renderHealthBars(pushHealth(ok));
      const up = body && Number(body.uptimeSeconds)
        ? formatUptime(Date.now() - Number(body.uptimeSeconds) * 1000)
        : "";
      setHealthState(ok ? "ok" : "bad", ok ? "online" : "down", up);
    } catch (e) {
      renderHealthBars(pushHealth(false));
      setHealthState("bad", "unreachable", "");
    }
  }

  function startHealthTimer() {
    if (healthTimer) return;
    healthTimer = setInterval(() => {
      if (!healthOpen || document.hidden) return;
      checkHealth();
    }, 60000);
  }

  function openHealthPop() {
    if (!dom.healthPop || healthOpen) return;
    healthOpen = true;
    clearTimeout(healthCloseTimer);
    dom.healthPop.hidden = false;
    dom.healthPop.classList.remove("is-closing");
    dom.instancePill.setAttribute("aria-expanded", "true");
    renderHealthBars(readHealth());
    checkHealth();
    startHealthTimer();
  }

  function closeHealthPop() {
    if (!dom.healthPop || !healthOpen) return;
    healthOpen = false;
    dom.instancePill.setAttribute("aria-expanded", "false");
    dom.healthPop.classList.add("is-closing");
    healthCloseTimer = setTimeout(() => {
      dom.healthPop.hidden = true;
      dom.healthPop.classList.remove("is-closing");
    }, 120);
  }

  function bindSheet() {
    $("#open-settings").addEventListener("click", () => openSettings());
    dom.setupOpenSettings.addEventListener("click", () => openSettings("instance"));
    /* the dot is the connection: click for a miniature of the status page,
       the gear is still the way into the settings */
    dom.instancePill.addEventListener("click", (event) => {
      event.stopPropagation();
      if (healthOpen) closeHealthPop();
      else openHealthPop();
    });
    if (dom.hpSettings) {
      dom.hpSettings.addEventListener("click", () => {
        closeHealthPop();
        openSettings("instance");
      });
    }
    document.addEventListener("click", (event) => {
      if (!healthOpen) return;
      if (event.target.closest("#health")) return;
      closeHealthPop();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && healthOpen) {
        closeHealthPop();
        dom.instancePill.focus();
      }
    });

    if (dom.openSources) {
      dom.openSources.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleSources();
      });
      document.addEventListener("click", (event) => {
        if (!sourcesOpen) return;
        if (dom.sourcesWrap && dom.sourcesWrap.contains(event.target)) return;
        closeSources();
      });
    }

    if (dom.openHealth) {
      dom.openHealth.addEventListener("click", (event) => {
        const base = normalizeInstance(settings.instance);
        if (!base) { event.preventDefault(); return; }
        dom.openHealth.href = base.replace(/\/+$/, "") + "/health";
      });
    }

    const help = $("#open-help");
    if (help) help.addEventListener("click", openHelp);
    $$("[data-close-settings]").forEach((node) => node.addEventListener("click", closeSettings));

    $$(".sheet-nav-item").forEach((btn) => {
      btn.addEventListener("click", () => showSettingsSection(btn.dataset.section));
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (!dom.modal.hidden) {
          closeModal();
        } else if (!dom.sheet.hidden) {
          closeSettings();
        } else if (sourcesOpen) {
          closeSources();
        } else if (dockOpen) {
          setDock(false);
        }
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSettings();
      }
      if (event.key === "Tab") {
        const container = dom.modal.hidden ? (dom.sheet.hidden ? null : dom.sheet) : dom.modal;
        if (!container) return;
        const focusable = $$(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          container
        ).filter((node) => !node.disabled && node.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
      }
    });
  }

  /* ----------------------------------------------------------
     history
     ---------------------------------------------------------- */
  function addHistory(url) {
    recentLinks = [url].concat(recentLinks.filter((u) => u !== url)).slice(0, HISTORY_LIMIT);
    saveHistory();
    renderHistory();
  }

  function renderHistory() {
    dom.recent.innerHTML = "";
    dom.recent.hidden = recentLinks.length === 0;
    if (!recentLinks.length) return;
    dom.recent.appendChild(el("span", { class: "recent-label", text: "recent" }));
    const seen = new Set();
    recentLinks.forEach((url) => {
      const host = hostOf(url) || url;
      if (seen.has(host) || seen.size >= 5) return;
      seen.add(host);
      const item = el("button", { type: "button", class: "recent-item", text: host });
      item.title = url;
      item.addEventListener("click", () => {
        dom.input.value = url;
        updateComposerState();
        dom.input.focus();
      });
      dom.recent.appendChild(item);
    });
  }

  /* ----------------------------------------------------------
     composer events
     ---------------------------------------------------------- */
  function bindComposer() {
    dom.input.addEventListener("input", updateComposerState);
    dom.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submitUrls(dom.input.value);
      }
    });

    dom.form.addEventListener("submit", (event) => {
      event.preventDefault();
      submitUrls(dom.input.value);
    });

    dom.clearBtn.addEventListener("click", () => {
      dom.input.value = "";
      updateComposerState();
      dom.input.focus();
    });

    dom.pasteBtn.addEventListener("click", async () => {
      const blocked = IS_TOUCH
        ? "Clipboard is blocked here — tap and hold the field to paste."
        : "Clipboard is blocked here — press ⌘V to paste.";
      if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") {
        toast(blocked, "warn");
        focusForPaste();
        return;
      }
      try {
        const text = await navigator.clipboard.readText();
        if (!text) { toast("Clipboard is empty.", "warn"); return; }
        dom.input.value = text;
        updateComposerState();
        if (parseUrls(text).length === 1) submitUrls(text);
      } catch {
        toast(blocked, "warn");
        focusForPaste();
      }
    });

    /* put the caret where the paste should land, and select whatever is there
       so a long-press paste replaces it instead of appending */
    function focusForPaste() {
      dom.input.focus();
      try { dom.input.select(); } catch { /* not selectable */ }
    }

    dom.modes.forEach((btn) => {
      btn.addEventListener("click", () => {
        settings.downloadMode = btn.dataset.mode;
        saveSettings();
        renderModes();
        updateComposerState();
      });
    });

    dom.clearFinished.addEventListener("click", clearFinished);

    if (dom.queueToggle) {
      dom.queueToggle.addEventListener("click", (event) => {
        event.stopPropagation();
        setDock(!dockOpen);
      });
      document.addEventListener("click", (event) => {
        if (!dockOpen) return;
        if (dom.queueDock.contains(event.target)) return;
        if (event.target && event.target.closest && event.target.closest("[data-ignore-dock]")) return;
        setDock(false);
      });
    }

    dom.quickpickButtons.forEach((btn) => {
      btn.addEventListener("click", () => resolveQuickPick(btn.dataset.pick));
    });
    if (dom.quickpickCancel) {
      dom.quickpickCancel.addEventListener("click", () => hideQuickPick(true));
    }
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || dom.quickpick.hidden) return;
      hideQuickPick(true);
    });

    dom.hint.addEventListener("click", () => {
      if (dom.hint.dataset.action !== "audio") return;
      settings.downloadMode = "audio";
      saveSettings();
      renderModes();
      updateComposerState();
    });

    const tune = $("#tune-mode");
    if (tune) {
      tune.addEventListener("click", () => openSettings(settings.downloadMode === "audio" ? "audio" : "video"));
    }

    document.addEventListener("dragover", (event) => {
      event.preventDefault();
      dom.composer.classList.add("is-dropping");
    });
    document.addEventListener("dragleave", (event) => {
      if (event.relatedTarget === null) dom.composer.classList.remove("is-dropping");
    });
    document.addEventListener("drop", async (event) => {
      event.preventDefault();
      dom.composer.classList.remove("is-dropping");
      const transfer = event.dataTransfer;
      if (!transfer) return;
      let text = transfer.getData("text/plain") || transfer.getData("text/uri-list") || "";
      const file = transfer.files && transfer.files[0];
      if (!text && file && /\.(txt|csv|json|md)$/i.test(file.name)) {
        try { text = await file.text(); } catch { text = ""; }
      }
      if (!text.trim()) return;
      dom.input.value = text.trim();
      updateComposerState();
      submitUrls(text);
      dom.input.focus();
    });

    document.addEventListener("paste", (event) => {
      if (event.target === dom.input) return;
      const text = (event.clipboardData || window.clipboardData);
      if (!text) return;
      const value = text.getData("text");
      if (!value) return;
      const tag = (document.activeElement && document.activeElement.tagName) || "";
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
      if (!parseUrls(value).length) return;
      event.preventDefault();
      dom.input.value = value;
      updateComposerState();
      dom.input.focus();
    });
  }

  /* ----------------------------------------------------------
     boot
     ---------------------------------------------------------- */
  /* The field is the only thing this page is for, so it owns the caret. Select,
     not just focus: typing replaces whatever is there instead of appending. */
  function focusComposer() {
    if (!dom.input) return;
    if (dom.modal && !dom.modal.hidden) return;
    if (dom.sheet && !dom.sheet.hidden) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== dom.input) return;
    if (active === dom.input) { try { dom.input.select(); } catch (e) {} return; }
    try {
      dom.input.focus({ preventScroll: true });
      dom.input.select();
    } catch (e) {}
  }

  function boot() {
    renderDonate();
    applyTheme();
    reflectSettings();
    bindSettings();
    bindSheet();
    bindComposer();
    renderHistory();
    renderQueue();
    updateComposerState();
    checkInstance({ silent: true });
    autosize();
    focusComposer();

    /* coming back to the tab puts the caret back where you left it — the same
       thing as arriving for the first time */
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") focusComposer();
    });

    if (location.protocol === "file:") {
      const note = $("#file-note");
      if (note) note.hidden = false;
    }

    const bookmarklet = $("#bookmarklet");
    if (bookmarklet) {
      const base = location.origin + location.pathname.replace(/index\.html$/, "");
      bookmarklet.href =
        "javascript:(()=>{location.href='" + base + "?url='+encodeURIComponent(location.href)})()";
    }

    takeDeepLink();

    window.addEventListener("resize", () => {
      if (sourcesOpen) fitSources();
    });

    if (location.hash === "#help") openHelp();
    window.addEventListener("hashchange", () => {
      if (location.hash === "#help") openHelp();
    });


    if (dom.footerVersion) {
      dom.footerVersion.textContent = instanceInfo && instanceInfo.version
        ? "mdown.cc · api " + instanceInfo.version
        : "mdown.cc";
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  /* dev hook: inspect state from the console / automated checks */
  window.md = {
    state: () => ({
      active,
      instance: settings.instance,
      rateRemaining,
      items: queue.map((i) => ({
        id: i.id,
        status: i.status,
        detail: i.detail,
        direct: i.direct,
        sourceUrl: i.sourceUrl,
        hasBlob: !!i.blob,
        filename: i.filename,
        received: i.received,
        size: i.size,
        error: i.error
      }))
    }),
    settings: () => Object.assign({}, settings),
    marks: () => Object.keys(SERVICE_MARKS),
    markHtml: (id) => markForService(id),
    refreshDonate: () => renderDonate(),
    isIOS: (ua, platform, touch) => isIOS(ua, platform, touch),
    pump
  };
})();
