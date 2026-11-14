/* ---------------------------------------------------------------
   Donations — off until you fill this in.

   Nothing here identifies you if you follow three rules:

   1. Crypto only, or a tip page that is not in your name.
      A wallet address is public but says nothing about who owns it.
      A Ko-fi / Buy Me a Coffee / Patreon page shows whatever name the
      account has, and often the payout name, to every donor.

   2. Never put an email, a real name or a link to a personal site here.
      This file is public — it ships to every visitor's browser.

   3. Use a donation-specific wallet if you want to keep it unlinkable
      from anything else you own. One address reused across the internet
      can be clustered; a fresh one cannot.

   enabled: false hides the footer link, the donate page's controls, and the
   dialog. `/donate.html` still resolves, and says donations are closed.

   Card payments need a Stripe Payment Link (one-time) and/or a Liberapay
   profile (recurring). Both are optional and both expose your name at
   payout — that is the trade, not a bug.
   --------------------------------------------------------------- */
window.MDOWN_DONATE = {
  enabled: true,

  /* one line under the headline, optional */
  note: "",

  /* Stripe Payment Link, e.g. "https://buy.stripe.com/xxxxxxxx"
     Only the URL — the page shows the tier buttons only when this exists. */
  stripe: "https://donate.stripe.com/bJe00jcEDg27fReaG55Ne00",

  /* Liberapay profile, e.g. "https://liberapay.com/yourname" */
  liberapay: "",

  /* suggested one-time amounts; shown only when `stripe` is set */
  tiers: [
    { amount: 5, label: "cup of coffee" },
    { amount: 10, label: "full size pizza" },
    { amount: 15, label: "full lunch" },
    { amount: 30, label: "lunch for two" }
  ],

  /* `value` renders as copyable monospace text; `href` renders as a link.
     Anything left out is simply not shown. */
  methods: [
    { id: "xmr", label: "monero", value: "45aNapD3TKJij5kxJXgc38CR2r6B5vm4BAFypBLxJgnebQEDBYDTNRoKpwtLguQEsHAeJfTxi21KvJecohNZ5MZMD3vUo1p", note: "private by default" },
    { id: "btc", label: "bitcoin", value: "bc1qxcfuxt84ksr2sxh6ee65c5qs8mpsuxvqw8u242", note: "native segwit · lowest fees" },
    { id: "eth", label: "ethereum", value: "0x5daE2C9048a8d4AF00A948bc2FAdBf7885689197", note: "eth and erc-20 tokens" }
  ]
};

/* ---------------------------------------------------------------
   Coin glyphs and address masking, in one place because the dialog and
   donate.html both draw the same rows. Everything is inline, monochrome and
   currentColor: no icon fonts, no requests, no brand colours fighting the
   page. The last six characters stay visible because that is what a person
   checks before sending; the rest is what malware swaps.
   --------------------------------------------------------------- */
window.MDOWN_COIN = {
  xmr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"/><path d="M8 16.2V9.4l4 4.6 4-4.6v6.8"/></svg>',
  btc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"/><path d="M10.4 7.6h3.1a2.2 2.2 0 0 1 0 4.4h-3.1z"/><path d="M10.4 12h3.3a2.2 2.2 0 0 1 0 4.6h-3.3z"/><path d="M10.4 7.6v9M12 6.4v1.2M12 16.6v1.2"/></svg>',
  eth: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"/><path d="M12 6.5 16 12.3l-4 2.3-4-2.3z"/><path d="m8 13.5 4 4.1 4-4.1"/></svg>',
  card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="2.6" y="5.4" width="18.8" height="13.2" rx="2.6"/><path d="M2.6 10h18.8"/><path d="M6.4 15h3.2"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13"/><path d="m12.5 6 6 6-6 6"/></svg>'
};

window.MDOWN_MASK = function (value) {
  var v = String(value == null ? "" : value);
  if (v.length <= 10) return v;
  return "******" + v.slice(-6);
};
