# Later, when you can be bothered

Nothing here is urgent. The site is built, tested and sitting in `mdown/`.
This is just the order to do it in.

---

## 1. Buy the box — 5 min

**https://dedione.com/store/special-vps-plans/20260520-lax-vps-intl-1c1g20g-special-1299**

- $12.99/year · 1 vCPU · 1 GB · 20 GB · 1 TB/mo · Los Angeles
- OS: **Ubuntu 24.04**
- SSH key:
  ```
  ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB4XxOGTGKmumpcyN32nY+pVZRDh/C1MKIg8e0jX9p17 mdown-api
  ```
- Don't save the card (nothing auto-renews)

## 2. Send me the IP — 10 seconds

Then I run `deploy-to.sh`, which installs everything, and **probe YouTube against
that IP first**. You have 24 hours to cancel if the IP is burned — so this is the
step to do before anything else.

## 3. DNS — 1 min

| type | name | value | proxy |
| --- | --- | --- | --- |
| `A` | `api` | `<the IP>` | DNS only (grey) |

## 4. Uptime monitor — 5 min

UptimeRobot → new HTTP(s) monitor → `https://api.mdown.cc/health`, 5 minutes,
email alert. Nothing on the box can tell you the box is dead.

## 5. Point the site at it — I do this

`DEFAULT_INSTANCE = "https://api.mdown.cc"` in `assets/app.js`, bump the `?v=`,
upload `mdown/` to Cloudflare Pages.

## 6. Optional, later

- Cloudflare Pages auto-deploy: add `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
  to repo secrets, `.github/workflows/deploy.yml` does the rest
- A donor link, if you ever want one

---

## Already done, don't redo

- Budget alert `zero-spend` ✅
- All code, tests (76 backend / 38 tools / 90 remux), terms, status page ✅
- yt-dlp auto-update timer ships in `install.sh` ✅
- Daily job cap + per-IP download burst limit ✅

## Known gaps (nobody's fault, just true)

- Multi-item posts (carousels) aren't supported — the API never returns a picker
- Age-gated / login-walled content needs a cookies file
- 1 GB RAM = one download at a time; upgrade to 2 GB if that annoys you
- No ads that are worth having; AdSense rejects this category
