"""So TRƯỚC/SAU bản vá BX-07 trên cùng hoa văn tổng hợp (audit bù xén lần 2).

"Trước" được xấp xỉ bằng cách hạ các hằng số BX-07 về hành vi cũ:
  * sigma cũ = 0.18×px_per_mm (≈2.1px @300DPI, trần 4) → đặt PER_AMOUNT/PER_EDGE = 0
    và MAX_SIGMA = 4.0. Khi sigma ≈ 2 thì median kernel = 3 (gần như vô hại) và
    trust-weight decay rất hẹp → sát hành vi trước bản vá.
  * không chặn tầm với → REACH_FACTOR = 10^6.

Đo 3 chỉ số ĐỐI KHÁNG nhau để thấy bản vá đánh đổi cái gì lấy cái gì:
  * err   — sai số bám nét NỘI VÙNG (thấp = bám đúng hướng hoa văn)
  * nhiễm — số hàng bị kéo theo hướng của VÙNG BÊN CẠNH (= loang)
  * jump  — gãy khúc lớn nhất giữa 2 hàng kề (= gãy)
"""
import os
import sys

import numpy as np

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.workers import sticker_engine as se  # noqa: E402
from measure_bleed_fidelity import (  # noqa: E402
    PX_PER_MM,
    capture_map,
    chevron,
    effective_slopes,
)


def measure(h: int, amount: int, slopes=(0.8, -0.8, 0.8)) -> dict:
    img, gt, bounds = chevron(h, 320, slopes)
    map_y = capture_map(img, amount)
    eff = effective_slopes(map_y)
    err = np.abs(eff - gt)

    guard = max(3, int(0.08 * h))
    interior = np.ones(h, dtype=bool)
    for b in bounds[1:-1]:
        interior[max(0, b - guard):min(h, b + guard)] = False

    span = float(np.abs(gt).max() * 2.0) or 1.0
    contam = int(np.count_nonzero(err > 0.30 * span))

    col = map_y[:, -1]
    disp = col - np.arange(h, dtype=np.float32)
    return {
        "err": float(np.median(err[interior])),
        "contam": contam,
        "contam_pct": 100.0 * contam / h,
        "jump": float(np.abs(np.diff(disp)).max()),
        "reach": float(np.abs(disp).max()) / amount,
    }


class OldParams:
    """Context manager hạ hằng số về xấp xỉ hành vi TRƯỚC bản vá BX-07."""

    KEYS = (
        "_TRAJ_SMOOTH_PER_AMOUNT",
        "_TRAJ_SMOOTH_PER_EDGE",
        "_TRAJ_SMOOTH_MAX_SIGMA",
        "_TRAJ_MAX_REACH_FACTOR",
    )

    def __enter__(self):
        self.saved = {k: getattr(se, k) for k in self.KEYS}
        se._TRAJ_SMOOTH_PER_AMOUNT = 0.0
        se._TRAJ_SMOOTH_PER_EDGE = 0.0
        se._TRAJ_SMOOTH_MAX_SIGMA = 4.0
        se._TRAJ_MAX_REACH_FACTOR = 1e6
        return self

    def __exit__(self, *exc):
        for k, v in self.saved.items():
            setattr(se, k, v)
        return False


def main() -> None:
    amount = int(round(3.0 * PX_PER_MM))
    print(f"hoa văn 3 vùng dốc +0.8/−0.8/+0.8, bù xén 3mm = {amount}px")
    print(f"{'mép(px)':>9}{'phiên bản':>12}{'err nội vùng':>14}"
          f"{'nhiễm(hàng)':>13}{'nhiễm%':>8}{'gãy(px)':>9}{'tầm với':>9}")
    for h in (480, 1200, 3508):
        with OldParams():
            before = measure(h, amount)
        after = measure(h, amount)
        for label, m in (("TRƯỚC", before), ("SAU", after)):
            print(f"{h:>9}{label:>12}{m['err']:>14.3f}{m['contam']:>13}"
                  f"{m['contam_pct']:>7.1f}%{m['jump']:>9.1f}{m['reach']:>9.2f}")

    print()
    print("Hoa văn MỘT hướng (không có ranh giới → tách riêng phần bám nét):")
    print(f"{'dốc thật':>9}{'phiên bản':>12}{'err':>10}{'gãy(px)':>9}{'tầm với':>9}")
    for s in (0.2, 0.4, 0.8, 1.2):
        with OldParams():
            b = measure(1200, amount, slopes=(s,))
        a = measure(1200, amount, slopes=(s,))
        for label, m in (("TRƯỚC", b), ("SAU", a)):
            print(f"{s:>9.1f}{label:>12}{m['err']:>10.3f}{m['jump']:>9.1f}{m['reach']:>9.2f}")


if __name__ == "__main__":
    main()
