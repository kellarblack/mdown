/* ============================================================
   Remux — local, lossless container rewriting with ffmpeg.wasm.
   Files never leave the device: bytes go into the WASM filesystem,
   get remuxed there, and come back as a Blob.
   ============================================================ */

const BASE = new URL("./vendor/ffmpeg/", import.meta.url).href;

const MIME = {
  mp4: "video/mp4",
  m4a: "audio/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav"
};

/* ---------- small helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs, text) => {
  const node = document.createElement(tag);
  if (attrs) {
    for (const key in attrs) {
      if (key === "class") node.className = attrs[key];
      else if (key === "html") node.innerHTML = attrs[key];
      else node.setAttribute(key, attrs[key]);
    }
  }
  if (text != null) node.textContent = text;
  return node;
};
const bytes = (n) => {
  if (!n && n !== 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = n, i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return (value < 10 && i > 0 ? value.toFixed(1) : Math.round(value)) + " " + units[i];
};
const ascii = (u8, start, len) => String.fromCharCode(...u8.subarray(start, start + len));

/* ---------- container sniffing (cheap, no decode) ---------- */
function sniff(u8, name) {
  if (u8.length < 16) return null;
  const head = ascii(u8, 0, 12);

  if (head.slice(4, 8) === "ftyp") {
    const brand = ascii(u8, 8, 4).replace(/\0/g, "");
    const audioOnly = /m4a|m4b|M4A/.test(brand) || /\.(m4a|aac)$/i.test(name);
    return { container: audioOnly ? "m4a" : "mp4", ext: audioOnly ? "m4a" : "mp4" };
  }
  if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) {
    const doc = ascii(u8, 0, Math.min(u8.length, 64));
    return { container: doc.includes("webm") ? "webm" : "mkv", ext: doc.includes("webm") ? "webm" : "mkv" };
  }
  if (head.slice(0, 4) === "OggS") {
    const window = ascii(u8, 0, Math.min(u8.length, 96));
    return { container: window.includes("OpusHead") ? "opus" : "ogg", ext: window.includes("OpusHead") ? "opus" : "ogg" };
  }
  if (head.slice(0, 4) === "RIFF" && head.slice(8, 12) === "WAVE") return { container: "wav", ext: "wav" };
  if (head.slice(0, 3) === "ID3" || (u8[0] === 0xff && (u8[1] & 0xe0) === 0xe0)) return { container: "mp3", ext: "mp3" };
  if (head.slice(0, 4) === "fLaC") return { container: "flac", ext: "flac" };
  return null;
}

function hasBytes(u8, text, limit) {
  const end = Math.min(u8.length, limit || u8.length) - text.length;
  for (let i = 0; i <= end; i++) {
    let match = true;
    for (let j = 0; j < text.length; j++) {
      if (u8[i + j] !== text.charCodeAt(j)) { match = false; break; }
    }
    if (match) return true;
  }
  return false;
}

function outputLooksValid(u8, container) {
  if (!u8 || u8.length < 512) return false;
  const head = ascii(u8, 0, 12);
  if (container === "mp4" || container === "m4a") {
    /* faststart puts the index near the front; require it, not just a brand */
    return head.slice(4, 8) === "ftyp" && hasBytes(u8, "moov", 4 * 1024 * 1024);
  }
  if (container === "webm" || container === "mkv") return u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3;
  if (container === "ogg" || container === "opus") return head.slice(0, 4) === "OggS";
  if (container === "wav") return head.slice(0, 4) === "RIFF";
  if (container === "mp3") return head.slice(0, 3) === "ID3" || (u8[0] === 0xff && (u8[1] & 0xe0) === 0xe0);
  return false;
}

/* ---------- engine ---------- */
const engine = {
  instance: null,
  loading: null,
  logs: [],
  active: null,

  async get() {
    if (this.instance) return this.instance;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      const { FFmpeg } = await import(BASE + "ffmpeg/index.js");
      const ff = new FFmpeg();
      ff.on("log", ({ message }) => {
        this.logs.push(message);
        if (this.logs.length > 300) this.logs.shift();
      });
      ff.on("progress", ({ progress }) => {
        const item = this.active;
        if (!item) return;
        const value = Number(progress);
        if (!Number.isFinite(value) || value <= 0) return;
        item.progress = Math.min(1, Math.max(0, value));
        item.indeterminate = false;
        paint(item);
      });
      await ff.load({
        coreURL: BASE + "core/ffmpeg-core.js",
        wasmURL: BASE + "core/ffmpeg-core.wasm"
      });
      this.instance = ff;
      return ff;
    })();

    try {
      return await this.loading;
    } catch (err) {
      this.loading = null;
      throw err;
    }
  },

  kill() {
    if (this.instance) {
      try { this.instance.terminate(); } catch {}
    }
    this.instance = null;
    this.loading = null;
    this.active = null;
  }
};

