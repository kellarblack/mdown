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
  /* mark only: no disc, no background, every one at the same size and
     upright, so the row reads as three coins and not three stickers */
  xmr: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0C5.365 0 0 5.373 0 12.015c0 1.335.228 2.607.618 3.81h3.577V5.729L12 13.545l7.805-7.815v10.095h3.577c.389-1.203.618-2.475.618-3.81C24 5.375 18.635 0 12 0zm-1.788 15.307l-3.417-3.421v6.351H1.758C3.87 21.689 7.678 24 12 24s8.162-2.311 10.245-5.764h-5.04v-6.351l-3.386 3.421-1.788 1.79-1.814-1.79h-.005z"/></svg>',
  btc: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23.638 14.904c-1.602 6.43-8.113 10.34-14.542 8.736C2.67 22.05-1.244 15.525.362 9.105 1.962 2.67 8.475-1.243 14.9.358c6.43 1.605 10.342 8.115 8.738 14.548v-.002zm-6.35-4.613c.24-1.59-.974-2.45-2.64-3.03l.54-2.153-1.315-.33-.525 2.107c-.345-.087-.705-.167-1.064-.25l.526-2.127-1.32-.33-.54 2.165c-.285-.067-.565-.132-.84-.2l-1.815-.45-.35 1.407s.975.225.955.236c.535.136.63.486.615.766l-1.477 5.92c-.075.166-.24.406-.614.314.015.02-.96-.24-.96-.24l-.66 1.51 1.71.426.93.242-.54 2.19 1.32.327.54-2.17c.36.1.705.19 1.05.273l-.51 2.154 1.32.33.545-2.19c2.24.427 3.93.257 4.64-1.774.57-1.637-.03-2.58-1.217-3.196.854-.193 1.5-.76 1.68-1.93h.01zm-3.01 4.22c-.404 1.64-3.157.75-4.05.53l.72-2.9c.896.23 3.757.67 3.33 2.37zm.41-4.24c-.37 1.49-2.662.735-3.405.55l.654-2.64c.744.18 3.137.524 2.75 2.084v.006z"/></svg>',
  eth: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.944 17.97L4.58 13.62 11.943 24l7.37-10.38-7.372 4.35h.003zM12.056 0L4.69 12.223l7.365 4.354 7.365-4.35L12.056 0z"/></svg>',
  card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="2.6" y="5.4" width="18.8" height="13.2" rx="2.6"/><path d="M2.6 10h18.8"/><path d="M6.4 15h3.2"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13"/><path d="m12.5 6 6 6-6 6"/></svg>'
};

/* First six and last six, the way a wallet shows an address: the middle is
   what malware swaps, the ends are what a person checks. Asterisks read as a
   password field, which is exactly what an address is not. */
window.MDOWN_MASK = function (value) {
  var v = String(value == null ? "" : value);
  if (v.length <= 14) return v;
  return v.slice(0, 6) + "\u2026" + v.slice(-6);
};
