"""Lưới an toàn (BX-05, audit bù xén 2026-07-30) cho các hàm QUỸ ĐẠO của bù xén
"Làm mượt thông minh" tab Xén vuông góc.

Các hàm này (``_trajectory_right_strip`` / ``_trajectory_extend_axis`` /
``_rectangle_smooth_color_fill``) trước đây KHÔNG có test trực tiếp — mọi thay đổi
thuật toán (vd BX-03 nới clamp slope) đều không có lưới bắt hồi quy. File này khoá
các bất biến ổn định (KHÔNG khoá giá trị pixel bit-for-bit vì remap nội suy):

* Kích thước dải bù xén đúng theo tham số.
* Nền TRƠN (không có hướng) → bù xén giữ đúng màu nền (không sinh vệt lạ).
* Sọc NGANG (slope≈0) → dải bù xén không dịch dọc (mỗi hàng giữ màu của nó).
* Biên CHÉO → dải bù xén dịch theo ĐÚNG dấu của độ dốc (đi lên/xuống theo nét).
* ``_rectangle_smooth_color_fill`` nở đúng pads và GIỮ NGUYÊN lõi artwork tại chỗ.
"""
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

pytest.importorskip("cv2")

from app.workers.sticker_engine import (
    _trajectory_right_strip,
    _trajectory_extend_axis,
    _rectangle_smooth_color_fill,
)

# 300 DPI ≈ 11.81 px/mm; các test dùng giá trị này cho gần thực tế.
PX_PER_MM = 11.81


def _solid(h, w, color):
    img = np.empty((h, w, 3), dtype=np.uint8)
    img[:, :] = color
    return img


def test_right_strip_shape_and_dtype():
    """Dải phải phải đúng (h, amount, 3) uint8."""
    img = _solid(40, 40, (10, 120, 200))
    strip = _trajectory_right_strip(img, amount=15, px_per_mm=PX_PER_MM)
    assert strip.shape == (40, 15, 3)
    assert strip.dtype == np.uint8


def test_right_strip_zero_amount_empty():
    img = _solid(20, 20, (0, 0, 0))
    strip = _trajectory_right_strip(img, amount=0, px_per_mm=PX_PER_MM)
    assert strip.shape == (20, 0, 3)


def test_right_strip_solid_preserves_color():
    """Nền trơn không có hướng → dải bù xén phải cùng màu (không sinh vệt)."""
    color = (30, 90, 210)
    img = _solid(48, 48, color)
    strip = _trajectory_right_strip(img, amount=20, px_per_mm=PX_PER_MM)
    # Cho phép sai số nội suy nhỏ; bản chất phải là đúng màu nền.
    assert np.allclose(strip, np.array(color, dtype=np.float32), atol=2.0)


