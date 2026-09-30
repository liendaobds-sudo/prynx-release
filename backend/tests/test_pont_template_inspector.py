"""Test kiểm thử chức năng tự động nhận diện thông số boong định vị từ file mẫu PDF/SVG."""

import os
import tempfile
import pytest
import pikepdf
from xml.etree import ElementTree

from app.workers.pont_template_inspector import inspect_pont_template
from app.workers.nup_marks import _draw_ponts_on_page
from app.workers import pdf_ops
from app.workers.pdf_types import Rect


MM_TO_PTS = 2.83464567


@pytest.fixture
def circle_pont_pdf():
    """Tạo 1 file PDF mẫu khổ A3+ (330x483mm) chứa 4 ốc tròn 5mm, lề 15mm, thanh dẫn BL 20mm."""
    sheet_w_mm = 330.0
    sheet_h_mm = 483.0
    sheet_w_pt = sheet_w_mm * MM_TO_PTS
    sheet_h_pt = sheet_h_mm * MM_TO_PTS

    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(sheet_w_pt, sheet_h_pt))

    pont_cfg = {
        "shape": "circle",
        "size": 5.0,
        "thickness": 0.5,
        "marginLeft": 15.0,
        "marginRight": 15.0,
        "marginTop": 15.0,
        "marginBottom": 15.0,
        "guide1Enabled": True,
        "guide1Pos": "BL",
        "guide1Length": 20.0,
        "guide1Thickness": 0.5,
        "guide1OffX": 0.0,
        "guide1OffY": 0.0,
    }

    # Bọc Page adapter
    class MockPageWrapper:
        def __init__(self, pike_page, p_doc, p_height):
            self._page = pike_page
            self._doc = p_doc
            self._h = p_height

        def new_shape(self):
            return pdf_ops.ShapeBuilder(self._h, self._doc, self._page)

    wrapped_page = MockPageWrapper(page, pdf, sheet_h_pt)
    _draw_ponts_on_page(wrapped_page, [], pont_cfg, sheet_w_pt, sheet_h_pt, 15.0 * MM_TO_PTS, 15.0 * MM_TO_PTS)

    fd, path = tempfile.mkstemp(suffix="_test_circle.pdf")
    os.close(fd)
    pdf.save(path)
    pdf.close()
    yield path
    if os.path.exists(path):
        os.remove(path)


@pytest.fixture
def l_corner_pont_pdf():
    """Tạo file PDF mẫu chứa ốc chữ L (l_corner) 6mm, lề 10mm."""
    sheet_w_mm = 300.0
    sheet_h_mm = 400.0
    sheet_w_pt = sheet_w_mm * MM_TO_PTS
    sheet_h_pt = sheet_h_mm * MM_TO_PTS

    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(sheet_w_pt, sheet_h_pt))

    pont_cfg = {
        "shape": "l_corner",
        "size": 6.0,
        "thickness": 0.5,
        "marginLeft": 10.0,
        "marginRight": 10.0,
        "marginTop": 10.0,
        "marginBottom": 10.0,
        "guide1Enabled": False,
        "guide2Enabled": False,
    }

    class MockPageWrapper:
        def __init__(self, pike_page, p_doc, p_height):
            self._page = pike_page
            self._doc = p_doc
            self._h = p_height

        def new_shape(self):
            return pdf_ops.ShapeBuilder(self._h, self._doc, self._page)

    wrapped_page = MockPageWrapper(page, pdf, sheet_h_pt)
    _draw_ponts_on_page(wrapped_page, [], pont_cfg, sheet_w_pt, sheet_h_pt, 10.0 * MM_TO_PTS, 10.0 * MM_TO_PTS)

    fd, path = tempfile.mkstemp(suffix="_test_l_corner.pdf")
    os.close(fd)
    pdf.save(path)
    pdf.close()
    yield path
    if os.path.exists(path):
        os.remove(path)


