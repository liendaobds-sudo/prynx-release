"""Benchmark đồng thời các consumer PPE của PrynX.

Chạy từ ``backend`` bằng Python trong venv, không cần build lại native::

    python benchmarks/benchmark_ppe_concurrency.py \
        --pdf "C:\\Users\\Khanh Pham\\Desktop\\CMNM2026 - Giay moi_BLUE - in.pdf" \
        --repeats 5 --warmups 1 \
        --output ..\\.tmp\\ppe-concurrency-benchmark.json

Ba tier RAM thấp/trung/cao ở đây là **mô phỏng policy**: mỗi process nhận đúng
render budget, session cache budget và heavy-slot count mà sản phẩm sẽ chọn. Chỉ
tier cao trùng phần cứng máy audit; harness không giả vờ biến máy 32 GiB thành máy
6/12 GiB và không gọi hai tier thấp là runtime vật lý.
"""

from __future__ import annotations

import argparse
import asyncio
import ctypes
import gc
import hashlib
import json
import logging
import math
import multiprocessing
import os
from pathlib import Path
import queue
import shutil
import statistics
import sys
import tempfile
import threading
import time
import traceback
from typing import Any, Iterable

import pikepdf


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

for _stream in (sys.stdout, sys.stderr):
    _reconfigure = getattr(_stream, "reconfigure", None)
    if callable(_reconfigure):
        _reconfigure(encoding="utf-8")


# PERF (audit 2026-08-10 §PPE.SCOPE.4): policy cố định để các lần đo có thể
# đối chiếu. CPU vẫn là CPU thật của máy; low/medium chỉ mô phỏng ngân sách RAM.
TIER_SPECS: dict[str, dict[str, float | int | str]] = {
    "low": {
        "label": "<8 GiB (mô phỏng policy 6/3 GiB)",
        "total_mb": 6 * 1024,
        "available_mb": 3 * 1024,
        "heavy_slots": 1,
    },
    "medium": {
        "label": "8–15 GiB (mô phỏng policy 12/8 GiB)",
        "total_mb": 12 * 1024,
        "available_mb": 8 * 1024,
        "heavy_slots": 2,
    },
    "high": {
        "label": "≥16 GiB (policy 32/20 GiB; runtime vật lý máy audit)",
        "total_mb": 32 * 1024,
        "available_mb": 20 * 1024,
        "heavy_slots": 3,
    },
}

PAIR_TASKS: dict[str, tuple[str, str]] = {
    "viewer_export": ("viewer_zoom_stop", "export_cmyk"),
    "preview_flatten": ("output_preview", "flatten_transparency"),
    "outline_detect": ("outline_fonts", "detect_shape"),
}

CANCEL_TASKS = ("session_cancel", "file_cancel_flatten")

WORKLOAD_SPECS: dict[str, dict[str, int]] = {
    "interactive": {
        "viewer_dpi": 192,
        "export_dpi": 72,
        "preview_dpi": 72,
        "flatten_dpi": 72,
        "session_cancel_dpi": 360,
        "file_cancel_flatten_dpi": 200,
    },
    "production": {
        "viewer_dpi": 192,
        "export_dpi": 300,
        "preview_dpi": 150,
        "flatten_dpi": 300,
        "session_cancel_dpi": 360,
        "file_cancel_flatten_dpi": 300,
    },
}


def percentile(values: Iterable[float], quantile: float) -> float:
    """Nearest-rank percentile, ổn định cả khi chỉ có vài lượt đo."""
    ordered = sorted(float(value) for value in values)
    if not ordered:
        raise ValueError("Không thể tính percentile từ danh sách rỗng")
    if not 0 < quantile <= 1:
        raise ValueError("quantile phải nằm trong (0, 1]")
    rank = max(1, math.ceil(quantile * len(ordered)))
    return ordered[rank - 1]


def _round(value: float | None, digits: int = 3) -> float | None:
    return None if value is None else round(float(value), digits)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().upper()


def _rss_mb(pid: int) -> float | None:
    """RSS/working set của một process, không thêm dependency psutil."""
    if pid <= 0:
        return None
    if sys.platform == "win32":
        class _ProcessMemoryCounters(ctypes.Structure):
            _fields_ = [
                ("cb", ctypes.c_ulong),
                ("PageFaultCount", ctypes.c_ulong),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        process_query = 0x0400
        handle = ctypes.windll.kernel32.OpenProcess(process_query, False, pid)
        if not handle:
            return None
        try:
            counters = _ProcessMemoryCounters()
            counters.cb = ctypes.sizeof(counters)
            ok = ctypes.windll.psapi.GetProcessMemoryInfo(
                handle,
                ctypes.byref(counters),
                counters.cb,
            )
            if not ok:
                return None
            return counters.WorkingSetSize / (1024.0 * 1024.0)
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)

    status = Path(f"/proc/{pid}/status")
    try:
        for line in status.read_text(encoding="utf-8").splitlines():
            if line.startswith("VmRSS:"):
                return float(line.split()[1]) / 1024.0
    except (OSError, ValueError):
        return None
    return None


def _current_rss_mb() -> float | None:
    return _rss_mb(os.getpid())


