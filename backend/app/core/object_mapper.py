"""
Object_Mapper — thành phần MẤU CHỐT nối hai mô hình PDF của tính năng
`pdf-object-edit`:

- **PDFium (Geometry_Reader)** trả về các object RỜI RẠC (type + bbox + matrix).
- **pikepdf (Stream_Editor)** làm việc trên chuỗi operator PHẲNG của content stream.

Module này (task 3.1) chịu trách nhiệm PHÂN ĐOẠN content stream phẳng thành các
"object vẽ" và dựng danh sách `OpSpan` (xem `app/schemas/edit.py`). Việc đối khớp
`ObjMeta` ↔ `OpSpan` và fallback an toàn là task 3.2 (KHÔNG làm ở đây).

Cơ chế:
1. `contents_coalesce()` — gộp đa content stream của trang về một (color-safe,
   chỉ-đọc trên bản sao logic của pikepdf, KHÔNG đụng PDFium).
2. `pikepdf.parse_content_stream(page)` → danh sách `ContentStreamInstruction`,
   mỗi cái có `.operands` và `.operator`.
3. Mô phỏng **graphics-state machine** khi quét tuyến tính:
   - Stack `q`/`Q` lưu/khôi phục graphics-state (gồm CTM).
   - CTM tích lũy qua `cm` (nhân ma trận, giữ đúng quy ước PDF).
   - Text-state: `BT`/`ET`, `Tm`/`Td`/`TD`/`T*`, font `Tf`.
   - XObject: `Do` (phân biệt theo lần xuất hiện thứ k của cùng tên).
   - Inline image: `BI … ID … EI` (pikepdf gộp thành 1 instruction).
4. Phân đoạn thành OpSpan: text-cluster (`BT…ET`), image (`/Name Do` subtype
   Image + inline image), vector (path-construction → painting op).

Quy ước ma trận affine 6 phần tử `[a, b, c, d, e, f]` tương ứng:

        | a  b  0 |
        | c  d  0 |
        | e  f  1 |

và điểm hàng `p' = p · M`. TÁI DÙNG đúng quy ước nhân ma trận đã có ở
`pdf_object_ops.remove_text_from_stream` (CTM mới khi gặp `cm` = `cm × CTM`).

Toàn bộ bbox của OpSpan được tính trong hệ tọa độ trang PDF (gốc dưới-trái,
đơn vị point) — KHỚP với hệ của PDFium `FPDFPageObj_GetBounds` để task 3.2 đối
khớp trực tiếp theo tolerance ≤ 1.0pt.

_Requirements: 1.4_
"""
from __future__ import annotations

import logging

import pikepdf

from app.schemas.edit import (
    BBOX_TOLERANCE_PT,
    OpSpan,
    bbox_within_tolerance,
    normalize_bbox,
)

logger = logging.getLogger(__name__)

# Ma trận đơn vị (identity) affine 6 phần tử.
IDENTITY: list[float] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]

# ── Phân loại operator ──────────────────────────────────
# Path-construction: bắt đầu/mở rộng một path.
_PATH_CONSTRUCT_OPS = {"m", "l", "c", "v", "y", "re", "h"}
# Painting op: kết thúc một path (kèm vẽ/nét/tô/clip-no-op).
_PATH_PAINT_OPS = {"S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"}
# Clip op: xuất hiện giữa path-construction và painting, vẫn thuộc cùng span.
_PATH_CLIP_OPS = {"W", "W*"}
# Text show op: hiển thị glyph.
_TEXT_SHOW_OPS = {"Tj", "TJ", "'", '"'}


# ── Toán ma trận (đồng bộ remove_text_from_stream) ──────
def mult_matrix(m1: list[float], m2: list[float]) -> list[float]:
    """
    Nhân hai ma trận affine 6 phần tử theo quy ước PDF (điểm hàng `p·M`):
    kết quả tương đương áp `m1` TRƯỚC rồi `m2`.

    Khi gặp operator `cm`, CTM mới = `mult_matrix(cm_operands, ctm_hiện_tại)`
    (đúng tiền lệ trong `pdf_object_ops.remove_text_from_stream`).
    """
    a = m1[0] * m2[0] + m1[1] * m2[2]
    b = m1[0] * m2[1] + m1[1] * m2[3]
    c = m1[2] * m2[0] + m1[3] * m2[2]
    d = m1[2] * m2[1] + m1[3] * m2[3]
    e = m1[4] * m2[0] + m1[5] * m2[2] + m2[4]
    f = m1[4] * m2[1] + m1[5] * m2[3] + m2[5]
    return [a, b, c, d, e, f]


def apply_matrix(pt: list[float], m: list[float]) -> list[float]:
    """Biến đổi điểm `pt = [x, y]` qua ma trận affine `m` → `[x', y']`."""
    x = pt[0] * m[0] + pt[1] * m[2] + m[4]
    y = pt[0] * m[1] + pt[1] * m[3] + m[5]
    return [x, y]


def _bbox_from_corners(corners: list[list[float]]) -> list[float]:
    """Bao các điểm góc thành bbox [x0, y0, x1, y1]."""
    xs = [p[0] for p in corners]
    ys = [p[1] for p in corners]
    return [min(xs), min(ys), max(xs), max(ys)]


def _unit_square_bbox(ctm: list[float]) -> list[float]:
    """
    BBox của một ảnh (XObject Image / inline image) khi vẽ: ảnh luôn nằm trong
    hình vuông đơn vị [0,1]×[0,1] trong không gian ảnh, được CTM biến đổi sang
    không gian trang. Bao 4 góc đã biến đổi.
    """
    corners = [
        apply_matrix([0.0, 0.0], ctm),
        apply_matrix([1.0, 0.0], ctm),
        apply_matrix([0.0, 1.0], ctm),
        apply_matrix([1.0, 1.0], ctm),
    ]
    return _bbox_from_corners(corners)


# ── Đọc operand an toàn ─────────────────────────────────
def _as_float(operand) -> float | None:
    """Chuyển operand pikepdf số → float; trả None nếu không phải số."""
    try:
        return float(operand)
    except (TypeError, ValueError):
        return None


def _name_str(operand) -> str | None:
    """
    Lấy tên resource từ operand `pikepdf.Name` → chuỗi không gồm dấu '/'.
    Trả None nếu operand không phải Name.
    """
    try:
        s = str(operand)
    except Exception:  # noqa: BLE001 - operand lạ, bỏ qua an toàn
        return None
    if s.startswith("/"):
        return s[1:]
    return None


def _glyph_count(operands: list, operator: str) -> int:
    """
    Ước lượng số ký tự hiển thị của một text-show op để tính bề rộng bbox gần đúng.

    - `Tj` / `'` : operand chuỗi đơn.
    - `"`        : [aw, ac, string] → lấy string cuối.
    - `TJ`       : mảng xen kẽ chuỗi và số (số = điều chỉnh khoảng cách) → cộng
                   độ dài các phần chuỗi.
    """
    try:
        if operator == "TJ" and operands:
            total = 0
            for item in operands[0]:
                if _as_float(item) is None:  # phần tử chuỗi
                    try:
                        total += len(bytes(item))
                    except Exception:  # noqa: BLE001
                        total += 1
            return total
        if operator in ("Tj", "'") and operands:
            return len(bytes(operands[0]))
        if operator == '"' and len(operands) >= 3:
            return len(bytes(operands[2]))
    except Exception:  # noqa: BLE001 - operand không decode được, ước lượng tối thiểu
        return 1
    return 0


