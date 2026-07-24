"""
Stream_Editor — engine GHI color-safe của tính năng `pdf-object-edit`.

Ràng buộc kiến trúc (chốt qua spike chạy thật):
- **CHỈ dùng pikepdf** để ghi: `parse_content_stream` → sửa danh sách instruction →
  `unparse_content_stream` → `page.Contents = pdf.make_stream(...)`.
- **TUYỆT ĐỐI KHÔNG** dùng PDFium `FPDFPage_GenerateContent` (hủy CMYK/spot → RGB).
- Bảo toàn màu in: chỉ thêm/bớt op QUANH hoặc TRONG `OpSpan` của object mục tiêu;
  các `Color_Operators` của `Untouched_Object` không bị chạm vì pikepdf unparse giữ
  nguyên các instruction còn lại.

Task 4.1 — `delete` qua content-stream surgery:
- text  : bỏ trọn cụm `BT…ET` (span text) — gồm các op show text `Tj/TJ/'/"`.
- image : bỏ `Do` của ảnh mục tiêu (hoặc inline image); dọn XObject khỏi
          `/Resources/XObject` CHỈ KHI không còn `Do` nào khác tham chiếu tên đó.
- vector: bỏ nhóm path-construction + painting op nằm trong span.
- KHÔNG đụng op nào ngoài `OpSpan`.

An toàn màu (Yêu cầu 4.7): nếu `Object_Mapper.map_object` trả `None` cho BẤT KỲ
target nào → HỦY toàn bộ thao tác, raise `ObjectMapError` và KHÔNG ghi gì.

Tập rỗng (không có target) → no-op, trả `DeleteResult(changed=False)`.

Quy ước index span: nửa-mở `[start, end)` (khớp `object_mapper.segment_ops` và
`app/schemas/edit.py`).

_Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.7_
"""
from __future__ import annotations

import logging
import math
import os
import struct
from dataclasses import dataclass, field

import pikepdf

from app.core.edit_debug_log import edit_text_move_log_enabled, log_text_move
from app.core.object_mapper import (
    _as_float,
    _name_str,
    build_op_spans,
    contents_coalesce,
    inverse_matrix,
    map_object,
    map_object_spans,
    map_text_show_op,
    mult_matrix,
    parse_page_ops,
    text_show_op_for_move,
)
from app.core.text_shaping import needs_shaping, shape_text
from app.schemas.edit import OpSpan, normalize_bbox

logger = logging.getLogger(__name__)


def _instr_op_name(instr) -> str:
    try:
        return str(instr.operator)
    except Exception:
        return "?"


def _show_operand_preview(instr, limit: int = 80) -> str:
    """Xem nhanh nội dung Tj/TJ/'/\" (CID/hex → độ dài + hex head)."""
    try:
        op = _instr_op_name(instr)
        operands = list(instr.operands)
        if not operands:
            return f"{op}()"

        def _one(raw) -> str:
            try:
                b = bytes(raw)
            except Exception:
                s = str(raw)
                return s if len(s) <= limit else s[:limit] + "…"
            # Thử utf-8; nếu toàn control/không đọc được → hex
            try:
                t = b.decode("utf-8")
                if t.isprintable() or any(c.isalpha() for c in t):
                    t = t.replace("\n", "\\n")
                    return t if len(t) <= limit else t[:limit] + "…"
            except Exception:
                pass
            hx = b.hex()
            return f"<{len(b)}B:{hx[: min(24, len(hx))]}{'…' if len(hx) > 24 else ''}>"

        if op == "TJ":
            arr = operands[0] if operands else []
            if isinstance(arr, (list, tuple, pikepdf.Array)):
                parts = []
                total_b = 0
                for item in arr:
                    if isinstance(item, (int, float)):
                        parts.append(f"[{item}]")
                        continue
                    try:
                        total_b += len(bytes(item))
                    except Exception:
                        pass
                    parts.append(_one(item))
                text = "".join(parts)
                if len(text) > limit:
                    text = text[:limit] + "…"
                return f"TJ(parts={len(list(arr))},bytes≈{total_b},{text!r})"
            return f"TJ({_one(arr)!r})"
        raw = operands[-1] if op == '"' and len(operands) >= 3 else operands[0]
        return f"{op}({_one(raw)!r})"
    except Exception as exc:
        return f"<preview-error {type(exc).__name__}>"


def _ops_window(instructions: list, center: int, radius: int = 8) -> list[dict]:
    """Cửa sổ op quanh index để debug multi-run."""
    lo = max(0, center - radius)
    hi = min(len(instructions), center + radius + 1)
    out = []
    for i in range(lo, hi):
        instr = instructions[i]
        op = _instr_op_name(instr)
        entry: dict = {"i": i, "op": op, "mark": i == center}
        if op in {"Tj", "TJ", "'", '"'}:
            entry["text"] = _show_operand_preview(instr)
        elif op == "Tm" and instr.operands:
            try:
                entry["tm"] = [float(v) for v in instr.operands]
            except Exception:
                entry["tm"] = str(list(instr.operands))[:80]
        out.append(entry)
    return out


def _stream_text_shows(instructions: list) -> list[dict]:
    """Mọi show-op text trong stream (index + preview)."""
    rows = []
    for i, instr in enumerate(instructions):
        op = _instr_op_name(instr)
        if op in {"Tj", "TJ", "'", '"'}:
            rows.append({"i": i, "preview": _show_operand_preview(instr)})
    return rows


class ObjectMapError(ValueError):
    """
    Raise khi `Object_Mapper.map_object` không map được DUY NHẤT một target
    (Yêu cầu 4.7). Caller phải HỦY thao tác, KHÔNG ghi kết quả sai.
    """


class GlyphCoverageError(ValueError):
    """
    Raise khi nội dung text mới chứa ký tự mà font gốc của cụm KHÔNG hỗ trợ VÀ
    font dự phòng (DejaVuSans) cũng thiếu glyph (Yêu cầu 8.4). Caller phải HỦY
    thao tác và KHÔNG ghi kết quả — tránh ghi `.notdef`/ô vuông.
    """


# Đường dẫn font dự phòng đủ glyph tiếng Việt (DejaVuSans) trong assets.
DEFAULT_FALLBACK_FONT_PATH = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "assets", "fonts", "DejaVuSans.ttf")
)


@dataclass
class MoveResult:
    """
    Kết quả của một thao tác di chuyển (move / tịnh tiến).

    - `changed`        : có thay đổi Working_File hay không (False = no-op).
    - `moved_spans`    : danh sách `OpSpan` đã được bọc cô lập `q/cm/Q`.
    - `dx`, `dy`       : độ dịch (đã chuẩn hóa về hệ PDF bottom-left) thực sự áp.
    - `wrapped_count`  : số object đã được bọc dịch chuyển.
    - `message`        : mô tả ngắn trạng thái (phục vụ API/log).
    """

    changed: bool
    moved_spans: list[OpSpan] = field(default_factory=list)
    dx: float = 0.0
    dy: float = 0.0
    wrapped_count: int = 0
    message: str = ""


@dataclass
class AffineResult:
    """Kết quả biến đổi affine chung cho một hoặc nhiều object."""

    changed: bool
    transformed_spans: list[OpSpan] = field(default_factory=list)
    matrix: list[float] = field(default_factory=lambda: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0])
    wrapped_count: int = 0
    message: str = ""

@dataclass
class ResizeResult:
    """
    Kết quả của một thao tác thay đổi kích thước (resize / scale).

    - `changed`        : có thay đổi Working_File hay không (False = no-op).
    - `resized_spans`  : danh sách `OpSpan` đã được bọc cô lập `q/cm/Q`.
    - `sx`, `sy`       : hệ số tỉ lệ thực sự áp.
    - `anchor`         : góc cố định ('nw'|'ne'|'sw'|'se') — điểm KHÔNG dịch.
    - `wrapped_count`  : số object đã được bọc scale.
    - `message`        : mô tả ngắn trạng thái (phục vụ API/log).
    """

    changed: bool
    resized_spans: list[OpSpan] = field(default_factory=list)
    sx: float = 1.0
    sy: float = 1.0
    anchor: str = "sw"
    wrapped_count: int = 0
    message: str = ""


@dataclass
class RotateResult:
    """
    Kết quả của một thao tác xoay (rotate) quanh TÂM bbox của từng object.

    - `changed`        : có thay đổi Working_File hay không (False = no-op).
    - `rotated_spans`  : danh sách `OpSpan` đã được bọc cô lập `q/cm/Q`.
    - `rotate_deg`     : góc xoay thực sự áp (độ; dương = ngược chiều kim đồng hồ
                         trong hệ tọa độ PDF gốc dưới-trái).
    - `wrapped_count`  : số object đã được bọc xoay.
    - `message`        : mô tả ngắn trạng thái (phục vụ API/log).
    """

    changed: bool
    rotated_spans: list[OpSpan] = field(default_factory=list)
    rotate_deg: float = 0.0
    wrapped_count: int = 0
    message: str = ""


@dataclass
class EditTextResult:
    """
    Kết quả của một thao tác sửa nội dung text (`edit_text`).

    - `changed`          : có thay đổi Working_File hay không (False = no-op).
    - `span`             : `OpSpan` của cụm text đã sửa (None nếu no-op).
    - `new_text`         : nội dung text mới đã ghi.
    - `used_fallback`    : True nếu phải nhúng/đổi sang font dự phòng (DejaVuSans).
    - `font_resource`    : tên resource font dùng để show text mới.
    - `font_size`        : cỡ chữ (giữ nguyên từ cụm cũ) áp cho text mới.
    - `removed_show_ops` : số op show-text cũ (`Tj/TJ/'/"`) bị loại khỏi cụm.
    - `message`          : mô tả ngắn trạng thái (phục vụ API/log).
    """

    changed: bool
    span: OpSpan | None = None
    new_text: str = ""
    used_fallback: bool = False
    font_resource: str = ""
    font_size: float = 0.0
    removed_show_ops: int = 0
    message: str = ""


@dataclass
class AddResult:
    """
    Kết quả của một thao tác THÊM object mới (text / image) — task 7.2.

    - `changed`        : có thay đổi Working_File hay không (False = no-op).
    - `kind`           : 'text' | 'image' — loại object vừa thêm.
    - `bbox`           : BBox (hệ PDF bottom-left) nơi object được đặt
                         [x0, y0, x1, y1].
    - `resource_name`  : tên resource đăng ký (font cho text, XObject cho image).
    - `used_fallback`  : True nếu text phải nhúng font dự phòng DejaVuSans
                         (ký tự ngoài ASCII).
    - `font_size`      : cỡ chữ áp cho text (0.0 với image).
    - `image_size_px`  : (width, height) pixel của ảnh (None với text).
    - `message`        : mô tả ngắn trạng thái (phục vụ API/log).
    """

    changed: bool
    kind: str = ""
    bbox: list[float] = field(default_factory=list)
    resource_name: str = ""
    used_fallback: bool = False
    font_size: float = 0.0
    image_size_px: tuple[int, int] | None = None
    message: str = ""


@dataclass
class ReplaceImageResult:
    """Result of replacing one image XObject while preserving its drawing transform."""

    changed: bool
    bbox: list[float] = field(default_factory=list)
    old_resource_name: str = ""
    new_resource_name: str = ""
    image_size_px: tuple[int, int] | None = None
    message: str = ""


@dataclass
class ClipImageResult:
    """Result of applying or removing an editable vector frame around one image."""

    changed: bool
    bbox: list[float] = field(default_factory=list)
    shape: str = "none"
    radius: float = 0.0
    message: str = ""

@dataclass
class DeleteResult:
    """
    Kết quả của một thao tác xóa.

    - `changed`           : có thay đổi Working_File hay không (False = no-op).
    - `removed_op_count`  : tổng số instruction bị loại khỏi content stream.
    - `removed_spans`     : danh sách `OpSpan` đã xóa (theo thứ tự target).
    - `cleaned_resources` : tên XObject đã gỡ khỏi `/Resources/XObject`.
    - `message`           : mô tả ngắn trạng thái (phục vụ API/log).
    """

    changed: bool
    removed_op_count: int = 0
    removed_spans: list[OpSpan] = field(default_factory=list)
    cleaned_resources: list[str] = field(default_factory=list)
    message: str = ""


def _as_page(page) -> pikepdf.Page:
    """Chuẩn hóa tham số `page` về `pikepdf.Page`."""
    return page if isinstance(page, pikepdf.Page) else pikepdf.Page(page)


def _xobject_dict(pg: pikepdf.Page):
    """Trả về dict `/Resources/XObject` của trang (hoặc None nếu không có)."""
    try:
        resources = pg.obj.get("/Resources")
        if resources is None:
            return None
        return resources.get("/XObject")
    except Exception:  # noqa: BLE001 - resource lạ → coi như không có
        return None


def _still_referenced(instructions: list, name: str) -> bool:
    """
    Kiểm xem tên XObject `name` còn được `Do` nào tham chiếu trong danh sách
    instruction (đã sau khi xóa) hay không.
    """
    for instr in instructions:
        if str(instr.operator) == "Do" and instr.operands:
            ref = _name_str(instr.operands[0])
            if ref == name:
                return True
    return False


def _meta_value(meta, field: str, default=None):
    return meta.get(field, default) if isinstance(meta, dict) else getattr(meta, field, default)


def _has_overlapping_object_sibling(meta, all_obj_metas) -> bool:
    """True when PDFium exposes fill/stroke as separate objects on the same shape."""
    if not all_obj_metas or _meta_value(meta, "type") not in {"vector", "image"}:
        return False
    bbox = _meta_value(meta, "bbox")
    if not bbox or len(bbox) != 4:
        return False
    a = normalize_bbox(list(bbox))
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    if area_a <= 0:
        return False
    meta_id = _meta_value(meta, "id")
    for other in all_obj_metas:
        if _meta_value(other, "id") == meta_id or _meta_value(other, "type") != _meta_value(meta, "type"):
            continue
        other_bbox = _meta_value(other, "bbox")
        if not other_bbox or len(other_bbox) != 4:
            continue
        b = normalize_bbox(list(other_bbox))
        area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
        inter = max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(
            0.0, min(a[3], b[3]) - max(a[1], b[1])
        )
        if area_b > 0 and inter / min(area_a, area_b) >= 0.9:
            return True
    return False


def delete_objects(
    page,
    obj_metas,
    pdf: pikepdf.Pdf,
    *,
    all_obj_metas=None,
) -> DeleteResult:
    """
    Xóa đúng tập object mục tiêu khỏi content stream của một trang (color-safe).

    Args:
        page:      trang pikepdf (`pikepdf.Page` hoặc object trang).
        obj_metas: danh sách `ObjMeta` (hoặc dict tương đương) cần xóa.
        pdf:       document pikepdf chứa trang (để coalesce + make_stream).

    Returns:
        `DeleteResult` mô tả thay đổi. Tập rỗng → `changed=False` (no-op).

    Raises:
        ObjectMapError: nếu BẤT KỲ target nào không map được duy nhất sang một
                        `OpSpan` (Yêu cầu 4.7) → HỦY toàn bộ, KHÔNG ghi.
    """
    pg = _as_page(page)

    # ── Tập rỗng → no-op (Yêu cầu 3.5) ──────────────────────────────────────
    if not obj_metas:
        return DeleteResult(changed=False, message="Không có object mục tiêu — không thay đổi.")

    # Gộp content stream về MỘT lần duy nhất để mọi index span/parse đồng bộ.
    try:
        contents_coalesce(pdf, pg)
    except Exception as exc:  # noqa: BLE001 - coalesce lỗi vẫn parse trực tiếp được
        logger.warning("contents_coalesce thất bại, tiếp tục parse trực tiếp: %s", exc)

    # ── Map từng target → OpSpan; bất kỳ None nào → HỦY (Yêu cầu 4.7) ───────
    spans: list[OpSpan] = []
    for meta in obj_metas:
        meta_type = meta.get("type") if isinstance(meta, dict) else getattr(meta, "type", None)
        # TEXT: ánh xạ GRANULAR (chỉ 1 show-op) để xóa 1 object KHÔNG xóa cả khối
        # BT…ET ("xóa 1 mất mấy"). image/vector giữ map_object (span chính xác).
        if meta_type == "text":
            span = map_text_show_op(pg, meta, pdf=pdf)
            if span is None:
                meta_id = meta.get("id") if isinstance(meta, dict) else getattr(meta, "id", "?")
                raise ObjectMapError(
                    f"Không thể ánh xạ object '{meta_id}' sang dải operator duy nhất "
                    f"(đa nghĩa/clip/Form XObject/inline image). HỦY thao tác để bảo "
                    f"toàn màu (Yêu cầu 4.7) — KHÔNG ghi kết quả."
                )
            spans.append(span)
        else:
            # Gộp fill+stroke: xóa 1 object (vẽ nhiều lượt cùng path) phải xóa HẾT
            # các span của nó. map_object_spans trả mọi span cùng bbox; rỗng → HỦY.
            obj_spans = map_object_spans(
                pg,
                meta,
                pdf=pdf,
                separate_same_bbox=_has_overlapping_object_sibling(meta, all_obj_metas),
            )
            if not obj_spans:
                meta_id = meta.get("id") if isinstance(meta, dict) else getattr(meta, "id", "?")
                raise ObjectMapError(
                    f"Không thể ánh xạ object '{meta_id}' sang dải operator duy nhất "
                    f"(đa nghĩa/clip/Form XObject/inline image). HỦY thao tác để bảo "
                    f"toàn màu (Yêu cầu 4.7) — KHÔNG ghi kết quả."
                )
            spans.extend(obj_spans)

    # ── Parse lại một lần để khớp index với span đã map ─────────────────────
    instructions = parse_page_ops(pg)
    n = len(instructions)

    # Tập index instruction cần loại bỏ (nửa-mở [start, end)).
    remove_idx: set[int] = set()
    # Tên XObject ứng viên dọn dẹp (chỉ từ span image có resource_name).
    candidate_resources: set[str] = set()

    for span in spans:
        start = max(0, span.start)
        end = min(n, span.end)
        for k in range(start, end):
            remove_idx.add(k)
        if span.kind == "image" and span.resource_name:
            candidate_resources.add(span.resource_name)

    if not remove_idx:
        return DeleteResult(changed=False, message="Span rỗng — không có op để xóa.")

    # ── Dựng danh sách instruction mới (giữ nguyên op ngoài span) ───────────
    new_instructions = [instr for i, instr in enumerate(instructions) if i not in remove_idx]

    # ── Dọn XObject CHỈ KHI không còn tham chiếu nào khác (Yêu cầu 3.1) ─────
    cleaned: list[str] = []
    xobjects = _xobject_dict(pg)
    if xobjects is not None:
        for name in candidate_resources:
            if _still_referenced(new_instructions, name):
                continue  # còn nơi khác dùng → KHÔNG gỡ
            key = pikepdf.Name("/" + name)
            try:
                if key in xobjects:
                    del xobjects[key]
                    cleaned.append(name)
            except Exception as exc:  # noqa: BLE001 - gỡ resource best-effort
                logger.warning("Không gỡ được XObject '%s': %s", name, exc)

    # ── Ghi lại content stream qua pikepdf (đường ghi DUY NHẤT) ─────────────
    new_bytes = pikepdf.unparse_content_stream(new_instructions)
    pg.obj[pikepdf.Name("/Contents")] = pdf.make_stream(new_bytes)

    removed_count = len(remove_idx)
    return DeleteResult(
        changed=True,
        removed_op_count=removed_count,
        removed_spans=spans,
        cleaned_resources=cleaned,
        message=(
            f"Đã xóa {len(spans)} object ({removed_count} op); "
            f"dọn {len(cleaned)} XObject không còn tham chiếu."
        ),
    )


def _q_instruction() -> pikepdf.ContentStreamInstruction:
    """Tạo instruction `q` (lưu graphics-state) — không operand."""
    return pikepdf.ContentStreamInstruction([], pikepdf.Operator("q"))


