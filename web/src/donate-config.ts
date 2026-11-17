/* the tip jar, moved from assets/donate.js. Never put a name or an email here: it ships to every visitor. */
export interface DonateMethod { id: string; label: string; value?: string; href?: string; note?: string }
export interface DonateTier { amount: number; label: string }
export interface DonateConfig { enabled: boolean; note: string; stripe: string; liberapay: string; tiers: DonateTier[]; methods: DonateMethod[] }

export const DONATE: DonateConfig = {
  "enabled": true,
  "note": "",
  "stripe": "https://donate.stripe.com/bJe00jcEDg27fReaG55Ne00",
  "liberapay": "",
  "tiers": [
    {
      "amount": 5,
      "label": "cup of coffee"
    },
    {
      "amount": 10,
      "label": "full size pizza"
    },
    {
      "amount": 15,
      "label": "full lunch"
    },
    {
      "amount": 30,
      "label": "lunch for two"
    }
  ],
  "methods": [
    {
      "id": "xmr",
      "label": "monero",
      "value": "45aNapD3TKJij5kxJXgc38CR2r6B5vm4BAFypBLxJgnebQEDBYDTNRoKpwtLguQEsHAeJfTxi21KvJecohNZ5MZMD3vUo1p",
      "note": "private by default"
    },
    {
      "id": "btc",
      "label": "bitcoin",
      "value": "bc1qxcfuxt84ksr2sxh6ee65c5qs8mpsuxvqw8u242",
      "note": "native segwit · lowest fees"
    },
    {
      "id": "eth",
      "label": "ethereum",
      "value": "0x5daE2C9048a8d4AF00A948bc2FAdBf7885689197",
      "note": "eth and erc-20 tokens"
    }
  ]
};

/* one family: the same circle, the same stroke, the mark drawn inside it */
export const COIN: Record<string, string> = {
  xmr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10.2"/><path d="M4.4 15.4h3.2V8.7l4.4 4.5 4.4-4.5v6.7h3.2"/></svg>',
  btc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10.2"/><path d="M9.6 7.2h3.7a2.4 2.4 0 0 1 0 4.8H9.6z"/><path d="M9.6 12h4.2a2.4 2.4 0 0 1 0 4.8H9.6z"/><path d="M9.6 7.2v9.6M11.1 5.6v1.6M13.2 5.6v1.6M11.1 16.8v1.6M13.2 16.8v1.6"/></svg>',
  eth: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10.2"/><path d="M12 5.2 8 11.8l4 2.4 4-2.4z"/><path d="M8 13.2l4 5.6 4-5.6-4 2.4z"/></svg>',
};

/** first six and last six, the way a wallet shows an address */
export const maskAddress = (v: string): string => (v.length > 16 ? v.slice(0, 6) + "…" + v.slice(-6) : v);
