"""
Test bảo tồn màu gốc và đa đường bế (bế đứt / bế demi / cấn) cho bình tem bế và bình bế rớt.

Quy chuẩn:
- 1 tem có thể có nhiều đường bế mang màu sắc hoặc kênh Spot khác nhau
  (vd: viền ngoài bế đứt ThruCut màu Đỏ CMYK, vòng trong bế demi KissCut màu Xanh Cyan).
- Khi bình bản, trang khuôn bế (hoặc lớp OCG) phải giữ nguyên từng nét theo màu gốc.
- Khi tách trang khuôn riêng (separate_cut_page), tất cả các màu bế đều phải được tẩy khỏi trang in.
"""

import math
import pytest
import pikepdf

from app.workers.pdf_types import Point, Rect
from app.workers.die_detection import (
    select_die_path, _collect_die_group, _merge_die_paths, DetectionConfig,
)
from app.workers.nup_diecut import (
    extract_page_die_cut_path_groups,
    extract_page_die_cut_path_items,
    extract_page_die_cut_polygon,
)
from app.workers.pdf_ops import ShapeBuilder
from app.workers.nesting_imposition_render import _cut_path_items_stream
from app.workers.imposition_affine import Affine2D, PoseMm
from app.workers.nup_artwork import strip_color_from_stream, strip_color_from_form_tree


class _FakePage:
    """Fake Page object mô phỏng trang PDF với extract_vector_paths()."""

    def __init__(self, paths, w=200.0, h=200.0):
        self.rect = Rect(0, 0, w, h)
        self.mediabox = Rect(0, 0, w, h)
        self.trimbox = Rect(0, 0, w, h)
        self._paths = paths

    def extract_vector_paths(self):
        return list(self._paths)


def _rect_path(x0, y0, x1, y1, color=(0.0, 1.0, 1.0, 0.0), spot_name=None, width=0.5):
    """Tạo 1 path chữ nhật (4 đoạn line)."""
    p0 = Point(x0, y0)
    p1 = Point(x1, y0)
    p2 = Point(x1, y1)
    p3 = Point(x0, y1)
    items = [
        ('l', p0, p1),
        ('l', p1, p2),
        ('l', p2, p3),
        ('l', p3, p0),
    ]
    return {
        'type': 's',
        'items': items,
        'rect': Rect(x0, y0, x1, y1),
        'color': color,
        'width': width,
        'spot_name': spot_name,
        'closePath': True,
    }


def _circle_path(cx, cy, r, color=(1.0, 0.0, 0.0, 0.0), spot_name=None, width=0.5, segments=16):
    """Tạo 1 path tròn (đa giác nội tiếp)."""
    items = []
    for i in range(segments):
        a0 = 2 * math.pi * i / segments
        a1 = 2 * math.pi * (i + 1) / segments
        items.append((
            'l',
            Point(cx + r * math.cos(a0), cy + r * math.sin(a0)),
            Point(cx + r * math.cos(a1), cy + r * math.sin(a1)),
        ))
    return {
        'type': 's',
        'items': items,
        'rect': Rect(cx - r, cy - r, cx + r, cy + r),
        'color': color,
        'width': width,
        'spot_name': spot_name,
        'closePath': True,
    }


def test_die_detection_multi_color_process():
    """Kiểm tra gom 2 đường bế khác màu (Đỏ ngoài, Xanh trong) không có spot."""
    outer_red = _rect_path(20, 20, 180, 180, color=(0.0, 1.0, 1.0, 0.0))  # CMYK Red
    inner_cyan = _circle_path(100, 100, 40, color=(1.0, 0.0, 0.0, 0.0))    # CMYK Cyan

    page = _FakePage([outer_red, inner_cyan], w=200, h=200)
    merged = select_die_path(page)

    assert merged is not None
    assert "groups" in merged
    assert len(merged["groups"]) == 2
    group_colors = [g["color"] for g in merged["groups"]]
    assert (0.0, 1.0, 1.0, 0.0) in group_colors
    assert (1.0, 0.0, 0.0, 0.0) in group_colors
    # Bóc tách đầy đủ all_colors
    assert (0.0, 1.0, 1.0, 0.0) in merged["all_colors"]
    assert (1.0, 0.0, 0.0, 0.0) in merged["all_colors"]


