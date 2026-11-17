package mdown

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// ---------------------------------------------------------------------------
// ranged source: many short range requests in parallel, read in order
// ---------------------------------------------------------------------------

// Some CDNs (YouTube's among them) serve one long request at playback speed
// and short ranged requests at line speed. A source here is read as a run of
// chunk-sized ranges with several in flight, which is what makes a download
// start at once and finish fast.
type source struct {
	url      string
	header   http.Header
	size     int64 // -1 unknown
	chunk    int64
	parallel int
	ranged   bool
	once     sync.Once
	err      error
}

func newSource(in Input, chunk int64, parallel int) *source {
	h := http.Header{}
	for k, v := range in.Headers {
		if strings.EqualFold(k, "Accept-Encoding") || strings.EqualFold(k, "Range") {
			continue
		}
		h.Set(k, HeaderSafe(v))
	}
	if c := cookieHeader(in.Cookies); c != "" {
		h.Set("Cookie", c)
	}
	if h.Get("User-Agent") == "" {
		h.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")
	}
	// identity, or Go would hand back a decoded body with the wrong length
	h.Set("Accept-Encoding", "identity")
	if in.Chunk > 0 && in.Chunk < chunk {
		chunk = in.Chunk
	}
	size := in.Size
	if size <= 0 {
		size = -1
	}
	return &source{url: in.URL, header: h, size: size, chunk: chunk, parallel: parallel}
}

// cookieHeader turns yt-dlp's per-format cookie string ("a=1; Domain=x;
// Path=/; b=2; ...") into a Cookie header value.
func cookieHeader(raw string) string {
	if raw == "" {
		return ""
	}
	attrs := map[string]bool{"domain": true, "path": true, "expires": true, "max-age": true,
		"secure": true, "httponly": true, "samesite": true, "version": true, "comment": true}
	var out []string
	for _, part := range strings.Split(raw, ";") {
		part = strings.TrimSpace(part)
		name, _, ok := strings.Cut(part, "=")
		if !ok || name == "" || attrs[strings.ToLower(name)] {
			continue
		}
		out = append(out, part)
	}
	return HeaderSafe(strings.Join(out, "; "))
}

func (s *source) request(ctx context.Context, start, end int64) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.url, nil)
	if err != nil {
		return nil, err
	}
	req.Header = s.header.Clone()
	if end >= start && start >= 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, end))
	}
	return upstreamClient.Do(req)
}

// discover learns the size and whether ranges work, with one tiny request.
func (s *source) discover(ctx context.Context) error {
	s.once.Do(func() {
		res, err := s.request(ctx, 0, 0)
		if err != nil {
			s.err = err
			return
		}
		defer res.Body.Close()
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 64*1024))
		switch res.StatusCode {
		case http.StatusPartialContent:
			s.ranged = true
			if total := totalFromContentRange(res.Header.Get("Content-Range")); total > 0 {
				s.size = total
			}
		case http.StatusOK:
			s.ranged = false
			if res.ContentLength > 0 {
				s.size = res.ContentLength
			}
		default:
			s.err = fmt.Errorf("source answered %d", res.StatusCode)
		}
	})
	return s.err
}

func totalFromContentRange(v string) int64 {
	slash := strings.LastIndexByte(v, '/')
	if slash < 0 {
		return -1
	}
	n, err := strconv.ParseInt(strings.TrimSpace(v[slash+1:]), 10, 64)
	if err != nil {
		return -1
	}
	return n
}

type chunkResult struct {
	data []byte
	err  error
}

