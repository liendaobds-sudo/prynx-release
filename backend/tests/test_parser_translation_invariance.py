"""Consumer của `extract_vector_paths` phải BẤT BIẾN với gốc MediaBox.

[AUDIT §4.2] docs/BAO_CAO_AUDIT_HE_TOA_DO_PARSER_2026-07-28.md

`pdf_content_parser` trả toạ độ theo hệ riêng: x giữ RAW, y lật quanh `mb[3]-mb[1]`
thay vì `mb[3]`. Khi gốc MediaBox khác (0,0), toạ độ bị dịch đúng một lượng không
phụ thuộc điểm: `Δ = (+mb[0], −mb[1])`.

Audit kết luận KHÔNG sửa parser, vì gần như mọi consumer bất biến với phép dịch —
nhưng trước đợt audit thì điều đó không được test nào bảo vệ. Bộ test này là lưới
đó: CÙNG nội dung vẽ trên hai trang khác gốc MediaBox → kết quả consumer phải TRÙNG.

Nếu một consumer mới trộn toạ độ parser với toạ độ hệ trang, test tương ứng ở đây
sẽ đỏ thay vì lỗi âm thầm trên máy khách.
"""
import pikepdf
import pytest

from app.workers import pdf_wrapper
from app.workers.pdf_types import Rect

# Hai trang giống nhau về nội dung, khác gốc MediaBox.
ORIGIN_ZERO = [0.0, 0.0, 200.0, 100.0]
ORIGIN_OFFSET = [50.0, 30.0, 250.0, 130.0]

# Hình vẽ, toạ độ TƯƠNG ĐỐI gốc trang (sẽ cộng gốc MediaBox khi ghi content stream).
DIE_REL = (10.0, 10.0, 190.0, 90.0)      # nét bế magenta CMYK — khớp die_colors
ART_REL = (30.0, 30.0, 90.0, 70.0)       # nét artwork nâu — không có tín hiệu bế


def _content(ox, oy):
    dx0, dy0, dx1, dy1 = (DIE_REL[0] + ox, DIE_REL[1] + oy,
                          DIE_REL[2] + ox, DIE_REL[3] + oy)
    ax0, ay0, ax1, ay1 = (ART_REL[0] + ox, ART_REL[1] + oy,
                          ART_REL[2] + ox, ART_REL[3] + oy)
    return (
        # Nét artwork (màu ngoài palette bế) — mồi để phép chọn không tầm thường.
        f"0.4 0.25 0.1 RG 1 w {ax0} {ay0} m {ax1} {ay0} l {ax1} {ay1} l {ax0} {ay1} l h S\n"
        # Nét bế magenta CMYK.
        f"0 1 0 0 K 0.5 w {dx0} {dy0} m {dx1} {dy0} l {dx1} {dy1} l {dx0} {dy1} l h S\n"
    ).encode()


def _make(path, mediabox):
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(mediabox[2] - mediabox[0], mediabox[3] - mediabox[1]))
    page = pdf.pages[0]
    page.obj[pikepdf.Name("/MediaBox")] = pikepdf.Array(mediabox)
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
        _content(mediabox[0], mediabox[1])
    )
    pdf.save(str(path))
    pdf.close()
    return str(path)


@pytest.fixture
def pages(tmp_path):
    """(page_gốc0, page_gốc_lệch) — cùng nội dung, mở sẵn, tự đóng."""
    zero = _make(tmp_path / "zero.pdf", ORIGIN_ZERO)
    offset = _make(tmp_path / "offset.pdf", ORIGIN_OFFSET)
    d0 = pdf_wrapper.open(zero)
    d1 = pdf_wrapper.open(offset)
    try:
        yield d0[0], d1[0]
    finally:
        d0.close()
        d1.close()


def _norm(rect):
    """Kích thước — bất biến với dịch."""
    return (round(rect.width, 4), round(rect.height, 4))


