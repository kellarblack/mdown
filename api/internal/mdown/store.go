package mdown

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// rate limiter: sliding window per client key, in memory
// ---------------------------------------------------------------------------

type RateLimiter struct {
	Max    int
	Window time.Duration
	mu     sync.Mutex
	hits   map[string][]time.Time
	now    func() time.Time
}

type Verdict struct {
	Allowed   bool
	Remaining int
	Retry     int
}

func NewRateLimiter(max, windowSeconds int) *RateLimiter {
	return &RateLimiter{Max: max, Window: time.Duration(windowSeconds) * time.Second,
		hits: map[string][]time.Time{}, now: time.Now}
}

func (l *RateLimiter) Check(key string) Verdict {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	kept := l.hits[key][:0]
	for _, t := range l.hits[key] {
		if now.Sub(t) < l.Window {
			kept = append(kept, t)
		}
	}
	if len(kept) >= l.Max {
		l.hits[key] = kept
		retry := int((l.Window - now.Sub(kept[0])).Seconds()) + 1
		if retry < 1 {
			retry = 1
		}
		return Verdict{false, 0, retry}
	}
	kept = append(kept, now)
	l.hits[key] = kept
	return Verdict{true, l.Max - len(kept), int((l.Window - now.Sub(kept[0])).Seconds()) + 1}
}

// Prune drops expired windows, so a scanner leaves nothing behind.
func (l *RateLimiter) Prune() {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	for key, list := range l.hits {
		kept := list[:0]
		for _, t := range list {
			if now.Sub(t) < l.Window {
				kept = append(kept, t)
			}
		}
		if len(kept) == 0 {
			delete(l.hits, key)
		} else {
			l.hits[key] = kept
		}
	}
}

// ---------------------------------------------------------------------------
// request board / private inbox: one JSONL file, approval before display
// ---------------------------------------------------------------------------

type BoardItem struct {
	ID   string `json:"id"`
	T    int64  `json:"t"`
	Text string `json:"text"`
	OK   bool   `json:"ok"`
}

type Board struct {
	path    string
	keep    int
	maxText int
	mu      sync.Mutex
	items   []BoardItem
	loaded  bool
}

func NewBoard(path string, keep, maxText int) *Board {
	return &Board{path: path, keep: keep, maxText: maxText}
}

func (b *Board) load() {
	if b.loaded {
		return
	}
	b.loaded = true
	f, err := os.Open(b.path)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var raw map[string]any
		if json.Unmarshal([]byte(line), &raw) != nil {
			continue
		}
		id, _ := raw["id"].(string)
		text, _ := raw["text"].(string)
		if id == "" || text == "" {
			continue
		}
		t, _ := raw["t"].(float64)
		ok := true // entries written before approval existed were public
		if v, present := raw["ok"].(bool); present {
			ok = v
		}
		b.items = append(b.items, BoardItem{ID: id, T: int64(t), Text: text, OK: ok})
	}
	if len(b.items) > b.keep {
		b.items = b.items[len(b.items)-b.keep:]
	}
}

func (b *Board) save() error {
	if err := os.MkdirAll(filepath.Dir(b.path), 0o700); err != nil {
		return err
	}
	tmp := b.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	w := bufio.NewWriter(f)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	for _, it := range b.items {
		if err := enc.Encode(it); err != nil {
			f.Close()
			return err
		}
	}
	if err := w.Flush(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, b.path)
}

