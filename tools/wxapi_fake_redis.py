#!/usr/bin/env python3
import fnmatch
import socket
import socketserver
import threading
import time


store = {}
hash_store = {}
expires = {}
lock = threading.Lock()


def encode(value):
    if value is None:
        return b"$-1\r\n"
    if isinstance(value, bytes):
        return b"$%d\r\n%s\r\n" % (len(value), value)
    if isinstance(value, str):
        return encode(value.encode())
    if isinstance(value, int):
        return b":%d\r\n" % value
    if isinstance(value, list):
        return b"*%d\r\n" % len(value) + b"".join(encode(item) for item in value)
    return encode(str(value))


def ok(message="OK"):
    return f"+{message}\r\n".encode()


def error(message):
    return f"-ERR {message}\r\n".encode()


def purge_expired(now=None):
    now = now or time.time()
    dead = [key for key, deadline in expires.items() if deadline <= now]
    for key in dead:
        store.pop(key, None)
        hash_store.pop(key, None)
        expires.pop(key, None)


class RespHandler(socketserver.StreamRequestHandler):
    def read_command(self):
        first = self.rfile.readline()
        if not first:
            return None
        first = first.rstrip(b"\r\n")
        if not first:
            return []
        if first.startswith(b"*"):
            try:
                count = int(first[1:])
            except ValueError:
                raise ValueError("bad array length")
            parts = []
            for _ in range(count):
                header = self.rfile.readline().rstrip(b"\r\n")
                if not header.startswith(b"$"):
                    raise ValueError("bad bulk header")
                length = int(header[1:])
                data = self.rfile.read(length)
                self.rfile.read(2)
                parts.append(data.decode(errors="replace"))
            return parts
        return first.decode(errors="replace").split()

    def handle(self):
        self.request.settimeout(60)
        while True:
            try:
                cmd = self.read_command()
                if cmd is None:
                    return
                response = self.execute(cmd)
            except socket.timeout:
                return
            except Exception as exc:
                response = error(str(exc))
            self.wfile.write(response)
            self.wfile.flush()

    def execute(self, cmd):
        if not cmd:
            return ok()
        op = cmd[0].upper()

        with lock:
            purge_expired()

            if op == "PING":
                return ok("PONG")
            if op in {"AUTH", "SELECT", "CLIENT", "CONFIG"}:
                return ok()
            if op == "QUIT":
                return ok()

            if op == "SET" and len(cmd) >= 3:
                key, value = cmd[1], cmd[2]
                store[key] = value
                hash_store.pop(key, None)
                expires.pop(key, None)
                rest = [part.upper() for part in cmd[3:]]
                if "EX" in rest:
                    idx = rest.index("EX")
                    if idx + 1 < len(cmd[3:]):
                        expires[key] = time.time() + int(cmd[3:][idx + 1])
                if "PX" in rest:
                    idx = rest.index("PX")
                    if idx + 1 < len(cmd[3:]):
                        expires[key] = time.time() + int(cmd[3:][idx + 1]) / 1000
                return ok()

            if op == "GET" and len(cmd) >= 2:
                return encode(store.get(cmd[1]))

            if op == "DEL":
                removed = 0
                for key in cmd[1:]:
                    if key in store or key in hash_store:
                        removed += 1
                    store.pop(key, None)
                    hash_store.pop(key, None)
                    expires.pop(key, None)
                return encode(removed)

            if op == "EXISTS":
                return encode(sum(1 for key in cmd[1:] if key in store or key in hash_store))

            if op == "KEYS" and len(cmd) >= 2:
                keys = set(store) | set(hash_store)
                return encode(sorted(key for key in keys if fnmatch.fnmatch(key, cmd[1])))

            if op == "EXPIRE" and len(cmd) >= 3:
                key = cmd[1]
                if key not in store and key not in hash_store:
                    return encode(0)
                expires[key] = time.time() + int(cmd[2])
                return encode(1)

            if op == "TTL" and len(cmd) >= 2:
                key = cmd[1]
                if key not in store and key not in hash_store:
                    return encode(-2)
                if key not in expires:
                    return encode(-1)
                return encode(max(0, int(expires[key] - time.time())))

            if op == "HSET" and len(cmd) >= 4:
                key = cmd[1]
                bucket = hash_store.setdefault(key, {})
                added = 0
                for idx in range(2, len(cmd) - 1, 2):
                    field = cmd[idx]
                    if field not in bucket:
                        added += 1
                    bucket[field] = cmd[idx + 1]
                store.pop(key, None)
                return encode(added)

            if op == "HGET" and len(cmd) >= 3:
                return encode(hash_store.get(cmd[1], {}).get(cmd[2]))

            if op == "HGETALL" and len(cmd) >= 2:
                out = []
                for field, value in hash_store.get(cmd[1], {}).items():
                    out.extend([field, value])
                return encode(out)

            if op == "DBSIZE":
                return encode(len(set(store) | set(hash_store)))

        return error(f"unsupported command {op}")


class ThreadingServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=6379)
    args = parser.parse_args()

    with ThreadingServer((args.host, args.port), RespHandler) as server:
        print(f"fake redis listening on {args.host}:{args.port}", flush=True)
        server.serve_forever()
