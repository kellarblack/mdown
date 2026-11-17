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
  xmr: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2 22V9l10-7 10 7v13h-3.6V12L12 17.6 5.6 12v10z"/></svg>',
  btc: '<svg viewBox="0 0 320 512" fill="currentColor" aria-hidden="true"><path d="M48 32C48 14.3 62.3 0 80 0s32 14.3 32 32V64h32V32c0-17.7 14.3-32 32-32s32 14.3 32 32V64c0 1.5-.1 3.1-.3 4.5C254.1 82.2 288 125.1 288 176c0 24.2-7.7 46.6-20.7 64.9c31.7 19.8 52.7 55 52.7 95.1c0 61.9-50.1 112-112 112v32c0 17.7-14.3 32-32 32s-32-14.3-32-32V448H112v32c0 17.7-14.3 32-32 32s-32-14.3-32-32V448H41.7C18.7 448 0 429.3 0 406.3V288 265.7 224 101.6C0 80.8 16.8 64 37.6 64H48V32zM64 224H176c26.5 0 48-21.5 48-48s-21.5-48-48-48H64v96zm112 64H64v96H208c26.5 0 48-21.5 48-48s-21.5-48-48-48H176z"/></svg>',
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
