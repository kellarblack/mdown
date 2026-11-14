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
  enabled: false,

  /* one line under the headline, optional */
  note: "",

  /* Stripe Payment Link, e.g. "https://buy.stripe.com/xxxxxxxx"
     Only the URL — the page shows the tier buttons only when this exists. */
  stripe: "",

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
    // { id: "xmr", label: "Monero", value: "", note: "no memo, no email" },
    // { id: "btc", label: "Bitcoin", value: "" },
    // { id: "ltc", label: "Litecoin", value: "" }
  ]
};
