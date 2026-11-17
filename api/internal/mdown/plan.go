package mdown

import (
	"fmt"
	"strings"
)

// Input is one source stream for a plan.
type Input struct {
	URL      string
	Headers  map[string]string
	Cookies  string
	Protocol string
	Size     int64 // 0 when the source did not say
	Chunk    int64 // the source's own ranged-request size, 0 for none
	// Direct inputs are fetched by this process with ranged requests. The rest
	// (HLS playlists) are read by ffmpeg itself.
	Direct bool
}

// Plan is how a tunnel will produce its bytes without touching the disk.
type Plan struct {
	// Kind "proxy" relays one source as is, with Range support and an exact
	// length. Kind "ffmpeg" muxes or transcodes into a pipe.
	Kind     string
	Inputs   []Input
	Args     []string // ffmpeg output arguments, without the output target
	Ext      string
	MIME     string
	Estimate int64
	Exact    bool
	// Optional is the index of an input that may be dropped on failure
	// (subtitles, cover art), with NoOptional the args to use without it.
	Optional   int
	NoOptional []string
}

var contentTypes = map[string]string{
	"mp4": "video/mp4", "m4v": "video/mp4", "mkv": "video/x-matroska", "webm": "video/webm",
	"mov": "video/quicktime", "mp3": "audio/mpeg", "m4a": "audio/mp4", "aac": "audio/aac",
	"ogg": "audio/ogg", "opus": "audio/ogg", "wav": "audio/wav", "flac": "audio/flac",
	"mka": "audio/x-matroska",
}

func mimeFor(ext string) string {
	if v, ok := contentTypes[strings.ToLower(ext)]; ok {
		return v
	}
	return "application/octet-stream"
}

func isHTTP(f Format) bool {
	p := strings.ToLower(f.Protocol)
	return f.URL != "" && !f.HasFragments && (p == "https" || p == "http" || p == "")
}

func isHLS(f Format) bool {
	p := strings.ToLower(f.Protocol)
	return f.URL != "" && (p == "m3u8" || p == "m3u8_native")
}

func streamable(f Format) bool { return isHTTP(f) || isHLS(f) }

func inputOf(f Format, duration float64) Input {
	size := int64(f.Filesize)
	return Input{URL: f.URL, Headers: f.HTTPHeaders, Cookies: f.Cookies, Protocol: f.Protocol,
		Size: size, Chunk: f.ChunkSize, Direct: isHTTP(f)}
}

// pick returns the last (best: yt-dlp sorts worst to best) format that passes.
func pick(list []Format, ok func(Format) bool) (Format, bool) {
	for i := len(list) - 1; i >= 0; i-- {
		if ok(list[i]) {
			return list[i], true
		}
	}
	return Format{}, false
}

func codecIn(codec string, prefixes ...string) bool {
	c := strings.ToLower(codec)
	for _, p := range prefixes {
		if strings.HasPrefix(c, p) {
			return true
		}
	}
	return false
}

func mp4Video(c string) bool {
	return codecIn(c, "avc1", "avc3", "h264", "hev1", "hvc1", "hevc", "h265", "av01", "vp09", "vp9")
}
func mp4Audio(c string) bool {
	return codecIn(c, "mp4a", "aac", "opus", "mp3", "ac-3", "ec-3", "flac", "alac")
}

const fragmentedMP4 = "+frag_keyframe+empty_moov+default_base_moof"

// BuildPlan picks formats the way the disk path's yt-dlp selector would, and
// returns nil when the job must go through the disk instead (DASH fragment
// lists, RTMP, cover art in ogg, anything this file does not know).
func BuildPlan(info *Info, o DownloadOptions, maxHeight int) *Plan {
	if len(info.Formats) == 0 || info.Duration <= 0 {
		return nil
	}
	h := o.Height
	if h <= 0 || h > maxHeight {
		h = maxHeight
	}
	switch o.Mode {
	case "audio":
		return audioPlan(info, o)
	case "mute":
		return mutePlan(info, h, maxHeight)
	}
	return videoPlan(info, o, h, maxHeight)
}

func fitsHeight(f Format, h int) bool { return f.Height > 0 && int(f.Height) <= h }

