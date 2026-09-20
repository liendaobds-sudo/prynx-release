"""Kế hoạch số lượng cho bình tem bế nhiều tờ — M72.A (2026-09-19).

Chỉ kiểm đếm/identity, không giải hình học và không sửa manifest native.
Kế hoạch cơ sở được đối soát rồi mới nhân số lần in; geometry validator vẫn là
thẩm quyền riêng. Production giữ manifest native đầy đủ và suy số lần in từ
recipe lossless; chốt số lượng ở đây kiểm độc lập trước preview/export.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from functools import reduce
import hashlib
import json
from math import gcd
from typing import Any

ORDER_PLAN_VERSION = "nesting-order/v1"
QuantityPairs = tuple[tuple[str, int], ...]


class NestingOrderError(ValueError):
    """Đơn hàng hoặc số lượng trong kế hoạch không thể đưa vào sản xuất."""


def _positive_int(value: Any, field: str, *, allow_zero: bool = False) -> int:
    if type(value) is not int or value < (0 if allow_zero else 1):
        raise NestingOrderError(f"{field} phải là số nguyên {'không âm' if allow_zero else 'dương'}.")
    return value


def _identifier(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip() or value != value.strip():
        raise NestingOrderError(f"{field} không hợp lệ.")
    return value


def _quantities(value: Any, field: str) -> QuantityPairs:
    if not isinstance(value, Mapping) or not value:
        raise NestingOrderError(f"{field} cần ít nhất một mẫu.")
    pairs = tuple(sorted(
        (_identifier(key, "Mã mẫu"), _positive_int(count, field, allow_zero=True))
        for key, count in value.items()
    ))
    if not any(count for _, count in pairs):
        raise NestingOrderError("Hãy nhập số lượng lớn hơn 0 cho ít nhất một mẫu.")
    return pairs


def _hash(payload: Mapping[str, Any]) -> str:
    try:
        raw = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise NestingOrderError("Kế hoạch chứa dữ liệu không thể lưu an toàn.") from exc
    return "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class NestingOrderDemand:
    requested: QuantityPairs
    base: QuantityPairs
    repeat_count: int

    def to_payload(self) -> dict[str, Any]:
        payload = {
            "version": ORDER_PLAN_VERSION,
            "requestedByPart": dict(self.requested),
            "baseByPart": dict(self.base),
            "repeatCount": self.repeat_count,
        }
        return {**payload, "orderFingerprint": _hash(payload)}

    @property
    def fingerprint(self) -> str:
        return self.to_payload()["orderFingerprint"]

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> NestingOrderDemand:
        if not isinstance(payload, Mapping):
            raise NestingOrderError("Đơn hàng đã lưu không hợp lệ.")
        demand = normalize_order_demand(payload.get("requestedByPart"))
        # JSON phân biệt true/1/1.0; so dict thuần của Python không phân biệt.
        if _hash(payload) != _hash(demand.to_payload()):
            raise NestingOrderError("Identity/số lượng đơn hàng đã lưu không khớp.")
        return demand


def normalize_order_demand(requested: Mapping[str, int]) -> NestingOrderDemand:
    """Rút hệ số lặp chung, không đổi số lượng giao của bất kỳ loại nào.

    72 loại x 100 -> cơ sở 72 loại x 1, lặp 100 lần. Với SL khác nhau chỉ rút
    ước chung thật; không làm tròn hoặc gán cùng một lượng cho mọi loại.
    """
    quantities = _quantities(requested, "Số lượng yêu cầu")
    repeats = reduce(gcd, (count for _, count in quantities if count > 0))
    return NestingOrderDemand(
        quantities,
        tuple((part_id, count // repeats) for part_id, count in quantities if count > 0),
        repeats,
    )


@dataclass(frozen=True, slots=True)
class OrderLayoutRun:
    layout_id: str
    counts: QuantityPairs
    run_count: int

    def to_payload(self) -> dict[str, Any]:
        return {"layoutId": self.layout_id, "countsByPart": dict(self.counts), "runCount": self.run_count}


@dataclass(frozen=True, slots=True)
class NestingOrderPlan:
    demand: NestingOrderDemand
    layout_fingerprint: str
    layouts: tuple[OrderLayoutRun, ...]
    produced: QuantityPairs

    @property
    def template_count(self) -> int:
        return len(self.layouts)

    @property
    def physical_sheet_count(self) -> int:
        return sum(layout.run_count for layout in self.layouts)

    def to_payload(self) -> dict[str, Any]:
        payload = {
            "version": ORDER_PLAN_VERSION,
            "order": self.demand.to_payload(),
            "layoutFingerprint": self.layout_fingerprint,
            "layouts": [layout.to_payload() for layout in self.layouts],
            "producedByPart": dict(self.produced),
            "templateCount": self.template_count,
            "physicalSheetCount": self.physical_sheet_count,
        }
        return {**payload, "planFingerprint": _hash(payload)}

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> NestingOrderPlan:
        if not isinstance(payload, Mapping):
            raise NestingOrderError("Kế hoạch đã lưu không hợp lệ.")
        demand = NestingOrderDemand.from_payload(payload.get("order"))
        raw_layouts = payload.get("layouts")
        if not isinstance(raw_layouts, list):
            raise NestingOrderError("Danh sách bố cục đã lưu không hợp lệ.")
        base_layouts = []
        for layout in raw_layouts:
            if not isinstance(layout, Mapping):
                raise NestingOrderError("Bố cục đã lưu không hợp lệ.")
            runs = _positive_int(layout.get("runCount"), "Số lần in")
            if runs % demand.repeat_count:
                raise NestingOrderError("Số lần in không khớp hệ số lặp của đơn hàng.")
            base_layouts.append({**layout, "runCount": runs // demand.repeat_count})
        plan = build_order_plan(
            demand, base_layouts, layout_fingerprint=payload.get("layoutFingerprint"),
        )
        if _hash(payload) != _hash(plan.to_payload()):
            raise NestingOrderError("Identity/thống kê kế hoạch đã lưu không khớp.")
        return plan


def _require_exact_quantities(requested: Mapping[str, int], actual: Mapping[str, int]) -> None:
    missing = sum(max(0, count - actual.get(part, 0)) for part, count in requested.items())
    if missing:
        total = sum(requested.values())
        raise NestingOrderError(
            f"Đơn hàng chưa đủ: mới xếp {total - missing}/{total} tem, còn thiếu {missing} tem. "
            "Chưa thể xuất file sản xuất; hãy tiếp tục tính hoặc kiểm tra khổ giấy và thiết lập xếp."
        )
    if any(actual.get(part, 0) != count for part, count in requested.items()) or any(
        part not in requested for part in actual
    ):
        raise NestingOrderError("Số lượng thực không khớp đơn hàng: có mẫu lạ hoặc in dư ngoài yêu cầu.")


def build_order_plan(
    demand: NestingOrderDemand,
    base_layouts: Sequence[Mapping[str, Any]],
    *,
    layout_fingerprint: str,
) -> NestingOrderPlan:
    """Gắn số lần in vào các bố cục ĐÃ tính, không tự suy hoặc gộp hình học.

    layoutId/layoutFingerprint phải đến từ kế hoạch hình học authoritative.
    Hash ở đây là identity, không thay cho xác thực nguồn/hình học của pipeline.
    """
    if not isinstance(demand, NestingOrderDemand):
        raise NestingOrderError("Thiếu đơn hàng đã chuẩn hóa.")
    # Không tin object do caller tự khởi tạo với hệ số lặp không đúng.
    demand = NestingOrderDemand.from_payload(demand.to_payload())
    _identifier(layout_fingerprint, "Identity bố cục")
    if not isinstance(base_layouts, Sequence) or isinstance(base_layouts, (str, bytes)):
        raise NestingOrderError("Danh sách bố cục cơ sở không hợp lệ.")
    requested = dict(demand.requested)
    layouts = []
    produced: Counter[str] = Counter()
    seen: set[str] = set()
    for value in base_layouts:
        if not isinstance(value, Mapping) or set(value) != {"layoutId", "countsByPart", "runCount"}:
            raise NestingOrderError("Bố cục cần mã, số con từng loại và số lần lặp cơ sở.")
        layout_id = _identifier(value["layoutId"], "Mã bố cục")
        if layout_id in seen:
            raise NestingOrderError("Mã bố cục bị trùng; không được gộp chỉ dựa vào số lượng.")
        seen.add(layout_id)
        counts = _quantities(value["countsByPart"], "Số con trên bố cục")
        if any(part not in requested for part, _ in counts):
            raise NestingOrderError("Bố cục chứa mẫu không thuộc đơn hàng.")
        runs = _positive_int(value["runCount"], "Số lần lặp cơ sở") * demand.repeat_count
        layouts.append(OrderLayoutRun(layout_id, counts, runs))
        for part, count in counts:
            produced[part] += count * runs
    _require_exact_quantities(requested, produced)
    return NestingOrderPlan(
        demand, layout_fingerprint, tuple(layouts),
        tuple((part, produced.get(part, 0)) for part in requested),
    )


def require_fulfilled_manifest(requested: Mapping[str, int], manifest: Mapping[str, Any]) -> None:
    """Chốt SL độc lập trước export; validation.valid có thể vẫn còn unplaced."""
    expected = dict(_quantities(requested, "Số lượng yêu cầu"))
    if not isinstance(manifest, Mapping):
        raise NestingOrderError("Thiếu manifest để kiểm tra đủ đơn hàng.")
    placements = manifest.get("placements")
    unplaced = manifest.get("unplaced")
    if not isinstance(placements, list) or not isinstance(unplaced, list):
        raise NestingOrderError("Thiếu danh sách xếp/chưa xếp để kiểm tra đủ đơn hàng.")
    actual: Counter[str] = Counter()
    instances: set[str] = set()
    for placement in placements:
        if not isinstance(placement, Mapping):
            raise NestingOrderError("Danh sách mẫu đã xếp không hợp lệ.")
        instance_id = _identifier(placement.get("instanceId"), "Định danh bản in")
        if instance_id in instances:
            raise NestingOrderError("Bản in bị trùng định danh; chưa thể xác nhận đủ đơn hàng.")
        instances.add(instance_id)
        part = _identifier(placement.get("partId"), "Mã mẫu đã xếp")
        actual[part] += 1
    _require_exact_quantities(expected, actual)
    if unplaced:
        raise NestingOrderError("Đơn hàng còn bản chưa xếp; chưa thể xuất file sản xuất.")
    stats = manifest.get("stats") or {}
    if not isinstance(stats, Mapping):
        raise NestingOrderError("Thống kê đơn hàng không hợp lệ.")
    for key, value in (("placedCount", len(placements)), ("unplacedCount", 0)):
        if key in stats and (type(stats[key]) is not int or stats[key] != value):
            raise NestingOrderError("Thống kê số lượng không khớp danh sách bản in.")
