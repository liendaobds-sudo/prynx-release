"""
Regression test — GUARDRAIL MÀU IN (Task 8.4 — spec `pdf-object-edit`).

Đây KHÔNG phải Property-Based Test mà là REGRESSION TEST với các VÍ DỤ CỐ ĐỊNH,
đóng vai guardrail CI: nếu BẤT KỲ đường ghi nào của `stream_editor` (+ lưu qua
`edit_io.apply_and_save`) lỡ HỦY màu in (vd. ai đó vô tình dùng PDFium
`GenerateContent` sau này) → test PHẢI ĐỎ.

Kiểm giữ NGUYÊN — qua MỌI đường ghi — các thuộc tính màu của object KHÔNG mục
tiêu:
  - `k`     (CMYK)                                  → Yêu cầu 4.3
  - `scn`   (spot/separation) + định nghĩa `/Separation` colorspace → Yêu cầu 4.4
  - overprint (`OP`/`op`/`OPM` qua ExtGState `gs`)  → Yêu cầu 4.5
  - tham chiếu `/ICCBased` colorspace               → Yêu cầu 4.6

CHIẾN LƯỢC
- Dựng MỘT PDF spike CỐ ĐỊNH bằng pikepdf chứa các object cô lập `q … Q`:
    idx0  target  : vector RGB thuần  (đây là object bị delete/move/resize/rotate)
    idx1  cmyk    : `c m y k k`
    idx2  spot    : `/Sep2 cs tint scn`  (+ /Separation colorspace)
    idx3  overprint: `/GS3 gs c m y k k` (+ ExtGState /OP /op /OPM)
    idx4  icc     : `/CS_ICC4 cs r g b scn` (+ /ICCBased colorspace, nhúng sRGB.icc)
    idx5  text    : `… k … BT /F1 … (Hello) Tj ET` (đây là object bị edit_text)
- Áp LẦN LƯỢT các đường ghi qua `edit_io.apply_and_save` (mở gốc → mutate →
  lưu Working_File MỚI), rồi xác nhận màu của các object KHÔNG mục tiêu
  (idx1..idx4) giữ NGUYÊN: operator + giá trị + định nghĩa colorspace +
  ExtGState overprint + tham chiếu `/ICCBased` không đổi.

_Requirements: 4.3, 4.4, 4.5, 4.6_
"""
import io
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pikepdf

from app.core.edit_io import apply_and_save
from app.core.object_mapper import parse_page_ops
from app.core.stream_editor import (
    add_image,
    add_text,
    build_op_spans,
    delete_objects,
    edit_text,
    move_objects,
    resize_objects,
    rotate_objects,
)
from app.schemas.edit import ObjMeta

# ── Đường dẫn ICC tái dùng trong assets (sRGB → N=3) ─────────────────────────
ICC_PATH = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "app", "assets", "icc", "sRGB.icc")
)
ICC_N = 3

# ── Layout cố định (hệ PDF bottom-left), các object KHÔNG chồng nhau ─────────
PAGE_W = 600.0
PAGE_H = 400.0

TARGET_BBOX = [40.0, 40.0, 100.0, 90.0]     # idx0 — vector RGB thuần (mục tiêu)
CMYK_BBOX = [200.0, 40.0, 260.0, 90.0]      # idx1
SPOT_BBOX = [360.0, 40.0, 420.0, 90.0]      # idx2
OVERPRINT_BBOX = [40.0, 200.0, 100.0, 250.0]  # idx3
ICC_BBOX = [200.0, 200.0, 260.0, 250.0]     # idx4
TEXT_BASELINE = (360.0, 210.0)              # idx5 — text "Hello"

# Giá trị màu DUY NHẤT theo object (giúp chữ ký toàn cục phân biệt được).
CMYK_VALUES = [0.11, 0.22, 0.33, 0.44]        # idx1 `k`
OVERPRINT_CMYK = [0.15, 0.25, 0.35, 0.45]     # idx3 `k` (sau `gs`)
SPOT_TINT = 0.6000                            # idx2 `scn`
ICC_RGB = [0.2000, 0.4000, 0.6000]            # idx4 `scn`
TARGET_RGB = [0.9000, 0.8000, 0.7000]         # idx0 `rg`
TEXT_CMYK = [0.05, 0.15, 0.25, 0.35]          # idx5 `k`

