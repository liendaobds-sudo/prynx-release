"""PAGEBOX (audit 2026-09-28 §WBR28.FILL): phủ viền giữ trang và artwork gốc."""
from contextlib import closing
import hashlib
import re

import cv2
import numpy as np
import pikepdf
import pytest
from PIL import ImageCms

from app.core.page_boxes import PageBoxesEngine
from app.core.pdfium_lock import pdfium_guard
from app.workers.sticker_engine import _rectangle_vector_bleed_commands

pdfium = pytest.importorskip("pypdfium2")
ALL_SIDES = ["left", "top", "right", "bottom"]
BOXES = ("/MediaBox", "/CropBox", "/TrimBox", "/BleedBox", "/ArtBox")


@pytest.fixture
def engine(tmp_path):
    value = PageBoxesEngine()
    value.output_dir = tmp_path / "results"
    value.output_dir.mkdir()
    return value


def _raw_box(values, origin, user_unit):
    return [
        float(value) / user_unit + origin[index % 2]
        for index, value in enumerate(values)
    ]


def _make_source(
    path, *, user_unit=1.0, rotation=0, origin=(0.0, 0.0),
    outside_crop=False, inherit=False, alpha=False, extra_page=False,
    blank=False, leaky_state=False, content_shift=(0.0, 0.0),
):
    """Khổ 200×150 pt; bốn dải viền không đều; mốc xanh nằm trong lõi."""
    with pikepdf.Pdf.new() as doc:
        page = doc.add_blank_page(page_size=(200, 150))
        for name, bounds in (
            ("/MediaBox", [0, 0, 200, 150]),
            ("/CropBox", [-12, -9, 230, 180] if outside_crop else [0, 0, 200, 150]),
            ("/TrimBox", [6, 7, 194, 142]),
            ("/BleedBox", [2, 3, 198, 147]),
            ("/ArtBox", [24, 18, 154, 114]),
        ):
            page[pikepdf.Name(name)] = pikepdf.Array(_raw_box(bounds, origin, user_unit))
        page.UserUnit = user_unit
        page.Rotate = rotation

        nested = pikepdf.Stream(doc, b"0 0 1 rg 0 0 8 8 re f\n")
        nested.Type = pikepdf.Name.XObject
        nested.Subtype = pikepdf.Name.Form
        nested.BBox = pikepdf.Array([0, 0, 8, 8])
        nested.Resources = pikepdf.Dictionary()
        page.Resources = pikepdf.Dictionary(
            XObject=pikepdf.Dictionary({"/Nested": nested}),
        )
        alpha_op = ""
        if alpha:
            page.Group = pikepdf.Dictionary(
                S=pikepdf.Name.Transparency, I=True, CS=pikepdf.Name.DeviceRGB,
            )
            page.Resources.ExtGState = pikepdf.Dictionary({
                "/Half": pikepdf.Dictionary(ca=0.5, CA=0.5),
            })
            alpha_op = "/Half gs\n"
        prefix = "" if leaky_state else "q\n"
        suffix = "" if leaky_state else "Q\n"
        content = (
            prefix
            + f"{1/user_unit:.16f} 0 0 {1/user_unit:.16f} {origin[0]:.16f} {origin[1]:.16f} cm\n"
            + f"1 0 0 1 {content_shift[0]:.16f} {content_shift[1]:.16f} cm\n"
            + alpha_op
            + "1 0 0 rg 24 18 130 96 re f\n"
            + "0 1 0 rg 148 18 6 96 re f\n"
            + "0 1 1 rg 24 18 130 6 re f\n"
            + "1 1 0 rg 24 108 130 6 re f\n"
            + "1 0 1 rg 24 26 0.7086614173 78 re f\n"
            + "q 1 0 0 1 50 50 cm /Nested Do Q\n"
            + suffix
        )
        if leaky_state:
            # Clip/CTM cuối không tác động nét đã vẽ, nhưng sẽ làm hỏng fill
            # nếu chỉ append q mà không bao lại Contents nguồn.
            content += "0 0 0 0 re W n 1 0 0 1 900 900 cm\n"
        page.Contents = pikepdf.Stream(doc, b"" if blank else content.encode("ascii"))
        page.Annots = pikepdf.Array([doc.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Text,
            Rect=pikepdf.Array(_raw_box([5, 5, 10, 10], origin, user_unit)),
            F=2, Contents="Ghi chú giữ nguyên",
        ))])

        profile = pikepdf.Stream(
            doc, ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes(),
        )
        profile.N = 3
        doc.Root.OutputIntents = pikepdf.Array([doc.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name.OutputIntent, S=pikepdf.Name.GTS_PDFX,
            OutputConditionIdentifier="Giữ profile nguồn", DestOutputProfile=profile,
        ))])
        doc.docinfo["/Title"] = "Nguồn kiểm thử phủ viền"

        if inherit:
            for name in ("/MediaBox", "/CropBox", "/Rotate", "/Resources"):
                page.obj.Parent[name] = page.obj[name]
                del page.obj[name]
        if extra_page:
            other = doc.add_blank_page(page_size=(130, 170))
            other.CropBox = pikepdf.Array([5, 10, 120, 160])
            other.TrimBox = pikepdf.Array([10, 15, 115, 155])
            other.Rotate = 270
            other.Contents = pikepdf.Stream(doc, b"0 1 0 rg 0 0 130 170 re f\n")
        doc.save(path)


