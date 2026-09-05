"""Cầu nối từ thiết lập job N-Up sang pipeline nesting theo đường bế.

NEST (audit 2026-08-28 §A4b-4). Đây là mắt xích cuối để "Nesting tối ưu theo
đường bế" tới được người dùng. Trước lô này `nesting_production_pipeline` không
có bất kỳ caller production nào — chỉ test dùng.

Vị trí trong đường chạy::

    UI → processHandlers → POST /nup-start → _launch_impose_job
      → _spawn_nup_process → run_nup_engine → _run_nup_engine_impl
          ├─ gridStrategy == 'true_shape_nesting' → MODULE NÀY          (mới)
          ├─ imposerMode == 'cnc'                → run_cnc_two_sided
          └─ còn lại                             → lưới grid như cũ

Đặt nhánh mới **trước** nhánh CNC vì nesting phục vụ cả Bình tem bế lẫn Bình CNC;
để sau thì job CNC không bao giờ tới được đây.

Module này chỉ **dịch hợp đồng**: `settings` (camelCase, mm, phẳng theo trang) →
`ProductionNestingJobInput` (dataclass, mm, theo mẫu). Mọi quyết định hình học
thuộc pipeline; ở đây không tính layout.

## Fail-closed, không âm thầm đổi cách xếp

Token nesting người dùng chọn tường minh luôn fail-closed. Auto-route chỉ được lùi
engine legacy khi module phát `TrueShapeCompatibilityFallback` hoặc
`TrueShapeQualityFallback`; mọi lỗi contract/manifest/writer và `ValueError` chưa
phân loại phải thoát ra để không che regression bằng một artifact khác preview.
"""

from __future__ import annotations

import logging
import math
import os
import secrets
import time
from decimal import Decimal, ROUND_HALF_EVEN
from typing import Any, Dict, Iterable, Mapping

from app.core.nesting_imposition_bundle import (
    DUPLEX_REGISTRATION_CIRCLE_DIAMETER_MM,
    DUPLEX_REGISTRATION_LINE_LENGTH_MM,
    DUPLEX_REGISTRATION_MARGIN_MM,
    DUPLEX_REGISTRATION_STROKE_WIDTH_MM,
)
from app.schemas.mixed_nesting import MAX_SHEETS_LIMIT

logger = logging.getLogger(__name__)

#: Giá trị strategy trên đường truyền. Phải trùng
#: `desktop/src/components/imposition-tools/trueShapeNestingRollout.ts`.
TRUE_SHAPE_NESTING_STRATEGY = "true_shape_nesting"

#: Metadata nội bộ do process API tự dò và bàn giao sang process export.
#: Route phải xoá giá trị cùng tên do client gửi trước khi gắn map này.
DETECTED_TRIM_DIMENSIONS_SETTING = "_serverDetectedTrimDimensionsMmByPage"
#: Hash report server-owned đi cùng reference preview qua ranh giới process.
#: Đây là provenance của overlay, KHÔNG phải identity layout/manifest.
REPORT_HASH_FIELD = "reportHash"
_MM_PER_PT = 25.4 / 72.0


class TrueShapeAutoFallback(ValueError):
    """Signal duy nhất cho phép auto-route lùi về engine legacy."""


class TrueShapeCompatibilityFallback(TrueShapeAutoFallback):
    """Intent hợp lệ nhưng true-shape chưa có capability tương đương."""


class TrueShapeQualityFallback(TrueShapeAutoFallback):
    """Cổng chất lượng đã chứng minh engine legacy cho kết quả tốt hơn."""


#: Trần protocol/core cho ``quantity_fulfillment``. UI không gửi field này;
#: adapter dùng trường hợp xấu nhất 1 con/tờ nhưng không được hạ âm thầm xuống 200.
#: Schema Python và Rust cùng chặn trên ở 10.000.
MAX_SHEETS_CEILING = MAX_SHEETS_LIMIT

#: Trần thời gian tìm kiếm của một lượt bình, ms.
#:
#: PERF (audit 2026-08-28 §NEST-DEFAULTS): 3000ms là mức đo được cho tờ bình **đủ tốt**
#: trên file khách — cùng `placedCount` với ngân sách 5000ms, và `unplaced` rỗng ở ca
#: 13 mẫu × 50 con. Tăng ngân sách không cho thêm con nào mà chỉ tốn thời gian chờ.
DEFAULT_TIME_BUDGET_MS = 3000

#: Ngân sách search rút gọn cho S&R trên máy dưới 16 GB.
#:
#: PERF (audit 2026-08-31 §SR-BUDGET-GATE): số đo NF-BUDGET cho thấy 1 ms vẫn giữ
#: baseline đầy đủ và bỏ phần trial không thắng ở bộ ca S&R. Tuy nhiên đây là cap chất
#: lượng, nên chỉ được áp khi đã có intent S&R tường minh VÀ máy yếu. N-up autofill,
#: máy >=16 GB hoặc không đọc được RAM đều giữ `DEFAULT_TIME_BUDGET_MS`.
#:
#: KHÔNG dùng 0 — adapter chặn `timeBudgetMs <= 0`. Env là escape hatch tường minh và
#: chỉ áp cho lane S&R, không được vô tình hạ mọi bài autofill.
AUTOFILL_TIME_BUDGET_MS = 1


def _step_repeat_time_budget_ms() -> int:
    """Ngân sách S&R theo RAM; env override thắng auto và luôn dương."""

    raw = os.environ.get("PRYNX_NEST_AUTOFILL_SEARCH_MS", "")
    if raw:
        try:
            forced = int(raw)
        except (TypeError, ValueError):
            forced = 0
        if forced > 0:
            return forced

    from app.core.system_memory import read_memory_status_mb

    total_ram_mb, _available_ram_mb = read_memory_status_mb()
    if total_ram_mb is not None and 0 < total_ram_mb < 16 * 1024:
        return AUTOFILL_TIME_BUDGET_MS
    return DEFAULT_TIME_BUDGET_MS


def _time_budget_ms(layout_intent: str) -> int:
    """Chỉ S&R máy yếu được giảm; mọi lane khác giữ ngân sách đầy đủ."""

    if layout_intent == "step_repeat_single_sheet":
        return _step_repeat_time_budget_ms()
    return DEFAULT_TIME_BUDGET_MS


def is_true_shape_nesting_requested(settings: Mapping[str, Any]) -> bool:
    """Job có yêu cầu nesting theo đường bế hay không.

    Chỉ đọc `gridStrategy`; không đọc cờ rollout. Tách hai việc để nhánh gọi
    phân biệt được "người dùng có yêu cầu" với "hệ thống có cho phép", nhờ đó khi
    cờ tắt vẫn báo được lỗi đúng nguyên nhân.
    """

    return (
        str(settings.get("gridStrategy") or "").strip()
        == TRUE_SHAPE_NESTING_STRATEGY
    )


def _tool_from_settings(settings: Mapping[str, Any]) -> str:
    """Suy công cụ theo đúng thứ tự ưu tiên của `_launch_impose_job`.

    `imposerMode == 'cnc'` thắng `isDieCutMode`, vì CNC cũng bật cờ die-cut.
    """

    if str(settings.get("imposerMode") or "").strip().lower() == "cnc":
        return "cnc_imposer"
    if bool(settings.get("isDieCutMode", False)):
        return "sticker_imposer"
    raise TrueShapeCompatibilityFallback(
        "Nesting tối ưu theo đường bế chỉ dùng cho Bình tem bế và Bình Bế Rớt CNC."
    )


def _shape_is_special(value: Any) -> bool:
    """Hình "đặc biệt" = CUSTOM (không khớp mẫu có tên). Thiếu/không nhận ra ⇒ đặc biệt.

    Hình có tên (tam giác, ngũ giác, chữ nhật…) đã có tiler chuyên biệt riêng nên KHÔNG
    đi true-shape — đó là ranh giới người dùng chốt ở §B10.
    """

    if value is None or (isinstance(value, str) and not value.strip()):
        return True
    try:
        from app.workers.shape_types import ShapeType, coerce_shape_type

        return coerce_shape_type(value) == ShapeType.CUSTOM
    except Exception:  # noqa: BLE001 — giá trị lạ ⇒ coi như đặc biệt (chọn true-shape)
        return True


def _job_has_special_shape(settings: Mapping[str, Any]) -> bool:
    """Job có ÍT NHẤT một mẫu đặc biệt không.

    Đây là mệnh đề "quy về đặc biệt hết": gang lẫn named + CUSTOM ⇒ có CUSTOM ⇒ cả tờ
    true-shape. Tập trang xét đúng bằng tập trang build_true_shape_nesting_job sẽ dựng.
    """

    shapes = settings.get("detectedShapesByPage")
    if not isinstance(shapes, Mapping):
        # Chưa dò khuôn ⇒ thận trọng coi là đặc biệt (die-cut không mẫu tên = CUSTOM).
        return True
    quantities = _page_quantities(settings)
    pages = sorted(quantities) if quantities else _autofill_pages(settings)
    for page in pages:
        value = shapes.get(str(page))
        if value is None:
            value = shapes.get(page)
        if _shape_is_special(value):
            return True
    return False


def route_true_shape(settings: Mapping[str, Any]) -> bool:
    """Có TỰ ĐỘNG định tuyến job sang true-shape nesting không (§B10).

    Đúng khi: die-cut/CNC + "Xếp tối ưu" (`optimal_auto`) + có ≥1 mẫu đặc biệt (CUSTOM),
    và KHÔNG phải nguyên tấm decal / mixed_guillotine / 1 Dao (`one_dao` = cắt chữ nhật).
    Phủ cả Bình trang (S&R), gang một mẫu, và gang lẫn named + đặc biệt. Job toàn hình
    có-tên ⇒ False ⇒ engine chuyên biệt cũ. "Lưới đơn giản"/manual ⇒ False ⇒ giữ lưới bbox.

    Gói sau CÙNG cờ master của true-shape (`true_shape_nesting_enabled` ↔ frontend
    `TRUE_SHAPE_NESTING_ENABLED`, cặp parity đã có): dev mở, bản phát hành HOLD tới khi bật
    tường minh. Nhờ vậy preview (frontend) và export (backend) luôn cùng quyết định, và
    test (DEV_MODE=false) không vô tình kích hoạt.

    VỊ NGỮ THUẦN: mọi bất thường ⇒ False để đường cũ tự báo lỗi đúng nguyên nhân. KHÔNG ném.
    """

    from app.core.nesting_rollout import true_shape_nesting_enabled

    if not true_shape_nesting_enabled():
        return False
    try:
        # PARITY (audit 2026-08-30 §B10-6): user đã hủy/preview đã chốt publication
        # lưới thì export phải giữ đúng engine đó, không tự solve true-shape lần nữa.
        if settings.get("forceLegacyGrid", False) is True:
            return False
        is_cnc = str(settings.get("imposerMode") or "").strip().lower() == "cnc"
        if not is_cnc and not bool(settings.get("isDieCutMode", False)):
            return False  # guillotine / N-Up thường: true-shape không áp
        if settings.get("page_sheet_mode", False) is True:
            return False
        if str(settings.get("layoutType") or "").strip() == "mixed_guillotine":
            return False
        if str(settings.get("gridStrategy") or "").strip() != "optimal_auto":
            return False
        if str(settings.get("cutType") or "").strip().lower() == "one_dao":
            return False  # 1 Dao = cắt chữ nhật (xem rectangle_inking_is_allowed): tiler cũ
        if _unsupported_true_shape_reason(settings) is not None:
            return False
        return _job_has_special_shape(settings)
    except Exception:  # noqa: BLE001 — predicate không được ném
        return False


def wants_true_shape_nesting(settings: Mapping[str, Any]) -> bool:
    """Job có ĐI true-shape nesting không — HỢP của hai tín hiệu, khớp đúng dispatch.

    `_run_nup_engine_impl` vào true-shape khi `is_true_shape_nesting_requested` (người dùng
    chọn tay — token `true_shape_nesting`, còn dùng ở đường PREVIEW) HOẶC `route_true_shape`
    (tự động: CUSTOM + "Xếp tối ưu" trên die-cut/CNC). MỌI nơi khác hỏi "đây có phải job
    nesting không" (guard scope, gắn tham chiếu phiên) PHẢI dùng đúng hợp này — nếu mỗi
    surface tự quyết một kiểu thì preview / guard / bàn giao phiên sẽ lệch nhau.

    Ví dụ lệch đã gặp: preview S&R CUSTOM gửi settings mang token nhưng `gridStrategy != 'optimal_auto'`,
    khiến `route_true_shape` (đơn lẻ) trả False và `_guard_scope` chặn nhầm "S&R chưa mở".
    """

    return is_true_shape_nesting_requested(settings) or route_true_shape(settings)


def _is_step_repeat(settings: Mapping[str, Any]) -> bool:
    """Nhận diện Bình trang từ contract mới hoặc payload cũ đã mất taskMode.

    `layoutType="repeat"` là tín hiệu authoritative từ engine lưới cũ. Giữ thêm
    `taskMode` để preview/export có cùng identity, nhưng không phụ thuộc riêng vào nó.
    """

    task_mode = str(settings.get("taskMode") or "").strip().lower()
    layout_type = str(settings.get("layoutType") or "").strip().lower()
    return task_mode in ("step_repeat", "sr") or layout_type == "repeat"