// open returns a reader for bytes [start, end] (end -1 = to the end).
func (s *source) open(ctx context.Context, start, end int64) (io.ReadCloser, error) {
	if err := s.discover(ctx); err != nil {
		return nil, err
	}
	if !s.ranged || s.size < 0 {
		// the source cannot do ranges: one plain request, from the top
		if start > 0 {
			return nil, errors.New("source does not support ranges")
		}
		res, err := s.request(ctx, -1, -1)
		if err != nil {
			return nil, err
		}
		if res.StatusCode != http.StatusOK {
			res.Body.Close()
			return nil, fmt.Errorf("source answered %d", res.StatusCode)
		}
		return res.Body, nil
	}
	if end < 0 || end >= s.size {
		end = s.size - 1
	}
	ctx, cancel := context.WithCancel(ctx)
	pr, pw := io.Pipe()
	futures := make(chan chan chunkResult, s.parallel)

	go func() { // producer: start chunk fetches, at most `parallel` ahead
		defer close(futures)
		for off := start; off <= end; off += s.chunk {
			last := off + s.chunk - 1
			if last > end {
				last = end
			}
			ch := make(chan chunkResult, 1)
			select {
			case futures <- ch:
			case <-ctx.Done():
				return
			}
			go func(a, b int64) { ch <- s.fetchChunk(ctx, a, b) }(off, last)
		}
	}()
	go func() { // consumer: write the chunks in order
		defer cancel()
		for ch := range futures {
			var r chunkResult
			select {
			case r = <-ch:
			case <-ctx.Done():
				pw.CloseWithError(ctx.Err())
				return
			}
			if r.err != nil {
				pw.CloseWithError(r.err)
				return
			}
			if _, err := pw.Write(r.data); err != nil {
				return
			}
		}
		pw.Close()
	}()
	return &cancelReader{PipeReader: pr, cancel: cancel}, nil
}

type cancelReader struct {
	*io.PipeReader
	cancel context.CancelFunc
}

func (c *cancelReader) Close() error {
	c.cancel()
	return c.PipeReader.Close()
}

func (s *source) fetchChunk(ctx context.Context, start, end int64) chunkResult {
	want := end - start + 1
	var lastErr error
	for attempt := 0; attempt < 4; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(time.Duration(attempt) * 700 * time.Millisecond):
			case <-ctx.Done():
				return chunkResult{err: ctx.Err()}
			}
		}
		cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
		res, err := s.request(cctx, start, end)
		if err != nil {
			cancel()
			lastErr = err
			continue
		}
		if res.StatusCode != http.StatusPartialContent {
			res.Body.Close()
			cancel()
			lastErr = fmt.Errorf("source answered %d for a range", res.StatusCode)
			if res.StatusCode == 403 || res.StatusCode == 404 || res.StatusCode == 410 {
				break
			}
			continue
		}
		buf := make([]byte, want)
		n, err := io.ReadFull(res.Body, buf)
		res.Body.Close()
		cancel()
		if err != nil {
			lastErr = err
			continue
		}
		return chunkResult{data: buf[:n]}
	}
	return chunkResult{err: lastErr}
}

// ---------------------------------------------------------------------------
// loopback feed: ffmpeg reads each input from here, seekable, over HTTP
// ---------------------------------------------------------------------------

// feed serves registered sources to ffmpeg on a random loopback port. It is
// never reachable from outside: it listens on 127.0.0.1 only, and each path
// carries a fresh random token.
type feed struct {
	mu      sync.Mutex
	sources map[string]*source
	base    string
}

func startFeed() (*feed, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	f := &feed{sources: map[string]*source{}, base: "http://" + ln.Addr().String() + "/in/"}
	srv := &http.Server{Handler: http.HandlerFunc(f.serve), ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	return f, nil
}

func (f *feed) add(s *source) (string, func()) {
	id := randomToken(18)
	f.mu.Lock()
	f.sources[id] = s
	f.mu.Unlock()
	return f.base + id, func() {
		f.mu.Lock()
		delete(f.sources, id)
		f.mu.Unlock()
	}
}

func (f *feed) serve(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/in/")
	f.mu.Lock()
	src := f.sources[id]
	f.mu.Unlock()
	if src == nil {
		http.NotFound(w, r)
		return
	}
	if err := src.discover(r.Context()); err != nil {
		http.Error(w, "source failed", http.StatusBadGateway)
		return
	}
	start, end := int64(0), int64(-1)
	partial := false
	if rng := r.Header.Get("Range"); rng != "" && src.ranged && src.size > 0 {
		if a, b, ok := parseRange(rng, src.size); ok {
			start, end, partial = a, b, true
		} else {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", src.size))
			w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
			return
		}
	}
	body, err := src.open(r.Context(), start, end)
	if err != nil {
		http.Error(w, "source failed", http.StatusBadGateway)
		return
	}
	defer body.Close()
	if src.ranged && src.size > 0 {
		if end < 0 {
			end = src.size - 1
		}
		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
		if partial {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, src.size))
			w.WriteHeader(http.StatusPartialContent)
		}
	}
	_, _ = io.Copy(w, body)
}

