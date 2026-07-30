"""Đo chất lượng quỹ đạo bù xén trên file thật (BX-07, audit bù xén 2026-07-30).

Chạy:  venv\\Scripts\\python scripts\\measure_bleed_trajectory.py [pdf] [bleed_mm]

In các chỉ số ĐỊNH LƯỢNG của trường dịch (displacement) mà thuật toán quỹ đạo áp
lên dải bù xén, cho từng mép. Dùng để so trước/sau bản vá thay vì cảm nhận bằng mắt:

* ``|disp|max / amount`` — kéo màu từ khoảng cách bao nhiêu lần bề rộng dải.
  Hoa văn hợp lý nên ≲1.0; >2 nghĩa là lấy màu từ chỗ phi lý.
* ``sign_flips`` — số lần trường dịch đổi dấu. Hoa văn tỏa thật chỉ đổi 1 lần
  (quanh tâm). Nhiều lần = quỹ đạo xé thành đoạn.
* ``max_jump`` — gãy khúc lớn nhất giữa 2 hàng liền kề (px). Càng nhỏ càng liền nét.
"""
import os
import sys

import numpy as np

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import cv2  # noqa: E402
from PIL import Image  # noqa: E402

from app.workers import sticker_engine as se  # noqa: E402

DPI = 300.0
PX_PER_MM = DPI / 25.4


def _render(pdf_path: str) -> np.ndarray:
    import pypdfium2 as pdfium
    pdf = pdfium.PdfDocument(pdf_path)
    page = pdf[0]
    bitmap = page.render(scale=DPI / 72.0)
    img = np.array(bitmap.to_pil().convert("RGB"))
    bitmap.close()
    page.close()
    pdf.close()
    return np.ascontiguousarray(img)


def _capture_disp(img: np.ndarray, amount: int) -> np.ndarray:
    """Chạy _trajectory_right_strip, bắt trường dịch ở cột XA nhất của dải."""
    original_remap = cv2.remap
    captured: list = []

    def spy(src, map_x, map_y, **kwargs):
        captured.append(np.asarray(map_y).copy())
        return original_remap(src, map_x, map_y, **kwargs)

    cv2.remap = spy
    try:
        se._trajectory_right_strip(img, amount, PX_PER_MM)
    finally:
        cv2.remap = original_remap
    if not captured:
        return np.zeros(img.shape[0], dtype=np.float32)
    map_y = captured[0]
    rows = np.arange(map_y.shape[0], dtype=np.float32)[:, None]
    return (map_y - rows)[:, -1]


def _metrics(disp: np.ndarray, amount: int) -> dict:
    moving = disp[np.abs(disp) > 1.0]
    flips = 0
    if moving.size > 1:
        flips = int(np.count_nonzero(np.diff(np.sign(moving)) != 0))
    jumps = np.abs(np.diff(disp)) if disp.size > 1 else np.zeros(1)
    return {
        "reach_ratio": float(np.abs(disp).max()) / max(1, amount),
        "sign_flips": flips,
        "max_jump": float(jumps.max()),
        "mean_jump": float(jumps.mean()),
    }


def main() -> None:
    pdf = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\Khanh Pham\Desktop\Binder162.pdf"
    bleed_mm = float(sys.argv[2]) if len(sys.argv) > 2 else 3.0
    amount = int(round(bleed_mm * PX_PER_MM))

    img = _render(pdf)
    print(f"file={os.path.basename(pdf)} raster={img.shape[1]}x{img.shape[0]}px "
          f"bleed={bleed_mm}mm amount={amount}px")
    print(f"{'edge':<8}{'reach(|d|max/amt)':>20}{'sign_flips':>12}{'max_jump':>10}{'mean_jump':>11}")

    # Mỗi mép quy về "mép phải" bằng phép quay, đúng như engine làm qua transpose.
    edges = {
        "right": img,
        "left": np.ascontiguousarray(img[:, ::-1]),
        "top": np.ascontiguousarray(np.transpose(img, (1, 0, 2))),
        "bottom": np.ascontiguousarray(np.transpose(img, (1, 0, 2))[:, ::-1]),
    }
    for name, oriented in edges.items():
        disp = _capture_disp(oriented, amount)
        m = _metrics(disp, amount)
        print(f"{name:<8}{m['reach_ratio']:>20.2f}{m['sign_flips']:>12d}"
              f"{m['max_jump']:>10.1f}{m['mean_jump']:>11.2f}")


if __name__ == "__main__":
    main()
