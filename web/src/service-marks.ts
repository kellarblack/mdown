/* The service logos are 40 KB of SVG. They load after the first paint; until
   then a link shows the plain link icon. */
import { AUDIO_FIRST, IMAGE_SERVICES } from "./constants";
import { ICONS } from "./status-icons";
import { createStore } from "./store";

type Marks = typeof import("./marks");
export const marksStore = createStore<Marks | null>(null);

let loading: Promise<void> | null = null;
export function loadMarks(): Promise<void> {
  if (!loading) {
    loading = import("./marks")
      .then((m) => marksStore.set(m))
      .catch(() => {
        loading = null;
      });
  }
  return loading;
}

export function markFor(marks: Marks | null, service: string | null | undefined): string {
  if (!service || !marks) return ICONS.link!;
  if (marks.SERVICE_MARKS[service]) return marks.SERVICE_MARKS[service]!;
  if (AUDIO_FIRST.has(service)) return marks.MARK_AUDIO;
  if (IMAGE_SERVICES.has(service)) return marks.MARK_IMAGE;
  return marks.MARK_VIDEO;
}
