"""Error vocabulary.

The codes match cobalt v11 exactly, because the front-end already has a
translation table for them (see ERROR_TEXT in assets/app.js). Emitting a code
the front-end doesn't know still works — it humanises the dotted name — but
using the known ones gives a proper sentence.
"""

from __future__ import annotations

from typing import Any, Dict, Optional


class ApiError(Exception):
    """An error the client is allowed to see."""

    #: default HTTP status per code family
    def __init__(
        self,
        code: str,
        status: int = 400,
        context: Optional[Dict[str, Any]] = None,
        detail: str = "",
    ) -> None:
        super().__init__(detail or code)
        self.code = code
        self.status = status
        self.context = context or {}
        self.detail = detail

    def payload(self) -> Dict[str, Any]:
        error: Dict[str, Any] = {"code": self.code}
        if self.context:
            error["context"] = self.context
        body: Dict[str, Any] = {"status": "error", "error": error}
        if self.detail:
            # not part of the cobalt schema, but harmless and useful in logs
            body["error"]["detail"] = self.detail
        return body

    # -- constructors for the cases this server actually produces ---------
    @classmethod
    def url_missing(cls) -> "ApiError":
        return cls("api.url.missing", 400)

    @classmethod
    def url_invalid(cls, detail: str = "") -> "ApiError":
        return cls("api.url.invalid", 400, detail=detail)

    @classmethod
    def url_unsupported(cls, detail: str = "") -> "ApiError":
        return cls("api.url.unsupported", 422, detail=detail)

    @classmethod
    def too_long(cls, limit: int, kind: str = "video") -> "ApiError":
        return cls(f"api.content.{kind}.too_long", 422, {"limit": limit})

    @classmethod
    def unavailable(cls, detail: str = "") -> "ApiError":
        return cls("api.content.video.unavailable", 422, detail=detail)

    @classmethod
    def live(cls) -> "ApiError":
        return cls("api.content.video.live", 422)

    @classmethod
    def private(cls) -> "ApiError":
        return cls("api.content.video.private", 422)

    @classmethod
    def rate_limit(cls, remaining: int = 0) -> "ApiError":
        return cls("api.rate_limit", 429, {"remaining": remaining})

    @classmethod
    def busy(cls) -> "ApiError":
        return cls("api.rate_limit", 429, {"reason": "queue_full"})

    @classmethod
    def auth_missing(cls) -> "ApiError":
        return cls("api.auth.apikey.missing", 401)

    @classmethod
    def auth_invalid(cls) -> "ApiError":
        return cls("api.auth.apikey.invalid", 403)

    @classmethod
    def not_found(cls) -> "ApiError":
        return cls("api.content.video.unavailable", 404, detail="job not found or expired")

    @classmethod
    def internal(cls, detail: str = "") -> "ApiError":
        # deliberately vague in the payload; the detail goes to the log only
        return cls("api.content.video.unavailable", 500, detail=detail)
