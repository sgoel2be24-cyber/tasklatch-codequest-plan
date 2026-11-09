"""desktopd: the only control channel into an agent desktop.

The TaskLatch controller (never the model) calls this to take screenshots and perform input
that the policy engine has already allowed. Every request needs the per-container token.
"""
import json
import os
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ["TL_DESKTOP_TOKEN"]
W = int(os.environ.get("TL_SCREEN_W", "1280"))
H = int(os.environ.get("TL_SCREEN_H", "800"))
ALLOWED_KEYS = {
    "Return", "Tab", "Escape", "BackSpace", "Delete", "Up", "Down", "Left", "Right", "Home", "End",
    "Page_Up", "Page_Down", "space", "ctrl+a", "ctrl+c", "ctrl+v", "ctrl+l", "ctrl+f", "ctrl+r",
    "alt+Left", "alt+Right", "shift+Tab", "ctrl+t", "ctrl+w", "ctrl+Tab", "ctrl+shift+Tab",
}


def xdo(*args, timeout=10):
    return subprocess.run(["xdotool", *args], capture_output=True, text=True, timeout=timeout)


def focus_browser():
    xdo("search", "--onlyvisible", "--class", "chromium", "windowactivate", "--sync")


def clamp(v, hi):
    return max(0, min(int(v), hi - 1))