# ── Coalesce + parse ────────────────────────────────────
def contents_coalesce(pdf: pikepdf.Pdf, page) -> None:
    """
    Gộp đa content stream của một trang về MỘT stream.

    Dùng `page.contents_coalesce()` của pikepdf nếu có; nếu không, ghép thủ công
    bằng cách nối bytes các stream (chèn dấu cách giữa các phần để không dính
    operator). Thao tác chỉ tác động cấu trúc /Contents, KHÔNG đổi operator màu.
    """
    pg = page if isinstance(page, pikepdf.Page) else pikepdf.Page(page)

    coalesce = getattr(pg, "contents_coalesce", None)
    if callable(coalesce):
        coalesce()
        return

    # Fallback thủ công: ghép các stream con thành một.
    contents = pg.obj.get("/Contents")
    if contents is None:
        return
    if isinstance(contents, pikepdf.Array):
        parts: list[bytes] = []
        for item in contents:
            try:
                parts.append(item.read_bytes())
            except Exception:  # noqa: BLE001
                continue
        merged = b"\n".join(parts)
        pg.obj[pikepdf.Name("/Contents")] = pdf.make_stream(merged)


def parse_page_ops(page) -> list:
    """
    Trả về danh sách `ContentStreamInstruction` của trang qua
    `pikepdf.parse_content_stream`. Mỗi instruction có `.operands` và `.operator`.
    """
    pg = page if isinstance(page, pikepdf.Page) else pikepdf.Page(page)
    return list(pikepdf.parse_content_stream(pg))


def _xobject_subtype(page, name: str) -> str | None:
    """
    Tra cứu `/Subtype` của một XObject theo tên resource (vd. 'Image' / 'Form').
    Trả None nếu không tìm thấy.
    """
    pg = page if isinstance(page, pikepdf.Page) else pikepdf.Page(page)
    try:
        resources = pg.obj.get("/Resources")
        if resources is None:
            return None
        xobjects = resources.get("/XObject")
        if xobjects is None:
            return None
        key = pikepdf.Name("/" + name)
        if key not in xobjects:
            return None
        sub = xobjects[key].get("/Subtype")
        if sub is None:
            return None
        s = str(sub)
        return s[1:] if s.startswith("/") else s
    except Exception:  # noqa: BLE001 - resource lạ → coi như không xác định
        return None


# ── Ranh giới span IMAGE: bao trọn cụm transform đặt ảnh ────────────────────
#
# BỐI CẢNH (root cause của bug Property 2 với IMAGE):
# Một ảnh thường được vẽ bằng cụm `w 0 0 h x y cm` đặt NGAY TRƯỚC `Do` (đưa hình
# vuông đơn vị của ảnh về đúng vị trí/kích thước trên trang). Nếu OpSpan của ảnh
# chỉ bao đúng instruction `Do` (start=i, end=i+1), thì khi Stream_Editor bọc
# `q <transform cm> ... Q` quanh RIÊNG `Do`, phép biến đổi bị áp TRONG hệ tọa độ
# ĐÃ scale của ảnh (CTM = transform · imageCm · pageCTM) → dịch/scale SAI (độ
# dịch bị nhân với ma trận ảnh w,h). Vector không bị vì nằm ở CTM đơn vị.
#
# KHẮC PHỤC: mở rộng ranh giới span ảnh để BAO TRỌN cụm transform đặt ảnh đứng
# ngay trước `Do`. Khi Stream_Editor bọc transform NGOÀI span (gồm cả cụm cm
# đó), phép biến đổi áp ở PAGE-SPACE: CTM = imageCm · transform · pageCTM →
# tương đương dịch/scale ảnh đúng trong hệ tọa độ trang. BBox span (vẫn tính từ
# CTM tại thời điểm `Do`, gồm cm ảnh) KHÔNG đổi, nên map_object vẫn khớp đúng.
def _preceding_cm_run_start(instructions: list, do_index: int) -> int:
    """
    Trả index của `cm` ĐẦU TIÊN trong chuỗi `cm` liên tiếp đứng NGAY TRƯỚC `Do`
    tại `do_index` (gộp cả cụm `w 0 0 h x y cm` đặt ảnh). Nếu ngay trước `Do`
    không có `cm` nào thì trả về chính `do_index` (span giữ nguyên = chỉ `Do`).
    """
    j = do_index - 1
    while j >= 0 and str(instructions[j].operator) == "cm":
        j -= 1
    return j + 1


def _enclosing_q_block(instructions: list, do_index: int) -> tuple[int, int] | None:
    """
    Tìm khối `q … Q` BAO NGOÀI trực tiếp instruction `Do` tại `do_index`.

    Trả `(q_index, Q_index)` của cặp q/Q lồng khít nhất bao quanh `Do`, hoặc
    None nếu `Do` không nằm trong khối q/Q nào (cùng độ sâu). Cân bằng độ sâu
    để bỏ qua các cặp q/Q lồng bên trong.
    """
    # Lùi tìm `q` mở khối hiện tại (bỏ qua các cặp Q…q lồng đã đóng).
    depth = 0
    q_index = -1
    j = do_index - 1
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

    # Tiến tìm `Q` đóng khối tương ứng (bỏ qua các cặp q…Q lồng bên trong).
    depth = 0
    Q_index = -1
    k = do_index + 1
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


def _block_only_serves_image(
    instructions: list, q_index: int, Q_index: int, do_index: int
) -> bool:
    """
    True nếu khối `q … Q` (giữa `q_index` và `Q_index`) CHỈ phục vụ ảnh này:
    bên trong chỉ gồm các `cm` (transform đặt ảnh) và DUY NHẤT instruction `Do`
    tại `do_index` — không có op vẽ/đổi-màu/text/`Do` khác. Khi đó toàn khối là
    "object ảnh cô lập", an toàn để lấy span = [q_index, Q_index] (bọc/xóa trọn).
    """
    for j in range(q_index + 1, Q_index):
        if j == do_index:
            continue
        if str(instructions[j].operator) != "cm":
            return False
    return True


def _image_span_bounds(instructions: list, do_index: int) -> tuple[int, int]:
    """
    Tính ranh giới `[start, end)` cho span ảnh tại `Do`/`INLINE IMAGE` ở
    `do_index`, BAO TRỌN cụm transform đặt ảnh đứng ngay trước:

      - Nếu `Do` nằm trong một khối `q … Q` mà khối đó CHỈ chứa (các cm + Do của
        ảnh này) → span = TOÀN KHỐI `[q, Q]`. Bọc transform bên ngoài khối ⇒ áp
        ở page-space; xóa thì xóa trọn khối (cân bằng q/Q).
      - Ngược lại (không có q/Q cô lập) → gộp chuỗi `cm` liên tiếp ngay trước
        `Do`: span bắt đầu từ `cm` đầu tiên của cụm đó tới hết `Do`.
      - Nếu không có cm liền trước và không có khối cô lập → giữ nguyên span chỉ
        gồm `Do` (`[do_index, do_index+1)`), không đổi hành vi cũ.
    """
    block = _enclosing_q_block(instructions, do_index)
    if block is not None:
        q_index, Q_index = block
        if _block_only_serves_image(instructions, q_index, Q_index, do_index):
            # Bao trọn cả `q` và `Q` (nửa-mở nên end = Q_index + 1).
            return q_index, Q_index + 1
    # Không phải khối cô lập → gộp chuỗi cm liền trước Do.
    start = _preceding_cm_run_start(instructions, do_index)
    return start, do_index + 1


# ── Graphics-state machine + phân đoạn OpSpan ───────────
def _text_cluster_bbox(
    show_origins: list[list[float]],
) -> list[float] | None:
    """
    Bao các hộp glyph (mỗi phần tử là [x0, y0, x1, y1] đã ở không gian trang)
    của một cụm `BT…ET` thành một bbox. Trả None nếu cụm rỗng (không show).
    """
    if not show_origins:
        return None
    x0 = min(b[0] for b in show_origins)
    y0 = min(b[1] for b in show_origins)
    x1 = max(b[2] for b in show_origins)
    y1 = max(b[3] for b in show_origins)
    return [x0, y0, x1, y1]


