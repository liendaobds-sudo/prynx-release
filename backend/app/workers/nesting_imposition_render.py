"""Writer PDF production từ Placement Manifest bất biến của Bình tem/CNC.

Module này **chỉ render**. Nó không solve, không finalize, không recenter và không
sửa manifest. Mọi hình học đến từ manifest đã công bố cộng RenderBundle đã ghim;
writer chỉ đổi hệ đơn vị và ghi toán tử PDF.

## Ba bất biến của writer

1. **Không solve lại.** Không có đường nào gọi kernel hay tính lại pose ở đây.
   Sai số duy nhất được phép là phép đổi mm → PDF unit.
2. **Fail-closed trước khi ghi byte đầu tiên.** Manifest chưa `completed`, validator
   chưa `valid`, `sourceRevision` lệch `renderBundleHash`, thiếu source pin hay
   thiếu trang nguồn thì dừng ngay — không tạo file dở dang.
3. **Thứ tự trang xác định.** Sheet tăng dần, trong mỗi sheet đi theo đúng
   ``renderBundle.outputSides``. Cùng manifest ⇒ cùng thứ tự trang, không phụ
   thuộc thứ tự dict hay hệ điều hành.

## Phân vai artwork và CUT

- ``front``/``back`` là **artwork**: đi qua ``render_manifest_artwork`` →
  ``paint_manifest_page_form``, clip theo ``artworkClipPath`` (chỉ vòng ngoài, vùng
  lỗ vẫn in mực — quyết định cổng Chặng 0 §7.2).
- ``cut`` là **vector CUT**: stroke ``cutContour`` đầy đủ outer + holes, vì dao
  phải cắt cả cửa sổ. Không paint artwork lên trang CUT.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

import pikepdf

from app.core.nesting_imposition_bundle import (
    DUPLEX_REGISTRATION_CIRCLE_DIAMETER_MM,
    DUPLEX_REGISTRATION_LINE_LENGTH_MM,
    DUPLEX_REGISTRATION_MARGIN_MM,
    DUPLEX_REGISTRATION_STROKE_WIDTH_MM,
    ImpositionReportSpec,
    canonicalize_imposition_report,
)
from app.core.perf_sampler import (
    finish_perf_stage,
    increment_perf_counter,
    start_perf_stage,
)
from app.workers.imposition_pdf_form import DIE_STRIPPED_FORM_VARIANT, PT_PER_MM
from app.workers.nup_artwork import (
    ManifestArtworkContractError,
    ManifestPartContext,
    parse_manifest_placement_identity,
    prepare_manifest_part_context,
    render_manifest_artwork,
    resolve_manifest_artwork_placement,
)
from app.workers.nup_clip_shape import transform_manifest_polygon_rings


ARTWORK_SIDES: frozenset[str] = frozenset({"front", "back"})
CUT_SIDE = "cut"
PRODUCTION_WRITER_VERSION = "nesting-manifest-writer-v6-unique-recipes"

_SheetRecipeCellKey = tuple[str, str, str, str]
_SheetRecipeKey = tuple[str, tuple[_SheetRecipeCellKey, ...]]
_SheetPlacementIndex = Mapping[int, Sequence[Mapping[str, Any]]]

#: Màu ốc bế và guide: **registration** CMYK 100/100/100/100.
#:
#: FIX (audit 2026-08-28 §NEST-WRITER-PONT): giữ đúng màu mà `nup_marks._draw_ponts_on_page`
#: dùng (`color = (1, 1, 1, 1)`), không dùng đen RGB. Đen RGB chỉ lên kẽm K nên khi in tách
#: màu thì ốc mất trên ba kẽm còn lại — thợ không canh được. Mục tiêu ở đây là **parity với
#: lane lưới**: cùng file, cùng thiết lập thì hai lane phải ra tờ giống nhau.
_PONT_REGISTRATION_CMYK = (1.0, 1.0, 1.0, 1.0)

#: Vị trí bốn ốc góc, theo thứ tự vẽ của lane cũ.
_PONT_CORNERS = ("TL", "TR", "BL", "BR")

# Toán tử đặt màu nét stroke theo không gian màu.
_STROKE_COLOR_OPERATOR = {"cmyk": "K", "rgb": "RG", "gray": "G"}


class ManifestRenderContractError(ValueError):
    """Manifest/bundle không đủ điều kiện để render artifact production."""


@dataclass(frozen=True, slots=True)
class RenderedProductionSheet:
    """Một trang đã ghi, giữ đủ thông tin để test đối chiếu với manifest."""

    page_index: int
    sheet_index: int
    side: str
    instance_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ProductionRenderResult:
    """Kết quả render; không mang lại hình học để caller không sửa ngược."""

    output_path: Path
    writer_version: str
    manifest_id: str
    layout_fingerprint: str
    render_bundle_hash: str
    report_hash: str
    artifact_render_fingerprint: str
    sheet_count: int
    sides: tuple[str, ...]
    pages: tuple[RenderedProductionSheet, ...]

    @property
    def page_count(self) -> int:
        return len(self.pages)


def _mapping(value: Any, field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ManifestRenderContractError(f"{field} phải là object.")
    return value


def _positive_mm(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ManifestRenderContractError(f"{field} phải là số.")
    result = float(value)
    if not math.isfinite(result) or result <= 0.0:
        raise ManifestRenderContractError(f"{field} phải là số hữu hạn dương.")
    return result


def _assert_renderable(
    manifest: Mapping[str, Any], *, render_bundle_hash: str
) -> None:
    """Cổng fail-closed: chỉ manifest terminal hợp lệ mới được render."""

    status = manifest.get("status")
    if status != "completed":
        raise ManifestRenderContractError(
            f"Chỉ render manifest đã completed; manifest hiện ở trạng thái {status!r}."
        )
    validation = _mapping(manifest.get("validation"), "manifest.validation")
    if validation.get("valid") is not True:
        raise ManifestRenderContractError(
            "Manifest chưa qua validator; không được render artifact."
        )
    placements = manifest.get("placements")
    if not isinstance(placements, Sequence) or isinstance(placements, (str, bytes)):
        raise ManifestRenderContractError("manifest.placements phải là mảng.")
    if not placements:
        raise ManifestRenderContractError(
            "Manifest không có placement nào để render."
        )
    unplaced = manifest.get("unplaced")
    if not isinstance(unplaced, Sequence) or isinstance(unplaced, (str, bytes)):
        raise ManifestRenderContractError("manifest.unplaced phải là mảng.")
    if unplaced:
        # Manifest hợp lệ mà còn unplaced nghĩa là intent chưa được thoả; xuất file
        # lúc này là giao thiếu hàng mà artifact trông như đủ.
        raise ManifestRenderContractError(
            "Manifest còn chi tiết chưa xếp; không được xuất artifact production."
        )
    for index, placement in enumerate(placements):
        item = _mapping(placement, f"manifest.placements[{index}]")
        if item.get("sourceRevision") != render_bundle_hash:
            raise ManifestRenderContractError(
                f"manifest.placements[{index}].sourceRevision không khớp "
                "renderBundleHash — bản mẫu đã đổi sau khi tính."
            )


def _sheet_count(manifest: Mapping[str, Any]) -> int:
    """Số tờ suy từ placement, và phải khớp `stats.sheetCount` đã công bố."""

    indices: set[int] = set()
    for index, placement in enumerate(manifest["placements"]):
        raw = _mapping(placement, f"manifest.placements[{index}]").get("sheetIndex")
        if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0:
            raise ManifestRenderContractError(
                f"manifest.placements[{index}].sheetIndex phải là số nguyên không âm."
            )
        indices.add(raw)
    expected = set(range(len(indices)))
    if indices != expected:
        raise ManifestRenderContractError(
            "sheetIndex phải liên tục từ 0; manifest đang thiếu tờ ở giữa."
        )
    stats = _mapping(manifest.get("stats"), "manifest.stats")
    if stats.get("sheetCount") != len(indices):
        raise ManifestRenderContractError(
            "stats.sheetCount không khớp số tờ suy từ placements."
        )
    if stats.get("placedCount") != len(manifest["placements"]):
        raise ManifestRenderContractError(
            "stats.placedCount không khớp số placement."
        )
    return len(indices)


def _output_sides(bundle: Mapping[str, Any]) -> tuple[str, ...]:
    raw = bundle.get("outputSides")
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)) or not raw:
        raise ManifestRenderContractError("renderBundle.outputSides phải là mảng.")
    sides = tuple(raw)
    if any(side not in {"front", "back", CUT_SIDE} for side in sides):
        raise ManifestRenderContractError(
            "renderBundle.outputSides chỉ nhận front/back/cut."
        )
    if len(set(sides)) != len(sides):
        raise ManifestRenderContractError("renderBundle.outputSides bị trùng side.")
    if "front" not in sides:
        raise ManifestRenderContractError("renderBundle.outputSides phải có front.")
    return sides


def _parts_by_id(bundle: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    raw_parts = bundle.get("parts")
    if not isinstance(raw_parts, Sequence) or isinstance(raw_parts, (str, bytes)):
        raise ManifestRenderContractError("renderBundle.parts phải là mảng.")
    parts: dict[str, Mapping[str, Any]] = {}
    for index, part in enumerate(raw_parts):
        item = _mapping(part, f"renderBundle.parts[{index}]")
        part_id = item.get("partId")
        if not isinstance(part_id, str) or not part_id:
            raise ManifestRenderContractError(
                f"renderBundle.parts[{index}].partId không hợp lệ."
            )
        if part_id in parts:
            raise ManifestRenderContractError(
                f"renderBundle.parts có partId trùng {part_id!r}."
            )
        parts[part_id] = item
    if not parts:
        raise ManifestRenderContractError("renderBundle.parts không được rỗng.")
    return parts


def _format_number(value: float) -> str:
    normalized = 0.0 if abs(value) < 0.5e-9 else value
    return f"{normalized:.9f}"


_ALTERNATE_PDF_SPACE = {
    "cmyk": pikepdf.Name.DeviceCMYK,
    "rgb": pikepdf.Name.DeviceRGB,
    "gray": pikepdf.Name.DeviceGray,
}


def _finite_unit_components(raw: Any, field: str) -> list[float]:
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)) or not raw:
        raise ManifestRenderContractError(f"{field} phải là mảng số không rỗng.")
    values: list[float] = []
    for index, item in enumerate(raw):
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            raise ManifestRenderContractError(f"{field}[{index}] phải là số.")
        value = float(item)
        if not math.isfinite(value) or not 0.0 <= value <= 1.0:
            raise ManifestRenderContractError(
                f"{field}[{index}] phải trong khoảng 0..1."
            )
        values.append(value)
    return values


def _separation_stroke_prologue(
    stroke: Mapping[str, Any], *, page: pikepdf.Page
) -> str:
    """Dựng colorspace ``/Separation`` thật rồi đặt tint làm màu stroke."""

    field = "renderBundle.cutStyle.stroke"
    name = stroke.get("separationName")
    if not isinstance(name, str) or not name:
        raise ManifestRenderContractError(f"{field}.separationName không hợp lệ.")
    alternate = _mapping(stroke.get("alternate"), f"{field}.alternate")
    space = alternate.get("space")
    pdf_space = _ALTERNATE_PDF_SPACE.get(space)
    if pdf_space is None:
        raise ManifestRenderContractError(
            f"{field}.alternate.space không được writer hỗ trợ."
        )
    alternate_components = _finite_unit_components(
        alternate.get("components"), f"{field}.alternate.components"
    )
    tint = _finite_unit_components(stroke.get("components"), f"{field}.components")
    if len(tint) != 1:
        raise ManifestRenderContractError(
            f"{field}.components phải có đúng một tint cho separation."
        )
    width_mm = _positive_mm(stroke.get("widthMm"), f"{field}.widthMm")
    overprint = stroke.get("overprint")
    if not isinstance(overprint, bool):
        raise ManifestRenderContractError(f"{field}.overprint phải là boolean.")

    # tint 0 → trắng (mọi kênh 0), tint 1 → đúng màu alternate đã khai.
    tint_transform = pikepdf.Dictionary(
        FunctionType=2,
        Domain=[0.0, 1.0],
        C0=[0.0] * len(alternate_components),
        C1=list(alternate_components),
        N=1.0,
    )
    colorspace = pikepdf.Array(
        [
            pikepdf.Name.Separation,
            pikepdf.Name("/" + name),
            pdf_space,
            tint_transform,
        ]
    )
    resource = page.add_resource(colorspace, pikepdf.Name.ColorSpace)
    resource_text = str(resource)
    if not resource_text.startswith("/"):
        resource_text = "/" + resource_text

    operations = [
        f"{_format_number(width_mm * PT_PER_MM)} w",
        f"{resource_text} CS",
        f"{_format_number(tint[0])} SCN",
    ]
    if overprint:
        state = pikepdf.Dictionary(
            Type=pikepdf.Name.ExtGState, OP=True, op=True, OPM=1
        )
        gs_name = page.add_resource(state, pikepdf.Name.ExtGState)
        gs_text = str(gs_name)
        if not gs_text.startswith("/"):
            gs_text = "/" + gs_text
        operations.append(f"{gs_text} gs")
    return "\n".join(operations) + "\n"


def _cut_stroke_prologue(
    cut_style: Mapping[str, Any], *, page: pikepdf.Page
) -> str:
    """Dựng toán tử đặt nét CUT: độ dày, màu stroke, overprint.

    NEST (audit 2026-08-28 §A3.1): ``separation`` dựng colorspace thật
    ``[/Separation /Name <alternate> <tint transform>]`` từ ``stroke.alternate``.
    Tint transform là function type 2 (exponential) đi từ tint 0 = trắng tới
    tint 1 = màu alternate, đúng ngữ nghĩa mà RIP mong đợi khi kênh spot không
    tồn tại trên máy.
    """

    stroke = _mapping(cut_style.get("stroke"), "renderBundle.cutStyle.stroke")
    color_space = stroke.get("colorSpace")
    if color_space == "separation":
        return _separation_stroke_prologue(stroke, page=page)
    operator = _STROKE_COLOR_OPERATOR.get(color_space)
    if operator is None:
        raise ManifestRenderContractError(
            "cutStyle.stroke.colorSpace không được writer hỗ trợ."
        )
    components = stroke.get("components")
    if not isinstance(components, Sequence) or isinstance(components, (str, bytes)):
        raise ManifestRenderContractError(
            "cutStyle.stroke.components phải là mảng số."
        )
    values = []
    for index, component in enumerate(components):
        if isinstance(component, bool) or not isinstance(component, (int, float)):
            raise ManifestRenderContractError(
                f"cutStyle.stroke.components[{index}] phải là số."
            )
        value = float(component)
        if not math.isfinite(value) or not 0.0 <= value <= 1.0:
            raise ManifestRenderContractError(
                f"cutStyle.stroke.components[{index}] phải trong khoảng 0..1."
            )
        values.append(value)
    width_mm = _positive_mm(stroke.get("widthMm"), "cutStyle.stroke.widthMm")

    operations = [
        f"{_format_number(width_mm * PT_PER_MM)} w",
        " ".join(_format_number(value) for value in values) + f" {operator}",
    ]
    overprint = stroke.get("overprint")
    if not isinstance(overprint, bool):
        raise ManifestRenderContractError(
            "cutStyle.stroke.overprint phải là boolean."
        )
    if overprint:
        # Overprint phải đi qua ExtGState; đặt cả OP (stroke) và op (fill) để
        # RIP không phải suy diễn từ một nửa hợp đồng.
        state = pikepdf.Dictionary(
            Type=pikepdf.Name.ExtGState,
            OP=True,
            op=True,
            OPM=1,
        )
        name = page.add_resource(state, pikepdf.Name.ExtGState)
        resource_text = str(name)
        if not resource_text.startswith("/"):
            resource_text = "/" + resource_text
        operations.append(f"{resource_text} gs")
    return "\n".join(operations) + "\n"


def _cut_rings_stream(
    rings_mm: Sequence[Sequence[Sequence[float]]],
    *,
    origin: tuple[float, float],
) -> str:
    """Vẽ và stroke từng ring CUT. Mỗi ring là một subpath kín."""

    operations: list[str] = []
    for ring_index, ring in enumerate(rings_mm):
        if not isinstance(ring, Sequence) or len(ring) < 3:
            raise ManifestRenderContractError(
                f"cutContour ring[{ring_index}] phải có ít nhất ba điểm."
            )
        for point_index, point in enumerate(ring):
            if not isinstance(point, Sequence) or len(point) != 2:
                raise ManifestRenderContractError(
                    f"cutContour ring[{ring_index}][{point_index}] phải có hai toạ độ."
                )
            x_pt = origin[0] + float(point[0]) * PT_PER_MM
            y_pt = origin[1] + float(point[1]) * PT_PER_MM
            verb = "m" if point_index == 0 else "l"
            operations.append(
                f"{_format_number(x_pt)} {_format_number(y_pt)} {verb}"
            )
        operations.append("h")
    # Một lệnh S cho toàn bộ subpath: nét bế là một đường liên tục của dao.
    operations.append("S")
    return "\n".join(operations) + "\n"


#: Nhãn chế độ trên report, khớp literal lane lưới cũ trong `nup_engine`.
_MODE_LABEL_BY_TOOL = {
    "sticker_imposer": "Bế tem",
    "cnc_imposer": "Bình bế rớt CNC",
}


def _single_mold_report_facts(
    parts: Mapping[str, Mapping[str, Any]],
    part_ids: Sequence[str],
) -> tuple[str, str, str]:
    """(dimensions, identifier, labelFallback) suy từ mẫu của MỘT tờ.

    FIX (audit 2026-08-29 §MAP-NEST-06 · re-audit 2026-09-01 §DIM-DIE): bundle
    mới mang ``dieDimensionsMm`` lấy từ ``DetectedShape.trim`` server-side, đúng
    số viewer đã hiển thị. Không đo lại bbox ``cutContour`` vì contour production
    dùng phép hợp/lấy mẫu khác và thực tế đã lệch 45,3×52,3 thành 45,4×52,9mm.
    Bundle V2 cũ chưa có field mới được fallback bbox contour để vẫn render được;
    tuyệt đối không dùng ``pageBoxesMm.trimBox`` vì đó là khổ trang PDF.

    identifier + fallback ``Trang N`` lấy theo số trang nguồn. Tờ gang nhiều mẫu
    trả rỗng (số mẫu đã do ``gangCount`` đảm nhiệm), kích thước hỗn hợp nên bỏ
    trống như lane cũ.
    """

    if len(part_ids) != 1:
        return "", "", ""
    part_id = next(iter(part_ids))
    part = parts.get(part_id)
    if not isinstance(part, Mapping):
        return "", "", ""

    identifier = ""
    label_fallback = ""
    page_index_for_log: int | None = None
    pages = part.get("pages")
    binding = pages.get("front") if isinstance(pages, Mapping) else None
    if isinstance(binding, Mapping):
        page_index = binding.get("pageIndex")
        if (
            not isinstance(page_index, bool)
            and isinstance(page_index, int)
            and page_index >= 0
        ):
            page_index_for_log = page_index
            identifier = str(page_index + 1)
            label_fallback = f"Trang {page_index + 1}"

    raw_die_dimensions = part.get("dieDimensionsMm")
    dimensions = _die_dimensions_text(raw_die_dimensions)
    dimension_source = "dieDimensionsMm"
    if not dimensions:
        # Tương thích manifest V2 đã lưu trước §DIM-DIE; bundle mới luôn có SSOT.
        dimension_source = "cutContour_fallback"
        dimensions = _legacy_cut_contour_dimensions_text(part.get("cutContour"))

    # SEC (audit 2026-09-05 §LOG.06): raw bundle và kích thước đã
    # format chỉ là diagnostic dev, không đưa lên warning production.
    import logging

    logging.getLogger(__name__).debug(
        "[DIM-DIE-TRACE] stage=writer_dimensions part_id=%s page_index=%s "
        "source=%s die_dimensions_mm=%r formatted=%r",
        part_id,
        page_index_for_log,
        dimension_source,
        raw_die_dimensions,
        dimensions,
    )
    return dimensions, identifier, label_fallback


def _die_dimensions_text(die_dimensions_mm: Any) -> str:
    """Format kích thước thành phẩm authoritative; rỗng nếu contract không đọc được."""

    from app.workers import nup_report

    if not isinstance(die_dimensions_mm, Mapping):
        return ""
    raw_width = die_dimensions_mm.get("width")
    raw_height = die_dimensions_mm.get("height")
    if isinstance(raw_width, bool) or isinstance(raw_height, bool):
        return ""
    try:
        width = float(raw_width)
        height = float(raw_height)
    except (TypeError, ValueError, OverflowError):
        return ""
    if (
        not math.isfinite(width)
        or not math.isfinite(height)
        or width <= 0.0
        or height <= 0.0
    ):
        return ""
    return (
        f"{nup_report._format_report_mm(width)} x "
        f"{nup_report._format_report_mm(height)} mm"
    )


def _legacy_cut_contour_dimensions_text(cut_contour: Any) -> str:
    """Fallback bbox chỉ dành cho bundle V2 cũ chưa có ``dieDimensionsMm``.

    Extent (max−min) bất biến với vị trí đặt/pose trên tờ. Không dùng đường này
    cho bundle mới vì bbox contour không bắt buộc bằng ``DetectedShape.trim``.
    """

    from app.workers import nup_report

    if not isinstance(cut_contour, Mapping):
        return ""
    outer = cut_contour.get("outer")
    if (
        not isinstance(outer, Sequence)
        or isinstance(outer, (str, bytes))
        or len(outer) < 3
    ):
        return ""
    xs: list[float] = []
    ys: list[float] = []
    for point in outer:
        if (
            not isinstance(point, Sequence)
            or isinstance(point, (str, bytes))
            or len(point) != 2
        ):
            return ""
        try:
            xs.append(float(point[0]))
            ys.append(float(point[1]))
        except (TypeError, ValueError):
            return ""
    width = max(xs) - min(xs)
    height = max(ys) - min(ys)
    if width <= 0.0 or height <= 0.0:
        return ""
    return (
        f"{nup_report._format_report_mm(width)} x "
        f"{nup_report._format_report_mm(height)} mm"
    )


def _report_text(
    report: Mapping[str, Any],
    *,
    manifest: Mapping[str, Any],
    engine_request: Mapping[str, Any],
    parts: Mapping[str, Mapping[str, Any]],
    sheet_index: int,
    sheet_count: int,
    recipe_run_count: int | None = None,
    tool: str = "",
    placements_by_sheet: _SheetPlacementIndex | None = None,
) -> str:
    """Dựng report cho đúng một physical sheet từ các đại lượng tách biệt.

    FIX/PARITY (audit 2026-08-29 §MAP-NEST-05): không dùng
    ``compute_report_data`` vì helper legacy giả định mọi tờ có cùng sức chứa.
    Writer dựng field tường minh rồi chỉ dùng chung ``build_report_string`` để
    giữ thứ tự, custom text và quy tắc bỏ dấu giống lane lưới.

    Với ``exportUniqueSheets``, ``recipe_run_count`` là số occurrence vật lý của
    đúng template này; tổng ``sheet_count`` vẫn giữ nguyên sự thật của manifest.
    """

    from app.workers import nup_report

    if recipe_run_count is not None and (
        isinstance(recipe_run_count, bool)
        or not isinstance(recipe_run_count, int)
        or recipe_run_count <= 0
    ):
        raise ManifestRenderContractError("recipe_run_count phải là số nguyên dương.")
    effective_run_count = (
        sheet_count if recipe_run_count is None else recipe_run_count
    )

    sheet = _mapping(engine_request.get("sheet"), "engineRequest.sheet")
    placements = manifest.get("placements")
    if isinstance(placements, (str, bytes)) or not isinstance(placements, Sequence):
        raise ManifestRenderContractError("manifest.placements phải là mảng.")
    # PERF (audit 2026-09-07 §TEMPERF.4): writer truyền cùng index đã kiểm;
    # helper độc lập giữ đường đọc raw cũ để không đổi hợp đồng caller/test.
    sheet_placements = (
        placements_by_sheet.get(sheet_index, ())
        if placements_by_sheet is not None
        else [
            _mapping(item, "manifest.placements[]")
            for item in placements
            if isinstance(item, Mapping) and item.get("sheetIndex") == sheet_index
        ]
    )
    items_on_this_sheet = len(sheet_placements)
    if items_on_this_sheet <= 0:
        raise ManifestRenderContractError(
            f"Tờ {sheet_index} không có placement để dựng report."
        )

    part_ids: set[str] = set()
    for item in sheet_placements:
        part_id = item.get("partId")
        if not isinstance(part_id, str) or part_id not in parts:
            raise ManifestRenderContractError(
                f"Report tờ {sheet_index} gặp partId không có trong RenderBundle."
            )
        part_ids.add(part_id)

    stats = _mapping(manifest.get("stats"), "manifest.stats")
    placed_in_manifest = stats.get("placedCount")
    if (
        isinstance(placed_in_manifest, bool)
        or not isinstance(placed_in_manifest, int)
        or placed_in_manifest <= 0
    ):
        raise ManifestRenderContractError("manifest.stats.placedCount không hợp lệ.")

    layout_intent = engine_request.get("layoutIntent")
    requested_qty: int | None = None
    if layout_intent == "quantity_fulfillment":
        raw_parts = engine_request.get("parts")
        if isinstance(raw_parts, (str, bytes)) or not isinstance(raw_parts, Sequence):
            raise ManifestRenderContractError("engineRequest.parts phải là mảng.")
        requested_qty = 0
        for index, raw_part in enumerate(raw_parts):
            part = _mapping(raw_part, f"engineRequest.parts[{index}]")
            quantity = part.get("quantity")
            if isinstance(quantity, bool) or not isinstance(quantity, int) or quantity <= 0:
                raise ManifestRenderContractError(
                    f"engineRequest.parts[{index}].quantity phải là số nguyên dương."
                )
            requested_qty += quantity
        placed_qty = placed_in_manifest
        run_count = effective_run_count
    elif layout_intent == "step_repeat_single_sheet":
        raw_requested = report.get("requestedQty")
        if raw_requested is not None and (
            isinstance(raw_requested, bool)
            or not isinstance(raw_requested, int)
            or raw_requested <= 0
        ):
            raise ManifestRenderContractError(
                "artifactOptions.report.requestedQty phải là số nguyên dương hoặc null."
            )
        requested_qty = raw_requested
        if requested_qty is None:
            run_count = effective_run_count
            placed_qty = placed_in_manifest
        else:
            run_count = math.ceil(requested_qty / items_on_this_sheet)
            placed_qty = items_on_this_sheet * run_count
    elif layout_intent == "autofill_single_sheet":
        if report.get("requestedQty") is not None:
            raise ManifestRenderContractError(
                "Report autofill không được mang requestedQty."
            )
        run_count = effective_run_count
        placed_qty = placed_in_manifest
    else:
        raise ManifestRenderContractError(
            f"engineRequest.layoutIntent không hỗ trợ report: {layout_intent!r}."
        )

    lamination = _mapping(report.get("lamination"), "artifactOptions.report.lamination")
    lamination_type = lamination.get("type")
    lamination_sides = lamination.get("sides")
    if lamination_type not in {"none", "gloss", "matte"} or lamination_sides not in {1, 2}:
        raise ManifestRenderContractError(
            "artifactOptions.report.lamination không hợp lệ."
        )
    lamination_text = {"none": "", "gloss": "Cán bóng", "matte": "Cán mờ"}[
        str(lamination_type)
    ]
    if lamination_text and lamination_sides == 2:
        lamination_text += " 2 mặt"

    # FIX (audit 2026-08-29 §MAP-NEST-06): metadata report per-sheet cho true-shape.
    # modeLabel suy từ công cụ (job-level); dimensions/identifier/labelName fallback
    # chỉ dựng cho tờ MỘT mẫu — tờ gang để trống, nhường số mẫu cho gangCount.
    sheet_dimensions, sheet_identifier, sheet_label_fallback = (
        _single_mold_report_facts(parts, sorted(part_ids))
    )
    sheet_label_name = str(report.get("labelName") or "") or sheet_label_fallback

    # Bốn giá trị raw giữ riêng để không bao giờ suy actual từ
    # runCount × itemsOnThisSheet ở manifest có tờ cuối không đầy.
    data: dict[str, Any] = {
        "raw": {
            "requestedQty": requested_qty,
            "placedQty": placed_qty,
            "itemsOnThisSheet": items_on_this_sheet,
            "runCount": run_count,
        },
        "orderCode": str(report.get("orderCode") or ""),
        "identifier": sheet_identifier,
        "gangCount": f"{len(part_ids)} mẫu" if part_ids else "",
        "labelName": sheet_label_name,
        "material": str(report.get("material") or ""),
        "lamination": lamination_text,
        "labelsPerSheet": f"SL/tờ: {items_on_this_sheet}",
        "actualQty": f"SL thực: {placed_qty}",
        "sheetCount": f"Số tờ: {run_count}",
        "dimensions": sheet_dimensions,
        "paperSize": (
            f"{_format_number(float(sheet['widthMm']))}x"
            f"{_format_number(float(sheet['heightMm']))}mm"
        ),
        "cutFileRef": "",
        "modeLabel": _MODE_LABEL_BY_TOOL.get(tool, ""),
    }
    fields = report.get("fields")
    if isinstance(fields, (str, bytes)) or not isinstance(fields, Sequence):
        raise ManifestRenderContractError("artifactOptions.report.fields phải là mảng.")
    return nup_report.build_report_string(
        {
            # `fields` đã lọc theo cờ `showX` ở build_artifact_options.
            "fieldOrder": list(fields),
            "customText": report.get("customText") or "",
            "removeDiacritics": bool(report.get("removeDiacritics")),
        },
        data,
    )


def _stamp_report(
    target: Path,
    *,
    report: Mapping[str, Any],
    rendered_pages: Sequence[RenderedProductionSheet],
    manifest: Mapping[str, Any],
    engine_request: Mapping[str, Any],
    parts: Mapping[str, Mapping[str, Any]],
    sheet_count: int,
    recipe_run_counts: Mapping[int, int] | None = None,
    tool: str = "",
    placements_by_sheet: _SheetPlacementIndex | None = None,
) -> None:
    """Vẽ text riêng theo physical sheet lên Front/Back; tuyệt đối bỏ trang CUT."""

    from app.workers import nup_report

    text_by_sheet: dict[int, str] = {}
    reports_by_page: dict[int, str] = {}
    for page in rendered_pages:
        if page.side not in ARTWORK_SIDES:
            continue
        text = text_by_sheet.get(page.sheet_index)
        if text is None:
            recipe_run_count: int | None = None
            if recipe_run_counts is not None:
                raw_run_count = recipe_run_counts.get(page.sheet_index)
                if (
                    isinstance(raw_run_count, bool)
                    or not isinstance(raw_run_count, int)
                    or raw_run_count <= 0
                ):
                    raise ManifestRenderContractError(
                        f"Thiếu run count hợp lệ cho recipe tờ {page.sheet_index}."
                    )
                recipe_run_count = raw_run_count
            text = _report_text(
                report,
                manifest=manifest,
                engine_request=engine_request,
                parts=parts,
                sheet_index=page.sheet_index,
                sheet_count=sheet_count,
                recipe_run_count=recipe_run_count,
                tool=tool,
                placements_by_sheet=placements_by_sheet,
            )
            text_by_sheet[page.sheet_index] = text
        if text:
            reports_by_page[page.page_index] = text
    if not reports_by_page:
        return

    placement = _mapping(report.get("placement"), "artifactOptions.report.placement")
    # PERF (audit 2026-09-02 §PERF-NEST-06): đo một lượt reopen/overlay/save;
    # không phát log riêng cho từng trang report.
    perf_sample = start_perf_stage()
    try:
        ok = nup_report.stamp_reports_on_pdf(
            str(target),
            str(target),
            reports_by_page,
            position=str(placement.get("position") or "top"),
            offset_x_mm=float(placement.get("offsetXmm") or 0.0),
            offset_y_mm=float(placement.get("offsetYmm") or 0.0),
            font_size=float(placement.get("fontSizePt") or 8.0),
            centered=bool(placement.get("centered", True)),
        )
    finally:
        finish_perf_stage(
            perf_sample,
            "writer_report_s",
            count_name="writer_report_attempts",
        )
    if not ok:
        target.unlink(missing_ok=True)
        raise ManifestRenderContractError(
            "Không ghi được report lên artifact. Đã bỏ file để không giao tờ thiếu report."
        )
    increment_perf_counter("writer_report_successes")
    increment_perf_counter("writer_save_successes")


def _pont_margins_pt(config: Mapping[str, Any]) -> dict[str, float]:
    margins = _mapping(config.get("marginsMm"), "marks.pont.config.marginsMm")
    result: dict[str, float] = {}
    for key in ("top", "bottom", "left", "right"):
        raw = margins.get(key)
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            raise ManifestRenderContractError(
                f"marks.pont.config.marginsMm.{key} phải là số."
            )
        value = float(raw)
        if not math.isfinite(value) or value < 0.0:
            raise ManifestRenderContractError(
                f"marks.pont.config.marginsMm.{key} phải là số hữu hạn không âm."
            )
        result[key] = value * PT_PER_MM
    return result


def _pont_corner_centers_pt(
    config: Mapping[str, Any], *, width_pt: float, height_pt: float, radius_pt: float
) -> list[tuple[float, float, str]]:
    """Tâm bốn ốc góc, trong hệ PDF **bottom-up**.

    Lane cũ (`nup_marks`) tính trong hệ pymupdf **top-down**: ``cy_T = marginTop + radius``
    và ``cy_B = sheet_h - marginBottom - radius``. Writer này ghi toán tử PDF thô nên y đi
    từ dưới lên; phải đảo đúng một lần ở đây, nếu không ốc lật trên–dưới và lề top/bottom
    hoán vị nhau — sai lặng lẽ mà chỉ đo trên tờ in mới thấy.
    """

    margins = _pont_margins_pt(config)
    x_left = margins["left"] + radius_pt
    x_right = width_pt - margins["right"] - radius_pt
    y_top = height_pt - margins["top"] - radius_pt
    y_bottom = margins["bottom"] + radius_pt
    by_corner = {
        "TL": (x_left, y_top),
        "TR": (x_right, y_top),
        "BL": (x_left, y_bottom),
        "BR": (x_right, y_bottom),
    }
    return [(by_corner[name][0], by_corner[name][1], name) for name in _PONT_CORNERS]


def _circle_stream(cx: float, cy: float, radius: float) -> list[str]:
    """Đường tròn bằng bốn cung Bézier. ``k`` là hằng xấp xỉ cung 90°."""

    k = radius * 0.5522847498307936
    return [
        f"{_format_number(cx + radius)} {_format_number(cy)} m",
        f"{_format_number(cx + radius)} {_format_number(cy + k)} "
        f"{_format_number(cx + k)} {_format_number(cy + radius)} "
        f"{_format_number(cx)} {_format_number(cy + radius)} c",
        f"{_format_number(cx - k)} {_format_number(cy + radius)} "
        f"{_format_number(cx - radius)} {_format_number(cy + k)} "
        f"{_format_number(cx - radius)} {_format_number(cy)} c",
        f"{_format_number(cx - radius)} {_format_number(cy - k)} "
        f"{_format_number(cx - k)} {_format_number(cy - radius)} "
        f"{_format_number(cx)} {_format_number(cy - radius)} c",
        f"{_format_number(cx + k)} {_format_number(cy - radius)} "
        f"{_format_number(cx + radius)} {_format_number(cy - k)} "
        f"{_format_number(cx + radius)} {_format_number(cy)} c",
        "h",
    ]


def _duplex_registration_stream(*, width_pt: float, height_pt: float) -> str:
    """Bốn dấu canh chồng mặt server-owned, trong hệ PDF bottom-up."""

    margin = DUPLEX_REGISTRATION_MARGIN_MM * PT_PER_MM
    radius = DUPLEX_REGISTRATION_CIRCLE_DIAMETER_MM * PT_PER_MM / 2.0
    half_line = DUPLEX_REGISTRATION_LINE_LENGTH_MM * PT_PER_MM / 2.0
    stroke_width = DUPLEX_REGISTRATION_STROKE_WIDTH_MM * PT_PER_MM
    centers = (
        (width_pt / 2.0, margin),
        (width_pt / 2.0, height_pt - margin),
        (margin, height_pt / 2.0),
        (width_pt - margin, height_pt / 2.0),
    )
    registration = " ".join(
        _format_number(value) for value in _PONT_REGISTRATION_CMYK
    )
    operations = [
        "q",
        "% PRYNX_DUPLEX_REGISTRATION",
        f"{registration} K",
        f"{_format_number(stroke_width)} w",
        "0 J",
        "0 j",
    ]
    for cx, cy in centers:
        operations.extend(_circle_stream(cx, cy, radius))
        operations.append("S")
        operations.append(
            f"{_format_number(cx - half_line)} {_format_number(cy)} m"
        )
        operations.append(
            f"{_format_number(cx + half_line)} {_format_number(cy)} l"
        )
        operations.append("S")
        operations.append(
            f"{_format_number(cx)} {_format_number(cy - half_line)} m"
        )
        operations.append(
            f"{_format_number(cx)} {_format_number(cy + half_line)} l"
        )
        operations.append("S")
    operations.append("Q")
    return "\n".join(operations) + "\n"


def _stamp_duplex_registration(
    target: Path,
    *,
    rendered_pages: Sequence[RenderedProductionSheet],
    width_pt: float,
    height_pt: float,
) -> None:
    """Append dấu canh sau report lên Front/Back; lỗi thì bỏ artifact."""

    stream = _duplex_registration_stream(width_pt=width_pt, height_pt=height_pt)
    pdf: pikepdf.Pdf | None = None
    # PERF (audit 2026-09-02 §PERF-NEST-06): phase duplex gom cả reopen và save
    # cuối; chỉ có một mẫu telemetry cho mỗi lượt writer.
    perf_sample = start_perf_stage()
    try:
        pdf = pikepdf.open(str(target), allow_overwriting_input=True)
        for rendered in rendered_pages:
            if rendered.side not in ARTWORK_SIDES:
                continue
            if not 0 <= rendered.page_index < len(pdf.pages):
                raise ManifestRenderContractError(
                    "Metadata trang dấu canh vượt ngoài artifact."
                )
            pdf.pages[rendered.page_index].contents_add(
                pikepdf.Stream(pdf, stream.encode("ascii"))
            )
        pdf.save(str(target))
        increment_perf_counter("writer_duplex_successes")
        increment_perf_counter("writer_save_successes")
    except Exception as exc:
        target.unlink(missing_ok=True)
        if isinstance(exc, ManifestRenderContractError):
            raise
        raise ManifestRenderContractError(
            "Không ghi được dấu canh CNC hai mặt; đã bỏ artifact không đầy đủ."
        ) from exc
    finally:
        if pdf is not None:
            pdf.close()
        finish_perf_stage(
            perf_sample,
            "writer_duplex_s",
            count_name="writer_duplex_attempts",
        )


#: Ba điểm của góc L, theo hệ **bottom-up**, cho từng vị trí và từng kiểu.
#:
#: Lane cũ khai các điểm này trong hệ top-down. Bảng dưới đã đảo dấu y đúng một lần, nên
#: hình vẽ ra trùng lane cũ. Giữ dạng bảng thay vì mấy nhánh ``if`` để đối chiếu được từng
#: dòng với `nup_marks._draw_ponts_on_page`.
_L_CORNER_POINTS: dict[str, dict[str, tuple[tuple[int, int], ...]]] = {
    # `l_inverted`: cạnh L nằm về phía NGOÀI tờ.
    "l_inverted": {
        "TL": ((+1, +1), (+1, -1), (-1, -1)),
        "TR": ((-1, +1), (-1, -1), (+1, -1)),
        "BL": ((+1, -1), (+1, +1), (-1, +1)),
        "BR": ((-1, -1), (-1, +1), (+1, +1)),
    },
    # `l_corner`: cạnh L nằm về phía TRONG tờ.
    "l_corner": {
        "TL": ((-1, -1), (-1, +1), (+1, +1)),
        "TR": ((+1, -1), (+1, +1), (-1, +1)),
        "BL": ((-1, +1), (-1, -1), (+1, -1)),
        "BR": ((+1, +1), (+1, -1), (-1, -1)),
    },
}


def _pont_stream(
    pont: Mapping[str, Any], *, width_pt: float, height_pt: float
) -> str:
    """Toán tử vẽ bốn ốc góc + guide. Trả chuỗi rỗng khi không có ốc.

    FIX (audit 2026-08-28 §NEST-WRITER-PONT): trước bản vá writer **không đọc**
    ``renderBundle.marks`` chút nào, nên ốc bế được map đúng, validate đúng, vào hash đúng
    rồi không bao giờ tới tờ in. Tờ bình không có ốc là tờ thợ không canh được — đây là lỗ
    đã giao ra người dùng.
    """

    pont_type = pont.get("type")
    if pont_type == "none":
        return ""
    if pont_type not in ("corner", "5mm", "custom"):
        raise ManifestRenderContractError("marks.pont.type không được writer hỗ trợ.")
    config = pont.get("config")
    if config is None:
        raise ManifestRenderContractError(
            "marks.pont.type khác 'none' nhưng thiếu config."
        )
    config = _mapping(config, "marks.pont.config")

    shape = config.get("shape")
    size_pt = _positive_mm(config.get("sizeMm"), "marks.pont.config.sizeMm") * PT_PER_MM
    thickness_pt = (
        _positive_mm(config.get("thicknessMm"), "marks.pont.config.thicknessMm")
        * PT_PER_MM
    )
    radius_pt = size_pt / 2.0

    fill = " ".join(_format_number(value) for value in _PONT_REGISTRATION_CMYK)
    operations = ["q"]

    centers = _pont_corner_centers_pt(
        config, width_pt=width_pt, height_pt=height_pt, radius_pt=radius_pt
    )
    if shape == "circle":
        # Ốc tròn là hình ĐẶC: lane cũ `finish(color, fill=color, width=0)`.
        operations.append(f"{fill} k")
        for cx, cy, _name in centers:
            operations.extend(_circle_stream(cx, cy, radius_pt))
            operations.append("f")
    elif shape in _L_CORNER_POINTS:
        # Góc L là MỘT polyline liền ba điểm, có miter join thật ở đỉnh — không phải hai
        # đoạn rời chạm nhau. `0 j` = miter, đúng `line_join=0` của lane cũ.
        operations.append(f"{fill} K")
        operations.append(f"{_format_number(thickness_pt)} w")
        operations.append("0 j")
        table = _L_CORNER_POINTS[shape]
        for cx, cy, name in centers:
            for index, (sign_x, sign_y) in enumerate(table[name]):
                x_pt = cx + sign_x * radius_pt
                y_pt = cy + sign_y * radius_pt
                verb = "m" if index == 0 else "l"
                operations.append(
                    f"{_format_number(x_pt)} {_format_number(y_pt)} {verb}"
                )
            operations.append("S")
    else:
        raise ManifestRenderContractError(
            "marks.pont.config.shape không được writer hỗ trợ."
        )

    operations.append(_pont_guides_stream(config, width_pt=width_pt, height_pt=height_pt))
    operations.append("Q")
    return "\n".join(part for part in operations if part) + "\n"


def _pont_guides_stream(
    config: Mapping[str, Any], *, width_pt: float, height_pt: float
) -> str:
    """Vạch guide giấy. Hệ bottom-up, khớp `nup_marks.draw_guide` sau khi đảo y."""

    raw_guides = config.get("guides")
    if raw_guides is None:
        return ""
    if isinstance(raw_guides, (str, bytes)) or not isinstance(raw_guides, Sequence):
        raise ManifestRenderContractError("marks.pont.config.guides phải là mảng.")
    if not raw_guides:
        return ""

    stroke = " ".join(_format_number(value) for value in _PONT_REGISTRATION_CMYK)
    operations = [f"{stroke} K"]
    for index, raw in enumerate(raw_guides):
        guide = _mapping(raw, f"marks.pont.config.guides[{index}]")
        field = f"marks.pont.config.guides[{index}]"
        position = guide.get("position")
        if position not in _PONT_CORNERS:
            raise ManifestRenderContractError(f"{field}.position không hợp lệ.")
        length_pt = _positive_mm(guide.get("lengthMm"), f"{field}.lengthMm") * PT_PER_MM
        thickness_pt = (
            _positive_mm(guide.get("thicknessMm"), f"{field}.thicknessMm") * PT_PER_MM
        )
        offset_x_pt = _finite_mm(guide.get("offsetXmm"), f"{field}.offsetXmm") * PT_PER_MM
        offset_y_pt = _finite_mm(guide.get("offsetYmm"), f"{field}.offsetYmm") * PT_PER_MM

        # Lane cũ đo `offY` từ MÉP TRÊN cho TL/TR và từ mép dưới cho BL/BR (hệ top-down).
        # Đảo sang bottom-up: TL/TR nằm gần mép trên, BL/BR gần mép dưới.
        if position in ("TL", "TR"):
            y_pt = height_pt - offset_y_pt
        else:
            y_pt = offset_y_pt
        if position in ("TL", "BL"):
            x_start = offset_x_pt
        else:
            x_start = width_pt - offset_x_pt - length_pt

        operations.append(f"{_format_number(thickness_pt)} w")
        operations.append(f"{_format_number(x_start)} {_format_number(y_pt)} m")
        operations.append(
            f"{_format_number(x_start + length_pt)} {_format_number(y_pt)} l"
        )
        operations.append("S")
    return "\n".join(operations)


def _finite_mm(value: Any, field: str) -> float:
    """Số mm hữu hạn, cho phép âm — độ lệch guide có thể âm."""

    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ManifestRenderContractError(f"{field} phải là số.")
    result = float(value)
    if not math.isfinite(result):
        raise ManifestRenderContractError(f"{field} phải là số hữu hạn.")
    return result


def _pont_sides(bundle: Mapping[str, Any], sides: Sequence[str]) -> frozenset[str]:
    """Side vẽ boong/ốc bế: Front luôn có, CUT theo contract; Back không có.

    FIX/PARITY (audit 2026-08-29 §MAP-NEST-08): boong định vị máy cắt
    khác dấu canh chồng mặt. Lane CNC legacy vẽ boong trên Front + CUT và
    tuyệt đối không vẽ ở Back; dấu canh duplex được xử lý bằng contract riêng.
    """

    marks = _mapping(bundle.get("marks"), "renderBundle.marks")
    cut = _mapping(marks.get("cut"), "renderBundle.marks.cut")
    ponts_on_cut = cut.get("pontsOnCutFile")
    if not isinstance(ponts_on_cut, bool):
        raise ManifestRenderContractError(
            "renderBundle.marks.cut.pontsOnCutFile phải là boolean."
        )
    selected = {"front"} if "front" in sides else set()
    if ponts_on_cut and CUT_SIDE in sides:
        selected.add(CUT_SIDE)
    return frozenset(selected)


def _sheet_frame(bundle: Mapping[str, Any], side: str) -> Sequence[Any]:
    frames = _mapping(bundle.get("sheetFrames"), "renderBundle.sheetFrames")
    frame = frames.get(side)
    if frame is None:
        raise ManifestRenderContractError(
            f"renderBundle.sheetFrames.{side} thiếu, không render được side này."
        )
    return frame


def _build_sheet_placement_index(
    manifest: Mapping[str, Any],
    *,
    sheet_count: int,
    parts: Mapping[str, Mapping[str, Any]],
    render_bundle_hash: str,
) -> dict[int, tuple[Mapping[str, Any], ...]]:
    """PERF (audit 2026-09-07 §TEMPERF.4): một lượt gom P, không quét lại P×S.

    Kiểm mọi occurrence trước khi dedup recipe, kể cả tờ không được render.
    Chỉ sắp bản danh sách riêng; không mutate placement hay thứ tự manifest.
    """

    grouped: dict[int, list[Mapping[str, Any]]] = {}
    for occurrence in manifest["placements"]:
        try:
            identity = parse_manifest_placement_identity(
                occurrence, render_bundle_hash=render_bundle_hash,
            )
        except ManifestArtworkContractError as exc:
            raise ManifestRenderContractError(str(exc)) from exc
        if identity.part_id not in parts:
            raise ManifestRenderContractError(
                f"placement.partId {identity.part_id!r} không thuộc RenderBundle."
            )
        if identity.sheet_index >= sheet_count:
            raise ManifestRenderContractError("placement.sheetIndex vượt số tờ manifest.")
        grouped.setdefault(identity.sheet_index, []).append(occurrence)
    if set(grouped) != set(range(sheet_count)):
        raise ManifestRenderContractError("Index placement thiếu tờ trong manifest.")
    return {
        index: tuple(sorted(items, key=lambda item: item["instanceId"].encode("utf-8")))
        for index, items in grouped.items()
    }


def _placements_for_sheet(
    manifest: Mapping[str, Any], sheet_index: int,
    *, placements_by_sheet: _SheetPlacementIndex | None = None,
) -> list[Mapping[str, Any]]:
    """Placement của một tờ, sắp theo instanceId để thứ tự vẽ xác định."""

    if placements_by_sheet is not None:
        return list(placements_by_sheet.get(sheet_index, ()))
    selected = [
        placement
        for placement in manifest["placements"]
        if placement.get("sheetIndex") == sheet_index
    ]
    selected.sort(key=lambda item: str(item.get("instanceId")).encode("utf-8"))
    return selected


def _sheet_recipe_key(
    placements: Sequence[Mapping[str, Any]],
    *,
    parts: Mapping[str, Mapping[str, Any]],
    render_bundle_hash: str,
) -> _SheetRecipeKey:
    """Identity lossless của layout vật lý, bỏ occurrence ID và sheet index."""

    cells: list[_SheetRecipeCellKey] = []
    for placement in placements:
        try:
            identity = parse_manifest_placement_identity(
                placement,
                render_bundle_hash=render_bundle_hash,
            )
        except ManifestArtworkContractError as exc:
            raise ManifestRenderContractError(str(exc)) from exc
        if identity.part_id not in parts:
            raise ManifestRenderContractError(
                f"Recipe có partId {identity.part_id!r} không thuộc RenderBundle."
            )
        # Manifest giữ pose f64 lossless. `float.hex()` bảo toàn đúng bit số đã
        # parse; serializer request 6 chữ số không được dùng vì sẽ gộp nhầm hai
        # layout khác nhau sau chữ số thập phân thứ sáu.
        cells.append(
            (
                identity.part_id,
                identity.pose.rotation_deg.hex(),
                identity.pose.translate_x_mm.hex(),
                identity.pose.translate_y_mm.hex(),
            )
        )

    cells.sort()
    return render_bundle_hash, tuple(cells)


def _render_sheet_plan(
    manifest: Mapping[str, Any],
    *,
    sheet_count: int,
    parts: Mapping[str, Mapping[str, Any]],
    render_bundle_hash: str,
    export_unique_sheets: bool,
    placements_by_sheet: _SheetPlacementIndex | None = None,
) -> tuple[tuple[int, int], ...]:
    """Trả ``(representative sheet index, physical run count)`` theo thứ tự đầu tiên."""

    plan: list[tuple[int, int]] = []
    recipe_positions: dict[_SheetRecipeKey, int] = {}
    for sheet_index in range(sheet_count):
        placements = _placements_for_sheet(
            manifest, sheet_index, placements_by_sheet=placements_by_sheet,
        )
        if not placements:
            raise ManifestRenderContractError(
                f"Tờ {sheet_index} không có placement nào."
            )
        if not export_unique_sheets:
            plan.append((sheet_index, 1))
            continue

        # FIX/PARITY (audit 2026-08-29 §MAP-NEST-09): recipe là multiset
        # part+pose exact trong namespace RenderBundle; instance/sheet occurrence
        # không được làm hai template logic giống nhau thành khác nhau.
        key = _sheet_recipe_key(
            placements,
            parts=parts,
            render_bundle_hash=render_bundle_hash,
        )
        previous_position = recipe_positions.get(key)
        if previous_position is None:
            recipe_positions[key] = len(plan)
            plan.append((sheet_index, 1))
        else:
            representative, run_count = plan[previous_position]
            plan[previous_position] = (representative, run_count + 1)
    return tuple(plan)


def render_production_nesting(
    *,
    production_request: Mapping[str, Any],
    manifest: Mapping[str, Any],
    source_paths: Mapping[str, str | Path],
    output_path: str | Path,
    report_override: ImpositionReportSpec | None = None,
) -> ProductionRenderResult:
    """Ghi artifact production từ manifest bất biến. Không solve, không sửa manifest.

    ``source_paths`` map ``locatorId`` → đường dẫn snapshot đã pin. Writer không tự
    tìm file: thiếu locator là lỗi, không phải lý do để đoán.
    """

    payload = _mapping(production_request, "productionRequest")
    bundle = _mapping(payload.get("renderBundle"), "productionRequest.renderBundle")
    engine_request = _mapping(
        payload.get("engineRequest"), "productionRequest.engineRequest"
    )
    render_bundle_hash = payload.get("renderBundleHash")
    if not isinstance(render_bundle_hash, str) or not render_bundle_hash:
        raise ManifestRenderContractError("renderBundleHash không hợp lệ.")

    manifest_value = _mapping(manifest, "manifest")
    _assert_renderable(manifest_value, render_bundle_hash=render_bundle_hash)
    sheet_count = _sheet_count(manifest_value)
    sides = _output_sides(bundle)
    parts = _parts_by_id(bundle)
    placements_by_sheet = _build_sheet_placement_index(
        manifest_value,
        sheet_count=sheet_count,
        parts=parts,
        render_bundle_hash=render_bundle_hash,
    )
    cut_style = _mapping(bundle.get("cutStyle"), "renderBundle.cutStyle")
    artifact_options = _mapping(
        bundle.get("artifactOptions"), "renderBundle.artifactOptions"
    )
    if report_override is None:
        effective_report = _mapping(
            artifact_options.get("report"), "renderBundle.artifactOptions.report"
        )
    else:
        # Override chỉ nhận dataclass frozen do backend dựng lại từ settings hiện
        # hành. Mapping/raw payload không được đi tắt qua validator canonical.
        effective_report = canonicalize_imposition_report(
            report_override,
            layout_intent=str(engine_request.get("layoutIntent") or ""),
        )
    export_unique_sheets = artifact_options.get("exportUniqueSheets")
    if not isinstance(export_unique_sheets, bool):
        raise ManifestRenderContractError(
            "renderBundle.artifactOptions.exportUniqueSheets phải là boolean."
        )
    sheet_plan = _render_sheet_plan(
        manifest_value,
        sheet_count=sheet_count,
        parts=parts,
        render_bundle_hash=render_bundle_hash,
        export_unique_sheets=export_unique_sheets,
        placements_by_sheet=placements_by_sheet,
    )
    recipe_run_counts = (
        {sheet_index: run_count for sheet_index, run_count in sheet_plan}
        if export_unique_sheets
        else None
    )
    # FIX (audit 2026-08-28 §NEST-WRITER-PONT): writer phải đọc `marks`. Trước bản vá nó chỉ
    # đọc outputSides/parts/sheetFrames/cutStyle, nên ốc bế và dấu xén tới được bundle rồi
    # dừng ở đó.
    marks = _mapping(bundle.get("marks"), "renderBundle.marks")
    pont_sides = _pont_sides(bundle, sides)
    duplex_registration = marks.get("duplexRegistration")
    if not isinstance(duplex_registration, bool):
        raise ManifestRenderContractError(
            "renderBundle.marks.duplexRegistration phải là boolean."
        )
    if duplex_registration and not {"front", "back"}.issubset(sides):
        raise ManifestRenderContractError(
            "Dấu canh CNC hai mặt yêu cầu đủ Front và Back."
        )

    sheet = _mapping(engine_request.get("sheet"), "engineRequest.sheet")
    width_pt = _positive_mm(sheet.get("widthMm"), "sheet.widthMm") * PT_PER_MM
    height_pt = _positive_mm(sheet.get("heightMm"), "sheet.heightMm") * PT_PER_MM

    if not isinstance(source_paths, Mapping):
        raise ManifestRenderContractError("source_paths phải là mapping.")
    missing = {
        str(part["source"]["locatorId"])
        for part in parts.values()
        if str(part["source"]["locatorId"]) not in source_paths
    }
    if missing:
        raise ManifestRenderContractError(
            "Thiếu snapshot nguồn cho locator: " + ", ".join(sorted(missing)) + "."
        )

    target = Path(output_path)
    rendered: list[RenderedProductionSheet] = []
    # PERF (audit 2026-09-07 §TEMPERF.3): context bất biến chỉ sống trong job.
    # Chuẩn hóa lazily theo khuôn/mặt để không siết side/part không được render.
    part_contexts: dict[tuple[str, str], ManifestPartContext] = {}

    def _part_context(part: Mapping[str, Any], side: str) -> ManifestPartContext:
        key = (part["partId"], side)
        if key not in part_contexts:
            part_contexts[key] = prepare_manifest_part_context(
                part=part, side=side, render_bundle_hash=render_bundle_hash,
            )
        return part_contexts[key]

    output = pikepdf.Pdf.new()
    # PERF (audit 2026-09-02 §PERF-NEST-06): phase cha này là tổng inclusive của
    # toàn bộ dựng trang; embed/form-paint là phase con, không được cộng thêm vào tổng.
    base_sample = start_perf_stage()
    try:
        for sheet_index, _recipe_run_count in sheet_plan:
            sheet_placements = _placements_for_sheet(
                manifest_value, sheet_index, placements_by_sheet=placements_by_sheet,
            )
            for side in sides:
                page = output.add_blank_page(page_size=(width_pt, height_pt))
                frame = _sheet_frame(bundle, side)
                instance_ids: list[str] = []
                if side == CUT_SIDE:
                    prologue = _cut_stroke_prologue(cut_style, page=page)
                    stream_parts = ["q\n", prologue]
                    for placement in sheet_placements:
                        part = parts.get(str(placement.get("partId")))
                        if part is None:
                            raise ManifestRenderContractError(
                                "placement.partId không có trong renderBundle.parts."
                            )
                        # Dùng chính seam của artwork để KHÔNG có đường thứ hai
                        # đọc pose: mọi kiểm identity (sourceRevision, page
                        # binding, partId) áp cho CUT y như artwork.
                        context = _part_context(part, CUT_SIDE)
                        resolved = resolve_manifest_artwork_placement(
                            placement=placement,
                            part=context,
                            sheet_frame=frame,
                            side=CUT_SIDE,
                            render_bundle_hash=render_bundle_hash,
                        )
                        rings = transform_manifest_polygon_rings(
                            context.cut_contour,
                            sheet_frame=resolved.sheet_frame,
                            pose=resolved.pose,
                            reference_point_mm=resolved.reference_point_mm,
                            field="cutContour",
                        )
                        stream_parts.append(
                            _cut_rings_stream(rings, origin=(0.0, 0.0))
                        )
                        instance_ids.append(resolved.instance_id)
                    stream_parts.append("Q\n")
                    if side in pont_sides:
                        stream_parts.append(
                            _pont_stream(
                                _mapping(marks.get("pont"), "renderBundle.marks.pont"),
                                width_pt=width_pt,
                                height_pt=height_pt,
                            )
                        )
                    page.contents_add(
                        pikepdf.Stream(
                            output, "".join(stream_parts).encode("ascii")
                        )
                    )
                else:
                    for placement in sheet_placements:
                        part = parts.get(str(placement.get("partId")))
                        if part is None:
                            raise ManifestRenderContractError(
                                "placement.partId không có trong renderBundle.parts."
                            )
                        resolved = resolve_manifest_artwork_placement(
                            placement=placement,
                            part=_part_context(part, side),
                            sheet_frame=frame,
                            side=side,
                            render_bundle_hash=render_bundle_hash,
                        )
                        # FIX (audit 2026-08-28 §NEST-STRIP-DIE): trang in phải
                        # KHÔNG có nét bế. Nguồn tem bế mang nét CutContour trong
                        # chính artwork; paint nguyên trang nguồn nghĩa là in cả
                        # đường bế lên trang in — đúng lỗi người dùng báo. Biến thể
                        # này materialize thật: bỏ nét bế trong content stream của
                        # Form đã nhúng, theo cùng tiêu chí `cutStyle.sourceFilter`
                        # mà lane cũ dùng.
                        render_manifest_artwork(
                            output,
                            page,
                            str(source_paths[resolved.locator_id]),
                            resolved,
                            form_variant=DIE_STRIPPED_FORM_VARIANT,
                            die_filter=cut_style.get("sourceFilter"),
                        )
                        instance_ids.append(resolved.instance_id)
                    if side in pont_sides:
                        # Vẽ ốc SAU artwork để không bị hình đè lên. Ốc là dấu canh của
                        # thợ, phải nhìn thấy được.
                        pont_stream = _pont_stream(
                            _mapping(marks.get("pont"), "renderBundle.marks.pont"),
                            width_pt=width_pt,
                            height_pt=height_pt,
                        )
                        if pont_stream:
                            page.contents_add(
                                pikepdf.Stream(output, pont_stream.encode("ascii"))
                            )
                rendered.append(
                    RenderedProductionSheet(
                        page_index=len(rendered),
                        sheet_index=sheet_index,
                        side=side,
                        instance_ids=tuple(instance_ids),
                    )
                )
        finish_perf_stage(
            base_sample,
            "writer_page_build_total_s",
            count_name="writer_render_successes",
        )
        # Khi PRYNX_PERF tắt, tránh cả lượt quét O(số trang) chỉ để tính counter.
        if base_sample is not None:
            increment_perf_counter("writer_page_count", len(rendered))
            increment_perf_counter(
                "writer_cut_page_count",
                sum(1 for page in rendered if page.side == CUT_SIDE),
            )
        target.parent.mkdir(parents=True, exist_ok=True)
        save_sample = start_perf_stage()
        try:
            output.save(str(target))
            increment_perf_counter("writer_base_save_successes")
            increment_perf_counter("writer_save_successes")
        finally:
            finish_perf_stage(
                save_sample,
                "writer_base_save_s",
                count_name="writer_base_save_attempts",
            )
    except ManifestArtworkContractError as exc:
        raise ManifestRenderContractError(str(exc)) from exc
    finally:
        output.close()

    # FIX (audit 2026-08-28 §NEST-WRITER-REPORT): report vẽ SAU khi lưu, vì nó là overlay
    # trang dựng bằng reportlab rồi ghép qua `add_overlay` — cùng đường mà lane lưới dùng,
    # nên hai lane ra cùng font và cùng cách canh.
    report = effective_report
    # MAP-NEST-06: tool là job-level trong renderBundle.flow; đọc lenient vì đây chỉ là
    # metadata report — thiếu tool chỉ để trống modeLabel, không được làm hỏng artifact.
    _report_flow = bundle.get("flow")
    _report_mode_tool = (
        str(_report_flow.get("tool") or "")
        if isinstance(_report_flow, Mapping)
        else ""
    )
    if report.get("enabled") is True:
        _stamp_report(
            target,
            report=report,
            # `rendered` giữ mapping page → physical sheet → side; truyền nguyên
            # snapshot để Front/Back cùng tờ dùng cùng text và CUT luôn bị loại.
            rendered_pages=rendered,
            manifest=manifest_value,
            engine_request=engine_request,
            parts=parts,
            sheet_count=sheet_count,
            recipe_run_counts=recipe_run_counts,
            tool=_report_mode_tool,
            placements_by_sheet=placements_by_sheet,
        )

    # FIX/PARITY (audit 2026-08-29 §MAP-NEST-08): dấu canh là dấu sản xuất
    # bắt buộc nhìn thấy, nên append SAU report để text overlay không che mất dấu.
    if duplex_registration:
        _stamp_duplex_registration(
            target,
            rendered_pages=rendered,
            width_pt=width_pt,
            height_pt=height_pt,
        )

    # Provenance hai tầng: layoutFingerprint/renderBundleHash vẫn xác thực đúng
    # placements + bundle preview bất biến; fingerprint artifact ghi nhận report
    # overlay thực sự đã dùng, không giả vờ hash bundle cũ đại diện byte PDF mới.
    from app.core.nesting_production_adapter import canonical_sha256

    report_hash = canonical_sha256(report)
    artifact_render_fingerprint = canonical_sha256(
        {
            "schemaVersion": 1,
            "writerVersion": PRODUCTION_WRITER_VERSION,
            "manifestId": str(manifest_value.get("manifestId")),
            "layoutFingerprint": str(manifest_value.get("layoutFingerprint")),
            "renderBundleHash": render_bundle_hash,
            "reportHash": report_hash,
        }
    )
    return ProductionRenderResult(
        output_path=target,
        writer_version=PRODUCTION_WRITER_VERSION,
        manifest_id=str(manifest_value.get("manifestId")),
        layout_fingerprint=str(manifest_value.get("layoutFingerprint")),
        render_bundle_hash=render_bundle_hash,
        report_hash=report_hash,
        artifact_render_fingerprint=artifact_render_fingerprint,
        sheet_count=sheet_count,
        sides=sides,
        pages=tuple(rendered),
    )
