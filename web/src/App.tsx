import { lazy, Suspense, useEffect } from "react";
import { apiEndpoint, checkInstance } from "./api";
import { modalStore, submitUrls } from "./queue";
import { composerStore, setPanel, settingsStore, toastStore, uiStore, useStore } from "./store";
import { navigate, onNav } from "./routing";
import { detectService, parseUrls, targetFromLocation } from "./util";
import { Header, MobileBar } from "./components/Header";
import { askWhatToDownload, DownloadView } from "./components/Download";
import { ToolView, loadTools } from "./components/Tools";
import { Modals } from "./components/Modal";
import { loadMarks } from "./service-marks";

// what most visits never open loads only when it is opened
const SettingsSheet = lazy(() => import("./components/Settings").then((m) => ({ default: m.SettingsSheet })));
const DonateView = lazy(() => import("./components/Donate").then((m) => ({ default: m.DonateView })));
import { MiniDock } from "./components/Queue";
import { TipNudge } from "./components/Tip";
import { cx } from "./util";

function Toasts() {
  const list = useStore(toastStore);
  return (
    <div className="toasts" id="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id + ":" + t.pulse} className={cx("toast", t.leaving && "is-leaving", t.pulse > 0 && "is-pulse")} data-tone={t.tone}>
          <span className="dot" />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <nav className="footer-meta" aria-label="Footer">
        <a href="terms.html">terms</a>
        <a href="updates.html">updates</a>
        <a href="donate" onClick={onNav("donate")}>donate</a>
        <a className="footer-source" href="https://github.com/kelllar/mdown" rel="noopener">github</a>
      </nav>
    </footer>
  );
}

/* theme: the stored choice, or the system's */
function useTheme() {
  const theme = useStore(settingsStore, (s) => s.theme);
  useEffect(() => {
    const query = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = theme === "light" || theme === "dark" ? theme : query.matches ? "dark" : "light";
      document.documentElement.dataset.theme = resolved;
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved === "dark" ? "#0a0a0b" : "#f6f6f7");
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [theme]);
}

/* a link in the address (mdown.cc/<link>, ?url=) fills the field and starts */
function takeDeepLink() {
  const raw = targetFromLocation(location);
  if (!raw || raw.length > 2048) return;
  const urls = parseUrls(raw);
  if (!urls.length) return;
  composerStore.set((s) => ({ ...s, text: urls[0]! }));
  try {
    history.replaceState(null, "", location.pathname.replace(/index\.html$/, "").replace(/[^/]*$/, "") || "/");
  } catch {
    /* fine */
  }
  // inside someone else's frame a deep link only fills the field
  if (window.top !== window.self) return;
  const detected = detectService(urls[0]!);
  if (apiEndpoint() && detected?.id === "youtube") {
    askWhatToDownload(urls[0]!, detected.host);
    return;
  }
  void submitUrls(urls[0]!);
}

/* Android's back button (and a back swipe) closes the sheet or dialog on top
   instead of leaving the site. Opening a layer adds one history entry with the
   same address; closing it by hand takes that entry back off. */
function useBackClosesLayers() {
  const layer = useStore(uiStore, (s) => s.settingsOpen || s.helpOpen || s.panel !== "none");
  const modal = useStore(modalStore);
  const open = layer || modal !== null;
  useEffect(() => {
    const onPop = () => {
      const m = modalStore.get();
      if (m?.kind === "confirm") m.resolve(false);
      if (m) modalStore.set(null);
      uiStore.set((s) => (s.settingsOpen || s.helpOpen || s.panel !== "none" ? { ...s, settingsOpen: false, helpOpen: false, panel: "none" } : s));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    if (open) {
      if (!(history.state && history.state.mdLayer)) history.pushState({ mdLayer: true }, "");
    } else if (history.state && history.state.mdLayer) {
      history.back();
    }
  }, [open]);
}

export function App() {
  const ui = useStore(uiStore);
  useTheme();
  useBackClosesLayers();

  useEffect(() => {
    void checkInstance({ silent: true });
    // a changed server is checked once the typing stops
    let last = settingsStore.get().instance;
    let t: ReturnType<typeof setTimeout> | undefined;
    const unsub = settingsStore.subscribe(() => {
      const now = settingsStore.get().instance;
      if (now === last) return;
      last = now;
      clearTimeout(t);
      t = setTimeout(() => void checkInstance(), 600);
    });
    takeDeepLink();
    const idle = (cb: () => void) => ("requestIdleCallback" in window ? requestIdleCallback(cb, { timeout: 2500 }) : setTimeout(cb, 1200));
    idle(() => void loadMarks());
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        uiStore.set((s) => ({ ...s, panel: "none", settingsOpen: !s.settingsOpen }));
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const typing = /INPUT|TEXTAREA|SELECT/.test((document.activeElement as HTMLElement | null)?.tagName || "");
      if (typing) return;
      if (event.key === "/") {
        event.preventDefault();
        if (uiStore.get().view !== "download") navigate("download");
        setTimeout(() => document.getElementById("url-input")?.focus(), 0);
      } else if (event.key === "?") {
        event.preventDefault();
        uiStore.set((s) => ({ ...s, helpOpen: true }));
      }
    };
    document.addEventListener("keydown", onKey);
    if (location.hash === "#help") uiStore.set((s) => ({ ...s, helpOpen: true }));
    // warm the tool code while idle once someone points at a tool
    const warm = (e: Event) => (e.target as Element).closest?.(".tool-card, [data-tab='remux']") && void loadTools();
    document.addEventListener("pointerover", warm, { passive: true });
    document.addEventListener("touchstart", warm, { passive: true });
    return () => {
      unsub();
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerover", warm);
      document.removeEventListener("touchstart", warm);
    };
  }, []);

  // a panel never outlives the page it belongs to
  useEffect(() => {
    if (ui.view !== "download" && ui.panel === "queue") setPanel("none");
  }, [ui.view, ui.panel]);

  const v = ui.view;
  return (
    <>
      <a className="skip-link" href="#url-input">skip to the link field</a>
      <Header />
      <DownloadView hidden={v !== "download"} />
      <ToolView name="remux" hidden={v !== "remux"} />
      <ToolView name="subs" hidden={v !== "subs"} />
      <ToolView name="clean" hidden={v !== "clean"} />
      {v === "donate" && <Suspense fallback={<main className="wrap donate-page" />}><DonateView hidden={false} /></Suspense>}
      <Footer />
      {ui.settingsOpen && <Suspense fallback={null}><SettingsSheet /></Suspense>}
      <Modals />
      <MiniDock hidden={ui.panel === "queue"} />
      <MobileBar />
      <TipNudge />
      <Toasts />
    </>
  );
}
