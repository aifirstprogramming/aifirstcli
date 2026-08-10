#!/usr/bin/env python3
"""Fixture server: always answers 404. Used for the negative test proving
-f semantics survive the -L addition."""
import http.server
import socketserver
import sys

listen_port = int(sys.argv[1])


class NotFoundHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(404)
        self.end_headers()
        self.wfile.write(b"not found")

    def log_message(self, fmt, *args):
        pass


class ReusableServer(socketserver.TCPServer):
    allow_reuse_address = True


with ReusableServer(("127.0.0.1", listen_port), NotFoundHandler) as httpd:
    httpd.serve_forever()
