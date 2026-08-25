"""
Test hàm thuần _pixel_bbox_to_cropbox — ánh xạ bbox pixel (ảnh pdfium ĐÃ áp
/Rotate) → CropBox trong toạ độ trang gốc, cho cả 4 góc quay.

Đây là phần dễ sai nhất của auto_trim: pdfium render ảnh đã xoay nên pix_w/pix_h
hoán đổi khi 90/270; nếu ánh xạ sai thì box xén lệch hẳn với file có /Rotate.
"""
import numpy as np
import pikepdf
import pytest

from app.core.page_boxes import (
    PT_PER_MM,
    PageBoxesEngine,
    _find_edge_background_content_bbox,
    _find_nonwhite_content_bbox,
    _pixel_bbox_to_cropbox,
)


# Trang gốc (chưa xoay): 200pt rộng × 100pt cao, gốc CropBox tại (0,0).
CB = [0.0, 0.0, 200.0, 100.0]
DPI_SCALE = 200.0 / 72.0  # khớp DETECT_SCALE trong auto_trim


def _render_px(cb, rotate):
    """Kích thước ảnh pdfium (đã áp /Rotate) theo cùng scale auto_trim dùng."""
    w = cb[2] - cb[0]
    h = cb[3] - cb[1]
    if rotate % 360 in (90, 270):
        w, h = h, w
    return int(round(w * DPI_SCALE)), int(round(h * DPI_SCALE))


def test_rotate_0_maps_content_region():
    # Nội dung nằm ở dải giữa trang gốc. Không xoay: pixel trực tiếp.
    pix_w, pix_h = _render_px(CB, 0)
    # bbox pixel: cột 20%..80%, hàng 10%..90% (gốc trên-trái).
    x0 = int(0.20 * pix_w); x1 = int(0.80 * pix_w)
    y0 = int(0.10 * pix_h); y1 = int(0.90 * pix_h)
    box = _pixel_bbox_to_cropbox(x0, y0, x1, y1, pix_w, pix_h, CB, 0, margin_pt=0)
    # x theo bề rộng 200pt: 20%..80% → ~40..160
    assert box[0] == pytest.approx(40, abs=1.0)
    assert box[2] == pytest.approx(160, abs=1.0)
    # y: pixel hàng 10%..90% từ TRÊN → trong PDF (gốc dưới) là 10%..90% từ dưới của 100pt
    assert box[1] == pytest.approx(10, abs=1.0)
    assert box[3] == pytest.approx(90, abs=1.0)


def test_all_rotations_map_same_source_region():
    """Cùng một vùng nội dung VẬT LÝ trên trang, render ở 4 góc quay khác nhau,
    phải map về CÙNG một CropBox trong toạ độ trang gốc."""
    # Vùng nội dung mục tiêu trong toạ độ trang gốc (chưa xoay), gốc dưới-trái:
    # u (bề rộng) 40..160 của 200; v (bề cao) 10..90 của 100.
    target = [40.0, 10.0, 160.0, 90.0]
    W, H = 200.0, 100.0

    for rotate in (0, 90, 180, 270):
        pix_w, pix_h = _render_px(CB, rotate)
        # Ánh xạ vùng target → bbox pixel trên ảnh ĐÃ xoay (đảo phép trong hàm).
        # Toạ độ trang gốc: u∈[40,160] dọc bề rộng, v∈[10,90] dọc bề cao.
        u0, u1 = target[0], target[2]
        v0, v1 = target[1], target[3]
        if rotate == 0:
            X0, X1 = u0, u1
            Ytop0, Ytop1 = H - v1, H - v0  # pixel-y (từ trên)
            disp_w, disp_h = W, H
        elif rotate == 90:
            X0, X1 = v0, v1
            Ytop0, Ytop1 = u0, u1
            disp_w, disp_h = H, W
        elif rotate == 180:
            X0, X1 = W - u1, W - u0
            Ytop0, Ytop1 = v0, v1
            disp_w, disp_h = W, H
        else:  # 270
            X0, X1 = H - v1, H - v0
            Ytop0, Ytop1 = W - u1, W - u0
            disp_w, disp_h = H, W

        sx = pix_w / disp_w
        sy = pix_h / disp_h
        px0 = int(round(X0 * sx)); px1 = int(round(X1 * sx)) - 1
        py0 = int(round(Ytop0 * sy)); py1 = int(round(Ytop1 * sy)) - 1

        box = _pixel_bbox_to_cropbox(px0, py0, px1, py1, pix_w, pix_h, CB, rotate, margin_pt=0)

        assert box[0] == pytest.approx(target[0], abs=1.5), f"rot={rotate} x0"
        assert box[1] == pytest.approx(target[1], abs=1.5), f"rot={rotate} y0"
        assert box[2] == pytest.approx(target[2], abs=1.5), f"rot={rotate} x1"
        assert box[3] == pytest.approx(target[3], abs=1.5), f"rot={rotate} y1"