def _ocg_ids_from_value(value, seen=None) -> set[int]:
    """Resolve OCG IDs from an OCG, OCMD (/OCGs or /VE), or nested array."""
    if value is None:
        return set()
    if seen is None:
        seen = set()
    try:
        resolved = value
        identity = _object_identity(resolved)
        if identity is not None:
            if identity in seen:
                return set()
            seen.add(identity)
        if isinstance(resolved, (list, pikepdf.Array)):
            result: set[int] = set()
            for item in resolved:
                result.update(_ocg_ids_from_value(item, seen))
            return result
        if not hasattr(resolved, "get"):
            return set()
        kind = str(resolved.get("/Type", ""))
        if kind == "/OCG":
            if bool(resolved.get("/PrynXInternal", False)):
                return set()
            oid = (_object_identity(value) or _object_identity(resolved) or (0, 0))[0]
            return {int(oid)} if oid else set()
        if kind == "/OCMD":
            result = _ocg_ids_from_value(resolved.get("/OCGs"), seen)
            result.update(_ocg_ids_from_value(resolved.get("/VE"), seen))
            return result
    except Exception:
        return set()
    return set()


def _page_property_ocg_ids(page, operand) -> set[int]:
    try:
        page_obj = page.obj if hasattr(page, "obj") else page
        if isinstance(operand, pikepdf.Name):
            resources = page_obj.get("/Resources") or pikepdf.Dictionary()
            properties = resources.get("/Properties") or pikepdf.Dictionary()
            return _ocg_ids_from_value(properties.get(operand))
        return _ocg_ids_from_value(operand)
    except Exception:
        return set()


def _xobject_ocg_ids(page, resource_name: str | None) -> set[int]:
    if not resource_name:
        return set()
    try:
        page_obj = page.obj if hasattr(page, "obj") else page
        resources = page_obj.get("/Resources") or pikepdf.Dictionary()
        xobjects = resources.get("/XObject") or pikepdf.Dictionary()
        ref = xobjects.get(pikepdf.Name("/" + resource_name))
        resolved = ref
        return _ocg_ids_from_value(resolved.get("/OC") if hasattr(resolved, "get") else None)
    except Exception:
        return set()

def segment_ops(instructions: list, page=None) -> list[OpSpan]:
    """
    Quét tuyến tính danh sách instruction, mô phỏng graphics-state machine và
    phân đoạn thành danh sách `OpSpan`.

    Quy ước index: `OpSpan.start` là index instruction đầu, `OpSpan.end` là
    index NGAY SAU instruction cuối (nửa-mở `[start, end)`), khớp comment trong
    `app/schemas/edit.py`.

    Args:
        instructions: list `ContentStreamInstruction` (từ `parse_page_ops`).
        page: trang pikepdf (tùy chọn) để tra cứu `/Subtype` của XObject `Do`.
    """
    spans: list[OpSpan] = []

    # Trạng thái đồ họa.
    ctm: list[float] = list(IDENTITY)
    gs_stack: list[list[float]] = []  # stack q/Q lưu CTM

    # Trạng thái văn bản (chỉ có nghĩa giữa BT…ET).
    in_text = False
    text_start = -1
    tm: list[float] = list(IDENTITY)
    tlm: list[float] = list(IDENTITY)
    font_size = 1.0
    leading = 0.0
    text_glyph_boxes: list[list[float]] = []
    text_ocg_ids: set[int] = set()

    # Trạng thái path (vector).
    in_path = False
    path_start = -1
    path_points: list[list[float]] = []

    # Đếm lần xuất hiện của từng tên XObject (phân biệt lần thứ k).
    do_occurrence: dict[str, int] = {}

    # Active optional-content membership inherited through nested BDC/BMC blocks.
    ocg_stack: list[set[int]] = [set()]

    def _active_ocg_ids() -> list[int]:
        return sorted(ocg_stack[-1])

    def _record_glyph(num_chars: int) -> None:
        """Tính hộp gần đúng cho một text-show op tại trạng thái text hiện tại
        rồi tích lũy vào cụm, và đẩy `tm` tiến theo bề rộng ước lượng."""
        nonlocal tm
        # Ma trận render text: [fs 0 0 fs 0 0] · Tm · CTM (fontsize áp trước).
        trm = mult_matrix([font_size, 0.0, 0.0, font_size, 0.0, 0.0],
                          mult_matrix(tm, ctm))
        # Ước lượng bề rộng theo em: ~0.5 em mỗi glyph; cao từ descent→ascent.
        adv = 0.5 * max(num_chars, 1)
        corners = [
            apply_matrix([0.0, -0.2], trm),
            apply_matrix([adv, -0.2], trm),
            apply_matrix([0.0, 0.8], trm),
            apply_matrix([adv, 0.8], trm),
        ]
        text_glyph_boxes.append(_bbox_from_corners(corners))
        # Đẩy con trỏ text tiến (trong không gian text, trước khi nhân fontsize
        # vào trm ta dùng adv*font_size theo đơn vị text-space của Tm).
        tm = mult_matrix([1.0, 0.0, 0.0, 1.0, adv * font_size, 0.0], tm)

    def _close_path(end_index: int) -> None:
        """Đóng một nhóm path đang mở thành OpSpan vector."""
        nonlocal in_path, path_start, path_points
        if in_path and path_points:
            bbox = _bbox_from_corners(path_points)
            spans.append(
                OpSpan(
                    start=path_start,
                    end=end_index,
                    kind="vector",
                    ctm=list(ctm),
                    bbox=bbox,
                    resource_name=None,
                    ocgIds=_active_ocg_ids(),
                )
            )
        in_path = False
        path_start = -1
        path_points = []

    for i, instr in enumerate(instructions):
        op = str(instr.operator)
        operands = list(instr.operands)

        # ----- Optional-content stack -----
        if op in ("BDC", "BMC"):
            inherited = set(ocg_stack[-1])
            if op == "BDC" and len(operands) >= 2 and str(operands[-2]) == "/OC":
                inherited.update(_page_property_ocg_ids(page, operands[-1]))
            ocg_stack.append(inherited)
            continue
        if op == "EMC":
            if len(ocg_stack) > 1:
                ocg_stack.pop()
            continue

        # ----- Graphics-state stack -----
        if op == "q":
            gs_stack.append(list(ctm))
            continue
        if op == "Q":
            if gs_stack:
                ctm = gs_stack.pop()
            continue
        if op == "cm":
            vals = [_as_float(o) for o in operands]
            if len(vals) == 6 and all(v is not None for v in vals):
                ctm = mult_matrix([float(v) for v in vals], ctm)
            continue

        # ----- Inline image: BI…ID…EI (pikepdf gộp 1 instruction) -----
        if op == "INLINE IMAGE":
            # Mở rộng ranh giới để bao trọn cụm `cm` đặt ảnh (và khối q/Q cô lập
            # nếu có) đứng ngay trước inline image — xem `_image_span_bounds`.
            start_idx, end_idx = _image_span_bounds(instructions, i)
            spans.append(
                OpSpan(
                    start=start_idx,
                    end=end_idx,
                    kind="image",
                    ctm=list(ctm),
                    bbox=_unit_square_bbox(ctm),
                    resource_name=None,
                    ocgIds=_active_ocg_ids(),
                )
            )
            continue

        # ----- Text-state -----
        if op == "BT":
            in_text = True
            text_start = i
            tm = list(IDENTITY)
            tlm = list(IDENTITY)
            text_glyph_boxes = []
            text_ocg_ids = set(ocg_stack[-1])
            continue
        if op == "ET":
            if in_text:
                bbox = _text_cluster_bbox(text_glyph_boxes)
                if bbox is not None:
                    spans.append(
                        OpSpan(
                            start=text_start,
                            end=i + 1,
                            kind="text",
                            # CTM tại thời điểm vẽ cụm text.
                            ctm=list(ctm),
                            bbox=bbox,
                            resource_name=None,
                            ocgIds=sorted(text_ocg_ids),
                        )
                    )
            in_text = False
            text_start = -1
            text_glyph_boxes = []
            continue

        if in_text:
            if op == "Tf":
                # operands = [/FontName, size]
                if operands:
                    sz = _as_float(operands[-1])
                    if sz is not None:
                        font_size = sz
                continue
            if op == "TL":
                if operands:
                    val = _as_float(operands[0])
                    if val is not None:
                        leading = val
                continue
            if op == "Tm":
                vals = [_as_float(o) for o in operands]
                if len(vals) == 6 and all(v is not None for v in vals):
                    tm = [float(v) for v in vals]
                    tlm = list(tm)
                continue
            if op in ("Td", "TD"):
                if len(operands) >= 2:
                    tx = _as_float(operands[0]) or 0.0
                    ty = _as_float(operands[1]) or 0.0
                    if op == "TD":
                        leading = -ty
                    tlm = mult_matrix([1.0, 0.0, 0.0, 1.0, tx, ty], tlm)
                    tm = list(tlm)
                continue
            if op == "T*":
                tlm = mult_matrix([1.0, 0.0, 0.0, 1.0, 0.0, -leading], tlm)
                tm = list(tlm)
                continue
            if op in _TEXT_SHOW_OPS:
                text_ocg_ids.update(ocg_stack[-1])
                if op in ("'", '"'):
                    # ' và " xuống dòng trước khi show.
                    tlm = mult_matrix([1.0, 0.0, 0.0, 1.0, 0.0, -leading], tlm)
                    tm = list(tlm)
                _record_glyph(_glyph_count(operands, op))
                continue
            # Các op text khác (Tc, Tw, Tz, Ts, Tr...) không ảnh hưởng phân đoạn.
            continue

        # ----- XObject Do (ngoài text) -----
        if op == "Do":
            name = _name_str(operands[0]) if operands else None
            if name is not None:
                do_occurrence[name] = do_occurrence.get(name, 0) + 1
                subtype = _xobject_subtype(page, name) if page is not None else None
                # Chỉ phân đoạn XObject ảnh thành 'image'; Form XObject để task 3.2
                # xử lý/hủy an toàn (không tạo span ở đây).
                if subtype == "Image" or subtype is None:
                    # Mở rộng ranh giới span để BAO TRỌN cụm transform đặt ảnh
                    # (`w 0 0 h x y cm`) đứng ngay trước `Do` — và cả khối q/Q
                    # cô lập nếu khối đó chỉ phục vụ ảnh này. Nhờ vậy khi
                    # Stream_Editor bọc transform NGOÀI span, biến đổi áp ở
                    # page-space (đúng), không bị nhân vào ma trận ảnh.
                    start_idx, end_idx = _image_span_bounds(instructions, i)
                    spans.append(
                        OpSpan(
                            start=start_idx,
                            end=end_idx,
                            kind="image",
                            ctm=list(ctm),
                            bbox=_unit_square_bbox(ctm),
                            resource_name=name,
                            ocgIds=sorted(set(_active_ocg_ids()) | _xobject_ocg_ids(page, name)),
                        )
                    )
            continue

        # ----- Vector path -----
        if op in _PATH_CONSTRUCT_OPS:
            if not in_path:
                in_path = True
                path_start = i
                path_points = []
            # Tích lũy điểm để tính bbox (đã đưa về không gian trang qua CTM).
            coords = [_as_float(o) for o in operands]
            coords = [c for c in coords if c is not None]
            # Lấy từng cặp (x, y); 're' có dạng x y w h.
            if op == "re" and len(coords) >= 4:
                x, y, w, h = coords[0], coords[1], coords[2], coords[3]
                pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]
                for p in pts:
                    path_points.append(apply_matrix(p, ctm))
            else:
                for k in range(0, len(coords) - 1, 2):
                    path_points.append(apply_matrix([coords[k], coords[k + 1]], ctm))
            continue
        if op in _PATH_CLIP_OPS:
            # Clip op nằm trong cùng span path (giữ ranh giới tới painting op).
            continue
        if op in _PATH_PAINT_OPS:
            # Kết thúc nhóm path bằng painting op (gồm cả 'n' = no-op/clip).
            _close_path(i + 1)
            continue

        # Các op khác (màu, BDC/EMC, gs...) không tạo OpSpan ở task 3.1.

    # Đóng path còn treo (stream không kết thúc bằng painting op hợp lệ).
    if in_path:
        _close_path(len(instructions))

    return spans


