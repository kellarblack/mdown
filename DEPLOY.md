# Deploying mdown.cc

```
mdown.cc            static site      Cloudflare Pages        $0, unlimited bandwidth
api.mdown.cc        mdown API        any Ubuntu 24.04 VPS    $13-22/year, or $0 on Oracle
```

The API is `server/` in this repo: a small Python service that speaks the same
cobalt-v11 contract the front-end already uses, backed by yt-dlp and ffmpeg.
It is not cobalt itself — it implements the same four endpoints, so the site
needs no change beyond its API base URL.

---

## 0. What the VM has to be

Any Ubuntu 24.04 VPS will do. It runs ffmpeg and a small Python service; there is
no GPU, no Docker, no database.

| | minimum | comfortable |
| --- | --- | --- |
| RAM | 1 GB | 2 GB |
| CPU | 1 vCPU | 2 vCPU |
| Disk | 10 GB | 20 GB |
| Transfer | 1 TB/month | 3 TB+ |
| Arch | x86_64 or aarch64 | either |

At 1 GB, set `MDOWN_MAX_CONCURRENT=1`. Audio is effortless at that size; a 1080p
merge works but blocks the queue while it runs.

**Cheap hosts that work** (prices move, check at checkout):

- **DediOne** — Los Angeles, $12.99/yr for 1 vCPU / 1 GB / 20 GB / 1 TB.
- **RackNerd** — $21.99/yr for 1 vCPU / 1 GB / 20 GB / 3 TB. More track record.
- **CloudCone** — ~$20/yr for 2 vCPU / 1.25 GB / 30 GB / 4 TB.
- **Oracle Always Free** — 2 OCPU / 12 GB / 10 TB at $0, *if* your region has
  Ampere capacity. Frequently it doesn't.

Avoid anything IPv6-only: browsers need IPv4 to reach `api.mdown.cc`.

---

## 1. Create the instance

Any provider: pick **Ubuntu 24.04**, one IPv4, and paste your public key at
checkout. Generate the key locally so the private half never leaves your machine:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/mdown_oracle -C mdown-api -N ""
cat ~/.ssh/mdown_oracle.pub      # paste this into the provider
```

Then `ssh -i ~/.ssh/mdown_oracle root@<ip>` (some hosts use `ubuntu@`).

**If you use Oracle**, the extra steps are: shape `VM.Standard.A1.Flex`
(2 OCPU / 12 GB) or `VM.Standard.E2.1.Micro`, an Ubuntu **aarch64** image for the
Ampere shape, and opening ports in both the VCN security list and the host's
iptables (see step 2).

---

## 2. Open the ports

**a) Oracle security list** — VCN → subnet → Security Lists → Default →
Add Ingress Rules: `0.0.0.0/0` → TCP → `80`, and again for `443`.

**b) Ubuntu's own iptables** — Oracle images end in a `REJECT`, so rules must
be inserted above it:

```sh
sudo iptables -L INPUT --line-numbers -n      # find the REJECT line, usually 6
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80  -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo apt install -y iptables-persistent
sudo netfilter-persistent save
```

---

## 3. DNS

| type | name | content | proxy |
| --- | --- | --- | --- |
| `A` | `api` | `<public IP>` | **DNS only** (grey cloud) |

Grey cloud keeps 10 TB of media transfer off Cloudflare's free proxy, which is
not meant to carry it. Caddy still issues a real certificate.

---

## 4. Install the API

From your machine:

```sh
scp -r server ubuntu@<ip>:/tmp/
ssh -i ~/.ssh/mdown_oracle ubuntu@<ip>
sudo bash /tmp/server/deploy/install.sh
```

The script is idempotent and does the whole server side:

- `apt update && apt upgrade`, then `ffmpeg`, `python3-venv`, `ca-certificates`
- a locked-down `mdown` system user (no shell, no home login)
- a venv at `/opt/mdown/venv` with yt-dlp
- `/etc/mdown/api.env` (mode 0600, root-owned) with the limits below
- a hardened systemd unit: `ProtectSystem=strict`, `NoNewPrivileges`,
  `PrivateTmp`, `MemoryMax=3G`, `CPUQuota=180%`, restart on failure
- log rotation

Then Caddy:

```sh
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

sudo cp /tmp/server/deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### The environment file

`/etc/mdown/api.env`, all overridable:

