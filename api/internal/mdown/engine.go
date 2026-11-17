package mdown

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// EngineError is a toolchain failure that is not the visitor's fault.
type EngineError struct {
	Msg    string
	Stderr string
}

func (e *EngineError) Error() string { return e.Msg }

var errTimedOut = &EngineError{Msg: "timed out"}

// run executes argv (never a shell) in its own process group, so a timeout
// kills yt-dlp and the ffmpeg it spawned, not only the parent.
func run(ctx context.Context, argv []string, timeout time.Duration, env []string, limit int) (int, []byte, string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = append(baseEnv(), env...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var out, errb bytes.Buffer
	cmd.Stdout = &limitedBuffer{buf: &out, max: limit}
	cmd.Stderr = &limitedBuffer{buf: &errb, max: 256 * 1024}
	if err := cmd.Start(); err != nil {
		return -1, nil, "", &EngineError{Msg: "could not start " + filepath.Base(argv[0]), Stderr: err.Error()}
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		code := 0
		if err != nil {
			code = -1
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				code = ee.ExitCode()
			}
		}
		return code, out.Bytes(), errb.String(), nil
	case <-ctx.Done():
		killGroup(cmd)
		<-done
		return -1, nil, errb.String(), errTimedOut
	}
}

func killGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	if pgid, err := syscall.Getpgid(cmd.Process.Pid); err == nil {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
	} else {
		_ = cmd.Process.Kill()
	}
}

func baseEnv() []string {
	env := os.Environ()
	has := func(k string) bool {
		for _, e := range env {
			if strings.HasPrefix(e, k+"=") {
				return true
			}
		}
		return false
	}
	if !has("LC_ALL") {
		env = append(env, "LC_ALL=C.UTF-8")
	}
	env = append(env, "PYTHONUNBUFFERED=1")
	return env
}

type limitedBuffer struct {
	buf *bytes.Buffer
	max int
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	if room := l.max - l.buf.Len(); room > 0 {
		if len(p) > room {
			l.buf.Write(p[:room])
		} else {
			l.buf.Write(p)
		}
	}
	return len(p), nil
}

// ---------------------------------------------------------------------------
// error classification
// ---------------------------------------------------------------------------

type errorPattern struct {
	re     *regexp.Regexp
	code   string
	detail string
}

var errorPatterns = []errorPattern{
	{regexp.MustCompile(`(?i)Unsupported URL|no suitable InfoExtractor`), "api.url.unsupported", "unsupported url"},
	{regexp.MustCompile(`(?i)This (video|content) is (private|only available)`), "api.content.video.private", "private"},
	{regexp.MustCompile(`(?i)Private (video|content)`), "api.content.video.private", "private"},
	{regexp.MustCompile(`(?i)Sign in to confirm your age|age[- ]restricted|inappropriate for some users`), "api.content.video.age", "age restricted"},
	{regexp.MustCompile(`(?i)members[- ]only|Join this channel|paid|premium`), "api.content.video.payment", "paywalled"},
	{regexp.MustCompile(`(?i)not available in your country|geo[- ]restrict`), "api.content.video.region", "region locked"},
	{regexp.MustCompile(`(?i)is live|live event will begin|premieres in|stream is offline`), "api.content.video.live", "live"},
	{regexp.MustCompile(`(?i)Requested format is not available`), "api.content.video.unavailable", "format not available"},
	{regexp.MustCompile(`(?i)larger than max-filesize|File is larger`), "api.content.too_large", "output exceeds the size cap"},
	{regexp.MustCompile(`(?i)HTTP Error 429|Too Many Requests`), "api.content.video.unavailable", "source rate limited"},
	{regexp.MustCompile(`(?i)Video unavailable|video is unavailable|has been removed|does not exist|404`), "api.content.video.unavailable", "unavailable"},
}

