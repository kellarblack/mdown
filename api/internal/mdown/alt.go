package mdown

import (
	"context"
	"encoding/json"
	"math"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Alternative is the same recording found on YouTube, offered when the
// original source only serves it encrypted. Nothing is decrypted: the page
// downloads the YouTube upload through the normal path.
type Alternative struct {
	URL     string `json:"url"`
	Title   string `json:"title"`
	Channel string `json:"channel"`
}

type altEntry struct {
	ID       string  `json:"id"`
	Title    string  `json:"title"`
	Channel  string  `json:"channel"`
	Uploader string  `json:"uploader"`
	Duration float64 `json:"duration"`
}

type altCached struct {
	alt *Alternative
	at  time.Time
}

var (
	altMu    sync.Mutex
	altCache = map[string]altCached{}
)

var (
	altFeatRE  = regexp.MustCompile(`(?i)\s*[(\[](feat\.?|ft\.?|with|prod\.?)[^)\]]*[)\]]`)
	altWordRE  = regexp.MustCompile(`[\p{L}\p{N}]+`)
	altBadRE   = regexp.MustCompile(`(?i)\b(remix|sped ?up|slowed|reverb|nightcore|8d|cover|karaoke|instrumental|live|reaction|full album|1 hour|loop|bass ?boosted|mashup)\b`)
	altVideoID = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)
)

func altWords(v string) []string {
	return altWordRE.FindAllString(strings.ToLower(v), -1)
}

// containsWords reports whether every word of want appears in have.
func containsWords(have string, want []string) bool {
	set := map[string]bool{}
	for _, w := range altWords(have) {
		set[w] = true
	}
	for _, w := range want {
		if !set[w] {
			return false
		}
	}
	return len(want) > 0
}

// pickAlternative scores YouTube results against the track. A result must
// carry the track's title and, when both lengths are known, run within a few
// seconds of it; edits (remix, sped up, live...) are refused unless the
// original title says so too.
func pickAlternative(track, artist string, duration float64, entries []altEntry) *altEntry {
	track = strings.TrimSpace(altFeatRE.ReplaceAllString(track, ""))
	trackWords := altWords(track)
	artistWords := altWords(artist)
	var best *altEntry
	bestScore := 0
	for i := range entries {
		e := &entries[i]
		if !altVideoID.MatchString(e.ID) {
			continue
		}
		channel := e.Channel
		if channel == "" {
			channel = e.Uploader
		}
		score := 0
		if !containsWords(e.Title, trackWords) {
			continue
		}
		score += 30
		if duration > 0 && e.Duration > 0 {
			d := math.Abs(duration - e.Duration)
			switch {
			case d <= 3:
				score += 50
			case d <= 8:
				score += 20
			case d > 30:
				continue
			default:
				score -= 20
			}
		}
		if altBadRE.MatchString(e.Title) && !altBadRE.MatchString(track) {
			continue
		}
		if containsWords(e.Title+" "+channel, artistWords) {
			score += 15
		}
		lc := strings.ToLower(channel)
		if strings.HasSuffix(lc, " - topic") || strings.Join(altWords(channel), " ") == strings.Join(artistWords, " ") {
			score += 10
		}
		lt := strings.ToLower(e.Title)
		if strings.Contains(lt, "official audio") {
			score += 10
		} else if strings.Contains(lt, "audio") {
			score += 5
		}
		if score > bestScore {
			best, bestScore = e, score
		}
	}
	if bestScore < 60 {
		return nil
	}
	return best
}

func isSoundCloud(link string) bool {
	u, err := url.Parse(link)
	if err != nil {
		return false
	}
	h := strings.ToLower(u.Hostname())
	return h == "soundcloud.com" || strings.HasSuffix(h, ".soundcloud.com")
}

// Alternative looks up the same recording on YouTube. It returns nil when
// nothing matches well enough; a wrong song is worse than no offer.
func (e *Engine) Alternative(ctx context.Context, link string) *Alternative {
	if !isSoundCloud(link) {
		return nil
	}
	altMu.Lock()
	if c, ok := altCache[link]; ok && time.Since(c.at) < 6*time.Hour {
		altMu.Unlock()
		return c.alt
	}
	altMu.Unlock()

	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	env := []string{"XDG_CACHE_HOME=" + e.cacheDir()}
	// the track's facts are readable even when every stream is encrypted
	argv := append(e.ytdlpBase(), "--ignore-no-formats-error", "--dump-single-json", "--skip-download",
		"--no-warnings", "--socket-timeout", "15", link)
	code, out, _, err := run(ctx, argv, 20*time.Second, env, 8*MB)
	if err != nil || code != 0 {
		return nil
	}
	var meta struct {
		Title    string  `json:"title"`
		Track    string  `json:"track"`
		Artist   string  `json:"artist"`
		Uploader string  `json:"uploader"`
		Duration float64 `json:"duration"`
	}
	if json.Unmarshal(out, &meta) != nil {
		return nil
	}
	track := firstNonEmpty(meta.Track, meta.Title)
	artist := firstNonEmpty(meta.Artist, meta.Uploader)
	if track == "" {
		return nil
	}
	query := track
	if artist != "" && !containsWords(track, altWords(artist)) {
		query = artist + " " + track
	}
	argv = append(e.ytdlpBase(), "--flat-playlist", "--dump-single-json", "--no-warnings",
		"--socket-timeout", "15", "ytsearch6:"+query)
	code, out, _, err = run(ctx, argv, 20*time.Second, env, 8*MB)
	if err != nil || code != 0 {
		return nil
	}
	var res struct {
		Entries []altEntry `json:"entries"`
	}
	if json.Unmarshal(out, &res) != nil {
		return nil
	}
	var alt *Alternative
	if best := pickAlternative(track, artist, meta.Duration, res.Entries); best != nil {
		alt = &Alternative{URL: "https://www.youtube.com/watch?v=" + best.ID, Title: best.Title,
			Channel: firstNonEmpty(best.Channel, best.Uploader)}
	}
	altMu.Lock()
	if len(altCache) >= 500 {
		altCache = map[string]altCached{}
	}
	altCache[link] = altCached{alt: alt, at: time.Now()}
	altMu.Unlock()
	return alt
}