| variable | default | meaning |
| --- | --- | --- |
| `MDOWN_API_URL` | — | public base URL, used to build tunnel links |
| `MDOWN_CORS_ORIGINS` | `https://mdown.cc` | comma-separated, exact origins only |
| `MDOWN_MAX_HEIGHT` | `4320` | hard resolution cap, enforced after download |
| `MDOWN_MAX_DURATION` | `1800` | 30 minutes, in seconds, checked before download |
| `MDOWN_MAX_OUTPUT_MB` | `800` | per-file ceiling, also handed to yt-dlp |
| `MDOWN_MAX_CONCURRENT` | `2` | simultaneous downloads |
| `MDOWN_MAX_QUEUE` | `6` | waiting requests before 429 |
| `MDOWN_JOB_TIMEOUT` | `300` | whole-download timeout |
| `MDOWN_PROBE_TIMEOUT` | `45` | metadata-only timeout |
| `MDOWN_JOB_TTL` | `900` | how long a finished file is kept |
| `MDOWN_MIN_FREE_MB` | `3072` | refuse new jobs below this much free disk |
| `MDOWN_RATE_MAX` / `WINDOW` | `30` / `60` | requests per IP per window |
| `MDOWN_JOB_RATE_MAX` / `WINDOW` | `60` / `300` | **downloads** per IP per window — the burst limiter |
| `MDOWN_DAILY_JOBS` | `500` | hard ceiling per day, all IPs. `0` disables |
| `MDOWN_API_KEY` | empty | set it and every request needs `Authorization: Api-Key …` |
| `MDOWN_REQUIRE_ORIGIN` | `1` | POSTs must carry an allowed `Origin`. CORS alone does **not** stop a request running — this does |

After editing: `sudo systemctl restart mdown-api`.

---

## 5. Verify

```sh
python3 /tmp/server/deploy/verify.py       # end-to-end, prints PASS/FAIL
```

or by hand:

```sh
curl -s https://api.mdown.cc/health | python3 -m json.tool
curl -s https://api.mdown.cc/ | python3 -m json.tool
```

`/health` reports the dependencies it actually found. It returns **503** if
yt-dlp, ffmpeg, ffprobe or the disk check fails, so a green health response is
not by itself proof that a download works — `verify.py` does a real one.

---

## 6. Point the site at it

`assets/app.js`, near the top:

```js
const DEFAULT_INSTANCE = "https://api.mdown.cc";
```

Bump the cache-buster in `index.html` (`assets/app.js?v=9` → `?v=10`), then
publish. The footer then reads `mdown.cc · api mdown-1.0` — that string is the
`cobalt.version` the API reports about itself, not a label baked into the page.

---

## 6b. When YouTube says "confirm you're not a bot"

This is the most likely way the service breaks, and it is not a bug in the code.
Datacenter IPs get challenged; a new VPS may be challenged on day one.

**First, check before you commit.** On the box:

```sh
yt-dlp -J "https://www.youtube.com/watch?v=aqz-KE-bpKQ" | head -c 200
```

JSON means the IP is fine. `Sign in to confirm you're not a bot` means it isn't.

**First: the IP is not yours to rotate.** A VPS gets one address from the host.
It does not change on its own, and "make it dynamic" is not a setting. What you
can do is *swap* it or *route around* it:

- **Ask the host for a new IP.** Some do it free once, some charge a few dollars.
  Worth doing if the range is obviously burned.
- **Route yt-dlp through a proxy.** Already supported:
  ```
  MDOWN_YTDLP_EXTRA_ARGS=--proxy http://user:pass@host:port
  ```
  Datacenter proxies are cheap and mostly already blocked. Residential ones work
  and cost real money per GB. Rotating IPs to dodge limits is also what gets proxy
  ranges banned, so treat it as a repair, not a strategy.
- **Extra IPv6 will not help** — YouTube reaches the same trust decision.

**If it is challenged, in order of effort:**

1. **Update yt-dlp.** It is the extractor layer, and the timer installed by
   `install.sh` already does this weekly:
   `systemctl list-timers mdown-ytdlp-update.timer`
2. **Change the player client** — YouTube serves different clients to different
   callers. Try, in `/etc/mdown/api.env`:
   ```
   MDOWN_YTDLP_EXTRA_ARGS=--extractor-args "youtube:player_client=tv,web_safari"
   ```
   then `systemctl restart mdown-api`.
3. **Cookies.** A logged-in account's cookies satisfy the check:
   ```
   MDOWN_YTDLP_COOKIES=/var/lib/mdown/cookies.txt
   ```
   Export with `yt-dlp --cookies-from-browser chrome --cookies /var/lib/mdown/cookies.txt`.
   Caveat that matters: that account is now attached to every download. Use a
   throwaway, expect it to get rate-limited, and never commit the file.
4. **A different IP.** If the range is burned, no flag fixes it. Ask the host for
   a rebuild, or move.

There is no clean way around this that does not involve either an account or a
residential exit. Anything claiming otherwise is selling you a proxy.

## 6c. If you add advertising

Be clear-eyed: **AdSense will not approve a media downloader.** The networks that
will are the ones serving fake "Download now" buttons and malware — which is
exactly the thing your own UI spends effort not being.

