#!/usr/bin/env python3
"""Fixture server: always answers with a 302 to a second local port.

Used by test-download-progress.sh to exercise download_with_progress()'s
real redirect-following path. Not part of the shipped installer.
"""
import http.server
import socketserver
import sys

listen_port = int(sys.argv[1])
target_port = int(sys.argv[2])


class RedirectHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self._redirect()

    def do_HEAD(self):
        self._redirect()

    def _redirect(self):
        target = f"http://127.0.0.1:{target_port}{self.path}"
        self.send_response(302)
        self.send_header("Location", target)
        self.end_headers()

    def log_message(self, fmt, *args):
        pass


class ReusableServer(socketserver.TCPServer):
    allow_reuse_address = True


with ReusableServer(("127.0.0.1", listen_port), RedirectHandler) as httpd:
    httpd.serve_forever()
