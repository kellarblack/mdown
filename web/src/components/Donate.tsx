import { useState } from "react";
import { COIN, DONATE, maskAddress, type DonateMethod } from "../donate-config";
import { SERVICE_MARKS } from "../marks";
import { toast } from "../store";
import { onNav } from "../routing";
import { IconArrow, IconCard, IconCheck, IconCopy, IconPaste, Svg } from "../icons";
import { copyText, cx } from "../util";

const PAGE_URL = "https://mdown.cc";
const BLURB = "mdown: media downloader for video and audio. no ads, no accounts, no tracking.";
const SHARES: [string, string, string, string][] = [
  ["x", "x", SERVICE_MARKS.twitter!, "https://x.com/intent/post?text=" + encodeURIComponent(BLURB) + "&url=" + encodeURIComponent(PAGE_URL)],
  ["threads", "threads", SERVICE_MARKS.threads!, "https://www.threads.net/intent/post?text=" + encodeURIComponent(BLURB + " " + PAGE_URL)],
  ["reddit", "reddit", SERVICE_MARKS.reddit!, "https://www.reddit.com/submit?url=" + encodeURIComponent(PAGE_URL) + "&title=" + encodeURIComponent(BLURB)],
  ["bsky", "bluesky", SERVICE_MARKS.bluesky!, "https://bsky.app/intent/compose?text=" + encodeURIComponent(BLURB + " " + PAGE_URL)],
];

function useCopied(): [boolean, (text: string, message: string) => void] {
  const [done, setDone] = useState(false);
  return [done, (text, message) => {
    void copyText(text).then((ok) => {
      if (!ok) return toast("Couldn't copy. Select it and copy by hand.", "warn");
      toast(message, "ok");
      setDone(true);
      setTimeout(() => setDone(false), 1100);
    });
  }];
}

function Address({ method }: { method: DonateMethod }) {
  const [shown, setShown] = useState(false);
  const [copied, copy] = useCopied();
  const full = String(method.value || "");
  const toggle = () => setShown((v) => !v);
  return (
    <div className="addr" data-coin={method.id}>
      {COIN[method.id] && <Svg className="coin-icon" html={COIN[method.id]!} />}
      <span className="addr-left">
        <span className="addr-label">{method.label || method.id}</span>
        {method.href ? (
          <a className="addr-value" href={method.href} rel="noopener noreferrer" target="_blank">{method.href.replace(/^https?:\/\//, "")}</a>
        ) : (
          <code className={cx("addr-value", shown && "is-revealed")} data-address={full} tabIndex={0} role="button" aria-pressed={shown}
            title={shown ? "click to hide the address" : "click to show the whole address"} onClick={toggle}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggle();
              }
            }}>{shown ? full : maskAddress(full)}</code>
        )}
        {method.note && <span className="addr-note">{method.note}</span>}
      </span>
      {!method.href && full && (
        <button className={cx("addr-copy", copied && "is-copied")} type="button" aria-label={"copy " + (method.label || "address")}
          onClick={() => copy(full, "Address copied")}>
          {copied ? <IconCheck /> : <IconCopy />}
        </button>
      )}
    </div>
  );
}

