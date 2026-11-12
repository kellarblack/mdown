# What's left

**Status:** the API is live on `136.0.57.157` and downloads real media.
Verified tonight: a real YouTube link → valid 10 MB mp3 in 26 s, ffprobe clean.

---

## Tomorrow — 15 minutes, needs the domain

1. **Buy `mdown.cc`** (~$8.55/yr). Point its nameservers at Cloudflare (free).
2. **DNS record:**
   | type | name | value | proxy |
   | --- | --- | --- | --- |
   | `A` | `api` | `136.0.57.157` | **DNS only (grey)** |
3. Tell me. Caddy gets a certificate in ~20 s, then I run `verify.py`.
4. **Flip the frontend:** `DEFAULT_INSTANCE = "https://api.mdown.cc"` in
   `assets/app.js`, bump `?v=` in `index.html`, push.
5. **Publish the site:** GitHub → Settings → Pages → Source: **GitHub Actions**,
   then Custom domain `mdown.cc`.

## After it's live — the rest of the list

- **UptimeRobot** (free): HTTP monitor on `https://api.mdown.cc/health`, 5 min,
  email alerts. Nothing on the box can tell you the box is dead.
- **API auto-deploy** (optional): three repo secrets — `DEPLOY_HOST`, `DEPLOY_USER`,
  `DEPLOY_SSH_KEY` — plus `git clone` the repo to `/opt/mdown-src` on the box.
  Then a merged PR redeploys the API by itself.
- **Donate link:** not built yet. Decide Ko-fi / Liberapay / GitHub Sponsors, then
  it's one line in the footer.
- **Sponsor slot:** `#slot` exists in `index.html`, hidden. Delete `hidden` to show it.
- **API key:** `MDOWN_API_KEY=` in `/etc/mdown/api.env` when you want friends-only.

## Tune after a week of real traffic

Watch `journalctl -u mdown-api` and the bandwidth panel, then adjust:
`MDOWN_JOB_RATE_MAX` (12/5min), `MDOWN_RATE_MAX` (30/min), `MDOWN_DAILY_JOBS` (500).

## Still unverified (needs the browser back, or real use)

- `tests/tools.test.html` (38) and `tests/remux.test.html` (90) — last green before
  the browser tool was removed from the session
- picker on a real multi-item post
- subtitle embedding on a real file
- `source` audio mode (the 10 MB mp3 above used `mp3`, not `best`)

## Known limits, stated plainly

- Multi-item pickers return page links the client re-posts — fine for playlists,
  untested on Instagram carousels
- Age-gated / login-walled content needs a cookies file
- 1 GB RAM = one download at a time
- YouTube bot checks can return at any time; the fix is cookies or a new IP
- A DMCA complaint ends the hosting. No code prevents that.

---

## Older notes (kept for the record)

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