@pytest.fixture
def sample_svg_template():
    """Tạo file SVG mẫu khổ 320x450mm với 4 ốc tròn đường kính 5mm, lề 12mm."""
    w_mm = 320.0
    h_mm = 450.0
    r_mm = 2.5
    m_mm = 12.0

    svg_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="{w_mm}mm" height="{h_mm}mm" viewBox="0 0 {w_mm} {h_mm}">
  <!-- 4 ốc tròn 4 góc -->
  <circle cx="{m_mm + r_mm}" cy="{m_mm + r_mm}" r="{r_mm}" stroke="black" stroke-width="0.5" fill="black" />
  <circle cx="{w_mm - m_mm - r_mm}" cy="{m_mm + r_mm}" r="{r_mm}" stroke="black" stroke-width="0.5" fill="black" />
  <circle cx="{m_mm + r_mm}" cy="{h_mm - m_mm - r_mm}" r="{r_mm}" stroke="black" stroke-width="0.5" fill="black" />
  <circle cx="{w_mm - m_mm - r_mm}" cy="{h_mm - m_mm - r_mm}" r="{r_mm}" stroke="black" stroke-width="0.5" fill="black" />
  <!-- Thanh canh giấy BL dài 25mm -->
  <line x1="0" y1="{h_mm}" x2="25" y2="{h_mm}" stroke="black" stroke-width="0.5" />
</svg>
"""
    fd, path = tempfile.mkstemp(suffix="_test_boong.svg")
    os.close(fd)
    with open(path, "w", encoding="utf-8") as f:
        f.write(svg_content)
    yield path
    if os.path.exists(path):
        os.remove(path)


def test_inspect_circle_pont_pdf(circle_pont_pdf):
    """Kiểm tra nhận diện file PDF có ốc tròn 5mm, lề 15mm, thanh canh giấy 20mm."""
    res = inspect_pont_template(circle_pont_pdf, "Boong_A3_5mm.pdf")
    assert res["success"] is True
    assert res["sheet"]["widthMm"] == pytest.approx(330.0, abs=1.0)
    assert res["sheet"]["heightMm"] == pytest.approx(483.0, abs=1.0)

    detected = res["detected"]
    assert detected["marksFound"] == 4
    assert detected["shape"] == "circle"
    assert detected["size"] == pytest.approx(5.0, abs=0.5)
    assert detected["marginLeft"] == pytest.approx(15.0, abs=0.5)
    assert detected["marginRight"] == pytest.approx(15.0, abs=0.5)
    assert detected["marginTop"] == pytest.approx(15.0, abs=0.5)
    assert detected["marginBottom"] == pytest.approx(15.0, abs=0.5)

    cfg = res["config"]
    assert cfg["shape"] == "circle"
    assert cfg["guide1Enabled"] is True
    assert cfg["guide1Pos"] == "BL"
    assert cfg["guide1Length"] == pytest.approx(20.0, abs=1.0)
    assert "Boong_A3_5mm" in res["suggestedName"]


def test_inspect_l_corner_pont_pdf(l_corner_pont_pdf):
    """Kiểm tra nhận diện file PDF có ốc chữ L (l_corner) 6mm, lề 10mm."""
    res = inspect_pont_template(l_corner_pont_pdf, "Khuon_L_6mm.pdf")
    assert res["success"] is True
    assert res["sheet"]["widthMm"] == pytest.approx(300.0, abs=1.0)
    assert res["sheet"]["heightMm"] == pytest.approx(400.0, abs=1.0)

    detected = res["detected"]
    assert detected["marksFound"] >= 3
    assert detected["shape"] == "l_corner"
    assert detected["size"] == pytest.approx(6.0, abs=0.5)
    assert detected["marginLeft"] == pytest.approx(10.0, abs=0.5)
    assert detected["marginTop"] == pytest.approx(10.0, abs=0.5)


def test_inspect_svg_template(sample_svg_template):
    """Kiểm tra nhận diện file SVG có ốc tròn 5mm, lề 12mm, thanh canh giấy 25mm."""
    res = inspect_pont_template(sample_svg_template, "Mau_Boong_Decal.svg")
    assert res["success"] is True
    assert res["sheet"]["widthMm"] == pytest.approx(320.0, abs=1.0)
    assert res["sheet"]["heightMm"] == pytest.approx(450.0, abs=1.0)

    detected = res["detected"]
    assert detected["marksFound"] == 4
    assert detected["shape"] == "circle"
    assert detected["size"] == pytest.approx(5.0, abs=0.5)
    assert detected["marginLeft"] == pytest.approx(12.0, abs=0.5)
    assert detected["marginRight"] == pytest.approx(12.0, abs=0.5)
    assert detected["marginTop"] == pytest.approx(12.0, abs=0.5)
    assert detected["marginBottom"] == pytest.approx(12.0, abs=0.5)

    cfg = res["config"]
    assert cfg["guide1Enabled"] is True
    assert cfg["guide1Pos"] == "BL"
    assert cfg["guide1Length"] == pytest.approx(25.0, abs=1.0)


def test_inspect_invalid_extension():
    """Kiểm tra báo lỗi khi truyền file không phải PDF hoặc SVG."""
    with pytest.raises(ValueError, match="Chỉ hỗ trợ file mẫu định dạng PDF"):
        inspect_pont_template("invalid_file.docx")


def test_api_inspect_pont_template_upload(circle_pont_pdf):
    """Kiểm tra gọi endpoint /api/imposition/inspect-pont-template với upload file."""
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as client:
        with open(circle_pont_pdf, "rb") as f:
            resp = client.post(
                "/api/imposition/inspect-pont-template",
                files={"file": ("Mau_Boong.pdf", f, "application/pdf")},
            )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["success"] is True
        assert data["config"]["shape"] == "circle"
        assert data["config"]["size"] == pytest.approx(5.0, abs=0.5)
        assert data["config"]["marginLeft"] == pytest.approx(15.0, abs=0.5)


def test_api_inspect_pont_template_path(circle_pont_pdf):
    """Kiểm tra gọi endpoint /api/imposition/inspect-pont-template với đường dẫn path."""
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as client:
        resp = client.post(
            "/api/imposition/inspect-pont-template",
            data={"path": circle_pont_pdf},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["success"] is True
        assert data["config"]["shape"] == "circle"


def test_inspect_graphtec_dashes_guide():
    """Kiểm tra nhận diện thanh canh giấy dạng vạch rời / nét đứt Graphtec ở góc BR."""
    sheet_w_pt = 330.0 * MM_TO_PTS
    sheet_h_pt = 480.0 * MM_TO_PTS

    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(sheet_w_pt, sheet_h_pt))

    # Viết content stream chứa 4 ốc L 10mm và 2 vạch 0.5mm tại BR
    stream_content = b"""
