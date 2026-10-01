"""Kiểm thử tính năng tự động khử bóng đen mảnh / viền lem tối ở rìa kênh Alpha (PNG).

QUALITY (feedback 2026-10-01 §PNG.SHADOW-CLEAN):
1. Khử dải bóng tối bán trong suốt quanh mép tem sáng hoặc màu.
2. Giữ Alpha bên trong, viền đen đặc, khử răng cưa trắng/màu và RGB đầu vào.
3. Kiểm tra ngân sách 60ms trên fixture 2000x2000.
"""

import time
import cv2
import numpy as np
from PIL import Image
import pytest

from app.workers.sticker_shadow_boundary import clean_alpha_dark_shadow_fringe
from app.workers.sticker_source_pipeline import _analysis_from_alpha


def test_clean_alpha_dark_shadow_white_border():
    """Tem viền trắng có dải bóng mờ đen 2px ở rìa: bóng phải bị bóc sạch."""
    h, w = 120, 120
    # Ruột tem trắng (Luma = 255)
    rgb = np.full((h, w, 3), 255, dtype=np.uint8)
    alpha = np.zeros((h, w), dtype=np.uint8)
    # Tem trắng 60x60 tại [30:90, 30:90]
    alpha[30:90, 30:90] = 255

    # Thêm dải bóng đen 2px ở rìa ngoài: [28:92, 28:92]
    for y in range(28, 92):
        for x in range(28, 92):
            if not (30 <= y < 90 and 30 <= x < 90):
                alpha[y, x] = 120
                rgb[y, x] = [35, 35, 35] # bóng xám đen

    cleaned, removed = clean_alpha_dark_shadow_fringe(rgb, alpha)
    assert removed > 0, "Phải nhận diện và khử được bóng đen ở rìa tem"
    # Ruột tem trắng 60x60 phải giữ nguyên 100%
    assert np.all(cleaned[30:90, 30:90] == 255), "Thân tem viền trắng không được bị suy suyển"
    # Vùng bóng đen [28:30] phải bị xóa về 0
    assert np.all(cleaned[28:30, :] == 0), "Vệt bóng đen phía trên phải bị xóa sạch"
    assert np.all(cleaned[90:92, :] == 0), "Vệt bóng đen phía dưới phải bị xóa sạch"


def test_clean_alpha_dark_shadow_colored_border():
    """Tem viền màu sắc (Cam rực) có bóng đổ xám: bóng bị bóc, màu cam giữ nguyên."""
    h, w = 120, 120
    rgb = np.zeros((h, w, 3), dtype=np.uint8)
    # Tem màu cam rực rỡ (Luma ~ 130, Chroma = 255)
    rgb[30:90, 30:90] = [255, 100, 0]
    alpha = np.zeros((h, w), dtype=np.uint8)
    alpha[30:90, 30:90] = 255

    # Thêm viền bóng mờ xám tối 2px
    for y in range(28, 92):
        for x in range(28, 92):
            if not (30 <= y < 90 and 30 <= x < 90):
                alpha[y, x] = 110
                rgb[y, x] = [40, 40, 40]

    cleaned, removed = clean_alpha_dark_shadow_fringe(rgb, alpha)
    assert removed > 0, "Phải khử được bóng đen bên ngoài tem màu"
    assert np.all(cleaned[30:90, 30:90] == 255), "Tem màu cam phải giữ nguyên vẹn"


def test_clean_alpha_dark_shadow_keeps_enclosed_semitransparent_artwork():
    """Alpha bán trong suốt bên trong lõi tem không phải là bóng ngoài mép."""
    h, w = 120, 120
    rgb = np.full((h, w, 3), 255, dtype=np.uint8)
    alpha = np.zeros((h, w), dtype=np.uint8)
    alpha[30:90, 30:90] = 255

    # Một mảng mực đen bán trong suốt nằm kín trong lõi trắng.
    alpha[54:66, 54:66] = 128
    rgb[54:66, 54:66] = [20, 20, 20]

    # Bóng xám bên ngoài vẫn phải được khử.
    alpha[28:30, 30:90] = 120
    rgb[28:30, 30:90] = [35, 35, 35]

    cleaned, removed = clean_alpha_dark_shadow_fringe(rgb, alpha)
    assert removed > 0
    assert np.all(cleaned[54:66, 54:66] == 128), "Không được xóa artwork alpha 128 nằm trong lõi"
    assert np.all(cleaned[28:30, 30:90] == 0), "Bóng ngoài mép phải bị xóa"


def test_clean_alpha_dark_shadow_keeps_enclosed_dark_solid_artwork():
    """Artwork đen đặc sát viền trong nhưng vẫn nằm trong contour phải được giữ."""
    h, w = 120, 120
    rgb = np.full((h, w, 3), 255, dtype=np.uint8)
    alpha = np.zeros((h, w), dtype=np.uint8)
    alpha[30:90, 30:90] = 255
    alpha[31:35, 48:72] = 255
    rgb[31:35, 48:72] = [0, 0, 0]
    alpha[28:30, 30:90] = 120
    rgb[28:30, 30:90] = [35, 35, 35]

    cleaned, removed = clean_alpha_dark_shadow_fringe(rgb, alpha)
    assert removed > 0
    assert np.all(cleaned[31:35, 48:72] == 255), "Nét đen thật trong tem không được ăn lẹm"


