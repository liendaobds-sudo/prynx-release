"""Map thiết lập GIA CÔNG của job N-Up sang spec của bundle nesting.

FIX (audit 2026-08-28 §NEST-FINISHING). Đây là lỗ đã giao ra người dùng và phải nói rõ
để không tái diễn.

Nhánh nesting đi renderer **khác** với "Xếp tối ưu"/"Lưới đơn giản": chúng dùng renderer
của ``nup_engine`` — nơi đã cài ốc bế, dấu xén, tách nét bế, trang CUT riêng, report qua
nhiều năm — còn nesting đi ``nesting_imposition_render``. Lô nối dây đầu chỉ map **hình
học** (khổ tờ, lề, khoảng hở, số lượng), nên mọi thiết lập gia công rơi về mặc định:

- ``ImpositionPontSpec.type`` mặc định ``"none"`` ⇒ **không có ốc bế**;
- ``ImpositionTrimSpec.type`` mặc định ``"none"`` ⇒ **không có dấu xén**;
- ``cut_style`` mặc định ⇒ nét bế sai màu/độ dày người dùng chọn;
- ``artifact_options`` mặc định ⇒ **không có report**.

Người dùng nhận tờ bình xếp đúng hình nhưng thiếu hết gia công. Module này đóng lỗ đó.

## Nguyên tắc

1. **Cùng nguồn dữ liệu với đường cũ.** Đọc đúng các khoá mà ``processHandlers`` gửi và
   ``nup_engine`` đọc, không phát minh tên mới.
2. **Fail-soft cho phần trang trí, fail-closed cho phần hình học.** Cấu hình ốc sai không
   được làm hỏng lượt bình — nhưng cũng không được **âm thầm** thành "không ốc": mọi lần
   bỏ đều log rõ.
3. ``normalize_pont_settings`` của route đã chạy trước ở ``_launch_impose_job``, nên
   ``pontConfig`` tới đây đã có đủ default và đã qua kiểm hợp lệ.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping

logger = logging.getLogger(__name__)

#: Khoá report hợp lệ, giữ đồng bộ với `ImpositionArtifactOptions`.
_REPORT_FIELD_KEYS = frozenset(
    {
        "orderCode",
        "identifier",
        "gangCount",
        "labelName",
        "material",
        "lamination",
        "labelsPerSheet",
        "actualQty",
        "sheetCount",
        "dimensions",
        "paperSize",
        "cutFileRef",
        "modeLabel",
    }
)

#: `reportLamination` của UI là chỉ số trong `LAMINATION_OPTIONS`.
_LAMINATION_BY_INDEX = {0: "none", 1: "gloss", 2: "matte"}

#: Cờ bật/tắt từng field report của UI. Nguồn chân lý:
#: `desktop/src/lib/reportPreview.ts` `SHOW_FLAG_KEY`, mirror của
#: `nup_report.build_report_string`.
#:
#: FIX (audit 2026-08-28 §NEST-FINISHING-KEYS): bản đầu chỉ đọc `fieldOrder`. Mà
#: `DEFAULT_REPORT_CONFIG` liệt kê **cả 13** field trong `fieldOrder`, còn việc ẩn field
#: nằm ở các cờ `showX` — nên bỏ cờ nghĩa là vẽ luôn những field người dùng đã tắt.
_REPORT_SHOW_FLAG = {
    "identifier": "showIdentifier",
    "gangCount": "showGangCount",
    "labelName": "showLabelName",
    "dimensions": "showDimensions",
    "paperSize": "showPaperSize",
    "labelsPerSheet": "showLabelsPerSheet",
    "sheetCount": "showSheetCount",
    "actualQty": "showActualQty",
    "material": "showMaterial",
    "lamination": "showLamination",
    "cutFileRef": "showCutFileRef",
    "modeLabel": "showModeLabel",
}

_PONT_SHAPES = frozenset({"circle", "l_corner", "l_inverted"})

#: Vị trí guide hợp lệ. Nguồn chân lý: `backend/app/schemas/pont.py`
#: `_VALID_GUIDE_POSITIONS`.
_GUIDE_POSITIONS = frozenset({"TL", "TR", "BL", "BR"})

#: Số guide mà UI có. Nguồn chân lý: `desktop/src/components/imposition-tools/types.ts`
#: (`guide1*`, `guide2*`) và `schemas/pont.py` vòng `for index in (1, 2)`.
#:
#: FIX (audit 2026-08-28 §NEST-FINISHING-KEYS): bản đầu lặp
#: `range(1, len(_GUIDE_POSITIONS) + 1)` — trộn "số vị trí hợp lệ" với "số guide", nên dò
#: cả `guide3*`/`guide4*` không tồn tại.
_GUIDE_COUNT = 2


def _number(raw: Any, default: float) -> float:
    if isinstance(raw, bool) or raw is None:
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    return value if value == value and value not in (float("inf"), float("-inf")) else default


def _text(raw: Any, default: str = "") -> str:
    return raw if isinstance(raw, str) else default


def _index_or_none(raw: Any) -> int | None:
    """Chỉ số kiểu số của UI → ``int``, hoặc ``None`` nếu không phải chỉ số.

    FIX (audit 2026-08-28 §NEST-FINISHING-KEYS): bản đầu kiểm ``isinstance(raw, int)``, nên
    JSON gửi ``1.0`` (hoàn toàn hợp lệ cho một số nguyên trong JSON) rơi về ``"none"`` —
    cán màng bị mất im lặng. Nhận cả float nguyên, từ chối float lẻ và ``bool``.
    """

    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    value = float(raw)
    if value != value or value in (float("inf"), float("-inf")) or value != int(value):
        return None
    return int(value)


def build_trim_spec(settings: Mapping[str, Any]):
    """Dấu xén — **luôn `none`** trên lane nesting, và đây là điều đúng.

    FIX (audit 2026-08-28 §NEST-TRIM-OUT-OF-SCOPE): bản đầu map `markType` vào spec, làm
    như dấu xén là một tính năng còn thiếu ở writer. Đo lại thì không phải:

    1. Lane lưới **không vẽ** dấu xén cho die-cut. Điều kiện thật ở
       `nup_process_chunk.py:1059`: ``if not is_die_cut and (mark_type in ...)``.
    2. UI **không cho** bật dấu xén cho hai công cụ mà lane nesting phục vụ:
       `IMPOSER_CAPABILITIES` trong `desktop/src/components/imposition-tools/types.ts` khai
       ``diecut: {supportsMarks: false}`` và ``cnc: {supportsMarks: false}``, nên
       `processHandlers.ts:276` luôn gửi ``markType: 'none'``.
    3. Về nghiệp vụ: tem bế và bế rớt CNC được **dao** cắt, không phải bàn cắt xén. Dấu xén
       trên tờ như vậy là dấu vô nghĩa, thợ dễ hiểu sai thành đường cắt.

    Nên viết code vẽ dấu xén cho lane này là thêm bug, không phải đóng lỗ.

    Vẫn cần hàm này thay vì bỏ trắng: một payload dựng tay có thể khai `markType='corners'`
    mà không qua UI. Khi đó spec sẽ mang giá trị mà writer không bao giờ vẽ — im lặng. Ở đây
    ép về `none` **và log**, đúng nguyên tắc "không âm thầm" của module.
    """

    from app.core.nesting_imposition_bundle import ImpositionTrimSpec

    mark_type = _text(settings.get("markType"), "none").strip().lower()
    if mark_type != "none":
        logger.info(
            "[NEST] markType=%r bị bỏ: tem bế/CNC do dao cắt nên lane nesting không vẽ "
            "dấu xén, giống lane lưới.",
            mark_type,
        )
    return ImpositionTrimSpec()


def _build_pont_guides(config: Mapping[str, Any]):
    """Guide ốc: UI phẳng hoá thành `guide{i}Enabled/Pos/Length/Thickness/OffX/OffY`.

    FIX (audit 2026-08-28 §NEST-FINISHING-KEYS): ba lỗi tên khoá trong bản đầu, cả ba đều
    **im lặng** nên không có log nào để lần ra:

    1. Đọc `guide{i}Position` — tên thật là `guide{i}Pos`. Vì luôn `None` nên hàm `continue`
       mọi vòng và trả tuple rỗng: guide **chưa bao giờ** được vẽ.
    2. Đọc `guide{i}OffsetX/OffsetY` — tên thật là `guide{i}OffX/OffY`, nên độ lệch luôn 0.
    3. Bỏ qua `guide{i}Enabled`, tức cờ bật/tắt thật. Sửa xong hai lỗi trên mà không đọc cờ
       này thì lại vẽ cả guide người dùng đã tắt — đổi lỗi này thành lỗi khác.

    Nguồn chân lý cho cả ba: `desktop/src/components/imposition-tools/types.ts` và
    `backend/app/schemas/pont.py` (`normalize_pont_settings`, vòng ``for index in (1, 2)``).
    """

    from app.core.nesting_imposition_bundle import ImpositionPontGuideSpec

    guides = []
    for index in range(1, _GUIDE_COUNT + 1):
        if not config.get(f"guide{index}Enabled", False):
            continue
        position = config.get(f"guide{index}Pos")
        if not isinstance(position, str) or position not in _GUIDE_POSITIONS:
            logger.info(
                "[NEST] guide%d bật nhưng vị trí %r không hợp lệ ⇒ bỏ guide này.",
                index,
                position,
            )
            continue
        guides.append(
            ImpositionPontGuideSpec(
                position=position,
                length_mm=_number(config.get(f"guide{index}Length"), 20.0),
                thickness_mm=_number(config.get(f"guide{index}Thickness"), 0.5),
                offset_x_mm=_number(config.get(f"guide{index}OffX"), 0.0),
                offset_y_mm=_number(config.get(f"guide{index}OffY"), 0.0),
            )
        )
    return tuple(guides)


def build_pont_spec(settings: Mapping[str, Any]):
    """Ốc bế. Thiếu ốc là tờ bình không dùng được nên đây là phần quan trọng nhất.

    Lề của ốc: hợp đồng rút gọn cho phép thiếu, khi đó dùng **lề tờ** — giữ đúng hành vi
    `normalize_pont_settings` đã ghi.
    """

    from app.core.nesting_imposition_bundle import (
        ImpositionPontConfigSpec,
        ImpositionPontSpec,
    )

    pont_type = _text(settings.get("pontType"), "none").strip().lower()
    if pont_type not in ("none", "corner", "5mm", "custom"):
        logger.info("[NEST] pontType %r không hỗ trợ ⇒ không vẽ ốc.", pont_type)
        return ImpositionPontSpec()
    if pont_type == "none":
        return ImpositionPontSpec()

    raw = settings.get("pontConfig")
    if not isinstance(raw, Mapping):
        logger.warning(
            "[NEST] pontType=%s nhưng thiếu pontConfig ⇒ không vẽ ốc được.", pont_type
        )
        return ImpositionPontSpec()

    shape = _text(raw.get("shape"), "circle").strip().lower()
    if shape not in _PONT_SHAPES:
        logger.warning("[NEST] hình ốc %r không hợp lệ ⇒ dùng 'circle'.", shape)
        shape = "circle"

    def margin(key: str) -> float:
        # Thiếu lề ⇒ lấy lề tờ, đúng hợp đồng rút gọn của cấu hình ốc.
        fallback = _number(settings.get(f"margin{key}"), 0.0)
        return _number(raw.get(f"margin{key}"), fallback)

    config = ImpositionPontConfigSpec(
        shape=shape,
        size_mm=_number(raw.get("size"), 5.0),
        thickness_mm=_number(raw.get("thickness"), 0.5),
        is_graphtec=bool(raw.get("isGraphtec", False)),
        layer_info_name=_text(raw.get("layerInfoName")),
        layer_name=_text(raw.get("layerName")),
        group_name=_text(raw.get("groupName")),
        item_name=_text(raw.get("itemName")),
        disable_collision=bool(raw.get("disableCollision", False)),
        margin_top_mm=margin("Top"),
        margin_bottom_mm=margin("Bottom"),
        margin_left_mm=margin("Left"),
        margin_right_mm=margin("Right"),
        guides=_build_pont_guides(raw),
    )
    return ImpositionPontSpec(type=pont_type, config=config)


def build_cut_spec(settings: Mapping[str, Any]):
    """Trang CUT riêng, 1 dao, co/mở khuôn.

    ``separate_page`` mặc định True và **phải** giữ True cho tem bế: dao nằm trên trang in
    là tờ bình không dùng được. UI gửi `separateCutPage`; `cutType == 'one_dao'` thì đường
    cũ luôn ép tách trang, giữ nguyên quy tắc đó.
    """

    from app.core.nesting_imposition_bundle import ImpositionCutSpec

    cut_type = _text(settings.get("cutType"), "default").strip().lower()
    if cut_type not in ("default", "one_dao"):
        cut_type = "default"
    separate = settings.get("separateCutPage")
    separate_page = True if separate is None else bool(separate)
    if cut_type == "one_dao":
        separate_page = True

    die_size_mode = _text(settings.get("dieSizeMode"), "die").strip().lower()
    if die_size_mode not in ("die", "page"):
        die_size_mode = "die"

    ponts_on_cut = settings.get("pontsOnCutFile")
    return ImpositionCutSpec(
        type=cut_type,
        separate_page=separate_page,
        ponts_on_cut_file=True if ponts_on_cut is None else bool(ponts_on_cut),
        fill_block_gap_mm=_number(settings.get("fillBlockGap"), 0.0),
        die_size_mode=die_size_mode,
        die_offset_mm=_number(settings.get("dieOffsetMm"), 0.0),
    )


def build_cut_style_spec(settings: Mapping[str, Any]):
    """Kiểu nét CUT trên tờ ra.

    Mặc định của spec (100% Magenta CMYK, 0,25mm) đúng thói quen file khách Việt Nam nên
    chỉ ghi đè khi UI thật sự khai. Hiện UI chưa có ô riêng cho kiểu nét bế ngoài độ dày
    dấu xén, nên giữ mặc định và ghi nhận ở finding thay vì bịa ánh xạ.
    """

    from app.core.nesting_imposition_bundle import ImpositionCutStyleSpec

    return ImpositionCutStyleSpec()


def build_artifact_options(
    settings: Mapping[str, Any],
    *,
    requested_qty: int | None = None,
    fallback_label_name: str = "",
):
    """Report trên tờ và xuất tờ duy nhất.

    ``requested_qty`` là demand report riêng của S&R; không được dùng làm
    ``JobPartInput.quantity`` vì solver chỉ nhận một tờ đại diện ở lane này.
    """

    from app.core.nesting_imposition_bundle import (
        ImpositionArtifactOptions,
        ImpositionReportDisabled,
        ImpositionReportEnabled,
        ImpositionReportLamination,
    )

    export_unique = settings.get("exportUniqueSheets")
    export_unique_sheets = True if export_unique is None else bool(export_unique)

    display = settings.get("reportDisplay")
    if not isinstance(display, Mapping) or not display.get("enabled"):
        return ImpositionArtifactOptions(
            export_unique_sheets=export_unique_sheets,
            report=ImpositionReportDisabled(),
        )

    # FIX (audit 2026-08-28 §NEST-FINISHING-KEYS): phải lọc theo cờ `showX`, không chỉ
    # `fieldOrder`. `DEFAULT_REPORT_CONFIG` để `fieldOrder` chứa cả 13 field và dùng cờ
    # `showX` để ẩn, nên chỉ đọc `fieldOrder` là vẽ luôn field người dùng đã tắt. Cùng quy
    # tắc với `nup_report.build_report_string` và `reportPreview.ts`: thiếu cờ ⇒ coi như bật.
    raw_order = display.get("fieldOrder")
    seen: set[str] = set()
    fields_list: list[str] = []
    for key in raw_order if isinstance(raw_order, (list, tuple)) else ():
        if not isinstance(key, str) or key not in _REPORT_FIELD_KEYS or key in seen:
            continue
        seen.add(key)
        flag = _REPORT_SHOW_FLAG.get(key)
        if flag is not None and display.get(flag) is False:
            continue
        fields_list.append(key)
    fields = tuple(fields_list)
    if not fields:
        logger.info("[NEST] reportDisplay bật nhưng fieldOrder rỗng ⇒ không vẽ report.")
        return ImpositionArtifactOptions(
            export_unique_sheets=export_unique_sheets,
            report=ImpositionReportDisabled(),
        )

    lamination_type = _LAMINATION_BY_INDEX.get(_index_or_none(settings.get("reportLamination")), "none")
    sides_raw = settings.get("reportLaminationSides")
    sides = 2 if sides_raw == 2 else 1

    return ImpositionArtifactOptions(
        export_unique_sheets=export_unique_sheets,
        report=ImpositionReportEnabled(
            fields=fields,
            # FIX/PARITY (audit 2026-08-29 §MAP-NEST-05): materialize demand
            # và fallback từ trang nguồn tại upstream; writer không đoán từ tên file.
            requested_qty=requested_qty,
            label_name=(
                _text(display.get("labelNameText"))
                if _text(display.get("labelNameText")).strip()
                else _text(fallback_label_name)
            ),
            material=_text(settings.get("reportMaterial")),
            lamination=ImpositionReportLamination(type=lamination_type, sides=sides),
            order_code=_text(settings.get("reportOrderCode")),
            # FIX (audit 2026-08-28 §NEST-FINISHING-KEYS): ba thứ dưới trước đây không được
            # map, nên report luôn ra ở mặc định `top / 5mm / 8pt / centered` bất kể người
            # dùng chọn gì, và `customText` biến mất. Cùng tên khoá với `nup_output_finalize
            # ._stamp_reports` đọc: `reportDisplay.position/offsetX/offsetY/fontSize/centered`.
            custom_text=_text(display.get("customText")),
            remove_diacritics=bool(display.get("removeDiacritics", False)),
            placement=_build_report_placement(display),
        ),
    )


#: Vị trí report hợp lệ. Nguồn chân lý: `ReportDisplayConfig.position` trong `types.ts`.
_REPORT_POSITIONS = frozenset({"top", "bottom", "left", "right"})


def _build_report_placement(display: Mapping[str, Any]):
    """Vị trí report. Mặc định của UI và của spec trùng nhau: top / 5mm / 8pt / centered."""

    from app.core.nesting_imposition_bundle import ImpositionReportPlacement

    position = _text(display.get("position"), "top").strip().lower()
    if position not in _REPORT_POSITIONS:
        logger.info("[NEST] vị trí report %r không hợp lệ ⇒ dùng 'top'.", position)
        position = "top"
    # Hợp đồng bundle chặn `font_size_pt` ngoài 4..40; kẹp ở đây để một giá trị UI lạ không
    # làm vỡ cả lượt bình vì một dòng chữ.
    font_size = _number(display.get("fontSize"), 8.0)
    if not 4.0 <= font_size <= 40.0:
        logger.info("[NEST] fontSize report %r ngoài khoảng 4..40 ⇒ dùng 8pt.", font_size)
        font_size = 8.0
    return ImpositionReportPlacement(
        position=position,
        centered=bool(display.get("centered", True)),
        offset_x_mm=max(0.0, _number(display.get("offsetX"), 5.0)),
        offset_y_mm=max(0.0, _number(display.get("offsetY"), 5.0)),
        font_size_pt=font_size,
    )


# ─────────────────────────────────────────────────────────────────────────────
#  Ốc bế thành VẬT CẢN của solver — §NEST-AUD-03
# ─────────────────────────────────────────────────────────────────────────────


def _pont_corner_centers_mm(
    config, *, sheet_width_mm: float, sheet_height_mm: float
) -> list[tuple[float, float, str]]:
    """Tâm bốn ốc góc, mm, gốc góc trái-dưới tờ.

    Đây là **nguồn chân lý duy nhất** cho vị trí ốc trong không gian engine. Writer
    (`nesting_imposition_render._pont_corner_centers_pt`) tính cùng công thức trong đơn vị
    point; `test_nesting_pont_obstacles.py` so hai bên và đỏ nếu chúng lệch.

    Lệch nhau là lỗi tệ nhất có thể ở đây: vật cản nằm một chỗ, ốc vẽ ở chỗ khác ⇒ solver
    tránh vùng trống còn tem vẫn đè lên dấu canh thật.
    """

    radius = _number(getattr(config, "size_mm", 0.0), 0.0) / 2.0
    x_left = _number(getattr(config, "margin_left_mm", 0.0), 0.0) + radius
    x_right = sheet_width_mm - _number(getattr(config, "margin_right_mm", 0.0), 0.0) - radius
    y_top = sheet_height_mm - _number(getattr(config, "margin_top_mm", 0.0), 0.0) - radius
    y_bottom = _number(getattr(config, "margin_bottom_mm", 0.0), 0.0) + radius
    return [
        (x_left, y_top, "TL"),
        (x_right, y_top, "TR"),
        (x_left, y_bottom, "BL"),
        (x_right, y_bottom, "BR"),
    ]


def _square_ring(cx: float, cy: float, half: float) -> list[list[float]]:
    """Ô vuông bao quanh tâm. Vuông là **bao trên** an toàn cho cả ốc tròn và góc L."""

    return [
        [cx - half, cy - half],
        [cx + half, cy - half],
        [cx + half, cy + half],
        [cx - half, cy + half],
    ]


def _clip_ring_to_sheet(
    ring: list[list[float]], *, sheet_width_mm: float, sheet_height_mm: float
) -> list[list[float]] | None:
    """Cắt ring về trong tờ. Trả ``None`` nếu ra ngoài hoàn toàn hoặc suy biến.

    Vật cản nằm ngoài tờ không có nghĩa với solver, mà validator lại đòi ring hợp lệ — nên
    kẹp về biên thay vì gửi hình có toạ độ âm.
    """

    xs = [max(0.0, min(sheet_width_mm, float(point[0]))) for point in ring]
    ys = [max(0.0, min(sheet_height_mm, float(point[1]))) for point in ring]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    if max_x - min_x <= 1e-9 or max_y - min_y <= 1e-9:
        return None
    return [[min_x, min_y], [max_x, min_y], [max_x, max_y], [min_x, max_y]]


def build_pont_obstacles(
    pont, *, sheet_width_mm: float, sheet_height_mm: float
) -> tuple[dict[str, Any], ...]:
    """Ốc bế và guide thành `fixed_obstacles` để solver KHÔNG xếp tem lên dấu canh.

    FIX (audit 2026-08-29 §NEST-AUD-03). Trước bản vá `fixed_obstacles` của job **luôn rỗng**,
    kể cả khi `disable_collision=False`. Ốc được map đúng và writer vẽ đúng, nhưng solver
    không biết chúng tồn tại. Vì lề ốc (thường 7mm) **lớn hơn** lề tờ (thường 5mm), ốc nằm
    trong vùng dùng được ⇒ tem được xếp đè lên dấu canh. Thợ mất dấu canh là mất cả tờ.

    Lane lưới đã có việc này từ lâu qua `pont_collision.calculate_forbidden_zones` /
    `compute_packer_exclude_zones`; lane nesting chưa có bản tương ứng.

    `disable_collision=True` là người dùng **cố ý** tắt — tôn trọng, không âm thầm bật lại.
    """

    obstacles: list[dict[str, Any]] = []
    if pont is None or getattr(pont, "type", "none") == "none":
        return ()
    config = getattr(pont, "config", None)
    if config is None:
        return ()
    if bool(getattr(config, "disable_collision", False)):
        logger.info("[NEST] disableCollision=True ⇒ không dựng vật cản cho ốc bế.")
        return ()

    size_mm = _number(getattr(config, "size_mm", 0.0), 0.0)
    if size_mm <= 0.0:
        return ()
    half = size_mm / 2.0

    for cx, cy, name in _pont_corner_centers_mm(
        config, sheet_width_mm=sheet_width_mm, sheet_height_mm=sheet_height_mm
    ):
        ring = _clip_ring_to_sheet(
            _square_ring(cx, cy, half),
            sheet_width_mm=sheet_width_mm,
            sheet_height_mm=sheet_height_mm,
        )
        if ring is None:
            continue
        obstacles.append(
            {"obstacleId": f"pont-{name.lower()}", "kind": "sheet_mark", "outer": ring}
        )

    obstacles.extend(
        _guide_obstacles(
            config, sheet_width_mm=sheet_width_mm, sheet_height_mm=sheet_height_mm
        )
    )
    return tuple(obstacles)


def _guide_obstacles(
    config, *, sheet_width_mm: float, sheet_height_mm: float
) -> list[dict[str, Any]]:
    """Vạch guide thành vật cản mỏng. Cùng hệ toạ độ với `_pont_corner_centers_mm`.

    Writer đo `offsetY` từ mép TRÊN cho TL/TR và từ mép DƯỚI cho BL/BR
    (`_pont_guides_stream`). Ở đây phải khớp, nếu không vật cản nằm sai nửa tờ.
    """

    result: list[dict[str, Any]] = []
    for index, guide in enumerate(getattr(config, "guides", ()) or ()):
        position = getattr(guide, "position", "")
        length = _number(getattr(guide, "length_mm", 0.0), 0.0)
        thickness = _number(getattr(guide, "thickness_mm", 0.0), 0.0)
        if length <= 0.0 or thickness <= 0.0 or position not in _GUIDE_POSITIONS:
            continue
        offset_x = _number(getattr(guide, "offset_x_mm", 0.0), 0.0)
        offset_y = _number(getattr(guide, "offset_y_mm", 0.0), 0.0)

        y_center = sheet_height_mm - offset_y if position in ("TL", "TR") else offset_y
        x_start = offset_x if position in ("TL", "BL") else sheet_width_mm - offset_x - length

        half = thickness / 2.0
        ring = _clip_ring_to_sheet(
            [
                [x_start, y_center - half],
                [x_start + length, y_center - half],
                [x_start + length, y_center + half],
                [x_start, y_center + half],
            ],
            sheet_width_mm=sheet_width_mm,
            sheet_height_mm=sheet_height_mm,
        )
        if ring is None:
            continue
        result.append(
            {
                "obstacleId": f"pont-guide-{index + 1}-{position.lower()}",
                "kind": "sheet_mark",
                "outer": ring,
            }
        )
    return result