def test_margin_expands_box_and_clamps():
    pix_w, pix_h = _render_px(CB, 0)
    x0 = int(0.40 * pix_w); x1 = int(0.60 * pix_w)
    y0 = int(0.40 * pix_h); y1 = int(0.60 * pix_h)
    margin_pt = 5 * PT_PER_MM
    box = _pixel_bbox_to_cropbox(x0, y0, x1, y1, pix_w, pix_h, CB, 0, margin_pt=margin_pt)
    # box vẫn nằm trong CropBox gốc (clamp).
    assert box[0] >= CB[0] - 1e-6
    assert box[1] >= CB[1] - 1e-6
    assert box[2] <= CB[2] + 1e-6
    assert box[3] <= CB[3] + 1e-6


def test_cropbox_offset_origin_respected():
    """CropBox không bắt đầu ở (0,0) → box trả về phải cộng offset gốc."""
    cb = [50.0, 30.0, 250.0, 130.0]  # 200×100 nhưng dời gốc
    pix_w, pix_h = _render_px(cb, 0)
    x0 = int(0.0 * pix_w); x1 = pix_w - 1
    y0 = 0; y1 = pix_h - 1
    box = _pixel_bbox_to_cropbox(x0, y0, x1, y1, pix_w, pix_h, cb, 0, margin_pt=0)
    # Toàn bộ nội dung → box ≈ cb.
    assert box[0] == pytest.approx(cb[0], abs=1.5)
    assert box[1] == pytest.approx(cb[1], abs=1.5)
    assert box[2] == pytest.approx(cb[2], abs=1.5)
    assert box[3] == pytest.approx(cb[3], abs=1.5)


def _previous_nonwhite_bbox(arr: np.ndarray, min_area: int):
    """Thuật toán trước tối ưu, giữ tại test để khóa parity pixel tuyệt đối."""
    cv2 = pytest.importorskip("cv2")
    if arr.ndim == 3 and arr.shape[2] >= 3:
        mask = np.any(arr[:, :, :3] < 248, axis=2).astype(np.uint8)
    else:
        mask = (arr[:, :, 0] < 248).astype(np.uint8)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    clean = np.zeros_like(mask)
    for index in range(1, count):
        if stats[index, cv2.CC_STAT_AREA] >= min_area:
            clean[labels == index] = 1
    if not clean.any():
        return None
    rows = np.any(clean, axis=1)
    cols = np.any(clean, axis=0)
    y0, y1 = np.where(rows)[0][[0, -1]]
    x0, x1 = np.where(cols)[0][[0, -1]]
    return ((int(x0), int(y0), int(x1), int(y1)), int(clean.sum()))


@pytest.mark.parametrize("channels", [3, 4])
def test_fast_nonwhite_bbox_matches_previous_algorithm(channels):
    """PERF §RT.1: đường stats nhanh phải giữ nguyên bbox và số pixel sạch."""
    arr = np.full((240, 320, channels), 255, dtype=np.uint8)
    if channels == 4:
        arr[:, :, 3] = 0  # alpha không tham gia nhận diện trắng
    arr[30:160, 40:220, :3] = (30, 120, 250)
    for y, x in ((8, 260), (190, 15), (205, 270), (175, 245)):
        arr[y:y + 7, x:x + 7, :3] = 0
    rng = np.random.default_rng(20260731)
    noise_y = rng.integers(0, arr.shape[0], size=300)
    noise_x = rng.integers(0, arr.shape[1], size=300)
    arr[noise_y, noise_x, :3] = 0

    assert _find_nonwhite_content_bbox(arr, 9) == _previous_nonwhite_bbox(arr, 9)