0 0 0 1 K
1.134 w 
q 1 0 0 1 56.6926 1332.2832 cm
0 0 m -28.346 0 l -28.346 -28.346 l S Q
q 1 0 0 1 873.071 28.3467 cm
0 0 m -1.418 0 l S Q
q 1 0 0 1 865.9841 28.3467 cm
0 0 m -1.417 0 l S Q
q 1 0 0 1 878.7399 1332.2832 cm
0 0 m 28.347 0 l 28.347 -28.346 l S Q
q 1 0 0 1 878.7399 28.3467 cm
0 0 m 28.347 0 l 28.347 28.346 l S Q
q 1 0 0 1 56.6926 28.3467 cm
0 0 m -28.346 0 l -28.346 28.346 l S Q
"""
    page.Contents = pdf.make_stream(stream_content)
    fd, path = tempfile.mkstemp(suffix="_graphtec_dashes.pdf")
    os.close(fd)
    pdf.save(path)
    pdf.close()

    try:
        res = inspect_pont_template(path, "Graphtec_Template.pdf")
        assert res["success"] is True
        assert res["detected"]["shape"] == "l_corner"
        assert res["detected"]["size"] == pytest.approx(10.0, abs=0.5)
        assert res["detected"]["guidesFound"] == 2
        cfg = res["config"]
        # Thanh dẫn 1: vạch nhỏ gần cánh ốc hơn
        assert cfg["guide1Enabled"] is True
        assert cfg["guide1Pos"] == "BR"
        assert cfg["guide1Length"] == pytest.approx(0.5, abs=0.1)
        assert cfg["guide1OffX"] == pytest.approx(22.0, abs=0.5)
        assert cfg["guide1OffY"] == pytest.approx(10.0, abs=0.5)
        # Thanh dẫn 2: vạch nhỏ ngoài cùng bên trái
        assert cfg["guide2Enabled"] is True
        assert cfg["guide2Pos"] == "BR"
        assert cfg["guide2Length"] == pytest.approx(0.5, abs=0.1)
        assert cfg["guide2OffX"] == pytest.approx(24.5, abs=0.5)
        assert cfg["guide2OffY"] == pytest.approx(10.0, abs=0.5)
    finally:
        if os.path.exists(path):
            os.remove(path)


def test_inspect_no_guides_template(l_corner_pont_pdf):
    """Kiểm tra file mẫu chỉ có ốc định vị, hoàn toàn không có thanh canh giấy nào."""
    res = inspect_pont_template(l_corner_pont_pdf, "No_Guides.pdf")
    assert res["success"] is True
    assert res["detected"]["shape"] == "l_corner"
    assert res["detected"]["guidesFound"] == 0
    cfg = res["config"]
    assert cfg["guide1Enabled"] is False
    assert cfg["guide2Enabled"] is False


def test_inspect_paired_independent_lines_l_corner():
    """Kiểm tra nhận diện ốc chữ L tạo từ các đoạn thẳng rời nhau (như từ CorelDRAW / AutoCAD)."""
    sheet_w_pt = 300.0 * MM_TO_PTS
    sheet_h_pt = 400.0 * MM_TO_PTS

    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(sheet_w_pt, sheet_h_pt))

    # Mỗi ốc L được vẽ bằng 2 lệnh S riêng biệt độc lập (2 đoạn thẳng vuông góc)
    stream_content = b"""
