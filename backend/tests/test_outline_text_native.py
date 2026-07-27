"""Outline chữ bằng fontTools — và chốt verify bắt được chữ đặt sai chỗ.

Rủi ro riêng của đường này: một ma trận chữ sai vẫn cho ra file "có chữ", trông
bình thường trên màn hình, và lỗi chỉ lộ khi bản in đã chạy. Vì vậy phần đáng
test nhất không phải "outline chạy được" mà là **verify có bắt được khi nó
sai** — nếu chốt đó hỏng thì cả đường này không dùng được.
"""

import asyncio
import os

import pikepdf
import pytest

from app.core import outline_text


@pytest.fixture
def text_pdf(tmp_path):
    """Trang có font TrueType NHÚNG thật và một dòng chữ."""
    src_font = os.path.join("app", "assets", "fonts", "DejaVuSans.ttf")
    if not os.path.isfile(src_font):
        pytest.skip("thiếu DejaVuSans.ttf")
    data = open(src_font, "rb").read()

    pdf = pikepdf.Pdf.new()
    ff = pikepdf.Stream(pdf, data)
    ff["/Length1"] = len(data)
    desc = pikepdf.Dictionary(
        Type=pikepdf.Name("/FontDescriptor"), FontName=pikepdf.Name("/DejaVuSans"),
        Flags=32, ItalicAngle=0, Ascent=928, Descent=-236, CapHeight=700, StemV=80,
        FontBBox=[-1021, -463, 1793, 1232], FontFile2=pdf.make_indirect(ff),
    )
    font = pikepdf.Dictionary(
        Type=pikepdf.Name("/Font"), Subtype=pikepdf.Name("/TrueType"),
        BaseFont=pikepdf.Name("/DejaVuSans"), FirstChar=32, LastChar=126,
        Widths=[600] * 95, Encoding=pikepdf.Name("/WinAnsiEncoding"),
        FontDescriptor=pdf.make_indirect(desc),
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 300, 150],
        Resources=pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=pdf.make_indirect(font))),
        Contents=pdf.make_indirect(pikepdf.Stream(
            pdf, b"0 0 0 1 k BT /F1 36 Tf 20 60 Td (PRYNX) Tj ET\n"
        )),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    path = tmp_path / "text.pdf"
    pdf.save(str(path))
    pdf.close()
    return str(path)


def test_outline_replaces_text_with_paths_and_drops_font_resource(text_pdf, tmp_path):
    out = str(tmp_path / "outlined.pdf")
    result = outline_text.outline_fonts(text_pdf, out)

    assert result["supported"], result["warnings"]
    assert result["glyphs"] == 5, "PRYNX là 5 glyph"

    with pikepdf.open(out) as pdf:
        data = bytes(pdf.pages[0].Contents.read_bytes())
        # Còn /Font trong resources thì file vẫn phụ thuộc font — đúng thứ
        # người dùng bấm nút để thoát khỏi.
        assert pdf.pages[0].Resources.get("/Font") is None
    assert b" Tj" not in data and b"BT" not in data, "vẫn còn toán tử chữ"
    assert b" c\n" in data or b" l\n" in data, "không có đường vector nào"


def test_verify_catches_text_moved_to_the_wrong_place(text_pdf, tmp_path):
    """Chốt an toàn: dịch chữ đi 30pt thì verify PHẢI từ chối.

    Không có test này, ta chỉ biết verify "chạy", không biết nó có nhìn thấy gì
    không — và một chốt an toàn không bao giờ kêu thì bằng không có.
    """
    moved = str(tmp_path / "moved.pdf")
    with pikepdf.open(text_pdf) as pdf:
        pdf.pages[0].Contents = pdf.make_indirect(pikepdf.Stream(
            pdf, b"0 0 0 1 k BT /F1 36 Tf 50 90 Td (PRYNX) Tj ET\n"
        ))
        pdf.save(moved)

    ok, reason = outline_text.verify_outline(text_pdf, moved)
    assert ok is False, "verify bỏ lọt chữ đặt sai chỗ"
    assert reason


def test_verify_accepts_a_correct_outline(text_pdf, tmp_path):
    out = str(tmp_path / "ok.pdf")
    outline_text.outline_fonts(text_pdf, out)
    ok, reason = outline_text.verify_outline(text_pdf, out)
    assert ok, reason


