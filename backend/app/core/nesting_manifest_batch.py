"""Điều phối đọc/kiểm manifest theo batch, không thay thế validator production.

PERF (audit 2026-09-07 §TEMPERF.F): bước đọc thăm dò chỉ lập ngân sách và ghim
SHA-256. Callback ``decode`` vẫn phải chạy đầy đủ trên chính bytes đọc lại. RAM
được giữ tới khi caller hoàn tất source/lease; CPU được nhả trước khi yield.
"""

from __future__ import annotations

import hashlib
import json
import math
import threading
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from typing import Callable, Iterator, Sequence, TypeVar, cast

from app.core.heavy_job_scheduler import (
    HeavyJobMemoryUnavailable,
    HeavyJobQueueCancelled,
    memory_reservation,
)
from app.core.mixed_nesting_service import (
    MIXED_NESTING_KIND,
    memory_budget_mb,
    plan_batch_hardware,
    register_shared_batch_worker_grants,
)

MANIFEST_BATCH_MEMORY_MODEL_VERSION = 1
_MIB = 1024 * 1024
_BATCH_OVERHEAD_BYTES = 64 * _MIB
_RESIDENT_BYTES_PER_JSON_BYTE = 64
_NATIVE_OVERHEAD_BYTES = 16 * _MIB
_BYTES_PER_TRANSFORMED_VERTEX = 48
_BYTES_PER_SOURCE_VERTEX = 256
_BYTES_PER_PLACEMENT = 1024
_BYTES_PER_SPATIAL_MEMBER = 16
_BYTES_PER_SPATIAL_CELL = 96
_MAX_SPATIAL_CELLS_PER_AXIS = 512
_SPATIAL_MEMBERS_PER_ENTRY = 12 + 2 * _MAX_SPATIAL_CELLS_PER_AXIS
_FIXED_NATIVE_BYTES = (
    _NATIVE_OVERHEAD_BYTES
    + 2 * _BYTES_PER_SPATIAL_CELL * _MAX_SPATIAL_CELLS_PER_AXIS**2
)

_ItemT = TypeVar("_ItemT")
_DecodedT = TypeVar("_DecodedT")


class ManifestBatchIntegrityError(ValueError):
    """Bytes/size đổi giữa hai lần đọc; caller ánh xạ về lỗi integrity của store."""


@dataclass(frozen=True)
class _ReadBudget:
    """Chỉ giữ scalar/digest, không giữ cây JSON hay proof quyền đọc nguồn."""

    byte_size: int
    sha256: bytes
    native_bytes: int


def _raise_if_cancelled(check: Callable[[], bool] | None) -> None:
    if check is not None and check():
        raise HeavyJobQueueCancelled("Đã hủy nạp manifest trước khi công bố kết quả.")


def _list(value: object) -> list:
    return value if isinstance(value, list) else []


def _dict(value: object) -> dict:
    return value if isinstance(value, dict) else {}


