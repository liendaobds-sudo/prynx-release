"""Session PPE dùng chung theo revision tài liệu cho Viewer.

Logical owner của frontend chỉ giữ ref-count. Native session dùng owner/generation nội bộ
và một hàng đợi riêng cho từng revision, nhờ vậy hai tab không hủy nhầm nhau nhưng hai tài
liệu khác vẫn render song song.
"""

from __future__ import annotations

import asyncio
import heapq
import logging
import os
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from app.core.icc_profiles import resolve_cmyk_profile_path, resolve_srgb_profile_path
from app.core.print_engine.facade import PpeSoftproofSession, open_softproof_session
from app.core.system_memory import read_memory_status_mb


logger = logging.getLogger(__name__)

PPE_VIEWER_SESSION_IDENTITY_VERSION = "ppe-viewer-session-v2-view-annotations"
_SESSION_OVERHEAD_MB = 64
_INTENT_CODES = {
    "perceptual": 0,
    "relative": 1,
    "saturation": 2,
    "absolute": 3,
}


class ViewerSessionSuperseded(RuntimeError):
    """Owner/revision hoặc interest của một render đã bị thay thế."""


class ViewerBackgroundSessionDeferred(ViewerSessionSuperseded):
    """Prefetch bị hoãn để nhường pool RAM cho request tương tác."""


@dataclass(frozen=True)
class ViewerFileStamp:
    path: str
    size: int
    modified_ns: int
    created_ns: int

    def cache_value(self) -> tuple[str, int, int, int]:
        return self.path, self.size, self.modified_ns, self.created_ns


@dataclass(frozen=True)
class ViewerSessionIdentity:
    pdf: ViewerFileStamp
    cmyk_profile: ViewerFileStamp
    rgb_profile: ViewerFileStamp | None
    profile_id: str
    intent: str
    intent_code: int
    engine_version: str = PPE_VIEWER_SESSION_IDENTITY_VERSION

    def cache_value(self) -> dict[str, Any]:
        return {
            "pdf": self.pdf.cache_value(),
            "profile_id": self.profile_id,
            "cmyk_profile": self.cmyk_profile.cache_value(),
            "rgb_profile": (
                self.rgb_profile.cache_value() if self.rgb_profile is not None else None
            ),
            "intent": self.intent,
            "engine_version": self.engine_version,
        }


def _file_stamp(path: str | os.PathLike[str]) -> ViewerFileStamp:
    resolved = os.path.normcase(os.path.realpath(os.fspath(path)))
    stat = os.stat(resolved)
    return ViewerFileStamp(
        resolved,
        int(stat.st_size),
        int(stat.st_mtime_ns),
        int(stat.st_ctime_ns),
    )


def resolve_viewer_session_identity(
    pdf_path: str,
    profile_id: str = "fogra39",
    intent: str = "relative",
) -> ViewerSessionIdentity:
    normalized_profile = (profile_id or "fogra39").strip().lower()
    normalized_intent = (intent or "relative").strip().lower()
    intent_code = _INTENT_CODES.get(normalized_intent)
    if intent_code is None:
        raise ValueError("rendering intent Viewer không hợp lệ")
    cmyk_path = resolve_cmyk_profile_path(normalized_profile)
    if not cmyk_path:
        raise RuntimeError(f"không tìm được profile CMYK '{normalized_profile}'")
    rgb_path = resolve_srgb_profile_path()
    return ViewerSessionIdentity(
        pdf=_file_stamp(pdf_path),
        cmyk_profile=_file_stamp(cmyk_path),
        rgb_profile=_file_stamp(rgb_path) if rgb_path else None,
        profile_id=normalized_profile,
        intent=normalized_intent,
        intent_code=intent_code,
    )


def viewer_session_identity_is_current(identity: ViewerSessionIdentity) -> bool:
    try:
        return resolve_viewer_session_identity(
            identity.pdf.path,
            identity.profile_id,
            identity.intent,
        ) == identity
    except (OSError, RuntimeError, ValueError):
        return False


@dataclass(frozen=True)
class ViewerSessionBudgetPolicy:
    total_pool_mb: int
    desired_cache_mb: int
    orphan_ttl_seconds: float