def test_die_detection_multi_spot():
    """Kiểm tra gom 2 đường bế mang 2 spot khác nhau (ThruCut và KissCut)."""
    outer_thru = _rect_path(20, 20, 180, 180, color=(0.0, 1.0, 1.0, 0.0), spot_name="ThruCut")
    inner_kiss = _circle_path(100, 100, 40, color=(1.0, 0.0, 0.0, 0.0), spot_name="KissCut")

    page = _FakePage([outer_thru, inner_kiss], w=200, h=200)
    merged = select_die_path(page, die_channel_names=("ThruCut", "KissCut", "CutContour"))

    assert merged is not None
    assert len(merged["groups"]) == 2
    assert merged["groups"][0]["spot_name"] == "ThruCut"
    assert merged["groups"][1]["spot_name"] == "KissCut"
    assert "ThruCut" in merged["all_spots"]
    assert "KissCut" in merged["all_spots"]


def test_nup_diecut_extract_groups_and_items():
    """Kiểm tra trích xuất groups và items qua nup_diecut."""
    outer_red = _rect_path(20, 20, 180, 180, color=(0.0, 1.0, 1.0, 0.0), spot_name="ThruCut")
    inner_cyan = _circle_path(100, 100, 40, color=(1.0, 0.0, 0.0, 0.0), spot_name="KissCut")

    page = _FakePage([outer_red, inner_cyan], w=200, h=200)

    groups = extract_page_die_cut_path_groups(page)
    assert len(groups) == 2
    assert groups[0]["spot_name"] == "ThruCut"
    assert groups[1]["spot_name"] == "KissCut"

    items = extract_page_die_cut_path_items(page)
    assert len(items) == 2  # 2 groups of items

    # Polygon solver chỉ lấy đường bao ngoài cùng
    poly = extract_page_die_cut_polygon(page)
    assert poly is not None
    # Bounds của polygon phải khớp với outer_red
    minx, miny, maxx, maxy = poly.bounds
    assert abs(minx - 20) < 1e-3
    assert abs(maxx - 180) < 1e-3