def _policy_for_tier(name: str) -> dict[str, Any]:
    """Tính policy bằng chính helper production, không chép lại công thức."""
    spec = dict(TIER_SPECS[name])
    from app.core.print_engine import facade
    from app.core.ppe_viewer_session import viewer_session_budget_policy

    total_mb = float(spec["total_mb"])
    available_mb = float(spec["available_mb"])
    heavy_slots = int(spec["heavy_slots"])
    session = viewer_session_budget_policy(total_mb, available_mb)
    spec.update(
        render_budget_mb=facade._auto_memory_budget_mb(
            total_mb,
            available_mb,
            heavy_slots,
        ),
        session_pool_mb=session.total_pool_mb,
        session_cache_mb=session.desired_cache_mb,
        orphan_ttl_seconds=session.orphan_ttl_seconds,
    )
    return spec


def _make_customer_page(source: Path, output: Path) -> None:
    with pikepdf.open(source) as original:
        if not original.pages:
            raise RuntimeError("PDF benchmark không có trang")
        one_page = pikepdf.Pdf.new()
        one_page.pages.append(original.pages[0])
        one_page.save(output)
        one_page.close()


def _make_spot_rectangle(output: Path) -> None:
    pdf = pikepdf.Pdf.new()
    tint = pikepdf.Dictionary(
        FunctionType=2,
        Domain=[0, 1],
        C0=[0, 0, 0, 0],
        C1=[0, 1, 0, 0],
        N=1,
        Range=[0, 1, 0, 1, 0, 1, 0, 1],
    )
    separation = pikepdf.Array(
        [
            pikepdf.Name("/Separation"),
            pikepdf.Name("/CutContour"),
            pikepdf.Name("/DeviceCMYK"),
            pdf.make_indirect(tint),
        ]
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 200, 120],
        Resources=pikepdf.Dictionary(
            ColorSpace=pikepdf.Dictionary(CS0=pdf.make_indirect(separation))
        ),
        Contents=pdf.make_indirect(
            pikepdf.Stream(pdf, b"/CS0 cs 1 scn 20 30 120 60 re f\n")
        ),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    pdf.save(output)
    pdf.close()


def _make_outline_fixture(output: Path) -> None:
    font_path = BACKEND_ROOT / "app" / "assets" / "fonts" / "DejaVuSans.ttf"
    if not font_path.is_file():
        raise RuntimeError(f"Thiếu font fixture: {font_path}")
    pdf = pikepdf.Pdf.new()
    font_data = font_path.read_bytes()
    font_file = pdf.make_stream(font_data)
    font_file["/Length1"] = len(font_data)
    descriptor = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name("/FontDescriptor"),
            FontName=pikepdf.Name("/DejaVuSans"),
            Flags=32,
            ItalicAngle=0,
            Ascent=900,
            Descent=-200,
            CapHeight=700,
            StemV=80,
            FontBBox=[-1021, -463, 1793, 1232],
            FontFile2=font_file,
        )
    )
    font = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name("/Font"),
            Subtype=pikepdf.Name("/TrueType"),
            BaseFont=pikepdf.Name("/DejaVuSans"),
            Encoding=pikepdf.Name("/WinAnsiEncoding"),
            FontDescriptor=descriptor,
        )
    )
    content = (
        b"BT /F1 36 Tf 30 120 Td "
        b"(Hop giay ABC - PrynX PPE concurrency) Tj ET"
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 600, 300],
        Resources=pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font)),
        Contents=pdf.make_stream(content),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    pdf.save(output)
    pdf.close()


def _prepare_fixtures(source: Path, root: Path) -> dict[str, str]:
    customer_page = root / "customer-page-1.pdf"
    spot_rectangle = root / "spot-rectangle.pdf"
    outline_fixture = root / "outline-font.pdf"
    _make_customer_page(source, customer_page)
    _make_spot_rectangle(spot_rectangle)
    _make_outline_fixture(outline_fixture)
    return {
        "customer": str(customer_page),
        "spot": str(spot_rectangle),
        "outline": str(outline_fixture),
    }


def _install_render_budget(render_budget_mb: int) -> None:
    """Chỉ monkeypatch trong benchmark child; không đổi policy app đang chạy."""
    from app.core.print_engine import facade

    facade._memory_budget_mb = lambda: int(render_budget_mb)


def _open_session(
    source: str,
    owner: str,
    policy: dict[str, Any],
):
    from app.core.print_engine.facade import open_softproof_session

    return open_softproof_session(
        source,
        owner_id=owner,
        cmyk_profile_id="fogra39",
        render_intent=1,
        resource_cache_budget_mb=int(policy["session_cache_mb"]),
    )


def _prepare_task(
    task_name: str,
    fixtures: dict[str, str],
    policy: dict[str, Any],
) -> Any:
    if task_name == "viewer_zoom_stop":
        session = _open_session(fixtures["customer"], f"bench-view-{os.getpid()}", policy)
        session.render(
            owner_id=session.owner_id,
            request_generation=1,
            pdf_path=fixtures["customer"],
            cmyk_profile_id="fogra39",
            render_intent=1,
            page_num=1,
            dpi=96,
            clip=(0, 0, 512, 384),
        )
        return session
    if task_name in {"output_preview", "session_cancel"}:
        return _open_session(
            fixtures["customer"],
            f"bench-{task_name}-{os.getpid()}",
            policy,
        )
    return None