def _Q_instruction() -> pikepdf.ContentStreamInstruction:
    """Tạo instruction `Q` (khôi phục graphics-state) — không operand."""
    return pikepdf.ContentStreamInstruction([], pikepdf.Operator("Q"))


def _cm_translate_instruction(dx: float, dy: float) -> pikepdf.ContentStreamInstruction:
    """
    Tạo instruction `cm` cho phép tịnh tiến thuần:

        translate(dx, dy) = [1, 0, 0, 1, dx, dy]

    Khi đặt NGAY TRƯỚC dải operator của object (và đóng bằng `Q` ngay sau),
    object được vẽ với CTM = mult_matrix([1,0,0,1,dx,dy], CTM_hiện_tại). Với
    trang có CTM gốc là đơn vị (trường hợp phổ biến), kết quả là object dịch
    đúng `(dx, dy)` point trong hệ tọa độ trang PDF — khớp Property 2 (Yêu cầu 5.2).
    """
    return pikepdf.ContentStreamInstruction(
        [1.0, 0.0, 0.0, 1.0, float(dx), float(dy)],
        pikepdf.Operator("cm"),
    )


def _Tm_instruction(tm: list[float]) -> pikepdf.ContentStreamInstruction:
    """Tạo instruction `Tm` (đặt text matrix TUYỆT ĐỐI) từ ma trận 6 phần tử."""
    if len(tm) != 6:
        raise ValueError("Ma trận Tm phải gồm đúng 6 phần tử [a, b, c, d, e, f]")
    return pikepdf.ContentStreamInstruction(
        [float(v) for v in tm],
        pikepdf.Operator("Tm"),
    )


def _BT_instruction() -> pikepdf.ContentStreamInstruction:
    return pikepdf.ContentStreamInstruction([], pikepdf.Operator("BT"))


def _ET_instruction() -> pikepdf.ContentStreamInstruction:
    return pikepdf.ContentStreamInstruction([], pikepdf.Operator("ET"))


def _show_as_Tj(show_instr) -> pikepdf.ContentStreamInstruction:
    """Chuẩn hoá Tj/TJ/'/\" thành một show an toàn trong BT…ET tách riêng."""
    op = str(show_instr.operator)
    operands = list(show_instr.operands)
    if op == "Tj":
        return show_instr
    if op == "TJ":
        return show_instr
    if op == "'" and operands:
        return pikepdf.ContentStreamInstruction([operands[0]], pikepdf.Operator("Tj"))
    if op == '"' and len(operands) >= 3:
        return pikepdf.ContentStreamInstruction([operands[2]], pikepdf.Operator("Tj"))
    if operands:
        return pikepdf.ContentStreamInstruction([operands[-1]], pikepdf.Operator("Tj"))
    return pikepdf.ContentStreamInstruction([pikepdf.String("")], pikepdf.Operator("Tj"))


def _active_tf_before(instructions: list, index: int):
    """Tf gần nhất trước `index` (kể cả ngoài BT — text state bền)."""
    for j in range(index - 1, -1, -1):
        if str(instructions[j].operator) == "Tf":
            return instructions[j]
    return None


def _should_drop_tm_before_show(instructions: list, tm_index: int, show_index: int) -> bool:
    """True nếu `tm_index` là Tm ngay trước show và không còn show nào dùng nó."""
    if tm_index < 0 or show_index != tm_index + 1:
        return False
    if str(instructions[tm_index].operator) != "Tm":
        return False
    # Sau show: ET / Tm / Td / TD / T* / BMC… → Tm này chỉ phục vụ show này.
    if show_index + 1 >= len(instructions):
        return True
    nxt = str(instructions[show_index + 1].operator)
    return nxt in {"ET", "Tm", "Td", "TD", "T*", "BT", "Q", "EMC"}


def _shifted_text_tm(tm: list[float], ctm: list[float], dx: float, dy: float) -> list[float]:
    """
    Tính text-matrix MỚI để glyph dịch `(dx, dy)` trong hệ tọa độ TRANG (page-space).

    Điểm hiển thị page = p_text · (tm · ctm). Để cộng (dx,dy) ở page-space:
        new(tm·ctm) = (tm·ctm) · T(dx,dy)
        ⇒ new_tm = tm · ctm · T(dx,dy) · ctm⁻¹
    Nếu ctm suy biến (hiếm) → fallback dịch trực tiếp e,f của tm (đúng khi ctm
    là đơn vị/tịnh tiến).
    """
    t = [1.0, 0.0, 0.0, 1.0, float(dx), float(dy)]
    m = mult_matrix(tm, ctm)
    m2 = mult_matrix(m, t)
    ctm_inv = inverse_matrix(ctm)
    if ctm_inv is None:
        return [tm[0], tm[1], tm[2], tm[3], tm[4] + float(dx), tm[5] + float(dy)]
    return mult_matrix(m2, ctm_inv)


def _rotated_text_tm(tm: list[float], ctm: list[float], deg: float, cx: float, cy: float) -> list[float]:
    """
    Text-matrix MỚI để run text XOAY góc `deg` quanh tâm `(cx, cy)` (page-space).

    Điểm page = p_text · (tm · ctm). Xoay output quanh (cx,cy):
        new(tm·ctm) = (tm·ctm) · Mrot   với Mrot = T(c)·rot(θ)·T(-c)
        ⇒ new_tm = tm · ctm · Mrot · ctm⁻¹
    `Mrot` tái dùng `_compose_rotate_cm` (đồng nhất quy ước với nhánh image/vector).
    """
    mrot = _compose_rotate_cm(deg, cx, cy)
    m = mult_matrix(tm, ctm)
    m2 = mult_matrix(m, mrot)
    ctm_inv = inverse_matrix(ctm)
    if ctm_inv is None:
        # Fallback: ctm đơn vị → new_tm = tm · Mrot.
        return mult_matrix(tm, mrot)
    return mult_matrix(m2, ctm_inv)




def _affine_text_tm(tm: list[float], ctm: list[float], matrix: list[float]) -> list[float]:
    """Áp ma trận page-space lên một text run nhưng không làm xê dịch run lân cận."""
    transformed = mult_matrix(mult_matrix(tm, ctm), matrix)
    ctm_inv = inverse_matrix(ctm)
    if ctm_inv is None:
        return mult_matrix(tm, matrix)
    return mult_matrix(transformed, ctm_inv)

def _enclosing_q_indices(instructions: list, index: int) -> tuple[int, int] | None:
    """
    Tìm cặp `q … Q` lồng khít nhất bao quanh instruction tại `index`.
    Trả `(q_index, Q_index)` hoặc None.
    """
    depth = 0
    q_index = -1
    j = index - 1
    while j >= 0:
        op = str(instructions[j].operator)
        if op == "Q":
            depth += 1
        elif op == "q":
            if depth == 0:
                q_index = j
                break
            depth -= 1
        j -= 1
    if q_index < 0:
        return None

    depth = 0
    Q_index = -1
    k = index + 1
    n = len(instructions)
    while k < n:
        op = str(instructions[k].operator)
        if op == "q":
            depth += 1
        elif op == "Q":
            if depth == 0:
                Q_index = k
                break
            depth -= 1
        k += 1
    if Q_index < 0:
        return None
    return q_index, Q_index


def _expand_re_operands_for_delta(operands: list, dx: float, dy: float) -> list:
    """
    Mở rộng rectangle `x y w h re` thành UNION của rect cũ và rect đã dịch (dx, dy).

    Giữ nguyên vùng clip cũ (các run text khác trong cụm vẫn hiện) VÀ phủ vị trí
    mới của text vừa kéo — tránh "kéo text ra ngoài clip → mất chữ".
    """
    if len(operands) < 4:
        return operands
    vals = [_as_float(o) for o in operands[:4]]
    if any(v is None for v in vals):
        return operands
    x, y, w, h = (float(v) for v in vals)  # type: ignore[arg-type]
    # Chuẩn hóa w/h âm (hiếm) về origin + kích thước dương.
    if w < 0:
        x, w = x + w, -w
    if h < 0:
        y, h = y + h, -h
    x0, y0, x1, y1 = x, y, x + w, y + h
    nx0, ny0, nx1, ny1 = x0 + dx, y0 + dy, x1 + dx, y1 + dy
    ux0, uy0 = min(x0, nx0), min(y0, ny0)
    ux1, uy1 = max(x1, nx1), max(y1, ny1)
    return [ux0, uy0, ux1 - ux0, uy1 - uy0, *operands[4:]]


def _find_enclosing_q_open(instructions: list, index: int) -> int:
    """Chỉ số của `q` bao khít nhất TRƯỚC `index` (bỏ qua cặp q…Q lồng đã đóng).

    Trả -1 nếu `index` không nằm trong khối q…Q nào. Chỉ dò về sau (không cần
    tìm `Q` đóng như `_enclosing_q_indices`) nên đúng kể cả khi `index` là chính
    một `q` mở khối con.
    """
    depth = 0
    j = index - 1
    while j >= 0:
        op = str(instructions[j].operator)
        if op == "Q":
            depth += 1
        elif op == "q":
            if depth == 0:
                return j
            depth -= 1
        j -= 1
    return -1


def _shift_enclosing_clip_rects(
    instructions: list,
    span_start: int,
    dx: float,
    dy: float,
) -> dict[int, object]:
    """
    Mở rộng clip rectangle của MỌI khối `q…Q` BAO NGOÀI dải bọc `[span_start, …)`.

    Root cause "kéo text → mất" trên PDF InDesign/Illustrator: text nằm trong
    clip LỒNG NHAU — `q re W n  q re W n BT…ET Q  Q`. `move_objects` bọc
    `q/cm/Q` quanh khối TRONG nên clip trong dịch theo chữ (OK), NHƯNG clip
    NGOÀI đứng TRƯỚC `cm`, giữ vị trí gốc → glyph đã dịch nằm ngoài clip ngoài
    → PDFium cắt sạch → mất chữ (dù `Tm`/bbox báo đã dịch).

    Đi ngược lên từng khối `q…Q` tổ tiên (nằm NGOÀI vùng được `cm` dịch) và mở
    rộng các `re` clip-setup của nó thành union(cũ, cũ+(dx,dy)) — vừa giữ nội
    dung khác trong clip, vừa để lọt glyph đã dịch. Chỉ đụng `re` ở ĐÚNG cấp
    của khối (bỏ qua q…Q con đã đóng) và CHỈ phần TRƯỚC `span_start` (không đụng
    clip bên trong vùng đã dịch — chúng dịch cùng chữ).

    Trả map `{index: instruction_mới}` để thay `re`.
    """
    replacements: dict[int, object] = {}
    if dx == 0.0 and dy == 0.0:
        return replacements

    cursor = span_start
    while True:
        q_index = _find_enclosing_q_open(instructions, cursor)
        if q_index < 0:
            break
        # Quét q_index+1 → span_start ở ĐÚNG cấp khối này (depth 0). `re` đứng
        # trước `W`/`W*` là clip-setup → mở rộng. Painting thật xoá pending.
        pending_re: list[int] = []
        depth = 0
        i = q_index + 1
        while i < span_start:
            op = str(instructions[i].operator)
            if depth == 0:
                if op == "re":
                    pending_re.append(i)
                elif op in ("W", "W*"):
                    for ri in pending_re:
                        old = instructions[ri]
                        new_ops = _expand_re_operands_for_delta(list(old.operands), dx, dy)
                        replacements[ri] = pikepdf.ContentStreamInstruction(
                            new_ops, pikepdf.Operator("re")
                        )
                    pending_re = []
                elif op in ("f", "F", "f*", "S", "s", "B", "B*", "b", "b*"):
                    pending_re = []  # fill/stroke: path không phải clip
            if op == "q":
                depth += 1
            elif op == "Q":
                depth -= 1
            i += 1
        cursor = q_index

    return replacements


def _find_bt_et_bounds(instructions: list, show_index: int) -> tuple[int, int] | None:
    """
    Tìm cụm `BT…ET` chứa instruction show-op tại `show_index`.
    Trả `[bt_index, et_index+1)` (nửa-mở) hoặc None.
    """
    if show_index < 0 or show_index >= len(instructions):
        return None
    bt = -1
    for j in range(show_index, -1, -1):
        op = str(instructions[j].operator)
        if op == "BT":
            bt = j
            break
        if op == "ET" and j != show_index:
            return None
    if bt < 0:
        return None
    et = -1
    for j in range(show_index, len(instructions)):
        if str(instructions[j].operator) == "ET":
            et = j
            break
    if et < 0:
        return None
    return bt, et + 1


# Op được phép trong khối q…Q bao text khi ta expand span để gồm clip:
# path/clip, màu, graphics-state đơn giản — KHÔNG painting khác, KHÔNG Do/text khác.
_TEXT_CLIP_BLOCK_OK = {
    "q", "Q", "cm", "gs",
    "w", "J", "j", "M", "d", "ri", "i",
    "g", "G", "rg", "RG", "k", "K", "cs", "CS", "scn", "SCN", "sc", "SC",
    "m", "l", "c", "v", "y", "h", "re",
    "W", "W*", "n",
    "BT", "ET", "Tf", "Td", "TD", "Tm", "T*", "TL", "Tc", "Tw", "Tz", "Ts", "Tr",
    "Tj", "TJ", "'", '"',
}


def _block_is_isolated_text_clip(
    instructions: list, q_index: int, Q_index: int, text_start: int, text_end: int
) -> bool:
    """
    True nếu khối `q…Q` CHỈ phục vụ đúng một cụm text `[text_start, text_end)`
    (+ clip/màu/gs). An toàn để bọc translate cm NGOÀI cả khối → clip đi cùng text.
    """
    if not (q_index < text_start < text_end - 1 <= Q_index):
        return False
    # Không có BT…ET nào khác trong block.
    for j in range(q_index + 1, Q_index):
        op = str(instructions[j].operator)
        if op == "BT" and j != text_start:
            return False
        if op == "Do" or op == "INLINE IMAGE":
            return False
        # Painting thật (tô/nét) ngoài vùng text → block còn vẽ khác, không expand.
        if op in ("f", "F", "f*", "S", "s", "B", "B*", "b", "b*") and not (
            text_start <= j < text_end
        ):
            return False
        if op not in _TEXT_CLIP_BLOCK_OK and not (text_start <= j < text_end):
            # Op lạ ngoài cụm text → không chắc an toàn.
            if op not in ("BMC", "BDC", "EMC", "MP", "DP", "BX", "EX"):
                return False
    return True


def _include_preceding_clip_ops(instructions: list, start: int) -> int:
    """
    Nếu ngay trước `start` (thường là BT) là chuỗi clip `… re … W/W* n`,
    lùi start để BAO luôn clip — kể cả khi không có khối `q…Q` cô lập.
    """
    if start <= 0:
        return start
    i = start - 1
    # Bỏ qua n sau W
    if i >= 0 and str(instructions[i].operator) == "n":
        i -= 1
    if i < 0 or str(instructions[i].operator) not in ("W", "W*"):
        return start
    # Lùi qua path construction (re/m/l/c/…) và màu đơn giản đứng trước clip
    i -= 1
    path_ops = {"m", "l", "c", "v", "y", "h", "re"}
    color_gs = {
        "g", "G", "rg", "RG", "k", "K", "cs", "CS", "scn", "SCN", "sc", "SC",
        "w", "J", "j", "M", "d", "gs", "cm",
    }
    while i >= 0:
        op = str(instructions[i].operator)
        if op in path_ops or op in color_gs:
            i -= 1
            continue
        break
    new_start = i + 1
    # Chỉ nhận nếu thực sự có ít nhất một `re` trong đoạn clip vừa quét.
    has_re = any(
        str(instructions[j].operator) == "re" for j in range(new_start, start)
    )
    return new_start if has_re else start


def _expand_text_span_for_move(
    instructions: list, start: int, end: int
) -> tuple[int, int]:
    """
    Mở rộng span text `[start, end)` (thường là BT…ET):
      1) Lên cả khối `q…Q` bao ngoài nếu khối chỉ là clip + text.
      2) Hoặc lùi bao clip `re W n` đứng ngay trước BT (không cần q).

    Nhờ đó bọc `q/cm/Q` translate dịch CẢ clip lẫn chữ — không mất chữ.
    """
    if start < 0 or end > len(instructions) or start >= end:
        return start, end
    # Neo vào instruction giữa span (BT hoặc show-op) để tìm q bao ngoài.
    mid = start
    block = _enclosing_q_indices(instructions, mid)
    if block is not None:
        q_index, Q_index = block
        if _block_is_isolated_text_clip(instructions, q_index, Q_index, start, end):
            return q_index, Q_index + 1
    # Không expand được cả q…Q → vẫn cố gắng gồm clip ngay trước BT.
    start = _include_preceding_clip_ops(instructions, start)
    return start, end


