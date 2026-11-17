package mdown

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// format selection
// ---------------------------------------------------------------------------

func ytInfo() *Info {
	f := func(id, ext, v, a string, h float64, size float64) Format {
		return Format{FormatID: id, Ext: ext, VCodec: v, ACodec: a, Height: h, Filesize: size,
			URL: "https://cdn.example.com/" + id, Protocol: "https"}
	}
	return &Info{Title: "Clip", Duration: 60, Formats: []Format{
		f("18", "mp4", "avc1.42001E", "mp4a.40.2", 360, 3e6),
		f("140", "m4a", "none", "mp4a.40.2", 0, 1e6),
		f("251", "webm", "none", "opus", 0, 1.1e6),
		f("136", "mp4", "avc1.4d401f", "none", 720, 8e6),
		f("247", "webm", "vp9", "none", 720, 7e6),
		f("137", "mp4", "avc1.640028", "none", 1080, 15e6),
		f("248", "webm", "vp9", "none", 1080, 13e6),
		f("271", "webm", "vp9", "none", 1440, 30e6),
		f("313", "webm", "vp9", "none", 2160, 60e6),
	}, Subtitles: map[string][]Subtitle{"en-us": {{Ext: "vtt", URL: "https://cdn.example.com/sub.vtt"}}}}
}

func TestPlanVideoPrefersH264AtTheCap(t *testing.T) {
	p := BuildPlan(ytInfo(), DownloadOptions{Mode: "auto", Height: 1080}, 4320)
	if p == nil || p.Kind != "ffmpeg" || p.Ext != "mp4" {
		t.Fatalf("plan %+v", p)
	}
	if !strings.HasSuffix(p.Inputs[0].URL, "/137") || !strings.HasSuffix(p.Inputs[1].URL, "/140") {
		t.Fatalf("picked %s + %s", p.Inputs[0].URL, p.Inputs[1].URL)
	}
	if p.Estimate != 16e6 || !p.Exact {
		t.Fatalf("estimate %d", p.Estimate)
	}
}

func TestPlanVideoAboveH264TakesTheSharperCodec(t *testing.T) {
	p := BuildPlan(ytInfo(), DownloadOptions{Mode: "auto", Height: 2160}, 4320)
	if p == nil || !strings.HasSuffix(p.Inputs[0].URL, "/313") || !strings.HasSuffix(p.Inputs[1].URL, "/251") {
		t.Fatalf("plan %+v", p)
	}
	if p.Ext != "mp4" {
		t.Fatalf("vp9 + opus merges into mp4 like the disk path, got %s", p.Ext)
	}
}

func TestPlanRespectsServerCap(t *testing.T) {
	p := BuildPlan(ytInfo(), DownloadOptions{Mode: "auto", Height: 4320}, 720)
	if p == nil || !strings.HasSuffix(p.Inputs[0].URL, "/136") {
		t.Fatalf("plan %+v", p.Inputs)
	}
}

func TestPlanSubtitlesAreOptional(t *testing.T) {
	p := BuildPlan(ytInfo(), DownloadOptions{Mode: "auto", Height: 1080, SubtitleLang: "en"}, 4320)
	if p == nil || len(p.Inputs) != 3 || p.Optional != 2 || len(p.NoOptional) == 0 {
		t.Fatalf("plan %+v", p)
	}
	if !strings.Contains(strings.Join(p.Args, " "), "mov_text") {
		t.Fatalf("mp4 subtitles need mov_text: %v", p.Args)
	}
}

func TestPlanAudio(t *testing.T) {
	best := BuildPlan(ytInfo(), DownloadOptions{Mode: "audio", AudioFormat: "best"}, 4320)
	if best == nil || best.Kind != "proxy" || best.Ext != "webm" {
		t.Fatalf("best audio %+v", best)
	}
	mp3 := BuildPlan(ytInfo(), DownloadOptions{Mode: "audio", AudioFormat: "mp3", AudioBitrate: 96}, 4320)
	if mp3 == nil || mp3.Ext != "mp3" || mp3.Estimate != 96*125*60 || !strings.Contains(strings.Join(mp3.Args, " "), "96k") {
		t.Fatalf("mp3 %+v", mp3)
	}
	if BuildPlan(ytInfo(), DownloadOptions{Mode: "audio", AudioFormat: "opus", AudioCovers: true}, 4320) != nil {
		t.Fatal("opus with a cover goes through the disk")
	}
}

