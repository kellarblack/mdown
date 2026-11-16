# The version the user is unhappy with

## Markup (index.html)

```html
<h1 class="hero-logo">
      <span class="hero-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <!-- the arrow is its own group so it can travel into the tray: the
               mark reads as something being downloaded, not as a shape fading -->
          <g class="mark-arrow"><path d="M12 3v12"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/></g>
          <path class="mark-tray" d="M4 19h16"/>
        </svg>
      </span>
      <span class="hero-word"><span class="hero-type"><span class="hero-word-m">m</span><span class="hero-word-down">down</span><span class="hero-word-dot">.</span><span class="hero-word-sub">cc</span></span></span>
      <span class="sr-only"> — a media downloader for video and audio</span>
    </h1>
```

## CSS (assets/app.css), the hero block, top to bottom

```css
.hero { width: 100%; }
/* one flow: the arrow rises, the name follows it, the line follows the name.
   Same gesture each time, 70ms apart, so the eye reads it as one movement. */
.hero-logo {
  display: flex; align-items: center; justify-content: center; gap: 14px;
  margin: 0 auto 10px;
  color: var(--text);
}

.hero-mark {
  display: grid; place-items: center; flex: none;
  width: clamp(34px, 5vw, 44px); height: clamp(34px, 5vw, 44px);
  color: var(--text);
}
/* One gesture, one curve, one duration: the mark and the word arrive together
   and the second half settles into place. Transform and opacity only — both are
   compositor properties, so the animation never re-lays-out the page, never
   repaints text, and finishes in about half a second. No overshoot: a bounce at
   this size reads as a toy. */
.hero-mark svg { width: 100%; height: 100%; }

/* The lockup does not move as a block — that is what made the page feel like it
   jumped. It fades in where it already is, and then the arrow drops into the
   tray while the second half of the name falls with it. Nothing else moves. */
.hero-logo { animation: hero-fade-in 240ms var(--ease) both; }
@keyframes hero-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
.mark-arrow {
  animation: arrow-drop 760ms cubic-bezier(0.22, 0.75, 0.2, 1) both;
}
@keyframes arrow-drop {
  from { transform: translate3d(0, -9px, 0); }
  to   { transform: translate3d(0, 0, 0); }
}
.hero-word-down {
  animation: word-drop 760ms cubic-bezier(0.22, 0.75, 0.2, 1) 70ms both;
}
@keyframes word-drop {
  from { transform: translate3d(0, -0.14em, 0); }
  to   { transform: translate3d(0, 0, 0); }
}

.hero-word {
  position: relative;
  font-family: var(--mono); font-weight: 500;
  font-size: clamp(1.75rem, 4.2vw, 2.4rem);
  letter-spacing: -0.03em; line-height: 1;
}
.hero-type { display: inline-block; }


.hero-word-m { display: inline; }
.hero-word-down { display: inline-block; margin-left: 0.05em;
  /* the hair of margin is what keeps the grey letters off the white m while
     they fall; it stays after they land, so nothing reflows */ }
/* nobody asked for motion: show the lockup and be done */
@media (prefers-reduced-motion: reduce) {
  .hero-logo, .mark-arrow, .hero-word-down { animation: none; }
}
.hero-word-dot { color: var(--accent); margin: 0 -0.14em; }
.hero-word-sub {
  /* the tld, set smaller than the name: it reads as mdown.cc rather than
     mdowncc, and the dot still does the separating */
  font-size: 0.72em; font-weight: 400; color: var(--text-3);
  letter-spacing: 0; margin-left: 2px;
}
.hero-logo { margin-bottom: clamp(18px, 3vh, 28px); }

```