def _estimate_native_bytes(payload: bytes) -> int:
    """Ước lượng cấp phát từ số lượng thô; tuyệt đối không chứng nhận manifest.

    Trường thiếu/sai kiểu chỉ nhận phần ngân sách đọc được. Decode authoritative
    phía sau vẫn bắt buộc chạy và từ chối schema trước khi native dựng hình học.
    Khi partId méo/không tìm thấy, dùng outer lớn nhất thay vì đánh giá thấp nó.
    """

    try:
        envelope = _dict(json.loads(payload.decode("utf-8")))
    except (UnicodeError, ValueError, RecursionError):
        return _FIXED_NATIVE_BYTES
    production = _dict(envelope.get("productionRequest"))
    request = _dict(production.get("engineRequest"))
    parts = _list(request.get("parts"))
    manifest = _dict(envelope.get("manifest"))
    placements = _list(manifest.get("placements"))
    contract = _dict(request.get("productionContract"))
    obstacles = _list(contract.get("fixedObstacles"))

    outer_by_part: dict[str, int] = {}
    source_vertices = 0
    max_outer = 0
    for raw_part in parts:
        part = _dict(raw_part)
        outer_count = len(_list(part.get("outer")))
        max_outer = max(max_outer, outer_count)
        source_vertices += outer_count + sum(
            len(_list(hole)) for hole in _list(part.get("holes"))
        )
        part_id = part.get("partId")
        if isinstance(part_id, str):
            outer_by_part[part_id] = max(outer_by_part.get(part_id, 0), outer_count)
    for raw_obstacle in obstacles:
        source_vertices += len(_list(_dict(raw_obstacle).get("outer")))

    transformed_vertices = 0
    for raw_placement in placements:
        part_id = _dict(raw_placement).get("partId")
        transformed_vertices += (
            outer_by_part.get(part_id, max_outer)
            if isinstance(part_id, str)
            else max_outer
        )

    # Với hint = mean(extent), r=extent/hint thì sum(r)=N. Khi grid khác 1x1,
    # cell>=hint/2, membership<=min(M²,(2r+2)²). Vì min(M²,4r²)<=2Mr,
    # tổng membership <= (2M+12)N. Dùng N thô bảo vệ cả subset pose bị bỏ qua;
    # header dành cho hai grid part/obstacle, không nhân số tờ vật lý.
    spatial_members = _SPATIAL_MEMBERS_PER_ENTRY * (
        len(placements) + len(obstacles)
    )
    return (
        _FIXED_NATIVE_BYTES
        + _BYTES_PER_TRANSFORMED_VERTEX * transformed_vertices
        + _BYTES_PER_SOURCE_VERTEX * source_vertices
        + _BYTES_PER_PLACEMENT * len(placements)
        + _BYTES_PER_SPATIAL_MEMBER * spatial_members
    )


def _read_exact(
    item: _ItemT,
    expected_size: int,
    read_payload: Callable[[_ItemT, int], bytes],
) -> bytes:
    payload = read_payload(item, expected_size)
    if type(payload) is not bytes or len(payload) != expected_size:
        raise ManifestBatchIntegrityError(
            "Kích thước/nội dung đọc manifest không còn khớp lần kiểm tra."
        )
    return payload


def _batch_memory_plan(
    budgets: Sequence[_ReadBudget],
    planned_workers: int,
    available_mb: float | None,
) -> tuple[int, int]:
    """Chỉ co số lane khi batch đầy đủ không vừa ngân sách RAM thật.

    Đây là admission theo byte, không phải trần worker theo hằng số. RAM không
    đọc được giữ nguyên planner; reservation cuối vẫn đọc lại budget để chặn race.
    """

    resident = _BATCH_OVERHEAD_BYTES + _RESIDENT_BYTES_PER_JSON_BYTE * sum(
        budget.byte_size for budget in budgets
    )
    native_costs = sorted((budget.native_bytes for budget in budgets), reverse=True)
    workers = min(len(budgets), planned_workers)
    required = resident + sum(native_costs[:workers])
    if available_mb is None:
        return workers, required
    budget_mb = float(available_mb)
    if not math.isfinite(budget_mb):
        budget_mb = 0.0
    budget_mb = max(0.0, budget_mb)
    while workers > 1 and required / _MIB > budget_mb:
        workers -= 1
        required -= native_costs[workers]
    if required / _MIB > budget_mb:
        raise HeavyJobMemoryUnavailable(required / _MIB, budget_mb)
    return workers, required


