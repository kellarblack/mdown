package mdown

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode"

	"golang.org/x/net/idna"
	"golang.org/x/text/unicode/norm"
)

const maxURLLength = 2048

var blockedSuffixes = []string{
	".local", ".localdomain", ".localhost", ".internal", ".intranet",
	".lan", ".home", ".corp", ".test", ".example", ".invalid",
}

var blockedPrefixes = mustPrefixes(
	"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
	"169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
	"192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
	"224.0.0.0/4", "240.0.0.0/4",
	"::/128", "::1/128", "fc00::/7", "fe80::/10", "ff00::/8", "2001:db8::/32",
	"64:ff9b::/96", "2002::/16",
)

func mustPrefixes(list ...string) []netip.Prefix {
	out := make([]netip.Prefix, 0, len(list))
	for _, s := range list {
		out = append(out, netip.MustParsePrefix(s))
	}
	return out
}

// IsBlockedIP is true for any address that must never be dialled: private,
// loopback, link-local (the cloud metadata address), multicast, reserved.
func IsBlockedIP(raw string) bool {
	addr, err := netip.ParseAddr(strings.Trim(raw, "[]"))
	if err != nil {
		return true
	}
	return isBlockedAddr(addr)
}

func isBlockedAddr(addr netip.Addr) bool {
	addr = addr.Unmap().WithZone("")
	if !addr.IsGlobalUnicast() || addr.IsPrivate() || addr.IsLoopback() ||
		addr.IsLinkLocalUnicast() || addr.IsMulticast() || addr.IsUnspecified() {
		return true
	}
	for _, p := range blockedPrefixes {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}

// Resolver is swapped out by tests.
var Resolver = func(ctx context.Context, host string) ([]string, error) {
	return net.DefaultResolver.LookupHost(ctx, host)
}

var allDigits = regexp.MustCompile(`^[0-9]+$`)

// ValidateURL returns a normalised http(s) URL on a public host, or an error.
func ValidateURL(raw string, checkDNS bool) (string, error) {
	candidate := strings.TrimSpace(raw)
	if candidate == "" {
		return "", ErrURLMissing()
	}
	if len(candidate) > maxURLLength {
		return "", ErrURLInvalid("url too long")
	}
	for _, r := range candidate {
		if r < 0x20 || r == 0x7f {
			return "", ErrURLInvalid("control character in url")
		}
	}
	u, err := url.Parse(candidate)
	if err != nil {
		return "", ErrURLInvalid("unparseable url")
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", ErrURLInvalid("scheme must be http or https")
	}
	if u.User != nil {
		return "", ErrURLInvalid("credentials in url")
	}
	hostname := u.Hostname()
	if hostname == "" {
		return "", ErrURLInvalid("missing hostname")
	}
	host := strings.ToLower(strings.TrimRight(strings.TrimSpace(hostname), "."))
	if host == "" {
		return "", ErrURLInvalid("empty hostname")
	}
	if ascii, err := idna.Lookup.ToASCII(host); err == nil {
		host = ascii
	} else if _, ipErr := netip.ParseAddr(host); ipErr != nil {
		return "", ErrURLInvalid("invalid hostname")
	}
	if len(host) > 253 {
		return "", ErrURLInvalid("hostname too long")
	}
	for _, suffix := range blockedSuffixes {
		if strings.HasSuffix(host, suffix) || host == strings.TrimPrefix(suffix, ".") {
			return "", ErrURLInvalid("hostname is not public")
		}
	}
	if host == "localhost" {
		return "", ErrURLInvalid("hostname is not public")
	}
	port := 0
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil {
			return "", ErrURLInvalid("invalid port")
		}
		port = n
	}
	if port != 0 && port != 80 && port != 443 {
		return "", ErrURLInvalid("port not allowed")
	}

	if addr, err := netip.ParseAddr(host); err == nil {
		if isBlockedAddr(addr) {
			return "", ErrURLInvalid("address is not public")
		}
	} else {
		labels := strings.Split(host, ".")
		numeric := true
		for _, l := range labels {
			if !allDigits.MatchString(l) {
				numeric = false
				break
			}
		}
		// "127.1", "017700000001": an address spelling, never a domain
		if numeric {
			return "", ErrURLInvalid("address is not public")
		}
		if checkDNS {
			if !strings.Contains(host, ".") {
				return "", ErrURLInvalid("hostname is not public")
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			addrs, err := Resolver(ctx, host)
			cancel()
			if err != nil || len(addrs) == 0 {
				return "", ErrURLInvalid("hostname does not resolve")
			}
			for _, a := range addrs {
				if IsBlockedIP(a) {
					return "", ErrURLInvalid("address is not public")
				}
			}
		}
	}

	netloc := host
	if strings.Contains(host, ":") {
		netloc = "[" + host + "]"
	}
	if port != 0 && !((scheme == "http" && port == 80) || (scheme == "https" && port == 443)) {
		netloc += ":" + strconv.Itoa(port)
	}
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	out := scheme + "://" + netloc + path
	if u.RawQuery != "" {
		out += "?" + u.RawQuery
	}
	return out, nil
}

// safeDialer refuses to connect to a non-public address at connect time, which
// also closes DNS rebinding for every request this process makes itself.
var safeDialer = &net.Dialer{
	Timeout:   10 * time.Second,
	KeepAlive: 30 * time.Second,
	Control: func(network, address string, _ syscall.RawConn) error {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return err
		}
		if IsBlockedIP(host) {
			return errors.New("refusing to dial a non-public address")
		}
		return nil
	},
}