def test_incomplete_type0_font_is_declined_not_guessed(tmp_path):
    """Type0 thiếu tài nguyên bắt buộc phải bị từ chối thay vì đoán glyph."""
    pdf = pikepdf.Pdf.new()
    font = pikepdf.Dictionary(
        Type=pikepdf.Name("/Font"), Subtype=pikepdf.Name("/Type0"),
        BaseFont=pikepdf.Name("/SomeCID"),
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 200, 200],
        Resources=pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=pdf.make_indirect(font))),
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"BT /F1 12 Tf (x) Tj ET\n")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    src = tmp_path / "type0.pdf"
    pdf.save(str(src))
    pdf.close()

    result = outline_text.outline_fonts(str(src), str(tmp_path / "o.pdf"))
    assert result["supported"] is False
    assert any("Type0" in w or "phạm vi" in w for w in result["warnings"])


def test_action_outline_without_ghostscript(text_pdf, tmp_path, monkeypatch):
    from app.config import settings
    from app.core import gs_usage
    from app.core.action_engine import ActionEngine

    missing = str(tmp_path / "khong-co-gs.exe")
    monkeypatch.setattr(settings, "GHOSTSCRIPT_PATH", missing)
    gs_usage.reset_for_tests()

    engine = ActionEngine()
    engine.gs_path = missing
    result = asyncio.run(engine.execute(text_pdf, "OUTLINE_FONTS"))

    assert result.success, result.error
    assert result.log[0].engine == "pikepdf"
    assert gs_usage.summary()["total_gs_calls"] == 0
    assert result.log[0].report["glyphs_outlined"] == 5


def test_form_with_own_font_is_outlined_without_page_font(text_pdf, tmp_path):
    """OUT-FONT (audit 2026-07-27 §4.1): font riêng của Form không được bỏ sót."""
    from app.core.outline_fonts import count_live_text

    src = str(tmp_path / "form_only_font.pdf")
    out = str(tmp_path / "form_only_font_out.pdf")
    with pikepdf.open(text_pdf) as pdf:
        page = pdf.pages[0]
        font_ref = page.Resources.Font.F1
        form = pdf.make_stream(b"0 0 0 1 k BT /F1 36 Tf 20 60 Td (FORMTEXT) Tj ET")
        form["/Type"] = pikepdf.Name("/XObject")
        form["/Subtype"] = pikepdf.Name("/Form")
        form["/BBox"] = pikepdf.Array([0, 0, 300, 150])
        form["/Resources"] = pikepdf.Dictionary(
            Font=pikepdf.Dictionary(F1=font_ref)
        )
        page["/Resources"] = pikepdf.Dictionary(
            XObject=pikepdf.Dictionary(Fm=pdf.make_indirect(form))
        )
        page["/Contents"] = pdf.make_stream(b"q /Fm Do Q")
        pdf.save(src)

    result = outline_text.outline_fonts(src, out)

    assert result["supported"], result["warnings"]
    assert result["glyphs"] == 8
    assert count_live_text(out)["total"] == 0
    with pikepdf.open(out) as pdf:
        form = pdf.pages[0].Resources.XObject.Fm
        assert form.Resources.get("/Font") is None
        assert b"Tj" not in bytes(form.read_bytes())


