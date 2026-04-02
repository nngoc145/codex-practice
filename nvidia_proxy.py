import json
import os
import ssl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError

ENV_API_KEY = os.getenv("NVIDIA_API_KEY")
MODEL = os.getenv("NVIDIA_MODEL", "meta/llama-3.1-8b-instruct")
ENDPOINT = os.getenv("NVIDIA_ENDPOINT", "https://integrate.api.nvidia.com/v1/chat/completions")
VERIFY_SSL = os.getenv("NVIDIA_VERIFY_SSL", "false").lower() not in {"0", "false", "no"}


def call_nvidia(message: str, system: str = "", api_key: str | None = None) -> str:
    api_key = (api_key or ENV_API_KEY or "").strip()
    if not api_key:
        raise RuntimeError("Missing NVIDIA_API_KEY")

    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system or ""},
            {"role": "user", "content": message},
        ],
        "temperature": 0.4,
        "max_tokens": 500,
    }

    body = json.dumps(payload).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    req = urlrequest.Request(ENDPOINT, data=body, headers=headers, method="POST")
    context = ssl.create_default_context() if VERIFY_SSL else ssl._create_unverified_context()
    try:
        with urlrequest.urlopen(req, timeout=30, context=context) as resp:
            resp_body = resp.read()
            data = json.loads(resp_body.decode("utf-8"))
    except HTTPError as exc:
        text = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"NVIDIA API error {exc.code}: {text}") from exc
    except URLError as exc:
        raise RuntimeError(f"NVIDIA API unreachable: {exc.reason}") from exc

    try:
        return data["choices"][0]["message"]["content"]
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"Unexpected response: {data}") from exc


class Handler(BaseHTTPRequestHandler):
    def _set_headers(self, status=200, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()

    def do_OPTIONS(self):  # noqa: N802
        self._set_headers(204)

    def do_POST(self):  # noqa: N802
        if self.path != "/chat":
            self._set_headers(404)
            self.wfile.write(b'{"error":"not found"}')
            return
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            self._set_headers(400)
            self.wfile.write(b'{"error":"invalid json"}')
            return

        message = (body.get("message") or "").strip()
        system = body.get("system") or ""
        api_key = body.get("apiKey") or ""
        if not message:
            self._set_headers(400)
            self.wfile.write(b'{"error":"message is required"}')
            return

        try:
            reply = call_nvidia(message, system, api_key)
            self._set_headers(200)
            self.wfile.write(json.dumps({"reply": reply}).encode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            # log server-side for debugging
            print(f"[ERROR] {exc}", flush=True)
            self._set_headers(500)
            self.wfile.write(json.dumps({"error": str(exc)}).encode("utf-8"))


def run(host="127.0.0.1", port=None):
    port = port if port is not None else int(os.getenv("PORT", "5000"))
    with ThreadingHTTPServer((host, port), Handler) as httpd:
        bound_port = httpd.server_address[1]
        print(f"Serving proxy on http://{host}:{bound_port}/chat")
        httpd.serve_forever()


if __name__ == "__main__":
    env_port = os.getenv("PORT")
    run(port=int(env_port) if env_port else None)
