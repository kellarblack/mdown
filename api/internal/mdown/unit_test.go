package mdown

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fakeDNS(t *testing.T, answers map[string][]string) {
	t.Helper()
	old := Resolver
	Resolver = func(_ context.Context, host string) ([]string, error) {
		if a, ok := answers[host]; ok {
			return a, nil
		}
		return nil, os.ErrNotExist
	}
	t.Cleanup(func() { Resolver = old })
}

func TestValidateURLAccepts(t *testing.T) {
	fakeDNS(t, map[string][]string{"www.youtube.com": {"142.250.1.1"}, "youtu.be": {"2607:f8b0::1"}})
	for in, want := range map[string]string{
		"https://www.youtube.com/watch?v=abc":     "https://www.youtube.com/watch?v=abc",
		"  https://WWW.YouTube.com:443/watch?v=x": "https://www.youtube.com/watch?v=x",
		"http://youtu.be/xyz#frag":                "http://youtu.be/xyz",
		"https://www.youtube.com":                 "https://www.youtube.com/",
	} {
		got, err := ValidateURL(in, true)
		if err != nil || got != want {
			t.Errorf("ValidateURL(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
}

func TestValidateURLRejects(t *testing.T) {
	fakeDNS(t, map[string][]string{"evil.example.org": {"10.0.0.5"}, "mixed.org": {"8.8.8.8", "127.0.0.1"}})
	for _, in := range []string{
		"", "ftp://x.org/a", "file:///etc/passwd", "javascript:alert(1)",
		"http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest", "http://10.1.2.3/",
		"http://192.168.0.1/", "http://0.0.0.0/", "http://[::ffff:127.0.0.1]/",
		"http://127.1/", "http://2130706433/", "http://017700000001/",
		"http://localhost/", "http://printer.local/", "http://db.internal/", "http://a.test/",
		"http://user:pass@youtube.com/", "http://youtube.com:8080/", "https://evil.example.org/",
		"https://mixed.org/", "https://nowhere-at-all.org/", "http://intranet/",
		"https://x.org/\x00", "https://x.org/" + strings.Repeat("a", 3000),
	} {
		if got, err := ValidateURL(in, true); err == nil {
			t.Errorf("ValidateURL(%q) accepted as %q", in, got)
		}
	}
}

func TestBlockedIPs(t *testing.T) {
	for _, ip := range []string{"127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254",
		"100.64.0.1", "::1", "fe80::1", "fc00::1", "::ffff:10.0.0.1", "224.0.0.1", "not-an-ip"} {
		if !IsBlockedIP(ip) {
			t.Errorf("%s should be blocked", ip)
		}
	}
	for _, ip := range []string{"8.8.8.8", "142.250.1.1", "2607:f8b0::1"} {
		if IsBlockedIP(ip) {
			t.Errorf("%s should be allowed", ip)
		}
	}
}

func TestSafeFilename(t *testing.T) {
	cases := map[[2]string]string{
		{"a/b\\c:d", "mp4"}:               "a-b-c-d.mp4",
		{"\x00\x1fhi\x7f", "mp3"}:         "hi.mp3",
		{"", "webm"}:                      "download.webm",
		{"  ..title.. ", "MKV"}:           "title.mkv",
		{"x", "../../etc"}:                "x.bin",
		{strings.Repeat("é", 300), "m4a"}: strings.Repeat("é", 110) + ".m4a",
	}
	for in, want := range cases {
		if got := SafeFilename(in[0], in[1]); got != want {
			t.Errorf("SafeFilename(%q,%q) = %q, want %q", in[0], in[1], got, want)
		}
	}
}

func TestRedactAndHeaders(t *testing.T) {
	line := "GET /tunnel/AbCdEfGhIjKlMnOp1234?x=1 failed fetching https://youtube.com/watch?v=abc"
	got := RedactLog(line)
	if strings.Contains(got, "AbCdEf") || strings.Contains(got, "youtube") || strings.Contains(got, "x=1") {
		t.Fatalf("not redacted: %q", got)
	}
	if HeaderSafe("a\r\nSet-Cookie: x") != "aSet-Cookie: x" {
		t.Fatal("header not cleaned")
	}
	if c := cookieHeader("a=1; Domain=.x.com; Path=/; Secure; b=2; Expires=Wed"); c != "a=1; b=2" {
		t.Fatalf("cookie header = %q", c)
	}
}

func TestRateLimiter(t *testing.T) {
	l := NewRateLimiter(2, 60)
	now := time.Unix(1000, 0)
	l.now = func() time.Time { return now }
	if !l.Check("a").Allowed || !l.Check("a").Allowed {
		t.Fatal("first two must pass")
	}
	v := l.Check("a")
	if v.Allowed || v.Retry < 1 {
		t.Fatalf("third must fail with retry: %+v", v)
	}
	if !l.Check("b").Allowed {
		t.Fatal("another key has its own window")
	}
	now = now.Add(61 * time.Second)
	if !l.Check("a").Allowed {
		t.Fatal("window must slide")
	}
	l.Prune()
}

func TestBoard(t *testing.T) {
	path := filepath.Join(t.TempDir(), "board.jsonl")
	b := NewBoard(path, 3, 20)
	if _, err := b.Add("  "); err == nil {
		t.Fatal("empty text must fail")
	}
	one, _ := b.Add("first\n\tline   here")
	if one.Text != "first line here" || one.OK {
		t.Fatalf("bad item %+v", one)
	}
	two, _ := b.Add(strings.Repeat("x", 50))
	if len(two.Text) != 20 {
		t.Fatalf("text not clipped: %d", len(two.Text))
	}
	if len(b.List(10)) != 0 || len(b.Pending(10)) != 2 {
		t.Fatal("new items wait for approval")
	}
	if !b.Approve(one.ID) || b.Count() != 1 {
		t.Fatal("approve")
	}
	again := NewBoard(path, 3, 20)
	if again.Count() != 1 || len(again.Pending(10)) != 1 {
		t.Fatal("state must survive a reload")
	}
	if !again.Delete(two.ID) || again.Delete("nope") {
		t.Fatal("delete")
	}
	for i := 0; i < 5; i++ {
		_, _ = again.Add("filler text")
	}
	if len(again.Pending(10))+again.Count() != 3 {
		t.Fatal("keep limit")
	}
}

func TestUptimeGapCountsAsDown(t *testing.T) {
	u := NewUptime(filepath.Join(t.TempDir(), "uptime.json"))
	now := time.Date(2026, 1, 2, 12, 0, 0, 0, time.UTC)
	u.now = func() time.Time { return now }
	u.Record(true)
	now = now.Add(10 * time.Minute)
	u.Record(true)
	sum := u.Summary(1)
	days := sum["days"].([]map[string]any)
	if days[0]["up"].(int) != 2 || days[0]["total"].(int) < 10 {
		t.Fatalf("gap not filled: %+v", days[0])
	}
	u.Flush()
	again := NewUptime(u.path)
	if again.lastAt == 0 {
		t.Fatal("timestamp must persist")
	}
}

func TestParseRange(t *testing.T) {
	cases := []struct {
		h    string
		a, b int64
		ok   bool
	}{
		{"bytes=0-99", 0, 99, true}, {"bytes=100-", 100, 999, true}, {"bytes=-10", 990, 999, true},
		{"bytes=900-5000", 900, 999, true}, {"bytes=1000-", 0, 0, false}, {"bytes=5-1", 0, 0, false},
		{"bytes=0-1,5-6", 0, 0, false}, {"items=0-1", 0, 0, false},
	}
	for _, c := range cases {
		a, b, ok := parseRange(c.h, 1000)
		if ok != c.ok || (ok && (a != c.a || b != c.b)) {
			t.Errorf("parseRange(%q) = %d,%d,%v", c.h, a, b, ok)
		}
	}
}

func TestClassify(t *testing.T) {
	if e := Classify("ERROR: Private video. Sign in"); e == nil || e.Code != "api.content.video.private" {
		t.Fatalf("got %+v", e)
	}
	for text, want := range map[string]string{
		"ERROR: [vimeo] 1: The web client only works when logged-in. Use --cookies":                 "api.content.login",
		"ERROR: [Reddit] x: Account authentication is required. Use --cookies-from-browser":         "api.content.login",
		"ERROR: [dailymotion] x8j1x2o: Not found.\n":                                                "api.content.video.unavailable",
		"ERROR: [Bandcamp] a: The extractor is attempting impersonation, but no impersonate target": "api.service.unavailable",
		"ERROR: [Bandcamp] a: Got client challenge webpage response with chrome-152":                "api.service.unavailable",
	} {
		if e := Classify(text); e == nil || e.Code != want {
			t.Errorf("Classify(%q) = %+v, want %s", text, e, want)
		}
	}
	if Classify("ERROR: [youtube] x: Sign in to confirm you're not a bot. Use --cookies-from-browser") != nil {
		t.Fatal("the bot wall must stay retryable")
	}
	if Classify("ERROR: ffmpeg not found. Please install") != nil {
		t.Fatal("a missing tool is not a missing video")
	}
	if Classify("something else entirely") != nil {
		t.Fatal("unknown text must not classify")
	}
}

func TestShellSplit(t *testing.T) {
	got := shellSplit(`--extractor-args "youtube:player_client=tv,web_safari" -v`)
	if len(got) != 3 || got[1] != "youtube:player_client=tv,web_safari" {
		t.Fatalf("got %q", got)
	}
}

func TestConfigFromEnv(t *testing.T) {
	env := map[string]string{"MDOWN_PORT": "9100", "MDOWN_CORS_ORIGINS": "https://a.cc/, https://b.cc", "MDOWN_STREAMING": "0"}
	c, err := ConfigFromEnv(func(k string) string { return env[k] })
	if err != nil || c.Port != 9100 || len(c.CORSOrigins) != 2 || c.CORSOrigins[0] != "https://a.cc" || c.Streaming {
		t.Fatalf("config %+v %v", c, err)
	}
	env["MDOWN_PORT"] = "80"
	if _, err := ConfigFromEnv(func(k string) string { return env[k] }); err == nil {
		t.Fatal("port below 1024 must fail")
	}
}

func TestUptimeNeverRoundsUpTo100(t *testing.T) {
	u := NewUptime(filepath.Join(t.TempDir(), "uptime.json"))
	now := time.Date(2026, 1, 2, 12, 0, 0, 0, time.UTC)
	u.now = func() time.Time { return now }
	u.data["2026-01-02"] = [2]int{19999, 20000}
	if got := u.Summary(1)["uptime"].(float64); got >= 100 {
		t.Fatalf("19999/20000 reported as %v", got)
	}
}

func TestChunkPlan(t *testing.T) {
	small := chunkPlan(4*MB, 4*MB)
	if small(0) != 256*1024 || small(1) != 512*1024 {
		t.Fatalf("small file: first %d, then %d", small(0), small(1))
	}
	big := chunkPlan(300*MB, 4*MB)
	if big(0) != 256*1024 || big(5) != 4*MB {
		t.Fatalf("big file: first %d, then %d", big(0), big(5))
	}
	tiny := chunkPlan(100*1024, 4*MB)
	if tiny(0) != 256*1024 && tiny(0) != 512*1024 {
		t.Fatalf("tiny file: %d", tiny(0))
	}
}