def _unsupported_true_shape_reason(settings: Mapping[str, Any]) -> str | None:
    """Lý do một ý định UI chưa có semantics tương đương trong core true-shape.

    Payload production luôn mang nhiều default ẩn, nên chỉ chặn intent đang hoạt động.
    Auto-route dùng hàm này để giữ lane legacy; token thủ công dùng cùng lý do để báo
    lỗi rõ thay vì âm thầm coi ratio/cluster/1 Dao như gang thường.
    """

    layout_type = str(settings.get("layoutType") or "sequential").strip().lower()
    if layout_type in {"ratio_stack", "cut_stacks"}:
        return (
            "Nesting theo đường bế chưa hỗ trợ cách dàn chia cọc/tỷ lệ. "
            "Hãy chọn Dàn tuần tự hoặc Bình trang."
        )
    if str(settings.get("cutType") or "default").strip().lower() == "one_dao":
        return (
            "Nesting theo đường bế chưa hỗ trợ chế độ 1 Dao. "
            "Hãy dùng cách xếp lưới cho chế độ này."
        )

    grouping = str(
        settings.get("groupingStrategy")
        or ("none" if _is_step_repeat(settings) else "maximize_area")
    ).strip().lower()
    # PARITY (audit 2026-08-29 MAP-NEST-04): N-up có hai semantics độc lập.
    # S&R một mẫu không chia dải; `none` được chuẩn hoá thành free_gang ở job.
    allowed_grouping = (
        {"none", "free_gang"}
        if _is_step_repeat(settings)
        else {"free_gang", "maximize_area"}
    )
    if grouping not in allowed_grouping:
        return (
            "Nesting theo đường bế chưa hỗ trợ cách chia cụm/tỷ lệ đang chọn. "
            "Hãy dùng Xếp tự do."
        )
    if str(settings.get("clusterMode") or "none").strip().lower() != "none":
        return (
            "Nesting theo đường bế chưa hỗ trợ chia cọc theo hàng/cột. "
            "Hãy tắt Chia cọc trước khi xếp."
        )
    if str(settings.get("alternateRotation") or "none").strip().lower() != "none":
        return (
            "Nesting theo đường bế chưa hỗ trợ xoay xen kẽ theo hàng/cột. "
            "Hãy chọn Không xoay xen kẽ."
        )

    cut_border = settings.get("cutBorder")
    cut_border_enabled = settings.get("cutBorderEnabled") is True or (
        isinstance(cut_border, Mapping) and cut_border.get("enabled") is True
    )
    if cut_border_enabled:
        return "Nesting theo đường bế chưa hỗ trợ đường viền cắt xén."

    hidden_layers = settings.get("hiddenOcgLayerIds")
    if hidden_layers:
        return (
            "Nesting theo đường bế chưa áp dụng được danh sách layer PDF đang ẩn. "
            "Hãy hiện lại các layer hoặc dùng cách xếp lưới."
        )
    if settings.get("saveByReport") is True:
        return (
            "Nesting theo đường bế chưa hỗ trợ tự tách/lưu file theo report. "
            "Hãy tắt tuỳ chọn này trước khi bình."
        )
    return None


def _guard_scope(settings: Mapping[str, Any]) -> None:
    """Chặn các tổ hợp chưa nằm trong phạm vi đã mở.

    Giữ đúng ba điều kiện của `shouldShowTrueShapeNestingOption` phía UI, để một
    payload dựng tay hoặc preset cũ không lách qua cổng mà UI đang khoá.

    §B10: Bình trang (S&R) nay ĐƯỢC nếu job THẬT SỰ đi true-shape (`wants_true_shape_nesting`
    = tự động CUSTOM `route_true_shape` HOẶC token thủ công/preview). Hình có-tên vẫn bị chặn
    vì cả hai tín hiệu đều False cho chúng — chúng không bao giờ nên tới true-shape. Dùng token
    ở đây để đường PREVIEW (settings mang token, gridStrategy≠optimal_auto) không bị chặn nhầm.
    """

    if _is_step_repeat(settings) and not wants_true_shape_nesting(settings):
        raise TrueShapeCompatibilityFallback(
            "Nesting tối ưu theo đường bế chưa mở cho Bình trang (S&R). "
            "Hãy chọn cách xếp khác cho chế độ này."
        )
    if settings.get("page_sheet_mode", False) is True:
        raise TrueShapeCompatibilityFallback(
            "Bình nguyên tấm decal không dùng nesting tối ưu theo đường bế."
        )
    layout_type = str(settings.get("layoutType") or "").strip()
    if layout_type == "mixed_guillotine":
        raise TrueShapeCompatibilityFallback(
            "Dàn nhiều kích thước là chế độ cắt xén chữ nhật, "
            "không dùng nesting tối ưu theo đường bế."
        )
    unsupported_reason = _unsupported_true_shape_reason(settings)
    if unsupported_reason is not None:
        raise TrueShapeCompatibilityFallback(unsupported_reason)


def _positive_float(value: Any, *, field: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} không phải số hợp lệ.") from exc
    if not number > 0.0:
        raise ValueError(f"{field} phải lớn hơn 0.")
    return number


def _non_negative_float(value: Any, *, field: str) -> float:
    if value is None:
        return 0.0
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} không phải số hợp lệ.") from exc
    if number < 0.0:
        raise ValueError(f"{field} không được âm.")
    return number


def _margin_mm(settings: Mapping[str, Any]) -> dict[str, float]:
    """Bốn lề phẳng của UI → dict lề của pipeline. Đơn vị mm cả hai bên."""

    return {
        "left": _non_negative_float(settings.get("marginLeft"), field="Lề trái"),
        "right": _non_negative_float(settings.get("marginRight"), field="Lề phải"),
        "top": _non_negative_float(settings.get("marginTop"), field="Lề trên"),
        "bottom": _non_negative_float(settings.get("marginBottom"), field="Lề dưới"),
    }


def _duplex_registration_obstacles(
    *, sheet_width_mm: float, sheet_height_mm: float
) -> tuple[dict[str, Any], ...]:
    """Keep-out bốn dấu canh duplex, cùng geometry server-owned với writer."""

    # FIX/PARITY (audit 2026-08-29 §MAP-NEST-08): cross dài hơn vòng tròn;
    # cộng nửa nét để solver không đặt artwork chạm đúng biên nét in.
    half_extent = max(
        DUPLEX_REGISTRATION_CIRCLE_DIAMETER_MM / 2.0,
        DUPLEX_REGISTRATION_LINE_LENGTH_MM / 2.0,
    ) + DUPLEX_REGISTRATION_STROKE_WIDTH_MM / 2.0
    margin = DUPLEX_REGISTRATION_MARGIN_MM
    centers = (
        ("bottom", sheet_width_mm / 2.0, margin),
        ("top", sheet_width_mm / 2.0, sheet_height_mm - margin),
        ("left", margin, sheet_height_mm / 2.0),
        ("right", sheet_width_mm - margin, sheet_height_mm / 2.0),
    )
    obstacles: list[dict[str, Any]] = []
    for name, cx, cy in centers:
        min_x = max(0.0, cx - half_extent)
        max_x = min(sheet_width_mm, cx + half_extent)
        min_y = max(0.0, cy - half_extent)
        max_y = min(sheet_height_mm, cy + half_extent)
        if max_x <= min_x or max_y <= min_y:
            raise ValueError("Khổ tờ không đủ chỗ cho dấu canh CNC hai mặt.")
        obstacles.append(
            {
                "obstacleId": f"duplex-registration-{name}",
                "kind": "sheet_mark",
                "outer": [
                    [min_x, min_y],
                    [max_x, min_y],
                    [max_x, max_y],
                    [min_x, max_y],
                ],
            }
        )
    return tuple(obstacles)


def _production_grouping_intent(settings: Mapping[str, Any]) -> str:
    grouping = str(
        settings.get("groupingStrategy")
        or ("none" if _is_step_repeat(settings) else "maximize_area")
    ).strip().lower()
    return "maximize_area" if grouping == "maximize_area" else "free_gang"


def _equal_area_placement_zones(
    part_ids: Iterable[str],
    *,
    sheet_width_mm: float,
    sheet_height_mm: float,
    margin_mm: Mapping[str, float],
) -> tuple[Any, ...]:
    """Chia usable sheet thành dải ngang bằng nhau theo thứ tự trang nguồn.

    PARITY (audit 2026-08-29 §MAP-NEST-04): biên dùng chung được lượng tử đúng
    một lần; gapX/gapY không tạo khe giả và không nới dải theo kích thước mẫu.
    Mẫu đầu nhận dải trên cùng, mẫu cuối chạm đúng lề dưới.
    """

    from app.core.nesting_production_pipeline import (
        AxisAlignedBoundsSpec,
        PartPlacementZoneSpec,
    )

    ordered_ids = tuple(part_ids)
    if not ordered_ids:
        raise ValueError("Chia đều diện tích cần ít nhất một mẫu.")
    quantum = Decimal("0.000001")

    def quantize(value: Decimal) -> Decimal:
        return value.quantize(quantum, rounding=ROUND_HALF_EVEN)

    width = Decimal(str(sheet_width_mm))
    height = Decimal(str(sheet_height_mm))
    left = quantize(Decimal(str(margin_mm["left"])))
    right = quantize(width - Decimal(str(margin_mm["right"])))
    bottom = quantize(Decimal(str(margin_mm["bottom"])))
    top = quantize(height - Decimal(str(margin_mm["top"])))
    if right <= left or top <= bottom:
        raise ValueError("Lề làm vùng chia đều diện tích không còn diện tích dương.")

    count = Decimal(len(ordered_ids))
    usable_height = top - bottom
    boundaries = [
        quantize(top - usable_height * Decimal(index) / count)
        for index in range(len(ordered_ids) + 1)
    ]
    # Ép hai đầu về cùng giá trị edge đã canonical, không tích lũy drift.
    boundaries[0] = top
    boundaries[-1] = bottom
    return tuple(
        PartPlacementZoneSpec(
            part_id=part_id,
            bounds=AxisAlignedBoundsSpec(
                min_x_mm=float(left),
                min_y_mm=float(boundaries[index + 1]),
                max_x_mm=float(right),
                max_y_mm=float(boundaries[index]),
            ),
        )
        for index, part_id in enumerate(ordered_ids)
    )


def _manifest_id() -> str:
    """Identity 128-bit của đúng một publication immutable.

    FIX (re-audit 2026-08-30 §RA-NEST-08): manifest ID không phải cache key cấu
    hình. Mỗi lượt pin hợp lệ sinh locator mới trong RenderBundle, nên tái dùng ID
    tất định cho một solve mới khiến kho immutable phát hiện cùng ID nhưng canonical
    bytes khác và từ chối commit. Cache/singleflight đã có ``job_identity_key`` riêng
    và cố ý không chứa manifest ID; publication vì vậy phải nhận nonce server-owned.
    """

    return secrets.token_hex(16)


def _page_quantities(
    settings: Mapping[str, Any],
    *,
    eligible_pages: Iterable[int] | None = None,
) -> dict[int, int]:
    """Chuẩn hoá SL global + override theo trang; chỉ trả trang SL dương.

    ``targetQuantity`` là mặc định cho mọi trang tham gia. Một key có mặt trong
    ``targetQuantitiesByPage`` luôn thắng, kể cả giá trị 0 (loại riêng mẫu đó).
    Khi cả global và mọi override đều 0, caller giữ semantics tự lấp đầy một tờ.
    """

    raw = settings.get("targetQuantitiesByPage")
    if raw is None:
        raw = {}
    if not isinstance(raw, Mapping):
        raise ValueError("targetQuantitiesByPage phải là map trang → số lượng.")

    def _parse(value: Any, *, field: str, default_zero: bool = False) -> int:
        if value is None and default_zero:
            return 0
        if isinstance(value, bool):
            raise ValueError(f"{field} không hợp lệ.")
        try:
            quantity = int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{field} không phải số nguyên.") from exc
        if quantity < 0:
            raise ValueError(f"{field} không được âm.")
        return quantity

    global_quantity = _parse(
        settings.get("targetQuantity", 0),
        field="Số lượng chung",
        default_zero=True,
    )
    allowed = (
        {int(page) for page in eligible_pages}
        if eligible_pages is not None
        else None
    )
    known_pages = set(allowed or ())
    if allowed is None:
        known_pages |= _page_index_keys(raw)
        known_pages |= _page_index_keys(settings.get("detectedShapesByPage"))
        known_pages |= _page_index_keys(settings.get("detectedShapeParamsByPage"))

    overrides: dict[int, int] = {}
    for key, value in raw.items():
        try:
            index = int(key)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"Chỉ số trang không hợp lệ: {key!r}.") from exc
        if index < 0:
            raise ValueError(f"Chỉ số trang không được âm: {index}.")
        quantity = _parse(value, field=f"Số lượng trang {index + 1}")
        if allowed is None or index in allowed:
            overrides[index] = quantity

    if global_quantity > 0:
        if not known_pages:
            known_pages.add(0)
        merged = {page: global_quantity for page in known_pages}
        merged.update(overrides)
    else:
        merged = overrides
    return {page: quantity for page, quantity in merged.items() if quantity > 0}