def _close_session(session: Any) -> dict[str, Any]:
    rss_before = _current_rss_mb()
    started = time.perf_counter()
    closed = bool(session.close(session.owner_id))
    close_ms = (time.perf_counter() - started) * 1000.0
    gc.collect()
    time.sleep(0.05)
    return {
        "closed": closed,
        "close_ms": _round(close_ms),
        "rss_before_close_mb": _round(rss_before),
        "rss_after_close_mb": _round(_current_rss_mb()),
    }


def _run_viewer_zoom(
    session: Any,
    source: str,
    dpi: int,
) -> dict[str, Any]:
    started = time.perf_counter()
    rendered = session.render(
        owner_id=session.owner_id,
        request_generation=2,
        pdf_path=source,
        cmyk_profile_id="fogra39",
        render_intent=1,
        page_num=1,
        dpi=dpi,
        clip=(250, 180, 1024, 768),
    )
    operation_ms = (time.perf_counter() - started) * 1000.0
    rgb = bytes(rendered["rgb"])
    cleanup = _close_session(session)
    return {
        "operation_ms": operation_ms,
        "artifact": {
            "width": int(rendered["width"]),
            "height": int(rendered["height"]),
            "rgb_sha256": _sha256_bytes(rgb),
            "degraded": bool(rendered.get("degraded")),
            "ink_unsound": bool(rendered.get("ink_unsound")),
        },
        "cleanup": cleanup,
    }


def _run_output_preview(session: Any, source: str, dpi: int) -> dict[str, Any]:
    started = time.perf_counter()
    rendered = session.render(
        owner_id=session.owner_id,
        request_generation=1,
        pdf_path=source,
        cmyk_profile_id="fogra39",
        render_intent=1,
        page_num=1,
        dpi=dpi,
        simulate_overprint=True,
        output_preview_filter="all",
    )
    operation_ms = (time.perf_counter() - started) * 1000.0
    rgb = bytes(rendered["rgb"])
    cleanup = _close_session(session)
    return {
        "operation_ms": operation_ms,
        "artifact": {
            "width": int(rendered["width"]),
            "height": int(rendered["height"]),
            "rgb_sha256": _sha256_bytes(rgb),
            "degraded": bool(rendered.get("degraded")),
            "ink_unsound": bool(rendered.get("ink_unsound")),
        },
        "cleanup": cleanup,
    }


def _run_export_cmyk(source: str, dpi: int) -> dict[str, Any]:
    from app.core.print_engine import facade

    started = time.perf_counter()
    rendered = facade.export_cmyk(source, 1, dpi=dpi, page_box="crop")
    operation_ms = (time.perf_counter() - started) * 1000.0
    cmyk = bytes(rendered["cmyk"])
    return {
        "operation_ms": operation_ms,
        "artifact": {
            "width": int(rendered["width"]),
            "height": int(rendered["height"]),
            "cmyk_sha256": _sha256_bytes(cmyk),
            "degraded": bool(rendered.get("degraded")),
            "ink_unsound": bool(rendered.get("ink_unsound")),
        },
    }


def _remove_output(path: Path) -> bool:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        return False
    return not path.exists()


def _run_flatten(source: str, output_dir: Path, *, dpi: int = 72) -> dict[str, Any]:
    from app.core import pdf_actions_native

    output = output_dir / "flattened.pdf"
    started = time.perf_counter()
    result = pdf_actions_native.flatten_transparency(source, str(output), float(dpi))
    operation_ms = (time.perf_counter() - started) * 1000.0
    if not result.get("supported") or not output.is_file():
        raise RuntimeError(f"Flatten không tạo artifact hợp lệ: {result}")
    with pikepdf.open(output) as pdf:
        pages = len(pdf.pages)
    signs_after = pdf_actions_native.detect_transparency(str(output))
    output_sha = _sha256_file(output)
    output_bytes = output.stat().st_size
    removed = _remove_output(output)
    return {
        "operation_ms": operation_ms,
        "artifact": {
            "pages": pages,
            "flattened": int(result.get("flattened", 0)),
            "dpi_used": int(result.get("dpi_used", dpi)),
            "transparency_signs_after": len(signs_after),
        },
        "diagnostic": {
            "output_sha256": output_sha,
            "output_bytes": output_bytes,
            "warnings": len(result.get("warnings") or []),
        },
        "cleanup": {"output_removed": removed},
    }


def _run_outline(source: str, output_dir: Path) -> dict[str, Any]:
    from app.core import outline_text

    output = output_dir / "outlined.pdf"
    started = time.perf_counter()
    result = outline_text.outline_fonts(source, str(output))
    operation_ms = (time.perf_counter() - started) * 1000.0
    if not result.get("supported") or not output.is_file():
        raise RuntimeError(f"Outline không tạo artifact hợp lệ: {result}")
    with pikepdf.open(output) as pdf:
        pages = len(pdf.pages)
        font_alive = any(
            "/Font" in (page.get("/Resources") or {})
            for page in pdf.pages
        )
    output_sha = _sha256_file(output)
    removed = _remove_output(output)
    return {
        "operation_ms": operation_ms,
        "artifact": {
            "pages": pages,
            "glyphs": int(result.get("glyphs", 0)),
            "font_resource_alive": font_alive,
        },
        "diagnostic": {"output_sha256": output_sha},
        "cleanup": {"output_removed": removed},
    }