def viewer_session_budget_policy(
    total_ram_mb: float | None,
    available_ram_mb: float | None,
) -> ViewerSessionBudgetPolicy:
    """Pool persistent nhỏ hơn render budget; máy >=16 GB không có ceiling cố định."""
    if total_ram_mb is None or total_ram_mb <= 0:
        return ViewerSessionBudgetPolicy(256, 128, 120.0)
    available = (
        available_ram_mb
        if available_ram_mb is not None and available_ram_mb > 0
        else total_ram_mb
    )
    if total_ram_mb < 8 * 1024:
        return ViewerSessionBudgetPolicy(
            total_pool_mb=max(128, min(256, int(available * 0.08))),
            desired_cache_mb=max(32, min(96, int(available * 0.05))),
            orphan_ttl_seconds=90.0,
        )
    if total_ram_mb < 16 * 1024:
        return ViewerSessionBudgetPolicy(
            total_pool_mb=max(256, min(768, int(available * 0.10))),
            desired_cache_mb=max(96, min(256, int(available * 0.05))),
            orphan_ttl_seconds=180.0,
        )
    # PERF (audit 2026-08-09 §L2C): máy mạnh tăng theo RAM trống, không hard-cap
    # session/cache hay hạ DPI. Pool chỉ giữ persistent resources, không phải render scratch.
    return ViewerSessionBudgetPolicy(
        total_pool_mb=max(512, int(available * 0.125)),
        desired_cache_mb=max(256, int(available * 0.03125)),
        orphan_ttl_seconds=300.0,
    )


@dataclass
class _OwnerBinding:
    last_seen: float
    last_purpose: str
    latest_generation: int | None = None


@dataclass(order=True)
class _RenderWaiter:
    priority: int
    sequence: int
    future: asyncio.Future[None] = field(compare=False)
    owner_id: str = field(compare=False)
    purpose: str = field(compare=False)
    granted: bool = field(default=False, compare=False)
    native_generation: int = field(default=0, compare=False)
    session: PpeSoftproofSession | None = field(default=None, compare=False)


@dataclass
class _SessionEntry:
    identity: ViewerSessionIdentity
    native_owner: str
    owners: dict[str, _OwnerBinding] = field(default_factory=dict)
    session: PpeSoftproofSession | None = None
    open_task: asyncio.Task[None] | None = None
    waiters: list[_RenderWaiter] = field(default_factory=list)
    active_waiter: _RenderWaiter | None = None
    next_sequence: int = 0
    next_native_generation: int = 0
    cache_budget_mb: int = 0
    reserved_mb: int = 0
    transient_session: bool = False
    closing_sessions: int = 0
    close_when_idle: bool = False
    retired: bool = False
    last_used: float = 0.0
    last_purpose: str = "background"


_ClosingSession = tuple[PpeSoftproofSession, str, int, _SessionEntry]


class ViewerSessionLease:
    """Giữ độc quyền shared session xuyên raster → encode → hậu kiểm identity."""

    def __init__(
        self,
        manager: "PpeViewerSessionManager",
        entry: _SessionEntry,
        waiter: _RenderWaiter,
    ) -> None:
        self._manager = manager
        self._entry = entry
        self._waiter = waiter
        self._released = False
        if waiter.session is None:  # chỉ để phòng sai invariant nội bộ
            raise RuntimeError("PPE Viewer lease thiếu native session")
        self.session = waiter.session
        self.native_owner_id = entry.native_owner
        self.native_generation = waiter.native_generation

    async def __aenter__(self) -> "ViewerSessionLease":
        return self

    async def __aexit__(self, _exc_type, _exc, _traceback) -> None:
        await self.release()

    async def release(self) -> None:
        if self._released:
            return
        self._released = True
        await self._manager._finish_render(self._entry, self._waiter)


