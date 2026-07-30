"""Tách từng CƠ CHẾ làm hỏng quỹ đạo bù xén (audit bù xén lần 2, 2026-07-30).

`measure_bleed_fidelity.py` cho thấy 3 dấu hiệu bất thường cùng lúc:
  err nội vùng ≡ 0.200, jac_min ≡ 0.00, jac_max tới 20.0, clip% 48-85%.
Script này chạy từng phép đo CÔ LẬP để biết dấu hiệu nào do cơ chế nào, thay vì
suy diễn từ đọc code.

A) Trần TẦM VỚI có tự biến thành trần ĐỘ DỐC không?
   Hoa văn MỘT hướng, quét độ dốc thật 0.1 → 1.25. Nếu engine bám đúng thì
   slope_eff ≈ gt trên toàn dải. Nếu trần tầm với (0.6×amount) chi phối thì
   slope_eff sẽ bão hoà ở 0.6 bất kể gt.

B) Quỹ đạo HỘI TỤ (hai vùng dốc ngược chiều hướng vào nhau) bị xử lý thế nào?
   `np.maximum.accumulate` cưỡng chế đơn điệu → chỗ hội tụ thành CAO NGUYÊN.
   Đo chiều dài cao nguyên + hệ số kéo dãn của ánh xạ nghịch tại đó.

C) jac_min = 0 nằm ở ĐÂU? (mép biên do np.interp kẹp left/right, hay giữa dải?)

D) Sigma làm trơn có trải hướng XUYÊN ranh giới hoa văn không (= "loang")?
   Đo bề rộng vùng nhiễm quanh ranh giới theo từng sigma.
"""
import os
import sys

import numpy as np

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import cv2  # noqa: E402

from app.workers import sticker_engine as se  # noqa: E402
from measure_bleed_fidelity import (  # noqa: E402
    PX_PER_MM,
    capture_map,
    chevron,
    effective_slopes,
)

AMOUNT = int(round(3.0 * PX_PER_MM))  # bù xén 3mm @300DPI = 35px


def probe_a_slope_ceiling() -> None:
    print("=" * 78)
    print("A) TRẦN TẦM VỚI có biến thành TRẦN ĐỘ DỐC?  (hoa văn MỘT hướng, h=1200)")
    print(f"   amount={AMOUNT}px, max_reach = {se._TRAJ_MAX_REACH_FACTOR}×amount"
          f" = {se._TRAJ_MAX_REACH_FACTOR * AMOUNT:.1f}px")
    print(f"   _TRAJ_MAX_SLOPE khai báo = {se._TRAJ_MAX_SLOPE}")
    print(f"{'dốc thật':>10}{'dốc hiệu dụng (median)':>25}{'sai số':>9}{'clip%':>8}")
    h, w = 1200, 320
    for s in (0.1, 0.2, 0.4, 0.6, 0.8, 1.0, 1.25):
        img, gt, bounds = chevron(h, w, (s,))
        map_y = capture_map(img, AMOUNT)
        eff = effective_slopes(map_y)
        col = map_y[:, -1]
        reach = np.abs(col - np.arange(h, dtype=np.float32))
        max_reach = se._TRAJ_MAX_REACH_FACTOR * float(AMOUNT)
        clip = 100.0 * np.count_nonzero(reach >= max_reach - 0.51) / h
        med = float(np.median(eff))
        print(f"{s:>10.2f}{med:>25.3f}{abs(med - s):>9.3f}{clip:>7.1f}%")


