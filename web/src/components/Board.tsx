import { useCallback, useEffect, useState } from "react";
import { apiEndpoint, authHeaders } from "../api";
import { instanceStore, settingsStore, useStore } from "../store";

/* The request board: off unless the address asks for it (?board=1) and the
   instance says it has a moderator. One public line, nothing attached. */

interface Entry {
  id: string;
  t: number;
  text: string;
}

const BOARD_ENABLED = typeof location !== "undefined" && /[?&]board=(?!0)/.test(location.search);
const TAG = "public · no name · no account";

function ago(stamp: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - Number(stamp || 0)));
  if (s < 45) return "just now";
  if (s < 5400) return Math.max(1, Math.round(s / 60)) + "m ago";
  if (s < 172800) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

async function post(path: string, body: unknown, auth = false): Promise<Response> {
  return fetch(apiEndpoint() + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...(auth ? authHeaders() : {}) },
    body: JSON.stringify(body),
  });
}

export function Board() {
  const enabled = useStore(instanceStore, (s) => !!s.info?.board) && BOARD_ENABLED;
  const hasKey = useStore(settingsStore, (s) => !!s.apiKey);
  const [items, setItems] = useState<Entry[]>([]);
  const [pending, setPending] = useState<Entry[]>([]);
  const [inbox, setInbox] = useState<Entry[]>([]);
  const [say, setSay] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(apiEndpoint() + "requests", { headers: { Accept: "application/json" }, cache: "no-store" });
      if (!res.ok) throw new Error();
      const data = await res.json();
      const list: Entry[] = Array.isArray(data.items) ? data.items : [];
      setItems(list);
      setSay(list.length ? "" : "nothing yet. yours can be the first.");
    } catch {
      setSay("the board is not answering right now.");
    }
    if (!hasKey) return;
    try {
      const res = await fetch(apiEndpoint() + "requests/pending", { headers: { Accept: "application/json", ...authHeaders() }, cache: "no-store" });
      if (res.ok) setPending((await res.json()).items || []);
      const rep = await fetch(apiEndpoint() + "reports", { headers: { Accept: "application/json", ...authHeaders() }, cache: "no-store" });
      if (rep.ok) setInbox((await rep.json()).items || []);
    } catch {
      /* moderation is optional */
    }
  }, [hasKey]);

  useEffect(() => {
    if (enabled && open) void load();
  }, [enabled, open, load]);

  if (!enabled) return null;

  const moderate = async (path: string, entry: Entry, after: () => void) => {
    try {
      const res = await post(path, { id: entry.id }, true);
      if (!res.ok) throw new Error();
      after();
    } catch {
      setSay("that did not go through.");
    }
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const line = text.trim();
    if (line.length < 3 || sending) return;
    setSending(true);
    try {
      const res = await post("requests", { text: line });
      if (res.status === 429) setSay("that is a lot of asks. try again in an hour.");
      else if (!res.ok) setSay("that did not go through.");
      else {
        setText("");
        setSay("thanks. it shows up once it has been read.");
      }
    } catch {
      setSay("that did not go through.");
    } finally {
      setSending(false);
    }
  };

  const waiting = pending.length;
  return (
    <section className="board" id="board">
      <details className="board-disclosure" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary className="board-summary">
          <span className="section-label" id="board-title">ask for a tool</span>
          <span className="board-tag">{waiting ? waiting + " to review" : TAG}</span>
          <span className="board-toggle" aria-hidden="true" />
        </summary>
        <div className="board-body">
          {inbox.length > 0 && (
            <div className="board-inbox">
              <div className="board-review-head"><span className="board-tag">broken-service reports</span><span className="board-count">{inbox.length} waiting</span></div>
              <ul className="board-list" aria-label="broken service reports">
                {inbox.map((entry) => (
                  <li key={entry.id} className="board-item is-review">
                    <p className="board-line">{entry.text}</p>
                    <span className="board-meta">{ago(entry.t)}</span>
                    <button type="button" className="ghost-btn small" onClick={() => void moderate("reports/handled", entry, () => setInbox((l) => l.filter((x) => x !== entry)))}>handled</button>
                    <button type="button" className="ghost-btn small" onClick={() => void moderate("reports/delete", entry, () => setInbox((l) => l.filter((x) => x !== entry)))}>delete</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {waiting > 0 && (
            <div className="board-review">
              <div className="board-review-head"><span className="board-tag">waiting for a yes</span><span className="board-count">{waiting} waiting</span></div>
              <ul className="board-list" aria-label="waiting requests">
                {pending.map((entry) => (
                  <li key={entry.id} className="board-item is-review">
                    <p className="board-line">{entry.text}</p>
                    <span className="board-meta">{ago(entry.t)}</span>
                    <button type="button" className="ghost-btn small" onClick={() => void moderate("requests/approve", entry, () => {
                      setPending((l) => l.filter((x) => x !== entry));
                      setItems((l) => [entry, ...l]);
                    })}>show</button>
                    <button type="button" className="ghost-btn small" onClick={() => void moderate("requests/delete", entry, () => setPending((l) => l.filter((x) => x !== entry)))}>hide</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="board-copy">a service that should work here, or something this should do. one line, and it goes on the board below. nothing about you goes with it.</p>
          <form className="board-form" noValidate onSubmit={(e) => void send(e)}>
            <label className="sr-only" htmlFor="board-text">your request</label>
            <textarea id="board-text" className="board-text" rows={2} maxLength={240} placeholder="what should this do?" spellCheck
              value={text} onChange={(e) => setText(e.target.value)} />
            <div className="board-foot">
              <span className="board-count">{text.length} / 240</span>
              <button className="ghost-btn" type="submit" disabled={text.trim().length < 3 || sending}>send</button>
            </div>
          </form>
          <p className="board-state" role="status" aria-live="polite" hidden={!say}>{say}</p>
          <ol className="board-list" aria-label="recent requests">
            {items.slice(0, 12).map((entry) => (
              <li key={entry.id} className="board-item">
                <p className="board-line">{entry.text}</p>
                <span className="board-meta">{ago(entry.t)}</span>
              </li>
            ))}
          </ol>
        </div>
      </details>
    </section>
  );
}