def _resolve_text_move_span(pg, meta, pdf: pikepdf.Pdf, instructions: list) -> OpSpan:
    """
    Xác định dải operator để DI CHUYỂN text bằng bọc `q/cm/Q` (page-space).

    Ưu tiên `map_object` (cả BT…ET); fallback `text_show_op_for_move` → BT…ET
    chứa show-op. Sau đó expand để gồm clip group cô lập nếu có.
    """
    meta_id = meta.get("id") if isinstance(meta, dict) else getattr(meta, "id", "?")
    span = map_object(pg, meta, pdf=pdf)
    if span is not None and span.kind == "text":
        start, end = _expand_text_span_for_move(instructions, span.start, span.end)
        return OpSpan(
            start=start,
            end=end,
            kind="text",
            ctm=list(span.ctm),
            bbox=list(span.bbox),
            resource_name=None,
        )

    info = text_show_op_for_move(pg, meta, pdf=pdf)
    if info is None:
        raise ObjectMapError(
            f"Không thể ánh xạ object '{meta_id}' sang dải text để di chuyển. "
            f"HỦY thao tác để bảo toàn (Yêu cầu 4.7) — KHÔNG ghi."
        )
    bounds = _find_bt_et_bounds(instructions, info["target_index"])
    if bounds is None:
        raise ObjectMapError(
            f"Không tìm thấy cụm BT…ET cho object '{meta_id}'. "
            f"HỦY thao tác (Yêu cầu 4.7) — KHÔNG ghi."
        )
    start, end = _expand_text_span_for_move(instructions, bounds[0], bounds[1])
    return OpSpan(
        start=start,
        end=end,
        kind="text",
        ctm=[1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        bbox=[0.0, 0.0, 0.0, 0.0],
        resource_name=None,
    )


def move_objects(
    page,
    obj_metas,
    dx: float,
    dy: float,
    pdf: pikepdf.Pdf,
    coord_space: str = "pdf",
) -> MoveResult:
    """
    Di chuyển (tịnh tiến) đúng tập object mục tiêu.

    IMAGE/VECTOR (và text 1 run trong BT…ET): bọc `q <translate cm> … Q` page-space
    + mở rộng clip lồng nhau (InDesign/Illustrator) — `cm` ngoài BT…ET.

    TEXT nhiều run chung một BT…ET (PDFium tách "hotline" / "@asia…" thành
    object riêng): TÁCH run được chọn ra BT…ET mới + bọc cm, XOÁ show gốc
    trong cụm — không ghim Tm ước lượng (tránh cắt/nhân bản email).

    Quy ước hệ tọa độ của `(dx, dy)` — xác định bởi `coord_space`:
      - `"pdf"`    (MẶC ĐỊNH): hệ trang PDF (gốc dưới-trái, y lên).
      - `"canvas"`: hệ canvas (gốc trên-trái, y xuống); `dy_pdf = -dy`.

    Raises:
        ObjectMapError: nếu BẤT KỲ target nào không map được duy nhất → HỦY,
                        KHÔNG ghi.
    """
    pg = _as_page(page)

    # Chuẩn hóa độ dịch về hệ PDF (bottom-left).
    pdf_dx = float(dx)
    pdf_dy = float(dy)
    if coord_space == "canvas":
        pdf_dy = -pdf_dy
    elif coord_space != "pdf":
        raise ValueError(f"coord_space không hợp lệ: {coord_space!r} (chỉ 'pdf' hoặc 'canvas')")

    # ── Tập rỗng → no-op (đồng bộ hành vi delete) ───────────────────────────
    if not obj_metas:
        return MoveResult(
            changed=False,
            dx=pdf_dx,
            dy=pdf_dy,
            message="Không có object mục tiêu — không thay đổi.",
        )

    # Gộp content stream về MỘT lần để mọi index span/parse đồng bộ.
    try:
        contents_coalesce(pdf, pg)
    except Exception as exc:  # noqa: BLE001 - coalesce lỗi vẫn parse trực tiếp được
        logger.warning("contents_coalesce thất bại, tiếp tục parse trực tiếp: %s", exc)

    instructions = parse_page_ops(pg)
    n = len(instructions)

    _dbg = edit_text_move_log_enabled()
    shows_before = _stream_text_shows(instructions) if _dbg else []
    if _dbg:
        log_text_move(
            "text.move.begin",
            dx=pdf_dx,
            dy=pdf_dy,
            coordSpace=coord_space,
            metaCount=len(obj_metas),
            streamOpCount=n,
            showsBefore=shows_before,
            targets=[
                {
                    "id": (m.get("id") if isinstance(m, dict) else getattr(m, "id", "?")),
                    "type": (m.get("type") if isinstance(m, dict) else getattr(m, "type", None)),
                    "bbox": list(
                        m.get("bbox") if isinstance(m, dict)
                        else getattr(m, "bbox", None) or []
                    ),
                    "drawIndex": (
                        m.get("drawIndex") if isinstance(m, dict)
                        else getattr(m, "drawIndex", None)
                    ),
                }
                for m in obj_metas
            ],
        )

    # ── Map targets ────────────────────────────────────────────────────────
    # wrap_spans: bọc q/cm/Q (image/vector + text 1-run).
    # text_extracts: multi-run — xoá show gốc, chèn BT…ET mới sau ET cụm.
    wrap_spans: list[OpSpan] = []
    text_extracts: list[dict] = []
    remove_indices: set[int] = set()
    # et_index (instruction ET) → các block instruction cần chèn SAU nó
    append_after: dict[int, list[list]] = {}
    path_decisions: list[dict] = []

    for meta in obj_metas:
        meta_type = meta.get("type") if isinstance(meta, dict) else getattr(meta, "type", None)
        meta_id = meta.get("id") if isinstance(meta, dict) else getattr(meta, "id", "?")
        meta_bbox = list(
            meta.get("bbox") if isinstance(meta, dict)
            else getattr(meta, "bbox", [0.0, 0.0, 0.0, 0.0])
        )
        if meta_type == "text":
            info = text_show_op_for_move(pg, meta, pdf=pdf)
            if info is None:
                span = _resolve_text_move_span(pg, meta, pdf, instructions)
                wrap_spans.append(span)
                path_decisions.append({
                    "metaId": meta_id,
                    "path": "wrap_full_bt_et",
                    "reason": "text_show_op_for_move_none",
                    "bbox": meta_bbox,
                    "wrap": [span.start, span.end],
                })
                continue

            cluster = info.get("cluster") or []
            target_index = int(info["target_index"])
            cluster_preview = []
            for s in cluster:
                si = int(s["index"])
                if 0 <= si < n:
                    cluster_preview.append({
                        "i": si,
                        "preview": _show_operand_preview(instructions[si]),
                        "tm": list(s.get("tm") or []),
                    })
            if len(cluster) <= 1:
                # QUAN TRỌNG: bọc ĐÚNG BT…ET chứa target_index từ text_show_op_for_move.
                # map_object (bbox) trên file AI/InDesign từng trả span LÂN CẬN
                # (vd show@286 nhưng wrap [253,265]) → kéo hotline phá email.
                bounds = _find_bt_et_bounds(instructions, target_index)
                if bounds is not None:
                    start, end = _expand_text_span_for_move(
                        instructions, bounds[0], bounds[1]
                    )
                    show_ctm = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
                    if cluster:
                        show_ctm = list(cluster[0].get("ctm") or show_ctm)
                    span = OpSpan(
                        start=start,
                        end=end,
                        kind="text",
                        ctm=show_ctm,
                        bbox=meta_bbox,
                        resource_name=None,
                    )
                else:
                    span = _resolve_text_move_span(pg, meta, pdf, instructions)
                wrap_spans.append(span)
                path_decisions.append({
                    "metaId": meta_id,
                    "path": "wrap_single_run",
                    "targetIndex": target_index,
                    "clusterSize": len(cluster),
                    "cluster": cluster_preview,
                    "bbox": meta_bbox,
                    "wrap": [span.start, span.end],
                    "btEtBounds": list(bounds) if bounds else None,
                    "window": _ops_window(instructions, target_index),
                    "wrapContainsTarget": (
                        span.start <= target_index < span.end
                    ),
                })
                if not (span.start <= target_index < span.end):
                    logger.error(
                        "[EDIT_TEXT_MOVE] wrap KHÔNG chứa target! meta=%s "
                        "target_i=%d wrap=[%d,%d) — HUỶ để không phá run khác",
                        meta_id, target_index, span.start, span.end,
                    )
                    log_text_move(
                        "text.move.wrap_miss_target",
                        metaId=meta_id,
                        targetIndex=target_index,
                        wrap=[span.start, span.end],
                    )
                    raise ObjectMapError(
                        f"Map text '{meta_id}' lệch span (show@{target_index} "
                        f"vs wrap [{span.start},{span.end})). HỦY — không ghi."
                    )
                continue

            # Multi-run: tách run ra khỏi cụm (extract) — an toàn hơn ghim Tm.
            if not (0 <= target_index < n):
                raise ObjectMapError(
                    f"Show-op text '{meta_id}' ngoài phạm vi stream."
                )
            if target_index in remove_indices:
                path_decisions.append({
                    "metaId": meta_id,
                    "path": "extract_skip_already_removed",
                    "targetIndex": target_index,
                })
                continue  # đã extract trong batch selection
            show_by_idx = {int(s["index"]): s for s in cluster}
            target_show = show_by_idx.get(target_index)
            if target_show is None:
                raise ObjectMapError(
                    f"Không tìm thấy show-op mục tiêu cho text '{meta_id}'."
                )
            bounds = _find_bt_et_bounds(instructions, target_index)
            if bounds is None:
                # Không tìm được ET → fallback bọc cả cụm
                span = _resolve_text_move_span(pg, meta, pdf, instructions)
                wrap_spans.append(span)
                path_decisions.append({
                    "metaId": meta_id,
                    "path": "wrap_full_bt_et",
                    "reason": "no_bt_et_bounds",
                    "targetIndex": target_index,
                    "cluster": cluster_preview,
                    "bbox": meta_bbox,
                    "wrap": [span.start, span.end],
                })
                continue
            _bt, et_end = bounds
            et_index = et_end - 1

            show_instr = instructions[target_index]
            base_tm = list(target_show["tm"])
            tf_instr = _active_tf_before(instructions, target_index)
            drop_tm = _should_drop_tm_before_show(
                instructions, target_index - 1, target_index
            )

            # Block độc lập: vị trí cũ (Tm gốc) + cm dịch page-space.
            block: list = [
                _q_instruction(),
                _cm_translate_instruction(pdf_dx, pdf_dy),
                _BT_instruction(),
            ]
            if tf_instr is not None:
                block.append(tf_instr)
            block.append(_Tm_instruction(base_tm))
            block.append(_show_as_Tj(show_instr))
            block.append(_ET_instruction())
            block.append(_Q_instruction())

            append_after.setdefault(et_index, []).append(block)
            remove_indices.add(target_index)
            # Gỡ Tm chỉ phục vụ show này (tránh Tm mồ côi ảnh hưởng run sau).
            if drop_tm:
                remove_indices.add(target_index - 1)

            text_extracts.append({
                "target_index": target_index,
                "meta_id": meta_id,
                "bbox": meta_bbox,
                "showPreview": _show_operand_preview(show_instr),
                "baseTm": base_tm,
                "etIndex": et_index,
                "btIndex": _bt,
                "dropPrecedingTm": drop_tm,
            })
            path_decisions.append({
                "metaId": meta_id,
                "path": "extract_multi_run",
                "targetIndex": target_index,
                "clusterSize": len(cluster),
                "cluster": cluster_preview,
                "bbox": meta_bbox,
                "showPreview": _show_operand_preview(show_instr),
                "baseTm": base_tm,
                "etIndex": et_index,
                "btIndex": _bt,
                "dropPrecedingTm": drop_tm,
                "window": _ops_window(instructions, target_index),
                "siblingShowsNotTouched": [
                    c for c in cluster_preview if c["i"] != target_index
                ],
            })
            if _dbg:
                logger.info(
                    "[EDIT_TEXT_MOVE] EXTRACT meta=%s target_i=%d show=%s "
                    "cluster=%d dropTm=%s et=%d",
                    meta_id,
                    target_index,
                    _show_operand_preview(show_instr),
                    len(cluster),
                    drop_tm,
                    et_index,
                )
        else:
            obj_spans = map_object_spans(pg, meta, pdf=pdf)
            if not obj_spans:
                raise ObjectMapError(
                    f"Không thể ánh xạ object '{meta_id}' sang dải operator duy nhất "
                    f"(đa nghĩa/clip/Form XObject/inline image). HỦY thao tác để bảo "
                    f"toàn màu (Yêu cầu 4.7) — KHÔNG ghi kết quả."
                )
            wrap_spans.extend(obj_spans)

    # Gộp span trùng (nhiều text object PDFium cùng 1 BT…ET / cùng clip group)
    # để không bọc q/cm/Q lồng nhiều lần cùng vùng.
    unique: list[OpSpan] = []
    seen_ranges: set[tuple[int, int]] = set()
    for span in wrap_spans:
        key = (span.start, span.end)
        if key in seen_ranges:
            continue
        seen_ranges.add(key)
        unique.append(span)

    # Gom chèn prefix/suffix theo vị trí.
    prefix: dict[int, list] = {}
    suffix: dict[int, list] = {}

    def _add_prefix(i: int, instrs: list) -> None:
        prefix.setdefault(i, []).extend(instrs)

    def _add_suffix(i: int, instrs: list) -> None:
        suffix.setdefault(i, []).extend(instrs)

    # Clip LỒNG NHAU (InDesign/Illustrator): mở rộng clip bao ngoài vùng cm.
    clip_replacements: dict[int, object] = {}
    for span in unique:
        start = max(0, span.start)
        end = min(n, span.end)
        if start >= end:
            continue
        _add_prefix(start, [_q_instruction(), _cm_translate_instruction(pdf_dx, pdf_dy)])
        _add_suffix(end - 1, [_Q_instruction()])
        clip_replacements.update(
            _shift_enclosing_clip_rects(instructions, start, pdf_dx, pdf_dy)
        )
    # Clip expand cho extract (neo tại show gốc — trước khi xoá).
    for ex in text_extracts:
        ti = int(ex["target_index"])
        if 0 <= ti < n:
            clip_replacements.update(
                _shift_enclosing_clip_rects(instructions, ti, pdf_dx, pdf_dy)
            )

    # ── Dựng instruction list mới ──────────────────────────────────────────
    new_instructions: list = []
    for i, instr in enumerate(instructions):
        if i in remove_indices:
            # Vẫn chèn extract sau ET dù ET không bị xoá; skip show/Tm đã extract.
            if i in append_after:
                for block in append_after[i]:
                    new_instructions.extend(block)
            continue
        if i in prefix:
            new_instructions.extend(prefix[i])
        new_instructions.append(clip_replacements.get(i, instr))
        if i in suffix:
            new_instructions.extend(suffix[i])
        if i in append_after:
            for block in append_after[i]:
                new_instructions.extend(block)

    # ── Ghi lại content stream qua pikepdf (đường ghi DUY NHẤT) ─────────────
    new_bytes = pikepdf.unparse_content_stream(new_instructions)
    pg.obj[pikepdf.Name("/Contents")] = pdf.make_stream(new_bytes)

    if _dbg:
        shows_after = _stream_text_shows(new_instructions)
        log_text_move(
            "text.move.end",
            dx=pdf_dx,
            dy=pdf_dy,
            pathDecisions=path_decisions,
            removeIndices=sorted(remove_indices),
            appendAfterEt=sorted(append_after.keys()),
            wrapRanges=[[s.start, s.end] for s in unique],
            extractCount=len(text_extracts),
            extracts=text_extracts,
            showsBefore=shows_before,
            showsAfter=shows_after,
            showTextsBefore=[s.get("preview") for s in shows_before],
            showTextsAfter=[s.get("preview") for s in shows_after],
            newOpCount=len(new_instructions),
        )
        logger.info(
            "[EDIT_TEXT_MOVE] end extracts=%d wraps=%d remove=%s shows %d→%d decisions=%s",
            len(text_extracts),
            len(unique),
            sorted(remove_indices),
            len(shows_before),
            len(shows_after),
            [d.get("path") for d in path_decisions],
        )

    granular_spans = [
        OpSpan(
            start=0, end=0, kind="text",
            ctm=[1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            bbox=list(ex["bbox"]),
            resource_name=None,
        )
        for ex in text_extracts
    ]
    all_spans = list(wrap_spans) + granular_spans
    wrapped = len(unique) + len(text_extracts)
    return MoveResult(
        changed=True,
        moved_spans=all_spans,
        dx=pdf_dx,
        dy=pdf_dy,
        wrapped_count=wrapped,
        message=(
            f"Đã di chuyển {len(obj_metas)} object (dx={pdf_dx:.3f}, dy={pdf_dy:.3f}); "
            f"cm-wrap={len(unique)}, text-extract={len(text_extracts)}."
        ),
    )



def affine_transform_objects(
    page,
    obj_metas,
    matrix: list[float],
    pdf: pikepdf.Pdf,
) -> AffineResult:
    """
    Áp một ma trận affine page-space CHUNG cho toàn bộ selection trong một lần parse/ghi.

    Translation thuần tái dùng move_objects để giữ nguyên cơ chế mở rộng clip đã kiểm chứng.
    Scale/rotate hỗn hợp ghim Tm riêng cho text run và bọc q/cm/Q cho image/vector.
    """
    values = [float(v) for v in matrix]
    if len(values) != 6 or not all(math.isfinite(v) for v in values):
        raise ValueError("matrix affine phải gồm 6 số hữu hạn")
    if abs(values[0] * values[3] - values[1] * values[2]) < 1e-9:
        raise ValueError("matrix affine suy biến không được phép")
    if all(abs(values[i] - expected) < 1e-9 for i, expected in enumerate(
        [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
    )):
        return AffineResult(changed=False, matrix=values, message="Affine identity - không thay đổi.")

    # Dịch thuần đi qua đường move đã xử lý clip text Illustrator/InDesign.
    if (
        abs(values[0] - 1.0) < 1e-9
        and abs(values[1]) < 1e-9
        and abs(values[2]) < 1e-9
        and abs(values[3] - 1.0) < 1e-9
    ):
        moved = move_objects(page, obj_metas, values[4], values[5], pdf)
        return AffineResult(
            changed=moved.changed,
            transformed_spans=moved.moved_spans,
            matrix=values,
            wrapped_count=moved.wrapped_count,
            message=moved.message,
        )

    if not obj_metas:
        return AffineResult(changed=False, matrix=values, message="Không có object mục tiêu.")

    pg = _as_page(page)
    try:
        contents_coalesce(pdf, pg)
    except Exception as exc:
        logger.warning("contents_coalesce thất bại trong affine, tiếp tục: %s", exc)

    nontext_spans: list[OpSpan] = []
    text_infos: list[dict] = []
    transformed_spans: list[OpSpan] = []
    for meta in obj_metas:
        meta_type = _meta_value(meta, "type")
        meta_id = _meta_value(meta, "id", "?")
        if meta_type == "text":
            info = text_show_op_for_move(pg, meta, pdf=pdf)
            if info is None:
                raise ObjectMapError(
                    f"Không thể ánh xạ text '{meta_id}' sang show-op duy nhất cho affine."
                )
            text_infos.append(info)
            ti = info["target_index"]
            transformed_spans.append(OpSpan(
                start=ti, end=ti + 1, kind="text",
                ctm=[1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                bbox=list(_meta_value(meta, "bbox", [0.0, 0.0, 0.0, 0.0])),
                resource_name=None,
            ))
        else:
            spans = map_object_spans(pg, meta, pdf=pdf)
            if not spans:
                raise ObjectMapError(
                    f"Không thể ánh xạ object '{meta_id}' cho affine; hủy để bảo toàn PDF."
                )
            nontext_spans.extend(spans)
            transformed_spans.extend(spans)

    instructions = parse_page_ops(pg)
    n = len(instructions)
    prefix: dict[int, list] = {}
    suffix: dict[int, list] = {}

    # Dedupe fill/stroke cùng span để không bọc lồng ma trận hai lần.
    seen_ranges: set[tuple[int, int]] = set()
    for span in nontext_spans:
        start = max(0, span.start)
        end = min(n, span.end)
        key = (start, end)
        if start >= end or key in seen_ranges:
            continue
        seen_ranges.add(key)
        prefix.setdefault(start, []).extend([_q_instruction(), _cm_instruction(values)])
        suffix.setdefault(end - 1, []).append(_Q_instruction())

    # Ghim lại tất cả show-op cùng cluster; chỉ target được áp affine.
    target_indices = {info["target_index"] for info in text_infos}
    cluster_show: dict[int, tuple[list[float], list[float]]] = {}
    for info in text_infos:
        for show in info["cluster"]:
            cluster_show[show["index"]] = (show["tm"], show["ctm"])
    for idx, (tm_abs, ctm_abs) in cluster_show.items():
        tm_use = _affine_text_tm(tm_abs, ctm_abs, values) if idx in target_indices else tm_abs
        prefix.setdefault(idx, []).append(_Tm_instruction(tm_use))

    new_instructions: list = []
    for i, instr in enumerate(instructions):
        if i in prefix:
            new_instructions.extend(prefix[i])
        new_instructions.append(instr)
        if i in suffix:
            new_instructions.extend(suffix[i])

    pg.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
        pikepdf.unparse_content_stream(new_instructions)
    )
    return AffineResult(
        changed=True,
        transformed_spans=transformed_spans,
        matrix=values,
        wrapped_count=len(seen_ranges) + len(target_indices),
        message=f"Đã áp affine cho {len(obj_metas)} object trong một lần ghi stream.",
    )

def _cm_instruction(matrix: list[float]) -> pikepdf.ContentStreamInstruction:
    """
    Tạo instruction `cm` tổng quát từ ma trận affine 6 phần tử
    `[a, b, c, d, e, f]`. Khi đặt NGAY TRƯỚC dải operator của object (và đóng
    bằng `Q` ngay sau), object được vẽ với CTM = mult_matrix(matrix, CTM_hiện_tại).
    """
    if len(matrix) != 6:
        raise ValueError("Ma trận cm phải gồm đúng 6 phần tử [a, b, c, d, e, f]")
    return pikepdf.ContentStreamInstruction(
        [float(v) for v in matrix],
        pikepdf.Operator("cm"),
    )


def _anchor_point(bbox: list[float], anchor: str) -> tuple[float, float]:
    """
    Suy ra điểm neo CỐ ĐỊNH (tọa độ PDF, hệ gốc dưới-trái) từ bbox object.

    bbox = [x0, y0, x1, y1] (đã chuẩn hóa x0<=x1, y0<=y1). Quy ước góc:
      - nw = (x0, y1)   ne = (x1, y1)
      - sw = (x0, y0)   se = (x1, y0)

    `anchor` LÀ góc cố định (đối diện handle người dùng kéo). Ví dụ người dùng
    kéo handle 'se' thì điểm cố định là 'nw' — caller truyền anchor='nw'.
    """
    x0, y0, x1, y1 = bbox
    corners = {
        "nw": (x0, y1),
        "ne": (x1, y1),
        "sw": (x0, y0),
        "se": (x1, y0),
    }
    if anchor not in corners:
        raise ValueError(f"anchor không hợp lệ: {anchor!r} (chỉ 'nw'|'ne'|'sw'|'se')")
    return corners[anchor]


def _compose_resize_cm(sx: float, sy: float, ax: float, ay: float) -> list[float]:
    """
    Dựng ma trận `cm` cho phép scale quanh điểm neo cố định `(ax, ay)`:

        cm = T(anchor) · scale(sx, sy) · T(-anchor)

    Theo quy ước nhân ma trận hàng (`p·M`) của `mult_matrix` (m1 áp TRƯỚC m2):
        cm = mult_matrix( mult_matrix(T(-a), S), T(a) )
    nghĩa là điểm p được tịnh tiến về gốc neo, scale, rồi đưa trở lại — điểm
    neo `(ax, ay)` đứng yên còn mọi điểm khác giãn theo `(sx, sy)`.
    """
    t_neg = [1.0, 0.0, 0.0, 1.0, -ax, -ay]
    scale = [sx, 0.0, 0.0, sy, 0.0, 0.0]
    t_pos = [1.0, 0.0, 0.0, 1.0, ax, ay]
    return mult_matrix(mult_matrix(t_neg, scale), t_pos)


def resize_objects(
    page,
    obj_metas,
    sx: float,
    sy: float,
    anchor: str,
    pdf: pikepdf.Pdf,
) -> ResizeResult:
    """
    Thay đổi kích thước (scale) đúng tập object mục tiêu, GIỮ CỐ ĐỊNH góc neo,
    bằng cách BỌC CÔ LẬP `q/cm/Q` quanh `OpSpan` của từng object.

    Ma trận chèn cho mỗi object:
        cm = T(anchor) · scale(sx, sy) · T(-anchor)
    với `anchor` = điểm neo CỐ ĐỊNH (góc đối diện handle người dùng kéo). Quy ước
    handle → neo: kéo se→neo nw; ne→neo sw; sw→neo ne; nw→neo se. Tham số `anchor`
    của hàm này NHẬN TRỰC TIẾP góc cố định ('nw'|'ne'|'sw'|'se') — tức caller đã
    suy ra góc đối diện handle trước khi gọi.

    Điểm neo được tính từ `span.bbox` (tọa độ PDF, hệ gốc dưới-trái) của từng
    object, nên mỗi object scale quanh góc cố định CỦA CHÍNH NÓ. Việc bọc `q…Q`
    bảo đảm CTM/màu/clip của các operator khác không bị chạm (Yêu cầu 4.1, 4.2).

    TỪ CHỐI thao tác (raise `ValueError`) nếu `sx <= 0` hoặc `sy <= 0` vì sẽ làm
    chiều rộng/chiều cao kết quả ≤ 0 (Yêu cầu 6.5) — KHÔNG ghi gì. (Schema
    `ResizeScale` cũng chặn ở mức validator; đây là guard tầng engine.)

    Args:
        page:      trang pikepdf (`pikepdf.Page` hoặc object trang).
        obj_metas: danh sách `ObjMeta` (hoặc dict tương đương) cần resize.
        sx, sy:    hệ số tỉ lệ theo trục x / y (phải > 0).
        anchor:    góc cố định 'nw'|'ne'|'sw'|'se'.
        pdf:       document pikepdf chứa trang.

    Returns:
        `ResizeResult` mô tả thay đổi. Tập rỗng → `changed=False` (no-op).

    Raises:
        ValueError:     nếu sx/sy ≤ 0 (Yêu cầu 6.5) hoặc anchor không hợp lệ.
        ObjectMapError: nếu BẤT KỲ target nào không map được duy nhất sang một
                        `OpSpan` (Yêu cầu 4.7) → HỦY toàn bộ, KHÔNG ghi.
    """
    pg = _as_page(page)

    fsx = float(sx)
    fsy = float(sy)

    # ── Guard tầng engine: từ chối scale ≤ 0 (Yêu cầu 6.5) ──────────────────
    if fsx <= 0 or fsy <= 0:
        raise ValueError(
            f"Hệ số resize phải > 0 để kích thước kết quả > 0 (Yêu cầu 6.5); "
            f"nhận sx={fsx}, sy={fsy} — TỪ CHỐI, không ghi."
        )

    # Validate anchor sớm (trước mọi thao tác parse/ghi).
    if anchor not in ("nw", "ne", "sw", "se"):
        raise ValueError(f"anchor không hợp lệ: {anchor!r} (chỉ 'nw'|'ne'|'sw'|'se')")

    # ── Tập rỗng → no-op (đồng bộ hành vi delete/move) ──────────────────────
    if not obj_metas:
        return ResizeResult(
            changed=False,
            sx=fsx,
            sy=fsy,
            anchor=anchor,
            message="Không có object mục tiêu — không thay đổi.",
        )

    # Gộp content stream về MỘT lần để mọi index span/parse đồng bộ.
    try:
        contents_coalesce(pdf, pg)
    except Exception as exc:  # noqa: BLE001 - coalesce lỗi vẫn parse trực tiếp được
        logger.warning("contents_coalesce thất bại, tiếp tục parse trực tiếp: %s", exc)

    # ── Map từng target → OpSpan; bất kỳ None nào → HỦY (Yêu cầu 4.7) ───────
    # Gộp fill+stroke: 1 object vẽ nhiều lượt cùng path → nhiều span cùng bbox.
    # Anchor tính từ span.bbox nên các span cùng object có CÙNG điểm neo → resize
    # quanh cùng gốc, kết quả nhất quán. map_object_spans rỗng = HỦY (bảo toàn màu).
    spans: list[OpSpan] = []
    for meta in obj_metas:
        obj_spans = map_object_spans(pg, meta, pdf=pdf)
        if not obj_spans:
            meta_id = meta.get("id") if isinstance(meta, dict) else getattr(meta, "id", "?")
            raise ObjectMapError(
                f"Không thể ánh xạ object '{meta_id}' sang dải operator duy nhất "
                f"(đa nghĩa/clip/Form XObject/inline image). HỦY thao tác để bảo "
                f"toàn màu (Yêu cầu 4.7) — KHÔNG ghi kết quả."
            )
        spans.extend(obj_spans)

    # ── Parse lại một lần để khớp index với span đã map ─────────────────────
    instructions = parse_page_ops(pg)
    n = len(instructions)

    # Bọc theo thứ tự start GIẢM DẦN để không lệch index khi chèn nhiều span.
    ordered = sorted(spans, key=lambda s: s.start, reverse=True)
    for span in ordered:
        start = max(0, span.start)
        end = min(n, span.end)
        # Điểm neo cố định của CHÍNH object này (từ bbox PDF của span).
        ax, ay = _anchor_point(span.bbox, anchor)
        cm = _compose_resize_cm(fsx, fsy, ax, ay)
        # Chèn `Q` NGAY SAU span trước, rồi `q`+`cm` TRƯỚC span.
        instructions.insert(end, _Q_instruction())
        instructions.insert(start, _cm_instruction(cm))
        instructions.insert(start, _q_instruction())

    # ── Ghi lại content stream qua pikepdf (đường ghi DUY NHẤT) ─────────────
    new_bytes = pikepdf.unparse_content_stream(instructions)
    pg.obj[pikepdf.Name("/Contents")] = pdf.make_stream(new_bytes)

    return ResizeResult(
        changed=True,
        resized_spans=spans,
        sx=fsx,
        sy=fsy,
        anchor=anchor,
        wrapped_count=len(spans),
        message=(
            f"Đã resize {len(spans)} object (sx={fsx:.3f}, sy={fsy:.3f}, "
            f"anchor={anchor}); bọc cô lập q/cm/Q quanh mỗi span."
        ),
    )


def _bbox_center(bbox: list[float]) -> tuple[float, float]:
    """
    Tâm bbox c = ((x0+x1)/2, (y0+y1)/2) (tọa độ PDF, hệ gốc dưới-trái).

    bbox = [x0, y0, x1, y1] (đã chuẩn hóa x0<=x1, y0<=y1 bởi OpSpan).
    """
    x0, y0, x1, y1 = bbox
    return (x0 + x1) / 2.0, (y0 + y1) / 2.0


def _compose_rotate_cm(rotate_deg: float, cx: float, cy: float) -> list[float]:
    """
    Dựng ma trận `cm` cho phép xoay góc `rotate_deg` (ĐỘ) quanh tâm `(cx, cy)`:

        cm = T(c) · rot(θ) · T(-c)

    với θ = radian(rotate_deg) và:

        rot(θ) = [cosθ, sinθ, -sinθ, cosθ, 0, 0]

    Theo quy ước nhân ma trận hàng (`p·M`) của `mult_matrix` (m1 áp TRƯỚC m2):
        cm = mult_matrix( mult_matrix(T(-c), rot), T(c) )
    nghĩa là điểm p được tịnh tiến về gốc tâm, xoay, rồi đưa trở lại — tâm
    `(cx, cy)` đứng yên còn mọi điểm khác xoay quanh nó. Đây cũng là tiền đề cho
    Property 6 (rotate khả nghịch): xoay θ rồi −θ quanh CÙNG tâm trả về bbox cũ.
    """
    theta = math.radians(float(rotate_deg))
    cos_t = math.cos(theta)
    sin_t = math.sin(theta)
    t_neg = [1.0, 0.0, 0.0, 1.0, -cx, -cy]
    rot = [cos_t, sin_t, -sin_t, cos_t, 0.0, 0.0]
    t_pos = [1.0, 0.0, 0.0, 1.0, cx, cy]
    return mult_matrix(mult_matrix(t_neg, rot), t_pos)


def rotate_objects(
    page,
    obj_metas,
    rotate_deg: float,
    pdf: pikepdf.Pdf,
) -> RotateResult:
    """
    Xoay đúng tập object mục tiêu quanh TÂM bbox CỦA CHÍNH NÓ, bằng cách BỌC
    CÔ LẬP `q/cm/Q` quanh `OpSpan` của từng object.

    Ma trận chèn cho mỗi object:
        cm = T(c) · rot(θ) · T(-c)
    với `c` = tâm bbox của object (lấy từ `span.bbox`, hệ PDF gốc dưới-trái) và
    `θ` = radian(`rotate_deg`). Mỗi object xoay quanh tâm CỦA CHÍNH NÓ.

    Lưu ý về TEXT: design.md đề xuất "ưu tiên sửa `Tm`" cho text, nhưng cơ chế
    bọc cô lập `q <cm> … Q` hoạt động THỐNG NHẤT cho mọi loại object (text /
    image / vector). Root cause của bug image-transform đã được sửa ở
    `object_mapper` (span IMAGE bao trọn cụm `cm/q…Q` đặt ảnh), nên việc bọc
    `q/cm/Q` quanh span áp đúng ở page-space cho cả image. Vì vậy ở đây ta dùng
    CHUNG đường bọc `q/cm/Q` cho mọi loại để nhất quán; CHƯA sửa trực tiếp `Tm`
    của text (text-state vẫn đúng vì toàn cụm `BT…ET` nằm gọn trong span được
    bọc, và `q/Q` lưu/khôi phục graphics-state quanh nó).

    Việc bọc `q…Q` bảo đảm CTM/màu/clip của các operator khác không bị chạm
    (Yêu cầu 4.1, 4.2). Đường GHI DUY NHẤT qua pikepdf giữ nguyên các
    `Color_Operators` của `Untouched_Object`.

    CÙNG một `rotate_deg` được áp cho TẤT CẢ object trong `obj_metas`, mỗi object
    xoay quanh tâm riêng.

    Args:
        page:       trang pikepdf (`pikepdf.Page` hoặc object trang).
        obj_metas:  danh sách `ObjMeta` (hoặc dict tương đương) cần xoay.
        rotate_deg: góc xoay theo ĐỘ (dương = ngược chiều kim đồng hồ trong hệ
                    tọa độ PDF gốc dưới-trái).
        pdf:        document pikepdf chứa trang.

    Returns:
        `RotateResult` mô tả thay đổi. Tập rỗng → `changed=False` (no-op).

    Raises:
        ObjectMapError: nếu BẤT KỲ target nào không map được duy nhất sang một
                        `OpSpan` (Yêu cầu 4.7) → HỦY toàn bộ, KHÔNG ghi.
    """
    pg = _as_page(page)

    fdeg = float(rotate_deg)

    # ── Tập rỗng → no-op (đồng bộ hành vi delete/move/resize) ───────────────
    if not obj_metas:
        return RotateResult(
            changed=False,
            rotate_deg=fdeg,
            message="Không có object mục tiêu — không thay đổi.",
        )

    # Gộp content stream về MỘT lần để mọi index span/parse đồng bộ.
    try:
        contents_coalesce(pdf, pg)
    except Exception as exc:  # noqa: BLE001 - coalesce lỗi vẫn parse trực tiếp được
        logger.warning("contents_coalesce thất bại, tiếp tục parse trực tiếp: %s", exc)

    # ── Map target → edit; text xoay GRANULAR (chỉ run mục tiêu, KHÔNG cả cụm
    # BT…ET) bằng ghim Tm tuyệt đối; image/vector bọc q/cm/Q. None → HỦY (4.7).
    nontext_spans: list[OpSpan] = []
    text_rotations: list[dict] = []
    rotated_spans: list[OpSpan] = []
    for meta in obj_metas:
        meta_type = meta.get("type") if isinstance(meta, dict) else getattr(meta, "type", None)
        meta_id = meta.get("id") if isinstance(meta, dict) else getattr(meta, "id", "?")
        meta_bbox = meta.get("bbox") if isinstance(meta, dict) else getattr(meta, "bbox", None)
        if meta_type == "text":
            info = text_show_op_for_move(pg, meta, pdf=pdf)
            if info is None:
                raise ObjectMapError(
                    f"Không thể ánh xạ object '{meta_id}' sang một show-op text duy "
                    f"nhất. HỦY thao tác để bảo toàn (Yêu cầu 4.7) — KHÔNG ghi."
                )
            # Tâm xoay = tâm bbox PDFium của object (khớp ghost preview ở frontend).
            cx, cy = _bbox_center(list(meta_bbox)) if meta_bbox and len(meta_bbox) == 4 else (0.0, 0.0)
            info["cx"] = cx
            info["cy"] = cy
            text_rotations.append(info)
            ti = info["target_index"]
            rotated_spans.append(OpSpan(start=ti, end=ti + 1, kind="text",
                                        ctm=[1.0, 0.0, 0.0, 1.0, 0.0, 0.0], bbox=[0, 0, 0, 0],
                                        resource_name=None))
        else:
            # Gộp fill+stroke: 1 object vẽ nhiều lượt (cùng path) → nhiều span cùng
            # bbox, đều xoay quanh CÙNG tâm bbox. map_object_spans trả HẾT span đó;
            # rỗng = không map được duy nhất → HỦY (bảo toàn màu, Yêu cầu 4.7).
            obj_spans = map_object_spans(pg, meta, pdf=pdf)
            if not obj_spans:
                raise ObjectMapError(
                    f"Không thể ánh xạ object '{meta_id}' sang dải operator duy nhất "
                    f"(đa nghĩa/clip/Form XObject/inline image). HỦY thao tác để bảo "
                    f"toàn màu (Yêu cầu 4.7) — KHÔNG ghi kết quả."
                )
            nontext_spans.extend(obj_spans)
            rotated_spans.extend(obj_spans)

    # ── Parse lại một lần để khớp index với span/show-op đã map ─────────────
    instructions = parse_page_ops(pg)
    n = len(instructions)

    prefix: dict[int, list] = {}
    suffix: dict[int, list] = {}

    # image/vector: bọc q + cm(rotate quanh tâm bbox) TRƯỚC span, Q SAU span.
    for span in nontext_spans:
        start = max(0, span.start)
        end = min(n, span.end)
        cx, cy = _bbox_center(span.bbox)
        cm = _compose_rotate_cm(fdeg, cx, cy)
        prefix.setdefault(start, []).extend([_q_instruction(), _cm_instruction(cm)])
        suffix.setdefault(end - 1, []).append(_Q_instruction())

    # text: ghim mọi show-op trong cụm bằng Tm tuyệt đối; run mục tiêu xoay quanh
    # tâm bbox của nó (page-space) → các run khác trong cụm KHÔNG xê dịch.
    target_anchor: dict[int, tuple[float, float]] = {
        info["target_index"]: (info["cx"], info["cy"]) for info in text_rotations
    }
    cluster_show: dict[int, tuple[list[float], list[float]]] = {}
    for info in text_rotations:
        for so in info["cluster"]:
            cluster_show[so["index"]] = (so["tm"], so["ctm"])
    for idx, (tm_abs, ctm_abs) in cluster_show.items():
        if idx in target_anchor:
            cx, cy = target_anchor[idx]
            tm_use = _rotated_text_tm(tm_abs, ctm_abs, fdeg, cx, cy)
        else:
            tm_use = tm_abs
        prefix.setdefault(idx, []).append(_Tm_instruction(tm_use))

    # ── Dựng instruction list mới (chèn prefix/suffix quanh từng instr) ─────
    new_instructions: list = []
    for i, instr in enumerate(instructions):
        if i in prefix:
            new_instructions.extend(prefix[i])
        new_instructions.append(instr)
        if i in suffix:
            new_instructions.extend(suffix[i])

    # ── Ghi lại content stream qua pikepdf (đường ghi DUY NHẤT) ─────────────
    new_bytes = pikepdf.unparse_content_stream(new_instructions)
    pg.obj[pikepdf.Name("/Contents")] = pdf.make_stream(new_bytes)

    return RotateResult(
        changed=True,
        rotated_spans=rotated_spans,
        rotate_deg=fdeg,
        wrapped_count=len(rotated_spans),
        message=(
            f"Đã xoay {len(rotated_spans)} object (rotate_deg={fdeg:.3f}); text ghim "
            f"Tm tuyệt đối theo run, image/vector bọc q/cm/Q quanh tâm bbox."
        ),
    )


# ── Task 7.1: Sửa nội dung text (xóa + chèn lại, không reflow) ──────────────
#
# Chiến lược (color-safe, đường ghi DUY NHẤT qua pikepdf):
#   1. map_object → OpSpan (kind 'text'); None → ObjectMapError (Yêu cầu 4.7).
#   2. Trong span, xác định op show-text (`Tj/TJ/'/"`), `Tf` (font + cỡ).
#   3. Quyết định đường mã hóa:
#      - Nếu text mới THUẦN ASCII và font gốc là font SIMPLE (không phải Type0)
#        → GIỮ NGUYÊN `Tf`, mã hóa single-byte (latin-1). Không nhúng gì thêm.
#      - Ngược lại (có ký tự ngoài ASCII, hoặc font gốc là Type0/không tra được)
#        → nhúng font dự phòng DejaVuSans dưới dạng Type0/Identity-H (CID), đổi
#        `Tf` sang font mới (GIỮ cỡ chữ), mã hóa text thành chuỗi 2-byte glyph-id.
#   4. KIỂM GLYPH trước khi ghi: nếu font dự phòng thiếu glyph cho ký tự nào →
#      GlyphCoverageError, KHÔNG ghi (Yêu cầu 8.4 — không .notdef/ô vuông).
#   5. Thay op show-text cũ bằng MỘT op `Tj` mới tại đúng vị trí (`Tm/Td` giữ
#      nguyên) → KHÔNG reflow. Giữ mọi op khác trong span (màu, BT/ET, Tm…).
#   6. Ghi lại content stream qua `unparse_content_stream` + `make_stream`.


def _font_dict_for_name(pg: pikepdf.Page, font_name: str):
    """
    Tra cứu dict font theo tên resource trong `/Resources/Font/<font_name>`.
    Trả về `pikepdf.Object` (dict font) hoặc None nếu không tìm thấy.
    """
    try:
        resources = pg.obj.get("/Resources")
        if resources is None:
            return None
        fonts = resources.get("/Font")
        if fonts is None:
            return None
        key = pikepdf.Name("/" + font_name)
        if key not in fonts:
            return None
        return fonts[key]
    except Exception:  # noqa: BLE001 - resource lạ → coi như không tra được
        return None


def _font_subtype(pg: pikepdf.Page, font_name: str) -> str | None:
    """Trả `/Subtype` của font (vd. 'Type1' | 'TrueType' | 'Type0') hoặc None."""
    fd = _font_dict_for_name(pg, font_name)
    if fd is None:
        return None
    try:
        sub = fd.get("/Subtype")
        if sub is None:
            return None
        s = str(sub)
        return s[1:] if s.startswith("/") else s
    except Exception:  # noqa: BLE001
        return None


def _ensure_font_resource(pg: pikepdf.Page, font_obj, base_name: str) -> str:
    """
    Đăng ký `font_obj` vào `/Resources/Font` của trang với một tên DUY NHẤT
    (không trùng tên đã có). Trả về tên resource (không gồm dấu '/').
    """
    resources = pg.obj.get("/Resources")
    if resources is None:
        resources = pikepdf.Dictionary()
        pg.obj[pikepdf.Name("/Resources")] = resources
    fonts = resources.get("/Font")
    if fonts is None:
        fonts = pikepdf.Dictionary()
        resources[pikepdf.Name("/Font")] = fonts

    # Sinh tên duy nhất: base_name, base_name1, base_name2, …
    name = base_name
    suffix = 0
    while pikepdf.Name("/" + name) in fonts:
        suffix += 1
        name = f"{base_name}{suffix}"
    fonts[pikepdf.Name("/" + name)] = font_obj
    return name


def _subset_font_bytes(font_path: str, codepoints) -> bytes | None:
    """
    Tạo font TrueType SUBSET chỉ chứa các glyph cho `codepoints` (+ `.notdef`)
    bằng `fontTools.subset`, trả về bytes font subset (nhỏ hơn nhiều so với font
    đầy đủ ~700KB). Trả None nếu `fontTools` không khả dụng / subset thất bại
    (caller sẽ fallback nhúng TOÀN BỘ font — không làm hỏng chức năng).

    Lưu ý map glyph-id: subsetting ĐỔI glyph-id (renumber compact). Vì vậy
    caller PHẢI đọc lại cmap TỪ font subset (codepoint → gid MỚI) để mã hóa Tj
    cho khớp đúng glyph trong FontFile2 đã nhúng. `_embed_cid_font` đảm nhận việc
    này: nó parse chính bytes subset để lấy `char_to_glyph` mới.
    """
    cps = {int(c) for c in codepoints if c is not None}
    if not cps:
        return None
    try:
        import io as _io

        from fontTools import subset as _ftsubset
        from fontTools.ttLib import TTFont as _TTFont

        options = _ftsubset.Options()
        # Giữ outline .notdef + không ghi timestamp (bytes ổn định, dễ kiểm thử).
        options.notdef_outline = True
        options.recalc_timestamp = False
        # Không cần layout/hinting nâng cao cho text chèn đơn giản.
        options.layout_features = []
        options.hinting = False

        # Font collection (.ttc/.otc) cần chỉ định fontNumber; lấy face đầu (0).
        _ext = os.path.splitext(font_path)[1].lower()
        if _ext in (".ttc", ".otc"):
            font = _TTFont(font_path, fontNumber=0)
        else:
            font = _TTFont(font_path)
        subsetter = _ftsubset.Subsetter(options=options)
        subsetter.populate(unicodes=sorted(cps))
        subsetter.subset(font)

        buf = _io.BytesIO()
        font.save(buf)
        font.close()
        return buf.getvalue()
    except Exception as exc:  # noqa: BLE001 - subset best-effort → fallback full
        logger.warning("Subset font thất bại, sẽ nhúng toàn bộ font: %s", exc)
        return None


def _embed_cid_font(pdf: pikepdf.Pdf, font_path: str, subset_codepoints=None):
    """
    Nhúng một font TrueType (vd. DejaVuSans) vào `pdf` dưới dạng font composite
    Type0 / Identity-H (CIDFontType2) — đủ để hiển thị ký tự tiếng Việt.

    Dùng parser TrueType của reportlab (đã là dependency) để đọc cmap
    (codepoint → glyph-id) và metric (đã scale về em-1000). `CIDToGIDMap =
    Identity` (CID = GID), nên glyph-id lấy trực tiếp từ cmap là dùng được.

    SUBSET (giảm dung lượng): nếu `subset_codepoints` được cung cấp và
    `fontTools` khả dụng → chỉ nhúng các glyph THỰC SỰ DÙNG (FontFile2 nhỏ hơn
    nhiều so với ~700KB của DejaVuSans đầy đủ). Vì subsetting ĐỔI glyph-id, ta
    PARSE CHÍNH bytes subset (qua reportlab `TTFontFile` đọc từ BytesIO) để lấy
    `char_to_glyph` MỚI → glyph-id dùng trong content stream luôn khớp font đã
    nhúng. Nếu subset thất bại/không khả dụng → nhúng TOÀN BỘ font như cũ.

    Returns:
        tuple `(font_obj, char_to_glyph, char_widths)`:
          - `font_obj`      : dict font Type0 (indirect) để đăng ký vào Resources.
          - `char_to_glyph` : dict {codepoint: glyph_id} (theo font ĐÃ nhúng).
          - `char_widths`   : dict {codepoint: width(em-1000)} dùng dựng mảng W.
    """
    # Import cục bộ để không ràng buộc khi import module (và tránh circular).
    import io as _io

    from reportlab.pdfbase.ttfonts import TTFontFile

    ttf = None
    raw: bytes | None = None
    if subset_codepoints:
        sub = _subset_font_bytes(font_path, subset_codepoints)
        if sub is not None:
            try:
                # Parse font SUBSET từ bytes (cmap/metric phản ánh glyph-id MỚI).
                ttf = TTFontFile(_io.BytesIO(sub))
                raw = sub
            except Exception as exc:  # noqa: BLE001 - subset không parse được
                # Vd. subset rỗng (codepoint không có trong font) → reportlab
                # không tìm được cmap. Fallback nhúng TOÀN BỘ để kiểm coverage
                # đúng (thiếu glyph → GlyphCoverageError ở caller).
                logger.warning(
                    "Parse font subset thất bại, nhúng toàn bộ font: %s", exc
                )
                ttf = None
                raw = None

    if ttf is None:
        # Đường cũ: nhúng toàn bộ file font.
        ttf = TTFontFile(font_path)
        with open(font_path, "rb") as fh:
            raw = fh.read()

    base = ttf.name or "FallbackFont"
    if isinstance(base, bytes):
        base = base.decode("latin-1", "ignore")
    # Tên PostScript hợp lệ cho /BaseFont (loại bỏ ký tự khoảng trắng).
    base = base.replace(" ", "")

    fontfile = pdf.make_stream(raw)
    fontfile[pikepdf.Name("/Length1")] = len(raw)

    descriptor = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name("/FontDescriptor"),
            FontName=pikepdf.Name("/" + base),
            Flags=int(ttf.flags) if getattr(ttf, "flags", None) else 4,
            FontBBox=[int(round(v)) for v in ttf.bbox],
            ItalicAngle=int(round(ttf.italicAngle)),
            Ascent=int(round(ttf.ascent)),
            Descent=int(round(ttf.descent)),
            CapHeight=int(round(ttf.capHeight)) if ttf.capHeight else int(round(ttf.ascent)),
            StemV=int(round(ttf.stemV)) if getattr(ttf, "stemV", None) else 80,
            FontFile2=fontfile,
        )
    )

    char_to_glyph = dict(ttf.charToGlyph)
    char_widths = dict(ttf.charWidths)

    cid_font = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name("/Font"),
            Subtype=pikepdf.Name("/CIDFontType2"),
            BaseFont=pikepdf.Name("/" + base),
            CIDSystemInfo=pikepdf.Dictionary(
                Registry=pikepdf.String("Adobe"),
                Ordering=pikepdf.String("Identity"),
                Supplement=0,
            ),
            FontDescriptor=descriptor,
            CIDToGIDMap=pikepdf.Name("/Identity"),
            DW=int(round(ttf.defaultWidth)) if getattr(ttf, "defaultWidth", None) else 1000,
        )
    )

    font_obj = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name("/Font"),
            Subtype=pikepdf.Name("/Type0"),
            BaseFont=pikepdf.Name("/" + base),
            Encoding=pikepdf.Name("/Identity-H"),
            DescendantFonts=pikepdf.Array([cid_font]),
        )
    )
    # Giữ tham chiếu cid_font để dựng W sau khi biết glyph dùng (caller set W).
    font_obj._cid_font = cid_font  # type: ignore[attr-defined]
    return font_obj, char_to_glyph, char_widths


