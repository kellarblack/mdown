import { useEffect, useRef, useState, type RefObject } from "react";
import { apiEndpoint } from "../api";
import { confirmPicker, getItem, modalStore, queueStore, saveLocalPart, type ModalSpec } from "../queue";
import { toast, uiStore, useStore } from "../store";
import { IconClose } from "../icons";
import { copyText, formatBytes, resolveUrl } from "../util";

/** Escape closes, Tab stays inside, focus returns where it was */
export function useFocusTrap(open: boolean, root: RefObject<HTMLElement | null>, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const t = setTimeout(() => {
      const target = root.current?.querySelector<HTMLElement>("[data-autofocus], .modal-head .icon-btn, .sheet-head .icon-btn");
      target?.focus({ preventScroll: true });
    }, 40);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !root.current) return;
      const focusable = Array.from(root.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
        .filter((n) => !(n as HTMLButtonElement).disabled && n.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = overflow;
      before?.focus?.({ preventScroll: true });
    };
  }, [open, root]);
}

function Dialog({ title, onClose, children, foot }: { title: string; onClose: () => void; children: React.ReactNode; foot: React.ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useFocusTrap(true, root, onClose);
  return (
    <div className="modal" id="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={root}>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-inner" role="document">
        <header className="modal-head">
          <h2 id="modal-title">{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><IconClose /></button>
        </header>
        <div className="modal-body">{children}</div>
        <footer className="modal-foot">{foot}</footer>
      </div>
    </div>
  );
}

function Confirm({ spec }: { spec: Extract<ModalSpec, { kind: "confirm" }> }) {
  const total = spec.entries.reduce((s, e) => s + (e.bytes || 0), 0);
  const done = (ok: boolean) => {
    modalStore.set(null);
    spec.resolve(ok);
  };
  return (
    <Dialog title="That's a big file" onClose={() => done(false)} foot={<>
      <button type="button" className="ghost-btn" onClick={() => done(false)}>cancel</button>
      <button type="button" className="primary-btn" data-autofocus onClick={() => done(true)}>download ≈ {formatBytes(total)}</button>
    </>}>
      <div className="confirm">
        <p className="confirm-lede">{spec.entries.length === 1 ? "This one is big." : "These are big."}</p>
        <ul className="confirm-list">
          {spec.entries.map((e, i) => <li key={i}>{(e.title ? e.title.slice(0, 54) + " · " : "") + "≈ " + formatBytes(e.bytes)}</li>)}
        </ul>
        <p className="confirm-note">It will use ≈ {formatBytes(total)} of data and take longer on a slow connection. Cancel and pick a lower quality if that is not what you want.</p>
      </div>
    </Dialog>
  );
}

function Picker({ itemId }: { itemId: string }) {
  useStore(queueStore, (s) => s.v);
  const item = getItem(itemId);
  const entries = item?.picker?.entries || [];
  const [selected, setSelected] = useState<Set<number>>(() => new Set(entries.map((_, i) => i)));
  const [audio, setAudio] = useState(false);
  const close = () => modalStore.set(null);
  if (!item) return null;
  const toggle = (i: number) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    return next;
  });
  return (
    <Dialog title="Choose items" onClose={close} foot={<>
      <button type="button" className="ghost-btn" onClick={close}>Cancel</button>
      <button type="button" className="primary-btn" data-autofocus onClick={() => {
        close();
        confirmPicker(item, [...selected], audio);
      }}><span>Download selected</span></button>
    </>}>
      <div>
        {!entries.length ? <p className="picker-empty">The API returned an empty picker.</p> : (
          <div className="picker-bulk">
            <button type="button" className="ghost-btn small" onClick={() => setSelected(new Set([0]))}>just the first</button>
            <button type="button" className="ghost-btn small" onClick={() => setSelected(new Set(entries.map((_, i) => i)))}>all {entries.length}</button>
            <span className="picker-bulk-note">or tick them below</span>
          </div>
        )}
        <div className="picker-grid">
          {entries.map((entry, i) => {
            const label = (entry.name || "").trim() || entry.type || "item";
            const thumb = entry.thumb ? resolveUrl(entry.thumb, apiEndpoint()) : "";
            return (
              <button key={i} type="button" className="picker-cell" data-selected={selected.has(i) ? "true" : "false"} onClick={() => toggle(i)}>
                <img alt="" loading="lazy" src={thumb || undefined} referrerPolicy="no-referrer"
                  style={thumb ? undefined : { background: "linear-gradient(135deg, rgba(47,129,247,.22), rgba(63,185,80,.18))" }}
                  onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
                <span className="picker-type">{label.length > 42 ? label.slice(0, 40) + "…" : label}</span>
              </button>
            );
          })}
        </div>
        {item.picker?.audio && (
          <label className="switch-row" style={{ marginTop: 16 }}>
            <span><span className="field-label">Also download background audio</span><span className="field-help">Some slideshows carry a single audio track.</span></span>
            <input type="checkbox" className="switch" checked={audio} onChange={(e) => setAudio(e.target.checked)} />
          </label>
        )}
      </div>
    </Dialog>
  );
}

