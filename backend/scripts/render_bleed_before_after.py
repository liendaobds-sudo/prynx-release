"""Render ẢNH dải bù xén để soi BẰNG MẮT (đóng proof gap của audit bù xén lần 2).

Mọi số đo trước đây là trường dịch (displacement) — gián tiếp. Script này dựng ảnh
PIXEL CUỐI mà thuật toán quỹ đạo sinh ra, cho từng biến thể tham số, ghép cạnh nhau
kèm nhãn để so.

Bố cục ảnh xuất: mỗi biến thể một BĂNG ngang gồm
    [ dải artwork sát mép (nguồn) | ĐƯỜNG TRIM đỏ | dải bù xén do engine sinh ]
Dải bù xén được phóng ngang ``--zoom`` lần để nhìn rõ khuỷu gập.

Chạy:
    venv\\Scripts\\python scripts\\render_bleed_before_after.py
    venv\\Scripts\\python scripts\\render_bleed_before_after.py <pdf> <bleed_mm> <edge>

``edge`` ∈ right|left|top|bottom (mặc định right). Ảnh ra: backend/debug_output/.
"""
import os
import sys

import numpy as np

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import cv2  # noqa: E402

from app.workers import sticker_engine as se  # noqa: E402

DPI = 300.0
PX_PER_MM = DPI / 25.4
OUT_DIR = os.path.join(_BACKEND_DIR, "debug_output")

# Biến thể tham số. None = giữ nguyên giá trị đang có trong engine.
#   name, max_slope, reach_factor, per_amount, per_edge, max_sigma, use_median, use_trust
VARIANTS = [
    # Trước bản vá BX-07: sigma yếu, không median, không trust, không chặn tầm với.
    dict(name="A_truoc_BX07", max_slope=1.25, reach_factor=1e9,
         per_amount=0.0, per_edge=0.0, max_sigma=4.0,
         use_median=False, use_trust=False),
    # Hiện tại (sau BX-07): clip offset theo từng bước → khuỷu gập.
    dict(name="B_hien_tai_BX07", max_slope=1.25, reach_factor=0.6,
         per_amount=0.35, per_edge=0.03, max_sigma=64.0,
         use_median=True, use_trust=True),
]


def _apply(variant: dict) -> dict:
    """Đặt hằng module theo biến thể, trả lại giá trị cũ để phục hồi."""
    keys = {
        "max_slope": "_TRAJ_MAX_SLOPE",
        "reach_factor": "_TRAJ_MAX_REACH_FACTOR",
        "per_amount": "_TRAJ_SMOOTH_PER_AMOUNT",
        "per_edge": "_TRAJ_SMOOTH_PER_EDGE",
        "max_sigma": "_TRAJ_SMOOTH_MAX_SIGMA",
    }
    saved = {}
    for k, attr in keys.items():
        if variant.get(k) is None or not hasattr(se, attr):
            continue
        saved[attr] = getattr(se, attr)
        setattr(se, attr, variant[k])
    return saved


def _restore(saved: dict) -> None:
    for attr, val in saved.items():
        setattr(se, attr, val)


def _patch_optional_steps(variant: dict):
    """Tắt median / trust-weight bằng cách chặn scipy.median_filter và GaussianBlur.

    Bản 'trước BX-07' không có hai bước này. Không thể tắt bằng hằng số nên vá tạm
    ``scipy.ndimage.median_filter`` thành identity khi cần.
    """
    undo = []
    if not variant.get("use_median", True):
        import scipy.ndimage as ndi
        orig = ndi.median_filter
        ndi.median_filter = lambda a, **kw: a
        undo.append(lambda: setattr(ndi, "median_filter", orig))
    return undo


def _render_page(pdf: str) -> np.ndarray:
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(pdf)
    page = doc[0]
    bitmap = page.render(scale=DPI / 72.0)
    img = np.array(bitmap.to_pil().convert("RGB"))
    bitmap.close()
    page.close()
    doc.close()
    return np.ascontiguousarray(img)


def _orient(img: np.ndarray, edge: str) -> np.ndarray:
    """Quy mọi mép về 'mép phải', đúng như engine làm qua transpose/flip."""
    if edge == "right":
        return img
    if edge == "left":
        return np.ascontiguousarray(img[:, ::-1])
    if edge == "top":
        return np.ascontiguousarray(np.transpose(img, (1, 0, 2)))
    if edge == "bottom":
        return np.ascontiguousarray(np.transpose(img, (1, 0, 2))[:, ::-1])
    raise SystemExit(f"edge lạ: {edge}")


def _label(canvas: np.ndarray, text: str, y: int) -> None:
    cv2.putText(canvas, text, (6, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5,
                (0, 0, 0), 1, cv2.LINE_AA)


def main() -> None:
    pdf = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\Khanh Pham\Desktop\Binder162.pdf"
    bleed_mm = float(sys.argv[2]) if len(sys.argv) > 2 else 3.0
    edge = sys.argv[3] if len(sys.argv) > 3 else "right"
    zoom = int(sys.argv[4]) if len(sys.argv) > 4 else 6

    amount = int(round(bleed_mm * PX_PER_MM))
    page = _render_page(pdf)
    oriented = _orient(page, edge)
    h = oriented.shape[0]
    os.makedirs(OUT_DIR, exist_ok=True)

    # Dải artwork nguồn: lấy đúng bề rộng bằng dải bù xén để so 1:1.
    src = oriented[:, -amount:].copy()

    print(f"file={os.path.basename(pdf)} edge={edge} raster={page.shape[1]}x{page.shape[0]}"
          f" mép={h}px bleed={bleed_mm}mm={amount}px zoom={zoom}×")

    bands = []
    for variant in VARIANTS + [dict(name="C_code_dang_chay")]:
        saved = _apply(variant)
        undo = _patch_optional_steps(variant)
        try:
            strip = se._trajectory_right_strip(oriented, amount, PX_PER_MM)
        finally:
            for fn in undo:
                fn()
            _restore(saved)

        band = np.concatenate([
            src,
            np.full((h, 2, 3), (220, 0, 0), dtype=np.uint8),   # đường trim đỏ
            strip,
        ], axis=1)
        band = cv2.resize(band, (band.shape[1] * zoom, h),
                          interpolation=cv2.INTER_NEAREST)
        header = np.full((22, band.shape[1], 3), 245, dtype=np.uint8)
        _label(header, f"{variant['name']}  (trai=artwork | do=trim | phai=bu xen)", 15)
        bands.append(np.concatenate([header, band], axis=0))

        out = os.path.join(OUT_DIR, f"bleed_{edge}_{variant['name']}.png")
        cv2.imwrite(out, cv2.cvtColor(strip, cv2.COLOR_RGB2BGR))
        print(f"  {variant['name']:<18} → {out}")

    gap = np.full((bands[0].shape[0], 8, 3), 255, dtype=np.uint8)
    joined = bands[0]
    for b in bands[1:]:
        joined = np.concatenate([joined, gap, b], axis=1)
    combo = os.path.join(OUT_DIR, f"bleed_{edge}_SO_SANH.png")
    cv2.imwrite(combo, cv2.cvtColor(joined, cv2.COLOR_RGB2BGR))
    print(f"  ẢNH SO SÁNH        → {combo}")


if __name__ == "__main__":
    main()