def _make_shaped_show(pdf: pikepdf.Pdf, page, font_path: str, text: str):
    """
    SHAPING chữ phức tạp (Arabic/Thai/Indic…): dùng HarfBuzz chọn dạng glyph theo
    ngữ cảnh, nhúng FONT ĐẦY ĐỦ (Type0/Identity-H, CID=GID — để mọi glyph shaped
    đều có), đặt `/W` theo advance HarfBuzz, và trả op show-text Tj theo chuỗi GID
    đã shape.

    Returns `(new_tf_name, show_instr)` hoặc None nếu shaping không khả dụng/thất
    bại (caller fallback về đường mã hóa theo codepoint).
    """
    glyphs = shape_text(font_path, text)
    if not glyphs:
        return None
    try:
        # Nhúng FULL font (subset_codepoints=None) → CID=GID khớp GID shaped.
        font_obj, _c2g, _cw = _embed_cid_font(pdf, font_path, subset_codepoints=None)
        gid_bytes = bytearray()
        widths: dict[int, float] = {}
        for g in glyphs:
            gid = int(g["gid"])
            if gid == 0:
                # gid 0 = .notdef → font thiếu glyph cho script này → fallback an toàn.
                return None
            gid_bytes += struct.pack(">H", gid)
            widths[gid] = float(g["x_advance"]) * 1000.0  # em → em-1000 (đơn vị /W)
        _set_cid_widths(font_obj._cid_font, widths)  # type: ignore[attr-defined]
        new_tf_name = _ensure_font_resource(page, font_obj, "FShape")
        show_instr = pikepdf.ContentStreamInstruction(
            [pikepdf.String(bytes(gid_bytes))], pikepdf.Operator("Tj")
        )
        return new_tf_name, show_instr
    except Exception as exc:  # noqa: BLE001 - shaping embed lỗi → fallback
        logger.warning("Nhúng glyph shaped thất bại, fallback codepoint: %s", exc)
        return None


