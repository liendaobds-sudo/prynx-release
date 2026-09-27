"""Đo worker thật, không mở GUI và không sửa PDF/source ứng dụng.

Chạy bằng backend/venv/Scripts/python.exe. Cold là process/session mới, không
xóa cache filesystem Windows. Kết quả không phải input-to-screen/60fps.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import queue
import struct
import subprocess
import sys
import threading
import time
from typing import Any, BinaryIO, Callable
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[3]
EXPECTED_EXE_SHA256 = "4c7a8b752494925df574e2e34ac68fde99fde6e23d6206fb2d5f3308d67f8dc4"
ACCURATE_PIPELINE = "ppe-fogra39-relative-view-knockout-png-v5-native-worker"
DISPLAY_PIPELINE = "pdfium-display-png-v1"
TILE_VERSION = "v10_view_semantics_opaque_white_png"
PREFIX = struct.Struct("<4sHHQIQ")
MAX_HEADER = 64 * 1024
MAX_PPE_PAYLOAD = 512 * 1024 * 1024


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def stamp(path: Path) -> dict[str, Any]:
    value = path.stat()
    created_ns = getattr(value, "st_birthtime_ns", value.st_ctime_ns)
    return {"path": str(path), "size_bytes": str(value.st_size),
            "modified_nanos": str(value.st_mtime_ns), "created_nanos": str(created_ns),
            "token": f"{value.st_size}:{value.st_mtime_ns}:{created_ns}"}


def read_exact(stream: BinaryIO, length: int) -> bytes:
    parts = bytearray()
    while len(parts) < length:
        chunk = stream.read(length - len(parts))
        if not chunk:
            raise EOFError(f"Pipe kết thúc khi còn thiếu {length - len(parts)} byte")
        parts.extend(chunk)
    return bytes(parts)


class Child:
    """Chỉ sở hữu và dọn process được chính instance này tạo."""

    def __init__(self, exe: Path, arguments: list[str], timeout: float):
        started = time.perf_counter_ns()
        self.proc = subprocess.Popen(
            [str(exe), *arguments], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, cwd=ROOT / "desktop" / "src-tauri",
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        self.spawn_ms = (time.perf_counter_ns() - started) / 1e6
        self.timeout = timeout
        self.stderr_tail = bytearray()
        self.reader = threading.Thread(target=self._drain_stderr, daemon=True)
        self.reader.start()

    def _drain_stderr(self) -> None:
        assert self.proc.stderr is not None
        while chunk := self.proc.stderr.read(4096):
            self.stderr_tail.extend(chunk)
            if len(self.stderr_tail) > MAX_HEADER:
                del self.stderr_tail[:-MAX_HEADER]

    def bounded(self, operation: Callable[[], Any]) -> tuple[Any, float]:
        result: queue.Queue[tuple[bool, Any]] = queue.Queue(maxsize=1)

        def run() -> None:
            try:
                result.put((True, operation()))
            except BaseException as error:
                result.put((False, error))

        started = time.perf_counter_ns()
        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        try:
            ok, value = result.get(timeout=self.timeout)
        except queue.Empty as error:
            self.kill_owned()
            worker.join(timeout=2)
            raise TimeoutError(f"Worker riêng PID {self.proc.pid} quá {self.timeout:g}s") from error
        wall_ms = (time.perf_counter_ns() - started) / 1e6
        worker.join(timeout=2)
        if not ok:
            raise value
        return value, wall_ms

    def kill_owned(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(timeout=5)

    def close(self) -> None:
        if self.proc.stdin is not None and not self.proc.stdin.closed:
            try:
                self.proc.stdin.close()
            except OSError:
                pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.kill_owned()
        self.reader.join(timeout=2)
        for stream in (self.proc.stdout, self.proc.stderr):
            if stream is not None:
                stream.close()


def scene_exchange(child: Child, request: dict[str, Any]) -> dict[str, Any]:
    assert child.proc.stdin is not None and child.proc.stdout is not None
    request_bytes = json.dumps(request, separators=(",", ":")).encode()
    child.proc.stdin.write(struct.pack("<I", len(request_bytes)) + request_bytes)
    child.proc.stdin.flush()
    length = struct.unpack("<I", read_exact(child.proc.stdout, 4))[0]
    if not 0 < length <= MAX_HEADER:
        raise ValueError(f"Header scene sai: {length}")
    reply = json.loads(read_exact(child.proc.stdout, length))
    if reply.get("error"):
        raise RuntimeError(f"Scene worker: {reply['error']}")
    prefix = read_exact(child.proc.stdout, 16)
    magic, json_length = struct.unpack("<8sQ", prefix)
    if magic != b"PPEIR003" or not 0 < json_length <= MAX_PPE_PAYLOAD:
        raise ValueError("Scene packet sai phiên bản/độ dài")
    metadata_bytes = read_exact(child.proc.stdout, json_length)
    decode_started = time.perf_counter_ns()
    metadata = json.loads(metadata_bytes)
    decode_ms = (time.perf_counter_ns() - decode_started) / 1e6
    if metadata["revision"] != request["revision"]:
        raise ValueError("Scene trả sai revision")
    digest = hashlib.sha256()
    hash_started = time.perf_counter_ns()
    digest.update(prefix)
    digest.update(metadata_bytes)
    hash_ns = time.perf_counter_ns() - hash_started
    wire_bytes = len(prefix) + len(metadata_bytes)
    planes = []
    for resource in metadata["images"]:
        lengths_raw = read_exact(child.proc.stdout, 24)
        samples, stencil, alpha = struct.unpack("<QQQ", lengths_raw)
        pixels = resource["width"] * resource["height"]
        if (samples != pixels * resource["n_comps"]
                or stencil not in (0, pixels) or alpha not in (0, pixels)):
            raise ValueError("Payload ảnh scene không khớp kích thước metadata")
        remaining = samples + stencil + 4 * alpha
        if remaining > 8 * 1024 * 1024 * 1024:
            raise ValueError("Payload chẩn đoán vượt 8 GiB, cần chọn harness khác")
        hash_started = time.perf_counter_ns()
        digest.update(lengths_raw)
        hash_ns += time.perf_counter_ns() - hash_started
        wire_bytes += len(lengths_raw) + remaining
        while remaining:
            chunk = read_exact(child.proc.stdout, min(1024 * 1024, remaining))
            hash_started = time.perf_counter_ns()
            digest.update(chunk)
            hash_ns += time.perf_counter_ns() - hash_started
            remaining -= len(chunk)
        planes.append({"width": resource["width"], "height": resource["height"],
                       "n_comps": resource["n_comps"], "samples_bytes": samples,
                       "stencil_bytes": stencil, "alpha_bytes": 4 * alpha})
    server_wire_timing = None
    if reply.get("phase_timings"):
        trailer_length = struct.unpack("<I", read_exact(child.proc.stdout, 4))[0]
        if not 0 < trailer_length <= MAX_HEADER:
            raise ValueError("Trailer telemetry scene sai độ dài")
        server_wire_timing = json.loads(read_exact(child.proc.stdout, trailer_length))
    return {"reply": reply, "server_wire_timing": server_wire_timing, "scene_wire_bytes": wire_bytes,
            "reply_header_bytes": length + 4, "scene_metadata_bytes": json_length,
            "scene_wire_sha256": digest.hexdigest(), "scene_images": planes,
            "scene_commands": len(metadata["commands"]), "scene_clips": len(metadata["clips"]),
            "scene_masks": len(metadata["masks"]), "scene_bounds": metadata["bounds"],
            "scene_warnings": metadata["warnings"], "probe_json_decode_ms": decode_ms,
            "probe_hash_ms": hash_ns / 1e6}


def ppe_exchange(child: Child, wire_id: int, request: dict[str, Any]) -> tuple[dict[str, Any], bytes]:
    assert child.proc.stdin is not None and child.proc.stdout is not None
    header = json.dumps(request, separators=(",", ":")).encode()
    child.proc.stdin.write(PREFIX.pack(b"PXRW", 4, 1, wire_id, len(header), 0) + header)
    child.proc.stdin.flush()
    magic, version, kind, response_id, header_length, payload_length = PREFIX.unpack(
        read_exact(child.proc.stdout, PREFIX.size))
    if ((magic, version, kind, response_id) != (b"PXRW", 4, 2, wire_id)
            or not 0 < header_length <= MAX_HEADER or payload_length > MAX_PPE_PAYLOAD):
        raise ValueError("Frame PPE sai identity/phiên bản/độ dài")
    response = json.loads(read_exact(child.proc.stdout, header_length))
    payload = read_exact(child.proc.stdout, payload_length)
    return response, payload


def file_manifest(paths: list[Path]) -> list[dict[str, Any]]:
    return [{**stamp(path), "sha256": sha256_file(path)} for path in paths]


def checkpoint(path: Path, report: dict[str, Any]) -> None:
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


def self_test() -> int:
    """Kiểm framing bằng byte giả; không spawn worker hoặc benchmark."""
    reply = json.dumps({"error": None, "stats": {"parse_us": 0, "compile_us": 0}}).encode()
    metadata = json.dumps({"revision": 1, "images": [{"width": 1, "height": 1, "n_comps": 4}],
                           "commands": [], "clips": [], "masks": [], "bounds": {}, "warnings": {}}).encode()
    wire = b"PPEIR003" + struct.pack("<Q", len(metadata)) + metadata + struct.pack("<QQQ", 4, 0, 1) + bytes(4) + struct.pack("<f", 1.0)
    child = SimpleNamespace(proc=SimpleNamespace(stdin=io.BytesIO(), stdout=io.BytesIO(struct.pack("<I", len(reply)) + reply + wire)))
    result = scene_exchange(child, {"revision": 1})
    assert result["scene_wire_bytes"] == len(wire)
    assert result["scene_wire_sha256"] == hashlib.sha256(wire).hexdigest()
    header = json.dumps({"message": "pong", "nonce": "test"}).encode()
    child.proc.stdout = io.BytesIO(PREFIX.pack(b"PXRW", 4, 2, 7, len(header), 3) + header + b"abc")
    response, payload = ppe_exchange(child, 7, {"message": "ping", "nonce": "test"})
    assert response["nonce"] == "test" and payload == b"abc"
    try:
        read_exact(io.BytesIO(b"a"), 2)
    except EOFError:
        pass
    else:
        raise AssertionError("Phải từ chối frame bị cắt")
    print(json.dumps({"self_test": "passed", "spawned_children": 0}))
    return 0


def run(args: argparse.Namespace) -> int:
    pdf, exe, output = args.pdf.resolve(), args.exe.resolve(), args.output.resolve()
    if os.name != "nt":
        raise RuntimeError("Probe này kiểm identity file trên Windows thật")
    if not pdf.is_file() or not exe.is_file() or output in (pdf, exe):
        raise ValueError("Đường dẫn input/exe/output không hợp lệ")
    if output.exists():
        raise FileExistsError("Không ghi đè artifact audit có sẵn; chọn --output mới")
    exe_hash = sha256_file(exe)
    if exe_hash != args.expected_exe_sha256.lower():
        raise ValueError(f"EXE thay đổi: {exe_hash}; cần xác minh provenance rồi truyền hash mới")
    output.mkdir(parents=True, exist_ok=False)
    input_identity = stamp(pdf)
    source_paths = [ROOT / path for path in (
        "desktop/src-tauri/src/main.rs", "desktop/src-tauri/src/lib.rs",
        "desktop/src-tauri/src/viewport/scene_worker.rs",
        "desktop/src-tauri/src/pdf_engine/render_worker.rs",
        "desktop/src-tauri/src/pdf_engine/render_worker/work_queue.rs",
        "print_engine/src/scene/wire.rs", "print_engine/src/image/sampler.rs",
        "print_engine/src/content/retained.rs", "print_engine/src/session.rs",
        "print_engine/src/page.rs", "print_engine/src/color/icc.rs")]
    report: dict[str, Any] = {
        "schema_version": 1, "scope": "existing-debug-exe-worker-headless-not-ui",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "complete": False,
        "input": {**input_identity, "sha256": sha256_file(pdf)},
        "exe": {**stamp(exe), "sha256": exe_hash},
        "source_manifest": file_manifest(source_paths),
        "icc": file_manifest([ROOT / "backend/app/assets/icc/FOGRA39.icc"])[0],
        "harness": file_manifest([Path(__file__).resolve()])[0],
        "config": {"fresh_children_per_mode": args.runs, "requests_per_child": args.repeats,
                   "dpi": args.dpi, "page": args.page, "timeout_seconds": args.timeout},
        "scene": [], "ppe": [],
        "limitations": [
            "Không đo GPU upload/present, WebView hay input-to-screen; không chứng minh 60fps.",
            "Cold là process/session mới; không xóa cache filesystem Windows.",
            "Source manifest không chứng minh EXE được build từ đúng source hiện tại.",
            "Scene residual gồm init màu, serialize/pipe/probe decode/hash; không gọi là IPC thuần.",
            "Scene consumer Python chỉ consume/validate wire, không dựng RetainedPage host Rust.",
            "PPE total_ms nội bộ chưa tách cold-open, pool-lock, raster và quy màu đầy đủ.",
            "PPE Hello vẫn khởi tạo/hash PDFium; được ghi riêng, không nhập vào raster.",
            "N nhỏ chỉ là probe; không dùng làm P95/P99 có ý nghĩa thống kê.",
        ],
    }
    report_path = output / "worker-probe.json"
    checkpoint(report_path, report)
    try:
        for mode in ("scene", "ppe"):
            for run_index in range(1, args.runs + 1):
                if stamp(pdf) != input_identity or sha256_file(exe) != exe_hash:
                    raise RuntimeError("PDF/EXE thay đổi giữa các lượt đo")
                arguments = (["--prynx-scene-worker", "--prynx-scene-session"]
                             if mode == "scene" else ["--prynx-render-worker"])
                child = Child(exe, arguments, args.timeout)
                run_result: dict[str, Any] = {"run": run_index, "pid": child.proc.pid,
                                             "spawn_ms": child.spawn_ms, "arguments": arguments,
                                             "samples": []}
                report[mode].append(run_result)
                try:
                    if mode == "ppe":
                        hello = {"message": "hello", "request_id": f"audit-hello-{run_index}",
                                 "parent_pid": os.getpid(), "nonce": f"audit-{os.getpid()}-{run_index}",
                                 "expected_app_version": "2.0.4",
                                 "expected_tile_cache_version": TILE_VERSION,
                                 "expected_pipeline_identity": DISPLAY_PIPELINE}
                        (response, payload), wall = child.bounded(lambda: ppe_exchange(child, 1, hello))
                        run_result["hello"] = {"request": hello, "response": response, "wall_ms": wall}
                        if (not response.get("ok") or payload or response.get("worker_pid") != child.proc.pid
                                or response.get("nonce") != hello["nonce"] or response.get("protocol_version") != 4):
                            raise RuntimeError(f"PPE Hello không đạt: {response}")
                    for iteration in range(1, args.repeats + 1):
                        if mode == "scene":
                            request = {"path": str(pdf), "page": args.page, "revision": 1,
                                       "identity": input_identity["token"], "phase_timings": True}
                            data, wall = child.bounded(lambda: scene_exchange(child, request))
                            timing = data["reply"]["stats"]
                            data["residual_transport_ms"] = wall - (timing["parse_us"] + timing["compile_us"]) / 1000
                        else:
                            request = {"message": "render", "request_id": f"audit-ppe-{run_index}-{iteration}",
                                       "owner_id": f"audit-ppe-{run_index}", "session_owner_id": f"audit-ppe-session-{run_index}",
                                       "group_key": "audit-page1", "generation": 1, "purpose": "interactive", "priority": 0,
                                       "document": input_identity, "page": args.page, "rotation": 0,
                                       "raster": {"kind": "dpi", "dpi": args.dpi, "clip": None},
                                       "color": {"pipeline": "accurate", "profile_id": "fogra39", "intent": "relative"},
                                       "pipeline_identity": ACCURATE_PIPELINE, "soundness": "color-verified", "format": None}
                            (response, payload), wall = child.bounded(lambda: ppe_exchange(child, iteration + 1, request))
                            if (response.get("status") != "ready" or response.get("request_id") != request["request_id"]
                                    or response.get("pipeline_identity") != ACCURATE_PIPELINE
                                    or response.get("soundness") != "color-verified" or response.get("generation") != 1):
                                raise RuntimeError(f"PPE render không đạt: {response}")
                            if len(payload) < 24 or payload[:8] != b"\x89PNG\r\n\x1a\n" or payload[12:16] != b"IHDR":
                                raise ValueError("PPE không trả PNG hợp lệ")
                            dimensions = struct.unpack(">II", payload[16:24])
                            if dimensions != (response["bitmap_width"], response["bitmap_height"]):
                                raise ValueError("PNG không khớp kích thước response")
                            artifact = output / f"ppe-run-{run_index}-sample-{iteration}.png"
                            artifact.write_bytes(payload)
                            data = {"response": response, "png_bytes": len(payload), "png_sha256": hashlib.sha256(payload).hexdigest(),
                                    "png_dimensions": dimensions, "png_artifact": str(artifact),
                                    "worker_residual_ms": response["timing"]["total_ms"] - sum(
                                        response["timing"].get(field) or 0 for field in ("render_ms", "encode_ms", "cache_ms"))}
                        sample = {"iteration": iteration, "request": request, "wire_request_wall_ms": wall, **data}
                        run_result["samples"].append(sample)
                        checkpoint(report_path, report)
                        print(json.dumps({"mode": mode, "run": run_index, "iteration": iteration,
                                          "wire_request_wall_ms": wall}, ensure_ascii=False), flush=True)
                finally:
                    child.close()
                    run_result["exit_code"] = child.proc.returncode
                    run_result["stderr_tail"] = child.stderr_tail.decode("utf-8", errors="replace")
                    checkpoint(report_path, report)
        if (stamp(pdf) != input_identity or sha256_file(pdf) != report["input"]["sha256"]
                or sha256_file(exe) != exe_hash):
            raise RuntimeError("Input/EXE thay đổi trước khi chốt probe")
        report["complete"] = True
    except BaseException as error:
        report["failure"] = {"type": type(error).__name__, "message": str(error)}
        checkpoint(report_path, report)
        raise
    checkpoint(report_path, report)
    print(json.dumps({"complete": True, "report": str(report_path)}, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--pdf", type=Path, default=ROOT / "test/CMNM2026 - Giay moi_BLUE - in_OUTLINE_FONTS_5e2846.pdf")
    parser.add_argument("--exe", type=Path, default=ROOT / "desktop/src-tauri/target/debug/pdf-inspector.exe")
    parser.add_argument("--expected-exe-sha256", default=EXPECTED_EXE_SHA256)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent / "worker-probe")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--page", type=int, default=1)
    parser.add_argument("--dpi", type=float, default=96.0)
    parser.add_argument("--timeout", type=float, default=60.0)
    arguments = parser.parse_args()
    if arguments.self_test:
        raise SystemExit(self_test())
    if not 1 <= arguments.runs <= 30 or not 1 <= arguments.repeats <= 30:
        parser.error("runs/repeats cần trong 1..30 cho harness chẩn đoán")
    if arguments.page < 1 or not 24 <= arguments.dpi <= 9600 or not 1 <= arguments.timeout <= 60:
        parser.error("page/DPI/timeout ngoài miền hỗ trợ của harness")
    raise SystemExit(run(arguments))
