# Next

## It is live

| | |
| --- | --- |
| site | https://mdown.cc (GitHub Pages, Enforce HTTPS on) |
| api | https://api.mdown.cc (VPS 136.0.57.157, Let's Encrypt, auto-renew) |
| dns | Porkbun — apex `A`+`AAAA` → GitHub Pages, `A api` → VPS, `www` → apex |
| monitoring | local watchdog every 2 min; GitHub `uptime` workflow every 30 min |
| lighthouse | accessibility 100 · best practices 100 · seo 100 |

Deploy the API: `bash server/deploy/deploy-to.sh 136.0.57.157 root`
Deploy the site: push to `main` — `pages.yml` does it.

## What is left, in order

1. **Verify `mdown.cc` for GitHub Pages.** The custom-domain state stays on
   "DNS Check in Progress" until the domain is verified in
   *Settings → Pages → Verified domains*, and an unverified domain can be
   claimed by someone else if the site is ever removed. One TXT record:

   | type | host | value |
   | --- | --- | --- |
   | `TXT` | `_github-pages-challenge-kellarblack` | `8f6e13355604bb9c980c1c47699b81` |

   Then press **Verify** on `github.com/settings/pages_verified_domains/mdown.cc`.

2. **Donations are off.** Fill in `assets/donate.js` when you want the footer
   link. Crypto addresses only, or a tip page you accept shows its account name.
   Use a dedicated wallet: donation funds in your main wallet are publicly
   traceable and linkable to you.

3. **Optional: UptimeRobot** on `https://api.mdown.cc/health` if you want an
   uptime graph. The issue-based check already emails you when it breaks.

Done already: the Porkbun API key is revoked and "Opt all domains into API
access" is off. DNS changes now need the Porkbun dashboard (or a fresh key).

## Things that will break, and what catches them

| failure | caught by |
| --- | --- |
| API process dies | systemd `Restart=always` |
| API alive but wedged | `mdown-health.timer`, restarts it, logs to `journalctl -t mdown-health` |
| whole box down | GitHub `uptime` workflow opens an issue, closes it on recovery |
| YouTube changes their player | weekly `mdown-ytdlp-update.timer`; a failed download shows `api.content.video.unavailable` |
| disk fills with jobs | TTL sweep (15 min) + `min_free_bytes` guard refuses new jobs |
| certificate expiry | Caddy renews automatically, ~2/3 of the 90-day lifetime |

## Known limits

- 8K is allowed by config but a 30-minute 8K file exceeds the 2 GB output cap.
- YouTube may start demanding sign-in from a datacenter IP. If that happens the
  fix is cookies (`MDOWN_YTDLP_COOKIES`), not retries. See `DEPLOY.md`.
- GitHub Pages ignores `_headers`; the CSP that matters is the one in each
  page's `<meta>`.

## Tests

```sh
./tests/run-all.sh          # 300 assertions + privacy scan, one command
```

If something must be checked by hand, use a real browser against
`https://mdown.cc` — the live site and API are now the best integration test.