def _set_cid_widths(cid_font, used_gid_widths: dict[int, float]) -> None:
    """
    Gán mảng `/W` cho CIDFontType2 từ {glyph_id: width(em-1000)} của các glyph
    thực sự dùng. Định dạng: `[ gid [w] gid2 [w2] … ]` (mỗi glyph một mục).
    """
    if not used_gid_widths:
        return
    w_array = pikepdf.Array()
    for gid in sorted(used_gid_widths):
        w_array.append(int(gid))
        w_array.append(pikepdf.Array([int(round(used_gid_widths[gid]))]))
    cid_font[pikepdf.Name("/W")] = w_array


def _set_to_unicode(font_obj, pdf: pikepdf.Pdf, gid_to_unicode: dict[int, str]) -> None:
    """
    Gắn CMap `/ToUnicode` cho font Type0 để text vẫn TRÍCH XUẤT / TÌM KIẾM được
    sau khi mã hóa Identity-H (CID = GID). Map mỗi glyph-id (2-byte) → codepoint
    Unicode tương ứng của ký tự đã chèn.
    """
    if not gid_to_unicode:
        return
    lines = [
        "/CIDInit /ProcSet findresource begin",
        "12 dict begin",
        "begincmap",
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
        "/CMapName /Adobe-Identity-UCS def",
        "/CMapType 2 def",
        "1 begincodespacerange",
        "<0000> <FFFF>",
        "endcodespacerange",
    ]
    items = sorted(gid_to_unicode.items())
    # beginbfchar chỉ cho phép tối đa 100 mục mỗi khối.
    for i in range(0, len(items), 100):
        chunk = items[i : i + 100]
        lines.append(f"{len(chunk)} beginbfchar")
        for gid, ch in chunk:
            uni_hex = "".join(f"{ord(c):04X}" for c in ch)
            lines.append(f"<{gid:04X}> <{uni_hex}>")
        lines.append("endbfchar")
    lines += [
        "endcmap",
        "CMapName currentdict /CMap defineresource pop",
        "end",
        "end",
    ]
    cmap_bytes = ("\n".join(lines) + "\n").encode("latin-1")
    font_obj[pikepdf.Name("/ToUnicode")] = pdf.make_stream(cmap_bytes)


def _is_pure_ascii_printable(text: str) -> bool:
    """True nếu mọi ký tự nằm trong ASCII in được (0x20..0x7E)."""
    return all(0x20 <= ord(c) <= 0x7E for c in text)


def _name_value(obj) -> str | None:
    """
    Chuẩn hóa một `pikepdf.Name` (hoặc giá trị tên) về chuỗi dạng '/Xxx'. Trả
    None nếu `obj` là None hoặc KHÔNG phải tên đơn (vd. Dictionary/Array).
    """
    if obj is None:
        return None
    if isinstance(obj, (pikepdf.Dictionary, pikepdf.Array, pikepdf.Stream)):
        return None
    try:
        s = str(obj)
    except Exception:  # noqa: BLE001
        return None
    if not s.startswith("/"):
        return None
    return s


def _read_truetype_cmap(font_bytes: bytes) -> dict | None:
    """
    Đọc cmap (codepoint → glyph_id) từ bytes một font TrueType embedded, dùng
    reportlab `TTFontFile` (đọc trực tiếp từ BytesIO). Trả về dict hoặc None nếu
    không parse được (font lạ / không phải TrueType) → caller coi như KHÔNG kiểm
    chắc chắn được coverage và sẽ fallback.
    """
    try:
        import io as _io

        from reportlab.pdfbase.ttfonts import TTFontFile

        ttf = TTFontFile(_io.BytesIO(font_bytes))
        cmap = dict(ttf.charToGlyph)
        return cmap or None
    except Exception:  # noqa: BLE001 - font embedded lạ → không kiểm được
        return None


# Map codepoint Unicode → mã đơn-byte theo WinAnsiEncoding (xấp xỉ cp1252). Dùng
# để mã hóa lại text cho font SIMPLE embedded mà encoding là WinAnsi.
def _winansi_unicode_to_code() -> dict[int, int]:
    mapping: dict[int, int] = {}
    for code in range(0x20, 0x100):
        try:
            ch = bytes([code]).decode("cp1252")
        except Exception:  # noqa: BLE001 - vài byte cp1252 không định nghĩa
            continue
        mapping[ord(ch)] = code
    return mapping


def _encode_with_original_font(
    pg: pikepdf.Page,
    font_name: str,
    font_subtype: str | None,
    new_text: str,
):
    """
    Thử mã hóa `new_text` BẰNG CHÍNH font gốc của cụm — chỉ khi AN TOÀN (đủ glyph
    cho TẤT CẢ codepoint + encoding xác định chắc chắn). Trả về `bytes` show-string
    (để dựng op `Tj`, GIỮ NGUYÊN `Tf`) nếu giữ được font gốc; ngược lại trả None
    để caller fallback nhúng DejaVuSans.

    AN TOÀN là trên hết — thà fallback còn hơn ghi `.notdef`/sai glyph. Các nhánh
    được CHẤP NHẬN giữ font gốc:

      1. Font SIMPLE (≠ Type0) + text thuần ASCII in được → mã hóa single-byte
         latin-1. (Giữ hành vi cũ; không cần đọc font — ASCII là tập con an toàn
         của Standard/WinAnsi/MacRoman.)
      2. Font SIMPLE TrueType EMBEDDED (FontFile2) + Encoding = WinAnsiEncoding
         (KHÔNG có /Differences) → với MỖI codepoint: tra mã đơn-byte WinAnsi VÀ
         xác nhận có glyph trong cmap; đủ thì mã hóa single-byte.
      3. Font Type0 + Encoding Identity-H/Identity-V + DescendantFont
         CIDToGIDMap = Identity + FontFile2 (CIDFontType2) → mọi codepoint có
         glyph trong cmap → mã hóa 2-byte CID (= GID).

    GIỚI HẠN ĐÃ BIẾT: rất nhiều PDF in dùng font SUBSET (chỉ chứa glyph đã in)
    nên cmap thường THIẾU glyph cho ký tự mới → hàm trả None → fallback. Ta CHỈ
    giữ font gốc khi chắc chắn đủ glyph + encoding xác định; mọi nghi ngờ
    (không embedded, encoding lạ/có Differences, Type0 CMap không Identity,
    FontFile1/3 không đọc được cmap) đều trả None.
    """
    if font_subtype is None:
        return None

    is_simple = font_subtype != "Type0"

    # ── (1) Simple + ASCII → giữ nguyên, single-byte latin-1 (đường cũ) ─────
    if is_simple and _is_pure_ascii_printable(new_text):
        return new_text.encode("latin-1")

    fd = _font_dict_for_name(pg, font_name)
    if fd is None:
        return None

    try:
        if is_simple:
            # ── (2) Simple TrueType embedded + WinAnsiEncoding ──────────────
            encoding = fd.get("/Encoding")
            # /Differences hoặc encoding lạ → KHÔNG chắc chắn → fallback.
            if _name_value(encoding) != "/WinAnsiEncoding":
                return None
            descriptor = fd.get("/FontDescriptor")
            if descriptor is None:
                return None
            fontfile2 = descriptor.get("/FontFile2")
            if fontfile2 is None:
                return None  # FontFile/FontFile3 (Type1/CFF) → không đọc cmap chắc
            cmap = _read_truetype_cmap(bytes(fontfile2.read_bytes()))
            if not cmap:
                return None
            code_map = _winansi_unicode_to_code()
            out = bytearray()
            for ch in new_text:
                cp = ord(ch)
                code = code_map.get(cp)
                if code is None or cp not in cmap:
                    return None  # thiếu mã/encoding hoặc thiếu glyph → fallback
                out.append(code)
            return bytes(out)

        # ── (3) Type0 Identity-H + CIDToGIDMap Identity + FontFile2 ─────────
        if _name_value(fd.get("/Encoding")) not in ("/Identity-H", "/Identity-V"):
            return None
        descendants = fd.get("/DescendantFonts")
        if descendants is None or len(descendants) < 1:
            return None
        cid_font = descendants[0]
        if _name_value(cid_font.get("/CIDToGIDMap")) != "/Identity":
            return None  # CIDToGIDMap stream/khác Identity → CID≠GID, không chắc
        descriptor = cid_font.get("/FontDescriptor")
        if descriptor is None:
            return None
        fontfile2 = descriptor.get("/FontFile2")
        if fontfile2 is None:
            return None
        cmap = _read_truetype_cmap(bytes(fontfile2.read_bytes()))
        if not cmap:
            return None
        out = bytearray()
        for ch in new_text:
            cp = ord(ch)
            gid = cmap.get(cp)
            if gid is None:
                return None  # subset thiếu glyph → fallback (AN TOÀN)
            out += struct.pack(">H", gid)
        return bytes(out)
    except Exception:  # noqa: BLE001 - bất kỳ bất thường nào → fallback an toàn
        return None


