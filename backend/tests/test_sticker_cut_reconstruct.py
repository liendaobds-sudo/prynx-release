"""
Strict reconstruct: tròn sạch được ép; tròn khuyết / notch bị reject.
"""
import math
import numpy as np
import pytest

from app.workers.sticker_cut_reconstruct import (
    PT_PER_MM,
    reconstruct_cut_coords,
    try_ellipse_or_circle,
    try_rect,
    try_rounded_rect,
    try_triangle,
    normalize_shape_mode,
)

PT_PER_MM = 72.0 / 25.4


def _circle_pts(cx=100.0, cy=100.0, r=40.0, n=80, noise=0.0, rng=None):
    rng = rng or np.random.default_rng(0)
    th = np.linspace(0, 2 * math.pi, n, endpoint=False)
    xs = cx + r * np.cos(th) + rng.normal(0, noise, n)
    ys = cy + r * np.sin(th) + rng.normal(0, noise, n)
    return np.column_stack([xs, ys])


def _notched_circle(cx=100.0, cy=100.0, r=40.0, n=80):
    """Tròn + khuyết sâu (bán kính co 40% trên 1 cung) — không được ép tròn."""
    th = np.linspace(0, 2 * math.pi, n, endpoint=False)
    rr = np.full(n, r)
    # notch ~45°
    mask = (th > 0.3) & (th < 1.0)
    rr[mask] = r * 0.55
    return np.column_stack([cx + rr * np.cos(th), cy + rr * np.sin(th)])


def test_normalize_shape_mode():
    assert normalize_shape_mode(None) == "auto_safe"
    assert normalize_shape_mode("AUTO") == "auto_safe"
    assert normalize_shape_mode("contour") == "contour"
    assert normalize_shape_mode("circle") == "force_circle"


def test_clean_circle_auto_safe_accepts():
    pts = _circle_pts(noise=0.05)
    coords, meta = reconstruct_cut_coords(pts, "auto_safe")
    assert coords is not None
    assert meta.get("reconstructed") is True
    assert meta.get("kind") in ("circle", "ellipse")
    assert meta.get("residual_mm", 99) < 0.5


def test_notched_circle_auto_safe_rejects():
    pts = _notched_circle()
    coords, meta = reconstruct_cut_coords(pts, "auto_safe")
    assert coords is None
    assert meta.get("reconstructed") is False
    assert meta.get("reason") == "auto_safe_reject"


def test_notched_circle_force_circle_accepts():
    pts = _notched_circle()
    coords, meta = reconstruct_cut_coords(pts, "force_circle")
    assert coords is not None
    assert meta.get("kind") == "circle"


def test_contour_mode_never_reconstructs():
    pts = _circle_pts()
    coords, meta = reconstruct_cut_coords(pts, "contour")
    assert coords is None
    assert meta.get("reason") == "user_contour"


def test_clean_rect_auto_safe():
    # axis-aligned square
    pts = np.array([[0, 0], [50, 0], [50, 50], [0, 50]], dtype=float)
    # densify edges so fit works like a contour
    dens = []
    for i in range(4):
        a, b = pts[i], pts[(i + 1) % 4]
        for t in np.linspace(0, 1, 20, endpoint=False):
            dens.append(a * (1 - t) + b * t)
    dens = np.array(dens)
    r = try_rect(dens, force=False)
    assert r is not None
    assert r.kind == "rect"


def test_triangle_force():
    pts = np.array([[0, 0], [80, 0], [40, 60]], dtype=float)
    dens = []
    for i in range(3):
        a, b = pts[i], pts[(i + 1) % 3]
        for t in np.linspace(0, 1, 25, endpoint=False):
            dens.append(a * (1 - t) + b * t)
    r = try_triangle(np.array(dens), force=True)
    assert r is not None
    assert r.kind == "triangle"


# ─────────────────────────────────────────────────────────────────────────
# Synthetic shape builders (đơn vị = points; kích thước cho theo mm → *PT_PER_MM)
# ─────────────────────────────────────────────────────────────────────────