func TestPlanMute(t *testing.T) {
	p := BuildPlan(ytInfo(), DownloadOptions{Mode: "mute", Height: 1080}, 4320)
	if p == nil || p.Kind != "proxy" || !strings.HasSuffix(p.Inputs[0].URL, "/248") {
		t.Fatalf("mute %+v", p)
	}
}

func TestPlanRefusesFragmentLists(t *testing.T) {
	info := ytInfo()
	for i := range info.Formats {
		info.Formats[i].HasFragments = true
	}
	if BuildPlan(info, DownloadOptions{Mode: "auto", Height: 1080}, 4320) != nil {
		t.Fatal("fragment lists cannot stream")
	}
}

// ---------------------------------------------------------------------------
// end to end, with a fake yt-dlp and a local media host
// ---------------------------------------------------------------------------

type harness struct {
	srv     *Server
	api     *httptest.Server
	media   *httptest.Server
	payload []byte
	ranges  atomic.Int32
}

func writeScript(t *testing.T, dir, name, body string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func newHarness(t *testing.T, mutate func(*Config)) *harness {
	t.Helper()
	InfoCache.Reset()
	AllowPrivateDial = true
	t.Cleanup(func() { AllowPrivateDial = false })
	fakeDNS(t, map[string][]string{"www.youtube.com": {"142.250.1.1"}})

	h := &harness{payload: make([]byte, 9*MB+123)}
	_, _ = rand.Read(h.payload)
	h.media = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") != "" {
			h.ranges.Add(1)
		}
		if r.Header.Get("X-Must") != "yes" {
			http.Error(w, "missing header", 403)
			return
		}
		http.ServeContent(w, r, "a.mp4", time.Time{}, bytes.NewReader(h.payload))
	}))
	t.Cleanup(h.media.Close)

	dir := t.TempDir()
	info := map[string]any{
		"id": "x", "title": "My / Clip", "duration": 42.0, "extractor_key": "Youtube",
		"thumbnail": "", "webpage_url": "https://www.youtube.com/watch?v=x",
		"formats": []map[string]any{{
			"format_id": "18", "ext": "mp4", "vcodec": "avc1", "acodec": "mp4a.40.2", "height": 360.0,
			"url": h.media.URL + "/media", "protocol": "https", "filesize": float64(len(h.payload)),
			"http_headers": map[string]string{"X-Must": "yes"},
		}},
	}
	raw, _ := json.Marshal(info)
	infoPath := filepath.Join(dir, "info.json")
	_ = os.WriteFile(infoPath, raw, 0o600)
	ytdlp := writeScript(t, dir, "yt-dlp", fmt.Sprintf(`case "$1" in --version) echo 2026.01.01; exit 0;; esac
cat %q
`, infoPath))
	tool := writeScript(t, dir, "tool", "echo version 1\n")

	cfg := Defaults()
	cfg.WorkDir = filepath.Join(dir, "work")
	cfg.APIURL = "http://api.test/"
	cfg.CORSOrigins = []string{"https://mdown.cc"}
	cfg.MinFreeBytes = 1
	cfg.YtdlpBin, cfg.FFmpegBin, cfg.FFprobeBin = ytdlp, tool, tool
	cfg.StreamChunk = 1 * MB
	if mutate != nil {
		mutate(&cfg)
	}
	srv, err := NewServer(&cfg)
	if err != nil {
		t.Fatal(err)
	}
	h.srv = srv
	h.api = httptest.NewServer(srv.Handler())
	t.Cleanup(h.api.Close)
	return h
}

func (h *harness) post(t *testing.T, path string, body any, origin string) (*http.Response, map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPost, h.api.URL+path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res, out
}

