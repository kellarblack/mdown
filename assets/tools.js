/* ============================================================
   Two small local tools: subtitle extraction and metadata stripping.
   Both borrow the ffmpeg.wasm instance that the remux tool loads,
   so there is one engine, one download, one memory budget.
   ============================================================ */

const engineTools = () => window.remuxTool;

const TEXT_SUBS = new Set([
  "subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text",
  "microdvd", "subviewer", "subviewer1", "sami", "realtext",
  "jacosub", "mpl2", "pjs", "vplayer", "eia_608", "subtext"
]);

const TECHNICAL_TAGS = new Set([
  "major_brand", "minor_version", "compatible_brands",
  "encoder", "handler_name", "vendor_id"
]);

const IMAGE_SUBS = new Set([
  "hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub", "dvb_teletext", "dvdsub", "pgssub"
]);

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

const baseName = (name) => (name || "file").replace(/\.[^./\\]+$/, "") || "file";

const safe = (text) => String(text || "").replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim();

async function probe(ff, filename, logLines) {
  T().engine.logs.length = 0;
  await ff.exec(["-hide_banner", "-i", filename]).catch(() => {});
  return T().parseProbe(T().engine.logs.slice());
}

function T() {
  return engineTools();
}

function engineReady() {
  return !!(engineTools() && engineTools().engine);
}

function wireDropzone(drop, input, browseText, onFile) {
  const zone = typeof drop === "string" ? $(drop) : drop;
  const field = typeof input === "string" ? $(input) : input;
  if (!zone || !field) return;

  const open = () => field.click();
  zone.addEventListener("click", open);
  zone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
  });
  field.addEventListener("change", () => {
    if (field.files && field.files[0]) onFile(field.files[0]);
    field.value = "";
  });

  let depth = 0;
  zone.addEventListener("dragenter", (event) => {
    event.preventDefault(); depth++; zone.classList.add("is-dragging");
  });
  zone.addEventListener("dragover", (event) => event.preventDefault());
  zone.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) zone.classList.remove("is-dragging");
  });
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    depth = 0;
    zone.classList.remove("is-dragging");
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) onFile(file);
  });
}

function fileSummary(name, size, probeInfo) {
  const bits = [name, bytes(size)];
  if (probeInfo) {
    const types = probeInfo.streams.map((s) => s.type).filter((t, i, a) => a.indexOf(t) === i);
    if (types.length) bits.push(types.join(" + "));
    if (probeInfo.duration) bits.push(probeInfo.duration);
  }
  return bits.join(" · ");
}

/* ============================================================
   subtitles
   ============================================================ */

const subs = {
  file: null,
  input: "",
  probe: null,
  cache: "",
  busy: false,
  urls: [],
  outputs: []
};

function subsReset() {
  const ff = T() && T().engine.instance;
  if (ff && subs.input) ff.deleteFile(subs.input).catch(() => {});
  subs.urls.forEach((url) => URL.revokeObjectURL(url));
  subs.urls = [];
  subs.outputs = [];
  subs.file = null;
  subs.input = "";
  subs.probe = null;
  subs.cache = "";

  $("#subs-panel").hidden = true;
  $("#subs-outputs").innerHTML = "";
  $("#subs-tracks").innerHTML = "";
  $("#subs-file").textContent = "";
  $("#subs-note").hidden = true;
  $("#subs-extract").disabled = true;
}

function subsNote(text, tone) {
  const node = $("#subs-note");
  node.textContent = text || "";
  node.hidden = !text;
  node.dataset.tone = tone || "";
}

async function subsPick(file) {
  if (!engineReady()) {
    subsNote("The media engine didn't load. Reload the page and try again.", "err");
    $("#subs-panel").hidden = false;
    return;
  }
  const key = file.name + ":" + file.size + ":" + file.lastModified;
  if (subs.cache === key) return;

  subsReset();
  $("#subs-panel").hidden = false;
  $("#subs-file").textContent = fileSummary(file.name, file.size, null);
  subsNote("Reading the file…");

  try {
    const ff = await T().engine.get();
    const buffer = new Uint8Array(await file.arrayBuffer());
    const sig = T().sniff(buffer, file.name);
    if (!sig || sig.container === "flac") {
      throw new Error("That file isn't a container this tool can read.");
    }
    subs.input = "subs_" + Date.now() + "." + sig.ext;
    await ff.writeFile(subs.input, buffer);
    const info = await probe(ff, subs.input);
    subs.file = file;
    subs.probe = info;
    subs.cache = key;
    subsNote("");
    $("#subs-file").textContent = fileSummary(file.name, file.size, info);
    renderTracks(info);
  } catch (err) {
    subsNote(err && err.message ? err.message : "Couldn't read that file.", "err");
    $("#subs-file").textContent = fileSummary(file.name, file.size, null);
  }
}

