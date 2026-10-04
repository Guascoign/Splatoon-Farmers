"""Serve the local WebUI and open the macro settings page."""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import webbrowser

HOST = "127.0.0.1"
PORT = 51878
WEB_DIR = Path(__file__).resolve().parents[1] / "web"
URL = f"http://{HOST}:{PORT}/#/macros"

if not (WEB_DIR / "index.html").is_file():
    print(f"WebUI files not found: {WEB_DIR}", file=sys.stderr)
    raise SystemExit(1)

try:
    handler = partial(SimpleHTTPRequestHandler, directory=str(WEB_DIR))
    server = ThreadingHTTPServer((HOST, PORT), handler)
except OSError as exc:
    print(f"Could not start WebUI on {HOST}:{PORT}: {exc}", file=sys.stderr)
    raise SystemExit(1)

print(f"WebUI running at {URL}", flush=True)
print("Keep this window open. Press Ctrl+C to stop.", flush=True)

try:
    webbrowser.open(URL)
    server.serve_forever()
except KeyboardInterrupt:
    print("\nStopping WebUI.")
finally:
    server.server_close()
