# mdown

**Donations are off by default.** Fill in `assets/donate.js` to show a tip jar.
Crypto addresses only, or a tip page that is not in your name — the dialog never
loads anything from a third party. `python3 tests/privacy_check.py` fails the
build if the published site ever carries a name, an email or a tracker.

**Open source, MIT.** The front-end is plain HTML/CSS/JS with no build step; the
API is Python stdlib + yt-dlp + ffmpeg. Fork it, run your own instance, send a PR.

- **Site:** published to GitHub Pages from `main` by `.github/workflows/pages.yml`
- **API:** deployed to a VPS separately — `server/deploy/deploy-to.sh <ip>` (see `DEPLOY.md`)
- **No secrets in the repo.** `cookies.txt`, `keys.json` and `*.env` are gitignored; keep them that way.

Want to work on it? `python3 -m http.server 4331` in this folder is the whole dev
setup, and `server/tests` runs with `python3 -m unittest discover -s tests`.


A quiet front-end for the [cobalt](https://github.com/imputnet/cobalt) media API — the same
capabilities as `cobalt.tools`, rebuilt as a single static page with no build step, no
framework, and no telemetry.

Plain HTML + CSS + JavaScript. No Node, no bundler, no dependencies.

## Why a separate front-end

`cobalt.tools` is only the UI; downloads are done by a cobalt **API instance**. The hosted
API applies per-IP limits and is not meant for third-party clients, so this page talks to
**an instance you point it at**.

- Run your own: [self-hosting guide](https://github.com/imputnet/cobalt/blob/main/docs/run-an-instance.md)
- Or use an instance whose owner gave you access (and an API key if it requires one).

## Run it

```sh
cd mdown
python3 -m http.server 4331
# open http://127.0.0.1:4331/index.html
```

Then: **Settings → Connection → API address**, paste e.g. `https://cobalt.example.com`,
press **Check**. A green pill in the header means the instance answered.

Anything that can serve static files works (GitHub Pages, Caddy, nginx). There is nothing to
compile.

## One-line downloads

Besides pasting into the box, a link can be handed over in the address bar. Whichever form you
use, the app starts fetching on load:

```
mdown.cc/?url=https://youtube.com/watch?v=dQw4w9WgXcQ
mdown.cc/https://youtube.com/watch?v=dQw4w9WgXcQ
mdown.cc/youtube.com/watch?v=dQw4w9WgXcQ
```

The query form works on any static host. The pretty path form needs a host that serves
`404.html` for unknown paths (GitHub Pages, Netlify, Cloudflare Pages all do) — that file hands
the path back to the app and the URL is cleaned up afterwards so a refresh doesn't fetch twice.

There is also a **bookmarklet** in Settings → Advanced: drag it to your bookmarks bar and one
click sends whatever page you're on straight here.

### Lookalike hosts (optional)

If you ever own a short variant of a service's domain, add it to `SERVICE_ALIASES` in
`assets/app.js` and links typed into it are rewritten automatically:

```js
"yout.cc": "youtube.com"   //  yout.cc/watch?v=x  ->  youtube.com/watch?v=x
```

That is the "delete a couple of letters and it just downloads" trick — it needs the domain, the
code is already there.

## What it does

- **Queue with real progress.** Files are streamed with `fetch` and a `ReadableStream`, so the
  bar reflects actual bytes from `Content-Length` / `Estimated-Content-Length`. Cancel any
  transfer mid-flight.
- **Multiple links at once.** Paste a block of links (or several lines) and up to 10 are queued,
  with 3 running concurrently.
- **Picker support.** Services that return several photos/videos open a selectable grid, plus
  the background audio option when the API offers it.
- **Local-processing dialog.** If the instance returns separate streams (`merge`, `remux`,
  `audio`, `mute`, `gif`), the item explains what to do, lists every tunnel, and gives a ready
  `ffmpeg` command instead of silently failing.
- **Full v11 settings**, mapped 1:1 to API keys: download mode, quality, codec, container,
  audio format/bitrate, dub and subtitle languages, filename style with a live preview,
  metadata stripping, always-proxy, local processing, saving method.
- **Instance awareness.** `GET /` is used for version, uptime, commit and the supported-service
  list, which is shown as chips and used to warn when a link's service isn't offered.
- **Detection as you type.** The service is named right in the field (`youtube`, `soundcloud`, …),
  and audio-first services offer a one-click switch to audio mode.
- **Readable errors.** API error codes are translated (`api.content.video.private` →
  "The video is private."), with `context.service` / `context.limit` appended.
- **Output is shown before you fetch.** Each mode button carries its real output
  (`mp4 · 1080p`, `wav`, `mp3 · 128k`, `mp4 · muted`), and the sliders icon jumps straight to
  the matching format pane.
- **Transfer telemetry.** Percentage, bytes of total, current speed and an ETA, not just a bar.
- **Parallel downloads** you can tune (1–5) from Advanced.
- **Drag and drop.** Drop links — or a `.txt` of links — anywhere on the page to queue them.
- **Audio-first suggestions.** SoundCloud, Bandcamp, Mixcloud, Audiomack and hearthis.at links
  offer a one-click switch to audio mode instead of assuming video.
- **Session stats** in the queue header: saved count, bytes, failures.
- **An About section** on the page: the three-step flow plus a short FAQ (instance, formats,
  where files go, what's stored, why a link fails).
- **Theme follows the system** until you override it in Settings → Appearance (system / light /
  dark), with a pre-paint script so there is no flash. Focus trap in the settings sheet,
  reduced-motion support, `⌘K` for settings and `Esc` to close.
- **Local-only state.** Settings and recent links live in `localStorage`. No accounts, no
  cookies, no analytics, no advertising, and no third-party requests — the optional bot
  check some instances enable is the only thing that can load an external script, and the
  hosted instance leaves it off.

## Settings → API mapping

| UI | API key | Values |
| --- | --- | --- |
| download mode | `downloadMode` | `auto` `audio` `mute` |
| video quality | `videoQuality` | `4320` `2160` `1440` `1080` `720` `480` `360` `240` `144` — clamped on load and again in the request body |
| YouTube codec | `youtubeVideoCodec` | `h264` `av1` `vp9` |
| YouTube container | `youtubeVideoContainer` | `auto` `mp4` `webm` `mkv` |
| audio format | `audioFormat` | `best` (untouched source) `mp3` `ogg` `opus` `wav` |
| cover art | `audioCovers` | boolean — embed the thumbnail in mp3, ogg and opus |
| bitrate | `audioBitrate` | `128` `96` `64` `8` — clamped to 128, ignored for `wav` |
| filename style | `filenameStyle` | `classic` `basic` `pretty` `nerdy` |
| strip metadata | `disableMetadata` | boolean |
| always tunnel | `alwaysProxy` | boolean |
| local processing | `localProcessing` | `disabled` `preferred` `forced` |
| subtitle language | `subtitleLang` | ISO 639-1, omitted when `none` |
| dub language | `youtubeDubLang` | ISO 639-1, omitted for `original` |
| better audio | `youtubeBetterAudio` | **not sent** — removed with the quality caps, kept only so old stored settings migrate cleanly |
| HLS | `youtubeHLS` | **not sent** — same reason |
| GIF conversion | `convertGif` | boolean |
| h265 | `allowH265` | boolean |
| TikTok original sound | `tiktokFullAudio` | boolean |
| parallel downloads | — | client-side only (`concurrency`, 1–5) |

The **Advanced → Request preview** pane shows the exact JSON body for the current settings.

## Remux (fully local, no upload)

`#remux` is a second view, linked in the header. Drop files, they are repackaged on the device.

- **Engine**: ffmpeg.wasm 5.1.4 — `@ffmpeg/ffmpeg@0.12.10` + `@ffmpeg/core@0.12.6`, vendored in
  `assets/vendor/ffmpeg/` (~31 MB). Nothing is fetched from a CDN at runtime, and the engine is
  imported only when the first file is added, so the downloader page never pays for it.
- **What it does**: `-c copy` only. Streams are moved, not re-encoded, so output quality is
  bit-identical. `-movflags +faststart` rewrites the MP4 index, `-fflags +genpts` rebuilds missing
  timestamps, and zeroed `mvhd`/`tkhd` durations are recalculated.
- **Targets**: mp4/mov → mp4 (or m4a when there is no video), webm → webm, mkv → mp4 when the
  codecs fit (h264/hevc/av1) else mkv, ogg/opus → ogg/opus, mp3 → mp3, wav → wav.
- **Not supported**: FLAC (rejected before processing), anything needing a codec change (explained
  in the error), and damaged frame data — a container rewrite can't fix corrupt media.
- **Privacy**: bytes go into the WASM filesystem, are remuxed there, and come back as a Blob.
  No request carries file data. Temp files are deleted after every job, object URLs are revoked on
  remove/clear/unload, and the worker is terminated on cancel or page hide.
- **Memory**: files are read into memory once, so very large files (multi-GB) can run out of
  memory. That failure is reported instead of silently failing.

## Traffic: what 400+ people actually costs

The site is static and the remux tool is client-side, so **the page itself scales for free** —
no server executes anything for a visitor.

| what | per visitor | 400 visitors |
| --- | --- | --- |
| page, CSS, JS | ~140 KB | ~56 MB |
| remux engine (first use only) | 31 MB raw, ~10 MB brotli | ~4–12 GB |
| downloads | streamed from your API, not from the static host | API bandwidth |

Pick the host accordingly:

- **GitHub Pages — what mdown.cc uses.** Free, 100 GB/month soft limit, and it ignores
  `_headers`, so cache policy comes from the query-versioned asset URLs.
- **Cloudflare Pages — free, unlimited bandwidth, honours `_headers`.** The better host if you
  expect the engine to be fetched a lot; `_headers` is already written for it.
- **Netlify — free, 100 GB/month, also honours `_headers`.**

`_headers` sets a one-year immutable cache on the engine there, so repeat visits cost nothing.
The `.wasm` is ~31 MB, compressed automatically to roughly 10 MB.

The real ceiling is the **API instance**, not this site. Every download is a stream through it.
400 people doing one download each is fine for a well-provisioned instance; 400 people pulling
3 at once is not. Limits that keep it alive: the client never runs more than 3 fetches per
visitor, the instance has its own rate limits, and the queue is per-tab. If you expect sustained
traffic, put the API behind Cloudflare too and cap its rate limit deliberately.

## Subtitles (`#subs`)

Pulls embedded subtitle tracks out of a file as `.srt`. It probes the real streams
(`ffmpeg -i`) and lists each track with its language, name and codec.

- Text codecs (`subrip`, `ass`, `mov_text`, `webvtt`, …) convert to SRT with `-c:s srt`.
- Image codecs (`hdmv_pgs_subtitle`, `dvd_subtitle`, …) are shown but disabled with an
  "image — can't export" badge. There is no OCR here and the UI says so.
- A file with no subtitle tracks says so — subtitles are never invented from audio.
- Output names are `original.<lang>.srt`, with `-2` suffixes on collisions.

## Metadata (`#clean`)

Strips container tags — title, artist, comment, creation time, location — with
`-map 0 -c copy -map_metadata -1 -fflags +bitexact` (plus `+faststart` for MP4).

- Streams are copied, never re-encoded, and the output is re-probed to report what was
  actually removed and what is left.
- Technical fields that playback needs (`major_brand`, `compatible_brands`, `handler_name`)
  are filtered out of both the report and the "removed" count.
- It cannot remove watermarks, burned-in text, or data inside the encoded frames, and the
  UI says exactly that. No anonymisation claims.

Both tools share the remux engine (one WASM instance, one 31 MB fetch) and are loaded
lazily. Files are read into the WASM filesystem and never leave the tab; a network check
during extraction and cleaning recorded **zero** fetch/XHR calls.

## Tests

```sh
python3 -m http.server 4331          # from the repo folder
open http://127.0.0.1:4331/tests/remux.test.html   # 90 assertions
open http://127.0.0.1:4331/tests/tools.test.html   # 38 assertions
open http://127.0.0.1:4331/tests/picker.test.html  # 13 assertions (needs mock-api.py 4320)
open http://127.0.0.1:4331/tests/picker.test.html?w=390  # same, at phone width
open http://127.0.0.1:4331/tests/status.test.html  # 11 assertions (needs mock-api.py 4320)
```

**Everything at once:** `./tests/run-all.sh` — backend plus every browser suite
(97 backend + 365 browser). It starts the mock and a static server itself.

Backend alone: `cd server && python3 -m unittest discover -s tests`.

**Headless runs** (no devtools needed). Do *not* pass `--virtual-time-budget` —
it freezes the clock the WASM engine needs, and the suite hangs:

```sh
python3 tests/mock-api.py 4320 &
python3 -m http.server 4331 &
rm -f /tmp/mdown-report.json
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --user-data-dir=/tmp/mdown-run "http://127.0.0.1:4331/tests/tools.test.html?report=1" &
# the page POSTs its results to /report; read /tmp/mdown-report.json
```

## Before you deploy

Full walkthrough, including the free backend: **[DEPLOY.md](DEPLOY.md)**.

The short version:

1. **Get an API instance** — a cobalt v11 server. `DEPLOY.md` builds one on any Ubuntu VPS,
   with the 8k / 128 kb/s / 30-minute caps this front-end assumes. Nothing is bundled here:
   without an instance the page says "not connected" and downloads nothing.
2. **Set a default API** — in `assets/app.js`, top of the file:
   ```js
   const DEFAULT_INSTANCE = "https://your-api.example.com";
   ```
   Leave it empty and every visitor has to connect one themselves. Set it and the page
   connects on first load.
3. **Host it anywhere static** — GitHub Pages, Netlify, Cloudflare Pages. Upload the folder as
   it is; there is nothing to build.
4. **Keep `404.html` at the root** — that file is what makes
   `yourdomain/<pasted link>` work. It detects whether you are at a domain root or a project
   subfolder, forwards the link to the app, and refuses to loop.
5. **HTTPS on** — the API, the bookmarklet and the clipboard all expect a secure context.
6. **CORS on the API** — the instance must send `Access-Control-Allow-Origin` for your domain,
   or the browser blocks every request. Self-hosted cobalt does this by default; narrowing it
   to one origin means `CORS_WILDCARD=0` plus an exact `CORS_URL`.

Append `#help` to the URL to open the how-it-works dialog directly.

## Development

No test framework is installed here, so verification is done with a mock API plus a scripted
screenshot harness:

```sh
python3 tests/mock-api.py 4320 &          # mock cobalt API (tunnel/picker/local/error)
python3 -m http.server 4331 &
open http://127.0.0.1:4331/tests/visual.html?view=queue
```

`tests/visual.html?view=` accepts `queue`, `mobile`, `video`, `audio`, `metadata`, `privacy`,
`advanced`, `light`. It points the app at `http://127.0.0.1:4320` and drives the UI so a
headless browser can capture it:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --hide-scrollbars --window-size=1440,1400 \
  --screenshot=.shots/queue.png --virtual-time-budget=9000 \
  "http://127.0.0.1:4331/tests/visual.html?view=queue"
```

`window.md.state()` exposes the live queue for console checks.

## Known limits

- **Turnstile is supported and off by default.** If an instance advertises `turnstileSitekey`
  the page renders the widget and sends `turnstileToken` with each request; the API checks it
  with `MDOWN_TURNSTILE_SECRET`. The hosted instance advertises the key only when the secret is
  set, because a widget nobody verifies is a ten-second wait for nothing.
- **Local processing** hands you the streams and the command. Bundling ffmpeg.wasm would add a
  ~30 MB third-party download, which this project deliberately avoids.
- Redirect-style responses are opened directly, so no byte-level progress is available for
  those (the API serves a direct link instead of a tunnel).
- **Audio output is limited by the API**: `mp3`, `ogg`, `wav`, or `opus`. The API cannot encode
  m4a, AAC or FLAC, so there is no such option in the UI. `source` (`best`) keeps the
  untouched stream and skips ffmpeg entirely; the bitrate ceiling is 128 kb/s for lossy
  re-encodes. wav ignores the bitrate setting: it is
  uncompressed PCM (≈42 MB for a 4-minute track), so it avoids a second lossy encode but is
  ~11× the size of mp3 and no better than whatever the source stream was.
- **Duration is capped by the instance, not the page** — `MDOWN_MAX_DURATION=1800` means 30 minutes
  for youtube, soundcloud and vimeo. The front-end can't know a length before the API fetches
  it, so it translates the API's `content.too_long` error instead of pretending to check.
- **Service recognition is wider than any instance.** The hostname map covers more sites than
  cobalt ships; the instance still decides what it can actually fetch, and the composer warns
  when a recognised service is missing from its list. Pinterest is intentionally left out.

## Files

```
index.html          markup, settings sheet, modal
404.html            pretty deep links on static hosts
status.html         live API health, uptime strip, copy-a-report
terms.html          terms & ethics, plain language
assets/app.css      design tokens, layout, motion
assets/app.js       API client, queue, settings, UI wiring
DEPLOY.md           how to stand up the backend and publish the site
server/             the download API (stdlib HTTP + yt-dlp + ffmpeg)
server/deploy/      systemd unit, Caddyfile, install script
server/tests/       97 unit + contract tests, no network needed
tests/mock-api.py   mock cobalt API (stdlib only)
tests/visual.html   screenshot harness
tests/remux.test.html  90 assertions for the remux tool
tests/make-media.html  regenerates the media fixtures with ffmpeg.wasm
tests/spa-server.py static server that mimics GitHub Pages 404 fallback
.shots/             reference screenshots
```

## Credit

Protocol and behaviour follow [imputnet/cobalt](https://github.com/imputnet/cobalt) (v11 API).
This is an independent UI; it is not affiliated with the cobalt project. You are responsible
for what you download and for respecting copyright and each service's terms.