// Classify maps toolchain stderr to a cobalt error code, or nil.
func Classify(stderr string) *APIError {
	for _, p := range errorPatterns {
		if p.re.MatchString(stderr) {
			return newErr(p.code, 422, p.detail)
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// metadata
// ---------------------------------------------------------------------------

// Format is one entry of yt-dlp's formats list, with what streaming needs.
type Format struct {
	FormatID       string            `json:"format_id"`
	Ext            string            `json:"ext"`
	Height         float64           `json:"height"`
	Width          float64           `json:"width"`
	VCodec         string            `json:"vcodec"`
	ACodec         string            `json:"acodec"`
	Filesize       float64           `json:"filesize"`
	FilesizeApprox float64           `json:"filesize_approx"`
	TBR            float64           `json:"tbr"`
	ABR            float64           `json:"abr"`
	VBR            float64           `json:"vbr"`
	FPS            float64           `json:"fps"`
	URL            string            `json:"url"`
	Protocol       string            `json:"protocol"`
	HTTPHeaders    map[string]string `json:"http_headers"`
	Cookies        string            `json:"cookies"`
	Language       string            `json:"language"`
	FormatNote     string            `json:"format_note"`
	HasFragments   bool              `json:"-"`
	Container      string            `json:"container"`
	ChunkSize      int64             `json:"-"`
}

type Entry struct {
	URL   string `json:"url"`
	Title string `json:"title"`
	Thumb string `json:"thumb"`
}

type Subtitle struct {
	Ext string `json:"ext"`
	URL string `json:"url"`
}

// Info is the slim, cached result of one extraction.
type Info struct {
	ID         string
	Title      string
	Uploader   string
	Thumbnail  string
	Formats    []Format
	Entries    []Entry
	Duration   float64
	Height     float64
	Width      float64
	IsLive     bool
	Ext        string
	Extractor  string
	WebpageURL string
	Subtitles  map[string][]Subtitle
	At         time.Time
}

type infoCache struct {
	mu   sync.Mutex
	ttl  time.Duration
	size int
	data map[string]*Info
}

var InfoCache = &infoCache{ttl: 120 * time.Second, size: 128, data: map[string]*Info{}}

func (c *infoCache) get(key string) *Info {
	c.mu.Lock()
	defer c.mu.Unlock()
	if v, ok := c.data[key]; ok {
		if time.Since(v.At) <= c.ttl {
			return v
		}
		delete(c.data, key)
	}
	return nil
}

func (c *infoCache) put(key string, v *Info) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.data) >= c.size {
		var oldest string
		for k, x := range c.data {
			if oldest == "" || x.At.Before(c.data[oldest].At) {
				oldest = k
			}
		}
		delete(c.data, oldest)
	}
	c.data[key] = v
}

// Reset empties the cache (tests).
func (c *infoCache) Reset() {
	c.mu.Lock()
	c.data = map[string]*Info{}
	c.mu.Unlock()
}

type Engine struct {
	cfg *Config
	// probes for the same link share one yt-dlp process
	flight sync.Map
}

func NewEngine(cfg *Config) *Engine { return &Engine{cfg: cfg} }

func (e *Engine) cacheDir() string { return filepath.Join(e.cfg.WorkDir, ".cache") }

func (e *Engine) ytdlpBase() []string {
	argv := []string{e.cfg.YtdlpBin, "--cache-dir", e.cacheDir()}
	if e.cfg.YtdlpCookies != "" {
		if st, err := os.Stat(e.cfg.YtdlpCookies); err == nil && !st.IsDir() {
			argv = append(argv, "--cookies", e.cfg.YtdlpCookies)
		}
	}
	if e.cfg.YtdlpExtraArgs != "" {
		argv = append(argv, shellSplit(e.cfg.YtdlpExtraArgs)...)
	}
	return argv
}

type flightCall struct {
	done chan struct{}
	info *Info
	err  error
}

// Probe extracts metadata once. Concurrent calls for one link share a single
// yt-dlp process, and a result is reused for two minutes, so the probe the
// page runs while a link is typed makes the later download instant to start.
func (e *Engine) Probe(ctx context.Context, link string) (*Info, error) {
	if v := InfoCache.get(link); v != nil {
		return v, nil
	}
	call := &flightCall{done: make(chan struct{})}
	if existing, loaded := e.flight.LoadOrStore(link, call); loaded {
		c := existing.(*flightCall)
		select {
		case <-c.done:
			return c.info, c.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	defer func() {
		e.flight.Delete(link)
		close(call.done)
	}()
	call.info, call.err = e.probe(ctx, link)
	if call.err == nil {
		InfoCache.put(link, call.info)
	}
	return call.info, call.err
}

func (e *Engine) probe(ctx context.Context, link string) (*Info, error) {
	argv := append(e.ytdlpBase(),
		"--dump-single-json", "--skip-download", "--flat-playlist",
		"--no-warnings", "--socket-timeout", "20", "--retries", "2", link)
	timeout := time.Duration(e.cfg.ProbeTimeout) * time.Second
	env := []string{"XDG_CACHE_HOME=" + e.cacheDir()}
	code, out, stderr, err := run(ctx, argv, timeout, env, 64*MB)
	if err != nil {
		return nil, err
	}
	if code != 0 || len(bytes.TrimSpace(out)) == 0 {
		if f := Classify(stderr); f != nil {
			return nil, f
		}
		// the bot wall is intermittent: one retry turns a failure into a file
		select {
		case <-time.After(time.Second):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		code, out, stderr, err = run(ctx, argv, timeout, env, 64*MB)
		if err != nil {
			return nil, err
		}
		if code != 0 || len(bytes.TrimSpace(out)) == 0 {
			return nil, &EngineError{Msg: "metadata extraction failed", Stderr: stderr}
		}
	}
	info, perr := ParseInfo(out, link)
	if perr != nil {
		return nil, perr
	}
	return info, nil
}

// ParseInfo turns yt-dlp's JSON into Info. Exported for tests.
func ParseInfo(raw []byte, link string) (*Info, error) {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, &EngineError{Msg: "metadata was not valid json"}
	}
	if s(doc["_type"]) == "playlist" {
		if list, _ := doc["entries"].([]any); len(list) == 0 {
			return nil, &EngineError{Msg: "playlist came back empty"}
		}
	}
	info := &Info{
		ID:         s(doc["id"]),
		Title:      s(doc["title"]),
		Uploader:   firstNonEmpty(s(doc["uploader"]), s(doc["channel"])),
		Thumbnail:  thumbOf(doc),
		Duration:   num(doc["duration"]),
		Height:     num(doc["height"]),
		Width:      num(doc["width"]),
		IsLive:     truthy(doc["is_live"]) || truthy(doc["was_live"]),
		Ext:        s(doc["ext"]),
		Extractor:  firstNonEmpty(s(doc["extractor_key"]), s(doc["extractor"])),
		WebpageURL: firstNonEmpty(s(doc["webpage_url"]), link),
		Subtitles:  map[string][]Subtitle{},
		At:         time.Now(),
	}
	if list, ok := doc["entries"].([]any); ok {
		for _, raw := range list {
			entry, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			u := firstNonEmpty(s(entry["webpage_url"]), s(entry["url"]))
			if u == "" {
				continue
			}
			info.Entries = append(info.Entries, Entry{URL: u, Title: s(entry["title"]), Thumb: thumbOf(entry)})
			if len(info.Entries) >= 20 {
				break
			}
		}
	}
	if list, ok := doc["formats"].([]any); ok {
		for _, raw := range list {
			m, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			f := Format{
				FormatID: s(m["format_id"]), Ext: s(m["ext"]),
				Height: num(m["height"]), Width: num(m["width"]),
				VCodec: s(m["vcodec"]), ACodec: s(m["acodec"]),
				Filesize: num(m["filesize"]), FilesizeApprox: num(m["filesize_approx"]),
				TBR: num(m["tbr"]), ABR: num(m["abr"]), VBR: num(m["vbr"]), FPS: num(m["fps"]),
				URL: s(m["url"]), Protocol: s(m["protocol"]), Cookies: s(m["cookies"]),
				Language: s(m["language"]), FormatNote: s(m["format_note"]), Container: s(m["container"]),
			}
			if f.Height == 0 && f.ACodec == "" && f.VCodec == "" {
				continue
			}
			if h, ok := m["http_headers"].(map[string]any); ok {
				f.HTTPHeaders = map[string]string{}
				for k, v := range h {
					f.HTTPHeaders[k] = s(v)
				}
			}
			if fr, ok := m["fragments"].([]any); ok && len(fr) > 0 {
				f.HasFragments = true
			}
			if d, ok := m["downloader_options"].(map[string]any); ok {
				f.ChunkSize = int64(num(d["http_chunk_size"]))
			}
			info.Formats = append(info.Formats, f)
		}
	}
	if subs, ok := doc["subtitles"].(map[string]any); ok {
		for lang, raw := range subs {
			list, _ := raw.([]any)
			for _, item := range list {
				m, _ := item.(map[string]any)
				if m == nil || s(m["url"]) == "" {
					continue
				}
				info.Subtitles[strings.ToLower(lang)] = append(info.Subtitles[strings.ToLower(lang)],
					Subtitle{Ext: s(m["ext"]), URL: s(m["url"])})
			}
		}
	}
	return info, nil
}

func thumbOf(m map[string]any) string {
	if t := s(m["thumbnail"]); t != "" {
		return t
	}
	if list, ok := m["thumbnails"].([]any); ok && len(list) > 0 {
		if last, ok := list[len(list)-1].(map[string]any); ok {
			return s(last["url"])
		}
	}
	return ""
}

func s(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case nil:
		return ""
	}
	return fmt.Sprint(v)
}

func num(v any) float64 {
	switch t := v.(type) {
	case float64:
		if t > 0 {
			return t
		}
	case string:
		if f, err := strconv.ParseFloat(t, 64); err == nil && f > 0 {
			return f
		}
	}
	return 0
}

func truthy(v any) bool {
	b, ok := v.(bool)
	return ok && b
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func has(codec string) bool { return codec != "" && codec != "none" }

// ---------------------------------------------------------------------------
// estimate
// ---------------------------------------------------------------------------

func sizeOf(f Format, duration float64) float64 {
	if f.Filesize > 0 {
		return f.Filesize
	}
	if f.FilesizeApprox > 0 {
		return f.FilesizeApprox
	}
	rate := f.TBR
	if rate == 0 {
		rate = f.VBR + f.ABR
	}
	if rate > 0 && duration > 0 {
		return rate * 1000 / 8 * duration
	}
	return 0
}

type Estimate struct {
	Bytes  int64 `json:"bytes"`
	Height any   `json:"height"`
	Exact  bool  `json:"exact"`
}

// EstimateSize guesses the output size before a byte is fetched.
func EstimateSize(info *Info, mode string, height int, audioFormat string, bitrate int) Estimate {
	d := info.Duration
	if d == 0 || len(info.Formats) == 0 {
		return Estimate{0, nil, false}
	}
	if mode == "audio" {
		switch audioFormat {
		case "wav":
			return Estimate{int64(176400 * d), nil, true}
		case "mp3", "ogg", "opus":
			return Estimate{int64(float64(bitrate) * 125 * d), nil, true}
		}
		pick, ok := bestAudio(info.Formats)
		if !ok {
			return Estimate{0, nil, false}
		}
		return Estimate{int64(sizeOf(pick, d)), nil, pick.Filesize > 0}
	}
	var pool []Format
	for _, f := range info.Formats {
		if has(f.VCodec) && f.Height > 0 && int(f.Height) <= height {
			pool = append(pool, f)
		}
	}
	if len(pool) == 0 {
		for _, f := range info.Formats {
			if has(f.VCodec) {
				pool = append(pool, f)
			}
		}
	}
	if len(pool) == 0 {
		return Estimate{0, nil, false}
	}
	top := 0.0
	for _, f := range pool {
		if f.Height > top {
			top = f.Height
		}
	}
	var same []Format
	for _, f := range pool {
		if f.Height == top {
			same = append(same, f)
		}
	}
	var h any
	if top > 0 {
		h = int(top)
	}
	biggest := func(list []Format) Format {
		best := list[0]
		for _, f := range list[1:] {
			if sizeOf(f, d) > sizeOf(best, d) {
				best = f
			}
		}
		return best
	}
	if mode == "mute" {
		p := biggest(same)
		return Estimate{int64(sizeOf(p, d)), h, p.Filesize > 0}
	}
	var progressive []Format
	for _, f := range same {
		if has(f.ACodec) {
			progressive = append(progressive, f)
		}
	}
	if len(progressive) > 0 {
		p := biggest(progressive)
		return Estimate{int64(sizeOf(p, d)), h, p.Filesize > 0}
	}
	video := sizeOf(biggest(same), d)
	audio := 0.0
	for _, f := range info.Formats {
		if has(f.ACodec) && !has(f.VCodec) {
			if v := sizeOf(f, d); v > audio {
				audio = v
			}
		}
	}
	return Estimate{int64(video + audio), h, video > 0 && audio > 0}
}

func bestAudio(list []Format) (Format, bool) {
	var pool []Format
	for _, f := range list {
		if has(f.ACodec) && !has(f.VCodec) {
			pool = append(pool, f)
		}
	}
	if len(pool) == 0 {
		for _, f := range list {
			if has(f.ACodec) {
				pool = append(pool, f)
			}
		}
	}
	if len(pool) == 0 {
		return Format{}, false
	}
	sort.SliceStable(pool, func(i, j int) bool {
		a, b := pool[i], pool[j]
		if a.Height != b.Height {
			return a.Height < b.Height
		}
		if a.TBR != b.TBR {
			return a.TBR < b.TBR
		}
		return a.Filesize < b.Filesize
	})
	return pool[len(pool)-1], true
}

// ---------------------------------------------------------------------------
// thumbnail
// ---------------------------------------------------------------------------

// ThumbDataURL fetches a thumbnail once, scales it with ffmpeg, and returns it
// inline so the page never talks to the source's CDN. Failure returns "".
func (e *Engine) ThumbDataURL(ctx context.Context, link string) string {
	if !strings.HasPrefix(strings.ToLower(link), "http://") && !strings.HasPrefix(strings.ToLower(link), "https://") {
		return ""
	}
	sum := sha256.Sum256([]byte(link))
	dir := filepath.Join(e.cacheDir(), "thumbs")
	_ = os.MkdirAll(dir, 0o700)
	path := filepath.Join(dir, hex.EncodeToString(sum[:16])+".jpg")
	if data, err := os.ReadFile(path); err == nil && len(data) > 2 && data[0] == 0xff && data[1] == 0xd8 {
		return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(data)
	}
	argv := []string{e.cfg.FFmpegBin, "-nostdin", "-loglevel", "error", "-y",
		"-protocol_whitelist", "http,https,tls,tcp",
		"-rw_timeout", "8000000", "-i", link,
		"-frames:v", "1", "-vf", "scale=160:-2:flags=lanczos",
		"-f", "mjpeg", "-q:v", "6", "pipe:1"}
	code, data, _, err := run(ctx, argv, 10*time.Second, nil, 2*MB)
	if err != nil || code != 0 || len(data) < 400 || len(data) > 400000 || data[0] != 0xff || data[1] != 0xd8 {
		return ""
	}
	_ = os.WriteFile(path, data, 0o600)
	return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(data)
}

// ---------------------------------------------------------------------------
// disk download: the slow, always-works path
// ---------------------------------------------------------------------------

type DownloadOptions struct {
	Mode         string
	Height       int
	AudioFormat  string
	AudioBitrate int
	AudioCovers  bool
	SubtitleLang string
}

var subtitleExts = []string{".srt", ".vtt", ".ass", ".ssa", ".lrc"}

// DownloadToDisk runs yt-dlp into dest and returns the produced file.
func (e *Engine) DownloadToDisk(ctx context.Context, link, dest string, o DownloadOptions) (string, error) {
	template := filepath.Join(dest, "media.%(ext)s")
	base := append(e.ytdlpBase(),
		"--no-playlist", "--no-warnings", "--no-mtime",
		"--socket-timeout", "30", "--retries", "10", "--fragment-retries", "10",
		"--retry-sleep", "2", "--concurrent-fragments", strconv.Itoa(e.cfg.Fragments),
		"--max-filesize", fmt.Sprintf("%dM", max64(1, e.cfg.MaxOutputBytes/MB)))
	timeout := time.Duration(e.cfg.JobTimeout) * time.Second
	env := []string{"XDG_CACHE_HOME=" + e.cacheDir()}
	exec := func(argv []string) (int, string, error) {
		code, _, stderr, err := run(ctx, argv, timeout, env, 64*1024)
		return code, stderr, err
	}

	if o.Mode == "audio" {
		f := o.AudioFormat
		switch f {
		case "best", "mp3", "ogg", "opus", "wav":
		default:
			f = "mp3"
		}
		if f == "best" {
			code, stderr, err := exec(append(base, "-f", "bestaudio/best", "-o", template, link))
			if err != nil {
				return "", err
			}
			if code != 0 {
				return "", downloadError(stderr)
			}
			return singleFile(dest, nil)
		}
		argv := append(base, "-f", "bestaudio/best", "-x", "--audio-format", f, "-o", template)
		if f != "wav" {
			argv = append(argv, "--audio-quality", fmt.Sprintf("%dK", o.AudioBitrate))
		}
		if o.AudioCovers && (f == "mp3" || f == "ogg" || f == "opus") {
			argv = append(argv, "--embed-thumbnail", "--convert-thumbnails", "jpg")
		}
		code, stderr, err := exec(append(argv, link))
		if err != nil {
			return "", err
		}
		if code != 0 {
			return "", downloadError(stderr)
		}
		if p, err := singleFile(dest, []string{"." + f}); err == nil {
			return p, nil
		}
		return singleFile(dest, nil)
	}

	subs := []string{}
	if o.SubtitleLang != "" {
		subs = []string{"--write-subs", "--sub-langs", o.SubtitleLang, "--embed-subs", "--convert-subs", "srt"}
	}
	build := func(container string, withSubs bool) []string {
		h := o.Height
		var selector string
		if o.Mode == "mute" {
			selector = fmt.Sprintf("bv*[height<=%d]/b[height<=%d]/b", h, h)
		} else {
			selector = fmt.Sprintf("bv*[height<=%d][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[height<=%d]+ba/b[height<=%d]/b", h, h, h)
		}
		argv := append([]string{}, base...)
		if withSubs {
			argv = append(argv, subs...)
		}
		return append(argv, "-f", selector, "--merge-output-format", container, "-o", template, link)
	}
	code, stderr, err := exec(build("mp4", len(subs) > 0))
	if err != nil {
		return "", err
	}
	if code != 0 {
		code, stderr, err = exec(build("mkv", len(subs) > 0))
		if err == nil && code != 0 && len(subs) > 0 {
			code, stderr, err = exec(build("mkv", false))
		}
		if err != nil {
			return "", err
		}
		if code != 0 {
			return "", downloadError(stderr)
		}
	}
	return singleFile(dest, nil)
}

func downloadError(stderr string) error {
	if f := Classify(stderr); f != nil {
		return f
	}
	if len(stderr) > 400 {
		stderr = stderr[len(stderr)-400:]
	}
	// the toolchain's own words stay in the log: they can name paths and hosts
	e := ErrUnavailable(RedactLog(stderr))
	e.Expose = false
	return e
}

// singleFile picks the media file, never a subtitle sidecar or a partial.
func singleFile(dir string, exts []string) (string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", &EngineError{Msg: "downloader finished without producing a file"}
	}
	best, bestSize := "", int64(-1)
	for _, ent := range entries {
		name := ent.Name()
		lower := strings.ToLower(name)
		if !strings.HasPrefix(name, "media.") || ent.IsDir() {
			continue
		}
		if strings.HasSuffix(lower, ".part") || strings.HasSuffix(lower, ".ytdl") || strings.HasSuffix(lower, ".tmp") {
			continue
		}
		skip := false
		for _, e := range subtitleExts {
			if strings.HasSuffix(lower, e) {
				skip = true
			}
		}
		if skip {
			continue
		}
		if len(exts) > 0 {
			match := false
			for _, e := range exts {
				if strings.ToLower(filepath.Ext(name)) == e {
					match = true
				}
			}
			if !match {
				continue
			}
		}
		if st, err := ent.Info(); err == nil && st.Size() > bestSize {
			best, bestSize = filepath.Join(dir, name), st.Size()
		}
	}
	if best == "" {
		return "", &EngineError{Msg: "downloader finished without producing a file"}
	}
	return best, nil
}

// MediaFacts is what ffprobe says about a finished file.
type MediaFacts struct {
	Height   int
	Width    int
	Duration float64
	HasVideo bool
	HasAudio bool
	Size     int64
}

func (e *Engine) ProbeFile(ctx context.Context, path string) (MediaFacts, error) {
	argv := []string{e.cfg.FFprobeBin, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path}
	code, out, stderr, err := run(ctx, argv, 30*time.Second, nil, 4*MB)
	if err != nil {
		return MediaFacts{}, err
	}
	if code != 0 || len(bytes.TrimSpace(out)) == 0 {
		return MediaFacts{}, &EngineError{Msg: "ffprobe rejected the output", Stderr: stderr}
	}
	var doc struct {
		Streams []struct {
			CodecType string `json:"codec_type"`
			Height    int    `json:"height"`
			Width     int    `json:"width"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
			Size     string `json:"size"`
		} `json:"format"`
	}
	if json.Unmarshal(out, &doc) != nil {
		return MediaFacts{}, &EngineError{Msg: "ffprobe output was not json"}
	}
	var m MediaFacts
	for _, st := range doc.Streams {
		switch st.CodecType {
		case "video":
			if !m.HasVideo {
				m.HasVideo, m.Height, m.Width = true, st.Height, st.Width
			}
		case "audio":
			m.HasAudio = true
		}
	}
	m.Duration, _ = strconv.ParseFloat(doc.Format.Duration, 64)
	m.Size, _ = strconv.ParseInt(doc.Format.Size, 10, 64)
	return m, nil
}

// ToolsAvailable checks each binary with the flag it supports.
func (e *Engine) ToolsAvailable() map[string]bool {
	found := map[string]bool{}
	for _, t := range [][3]string{{"yt-dlp", e.cfg.YtdlpBin, "--version"}, {"ffmpeg", e.cfg.FFmpegBin, "-version"}, {"ffprobe", e.cfg.FFprobeBin, "-version"}} {
		code, out, _, err := run(context.Background(), []string{t[1], t[2]}, 15*time.Second, nil, 64*1024)
		found[t[0]] = err == nil && code == 0 && len(bytes.TrimSpace(out)) > 0
	}
	return found
}

// YtdlpVersion is cached for an hour by the caller.
func (e *Engine) YtdlpVersion() string {
	code, out, _, err := run(context.Background(), []string{e.cfg.YtdlpBin, "--version"}, 10*time.Second, nil, 4096)
	if err != nil || code != 0 {
		return ""
	}
	line := strings.TrimSpace(strings.SplitN(string(out), "\n", 2)[0])
	if len(line) > 24 {
		line = line[:24]
	}
	return line
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// shellSplit splits an operator-supplied argument string the way a POSIX
// shell would, without ever running one.
func shellSplit(in string) []string {
	var out []string
	var cur strings.Builder
	inWord, quote := false, rune(0)
	for _, r := range in {
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
			} else {
				cur.WriteRune(r)
			}
		case r == '"' || r == '\'':
			quote, inWord = r, true
		case r == ' ' || r == '\t' || r == '\n':
			if inWord {
				out = append(out, cur.String())
				cur.Reset()
				inWord = false
			}
		default:
			cur.WriteRune(r)
			inWord = true
		}
	}
	if inWord {
		out = append(out, cur.String())
	}
	return out
}
