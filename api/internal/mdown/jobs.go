package mdown

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

// TokenRE is the shape of a tunnel capability token.
var TokenRE = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)

// PickerNeeded means the link holds several items: the client chooses.
type PickerNeeded struct {
	Entries []Entry
	Title   string
}

func (p *PickerNeeded) Error() string { return "picker" }

// Tunnel is what a /tunnel/<token> URL leads to: a finished file on disk, or
// a plan that produces the bytes as they are requested.
type Tunnel struct {
	Token    string
	Link     string
	Opts     DownloadOptions
	Filename string
	Created  time.Time
	ReadyAt  time.Time
	ServedAt time.Time

	// disk
	Path string
	Size int64

	// stream
	Plan  *Plan
	Title string

	mu sync.Mutex // serialises the one-time disk fallback
}

// Jobs owns capacity, the tunnel table and cleanup.
type Jobs struct {
	cfg    *Config
	engine *Engine

	mu      sync.Mutex
	tunnels map[string]*Tunnel

	slots   chan struct{} // disk jobs and extractions
	streams chan struct{} // live tunnels
	queued  int
	active  int
	cmu     sync.Mutex

	day      string
	dayCount int
	started  time.Time
	stop     chan struct{}

	freeBytes func() int64
}

func NewJobs(cfg *Config, engine *Engine) (*Jobs, error) {
	if err := os.MkdirAll(cfg.WorkDir, 0o700); err != nil {
		return nil, err
	}
	streams := cfg.MaxConcurrent * 4
	if streams < 4 {
		streams = 4
	}
	j := &Jobs{cfg: cfg, engine: engine, tunnels: map[string]*Tunnel{},
		slots: make(chan struct{}, cfg.MaxConcurrent), streams: make(chan struct{}, streams),
		started: time.Now(), stop: make(chan struct{})}
	j.freeBytes = func() int64 {
		var st syscall.Statfs_t
		if syscall.Statfs(cfg.WorkDir, &st) != nil {
			return 0
		}
		return int64(st.Bavail) * int64(st.Bsize)
	}
	return j, nil
}

func (j *Jobs) Start() {
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-j.stop:
				return
			case <-t.C:
				j.Sweep()
			}
		}
	}()
}

func (j *Jobs) Stop() {
	select {
	case <-j.stop:
	default:
		close(j.stop)
	}
}

// acquire takes a job slot, queueing behind at most MaxQueue others.
func (j *Jobs) acquire(ctx context.Context) (func(), error) {
	select {
	case j.slots <- struct{}{}:
	default:
		j.cmu.Lock()
		if j.queued >= j.cfg.MaxQueue {
			j.cmu.Unlock()
			return nil, ErrBusy()
		}
		j.queued++
		j.cmu.Unlock()
		select {
		case j.slots <- struct{}{}:
			j.cmu.Lock()
			j.queued--
			j.cmu.Unlock()
		case <-ctx.Done():
			j.cmu.Lock()
			j.queued--
			j.cmu.Unlock()
			return nil, ctx.Err()
		}
	}
	j.cmu.Lock()
	j.active++
	j.cmu.Unlock()
	return func() {
		j.cmu.Lock()
		j.active--
		j.cmu.Unlock()
		<-j.slots
	}, nil
}