func videoOnly(f Format) bool   { return has(f.VCodec) && !has(f.ACodec) }
func audioOnly(f Format) bool   { return has(f.ACodec) && !has(f.VCodec) }
func progressive(f Format) bool { return has(f.VCodec) && has(f.ACodec) }

// unknown codecs: yt-dlp leaves vcodec empty for some progressive files
func maybeProgressive(f Format) bool {
	return progressive(f) || (f.VCodec == "" && f.ACodec == "" && f.Height > 0)
}

func videoPlan(info *Info, o DownloadOptions, h, maxHeight int) *Plan {
	d := info.Duration
	var v, a Format
	var okV, okA bool

	// 1. h264 + aac: copies into mp4 that every phone plays
	v, okV = pick(info.Formats, func(f Format) bool {
		return videoOnly(f) && fitsHeight(f, h) && codecIn(f.VCodec, "avc1")
	})
	a, okA = pick(info.Formats, func(f Format) bool { return audioOnly(f) && codecIn(f.ACodec, "mp4a") })
	if okV && okA && v.Height < topHeight(info.Formats, h) {
		// a sharper picture exists in another codec: prefer it, as yt-dlp would
		okV = false
	}
	if !(okV && okA) {
		// 2. the best picture under the cap, plus the best sound
		v, okV = pick(info.Formats, func(f Format) bool { return has(f.VCodec) && fitsHeight(f, h) })
		if okV && progressive(v) {
			return single(info, v, o, true)
		}
		a, okA = bestAudioOnly(info.Formats)
	}
	if okV && okA {
		return mergePlan(info, v, a, o, d)
	}
	// 3. the best file that already has both, under the cap, then any
	if p, ok := pick(info.Formats, func(f Format) bool { return maybeProgressive(f) && fitsHeight(f, h) }); ok {
		return single(info, p, o, true)
	}
	if p, ok := pick(info.Formats, func(f Format) bool {
		return maybeProgressive(f) && (f.Height == 0 || int(f.Height) <= maxHeight)
	}); ok {
		return single(info, p, o, true)
	}
	if okV {
		return single(info, v, o, false)
	}
	return nil
}

func topHeight(list []Format, h int) float64 {
	top := 0.0
	for _, f := range list {
		if has(f.VCodec) && fitsHeight(f, h) && f.Height > top {
			top = f.Height
		}
	}
	return top
}

func bestAudioOnly(list []Format) (Format, bool) {
	return pick(list, audioOnly)
}

func mutePlan(info *Info, h, maxHeight int) *Plan {
	v, ok := pick(info.Formats, func(f Format) bool { return has(f.VCodec) && fitsHeight(f, h) })
	if !ok {
		v, ok = pick(info.Formats, func(f Format) bool {
			return (has(f.VCodec) || f.VCodec == "") && (f.Height == 0 || int(f.Height) <= maxHeight)
		})
	}
	if !ok || !streamable(v) {
		return nil
	}
	est := int64(sizeOf(v, info.Duration))
	if videoOnly(v) && isHTTP(v) {
		return &Plan{Kind: "proxy", Inputs: []Input{inputOf(v, info.Duration)}, Ext: v.Ext,
			MIME: mimeFor(v.Ext), Estimate: est, Exact: v.Filesize > 0, Optional: -1}
	}
	ext, format := videoContainer(v.VCodec, "")
	args := []string{"-map", "0:v:0", "-an", "-sn", "-c", "copy"}
	args = append(args, muxerArgs(format)...)
	return &Plan{Kind: "ffmpeg", Inputs: []Input{inputOf(v, info.Duration)}, Args: args, Ext: ext,
		MIME: mimeFor(ext), Estimate: est, Optional: -1}
}

