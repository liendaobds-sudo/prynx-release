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

from app.core.object_mapper import (
    _as_float,
    _name_str,
    build_op_spans,
    contents_coalesce,
    inverse_matrix,
    map_object,
    map_text_show_op,
    mult_matrix,
    parse_page_ops,
    text_show_op_for_move,
)
from app.schemas.edit import OpSpan, normalize_bbox

logger = logging.getLogger(__name__)


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


def delete_objects(page, obj_metas, pdf: pikepdf.Pdf) -> DeleteResult:
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
        else:
            span = map_object(pg, meta, pdf=pdf)
        if span is None:
            meta_id = meta.get("id") if isinstance(meta, dict) else getattr(meta, "id", "?")
            raise ObjectMapError(
                f"Không thể ánh xạ object '{meta_id}' sang dải operator duy nhất "
                f"(đa nghĩa/clip/Form XObject/inline image). HỦY thao tác để bảo "
                f"toàn màu (Yêu cầu 4.7) — KHÔNG ghi kết quả."
            )
        spans.append(span)

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



def move_objects(
    page,
    obj_metas,
    dx: float,
    dy: float,
    pdf: pikepdf.Pdf,
    coord_space: str = "pdf",
) -> MoveResult:
    """
    Di chuyển (tịnh tiến) đúng tập object mục tiêu bằng cách BỌC CÔ LẬP `q/cm/Q`.

    Với mỗi object mục tiêu, chèn `q <translate(dx,dy) cm>` NGAY TRƯỚC dải
    operator (`OpSpan`) và `Q` NGAY SAU — bao cô lập để KHÔNG ảnh hưởng
    graphics-state (CTM/màu/clip) của các operator khác. Đây là đường GHI DUY
    NHẤT qua pikepdf (`unparse_content_stream` + `make_stream`), nên các
    `Color_Operators` của `Untouched_Object` không bị chạm (Yêu cầu 4.1, 4.2).

    Quy ước hệ tọa độ của `(dx, dy)` — xác định bởi `coord_space`:
      - `"pdf"`    (MẶC ĐỊNH): `(dx, dy)` đã ở hệ trang PDF (gốc dưới-trái,
                   trục y hướng LÊN). Áp thẳng vào `cm` translate.
      - `"canvas"`: `(dx, dy)` ở hệ canvas frontend (gốc trên-trái, trục y
                   hướng XUỐNG). Vì move là một độ dịch (delta) thuần, chỉ cần
                   ĐẢO DẤU dy để chuyển sang hệ PDF: `dy_pdf = -dy`; `dx` giữ
                   nguyên. (Không cần chiều cao MediaBox cho một delta tịnh tiến;
                   MediaBox chỉ cần khi quy đổi TỌA ĐỘ TUYỆT ĐỐI top-left↔bottom-left,
                   tham khảo tiền lệ `remove_text_from_stream`.)

    CÙNG một `(dx, dy)` được áp cho TẤT CẢ object trong `obj_metas` (Yêu cầu 5.5).

    Args:
        page:        trang pikepdf (`pikepdf.Page` hoặc object trang).
        obj_metas:   danh sách `ObjMeta` (hoặc dict tương đương) cần di chuyển.
        dx, dy:      độ dịch theo hệ `coord_space`.
        pdf:         document pikepdf chứa trang.
        coord_space: "pdf" (mặc định) hoặc "canvas".

    Returns:
        `MoveResult` mô tả thay đổi. Tập rỗng → `changed=False` (no-op).

    Raises:
        ObjectMapError: nếu BẤT KỲ target nào không map được duy nhất sang một
                        `OpSpan` (Yêu cầu 4.7) → HỦY toàn bộ, KHÔNG ghi.
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

    # ── Map target → edit; text di chuyển GRANULAR (chỉ 1 show-op, KHÔNG cả cụm
    # BT…ET), image/vector dùng span + bọc q/cm/Q. None bất kỳ → HỦY (Yêu cầu 4.7).
    nontext_spans: list[OpSpan] = []
    text_moves: list[dict] = []
    moved_spans: list[OpSpan] = []
    for meta in obj_metas:
        meta_type = meta.get("type") if isinstance(meta, dict) else getattr(meta, "type", None)
        meta_id = meta.get("id") if isinstance(meta, dict) else getattr(meta, "id", "?")
        if meta_type == "text":
            info = text_show_op_for_move(pg, meta, pdf=pdf)
            if info is None:
                raise ObjectMapError(
                    f"Không thể ánh xạ object '{meta_id}' sang một show-op text duy "
                    f"nhất. HỦY thao tác để bảo toàn (Yêu cầu 4.7) — KHÔNG ghi."
                )
            text_moves.append(info)
            ti = info["target_index"]
            moved_spans.append(OpSpan(start=ti, end=ti + 1, kind="text",
                                      ctm=[1.0, 0.0, 0.0, 1.0, 0.0, 0.0], bbox=[0, 0, 0, 0],
                                      resource_name=None))
        else:
            span = map_object(pg, meta, pdf=pdf)
            if span is None:
                raise ObjectMapError(
                    f"Không thể ánh xạ object '{meta_id}' sang dải operator duy nhất "
                    f"(đa nghĩa/clip/Form XObject/inline image). HỦY thao tác để bảo "
                    f"toàn màu (Yêu cầu 4.7) — KHÔNG ghi kết quả."
                )
            nontext_spans.append(span)
            moved_spans.append(span)

    # ── Parse lại một lần để khớp index với span/show-op đã map ─────────────
    instructions = parse_page_ops(pg)
    n = len(instructions)

    # Gom các instruction chèn THÊM theo vị trí (prefix: trước instr[i]; suffix: sau).
    prefix: dict[int, list] = {}
    suffix: dict[int, list] = {}

    def _add_prefix(i: int, instrs: list) -> None:
        prefix.setdefault(i, []).extend(instrs)

    def _add_suffix(i: int, instrs: list) -> None:
        suffix.setdefault(i, []).extend(instrs)

    # image/vector: bọc q + cm(translate) TRƯỚC span, Q SAU instr cuối của span.
    for span in nontext_spans:
        start = max(0, span.start)
        end = min(n, span.end)
        _add_prefix(start, [_q_instruction(), _cm_translate_instruction(pdf_dx, pdf_dy)])
        _add_suffix(end - 1, [_Q_instruction()])

    # text: GHIM mọi show-op trong các cụm liên quan bằng Tm TUYỆT ĐỐI (giữ nguyên
    # thứ tự op màu/state nên màu an toàn); chỉ run MỤC TIÊU cộng delta → các run
    # khác trong cùng cụm KHÔNG xê dịch. (Không dùng cm vì cm bất hợp lệ trong BT…ET.)
    target_indices: set[int] = {info["target_index"] for info in text_moves}
    cluster_show: dict[int, tuple[list[float], list[float]]] = {}
    for info in text_moves:
        for so in info["cluster"]:
            cluster_show[so["index"]] = (so["tm"], so["ctm"])
    for idx, (tm_abs, ctm_abs) in cluster_show.items():
        tm_use = _shifted_text_tm(tm_abs, ctm_abs, pdf_dx, pdf_dy) if idx in target_indices else tm_abs
        _add_prefix(idx, [_Tm_instruction(tm_use)])

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

    return MoveResult(
        changed=True,
        moved_spans=moved_spans,
        dx=pdf_dx,
        dy=pdf_dy,
        wrapped_count=len(moved_spans),
        message=(
            f"Đã di chuyển {len(moved_spans)} object (dx={pdf_dx:.3f}, dy={pdf_dy:.3f}); "
            f"text ghim Tm tuyệt đối theo run, image/vector bọc q/cm/Q."
        ),
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
    spans: list[OpSpan] = []
    for meta in obj_metas:
        span = map_object(pg, meta, pdf=pdf)
        if span is None:
            meta_id = meta.get("id") if isinstance(meta, dict) else getattr(meta, "id", "?")
            raise ObjectMapError(
                f"Không thể ánh xạ object '{meta_id}' sang dải operator duy nhất "
                f"(đa nghĩa/clip/Form XObject/inline image). HỦY thao tác để bảo "
                f"toàn màu (Yêu cầu 4.7) — KHÔNG ghi kết quả."
            )
        spans.append(span)

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
            span = map_object(pg, meta, pdf=pdf)
            if span is None:
                raise ObjectMapError(
                    f"Không thể ánh xạ object '{meta_id}' sang dải operator duy nhất "
                    f"(đa nghĩa/clip/Form XObject/inline image). HỦY thao tác để bảo "
                    f"toàn màu (Yêu cầu 4.7) — KHÔNG ghi kết quả."
                )
            nontext_spans.append(span)
            rotated_spans.append(span)

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

        # Giữ cỡ chữ cũ; nếu không xác định được, dùng sizePt từ payload/12.
        if font_size <= 0:
            font_size = 12.0

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


def _build_image_xobject(pdf: pikepdf.Pdf, image_source):
    """
    Dựng một XObject ảnh (`/Subtype /Image`) từ `image_source` (đường dẫn file
    hoặc bytes). Trả về `(xobj, width_px, height_px)`.

    - JPEG  → nhúng nguyên bytes với `/DCTDecode` (giữ dữ liệu gốc, ColorSpace
              theo mode: RGB→DeviceRGB, CMYK→DeviceCMYK, L→DeviceGray).
    - Khác  → giải mã bằng PIL, chuyển RGB (hoặc giữ Gray nếu mode 'L'), nén
              `zlib` rồi nhúng raw với `/FlateDecode`.
    """
    import io
    import zlib

    from PIL import Image

    if isinstance(image_source, (bytes, bytearray)):
        raw_input = bytes(image_source)
        img = Image.open(io.BytesIO(raw_input))
    else:
        with open(image_source, "rb") as fh:
            raw_input = fh.read()
        img = Image.open(io.BytesIO(raw_input))

    fmt = (img.format or "").upper()
    width, height = img.size

    if fmt in ("JPEG", "JPG"):
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

    # Đường raw: giải mã pixel → nén zlib → FlateDecode.
    if img.mode == "L":
        colorspace = "/DeviceGray"
    elif img.mode == "CMYK":
        colorspace = "/DeviceCMYK"
    else:
        if img.mode != "RGB":
            img = img.convert("RGB")
        colorspace = "/DeviceRGB"

    pixel_bytes = img.tobytes()
    compressed = zlib.compress(pixel_bytes)
    stream = pdf.make_stream(compressed)
    stream[pikepdf.Name("/Type")] = pikepdf.Name("/XObject")
    stream[pikepdf.Name("/Subtype")] = pikepdf.Name("/Image")
    stream[pikepdf.Name("/Width")] = int(width)
    stream[pikepdf.Name("/Height")] = int(height)
    stream[pikepdf.Name("/ColorSpace")] = pikepdf.Name(colorspace)
    stream[pikepdf.Name("/BitsPerComponent")] = 8
    stream[pikepdf.Name("/Filter")] = pikepdf.Name("/FlateDecode")
    return stream, width, height


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


# Re-export build_op_spans để caller (vd. API route) dùng chung tiện ích phân đoạn.
__all__ = [
    "delete_objects",
    "DeleteResult",
    "move_objects",
    "MoveResult",
    "resize_objects",
    "ResizeResult",
    "rotate_objects",
    "RotateResult",
    "edit_text",
    "EditTextResult",
    "add_text",
    "add_image",
    "add_object",
    "AddResult",
    "ObjectMapError",
    "GlyphCoverageError",
    "DEFAULT_FALLBACK_FONT_PATH",
    "build_op_spans",
]
