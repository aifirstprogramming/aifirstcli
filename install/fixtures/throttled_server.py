#!/usr/bin/env python3
"""Fixture server: serves one file in slow chunks so a poller can observe
genuine intermediate progress instead of a single 0-to-100 jump."""
import http.server
import os
import socketserver
import sys
import time

listen_port = int(sys.argv[1])
file_path = sys.argv[2]
CHUNK = 32 * 1024
DELAY_SECONDS = 0.35


class ThrottledHandler(http.server.BaseHTTPRequestHandler):
    def do_HEAD(self):
        size = os.path.getsize(file_path)
        self.send_response(200)
        self.send_header("Content-Length", str(size))
        self.end_headers()

    def do_GET(self):
        size = os.path.getsize(file_path)
        self.send_response(200)
        self.send_header("Content-Length", str(size))
        self.end_headers()
        with open(file_path, "rb") as f:
            while True:
                chunk = f.read(CHUNK)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
                time.sleep(DELAY_SECONDS)

    def log_message(self, fmt, *args):
        pass


class ReusableServer(socketserver.TCPServer):
    allow_reuse_address = True


with ReusableServer(("127.0.0.1", listen_port), ThrottledHandler) as httpd:
    httpd.serve_forever()