// single relays one file that already holds what was asked for. Subtitles
// turn it into an ffmpeg job, since they have to be muxed in.
func single(info *Info, f Format, o DownloadOptions, withAudio bool) *Plan {
	if !streamable(f) {
		return nil
	}
	est := int64(sizeOf(f, info.Duration))
	sub, hasSub := subtitleFor(info, o)
	if isHTTP(f) && !hasSub && f.Ext != "" {
		return &Plan{Kind: "proxy", Inputs: []Input{inputOf(f, info.Duration)}, Ext: f.Ext,
			MIME: mimeFor(f.Ext), Estimate: est, Exact: f.Filesize > 0, Optional: -1}
	}
	ext, format := videoContainer(f.VCodec, f.ACodec)
	if f.VCodec == "" && f.ACodec == "" {
		ext, format = "mkv", "matroska"
	}
	maps := []string{"-map", "0:v:0?"}
	if withAudio {
		maps = append(maps, "-map", "0:a:0?")
	}
	return withSubtitle(&Plan{Kind: "ffmpeg", Inputs: []Input{inputOf(f, info.Duration)}, Ext: ext,
		MIME: mimeFor(ext), Estimate: est, Optional: -1}, maps, format, isHLS(f), sub, hasSub)
}

func mergePlan(info *Info, v, a Format, o DownloadOptions, d float64) *Plan {
	if !streamable(v) || !streamable(a) {
		return nil
	}
	ext, format := videoContainer(v.VCodec, a.ACodec)
	est := int64(sizeOf(v, d) + sizeOf(a, d))
	sub, hasSub := subtitleFor(info, o)
	maps := []string{"-map", "0:v:0", "-map", "1:a:0"}
	p := &Plan{Kind: "ffmpeg", Inputs: []Input{inputOf(v, d), inputOf(a, d)}, Ext: ext,
		MIME: mimeFor(ext), Estimate: est, Exact: v.Filesize > 0 && a.Filesize > 0, Optional: -1}
	return withSubtitle(p, maps, format, isHLS(v) || isHLS(a), sub, hasSub)
}

func withSubtitle(p *Plan, maps []string, format string, hls bool, sub Subtitle, hasSub bool) *Plan {
	base := append(append([]string{}, maps...), "-c", "copy")
	if hls && format == "mp4" {
		base = append(base, "-bsf:a", "aac_adtstoasc")
	}
	without := append(append([]string{}, base...), muxerArgs(format)...)
	if !hasSub {
		p.Args = without
		return p
	}
	idx := len(p.Inputs)
	p.Inputs = append(p.Inputs, Input{URL: sub.URL, Protocol: "https", Direct: true})
	codec := "srt"
	if format == "mp4" {
		codec = "mov_text"
	} else if format == "webm" {
		codec = "webvtt"
	}
	with := append([]string{}, base...)
	with = append(with, "-map", fmt.Sprintf("%d:s:0", idx), "-c:s", codec)
	with = append(with, muxerArgs(format)...)
	p.Args = with
	p.Optional = idx
	p.NoOptional = without
	return p
}

func subtitleFor(info *Info, o DownloadOptions) (Subtitle, bool) {
	lang := strings.ToLower(o.SubtitleLang)
	if lang == "" || o.Mode == "audio" {
		return Subtitle{}, false
	}
	candidates := info.Subtitles[lang]
	if len(candidates) == 0 {
		// "en" also takes "en-US", "en-GB": the first one the source lists
		for _, key := range sortedKeys(info.Subtitles) {
			if strings.HasPrefix(key, lang+"-") {
				candidates = info.Subtitles[key]
				break
			}
		}
	}
	for _, want := range []string{"vtt", "srt"} {
		for _, c := range candidates {
			if strings.EqualFold(c.Ext, want) && strings.HasPrefix(strings.ToLower(c.URL), "http") {
				return c, true
			}
		}
	}
	return Subtitle{}, false
}

func videoContainer(vcodec, acodec string) (ext, format string) {
	if (vcodec == "" || mp4Video(vcodec)) && (acodec == "" || acodec == "none" || mp4Audio(acodec)) {
		return "mp4", "mp4"
	}
	if codecIn(vcodec, "vp8", "vp9", "vp09", "av01") && (acodec == "" || acodec == "none" || codecIn(acodec, "opus", "vorbis")) {
		return "webm", "webm"
	}
	return "mkv", "matroska"
}

func muxerArgs(format string) []string {
	switch format {
	case "mp4":
		return []string{"-movflags", fragmentedMP4, "-f", "mp4"}
	case "webm":
		return []string{"-f", "webm"}
	}
	return []string{"-f", "matroska"}
}

