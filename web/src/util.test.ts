import { describe, expect, test } from "bun:test";
import {
  detectService, filenameFromDisposition, formatBytes, isIOS, normalizeInstance, parseUrls, prefersAudio, resolveUrl, safeFilename,
  safeImageUrl, targetFromLocation,
} from "./util";

describe("links", () => {
  test("parseUrls keeps distinct http(s) links and adds a missing scheme", () => {
    expect(parseUrls("https://youtu.be/a, https://youtu.be/a\nyoutube.com/watch?v=b ftp://x.org/f")).toEqual([
      "https://youtu.be/a",
      "https://youtube.com/watch?v=b",
    ]);
    expect(parseUrls("not a link")).toEqual([]);
  });

  test("detectService matches subdomains, not lookalikes", () => {
    expect(detectService("https://music.youtube.com/watch?v=x")?.id).toBe("youtube");
    expect(detectService("https://m.soundcloud.com/a/b")?.id).toBe("soundcloud");
    expect(detectService("https://notyoutube.com/x")?.id).toBeNull();
  });

  test("deep links: path, query, alias host", () => {
    const at = (hostname: string, pathname: string, search = "") => targetFromLocation({ hostname, pathname, search });
    expect(at("mdown.cc", "/https://youtube.com/watch", "?v=x")).toBe("https://youtube.com/watch?v=x");
    expect(at("mdown.cc", "/https:/youtube.com/watch", "?v=x")).toBe("https://youtube.com/watch?v=x");
    expect(at("mdown.cc", "/", "?url=https%3A%2F%2Fyoutu.be%2Fa")).toBe("https://youtu.be/a");
    expect(at("mdown.cc", "/youtu.be/abc")).toBe("https://youtu.be/abc");
    expect(at("yout.cc", "/watch", "?v=x")).toBe("https://youtube.com/watch?v=x");
    expect(at("mdown.cc", "/donate.html")).toBe("");
    expect(at("mdown.cc", "/index.html")).toBe("");
  });

  test("normalizeInstance picks a scheme and trims", () => {
    expect(normalizeInstance("api.example.com/")).toBe("https://api.example.com");
    expect(normalizeInstance("127.0.0.1:9000")).toBe("http://127.0.0.1:9000");
    expect(normalizeInstance("javascript:alert(1)")).toBe("");
  });
});

describe("hostile values from a server", () => {
  test("only http(s) links survive", () => {
    expect(resolveUrl("javascript:alert(1)", "https://api.mdown.cc/")).toBe("");
    expect(resolveUrl("/tunnel/x", "https://api.mdown.cc/")).toBe("https://api.mdown.cc/tunnel/x");
    expect(safeImageUrl("data:image/svg+xml;base64,AAAA", "https://a.cc/")).toBe("");
    expect(safeImageUrl("data:image/jpeg;base64,AAAA", "https://a.cc/")).toBe("data:image/jpeg;base64,AAAA");
  });

  test("file names lose separators and control characters", () => {
    expect(safeFilename("../../etc/passwd", "x")).toBe("-..-etc-passwd");
    expect(safeFilename("a\u0000b/c", "x")).toBe("ab-c");
    expect(safeFilename("", "fallback")).toBe("fallback");
  });

  test("content-disposition, both spellings", () => {
    expect(filenameFromDisposition("attachment; filename*=UTF-8''Me%20at%20the%20zoo.mp4")).toBe("Me at the zoo.mp4");
    expect(filenameFromDisposition('attachment; filename="a b.mp3"')).toBe("a b.mp3");
  });
});

test("formatBytes and iOS detection", () => {
  expect(formatBytes(0)).toBe("");
  expect(formatBytes(1536)).toBe("1.5 KB");
  expect(formatBytes(250 * 1024 * 1024)).toBe("250 MB");
  expect(isIOS("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", "iPhone", 5)).toBe(true);
  expect(isIOS("Mozilla/5.0 (Macintosh)", "MacIntel", 5)).toBe(true);
  expect(isIOS("Mozilla/5.0 (Macintosh)", "MacIntel", 0)).toBe(false);
});

test("auto mode: audio only for music links", () => {
  expect(prefersAudio("https://www.youtube.com/watch?v=x")).toBe(false);
  expect(prefersAudio("https://youtu.be/x")).toBe(false);
  expect(prefersAudio("https://music.youtube.com/watch?v=x")).toBe(true);
  expect(prefersAudio("https://soundcloud.com/a/b")).toBe(true);
  expect(prefersAudio("https://artist.bandcamp.com/track/x")).toBe(true);
  expect(prefersAudio("https://x.com/a/status/1")).toBe(false);
  expect(prefersAudio("not a link")).toBe(false);
});
