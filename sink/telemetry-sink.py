#!/usr/bin/env python3
# HELMDECK telemetry sink (container). Appends NDJSON POST bodies to per-session
# files under TELEM_ROOT. Binds 0.0.0.0 INSIDE the zerotier sidecar's network
# namespace, so it is reachable only over ZeroTier: this compose publishes no
# host port for it. Path tokens are allowlisted and "." / ".." rejected, so a
# request can never escape TELEM_ROOT.
#
# Every read from the network is bounded. This service shares a host with
# unrelated workloads, so an unbounded Content-Length or an idle socket must not
# be able to consume the host's memory or thread budget.
import http.server
import os
import re
import socketserver

ROOT = os.environ.get("TELEM_ROOT", "/telem")
PORT = int(os.environ.get("PORT", "9410"))
TOKEN = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
MAX_BODY = 4 * 1024 * 1024


def safe_token(tok):
    return bool(TOKEN.match(tok)) and tok not in (".", "..")


class Handler(http.server.BaseHTTPRequestHandler):
    # A client that connects and then says nothing must not pin a thread.
    timeout = 15

    def _reply(self, code):
        self.send_response(code)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        parts = self.path.strip("/").split("/")
        if (
            len(parts) != 3
            or parts[0] != "telemetry"
            or not safe_token(parts[1])
            or not safe_token(parts[2])
        ):
            self._reply(400)
            return
        node, session = parts[1], parts[2]
        # A malformed Content-Length raises inside socketserver and answers
        # NOTHING, leaving the client to hang until its own timeout.
        try:
            n = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            self._reply(400)
            return
        if n < 0 or n > MAX_BODY:
            self._reply(413)
            return
        body = self.rfile.read(n)
        d = os.path.join(ROOT, node)
        os.makedirs(d, exist_ok=True)
        # NDJSON: without a trailing newline the next POST's first record is
        # concatenated onto this one and BOTH samples are silently unparseable.
        if body and not body.endswith(b"\n"):
            body += b"\n"
        with open(os.path.join(d, session + ".jsonl"), "ab") as f:
            f.write(body)
        self._reply(204)

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingTCPServer):
    # The sink shares the zerotier container's persistent netns, so it is NOT
    # given a fresh one on restart and can hit "Address already in use" from
    # lingering TIME_WAIT sockets, turning a restart into a crash loop.
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 128


if __name__ == "__main__":
    os.makedirs(ROOT, exist_ok=True)
    with Server(("0.0.0.0", PORT), Handler) as s:
        s.serve_forever()