def test_clean_alpha_dark_shadow_solid_black_sticker_protected():
    """Tem màu đen đặc ruột (Black sticker): TUYỆT ĐỐI không bị xóa/ăn lẹm!"""
    h, w = 120, 120
    rgb_black = np.zeros((h, w, 3), dtype=np.uint8) # ruột đen Luma = 0
    alpha_black = np.zeros((h, w), dtype=np.uint8)
    alpha_black[30:90, 30:90] = 255
    # Thêm anti-aliasing tự nhiên 1px
    for y in range(29, 91):
        for x in range(29, 91):
            if not (30 <= y < 90 and 30 <= x < 90):
                alpha_black[y, x] = 128

    cleaned_black, removed = clean_alpha_dark_shadow_fringe(rgb_black, alpha_black)
    assert removed == 0, "Tem màu đen đặc ruột KHÔNG ĐƯỢC bị xóa hoặc ăn mòn biên!"
    assert np.array_equal(cleaned_black, alpha_black), "Kênh alpha của tem đen phải giữ nguyên 100%"


def test_clean_alpha_no_dark_fringe_exits_instantly():
    """Tem sạch hoàn toàn không có bóng: hàm kết thúc ngay không đổi gì."""
    h, w = 100, 100
    rgb = np.full((h, w, 3), 255, dtype=np.uint8)
    alpha = np.zeros((h, w), dtype=np.uint8)
    alpha[20:80, 20:80] = 255

    cleaned, removed = clean_alpha_dark_shadow_fringe(rgb, alpha)
    assert removed == 0
    assert np.array_equal(cleaned, alpha)


def test_analysis_from_alpha_end_to_end():
    """Tích hợp pipeline: _analysis_from_alpha tự động loại bóng đen và gắn warning."""
    h, w = 150, 150
    rgb = np.full((h, w, 3), 255, dtype=np.uint8)
    alpha = np.zeros((h, w), dtype=np.uint8)
    alpha[35:115, 35:115] = 255

    # Viền bóng đen
    for y in range(33, 117):
        for x in range(33, 117):
            if not (35 <= y < 115 and 35 <= x < 115):
                alpha[y, x] = 130
                rgb[y, x] = [30, 30, 30]

    image = Image.fromarray(rgb)
    analysis = _analysis_from_alpha(
        image,
        alpha,
        model="birefnet-lite",
        alpha_threshold=128,
        shadow_cleanup="auto",
    )

    assert "png-dark-shadow-removed" in analysis.warnings
    assert analysis.shadow_exclusion is not None
    assert np.any(analysis.shadow_exclusion > 0)
    # Đường bế / alpha sạch phải không còn bóng đen ở [33:35]
    assert np.all(analysis.alpha[33:35, :] == 0)
    assert np.all(analysis.alpha[35:115, 35:115] == 255)


def test_analysis_from_alpha_shadow_cleanup_off():
    """Khi shadow_cleanup='off': không khử bóng."""
    h, w = 150, 150
    rgb = np.full((h, w, 3), 255, dtype=np.uint8)
    alpha = np.zeros((h, w), dtype=np.uint8)
    alpha[35:115, 35:115] = 255

    for y in range(33, 117):
        for x in range(33, 117):
            if not (35 <= y < 115 and 35 <= x < 115):
                alpha[y, x] = 130
                rgb[y, x] = [30, 30, 30]

    image = Image.fromarray(rgb)
    analysis = _analysis_from_alpha(
        image,
        alpha,
        model="birefnet-lite",
        alpha_threshold=128,
        shadow_cleanup="off",
    )

    assert "png-dark-shadow-removed" not in analysis.warnings
    # Vùng bóng 130 >= 128 vẫn còn nguyên vì đã tắt khử bóng
    assert np.any(analysis.alpha[33:35, :] > 0)


def test_clean_alpha_perf_large_image():
    """Hiệu năng: xử lý ảnh lớn 2000x2000 phải dưới 60ms."""
    h, w = 2000, 2000
    rgb = np.full((h, w, 3), 255, dtype=np.uint8)
    alpha = np.zeros((h, w), dtype=np.uint8)
    alpha[200:1800, 200:1800] = 255
    # Bóng đen 3px quanh tem
    alpha[197:1803, 197:1803] = np.where(alpha[197:1803, 197:1803] == 0, 120, 255)
    rgb[alpha == 120] = [35, 35, 35]

    t0 = time.perf_counter()
    cleaned, removed = clean_alpha_dark_shadow_fringe(rgb, alpha)
    elapsed_ms = (time.perf_counter() - t0) * 1000

    assert removed > 0, "Phải xóa được bóng đen"
    assert elapsed_ms < 60.0, f"Thời gian xử lý quá chậm: {elapsed_ms:.2f}ms >= 60ms"