def _render(path, page_index=0, scale=4.0, transparent=False):
    with pikepdf.Pdf.open(path) as doc:
        user_unit = float(doc.pages[page_index].get("/UserUnit", 1))
    with pdfium_guard("test_page_boxes_autofill"):
        with pdfium.PdfDocument(str(path)) as doc:
            with closing(doc[page_index]) as page:
                kwargs = {"fill_color": (0, 0, 0, 0)} if transparent else {}
                with closing(page.render(scale=scale * user_unit, **kwargs)) as bitmap:
                    mode = "RGBA" if transparent else "RGB"
                    return np.array(bitmap.to_pil().convert(mode), copy=True)


def _contents(page):
    value = page.get("/Contents")
    streams = list(value) if isinstance(value, pikepdf.Array) else [value]
    return b"\n".join(stream.read_bytes() for stream in streams if stream is not None)


def _page_state(page):
    return {
        "boxes": {
            name: [float(v) for v in page.get(name)]
            for name in BOXES if page.get(name) is not None
        },
        "rotation": int(page.get("/Rotate", 0)),
        "user_unit": float(page.get("/UserUnit", 1)),
        "annotations": [
            ([float(v) for v in item.Rect], str(item.Contents), int(item.F))
            for item in page.get("/Annots", [])
        ],
    }


def _profile_hash(doc):
    return hashlib.sha256(
        doc.Root.OutputIntents[0].DestOutputProfile.read_bytes()
    ).hexdigest()


def _pixel(rgb, x, y, rotation=0, scale=4.0):
    """Điểm vật lý trên nguồn → pixel của ảnh đã áp góc xoay."""
    if rotation == 90:
        x, y, height = y, 200 - x, 200
    elif rotation == 180:
        x, y, height = 200 - x, 150 - y, 150
    elif rotation == 270:
        x, y, height = 150 - y, x, 200
    else:
        height = 150
    return rgb[int((height - y) * scale), int(x * scale), :3]