def _run_detect_shape(source: str) -> dict[str, Any]:
    from app.api.routes import imposition
    from app.core.separations import SeparationEngine
    from app.workers.die_detection import DetectionConfig

    started = time.perf_counter()
    shape = asyncio.run(
        imposition._raster_fallback_shape(
            SeparationEngine(),
            source,
            0,
            DetectionConfig(),
            logging.getLogger("ppe-concurrency-benchmark"),
        )
    )
    operation_ms = (time.perf_counter() - started) * 1000.0
    if shape is None:
        raise RuntimeError("Detect-shape không trả về hình")
    return {
        "operation_ms": operation_ms,
        "artifact": {
            "source": str(shape.source),
            "type": str(shape.type.name),
            "trim_w_pt": round(float(shape.trim.w), 3),
            "trim_h_pt": round(float(shape.trim.h), 3),
        },
    }


def _run_session_cancel(session: Any, source: str, dpi: int) -> dict[str, Any]:
    holder: dict[str, Any] = {}
    render_started = threading.Event()

    def render() -> None:
        render_started.set()
        try:
            result = session.render(
                owner_id=session.owner_id,
                request_generation=1,
                pdf_path=source,
                cmyk_profile_id="fogra39",
                render_intent=1,
                page_num=1,
                dpi=dpi,
            )
            holder["completed"] = True
            holder["artifact"] = {
                "width": int(result["width"]),
                "height": int(result["height"]),
            }
        except BaseException as exc:  # noqa: BLE001 - benchmark phải ghi kiểu hủy
            holder["completed"] = False
            holder["exception"] = type(exc).__name__
            holder["message"] = str(exc)[:200]

    thread = threading.Thread(target=render, name="ppe-session-cancel", daemon=False)
    operation_started = time.perf_counter()
    thread.start()
    if not render_started.wait(5.0):
        raise RuntimeError("Render cancel không khởi động")
    time.sleep(0.005)
    cancel_started = time.perf_counter()
    cancel_changed = bool(session.cancel(session.owner_id, 1))
    cancel_ack_ms = (time.perf_counter() - cancel_started) * 1000.0
    drain_started = time.perf_counter()
    thread.join(timeout=60.0)
    cancel_drain_ms = (time.perf_counter() - drain_started) * 1000.0
    operation_ms = (time.perf_counter() - operation_started) * 1000.0
    if thread.is_alive():
        raise RuntimeError("PPE session không dừng trong 60 giây sau cancel")
    cleanup = _close_session(session)
    return {
        "operation_ms": operation_ms,
        "artifact": {
            "cancel_changed": cancel_changed,
            "render_completed": bool(holder.get("completed")),
            "exception": holder.get("exception"),
        },
        "cancel": {
            "ack_ms": cancel_ack_ms,
            "drain_ms": cancel_drain_ms,
        },
        "cleanup": cleanup,
    }


async def _cancel_to_thread_flatten(
    source: str,
    output: Path,
    dpi: int,
) -> dict[str, Any]:
    from app.core import pdf_actions_native

    worker_started = threading.Event()
    worker_done = threading.Event()
    holder: dict[str, Any] = {}

    def work() -> None:
        worker_started.set()
        try:
            holder["result"] = pdf_actions_native.flatten_transparency(
                source,
                str(output),
                float(dpi),
            )
        except BaseException as exc:  # noqa: BLE001 - ghi bằng chứng drain
            holder["exception"] = type(exc).__name__
            holder["message"] = str(exc)[:200]
        finally:
            worker_done.set()

    task = asyncio.create_task(asyncio.to_thread(work))
    await asyncio.to_thread(worker_started.wait, 5.0)
    await asyncio.sleep(0.005)
    cancel_started = time.perf_counter()
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    ack_ms = (time.perf_counter() - cancel_started) * 1000.0
    drain_started = time.perf_counter()
    finished = await asyncio.to_thread(worker_done.wait, 120.0)
    drain_ms = (time.perf_counter() - drain_started) * 1000.0
    if not finished:
        raise RuntimeError("Worker flatten không drain trong 120 giây")
    return {
        "ack_ms": ack_ms,
        "drain_ms": drain_ms,
        "worker_completed_after_cancel": "result" in holder,
        "worker_exception": holder.get("exception"),
    }


def _run_file_cancel_flatten(
    source: str,
    output_dir: Path,
    dpi: int,
) -> dict[str, Any]:
    output = output_dir / "cancelled-flatten.pdf"
    started = time.perf_counter()
    cancel = asyncio.run(_cancel_to_thread_flatten(source, output, dpi))
    operation_ms = (time.perf_counter() - started) * 1000.0
    output_exists_after_drain = output.is_file()
    output_valid = False
    if output_exists_after_drain:
        try:
            with pikepdf.open(output) as pdf:
                output_valid = len(pdf.pages) == 1
        except Exception:  # noqa: BLE001 - artifact hủy có thể dở dang
            output_valid = False
    removed = _remove_output(output)
    return {
        "operation_ms": operation_ms,
        "artifact": {
            "caller_cancelled": True,
            "worker_completed_after_cancel": cancel["worker_completed_after_cancel"],
            "output_exists_after_drain": output_exists_after_drain,
            "output_valid": output_valid,
        },
        "cancel": {
            "ack_ms": cancel["ack_ms"],
            "drain_ms": cancel["drain_ms"],
            "worker_exception": cancel["worker_exception"],
        },
        "cleanup": {"output_removed": removed},
    }