class Cdp:
    """Minimal DevTools protocol session over WebSocket (stdlib only), in-container port 9222 only."""

    def __init__(self, ws_url):
        import base64, socket, urllib.parse
        u = urllib.parse.urlparse(ws_url)
        self.s = socket.create_connection((u.hostname, u.port), timeout=8)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f"GET {u.path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        hdr = b""
        while b"\r\n\r\n" not in hdr:
            hdr += self.s.recv(1)
        if b" 101 " not in hdr.split(b"\r\n")[0]:
            raise RuntimeError("websocket upgrade refused")
        self.next_id = 0

    def _recv_exact(self, k):
        buf = b""
        while len(buf) < k:
            chunk = self.s.recv(k - len(buf))
            if not chunk:
                raise RuntimeError("websocket closed")
            buf += chunk
        return buf

    def _recv_message(self):
        import struct
        data, opcode = b"", None
        while True:
            b1, b2 = self._recv_exact(2)
            ln = b2 & 0x7F
            if ln == 126:
                ln = struct.unpack(">H", self._recv_exact(2))[0]
            elif ln == 127:
                ln = struct.unpack(">Q", self._recv_exact(8))[0]
            chunk = self._recv_exact(ln)
            if opcode is None:
                opcode = b1 & 0x0F
            data += chunk
            if b1 & 0x80:  # FIN
                return opcode, data

    def call(self, method, params=None):
        import struct
        self.next_id += 1
        mid = self.next_id
        payload = json.dumps({"id": mid, "method": method, "params": params or {}}).encode()
        mask = os.urandom(4)
        n = len(payload)
        head = bytes([0x81]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n) if n < 65536 else bytes([0x80 | 127]) + struct.pack(">Q", n))
        self.s.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
        while True:
            opcode, data = self._recv_message()
            if opcode == 1:
                msg = json.loads(data)
                if msg.get("id") == mid:
                    if "error" in msg:
                        raise RuntimeError(msg["error"].get("message", "cdp error"))
                    return msg.get("result", {})

    def eval(self, expression):
        r = self.call("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True})
        return r.get("result", {}).get("value")

    def close(self):
        try:
            self.s.close()
        except Exception:
            pass


def active_tab():
    import urllib.request
    tabs = json.loads(urllib.request.urlopen("http://127.0.0.1:9222/json", timeout=3).read())
    pages = [t for t in tabs if t.get("type") == "page" and not str(t.get("url", "")).startswith(("chrome://", "devtools://", "chrome-untrusted://"))]
    return pages[0] if pages else None  # the most recently focused page is listed first


def read_page():
    tab = active_tab()
    if not tab:
        return {"url": None, "title": None, "text": ""}
    text = ""
    try:
        c = Cdp(tab["webSocketDebuggerUrl"])
        text = c.eval("document.body ? document.body.innerText.slice(0, 20000) : ''") or ""
        c.close()
    except Exception as e:
        text = f"[page text unavailable: {e}]"
    return {"url": tab.get("url"), "title": tab.get("title"), "text": text}


# Labels every visible interactive element with a number (set-of-marks), returns their screen centres.
MARK_JS = r"""
(() => {
  document.querySelectorAll('[data-tl-mark]').forEach(e => e.remove());
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],[onclick],[contenteditable=true],summary,label[for]';
  const chromeTop = window.outerHeight - window.innerHeight, chromeLeft = (window.outerWidth - window.innerWidth) / 2;
  const out = []; let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    const st = getComputedStyle(el); if (st.visibility === 'hidden' || st.display === 'none' || +st.opacity === 0) continue;
    const id = ++n; if (id > 80) break;
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.name || el.getAttribute('href') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    out.push({ id, tag: el.tagName.toLowerCase(), type: el.type || el.getAttribute('role') || '', label,
      x: Math.round(chromeLeft + r.left + r.width / 2), y: Math.round(chromeTop + r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) });
    const m = document.createElement('div'); m.setAttribute('data-tl-mark', '');
    m.style.cssText = `position:fixed;left:${Math.max(0, r.left - 2)}px;top:${Math.max(0, r.top - 2)}px;width:${r.width + 2}px;height:${r.height + 2}px;outline:2px solid #e11d48;z-index:2147483647;pointer-events:none`;
    const tag = document.createElement('span'); tag.textContent = id;
    tag.style.cssText = 'position:absolute;left:-2px;top:-14px;background:#e11d48;color:#fff;font:bold 11px/13px sans-serif;padding:0 3px;border-radius:3px';
    m.appendChild(tag); document.documentElement.appendChild(m);
  }
  const vis = []; let total = 0;
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t && total < 4000; t = walker.nextNode()) {
    const txt = t.nodeValue.replace(/\s+/g, ' ').trim(); if (txt.length < 2) continue;
    const p = t.parentElement; if (!p || p.closest('[data-tl-mark],script,style,noscript')) continue;
    const r = p.getBoundingClientRect(); if (r.bottom < 0 || r.top > innerHeight || r.width === 0) continue;
    vis.push(txt); total += txt.length + 1;
  }
  return { elements: out, visibleText: vis.join('\n'), scrollY: Math.round(scrollY), scrollMax: Math.max(0, document.documentElement.scrollHeight - innerHeight), viewport: [innerWidth, innerHeight] };
})()
"""
UNMARK_JS = "document.querySelectorAll('[data-tl-mark]').forEach(e => e.remove()); true"


def observe(width=768):
    """Labelled viewport screenshot (JPEG, scaled to `width`), element list, URL, title and page text."""
    tab = active_tab()
    if not tab:
        return {"url": None, "title": None, "text": "", "elements": [], "screenshot": None}
    c = Cdp(tab["webSocketDebuggerUrl"])
    try:
        marks = c.eval(MARK_JS) or {"elements": [], "viewport": [W, H]}
        vw, vh = marks.get("viewport", [W, H])
        scale = min(1.0, width / max(1, vw))
        shot = c.call("Page.captureScreenshot", {"format": "jpeg", "quality": 70,
                                                 "clip": {"x": 0, "y": 0, "width": vw, "height": vh, "scale": scale}})
        c.eval(UNMARK_JS)
        text = c.eval("document.body ? document.body.innerText.slice(0, 20000) : ''") or ""
    finally:
        c.close()
    return {"url": tab.get("url"), "title": tab.get("title"), "text": text, "visible_text": marks.get("visibleText", ""), "elements": marks.get("elements", []),
            "scroll": {"y": marks.get("scrollY", 0), "max": marks.get("scrollMax", 0)}, "screenshot": shot.get("data"),
            "screenshot_scale": scale, "viewport": [vw, vh]}


def act(a):
    t = a.get("type")
    if t in ("click", "double_click", "move"):  # no right-click: keeps the context menu (and Inspect) out of reach
        x, y = clamp(a["x"], W), clamp(a["y"], H)
        xdo("mousemove", str(x), str(y))
        if t == "click":
            xdo("click", "1")
        elif t == "double_click":
            xdo("click", "--repeat", "2", "--delay", "80", "1")
        return {"ok": True}
    if t == "type":
        text = str(a.get("text", ""))[:2000]
        xdo("type", "--delay", "15", "--", text, timeout=60)
        return {"ok": True}
    if t == "key":
        keys = str(a.get("keys", ""))
        if keys not in ALLOWED_KEYS:
            return {"ok": False, "error": f"key not allowed: {keys}"}
        xdo("key", "--", keys)
        return {"ok": True}
    if t == "scroll":
        x, y = clamp(a.get("x", W // 2), W), clamp(a.get("y", H // 2), H)
        amount = max(-15, min(15, int(a.get("amount", 5))))
        xdo("mousemove", str(x), str(y))
        xdo("click", "--repeat", str(abs(amount)), "--delay", "30", "5" if amount > 0 else "4")
        return {"ok": True}
    if t == "navigate":
        url = str(a.get("url", ""))[:2000]
        focus_browser()
        xdo("key", "ctrl+l")
        time.sleep(0.15)
        xdo("type", "--delay", "8", "--", url, timeout=30)
        xdo("key", "Return")
        return {"ok": True}
    return {"ok": False, "error": f"unsupported action: {t}"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _auth(self):
        if self.headers.get("X-TL-Token") != TOKEN:
            self.send_response(401)
            self.end_headers()
            return False
        return True

    def _json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True, "screen": [W, H]})
        if not self._auth():
            return
        if self.path == "/screenshot":
            subprocess.run(["scrot", "-o", "-z", "/tmp/shot.png"], capture_output=True, timeout=10)
            with open("/tmp/shot.png", "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("content-type", "image/png")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if self.path.startswith("/observe"):
            try:
                return self._json(200, observe())
            except Exception as e:
                return self._json(200, {"url": None, "title": None, "text": "", "elements": [], "screenshot": None, "error": str(e)[:200]})
        if self.path == "/page":
            try:
                return self._json(200, read_page())
            except Exception as e:
                return self._json(200, {"url": None, "title": None, "text": "", "error": str(e)[:200]})
        self._json(404, {"error": "not_found"})

    def do_POST(self):
        if not self._auth():
            return
        if self.path != "/action":
            return self._json(404, {"error": "not_found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0") or 0)) or b"{}")
            self._json(200, act(body))
        except Exception as e:  # report, never crash the desktop
            self._json(400, {"ok": False, "error": str(e)[:300]})


ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