/* ---------- state ---------- */
const items = [];
let idCounter = 0;
let running = false;
let cancelled = false;

/* ---------- format knowledge ---------- */
const TARGET_EXT = { mp4: "mp4", m4a: "m4a", webm: "webm", mkv: "mkv", ogg: "ogg", opus: "opus", mp3: "mp3", wav: "wav" };

function chooseTarget(source, probe) {
  const c = source.container;
  if (c === "mp4") return probe.video ? "mp4" : "m4a";
  if (c === "m4a") return "m4a";
  if (c === "webm") return "webm";
  if (c === "ogg" || c === "opus") return probe.codecAudio === "opus" ? "opus" : "ogg";
  if (c === "mp3") return "mp3";
  if (c === "wav") return "wav";
  if (c === "mkv") {
    if (probe.videoCodec === "h264" || probe.videoCodec === "hevc" || probe.videoCodec === "av1") return "mp4";
    return "mkv";
  }
  return c;
}

function argsFor(target, input, output, dropExtras) {
  const maps = dropExtras ? ["-map", "0:v?", "-map", "0:a?"] : ["-map", "0"];
  const base = ["-hide_banner", "-y", "-fflags", "+genpts", "-i", input, ...maps, "-c", "copy"];
  if (target === "mp4" || target === "m4a") {
    return [...base, "-movflags", "+faststart", "-f", target === "m4a" ? "ipod" : "mp4", output];
  }
  if (target === "webm") return [...base, "-f", "webm", output];
  if (target === "mkv") return [...base, "-f", "matroska", output];
  if (target === "ogg") return [...base, "-f", "ogg", output];
  if (target === "opus") return [...base, "-f", "ogg", output];
  if (target === "mp3") return [...base, "-f", "mp3", output];
  if (target === "wav") return [...base, "-f", "wav", output];
  return [...base, output];
}

/* ---------- probe ---------- */
function parseProbe(lines) {
  const text = lines.join("\n");
  const result = {
    video: false, audio: false, videoCodec: "", codecAudio: "",
    duration: "", subtitles: 0, streams: []
  };
  const duration = text.match(/Duration: (\d+:\d+:\d+(?:\.\d+)?)/);
  if (duration) result.duration = duration[1];

  const streamRe = /Stream #0:(\d+)(?:\[[^\]]+\])?(?:\(([a-z]{2,3})\))?: (Video|Audio|Subtitle|Data|Attachment): ([A-Za-z0-9_]+)/;
  let current = null;
  for (const line of lines) {
    const match = streamRe.exec(line);
    if (match) {
      current = {
        index: Number(match[1]),
        type: match[3].toLowerCase(),
        codec: match[4],
        lang: match[2] || "",
        title: ""
      };
      result.streams.push(current);
      continue;
    }
    if (current && /^\s{2,}title\s*:/.test(line)) {
      current.title = line.replace(/^\s+title\s*:\s*/, "").trim();
    }
  }

  for (const stream of result.streams) {
    if (stream.type === "video" && !result.video) { result.video = true; result.videoCodec = stream.codec; }
    if (stream.type === "audio" && !result.audio) { result.audio = true; result.codecAudio = stream.codec; }
    if (stream.type === "subtitle") result.subtitles++;
  }
  return result;
}

/* ---------- error translation ---------- */
function explain(lines) {
  const text = lines.join("\n");
  if (/Could not find tag for codec/i.test(text)) {
    return "That codec can't go into this container. It would need a re-encode, which this tool doesn't do.";
  }
  if (/Invalid data found when processing input/i.test(text)) {
    return "The file looks corrupt, or the bytes inside don't match the extension.";
  }
  if (/Output file does not contain any stream/i.test(text)) {
    return "No audio or video streams were found in that file.";
  }
  if (/not currently supported in container/i.test(text)) {
    return "The target container doesn't accept one of these streams.";
  }
  if (/No space left|Cannot allocate memory|Aborted\(\)|out of memory/i.test(text)) {
    return "Ran out of memory. Try a smaller file, or close other tabs.";
  }
  if (/Permission denied/i.test(text)) return "The browser blocked access to that file.";
  if (/Unsupported codec|unknown codec/i.test(text)) return "That codec isn't supported by this build.";

  const tail = lines.slice().reverse().find((line) => /error|invalid|failed/i.test(line) && line.trim());
  return tail ? tail.replace(/^\[[^\]]+\]\s*/, "").slice(0, 180) : "Remux failed.";
}

