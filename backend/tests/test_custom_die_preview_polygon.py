"""Verify FIX preview khuôn CUSTOM (đường cắt 'bù xén' trace): backend trích được
ĐƯỜNG BẾ THẬT (diePolygon) cho hình CUSTOM → preview vẽ contour thật, KHÔNG bbox.

Trước fix: preview-layout chỉ trích diePolygon cho HAMMER/DUMBBELL → CUSTOM trả None
→ GridPreview vẽ bounding box. Fix: trích cả CUSTOM + frontend vẽ polygon thật.

Test này kiểm DATA PATH của fix (không cần auth route): với khuôn CUSTOM (ngôi sao
nhiều đỉnh, kiểu contour trace), pipeline trích polygon + chuẩn hoá cho ra contour
THẬT (nhiều đỉnh, trong [0,1]), KHÔNG phải hình chữ nhật 4 góc.
"""
from __future__ import annotations

import math
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

pytest.importorskip("pikepdf")
pytest.importorskip("shapely")

from app.workers import pdf_wrapper as pdf_lib
from app.workers.shape_classifier import classify_shape
from app.workers.shape_types import ShapeType
from app.workers.pont_collision import build_shapely_polygon_from_paths
from app.api.routes.imposition import _normalize_polygon_to_unit


def _star_pts(cx, cy, rO, rI, points=5):
    pts = []
    for i in range(points * 2):
        r = rO if i % 2 == 0 else rI
        a = math.pi * i / points - math.pi / 2
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def _make_star_die_pdf(path):
    """Trang có khuôn NGÔI SAO (magenta CutContour-like) — hình CUSTOM."""
    doc = pdf_lib.open()
    page = doc.new_page(width=200.0, height=200.0)
    shape = page.new_shape()
    pts = _star_pts(100, 100, 80, 32)
    for i in range(len(pts)):
        shape.draw_line(pdf_lib.Point(*pts[i]), pdf_lib.Point(*pts[(i + 1) % len(pts)]))
    shape.finish(color=(0.0, 1.0, 0.0, 0.0), width=1.0)  # magenta = đường bế
    shape.commit()
    doc.save(path)
    doc.close()


def _classify_pts(pts):
    from collections import namedtuple
    P = namedtuple("P", ["x", "y"])
    return [("l", P(*pts[i]), P(*pts[(i + 1) % len(pts)])) for i in range(len(pts))]


def test_star_die_classifies_custom():
    """Ngôi sao (10 đỉnh) → CUSTOM (đúng: không phải hình mẫu) → cần diePolygon thật."""
    got = classify_shape(_classify_pts(_star_pts(100, 100, 80, 32)))['shape_type']
    assert got is ShapeType.CUSTOM


def test_custom_die_polygon_is_real_contour_not_bbox(tmp_path):
    """Khuôn CUSTOM → _normalize_polygon_to_unit cho contour THẬT (nhiều đỉnh, [0,1])."""
    p = str(tmp_path / "star_die.pdf")
    _make_star_die_pdf(p)
    doc = pdf_lib.open(p)
    try:
        page = doc[0]
        paths = page.extract_vector_paths()
        base_poly = build_shapely_polygon_from_paths(paths, page.rect)
        norm = _normalize_polygon_to_unit(base_poly)
    finally:
        doc.close()

    assert norm is not None, "khuôn CUSTOM phải trích được đa giác (diePolygon)"
    # Contour THẬT của ngôi sao → nhiều đỉnh, KHÔNG phải 4 góc bbox.
    assert len(norm) >= 8, f"phải là contour thật (≥8 đỉnh), got {len(norm)} → vẫn giống bbox?"
    # Mọi đỉnh trong [0,1] (đã chuẩn hoá).
    for fx, fy in norm:
        assert -0.01 <= fx <= 1.01 and -0.01 <= fy <= 1.01, f"đỉnh ngoài [0,1]: {(fx, fy)}"
    # Có đỉnh lõm (bán kính tới tâm biến thiên) → đúng ngôi sao, không phải hình lồi đơn giản.
    rs = [math.hypot(fx - 0.5, fy - 0.5) for fx, fy in norm]
    assert (max(rs) - min(rs)) > 0.1, "contour phải có đỉnh lồi/lõm (ngôi sao), không phải bbox"