def edit_text(
    page,
    obj_meta,
    new_text: str,
    pdf: pikepdf.Pdf,
    fallback_font_path: str = DEFAULT_FALLBACK_FONT_PATH,
    chosen_font_path: str | None = None,
) -> EditTextResult:
    """
    Sửa nội dung MỘT cụm text (xóa cụm cũ + chèn lại nội dung mới), GIỮ NGUYÊN
    font / cỡ chữ / vị trí (`Tf` + `Tm`/`Td`) — KHÔNG reflow đoạn (Yêu cầu 8.1, 8.2).

    Quy tắc font (Yêu cầu 8.3, 8.4) — MỤC TIÊU GIỮ FONT GỐC khi AN TOÀN:
      - GIỮ font gốc (`Tf` không đổi) nếu font gốc đủ glyph cho TẤT CẢ codepoint
        của `new_text` VÀ encoding xác định chắc chắn:
          * font simple + text ASCII → single-byte latin-1;
          * font simple TrueType EMBEDDED + WinAnsiEncoding (không Differences)
            → single-byte WinAnsi nếu đủ glyph;
          * font Type0 Identity-H + CIDToGIDMap=Identity + FontFile2 → 2-byte CID
            (= GID) nếu đủ glyph.
      - Ngược lại (font subset thiếu glyph, không embedded, encoding lạ, Type0
        CMap không Identity…) → nhúng font dự phòng DejaVuSans (Type0/Identity-H,
        SUBSET theo codepoint thực dùng để nhẹ file), đổi `Tf` sang font mới
        (GIỮ cỡ), mã hóa thành chuỗi 2-byte glyph-id.
      - Nếu CẢ font gốc lẫn font dự phòng đều thiếu glyph → `GlyphCoverageError`,
        KHÔNG ghi (không .notdef/ô vuông).

    GIỚI HẠN: nhiều PDF in dùng font SUBSET (chỉ chứa glyph đã in) → thường
    thiếu glyph cho ký tự mới nên vẫn fallback; CHỈ giữ font gốc khi chắc chắn
    đủ glyph (AN TOÀN trên hết — thà fallback còn hơn ghi sai glyph).

    Đường GHI DUY NHẤT qua pikepdf giữ nguyên `Color_Operators` của
    `Untouched_Object` (Yêu cầu 4.1, 8.6) — ta chỉ thay op show-text trong span
    mục tiêu, không đụng op ngoài span.

    Args:
        page:               trang pikepdf (`pikepdf.Page` hoặc object trang).
        obj_meta:           `ObjMeta` (hoặc dict) của cụm text cần sửa.
        new_text:           nội dung text mới.
        pdf:                document pikepdf chứa trang.
        fallback_font_path: đường dẫn font dự phòng (mặc định DejaVuSans assets).

    Returns:
        `EditTextResult` mô tả thay đổi.

    Raises:
        ObjectMapError:     obj_meta không map được duy nhất sang OpSpan (4.7).
        ValueError:         obj_meta không phải cụm text, hoặc span không có
                            op show-text để sửa.
        GlyphCoverageError: thiếu glyph cho text mới và không có font đủ glyph (8.4).
    """
    pg = _as_page(page)

    # Gộp content stream để index span/parse đồng bộ.
    try:
        contents_coalesce(pdf, pg)
    except Exception as exc:  # noqa: BLE001
        logger.warning("contents_coalesce thất bại, tiếp tục parse trực tiếp: %s", exc)

    # ── Map target → ĐÚNG MỘT show-op text (granular); None → HỦY (4.7) ─────
    # KHÁC trước: KHÔNG dùng span cả cụm BT…ET (gây gộp/xoá các run khác khi sửa
    # 1 chữ). Dùng `text_show_op_for_move` để lấy ĐÚNG show-op mục tiêu + danh
    # sách show-op cùng cụm (để ghim Tm tuyệt đối, tránh xê dịch khi đổi bề rộng).
    info = text_show_op_for_move(pg, obj_meta, pdf=pdf)
    if info is None:
        meta_id = obj_meta.get("id") if isinstance(obj_meta, dict) else getattr(obj_meta, "id", "?")
        raise ObjectMapError(
            f"Không thể ánh xạ object '{meta_id}' sang một show-op text duy nhất "
            f"(đa nghĩa/clip/Form XObject). HỦY thao tác để bảo toàn (Yêu cầu 4.7)."
        )
    target_index = info["target_index"]
    cluster = info["cluster"]  # [{index, tm, ctm}]

    instructions = parse_page_ops(pg)
    n = len(instructions)
    if not (0 <= target_index < n):
        raise ValueError("Show-op text mục tiêu ngoài phạm vi — HỦY thao tác.")

    # ── Font đang hoạt động TẠI show-op mục tiêu: Tf gần nhất có index < target ─
    # (text-state `Tf` bền qua BT/ET nên quét ngược toàn bộ tới khi gặp Tf đầu).
    active_tf_index: int | None = None
    for j in range(target_index - 1, -1, -1):
        if str(instructions[j].operator) == "Tf":
            active_tf_index = j
            break

    orig_font_name: str | None = None
    font_size = 0.0
    if active_tf_index is not None:
        tf_operands = list(instructions[active_tf_index].operands)
        if tf_operands:
            orig_font_name = _name_str(tf_operands[0])
        if len(tf_operands) >= 2:
            sz = _as_float(tf_operands[-1])
            if sz is not None:
                font_size = float(sz)
    orig_size = font_size

    orig_subtype = _font_subtype(pg, orig_font_name) if orig_font_name else None

    # Font NHÚNG: nếu người dùng CHỌN font (chosen_font_path hợp lệ) → ƯU TIÊN dùng
    # font đó (bỏ giữ-font-gốc), nhúng full + subset codepoint. Ngược lại dùng font
    # dự phòng DejaVuSans. Cho phép kiểm soát kiểu chữ đầu ra (vd. file font subset
    # gốc thiếu glyph nên không giữ được — người dùng chọn font thay thế gần giống).
    embed_path = fallback_font_path
    force_embed = False
    if chosen_font_path and os.path.exists(chosen_font_path):
        embed_path = chosen_font_path
        force_embed = True

    # ── Quyết định đường mã hóa ─────────────────────────────────────────────
    kept_bytes: bytes | None = None
    if not force_embed and orig_font_name and orig_subtype is not None:
        kept_bytes = _encode_with_original_font(
            pg, orig_font_name, orig_subtype, new_text
        )
    keep_original = kept_bytes is not None

    new_show_instr: pikepdf.ContentStreamInstruction
    new_tf_name: str | None = None  # nếu set → cần đổi font name trong Tf
    used_fallback = False
    font_resource = orig_font_name or ""

    if keep_original:
        # Giữ nguyên font gốc + `Tf`; mã hóa theo encoding gốc (single-byte cho
        # simple latin/WinAnsi; 2-byte CID cho Type0 Identity-H).
        new_show_instr = pikepdf.ContentStreamInstruction(
            [pikepdf.String(kept_bytes)], pikepdf.Operator("Tj")
        )
    else:
        # Giữ cỡ chữ cũ; nếu không xác định được, dùng sizePt từ payload/12.
        if font_size <= 0:
            font_size = 12.0
        # CHỮ PHỨC TẠP (Arabic/Thai/Indic…): shape bằng HarfBuzz → nhúng glyph
        # shaped (dạng ngữ cảnh ĐÚNG). Chỉ khi cần; Latin/CJK/Việt đi đường codepoint.
        shaped = None
        if needs_shaping(new_text) and os.path.exists(embed_path):
            shaped = _make_shaped_show(pdf, pg, embed_path, new_text)
        if shaped is not None:
            new_tf_name, new_show_instr = shaped
            font_resource = new_tf_name
            used_fallback = True
        else:
            # Nhúng/đổi sang font ĐÃ CHỌN (hoặc dự phòng DejaVuSans nếu không chọn),
            # Type0/Identity-H, SUBSET theo các codepoint thực dùng để giảm dung lượng.
            if not os.path.exists(embed_path):
                raise GlyphCoverageError(
                    f"Không có file font tại '{embed_path}' để nhúng — HỦY thao tác "
                    f"(Yêu cầu 8.4), KHÔNG ghi."
                )
            font_obj, char_to_glyph, char_widths = _embed_cid_font(
                pdf, embed_path, subset_codepoints={ord(c) for c in new_text}
            )

            # KIỂM GLYPH trước khi ghi (Yêu cầu 8.4).
            missing = sorted({c for c in new_text if ord(c) not in char_to_glyph})
            if missing:
                preview = "".join(missing[:10])
                raise GlyphCoverageError(
                    f"Font nhúng thiếu glyph cho ký tự: {preview!r} — HỦY thao tác "
                    f"(Yêu cầu 8.4), KHÔNG ghi .notdef/ô vuông. Hãy chọn font khác."
                )

            # Mã hóa text → chuỗi 2-byte glyph-id (Identity-H, CID = GID).
            used_gid_widths: dict[int, float] = {}
            gid_to_unicode: dict[int, str] = {}
            gid_bytes = bytearray()
            for c in new_text:
                cp = ord(c)
                gid = char_to_glyph[cp]
                gid_bytes += struct.pack(">H", gid)
                if cp in char_widths:
                    used_gid_widths[gid] = char_widths[cp]
                gid_to_unicode[gid] = c
            _set_cid_widths(font_obj._cid_font, used_gid_widths)  # type: ignore[attr-defined]
            _set_to_unicode(font_obj, pdf, gid_to_unicode)

            new_tf_name = _ensure_font_resource(pg, font_obj, "FEdit")
            font_resource = new_tf_name
            used_fallback = True

            new_show_instr = pikepdf.ContentStreamInstruction(
                [pikepdf.String(bytes(gid_bytes))], pikepdf.Operator("Tj")
            )

    # ── Dựng instruction list MỚI: GHIM Tm tuyệt đối mọi show-op trong cụm để
    # không xê dịch khi đổi bề rộng text; CHỈ thay nội dung show-op MỤC TIÊU,
    # GIỮ NGUYÊN các run khác (KHÔNG gộp/xoá cụm). ──────────────────────────
    cluster_tm: dict[int, list[float]] = {c["index"]: c["tm"] for c in cluster}
    new_instructions: list = []
    for i, instr in enumerate(instructions):
        # Ghim vị trí tuyệt đối cho mọi show-op trong cụm (gồm cả mục tiêu).
        if i in cluster_tm:
            new_instructions.append(_Tm_instruction(cluster_tm[i]))
        if i == target_index:
            # Fallback đổi font → đặt Tf mới NGAY TRƯỚC show-op mục tiêu, rồi
            # KHÔI PHỤC font gốc NGAY SAU để các run kế tiếp không bị đổi font.
            if new_tf_name is not None:
                new_instructions.append(pikepdf.ContentStreamInstruction(
                    [pikepdf.Name("/" + new_tf_name), font_size], pikepdf.Operator("Tf")))
            new_instructions.append(new_show_instr)
            if new_tf_name is not None and orig_font_name:
                new_instructions.append(pikepdf.ContentStreamInstruction(
                    [pikepdf.Name("/" + orig_font_name), orig_size if orig_size > 0 else font_size],
                    pikepdf.Operator("Tf")))
            continue
        new_instructions.append(instr)

    new_bytes = pikepdf.unparse_content_stream(new_instructions)
    pg.obj[pikepdf.Name("/Contents")] = pdf.make_stream(new_bytes)

    span = OpSpan(start=target_index, end=target_index + 1, kind="text",
                  ctm=[1.0, 0.0, 0.0, 1.0, 0.0, 0.0], bbox=[0, 0, 0, 0], resource_name=None)
    return EditTextResult(
        changed=True,
        span=span,
        new_text=new_text,
        used_fallback=used_fallback,
        font_resource=font_resource,
        font_size=font_size,
        removed_show_ops=1,
        message=(
            f"Đã sửa text thành {new_text!r} "
            f"({'font đã nhúng' if used_fallback else 'giữ font gốc'}, "
            f"resource='{font_resource}', size={font_size:.2f}); "
            f"granular 1 show-op, ghim Tm, không gộp cụm."
        ),
    )


# ── Task 7.2: Thêm object mới (text / image) — CHỈ BỔ SUNG, color-safe ──────
#
# Chiến lược (đường ghi DUY NHẤT qua pikepdf, Yêu cầu 9.1/9.2/9.3/9.4/4.1):
#   - CHỈ append op MỚI vào CUỐI content stream, bọc cô lập trong `q … Q` để
#     KHÔNG đụng graphics-state (CTM/màu/clip) của object cũ → Color_Operators
#     của Untouched_Object giữ nguyên (Yêu cầu 9.4, 4.2).
#   - Text  : `q [màu] BT /Font size Tf <Tm đặt baseline> (text) Tj ET Q`.
#             ASCII thuần → đăng ký font chuẩn Helvetica (Type1), mã hóa
#             single-byte. Ngược lại → nhúng DejaVuSans (Type0/Identity-H) tái
#             dùng helpers task 7.1, mã hóa 2-byte glyph-id; thiếu glyph →
#             GlyphCoverageError (Yêu cầu 9.3, như 8.4).
#   - Image : đăng ký XObject ảnh vào `/Resources/XObject`, chèn
#             `q w 0 0 h x y cm /Name Do Q` tại bbox (Yêu cầu 9.2).
#   - Tọa độ bbox theo hệ PDF bottom-left, nhất quán các hàm transform.


def _fill_color_instructions(color) -> list:
    """
    Dựng op màu TÔ (fill) cho text mới theo số thành phần của `color`:
      - None       → đen mặc định `0 0 0 rg`.
      - len 1       → gray `g`.
      - len 3       → RGB `rg`.
      - len 4       → CMYK `k` (an toàn cho in — giữ kênh mực).

    Op màu được đặt TRONG khối `q … Q` cô lập nên không ảnh hưởng object khác.
    """
    if color is None:
        vals = [0.0, 0.0, 0.0]
        op = "rg"
    else:
        vals = [float(c) for c in color]
        if len(vals) == 1:
            op = "g"
        elif len(vals) == 3:
            op = "rg"
        elif len(vals) == 4:
            op = "k"
        else:
            raise ValueError(
                "color phải có 1 (gray), 3 (rgb) hoặc 4 (cmyk) thành phần"
            )
    return [pikepdf.ContentStreamInstruction(vals, pikepdf.Operator(op))]


def add_text(
    page,
    text: str,
    bbox,
    pdf: pikepdf.Pdf,
    font_size: float = 12.0,
    color=None,
    fallback_font_path: str = DEFAULT_FALLBACK_FONT_PATH,
    chosen_font_path: str | None = None,
) -> AddResult:
    """
    Thêm MỘT cụm text mới tại `bbox` (hệ PDF bottom-left) — CHỈ BỔ SUNG, không
    sửa object cũ (Yêu cầu 9.1, 9.4).

    Baseline của text đặt tại góc dưới-trái `(x0, y0)` của `bbox`. Toàn bộ cụm
    được bọc cô lập `q … Q` và APPEND vào CUỐI content stream nên không đụng op
    hiện có → Color_Operators của Untouched_Object giữ nguyên (Yêu cầu 4.1, 4.2).

    Quy tắc font (Yêu cầu 9.3, như 8.4):
      - Text thuần ASCII in được → đăng ký font chuẩn Helvetica (Type1,
        WinAnsiEncoding), mã hóa single-byte (latin-1).
      - Có ký tự ngoài ASCII (vd. tiếng Việt có dấu) → nhúng font dự phòng
        DejaVuSans (Type0/Identity-H) tái dùng `_embed_cid_font`/`_set_cid_widths`/
        `_set_to_unicode`, mã hóa thành chuỗi 2-byte glyph-id.
      - Thiếu glyph (hoặc không có file font dự phòng) → `GlyphCoverageError`,
        KHÔNG ghi (không .notdef/ô vuông).

    Args:
        page:               trang pikepdf (`pikepdf.Page` hoặc object trang).
        text:               nội dung cụm text mới.
        bbox:               [x0, y0, x1, y1] (hệ PDF bottom-left); baseline = (x0, y0).
        pdf:                document pikepdf chứa trang.
        font_size:          cỡ chữ (point), mặc định 12.0.
        color:              màu tô — None (đen) | (g,) | (r,g,b) | (c,m,y,k).
        fallback_font_path: đường dẫn font dự phòng (mặc định DejaVuSans assets).

    Returns:
        `AddResult` mô tả thay đổi. Text rỗng → `changed=False` (no-op).

    Raises:
        GlyphCoverageError: thiếu glyph cho text và không có font đủ glyph (Yêu cầu 9.3).
        ValueError:         color sai số thành phần / bbox sai định dạng.
    """
    pg = _as_page(page)

    if not text:
        return AddResult(changed=False, kind="text", message="Text rỗng — không thêm.")

    nb = normalize_bbox(list(bbox))
    x0, y0, _x1, _y1 = nb
    fsize = float(font_size) if font_size and float(font_size) > 0 else 12.0

    # Gộp content stream về MỘT để index/parse đồng bộ với các thao tác khác.
    try:
        contents_coalesce(pdf, pg)
    except Exception as exc:  # noqa: BLE001
        logger.warning("contents_coalesce thất bại, tiếp tục parse trực tiếp: %s", exc)

    instructions = parse_page_ops(pg)

    used_fallback = False

    # Font NHÚNG: người dùng chọn (chosen_font_path) → ưu tiên nhúng font đó (kể cả
    # text ASCII), giúp thêm text đúng kiểu chữ mong muốn. Không chọn → ASCII dùng
    # Helvetica built-in, phi-ASCII nhúng DejaVuSans dự phòng.
    embed_path = fallback_font_path
    force_embed = False
    if chosen_font_path and os.path.exists(chosen_font_path):
        embed_path = chosen_font_path
        force_embed = True

    if _is_pure_ascii_printable(text) and not force_embed:
        # Font chuẩn Helvetica (built-in, không cần nhúng) cho ASCII.
        font_obj = pdf.make_indirect(
            pikepdf.Dictionary(
                Type=pikepdf.Name("/Font"),
                Subtype=pikepdf.Name("/Type1"),
                BaseFont=pikepdf.Name("/Helvetica"),
                Encoding=pikepdf.Name("/WinAnsiEncoding"),
            )
        )
        font_resource = _ensure_font_resource(pg, font_obj, "FAdd")
        show_instr = pikepdf.ContentStreamInstruction(
            [pikepdf.String(text.encode("latin-1"))], pikepdf.Operator("Tj")
        )
    else:
        # CHỮ PHỨC TẠP (Arabic/Thai/Indic…): shape bằng HarfBuzz → nhúng glyph
        # shaped (dạng ngữ cảnh ĐÚNG). Chỉ khi cần; Latin/CJK/Việt đi đường codepoint.
        shaped = None
        if needs_shaping(text) and os.path.exists(embed_path):
            shaped = _make_shaped_show(pdf, pg, embed_path, text)
        if shaped is not None:
            shaped_tf_name, show_instr = shaped
            font_resource = shaped_tf_name
            used_fallback = True
        else:
            # Nhúng font ĐÃ CHỌN (hoặc dự phòng DejaVuSans) — Type0/Identity-H, subset.
            if not os.path.exists(embed_path):
                raise GlyphCoverageError(
                    f"Không có file font tại '{embed_path}' để nhúng — HỦY thao tác "
                    f"(Yêu cầu 9.3), KHÔNG ghi."
                )
            font_obj, char_to_glyph, char_widths = _embed_cid_font(
                pdf, embed_path, subset_codepoints={ord(c) for c in text}
            )

            # KIỂM GLYPH trước khi ghi (Yêu cầu 9.3 / 8.4).
            missing = sorted({c for c in text if ord(c) not in char_to_glyph})
            if missing:
                preview = "".join(missing[:10])
                raise GlyphCoverageError(
                    f"Font nhúng thiếu glyph cho ký tự: {preview!r} — HỦY thao tác "
                    f"(Yêu cầu 9.3), KHÔNG ghi .notdef/ô vuông. Hãy chọn font khác."
                )

            used_gid_widths: dict[int, float] = {}
            gid_to_unicode: dict[int, str] = {}
            gid_bytes = bytearray()
            for c in text:
                cp = ord(c)
                gid = char_to_glyph[cp]
                gid_bytes += struct.pack(">H", gid)
                if cp in char_widths:
                    used_gid_widths[gid] = char_widths[cp]
                gid_to_unicode[gid] = c
            _set_cid_widths(font_obj._cid_font, used_gid_widths)  # type: ignore[attr-defined]
            _set_to_unicode(font_obj, pdf, gid_to_unicode)

            font_resource = _ensure_font_resource(pg, font_obj, "FAdd")
            used_fallback = True
            show_instr = pikepdf.ContentStreamInstruction(
                [pikepdf.String(bytes(gid_bytes))], pikepdf.Operator("Tj")
            )

    # ── Dựng khối text cô lập `q [màu] BT … ET Q` và APPEND vào cuối ─────────
    text_block: list = [_q_instruction()]
    text_block += _fill_color_instructions(color)
    text_block += [
        pikepdf.ContentStreamInstruction([], pikepdf.Operator("BT")),
        pikepdf.ContentStreamInstruction(
            [pikepdf.Name("/" + font_resource), fsize], pikepdf.Operator("Tf")
        ),
        pikepdf.ContentStreamInstruction(
            [1.0, 0.0, 0.0, 1.0, float(x0), float(y0)], pikepdf.Operator("Tm")
        ),
        show_instr,
        pikepdf.ContentStreamInstruction([], pikepdf.Operator("ET")),
        _Q_instruction(),
    ]

    new_instructions = instructions + text_block
    new_bytes = pikepdf.unparse_content_stream(new_instructions)
    pg.obj[pikepdf.Name("/Contents")] = pdf.make_stream(new_bytes)

    return AddResult(
        changed=True,
        kind="text",
        bbox=nb,
        resource_name=font_resource,
        used_fallback=used_fallback,
        font_size=fsize,
        message=(
            f"Đã thêm text {text!r} tại baseline ({x0:.2f}, {y0:.2f}) "
            f"({'font dự phòng DejaVuSans' if used_fallback else 'font chuẩn Helvetica'}, "
            f"resource='{font_resource}', size={fsize:.2f}); bọc q…Q, append cuối stream."
        ),
    )