/* ---------- UI ---------- */
const dom = {
  view: null,
  downloadView: null,
  dropzone: null,
  input: null,
  browse: null,
  list: null,
  empty: null,
  count: null,
  stats: null,
  clear: null,
  nav: [],
  section: null
};

function paint(item) {
  if (!item.node) return;
  const { node, refs } = item;
  node.dataset.status = item.status;
  node.dataset.indeterminate = item.indeterminate ? "true" : "false";
  node.setAttribute("aria-busy", item.status === "working" ? "true" : "false");

  if (refs.title.textContent !== item.name) refs.title.textContent = item.name;

  const parts = [];
  if (item.target) parts.push(item.target);
  if (item.size) parts.push(bytes(item.size));
  if (item.status === "working" && item.progress > 0) parts.push(Math.round(item.progress * 100) + "%");
  else if (item.status === "working") parts.push("working");
  else if (item.status === "done") parts.push("ready");
  else if (item.status === "cancelled") parts.push("cancelled");
  else if (item.status === "error") parts.push("failed");
  else parts.push("queued");

  const key = parts.join("|") + "|" + (item.error || "") + "|" + (item.note || "");
  if (refs.meta.dataset.key !== key) {
    refs.meta.dataset.key = key;
    refs.meta.innerHTML = "";
    parts.forEach((part, index) => {
      if (index) refs.meta.appendChild(el("span", { class: "rq-dot" }, " · "));
      refs.meta.appendChild(el("span", null, part));
    });
    if (item.note) refs.meta.appendChild(el("span", { class: "rq-warn" }, " · " + item.note));
    if (item.error) refs.meta.appendChild(el("span", { class: "rq-err" }, " · " + item.error));
  }

  refs.fill.style.width = (item.progress ? Math.round(item.progress * 100) : 0) + "%";
  refs.progress.setAttribute("role", "progressbar");
  refs.progress.setAttribute("aria-label", "Processing " + item.name);
  if (item.indeterminate) refs.progress.removeAttribute("aria-valuenow");
  else refs.progress.setAttribute("aria-valuenow", String(Math.round(item.progress * 100)));

  renderActions(item);
  updateSummary();
}

function icon(paths) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + paths + "</svg>";
}
const ICONS = {
  file: icon('<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/>'),
  working: '<span class="spinner"></span>',
  done: icon('<path d="M5 13l4.5 4.5L19 7"/>'),
  error: icon('<path d="M12 7v7"/><path d="M12 17.5h.01"/><circle cx="12" cy="12" r="9"/>'),
  cancelled: icon('<path d="M8 8l8 8M16 8l-8 8"/>'),
  download: icon('<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 19h14"/>'),
  remove: icon('<path d="M6 6l12 12M18 6 6 18"/>'),
  retry: icon('<path d="M20 11a8 8 0 1 0-2.6 6"/><path d="M20 5v6h-6"/>'),
  cancel: icon('<rect x="7" y="7" width="10" height="10" rx="1.5"/>')
};

function renderActions(item) {
  const box = item.refs.actions;
  box.innerHTML = "";
  const add = (svg, label, handler) => {
    const btn = el("button", { type: "button", class: "icon-btn", title: label, "aria-label": label });
    btn.innerHTML = svg;
    btn.addEventListener("click", handler);
    box.appendChild(btn);
  };

  if (item.status === "working" || item.status === "queued") {
    add(ICONS.cancel, "Cancel", () => cancelItem(item));
  }
  if (item.status === "done" && item.blobUrl) {
    add(ICONS.download, "Download", () => downloadItem(item));
  }
  if (item.status === "error" || item.status === "cancelled") {
    add(ICONS.retry, "Retry", () => retryItem(item));
  }
  add(ICONS.remove, "Remove", () => removeItem(item));
}

function buildNode(item) {
  const node = el("div", { class: "rqitem", "data-status": item.status });
  const iconBox = el("div", { class: "rq-icon", "aria-hidden": "true", html: ICONS.file });
  const body = el("div", { class: "rq-body" });
  const title = el("div", { class: "rq-title" });
  const meta = el("div", { class: "rq-meta" });
  const progress = el("div", { class: "rq-progress" });
  const fill = el("div", { class: "rq-fill" });
  const actions = el("div", { class: "rq-actions" });

  progress.appendChild(fill);
  body.appendChild(title);
  body.appendChild(meta);
  body.appendChild(progress);
  node.appendChild(iconBox);
  node.appendChild(body);
  node.appendChild(actions);

  item.node = node;
  item.refs = { icon: iconBox, title, meta, progress, fill, actions };
  paint(item);
  return node;
}