# Operator được coi là Color_Operators (gồm `gs` áp overprint, `cs`/`scn`…).
COLOR_OPS = {"k", "K", "scn", "SCN", "sc", "SC", "cs", "CS", "rg", "RG", "g", "G", "gs"}


# ─────────────────────────────────────────────────────────────────────────────
#  Chuẩn hóa chữ ký Color_Operators
# ─────────────────────────────────────────────────────────────────────────────
def _sig(op: str, raw_operands: list):
    """(op, operands) dạng nguồn → chữ ký so khớp được (số làm tròn 4, tên giữ str)."""
    canon = []
    for o in raw_operands:
        if isinstance(o, str):
            canon.append(("name", o))
        else:
            canon.append(("num", round(float(o), 4)))
    return (op, tuple(canon))


def _sig_from_instr(instr):
    """ContentStreamInstruction đã parse → chữ ký so khớp được."""
    canon = []
    for o in instr.operands:
        try:
            canon.append(("num", round(float(o), 4)))
        except (TypeError, ValueError):
            canon.append(("name", str(o)))
    return (str(instr.operator), tuple(canon))


def _color_signatures(page) -> list:
    """Danh sách chữ ký Color_Operators hiện diện trong content stream của trang."""
    return [
        _sig_from_instr(instr)
        for instr in parse_page_ops(page)
        if str(instr.operator) in COLOR_OPS
    ]


# Chữ ký màu KỲ VỌNG của các object KHÔNG mục tiêu (idx1..idx4) — phải giữ NGUYÊN
# qua MỌI đường ghi.
UNTOUCHED_COLOR_SIGS = [
    _sig("k", CMYK_VALUES),                # idx1 CMYK
    _sig("cs", ["/Sep2"]),                 # idx2 spot colorspace select
    _sig("scn", [SPOT_TINT]),              # idx2 spot tint
    _sig("gs", ["/GS3"]),                  # idx3 overprint ExtGState
    _sig("k", OVERPRINT_CMYK),             # idx3 CMYK dưới overprint
    _sig("cs", ["/CS_ICC4"]),              # idx4 ICCBased colorspace select
    _sig("scn", ICC_RGB),                  # idx4 ICCBased màu
]


# ─────────────────────────────────────────────────────────────────────────────
#  Dựng PDF spike cố định
# ─────────────────────────────────────────────────────────────────────────────
def _fragment(lines: list[str]) -> str:
    return "\n".join(["q", *lines, "Q"]) + "\n"


def _rect_lines(bbox: list[float]) -> str:
    x0, y0, x1, y1 = bbox
    return f"{x0:.4f} {y0:.4f} {x1 - x0:.4f} {y1 - y0:.4f} re"


