"""Chỉ số đánh giá chất lượng vector hóa logo, dùng cho cổng G1.

Nguyên tắc chọn chỉ số: **một điểm SSIM cao không được che việc sai chữ hoặc sai
hình logo** (mục 11 báo cáo khảo sát). Vì vậy bộ này luôn báo cùng lúc:

* `iou` — trùng khớp vùng tô (phát hiện mất/thừa vùng lớn);
* `boundary_f` — trùng khớp **đường biên** ở sai số cho phép, đây là chỉ số bắt
  được lỗi méo nét chữ mà IoU/SSIM bỏ qua vì phần lớn diện tích vẫn đúng;
* `delta_e` — sai màu theo CIEDE2000, chỉ có nghĩa khi có ground truth màu;
* `ssim` — sai khác tổng thể sau khi raster hóa SVG trở lại;
* `complexity` — số path/node và tỷ lệ vùng vụn, tức "còn chỉnh tay được không".

Mọi chỉ số dựa trên ảnh RGBA đã render cùng kích thước. Không so JSON trung gian:
golden phải so artifact render thật.

Self-test:

    backend\\venv\\Scripts\\python.exe tools\\logo_rebuild_spike\\metrics.py --self-test
"""

from __future__ import annotations

import math
import sys
from dataclasses import dataclass, asdict, field

import numpy as np
from PIL import Image

# Sai số biên mặc định: 0,75% đường chéo ảnh — quy ước của benchmark phân vùng
# (DAVIS/BSDS). Dùng tỷ lệ thay vì px cố định để so được giữa các độ phân giải.
DEFAULT_BOUNDARY_TOLERANCE_RATIO = 0.0075
ALPHA_THRESHOLD = 128


@dataclass
class ComplexityReport:
    path_count: int
    node_count: int
    # Tỷ lệ path có diện tích dưới ngưỡng "vụn" — cao nghĩa là nhiều path rác.
    tiny_path_ratio: float
    tiny_path_count: int
    has_nonfinite: bool
    open_path_count: int
    svg_bytes: int = 0

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class QualityReport:
    iou: float
    boundary_f: float
    boundary_precision: float
    boundary_recall: float
    ssim: float
    delta_e_median: float | None
    delta_e_p95: float | None
    coverage_gt: float
    coverage_pred: float
    complexity: ComplexityReport | None = None
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        d = asdict(self)
        return d


# ── Mặt nạ và trùng khớp vùng ────────────────────────────────────────────────

def alpha_mask(img: Image.Image, threshold: int = ALPHA_THRESHOLD) -> np.ndarray:
    """Mặt nạ vùng có mực. Ảnh không alpha ⇒ coi pixel không-trắng là có mực."""
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    a = np.asarray(img)
    alpha = a[..., 3]
    if alpha.min() == 255:
        # Nền đục: suy mặt nạ theo độ lệch khỏi trắng.
        lum = a[..., :3].astype(np.int16).sum(axis=-1)
        return lum < (255 * 3 - 30)
    return alpha > threshold


def iou(gt: np.ndarray, pred: np.ndarray) -> float:
    union = np.logical_or(gt, pred).sum()
    if union == 0:
        return 1.0
    return float(np.logical_and(gt, pred).sum() / union)


def _boundary(mask: np.ndarray) -> np.ndarray:
    """Biên của mặt nạ: pixel thuộc mask mà có láng giềng 4 ngoài mask."""
    m = mask
    pad = np.pad(m, 1, mode="constant", constant_values=False)
    inner = (
        pad[:-2, 1:-1] & pad[2:, 1:-1] & pad[1:-1, :-2] & pad[1:-1, 2:]
    )
    return m & ~inner