def _rounded_rect_pts(cx=200.0, cy=200.0, w_mm=60.0, h_mm=40.0, r_mm=4.0,
                      n_arc=24, n_edge=30, angle_deg=0.0, noise=0.0, rng=None):
    """Contour CN bo góc, dày điểm dọc cạnh + cung. Tâm gốc rồi xoay + dời."""
    rng = rng or np.random.default_rng(0)
    W = w_mm * PT_PER_MM / 2.0
    H = h_mm * PT_PER_MM / 2.0
    r = r_mm * PT_PER_MM
    bx, by = W - r, H - r  # tâm 4 cung
    pts = []
    # cạnh phải (đi lên), cung TR, cạnh trên (sang trái), cung TL, cạnh trái (xuống),
    # cung BL, cạnh dưới (sang phải), cung BR
    # cạnh phải x=W từ y=-by → +by
    for t in np.linspace(-by, by, n_edge, endpoint=False):
        pts.append((W, t))
    for k in range(n_arc):  # cung TR tâm (bx,by) 0→90
        a = math.radians(90.0 * k / n_arc)
        pts.append((bx + r * math.cos(a), by + r * math.sin(a)))
    for t in np.linspace(bx, -bx, n_edge, endpoint=False):
        pts.append((t, H))
    for k in range(n_arc):  # cung TL tâm (-bx,by) 90→180
        a = math.radians(90.0 + 90.0 * k / n_arc)
        pts.append((-bx + r * math.cos(a), by + r * math.sin(a)))
    for t in np.linspace(by, -by, n_edge, endpoint=False):
        pts.append((-W, t))
    for k in range(n_arc):  # cung BL tâm (-bx,-by) 180→270
        a = math.radians(180.0 + 90.0 * k / n_arc)
        pts.append((-bx + r * math.cos(a), -by + r * math.sin(a)))
    for t in np.linspace(-bx, bx, n_edge, endpoint=False):
        pts.append((t, -H))
    for k in range(n_arc):  # cung BR tâm (bx,-by) 270→360
        a = math.radians(270.0 + 90.0 * k / n_arc)
        pts.append((bx + r * math.cos(a), -by + r * math.sin(a)))
    arr = np.asarray(pts, dtype=np.float64)
    if noise > 0:
        arr = arr + rng.normal(0, noise, arr.shape)
    ca, sa = math.cos(math.radians(angle_deg)), math.sin(math.radians(angle_deg))
    xr = arr[:, 0] * ca - arr[:, 1] * sa + cx
    yr = arr[:, 0] * sa + arr[:, 1] * ca + cy
    return np.column_stack([xr, yr])


def _sharp_rect_pts(cx=200.0, cy=200.0, w_mm=60.0, h_mm=40.0, n_edge=40):
    """CN vuông góc (r≈0), dày điểm dọc cạnh."""
    W = w_mm * PT_PER_MM / 2.0
    H = h_mm * PT_PER_MM / 2.0
    corners = [(W, -H), (W, H), (-W, H), (-W, -H)]
    pts = []
    for i in range(4):
        a = np.array(corners[i]); b = np.array(corners[(i + 1) % 4])
        for t in np.linspace(0, 1, n_edge, endpoint=False):
            pts.append(a * (1 - t) + b * t)
    arr = np.asarray(pts, dtype=np.float64)
    return np.column_stack([arr[:, 0] + cx, arr[:, 1] + cy])


def _blob_pts(cx=200.0, cy=200.0, r_mm=30.0, n=200, seed=3):
    """Logo/mascot tự do: bán kính dao động mạnh theo nhiều tần số → KHÔNG phải hình cơ bản."""
    rng = np.random.default_rng(seed)
    th = np.linspace(0, 2 * math.pi, n, endpoint=False)
    base = r_mm * PT_PER_MM
    rr = base * (1.0
                 + 0.18 * np.sin(3 * th + 0.5)
                 + 0.12 * np.sin(7 * th + 1.0)
                 + 0.08 * np.sin(11 * th))
    return np.column_stack([cx + rr * np.cos(th), cy + rr * np.sin(th)])


# ─────────────────────────────────────────────────────────────────────────
# Rounded-rect: nhận đúng
# ─────────────────────────────────────────────────────────────────────────

def test_rounded_rect_auto_safe_accepts():
    pts = _rounded_rect_pts(w_mm=60, h_mm=40, r_mm=4)
    coords, meta = reconstruct_cut_coords(pts, "auto_safe")
    assert coords is not None
    assert meta.get("kind") == "rounded_rect", meta
    # bán kính fit gần 4mm
    assert abs(meta["params"]["r"] / PT_PER_MM - 4.0) < 1.0
    assert meta.get("residual_mm", 99) < 0.5