def _page_index_keys(raw: Any) -> set[int]:
    """Đọc tập chỉ số trang từ một map trang→giá trị của UI, bỏ khoá rác."""

    if not isinstance(raw, Mapping):
        return set()
    pages: set[int] = set()
    for key in raw:
        try:
            index = int(key)
        except (TypeError, ValueError):
            continue
        if index >= 0:
            pages.add(index)
    return pages


def _autofill_pages(settings: Mapping[str, Any]) -> list[int]:
    """Tập trang tham gia lấp đầy tờ khi người dùng không khai số lượng.

    "Tự lấp đầy tờ" với nhiều mẫu nghĩa là **mọi mẫu** cùng lên tờ, không phải mẫu đầu.
    Lấy hợp của hai nguồn UI gửi, vì mỗi nguồn thiếu một kiểu:

    - `targetQuantitiesByPage`: có đủ trang kể cả SL 0, nhưng người dùng có thể chưa mở
      bảng nhập SL bao giờ;
    - `detectedShapesByPage`: có mọi trang đã dò được khuôn.
    """

    pages = _page_index_keys(settings.get("targetQuantitiesByPage"))
    pages |= _page_index_keys(settings.get("detectedShapesByPage"))
    pages |= _page_index_keys(settings.get("detectedShapeParamsByPage"))
    return sorted(pages) if pages else [0]


def _detected_trim_dimensions_for_log(shapes: Mapping[int, Any]) -> dict[int, Any]:
    """Rút gọn detector payload cho log, không ghi path hay hình học contour."""

    dimensions: dict[int, Any] = {}
    for page_index, shape in sorted(shapes.items()):
        trim = getattr(shape, "trim", None)
        if trim is None:
            dimensions[int(page_index)] = {"trim": "missing"}
            continue
        try:
            width_pt = float(getattr(trim, "w"))
            height_pt = float(getattr(trim, "h"))
        except (TypeError, ValueError, OverflowError, AttributeError):
            dimensions[int(page_index)] = {"trim": "invalid"}
            continue
        dimensions[int(page_index)] = {
            "trimPt": [round(width_pt, 6), round(height_pt, 6)],
            "trimMm": [
                round(width_pt * 25.4 / 72.0, 6),
                round(height_pt * 25.4 / 72.0, 6),
            ],
            "hasPageContour": getattr(shape, "page_contour", None) is not None,
        }
    return dimensions


def _attach_detected_trim_dimensions(
    settings: Dict[str, Any],
    jobs: Iterable[Any],
    *,
    job_id: str | None,
) -> None:
    """Bàn giao kích thước trim server-owned sang report của engine legacy.

    Quality gate có thể chủ đích chọn lưới để giữ sức chứa tốt hơn. Khi đó chỉ
    layout/placement quay về legacy; kích thước thành phẩm trong report vẫn phải
    lấy từ cùng ``DetectedShape.trim`` mà backend vừa dùng để dựng job nesting.
    Map chỉ chứa số mm nên pickle nhẹ và không mang contour lớn qua process.
    """

    dimensions: dict[str, dict[str, float]] = {}
    for job in jobs:
        for part in getattr(job, "parts", ()):
            trim = getattr(getattr(part, "detected_shape", None), "trim", None)
            try:
                page_index = int(getattr(part, "page_index"))
                width_mm = float(getattr(trim, "w")) * _MM_PER_PT
                height_mm = float(getattr(trim, "h")) * _MM_PER_PT
            except (TypeError, ValueError, OverflowError, AttributeError):
                continue
            if not all(
                math.isfinite(value) and value > 0.0
                for value in (width_mm, height_mm)
            ):
                continue
            dimensions[str(page_index)] = {
                "width": width_mm,
                "height": height_mm,
            }

    if dimensions:
        settings[DETECTED_TRIM_DIMENSIONS_SETTING] = dimensions
    else:
        settings.pop(DETECTED_TRIM_DIMENSIONS_SETTING, None)
    # SEC (audit 2026-09-05 §LOG.06): kích thước authoritative chỉ
    # là diagnostic dev; không đẩy payload hình học lên warning production.
    logger.debug(
        "[DIM-DIE-TRACE] stage=handoff_dimensions job_id=%s dimensions_mm=%s",
        job_id,
        dimensions,
    )


def _detect_shapes_for_nesting(source_path: str) -> dict[int, Any]:
    """Dò khuôn server-side **một lượt** cho cả Tem bế và CNC.

    ``DetectedShape.trim`` là SSOT kích thước mà viewer hiển thị. Tem bế vẫn resolve
    contour production bằng extractor riêng, nhưng phải giữ object detector để report
    không đo lại bbox contour bằng thuật toán khác. CNC dùng thêm ``page_contour`` cho
    chính hình xếp/cắt. Không nhận mù kích thước do frontend gửi.
    """

    from app.workers import pdf_wrapper
    from app.workers.die_detection import detect_die_shapes

    document = pdf_wrapper.open(source_path)
    try:
        result = detect_die_shapes(document)
    finally:
        try:
            document.close()
        except Exception:
            pass
    shapes = {int(shape.page): shape for shape in result.shapes}
    # DIAG (feedback 2026-09-01 §DIM-DIE-TRACE): chỉ ghi kích thước và tên file,
    # không serialize contour lớn. Dòng kế tiếp phải khớp số viewer trước khi vào bundle.
    logger.debug(
        "[DIM-DIE-TRACE] stage=detector_raw source=%s shapes=%s",
        os.path.basename(source_path),
        _detected_trim_dimensions_for_log(shapes),
    )
    return shapes


def _cnc_duplex_front_pages(
    settings: Mapping[str, Any],
    shapes: Mapping[int, Any],
) -> list[int] | None:
    """Trang Front server-owned của CNC duplex; ``None`` nghĩa là simplex.

    Detector trả đúng một record cho mỗi trang. Dựa vào tập key đã dò để không tin
    một ``back_page_index`` nào từ client và để chặn file lẻ trước khi dựng bundle.
    """

    if not bool(settings.get("cncTwoSided", False)):
        return None
    indexes = sorted(int(index) for index in shapes)
    if not indexes or indexes != list(range(indexes[-1] + 1)):
        raise ValueError("Không đọc đủ số trang nguồn để dựng CNC hai mặt.")
    page_count = len(indexes)
    if page_count % 2 != 0:
        raise ValueError(
            "Bình CNC hai mặt cần số trang CHẴN "
            f"(Front + Back); file có {page_count} trang."
        )
    return list(range(0, page_count, 2))


def build_true_shape_nesting_job(
    source_path: str,
    settings: Mapping[str, Any],
    *,
    job_id: str | None = None,
):
    """Dịch `settings` của job N-Up thành `ProductionNestingJobInput`.

    Tách khỏi hàm chạy để test dựng được job mà không phải solve.
    """

    _guard_scope(settings)
    tool = _tool_from_settings(settings)
    shapes = _detect_shapes_for_nesting(source_path)
    logger.debug(
        "[DIM-DIE-TRACE] stage=detector_selected job_id=%s tool=%s shapes=%s",
        job_id,
        tool,
        _detected_trim_dimensions_for_log(shapes),
    )
    cnc_front_pages = (
        _cnc_duplex_front_pages(settings, shapes)
        if tool == "cnc_imposer"
        else None
    )

    quantities = _page_quantities(settings, eligible_pages=cnc_front_pages)
    if quantities:
        layout_intent = "quantity_fulfillment"
        pages = sorted(quantities)
    else:
        # Không khai SL nào ⇒ bài toán "lấp đầy một tờ".
        #
        # FIX (audit 2026-08-28 §NEST-AUTOFILL-PAGES): bản đầu hardcode `pages = [0]`.
        # Người dùng ghép 13 mẫu, để trống SL (= tự lấp đầy tờ), và nhận tờ bình **chỉ có
        # mẫu đầu tiên** — 12 mẫu còn lại bị bỏ im lặng. Preview vẫn hiện đủ 13 vì nó đi
        # đường lưới cũ, nên lệch càng khó phát hiện.
        #
        # Tập trang phải lấy từ chính những trang người dùng đang làm việc: hợp của khoá
        # `targetQuantitiesByPage` (UI gửi cả trang SL 0) và `detectedShapesByPage`.
        layout_intent = "autofill_single_sheet"
        pages = (
            cnc_front_pages
            if cnc_front_pages is not None
            else _autofill_pages(settings)
        )

    return _assemble_nesting_job(
        source_path,
        settings,
        tool=tool,
        pages=pages,
        layout_intent=layout_intent,
        quantities=quantities,
        report_requested_quantity=None,
        shapes=shapes,
    )


def build_true_shape_nesting_jobs(
    source_path: str,
    settings: Mapping[str, Any],
    *,
    job_id: str | None = None,
) -> list[Any]:
    """§B10-4 — danh sách job cho một lượt bình.

    - **Bình trang (S&R)** (`taskMode ∈ {step_repeat, sr}`): MỖI MẪU MỘT JOB "lấp đầy một
      tờ" (nest sát copies của đúng một mẫu). N mẫu ⇒ N job ⇒ N tờ đồng nhất. Đây là quy tắc
      của engine lưới cũ ("nhân bản MỘT trang/tờ"), nay đưa sang true-shape.
    - **Dàn nhiều mẫu (nup)** và mọi trường hợp khác: MỘT job gang như cũ (mọi mẫu chung tờ).

    Engine true-shape chỉ gang trong một job (xem `_render_context`: "Chặng A chỉ mở nhánh
    gang"), nên S&R phải tách thành nhiều job single-design rồi ghép tờ ở tầng preview/export.
    """

    _guard_scope(settings)
    if not _is_step_repeat(settings):
        return [build_true_shape_nesting_job(source_path, settings, job_id=job_id)]

    tool = _tool_from_settings(settings)
    shapes = _detect_shapes_for_nesting(source_path)
    logger.debug(
        "[DIM-DIE-TRACE] stage=detector_selected job_id=%s tool=%s shapes=%s",
        job_id,
        tool,
        _detected_trim_dimensions_for_log(shapes),
    )
    cnc_front_pages = (
        _cnc_duplex_front_pages(settings, shapes)
        if tool == "cnc_imposer"
        else None
    )
    # Trang tham gia chọn y như nhánh gang (SL>0 nếu có khai, ngược lại mọi mẫu đã dò), nhưng
    # MỖI trang là một job autofill riêng — quantity chỉ để chọn trang, không đẩy vào job.
    quantities = _page_quantities(settings, eligible_pages=cnc_front_pages)
    pages = (
        sorted(quantities)
        if quantities
        else (
            cnc_front_pages
            if cnc_front_pages is not None
            else _autofill_pages(settings)
        )
    )
    return [
        _assemble_nesting_job(
            source_path,
            settings,
            tool=tool,
            pages=[page],
            layout_intent="step_repeat_single_sheet",
            # FIX/PARITY (audit 2026-08-29 §MAP-NEST-05): quantity của part
            # vẫn vắng mặt theo invariant solver; demand chỉ đi qua snapshot report.
            quantities={},
            report_requested_quantity=quantities.get(page),
            shapes=shapes,
        )
        for page in pages
    ]


