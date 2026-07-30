"""Khoanh vị trí NẾP GẤP (jac≈0) trong ca quỹ đạo HỘI TỤ — audit bù xén lần 2.

Probe B đo được ``jac_min = 0.00`` cho ca hội tụ (hai vùng hoa văn dốc hướng VÀO
nhau) nhưng lại đếm "cao nguyên = 0 hàng". Hai số đó nhìn như mâu thuẫn, nên phải
khoanh cho rõ TRƯỚC KHI kết luận: jac≈0 nằm ở BIÊN (kẹp ``np.interp`` left/right —
vô hại, nằm ngoài vùng nhìn thấy) hay ở GIỮA dải (nếp gấp thật — nhiều hàng nguồn bị
nén vào một hàng đích = vệt sắc nét sai chỗ, đúng thứ mắt thấy là "gãy khúc").

Chạy: venv\\Scripts\\python scripts\\probe_bleed_fold.py
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


def capture_map(img, amount):
    original = cv2.remap
    captured = []

    def spy(src, map_x, map_y, **kwargs):
        captured.append(np.asarray(map_y).copy())
        return original(src, map_x, map_y, **kwargs)

    cv2.remap = spy
    try:
        se._trajectory_right_strip(np.ascontiguousarray(img), amount, PX_PER_MM)
    finally:
        cv2.remap = original
    return captured[0]


def two_zone(h, w, s_top, s_bottom, period=22.0):
    """Hai vùng sọc, dốc s_top ở nửa trên và s_bottom ở nửa dưới."""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    img = np.zeros((h, w, 3), dtype=np.uint8)
    for r0, r1, s in ((0, h // 2, s_top), (h // 2, h, s_bottom)):
        wave = np.sin(2.0 * np.pi * (yy[r0:r1] - s * xx[r0:r1]) / period)
        v = np.where(wave > 0, 210, 35).astype(np.uint8)
        img[r0:r1, :, 0] = v
        img[r0:r1, :, 1] = 255 - v
        img[r0:r1, :, 2] = v // 2
    return img


def runs_below(jac, thresh):
    """Các đoạn liên tiếp có jac < thresh, trả (bắt_đầu, dài)."""
    flag = jac < thresh
    out = []
    i = 0
    while i < flag.size:
        if flag[i]:
            j = i
            while j + 1 < flag.size and flag[j + 1]:
                j += 1
            out.append((i, j - i + 1))
            i = j + 1
        else:
            i += 1
    return out


def report(name, img, amount):
    h = img.shape[0]
    map_y = capture_map(img, amount)
    print(f"\n{name}  (h={h}, amount={amount}px)")
    for col_label, col_idx in (("cột gần nhất", 0), ("cột giữa", amount // 2),
                               ("cột XA nhất", amount - 1)):
        col = map_y[:, col_idx]
        jac = np.diff(col)
        near_zero = runs_below(jac, 0.02)
        interior = [(s, n) for (s, n) in near_zero if s > 5 and s + n < h - 6]
        biggest_int = max(interior, key=lambda t: t[1], default=None)
        print(f"  {col_label:<13} jac min={jac.min():>5.2f} max={jac.max():>5.2f}"
              f" | đoạn jac<0.02: tổng {len(near_zero)}"
              f", trong đó GIỮA dải {len(interior)}"
              + (f" — dài nhất hàng {biggest_int[0]}..{biggest_int[0]+biggest_int[1]-1}"
                 f" ({biggest_int[1]} hàng)" if biggest_int else ""))

    # Cao nguyên offset: nhiều hàng liền nhau có CÙNG offset (đã bị chặn tầm với).
    col = map_y[:, -1]
    off = col - np.arange(h, dtype=np.float32)
    max_reach = se._TRAJ_MAX_REACH_FACTOR * float(amount)
    clipped = np.abs(off) >= max_reach - 0.51
    print(f"  hàng bị CHẶN tầm với: {int(clipped.sum())}/{h}"
          f" ({100.0*clipped.sum()/h:.1f}%) — trong vùng chặn mọi hướng ra CÙNG offset")


def main():
    amount = int(round(3.0 * PX_PER_MM))
    h, w = 1200, 320
    print("=" * 78)
    print("NẾP GẤP nằm ở BIÊN hay GIỮA dải? (jac = d map_y / d row, 1.0 là lý tưởng)")
    print("=" * 78)
    report("HỘI TỤ  (nửa trên +0.8, nửa dưới −0.8 → hai hướng chụm vào nhau)",
           two_zone(h, w, 0.8, -0.8), amount)
    report("PHÂN KỲ (nửa trên −0.8, nửa dưới +0.8 → hai hướng tách ra)",
           two_zone(h, w, -0.8, 0.8), amount)
    report("HỘI TỤ DỐC NHẸ (+0.3 / −0.3 → dưới trần tầm với, tách biến clip)",
           two_zone(h, w, 0.3, -0.3), amount)


if __name__ == "__main__":
    main()
