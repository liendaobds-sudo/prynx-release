"""Test dựng CutModel từ PDF đã bình (task 12.3/18 — nguồn hình học thật). Req 1.1, 6.3, 10.

Dùng fixture corel_cut_sample.pdf (file print-and-cut thật, lớp cắt PL_SR_Cutline_Combined_1).
"""

import hashlib
import os

import pytest

from app.workers.cut_export.pdf_source import (
    cut_model_from_polygon,
    build_cut_model_from_pdf,
    inspect_cut_pdf,
    preview_svg_from_pdf,
    PT_TO_MM,
)

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "corel_cut_sample.pdf")


def test_cut_model_from_polygon_scales_pt_to_mm():
    pytest.importorskip("shapely")
    from shapely.geometry import Polygon
    # Hình vuông 72pt = 1 inch = 25.4mm.
    poly = Polygon([(0, 0), (72, 0), (72, 72), (0, 72)])
    cm = cut_model_from_polygon(poly, sheet_w_pt=144, sheet_h_pt=216)
    assert len(cm.paths) == 1
    b = cm.paths[0].bounds()
    assert b is not None
    assert abs(b[2] - 25.4) < 0.01
    assert abs(cm.sheet_w_mm - 144 * PT_TO_MM) < 0.01


def test_build_cut_model_from_real_cut_layer():
    pytest.importorskip("pikepdf")
    cm = build_cut_model_from_pdf(FIXTURE, page_idx=0)
    # File có 75 con tem trên lớp cắt — phải ra 75 đường cắt (không phải số ốc).
    assert len([p for p in cm.paths if not p.is_empty]) == 75
    assert cm.sheet_w_mm > 0 and cm.sheet_h_mm > 0


def test_build_from_pdf_missing_cut_raises_with_hint():
    pytest.importorskip("pikepdf")
    import tempfile
    from reportlab.pdfgen import canvas

    fd = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    fd.close()
    c = canvas.Canvas(fd.name, pagesize=(200, 200), invariant=1)
    c.showPage()  # trang trống, không có lớp cắt
    c.save()
    try:
        with pytest.raises(ValueError):
            build_cut_model_from_pdf(fd.name, 0)
    finally:
        os.remove(fd.name)


def test_preview_svg_from_real_file():
    pytest.importorskip("pikepdf")
    d = preview_svg_from_pdf(FIXTURE, 0)
    assert d["total_items"] == 75
    assert d["svg"].startswith("<?xml")
    assert "<svg" in d["svg"]
    assert d["num_pages"] >= 1
    assert d["sheet_w_mm"] > 0


def test_inspect_hop_nhat_chon_trang_cut_va_bam_dung_noi_dung(tmp_path):
    pikepdf = pytest.importorskip("pikepdf")
    combined_path = tmp_path / "print-va-cut.pdf"
    output = pikepdf.Pdf.new()
    source = pikepdf.open(FIXTURE)
    try:
        output.add_blank_page(page_size=(200, 200))
        output.pages.extend(source.pages)
        output.save(combined_path)
    finally:
        source.close()
        output.close()

    data = inspect_cut_pdf(str(combined_path), page_idx=0)
    with open(combined_path, "rb") as stream:
        expected_digest = hashlib.sha256(stream.read()).hexdigest()

    assert data["cut_pages"] == [1]
    assert data["num_pages"] == 2
    assert data["selected_page_idx"] == 1
    assert data["preview"]["page_idx"] == 1
    assert data["preview"]["total_items"] == 75
    assert data["candidates"]["layers"]
    assert data["fingerprint"] == {
        "algorithm": "sha256",
        "sha256": expected_digest,
        "size_bytes": combined_path.stat().st_size,
        "mtime_ns": combined_path.stat().st_mtime_ns,
    }
    assert len(data["fingerprint"]["sha256"]) == 64
    assert data["fingerprint"]["sha256"] == data["fingerprint"]["sha256"].lower()


def test_inspect_chi_mo_pikepdf_mot_lan(monkeypatch):
    pikepdf = pytest.importorskip("pikepdf")
    real_open = pikepdf.open
    opened = []

    def counted_open(*args, **kwargs):
        opened.append(args[0])
        return real_open(*args, **kwargs)

    monkeypatch.setattr(pikepdf, "open", counted_open)
    data = inspect_cut_pdf(FIXTURE, page_idx=0)

    assert data["selected_page_idx"] == 0
    assert len(opened) == 1


def test_inspect_tu_choi_tamper_cung_size_mtime_giua_hash_va_parse(
    tmp_path, monkeypatch
):
    """Fingerprint phải bind đúng revision đã parse, kể cả metadata bị giữ nguyên."""
    pikepdf = pytest.importorskip("pikepdf")
    target = tmp_path / "race.pdf"
    with open(FIXTURE, "rb") as source, open(target, "wb") as destination:
        destination.write(source.read())
    original_stat = target.stat()
    real_open = pikepdf.open
    mutated = False

    def raced_open(*args, **kwargs):
        nonlocal mutated
        if not mutated:
            mutated = True
            with open(target, "r+b", buffering=0) as stream:
                stream.seek(7)
                old = stream.read(1)
                stream.seek(7)
                stream.write(b"6" if old != b"6" else b"5")
            os.utime(
                target,
                ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns),
            )
        return real_open(*args, **kwargs)

    monkeypatch.setattr(pikepdf, "open", raced_open)

    with pytest.raises(ValueError, match="đã thay đổi"):
        inspect_cut_pdf(str(target), page_idx=0)


def test_inspect_khong_cut_van_tra_candidates_de_ui_chon_lop(tmp_path):
    pikepdf = pytest.importorskip("pikepdf")
    blank_path = tmp_path / "blank.pdf"
    pdf = pikepdf.Pdf.new()
    try:
        pdf.add_blank_page(page_size=(200, 200))
        pdf.save(blank_path)
    finally:
        pdf.close()

    data = inspect_cut_pdf(str(blank_path), page_idx=0)

    assert data["cut_pages"] == []
    assert data["selected_page_idx"] is None
    assert data["preview"] is None
    assert data["candidates"] == {"layers": [], "spots": [], "auto_matched": []}
