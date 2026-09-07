#!/usr/bin/env python3
"""Copy stdin, one JSON line at a time, onto the render socket.

`--serve` makes this the socket the renderer connects to (what main.js does),
so a scene can be driven with no node body and therefore no audio at all;
without it the socket must already exist and node be listening on it.
"""
import os, socket, sys

serve = "--serve" in sys.argv
path = os.environ.get("DARK_EYE_RENDER_SOCK") or os.path.join(
    os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "dark-eye", "render.sock")

if serve:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        os.unlink(path)
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(path)
    os.chmod(path, 0o600)
    srv.listen(1)
    print(f"drive: listening on {path}", file=sys.stderr)
    conn, _ = srv.accept()
    print("drive: renderer connected", file=sys.stderr)
else:
    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    conn.connect(path)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    conn.sendall((line + "\n").encode())
    print(f"drive: {line[:90]}", file=sys.stderr)
conn.close()
if serve:
    srv.close()
    os.unlink(path)
