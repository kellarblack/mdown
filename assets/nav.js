/* ============================================================
   View routing. One place decides which panel is on screen, so
   every tool module can stay focused on its own job.
   ============================================================ */

const PANELS = {
  "": "download",
  "#remux": "remux",
  "#subs": "subs",
  "#clean": "clean"
};

const META = {
  download: {
    title: "mdown.cc — paste a link, keep the file",
    desc: "No ads, no account. Paste a link and keep the video or audio. Remux, subtitles and metadata tools run in your browser."
  },
  remux: {
    title: "Remux without re-encoding — mdown.cc",
    desc: "Repackage a video or audio file into a different container without re-encoding. Fix broken seeking and container problems in your browser, with no upload."
  },
  subs: {
    title: "Subtitle extractor — mdown.cc",
    desc: "Extract embedded text subtitle tracks from a video as SRT files, in your browser. Image-based subtitles are detected and flagged, not faked."
  },
  clean: {
    title: "Metadata cleaner — mdown.cc",
    desc: "Remove title, artist, comment, date and location tags from a media file while leaving the streams untouched. Runs locally in your browser."
  }
};

const BASE_URL = "https://mdown.cc/";

function setMeta(selector, value) {
  const node = document.querySelector(selector);
  if (node) node.setAttribute("content", value);
}

function apply() {
  const view = PANELS[location.hash] || "download";
  // the "back to download" link only exists while you are inside a tool
  document.body.dataset.view = view;

  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.viewPanel !== view;
  });

  document.querySelectorAll("[data-view]").forEach((link) => {
    const active = link.dataset.view === view;
    link.classList.toggle("is-active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });

  const toolsToggle = document.querySelector("[data-tools-toggle]");
  if (toolsToggle) {
    const active = view !== "download";
    toolsToggle.classList.toggle("is-active", active);
    if (active) toolsToggle.setAttribute("aria-current", "page");
    else toolsToggle.removeAttribute("aria-current");
  }

  if (toolsMenu) toolsMenu.open = false;

  const meta = META[view] || META.download;
  document.title = meta.title;
  setMeta('meta[name="description"]', meta.desc);
  setMeta('meta[property="og:title"]', meta.title);
  setMeta('meta[property="og:description"]', meta.desc);
  setMeta('meta[property="og:url"]', BASE_URL + (location.hash === "#remux" || location.hash === "#subs" || location.hash === "#clean" ? location.hash : ""));
  setMeta('meta[name="twitter:title"]', meta.title);
  setMeta('meta[name="twitter:description"]', meta.desc);
  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical) canonical.setAttribute("href", BASE_URL);
}

const toolsMenu = document.querySelector("#nav-tools");
let toolsTimer = null;

function syncToolsMenu() {
  if (!toolsMenu) return;
  const summary = toolsMenu.querySelector("summary");
  if (summary) summary.setAttribute("aria-expanded", toolsMenu.open ? "true" : "false");
}

/* <details> hides its content the instant it closes, so the exit runs first and
   the element is removed 120ms later. Opening is native: the menu mounts and
   its drop-in animation plays. */
function closeTools(restoreFocus) {
  if (!toolsMenu || !toolsMenu.open) return;
  const menu = toolsMenu.querySelector(".nav-menu");
  const summary = toolsMenu.querySelector("summary");
  if (menu) menu.classList.add("is-closing");
  clearTimeout(toolsTimer);
  toolsTimer = setTimeout(() => {
    toolsMenu.open = false;
    if (menu) menu.classList.remove("is-closing");
    syncToolsMenu();
    if (restoreFocus && summary) summary.focus();
  }, 120);
  if (summary) summary.setAttribute("aria-expanded", "false");
}

if (toolsMenu) {
  const summary = toolsMenu.querySelector("summary");
  if (summary) {
    summary.addEventListener("click", (event) => {
      event.preventDefault();
      clearTimeout(toolsTimer);
      const menu = toolsMenu.querySelector(".nav-menu");
      if (menu) menu.classList.remove("is-closing");
      if (toolsMenu.open) closeTools(false);
      else {
        toolsMenu.open = true;
        syncToolsMenu();
      }
    });
  }
  toolsMenu.addEventListener("toggle", syncToolsMenu);
  syncToolsMenu();

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && toolsMenu.open) closeTools(true);
  });
}

window.addEventListener("hashchange", apply);
document.addEventListener("DOMContentLoaded", apply);
if (document.readyState !== "loading") apply();

/* close the tools menu once a choice is made */
document.addEventListener("click", (event) => {
  const menu = document.querySelector("#nav-tools");
  if (!menu || !menu.open) return;
  if (menu.contains(event.target) && event.target.closest(".nav-menu a")) {
    closeTools(false);
  } else if (!menu.contains(event.target)) {
    closeTools(false);
  }
});
