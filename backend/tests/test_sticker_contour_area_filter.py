"""Lọc contour vụn theo diện tích mm² — QUALITY (audit 2026-08-07 §BG.6).

Nhiễu nén JPEG quanh ngưỡng nền làm vài cụm điểm ảnh nền rớt lại thành contour
riêng → đường cắt có vòng nhỏ và chấm rời rạc bám dọc biên tem. Ngưỡng
``_MIN_CONTOUR_AREA_MM2`` tách nhóm vụn khỏi tem thật mà KHÔNG chạm điểm ảnh nào
của hình.

Kiểm ở mức hàm thuần (numpy + skimage + shapely), không PDF, không PDFium.
"""
import cv2
import numpy as np
from shapely.geometry import Polygon
from skimage import measure

from app.workers.sticker_engine import _MIN_CONTOUR_AREA_MM2, _PT_PER_MM

_DPI = 300.0


def _anh_tem(canh_mm: float, chat_luong_jpeg: int = 60):
    """Tem tròn xanh trên nền trắng, nén JPEG để sinh nhiễu quanh ngưỡng nền."""
    canh_pt = canh_mm * _PT_PER_MM
    scale = _DPI / 72.0
    px = int(round(canh_pt * scale))
    img = np.full((px, px, 3), 255, np.uint8)
    cv2.circle(img, (px // 2, px // 2), int(px * 0.45), (30, 60, 200), -1,
               lineType=cv2.LINE_AA)
    ma = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, chat_luong_jpeg])[1]
    return cv2.imdecode(ma, 1), scale


def _dien_tich_contour_mm2(img: np.ndarray, scale: float) -> list:
    """Diện tích (mm²) mọi contour, đúng đường mà engine đi ở nhánh nền trắng."""
    nen = (img.min(axis=2) >= 248).astype(np.uint8) * 255
    so, nhan = cv2.connectedComponents(nen)
    vien = set(nhan[0, :]) | set(nhan[-1, :]) | set(nhan[:, 0]) | set(nhan[:, -1])
    vien.discard(0)
    mask = cv2.bitwise_not(np.isin(nhan, list(vien)).astype(np.uint8) * 255)
    aa = cv2.GaussianBlur(mask, (7, 7), 0)  # corner_style="round"
    ra = []
    for c in measure.find_contours(np.pad(aa, 1, constant_values=0), 127.5):
        diem = (c - 1)[:, [1, 0]] / scale  # sang point, như poly_scale trong engine
        if len(diem) >= 3:
            poly = Polygon(diem)
            if poly.is_valid:
                ra.append(poly.area / (_PT_PER_MM ** 2))
    return ra


def test_co_contour_vun_that_thi_test_sau_moi_co_nghia():
    """Đối chứng: ảnh nén JPEG phải sinh ra contour vụn, nếu không test vô nghĩa."""
    img, scale = _anh_tem(200.0)
    dt = _dien_tich_contour_mm2(img, scale)
    assert len(dt) > 5, f"chỉ thấy {len(dt)} contour — nhiễu chưa sinh ra"


def test_nguong_tach_sach_vun_khoi_tem_that():
    """Sau lọc, mỗi cỡ tem chỉ còn ĐÚNG một contour — chính con tem."""
    for canh_mm in (20.0, 50.0, 200.0):
        dt = _dien_tich_contour_mm2(*_anh_tem(canh_mm))
        giu = [a for a in dt if a >= _MIN_CONTOUR_AREA_MM2]
        assert len(giu) == 1, f"tem {canh_mm}mm còn {len(giu)} contour sau lọc"


def test_lo_treo_that_khong_bi_loc_mat():
    """Đối chứng âm: lỗ treo r=1 mm (≈3,14 mm²) phải sống sót qua bộ lọc.

    Dựng mask trực tiếp (đường alpha / dò nền theo màu) chứ KHÔNG qua nhánh nền
    trắng: ở nhánh đó lỗ trắng bên trong bị bước lọc "thành phần chạm biên" loại
    từ trước, không liên quan bộ lọc diện tích — đã đo và xác nhận.
    """
    scale = _DPI / 72.0
    ppm = scale * 72.0 / 25.4
    px = int(round(100.0 * _PT_PER_MM * scale))
    mask = np.zeros((px, px), np.uint8)
    cv2.circle(mask, (px // 2, px // 2), int(px * 0.45), 255, -1, lineType=cv2.LINE_AA)
    cv2.circle(mask, (px // 2, int(px * 0.25)), int(round(1.0 * ppm)), 0, -1,
               lineType=cv2.LINE_AA)
    dien_tich = []
    for c in measure.find_contours(np.pad(mask, 1, constant_values=0), 127.5):
        diem = (c - 1)[:, [1, 0]] / scale
        if len(diem) >= 3:
            poly = Polygon(diem)
            if poly.is_valid:
                dien_tich.append(poly.area / (_PT_PER_MM ** 2))
    giu = sorted((a for a in dien_tich if a >= _MIN_CONTOUR_AREA_MM2), reverse=True)
    assert len(giu) == 2, f"kỳ vọng tem + lỗ treo, thấy {len(giu)}: {giu[:5]}"
    assert 1.5 < giu[1] < 6.0, f"diện tích lỗ treo bất thường: {giu[1]}"


def test_nguong_nho_hon_moi_tem_that_trong_nghe():
    """1 mm² phải nhỏ hơn con tem nhỏ nhất thực tế (tem tròn 20 mm ≈ 265 mm²)."""
    dt = _dien_tich_contour_mm2(*_anh_tem(20.0))
    assert max(dt) > 100 * _MIN_CONTOUR_AREA_MM2
