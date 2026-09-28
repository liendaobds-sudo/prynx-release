"""Tái dùng kết quả Simplify đã kiểm trong phiên, không đọc cache từ đĩa.

PERF (audit 2026-09-10 §SIMPERF.3): memo thuần hình học đi từ worker tin cậy
về session RAM rồi sang worker xuất. Không nhận memo qua JSON HTTP, không
thay mask/màu/khổ trang và không tin SVG theo pixel làm quỹ đạo máy.
"""
from __future__ import annotations

from contextlib import contextmanager, nullcontext
from contextvars import ContextVar
from copy import deepcopy
from functools import wraps
import hashlib
import inspect
import json
import math
import logging
from multiprocessing.managers import BaseManager, RemoteError
import sys
from threading import Lock
import time
from uuid import uuid4
from app.utils.cutline_debug_log import log_cutline
from app.workers.cutline_preview_cancel import check_preview_cancelled


_MEMO: ContextVar[dict | None] = ContextVar("cutline_simplify_memo", default=None)
_SHARED_MEMO: ContextVar[object | None] = ContextVar("cutline_job_memo", default=None)
logger = logging.getLogger(__name__)
_IPC_ERRORS = (OSError, EOFError, RemoteError)
# Chỉ giới hạn chờ memo khi mất producer/response; KHÔNG giới hạn solver.
# Hết hạn thì tự giải đầy đủ, không trả đường thô hay giảm chất lượng.
_SHARED_WAIT_TIMEOUT_S = 120.0


def _memo_budget_bytes(total_ram_mb):
    """Chỉ hạn chế RAM giữ kết quả trên máy yếu; không giới hạn máy >=16 GB."""
    if total_ram_mb is None or total_ram_mb <= 0 or total_ram_mb >= 16 * 1024:
        return None
    return (16 if total_ram_mb < 8 * 1024 else 64) * 1024 * 1024


def _current_memo_budget_bytes():
    # PERF (audit 2026-09-28 §PERF28.03): chỉ lớp runtime đọc installed;
    # policy và broker nhận RAM minh thị vẫn độc lập với máy chạy.
    from app.core.system_memory import read_memory_status_mb, read_memory_tier_mb

    total_mb, _available_mb = read_memory_status_mb()
    return _memo_budget_bytes(read_memory_tier_mb(total_mb))


def _object_bytes(value, seen=None):
    seen = set() if seen is None else seen
    if id(value) in seen:
        return 0
    seen.add(id(value))
    size = sys.getsizeof(value)
    if isinstance(value, dict):
        size += sum(_object_bytes(k, seen) + _object_bytes(v, seen) for k, v in value.items())
    elif isinstance(value, (tuple, list)):
        size += sum(_object_bytes(item, seen) for item in value)
    return size


class _BoundedMemo(dict):
    """Đầy bộ nhớ thì giải lại bình thường, không hạ chất lượng đường CUT."""
    def __init__(self, max_bytes, initial=None):
        # Snapshot preview đã duyệt phải còn nguyên; chỉ ngừng nhận thêm
        # kết quả mới khi hết budget, không loại đường đang được tham chiếu.
        super().__init__(initial or {})
        self.max_bytes = max_bytes
        self.used_bytes = _object_bytes(dict(self)) if self else 0

    def __setitem__(self, key, value):
        if key in self:
            return
        size = _object_bytes((key, value))
        if self.used_bytes + size <= self.max_bytes:
            super().__setitem__(key, value)
            self.used_bytes += size


class _JobMemoStore:
    """Broker RAM riêng cho một job; RPC ngắn, không giữ khóa khi giải hình học.

    PERF (audit 2026-09-27 §CUT.REUSE): claim theo khóa đầy đủ để worker khác
    không tính lại cùng khuôn. Lock nằm bên trong RPC nên worker bị kill không
    để lại khóa process giữ mãi. Pool hỏng sẽ đóng broker trước lần retry mới.
    """
    def __init__(self, records=None, max_bytes=None):
        self._records = {} if max_bytes is None else _BoundedMemo(max_bytes)
        for key, record in (records or {}).items():
            self._records[key] = deepcopy(record)
        self._pending = {}
        self._lock = Lock()
        self._computed = self._hits = self._waits = 0

    def claim(self, key, owner):
        with self._lock:
            if key in self._records:
                self._hits += 1
                return "hit", deepcopy(self._records[key])
            if key in self._pending:
                self._waits += 1
                return "wait", None
            self._pending[key] = owner
            self._computed += 1
            return "compute", None

    def publish(self, key, owner, record):
        with self._lock:
            if self._pending.get(key) != owner:
                return
            self._records[key] = deepcopy(record)
            del self._pending[key]

    def abandon(self, key, owner):
        with self._lock:
            if self._pending.get(key) == owner:
                del self._pending[key]

    def stats(self):
        with self._lock:
            return dict(computed=self._computed, hits=self._hits, waits=self._waits,
                        entries=len(self._records), pending=len(self._pending))


class _JobMemoManager(BaseManager):
    pass


_JobMemoManager.register("MemoStore", _JobMemoStore)


@contextmanager
def shared_simplify_job(*, enabled, records=None, total_ram_mb=None):
    """Broker chỉ sống cùng pool của job; không cache đĩa/HTTP hay qua tài liệu."""
    if not enabled:
        yield None
        return
    manager = _JobMemoManager()
    try:
        manager.start()
    except (OSError, RuntimeError) as error:
        logger.warning("Không mở được memo CUT dùng chung (%s); giữ solver cũ.", type(error).__name__)
        yield None
        return
    try:
        proxy = manager.MemoStore(records, _memo_budget_bytes(total_ram_mb))
        yield proxy
        try:
            logger.info("[STICKER_MEMO] %s", proxy.stats())
        except _IPC_ERRORS:
            pass
    finally:
        manager.shutdown()


