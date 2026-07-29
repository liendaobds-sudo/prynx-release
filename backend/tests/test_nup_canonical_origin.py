"""Luồng bình bản phải chuẩn hoá gốc MediaBox về (0,0) trước khi layout.

Bug (đo được, 2026-07-28): cả tầng đặt tem giả định trang bắt đầu tại (0,0) —
`pdf_ops.page_rect()` trả `Rect(0, 0, w, h)` bỏ hẳn mb[0]/mb[1], `show_pdf_page`
tính tâm nguồn bằng `clip.x0 + clip_w/2`, `pdf_content_parser` lật y quanh
`mb[3]-mb[1]` thay vì `mb[3]`.

Đo trên trang MediaBox [50,30,250,130] trước khi sửa:
  - nhánh KHÔNG die-cut lệch (+50, +30) pt;
  - parser trả bbox đường bế y ÂM: (60, -20, 240, 60);
  - nhánh die-cut lệch 0 vì TỰ TRIỆT TIÊU (rel_tx0 dùng x raw, show_pdf_page map
    content-0 → mép ô) — nên KHÔNG được sửa riêng show_pdf_page, sẽ làm lệch nhánh này.

Fix: chuẩn hoá tại đúng một chỗ ở cửa vào pipeline (`_canonicalize_page_space`),
cùng cách VDP đã làm (`test_canonicalize_offset_mediabox_moves_origin_to_zero`).
"""
import os
import re

import pikepdf
import pytest

from app.workers import nup_engine, pdf_wrapper
from app.workers.pdf_ops import Rect, show_pdf_page

MB_OFFSET = [50.0, 30.0, 250.0, 130.0]
DIE_RAW = (60.0, 40.0, 240.0, 120.0)   # thụt 10pt mỗi cạnh so với MediaBox
PAGE_W = MB_OFFSET[2] - MB_OFFSET[0]
PAGE_H = MB_OFFSET[3] - MB_OFFSET[1]

# bbox đường bế trong hệ TƯƠNG ĐỐI GỐC TRANG (x - mb[0]; y lật quanh mb[3]).
# Đường bế thụt đều 10pt nên giá trị này đối xứng.
PAGE_RELATIVE_DIE = (10.0, 10.0, 190.0, 90.0)

# Sai số hệ toạ độ của `pdf_content_parser` so với hệ trên — phép DỊCH THUẦN.
# Đổi về (0.0, 0.0) nếu parser được chuyển sang hệ tương đối gốc trang.
PARSER_DELTA = (MB_OFFSET[0], -MB_OFFSET[1])
DEST_H = 400.0
CELL = Rect(100.0, 100.0, 100.0 + PAGE_W, 100.0 + PAGE_H)


@pytest.fixture(autouse=True)
def _temp_in_tmp_path(tmp_path, monkeypatch):
    """File canonical tạm ghi vào tmp_path để pytest tự dọn."""
    monkeypatch.setattr(nup_engine.tempfile, "gettempdir", lambda: str(tmp_path))


def _make_page(path, mediabox, rotate=0, with_die=True):
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(mediabox[2] - mediabox[0], mediabox[3] - mediabox[1]))
    page = pdf.pages[0]
    page.obj[pikepdf.Name("/MediaBox")] = pikepdf.Array(mediabox)
    page.obj[pikepdf.Name("/TrimBox")] = pikepdf.Array(mediabox)
    if rotate:
        page.obj[pikepdf.Name("/Rotate")] = rotate
    if with_die:
        x0, y0, x1, y1 = DIE_RAW
        page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
            f"0 1 0 0 K 0.5 w {x0} {y0} m {x1} {y0} l {x1} {y1} l {x0} {y1} l h S\n".encode()
        )
    pdf.save(str(path))
    pdf.close()
    return str(path)


def _mediabox(path):
    with pikepdf.Pdf.open(path) as pdf:
        return [float(v) for v in pdf.pages[0].obj["/MediaBox"]]


def _box(path, name):
    with pikepdf.Pdf.open(path) as pdf:
        return [float(v) for v in pdf.pages[0].obj[name]]


def _die_rect(path):
    doc = pdf_wrapper.open(path)
    try:
        paths = doc[0].extract_vector_paths()
        assert paths, "không trích được path"
        r = paths[0]["rect"]
        return (r.x0, r.y0, r.x1, r.y1)
    finally:
        doc.close()


def _place_and_read_cm(src_path, target_rect):
    with pikepdf.Pdf.open(src_path) as src:
        dest = pikepdf.Pdf.new()
        dest.add_blank_page(page_size=(600, DEST_H))
        dp = dest.pages[0]
        show_pdf_page(dest, dp, target_rect, src, 0)
        contents = dp.obj["/Contents"]
        raw = (
            b"\n".join(bytes(s.read_bytes()) for s in contents)
            if isinstance(contents, pikepdf.Array)
            else bytes(contents.read_bytes())
        ).decode("latin-1")
    found = re.findall(r"([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) cm", raw)
    assert found, "không tìm thấy ma trận cm"
    return [float(v) for v in found[-1]]