def build_spike_pdf(path: str) -> None:
    """
    Dựng + LƯU PDF spike 1 trang chứa CMYK/spot/overprint/ICCBased + text,
    mỗi object là một khối cô lập `q … Q`. Ghi ra `path`.
    """
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
    page = pdf.pages[0]

    # ── Resources: ColorSpace (/Separation + /ICCBased), ExtGState, Font ────
    with open(ICC_PATH, "rb") as fh:
        icc_bytes = fh.read()
    icc_stream = pdf.make_stream(icc_bytes)
    icc_stream[pikepdf.Name("/N")] = ICC_N

    sep_func = pdf.make_indirect(
        pikepdf.Dictionary(
            FunctionType=2,
            Domain=pikepdf.Array([0, 1]),
            C0=pikepdf.Array([0, 0, 0, 0]),
            C1=pikepdf.Array([0, 0, 0, 1]),
            N=1,
        )
    )
    sep_cs = pdf.make_indirect(
        pikepdf.Array(
            [
                pikepdf.Name("/Separation"),
                pikepdf.Name("/SpotGuardrail"),
                pikepdf.Name("/DeviceCMYK"),
                sep_func,
            ]
        )
    )
    icc_cs = pdf.make_indirect(
        pikepdf.Array([pikepdf.Name("/ICCBased"), icc_stream])
    )

    cs_dict = pikepdf.Dictionary()
    cs_dict[pikepdf.Name("/Sep2")] = sep_cs
    cs_dict[pikepdf.Name("/CS_ICC4")] = icc_cs

    gs_dict = pikepdf.Dictionary()
    gs_dict[pikepdf.Name("/GS3")] = pdf.make_indirect(
        pikepdf.Dictionary(OP=True, op=True, OPM=1)
    )

    font_dict = pikepdf.Dictionary()
    font_dict[pikepdf.Name("/F1")] = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name("/Font"),
            Subtype=pikepdf.Name("/Type1"),
            BaseFont=pikepdf.Name("/Helvetica"),
            Encoding=pikepdf.Name("/WinAnsiEncoding"),
        )
    )

    resources = pikepdf.Dictionary()
    resources[pikepdf.Name("/ColorSpace")] = cs_dict
    resources[pikepdf.Name("/ExtGState")] = gs_dict
    resources[pikepdf.Name("/Font")] = font_dict
    page.obj[pikepdf.Name("/Resources")] = resources

    # ── Content stream: 6 object cô lập ─────────────────────────────────────
    cmyk = " ".join(f"{v:.4f}" for v in CMYK_VALUES)
    op_cmyk = " ".join(f"{v:.4f}" for v in OVERPRINT_CMYK)
    rgb = " ".join(f"{v:.4f}" for v in TARGET_RGB)
    icc_rgb = " ".join(f"{v:.4f}" for v in ICC_RGB)
    text_cmyk = " ".join(f"{v:.4f}" for v in TEXT_CMYK)
    tx, ty = TEXT_BASELINE

    fragments = [
        # idx0 — target RGB thuần
        _fragment([f"{rgb} rg", _rect_lines(TARGET_BBOX), "f"]),
        # idx1 — CMYK
        _fragment([f"{cmyk} k", _rect_lines(CMYK_BBOX), "f"]),
        # idx2 — spot/separation
        _fragment(["/Sep2 cs", f"{SPOT_TINT:.4f} scn", _rect_lines(SPOT_BBOX), "f"]),
        # idx3 — overprint (ExtGState) + CMYK
        _fragment(["/GS3 gs", f"{op_cmyk} k", _rect_lines(OVERPRINT_BBOX), "f"]),
        # idx4 — ICCBased colorspace
        _fragment(["/CS_ICC4 cs", f"{icc_rgb} scn", _rect_lines(ICC_BBOX), "f"]),
        # idx5 — text (CMYK), font chuẩn Helvetica
        _fragment(
            [
                f"{text_cmyk} k",
                "BT",
                "/F1 12 Tf",
                f"{tx:.4f} {ty:.4f} Td",
                "(Hello) Tj",
                "ET",
            ]
        ),
    ]
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
        "".join(fragments).encode("latin-1")
    )
    pdf.save(path)
    pdf.close()


# ─────────────────────────────────────────────────────────────────────────────
#  Xác nhận màu của object KHÔNG mục tiêu giữ NGUYÊN trong Working_File
# ─────────────────────────────────────────────────────────────────────────────
def assert_untouched_color_preserved(working_path: str) -> None:
    """
    Mở Working_File đã ghi và xác nhận:
      1. Mỗi chữ ký Color_Operators của object KHÔNG mục tiêu (idx1..idx4) còn
         hiện diện ĐÚNG SỐ LẦN trong content stream.
      2. Định nghĩa `/Separation` colorspace còn nguyên trong Resources.
      3. Định nghĩa `/ICCBased` colorspace còn nguyên (đúng /N + bytes ICC).
      4. ExtGState overprint (`/OP /op /OPM`) còn nguyên.
    """
    with pikepdf.Pdf.open(working_path) as pdf:
        page = pdf.pages[0]

        # 1) Color_Operators của Untouched_Object giữ nguyên (operator + giá trị).
        sigs = _color_signatures(page)
        for expected in UNTOUCHED_COLOR_SIGS:
            got = sigs.count(expected)
            assert got == 1, (
                f"Vi phạm bảo toàn màu in: chữ ký {expected} kỳ vọng 1 lần, "
                f"Working_File có {got} lần (file={working_path})"
            )

        resources = page.obj.get("/Resources")
        assert resources is not None, "Mất toàn bộ /Resources sau khi ghi"
        cs_dict = resources.get("/ColorSpace")
        assert cs_dict is not None, "Mất /Resources/ColorSpace sau khi ghi"

        # 2) /Separation colorspace giữ nguyên (Yêu cầu 4.4).
        sep = cs_dict.get("/Sep2")
        assert sep is not None, "Mất định nghĩa /Separation colorspace (/Sep2)"
        assert str(sep[0]) == "/Separation", (
            f"Colorspace /Sep2 không còn là /Separation: {sep[0]}"
        )
        assert str(sep[1]) == "/SpotGuardrail", "Mất tên spot /SpotGuardrail"

        # 3) /ICCBased colorspace giữ nguyên (Yêu cầu 4.6).
        icc = cs_dict.get("/CS_ICC4")
        assert icc is not None, "Mất định nghĩa /ICCBased colorspace (/CS_ICC4)"
        assert str(icc[0]) == "/ICCBased", (
            f"Colorspace /CS_ICC4 không còn là /ICCBased: {icc[0]}"
        )
        icc_stream = icc[1]
        assert int(icc_stream["/N"]) == ICC_N, "Sai /N của /ICCBased stream"
        assert len(bytes(icc_stream.read_bytes())) > 0, "Mất bytes ICC profile"

        # 4) ExtGState overprint giữ nguyên (Yêu cầu 4.5).
        gs_dict = resources.get("/ExtGState")
        assert gs_dict is not None, "Mất /Resources/ExtGState sau khi ghi"
        gs = gs_dict.get("/GS3")
        assert gs is not None, "Mất ExtGState overprint (/GS3)"
        assert bool(gs.get("/OP")) is True, "Mất /OP (overprint stroke)"
        assert bool(gs.get("/op")) is True, "Mất /op (overprint fill)"
        assert int(gs.get("/OPM")) == 1, "Mất/đổi /OPM (overprint mode)"


