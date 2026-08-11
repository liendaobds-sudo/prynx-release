"""Cache PNG chuẩn màu của Viewer, có single-flight cho request trùng nhau."""

from __future__ import annotations

import asyncio
import contextvars
import hashlib
import json
import logging
import os
import threading
import weakref
import zlib
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path

from app.config import settings
from app.core.ppe_viewer_session import (
    ViewerSessionIdentity,
    resolve_viewer_session_identity,
)
from app.core.system_memory import read_memory_status_mb


logger = logging.getLogger(__name__)


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# PERF (audit 2026-08-07 §GV.P3): tăng phiên bản khi thuật toán PPE/contract màu
# thay đổi để cache cũ không thể che khuất đầu ra mới.
# COLOR (audit 2026-08-08 §RENDER.4): v1 có thể chứa ảnh PPE ``ink_unsound``
# nhưng từng bị gắn nhãn RIP. Đổi namespace để không tái dùng artifact sai đó.
VIEWER_ACCURATE_CACHE_VERSION = "ppe-viewer-accurate-v5-output-preview"
_CACHE_DIR_NAME = "viewer_accurate_cache"


@dataclass(frozen=True)
class RenderedAccuratePng:
    data: bytes
    engine: str
    accuracy: str = "rip_softproof"
    session_mode: str = "unknown"


@dataclass(frozen=True)
class AccurateCacheResult:
    rendered: RenderedAccuratePng
    status: str


class AccurateRequestSuperseded(RuntimeError):
    """Request Viewer đã bị generation/purpose mới hơn thay thế."""


@dataclass(frozen=True)
class AccurateRenderInterest:
    """Danh tính admission; không tham gia cache key của pixel."""

    scope: str
    generation: int
    purpose: str = "interactive"
    request_id: str | None = None

    @property
    def version(self) -> tuple[int, int]:
        # Cùng generation: interactive thắng background.
        return (int(self.generation), 1 if self.purpose == "interactive" else 0)


@dataclass
class _InflightEntry:
    task: asyncio.Task[RenderedAccuratePng] | None = None
    waiters: int = 0
    started: bool = False


@dataclass(frozen=True)
class _ScopeRegistration:
    interest: AccurateRenderInterest
    superseded: asyncio.Future[None]


@dataclass
class _ScopeRenderLane:
    """Một lane vật lý cho đúng một owner tài liệu trong một event loop."""

    lock: asyncio.Lock
    users: int = 0


