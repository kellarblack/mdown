"""Entry point: `python3 -m mdown_api`."""

from __future__ import annotations

import logging
import signal
import sys

from .config import Config, ConfigError
from .server import ApiServer


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )
    log = logging.getLogger("mdown.api")

    try:
        config = Config.from_env()
    except ConfigError as problem:
        print(f"configuration error: {problem}", file=sys.stderr)
        return 2

    try:
        server = ApiServer(config)
    except OSError as problem:
        print(f"cannot bind {config.host}:{config.port} - {problem}", file=sys.stderr)
        return 1

    handler = server.RequestHandlerClass  # type: ignore[attr-defined]
    handler.jobs.start()

    log.info(
        "listening on %s:%d | max %dx%d, %ds, %d concurrent, %d queued, %dMB output",
        config.host,
        config.port,
        config.max_height,
        config.max_height,
        config.max_duration,
        config.max_concurrent,
        config.max_queue,
        config.max_output_bytes // (1024 * 1024),
    )
    log.info("cors origins: %s", ", ".join(config.cors_origins))
    if config.api_key:
        log.info("api key required")

    def shutdown(_signum, _frame):
        log.info("shutting down")
        handler.jobs.stop()
        # serve_forever runs in this thread; shutdown() must come from another
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