function updateIcon(item) {
  if (!item.refs) return;
  const next = ICONS[item.status] || ICONS.file;
  if (item.refs.icon.innerHTML !== next) item.refs.icon.innerHTML = next;
}

let lastCount = 0;

function updateSummary() {
  const total = items.length;
  if (dom.section) {
    if (total > 0 && lastCount === 0) dom.section.open = true;
    if (total === 0) dom.section.open = false;
  }
  lastCount = total;
  dom.count.textContent = String(total);
  dom.count.hidden = total === 0;
  dom.empty.hidden = total > 0;
  dom.clear.hidden = total === 0;

  const done = items.filter((i) => i.status === "done").length;
  const failed = items.filter((i) => i.status === "error").length;
  const working = items.filter((i) => i.status === "working").length;
  const parts = [];
  if (done) parts.push(done + " ready");
  if (working) parts.push(working + " working");
  if (failed) parts.push(failed + " failed");
  dom.stats.textContent = parts.join(" · ");
}

/* ---------- queue ---------- */
function addFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  for (const file of files) {
    const item = {
      id: "r" + ++idCounter,
      file,
      name: file.name,
      size: file.size,
      status: "queued",
      progress: 0,
      indeterminate: true,
      error: "",
      note: "",
      target: "",
      blobUrl: "",
      outName: "",
      probe: null,
      node: null,
      refs: null
    };
    items.push(item);
    dom.list.appendChild(buildNode(item));
  }
  updateSummary();
  pump();
}

async function pump() {
  if (running) return;
  const next = items.find((item) => item.status === "queued");
  if (!next) return;
  running = true;
  await processItem(next);
  running = false;
  pump();
}

function setStatus(item, status) {
  item.status = status;
  updateIcon(item);
  paint(item);
}

async function processItem(item) {
  if (item.cancelled) {
    setStatus(item, "cancelled");
    return;
  }

  setStatus(item, "working");
  item.indeterminate = true;
  item.progress = 0;
  engine.logs = [];
  engine.active = item;

  let ff = null;
  let inputName = "";
  let outputName = "";

  try {
    ff = await engine.get();
    if (item.cancelled) { setStatus(item, "cancelled"); return; }

    const buffer = new Uint8Array(await item.file.arrayBuffer());
    const sig = sniff(buffer, item.name);
    if (!sig) {
      throw new Error("That file isn't a media container this tool recognises.");
    }
    if (sig.container === "flac") {
      throw new Error("FLAC isn't supported here. Convert it to WAV or MP3 elsewhere first.");
    }

    inputName = "in_" + item.id + "." + sig.ext;
    await ff.writeFile(inputName, buffer);

    /* probe: real stream list, actual container */
    engine.logs = [];
    await ff.exec(["-hide_banner", "-i", inputName]).catch(() => {});
    const probe = parseProbe(engine.logs);
    if (!probe.video && !probe.audio) {
      throw new Error("No audio or video streams found. It may be corrupt or not a media file.");
    }
    item.probe = probe;

    const target = chooseTarget(sig, probe);
    item.target = target;
    outputName = "out_" + item.id + "." + TARGET_EXT[target];
    paint(item);

    engine.logs = [];
    item.indeterminate = true;
    let code = await ff.exec(argsFor(target, inputName, outputName));
    if (item.cancelled) { setStatus(item, "cancelled"); return; }

    /* subtitle/data streams the target container can't hold: keep the media, say so */
    if (code !== 0 && probe.subtitles > 0 && /tag for codec|not currently supported in container/i.test(engine.logs.join("\n"))) {
      engine.logs = [];
      code = await ff.exec(argsFor(target, inputName, outputName, true));
      if (code === 0) item.note = "subtitle streams dropped (" + target + " can't hold them)";
      if (item.cancelled) { setStatus(item, "cancelled"); return; }
    }
    if (code !== 0) throw new Error(explain(engine.logs));

    const out = await ff.readFile(outputName);
    if (!out || !out.length) throw new Error("The remux produced an empty file.");
    if (!outputLooksValid(out, target)) throw new Error("The output didn't validate as a " + target + " file.");

    const blob = new Blob([out], { type: MIME[target] || "application/octet-stream" });
    item.blobUrl = URL.createObjectURL(blob);
    item.outName = outputNameFor(item.name, target);
    item.sizeOut = blob.size;
    item.indeterminate = false;
    item.progress = 1;
    setStatus(item, "done");
  } catch (err) {
    if (item.cancelled) {
      setStatus(item, "cancelled");
    } else {
      item.error = friendly(err);
      setStatus(item, "error");
    }
  } finally {
    engine.active = null;
    try {
      if (ff && inputName) await ff.deleteFile(inputName);
      if (ff && outputName) await ff.deleteFile(outputName);
    } catch {}
  }
}

