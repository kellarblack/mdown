#!/usr/bin/env python3
"""Generate the hero lab page: candidates stacked at 1440, with a composer mock."""
import html

CSS = """
:root{--bg:#0a0a0b;--bg-elev:#101012;--surface:rgba(255,255,255,.03);--stroke:rgba(255,255,255,.09);
 --text:#ededee;--text-2:#a1a1a6;--text-3:#8b8b93;--accent:#ededee;--ease:cubic-bezier(.22,.61,.36,1);
 --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;}
html,body{margin:0;background:var(--bg);color:var(--text);font-family:var(--mono);}
.lab{width:100%;max-width:900px;margin:0 auto;padding:26px clamp(16px,4vw,26px);}
.tag{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#5f5f67;margin:0 0 10px;}
.hero{width:100%;}
.hero-logo{display:flex;align-items:baseline;justify-content:center;gap:.34em;
 margin:0 auto clamp(18px,3vh,28px);font-family:var(--mono);font-weight:500;
 font-size:clamp(1.8rem,3.9vw,2.5rem);letter-spacing:-.035em;line-height:1;color:var(--text);}
.hero-mark{flex:none;padding-top:.15em;color:var(--text);}
.hero-mark svg{display:block;width:.896em;height:1em;overflow:visible;fill:none;stroke:currentColor;
 stroke-width:1;stroke-linecap:round;stroke-linejoin:round;}
.hero-word{display:inline-block;}
.hero-word-m{display:inline;}
.hero-word-down{display:inline-block;}
.hero-word-dot{color:var(--accent);margin-left:-.135em;margin-right:-.16em;}
.hero-word-sub{font-size:.8em;font-weight:500;letter-spacing:0;color:var(--text-2);}
.composer{height:96px;border-radius:12px;background:var(--bg-elev);border:1px solid var(--stroke);
 display:flex;align-items:flex-start;padding:11px;}
.composer span{color:var(--text-3);font-size:.9rem;}
/* the old one */
.old{align-items:center;gap:14px;}
.old .hero-mark{padding-top:0;}
.old .hero-mark svg{width:44px;height:44px;stroke-width:2;}
.old .hero-word{font-size:2.4rem;letter-spacing:-.03em;}
.old .hero-word-dot{margin:0 -.14em;}
.old .hero-word-sub{font-size:.72em;font-weight:400;color:var(--text-3);margin-left:2px;}
"""

def block(label, paths, mark_h=None, cls=""):
    style = f' style="--mh:{mark_h}"' if mark_h else ''
    m = f'<style>.{cls} .hero-mark svg{{height:{mark_h};width:calc({mark_h}*.8958)}}</style>' if mark_h else ''
    return f"""
{m}<p class="tag">{html.escape(label)}</p>
<div class="hero"><h1 class="hero-logo {cls}"{style}>
  <span class="hero-mark" aria-hidden="true"><svg viewBox="3.4 2.4 17.2 19.2">{paths}</svg></span>
  <span class="hero-word"><span class="hero-word-m">m</span><span class="hero-word-down">down</span><span class="hero-word-dot">.</span><span class="hero-word-sub">cc</span></span>
</h1></div>
<div class="composer"><span>paste a link</span></div>
"""

ARROW = '<g><path d="M12 3.6V12.2"/><path d="m7.9 8.2 4.1 4 4.1-4"/></g>'
TRAY_A = '<path d="M4.6 14v3.9a2.5 2.5 0 0 0 2.5 2.5h9.8a2.5 2.5 0 0 0 2.5-2.5V14"/>'
TRAY_B = '<path d="M5.4 13.2v4.6a2.2 2.2 0 0 0 2.2 2.2h8.8a2.2 2.2 0 0 0 2.2-2.2v-4.6"/>'
TRAY_C = '<path d="M4.6 15.2v1.6a2.6 2.6 0 0 0 2.6 2.6h9.6a2.6 2.6 0 0 0 2.6-2.6v-1.6"/>'
OLD = ('<path d="M12 3v12"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4 19h16"/>')

page = f"""<!doctype html><html><head><meta charset="utf-8"><title>hero lab</title><style>{CSS}</style></head><body>
<div class="lab">
<div class="tag">v0 — today</div>
<div class="hero"><h1 class="hero-logo old" style="display:flex;align-items:center;justify-content:center;gap:14px;margin:0 auto 24px">
  <span class="hero-mark" aria-hidden="true"><svg viewBox="0 0 24 24">{OLD}</svg></span>
  <span class="hero-word" style="font-size:2.4rem;letter-spacing:-.03em">m<span style="display:inline-block;margin-left:.05em">down</span><span class="old-dot" style="color:var(--accent);margin:0 -.14em">.</span><span style="font-size:.72em;font-weight:400;color:var(--text-3);margin-left:2px">cc</span></span>
</h1></div>
<div class="composer"><span>paste a link</span></div>
{block("A — wide tray, mark 1em", ARROW + TRAY_A, "1em", "va")}
{block("B — deep tray, mark 1.05em", ARROW + TRAY_B, "1.05em", "vb")}
{block("C — shallow tray, mark 1em", ARROW + TRAY_C, "1em", "vc")}
{block("D — wide tray, mark 1.14em", ARROW + TRAY_A, "1.14em", "vd")}
</div></body></html>"""

open("hero-lab.html", "w").write(page)
print("wrote hero-lab.html")
