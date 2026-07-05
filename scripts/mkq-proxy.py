#!/usr/bin/env python3
"""
MKQ AI Proxy — Lightweight OpenAI-compatible API for Ollama
============================================================
Replaces LiteLLM. Handles:
  - OpenAI-compatible /v1/chat/completions (streaming + non-streaming)
  - sk-mkq- API key validation (configurable via config.yaml)
  - /v1/models endpoint
  - /health endpoint
  - Key generation & management via /key/* endpoints

Usage:
  python3 mkq-proxy.py --port 4000 --host 0.0.0.0
"""

import sys, os, json, re, asyncio, secrets, hashlib, time, argparse
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.request import urlopen, Request
from urllib.error import URLError
import threading

# ─── CONFIG ──────────────────────────────────────────────────────────────────
CFG = {
    "ollama_base": os.environ.get("OLLAMA_BASE", "http://127.0.0.1:11434"),
    "master_key": os.environ.get("MKQ_MASTER_KEY", "sk-mkq-master-secret"),
    "port": int(os.environ.get("PORT", "4000")),
    "host": os.environ.get("HOST", "0.0.0.0"),
    "keys_file": os.environ.get("KEYS_FILE", "/var/lib/mkq/keys.json"),
}
KEY_PREFIX = "sk-mkq-"
KEY_REGEX = re.compile(r"^sk-mkq-[a-f0-9]{42}$")

# ─── KEY STORE ───────────────────────────────────────────────────────────────
keys_store = {}
keys_lock = threading.Lock()

def load_keys():
    global keys_store
    try:
        os.makedirs(os.path.dirname(CFG["keys_file"]), exist_ok=True)
        with open(CFG["keys_file"]) as f:
            keys_store = json.load(f)
    except:
        keys_store = {}

def save_keys():
    with keys_lock:
        try:
            os.makedirs(os.path.dirname(CFG["keys_file"]), exist_ok=True)
            with open(CFG["keys_file"], 'w') as f:
                json.dump(keys_store, f, indent=2)
        except:
            pass

def validate_key(token: str) -> bool:
    """Check if key is valid (master key or stored key)."""
    if token == CFG["master_key"]:
        return True
    if KEY_REGEX.match(token):
        with keys_lock:
            return token in keys_store
    return False

def generate_key(alias: str = "", models: list = None, duration: str = "90d") -> str:
    """Generate a new sk-mkq- key."""
    hex_part = secrets.token_hex(21)
    key = f"{KEY_PREFIX}{hex_part}"
    with keys_lock:
        keys_store[key] = {
            "alias": alias,
            "models": models or ["deepseek-r1-mkq"],
            "duration": duration,
            "created": time.time()
        }
    save_keys()
    return key

# ─── OLLAMA BRIDGE ───────────────────────────────────────────────────────────
def ollama_chat_sync(model: str, messages: list, temperature: float = 0.7, max_tokens: int = 2048):
    """Non-streaming chat completion."""
    payload = {
        "model": model, "messages": messages, "stream": False,
        "options": {"temperature": temperature, "num_predict": max(max_tokens, 2048)}
    }
    req = Request(
        f"{CFG['ollama_base']}/api/chat",
        data=json.dumps(payload).encode('utf-8'),
        headers={"Content-Type": "application/json"}
    )
    try:
        resp = urlopen(req, timeout=300)
        data = json.loads(resp.read())
        content = data.get("message", {}).get("content", "")
        return {
            "id": "chatcmpl-" + secrets.token_hex(12),
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        }
    except URLError as e:
        raise Exception(f"Ollama connection failed: {e}")

def ollama_chat_stream_stream(model: str, messages: list, temperature: float = 0.7, max_tokens: int = 2048):
    """Streaming chat completion — yields SSE chunks."""
    payload = {
        "model": model, "messages": messages, "stream": True,
        "options": {"temperature": temperature, "num_predict": max(max_tokens, 2048)}
    }
    req = Request(
        f"{CFG['ollama_base']}/api/chat",
        data=json.dumps(payload).encode('utf-8'),
        headers={"Content-Type": "application/json"}
    )
    try:
        resp = urlopen(req, timeout=300)
        buffer = b""
        while True:
            chunk = resp.read(4096)
            if not chunk:
                break
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                try:
                    data = json.loads(line)
                    delta = {}
                    msg = data.get("message", {})
                    if "content" in msg:
                        delta["content"] = msg["content"]
                    if delta:
                        yield f"data: {json.dumps({'choices': [{'delta': delta, 'index': 0}], 'id': 'chatcmpl-' + secrets.token_hex(12), 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': model})}\n\n"
                except:
                    pass
        yield "data: [DONE]\n\n"
    except URLError as e:
        yield f"data: {json.dumps({'error': str(e)})}\n\n"

def ollama_list_models():
    """Get list of models from Ollama."""
    try:
        req = Request(f"{CFG["ollama_base"]}/api/tags")
        resp = urlopen(req, timeout=10)
        data = json.loads(resp.read())
        models = []
        for m in data.get("models", []):
            name = m.get("name", "unknown")
            models.append({"id": name, "object": "model"})
        return {"object": "list", "data": models}
    except:
        return {"object": "list", "data": []}