# ─────────────────────────────────────────────────────────────────────────────
#  Fixtures
# ─────────────────────────────────────────────────────────────────────────────
@pytest.fixture()
def spike_path(tmp_path):
    """Đường dẫn file spike gốc (CHỈ ĐỌC trong các test — không bị ghi đè)."""
    p = tmp_path / "spike_original.pdf"
    build_spike_pdf(str(p))
    return str(p)


def _target_vector_meta() -> ObjMeta:
    """ObjMeta cho object mục tiêu idx0 (vector RGB thuần)."""
    return ObjMeta(id="target-rgb", drawIndex=0, type="vector", bbox=list(TARGET_BBOX))


def _text_meta(spike_path: str) -> ObjMeta:
    """ObjMeta cho object text idx5 — bbox lấy từ span do Object_Mapper phân đoạn."""
    with pikepdf.Pdf.open(spike_path) as pdf:
        page = pdf.pages[0]
        spans = build_op_spans(page, pdf=pdf)
        text_spans = [s for s in spans if s.kind == "text"]
        assert text_spans, "Spike phải có đúng một cụm text để edit_text"
        bbox = list(text_spans[0].bbox)
    return ObjMeta(id="text-hello", drawIndex=0, type="text", bbox=bbox)


# ═════════════════════════════════════════════════════════════════════════════
#  Sanity: spike gốc chứa đủ Color_Operators màu in
# ═════════════════════════════════════════════════════════════════════════════
def test_spike_contains_all_print_color_operators(spike_path):
    """Tiền đề: spike gốc thực sự chứa k/scn/gs/cs + /Separation + /ICCBased."""
    with pikepdf.Pdf.open(spike_path) as pdf:
        page = pdf.pages[0]
        sigs = _color_signatures(page)
        for expected in UNTOUCHED_COLOR_SIGS:
            assert sigs.count(expected) == 1, (
                f"Spike gốc thiếu chữ ký màu kỳ vọng: {expected}"
            )
    # Cấu trúc resource cũng phải có sẵn (tái dùng chính bộ assert).
    assert_untouched_color_preserved(spike_path)


# ═════════════════════════════════════════════════════════════════════════════
#  GUARDRAIL — từng đường ghi của stream_editor + edit_io.apply_and_save
# ═════════════════════════════════════════════════════════════════════════════
def test_delete_preserves_untouched_print_color(spike_path, tmp_path):
    """delete_objects (xóa idx0) → màu idx1..idx4 giữ nguyên qua Working_File."""
    out = tmp_path / "after_delete.pdf"

    def mutate(pdf):
        page = pdf.pages[0]
        return delete_objects(page, [_target_vector_meta()], pdf)

    saved, result = apply_and_save(spike_path, mutate, output_path=str(out))
    assert result.changed is True
    assert_untouched_color_preserved(saved)


