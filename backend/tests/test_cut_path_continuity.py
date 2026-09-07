"""Regression cho đường bế sau khi bình tem.

Các đoạn CutContour liên tiếp phải dùng chung một PDF subpath. Nếu mỗi đoạn
phát một ``m`` riêng, Illustrator sẽ cho phép kéo rời từng đoạn dù endpoint
trùng tọa độ.
"""

import logging

import pikepdf
import pytest

from app.core import development_diagnostics
from app.config import settings
from app.workers.pdf_ops import add_ocg, new_shape
from app.workers.pdf_types import Point


def _contents(page) -> str:
    contents = page.obj["/Contents"]
    if isinstance(contents, pikepdf.Array):
        return "\n".join(bytes(stream.read_bytes()).decode("latin-1") for stream in contents)
    return bytes(contents.read_bytes()).decode("latin-1")


def test_shape_builder_joins_contiguous_cut_segments_into_one_subpath():
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(100, 100))
    shape = new_shape(pdf, page)

    shape.draw_line(Point(10, 10), Point(20, 10))
    shape.draw_line(Point(20, 10), Point(20, 20))
    shape.draw_bezier(Point(20, 20), Point(21, 20), Point(22, 21), Point(22, 22))
    shape.finish(color=(0, 1, 1, 0), width=0.5)
    shape.commit()

    content = _contents(page)
    assert content.count(" m") == 1
    assert content.count(" l") == 2
    assert content.count(" c") == 1


def test_shape_builder_starts_new_subpath_after_a_real_gap():
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(100, 100))
    shape = new_shape(pdf, page)

    shape.draw_line(Point(10, 10), Point(20, 10))
    shape.draw_line(Point(30, 10), Point(40, 10))
    shape.finish(color=(0, 1, 1, 0), width=0.5)
    shape.commit()

    assert _contents(page).count(" m") == 2


def _write_cut_sample(path, count=64):
    """Nhiều path CUT thật; diagnostic không được sửa stream hoặc PDF."""
    with pikepdf.Pdf.new() as pdf:
        page = pdf.add_blank_page(page_size=(400, 400))
        ocg = add_ocg(pdf, "CUT")
        shape = new_shape(pdf, page)
        for index in range(count):
            x = 10.0 + (index % 8) * 40.0
            y = 10.0 + (index // 8) * 40.0
            shape.draw_line(Point(x, y), Point(x + 20.0, y))
            shape.draw_line(Point(x + 20.0, y), Point(x + 20.0, y + 20.0))
            shape.finish(color=(0, 1, 0, 0), width=0.5, oc=ocg)
        shape.commit()
        pdf.save(path, static_id=True)
    with pikepdf.Pdf.open(path) as document:
        return _contents(document.pages[0])


@pytest.mark.parametrize(
    "dev,compiled,flag,expected_logs",
    [(True, False, None, 0), (False, False, "1", 0),
     (True, True, "1", 0), (True, False, "1", 64)],
)
def test_cut_diagnostic_is_dev_opt_in_and_never_warning(
    tmp_path, monkeypatch, caplog, dev, compiled, flag, expected_logs,
):
    """PERF (audit 2026-09-07 §TEMPERF.5): mặc định không log từng tem."""
    monkeypatch.setattr(settings, "DEV_MODE", dev)
    monkeypatch.setattr(development_diagnostics, "is_compiled_runtime", lambda: compiled)
    if flag is None:
        monkeypatch.delenv("PRYNX_CUT_PATH_DEBUG", raising=False)
    else:
        monkeypatch.setenv("PRYNX_CUT_PATH_DEBUG", flag)
    with caplog.at_level(logging.DEBUG, logger="app.workers.pdf_ops"):
        content = _write_cut_sample(tmp_path / "cut.pdf")
    records = [r for r in caplog.records if "[CUT-PATH-AUDIT]" in r.getMessage()]
    assert len(records) == expected_logs
    assert all(record.levelno == logging.DEBUG for record in records)
    assert content.count(" m") == 64
    assert content.count(" l") == 128


def test_cut_debug_on_off_preserves_pdf_bytes(tmp_path, monkeypatch, caplog):
    """Bật trace không được thay đổi đường bế, OCG hoặc byte của artifact."""
    monkeypatch.setattr(settings, "DEV_MODE", True)
    monkeypatch.setattr(development_diagnostics, "is_compiled_runtime", lambda: False)
    first = tmp_path / "off.pdf"
    second = tmp_path / "on.pdf"
    with caplog.at_level(logging.DEBUG, logger="app.workers.pdf_ops"):
        monkeypatch.delenv("PRYNX_CUT_PATH_DEBUG", raising=False)
        off = _write_cut_sample(first)
        monkeypatch.setenv("PRYNX_CUT_PATH_DEBUG", "1")
        on = _write_cut_sample(second)
    assert off == on
    assert first.read_bytes() == second.read_bytes()
