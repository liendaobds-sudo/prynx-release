"""Regression cho đường bế sau khi bình tem.

Các đoạn CutContour liên tiếp phải dùng chung một PDF subpath. Nếu mỗi đoạn
phát một ``m`` riêng, Illustrator sẽ cho phép kéo rời từng đoạn dù endpoint
trùng tọa độ.
"""

import pikepdf

from app.workers.pdf_ops import new_shape
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
