/* Builds the site into web/dist: one hashed, minified bundle for the app, the
   local tools split into their own chunk, and the static pages copied as is.

     bun run build.ts          # once
     bun run build.ts --watch  # rebuild on change */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const WEB = import.meta.dir;
const ROOT = resolve(WEB, "..");
const DIST = join(WEB, "dist");

async function build(): Promise<void> {
  const started = performance.now();
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(join(DIST, "assets"), { recursive: true });

  // React's API, Preact's runtime: the same components at a tenth of the
  // weight. MDOWN_REACT=1 ships real React instead.
  const usePreact = process.env.MDOWN_REACT !== "1";
  const alias: Record<string, string> = {
    react: "preact/compat",
    "react-dom": "preact/compat",
    "react-dom/client": "preact/compat/client",
    "react/jsx-runtime": "preact/jsx-runtime",
    "react/jsx-dev-runtime": "preact/jsx-runtime",
  };
  const preactPlugin: import("bun").BunPlugin = {
    name: "react-to-preact",
    setup(b) {
      b.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (args) => {
        const to = alias[args.path];
        return to ? { path: Bun.resolveSync(to, WEB) } : undefined;
      });
    },
  };

  const result = await Bun.build({
    plugins: usePreact ? [preactPlugin] : [],
    entrypoints: [join(WEB, "src/main.tsx")],
    outdir: join(DIST, "assets"),
    target: "browser",
    format: "esm",
    splitting: true,
    minify: true,
    sourcemap: "none",
    naming: { entry: "app-[hash].[ext]", chunk: "chunk-[hash].[ext]", asset: "[name]-[hash].[ext]" },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("build failed");
  }
  const files = result.outputs.map((o) => o.path.slice(join(DIST, "assets").length + 1));
  const js = files.find((f) => /^app-.*\.js$/.test(f));
  const css = files.find((f) => f.endsWith(".css"));
  if (!js || !css) throw new Error("missing entry output: " + files.join(", "));

  const template = readFileSync(join(WEB, "index.html"), "utf8");
  const shell = (extraHead = "") =>
    template
      .replace("<!--CSS-->", `<link rel="stylesheet" href="assets/${css}">`)
      .replace("<!--PRELOAD-->", `<link rel="modulepreload" href="assets/${js}">${extraHead}`)
      .replace("<!--JS-->", `<script type="module" src="assets/${js}"></script>`);
  writeFileSync(join(DIST, "index.html"), shell());
  // the tip page is the same app, opened on the donate view; a <base> keeps
  // relative asset paths right if a host serves it as /donate/
  writeFileSync(
    join(DIST, "donate.html"),
    shell()
      .replace(/<title>[^<]*<\/title>/, "<title>Support mdown.cc · tip jar</title>")
      .replace(/<link rel="canonical" href="[^"]*">/, '<link rel="canonical" href="https://mdown.cc/donate.html">'),
  );

  // static pages and the files they use
  for (const page of ["404.html", "terms.html", "status.html", "updates.html", "api.html", "sources.html",
    "robots.txt", "sitemap.xml", "llms.txt", "manifest.webmanifest", "favicon.ico", "_headers"]) {
    if (existsSync(join(ROOT, page))) cpSync(join(ROOT, page), join(DIST, page));
  }
  for (const asset of ["app.css", "nav.js", "favicon.svg", "apple-touch-icon.png", "icon-180.png", "icon-192.png",
    "icon-512.png", "og-card.png", "api-policy.pdf", "stripe-icon.png", "stripe-icon-m.png", "stripe-icon-alt.png", "vendor"]) {
    const from = join(ROOT, "assets", asset);
    if (existsSync(from)) cpSync(from, join(DIST, "assets", asset), { recursive: true });
  }
  const size = (f: string) => (statSync(join(DIST, "assets", f)).size / 1024).toFixed(1) + " KB";
  console.log(`built in ${Math.round(performance.now() - started)} ms: ${js} ${size(js)}, ${css} ${size(css)}, ${files.length} files`);
}

await build();
if (process.argv.includes("--watch")) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(join(WEB, "src"), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => build().catch((e) => console.error(e)), 120);
  });
  console.log("watching src/ …");
}