// AllowPrivateDial is for tests that serve media from 127.0.0.1.
var AllowPrivateDial = false

func dialContext(ctx context.Context, network, address string) (net.Conn, error) {
	if AllowPrivateDial {
		return (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, address)
	}
	return safeDialer.DialContext(ctx, network, address)
}

// upstreamClient fetches from sources. No redirect limit beyond Go's ten; the
// dialer re-checks every hop.
var upstreamClient = &http.Client{
	Transport: &http.Transport{
		DialContext:           dialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          64,
		MaxIdleConnsPerHost:   16,
		IdleConnTimeout:       60 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 20 * time.Second,
		ExpectContinueTimeout: time.Second,
	},
}

var shorteners = map[string]bool{
	"on.soundcloud.com": true, "soundcloud.app.goo.gl": true, "bit.ly": true,
	"t.co": true, "tinyurl.com": true, "goo.gl": true, "snd.sc": true, "fb.me": true,
}

// ResolveShortener follows a share link one HEAD request deep. Any failure
// returns the input unchanged.
func ResolveShortener(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || !shorteners[strings.ToLower(u.Hostname())] {
		return raw
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, raw, nil)
	if err != nil {
		return raw
	}
	req.Header.Set("User-Agent", "mdown/2.0 (+https://mdown.cc)")
	req.Header.Set("Accept", "*/*")
	res, err := upstreamClient.Do(req)
	if err != nil {
		return raw
	}
	res.Body.Close()
	if final := res.Request.URL.String(); final != "" && final != raw {
		return final
	}
	return raw
}

var (
	controlRE   = regexp.MustCompile(`[\x00-\x1f\x7f]`)
	reservedRE  = regexp.MustCompile(`[\\/:*?"<>|]`)
	spaceRE     = regexp.MustCompile(`\s+`)
	extRE       = regexp.MustCompile(`^[a-z0-9]{1,8}$`)
	tunnelLogRE = regexp.MustCompile(`/tunnel/[A-Za-z0-9_\-]{4,}`)
	urlLogRE    = regexp.MustCompile(`https?://[^\s"'<>]+`)
	queryLogRE  = regexp.MustCompile(`\?[^ "]+`)
)

// SafeFilename builds a display file name: no separators, no control
// characters, at most 110 characters before the extension.
func SafeFilename(title, extension string) string {
	ext := strings.ToLower(strings.TrimPrefix(extension, "."))
	if !extRE.MatchString(ext) {
		ext = "bin"
	}
	name := controlRE.ReplaceAllString(title, "")
	name = norm.NFC.String(name)
	name = reservedRE.ReplaceAllString(name, "-")
	name = spaceRE.ReplaceAllString(name, " ")
	name = strings.Trim(name, " .-")
	if name == "" {
		name = "download"
	}
	if r := []rune(name); len(r) > 110 {
		name = strings.TrimRight(string(r[:110]), " .-")
	}
	return name + "." + ext
}

// HeaderSafe strips anything that could end a response header.
func HeaderSafe(v string) string {
	return controlRE.ReplaceAllString(v, "")
}

// RedactLog removes tunnel tokens, query strings and links from a log line.
func RedactLog(v string) string {
	v = queryLogRE.ReplaceAllString(v, "")
	v = tunnelLogRE.ReplaceAllString(v, "/tunnel/[redacted]")
	return urlLogRE.ReplaceAllString(v, "[url]")
}

// normalizeBoardText makes one line of printable text.
func normalizeBoardText(raw string, max int) (string, error) {
	var b strings.Builder
	for _, r := range raw {
		if unicode.IsPrint(r) || r == ' ' {
			b.WriteRune(r)
		} else {
			b.WriteRune(' ')
		}
	}
	text := strings.TrimSpace(spaceRE.ReplaceAllString(b.String(), " "))
	if len([]rune(text)) < 3 {
		return "", errors.New("a few words, please")
	}
	if r := []rune(text); len(r) > max {
		text = strings.TrimRight(string(r[:max]), " ")
	}
	return text, nil
}