def _assert_core_unchanged(before, after):
    assert after.shape == before.shape
    ink = np.any(before[:, :, :3] < 240, axis=2)
    if before.shape[2] == 4:
        ink &= before[:, :, 3] > 100
    ink = ink.astype(np.uint8)
    core = cv2.erode(ink, np.ones((9, 9), dtype=np.uint8)) > 0
    assert int(core.sum()) > 100
    np.testing.assert_array_equal(after[core], before[core])


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("user_unit", [0.5, 1.0, 2.0, 4.0])
@pytest.mark.parametrize("origin", [(0.0, 0.0), (-70.25, 31.125)])
def test_fill_preserves_geometry_and_core(tmp_path, engine, rotation, user_unit, origin):
    source = tmp_path / "nguon.pdf"
    _make_source(
        source, user_unit=user_unit, rotation=rotation, origin=origin,
        outside_crop=True,
    )
    original_bytes = source.read_bytes()
    before = _render(source)
    output = engine.auto_trim(str(source), trim_sides=ALL_SIDES, mode="fill")
    after = _render(output)
    _assert_core_unchanged(before, after)

    # Màu độc lập trên bốn cạnh bắt được đảo trái/phải/trên/dưới và sai UserUnit.
    for (x, y), expected in [
        ((10, 65), (255, 0, 0)), ((185, 65), (0, 255, 0)),
        ((80, 8), (0, 255, 255)), ((80, 135), (255, 255, 0)),
    ]:
        assert _pixel(after, x, y, rotation) == pytest.approx(expected, abs=3)
    # Mốc magenta mỏng 0,25 mm không bị lấy mẫu sâu 0,5 mm xoá mất.
    assert _pixel(after, 24.5, 65, rotation) == pytest.approx((255, 0, 255), abs=3)
    with pikepdf.Pdf.open(source) as src, pikepdf.Pdf.open(output) as result:
        assert _page_state(result.pages[0]) == _page_state(src.pages[0])
        assert _profile_hash(result) == _profile_hash(src)
        assert result.docinfo["/Title"] == src.docinfo["/Title"]
        assert _contents(src.pages[0]) in _contents(result.pages[0])
        forms = result.pages[0].Resources.XObject
        added = [value for name, value in forms.items() if str(name) != "/Nested"]
        assert len(added) == 1
        form = added[0]
        assert list(form.Matrix) == [user_unit, 0, 0, user_unit, 0, 0]
        assert set(str(name) for name in form.Resources.XObject.keys()) == {"/Nested"}
        assert all(child.objgen != form.objgen for child in form.Resources.XObject.values())
        assert all(value.Subtype == pikepdf.Name.Form for value in forms.values())
    assert source.read_bytes() == original_bytes