# --------------------------------------------------------------- chuẩn hoá

def test_offset_origin_is_canonicalized(tmp_path):
    src = _make_page(tmp_path / "offset.pdf", MB_OFFSET)
    canon, is_temp = nup_engine._canonicalize_page_space(src, "t1")
    assert is_temp is True, "gốc MediaBox lệch phải được chuẩn hoá"
    assert _mediabox(canon) == pytest.approx([0.0, 0.0, PAGE_W, PAGE_H], abs=1e-4)


def test_already_canonical_is_untouched(tmp_path):
    """Gốc đã (0,0) + không xoay → giữ NGUYÊN file, không tạo temp."""
    src = _make_page(tmp_path / "plain.pdf", [0.0, 0.0, PAGE_W, PAGE_H])
    canon, is_temp = nup_engine._canonicalize_page_space(src, "t2")
    assert is_temp is False
    assert canon == src


def test_tiny_offset_below_epsilon_is_ignored(tmp_path):
    """Lệch 0.001pt là nhiễu số thực — không rewrite file vì nó."""
    src = _make_page(tmp_path / "eps.pdf", [0.001, 0.0, 0.001 + PAGE_W, PAGE_H])
    canon, is_temp = nup_engine._canonicalize_page_space(src, "t3")
    assert is_temp is False
    assert canon == src


def test_content_is_translated_so_die_bbox_is_symmetric(tmp_path):
    """Đường bế thụt đều 10pt → sau chuẩn hoá bbox phải ĐỐI XỨNG.

    Trước chuẩn hoá bbox KHÔNG đối xứng, vì `pdf_content_parser` trả toạ độ theo hệ
    riêng: x giữ RAW (thiếu `- mb[0]`), y lật quanh `mb[3]-mb[1]` thay vì `mb[3]`.
    Sai số là phép DỊCH THUẦN `Δ = (+mb[0], −mb[1])`.

    [AUDIT §4.1] Test tính giá trị mong đợi TỪ Δ, không ghim số magic. Bản trước ghim
    thẳng `(60, -20, 240, 60)` nên nếu ai đổi parser sang hệ tương đối gốc trang
    (lô 3 của docs/BAO_CAO_AUDIT_HE_TOA_DO_PARSER_2026-07-28.md) thì test đỏ DÙ SỬA
    ĐÚNG. Nay chỉ cần đặt `PARSER_DELTA = (0.0, 0.0)` là test khớp hệ mới.
    """
    expected_before = (
        PAGE_RELATIVE_DIE[0] + PARSER_DELTA[0],
        PAGE_RELATIVE_DIE[1] + PARSER_DELTA[1],
        PAGE_RELATIVE_DIE[2] + PARSER_DELTA[0],
        PAGE_RELATIVE_DIE[3] + PARSER_DELTA[1],
    )

    src = _make_page(tmp_path / "offset.pdf", MB_OFFSET)
    assert _die_rect(src) == pytest.approx(expected_before, abs=1e-3)

    # Sau chuẩn hoá, gốc MediaBox = 0 nên Δ triệt tiêu → bbox về đúng hệ trang.
    canon, _ = nup_engine._canonicalize_page_space(src, "t4")
    assert _die_rect(canon) == pytest.approx(PAGE_RELATIVE_DIE, abs=1e-3)


def test_trimbox_is_translated_with_content(tmp_path):
    src = _make_page(tmp_path / "offset.pdf", MB_OFFSET)
    canon, _ = nup_engine._canonicalize_page_space(src, "t5")
    assert _box(canon, "/TrimBox") == pytest.approx([0.0, 0.0, PAGE_W, PAGE_H], abs=1e-4)


# ------------------------------------------------------------ đặt tem lên tờ

def test_non_diecut_branch_lands_at_cell_origin(tmp_path):
    """Nhánh không die-cut: trước fix lệch đúng (mb[0], mb[1])."""
    src = _make_page(tmp_path / "offset.pdf", MB_OFFSET)

    a, _b, _c, d, e, f = _place_and_read_cm(src, CELL)
    assert e - (CELL.x0 - MB_OFFSET[0] * a) == pytest.approx(50.0, abs=1e-3)
    assert f - ((DEST_H - CELL.y1) - MB_OFFSET[1] * d) == pytest.approx(30.0, abs=1e-3)

    canon, _ = nup_engine._canonicalize_page_space(src, "t6")
    a2, _b2, _c2, d2, e2, f2 = _place_and_read_cm(canon, CELL)
    assert e2 == pytest.approx(CELL.x0, abs=1e-3)
    assert f2 == pytest.approx(DEST_H - CELL.y1, abs=1e-3)


