#!/usr/bin/env python3
"""Round 2: tray/bracket proportions. Geometry is parametric so the viewBox
is always exactly the ink."""

CSS = """
:root{--bg:#0a0a0b;--bg-elev:#101012;--stroke:rgba(255,255,255,.09);
 --text:#ededee;--text-2:#a1a1a6;--text-3:#8b8b93;--accent:#ededee;--ease:cubic-bezier(.22,.61,.36,1);
 --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;}
html,body{margin:0;background:var(--bg);color:var(--text);font-family:var(--mono);}
.lab{width:100%;max-width:900px;margin:0 auto;padding:20px clamp(16px,4vw,26px);}
.tag{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#5f5f67;margin:0 0 6px;}
.hero{width:100%;}
.hero-logo{display:flex;align-items:baseline;justify-content:center;gap:.34em;
 margin:0 auto 22px;font-family:var(--mono);font-weight:500;
 font-size:clamp(1.9rem,5vw,2.5rem);letter-spacing:-.035em;line-height:1;color:var(--text);}
.hero-mark{flex:none;padding-top:.15em;color:var(--text);}
.hero-mark svg{display:block;height:1em;overflow:visible;fill:none;stroke:currentColor;
 stroke-width:1;stroke-linecap:round;stroke-linejoin:round;}
.hero-word{display:inline-block;}
.hero-word-m{display:inline;}
.hero-word-down{display:inline-block;}
.hero-word-dot{color:var(--accent);margin-left:-.105em;margin-right:-.14em;}
.hero-word-sub{font-size:.8em;font-weight:500;letter-spacing:0;color:var(--text-2);}
.composer{height:64px;border-radius:12px;background:var(--bg-elev);border:1px solid var(--stroke);
 display:flex;align-items:flex-start;padding:11px;}
.composer span{color:var(--text-3);font-size:.9rem;}
.zoom{transform:scale(3);transform-origin:0 0;}
"""

S = 0.5  # half stroke

def tray(x0, x1, mouth, wall, r):
    return (f'M{x0} {mouth}v{wall}a{r} {r} 0 0 0 {r} {r}h{x1-x0-2*r}'
            f'a{r} {r} 0 0 0 {r} {-r}V{mouth}')

def mark(x0, x1, mouth, wall, r, shaft_top, tip, w):
    """returns (paths, viewbox, w/h ratio)"""
    chev_top = tip - w
    paths = (f'<g><path d="M12 {shaft_top}V{tip}"/>'
             f'<path d="m{12-w} {chev_top} {w} {w} {w} {-w}"/></g>'
             f'<path d="{tray(x0,x1,mouth,wall,r)}"/>')
    left, right = x0 - S, x1 + S
    top, bottom = shaft_top - S, mouth + wall + r + S
    vb = f'{left} {top} {right-left} {bottom-top}'
    return paths, vb, (right-left)/(bottom-top)

VARIANTS = [
    ("E — tray 12.8 wide, arrow tip inside the mouth",
     12, dict(x0=5.6, x1=18.4, mouth=14.8, wall=3.2, r=2.4, shaft_top=3.4, tip=14.2, w=4.2)),
    ("F — tray 14.4 wide, tip just above the mouth",
     12, dict(x0=4.8, x1=19.2, mouth=14.4, wall=3.4, r=2.6, shaft_top=3.4, tip=13.6, w=4.2)),
    ("G — deep tray 12.8 wide, tip inside the mouth",
     12, dict(x0=5.6, x1=18.4, mouth=13.6, wall=4.4, r=2.4, shaft_top=3.0, tip=13.4, w=4.2)),
    ("H — wide arrow, tray 14.4, tip just inside",
     12, dict(x0=4.8, x1=19.2, mouth=14.6, wall=3.2, r=2.6, shaft_top=2.8, tip=14.0, w=4.6)),
]

blocks = []
for label, cx, g in VARIANTS:
    paths, vb, ratio = mark(**g)
    blocks.append(f"""
<p class="tag">{label}</p>
<div class="hero"><h1 class="hero-logo">
  <span class="hero-mark" aria-hidden="true"><svg viewBox="{vb}" style="width:{ratio:.3f}em">{paths}</svg></span>
  <span class="hero-word"><span class="hero-word-m">m</span><span class="hero-word-down">down</span><span class="hero-word-dot">.</span><span class="hero-word-sub">cc</span></span>
</h1></div>
<div class="composer"><span>paste a link</span></div>
""")

# a 4x close-up of E and H, drawn big
zoom = []
for label, cx, g in VARIANTS:
    paths, vb, ratio = mark(**g)
    zoom.append(f"""<div style="display:flex;align-items:flex-end;gap:80px;padding:18px 0 34px">
<svg style="height:110px;width:{110*ratio:.1f}px;overflow:visible;fill:none;stroke:var(--text);stroke-width:1;stroke-linecap:round;stroke-linejoin:round" viewBox="{vb}">{paths}</svg>
<svg style="height:110px;width:{110*ratio:.1f}px;overflow:visible;fill:none;stroke:var(--text);stroke-width:1.15;stroke-linecap:round;stroke-linejoin:round" viewBox="{vb}">{paths}</svg>
</div>""")

page = f"""<!doctype html><html><head><meta charset="utf-8"><title>hero lab 2</title><style>{CSS}</style></head><body>
<div class="lab">
{''.join(blocks)}
<p class="tag">close-ups, stroke 1.0 and 1.15</p>
{''.join(zoom)}
</div></body></html>"""
open("hero-lab2.html", "w").write(page)
print("ok")