def build_op_spans(page, pdf: pikepdf.Pdf | None = None, coalesce: bool = True) -> list[OpSpan]:
    """
    Điểm vào chính của task 3.1: từ một trang pikepdf, gộp content stream, parse
    và phân đoạn thành danh sách `OpSpan` (text / image / vector).

    Args:
        page: trang pikepdf (`pikepdf.Page` hoặc object trang).
        pdf:  document chứa trang (cần cho coalesce thủ công). Nếu None, lấy từ
              `page.obj.owner` khi có thể.
        coalesce: True thì gộp đa content stream về một trước khi parse.

    Returns:
        list[OpSpan] theo thứ tự vẽ.
    """
    pg = page if isinstance(page, pikepdf.Page) else pikepdf.Page(page)

    if coalesce:
        owner = pdf
        if owner is None:
            owner = getattr(pg.obj, "owner", None)
        if owner is not None:
            try:
                contents_coalesce(owner, pg)
            except Exception as exc:  # noqa: BLE001 - coalesce lỗi → vẫn parse được
                logger.warning("contents_coalesce thất bại, parse trực tiếp: %s", exc)

    instructions = parse_page_ops(pg)
    return segment_ops(instructions, page=pg)


# ── Task 3.2: Đối khớp ObjMeta ↔ OpSpan + fallback an toàn ───────────────────
def _meta_field(obj_meta, name: str):
    """
    Đọc một trường của `obj_meta` một cách khoan dung: hỗ trợ cả `ObjMeta`
    (truy cập thuộc tính) lẫn `dict` (truy cập khóa). Trả None nếu không có.
    """
    if isinstance(obj_meta, dict):
        return obj_meta.get(name)
    return getattr(obj_meta, name, None)


# ── Tiêu chí đối khớp riêng cho TEXT: dựa trên độ chồng lấp / tâm ────────────
#
# VÌ SAO TEXT KHÁC image/vector:
# - BBox của OpSpan IMAGE/VECTOR được suy ra từ CTM CHÍNH XÁC (hình vuông đơn vị
#   của ảnh, hoặc tọa độ điểm path), nên KHỚP cạnh-theo-cạnh với bbox PDFium
#   trong tolerance ≤ 1.0pt → giữ nguyên tiêu chí `bbox_within_tolerance`.
# - BBox của OpSpan TEXT lại được ƯỚC LƯỢNG trong `segment_ops` (~0.5em mỗi
#   glyph, ascent/descent giả định 0.8/-0.2). Bbox ước lượng này lệch ĐÁNG KỂ so
#   với bbox CHÍNH XÁC mà PDFium `FPDFPageObj_GetBounds` trả về → nếu đòi lệch
#   ≤ 1.0pt mỗi cạnh thì KHÔNG ứng viên text nào khớp (đây chính là root cause
#   khiến `/edit/text` luôn trả 409). Do đó với text ta nới sang tiêu chí
#   ĐỘ CHỒNG LẤP / TÂM: cụm text đúng vị trí sẽ chồng lấp đáng kể với bbox PDFium.
_TEXT_OVERLAP_RATIO_THRESHOLD = 0.30


def _bbox_area(bbox: list[float]) -> float:
    """Diện tích bbox [x0, y0, x1, y1] đã normalize (x0<=x1, y0<=y1)."""
    return max(0.0, bbox[2] - bbox[0]) * max(0.0, bbox[3] - bbox[1])


def _bbox_center_inside(center_of: list[float], container: list[float]) -> bool:
    """True nếu TÂM của bbox `center_of` nằm trong bbox `container`."""
    cx = (center_of[0] + center_of[2]) / 2.0
    cy = (center_of[1] + center_of[3]) / 2.0
    return container[0] <= cx <= container[2] and container[1] <= cy <= container[3]


