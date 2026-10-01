"""VDP audit: preview phải khớp đúng trang PDF xuất, kể cả record sau trang 1."""
import io

import pytest
from PIL import Image
from reportlab.pdfgen import canvas

from app.core.pdfium_lock import pdfium_guard
from app.schemas.vdp import VdpField
from app.workers import vdp_preview
from app.workers.vdp_engine import run_vdp_engine


def _template(path):
    pdf = canvas.Canvas(str(path), pagesize=(216, 303))
    for color in [(0.9, 0.95, 1), (1, 0.95, 0.9)]:
        pdf.setFillColorRGB(*color)
        pdf.rect(0, 0, 216, 303, fill=1, stroke=0)
        pdf.showPage()
    pdf.save()


def test_second_record_preview_matches_generated_page_and_cleans_progress(tmp_path, monkeypatch):
    import pypdfium2 as pdfium

    template = tmp_path / "template.pdf"
    output = tmp_path / "output.pdf"
    _template(template)
    fields = [VdpField(
        id=f"field-{page}", name="Code", type="barcode", pageNum=page,
        x=5, y=page * 15, width=45, height=10,
        textContent=f"P{page}-{{Code}}", barcodeType="code128",
    ) for page in (1, 2)]
    rows = [{"Code": "001"}, {"Code": "002"}]
    monkeypatch.setattr(vdp_preview.tempfile, "gettempdir", lambda: str(tmp_path))
    result = vdp_preview.render_record_preview(str(template), fields, rows, 2, scale=1)
    run_vdp_engine(str(template), fields, rows, str(output))
    with pdfium_guard("test-vdp-preview-parity"):
        with pdfium.PdfDocument(str(output)) as pdf:
            assert len(pdf) == 2
            page = pdf[1]
            bitmap = page.render(scale=1)
            expected = bitmap.to_pil().copy()
            bitmap.close()
            page.close()
    actual = Image.open(io.BytesIO(result.image_png))
    assert result.record_index == 2
    assert actual.size == expected.size
    assert actual.convert("RGB").tobytes() == expected.convert("RGB").tobytes()
    assert not list(tmp_path.glob("vdp_prog_preview_*"))
    assert not list(tmp_path.glob("vdp_preview_*"))


@pytest.mark.parametrize("scale", [float("nan"), float("inf"), -1, 0, 1e308])
def test_preview_rejects_invalid_or_overflowing_scale(tmp_path, scale):
    template = tmp_path / "template.pdf"
    _template(template)
    with pytest.raises(ValueError):
        vdp_preview.render_record_preview(str(template), [], [{"Code": "1"}], 1, scale=scale)


def test_preview_budget_tracks_available_ram(tmp_path, monkeypatch):
    template = tmp_path / "template.pdf"
    _template(template)
    monkeypatch.setattr(vdp_preview, "read_memory_status_mb", lambda: (8192, 256))
    # 216 x 303 x 20² x 12 bytes vượt ngân sách 64MiB của fixture.
    with pytest.raises(ValueError, match="ngân sách"):
        vdp_preview.render_record_preview(str(template), [], [{"Code": "1"}], 1, scale=20)