def _assemble_nesting_job(
    source_path: str,
    settings: Mapping[str, Any],
    *,
    tool: str,
    pages: list[int],
    layout_intent: str,
    quantities: Mapping[int, int],
    report_requested_quantity: int | None,
    shapes: Mapping[int, Any],
):
    """Dựng MỘT `ProductionNestingJobInput` từ tập trang + intent đã chốt.

    Tách khỏi `build_true_shape_nesting_job` để đường S&R (nhiều job single-design) và đường
    gang (một job) dùng chung đúng một bộ setup (khổ tờ, lề, hở, ốc, gia công) — không lệch.
    """

    from app.core.nesting_production_pipeline import (
        AxisGapMm,
        JobPartInput,
        ProductionNestingJobInput,
    )
    from app.workers.nup_nesting_finishing import (
        build_artifact_options,
        build_cut_spec,
        build_cut_style_spec,
        build_pont_obstacles,
        build_pont_spec,
        build_trim_spec,
    )

    sheet_w = _positive_float(settings.get("sheetWidth"), field="Chiều rộng tờ")
    sheet_h = _positive_float(settings.get("sheetHeight"), field="Chiều cao tờ")
    margin_mm = _margin_mm(settings)
    grouping_intent = _production_grouping_intent(settings)
    gap_x = _non_negative_float(settings.get("gapX"), field="Khoảng hở ngang")
    gap_y = _non_negative_float(settings.get("gapY"), field="Khoảng hở dọc")
    cnc_duplex = tool == "cnc_imposer" and bool(
        settings.get("cncTwoSided", False)
    )
    if cnc_duplex:
        flip_edge = str(settings.get("cncFlipEdge") or "long").strip().lower()
        if flip_edge not in {"long", "short"}:
            raise ValueError("Cạnh lật CNC hai mặt phải là cạnh dài hoặc cạnh ngắn.")
    else:
        flip_edge = "none"

    # FIX/PARITY (audit 2026-08-29 §MAP-NEST-08): dấu canh chỉ có hiệu lực
    # cho CNC duplex; simplex vẫn giữ payload tương thích nhưng không tạo dấu/vật cản.
    duplex_registration = cnc_duplex and bool(
        settings.get("cncDuplexMarks", False)
    )
    registration_obstacles = (
        _duplex_registration_obstacles(
            sheet_width_mm=sheet_w,
            sheet_height_mm=sheet_h,
        )
        if duplex_registration
        else ()
    )

    pont = build_pont_spec(settings)
    # FIX (audit 2026-08-29 §NEST-AUD-03): ốc bế phải là VẬT CẢN của solver, không chỉ là
    # hình writer vẽ. Lề ốc (thường 7mm) lớn hơn lề tờ (thường 5mm) nên ốc nằm trong vùng
    # dùng được; trước bản vá `fixed_obstacles` luôn rỗng ⇒ tem được xếp đè lên dấu canh và
    # thợ mất cả tờ. Lane lưới đã có việc này qua `pont_collision`; lane nesting thì chưa.
    pont_obstacles = build_pont_obstacles(
        pont, sheet_width_mm=sheet_w, sheet_height_mm=sheet_h
    )

    if layout_intent == "quantity_fulfillment":
        total_quantity = sum(quantities.values())
        max_sheets = max(1, min(MAX_SHEETS_CEILING, total_quantity))
    else:
        # Pipeline bắt buộc max_sheets = 1 và quantity = None cho nhánh lấp đầy một tờ.
        max_sheets = 1

    parts: list[Any] = []
    for page_index in sorted(pages):
        # FIX (audit 2026-09-01 §DIM-DIE-RUNTIME): cả Tem bế lẫn CNC phải mang
        # DetectedShape.trim tới bundle; nếu bỏ ở Tem bế thì report lại đo bbox contour
        # và tái hiện đúng lỗi 45,3×52,3 → 45,4×52,9mm.
        detected_shape = shapes.get(page_index)
        if tool == "cnc_imposer":
            if detected_shape is None:
                raise TrueShapeCompatibilityFallback(
                    f"Không dò được khuôn bế trên trang {page_index + 1} "
                    "để xếp theo đường bế."
                )
            if getattr(detected_shape, "page_contour", None) is None:
                raise TrueShapeCompatibilityFallback(
                    f"Khuôn bế trang {page_index + 1} không có đường bao dùng được "
                    "cho nesting. Hãy kiểm tra đường bế trên trang này."
                )
        parts.append(
            JobPartInput(
                part_id=f"trang-{page_index + 1}",
                source_path=source_path,
                page_index=page_index,
                quantity=(
                    quantities.get(page_index)
                    if layout_intent == "quantity_fulfillment"
                    else None
                ),
                detected_shape=detected_shape,
                # CNC duplex luôn ghép cặp server-owned Front 2n → Back 2n+1.
                back_page_index=page_index + 1 if cnc_duplex else None,
            )
        )

    placement_zones = (
        _equal_area_placement_zones(
            (part.part_id for part in parts),
            sheet_width_mm=sheet_w,
            sheet_height_mm=sheet_h,
            margin_mm=margin_mm,
        )
        if grouping_intent == "maximize_area"
        else ()
    )

    artifact_settings: Mapping[str, Any] = settings
    if layout_intent == "step_repeat_single_sheet":
        # S&R xuất một tờ đại diện cho mỗi mẫu; số lượng chỉ chọn mẫu tham gia.
        artifact_settings = {**settings, "exportUniqueSheets": True}

    return ProductionNestingJobInput(
        manifest_id=_manifest_id(),
        tool=tool,
        layout_intent=layout_intent,
        sheet_width_mm=sheet_w,
        sheet_height_mm=sheet_h,
        parts=tuple(parts),
        margin_mm=margin_mm,
        max_sheets=max_sheets,
        seed=0,
        # PERF (audit 2026-08-28 §NEST-DEFAULTS): hai mặc định này ĐỔI so với bản đầu,
        # và đây là chỗ tôi đã chọn sai.
        #
        # `profile="balanced"` + `time_budget_ms=None` nghĩa là chạy **hết** ngân sách
        # 100.000 lượt thử pose, không có trần thời gian nào. Đo trên file khách: người
        # dùng chờ quá 2 phút mà chưa có kết quả.
        #
        # Đo thật cho thấy `balanced` KHÔNG cho tờ bình tốt hơn: fast/balanced/tight ra
        # **cùng** `placedCount` và **cùng** số tờ trên mọi ca đã thử, trong khi balanced
        # chậm ~3× và tight chậm ~16×. Trả giá thời gian mà không đổi được chất lượng.
        #
        # `time_budget_ms` phải là số thật, không được None: một lượt bình vô hạn thì
        # không dùng được, dù có tất định. Đánh đổi đã nhận: kết quả phụ thuộc tốc độ máy
        # khi ngân sách bị chạm — chấp nhận, vì thà có tờ bình hơi khác nhau còn hơn
        # không có tờ bình nào.
        #
        # Lưu ý còn hở: thời gian THỰC vẫn có thể vượt ngân sách này (đo được 13 mẫu với
        # 3000ms mất 32s) vì `RunControl::checkpoint()` chỉ kiểm giữa các góc, chưa kiểm
        # trong `feasible_region`. Xem finding NFP-DEADLINE-1.
        profile="fast",
        # PERF (audit 2026-08-31 §SR-BUDGET-GATE): chỉ S&R trên máy <16 GB
        # dùng ngân sách rút gọn; máy mạnh và N-up autofill giữ mức đầy đủ.
        time_budget_ms=_time_budget_ms(layout_intent),
        # NEST (audit 2026-08-29 §NEST-CENTER-1): solver giữ objective bottom-left
        # để tìm nhanh; orchestrator sẽ dịch cứng cả cụm theo lựa chọn này rồi
        # re-validate trước khi preview/export đọc manifest.
        align=str(settings.get("align") or "center"),
        grouping_intent=grouping_intent,
        placement_zones=placement_zones,
        part_gap=AxisGapMm(gap_x, gap_y),
        duplex_mode="duplex" if cnc_duplex else "simplex",
        flip_edge=flip_edge,
        duplex_registration=duplex_registration,
        # FIX (audit 2026-08-28 §NEST-FINISHING): lô nối dây đầu chỉ map hình học nên
        # ốc bế, dấu xén, trang CUT riêng và report đều rơi về mặc định — người dùng nhận
        # tờ bình xếp đúng nhưng thiếu hết gia công. Bốn dòng dưới đóng lỗ đó.
        fixed_obstacles=(*pont_obstacles, *registration_obstacles),
        trim=build_trim_spec(settings),
        pont=pont,
        cut=build_cut_spec(settings),
        cut_style=build_cut_style_spec(settings),
        artifact_options=build_artifact_options(
            artifact_settings,
            requested_qty=report_requested_quantity,
            fallback_label_name=(
                f"Trang {pages[0] + 1}" if len(pages) == 1 else ""
            ),
        ),
    )


def _report_override_for_job(job: Any):
    """Report typed mới nhất, writer sẽ canonicalize trước khi tạo artifact."""

    return job.artifact_options.report


def _report_hash_for_job(job: Any) -> str:
    """Băm report typed sau canonicalize, tách biệt hoàn toàn identity layout."""

    from app.core.nesting_imposition_bundle import canonicalize_imposition_report
    from app.core.nesting_production_adapter import canonical_sha256

    canonical = canonicalize_imposition_report(
        _report_override_for_job(job),
        layout_intent=str(job.layout_intent),
    )
    return canonical_sha256(canonical)


def _verify_reference_report_hash(
    reference: Any,
    job: Any,
    *,
    context: str,
) -> str:
    """Child xác minh reference đang bind đúng report mà chính nó sẽ đóng dấu."""

    expected = _report_hash_for_job(job)
    supplied = (
        reference.get(REPORT_HASH_FIELD)
        if isinstance(reference, Mapping)
        else None
    )
    if not isinstance(supplied, str) or not secrets.compare_digest(supplied, expected):
        context_label = f" {context}" if context else ""
        raise ValueError(
            f"Metadata bản xem trước nesting{context_label} không khớp lượt Bình. "
            "Hãy tạo lại bản xem trước rồi bấm Bình lại."
        )
    return expected


def _report_from_manifest(job, manifest) -> str:
    """Chuỗi report tiếng Việt cho ô kết quả, cùng giọng với nhánh CNC.

    Nhận thẳng `manifest` để dùng được cho cả hai đường: phiên vừa solve và manifest
    nạp lại từ kho — hai bên phải cho **cùng** một report.
    """

    stats = manifest.get("stats") or {}
    placed = int(stats.get("placedCount") or 0)
    sheets = int(stats.get("sheetCount") or 0)

    lines = ["Nesting tối ưu theo đường bế"]
    lines.append(
        "  • Chế độ: "
        + (
            "Lấp đầy một tờ"
            if job.layout_intent
            in {"autofill_single_sheet", "step_repeat_single_sheet"}
            else "Đủ số lượng đặt"
        )
    )
    lines.append(f"  • Số mẫu xếp được: {placed} con")
    lines.append(f"  ⇒ Số tờ cần in: {sheets} tờ")

    unplaced = manifest.get("unplaced") or []
    if unplaced:
        lines.append(
            f"  ⚠ Còn {len(unplaced)} mẫu chưa xếp được — "
            "hãy tăng khổ tờ, giảm lề hoặc giảm khoảng hở."
        )
    return "\n".join(lines)


def _progress_writer(job_id: str | None, total_quantity: int):
    """Ghi tiến trình ra đúng file mà `/nup-status` đọc.

    UIUX (audit 2026-08-28 §NEST-PROGRESS): trước lô này nhánh nesting **không ghi gì**,
    nên người dùng thấy "Đang bình trang: 0/0..." bất động suốt cả phút và không biết job
    còn sống hay đã treo. Route đọc `nup_prog_<job_id>.txt` và đưa nguyên chuỗi vào status.

    Snapshot của Rust cho `progress` (0..1), `attempts`, `elapsedMs`, `bestSheetCount`.
    Ta quy về dạng "N/M" mà UI đang kỳ vọng: N suy từ `progress`, M là tổng số con cần.
    """

    if not job_id:
        return None

    import tempfile

    path = os.path.join(tempfile.gettempdir(), f"nup_prog_{job_id}.txt")
    total = max(1, int(total_quantity))
    state = {"last": -1}

    def _write(snapshot: Mapping[str, Any]) -> None:
        try:
            fraction = float(snapshot.get("progress") or 0.0)
        except (TypeError, ValueError):
            fraction = 0.0
        fraction = min(max(fraction, 0.0), 1.0)
        done = int(round(fraction * total))
        # Chỉ ghi khi số đổi: tránh đập đĩa 10 lần/giây suốt cả phút.
        if done == state["last"]:
            return
        state["last"] = done
        try:
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(f"{done}/{total}")
        except OSError:
            pass  # Mất tiến trình không được làm hỏng job.

    # Ghi ngay một mốc để UI thoát khỏi "0/0" trước cả lượt snapshot đầu.
    try:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(f"0/{total}")
    except OSError:
        pass
    return _write