def test_diecut_branch_still_lands_at_cell_origin(tmp_path):
    """Nhánh die-cut đang TỰ TRIỆT TIÊU sai số — chuẩn hoá không được làm nó lệch."""
    src = _make_page(tmp_path / "offset.pdf", MB_OFFSET)
    canon, _ = nup_engine._canonicalize_page_space(src, "t7")

    dx0, dy0, _dx1, _dy1 = _die_rect(canon)
    mb = _mediabox(canon)
    vis_w, vis_h = mb[2] - mb[0], mb[3] - mb[1]
    shift_x, shift_y = CELL.x0 - dx0, CELL.y0 - dy0
    target = Rect(shift_x, shift_y, shift_x + vis_w, shift_y + vis_h)

    a, _b, _c, _d, e, _f = _place_and_read_cm(canon, target)
    die_left_on_sheet = e + dx0 * a
    assert die_left_on_sheet == pytest.approx(CELL.x0, abs=1e-3)


# ------------------------------------------------- không phá hành vi /Rotate

def test_rotated_page_keeps_being_canonicalized(tmp_path):
    """Trang xoay 90 + gốc lệch: vẫn hoán w/h, /Rotate = 0, gốc (0,0)."""
    src = _make_page(tmp_path / "rot.pdf", MB_OFFSET, rotate=90)
    canon, is_temp = nup_engine._canonicalize_page_space(src, "t8")
    assert is_temp is True
    assert _mediabox(canon) == pytest.approx([0.0, 0.0, PAGE_H, PAGE_W], abs=1e-4)
    with pikepdf.Pdf.open(canon) as pdf:
        assert int(pdf.pages[0].obj.get("/Rotate", 0)) == 0


def test_blank_page_without_contents_is_handled(tmp_path):
    """Trang trắng gốc lệch không có /Contents → không được crash."""
    src = _make_page(tmp_path / "blank.pdf", MB_OFFSET, with_die=False)
    with pikepdf.Pdf.open(src, allow_overwriting_input=True) as pdf:
        if "/Contents" in pdf.pages[0].obj:
            del pdf.pages[0].obj[pikepdf.Name("/Contents")]
        pdf.save(str(tmp_path / "blank2.pdf"))

    canon, is_temp = nup_engine._canonicalize_page_space(str(tmp_path / "blank2.pdf"), "t9")
    assert is_temp is True
    assert _mediabox(canon) == pytest.approx([0.0, 0.0, PAGE_W, PAGE_H], abs=1e-4)


# ----------------------------------------- context manager công khai (AUDIT §2.1)

def test_canonical_page_space_cm_removes_temp(tmp_path):
    """`canonical_page_space` yield đường chuẩn hoá rồi tự dọn file tạm."""
    src = _make_page(tmp_path / "offset.pdf", MB_OFFSET)
    with nup_engine.canonical_page_space(src, "cm1") as canon:
        assert canon != src
        assert os.path.exists(canon)
        assert _mediabox(canon) == pytest.approx([0.0, 0.0, PAGE_W, PAGE_H], abs=1e-4)
        seen = canon
    assert not os.path.exists(seen), "file tạm phải được xoá khi ra khỏi block"


def test_canonical_page_space_cm_removes_temp_on_exception(tmp_path):
    """Thân block ném ngoại lệ vẫn không được rò rỉ file tạm."""
    src = _make_page(tmp_path / "offset.pdf", MB_OFFSET)
    seen = None
    with pytest.raises(RuntimeError, match="boom"):
        with nup_engine.canonical_page_space(src, "cm2") as canon:
            seen = canon
            raise RuntimeError("boom")
    assert seen is not None
    assert not os.path.exists(seen)


def test_canonical_page_space_cm_passthrough_when_already_canonical(tmp_path):
    """File đã chuẩn → yield chính nó, KHÔNG được xoá file gốc của người dùng."""
    src = _make_page(tmp_path / "plain.pdf", [0.0, 0.0, PAGE_W, PAGE_H])
    with nup_engine.canonical_page_space(src, "cm3") as canon:
        assert canon == src
    assert os.path.exists(src), "file gốc không bao giờ được xoá"


def test_rotated_page_trim_matches_export_after_fix(tmp_path):
    """[AUDIT §2.1] Chốt lệch ĐO ĐƯỢC: /Rotate=90 làm preview và export khác khổ.

    Trước fix: đọc thô `page.rect` → (200, 100); export sau chuẩn hoá → (100, 200).
    Sau fix: đường nào cũng đi qua `canonical_page_space` nên cùng thấy (100, 200).
    """
    src = _make_page(tmp_path / "rot.pdf", [0.0, 0.0, 200.0, 100.0], rotate=90)

    doc = pdf_wrapper.open(src)
    try:
        raw = (doc[0].rect.width, doc[0].rect.height)
    finally:
        doc.close()
    assert raw == (200.0, 100.0), "đọc thô vẫn là khổ CHƯA xoay"

    with nup_engine.canonical_page_space(src, "cm4") as canon:
        doc = pdf_wrapper.open(canon)
        try:
            canonical = (doc[0].rect.width, doc[0].rect.height)
        finally:
            doc.close()
    assert canonical == (100.0, 200.0), "sau chuẩn hoá phải hoán w/h"
    assert raw != canonical, "đây chính là lệch mà lô 2 bịt"