// acquireStream takes a live-tunnel slot, waiting a little before saying busy.
func (j *Jobs) acquireStream(ctx context.Context) (func(), error) {
	t := time.NewTimer(20 * time.Second)
	defer t.Stop()
	select {
	case j.streams <- struct{}{}:
		return func() { <-j.streams }, nil
	case <-t.C:
		return nil, ErrBusy()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (j *Jobs) claimDaily() error {
	if j.cfg.MaxDailyJobs == 0 {
		return nil
	}
	today := time.Now().Format("2006-01-02")
	j.cmu.Lock()
	defer j.cmu.Unlock()
	if today != j.day {
		j.day, j.dayCount = today, 0
	}
	if j.dayCount >= j.cfg.MaxDailyJobs {
		return errWith("api.rate_limit", 429, map[string]any{"reason": "daily_cap"}, "daily job cap reached")
	}
	j.dayCount++
	return nil
}

func (j *Jobs) newToken() string {
	for {
		t := randomToken(24)
		if TokenRE.MatchString(t) {
			return t
		}
	}
}

// Create resolves a link into a tunnel. With streaming on, this returns as
// soon as the formats are known; the bytes are produced when the tunnel is
// fetched. Without a usable plan the file is fetched to disk first.
func (j *Jobs) Create(ctx context.Context, link string, o DownloadOptions) (*Tunnel, error) {
	release, err := j.acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	if err := j.claimDaily(); err != nil {
		return nil, err
	}
	info, err := j.engine.Probe(ctx, link)
	if err != nil {
		return nil, err
	}
	if info.IsLive {
		return nil, ErrLive()
	}
	if len(info.Entries) > 1 {
		return nil, &PickerNeeded{Entries: info.Entries, Title: info.Title}
	}
	if info.Duration <= 0 {
		return nil, ErrUnavailable("duration unknown, refusing to guess")
	}
	if info.Duration > float64(j.cfg.MaxDuration) {
		return nil, ErrTooLong(j.cfg.MaxDuration)
	}
	if o.Height <= 0 || o.Height > j.cfg.MaxHeight {
		o.Height = j.cfg.MaxHeight
	}

	if j.cfg.Streaming {
		if plan := BuildPlan(info, o, j.cfg.MaxHeight); plan != nil {
			if plan.Estimate > j.cfg.MaxOutputBytes && plan.Exact {
				return nil, ErrContentTooLarge()
			}
			t := &Tunnel{Token: j.newToken(), Link: link, Opts: o, Plan: plan, Title: info.Title,
				Filename: SafeFilename(info.Title, plan.Ext), Created: time.Now(), ReadyAt: time.Now(),
				Size: plan.Estimate}
			j.put(t)
			return t, nil
		}
	}
	return j.toDisk(ctx, link, info.Title, o)
}

// toDisk runs the yt-dlp download and verifies the file. The caller holds a slot.
func (j *Jobs) toDisk(ctx context.Context, link, title string, o DownloadOptions) (*Tunnel, error) {
	if j.freeBytes() < j.cfg.MinFreeBytes {
		return nil, errWith("api.instance.not_ready", 503, map[string]any{"reason": "disk"},
			"not enough free disk for another download")
	}
	token := j.newToken()
	dest := filepath.Join(j.cfg.WorkDir, token)
	if err := os.MkdirAll(dest, 0o700); err != nil {
		return nil, ErrInternal(err.Error())
	}
	ok := false
	defer func() {
		if !ok {
			_ = os.RemoveAll(dest)
		}
	}()
	path, err := j.engine.DownloadToDisk(ctx, link, dest, o)
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(path)
	if err != nil || st.Size() <= 0 {
		return nil, ErrUnavailable("empty output")
	}
	if st.Size() > j.cfg.MaxOutputBytes {
		return nil, ErrContentTooLarge()
	}
	facts, err := j.engine.ProbeFile(ctx, path)
	if err != nil {
		return nil, err
	}
	if facts.HasVideo && facts.Height > j.cfg.MaxHeight {
		return nil, ErrUnavailable("resolution above the cap")
	}
	if facts.Duration > float64(j.cfg.MaxDuration+5) {
		return nil, ErrTooLong(j.cfg.MaxDuration)
	}
	if o.Mode == "audio" && facts.HasVideo {
		return nil, ErrUnavailable("audio mode returned a video")
	}
	ext := strings.TrimPrefix(filepath.Ext(path), ".")
	t := &Tunnel{Token: token, Link: link, Opts: o, Path: path, Size: st.Size(),
		Filename: SafeFilename(title, ext), Created: time.Now(), ReadyAt: time.Now(), Title: title}
	j.put(t)
	ok = true
	return t, nil
}

// Fallback turns a stream tunnel into a disk tunnel, once, when the source
// would not stream. Concurrent fetches of the same tunnel wait for one run.
func (j *Jobs) Fallback(ctx context.Context, t *Tunnel) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.Path != "" {
		return nil
	}
	release, err := j.acquire(ctx)
	if err != nil {
		return err
	}
	defer release()
	disk, err := j.toDisk(ctx, t.Link, t.Title, t.Opts)
	if err != nil {
		return err
	}
	j.mu.Lock()
	delete(j.tunnels, disk.Token) // the file belongs to the original token now
	j.mu.Unlock()
	t.Path, t.Size, t.Plan = disk.Path, disk.Size, nil
	t.Filename = disk.Filename
	return nil
}

func (j *Jobs) put(t *Tunnel) {
	j.mu.Lock()
	j.tunnels[t.Token] = t
	j.mu.Unlock()
}

func (j *Jobs) Get(token string) *Tunnel {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.tunnels[token]
}

func (j *Jobs) MarkServed(token string) {
	j.mu.Lock()
	if t := j.tunnels[token]; t != nil {
		t.ServedAt = time.Now()
	}
	j.mu.Unlock()
}

// Sweep deletes served and expired tunnels and orphaned directories.
func (j *Jobs) Sweep() {
	now := time.Now()
	ttl := time.Duration(j.cfg.JobTTL) * time.Second
	var expired []*Tunnel
	j.mu.Lock()
	for token, t := range j.tunnels {
		if (!t.ServedAt.IsZero() && now.Sub(t.ServedAt) > 60*time.Second) || now.Sub(t.ReadyAt) > ttl {
			expired = append(expired, t)
			delete(j.tunnels, token)
		}
	}
	live := map[string]bool{}
	for token := range j.tunnels {
		live[token] = true
	}
	j.mu.Unlock()
	for _, t := range expired {
		if t.Path != "" {
			_ = os.RemoveAll(filepath.Dir(t.Path))
		}
	}
	entries, err := os.ReadDir(j.cfg.WorkDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() || e.Name() == ".cache" || live[e.Name()] {
			continue
		}
		if info, err := e.Info(); err == nil && now.Sub(info.ModTime()) > 2*ttl {
			_ = os.RemoveAll(filepath.Join(j.cfg.WorkDir, e.Name()))
		}
	}
	// thumbnails: seven days, four hundred files
	dir := filepath.Join(j.cfg.WorkDir, ".cache", "thumbs")
	thumbs, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type kept struct {
		at   time.Time
		path string
	}
	var keep []kept
	for _, e := range thumbs {
		info, err := e.Info()
		if err != nil {
			continue
		}
		p := filepath.Join(dir, e.Name())
		if now.Sub(info.ModTime()) > 7*24*time.Hour {
			_ = os.Remove(p)
		} else {
			keep = append(keep, kept{info.ModTime(), p})
		}
	}
	if len(keep) > 400 {
		sort.Slice(keep, func(a, b int) bool { return keep[a].at.Before(keep[b].at) })
		for _, k := range keep[:len(keep)-400] {
			_ = os.Remove(k.path)
		}
	}
}

func (j *Jobs) Stats() map[string]any {
	j.mu.Lock()
	ready := len(j.tunnels)
	j.mu.Unlock()
	j.cmu.Lock()
	active, queued, today := j.active, j.queued, j.dayCount
	j.cmu.Unlock()
	return map[string]any{
		"active": active + len(j.streams), "queued": queued, "ready_jobs": ready, "today": today,
		"disk_free_mb": j.freeBytes() / MB, "uptime_s": int(time.Since(j.started).Seconds()),
	}
}