def _dilate(mask: np.ndarray, radius: int) -> np.ndarray:
    """Nở mặt nạ bằng đĩa bán kính `radius`. Dùng scipy nếu có, không thì thủ công."""
    if radius <= 0:
        return mask
    try:
        from scipy.ndimage import binary_dilation

        yy, xx = np.mgrid[-radius:radius + 1, -radius:radius + 1]
        disk = (yy * yy + xx * xx) <= radius * radius
        return binary_dilation(mask, structure=disk)
    except ImportError:  # pragma: no cover - scipy đã pin trong requirements
        out = mask.copy()
        for dy in range(-radius, radius + 1):
            for dx in range(-radius, radius + 1):
                if dy * dy + dx * dx > radius * radius:
                    continue
                out |= np.roll(np.roll(mask, dy, axis=0), dx, axis=1)
        return out


def boundary_f_score(
    gt: np.ndarray, pred: np.ndarray, tolerance_px: int
) -> tuple[float, float, float]:
    """(F, precision, recall) của đường biên ở sai số `tolerance_px`."""
    gt_b = _boundary(gt)
    pred_b = _boundary(pred)
    n_gt, n_pred = int(gt_b.sum()), int(pred_b.sum())
    if n_gt == 0 and n_pred == 0:
        return 1.0, 1.0, 1.0
    if n_gt == 0 or n_pred == 0:
        return 0.0, 0.0, 0.0
    gt_dil = _dilate(gt_b, tolerance_px)
    pred_dil = _dilate(pred_b, tolerance_px)
    precision = float((pred_b & gt_dil).sum() / n_pred)
    recall = float((gt_b & pred_dil).sum() / n_gt)
    f = 0.0 if (precision + recall) == 0 else 2 * precision * recall / (precision + recall)
    return f, precision, recall


# ── Màu ──────────────────────────────────────────────────────────────────────

def delta_e_stats(
    gt: Image.Image, pred: Image.Image, mask: np.ndarray | None = None
) -> tuple[float, float]:
    """(median, p95) của ΔE00 trên vùng mask. Ảnh phải cùng kích thước."""
    from skimage.color import deltaE_ciede2000, rgb2lab

    a = np.asarray(gt.convert("RGB"), dtype=np.float64) / 255.0
    b = np.asarray(pred.convert("RGB"), dtype=np.float64) / 255.0
    lab_a, lab_b = rgb2lab(a), rgb2lab(b)
    d = deltaE_ciede2000(lab_a, lab_b)
    if mask is not None:
        d = d[mask]
    if d.size == 0:
        return 0.0, 0.0
    return float(np.median(d)), float(np.percentile(d, 95))


# ── Sai khác tổng thể ────────────────────────────────────────────────────────

def ssim_score(gt: Image.Image, pred: Image.Image) -> float:
    """SSIM trên ảnh xám đã ghép lên nền trắng (alpha cũng ảnh hưởng kết quả in)."""
    from skimage.metrics import structural_similarity

    g = _flatten_on_white(gt)
    p = _flatten_on_white(pred)
    return float(structural_similarity(g, p, data_range=255))


def _flatten_on_white(img: Image.Image) -> np.ndarray:
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
    return np.asarray(Image.alpha_composite(bg, img).convert("L"), dtype=np.float64)


# ── Độ phức tạp hình học ─────────────────────────────────────────────────────

def svg_complexity(svg_data: bytes | str, tiny_area_ratio: float = 1e-4) -> ComplexityReport:
    """Đếm path/node, phát hiện toạ độ không hữu hạn và vùng vụn.

    `tiny_area_ratio` là ngưỡng "vụn" so với diện tích viewBox. Mặc định 1e-4
    (0,01% khung) — path nhỏ hơn thế thường là hạt vải/nhiễu, không phải thiết kế.
    """
    from svg_raster import parse_svg

    raw = svg_data.encode("utf-8") if isinstance(svg_data, str) else svg_data
    doc = parse_svg(raw)
    _, _, vb_w, vb_h = doc.view_box
    frame_area = max(vb_w * vb_h, 1e-9)

    node_count = 0
    tiny = 0
    open_paths = 0
    nonfinite = False
    for subpaths, _color, _op, _eo in doc.shapes:
        area = 0.0
        for sp in subpaths:
            node_count += len(sp.segments)
            if not sp.closed:
                open_paths += 1
            pts = _flatten_subpath(sp)
            for x, y in pts:
                if not (math.isfinite(x) and math.isfinite(y)):
                    nonfinite = True
            area += abs(_shoelace(pts))
        if area / frame_area < tiny_area_ratio:
            tiny += 1

    return ComplexityReport(
        path_count=doc.path_count,
        node_count=node_count,
        tiny_path_ratio=(tiny / doc.path_count) if doc.path_count else 0.0,
        tiny_path_count=tiny,
        has_nonfinite=nonfinite,
        open_path_count=open_paths,
        svg_bytes=len(raw),
    )