def _ensure_xobject_resource(pg: pikepdf.Page, xobj, base_name: str) -> str:
    """
    Đăng ký `xobj` vào `/Resources/XObject` của trang với một tên DUY NHẤT
    (không trùng tên đã có). Trả về tên resource (không gồm dấu '/').
    """
    resources = pg.obj.get("/Resources")
    if resources is None:
        resources = pikepdf.Dictionary()
        pg.obj[pikepdf.Name("/Resources")] = resources
    xobjects = resources.get("/XObject")
    if xobjects is None:
        xobjects = pikepdf.Dictionary()
        resources[pikepdf.Name("/XObject")] = xobjects

    name = base_name
    suffix = 0
    while pikepdf.Name("/" + name) in xobjects:
        suffix += 1
        name = f"{base_name}{suffix}"
    xobjects[pikepdf.Name("/" + name)] = xobj
    return name


def _build_image_xobject(
    pdf: pikepdf.Pdf,
    image_source,
    *,
    target_size: tuple[int, int] | None = None,
):
    """
    Build an Image XObject from a path or bytes.

    ``target_size`` is used by Replace Image when the original XObject owns a
    pixel mask. Matching the original pixel grid is required for /SMask and
    image /Mask resources to clip the replacement exactly like the source.
    PNG/WEBP alpha is retained as a PDF soft mask.
    """
    import io
    import zlib

    from PIL import Image

    if isinstance(image_source, (bytes, bytearray)):
        raw_input = bytes(image_source)
    else:
        with open(image_source, "rb") as fh:
            raw_input = fh.read()

    source = Image.open(io.BytesIO(raw_input))
    source.load()
    img = source.copy()
    fmt = (source.format or "").upper()
    source.close()

    width, height = img.size
    resized = False
    if target_size is not None:
        target_width, target_height = int(target_size[0]), int(target_size[1])
        if target_width <= 0 or target_height <= 0:
            raise ValueError("Kích thước pixel ảnh đích phải lớn hơn 0.")
        if target_width * target_height > 64_000_000:
            raise ValueError(
                "Ảnh gốc có mask vượt quá 64 triệu pixel; từ chối thay ảnh để tránh hết bộ nhớ."
            )
        if (width, height) != (target_width, target_height):
            img = img.resize((target_width, target_height), Image.Resampling.LANCZOS)
            width, height = img.size
            resized = True

    def _raw_stream(image, colorspace: str):
        compressed = zlib.compress(image.tobytes())
        stream = pdf.make_stream(compressed)
        stream[pikepdf.Name("/Type")] = pikepdf.Name("/XObject")
        stream[pikepdf.Name("/Subtype")] = pikepdf.Name("/Image")
        stream[pikepdf.Name("/Width")] = int(width)
        stream[pikepdf.Name("/Height")] = int(height)
        stream[pikepdf.Name("/ColorSpace")] = pikepdf.Name(colorspace)
        stream[pikepdf.Name("/BitsPerComponent")] = 8
        stream[pikepdf.Name("/Filter")] = pikepdf.Name("/FlateDecode")
        return stream

    # Preserve transparency supplied by the replacement itself. When the
    # original image owns a mask, replace_image overrides this /SMask below.
    has_alpha = img.mode in {"RGBA", "LA"} or "transparency" in img.info
    if has_alpha:
        rgba = img.convert("RGBA")
        color_stream = _raw_stream(rgba.convert("RGB"), "/DeviceRGB")
        alpha_stream = _raw_stream(rgba.getchannel("A"), "/DeviceGray")
        color_stream[pikepdf.Name("/SMask")] = alpha_stream
        return color_stream, width, height

    # Keep JPEG bytes verbatim only when no resize was needed.
    if fmt in ("JPEG", "JPG") and not resized:
        cs_map = {"RGB": "/DeviceRGB", "CMYK": "/DeviceCMYK", "L": "/DeviceGray"}
        colorspace = cs_map.get(img.mode, "/DeviceRGB")
        stream = pdf.make_stream(raw_input)
        stream[pikepdf.Name("/Type")] = pikepdf.Name("/XObject")
        stream[pikepdf.Name("/Subtype")] = pikepdf.Name("/Image")
        stream[pikepdf.Name("/Width")] = int(width)
        stream[pikepdf.Name("/Height")] = int(height)
        stream[pikepdf.Name("/ColorSpace")] = pikepdf.Name(colorspace)
        stream[pikepdf.Name("/BitsPerComponent")] = 8
        stream[pikepdf.Name("/Filter")] = pikepdf.Name("/DCTDecode")
        return stream, width, height

    if img.mode == "L":
        color_image = img
        colorspace = "/DeviceGray"
    elif img.mode == "CMYK":
        color_image = img
        colorspace = "/DeviceCMYK"
    else:
        color_image = img.convert("RGB")
        colorspace = "/DeviceRGB"
    return _raw_stream(color_image, colorspace), width, height


def _original_image_mask_kind(original_xobj) -> str | None:
    soft_mask = original_xobj.get("/SMask")
    if soft_mask is not None and str(soft_mask) != "/None":
        return "soft"
    hard_mask = original_xobj.get("/Mask")
    if hard_mask is not None and not isinstance(hard_mask, pikepdf.Array):
        return "hard"
    return None


def _preserve_original_image_presentation(original_xobj, replacement_xobj) -> str | None:
    """Copy mask/layer presentation metadata that belongs to the original image."""
    for key in ("/OC", "/Interpolate", "/Intent"):
        value = original_xobj.get(key)
        if value is not None:
            replacement_xobj[pikepdf.Name(key)] = value

    mask_kind = _original_image_mask_kind(original_xobj)
    soft_mask = original_xobj.get("/SMask")
    if mask_kind == "soft":
        replacement_xobj[pikepdf.Name("/SMask")] = soft_mask
        if pikepdf.Name("/Mask") in replacement_xobj:
            del replacement_xobj[pikepdf.Name("/Mask")]
        return "soft"

    hard_mask = original_xobj.get("/Mask")
    # A stream /Mask is a reusable image mask. A color-key array belongs to
    # the old pixel values and must not be copied to unrelated replacement RGB.
    if mask_kind == "hard":
        if pikepdf.Name("/SMask") in replacement_xobj:
            del replacement_xobj[pikepdf.Name("/SMask")]
        replacement_xobj[pikepdf.Name("/Mask")] = hard_mask
        return "hard"
    return None


def _frame_path_instruction(operator: str, *operands: float):
    return pikepdf.ContentStreamInstruction(
        [float(value) for value in operands], pikepdf.Operator(operator)
    )


def _image_frame_path(shape: str, span: OpSpan, radius: float) -> list:
    """Build a closed clipping path in the image's unit-square coordinate space."""

    def closed_polygon(points: list[tuple[float, float]]) -> list:
        if len(points) < 3:
            raise ValueError("A clipping polygon needs at least three points")
        instructions = [_frame_path_instruction("m", *points[0])]
        instructions.extend(_frame_path_instruction("l", *point) for point in points[1:])
        instructions.append(_frame_path_instruction("h"))
        return instructions

    def regular_polygon(sides: int) -> list:
        points = [
            (
                0.5 + 0.5 * math.cos(math.pi / 2.0 - (2.0 * math.pi * index / sides)),
                0.5 + 0.5 * math.sin(math.pi / 2.0 - (2.0 * math.pi * index / sides)),
            )
            for index in range(sides)
        ]
        return closed_polygon(points)

    if shape == "rectangle":
        return [_frame_path_instruction("re", 0.0, 0.0, 1.0, 1.0)]
    if shape == "triangle":
        return closed_polygon([(0.5, 1.0), (1.0, 0.0), (0.0, 0.0)])
    if shape == "diamond":
        return closed_polygon([(0.5, 1.0), (1.0, 0.5), (0.5, 0.0), (0.0, 0.5)])
    if shape == "pentagon":
        return regular_polygon(5)
    if shape == "hexagon":
        return regular_polygon(6)
    if shape == "octagon":
        return regular_polygon(8)
    if shape == "star":
        points = []
        for index in range(10):
            radius_value = 0.5 if index % 2 == 0 else 0.22
            angle = math.pi / 2.0 - (math.pi * index / 5.0)
            points.append(
                (
                    0.5 + radius_value * math.cos(angle),
                    0.5 + radius_value * math.sin(angle),
                )
            )
        return closed_polygon(points)
    if shape == "cross":
        return closed_polygon(
            [
                (0.35, 1.0), (0.65, 1.0), (0.65, 0.65), (1.0, 0.65),
                (1.0, 0.35), (0.65, 0.35), (0.65, 0.0), (0.35, 0.0),
                (0.35, 0.35), (0.0, 0.35), (0.0, 0.65), (0.35, 0.65),
            ]
        )
    if shape == "heart":
        return [
            _frame_path_instruction("m", 0.5, 0.05),
            _frame_path_instruction("c", 0.42, 0.2, 0.08, 0.42, 0.08, 0.7),
            _frame_path_instruction("c", 0.08, 0.93, 0.36, 0.99, 0.5, 0.79),
            _frame_path_instruction("c", 0.64, 0.99, 0.92, 0.93, 0.92, 0.7),
            _frame_path_instruction("c", 0.92, 0.42, 0.58, 0.2, 0.5, 0.05),
            _frame_path_instruction("h"),
        ]

    ctm = list(span.ctm or [1.0, 0.0, 0.0, 1.0, 0.0, 0.0])
    width = max(1e-6, math.hypot(ctm[0], ctm[1]))
    height = max(1e-6, math.hypot(ctm[2], ctm[3]))
    kappa = 0.5522847498307936

    if shape in {"circle", "ellipse"}:
        if shape == "circle":
            physical_radius = min(width, height) / 2.0
            rx = min(0.5, physical_radius / width)
            ry = min(0.5, physical_radius / height)
        else:
            rx = ry = 0.5
        cx = cy = 0.5
        return [
            _frame_path_instruction("m", cx + rx, cy),
            _frame_path_instruction("c", cx + rx, cy + kappa * ry, cx + kappa * rx, cy + ry, cx, cy + ry),
            _frame_path_instruction("c", cx - kappa * rx, cy + ry, cx - rx, cy + kappa * ry, cx - rx, cy),
            _frame_path_instruction("c", cx - rx, cy - kappa * ry, cx - kappa * rx, cy - ry, cx, cy - ry),
            _frame_path_instruction("c", cx + kappa * rx, cy - ry, cx + rx, cy - kappa * ry, cx + rx, cy),
            _frame_path_instruction("h"),
        ]

    if shape == "rounded":
        physical_radius = max(0.0, min(0.5, float(radius))) * min(width, height)
        rx = min(0.5, physical_radius / width)
        ry = min(0.5, physical_radius / height)
        return [
            _frame_path_instruction("m", rx, 0.0),
            _frame_path_instruction("l", 1.0 - rx, 0.0),
            _frame_path_instruction("c", 1.0 - rx + kappa * rx, 0.0, 1.0, ry - kappa * ry, 1.0, ry),
            _frame_path_instruction("l", 1.0, 1.0 - ry),
            _frame_path_instruction("c", 1.0, 1.0 - ry + kappa * ry, 1.0 - rx + kappa * rx, 1.0, 1.0 - rx, 1.0),
            _frame_path_instruction("l", rx, 1.0),
            _frame_path_instruction("c", rx - kappa * rx, 1.0, 0.0, 1.0 - ry + kappa * ry, 0.0, 1.0 - ry),
            _frame_path_instruction("l", 0.0, ry),
            _frame_path_instruction("c", 0.0, ry - kappa * ry, rx - kappa * rx, 0.0, rx, 0.0),
            _frame_path_instruction("h"),
        ]
    raise ValueError(f"Unsupported image frame: {shape!r}")
def _existing_prynx_image_clip_bounds(instructions: list, do_index: int) -> tuple[int, int] | None:
    pair = _enclosing_q_indices(instructions, do_index)
    if pair is None:
        return None
    q_index, q_end = pair
    if q_index <= 0 or q_end + 1 >= len(instructions):
        return None
    marker = instructions[q_index - 1]
    if str(marker.operator) not in {"BMC", "BDC"} or not marker.operands:
        return None
    if _name_str(marker.operands[0]) != "PrynXImageClip":
        return None
    if str(instructions[q_end + 1].operator) != "EMC":
        return None
    return q_index - 1, q_end + 2


def clip_image(
    page,
    obj_meta,
    shape: str,
    radius: float,
    pdf: pikepdf.Pdf,
) -> ClipImageResult:
    """Apply/change/remove a PrynX-owned vector clipping frame around one image."""
    pg = _as_page(page)
    meta_id = _meta_value(obj_meta, "id", "?")
    if _meta_value(obj_meta, "type") != "image":
        raise ValueError(f"Object '{meta_id}' is not an image.")

    try:
        contents_coalesce(pdf, pg)
    except Exception as exc:  # noqa: BLE001
        logger.warning("contents_coalesce failed before clip_image: %s", exc)

    spans = [span for span in map_object_spans(pg, obj_meta, pdf=pdf) if span.kind == "image"]
    if len(spans) != 1 or not spans[0].resource_name:
        raise ObjectMapError(
            f"Cannot map image '{meta_id}' to one normal XObject for a frame."
        )
    span = spans[0]
    instructions = parse_page_ops(pg)
    do_indices = [
        index
        for index in range(max(0, span.start), min(len(instructions), span.end))
        if str(instructions[index].operator) == "Do"
        and instructions[index].operands
        and _name_str(instructions[index].operands[0]) == span.resource_name
    ]
    if len(do_indices) != 1:
        raise ObjectMapError(
            f"Image '{meta_id}' does not resolve to one unique Do operator for a frame."
        )

    do_index = do_indices[0]
    do_instruction = instructions[do_index]
    existing = _existing_prynx_image_clip_bounds(instructions, do_index)
    start, end = existing if existing is not None else (do_index, do_index + 1)

    if shape == "none":
        replacement = [do_instruction]
    else:
        path = _image_frame_path(shape, span, radius)
        replacement = [
            pikepdf.ContentStreamInstruction(
                [pikepdf.Name("/PrynXImageClip")], pikepdf.Operator("BMC")
            ),
            _q_instruction(),
            *path,
            pikepdf.ContentStreamInstruction([], pikepdf.Operator("W")),
            pikepdf.ContentStreamInstruction([], pikepdf.Operator("n")),
            do_instruction,
            _Q_instruction(),
            pikepdf.ContentStreamInstruction([], pikepdf.Operator("EMC")),
        ]

    instructions[start:end] = replacement
    pg.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
        pikepdf.unparse_content_stream(instructions)
    )
    bbox = normalize_bbox(list(_meta_value(obj_meta, "bbox", [])))
    return ClipImageResult(
        changed=True,
        bbox=bbox,
        shape=shape,
        radius=float(radius),
        message=f"Applied image frame '{shape}' to '{meta_id}' without rasterizing.",
    )

def replace_image(
    page,
    obj_meta,
    image_source,
    pdf: pikepdf.Pdf,
) -> ReplaceImageResult:
    """
    Replace one normal Image XObject without changing the original placement block.

    A fresh XObject resource is registered and only the target Do operand is changed.
    If the image is inline, ambiguous, or cannot be mapped to exactly one Do, the
    operation is rejected so the session rollback keeps the PDF untouched.
    """
    pg = _as_page(page)
    meta_type = _meta_value(obj_meta, "type")
    meta_id = _meta_value(obj_meta, "id", "?")
    if meta_type != "image":
        raise ValueError(f"Object '{meta_id}' is not an image.")

    try:
        contents_coalesce(pdf, pg)
    except Exception as exc:  # noqa: BLE001
        logger.warning("contents_coalesce failed before replace_image: %s", exc)

    spans = map_object_spans(pg, obj_meta, pdf=pdf)
    image_spans = [span for span in spans if span.kind == "image"]
    if len(image_spans) != 1:
        raise ObjectMapError(
            f"Cannot map image '{meta_id}' to one unique image span for replacement."
        )
    span = image_spans[0]
    if not span.resource_name:
        raise ObjectMapError(
            f"Image '{meta_id}' is inline and cannot be replaced safely."
        )

    instructions = parse_page_ops(pg)
    do_indices: list[int] = []
    for index in range(max(0, span.start), min(len(instructions), span.end)):
        instruction = instructions[index]
        if str(instruction.operator) != "Do" or not instruction.operands:
            continue
        if _name_str(instruction.operands[0]) == span.resource_name:
            do_indices.append(index)
    if len(do_indices) != 1:
        raise ObjectMapError(
            f"Image '{meta_id}' does not resolve to one unique Do operator."
        )

    xobjects = _xobject_dict(pg)
    old_key = pikepdf.Name("/" + span.resource_name)
    if xobjects is None or old_key not in xobjects:
        raise ObjectMapError(
            f"Image resource '/{span.resource_name}' is missing from the page."
        )
    original_xobj = xobjects[old_key]
    if str(original_xobj.get("/Subtype")) != "/Image":
        raise ObjectMapError(
            f"Resource '/{span.resource_name}' is not a normal Image XObject."
        )
    if bool(original_xobj.get("/ImageMask", False)):
        raise ObjectMapError(
            f"Image '{meta_id}' is a stencil mask and cannot be replaced safely."
        )

    original_width = int(original_xobj.get("/Width", 0) or 0)
    original_height = int(original_xobj.get("/Height", 0) or 0)
    original_mask_kind = _original_image_mask_kind(original_xobj)
    # Only a pixel mask requires identical Width/Height. Without one, retain
    # the replacement's native resolution for maximum print quality.
    target_size = (
        (original_width, original_height)
        if original_mask_kind and original_width > 0 and original_height > 0
        else None
    )
    xobj, width_px, height_px = _build_image_xobject(
        pdf, image_source, target_size=target_size
    )
    preserved_mask = _preserve_original_image_presentation(original_xobj, xobj)
    new_name = _ensure_xobject_resource(pg, xobj, "ImgReplace")
    do_index = do_indices[0]
    instructions[do_index] = pikepdf.ContentStreamInstruction(
        [pikepdf.Name("/" + new_name)], pikepdf.Operator("Do")
    )
    pg.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
        pikepdf.unparse_content_stream(instructions)
    )

    bbox = normalize_bbox(list(_meta_value(obj_meta, "bbox", [])))
    return ReplaceImageResult(
        changed=True,
        bbox=bbox,
        old_resource_name=span.resource_name,
        new_resource_name=new_name,
        image_size_px=(int(width_px), int(height_px)),
        message=(
            f"Replaced image '{meta_id}' with {width_px}x{height_px}px resource "
            f"'{new_name}' while preserving its original transform"
            f" and {preserved_mask + ' mask' if preserved_mask else 'page clipping'}."
        ),
    )

