"""Tạo packet fixture từ worker headless sở hữu riêng; không mở GUI."""
import json
from pathlib import Path
from probe_workers import Child, ROOT, stamp

pdf = ROOT / "test/CMNM2026 - Giay moi_BLUE - in_OUTLINE_FONTS_5e2846.pdf"
exe = ROOT / ".tmp/viewer-v27-target/debug/examples/viewer_audit_worker.exe"
output = ROOT / ".tmp/viewer-v27-scene.ppeir"
if output.exists():
    raise FileExistsError("Không ghi đè packet có sẵn")
child = Child(exe, ["--prynx-scene-worker"], 60)
try:
    def exchange():
        child.proc.stdin.write(json.dumps({"path": str(pdf), "page": 1, "revision": 17,
                                          "identity": stamp(pdf)["token"]}).encode())
        child.proc.stdin.close()
        return child.proc.stdout.read()
    packet, wall_ms = child.bounded(exchange)
    if not packet.startswith(b"PPEIR003"):
        raise ValueError("Worker không trả packet scene hợp lệ")
    output.write_bytes(packet)
    print(json.dumps({"packet": str(output), "bytes": len(packet), "wall_ms": wall_ms}))
finally:
    child.close()
