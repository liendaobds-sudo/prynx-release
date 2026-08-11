"""Nguồn màu bù xén (bleed) trên nền KHÔNG trắng.

QUALITY (audit 2026-08-06 §BG.4). Viền răng cưa (AA) quanh tem bị trộn với NỀN;
nền không nhất thiết là trắng. Nếu chỉ loại pixel gần trắng thì trên nền kem/xanh
những pixel pha nền vẫn lọt vào nguồn màu viền → màu nền bị kéo ra vùng bù xén
thành quầng, thợ bế xong thấy mép tem ám màu.

Kiểm ở mức hàm thuần (mask + ảnh numpy), không PDF, không PDFium.
"""
import numpy as np
import pytest

from app.workers.sticker_engine import (
    _build_adaptive_edge_color_source_mask,
    _build_bleed_color_work_band,
    _build_edge_color_source_mask,
    _edge_color_adaptive_max_mm,
    _near_background_mask_rgb,
    _near_white_mask_rgb,
    _sampled_bleed_overlap_px,
    _strip_edge_color_shell_pixels,
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


def test_loc_mau_tren_shell_giong_het_mask_toan_anh():
    """Fast-path chỉ đọc shell nhưng phải giữ đúng từng pixel của cách quét cũ."""
    rng = np.random.default_rng(20260810)
    image = rng.integers(0, 256, size=(96, 112, 3), dtype=np.uint8)
    shell = np.zeros((96, 112), dtype=np.uint8)
    shell[9:87, 13:99] = 255
    shell[15:81, 19:93] = 0
    image[9:12, 13:99] = (255, 252, 250)
    image[84:87, 13:99] = _NEN

    expected = shell.copy()
    remove = _near_white_mask_rgb(image) | _near_background_mask_rgb(
        image,
        _NEN,
        12,
    )
    expected[remove] = 0
    if np.count_nonzero(expected) == 0:
        expected = shell

    actual = _strip_edge_color_shell_pixels(
        shell,
        image,
        exclude_near_white=True,
        background_rgb=_NEN,
        background_tolerance=12,
    )
    assert np.array_equal(actual, expected)


def test_mien_tinh_mau_chu_nhat_bao_tron_nhung_khong_doi_smask():
    """Miền tính nhanh được phép rộng hơn; alpha bù xén phải giữ nguyên riêng biệt."""
    import cv2

    ring = np.zeros((80, 96), dtype=np.uint8)
    cv2.circle(ring, (48, 40), 24, 255, 2)
    radius = 7
    ellipse = cv2.dilate(
        ring,
        cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE,
            (radius * 2 + 1, radius * 2 + 1),
        ),
    )
    original = ring.copy()
    work_band = _build_bleed_color_work_band(ring, radius)

    assert np.array_equal(ring, original)
    assert np.all(work_band[ellipse > 0] > 0)


def test_anh_72dpi_lui_qua_du_dai_jpeg_hong_trang():
    """Halo đều 7 pixel nguồn không được bị hiểu nhầm là màu viền ổn định."""
    import cv2

    size = 160
    image = np.full((size, size, 3), 255, dtype=np.uint8)
    silhouette = np.zeros((size, size), dtype=np.uint8)
    silhouette[20:140, 20:140] = 255
    image[20:140, 20:140] = (255, 232, 232)
    transition = (170, 120, 120)
    image[26:134, 26:134] = transition
    image[27:133, 27:133] = (120, 20, 20)

    pixel_mm = 25.4 / 72.0
    px_per_mm = 72.0 / 25.4
    max_peel_px = round(_edge_color_adaptive_max_mm(pixel_mm) * px_per_mm)
    source, selected_peel = _build_adaptive_edge_color_source_mask(
        silhouette,
        image,
        band_px=2,
        peel_px=1,
        max_peel_px=max_peel_px,
        kernel_type=cv2.MORPH_RECT,
        background_rgb=(255, 255, 255),
        background_tolerance=1,
    )

    sampled = image[source > 0]
    assert selected_peel == 7
    assert float(np.median(sampled[:, 1])) < 80
    assert not np.any(np.all(sampled == (255, 232, 232), axis=1))
    assert not np.any(np.all(sampled == transition, axis=1))