@pytest.mark.parametrize(
    ("mode", "paint_op"),
    [
        (0, "f"),
        (1, "S"),
        (2, "B"),
        (3, None),
        (4, "f"),
        (5, "S"),
        (6, "B"),
        (7, None),
    ],
)
def test_text_render_modes_keep_fill_stroke_and_clip(
    text_pdf, tmp_path, mode, paint_op
):
    """OUT-FONT (audit 2026-07-27 §4.2): giữ đúng semantics Tr=0..7."""
    from app.core.outline_fonts import count_live_text

    src = str(tmp_path / f"tr_{mode}.pdf")
    out = str(tmp_path / f"tr_{mode}_out.pdf")
    tail = b" 0 0 300 150 re f" if mode >= 4 else b""
    with pikepdf.open(text_pdf) as pdf:
        pdf.pages[0].Contents = pdf.make_stream(
            b"0 0 0 1 k 0 0 0 1 K 0.5 w "
            + f"BT /F1 36 Tf 20 60 Td {mode} Tr (P) Tj ET".encode()
            + tail
        )
        pdf.save(src)

    result = outline_text.outline_fonts(src, out)

    assert result["supported"], result["warnings"]
    assert count_live_text(out)["total"] == 0
    with pikepdf.open(out) as pdf:
        ops = [
            str(instruction.operator)
            for instruction in pikepdf.parse_content_stream(pdf.pages[0])
        ]

    assert "BT" not in ops and "Tj" not in ops and "ET" not in ops
    if mode == 3:
        assert result["glyphs"] == 0
        assert not any(op in {"m", "l", "c"} for op in ops)
    else:
        assert result["glyphs"] == 1
    if paint_op is not None:
        assert paint_op in ops
    if mode >= 4:
        assert "W" in ops and "n" in ops
    else:
        assert "W" not in ops
    if mode == 7:
        # `f` phía sau là hình chữ nhật bị clip; trước W không được paint glyph.
        assert not any(op in {"f", "S", "B"} for op in ops[:ops.index("W")])


def test_verify_checks_every_page(text_pdf, tmp_path):
    """OUT-FONT (audit 2026-07-27 §4.2): lỗi trang 2 không được lọt."""
    original = str(tmp_path / "two_pages.pdf")
    changed = str(tmp_path / "two_pages_changed.pdf")
    with pikepdf.open(text_pdf) as pdf:
        first = pdf.pages[0]
        page2 = pikepdf.Dictionary(
            Type=pikepdf.Name("/Page"),
            MediaBox=pikepdf.Array([0, 0, 300, 150]),
            Resources=first.Resources,
            Contents=pdf.make_indirect(
                pikepdf.Stream(pdf, b"0 0 0 1 k BT /F1 36 Tf 20 60 Td (PRYNX) Tj ET")
            ),
        )
        pdf.pages.append(pikepdf.Page(pdf.make_indirect(page2)))
        pdf.save(original)

    with pikepdf.open(original) as pdf:
        pdf.pages[1].Contents = pdf.make_stream(
            b"0 0 0 1 k BT /F1 36 Tf 80 60 Td (PRYNX) Tj ET"
        )
        pdf.save(changed)

    ok, reason = outline_text.verify_outline(original, changed)
    assert ok is False
    assert "trang 2" in reason


def test_verify_local_iou_catches_small_shift_on_large_page(text_pdf, tmp_path):
    """Mean/coverage toàn trang từng bỏ lọt chữ nhỏ dịch trên nền trắng lớn."""
    original = str(tmp_path / "large_page.pdf")
    changed = str(tmp_path / "large_page_changed.pdf")
    with pikepdf.open(text_pdf) as pdf:
        page = pdf.pages[0]
        page.MediaBox = pikepdf.Array([0, 0, 612, 792])
        page.Contents = pdf.make_stream(
            b"0 0 0 1 k BT /F1 12 Tf 40 400 Td (PRYNX) Tj ET"
        )
        pdf.save(original)

    with pikepdf.open(original) as pdf:
        pdf.pages[0].Contents = pdf.make_stream(
            b"0 0 0 1 k BT /F1 12 Tf 70 400 Td (PRYNX) Tj ET"
        )
        pdf.save(changed)

    ok, reason = outline_text.verify_outline(original, changed)
    assert ok is False
    assert "lệch cục bộ" in reason


def test_q_q_restores_text_state(text_pdf, tmp_path):
    """q/Q phải khôi phục font/size, không chỉ CTM."""
    from app.core.outline_fonts import count_live_text

    src = str(tmp_path / "graphics_state.pdf")
    out = str(tmp_path / "graphics_state_out.pdf")
    with pikepdf.open(text_pdf) as pdf:
        pdf.pages[0].Contents = pdf.make_stream(
            b"0 0 0 1 k "
            b"BT /F1 12 Tf ET "
            b"q BT /F1 36 Tf 20 60 Td (A) Tj ET Q "
            b"BT 20 20 Td (B) Tj ET"
        )
        pdf.save(src)

    result = outline_text.outline_fonts(src, out)

    assert result["supported"], result["warnings"]
    assert result["glyphs"] == 2
    assert count_live_text(out)["total"] == 0