class PpeViewerSessionManager:
    """Registry dùng khóa rất ngắn; mỗi identity có lane ưu tiên và mutex native riêng."""

    def __init__(
        self,
        *,
        open_session: Callable[..., PpeSoftproofSession] = open_softproof_session,
        memory_status: Callable[[], tuple[float | None, float | None]] = read_memory_status_mb,
        identity_is_current: Callable[
            [ViewerSessionIdentity], bool
        ] = viewer_session_identity_is_current,
        clock: Callable[[], float] = time.monotonic,
        session_overhead_mb: int = _SESSION_OVERHEAD_MB,
        policy_refresh_seconds: float = 2.0,
    ) -> None:
        self._open_session = open_session
        self._memory_status = memory_status
        self._identity_is_current = identity_is_current
        self._clock = clock
        self._session_overhead_mb = max(0, int(session_overhead_mb))
        self._policy_refresh_seconds = max(0.0, float(policy_refresh_seconds))
        self._lock = threading.RLock()
        self._entries: dict[ViewerSessionIdentity, _SessionEntry] = {}
        self._owner_bindings: dict[str, ViewerSessionIdentity] = {}
        self._released_owner_generations: dict[str, tuple[int, float]] = {}
        self._closing_reserved_mb = 0
        self._closing_identity_counts: dict[ViewerSessionIdentity, int] = {}
        self._closing_tasks: set[asyncio.Task[None]] = set()
        self._policy_cache: ViewerSessionBudgetPolicy | None = None
        self._policy_checked_at = float("-inf")

    async def bind_owner(
        self,
        identity: ViewerSessionIdentity,
        *,
        owner_id: str,
        purpose: str,
        owner_generation: int | None = None,
    ) -> None:
        owner = self._normalize_owner(owner_id)
        normalized_purpose = self._normalize_purpose(purpose)
        generation = self._normalize_owner_generation(owner_generation)
        policy = await self._policy()
        sessions_to_close: list[_ClosingSession] = []
        now = self._clock()
        with self._lock:
            self._prune_release_watermarks_locked(now, policy.orphan_ttl_seconds)
            released_through = self._released_owner_generations.get(owner)
            if (
                generation is not None
                and released_through is not None
                and generation <= released_through[0]
            ):
                raise ViewerSessionSuperseded(
                    f"Owner Viewer đã release tới generation {released_through[0]}"
                )
            previous_identity = self._owner_bindings.get(owner)
            previous_entry = (
                self._entries.get(previous_identity)
                if previous_identity is not None
                else None
            )
            previous_binding = (
                previous_entry.owners.get(owner)
                if previous_entry is not None
                else None
            )
            if (
                generation is not None
                and previous_binding is not None
                and previous_binding.latest_generation is not None
                and previous_identity != identity
                and generation <= previous_binding.latest_generation
            ):
                raise ViewerSessionSuperseded(
                    f"Generation {generation} cũ hoặc không khớp revision "
                    f"{previous_binding.latest_generation} của owner Viewer"
                )
            # Chỉ prune owner có side-effect detach session sau khi các
            # validation có thể raise đã qua; nếu không close item vừa
            # tạo có thể không bao giờ được dispatch.
            sessions_to_close.extend(
                self._prune_orphan_owners_locked(now, policy.orphan_ttl_seconds)
            )
            previous_identity = self._owner_bindings.get(owner)
            previous_entry = (
                self._entries.get(previous_identity)
                if previous_identity is not None
                else None
            )
            previous_binding = (
                previous_entry.owners.get(owner)
                if previous_entry is not None
                else None
            )
            if previous_identity is not None and previous_identity != identity:
                sessions_to_close.extend(
                    self._detach_owner_locked(
                        owner,
                        ViewerSessionSuperseded("Owner Viewer đã chuyển revision/profile"),
                    )
                )
            entry = self._entries.get(identity)
            if entry is None or entry.retired:
                entry = _SessionEntry(
                    identity=identity,
                    native_owner=f"ppe-viewer:{uuid.uuid4().hex}",
                    last_used=now,
                    last_purpose=normalized_purpose,
                )
                self._entries[identity] = entry
            entry.close_when_idle = False
            latest_generation = (
                previous_binding.latest_generation
                if previous_binding is not None
                else None
            )
            if generation is not None:
                latest_generation = max(generation, latest_generation or 0)
            entry.owners[owner] = _OwnerBinding(
                now,
                normalized_purpose,
                latest_generation,
            )
            entry.last_used = now
            entry.last_purpose = normalized_purpose
            self._owner_bindings[owner] = identity
        await self._close_sessions(sessions_to_close)

    async def render_lease(
        self,
        identity: ViewerSessionIdentity,
        *,
        owner_id: str,
        purpose: str,
        still_interested: Callable[[], bool] | None = None,
        owner_generation: int | None = None,
    ) -> ViewerSessionLease:
        owner = self._normalize_owner(owner_id)
        normalized_purpose = self._normalize_purpose(purpose)
        await self.bind_owner(
            identity,
            owner_id=owner,
            purpose=normalized_purpose,
            owner_generation=owner_generation,
        )
        loop = asyncio.get_running_loop()
        with self._lock:
            entry = self._entries.get(identity)
            if (
                entry is None
                or entry.retired
                or self._owner_bindings.get(owner) != identity
            ):
                raise ViewerSessionSuperseded("Owner không còn giữ PPE ViewerSession")
            entry.next_sequence += 1
            waiter = _RenderWaiter(
                0 if normalized_purpose == "interactive" else 1,
                entry.next_sequence,
                loop.create_future(),
                owner,
                normalized_purpose,
            )
            heapq.heappush(entry.waiters, waiter)
            entry.last_used = self._clock()
            entry.last_purpose = normalized_purpose
            if (
                entry.session is None
                and entry.open_task is None
                and entry.closing_sessions == 0
                and self._closing_identity_counts.get(identity, 0) == 0
            ):
                entry.open_task = loop.create_task(self._open_and_publish(entry))
            self._grant_next_locked(entry)

        try:
            await waiter.future
        except asyncio.CancelledError:
            await self._cancel_waiter(entry, waiter)
            raise
        if still_interested is not None:
            try:
                interested = bool(still_interested())
            except BaseException:
                # PERF (audit 2026-08-09 §L2C): callback thuộc cache/admission.
                # Dù nó lỗi, lane đã grant phải được nhả; nếu không mọi
                # request sau của cùng PDF sẽ kẹt vĩnh viễn.
                await self._finish_render(entry, waiter)
                raise
            if not interested:
                await self._finish_render(entry, waiter)
                raise ViewerSessionSuperseded(
                    "Request Viewer hết người chờ trước native render"
                )
        return ViewerSessionLease(self, entry, waiter)

    async def release_owner(
        self,
        owner_id: str,
        *,
        through_generation: int | None = None,
    ) -> bool:
        owner = self._normalize_owner(owner_id)
        release_generation = self._normalize_release_generation(through_generation)
        with self._lock:
            if release_generation is not None:
                previous = self._released_owner_generations.get(owner)
                self._released_owner_generations[owner] = (
                    max(release_generation, previous[0] if previous else 0),
                    self._clock(),
                )
            identity = self._owner_bindings.get(owner)
            if identity is None:
                return False
            entry = self._entries.get(identity)
            binding = entry.owners.get(owner) if entry is not None else None
            if (
                release_generation is not None
                and binding is not None
                and binding.latest_generation is not None
                and binding.latest_generation > release_generation
            ):
                # DELETE cũ đến trễ không được đóng lifecycle
                # đã tiến sang generation mới hơn (StrictMode/dev).
                return False
            sessions = self._detach_owner_locked(
                owner,
                ViewerSessionSuperseded("Tab/file Viewer đã đóng"),
            )
        await self._close_sessions(sessions)
        return True

    async def sweep_orphans(self) -> int:
        policy = await self._policy()
        with self._lock:
            before = len(self._owner_bindings)
            now = self._clock()
            sessions = self._prune_orphan_owners_locked(
                now,
                policy.orphan_ttl_seconds,
            )
            self._prune_release_watermarks_locked(
                now,
                policy.orphan_ttl_seconds,
            )
            removed = before - len(self._owner_bindings)
        await self._close_sessions(sessions)
        return removed

    async def close_all(self) -> None:
        sessions: list[_ClosingSession] = []
        open_tasks: list[asyncio.Task[None]] = []
        with self._lock:
            self._owner_bindings.clear()
            self._released_owner_generations.clear()
            for entry in list(self._entries.values()):
                entry.retired = True
                self._fail_all_waiters_locked(
                    entry,
                    ViewerSessionSuperseded("Backend đang đóng PPE ViewerSession"),
                )
                if entry.open_task is not None:
                    open_tasks.append(entry.open_task)
                if entry.session is not None:
                    detached = self._detach_session_locked(entry)
                    if detached is not None:
                        sessions.append(detached)
                else:
                    entry.reserved_mb = 0
                    entry.cache_budget_mb = 0
            self._entries.clear()
        await self._close_sessions(sessions)
        if open_tasks:
            await asyncio.gather(*open_tasks, return_exceptions=True)
        await self._wait_for_closing_tasks()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            entries = [entry for entry in self._entries.values() if not entry.retired]
            return {
                "documents": len(entries),
                "owners": len(self._owner_bindings),
                "open_sessions": sum(entry.session is not None for entry in entries),
                "active_renders": sum(entry.active_waiter is not None for entry in entries),
                "queued_renders": sum(self._live_waiter_count(entry) for entry in entries),
                "reserved_mb": (
                    sum(entry.reserved_mb for entry in entries)
                    + self._closing_reserved_mb
                ),
                "cache_budget_mb": sum(entry.cache_budget_mb for entry in entries),
            }

    async def _open_and_publish(self, entry: _SessionEntry) -> None:
        session: PpeSoftproofSession | None = None
        sessions_to_close: list[_ClosingSession] = []
        try:
            policy = await self._policy()
            with self._lock:
                if entry.retired:
                    return
                purpose = self._entry_open_purpose_locked(entry)
                cache_budget, transient, evicted, deferred = (
                    self._reserve_for_open_locked(entry, policy, purpose)
                )
                sessions_to_close.extend(evicted)
            await self._close_sessions(sessions_to_close)
            if deferred:
                # Trong lúc đóng victim, viewport tương tác có thể đã
                # gia nhập chính entry này. Quyết định defer cũ không được
                # làm request tương tác fail theo; nó phải được mở
                # transient cache=0, giữ nguyên DPI/pixel.
                retry_close: list[_ClosingSession] = []
                with self._lock:
                    if entry.retired:
                        return
                    if self._entry_open_purpose_locked(entry) == "interactive":
                        cache_budget, transient, evicted, deferred = (
                            self._reserve_for_open_locked(
                                entry,
                                policy,
                                "interactive",
                            )
                        )
                        retry_close.extend(evicted)
                    else:
                        # Chốt defer trong cùng lock với việc nhả open_task.
                        # Interactive đến ngay sau đó sẽ tự tạo opener mới,
                        # không bị fail chung với các waiter background này.
                        entry.open_task = None
                        entry.reserved_mb = 0
                        entry.cache_budget_mb = 0
                        self._fail_all_waiters_locked(
                            entry,
                            ViewerBackgroundSessionDeferred(
                                "Hoãn PPE prefetch vì pool session đang dành cho tương tác"
                            ),
                        )
                        if not entry.owners and entry.close_when_idle:
                            self._retire_entry_locked(entry)
                        return
                await self._close_sessions(retry_close)

            # Owner có thể đã đóng trong lúc victim đang close. Tránh
            # mở native session chỉ để đóng lại ngay sau đó.
            with self._lock:
                if entry.retired or (not entry.owners and entry.close_when_idle):
                    entry.open_task = None
                    self._retire_entry_locked(entry)
                    return

            session = await asyncio.to_thread(
                self._open_session,
                entry.identity.pdf.path,
                owner_id=entry.native_owner,
                cmyk_profile_id=entry.identity.profile_id,
                render_intent=entry.identity.intent_code,
                resource_cache_budget_mb=cache_budget,
                # CORRECTNESS (audit 2026-08-31 §LÔ-B): Viewer theo /View và
                # dựng appearance annotation; print/preflight giữ mặc định facade.
                optional_content_usage="view",
                render_annotations=True,
            )
            if not await asyncio.to_thread(self._identity_is_current, entry.identity):
                raise ViewerSessionSuperseded(
                    "PDF/profile thay đổi trong lúc mở PPE ViewerSession"
                )

            close_late: _ClosingSession | None = None
            with self._lock:
                entry.open_task = None
                if entry.retired or (not entry.owners and entry.close_when_idle):
                    entry.retired = True
                    entry.session = session
                    close_late = self._detach_session_locked(entry)
                    session = None
                    self._remove_entry_locked(entry)
                else:
                    entry.session = session
                    entry.cache_budget_mb = cache_budget
                    entry.transient_session = transient
                    entry.last_used = self._clock()
                    self._grant_next_locked(entry)
            if close_late is not None:
                await self._close_sessions([close_late])
        except asyncio.CancelledError:
            close_item: _ClosingSession | None = None
            with self._lock:
                entry.open_task = None
                if session is not None:
                    entry.session = session
                    close_item = self._detach_session_locked(entry)
                    session = None
                else:
                    entry.reserved_mb = 0
                    entry.cache_budget_mb = 0
                self._fail_all_waiters_locked(
                    entry,
                    ViewerSessionSuperseded("Tác vụ mở PPE ViewerSession bị hủy"),
                )
                if not entry.owners and entry.close_when_idle:
                    self._retire_entry_locked(entry)
            if close_item is not None:
                try:
                    await self._close_sessions([close_item])
                except asyncio.CancelledError:
                    # Close task do manager giữ vẫn tiếp tục; state registry đã
                    # được dọn trước await nên cancellation lần hai không
                    # thể làm kẹt entry.
                    pass
            raise
        except BaseException as exc:
            close_item = None
            with self._lock:
                entry.open_task = None
                if session is not None:
                    entry.session = session
                    close_item = self._detach_session_locked(entry)
                    session = None
                else:
                    entry.reserved_mb = 0
                    entry.cache_budget_mb = 0
                entry.transient_session = False
                self._fail_all_waiters_locked(entry, exc)
                # Owner có thể đã release/rebind trong lúc to_thread(open)
                # còn chạy. Sau open lỗi không còn request nào sẽ quay lại
                # dọn entry không owner này, nên phải retire ngay tại đây.
                if not entry.owners and entry.close_when_idle:
                    self._retire_entry_locked(entry)
            if close_item is not None:
                await self._close_sessions([close_item])

    def _reserve_for_open_locked(
        self,
        entry: _SessionEntry,
        policy: ViewerSessionBudgetPolicy,
        purpose: str,
    ) -> tuple[
        int,
        bool,
        list[_ClosingSession],
        bool,
    ]:
        sessions_to_close: list[_ClosingSession] = []

        def used() -> int:
            return self._closing_reserved_mb + sum(
                candidate.reserved_mb
                for candidate in self._entries.values()
                if not candidate.retired and candidate is not entry
            )

        def effective_used() -> int:
            # Opener hiện tại luôn await các victim này trước khi
            # mở session mới, nên được tính phần RAM sắp thu hồi.
            # Opener khác không có credit này và vẫn thấy toàn bộ
            # `_closing_reserved_mb`, tránh double-residency vượt pool.
            closing_credit = sum(item[2] for item in sessions_to_close)
            return max(0, used() - closing_credit)

        desired_reserved = self._session_overhead_mb + policy.desired_cache_mb
        candidates = sorted(
            (
                candidate
                for candidate in self._entries.values()
                if candidate is not entry
                and not candidate.retired
                and candidate.session is not None
                and candidate.active_waiter is None
                and self._live_waiter_count(candidate) == 0
                and candidate.open_task is None
            ),
            key=lambda candidate: (
                0 if candidate.last_purpose == "background" else 1,
                candidate.last_used,
            ),
        )
        while effective_used() + desired_reserved > policy.total_pool_mb and candidates:
            victim = candidates.pop(0)
            detached = self._detach_session_locked(victim)
            if detached is not None:
                sessions_to_close.append(detached)

        available = policy.total_pool_mb - effective_used()
        if available < self._session_overhead_mb:
            if purpose == "background":
                return 0, False, sessions_to_close, True
            # Request tương tác vẫn giữ pixel/DPI; chỉ session này không giữ cache lâu dài.
            entry.reserved_mb = self._session_overhead_mb
            return 0, True, sessions_to_close, False
        cache_budget = min(
            policy.desired_cache_mb,
            max(0, available - self._session_overhead_mb),
        )
        entry.reserved_mb = self._session_overhead_mb + cache_budget
        return cache_budget, False, sessions_to_close, False

    async def _finish_render(
        self,
        entry: _SessionEntry,
        waiter: _RenderWaiter,
    ) -> None:
        sessions: list[_ClosingSession] = []
        with self._lock:
            if entry.active_waiter is waiter:
                entry.active_waiter = None
            waiter.granted = False
            entry.last_used = self._clock()
            self._grant_next_locked(entry)
            if entry.active_waiter is None and self._live_waiter_count(entry) == 0:
                if entry.transient_session:
                    detached = self._detach_session_locked(entry)
                    if detached is not None:
                        sessions.append(detached)
                if entry.close_when_idle and not entry.owners and entry.open_task is None:
                    detached = self._retire_entry_locked(entry)
                    if detached is not None:
                        sessions.append(detached)
        await self._close_sessions(sessions)

    async def _cancel_waiter(
        self,
        entry: _SessionEntry,
        waiter: _RenderWaiter,
    ) -> None:
        if not waiter.future.done():
            waiter.future.cancel()
        if waiter.granted:
            await self._finish_render(entry, waiter)

    def _grant_next_locked(self, entry: _SessionEntry) -> None:
        if entry.retired or entry.session is None or entry.active_waiter is not None:
            return
        while entry.waiters:
            waiter = heapq.heappop(entry.waiters)
            if waiter.future.done():
                continue
            if self._owner_bindings.get(waiter.owner_id) != entry.identity:
                waiter.future.set_exception(
                    ViewerSessionSuperseded("Owner không còn giữ revision này")
                )
                continue
            entry.active_waiter = waiter
            entry.next_native_generation += 1
            waiter.native_generation = entry.next_native_generation
            waiter.session = entry.session
            waiter.granted = True
            waiter.future.set_result(None)
            return

    def _detach_owner_locked(
        self,
        owner: str,
        reason: BaseException,
    ) -> list[_ClosingSession]:
        identity = self._owner_bindings.pop(owner, None)
        if identity is None:
            return []
        entry = self._entries.get(identity)
        if entry is None or entry.retired:
            return []
        entry.owners.pop(owner, None)
        for waiter in entry.waiters:
            if waiter.owner_id == owner and not waiter.future.done():
                waiter.future.set_exception(reason)
        if entry.owners:
            return []
        entry.close_when_idle = True
        if (
            entry.active_waiter is None
            and self._live_waiter_count(entry) == 0
            and entry.open_task is None
        ):
            detached = self._retire_entry_locked(entry)
            return [detached] if detached is not None else []
        return []

    def _prune_orphan_owners_locked(
        self,
        now: float,
        ttl_seconds: float,
    ) -> list[_ClosingSession]:
        sessions: list[_ClosingSession] = []
        stale = [
            owner
            for owner, identity in self._owner_bindings.items()
            if (
                (entry := self._entries.get(identity)) is None
                or (binding := entry.owners.get(owner)) is None
                or now - binding.last_seen >= ttl_seconds
            )
        ]
        for owner in stale:
            sessions.extend(
                self._detach_owner_locked(
                    owner,
                    ViewerSessionSuperseded("Owner Viewer hết TTL"),
                )
            )
        return sessions

    def _prune_release_watermarks_locked(
        self,
        now: float,
        ttl_seconds: float,
    ) -> None:
        for owner, (_generation, released_at) in list(
            self._released_owner_generations.items()
        ):
            if now - released_at >= ttl_seconds:
                self._released_owner_generations.pop(owner, None)

    def _retire_entry_locked(
        self,
        entry: _SessionEntry,
    ) -> _ClosingSession | None:
        if entry.retired:
            return None
        entry.retired = True
        self._remove_entry_locked(entry)
        self._fail_all_waiters_locked(
            entry,
            ViewerSessionSuperseded("PPE ViewerSession đã bị thu hồi"),
        )
        return self._detach_session_locked(entry)

    def _remove_entry_locked(self, entry: _SessionEntry) -> None:
        if self._entries.get(entry.identity) is entry:
            self._entries.pop(entry.identity, None)
        for owner in list(entry.owners):
            if self._owner_bindings.get(owner) == entry.identity:
                self._owner_bindings.pop(owner, None)
        entry.owners.clear()

    def _detach_session_locked(
        self,
        entry: _SessionEntry,
    ) -> _ClosingSession | None:
        session = entry.session
        entry.session = None
        reserved_mb = max(0, entry.reserved_mb)
        entry.cache_budget_mb = 0
        entry.reserved_mb = 0
        entry.transient_session = False
        if session is None:
            return None
        entry.closing_sessions += 1
        self._closing_reserved_mb += reserved_mb
        self._closing_identity_counts[entry.identity] = (
            self._closing_identity_counts.get(entry.identity, 0) + 1
        )
        return session, entry.native_owner, reserved_mb, entry

    def _fail_all_waiters_locked(
        self,
        entry: _SessionEntry,
        exc: BaseException,
    ) -> None:
        while entry.waiters:
            waiter = heapq.heappop(entry.waiters)
            if not waiter.future.done():
                waiter.future.set_exception(exc)

    @staticmethod
    def _live_waiter_count(entry: _SessionEntry) -> int:
        return sum(not waiter.future.done() for waiter in entry.waiters)

    @staticmethod
    def _entry_open_purpose_locked(entry: _SessionEntry) -> str:
        return (
            "interactive"
            if any(
                not waiter.future.done() and waiter.purpose == "interactive"
                for waiter in entry.waiters
            )
            else "background"
        )

    async def _policy(self) -> ViewerSessionBudgetPolicy:
        now = self._clock()
        with self._lock:
            if (
                self._policy_cache is not None
                and now - self._policy_checked_at < self._policy_refresh_seconds
            ):
                return self._policy_cache
        total_mb, available_mb = await asyncio.to_thread(self._memory_status)
        policy = viewer_session_budget_policy(total_mb, available_mb)
        with self._lock:
            self._policy_cache = policy
            self._policy_checked_at = self._clock()
        return policy

    @staticmethod
    def _normalize_owner(owner_id: str) -> str:
        owner = str(owner_id).strip()
        if not owner:
            raise ValueError("owner_id Viewer không được rỗng")
        return owner

    @staticmethod
    def _normalize_purpose(purpose: str) -> str:
        normalized = str(purpose).strip().lower()
        if normalized not in {"interactive", "background"}:
            raise ValueError("purpose Viewer không hợp lệ")
        return normalized

    @staticmethod
    def _normalize_owner_generation(generation: int | None) -> int | None:
        if generation is None:
            return None
        normalized = int(generation)
        if normalized <= 0:
            raise ValueError("owner_generation Viewer phải lớn hơn 0")
        return normalized

    @staticmethod
    def _normalize_release_generation(generation: int | None) -> int | None:
        if generation is None:
            return None
        normalized = int(generation)
        if normalized < 0:
            raise ValueError("through_generation Viewer không được âm")
        return normalized

    async def _close_sessions(
        self,
        sessions: list[_ClosingSession],
    ) -> None:
        if not sessions:
            return
        loop = asyncio.get_running_loop()
        tasks: list[asyncio.Task[None]] = []
        for item in sessions:
            task = loop.create_task(self._close_tracked_session(item))
            with self._lock:
                self._closing_tasks.add(task)
            task.add_done_callback(self._forget_closing_task)
            tasks.append(task)
        # Caller (HTTP DELETE, rebind, sweeper) có thể bị cancel, nhưng
        # close native và reservation RAM là trách nhiệm của manager.
        # Shield giữ task chạy tới close thật; strong-set phía trên
        # ngăn task mất tham chiếu khi caller biến mất.
        await asyncio.gather(*(asyncio.shield(task) for task in tasks))

    async def _close_tracked_session(self, item: _ClosingSession) -> None:
        session, owner, reserved_mb, entry = item
        try:
            await asyncio.to_thread(self._close_session, session, owner)
        finally:
            loop = asyncio.get_running_loop()
            with self._lock:
                entry.closing_sessions = max(0, entry.closing_sessions - 1)
                self._closing_reserved_mb = max(
                    0,
                    self._closing_reserved_mb - reserved_mb,
                )
                remaining_identity_closes = max(
                    0,
                    self._closing_identity_counts.get(entry.identity, 0) - 1,
                )
                if remaining_identity_closes:
                    self._closing_identity_counts[entry.identity] = (
                        remaining_identity_closes
                    )
                else:
                    self._closing_identity_counts.pop(entry.identity, None)
                # Eviction tách wrapper trước khi close thật xong. Nếu
                # request của chính document đó đến trong cửa sổ này,
                # nó đợi close cũ rồi mới mở lại, không giữ hai
                # document/cache cùng revision đồng thời.
                current_entry = self._entries.get(entry.identity)
                if (
                    remaining_identity_closes == 0
                    and current_entry is not None
                    and not current_entry.retired
                    and current_entry.session is None
                    and current_entry.open_task is None
                    and self._live_waiter_count(current_entry) > 0
                ):
                    current_entry.open_task = loop.create_task(
                        self._open_and_publish(current_entry)
                    )

    def _forget_closing_task(self, task: asyncio.Task[None]) -> None:
        if not task.cancelled():
            task.exception()
        with self._lock:
            self._closing_tasks.discard(task)

    async def _wait_for_closing_tasks(self) -> None:
        while True:
            with self._lock:
                pending = [task for task in self._closing_tasks if not task.done()]
            if not pending:
                return
            await asyncio.gather(*pending, return_exceptions=True)

    @staticmethod
    def _close_session(session: PpeSoftproofSession, owner_id: str) -> None:
        try:
            session.close(owner_id)
        except Exception as exc:  # pragma: no cover - phòng thủ lúc shutdown
            logger.warning("Không đóng được PPE ViewerSession %s: %s", owner_id, exc)


viewer_session_manager = PpeViewerSessionManager()
