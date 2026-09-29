#!/usr/bin/env python3
"""
SOC-RAP local server
Serves the SOC-RAP app to this computer only (http://localhost:8731).
- Listens on 127.0.0.1 only, so other machines on the network can't reach it.
- Serves only the app's own files (no directory listing, no other files on disk).
- Accepts GET/HEAD only and rejects requests whose Host isn't localhost (blocks DNS-rebinding).
- Sends strict security headers (CSP, no framing, no sniffing, no referrer, no caching).
Stop it with Ctrl+C.
"""
import http.server, os, socket, sys, threading, webbrowser

PORT = int(os.environ.get("SOC_RAP_PORT", "8731"))   # keep the same port: saved client data belongs to this address
ROOT = os.path.dirname(os.path.abspath(__file__))
FILES = {  # the only paths served
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/vendor/pptxgen.bundle.js": ("vendor/pptxgen.bundle.js", "text/javascript; charset=utf-8"),
}
CSP = ("default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
       "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
HEADERS = {
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), usb=(), payment=()",
    "Cache-Control": "no-store",
}
ALLOWED_HOSTS = {f"localhost:{PORT}", f"127.0.0.1:{PORT}"}

class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "SOC-RAP"
    sys_version = ""

    def _deny(self, code, msg):
        body = msg.encode()
        self.send_response(code)
        for k, v in HEADERS.items(): self.send_header(k, v)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD": self.wfile.write(body)

    def _serve(self):
        if self.headers.get("Host", "") not in ALLOWED_HOSTS:
            return self._deny(403, "Forbidden")
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        entry = FILES.get(path)
        if not entry:
            return self._deny(404, "Not found")
        full = os.path.realpath(os.path.join(ROOT, entry[0]))
        if not full.startswith(ROOT + os.sep) or not os.path.isfile(full):
            return self._deny(404, "Not found")
        with open(full, "rb") as f: body = f.read()
        self.send_response(200)
        for k, v in HEADERS.items(): self.send_header(k, v)
        self.send_header("Content-Type", entry[1])
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD": self.wfile.write(body)

    do_GET = _serve
    do_HEAD = _serve
    def do_POST(self): self._deny(405, "Method not allowed")
    do_PUT = do_DELETE = do_PATCH = do_OPTIONS = do_TRACE = do_CONNECT = do_POST

    def log_message(self, fmt, *args):   # log method, path and status only; never request bodies
        sys.stderr.write("%s  %s\n" % (self.log_date_time_string(), fmt % args))

def main():
    try:
        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError:
        print(f"Port {PORT} is already in use. If SOC-RAP is already running, open http://localhost:{PORT}")
        print("Otherwise close the program using that port and try again.")
        sys.exit(1)
    url = f"http://localhost:{PORT}"
    print(f"SOC-RAP is running at {url}  (this computer only). Press Ctrl+C to stop.")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")

if __name__ == "__main__":
    main()