def probe_b_converging() -> None:
    print("=" * 78)
    print("B) QUỸ ĐẠO HỘI TỤ — hai vùng dốc hướng VÀO nhau (+0.8 rồi −0.8)")
    print("   So với PHÂN KỲ (−0.8 rồi +0.8) là ca đơn điệu tự nhiên.")
    print(f"{'kiểu':<12}{'jac min':>9}{'jac max':>9}{'cao nguyên(hàng)':>18}"
          f"{'|d|max':>9}{'err trung vị':>14}")
    h, w = 1200, 320
    for name, slopes in (("hội tụ", (0.8, -0.8)), ("phân kỳ", (-0.8, 0.8))):
        img, gt, bounds = chevron(h, w, slopes)
        map_y = capture_map(img, AMOUNT)
        col = map_y[:, -1]
        jac = np.diff(col)
        # Cao nguyên của ánh xạ THUẬN thể hiện ở ánh xạ nghịch dưới dạng đoạn
        # jac lớn bất thường (một hàng nguồn kéo dãn ra nhiều hàng đích).
        plateau = int(np.count_nonzero(jac > 2.0))
        eff = effective_slopes(map_y)
        err = float(np.median(np.abs(eff - gt)))
        reach = np.abs(col - np.arange(h, dtype=np.float32))
        print(f"{name:<12}{jac.min():>9.2f}{jac.max():>9.2f}{plateau:>18}"
              f"{reach.max():>9.1f}{err:>14.3f}")

    # Chi tiết ca hội tụ: cao nguyên nằm ở đâu, dài bao nhiêu.
    img, gt, bounds = chevron(h, w, (0.8, -0.8))
    map_y = capture_map(img, AMOUNT)
    col = map_y[:, -1]
    jac = np.diff(col)
    hot = np.flatnonzero(jac > 2.0)
    if hot.size:
        print(f"   ranh giới hoa văn ở hàng {bounds[1]}; đoạn kéo dãn: hàng "
              f"{hot.min()}..{hot.max()} (dài {hot.max() - hot.min() + 1}), "
              f"jac tại đó max={jac[hot].max():.1f}")
        print(f"   → 1 hàng nguồn bị trải ra tối đa {jac[hot].max():.0f} hàng đích"
              f" = vệt loang dọc mép")
    print(f"   min_spacing trong engine = 0.05 → trần kéo dãn lý thuyết = "
          f"{1/0.05:.0f}×")


def probe_c_where_jac_zero() -> None:
    print("=" * 78)
    print("C) jac_min = 0 NẰM Ở ĐÂU? (kẹp biên np.interp hay giữa dải?)")
    h, w = 1200, 320
    for name, slopes in (("một hướng +0.8", (0.8,)), ("chevron 3 vùng", (0.8, -0.8, 0.8))):
        img, gt, bounds = chevron(h, w, slopes)
        map_y = capture_map(img, AMOUNT)
        col = map_y[:, -1]
        jac = np.diff(col)
        flat = np.flatnonzero(jac <= 1e-6)
        if not flat.size:
            print(f"   {name:<18} không có đoạn phẳng")
            continue
        # Gom thành các đoạn liên tiếp.
        breaks = np.flatnonzero(np.diff(flat) > 1)
        starts = np.concatenate(([flat[0]], flat[breaks + 1]))
        ends = np.concatenate((flat[breaks], [flat[-1]]))
        runs = [(int(a), int(b), int(b - a + 1)) for a, b in zip(starts, ends)]
        runs.sort(key=lambda r: -r[2])
        print(f"   {name:<18} tổng {flat.size} hàng phẳng; đoạn dài nhất: "
              + ", ".join(f"hàng {a}..{b} ({n})" for a, b, n in runs[:3]))
        print(f"   {'':18} (h={h}; đoạn sát 0 hoặc sát {h-1} = kẹp biên "
              f"np.interp left/right)")


def probe_d_contamination_vs_sigma() -> None:
    print("=" * 78)
    print("D) SIGMA trải hướng XUYÊN ranh giới hoa văn (= loang) — bao rộng?")
    print("   Ép sigma bằng cách đổi chiều dài mép h (sigma = 0.03×h, trần 64).")
    print(f"{'h(px)':>7}{'sigma':>8}{'bề rộng nhiễm quanh ranh giới(hàng)':>38}"
          f"{'% mép':>8}")
    w = 320
    for h in (480, 960, 1920, 3508, 4960):
        img, gt, bounds = chevron(h, w, (0.8, -0.8))
        map_y = capture_map(img, AMOUNT)
        eff = effective_slopes(map_y)
        b = int(bounds[1])
        # Nhiễm = lệch gt quá 25% biên độ hướng (0.8) quanh ranh giới.
        bad = np.abs(eff - gt) > 0.25 * 0.8
        # Bề rộng liên tục quanh ranh giới.
        lo = b
        while lo > 0 and bad[lo - 1]:
            lo -= 1
        hi = b
        while hi < h - 1 and bad[hi]:
            hi += 1
        width = hi - lo
        sigma = max(0.8, min(se._TRAJ_SMOOTH_MAX_SIGMA,
                             max(0.18 * PX_PER_MM,
                                 se._TRAJ_SMOOTH_PER_AMOUNT * AMOUNT,
                                 se._TRAJ_SMOOTH_PER_EDGE * h)))
        print(f"{h:>7}{sigma:>8.1f}{width:>38}{100.0 * width / h:>7.1f}%")
    print("   Ghi chú: nhiễm ở đây KHÔNG phải nhiễu — là hướng của vùng A bị")
    print("   Gaussian/median trải sang dải bù xén của vùng B.")


def main() -> None:
    probe_a_slope_ceiling()
    probe_b_converging()
    probe_c_where_jac_zero()
    probe_d_contamination_vs_sigma()


if __name__ == "__main__":
    main()
