"""Kéo MỘT run text trong cụm BT…ET nhiều run không được xô run lân cận.

PDFium tách "kỹ" / "thuật" thành 2 object text; move cũ bọc cả BT…ET → kéo
"thuật" làm lệch dấu "ỹ" / "kỹ".
"""
from __future__ import annotations

import os
import tempfile

import pikepdf
import pytest
from pikepdf import Dictionary, Name

from app.core.geometry_reader import list_objects
from app.core.stream_editor import move_objects


def _write_two_run_pdf(path: str) -> None:
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(400, 200))
    font = Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)
    page.Resources = Dictionary(Font=Dictionary(F1=font))
    # Hai run trong MỘT BT…ET — giống file AI tách từ/cụm.
    page.Contents = pdf.make_stream(
        b"""
BT
/F1 18 Tf
1 0 0 1 40 100 Tm
(ky) Tj
1 0 0 1 70 100 Tm
(thuat) Tj
ET
"""
    )
    pdf.save(path)
    pdf.close()


def test_move_second_run_leaves_first_run_bbox():
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "two_run.pdf")
        out = os.path.join(td, "out.pdf")
        _write_two_run_pdf(src)

        metas = [m for m in list_objects(src, 0) if m.type == "text"]
        assert len(metas) >= 2, f"cần ≥2 text object, được {len(metas)}"

        # Chọn run bên phải ("thuat") — bbox x lớn hơn.
        metas_sorted = sorted(metas, key=lambda m: m.bbox[0])
        left, right = metas_sorted[0], metas_sorted[-1]
        left_bbox = list(left.bbox)
        right_bbox = list(right.bbox)

        with pikepdf.open(src) as pdf:
            res = move_objects(pdf.pages[0], [right], 50.0, 0.0, pdf)
            assert res.changed is True
            pdf.save(out)

        after = [m for m in list_objects(out, 0) if m.type == "text"]
        after_sorted = sorted(after, key=lambda m: m.bbox[0])
        left_after = after_sorted[0]
        right_after = after_sorted[-1]

        # Run trái (ky) gần như không dịch.
        assert left_after.bbox[0] == pytest.approx(left_bbox[0], abs=2.0)
        assert left_after.bbox[1] == pytest.approx(left_bbox[1], abs=2.0)
        # Run phải (thuat) dịch +50 theo x.
        assert right_after.bbox[0] == pytest.approx(right_bbox[0] + 50.0, abs=2.5)


def test_move_single_run_still_uses_cm_wrap():
    """1 run trong BT…ET vẫn bọc cm (regression clip path)."""
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "one.pdf")
        pdf = pikepdf.Pdf.new()
        page = pdf.add_blank_page(page_size=(300, 200))
        font = Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)
        page.Resources = Dictionary(Font=Dictionary(F1=font))
        page.Contents = pdf.make_stream(
            b"BT /F1 14 Tf 1 0 0 1 20 80 Tm (ONLY) Tj ET\n"
        )
        pdf.save(src)
        pdf.close()

        metas = [m for m in list_objects(src, 0) if m.type == "text"]
        assert len(metas) == 1
        with pikepdf.open(src) as doc:
            move_objects(doc.pages[0], metas, 30.0, 0.0, doc)
            raw = bytes(doc.pages[0].Contents.read_bytes())
            assert b"1 0 0 1 30" in raw or b"1 0 0 1 30.0" in raw