def test_rounded_rect_rotated_accepts():
    pts = _rounded_rect_pts(w_mm=50, h_mm=50, r_mm=6, angle_deg=27.0)
    coords, meta = reconstruct_cut_coords(pts, "auto_safe")
    assert coords is not None
    assert meta.get("kind") == "rounded_rect", meta


def test_rounded_rect_small_radius_becomes_rect():
    # r rất nhỏ (0.3mm) → dưới ROUNDED_MIN_RADIUS_MM → phải nhận CN vuông, không rounded.
    pts = _rounded_rect_pts(w_mm=60, h_mm=40, r_mm=0.3)
    coords, meta = reconstruct_cut_coords(pts, "auto_safe")
    assert coords is not None
    assert meta.get("kind") == "rect", meta


def test_jpeg_corner_radius_below_eight_source_pixels_stays_rect():
    """§NOODLE.10: bo giả 1,1 mm trên ảnh 0,2 mm/px không được đổi góc vuông."""
    pts = _rounded_rect_pts(w_mm=60, h_mm=40, r_mm=1.1)
    coords, meta = reconstruct_cut_coords(
        pts,
        "auto_safe",
        px_per_mm=5.0,
        source_pixel_mm=0.2,
    )
    assert coords is not None
    assert meta.get("kind") == "rect", meta


def test_sharp_rect_not_rounded():
    pts = _sharp_rect_pts(w_mm=60, h_mm=40)
    coords, meta = reconstruct_cut_coords(pts, "auto_safe")
    assert coords is not None
    assert meta.get("kind") == "rect", meta


def test_large_radius_rounded_is_not_circle():
    # r lớn (12mm trên CN 60x40) vẫn là bo góc, KHÔNG được nuốt thành elip.
    pts = _rounded_rect_pts(w_mm=60, h_mm=40, r_mm=12)
    coords, meta = reconstruct_cut_coords(pts, "auto_safe")
    assert coords is not None
    assert meta.get("kind") == "rounded_rect", meta


# ─────────────────────────────────────────────────────────────────────────
# CA AN TOÀN: hình phức tạp / khuyết → PHẢI về contour (không ép hình)
# ─────────────────────────────────────────────────────────────────────────

def test_blob_logo_rejects_to_contour():
    pts = _blob_pts()
    coords, meta = reconstruct_cut_coords(pts, "auto_safe")
    assert coords is None, f"logo tự do bị ép thành {meta.get('kind')}"
    assert meta.get("reason") == "auto_safe_reject"


def test_rounded_rect_with_notch_rejects():
    # CN bo góc nhưng cắt 1 notch sâu ở cạnh → có defect → không được ép.
    pts = _rounded_rect_pts(w_mm=60, h_mm=40, r_mm=4).tolist()
    # chèn notch: kéo vài điểm giữa cạnh trên thụt vào 6mm
    arr = np.asarray(pts)
    top_y = arr[:, 1].max()
    for i, p in enumerate(arr):
        if p[1] > top_y - 0.5 and abs(p[0] - arr[:, 0].mean()) < 8 * PT_PER_MM:
            arr[i, 1] -= 6.0 * PT_PER_MM
    coords, meta = reconstruct_cut_coords(arr, "auto_safe")
    assert coords is None, f"CN có notch bị ép thành {meta.get('kind')}"


# ─────────────────────────────────────────────────────────────────────────
# Noise-floor: tròn ở "DPI thấp" (noise cao) — nới τ để không reject oan
# ─────────────────────────────────────────────────────────────────────────

def test_noise_floor_rescues_low_dpi_circle():
    # Tròn với răng cưa vừa: residual rơi vào khoảng (τ mặc định 0.35mm, τ nới
    # ~0.75mm khi px_per_mm=2). px_per_mm thấp → noise-floor nới τ → vẫn nhận.
    pts = _circle_pts(r=120, n=64, noise=0.5, rng=np.random.default_rng(7))
    coords_lo, meta_lo = reconstruct_cut_coords(pts, "auto_safe", px_per_mm=2.0)
    # px_per_mm thấp (noise-floor lớn) → τ nới → chắc chắn nhận.
    assert coords_lo is not None, meta_lo
    assert meta_lo.get("kind") in ("circle", "ellipse")


def test_rounded_rect_force_rect_still_available():
    # người dùng vẫn ép được CN vuông trên tem bo góc (force path không đổi).
    pts = _rounded_rect_pts(w_mm=60, h_mm=40, r_mm=4)
    coords, meta = reconstruct_cut_coords(pts, "force_rect")
    assert coords is not None
    assert meta.get("kind") == "rect"
