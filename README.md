# mdown

[mdown.cc](https://mdown.cc) is a free media downloader: paste a link, pick video or audio, keep
the file. No ads, no account, no tracking. The page is plain HTML, CSS and JavaScript with no
build step and no dependencies. The work happens on a small Python 3 API that this repo also
contains: stdlib http server, yt-dlp and ffmpeg, speaking the cobalt v11 request shape. Both
halves are MIT licensed, with one vendored exception noted at the end. The page is static and
hosted on GitHub Pages; the API is one process on one VPS, because a browser cannot fetch video
from most sites by itself. There is nothing to buy and nothing to sign up for; the running costs
are covered by optional tips.

## run it

```sh
git clone https://github.com/kelllar/mdown
cd mdown
python3 -m http.server 4331     # then open http://127.0.0.1:4331/
```

There is nothing to install and nothing to compile. Any static file server will do.

A fresh clone points at `https://api.mdown.cc`. `DEFAULT_INSTANCE` at the top of
`assets/app.js`. That instance only accepts requests from `https://mdown.cc`, so locally the page
loads and nothing downloads. Run your own API with
`MDOWN_CORS_ORIGINS=http://127.0.0.1:4331`, or open settings (⌘K, ctrl-K elsewhere, or the gear
in the header), go to **Server**, paste an instance you may use, and press **Check**. A green pill
in the header means it answered.

Change `DEFAULT_INSTANCE` before you publish a fork, or leave it empty and every visitor starts
with no server connected.

## self-host the api

`server/` is the API. One Python process, standard library only, shelling out to `yt-dlp` and
`ffmpeg`. It is written for Ubuntu 22.04 or 24.04 on 1 vCPU and 1 GB of RAM: no Docker, no
database, no GPU. For a 1 GB box set `MDOWN_MAX_CONCURRENT=1`.

From this repo, on a machine that can SSH to the VM:

```sh
bash server/deploy/deploy-to.sh <vps-ip> root
```

That copies `server/`, installs the packages, creates the `mdown` user and a venv, writes
`/etc/mdown/api.env`, installs the systemd units and Caddy, and gets a certificate. Re-running it
is the update path. `server/deploy/install.sh` does the same work if you would rather be on the
box.

The script is written for this deployment, so two things are hard-coded for `mdown.cc`:

- `server/deploy/Caddyfile` is the site block for `api.mdown.cc`. Change the domain or Caddy
  will ask Let's Encrypt for a certificate it cannot get.
- `install.sh` defaults `API_DOMAIN=api.mdown.cc` and `SITE_ORIGIN=https://mdown.cc`, and the
  second one becomes `MDOWN_CORS_ORIGINS`. Set both in the environment when you run it.

Everything else is a knob in `/etc/mdown/api.env` and `server/mdown_api/config.py` documents each
one. The defaults are ceilings for a small box, not targets: **8K** (`MDOWN_MAX_HEIGHT=4320`),
**30 minutes** (`MDOWN_MAX_DURATION=1800`), **2 GB** per file (`MDOWN_MAX_OUTPUT_MB=2048`),
**2 downloads at once and 6 waiting**, **500 jobs per day**, and per-address rate limits
(30 requests a minute, 60 downloads per 5 minutes). A finished file is deleted 60 seconds after
it is handed over, or after 15 minutes if nobody fetches it.

An API key (`MDOWN_API_KEY`) and a Cloudflare Turnstile check (`MDOWN_TURNSTILE_SITEKEY` plus
`MDOWN_TURNSTILE_SECRET`) are both optional and both off by default. With the key unset the API
is open to any client whose origin is listed in `MDOWN_CORS_ORIGINS`, which is the right shape
for a personal instance.

## what it does not do

- **no drm.** netflix, spotify, disney+, prime video, audible: the media is encrypted on purpose
  and the request fails. the error says so. there is no attempt to work around it.
- **no logins.** no account here means nothing behind a sign-in: private videos, member-only
  posts, subscriber streams, most age-gated content. a server operator can add their own
  `cookies.txt` for a source that needs one; the public instance does not ship one.
- **no paywalls, no region locks.** rented and subscribed content is out, and so is pretending
  to be in another country.
- **no piracy.** it does not host, index, mirror or share anything. one link becomes one file for
  one person, from that person's own request, and the file is deleted afterwards. there is no
  library and no way to hand a download to somebody else.
- **no OCR.** image-based subtitles (PGS, VobSub) are detected and named, not converted to text.
- **no watermark removal.** tags in the container can be stripped; pixels cannot.

what you download, and whether you may, is yours to weigh. the terms page says it at length.

## how it fits together

```
browser              static host            api (one vps)
-------              -----------            -------------
GET /, assets/*      <-- files, nothing runs
POST / {url, mode}   ---------------------> yt-dlp fetches, ffmpeg merges
                     <--------------------- {status: "tunnel", url}
GET /tunnel/<token>  ---------------------> the file, range-capable
```

The page never talks to the source site. It asks the API for a job, the API returns one URL, and
the browser streams that URL to disk with `fetch` and a `ReadableStream`, so the progress bar is
real bytes rather than a spinner. The static half can be cached anywhere and costs nothing to
serve; every byte of media passes through the API, which is the part with a bandwidth bill.

The page adds what the API cannot: a queue with real byte progress and mid-transfer cancel, one to
five parallel downloads per tab, a picker grid when a post holds several files, service detection
as you type, and the cobalt v11 settings set mapped one-to-one onto request keys. `404.html` is
what makes `https://mdown.cc/<pasted link>` work on a static host: the host serves it for unknown
paths, and it hands the path back to the app.

`POST /` and `GET /tunnel/<token>` are the cobalt v11 shape, so an ordinary cobalt instance works
as the backend too. `/probe`, `/report`, `/health` and `/uptime` are mdown's own additions,
metadata before download, a bug report from the status page, and the numbers that page shows.

The three local tools (`#remux`, `#subs`, `#clean`) run the other way: `assets/vendor/ffmpeg/`
is ffmpeg.wasm in the tab, the file goes into the WASM filesystem and comes back as a blob. No
request carries it. The engine is about 31 MB, so it is imported only when a tool is first used.

## tests

```sh
./tests/run-all.sh          # everything
./tests/run-all.sh backend  # python only
```

**115 backend tests** (`server/tests`: config, jobs, security, server, uptime) and **455 browser
assertions** across 23 suites (the picker suite runs twice, once at phone width), plus the
privacy check that fails the build if the published site carries a name, an email or a tracker.
The runner starts its own mock API on port 4320 and a static server on 4331, then drives headless
Chrome.

Requirements are `python3` and Google Chrome at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
On another OS, point `CHROME` at your binary. The backend alone needs no network and no browser:

```sh
cd server && python3 -m unittest discover -s tests
```

Do not pass `--virtual-time-budget` to the browser suites: it freezes the clock the WASM engine
needs and they hang.

## licence

MIT, all of it except one directory. The full text is in [LICENSE](LICENSE).

`assets/vendor/ffmpeg/` is `@ffmpeg/core` 0.12.6 (about 31 MB), built from ffmpeg and released
under **GPL-3.0**. It is not MIT and the MIT licence above does not cover it. If you fork this and
republish, that directory keeps its own terms: ship its notices with it, keep the build
identifiable as `@ffmpeg/core` 0.12.6, and offer the corresponding source as GPL-3.0 requires.
The GPL covers the engine; everything in this repo outside `assets/vendor/` is MIT.

Protocol and behaviour follow [imputnet/cobalt](https://github.com/imputnet/cobalt) (v11 API).
This is an independent project and is not affiliated with it.