def _text_bbox_overlaps(span_bbox: list[float], meta_bbox: list[float]) -> bool:
    """
    Tiêu chí khớp dành RIÊNG cho text (bbox ước lượng):

    Khớp nếu hai bbox chồng lấp đáng kể, định nghĩa cụ thể:
      - Tính intersection area của `span_bbox` và `meta_bbox` (đều đã normalize).
      - `overlap_ratio = inter_area / min(area_span, area_meta)` (tránh chia 0).
      - Khớp khi `overlap_ratio >= 0.30` HOẶC tâm `meta_bbox` nằm trong
        `span_bbox` HOẶC tâm `span_bbox` nằm trong `meta_bbox`.
      - Nếu một trong hai area = 0: chỉ khớp khi tâm trùng/nằm trong nhau (vì
        overlap_ratio không xác định được qua diện tích).
    """
    a = normalize_bbox(span_bbox)
    b = normalize_bbox(meta_bbox)

    # Tâm của cái này nằm trong cái kia → khớp (bao gồm cả trường hợp area=0).
    center_match = _bbox_center_inside(b, a) or _bbox_center_inside(a, b)
    if center_match:
        return True

    area_a = _bbox_area(a)
    area_b = _bbox_area(b)
    if area_a <= 0.0 or area_b <= 0.0:
        # Không có diện tích để tính tỉ lệ và tâm cũng không nằm trong nhau.
        return False

    inter_x0 = max(a[0], b[0])
    inter_y0 = max(a[1], b[1])
    inter_x1 = min(a[2], b[2])
    inter_y1 = min(a[3], b[3])
    inter_area = max(0.0, inter_x1 - inter_x0) * max(0.0, inter_y1 - inter_y0)
    if inter_area <= 0.0:
        return False

    overlap_ratio = inter_area / min(area_a, area_b)
    return overlap_ratio >= _TEXT_OVERLAP_RATIO_THRESHOLD


def map_object(
    page,
    obj_meta,
    pdf: pikepdf.Pdf | None = None,
    *,
    allow_same_bbox_order: bool = False,
    prebuilt_spans: list[OpSpan] | None = None,
) -> OpSpan | None:
    """
    Đối khớp MỘT `ObjMeta` (Geometry_Reader / PDFium: type + bbox + matrix +
    drawIndex) với MỘT `OpSpan` (từ `build_op_spans`).

    Điều kiện khớp một ứng viên:
      1. `type` khớp (`ObjMeta.type` == `OpSpan.kind`).
      2. BBox tính từ CTM của OpSpan ≈ BBox PDFium của ObjMeta trong tolerance
         ≤ 1.0pt (dùng `bbox_within_tolerance` / `BBOX_TOLERANCE_PT`).
      3. Thứ tự vẽ: `draw_index` (drawIndex) CHỈ là gợi ý/ưu tiên để phân giải
         khi có nhiều ứng viên — KHÔNG phải khóa cứng.

    FALLBACK AN TOÀN (Yêu cầu 4.7) — trả `None` để caller HỦY thao tác thay vì
    đoán liều, trong các trường hợp KHÔNG khớp được DUY NHẤT:
      - Không có OpSpan nào khớp (vd. ObjMeta là Form XObject — `segment_ops`
        cố ý KHÔNG tạo span cho Form XObject; hoặc clip phức tạp / object suy
        biến không dựng được span tương ứng).
      - Nhiều OpSpan ứng viên cùng khớp và drawIndex KHÔNG phân giải được duy
        nhất (đa nghĩa, vd. hai object cùng type chồng bbox).
      - drawIndex tách được một ứng viên theo thứ tự vẽ, NHƯNG ứng viên á quân
        nằm gần như cùng vị trí (bbox trong tolerance của ứng viên đầu) → vẫn
        không phân biệt chắc chắn bằng hình học → an toàn màu: trả `None`.

    Args:
        page:     trang pikepdf (`pikepdf.Page` hoặc object trang).
        obj_meta: `ObjMeta` (hoặc dict tương đương) cần đối khớp.
        pdf:      document chứa trang (chuyển tiếp cho `build_op_spans`).

    Returns:
        `OpSpan` khi và chỉ khi khớp được DUY NHẤT; ngược lại `None`.
    """
    obj_type = _meta_field(obj_meta, "type")
    obj_bbox = _meta_field(obj_meta, "bbox")
    draw_index = _meta_field(obj_meta, "drawIndex")

    # Thiếu thông tin tối thiểu để đối khớp → an toàn: hủy.
    if obj_type is None or obj_bbox is None or len(obj_bbox) != 4:
        return None

    spans = prebuilt_spans if prebuilt_spans is not None else build_op_spans(page, pdf=pdf)

    # Ứng viên: type khớp + tiêu chí khớp bbox theo từng loại object.
    #   - image/vector: bbox PDFium CHÍNH XÁC ⇒ khớp cạnh-theo-cạnh ≤ 1.0pt.
    #   - text       : bbox OpSpan là ƯỚC LƯỢNG ⇒ khớp theo độ chồng lấp / tâm
    #                  (xem `_text_bbox_overlaps`). Tránh trả 409 oan cho text.
    candidates: list[tuple[int, OpSpan]] = []
    for idx, span in enumerate(spans):
        if span.kind != obj_type:
            continue
        if obj_type == "text":
            matched = _text_bbox_overlaps(span.bbox, list(obj_bbox))
        else:
            matched = bbox_within_tolerance(span.bbox, list(obj_bbox), BBOX_TOLERANCE_PT)
        if matched:
            candidates.append((idx, span))

    # Không có ứng viên → không xác định chắc chắn (Form XObject/clip/...) → None.
    if not candidates:
        return None

    # Đúng một ứng viên → khớp duy nhất.
    if len(candidates) == 1:
        return candidates[0][1]

    # Nhiều ứng viên: dùng drawIndex như GỢI Ý (tie-breaker theo thứ tự vẽ).
    # Nếu thiếu drawIndex thì không có cơ sở phân giải → đa nghĩa → None.
    if draw_index is None:
        return None

    target = int(draw_index)
    # Xếp ứng viên theo khoảng cách thứ tự vẽ |vị-trí-span − drawIndex| tăng dần.
    scored = sorted(candidates, key=lambda c: abs(c[0] - target))
    best_pos, best_span = scored[0]
    second_pos, second_span = scored[1]

    # drawIndex KHÔNG tách được duy nhất (đồng khoảng cách) → đa nghĩa → None.
    if abs(best_pos - target) == abs(second_pos - target):
        return None

    # drawIndex tách được theo thứ tự, nhưng nếu á quân nằm gần như cùng vị trí
    # (bbox trong tolerance của ứng viên đầu) thì không phân biệt chắc chắn bằng
    # hình học → an toàn màu: hủy (None).
    if (
        not allow_same_bbox_order
        and bbox_within_tolerance(best_span.bbox, second_span.bbox, BBOX_TOLERANCE_PT)
    ):
        return None

    return best_span


