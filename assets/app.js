/* ============================================================
   mdown — front-end for the cobalt v11 API contract
   plain JavaScript, no build step, no dependencies.

   API contract: https://github.com/imputnet/cobalt/blob/main/docs/api.md
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
  const DEFAULT_INSTANCE = "";

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
    "api.auth.apikey.missing": "This API requires a key.",
    "api.auth.apikey.invalid": "The API key was rejected.",
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
      if (!raw) return Object.assign({}, DEFAULT_SETTINGS);
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
    serviceName: $("#service-name"),
    composer: $("#composer"),
    setupNote: $("#setup-note"),
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
    emptyTip: $("#empty-tip"),
    clearFinished: $("#clear-finished"),
    servicesCard: $("#services-card"),
    servicesChips: $("#services-chips"),
    servicesCount: $("#services-count"),
    refreshInstance: $("#refresh-instance"),
    instancePill: $("#instance-pill"),
    instancePillLabel: $("#instance-pill-label"),
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
    previewAudio: $("#preview-audio"),
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
  function toast(message, tone) {
    const node = el("div", { class: "toast", "data-tone": tone || "info" });
    node.appendChild(el("span", { class: "dot" }));
    node.appendChild(el("span", { text: message }));
    dom.toasts.appendChild(node);
    const remove = () => {
      node.classList.add("is-leaving");
      setTimeout(() => node.remove(), 220);
    };
    setTimeout(remove, tone === "err" ? 6000 : 3800);
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
    dom.clearBtn.hidden = text.length === 0;
    autosize();

    const urls = parseUrls(text);
    const first = urls[0] || "";
    const detected = first ? detectService(first) : null;
    const service = detected && detected.id ? detected.id : null;

    dom.badge.dataset.empty = service ? "false" : "true";
    if (dom.serviceName) {
      dom.serviceName.hidden = !service;
      dom.serviceName.textContent = service || "";
    }
    dom.badge.setAttribute("aria-label", service ? "detected service: " + service : "detected service: unknown");
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
    if (mode === "mute") return container + " · muted";
    return container + " · " + qualityLabel();
  }

  function renderModes() {
    dom.modes.forEach((btn) => {
      const mode = btn.dataset.mode;
      const on = mode === settings.downloadMode;
      btn.setAttribute("aria-checked", on ? "true" : "false");
      
    });
    if (dom.formatNote) dom.formatNote.textContent = modeSummary(settings.downloadMode);
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
      toast("Paste at least one valid http(s) link.", "warn");
      dom.input.focus();
      return;
    }
    if (!apiEndpoint()) {
      toast("Connect an API first.", "warn");
      openSettings("instance");
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
      node: null,
      modalOpener: null
    };
    queue.push(item);
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
    if (item.status === "local") return "Local processing required";
    if (item.status === "picker") return "Multiple items found";
    if (item.url) return item.host || item.url;
    return "Untitled";
  }

  function metaFor(item) {
    const parts = [];
    if (item.service) parts.push(item.service);
    if (item.mode) parts.push(item.mode);
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
    }
    return parts;
  }

  function buildNode(item) {
    const node = el("div", { class: "qitem", "data-status": item.status, id: item.id });
    const icon = el("div", { class: "q-icon", "aria-hidden": "true" });
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
    node.appendChild(body);
    node.appendChild(actions);
    node.appendChild(progress);

    item.node = node;
    item.refs = { icon, title, meta, actions, fill };
    updateItem(item);
    return node;
  }

  function updateItem(item) {
    const node = item.node;
    if (!node) return;

    node.setAttribute("data-status", item.status);
    node.setAttribute("data-indeterminate", item.indeterminate ? "true" : "false");

    const { icon, title, meta, actions, fill } = item.refs;
    if (icon.innerHTML !== iconFor(item)) icon.innerHTML = iconFor(item);

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
    fill.style.width = pct + "%";

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

  function setDock(open) {
    if (!dom.queueDock || !dom.queuePanel) return;
    dockOpen = open;
    dom.queuePanel.hidden = !open;
    dom.queueToggle.setAttribute("aria-expanded", open ? "true" : "false");
    dom.queueDock.classList.toggle("is-open", open);
  }

  function updateQueueMeta() {
    const count = queue.length;
    const active = queue.filter((i) => ["queued", "working", "downloading"].includes(i.status)).length;

    if (dom.queueBadge) {
      const finished = queue.filter((i) => ["done", "error", "cancelled"].includes(i.status)).length;
      const show = active > 0 || finished > 0;
      dom.queueBadge.textContent = active > 0 ? String(active) : "•";
      dom.queueBadge.hidden = !show;
      dom.queueBadge.classList.toggle("is-dot", active === 0 && show);
    }
    if (count > 0 && lastQueueCount === 0 && window.innerWidth > 720) setDock(true);
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

    setStatus(item, "working", "requesting");

    try {
      const res = await fetch(apiEndpoint(), {
        method: "POST",
        headers: Object.assign({
          Accept: "application/json",
          "Content-Type": "application/json"
        }, authHeaders()),
        body: JSON.stringify(buildBody(item.url, item.mode)),
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

  function saveBlob(item) {
    if (!item.blob || !item.blobUrl) return;
    const link = document.createElement("a");
    link.href = item.blobUrl;
    link.download = item.filename || "download";
    link.dataset.ignoreDock = "true";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setStatus(item, "done", "saved");
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

  async function checkInstance(options) {
    const opts = options || {};
    const base = normalizeInstance(settings.instance);
    dom.setupNote.hidden = !!base;

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
        throw new Error("The API refused the request (HTTP " + res.status + "). Add or check the API key in Settings → Instances.");
      }
      if (!res.ok) throw new Error("The API answered HTTP " + res.status + ".");
      const data = await res.json();
      const cobalt = data && data.cobalt ? data.cobalt : {};
      const git = data && data.git ? data.git : {};

      instanceInfo = { services: Array.isArray(cobalt.services) ? cobalt.services : [], version: cobalt.version || "" };
      if (dom.footerVersion) dom.footerVersion.textContent = "mdown.cc · api " + (cobalt.version || "v11");
      const host = hostOf(base) || base;
      setInstancePill("ok", host, cobalt.version ? "api " + cobalt.version : host);

      const uptime = cobalt.startTime ? formatUptime(Number(cobalt.startTime)) : "unknown";
      setInstanceDetail("ok", "Connected", [
        ["version", cobalt.version || "unknown"],
        ["services", String(instanceInfo.services.length || "unknown")],
        ["uptime", uptime],
        ["commit", git.commit ? String(git.commit).slice(0, 8) : "unknown"]
      ]);

      renderServices(instanceInfo.services);
      updateComposerState();
      return true;
    } catch (err) {
      const message = err && err.name === "AbortError"
        ? "The API didn't respond within 12 seconds."
        : friendlyError(err);
      instanceInfo = null;
      setInstancePill("bad", "unreachable", message);
      setInstanceDetail("bad", "Can't reach this instance", [], message);
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
      const chip = el("button", { type: "button", class: "chip", text: service, title: "Open a " + service + " link" });
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
    dom.setupNote.hidden = !!normalizeInstance(settings.instance);
  }

  function updateFileNamePreview() {
    const title = "Video Title";
    const author = "Video Author";
    const quality = settings.videoQuality + "p";
    const codec = settings.youtubeVideoCodec;
    const styles = {
      classic: "Video Title.mp4",
      basic: title + " - " + author + " (" + quality + ").mp4",
      pretty: title + " (" + quality + ").mp4",
      nerdy: title + "_" + quality + "_" + codec + "_" + author + ".mp4"
    };
    if (dom.previewVideo) dom.previewVideo.textContent = styles[settings.filenameStyle] || styles.basic;
    if (dom.previewAudio) dom.previewAudio.textContent = "Audio Title - Audio Author." + audioExt();
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
      });
    });

    dom.instanceUrl.addEventListener("input", () => {
      settings.instance = dom.instanceUrl.value.trim();
      saveSettings();
      dom.setupNote.hidden = !!normalizeInstance(settings.instance);
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

  function bindSheet() {
    $("#open-settings").addEventListener("click", () => openSettings());
    dom.setupOpenSettings.addEventListener("click", () => openSettings("instance"));
    dom.instancePill.addEventListener("click", () => openSettings("instance"));

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
    dom.input.addEventListener("focus", () => dom.composer.classList.add("is-focused"));
    dom.input.addEventListener("blur", () => dom.composer.classList.remove("is-focused"));
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
      try {
        const text = await navigator.clipboard.readText();
        if (!text) { toast("Clipboard is empty.", "warn"); return; }
        dom.input.value = text;
        updateComposerState();
        if (parseUrls(text).length === 1) submitUrls(text);
      } catch {
        toast("Clipboard access was blocked — press ⌘V instead.", "warn");
        dom.input.focus();
      }
    });

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
  function boot() {
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
    dom.input.focus({ preventScroll: true });

    if (location.protocol === "file:") {
      const note = $("#file-note");
      if (note) note.hidden = false;
    }

    if (dom.emptyTip) {
      dom.emptyTip.textContent = location.host + "/<link> starts it instantly";
    }

    const bookmarklet = $("#bookmarklet");
    if (bookmarklet) {
      const base = location.origin + location.pathname.replace(/index\.html$/, "");
      bookmarklet.href =
        "javascript:(()=>{location.href='" + base + "?url='+encodeURIComponent(location.href)})()";
    }

    takeDeepLink();

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
        filename: i.filename,
        received: i.received,
        size: i.size,
        error: i.error
      }))
    }),
    settings: () => Object.assign({}, settings),
    pump
  };
})();