def _shifted_to_origin(coords):
    """Dịch chuỗi điểm về gốc riêng của nó → so sánh được giữa hai trang."""
    xs = [c[0] for c in coords]
    ys = [c[1] for c in coords]
    mnx, mny = min(xs), min(ys)
    return tuple((round(x - mnx, 4), round(y - mny, 4)) for x, y in coords)


# ------------------------------------------------------- tiền đề của bộ test

def test_parser_delta_is_pure_translation(pages):
    """Tiền đề: sai số đúng bằng (+mb[0], −mb[1]) cho MỌI path, không phụ thuộc điểm."""
    p0, p1 = pages
    r0 = {(_norm(p["rect"])): p["rect"] for p in p0.extract_vector_paths()}
    paths1 = p1.extract_vector_paths()
    assert len(r0) == len(paths1) == 2

    dx, dy = ORIGIN_OFFSET[0], -ORIGIN_OFFSET[1]
    for p in paths1:
        base = r0[_norm(p["rect"])]
        assert p["rect"].x0 - base.x0 == pytest.approx(dx, abs=1e-3)
        assert p["rect"].y0 - base.y0 == pytest.approx(dy, abs=1e-3)
        assert p["rect"].x1 - base.x1 == pytest.approx(dx, abs=1e-3)
        assert p["rect"].y1 - base.y1 == pytest.approx(dy, abs=1e-3)


# ------------------------------------------------------------- các consumer

def test_select_from_paths_is_translation_invariant(pages):
    """`die_detection._select_from_paths` chọn ĐÚNG path bế trên cả hai trang."""
    from app.workers.die_detection import DetectionConfig, _select_from_paths

    cfg = DetectionConfig()
    picked = []
    for page in pages:
        chosen, by_spot, is_fb = _select_from_paths(
            page.extract_vector_paths(), page.rect,
            cfg.die_channel_names, cfg.die_colors, cfg.die_color_tol,
        )
        assert chosen is not None, "phải chọn được nét bế"
        picked.append((_norm(chosen["rect"]), by_spot, is_fb))

    assert picked[0] == picked[1]
    # Chọn đúng nét BẾ (180x80) chứ không phải nét artwork (60x40).
    assert picked[0][0] == (
        round(DIE_REL[2] - DIE_REL[0], 4), round(DIE_REL[3] - DIE_REL[1], 4)
    )


def test_classify_shape_is_translation_invariant(pages):
    """`shape_classifier.classify_shape` cho cùng loại hình + cùng tham số."""
    from app.workers.die_detection import DetectionConfig, _select_from_paths
    from app.workers.shape_classifier import classify_shape

    cfg = DetectionConfig()
    results = []
    for page in pages:
        chosen, _, _ = _select_from_paths(
            page.extract_vector_paths(), page.rect,
            cfg.die_channel_names, cfg.die_colors, cfg.die_color_tol,
        )
        out = classify_shape(chosen.get("items", []))
        results.append((
            out["shape_type"].name,
            {k: round(float(v), 4) for k, v in (out.get("params") or {}).items()
             if isinstance(v, (int, float)) and not isinstance(v, bool)},
        ))

    assert results[0] == results[1]


def test_poly_to_trim_coords_is_translation_invariant(pages):
    """`die_detection._poly_to_trim_coords` tự dịch về gốc → phải trùng khít."""
    from app.workers.die_detection import _poly_to_trim_coords, _same_color_group_poly

    magenta = (0.0, 1.0, 0.0, 0.0)
    coords = []
    for page in pages:
        poly = _same_color_group_poly(page, magenta, paths=page.extract_vector_paths())
        assert poly is not None, "phải dựng được polygon từ nét bế magenta"
        coords.append(_poly_to_trim_coords(poly))

    assert coords[0] == coords[1]
    assert coords[0], "poly không được rỗng"