def map_object_spans(
    page,
    obj_meta,
    pdf: pikepdf.Pdf | None = None,
    *,
    separate_same_bbox: bool = False,
    prebuilt_spans: list[OpSpan] | None = None,
) -> list[OpSpan]:
    """
    Như `map_object` nhưng trả về TẤT CẢ span thuộc cùng MỘT object khi object đó
    được vẽ bằng NHIỀU painting-op có CÙNG hình (bbox trùng khít trong tolerance).

    VÌ SAO CẦN: Illustrator/InDesign thường vẽ một hình bằng 2+ lượt liên tiếp trên
    CÙNG một path — vd `q cm …path… f Q` (tô) rồi `q cm …path… S Q` (viền). PDFium
    gộp các lượt này thành MỘT page-object (một bbox), nhưng `build_op_spans` tạo
    NHIỀU span (mỗi painting-op một span) có bbox trùng nhau. `map_object` coi đây là
    "đa nghĩa" và trả None → thao tác bị hủy (409) dù thực chất KHÔNG mơ hồ: mọi
    ứng viên là cùng một hình, chỉ khác lượt tô/viền, và phải biến đổi CÙNG NHAU.

    HÀNH VI:
      - 1 ứng viên            → trả [span] (như map_object).
      - Nhiều ứng viên trùng bbox lẫn nhau (fill+stroke cùng path) → trả HẾT các span
        đó (đã sort theo thứ tự xuất hiện) để caller biến đổi đồng thời.
      - Nhiều ứng viên bbox KHÁC nhau (chồng lấp thật / mơ hồ) → giữ nguyên an toàn:
        thử phân giải DUY NHẤT qua map_object; nếu map_object trả span → [span];
        nếu None → [] (caller HỦY, bảo toàn màu — Yêu cầu 4.7).

    Chỉ áp cho image/vector. Text đi đường riêng (map_text_show_op / _resolve_text_move_span).
    """
    obj_type = _meta_field(obj_meta, "type")
    obj_bbox = _meta_field(obj_meta, "bbox")

    if obj_type is None or obj_bbox is None or len(obj_bbox) != 4:
        return []
    spans = prebuilt_spans if prebuilt_spans is not None else build_op_spans(page, pdf=pdf)
    if obj_type == "text":
        # Text không dùng gộp fill+stroke; giữ hành vi map_object đơn.
        span = map_object(page, obj_meta, pdf=pdf, prebuilt_spans=spans)
        return [span] if span is not None else []

    # CỔNG DIỆN TÍCH (chặn TRƯỚC MỌI nhánh gom): object siêu nhỏ (mark li ti box
    # ~0pt²) — tolerance 1pt LỚN HƠN cả mark nên nhiều span kề nhau đều "trùng box"
    # → nhánh all_same gom nhầm span của mark bên cạnh (đã đo: 63 span bị >1 object
    # nhận). Với object nhỏ hơn ngưỡng, KHÔNG gom: về thẳng map_object (single span,
    # hành vi gốc an toàn — 409 nếu thật sự đa nghĩa). Chỉ hình đủ lớn mới gom.
    if _bbox_area(normalize_bbox(list(obj_bbox))) < _IOU_MIN_OBJ_AREA_PT2:
        span = map_object(page, obj_meta, pdf=pdf, prebuilt_spans=spans)
        return [span] if span is not None else []

    candidates: list[OpSpan] = []
    for span in spans:
        if span.kind != obj_type:
            continue
        if bbox_within_tolerance(span.bbox, list(obj_bbox), BBOX_TOLERANCE_PT):
            candidates.append(span)

    # 0 ứng viên tolerance: lớp B điển hình — stroke-object box NỞ theo nửa nét vẽ
    # nên lệch >1pt so với MỌI span (tọa độ path thuần). Thử khớp theo IoU.
    if not candidates:
        return _map_spans_by_iou(
            spans, obj_type, normalize_bbox(list(obj_bbox)),
            separate_same_bbox=separate_same_bbox, draw_index=_meta_field(obj_meta, "drawIndex"),
        )
    if len(candidates) == 1:
        return candidates

    # Nhiều ứng viên: fill+stroke cùng path ⇔ MỌI ứng viên trùng bbox lẫn nhau.
    first = candidates[0]
    all_same = all(
        bbox_within_tolerance(c.bbox, first.bbox, BBOX_TOLERANCE_PT) for c in candidates
    )
    if all_same:
        if separate_same_bbox:
            span = map_object(
                page, obj_meta, pdf=pdf, allow_same_bbox_order=True, prebuilt_spans=spans
            )
            return [span] if span is not None else []
        # Cùng một hình vẽ nhiều lượt → biến đổi tất cả cùng nhau (theo thứ tự vẽ).
        return sorted(candidates, key=lambda s: s.start)

    # bbox khác nhau thật trong nhóm tolerance → nhờ map_object phân giải duy nhất.
    span = map_object(page, obj_meta, pdf=pdf, prebuilt_spans=spans)
    if span is not None:
        return [span]

    # ── FALLBACK IoU (lớp B): stroke-object có box PDFium NỞ theo nửa nét vẽ nên
    # lệch >1pt so với box span (tọa độ path thuần) → tolerance 1pt trượt HẾT.
    # Khớp theo độ chồng lấp (IoU) thay vì cạnh-theo-cạnh: gom mọi span chồng CAO
    # với object; CHỈ nhận khi các span đó cùng thuộc MỘT hình (chồng khít lẫn
    # nhau) — fill+stroke của cùng path. Nếu ứng viên tách thành nhiều cụm rời
    # (hình khác nhau / mơ hồ thật) → HỦY (trả []), giữ nguyên bảo toàn màu.
    return _map_spans_by_iou(
        spans, obj_type, normalize_bbox(list(obj_bbox)),
        separate_same_bbox=separate_same_bbox, draw_index=_meta_field(obj_meta, "drawIndex"),
    )


def _object_identity(value) -> tuple[int, int] | None:
    """Return a stable indirect-object identity, or None for direct objects."""
    try:
        objgen = getattr(value, "objgen", (0, 0))
        if objgen and objgen != (0, 0):
            return int(objgen[0]), int(objgen[1])
    except Exception:
        pass
    return None


def _ocg_name_id_pairs(value, seen=None) -> list[tuple[str, int]]:
    """Resolve public (OCG name, object id) pairs through OCG/OCMD/VE values."""
    if value is None:
        return []
    if seen is None:
        seen = set()
    try:
        identity = _object_identity(value)
        if identity is not None:
            if identity in seen:
                return []
            seen.add(identity)
        resolved = value
        if isinstance(resolved, (list, pikepdf.Array)):
            pairs: list[tuple[str, int]] = []
            for item in resolved:
                pairs.extend(_ocg_name_id_pairs(item, seen))
            return pairs
        if not hasattr(resolved, "get"):
            return []
        kind = str(resolved.get("/Type", ""))
        if kind == "/OCG":
            if bool(resolved.get("/PrynXInternal", False)):
                return []
            oid = (_object_identity(value) or _object_identity(resolved) or (0, 0))[0]
            name = str(resolved.get("/Name", "")).strip()
            return [(name, oid)] if name and oid else []
        if kind == "/OCMD":
            pairs = _ocg_name_id_pairs(resolved.get("/OCGs"), seen)
            pairs.extend(_ocg_name_id_pairs(resolved.get("/VE"), seen))
            return pairs
    except Exception:
        return []
    return []


def _merge_ocg_name_map(target: dict[str, set[int]], value) -> None:
    for name, oid in _ocg_name_id_pairs(value):
        target.setdefault(name, set()).add(oid)


def _resource_ocg_name_map(page) -> dict[str, set[int]]:
    """Collect OCG names reachable from this page, including nested Form XObjects."""
    page_obj = page.obj if hasattr(page, "obj") else page
    result: dict[str, set[int]] = {}
    seen_resources: set[tuple[int, int]] = set()
    seen_xobjects: set[tuple[int, int]] = set()

    def visit_resources(resources) -> None:
        if resources is None or not hasattr(resources, "get"):
            return
        resource_identity = _object_identity(resources)
        if resource_identity is not None:
            if resource_identity in seen_resources:
                return
            seen_resources.add(resource_identity)

        properties = resources.get("/Properties")
        if properties is not None:
            try:
                for _, value in properties.items():
                    _merge_ocg_name_map(result, value)
            except Exception:
                pass

        xobjects = resources.get("/XObject")
        if xobjects is None:
            return
        try:
            values = [value for _, value in xobjects.items()]
        except Exception:
            return
        for xobject in values:
            xobject_identity = _object_identity(xobject)
            if xobject_identity is not None:
                if xobject_identity in seen_xobjects:
                    continue
                seen_xobjects.add(xobject_identity)
            try:
                resolved = xobject
                if not hasattr(resolved, "get"):
                    continue
                _merge_ocg_name_map(result, resolved.get("/OC"))
                if str(resolved.get("/Subtype", "")) == "/Form":
                    visit_resources(resolved.get("/Resources"))
            except Exception:
                continue

    visit_resources(page_obj.get("/Resources") if hasattr(page_obj, "get") else None)
    return result


def _catalog_ocg_name_map(pdf: pikepdf.Pdf | None) -> dict[str, set[int]]:
    result: dict[str, set[int]] = {}
    if pdf is None:
        return result
    try:
        oc_props = pdf.Root.get("/OCProperties")
        if oc_props is None:
            return result
        for ocg in list(oc_props.get("/OCGs", [])):
            _merge_ocg_name_map(result, ocg)
    except Exception:
        pass
    return result


