package mdown

import (
	"crypto/rand"
	"encoding/hex"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const maxBody = 16 * 1024

// Services the instance advertises, for the page's "works here" hint.
// Reddit, Vimeo and Bandcamp are left out on purpose: they refuse requests
// from datacenter addresses (login wall or bot challenge), so listing them
// only leads people into an error.
var Services = []string{
	"9gag", "audiomack", "bilibili", "bluesky", "coub", "dailymotion",
	"douyin", "facebook", "hearthis", "imgur", "instagram", "kick", "loom",
	"mixcloud", "newgrounds", "odysee", "ok", "rumble", "rutube",
	"snapchat", "soundcloud", "streamable", "threads", "tiktok", "tumblr",
	"twitch", "twitter", "vk", "xiaohongshu", "youtube",
}

// Server is the HTTP API.
type Server struct {
	cfg     *Config
	engine  *Engine
	jobs    *Jobs
	stream  *streamer
	board   *Board
	inbox   *Board
	uptime  *Uptime
	started time.Time

	limiter, jobLimiter, probeLimiter, readLimiter *RateLimiter
	reportLimiter, boardLimiter, inboxLimiter      *RateLimiter

	toolsMu   sync.Mutex
	toolsAt   time.Time
	tools     map[string]bool
	versionAt time.Time
	version   string
}

func NewServer(cfg *Config) (*Server, error) {
	engine := NewEngine(cfg)
	jobs, err := NewJobs(cfg, engine)
	if err != nil {
		return nil, err
	}
	f, err := startFeed()
	if err != nil {
		return nil, err
	}
	s := &Server{
		cfg: cfg, engine: engine, jobs: jobs, stream: &streamer{cfg: cfg, feed: f},
		board:         NewBoard(filepath.Join(cfg.WorkDir, "board.jsonl"), 500, 240),
		inbox:         NewBoard(filepath.Join(cfg.WorkDir, "reports.jsonl"), 300, 600),
		uptime:        NewUptime(filepath.Join(cfg.WorkDir, "uptime.json")),
		started:       time.Now(),
		limiter:       NewRateLimiter(cfg.RateLimitMax, cfg.RateLimitWindow),
		jobLimiter:    NewRateLimiter(cfg.JobRateMax, cfg.JobRateWindow),
		probeLimiter:  NewRateLimiter(cfg.ProbeRateMax, cfg.ProbeRateWindow),
		readLimiter:   NewRateLimiter(cfg.ReadRateMax, cfg.ReadRateWindow),
		reportLimiter: NewRateLimiter(cfg.ReportRateMax, cfg.ReportRateWin),
		boardLimiter:  NewRateLimiter(cfg.BoardRateMax, cfg.BoardRateWindow),
		inboxLimiter:  NewRateLimiter(cfg.InboxRateMax, cfg.InboxRateWindow),
	}
	return s, nil
}

// Background starts the sweeper, the limiter pruner and the uptime sampler.
func (s *Server) Background(ctx context.Context) {
	s.jobs.Start()
	go func() {
		t := time.NewTicker(2 * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				for _, l := range []*RateLimiter{s.limiter, s.jobLimiter, s.probeLimiter, s.readLimiter, s.reportLimiter, s.boardLimiter, s.inboxLimiter} {
					l.Prune()
				}
			}
		}
	}()
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		sample := func() { s.uptime.Record(s.selfCheck(ctx)) }
		sample()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				sample()
			}
		}
	}()
}

// selfCheck is one uptime sample. It asks the public address, the way a
// visitor's browser would, so a dead proxy, an expired certificate or broken
// DNS counts as down, not only a missing ffmpeg. A local-only instance (plain
// http API_URL) checks its tools and disk instead.
func (s *Server) selfCheck(ctx context.Context) bool {
	tools := s.readTools()
	local := tools["yt-dlp"] && tools["ffmpeg"] && tools["ffprobe"] && s.jobs.freeBytes() >= s.cfg.MinFreeBytes
	if !local || !strings.HasPrefix(s.cfg.APIURL, "https://") {
		return local
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(s.cfg.APIURL, "/")+"/health", nil)
	if err != nil {
		return false
	}
	req.Header.Set("Accept", "application/json")
	res, err := selfClient.Do(req)
	if err != nil {
		log.Printf("uptime: public check failed: %s", RedactLog(err.Error()))
		return false
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 64*1024))
	if res.StatusCode != http.StatusOK {
		log.Printf("uptime: public check answered %d", res.StatusCode)
		return false
	}
	return true
}