def test_right_strip_horizontal_bands_no_vertical_drift():
    """Sọc NGANG (slope≈0): mỗi hàng của dải bù xén giữ đúng màu hàng đó ở mép.

    Nếu thuật toán tự ý bẻ dọc, màu hàng sẽ lệch sang hàng khác → bắt được.
    """
    h, w = 60, 40
    img = np.zeros((h, w, 3), dtype=np.uint8)
    img[: h // 2] = (220, 40, 40)   # nửa trên đỏ
    img[h // 2 :] = (40, 40, 220)   # nửa dưới xanh
    strip = _trajectory_right_strip(img, amount=18, px_per_mm=PX_PER_MM)
    # Hàng gần biên (tránh vùng chuyển tiếp giữa) phải giữ đúng màu nửa của nó.
    assert strip[5, -1, 0] > strip[5, -1, 2]      # hàng trên: R > B (đỏ)
    assert strip[h - 6, -1, 2] > strip[h - 6, -1, 0]  # hàng dưới: B > R (xanh)


def _diagonal_boundary(h, w, going_up=True):
    """Ảnh có biên CHÉO giữa 2 màu; nét đi lên (going_up) hoặc xuống theo cột→phải."""
    img = np.zeros((h, w, 3), dtype=np.uint8)
    for x in range(w):
        # Biên nghiêng ~45°: y_boundary giảm khi x tăng (nét đi LÊN sang phải).
        yb = (h - 1 - x) if going_up else x
        yb = int(np.clip(yb, 0, h - 1))
        img[:yb, x] = (230, 30, 30)   # trên biên: đỏ
        img[yb:, x] = (30, 30, 230)   # dưới biên: xanh
    return img


def test_right_strip_diagonal_follows_slope_sign():
    """Biên chéo đi LÊN sang phải → trong dải bù xén, ranh giới đỏ/xanh tiếp tục
    đi lên (vị trí y của ranh giới ở cột xa < ở cột gần). Bắt sai DẤU độ dốc."""
    h, w = 80, 60
    img = _diagonal_boundary(h, w, going_up=True)
    amount = 24
    strip = _trajectory_right_strip(img, amount=amount, px_per_mm=PX_PER_MM)

    def boundary_row(col):
        # Ranh giới = hàng đầu tiên chuyển từ đỏ (R>B) sang xanh (B>R).
        r = strip[:, col, 0].astype(np.int32)
        b = strip[:, col, 2].astype(np.int32)
        blue_rows = np.flatnonzero(b > r + 20)
        return int(blue_rows[0]) if blue_rows.size else h // 2

    near = boundary_row(0)
    far = boundary_row(amount - 1)
    # Nét đi lên → ranh giới ở cột xa phải CAO hơn (y nhỏ hơn) cột gần.
    assert far <= near, f"kỳ vọng ranh giới đi lên: far={far} phải <= near={near}"


def _disp_field(img, amount):
    """Trường dịch (displacement) mà thuật toán áp lên cột XA nhất của dải bù xén."""
    import cv2
    original = cv2.remap
    captured = []

    def spy(src, map_x, map_y, **kwargs):
        captured.append(np.asarray(map_y).copy())
        return original(src, map_x, map_y, **kwargs)

    cv2.remap = spy
    try:
        _trajectory_right_strip(np.ascontiguousarray(img), amount, PX_PER_MM)
    finally:
        cv2.remap = original
    map_y = captured[0]
    rows = np.arange(map_y.shape[0], dtype=np.float32)[:, None]
    return (map_y - rows)[:, -1]


def _sunburst(h, w, cx, cy, nrays=16):
    """Hoa văn TỎA từ tâm (cx, cy) — mô phỏng nền tia mặt trời."""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    ang = np.arctan2(yy - cy, xx - cx)
    t = (np.sin(ang * nrays) > 0).astype(np.float32)
    img = np.stack([t * 220 + 20, (1 - t) * 40 + 20, (1 - t) * 220 + 20], -1)
    return np.ascontiguousarray(img.astype(np.uint8))


def test_sunburst_keeps_divergence():
    """BX-07: bản vá dập nhiễu KHÔNG được giết phân kỳ — tia tỏa vẫn phải loe.

    Trường dịch của hoa văn radial phải ĐỔI DẤU quanh tâm (hàng trên đi lên, hàng
    dưới đi xuống). Nếu bản vá làm phẳng hết thì dấu không đổi nữa → bắt được.
    """
    h, w = 240, 120
    cy = 120.0
    img = _sunburst(h, w, cx=-60.0, cy=cy)
    disp = _disp_field(img, amount=30)
    top_half = disp[: int(cy) - 20]
    bottom_half = disp[int(cy) + 20 :]
    # Hai nửa phải lệch dấu nhau (phân kỳ), không cùng chiều.
    assert top_half.mean() * bottom_half.mean() < 0, (
        f"mất phân kỳ: mean trên={top_half.mean():.2f} mean dưới={bottom_half.mean():.2f}"
    )


def test_trajectory_reach_bounded_by_strip_width():
    """BX-07 điểm 1: màu bù xén không được kéo từ xa hơn _TRAJ_MAX_REACH_FACTOR×amount.

    Trước bản vá, hoa văn tỏa thật cho tầm với 1.11-1.25× bề rộng dải (dải 35px mà
    dịch tới ±63px) → dải lấy màu của vùng khác hẳn, nhìn như bị xé đoạn.
    """
    from app.workers.sticker_engine import _TRAJ_MAX_REACH_FACTOR

    h, w = 240, 120
    img = _sunburst(h, w, cx=-40.0, cy=110.0, nrays=24)
    amount = 30
    disp = _disp_field(img, amount)
    reach = float(np.abs(disp).max()) / amount
    assert reach <= _TRAJ_MAX_REACH_FACTOR + 0.05, (
        f"tầm với {reach:.2f}× vượt trần {_TRAJ_MAX_REACH_FACTOR}×"
    )


def test_trajectory_field_is_continuous():
    """BX-07 điểm 2/3: trường dịch phải LIỀN — không gãy khúc lớn giữa 2 hàng kề.

    Đo trên file thật trước bản vá: gãy 19px/hàng và đổi dấu 7-26 lần → quỹ đạo xé
    thành từng đoạn lệch nhau. Sau bản vá gãy còn ~1-2px.
    """
    h, w = 240, 160
    img = _sunburst(h, w, cx=-50.0, cy=115.0, nrays=20)
    disp = _disp_field(img, amount=30)
    max_jump = float(np.abs(np.diff(disp)).max())
    assert max_jump < 6.0, f"trường dịch gãy khúc {max_jump:.1f}px giữa 2 hàng kề"


def _oriented_stripes(h: int, w: int, slope: float, period: float = 22.0):
    """Sọc nhiều vùng cùng MỘT hướng đã biết trước — ground truth độ dốc = ``slope``.

    Sọc theo hướng (1, s) ⇒ isophote là ``y − s·x = const`` ⇒ dy/dx = s. Nhờ vậy so
    được độ dốc engine áp lên dải bù xén với con số đúng, thay vì chỉ so dấu.
    """
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    wave = np.sin(2.0 * np.pi * (yy - slope * xx) / period)
    v = np.where(wave > 0, 210, 35).astype(np.uint8)
    img = np.stack([v, 255 - v, v // 2], axis=-1)
    return np.ascontiguousarray(img)


def _effective_slope(img: np.ndarray, amount: int) -> np.ndarray:
    """Độ dốc THỰC TẾ engine áp lên cột xa nhất của dải bù xén.

    ``map_y`` là ánh xạ NGHỊCH: ``map_y[o]`` = hàng nguồn đọc cho hàng đích ``o``. Với
    offset không đổi ``c`` thì ``forward_y = r + c`` ⇒ ``map_y[o] = o − c``, nên độ dốc
    thuận là ``−(map_y − row)/amount``.
    """
    return -_disp_field(img, amount) / float(amount)


def test_effective_slope_tracks_true_slope_magnitude():
    """BX-13: khoá ĐỘ LỚN dốc, không chỉ dấu.

    Bộ chỉ số của audit lần 1 (tầm với / số đoạn xé / gãy khúc) đều đạt điểm tối đa khi
    ``slopes ≡ 0``, nên không phân biệt "bám nét đúng" với "không bám gì cả". Test này
    bắt đúng chỗ đó: bản trước lô A kẹp mọi dốc ≥0.8 về CÙNG một dốc hiệu dụng 0.600
    (do ``_TRAJ_MAX_REACH_FACTOR`` bị áp theo từng bước, xem BX-08), nên vừa lệch số
    vừa mất tính đơn điệu.
    """
    h, w, amount = 1200, 320, 35
    measured = []
    for true_slope in (0.2, 0.4, 0.6, 0.8, 1.0, 1.25):
        img = _oriented_stripes(h, w, true_slope)
        eff = _effective_slope(img, amount)
        # Trung vị: bỏ ảnh hưởng của vài hàng biên bị kẹp left/right của np.interp.
        measured.append(float(np.median(eff)))

    # 1) Đơn điệu: hoa văn dốc hơn phải cho dải bù xén dốc hơn. Bản cũ ra 0.6/0.6/0.6.
    for i in range(1, len(measured)):
        assert measured[i] > measured[i - 1] + 0.02, (
            f"mất tính đơn điệu tại bậc {i}: {measured}"
        )

    # 2) Độ lớn: dốc thật 1.25 phải ra ≳0.85 (đo được 1.16). Bản cũ kẹp cứng 0.600 nên
    #    ngưỡng này là ranh giới phát hiện hồi quy kiểu "làm phẳng để lấy điểm trơn".
    assert measured[-1] >= 0.85, f"dốc hiệu dụng bị làm phẳng còn {measured[-1]:.3f}"


def test_trajectory_has_no_elbow_along_strip():
    """BX-09: quỹ đạo phải THẲNG suốt dải, không bẻ khuỷu rồi chạy song song mép.

    Trần tầm với từng bị clip theo từng ``step`` nên vệt màu đi đúng hướng nét một đoạn
    rồi gập ngang: đo được góc bẻ 31° và tới 48,6% bề rộng dải đi ngang ở hoa văn dốc
    1,25. Kiểm bằng cách so độ dịch ở cột giữa với đúng một nửa độ dịch ở cột xa nhất —
    quỹ đạo thẳng thì tỉ lệ này là 0,5.
    """
    import cv2

    h, w, amount = 1200, 320, 35
    img = _oriented_stripes(h, w, 1.25)

    original = cv2.remap
    captured = []

    def spy(src, map_x, map_y, **kwargs):
        captured.append(np.asarray(map_y).copy())
        return original(src, map_x, map_y, **kwargs)

    cv2.remap = spy
    try:
        _trajectory_right_strip(img, amount, PX_PER_MM)
    finally:
        cv2.remap = original

    map_y = captured[0]
    rows = np.arange(h, dtype=np.float32)[:, None]
    disp = map_y - rows
    mid = amount // 2
    # Chỉ xét các hàng thực sự có dịch chuyển đáng kể (bỏ hàng gần như đứng yên).
    moving = np.abs(disp[:, -1]) > 2.0
    assert moving.any(), "hoa văn dốc 1.25 mà không hàng nào dịch — hướng bị giết"
    ratio = disp[moving, mid] / disp[moving, -1]
    # Thẳng ⇒ ratio ≈ mid/amount. Có khuỷu ⇒ cột giữa đã chạm trần nên ratio → 1.
    expected = (mid + 1) / float(amount)
    assert abs(float(np.median(ratio)) - expected) < 0.08, (
        f"quỹ đạo bẻ khuỷu: tỉ lệ dịch giữa/xa = {float(np.median(ratio)):.3f}, "
        f"kỳ vọng {expected:.3f}"
    )


def test_extend_axis_pads_total_width():
    """_trajectory_extend_axis nở cả 2 đầu trục x đúng tổng chiều rộng."""
    img = _solid(30, 50, (100, 100, 100))
    out = _trajectory_extend_axis(img, before=10, after=15, px_per_mm=PX_PER_MM)
    assert out.shape == (30, 50 + 10 + 15, 3)
    # Phần lõi giữa giữ nguyên artwork gốc.
    assert np.array_equal(out[:, 10:10 + 50], img)


def test_extend_axis_zero_pads_identity():
    img = _solid(25, 25, (5, 6, 7))
    out = _trajectory_extend_axis(img, before=0, after=0, px_per_mm=PX_PER_MM)
    assert np.array_equal(out, img)


def test_rectangle_smooth_fill_pads_and_preserves_core():
    """Nở đúng 4 pad và GIỮ NGUYÊN lõi artwork tại vị trí (top, left)."""
    h, w = 50, 60
    img = _solid(h, w, (12, 200, 90))
    pad = 12
    out = _rectangle_smooth_color_fill(
        img, pad_px=pad, edge_bite_px=0, px_per_mm=PX_PER_MM
    )
    assert out.shape == (h + 2 * pad, w + 2 * pad, 3)
    # Lõi (không bite) phải trùng khít artwork gốc.
    core = out[pad:pad + h, pad:pad + w]
    assert np.array_equal(core, img)


def test_rectangle_smooth_fill_uneven_pads():
    """pads KHÔNG đều (chỉ vài cạnh) — kích thước và vị trí lõi đúng."""
    h, w = 40, 40
    img = _solid(h, w, (200, 200, 10))
    # (trái, phải, dưới, trên)
    pads = (10, 0, 5, 20)
    out = _rectangle_smooth_color_fill(
        img, pad_px=0, edge_bite_px=0, px_per_mm=PX_PER_MM, pads=pads
    )
    pl, pr, pb, pt = pads
    assert out.shape == (h + pb + pt, w + pl + pr, 3)
    core = out[pt:pt + h, pl:pl + w]
    assert np.array_equal(core, img)


def test_rectangle_smooth_fill_empty_input_safe():
    """Ảnh rỗng/không hợp lệ → trả về nguyên trạng, không raise."""
    assert _rectangle_smooth_color_fill(None, 5, 0, PX_PER_MM) is None
    empty = np.empty((0, 0, 3), dtype=np.uint8)
    out = _rectangle_smooth_color_fill(empty, 5, 0, PX_PER_MM)
    assert out.shape == (0, 0, 3)