def run_true_shape_nesting(
    source_path: str,
    output_path: str,
    settings: Dict[str, Any],
    job_id: str | None = None,
    progress_callback=None,
    *,
    store=None,
    cancel_event=None,
) -> str:
    """Chạy một lượt nesting theo đường bế. Trả chuỗi report như `run_nup_engine`.

    Hợp đồng trả về phải là **chuỗi**: `_spawn_nup_process` ghi thẳng giá trị này
    vào file trạng thái dạng ``completed|||<report>``.

    ``store=None`` dùng kho manifest thật dưới artifact root — đúng cho production.
    Test phải truyền kho tạm, nếu không sẽ commit manifest vào thư mục dùng chung.
    """

    from app.core.nesting_preview_session import (
        SESSION_REFERENCE_SETTING,
        get_preview_session_store,
        load_referenced_manifest,
    )
    from app.core.nesting_debug_trace import (
        job_identity_digest,
        manifest_trace_summary,
        native_runtime_summary,
        nfp_diagnostics_summary,
        nesting_trace_enabled,
        production_identity_summary,
        sanitize_trace_id,
        trace_nesting_event,
    )
    from app.core.nesting_production_pipeline import (
        commit_production_nesting_session,
        render_production_nesting_session,
        render_stored_production_nesting,
    )
    from app.core.nesting_rollout import true_shape_nesting_enabled

    if not true_shape_nesting_enabled():
        raise ValueError(
            "Nesting tối ưu theo đường bế chưa được mở trong bản này. "
            "Hãy chọn cách xếp khác."
        )

    # §B10-4: Bình trang (S&R) = MỖI MẪU MỘT TỜ. Solve+render từng mẫu rồi NỐI các tờ lại,
    # thay vì gang mọi mẫu chung một tờ. Nup giữ nguyên đường một-job bên dưới.
    if _is_step_repeat(settings):
        return _run_step_repeat_export(
            source_path,
            output_path,
            settings,
            job_id=job_id,
            progress_callback=progress_callback,
            store=store,
            cancel_event=cancel_event,
        )

    trace_id = settings.get("_diagnosticTraceId") or settings.get("diagnosticTraceId")
    request_id = settings.get("diagnosticPreviewRequestId")
    trace_enabled = nesting_trace_enabled()
    job = build_true_shape_nesting_job(source_path, settings, job_id=job_id)
    identity_digest = job_identity_digest(job) if trace_enabled else None

    # NEST (audit 2026-08-28 §A4b-6): đường ưu tiên — process API đã solve ở bước
    # preview và công bố manifest, chỉ chuyển identity + hash report. Ở đây (process
    # CON của `_spawn_nup_process`) chỉ nạp và render, không solve. Đây là cách duy
    # nhất giữ bất biến preview ≡ output qua ranh giới process, vì session nằm trong
    # RAM process API thì process con không thấy.
    reference_present = SESSION_REFERENCE_SETTING in settings
    reference = settings.get(SESSION_REFERENCE_SETTING) or {}
    effective_report_hash = (
        _verify_reference_report_hash(reference, job, context="")
        if reference_present
        else _report_hash_for_job(job)
    )
    reference_started = time.perf_counter()
    stored = load_referenced_manifest(reference, store=store)
    if trace_enabled:
        trace_nesting_event(
            "export.reference",
            trace_id=trace_id,
            request_id=request_id,
            job_id=job_id,
            exportIdentityDigest=identity_digest,
            referencePresent=bool(reference),
            referencedManifestId=sanitize_trace_id(
                reference.get("manifestId") if isinstance(reference, Mapping) else None
            ),
            referencedLayoutFingerprint=sanitize_trace_id(
                reference.get("layoutFingerprint")
                if isinstance(reference, Mapping)
                else None
            ),
            referencedReportHash=sanitize_trace_id(
                reference.get(REPORT_HASH_FIELD)
                if isinstance(reference, Mapping)
                else None
            ),
            effectiveReportHash=effective_report_hash,
            storedManifestHit=stored is not None,
            lookupMs=round((time.perf_counter() - reference_started) * 1000.0, 3),
            storedProductionIdentity=(
                production_identity_summary(stored.production_request)
                if stored is not None
                else None
            ),
            nativeRuntime=native_runtime_summary(),
            storedManifest=(
                manifest_trace_summary(
                    stored.manifest,
                    layout_fingerprint=stored.production_request.layout_fingerprint,
                )
                if stored is not None
                else None
            ),
        )
    if stored is not None:
        # PERF (audit 2026-09-02 §PERF-NEST-05): proof preview hợp lệ cho phép
        # render ngay; proof thiếu/méo/stale chỉ đo lại đúng một lần trên snapshot
        # đã resolve của manifest, tuyệt đối không mở lại source path đang sống.
        if len(job.parts) == 1:
            gate_decision, grid_capacity = _export_quality_gate_decision(
                settings,
                job,
                reference=reference,
                stored=stored,
            )
            if gate_decision == "grid":
                _raise_export_quality_fallback(
                    page_index=int(job.parts[0].page_index),
                    grid_capacity=grid_capacity,
                    nesting_capacity=_manifest_placed_count(stored.manifest),
                    nesting_sheets=_manifest_sheet_count(stored.manifest),
                    total_quantity=_job_total_quantity(job),
                    layout_intent=str(job.layout_intent),
                )
        logger.debug(
            "[NEST] true_shape_nesting job_id=%s tool=%s render TỪ manifest "
            "%s — không solve lại",
            job_id,
            job.tool,
            stored.manifest_id,
        )
        render_started = time.perf_counter()
        render = render_stored_production_nesting(
            stored,
            output_path=output_path,
            report_override=_report_override_for_job(job),
        )
        if trace_enabled:
            trace_nesting_event(
                "export.rendered",
                trace_id=trace_id,
                request_id=request_id,
                job_id=job_id,
                exportIdentityDigest=identity_digest,
                source="preview_manifest",
                solvedAgain=False,
                renderWallMs=round(
                    (time.perf_counter() - render_started) * 1000.0, 3
                ),
                pageCount=render.page_count,
                manifestId=render.manifest_id,
                layoutFingerprint=render.layout_fingerprint,
                renderBundleHash=render.render_bundle_hash,
                reportHash=render.report_hash,
                artifactRenderFingerprint=render.artifact_render_fingerprint,
                productionIdentity=production_identity_summary(
                    stored.production_request
                ),
                nativeRuntime=native_runtime_summary(),
            )
        return _report_from_manifest(job, stored.manifest)

    if reference_present:
        # FIX (re-audit 2026-08-30 §RA-NEST-08): reference preview là cam kết
        # artifact phải render đúng publication đó. Load miss mà solve lại sẽ có thể
        # đổi pose/capacity và tái tạo chính lỗi preview ≠ kết quả; phải fail-closed.
        raise ValueError(
            "Không thể nạp manifest của bản xem trước nesting. "
            "Hãy tạo lại bản xem trước rồi bấm Bình lại."
        )

    # Không có tham chiếu vì người dùng bấm Bình mà chưa preview: solve tại đây.
    # Kho phiên trong process này vẫn giúp lượt bình thứ hai cùng thiết lập không
    # phải solve lại.
    total_quantity = sum(int(part.quantity or 0) for part in job.parts) or len(job.parts)
    solve_started = time.perf_counter()
    session_store = get_preview_session_store()
    lookup = session_store.get_or_solve(
        job,
        cancel_event=cancel_event,
        progress_callback=progress_callback
        or _progress_writer(job_id, total_quantity),
    )
    solved_manifest = lookup.session.solved.manifest
    solved_production = lookup.session.solved.production_request
    # §B10-5 cổng chất lượng: chỉ so được khi ĐÚNG MỘT mẫu (gang nhiều mẫu ở đường cũ đi
    # MaxRects theo bbox, không so một-một với nesting theo đường bế).
    if len(job.parts) == 1:
        peek_proof = getattr(session_store, "peek_quality_gate_proof", None)
        session_proof = peek_proof(job) if callable(peek_proof) else None
        gate_decision, grid_capacity = _export_quality_gate_decision(
            settings,
            job,
            session=lookup.session,
            proof_value=session_proof,
        )
        if gate_decision == "grid":
            _raise_export_quality_fallback(
                page_index=int(job.parts[0].page_index),
                grid_capacity=grid_capacity,
                nesting_capacity=_manifest_placed_count(solved_manifest),
                nesting_sheets=_manifest_sheet_count(solved_manifest),
                total_quantity=_job_total_quantity(job),
                layout_intent=str(job.layout_intent),
            )
    if trace_enabled:
        trace_nesting_event(
            "export.solve",
            trace_id=trace_id,
            request_id=request_id,
            job_id=job_id,
            exportIdentityDigest=identity_digest,
            cacheReused=lookup.reused,
            solvedAgain=not lookup.reused,
            solveWallMs=round((time.perf_counter() - solve_started) * 1000.0, 3),
            productionIdentity=production_identity_summary(solved_production),
            nativeRuntime=native_runtime_summary(),
            nfpDiagnostics=nfp_diagnostics_summary(
                lookup.session.solved.runtime_diagnostics.get("nfpDiagnostics")
            ),
            **manifest_trace_summary(
                solved_manifest,
                layout_fingerprint=solved_production.layout_fingerprint,
            ),
        )
    logger.debug(
        "[NEST] true_shape_nesting job_id=%s tool=%s intent=%s parts=%d "
        "max_sheets=%d reused_session=%s",
        job_id,
        job.tool,
        job.layout_intent,
        len(job.parts),
        job.max_sheets,
        lookup.reused,
    )
    render_started = time.perf_counter()
    render = render_production_nesting_session(
        lookup.session,
        output_path=output_path,
        report_override=_report_override_for_job(job),
    )
    # Commit CHỈ sau khi artifact đã đóng thành công — giữ đúng thứ tự của pipeline.
    commit_production_nesting_session(lookup.session, store=store)
    if trace_enabled:
        trace_nesting_event(
            "export.rendered",
            trace_id=trace_id,
            request_id=request_id,
            job_id=job_id,
            exportIdentityDigest=identity_digest,
            source="export_session",
            solvedAgain=not lookup.reused,
            renderWallMs=round((time.perf_counter() - render_started) * 1000.0, 3),
            pageCount=render.page_count,
            manifestId=render.manifest_id,
            layoutFingerprint=render.layout_fingerprint,
            renderBundleHash=render.render_bundle_hash,
            reportHash=render.report_hash,
            artifactRenderFingerprint=render.artifact_render_fingerprint,
            productionIdentity=production_identity_summary(solved_production),
            nativeRuntime=native_runtime_summary(),
            nfpDiagnostics=nfp_diagnostics_summary(
                lookup.session.solved.runtime_diagnostics.get("nfpDiagnostics")
            ),
        )
    return _report_from_manifest(job, solved_manifest)


def _export_quality_gate_decision(
    settings: Mapping[str, Any],
    job: Any,
    *,
    reference: Mapping[str, Any] | None = None,
    stored: Any = None,
    session: Any = None,
    proof_value: Any = None,
) -> tuple[str, int]:
    """Quyết định gate từ proof, hoặc đo lại đúng một lần trên snapshot.

    Proof chỉ có thẩm quyền sau verifier bind đủ policy/input/job/manifest/source.
    Khi proof thiếu hoặc stale, source probe phải lấy từ pin/session hay resolved
    source của manifest; đọc ``source_path`` request sẽ tạo race source đổi revision.
    ``grid_capacity=0`` là không có ý kiến nên giữ nesting và không dựng proof giả.
    """

    if is_true_shape_nesting_requested(settings):
        return "nesting", 0
    parts = getattr(job, "parts", ()) or ()
    if len(parts) != 1:
        return "nesting", 0

    from app.core.nesting_quality_gate import (
        QUALITY_GATE_PROOF_FIELD,
        grid_beats_nesting,
        grid_capacity_from_settings,
        quality_gate_source_for_session,
        quality_gate_source_for_stored,
        verify_quality_gate_proof_for_session,
        verify_quality_gate_proof_for_stored,
    )

    candidate = proof_value
    if candidate is None and isinstance(reference, Mapping):
        candidate = reference.get(QUALITY_GATE_PROOF_FIELD)

    if stored is not None:
        verified = verify_quality_gate_proof_for_stored(
            candidate, settings, job, stored
        )
    elif session is not None:
        verified = verify_quality_gate_proof_for_session(
            candidate, settings, job, session
        )
    else:  # pragma: no cover - chỉ caller nội bộ, luôn có artifact owner
        raise ValueError("Thiếu phiên hoặc manifest để xác minh quality gate nesting.")

    if verified is not None:
        return str(verified.decision), int(verified.grid_capacity)

    source = (
        quality_gate_source_for_stored(stored, job)
        if stored is not None
        else quality_gate_source_for_session(session, job)
    )

    # PERF (audit 2026-09-02 §PERF-NEST-05): không fallback sang source path
    # đang sống. Thiếu binding snapshot là lỗi contract, không phải cache miss.
    if not isinstance(source, Mapping) or not source.get("source_path"):
        raise ValueError(
            "Không thể xác minh snapshot nguồn cho quality gate nesting. "
            "Hãy tạo lại bản xem trước rồi bấm Bình lại."
        )
    page_index = int(getattr(parts[0], "page_index"))
    grid_capacity = int(
        grid_capacity_from_settings(
            str(source["source_path"]), settings, page_index
        )
        or 0
    )
    if grid_capacity <= 0:
        return "nesting", 0

    manifest = (
        getattr(stored, "manifest", None)
        if stored is not None
        else getattr(getattr(session, "solved", None), "manifest", None)
    )
    manifest = manifest if isinstance(manifest, Mapping) else {}
    decision = (
        "grid"
        if grid_beats_nesting(
            layout_intent=str(
                getattr(job, "layout_intent", "autofill_single_sheet")
            ),
            nesting_placed=_manifest_placed_count(manifest),
            nesting_sheets=_manifest_sheet_count(manifest),
            total_quantity=_job_total_quantity(job),
            grid_capacity=grid_capacity,
        )
        else "nesting"
    )
    return decision, grid_capacity


def _raise_export_quality_fallback(
    *,
    page_index: int,
    grid_capacity: int,
    nesting_capacity: int,
    nesting_sheets: int,
    total_quantity: int,
    layout_intent: str,
) -> None:
    """Phát signal auto-route sau khi proof/probe đã quyết lưới thắng."""

    logger.debug(
        "[NEST-GATE] export trang %s (%s): lưới %s ⇒ lùi engine cũ "
        "(nesting placed=%s sheets=%s qty=%s)",
        page_index,
        layout_intent,
        grid_capacity,
        nesting_capacity,
        nesting_sheets,
        total_quantity,
    )
    raise TrueShapeQualityFallback(
        f"Đường cũ xếp tốt hơn nesting (lưới {grid_capacity} con/tờ) — dùng đường cũ."
    )