def _execute_task(
    task_name: str,
    prepared: Any,
    fixtures: dict[str, str],
    output_dir: Path,
    policy: dict[str, Any],
) -> dict[str, Any]:
    if task_name == "viewer_zoom_stop":
        return _run_viewer_zoom(
            prepared,
            fixtures["customer"],
            int(policy["viewer_dpi"]),
        )
    if task_name == "export_cmyk":
        return _run_export_cmyk(
            fixtures["customer"],
            int(policy["export_dpi"]),
        )
    if task_name == "output_preview":
        return _run_output_preview(
            prepared,
            fixtures["customer"],
            int(policy["preview_dpi"]),
        )
    if task_name == "flatten_transparency":
        return _run_flatten(
            fixtures["customer"],
            output_dir,
            dpi=int(policy["flatten_dpi"]),
        )
    if task_name == "outline_fonts":
        return _run_outline(fixtures["outline"], output_dir)
    if task_name == "detect_shape":
        return _run_detect_shape(fixtures["spot"])
    if task_name == "session_cancel":
        return _run_session_cancel(
            prepared,
            fixtures["customer"],
            int(policy["session_cancel_dpi"]),
        )
    if task_name == "file_cancel_flatten":
        return _run_file_cancel_flatten(
            fixtures["customer"],
            output_dir,
            int(policy["file_cancel_flatten_dpi"]),
        )
    raise ValueError(f"Task benchmark không hợp lệ: {task_name}")


def _worker_entry(
    task_name: str,
    fixtures: dict[str, str],
    output_dir: str,
    policy: dict[str, Any],
    start_event,
    message_queue,
) -> None:
    """Process worker: import native sau khi nhận policy, rồi chờ barrier."""
    prepared = None
    try:
        _install_render_budget(int(policy["render_budget_mb"]))
        prepared = _prepare_task(task_name, fixtures, policy)
        message_queue.put(
            {"event": "ready", "task": task_name, "pid": os.getpid()}
        )
        if not start_event.wait(120.0):
            raise RuntimeError("Hết thời gian chờ benchmark barrier")
        cpu_started = time.process_time()
        wall_started = time.perf_counter()
        payload = _execute_task(
            task_name,
            prepared,
            fixtures,
            Path(output_dir),
            policy,
        )
        message_queue.put(
            {
                "event": "result",
                "task": task_name,
                "pid": os.getpid(),
                "wall_ms": (time.perf_counter() - wall_started) * 1000.0,
                "cpu_ms": (time.process_time() - cpu_started) * 1000.0,
                "payload": payload,
            }
        )
    except BaseException as exc:  # noqa: BLE001 - child phải trả lỗi về parent
        message_queue.put(
            {
                "event": "error",
                "task": task_name,
                "pid": os.getpid(),
                "error": f"{type(exc).__name__}: {exc}",
                "traceback": traceback.format_exc(),
            }
        )
        raise
    finally:
        if prepared is not None and hasattr(prepared, "close"):
            try:
                prepared.close(prepared.owner_id)
            except Exception:
                pass


def _drain_messages(message_queue) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    while True:
        try:
            messages.append(message_queue.get_nowait())
        except queue.Empty:
            return messages


