"""Đo ĐỘ TRUNG THỰC của quỹ đạo bù xén (audit bù xén lần 2, 2026-07-30).

Khác `measure_bleed_trajectory.py`: script cũ chỉ đo ĐỘ TRƠN (số lần đổi dấu, gãy
khúc, tầm với). Ba chỉ số đó đều đạt ĐIỂM TỐI ĐA khi quỹ đạo bị làm phẳng hoàn toàn
(slopes ≡ 0 → reach 0, flips 0, jump 0), nên chúng KHÔNG phân biệt được "bám nét
đúng" với "không bám gì cả". Script này đo phần còn thiếu:

* ``slope_err`` — sai số giữa độ dốc THỰC TẾ engine áp lên dải bù xén và độ dốc
  GROUND TRUTH của hoa văn tổng hợp (biết trước bằng toán). Đây là chỉ số "bám nét".
* ``contam_rows`` — số hàng bị NHIỄM hướng của vùng hoa văn lân cận quanh mỗi ranh
  giới đổi hướng. Đây chính là "loang": màu của vùng A bị kéo vào dải bù xén của
  vùng B vì hướng đã bị làm trơn xuyên qua ranh giới.
* ``jac_min/jac_max`` — đạo hàm của ánh xạ nghịch dọc mép (d map_y / d row) ở cột
  XA nhất. =1 là lý tưởng. <<1 = nhiều hàng nguồn bị NÉN vào ít hàng đích (nếp gấp
  = "gãy khúc"); >>1 = một hàng nguồn bị KÉO DÃN ra nhiều hàng đích (vệt mờ/loang).
* ``clip_frac`` — tỉ lệ hàng bị chặn cứng bởi ``_TRAJ_MAX_REACH_FACTOR``. Hàng đã
  chặn thì mọi hướng khác nhau đều thành CÙNG một offset → tạo cao nguyên và nếp
  gấp ở ranh giới chặn.

Chạy:
    venv\\Scripts\\python scripts\\measure_bleed_fidelity.py            # quét theo chiều dài mép
    venv\\Scripts\\python scripts\\measure_bleed_fidelity.py <pdf> [mm] # file thật
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


def capture_map(img: np.ndarray, amount: int, px_per_mm: float = PX_PER_MM) -> np.ndarray:
    """Bắt ánh xạ nghịch (map_y) mà engine đưa vào cv2.remap. Trả (h, amount)."""
    original = cv2.remap
    captured: list = []

    def spy(src, map_x, map_y, **kwargs):
        captured.append(np.asarray(map_y).copy())
        return original(src, map_x, map_y, **kwargs)

    cv2.remap = spy
    try:
        se._trajectory_right_strip(np.ascontiguousarray(img), amount, px_per_mm)
    finally:
        cv2.remap = original
    if not captured:
        return np.zeros((img.shape[0], max(1, amount)), dtype=np.float32)
    return captured[0]


def effective_slopes(map_y: np.ndarray) -> np.ndarray:
    """Độ dốc THỰC TẾ áp lên cột xa nhất.

    ``map_y`` là ánh xạ NGHỊCH: map_y[o] = hàng nguồn được đọc cho hàng đích o.
    Với offset không đổi c thì forward_y = r + c ⇒ map_y[o] = o − c. Vì vậy độ dốc
    thuận = −(map_y − row)/step (script cũ bỏ qua dấu trừ này).
    """
    h, amount = map_y.shape
    rows = np.arange(h, dtype=np.float32)[:, None]
    return -(map_y[:, -1] - rows[:, 0]) / float(amount)


def chevron(h: int, w: int, block_slopes, period: float = 22.0):
    """Hoa văn sọc nhiều VÙNG, mỗi vùng một hướng đã biết trước.

    Sọc theo hướng (1, s) ⇒ isophote là đường ``y − s·x = const`` ⇒ dy/dx = s.
    Ground truth độ dốc theo hàng vì thế là hằng trong mỗi vùng — mô phỏng file
    thật có nhiều mảng hoa văn khác hướng nằm cạnh nhau (đây là ca sinh "loang").
    """
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    img = np.zeros((h, w, 3), dtype=np.uint8)
    gt = np.zeros(h, dtype=np.float32)
    bounds = np.linspace(0, h, len(block_slopes) + 1).astype(int)
    for i, s in enumerate(block_slopes):
        r0, r1 = int(bounds[i]), int(bounds[i + 1])
        wave = np.sin(2.0 * np.pi * (yy[r0:r1] - s * xx[r0:r1]) / period)
        v = np.where(wave > 0, 210, 35).astype(np.uint8)
        img[r0:r1, :, 0] = v
        img[r0:r1, :, 1] = 255 - v
        img[r0:r1, :, 2] = v // 2
        gt[r0:r1] = s
    return img, gt, bounds


def metrics(img: np.ndarray, gt: np.ndarray, bounds, amount: int) -> dict:
    map_y = capture_map(img, amount)
    slope_eff = effective_slopes(map_y)
    err = np.abs(slope_eff - gt)

    # Nội vùng = bỏ dải ±8% chiều cao quanh mỗi ranh giới, để tách "sai số nội vùng"
    # khỏi "nhiễm chéo ranh giới".
    h = img.shape[0]
    guard = max(3, int(0.08 * h))
    interior = np.ones(h, dtype=bool)
    for b in bounds[1:-1]:
        interior[max(0, b - guard):min(h, b + guard)] = False

    # Nhiễm chéo: hàng nằm trong vùng có gt = s nhưng độ dốc thực tế lệch >30% biên
    # độ hướng của hoa văn ⇒ đang bị kéo theo hướng của vùng bên cạnh.
    span = float(np.abs(gt).max() * 2.0) or 1.0
    contaminated = err > 0.30 * span

    col = map_y[:, -1]
    jac = np.diff(col)

    reach = np.abs(col - np.arange(h, dtype=np.float32))
    max_reach = se._TRAJ_MAX_REACH_FACTOR * float(amount)
    return {
        "sigma": _sigma_for(h, amount),
        "err_interior": float(np.median(err[interior])) if interior.any() else float("nan"),
        "err_p90": float(np.percentile(err, 90)),
        "contam_rows": int(np.count_nonzero(contaminated)),
        "contam_pct": 100.0 * np.count_nonzero(contaminated) / h,
        "jac_min": float(jac.min()) if jac.size else 1.0,
        "jac_max": float(jac.max()) if jac.size else 1.0,
        "clip_frac": float(np.count_nonzero(reach >= max_reach - 0.51) / h),
    }


def _sigma_for(h: int, amount: int) -> float:
    """Nhân bản đúng công thức sigma trong engine để in ra cùng bảng."""
    return max(
        0.8,
        min(
            se._TRAJ_SMOOTH_MAX_SIGMA,
            max(
                0.18 * max(0.1, PX_PER_MM),
                se._TRAJ_SMOOTH_PER_AMOUNT * amount,
                se._TRAJ_SMOOTH_PER_EDGE * h,
            ),
        ),
    )


def sweep() -> None:
    """Quét theo CHIỀU DÀI MÉP — chỗ công thức sigma phụ thuộc h và bị chặn trần."""
    amount = int(round(3.0 * PX_PER_MM))  # bù xén 3mm @300DPI = 35px
    w = 320
    print(f"hoa văn tổng hợp 3 vùng (dốc +0.8 / −0.8 / +0.8), bù xén 3mm = {amount}px")
    print(f"{'mép(px)':>9}{'sigma':>8}{'err nội vùng':>14}{'err p90':>9}"
          f"{'nhiễm(hàng)':>13}{'nhiễm%':>8}{'jac min':>9}{'jac max':>9}{'clip%':>7}")
    for h in (240, 480, 960, 1920, 2480, 3508, 4960):
        img, gt, bounds = chevron(h, w, (0.8, -0.8, 0.8))
        m = metrics(img, gt, bounds, amount)
        print(f"{h:>9}{m['sigma']:>8.1f}{m['err_interior']:>14.3f}{m['err_p90']:>9.3f}"
              f"{m['contam_rows']:>13}{m['contam_pct']:>7.1f}%"
              f"{m['jac_min']:>9.2f}{m['jac_max']:>9.2f}{100*m['clip_frac']:>6.1f}%")


def real_file(pdf: str, bleed_mm: float) -> None:
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(pdf)
    page = doc[0]
    bitmap = page.render(scale=DPI / 72.0)
    img = np.array(bitmap.to_pil().convert("RGB"))
    bitmap.close()
    page.close()
    doc.close()
    amount = int(round(bleed_mm * PX_PER_MM))
    print(f"file={os.path.basename(pdf)} raster={img.shape[1]}x{img.shape[0]} "
          f"bleed={bleed_mm}mm amount={amount}px")
    print(f"{'mép':<8}{'sigma':>8}{'jac min':>9}{'jac max':>9}{'clip%':>8}"
          f"{'|d|max':>9}{'reach':>8}")
    edges = {
        "right": img,
        "left": np.ascontiguousarray(img[:, ::-1]),
        "top": np.ascontiguousarray(np.transpose(img, (1, 0, 2))),
        "bottom": np.ascontiguousarray(np.transpose(img, (1, 0, 2))[:, ::-1]),
    }
    for name, oriented in edges.items():
        h = oriented.shape[0]
        map_y = capture_map(oriented, amount)
        col = map_y[:, -1]
        jac = np.diff(col)
        reach = np.abs(col - np.arange(h, dtype=np.float32))
        max_reach = se._TRAJ_MAX_REACH_FACTOR * float(amount)
        clip = np.count_nonzero(reach >= max_reach - 0.51) / h
        print(f"{name:<8}{_sigma_for(h, amount):>8.1f}{jac.min():>9.2f}{jac.max():>9.2f}"
              f"{100*clip:>7.1f}%{reach.max():>9.1f}{reach.max()/amount:>8.2f}")


def main() -> None:
    if len(sys.argv) > 1:
        real_file(sys.argv[1], float(sys.argv[2]) if len(sys.argv) > 2 else 3.0)
    else:
        sweep()


if __name__ == "__main__":
    main()