// parseRange reads one "bytes=a-b" range. ok false means unsatisfiable or
// unreadable; a multi-range header is treated as unreadable.
func parseRange(header string, size int64) (int64, int64, bool) {
	v := strings.TrimSpace(header)
	if !strings.HasPrefix(strings.ToLower(v), "bytes=") || size <= 0 {
		return 0, 0, false
	}
	spec := strings.TrimSpace(v[6:])
	if strings.Contains(spec, ",") {
		return 0, 0, false
	}
	first, last, _ := strings.Cut(spec, "-")
	first, last = strings.TrimSpace(first), strings.TrimSpace(last)
	if first == "" {
		n, err := strconv.ParseInt(last, 10, 64)
		if err != nil || n <= 0 {
			return 0, 0, false
		}
		if n > size {
			n = size
		}
		return size - n, size - 1, true
	}
	a, err := strconv.ParseInt(first, 10, 64)
	if err != nil {
		return 0, 0, false
	}
	b := size - 1
	if last != "" {
		if b, err = strconv.ParseInt(last, 10, 64); err != nil {
			return 0, 0, false
		}
	}
	if a < 0 || b < a || a >= size {
		return 0, 0, false
	}
	if b >= size {
		b = size - 1
	}
	return a, b, true
}

// ---------------------------------------------------------------------------
// running a plan
// ---------------------------------------------------------------------------

// errBeforeFirstByte means nothing was sent: the caller may try another way.
type errBeforeFirstByte struct{ err error }

func (e *errBeforeFirstByte) Error() string { return e.err.Error() }
func (e *errBeforeFirstByte) Unwrap() error { return e.err }

type streamer struct {
	cfg  *Config
	feed *feed
}

// headerFunc writes the response head once the first bytes exist.
type headerFunc func(status int, length int64, contentRange string)

// proxy relays one source with Range support.
func (st *streamer) proxy(ctx context.Context, p *Plan, rangeHeader string, w io.Writer, head headerFunc) (int64, error) {
	src := newSource(p.Inputs[0], st.cfg.StreamChunk, st.cfg.StreamParallel)
	if err := src.discover(ctx); err != nil {
		return 0, &errBeforeFirstByte{err}
	}
	if src.size > st.cfg.MaxOutputBytes {
		return 0, &errBeforeFirstByte{ErrContentTooLarge()}
	}
	start, end := int64(0), int64(-1)
	status := http.StatusOK
	cr := ""
	if rangeHeader != "" && src.ranged && src.size > 0 {
		if a, b, ok := parseRange(rangeHeader, src.size); ok {
			start, end, status = a, b, http.StatusPartialContent
			cr = fmt.Sprintf("bytes %d-%d/%d", a, b, src.size)
		}
	}
	body, err := src.open(ctx, start, end)
	if err != nil {
		return 0, &errBeforeFirstByte{err}
	}
	defer body.Close()
	first := make([]byte, 64*1024)
	n, err := io.ReadAtLeast(body, first, 1)
	if err != nil && n == 0 {
		return 0, &errBeforeFirstByte{err}
	}
	length := int64(-1)
	if src.size > 0 {
		if end < 0 {
			end = src.size - 1
		}
		length = end - start + 1
		if !src.ranged {
			length = src.size
		}
	}
	head(status, length, cr)
	if _, err := w.Write(first[:n]); err != nil {
		return int64(n), err
	}
	copied, err := io.Copy(w, &capReader{r: body, left: st.cfg.MaxOutputBytes - int64(n)})
	return int64(n) + copied, err
}

type capReader struct {
	r    io.Reader
	left int64
}

func (c *capReader) Read(p []byte) (int, error) {
	if c.left <= 0 {
		return 0, ErrContentTooLarge()
	}
	if int64(len(p)) > c.left {
		p = p[:c.left]
	}
	n, err := c.r.Read(p)
	c.left -= int64(n)
	return n, err
}