def test_wrap_uses_target_bt_et_not_neighbor_map_object(tmp_path):
    """Regression log 18:41: map show@i nhưng wrap span lân cận → phá run khác.

    Hai khối clip+BT…ET liền nhau: map_object bbox có thể dính nhầm block trước.
    move phải bọc đúng block chứa show được chọn.
    """
    path = tmp_path / "neighbor_blocks.pdf"
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(600, 120))
    font = Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)
    page.Resources = Dictionary(Font=Dictionary(F1=font))
    # Mỗi từ một q/clip/BT…ET riêng (giống AI export).
    page.Contents = pdf.make_stream(
        b"""
q 20 40 80 30 re W* n
BT /F1 12 Tf 1 0 0 1 20 50 Tm (EmailPart) Tj ET
Q
q 280 40 120 30 re W* n
BT /F1 12 Tf 1 0 0 1 280 50 Tm (hotlinePart) Tj ET
Q
"""
    )
    pdf.save(path)
    pdf.close()

    metas = [m for m in list_objects(str(path), 0) if m.type == "text"]
    assert len(metas) >= 2
    hotline = max(metas, key=lambda m: m.bbox[0])
    email = min(metas, key=lambda m: m.bbox[0])
    email_bbox = list(email.bbox)

    with pikepdf.open(path) as doc:
        move_objects(doc.pages[0], [hotline], 0.0, 25.0, doc)
        shown = [
            bytes(args[0])
            for args, op in pikepdf.parse_content_stream(doc.pages[0])
            if str(op) == "Tj" and args
        ]
        assert b"EmailPart" in shown
        assert b"hotlinePart" in shown

    after = [m for m in list_objects(str(path), 0) if m.type == "text"]
    # Re-open saved? move_objects mutated in-memory only — save needed
    with pikepdf.open(path) as doc:
        # file on disk unchanged; re-run with save
        pass

    out = tmp_path / "neighbor_out.pdf"
    with pikepdf.open(path) as doc:
        move_objects(doc.pages[0], [hotline], 0.0, 25.0, doc)
        doc.save(out)

    after = sorted(
        [m for m in list_objects(str(out), 0) if m.type == "text"],
        key=lambda m: m.bbox[0],
    )
    left = after[0]
    assert left.bbox[0] == pytest.approx(email_bbox[0], abs=2.0)
    assert left.bbox[1] == pytest.approx(email_bbox[1], abs=2.0)


def test_move_hotline_does_not_corrupt_email_run():
    """Regression: kéo run cuối (hotline) không được cắt/xô run email phía trước."""
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "email_line.pdf")
        out = os.path.join(td, "out.pdf")
        pdf = pikepdf.Pdf.new()
        page = pdf.add_blank_page(page_size=(600, 120))
        font = Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)
        page.Resources = Dictionary(Font=Dictionary(F1=font))
        # Giống dòng contact: 3 run absolute Tm trong 1 BT…ET.
        page.Contents = pdf.make_stream(
            b"""
BT
/F1 12 Tf
1 0 0 1 20 50 Tm
(Email:sales05) Tj
1 0 0 1 100 50 Tm
(@asiaplastic.com.vn;) Tj
1 0 0 1 280 50 Tm
(hotline 0325010619) Tj
ET
"""
        )
        pdf.save(src)
        pdf.close()

        metas = [m for m in list_objects(src, 0) if m.type == "text"]
        assert len(metas) >= 3
        ordered = sorted(metas, key=lambda m: m.bbox[0])
        email_at = ordered[1]
        hotline = ordered[-1]
        email_bbox = list(email_at.bbox)
        email_w = email_bbox[2] - email_bbox[0]

        with pikepdf.open(src) as doc:
            move_objects(doc.pages[0], [hotline], 0.0, 40.0, doc)
            shown = [
                bytes(args[0])
                for args, op in pikepdf.parse_content_stream(doc.pages[0])
                if str(op) in ("Tj", "'", '"') and args
            ]
            # Email string vẫn còn nguyên (không bị cắt thành "n;").
            assert b"@asiaplastic.com.vn;" in shown
            assert b"hotline 0325010619" in shown
            doc.save(out)

        after = sorted(
            [m for m in list_objects(out, 0) if m.type == "text"],
            key=lambda m: m.bbox[0],
        )
        # Run giữa (email domain) gần như cùng x và cùng bề rộng.
        mid = after[1]
        assert mid.bbox[0] == pytest.approx(email_bbox[0], abs=2.0)
        assert (mid.bbox[2] - mid.bbox[0]) == pytest.approx(email_w, abs=3.0)
        # Hotline đã dịch lên (y PDF tăng).
        assert after[-1].bbox[1] == pytest.approx(hotline.bbox[1] + 40.0, abs=3.0)
