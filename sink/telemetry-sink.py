#!/usr/bin/env python3
# HELMDECK telemetry sink (container). Appends NDJSON POST bodies to per-session
# files under TELEM_ROOT. Binds 0.0.0.0 inside the container; the compose port
# mapping restricts the host side to the WireGuard address. Path tokens are
# allowlisted and "." / ".." rejected, so a request can never escape TELEM_ROOT.
import http.server
import os
import re
import socketserver

ROOT = os.environ.get("TELEM_ROOT", "/telem")
PORT = int(os.environ.get("PORT", "9410"))
TOKEN = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def safe_token(tok):
    return bool(TOKEN.match(tok)) and tok not in (".", "..")


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        parts = self.path.strip("/").split("/")
        if (
            len(parts) != 3
            or parts[0] != "telemetry"
            or not safe_token(parts[1])
            or not safe_token(parts[2])
        ):
            self.send_response(400)
            self.end_headers()
            return
        node, session = parts[1], parts[2]
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n)
        d = os.path.join(ROOT, node)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, session + ".jsonl"), "ab") as f:
            f.write(body)
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    os.makedirs(ROOT, exist_ok=True)
    with socketserver.ThreadingTCPServer(("0.0.0.0", PORT), Handler) as s:
        s.serve_forever()