func tunnelPath(t *testing.T, out map[string]any) string {
	t.Helper()
	u, _ := out["url"].(string)
	if !strings.HasPrefix(u, "http://api.test/tunnel/") {
		t.Fatalf("no tunnel in %v", out)
	}
	return strings.TrimPrefix(u, "http://api.test")
}

func TestEndToEndStreamsWithRanges(t *testing.T) {
	h := newHarness(t, nil)
	res, out := h.post(t, "/", map[string]any{"url": "https://www.youtube.com/watch?v=x", "videoQuality": "1080"}, "https://mdown.cc")
	if res.StatusCode != 200 || out["status"] != "tunnel" || out["filename"] != "My - Clip.mp4" || out["streamed"] != true {
		t.Fatalf("create: %d %v", res.StatusCode, out)
	}
	if res.Header.Get("Access-Control-Allow-Origin") != "https://mdown.cc" {
		t.Fatal("cors header missing")
	}
	path := tunnelPath(t, out)

	full, err := http.Get(h.api.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(full.Body)
	full.Body.Close()
	if full.StatusCode != 200 || !bytes.Equal(got, h.payload) {
		t.Fatalf("full body: status %d, %d bytes, equal %v", full.StatusCode, len(got), bytes.Equal(got, h.payload))
	}
	if full.Header.Get("Content-Length") != fmt.Sprint(len(h.payload)) || !strings.Contains(full.Header.Get("Content-Disposition"), "My%20-%20Clip.mp4") {
		t.Fatalf("headers %v", full.Header)
	}
	if h.ranges.Load() < 9 {
		t.Fatalf("expected chunked range requests, saw %d", h.ranges.Load())
	}

	req, _ := http.NewRequest(http.MethodGet, h.api.URL+path, nil)
	req.Header.Set("Range", "bytes=5000000-5000099")
	part, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	piece, _ := io.ReadAll(part.Body)
	part.Body.Close()
	if part.StatusCode != 206 || !bytes.Equal(piece, h.payload[5000000:5000100]) {
		t.Fatalf("range: %d, %d bytes", part.StatusCode, len(piece))
	}
}

func TestEndToEndRejections(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.RateLimitMax = 2 })
	if res, out := h.post(t, "/", map[string]any{"url": "https://www.youtube.com/watch?v=x"}, "https://evil.example"); res.StatusCode != 403 ||
		out["error"].(map[string]any)["code"] != "api.auth.origin" {
		t.Fatalf("foreign origin: %d %v", res.StatusCode, out)
	}
	if res, out := h.post(t, "/", map[string]any{"url": "http://169.254.169.254/"}, "https://mdown.cc"); res.StatusCode != 400 ||
		out["error"].(map[string]any)["code"] != "api.url.invalid" {
		t.Fatalf("metadata address: %d %v", res.StatusCode, out)
	}
	if res, _ := h.post(t, "/", map[string]any{}, "https://mdown.cc"); res.StatusCode != 400 {
		t.Fatalf("missing url: %d", res.StatusCode)
	}
	res, out := h.post(t, "/", map[string]any{"url": "https://www.youtube.com/watch?v=x"}, "https://mdown.cc")
	if res.StatusCode != 429 || res.Header.Get("Retry-After") == "" || out["error"].(map[string]any)["code"] != "api.rate_limit" {
		t.Fatalf("rate limit: %d %v", res.StatusCode, out)
	}

	big := strings.NewReader(`{"url":"` + strings.Repeat("a", 20000) + `"}`)
	req, _ := http.NewRequest(http.MethodPost, h.api.URL+"/probe", big)
	req.Header.Set("Origin", "https://mdown.cc")
	if r2, _ := http.DefaultClient.Do(req); r2.StatusCode != 413 {
		t.Fatalf("big body: %d", r2.StatusCode)
	}
	req, _ = http.NewRequest(http.MethodDelete, h.api.URL+"/", nil)
	if r3, _ := http.DefaultClient.Do(req); r3.StatusCode != 405 || r3.Header.Get("Allow") == "" {
		t.Fatalf("delete: %d", r3.StatusCode)
	}
	if r4, _ := http.Get(h.api.URL + "/tunnel/AAAAAAAAAAAAAAAAAAAAAAAA"); r4.StatusCode != 404 {
		t.Fatalf("unknown tunnel: %d", r4.StatusCode)
	}
	if r5, _ := http.Get(h.api.URL + "/nope"); r5.StatusCode != 404 {
		t.Fatalf("unknown route: %d", r5.StatusCode)
	}
}

