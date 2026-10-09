"""cartographer: local mock of a sign-in page to exercise WrenfieldClient._login_on (no network to the clinic)."""
import asyncio, sys, os, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wf_client import WrenfieldClient

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        authed = "sess=ok" in (self.headers.get("Cookie") or "")
        if self.path.startswith("/login") and not authed or (not authed):
            if not self.path.startswith("/login"):
                self.send_response(302); self.send_header("Location", "/login"); self.end_headers(); return
            body = b"<!doctype html><html><body><main><h1>Sign in</h1><form method=post action=/login><label>Username <input name=u></label><label>Password <input type=password name=p></label><button>Sign in</button></form></main></body></html>"
        elif self.path.startswith("/login"):
            self.send_response(302); self.send_header("Location", "/"); self.end_headers(); return
        else:
            body = b"<!doctype html><html><body><main><h1>Dashboard</h1><p>Welcome</p></main></body></html>"
        self.send_response(200); self.send_header("Content-Type", "text/html"); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0)); q = parse_qs(self.rfile.read(n).decode())
        if q.get("u") == ["agent"] and q.get("p") == ["pw123"]:
            self.send_response(302); self.send_header("Set-Cookie", "sess=ok; Path=/"); self.send_header("Location", "/"); self.end_headers()
        else:
            self.send_response(302); self.send_header("Location", "/login?err=1"); self.end_headers()

srv = HTTPServer(("127.0.0.1", 8765), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()

async def main():
    async with WrenfieldClient("http://127.0.0.1:8765", "agent", "pw123") as wf:
        print(await wf.get_text("/"))
    try:
        async with WrenfieldClient("http://127.0.0.1:8765", "agent", "wrong") as wf:
            print("unexpected success")
    except Exception as e:
        print("bad password ->", type(e).__name__, e)
asyncio.run(main())
