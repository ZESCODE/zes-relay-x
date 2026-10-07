#!/usr/bin/env python3
"""
pol_relay.py — OpenAI-compatible HTTP relay for a single upstream.

Contract (do not change the wire format; the control panel is a client of it):

    POST /v1/chat/completions   streaming (SSE) and non-streaming
    GET  /v1/models

* Listens on 127.0.0.1:${POL_RELAY_PORT:-7179}
* Proxies to ${POL_UPSTREAM_BASE:-https://gen.pollinations.ai/v1}
* Injects ``Authorization: Bearer ${POL_API_KEY}`` unless ``POL_SKIP_AUTH=true``,
  in which case the caller's Authorization header is forwarded if present.
* Returns the upstream body verbatim (JSON or SSE) with OpenAI-compatible shape.
* Logs to stderr with the ``[pol-relay]`` prefix. Access lines are parsed by the
  control panel:

    [pol-relay] 2026-10-07T15:33:20Z POST /v1/chat/completions 200 model=openai 1234ms stream=true rid=<id>

Only the Python standard library is used — no pip install required.
"""

from __future__ import annotations

import json
import os
import signal
import socket
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional, Tuple

LOG_PREFIX = "[pol-relay]"

DEFAULT_PORT = 7179
DEFAULT_UPSTREAM_BASE = "https://gen.pollinations.ai/v1"

UPSTREAM_BASE = os.environ.get("POL_UPSTREAM_BASE", DEFAULT_UPSTREAM_BASE).rstrip("/")
API_KEY = os.environ.get("POL_API_KEY", "")
SKIP_AUTH = os.environ.get("POL_SKIP_AUTH", "false").strip().lower() in {"1", "true", "yes", "on"}

try:
    PORT = int(os.environ.get("POL_RELAY_PORT", str(DEFAULT_PORT)))
except ValueError:
    PORT = DEFAULT_PORT

HOST = os.environ.get("POL_RELAY_HOST", "127.0.0.1")
REQUEST_TIMEOUT = float(os.environ.get("POL_UPSTREAM_TIMEOUT", "300"))
MAX_BODY_BYTES = int(os.environ.get("POL_MAX_BODY_BYTES", str(8 * 1024 * 1024)))
DEBUG = os.environ.get("POL_DEBUG", "").strip().lower() in {"1", "true", "yes"}

# Routes the relay exposes. Everything else is a 404.
ROUTES = {"/v1/chat/completions", "/v1/models"}


def log(message: str) -> None:
    """Human-readable stderr line, prefixed like the original relay."""
    sys.stderr.write(f"{LOG_PREFIX} {message}\n")
    sys.stderr.flush()


def response_log(
    method: str,
    path: str,
    status: int,
    started_at: float,
    model: Optional[str] = None,
    stream: Optional[bool] = None,
    request_id: Optional[str] = None,
) -> None:
    """Access record consumed by the control panel's log parser + metrics."""
    duration_ms = int((time.time() - started_at) * 1000)
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    parts = [stamp, method, path, str(status)]
    if model:
        parts.append(f"model={model}")
    parts.append(f"{duration_ms}ms")
    if stream is not None:
        parts.append(f"stream={'true' if stream else 'false'}")
    if request_id:
        parts.append(f"rid={request_id}")
    log(" ".join(parts))


class UpstreamError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def build_ssl_context() -> Optional[ssl.SSLContext]:
    """Use certifi when available, otherwise the system trust store."""
    try:
        import certifi  # type: ignore

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:  # pragma: no cover - certifi is optional
        return ssl.create_default_context()


SSL_CONTEXT = build_ssl_context()


def upstream_headers(forwarded_auth: Optional[str]) -> Dict[str, str]:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "pol-relay/1.0 (+control-panel)",
    }
    if SKIP_AUTH:
        if forwarded_auth:
            headers["Authorization"] = forwarded_auth
    elif API_KEY:
        headers["Authorization"] = f"Bearer {API_KEY}"
    return headers