# ─── SSE HELPER ──────────────────────────────────────────────────────────────
def sse_encode(data: dict) -> str:
    """Convert dict to SSE format."""
    return f"data: {json.dumps(data)}\n\n"

# ─── HTTP HANDLER ────────────────────────────────────────────────────────────
class MKQHandler(BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        """Quiet logging."""
        if "/health" not in str(args):
            sys.stderr.write(f"[mkq-proxy] {args[0]}\n")

    def _send_json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

    def _send_error(self, msg, status=401):
        self._send_json({"error": {"message": msg, "type": "auth_error", "code": str(status)}}, status)

    def _get_token(self):
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            return auth[7:]
        return ""

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._send_json({"status": "ok", "ollama": CFG["ollama_base"]})
            return

        if self.path == "/v1/models":
            token = self._get_token()
            if not validate_key(token):
                return self._send_error("Invalid API key")
            self._send_json(ollama_list_models())
            return

        if self.path.startswith("/key/list"):
            token = self._get_token()
            if token != CFG["master_key"]:
                return self._send_error("Master key required")
            with keys_lock:
                key_list = [{"key": k[:12] + "...", "key_alias": v.get("alias", ""),
                             "models": v.get("models", [])} for k, v in keys_store.items()]
            self._send_json(key_list)
            return

        if self.path == "/key/info":
            return self._send_json({"info": {}})

        self._send_json({"error": "Not found"}, 404)

    def do_POST(self):
        # Read body
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(body)
        except:
            data = {}

        # ── Chat Completions ──────────────────────────────────────────
        if self.path == "/v1/chat/completions":
            token = self._get_token()
            if not validate_key(token):
                return self._send_error("Invalid API key")

            model = data.get("model", "deepseek-r1-mkq")
            messages = data.get("messages", [])
            stream = data.get("stream", False)
            temperature = data.get("temperature", 0.7)
            max_tokens = data.get("max_tokens", 2048)

            if not messages:
                return self._send_error("messages required", 400)

            try:
                if stream:
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("Cache-Control", "no-cache")
                    self.send_header("Connection", "keep-alive")
                    self.end_headers()

                    for chunk in ollama_chat_stream(model, messages,
                                            temperature=temperature, max_tokens=max_tokens):
                        self.wfile.write(chunk.encode('utf-8'))
                        self.wfile.flush()
                else:
                    result = ollama_chat_sync(model, messages,
                                        temperature=temperature, max_tokens=max_tokens)
                    self._send_json(result)
            except Exception as e:
                if stream:
                    err_data = sse_encode({"error": str(e)})
                    self.wfile.write(err_data.encode('utf-8'))
                else:
                    self._send_error(str(e), 500)
            return

        # ── Key Generation ───────────────────────────────────────────
        if self.path == "/key/generate":
            token = self._get_token()
            if token != CFG["master_key"]:
                return self._send_error("Master key required")

            alias = data.get("key_alias", data.get("key", "unnamed"))
            models = data.get("models", ["deepseek-r1-mkq"])
            duration = data.get("duration", "90d")

            new_key = generate_key(alias, models, duration)
            self._send_json({
                "key": new_key,
                "key_alias": alias,
                "models": models,
                "duration": duration
            })
            return

        # ── Key Delete ───────────────────────────────────────────────
        if self.path == "/key/delete":
            token = self._get_token()
            if token != CFG["master_key"]:
                return self._send_error("Master key required")

            to_delete = data.get("keys", [])
            deleted = []
            with keys_lock:
                for k in to_delete:
                    if k in keys_store:
                        del keys_store[k]
                        deleted.append(k)
            save_keys()
            self._send_json({"deleted": deleted})
            return

        self._send_json({"error": "Not found"}, 404)

# ─── MAIN ────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="MKQ AI Proxy")
    parser.add_argument("--port", type=int, default=CFG["port"], help=f"Port (default: {CFG['port']})")
    parser.add_argument("--host", type=str, default=CFG["host"], help=f"Host (default: {CFG['host']})")
    parser.add_argument("--ollama", type=str, default=CFG["ollama_base"], help="Ollama base URL")
    parser.add_argument("--master-key", type=str, default=CFG["master_key"], help="Master API key")
    args = parser.parse_args()

    CFG["ollama_base"] = args.ollama
    CFG["master_key"] = args.master_key
    CFG["port"] = args.port
    CFG["host"] = args.host

    # Load existing keys
    load_keys()

    print(f"""
╔══════════════════════════════════════════════════════════════╗
║     🧠 MKQ AI Proxy — Ready                                  ║
╠══════════════════════════════════════════════════════════════╣
║  Ollama:    {CFG['ollama_base']:<44} ║
║  Listen:    http://{CFG['host']}:{CFG['port']:<38} ║
║  Keys:      {CFG['keys_file']:<44} ║
║  Master:    {CFG['master_key'][:20]}...{'':<31} ║
╚══════════════════════════════════════════════════════════════╝
""")

    server = HTTPServer((CFG["host"], CFG["port"]), MKQHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()

if __name__ == "__main__":
    main()
