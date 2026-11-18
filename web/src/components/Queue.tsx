import { Fragment, memo } from "react";
import { ICONS } from "../status-icons";
import { markFor, marksStore } from "../service-marks";
import {
  cancelItem, clearFinished, FINISHED, modalStore, openSource, queueStore, queueSummary, removeItem, reportable,
  retryItem, saveBlob, shareItem, switchToAlternative, type QueueItem,
} from "../queue";
import { settingsStore, setPanel, toast, useStore } from "../store";
import { clockTime, copyText, cx, etaText, formatBytes } from "../util";
import {
  IconClose, IconCopy, IconDots, IconFlag, IconOpen, IconRetry, IconSave, IconShare,
} from "../icons";

/** the logo for a service; re-renders once the logos have loaded */
export function useMark(service: string | null | undefined): string {
  return markFor(useStore(marksStore), service);
}

/** a service logo as an element, so a list can render many */
export function Mark({ service, className }: { service: string | null | undefined; className?: string }) {
  return <span className={className} aria-hidden="true" dangerouslySetInnerHTML={{ __html: useMark(service) }} />;
}

function iconFor(item: QueueItem): string {
  switch (item.status) {
    case "working":
    case "downloading":
      return ICONS.working!;
    case "ready":
    case "done":
      return ICONS.ready!;
    case "error":
    case "cancelled":
      return ICONS.error!;
    case "local":
      return ICONS.local!;
    case "picker":
      return ICONS.picker!;
    default:
      return ICONS.link!;
  }
}

function titleFor(item: QueueItem): string {
  if (item.filename) return item.filename;
  if (item.previewTitle) return item.previewTitle;
  if (item.status === "local") return "Local processing required";
  if (item.status === "picker") return "Multiple items found";
  return item.host || item.url || "Untitled";
}

const MODE_NAMES: Record<string, string> = { auto: "video", audio: "audio", mute: "silent" };

function metaFor(item: QueueItem): { text: string; err: boolean }[] {
  const parts: { text: string; err: boolean }[] = [];
  const add = (text: string, err = false) => text && parts.push({ text, err });
  add(item.service);
  add(MODE_NAMES[item.mode] || item.mode);
  if (item.status === "downloading") {
    if (item.duration) add(clockTime(item.duration));
  } else if (item.error) {
    add(item.error, true);
  } else if (item.detail) {
    if (item.size) add(formatBytes(item.size));
    add(item.detail);
    if (item.started && item.status === "working") add(Math.max(1, Math.round((Date.now() - item.started) / 1000)) + "s");
    if (item.estimate?.bytes && !item.size) add((item.estimate.exact ? "~" : "≈") + " " + formatBytes(item.estimate.bytes));
    if (item.duration) add(clockTime(item.duration));
  }
  return parts;
}

function Btn({ label, onClick, children, className }: { label: string; onClick: () => void; children: React.ReactNode; className?: string }) {
  return (
    <button type="button" className={cx("icon-btn", className)} title={label} aria-label={label} onClick={onClick}>
      {children}
    </button>
  );
}

const Row = memo(function Row({ item }: { item: QueueItem; v: number }) {
  const pct = item.status === "done" || item.status === "ready" ? 100 : item.size ? Math.min(100, (item.received / item.size) * 100) : 0;
  let pctText = "";
  let bytesText = "";
  let rateText = "";
  if (item.status === "downloading") {
    if (item.size) {
      pctText = Math.min(100, Math.floor(pct)) + "%";
      bytesText = formatBytes(item.received) + " / " + formatBytes(item.size);
      const left = item.speed && item.size > item.received ? etaText((item.size - item.received) / item.speed) : "";
      rateText = [item.speed ? formatBytes(item.speed) + "/s" : "", left].filter(Boolean).join(" · ");
    } else {
      bytesText = formatBytes(item.received) || "receiving";
      rateText = item.speed ? formatBytes(item.speed) + "/s" : "size unknown";
    }
  } else if (item.status === "working") {
    bytesText = item.detail || "requesting";
    rateText = item.started ? Math.max(1, Math.round((Date.now() - item.started) / 1000)) + "s" : "";
  }
  const meta = metaFor(item);
  const finished = item.status === "ready" || item.status === "done";
  const canShare = typeof navigator !== "undefined" && !!navigator.share;
  return (
    <div className={cx("qitem", Date.now() - item.fresh < 400 && "is-new")} data-status={item.status}
      data-indeterminate={item.indeterminate ? "true" : "false"} id={item.id}>
      <div className="q-icon" aria-hidden="true" hidden={!!item.thumb} dangerouslySetInnerHTML={{ __html: iconFor(item) }} />
      <div className="q-thumb" aria-hidden="true" hidden={!item.thumb}
        style={item.thumb ? { backgroundImage: "url(" + JSON.stringify(item.thumb) + ")" } : undefined} />
      <div className="q-body">
        <div className="q-title">{titleFor(item)}</div>
        <div className="q-meta">
          {meta.map((p, i) => (
            <Fragment key={i}>
              {i > 0 && <span className="sep" />}
              <span className={p.err ? "q-err" : undefined}>{p.text}</span>
            </Fragment>
          ))}
        </div>
      </div>
      <div className="q-actions">
        {["working", "downloading", "queued"].includes(item.status) && (
          <Btn label="Cancel" onClick={() => cancelItem(item)}><IconClose /></Btn>
        )}
        {(item.status === "error" || item.status === "cancelled") && (
          item.alt ? (
            <button type="button" className="q-save q-alt" onClick={() => switchToAlternative(item)}
              title={"Download from YouTube: " + item.alt.title + (item.alt.channel ? " · " + item.alt.channel : "")}>
              <IconRetry /><span>get from YouTube</span>
            </button>
          ) : item.altSearch ? (
            <a className="q-save q-alt" href={item.altSearch} target="_blank" rel="noopener noreferrer" title="search YouTube for this song">
              <IconOpen /><span>find on YouTube</span>
            </a>
          ) : <Btn label="Retry" onClick={() => retryItem(item)}><IconRetry /></Btn>
        )}
        {reportable(item) && (
          <Btn label="Report this service" onClick={() => modalStore.set({ kind: "report", service: item.service })}><IconFlag /></Btn>
        )}
        {finished && item.blob && canShare && (
          <Btn label="Share" onClick={() => void shareItem(item)}><IconShare /></Btn>
        )}
        {item.status === "ready" && !item.blob && item.sourceUrl && (
          <Btn label="Save from the link" onClick={() => openSource(item)}><IconOpen /></Btn>
        )}
        {(item.status === "local" || item.status === "picker") && (
          <Btn label="Details" onClick={() => modalStore.set({ kind: item.status === "local" ? "local" : "picker", itemId: item.id })}><IconDots /></Btn>
        )}
        {item.sourceUrl && finished && (
          <Btn label="Copy link" onClick={() => void copyText(item.sourceUrl).then((ok) => ok && toast("Link copied", "info"))}><IconCopy /></Btn>
        )}
        {(item.status === "done" || item.status === "error" || item.status === "cancelled") && (
          <Btn label="Remove" onClick={() => removeItem(item)}><IconClose /></Btn>
        )}
        {finished && item.blob && (
          <button type="button" className="q-save" title={"Save " + (item.filename || "file")} aria-label={"Save " + (item.filename || "file")}
            onClick={() => saveBlob(item)}>
            <IconSave /><span>save</span>
          </button>
        )}
      </div>
      <div className="q-progress">
        <div className="q-progress-track">
          <div className="q-progress-fill" style={{ transform: `scaleX(${(pct / 100).toFixed(4)})` }} />
        </div>
        <span className="q-progress-pct">{pctText}</span>
        <div className="q-progress-line">
          <span className="q-bytes">{bytesText}</span>
          <span className="q-rate">{rateText}</span>
        </div>
      </div>
    </div>
  );
}, (a, b) => a.item === b.item && a.v === b.v);

