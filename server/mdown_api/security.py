"""Input validation and SSRF protection.

Two jobs:

1. Only http(s) URLs on standard ports, with a resolvable public hostname.
2. Never hand a private, loopback, link-local or metadata address to the
   downloader, even when it arrives disguised as a decimal IP or a redirect
   target.

Residual risk, stated plainly: yt-dlp resolves the hostname again when it
connects, so a hostile DNS server could answer differently the second time
(rebinding). Mitigations in place are a re-check immediately before download
and a hard rejection of non-public answers. Pinning the resolved IP through
yt-dlp is not supported by its API, so this is a documented limit rather than
a closed hole.
"""

from __future__ import annotations

import ipaddress
import re
import socket
import unicodedata
from typing import List, Optional, Tuple
from urllib.parse import urlsplit, urlunsplit

from .errors import ApiError

MAX_URL_LENGTH = 2048
ALLOWED_SCHEMES = ("http", "https")
ALLOWED_PORTS = (None, 80, 443)

#: hostname suffixes that only ever mean "inside some network"
BLOCKED_SUFFIXES = (
    ".local",
    ".localdomain",
    ".localhost",
    ".internal",
    ".intranet",
    ".lan",
    ".home",
    ".corp",
    ".test",
    ".example",
    ".invalid",
)

#: explicit networks, belt-and-braces on top of `is_global`
BLOCKED_NETWORKS = [
    ipaddress.ip_network(n)
    for n in (
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",      # includes 169.254.169.254, the cloud metadata address
        "172.16.0.0/12",
        "192.0.0.0/24",
        "192.0.2.0/24",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "198.51.100.0/24",
        "203.0.113.0/24",
        "224.0.0.0/4",
        "240.0.0.0/4",
        "::/128",
        "::1/128",
        "fc00::/7",
        "fe80::/10",
        "ff00::/8",
        "2001:db8::/32",
    )
]


def is_blocked_ip(raw: str) -> bool:
    """True when this address must never be dialled."""
    try:
        ip = ipaddress.ip_address(raw)
    except ValueError:
        return True

    # ::ffff:127.0.0.1 style
    if getattr(ip, "ipv4_mapped", None) is not None:
        ip = ip.ipv4_mapped  # type: ignore[assignment]

    if not ip.is_global:
        return True
    for network in BLOCKED_NETWORKS:
        if ip.version == network.version and ip in network:
            return True
    return False


def resolve(host: str, port: int) -> List[str]:
    """Resolve a hostname to every address it answers with."""
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError, OSError):
        return []
    addresses: List[str] = []
    for info in infos:
        address = info[4][0]
        if address not in addresses:
            addresses.append(address)
    return addresses


def _normalise_host(raw: str) -> str:
    host = raw.strip().rstrip(".").lower()
    if not host:
        raise ApiError.url_invalid("empty hostname")
    # internationalised domain names -> ascii for resolution
    try:
        host = host.encode("idna").decode("ascii")
    except UnicodeError:
        raise ApiError.url_invalid("invalid hostname")
    return host


def validate_url(raw: str, *, check_dns: bool = True) -> str:
    """Return a normalised URL, or raise ApiError.

    `check_dns` is only disabled by unit tests; the server always checks.
    """
    if not isinstance(raw, str) or not raw.strip():
        raise ApiError.url_missing()

    candidate = raw.strip()
    if len(candidate) > MAX_URL_LENGTH:
        raise ApiError.url_invalid("url too long")
    # control characters and whitespace inside a URL are never legitimate
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in candidate):
        raise ApiError.url_invalid("control character in url")

    try:
        parts = urlsplit(candidate)
    except ValueError:
        raise ApiError.url_invalid("unparseable url")

    scheme = parts.scheme.lower()
    if scheme not in ALLOWED_SCHEMES:
        raise ApiError.url_invalid("scheme must be http or https")
    if parts.username or parts.password:
        raise ApiError.url_invalid("credentials in url")
    if not parts.hostname:
        raise ApiError.url_invalid("missing hostname")

    host = _normalise_host(parts.hostname)
    if len(host) > 253:
        raise ApiError.url_invalid("hostname too long")
    for suffix in BLOCKED_SUFFIXES:
        if host.endswith(suffix) or host == suffix.lstrip("."):
            raise ApiError.url_invalid("hostname is not public")

    try:
        port = parts.port
    except ValueError:
        raise ApiError.url_invalid("invalid port")
    if port not in ALLOWED_PORTS:
        raise ApiError.url_invalid("port not allowed")

    # an IP literal never needs DNS and must be public already
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None

    if literal is not None:
        if is_blocked_ip(str(literal)):
            raise ApiError.url_invalid("address is not public")
    else:
        # a host made only of digits ("127.1", "017700000001") is an address
        # spelling, never a real domain name — refuse it before it resolves
        if all(label.isdigit() for label in host.split(".")):
            raise ApiError.url_invalid("address is not public")
        if check_dns:
            if "." not in host:
                raise ApiError.url_invalid("hostname is not public")
            addresses = resolve(host, port or 443)
            if not addresses:
                raise ApiError.url_invalid("hostname does not resolve")
            if any(is_blocked_ip(address) for address in addresses):
                raise ApiError.url_invalid("address is not public")

    netloc = host if port in (None, 80, 443) and scheme else host
    if port is not None:
        # keep an explicit non-default port, drop the default one
        if not ((scheme == "http" and port == 80) or (scheme == "https" and port == 443)):
            netloc = f"{host}:{port}"
    path = parts.path or "/"
    return urlunsplit((scheme, netloc, path, parts.query, ""))


_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def safe_filename(title: Optional[str], extension: str, fallback: str = "download") -> str:
    """Build a display filename: no separators, no control characters, bounded."""
    ext = (extension or "").lstrip(".").lower()
    if not re.fullmatch(r"[a-z0-9]{1,8}", ext or ""):
        ext = "bin"

    name = _CONTROL.sub("", str(title or ""))
    name = unicodedata.normalize("NFC", name)
    # path separators and Windows reserved characters
    name = re.sub(r'[\\/:*?"<>|]', "-", name)
    name = re.sub(r"\s+", " ", name).strip(" .-")
    if not name:
        name = fallback
    if len(name) > 110:
        name = name[:110].rstrip(" .-")
    return f"{name}.{ext}"


def header_safe(value: str) -> str:
    """Strip anything that could break out of a response header."""
    return _CONTROL.sub("", str(value)).replace("\r", "").replace("\n", "")


def split_target(url: str) -> Tuple[str, int]:
    parts = urlsplit(url)
    return parts.hostname or "", parts.port or (443 if parts.scheme == "https" else 80)