def enrich_object_ocg_memberships(page, objects: list, pdf: pikepdf.Pdf | None = None) -> list:
    """Attach public OCG IDs to PDFium objects for the current page only.

    PDFium mark names are the fast path and handle Form XObjects well. Content-stream
    spans are a precise fallback for OCMD and nested BDC membership. Ambiguous duplicate
    names are never guessed.
    """
    if not objects:
        return objects

    page_name_map = _resource_ocg_name_map(page)
    catalog_name_map = _catalog_ocg_name_map(pdf)
    unresolved: list = []

    for obj in objects:
        ids: set[int] = set()
        names = list(_meta_field(obj, "ocgNames") or [])
        for name in names:
            candidates = page_name_map.get(name)
            if not candidates:
                candidates = catalog_name_map.get(name)
            if candidates and len(candidates) == 1:
                ids.update(candidates)
        if ids:
            if isinstance(obj, dict):
                obj["ocgIds"] = sorted(ids)
            else:
                obj.ocgIds = sorted(ids)
        else:
            unresolved.append(obj)

    # Only parse streams if the page actually exposes optional-content resources.
    # This keeps ordinary/unlayered pages at O(N), while still supporting OCMD.
    if not unresolved or (not page_name_map and not catalog_name_map):
        return objects

    try:
        spans = build_op_spans(page, pdf=pdf, coalesce=False)
        layered_spans = [span for span in spans if span.ocgIds]
    except Exception as exc:  # metadata is best-effort; object editing must still load
        logger.warning("Không đọc được OCG membership trong content stream: %s", exc)
        return objects
    if not layered_spans:
        return objects

    for obj in unresolved:
        try:
            matched = map_object_spans(
                page,
                obj,
                pdf=pdf,
                separate_same_bbox=True,
                prebuilt_spans=layered_spans,
            )
            ids = sorted({oid for span in matched for oid in span.ocgIds})
            if isinstance(obj, dict):
                obj["ocgIds"] = ids
            else:
                obj.ocgIds = ids
        except Exception:
            continue
    return objects

def _iou(a: list[float], b: list[float]) -> float:
    """IoU (intersection-over-union) của hai bbox đã normalize; 0 nếu rời nhau."""
    inter = _bbox_intersection_area(a, b)
    if inter <= 0:
        return 0.0
    union = _bbox_area(a) + _bbox_area(b) - inter
    return inter / union if union > 0 else 0.0


# Ngưỡng IoU tối thiểu để coi một span là "cùng hình" với object (fallback lớp B).
# 0.5 đủ chặt để loại span bao trùm cả nhóm (object nhỏ trong span lớn → IoU thấp)
# nhưng đủ lỏng cho lệch nửa-nét-vẽ giữa fill-span và stroke-object (~0.9 thực tế).
_IOU_SAME_SHAPE: float = 0.5

# Diện tích object tối thiểu (pt²) để CHO PHÉP IoU-fallback. Dưới ngưỡng này (mark
# li ti box ~0pt²) IoU nhiễu ở mức pixel → gom nhầm span mark kề bên. Đặt giữa mark
# (~0pt²) và hình thật nhỏ nhất đo được (~16000pt²) — 100pt² rất an toàn cho cả hai.
_IOU_MIN_OBJ_AREA_PT2: float = 100.0


def _map_spans_by_iou(
    spans,
    obj_type: str,
    obj_bbox: list[float],
    *,
    separate_same_bbox: bool = False,
    draw_index: int | None = None,
) -> list[OpSpan]:
    """
    Khớp object→span theo IoU khi tolerance cạnh-theo-cạnh thất bại (lớp B:
    stroke-object box nở theo nét vẽ). Trả HẾT span cùng một hình, hoặc [] nếu mơ hồ.

    An toàn màu: chỉ trả khi MỌI span ứng viên (IoU ≥ ngưỡng với object) đều chồng
    khít LẪN NHAU (cùng path fill+stroke). Nếu ứng viên phân thành ≥2 cụm rời rạc
    (nhiều hình khác nhau chồng vùng) → mơ hồ → [] (HỦY).

    CỔNG DIỆN TÍCH: chỉ áp IoU-fallback cho object đủ LỚN. Mark siêu nhỏ (box ~0pt²,
    vd dấu chấm/nét li ti) có IoU nhiễu ở mức pixel → dễ gom nhầm span của mark kề
    bên (đã đo: 83 lần span bị >1 mark cùng nhận). Object nhỏ hơn ngưỡng → KHÔNG dùng
    IoU (giữ HỦY an toàn như hành vi gốc), tránh move-1-kéo-nhiều phá nội dung.
    """
    if _bbox_area(obj_bbox) < _IOU_MIN_OBJ_AREA_PT2:
        return []
    cands = [
        s for s in spans
        if s.kind == obj_type and _iou(normalize_bbox(list(s.bbox)), obj_bbox) >= _IOU_SAME_SHAPE
    ]
    if not cands:
        return []
    if len(cands) == 1:
        return cands
    if separate_same_bbox and draw_index is not None:
        positions = [(idx, span) for idx, span in enumerate(spans) if span in cands]
        scored = sorted(positions, key=lambda item: abs(item[0] - int(draw_index)))
        if len(scored) == 1 or abs(scored[0][0] - int(draw_index)) < abs(scored[1][0] - int(draw_index)):
            return [scored[0][1]]
        return []

    # Mọi ứng viên phải chồng khít LẪN NHAU (cùng hình). Nếu có cặp IoU thấp →
    # chúng là hình khác nhau → mơ hồ → HỦY.
    for i in range(len(cands)):
        for j in range(i + 1, len(cands)):
            if _iou(normalize_bbox(list(cands[i].bbox)),
                    normalize_bbox(list(cands[j].bbox))) < _IOU_SAME_SHAPE:
                return []
    return sorted(cands, key=lambda s: s.start)


