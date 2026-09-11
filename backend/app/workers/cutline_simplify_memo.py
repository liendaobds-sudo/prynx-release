"""Tái dùng kết quả Simplify đã kiểm trong phiên, không đọc cache từ đĩa.

PERF (audit 2026-09-10 §SIMPERF.3): memo thuần hình học đi từ worker tin cậy
về session RAM rồi sang worker xuất. Không nhận memo qua JSON HTTP, không
thay mask/màu/khổ trang và không tin SVG theo pixel làm quỹ đạo máy.
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from copy import deepcopy
from functools import wraps
import hashlib
import inspect
import json
import math
from app.workers.cutline_preview_cancel import check_preview_cancelled


_MEMO: ContextVar[dict | None] = ContextVar("cutline_simplify_memo", default=None)


@contextmanager
def simplify_memo_scope(records=None):
    values = deepcopy(records) if isinstance(records, dict) else {}
    token = _MEMO.set(values)
    try:
        yield values
    finally:
        _MEMO.reset(token)


def current_simplify_memo():
    """Dữ liệu picklable để pool con có cùng memo, không có global cache."""
    return _MEMO.get()


def with_simplify_memo(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        supplied = kwargs.pop("_simplify_memo", None)
        if supplied is None:
            return function(*args, **kwargs)
        with simplify_memo_scope(supplied):
            return function(*args, **kwargs)
    return wrapped


def _rings(groups):
    return [[[[[float(v) for v in point] for point in curve] for curve in ring]
             for ring in [group["exterior"], *(group.get("interiors") or [])]] for group in groups]


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
        result, stats = function(path_groups, **options)
        check_preview_cancelled()
        memo[key] = {"rings": [[deepcopy(ring) for ring in [group["exterior"], *(group.get("interiors") or [])]]
                                for group in result] if stats["changed"] else None,
                     "stats": deepcopy(stats)}
        return result, stats
    return wrapped
