"""Baseline tái lập cho PPE Native Viewer trước khi thay kiến trúc.

Script chạy probe Rust theo process riêng để đo cold-open thật, rồi chạy nhiều lượt
warm trong cùng RenderSession. Nó không mở PrynX, không đổi engine và không chứa PDF
khách trong repo. Kết quả chỉ ghi hash, kích thước, timing và peak RSS của process probe.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = REPO_ROOT / ".tmp" / "ppe_viewer_baseline" / "ppe-core-baseline.json"
DEFAULT_PROBE = REPO_ROOT / "print_engine" / "target" / "release" / "examples" / "perf_profile.exe"
PROBE_DEPENDENCY_SOURCES = [
    REPO_ROOT / "print_engine" / "examples" / "perf_profile.rs",
    REPO_ROOT / "print_engine" / "Cargo.toml",
    REPO_ROOT / "print_engine" / "Cargo.lock",
    REPO_ROOT / "backend" / "app" / "assets" / "icc" / "FOGRA39.icc",
    REPO_ROOT / "backend" / "app" / "assets" / "fonts" / "DejaVuSans.ttf",
]
PROBE_DEPENDENCY_TREES = [REPO_ROOT / "print_engine" / "src"]
STANDEE_SHA256 = "d3afdaa6c3940f0431fe26ea3cbeedb8e59fe85c2a802db49a95be856868f61c"
FOGRA39_SHA256 = "da2b9b593e27cba2563cbc8596071c5c8f2395d3dbb4434538bac2bc9d58ce77"
FALLBACK_FONT_SHA256 = "7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954"
MIB = 1024 * 1024


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(MIB), b""):
            digest.update(block)
    return digest.hexdigest()


def _file_identity(path: Path) -> tuple[int, int, int]:
    value = path.stat()
    return value.st_size, value.st_mtime_ns, value.st_ctime_ns


def _paths_refer_to_same_file(first: Path, second: Path) -> bool:
    first_resolved = first.expanduser().resolve()
    second_resolved = second.expanduser().resolve()
    if os.path.normcase(str(first_resolved)) == os.path.normcase(str(second_resolved)):
        return True
    try:
        return os.path.samefile(first_resolved, second_resolved)
    except (FileNotFoundError, OSError):
        return False


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _redact_report_value(value: Any, pdf_path: Path) -> Any:
    if isinstance(value, str):
        variants = sorted(
            {str(pdf_path), str(pdf_path).replace("\\", "/")},
            key=len,
            reverse=True,
        )
        result = value
        for variant in variants:
            lower = result.lower()
            target = variant.lower()
            while target and target in lower:
                index = lower.index(target)
                result = result[:index] + "<PDF_PATH>" + result[index + len(variant):]
                lower = result.lower()
        return result
    if isinstance(value, list):
        return [_redact_report_value(item, pdf_path) for item in value]
    if isinstance(value, dict):
        return {
            key: _redact_report_value(item, pdf_path)
            for key, item in value.items()
        }
    return value


def _write_report_atomic(path: Path, payload: dict[str, Any], pdf_path: Path) -> None:
    _write_json_atomic(path, _redact_report_value(payload, pdf_path))


def _probe_dependency_files() -> list[Path]:
    files = list(PROBE_DEPENDENCY_SOURCES)
    for tree in PROBE_DEPENDENCY_TREES:
        files.extend(path for path in tree.rglob("*.rs") if path.is_file())
    return sorted(set(files))


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    rank = max(0, min(len(ordered) - 1, math.ceil(percentile * len(ordered)) - 1))
    return round(ordered[rank], 3)


def _summary(values: list[float]) -> dict[str, float | int | None]:
    return {
        "count": len(values),
        "min": round(min(values), 3) if values else None,
        "p50": _percentile(values, 0.50),
        "p95": _percentile(values, 0.95),
        "max": round(max(values), 3) if values else None,
    }


def _open_process_memory_handle(pid: int) -> tuple[Any, Any, Any] | None:
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class ProcessMemoryCounters(ctypes.Structure):
            _fields_ = [
                ("cb", wintypes.DWORD),
                ("PageFaultCount", wintypes.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        psapi.GetProcessMemoryInfo.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(ProcessMemoryCounters),
            wintypes.DWORD,
        ]
        psapi.GetProcessMemoryInfo.restype = wintypes.BOOL

        handle = None
        for query in (0x1000, 0x0400):
            handle = kernel32.OpenProcess(query, False, pid)
            if handle:
                break
        if not handle:
            return None
        return handle, kernel32, (ctypes, psapi, ProcessMemoryCounters)
    except Exception:
        return None


def _read_process_memory_handle(memory_handle: tuple[Any, Any, Any]) -> tuple[int, int] | None:
    handle, _kernel32, api = memory_handle
    ctypes, psapi, counters_type = api
    counters = counters_type()
    counters.cb = ctypes.sizeof(counters)
    ok = psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb)
    if not ok:
        return None
    return int(counters.WorkingSetSize), int(counters.PeakWorkingSetSize)


def _close_process_memory_handle(memory_handle: tuple[Any, Any, Any] | None) -> None:
    if memory_handle is None:
        return
    handle, kernel32, _api = memory_handle
    kernel32.CloseHandle(handle)


def _process_memory_bytes(pid: int) -> tuple[int, int] | None:
    memory_handle = _open_process_memory_handle(pid)
    try:
        return _read_process_memory_handle(memory_handle) if memory_handle else None
    finally:
        _close_process_memory_handle(memory_handle)


def _run_probe(
    command: list[str],
    cwd: Path,
    expected_pdf_identity: tuple[int, int, int] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    started = time.perf_counter()
    process = subprocess.Popen(
        command,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    samples: list[int] = []
    windows_peaks: list[int] = []
    stop = threading.Event()
    memory_handle = _open_process_memory_handle(process.pid)

    def sample_memory() -> None:
        while not stop.is_set():
            value = _read_process_memory_handle(memory_handle) if memory_handle else None
            if value is not None:
                current, peak = value
                samples.append(current)
                windows_peaks.append(peak)
            stop.wait(0.01)

    sampler = threading.Thread(target=sample_memory, name="ppe-baseline-rss", daemon=True)
    sampler.start()
    try:
        stdout, stderr = process.communicate()
    except BaseException:
        # Chỉ dọn process probe do chính harness tạo; không chạm PrynX hay process người dùng.
        try:
            _terminate_probe_process(process)
        except Exception:
            pass
        raise
    finally:
        stop.set()
        sampler.join(timeout=1)
        _close_process_memory_handle(memory_handle)
    wall_ms = (time.perf_counter() - started) * 1000.0
    redacted_stderr_tail = _redact_report_value(stderr[-4000:], Path(command[1]))
    if process.returncode != 0:
        raise RuntimeError(
            f"probe PPE thất bại (exit {process.returncode}):\n"
            f"{redacted_stderr_tail}"
        )
    if expected_pdf_identity is not None:
        source = Path(command[1])
        current_identity = _file_identity(source)
        if current_identity != expected_pdf_identity:
            raise RuntimeError(
                "file PDF đo đã thay đổi trong lúc probe chạy; từ chối trộn revision"
            )
    lines = [line.strip() for line in stdout.splitlines() if line.strip()]
    if not lines:
        raise RuntimeError(f"probe PPE không trả JSON; stderr:\n{redacted_stderr_tail}")
    try:
        payload = json.loads(lines[-1])
    except json.JSONDecodeError as error:
        raise RuntimeError(
            f"dòng cuối probe không phải JSON: "
            f"{_redact_report_value(lines[-1][:500], Path(command[1]))}"
        ) from error
    peak_working_set = max(windows_peaks) if windows_peaks else None
    sampled_peak = max(samples) if samples else None
    memory = {
        "sampleIntervalMs": 10,
        "sampleCount": len(samples),
        "peakWorkingSetBytes": peak_working_set,
        "peakWorkingSetMiB": round(peak_working_set / MIB, 3) if peak_working_set else None,
        "sampledMaxWorkingSetBytes": sampled_peak,
        "sampledMaxWorkingSetMiB": round(sampled_peak / MIB, 3) if sampled_peak else None,
        "measurement": "windows-process-memory-counters-peak" if peak_working_set else "unavailable",
    }
    payload["processWallMs"] = round(wall_ms, 3)
    return payload, memory


def _terminate_probe_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate()


def _valid_sha256(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(
        character in "0123456789abcdef" for character in value.lower()
    )


def _assert_file_revision(
    path: Path,
    expected_identity: tuple[int, int, int],
    expected_sha256: str,
    label: str,
) -> None:
    if _file_identity(path) != expected_identity or _sha256_file(path) != expected_sha256:
        raise RuntimeError(f"{label} đã thay đổi trong lúc chạy baseline; từ chối trộn revision")


def _probe_render_signature(probe: dict[str, Any]) -> tuple[int, int, int, int, int]:
    fields = ("width", "height", "rgb_bytes", "png_bytes", "checksum")
    values = tuple(probe.get(field) for field in fields)
    if not all(isinstance(value, int) and value >= 0 for value in values):
        raise RuntimeError("probe PPE trả render signature không hợp lệ")
    return values


def _validate_probe_memory(memory: dict[str, Any]) -> None:
    if (
        memory.get("measurement") != "windows-process-memory-counters-peak"
        or memory.get("sampleCount", 0) < 1
        or not isinstance(memory.get("peakWorkingSetBytes"), int)
        or memory["peakWorkingSetBytes"] <= 0
    ):
        raise RuntimeError("không lấy được peak working set Windows của process probe")


def _validate_cross_run_signature(runs: list[dict[str, Any]], probe: dict[str, Any]) -> None:
    if runs and _probe_render_signature(runs[0]["probe"]) != _probe_render_signature(probe):
        raise RuntimeError("kết quả PPE không ổn định giữa các process cold")


def _probe_command(args: argparse.Namespace, pdf: Path) -> list[str]:
    return [
        str(args.probe),
        str(pdf),
        str(args.dpi),
        str(args.warm_repeats),
        args.clip,
        str(args.render_budget_mib),
        str(args.resource_cache_budget_mib),
    ]


def _expected_probe_run() -> dict[str, Any]:
    return {
        "probe": {
            "open_wall_ms": 11,
            "open": {"file_ms": 1, "parse_ms": 2, "resource_ms": 3, "color_ms": 4},
            "width": 100,
            "height": 200,
            "rgb_bytes": 60_000,
            "png_bytes": 1_000,
            "checksum": 123,
            "samples": [
                {"total_wall_ms": 20, "open_ms": 0, "parse_ms": 0, "resource_ms": 1,
                 "raster_ms": 10, "color_ms": 5, "checksum_ms": 1, "encode_ms": 3},
                {"total_wall_ms": 12, "open_ms": 0, "parse_ms": 0, "resource_ms": 1,
                 "raster_ms": 5, "color_ms": 3, "checksum_ms": 1, "encode_ms": 2},
            ],
        },
        "memory": {"peakWorkingSetMiB": 100},
    }


def _aggregate(runs: list[dict[str, Any]]) -> dict[str, Any]:
    cold_open = [float(run["probe"]["open_wall_ms"]) for run in runs]
    first_render = [float(run["probe"]["samples"][0]["total_wall_ms"]) for run in runs]
    warm_render = [
        float(sample["total_wall_ms"])
        for run in runs
        for sample in run["probe"]["samples"][1:]
    ]
    open_stage_names = ["file_ms", "parse_ms", "resource_ms", "color_ms"]
    render_stage_names = [
        "open_ms",
        "parse_ms",
        "resource_ms",
        "raster_ms",
        "color_ms",
        "checksum_ms",
        "encode_ms",
    ]
    open_stages: dict[str, Any] = {}
    for name in open_stage_names:
        open_stages[name] = _summary(
            [float(run["probe"]["open"][name]) for run in runs]
        )
    render_stages: dict[str, Any] = {}
    for name in render_stage_names:
        values = [
            float(sample[name])
            for run in runs
            for sample in run["probe"]["samples"]
        ]
        render_stages[name] = _summary(values)
    first_render_stages = {
        name: _summary(
            [float(run["probe"]["samples"][0][name]) for run in runs]
        )
        for name in render_stage_names
    }
    warm_render_stages = {
        name: _summary(
            [
                float(sample[name])
                for run in runs
                for sample in run["probe"]["samples"][1:]
            ]
        )
        for name in render_stage_names
    }
    return {
        "coldSessionOpenMs": _summary(cold_open),
        "firstRenderMs": _summary(first_render),
        "warmRenderMs": _summary(warm_render),
        "openStageMs": open_stages,
        "renderStageMs": render_stages,
        "firstRenderStageMs": first_render_stages,
        "warmRenderStageMs": warm_render_stages,
        "peakWorkingSetMiB": _summary(
            [
                float(run["memory"]["peakWorkingSetMiB"])
                for run in runs
                if run["memory"]["peakWorkingSetMiB"] is not None
            ]
        ),
    }


def _build_report(
    args: argparse.Namespace,
    pdf: Path,
    sha256: str,
    probe_dependencies: list[Path],
    runs: list[dict[str, Any]],
    *,
    complete: bool,
    failure: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schemaVersion": 2,
        "scope": "ppe-core-baseline-not-end-to-end-viewer",
        "timingUnit": "ms",
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "complete": complete,
        "failure": failure,
        "artifact": {
            "name": pdf.name,
            "sizeBytes": pdf.stat().st_size,
            "sha256": sha256,
            "pathStored": False,
            "matchesAuditedStandee": sha256 == STANDEE_SHA256,
        },
        "probe": {
            "name": args.probe.name,
            "sizeBytes": args.probe.stat().st_size,
            "sha256": _sha256_file(args.probe),
            "freshAgainstFileCount": len(probe_dependencies),
            "freshAgainstTrees": [
                str(path.relative_to(REPO_ROOT)).replace("\\", "/")
                for path in PROBE_DEPENDENCY_TREES
            ],
            "freshAgainstExplicit": [
                str(path.relative_to(REPO_ROOT)).replace("\\", "/")
                for path in PROBE_DEPENDENCY_SOURCES
            ],
        },
        "config": {
            "coldRuns": args.cold_runs,
            "renderRepeatsPerSession": args.warm_repeats,
            "warmSamplesPerSession": args.warm_repeats - 1,
            "dpi": args.dpi,
            "clip": args.clip,
            "cargoProfile": "release",
            "productionBuild": False,
            "probeBinary": args.probe.name,
            "renderBudgetBytes": args.render_budget_mib * MIB,
            "resourceCacheBudgetBytes": args.resource_cache_budget_mib * MIB,
            "budgetSource": "explicit-probe-arguments-not-runtime-policy",
            "pngEncodeMeasurement": "flate2-rgb-png-proxy-not-runtime-image-png-encoder",
        },
        "summary": _aggregate(runs),
        "runs": runs,
        "limitations": [
            "Không đo bootstrap/IPC/Blob/WebView decode/compositor.",
            "Peak RSS chỉ thuộc process probe PPE, không phải toàn cây ứng dụng.",
            "FSP/FCVF và blank-gap phải lấy từ harness WebView riêng.",
            "encode_ms là PNG proxy RGB/flate2, không phải Image::PngEncoder của worker runtime.",
            "Cold ở đây là process/RenderSession mới; không xóa cache file của Windows.",
        ],
    }


def _write_checkpoint_preserving_error(
    path: Path,
    report: dict[str, Any],
    run_error: Exception,
    pdf_path: Path,
) -> None:
    try:
        _write_report_atomic(path, report, pdf_path)
    except Exception as report_error:
        if sys.version_info >= (3, 11):
            raise ExceptionGroup(
                "probe thất bại và không ghi được report checkpoint",
                [run_error, report_error],
            ) from run_error
        raise RuntimeError(
            f"probe thất bại ({run_error}); đồng thời không ghi được report ({report_error})"
        ) from run_error


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "pdf",
        type=Path,
        nargs="?",
        help="PDF cần đo; file không được chép vào repo",
    )
    parser.add_argument("--cold-runs", type=int, default=30)
    parser.add_argument("--warm-repeats", type=int, default=2)
    parser.add_argument("--dpi", type=float, default=96.0)
    parser.add_argument("--clip", default="full", help="full hoặc x,y,width,height")
    parser.add_argument(
        "--render-budget-mib",
        type=int,
        default=1536,
        help="ngân sách buffer/scratch của một lượt render probe; không đổi policy app",
    )
    parser.add_argument(
        "--resource-cache-budget-mib",
        type=int,
        default=512,
        help="ngân sách cache resource trong RenderSession probe",
    )
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--probe",
        type=Path,
        default=DEFAULT_PROBE,
        help="binary perf_profile release đã build sẵn; script không tự build",
    )
    parser.add_argument(
        "--require-standee-hash",
        action="store_true",
        help="từ chối file không khớp Standee đã audit",
    )
    parser.add_argument("--self-test", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args(argv)


def self_test() -> int:
    assert _percentile([1, 2, 3, 4], 0.5) == 2
    assert _percentile([1, 2, 3, 4], 0.95) == 4
    assert _summary([])["p95"] is None
    runs = [_expected_probe_run()]
    aggregated = _aggregate(runs)
    assert aggregated["openStageMs"]["parse_ms"]["p50"] == 2
    assert aggregated["renderStageMs"]["parse_ms"]["p50"] == 0
    assert aggregated["firstRenderStageMs"]["raster_ms"]["p50"] == 10
    assert aggregated["warmRenderStageMs"]["raster_ms"]["p50"] == 5
    assert _paths_refer_to_same_file(Path("same.pdf"), Path("same.pdf"))
    assert _valid_sha256(STANDEE_SHA256) and not _valid_sha256("abc")
    assert _probe_render_signature(runs[0]["probe"]) == (100, 200, 60_000, 1_000, 123)
    _validate_cross_run_signature(runs, runs[0]["probe"])
    try:
        _validate_cross_run_signature(runs, {**runs[0]["probe"], "checksum": 124})
    except RuntimeError:
        pass
    else:
        raise AssertionError("cross-run signature mismatch phải fail")
    _validate_probe_memory({
        "measurement": "windows-process-memory-counters-peak",
        "sampleCount": 1,
        "peakWorkingSetBytes": 1,
    })
    try:
        _validate_probe_memory({"measurement": "unavailable", "sampleCount": 0})
    except RuntimeError:
        pass
    else:
        raise AssertionError("thiếu peak working set phải fail")
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory) / "report.json"
        _write_json_atomic(output, {"complete": False, "runs": runs})
        assert json.loads(output.read_text(encoding="utf-8"))["runs"][0]["probe"]["open_wall_ms"] == 11
        fake_process = object.__new__(subprocess.Popen)
        termination_calls: list[str] = []
        fake_process.returncode = None
        fake_process.poll = lambda: fake_process.returncode
        fake_process.terminate = lambda: termination_calls.append("terminate")
        fake_process.kill = lambda: termination_calls.append("kill")

        def fake_communicate(timeout: float | None = None) -> tuple[str, str]:
            if timeout is not None:
                raise subprocess.TimeoutExpired("probe", timeout)
            fake_process.returncode = -9
            return "", ""

        fake_process.communicate = fake_communicate
        _terminate_probe_process(fake_process)
        assert termination_calls == ["terminate", "kill"]
        sensitive_pdf = Path(directory) / "Khach Hang" / "standee.pdf"
        redacted = _redact_report_value(
            {"failure": {"message": f"không mở được {sensitive_pdf}"}},
            sensitive_pdf,
        )
        assert str(sensitive_pdf) not in redacted["failure"]["message"]
        assert "<PDF_PATH>" in redacted["failure"]["message"]
    dependency_files = _probe_dependency_files()
    assert PROBE_DEPENDENCY_SOURCES[0] in dependency_files
    assert any(path.name == "session.rs" for path in dependency_files)
    if os.name == "nt":
        memory = _process_memory_bytes(os.getpid())
        assert memory is not None and memory[0] > 0 and memory[1] >= memory[0]
    print(json.dumps({"ok": True, "schemaVersion": 2}))
    return 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.self_test:
        return self_test()
    if args.pdf is None:
        raise ValueError("thiếu đường dẫn PDF cần đo")
    raw_pdf = args.pdf.expanduser()
    raw_output = args.output.expanduser()
    if _paths_refer_to_same_file(raw_pdf, raw_output):
        raise ValueError("output baseline không được trùng file PDF đầu vào")
    args.output = raw_output.resolve()
    pdf = raw_pdf.resolve()
    if not pdf.is_file():
        raise FileNotFoundError(f"không tìm thấy PDF: {pdf}")
    if args.cold_runs < 30 or args.warm_repeats < 2:
        raise ValueError("baseline chính thức cần cold-runs >=30 và warm-repeats >=2")
    if not math.isfinite(args.dpi) or not 24 <= args.dpi <= 9600:
        raise ValueError("dpi phải là số hữu hạn trong miền PPE 24..9600")
    expected_clip: dict[str, int] | None = None
    if args.clip != "full":
        parts = args.clip.split(",")
        if len(parts) != 4:
            raise ValueError("clip phải là full hoặc x,y,width,height")
        try:
            x, y, width, height = (int(part.strip()) for part in parts)
        except ValueError as error:
            raise ValueError("clip phải là full hoặc x,y,width,height nguyên") from error
        if min(x, y) < 0 or not 1 <= width <= 4000 or not 1 <= height <= 4000:
            raise ValueError("clip cần x/y >=0 và width/height trong 1..4000")
        expected_clip = {"x": x, "y": y, "width": width, "height": height}
    if args.render_budget_mib < 1 or args.resource_cache_budget_mib < 0:
        raise ValueError("render-budget-mib phải >=1 và resource-cache-budget-mib phải >=0")
    args.probe = args.probe.expanduser().resolve()
    if not args.probe.is_file():
        raise FileNotFoundError(
            "không tìm thấy binary perf_profile release đã build sẵn; "
            "harness sẽ không tự build khi chưa được phép"
        )
    probe_identity = _file_identity(args.probe)
    probe_sha256 = _sha256_file(args.probe)
    probe_dependencies = _probe_dependency_files()
    newest_probe_source = max(path.stat().st_mtime_ns for path in probe_dependencies)
    if newest_probe_source > args.probe.stat().st_mtime_ns:
        raise RuntimeError(
            "binary perf_profile cũ hơn source Lô 0A; từ chối lấy baseline giả. "
            "Cần được phép compile riêng probe trước khi chạy."
        )
    if _sha256_file(PROBE_DEPENDENCY_SOURCES[3]) != FOGRA39_SHA256:
        raise RuntimeError("FOGRA39 trong worktree không khớp fingerprint baseline")
    if _sha256_file(PROBE_DEPENDENCY_SOURCES[4]) != FALLBACK_FONT_SHA256:
        raise RuntimeError("font dự phòng trong worktree không khớp fingerprint baseline")
    _assert_file_revision(args.probe, probe_identity, probe_sha256, "Binary perf_profile")
    pdf_identity = _file_identity(pdf)
    sha256 = _sha256_file(pdf)
    if _file_identity(pdf) != pdf_identity:
        raise RuntimeError("file PDF đo đã thay đổi trong lúc fingerprint")
    if args.require_standee_hash and sha256 != STANDEE_SHA256:
        raise ValueError(f"SHA-256 không khớp Standee audit: {sha256}")

    runs: list[dict[str, Any]] = []
    current_index = 0
    _write_report_atomic(
        args.output,
        _build_report(
            args,
            pdf,
            sha256,
            probe_dependencies,
            runs,
            complete=False,
        ),
        pdf,
    )
    try:
        for index in range(args.cold_runs):
            current_index = index
            _run_and_validate_probe(
                args,
                pdf,
                expected_clip,
                pdf_identity,
                probe_identity,
                probe_sha256,
                runs,
                index,
            )
            _write_report_atomic(
                args.output,
                _build_report(
                    args,
                    pdf,
                    sha256,
                    probe_dependencies,
                    runs,
                    complete=False,
                ),
                pdf,
            )
        if _file_identity(pdf) != pdf_identity:
            raise RuntimeError("file PDF đo đã thay đổi trước khi chốt baseline")
        if _sha256_file(pdf) != sha256:
            raise RuntimeError("nội dung PDF đo đã thay đổi trước khi chốt baseline")
        _assert_file_revision(args.probe, probe_identity, probe_sha256, "Binary perf_profile")
    except BaseException as error:
        failure_report = _build_report(
            args,
            pdf,
            sha256,
            probe_dependencies,
            runs,
            complete=False,
            failure={
                "message": str(error),
                "failedRun": current_index + 1,
                "completedRuns": len(runs),
                "interrupted": not isinstance(error, Exception),
            },
        )
        if isinstance(error, Exception):
            _write_checkpoint_preserving_error(
                args.output,
                failure_report,
                error,
                pdf,
            )
        else:
            _write_report_atomic(args.output, failure_report, pdf)
        raise

    report = _build_report(
        args,
        pdf,
        sha256,
        probe_dependencies,
        runs,
        complete=len(runs) == args.cold_runs,
    )
    _write_report_atomic(args.output, report, pdf)
    print(json.dumps({"output": str(args.output), "summary": report["summary"]}, ensure_ascii=False))
    return 0


def _run_and_validate_probe(
    args: argparse.Namespace,
    pdf: Path,
    expected_clip: dict[str, int] | None,
    expected_pdf_identity: tuple[int, int, int],
    expected_probe_identity: tuple[int, int, int],
    expected_probe_sha256: str,
    runs: list[dict[str, Any]],
    index: int,
) -> None:
    current_identity = _file_identity(pdf)
    if current_identity != expected_pdf_identity:
        raise RuntimeError("file PDF đo đã thay đổi giữa các cold run")
    _assert_file_revision(
        args.probe,
        expected_probe_identity,
        expected_probe_sha256,
        "Binary perf_profile",
    )
    probe, memory = _run_probe(
        _probe_command(args, pdf),
        REPO_ROOT / "print_engine",
        expected_pdf_identity,
    )
    _assert_file_revision(
        args.probe,
        expected_probe_identity,
        expected_probe_sha256,
        "Binary perf_profile",
    )
    _validate_probe_memory(memory)
    if probe.get("schema_version") != 2:
        raise RuntimeError("probe PPE không đúng schema 2 của Lô 0A")
    expected_budgets = {
        "render_bytes": args.render_budget_mib * MIB,
        "resource_cache_bytes": args.resource_cache_budget_mib * MIB,
    }
    if probe.get("budgets") != expected_budgets:
        raise RuntimeError(
            f"probe PPE báo ngân sách sai: {probe.get('budgets')} != {expected_budgets}"
        )
    if probe.get("source_name") != pdf.name or probe.get("page") != 1:
        raise RuntimeError("probe PPE báo sai artifact hoặc trang đo")
    if not isinstance(probe.get("open_wall_ms"), (int, float)) or probe["open_wall_ms"] < 0:
        raise RuntimeError("probe PPE trả open_wall_ms không hợp lệ")
    open_stages = probe.get("open")
    if not isinstance(open_stages, dict) or any(
        not isinstance(open_stages.get(field), (int, float)) or open_stages[field] < 0
        for field in ("total_ms", "file_ms", "parse_ms", "resource_ms", "color_ms")
    ):
        raise RuntimeError("probe PPE trả timing pha mở không hợp lệ")
    try:
        reported_dpi = float(probe.get("dpi", -1))
    except (TypeError, ValueError) as error:
        raise RuntimeError("probe PPE báo DPI không phải số") from error
    if not math.isclose(reported_dpi, args.dpi, rel_tol=0, abs_tol=0.001):
        raise RuntimeError(f"probe PPE báo DPI sai: {probe.get('dpi')} != {args.dpi}")
    if probe.get("clip") != expected_clip or probe.get("repeats") != args.warm_repeats:
        raise RuntimeError("probe PPE báo sai clip hoặc số lượt warm")
    viewer_options = probe.get("viewer_options")
    expected_viewer_options = {
        "profile": "FOGRA39",
        "profile_sha256": FOGRA39_SHA256,
        "intent": "relative",
        "optional_content": "view",
        "annotations": True,
        "overprint_simulation": False,
        "fallback_font": "DejaVuSans.ttf",
        "fallback_font_bytes": 757076,
        "fallback_font_sha256": FALLBACK_FONT_SHA256,
    }
    if viewer_options != expected_viewer_options:
        raise RuntimeError("probe PPE không công khai đúng Viewer options")
    encode = probe.get("encode")
    if encode != {"kind": "flate2-rgb-png-proxy", "runtime_equivalent": False}:
        raise RuntimeError("probe PPE gắn nhãn PNG proxy không đúng hợp đồng")
    samples = probe.get("samples")
    if not isinstance(samples, list) or len(samples) != args.warm_repeats:
        raise RuntimeError("probe PPE không trả đủ sample warm")
    for sample_index, sample in enumerate(samples, start=1):
        if sample.get("iteration") != sample_index:
            raise RuntimeError("probe PPE trả thứ tự sample không liên tục")
        for field in (
            "render_wall_ms", "open_ms", "parse_ms", "resource_ms", "raster_ms",
            "color_ms", "checksum_ms", "encode_ms", "total_wall_ms",
        ):
            if not isinstance(sample.get(field), (int, float)) or sample[field] < 0:
                raise RuntimeError(f"probe PPE trả timing {field} không hợp lệ")
        if sample.get("width", 0) <= 0 or sample.get("height", 0) <= 0:
            raise RuntimeError("probe PPE trả kích thước bitmap không hợp lệ")
        if sample.get("rgb_bytes") != sample["width"] * sample["height"] * 3:
            raise RuntimeError("probe PPE trả kích thước RGB không khớp bitmap")
        cache = sample.get("cache")
        if sample.get("png_bytes", 0) <= 0 or not isinstance(cache, dict):
            raise RuntimeError("probe PPE thiếu PNG/cache stats")
        if cache.get("budget_bytes") != expected_budgets["resource_cache_bytes"]:
            raise RuntimeError("probe PPE trả cache budget sai trong sample")
    signatures = {
        (
            sample.get("width"),
            sample.get("height"),
            sample.get("rgb_bytes"),
            sample.get("png_bytes"),
        )
        for sample in samples
    }
    if len(signatures) != 1:
        raise RuntimeError("probe PPE trả hình học/byte count không ổn định giữa first/warm")
    render_signature = _probe_render_signature(probe)
    _validate_cross_run_signature(runs, probe)
    final_sample = samples[-1]
    if probe.get("width") != final_sample["width"] or probe.get("height") != final_sample["height"]:
        raise RuntimeError("probe PPE trả kích thước tổng kết không khớp sample cuối")
    if probe.get("rgb_bytes") != final_sample["rgb_bytes"]:
        raise RuntimeError("probe PPE trả RGB tổng kết không khớp sample cuối")
    if probe.get("png_bytes") != final_sample["png_bytes"]:
        raise RuntimeError("probe PPE trả PNG tổng kết không khớp sample cuối")
    runs.append({"index": index + 1, "probe": probe, "memory": memory})
    print(
        f"[{index + 1}/{args.cold_runs}] open={probe['open_wall_ms']:.1f} ms "
        f"first={probe['samples'][0]['total_wall_ms']:.1f} ms "
        f"rss={memory['peakWorkingSetMiB']} MiB",
        file=sys.stderr,
    )

if __name__ == "__main__":
    raise SystemExit(main())
