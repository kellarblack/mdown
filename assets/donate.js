/* ---------------------------------------------------------------
   Donations — off until you fill this in.

   Nothing here identifies you if you follow three rules:

   1. Crypto only, or a tip page that is not in your name.
      A wallet address is public but says nothing about who owns it.
      A Ko-fi / Buy Me a Coffee / Patreon page shows whatever name the
      account has, and often the payout name, to every donor.

   2. Never put an email, a real name or a link to a personal site here.
      This file is public — it ships to every visitor's browser.

   3. Use a donation-specific address if you want to keep it unlinkable
      from anything else you own. One address reused across the internet
      can be clustered; a fresh one cannot.

   To turn it on: set enabled: true and fill methods. Each method is one
   of two shapes:

     { id: "xmr", label: "Monero", value: "4...", note: "no memo needed" }
     { id: "kofi", label: "Ko-fi", href: "https://ko-fi.com/xxx", note: "shows the account name" }

   `value` renders as copyable monospace text. `href` renders as a link
   that opens in a new tab with no referrer. Anything you leave out is
   simply not shown.
   --------------------------------------------------------------- */
window.MDOWN_DONATE = {
  enabled: false,

  /* shown above the methods, keep it short */
  note: "",

  methods: [
    // { id: "xmr", label: "Monero", value: "", note: "no memo, no email" },
    // { id: "btc", label: "Bitcoin", value: "" },
    // { id: "ln",  label: "Lightning", value: "" }
  ]
};