export function DonateView({ hidden }: { hidden: boolean }) {
  const [copied, copy] = useCopied();
  const open = DONATE.enabled && (!!DONATE.stripe || !!DONATE.liberapay || DONATE.methods.length > 0);
  return (
    <main className="wrap donate-page" data-view-panel="donate" hidden={hidden}>
      <section className="donate-hero">
        <div className="donate-hero-copy">
          <p className="donate-kicker">support</p>
          <h1 className="donate-headline">free is the <br />whole idea.</h1>
          <p className="donate-sub">no ads, no accounts, no tracking, and no plan to change that. if it earned an evening, leave a tip. if it didn't, keep using it.</p>
        </div>
        <div className="donate-hero-art" aria-hidden="true">
          <svg className="tip-coins" viewBox="0 0 200 132" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <g transform="rotate(7 128 36)">
              <circle cx="128" cy="36" r="20" fill="currentColor" fillOpacity="0.045" /><circle cx="128" cy="36" r="20" />
              <path d="m128 25 8.5 11.5-8.5 5-8.5-5z" /><path d="m119.5 39 8.5 9.5 8.5-9.5" />
            </g>
            <g transform="rotate(-9 62 30)">
              <circle cx="62" cy="30" r="19" fill="currentColor" fillOpacity="0.045" /><circle cx="62" cy="30" r="19" />
              <path d="M58 21h5.6a4 4 0 0 1 0 8H58z" /><path d="M58 29h6.2a4 4 0 0 1 0 8H58z" /><path d="M58 21v16M61.5 18.5v2.5M61.5 37v2.5" />
            </g>
            <g>
              <circle cx="92" cy="82" r="34" fill="currentColor" fillOpacity="0.05" /><circle cx="92" cy="82" r="34" strokeWidth="2.4" />
              <path d="M92 60v44" strokeWidth="2.2" />
              <path d="M104 68.5c-2.6-4.4-7-6.5-12-6.5-7 0-12 3.4-12 8.8 0 5.6 4.8 7.7 12 9.5 7.2 1.8 12 4 12 9.5 0 5.4-5 8.8-12 8.8-5 0-9.4-2.1-12-6.5" strokeWidth="2.4" />
              <path d="M69 65a27 27 0 0 1 15-9.5" opacity="0.35" />
            </g>
          </svg>
        </div>
      </section>

      <section className="support" id="support" aria-labelledby="support-title">
        <div className="support-head">
          <h2 id="support-title">the tip jar</h2>
          <span className="support-state">{open ? "open" : "closed"}</span>
        </div>
        <p className="support-lede">the site is free and stays free. a tip is a thank you, not a price. card if that is easiest, a coin if you would rather.</p>
        {open ? (
          <>
            <div className="support-ways">
              {DONATE.stripe && (
                <a className="support-row support-primary support-card" href={DONATE.stripe} target="_blank" rel="noopener noreferrer">
                  <span className="support-icon" aria-hidden="true"><IconCard /></span>
                  <span className="support-copy"><b>credit card</b><span>one-time · handled by stripe</span></span>
                  <span className="support-go" aria-hidden="true"><IconArrow /></span>
                </a>
              )}
              {DONATE.liberapay && (
                <a className="support-row" href={DONATE.liberapay} target="_blank" rel="noopener noreferrer">
                  <span className="support-icon" aria-hidden="true"><IconArrow /></span>
                  <span className="support-copy"><b>monthly</b><span>recurring · cancel whenever</span></span>
                  <span className="support-go" aria-hidden="true"><IconArrow /></span>
                </a>
              )}
            </div>
            {DONATE.methods.length > 0 && (
              <div className="support-alt">
                <p className="support-alt-lede">or send crypto</p>
                <div className="addr-grid">{DONATE.methods.map((m) => <Address key={m.id} method={m} />)}</div>
                <p className="support-fine">bitcoin and ethereum are public ledgers; monero hides the amount and both sides. send only the asset named on the row.</p>
              </div>
            )}
            <div className="support-foot"><span>a tip is a thank you and nothing else. nothing about the site changes either way.</span></div>
          </>
        ) : (
          <div className="support-empty">
            <p><b>the jar is closed for now.</b></p>
            <p>no dead buttons, no placeholder links. when there is somewhere to send a tip, it appears here. until then, the site is the same either way.</p>
            <p className="support-empty-link"><a href="./" onClick={onNav("download")}>go download something →</a></p>
          </div>
        )}
      </section>

      <section className="donate-facts" aria-label="What a tip does">
        <div className="fact"><span className="fact-k">buys nothing</span><p>no tier, no badge, no faster queue. every download is the same download.</p></div>
        <div className="fact"><span className="fact-k">no name attached</span><p>no account, no email, no mailing list. the page cannot tell who you are.</p></div>
        <div className="fact"><span className="fact-k">stays free</span><p>no ads and no tracking whether the jar is full, empty or closed.</p></div>
      </section>

      <section className="share-card" aria-labelledby="share-title">
        <div className="share-head">
          <h2 id="share-title">or just pass it on</h2>
          <p>one person finding mdown is worth more than a tip. no tracking links, no referral tags. the link is the link.</p>
          <p className="share-src">the source is on <a href="https://github.com/kelllar/mdown" rel="noopener">GitHub</a>.</p>
        </div>
        <div className="share-actions">
          <button type="button" className={cx("share-copy-btn", copied && "is-copied")} onClick={() => copy(PAGE_URL, "Link copied")}>
            <span>{copied ? "copied" : "copy link"}</span>
            {copied ? <IconCheck /> : <IconPaste />}
          </button>
          <div className="share-chips" role="group" aria-label="Share mdown">
            {SHARES.map(([id, label, icon, href]) => (
              <a key={id} className="share-chip" data-share={id} href={href} target="_blank" rel="noopener noreferrer">
                <Svg className="share-icon" html={icon} />
                <span className="share-label">{label}</span>
              </a>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