class RelayHandler(BaseHTTPRequestHandler):
    """One instance per request; ThreadingHTTPServer gives us concurrency."""

    protocol_version = "HTTP/1.1"
    server_version = "pol-relay/1.0"
    sys_version = ""

    # ── plumbing ────────────────────────────────────────────────────────────
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003 - stdlib name
        if DEBUG:
            log(f"http {self.address_string()} {fmt % args}")
        # Access logging is handled by response_log() with structured fields.

    def _read_body(self) -> bytes:
        length_header = self.headers.get("Content-Length")
        if not length_header:
            return b""
        try:
            length = int(length_header)
        except ValueError:
            raise UpstreamError(400, "Invalid Content-Length header")
        if length > MAX_BODY_BYTES:
            raise UpstreamError(413, f"Request body exceeds {MAX_BODY_BYTES} bytes")
        return self.rfile.read(length)

    def _json_error(self, status: int, message: str, code: str) -> None:
        payload = json.dumps(
            {"error": {"message": message, "type": code, "code": code}}
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    # ── routing ─────────────────────────────────────────────────────────────
    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        started_at = time.time()
        path = self.path.split("?", 1)[0]
        if path == "/v1/models":
            self._proxy_models(started_at)
            return
        self._json_error(404, f"Unknown route {path}", "not_found")
        response_log("GET", path, 404, started_at)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Allow", "GET, POST, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        started_at = time.time()
        path = self.path.split("?", 1)[0]
        if path != "/v1/chat/completions":
            self._json_error(404, f"Unknown route {path}", "not_found")
            response_log("POST", path, 404, started_at)
            return
        self._proxy_chat(started_at)

    # ── handlers ────────────────────────────────────────────────────────────
    def _upstream_request(self, path: str, method: str, body: Optional[bytes]) -> urllib.request.Request:
        return urllib.request.Request(
            f"{UPSTREAM_BASE}{path}",
            data=body,
            method=method,
            headers=upstream_headers(self.headers.get("Authorization")),
        )

    def _proxy_models(self, started_at: float) -> None:
        request = self._upstream_request("/models", "GET", None)
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT, context=SSL_CONTEXT) as upstream:
                payload = upstream.read()
                status = upstream.status
                content_type = upstream.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as error:
            payload = error.read() or json.dumps(
                {"error": {"message": error.reason or "upstream error", "type": "upstream_error"}}
            ).encode("utf-8")
            status = error.code
            content_type = "application/json"
        except Exception as error:  # network failure
            self._json_error(502, f"Upstream unreachable: {error}", "upstream_unreachable")
            response_log("GET", "/v1/models", 502, started_at)
            return

        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        response_log("GET", "/v1/models", status, started_at)

    def _proxy_chat(self, started_at: float) -> None:
        request_id = self.headers.get("X-Panel-Request-Id") or ""
        try:
            raw_body = self._read_body()
        except UpstreamError as error:
            self._json_error(error.status, error.message, "bad_request")
            response_log("POST", "/v1/chat/completions", error.status, started_at, request_id=request_id)
            return

        model: Optional[str] = None
        stream_requested = False
        body = raw_body
        if raw_body:
            try:
                parsed = json.loads(raw_body.decode("utf-8"))
                model = parsed.get("model") if isinstance(parsed, dict) else None
                stream_requested = bool(parsed.get("stream")) if isinstance(parsed, dict) else False
            except (ValueError, UnicodeDecodeError):
                self._json_error(400, "Request body is not valid JSON", "bad_request")
                response_log("POST", "/v1/chat/completions", 400, started_at, request_id=request_id)
                return

        upstream_request = self._upstream_request("/chat/completions", "POST", body)

        try:
            upstream = urllib.request.urlopen(
                upstream_request, timeout=REQUEST_TIMEOUT, context=SSL_CONTEXT
            )
        except urllib.error.HTTPError as error:
            detail = error.read()
            status = error.code
            try:
                parsed_error = json.loads(detail.decode("utf-8"))
                message = (
                    parsed_error.get("error", {}).get("message")
                    if isinstance(parsed_error, dict) and isinstance(parsed_error.get("error"), dict)
                    else None
                ) or (error.reason or "upstream error")
            except Exception:
                message = (error.reason or "upstream error") if error.reason else "upstream error"
            payload = (
                detail
                if detail
                else json.dumps({"error": {"message": message, "type": "upstream_error"}}).encode("utf-8")
            )
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            response_log(
                "POST",
                "/v1/chat/completions",
                status,
                started_at,
                model=model,
                stream=stream_requested,
                request_id=request_id,
            )
            return
        except Exception as error:
            self._json_error(502, f"Upstream unreachable: {error}", "upstream_unreachable")
            response_log(
                "POST",
                "/v1/chat/completions",
                502,
                started_at,
                model=model,
                stream=stream_requested,
                request_id=request_id,
            )
            return

        content_type = upstream.headers.get("Content-Type", "application/json")
        is_stream = "text/event-stream" in content_type.lower()

        if not is_stream:
            try:
                payload = upstream.read()
                status = upstream.status
            except Exception as error:
                upstream.close()
                self._json_error(502, f"Upstream read failed: {error}", "upstream_error")
                response_log(
                    "POST",
                    "/v1/chat/completions",
                    502,
                    started_at,
                    model=model,
                    stream=stream_requested,
                    request_id=request_id,
                )
                return
            upstream.close()

            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            response_log(
                "POST",
                "/v1/chat/completions",
                status,
                started_at,
                model=model,
                stream=stream_requested,
                request_id=request_id,
            )
            return

        # ── streaming: forward bytes as they arrive, chunked encoding ───────
        self.send_response(upstream.status)
        self.send_header("Content-Type", content_type or "text/event-stream")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        if request_id:
            self.send_header("X-Panel-Request-Id", request_id)
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        status = upstream.status
        try:
            while True:
                chunk = upstream.read(1024)
                if not chunk:
                    break
                self.wfile.write(b"%X\r\n" % len(chunk))
                self.wfile.write(chunk)
                self.wfile.write(b"\r\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            log("client disconnected mid-stream; aborting upstream read")
        except Exception as error:
            log(f"stream error: {error}")
            status = 502
        finally:
            try:
                upstream.close()
            except Exception:
                pass
            try:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except Exception:
                pass

        response_log(
            "POST",
            "/v1/chat/completions",
            status,
            started_at,
            model=model,
            stream=True,
            request_id=request_id,
        )


class RelayServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request: Any, client_address: Any) -> None:
        exc = sys.exc_info()[1]
        if isinstance(exc, (BrokenPipeError, ConnectionResetError)):
            return  # normal for aborted SSE clients
        log(f"unhandled error from {client_address}: {exc!r}")


