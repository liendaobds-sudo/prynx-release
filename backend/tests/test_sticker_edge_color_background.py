"""Nguồn màu bù xén (bleed) trên nền KHÔNG trắng.

QUALITY (audit 2026-08-06 §BG.4). Viền răng cưa (AA) quanh tem bị trộn với NỀN;
nền không nhất thiết là trắng. Nếu chỉ loại pixel gần trắng thì trên nền kem/xanh
những pixel pha nền vẫn lọt vào nguồn màu viền → màu nền bị kéo ra vùng bù xén
thành quầng, thợ bế xong thấy mép tem ám màu.

Kiểm ở mức hàm thuần (mask + ảnh numpy), không PDF, không PDFium.
"""
import numpy as np

from app.workers.sticker_engine import (
    _build_edge_color_source_mask,
    _near_background_mask_rgb,
)

_NEN = (242, 233, 220)   # kem — nền tem do AI sinh
_RUOT = (30, 60, 200)    # xanh — ruột tem
_AA = (140, 150, 210)    # pixel mép pha nửa nền nửa ruột


def _tem_tren_nen_kem(canh_aa: int = 3):
    """Ảnh nền kem + tem vuông xanh, quanh tem có vành AA dày ``canh_aa`` px.

    Trả ``(img, silhouette)`` — silhouette bao GỒM cả vành AA, đúng như mask do
    bộ dò nền trả về (nền bị loại, phần còn lại tính là hình).
    """
    h = w = 120
    img = np.full((h, w, 3), _NEN, dtype=np.uint8)
    y0, y1, x0, x1 = 30, 90, 30, 90
    img[y0:y1, x0:x1] = _AA
    img[y0 + canh_aa: y1 - canh_aa, x0 + canh_aa: x1 - canh_aa] = _RUOT

    silhouette = np.zeros((h, w), dtype=np.uint8)
    silhouette[y0:y1, x0:x1] = 255
    return img, silhouette


def test_khong_truyen_mau_nen_thi_pixel_pha_nen_van_lot_vao():
    """Hành vi CŨ: chỉ lọc near-white → pixel pha kem vẫn được lấy làm màu bleed."""
    img, silhouette = _tem_tren_nen_kem()
    mask = _build_edge_color_source_mask(
        silhouette, img, band_px=2, peel_px=0, exclude_near_white=True
    )
    lay = img[mask > 0]
    assert lay.size > 0
    la_aa = np.all(np.abs(lay.astype(int) - np.array(_AA)) <= 6, axis=1)
    assert la_aa.any(), "ca đối chứng phải có pixel AA lọt vào thì test sau mới có nghĩa"


def test_truyen_mau_nen_thi_loai_het_pixel_pha_nen():
    """§BG.4: truyền màu nền đã dò → nguồn màu viền chỉ còn màu RUỘT tem."""
    img, silhouette = _tem_tren_nen_kem()
    mask = _build_edge_color_source_mask(
        silhouette,
        img,
        band_px=2,
        peel_px=0,
        exclude_near_white=True,
        background_rgb=_NEN,
        background_tolerance=90,  # đủ rộng để phủ cả pixel pha nửa nền
    )
    lay = img[mask > 0]
    assert lay.size > 0, "loại pha nền không được làm rỗng nguồn màu"
    gan_nen = np.max(np.abs(lay.astype(int) - np.array(_NEN)), axis=1) <= 90
    assert not gan_nen.any(), "vẫn còn pixel pha màu nền trong nguồn màu bleed"


def test_loai_pha_nen_khong_duoc_lam_rong_nguon_mau():
    """Dung sai quá rộng nuốt cả tem → phải rơi về dải viền gốc, không trả rỗng.

    Rỗng nghĩa là vùng bù xén không có màu để kéo — tệ hơn hẳn màu hơi nhạt.
    """
    img, silhouette = _tem_tren_nen_kem()
    mask = _build_edge_color_source_mask(
        silhouette,
        img,
        band_px=2,
        peel_px=0,
        exclude_near_white=True,
        background_rgb=_NEN,
        background_tolerance=255,
    )
    assert np.count_nonzero(mask) > 0


def test_near_background_mask_bien_dau_vao():
    img, _ = _tem_tren_nen_kem()
    assert not _near_background_mask_rgb(img, None, 10).any()
    assert _near_background_mask_rgb(img, _NEN, 4).any()
    assert not _near_background_mask_rgb(img, (0, 0, 0), 2).any()