def _enforce_export_quality_gate(
    source_path: str,
    settings: Mapping[str, Any],
    *,
    page_index: int,
    nesting_capacity: int,
    layout_intent: str = "autofill_single_sheet",
    nesting_sheets: int = 0,
    total_quantity: int = 0,
) -> None:
    """§B10-5 cổng chất lượng ở EXPORT: lưới ≥ nesting ⇒ signal lùi engine cũ.

    `TrueShapeQualityFallback` là allowlist tường minh duy nhất ở dispatch; lỗi
    contract/manifest/writer dù cũng là `ValueError` phải fail-closed, không được
    giao artifact khác preview rồi che regression.

    CHỈ áp cho auto-route. Nếu người dùng/preview gửi token thủ công (`true_shape_nesting`) thì
    đó là yêu cầu tường minh và dispatch fail-closed — không được biến thành lỗi ở đây.
    """

    if is_true_shape_nesting_requested(settings):
        return
    from app.core.nesting_quality_gate import (
        grid_beats_nesting,
        grid_capacity_from_settings,
    )

    grid_capacity = grid_capacity_from_settings(source_path, settings, page_index)
    if grid_beats_nesting(
        layout_intent=layout_intent,
        nesting_placed=nesting_capacity,
        nesting_sheets=nesting_sheets,
        total_quantity=total_quantity,
        grid_capacity=grid_capacity,
    ):
        logger.debug(
            "[NEST-GATE] export trang %s (%s): lưới %s ⇒ lùi engine cũ "
            "(nesting placed=%s sheets=%s qty=%s)",
            page_index,
            layout_intent,
            grid_capacity,
            nesting_capacity,
            nesting_sheets,
            total_quantity,
        )
        raise TrueShapeQualityFallback(
            f"Đường cũ xếp tốt hơn nesting (lưới {grid_capacity} con/tờ) — dùng đường cũ."
        )


def _manifest_placed_count(manifest: Mapping[str, Any]) -> int:
    stats = manifest.get("stats") or {}
    try:
        return int(stats.get("placedCount") or 0)
    except (TypeError, ValueError):
        return 0


def _manifest_sheet_count(manifest: Mapping[str, Any]) -> int:
    stats = manifest.get("stats") or {}
    try:
        return int(stats.get("sheetCount") or 0)
    except (TypeError, ValueError):
        return 0


def _job_total_quantity(job: Any) -> int:
    """Tổng SL đặt của job (0 khi là bài toán lấp đầy tờ — part.quantity là None)."""

    total = 0
    for part in getattr(job, "parts", ()) or ():
        try:
            total += int(getattr(part, "quantity", None) or 0)
        except (TypeError, ValueError):
            continue
    return total


def _step_repeat_report(
    designs: list[tuple[int, int, int]], *, per_design_best: bool = False
) -> str:
    """Report gộp cho Bình trang (S&R) — mỗi mẫu một tờ.

    `designs`: danh sách `(page_index, placed_count, sheet_count)` theo thứ tự tờ ra.
    Auto S&R công bố cách xếp tốt nhất riêng từng mẫu; chọn nesting thủ công giữ tên cũ.
    """

    placed = sum(item[1] for item in designs)
    sheets = sum(max(1, item[2]) for item in designs)
    title = (
        "Tự động chọn cách xếp tốt nhất theo từng mẫu"
        if per_design_best
        else "Nesting tối ưu theo đường bế"
    )
    lines = [
        title,
        "  • Chế độ: Bình trang (S&R) — mỗi mẫu một tờ",
        f"  • Số mẫu: {len(designs)}",
        f"  • Tổng số con xếp được: {placed} con",
        f"  ⇒ Số tờ (mỗi mẫu một tờ): {sheets} tờ",
    ]
    return "\n".join(lines)


def _concat_pdf_pages(source_paths: list[str], output_path: str | os.PathLike) -> None:
    """Gộp PDF tạm và đo aggregate khi telemetry được bật.

    PERF (audit 2026-09-02 §PERF-NEST-06): merge nằm ngoài từng writer page nên
    phải có phase riêng; khi tắt telemetry không mở thêm PDF/đọc clock.
    """

    from app.core.perf_sampler import (
        finish_perf_stage,
        increment_perf_counter,
        start_perf_stage,
    )

    perf_sample = start_perf_stage()
    if perf_sample is not None:
        increment_perf_counter("sr_merge_input_files", len(source_paths))
    try:
        page_count = _concat_pdf_pages_impl(source_paths, output_path)
        if perf_sample is not None:
            increment_perf_counter("sr_merge_pages", page_count)
            increment_perf_counter("sr_merge_successes")
    finally:
        finish_perf_stage(
            perf_sample,
            "sr_merge_s",
            count_name="sr_merge_attempts",
        )


def _concat_pdf_pages_impl(
    source_paths: list[str], output_path: str | os.PathLike
) -> int:
    """Nối PDF một-tờ theo thứ tự Front/CUT rồi publish nguyên tử.

    Giữ MỌI ``Pdf`` nguồn mở tới khi save: pikepdf phân giải trang từ nguồn lúc
    lưu, đóng sớm sẽ mất nội dung trang. File hoàn chỉnh được stage cùng thư mục
    đích để lỗi save/replace không để lại output bị cắt cụt.
    """

    import tempfile

    import pikepdf

    target = os.path.abspath(os.fspath(output_path))
    parent = os.path.dirname(target)
    if parent:
        os.makedirs(parent, exist_ok=True)
    fd, staged_path = tempfile.mkstemp(
        prefix=".nup_sr_merge_",
        suffix=".pdf",
        dir=parent or None,
    )
    os.close(fd)

    output = None
    sources: list[Any] = []
    page_count = 0
    try:
        try:
            output = pikepdf.Pdf.new()
            for path in source_paths:
                src = pikepdf.open(path)
                sources.append(src)
                page_count += len(src.pages)
                output.pages.extend(src.pages)
            output.save(staged_path)
        finally:
            try:
                if output is not None:
                    output.close()
            finally:
                for src in sources:
                    try:
                        src.close()
                    except Exception:  # pragma: no cover - không che lỗi gốc
                        pass

        # FIX (audit 2026-08-31 §S&R-MERGE-PUBLISH): stage cùng ổ nên replace
        # là bước publish duy nhất; output cũ còn nguyên nếu merge thất bại.
        os.replace(staged_path, target)
        staged_path = ""
    finally:
        if staged_path:
            try:
                os.remove(staged_path)
            except OSError:
                logger.warning("Không xoá được PDF merge tạm.")
    return page_count


def _write_step_repeat_progress(job_id: str | None, done: int, total: int) -> None:
    """Ghi tiến trình "mẫu done/total" cho `/nup-status`, để UI không kẹt ở 0/0."""

    if not job_id:
        return
    import tempfile

    path = os.path.join(tempfile.gettempdir(), f"nup_prog_{job_id}.txt")
    try:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(f"{done}/{max(1, total)}")
    except OSError:
        pass  # Mất tiến trình không được làm hỏng job.


def _step_repeat_cancel_requested(value: Any) -> bool:
    """Đọc tín hiệu hủy Event/callable mà không giả định một implementation cụ thể."""

    checker = getattr(value, "is_set", None)
    if callable(checker):
        return bool(checker())
    if callable(value):
        return bool(value())
    return bool(value)


def _raise_if_step_repeat_cancelled(value: Any) -> None:
    if _step_repeat_cancel_requested(value):
        raise InterruptedError("Đã hủy batch nesting S&R.")


class _StepRepeatBatchCancel:
    """Gộp tín hiệu hủy của job cha với lỗi nội bộ của một future trong batch."""

    def __init__(self, parent: Any) -> None:
        import threading

        self._parent = parent
        self._internal = threading.Event()

    def set(self) -> None:
        self._internal.set()

    def is_set(self) -> bool:
        return self._internal.is_set() or _step_repeat_cancel_requested(self._parent)

    def wait(self, timeout: float | None = None) -> bool:
        """Giữ contract ``threading.Event`` và quan sát cả event cha theo nhịp ngắn."""

        deadline = None if timeout is None else time.monotonic() + max(0.0, timeout)
        while True:
            if self.is_set():
                return True
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0.0:
                return False
            self._internal.wait(
                0.05 if remaining is None else min(0.05, remaining)
            )


def _discard_step_repeat_sessions(sessions: Iterable[Any]) -> None:
    """Thu hồi pin private; pin đã promote khi commit sẽ không bị xóa final."""

    from app.core.nesting_source_pin import discard_source_pin

    seen: set[int] = set()
    for session in sessions:
        if session is None:
            continue
        for pin in getattr(session, "source_pins", ()) or ():
            identity = id(pin)
            if identity in seen:
                continue
            seen.add(identity)
            try:
                discard_source_pin(pin)
            except Exception:  # pragma: no cover - dọn dẹp không che lỗi gốc
                logger.debug("Không thu hồi được source pin batch S&R.", exc_info=True)


def run_step_repeat_batch_wave(
    jobs: list[Any],
    *,
    cancel_event: Any,
    progress_callback,
    runner,
    cleanup_results=None,
) -> list[Any]:
    """Chạy các mẫu S&R theo wave, giữ input order và một grant chung toàn máy.

    ``runner`` nhận một job cùng các keyword ``design_index``, ``cancel_event``,
    ``progress_callback`` và ``runtime_worker_grant_request``. Vé grant chỉ được
    claim ở owner solve thật; preview cache hit/follower không giữ quota trong lúc chờ.
    """

    import threading
    from concurrent.futures import FIRST_EXCEPTION, ThreadPoolExecutor, wait

    from app.core.mixed_nesting_service import (
        plan_batch_hardware,
        register_shared_batch_worker_grants,
    )

    if not jobs:
        raise ValueError("Batch nesting S&R phải có ít nhất một job.")

    plan = plan_batch_hardware(len(jobs))
    grant_lease = register_shared_batch_worker_grants(plan.total_worker_grant)
    logger.debug("[NEST-S&R-BATCH] %s", plan.reason)
    missing = object()
    results: list[Any] = [missing] * len(jobs)
    all_futures: dict[Any, int] = {}
    batch_cancel = _StepRepeatBatchCancel(cancel_event)
    progress_lock = threading.Lock()
    progress_by_design: dict[int, float] = {}

    def publish_progress(design_index: int, value: Mapping[str, Any]) -> None:
        if progress_callback is None:
            return
        # PERF (audit 2026-09-01 §PERF-NEST-01): raw 13 lane có thể đẩy UI tới 100%
        # khi mới xong một mẫu. Serialize và quy về tiến độ trung bình toàn batch.
        with progress_lock:
            snapshot = dict(value)
            try:
                lane_progress = float(snapshot.get("progress", 0.0))
            except (TypeError, ValueError, OverflowError):
                lane_progress = 0.0
            progress_by_design[design_index] = min(1.0, max(0.0, lane_progress))
            snapshot["progress"] = sum(progress_by_design.values()) / len(jobs)
            snapshot["designIndex"] = design_index
            snapshot["designCount"] = len(jobs)
            progress_callback(snapshot)

    executor = None
    try:
        executor = ThreadPoolExecutor(
            max_workers=plan.max_parallel_jobs,
            thread_name_prefix="prynx-sr-nesting",
        )
        for wave_start in range(0, len(jobs), plan.max_parallel_jobs):
            if batch_cancel.is_set():
                raise InterruptedError("Đã hủy batch nesting S&R.")
            wave_indices = list(
                range(
                    wave_start,
                    min(len(jobs), wave_start + plan.max_parallel_jobs),
                )
            )
            grants = plan.grants_for_wave(len(wave_indices))
            # PERF (audit 2026-09-01 §SR13-WAVE): một wave dùng đúng tổng grant;
            # không để mỗi job tự nhận cpu-1 (13 job × 15 worker trên máy 16 lõi).
            logger.debug(
                "[NEST-S&R-BATCH] wave=%d jobs=%s worker_grants=%s",
                wave_start // plan.max_parallel_jobs + 1,
                wave_indices,
                grants,
            )
            wave_futures: dict[Any, int] = {}
            for offset, design_index in enumerate(wave_indices):
                forwarded_progress = (
                    (lambda value, index=design_index: publish_progress(index, value))
                    if progress_callback is not None
                    else None
                )
                future = executor.submit(
                    runner,
                    jobs[design_index],
                    design_index=design_index,
                    cancel_event=batch_cancel,
                    progress_callback=forwarded_progress,
                    runtime_worker_grant_request=grant_lease.request(grants[offset]),
                )
                wave_futures[future] = design_index
                all_futures[future] = design_index

            done, _pending = wait(
                tuple(wave_futures), return_when=FIRST_EXCEPTION
            )
            cancelled = next((future for future in done if future.cancelled()), None)
            failed = next(
                (
                    future
                    for future in done
                    if not future.cancelled() and future.exception() is not None
                ),
                None,
            )
            if cancelled is not None or failed is not None:
                batch_cancel.set()
                for future in wave_futures:
                    if future not in done:
                        future.cancel()
                if failed is not None:
                    failed.result()  # raise lại đúng lỗi gốc
                raise InterruptedError("Batch nesting S&R bị hủy.")

            # FIRST_EXCEPTION chỉ trả sớm khi có lỗi; tới đây toàn wave đã hoàn tất.
            for future, design_index in wave_futures.items():
                results[design_index] = future.result()
            # Đóng cửa sổ hủy rất hẹp sau final check của từng solver nhưng trước render.
            _raise_if_step_repeat_cancelled(batch_cancel)
    except BaseException:
        batch_cancel.set()
        for future in all_futures:
            future.cancel()
        if executor is not None:
            executor.shutdown(wait=True, cancel_futures=True)
        # Future khác có thể hoàn tất trong lúc chờ shutdown; giữ lại để caller dọn
        # resource private. Preview store tự sở hữu lifecycle nên không truyền cleanup.
        for future, design_index in all_futures.items():
            if results[design_index] is not missing or future.cancelled():
                continue
            try:
                results[design_index] = future.result()
            except BaseException:
                pass
        if cleanup_results is not None:
            try:
                cleanup_results(
                    [result for result in results if result is not missing]
                )
            except Exception:  # pragma: no cover - cleanup không che lỗi gốc
                logger.debug("Không dọn được kết quả batch S&R.", exc_info=True)
        raise
    else:
        assert executor is not None  # constructor thành công mới vào nhánh này
        executor.shutdown(wait=True, cancel_futures=False)
    finally:
        # PERF (audit 2026-09-02 §PERF-NEST-12): chỉ đóng sau khi mọi future đã
        # drain; vé active/queued không thể trỏ vào một batch bị thu hồi giữa solve.
        grant_lease.close()

    if any(result is missing for result in results):  # pragma: no cover - hàng rào bất biến
        if cleanup_results is not None:
            cleanup_results([result for result in results if result is not missing])
        raise RuntimeError("Batch nesting S&R kết thúc thiếu kết quả.")
    return list(results)