var selfClient = &http.Client{Timeout: 10 * time.Second}

// Shutdown flushes state.
func (s *Server) Shutdown() {
	s.jobs.Stop()
	s.uptime.Flush()
}

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

type statusWriter struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (w *statusWriter) WriteHeader(code int) {
	if !w.wrote {
		w.status, w.wrote = code, true
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(p []byte) (int, error) {
	if !w.wrote {
		w.status, w.wrote = 200, true
	}
	return w.ResponseWriter.Write(p)
}

func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// ReadFrom keeps sendfile available for file tunnels.
func (w *statusWriter) ReadFrom(r io.Reader) (int64, error) {
	if !w.wrote {
		w.status, w.wrote = 200, true
	}
	if rf, ok := w.ResponseWriter.(io.ReaderFrom); ok {
		return rf.ReadFrom(r)
	}
	return io.Copy(w.ResponseWriter, r)
}

func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sw := &statusWriter{ResponseWriter: w}
		start := time.Now()
		defer func() {
			if rec := recover(); rec != nil {
				if rec == http.ErrAbortHandler {
					panic(rec)
				}
				log.Printf("panic: %v", rec)
				if !sw.wrote {
					s.sendError(sw, r, ErrInternal(fmt.Sprint(rec)))
				}
			}
			// no address, no query, no token: that a request happened, not what for
			log.Printf("%s %s %d %dms", r.Method, RedactLog(r.URL.Path), sw.status, time.Since(start).Milliseconds())
		}()
		s.route(sw, r)
	})
}

func (s *Server) clientIP(r *http.Request) string {
	if s.cfg.TrustProxy {
		if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
			parts := strings.Split(fwd, ",")
			// the proxy appends what it saw; the first entry is the client's word
			candidate := strings.TrimSpace(parts[len(parts)-1])
			if net.ParseIP(candidate) != nil {
				return candidate
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (s *Server) cors(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Add("Vary", "Origin")
	origin := r.Header.Get("Origin")
	if s.cfg.OriginAllowed(origin) {
		h.Set("Access-Control-Allow-Origin", strings.TrimRight(origin, "/"))
		h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Range")
		h.Set("Access-Control-Expose-Headers", "RateLimit-Remaining, RateLimit-Reset, Content-Length, Content-Range, Content-Disposition, Estimated-Content-Length")
		h.Set("Access-Control-Max-Age", "600")
	}
}

func (s *Server) sendJSON(w http.ResponseWriter, r *http.Request, status int, payload any, extra map[string]string) {
	body, _ := json.Marshal(payload)
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Content-Length", strconv.Itoa(len(body)))
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Robots-Tag", "noindex")
	// JSON is never a page: nothing may frame it, run in it or load from it
	h.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Cross-Origin-Resource-Policy", "same-site")
	for k, v := range extra {
		h.Set(k, HeaderSafe(v))
	}
	s.cors(w, r)
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}

// newRef is the short id a failure is logged under: eight hex characters,
// enough to be unique per box and short enough to read out loud.
func newRef() string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%08x", time.Now().UnixNano()&0xffffffff)
	}
	return hex.EncodeToString(b[:])
}

func (s *Server) sendError(w http.ResponseWriter, r *http.Request, e *APIError) {
	// one line per failure, always. the ref is the thread between the sentence
	// a visitor sees and the detail only this log keeps.
	e.Ref = newRef()
	log.Printf("error ref=%s at=%s status=%d code=%s method=%s path=%s ip=%s detail=%q",
		e.Ref, time.Now().UTC().Format(time.RFC3339), e.Status, e.Code,
		r.Method, r.URL.Path, s.clientIP(r), RedactLog(e.Detail))

	extra := map[string]string{}
	if e.Code == "api.rate_limit" {
		retry := 30
		if v, ok := e.Context["retry"].(int); ok && v > 0 {
			retry = v
		}
		extra["Retry-After"] = strconv.Itoa(retry)
	}
	s.sendJSON(w, r, e.Status, e.Payload(), extra)
}

func rateHeaders(l *RateLimiter, v Verdict) map[string]string {
	return map[string]string{
		"RateLimit-Limit":     strconv.Itoa(l.Max),
		"RateLimit-Remaining": strconv.Itoa(v.Remaining),
		"RateLimit-Reset":     strconv.Itoa(v.Retry),
	}
}

// limit checks a limiter and answers 429 itself when it says no.
func (s *Server) limit(w http.ResponseWriter, r *http.Request, l *RateLimiter, reason string) (map[string]string, bool) {
	v := l.Check(s.clientIP(r))
	h := rateHeaders(l, v)
	if v.Allowed {
		return h, true
	}
	h["Retry-After"] = strconv.Itoa(v.Retry)
	h["RateLimit-Policy"] = fmt.Sprintf("%d;w=%d", l.Max, int(l.Window.Seconds()))
	s.sendError(w, r, ErrRateLimit(v.Retry, reason))
	return nil, false
}

func bearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if _, token, ok := strings.Cut(header, " "); ok && strings.TrimSpace(token) != "" {
		return strings.TrimSpace(token)
	}
	return strings.TrimSpace(header)
}