_inflight: dict[str, _InflightEntry] = {}
_inflight_guard = threading.Lock()
_scope_guard = threading.Lock()
_scope_latest: dict[str, tuple[int, int]] = {}
_scope_waiters: dict[str, list[_ScopeRegistration]] = {}
_scope_render_lanes: weakref.WeakKeyDictionary[
    asyncio.AbstractEventLoop, dict[tuple[str, str], _ScopeRenderLane]
] = weakref.WeakKeyDictionary()
_render_gate_guard = threading.Lock()
_render_gate_loop: asyncio.AbstractEventLoop | None = None
_render_gate_limit: int | None = None
_render_gate: asyncio.Semaphore | None = None
_current_render_entry: contextvars.ContextVar[_InflightEntry | None] = (
    contextvars.ContextVar("ppe_viewer_current_render_entry", default=None)
)


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
    clip: tuple[int, int, int, int] | None = None,
    output_preview_filter: str = "all",
    simulate_paper_color: bool = False,
    simulate_black_ink: bool = False,
    page_background_rgb: tuple[int, int, int] | None = None,
    source_identity: ViewerSessionIdentity | None = None,
) -> str:
    """Khoá gồm mọi đầu vào có thể đổi pixel của ảnh proof."""
    identity = source_identity or resolve_viewer_session_identity(
        pdf_path,
        profile_id,
        intent,
    )
    resolved_pdf = os.path.normcase(os.path.realpath(os.fspath(pdf_path)))
    if resolved_pdf != identity.pdf.path:
        raise ValueError("source_identity không thuộc PDF của cache key")
    if str(profile_id).strip().lower() != identity.profile_id:
        raise ValueError("source_identity không thuộc profile của cache key")
    if str(intent).strip().lower() != identity.intent:
        raise ValueError("source_identity không thuộc intent của cache key")
    payload = {
        "version": VIEWER_ACCURATE_CACHE_VERSION,
        "source": identity.cache_value(),
        "page": int(page),
        "dpi": int(dpi),
        "page_box": "crop",
        # COLOR (feedback 2026-08-10 §VIEWER.C1): tham gia khóa để artifact
        # overprint-on cũ tuyệt đối không được dùng lại cho Page Display.
        "simulate_overprint": False,
        "output_preview_filter": str(output_preview_filter).strip().lower(),
        "simulate_paper_color": bool(simulate_paper_color),
        "simulate_black_ink": bool(simulate_black_ink),
        "page_background_rgb": (
            list(page_background_rgb) if page_background_rgb is not None else None
        ),
        "clip": list(clip) if clip is not None else None,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def build_accurate_request_scope(pdf_path: str, owner_id: str) -> str:
    """Scope latest-wins theo owner + tài liệu, không lộ path vào registry.

    PERF (audit 2026-08-08 §RENDER.5): revision của file chỉ thuộc cache key. Giữ
    scope ổn định khi save-over để request của revision cũ vẫn bị thế hệ mới loại.
    """
    owner = str(owner_id).strip()
    if not owner:
        raise ValueError("owner_id Viewer không được rỗng")
    resolved = os.path.normcase(os.path.realpath(os.fspath(pdf_path)))
    payload = json.dumps(
        {"owner": owner, "pdf": resolved},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


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
    if not _is_complete_png(data):
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
    if not _is_complete_png(data):
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
    *,
    interest: AccurateRenderInterest | None = None,
) -> AccurateCacheResult:
    """Đọc cache hoặc single-flight, đồng thời loại request Viewer lỗi thời.

    PERF (audit 2026-08-08 §RENDER.5): waiter cuối rời đi sẽ hủy task còn chờ
    quota. Task đã vào PPE không bị cancel giả vì `asyncio.to_thread` không dừng
    được thread Rust; giữ task sống giữ luôn RAM gate thật, nhưng bỏ bước ghi cache.
    """
    registration = _register_interest(interest)
    entry: _InflightEntry | None = None
    try:
        cached = await asyncio.to_thread(read_cached_png, key)
        _raise_if_superseded(registration)
        if cached is not None:
            return AccurateCacheResult(
                rendered=RenderedAccuratePng(cached, engine="persistent-cache"),
                status="disk-hit",
            )

        owner = False
        loop = asyncio.get_running_loop()
        with _inflight_guard:
            entry = _inflight.get(key)
            if entry is None or entry.task is None or entry.task.done():
                entry = _InflightEntry()
                task = loop.create_task(
                    _render_and_store(
                        key,
                        renderer,
                        entry,
                        scope=interest.scope if interest is not None else None,
                        purpose=interest.purpose if interest is not None else None,
                    )
                )
                entry.task = task
                _inflight[key] = entry
                owner = True

                def forget(done: asyncio.Task[RenderedAccuratePng]) -> None:
                    # Thu exception kể cả khi mọi waiter đã stale để event loop
                    # không báo "Task exception was never retrieved".
                    if not done.cancelled():
                        done.exception()
                    with _inflight_guard:
                        if _inflight.get(key) is entry:
                            _inflight.pop(key, None)

                task.add_done_callback(forget)
            entry.waiters += 1
            task = entry.task

        if task is None:  # chỉ để type-checker; entry luôn có task ở nhánh trên.
            raise RuntimeError("Task PPE Viewer không được khởi tạo")
        rendered = await _await_render_or_superseded(task, registration)
        status = "miss" if owner else "shared"
        if rendered.engine == "persistent-cache":
            status = "disk-hit"
        return AccurateCacheResult(rendered=rendered, status=status)
    finally:
        if entry is not None:
            _release_inflight_waiter(entry)
        _unregister_interest(registration)


async def _render_and_store(
    key: str,
    renderer: Callable[[], Awaitable[RenderedAccuratePng]],
    entry: _InflightEntry,
    *,
    scope: str | None,
    purpose: str | None,
) -> RenderedAccuratePng:
    # PERF (audit 2026-08-08 §RENDER.5): request có thể đã đọc miss ngay trước
    # khi owner cũ ghi xong rồi rời `_inflight`. Kiểm lại sau khi giành ownership
    # để khe đó không dựng PPE lần hai cho đúng cùng một key.
    cached = await asyncio.to_thread(read_cached_png, key)
    if cached is not None:
        return RenderedAccuratePng(cached, engine="persistent-cache")

    rendered = await _render_with_admission(renderer, entry, scope, purpose)
    if rendered.accuracy != "rip_softproof":
        raise RuntimeError("Chỉ đầu ra PPE/RIP chính xác mới được ghi cache Viewer.")
    if not rendered.data.startswith(PNG_SIGNATURE):
        raise RuntimeError("Bộ dựng màu không trả đúng PNG lossless.")
    # Request đã bị bỏ sau khi native bắt đầu vẫn phải giữ gate đến lúc native
    # xong, nhưng không tạo I/O/cache churn cho generation không ai còn cần.
    if _entry_has_waiters(entry):
        try:
            await asyncio.to_thread(write_cached_png, key, rendered.data)
        except OSError as exc:
            # Cache chỉ là tối ưu. Ảnh PPE đã dựng hợp lệ vẫn phải được trả khi
            # ổ đĩa đầy, antivirus khóa file hoặc thư mục cache tạm thời lỗi.
            logger.warning("Không ghi được cache Viewer %s: %s", key[:12], exc)
    return rendered


async def _render_with_admission(
    renderer: Callable[[], Awaitable[RenderedAccuratePng]],
    entry: _InflightEntry,
    scope: str | None,
    purpose: str | None,
) -> RenderedAccuratePng:
    """Loại backlog cùng tab trước khi lấy quota RAM và gọi PPE native.

    PERF (audit 2026-08-08 §RENDER.5): đây là latest-only theo owner, không phải
    hard-cap phần cứng. Các tab/tài liệu khác vẫn tận dụng toàn bộ máy mạnh; riêng
    một tab không được chạy đồng thời nhiều thế hệ zoom mà chỉ thế hệ cuối có ích.
    """
    lane_info = _claim_scope_render_lane(scope, purpose)
    try:
        if lane_info is None:
            return await _render_with_ram_gate(renderer, entry)
        _loop, _lane_key, lane = lane_info
        async with lane.lock:
            return await _render_with_ram_gate(renderer, entry)
    finally:
        if lane_info is not None:
            loop, lane_key, lane = lane_info
            _release_scope_render_lane(loop, lane_key, lane)


async def _render_with_ram_gate(
    renderer: Callable[[], Awaitable[RenderedAccuratePng]],
    entry: _InflightEntry,
) -> RenderedAccuratePng:
    gate = _render_gate_for_current_loop()
    if gate is None:
        return await _run_renderer_if_interested(renderer, entry)
    async with gate:
        return await _run_renderer_if_interested(renderer, entry)


def _claim_scope_render_lane(
    scope: str | None,
    purpose: str | None,
) -> tuple[asyncio.AbstractEventLoop, tuple[str, str], _ScopeRenderLane] | None:
    if scope is None:
        return None
    loop = asyncio.get_running_loop()
    # Máy đủ RAM cho phép viewport tương tác vượt một full-page nền đang chạy,
    # nhưng từng lane vẫn latest-only nên không tích tụ chuỗi zoom lỗi thời.
    lane_key = (scope, purpose or "interactive")
    with _scope_guard:
        lanes = _scope_render_lanes.setdefault(loop, {})
        lane = lanes.get(lane_key)
        if lane is None:
            lane = _ScopeRenderLane(asyncio.Lock())
            lanes[lane_key] = lane
        lane.users += 1
    return loop, lane_key, lane


def _release_scope_render_lane(
    loop: asyncio.AbstractEventLoop,
    lane_key: tuple[str, str],
    lane: _ScopeRenderLane,
) -> None:
    with _scope_guard:
        lanes = _scope_render_lanes.get(loop)
        if lanes is None or lanes.get(lane_key) is not lane:
            return
        lane.users = max(0, lane.users - 1)
        if lane.users == 0:
            lanes.pop(lane_key, None)
        if not lanes:
            _scope_render_lanes.pop(loop, None)


async def _run_renderer_if_interested(
    renderer: Callable[[], Awaitable[RenderedAccuratePng]],
    entry: _InflightEntry,
) -> RenderedAccuratePng:
    with _inflight_guard:
        if entry.waiters <= 0:
            raise AccurateRequestSuperseded("Request PPE đã hết người chờ trước khi chạy")
        entry.started = True
    token = _current_render_entry.set(entry)
    try:
        return await renderer()
    finally:
        _current_render_entry.reset(token)


def current_accurate_render_is_interested() -> bool:
    """Checkpoint cho Session Manager ngay trước khi cấp lane/native generation."""
    entry = _current_render_entry.get()
    return True if entry is None else _entry_has_waiters(entry)


def _entry_has_waiters(entry: _InflightEntry) -> bool:
    with _inflight_guard:
        return entry.waiters > 0


def _release_inflight_waiter(entry: _InflightEntry) -> None:
    task_to_cancel: asyncio.Task[RenderedAccuratePng] | None = None
    with _inflight_guard:
        entry.waiters = max(0, entry.waiters - 1)
        task = entry.task
        if entry.waiters == 0 and not entry.started and task is not None and not task.done():
            task_to_cancel = task
    if task_to_cancel is not None:
        task_to_cancel.cancel()


async def _await_render_or_superseded(
    task: asyncio.Task[RenderedAccuratePng],
    registration: _ScopeRegistration | None,
) -> RenderedAccuratePng:
    shielded = asyncio.shield(task)
    try:
        if registration is None:
            return await shielded
        done, _pending = await asyncio.wait(
            {shielded, registration.superseded},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if registration.superseded in done:
            raise AccurateRequestSuperseded(
                f"Request {registration.interest.request_id or ''} đã bị thay thế"
            )
        _raise_if_superseded(registration)
        return shielded.result()
    finally:
        if not shielded.done():
            shielded.cancel()


def _register_interest(
    interest: AccurateRenderInterest | None,
) -> _ScopeRegistration | None:
    if interest is None:
        return None
    if interest.generation < 0:
        raise ValueError("generation Viewer không được âm")
    if interest.purpose not in {"interactive", "background"}:
        raise ValueError("purpose Viewer không hợp lệ")

    loop = asyncio.get_running_loop()
    registration = _ScopeRegistration(interest, loop.create_future())
    stale: list[_ScopeRegistration] = []
    with _scope_guard:
        latest = _scope_latest.get(interest.scope)
        if latest is not None and interest.version < latest:
            raise AccurateRequestSuperseded("Generation Viewer đã lỗi thời trước khi vào hàng")
        if latest is None or interest.version > latest:
            _scope_latest[interest.scope] = interest.version
            stale = [
                item
                for item in _scope_waiters.get(interest.scope, [])
                if item.interest.version < interest.version
            ]
        _scope_waiters.setdefault(interest.scope, []).append(registration)

    for item in stale:
        if not item.superseded.done():
            item.superseded.set_result(None)
    return registration


def _raise_if_superseded(registration: _ScopeRegistration | None) -> None:
    if registration is None:
        return
    with _scope_guard:
        latest = _scope_latest.get(registration.interest.scope)
    if registration.superseded.done() or (
        latest is not None and registration.interest.version < latest
    ):
        raise AccurateRequestSuperseded("Generation Viewer đã bị thay thế")


def _unregister_interest(registration: _ScopeRegistration | None) -> None:
    if registration is None:
        return
    with _scope_guard:
        waiters = _scope_waiters.get(registration.interest.scope, [])
        remaining = [item for item in waiters if item is not registration]
        if remaining:
            _scope_waiters[registration.interest.scope] = remaining
        else:
            _scope_waiters.pop(registration.interest.scope, None)

        # Registry chỉ phục vụ app local nhưng owner vẫn do request cung cấp;
        # giữ một trần phòng client lỗi sinh ID vô hạn. Scope đang active không bị xóa.
        if len(_scope_latest) > 2_048:
            for scope in list(_scope_latest):
                if scope not in _scope_waiters:
                    _scope_latest.pop(scope, None)
                    if len(_scope_latest) <= 1_024:
                        break
    if not registration.superseded.done():
        registration.superseded.cancel()


def _is_complete_png(data: bytes) -> bool:
    """Kiểm cấu trúc + CRC để cache cắt dở không sống lại như ảnh hợp lệ."""
    if len(data) < 45 or not data.startswith(PNG_SIGNATURE):
        return False
    offset = len(PNG_SIGNATURE)
    first = True
    seen_idat = False
    idat_ended = False
    color_type: int | None = None
    while offset + 12 <= len(data):
        length = int.from_bytes(data[offset : offset + 4], "big")
        chunk_end = offset + 12 + length
        if chunk_end > len(data):
            return False
        chunk_type = data[offset + 4 : offset + 8]
        chunk_data = data[offset + 8 : offset + 8 + length]
        expected_crc = int.from_bytes(data[offset + 8 + length : chunk_end], "big")
        actual_crc = zlib.crc32(chunk_type)
        actual_crc = zlib.crc32(chunk_data, actual_crc) & 0xFFFFFFFF
        if actual_crc != expected_crc:
            return False
        if first:
            if chunk_type != b"IHDR" or length != 13:
                return False
            width = int.from_bytes(chunk_data[0:4], "big")
            height = int.from_bytes(chunk_data[4:8], "big")
            bit_depth = chunk_data[8]
            color_type = chunk_data[9]
            valid_depths = {
                0: {1, 2, 4, 8, 16},
                2: {8, 16},
                3: {1, 2, 4, 8},
                4: {8, 16},
                6: {8, 16},
            }
            if (
                width == 0
                or height == 0
                or bit_depth not in valid_depths.get(color_type, set())
                or chunk_data[10] != 0
                or chunk_data[11] != 0
                or chunk_data[12] not in {0, 1}
            ):
                return False
            first = False
        elif chunk_type == b"IHDR":
            return False

        if chunk_type == b"IDAT":
            if idat_ended:
                return False
            seen_idat = True
        elif seen_idat and chunk_type != b"IEND":
            idat_ended = True
        if chunk_type == b"IEND":
            return (
                length == 0
                and seen_idat
                and color_type is not None
                and chunk_end == len(data)
            )
        offset = chunk_end
    return False
