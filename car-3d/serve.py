#!/usr/bin/env python3
"""Local static server for the studio and the driving sim.

  python3 serve.py            ->  http://localhost:8778/index.html
  python3 serve.py 9000       ->  same, on another port

Serves the folder this file sits in, with caching off so an edit to
car-model.js shows up on a plain reload. .claude/launch.json points the
preview pane at this script.

It used to proxy an LLM call for the town's behaviour. That is gone: the
crowd and the traffic run on their own logic now, so there is no key, no
outbound request and nothing to configure.
"""
import http.server
import os
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8778
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write('%s\n' % (fmt % args))


def main():
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(('', PORT), Handler) as httpd:
        httpd.daemon_threads = True
        print('serving %s at http://localhost:%d/index.html' % (ROOT, PORT), flush=True)
        httpd.serve_forever()


if __name__ == '__main__':
    main()
