"""Test PDF spot-color emitter (task 3.2/3.4). Requirements: 3.2, 3.5, 8.4."""

from app.workers.cut_export.cut_model import CutModel, CutPath
from app.workers.cut_export.emitters.pdf_spot import PdfSpotEmitter


def _model():
    return CutModel(
        paths=[CutPath(points=[(0, 0), (10, 0), (10, 10), (0, 10)], closed=True)],
        sheet_w_mm=100, sheet_h_mm=200,
    )


def test_pdf_is_valid_and_has_spot_separation():
    out = PdfSpotEmitter().emit(_model())
    assert out[:4] == b"%PDF"
    assert b"Separation" in out
    assert b"CutContour" in out


def test_pdf_custom_spot_name():
    out = PdfSpotEmitter(spot_name="Thru-cut").emit(_model())
    assert b"Thru-cut" in out


def test_pdf_deterministic():
    a = PdfSpotEmitter().emit(_model())
    b = PdfSpotEmitter().emit(_model())
    assert a == b


def test_pdf_skips_empty_paths():
    cm = CutModel(paths=[CutPath(points=[(0, 0)])], sheet_w_mm=10, sheet_h_mm=10)
    out = PdfSpotEmitter().emit(cm)
    assert out[:4] == b"%PDF"  # vẫn ra PDF hợp lệ, không crash