def test_shapebuilder_spot_name_registration():
    """Kiểm tra ShapeBuilder.finish tạo /Separation ColorSpace khi truyền spot_name."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    builder = ShapeBuilder(200.0, pdf, page)

    builder.draw_line((10, 10), (100, 100))
    builder.finish(color=(1.0, 0.0, 0.0, 0.0), width=0.5, spot_name="KissCut")
    builder.commit()

    # Kiểm tra Resources của page có chứa ColorSpace /Separation /KissCut
    resources = page.get("/Resources")
    assert resources is not None
    cs_dict = resources.get("/ColorSpace")
    assert cs_dict is not None
    # Phải có một entry ColorSpace
    assert len(cs_dict) > 0
    found_kisscut = False
    for cs_key, cs_val in cs_dict.items():
        if isinstance(cs_val, pikepdf.Array) and len(cs_val) >= 2:
            if cs_val[0] == pikepdf.Name("/Separation") and cs_val[1] == pikepdf.Name("/KissCut"):
                found_kisscut = True
    assert found_kisscut, "Không tìm thấy /Separation /KissCut trong Page ColorSpace Resources!"


def test_nesting_render_multi_color_stream():
    """Kiểm tra _cut_path_items_stream vẽ đúng màu/spot cho từng group trong True-shape nesting."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(400, 400))

    class _FakeBinding:
        user_unit = 1.0
        media_box_mm = (0, 0, 100, 100)
        source_page_to_canonical = Affine2D(1.0, 0.0, 0.0, 1.0, 0.0, 0.0)

    class _FakePlacement:
        page_binding = _FakeBinding()
        sheet_frame = Affine2D(1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
        pose = PoseMm(0.0, 0.0, 0.0)
        reference_point_mm = (0.0, 0.0)

    p0 = Point(10, 10)
    p1 = Point(50, 10)
    group1 = {
        'items': [('l', p0, p1)],
        'color': (0.0, 1.0, 1.0, 0.0),  # Red CMYK
        'width': 0.5,
        'spot_name': None,
    }

    p2 = Point(20, 20)
    p3 = Point(40, 20)
    group2 = {
        'items': [('l', p2, p3)],
        'color': (1.0, 0.0, 0.0, 0.0),  # Cyan CMYK
        'width': 0.25,
        'spot_name': "KissCut",
    }

    stream = _cut_path_items_stream([group1, group2], placement=_FakePlacement(), page=page)
    assert stream, "Stream không được rỗng"
    # Kiểm tra group1 có toán tử màu CMYK Red (K)
    assert "1.000000000 1.000000000 0.000000000 K" in stream
    # Kiểm tra group2 có đăng ký /Separation /KissCut và gọi CS / SCN
    assert "CS" in stream
    assert "1 SCN" in stream
    resources = page.get("/Resources")
    assert resources is not None
    cs_dict = resources.get("/ColorSpace")
    assert cs_dict is not None


def test_multi_color_strip_from_artwork():
    """Kiểm tra tẩy sạch tất cả các màu bế khác nhau khỏi trang in."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    builder = ShapeBuilder(200.0, pdf, page)

    # 1. Vẽ họa tiết in (màu Đen K100)
    builder.draw_rect(Rect(10, 10, 50, 50))
    builder.finish(color=(0, 0, 0, 1), width=1.0)

    # 2. Vẽ đường bế 1 (Đỏ Red CMYK)
    builder.draw_rect(Rect(20, 20, 80, 80))
    builder.finish(color=(0, 1, 1, 0), width=0.5)

    # 3. Vẽ đường bế 2 (Spot CustomDie)
    builder.draw_line((30, 30), (70, 70))
    builder.finish(color=(1, 0, 0, 0), width=0.5, spot_name="CustomDie")

    builder.commit()

    # Trước khi tẩy: có cả 3 nét vẽ S
    page.contents_coalesce()
    ops_before = [str(op) for _, op in pikepdf.parse_content_stream(page)]
    assert ops_before.count("S") == 3, "Ban đầu phải có 3 nét vẽ S"

    # Tẩy đường bế 1 (Đỏ) - truyền die_names_lower=() để chỉ tẩy đúng màu Đỏ
    res1 = strip_color_from_stream(page, (0, 1, 1, 0), die_names_lower=())
    assert res1 is True, "Đường bế Đỏ phải được strip thành công"

    # Tẩy đường bế 2 (CustomDie)
    res2 = strip_color_from_stream(page, (1, 0, 0, 0), target_spot="CustomDie", die_names_lower=())
    assert res2 is True, "Đường bế CustomDie phải được strip thành công"

    page.contents_coalesce()
    # Phân tích content stream sau khi tẩy
    ops_after = [str(op) for _, op in pikepdf.parse_content_stream(page)]
    # Ban đầu có 3 lệnh 'S'. Sau khi tẩy 2 đường bế, chỉ còn đúng 1 lệnh 'S' (của họa tiết Đen)
    # và có 2 lệnh 'n' (thay thế cho 2 lệnh 'S' của đường bế đã bị triệt tiêu không vẽ)
    assert ops_after.count("S") == 1, "Chỉ duy nhất nét vẽ họa tiết in được giữ lại lệnh S"
    assert ops_after.count("n") == 2, "2 nét bế phải được triệt tiêu thành lệnh không vẽ n"


def test_multi_color_strip_grouped_in_form_xobject():
    """Kiểm tra tẩy sạch các đường bế khác màu/spot khi được nhóm (Ctrl+G trong Illustrator tạo Form XObject)."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))

    # Tạo Form XObject Fm1 chứa:
    # - 1 nét vẽ in (K100)
    # - 1 đường bế Đỏ (ThruCut, CMYK Red)
    # - 1 đường bế Cyan (KissCut, CMYK Cyan)
    form_stream = b"""
q
0 0 0 1 K
10 10 50 50 re
S
Q
q
0 1 1 0 K
20 20 80 80 re
S
Q
q
1 0 0 0 K
30 30 70 70 re
S
Q
"""
    xobj = pdf.make_stream(form_stream)
    xobj.Type = pikepdf.Name("/XObject")
    xobj.Subtype = pikepdf.Name("/Form")
    xobj.BBox = [0, 0, 200, 200]

    # Đăng ký Fm1 vào page Resources
    page.Resources = pikepdf.Dictionary(
        XObject=pikepdf.Dictionary(
            Fm1=xobj
        )
    )
    # Gọi /Fm1 Do trên trang
    page_content = b"q /Fm1 Do Q\n"
    page.Contents = pdf.make_stream(page_content)

    # Tẩy đường bế Đỏ (0, 1, 1, 0)
    res1 = strip_color_from_form_tree(
        page,
        target_color=(0, 1, 1, 0),
        page_height=200.0,
        owner_pdf=pdf,
    )
    assert res1 is True, "Đường bế Đỏ trong Form XObject phải được strip thành công"

    # Tẩy đường bế Cyan (1, 0, 0, 0)
    res2 = strip_color_from_form_tree(
        page,
        target_color=(1, 0, 0, 0),
        page_height=200.0,
        owner_pdf=pdf,
    )
    assert res2 is True, "Đường bế Cyan trong Form XObject phải được strip thành công"

    # Lấy Form XObject sau khi strip
    xobj_after = page.Resources.XObject["/Fm1"]
    ops_after = [str(op) for _, op in pikepdf.parse_content_stream(xobj_after)]
    # Chỉ duy nhất 1 nét in K100 giữ lại S, 2 nét bế biến thành n
    assert ops_after.count("S") == 1, "Chỉ duy nhất nét vẽ họa tiết in được giữ lại lệnh S trong Form XObject"
    assert ops_after.count("n") == 2, "2 nét bế trong Form XObject phải được triệt tiêu thành lệnh không vẽ n"


def test_die_cut_caching_and_simplification():
    """Kiểm tra cache và tối ưu tốc độ cho _find_largest_die_path và get_optimal_head_to_tail_overlap."""
    from app.workers.nup_diecut import _find_largest_die_path, get_optimal_head_to_tail_overlap

    outer_red = _rect_path(20, 20, 180, 180, color=(0.0, 1.0, 1.0, 0.0), spot_name="ThruCut")
    inner_cyan = _circle_path(100, 100, 40, color=(1.0, 0.0, 0.0, 0.0), spot_name="KissCut")
    page = _FakePage([outer_red, inner_cyan], w=200, h=200)

    # 1. _find_largest_die_path caching
    lp1 = _find_largest_die_path(page)
    assert lp1 is not None
    assert getattr(page, '_cached_largest_die', None) is lp1
    # Gọi lần 2 lấy ngay từ cache
    lp2 = _find_largest_die_path(page)
    assert lp2 is lp1

    # 2. get_optimal_head_to_tail_overlap caching
    res1 = get_optimal_head_to_tail_overlap(page, gap_pt=2.0)
    assert res1 is not None
    assert getattr(page, '_cached_head_to_tail', None) is not None
    # Gọi lần 2 cùng gap_pt lấy ngay từ cache
    res2 = get_optimal_head_to_tail_overlap(page, gap_pt=2.0)
    assert res2 is res1


def test_multi_cutline_group_unified_entity():
    """Kiểm tra 2 đường bế khác màu (ThruCut + KissCut) được gom thành 1 thực thể thống nhất."""
    outer_red = _rect_path(20, 20, 180, 180, color=(0.0, 1.0, 1.0, 0.0), spot_name="ThruCut")
    inner_cyan = _circle_path(100, 100, 40, color=(1.0, 0.0, 0.0, 0.0), spot_name="KissCut")
    page = _FakePage([outer_red, inner_cyan], w=200, h=200)

    # 1. extract_page_die_cut_polygon gom cả 2 đường
    poly = extract_page_die_cut_polygon(page)
    assert poly is not None
    assert poly.is_valid
    bounds = poly.bounds
    # Phải bao quát cả outer rect (20, 20, 180, 180)
    assert bounds[0] <= 21 and bounds[1] <= 21
    assert bounds[2] >= 179 and bounds[3] >= 179

    # 2. _detect_one_page_vector sinh contour bao trùm toàn bộ group
    from app.workers.die_detection import _detect_one_page_vector
    s = _detect_one_page_vector(page, 0)
    assert s is not None
    assert s.page_contour is not None
    # Dimension phải phản ánh kích thước của toàn nhóm
    assert abs(s.trim.w - 160.0) < 1.0
    assert abs(s.trim.h - 160.0) < 1.0


def test_route_true_shape_skips_single_item(monkeypatch):
    """Kiểm tra route_true_shape bỏ qua true-shape nặng nề khi chỉ có 1 tem hoặc lưới 1x1."""
    monkeypatch.setattr(
        "app.core.nesting_rollout.true_shape_nesting_enabled", lambda **_: True
    )
    from app.workers.nup_true_shape_nesting import route_true_shape

    base_settings = {
        "isDieCutMode": True,
        "gridStrategy": "optimal_auto",
        "taskMode": "step_repeat",
        "layoutType": "repeat",
        "groupingStrategy": "none",
        "sheetWidth": 320.0,
        "sheetHeight": 430.0,
        "detectedShapesByPage": {"0": "CUSTOM"},
    }

    # 1 tem bằng targetQuantity == 1 ⇒ False
    s1 = dict(base_settings, targetQuantity=1)
    assert route_true_shape(s1) is False

    # 1 tem bằng targetQuantitiesByPage: {0: 1} ⇒ False
    s2 = dict(base_settings, targetQuantitiesByPage={"0": 1})
    assert route_true_shape(s2) is False

    # 1 tem bằng lưới 1x1 ⇒ False
    s3 = dict(base_settings, columns=1, rows=1)
    assert route_true_shape(s3) is False

    # Tem kích thước quá lớn so với tờ in (sức chứa <= 1) ⇒ False
    s4 = dict(base_settings, itemW=466.2, itemH=280.9, sheetWidth=493.0, sheetHeight=317.0, marginLeft=5.0, marginRight=5.0, marginTop=5.0, marginBottom=5.0)
    assert route_true_shape(s4) is False

    # Tem nhỏ thông thường ⇒ True
    s5 = dict(base_settings, itemW=50.0, itemH=50.0, sheetWidth=493.0, sheetHeight=317.0, marginLeft=5.0, marginRight=5.0, marginTop=5.0, marginBottom=5.0)
    assert route_true_shape(s5) is True


def test_layout_compute_single_item_fast_path():
    """Kiểm tra compute_sticker_layout_for_page trả đúng 1 tem khi target_quantity=1."""
    from app.workers.sticker_imposer_pkg.layout_compute import compute_sticker_layout_for_page

    outer_red = _rect_path(20, 20, 180, 180, color=(0.0, 1.0, 1.0, 0.0), spot_name="ThruCut")
    inner_cyan = _circle_path(100, 100, 40, color=(1.0, 0.0, 0.0, 0.0), spot_name="KissCut")
    page = _FakePage([outer_red, inner_cyan], w=200, h=200)

    res = compute_sticker_layout_for_page(
        page=page,
        sheet_usable_w=800.0,
        sheet_usable_h=1000.0,
        gap_x=5.0,
        gap_y=5.0,
        strategy="optimal_auto",
        target_quantity=1,
    )

    assert res["totalItems"] == 1
    assert len(res["items"]) == 1


def test_die_detection_does_not_overgroup_multiple_stickers_on_sheet():
    """Kiểm tra không gom nhầm nhiều con tem độc lập trên cùng 1 trang vào 1 cụm bế.
    
    Tình huống: Trang có 2 con tem tách rời nhau (khoảng cách 100pt).
    Mỗi tem có 1 đường ThruCut ngoài và 1 đường KissCut trong.
    Hệ thống chỉ được gom đúng cặp (ThruCut + KissCut) của 1 con tem được chọn,
    tuyệt đối không gom cả 2 con tem thành 1 cụm 4 đường bế bao trùm cả trang.
    """
    # Tem 1 ở tọa độ (20, 20)
    s1_out = _rect_path(20, 20, 100, 100, spot_name="ThruCut")
    s1_in = _circle_path(60, 60, 20, spot_name="KissCut")

    # Tem 2 ở tọa độ (200, 20)
    s2_out = _rect_path(200, 20, 280, 100, spot_name="ThruCut")
    s2_in = _circle_path(240, 60, 20, spot_name="KissCut")

    page = _FakePage([s1_out, s1_in, s2_out, s2_in], w=500, h=500)
    merged = select_die_path(page, die_channel_names=("ThruCut", "KissCut"))

    assert merged is not None
    # Chỉ chứa đúng 2 đường bế của 1 con tem (outer + inner), KHÔNG phải 4 đường
    assert len(merged.get("groups", [])) == 2
    # Bbox chỉ bao trùm đúng 1 con tem (chiều rộng 80pt, không phải kéo dài 20..280)
    assert merged["rect"].width < 90.0
    assert merged["rect"].height < 90.0

    # Kiểm tra nup_diecut cũng chỉ trích đúng 2 nhóm của con tem đó
    groups = extract_page_die_cut_path_groups(page)
    assert len(groups) == 2


def test_spot_color_alternate_extraction_and_preservation():
    """Kiểm tra trích xuất chính xác màu alternate từ ColorSpace /Separation (/C1)."""
    import os, tempfile
    from app.workers.pdf_wrapper import Document

    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    func_dict = pdf.make_indirect(pikepdf.Dictionary({
        '/FunctionType': 2,
        '/Domain': [0.0, 1.0],
        '/C0': [0.0, 0.0, 0.0, 0.0],
        '/C1': [0.0, 1.0, 0.0, 0.0],
        '/N': 1.0
    }))
    cs_arr = pikepdf.Array([pikepdf.Name.Separation, pikepdf.Name('/CutContour'), pikepdf.Name.DeviceCMYK, func_dict])
    page.Resources = pikepdf.Dictionary(ColorSpace=pikepdf.Dictionary(CutContour=cs_arr))
    page.Contents = pdf.make_stream(b'''
q
/CutContour CS
1.0 SCN
1.0 w
50 50 m 150 50 l 150 150 l 50 150 l s
Q
''')
    with tempfile.TemporaryDirectory() as tmpdir:
        src_path = os.path.join(tmpdir, 'src.pdf')
        pdf.save(src_path)

        doc = Document(pikepdf.open(src_path))
        paths = doc[0].extract_vector_paths()
        assert len(paths) == 1
        assert paths[0]['spot_name'] == 'CutContour'
        assert paths[0]['color'] == (0.0, 1.0, 0.0, 0.0)
        doc._pdf.close()


def test_imposition_no_double_cutline_when_not_separate_cut_page():
    """Kiểm tra triệt tiêu hiện tượng vẽ trùng 2 đường bế song song khi not separate_cut_page."""
    import os, tempfile
    from app.workers.pdf_wrapper import Document
    from app.workers.nup_artwork import place_one_artwork
    from app.workers.nup_diecut import _find_largest_die_path
    from app.workers.nup_process_chunk import _draw_die_items_to_shape

    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    func_dict = pdf.make_indirect(pikepdf.Dictionary({
        '/FunctionType': 2,
        '/Domain': [0.0, 1.0],
        '/C0': [0.0, 0.0, 0.0, 0.0],
        '/C1': [0.0, 1.0, 0.0, 0.0],
        '/N': 1.0
    }))
    cs_arr = pikepdf.Array([pikepdf.Name.Separation, pikepdf.Name('/CutContour'), pikepdf.Name.DeviceCMYK, func_dict])
    page.Resources = pikepdf.Dictionary(ColorSpace=pikepdf.Dictionary(CutContour=cs_arr))
    page.Contents = pdf.make_stream(b'''
q
/CutContour CS
1.0 SCN
1.0 w
50 50 m 150 50 l 150 150 l 50 150 l s
Q
''')
    with tempfile.TemporaryDirectory() as tmpdir:
        src_path = os.path.join(tmpdir, 'src.pdf')
        pdf.save(src_path)

        src_doc = Document(pikepdf.open(src_path))
        out_doc = Document(pikepdf.new())
        out_page = out_doc.new_page(width=400, height=400)

        die_items_cache = {}
        diecut_geom_cache = {}
        placement = {
            'abs_x': 100,
            'abs_y': 100,
            'original_cell_y': 100,
            'cell': {'pageIdx': 0, 'width': 100, 'height': 100},
            'src_page_idx': 0,
            'width': 100,
            'height': 100,
            'col': 0,
            'row': 0,
            'cluster_idx': 0,
        }

        # separate_cut_page = False (mặc định)
        place_one_artwork(
            out_page, src_doc, placement,
            bleed_pt=0, is_die_cut=True, cut_type='default',
            separate_cut_page=False, local_stripped_pages=set(),
            job_id='job_test', diecut_geom_cache=diecut_geom_cache, die_items_cache=die_items_cache,
            max_geom_cache=100, block_bbox={}, clip_off_x=0, clip_off_y=0,
            find_largest_die_path=_find_largest_die_path,
        )

        cut_shape_main = out_page.new_shape()
        cached = die_items_cache.get('job_test_0')
        assert cached is not None
        assert cached['color'] == (0.0, 1.0, 0.0, 0.0)
        assert cached['spot_name'] == 'CutContour'

        for grp in cached.get('groups', []):
            _draw_die_items_to_shape(cut_shape_main, grp['items'], cached['rect'], 100, 100)
            cut_shape_main.finish(color=grp['color'], width=grp['width'], spot_name=grp['spot_name'])
        cut_shape_main.commit()

        out_path = os.path.join(tmpdir, 'out_imposed.pdf')
        out_doc._pdf.save(out_path)

        imposed_doc = Document(pikepdf.open(out_path))
        paths = imposed_doc[0].extract_vector_paths()

        # PHẢI CÓ ĐÚNG 1 ĐƯỜNG BẾ trên tờ in (triệt tiêu 100% hiện tượng double cutlines)
        assert len(paths) == 1, f"Kỳ vọng 1 đường bế duy nhất, nhưng phát hiện {len(paths)} đường bế bị vẽ trùng!"
        assert paths[0]['spot_name'] == 'CutContour'
        assert paths[0]['color'] == (0.0, 1.0, 0.0, 0.0)

        src_doc._pdf.close()
        out_doc._pdf.close()
        imposed_doc._pdf.close()


def test_strip_die_cut_reverse_vector_matching():
    """Kiểm tra _path_matches_target_items khớp chính xác dù vector đảo chiều p0->p1 vs p1->p0."""
    from app.workers.nup_artwork import _path_matches_target_items
    p_forward = ('l', 10.0, 20.0, 100.0, 20.0)
    p_reverse = ('l', 100.0, 20.0, 10.0, 20.0)
    assert _path_matches_target_items([p_forward], [p_forward]) is True
    assert _path_matches_target_items([p_reverse], [p_forward]) is True


def test_strip_die_cut_process_stroke_when_spot_present():
    """Kiểm tra tẩy nét vẽ process color cùng màu bế ngay cả khi file có khai báo kênh Spot."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    page.Contents = pdf.make_stream(b'''
q
0 1 0 0 K
1.0 w
50 50 m 150 50 l 150 150 l 50 150 l s
Q
''')
    res = strip_color_from_stream(page, (0, 1, 0, 0), target_spot="CutContour")
    assert res is True, "Phải strip thành công nét vẽ CMYK Magenta dù target_spot là CutContour"
    page.contents_coalesce()
    ops = [str(op) for _, op in pikepdf.parse_content_stream(page)]
    assert 's' not in ops and 'S' not in ops, "Lệnh vẽ nét s/S phải bị triệt tiêu"
    assert 'n' in ops, "Toán tử phải được chuyển thành n"


def test_strip_multi_spot_thrucut_and_crease_on_separate_cut_page():
    """Kiểm tra file có 2 kênh bế khác nhau (ThruCut + Crease), cả 2 đều bị tẩy 100% khỏi trang in."""
    import os, tempfile
    from app.workers.pdf_wrapper import Document
    from app.workers.nup_artwork import place_one_artwork
    from app.workers.nup_diecut import _find_largest_die_path

    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    func_dict = pdf.make_indirect(pikepdf.Dictionary({
        '/FunctionType': 2, '/Domain': [0.0, 1.0],
        '/C0': [0.0, 0.0, 0.0, 0.0], '/C1': [0.0, 1.0, 0.0, 0.0], '/N': 1.0
    }))
    cs_cut = pikepdf.Array([pikepdf.Name.Separation, pikepdf.Name('/ThruCut'), pikepdf.Name.DeviceCMYK, func_dict])
    cs_crease = pikepdf.Array([pikepdf.Name.Separation, pikepdf.Name('/Crease'), pikepdf.Name.DeviceCMYK, func_dict])
    page.Resources = pikepdf.Dictionary(ColorSpace=pikepdf.Dictionary(ThruCut=cs_cut, Crease=cs_crease))

    page.Contents = pdf.make_stream(b'''
q
/ThruCut CS
1.0 SCN
1.0 w
30 30 m 170 30 l 170 170 l 30 170 l s
Q
q
/Crease CS
1.0 SCN
0.5 w
50 50 m 150 50 l s
Q
''')

    with tempfile.TemporaryDirectory() as tmpdir:
        src_path = os.path.join(tmpdir, 'src.pdf')
        pdf.save(src_path)

        src_doc = Document(pikepdf.open(src_path))
        lp = _find_largest_die_path(src_doc[0])
        assert len(lp.get('groups', [])) == 2, "Phải gom cả đường ThruCut và đường cấn Crease vào nhóm khuôn"

        out_doc = Document(pikepdf.new())
        out_page = out_doc.new_page(width=400, height=400)
        placement = {
            'abs_x': 50, 'abs_y': 50, 'original_cell_y': 50,
            'cell': {'pageIdx': 0, 'width': 140, 'height': 140},
            'src_page_idx': 0, 'width': 140, 'height': 140,
            'col': 0, 'row': 0, 'cluster_idx': 0,
        }

        # Bình với separate_cut_page = True
        place_one_artwork(
            out_page, src_doc, placement,
            bleed_pt=0, is_die_cut=True, cut_type='default',
            separate_cut_page=True, local_stripped_pages=set(),
            job_id='job_test_sep', diecut_geom_cache={}, die_items_cache={},
            max_geom_cache=100, block_bbox={}, clip_off_x=0, clip_off_y=0,
            find_largest_die_path=_find_largest_die_path,
        )

        xobj = out_page._page.Resources.XObject[list(out_page._page.Resources.XObject.keys())[0]]
        ops_xobj = [str(op) for _, op in pikepdf.parse_content_stream(xobj)]
        assert 's' not in ops_xobj and 'S' not in ops_xobj, "Không được còn bất kỳ nét vẽ s hay S nào trên trang in!"
        assert ops_xobj.count('n') == 2, "Cả 2 nét bế ThruCut và Crease đều phải bị triệt tiêu thành n trên trang in!"

        src_doc._pdf.close()
        out_doc._pdf.close()

