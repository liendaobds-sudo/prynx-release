"""Cổng chất lượng nesting — "Xếp tối ưu" KHÔNG BAO GIỜ được thua "Lưới đơn giản".

## Vì sao cần

§B10 định tuyến tem hình đặc biệt (CUSTOM) sang true-shape nesting khi người dùng chọn
"Xếp tối ưu". Nhưng đo trên file thật: nesting cho **43 con/tờ** trong khi lưới cho **54**
— kém 20%. Hai cơ chế cộng dồn:

1. **Autofill tắt hẳn pha tìm kiếm** (`AUTOFILL_TIME_BUDGET_MS = 1`): chỉ còn baseline greedy
   xếp lần lượt từ dưới-trái, không có vòng tối ưu nào.
2. **Footprint đóng gói bị phình**: `derive_packing_footprint` nới 0,2mm rồi **nhân đôi dần
   tới 3mm** cho đủ trần 256 đỉnh. Tem bo tròn mượt dễ vượt trần ⇒ mỗi con to hơn thực tế,
   rồi hở tem cộng thêm lên trên.

Cả hai đều là hạn chế của kernel, và số đo Lô 0 đã ghi kernel thua tiler/lưới ở 8/9 ca. Vì
vậy KHÔNG được tin nesting một cách vô điều kiện.

## Quy tắc

Với cùng một mẫu và cùng thiết lập, tính sức chứa của **cả hai** đường rồi lấy đường nhiều
con hơn. **Lưới thắng khi hoà** (`grid >= nesting`): lưới rẻ hơn, quen mắt thợ, và là hành vi
trước §B10 — chỉ đổi sang nesting khi nó THẬT SỰ hơn.

Đây không phải fail-soft che lỗi: nesting vẫn được dùng ở đúng ca nó thắng (tem lõm, đo B8:
351 so với 316). Cổng chỉ chặn ca nó thua.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import re
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any, Mapping

logger = logging.getLogger(__name__)

# PARITY (audit 2026-08-30 §B10-6): quality gate phải đo đúng cùng point với
# provisional/export. Hằng rút gọn 2.83465 làm lệch ca vừa khít ở biên EPS.
MM_TO_PTS = 72.0 / 25.4

#: Chiến lược dùng để đo đường cũ. `optimal_auto` là "Xếp tối ưu" của engine lưới/tiler —
#: đúng thứ người dùng nhận TRƯỚC §B10, và nó đã best-of cả lưới thuần bên trong.
GRID_PROBE_STRATEGY = "optimal_auto"

# PERF (audit 2026-09-02 §PERF-NEST-05): proof chỉ là metadata nội bộ giúp export
# bỏ phép đo lưới đã hoàn tất ở preview. Đổi luật so, chiến lược probe hoặc cách
# chuẩn hoá input phải đổi payload policy; proof cũ khi đó tự thành stale.
QUALITY_GATE_PROOF_FIELD = "qualityGateProof"
QUALITY_GATE_PROOF_SCHEMA_VERSION = 1
QUALITY_GATE_INPUT_SCHEMA_VERSION = 1
_QUALITY_GATE_POLICY_PAYLOAD = {
    "policyVersion": 1,
    "inputSchemaVersion": QUALITY_GATE_INPUT_SCHEMA_VERSION,
    "gridProbeStrategy": GRID_PROBE_STRATEGY,
    "singleSheetIntents": ["autofill_single_sheet", "step_repeat_single_sheet"],
    "singleSheetRule": "grid_capacity_gte_nesting_placed",
    "quantityRule": "grid_sheet_count_lt_nesting_sheet_count",
    "gridCapacityZero": "no_opinion",
}
_SHA256_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")


def _exact_canonical_value(value: Any) -> Any:
    """Đổi dữ liệu JSON-like thành dạng băm giữ chính xác float đầu vào.

    Canonical production cố ý lượng tử 6 chữ số cho hình học. Quality gate lại có
    thể đổi sức chứa ở đúng một biên vừa khít, nên proof không được coi hai float
    khác nhau dưới 1e-6 là cùng input. ``float.hex`` giữ đúng bit IEEE-754; mapping
    vẫn được ``json.dumps(sort_keys=True)`` sắp tất định ở bước băm.
    """

    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return {"$int": str(value)}
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("Input quality gate phải là số hữu hạn.")
        return {"$float64": value.hex()}
    if isinstance(value, (list, tuple)):
        return [_exact_canonical_value(item) for item in value]
    if isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            raise ValueError("Mọi key input quality gate phải là chuỗi.")
        return {
            key: _exact_canonical_value(value[key])
            for key in sorted(value, key=lambda item: item.encode("utf-8"))
        }
    raise ValueError(
        f"Kiểu {type(value).__name__} không được phép trong input quality gate."
    )


def _exact_sha256(value: Any) -> str:
    canonical = json.dumps(
        _exact_canonical_value(value),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(canonical).hexdigest()


QUALITY_GATE_POLICY_FINGERPRINT = _exact_sha256(_QUALITY_GATE_POLICY_PAYLOAD)


@dataclass(frozen=True, slots=True)
class QualityGateDecisionProof:
    """Bằng chứng JSON-safe của một quyết định grid-vs-nesting ở preview.

    Đây không phải capability hay chữ ký mật mã. Chỉ verifier có đủ identity
    server-owned của manifest/source pin mới được dùng nó; parse thành công đơn thuần
    không tạo thẩm quyền.
    """

    schema_version: int
    policy_fingerprint: str
    normalized_input_fingerprint: str
    source_locator_id: str
    source_content_hash: str
    input_hash: str
    layout_fingerprint: str
    page_index: int
    layout_intent: str
    nesting_placed: int
    nesting_sheets: int
    total_quantity: int
    grid_capacity: int
    decision: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schema_version,
            "policyFingerprint": self.policy_fingerprint,
            "normalizedInputFingerprint": self.normalized_input_fingerprint,
            "sourceLocatorId": self.source_locator_id,
            "sourceContentHash": self.source_content_hash,
            "inputHash": self.input_hash,
            "layoutFingerprint": self.layout_fingerprint,
            "pageIndex": self.page_index,
            "layoutIntent": self.layout_intent,
            "nestingPlaced": self.nesting_placed,
            "nestingSheets": self.nesting_sheets,
            "totalQuantity": self.total_quantity,
            "gridCapacity": self.grid_capacity,
            "decision": self.decision,
        }


class GridBeatsNestingSignal(Exception):
    """Tín hiệu: đường cũ (lưới/tiler) xếp được BẰNG hoặc NHIỀU HƠN nesting.

    **Không** phải lỗi người dùng, nên cố ý KHÔNG kế thừa `ValueError`: route đổi
    `ValueError` thành 422 và job registry gắn `NESTING_PREVIEW_INVALID_REQUEST` — cả hai
    đều hiện ra như lỗi. Tín hiệu này phải được bắt và đổi thành kết quả của đường cũ.
    """

    def __init__(self, *, grid_capacity: int, nesting_capacity: int) -> None:
        super().__init__(
            f"Lưới xếp được {grid_capacity} con/tờ ≥ nesting {nesting_capacity} con/tờ "
            "— dùng đường cũ."
        )
        self.grid_capacity = int(grid_capacity)
        self.nesting_capacity = int(nesting_capacity)


def grid_wins(nesting_capacity: int, grid_capacity: int) -> bool:
    """Đường cũ có thắng (hoặc hoà) nesting không, so theo SỨC CHỨA MỘT TỜ.

    Chỉ dùng cho bài toán "lấp đầy một tờ" (`autofill_single_sheet`), nơi `placedCount` CHÍNH
    LÀ sức chứa một tờ. Với "đủ số lượng đặt" phải dùng [`grid_wins_by_sheets`] — xem ở đó.
    """

    try:
        nesting = int(nesting_capacity)
        grid = int(grid_capacity)
    except (TypeError, ValueError):
        return False
    if grid <= 0:
        return False  # không đo được lưới ⇒ không chặn nesting
    return grid >= nesting


def grid_wins_by_sheets(
    *, nesting_sheets: int, total_quantity: int, grid_capacity: int
) -> bool:
    """Đường cũ có cần SỐ TỜ bằng/ít hơn nesting không (bài toán "đủ số lượng đặt").

    FIX (§B10-5): bản đầu so `placedCount` với sức chứa lưới ở MỌI intent — sai đơn vị. Với
    `quantity_fulfillment`, `placedCount` là **số con đã đặt** (vd đặt 6 thì xếp đúng 6), nên
    so với "sức chứa 18 con/tờ" là so hai đại lượng khác nhau và cổng chặn oan nesting dù nó
    đã hoàn thành đơn. Đại lượng so được ở đây là **số tờ phải in**.

    Khác `grid_wins`: ở đây HOÀ thì **giữ nesting** (`<`, không phải `<=`). Cùng số tờ nghĩa là
    không mất vật liệu — mà đơn nhỏ vừa một tờ thì hầu như luôn hoà, nếu hoà mà nhường lưới thì
    nesting bị tắt ở gần hết đơn hàng, kể cả tem lõm mà nó thắng rõ về mật độ.
    """

    import math

    try:
        sheets = int(nesting_sheets)
        quantity = int(total_quantity)
        grid = int(grid_capacity)
    except (TypeError, ValueError):
        return False
    if grid <= 0 or quantity <= 0 or sheets <= 0:
        return False  # thiếu dữ kiện ⇒ không chặn nesting
    grid_sheets = math.ceil(quantity / grid)
    return grid_sheets < sheets


def grid_beats_nesting(
    *,
    layout_intent: str,
    nesting_placed: int,
    nesting_sheets: int,
    total_quantity: int,
    grid_capacity: int,
) -> bool:
    """Quyết định DUY NHẤT của cổng, dùng chung cho preview và export.

    Tách ra một hàm để hai bên không thể so bằng hai đơn vị khác nhau (đúng lỗi vừa sửa):

    - `autofill_single_sheet` ("tự lấp đầy tờ"): so **con/tờ** — `nesting_placed` là sức chứa.
    - `quantity_fulfillment` ("đủ số lượng đặt"): so **số tờ phải in**, vì `nesting_placed`
      chỉ là số con đã đặt nên không nói gì về mật độ.
    """

    if str(layout_intent) in {
        "autofill_single_sheet",
        "step_repeat_single_sheet",
    }:
        return grid_wins(nesting_placed, grid_capacity)
    return grid_wins_by_sheets(
        nesting_sheets=nesting_sheets,
        total_quantity=total_quantity,
        grid_capacity=grid_capacity,
    )


def _pont_req(
    *,
    pont_config: Any,
    usable_w_pt: float,
    usable_h_pt: float,
    sheet_w_pt: float,
    sheet_h_pt: float,
    margin_left_pt: float,
    margin_bottom_pt: float,
    margin_top_pt: float,
) -> SimpleNamespace:
    """Đối tượng req-like tối thiểu cho `sticker_capacity_after_pont`.

    Cả preview (có `req` thật) và export (chỉ có `settings`) đều đi qua đây, nên hai bên đo
    sức chứa lưới bằng ĐÚNG một cách — kể cả phần né ốc.
    """

    return SimpleNamespace(
        pont_config=pont_config or None,
        usable_w=float(usable_w_pt),
        usable_h=float(usable_h_pt),
        sheet_w=float(sheet_w_pt),
        sheet_h=float(sheet_h_pt),
        margin_left=float(margin_left_pt),
        margin_bottom=float(margin_bottom_pt),
        margin_top=float(margin_top_pt),
    )


def grid_capacity_for_page(
    source_path: str,
    page_index: int,
    *,
    usable_w_pt: float,
    usable_h_pt: float,
    gap_x_pt: float,
    gap_y_pt: float,
    sheet_w_pt: float,
    sheet_h_pt: float,
    margin_left_pt: float,
    margin_bottom_pt: float,
    margin_top_pt: float,
    bleed_pt: float = 0.0,
    cut_type: str = "default",
    die_size_mode: str = "die",
    die_offset_mm: float = 0.0,
    shape_type: str | None = None,
    shape_props: Mapping[str, Any] | None = None,
    pont_config: Any = None,
    strategy: str = GRID_PROBE_STRATEGY,
) -> int:
    """Sức chứa của ĐƯỜNG CŨ (lưới/tiler) cho một mẫu, đơn vị con/tờ.

    Dùng đúng `compute_sticker_layout_for_page` — nguồn chân lý dùng chung của preview và
    export ở đường cũ — nên con số này chính là con số thợ thấy khi chọn đường cũ. Sau đó
    trừ ốc bằng `sticker_capacity_after_pont` để so sánh công bằng với nesting (nesting coi ốc
    là vật cản của solver).

    Trả **0** khi không đo được (thiếu Rust, file lỗi, hình không dựng được): 0 nghĩa là
    "không có ý kiến", `grid_wins` sẽ không chặn nesting.

    Mọi đối số hình học là **point**, trừ `die_offset_mm` (mm — đúng hợp đồng hàm gốc).
    """

    from app.core.pdfium_lock import pdfium_guard
    from app.workers import pdf_wrapper as pdf_lib
    from app.workers.imposition_preview_helpers import sticker_capacity_after_pont
    from app.workers.sticker_imposer_pkg.layout_compute import (
        compute_sticker_layout_for_page,
    )

    override = str(shape_type).strip() if shape_type else ""
    document = None
    try:
        # PDFium không thread-safe và hàm này chạy trong `run_in_threadpool` (job preview),
        # nên toàn bộ vùng chạm trang phải nằm trong `pdfium_guard()`.
        with pdfium_guard():
            document = pdf_lib.open(source_path)
            if page_index < 0 or page_index >= document.page_count:
                return 0
            page = document[page_index]
            layout = compute_sticker_layout_for_page(
                page=page,
                sheet_usable_w=float(usable_w_pt),
                sheet_usable_h=float(usable_h_pt),
                gap_x=float(gap_x_pt),
                gap_y=float(gap_y_pt),
                strategy=str(strategy),
                shape_type_override=override or None,
                shape_props_override=dict(shape_props) if shape_props else None,
                bleed_pt=float(bleed_pt),
                # Khe block phụ không thuộc bài toán "một mẫu lấp đầy tờ" của cổng này.
                secondary_gap=None,
                cut_type=str(cut_type or "default"),
                die_size_mode=str(die_size_mode or "die"),
                die_offset_mm=float(die_offset_mm or 0.0),
                # Cổng chỉ so SỐ LƯỢNG; Inking không đổi sức chứa nên giữ 'none'.
                alternate_rotation="none",
            )
            return int(
                sticker_capacity_after_pont(
                    layout,
                    _pont_req(
                        pont_config=pont_config,
                        usable_w_pt=usable_w_pt,
                        usable_h_pt=usable_h_pt,
                        sheet_w_pt=sheet_w_pt,
                        sheet_h_pt=sheet_h_pt,
                        margin_left_pt=margin_left_pt,
                        margin_bottom_pt=margin_bottom_pt,
                        margin_top_pt=margin_top_pt,
                    ),
                    page,
                    int(page_index),
                    override or None,
                    is_cluster=False,
                    logger=logger,
                )
            )
    except Exception:  # noqa: BLE001 — không đo được lưới KHÔNG được làm hỏng job
        logger.warning(
            "[NEST-GATE] không đo được sức chứa lưới cho trang %s của %s",
            page_index,
            source_path,
            exc_info=True,
        )
        return 0
    finally:
        if document is not None:
            try:
                with pdfium_guard():
                    document.close()
            except Exception:  # pragma: no cover - dọn dẹp không che lỗi gốc
                pass


def _grid_probe_inputs_from_settings(
    settings: Mapping[str, Any], page_index: int
) -> dict[str, Any]:
    """Chuẩn hoá đúng các input mà probe lưới thực sự đọc từ settings export."""

    def _mm_to_pt(key: str) -> float:
        try:
            return float(settings.get(key) or 0.0) * MM_TO_PTS
        except (TypeError, ValueError):
            return 0.0

    sheet_w = _mm_to_pt("sheetWidth")
    sheet_h = _mm_to_pt("sheetHeight")
    margin_left = _mm_to_pt("marginLeft")
    margin_right = _mm_to_pt("marginRight")
    margin_top = _mm_to_pt("marginTop")
    margin_bottom = _mm_to_pt("marginBottom")
    shapes = settings.get("detectedShapesByPage")
    shape_type = None
    shape_props = None
    if isinstance(shapes, Mapping):
        shape_type = shapes.get(str(page_index), shapes.get(page_index))
    params = settings.get("detectedShapeParamsByPage")
    if isinstance(params, Mapping):
        raw_props = params.get(str(page_index), params.get(page_index))
        if isinstance(raw_props, Mapping):
            shape_props = dict(raw_props)
    pont_config = (
        settings.get("pontConfig")
        if str(settings.get("pontType") or "none") != "none"
        else None
    )
    normalized_shape_type = str(shape_type).strip() if shape_type else ""
    return {
        "page_index": int(page_index),
        "usable_w_pt": max(0.0, sheet_w - margin_left - margin_right),
        "usable_h_pt": max(0.0, sheet_h - margin_top - margin_bottom),
        "gap_x_pt": _mm_to_pt("gapX"),
        "gap_y_pt": _mm_to_pt("gapY"),
        "sheet_w_pt": sheet_w,
        "sheet_h_pt": sheet_h,
        "margin_left_pt": margin_left,
        "margin_bottom_pt": margin_bottom,
        "margin_top_pt": margin_top,
        "bleed_pt": _mm_to_pt("bleed"),
        "cut_type": str(settings.get("cutType") or "default"),
        "die_size_mode": str(settings.get("dieSizeMode") or "die"),
        "die_offset_mm": float(settings.get("dieOffsetMm") or 0.0),
        "shape_type": normalized_shape_type or None,
        "shape_props": shape_props,
        "pont_config": pont_config,
        "strategy": GRID_PROBE_STRATEGY,
    }


def quality_gate_input_fingerprint(
    settings: Mapping[str, Any], page_index: int
) -> str:
    """Băm exact input probe; field settings không liên quan không tham gia proof."""

    return _exact_sha256(
        {
            "schemaVersion": QUALITY_GATE_INPUT_SCHEMA_VERSION,
            "gridProbe": _grid_probe_inputs_from_settings(settings, page_index),
        }
    )


def grid_capacity_from_settings(
    source_path: str,
    settings: Mapping[str, Any],
    page_index: int,
) -> int:
    """Như `grid_capacity_for_page` nhưng đọc `settings` camelCase/mm của engine (export).

    Preview có `PreviewLayoutRequest` (point) còn export chỉ có `settings` (mm); hàm này là
    bộ chuyển đơn vị duy nhất để hai bên đo CÙNG một con số.
    """

    normalized = _grid_probe_inputs_from_settings(settings, page_index)
    normalized_page_index = int(normalized.pop("page_index"))
    return grid_capacity_for_page(
        source_path,
        normalized_page_index,
        **normalized,
    )


def grid_capacity_from_request(req: Any, page_index: int, *, source_path: str) -> int:
    """Như trên nhưng đọc `PreviewLayoutRequest` (snake_case, point) của preview."""

    shapes = getattr(req, "detected_shapes_by_page", None)
    shape_type = None
    if isinstance(shapes, Mapping):
        shape_type = shapes.get(str(page_index), shapes.get(page_index))
    if not shape_type:
        shape_type = getattr(req, "shape_type", None)
    params = getattr(req, "detected_shape_params_by_page", None)
    shape_props = None
    if isinstance(params, Mapping):
        raw_props = params.get(str(page_index), params.get(page_index))
        if isinstance(raw_props, Mapping):
            shape_props = dict(raw_props)
    if shape_props is None:
        raw_props = getattr(req, "shape_props", None)
        if isinstance(raw_props, Mapping) and raw_props:
            shape_props = dict(raw_props)
    return grid_capacity_for_page(
        source_path,
        int(page_index),
        usable_w_pt=float(getattr(req, "usable_w", 0.0) or 0.0),
        usable_h_pt=float(getattr(req, "usable_h", 0.0) or 0.0),
        gap_x_pt=float(getattr(req, "gap_x", 0.0) or 0.0),
        gap_y_pt=float(getattr(req, "gap_y", 0.0) or 0.0),
        sheet_w_pt=float(getattr(req, "sheet_w", 0.0) or 0.0),
        sheet_h_pt=float(getattr(req, "sheet_h", 0.0) or 0.0),
        margin_left_pt=float(getattr(req, "margin_left", 0.0) or 0.0),
        margin_bottom_pt=float(getattr(req, "margin_bottom", 0.0) or 0.0),
        margin_top_pt=float(getattr(req, "margin_top", 0.0) or 0.0),
        bleed_pt=float(getattr(req, "bleed", 0.0) or 0.0),
        cut_type=str(getattr(req, "cut_type", None) or "default"),
        die_size_mode=str(getattr(req, "die_size_mode", None) or "die"),
        die_offset_mm=float(getattr(req, "die_offset_mm", 0.0) or 0.0),
        shape_type=shape_type,
        shape_props=shape_props,
        pont_config=getattr(req, "pont_config", None),
    )


_QUALITY_GATE_PROOF_KEYS = frozenset(
    {
        "schemaVersion",
        "policyFingerprint",
        "normalizedInputFingerprint",
        "sourceLocatorId",
        "sourceContentHash",
        "inputHash",
        "layoutFingerprint",
        "pageIndex",
        "layoutIntent",
        "nestingPlaced",
        "nestingSheets",
        "totalQuantity",
        "gridCapacity",
        "decision",
    }
)


def _proof_int(value: Any, field: str, *, expected: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{field} phải là số nguyên không âm.")
    if expected is not None and value != expected:
        raise ValueError(f"{field} không đúng phiên bản được hỗ trợ.")
    return value


def _proof_text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{field} phải là chuỗi không rỗng.")
    return value


def _proof_hash(value: Any, field: str) -> str:
    text = _proof_text(value, field)
    if not _SHA256_PATTERN.fullmatch(text):
        raise ValueError(f"{field} không đúng định dạng SHA-256.")
    return text


def parse_quality_gate_decision_proof(value: Any) -> QualityGateDecisionProof | None:
    """Parse cấu trúc proof thành bản sao typed; chưa cấp thẩm quyền sử dụng.

    Dữ liệu lạ không ném ra caller. Store dùng hàm này để bỏ proof méo nhưng vẫn giữ
    reference hai field cũ; export sau đó xem như proof thiếu và đo lại.
    """

    try:
        if not isinstance(value, Mapping) or frozenset(value) != _QUALITY_GATE_PROOF_KEYS:
            return None
        proof = QualityGateDecisionProof(
            schema_version=_proof_int(
                value.get("schemaVersion"),
                "schemaVersion",
                expected=QUALITY_GATE_PROOF_SCHEMA_VERSION,
            ),
            policy_fingerprint=_proof_hash(
                value.get("policyFingerprint"), "policyFingerprint"
            ),
            normalized_input_fingerprint=_proof_hash(
                value.get("normalizedInputFingerprint"),
                "normalizedInputFingerprint",
            ),
            source_locator_id=_proof_text(
                value.get("sourceLocatorId"), "sourceLocatorId"
            ),
            source_content_hash=_proof_hash(
                value.get("sourceContentHash"), "sourceContentHash"
            ),
            input_hash=_proof_hash(value.get("inputHash"), "inputHash"),
            layout_fingerprint=_proof_hash(
                value.get("layoutFingerprint"), "layoutFingerprint"
            ),
            page_index=_proof_int(value.get("pageIndex"), "pageIndex"),
            layout_intent=_proof_text(value.get("layoutIntent"), "layoutIntent"),
            nesting_placed=_proof_int(value.get("nestingPlaced"), "nestingPlaced"),
            nesting_sheets=_proof_int(value.get("nestingSheets"), "nestingSheets"),
            total_quantity=_proof_int(value.get("totalQuantity"), "totalQuantity"),
            grid_capacity=_proof_int(value.get("gridCapacity"), "gridCapacity"),
            decision=_proof_text(value.get("decision"), "decision"),
        )
        # PERF (audit 2026-09-02 §PERF-NEST-05): 0 nghĩa là phép đo lưới
        # không có kết quả; không được biến nó thành proof “nesting thắng”.
        if proof.grid_capacity <= 0:
            return None
        if proof.decision not in {"grid", "nesting"}:
            return None
        expected_decision = (
            "grid"
            if grid_beats_nesting(
                layout_intent=proof.layout_intent,
                nesting_placed=proof.nesting_placed,
                nesting_sheets=proof.nesting_sheets,
                total_quantity=proof.total_quantity,
                grid_capacity=proof.grid_capacity,
            )
            else "nesting"
        )
        return proof if proof.decision == expected_decision else None
    except (KeyError, TypeError, ValueError, OverflowError):
        return None


def build_quality_gate_decision_proof(
    settings: Mapping[str, Any],
    *,
    source_locator_id: str,
    source_content_hash: str,
    input_hash: str,
    layout_fingerprint: str,
    page_index: int,
    layout_intent: str,
    nesting_placed: int,
    nesting_sheets: int,
    total_quantity: int,
    grid_capacity: int,
) -> dict[str, Any]:
    """Tạo proof từ identity server-owned và đúng phép đo preview vừa hoàn tất."""

    page = _proof_int(page_index, "page_index")
    placed = _proof_int(nesting_placed, "nesting_placed")
    sheets = _proof_int(nesting_sheets, "nesting_sheets")
    quantity = _proof_int(total_quantity, "total_quantity")
    grid = _proof_int(grid_capacity, "grid_capacity")
    if grid <= 0:
        raise ValueError("grid_capacity=0 không phải là một quyết định quality gate.")
    intent = _proof_text(layout_intent, "layout_intent")
    proof = QualityGateDecisionProof(
        schema_version=QUALITY_GATE_PROOF_SCHEMA_VERSION,
        policy_fingerprint=QUALITY_GATE_POLICY_FINGERPRINT,
        normalized_input_fingerprint=quality_gate_input_fingerprint(settings, page),
        source_locator_id=_proof_text(source_locator_id, "source_locator_id"),
        source_content_hash=_proof_hash(source_content_hash, "source_content_hash"),
        input_hash=_proof_hash(input_hash, "input_hash"),
        layout_fingerprint=_proof_hash(layout_fingerprint, "layout_fingerprint"),
        page_index=page,
        layout_intent=intent,
        nesting_placed=placed,
        nesting_sheets=sheets,
        total_quantity=quantity,
        grid_capacity=grid,
        decision=(
            "grid"
            if grid_beats_nesting(
                layout_intent=intent,
                nesting_placed=placed,
                nesting_sheets=sheets,
                total_quantity=quantity,
                grid_capacity=grid,
            )
            else "nesting"
        ),
    )
    return proof.to_dict()


def verify_quality_gate_decision_proof(
    value: Any,
    settings: Mapping[str, Any],
    *,
    source_locator_id: str,
    source_content_hash: str,
    input_hash: str,
    layout_fingerprint: str,
    page_index: int,
    layout_intent: str,
    nesting_placed: int,
    nesting_sheets: int,
    total_quantity: int,
) -> QualityGateDecisionProof | None:
    """Trả proof typed khi còn khớp toàn bộ identity; sai/thiếu ⇒ stale.

    Caller phải đo lại grid khi nhận ``None``. Hàm cố ý không nhận ``decision`` hay
    ``gridCapacity`` từ request hiện tại: hai giá trị đó chỉ có quyền vì nằm trong
    proof do preview server tạo và mọi identity bên ngoài đều đã đối chiếu.
    """

    proof = parse_quality_gate_decision_proof(value)
    if proof is None:
        return None
    try:
        expected = {
            "policy_fingerprint": QUALITY_GATE_POLICY_FINGERPRINT,
            "normalized_input_fingerprint": quality_gate_input_fingerprint(
                settings, _proof_int(page_index, "page_index")
            ),
            "source_locator_id": _proof_text(
                source_locator_id, "source_locator_id"
            ),
            "source_content_hash": _proof_hash(
                source_content_hash, "source_content_hash"
            ),
            "input_hash": _proof_hash(input_hash, "input_hash"),
            "layout_fingerprint": _proof_hash(
                layout_fingerprint, "layout_fingerprint"
            ),
            "page_index": _proof_int(page_index, "page_index"),
            "layout_intent": _proof_text(layout_intent, "layout_intent"),
            "nesting_placed": _proof_int(nesting_placed, "nesting_placed"),
            "nesting_sheets": _proof_int(nesting_sheets, "nesting_sheets"),
            "total_quantity": _proof_int(total_quantity, "total_quantity"),
        }
    except (TypeError, ValueError, OverflowError):
        return None
    return proof if all(getattr(proof, key) == value for key, value in expected.items()) else None


def _bundle_part_for_job(production: Any, job: Any, part_id: str | None = None) -> Mapping[str, Any] | None:
    """Lấy part canonical tương ứng với job mà không đọc lại PDF nguồn."""

    bundle = getattr(production, "render_bundle", None)
    if not isinstance(bundle, Mapping):
        return None
    raw_parts = bundle.get("parts")
    if not isinstance(raw_parts, (list, tuple)):
        return None
    wanted = str(part_id) if part_id is not None else None
    if wanted is None:
        job_parts = getattr(job, "parts", ()) or ()
        if len(job_parts) == 1:
            wanted = str(getattr(job_parts[0], "part_id", ""))
    for raw_part in raw_parts:
        if not isinstance(raw_part, Mapping):
            continue
        if wanted is None or str(raw_part.get("partId")) == wanted:
            return raw_part
    return None


def quality_gate_source_for_session(
    session: Any, job: Any | None = None, *, part_id: str | None = None
) -> dict[str, Any] | None:
    """Trả identity của **snapshot pin** dùng để đo quality gate.

    Không suy source hash từ path đang sống. Chỉ trả kết quả khi descriptor trong
    render bundle khớp một ``PinnedNestingSource`` và có ``snapshot_path``; nếu file
    nguồn đổi giữa solve và gate thì caller dùng snapshot cũ hoặc bỏ proof.
    """

    try:
        solved = getattr(session, "solved")
        production = getattr(solved, "production_request")
        part = _bundle_part_for_job(production, job, part_id)
        if part is None:
            return None
        source = part.get("source")
        if not isinstance(source, Mapping):
            return None
        locator_id = source.get("locatorId")
        content_hash = source.get("contentHash")
        if not isinstance(locator_id, str) or not isinstance(content_hash, str):
            return None
        for pin in getattr(session, "source_pins", ()) or ():
            if (
                str(getattr(pin, "locator_id", "")) == locator_id
                and str(getattr(pin, "content_hash", "")) == content_hash
                and getattr(pin, "snapshot_path", None) is not None
            ):
                return {
                    "source_locator_id": locator_id,
                    # Lấy từ pin (không lấy lại từ path sống) để proof bind đúng snapshot.
                    "source_content_hash": str(pin.content_hash),
                    "source_path": str(pin.snapshot_path),
                }
    except (AttributeError, TypeError, ValueError):
        return None
    return None


def quality_gate_source_for_stored(
    stored: Any, job: Any | None = None, *, part_id: str | None = None
) -> dict[str, Any] | None:
    """Trả identity + path của source snapshot đã promote trong manifest store."""

    try:
        production = getattr(stored, "production_request")
        part = _bundle_part_for_job(production, job, part_id)
        if part is None:
            return None
        source = part.get("source")
        if not isinstance(source, Mapping):
            return None
        locator_id = source.get("locatorId")
        content_hash = source.get("contentHash")
        resolved_sources = getattr(stored, "resolved_sources", None)
        resolved = resolved_sources.get(locator_id) if isinstance(resolved_sources, Mapping) else None
        if (
            not isinstance(locator_id, str)
            or not isinstance(content_hash, str)
            or resolved is None
            or str(getattr(resolved, "content_hash", "")) != content_hash
            or getattr(resolved, "path", None) is None
        ):
            return None
        return {
            "source_locator_id": locator_id,
            "source_content_hash": content_hash,
            "source_path": str(resolved.path),
        }
    except (AttributeError, TypeError, ValueError):
        return None


def _job_total_quantity_for_quality_gate(job: Any) -> int:
    total = 0
    for part in getattr(job, "parts", ()) or ():
        try:
            total += int(getattr(part, "quantity", None) or 0)
        except (TypeError, ValueError):
            return 0
    return total


def build_quality_gate_proof_for_session(
    settings: Mapping[str, Any], job: Any, session: Any, *, grid_capacity: int
) -> dict[str, Any] | None:
    """Tạo proof từ session đã solve; thiếu binding snapshot thì trả ``None``."""

    try:
        job_parts = getattr(job, "parts", ()) or ()
        if len(job_parts) != 1:
            return None
        part_id = str(getattr(job_parts[0], "part_id", ""))
        source = quality_gate_source_for_session(session, job, part_id=part_id)
        if source is None:
            return None
        production = getattr(getattr(session, "solved"), "production_request")
        manifest = getattr(getattr(session, "solved"), "manifest")
        stats = manifest.get("stats") if isinstance(manifest, Mapping) else {}
        placed = int((stats or {}).get("placedCount") or 0)
        sheets = int((stats or {}).get("sheetCount") or 0)
        return build_quality_gate_decision_proof(
            settings,
            source_locator_id=source["source_locator_id"],
            source_content_hash=source["source_content_hash"],
            input_hash=str(getattr(production, "input_hash")),
            layout_fingerprint=str(getattr(production, "layout_fingerprint")),
            page_index=int(getattr(job_parts[0], "page_index")),
            layout_intent=str(getattr(job, "layout_intent", "autofill_single_sheet")),
            nesting_placed=placed,
            nesting_sheets=sheets,
            total_quantity=_job_total_quantity_for_quality_gate(job),
            grid_capacity=int(grid_capacity),
        )
    except (AttributeError, TypeError, ValueError, OverflowError):
        # Proof là đường tăng tốc, không được làm hỏng preview hợp lệ.
        return None


def verify_quality_gate_proof_for_session(
    value: Any, settings: Mapping[str, Any], job: Any, session: Any
) -> QualityGateDecisionProof | None:
    """Verifier tiện dụng cho proof vừa lưu trong kho phiên."""

    try:
        job_parts = getattr(job, "parts", ()) or ()
        if len(job_parts) != 1:
            return None
        part = job_parts[0]
        source = quality_gate_source_for_session(
            session, job, part_id=str(getattr(part, "part_id", ""))
        )
        if source is None:
            return None
        production = getattr(getattr(session, "solved"), "production_request")
        manifest = getattr(getattr(session, "solved"), "manifest")
        stats = manifest.get("stats") if isinstance(manifest, Mapping) else {}
        return verify_quality_gate_decision_proof(
            value,
            settings,
            source_locator_id=source["source_locator_id"],
            source_content_hash=source["source_content_hash"],
            input_hash=str(getattr(production, "input_hash")),
            layout_fingerprint=str(getattr(production, "layout_fingerprint")),
            page_index=int(getattr(part, "page_index")),
            layout_intent=str(getattr(job, "layout_intent", "autofill_single_sheet")),
            nesting_placed=int((stats or {}).get("placedCount") or 0),
            nesting_sheets=int((stats or {}).get("sheetCount") or 0),
            total_quantity=_job_total_quantity_for_quality_gate(job),
        )
    except (AttributeError, TypeError, ValueError, OverflowError):
        return None


def verify_quality_gate_proof_for_stored(
    value: Any, settings: Mapping[str, Any], job: Any, stored: Any
) -> QualityGateDecisionProof | None:
    """Verifier cho consumer export; source phải là snapshot final trong manifest."""

    try:
        job_parts = getattr(job, "parts", ()) or ()
        if len(job_parts) != 1:
            return None
        part = job_parts[0]
        source = quality_gate_source_for_stored(
            stored, job, part_id=str(getattr(part, "part_id", ""))
        )
        if source is None:
            return None
        production = getattr(stored, "production_request")
        manifest = getattr(stored, "manifest")
        stats = manifest.get("stats") if isinstance(manifest, Mapping) else {}
        return verify_quality_gate_decision_proof(
            value,
            settings,
            source_locator_id=source["source_locator_id"],
            source_content_hash=source["source_content_hash"],
            input_hash=str(getattr(production, "input_hash")),
            layout_fingerprint=str(getattr(production, "layout_fingerprint")),
            page_index=int(getattr(part, "page_index")),
            layout_intent=str(getattr(job, "layout_intent", "autofill_single_sheet")),
            nesting_placed=int((stats or {}).get("placedCount") or 0),
            nesting_sheets=int((stats or {}).get("sheetCount") or 0),
            total_quantity=_job_total_quantity_for_quality_gate(job),
        )
    except (AttributeError, TypeError, ValueError, OverflowError):
        return None


__all__ = [
    "GRID_PROBE_STRATEGY",
    "GridBeatsNestingSignal",
    "QUALITY_GATE_INPUT_SCHEMA_VERSION",
    "QUALITY_GATE_POLICY_FINGERPRINT",
    "QUALITY_GATE_PROOF_FIELD",
    "QUALITY_GATE_PROOF_SCHEMA_VERSION",
    "QualityGateDecisionProof",
    "build_quality_gate_decision_proof",
    "build_quality_gate_proof_for_session",
    "grid_beats_nesting",
    "grid_capacity_for_page",
    "grid_capacity_from_request",
    "grid_capacity_from_settings",
    "grid_wins",
    "grid_wins_by_sheets",
    "parse_quality_gate_decision_proof",
    "quality_gate_input_fingerprint",
    "quality_gate_source_for_session",
    "quality_gate_source_for_stored",
    "verify_quality_gate_decision_proof",
    "verify_quality_gate_proof_for_session",
    "verify_quality_gate_proof_for_stored",
]
