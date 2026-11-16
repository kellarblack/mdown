# Make the mdown.cc hero lockup look designed

## What this is
mdown.cc is a free, ad-free media downloader: one static page (plain HTML/CSS/JS, no build step) that
talks to a small API. Monochrome only — near-black page (#0a0a0b), off-white text (#ededee), no
colour except a single accent dot. Monospace type throughout (system mono stack: ui-monospace,
"SF Mono", Menlo, Consolas).

The user has iterated the logo many times and is still not happy: "the logo still doesn't look that
good". They want it to look like a serious product made by a company with a design team, not a
side-project wordmark.

## The thing to fix
The hero lockup at the top of the page: a download-arrow-into-tray mark next to the wordmark
`mdown.cc`, centred, sitting above the paste field.

Files (absolute paths):
- `/Users/kellarblack/Documents/Default Project/mdown/index.html` — the hero markup is the
  `<h1 class="hero-logo">` block, around lines 292–305
- `/Users/kellarblack/Documents/Default Project/mdown/assets/app.css` — the hero rules are the
  block starting at the comment `/* one gesture, on the same curve as the mode switch ... */`
  and the rules `.hero-mark`, `.hero-word`, `.hero-word-m`, `.hero-word-down`, `.hero-word-dot`,
  `.hero-word-sub`, `.hero-logo`, around lines 2270–2340

The current markup and CSS are pasted in full in `baseline.md`. That is the version the user is
unhappy with.

## What the user has already rejected (do not repeat these)
- a tagline under the logo (`an ad-free download tool`) — "corny"
- a soft radial spotlight behind the logo — trying too hard
- per-letter or per-word drop-in choreography — "amateur"
- a three-beat cascade (mark, then word, then tagline) — three things pretending to be one
- overshoot / bounce on the word — "reads as a toy"
- moving the whole lockup up 8px on load — makes the page feel like it jumps
- the mark wrapped in a circle, and a `?` glyph drawn as a circle
- a stacked, boxed logo lockup (mark in a rounded square above the word)

## What has been liked, for reference
- the arrow drops into the tray while the second half of the name ("down") falls with it: one paired
  gesture, ~760ms, no bounce
- thin 1.6–1.8px strokes everywhere; nothing heavy
- the mode switch (auto / audio / video): one object that moves, on the site's easing curve

## Hard requirements
1. Plain HTML + CSS in the two files above. No images, no SVG files, no webfonts, no JS required for
   the visual result (JS may not be added for this).
2. Monochrome, using the existing custom properties (`--text`, `--text-2`, `--text-3`, `--accent`,
   `--mono`). No new colours, no glow, no coloured shadows, no gradients.
3. Animation, if any: transform and opacity only, one-shot, no infinite loops, no bounce or overshoot,
   and it must not change layout (nothing may move outside the lockup). Must be disabled under
   `prefers-reduced-motion: reduce`.
4. Responsive from 320px to 1440px without wrapping or clipping. The lockup is hidden on landscape
   phones (existing media query) — keep that behaviour.
5. Keep the page's semantics: the `<h1>` stays, the wordmark stays real text (not an image), the mark
   stays `aria-hidden`.
6. Do not change anything else on the page: not the composer, not the top bar, not the footer.

## What "done" looks like
A lockup that reads as one designed object:
- the optical weight of the mark balanced against the wordmark (size ratio, stroke weight, gap)
- the wordmark's letterspacing, the `.` and the `cc` treated as typography rather than leftovers
- vertical alignment that looks right to the eye, not just mathematically centred
- one quiet entrance that does not draw attention to itself
- nothing that would look out of place on a good product site

## Deliverable
Write the exact changes the user can apply:
- the replacement HTML block for the hero (complete, copy-pasteable)
- the replacement CSS block (complete, with the selectors it replaces named)
- a short "why this, not the old one" — maximum 150 words, in plain language
- a two-line verification: what to look at at 1440px and at 360px

Assume the reader has the two files open and will paste your blocks in.
