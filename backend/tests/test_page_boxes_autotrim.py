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