def _solve_step_repeat_sessions(
    jobs: list[Any],
    *,
    cancel_event: Any,
    progress_callback,
) -> list[Any]:
    """Solve session private bằng scheduler wave dùng chung với preview."""

    from app.core.nesting_production_pipeline import solve_production_nesting_job

    def solve_one(
        job: Any,
        *,
        design_index: int,
        cancel_event: Any,
        progress_callback,
        runtime_worker_grant_request,
    ) -> Any:
        del design_index
        return solve_production_nesting_job(
            job,
            cancel_event=cancel_event,
            progress_callback=progress_callback,
            runtime_worker_grant_request=runtime_worker_grant_request,
        )

    return run_step_repeat_batch_wave(
        jobs,
        cancel_event=cancel_event,
        progress_callback=progress_callback,
        runner=solve_one,
        cleanup_results=_discard_step_repeat_sessions,
    )


def _run_step_repeat_export(
    source_path: str,
    output_path: str,
    settings: Dict[str, Any],
    *,
    job_id: str | None,
    progress_callback,
    store,
    cancel_event,
) -> str:
    """Export S&R theo quyết định tốt nhất của TỪNG MẪU.

    Mẫu nesting thắng render từ đúng manifest preview. Mẫu lưới thắng render bằng
    ``render_nup_sheet`` từ một kế hoạch legacy duy nhất, tức dùng chính writer production
    thay vì dựng một renderer lai. Các PDF tạm được nối theo thứ tự trang nguồn.
    """

    import contextlib
    import shutil
    import tempfile

    from app.core.nesting_preview_session import (
        SESSION_REFERENCE_SETTING,
        NestingPreviewSessionStore,
        get_preview_session_store,
        load_referenced_manifests,
    )
    from app.core.nesting_production_pipeline import (
        commit_production_nesting_session,
        render_production_nesting_session,
        render_stored_production_nesting,
    )
    from app.core.nesting_quality_gate import (
        QUALITY_GATE_PROOF_FIELD,
    )
    from app.workers.nup_sheet_render import nup_sheet_plan, render_nup_sheet

    jobs = build_true_shape_nesting_jobs(source_path, settings, job_id=job_id)
    if not jobs:  # pragma: no cover - build luôn trả ≥1 job cho S&R
        raise ValueError("Không dựng được job nào cho Bình trang (S&R).")

    reference_present = SESSION_REFERENCE_SETTING in settings
    raw_references = settings.get(SESSION_REFERENCE_SETTING)
    if reference_present:
        if not isinstance(raw_references, list) or len(raw_references) != len(jobs):
            # PARITY (audit 2026-08-31 §S&R-HANDOFF-SPILL): marker authoritative
            # có mặt nhưng thiếu/méo không được bị hiểu như cache miss rồi solve lại.
            raise ValueError(
                "Tham chiếu preview nesting S&R không đủ mọi mẫu. "
                "Hãy tạo lại bản xem trước rồi bấm Bình lại."
            )
        references = raw_references
    else:
        references = None
    stored_references = None
    if references is not None:
        for design_index, (job, reference) in enumerate(
            zip(jobs, references, strict=True)
        ):
            _verify_reference_report_hash(
                reference,
                job,
                context=f"S&R mẫu {design_index + 1}",
            )
        # PERF (audit 2026-09-01 §PERF-NEST-02): 13 manifest S&R vẫn full
        # native/hash validate độc lập, nhưng locator mới được resolve O(1);
        # marker token v1 lịch sử chỉ fallback một lượt scan cho cả batch.
        stored_references = load_referenced_manifests(references, store=store)
        if stored_references is None or len(stored_references) != len(jobs):
            raise ValueError(
                "Không thể nạp đủ manifest của bản xem trước nesting (S&R). "
                "Hãy tạo lại bản xem trước rồi bấm Bình lại."
            )
    session_store = get_preview_session_store() if references is None else None
    manual_nesting = is_true_shape_nesting_requested(settings)

    designs: list[tuple[int, int, int]] = []
    temp_dir = tempfile.mkdtemp(prefix="nup_sr_")
    temp_paths: list[str] = []
    private_sessions: list[Any] | None = None
    _write_step_repeat_progress(job_id, 0, len(jobs))
    try:
        # PERF (audit 2026-09-01 §SR13-WAVE): khi không có manifest preview, solve
        # nhiều mẫu bằng session private để LRU không loại pin trước lượt render tuần tự.
        # Fake store giữ đường tuần tự cũ để contract test/caller tùy biến không đổi.
        if (
            references is None
            and len(jobs) > 1
            and isinstance(session_store, NestingPreviewSessionStore)
        ):
            private_sessions = _solve_step_repeat_sessions(
                jobs,
                cancel_event=cancel_event,
                progress_callback=progress_callback,
            )

        with contextlib.ExitStack() as plan_stack:
            legacy_plan = None
            for design_index, job in enumerate(jobs):
                # Hủy sau solve phải chặn trước mọi render/commit còn lại.
                _raise_if_step_repeat_cancelled(cancel_event)
                page_index = int(job.parts[0].page_index)
                stored = None
                session = None
                if references is not None:
                    assert stored_references is not None
                    stored = stored_references[design_index]
                    manifest = stored.manifest
                elif private_sessions is not None:
                    session = private_sessions[design_index]
                    manifest = session.solved.manifest
                else:
                    lookup = session_store.get_or_solve(
                        job,
                        cancel_event=cancel_event,
                        progress_callback=progress_callback,
                    )
                    session = lookup.session
                    manifest = session.solved.manifest

                nesting_placed = _manifest_placed_count(manifest)
                nesting_sheets = _manifest_sheet_count(manifest)
                total_quantity = _job_total_quantity(job)
                grid_capacity = 0
                use_grid = False
                if not manual_nesting:
                    proof_value = None
                    if references is not None:
                        proof_value = references[design_index].get(
                            QUALITY_GATE_PROOF_FIELD
                        )
                    elif session_store is not None:
                        peek_proof = getattr(
                            session_store, "peek_quality_gate_proof", None
                        )
                        if callable(peek_proof):
                            proof_value = peek_proof(job)
                    gate_decision, grid_capacity = _export_quality_gate_decision(
                        settings,
                        job,
                        reference=(
                            references[design_index]
                            if references is not None
                            else None
                        ),
                        stored=stored,
                        session=session,
                        proof_value=proof_value,
                    )
                    use_grid = gate_decision == "grid"

                if use_grid:
                    if legacy_plan is None:
                        legacy_settings = {
                            **settings,
                            # Chặn auto-route quay lại chính hàm này; kế hoạch bên dưới
                            # phải là đường legacy đã thắng gate.
                            "forceLegacyGrid": True,
                            # FIX (audit 2026-08-31 §S&R-REPORT-QTY): giữ nguyên SL
                            # global/per-page để report dùng đúng đơn hàng. Chính cờ
                            # này mới chịu trách nhiệm chỉ materialize một tờ/mẫu.
                            "exportUniqueSheets": True,
                        }
                        legacy_settings.pop(SESSION_REFERENCE_SETTING, None)
                        legacy_settings.pop(QUALITY_GATE_PROOF_FIELD, None)
                        legacy_plan = plan_stack.enter_context(
                            nup_sheet_plan(
                                source_path,
                                legacy_settings,
                                job_id=job_id,
                            )
                        )
                    sheet_indices = [
                        sheet_index
                        for sheet_index in range(legacy_plan.total_sheets)
                        if legacy_plan.source_page_for_sheet(sheet_index) == page_index
                    ]
                    if len(sheet_indices) != 1:
                        raise ValueError(
                            "Bình trang phải có đúng một tờ lưới đại diện cho "
                            f"trang {page_index + 1}, nhận {len(sheet_indices)}."
                        )
                    temp_path = os.path.join(
                        temp_dir,
                        f"design_{design_index:04d}_grid.pdf",
                    )
                    _raise_if_step_repeat_cancelled(cancel_event)
                    render_nup_sheet(
                        legacy_plan,
                        sheet_indices[0],
                        temp_path,
                        include_report=True,
                    )
                    _raise_if_step_repeat_cancelled(cancel_event)
                    temp_paths.append(temp_path)
                    selected_placed = grid_capacity
                    selected_sheets = 1
                    selected_strategy = "lưới"
                else:
                    temp_path = os.path.join(
                        temp_dir, f"design_{design_index:04d}_nesting.pdf"
                    )
                    _raise_if_step_repeat_cancelled(cancel_event)
                    if stored is not None:
                        render_stored_production_nesting(
                            stored,
                            output_path=temp_path,
                            report_override=_report_override_for_job(job),
                        )
                    else:
                        render_production_nesting_session(
                            session,
                            output_path=temp_path,
                            report_override=_report_override_for_job(job),
                        )
                        # Commit chỉ sau khi artifact nesting đã đóng thành công và
                        # job cha vẫn chưa hủy.
                        _raise_if_step_repeat_cancelled(cancel_event)
                        commit_production_nesting_session(session, store=store)
                    _raise_if_step_repeat_cancelled(cancel_event)
                    temp_paths.append(temp_path)
                    selected_placed = nesting_placed
                    selected_sheets = nesting_sheets
                    selected_strategy = "theo đường bế"

                designs.append(
                    (page_index, int(selected_placed), int(selected_sheets))
                )
                logger.debug(
                    "[NEST-GATE] export S&R mẫu %d/%d (trang %d): "
                    "lưới=%d nesting=%d ⇒ %s",
                    design_index + 1,
                    len(jobs),
                    page_index + 1,
                    grid_capacity,
                    nesting_placed,
                    selected_strategy,
                )
                _write_step_repeat_progress(
                    job_id, design_index + 1, len(jobs)
                )

        _raise_if_step_repeat_cancelled(cancel_event)
        _concat_pdf_pages(temp_paths, output_path)
    finally:
        if private_sessions is not None:
            _discard_step_repeat_sessions(private_sessions)
        # Dọn cả cây để bao luôn file stage chưa kịp đăng ký khi render/stamp lỗi.
        try:
            shutil.rmtree(temp_dir)
        except FileNotFoundError:
            pass
        except OSError:
            logger.warning("Không dọn được thư mục S&R tạm.")

    return _step_repeat_report(designs, per_design_best=not manual_nesting)