func randomToken(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

func (b *Board) Add(raw string) (BoardItem, error) {
	text, err := normalizeBoardText(raw, b.maxText)
	if err != nil {
		return BoardItem{}, err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.load()
	item := BoardItem{ID: randomToken(6), T: time.Now().Unix(), Text: text}
	b.items = append(b.items, item)
	if len(b.items) > b.keep {
		b.items = b.items[len(b.items)-b.keep:]
	}
	return item, b.save()
}

// List returns approved items, newest first.
func (b *Board) List(limit int) []BoardItem {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.load()
	out := []BoardItem{}
	for i := len(b.items) - 1; i >= 0 && len(out) < limit; i-- {
		if b.items[i].OK {
			out = append(out, b.items[i])
		}
	}
	return out
}

// Pending returns items waiting for approval, oldest first.
func (b *Board) Pending(limit int) []BoardItem {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.load()
	out := []BoardItem{}
	for _, it := range b.items {
		if !it.OK && len(out) < limit {
			out = append(out, it)
		}
	}
	return out
}

func (b *Board) Approve(id string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.load()
	for i := range b.items {
		if b.items[i].ID == id {
			b.items[i].OK = true
			_ = b.save()
			return true
		}
	}
	return false
}

func (b *Board) Delete(id string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.load()
	kept := b.items[:0]
	found := false
	for _, it := range b.items {
		if it.ID == id {
			found = true
			continue
		}
		kept = append(kept, it)
	}
	b.items = kept
	if found {
		_ = b.save()
	}
	return found
}

func (b *Board) Count() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.load()
	n := 0
	for _, it := range b.items {
		if it.OK {
			n++
		}
	}
	return n
}

// ---------------------------------------------------------------------------
// uptime: one sample a minute, daily buckets, gaps counted as down
// ---------------------------------------------------------------------------

type Uptime struct {
	path     string
	keepDays int
	mu       sync.Mutex
	data     map[string][2]int
	lastAt   float64
	lastSave time.Time
	now      func() time.Time
}

const uptimeGap = 150 * time.Second

func NewUptime(path string) *Uptime {
	u := &Uptime{path: path, keepDays: 35, data: map[string][2]int{}, now: time.Now}
	u.load()
	return u
}

func (u *Uptime) load() {
	raw, err := os.ReadFile(u.path)
	if err != nil {
		return
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil {
		return
	}
	for k, v := range m {
		if k == "_at" {
			_ = json.Unmarshal(v, &u.lastAt)
			continue
		}
		var pair []int
		if json.Unmarshal(v, &pair) == nil && len(pair) == 2 {
			u.data[k] = [2]int{pair[0], pair[1]}
		}
	}
}

func (u *Uptime) saveLocked() {
	payload := map[string]any{}
	for k, v := range u.data {
		payload[k] = []int{v[0], v[1]}
	}
	payload["_at"] = u.lastAt
	body, _ := json.Marshal(payload)
	_ = os.MkdirAll(filepath.Dir(u.path), 0o700)
	tmp := u.path + ".tmp"
	if os.WriteFile(tmp, body, 0o600) == nil && os.Rename(tmp, u.path) == nil {
		u.lastSave = u.now()
	}
}

func dayOf(t time.Time) string { return t.UTC().Format("2006-01-02") }

func (u *Uptime) fillGapLocked(now time.Time) int {
	if u.lastAt == 0 {
		return 0
	}
	last := time.Unix(0, int64(u.lastAt*1e9))
	if now.Sub(last) <= uptimeGap || now.Sub(last) > time.Duration(u.keepDays)*24*time.Hour {
		return 0
	}
	missed := 0
	for at := last.Add(time.Minute); at.Before(now.Add(-30 * time.Second)); at = at.Add(time.Minute) {
		d := dayOf(at)
		p := u.data[d]
		p[1]++
		u.data[d] = p
		missed++
	}
	return missed
}

func (u *Uptime) Record(ok bool) {
	now := u.now()
	u.mu.Lock()
	defer u.mu.Unlock()
	u.fillGapLocked(now)
	d := dayOf(now)
	p := u.data[d]
	p[1]++
	if ok {
		p[0]++
	}
	u.data[d] = p
	u.lastAt = float64(now.UnixNano()) / 1e9
	cutoff := dayOf(now.Add(-time.Duration(u.keepDays) * 24 * time.Hour))
	for k := range u.data {
		if k < cutoff {
			delete(u.data, k)
		}
	}
	if now.Sub(u.lastSave) > 120*time.Second {
		u.saveLocked()
	}
}

func (u *Uptime) Flush() {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.saveLocked()
}

func (u *Uptime) Summary(days int) map[string]any {
	u.mu.Lock()
	data := make(map[string][2]int, len(u.data))
	for k, v := range u.data {
		data[k] = v
	}
	lastAt := u.lastAt
	u.mu.Unlock()
	now := u.now()
	out := make([]map[string]any, 0, days)
	up, all := 0, 0
	for off := days - 1; off >= 0; off-- {
		d := dayOf(now.Add(-time.Duration(off) * 24 * time.Hour))
		if p, ok := data[d]; ok {
			out = append(out, map[string]any{"date": d, "up": p[0], "total": p[1]})
			up += p[0]
			all += p[1]
		} else {
			out = append(out, map[string]any{"date": d, "up": nil, "total": nil})
		}
	}
	var pct any
	if all > 0 {
		pct = float64(int(float64(up)/float64(all)*10000+0.5)) / 100
	}
	var since any
	if len(out) > 0 {
		since = out[0]["date"]
	}
	var last any
	if lastAt > 0 {
		last = int64(lastAt)
	}
	return map[string]any{"days": out, "checks": all, "up": up, "uptime": pct,
		"since": since, "lastSampleAt": last}
}

// sortedKeys is used by tests and the sweeper for a stable order.
func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
