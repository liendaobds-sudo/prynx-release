"""Đo PPE viewport trước/sau khi hoãn near-grid, không mở hay điều khiển UI.

Gọi binary worker có sẵn qua protocol thật; không build/thay binary. Hai nhánh
dựng cùng 7 PNG, chỉ đổi thời điểm gửi 6 cell nền. Không coi đây là click-to-paint.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import statistics
import struct
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parent.parent
PREFIX = struct.Struct("<4sHHQIQ")
PIPELINE = "ppe-fogra39-relative-view-knockout-png-v6-native-worker"


def sha256(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


class Worker:
    def __init__(self, executable: Path, lanes: int | None):
        env = os.environ.copy()
        if lanes is not None:
            env["PRYNX_RENDER_BACKGROUND_WORKERS"] = str(lanes)
        self.process = subprocess.Popen(
            [str(executable), "--prynx-render-worker"], cwd=ROOT / "desktop/src-tauri",
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env=env, creationflags=subprocess.CREATE_NO_WINDOW,
        )
        self.serial = 0
        self.results: queue.Queue = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()

    def _exact(self, size: int) -> bytes:
        result = bytearray()
        while len(result) < size:
            part = self.process.stdout.read(size - len(result))
            if not part:
                raise RuntimeError("Worker kết thúc khi chưa trả đủ frame")
            result.extend(part)
        return bytes(result)

    def _read(self):
        try:
            while True:
                magic, version, kind, wire, header_size, payload_size = PREFIX.unpack(self._exact(PREFIX.size))
                if (magic, version, kind) != (b"PXRW", 4, 2) or header_size > 65536 or payload_size > 512 * 1024**2:
                    raise RuntimeError("Frame worker không hợp lệ")
                header = json.loads(self._exact(header_size))
                payload = self._exact(payload_size)
                self.results.put((wire, header, payload, time.perf_counter()))
        except Exception as error:
            self.results.put(error)

    def send(self, header: dict) -> int:
        self.serial += 1
        header = dict(header, request_id=f"zoom-runway-{self.serial}")
        data = json.dumps(header).encode()
        self.process.stdin.write(PREFIX.pack(b"PXRW", 4, 1, self.serial, len(data), 0) + data)
        self.process.stdin.flush()
        return self.serial

    def receive(self):
        item = self.results.get(timeout=60)
        if isinstance(item, Exception):
            raise item
        return item

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                # Chỉ dừng child do chính benchmark tạo, không đụng app người dùng.
                self.process.kill()
                self.process.wait(timeout=5)


def run(args):
    pdf, executable = args.pdf.resolve(), args.worker.resolve()
    before = (sha256(pdf), sha256(executable))
    stat = pdf.stat()
    created = getattr(stat, "st_birthtime_ns", stat.st_ctime_ns)
    identity = {
        "path": str(pdf), "size_bytes": str(stat.st_size),
        "modified_nanos": str(stat.st_mtime_ns), "created_nanos": str(created),
        "token": f"{stat.st_size}:{stat.st_mtime_ns}:{created}",
    }
    worker = Worker(executable, args.lanes)
    rows, reference = [], {}
    try:
        worker.send({"message": "hello", "parent_pid": os.getpid(), "nonce": "zoom-runway",
                     "expected_app_version": "2.0.4", "expected_tile_cache_version": "v8_transparent_bg_lossless_png",
                     "expected_pipeline_identity": "pdfium-display-png-v1"})
        _, hello, _, _ = worker.receive()
        if not hello.get("ok") or hello.get("worker_pid") != worker.process.pid:
            raise RuntimeError(f"Handshake không đạt: {hello}")

        def request(slot):
            clip = {"x": 1024, "y": 512, "width": 1344, "height": 832} if slot == 0 else {
                "x": 1024 + ((slot - 1) % 3) * 512,
                "y": 512 + ((slot - 1) // 3) * 512, "width": 512, "height": 512,
            }
            return worker.send({
                "message": "render", "owner_id": "viewer:zoom-runway", "session_owner_id": "viewer:zoom-runway",
                "group_key": f"viewport-{slot}", "generation": worker.serial + 1,
                "purpose": "accurate", "priority": 0 if slot == 0 else 100 + slot,
                "document": identity, "page": 1, "rotation": 0,
                "raster": {"kind": "dpi", "dpi": args.dpi, "clip": clip},
                "color": {"pipeline": "accurate", "profile_id": "fogra39", "intent": "relative"},
                "pipeline_identity": PIPELINE, "soundness": "color-verified",
            })

        def check(slot, header, payload):
            if header.get("status") != "ready" or header.get("soundness") != "color-verified" or not payload.startswith(b"\x89PNG"):
                raise RuntimeError(f"PPE không đạt: {header}")
            digest = hashlib.sha256(payload).hexdigest()
            if reference.setdefault(slot, digest) != digest:
                raise RuntimeError(f"PNG đổi ở slot {slot}")

        # Làm ấm đầy đủ bảy vùng trước cả hai nhánh, giữ lại hash đối chiếu.
        for slot in range(7):
            wire = request(slot)
            received, header, payload, _ = worker.receive()
            assert received == wire
            check(slot, header, payload)

        for sample in range(args.samples):
            modes = ("eager", "deferred") if sample % 2 == 0 else ("deferred", "eager")
            for mode in modes:
                started = time.perf_counter()
                pending = {request(0): 0}
                if mode == "eager":
                    for slot in range(1, 7):
                        pending[request(slot)] = slot
                main_ms = None
                while pending:
                    wire, header, payload, finished = worker.receive()
                    slot = pending.pop(wire)
                    check(slot, header, payload)
                    if slot == 0:
                        main_ms = (finished - started) * 1000
                        if mode == "deferred":
                            for next_slot in range(1, 7):
                                pending[request(next_slot)] = next_slot
                rows.append({"sample": sample, "mode": mode, "main_ms": round(main_ms, 2),
                             "all_ms": round((finished - started) * 1000, 2)})
                print(json.dumps(rows[-1]), flush=True)
        assert before == (sha256(pdf), sha256(executable))
        report = {"scope": "headless-worker-png-not-webview", "pdf_sha256": before[0],
                  "worker_sha256": before[1], "lanes_override": args.lanes, "dpi": args.dpi,
                  "worker_pid": worker.process.pid, "samples_per_mode": args.samples,
                  "png_sha256": reference, "rows": rows,
                  "median_main_ms": {mode: statistics.median(row["main_ms"] for row in rows if row["mode"] == mode)
                                     for mode in ("eager", "deferred")}}
        with args.output.open("x", encoding="utf-8") as handle:
            handle.write(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report["median_main_ms"]), flush=True)
    finally:
        worker.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", type=Path, required=True)
    parser.add_argument("--worker", type=Path, default=ROOT / "desktop/src-tauri/target/debug/pdf-inspector.exe")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--samples", type=int, default=6)
    parser.add_argument("--dpi", type=float, default=188)
    parser.add_argument("--lanes", type=int)
    options = parser.parse_args()
    if options.samples < 1 or options.dpi <= 0 or (options.lanes is not None and options.lanes < 0):
        parser.error("samples/DPI phải dương, lanes phải không âm")
    if options.output.resolve() in (options.pdf.resolve(), options.worker.resolve()) or options.output.exists():
        parser.error("Output phải là file mới, không ghi đè PDF/binary/báo cáo có sẵn")
    run(options)
