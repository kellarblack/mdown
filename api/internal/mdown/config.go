// Package mdown is the mdown.cc API: the cobalt v11 request shape, yt-dlp for
// extraction, and a streaming tunnel that starts sending bytes while the
// source is still being fetched.
package mdown

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

const (
	MB = 1024 * 1024
	GB = 1024 * MB
)

// Config is read from the environment once, at start. Every limit is a ceiling
// for a small box, not a target. The names match the Python API, so an
// existing /etc/mdown/api.env keeps working unchanged.
type Config struct {
	Version       string
	APIURL        string
	Host          string
	Port          int
	TrustProxy    bool
	RequireOrigin bool
	CORSOrigins   []string

	APIKey           string
	ModerateKey      string
	TurnstileSitekey string
	TurnstileSecret  string

	MaxHeight      int
	MaxDuration    int
	MaxOutputBytes int64

	MaxConcurrent int
	Fragments     int
	MaxQueue      int
	JobTimeout    int
	ProbeTimeout  int
	JobTTL        int
	MaxDailyJobs  int
	MinFreeBytes  int64
	WorkDir       string

	RateLimitMax    int
	RateLimitWindow int
	ReadRateMax     int
	ReadRateWindow  int
	TunnelRateMax   int
	JobRateMax      int
	JobRateWindow   int
	ProbeRateMax    int
	ProbeRateWindow int
	ReportRateMax   int
	ReportRateWin   int
	BoardRateMax    int
	BoardRateWindow int
	InboxRateMax    int
	InboxRateWindow int

	YtdlpCookies   string
	YtdlpExtraArgs string

	// Streaming is the fast path: bytes reach the browser while the source is
	// still being read. Off means every job goes through the disk, as before.
	Streaming bool
	// StreamChunk is the size of one ranged request against the source. Some
	// CDNs throttle a single long request to playback speed; many short ranged
	// requests in parallel are not throttled.
	StreamChunk int64
	// StreamParallel is how many of those requests run ahead of the reader.
	StreamParallel int

	YtdlpBin   string
	FFmpegBin  string
	FFprobeBin string
}

// Defaults returns the configuration with no environment applied.
func Defaults() Config {
	return Config{
		Version:         "mdown-2.0-go",
		APIURL:          "http://127.0.0.1:9000/",
		Host:            "127.0.0.1",
		Port:            9000,
		RequireOrigin:   true,
		CORSOrigins:     []string{"https://mdown.cc"},
		MaxHeight:       4320,
		MaxDuration:     1800,
		MaxOutputBytes:  2048 * MB,
		MaxConcurrent:   2,
		Fragments:       8,
		MaxQueue:        6,
		JobTimeout:      300,
		ProbeTimeout:    45,
		JobTTL:          900,
		// a 1 GB box with two workers: the queue is the real ceiling, these are
		// the numbers that keep one person from eating it
		MaxDailyJobs:    800,
		MinFreeBytes:    3 * GB,
		WorkDir:         "/var/lib/mdown/jobs",
		RateLimitMax:    40,
		RateLimitWindow: 60,
		ReadRateMax:     120,
		ReadRateWindow:  60,
		TunnelRateMax:   120,
		JobRateMax:      20,
		JobRateWindow:   300,
		ProbeRateMax:    30,
		ProbeRateWindow: 300,
		ReportRateMax:   12,
		ReportRateWin:   3600,
		BoardRateMax:    6,
		BoardRateWindow: 3600,
		InboxRateMax:    6,
		InboxRateWindow: 3600,
		Streaming:       true,
		StreamChunk:     4 * MB,
		StreamParallel:  4,
		YtdlpBin:        "yt-dlp",
		FFmpegBin:       "ffmpeg",
		FFprobeBin:      "ffprobe",
	}
}

// ConfigError is a bad environment value. The process exits with code 2.
type ConfigError struct{ msg string }

func (e *ConfigError) Error() string { return e.msg }

type envReader struct {
	get func(string) string
	err error
}

func (r *envReader) str(name, fallback string) string {
	v := strings.TrimSpace(r.get(name))
	if v == "" {
		return fallback
	}
	return v
}

func (r *envReader) num(name string, fallback, low, high int) int {
	raw := strings.TrimSpace(r.get(name))
	if raw == "" {
		return fallback
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		if r.err == nil {
			r.err = &ConfigError{fmt.Sprintf("%s must be an integer, got %q", name, raw)}
		}
		return fallback
	}
	if v < low || v > high {
		if r.err == nil {
			r.err = &ConfigError{fmt.Sprintf("%s must be between %d and %d, got %d", name, low, high, v)}
		}
		return fallback
	}
	return v
}