def test_transform_die_point_is_translation_invariant(pages):
    """`nup_artwork.transform_die_point` chỉ dùng hiệu số so die_rect → bất biến."""
    from app.workers.die_detection import DetectionConfig, _select_from_paths
    from app.workers.nup_artwork import transform_die_point

    cfg = DetectionConfig()
    out = []
    for page in pages:
        chosen, _, _ = _select_from_paths(
            page.extract_vector_paths(), page.rect,
            cfg.die_channel_names, cfg.die_colors, cfg.die_color_tol,
        )
        r = chosen["rect"]
        # Lấy 3 điểm mốc của chính đường bế → so sánh vị trí sau khi đặt vào ô.
        probes = [(r.x0, r.y0), ((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2), (r.x1, r.y1)]
        out.append([
            tuple(round(v, 4) for v in transform_die_point(px, py, r, 100.0, 200.0))
            for px, py in probes
        ])

    assert out[0] == out[1]


@pytest.mark.parametrize("rotated,rotated180", [
    (False, False), (True, False), (False, True), (True, True),
])
def test_transform_die_point_invariant_for_every_rotation(pages, rotated, rotated180):
    """Bất biến phải giữ cho cả 4 trạng thái xoay ô mà bình bế dùng."""
    from app.workers.die_detection import DetectionConfig, _select_from_paths
    from app.workers.nup_artwork import transform_die_point

    cfg = DetectionConfig()
    out = []
    for page in pages:
        chosen, _, _ = _select_from_paths(
            page.extract_vector_paths(), page.rect,
            cfg.die_channel_names, cfg.die_colors, cfg.die_color_tol,
        )
        r = chosen["rect"]
        out.append(tuple(
            round(v, 4) for v in transform_die_point(
                r.x0, r.y0, r, 100.0, 200.0,
                is_rotated=rotated, is_rotated_180=rotated180,
            )
        ))

    assert out[0] == out[1]


def test_build_shapely_polygon_is_translation_invariant(pages):
    """`pont_collision.build_shapely_polygon_from_paths`: hình dạng + diện tích trùng."""
    pytest.importorskip("shapely")
    from app.workers.pont_collision import build_shapely_polygon_from_paths

    shapes = []
    for page in pages:
        poly = build_shapely_polygon_from_paths(page.extract_vector_paths(), page.rect)
        assert poly is not None and not poly.is_empty
        geom = poly
        if getattr(geom, "geom_type", None) == "MultiPolygon":
            geom = max(geom.geoms, key=lambda g: g.area)
        shapes.append((
            round(geom.area, 3),
            _shifted_to_origin(list(geom.exterior.coords)),
        ))

    assert shapes[0][0] == shapes[1][0]
    assert shapes[0][1] == shapes[1][1]


def test_detect_die_shapes_is_translation_invariant(tmp_path):
    """[AUDIT §4.3] `detect_die_shapes` trên PDF THẬT gốc lệch — không dùng _FakeDoc.

    Đây là consumer của route /imposition/detect-shape, đường KHÔNG qua chốt
    canonicalize, nên bất biến ở đây là điều kiện để UI báo đúng khổ thành phẩm.
    """
    from app.workers.die_detection import detect_die_shapes, shape_to_dict

    results = []
    for name, mb in (("zero.pdf", ORIGIN_ZERO), ("offset.pdf", ORIGIN_OFFSET)):
        doc = pdf_wrapper.open(_make(tmp_path / name, mb))
        try:
            res = detect_die_shapes(doc)
        finally:
            doc.close()
        assert res.total_pages == 1
        results.append([shape_to_dict(s) for s in res.shapes])

    assert results[0] == results[1]
    assert results[0][0]["trim"]["w"] == pytest.approx(
        DIE_REL[2] - DIE_REL[0], abs=0.05
    )


def test_page_has_die_is_translation_invariant(tmp_path):
    """`sticker_homogeneous.page_has_die` chỉ dùng tín hiệu tỉ lệ → bất biến."""
    from app.workers.sticker_homogeneous import page_has_die

    out = []
    for name, mb in (("zero.pdf", ORIGIN_ZERO), ("offset.pdf", ORIGIN_OFFSET)):
        doc = pdf_wrapper.open(_make(tmp_path / name, mb))
        try:
            out.append(page_has_die(doc[0]))
        finally:
            doc.close()

    assert out[0] == out[1] is True


def test_artwork_bbox_is_the_known_exception(tmp_path):
    """[AUDIT §3.1] `artwork_bbox` KHÔNG bất biến — nó trả Rect tuyệt đối.

    Ghim lại sự thật này để không ai vô tình dùng nó ngoài chốt canonicalize. Nếu
    sau này artwork_bbox được chuyển sang hệ tương đối gốc trang, test này đỏ và đó
    là tín hiệu ĐÚNG — sửa assert thành bằng nhau.
    """
    from app.workers.sticker_homogeneous import artwork_bbox

    boxes = []
    for name, mb in (("zero.pdf", ORIGIN_ZERO), ("offset.pdf", ORIGIN_OFFSET)):
        doc = pdf_wrapper.open(_make(tmp_path / name, mb))
        try:
            boxes.append(artwork_bbox(doc[0]))
        finally:
            doc.close()

    assert boxes[0] is not None and boxes[1] is not None
    # Kích thước thì bất biến…
    assert _norm(boxes[0]) == _norm(boxes[1])
    # …nhưng gốc thì lệch đúng Δ = (+mb[0], −mb[1]).
    assert boxes[1].x0 - boxes[0].x0 == pytest.approx(ORIGIN_OFFSET[0], abs=1e-3)
    assert boxes[1].y0 - boxes[0].y0 == pytest.approx(-ORIGIN_OFFSET[1], abs=1e-3)


def test_fix_hairlines_roundtrip_cancels_on_offset_page(tmp_path):
    """[AUDIT §3.2] parser + ShapeBuilder dùng cùng pivot sai → round-trip triệt tiêu.

    Ghim cặp phụ thuộc này: sửa MỘT phía (parser hoặc ShapeBuilder) mà không sửa
    phía kia sẽ làm nét hairline vẽ lệch Δ một cách im lặng. Test đỏ = đã sửa lệch pha.
    """
    import re

    from app.workers.pdf_content_parser import extract_vector_paths
    from app.workers.pdf_ops import new_shape

    raw_y = 40.0
    path = str(tmp_path / "hair.pdf")
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(200, 100))
    page = pdf.pages[0]
    page.obj[pikepdf.Name("/MediaBox")] = pikepdf.Array(ORIGIN_OFFSET)
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
        f"0 0 0 RG 0.05 w 60 {raw_y} m 240 {raw_y} l S\n".encode()
    )
    pdf.save(path)
    pdf.close()

    with pikepdf.Pdf.open(path) as doc:
        pike_page = doc.pages[0]
        drawing = extract_vector_paths(pike_page, doc)[0]
        item = drawing["items"][0]

        # Parser lệch so với hệ tương đối gốc trang…
        assert item[1].y == pytest.approx(
            (ORIGIN_OFFSET[3] - raw_y) - ORIGIN_OFFSET[1], abs=1e-3
        )

        shape = new_shape(doc, pike_page)
        shape.draw_line(item[1], item[2])
        shape.finish(color=drawing["color"], width=0.25)
        shape.commit()

        contents = pike_page.obj["/Contents"]
        blob = (
            b"\n".join(bytes(s.read_bytes()) for s in contents)
            if isinstance(contents, pikepdf.Array)
            else bytes(contents.read_bytes())
        ).decode("latin-1")

    ys = re.findall(r"([-\d.]+) ([-\d.]+) m", blob)
    # …nhưng ghi lại đúng y RAW ban đầu.
    assert float(ys[-1][1]) == pytest.approx(raw_y, abs=1e-3)