def _flatten_subpath(sp, steps: int = 8) -> list[tuple[float, float]]:
    """Xấp xỉ subpath bằng đa giác để tính diện tích."""
    pts = [sp.start]
    cur = sp.start
    for seg in sp.segments:
        if seg[0] == "L":
            cur = (seg[1], seg[2])
            pts.append(cur)
        else:
            p0 = cur
            c1, c2, p3 = (seg[1], seg[2]), (seg[3], seg[4]), (seg[5], seg[6])
            for i in range(1, steps + 1):
                t = i / steps
                mt = 1 - t
                x = (mt ** 3 * p0[0] + 3 * mt * mt * t * c1[0]
                     + 3 * mt * t * t * c2[0] + t ** 3 * p3[0])
                y = (mt ** 3 * p0[1] + 3 * mt * mt * t * c1[1]
                     + 3 * mt * t * t * c2[1] + t ** 3 * p3[1])
                pts.append((x, y))
            cur = p3
    return pts


def _shoelace(pts: list[tuple[float, float]]) -> float:
    if len(pts) < 3:
        return 0.0
    s = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % len(pts)]
        if not (math.isfinite(x1) and math.isfinite(y1)
                and math.isfinite(x2) and math.isfinite(y2)):
            return 0.0
        s += x1 * y2 - x2 * y1
    return s / 2.0


# ── Sai số hiệu chỉnh phối cảnh ──────────────────────────────────────────────

def quad_error_px(
    expected: list[tuple[float, float]],
    actual: list[tuple[float, float]],
    width: int,
    height: int,
) -> float:
    """Sai số trung bình bốn góc, tính bằng px. Toạ độ vào là chuẩn hoá 0..1."""
    if len(expected) != 4 or len(actual) != 4:
        raise ValueError("Cần đúng 4 điểm cho mỗi bên")
    total = 0.0
    for (ex, ey), (ax, ay) in zip(expected, actual):
        dx = (ex - ax) * width
        dy = (ey - ay) * height
        total += math.hypot(dx, dy)
    return total / 4.0


# ── Gộp ──────────────────────────────────────────────────────────────────────

def compare_rasters(
    gt: Image.Image,
    pred: Image.Image,
    svg_data: bytes | str | None = None,
    tolerance_ratio: float = DEFAULT_BOUNDARY_TOLERANCE_RATIO,
    measure_color: bool = True,
) -> QualityReport:
    """So một cặp ảnh cùng kích thước và trả toàn bộ chỉ số."""
    if gt.size != pred.size:
        pred = pred.resize(gt.size, Image.Resampling.LANCZOS)

    gt_m = alpha_mask(gt)
    pred_m = alpha_mask(pred)
    h, w = gt_m.shape
    tol = max(1, int(round(math.hypot(w, h) * tolerance_ratio)))

    f, prec, rec = boundary_f_score(gt_m, pred_m, tol)
    warnings: list[str] = []

    de_med = de_p95 = None
    if measure_color:
        both = gt_m & pred_m
        if both.sum() < 16:
            warnings.append(
                "Vùng trùng khớp quá nhỏ để đo sai màu — bỏ qua ΔE thay vì báo số vô nghĩa"
            )
        else:
            de_med, de_p95 = delta_e_stats(gt, pred, both)

    complexity = None
    if svg_data is not None:
        complexity = svg_complexity(svg_data)
        if complexity.has_nonfinite:
            warnings.append("SVG chứa toạ độ không hữu hạn (NaN/Inf) — kết quả không dùng được")
        if complexity.tiny_path_ratio > 0.3:
            warnings.append(
                f"{complexity.tiny_path_count}/{complexity.path_count} path là vùng vụn "
                "— nhiều khả năng đang vector hóa texture, không phải thiết kế"
            )

    report = QualityReport(
        iou=iou(gt_m, pred_m),
        boundary_f=f,
        boundary_precision=prec,
        boundary_recall=rec,
        ssim=ssim_score(gt, pred),
        delta_e_median=de_med,
        delta_e_p95=de_p95,
        coverage_gt=float(gt_m.mean()),
        coverage_pred=float(pred_m.mean()),
        complexity=complexity,
        warnings=warnings,
    )
    return report