function friendly(err) {
  const message = err && err.message ? String(err.message) : "Remux failed.";
  if (/not a function|Failed to fetch|dynamically imported module|Worker/i.test(message)) {
    return "The media engine couldn't start. Check your connection and reload.";
  }
  return message;
}

function outputNameFor(name, target) {
  const base = name.replace(/\.[^./\\]+$/, "") || "file";
  return base + "-remuxed." + (TARGET_EXT[target] || target);
}

function cancelItem(item) {
  if (item.status === "queued") {
    item.cancelled = true;
    setStatus(item, "cancelled");
    return;
  }
  if (item.status !== "working") return;
  item.cancelled = true;
  engine.kill();
  setStatus(item, "cancelled");
  item.indeterminate = false;
  paint(item);
}

function retryItem(item) {
  if (item.blobUrl) { URL.revokeObjectURL(item.blobUrl); item.blobUrl = ""; }
  item.error = "";
  item.note = "";
  item.progress = 0;
  item.indeterminate = true;
  item.cancelled = false;
  item.sizeOut = 0;
  setStatus(item, "queued");
  pump();
}

function removeItem(item) {
  if (item.status === "working") cancelItem(item);
  if (item.blobUrl) URL.revokeObjectURL(item.blobUrl);
  const index = items.indexOf(item);
  if (index >= 0) items.splice(index, 1);
  if (item.node) item.node.remove();
  updateSummary();
}

function downloadItem(item) {
  if (!item.blobUrl) return;
  const link = el("a", { href: item.blobUrl, download: item.outName });
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function clearQueue() {
  items.slice().forEach((item) => removeItem(item));
}

/* ---------- wiring ---------- */
function init() {
  dom.view = $("#remux-view");
  dom.dropzone = $("#dropzone");
  dom.input = $("#remux-input");
  dom.browse = $("#browse-btn");
  dom.list = $("#remux-list");
  dom.empty = $("#remux-empty");
  dom.count = $("#remux-count");
  dom.stats = $("#remux-stats");
  dom.clear = $("#remux-clear");
  dom.section = $("#remux-section");

  if (!dom.view) return;

  const privacy = $(".remux-privacy", dom.view);
  if (privacy) {
    privacy.textContent =
      "Files are processed on this device. Nothing is uploaded, and nothing is kept after you leave the page.";
  }

  const openPicker = () => dom.input.click();
  dom.browse.addEventListener("click", (event) => { event.stopPropagation(); openPicker(); });
  dom.dropzone.addEventListener("click", openPicker);
  dom.dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openPicker(); }
  });
  dom.input.addEventListener("change", () => {
    addFiles(dom.input.files);
    dom.input.value = "";
  });

  let depth = 0;
  dom.dropzone.addEventListener("dragenter", (event) => {
    event.preventDefault(); depth++; dom.dropzone.classList.add("is-dragging");
  });
  dom.dropzone.addEventListener("dragover", (event) => { event.preventDefault(); });
  dom.dropzone.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) dom.dropzone.classList.remove("is-dragging");
  });
  dom.dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    depth = 0;
    dom.dropzone.classList.remove("is-dragging");
    addFiles(event.dataTransfer && event.dataTransfer.files);
  });
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => {
    if (dom.view.hidden) return;
    if (dom.dropzone.contains(event.target)) return;
    event.preventDefault();
    addFiles(event.dataTransfer && event.dataTransfer.files);
  });

  dom.clear.addEventListener("click", clearQueue);

  if (dom.section) {
    dom.section.querySelectorAll(".section-actions").forEach((box) => {
      box.addEventListener("click", (event) => event.stopPropagation());
    });
  }

  updateSummary();

  window.addEventListener("pagehide", () => {
    engine.kill();
    items.forEach((item) => { if (item.blobUrl) URL.revokeObjectURL(item.blobUrl); });
  });
}

init();

/* expose a tiny hook for tests */
window.remuxTool = {
  items,
  addFiles,
  clearQueue,
  processItem,
  engine,
  sniff,
  parseProbe,
  outputNameFor,
  explain,
  state: () => items.map((i) => ({
    name: i.name, status: i.status, target: i.target, outName: i.outName,
    size: i.size, sizeOut: i.sizeOut, error: i.error, progress: i.progress
  }))
};