def test_anh_72dpi_khong_lay_lop_do_pha_trang_truoc_vien_muc():
    """Ca thật: nguồn màu phải là viền đỏ đậm, không phải lớp chuyển tiếp nâu/hồng."""
    import cv2

    size = 160
    image = np.full((size, size, 3), 255, dtype=np.uint8)
    silhouette = np.zeros((size, size), dtype=np.uint8)
    silhouette[20:140, 20:140] = 255
    image[20:140, 20:140] = (255, 232, 232)
    red_white_transition = (130, 76, 74)
    image[26:134, 26:134] = red_white_transition
    dark_red_outline = (60, 0, 0)
    image[27:133, 27:133] = dark_red_outline
    image[31:129, 31:129] = (250, 242, 165)  # ruột vàng sát viền đỏ mảnh

    pixel_mm = 25.4 / 72.0
    px_per_mm = 72.0 / 25.4
    max_peel_px = round(_edge_color_adaptive_max_mm(pixel_mm) * px_per_mm)
    source, selected_peel = _build_adaptive_edge_color_source_mask(
        silhouette,
        image,
        band_px=2,
        peel_px=1,
        max_peel_px=max_peel_px,
        kernel_type=cv2.MORPH_RECT,
        background_rgb=(255, 255, 255),
        background_tolerance=1,
    )

    sampled = image[source > 0]
    assert selected_peel == 7
    assert sampled.size > 0
    assert np.all(sampled == dark_red_outline)
    assert not np.any(np.all(sampled == red_white_transition, axis=1))


def test_chong_mi_mau_khong_duoc_tang_theo_do_sau_lay_mau():
    """Dò sâu 2,5 mm vẫn chỉ phủ mí 0,25 mm lên artwork."""
    px_per_mm = 300.0 / 25.4
    overlap_px = _sampled_bleed_overlap_px(px_per_mm)
    deep_sample_px = round(2.5 * px_per_mm)

    assert overlap_px == 3
    assert overlap_px <= deep_sample_px / 10


def test_vien_sang_co_chu_dich_keo_dai_vao_trong_van_duoc_giu():
    """Dải sáng thật còn tiếp tục qua mọi candidate thì không được ăn vào ruột."""
    import cv2

    size = 160
    image = np.full((size, size, 3), 255, dtype=np.uint8)
    silhouette = np.zeros((size, size), dtype=np.uint8)
    silhouette[20:140, 20:140] = 255
    image[20:140, 20:140] = (255, 232, 232)
    image[34:126, 34:126] = (120, 20, 20)

    initial = _build_edge_color_source_mask(
        silhouette,
        image,
        band_px=2,
        peel_px=1,
        kernel_type=cv2.MORPH_RECT,
        background_rgb=(255, 255, 255),
        background_tolerance=1,
    )
    adaptive, selected_peel = _build_adaptive_edge_color_source_mask(
        silhouette,
        image,
        band_px=2,
        peel_px=1,
        max_peel_px=7,
        kernel_type=cv2.MORPH_RECT,
        background_rgb=(255, 255, 255),
        background_tolerance=1,
    )

    assert selected_peel == 1
    assert np.array_equal(adaptive, initial)


def test_do_sau_adaptive_theo_pixel_nguon_va_co_tran_vat_ly():
    assert _edge_color_adaptive_max_mm(None) == 0.60
    assert _edge_color_adaptive_max_mm(25.4 / 300.0) == 0.60
    assert _edge_color_adaptive_max_mm(25.4 / 72.0) == pytest.approx(
        7.0 * 25.4 / 72.0
    )
    assert _edge_color_adaptive_max_mm(1.0) == 2.50