@pytest.mark.parametrize("rotation", [0, 90])
@pytest.mark.parametrize("user_unit,origin", [
    (1.0, (0.00001, -0.00002)),
    (20000.0, (0.0, 0.0)),
    (75000.0, (0.00001, -0.00002)),
])
def test_fill_small_origin_large_user_unit_uses_pdf_numbers(
    tmp_path, engine, rotation, user_unit, origin,
):
    source = tmp_path / "toa_do_nho.pdf"
    _make_source(source, rotation=rotation, user_unit=user_unit, origin=origin)
    exponent_number = rb"[+-]?(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?\d+"
    with pikepdf.Pdf.open(source) as doc:
        assert not any(
            re.fullmatch(exponent_number, token) for token in _contents(doc.pages[0]).split()
        )
    before = _render(source)
    assert _pixel(before, 80, 65, rotation) == pytest.approx((255, 0, 0), abs=3)
    output = engine.auto_trim(str(source), mode="fill", trim_sides=ALL_SIDES)
    with pikepdf.Pdf.open(output) as result:
        fill_stream = list(result.pages[0].Contents)[-1].read_bytes()
        # Content stream PDF chỉ nhận số thập phân, không nhận 1e-05/5e-05.
        assert not any(
            re.fullmatch(exponent_number, token) for token in fill_stream.split()
        ), fill_stream
    after = _render(output)
    _assert_core_unchanged(before, after)
    for point, color in [
        ((10, 65), (255, 0, 0)), ((185, 65), (0, 255, 0)),
        ((80, 8), (0, 255, 255)), ((80, 135), (255, 255, 0)),
    ]:
        assert _pixel(after, *point, rotation) == pytest.approx(color, abs=3)


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("side", ALL_SIDES)
def test_fill_respects_selected_display_side(tmp_path, engine, rotation, side):
    source = tmp_path / "canh.pdf"
    _make_source(source, rotation=rotation, user_unit=2, origin=(-7, 13))
    before = _render(source)
    output = engine.auto_trim(str(source), trim_sides=[side], mode="fill")
    after = _render(output)
    _assert_core_unchanged(before, after)
    height, width = before.shape[:2]
    bands = {
        "left": (slice(height // 3, 2 * height // 3), slice(8, 24)),
        "right": (slice(height // 3, 2 * height // 3), slice(width - 24, width - 8)),
        "top": (slice(8, 24), slice(width // 3, 2 * width // 3)),
        "bottom": (slice(height - 24, height - 8), slice(width // 3, 2 * width // 3)),
    }
    for name, region in bands.items():
        if name == side:
            assert float(np.any(after[region] < 240, axis=2).mean()) > 0.98
        else:
            np.testing.assert_array_equal(after[region], before[region])


def test_fill_inherited_resources_boxes_and_graphics_state(tmp_path, engine):
    source = tmp_path / "ke_thua.pdf"
    _make_source(
        source, inherit=True, leaky_state=True, rotation=90,
        user_unit=4, origin=(-13.25, 7.5), outside_crop=True,
    )
    before = _render(source)
    output = engine.auto_trim(str(source), trim_sides=ALL_SIDES, mode="fill")
    after = _render(output)
    _assert_core_unchanged(before, after)
    assert _pixel(after, 10, 65, 90) == pytest.approx((255, 0, 0), abs=3)


def test_fill_subset_and_duplicate_pages_are_idempotent(tmp_path, engine):
    source = tmp_path / "nhieu_trang.pdf"
    _make_source(source, extra_page=True)
    once = engine.auto_trim(str(source), pages=[1], trim_sides=ALL_SIDES, mode="fill")
    twice = engine.auto_trim(str(source), pages=[1, 1], trim_sides=ALL_SIDES, mode="fill")
    np.testing.assert_array_equal(_render(once), _render(twice))
    np.testing.assert_array_equal(_render(source, 1), _render(once, 1))
    _assert_core_unchanged(_render(source), _render(once))
    with pikepdf.Pdf.open(source) as src, pikepdf.Pdf.open(once) as out:
        assert _page_state(out.pages[1]) == _page_state(src.pages[1])
        assert _contents(out.pages[1]) == _contents(src.pages[1])
        assert len(out.pages[0].Resources.XObject) == 2
        assert all(
            value.Subtype == pikepdf.Name.Form
            for value in out.pages[0].Resources.XObject.values()
        )


@pytest.mark.parametrize("margin", [0.5, -1, float("nan"), float("inf")])
def test_fill_rejects_margin_before_file_io(tmp_path, engine, margin):
    with pytest.raises(ValueError, match="lề bổ sung 0"):
        engine.auto_trim(str(tmp_path / "khong_ton_tai.pdf"), margin_mm=margin, mode="fill")
    assert not list(engine.output_dir.iterdir())


def test_fill_rejects_unknown_mode_before_file_io(tmp_path, engine):
    with pytest.raises(ValueError, match="Cách xử lý viền"):
        engine.auto_trim(str(tmp_path / "khong_ton_tai.pdf"), mode="unknown")


def test_fill_explicit_failure_leaves_no_partial_result(tmp_path, engine):
    source = tmp_path / "trang_sau_khong_vien.pdf"
    _make_source(source, extra_page=True)
    original_bytes = source.read_bytes()
    with pytest.raises(ValueError, match="Trang 2.*phủ"):
        engine.auto_trim(str(source), pages=[1, 2], trim_sides=ALL_SIDES, mode="fill")
    assert not list(engine.output_dir.iterdir())
    assert source.read_bytes() == original_bytes


def test_fill_blank_legacy_noop_and_explicit_fails(tmp_path, engine):
    source = tmp_path / "trang_trang.pdf"
    _make_source(source, blank=True)
    output = engine.auto_trim(str(source), mode="fill")
    np.testing.assert_array_equal(_render(source), _render(output))
    with pytest.raises(ValueError, match="phủ"):
        engine.auto_trim(str(source), trim_sides=ALL_SIDES, mode="fill")


def test_default_mode_keeps_trim_contract(tmp_path, engine):
    source = tmp_path / "xen_cu.pdf"
    _make_source(source, rotation=270, user_unit=2, origin=(13, -8))
    legacy = engine.auto_trim(str(source), margin_mm=0.5, trim_sides=ALL_SIDES)
    explicit = engine.auto_trim(
        str(source), margin_mm=0.5, trim_sides=ALL_SIDES, mode="trim",
    )
    np.testing.assert_array_equal(_render(legacy), _render(explicit))
    with pikepdf.Pdf.open(legacy) as old, pikepdf.Pdf.open(explicit) as new:
        assert _page_state(old.pages[0]) == _page_state(new.pages[0])
        assert "/TrimBox" not in new.pages[0]


def test_vector_helper_equal_pads_are_exact_legacy_commands():
    args = dict(
        xobject_name="/Form", crop_x0=-14, crop_y0=13,
        page_width=100, page_height=50, bleed_pts=3,
        edge_bite_pts=0, sample_depth_pts=0.24, sample_inset_pts=1.417,
    )
    assert _rectangle_vector_bleed_commands(**args) == _rectangle_vector_bleed_commands(
        **args, bleed_amounts_pts=(3, 3, 3, 3),
    )
    commands, *bites = _rectangle_vector_bleed_commands(
        **{**args, "bleed_pts": 0}, bleed_amounts_pts=(2, 5, 7, 11),
    )
    assert bites == [0, 0, 0, 0]
    clips = [line for line in commands if line.endswith("re W n")]
    assert clips[:4] == [
        "0.0000 7.0000 2.0000 50.0000 re W n",
        "102.0000 7.0000 5.0000 50.0000 re W n",
        "2.0000 0.0000 100.0000 7.0000 re W n",
        "2.0000 57.0000 100.0000 11.0000 re W n",
    ]
    disabled, *_ = _rectangle_vector_bleed_commands(
        **args, bleed_amounts_pts=(2, 0, 0, 0), sides=["left"],
    )
    assert sum(line.endswith("re W n") for line in disabled) == 1


@pytest.mark.parametrize("pads", [(1, 2, 3), (1, -2, 3, 4), (1, 2, float("nan"), 4)])
def test_vector_helper_rejects_invalid_pads(pads):
    with pytest.raises(ValueError, match="bốn số hữu hạn"):
        _rectangle_vector_bleed_commands(
            "/Form", crop_x0=0, crop_y0=0, page_width=10, page_height=10,
            bleed_pts=2, edge_bite_pts=0, sample_depth_pts=0.24,
            bleed_amounts_pts=pads,
        )


def _make_color_source(
    path, kind, *, rotation=0, user_unit=1, origin=(-17.375, 8.625),
):
    """Mẫu một màu, bbox lẻ pixel để đo seam và giữ CMYK/spot/SMask."""
    with pikepdf.Pdf.new() as doc:
        page = doc.add_blank_page(page_size=(200, 150))
        page.MediaBox = pikepdf.Array(_raw_box([0, 0, 200, 150], origin, user_unit))
        page.CropBox = pikepdf.Array(page.MediaBox)
        page.Rotate = rotation
        page.UserUnit = user_unit
        page.Resources = pikepdf.Dictionary()
        if kind == "cmyk":
            draw = "0.75 0 0.65 0.1 k 24.17 18.31 130.26 95.98 re f"
        elif kind == "separation":
            tint = pikepdf.Dictionary(
                FunctionType=2, Domain=pikepdf.Array([0, 1]),
                C0=pikepdf.Array([0, 0, 0, 0]),
                C1=pikepdf.Array([1, 0, 1, 0]), N=1,
            )
            page.Resources.ColorSpace = pikepdf.Dictionary({
                "/SpotGreen": pikepdf.Array([
                    pikepdf.Name.Separation, pikepdf.Name("/MucXanh"),
                    pikepdf.Name.DeviceCMYK, doc.make_indirect(tint),
                ]),
            })
            draw = "/SpotGreen cs 1 scn 24.17 18.31 130.26 95.98 re f"
        elif kind == "smask":
            soft_mask = pikepdf.Stream(doc, bytes([128] * 16))
            soft_mask.Type = pikepdf.Name.XObject
            soft_mask.Subtype = pikepdf.Name.Image
            soft_mask.Width = soft_mask.Height = 4
            soft_mask.BitsPerComponent = 8
            soft_mask.ColorSpace = pikepdf.Name.DeviceGray
            image = pikepdf.Stream(doc, bytes([0, 160, 80] * 16))
            image.Type = pikepdf.Name.XObject
            image.Subtype = pikepdf.Name.Image
            image.Width = image.Height = 4
            image.BitsPerComponent = 8
            image.ColorSpace = pikepdf.Name.DeviceRGB
            image.SMask = soft_mask
            page.Resources.XObject = pikepdf.Dictionary({"/AlphaImage": image})
            page.Group = pikepdf.Dictionary(
                S=pikepdf.Name.Transparency, CS=pikepdf.Name.DeviceRGB, I=True,
            )
            draw = "q 130.26 0 0 95.98 24.17 18.31 cm /AlphaImage Do Q"
        else:
            raise AssertionError(kind)
        content = (
            "q\n"
            + f"{1/user_unit:.16f} 0 0 {1/user_unit:.16f} {origin[0]:.16f} {origin[1]:.16f} cm\n"
            + draw + "\nQ\n"
        )
        page.Contents = pikepdf.Stream(doc, content.encode("ascii"))
        doc.save(path)


@pytest.mark.parametrize("kind", ["cmyk", "separation"])
def test_fill_keeps_original_color_resources(tmp_path, engine, kind):
    source = tmp_path / f"mau_{kind}.pdf"
    _make_color_source(source, kind, rotation=90, user_unit=2)
    output = engine.auto_trim(str(source), mode="fill", trim_sides=ALL_SIDES)
    before = _render(source)
    after = _render(output)
    _assert_core_unchanged(before, after)
    sample = _pixel(after, 80, 65, 90)
    for point in [(10, 65), (185, 65), (80, 8), (80, 135), (10, 8)]:
        assert _pixel(after, *point, 90) == pytest.approx(sample, abs=3)
    with pikepdf.Pdf.open(source) as src, pikepdf.Pdf.open(output) as result:
        page = result.pages[0]
        forms = [
            value for value in page.Resources.XObject.values()
            if value.Subtype == pikepdf.Name.Form
        ]
        assert len(forms) == 1
        form = forms[0]
        assert form.read_bytes() == _contents(src.pages[0])
        assert _page_state(page) == _page_state(src.pages[0])
        if kind == "separation":
            space = form.Resources.ColorSpace.SpotGreen
            assert [space[index] for index in range(3)] == [
                pikepdf.Name.Separation, pikepdf.Name("/MucXanh"),
                pikepdf.Name.DeviceCMYK,
            ]
            assert list(space[3].C1) == [1, 0, 1, 0]
        if kind == "cmyk":
            assert b"0.75 0 0.65 0.1 k" in form.read_bytes()
            assert all(value.Subtype == pikepdf.Name.Form for value in page.Resources.XObject.values())


def _make_transparent_source(path, kind):
    if kind == "smask":
        _make_color_source(path, kind)
        return
    _make_source(path, alpha=kind == "extgstate")
    if kind == "extgstate":
        return
    with pikepdf.Pdf.open(path, allow_overwriting_input=True) as doc:
        page = doc.pages[0]
        if kind == "nested_form":
            form = page.Resources.XObject.Nested
            form.Resources.ExtGState = pikepdf.Dictionary({
                "/Half": pikepdf.Dictionary(ca=0.5, CA=0.5),
            })
            form.write(b"/Half gs\n" + form.read_bytes())
        elif kind == "blend_mode":
            page.Resources.ExtGState = pikepdf.Dictionary({
                "/Multiply": pikepdf.Dictionary(BM=pikepdf.Name.Multiply),
            })
            page.Contents = pikepdf.Stream(doc, b"/Multiply gs\n" + _contents(page))
        elif kind == "opaque_group":
            page.Group = pikepdf.Dictionary(
                S=pikepdf.Name.Transparency, I=True, CS=pikepdf.Name.DeviceRGB,
            )
        elif kind == "unused_alpha":
            page.Resources.ExtGState = pikepdf.Dictionary({
                "/KhongDung": pikepdf.Dictionary(ca=0.5, CA=0.5),
            })
        else:
            raise AssertionError(kind)
        doc.save(path)


@pytest.mark.parametrize("kind", [
    "smask", "extgstate", "nested_form", "blend_mode", "opaque_group", "unused_alpha",
])
def test_fill_rejects_transparency_without_touching_source(tmp_path, engine, kind):
    # Bằng chứng WBR28.FILL.ALPHA: SMask=128 từng lên 218 ở mối nối tile,
    # còn Poppler mất góc. Hợp đồng lô đầu là báo lỗi, không âm thầm flatten.
    source = tmp_path / f"trong_suot_{kind}.pdf"
    _make_transparent_source(source, kind)
    original = source.read_bytes()
    with pytest.raises(ValueError, match="Trang 1.*phủ viền an toàn.*độ trong suốt"):
        engine.auto_trim(str(source), mode="fill", trim_sides=ALL_SIDES)
    assert source.read_bytes() == original
    assert not list(engine.output_dir.iterdir())


def test_fill_checks_transparency_only_on_selected_pages(tmp_path, engine):
    source = tmp_path / "trang_chon.pdf"
    transparent = tmp_path / "trang_trong_suot.pdf"
    _make_source(source)
    _make_transparent_source(transparent, "smask")
    with pikepdf.Pdf.open(source, allow_overwriting_input=True) as doc:
        with pikepdf.Pdf.open(transparent) as other:
            doc.pages.append(other.pages[0])
        doc.save(source)
    before = _render(source, page_index=1, transparent=True)
    output = engine.auto_trim(str(source), pages=[1], mode="fill", trim_sides=ALL_SIDES)
    np.testing.assert_array_equal(before, _render(output, page_index=1, transparent=True))
    existing = set(engine.output_dir.iterdir())
    original = source.read_bytes()
    with pytest.raises(ValueError, match="Trang 2.*độ trong suốt"):
        engine.auto_trim(str(source), pages=[1, 2], mode="fill", trim_sides=ALL_SIDES)
    assert set(engine.output_dir.iterdir()) == existing
    assert source.read_bytes() == original


def test_default_trim_still_accepts_soft_mask(tmp_path, engine):
    source = tmp_path / "van_xen_smask.pdf"
    _make_transparent_source(source, "smask")
    output = engine.auto_trim(str(source), trim_sides=ALL_SIDES)
    with pikepdf.Pdf.open(source) as src, pikepdf.Pdf.open(output) as result:
        assert _contents(result.pages[0]) == _contents(src.pages[0])
        assert result.pages[0].Resources.XObject.AlphaImage.SMask.read_bytes() == (
            src.pages[0].Resources.XObject.AlphaImage.SMask.read_bytes()
        )
        assert float(result.pages[0].MediaBox[2]) < float(src.pages[0].MediaBox[2])


def _make_pattern_source(path, location, alpha):
    _make_source(path)
    with pikepdf.Pdf.open(path, allow_overwriting_input=True) as doc:
        page = doc.pages[0]
        pattern_resources = pikepdf.Dictionary()
        draw = "0 1 0 rg 0 0 10 10 re f"
        if alpha:
            pattern_resources.ExtGState = pikepdf.Dictionary({
                "/Half": pikepdf.Dictionary(ca=0.5, CA=0.5),
            })
            draw = "/Half gs " + draw
        pattern = pikepdf.Stream(doc, draw.encode("ascii"))
        pattern.Type = pikepdf.Name.Pattern
        pattern.PatternType = pattern.PaintType = pattern.TilingType = 1
        pattern.BBox = pikepdf.Array([0, 0, 10, 10])
        pattern.XStep = pattern.YStep = 10
        pattern.Resources = pattern_resources
        resources = pikepdf.Dictionary(Pattern=pikepdf.Dictionary({"/MauLap": pattern}))
        draw = "/Pattern cs /MauLap scn 0 0 8 8 re f"
        if location == "page":
            page.Resources.Pattern = resources.Pattern
            page.Contents = pikepdf.Stream(
                doc, _contents(page) + b"\nq 1 0 0 1 50 50 cm " + draw.encode("ascii") + b" Q\n",
            )
        elif location == "form":
            form = page.Resources.XObject.Nested
            form.Resources = resources
            form.write(draw.encode("ascii"))
        elif location == "type3":
            glyph = pikepdf.Stream(doc, ("8 0 d0 " + draw).encode("ascii"))
            font = pikepdf.Dictionary(
                Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type3,
                FontBBox=pikepdf.Array([0, 0, 8, 8]),
                FontMatrix=pikepdf.Array([1, 0, 0, 1, 0, 0]),
                FirstChar=65, LastChar=65, Widths=pikepdf.Array([8]),
                Encoding=pikepdf.Dictionary(
                    Type=pikepdf.Name.Encoding, Differences=pikepdf.Array([65, pikepdf.Name.A]),
                ),
                CharProcs=pikepdf.Dictionary({"/A": glyph}), Resources=resources,
            )
            page.Resources.Font = pikepdf.Dictionary({"/ChuMau": doc.make_indirect(font)})
            page.Contents = pikepdf.Stream(
                doc, _contents(page) + b"\nBT /ChuMau 1 Tf 50 50 Td (A) Tj ET\n",
            )
        else:
            raise AssertionError(location)
        doc.save(path)


@pytest.mark.parametrize("location", ["page", "form", "type3"])
@pytest.mark.parametrize("alpha", [False, True])
def test_fill_rejects_pattern_resources_conservatively(tmp_path, engine, location, alpha):
    source = tmp_path / "mau_lap.pdf"
    _make_pattern_source(source, location, alpha)
    original = source.read_bytes()
    with pytest.raises(ValueError, match=r"Trang 1.*mẫu tô lặp \(Pattern\)"):
        engine.auto_trim(str(source), mode="fill", trim_sides=ALL_SIDES)
    assert source.read_bytes() == original
    assert not list(engine.output_dir.iterdir())


def test_fill_does_not_reject_pattern_on_unselected_page(tmp_path, engine):
    source = tmp_path / "trang_chon_khong_pattern.pdf"
    other_source = tmp_path / "trang_pattern.pdf"
    _make_source(source)
    _make_pattern_source(other_source, "form", True)
    with pikepdf.Pdf.open(source, allow_overwriting_input=True) as doc:
        with pikepdf.Pdf.open(other_source) as other:
            doc.pages.append(other.pages[0])
        doc.save(source)
    output = engine.auto_trim(str(source), pages=[1], mode="fill", trim_sides=ALL_SIDES)
    np.testing.assert_array_equal(_render(source, page_index=1), _render(output, page_index=1))

