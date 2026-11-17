import { useEffect } from "react";
import { CLEAN_HTML, REMUX_HTML, SUBS_HTML } from "../tools/markup";
import { toast } from "../store";

/* The three local tools run ffmpeg.wasm in the tab. Their code (and the 31 MB
   engine) loads only when a tool is first opened, never for the downloader. */

let loading: Promise<unknown> | null = null;

export function loadTools(): Promise<unknown> {
  if (!loading) {
    loading = import("../tools/remux")
      .then(() => import("../tools/tools"))
      .catch((err) => {
        loading = null;
        toast("The local tools did not load. Check the connection and reload.", "err");
        throw err;
      });
  }
  return loading;
}

const MARKUP = { remux: REMUX_HTML, subs: SUBS_HTML, clean: CLEAN_HTML } as const;

export function ToolView({ name, hidden }: { name: keyof typeof MARKUP; hidden: boolean }) {
  useEffect(() => {
    if (!hidden) void loadTools();
  }, [hidden]);
  // the markup is set once; the tool module owns everything inside it
  return (
    <main className="wrap" data-view-panel={name} id={name === "remux" ? "remux-view" : undefined} hidden={hidden}
      dangerouslySetInnerHTML={{ __html: MARKUP[name] }} />
  );
}