def add_image(
    page,
    image_source,
    bbox,
    pdf: pikepdf.Pdf,
) -> AddResult:
    """
    Thêm MỘT ảnh mới tại `bbox` (hệ PDF bottom-left) dưới dạng XObject Image —
    CHỈ BỔ SUNG, không sửa object cũ (Yêu cầu 9.2, 9.4).

    Ảnh được đăng ký vào `/Resources/XObject` với tên DUY NHẤT, rồi chèn cụm
    `q w 0 0 h x0 y0 cm /Name Do Q` (APPEND vào CUỐI content stream) để vẽ ảnh
    lấp đầy `bbox`. Bọc cô lập `q … Q` nên CTM/màu/clip của object cũ không bị
    chạm → Color_Operators của Untouched_Object giữ nguyên (Yêu cầu 4.1, 4.2).

    Args:
        page:         trang pikepdf (`pikepdf.Page` hoặc object trang).
        image_source: đường dẫn file ảnh (str) HOẶC bytes dữ liệu ảnh.
        bbox:         [x0, y0, x1, y1] (hệ PDF bottom-left) — vùng đặt ảnh.
        pdf:          document pikepdf chứa trang.

    Returns:
        `AddResult` mô tả thay đổi. Vùng bbox suy biến (w≤0 hoặc h≤0) →
        `ValueError`.

    Raises:
        ValueError: nếu bbox tạo chiều rộng/cao ≤ 0.
    """
    pg = _as_page(page)

    nb = normalize_bbox(list(bbox))
    x0, y0, x1, y1 = nb
    w = x1 - x0
    h = y1 - y0
    if w <= 0 or h <= 0:
        raise ValueError(
            f"bbox ảnh suy biến (w={w}, h={h}); cần w>0 và h>0 — TỪ CHỐI, không ghi."
        )

    # Gộp content stream về MỘT để index/parse đồng bộ.
    try:
        contents_coalesce(pdf, pg)
    except Exception as exc:  # noqa: BLE001
        logger.warning("contents_coalesce thất bại, tiếp tục parse trực tiếp: %s", exc)

    instructions = parse_page_ops(pg)

    # Dựng + đăng ký XObject ảnh.
    xobj, width_px, height_px = _build_image_xobject(pdf, image_source)
    img_name = _ensure_xobject_resource(pg, xobj, "ImgAdd")

    # ── Cụm vẽ ảnh cô lập `q w 0 0 h x0 y0 cm /Name Do Q`, APPEND cuối ──────
    image_block = [
        _q_instruction(),
        pikepdf.ContentStreamInstruction(
            [float(w), 0.0, 0.0, float(h), float(x0), float(y0)],
            pikepdf.Operator("cm"),
        ),
        pikepdf.ContentStreamInstruction(
            [pikepdf.Name("/" + img_name)], pikepdf.Operator("Do")
        ),
        _Q_instruction(),
    ]

    new_instructions = instructions + image_block
    new_bytes = pikepdf.unparse_content_stream(new_instructions)
    pg.obj[pikepdf.Name("/Contents")] = pdf.make_stream(new_bytes)

    return AddResult(
        changed=True,
        kind="image",
        bbox=nb,
        resource_name=img_name,
        image_size_px=(int(width_px), int(height_px)),
        message=(
            f"Đã thêm ảnh ({width_px}x{height_px}px) tại bbox "
            f"[{x0:.2f}, {y0:.2f}, {x1:.2f}, {y1:.2f}]; XObject '{img_name}', "
            f"bọc q…Q, append cuối stream."
        ),
    )


def add_object(
    page,
    bbox,
    pdf: pikepdf.Pdf,
    text: str | None = None,
    image_source=None,
    font_size: float = 12.0,
    color=None,
    fallback_font_path: str = DEFAULT_FALLBACK_FONT_PATH,
) -> AddResult:
    """
    Điều phối thêm object mới: nếu có `text` → `add_text`; nếu có `image_source`
    → `add_image`. Tiện cho lớp API map từ `EditOp(kind='add')`.

    Raises:
        ValueError: nếu không cung cấp `text` lẫn `image_source`, hoặc cung cấp cả hai.
    """
    has_text = text is not None
    has_image = image_source is not None
    if has_text == has_image:
        raise ValueError(
            "add_object yêu cầu ĐÚNG MỘT trong hai: 'text' hoặc 'image_source'."
        )
    if has_text:
        return add_text(
            page,
            text,  # type: ignore[arg-type]
            bbox,
            pdf,
            font_size=font_size,
            color=color,
            fallback_font_path=fallback_font_path,
        )
    return add_image(page, image_source, bbox, pdf)


# ── Copy/Paste (task paste) ─────────────────────────────────────────────────

@dataclass
class PasteResult:
    """
    Kết quả của một thao tác dán (paste / nhân bản object).

    - `changed`      : có ghi thay đổi hay không (False = no-op).
    - `pasted_spans` : các OpSpan nguồn đã được nhân bản.
    - `dx`, `dy`     : offset (hệ PDF bottom-left) đã áp cho bản dán.
    - `count`        : số object đã dán.
    - `cross_page`   : True nếu dán sang trang khác trang nguồn.
    - `message`      : mô tả ngắn.
    """

    changed: bool
    pasted_spans: list[OpSpan] = field(default_factory=list)
    dx: float = 0.0
    dy: float = 0.0
    count: int = 0
    cross_page: bool = False
    message: str = ""


_IDENTITY_M = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]

# Các operator SET graphics-state (màu fill/stroke, colorspace, line-width, gs…).
# CHÚNG NẰM NGOÀI OpSpan (segment_ops chỉ bao path-construct→paint), nên khi TRÍCH
# slice ra cuối stream để dán, phải REPLAY lại các op này bên trong q…Q — nếu không
# object dán MẤT MÀU (về đen mặc định). Đây là ràng buộc an-toàn-màu (Yêu cầu 4.7).
_STATE_OPS = frozenset({
    "g", "G", "rg", "RG", "k", "K", "cs", "CS", "sc", "SC", "scn", "SCN",
    "w", "J", "j", "M", "d", "ri", "i", "gs",
})

# Colorspace dựng sẵn — KHÔNG phải resource của trang, không remap khi cross-page.
_DEVICE_COLORSPACES = frozenset({
    "DeviceGray", "DeviceRGB", "DeviceCMYK", "Pattern",
})


def _capture_graphics_state(instructions: list, upto: int):
    """
    Replay `instructions[0:upto]` mô phỏng q/Q stack, trả về:
      - danh sách instruction SET-state đang hiệu lực tại `upto` (theo thứ tự,
        outer→inner scope) để tái dựng màu/gs cho slice dán;
      - CTM tích lũy tại `upto` (6 phần tử) để tái dựng vị trí/scale gốc.

    Vì slice được append ra CUỐI stream (CTM=identity), phải tự dựng lại cả màu
    lẫn CTM; nếu không bản dán sai màu và sai chỗ.
    """
    state_stack: list[list] = [[]]
    ctm: list[float] = list(_IDENTITY_M)
    ctm_stack: list[list[float]] = []
    limit = min(upto, len(instructions))
    for i in range(limit):
        instr = instructions[i]
        op = str(instr.operator)
        if op == "q":
            state_stack.append([])
            ctm_stack.append(list(ctm))
        elif op == "Q":
            if len(state_stack) > 1:
                state_stack.pop()
            if ctm_stack:
                ctm = ctm_stack.pop()
        elif op == "cm":
            vals = [_as_float(o) for o in instr.operands]
            if len(vals) == 6 and all(v is not None for v in vals):
                ctm = mult_matrix([float(v) for v in vals], ctm)
        elif op in _STATE_OPS:
            state_stack[-1].append(instr)
    flat: list = []
    for scope in state_stack:
        flat.extend(scope)
    return flat, ctm


def _resource_subdict(pg: pikepdf.Page, category: str):
    """Trả `/Resources/<category>` (read-only) của trang, hoặc None."""
    try:
        resources = pg.obj.get("/Resources")
        if resources is None:
            return None
        return resources.get("/" + category)
    except Exception:  # noqa: BLE001 - resource lạ → coi như không có
        return None


def _ensure_resource_subdict(pg: pikepdf.Page, category: str):
    """Trả `/Resources/<category>`, tạo mới nếu chưa có."""
    resources = pg.obj.get("/Resources")
    if resources is None:
        resources = pikepdf.Dictionary()
        pg.obj[pikepdf.Name("/Resources")] = resources
    sub = resources.get("/" + category)
    if sub is None:
        sub = pikepdf.Dictionary()
        resources[pikepdf.Name("/" + category)] = sub
    return sub


def _same_indirect(a, b) -> bool:
    """True nếu hai object PDF trỏ cùng một indirect object (theo objgen)."""
    try:
        ga = getattr(a, "objgen", None)
        gb = getattr(b, "objgen", None)
        return ga is not None and ga == gb and ga != (0, 0)
    except Exception:  # noqa: BLE001
        return False


def _copy_resource(src_pg, dest_pg, category: str, name: str | None, cache: dict) -> str | None:
    """
    Copy một resource (theo tên) từ `/Resources/<category>` trang nguồn sang trang
    đích với TÊN DUY NHẤT, trả tên mới. Vì edit-session giữ CÙNG một `pikepdf.Pdf`
    cho cả tài liệu nên object đã indirect — chỉ cần thêm entry tham chiếu vào
    `/Resources` trang đích, KHÔNG cần copy_foreign.

    - Trả None nếu không tìm thấy (giữ operand cũ nguyên).
    - Nếu trang đích đã có entry cùng tên TRỎ CÙNG object → tái dùng tên cũ.
    - Va chạm tên khác object → sinh hậu tố `_pp{n}`.
    """
    if not name:
        return None
    ck = (category, name)
    if ck in cache:
        return cache[ck]
    src_sub = _resource_subdict(src_pg, category)
    if src_sub is None:
        return None
    src_key = pikepdf.Name("/" + name)
    try:
        if src_key not in src_sub:
            return None
        obj = src_sub[src_key]
    except Exception:  # noqa: BLE001
        return None
    dest_sub = _ensure_resource_subdict(dest_pg, category)
    existing = None
    try:
        existing = dest_sub.get(src_key)
    except Exception:  # noqa: BLE001
        existing = None
    if existing is not None and _same_indirect(existing, obj):
        cache[ck] = name
        return name
    new_name = name
    suffix = 0
    while pikepdf.Name("/" + new_name) in dest_sub:
        suffix += 1
        new_name = f"{name}_pp{suffix}"
    dest_sub[pikepdf.Name("/" + new_name)] = obj
    cache[ck] = new_name
    return new_name


def remap_span_resources(src_pg, dest_pg, instrs: list, cache: dict) -> list:
    """
    Copy mọi resource mà `instrs` tham chiếu (XObject/Font/ExtGState/ColorSpace/
    Pattern/Shading/Properties) từ trang nguồn sang trang đích, rồi VIẾT LẠI tên
    trong operand. Chỉ gọi khi dán CROSS-PAGE (cùng trang thì tên đã resolve sẵn).

    Đây là bước không có sẵn trong edit-path; cần thiết để `/Im0 Do`, `/F1 Tf`,
    `/GS0 gs`… trong slice trỏ đúng resource sau khi sang trang khác.
    """
    out: list = []
    for instr in instrs:
        op = str(instr.operator)
        operands = list(instr.operands)
        new_operands = operands
        if op == "Do" and operands:
            nm = _name_str(operands[0])
            new = _copy_resource(src_pg, dest_pg, "XObject", nm, cache)
            if new and new != nm:
                new_operands = [pikepdf.Name("/" + new)]
        elif op == "Tf" and operands:
            nm = _name_str(operands[0])
            new = _copy_resource(src_pg, dest_pg, "Font", nm, cache)
            if new and new != nm:
                new_operands = [pikepdf.Name("/" + new)] + operands[1:]
        elif op == "gs" and operands:
            nm = _name_str(operands[0])
            new = _copy_resource(src_pg, dest_pg, "ExtGState", nm, cache)
            if new and new != nm:
                new_operands = [pikepdf.Name("/" + new)]
        elif op == "sh" and operands:
            nm = _name_str(operands[0])
            new = _copy_resource(src_pg, dest_pg, "Shading", nm, cache)
            if new and new != nm:
                new_operands = [pikepdf.Name("/" + new)]
        elif op in ("cs", "CS") and operands:
            nm = _name_str(operands[0])
            if nm and nm not in _DEVICE_COLORSPACES:
                new = _copy_resource(src_pg, dest_pg, "ColorSpace", nm, cache)
                if new and new != nm:
                    new_operands = [pikepdf.Name("/" + new)]
        elif op in ("scn", "SCN") and operands:
            nm = _name_str(operands[-1])  # tên Pattern (nếu có) là operand cuối
            if nm:
                new = _copy_resource(src_pg, dest_pg, "Pattern", nm, cache)
                if new and new != nm:
                    new_operands = operands[:-1] + [pikepdf.Name("/" + new)]
        elif op in ("BDC", "DP") and len(operands) >= 2:
            nm = _name_str(operands[1])  # /OC /MC0 → operand[1] là tên Properties
            if nm:
                new = _copy_resource(src_pg, dest_pg, "Properties", nm, cache)
                if new and new != nm:
                    new_operands = [operands[0], pikepdf.Name("/" + new)]
        if new_operands is operands:
            out.append(instr)
        else:
            out.append(pikepdf.ContentStreamInstruction(new_operands, instr.operator))
    return out


def paste_objects(
    source_page,
    dest_page,
    obj_metas,
    dx: float,
    dy: float,
    pdf: pikepdf.Pdf,
    coord_space: str = "pdf",
) -> PasteResult:
    """
    Nhân bản (copy/paste) đúng tập object mục tiêu từ `source_page`, dán lệch
    (dx, dy) vào `dest_page`. Hỗ trợ cùng trang lẫn cross-page (cùng một `pikepdf.Pdf`).

    An-toàn-màu (Yêu cầu 4.7):
      - object nào `map_object_spans` không phân giải DUY NHẤT (Form đa nghĩa/clip)
        → raise `ObjectMapError`, HỦY, KHÔNG ghi.
      - slice được bọc `q <state> <cm gốc> <cm dịch> <slice> Q`: replay lại graphics
        state (màu/gs) + CTM gốc tại span.start, nên bản dán giữ đúng màu và vị trí.

    Cross-page còn copy resource (XObject/Font/ExtGState/ColorSpace/Pattern/…) sang
    `/Resources` trang đích và viết lại tên trong slice (`remap_span_resources`).
    """
    src_pg = _as_page(source_page)
    dest_pg = _as_page(dest_page)

    pdf_dx = float(dx)
    pdf_dy = float(dy)
    if coord_space == "canvas":
        pdf_dy = -pdf_dy
    elif coord_space != "pdf":
        raise ValueError(f"coord_space không hợp lệ: {coord_space!r} (chỉ 'pdf' hoặc 'canvas')")

    if not obj_metas:
        return PasteResult(changed=False, dx=pdf_dx, dy=pdf_dy,
                           message="Không có object mục tiêu — không thay đổi.")

    same_page = _same_indirect(src_pg.obj, dest_pg.obj)

    # Gộp + parse trang NGUỒN.
    try:
        contents_coalesce(pdf, src_pg)
    except Exception as exc:  # noqa: BLE001
        logger.warning("contents_coalesce (source) thất bại, parse trực tiếp: %s", exc)
    src_instructions = parse_page_ops(src_pg)

    resource_cache: dict = {}
    blocks: list[list] = []
    pasted_spans: list[OpSpan] = []

    for meta in obj_metas:
        meta_id = meta.get("id") if isinstance(meta, dict) else getattr(meta, "id", "?")
        spans = map_object_spans(src_pg, meta, pdf=pdf, prebuilt_spans=None)
        if not spans:
            raise ObjectMapError(
                f"Không thể ánh xạ object '{meta_id}' sang dải operator duy nhất "
                f"(đa nghĩa/clip/Form XObject/inline image). HỦY thao tác để bảo "
                f"toàn màu (Yêu cầu 4.7) — KHÔNG ghi kết quả."
            )
        for span in spans:
            start = max(0, span.start)
            end = min(len(src_instructions), span.end)
            if start >= end:
                continue
            slice_instrs = list(src_instructions[start:end])
            state_instrs, ctm_start = _capture_graphics_state(src_instructions, start)
            if not same_page:
                state_instrs = remap_span_resources(src_pg, dest_pg, state_instrs, resource_cache)
                slice_instrs = remap_span_resources(src_pg, dest_pg, slice_instrs, resource_cache)
            block: list = [_q_instruction()]
            block.extend(state_instrs)
            # Dựng lại CTM gốc rồi mới dịch (cm post-multiply: CTM = T × ctm_start).
            if ctm_start != _IDENTITY_M:
                block.append(_cm_instruction(ctm_start))
            block.append(_cm_translate_instruction(pdf_dx, pdf_dy))
            block.extend(slice_instrs)
            block.append(_Q_instruction())
            blocks.append(block)
            pasted_spans.append(span)

    if not blocks:
        return PasteResult(changed=False, dx=pdf_dx, dy=pdf_dy,
                           message="Không trích được slice hợp lệ — không thay đổi.")

    # Append vào CUỐI content stream trang ĐÍCH.
    if same_page:
        dest_instructions = list(src_instructions)
    else:
        try:
            contents_coalesce(pdf, dest_pg)
        except Exception as exc:  # noqa: BLE001
            logger.warning("contents_coalesce (dest) thất bại, parse trực tiếp: %s", exc)
        dest_instructions = parse_page_ops(dest_pg)

    new_instructions = list(dest_instructions)
    for block in blocks:
        new_instructions.extend(block)

    new_bytes = pikepdf.unparse_content_stream(new_instructions)
    dest_pg.obj[pikepdf.Name("/Contents")] = pdf.make_stream(new_bytes)

    return PasteResult(
        changed=True,
        pasted_spans=pasted_spans,
        dx=pdf_dx,
        dy=pdf_dy,
        count=len(blocks),
        cross_page=not same_page,
        message=(
            f"Đã dán {len(blocks)} object (dx={pdf_dx:.3f}, dy={pdf_dy:.3f}, "
            f"cross_page={not same_page})."
        ),
    )


# Re-export build_op_spans để caller (vd. API route) dùng chung tiện ích phân đoạn.
__all__ = [
    "delete_objects",
    "DeleteResult",
    "move_objects",
    "MoveResult",
    "paste_objects",
    "PasteResult",
    "affine_transform_objects",
    "AffineResult",
    "resize_objects",
    "ResizeResult",
    "rotate_objects",
    "RotateResult",
    "edit_text",
    "EditTextResult",
    "add_text",
    "add_image",
    "replace_image",
    "ReplaceImageResult",
    "clip_image",
    "ClipImageResult",
    "add_object",
    "AddResult",
    "ObjectMapError",
    "GlyphCoverageError",
    "DEFAULT_FALLBACK_FONT_PATH",
    "build_op_spans",
]