function Local({ itemId }: { itemId: string }) {
  const item = getItem(itemId);
  const close = () => modalStore.set(null);
  if (!item?.local) return null;
  const { tunnels, type, command } = item.local;
  return (
    <Dialog title="Merge locally" onClose={close} foot={<>
      <button type="button" className="ghost-btn" onClick={() => void copyText(tunnels.join("\n")).then((ok) => ok && toast("Links copied", "info"))}>Copy all links</button>
      <button type="button" className="primary-btn" data-autofocus onClick={close}>Got it</button>
    </>}>
      <div>
        <p className="field-help" style={{ marginBottom: 14 }}>The API served this media as separate streams ({type}). Merge them on your machine. The streams are temporary and expire.</p>
        <ul className="step-list">
          {tunnels.map((_, i) => (
            <li key={i}><code>stream {i + 1}</code><button type="button" className="ghost-btn" onClick={() => saveLocalPart(item, i)}>Save</button></li>
          ))}
        </ul>
        {command && <pre className="code-block" style={{ marginTop: 16 }}>{command}</pre>}
      </div>
    </Dialog>
  );
}

function Report({ service }: { service: string }) {
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const close = () => modalStore.set(null);
  const reasons = ["every link fails", "audio only fails", "it is very slow", "wrong file"];
  const send = async (reason: string) => {
    setSending(true);
    try {
      const res = await fetch(apiEndpoint() + "reports", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ service, note: [reason, note.trim()].filter(Boolean).join(" · ").slice(0, 500) }),
      });
      if (!res.ok) throw new Error();
      toast("Thanks. It goes to the person who runs the server.", "ok");
      close();
    } catch {
      toast("That did not go through. Try again later.", "warn");
    } finally {
      setSending(false);
    }
  };
  return (
    <Dialog title={"Is " + service + " broken?"} onClose={close} foot={<button type="button" className="ghost-btn" onClick={close}>cancel</button>}>
      <div>
        <p className="field-help" style={{ marginBottom: 12 }}>Only the service name and what you pick go with it. The link you pasted does not.</p>
        <div className="field-row wrap-row">
          {reasons.map((r) => <button key={r} type="button" className="ghost-btn small" disabled={sending} onClick={() => void send(r)}>{r}</button>)}
        </div>
        <textarea className="board-text" rows={2} maxLength={300} placeholder="anything else? (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ marginTop: 12 }} />
      </div>
    </Dialog>
  );
}

function Help() {
  const close = () => uiStore.set((s) => ({ ...s, helpOpen: false }));
  return (
    <Dialog title="How it works" onClose={close} foot={<>
      <button type="button" className="primary-btn" data-autofocus onClick={close}>got it</button>
    </>}>
      <div className="help">
        <p className="help-lede">The page cannot fetch video by itself. A small API does that. The address in Settings is the one it uses, and the file streams straight back to you.</p>
        <ol className="steps">
          <li><div><strong>Drop a link</strong><span>Paste it above, or put it after the address: <code>mdown.cc/&lt;link&gt;</code>. Both start on their own.</span></div></li>
          <li><div><strong>Pick the output</strong><span>video with sound, audio only, or silent video. The row under the field shows the size before you commit.</span></div></li>
          <li><div><strong>Keep the file</strong><span>It lands in your downloads. On iOS that is <b>Files → Downloads</b>, on Android <b>Downloads</b>. Cancel and nothing half-written is kept.</span></div></li>
        </ol>
        <h3 className="help-sub">Questions</h3>
        <div className="faq">
          <details><summary>Why does it need a server?</summary><p>A browser can't fetch video from most sites on its own. mdown borrows a server that can. The default one comes with the site; you only touch <b>Settings → Server</b> to use your own.</p></details>
          <details><summary>Where do my files go?</summary><p>Your normal downloads. The queue is gone when you close the tab. On the server the file exists only long enough to hand it over.</p></details>
          <details><summary>Does it work on my phone?</summary><p>Yes. Same page, same queue. Bookmark or send <code>mdown.cc/&lt;link&gt;</code> and opening it starts the download.</p></details>
          <details><summary>Spotify?</summary><p>No. Spotify, Deezer, Tidal and Apple Music encrypt their audio, so mdown refuses them and says so. The same track is usually on YouTube or SoundCloud.</p></details>
          <details><summary>Is it open source?</summary><p>Yes. MIT, all of it: <a href="https://github.com/kelllar/mdown" rel="noopener">github.com/kelllar/mdown</a>. Fork it, run the API yourself, and the downloads never touch this server. <a href="terms.html#source">The terms</a> say the same thing at greater length.</p></details>
          <details><summary>Why did a link fail?</summary><p>Usually private, region-locked, age-gated, longer than 30 minutes, or rate limited. The row says which, and retry re-sends it.</p></details>
          <details><summary>What does it keep?</summary><p>Settings and a short list of recent links, in this browser only. No account, no analytics. The server keeps no record of what you download: no link, no file name, no address, no history. A finished file is deleted after it is handed over.</p></details>
        </div>
        <p className="help-note"><b>Respect copyright.</b> Use it for what you own, what is licensed for reuse, or what the service allows.</p>
      </div>
    </Dialog>
  );
}

export function Modals() {
  const spec = useStore(modalStore);
  const help = useStore(uiStore, (s) => s.helpOpen);
  if (spec?.kind === "confirm") return <Confirm spec={spec} />;
  if (spec?.kind === "picker") return <Picker key={spec.itemId} itemId={spec.itemId} />;
  if (spec?.kind === "local") return <Local itemId={spec.itemId} />;
  if (spec?.kind === "report") return <Report service={spec.service} />;
  if (help) return <Help />;
  return null;
}
