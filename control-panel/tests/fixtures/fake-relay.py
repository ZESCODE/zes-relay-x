#!/usr/bin/env python3
"""
Minimal stand-in for pol_relay.py used by the relay-manager tests.

It answers GET /v1/models (and POST /v1/chat/completions non-streaming) so the
manager's spawn → readiness → health → graceful shutdown path can be exercised
without touching the network or the real relay.
"""

from __future__ import annotations

import json
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("POL_RELAY_PORT", "7179"))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        sys.stderr.write(f"[pol-relay] {fmt % args}\n")

    def _json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/v1/models"):
            self._json({"object": "list", "data": [{"id": "fake-model", "object": "model"}]})
            sys.stderr.write(
                f"[pol-relay] {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} GET /v1/models 200 3ms\n"
            )
            return
        self._json({"error": {"message": "not found"}}, 404)

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except ValueError:
            parsed = {}
        model = parsed.get("model", "fake-model")
        self._json(
            {
                "id": "chatcmpl-fake",
                "object": "chat.completion",
                "model": model,
                "choices": [
                    {"index": 0, "message": {"role": "assistant", "content": "pong"}, "finish_reason": "stop"}
                ],
                "usage": {"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4},
            }
        )
        sys.stderr.write(
            f"[pol-relay] {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} POST /v1/chat/completions 200 "
            f"model={model} 12ms stream=false\n"
        )


def main() -> int:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    sys.stderr.write(f"[pol-relay] listening on http://127.0.0.1:{PORT} upstream=http://fake/v1 skip_auth=true\n")

    def shutdown(_signum, _frame):
        # server.shutdown() blocks until serve_forever() returns, so it must be
        # called from another thread than the one running the loop.
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
        sys.stderr.write("[pol-relay] stopped\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