0 0 0 1 K
1.0 w
% TL corner: (28.34, 1105.5) -> (56.69, 1105.5) va (28.34, 1105.5) -> (28.34, 1077.16)
28.346 1105.51 m 56.692 1105.51 l S
28.346 1105.51 m 28.346 1077.16 l S
% TR corner
822.04 1105.51 m 793.70 1105.51 l S
822.04 1105.51 m 822.04 1077.16 l S
% BL corner
28.346 28.34 m 56.692 28.34 l S
28.346 28.34 m 28.346 56.69 l S
% BR corner
822.04 28.34 m 793.70 28.34 l S
822.04 28.34 m 822.04 56.69 l S
"""
    page.Contents = pdf.make_stream(stream_content)
    fd, path = tempfile.mkstemp(suffix="_corel_paired_l.pdf")
    os.close(fd)
    pdf.save(path)
    pdf.close()

    try:
        res = inspect_pont_template(path, "Corel_L_Marks.pdf")
        assert res["success"] is True
        assert res["detected"]["marksFound"] == 4
        assert res["detected"]["shape"] == "l_corner"
        assert res["detected"]["size"] == pytest.approx(10.0, abs=0.5)
        assert res["detected"]["guidesFound"] == 0
    finally:
        if os.path.exists(path):
            os.remove(path)


def test_inspect_two_corners_guides():
    """Kiểm tra file có 2 thanh canh giấy ở 2 góc khác nhau (ví dụ: BL dài 20mm và BR dài 15mm)."""
    sheet_w_pt = 320.0 * MM_TO_PTS
    sheet_h_pt = 450.0 * MM_TO_PTS

    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(sheet_w_pt, sheet_h_pt))

    pont_cfg = {
        "shape": "circle",
        "size": 5.0,
        "thickness": 0.5,
        "marginLeft": 10.0,
        "marginRight": 10.0,
        "marginTop": 10.0,
        "marginBottom": 10.0,
        "guide1Enabled": True,
        "guide1Pos": "BL",
        "guide1Length": 20.0,
        "guide1Thickness": 0.5,
        "guide1OffX": 0.0,
        "guide1OffY": 0.0,
        "guide2Enabled": True,
        "guide2Pos": "BR",
        "guide2Length": 15.0,
        "guide2Thickness": 0.5,
        "guide2OffX": 0.0,
        "guide2OffY": 0.0,
    }

    class MockPageWrapper:
        def __init__(self, pike_page, p_doc, p_height):
            self._page = pike_page
            self._doc = p_doc
            self._h = p_height

        def new_shape(self):
            return pdf_ops.ShapeBuilder(self._h, self._doc, self._page)

    wrapped_page = MockPageWrapper(page, pdf, sheet_h_pt)
    _draw_ponts_on_page(wrapped_page, [], pont_cfg, sheet_w_pt, sheet_h_pt, 10.0 * MM_TO_PTS, 10.0 * MM_TO_PTS)

    fd, path = tempfile.mkstemp(suffix="_two_guides.pdf")
    os.close(fd)
    pdf.save(path)
    pdf.close()

    try:
        res = inspect_pont_template(path, "Two_Guides.pdf")
        assert res["success"] is True
        assert res["detected"]["guidesFound"] == 2
        cfg = res["config"]
        # Thanh BL
        assert cfg["guide1Enabled"] is True
        assert cfg["guide1Pos"] == "BL"
        assert cfg["guide1Length"] == pytest.approx(20.0, abs=1.0)
        # Thanh BR
        assert cfg["guide2Enabled"] is True
        assert cfg["guide2Pos"] == "BR"
        assert cfg["guide2Length"] == pytest.approx(15.0, abs=1.0)
    finally:
        if os.path.exists(path):
            os.remove(path)