func audioPlan(info *Info, o DownloadOptions) *Plan {
	a, ok := bestAudioOnly(info.Formats)
	if !ok {
		// a source with no separate sound: take it from the best full file
		a, ok = pick(info.Formats, func(f Format) bool { return has(f.ACodec) })
	}
	if !ok || !streamable(a) {
		return nil
	}
	d := info.Duration
	in := inputOf(a, d)
	format := o.AudioFormat
	switch format {
	case "best", "mp3", "ogg", "opus", "wav":
	default:
		format = "mp3"
	}
	br := o.AudioBitrate
	if br <= 0 || br > 128 {
		br = 128
	}

	if format == "best" {
		if audioOnly(a) && isHTTP(a) && a.Ext != "" {
			return &Plan{Kind: "proxy", Inputs: []Input{in}, Ext: a.Ext, MIME: mimeFor(a.Ext),
				Estimate: int64(sizeOf(a, d)), Exact: a.Filesize > 0, Optional: -1}
		}
		ext, args := audioCopy(a.ACodec)
		if isHLS(a) && ext == "m4a" {
			args = append([]string{"-bsf:a", "aac_adtstoasc"}, args...)
		}
		return &Plan{Kind: "ffmpeg", Inputs: []Input{in},
			Args: append([]string{"-map", "0:a:0", "-vn", "-sn", "-c:a", "copy"}, args...),
			Ext:  ext, MIME: mimeFor(ext), Estimate: int64(sizeOf(a, d)), Optional: -1}
	}

	if o.AudioCovers && (format == "ogg" || format == "opus") {
		// cover art in ogg needs a base64 picture block: yt-dlp does that well
		return nil
	}

	var codec []string
	ext := format
	switch format {
	case "mp3":
		codec = []string{"-c:a", "libmp3lame", "-b:a", fmt.Sprintf("%dk", br), "-id3v2_version", "3", "-f", "mp3"}
	case "ogg":
		codec = []string{"-c:a", "libvorbis", "-b:a", fmt.Sprintf("%dk", br), "-f", "ogg"}
	case "opus":
		codec = []string{"-c:a", "libopus", "-b:a", fmt.Sprintf("%dk", br), "-f", "ogg"}
	case "wav":
		codec = []string{"-c:a", "pcm_s16le", "-ar", "44100", "-ac", "2", "-f", "wav"}
	}
	est := int64(float64(br) * 125 * d)
	if format == "wav" {
		est = int64(176400 * d)
	}
	p := &Plan{Kind: "ffmpeg", Inputs: []Input{in}, Ext: ext, MIME: mimeFor(ext), Estimate: est,
		Exact: true, Optional: -1}
	plain := append([]string{"-map", "0:a:0", "-vn", "-sn"}, codec...)
	thumb := strings.TrimSpace(info.Thumbnail)
	if o.AudioCovers && format == "mp3" && strings.HasPrefix(strings.ToLower(thumb), "http") {
		p.Inputs = append(p.Inputs, Input{URL: thumb, Protocol: "https", Direct: true})
		p.Args = append([]string{"-map", "0:a:0", "-map", "1:v:0", "-sn",
			"-c:v", "mjpeg", "-vf", "scale='min(800,iw)':-2", "-frames:v", "1",
			"-disposition:v:0", "attached_pic", "-metadata:s:v", "title=Album cover",
			"-metadata:s:v", "comment=Cover (front)"}, codec...)
		p.Optional = 1
		p.NoOptional = plain
		return p
	}
	p.Args = plain
	return p
}

func audioCopy(acodec string) (string, []string) {
	switch {
	case codecIn(acodec, "mp4a", "aac"):
		return "m4a", []string{"-movflags", fragmentedMP4, "-f", "mp4"}
	case codecIn(acodec, "opus"):
		return "opus", []string{"-f", "ogg"}
	case codecIn(acodec, "vorbis"):
		return "ogg", []string{"-f", "ogg"}
	case codecIn(acodec, "mp3"):
		return "mp3", []string{"-f", "mp3"}
	case codecIn(acodec, "flac"):
		return "flac", []string{"-f", "flac"}
	}
	return "mka", []string{"-f", "matroska"}
}