@pytest.mark.parametrize("border_color", [(255, 255, 255), (255, 100, 0), (0, 0, 0)])
def test_clean_alpha_preserves_true_feather_and_source_rgb(border_color):
    """Khử răng cưa cùng màu viền là artwork; RGB dưới Alpha không bị sửa ngầm."""
    rgb = np.full((120, 120, 3), [132, 29, 18], dtype=np.uint8)
    alpha = np.zeros((120, 120), dtype=np.uint8)
    alpha[28:92, 28:92] = 120
    rgb[28:92, 28:92] = border_color
    alpha[30:90, 30:90] = 255
    original_rgb = rgb.copy()
    original_alpha = alpha.copy()
    cleaned, removed = clean_alpha_dark_shadow_fringe(rgb, alpha)
    assert removed == 0
    assert np.array_equal(cleaned, original_alpha)
    assert np.array_equal(rgb, original_rgb)
    assert np.array_equal(alpha, original_alpha)


def test_clean_alpha_shadow_removal_does_not_mutate_inputs():
    rgb = np.full((120, 120, 3), [132, 29, 18], dtype=np.uint8)
    alpha = np.zeros((120, 120), dtype=np.uint8)
    alpha[28:92, 28:92] = 120
    rgb[28:92, 28:92] = [35, 35, 35]
    alpha[30:90, 30:90] = 255
    rgb[30:90, 30:90] = 255
    original_rgb, original_alpha = rgb.copy(), alpha.copy()
    rgb.flags.writeable = False
    alpha.flags.writeable = False
    cleaned, removed = clean_alpha_dark_shadow_fringe(rgb, alpha)
    assert removed == 64 * 64 - 60 * 60
    assert np.all(cleaned[30:90, 30:90] == 255)
    assert np.array_equal(rgb, original_rgb)
    assert np.array_equal(alpha, original_alpha)


def test_clean_alpha_keeps_black_outline_around_white_art():
    """Viền đen đặc là artwork thật dù ruột tem màu trắng."""
    rgb = np.zeros((120, 120, 3), dtype=np.uint8)
    alpha = np.zeros((120, 120), dtype=np.uint8)
    alpha[28:92, 28:92] = 120
    alpha[30:90, 30:90] = 255
    rgb[34:86, 34:86] = 255
    cleaned, removed = clean_alpha_dark_shadow_fringe(rgb, alpha)
    assert removed == 0
    assert np.array_equal(cleaned, alpha)


def test_clean_alpha_limits_shadow_distance():
    rgb = np.zeros((120, 120, 3), dtype=np.uint8)
    alpha = np.zeros((120, 120), dtype=np.uint8)
    alpha[20:100, 20:100] = 100
    alpha[40:80, 40:80] = 255
    rgb[40:80, 40:80] = 255
    cleaned, removed = clean_alpha_dark_shadow_fringe(rgb, alpha, max_fringe_px=3)
    assert removed > 0
    assert np.all(cleaned[20:30, 20:100] == 100)
    assert np.all(cleaned[40:80, 40:80] == 255)


@pytest.mark.parametrize("border_color", [(255, 255, 255), (255, 100, 0), (0, 0, 0)])
def test_analysis_preserves_real_antialiasing_and_rgb(border_color):
    """Nhãn nhị phân không được cắt mất pixel khử răng cưa ở ngưỡng thấp."""
    rgb = np.full((120, 120, 3), [132, 29, 18], dtype=np.uint8)
    alpha = np.zeros((120, 120), dtype=np.uint8)
    alpha[29:91, 29:91] = 80
    rgb[29:91, 29:91] = border_color
    alpha[30:90, 30:90] = 255
    original_rgb = rgb.copy()
    analysis = _analysis_from_alpha(Image.fromarray(rgb), alpha, model="birefnet-lite", alpha_threshold=128)
    assert np.array_equal(analysis.alpha, alpha)
    assert np.array_equal(analysis.rgba[:, :, :3], original_rgb)
    assert np.any((analysis.alpha > 0) & (analysis.labels == 0))
    assert "png-dark-shadow-removed" not in analysis.warnings


def test_analysis_removes_shadow_and_preserves_antialiasing_in_same_image():
    rgb = np.full((120, 120, 3), 255, dtype=np.uint8)
    alpha = np.zeros((120, 120), dtype=np.uint8)
    alpha[29:91, 29:91] = 80
    alpha[30:90, 30:90] = 255
    alpha[91:93, 30:90] = 70
    rgb[91:93, 30:90] = 35
    alpha[50:60, 50:60] = 100
    rgb[50:60, 50:60] = 0
    analysis = _analysis_from_alpha(Image.fromarray(rgb), alpha, model="birefnet-lite", alpha_threshold=128)
    assert np.all(analysis.alpha[91:93, 30:90] == 0)
    assert np.all(analysis.alpha[29, 30:90] == 80)
    assert np.all(analysis.alpha[50:60, 50:60] == 100)
    assert np.all(analysis.shadow_exclusion[50:60, 50:60] == 0)
    assert np.all(analysis.rgba[:, :, :3] == rgb)