func TestEndToEndInfoProbeHealthBoard(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.APIKey = ""; c.ModerateKey = "mod-key" })
	res, err := http.Get(h.api.URL + "/")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("info: %v", err)
	}
	var info map[string]any
	_ = json.NewDecoder(res.Body).Decode(&info)
	if info["cobalt"].(map[string]any)["probe"] != true || info["cobalt"].(map[string]any)["board"] != true {
		t.Fatalf("info %v", info)
	}

	pres, probe := h.post(t, "/probe", map[string]any{"url": "https://www.youtube.com/watch?v=x"}, "https://mdown.cc")
	if pres.StatusCode != 200 || probe["title"] != "My / Clip" || probe["duration"].(float64) != 42 {
		t.Fatalf("probe %d %v", pres.StatusCode, probe)
	}

	hres, _ := http.Get(h.api.URL + "/health")
	var health map[string]any
	_ = json.NewDecoder(hres.Body).Decode(&health)
	if hres.StatusCode != 200 || health["status"] != "ok" || health["ytdlp"] != "2026.01.01" {
		t.Fatalf("health %d %v", hres.StatusCode, health)
	}

	bres, board := h.post(t, "/requests", map[string]any{"text": "please add a tool"}, "https://mdown.cc")
	if bres.StatusCode != 202 || board["status"] != "pending" {
		t.Fatalf("board post %d %v", bres.StatusCode, board)
	}
	id := board["item"].(map[string]any)["id"].(string)
	raw, _ := json.Marshal(map[string]string{"id": id})
	req, _ := http.NewRequest(http.MethodPost, h.api.URL+"/requests/approve", bytes.NewReader(raw))
	req.Header.Set("Origin", "https://mdown.cc")
	req.Header.Set("Authorization", "Api-Key wrong")
	if r, _ := http.DefaultClient.Do(req); r.StatusCode != 403 {
		t.Fatalf("wrong key: %d", r.StatusCode)
	}
	req, _ = http.NewRequest(http.MethodPost, h.api.URL+"/requests/approve", bytes.NewReader(raw))
	req.Header.Set("Origin", "https://mdown.cc")
	req.Header.Set("Authorization", "Api-Key mod-key")
	if r, _ := http.DefaultClient.Do(req); r.StatusCode != 200 {
		t.Fatalf("approve: %d", r.StatusCode)
	}
	lres, _ := http.Get(h.api.URL + "/requests")
	var list map[string]any
	_ = json.NewDecoder(lres.Body).Decode(&list)
	if list["count"].(float64) != 1 {
		t.Fatalf("list %v", list)
	}

	ures, _ := http.Get(h.api.URL + "/uptime")
	if ures.StatusCode != 200 || ures.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("uptime %d", ures.StatusCode)
	}
}

func TestPickerForPlaylists(t *testing.T) {
	h := newHarness(t, nil)
	raw, _ := json.Marshal(map[string]any{"_type": "playlist", "title": "Album", "entries": []map[string]any{
		{"url": "https://www.youtube.com/watch?v=a", "title": "A"},
		{"url": "https://www.youtube.com/watch?v=b", "title": "B"},
	}})
	infoPath := filepath.Join(filepath.Dir(h.srv.cfg.YtdlpBin), "info.json")
	_ = os.WriteFile(infoPath, raw, 0o600)
	res, out := h.post(t, "/", map[string]any{"url": "https://www.youtube.com/watch?v=list"}, "https://mdown.cc")
	if res.StatusCode != 200 || out["status"] != "picker" || len(out["picker"].([]any)) != 2 {
		t.Fatalf("picker %d %v", res.StatusCode, out)
	}
}