# ── Self-test ────────────────────────────────────────────────────────────────

def _self_test() -> int:
    sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
    from svg_raster import render_svg_to_png

    failures: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")
        if not ok:
            failures.append(name)

    def sq(x0, y0, x1, y1, color="#000000") -> Image.Image:
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
            f'<path d="M {x0} {y0} L {x1} {y0} L {x1} {y1} L {x0} {y1} Z" '
            f'fill="{color}"/></svg>'
        )
        return render_svg_to_png(svg, target_px=400)

    # 1) Ảnh giống hệt ⇒ mọi chỉ số hoàn hảo.
    a = sq(20, 20, 80, 80)
    r = compare_rasters(a, a)
    check("giống hệt: IoU=1", abs(r.iou - 1.0) < 1e-9, f"{r.iou:.6f}")
    check("giống hệt: boundary F=1", abs(r.boundary_f - 1.0) < 1e-9, f"{r.boundary_f:.6f}")
    check("giống hệt: SSIM=1", abs(r.ssim - 1.0) < 1e-6, f"{r.ssim:.6f}")
    check("giống hệt: ΔE≈0", r.delta_e_median is not None and r.delta_e_median < 1e-6,
          f"{r.delta_e_median}")

    # 2) IoU biết trước: hai ô vuông 60×60 lệch nhau 30 theo x ⇒ giao 30×60,
    #    hợp 2*3600-1800 ⇒ IoU = 1800/5400 = 1/3.
    #    LƯU Ý: cả hai ô phải nằm TRONG viewBox. Renderer clip theo viewBox, nên
    #    một ô tràn khung sẽ bị cắt và làm sai diện tích kỳ vọng (đã mắc một lần).
    #    Chính đặc tính clip này là lý do preflight sau phải kiểm "path ngoài canvas"
    #    trên toạ độ, không phải trên ảnh đã render.
    r2 = compare_rasters(sq(10, 20, 70, 80), sq(40, 20, 100, 80), measure_color=False)
    check("IoU biết trước = 1/3", abs(r2.iou - 1 / 3) < 0.01, f"{r2.iou:.4f}")

    # 3) Đặc tính then chốt của bộ chỉ số: khi hình bị lệch, IoU vẫn còn cao trong
    #    khi boundary F sụp. Đây chính là lớp lỗi "SSIM/IoU đẹp nhưng nét chữ sai".
    #    Lệch 4 đơn vị viewBox = 16 px ở ảnh 400 px, vượt sai số cho phép (4 px).
    #    Giao 56×56=3136, hợp 4064 ⇒ IoU = 0.7717 (số học biết trước).
    r3 = compare_rasters(sq(20, 20, 80, 80), sq(24, 24, 84, 84), measure_color=False)
    check("lệch 4/100: IoU biết trước ≈ 0.772", abs(r3.iou - 3136 / 4064) < 0.01,
          f"IoU={r3.iou:.4f}")
    check("lệch 4/100: boundary F sụp trong khi IoU còn cao",
          r3.boundary_f < 0.10 and r3.iou > 0.70,
          f"F={r3.boundary_f:.4f} vs IoU={r3.iou:.4f}")

    # 4) ΔE: đen vs trắng phải ~100; đỏ vs đỏ hơi lệch phải nhỏ nhưng > 0.
    black = Image.new("RGBA", (32, 32), (0, 0, 0, 255))
    white = Image.new("RGBA", (32, 32), (255, 255, 255, 255))
    med, _ = delta_e_stats(black, white)
    check("ΔE00 đen↔trắng ≈ 100", 95 < med < 101, f"{med:.2f}")
    red1 = Image.new("RGBA", (32, 32), (229, 57, 53, 255))
    red2 = Image.new("RGBA", (32, 32), (235, 64, 52, 255))
    med2, _ = delta_e_stats(red1, red2)
    check("ΔE00 hai sắc đỏ gần nhau trong 0<ΔE<5", 0 < med2 < 5, f"{med2:.2f}")

    # 5) ΔE phải đo được lỗi màu ở vùng nhỏ, không để nền giống nhau lấn át
    # trung vị toàn khung. Đây là lỗi đã làm preset nhị phân thắng nhóm chữ màu.
    tiny_gt = Image.new("RGB", (400, 400), (255, 255, 255))
    tiny_pred = tiny_gt.copy()
    for y in range(150, 190):
        for x in range(180, 220):
            tiny_gt.putpixel((x, y), (229, 57, 53))
            tiny_pred.putpixel((x, y), (20, 35, 70))
    tiny_mask = np.zeros((400, 400), dtype=bool)
    tiny_mask[150:190, 180:220] = True
    whole_med, _ = delta_e_stats(tiny_gt, tiny_pred)
    ink_med, _ = delta_e_stats(tiny_gt, tiny_pred, tiny_mask)
    check("ΔE vùng mực không bị nền che",
          whole_med < 1 and ink_med > 20,
          f"toàn khung={whole_med:.2f}, vùng mực={ink_med:.2f}")

    # 6) Độ phức tạp: đếm đúng path/node và bắt được path vụn.
    many = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
            '<path d="M 10 10 L 90 10 L 90 90 L 10 90 Z" fill="#000"/>'
            + "".join(
                f'<path d="M {i} 95 L {i + 0.2} 95 L {i + 0.2} 95.2 L {i} 95.2 Z" fill="#111"/>'
                for i in range(5)
            )
            + "</svg>")
    cx = svg_complexity(many)
    check("đếm path", cx.path_count == 6, f"{cx.path_count}")
    check("đếm node", cx.node_count == 18, f"{cx.node_count}")
    check("bắt path vụn", cx.tiny_path_count == 5, f"{cx.tiny_path_count}")
    check("không báo nhầm NaN", cx.has_nonfinite is False)

    # 7) Cảnh báo path vụn phải nổi lên trong báo cáo gộp.
    r6 = compare_rasters(a, a, svg_data=many, measure_color=False)
    check("cảnh báo vector hóa texture",
          any("vùng vụn" in w for w in r6.warnings), str(r6.warnings))

    # 8) Sai số bốn góc biết trước: lệch đúng 10 px theo x trên ảnh 1000 px.
    exp = [(0.1, 0.1), (0.9, 0.1), (0.9, 0.9), (0.1, 0.9)]
    act = [(0.11, 0.1), (0.91, 0.1), (0.91, 0.9), (0.11, 0.9)]
    err = quad_error_px(exp, act, 1000, 1000)
    check("sai số bốn góc = 10 px", abs(err - 10.0) < 1e-6, f"{err:.4f}")

    # 9) Vùng không giao nhau ⇒ ΔE bị bỏ qua kèm cảnh báo, không trả số bừa.
    r8 = compare_rasters(sq(5, 5, 20, 20), sq(80, 80, 95, 95))
    check("không giao: ΔE bị bỏ qua", r8.delta_e_median is None and bool(r8.warnings),
          str(r8.warnings))
    check("không giao: IoU=0", r8.iou < 1e-6, f"{r8.iou:.6f}")

    print()
    if failures:
        print(f"SELF-TEST THẤT BẠI: {len(failures)} mục — {', '.join(failures)}")
        return 1
    print("SELF-TEST ĐẠT — chỉ số từ bộ này dùng được.")
    return 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return _self_test()
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
    sys.exit(main(sys.argv))