@pytest.mark.parametrize("shape", [(60, 80, 1), (60, 80, 3), (60, 80, 4)])
def test_fast_nonwhite_bbox_keeps_blank_page_unchanged(shape):
    arr = np.full(shape, 255, dtype=np.uint8)
    if shape[2] == 4:
        arr[:, :, 3] = 0
    assert _find_nonwhite_content_bbox(arr, 4) is None


def test_edge_background_bbox_trims_flat_colored_border():
    """Viền dư màu phẳng được nhận từ chu vi, không phụ thuộc màu trắng."""
    arr = np.full((120, 160, 3), (32, 78, 145), dtype=np.uint8)
    arr[20:100, 30:130, :3] = (238, 225, 40)

    detection = _find_edge_background_content_bbox(arr, 9)
    assert detection is not None
    assert detection[0] == (30, 20, 129, 99)
    # Morphology-open chỉ bỏ bốn pixel góc, không được làm đổi bbox.
    assert 7_990 <= detection[1] <= 8_000


def _make_partial_edge_border_image(sides: set[str]) -> np.ndarray:
    """Tạo nội dung chạm các cạnh còn lại để xác nhận chỉ cạnh dư bị co."""
    height, width = 120, 160
    yy, xx = np.mgrid[:height, :width]
    checker = (xx + yy) % 2 == 0
    arr = np.empty((height, width, 3), dtype=np.uint8)
    arr[checker] = (24, 24, 24)
    arr[~checker] = (232, 232, 232)

    if "left" in sides:
        arr[:, :12, :3] = (32, 78, 145)
    if "top" in sides:
        arr[:8, :, :3] = (180, 40, 70)
    if "right" in sides:
        arr[:, -15:, :3] = (60, 160, 80)
    if "bottom" in sides:
        arr[-10:, :, :3] = (210, 130, 20)
    return arr


@pytest.mark.parametrize(
    ("sides", "expected_bbox"),
    [
        ({"left"}, (12, 0, 159, 119)),
        ({"top"}, (0, 8, 159, 119)),
        ({"right"}, (0, 0, 144, 119)),
        ({"bottom"}, (0, 0, 159, 109)),
        ({"left", "top"}, (12, 8, 159, 119)),
        ({"left", "right"}, (12, 0, 144, 119)),
        ({"left", "top", "bottom"}, (12, 8, 159, 109)),
        ({"left", "top", "right", "bottom"}, (12, 8, 144, 109)),
    ],
)
def test_edge_background_bbox_trims_only_detected_sides(sides, expected_bbox):
    """Viền dư ở 1–4 cạnh chỉ được co đúng các cạnh có dải màu phẳng."""
    arr = _make_partial_edge_border_image(sides)

    detection = _find_edge_background_content_bbox(arr, 9)
    assert detection is not None
    assert detection[0] == expected_bbox


def test_edge_background_bbox_refuses_perpendicular_gradient():
    """Outer-line phẳng không được làm gradient vuông góc bị xén từng dải."""
    height, width = 120, 160
    ramp = np.linspace(20, 220, height).round().astype(np.uint8)
    arr = np.repeat(ramp[:, None, None], width, axis=1)
    arr = np.repeat(arr, 3, axis=2)

    assert _find_edge_background_content_bbox(arr, 9) is None


def test_edge_background_bbox_keeps_side_with_print_mark():
    """Nét in mảnh nhưng đủ dài chạm cạnh phải chặn xén cạnh đó."""
    arr = _make_partial_edge_border_image({"left"})
    arr[60, :20, :3] = (255, 0, 255)

    assert _find_edge_background_content_bbox(arr, 9) is None


def test_edge_background_bbox_ignores_isolated_edge_noise():
    """Một pixel nhiễu không được chặn việc xén dải viền hợp lệ."""
    arr = _make_partial_edge_border_image({"left"})
    arr[60, 0, :3] = (255, 0, 255)

    detection = _find_edge_background_content_bbox(arr, 9)
    assert detection is not None
    assert detection[0] == (12, 0, 159, 119)


