package mdown

import "fmt"

// APIError is an error the client may see. The codes are cobalt v11 codes, so
// the page's error table already has a sentence for each.
type APIError struct {
	Code    string
	Status  int
	Context map[string]any
	Detail  string
	// Expose false keeps Detail in the log only: a 500 can carry a temp path.
	Expose bool
}

func (e *APIError) Error() string {
	if e.Detail != "" {
		return e.Code + ": " + e.Detail
	}
	return e.Code
}

// Payload is the JSON body for this error.
func (e *APIError) Payload() map[string]any {
	inner := map[string]any{"code": e.Code}
	if len(e.Context) > 0 {
		inner["context"] = e.Context
	}
	if e.Detail != "" && e.Expose {
		inner["detail"] = e.Detail
	}
	return map[string]any{"status": "error", "error": inner}
}

func newErr(code string, status int, detail string) *APIError {
	return &APIError{Code: code, Status: status, Detail: detail, Expose: true}
}

func errWith(code string, status int, ctx map[string]any, detail string) *APIError {
	return &APIError{Code: code, Status: status, Context: ctx, Detail: detail, Expose: true}
}

func ErrURLMissing() *APIError          { return newErr("api.url.missing", 400, "") }
func ErrURLInvalid(d string) *APIError  { return newErr("api.url.invalid", 400, d) }
func ErrUnavailable(d string) *APIError { return newErr("api.content.video.unavailable", 422, d) }
func ErrLive() *APIError                { return newErr("api.content.video.live", 422, "") }
func ErrAuthMissing() *APIError         { return newErr("api.auth.apikey.missing", 401, "") }
func ErrAuthInvalid() *APIError         { return newErr("api.auth.apikey.invalid", 403, "") }
func ErrNotFound() *APIError {
	return newErr("api.content.video.unavailable", 404, "job not found or expired")
}
func ErrNoRoute() *APIError        { return newErr("api.content.video.unavailable", 404, "no such endpoint") }
func ErrTooLarge() *APIError       { return newErr("api.request.too_large", 413, "body too large") }
func ErrBadMethod() *APIError      { return newErr("api.request.method", 405, "method not allowed") }
func ErrRequestMissing() *APIError { return newErr("api.request.missing", 404, "no such request") }
func ErrRequestLocked() *APIError {
	return newErr("api.request.locked", 403, "set an api key to moderate the board")
}
func ErrBusy() *APIError {
	return errWith("api.rate_limit", 429, map[string]any{"reason": "queue_full"}, "")
}
func ErrContentTooLarge() *APIError {
	return newErr("api.content.too_large", 413, "output exceeds the size cap")
}
func ErrTimedOut() *APIError { return newErr("api.instance.timed_out", 504, "") }
func ErrRequestInvalid(r string) *APIError {
	if r == "" {
		r = "empty"
	}
	return errWith("api.request.invalid", 400, map[string]any{"reason": r}, r)
}
func ErrTooLong(limit int) *APIError {
	return errWith("api.content.video.too_long", 422, map[string]any{"limit": limit}, "")
}
func ErrRateLimit(retry int, reason string) *APIError {
	ctx := map[string]any{"remaining": 0, "retry": retry}
	if reason != "" {
		ctx["reason"] = reason
	}
	return errWith("api.rate_limit", 429, ctx, "")
}

// ErrInternal is vague on purpose; the detail goes to the log.
func ErrInternal(detail string) *APIError {
	return &APIError{Code: "api.content.video.unavailable", Status: 500, Detail: detail}
}

// asAPIError converts anything into an APIError the handler can send.
func asAPIError(err error) *APIError {
	if err == nil {
		return nil
	}
	if e, ok := err.(*APIError); ok {
		return e
	}
	return ErrInternal(fmt.Sprint(err))
}
