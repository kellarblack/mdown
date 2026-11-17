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

export const COIN: Record<string, string> = {
  "xmr": "<svg viewBox=\"0 0 24 24\" fill=\"currentColor\" aria-hidden=\"true\"><path d=\"M2 21.5V5.5h20v16h-4V10l-6 9-6-9v11.5z\"/></svg>",
  "btc": "<svg viewBox=\"0 0 320 512\" fill=\"currentColor\" aria-hidden=\"true\"><path d=\"M48 32C48 14.3 62.3 0 80 0s32 14.3 32 32V64h32V32c0-17.7 14.3-32 32-32s32 14.3 32 32V64c0 1.5-.1 3.1-.3 4.5C254.1 82.2 288 125.1 288 176c0 24.2-7.7 46.6-20.7 64.9c31.7 19.8 52.7 55 52.7 95.1c0 61.9-50.1 112-112 112v32c0 17.7-14.3 32-32 32s-32-14.3-32-32V448H112v32c0 17.7-14.3 32-32 32s-32-14.3-32-32V448H41.7C18.7 448 0 429.3 0 406.3V288 265.7 224 101.6C0 80.8 16.8 64 37.6 64H48V32zM64 224H176c26.5 0 48-21.5 48-48s-21.5-48-48-48H64v96zm112 64H64v96H208c26.5 0 48-21.5 48-48s-21.5-48-48-48H176z\"/></svg>",
  "eth": "<svg viewBox=\"0 0 24 24\" fill=\"currentColor\" aria-hidden=\"true\"><path d=\"M11.944 17.97L4.58 13.62 11.943 24l7.37-10.38-7.372 4.35h.003zM12.056 0L4.69 12.223l7.365 4.354 7.365-4.35L12.056 0z\"/></svg>",
  "card": "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\"><rect x=\"2.6\" y=\"5.4\" width=\"18.8\" height=\"13.2\" rx=\"2.6\"/><path d=\"M2.6 10h18.8\"/><path d=\"M6.4 15h3.2\"/></svg>",
  "arrow": "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M5 12h13\"/><path d=\"m12.5 6 6 6-6 6\"/></svg>"
};

/** first six and last six, the way a wallet shows an address */
export const maskAddress = (v: string): string => (v.length > 16 ? v.slice(0, 6) + "…" + v.slice(-6) : v);
