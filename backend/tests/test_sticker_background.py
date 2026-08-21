"""Unit test cho bộ dò nền tem/nhãn.

QUALITY (audit 2026-08-06 §BG.2). Kiểm ở mức hàm thuần — không PDF, không PDFium
— để khi nhánh nền trong engine đổi thì vẫn có chỗ khoá đúng luật dò nền.
"""
import numpy as np

from app.core.sticker_background import (
    BG_FOREGROUND_RATIO_MAX,
    BG_FOREGROUND_RATIO_MIN,
    detect_background,
    foreground_ratio,
    mask_tach_duoc_nen,
)
import app.core.sticker_background as sticker_background_module


def _anh_nen_phang(mau, kich_thuoc=(120, 160)) -> np.ndarray:
    """Ảnh nền phẳng `mau` với một hình chữ nhật đỏ ở giữa."""
    h, w = kich_thuoc
    img = np.full((h, w, 3), mau, dtype=np.uint8)
    img[h // 4: 3 * h // 4, w // 4: 3 * w // 4] = (200, 30, 30)
    return img


def _anh_gradient(kich_thuoc=(200, 300)) -> np.ndarray:
    """Nền gradient chéo: bốn góc bốn màu khác nhau rõ rệt, không góc nào đồng màu."""
    h, w = kich_thuoc
    yy, xx = np.mgrid[:h, :w]
    img = np.zeros((h, w, 3), dtype=np.uint8)
    img[:, :, 0] = (xx * 255 // (w - 1)).astype(np.uint8)
    img[:, :, 1] = (yy * 255 // (h - 1)).astype(np.uint8)
    img[:, :, 2] = 90
    return img


def test_nen_trang_tinh_duoc_nhan_la_gan_trang():
    info = detect_background(_anh_nen_phang((255, 255, 255)))
    assert info is not None
    assert info.is_near_white is True
    assert min(info.color) >= 250
    # Hình chiếm đúng 1/4 diện tích (nửa cạnh mỗi chiều).
    assert 0.20 < foreground_ratio(info.foreground_mask) < 0.30


def test_nen_trang_nga_do_nen_jpeg_van_dò_được():
    """246/244/245 trượt ngưỡng 248 của nhánh trắng cũ nhưng vẫn là nền phẳng."""
    info = detect_background(_anh_nen_phang((246, 244, 245)))
    assert info is not None
    assert info.is_near_white is True


def test_nen_mau_phang_do_duoc_dung_mau():
    info = detect_background(_anh_nen_phang((242, 233, 220)))
    assert info is not None
    assert info.is_near_white is False
    assert all(abs(a - b) <= 2 for a, b in zip(info.color, (242, 233, 220)))
    assert info.confidence > 0.9


def test_so_nen_phang_khong_nang_toan_anh_len_float64(monkeypatch):
    """So màu nền không được tạo mảng float64 cỡ nguyên ảnh."""
    image = _anh_nen_phang((254, 254, 254)).astype(np.uint8)
    original_abs = np.abs

    def guarded_abs(values, *args, **kwargs):
        array = np.asarray(values)
        if array.shape[:2] == image.shape[:2] and array.dtype == np.float64:
            raise AssertionError("đã cấp phát mảng float64 cỡ nguyên ảnh")
        return original_abs(values, *args, **kwargs)

    monkeypatch.setattr(sticker_background_module.np, "abs", guarded_abs)
    info = detect_background(image)

    assert info is not None
    assert info.foreground_mask.dtype == np.uint8
    assert 0.20 < foreground_ratio(info.foreground_mask) < 0.30


def test_nen_gradient_khong_co_hinh_tra_none():
    """Nền gradient nhưng KHÔNG có tem → loang phủ hết → mask rỗng → None.

    Không được trả một mask "đầy" khiến lớp trên cắt trọn khổ tờ.
    """
    assert detect_background(_anh_gradient()) is None


def test_nen_gradient_co_tem_tach_duoc_bang_nhanh_loang():
    """QUALITY (audit 2026-08-06 §BG.3): nhánh nền phẳng bó tay, nhánh loang gánh.

    Gradient biến thiên chậm nên nước loang men khắp nền; mép tem là bậc nhảy
    màu nên nước khựng lại. Kết quả phải là ``is_flat=False`` (phỏng đoán, lớp
    trên sẽ cảnh báo nặng) và mask ôm đúng con tem 1/4 diện tích.
    """
    img = _anh_gradient()
    h, w = img.shape[:2]
    img[h // 4: 3 * h // 4, w // 4: 3 * w // 4] = (10, 200, 40)

    info = detect_background(img)
    assert info is not None, "nền gradient có tem phải tách được bằng nhánh loang"
    assert info.is_flat is False
    assert info.confidence < 0.5, "nhánh phỏng đoán phải có độ tin cậy thấp"
    assert 0.20 < foreground_ratio(info.foreground_mask) < 0.30


def test_anh_toan_mot_mau_tra_none():
    """Không có hình nào → mask rỗng → None, không được trả 'cắt cả trang'."""
    assert detect_background(np.full((100, 100, 3), 255, dtype=np.uint8)) is None


def test_anh_qua_nho_va_sai_dinh_dang_tra_none():
    assert detect_background(np.zeros((2, 2, 3), dtype=np.uint8)) is None
    assert detect_background(np.zeros((50, 50), dtype=np.uint8)) is None
    assert detect_background(None) is None


def test_nguong_mask_tach_duoc_nen():
    assert foreground_ratio(None) == 0.0
    trong = np.zeros((100, 100), dtype=np.uint8)
    day = np.full((100, 100), 255, dtype=np.uint8)
    assert not mask_tach_duoc_nen(trong)
    assert not mask_tach_duoc_nen(day)
    vua = np.zeros((100, 100), dtype=np.uint8)
    vua[:50, :] = 255
    assert mask_tach_duoc_nen(vua)
    assert BG_FOREGROUND_RATIO_MIN < 0.5 < BG_FOREGROUND_RATIO_MAX
