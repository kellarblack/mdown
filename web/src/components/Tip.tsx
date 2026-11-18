import { useEffect, useRef, useState } from "react";
import { COIN, DONATE, maskAddress } from "../donate-config";
import { setPanel, toast, togglePanel, uiStore, useStore } from "../store";
import { navigate } from "../routing";
import { IconArrow, IconCard, IconCheck, IconClose, IconCopy, IconHeart, Svg } from "../icons";
import { copyText, cx } from "../util";
import { createStore } from "../store";
import { queueStore } from "../queue";

/* ------------------------------------------------------------------ */
/* the tip jar popover: card, coins, and the way to the full page      */
/* ------------------------------------------------------------------ */

function CoinRow({ id, label, value }: { id: string; label: string; value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="tp-coin">
      {COIN[id] && <Svg className="tp-coin-icon" html={COIN[id]!} />}
      <span className="tp-coin-text"><b>{label}</b><code translate="no">{maskAddress(value)}</code></span>
      <button type="button" className={cx("tp-copy", done && "is-copied")} aria-label={"copy " + label + " address"}
        onClick={() => void copyText(value).then((ok) => {
          if (!ok) return toast("Couldn't copy. Open the full page and copy it there.", "warn");
          toast("Address copied", "info");
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        })}>
        {done ? <IconCheck /> : <IconCopy />}
      </button>
    </div>
  );
}

export function TipPop({ anchor }: { anchor: React.RefObject<HTMLElement | null> }) {
  const open = useStore(uiStore, (s) => s.panel === "tip");
  const pop = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) return setMounted(true);
    const t = setTimeout(() => setMounted(false), 160);
    return () => clearTimeout(t);
  }, [open]);

  // close on Escape or a press outside (the opener and the phone bar excepted)
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element;
      if (pop.current?.contains(t) || anchor.current?.contains(t) || t.closest?.('[data-tab="donate"]')) return;
      setPanel("none");
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPanel("none");
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, anchor]);

  // a desktop dropdown hangs under the heart, kept on screen; a phone sheet sits above the bar
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const node = pop.current;
      const button = anchor.current;
      if (!node) return;
      const phone = matchMedia("(max-width: 720px), (hover: none) and (max-height: 520px)").matches;
      if (phone || !button || !button.offsetParent) {
        node.style.left = node.style.top = "";
        return;
      }
      const r = button.getBoundingClientRect();
      const w = node.getBoundingClientRect().width;
      node.style.top = Math.round(r.bottom + 8) + "px";
      node.style.left = Math.round(Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8)) + "px";
    };
    place();
    addEventListener("resize", place);
    return () => removeEventListener("resize", place);
  }, [open, anchor, mounted]);

  if (!mounted) return null;
  const coins = DONATE.methods.filter((m) => m.value);
  return (
    <div ref={pop} className={cx("tp", !open && "is-closing")} id="tip-pop" role="dialog" aria-label="tip jar">
      <div className="tp-head">
        <span className="tp-title"><span className="tp-dot" aria-hidden="true" />tip jar</span>
        <button type="button" className="tp-close" aria-label="close tip jar" onClick={() => setPanel("none")}><IconClose /></button>
      </div>
      <p className="tp-lede">no ads, no accounts. a tip keeps the server running and buys nothing else.</p>
      {DONATE.stripe && (
        <a className="tp-card" href={DONATE.stripe} target="_blank" rel="noopener noreferrer" onClick={() => setPanel("none")}>
          <span className="tp-card-icon" aria-hidden="true"><IconCard /></span>
          <span className="tp-card-text"><b>card, apple pay, google pay</b><span>any amount · stripe</span></span>
          <IconArrow className="tp-go" />
        </a>
      )}
      {coins.length > 0 && <div className="tp-coins">{coins.map((m) => <CoinRow key={m.id} id={m.id} label={m.label || m.id} value={String(m.value)} />)}</div>}
      <a className="tp-more" href="donate" onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        setPanel("none");
        navigate("donate");
      }}>
        <span>see all the ways to give</span><IconArrow className="tp-go" />
      </a>
    </div>
  );
}

export function TipButton() {
  const ref = useRef<HTMLButtonElement>(null);
  const open = useStore(uiStore, (s) => s.panel === "tip");
  return (
    <>
      <button ref={ref} type="button" className="icon-btn labeled donate-btn" id="open-donate-top" title="leave a tip"
        aria-haspopup="dialog" aria-expanded={open} aria-controls="tip-pop" onClick={() => togglePanel("tip")}>
        <IconHeart /><span>tip</span>
      </button>
      <TipPop anchor={ref} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* one quiet line after a download, instead of tip buttons everywhere  */
/* ------------------------------------------------------------------ */

const NUDGE_KEY = "mdown.tipnudge";
export const nudgeStore = createStore(false);

type Nudge = { saves: number; shownAt: number; quietUntil: number };

function readNudge(): Nudge {
  try {
    const v = JSON.parse(localStorage.getItem(NUDGE_KEY) || "{}");
    return { saves: Number(v.saves) || 0, shownAt: Number(v.shownAt) || 0, quietUntil: Number(v.quietUntil) || 0 };
  } catch {
    return { saves: 0, shownAt: 0, quietUntil: 0 };
  }
}
function writeNudge(v: Nudge) {
  try {
    localStorage.setItem(NUDGE_KEY, JSON.stringify(v));
  } catch {
    /* then it may show again next visit; harmless */
  }
}

const HOUR = 3600 * 1000;

/** after the first saved file, then at most once a day; a dismiss quiets it
 *  for three days and a tip for a month */
export function noteSaved(): void {
  const v = readNudge();
  v.saves += 1;
  const now = Date.now();
  if (now >= v.quietUntil && now - v.shownAt > 20 * HOUR) {
    v.shownAt = now;
    setTimeout(() => nudgeStore.set(true), 900);
  }
  writeNudge(v);
}

function quiet(hours: number): void {
  const v = readNudge();
  v.quietUntil = Date.now() + hours * HOUR;
  writeNudge(v);
}



export function TipNudge() {
  const show = useStore(nudgeStore);
  // the phone's progress bar sits in the same place: a live download goes first
  const busy = useStore(queueStore, (q) => q.items.some((i) => ["queued", "working", "downloading", "ready"].includes(i.status)));
  useEffect(() => {
    if (!show) return;
    const t = setTimeout(() => nudgeStore.set(false), 10000);
    return () => clearTimeout(t);
  }, [show]);
  if (!show || busy || !DONATE.enabled) return null;
  return (
    <div className="tn" role="status">
      <button type="button" className="tn-tip" onClick={() => {
        nudgeStore.set(false);
        quiet(30 * 24);
        uiStore.set((s) => ({ ...s, panel: "tip" }));
      }}><IconHeart /><span>leave a tip</span></button>
      <button type="button" className="tn-close" aria-label="dismiss" onClick={() => {
        nudgeStore.set(false);
        quiet(3 * 24);
      }}><IconClose /></button>
    </div>
  );
}