def _attach_step_repeat_references(
    settings: Dict[str, Any],
    source_path: str,
    *,
    job_id: str | None,
    store,
    cancel_check: Any = None,
) -> Dict[str, Any]:
    """Gắn DANH SÁCH tham chiếu phiên (một mỗi mẫu) cho Bình trang (S&R).

    Preview giữ session nóng khi publication vừa LRU; publication lớn hơn trần RAM đã
    spill manifest xuống kho đĩa và giữ một batch identity nhẹ. Lúc launch, ưu tiên batch
    đó; nếu không có mới peek từng session rồi commit như đường cũ. Cả hai đều gắn list
    `[{manifestId, layoutFingerprint, reportHash}]` theo đúng thứ tự mẫu, không solve
    lần hai. `reportHash` luôn dựng lại từ settings Execute; cache chỉ sở hữu layout.

    Thiếu phiên/batch của bất kỳ mẫu nào trước khi nhận diện publication thì không gắn
    marker. Khi đã có đủ identity, marker được gắn TRƯỚC commit; mọi lỗi storage về sau
    phải giữ marker để process con fail-closed, không âm thầm solve layout khác.
    """

    authoritative_marker_attached = False
    try:
        from app.core.nesting_quality_gate import (
            QUALITY_GATE_PROOF_FIELD,
            verify_quality_gate_proof_for_session,
        )
        from app.core.nesting_preview_session import (
            SESSION_REFERENCE_SETTING,
            commit_and_reference,
            get_preview_session_store,
        )

        # PERF (audit 2026-09-02 §PERF-NEST-05/07): cả marker lẫn proof từ
        # payload client đều không có thẩm quyền. Chỉ publication trong store
        # server mới được gắn lại bên dưới.
        settings.pop(SESSION_REFERENCE_SETTING, None)
        settings.pop(QUALITY_GATE_PROOF_FIELD, None)

        jobs = build_true_shape_nesting_jobs(source_path, settings, job_id=job_id)
        _attach_detected_trim_dimensions(settings, jobs, job_id=job_id)
        store_obj = get_preview_session_store()
        # Batch spill luôn nằm ở default store; custom store của test/caller phải commit
        # lại từ session để reference trỏ đúng kho được truyền vào.
        # PERF/PARITY (audit 2026-09-01 §PERF-NEST-01): nếu preview wave đã đăng
        # ký publication nhưng chưa ráp xong batch, chờ đúng chốt batch. Gom session
        # tuần tự bằng peek_or_wait trong lúc LRU đổi từng lane có thể miss và khiến
        # process export solve lại một layout khác preview.
        peek_batch = getattr(store_obj, "peek_reference_batch_or_wait", None)
        if not callable(peek_batch):
            peek_batch = getattr(store_obj, "peek_reference_batch", None)
        if store is None and callable(peek_batch):
            spilled = (
                peek_batch(jobs, cancel_check=cancel_check)
                if cancel_check is not None
                else peek_batch(jobs)
            )
        else:
            spilled = None
        if spilled is not None:
            # PARITY (audit 2026-09-02 §REPORT-OVERLAY): durable batch đã được
            # nhận diện là publication authoritative. Gắn identity + toàn bộ
            # reportHash trong MỘT bước trước khi truyền marker sang child. Batch
            # spill chỉ giữ manifest bền; session nóng có thể đã bị LRU loại nên
            # tuyệt đối không được dùng `peek_or_wait()` làm điều kiện dựng marker.
            # Nếu proof quality gate thiếu/stale, child sẽ xác minh trên manifest
            # đã load (hoặc tự probe đúng snapshot), không solve lại layout.
            verified_spilled: list[dict[str, Any]] = [
                {
                    "manifestId": reference.get("manifestId"),
                    "layoutFingerprint": reference.get("layoutFingerprint"),
                    # PERF (audit 2026-09-02 §REPORT-OVERLAY): report là overlay
                    # của lượt Execute, không sao chép hash metadata preview cũ.
                    REPORT_HASH_FIELD: _report_hash_for_job(job),
                    # Reference đã đi qua store parser; chỉ chép proof scalar nếu
                    # có để child có thể bỏ phép đo lưới lặp lại. Verifier ở child
                    # vẫn bind proof với settings + manifest trước khi dùng.
                    **(
                        {
                            QUALITY_GATE_PROOF_FIELD: dict(proof)
                        }
                        if isinstance(
                            proof := reference.get(QUALITY_GATE_PROOF_FIELD),
                            Mapping,
                        )
                        else {}
                    ),
                }
                for job, reference in zip(jobs, spilled, strict=True)
            ]
            settings[SESSION_REFERENCE_SETTING] = verified_spilled
            authoritative_marker_attached = True
            return settings

        sessions = []
        for job in jobs:
            session = (
                store_obj.peek_or_wait(job, cancel_check=cancel_check)
                if cancel_check is not None
                else store_obj.peek_or_wait(job)
            )
            if session is None:
                return settings
            sessions.append(session)

        references = [
            {
                "manifestId": session.manifest_id,
                "layoutFingerprint": session.layout_fingerprint,
                REPORT_HASH_FIELD: _report_hash_for_job(job),
            }
            for job, session in zip(jobs, sessions, strict=True)
        ]
        # PARITY (audit 2026-08-31 §S&R-HANDOFF-SPILL): từ thời điểm này exact
        # publication đã được nhận diện. Commit lỗi vẫn phải để marker đi xuống child.
        settings[SESSION_REFERENCE_SETTING] = references
        authoritative_marker_attached = True
        peek_proof = getattr(store_obj, "peek_quality_gate_proof", None)
        for job, session, reference in zip(jobs, sessions, references, strict=True):
            committed_reference = commit_and_reference(session, store=store)
            if committed_reference != {
                "manifestId": reference["manifestId"],
                "layoutFingerprint": reference["layoutFingerprint"],
            }:  # pragma: no cover - hàng rào bất biến
                raise RuntimeError("Kho manifest trả identity khác phiên preview S&R.")
            candidate = peek_proof(job) if callable(peek_proof) else None
            verified = verify_quality_gate_proof_for_session(
                candidate, settings, job, session
            )
            if verified is not None:
                reference[QUALITY_GATE_PROOF_FIELD] = verified.to_dict()
    except Exception:  # noqa: BLE001 - marker authoritative quyết định fail-closed
        if authoritative_marker_attached:
            logger.debug(
                "Không công bố đủ manifest preview S&R; export sẽ fail-closed.",
                exc_info=True,
            )
        else:
            settings.pop(SESSION_REFERENCE_SETTING, None)
    return settings


def attach_preview_session_reference(
    settings: Dict[str, Any],
    source_path: str,
    *,
    job_id: str | None = None,
    store=None,
    cancel_check: Any = None,
) -> Dict[str, Any]:
    """Gắn tham chiếu phiên preview vào `settings` TRƯỚC khi spawn process con.

    Gọi từ route (process API), nơi kho phiên đang giữ kết quả solve của bước
    preview. Trả về dict settings (đã gắn thêm khoá nếu có phiên).

    Không có phiên preview khớp thì giữ đường solve bình thường. Khi đã nhận diện được
    identity publication, marker được gắn trước commit và mọi lỗi storage phải fail-closed;
    đây là hàng rào giữ preview ≡ output, không còn chỉ là đường tăng tốc.

    §B10: dùng `wants_true_shape_nesting` (token THỦ CÔNG hoặc auto `route_true_shape`), không
    chỉ token. Nếu chỉ nhìn token thì job auto-route (`gridStrategy='optimal_auto'`) sẽ KHÔNG
    gắn tham chiếu ⇒ process con solve lại nguyên lượt (mất bàn giao phiên preview→export).
    `job_identity_key` không phụ thuộc gridStrategy nên preview (token) và export (optimal_auto)
    vẫn cùng khoá ⇒ tra đúng phiên.
    """

    from app.core.nesting_preview_session import SESSION_REFERENCE_SETTING
    from app.core.nesting_quality_gate import QUALITY_GATE_PROOF_FIELD

    # SECURITY/FIX (feedback 2026-09-01 §DIM-DIE-RUNTIME): field này chỉ được
    # tạo từ detector backend bên dưới; không tin giá trị trùng tên do client gửi.
    settings.pop(DETECTED_TRIM_DIMENSIONS_SETTING, None)
    # PERF (audit 2026-09-02 §PERF-NEST-05/07): marker/proof client không bao
    # giờ được làm authority qua ranh giới process. Handoff dựng lại từ store server.
    settings.pop(SESSION_REFERENCE_SETTING, None)
    settings.pop(QUALITY_GATE_PROOF_FIELD, None)
    if not wants_true_shape_nesting(settings):
        return settings
    # §B10-4: Bình trang (S&R) có N phiên (mỗi mẫu một), nên gắn DANH SÁCH tham chiếu.
    if _is_step_repeat(settings):
        return _attach_step_repeat_references(
            settings,
            source_path,
            job_id=job_id,
            store=store,
            cancel_check=cancel_check,
        )
    from app.core.nesting_debug_trace import (
        job_identity_digest,
        manifest_trace_summary,
        native_runtime_summary,
        nfp_diagnostics_summary,
        nesting_trace_enabled,
        production_identity_summary,
        summarize_finishing_settings,
        summarize_quantities,
        trace_nesting_event,
    )

    trace_id = settings.get("_diagnosticTraceId") or settings.get("diagnosticTraceId")
    request_id = settings.get("diagnosticPreviewRequestId")
    trace_enabled = nesting_trace_enabled()
    identity_digest: str | None = None
    session = None
    try:
        from app.core.nesting_preview_session import (
            commit_and_reference,
            get_preview_session_store,
        )
        from app.core.nesting_quality_gate import (
            verify_quality_gate_proof_for_session,
        )

        job = build_true_shape_nesting_job(source_path, settings, job_id=job_id)
        _attach_detected_trim_dimensions(settings, (job,), job_id=job_id)
        identity_digest = job_identity_digest(job) if trace_enabled else None
        # PERF/FIX (audit 2026-08-29 §NEST-SINGLEFLIGHT): nếu người dùng bấm Bình
        # khi preview cùng identity còn solve, chờ đúng owner đó thay vì coi là cache
        # miss rồi để process con chạy solver lần hai.
        store_obj = get_preview_session_store()
        session = (
            store_obj.peek_or_wait(
                job,
                cancel_check=cancel_check,
                subscriber_id=job_id,
            )
            if cancel_check is not None
            else store_obj.peek_or_wait(job)
        )
        if session is None:
            if trace_enabled:
                trace_nesting_event(
                    "export.handoff",
                    trace_id=trace_id,
                    request_id=request_id,
                    job_id=job_id,
                    exportIdentityDigest=identity_digest,
                    previewSessionHit=False,
                    nativeRuntime=native_runtime_summary(),
                    requestedAlign=settings.get("align"),
                    normalizedFinishing=summarize_finishing_settings(settings),
                    quantities=summarize_quantities(
                        settings.get("targetQuantitiesByPage")
                    ),
                    sheetMm={
                        "width": settings.get("sheetWidth"),
                        "height": settings.get("sheetHeight"),
                    },
                    marginsMm={
                        "left": settings.get("marginLeft"),
                        "right": settings.get("marginRight"),
                        "top": settings.get("marginTop"),
                        "bottom": settings.get("marginBottom"),
                    },
                    gapsMm={"x": settings.get("gapX"), "y": settings.get("gapY")},
                )
            return settings
        # Gắn identity authoritative TRƯỚC commit. Nếu commit/storage lỗi, marker
        # vẫn đi tới process con và buộc fail-closed thay vì âm thầm solve layout mới.
        reference: dict[str, Any] = {
            "manifestId": session.manifest_id,
            "layoutFingerprint": session.layout_fingerprint,
            REPORT_HASH_FIELD: _report_hash_for_job(job),
        }
        settings[SESSION_REFERENCE_SETTING] = reference
        committed_reference = commit_and_reference(session, store=store)
        if committed_reference != {
            "manifestId": reference["manifestId"],
            "layoutFingerprint": reference["layoutFingerprint"],
        }:  # pragma: no cover - hàng rào bất biến
            raise RuntimeError("Kho manifest trả identity khác phiên preview.")
        peek_proof = getattr(store_obj, "peek_quality_gate_proof", None)
        candidate = peek_proof(job) if callable(peek_proof) else None
        verified = verify_quality_gate_proof_for_session(
            candidate, settings, job, session
        )
        if verified is not None:
            reference[QUALITY_GATE_PROOF_FIELD] = verified.to_dict()
        if trace_enabled:
            trace_nesting_event(
                "export.handoff",
                trace_id=trace_id,
                request_id=request_id,
                job_id=job_id,
                exportIdentityDigest=identity_digest,
                previewSessionHit=True,
                requestedAlign=settings.get("align"),
                normalizedFinishing=summarize_finishing_settings(settings),
                referencedManifestId=reference.get("manifestId"),
                referencedLayoutFingerprint=reference.get("layoutFingerprint"),
                reportHash=reference.get(REPORT_HASH_FIELD),
                previewManifest=manifest_trace_summary(
                    session.solved.manifest,
                    layout_fingerprint=session.solved.production_request.layout_fingerprint,
                ),
                nfpDiagnostics=nfp_diagnostics_summary(
                    session.solved.runtime_diagnostics.get("nfpDiagnostics")
                ),
                productionIdentity=production_identity_summary(
                    session.solved.production_request
                ),
                nativeRuntime=native_runtime_summary(),
                quantities=summarize_quantities(
                    settings.get("targetQuantitiesByPage")
                ),
                sheetMm={
                    "width": settings.get("sheetWidth"),
                    "height": settings.get("sheetHeight"),
                },
                marginsMm={
                    "left": settings.get("marginLeft"),
                    "right": settings.get("marginRight"),
                    "top": settings.get("marginTop"),
                    "bottom": settings.get("marginBottom"),
                },
                gapsMm={"x": settings.get("gapX"), "y": settings.get("gapY")},
            )
    except InterruptedError:
        # Hủy job chỉ dừng handoff nền; không biến thao tác chủ đích thành lỗi log.
        return settings
    except Exception as exc:
        if trace_enabled:
            trace_nesting_event(
                "export.handoff",
                trace_id=trace_id,
                request_id=request_id,
                job_id=job_id,
                exportIdentityDigest=identity_digest,
                previewSessionHit=session is not None,
                handoffErrorType=type(exc).__name__,
                nativeRuntime=native_runtime_summary(),
                requestedAlign=settings.get("align"),
                normalizedFinishing=summarize_finishing_settings(settings),
            )
        logger.debug(
            "Không công bố được manifest phiên preview; export sẽ fail-closed.",
            exc_info=True,
        )
    return settings