export function QueueList() {
  const { items, v } = useStore(queueStore);
  return (
    <>
      <div className="queue-list" id="queue-list">
        {items.map((item) => <Row key={item.id} item={item} v={v} />)}
      </div>
      <p className="empty" id="empty-state" hidden={items.length > 0}>Nothing here yet.</p>
    </>
  );
}

export function QueuePanelHead() {
  const { items } = useStore(queueStore);
  const { stats } = queueSummary(items);
  const canClear = items.some((i) => FINISHED.includes(i.status));
  return (
    <div className="dock-head">
      <span className="section-label">
        downloads <span className="count" id="queue-count" hidden={!items.length}>{items.length}</span>
      </span>
      <span className="section-actions">
        <span className="qstats" id="queue-stats">{stats}</span>
        <button type="button" className="ghost-btn small" id="clear-finished" hidden={!canClear} onClick={clearFinished} title="clear finished downloads">clear</button>
        <button type="button" className="icon-btn" id="queue-close" aria-label="close downloads" title="close" onClick={() => setPanel("none")}>
          <IconClose />
        </button>
      </span>
    </div>
  );
}

/** the phone's one-line summary of the download in flight */
export function MiniDock({ hidden }: { hidden: boolean }) {
  const { items } = useStore(queueStore);
  const { live, focus } = queueSummary(items);
  if (!focus || hidden) return null;
  const title = focus.filename || focus.previewTitle || focus.host || "download";
  const pct = live && live.size ? Math.min(100, Math.round((live.received / live.size) * 100)) : 0;
  let meta = "";
  let eta = "";
  if (live) {
    meta = live.size ? formatBytes(live.received) + " / " + formatBytes(live.size) : live.detail || "starting";
    const done = live.size && live.received >= live.size;
    eta = (!done && live.speed && live.size > live.received ? etaText((live.size - live.received) / live.speed) : "") ||
      (!done && live.speed ? formatBytes(live.speed) + "/s" : "");
  } else {
    meta = formatBytes(focus.size) + " · ready";
    eta = "tap to save";
  }
  const onClick = () => {
    if (focus.status === "ready") {
      if (settingsStore.get().savingMethod === "share" && focus.blob) {
        void shareItem(focus, true).then((shared) => !shared && saveBlob(focus));
      } else if (focus.blob) saveBlob(focus);
      else openSource(focus);
      return;
    }
    setPanel("queue");
  };
  return (
    <button type="button" className="mini-dock" id="mini-dock" aria-label="open downloads" data-state={live ? "live" : "ready"}
      data-live={live && live.size ? "true" : "false"} onClick={onClick}>
      <span className="mini-icon" aria-hidden="true">
        <svg className="mini-live" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v10" /><path d="m7.5 9.5 4.5 4.5 4.5-4.5" /><path d="M5 19h14" /></svg>
        <svg className="mini-ready" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
      </span>
      <span className="mini-body">
        <span className="mini-line"><b id="mini-title">{title.length > 32 ? title.slice(0, 31) + "…" : title}</b><span className="mini-pct">{live && live.size ? pct + "%" : ""}</span></span>
        <span className="mini-track"><span style={{ transform: `scaleX(${live ? (live.size ? pct / 100 : 0.12) : 1})` }} /></span>
        <span className="mini-line mini-sub"><span>{meta}</span><span>{eta}</span></span>
      </span>
      <span className="mini-go" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h13" /><path d="m12.5 6 6 6-6 6" /></svg>
      </span>
    </button>
  );
}