def test_edge_background_bbox_trims_one_pixel_colored_border():
    """Mẫu chu vi phải nhận được viền màu rất mỏng, không dùng ratio guard 98%."""
    arr = np.full((200, 200, 3), (18, 92, 160), dtype=np.uint8)
    arr[1:-1, 1:-1, :3] = (240, 210, 35)

    detection = _find_edge_background_content_bbox(arr, 9)
    assert detection is not None
    assert detection[0] == (1, 1, 198, 198)


def test_edge_background_bbox_tolerates_compression_noise():
    """Nhiễu màu nhẹ ở viền không được kéo bbox trở lại toàn trang."""
    rng = np.random.default_rng(20260825)
    base = np.full((120, 160, 3), (208, 222, 235), dtype=np.int16)
    noise = rng.integers(-5, 6, size=base.shape, dtype=np.int16)
    arr = np.clip(base + noise, 0, 255).astype(np.uint8)
    arr[20:100, 30:130, :3] = (24, 38, 52)

    detection = _find_edge_background_content_bbox(arr, 9)
    assert detection is not None
    assert detection[0] == (30, 20, 129, 99)


def test_edge_background_bbox_refuses_ambiguous_gradient():
    """Viền biến thiên không rõ ràng phải giữ nguyên thay vì đoán rồi xén sai."""
    height, width = 120, 160
    yy, xx = np.mgrid[:height, :width]
    arr = np.zeros((height, width, 3), dtype=np.uint8)
    arr[:, :, 0] = (xx * 180 // (width - 1)).astype(np.uint8)
    arr[:, :, 1] = (yy * 180 // (height - 1)).astype(np.uint8)
    arr[:, :, 2] = 70
    arr[20:100, 30:130, :3] = (240, 30, 30)

    assert _find_edge_background_content_bbox(arr, 9) is None


def test_auto_trim_fast_path_preserves_geometry_for_all_rotations(tmp_path):
    """Đường bitmap→NumPy nhanh vẫn xén đúng cùng nội dung ở bốn góc xoay."""
    pytest.importorskip("pypdfium2")
    source = tmp_path / "auto_trim_rotations.pdf"
    pdf = pikepdf.Pdf.new()
    for rotate in (0, 90, 180, 270):
        pdf.add_blank_page(page_size=(200.0, 100.0))
        page = pdf.pages[-1]
        page.obj[pikepdf.Name("/Contents")] = pikepdf.Stream(
            pdf,
            b"0 0 0 rg 40 10 120 80 re f\n",
        )
        page.obj[pikepdf.Name("/Rotate")] = rotate
    pdf.save(source)
    pdf.close()

    engine = PageBoxesEngine()
    engine.output_dir = tmp_path
    output = engine.auto_trim(str(source))
    with pikepdf.Pdf.open(output) as result:
        assert len(result.pages) == 4
        for page, rotate in zip(result.pages, (0, 90, 180, 270)):
            media_box = [float(value) for value in page.obj["/MediaBox"]]
            assert media_box == pytest.approx([40.0, 10.0, 160.0, 90.0], abs=0.5)
            assert int(page.get("/Rotate", 0) or 0) == rotate


def test_auto_trim_colored_border_preserves_geometry_for_all_rotations(tmp_path):
    """PDF thật có viền xanh phải xén đúng nội dung ở cả bốn góc /Rotate."""
    pytest.importorskip("pypdfium2")
    source = tmp_path / "auto_trim_colored_rotations.pdf"
    pdf = pikepdf.Pdf.new()
    for rotate in (0, 90, 180, 270):
        pdf.add_blank_page(page_size=(200.0, 100.0))
        page = pdf.pages[-1]
        page.obj[pikepdf.Name("/Contents")] = pikepdf.Stream(
            pdf,
            (
                b"0.13 0.31 0.57 rg 0 0 200 100 re f\n"
                b"0.93 0.88 0.16 rg 40 10 120 80 re f\n"
            ),
        )
        page.obj[pikepdf.Name("/Rotate")] = rotate
    pdf.save(source)
    pdf.close()

    engine = PageBoxesEngine()
    engine.output_dir = tmp_path
    output = engine.auto_trim(str(source))

    with pikepdf.Pdf.open(output) as result:
        assert len(result.pages) == 4
        for page, rotate in zip(result.pages, (0, 90, 180, 270)):
            media_box = [float(value) for value in page.obj["/MediaBox"]]
            assert media_box == pytest.approx([40.0, 10.0, 160.0, 90.0], abs=0.5)
            assert int(page.get("/Rotate", 0) or 0) == rotate


def test_auto_trim_partial_colored_border_preserves_other_sides_for_all_rotations(tmp_path):
    """Một dải màu bên trái chỉ được co cạnh tương ứng qua mọi /Rotate."""
    pytest.importorskip("pypdfium2")
    source = tmp_path / "auto_trim_partial_colored_rotations.pdf"
    pdf = pikepdf.Pdf.new()
    checker_commands: list[bytes] = []
    for row in range(10):
        for col in range(20):
            shade = b"0.08 0.08 0.08" if (row + col) % 2 == 0 else b"0.92 0.92 0.92"
            checker_commands.append(
                shade
                + f" rg {col * 10} {row * 10} 10 10 re f".encode("ascii")
            )
    checker_commands.append(b"0.13 0.31 0.57 rg 0 0 17 100 re f")
    stream = b"\n".join(checker_commands) + b"\n"

    for rotate in (0, 90, 180, 270):
        pdf.add_blank_page(page_size=(200.0, 100.0))
        page = pdf.pages[-1]
        page.obj[pikepdf.Name("/Contents")] = pikepdf.Stream(pdf, stream)
        page.obj[pikepdf.Name("/Rotate")] = rotate
    pdf.save(source)
    pdf.close()

    engine = PageBoxesEngine()
    engine.output_dir = tmp_path
    output = engine.auto_trim(str(source))

    with pikepdf.Pdf.open(output) as result:
        assert len(result.pages) == 4
        for page, rotate in zip(result.pages, (0, 90, 180, 270)):
            media_box = [float(value) for value in page.obj["/MediaBox"]]
            assert media_box == pytest.approx([17.0, 0.0, 200.0, 100.0], abs=0.75)
            assert int(page.get("/Rotate", 0) or 0) == rotate


def test_auto_trim_user_unit_keeps_physical_dpi_margin_and_box(tmp_path):
    """PB6: `/UserUnit` không được làm đổi DPI dò mép hoặc nhân đôi margin vật lý."""
    pytest.importorskip("pypdfium2")
    source = tmp_path / "auto-trim-user-unit.pdf"
    pdf = pikepdf.Pdf.new()
    for user_unit in (1.0, 2.0):
        page = pdf.add_blank_page(page_size=(200.0 / user_unit, 100.0 / user_unit))
        page.obj[pikepdf.Name("/Contents")] = pikepdf.Stream(
            pdf,
            (
                "0 0 0 rg "
                f"{40 / user_unit:g} {10 / user_unit:g} "
                f"{120 / user_unit:g} {80 / user_unit:g} re f\n"
            ).encode("ascii"),
        )
        page.obj[pikepdf.Name("/Rotate")] = 90
        if user_unit != 1.0:
            page.obj[pikepdf.Name("/UserUnit")] = user_unit
    pdf.save(source)
    pdf.close()

    engine = PageBoxesEngine()
    engine.output_dir = tmp_path
    output = engine.auto_trim(str(source), margin_mm=3.0)

    physical_boxes = []
    with pikepdf.Pdf.open(output) as result:
        for page in result.pages:
            unit = float(page.get("/UserUnit", 1) or 1)
            physical_boxes.append([
                float(value) * unit for value in page.obj["/MediaBox"]
            ])

    margin_pt = 3.0 * PT_PER_MM
    expected = [40.0 - margin_pt, 10.0 - margin_pt, 160.0 + margin_pt, 90.0 + margin_pt]
    assert physical_boxes[0] == pytest.approx(expected, abs=0.8)
    assert physical_boxes[1] == pytest.approx(expected, abs=0.8)