def _run_group(
    tasks: tuple[str, ...],
    fixtures: dict[str, str],
    policy: dict[str, Any],
    run_root: Path,
    run_id: str,
    *,
    timeout_seconds: float = 180.0,
) -> dict[str, Any]:
    context = multiprocessing.get_context("spawn")
    start_event = context.Event()
    message_queue = context.Queue()
    processes: list[multiprocessing.Process] = []
    task_dirs: dict[str, Path] = {}
    for task_name in tasks:
        task_dir = run_root / f"{run_id}-{task_name}"
        task_dir.mkdir(parents=True, exist_ok=False)
        task_dirs[task_name] = task_dir
        process = context.Process(
            target=_worker_entry,
            args=(
                task_name,
                fixtures,
                str(task_dir),
                policy,
                start_event,
                message_queue,
            ),
            name=f"ppe-bench-{task_name}",
            daemon=False,
        )
        process.start()
        processes.append(process)

    pids = [int(process.pid or 0) for process in processes]
    peak_rss_mb = 0.0
    baseline_rss_mb = 0.0
    messages: list[dict[str, Any]] = []
    ready: set[str] = set()
    prepare_deadline = time.monotonic() + timeout_seconds
    while len(ready) < len(tasks):
        readings = [_rss_mb(pid) for pid in pids]
        peak_rss_mb = max(
            peak_rss_mb,
            sum(value for value in readings if value is not None),
        )
        messages.extend(_drain_messages(message_queue))
        ready.update(
            str(message["task"])
            for message in messages
            if message.get("event") == "ready"
        )
        errors = [message for message in messages if message.get("event") == "error"]
        if errors:
            break
        if any(not process.is_alive() for process in processes) and len(ready) < len(tasks):
            break
        if time.monotonic() >= prepare_deadline:
            break
        time.sleep(0.02)

    if len(ready) == len(tasks):
        baseline_readings = [_rss_mb(pid) for pid in pids]
        baseline_rss_mb = sum(
            value for value in baseline_readings if value is not None
        )
        start_event.set()
    else:
        start_event.set()

    run_started = time.perf_counter()
    deadline = time.monotonic() + timeout_seconds
    while any(process.is_alive() for process in processes):
        readings = [_rss_mb(pid) for pid in pids]
        peak_rss_mb = max(
            peak_rss_mb,
            sum(value for value in readings if value is not None),
        )
        messages.extend(_drain_messages(message_queue))
        if time.monotonic() >= deadline:
            for process in processes:
                if process.is_alive():
                    process.terminate()
            break
        time.sleep(0.02)
    makespan_ms = (time.perf_counter() - run_started) * 1000.0

    for process in processes:
        process.join(timeout=5.0)
    time.sleep(0.05)
    messages.extend(_drain_messages(message_queue))
    results = {
        str(message["task"]): message
        for message in messages
        if message.get("event") == "result"
    }
    errors = [message for message in messages if message.get("event") == "error"]
    exit_codes = {process.name: process.exitcode for process in processes}
    if len(ready) != len(tasks) or len(results) != len(tasks) or errors:
        details = errors or messages
        raise RuntimeError(
            f"Benchmark group {run_id} thất bại; ready={sorted(ready)}, "
            f"results={sorted(results)}, exits={exit_codes}, details={details}"
        )

    leftovers: list[str] = []
    for task_dir in task_dirs.values():
        leftovers.extend(
            str(path.relative_to(run_root))
            for path in task_dir.rglob("*")
            if path.is_file()
        )
        shutil.rmtree(task_dir, ignore_errors=True)

    cpu_ms = sum(float(result["cpu_ms"]) for result in results.values())
    core_equivalents = cpu_ms / makespan_ms if makespan_ms > 0 else 0.0
    host_cpus = max(1, os.cpu_count() or 1)
    return {
        "tasks": list(tasks),
        "makespan_ms": makespan_ms,
        "baseline_rss_mb": baseline_rss_mb,
        "peak_rss_mb": peak_rss_mb,
        "peak_rss_delta_mb": max(0.0, peak_rss_mb - baseline_rss_mb),
        "cpu_ms": cpu_ms,
        "cpu_core_equivalents": core_equivalents,
        "cpu_pct_of_host": core_equivalents / host_cpus * 100.0,
        "results": results,
        "leftover_files": leftovers,
        "exit_codes": exit_codes,
    }


def _task_times(groups: list[dict[str, Any]], task_name: str) -> list[float]:
    values: list[float] = []
    for group in groups:
        result = group["results"][task_name]
        payload = result.get("payload") or {}
        values.append(float(payload.get("operation_ms", result["wall_ms"])))
    return values


def _summary(values: list[float]) -> dict[str, Any]:
    return {
        "n": len(values),
        "p50": _round(statistics.median(values)),
        "p95": _round(percentile(values, 0.95)),
        "min": _round(min(values)),
        "max": _round(max(values)),
        "samples": [_round(value) for value in values],
    }


def _artifact_signatures(
    groups: list[dict[str, Any]],
    task_name: str,
) -> list[str]:
    signatures = {
        json.dumps(
            group["results"][task_name]["payload"].get("artifact"),
            ensure_ascii=False,
            sort_keys=True,
        )
        for group in groups
    }
    return sorted(signatures)


def _payload_cleanup_ok(payload: dict[str, Any]) -> bool:
    cleanup = payload.get("cleanup") or {}
    if "closed" in cleanup and not cleanup["closed"]:
        return False
    if "output_removed" in cleanup and not cleanup["output_removed"]:
        return False
    return True


def _summarize_pair(
    pair_name: str,
    pair: tuple[str, str],
    isolated: dict[str, list[dict[str, Any]]],
    concurrent: list[dict[str, Any]],
) -> dict[str, Any]:
    tasks_summary: dict[str, Any] = {}
    for task_name in pair:
        isolated_times = _task_times(isolated[task_name], task_name)
        concurrent_times = _task_times(concurrent, task_name)
        isolated_p95 = percentile(isolated_times, 0.95)
        concurrent_p95 = percentile(concurrent_times, 0.95)
        signatures = _artifact_signatures(
            isolated[task_name] + concurrent,
            task_name,
        )
        tasks_summary[task_name] = {
            "isolated_ms": _summary(isolated_times),
            "concurrent_ms": _summary(concurrent_times),
            "p95_slowdown_ratio": _round(
                concurrent_p95 / isolated_p95 if isolated_p95 > 0 else None
            ),
            "artifact_consistent": len(signatures) == 1,
            "artifact_signatures": signatures,
        }

    return {
        "pair": pair_name,
        "tasks": tasks_summary,
        "concurrent_makespan_ms": _summary(
            [float(group["makespan_ms"]) for group in concurrent]
        ),
        "concurrent_peak_rss_mb": _summary(
            [float(group["peak_rss_mb"]) for group in concurrent]
        ),
        "concurrent_peak_rss_delta_mb": _summary(
            [float(group["peak_rss_delta_mb"]) for group in concurrent]
        ),
        "concurrent_cpu_core_equivalents": _summary(
            [float(group["cpu_core_equivalents"]) for group in concurrent]
        ),
        "concurrent_cpu_pct_of_host": _summary(
            [float(group["cpu_pct_of_host"]) for group in concurrent]
        ),
        "cleanup_ok": all(
            not group["leftover_files"]
            and all(
                _payload_cleanup_ok(result["payload"])
                for result in group["results"].values()
            )
            for group in concurrent
        ),
    }