def _triangle_pts(cx, cy, r):
    return [(cx + r * math.cos(math.pi / 2 + i * 2 * math.pi / 3),
             cy + r * math.sin(math.pi / 2 + i * 2 * math.pi / 3)) for i in range(3)]


def _make_two_die_pdf(path):
    """2 trang khuôn KHÁC nhau (mixed): trang0 = ngôi sao, trang1 = tam giác."""
    doc = pdf_lib.open()
    # Trang 0: ngôi sao (CUSTOM)
    p0 = doc.new_page(width=200.0, height=200.0)
    s0 = p0.new_shape()
    star = _star_pts(100, 100, 80, 32)
    for i in range(len(star)):
        s0.draw_line(pdf_lib.Point(*star[i]), pdf_lib.Point(*star[(i + 1) % len(star)]))
    s0.finish(color=(0.0, 1.0, 0.0, 0.0), width=1.0)
    s0.commit()
    # Trang 1: tam giác
    p1 = doc.new_page(width=200.0, height=200.0)
    s1 = p1.new_shape()
    tri = _triangle_pts(100, 100, 80)
    for i in range(len(tri)):
        s1.draw_line(pdf_lib.Point(*tri[i]), pdf_lib.Point(*tri[(i + 1) % len(tri)]))
    s1.finish(color=(0.0, 1.0, 0.0, 0.0), width=1.0)
    s1.commit()
    doc.save(path)
    doc.close()


def test_mixed_per_page_die_polygons_distinct(tmp_path):
    """Dàn nhiều mẫu: mỗi trang khuôn KHÁC nhau → trích được contour THẬT riêng từng trang."""
    p = str(tmp_path / "two_die.pdf")
    _make_two_die_pdf(p)
    doc = pdf_lib.open(p)
    by_page = {}
    try:
        for pi in range(doc.page_count):
            pg = doc[pi]
            paths = pg.extract_vector_paths()
            poly = build_shapely_polygon_from_paths(paths, pg.rect)
            by_page[pi] = _normalize_polygon_to_unit(poly)
    finally:
        doc.close()

    assert 0 in by_page and 1 in by_page
    assert by_page[0] is not None and by_page[1] is not None
    # Ngôi sao (nhiều đỉnh) KHÁC tam giác (ít đỉnh) → contour riêng từng trang, không bbox chung.
    assert len(by_page[0]) >= 8, "trang sao phải nhiều đỉnh"
    assert len(by_page[0]) != len(by_page[1]) or by_page[0] != by_page[1], \
        "2 trang khuôn khác nhau phải cho contour KHÁC nhau"


def _arrow7_pts():
    """Mũi tên 7 đỉnh (heptagon) → classify = ARROW."""
    return [(0, 30), (60, 30), (60, 10), (100, 50), (60, 90), (60, 70), (0, 70)]


def test_arrow_die_returns_real_contour(tmp_path):
    """Khuôn MŨI TÊN → backend trích đường bế THẬT (diePolygon), không phải mũi tên tổng hợp."""
    # classify đúng là ARROW
    got = classify_shape(_classify_pts(_arrow7_pts()))['shape_type']
    assert got is ShapeType.ARROW

    doc = pdf_lib.open()
    page = doc.new_page(width=120.0, height=100.0)
    shape = page.new_shape()
    pts = _arrow7_pts()
    for i in range(len(pts)):
        shape.draw_line(pdf_lib.Point(*pts[i]), pdf_lib.Point(*pts[(i + 1) % len(pts)]))
    shape.finish(color=(0.0, 1.0, 0.0, 0.0), width=1.0)
    shape.commit()
    p = str(tmp_path / "arrow_die.pdf")
    doc.save(p)
    doc.close()

    doc2 = pdf_lib.open(p)
    try:
        pg = doc2[0]
        norm = _normalize_polygon_to_unit(build_shapely_polygon_from_paths(pg.extract_vector_paths(), pg.rect))
    finally:
        doc2.close()

    assert norm is not None, "khuôn mũi tên phải trích được đường bế thật"
    # Contour mũi tên: 7 đỉnh → ≥6 sau giản hoá (không phải bbox 4 góc).
    assert len(norm) >= 6, f"phải là contour mũi tên thật, got {len(norm)} đỉnh"
    for fx, fy in norm:
        assert -0.01 <= fx <= 1.01 and -0.01 <= fy <= 1.01