function renderTracks(info) {
  const list = $("#subs-tracks");
  list.innerHTML = "";
  const tracks = info.streams.filter((s) => s.type === "subtitle");

  if (!tracks.length) {
    subsNote("This file has no subtitle tracks. Subtitles can't be generated from audio — only embedded tracks can be pulled out.", "warn");
    $("#subs-extract").disabled = true;
    return;
  }

  for (const track of tracks) {
    const image = IMAGE_SUBS.has(track.codec);
    const text = TEXT_SUBS.has(track.codec) || !image;
    const row = el("label", { class: "track" + (image ? " is-disabled" : "") });
    const box = el("input", { type: "checkbox", class: "track-box" });
    box.disabled = image;
    if (!image && text) box.checked = true;
    box.dataset.index = String(track.index);

    const main = el("span", { class: "track-main" });
    main.appendChild(el("span", { class: "track-name" },
      (track.title || (track.lang ? track.lang.toUpperCase() : "Track " + (tracks.indexOf(track) + 1)))));
    const meta = [];
    if (track.lang) meta.push(track.lang);
    meta.push(track.codec);
    main.appendChild(el("span", { class: "track-meta" }, meta.join(" · ")));

    const badge = el("span", { class: "badge" + (image ? " is-warn" : "") },
      image ? "image — can't export" : "text");

    row.appendChild(box);
    row.appendChild(main);
    row.appendChild(badge);
    list.appendChild(row);
  }

  const anyText = tracks.some((t) => !IMAGE_SUBS.has(t.codec));
  $("#subs-extract").disabled = !anyText;
  if (!anyText) {
    subsNote("All subtitle tracks in this file are image-based. Turning those into text needs OCR, which this tool doesn't do.", "warn");
  }
}

function trackFilename(sourceName, track, used) {
  const stem = baseName(sourceName) + "." + (track.lang || "und");
  let filename = stem;
  let n = 2;
  while (used.has(filename)) filename = stem + "-" + (n++);
  used.add(filename);
  return filename + ".srt";
}

async function subsExtract() {
  if (subs.busy || !subs.file || !subs.probe) return;
  const chosen = Array.from(document.querySelectorAll("#subs-tracks .track-box:checked"))
    .map((box) => Number(box.dataset.index));
  if (!chosen.length) return;

  subs.busy = true;
  $("#subs-extract").disabled = true;
  subsNote("Extracting…");

  try {
    const ff = await T().engine.get();
    const outputs = $("#subs-outputs");
    const used = new Set();

    for (const index of chosen) {
      const track = subs.probe.streams.find((s) => s.index === index);
      if (!track || IMAGE_SUBS.has(track.codec)) continue;

      const outName = "subs_out_" + index + ".srt";
      T().engine.logs.length = 0;
      const code = await ff.exec([
        "-hide_banner", "-y", "-i", subs.input,
        "-map", "0:" + index, "-c:s", "srt", "-f", "srt", outName
      ]);

      if (code !== 0) {
        subsNote(T().explain(T().engine.logs.slice()), "err");
        continue;
      }

      const data = await ff.readFile(outName);
      await ff.deleteFile(outName);
      if (!data || !data.length) {
        subsNote("That track produced an empty subtitle file.", "warn");
        continue;
      }

      const blob = new Blob([data], { type: "application/x-subrip" });
      const url = URL.createObjectURL(blob);
      subs.urls.push(url);

      const filename = trackFilename(subs.file.name, track, used);
      subs.outputs.push({ filename, url, size: blob.size, lang: track.lang, codec: track.codec });

      const row = el("div", { class: "out-row" });
      row.appendChild(el("span", { class: "out-name" }, filename));
      row.appendChild(el("span", { class: "out-meta" }, bytes(blob.size)));
      const download = el("button", { type: "button", class: "ghost-btn small" }, "download");
      download.addEventListener("click", () => {
        const link = el("a", { href: url, download: filename });
        document.body.appendChild(link);
        link.click();
        link.remove();
      });
      row.appendChild(download);
      outputs.appendChild(row);
    }

    subsNote(chosen.length === 1 ? "Extracted 1 subtitle file." : `Extracted ${chosen.length} subtitle files.`);
  } catch (err) {
    subsNote(err && err.message ? err.message : "Extraction failed.", "err");
  } finally {
    subs.busy = false;
    $("#subs-extract").disabled = false;
  }
}