def test_move_preserves_untouched_print_color(spike_path, tmp_path):
    """move_objects (dịch idx0) → màu idx1..idx4 giữ nguyên."""
    out = tmp_path / "after_move.pdf"

    def mutate(pdf):
        page = pdf.pages[0]
        return move_objects(page, [_target_vector_meta()], 25.0, 15.0, pdf)

    saved, result = apply_and_save(spike_path, mutate, output_path=str(out))
    assert result.changed is True
    assert_untouched_color_preserved(saved)


def test_resize_preserves_untouched_print_color(spike_path, tmp_path):
    """resize_objects (scale idx0) → màu idx1..idx4 giữ nguyên."""
    out = tmp_path / "after_resize.pdf"

    def mutate(pdf):
        page = pdf.pages[0]
        return resize_objects(page, [_target_vector_meta()], 1.5, 0.75, "sw", pdf)

    saved, result = apply_and_save(spike_path, mutate, output_path=str(out))
    assert result.changed is True
    assert_untouched_color_preserved(saved)


def test_rotate_preserves_untouched_print_color(spike_path, tmp_path):
    """rotate_objects (xoay idx0) → màu idx1..idx4 giữ nguyên."""
    out = tmp_path / "after_rotate.pdf"

    def mutate(pdf):
        page = pdf.pages[0]
        return rotate_objects(page, [_target_vector_meta()], 30.0, pdf)

    saved, result = apply_and_save(spike_path, mutate, output_path=str(out))
    assert result.changed is True
    assert_untouched_color_preserved(saved)


def test_edit_text_preserves_untouched_print_color(spike_path, tmp_path):
    """edit_text (sửa idx5) → màu idx1..idx4 giữ nguyên."""
    out = tmp_path / "after_edit_text.pdf"
    meta = _text_meta(spike_path)

    def mutate(pdf):
        page = pdf.pages[0]
        return edit_text(page, meta, "World", pdf)

    saved, result = apply_and_save(spike_path, mutate, output_path=str(out))
    assert result.changed is True
    assert_untouched_color_preserved(saved)


def test_add_text_preserves_untouched_print_color(spike_path, tmp_path):
    """add_text (chỉ bổ sung) → toàn bộ màu in cũ giữ nguyên."""
    out = tmp_path / "after_add_text.pdf"

    def mutate(pdf):
        page = pdf.pages[0]
        return add_text(page, "New label", [120.0, 320.0, 300.0, 350.0], pdf, font_size=14.0)

    saved, result = apply_and_save(spike_path, mutate, output_path=str(out))
    assert result.changed is True
    assert_untouched_color_preserved(saved)


def test_add_image_preserves_untouched_print_color(spike_path, tmp_path):
    """add_image (chỉ bổ sung) → toàn bộ màu in cũ giữ nguyên."""
    out = tmp_path / "after_add_image.pdf"

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (120, 30, 200)).save(buf, format="PNG")
    img_bytes = buf.getvalue()

    def mutate(pdf):
        page = pdf.pages[0]
        return add_image(page, img_bytes, [430.0, 300.0, 500.0, 360.0], pdf)

    saved, result = apply_and_save(spike_path, mutate, output_path=str(out))
    assert result.changed is True
    assert_untouched_color_preserved(saved)


def test_all_write_paths_chained_preserve_print_color(spike_path, tmp_path):
    """
    Guardrail tổng: áp LIÊN TIẾP nhiều đường ghi trên CÙNG một document rồi lưu
    một lần — màu idx1..idx4 vẫn giữ nguyên (mô phỏng phiên chỉnh sửa thực tế).
    """
    out = tmp_path / "after_chain.pdf"
    text_meta = _text_meta(spike_path)

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (10, 200, 50)).save(buf, format="PNG")
    img_bytes = buf.getvalue()

    def mutate(pdf):
        page = pdf.pages[0]
        move_objects(page, [_target_vector_meta()], 10.0, 5.0, pdf)
        edit_text(page, text_meta, "Edited", pdf)
        add_text(page, "Footer", [120.0, 320.0, 300.0, 350.0], pdf)
        add_image(page, img_bytes, [430.0, 300.0, 500.0, 360.0], pdf)
        return True

    saved, _ = apply_and_save(spike_path, mutate, output_path=str(out))
    assert_untouched_color_preserved(saved)