@contextmanager
def simplify_memo_scope(records=None, *, budget_bytes=None):
    values = deepcopy(dict(records)) if isinstance(records, dict) else {}
    if budget_bytes is not None:
        values = _BoundedMemo(budget_bytes, values)
    token = _MEMO.set(values)
    try:
        yield values
    finally:
        _MEMO.reset(token)


def current_simplify_memo():
    """Dữ liệu picklable để pool con có cùng memo, không có global cache."""
    values = _MEMO.get()
    return dict(values) if isinstance(values, _BoundedMemo) else values


def with_simplify_memo(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        supplied = kwargs.pop("_simplify_memo", None)
        shared = kwargs.pop("_shared_simplify_memo", None)
        # Không làm mất memo scope của preview đang thu kết quả để bàn giao.
        if supplied is not None:
            scope = simplify_memo_scope(supplied, budget_bytes=_current_memo_budget_bytes())
        elif _MEMO.get() is not None:
            scope = nullcontext()
        else:
            scope = simplify_memo_scope(budget_bytes=_current_memo_budget_bytes())
        token = _SHARED_MEMO.set(shared) if shared is not None else None
        try:
            with scope:
                return function(*args, **kwargs)
        finally:
            if token is not None:
                _SHARED_MEMO.reset(token)
    return wrapped


def _rings(groups):
    return [[[[[float(v) for v in point] for point in curve] for curve in ring]
             for ring in [group["exterior"], *(group.get("interiors") or [])]] for group in groups]


def _restore_cached(path_groups, cached):
    stats = deepcopy(cached["stats"])
    if not stats["changed"]:
        return path_groups, stats
    # Metadata thuộc caller hiện tại, không lấy tên/id của lần trước.
    result = []
    for original, rings in zip(path_groups, cached["rings"]):
        group = {**original, "exterior": deepcopy(rings[0])}
        if "interiors" in original or len(rings) > 1:
            group["interiors"] = deepcopy(rings[1:])
        result.append(group)
    return result, stats


def memoized_simplify(function):
    signature = inspect.signature(function)
    @wraps(function)
    def wrapped(path_groups, **options):
        # PERF (audit 2026-09-11 §PREWARM.CANCEL): cache hit cũng không được
        # hồi sinh job đã hủy hoặc trả no-op như một kết quả ready mới.
        check_preview_cancelled()
        memo = _MEMO.get()
        if memo is None:
            return function(path_groups, **options)
        from app.workers.cutline_cubic_simplify import CUTLINE_SIMPLIFY_ALGORITHM

        bound = signature.bind(path_groups, **options)
        bound.apply_defaults()
        parameters = {key: value for key, value in bound.arguments.items() if key != "path_groups"}
        try:
            tolerance = float(parameters["tolerance_mm"])
            units = float(parameters["mm_to_units"])
            frame = [float(parameters[key]) for key in ("offset_x_points", "offset_y_points", "page_height")]
            if not 0 < tolerance <= .1 or units <= 0 or not all(map(math.isfinite, [tolerance, units, *frame])):
                raise ValueError("Không dùng memo cho dung sai/đơn vị/frame này")
            key = hashlib.sha256(json.dumps({"algorithm": CUTLINE_SIMPLIFY_ALGORITHM,
                "rings": _rings(path_groups), "options": parameters},
                sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
        except (TypeError, ValueError, KeyError, OverflowError):
            key = None
        if key is None:
            return function(path_groups, **options)
        cached = memo.get(key)
        if cached is not None:
            log_cutline("SIMPLIFY", "MEMO_HIT", f"local key={key[:12] if key else 'None'}")
            return _restore_cached(path_groups, cached)
        shared, owner = _SHARED_MEMO.get(), uuid4().hex
        if shared is not None:
            waiting_since = time.monotonic()
            try:
                while True:
                    check_preview_cancelled()
                    state, cached = shared.claim(key, owner)
                    if state == "hit":
                        check_preview_cancelled()
                        log_cutline("SIMPLIFY", "MEMO_HIT", f"shared key={key[:12] if key else 'None'}")
                        return _restore_cached(path_groups, cached)
                    if state == "compute":
                        break
                    if time.monotonic() - waiting_since >= _SHARED_WAIT_TIMEOUT_S:
                        # Cache là tối ưu tùy chọn: claim mồ côi không được
                        # khiến trang chờ mãi. Không chiếm/xóa claim của người khác.
                        _SHARED_MEMO.set(None)
                        shared = None
                        break
                    time.sleep(.02)
            except _IPC_ERRORS:
                # Broker chỉ tiết kiệm công việc. Mất IPC vẫn phải xuất đúng
                # hình học bằng chính solver, không trả placeholder/đường thô.
                # Claim có thể đã tới server trước khi client mất response.
                try:
                    shared.abandon(key, owner)
                except _IPC_ERRORS:
                    pass
                _SHARED_MEMO.set(None)
                shared = None
        try:
            log_cutline("SIMPLIFY", "MEMO_MISS", f"computing key={key[:12] if key else 'None'}")
            result, stats = function(path_groups, **options)
            check_preview_cancelled()
            record = {"rings": [[deepcopy(ring) for ring in [group["exterior"], *(group.get("interiors") or [])]]
                                for group in result] if stats["changed"] else None,
                      "stats": deepcopy(stats)}
            if shared is None:
                memo[key] = record
            else:
                try:
                    shared.publish(key, owner, record)
                except _IPC_ERRORS:
                    _SHARED_MEMO.set(None)
                    memo[key] = record
            return result, stats
        finally:
            if shared is not None:
                try:
                    shared.abandon(key, owner)
                except _IPC_ERRORS:
                    pass
    return wrapped