/* ============================================================
   metadata
   ============================================================ */

const clean = {
  file: null,
  input: "",
  probe: null,
  tags: [],
  cache: "",
  busy: false,
  url: ""
};

function cleanReset() {
  const ff = T() && T().engine.instance;
  if (ff && clean.input) ff.deleteFile(clean.input).catch(() => {});
  if (clean.url) URL.revokeObjectURL(clean.url);
  clean.url = "";
  clean.file = null;
  clean.input = "";
  clean.probe = null;
  clean.tags = [];
  clean.cache = "";

  $("#clean-panel").hidden = true;
  $("#clean-tags").innerHTML = "";
  $("#clean-file").textContent = "";
  $("#clean-outputs").innerHTML = "";
  $("#clean-run").disabled = true;
}

function parseTags(lines) {
  const tags = [];
  let inside = false;
  for (const line of lines) {
    if (/^\s*Duration:/.test(line)) break;
    if (/^\s*Metadata:\s*$/.test(line)) { inside = true; continue; }
    if (!inside) continue;
    if (/^\s*(Input #|Output #|Stream #)/.test(line)) { inside = false; continue; }
    const match = /^\s{2,}([A-Za-z0-9_:-]+)\s*:\s*(.*)$/.exec(line);
    if (match && !TECHNICAL_TAGS.has(match[1])) tags.push([match[1], match[2]]);
  }
  return tags;
}

async function cleanPick(file) {
  if (!engineReady()) {
    $("#clean-panel").hidden = false;
    $("#clean-file").textContent = "The media engine didn't load. Reload and try again.";
    return;
  }
  const key = file.name + ":" + file.size + ":" + file.lastModified;
  if (clean.cache === key) return;

  cleanReset();
  $("#clean-panel").hidden = false;
  $("#clean-file").textContent = fileSummary(file.name, file.size, null);

  try {
    const ff = await T().engine.get();
    const buffer = new Uint8Array(await file.arrayBuffer());
    const sig = T().sniff(buffer, file.name);
    if (!sig || sig.container === "flac") throw new Error("That file isn't a container this tool can read.");

    clean.input = "clean_" + Date.now() + "." + sig.ext;
    await ff.writeFile(clean.input, buffer);

    T().engine.logs.length = 0;
    await ff.exec(["-hide_banner", "-i", clean.input]).catch(() => {});
    const info = T().parseProbe(T().engine.logs.slice());
    const tags = parseTags(T().engine.logs.slice());

    clean.file = file;
    clean.probe = info;
    clean.tags = tags;
    clean.cache = key;
    clean.ext = sig.ext;

    $("#clean-file").textContent = fileSummary(file.name, file.size, info);
    renderTags(tags);
    $("#clean-run").disabled = false;
  } catch (err) {
    $("#clean-file").textContent = (err && err.message) || "Couldn't read that file.";
  }
}

function renderTags(tags) {
  const list = $("#clean-tags");
  list.innerHTML = "";
  if (!tags.length) {
    list.appendChild(el("p", { class: "tool-note" }, "No descriptive metadata found — this file is already clean."));
    return;
  }
  for (const [key, value] of tags) {
    const row = el("div", { class: "tag" });
    row.appendChild(el("span", { class: "tag-key" }, key));
    row.appendChild(el("span", { class: "tag-value" }, value.length > 80 ? value.slice(0, 80) + "…" : value));
    list.appendChild(row);
  }
}

async function cleanRun() {
  if (clean.busy || !clean.file) return;
  clean.busy = true;
  $("#clean-run").disabled = true;
  $("#clean-outputs").innerHTML = "";

  const ext = clean.ext || "mp4";
  const MUXER = { mp4: "mov", m4a: "ipod", mov: "mov", mkv: "matroska", webm: "webm", mp3: "mp3", ogg: "ogg", opus: "ogg", wav: "wav" };
  const target = MUXER[ext] || ext;
  const outName = "clean_out." + ext;

  let ff = null;

  try {
    ff = await T().engine.get();
    const args = ["-hide_banner", "-y", "-i", clean.input, "-map", "0", "-c", "copy", "-map_metadata", "-1", "-fflags", "+bitexact"];
    if (target === "mov") args.push("-movflags", "+faststart");
    args.push("-f", target, outName);

    T().engine.logs.length = 0;
    const code = await ff.exec(args);

    if (code !== 0) {
      $("#clean-outputs").appendChild(el("p", { class: "tool-note", "data-tone": "err" }, T().explain(T().engine.logs.slice())));
      return;
    }

    const data = await ff.readFile(outName);
    if (!data || !data.length) throw new Error("The cleaned file came back empty.");
    if (!T().sniff(data, outName)) throw new Error("The cleaned file didn't validate.");

    const after = await probe(ff, outName);
    const left = parseTags(T().engine.logs.slice());

    if (clean.url) URL.revokeObjectURL(clean.url);
    const blob = new Blob([data], { type: "application/octet-stream" });
    clean.url = URL.createObjectURL(blob);

    const filename = baseName(clean.file.name) + "-clean." + ext;
    const row = el("div", { class: "out-row" });
    row.appendChild(el("span", { class: "out-name" }, filename));
    row.appendChild(el("span", { class: "out-meta" }, bytes(blob.size)));
    const download = el("button", { type: "button", class: "ghost-btn small" }, "download");
    download.addEventListener("click", () => {
      const link = el("a", { href: clean.url, download: filename });
      document.body.appendChild(link);
      link.click();
      link.remove();
    });
    row.appendChild(download);
    $("#clean-outputs").appendChild(row);

    const removed = Math.max(0, clean.tags.length - left.length);
    const summary = [];
    summary.push(removed ? "Removed " + removed + " tag" + (removed === 1 ? "" : "s") + "." : "No tags were present to remove.");
    if (left.length) summary.push("Still present: " + left.map(([k]) => k).join(", ") + ".");
    summary.push("Streams copied without re-encoding: " + after.streams.map((s) => s.type).filter((t, i, a) => a.indexOf(t) === i).join(" + ") + ".");
    $("#clean-outputs").appendChild(el("p", { class: "tool-note" }, summary.join(" ")));
  } catch (err) {
    $("#clean-outputs").appendChild(el("p", { class: "tool-note", "data-tone": "err" },
      err && err.message ? err.message : "Couldn't clean that file."));
  } finally {
    /* the output never needs to outlive the download blob */
    if (ff) {
      try { await ff.deleteFile(outName); } catch (e) {}
    }
    clean.busy = false;
    $("#clean-run").disabled = false;
  }
}

/* ============================================================
   wiring
   ============================================================ */

function init() {
  if (!$("#subs-drop")) return;

  wireDropzone("#subs-drop", "#subs-input", "choose file", subsPick);
  wireDropzone("#clean-drop", "#clean-input", "choose file", cleanPick);

  $("#subs-extract").addEventListener("click", subsExtract);
  $("#subs-reset").addEventListener("click", subsReset);
  $("#clean-run").addEventListener("click", cleanRun);
  $("#clean-reset").addEventListener("click", cleanReset);

  window.addEventListener("pagehide", () => {
    subs.urls.forEach((url) => URL.revokeObjectURL(url));
    if (clean.url) URL.revokeObjectURL(clean.url);
  });
}

init();

window.tools = {
  subs, clean,
  pickSubs: subsPick,
  extract: subsExtract,
  pickClean: cleanPick,
  runClean: cleanRun,
  renderTracks,
  renderTags,
  trackFilename,
  parseTags,
  parseProbe: (lines) => T().parseProbe(lines),
  TEXT_SUBS, IMAGE_SUBS
};