def announce() -> None:
    log(
        f"listening on http://{HOST}:{PORT} upstream={UPSTREAM_BASE} "
        f"skip_auth={'true' if SKIP_AUTH else 'false'} key={'set' if API_KEY else 'unset'}"
    )
    log("routes: GET /v1/models · POST /v1/chat/completions (SSE when stream=true)")


def main(argv: list[str]) -> int:
    global HOST, PORT  # noqa: PLW0603 - simple CLI override

    index = 1
    while index < len(argv):
        argument = argv[index]
        if argument in {"--port", "-p"} and index + 1 < len(argv):
            try:
                PORT = int(argv[index + 1])
            except ValueError:
                log(f"invalid --port value {argv[index + 1]!r}")
                return 2
            index += 2
            continue
        if argument == "--host" and index + 1 < len(argv):
            HOST = argv[index + 1]
            index += 2
            continue
        if argument in {"--help", "-h"}:
            print(__doc__)
            return 0
        log(f"ignoring unknown argument {argument!r}")
        index += 1

    try:
        server = RelayServer((HOST, PORT), RelayHandler)
    except OSError as error:
        if error.errno in {errno_address_in_use(), 98, 48}:
            log(f"port {PORT} is already in use: {error}")
        else:
            log(f"could not bind {HOST}:{PORT}: {error}")
        return 1

    announce()

    stopping = threading.Event()

    def shutdown(signum: int, _frame: Any) -> None:
        log(f"received signal {signum} — shutting down")
        stopping.set()
        # shutdown() must run outside the signal handler frame on some platforms.
        threading.Thread(target=server.shutdown, daemon=True).start()

    for signal_name in ("SIGTERM", "SIGINT", "SIGHUP"):
        if hasattr(signal, signal_name):
            signal.signal(getattr(signal, signal_name), shutdown)

    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        log("stopped")
    return 0


def errno_address_in_use() -> int:
    import errno

    return errno.EADDRINUSE


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as fatal:  # pragma: no cover - last-resort guard
        log(f"fatal: {fatal!r}")
        sys.exit(1)