def _benchmark_pair(
    pair_name: str,
    pair: tuple[str, str],
    fixtures: dict[str, str],
    policy: dict[str, Any],
    run_root: Path,
    warmups: int,
    repeats: int,
) -> dict[str, Any]:
    isolated = {pair[0]: [], pair[1]: []}
    concurrent: list[dict[str, Any]] = []
    total = warmups + repeats
    for iteration in range(total):
        measured = iteration >= warmups
        phase = "đo" if measured else "warmup"
        print(
            f"[PPE BENCH] {policy['tier']} / {pair_name} / {phase} "
            f"{iteration + 1}/{total}",
            flush=True,
        )
        order = pair if iteration % 2 == 0 else (pair[1], pair[0])
        run_results: dict[str, dict[str, Any]] = {}
        for task_name in order:
            run_results[task_name] = _run_group(
                (task_name,),
                fixtures,
                policy,
                run_root,
                f"{policy['tier']}-{pair_name}-{iteration}-solo-{task_name}",
            )
        concurrent_result = _run_group(
            pair,
            fixtures,
            policy,
            run_root,
            f"{policy['tier']}-{pair_name}-{iteration}-pair",
        )
        if measured:
            for task_name in pair:
                isolated[task_name].append(run_results[task_name])
            concurrent.append(concurrent_result)
    return _summarize_pair(pair_name, pair, isolated, concurrent)


def _summarize_cancel(
    groups: list[dict[str, Any]],
    task_name: str,
) -> dict[str, Any]:
    payloads = [group["results"][task_name]["payload"] for group in groups]
    return {
        "operation_ms": _summary(
            [float(payload["operation_ms"]) for payload in payloads]
        ),
        "cancel_ack_ms": _summary(
            [float(payload["cancel"]["ack_ms"]) for payload in payloads]
        ),
        "cancel_drain_ms": _summary(
            [float(payload["cancel"]["drain_ms"]) for payload in payloads]
        ),
        "peak_rss_mb": _summary(
            [float(group["peak_rss_mb"]) for group in groups]
        ),
        "artifacts": [payload["artifact"] for payload in payloads],
        "cleanup_ok": all(
            not group["leftover_files"]
            and _payload_cleanup_ok(payload)
            for group, payload in zip(groups, payloads)
        ),
    }


def _benchmark_cancel(
    fixtures: dict[str, str],
    policy: dict[str, Any],
    run_root: Path,
    warmups: int,
    repeats: int,
) -> dict[str, Any]:
    measured: dict[str, list[dict[str, Any]]] = {
        task_name: [] for task_name in CANCEL_TASKS
    }
    total = warmups + repeats
    for task_name in CANCEL_TASKS:
        for iteration in range(total):
            phase = "đo" if iteration >= warmups else "warmup"
            print(
                f"[PPE BENCH] {policy['tier']} / {task_name} / {phase} "
                f"{iteration + 1}/{total}",
                flush=True,
            )
            group = _run_group(
                (task_name,),
                fixtures,
                policy,
                run_root,
                f"{policy['tier']}-{task_name}-{iteration}",
            )
            if iteration >= warmups:
                measured[task_name].append(group)
    return {
        task_name: _summarize_cancel(groups, task_name)
        for task_name, groups in measured.items()
    }


def _native_metadata() -> dict[str, Any]:
    import pdfcompare_native

    package_path = Path(pdfcompare_native.__file__).resolve()
    candidates = [package_path]
    if package_path.name == "__init__.py":
        candidates.extend(package_path.parent.glob("*.pyd"))
        candidates.extend(package_path.parent.glob("*.so"))
    binary = next((path for path in candidates if path.suffix in {".pyd", ".so"}), package_path)
    capabilities = (
        dict(pdfcompare_native.ppe_capabilities())
        if hasattr(pdfcompare_native, "ppe_capabilities")
        else {}
    )
    return {
        "module": str(package_path),
        "binary": str(binary),
        "sha256": _sha256_file(binary),
        "capabilities": capabilities,
    }


def _parse_csv(value: str, allowed: Iterable[str], label: str) -> list[str]:
    allowed_order = list(allowed)
    allowed_set = set(allowed_order)
    selected = allowed_order if value.strip().lower() == "all" else [
        item.strip().lower() for item in value.split(",") if item.strip()
    ]
    unknown = sorted(set(selected) - allowed_set)
    if unknown:
        raise ValueError(f"{label} không hợp lệ: {', '.join(unknown)}")
    return selected


