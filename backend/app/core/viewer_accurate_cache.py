"""Cache PNG chuẩn màu của Viewer, có single-flight cho request trùng nhau."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import threading
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path

from app.config import settings
from app.core.icc_profiles import resolve_cmyk_profile_path, resolve_srgb_profile_path
from app.core.system_memory import read_memory_status_mb


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# PERF (audit 2026-08-07 §GV.P3): tăng phiên bản khi thuật toán PPE/contract màu
# thay đổi để cache cũ không thể che khuất đầu ra mới.
VIEWER_ACCURATE_CACHE_VERSION = "ppe-viewer-accurate-v1"
_CACHE_DIR_NAME = "viewer_accurate_cache"


@dataclass(frozen=True)
class RenderedAccuratePng:
    data: bytes
    engine: str
    accuracy: str = "rip_softproof"


@dataclass(frozen=True)
class AccurateCacheResult:
    rendered: RenderedAccuratePng
    status: str


_inflight: dict[str, asyncio.Task[RenderedAccuratePng]] = {}
_inflight_guard = threading.Lock()
_render_gate_guard = threading.Lock()
_render_gate_loop: asyncio.AbstractEventLoop | None = None
_render_gate_limit: int | None = None
_render_gate: asyncio.Semaphore | None = None


def render_concurrency_for_total_ram(total_ram_mb: int | None) -> int | None:
    """Máy mạnh không cap; máy yếu mới giảm số PPE chạy đồng thời."""
    if total_ram_mb is None or total_ram_mb <= 0:
        return None
    if total_ram_mb < 8 * 1024:
        return 1
    if total_ram_mb < 16 * 1024:
        return 2
    return None


def _render_gate_for_current_loop() -> asyncio.Semaphore | None:
    total_ram_mb, _available_ram_mb = read_memory_status_mb()
    limit = render_concurrency_for_total_ram(total_ram_mb)
    if limit is None:
        return None
    loop = asyncio.get_running_loop()
    global _render_gate_loop, _render_gate_limit, _render_gate
    with _render_gate_guard:
        if _render_gate_loop is not loop or _render_gate_limit != limit or _render_gate is None:
            _render_gate_loop = loop
            _render_gate_limit = limit
            _render_gate = asyncio.Semaphore(limit)
        return _render_gate


def _file_identity(path: str | os.PathLike[str]) -> tuple[str, int, int, int]:
    resolved = os.path.normcase(os.path.realpath(os.fspath(path)))
    stat = os.stat(resolved)
    return resolved, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


def build_accurate_cache_key(
    pdf_path: str,
    *,
    page: int,
    dpi: int,
    profile_id: str,
    intent: str,
) -> str:
    """Khoá gồm mọi đầu vào có thể đổi pixel của ảnh proof."""
    cmyk_profile = resolve_cmyk_profile_path(profile_id)
    if not cmyk_profile:
        raise RuntimeError(f"không tìm được profile CMYK '{profile_id}'")
    rgb_profile = resolve_srgb_profile_path()
    payload = {
        "version": VIEWER_ACCURATE_CACHE_VERSION,
        "pdf": _file_identity(pdf_path),
        "page": int(page),
        "dpi": int(dpi),
        "profile_id": str(profile_id).strip().lower(),
        "cmyk_profile": _file_identity(cmyk_profile),
        "rgb_profile": _file_identity(rgb_profile) if rgb_profile else None,
        "intent": str(intent).strip().lower(),
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _cache_directory() -> Path:
    return Path(settings.RESULTS_DIR) / _CACHE_DIR_NAME


def _cache_path(key: str) -> Path:
    if len(key) != 64 or any(ch not in "0123456789abcdef" for ch in key):
        raise ValueError("Khoá cache Viewer không hợp lệ.")
    return _cache_directory() / f"{key}.png"


def read_cached_png(key: str) -> bytes | None:
    path = _cache_path(key)
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        return None
    except OSError:
        return None
    if not data.startswith(PNG_SIGNATURE):
        # File cache hỏng không phải dữ liệu người dùng; bỏ để lần sau render lại.
        try:
            path.unlink()
        except OSError:
            pass
        return None
    try:
        os.utime(path, None)
    except OSError:
        pass
    return data


def write_cached_png(key: str, data: bytes) -> None:
    if not data.startswith(PNG_SIGNATURE):
        raise ValueError("Dữ liệu cache Viewer không phải PNG.")
    directory = _cache_directory()
    directory.mkdir(parents=True, exist_ok=True)
    target = _cache_path(key)
    temporary = directory / f".{key}.{os.getpid()}.{threading.get_ident()}.tmp"
    try:
        temporary.write_bytes(data)
        os.replace(temporary, target)
    finally:
        if temporary.exists():
            try:
                temporary.unlink()
            except OSError:
                pass


async def get_or_render_accurate_png(
    key: str,
    renderer: Callable[[], Awaitable[RenderedAccuratePng]],
) -> AccurateCacheResult:
    """Đọc cache hoặc dùng chung đúng một task render cho cùng khoá."""
    cached = await asyncio.to_thread(read_cached_png, key)
    if cached is not None:
        return AccurateCacheResult(
            rendered=RenderedAccuratePng(cached, engine="persistent-cache"),
            status="disk-hit",
        )

    owner = False
    loop = asyncio.get_running_loop()
    with _inflight_guard:
        task = _inflight.get(key)
        if task is None or task.done():
            task = loop.create_task(_render_and_store(key, renderer))
            _inflight[key] = task
            owner = True

            def forget(done: asyncio.Task[RenderedAccuratePng]) -> None:
                with _inflight_guard:
                    if _inflight.get(key) is done:
                        _inflight.pop(key, None)

            task.add_done_callback(forget)

    rendered = await asyncio.shield(task)
    return AccurateCacheResult(rendered=rendered, status="miss" if owner else "shared")


async def _render_and_store(
    key: str,
    renderer: Callable[[], Awaitable[RenderedAccuratePng]],
) -> RenderedAccuratePng:
    gate = _render_gate_for_current_loop()
    if gate is None:
        rendered = await renderer()
    else:
        async with gate:
            rendered = await renderer()
    if rendered.accuracy != "rip_softproof":
        raise RuntimeError("Chỉ đầu ra PPE/RIP chính xác mới được ghi cache Viewer.")
    if not rendered.data.startswith(PNG_SIGNATURE):
        raise RuntimeError("Bộ dựng màu không trả đúng PNG lossless.")
    await asyncio.to_thread(write_cached_png, key, rendered.data)
    return rendered
