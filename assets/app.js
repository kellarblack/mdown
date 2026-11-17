/* ============================================================
   mdown — front-end for the media-downloader API contract
   plain JavaScript, no build step, no dependencies.

   API contract: POST / with {url, downloadMode, videoQuality, audioFormat},
   answers {status:"tunnel", url, filename} or {status:"picker", ...}.
   ============================================================ */
(function () {
  "use strict";

  /* A refresh should start at the top of the page. Browsers restore the old
     scroll offset *after* layout, which reads as the composer jumping. */
  try { if ("scrollRestoration" in history) history.scrollRestoration = "manual"; } catch (e) {}

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
    muteVideo: false,
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
    ["soundcloud.app.goo.gl", "soundcloud"],
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
  /* services where a link is almost always a song. youtube is on this list but
     not on AUDIO_FIRST: it carries video too, so "audio only" would be a lie */
  const MUSIC_FIRST = new Set(["youtube", ...AUDIO_FIRST]);

  /* DRM-protected services. Nothing here can download from them, and pretending
     otherwise would be a lie, so they get a straight answer instead. */
  const DRM_SERVICES = new Map([
    ["spotify", "Spotify audio is encrypted, so this can't download from it. The same track is usually on YouTube or SoundCloud."],
    ["deezer", "Deezer audio is encrypted, so this can't download from it. Try the same track on YouTube or SoundCloud."],
    ["tidal", "Tidal audio is encrypted, so this can't download from it. Try the same track on YouTube or SoundCloud."],
    ["apple-music", "Apple Music audio is encrypted, so this can't download from it. Try the same track on YouTube or SoundCloud."]
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
    "api.auth.apikey.missing": "This instance needs an API key. Add it in Settings → Server.",
    "api.auth.apikey.invalid": "That API key was rejected. Check it in Settings → Server.",
    "api.auth.bearer.missing": "This instance requires a session token.",
    "api.auth.bearer.invalid": "The session token was rejected.",
    "api.auth.turnstile.missing": "The bot check did not finish. Reload and try once.",
    "api.auth.turnstile.invalid": "The bot check failed. Reload and try once.",
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

  function etaText(seconds) {
    if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return "";
    const total = Math.max(1, Math.round(seconds));
    if (total < 60) return total + "s left";
    const mins = Math.floor(total / 60);
    const rest = total % 60;
    if (mins < 60) return mins + "m" + (rest ? " " + rest + "s" : "") + " left";
    return Math.floor(mins / 60) + "h " + (mins % 60) + "m left";
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
      /* a settings blob written by this app carries a schema; one without it
         is a test harness or a pre-v2 visitor and keeps exactly what it set */
      const hadSchema = !!(parsed && typeof parsed === "object" && parsed.schema);
      const merged = Object.assign({}, DEFAULT_SETTINGS, parsed && typeof parsed === "object" ? parsed : {});
      if (!merged.instance && DEFAULT_INSTANCE) merged.instance = DEFAULT_INSTANCE;

      /* v2: subtitles now default to English instead of "none" */
      if (!merged.schema || merged.schema < 2) {
        if (!merged.subtitleLang || merged.subtitleLang === "none") merged.subtitleLang = "en";
        merged.schema = 2;
      }

      /* v5/v6: a finished file saves itself, whatever it is. anyone still on
         the old "ask" default is moved with it once more here, because the v5
         step only reached browsers that reloaded after it shipped. settings
         written before schemas existed (test harnesses) keep what they set. */
      if (hadSchema && merged.schema < 6) {
        if (merged.savingMethod === "ask") merged.savingMethod = "download";
        merged.schema = 6;
      }

      /* v4: the mode row is auto/audio/video; silent is a switch on video */
      if (!merged.schema || merged.schema < 4) {
        if (merged.downloadMode === "mute") {
          merged.downloadMode = "video";
          merged.muteVideo = true;
        }
        if (["auto", "audio", "video"].indexOf(merged.downloadMode) < 0) merged.downloadMode = "auto";
        merged.muteVideo = !!merged.muteVideo;
        merged.schema = 4;
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
    /* the board has nowhere to go without an instance, and it appears the
       moment one is set */
    boardVisible();
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

    modes: $$(".mode"),
    formatNote: $("#format-note"),
    hint: $("#composer-hint"),
    badge: $("#service-badge"),
    serviceMark: $("#service-mark"),
    serviceName: $("#service-name"),
    composer: $("#composer"),
    composerNote: $("#composer-note"),
    copyStatus: $("#composer-copy-status"),
    probePreview: $("#probe-preview"),
    probeThumb: $("#probe-thumb"),
    probeTitle: $("#probe-title"),
    probeMeta: $("#probe-meta"),
    setupNote: $("#setup-note"),
    setupLead: $("#setup-lead"),
    setupTail: $("#setup-tail"),
    setupButton: $("#setup-open-settings"),
    donateLink: $("#donate-link"),
    board: $("#board"),
    boardForm: $("#board-form"),
    boardText: $("#board-text"),
    boardSend: $("#board-send"),
    boardCount: $("#board-count"),
    boardState: $("#board-state"),
    boardList: $("#board-list"),
    boardReview: $("#board-review"),
    boardReviewList: $("#board-review-list"),
    boardReviewCount: $("#board-review-count"),
    boardInbox: $("#board-inbox"),
    boardInboxList: $("#board-inbox-list"),
    boardInboxCount: $("#board-inbox-count"),
    tipPop: $("#tip-pop"),
    openHealth: $("#open-health"),
    openSources: $("#open-sources"),
    sourcesPanel: $("#sources-panel"),
    sourcesWrap: $("#sources-wrap"),
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
    mbarBadge: $("#mbar-badge"),
    queueCount: $("#queue-count"),
    queueStats: $("#queue-stats"),
    queueClose: $("#queue-close"),
    miniDock: $("#mini-dock"),
    miniTitle: $("#mini-title"),
    miniMeta: $("#mini-meta"),
    miniFill: $("#mini-fill"),
    miniPct: $("#mini-pct"),
    miniEta: $("#mini-eta"),
    emptyState: $("#empty-state"),
    clearFinished: $("#clear-finished"),
    servicesCard: $("#services-card"),
    servicesChips: $("#services-chips"),
    servicesCount: $("#services-count"),
    instancePill: $("#instance-pill"),
    instancePillLabel: $("#instance-pill-label"),
    healthPop: $("#health-pop"),
    hpState: $("#hp-state"),
    hpUptime: $("#hp-uptime"),
    hpStrip: $("#hp-strip"),
    hpPct: $("#hp-pct"),
    hpChecks: $("#hp-checks"),
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
    toasts: $("#toasts")
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
  let nudgeTimer = null;
  function nudgeComposer() {
    if (!dom.composer) return;
    const now = Date.now();
    if (now - nudgeAt < 500) return;
    nudgeAt = now;
    dom.composer.classList.remove("is-nudging", "is-error");
    void dom.composer.offsetWidth;
    dom.composer.classList.add("is-nudging", "is-error");
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => {
      dom.composer.classList.remove("is-nudging", "is-error");
    }, 1400);
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

  let morphTimer = 0;
  /* paste while the field is empty, download once it holds a link: one control
     that changes job instead of two that compete */
  function updatePasteButton(armed) {
    const button = dom.pasteBtn;
    if (!button) return;
    const state = armed ? "get" : "paste";
    if (button.dataset.state === state) return;
    button.dataset.state = state;
    button.setAttribute("aria-label", armed ? "download" : "paste from clipboard");
    button.title = armed ? "download" : "paste";
    const label = button.querySelector(".pb-label");
    if (!label) return;
    label.classList.add("is-out");
    clearTimeout(morphTimer);
    morphTimer = setTimeout(() => {
      label.textContent = armed ? "download" : "paste";
      label.classList.remove("is-out");
    }, 110);
  }

  let modePicked = false;   /* they chose a mode themselves: stop guessing */
  let autoAudio = false;    /* the current mode came from a music link */

  function updateComposerState() {
    const text = dom.input.value;
    scheduleProbe();
    dom.clearBtn.hidden = text.length === 0;
    autosize();

    const urls = parseUrls(text);
    const first = urls[0] || "";
    const detected = first ? detectService(first) : null;
    const service = detected && detected.id ? detected.id : null;
    /* the mode row shows what will actually happen: paste a song and audio is
       lit, paste a video and it goes back to auto. a press of their own wins
       for the rest of the session. */
    if (!modePicked) {
      if (service && MUSIC_FIRST.has(service) && settings.downloadMode === "auto") {
        settings.downloadMode = "audio";
        autoAudio = true;
        saveSettings();
        renderModes();
      } else if (autoAudio && (!service || !MUSIC_FIRST.has(service))) {
        settings.downloadMode = "auto";
        autoAudio = false;
        saveSettings();
        renderModes();
      }
    }
    updateFormatNote();

    /* one control: paste while the field is empty, download once it holds a
       link. It is always there, so nothing moves when a link lands. */
    const armed = urls.length >= 1;
    updatePasteButton(armed);
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
    if (service) {
      dom.badge.setAttribute("aria-label", "detected: " + service);
      dom.badge.title = service;
    } else {
      dom.badge.removeAttribute("aria-label");
      dom.badge.removeAttribute("title");
    }
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
    if (mode === "mute" || settings.muteVideo) return container + " · " + qualityLabel() + " · no sound";
    return container + " · " + qualityLabel();
  }

  /* nothing until a link says what it is */
  function updateFormatNote() {
    if (!dom.formatNote) return;
    const urls = parseUrls(dom.input.value);
    const detected = urls.length ? detectService(urls[0]) : null;
    const service = detected && detected.id ? detected.id : "";
    dom.formatNote.textContent = urls.length
      ? (service ? service + " · " : "") + modeSummary(effectiveMode(urls[0], settings.downloadMode))
      : "";
  }

  /* one pill that slides between auto / audio / video, rather than a
     background switching on and off under the words */
  function positionModeGlider() {
    const group = $("#modes");
    if (!group) return;
    const active = group.querySelector('.mode[aria-checked="true"]');
    if (!active) return;
    /* the first placement must not animate: the pill is already where the
       selection is, and a slide on page load would read as a glitch */
    if (!group.dataset.glide) {
      group.dataset.glide = "1";
      group.classList.add("no-glide");
      requestAnimationFrame(() => group.classList.remove("no-glide"));
    }
    group.style.setProperty("--mx", active.offsetLeft + "px");
    group.style.setProperty("--mw", active.offsetWidth + "px");
    group.classList.add("has-glider");
  }

  function renderModes() {
    dom.modes.forEach((btn) => {
      const mode = btn.dataset.mode;
      const on = mode === settings.downloadMode;
      btn.setAttribute("aria-checked", on ? "true" : "false");
      
    });
    positionModeGlider();
    updateFormatNote();
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
    if (!raw || raw.length > 2048) return false;
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
    /* A deep link is a convenience, not an instruction: inside someone else's
       frame it only fills the field. Otherwise any page could start a download
       on a visitor's connection without a click. */
    if (window.top !== window.self) return true;

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

  const recentSubmits = new Map();
  /* links being resolved right now: measuring a big file can take seconds, and
     a second tap during that window used to start the same download twice */
  const pendingSubmits = new Set();

  function admitSubmit(url) {
    const now = Date.now();
    for (const [key, at] of recentSubmits) {
      if (now - at > 4000) recentSubmits.delete(key);
    }
    const last = recentSubmits.get(url) || 0;
    if (now - last < 1500) return false;
    recentSubmits.set(url, now);
    return true;
  }

  const XL_BYTES = 250 * 1024 * 1024;

  /* A 1.5 GB download on a phone plan should be a decision, not a surprise.
     The estimate comes from the probe the preview already runs. */
  function confirmLarge(entries) {
    return new Promise((resolve) => {
      const total = entries.reduce((sum, e) => sum + (e.bytes || 0), 0);
      const wrap = el("div", { class: "confirm" });
      wrap.appendChild(el("p", {
        class: "confirm-lede",
        text: entries.length === 1 ? "This one is big." : "These are big."
      }));
      const list = el("ul", { class: "confirm-list" });
      entries.forEach((entry) => {
        list.appendChild(el("li", {
          text: (entry.title ? entry.title.slice(0, 54) + " · " : "") + "≈ " + formatBytes(entry.bytes)
        }));
      });
      wrap.appendChild(list);
      wrap.appendChild(el("p", {
        class: "confirm-note",
        text: "It will use ≈ " + formatBytes(total) + " of data and take longer on a slow connection. Cancel and pick a lower quality if that is not what you want."
      }));

      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        closeModal();
        resolve(value);
      };
      const cancel = el("button", { type: "button", class: "ghost-btn", text: "cancel" });
      const go = el("button", { type: "button", class: "primary-btn", text: "download ≈ " + formatBytes(total) });
      cancel.addEventListener("click", () => finish(false));
      go.addEventListener("click", () => finish(true));
      dom.modal.querySelectorAll("[data-close-modal]").forEach((node) => {
        node.addEventListener("click", () => finish(false), { once: true });
      });
      dom.modal.addEventListener("click", (event) => {
        if (event.target === dom.modal) finish(false);
      }, { once: true });

      openModal("That's a big file", wrap, [cancel, go]);
      setTimeout(() => go.focus({ preventScroll: true }), 60);
    });
  }

  async function submitUrls(text, mode) {
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
    const living = (url) => queue.some((item) =>
      item.url === url && (item.status === "queued" || item.status === "working" || item.status === "downloading"));
    const fresh = usable.filter((url) => {
      if (pendingSubmits.has(url)) return false;
      if (living(url)) return false;
      return admitSubmit(url);
    });
    if (!fresh.length) {
      /* a second tap, or the same link hammered: leave what they typed where
         it is, keep the keyboard down, and say it once */
      const starting = usable.some((url) => pendingSubmits.has(url));
      toast(starting ? "Already starting. One second." : "Already queued. Wait for it to finish.", "warn");
      nudgeComposer();
      return;
    }

    const batch = fresh.slice(0, MAX_URLS_PER_SUBMIT);
    fresh.forEach((url) => pendingSubmits.add(url));
    setSubmitting(true);
    try {
      /* measure before queueing, but only when the number is actually known */
      const big = [];
      batch.forEach((url) => {
        const known = readProbe(probeKey(url, mode));
        if (known && known.estimate && known.estimate.bytes >= XL_BYTES) {
          big.push({ url, bytes: known.estimate.bytes, title: known.title });
        }
      });
      if (!big.length && batch.length === 1 && probeSupported()) {
        const data = await fetchProbe(batch[0], mode).catch(() => null);
        if (data && data.estimate && data.estimate.bytes >= XL_BYTES) {
          big.push({ url: batch[0], bytes: data.estimate.bytes, title: data.title });
        }
      }
      if (big.length) {
        const proceed = await confirmLarge(big);
        if (!proceed) return;   /* the field keeps what they pasted */
      }

      batch.forEach((url) => {
        enqueue(url, mode);
        addHistory(url);
      });
      if (fresh.length > batch.length) toast("Only the first " + batch.length + " links were queued.", "warn");

      dom.input.value = "";
      updateComposerState();
      if (IS_TOUCH) { try { dom.input.blur(); } catch (e) {} }
      renderQueue();
      /* no scrollIntoView: on the main page that dragged the whole layout up
         under the user. The queue panel has its own scroll. */
      pump();
    } finally {
      fresh.forEach((url) => pendingSubmits.delete(url));
      setSubmitting(false);
    }
  }

  /* the button answers the click before the network does: the arrow turns
     into a spinner until the link is resolved and queued */
  function setSubmitting(on) {
    if (!dom.pasteBtn) return;
    dom.pasteBtn.dataset.busy = on ? "true" : "false";
    dom.pasteBtn.setAttribute("aria-busy", on ? "true" : "false");
    dom.pasteBtn.setAttribute("aria-disabled", on ? "true" : "false");
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
    dom.requestPreview.textContent = JSON.stringify(buildBody(sample, effectiveMode(sample, settings.downloadMode)), null, 2);
  }

  /* ----------------------------------------------------------
     queue: model
     ---------------------------------------------------------- */
  /* What the API is actually asked for. auto means "read the link": a music
     service gets audio, everything else gets video. The no-sound switch only
     ever applies to video, because muting an audio download is nonsense. */
  function effectiveMode(url, mode) {
    const wanted = mode || settings.downloadMode;
    if (wanted === "audio") return "audio";
    if (wanted === "mute") return "mute";
    const detected = detectService(url);
    const music = detected && MUSIC_FIRST.has(detected.id);
    if (wanted === "auto" && music) return "audio";
    return settings.muteVideo ? "mute" : "auto";
  }

  function enqueue(url, mode) {
    const detected = detectService(url);
    const resolved = effectiveMode(url, mode);
    const item = {
      id: "q" + ++idCounter,
      url,
      direct: false,
      directUrl: "",
      service: detected && detected.id ? detected.id : (detected ? detected.host : "link"),
      host: detected ? detected.host : hostOf(url),
      mode: resolved,
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
    youtube: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>',
    soundcloud: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23.999 14.165c-.052 1.796-1.612 3.169-3.4 3.169h-8.18a.68.68 0 0 1-.675-.683V7.862a.747.747 0 0 1 .452-.724s.75-.513 2.333-.513a5.364 5.364 0 0 1 2.763.755 5.433 5.433 0 0 1 2.57 3.54c.282-.08.574-.121.868-.12.884 0 1.73.358 2.347.992s.948 1.49.922 2.373ZM10.721 8.421c.247 2.98.427 5.697 0 8.672a.264.264 0 0 1-.53 0c-.395-2.946-.22-5.718 0-8.672a.264.264 0 0 1 .53 0ZM9.072 9.448c.285 2.659.37 4.986-.006 7.655a.277.277 0 0 1-.55 0c-.331-2.63-.256-5.02 0-7.655a.277.277 0 0 1 .556 0Zm-1.663-.257c.27 2.726.39 5.171 0 7.904a.266.266 0 0 1-.532 0c-.38-2.69-.257-5.21 0-7.904a.266.266 0 0 1 .532 0Zm-1.647.77a26.108 26.108 0 0 1-.008 7.147.272.272 0 0 1-.542 0 27.955 27.955 0 0 1 0-7.147.275.275 0 0 1 .55 0Zm-1.67 1.769c.421 1.865.228 3.5-.029 5.388a.257.257 0 0 1-.514 0c-.21-1.858-.398-3.549 0-5.389a.272.272 0 0 1 .543 0Zm-1.655-.273c.388 1.897.26 3.508-.01 5.412-.026.28-.514.283-.54 0-.244-1.878-.347-3.54-.01-5.412a.283.283 0 0 1 .56 0Zm-1.668.911c.4 1.268.257 2.292-.026 3.572a.257.257 0 0 1-.514 0c-.241-1.262-.354-2.312-.023-3.572a.283.283 0 0 1 .563 0Z"/></svg>',
    bandcamp: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M0 18.75l7.437-13.5H24l-7.438 13.5H0z"/></svg>',
    mixcloud: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2.462 8.596l1.372 6.49h.319l1.372-6.49h2.462v6.808H6.742v-5.68l.232-.81h-.402l-1.43 6.49H2.854l-1.44-6.49h-.391l.222.81v5.68H0V8.596zM24 8.63v1.429L21.257 12 24 13.941v1.43l-3.235-2.329h-.348l-3.226 2.329v-1.43l2.734-1.94-2.733-1.942V8.63l3.225 2.338h.348zm-7.869 2.75v1.24H9.304v-1.24z"/></svg>',
    audiomack: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M.331 11.378s.5418-.089.765.1439c.2234.2332.077.7156-.2195.7237-.2965.01-.5705.063-.765-.1439-.1946-.2066-.1424-.6218.2195-.7237m5.881 3.2925c-.0522.01-.1075-.018-.164-.059-.3884-.5413-.5287-2.3923-.707-2.5025-.185-.1144-.8545 1.0255-2.1862.903-.5569-.051-1.1236-.4121-1.4573-.662.031-.4206.0364-1.4027.8659-1.0833.5038.1939 1.3667.7266 2.1245-.23.8378-1.0579 1.2999-.7506 1.577-.5206.2771.23.0925 1.4259.5058 1.0916.4133-.3343 2.082-2.4103 2.082-2.4103s1.292-1.303 1.4898.067c.1979 1.3698 1.0403 2.8877 1.2635 2.8445.2234-.043 2.8223-5.3253 3.1945-5.666.3722-.3409 1.6252-.2961 1.5657.5781-.0596.8742-.1871 6.308-.1871 6.308s-.147 1.5311.0924.7128c.0992-.3392.206-.6453.3392-1.0024.6414-2.0534 1.734-5.5613 2.2784-7.3688.1252-.4325.233-.8037.3166-1.0891l.0001-.0008a3.5925 3.5925 0 0 1 .0973-.3305c.0455-.1532.0763-.2546.0858-.2813.0243-.068.0925-.1192.1884-.157.0962-.061.1995-.064.3165-.067.3021-.027.6907.012 1.0401.1119.1018 0 .2125.037.3172.1118v.0001s.0063 0 .0151.01c.0023 0 .0048 0 .0073.01.0219.015.0573.045.0983.095.0012 0 .0025 0 .004.01.017.021.0341.045.0515.073.1952.2863.315.814.1948 1.7498-.2996 2.3354-.5316 7.1397-.5316 7.1397s-.0461.2298.4353-.782c.0167-.035.0383-.066.058-.098.026-.017.0552-.042.0913-.085.2974-.3546 1.0968-.5629 1.6512-.5586.2336.028.4293.087.5462.1609.2188.333.0897 1.562.0897 1.562-.4612.043-1.3403.2908-1.6519.3366-.3118.046-.7852 2.0699-1.4433 1.8629-.6581-.2069-2.1246-1.1268-2.1246-1.2533 0-.1102.1152-1.4546.1453-1.8016.0022-.024.004-.046.0058-.068a.152.152 0 0 1 .0014-.014l-.0002.0003c.0213-.2733.0023-.3927-.1239-.1199-.1086.2346-.581 1.7359-1.1078 3.3709-.0556.1429-1.0511 3.1558-1.1818 3.5231-.156.4261-.287.7523-.3776.921-.1378.1867-.3234.3036-.5826.2252-.6465-.1954-1.4654-1.0889-1.473-1.3106-.0155-1.2503.0608-7.973-.2423-7.4127-.311.5744-2.73 4.5608-2.73 4.5608-.0405.01-.0705.01-.1062.01-.1712-.019-.4366-.074-.51-.2384-.004-.01-.0094-.018-.0129-.028-.0035-.01-.0075-.022-.0135-.04-.0329-.1097-.0463-.2289-.0753-.3265-.1082-.3652-.2813-.8886-.463-1.421-.2784-.9079-.5654-1.8366-.6127-1.9391-.0923-.2007-.2268-.116-.3475-.0002-.54.458-1.6868 2.4793-2.7225 2.5898"/></svg>',
    hearthis: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.485 3.515C15.799-1.17 8.2-1.17 3.515 3.515c-4.687 4.686-4.687 12.285 0 16.97 4.685 4.686 12.284 4.686 16.97 0 4.687-4.685 4.687-12.284 0-16.97zm-5.81 14.433c-.252.252-1.25.562-1.25-.012 0-.573-.157-3.089-2.028-4.958-1.88-1.88-4.55-2.192-5.056-2.192-.506 0-.331-1-.078-1.252.253-.253.558-.15 1.064-.15 0 0 3.445.464 5.326 2.345 1.868 1.869 2.173 5.153 2.173 5.153 0 .463.102.813-.15 1.066zm4.022-.509c-.36.36-1.786.803-1.786-.015 0-.82-.224-4.41-2.893-7.079C11.335 7.662 7.524 7.217 6.8 7.217c-.723 0-.473-1.426-.113-1.787.361-.36.799-.214 1.52-.214 0 0 4.918.663 7.603 3.348 2.666 2.667 3.1 7.356 3.1 7.356 0 .658.147 1.158-.214 1.52z"/></svg>',
    bilibili: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L9.653 4.44c.071.071.134.142.187.213h4.267a.836.836 0 0 1 .16-.213l2.853-2.747c.267-.249.573-.373.92-.373.347 0 .662.151.929.4.267.249.391.551.391.907 0 .355-.124.657-.373.906zM5.333 7.24c-.746.018-1.373.276-1.88.773-.506.498-.769 1.13-.786 1.894v7.52c.017.764.28 1.395.786 1.893.507.498 1.134.756 1.88.773h13.334c.746-.017 1.373-.275 1.88-.773.506-.498.769-1.129.786-1.893v-7.52c-.017-.765-.28-1.396-.786-1.894-.507-.497-1.134-.755-1.88-.773zM8 11.107c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c0-.373.129-.689.386-.947.258-.257.574-.386.947-.386zm8 0c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c.017-.391.15-.711.4-.96.249-.249.56-.373.933-.373Z"/></svg>',
    vimeo: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23.9765 6.4168c-.105 2.338-1.739 5.5429-4.894 9.6088-3.2679 4.247-6.0258 6.3699-8.2898 6.3699-1.409 0-2.578-1.294-3.553-3.881l-1.9179-7.1138c-.719-2.584-1.488-3.878-2.312-3.878-.179 0-.806.378-1.8809 1.132l-1.129-1.457a315.06 315.06 0 003.501-3.1279c1.579-1.368 2.765-2.085 3.5539-2.159 1.867-.18 3.016 1.1 3.447 3.838.465 2.953.789 4.789.971 5.5069.5389 2.45 1.1309 3.674 1.7759 3.674.502 0 1.256-.796 2.265-2.385 1.004-1.589 1.54-2.797 1.612-3.628.144-1.371-.395-2.061-1.614-2.061-.574 0-1.167.121-1.777.391 1.186-3.8679 3.434-5.7568 6.7619-5.6368 2.4729.06 3.6279 1.664 3.4929 4.7969z"/></svg>',
    twitch: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/></svg>',
    dailymotion: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.823 7.327a11.928 11.928 0 0 0-2.606-3.814 12.126 12.126 0 0 0-3.866-2.57A12.246 12.246 0 0 0 10.617 0H1.831a.602.602 0 0 0-.609.603v3.764c0 .162.064.312.179.426l4.164 4.123a.612.612 0 0 0 .439.177h4.56c.806 0 1.56.313 2.125.88.557.559.856 1.296.843 2.075-.029 1.571-1.343 2.849-2.931 2.849h-6.74a.613.613 0 0 0-.432.176.619.619 0 0 0-.178.427v3.764c0 .162.063.312.178.427l4.139 4.099a.647.647 0 0 0 .476.21h2.572a12.276 12.276 0 0 0 4.733-.945 12.145 12.145 0 0 0 3.866-2.571 11.959 11.959 0 0 0 2.607-3.813c.633-1.479.956-3.051.956-4.67 0-1.619-.321-3.19-.956-4.669l.001-.005ZM2.441 4.118V1.982l2.945 2.755.001 2.297-2.946-2.916Zm4.975 17.813-2.945-2.917v-2.137l2.945 2.755v2.299Zm-2.004-5.832h5.19c2.248 0 4.107-1.807 4.147-4.03a4.027 4.027 0 0 0-1.192-2.937 4.203 4.203 0 0 0-2.996-1.239H6.606V5.216h3.996c1.831 0 3.553.706 4.849 1.986a6.724 6.724 0 0 1-.152 9.736 6.875 6.875 0 0 1-4.697 1.84H8.275L5.412 16.1v-.001Zm15.289.1a10.753 10.753 0 0 1-2.345 3.431 10.91 10.91 0 0 1-3.48 2.314 11.018 11.018 0 0 1-4.26.847H8.633v-2.814h1.916c2.145 0 4.161-.802 5.675-2.254a7.88 7.88 0 0 0 2.451-5.728c0-2.177-.87-4.21-2.451-5.728-1.514-1.454-3.528-2.254-5.675-2.254h-4.16L3.383 1.202h7.234c1.479 0 2.911.285 4.259.847a10.957 10.957 0 0 1 3.48 2.313 10.769 10.769 0 0 1 2.345 3.432c.571 1.33.86 2.743.86 4.202 0 1.46-.289 2.873-.86 4.203Z"/></svg>',
    facebook: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z"/></svg>',
    pinterest: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.162-.105-.949-.199-2.403.041-3.439.219-.937 1.406-5.957 1.406-5.957s-.359-.72-.359-1.781c0-1.663.967-2.911 2.168-2.911 1.024 0 1.518.769 1.518 1.688 0 1.029-.653 2.567-.992 3.992-.285 1.193.6 2.165 1.775 2.165 2.128 0 3.768-2.245 3.768-5.487 0-2.861-2.063-4.869-5.008-4.869-3.41 0-5.409 2.562-5.409 5.199 0 1.033.394 2.143.889 2.741.099.12.112.225.085.345-.09.375-.293 1.199-.334 1.363-.053.225-.172.271-.401.165-1.495-.69-2.433-2.878-2.433-4.646 0-3.776 2.748-7.252 7.92-7.252 4.158 0 7.392 2.967 7.392 6.923 0 4.135-2.607 7.462-6.233 7.462-1.214 0-2.354-.629-2.758-1.379l-.749 2.848c-.269 1.045-1.004 2.352-1.498 3.146 1.123.345 2.306.535 3.55.535 6.607 0 11.985-5.365 11.985-11.987C23.97 5.39 18.592.026 11.985.026L12.017 0z"/></svg>',
    tumblr: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14.563 24c-5.093 0-7.031-3.756-7.031-6.411V9.747H5.116V6.648c3.63-1.313 4.512-4.596 4.71-6.469C9.84.051 9.941 0 9.999 0h3.517v6.114h4.801v3.633h-4.82v7.47c.016 1.001.375 2.371 2.207 2.371h.09c.631-.02 1.486-.205 1.936-.419l1.156 3.425c-.436.636-2.4 1.374-4.156 1.404h-.178l.011.002z"/></svg>',
    vk: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m9.489.004.729-.003h3.564l.73.003.914.01.433.007.418.011.403.014.388.016.374.021.36.025.345.03.333.033c1.74.196 2.933.616 3.833 1.516.9.9 1.32 2.092 1.516 3.833l.034.333.029.346.025.36.02.373.025.588.012.41.013.644.009.915.004.98-.001 3.313-.003.73-.01.914-.007.433-.011.418-.014.403-.016.388-.021.374-.025.36-.03.345-.033.333c-.196 1.74-.616 2.933-1.516 3.833-.9.9-2.092 1.32-3.833 1.516l-.333.034-.346.029-.36.025-.373.02-.588.025-.41.012-.644.013-.915.009-.98.004-3.313-.001-.73-.003-.914-.01-.433-.007-.418-.011-.403-.014-.388-.016-.374-.021-.36-.025-.345-.03-.333-.033c-1.74-.196-2.933-.616-3.833-1.516-.9-.9-1.32-2.092-1.516-3.833l-.034-.333-.029-.346-.025-.36-.02-.373-.025-.588-.012-.41-.013-.644-.009-.915-.004-.98.001-3.313.003-.73.01-.914.007-.433.011-.418.014-.403.016-.388.021-.374.025-.36.03-.345.033-.333c.196-1.74.616-2.933 1.516-3.833.9-.9 2.092-1.32 3.833-1.516l.333-.034.346-.029.36-.025.373-.02.588-.025.41-.012.644-.013.915-.009ZM6.79 7.3H4.05c.13 6.24 3.25 9.99 8.72 9.99h.31v-3.57c2.01.2 3.53 1.67 4.14 3.57h2.84c-.78-2.84-2.83-4.41-4.11-5.01 1.28-.74 3.08-2.54 3.51-4.98h-2.58c-.56 1.98-2.22 3.78-3.8 3.95V7.3H10.5v6.92c-1.6-.4-3.62-2.34-3.71-6.92Z"/></svg>',
    ok: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0a6.2 6.2 0 0 0-6.194 6.195 6.2 6.2 0 0 0 6.195 6.192 6.2 6.2 0 0 0 6.193-6.192A6.2 6.2 0 0 0 12.001 0zm0 3.63a2.567 2.567 0 0 1 2.565 2.565 2.568 2.568 0 0 1-2.564 2.564 2.568 2.568 0 0 1-2.565-2.564 2.567 2.567 0 0 1 2.565-2.564zM6.807 12.6a1.814 1.814 0 0 0-.91 3.35 11.611 11.611 0 0 0 3.597 1.49l-3.462 3.463a1.815 1.815 0 0 0 2.567 2.566L12 20.066l3.405 3.403a1.813 1.813 0 0 0 2.564 0c.71-.709.71-1.858 0-2.566l-3.462-3.462a11.593 11.593 0 0 0 3.596-1.49 1.814 1.814 0 1 0-1.932-3.073 7.867 7.867 0 0 1-8.34 0c-.318-.2-.674-.29-1.024-.278z"/></svg>',
    rutube: _mark('<rect x="3.5" y="6.5" width="17" height="11" rx="3"/><path d="M9.6 10.4v3.2l3-1.6z" fill="currentColor" stroke="none"/><path d="M14.6 10.1v3.8"/>'),  /* line fallback: no official mark in Simple Icons */
    rumble: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14.4528 13.5458c.8064-.6542.9297-1.8381.2756-2.6445a1.8802 1.8802 0 0 0-.2756-.2756 21.2127 21.2127 0 0 0-4.3121-2.776c-1.066-.51-2.256.2-2.4261 1.414a23.5226 23.5226 0 0 0-.14 5.5021c.116 1.23 1.292 1.964 2.372 1.492a19.6285 19.6285 0 0 0 4.5062-2.704v-.008zm6.9322-5.4002c2.0335 2.228 2.0396 5.637.014 7.8723A26.1487 26.1487 0 0 1 8.2946 23.846c-2.6848.6713-5.4168-.914-6.1662-3.5781-1.524-5.2002-1.3-11.0803.17-16.3045.772-2.744 3.3521-4.4661 6.0102-3.832 4.9242 1.174 9.5443 4.196 13.0764 8.0121v.002z"/></svg>',
    odysee: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.965 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12 12 12 0 0 0-3.209-8.167 7.272 7.272 0 0 1-.799 3.218c-.548.957-2.281 2.77-3.264 3.699a.723.723 0 0 0 .056 1.104c.996.74 2.658 2.151 2.788 3.422.176 1.835 1.6 4.02 1.675 4.159a.67.67 0 0 1-.105.327 12.067 12.067 0 0 1-2.03 1.898 2.435 2.435 0 0 1-.807.126c-1.944-.04-1.526-1.866-1.712-2.905s-.78-3.085-2.716-2.788c0 0 .484 4.243-1.489 5.546s-5.843 2.27-6.55-.408 2.46-2.384 2.684-2.384c.223 0 2.233-.632 1.267-2.53-.967-1.898-2.01-3.5-2.01-3.5a11.37 11.37 0 0 0-2.735 1.285 5.42 5.42 0 0 0-1.061.82c-1.065 1.104-2.19 1.713-2.954 1.358a1.368 1.368 0 0 1-.32-.221A11.926 11.926 0 0 1 .1 13.503c.43-.641 2.082-2.038 3.696-2.906 1.304-.702 2.737-.988 3.118-1.355-.671-2.235-1.882-5.703.832-7.33C9.881.634 12.69-.142 13.77 2.958c1.08 3.1.802 3.796 1.267 3.796.465 0 1.608.223 2.09-1.75.356-1.445.574-2.685 1.379-3.087A12 12 0 0 0 12 0a12 12 0 0 0-.035 0zm-.498 2.125c-.353-.019-.78.05-1.303.224 0 0-1.895.52-1.749 2.53.13 1.777 1.08 2.753 3.053 2.01 1.972-.737 2.31-1.264 1.824-2.753-.364-1.117-.765-1.956-1.825-2.011zm.48.726a.249.249 0 0 1 .183.07 1.58 1.58 0 0 1 .232.346.253.253 0 0 1-.197.37.253.253 0 0 1-.233-.131 1.559 1.559 0 0 0-.148-.232.256.256 0 0 1 0-.353.249.249 0 0 1 .163-.07zm3.529.152a.22.22 0 0 1 .192.103.22.22 0 0 1-.07.305.22.22 0 1 1-.122-.408zM12.609 4.27a.253.253 0 0 1 .227.133 1.5 1.5 0 0 1 .102.982.253.253 0 0 1-.246.205h-.049a.253.253 0 0 1-.2-.295 1.013 1.013 0 0 0-.071-.697.253.253 0 0 1 .237-.328zm-8.035.552a.12.12 0 0 1 .029.003.12.12 0 1 1-.147.091.12.12 0 0 1 .118-.094zm15.77 3.419.273.539.593.12-.539.275-.123.592-.272-.539-.592-.123.538-.272zm-17.767.535a.22.22 0 0 1 .193.104.22.22 0 0 1-.07.304.22.22 0 1 1-.123-.408zm16.004 2.79a.258.258 0 0 1 .062.007.258.258 0 1 1-.31.195.258.258 0 0 1 .248-.202zM4.914 16.115a.17.17 0 0 1 .165.14.17.17 0 0 1-.137.197.17.17 0 1 1-.028-.337zm9.769 4.094a.2.2 0 0 1 .036.004.2.2 0 1 1-.233.15.2.2 0 0 1 .197-.154z"/></svg>',
    kick: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M1.333 0h8v5.333H12V2.667h2.667V0h8v8H20v2.667h-2.667v2.666H20V16h2.667v8h-8v-2.667H12v-2.666H9.333V24h-8Z"/></svg>',
    snapchat: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.206.793c.99 0 4.347.276 5.93 3.821.529 1.193.403 3.219.299 4.847l-.003.06c-.012.18-.022.345-.03.51.075.045.203.09.401.09.3-.016.659-.12 1.033-.301.165-.088.344-.104.464-.104.182 0 .359.029.509.09.45.149.734.479.734.838.015.449-.39.839-1.213 1.168-.089.029-.209.075-.344.119-.45.135-1.139.36-1.333.81-.09.224-.061.524.12.868l.015.015c.06.136 1.526 3.475 4.791 4.014.255.044.435.27.42.509 0 .075-.015.149-.045.225-.24.569-1.273.988-3.146 1.271-.059.091-.12.375-.164.57-.029.179-.074.36-.134.553-.076.271-.27.405-.555.405h-.03c-.135 0-.313-.031-.538-.074-.36-.075-.765-.135-1.273-.135-.3 0-.599.015-.913.074-.6.104-1.123.464-1.723.884-.853.599-1.826 1.288-3.294 1.288-.06 0-.119-.015-.18-.015h-.149c-1.468 0-2.427-.675-3.279-1.288-.599-.42-1.107-.779-1.707-.884-.314-.045-.629-.074-.928-.074-.54 0-.958.089-1.272.149-.211.043-.391.074-.54.074-.374 0-.523-.224-.583-.42-.061-.192-.09-.389-.135-.567-.046-.181-.105-.494-.166-.57-1.918-.222-2.95-.642-3.189-1.226-.031-.063-.052-.15-.055-.225-.015-.243.165-.465.42-.509 3.264-.54 4.73-3.879 4.791-4.02l.016-.029c.18-.345.224-.645.119-.869-.195-.434-.884-.658-1.332-.809-.121-.029-.24-.074-.346-.119-1.107-.435-1.257-.93-1.197-1.273.09-.479.674-.793 1.168-.793.146 0 .27.029.383.074.42.194.789.3 1.104.3.234 0 .384-.06.465-.105l-.046-.569c-.098-1.626-.225-3.651.307-4.837C7.392 1.077 10.739.807 11.727.807l.419-.015h.06z"/></svg>',
    threads: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.964-.065-1.19.408-2.285 1.33-3.082.88-.76 2.119-1.207 3.583-1.291a13.853 13.853 0 0 1 3.02.142c-.126-.742-.375-1.332-.75-1.757-.513-.586-1.308-.883-2.359-.89h-.029c-.844 0-1.992.232-2.721 1.32L7.734 7.847c.98-1.454 2.568-2.256 4.478-2.256h.044c3.194.02 5.097 1.975 5.287 5.388.108.046.216.094.321.142 1.49.7 2.58 1.761 3.154 3.07.797 1.82.871 4.79-1.548 7.158-1.85 1.81-4.094 2.628-7.277 2.65Zm1.003-11.69c-.242 0-.487.007-.739.021-1.836.103-2.98.946-2.916 2.143.067 1.256 1.452 1.839 2.784 1.767 1.224-.065 2.818-.543 3.086-3.71a10.5 10.5 0 0 0-2.215-.221z"/></svg>',
    bluesky: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5.202 2.857C7.954 4.922 10.913 9.11 12 11.358c1.087-2.247 4.046-6.436 6.798-8.501C20.783 1.366 24 .213 24 3.883c0 .732-.42 6.156-.667 7.037-.856 3.061-3.978 3.842-6.755 3.37 4.854.826 6.089 3.562 3.422 6.299-5.065 5.196-7.28-1.304-7.847-2.97-.104-.305-.152-.448-.153-.327 0-.121-.05.022-.153.327-.568 1.666-2.782 8.166-7.847 2.97-2.667-2.737-1.432-5.473 3.422-6.3-2.777.473-5.899-.308-6.755-3.369C.42 10.04 0 4.615 0 3.883c0-3.67 3.217-2.517 5.202-1.026"/></svg>',
    streamable: _mark('<rect x="3.5" y="6.5" width="17" height="11" rx="3"/><path d="M9.8 9.8v4.4l3.9-2.2z" fill="currentColor" stroke="none"/><path d="M15.6 10.3h1.8M15.6 13.7h1.8"/>'),  /* line fallback: no official mark in Simple Icons */
    loom: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M24 10.665h-7.018l6.078-3.509-1.335-2.312-6.078 3.509 3.508-6.077L16.843.94l-3.508 6.077V0h-2.67v7.018L7.156.94 4.844 2.275l3.509 6.077-6.078-3.508L.94 7.156l6.078 3.509H0v2.67h7.017L.94 16.844l1.335 2.313 6.077-3.508-3.509 6.077 2.312 1.335 3.509-6.078V24h2.67v-7.017l3.508 6.077 2.312-1.335-3.509-6.078 6.078 3.509 1.335-2.313-6.077-3.508h7.017v-2.67H24zm-12 4.966a3.645 3.645 0 1 1 0-7.29 3.645 3.645 0 0 1 0 7.29z"/></svg>',
    coub: _mark('<path d="M6.2 9.6a6.4 6.4 0 0 1 11.3-1.7"/><path d="M17.9 4.4v3.6h-3.6"/><path d="M17.8 14.4A6.4 6.4 0 0 1 6.5 16.1"/><path d="M6.1 19.6V16h3.6"/>'),  /* line fallback: no official mark in Simple Icons */
    newgrounds: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M1.187 3.236C.397 3.966.002 4.876.002 5.97v15.584c-.02.243.101.364.365.364H3.07c.243 0 .365-.121.365-.364V6.03c0-.405.212-.608.638-.608H6.29c.405 0 .608.203.608.608v15.523c0 .243.142.364.425.364h2.643c.243 0 .374-.121.395-.364V5.97c-.02-1.093-.415-2.005-1.185-2.734A4.047 4.047 0 0 0 6.29 2.082H4.073c-1.134 0-2.096.385-2.886 1.154m20.9 18.105c.263-.162.506-.344.728-.547.79-.77 1.185-1.68 1.185-2.734v-5.62c-.02-.263-.152-.394-.395-.394h-4.374c-.263 0-.395.131-.395.394v2.522c0 .263.132.395.395.395h.941c.244 0 .365.141.365.425v2.278c0 .385-.192.577-.577.577h-2.248c-.425 0-.638-.192-.638-.577V6.03c0-.404.213-.607.638-.607h2.248c.385 0 .577.203.577.608V8.34c-.02.243.111.374.395.394h2.673c.243-.02.375-.151.395-.394V5.97c0-1.073-.395-1.984-1.185-2.734-.81-.77-1.762-1.154-2.855-1.154h-2.248c-1.114 0-2.066.385-2.855 1.154-.83.75-1.236 1.66-1.216 2.734v12.09c-.02 1.053.385 1.965 1.216 2.734.222.203.465.385.729.547.627.385 1.336.577 2.126.577h2.248c.79 0 1.498-.192 2.126-.577Z"/></svg>',
    "9gag": '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m17.279 21.008 5.193-2.995V5.992l-5.193-2.996C14.423 1.348 12.048 0 12 0c-.048 0-2.423 1.348-5.279 2.996L1.528 5.992v2.354l5.193 2.996c2.856 1.648 5.232 2.996 5.28 2.996.048 0 1.469-.797 3.157-1.772a229.633 229.633 0 0 1 3.097-1.772c.016 0 .027 1.096.027 2.437l-.002 2.436-3.076 1.772c-1.692.975-3.115 1.783-3.163 1.795-.048.013-1.471-.776-3.162-1.752-1.69-.976-3.113-1.775-3.161-1.775-.155 0-4.036 2.274-4.011 2.35.031.093 10.136 5.937 10.276 5.943.057.002 2.44-1.344 5.296-2.992ZM9.847 8.391c-1.118-.65-2.033-1.2-2.033-1.222 0-.071 4.06-2.376 4.186-2.376.125 0 4.186 2.305 4.186 2.376 0 .063-4.047 2.375-4.184 2.39-.068.007-1.037-.519-2.155-1.168Z"/></svg>',
    imgur: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.147 3.043c-.002-.113-.069-.182-.189-.191a14.117 14.117 0 00-.51-.045l-.162-.01a21.998 21.998 0 00-1.085-.046l-.217-.005c-.172-.003-.35-.004-.532-.004l-.189-.001c-.295 0-.601.003-.919.01l-.106.003a55.86 55.86 0 00-.87.026l-.237.009c-.335.013-.676.029-1.027.049l-.012.001c-.357.021-.724.045-1.095.071l-.275.021c-.304.023-.609.048-.92.076l-.25.021c-.38.035-.766.074-1.156.115-.08.009-.161.019-.242.027-.319.035-.641.073-.965.113l-.33.042c-.403.051-.806.105-1.212.164a.547.547 0 00-.154.045.303.303 0 00-.097.074l-.003.002c-.045.055-.047.12.004.179.003.004.002.008.005.012l3.488 3.456-6.629 6.596c-.069.067-.068.165 0 .251.856 1.093 1.44 1.793 2.143 2.492.699.703 1.398 1.286 2.493 2.143a.216.216 0 00.132.051.167.167 0 00.119-.051l6.597-6.629 3.455 3.488a.143.143 0 00.101.047c.096 0 .187-.118.212-.292.746-5.141.882-10.051.634-12.31z M15.87 24l6.356-6.357.026-.026.156-.155-.006-.006a3.144 3.144 0 00.822-1.711c.804-5.53.903-10.591.654-12.952a2.904 2.904 0 00-.834-1.812 2.96 2.96 0 00-1.816-.855C20.458.042 19.476 0 18.318 0c-2.999 0-6.667.284-10.063.777a3.143 3.143 0 00-1.887.991L0 8.137V24H15.87zm1.528-6.707c-.151 0-.563.405-.563.613a.1.1 0 01-.099.1.1.1 0 01-.099-.1c0-.208-.411-.613-.563-.613a.1.1 0 01-.099-.1c0-.054.044-.098.099-.098.152 0 .563-.404.563-.614 0-.055.044-.098.099-.098.054 0 .099.043.099.098 0 .21.412.614.563.614a.1.1 0 010 .198zM5.4 7.045c.197 0 .735-.528.735-.801a.13.13 0 01.128-.129c.071 0 .128.058.128.129 0 .272.538.801.735.801.071 0 .128.057.128.128a.128.128 0 01-.128.128c-.197 0-.735.528-.735.801a.128.128 0 01-.128.128.128.128 0 01-.128-.128c0-.273-.538-.801-.735-.801a.128.128 0 010-.256zm-3.99 3.26c0-.065.057-.098.119-.118.69-.228 1.269-.8 1.403-1.554.011-.064.053-.118.118-.118.066 0 .107.054.119.118.133.754.711 1.326 1.401 1.554.062.02.118.053.118.118s-.056.098-.118.119c-.69.227-1.269.799-1.403 1.553-.011.064-.053.119-.119.119-.065 0-.106-.054-.118-.119-.134-.754-.713-1.326-1.403-1.553-.061-.022-.117-.054-.117-.119zm1.565 9.307c-.113 0-.42.302-.42.459 0 .04-.034.073-.074.073a.074.074 0 01-.074-.073c0-.157-.307-.459-.42-.459a.074.074 0 01-.074-.073c0-.039.034-.073.074-.073.113 0 .42-.302.42-.457 0-.042.033-.073.074-.073.04 0 .074.031.074.073 0 .155.307.457.42.457.04 0 .073.034.073.073a.073.073 0 01-.073.073zm.568-3.047c-.14 0-.521.375-.521.568a.092.092 0 11-.183 0c0-.193-.381-.568-.521-.568a.09.09 0 01-.091-.09c0-.051.041-.092.091-.092.14 0 .521-.375.521-.568a.09.09 0 01.092-.09.09.09 0 01.091.09c0 .193.381.568.521.568a.091.091 0 010 .182zm3.334 4.382c-.203 0-.758.546-.758.827 0 .073-.06.133-.132.133a.133.133 0 01-.133-.133c0-.281-.555-.827-.758-.827a.134.134 0 01-.133-.133c0-.073.059-.132.133-.132.204 0 .758-.545.758-.828 0-.071.06-.132.133-.132.073 0 .132.061.132.132 0 .283.555.828.758.828.074 0 .133.059.133.132a.133.133 0 01-.133.133zm1.922-.806c-1.086-.851-1.869-1.498-2.653-2.287-.789-.784-1.436-1.566-2.287-2.654-.626-.8-.566-1.897.144-2.607l.001-.001.002-.001L9.364 7.26 7.149 5.066l-.003-.003-.002-.003c-.52-.52-.7-1.27-.472-1.958.148-.447.464-.802.867-1.049a1.983 1.983 0 01.371-.19 2.1 2.1 0 01.468-.131c.005 0 .009-.003.014-.004C11.746 1.24 15.363.96 18.317.96h.002c1.125 0 2.072.041 2.818.121.469.046.903.249 1.228.576.328.331.525.767.562 1.237.243 2.311.144 7.253-.651 12.714-.001.01-.006.016-.007.025a2.258 2.258 0 01-.18.586c-.006.014-.01.028-.018.042-.333.699-1.001 1.163-1.771 1.163-.51 0-.992-.2-1.358-.567l-.003-.002-.004-.004-2.192-2.215-5.333 5.359-.001.002h-.001a1.94 1.94 0 01-1.378.573c-.44 0-.877-.151-1.231-.429zm2.576 2.09c-.139 0-.518.373-.518.566a.09.09 0 01-.091.09.09.09 0 01-.09-.09c0-.193-.379-.566-.519-.566a.09.09 0 110-.18c.139 0 .519-.373.519-.566a.09.09 0 01.09-.09c.05 0 .091.041.091.09 0 .193.379.566.518.566.05 0 .091.039.091.09s-.04.09-.091.09zm2.115-2.437c.248 0 .922-.662.922-1.003 0-.088.072-.161.161-.161.088 0 .161.073.161.161 0 .341.674 1.003.921 1.003.089 0 .161.073.161.161a.16.16 0 01-.161.161c-.247 0-.921.662-.921 1.005a.162.162 0 01-.161.162.162.162 0 01-.161-.162c0-.343-.674-1.005-.922-1.005a.161.161 0 010-.322z"/></svg>',
    giphy: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2.666 0v24h18.668V8.666l-2.668 2.668v10H5.334V2.668H10L12.666 0zm10.668 0v8h8V5.334h-2.668V2.668H16V0"/></svg>',
    tenor: _mark('<rect x="3.5" y="5.5" width="17" height="13" rx="2.6"/><path d="M8.6 9.4h6.8M12 9.4v5.6"/>'),  /* line fallback: no official mark in Simple Icons */
    pixiv: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4.94 0A4.953 4.953 0 0 0 0 4.94v14.12A4.953 4.953 0 0 0 4.94 24h14.12A4.953 4.953 0 0 0 24 19.06c-.014 1.355 0-14.12 0-14.12A4.953 4.953 0 0 0 19.06 0Zm1.783 5.465h.904a.37.37 0 0 1 .31.17l.752 1.17a6.172 6.172 0 0 1 10.01 4.834 6.172 6.172 0 0 1-9.394 5.265v2.016a.37.37 0 0 1-.37.367H6.724a.37.37 0 0 1-.37-.367V5.834a.37.37 0 0 1 .37-.37m5.804 2.951a3.222 3.222 0 1 0-.002 6.443 3.222 3.222 0 0 0 .002-6.443"/></svg>',
    xiaohongshu: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22.405 9.879c.002.016.01.02.07.019h.725a.797.797 0 0 0 .78-.972.794.794 0 0 0-.884-.618.795.795 0 0 0-.692.794c0 .101-.002.666.001.777zm-11.509 4.808c-.203.001-1.353.004-1.685.003a2.528 2.528 0 0 1-.766-.126.025.025 0 0 0-.03.014L7.7 16.127a.025.025 0 0 0 .01.032c.111.06.336.124.495.124.66.01 1.32.002 1.981 0 .01 0 .02-.006.023-.015l.712-1.545a.025.025 0 0 0-.024-.036zM.477 9.91c-.071 0-.076.002-.076.01a.834.834 0 0 0-.01.08c-.027.397-.038.495-.234 3.06-.012.24-.034.389-.135.607-.026.057-.033.042.003.112.046.092.681 1.523.787 1.74.008.015.011.02.017.02.008 0 .033-.026.047-.044.147-.187.268-.391.371-.606.306-.635.44-1.325.486-1.706.014-.11.021-.22.03-.33l.204-2.616.022-.293c.003-.029 0-.033-.03-.034zm7.203 3.757a1.427 1.427 0 0 1-.135-.607c-.004-.084-.031-.39-.235-3.06a.443.443 0 0 0-.01-.082c-.004-.011-.052-.008-.076-.008h-1.48c-.03.001-.034.005-.03.034l.021.293c.076.982.153 1.964.233 2.946.05.4.186 1.085.487 1.706.103.215.223.419.37.606.015.018.037.051.048.049.02-.003.742-1.642.804-1.765.036-.07.03-.055.003-.112zm3.861-.913h-.872a.126.126 0 0 1-.116-.178l1.178-2.625a.025.025 0 0 0-.023-.035l-1.318-.003a.148.148 0 0 1-.135-.21l.876-1.954a.025.025 0 0 0-.023-.035h-1.56c-.01 0-.02.006-.024.015l-.926 2.068c-.085.169-.314.634-.399.938a.534.534 0 0 0-.02.191.46.46 0 0 0 .23.378.981.981 0 0 0 .46.119h.59c.041 0-.688 1.482-.834 1.972a.53.53 0 0 0-.023.172.465.465 0 0 0 .23.398c.15.092.342.12.475.12l1.66-.001c.01 0 .02-.006.023-.015l.575-1.28a.025.025 0 0 0-.024-.035zm-6.93-4.937H3.1a.032.032 0 0 0-.034.033c0 1.048-.01 2.795-.01 6.829 0 .288-.269.262-.28.262h-.74c-.04.001-.044.004-.04.047.001.037.465 1.064.555 1.263.01.02.03.033.051.033.157.003.767.009.938-.014.153-.02.3-.06.438-.132.3-.156.49-.419.595-.765.052-.172.075-.353.075-.533.002-2.33 0-4.66-.007-6.991a.032.032 0 0 0-.032-.032zm11.784 6.896c0-.014-.01-.021-.024-.022h-1.465c-.048-.001-.049-.002-.05-.049v-4.66c0-.072-.005-.07.07-.07h.863c.08 0 .075.004.075-.074V8.393c0-.082.006-.076-.08-.076h-3.5c-.064 0-.075-.006-.075.073v1.445c0 .083-.006.077.08.077h.854c.075 0 .07-.004.07.07v4.624c0 .095.008.084-.085.084-.37 0-1.11-.002-1.304 0-.048.001-.06.03-.06.03l-.697 1.519s-.014.025-.008.036c.006.01.013.008.058.008 1.748.003 3.495.002 5.243.002.03-.001.034-.006.035-.033v-1.539zm4.177-3.43c0 .013-.007.023-.02.024-.346.006-.692.004-1.037.004-.014-.002-.022-.01-.022-.024-.005-.434-.007-.869-.01-1.303 0-.072-.006-.071.07-.07l.733-.003c.041 0 .081.002.12.015.093.025.16.107.165.204.006.431.002 1.153.001 1.153zm2.67.244a1.953 1.953 0 0 0-.883-.222h-.18c-.04-.001-.04-.003-.042-.04V10.21c0-.132-.007-.263-.025-.394a1.823 1.823 0 0 0-.153-.53 1.533 1.533 0 0 0-.677-.71 2.167 2.167 0 0 0-1-.258c-.153-.003-.567 0-.72 0-.07 0-.068.004-.068-.065V7.76c0-.031-.01-.041-.046-.039H17.93s-.016 0-.023.007c-.006.006-.008.012-.008.023v.546c-.008.036-.057.015-.082.022h-.95c-.022.002-.028.008-.03.032v1.481c0 .09-.004.082.082.082h.913c.082 0 .072.128.072.128V11.19s.003.117-.06.117h-1.482c-.068 0-.06.082-.06.082v1.445s-.01.068.064.068h1.457c.082 0 .076-.006.076.079v3.225c0 .088-.007.081.082.081h1.43c.09 0 .082.007.082-.08v-3.27c0-.029.006-.035.033-.035l2.323-.003c.098 0 .191.02.28.061a.46.46 0 0 1 .274.407c.008.395.003.79.003 1.185 0 .259-.107.367-.33.367h-1.218c-.023.002-.029.008-.028.033.184.437.374.871.57 1.303a.045.045 0 0 0 .04.026c.17.005.34.002.51.003.15-.002.517.004.666-.01a2.03 2.03 0 0 0 .408-.075c.59-.18.975-.698.976-1.313v-1.981c0-.128-.01-.254-.034-.38 0 .078-.029-.641-.724-.998z"/></svg>',
    spotify: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>',
    deezer: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M.693 10.024c.381 0 .693-1.256.693-2.807 0-1.55-.312-2.807-.693-2.807C.312 4.41 0 5.666 0 7.217s.312 2.808.693 2.808ZM21.038 1.56c-.364 0-.684.805-.91 2.096C19.765 1.446 19.184 0 18.526 0c-.78 0-1.464 2.036-1.784 5-.312-2.158-.788-3.536-1.325-3.536-.745 0-1.386 2.704-1.62 6.472-.442-1.932-1.083-3.145-1.793-3.145s-1.35 1.213-1.793 3.145c-.242-3.76-.874-6.463-1.628-6.463-.537 0-1.013 1.378-1.325 3.535C6.938 2.036 6.262 0 5.474 0c-.658 0-1.247 1.447-1.602 3.665-.217-1.291-.546-2.105-.91-2.105-.675 0-1.221 2.807-1.221 6.272 0 3.466.546 6.273 1.221 6.273.277 0 .537-.476.736-1.273.32 2.928.996 4.938 1.776 4.938.606 0 1.143-1.204 1.507-3.11.251 3.622.875 6.195 1.602 6.195.46 0 .875-1.023 1.187-2.677C10.142 21.6 11 24 12.004 24c1.005 0 1.863-2.4 2.235-5.822.312 1.654.727 2.677 1.186 2.677.728 0 1.352-2.573 1.603-6.195.364 1.906.9 3.11 1.507 3.11.78 0 1.455-2.01 1.775-4.938.208.797.46 1.273.737 1.273.675 0 1.22-2.807 1.22-6.273-.008-3.457-.553-6.272-1.23-6.272ZM23.307 10.024c.381 0 .693-1.256.693-2.807 0-1.55-.312-2.807-.693-2.807-.381 0-.693 1.256-.693 2.807s.312 2.808.693 2.808Z"/></svg>',
    tidal: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.012 3.992L8.008 7.996 4.004 3.992 0 7.996 4.004 12l4.004-4.004L12.012 12l-4.004 4.004 4.004 4.004 4.004-4.004L12.012 12l4.004-4.004-4.004-4.004zM16.042 7.996l3.979-3.979L24 7.996l-3.979 3.979z"/></svg>',
    "apple-music": '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23.994 6.124a9.23 9.23 0 00-.24-2.19c-.317-1.31-1.062-2.31-2.18-3.043a5.022 5.022 0 00-1.877-.726 10.496 10.496 0 00-1.564-.15c-.04-.003-.083-.01-.124-.013H5.986c-.152.01-.303.017-.455.026-.747.043-1.49.123-2.193.4-1.336.53-2.3 1.452-2.865 2.78-.192.448-.292.925-.363 1.408-.056.392-.088.785-.1 1.18 0 .032-.007.062-.01.093v12.223c.01.14.017.283.027.424.05.815.154 1.624.497 2.373.65 1.42 1.738 2.353 3.234 2.801.42.127.856.187 1.293.228.555.053 1.11.06 1.667.06h11.03a12.5 12.5 0 001.57-.1c.822-.106 1.596-.35 2.295-.81a5.046 5.046 0 001.88-2.207c.186-.42.293-.87.37-1.324.113-.675.138-1.358.137-2.04-.002-3.8 0-7.595-.003-11.393zm-6.423 3.99v5.712c0 .417-.058.827-.244 1.206-.29.59-.76.962-1.388 1.14-.35.1-.706.157-1.07.173-.95.045-1.773-.6-1.943-1.536a1.88 1.88 0 011.038-2.022c.323-.16.67-.25 1.018-.324.378-.082.758-.153 1.134-.24.274-.063.457-.23.51-.516a.904.904 0 00.02-.193c0-1.815 0-3.63-.002-5.443a.725.725 0 00-.026-.185c-.04-.15-.15-.243-.304-.234-.16.01-.318.035-.475.066-.76.15-1.52.303-2.28.456l-2.325.47-1.374.278c-.016.003-.032.01-.048.013-.277.077-.377.203-.39.49-.002.042 0 .086 0 .13-.002 2.602 0 5.204-.003 7.805 0 .42-.047.836-.215 1.227-.278.64-.77 1.04-1.434 1.233-.35.1-.71.16-1.075.172-.96.036-1.755-.6-1.92-1.544-.14-.812.23-1.685 1.154-2.075.357-.15.73-.232 1.108-.31.287-.06.575-.116.86-.177.383-.083.583-.323.6-.714v-.15c0-2.96 0-5.922.002-8.882 0-.123.013-.25.042-.37.07-.285.273-.448.546-.518.255-.066.515-.112.774-.165.733-.15 1.466-.296 2.2-.444l2.27-.46c.67-.134 1.34-.27 2.01-.403.22-.043.442-.088.663-.106.31-.025.523.17.554.482.008.073.012.148.012.223.002 1.91.002 3.822 0 5.732z"/></svg>',
    twitter: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z"/></svg>',
    instagram: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077"/></svg>',
    tiktok: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>',
    douyin: _mark('<path d="M13.8 4.4v9.8a3.1 3.1 0 1 1-2.7-3.08"/><path d="M13.8 4.4c.5 2.1 1.7 3.4 3.9 3.7"/><path d="M6 19.6c3.4 1 8.6 1 12 0"/>'),  /* line fallback: no official mark in Simple Icons */
    reddit: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z"/></svg>',
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
      /* bytes, rate, eta and % live on the progress block, not here: one place
         for the numbers keeps the row from reading twice */
      if (item.duration) parts.push(clockTime(item.duration));
    } else if (item.error) {
      parts.push("• " + item.error);
    } else if (item.detail) {
      /* a finished row still owes you the one number you care about */
      if (item.size) parts.push(formatBytes(item.size));
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
    const track = el("div", { class: "q-progress-track" });
    const fill = el("div", { class: "q-progress-fill" });
    const percent = el("span", { class: "q-progress-pct" });
    const line = el("div", { class: "q-progress-line" });
    const bytes = el("span", { class: "q-bytes" });
    const rate = el("span", { class: "q-rate" });

    body.appendChild(title);
    body.appendChild(meta);
    track.appendChild(fill);
    progress.appendChild(track);
    progress.appendChild(percent);
    line.appendChild(bytes);
    line.appendChild(rate);
    progress.appendChild(line);
    node.appendChild(icon);
    node.appendChild(thumb);
    node.appendChild(body);
    node.appendChild(actions);
    node.appendChild(progress);

    node.classList.add("is-new");
    node.addEventListener("animationend", () => node.classList.remove("is-new"), { once: true });
    item.node = node;
    item.refs = { icon, thumb, title, meta, actions, fill, percent, bytes, rate };
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
      /* JSON.stringify keeps a quote inside the URL from ending the CSS string */
      thumb.style.backgroundImage = picture ? "url(" + JSON.stringify(picture) + ")" : "";
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

    const pctNode = item.refs.percent;
    const bytesNode = item.refs.bytes;
    const rateNode = item.refs.rate;
    const write = (node, text) => {
      if (node.textContent !== text) node.textContent = text;
    };
    if (item.status === "downloading") {
      if (item.size) {
        write(pctNode, Math.min(100, Math.floor(pct)) + "%");
        write(bytesNode, formatBytes(item.received) + " / " + formatBytes(item.size));
        const speed = item.speed ? formatBytes(item.speed) + "/s" : "";
        const left = item.speed && item.size > item.received
          ? etaText((item.size - item.received) / item.speed)
          : "";
        write(rateNode, [speed, left].filter(Boolean).join(" · "));
      } else {
        write(pctNode, "");
        write(bytesNode, formatBytes(item.received) || "receiving");
        write(rateNode, item.speed ? formatBytes(item.speed) + "/s" : "size unknown");
      }
    } else if (item.status === "working") {
      write(pctNode, "");
      write(bytesNode, item.detail || "requesting");
      write(rateNode, item.started ? Math.max(1, Math.round((Date.now() - item.started) / 1000)) + "s" : "");
    }
    if (dom.miniDock && !dom.miniDock.hidden && item === miniFocus) {
      const shown = item.size ? Math.min(100, Math.round((item.received / item.size) * 100)) : 0;
      if (dom.miniPct) dom.miniPct.textContent = item.size ? shown + "%" : "";
      dom.miniMeta.textContent = item.size
        ? formatBytes(item.received) + " / " + formatBytes(item.size)
        : (item.detail || "starting");
      if (dom.miniEta) {
        const finished = item.size && item.received >= item.size;
        dom.miniEta.textContent = item.speed && !finished
          ? (item.size > item.received ? etaText((item.size - item.received) / item.speed) : formatBytes(item.speed) + "/s")
          : "";
      }
      dom.miniFill.style.transform = "scaleX(" + (item.size ? shown / 100 : 0.12) + ")";
    }

    if (item._lastStatus !== item.status) {
      item._lastStatus = item.status;
      if (item.status === "ready" || item.status === "done") {
        node.classList.remove("is-done");
        void node.offsetWidth;         /* restart the animation */
        node.classList.add("is-done");
        setTimeout(() => node.classList.remove("is-done"), 520);
      }
    }

    const actionsKey = item.status + "|" + item.error + "|" + (item.blob ? "blob" : "noblob") + (item.sourceUrl ? "|src" : "");
    if (item.refs.actionsKey !== actionsKey) {
      item.refs.actionsKey = actionsKey;
      renderActions(item, actions);
    }
  }

  function renderActions(item, container) {
    const buttons = [];
    /* a labelled action: the one primary thing on a finished row */
    const labelBtn = (svg, text, aria, handler) => {
      const b = el("button", { type: "button", class: "q-save", title: aria, "aria-label": aria },
        svg + '<span>' + text + "</span>");
      b.addEventListener("click", handler);
      return b;
    };
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
    /* a failure is the one moment a person knows the service is broken, so the
       way to say so belongs here and not in a menu somewhere */
    const repeats = item.service
      ? queue.filter((n) => n.service === item.service && n.status === "error").length
      : 0;
    if (item.status === "error" && repeats >= 2 && instanceInfo && instanceInfo.inbox === true) {
      buttons.push(iconBtn(
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4"/><path d="M5 5h10l-1.2 3L15 11H5"/></svg>',
        "Report this service",
        () => openBrokenReport(item)
      ));
    }
    /* the file is done: saving is the one thing left, so it is a labelled
       button — and it sits last, where the eye finishes on the row */
    let saveAction = null;
    if ((item.status === "ready" || item.status === "done") && item.blob) {
      saveAction = labelBtn(
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 19h14"/></svg>',
        "save",
        "Save " + (item.filename || "file"),
        () => saveBlob(item)
      );
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

    if (saveAction) buttons.push(saveAction);

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
  let miniFocus = null;   /* the download the phone dock is pointing at */

  let dockTimer = null;

  function setDock(open) {
    if (!dom.queueDock || !dom.queuePanel) return;
    dockOpen = open;
    clearTimeout(dockTimer);
    if (open) {
      dom.queuePanel.hidden = false;
      dom.queuePanel.classList.remove("is-closing");
      bringToFront(dom.queuePanel);
      positionDockPanel();
    } else if (!dom.queuePanel.hidden) {
      dom.queuePanel.classList.add("is-closing");
      dockTimer = setTimeout(() => {
        dom.queuePanel.hidden = true;
        dom.queuePanel.classList.remove("is-closing");
      }, 120);
    }
    dom.queueToggle.setAttribute("aria-expanded", open ? "true" : "false");
    const barQueue = $("#mbar-queue");
    if (barQueue) barQueue.setAttribute("aria-expanded", open ? "true" : "false");
    dom.queueDock.classList.toggle("is-open", open);
    syncBarGlider();
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
    if (dom.mbarBadge && dom.queueBadge) {
      const count = dom.queueBadge.textContent || "";
      dom.mbarBadge.textContent = count;
      dom.mbarBadge.hidden = dom.queueBadge.hidden;
    }
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
    /* a new job opens the panel on a desktop, where it is a corner panel.
       On a phone it would cover the composer, so the mini bar tells the
       story and the full list is one tap away. */
    const wide = !window.matchMedia("(max-width: 720px)").matches;
    if (count > lastQueueCount && !dockOpen && wide) setDock(true);
    lastQueueCount = count;

    dom.queueCount.textContent = String(count);
    dom.queueCount.hidden = count === 0;
    dom.emptyState.hidden = count > 0;
    /* "ready" is finished too: with saving set to ask, a completed file waits on
       the row until you save it, and a bar that cannot clear it is a bar that
       cannot clear anything */
    dom.clearFinished.hidden = !queue.some((i) => FINISHED_STATUS.includes(i.status));

    const live = queue.find((i) => ["downloading", "working", "queued"].includes(i.status));
    const ready = queue.find((i) => i.status === "ready");
    const focus = live || ready;
    if (dom.miniDock) {
      const show = !!focus && !dockOpen;
      dom.miniDock.hidden = !show;
      if (show) {
        const pct = live && live.size ? Math.min(100, Math.round((live.received / live.size) * 100)) : 0;
        const title = focus.filename || focus.previewTitle || focus.host || "download";
        dom.miniTitle.textContent = title.length > 32 ? title.slice(0, 31) + "…" : title;
        dom.miniDock.dataset.state = live ? "live" : "ready";
        if (live) {
          dom.miniPct.textContent = live.size ? pct + "%" : "";
          dom.miniMeta.textContent = live.size ? formatBytes(live.received) + " / " + formatBytes(live.size) : (live.detail || "starting");
          const done = live.size && live.received >= live.size;
          const left = !done && live.speed && live.size > live.received ? etaText((live.size - live.received) / live.speed) : "";
          dom.miniEta.textContent = left || (!done && live.speed ? formatBytes(live.speed) + "/s" : "");
          dom.miniFill.style.transform = "scaleX(" + (live.size ? pct / 100 : 0.12) + ")";
          dom.miniDock.dataset.live = live.size ? "true" : "false";
        } else {
          dom.miniPct.textContent = "";
          dom.miniMeta.textContent = formatBytes(focus.size) + " · ready";
          dom.miniEta.textContent = "tap to save";
          dom.miniFill.style.transform = "scaleX(1)";
        }
      }
    }
    miniFocus = focus || null;

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
    if (item.node) {
      const node = item.node;
      node.classList.add("is-leaving");
      setTimeout(() => node.remove(), 170);
    }
    queue = queue.filter((q) => q !== item);
    updateQueueMeta();
  }

  const FINISHED_STATUS = ["done", "error", "cancelled", "ready"];

  function clearFinished() {
    queue.filter((q) => FINISHED_STATUS.includes(q.status)).forEach((item) => {
      if (item.blobUrl) URL.revokeObjectURL(item.blobUrl);
      if (item.node) item.node.remove();
    });
    queue = queue.filter((q) => !FINISHED_STATUS.includes(q.status));
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

  /* the URL comes from whichever instance is configured, so it is treated as
     hostile: only http(s) survives, because an href of javascript: runs in our
     origin when the next person clicks "open" */
  function resolveUrl(url) {
    if (!url) return "";
    try {
      const resolved = new URL(url, apiEndpoint() || window.location.href);
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return "";
      return resolved.href;
    } catch { return ""; }
  }

  /* thumbnails are the same story, and they land in a CSS url() */
  function safeImageUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (/^data:image\//i.test(raw)) return raw;
    try {
      const parsed = new URL(raw, apiEndpoint() || window.location.href);
      return (parsed.protocol === "http:" || parsed.protocol === "https:") ? parsed.href : "";
    } catch { return ""; }
  }

  /* a filename is a filename: no separators, no control characters, no dotfiles */
  function safeFilename(value, fallback) {
    const raw = String(value || "")
      .replace(/[\u0000-\u001f\u007f]+/g, "")
      .replace(/[\\/]+/g, "-")
      .trim()
      .slice(0, 120)
      .replace(/^\.+/, "");
    return raw || fallback;
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
          const filename = safeFilename(data.filename, guessFilename(item.url, item.mode));
          const source = resolveUrl(data.url);
          if (!source) {
            item.error = "The server sent a link this page will not open.";
            setStatus(item, "error");
            return;
          }
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
      return "The API didn't answer. Check the address in settings, then retry.";
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

    /* the API speaks in "video" for every media failure. on a track that is
       merely wrong: this is an audio job, and the reason is usually the rights
       or the region, not a missing video */
    if (code === "api.content.video.unavailable") {
      const audioWanted = item.mode === "audio" ||
        (item.service && MUSIC_FIRST.has(item.service));
      text = audioWanted
        ? "This track isn't available to the API. It may be private, region-locked, Go+ only, or the uploader turned off app playback."
        : "This video isn't available. It may be private, region-locked or age-gated.";
    }
    if (code === "api.instance.not_ready" && context && context.reason === "disk") {
      text = "This instance is out of disk space. Try again later.";
    }
    if (code === "api.rate_limit") {
      const reason = context && context.reason ? String(context.reason) : "";
      if (reason === "daily_cap") {
        text = "This instance has hit its daily download limit. Try again tomorrow.";
      } else if (reason === "too_many_downloads") {
        text = "That's a lot of downloads in a row. Give it a minute and retry.";
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
      setStatus(item, "ready", "stream interrupted, open manually");
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
    return safeFilename(rawFilenameFromHeaders(disposition), "");
  }

  function rawFilenameFromHeaders(disposition) {
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
    if (settings.savingMethod === "download") {
      /* instant by default: a blob is saved straight away, and a direct link
         (a server that redirects instead of tunnelling) is handed to the
         browser rather than left on the row for a second press */
      if (blob) saveBlob(item);
      else if (item.sourceUrl) handOffToBrowser(item, "direct link");
      return;
    }
    if (settings.savingMethod === "share" && blob) {
      const shared = await shareItem(item, true);
      if (!shared) saveBlob(item);
    } else if (settings.savingMethod === "copy" && item.sourceUrl) {
      copyText(item.sourceUrl, "Link copied");
    } else if (settings.savingMethod === "ask") {
      /* nothing is pushed at you: the row turns into a save button and waits */
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
      setStatus(item, "ready", label + ", open to save");
      return;
    }
    if (settings.savingMethod === "copy") {
      copyText(item.sourceUrl, "Link copied");
      setStatus(item, "done", "link copied");
      return;
    }
    if (!item.sourceUrl) {
      setStatus(item, "ready", label + ", no direct link");
      return;
    }

    const link = document.createElement("a");
    link.href = item.sourceUrl;
    link.download = safeFilename(item.filename, "download");
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
    if (item.saving) return;
    item.saving = true;
    setTimeout(() => { item.saving = false; }, 900);
    const link = document.createElement("a");
    link.href = item.blobUrl;
    link.download = safeFilename(item.filename, "download");
    link.dataset.ignoreDock = "true";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setStatus(item, "done", "saved · " + SAVED_WHERE);
    tellWhereItWent();
    setTimeout(() => { if (item.status === "done") updateItem(item); }, 1200);
  }

  async function shareItem(item, silentFallback) {
    if (item.sharing) return false;
    item.sharing = true;
    setTimeout(() => { item.sharing = false; }, 900);
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
      if (item.sourceUrl) await copyText(item.sourceUrl, "Sharing isn't supported here, so the link was copied instead.");
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
    const tunnels = (Array.isArray(data.tunnel) ? data.tunnel.map(resolveUrl) : []).filter(Boolean);
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
        text: "The API served this media as separate streams (" + (data.type || "unknown") + "). Merge them on your machine. The streams are temporary and expire."
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
    toast("This media needs local merging. The streams and a ready ffmpeg command are in this dialog.", "warn");
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
    if (tipOpen) closeTipPop(true);
    const panel = dom.modal.querySelector(".modal-inner");
    if (panel) panel.classList.remove("is-sources");
    dom.modalTitle.textContent = title;
    dom.modalBody.innerHTML = "";
    dom.modalBody.appendChild(bodyNode);
    dom.modalFoot.innerHTML = "";
    (footButtons || []).forEach((btn) => dom.modalFoot.appendChild(btn));

    modalReturnFocus = document.activeElement;
    modalSeq += 1;
    dom.modal.classList.remove("is-closing");
    delete dom.modal.dataset.closing;
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
      if (!loaded || !window.turnstile) return "";

      /* the widget must be able to lay itself out: a display:none container
         never completes the challenge, which is exactly how the check looked
         broken while the server side was fine */
      await new Promise((resolve) => {
        let done = false;
        const ready = () => { if (!done) { done = true; resolve(); } };
        setTimeout(ready, 1500);
        if (typeof window.turnstile.ready === "function") window.turnstile.ready(ready);
        else ready();
      });

      if (!turnstileWidget) {
        const holder = document.createElement("div");
        holder.id = "turnstile-holder";
        holder.style.cssText = [
          "position:fixed", "bottom:14px", "right:14px", "z-index:90",
          "width:300px", "height:70px", "opacity:0", "pointer-events:none"
        ].join(";");
        document.body.appendChild(holder);
        turnstileWidget = window.turnstile.render(holder, {
          sitekey: key,
          appearance: "interaction-only",
          execution: "execute",
          callback: (token) => { turnstileToken = token; },
          "error-callback": () => { turnstileToken = ""; },
          "expired-callback": () => { turnstileToken = ""; }
        });
      }

      turnstileToken = "";
      try { window.turnstile.execute(turnstileWidget); } catch (e) { /* retried below */ }
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
    const request = () => fetch(endpoint + "probe", {
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

    let res = await request();
    if (res.status === 403) {
      /* a challenge that expired is worth one silent retry */
      await new Promise((resolve) => setTimeout(resolve, 400));
      res = await request();
    }
    if (!res.ok) {
      throw Object.assign(new Error("probe failed"), { status: res.status });
    }
    const data = await res.json();
    if (!data || data.status !== "ok") {
      throw Object.assign(new Error("probe rejected"), { status: 422 });
    }
    storeProbe(key, data);
    return data;
  }

  function showProbeError(status) {
    const known = {
      403: "the server refused this request. reload and try again.",
      404: "this link does not work. check the link, or try audio only.",
      422: "this link does not work. check the link, or try audio only.",
      429: "too many requests. wait a minute and try again."
    };
    const text = known[status] || "the server did not respond.";
    const withLink = !known[status] || status >= 500;
    dom.hint.innerHTML = escapeHtml(text) + (withLink ? ' <a href="status.html">status page</a>' : "");
    dom.hint.dataset.tone = "warn";
    nudgeComposer();
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
    item.thumb = safeImageUrl(data.thumbnail);
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

  /* where each one lives, for the chips: the panel is a list of sites, so a
     chip that goes nowhere was a missed handshake. no affiliation claimed. */
  const SOURCE_HOME = {
    "9gag": "https://9gag.com",
    audiomack: "https://audiomack.com",
    bandcamp: "https://bandcamp.com",
    bilibili: "https://www.bilibili.com",
    bluesky: "https://bsky.app",
    coub: "https://coub.com",
    dailymotion: "https://www.dailymotion.com",
    douyin: "https://www.douyin.com",
    facebook: "https://www.facebook.com",
    hearthis: "https://hearthis.at",
    imgur: "https://imgur.com",
    instagram: "https://www.instagram.com",
    kick: "https://kick.com",
    loom: "https://www.loom.com",
    mixcloud: "https://www.mixcloud.com",
    newgrounds: "https://www.newgrounds.com",
    odysee: "https://odysee.com",
    ok: "https://ok.ru",
    reddit: "https://www.reddit.com",
    rumble: "https://rumble.com",
    rutube: "https://rutube.ru",
    snapchat: "https://www.snapchat.com",
    soundcloud: "https://soundcloud.com",
    streamable: "https://streamable.com",
    threads: "https://www.threads.net",
    tiktok: "https://www.tiktok.com",
    tumblr: "https://www.tumblr.com",
    twitch: "https://www.twitch.tv",
    twitter: "https://x.com",
    vimeo: "https://vimeo.com",
    vk: "https://vk.com",
    xiaohongshu: "https://www.xiaohongshu.com",
    youtube: "https://www.youtube.com"
  };

  let sourcesOpen = false;
  let sourcesSeq = 0;

  function closeSources() {
    if (!sourcesOpen) return;
    sourcesOpen = false;
    dom.openSources.classList.remove("is-open");
    const veil = document.getElementById("sources-veil");
    if (veil) {
      veil.classList.remove("is-on");
      setTimeout(() => { if (!sourcesOpen) veil.hidden = true; }, 220);
    }
    const panel = dom.sourcesPanel;
    const topbar = document.querySelector(".topbar");
    if (!panel || panel.hidden) {
      dom.openSources.setAttribute("aria-expanded", "false");
      if (topbar) topbar.classList.remove("is-raised");
      return;
    }
    panel.classList.add("is-closing");
    const stamp = ++sourcesSeq;
    const done = () => {
      /* a reopen in the 220ms window bumps the sequence: the close that was
         already scheduled must not hide the panel the user just opened */
      if (stamp !== sourcesSeq) return;
      panel.classList.remove("is-closing");
      panel.hidden = true;
      dom.openSources.setAttribute("aria-expanded", "false");
      if (topbar) topbar.classList.remove("is-raised");
    };
    panel.addEventListener("animationend", done, { once: true });
    setTimeout(done, 220);   // if the animation is off (reduced motion)
  }

  /* The panel hangs from the top of the page and the wordmark sits a short
     drop below it. Rather than guess a height that overlaps on one screen and
     wastes space on another, measure the gap and cap to it. */
  /* the panel shows everything; no inner scroll */
  function fitSources() {}

  function toggleSources() {
    if (sourcesOpen) {
      if (raiseIfBehind(dom.sourcesPanel)) return;
      closeSources();
      return;
    }
    if (tipOpen) closeTipPop(true);
    sourcesSeq += 1;
    sourcesOpen = true;
    dom.sourcesPanel.classList.remove("is-closing");
    /* the cross answers the tap, not the render: flip it before building the
       list, or thirty chips of DOM work sit between your press and the turn */
    dom.openSources.classList.add("is-open");
    dom.openSources.setAttribute("aria-expanded", "true");
    const topbar = document.querySelector(".topbar");
    if (topbar) topbar.classList.add("is-raised");
    dom.sourcesPanel.hidden = false;
    bringToFront(dom.sourcesPanel);
    renderSources();
    const veil = document.getElementById("sources-veil");
    if (veil) {
      if (veil.hidden) {
        veil.hidden = false;
        /* one forced style pass, then the fade: requestAnimationFrame is
           throttled in some contexts and the veil never reached "on" */
        void veil.offsetHeight;
      }
      veil.classList.add("is-on");
    }
    fitSources();
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

  /* the panel is a shortcut, not an inventory: the twenty people actually
     paste from, with the rest one click away */
  const FEATURED = [
    "youtube", "soundcloud", "tiktok", "instagram", "reddit", "twitter",
    "facebook", "vimeo", "twitch", "dailymotion", "bilibili", "bluesky",
    "threads", "tumblr", "bandcamp", "mixcloud", "rumble", "odysee",
    "streamable", "snapchat"
  ];

  let sourcesSig = "";
  function renderSources(force) {
    const all = sourceList().sort((a, b) => a[0].localeCompare(b[0]));
    const sig = all.map((entry) => entry[0]).join(",");
    /* the panel is a list of twenty links: build it once and keep it. Opening
       it again is a visibility toggle, not a re-render. */
    if (!force && sig === sourcesSig && dom.sourcesPanel.firstChild) return;
    const known = new Map(all);
    const shown = FEATURED.filter((id) => known.has(id)).map((id) => [id, known.get(id)]);

    const wrap = el("div", { class: "sources" });

    /* a sheet needs to say what it is and offer a way out that is not the
       button you just pressed; on a desktop the same header anchors it */
    wrap.appendChild(el("span", { class: "sources-handle", "aria-hidden": "true" }));
    const head = el("div", { class: "sources-head" });
    head.appendChild(el("span", { class: "sources-title", text: "sources" }));
    head.appendChild(el("span", { class: "sources-count", text: all.length + " services" }));
    wrap.appendChild(head);

    const row = el("div", { class: "source-chips" });
    shown.forEach(([id, note]) => {
      const home = SOURCE_HOME[id] || "";
      const host = home.replace(/^https?:\/\/(?:www\.)?/, "").replace(/\/$/, "");
      /* a chip is a door: it opens the site in a new tab, and the title carries
         the full address for the names too long to print in full */
      const chip = home
        ? el("a", {
            class: "source-chip",
            href: home,
            target: "_blank",
            rel: "noopener noreferrer",
            title: id + (host ? " · " + host : "") + (note ? " · " + note : ""),
            "aria-label": id + (host ? ", open " + host : "")
          })
        : el("span", { class: "source-chip", title: id + (note ? ", " + note : "") });
      chip.textContent = id;
      row.appendChild(chip);
    });
    wrap.appendChild(row);

    /* the foot of the sheet: the thing you came here to do, then the full list,
       then the small print. It used to be note → gap → link, which read as a
       hole in the panel. */
    const note = el("p", { class: "sources-note" });
    note.appendChild(el("b", { text: "download" }));
    note.appendChild(document.createTextNode(" compatibility only, no affiliation or endorsement"));
    wrap.appendChild(note);

    const more = el("a", {
      class: "sources-more",
      href: "sources.html",
      text: "all " + all.length + " sources"
    });
    const go = el("span", { class: "sources-more-go", "aria-hidden": "true" });
    more.appendChild(go);
    wrap.appendChild(more);

    dom.sourcesPanel.innerHTML = "";
    dom.sourcesPanel.appendChild(wrap);
    sourcesSig = sig;
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
    const stripe = typeof cfg.stripe === "string" ? cfg.stripe.trim() : "";
    const liberapay = typeof cfg.liberapay === "string" ? cfg.liberapay.trim() : "";
    if (!methods.length && !stripe && !liberapay) return null;
    return {
      methods,
      stripe,
      liberapay,
      note: typeof cfg.note === "string" ? cfg.note : ""
    };
  }

  function renderDonate() {
    const cfg = donateConfig();
    /* a nav link to a closed tip jar is just a dead end */
    document.querySelectorAll(".nav-donate").forEach((link) => {
      link.hidden = !cfg;
    });
    const settingsDonate = $("#open-donate-settings");
    if (settingsDonate) {
      settingsDonate.hidden = !cfg;
      if (!settingsDonate.dataset.tipBound) {
        settingsDonate.dataset.tipBound = "1";
        settingsDonate.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          closeSettings();
          openTipPop(event);
        });
      }
    }
    const tip = $("#open-donate-top");
    if (tip) tip.hidden = !cfg;
    if (!dom.donateLink) return;
    dom.donateLink.hidden = !cfg;
    if (!cfg) return;
    /* the link may have been rendered before the config existed */
    dom.donateLink.removeAttribute("aria-disabled");
  }

  /* An open can happen inside a click handler (settings, help). That same
     click then bubbles to the document listener below, which used to close the
     jar in the same tick — the button looked dead. The event that opened it is
     remembered and ignored when it comes back around; a later click still
     closes the jar as it should. */
  let tipOpenedBy = null;

  function bindTip() {
    tipTriggers().forEach((node) => {
      node.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (tipOpen) closeTipPop();
        else openTipPop();
      });
    });
    const tipVeil = document.getElementById("tip-veil");
    if (tipVeil) tipVeil.addEventListener("click", () => closeTipPop());

    document.addEventListener("click", (event) => {
      if (!tipOpen) return;
      if (event === tipOpenedBy) return;
      if (dom.tipPop && dom.tipPop.contains(event.target)) return;
      if (event.target.closest && event.target.closest('[aria-controls="tip-pop"]')) return;
      closeTipPop();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && tipOpen) closeTipPop();
    });
    window.addEventListener("resize", () => {
      positionTipPop();
      positionDockPanel();
    });
  }

  function coinGlyph(id) {
    const set = window.MDOWN_COIN || {};
    if (!set[id]) return null;
    const box = el("span", { class: "coin-icon", "aria-hidden": "true" });
    box.dataset.coin = id;
    box.innerHTML = set[id];
    return box;
  }

  function masked(value) {
    return typeof window.MDOWN_MASK === "function" ? window.MDOWN_MASK(value) : String(value);
  }

  /* the full address is one click away and always in the DOM attribute, so a
     copy never depends on what is currently painted on screen */
  function addressCode(method) {
    const full = String(method.value);
    const code = el("code", { class: "donate-value", text: masked(full) });
    code.dataset.address = full;
    code.title = "click to show the whole address";
    code.tabIndex = 0;
    code.setAttribute("role", "button");
    code.setAttribute("aria-pressed", "false");
    const toggle = () => {
      const shown = code.dataset.revealed === "1";
      code.textContent = shown ? masked(full) : full;
      code.dataset.revealed = shown ? "0" : "1";
      code.classList.toggle("is-revealed", !shown);
      code.setAttribute("aria-pressed", shown ? "false" : "true");
      code.title = shown ? "click to show the whole address" : "click to hide the address";
    };
    code.addEventListener("click", toggle);
    code.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    });
    return code;
  }

  /* the tip jar is a dropdown, like the sources list: one tap, no page load */
  let tipOpen = false;
  let tipHideTimer = null;

  function tipTriggers() {
    return $$("#open-donate-top");
  }

  function setTipState(on) {
    tipOpen = on;
    tipTriggers().forEach((node) => node.setAttribute("aria-expanded", on ? "true" : "false"));
    const pop = dom.tipPop;
    if (pop) pop.setAttribute("aria-hidden", on ? "false" : "true");
  }

  /* a dropdown drops from the middle of the button that opened it, and stops
     eight pixels short of the screen. centring alone walks off the edge on a
     narrow window, which is what this clamp is for. */
  function placeUnder(pop, anchor) {
    if (!pop || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = pop.getBoundingClientRect().width;
    const centre = rect.left + rect.width / 2;
    const left = Math.min(
      Math.max(8, centre - width / 2),
      Math.max(8, window.innerWidth - width - 8)
    );
    pop.style.top = Math.round(rect.bottom + 8) + "px";
    pop.style.left = Math.round(left) + "px";
    pop.style.right = "auto";
  }

  function positionTipPop() {
    const pop = dom.tipPop;
    if (!pop || pop.hidden) return;
    if (PHONE()) {
      pop.style.left = "";
      pop.style.right = "";
      pop.style.top = "";
      return;
    }
    placeUnder(pop, $("#open-donate-top"));
  }

  function positionDockPanel() {
    const panel = dom.queuePanel;
    if (!panel || panel.hidden) return;
    if (PHONE()) {
      /* the phone's sheet is pinned to the bottom edge, not to the button */
      panel.style.left = "";
      panel.style.right = "";
      panel.style.top = "";
      return;
    }
    placeUnder(panel, dom.queueToggle);
  }

  function closeTipPop(instant) {
    if (!tipOpen) return;
    const pop = dom.tipPop;
    const veil = document.getElementById("tip-veil");
    setTipState(false);
    clearTimeout(tipHideTimer);
    if (!pop) return;
    if (instant) {
      pop.hidden = true;
      pop.classList.remove("is-closing");
      if (veil) { veil.classList.remove("is-on"); veil.hidden = true; }
      return;
    }
    if (veil) {
      veil.classList.remove("is-on");
      setTimeout(() => { if (!tipOpen) veil.hidden = true; }, 220);
    }
    pop.classList.add("is-closing");
    /* the phone's exit is 220ms: hiding at 140 cut the sheet off halfway down
       the screen, which is the snap that made the jar feel broken */
    tipHideTimer = setTimeout(() => {
      if (tipOpen) return;
      pop.hidden = true;
      pop.classList.remove("is-closing");
    }, PHONE() ? 260 : 150);
  }

  function openTipPop(openerEvent) {
    const cfg = donateConfig();
    const pop = dom.tipPop;
    if (!cfg || !pop) return;

    /* whatever you pressed to get here leaves at once. two panels animating
       through each other, or a dialog fading out above the jar, is what made
       the jar feel broken when it was opened from settings or help */
    if (healthOpen) closeHealthPop();
    if (dockOpen) setDock(false);
    if (sourcesOpen) closeSources();
    if (!dom.sheet.hidden) closeSettings();
    if (dom.modal && !dom.modal.hidden) closeModal(true);

    clearTimeout(tipHideTimer);
    pop.innerHTML = "";
    const head = el("div", { class: "tip-head" });
    head.appendChild(el("b", { text: "tip jar" }));
    head.appendChild(el("span", { class: "tip-state", text: "open" }));
    const closeBtn = el("button", { type: "button", class: "tip-close", "aria-label": "close tip jar" });
    closeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    closeBtn.addEventListener("click", () => closeTipPop());
    head.appendChild(closeBtn);
    pop.appendChild(head);

    if (cfg.stripe) {
      const card = el("a", {
        class: "donate-card",
        href: cfg.stripe,
        rel: "noopener noreferrer",
        target: "_blank"
      });
      const badge = coinGlyph("card");
      badge.classList.add("donate-card-icon");
      card.appendChild(badge);
      const copy = el("span", { class: "donate-card-copy" });
      copy.appendChild(el("b", { text: "credit card" }));
      copy.appendChild(el("span", { text: "apple pay · google pay · via stripe" }));
      card.appendChild(copy);
      const go = el("span", { class: "donate-card-go", "aria-hidden": "true" });
      go.innerHTML = (window.MDOWN_COIN || {}).arrow || "";
      card.appendChild(go);
      pop.appendChild(card);
    }

    if (cfg.methods.length) {
      pop.appendChild(el("p", { class: "donate-or", text: "or send crypto" }));
      const list = el("div", { class: "donate-list" });
      cfg.methods.forEach((method) => {
        const row = el("div", { class: "donate-row" });
        row.dataset.coin = method.id;
        const badge = coinGlyph(method.id);
        if (badge) row.appendChild(badge);
        const left = el("div", { class: "donate-id" });
        left.appendChild(el("span", { class: "donate-label", text: String(method.label || method.id || "tip") }));
        if (method.href) {
          left.appendChild(el("a", {
            class: "donate-value",
            href: String(method.href),
            text: String(method.href).replace(/^https?:\/\//, ""),
            rel: "noopener noreferrer",
            target: "_blank"
          }));
        } else {
          left.appendChild(addressCode(method));
        }
        if (method.note) left.appendChild(el("span", { class: "donate-hint", text: String(method.note) }));
        row.appendChild(left);
        if (!method.href && method.value) {
          const copy = el("button", {
            type: "button",
            class: "ghost-btn small",
            text: "copy",
            "aria-label": "copy " + String(method.label || "address")
          });
          copy.addEventListener("click", async () => {
            const ok = await copyText(String(method.value), "Address copied", true);
            if (!ok) return;
            copy.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7"/></svg><span>copied</span>';
            copy.classList.add("is-copied");
            clearTimeout(copy._reset);
            copy._reset = setTimeout(() => {
              copy.textContent = "copy";
              copy.classList.remove("is-copied");
            }, 900);
          });
          row.appendChild(copy);
        }
        list.appendChild(row);
      });
      pop.appendChild(list);
    }

    pop.appendChild(el("p", {
      class: "donate-fine",
      text: "nothing here unlocks anything. it is just a tip jar."
    }));

    const more = el("a", { class: "tip-more", href: "donate.html" });
    more.appendChild(el("span", { text: "all the ways to give" }));
    more.appendChild(el("span", { class: "tip-more-go", "aria-hidden": "true" }));
    /* a phone opens the tab here, and this is the one link inside the jar:
       answering it directly beats hoping a delegated handler sees it first */
    more.addEventListener("click", (event) => {
      if (!PHONE()) return;
      event.preventDefault();
      event.stopPropagation();
      /* leave first, then switch: opening the tab while the sheet is still
         animating left the sheet on top of it, which looked like the link just
         reopened the menu */
      closeTipPop(true);
      setTimeout(() => openDonateTab(), 30);
    });
    pop.appendChild(more);

    pop.hidden = false;
    pop.classList.remove("is-closing");
    /* the jar joins the same stack as every other panel: whichever you opened
       last is the one in front, whether that is the jar, the health card, the
       downloads list or the sources sheet */
    bringToFront(pop);
    setTipState(true);
    tipOpenedBy = openerEvent || null;
    const veil = document.getElementById("tip-veil");
    if (veil) {
      if (veil.hidden) {
        veil.hidden = false;
        void veil.offsetHeight;
      }
      veil.classList.add("is-on");
    }
    positionTipPop();
  }

  /* ----------------------------------------------------------
     the request board: one public line, nothing attached
     ---------------------------------------------------------- */
  let boardLoaded = false;
  let boardSending = false;

  function boardAgo(stamp) {
    const seconds = Math.max(0, Math.floor(Date.now() / 1000 - Number(stamp || 0)));
    if (seconds < 45) return "just now";
    if (seconds < 5400) return Math.max(1, Math.round(seconds / 60)) + "m ago";
    if (seconds < 172800) return Math.round(seconds / 3600) + "h ago";
    return Math.round(seconds / 86400) + "d ago";
  }

  function boardRow(entry) {
    const item = el("li", { class: "board-item" });
    /* textContent, never innerHTML: this is a stranger's sentence */
    item.appendChild(el("p", { class: "board-line", text: String((entry && entry.text) || "") }));
    item.appendChild(el("span", { class: "board-meta", text: boardAgo(entry && entry.t) }));
    return item;
  }

  function boardSay(text) {
    if (!dom.boardState) return;
    dom.boardState.textContent = text || "";
    dom.boardState.hidden = !text;
  }

  function boardPaint(items) {
    if (!dom.boardList) return;
    dom.boardList.innerHTML = "";
    items.slice(0, 12).forEach((entry) => dom.boardList.appendChild(boardRow(entry)));
    if (!items.length) boardSay("nothing yet. yours can be the first.");
    else boardSay("");
  }

  async function boardLoad() {
    if (boardLoaded) return;
    const base = apiEndpoint();
    if (!base) return;
    boardLoaded = true;
    try {
      const response = await fetch(base + "requests", {
        headers: { Accept: "application/json" }, cache: "no-store"
      });
      if (!response.ok) throw new Error("status " + response.status);
      const data = await response.json();
      boardPaint(Array.isArray(data.items) ? data.items : []);
      /* only the owner's browser has a key, and only the owner sees the queue */
      boardLoadPending();
    } catch (error) {
      boardLoaded = false;
      boardSay("the board is not answering right now.");
    }
  }

  const BOARD_TAG = "public · no name · no account";

  function boardReviewCount() {
    if (!dom.boardReview) return;
    const waiting = dom.boardReviewList ? dom.boardReviewList.children.length : 0;
    dom.boardReview.hidden = waiting === 0;
    if (dom.boardReviewCount) {
      dom.boardReviewCount.textContent = waiting ? waiting + " waiting" : "";
    }
    /* the closed line is the notification: an owner with three asks to read
       should not have to open the board to find out */
    const tag = dom.board && dom.board.querySelector(".board-tag");
    if (tag) tag.textContent = waiting ? waiting + " to review" : BOARD_TAG;
  }

  function boardReviewRow(entry) {
    const item = el("li", { class: "board-item is-review" });
    item.appendChild(el("p", { class: "board-line", text: String((entry && entry.text) || "") }));
    item.appendChild(el("span", { class: "board-meta", text: boardAgo(entry && entry.t) }));
    const show = el("button", { type: "button", class: "ghost-btn small", text: "show" });
    const hide = el("button", { type: "button", class: "ghost-btn small", text: "hide" });
    show.addEventListener("click", () => boardModerate("approve", entry, item));
    hide.addEventListener("click", () => boardModerate("delete", entry, item));
    item.appendChild(show);
    item.appendChild(hide);
    return item;
  }

  async function boardModerate(action, entry, row) {
    const base = apiEndpoint();
    if (!base) return;
    row.classList.add("is-busy");
    try {
      const response = await fetch(base + "requests/" + action, {
        method: "POST",
        headers: Object.assign({
          "Content-Type": "application/json", Accept: "application/json"
        }, authHeaders()),
        body: JSON.stringify({ id: entry.id })
      });
      if (!response.ok) throw new Error("status " + response.status);
      row.remove();
      if (action === "approve") {
        const first = dom.boardList.querySelector(".board-item");
        const approved = Object.assign({}, entry, { ok: true });
        if (first) dom.boardList.insertBefore(boardRow(approved), first);
        else dom.boardList.appendChild(boardRow(approved));
      }
      boardReviewCount();
    } catch (error) {
      row.classList.remove("is-busy");
      boardSay("that did not go through.");
    }
  }

  function inboxCount() {
    if (!dom.boardInbox) return;
    const waiting = dom.boardInboxList ? dom.boardInboxList.children.length : 0;
    dom.boardInbox.hidden = waiting === 0;
    if (dom.boardInboxCount) dom.boardInboxCount.textContent = waiting ? waiting + " waiting" : "";
  }

  function inboxRow(entry) {
    const item = el("li", { class: "board-item is-review" });
    item.appendChild(el("p", { class: "board-line", text: String((entry && entry.text) || "") }));
    item.appendChild(el("span", { class: "board-meta", text: boardAgo(entry && entry.t) }));
    const done = el("button", { type: "button", class: "ghost-btn small", text: "handled" });
    const drop = el("button", { type: "button", class: "ghost-btn small", text: "delete" });
    done.addEventListener("click", () => inboxModerate("handled", entry, item));
    drop.addEventListener("click", () => inboxModerate("delete", entry, item));
    item.appendChild(done);
    item.appendChild(drop);
    return item;
  }

  async function inboxModerate(action, entry, row) {
    const base = apiEndpoint();
    if (!base) return;
    row.classList.add("is-busy");
    try {
      const response = await fetch(base + "reports/" + action, {
        method: "POST",
        headers: Object.assign({
          "Content-Type": "application/json", Accept: "application/json"
        }, authHeaders()),
        body: JSON.stringify({ id: entry.id })
      });
      if (!response.ok) throw new Error("status " + response.status);
      row.remove();
      inboxCount();
    } catch (error) {
      row.classList.remove("is-busy");
    }
  }

  async function boardLoadInbox() {
    if (!settings.apiKey || !dom.boardInboxList) return;
    const base = apiEndpoint();
    if (!base) return;
    try {
      const response = await fetch(base + "reports", {
        headers: Object.assign({ Accept: "application/json" }, authHeaders()),
        cache: "no-store"
      });
      if (!response.ok) return;
      const data = await response.json();
      const items = Array.isArray(data.items) ? data.items : [];
      dom.boardInboxList.innerHTML = "";
      items.forEach((entry) => dom.boardInboxList.appendChild(inboxRow(entry)));
      inboxCount();
    } catch (error) { /* the inbox is the owner's, and it can wait */ }
  }

  /* "this service is broken": a private note, not a board post. The link they
     pasted is deliberately left out of it. */
  function openBrokenReport(item) {
    const base = apiEndpoint();
    if (!base) return;
    const body = el("div", { class: "report-form" });
    const who = el("p", { class: "report-who" });
    who.appendChild(el("span", { text: "service: " }));
    who.appendChild(el("b", { text: item.service || "unknown" }));
    body.appendChild(who);
    if (item.error) body.appendChild(el("p", { class: "report-why", text: item.error }));
    body.appendChild(el("p", {
      class: "report-privacy",
      text: "this goes to the owner only. no name, no address, and the link you pasted is not sent."
    }));
    const reasons = el("div", { class: "report-reasons", role: "group", "aria-label": "what went wrong" });
    const picked = { value: "" };
    ["service down", "download failed", "wrong file", "too slow"].forEach((label) => {
      const b = el("button", { type: "button", class: "ghost-btn small", text: label });
      b.addEventListener("click", () => {
        picked.value = label;
        reasons.querySelectorAll(".ghost-btn").forEach((n) => n.removeAttribute("aria-pressed"));
        b.setAttribute("aria-pressed", "true");
      });
      reasons.appendChild(b);
    });
    body.appendChild(reasons);
    const note = el("input", {
      class: "report-note", type: "text", maxlength: "120",
      placeholder: "anything else? (optional)", "aria-label": "anything else"
    });
    body.appendChild(note);
    const state = el("p", { class: "report-state", role: "status", "aria-live": "polite" });
    body.appendChild(state);

    const cancel = el("button", { type: "button", class: "ghost-btn", text: "cancel" });
    cancel.addEventListener("click", () => closeModal());
    const send = el("button", { type: "button", class: "primary-btn", text: "send" });
    send.addEventListener("click", async () => {
      if (send.disabled) return;
      if (!picked.value) {
        state.textContent = "pick what went wrong first.";
        return;
      }
      send.disabled = true;
      try {
        const response = await fetch(base + "reports", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            service: item.service || "unknown",
            note: (picked.value + (note.value.trim() ? " · " + note.value.trim() : "")).slice(0, 200)
          })
        });
        if (response.status === 429) {
          state.textContent = "a few reports an hour is the limit. try again later.";
          return;
        }
        if (!response.ok) throw new Error("status " + response.status);
        state.textContent = "sent. thank you.";
        note.value = "";
        /* if this browser is also the owner's, the note it just sent should
           show up in the inbox without a reload */
        boardLoadInbox();
        clearTimeout(send._close);
        send._close = setTimeout(() => {
          if (dom.modal && !dom.modal.hidden) closeModal();
        }, 900);
      } catch (error) {
        state.textContent = "it did not send. try again in a minute.";
      } finally {
        send.disabled = false;
      }
    });
    openModal("Report a broken service", body, [cancel, send]);
    setTimeout(() => { try { note.focus(); } catch (e) {} }, 80);
  }

  async function boardLoadPending() {
    if (!settings.apiKey || !dom.boardReviewList) return;
    const base = apiEndpoint();
    if (!base) return;
    try {
      const response = await fetch(base + "requests/pending", {
        headers: Object.assign({ Accept: "application/json" }, authHeaders()),
        cache: "no-store"
      });
      if (!response.ok) return;
      const data = await response.json();
      const items = Array.isArray(data.items) ? data.items : [];
      dom.boardReviewList.innerHTML = "";
      items.forEach((entry) => dom.boardReviewList.appendChild(boardReviewRow(entry)));
      boardReviewCount();
      boardLoadInbox();
    } catch (error) { /* the queue is the owner's problem, not the page's */ }
  }

  function boardSync() {
    const text = String((dom.boardText && dom.boardText.value) || "").trim();
    if (dom.boardCount) dom.boardCount.textContent = text.length + " / 240";
    if (dom.boardSend) dom.boardSend.disabled = boardSending || text.length < 3;
  }

  async function boardSend(event) {
    if (event) event.preventDefault();
    if (boardSending) return;
    const text = String((dom.boardText && dom.boardText.value) || "").trim();
    if (text.length < 3) return;
    const base = apiEndpoint();
    if (!base) {
      boardSay("no instance is set, so there is nowhere to send it.");
      return;
    }
    boardSending = true;
    if (dom.boardSend) dom.boardSend.textContent = "sending";
    boardSync();
    try {
      const response = await fetch(base + "requests", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ text })
      });
      if (response.status === 429) {
        boardSay("a few an hour is the whole limit. try again later.");
        return;
      }
      if (!response.ok) throw new Error("status " + response.status);
      /* queued, not published: a stranger cannot put words on the front page
         by typing them, so nothing is added to the list here */
      if (dom.boardText) dom.boardText.value = "";
      boardSay("sent. it shows on the board once it has been looked at.");
      boardLoadPending();
    } catch (error) {
      boardSay("it did not send. try again in a minute.");
    } finally {
      boardSending = false;
      if (dom.boardSend) dom.boardSend.textContent = "send";
      boardSync();
    }
  }

  function boardVisible() {
    if (!dom.board || !dom.board.isConnected) return;
    /* an instance that does not advertise the board has no routes for it: a
       box that cannot send is worse than no box */
    dom.board.hidden = !(apiEndpoint() && instanceInfo && instanceInfo.board === true);
  }

  /* The public ask board is off. ?board=1 still opens it. An owner (a key in
     settings) keeps the private reports strip either way. */
  const BOARD_ENABLED = /[?&]board=(?!0)/.test(location.search);

  function bindBoard() {
    if (!dom.board || !dom.boardForm) return;
    if (!BOARD_ENABLED) {
      /* no ask board. with a key, the card stays for one thing only: the
         reports waiting for a yes. */
      if (!settings.apiKey) { dom.board.remove(); return; }
      dom.board.classList.add("board-owner");
      dom.board.hidden = false;
      const disc = document.getElementById("board-disclosure");
      if (disc) disc.open = true;
      boardLoadInbox();
      return;
    }
    boardVisible();
    dom.boardText.addEventListener("input", boardSync);
    dom.boardForm.addEventListener("submit", boardSend);
    boardSync();
    /* the owner's browser can tell, without opening anything, whether there is
       something waiting: the queue is key-gated, so this costs other visitors
       nothing */
    if (settings.apiKey) boardLoadPending();
    /* shut until asked, and nothing is fetched until it opens: the page does
       not talk to the board just because somebody scrolled past the headline */
    const disclosure = document.getElementById("board-disclosure");
    if (disclosure) {
      disclosure.addEventListener("toggle", () => {
        if (disclosure.open) boardLoad();
      });
    } else {
      boardLoad();
    }
  }

  /* everything that used to open the donate dialog now opens the dropdown */
  function openDonate(event) {
    openTipPop(event);
  }

  let modalSeq = 0;
  function closeModal(instant) {
    if (dom.modal.hidden) return;
    if (instant) {
      modalSeq += 1;
      dom.modal.hidden = true;
      dom.modal.classList.remove("is-closing");
      delete dom.modal.dataset.closing;
      if (dom.sheet.hidden) document.body.style.overflow = "";
      modalReturnFocus = null;
      return;
    }
    if (dom.modal.dataset.closing === "1") return;
    dom.modal.dataset.closing = "1";
    dom.modal.classList.add("is-closing");
    const stamp = ++modalSeq;
    const finish = () => {
      if (stamp !== modalSeq) return;
      dom.modal.hidden = true;
      dom.modal.classList.remove("is-closing");
      delete dom.modal.dataset.closing;
      if (dom.sheet.hidden) document.body.style.overflow = "";
      if (modalReturnFocus && typeof modalReturnFocus.focus === "function") {
        modalReturnFocus.focus();
      }
      modalReturnFocus = null;
    };
    dom.modal.addEventListener("animationend", finish, { once: true });
    setTimeout(finish, 140);   /* or reduced motion, where nothing plays */
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
  async function copyText(text, message, quiet) {
    try {
      await navigator.clipboard.writeText(text);
      /* a control that already says "copied" does not need a toast saying it */
      if (!quiet) toast(message || "Copied", "ok");
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        if (!quiet) toast(message || "Copied", "ok");
        return true;
      } catch { toast("Copy failed. Select the text manually.", "err"); return false; }
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
      dom.setupLead.textContent = "The API isn't answering. Retrying. If it stays down, ";
      dom.setupButton.textContent = "open settings";
      dom.setupTail.textContent = " to check the address.";
    } else {
      dom.setupLead.textContent = "Not connected. ";
      dom.setupButton.textContent = "connect an API";
      dom.setupTail.textContent = " to download.";
    }
  }

  let instanceSeq = 0;

  /* One attempt at the instance, so a dropped request can be retried without
     carrying its own timeout into the second try. */
  async function fetchInstance(base, controller) {
    const res = await fetch(base.replace(/\/+$/, "") + "/", {
      method: "GET",
      headers: Object.assign({ Accept: "application/json" }, authHeaders()),
      signal: controller.signal
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error("The API refused the request (HTTP " + res.status + "). Add or check the API key in Settings → Server.");
    }
    if (!res.ok) throw new Error("The API answered HTTP " + res.status + ".");
    return res.json();
  }

  let instanceFails = 0;
  let instanceEverOk = false;
  let instanceRetry = 0;

  async function checkInstance(options) {
    const opts = options || {};
    const stamp = ++instanceSeq;
    const base = normalizeInstance(settings.instance);
    setSetupNote(base ? null : "empty");
    clearTimeout(instanceRetry);

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

    const ask = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 9000);
      try { return await fetchInstance(base, controller); }
      finally { clearTimeout(timer); }
    };

    try {
      let data;
      try {
        data = await ask();
      } catch (first) {
        if (stamp !== instanceSeq) return false;
        /* a deploy restarts the service for a second. One quiet retry turns
           that into a blip instead of a warning on the home page. */
        await new Promise((resolve) => setTimeout(resolve, 900));
        data = await ask();
      }
      const cobalt = data && data.cobalt ? data.cobalt : {};

      if (stamp !== instanceSeq) return false;
      instanceInfo = {
        services: Array.isArray(cobalt.services) ? cobalt.services : [],
        version: cobalt.version || "",
        // honest capability flag: only an instance that answers /probe gets a
        // size estimate and a thumbnail, everything else looks exactly as before
        probe: cobalt.probe === true,
        board: cobalt.board === true,
        inbox: cobalt.inbox === true,
        limits: cobalt.limits && typeof cobalt.limits === "object" ? cobalt.limits : null,
        turnstileSiteKey: typeof (cobalt.turnstileSitekey || cobalt.turnstileSiteKey) === "string" ? (cobalt.turnstileSitekey || cobalt.turnstileSiteKey) : ""
      };
      instanceFails = 0;
      instanceEverOk = true;
      boardVisible();
      // keep the trigger and an open panel agreeing about the count
      if (sourcesOpen) renderSources();
      const host = hostOf(base) || base;
      // keep the Server pane's health link pointing at the live instance
      if (dom.openHealth) dom.openHealth.href = base.replace(/\/+$/, "") + "/health";
      const usingDefault = normalizeInstance(settings.instance) === normalizeInstance(DEFAULT_INSTANCE);
      const detail = base + (cobalt.version ? " · api " + cobalt.version : "");
      setInstancePill("ok", usingDefault ? "online" : host, detail);
      recordHealth(true);

      const uptime = cobalt.startTime ? formatUptime(Number(cobalt.startTime)) : "unknown";
      const hostname = hostOf(base) || base;
      setInstanceDetail("ok", "Connected", [
        ["server", hostname],
        ["services", String(instanceInfo.services.length || "unknown") + " · up " + uptime]
      ]);
      dom.instanceDetail.title = "version " + (cobalt.version || "unknown");

      setSetupNote(null);
      renderServices(instanceInfo.services);
      updateComposerState();
      return true;
    } catch (err) {
      if (stamp !== instanceSeq) return false;
      recordHealth(false);
      instanceFails += 1;
      const message = err && err.name === "AbortError"
        ? "The API didn't answer within nine seconds."
        : friendlyError(err);
      instanceInfo = null;
      boardVisible();
      setInstancePill("bad", "unreachable", message);
      setInstanceDetail("bad", "Can't reach this instance", [], message);
      /* A person who just pressed "check" wants the answer now. A visitor on
         the home page gets one retry first, and only sees a line if the API is
         still silent after that. */
      setSetupNote(!opts.silent || instanceFails >= 2 ? "unreachable" : null);
      dom.servicesCard.hidden = true;
      /* keep asking in the background, so the note goes away by itself when
         the API comes back instead of staying until a reload */
      if (instanceFails <= 15) {
        instanceRetry = setTimeout(() => checkInstance({ silent: true }), 20000);
      }
      return false;
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

    let exportedAt = 0;
    $("#export-settings").addEventListener("click", () => {
      if (Date.now() - exportedAt < 1000) return;
      exportedAt = Date.now();
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

    let resetArmed = 0;
    $("#reset-settings").addEventListener("click", (event) => {
      const button = event.currentTarget;
      if (Date.now() - resetArmed > 3000) {
        resetArmed = Date.now();
        const label = button.textContent;
        button.textContent = "sure?";
        clearTimeout(button._disarm);
        button._disarm = setTimeout(() => {
          button.textContent = label;
          resetArmed = 0;
        }, 3000);
        return;
      }
      resetArmed = 0;
      clearTimeout(button._disarm);
      button.textContent = "reset all";
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
    /* ----------------------------------------------------------
     settings sheet
     ---------------------------------------------------------- */
  let lastFocused = null;

  function openSettings(section) {
    if (tipOpen) closeTipPop(true);
    if (healthOpen) closeHealthPop();
    if (donateTab) setDonateTab(false);
    const barSettings = $("#mbar-settings");
    if (barSettings) barSettings.setAttribute("aria-expanded", "true");
    syncBarGlider();
    lastFocused = document.activeElement;
    dom.sheet.hidden = false;
    document.body.style.overflow = "hidden";
    if (section) showSettingsSection(section);
    else revealSection($(".sheet-nav-item.is-active"));
    reflectSettings();
    setTimeout(() => {
      /* closing before the timer lands must not focus a hidden field */
      if (dom.sheet.hidden) return;
      const pane = $('.pane.is-active [data-setting], .pane.is-active input, .pane.is-active select');
      const target = section === "instance" ? dom.instanceUrl : pane;
      if (target && typeof target.focus === "function") target.focus();
    }, 60);
  }

  function closeSettings() {
    if (dom.sheet.hidden) return;
    dom.sheet.hidden = true;
    const barSettings = $("#mbar-settings");
    if (barSettings) barSettings.setAttribute("aria-expanded", "false");
    syncBarGlider();
    document.body.style.overflow = "";
    if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
  }

  /* on a phone the section list is a strip that scrolls sideways: keep the
     current one in view so it never looks like a section has no home */
  function revealSection(btn) {
    if (!btn) return;
    const nav = btn.parentElement;
    if (!nav) return;
    const max = nav.scrollWidth - nav.clientWidth;
    if (max <= 4) return;
    const b = btn.getBoundingClientRect();
    const n = nav.getBoundingClientRect();
    if (b.left >= n.left && b.right <= n.right) return;
    /* centred, and moved in the same frame as the pane: a strip that slides
       after the content has changed looks like a second, late decision */
    nav.scrollLeft = Math.max(0, Math.min(max, nav.scrollLeft + (b.left - n.left) - (n.width - b.width) / 2));
  }

  function showSettingsSection(name) {
    $$(".sheet-nav-item").forEach((btn) => {
      const on = btn.dataset.section === name;
      btn.classList.toggle("is-active", on);
      if (on) revealSection(btn);
    });
    $$(".pane").forEach((pane) => pane.classList.toggle("is-active", pane.dataset.pane === name));
    dom.sheetBody.scrollTop = 0;
    updateRequestPreview();
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
    const buttons = [close];
    /* the page, not a dropdown inside a dialog */
    const tip = el("a", { class: "ghost-btn", href: "donate.html", text: "tip jar" });
    tip.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeModal();
      openTipPop(event);
    });
    buttons.unshift(tip);
    openModal("How it works", body, buttons);
  }

  /* ----------------------------------------------------------
     health: the dot opens a miniature of the status page
     ---------------------------------------------------------- */
  const HEALTH_KEY = "mdown.uptime";
  let healthOpen = false;
  let healthTimer = null;
  let healthCloseTimer = null;

  function readHealth() {
    try {
      const parsed = JSON.parse(localStorage.getItem(HEALTH_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.filter((x) => x && "ok" in x) : [];
    } catch (e) {
      return [];
    }
  }

  /* a successful instance check is a health sample too, so the graph fills in
     over visits without a single extra request. One sample a minute is enough. */
  function recordHealth(ok) {
    const history = readHealth();
    const last = history[history.length - 1];
    if (last && Date.now() - last.t < 60000 && last.ok === ok) return history;
    return pushHealth(ok);
  }

  function pushHealth(ok) {
    const history = readHealth();
    history.push({ t: Date.now(), ok: !!ok });
    while (history.length > 480) history.shift();
    try { localStorage.setItem(HEALTH_KEY, JSON.stringify(history)); } catch (e) {}
    return history;
  }

  const CALM = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function clockStamp(t) {
    const d = new Date(t);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  /* Only the newest bar arrives with a rise; the rest are already there.
     Replaying the whole stagger every minute made a quiet graph look busy. */
  let healthSig = "";
  function renderHealthBars(history) {
    const strip = dom.hpStrip;
    if (!strip) return;
    const sig = history.map((x) => x.t + (x.ok === true ? "+" : x.ok === false ? "-" : "?")).join("|");
    if (sig && sig === healthSig) return;   // nothing new: leave the bars alone
    healthSig = sig;
    const recent = history.slice(-7);
    const pad = Math.max(0, 7 - recent.length);
    strip.innerHTML = "";
    for (let i = 0; i < pad; i += 1) {
      const empty = el("span", { class: "hp-bar", "data-empty": "true" });
      empty.title = "no sample yet";
      strip.appendChild(empty);
    }
    recent.forEach((entry, i) => {
      const bar = el("span", { class: "hp-bar" });
      const ok = entry.ok === true ? "true" : (entry.ok === false ? "false" : "unknown");
      bar.dataset.ok = ok;
      bar.dataset.live = i === recent.length - 1 ? "true" : "false";
      bar.title = clockStamp(entry.t) + " · " +
        (ok === "true" ? "answered" : ok === "false" ? "unreachable" : "no answer");
      if (i === recent.length - 1 && typeof bar.animate === "function" && !CALM) {
        bar.animate(
          [{ transform: "scaleY(0.18)", opacity: 0 }, { transform: "scaleY(1)", opacity: 1 }],
          { duration: 320, easing: "cubic-bezier(.22,.8,.3,1)", fill: "both" }
        );
      }
      strip.appendChild(bar);
    });

    const counted = history.filter((x) => x.ok === true || x.ok === false);
    const total = counted.length;
    const up = counted.filter((x) => x.ok === true).length;
    if (dom.hpPct) {
      dom.hpPct.textContent = total ? Math.round((up / total) * 1000) / 10 + "%" : "n/a";
    }
    if (dom.hpChecks) {
      dom.hpChecks.textContent = total
        ? compactCount(total) + " check" + (total === 1 ? "" : "s")
        : "no log yet";
    }
  }

  /* The popover used to draw one bar per time you opened it, which is why a
     private window showed "2 checks" and a well-used browser showed 300. The
     graph is the server's own log now; local samples are only the fallback when
     the server has nothing to say. */
  async function renderServerMini(endpoint) {
    const base = String(endpoint || "").replace(/\/+$/, "");
    if (!base) return false;
    try {
      const res = await fetch(base + "/uptime", {
        headers: { Accept: "application/json" },
        cache: "no-store"
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (!data || !Array.isArray(data.days)) return false;
      const days = data.days.slice(-30);
      const measured = days.filter((d) => d && d.total);
      if (!measured.length) return false;
      /* the card shows the last seven calendar days. days before the log
         started are a hairline, which is honest and still fills the width. */
      const week = days.slice(-7);

      const strip = dom.hpStrip;
      if (strip) {
        const sig = "server:" + week.map((d) => (d ? d.date + d.up + d.total : "-")).join(",");
        if (sig !== healthSig) {
          healthSig = sig;
          strip.innerHTML = "";
          week.forEach((day, i) => {
            const bar = el("span", { class: "hp-bar" });
            if (!day || !day.total) {
              bar.dataset.empty = "true";
              bar.title = (day && day.date ? shortClock(day.date) + " · " : "") + "no checks";
            } else {
              const ratio = day.up / day.total;
              bar.dataset.ok = ratio >= 0.995 ? "true" : (ratio >= 0.97 ? "partial" : "false");
              bar.dataset.live = i === week.length - 1 ? "true" : "false";
              bar.title = shortClock(day.date) + " · " +
                Math.round(ratio * 1000) / 10 + "% of " + day.total.toLocaleString() + " checks";
            }
            strip.appendChild(bar);
          });
        }
      }
      if (dom.hpPct) {
        dom.hpPct.textContent = data.uptime === null || data.uptime === undefined
          ? "n/a"
          : Number(data.uptime).toFixed(1) + "%";
      }
      if (dom.hpChecks) {
        dom.hpChecks.textContent = compactCount(data.checks) +
          " check" + (Number(data.checks) === 1 ? "" : "s");
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  /* 3,283 checks is a sentence; 3.3k is a glance. one decimal, and a round
     thousand loses the .0 */
  function compactCount(value) {
    const n = Math.max(0, Math.round(Number(value) || 0));
    if (n < 1000) return String(n);
    return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  }

  function shortClock(date) {
    const parts = String(date || "").split("-");
    return parts.length === 3 ? parts[2] + "." + parts[1] : String(date || "");
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

  async function healthSample(endpoint) {
    try {
      const res = await fetch(endpoint + "health", {
        headers: Object.assign({ Accept: "application/json" }, authHeaders()),
        cache: "no-store"
      });
      const body = await res.json().catch(() => null);
      return {
        responded: true,
        limited: res.status === 429,
        ok: res.ok && (!body || body.status !== "degraded"),
        body
      };
    } catch (e) {
      return { responded: false, limited: false, ok: false, body: null };
    }
  }

  /* a server with no log keeps no graph: say that plainly instead of leaving
     the last numbers up or borrowing this browser's samples */
  function sayNoGraph() {
    if (dom.hpPct) dom.hpPct.textContent = "n/a";
    if (dom.hpChecks) dom.hpChecks.textContent = "no log yet";
  }

  async function checkHealth() {
    const endpoint = apiEndpoint();
    if (!endpoint) {
      setHealthState("bad", "not connected", "");
      renderHealthBars(readHealth());
      return;
    }
    /* the first look says "checking…". Every look after that keeps whatever it
       already knows and only pulses the dot: flipping the word once a minute
       is what made a healthy server look unstable */
    const known = dom.healthPop && dom.healthPop.dataset.state &&
      dom.healthPop.dataset.state !== "unknown";
    if (!known) setHealthState("checking", "checking…", "");
    else dom.healthPop.dataset.busy = "true";

    let sample;
    try {
      sample = await healthSample(endpoint);
      /* one retry: a deploy restarts the service for a second, and that is not
         an outage worth drawing in red */
      if (!sample.responded) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        sample = await healthSample(endpoint);
      }
    } finally {
      if (dom.healthPop) dom.healthPop.dataset.busy = "false";
    }

    if (sample.limited) {
      // 429 means the server answered; that is proof of life, not downtime
      if (!(await renderServerMini(endpoint))) sayNoGraph();
      setHealthState("ok", "online", "");
      return;
    }

    if (!sample.responded) {
      /* the server answered nothing: keep the week it gave us before, or the
         holding slots. this browser's samples are not a second opinion */
      if (!(await renderServerMini(endpoint))) sayNoGraph();
      setHealthState("bad", "unreachable", "");
      return;
    }

    if (!(await renderServerMini(endpoint))) sayNoGraph();
    const up = sample.body && Number(sample.body.uptimeSeconds)
      ? "up " + formatUptime(Date.now() - Number(sample.body.uptimeSeconds) * 1000)
      : "";
    setHealthState(sample.ok ? "ok" : "bad", sample.ok ? "online" : "down", up);
  }

  function startHealthTimer() {
    if (healthTimer) return;
    healthTimer = setInterval(() => {
      if (!healthOpen || document.hidden) return;
      checkHealth();
    }, 60000);
  }

  /* Every floating panel shares one counter: the last one you opened — or
     touched — is the last one painted. Two panels can stay open at once; they
     just stop fighting over which is in front. */
  /* above the tip veil (94) and the sheets (90), below a modal (100): the
     first panel to open clears every backdrop, and each one after it clears
     the last */
  let panelZ = 94;
  let frontPanel = null;
  function bringToFront(node) {
    if (!node) return;
    node.style.zIndex = String(++panelZ);
    frontPanel = node;
  }
  /* A panel that is already open but behind another one comes forward on the
     click that reaches for it, instead of closing as if you had dismissed it. */
  function raiseIfBehind(node) {
    if (!node || node.hidden || node === frontPanel) return false;
    bringToFront(node);
    return true;
  }
  document.addEventListener("pointerdown", (event) => {
    const panel = event.target && event.target.closest
      ? event.target.closest(".health-pop, .dock-panel, .tip-pop, .sources-panel")
      : null;
    if (panel) bringToFront(panel);
  }, true);

  function openHealthPop() {
    if (!dom.healthPop || healthOpen) return;
    if (tipOpen) closeTipPop(true);
    healthOpen = true;
    bringToFront(dom.healthPop);
    clearTimeout(healthCloseTimer);
    dom.healthPop.hidden = false;
    dom.healthPop.classList.remove("is-closing");
    if (dom.hpStrip) {
      dom.hpStrip.title = "one check a minute while this is open; the server keeps the 30-day graph";
    }
    dom.instancePill.setAttribute("aria-expanded", "true");
    /* one graph, drawn once. this browser's samples used to paint first and
       then get replaced by the server's week a beat later, which read as extra
       bars arriving and then vanishing. seven holding slots take the space
       until the real week lands. */
    if (dom.hpStrip && !String(healthSig).startsWith("server:")) {
      healthSig = "holding";
      dom.hpStrip.innerHTML = "";
      for (let i = 0; i < 7; i += 1) {
        dom.hpStrip.appendChild(el("span", { class: "hp-bar", "data-empty": "true" }));
      }
    }
    checkHealth();
    startHealthTimer();
  }

  function closeHealthPop() {
    if (!dom.healthPop || !healthOpen) return;
    healthOpen = false;
    dom.healthPop.classList.add("is-closing");
    healthCloseTimer = setTimeout(() => {
      dom.healthPop.hidden = true;
      dom.healthPop.classList.remove("is-closing");
      /* collapse the label when the panel actually leaves: reporting it closed
         for 120ms while it is still on screen is a lie the DOM can be caught in */
      dom.instancePill.setAttribute("aria-expanded", "false");
    }, 120);
  }

  function bindSheet() {
    $("#open-settings").addEventListener("click", () => openSettings());
    dom.setupOpenSettings.addEventListener("click", () => openSettings("instance"));
    /* the dot is the connection: click for a miniature of the status page,
       the gear is still the way into the settings */
    const settingsDonate = $("#open-donate-settings");
    /* a plain link to the page: the jar in Settings should not open a second
       panel inside a panel */

    /* the hint is a shortcut: press it, get the link to this site on the
       clipboard, ready to paste into a message */
    if (dom.composerNote) {
      let noteTimer = 0;
      dom.composerNote.addEventListener("click", async () => {
        /* the confirmation appears where the press happened; no toast repeats it */
        const ok = await copyText("https://mdown.cc", "link copied", true);
        if (!ok) return;
        dom.composerNote.classList.add("is-copied");
        if (dom.copyStatus) dom.copyStatus.textContent = "link copied";
        clearTimeout(noteTimer);
        noteTimer = setTimeout(() => {
          dom.composerNote.classList.remove("is-copied");
          if (dom.copyStatus) dom.copyStatus.textContent = "";
        }, 1100);
      });
    }

    const mbarSettings = $("#mbar-settings");
    if (mbarSettings) mbarSettings.addEventListener("click", () => {
      if (donateTab) setDonateTab(false);
      if (!dom.sheet.hidden) closeSettings();
      else openSettings();
    });
    /* anything in the app that says "donate" opens the tab on a phone: the
       settings row and the help dialog used to launch a second document */
    document.addEventListener("click", (event) => {
      const link = event.target.closest ? event.target.closest('a[href="donate.html"]') : null;
      if (!link || link.id === "mbar-donate" || !PHONE()) return;
      event.preventDefault();
      if (dom.modal && !dom.modal.hidden) closeModal();
      if (!dom.sheet.hidden) closeSettings();
      openDonateTab();
    });

    const mbarDonate = $("#mbar-donate");
    if (mbarDonate) mbarDonate.addEventListener("click", (event) => {
      if (!PHONE()) return;              /* a desktop keeps the real page */
      event.preventDefault();
      if (donateTab) setDonateTab(false);
      else openDonateTab();
    });
    /* whichever tab you press, the transient one you were in gets out of the
       way first: one tap, one destination, no stacked surfaces */
    const barNode = document.querySelector(".mobile-bar");
    if (barNode) barNode.addEventListener("click", (event) => {
      const item = event.target.closest(".mbar-item");
      if (!item) return;
      if (tipOpen) closeTipPop(true);
      if (item.id !== "mbar-settings" && !dom.sheet.hidden) closeSettings();
      if (item.id !== "mbar-donate" && donateTab) setDonateTab(false);
    }, true);
    const mbarQueue = $("#mbar-queue");
    if (mbarQueue) mbarQueue.addEventListener("click", (event) => {
      event.stopPropagation();   /* or the outside-click handler closes it again */
      /* "downloads" is the way home: from a tool it returns to the page you
         download from, and only on that page does it open the list */
      const view = document.body.dataset.view || "download";
      if (view !== "download") {
        if (dockOpen) setDock(false);
        location.hash = "";
        return;
      }
      setDock(!dockOpen);
    });

    dom.instancePill.addEventListener("click", (event) => {
      event.stopPropagation();
      if (healthOpen) {
        if (raiseIfBehind(dom.healthPop)) return;
        closeHealthPop();
      } else openHealthPop();
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
      if (event.key === "Escape" && dockOpen) setDock(false);
      if (event.key === "Escape" && healthOpen) {
        closeHealthPop();
        dom.instancePill.focus();
      }
    });

    /* following a chip leaves this page behind: close the panel so coming back
       shows the downloader, not the list again */
    if (dom.sourcesPanel) {
      dom.sourcesPanel.addEventListener("click", (event) => {
        if (event.target.closest && event.target.closest(".source-chip")) closeSources();
      });
    }

    /* building the list on the way in makes the click itself instant */
    if (dom.openSources) {
      dom.openSources.addEventListener("pointerenter", () => {
        if (!dom.sourcesPanel.firstChild) renderSources();
      }, { passive: true });
    }

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
      const veil = document.getElementById("sources-veil");
      if (veil) veil.addEventListener("click", () => closeSources());
    }

    if (dom.openHealth) {
      dom.openHealth.addEventListener("click", (event) => {
        const base = normalizeInstance(settings.instance);
        if (!base) { event.preventDefault(); return; }
        dom.openHealth.href = base.replace(/\/+$/, "") + "/health";
      });
    }

    $$("#open-help, #open-help-top").forEach((button) => {
      button.addEventListener("click", openHelp);
    });
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
      if (seen.has(host) || seen.size >= 4) return;
      seen.add(host);
      const detected = detectService(url);
      const mark = markForService(detected && detected.id);
      const item = el("button", { type: "button", class: "recent-item" });
      item.innerHTML = '<span class="recent-mark">' + mark + "</span><span>" + escapeHtml(host) + "</span>";
      item.title = url;
      item.addEventListener("click", () => {
        dom.input.value = url;
        updateComposerState();
        dom.input.focus();
      });
      dom.recent.appendChild(item);
    });

    const clear = el("button", {
      type: "button",
      class: "recent-clear",
      text: "clear",
      "aria-label": "clear recent links"
    });
    clear.addEventListener("click", () => {
      recentLinks = [];
      try {
        localStorage.removeItem(HISTORY_KEY);
        /* and every key this page ever wrote under an older name: a leftover
           one gets migrated back in on the next visit, so clearing looked like
           it worked on this machine only */
        LEGACY_HISTORY_KEYS.forEach((key) => localStorage.removeItem(key));
      } catch (e) {}
      renderHistory();
      toast("Recent links cleared", "ok");
    });
    dom.recent.appendChild(clear);
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
      /* once there is a link the same button is the download button */
      if (dom.pasteBtn.dataset.state === "get") {
        submitUrls(dom.input.value);
        return;
      }
      const blocked = IS_TOUCH
        ? "Clipboard is blocked here. Tap and hold the field to paste."
        : "Clipboard is blocked here. Press ⌘V to paste.";
      if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") {
        toast(blocked, "warn");
        focusForPaste();
        return;
      }
      try {
        const text = await navigator.clipboard.readText();
        if (!text) { toast("Clipboard is empty.", "warn"); return; }
        /* paste fills the field and stops there: there is time to check the
           mode and quality before anything starts */
        dom.input.value = text;
        updateComposerState();
        dom.input.focus();
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
        modePicked = true;
        autoAudio = false;
        settings.downloadMode = btn.dataset.mode;
        saveSettings();
        renderModes();
        updateComposerState();
      });
    });

    dom.clearFinished.addEventListener("click", clearFinished);

    if (dom.queueClose) dom.queueClose.addEventListener("click", () => setDock(false));

    /* nav.js flips the active class on a hash change; this reads it a tick
       later and moves the glider to wherever it landed */
    window.addEventListener("hashchange", () => {
      syncBarGlider();
      setTimeout(() => syncBarGlider(), 60);
    });
    window.addEventListener("resize", () => {
      syncBarGlider(true);
      if (donateTab) placeDonateFrame();
    });
    window.addEventListener("orientationchange", () => setTimeout(() => {
      syncBarGlider(true);
      if (donateTab) placeDonateFrame();
    }, 120));
    if (dom.miniDock) dom.miniDock.addEventListener("click", (event) => {
      event.stopPropagation();
      /* when the row is ready, the dock IS the download button */
      if (miniFocus && miniFocus.status === "ready") {
        const item = miniFocus;
        if (settings.savingMethod === "share" && item.blob) {
          shareItem(item, true).then((shared) => { if (!shared) saveBlob(item); });
        } else {
          saveBlob(item);
        }
        return;
      }
      setDock(true);
    });

    if (dom.queueToggle) {
      dom.queueToggle.addEventListener("click", (event) => {
        event.stopPropagation();
        if (dockOpen) {
          if (raiseIfBehind(dom.queuePanel)) return;
          setDock(false);
          return;
        }
        setDock(true);
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
    /* a TV remote has no pointer: focusing the field there opens an on-screen
       keyboard over the page before anyone asked for one */
    if (window.matchMedia && window.matchMedia("(pointer: none)").matches) return;
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


  /* ----------------------------------------------------------
     history
     ---------------------------------------------------------- */
  /* ----------------------------------------------------------
     composer events
     ---------------------------------------------------------- */
  /* ----------------------------------------------------------
     boot
     ---------------------------------------------------------- */
  /* The field is the only thing this page is for, so it owns the caret. Select,
     not just focus: typing replaces whatever is there instead of appending. */
  /* remux.js + tools.js are 39 KB of wasm plumbing and nothing on the
     download view touches them, so they load when a tool is opened (or when
     the pointer says one is about to be) */
  let toolsPromise = null;
  function loadTools() {
    if (toolsPromise) return toolsPromise;
    const add = (src) => new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.type = "module";
      script.src = src;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
    toolsPromise = add("assets/remux.js?v=8").then(() => add("assets/tools.js?v=8"));
    return toolsPromise;
  }

  function toolsWanted() {
    if (/^#(remux|subs|clean)$/.test(location.hash)) loadTools();
  }

  function warmTools() {
    toolsWanted();
    window.addEventListener("hashchange", toolsWanted);
    $$(".tool-card").forEach((card) => {
      const warm = () => loadTools();
      card.addEventListener("mouseenter", warm, { once: true });
      card.addEventListener("focus", warm, { once: true });
      card.addEventListener("touchstart", warm, { once: true, passive: true });
    });
  }

  /* ----------------------------------------------------------
     the phone bar's selection
     ---------------------------------------------------------- */
  /* One object moves between four boxes, the way the mode switch does: the
     order of the bar never changes, so the eye follows the thing that does. */
  let barGlidedOnce = false;

  function barGliderTarget() {
    const bar = document.querySelector(".mobile-bar");
    if (!bar) return null;
    const items = Array.from(bar.querySelectorAll(".mbar-item"));
    return items.find((el) => el.getAttribute("data-tab-active") === "true")
        || items.find((el) => el.getAttribute("aria-expanded") === "true")
        || items.find((el) => el.classList.contains("is-active"))
        || null;
  }

  function syncBarGlider(instant) {
    const bar = document.querySelector(".mobile-bar");
    const glider = document.getElementById("mbar-glider");
    if (!bar || !glider) return;
    const target = barGliderTarget();
    for (const item of bar.querySelectorAll(".mbar-item")) {
      if (item === target) item.setAttribute("data-front", "true");
      else item.removeAttribute("data-front");
    }
    if (!target) { glider.classList.remove("is-on"); return; }
    const barBox = bar.getBoundingClientRect();
    const box = target.getBoundingClientRect();
    const left = barBox.left + bar.clientLeft;
    const top = barBox.top + bar.clientTop;
    glider.style.setProperty("--x", (box.left - left).toFixed(1) + "px");
    glider.style.setProperty("--y", (box.top - top).toFixed(1) + "px");
    glider.style.setProperty("--w", box.width.toFixed(1) + "px");
    glider.style.setProperty("--h", box.height.toFixed(1) + "px");
    if (!barGlidedOnce || instant) {
      /* the first placement must not fly in from the left edge */
      barGlidedOnce = true;
      glider.classList.add("is-instant");
      glider.classList.add("is-on");
      requestAnimationFrame(() => glider.classList.remove("is-instant"));
    } else {
      glider.classList.add("is-on");
    }
  }

  /* ----------------------------------------------------------
     the phone bar is four tabs: the page, the tool, settings and the tip jar.
     settings stops above the bar, and the tip page opens inside the app, so
     the bar never disappears and the lit tab always says where you are.
     ---------------------------------------------------------- */
  const PHONE = () => window.matchMedia("(max-width: 720px), (hover: none) and (max-height: 520px)").matches;
  let donateTab = false;

  function placeDonateFrame() {
    const frame = $("#donate-frame");
    const topbar = document.querySelector(".topbar");
    if (frame && topbar) {
      frame.style.setProperty("--tab-top", Math.round(topbar.getBoundingClientRect().bottom) + "px");
    }
  }

  function setDonateTab(on) {
    const frame = $("#donate-frame");
    const item = $("#mbar-donate");
    if (!frame || !item || on === donateTab) return;
    donateTab = on;
    if (on) {
      if (!frame.dataset.loaded) {
        const iframe = frame.querySelector("iframe");
        if (iframe) iframe.src = "donate.html?embed=1";
        frame.dataset.loaded = "1";
      }
      placeDonateFrame();
      frame.hidden = false;
      document.body.classList.add("tab-frame-open");
      item.setAttribute("data-tab-active", "true");
      item.setAttribute("aria-current", "page");
    } else {
      frame.hidden = true;
      document.body.classList.remove("tab-frame-open");
      item.removeAttribute("data-tab-active");
      item.removeAttribute("aria-current");
    }
    syncBarGlider();
  }

  function openDonateTab() {
    if (healthOpen) closeHealthPop();
    if (!dom.sheet.hidden) closeSettings();
    if (dockOpen) setDock(false);
    /* the tip popover has its own "all the ways to give" link: leaving it up
       would open the tab underneath the sheet you just pressed */
    if (tipOpen) closeTipPop();
    setDonateTab(true);
  }

  function boot() {
    /* and the page arrives where it was painted: no scroll jump on reload */
    try {
      if (!location.hash && window.scrollY > 0) window.scrollTo(0, 0);
    } catch (e) {}
    renderDonate();
    bindBoard();
    bindTip();
    /* build the sources list while the page is idle, so the first tap on a
       phone opens instantly instead of assembling twenty links */
    if ("requestIdleCallback" in window) {
      requestIdleCallback(() => renderSources(), { timeout: 2500 });
    } else {
      setTimeout(() => renderSources(), 1500);
    }
    warmTools();
    applyTheme();
    reflectSettings();
    bindSettings();
    bindSheet();
    bindComposer();
    renderHistory();
    renderQueue();
    syncBarGlider(true);
    /* nav.js is a module: it applies the active class a moment after boot */
    setTimeout(() => syncBarGlider(true), 90);
    window.addEventListener("load", () => syncBarGlider(true));
    updateComposerState();
    checkInstance({ silent: true });
    autosize();
    focusComposer();

    /* coming back to the tab puts the caret back where you left it — the same
       thing as arriving for the first time */
    document.addEventListener("keydown", (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = (document.activeElement && document.activeElement.tagName) || "";
      const typing = /INPUT|TEXTAREA|SELECT/.test(tag);
      if (event.key === "/" && !typing) {
        event.preventDefault();
        focusComposer();
        return;
      }
      if (event.key === "?" && !typing) {
        event.preventDefault();
        openHelp();
      }
    });

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
      positionModeGlider();
    });

    if (location.hash === "#help") openHelp();
    window.addEventListener("hashchange", () => {
      if (location.hash === "#help") openHelp();
    });

  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    /* boot() already paints the recent strip in the first frame; calling it
       again here built the same list twice */
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
        url: i.url,
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