def _decode_parallel(
    items: tuple[_ItemT, ...],
    budgets: Sequence[_ReadBudget],
    workers: int,
    read_payload: Callable[[_ItemT, int], bytes],
    decode: Callable[[_ItemT, bytes], _DecodedT],
    queue_cancelled: Callable[[], bool] | None,
) -> list[_DecodedT]:
    """Tối đa k future/payload đang chạy; mọi đường lỗi đều drain trước khi trả."""

    stop = threading.Event()

    def cancelled() -> bool:
        return stop.is_set() or (queue_cancelled is not None and queue_cancelled())

    def run(index: int) -> _DecodedT:
        _raise_if_cancelled(cancelled)
        receipt = budgets[index]
        payload = _read_exact(items[index], receipt.byte_size, read_payload)
        if hashlib.sha256(payload).digest() != receipt.sha256:
            raise ManifestBatchIntegrityError(
                "Manifest đổi nội dung giữa lần lập ngân sách và kiểm định."
            )
        _raise_if_cancelled(cancelled)
        result = decode(items[index], payload)
        _raise_if_cancelled(cancelled)
        return result

    if workers == 1:
        return [run(index) for index in range(len(items))]

    results: list[object] = [None] * len(items)
    executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="nest-manifest")
    pending = {}
    next_index = 0
    try:
        while next_index < workers:
            _raise_if_cancelled(cancelled)
            pending[executor.submit(run, next_index)] = next_index
            next_index += 1
        while pending:
            _raise_if_cancelled(cancelled)
            completed, _waiting = wait(
                pending, timeout=0.05, return_when=FIRST_COMPLETED
            )
            for future in sorted(completed, key=pending.__getitem__):
                index = pending.pop(future)
                results[index] = future.result()
            while next_index < len(items) and len(pending) < workers:
                _raise_if_cancelled(cancelled)
                pending[executor.submit(run, next_index)] = next_index
                next_index += 1
    except BaseException:
        stop.set()
        for future in pending:
            future.cancel()
        raise
    finally:
        # Không trả/yield khi native cũ còn chạy; callback không có API preempt.
        executor.shutdown(wait=True, cancel_futures=True)
    return cast(list[_DecodedT], results)


@contextmanager
def decode_manifest_batch(
    items: Sequence[_ItemT],
    *,
    get_size: Callable[[_ItemT], int],
    read_payload: Callable[[_ItemT, int], bytes],
    decode: Callable[[_ItemT, bytes], _DecodedT],
    queue_cancelled: Callable[[], bool] | None = None,
) -> Iterator[list[_DecodedT]]:
    """Đọc có ngân sách, full-decode theo input order rồi giữ RAM qua source phase.

    Caller chịu trách nhiệm secure path/regular-file/no-reparse và đọc tối đa
    ``expected_size + 1`` byte. Helper từ chối đổi size/digest; không tự mở path,
    không giữ proof qua request và không can thiệp exception của callback.
    """

    values = tuple(items)
    _raise_if_cancelled(queue_cancelled)
    if not values:
        yield []
        return
    plan = plan_batch_hardware(len(values))
    with ExitStack() as memory_stack:
        lease = register_shared_batch_worker_grants(plan.total_worker_grant)
        try:
            budgets: list[_ReadBudget] = []
            for item in values:
                _raise_if_cancelled(queue_cancelled)
                size = get_size(item)
                if isinstance(size, bool) or not isinstance(size, int) or size < 0:
                    raise ManifestBatchIntegrityError("Kích thước file manifest không hợp lệ.")
                # Không đọc trước cả batch rồi mới hỏi còn đủ RAM hay không.
                with lease.request(1).claim(queue_cancelled):
                    with memory_reservation(
                        MIXED_NESTING_KIND,
                        (_BATCH_OVERHEAD_BYTES + _RESIDENT_BYTES_PER_JSON_BYTE * size) / _MIB,
                        memory_budget_mb,
                        queue_cancelled,
                    ):
                        _raise_if_cancelled(queue_cancelled)
                        payload = _read_exact(item, size, read_payload)
                        try:
                            budgets.append(_ReadBudget(
                                byte_size=size,
                                sha256=hashlib.sha256(payload).digest(),
                                native_bytes=_estimate_native_bytes(payload),
                            ))
                        finally:
                            del payload
            _raise_if_cancelled(queue_cancelled)
            workers, required_bytes = _batch_memory_plan(
                budgets, plan.max_parallel_jobs, memory_budget_mb()
            )
            # Giữ cùng CPU→RAM ordering với solve, tránh hai loại job chờ chéo.
            with lease.request(workers).claim(queue_cancelled):
                memory_stack.enter_context(memory_reservation(
                    MIXED_NESTING_KIND,
                    required_bytes / _MIB,
                    memory_budget_mb,
                    queue_cancelled,
                ))
                decoded = _decode_parallel(
                    values, budgets, workers, read_payload, decode, queue_cancelled
                )
        finally:
            lease.close()
        _raise_if_cancelled(queue_cancelled)
        # Decoder không còn giữ CPU; source resolve/lease vẫn được RAM admission che.
        yield decoded
