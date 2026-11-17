import { useState } from "react";
import { COIN, DONATE, type DonateMethod } from "../donate-config";
import { SERVICE_MARKS } from "../marks";
import { toast } from "../store";
import { onNav } from "../routing";
import { IconArrow, IconCard, IconCheck, IconCopy, Svg } from "../icons";
import { copyText, cx } from "../util";

const PAGE_URL = "https://mdown.cc";
const BLURB = "mdown: media downloader for video and audio. no ads, no accounts, no tracking.";
const SHARES: [string, string, string][] = [
  ["x", SERVICE_MARKS.twitter!, "https://x.com/intent/post?text=" + encodeURIComponent(BLURB) + "&url=" + encodeURIComponent(PAGE_URL)],
  ["threads", SERVICE_MARKS.threads!, "https://www.threads.net/intent/post?text=" + encodeURIComponent(BLURB + " " + PAGE_URL)],
  ["reddit", SERVICE_MARKS.reddit!, "https://www.reddit.com/submit?url=" + encodeURIComponent(PAGE_URL) + "&title=" + encodeURIComponent(BLURB)],
  ["bluesky", SERVICE_MARKS.bluesky!, "https://bsky.app/intent/compose?text=" + encodeURIComponent(BLURB + " " + PAGE_URL)],
];

/** groups of four, so a person can check an address against their wallet */
const grouped = (v: string) => v.replace(/(.{4})(?=.)/g, "$1 ");

function useCopy(message: string): [boolean, (text: string) => void] {
  const [done, setDone] = useState(false);
  return [done, (text) => {
    void copyText(text).then((ok) => {
      if (!ok) return toast("Couldn't copy. Select it and copy by hand.", "warn");
      toast(message, "info");
      setDone(true);
      setTimeout(() => setDone(false), 1400);
    });
  }];
}

function Crypto({ methods }: { methods: DonateMethod[] }) {
  const [active, setActive] = useState(0);
  const [copied, copy] = useCopy("Address copied");
  const m = methods[Math.min(active, methods.length - 1)]!;
  const value = String(m.value || "");
  return (
    <section className="tj-block" aria-labelledby="tj-crypto">
      <h2 className="tj-label" id="tj-crypto">or send crypto</h2>
      <div className="tj-tabs" role="tablist" aria-label="coin">
        {methods.map((x, i) => (
          <button key={x.id} type="button" role="tab" id={"tj-tab-" + x.id} aria-selected={i === active} aria-controls="tj-coin"
            className="tj-tab" onClick={() => setActive(i)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              e.preventDefault();
              const next = (active + (e.key === "ArrowRight" ? 1 : methods.length - 1)) % methods.length;
              setActive(next);
              document.getElementById("tj-tab-" + methods[next]!.id)?.focus();
            }}
            tabIndex={i === active ? 0 : -1}>
            {COIN[x.id] && <Svg className="tj-coin" html={COIN[x.id]!} />}
            <span>{x.label || x.id}</span>
          </button>
        ))}
      </div>
      <div className="tj-addr" id="tj-coin" role="tabpanel" aria-labelledby={"tj-tab-" + m.id}>
        {m.href ? (
          <a className="tj-addr-value" href={m.href} target="_blank" rel="noopener noreferrer">{m.href.replace(/^https?:\/\//, "")}</a>
        ) : (
          <>
            <code className="tj-addr-value" translate="no">{grouped(value)}</code>
            <div className="tj-addr-foot">
              <span className="tj-note">{m.note}</span>
              <button type="button" className={cx("tj-copy", copied && "is-copied")} onClick={() => copy(value)}
                aria-label={"copy " + (m.label || "address")}>
                {copied ? <IconCheck /> : <IconCopy />}<span>{copied ? "copied" : "copy address"}</span>
              </button>
            </div>
          </>
        )}
      </div>
      <p className="tj-fine">send only {m.label || m.id} to this address. bitcoin and ethereum are public ledgers; monero hides the amount and both sides.</p>
    </section>
  );
}

export function DonateView({ hidden }: { hidden: boolean }) {
  const [copied, copy] = useCopy("Link copied");
  const open = DONATE.enabled && (!!DONATE.stripe || !!DONATE.liberapay || DONATE.methods.length > 0);
  return (
    <main className="wrap tj" data-view-panel="donate" hidden={hidden}>
      <header className="tj-intro">
        <p className="tj-kicker"><span className={cx("tj-dot", open && "is-open")} aria-hidden="true" />tip jar · {open ? "open" : "closed"}</p>
        <h1 className="tj-title">keep mdown free.</h1>
        <p className="tj-lede">no ads, no accounts, no tracking. a tip pays for the server and buys nothing else. if it didn't earn one, keep using it anyway.</p>
        <ul className="tj-facts">
          <li><b>buys nothing</b><span>no tier, no badge, no faster queue</span></li>
          <li><b>no name attached</b><span>no account, no email, no list</span></li>
          <li><b>stays free</b><span>full jar or empty, nothing changes</span></li>
        </ul>
      </header>

      <div className="tj-jar">
        {open ? (
          <>
            {(DONATE.stripe || DONATE.liberapay) && (
              <section className="tj-block" aria-labelledby="tj-card">
                <h2 className="tj-label" id="tj-card">give once</h2>
                {DONATE.stripe && (
                  <a className="tj-primary" href={DONATE.stripe} target="_blank" rel="noopener noreferrer">
                    <span className="tj-primary-icon" aria-hidden="true"><IconCard /></span>
                    <span className="tj-primary-copy"><b>card, apple pay, google pay</b><span>any amount · handled by stripe</span></span>
                    <IconArrow className="tj-go" />
                  </a>
                )}
                {DONATE.liberapay && (
                  <a className="tj-secondary" href={DONATE.liberapay} target="_blank" rel="noopener noreferrer">
                    <span>monthly, via liberapay</span><IconArrow className="tj-go" />
                  </a>
                )}
              </section>
            )}
            {DONATE.methods.length > 0 && <Crypto methods={DONATE.methods} />}
          </>
        ) : (
          <section className="tj-block">
            <p className="tj-lede"><b>the jar is closed for now.</b> when there is somewhere to send a tip, it appears here.</p>
            <a className="tj-secondary" href="./" onClick={onNav("download")}><span>go download something</span><IconArrow className="tj-go" /></a>
          </section>
        )}

        <section className="tj-block" aria-labelledby="tj-share">
          <h2 className="tj-label" id="tj-share">or pass it on</h2>
          <div className="tj-share">
            <button type="button" className={cx("tj-chip tj-chip-copy", copied && "is-copied")} onClick={() => copy(PAGE_URL)}>
              {copied ? <IconCheck /> : <IconCopy />}<span>{copied ? "copied" : "mdown.cc"}</span>
            </button>
            {SHARES.map(([label, icon, href]) => (
              <a key={label} className="tj-chip" href={href} target="_blank" rel="noopener noreferrer" aria-label={"share on " + label}>
                <Svg className="tj-chip-icon" html={icon} /><span>{label}</span>
              </a>
            ))}
          </div>
          <p className="tj-fine">no tracking links, no referral tags. the source is on <a href="https://github.com/kelllar/mdown" rel="noopener noreferrer">github</a>.</p>
        </section>
      </div>
    </main>
  );
}