def run_benchmark(args: argparse.Namespace) -> dict[str, Any]:
    source = args.pdf.resolve()
    if not source.is_file() or source.suffix.lower() != ".pdf":
        raise SystemExit(f"Không tìm thấy PDF benchmark: {source}")
    if args.warmups < 0 or args.repeats <= 0:
        raise SystemExit("warmups phải >=0 và repeats phải >0")
    if args.render_budget_mb is not None and args.render_budget_mb <= 0:
        raise SystemExit("render-budget-mb phải >0")
    try:
        tiers = _parse_csv(args.tiers, TIER_SPECS, "tier")
        pairs = _parse_csv(args.pairs, PAIR_TASKS, "pair")
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc

    source_sha = _sha256_file(source)
    started_utc = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    from app.core.system_memory import read_memory_status_mb

    memory_before = read_memory_status_mb()
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="prynx_ppe_concurrency_") as temp:
        root = Path(temp)
        fixtures = _prepare_fixtures(source, root)
        run_root = root / "runs"
        run_root.mkdir()
        tier_results: dict[str, Any] = {}
        for tier_name in tiers:
            policy = _policy_for_tier(tier_name)
            policy["tier"] = tier_name
            policy["workload"] = args.workload
            policy.update(WORKLOAD_SPECS[args.workload])
            if args.render_budget_mb is not None:
                policy["auto_render_budget_mb"] = policy["render_budget_mb"]
                policy["render_budget_mb"] = int(args.render_budget_mb)
            tier_pairs: dict[str, Any] = {}
            for pair_name in pairs:
                try:
                    tier_pairs[pair_name] = _benchmark_pair(
                        pair_name,
                        PAIR_TASKS[pair_name],
                        fixtures,
                        policy,
                        run_root,
                        args.warmups,
                        args.repeats,
                    )
                except RuntimeError as exc:
                    if not args.continue_on_error:
                        raise
                    tier_pairs[pair_name] = {
                        "status": "error",
                        "error": str(exc),
                    }
            cancel = (
                _benchmark_cancel(
                    fixtures,
                    policy,
                    run_root,
                    args.warmups,
                    args.repeats,
                )
                if not args.skip_cancel
                else {}
            )
            tier_results[tier_name] = {
                "policy": policy,
                "pairs": tier_pairs,
                "cancel": cancel,
            }

        leftovers = [
            str(path.relative_to(run_root))
            for path in run_root.rglob("*")
            if path.is_file()
        ]

    source_sha_after = _sha256_file(source)
    memory_after = read_memory_status_mb()
    report = {
        "schema": "prynx.ppe-concurrency-benchmark.v1",
        "started_utc": started_utc,
        "finished_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "scope": "W7-U06 / §PPE.SCOPE.4 / Lô B",
        "disclaimer": (
            "Tier high là runtime vật lý trên máy audit. Tier low/medium chỉ mô phỏng "
            "policy RAM; không mô phỏng áp lực swap, băng thông RAM hoặc CPU của máy khác."
        ),
        "host": {
            "platform": sys.platform,
            "python": sys.version,
            "logical_cpus": os.cpu_count(),
            "memory_total_mb_before": _round(memory_before[0]),
            "memory_available_mb_before": _round(memory_before[1]),
            "memory_total_mb_after": _round(memory_after[0]),
            "memory_available_mb_after": _round(memory_after[1]),
        },
        "source": {
            "path": str(source),
            "bytes": source.stat().st_size,
            "sha256_before": source_sha,
            "sha256_after": source_sha_after,
            "unchanged": source_sha == source_sha_after,
            "benchmark_page": 1,
        },
        "native": _native_metadata(),
        "config": {
            "warmups": args.warmups,
            "repeats": args.repeats,
            "tiers": tiers,
            "pairs": pairs,
            "cancel": not args.skip_cancel,
            "workload": args.workload,
            "workload_spec": WORKLOAD_SPECS[args.workload],
            "render_budget_override_mb": args.render_budget_mb,
            "continue_on_error": args.continue_on_error,
        },
        "tiers": tier_results,
        "cleanup": {
            "run_leftovers": leftovers,
            "ok": not leftovers,
        },
    }
    output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"[PPE BENCH] Đã ghi báo cáo: {output}", flush=True)
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Đo contention CPU/RAM giữa các consumer PPE"
    )
    parser.add_argument("--pdf", required=True, type=Path)
    parser.add_argument("--warmups", type=int, default=1)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--tiers", default="all", help="low,medium,high hoặc all")
    parser.add_argument(
        "--pairs",
        default="all",
        help="viewer_export,preview_flatten,outline_detect hoặc all",
    )
    parser.add_argument(
        "--skip-cancel",
        action="store_true",
        help="Bỏ hai ca cancel khi chỉ cần profile cặp consumer",
    )
    parser.add_argument(
        "--workload",
        choices=tuple(WORKLOAD_SPECS),
        default="interactive",
        help="interactive dùng DPI xem; production dùng Export/Flatten 300 DPI",
    )
    parser.add_argument(
        "--render-budget-mb",
        type=int,
        default=None,
        help="Chỉ dùng để A/B policy trong benchmark; không đổi cấu hình sản phẩm",
    )
    parser.add_argument(
        "--continue-on-error",
        action="store_true",
        help="Ghi lỗi từng cặp vào JSON và tiếp tục các cặp còn lại",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=BACKEND_ROOT.parent / ".tmp" / "ppe-concurrency-benchmark.json",
    )
    return parser


def main() -> None:
    multiprocessing.freeze_support()
    run_benchmark(build_parser().parse_args())


if __name__ == "__main__":
    main()
