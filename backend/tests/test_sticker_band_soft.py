"""Làm mềm dải biên phải giảm gợn sóng — QUALITY (audit 2026-08-07 §BG.6b).

Mask nhị phân không cho marching-squares nội suy dưới mức điểm ảnh → đường cắt
gợn sóng. Đo bằng SAI SỐ so với ảnh render sạch (không nén), tức đúng đại lượng
thợ nhìn thấy trên bản bế, không phải một chỉ số trung gian.

Kiểm ở mức hàm thuần (numpy + skimage), không PDF, không PDFium.
"""
import cv2
import numpy as np
from skimage import measure

from app.workers.sticker_engine import _lam_mem_dai_bien, _PT_PER_MM

_DPI = 300.0
_TRAN_PX = 6000  # MAX_LONG_PX trong engine


def _anh(canh_mm: float, chat_luong_jpeg: int):
    """Tem tròn trên nền trắng; mô phỏng cả trần độ phân giải của engine."""
    canh_pt = canh_mm * _PT_PER_MM
    scale = (_DPI / 72.0) * min(1.0, _TRAN_PX / (canh_pt * _DPI / 72.0))
    px = int(round(canh_pt * scale))
    img = np.full((px, px, 3), 255, np.uint8)
    cv2.circle(img, (px // 2, px // 2), int(px * 0.45), (30, 60, 200), -1,
               lineType=cv2.LINE_AA)
    if chat_luong_jpeg:
        ma = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, chat_luong_jpeg])[1]
        img = cv2.imdecode(ma, 1)
    return img, scale, px


def _mask_nen_trang(img: np.ndarray) -> np.ndarray:
    """Đúng nhánh nền trắng của engine: ngưỡng 248 + lọc thành phần chạm biên."""
    nen = (img.min(axis=2) >= 248).astype(np.uint8) * 255
    _, nhan = cv2.connectedComponents(nen)
    vien = set(nhan[0, :]) | set(nhan[-1, :]) | set(nhan[:, 0]) | set(nhan[:, -1])
    vien.discard(0)
    return cv2.bitwise_not(np.isin(nhan, list(vien)).astype(np.uint8) * 255)


def _ban_kinh_theo_goc(mask: np.ndarray, scale: float, px: int) -> np.ndarray:
    """Hồ sơ bán kính (mm) theo 720 góc, lấy trên biên dài nhất."""
    aa = cv2.GaussianBlur(mask, (7, 7), 0)  # corner_style="round"
    duong = measure.find_contours(np.pad(aa, 1, constant_values=0), 127.5)
    diem = (max(duong, key=len) - 1)[:, [1, 0]] / scale
    tam = np.array([px / 2, px / 2]) / scale
    d = diem - tam
    goc = np.arctan2(d[:, 1], d[:, 0])
    ban_kinh = np.hypot(d[:, 0], d[:, 1]) / _PT_PER_MM
    tt = np.argsort(goc)
    return np.interp(np.linspace(-np.pi, np.pi, 720), goc[tt], ban_kinh[tt])


def _sai_so_rms(canh_mm: float, lam_mem: bool) -> float:
    """RMS sai lệch bán kính (mm) so với cùng con tem render sạch."""
    img_sach, scale, px = _anh(canh_mm, 0)
    chuan = _ban_kinh_theo_goc(_mask_nen_trang(img_sach), scale, px)
    img, scale, px = _anh(canh_mm, 60)
    mask = _mask_nen_trang(img)
    if lam_mem:
        mask = _lam_mem_dai_bien(mask, img, scale * 72.0 / 25.4)
    return float(np.sqrt(((_ban_kinh_theo_goc(mask, scale, px) - chuan) ** 2).mean()))


def test_giam_gon_song_o_moi_co_tem():
    """Làm mềm dải biên phải giảm sai số ở MỌI cỡ — không ca nào tệ hơn."""
    for canh_mm in (20.0, 50.0, 200.0, 800.0):
        cu = _sai_so_rms(canh_mm, False)
        moi = _sai_so_rms(canh_mm, True)
        assert moi < cu, f"tem {canh_mm}mm: {cu:.3f} -> {moi:.3f} mm, không cải thiện"


def test_tem_lon_giam_it_nhat_mot_phan_ba():
    """Ca khách báo lỗi (~80 cm): gợn sóng phải giảm rõ, không chỉ nhúc nhích."""
    cu = _sai_so_rms(800.0, False)
    moi = _sai_so_rms(800.0, True)
    assert moi < cu * 0.75, f"800mm chỉ giảm {100 * (1 - moi / cu):.1f}%"


def test_khong_lam_xe_dich_hinh():
    """Chỉ đổi dải biên, ruột và nền giữ nguyên → diện tích lệch dưới 1%."""
    img, scale, px = _anh(200.0, 60)
    mask = _mask_nen_trang(img)
    moi = _lam_mem_dai_bien(mask, img, scale * 72.0 / 25.4)
    a0 = np.count_nonzero(cv2.threshold(mask, 127, 255, cv2.THRESH_BINARY)[1])
    a1 = np.count_nonzero(cv2.threshold(moi, 127, 255, cv2.THRESH_BINARY)[1])
    assert abs(a1 - a0) / a0 < 0.01, f"diện tích lệch {100 * (a1 - a0) / a0:+.3f}%"


def test_giu_nguyen_ruot_mau_nhat():
    """Vùng nhạt GIỮA artwork (kem/highlight) không được biến thành lỗ thủng."""
    img, scale, px = _anh(200.0, 60)
    cv2.circle(img, (px // 2, px // 2), int(px * 0.2), (252, 250, 251), -1)
    mask = _mask_nen_trang(img)
    moi = _lam_mem_dai_bien(mask, img, scale * 72.0 / 25.4)
    assert mask[px // 2, px // 2] == 255
    assert moi[px // 2, px // 2] == 255, "ruột pastel bị đục thủng"


def test_bo_qua_khi_kich_thuoc_lech():
    """Đầu vào không khớp thì trả nguyên mask, không nổ."""
    mask = np.zeros((10, 10), np.uint8)
    assert _lam_mem_dai_bien(mask, np.zeros((5, 5, 3), np.uint8), 12.0) is mask
    assert _lam_mem_dai_bien(mask, None, 12.0) is mask
    assert _lam_mem_dai_bien(mask, np.zeros((10, 10, 3), np.uint8), 0) is mask