A `#slot` element exists in `index.html`, hidden, styled to fit. Options, worst to
best:

- **Ad network** — revenue is cents, the creative is a scam, and it teaches users
  to distrust your buttons. Not worth it.
- **One self-sold sponsor** — a text line, labelled, no scripts, no cookies, no
  consent banner needed. This is the only version that stays clean.
- **Nothing, plus a donate link** — what cobalt does, and what fits a tool this size.

If you do add a network later: it sets cookies, which means a consent banner for
EU visitors, and a privacy policy that names the network. That is a real amount of
work for a few dollars a month.

## 6d. Keeping it alive after launch

Three things, and only the first needs doing before you share the link.

**1. An external monitor (5 minutes, do it first).**

UptimeRobot free tier → new HTTP(s) monitor → `https://api.mdown.cc/health`,
every 5 minutes, alert to your email. `/health` returns **503** when yt-dlp,
ffmpeg, ffprobe or disk fail, so this catches real breakage — not just a dead
network. Better Stack does the same with a nicer status page.

Nothing inside the box can tell you the box is down. That is what this is for.

**2. Redeploying the site.**

`.github/workflows/deploy.yml` publishes `mdown/` to Cloudflare Pages on every
push to `main`. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to the repo
secrets once and it runs itself. The API is not part of that workflow — it lives
on the VPS and is updated with `deploy-to.sh`.

**3. Keeping it from going stale.**

`mdown-ytdlp-update.timer` upgrades yt-dlp and restarts the service every week.
That is the whole maintenance story for the extractor layer. Check it with:

```sh
systemctl list-timers mdown-ytdlp-update.timer
journalctl -u mdown-ytdlp-update.service -n 20
```

## 6e. Keeping other sites off your instance

CORS is widely misunderstood: it stops a browser from **reading** the response, but
the request still runs and still spends your bandwidth. So the API also checks
`Origin` server-side (`MDOWN_REQUIRE_ORIGIN=1`, on by default) and answers **403**
to anything that does not name an allowed origin.

What that does and does not buy you:

- **Stops another website** pointing its front-end at your instance — the realistic
  abuse case. Blocked.
- **Does not stop curl.** Anyone can add `-H "Origin: https://mdown.cc"`. A header
  is a claim, not proof.
- **Does not stop someone reading your JS.** An API key in a static file is public.

If you need it actually closed, the only real answer is a login: accounts, sessions,
per-user keys. That is a different product, and it is not what you have.

What you *do* have: origin enforcement, per-IP request limits, a per-IP download
burst limit, a 500/day ceiling, and unguessable single-use tunnel tokens. Enough to
make abuse annoying, visible and bounded — not enough to make it impossible.

## 7. Publish the static site

Cloudflare Pages → Create project → Direct upload (no build step) → drag the
contents of `mdown/`. Keep `_headers` and `404.html` at the root: the first
sets cache policy, the second makes `mdown.cc/<pasted link>` work.

---

## Capacity, honestly

With 1440p / 128 kb/s / 30 min caps:

| download | size | 10 TB buys |
| --- | --- | --- |
| mp3 128k, 4 min | ~3.8 MB | ~2,600,000 |
| wav, 4 min | ~42 MB | ~240,000 |
| wav, 30 min | ~318 MB | ~32,000 |
| 1440p, 30 min (worst case) | ~1.1 GB | ~9,300 |

Two concurrent jobs on 2 OCPU is the real limit, not bandwidth: yt-dlp and
ffmpeg are mostly network-bound during download and briefly CPU-bound during
a merge. Raise `MDOWN_MAX_CONCURRENT` only after watching `htop` and
`/health` under load.

---

## If it grows

1. **Rate limits** — lower `MDOWN_RATE_MAX`, raise `MDOWN_MAX_QUEUE`.
2. **Per-person keys** — set `MDOWN_API_KEY` to a long random string and give
   it to friends; each pastes it into Settings → Connection. One shared key is
   the honest simple option; per-user keys would need a user store.
3. **Everything is per-process state** — jobs and rate limits live in memory,
   so a restart clears them. That is deliberate: it is also what guarantees no
   stale files survive a crash.

---

## Known limits

- **No Turnstile.** The front-end has no challenge widget, so this API is
  either open or key-protected; it does not implement `POST /session`.
- **Age-restricted and login-walled content fails** unless cookies are supplied
  to yt-dlp. Not configured.
- **Job state is in memory**, so a restart loses in-flight jobs. Finished files
  are swept from disk regardless.
- **Rebinding is mitigated, not eliminated** — see the note at the top of
  `server/mdown_api/security.py`.
- **Oracle can reclaim an idle Always Free instance.** Uptime is not promised
  by the free tier.
