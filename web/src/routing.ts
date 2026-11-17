import { uiStore, type View } from "./store";

const HASH_VIEWS: Record<string, View> = { "": "download", "#remux": "remux", "#subs": "subs", "#clean": "clean", "#donate": "donate" };

const META: Record<View, { title: string; desc: string }> = {
  download: {
    title: "mdown.cc · ad-free download tool",
    desc: "No ads, no account. Paste a link and keep the video or audio. Remux, subtitles and metadata tools run in your browser.",
  },
  remux: {
    title: "Remux without re-encoding · mdown.cc",
    desc: "Repackage a video or audio file into a different container without re-encoding. Fix broken seeking and container problems in your browser.",
  },
  subs: {
    title: "Subtitle extractor · mdown.cc",
    desc: "Extract embedded text subtitle tracks from a video as SRT files, in your browser. Image-based subtitles are detected and flagged, not faked.",
  },
  clean: {
    title: "Metadata cleaner · mdown.cc",
    desc: "Remove title, artist, comment, date and location tags from a media file while leaving the streams untouched. Runs locally in your browser.",
  },
  donate: {
    title: "Support mdown.cc · tip jar",
    desc: "mdown.cc is free, with no ads and no tracking. If it earned an evening, leave a tip by card or crypto.",
  },
};

const isDonatePath = (path: string) => /\/donate(\.html)?\/?$/.test(path);

/** the folder the app lives in, so a fork under /mdown/ still works */
export function appBase(): string {
  const path = location.pathname;
  if (isDonatePath(path)) return path.replace(/donate(\.html)?\/?$/, "");
  return path.replace(/[^/]*$/, "");
}

export function viewFromLocation(): View {
  if (isDonatePath(location.pathname)) return "donate";
  return HASH_VIEWS[location.hash] || "download";
}

function setMeta(selector: string, value: string): void {
  document.querySelector(selector)?.setAttribute("content", value);
}

export function applyMeta(view: View): void {
  const meta = META[view];
  document.title = meta.title;
  setMeta('meta[name="description"]', meta.desc);
  setMeta('meta[property="og:title"]', meta.title);
  setMeta('meta[property="og:description"]', meta.desc);
  document.body.dataset.view = view;
}

/** move to a view: the donate page has a real address, the tools a hash */
export function navigate(view: View): void {
  const base = appBase();
  const target = view === "donate" ? base + "donate.html" : base + (view === "download" ? "" : "#" + view);
  const current = location.pathname + location.hash;
  // leaving from an open sheet replaces the sheet's own history entry, so one
  // back press returns to where the sheet was opened
  if (history.state && history.state.mdLayer) history.replaceState(null, "", target || "/");
  else if (current !== target) history.pushState(null, "", target || "/");
  uiStore.set((s) => ({ ...s, view, panel: "none", settingsOpen: false, helpOpen: false }));
  applyMeta(view);
  window.scrollTo({ top: 0 });
}

export function startRouting(): void {
  const sync = () => {
    const view = viewFromLocation();
    uiStore.set((s) => (s.view === view ? s : { ...s, view, panel: "none" }));
    applyMeta(view);
  };
  window.addEventListener("popstate", sync);
  window.addEventListener("hashchange", sync);
  sync();
}

/** intercept a plain left click on an in-app link */
export function onNav(view: View) {
  return (event: { preventDefault(): void; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; button?: number }) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || (event.button ?? 0) !== 0) return;
    event.preventDefault();
    navigate(view);
  };
}