# ── Task fix: ánh xạ GRANULAR cho XÓA text (1 show-op, không cả khối BT…ET) ───
#
# VÌ SAO CẦN: `segment_ops` gộp cả khối `BT…ET` thành MỘT span text (vì các phép
# biến đổi move/resize phải bọc `q/cm/Q` NGOÀI khối — `cm` không hợp lệ bên trong
# BT…ET). Nhưng PDFium liệt kê MỖI đoạn show (`Tj/TJ/'/"`) là MỘT object riêng.
# Do đó nếu XÓA dùng span khối, xóa 1 object text sẽ xóa cả cụm ("xóa 1 mất mấy").
#
# XÓA thì KHÁC move/resize: chỉ cần bỏ ĐÚNG instruction show-op của object đó,
# GIỮ NGUYÊN `BT/ET` + các op định vị (`Td/Tm/T*`) → chữ còn lại không xê dịch
# (Td là tương đối/tích lũy nên bỏ riêng show-op không ảnh hưởng glyph khác).
def _iter_text_show_ops(instructions: list) -> list[dict]:
    """
    Mô phỏng graphics-state + text-state HỆT `segment_ops`, trả về danh sách dict
    `{index, bbox, tm, ctm, bt}` cho TỪNG text-show op (`Tj/TJ/'/"`):
      - index: chỉ số instruction của show op.
      - bbox : hộp bao ước lượng (page-space) — đối khớp với bbox PDFium.
      - tm   : ma trận text TUYỆT ĐỐI tại thời điểm show (TRƯỚC khi tiến glyph).
      - ctm  : CTM tại thời điểm show.
      - bt   : chỉ số instruction `BT` của cụm chứa show op (định danh cụm).
    """
    ctm: list[float] = list(IDENTITY)
    gs_stack: list[list[float]] = []
    in_text = False
    cur_bt = -1
    tm: list[float] = list(IDENTITY)
    tlm: list[float] = list(IDENTITY)
    font_size = 1.0
    leading = 0.0
    out: list[dict] = []

    for i, instr in enumerate(instructions):
        op = str(instr.operator)
        operands = list(instr.operands)

        if op == "q":
            gs_stack.append(list(ctm)); continue
        if op == "Q":
            if gs_stack:
                ctm = gs_stack.pop()
            continue
        if op == "cm":
            vals = [_as_float(o) for o in operands]
            if len(vals) == 6 and all(v is not None for v in vals):
                ctm = mult_matrix([float(v) for v in vals], ctm)
            continue
        if op == "BT":
            in_text = True
            cur_bt = i
            tm = list(IDENTITY); tlm = list(IDENTITY)
            continue
        if op == "ET":
            in_text = False
            continue
        if not in_text:
            continue

        if op == "Tf":
            if operands:
                sz = _as_float(operands[-1])
                if sz is not None:
                    font_size = sz
            continue
        if op == "TL":
            if operands:
                val = _as_float(operands[0])
                if val is not None:
                    leading = val
            continue
        if op == "Tm":
            vals = [_as_float(o) for o in operands]
            if len(vals) == 6 and all(v is not None for v in vals):
                tm = [float(v) for v in vals]; tlm = list(tm)
            continue
        if op in ("Td", "TD"):
            if len(operands) >= 2:
                tx = _as_float(operands[0]) or 0.0
                ty = _as_float(operands[1]) or 0.0
                if op == "TD":
                    leading = -ty
                tlm = mult_matrix([1.0, 0.0, 0.0, 1.0, tx, ty], tlm)
                tm = list(tlm)
            continue
        if op == "T*":
            tlm = mult_matrix([1.0, 0.0, 0.0, 1.0, 0.0, -leading], tlm)
            tm = list(tlm)
            continue
        if op in _TEXT_SHOW_OPS:
            if op in ("'", '"'):
                tlm = mult_matrix([1.0, 0.0, 0.0, 1.0, 0.0, -leading], tlm)
                tm = list(tlm)
            num_chars = _glyph_count(operands, op)
            trm = mult_matrix([font_size, 0.0, 0.0, font_size, 0.0, 0.0],
                              mult_matrix(tm, ctm))
            adv = 0.5 * max(num_chars, 1)
            corners = [
                apply_matrix([0.0, -0.2], trm),
                apply_matrix([adv, -0.2], trm),
                apply_matrix([0.0, 0.8], trm),
                apply_matrix([adv, 0.8], trm),
            ]
            out.append({
                "index": i,
                "bbox": _bbox_from_corners(corners),
                "tm": list(tm),
                "ctm": list(ctm),
                "bt": cur_bt,
            })
            tm = mult_matrix([1.0, 0.0, 0.0, 1.0, adv * font_size, 0.0], tm)
            continue
        # Các op text khác không ảnh hưởng phân đoạn show-op.

    return out


def _bbox_intersection_area(a: list[float], b: list[float]) -> float:
    """Diện tích phần giao của hai bbox đã normalize."""
    ix0 = max(a[0], b[0]); iy0 = max(a[1], b[1])
    ix1 = min(a[2], b[2]); iy1 = min(a[3], b[3])
    return max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)


def map_text_show_op(page, obj_meta, pdf: pikepdf.Pdf | None = None) -> OpSpan | None:
    """
    Khớp MỘT `ObjMeta` text với ĐÚNG MỘT text-show op để XÓA granular.

    Trả `OpSpan(start=idx, end=idx+1, kind='text')` trỏ tới đúng instruction
    show-op của object đó; hoặc `None` nếu KHÔNG xác định được duy nhất (0 hoặc
    nhiều ứng viên ngang nhau) → caller HỦY (an toàn, KHÔNG xóa nhầm cả cụm).

    Tiêu chí (bbox text là ƯỚC LƯỢNG nên không khớp cạnh ≤1pt được):
      - Ưu tiên show-op mà TÂM bbox PDFium của object nằm TRONG bbox show-op.
      - Nhiều ứng viên center-match → chọn ứng viên có diện tích giao LỚN NHẤT;
        chỉ nhận khi vượt trội duy nhất, nếu hòa → None.
      - Không có center-match → chọn theo diện tích giao lớn nhất (>0) duy nhất.
    """
    obj_type = _meta_field(obj_meta, "type")
    obj_bbox = _meta_field(obj_meta, "bbox")
    if obj_type != "text" or obj_bbox is None or len(obj_bbox) != 4:
        return None

    pg = page if isinstance(page, pikepdf.Page) else pikepdf.Page(page)
    instructions = parse_page_ops(pg)
    show_ops = _iter_text_show_ops(instructions)
    if not show_ops:
        return None

    b = normalize_bbox(list(obj_bbox))

    # 1) Ứng viên theo TÂM (tâm object nằm trong bbox show-op).
    center_cands = [
        d for d in show_ops
        if _bbox_center_inside(b, normalize_bbox(d["bbox"]))
    ]
    pool = center_cands if center_cands else show_ops

    # 2) Chấm điểm theo diện tích giao; chọn lớn nhất, yêu cầu vượt trội duy nhất.
    scored = sorted(
        ((_bbox_intersection_area(normalize_bbox(d["bbox"]), b), d) for d in pool),
        key=lambda t: t[0], reverse=True,
    )
    best_area, best = scored[0]
    if best_area <= 0.0 and not center_cands:
        return None  # không giao + không center-match → không chắc chắn.
    if len(scored) >= 2 and scored[1][0] == best_area and not center_cands:
        return None  # hòa diện tích, không có center để phân giải → None.

    return OpSpan(
        start=best["index"], end=best["index"] + 1, kind="text",
        ctm=list(best["ctm"]), bbox=normalize_bbox(best["bbox"]), resource_name=None,
    )


def inverse_matrix(m: list[float]) -> list[float] | None:
    """
    Nghịch đảo ma trận affine 6 phần tử `[a, b, c, d, e, f]` (quy ước p·M).
    Trả None nếu suy biến (det≈0).
    """
    a, b, c, d, e, f = m
    det = a * d - b * c
    if abs(det) < 1e-12:
        return None
    ia = d / det
    ib = -b / det
    ic = -c / det
    id_ = a / det
    ie = -(e * ia + f * ic)
    if_ = -(e * ib + f * id_)
    return [ia, ib, ic, id_, ie, if_]


def text_show_op_for_move(page, obj_meta, pdf: pikepdf.Pdf | None = None) -> dict | None:
    """
    Cho MOVE text granular: khớp object text với MỘT show-op (như `map_text_show_op`)
    rồi trả về thông tin để DI CHUYỂN RIÊNG show-op đó mà KHÔNG xê dịch các run khác
    trong cùng cụm `BT…ET`:

        {
          "target_index": int,           # chỉ số instruction show-op mục tiêu
          "cluster": [ {index, tm, ctm}, ... ]  # MỌI show-op cùng cụm BT…ET
        }

    Trả None nếu không khớp duy nhất (an toàn → caller HỦY).
    """
    obj_type = _meta_field(obj_meta, "type")
    obj_bbox = _meta_field(obj_meta, "bbox")
    if obj_type != "text" or obj_bbox is None or len(obj_bbox) != 4:
        return None

    pg = page if isinstance(page, pikepdf.Page) else pikepdf.Page(page)
    instructions = parse_page_ops(pg)
    show_ops = _iter_text_show_ops(instructions)
    if not show_ops:
        return None

    b = normalize_bbox(list(obj_bbox))
    center_cands = [d for d in show_ops if _bbox_center_inside(b, normalize_bbox(d["bbox"]))]
    pool = center_cands if center_cands else show_ops
    scored = sorted(
        ((_bbox_intersection_area(normalize_bbox(d["bbox"]), b), d) for d in pool),
        key=lambda t: t[0], reverse=True,
    )
    best_area, best = scored[0]
    if best_area <= 0.0 and not center_cands:
        return None
    if len(scored) >= 2 and scored[1][0] == best_area and not center_cands:
        return None

    target_bt = best["bt"]
    cluster = [
        {"index": d["index"], "tm": list(d["tm"]), "ctm": list(d["ctm"])}
        for d in show_ops if d["bt"] == target_bt
    ]
    return {"target_index": best["index"], "cluster": cluster}