func equalKey(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func (s *Server) checkAuth(r *http.Request) error {
	if s.cfg.APIKey == "" {
		return nil
	}
	token := bearer(r)
	if token == "" {
		return ErrAuthMissing()
	}
	if !equalKey(token, s.cfg.APIKey) {
		return ErrAuthInvalid()
	}
	return nil
}

func (s *Server) checkModerator(r *http.Request) error {
	key := s.cfg.ModerateKey
	if key == "" {
		key = s.cfg.APIKey
	}
	if key == "" {
		return ErrRequestLocked()
	}
	token := bearer(r)
	if token == "" {
		return ErrAuthMissing()
	}
	if !equalKey(token, key) {
		return ErrAuthInvalid()
	}
	return nil
}

func (s *Server) checkOrigin(r *http.Request) error {
	if !s.cfg.RequireOrigin {
		return nil
	}
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if s.cfg.OriginAllowed(origin) {
		return nil
	}
	if origin == "" {
		origin = "none"
	}
	return errWith("api.auth.origin", 403, map[string]any{"origin": origin}, "origin not allowed")
}

func (s *Server) checkTurnstile(r *http.Request, token string) error {
	if s.cfg.TurnstileSecret == "" {
		return nil
	}
	if token == "" {
		return newErr("api.auth.turnstile.missing", 403, "")
	}
	form := url.Values{"secret": {s.cfg.TurnstileSecret}, "response": {token}, "remoteip": {s.clientIP(r)}}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://challenges.cloudflare.com/turnstile/v0/siteverify", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := upstreamClient.Do(req)
	if err != nil {
		return newErr("api.auth.turnstile.invalid", 403, "")
	}
	defer res.Body.Close()
	var out struct {
		Success bool `json:"success"`
	}
	if json.NewDecoder(io.LimitReader(res.Body, 64*1024)).Decode(&out) != nil || !out.Success {
		return newErr("api.auth.turnstile.invalid", 403, "")
	}
	return nil
}

// readJSON reads a body of at most 16 KB into an object.
func readJSON(r *http.Request) (map[string]any, error) {
	if r.ContentLength > maxBody {
		return nil, ErrTooLarge()
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil {
		return nil, ErrURLInvalid("body could not be read")
	}
	if len(raw) > maxBody {
		return nil, ErrTooLarge()
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil, ErrURLMissing()
	}
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return nil, ErrURLInvalid("body was not json")
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, ErrURLInvalid("body was not an object")
	}
	return m, nil
}

func str(m map[string]any, key string) string {
	v, _ := m[key].(string)
	return strings.TrimSpace(v)
}

func asInt(v any, fallback int) int {
	switch t := v.(type) {
	case float64:
		if t > 0 {
			return int(t)
		}
	case string:
		if n, err := strconv.Atoi(strings.TrimSpace(t)); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

func cleanPath(p string) string {
	if p == "" {
		return "/"
	}
	if len(p) > 1 {
		p = strings.TrimRight(p, "/")
		if p == "" {
			p = "/"
		}
	}
	return p
}

func (s *Server) route(w http.ResponseWriter, r *http.Request) {
	path := cleanPath(r.URL.Path)
	switch r.Method {
	case http.MethodOptions:
		s.cors(w, r)
		w.Header().Set("Content-Length", "0")
		w.WriteHeader(http.StatusNoContent)
		return
	case http.MethodGet, http.MethodHead:
		if err := s.routeGet(w, r, path); err != nil {
			s.sendError(w, r, asAPIError(err))
		}
		return
	case http.MethodPost:
		if err := s.routePost(w, r, path); err != nil {
			s.sendError(w, r, asAPIError(err))
		}
		return
	}
	e := ErrBadMethod()
	s.sendJSON(w, r, e.Status, e.Payload(), map[string]string{"Allow": "GET, HEAD, POST, OPTIONS"})
}

func (s *Server) routeGet(w http.ResponseWriter, r *http.Request, path string) error {
	read := func() bool { _, ok := s.limit(w, r, s.readLimiter, ""); return ok }
	switch {
	case path == "/":
		if !read() {
			return nil
		}
		if err := s.checkAuth(r); err != nil {
			return err
		}
		s.instanceInfo(w, r)
	case path == "/health":
		if read() {
			s.health(w, r)
		}
	case path == "/uptime":
		if read() {
			s.sendJSON(w, r, 200, s.uptime.Summary(30), map[string]string{"Cache-Control": "no-store"})
		}
	case path == "/requests":
		if read() {
			s.sendJSON(w, r, 200, map[string]any{"items": s.board.List(30), "count": s.board.Count()},
				map[string]string{"Cache-Control": "no-store"})
		}
	case path == "/requests/pending":
		if s.cfg.APIKey == "" {
			return ErrRequestLocked()
		}
		if err := s.checkAuth(r); err != nil {
			return err
		}
		s.sendJSON(w, r, 200, map[string]any{"items": s.board.Pending(50)}, map[string]string{"Cache-Control": "no-store"})
	case path == "/reports":
		if err := s.checkModerator(r); err != nil {
			return err
		}
		s.sendJSON(w, r, 200, map[string]any{"items": s.inbox.Pending(200), "handled": s.inbox.List(200)},
			map[string]string{"Cache-Control": "no-store"})
	case path == "/tunnel" || strings.HasPrefix(path, "/tunnel/"):
		token := strings.TrimPrefix(strings.TrimPrefix(path, "/tunnel"), "/")
		if token == "" {
			token = r.URL.Query().Get("id")
		}
		if t, err := url.PathUnescape(token); err == nil {
			token = t
		}
		return s.serveTunnel(w, r, token)
	default:
		return ErrNoRoute()
	}
	return nil
}

func (s *Server) routePost(w http.ResponseWriter, r *http.Request, path string) error {
	switch path {
	case "/requests":
		return s.boardPost(w, r)
	case "/requests/delete":
		if s.cfg.APIKey == "" {
			return ErrRequestLocked()
		}
		if err := s.checkAuth(r); err != nil {
			return err
		}
		return s.boardEdit(w, r, s.board.Delete)
	case "/requests/approve":
		if err := s.checkModerator(r); err != nil {
			return err
		}
		return s.boardEdit(w, r, s.board.Approve)
	case "/reports":
		return s.inboxPost(w, r)
	case "/reports/handled":
		if err := s.checkModerator(r); err != nil {
			return err
		}
		return s.boardEdit(w, r, s.inbox.Approve)
	case "/reports/delete":
		if err := s.checkModerator(r); err != nil {
			return err
		}
		return s.boardEdit(w, r, s.inbox.Delete)
	case "/", "/probe", "/report":
	default:
		return ErrNoRoute()
	}
	if err := s.checkAuth(r); err != nil {
		return err
	}
	if err := s.checkOrigin(r); err != nil {
		return err
	}
	switch path {
	case "/report":
		return s.report(w, r)
	case "/probe":
		return s.probe(w, r)
	}
	return s.create(w, r)
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

func (s *Server) instanceInfo(w http.ResponseWriter, r *http.Request) {
	var sitekey any
	if s.cfg.TurnstileSecret != "" {
		sitekey = s.cfg.TurnstileSitekey
	}
	moderated := s.cfg.ModerateKey != "" || s.cfg.APIKey != ""
	s.sendJSON(w, r, 200, map[string]any{
		"cobalt": map[string]any{
			"version": s.cfg.Version, "url": s.cfg.APIURL,
			"startTime":        s.started.UTC().Format("2006-01-02T15:04:05Z"),
			"turnstileSitekey": sitekey, "apiKeyRequired": s.cfg.APIKey != "",
			"services": Services, "probe": true, "board": moderated, "inbox": moderated,
			"streaming": s.cfg.Streaming,
		},
		"git": map[string]string{"branch": "", "commit": ""},
		"limits": map[string]any{
			"maxHeight": s.cfg.MaxHeight, "maxDuration": s.cfg.MaxDuration,
			"modes": []string{"auto", "audio", "mute"}, "audioFormats": []string{"best", "mp3", "ogg", "opus", "wav"},
			"maxAudioBitrate": 128,
		},
	}, nil)
}

func (s *Server) readTools() map[string]bool {
	s.toolsMu.Lock()
	defer s.toolsMu.Unlock()
	if s.tools == nil || time.Since(s.toolsAt) > 120*time.Second {
		s.tools = s.engine.ToolsAvailable()
		s.toolsAt = time.Now()
	}
	out := map[string]bool{}
	for k, v := range s.tools {
		out[k] = v
	}
	return out
}

func (s *Server) ytdlpVersion() string {
	s.toolsMu.Lock()
	defer s.toolsMu.Unlock()
	if s.version == "" || time.Since(s.versionAt) > time.Hour {
		s.version = s.engine.YtdlpVersion()
		s.versionAt = time.Now()
	}
	return s.version
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	tools := s.readTools()
	stats := s.jobs.Stats()
	diskOK := s.jobs.freeBytes() >= s.cfg.MinFreeBytes
	healthy := tools["yt-dlp"] && tools["ffmpeg"] && tools["ffprobe"] && diskOK
	status, code := "ok", 200
	if !healthy {
		status, code = "degraded", 503
	}
	canary := map[string]any{"at": 0, "failed": 0, "of": 0, "services": ""}
	if raw, err := os.ReadFile(filepath.Join(s.cfg.WorkDir, "canary.json")); err == nil {
		var c map[string]any
		if json.Unmarshal(raw, &c) == nil {
			canary = map[string]any{"at": int(num(c["at"])), "failed": int(num(c["failed"])),
				"of": int(num(c["of"])), "services": strings.TrimSpace(s2(c["services"]))}
		}
	}
	s.sendJSON(w, r, code, map[string]any{
		"status": status,
		"checks": map[string]bool{"downloader": tools["yt-dlp"], "ffmpeg": tools["ffmpeg"],
			"ffprobe": tools["ffprobe"], "storage": diskOK},
		"jobs":          map[string]any{"active": stats["active"], "queued": stats["queued"]},
		"uptimeSeconds": stats["uptime_s"],
		"extraction":    canary,
		"ytdlp":         s.ytdlpVersion(),
	}, nil)
}

func s2(v any) string {
	if t, ok := v.(string); ok {
		return t
	}
	return ""
}

var subtitleLangRE = regexp.MustCompile(`^[a-z]{2,3}(-[a-z0-9]{2,8})?$`)

// options reads the download settings shared by POST / and /probe.
func (s *Server) options(body map[string]any) DownloadOptions {
	mode := strings.ToLower(str(body, "downloadMode"))
	if mode != "audio" && mode != "mute" {
		mode = "auto"
	}
	af := strings.ToLower(str(body, "audioFormat"))
	switch af {
	case "best", "mp3", "ogg", "opus", "wav":
	default:
		af = "mp3"
	}
	br := asInt(body["audioBitrate"], 128)
	if br > 128 {
		br = 128
	}
	height := asInt(body["videoQuality"], s.cfg.MaxHeight)
	if height > s.cfg.MaxHeight {
		height = s.cfg.MaxHeight
	}
	sub := strings.ToLower(str(body, "subtitleLang"))
	if !subtitleLangRE.MatchString(sub) {
		sub = ""
	}
	covers, _ := body["audioCovers"].(bool)
	return DownloadOptions{Mode: mode, Height: height, AudioFormat: af, AudioBitrate: br,
		AudioCovers: covers, SubtitleLang: sub}
}

func (s *Server) safeLink(body map[string]any) (string, error) {
	raw, ok := body["url"].(string)
	if !ok || strings.TrimSpace(raw) == "" {
		return "", ErrURLMissing()
	}
	link, err := ValidateURL(raw, true)
	if err != nil {
		return "", err
	}
	if resolved := ResolveShortener(link); resolved != link {
		return ValidateURL(resolved, true)
	}
	return link, nil
}

func (s *Server) create(w http.ResponseWriter, r *http.Request) error {
	headers, ok := s.limit(w, r, s.limiter, "")
	if !ok {
		return nil
	}
	if _, ok := s.limit(w, r, s.jobLimiter, "too_many_downloads"); !ok {
		return nil
	}
	body, err := readJSON(r)
	if err != nil {
		return err
	}
	if err := s.checkTurnstile(r, str(body, "turnstileToken")); err != nil {
		return err
	}
	link, err := s.safeLink(body)
	if err != nil {
		return err
	}
	t, err := s.jobs.Create(r.Context(), link, s.options(body))
	if err != nil {
		var picker *PickerNeeded
		if errors.As(err, &picker) {
			items := make([]map[string]string, 0, len(picker.Entries))
			for _, e := range picker.Entries {
				items = append(items, map[string]string{"type": "link", "url": e.URL, "thumb": e.Thumb, "name": e.Title})
			}
			s.sendJSON(w, r, 200, map[string]any{"status": "picker", "title": picker.Title, "picker": items}, headers)
			return nil
		}
		return s.engineFailure(err)
	}
	payload := map[string]any{
		"status":   "tunnel",
		"url":      strings.TrimRight(s.cfg.APIURL, "/") + "/tunnel/" + t.Token,
		"filename": t.Filename,
		"size":     t.Size,
	}
	if t.Plan != nil {
		payload["streamed"] = true
		payload["exact"] = t.Plan.Exact || t.Plan.Kind == "proxy"
	}
	s.sendJSON(w, r, 200, payload, headers)
	return nil
}

func (s *Server) engineFailure(err error) error {
	var ee *EngineError
	switch {
	case err == errTimedOut || errors.Is(err, context.DeadlineExceeded):
		return ErrTimedOut()
	case errors.As(err, &ee):
		// the toolchain's last words, without links: what the next fix needs
		log.Printf("engine failure: %s: %s", RedactLog(ee.Msg), lastLine(ee.Stderr))
		if ee.Msg == "metadata extraction failed" {
			return newErr("api.content.video.unavailable", 503, "the source refused, try again")
		}
		return ErrInternal(ee.Msg)
	}
	return err
}

func (s *Server) probe(w http.ResponseWriter, r *http.Request) error {
	headers, ok := s.limit(w, r, s.probeLimiter, "")
	if !ok {
		return nil
	}
	body, err := readJSON(r)
	if err != nil {
		return err
	}
	if err := s.checkTurnstile(r, str(body, "turnstileToken")); err != nil {
		return err
	}
	link, err := s.safeLink(body)
	if err != nil {
		return err
	}
	o := s.options(body)
	info, err := s.engine.Probe(r.Context(), link)
	if err != nil {
		return s.engineFailure(err)
	}
	thumb := ""
	if info.Thumbnail != "" {
		if want, ok := body["thumbnail"].(bool); !ok || want {
			if _, verr := ValidateURL(info.Thumbnail, true); verr == nil {
				thumb = s.engine.ThumbDataURL(r.Context(), info.Thumbnail)
			}
		}
	}
	s.sendJSON(w, r, 200, map[string]any{
		"status": "ok", "title": info.Title, "uploader": info.Uploader, "duration": info.Duration,
		"thumbnail":  thumb,
		"estimate":   EstimateSize(info, o.Mode, o.Height, o.AudioFormat, o.AudioBitrate),
		"isLive":     info.IsLive,
		"isPlaylist": len(info.Entries) > 1,
		"tooLong":    info.Duration > float64(s.cfg.MaxDuration),
		"service":    info.Extractor,
	}, headers)
	return nil
}

func (s *Server) report(w http.ResponseWriter, r *http.Request) error {
	if _, ok := s.limit(w, r, s.reportLimiter, ""); !ok {
		return nil
	}
	body, err := readJSON(r)
	if err != nil {
		return err
	}
	clip := func(v string, n int) string {
		if rs := []rune(v); len(rs) > n {
			return string(rs[:n])
		}
		return v
	}
	note, page, state := clip(str(body, "note"), 2000), clip(str(body, "page"), 120), clip(str(body, "state"), 40)
	if note == "" && state == "" {
		return ErrURLInvalid("empty report")
	}
	dir := filepath.Join(s.cfg.WorkDir, "reports")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return ErrInternal("could not store the report")
	}
	line, _ := json.Marshal(map[string]any{"t": time.Now().Unix(), "page": page, "state": state, "note": note,
		"ua": clip(r.Header.Get("User-Agent"), 180)})
	f, err := os.OpenFile(filepath.Join(dir, time.Now().UTC().Format("2006-01-02")+".jsonl"),
		os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return ErrInternal("could not store the report")
	}
	_, werr := f.Write(append(line, '\n'))
	f.Close()
	if werr != nil {
		return ErrInternal("could not store the report")
	}
	s.sendJSON(w, r, 200, map[string]string{"status": "ok"}, nil)
	return nil
}

func (s *Server) boardPost(w http.ResponseWriter, r *http.Request) error {
	if err := s.checkOrigin(r); err != nil {
		return err
	}
	headers, ok := s.limit(w, r, s.boardLimiter, "board_slow_down")
	if !ok {
		return nil
	}
	body, err := readJSON(r)
	if err != nil {
		return err
	}
	text, _ := body["text"].(string)
	item, err := s.board.Add(text)
	if err != nil {
		return ErrRequestInvalid(err.Error())
	}
	s.sendJSON(w, r, 202, map[string]any{"status": "pending", "item": item}, headers)
	return nil
}

var serviceNameRE = regexp.MustCompile(`[^a-z0-9._-]`)

func (s *Server) inboxPost(w http.ResponseWriter, r *http.Request) error {
	if err := s.checkOrigin(r); err != nil {
		return err
	}
	headers, ok := s.limit(w, r, s.inboxLimiter, "inbox_slow_down")
	if !ok {
		return nil
	}
	body, err := readJSON(r)
	if err != nil {
		return err
	}
	service := serviceNameRE.ReplaceAllString(strings.ToLower(str(body, "service")), "")
	if len(service) > 24 {
		service = service[:24]
	}
	if service == "" {
		service = "unknown"
	}
	note := str(body, "note")
	text := service + " · reported broken"
	if note != "" {
		text = service + " · " + note
	}
	item, err := s.inbox.Add(text)
	if err != nil {
		return ErrRequestInvalid(err.Error())
	}
	log.Printf("inbox: %s", service)
	item.Text = ""
	s.sendJSON(w, r, 202, map[string]any{"status": "queued", "item": item}, headers)
	return nil
}

func (s *Server) boardEdit(w http.ResponseWriter, r *http.Request, op func(string) bool) error {
	if err := s.checkOrigin(r); err != nil {
		return err
	}
	body, err := readJSON(r)
	if err != nil {
		return err
	}
	id := str(body, "id")
	if id == "" || !op(id) {
		return ErrRequestMissing()
	}
	s.sendJSON(w, r, 200, map[string]string{"status": "ok"}, nil)
	return nil
}

// ---------------------------------------------------------------------------
// the tunnel
// ---------------------------------------------------------------------------

func (s *Server) fileHeaders(w http.ResponseWriter, r *http.Request, t *Tunnel, mime string) {
	h := w.Header()
	h.Set("Content-Type", mime)
	h.Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(t.Filename))
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; sandbox")
	h.Set("X-Frame-Options", "DENY")
	s.cors(w, r)
}

func (s *Server) serveTunnel(w http.ResponseWriter, r *http.Request, token string) error {
	if token == "" || !TokenRE.MatchString(token) {
		return ErrNotFound()
	}
	t := s.jobs.Get(token)
	if t == nil {
		return ErrNotFound()
	}
	if t.Plan != nil && t.Path == "" {
		done, err := s.serveStream(w, r, t)
		if done || err != nil {
			return err
		}
		// the source would not stream: fetch it to disk, then serve the file
		if err := s.jobs.Fallback(r.Context(), t); err != nil {
			return s.engineFailure(err)
		}
	}
	f, err := os.Open(t.Path)
	if err != nil {
		return ErrNotFound()
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return ErrNotFound()
	}
	s.fileHeaders(w, r, t, mimeFor(strings.TrimPrefix(filepath.Ext(t.Path), ".")))
	// ServeContent answers Range (resume after a dropped connection) and uses
	// sendfile under the hood
	http.ServeContent(w, r, "", time.Time{}, f)
	if r.Method != http.MethodHead {
		s.jobs.MarkServed(token)
	}
	_ = st
	return nil
}

// serveStream returns done=true when the response was handled (sent or
// aborted), and done=false when nothing was sent and the disk path should run.
func (s *Server) serveStream(w http.ResponseWriter, r *http.Request, t *Tunnel) (bool, error) {
	p := t.Plan
	if r.Method == http.MethodHead {
		s.fileHeaders(w, r, t, p.MIME)
		if p.Estimate > 0 {
			w.Header().Set("Estimated-Content-Length", strconv.FormatInt(p.Estimate, 10))
		}
		w.WriteHeader(200)
		return true, nil
	}
	release, err := s.jobs.acquireStream(r.Context())
	if err != nil {
		return true, err
	}
	defer release()

	head := func(status int, length int64, contentRange string) {
		s.fileHeaders(w, r, t, p.MIME)
		h := w.Header()
		if p.Kind == "proxy" {
			h.Set("Accept-Ranges", "bytes")
		}
		if length >= 0 {
			h.Set("Content-Length", strconv.FormatInt(length, 10))
		} else if p.Estimate > 0 {
			h.Set("Estimated-Content-Length", strconv.FormatInt(p.Estimate, 10))
		}
		if contentRange != "" {
			h.Set("Content-Range", contentRange)
		}
		w.WriteHeader(status)
	}
	out := &flushWriter{w: w}
	var n int64
	if p.Kind == "proxy" {
		n, err = s.stream.proxy(r.Context(), p, r.Header.Get("Range"), out, head)
	} else {
		n, err = s.stream.ffmpeg(r.Context(), p, out, head)
	}
	var early *errBeforeFirstByte
	if err != nil && errors.As(err, &early) {
		if r.Context().Err() != nil {
			return true, nil
		}
		var api *APIError
		if errors.As(early.err, &api) && api.Code == "api.content.too_large" {
			return true, api
		}
		log.Printf("stream: falling back to disk: %s", RedactLog(early.Error()))
		return false, nil
	}
	if err != nil {
		// headers are out; a short body must not look like a finished file
		log.Printf("stream: aborted after %d bytes: %s", n, RedactLog(err.Error()))
		panic(http.ErrAbortHandler)
	}
	s.jobs.MarkServed(t.Token)
	return true, nil
}

// flushWriter pushes bytes out as they arrive instead of buffering 4 KB.
type flushWriter struct {
	w       http.ResponseWriter
	pending int
	started bool
}

func (f *flushWriter) Write(p []byte) (int, error) {
	n, err := f.w.Write(p)
	f.pending += n
	// the first bytes go out at once, so the page shows progress immediately
	if !f.started || f.pending >= 256*1024 {
		f.started = true
		if fl, ok := f.w.(http.Flusher); ok {
			fl.Flush()
		}
		f.pending = 0
	}
	return n, err
}
