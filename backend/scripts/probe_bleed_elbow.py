"""Đo KHUỶU GẬP trong quỹ đạo do trần tầm với chặn theo ``step``
(audit bù xén lần 2, 2026-07-30).

``offset = clip(slope*step, ±0.6*amount)``. Với hàng có ``slope`` lớn, tích
``slope*step`` chạm trần ở bước ``step* = 0.6*amount/slope`` < amount. Từ bước đó
tới hết dải, offset KHÔNG tăng nữa → quỹ đạo của vệt màu đi thẳng theo hướng nét
rồi BẺ NGANG song song với mép. Đó là một khuỷu gập HÌNH HỌC nhìn thấy được trên
ảnh, khác với "gãy khúc giữa hai hàng kề" mà script trước đo.

Script in: bước chạm trần, tỉ lệ dải còn lại bị đi ngang, và góc bẻ.
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
    got = []

    def spy(src, map_x, map_y, **kw):
        got.append(np.asarray(map_y).copy())
        return original(src, map_x, map_y, **kw)

    cv2.remap = spy
    try:
        se._trajectory_right_strip(np.ascontiguousarray(img), amount, PX_PER_MM)
    finally:
        cv2.remap = original
    return got[0]


def striped(h, w, slope, period=22.0):
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    wave = np.sin(2.0 * np.pi * (yy - slope * xx) / period)
    v = np.where(wave > 0, 210, 35).astype(np.uint8)
    return np.ascontiguousarray(np.stack([v, 255 - v, v // 2], -1))


def main():
    h, w = 1200, 320
    amount = int(round(3.0 * PX_PER_MM))
    max_reach = se._TRAJ_MAX_REACH_FACTOR * amount
    print("=" * 78)
    print("KHUỶU GẬP do trần tầm với chặn theo bước (amount=%dpx, trần=%.1fpx)"
          % (amount, max_reach))
    print("=" * 78)
    print(f"{'dốc thật':>9}{'dốc hiệu dụng':>15}{'bước chạm trần':>16}"
          f"{'% dải đi ngang':>16}{'góc bẻ(độ)':>12}")
    for s in (0.2, 0.4, 0.6, 0.8, 1.0, 1.25):
        img = striped(h, w, s)
        map_y = capture_map(img, amount)
        rows = np.arange(h, dtype=np.float32)[:, None]
        # offset thuận theo từng bước, lấy hàng giữa cho sạch biên.
        mid = h // 2
        disp = -(map_y[mid, :] - rows[mid, 0])
        eff = disp[-1] / amount
        # bước đầu tiên mà offset thôi tăng (|Δ| < 5% độ dốc hiệu dụng)
        d = np.abs(np.diff(disp))
        thr = 0.05 * max(1e-6, abs(eff))
        flat = np.flatnonzero(d <= thr)
        step_hit = int(flat[0]) + 1 if flat.size else amount
        pct_flat = 100.0 * (amount - step_hit) / amount
        bend = abs(np.degrees(np.arctan(eff)))
        print(f"{s:>9.2f}{eff:>15.3f}{step_hit:>16d}{pct_flat:>15.1f}%{bend:>12.1f}")
    print()
    print("Ghi chú: 'bước chạm trần' < amount nghĩa là vệt màu đi đúng hướng nét")
    print("một đoạn rồi BẺ NGANG song song mép cho hết dải — khuỷu gập thấy được.")


if __name__ == "__main__":
    main()
