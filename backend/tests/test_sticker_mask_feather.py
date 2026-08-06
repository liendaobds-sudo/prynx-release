"""Mask TỰ DỰNG phải có dải chuyển tiếp trước khi vào marching-squares.

QUALITY (audit 2026-08-07 §BG.5). `detect_background` trả mask NHỊ PHÂN thuần
0/255. `measure.find_contours` nội suy vị trí cắt bên trong dải chuyển tiếp để
lấy toạ độ dưới mức điểm ảnh; không có dải thì mọi điểm rơi đúng giữa cạnh điểm
ảnh → đường cắt bậc thang, tem càng lớn càng lộ.

Kiểm ở mức hàm thuần (numpy + skimage), không PDF, không PDFium.
"""
import cv2
import numpy as np
from skimage import measure

from app.core.sticker_background import detect_background
from app.workers.sticker_engine import (
    _BG_MASK_FEATHER_KERNEL_MAX,
    _BG_MASK_FEATHER_KERNEL_MIN,
    _feather_mask_tu_dung,
)

_NEN = (242, 233, 220)  # nền kem — tem do AI sinh


def _tem_tron(r: int = 240) -> np.ndarray:
    """Ảnh nền kem, tem tròn bán kính ``r`` — chu vi dài để lộ răng cưa."""
    h = w = 2 * r + 120
    img = np.full((h, w, 3), _NEN, dtype=np.uint8)
    cv2.circle(img, (w // 2, h // 2), r, (30, 60, 200), -1, lineType=cv2.LINE_AA)
    return img


def _goc_be_lon(mask: np.ndarray, nguong_do: float = 30.0) -> int:
    """Đếm số góc bẻ vượt ``nguong_do`` trên biên dài nhất của mask."""
    duong = measure.find_contours(np.pad(mask, 1, constant_values=0), 127.5)
    lon_nhat = max(duong, key=len)
    buoc = np.diff(lon_nhat, axis=0)
    goc = np.abs(np.diff(np.unwrap(np.arctan2(buoc[:, 0], buoc[:, 1]))))
    return int((goc > np.radians(nguong_do)).sum())


def test_mask_nhi_phan_chua_bu_thi_bien_bac_thang():
    """Ca đối chứng: không bù thì phải thấy răng cưa, test sau mới có nghĩa."""
    info = detect_background(_tem_tron())
    assert info is not None
    assert _goc_be_lon(info.foreground_mask) > 100


def test_feather_xoa_het_goc_be_bac_thang():
    """§BG.5: sau khi bù dải chuyển tiếp, không còn góc bẻ > 30°."""
    info = detect_background(_tem_tron())
    px_per_mm = 2.0 * 72.0 / 25.4  # scale=2.0, đúng công thức trong engine
    assert _goc_be_lon(_feather_mask_tu_dung(info.foreground_mask, px_per_mm)) == 0


def test_feather_khong_lam_xe_dich_hinh():
    """Bù dải chuyển tiếp KHÔNG được ăn mòn hay phình hình quá 0,1% diện tích.

    Đây là ranh giới giữa "trả lại dải AA" và "bo tròn góc" — cái sau là sửa
    thiết kế của khách, tuyệt đối không được làm.
    """
    info = detect_background(_tem_tron())
    goc = info.foreground_mask
    bu = _feather_mask_tu_dung(goc, 2.0 * 72.0 / 25.4)
    _, nhi_phan = cv2.threshold(bu, 127, 255, cv2.THRESH_BINARY)
    lech = abs(np.count_nonzero(nhi_phan) - np.count_nonzero(goc))
    assert lech / np.count_nonzero(goc) < 0.001


def test_be_rong_bu_theo_mm_khong_theo_diem_anh():
    """Cùng con tem quét ở hai scale phải ra cùng chất lượng biên.

    Nếu bù theo số điểm ảnh cố định thì scale cao sẽ thiếu dải và răng cưa
    quay lại.
    """
    for scale, r in ((2.0, 240), (4.0, 480)):
        info = detect_background(_tem_tron(r))
        assert info is not None
        bu = _feather_mask_tu_dung(info.foreground_mask, scale * 72.0 / 25.4)
        assert _goc_be_lon(bu) == 0, f"scale={scale} vẫn còn góc bẻ"


def test_feather_bien_dau_vao():
    mask = detect_background(_tem_tron(60)).foreground_mask
    assert _feather_mask_tu_dung(mask, 0) is mask, "px_per_mm không hợp lệ → trả nguyên"
    assert _feather_mask_tu_dung(None, 5.7) is None
    trong = np.zeros((0, 0), dtype=np.uint8)
    assert _feather_mask_tu_dung(trong, 5.7) is trong
    # Kernel luôn lẻ và nằm trong khoảng kẹp, kể cả scale cực đoan.
    assert _BG_MASK_FEATHER_KERNEL_MIN % 2 == 1
    assert _BG_MASK_FEATHER_KERNEL_MAX % 2 == 1
    for px_per_mm in (0.01, 5.7, 500.0):
        assert _feather_mask_tu_dung(mask, px_per_mm).shape == mask.shape