func (r *envReader) flag(name string, fallback bool) bool {
	raw := strings.ToLower(strings.TrimSpace(r.get(name)))
	switch raw {
	case "":
		return fallback
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return fallback
}

// ConfigFromEnv reads MDOWN_* variables. Pass nil to read the process
// environment; tests pass a map lookup.
func ConfigFromEnv(get func(string) string) (Config, error) {
	if get == nil {
		get = os.Getenv
	}
	r := &envReader{get: get}
	c := Defaults()
	c.Version = r.str("MDOWN_VERSION", c.Version)
	c.APIURL = r.str("MDOWN_API_URL", c.APIURL)
	c.Host = r.str("MDOWN_HOST", c.Host)
	c.Port = r.num("MDOWN_PORT", c.Port, 1024, 65535)
	c.TrustProxy = r.flag("MDOWN_TRUST_PROXY", false)
	c.RequireOrigin = r.flag("MDOWN_REQUIRE_ORIGIN", true)
	if list := splitList(get("MDOWN_CORS_ORIGINS")); len(list) > 0 {
		c.CORSOrigins = list
	}
	c.APIKey = strings.TrimSpace(get("MDOWN_API_KEY"))
	c.ModerateKey = strings.TrimSpace(get("MDOWN_MODERATE_KEY"))
	c.TurnstileSitekey = strings.TrimSpace(get("MDOWN_TURNSTILE_SITEKEY"))
	c.TurnstileSecret = strings.TrimSpace(get("MDOWN_TURNSTILE_SECRET"))
	c.MaxHeight = r.num("MDOWN_MAX_HEIGHT", c.MaxHeight, 144, 4320)
	c.MaxDuration = r.num("MDOWN_MAX_DURATION", c.MaxDuration, 30, 86400)
	c.MaxOutputBytes = int64(r.num("MDOWN_MAX_OUTPUT_MB", 2048, 16, 8192)) * MB
	c.MaxConcurrent = r.num("MDOWN_MAX_CONCURRENT", c.MaxConcurrent, 1, 16)
	c.Fragments = r.num("MDOWN_FRAGMENTS", c.Fragments, 1, 16)
	c.MaxQueue = r.num("MDOWN_MAX_QUEUE", c.MaxQueue, 0, 100)
	c.JobTimeout = r.num("MDOWN_JOB_TIMEOUT", c.JobTimeout, 30, 3600)
	c.ProbeTimeout = r.num("MDOWN_PROBE_TIMEOUT", c.ProbeTimeout, 5, 600)
	c.JobTTL = r.num("MDOWN_JOB_TTL", c.JobTTL, 60, 86400)
	c.MaxDailyJobs = r.num("MDOWN_DAILY_JOBS", c.MaxDailyJobs, 0, 1000000)
	c.MinFreeBytes = int64(r.num("MDOWN_MIN_FREE_MB", 3072, 128, 1024*1024)) * MB
	c.WorkDir = r.str("MDOWN_WORK_DIR", c.WorkDir)
	c.RateLimitMax = r.num("MDOWN_RATE_MAX", c.RateLimitMax, 1, 10000)
	c.RateLimitWindow = r.num("MDOWN_RATE_WINDOW", c.RateLimitWindow, 1, 3600)
	c.ReadRateMax = r.num("MDOWN_READ_RATE_MAX", c.ReadRateMax, 1, 100000)
	c.ReadRateWindow = r.num("MDOWN_READ_RATE_WINDOW", c.ReadRateWindow, 1, 3600)
	c.TunnelRateMax = r.num("MDOWN_TUNNEL_RATE_MAX", c.TunnelRateMax, 1, 100000)
	c.JobRateMax = r.num("MDOWN_JOB_RATE_MAX", c.JobRateMax, 1, 10000)
	c.JobRateWindow = r.num("MDOWN_JOB_RATE_WINDOW", c.JobRateWindow, 10, 86400)
	c.ProbeRateMax = r.num("MDOWN_PROBE_RATE_MAX", c.ProbeRateMax, 1, 10000)
	c.ProbeRateWindow = r.num("MDOWN_PROBE_RATE_WINDOW", c.ProbeRateWindow, 10, 86400)
	c.ReportRateMax = r.num("MDOWN_REPORT_RATE_MAX", c.ReportRateMax, 1, 1000)
	c.ReportRateWin = r.num("MDOWN_REPORT_RATE_WINDOW", c.ReportRateWin, 60, 86400)
	c.BoardRateMax = r.num("MDOWN_BOARD_RATE_MAX", c.BoardRateMax, 1, 200)
	c.BoardRateWindow = r.num("MDOWN_BOARD_RATE_WINDOW", c.BoardRateWindow, 60, 86400)
	c.InboxRateMax = r.num("MDOWN_INBOX_RATE_MAX", c.InboxRateMax, 1, 200)
	c.InboxRateWindow = r.num("MDOWN_INBOX_RATE_WINDOW", c.InboxRateWindow, 60, 86400)
	c.YtdlpCookies = strings.TrimSpace(get("MDOWN_YTDLP_COOKIES"))
	c.YtdlpExtraArgs = strings.TrimSpace(get("MDOWN_YTDLP_EXTRA_ARGS"))
	c.Streaming = r.flag("MDOWN_STREAMING", true)
	c.StreamChunk = int64(r.num("MDOWN_STREAM_CHUNK_MB", 4, 1, 64)) * MB
	c.StreamParallel = r.num("MDOWN_STREAM_PARALLEL", c.StreamParallel, 1, 16)
	c.YtdlpBin = r.str("MDOWN_YTDLP", c.YtdlpBin)
	c.FFmpegBin = r.str("MDOWN_FFMPEG", c.FFmpegBin)
	c.FFprobeBin = r.str("MDOWN_FFPROBE", c.FFprobeBin)
	return c, r.err
}

func splitList(raw string) []string {
	var out []string
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimRight(strings.TrimSpace(item), "/")
		if item != "" {
			out = append(out, item)
		}
	}
	return out
}

// OriginAllowed reports whether a browser Origin header is on the list.
func (c *Config) OriginAllowed(origin string) bool {
	origin = strings.TrimRight(origin, "/")
	if origin == "" {
		return false
	}
	for _, o := range c.CORSOrigins {
		if o == origin {
			return true
		}
	}
	return false
}