// ffmpeg runs the plan's muxer or encoder and pipes its output to w.
func (st *streamer) ffmpeg(ctx context.Context, p *Plan, w io.Writer, head headerFunc) (int64, error) {
	n, err := st.ffmpegOnce(ctx, p, p.Args, len(p.Inputs), w, head)
	var early *errBeforeFirstByte
	if err != nil && errors.As(err, &early) && p.Optional >= 0 && ctx.Err() == nil {
		// subtitles or a cover that will not mux are not worth failing for
		log.Printf("stream: optional input dropped: %s", RedactLog(early.Error()))
		return st.ffmpegOnce(ctx, p, p.NoOptional, p.Optional, w, head)
	}
	return n, err
}

func (st *streamer) ffmpegOnce(ctx context.Context, p *Plan, args []string, inputs int, w io.Writer, head headerFunc) (int64, error) {
	argv := []string{st.cfg.FFmpegBin, "-nostdin", "-hide_banner", "-loglevel", "error"}
	var cleanups []func()
	defer func() {
		for _, c := range cleanups {
			c()
		}
	}()
	for i := 0; i < inputs; i++ {
		in := p.Inputs[i]
		if in.Direct {
			src := newSource(in, st.cfg.StreamChunk, st.cfg.StreamParallel)
			u, done := st.feed.add(src)
			cleanups = append(cleanups, done)
			argv = append(argv, "-protocol_whitelist", "http,tcp", "-i", u)
			continue
		}
		// HLS: ffmpeg reads the playlist and its segments itself
		if _, err := ValidateURL(in.URL, true); err != nil {
			return 0, &errBeforeFirstByte{err}
		}
		var hdr strings.Builder
		for k, v := range in.Headers {
			if strings.EqualFold(k, "User-Agent") || strings.EqualFold(k, "Accept-Encoding") {
				continue
			}
			hdr.WriteString(HeaderSafe(k) + ": " + HeaderSafe(v) + "\r\n")
		}
		if c := cookieHeader(in.Cookies); c != "" {
			hdr.WriteString("Cookie: " + c + "\r\n")
		}
		if ua := in.Headers["User-Agent"]; ua != "" {
			argv = append(argv, "-user_agent", HeaderSafe(ua))
		}
		if hdr.Len() > 0 {
			argv = append(argv, "-headers", hdr.String())
		}
		argv = append(argv, "-protocol_whitelist", "https,http,tls,tcp,crypto,hls",
			"-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "4",
			"-rw_timeout", "20000000", "-i", in.URL)
	}
	argv = append(argv, args...)
	argv = append(argv, "pipe:1")

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stderr := &limitedBuffer{buf: &bytes.Buffer{}, max: 32 * 1024}
	cmd.Stderr = stderr
	out, err := cmd.StdoutPipe()
	if err != nil {
		return 0, &errBeforeFirstByte{err}
	}
	if err := cmd.Start(); err != nil {
		return 0, &errBeforeFirstByte{err}
	}
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		select {
		case <-ctx.Done():
			killGroup(cmd)
		case <-stop:
		}
	}()

	first := make([]byte, 64*1024)
	n, rerr := io.ReadAtLeast(out, first, 1)
	if n == 0 {
		killGroup(cmd)
		_ = cmd.Wait()
		msg := strings.TrimSpace(stderr.buf.String())
		if rerr == nil {
			rerr = errors.New("no output")
		}
		if msg != "" {
			rerr = fmt.Errorf("ffmpeg: %s", lastLine(msg))
		}
		return 0, &errBeforeFirstByte{rerr}
	}
	head(http.StatusOK, -1, "")
	written := int64(0)
	if _, err := w.Write(first[:n]); err != nil {
		killGroup(cmd)
		_ = cmd.Wait()
		return 0, err
	}
	written += int64(n)
	copied, cerr := io.Copy(w, &capReader{r: out, left: st.cfg.MaxOutputBytes - written})
	written += copied
	if cerr != nil {
		killGroup(cmd)
		_ = cmd.Wait()
		return written, cerr
	}
	if werr := cmd.Wait(); werr != nil {
		return written, fmt.Errorf("ffmpeg ended badly: %s", lastLine(stderr.buf.String()))
	}
	return written, nil
}

func lastLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.LastIndexByte(s, '\n'); i >= 0 {
		s = s[i+1:]
	}
	if len(s) > 300 {
		s = s[:300]
	}
	return RedactLog(s)
}
