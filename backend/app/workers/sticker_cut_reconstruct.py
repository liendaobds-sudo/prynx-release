"""
Reconstruct đường cắt hình học chuẩn (tròn/elip/CN/tam giác) từ contour raster.

Chính sách mặc định `auto_safe`:
  - Chỉ thay contour khi biên KHỚP chặt mẫu hình học (residual mm + không lõm sâu).
  - Tem tròn khuyết mảnh / tai / notch → REJECT → giữ contour.

Modes:
  auto_safe | contour | force_circle | force_ellipse | force_rect | force_triangle
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, List, Optional, Sequence, Tuple

import numpy as np

try:
    import cv2
except ImportError:  # pragma: no cover
    cv2 = None  # type: ignore

PT_PER_MM = 72.0 / 25.4

SHAPE_MODES = (
    "auto_safe",
    "contour",
    "force_circle",
    "force_ellipse",
    "force_rect",
    "force_triangle",
)

# Ngưỡng auto_safe (mm trên trang PDF — độc lập DPI)
AUTO_MAX_RESIDUAL_MM = 0.35
AUTO_MAX_DEFECT_MM = 0.45
AUTO_AREA_RATIO_MIN = 0.96
AUTO_AREA_RATIO_MAX = 1.04
AUTO_ELLIPSE_ASPECT_MAX = 1.35  # a/b — lớn hơn → elip rõ; nhỏ hơn + residual thấp → circle

# Rounded-rect (CN bo góc — hình tem nhãn phổ biến nhất)
# r tối thiểu để coi là "bo góc thật" (dưới ngưỡng → coi vuông, để try_rect lo).
ROUNDED_MIN_RADIUS_MM = 1.0
# r tối đa theo tỉ lệ nửa cạnh ngắn. Không cần quá chặt: hình tròn thật đã được
# try_ellipse_or_circle chặn TRƯỚC trong chuỗi auto_safe, nên bo góc lớn (kể cả
# dạng viên thuốc r≈nửa cạnh ngắn) vẫn là rounded-rect hợp lệ, không phải tròn.
ROUNDED_MAX_RADIUS_FRAC = 0.85
# 4 góc phải nhất quán: độ lệch r cho phép giữa các góc (mm) — được kiểm gián tiếp
# qua residual toàn cục (candidate bo đều 4 góc; góc lệch → residual cao → reject).

# Noise-floor: contour raster có răng cưa sàn ~1.5px. Ở DPI thấp, tròn thật có thể
# vượt ngưỡng residual chỉ vì răng cưa → bị từ chối oan. τ_hiệu_dụng nới theo px_per_mm.
NOISE_FLOOR_PX = 1.5

# QUALITY (audit 2026-08-07 §BG.7) — ngưỡng residual/defect theo TỈ LỆ kích thước tem.
# Lỗi cũ: hai ngưỡng trên là mm TUYỆT ĐỐI, nên tem càng lớn càng chắc chắn trượt.
# Đo thật trên tem tròn 800mm (file khách): residual = 0.637mm > 0.35 → auto_safe từ
# chối → giữ contour raster thô → đường cắt gợn sóng "sợi mì tôm". Cùng độ lệch đó chỉ
# là 0.08% cạnh tem — tròn hơn cả dung sai bế.
# Ma trận đo (7 hình × 3 cỡ 50/200/800mm, residual tính theo % cạnh tem):
#   tròn/elip      0.025 – 0.172 %      ← phải NHẬN
#   bát giác       0.908 – 2.346 %      ← phải TỪ CHỐI (gần nhất, biên 2.6×)
#   squircle/rrect 1.867 – 10.860 %     ← phải TỪ CHỐI
# Chọn 0.35 % nằm giữa hai nhóm. Lấy max() với hằng số mm cũ nên tem nhỏ (≤100mm)
# giữ NGUYÊN hành vi cũ — chỉ tem lớn mới được nới.
AUTO_RESIDUAL_SIZE_FRAC = 0.0035
AUTO_DEFECT_SIZE_FRAC = 0.0045

# QUALITY (audit 2026-08-07 §BG.8) — ĐÃ BỎ cổng circularity khỏi nhánh nhận tự động.
# Cổng cũ (circ < AUTO_MIN_CIRCULARITY = 0.90 → từ chối) mang hai thiên lệch cộng dồn:
#   1. Elip dẹt có circ thấp BẨM SINH (elip 0.35 → circ ~0.69) dù tròn trịa hoàn hảo.
#   2. Chu vi = tổng đoạn qua MỌI điểm contour, nên răng cưa raster thổi phồng chu vi
#      ⇒ circ tụt theo kích thước tem. Đo thật cùng một elip 0.7: circ = 0.9534 ở tem
#      50mm nhưng chỉ 0.8019 ở tem 800mm → trượt ngưỡng 0.90 dù hình y hệt.
# Đã thử chuẩn hoá thành tỉ số circ_đo / circ_lý_thuyết(a, b) (chu vi Ramanujan) —
# vẫn vô dụng: đo 7 hình × 3 cỡ, tỉ số KHÔNG tách được nhóm tròn khỏi nhóm có góc:
#   50mm : tròn 0.9992 vs squircle2.5 0.9907  (chồng lấn)
#   800mm: elip 0.8406 vs bát giác 0.8381    (chồng lấn)
# Chạy lại toàn ma trận khi BỎ hẳn cổng: không hình có góc nào lọt — cổng residual
# (§BG.7) đã gánh trọn việc phân loại. Giữ một cổng vô tác dụng chỉ thêm một đường
# loại nhầm tem khổ lớn, nên bỏ.


@dataclass
class ReconstructResult:
    kind: str  # circle | ellipse | rect | triangle
    coords: np.ndarray  # (N, 2) closed optional; caller may close
    params: dict
    residual_mm: float
    defect_mm: float


def normalize_shape_mode(raw: Optional[str]) -> str:
    m = (raw or "auto_safe").strip().lower().replace("-", "_")
    aliases = {
        "auto": "auto_safe",
        "safe": "auto_safe",
        "keep": "contour",
        "trace": "contour",
        "original": "contour",
        "circle": "force_circle",
        "ellipse": "force_ellipse",
        "rect": "force_rect",
        "rectangle": "force_rect",
        "triangle": "force_triangle",
    }
    m = aliases.get(m, m)
    return m if m in SHAPE_MODES else "auto_safe"


def _pts_xy(coords: Sequence[Sequence[float]]) -> np.ndarray:
    a = np.asarray(coords, dtype=np.float64)
    if a.ndim != 2 or a.shape[1] < 2:
        return np.zeros((0, 2), dtype=np.float64)
    # drop duplicate closing point
    if len(a) > 2 and np.allclose(a[0], a[-1]):
        a = a[:-1]
    return a[:, :2].copy()


def _circularity(pts: np.ndarray) -> float:
    if len(pts) < 5:
        return 0.0
    # shoelace area + perimeter
    x, y = pts[:, 0], pts[:, 1]
    area = 0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))
    d = np.sqrt(np.sum(np.diff(pts, axis=0, append=pts[:1]) ** 2, axis=1))
    peri = float(np.sum(d))
    if peri <= 1e-9:
        return 0.0
    return float(4.0 * math.pi * area / (peri * peri))


def _contour_area(pts: np.ndarray) -> float:
    if len(pts) < 3:
        return 0.0
    x, y = pts[:, 0], pts[:, 1]
    return float(0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def _max_convexity_defect_mm(pts: np.ndarray) -> float:
    """Độ sâu lõm lớn nhất (mm). 0 nếu không có / không cv2."""
    if cv2 is None or len(pts) < 5:
        return 0.0
    cnt = pts.reshape(-1, 1, 2).astype(np.float32)
    # convexityDefects cần int contour gần đúng
    cnt_i = np.round(cnt).astype(np.int32)
    hull = cv2.convexHull(cnt_i, returnPoints=False)
    if hull is None or len(hull) < 3:
        return 0.0
    try:
        defects = cv2.convexityDefects(cnt_i, hull)
    except cv2.error:
        return 0.0
    if defects is None:
        return 0.0
    # depth in 1/256 of pixel units of the int contour → our units are PDF pt
    max_depth_pt = float(np.max(defects[:, 0, 3])) / 256.0
    return max_depth_pt / PT_PER_MM


def _sample_ellipse(
    cx: float, cy: float, a: float, b: float, angle_deg: float, n: int = 96
) -> np.ndarray:
    """Sample ellipse boundary. a,b = semi-axes (half of OpenCV MA/ma). angle degrees."""
    th = np.linspace(0, 2 * math.pi, n, endpoint=False)
    ca, sa = math.cos(math.radians(angle_deg)), math.sin(math.radians(angle_deg))
    xs = a * np.cos(th)
    ys = b * np.sin(th)
    xr = xs * ca - ys * sa + cx
    yr = xs * sa + ys * ca + cy
    return np.column_stack([xr, yr])


def _ellipse_residual_mm(
    pts: np.ndarray, cx: float, cy: float, a: float, b: float, angle_deg: float
) -> float:
    """Max radial residual of points vs ellipse (approx), in mm."""
    if a < 1e-6 or b < 1e-6 or len(pts) == 0:
        return 1e9
    ca, sa = math.cos(math.radians(-angle_deg)), math.sin(math.radians(-angle_deg))
    dx, dy = pts[:, 0] - cx, pts[:, 1] - cy
    lx = dx * ca - dy * sa
    ly = dx * sa + dy * ca
    # algebraic distance on unit circle after scale
    r = np.sqrt((lx / a) ** 2 + (ly / b) ** 2)
    # residual in plane ≈ |r-1| * local radius
    local_r = np.sqrt(lx ** 2 + ly ** 2)
    residual_pt = np.abs(r - 1.0) * np.maximum(local_r, 1e-6)
    # better: distance along ray from center
    # point at same angle on ellipse:
    ang = np.arctan2(ly / b, lx / a)
    ex = a * np.cos(ang)
    ey = b * np.sin(ang)
    dist = np.sqrt((lx - ex) ** 2 + (ly - ey) ** 2)
    return float(np.max(dist)) / PT_PER_MM


def _fit_ellipse_params(pts: np.ndarray) -> Optional[Tuple[float, float, float, float, float]]:
    """Return (cx, cy, semi_a, semi_b, angle_deg) or None."""
    if cv2 is None or len(pts) < 5:
        return None
    cnt = pts.reshape(-1, 1, 2).astype(np.float32)
    try:
        (cx, cy), (ma, mb), angle = cv2.fitEllipse(cnt)
    except cv2.error:
        return None
    # OpenCV returns full axes lengths
    a, b = ma / 2.0, mb / 2.0
    if a < b:
        a, b = b, a
        angle = angle + 90.0
    if a < 1e-3 or b < 1e-3:
        return None
    return float(cx), float(cy), float(a), float(b), float(angle % 180.0)


def try_ellipse_or_circle(
    pts: np.ndarray, *, force: Optional[str] = None,
    max_residual_mm: float = AUTO_MAX_RESIDUAL_MM,
    max_defect_mm: float = AUTO_MAX_DEFECT_MM,
) -> Optional[ReconstructResult]:
    """
    force: None (auto gates) | 'circle' | 'ellipse'
    """
    pts = _pts_xy(pts)
    if len(pts) < 8:
        return None
    fit = _fit_ellipse_params(pts)
    if fit is None:
        return None
    cx, cy, a, b, angle = fit
    residual = _ellipse_residual_mm(pts, cx, cy, a, b, angle)
    defect = _max_convexity_defect_mm(pts)
    area_c = _contour_area(pts)
    area_e = math.pi * a * b
    area_ratio = area_c / area_e if area_e > 1e-9 else 0.0
    aspect = a / b if b > 1e-9 else 99.0

    if force is None:
        if residual > max_residual_mm:
            return None
        if defect > max_defect_mm:
            return None
        if not (AUTO_AREA_RATIO_MIN <= area_ratio <= AUTO_AREA_RATIO_MAX):
            return None

    # circle vs ellipse
    is_circle = aspect <= 1.08  # ~8% axis difference
    if force == "circle":
        r = (a + b) / 2.0
        coords = _sample_ellipse(cx, cy, r, r, 0.0, n=96)
        kind = "circle"
        params = {"cx": cx, "cy": cy, "r": r}
    elif force == "ellipse" or (force is None and not is_circle):
        coords = _sample_ellipse(cx, cy, a, b, angle, n=96)
        kind = "ellipse"
        params = {"cx": cx, "cy": cy, "a": a, "b": b, "angle": angle}
    else:
        r = (a + b) / 2.0
        coords = _sample_ellipse(cx, cy, r, r, 0.0, n=96)
        kind = "circle"
        params = {"cx": cx, "cy": cy, "r": r}

    return ReconstructResult(
        kind=kind,
        coords=coords,
        params=params,
        residual_mm=residual,
        defect_mm=defect,
    )


def try_rect(
    pts: np.ndarray, *, force: bool = False, max_residual_mm: float = AUTO_MAX_RESIDUAL_MM
) -> Optional[ReconstructResult]:
    pts = _pts_xy(pts)
    if len(pts) < 4 or cv2 is None:
        return None
    cnt = pts.reshape(-1, 1, 2).astype(np.float32)
    rect = cv2.minAreaRect(cnt)
    (cx, cy), (w, h), angle = rect
    if w < 1e-3 or h < 1e-3:
        return None
    box = cv2.boxPoints(rect)  # 4 corners
    # residual: max distance of contour pts to nearest edge of box
    # approximate: distance to box as polygon
    from shapely.geometry import Polygon, Point
    poly = Polygon(box)
    if not poly.is_valid or poly.area < 1e-6:
        return None
    dists = [poly.exterior.distance(Point(p[0], p[1])) for p in pts]
    # also interior points should be inside — use max of exterior distance for outside; for inside 0
    residual = float(max(dists)) / PT_PER_MM
    area_c = _contour_area(pts)
    area_r = abs(w * h)
    area_ratio = area_c / area_r if area_r > 1e-9 else 0.0
    defect = _max_convexity_defect_mm(pts)

    if not force:
        # fill ratio for rect should be high
        if area_ratio < 0.94:
            return None
        if residual > max_residual_mm:
            return None
        if defect > AUTO_MAX_DEFECT_MM * 1.2:
            return None
        # reject near-circles that also fill a square bounding box poorly classified
        if _circularity(pts) > 0.92 and abs(w - h) / max(w, h) < 0.15:
            return None

    coords = np.asarray(box, dtype=np.float64)
    return ReconstructResult(
        kind="rect",
        coords=coords,
        params={"cx": cx, "cy": cy, "w": w, "h": h, "angle": angle},
        residual_mm=residual,
        defect_mm=defect,
    )


def _rounded_box_sdf(px: np.ndarray, py: np.ndarray, W: float, H: float, r: float) -> np.ndarray:
    """Signed distance (pt) tới rounded box tâm gốc, nửa-kích thước (W,H), bán kính r.
    Công thức Inigo Quilez: q = |p| - (W,H) + r; sdf = min(max(qx,qy),0) + |max(q,0)| - r."""
    qx = np.abs(px) - W + r
    qy = np.abs(py) - H + r
    outside = np.sqrt(np.maximum(qx, 0.0) ** 2 + np.maximum(qy, 0.0) ** 2)
    inside = np.minimum(np.maximum(qx, qy), 0.0)
    return outside + inside - r


def _sample_rounded_rect(
    cx: float, cy: float, W: float, H: float, r: float, angle_deg: float, n_arc: int = 16
) -> np.ndarray:
    """Sample biên rounded-rect (local half-size W,H, bán kính r) rồi xoay về angle_deg + dời tâm."""
    bx, by = W - r, H - r  # tâm 4 cung
    pts: List[Tuple[float, float]] = []
    # 4 cung: (tâm_x, tâm_y, góc_bắt_đầu)
    corners = [
        (bx, by, 0.0),      # top-right: 0→90
        (-bx, by, 90.0),    # top-left: 90→180
        (-bx, -by, 180.0),  # bottom-left: 180→270
        (bx, -by, 270.0),   # bottom-right: 270→360
    ]
    for ccx, ccy, a0 in corners:
        for k in range(n_arc + 1):
            a = math.radians(a0 + 90.0 * k / n_arc)
            pts.append((ccx + r * math.cos(a), ccy + r * math.sin(a)))
    arr = np.asarray(pts, dtype=np.float64)
    ca, sa = math.cos(math.radians(angle_deg)), math.sin(math.radians(angle_deg))
    xr = arr[:, 0] * ca - arr[:, 1] * sa + cx
    yr = arr[:, 0] * sa + arr[:, 1] * ca + cy
    return np.column_stack([xr, yr])


def try_rounded_rect(
    pts: np.ndarray,
    *,
    force: bool = False,
    max_residual_mm: float = AUTO_MAX_RESIDUAL_MM,
) -> Optional[ReconstructResult]:
    """CN bo góc: minAreaRect → xoay về trục → fit bán kính r bằng SDF, đo residual mm.
    Gate auto: r đủ lớn để là "bo góc thật", nhưng không lớn tới mức thành tròn/viên thuốc."""
    pts = _pts_xy(pts)
    if len(pts) < 8 or cv2 is None:
        return None
    cnt = pts.reshape(-1, 1, 2).astype(np.float32)
    rect = cv2.minAreaRect(cnt)
    (cx, cy), (w, h), angle = rect
    if w < 1e-3 or h < 1e-3:
        return None
    W, H = w / 2.0, h / 2.0
    # Xoay điểm về trục chuẩn quanh tâm (khử angle).
    ca, sa = math.cos(math.radians(-angle)), math.sin(math.radians(-angle))
    dx, dy = pts[:, 0] - cx, pts[:, 1] - cy
    lx = dx * ca - dy * sa
    ly = dx * sa + dy * ca
    # Fit r: quét [0, min(W,H)] tìm r cực tiểu max|SDF|.
    r_hi = min(W, H)
    if r_hi <= 1e-6:
        return None
    best_r, best_res = 0.0, 1e18
    # coarse rồi fine quanh nghiệm
    for r_try in np.linspace(0.0, r_hi, 33):
        res = float(np.max(np.abs(_rounded_box_sdf(lx, ly, W, H, r_try))))
        if res < best_res:
            best_res, best_r = res, r_try
    lo = max(0.0, best_r - r_hi / 32.0)
    hi = min(r_hi, best_r + r_hi / 32.0)
    for r_try in np.linspace(lo, hi, 21):
        res = float(np.max(np.abs(_rounded_box_sdf(lx, ly, W, H, r_try))))
        if res < best_res:
            best_res, best_r = res, r_try
    residual = best_res / PT_PER_MM
    r_mm = best_r / PT_PER_MM
    defect = _max_convexity_defect_mm(pts)

    if not force:
        # r phải "thật" (đủ lớn) nhưng không quá lớn (→ tròn/stadium).
        if r_mm < ROUNDED_MIN_RADIUS_MM:
            return None  # gần vuông → để try_rect
        if best_r > ROUNDED_MAX_RADIUS_FRAC * min(W, H):
            return None  # quá tròn → để circle/ellipse
        if residual > max_residual_mm:
            return None
        if defect > AUTO_MAX_DEFECT_MM:
            return None  # lõm/khuyết → không phải rounded-rect trơn

    coords = _sample_rounded_rect(cx, cy, W, H, best_r, angle)
    return ReconstructResult(
        kind="rounded_rect",
        coords=coords,
        params={"cx": cx, "cy": cy, "w": w, "h": h, "angle": angle, "r": best_r},
        residual_mm=residual,
        defect_mm=defect,
    )


def try_triangle(
    pts: np.ndarray, *, force: bool = False, max_residual_mm: float = AUTO_MAX_RESIDUAL_MM
) -> Optional[ReconstructResult]:
    pts = _pts_xy(pts)
    if len(pts) < 3 or cv2 is None:
        return None
    cnt = pts.reshape(-1, 1, 2).astype(np.float32)
    peri = cv2.arcLength(cnt, True)
    if peri < 1e-6:
        return None
    approx = cv2.approxPolyDP(cnt, 0.03 * peri, True)
    if len(approx) != 3 and not force:
        return None
    if len(approx) < 3:
        return None
    if force and len(approx) != 3:
        # min area triangle not in all OpenCV builds — use convex hull top-3 extend
        hull = cv2.convexHull(cnt)
        if len(hull) < 3:
            return None
        # take 3 hull points with max area triangle (O(n^3) ok for hull size)
        hp = hull.reshape(-1, 2).astype(np.float64)
        best = None
        best_a = 0.0
        n = len(hp)
        for i in range(n):
            for j in range(i + 1, n):
                for k in range(j + 1, n):
                    tri = np.array([hp[i], hp[j], hp[k]])
                    a = _contour_area(tri)
                    if a > best_a:
                        best_a = a
                        best = tri
        if best is None:
            return None
        tri_pts = best
    else:
        tri_pts = approx.reshape(-1, 2).astype(np.float64)

    from shapely.geometry import Polygon, Point
    poly = Polygon(tri_pts)
    if not poly.is_valid or poly.area < 1e-6:
        return None
    residual = float(max(poly.exterior.distance(Point(p[0], p[1])) for p in pts)) / PT_PER_MM
    area_c = _contour_area(pts)
    area_t = abs(poly.area)
    area_ratio = area_c / area_t if area_t > 1e-9 else 0.0
    defect = _max_convexity_defect_mm(pts)

    if not force:
        if len(approx) != 3:
            return None
        if area_ratio < 0.92:
            return None
        if residual > max_residual_mm * 1.2:
            return None
        if defect > AUTO_MAX_DEFECT_MM * 1.3:
            return None

    return ReconstructResult(
        kind="triangle",
        coords=tri_pts,
        params={"vertices": tri_pts.tolist()},
        residual_mm=residual,
        defect_mm=defect,
    )


def reconstruct_cut_coords(
    contour_pts: Sequence[Sequence[float]],
    mode: str = "auto_safe",
    px_per_mm: Optional[float] = None,
) -> Tuple[Optional[np.ndarray], dict]:
    """
    Returns (coords Nx2 without forced close, meta dict).
    coords None → caller keeps original contour pipeline.

    px_per_mm: độ phân giải raster nguồn contour. Dùng nới ngưỡng residual theo
    răng cưa sàn (NOISE_FLOOR_PX) để tròn/CN-bo-góc thật ở DPI thấp không bị
    reject oan. None → dùng ngưỡng cố định (hành vi cũ).
    """
    mode = normalize_shape_mode(mode)
    meta: dict[str, Any] = {"shape_mode": mode, "reconstructed": False}
    pts = _pts_xy(contour_pts)
    if len(pts) < 5:
        return None, meta

    # τ hiệu dụng: nới theo răng cưa raster (mm/px = 1/px_per_mm).
    if px_per_mm and px_per_mm > 1e-6:
        noise_mm = NOISE_FLOOR_PX / px_per_mm
        eff_residual = max(AUTO_MAX_RESIDUAL_MM, noise_mm)
    else:
        eff_residual = AUTO_MAX_RESIDUAL_MM

    # QUALITY (audit 2026-08-07 §BG.7) — nới thêm theo KÍCH THƯỚC tem.
    # Dung sai bế là tương đối, không tuyệt đối: lệch 0.6mm trên tem 800mm (0.08%)
    # là tròn hoàn hảo, còn trên tem 50mm (1.2%) là méo. Lấy cạnh dài bbox làm cỡ.
    # max() với hằng số cũ ⇒ tem ≤100mm giữ nguyên hành vi, chỉ tem lớn được nới.
    _w = float(np.max(pts[:, 0]) - np.min(pts[:, 0]))
    _h = float(np.max(pts[:, 1]) - np.min(pts[:, 1]))
    size_mm = max(_w, _h) / PT_PER_MM
    eff_residual = max(eff_residual, size_mm * AUTO_RESIDUAL_SIZE_FRAC)
    eff_defect = max(AUTO_MAX_DEFECT_MM, size_mm * AUTO_DEFECT_SIZE_FRAC)
    meta["size_mm"] = round(size_mm, 2)

    if mode == "contour":
        meta["reason"] = "user_contour"
        return None, meta

    if mode == "force_circle":
        r = try_ellipse_or_circle(pts, force="circle")
        if r:
            meta.update(reconstructed=True, kind=r.kind, params=r.params,
                        residual_mm=r.residual_mm, defect_mm=r.defect_mm)
            return r.coords, meta
        return None, {**meta, "reason": "force_failed"}

    if mode == "force_ellipse":
        r = try_ellipse_or_circle(pts, force="ellipse")
        if r:
            meta.update(reconstructed=True, kind=r.kind, params=r.params,
                        residual_mm=r.residual_mm, defect_mm=r.defect_mm)
            return r.coords, meta
        return None, {**meta, "reason": "force_failed"}

    if mode == "force_rect":
        r = try_rect(pts, force=True)
        if r:
            meta.update(reconstructed=True, kind=r.kind, params=r.params,
                        residual_mm=r.residual_mm, defect_mm=r.defect_mm)
            return r.coords, meta
        return None, {**meta, "reason": "force_failed"}

    if mode == "force_triangle":
        r = try_triangle(pts, force=True)
        if r:
            meta.update(reconstructed=True, kind=r.kind, params=r.params,
                        residual_mm=r.residual_mm, defect_mm=r.defect_mm)
            return r.coords, meta
        return None, {**meta, "reason": "force_failed"}

    # auto_safe: circle/ellipse → rounded-rect → rect vuông → triangle.
    # rounded-rect PHẢI thử trước rect vuông: CN bo góc là ca đặc biệt hơn,
    # để try_rect chạy trước sẽ nuốt nó thành CN nhọn (mất bo góc).
    for attempt in (
        lambda: try_ellipse_or_circle(
            pts, force=None, max_residual_mm=eff_residual, max_defect_mm=eff_defect
        ),
        lambda: try_rounded_rect(pts, force=False, max_residual_mm=eff_residual),
        lambda: try_rect(pts, force=False, max_residual_mm=eff_residual),
        lambda: try_triangle(pts, force=False, max_residual_mm=eff_residual),
    ):
        r = attempt()
        if r is not None:
            meta.update(
                reconstructed=True,
                kind=r.kind,
                params=r.params,
                residual_mm=r.residual_mm,
                defect_mm=r.defect_mm,
                reason="auto_safe_accept",
            )
            return r.coords, meta

    meta["reason"] = "auto_safe_reject"
    return None, meta


def coords_to_shapely_polygon(coords: np.ndarray):
    """Build valid Shapely Polygon from open ring coords."""
    from shapely.geometry import Polygon
    if coords is None or len(coords) < 3:
        return None
    ring = np.vstack([coords, coords[:1]])
    poly = Polygon(ring)
    if not poly.is_valid:
        poly = poly.buffer(0)
    if poly.is_empty:
        return None
    if poly.geom_type == "MultiPolygon":
        poly = max(poly.geoms, key=lambda g: g.area)
    return poly
