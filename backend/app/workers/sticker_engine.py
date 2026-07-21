import cv2
import numpy as np
import pypdfium2 as pdfium
import pikepdf
import io
import os
import zlib
import math
import time
import tempfile
from concurrent.futures import ProcessPoolExecutor
from shapely.geometry import Polygon, MultiPolygon
from shapely.ops import unary_union
import logging
from app.workers.shape_analyzer import ShapeType
import json

logger = logging.getLogger(__name__)


# Hàm hình học đường cắt được tách sang module nhẹ (không deps nặng) để test được.
# Re-export ở đây để giữ tương thích với code cũ import từ sticker_engine.
from app.workers.cutline_geometry import (  # noqa: E402
    build_contour_path_stream,
    _coords_to_bezier_stream,
    _coords_to_polyline_stream,
)


def compute_cut_bleed_offsets(cut_mode: str, bleed_pts: float, offset_pts: float) -> tuple:
    """Vị trí đường cắt và mép ngoài bù xén (pts, offset từ viền artwork).

    Trả (total_offset, bleed_outer_offset):
      - original: cut = offset; outer = offset + bleed (bù xén ngoài đường cắt)
      - bleed:    cut = outer = bleed + offset (cắt bao lề; vành đúng 1×bleed)
      - khác:     giống original

    REGRESSION: cut_mode=bleed KHÔNG được outer = cut + bleed (gấp đôi vành,
    đường cắt nằm giữa nền bù xén).
    """
    if cut_mode == "bleed" and bleed_pts > 0:
        total = bleed_pts + offset_pts
        return total, total
    total = offset_pts
    outer = total + bleed_pts if bleed_pts > 0 else total
    return total, outer


def _bleed_roi_bbox(mask, margin: int = 8):
    """Bounding box (y0, y1, x0, x1) của vùng mask>0, nới thêm `margin` px và
    kẹp trong biên ảnh. Trả None nếu mask rỗng.

    Dùng để giới hạn tính toán bleed (distance_transform_edt / cv2.inpaint)
    quanh mép hình thay vì chạy trên cả canvas (có nhiều vùng trống ở rìa).
    """
    ys, xs = np.where(mask > 0)
    if ys.size == 0:
        return None
    h, w = mask.shape[:2]
    y0 = max(0, int(ys.min()) - margin)
    y1 = min(h, int(ys.max()) + 1 + margin)
    x0 = max(0, int(xs.min()) - margin)
    x1 = min(w, int(xs.max()) + 1 + margin)
    return y0, y1, x0, x1


def _downscale_factor(h: int, w: int, max_dim: int = 1000) -> int:
    """Hệ số hạ mẫu để cạnh dài ≲ max_dim (1 = không hạ)."""
    longest = max(h, w)
    return int(math.ceil(longest / max_dim)) if longest > max_dim else 1


def _near_white_mask_rgb(img: np.ndarray, *, min_luma: int = 248, max_chroma: int = 18) -> np.ndarray:
    """Pixel gần trắng / AA trộn nền (RGB uint8 HxWx3).

    Dùng để LOẠI khỏi nguồn màu viền: pixel mép render thường bị trộn trắng →
    nearest kéo nhạt ra bleed. Chroma = max−min kênh; luma ≈ max kênh.
    """
    if img is None or img.ndim != 3 or img.shape[2] < 3:
        return np.zeros(img.shape[:2], dtype=bool) if img is not None else np.zeros((0, 0), dtype=bool)
    rgb = img[:, :, :3]
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    chroma = mx.astype(np.int16) - mn.astype(np.int16)
    return (mx >= min_luma) & (chroma <= max_chroma)


def _erode_px(mask: np.ndarray, px: int, kernel_type: int = cv2.MORPH_ELLIPSE) -> np.ndarray:
    """Erode mask `px` pixels (kernel ellipse/rect 2*px+1). px<=0 → copy."""
    if px is None or px <= 0:
        return mask.copy()
    k = max(1, int(px))
    ker = cv2.getStructuringElement(kernel_type, (k * 2 + 1, k * 2 + 1))
    return cv2.erode(mask, ker)


def _build_edge_color_source_mask(
    silhouette: np.ndarray,
    img: np.ndarray,
    *,
    band_px: int,
    peel_px: int = 1,
    edge_bite_px: int = 0,
    kernel_type: int = cv2.MORPH_ELLIPSE,
    exclude_near_white: bool = True,
) -> np.ndarray:
    """Nguồn màu bleed = dải VIỀN tem gốc (shell), không hút cả ruột.

    Mục tiêu: 'Lấy theo màu viền tem' phải lấy đúng màu dọc chu vi tem, không
    lấy màu lõi (khi viền mỏng + erode sâu) và không lấy pixel AA trắng mép.

    Pipeline:
      1) edge_bite: co silhouette (bỏ dải trắng mép khi file không tràn lề).
      2) peel: bỏ vài px ngoài cùng (AA trộn nền).
      3) band: dải dày `band_px` ngay sau peel = nguồn nearest/inpaint.
      4) Loại pixel near-white trong dải.
      5) Fallback dần nếu dải rỗng (tem mảnh / viền trắng dày).
    """
    if silhouette is None or np.count_nonzero(silhouette) == 0:
        return np.zeros_like(silhouette) if silhouette is not None else np.zeros((0, 0), dtype=np.uint8)

    base = silhouette
    if edge_bite_px and edge_bite_px > 0:
        bitten = _erode_px(silhouette, edge_bite_px, kernel_type)
        if np.count_nonzero(bitten) > 0:
            base = bitten

    peel = max(0, int(peel_px))
    band = max(1, int(band_px))

    def _shell(src: np.ndarray, peel_n: int, band_n: int) -> np.ndarray:
        outer = _erode_px(src, peel_n, kernel_type)
        inner = _erode_px(src, peel_n + band_n, kernel_type)
        return cv2.subtract(outer, inner)

    def _strip_white(shell: np.ndarray) -> np.ndarray:
        if (
            not exclude_near_white
            or np.count_nonzero(shell) == 0
            or img is None
            or img.ndim != 3
        ):
            return shell
        cleaned = shell.copy()
        cleaned[_near_white_mask_rgb(img)] = 0
        return cleaned if np.count_nonzero(cleaned) > 0 else shell

    shell = _strip_white(_shell(base, peel, band))
    if np.count_nonzero(shell) > 0:
        return shell

    # Fallback 1: bỏ peel, band dày hơn (bám sát viền hình học).
    shell = _strip_white(_shell(base, 0, max(band, 2)))
    if np.count_nonzero(shell) > 0:
        return shell

    # Fallback 2: không lọc trắng — thà lấy AA còn hơn rỗng (tránh bleed padding).
    shell = _shell(base, 0, max(band, 2))
    if np.count_nonzero(shell) > 0:
        return shell

    # Fallback 3: mọi pixel silhouette (sau bite) — hành vi cũ an toàn.
    if np.count_nonzero(base) > 0:
        cleaned = _strip_white(base)
        return cleaned if np.count_nonzero(cleaned) > 0 else base

    return silhouette.copy()


def _nearest_color_fill(sub_src, sub_img, max_dim: int = 4000):
    """Lấp màu nearest-neighbor từ vùng có màu (sub_src>0) ra toàn ROI
    ('Kéo giãn mép ảnh'). Chạy FULL-RES để giữ NÉT — nhân bản pixel mép vuông
    góc ra ngoài, không nội suy nên không mờ.

    Chỉ hạ mẫu khi ROI CỰC lớn (> max_dim, vd sheet SRA3+) để chặn OOM; khi đó
    dùng INTER_NEAREST ở CẢ hạ mẫu lẫn phóng lại (KHÔNG dùng INTER_AREA/LINEAR:
    chúng trộn trung bình pixel trắng+màu ở ranh giới → loang/mờ như bản cũ).
    """
    from scipy.ndimage import distance_transform_edt
    sh, sw = sub_src.shape[:2]
    f = _downscale_factor(sh, sw, max_dim)
    if f > 1:
        small_src = cv2.resize(sub_src, (max(1, sw // f), max(1, sh // f)), interpolation=cv2.INTER_NEAREST)
        if np.count_nonzero(small_src) > 0:
            small_img = cv2.resize(sub_img, (small_src.shape[1], small_src.shape[0]), interpolation=cv2.INTER_NEAREST)
            _, idx = distance_transform_edt(small_src == 0, return_indices=True)
            small_colors = small_img[idx[0], idx[1], :]
            return cv2.resize(small_colors, (sw, sh), interpolation=cv2.INTER_NEAREST)
    _, idx = distance_transform_edt(sub_src == 0, return_indices=True)
    return sub_img[idx[0], idx[1], :]


def _inpaint_color_fill(sub_img, sub_csm, sub_bleed, max_dim: int = 4000):
    """'Làm mượt thông minh' — seed nền từ color_source_mask (dải màu THẬT đã co
    vào trong, bỏ qua mép trắng) bằng nearest, rồi cv2.inpaint (NS) làm mượt mối
    nối màu trong vùng ring. Chạy FULL-RES cho ring hẹp (bleed 1-3mm = vài chục px)
    để giữ nét; chỉ hạ mẫu khi ROI CỰC lớn (chặn OOM), khi đó resize NEAREST ở CẢ
    hai chiều để không nội suy làm mờ.

    Sửa 2 bug bản cũ: (1) nền cũ lấp bằng pixel mép TRANG (thường TRẮNG với file
    không tràn lề) → inpaint hút trắng ngược vào ring = ra trắng/nhạt; nay seed từ
    csm (màu sâu bên trong). (2) hạ mẫu về ≤900px + INTER_AREA/LINEAR phóng lại →
    mờ; nay full-res + NEAREST.
    """
    from scipy.ndimage import distance_transform_edt
    sh, sw = sub_img.shape[:2]
    f = _downscale_factor(sh, sw, max_dim)
    if f > 1:
        nw, nh = max(1, sw // f), max(1, sh // f)
        s_img = cv2.resize(sub_img, (nw, nh), interpolation=cv2.INTER_NEAREST)
        s_csm = cv2.resize(sub_csm, (nw, nh), interpolation=cv2.INTER_NEAREST)
        s_bleed = cv2.resize(sub_bleed, (nw, nh), interpolation=cv2.INTER_NEAREST)
    else:
        s_img, s_csm, s_bleed = sub_img, sub_csm, sub_bleed

    # Seed sạch: mọi pixel NGOÀI color_source_mask lấp bằng màu csm gần nhất (màu
    # THẬT sâu bên trong, KHÔNG phải mép trắng). Đây là nền cho inpaint diffuse.
    src = (s_csm > 0)
    s_filled = s_img.copy()
    if src.any() and (~src).any():
        _, fi = distance_transform_edt(~src, return_indices=True)
        s_filled = s_img[fi[0], fi[1]]
    # Chỉ inpaint vùng ring (bleed NGOÀI csm) → NS diffuse màu từ biên csm ra, mượt.
    mask_for_inpaint = cv2.subtract(s_bleed, s_csm)
    out = cv2.inpaint(s_filled, mask_for_inpaint, 3, cv2.INPAINT_NS)
    if f > 1:
        out = cv2.resize(out, (sw, sh), interpolation=cv2.INTER_NEAREST)
    return out


def _render_page_rgb_ghostscript(
    input_path: str,
    page_index: int,
    scale: float,
    expected_width: int,
    expected_height: int,
) -> np.ndarray | None:
    """Render one page with Ghostscript for transparency/gradient colour fidelity.

    PDFium can expose the uncomposited colour of some Canva transparency groups
    at the trim edge. That colour does not match the original vector artwork when
    PDF.js, Poppler or a RIP displays it, creating a hard seam before any bleed
    algorithm runs. Ghostscript is already bundled/discovered by the application
    and produces the composited RGB appearance needed by raster bleed sampling.
    """
    try:
        import subprocess
        from app.config import settings
        from app.utils.subprocess_utils import run_hidden

        gs_path = getattr(settings, "GHOSTSCRIPT_PATH", "")
        if not gs_path or not os.path.isfile(gs_path):
            return None

        dpi = max(1.0, float(scale) * 72.0)
        with tempfile.TemporaryDirectory(prefix="prynx_sticker_gs_") as tmp_dir:
            output_path = os.path.join(tmp_dir, "page.png")
            page_number = int(page_index) + 1
            cmd = [
                gs_path,
                "-dSAFER",
                "-dBATCH",
                "-dNOPAUSE",
                "-dQUIET",
                "-dAutoRotatePages=/None",
                "-dUseCropBox",
                "-dTextAlphaBits=4",
                "-dGraphicsAlphaBits=4",
                "-sDEVICE=png16m",
                f"-r{dpi:.6f}",
                f"-dFirstPage={page_number}",
                f"-dLastPage={page_number}",
                f"-sOutputFile={output_path}",
                input_path,
            ]
            result = run_hidden(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=180,
            )
            if (
                result.returncode != 0
                or not os.path.isfile(output_path)
                or os.path.getsize(output_path) == 0
            ):
                logger.warning(
                    "Ghostscript sticker render failed on page %d (exit %s): %s",
                    page_number,
                    getattr(result, "returncode", "?"),
                    result.stderr.decode(errors="replace")[-500:],
                )
                return None

            image_bgr = cv2.imread(output_path, cv2.IMREAD_COLOR)
            if image_bgr is None or image_bgr.size == 0:
                return None
            image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)

        target_w = max(1, int(expected_width))
        target_h = max(1, int(expected_height))
        if image_rgb.shape[1] != target_w or image_rgb.shape[0] != target_h:
            image_rgb = cv2.resize(
                image_rgb, (target_w, target_h), interpolation=cv2.INTER_AREA
            )
        return image_rgb
    except Exception as exc:
        logger.warning(
            "Ghostscript sticker render unavailable on page %d: %s",
            int(page_index) + 1,
            exc,
        )
        return None


def _trajectory_right_strip(
    img: np.ndarray,
    amount: int,
    px_per_mm: float,
) -> np.ndarray:
    """Extrapolate the right edge by advecting colours along local isophotes."""
    amount = max(0, int(amount))
    h, w = img.shape[:2]
    if amount == 0:
        return np.empty((h, 0, 3), dtype=np.uint8)

    edge = np.ascontiguousarray(img[:, -1:])
    if h < 3 or w < 3:
        return np.repeat(edge, amount, axis=1)

    # Inspect only a narrow source band. This keeps memory/runtime proportional
    # to the perimeter even for very large print pages.
    lookback = min(
        w,
        max(8, min(64, int(round(max(amount, 1.5 * max(0.1, px_per_mm)))))),
    )
    band = img[:, -lookback:].astype(np.float32) / 255.0
    grad_x = cv2.Sobel(band, cv2.CV_32F, 1, 0, ksize=3)
    grad_y = cv2.Sobel(band, cv2.CV_32F, 0, 1, ksize=3)
    j_xx = np.sum(grad_x * grad_x, axis=2)
    j_xy = np.sum(grad_x * grad_y, axis=2)
    j_yy = np.sum(grad_y * grad_y, axis=2)

    weights = np.linspace(0.2, 1.0, lookback, dtype=np.float32)
    weights /= weights.sum()
    tensor_xx = np.sum(j_xx * weights, axis=1)
    tensor_xy = np.sum(j_xy * weights, axis=1)
    tensor_yy = np.sum(j_yy * weights, axis=1)

    smooth_sigma = max(1.0, min(6.0, amount / 6.0))
    tensor_xx = cv2.GaussianBlur(
        tensor_xx[:, None], (1, 0), smooth_sigma
    ).ravel()
    tensor_xy = cv2.GaussianBlur(
        tensor_xy[:, None], (1, 0), smooth_sigma
    ).ravel()
    tensor_yy = cv2.GaussianBlur(
        tensor_yy[:, None], (1, 0), smooth_sigma
    ).ravel()

    # Dominant tensor eigenvector is the colour-gradient normal. An isophote is
    # perpendicular to it, hence dy/dx = -gradient_x / gradient_y.
    angle = 0.5 * np.arctan2(
        2.0 * tensor_xy, tensor_xx - tensor_yy
    )
    direction_x = np.cos(angle)
    direction_y = np.sin(angle)
    energy = tensor_xx + tensor_yy
    coherence = np.sqrt(
        (tensor_xx - tensor_yy) ** 2 + 4.0 * tensor_xy ** 2
    ) / (energy + 1e-8)
    energy_floor = max(1e-7, float(np.percentile(energy, 15)))
    valid = (
        (coherence > 0.12)
        & (energy > energy_floor)
        & (np.abs(direction_y) > 0.15)
    )

    slopes = np.zeros(h, dtype=np.float32)
    valid_rows = np.flatnonzero(valid)
    if valid_rows.size:
        valid_slopes = np.clip(
            -direction_x[valid] / direction_y[valid], -1.25, 1.25
        )
        slopes = np.interp(
            np.arange(h), valid_rows, valid_slopes
        ).astype(np.float32)
        slopes = cv2.GaussianBlur(
            slopes[:, None], (1, 0),
            max(0.8, min(4.0, 0.18 * max(0.1, px_per_mm))),
        ).ravel()
        slopes = np.clip(slopes, -1.25, 1.25)

    source_y = np.arange(h, dtype=np.float32)
    output_y = source_y.copy()
    map_x = np.zeros((h, 1), dtype=np.float32)
    strip = np.empty((h, amount, 3), dtype=np.uint8)
    for step in range(1, amount + 1):
        # Forward-warp source rows, enforce a monotone mapping to prevent local
        # trajectory crossings, then invert it for cv2.remap. This avoids pointed
        # wedges and duplicated bands when neighbouring tangent estimates differ.
        forward_y = source_y + slopes * float(step)
        min_spacing = 0.05
        forward_y = np.maximum.accumulate(
            forward_y - source_y * min_spacing
        ) + source_y * min_spacing
        map_y = np.interp(
            output_y, forward_y, source_y, left=0.0, right=float(h - 1)
        ).astype(np.float32)[:, None]
        strip[:, step - 1] = cv2.remap(
            edge,
            map_x,
            map_y,
            interpolation=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REPLICATE,
        )[:, 0]
    return strip


def _trajectory_extend_axis(
    img: np.ndarray,
    before: int,
    after: int,
    px_per_mm: float,
) -> np.ndarray:
    """Extend both ends of the image x-axis; callers transpose for top/bottom."""
    before = max(0, int(before))
    after = max(0, int(after))
    parts = []
    if before:
        near_to_far = _trajectory_right_strip(
            np.ascontiguousarray(img[:, ::-1]), before, px_per_mm
        )
        parts.append(near_to_far[:, ::-1])
    parts.append(img)
    if after:
        parts.append(_trajectory_right_strip(img, after, px_per_mm))
    return np.concatenate(parts, axis=1)


def _rectangle_smooth_color_fill(
    img: np.ndarray,
    pad_px: int,
    edge_bite_px: int,
    px_per_mm: float,
) -> np.ndarray:
    """Continue local edge trajectories into all four rectangular bleed sides.

    Each side estimates a structure-tensor direction from the real artwork just
    inside the trim edge, then advects the edge colours along that tangent. This
    moves diagonal and curved bands as they leave the page instead of extruding
    every edge pixel along a perpendicular line. Top/bottom are evaluated after
    left/right so the corner fill inherits both local trajectories.
    """
    if img is None or img.ndim != 3 or img.shape[0] == 0 or img.shape[1] == 0:
        return img

    h, w = img.shape[:2]
    pad = max(0, int(pad_px))
    bite_x = min(max(0, int(edge_bite_px)), max(0, (w - 1) // 2))
    bite_y = min(max(0, int(edge_bite_px)), max(0, (h - 1) // 2))
    core = img[bite_y:h - bite_y if bite_y else h,
               bite_x:w - bite_x if bite_x else w]
    if core.size == 0:
        core = img
        bite_x = bite_y = 0

    top = bottom = pad + bite_y
    left = right = pad + bite_x

    # Continue left/right first. Transposing turns top/bottom into the same edge
    # problem while letting corner pixels inherit the side trajectories.
    horizontal = _trajectory_extend_axis(
        core, left, right, float(px_per_mm)
    )
    vertical_input = np.ascontiguousarray(
        np.transpose(horizontal, (1, 0, 2))
    )
    vertical = _trajectory_extend_axis(
        vertical_input, top, bottom, float(px_per_mm)
    )
    out = np.ascontiguousarray(np.transpose(vertical, (1, 0, 2)))

    # Keep the known artwork exact at the seam; the vector source is drawn above
    # it, but partial-alpha pixels still sample this raster layer.
    out[top:top + core.shape[0], left:left + core.shape[1]] = core

    # Interpolation may only mix existing colours; clamp any rounding excursion.
    src_min = core.reshape(-1, 3).min(axis=0)
    src_max = core.reshape(-1, 3).max(axis=0)
    return np.clip(out, src_min, src_max).astype(np.uint8)


def _band_tiles(band, band_radius: int, tile: int = 1024):
    """Sinh (crop_slice, core_slice) cho MỖI ô tile×tile GIAO với band.

    Mỗi ô lõi (core) là khối tile×tile; crop = core NỚI halo `band_radius` mọi phía
    (clamp trong biên). Chỉ trả ô mà band THỰC SỰ chạm (bỏ ô ruột → tăng tốc).
    core_slice trả về Ở TOẠ ĐỘ TUYỆT ĐỐI (để ghi vào out); kèm offset của core
    TRONG crop để driver ánh xạ index.

    Trả: (crop_y0, crop_y1, crop_x0, crop_x1, core_y0, core_y1, core_x0, core_x1).
    """
    ys, xs = np.where(band > 0)
    if ys.size == 0:
        return
    h, w = band.shape[:2]
    by0, by1 = int(ys.min()), int(ys.max()) + 1
    bx0, bx1 = int(xs.min()), int(xs.max()) + 1
    for cy0 in range(by0, by1, tile):
        cy1 = min(cy0 + tile, by1)
        for cx0 in range(bx0, bx1, tile):
            cx1 = min(cx0 + tile, bx1)
            # Bỏ ô nếu band không chạm khối core này (ô ruột) → không tính.
            if np.count_nonzero(band[cy0:cy1, cx0:cx1]) == 0:
                continue
            gy0 = max(0, cy0 - band_radius)
            gy1 = min(h, cy1 + band_radius)
            gx0 = max(0, cx0 - band_radius)
            gx1 = min(w, cx1 + band_radius)
            yield (gy0, gy1, gx0, gx1, cy0, cy1, cx0, cx1)


def _banded_nearest_fill(csm, img, ring, band, band_radius: int, out, tile: int = 1024) -> bool:
    """'Kéo giãn mép ảnh' giới hạn theo band (dải quanh ring) thay vì cả trang.

    Với mỗi ô có band: crop nới halo `band_radius`, chạy distance_transform_edt trên
    crop, GHI màu nearest chỉ vào vùng band[core]>0. Guard: nếu pixel band trong core
    có khoảng cách tới nguồn ≥ band_radius → nguồn thật có thể NGOÀI halo → trả False
    (caller fallback về _nearest_color_fill full-ROI, KHÔNG bao giờ tệ hơn).

    CHỨNG MINH giống hệt: pixel hiển thị = ring>0 ⊂ band; band[core] luôn ⊂ band nên
    được ghi. Guard đảm bảo crop chứa trọn nguồn gần nhất toàn cục → idx trùng bản full.
    """
    from scipy.ndimage import distance_transform_edt
    for (gy0, gy1, gx0, gx1, cy0, cy1, cx0, cx1) in _band_tiles(band, band_radius, tile):
        sub_src = csm[gy0:gy1, gx0:gx1]
        # Không có nguồn màu trong crop → không thể nearest-fill đúng → fallback.
        if np.count_nonzero(sub_src) == 0:
            return False
        dist, idx = distance_transform_edt(sub_src == 0, return_indices=True)
        # Vùng band cần ghi trong toạ độ crop.
        cyl, cyr = cy0 - gy0, cy1 - gy0
        cxl, cxr = cx0 - gx0, cx1 - gx0
        core_band = band[cy0:cy1, cx0:cx1] > 0
        if not core_band.any():
            continue
        # Guard CHỈ trên RING (pixel HIỂN THỊ) — KHÔNG phải band. Band rộng thêm
        # band_radius ngoài ring nên pixel band ngoài cùng luôn cách nguồn ≥ band_radius
        # → guard-trên-band LUÔN trip (tối ưu vô dụng, vd tem tròn có lỗ). Chỉ ring cần
        # khớp global (cách nguồn < band_radius). Pixel band ngoài-ring KHÔNG hiển thị
        # (SMask=ring), chỉ lấp màu liên tục chống sợi xám → không cần khớp global.
        core_ring = ring[cy0:cy1, cx0:cx1] > 0
        core_dist = dist[cyl:cyr, cxl:cxr]
        if core_ring.any() and float(core_dist[core_ring].max()) >= band_radius:
            return False
        sub_img = img[gy0:gy1, gx0:gx1]
        filled = sub_img[idx[0], idx[1]]
        core_out = out[cy0:cy1, cx0:cx1]
        core_filled = filled[cyl:cyr, cxl:cxr]
        core_out[core_band] = core_filled[core_band]
    return True


def _banded_inpaint_fill(img, csm, bleed, ring, band, band_radius: int, out, tile: int = 1024) -> bool:
    """'Làm mượt thông minh' giới hạn theo band. Mỗi ô gọi lại _inpaint_color_fill
    trên crop (nới halo band_radius), ghi kết quả chỉ vào band[core]>0.

    KHÔNG bitwise-identical (NS là PDE) nhưng giống thị giác: mask inpaint =
    bleed−csm nằm trong band_radius của ring; halo đủ xa (~45px ≫ radius 3) để nhiễu
    biên không chạm pixel ring. Guard EDT (như nearest) → fallback full-ROI khi rủi ro.
    """
    from scipy.ndimage import distance_transform_edt
    for (gy0, gy1, gx0, gx1, cy0, cy1, cx0, cx1) in _band_tiles(band, band_radius, tile):
        sub_csm = csm[gy0:gy1, gx0:gx1]
        if np.count_nonzero(sub_csm) == 0:
            return False
        core_band = band[cy0:cy1, cx0:cx1] > 0
        if not core_band.any():
            continue
        # Guard CHỈ trên RING (pixel hiển thị), KHÔNG phải band — xem giải thích ở
        # _banded_nearest_fill. Guard-trên-band luôn trip vì band rộng hơn ring band_radius.
        core_ring = ring[cy0:cy1, cx0:cx1] > 0
        dist = distance_transform_edt(sub_csm == 0)
        cyl, cyr = cy0 - gy0, cy1 - gy0
        cxl, cxr = cx0 - gx0, cx1 - gx0
        if core_ring.any() and float(dist[cyl:cyr, cxl:cxr][core_ring].max()) >= band_radius:
            return False
        sub_img = img[gy0:gy1, gx0:gx1]
        sub_bleed = bleed[gy0:gy1, gx0:gx1]
        filled = _inpaint_color_fill(sub_img, sub_csm, sub_bleed)
        core_out = out[cy0:cy1, cx0:cx1]
        core_filled = filled[cyl:cyr, cxl:cxr]
        core_out[core_band] = core_filled[core_band]
    return True


def _make_srgb_colorspace(pdf: pikepdf.Pdf):
    """Create a calibrated sRGB color space for raster bleed images.

    PDFium renders sampled bleed pixels to RGB. Labelling those bytes as bare
    DeviceRGB leaves their interpretation up to the viewer/RIP. ICCBased sRGB
    keeps the rendered samples deterministic while the original artwork stays
    vector and retains its own CMYK/spot resources.
    """
    try:
        from PIL import ImageCms
        # The legacy asset named sRGB.icc is actually Adobe RGB (1998). Build a
        # genuine LittleCMS sRGB profile so viewers do not oversaturate the bleed.
        cms_profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))
        profile = pikepdf.Stream(pdf, cms_profile.tobytes())
        profile[pikepdf.Name("/N")] = 3
        profile[pikepdf.Name("/Alternate")] = pikepdf.Name.DeviceRGB
        return pikepdf.Array([pikepdf.Name("/ICCBased"), pdf.make_indirect(profile)])
    except Exception as exc:
        logger.warning("Cannot embed sRGB ICC profile; falling back to DeviceRGB: %s", exc)
        return pikepdf.Name.DeviceRGB


def _copy_output_intents(src_pdf: pikepdf.Pdf, dst_pdf: pikepdf.Pdf) -> None:
    """Preserve document output profiles when rebuilding pages in a new PDF."""
    try:
        intents = src_pdf.Root.get("/OutputIntents")
        if not intents:
            return
        copied = []
        for intent in intents:
            foreign = intent if intent.is_indirect else src_pdf.make_indirect(intent)
            copied.append(dst_pdf.copy_foreign(foreign))
        if copied:
            dst_pdf.Root[pikepdf.Name("/OutputIntents")] = pikepdf.Array(copied)
    except Exception as exc:
        logger.warning("Cannot preserve PDF OutputIntents: %s", exc)


def _rectangle_vector_bleed_commands(
    xobject_name,
    *,
    crop_x0: float,
    crop_y0: float,
    page_width: float,
    page_height: float,
    bleed_pts: float,
    edge_bite_pts: float,
    sample_depth_pts: float,
) -> tuple[list[str], float, float]:
    """Stretch eight vector edge/corner strips around a rectangular page.

    Unlike the contour/sticker path, this never filters white pixels and never
    converts process/ICC/spot colors to RGB. ``edge_bite_pts`` intentionally
    moves the sampled strip inward; the default is zero for exact edge color.
    Returned bite values are clamped independently for X/Y and are also used to
    clip the original artwork when the user explicitly requests edge bite.
    """
    if bleed_pts <= 0 or page_width <= 0 or page_height <= 0:
        return [], 0.0, 0.0

    depth_x = min(max(0.01, sample_depth_pts), max(0.01, page_width / 2.0))
    depth_y = min(max(0.01, sample_depth_pts), max(0.01, page_height / 2.0))
    bite_x = min(max(0.0, edge_bite_pts), max(0.0, page_width / 2.0 - depth_x))
    bite_y = min(max(0.0, edge_bite_pts), max(0.0, page_height / 2.0 - depth_y))

    out_w = page_width + 2.0 * bleed_pts
    out_h = page_height + 2.0 * bleed_pts
    ext_x = bleed_pts + bite_x
    ext_y = bleed_pts + bite_y
    sx = ext_x / depth_x
    sy = ext_y / depth_y
    name = str(xobject_name)
    commands: list[str] = []

    def place(x: float, y: float, w: float, h: float,
              a: float, d: float, e: float, f: float) -> None:
        if w <= 0 or h <= 0:
            return
        commands.extend([
            "q",
            f"{x:.4f} {y:.4f} {w:.4f} {h:.4f} re W n",
            f"{a:.8f} 0 0 {d:.8f} {e:.4f} {f:.4f} cm",
            f"{name} Do",
            "Q",
        ])

    src_left = crop_x0 + bite_x
    src_right = crop_x0 + page_width - bite_x - depth_x
    src_bottom = crop_y0 + bite_y
    src_top = crop_y0 + page_height - bite_y - depth_y
    x_identity_shift = bleed_pts - crop_x0
    y_identity_shift = bleed_pts - crop_y0
    dst_right = out_w - ext_x
    dst_top = out_h - ext_y

    # Four sides, excluding corner squares.
    place(0.0, ext_y, ext_x, out_h - 2.0 * ext_y,
          sx, 1.0, -sx * src_left, y_identity_shift)
    place(dst_right, ext_y, ext_x, out_h - 2.0 * ext_y,
          sx, 1.0, dst_right - sx * src_right, y_identity_shift)
    place(ext_x, 0.0, out_w - 2.0 * ext_x, ext_y,
          1.0, sy, x_identity_shift, -sy * src_bottom)
    place(ext_x, dst_top, out_w - 2.0 * ext_x, ext_y,
          1.0, sy, x_identity_shift, dst_top - sy * src_top)

    # Four corners. Keeping them as vector form draws preserves ICC/spot color.
    place(0.0, 0.0, ext_x, ext_y,
          sx, sy, -sx * src_left, -sy * src_bottom)
    place(dst_right, 0.0, ext_x, ext_y,
          sx, sy, dst_right - sx * src_right, -sy * src_bottom)
    place(0.0, dst_top, ext_x, ext_y,
          sx, sy, -sx * src_left, dst_top - sy * src_top)
    place(dst_right, dst_top, ext_x, ext_y,
          sx, sy, dst_right - sx * src_right, dst_top - sy * src_top)

    return commands, bite_x, bite_y


# ── Ngưỡng song song ─────────────────────────────────────────────────────
# Overhead spawn trên Windows ~2-3s/worker (child re-import cv2/scipy/skimage/
# pikepdf/pdfium). Với ~2s/trang, break-even ≈ 6 trang. File < ngưỡng chạy tuần
# tự tại chỗ (không spawn) để không chậm hơn.
_STICKER_PARALLEL_MIN_PAGES = 6


def _n_pages_should_parallelize(n_pages: int) -> bool:
    """True nếu nên fan-out song song (đủ nhiều trang để bù overhead spawn)."""
    return n_pages >= _STICKER_PARALLEL_MIN_PAGES


def _process_sticker_chunk(args: dict):
    """Worker top-level (BẮT BUỘC picklable + importable cho Windows spawn).

    Mỗi tiến trình con tạo StickerEngine RIÊNG (self.scale mutate per-trang nên
    KHÔNG chia sẻ instance) và gọi lại process_pdf với _page_subset = dải trang
    của chunk. process_pdf ở chế độ worker trả MẢNH THÔ:
        (chunk_pdf_bytes, all_pages_meta, pages_no_dieline_global, any_dieline)
    Trả kèm chunk_idx để orchestrator sắp đúng thứ tự (dù pool.map đã giữ thứ tự,
    vẫn trả để phòng thủ + dễ log).
    """
    chunk_idx = args["chunk_idx"]
    # OVERSUBSCRIPTION FIX: OpenCV/BLAS tự đa luồng (cv2.getNumThreads=số nhân). Chạy
    # W worker mà mỗi worker vẫn dùng full nhân → W×nhân luồng chen nhau trên số nhân
    # có hạn → thrashing (đo thực: 6 worker chỉ nhanh 2x thay vì ~6x). Ghim mỗi worker
    # về ÍT luồng (orchestrator tính threads_per_worker ≈ nhân/W) để tổng luồng ≈ nhân.
    _tpw = str(args.get("threads_per_worker", 1))
    for _var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
                 "NUMEXPR_NUM_THREADS", "OPENCV_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
        os.environ[_var] = _tpw
    try:
        cv2.setNumThreads(int(_tpw))
    except Exception:
        pass
    engine = StickerEngine(dpi=args["dpi"], debug=args["debug"])
    result = engine.process_pdf(
        input_path=args["input_path"],
        output_path="",  # worker mode: KHÔNG ghi ra đĩa, trả bytes
        cut_mode=args["cut_mode"],
        offset_mm=args["offset_mm"],
        corner_style=args["corner_style"],
        cut_color=args["cut_color"],
        bleed_mm=args["bleed_mm"],
        fill_holes=args["fill_holes"],
        remove_white_bg=args["remove_white_bg"],
        bleed_color_type=args["bleed_color_type"],
        solid_bleed_color=args["solid_bleed_color"],
        draw_cut_contour=args["draw_cut_contour"],
        rectangle_mode=args["rectangle_mode"],
        edge_bite_mm=args["edge_bite_mm"],
        cut_first_page_only=args["cut_first_page_only"],
        shape_mode=args.get("shape_mode", "auto_safe"),
        _page_subset=args["page_indices"],
    )
    # result = (bytes, metas, pages_no_dieline, any_dieline)
    return (chunk_idx, result)


class StickerEngine:
    def __init__(self, dpi: int = 300, debug: bool = False):
        self.dpi = dpi
        self.scale = dpi / 72.0
        # Khi False (mặc định/production): KHÔNG ghi ảnh debug ra đĩa & KHÔNG log spam.
        # Bật qua tham số hoặc biến môi trường STICKER_DEBUG=1.
        self.debug = debug or os.environ.get("STICKER_DEBUG", "").lower() in ("1", "true", "yes")

    def process_pdf(
        self,
        input_path: str,
        output_path: str,
        cut_mode: str = "original",
        offset_mm: float = 0.0,
        corner_style: str = "round",
        cut_color: tuple = (0, 1, 0, 0),  
        bleed_mm: float = 0.0,
        fill_holes: bool = True,
        remove_white_bg: bool = False,
        bleed_color_type: str = "image",
        solid_bleed_color: tuple = (255, 255, 255),
        draw_cut_contour: bool = True,
        rectangle_mode: bool = False,
        edge_bite_mm: float = 0.0,
        cut_first_page_only: bool = False,
        shape_mode: str = "auto_safe",
        _page_subset: list = None,
    ) -> tuple:
        # _page_subset: khi != None, CHỈ xử lý các trang có index trong list (theo
        # đúng thứ tự truyền vào) và lưu output ra output_path. Dùng cho worker song
        # song — mỗi tiến trình con xử lý một dải trang liền kề rồi trả file chunk.
        # output_path lúc đó là file chunk tạm. page_idx trong log/meta vẫn là index
        # GLOBAL (index thật trong file gốc) để concat + cảnh báo trang đúng số.
        debug_step = "Init"
        doc_in_pdfium = None
        doc_in_pike = None
        doc_out = None
        try:
            debug_step = "Open Original PDF"
            doc_in_pdfium = pdfium.PdfDocument(input_path)
            doc_in_pike = pikepdf.Pdf.open(input_path)

            # ── ORCHESTRATOR: song song hóa khi gọi top-level + file nhiều trang ──
            # _page_subset None = gọi top-level (không phải worker). File >= ngưỡng →
            # chia dải trang liền kề cho nhiều tiến trình con, mỗi con tự mở lại file
            # + xử lý chunk + trả file PDF, rồi merge ở đây. Overhead spawn Windows
            # ~2-3s/worker nên file nhỏ (< ngưỡng) chạy tuần tự tại chỗ (rơi xuống dưới).
            if _page_subset is None and _n_pages_should_parallelize(len(doc_in_pdfium)):
                doc_in_pdfium.close(); doc_in_pdfium = None
                doc_in_pike.close(); doc_in_pike = None
                return self._process_parallel(
                    input_path=input_path, output_path=output_path,
                    cut_mode=cut_mode, offset_mm=offset_mm, corner_style=corner_style,
                    cut_color=cut_color, bleed_mm=bleed_mm, fill_holes=fill_holes,
                    remove_white_bg=remove_white_bg, bleed_color_type=bleed_color_type,
                    solid_bleed_color=solid_bleed_color, draw_cut_contour=draw_cut_contour,
                    rectangle_mode=rectangle_mode, edge_bite_mm=edge_bite_mm,
                    cut_first_page_only=cut_first_page_only,
                    shape_mode=shape_mode,
                )

            debug_step = "Create Output PDF"
            doc_out = pikepdf.Pdf.new()
            # Worker chunks are merged into a fresh document later; only the
            # top-level sequential path copies catalog-level output profiles here.
            if _page_subset is None:
                _copy_output_intents(doc_in_pike, doc_out)
            
            debug_step = "Inject Spot Color Definition"
            c, m, y, k = cut_color
            func_dict = doc_out.make_indirect(pikepdf.Dictionary({
                '/FunctionType': 2,
                '/Domain': [0.0, 1.0],
                '/C0': [0.0, 0.0, 0.0, 0.0],
                '/C1': [c, m, y, k],
                '/N': 1.0
            }))

            cs_arr = pikepdf.Array([pikepdf.Name.Separation, pikepdf.Name.CutContour, pikepdf.Name.DeviceCMYK, func_dict])
            
            mm_to_pts = 2.83465
            offset_pts = offset_mm * mm_to_pts
            bleed_pts = bleed_mm * mm_to_pts
            use_vector_rectangle_bleed = (
                rectangle_mode and bleed_color_type == "image" and bleed_pts > 0
            )
            srgb_colorspace = None
            
            all_pages_meta = []
            any_dieline_found = False
            pages_no_dieline = []

            _n_pages = len(doc_in_pdfium)
            # Danh sách trang cần xử lý: subset (worker song song) hoặc toàn bộ.
            _page_list = list(_page_subset) if _page_subset is not None else list(range(_n_pages))

            for page_idx in _page_list:
                debug_step = f"Rasterize Page {page_idx}"
                page_in = doc_in_pdfium[page_idx]
                page_in_pike = doc_in_pike.pages[page_idx]

                # ── Chặn OOM: giới hạn độ phân giải raster theo kích thước trang ──
                # Khổ tem nhỏ vẫn render full DPI; sheet lớn (SRA3+) tự hạ scale để
                # cạnh dài ≲ MAX_LONG_PX và tổng ≲ MAX_MEGAPIXELS, tránh treo/hết RAM.
                MAX_LONG_PX = 6000
                MAX_MEGAPIXELS = 40_000_000
                base_scale = self.dpi / 72.0
                try:
                    pw_pt, ph_pt = page_in.get_size()
                except Exception:
                    pw_pt, ph_pt = 0, 0
                shrink = 1.0
                if pw_pt and ph_pt:
                    est_w, est_h = pw_pt * base_scale, ph_pt * base_scale
                    long_px = max(est_w, est_h)
                    if long_px > MAX_LONG_PX:
                        shrink = min(shrink, MAX_LONG_PX / long_px)
                    mp = est_w * est_h
                    if mp > MAX_MEGAPIXELS:
                        shrink = min(shrink, (MAX_MEGAPIXELS / mp) ** 0.5)
                self.scale = base_scale * shrink
                # px/mm THỰC TẾ của raster: self.scale là px/point (đã gồm shrink khi trang
                # bị DPI-cap), nên px/mm = scale × 72/25.4. MỌI morphology bù xén PHẢI dùng
                # số này, KHÔNG dùng self.dpi/25.4 (bỏ qua shrink → phóng đại 1/shrink lần khi
                # trang lớn: hút màu quá sâu, đóng lỗ/lẹm mép quá tay, lệch bleed_mask).
                px_per_mm = self.scale * 72.0 / 25.4
                if shrink < 1.0 and self.debug:
                    logger.warning(">>> DPI CAP page %d: scale %.4f→%.4f (page %.0fx%.0f pt)", page_idx, base_scale, self.scale, pw_pt, ph_pt)

                if use_vector_rectangle_bleed:
                    # Geometry is the page rectangle and bleed is drawn from the
                    # source Form XObject. No raster is needed for detection/color.
                    img = np.full((1, 1, 4), 255, dtype=np.uint8)
                    img_native = img[:, :, :3]
                    has_alpha = False
                else:
                    img_native = None
                    use_color_managed_rectangle_raster = (
                        rectangle_mode
                        and bleed_color_type == "inpaint"
                        and bleed_pts > 0
                    )
                    if use_color_managed_rectangle_raster:
                        img_native = _render_page_rgb_ghostscript(
                            input_path,
                            page_idx,
                            self.scale,
                            max(1, int(round(float(pw_pt) * self.scale))),
                            max(1, int(round(float(ph_pt) * self.scale))),
                        )
                        if img_native is None:
                            logger.warning(
                                "Smart rectangle bleed page %d is falling back to PDFium RGB",
                                page_idx + 1,
                            )

                    if img_native is not None:
                        img = cv2.cvtColor(img_native, cv2.COLOR_RGB2RGBA)
                        has_alpha = False
                    else:
                        bitmap = page_in.render(scale=self.scale)
                        img_bgra = bitmap.to_numpy()
                        img = cv2.cvtColor(img_bgra, cv2.COLOR_BGRA2RGBA)
                        img_native = cv2.cvtColor(img_bgra, cv2.COLOR_BGRA2RGB)
                        has_alpha = img.shape[2] == 4 and img[:, :, 3].min() < 255
                if page_idx == 0 and self.debug:
                    logger.warning(">>> PARAMS: cut_mode=%s offset_mm=%.2f bleed_mm=%.2f corner_style=%s remove_white_bg=%s bleed_color_type=%s fill_holes=%s", cut_mode, offset_mm, bleed_mm, corner_style, remove_white_bg, bleed_color_type, fill_holes)
                    logger.warning(">>> IMAGE: shape=%s has_alpha=%s", img.shape, has_alpha)
                
                # RECTANGLE MODE: shape ĐÃ biết là cả page rect (nhánh dòng ~404 dựng
                # dieline/cut/bleed_outer từ page bbox). Toàn bộ pipeline mask dưới đây
                # (HSV/connectedComponents/fill_holes/GaussianBlur/skimage find_contours)
                # là THỪA — chỉ cần mask full-page. `contours` không dùng ở nhánh rect.
                # Bỏ qua giúp rectangle nhanh hẳn (audit tốc độ 2026-07-08).
                # LƯU Ý: rect mode bỏ qua remove_white_bg/alpha — đúng ngữ nghĩa "shape
                # là cả trang"; đừng dựa auto-trim trắng khi rectangle_mode=True.
                if rectangle_mode:
                    _full = np.full(img.shape[:2], 255, dtype=np.uint8)
                    base_mask = raw_mask = mask = aa_mask = _full
                    contours = []
                else:
                    if has_alpha:
                        base_mask = img[:, :, 3].copy()
                    else:
                        if remove_white_bg:
                            hsv = cv2.cvtColor(img[:,:,:3], cv2.COLOR_RGB2HSV)
                            # Ngưỡng SIẾT MẠNH: chỉ coi là "trắng nền" khi RẤT sáng
                            # (V>=200) VÀ GẦN NHƯ VÔ SẮC TUYỆT ĐỐI (S<=8 ≈ 3%). Lý do:
                            # nền kem/ngà CMYK rất nhạt (vd C4 M5 Y10 → RGB≈(243,237,227),
                            # S≈17 ≈ 6.6%) LÀ NỘI DUNG của nhãn, phải GIỮ. Ngưỡng cũ S<=25
                            # ăn nhầm cả nền kem đó (bóc mất nửa nhãn). Chỉ trắng gần tuyệt
                            # đối (S<3%) mới bị bóc; mọi ám màu nhẹ đều được giữ.
                            # ĐÁNH ĐỔI: nền trắng-JPEG có ám vàng nhẹ sẽ KHÔNG còn bị bóc.
                            lower_white = np.array([0, 0, 200])
                            upper_white = np.array([180, 8, 255])
                            white_mask = cv2.inRange(hsv, lower_white, upper_white)
                            # CHỈ bỏ vùng trắng NỐI với biên ảnh (nền thật) — dùng connected-components,
                            # giữ lại các mảng trắng chạm mép. Chi tiết sáng/pastel/xám nhạt NẰM GIỮA
                            # artwork (không chạm biên) được GIỮ → không đục lỗ nội dung như ngưỡng cứng
                            # cũ (nới ngưỡng mà không lọc-theo-biên sẽ đục thủng artwork nhạt màu).
                            num_lbl, labels = cv2.connectedComponents(white_mask)
                            if num_lbl > 1:
                                border_labels = set(labels[0, :]) | set(labels[-1, :]) | set(labels[:, 0]) | set(labels[:, -1])
                                border_labels.discard(0)
                                if border_labels:
                                    bg_white = np.isin(labels, list(border_labels)).astype(np.uint8) * 255
                                else:
                                    bg_white = np.zeros_like(white_mask)
                            else:
                                bg_white = np.zeros_like(white_mask)
                            base_mask = cv2.bitwise_not(bg_white)
                        else:
                            base_mask = np.ones(img.shape[:2], dtype=np.uint8) * 255

                    if remove_white_bg:
                        fringe_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
                        base_mask = cv2.erode(base_mask, fringe_kernel)

                    raw_mask = base_mask.copy()

                    if fill_holes:
                        contours_mask, _ = cv2.findContours(base_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                        cv2.drawContours(base_mask, contours_mask, -1, 255, cv2.FILLED)

                    _, mask = cv2.threshold(base_mask, 10, 255, cv2.THRESH_BINARY)

                    blur_size = 7 if corner_style == "round" else 1
                    if blur_size > 1:
                        aa_mask = cv2.GaussianBlur(mask, (blur_size, blur_size), 0)
                    else:
                        aa_mask = mask.copy()
                        clean_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
                        aa_mask = cv2.morphologyEx(aa_mask, cv2.MORPH_OPEN, clean_kernel)
                        aa_mask = cv2.morphologyEx(aa_mask, cv2.MORPH_CLOSE, clean_kernel)

                    aa_mask_padded = np.pad(aa_mask, pad_width=1, mode='constant', constant_values=0)

                    debug_step = f"Find Contours Page {page_idx}"
                    from skimage import measure
                    contours = measure.find_contours(aa_mask_padded, 127.5)
                
                # Hình học phải theo CROPBOX, KHÔNG phải MediaBox: pdfium render và
                # page.as_form_xobject() đều dùng CropBox (đã verify). Khi file có
                # CropBox ≠ MediaBox (vd sau auto-trim chỉ set CropBox), lấy MediaBox
                # sẽ lệch cả kích thước lẫn gốc toạ độ → bleed/đường cắt vẽ sai chỗ.
                # pikepdf .cropbox tự fallback về MediaBox khi trang không có CropBox.
                crop_x0 = float(page_in_pike.cropbox[0])
                crop_y0 = float(page_in_pike.cropbox[1])
                page_in_width = float(page_in_pike.cropbox[2]) - crop_x0
                page_in_height = float(page_in_pike.cropbox[3]) - crop_y0
                
                # Pad trang theo mép NGOÀI cùng (cut hoặc bleed), KHÔNG cộng bleed 2 lần.
                # - original: cut = offset, outer = offset + bleed
                # - bleed:    cut = outer = bleed + offset  (cắt bao lề bù xén)
                # - none:     chỉ tràn màu bleed
                # Không cộng vùng “safety” cố định: 50pt/cạnh tương đương 17.6mm trắng
                # và làm MediaBox phình vô cớ. Offset âm co đường cắt vào trong nên cũng
                # không cần abs(); chỉ phần thực sự nở ra ngoài mới cần pad.
                if rectangle_mode:
                    max_expansion_pts = max(0.0, bleed_pts)
                elif cut_mode == "none":
                    max_expansion_pts = max(0.0, bleed_pts)
                else:
                    _cut_edge, _outer_edge = compute_cut_bleed_offsets(
                        cut_mode, bleed_pts, offset_pts
                    )
                    max_expansion_pts = max(0.0, _cut_edge, _outer_edge)
                new_width = page_in_width + 2 * max_expansion_pts
                new_height = page_in_height + 2 * max_expansion_pts
                
                page_out = doc_out.add_blank_page(page_size=(new_width, new_height))
                
                bleed_stream_data = None
                mask_bytes_data = None
                img_pil = None
                bleed_ring = None
                sticker_footprint = None
                is_bleed_cmyk = False
                
                # ============================================================
                # STEP A: Compute dieline_poly FIRST (needed for bleed mask)
                # ============================================================
                dieline_poly = None
                cut_poly = None
                bleed_outer_poly = None
                dieline_polygons = []
                total_offset = 0
                bleed_outer_offset = 0
                recon_meta = {"shape_mode": shape_mode, "reconstructed": False}
                cut_draw_style = corner_style
                
                # ── RECTANGLE MODE: dùng page bbox làm shape, skip contour detection ──
                if rectangle_mode:
                    debug_step = f"Rectangle Mode Page {page_idx}"
                    rect_poly = Polygon([
                        (0, 0), (page_in_width, 0),
                        (page_in_width, page_in_height), (0, page_in_height)
                    ])
                    dieline_poly = rect_poly
                    cut_poly = rect_poly
                    any_dieline_found = True
                    if bleed_pts > 0:
                        bleed_outer_offset = bleed_pts
                        bleed_outer_poly = rect_poly.buffer(bleed_pts, join_style=2)  # miter
                    else:
                        bleed_outer_poly = rect_poly
                    if self.debug:
                        logger.warning(">>> RECTANGLE MODE: page %.1fx%.1f pt, bleed_pts=%.2f", page_in_width, page_in_height, bleed_pts)
                
                elif cut_mode != "none" and len(contours) > 0:
                    debug_step = f"Process Contours Page {page_idx}"
                    poly_scale = 1.0 / self.scale
                    
                    raw_polys = []
                    for contour in contours:
                        contour = contour - 1
                        contour_pts = contour[:, [1, 0]] * poly_scale
                        
                        # Chỉ làm mượt khi góc TRÒN. Với góc nhọn/vuông (miter),
                        # smoothing sẽ bo mềm các góc đáng lẽ phải sắc → sai kiểu góc.
                        if corner_style == "round" and len(contour_pts) >= 10:
                            # Window gắn theo ĐỘ DÀI VẬT LÝ cố định (~1mm chu vi), KHÔNG
                            # theo số điểm. Bản cũ (n_pts/30) tỉ lệ độ phân giải: nhãn to +
                            # scale cao (3901 điểm) đẩy window lên 130 điểm ≈ 11mm → trung
                            # bình trượt 11mm bo góc nhãn thành cung bán kính vài mm (đường
                            # cắt không bám viền). 1mm đủ khử răng cưa marching-square mà
                            # KHÔNG bo góc thấy được, độc lập scale/kích thước nhãn.
                            SMOOTH_MM = 1.0
                            window = int(round(SMOOTH_MM * mm_to_pts * self.scale))
                            window = max(3, min(window, len(contour_pts) // 4))
                            padded = np.pad(contour_pts, ((window, window), (0, 0)), mode='wrap')
                            kernel = np.ones(window) / window
                            sm_x = np.convolve(padded[:, 0], kernel, mode='same')
                            sm_y = np.convolve(padded[:, 1], kernel, mode='same')
                            contour_pts = np.column_stack((sm_x[window:-window], sm_y[window:-window]))

                        if len(contour_pts) >= 3:
                            poly = Polygon(contour_pts)
                            if poly.is_valid:
                                # KHÔNG nén điểm ở đây nữa! Nếu nén ở đây, hàm buffer() ở dưới sẽ khóa cứng các đường thẳng.
                                # Chỉ dọn dẹp nhẹ để giữ topology
                                poly = poly.simplify(0.1, preserve_topology=True)
                                raw_polys.append(poly)
                                
                    if raw_polys:
                        holes = []
                        exteriors = []
                        for p in raw_polys:
                            is_hole = False
                            pb = p.bounds
                            for other in raw_polys:
                                if p != other:
                                    ob = other.bounds
                                    if ob[0] <= pb[0] and ob[1] <= pb[1] and ob[2] >= pb[2] and ob[3] >= pb[3]:
                                        if other.contains(p):
                                            is_hole = True
                                            break
                            if is_hole:
                                holes.append(p)
                            else:
                                exteriors.append(p)
                                
                        base_dieline = unary_union(exteriors)
                        if not fill_holes:
                            for h in holes:
                                base_dieline = base_dieline.difference(h)

                        # Reconstruct hình học chuẩn (auto_safe / force_*).
                        # Tem tròn khuyết / CUSTOM → reject → giữ contour.
                        recon_meta = {"shape_mode": shape_mode, "reconstructed": False}
                        cut_draw_style = corner_style
                        try:
                            from app.workers.sticker_cut_reconstruct import (
                                reconstruct_cut_coords,
                                coords_to_shapely_polygon,
                            )
                            _probe = base_dieline
                            if getattr(_probe, "geom_type", None) == "Polygon" and not _probe.is_empty:
                                _coords, recon_meta = reconstruct_cut_coords(
                                    list(_probe.exterior.coords), shape_mode, px_per_mm
                                )
                                if _coords is not None:
                                    _fitted = coords_to_shapely_polygon(_coords)
                                    if _fitted is not None and not _fitted.is_empty:
                                        base_dieline = _fitted
                                        if recon_meta.get("kind") in ("rect", "triangle"):
                                            cut_draw_style = "miter"
                        except Exception as _recon_err:
                            logger.warning("shape reconstruct skip: %s", _recon_err)
                            recon_meta = {
                                "shape_mode": shape_mode,
                                "reconstructed": False,
                                "error": str(_recon_err),
                            }

                        # Vị trí đường cắt + mép ngoài bù xén — xem compute_cut_bleed_offsets.
                        total_offset, bleed_outer_offset = compute_cut_bleed_offsets(
                            cut_mode, bleed_pts, offset_pts
                        )

                        if recon_meta.get("reconstructed") and recon_meta.get("kind") in ("circle", "ellipse", "rounded_rect"):
                            join_style = 1
                        elif recon_meta.get("reconstructed") and recon_meta.get("kind") in ("rect", "triangle"):
                            join_style = 2
                        else:
                            join_style = 1 if corner_style == "round" else 2

                        # dieline_poly = CUT LINE position
                        if total_offset != 0:
                            dieline_poly = base_dieline.buffer(total_offset, join_style=join_style)
                            if total_offset < 0:
                                dieline_poly = dieline_poly.buffer(0.01, join_style=join_style)
                        else:
                            dieline_poly = base_dieline

                        # bleed_outer_poly = mép ngoài vùng màu bù xén
                        if bleed_outer_offset != 0:
                            bleed_outer_poly = base_dieline.buffer(bleed_outer_offset, join_style=join_style)
                        else:
                            bleed_outer_poly = base_dieline

                        if fill_holes:
                            if dieline_poly.geom_type == 'MultiPolygon':
                                dieline_poly = MultiPolygon([Polygon(p.exterior) for p in dieline_poly.geoms])
                            elif dieline_poly.geom_type == 'Polygon':
                                dieline_poly = Polygon(dieline_poly.exterior)
                            if bleed_outer_poly.geom_type == 'MultiPolygon':
                                bleed_outer_poly = MultiPolygon([Polygon(p.exterior) for p in bleed_outer_poly.geoms])
                            elif bleed_outer_poly.geom_type == 'Polygon':
                                bleed_outer_poly = Polygon(bleed_outer_poly.exterior)

                        # Reconstruct → nén nhẹ; contour → 1.0 pt (giữ hành vi cũ).
                        _cut_simplify = 0.05 if recon_meta.get("reconstructed") else 1.0
                        if isinstance(dieline_poly, MultiPolygon):
                            _cut_parts = []
                            for p in dieline_poly.geoms:
                                _s = p.simplify(_cut_simplify, preserve_topology=False)
                                if _s.is_empty:
                                    continue
                                if isinstance(_s, MultiPolygon):
                                    _cut_parts.extend(g for g in _s.geoms if not g.is_empty)
                                else:
                                    _cut_parts.append(_s)
                            cut_poly = MultiPolygon(_cut_parts) if _cut_parts else dieline_poly
                        else:
                            cut_poly = dieline_poly.simplify(_cut_simplify, preserve_topology=False)

                # ============================================================
                # STEP B: Generate bleed using dieline_poly for perfect alignment
                # ============================================================
                if bleed_mm > 0.0 and not use_vector_rectangle_bleed:
                    debug_step = f"Generate Bleed Page {page_idx}"
                    bleed_px = math.ceil(bleed_mm * px_per_mm)
                    if bleed_px > 0:
                        kernel_type = cv2.MORPH_ELLIPSE if (corner_style == "round" and cut_mode != "none") else cv2.MORPH_RECT
                        
                        # Determine pad_b: must be large enough for the bleed outer boundary
                        if bleed_outer_poly is not None and not getattr(bleed_outer_poly, 'is_empty', True):
                            pad_b = math.ceil(abs(bleed_outer_offset) * self.scale) + 2
                        elif dieline_poly is not None and not getattr(dieline_poly, 'is_empty', True):
                            pad_b = math.ceil(abs(total_offset) * self.scale) + 2
                        else:
                            pad_b = bleed_px
                        # Ensure pad_b is at least bleed_px
                        pad_b = max(pad_b, bleed_px)
                        
                        _, aa_mask_bin = cv2.threshold(aa_mask, 127, 255, cv2.THRESH_BINARY)
                        padded_mask = np.pad(aa_mask_bin, pad_width=pad_b, mode='constant', constant_values=0)
                        
                        # Original (unsmoothed) mask for bleed_ring inner boundary
                        # Prevents bleed from entering artwork at smoothing-shrunken edges
                        padded_original_mask = np.pad(mask, pad_width=pad_b, mode='constant', constant_values=0)
                        
                        _, raw_mask_bin = cv2.threshold(raw_mask, 10, 255, cv2.THRESH_BINARY)
                        padded_raw_mask = np.pad(raw_mask_bin, pad_width=pad_b, mode='constant', constant_values=0)
                        
                        padded_img = np.pad(img_native, pad_width=((pad_b, pad_b), (pad_b, pad_b), (0, 0)), mode='constant', constant_values=255)
                        
                        # Nguồn màu = dải VIỀN tem gốc (shell), không erode cả ruột.
                        # - peel ~0.08mm: bỏ 1 lớp AA trộn nền ở mép render.
                        # - band ~0.25mm: lấy màu thật ngay sau peel (đúng "màu viền tem").
                        # - edge_bite: co silhouette trước (doa viền trắng file không tràn lề).
                        # Fallback trong _build_edge_color_source_mask nếu shell rỗng.
                        edge_bite_px = max(0, int(edge_bite_mm * px_per_mm))
                        peel_px = max(1, int(0.08 * px_per_mm))
                        edge_band_px = max(2, int(0.25 * px_per_mm))
                        # depth dùng cho band_r (halo nearest): xa nhất nguồn có thể lùi vào trong.
                        source_depth_px = edge_bite_px + peel_px + edge_band_px
                        color_source_mask = _build_edge_color_source_mask(
                            padded_original_mask,
                            padded_img,
                            band_px=edge_band_px,
                            peel_px=peel_px,
                            edge_bite_px=edge_bite_px,
                            kernel_type=kernel_type,
                            exclude_near_white=not rectangle_mode,
                        )
                        # Giữ tên inset_px cho log/công thức band cũ (tương đương depth nguồn).
                        inset_px = max(1, source_depth_px)

                        # Generate bleed_mask from bleed_outer_poly (extends BEYOND cut line)
                        if bleed_outer_poly is not None and not getattr(bleed_outer_poly, 'is_empty', True):
                            if self.debug:
                                logger.warning(">>> RASTERIZE METHOD: Using bleed_outer_poly to generate bleed_mask (pad_b=%d, bleed_outer_offset=%.2f, scale=%.4f)", pad_b, bleed_outer_offset, self.scale)
                            mask_h, mask_w = padded_mask.shape
                            bleed_mask = np.zeros((mask_h, mask_w), dtype=np.uint8)
                            
                            def _rasterize_poly(poly_geom, target_mask, scale, pad):
                                if isinstance(poly_geom, MultiPolygon):
                                    for p in poly_geom.geoms:
                                        _rasterize_poly(p, target_mask, scale, pad)
                                    return
                                ext = np.array(poly_geom.exterior.coords)
                                ext_px = np.column_stack([
                                    ext[:, 0] * scale + pad,
                                    ext[:, 1] * scale + pad
                                ]).astype(np.int32)
                                cv2.fillPoly(target_mask, [ext_px], 255)
                                for interior in poly_geom.interiors:
                                    int_coords = np.array(interior.coords)
                                    int_px = np.column_stack([
                                        int_coords[:, 0] * scale + pad,
                                        int_coords[:, 1] * scale + pad
                                    ]).astype(np.int32)
                                    cv2.fillPoly(target_mask, [int_px], 0)
                            
                            _rasterize_poly(bleed_outer_poly, bleed_mask, self.scale, pad_b)
                            # 1px safety dilate to cover sub-pixel rounding at polygon edges
                            raster_safety = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
                            bleed_mask = cv2.dilate(bleed_mask, raster_safety)

                            if self.debug:
                                logger.warning(">>> RASTERIZE DONE: bleed_mask nonzero=%d, padded_mask nonzero=%d", np.count_nonzero(bleed_mask), np.count_nonzero(padded_mask))
                                try:
                                    debug_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'debug_output')
                                    os.makedirs(debug_dir, exist_ok=True)
                                    debug_img = np.zeros((mask_h, mask_w, 3), dtype=np.uint8)
                                    debug_img[bleed_mask > 0] = [0, 255, 0]  # Green = bleed area
                                    debug_img[padded_mask > 0] = [255, 255, 255]  # White = artwork
                                    cv2.imwrite(os.path.join(debug_dir, 'debug_bleed_mask.png'), debug_img)
                                    logger.warning(">>> DEBUG IMAGE SAVED to %s", debug_dir)
                                except Exception as e:
                                    logger.warning(">>> DEBUG IMAGE FAILED: %s", e)
                        else:
                            if self.debug:
                                logger.warning(">>> FALLBACK METHOD: Using cv2.dilate (no dieline_poly)")
                            kernel = cv2.getStructuringElement(kernel_type, (bleed_px*2+1, bleed_px*2+1))
                            bleed_mask = cv2.dilate(padded_mask, kernel)
                        
                        if fill_holes:
                            # Fill any holes/bays that were bridged so the bleed color covers everything inside.
                            b_contours, _ = cv2.findContours(bleed_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                            cv2.drawContours(bleed_mask, b_contours, -1, 255, cv2.FILLED)
                            
                        # Create "sticker footprint" - a SOLID mask covering the entire sticker
                        # including internal white gaps (between rainbow arcs, inside letters, etc.)
                        # This prevents bleed from appearing in internal white areas of the design.
                        close_px = max(10, int(1.5 * px_per_mm))  # ~1.5mm closing radius
                        close_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close_px*2+1, close_px*2+1))
                        closed_mask = cv2.morphologyEx(padded_original_mask, cv2.MORPH_CLOSE, close_kernel)
                        foot_contours, _ = cv2.findContours(closed_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                        sticker_footprint = np.zeros_like(padded_original_mask)
                        cv2.drawContours(sticker_footprint, foot_contours, -1, 255, cv2.FILLED)

                        # "Lẹm mép" (doa nền kiểu Photoshop): co footprint vào trong edge_bite_px.
                        # Artwork (layer trên) bị clip theo footprint → co vào để lộ dải bleed bên
                        # dưới ở đúng viền trắng mảnh của file nguồn. bleed_ring = bleed_mask − footprint
                        # nên footprint co lại thì ring TỰ lan vào trong phủ viền trắng đó. Nguồn màu
                        # (_build_edge_color_source_mask) cũng bite cùng lượng → lấy màu viền sau khi
                        # đã bỏ dải trắng, kéo phủ ra. Lẹm quá tay ăn nội dung sát mép — mặc định
                        # nhỏ / 0 khi tem đã tràn lề.
                        if edge_bite_px > 0:
                            bite_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (edge_bite_px*2+1, edge_bite_px*2+1))
                            sticker_footprint = cv2.erode(sticker_footprint, bite_kernel)

                        # bleed_ring = vùng giữa footprint và đường cắt. NỚI mép trong
                        # VÀO TRONG vài px: SMask lùa xuống DƯỚI artwork (layer trên phủ
                        # footprint) → bịt khe hở subpixel ở mối nối raster(SMask)↔clip-vector,
                        # tránh hở nền tạo sợi mảnh. Phần nới nằm dưới artwork nên vô hình.
                        _tuck_px = max(1, int(0.2 * px_per_mm))
                        _fp_inner = cv2.erode(sticker_footprint, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (_tuck_px*2+1, _tuck_px*2+1)))
                        bleed_ring = cv2.subtract(bleed_mask, _fp_inner)
                        
                        # Band = dải quanh ring, đủ rộng để chứa nguồn màu viền (source_depth)
                        # + bleed ngoài + tuck. Nguồn là shell mép, không còn full-interior.
                        _SAFETY = 4
                        band_r = int(bleed_px + inset_px + _tuck_px + 1 + _SAFETY)
                        band_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (band_r*2+1, band_r*2+1))
                        band = cv2.dilate(bleed_ring, band_kernel)

                        is_bleed_cmyk = False
                        if bleed_color_type == "image":
                            # 'Kéo giãn mép ảnh' — nearest-color giới hạn theo band (tile + bỏ ô ruột).
                            bleed_colors = np.zeros_like(padded_img)
                            if not _banded_nearest_fill(color_source_mask, padded_img, bleed_ring, band, band_r, out=bleed_colors):
                                # Guard tripped (artwork mảnh / nguồn ngoài halo) → full-ROI (không tệ hơn).
                                roi = _bleed_roi_bbox(bleed_mask, margin=8)
                                bleed_colors = np.zeros_like(padded_img)
                                if roi is not None:
                                    y0, y1, x0, x1 = roi
                                    bleed_colors[y0:y1, x0:x1] = _nearest_color_fill(
                                        color_source_mask[y0:y1, x0:x1], padded_img[y0:y1, x0:x1]
                                    )
                                else:
                                    bleed_colors = _nearest_color_fill(color_source_mask, padded_img)
                        elif bleed_color_type == "inpaint" and rectangle_mode:
                            bleed_colors = _rectangle_smooth_color_fill(
                                img_native, pad_b, edge_bite_px, px_per_mm
                            )
                        elif bleed_color_type == "inpaint":
                            # 'Làm mượt thông minh' — inpaint giới hạn theo band (tile + bỏ ô ruột).
                            bleed_colors = np.zeros_like(padded_img)
                            if not _banded_inpaint_fill(padded_img, color_source_mask, bleed_mask, bleed_ring, band, band_r, out=bleed_colors):
                                roi = _bleed_roi_bbox(bleed_mask, margin=8)
                                bleed_colors = np.zeros_like(padded_img)
                                if roi is not None:
                                    y0, y1, x0, x1 = roi
                                    bleed_colors[y0:y1, x0:x1] = _inpaint_color_fill(
                                        padded_img[y0:y1, x0:x1],
                                        color_source_mask[y0:y1, x0:x1], bleed_mask[y0:y1, x0:x1],
                                    )
                                else:
                                    bleed_colors = _inpaint_color_fill(padded_img, color_source_mask, bleed_mask)
                        else:
                            if len(solid_bleed_color) == 4:
                                is_bleed_cmyk = True
                                bg_canvas = np.zeros((padded_img.shape[0], padded_img.shape[1], 4), dtype=np.uint8)
                                bg_canvas[:] = solid_bleed_color
                            else:
                                bg_canvas = np.zeros_like(padded_img)
                                bg_canvas[:] = solid_bleed_color
                            bleed_colors = bg_canvas

                        # KHÔNG mask màu về canvas ĐEN nữa: trước đây bleed_result=zeros
                        # rồi chỉ copy ring → vùng interior (ngoài ring) là ĐEN, tạo cạnh
                        # màu↔đen ở biên trong ring. Khi PDF render nội suy ảnh+SMask ở cạnh
                        # đó → pixel alpha-một-phần = màu TRỘN đen = SỢI XÁM mảnh (lộ cả khi
                        # bleed trắng: 255↔0 = xám). bleed_colors đã có màu LIÊN TỤC toàn ROI
                        # (nearest/inpaint/solid fill) → dùng trực tiếp, cạnh chỉ còn màu↔màu.
                        bleed_rgb = bleed_colors

                        # image/inpaint được lấy từ bản render RGB của chính artwork, vì
                        # vậy phải giữ DeviceRGB để bảo toàn đúng các mẫu màu đã lấy ở mép.
                        # Không thể khôi phục CMYK gốc bằng C=255-R, M=255-G, Y=255-B,
                        # K=0: phép đó làm mất K/ICC/spot alternate và gây lệch màu khi RIP.
                        # Chỉ nhánh solid có 4 kênh do người dùng nhập mới là DeviceCMYK.

                        # LOSSLESS (zlib/FlateDecode) cho CẢ RGB lẫn CMYK. TRƯỚC đây RGB
                        # lưu JPEG q90 → ringing (Gibbs) ở mọi ranh giới tương phản cao:
                        # dải pixel bị kéo về trung tính = VIỀN XÁM nhạt ở biên hình↔bleed,
                        # lộ cả khi bleed trắng (255↔0 qua JPEG thành xám). Ring hẹp (bleed
                        # 1-3mm) + vùng ngoài ring = 0 nên zlib nén rất tốt, dung lượng không
                        # đáng ngại. Nhánh CMYK vốn đã né JPEG (Adobe inversion) — nay RGB cũng vậy.
                        bleed_stream_data = zlib.compress(bleed_rgb.tobytes())
                        img_w, img_h = bleed_rgb.shape[1], bleed_rgb.shape[0]
                            
                        mask_bytes_data = zlib.compress(bleed_ring.tobytes())
                        
                        # Save comprehensive debug images for first page
                        if page_idx == 0 and self.debug:
                            try:
                                debug_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'debug_output')
                                os.makedirs(debug_dir, exist_ok=True)
                                cv2.imwrite(os.path.join(debug_dir, 'debug_bleed_ring.png'), bleed_ring)
                                cv2.imwrite(os.path.join(debug_dir, 'debug_bleed_result.png'), cv2.cvtColor(bleed_rgb[:,:,:3], cv2.COLOR_RGB2BGR) if not is_bleed_cmyk else bleed_rgb)
                                cv2.imwrite(os.path.join(debug_dir, 'debug_padded_mask.png'), padded_mask)
                                cv2.imwrite(os.path.join(debug_dir, 'debug_sticker_footprint.png'), sticker_footprint)
                                logger.warning(">>> BLEED DEBUG: bleed_ring nonzero=%d, bleed_rgb mean=%s, bleed_color_type=%s", np.count_nonzero(bleed_ring), np.mean(bleed_rgb[bleed_ring > 0], axis=0) if np.count_nonzero(bleed_ring) > 0 else 'N/A', bleed_color_type)
                            except Exception as e:
                                logger.warning(">>> BLEED DEBUG FAILED: %s", e)

                # One source Form XObject is reused by the vector bleed strips and
                # by the original artwork layer. Its resources retain CMYK/ICC/spot.
                src_xobj = page_in_pike.as_form_xobject()
                src_xobj_name = page_out.add_resource(src_xobj, pikepdf.Name.XObject)

                page_content_stream = []
                vector_bite_x = 0.0
                vector_bite_y = 0.0
                if use_vector_rectangle_bleed:
                    vector_ops, vector_bite_x, vector_bite_y = _rectangle_vector_bleed_commands(
                        src_xobj_name,
                        crop_x0=crop_x0,
                        crop_y0=crop_y0,
                        page_width=page_in_width,
                        page_height=page_in_height,
                        bleed_pts=bleed_pts,
                        edge_bite_pts=max(0.0, edge_bite_mm * mm_to_pts),
                        sample_depth_pts=72.0 / max(1, self.dpi),
                    )
                    page_content_stream.extend(vector_ops)

                # LAYER 1 (BOTTOM): Bleed color with SMask
                if bleed_stream_data:
                    img_w_pt = float(img_w) / self.scale
                    img_h_pt = float(img_h) / self.scale
                    
                    mask_obj = pikepdf.Stream(doc_out, mask_bytes_data)
                    mask_obj.Type = pikepdf.Name.XObject
                    mask_obj.Subtype = pikepdf.Name.Image
                    mask_obj.Width = bleed_ring.shape[1]
                    mask_obj.Height = bleed_ring.shape[0]
                    mask_obj.ColorSpace = pikepdf.Name.DeviceGray
                    mask_obj.BitsPerComponent = 8
                    mask_obj.Filter = pikepdf.Name.FlateDecode
                    
                    img_obj = pikepdf.Stream(doc_out, bleed_stream_data)
                    img_obj.Type = pikepdf.Name.XObject
                    img_obj.Subtype = pikepdf.Name.Image
                    img_obj.Width = img_w
                    img_obj.Height = img_h
                    if is_bleed_cmyk:
                        img_obj.ColorSpace = pikepdf.Name.DeviceCMYK
                    else:
                        if srgb_colorspace is None:
                            srgb_colorspace = _make_srgb_colorspace(doc_out)
                        img_obj.ColorSpace = srgb_colorspace
                    img_obj.BitsPerComponent = 8
                    # Cả 2 nhánh nay đều zlib (lossless) → FlateDecode. Trước RGB là DCTDecode (JPEG).
                    img_obj.Filter = pikepdf.Name.FlateDecode
                    img_obj.SMask = mask_obj
                    
                    img_name = page_out.add_resource(img_obj, pikepdf.Name.XObject)
                    
                    shift_x = max_expansion_pts - (pad_b / self.scale)
                    shift_y = max_expansion_pts - (pad_b / self.scale)

                    if self.debug:
                        # So khớp 2 layer: bleed (raster, neo self.scale) vs artwork
                        # (vector 1:1, neo crop_x0). artwork phải rộng ĐÚNG page_in_width;
                        # bleed artwork-portion rộng img_native_px/self.scale. Lệch ⇒ pdfium
                        # render khác box ta giả định (CropBox) hoặc self.scale sai.
                        _art_px_w = img_w - 2 * pad_b
                        _art_px_h = img_h - 2 * pad_b
                        logger.warning(
                            ">>> ALIGN p%d: page_in=%.3fx%.3f pt | render_px=%dx%d → /scale=%.3fx%.3f pt | scale=%.5f (base=%.5f) | crop0=(%.3f,%.3f) | img_w_pt=%.3f shift=(%.3f,%.3f) max_exp=%.3f pad_b=%d",
                            page_idx, page_in_width, page_in_height,
                            _art_px_w, _art_px_h, _art_px_w / self.scale, _art_px_h / self.scale,
                            self.scale, base_scale, crop_x0, crop_y0,
                            img_w_pt, shift_x, shift_y, max_expansion_pts, pad_b,
                        )

                    page_content_stream.append("q")
                    page_content_stream.append(f"{img_w_pt:.4f} 0 0 {img_h_pt:.4f} {shift_x:.4f} {shift_y:.4f} cm")
                    page_content_stream.append(f"{str(img_name)} Do")
                    page_content_stream.append("Q")

                # LAYER 2 (TOP): Artwork gốc — GIỮ NGUYÊN VECTOR, KHÔNG raster hoá.
                # Trước đây artwork bị render thành JPEG 300 DPI (mất nét vector + lệch
                # màu RGB). Nay luôn vẽ lại form XObject gốc. Khi có bleed: clip artwork
                # vào đúng footprint (CÙNG biên với bleed_ring → không hở mép trắng),
                # phần ngoài footprint để lộ bleed bên dưới.

                page_content_stream.append("q")
                if use_vector_rectangle_bleed and (vector_bite_x > 0 or vector_bite_y > 0):
                    clip_x = bleed_pts + vector_bite_x
                    clip_y = bleed_pts + vector_bite_y
                    clip_w = max(0.01, page_in_width - 2.0 * vector_bite_x)
                    clip_h = max(0.01, page_in_height - 2.0 * vector_bite_y)
                    page_content_stream.append(
                        f"{clip_x:.4f} {clip_y:.4f} {clip_w:.4f} {clip_h:.4f} re W n"
                    )
                elif bleed_stream_data and sticker_footprint is not None:
                    # Trace footprint (đã đóng kín, hole-filled) thành đường clip vector.
                    # footprint là raster trong KHÔNG GIAN ẢNH ĐỆM (padded); ánh xạ về
                    # toạ độ trang giống vị trí đặt ảnh bleed: (shift_x + px/scale,
                    # shift_y + (h - py)/scale). Nhờ vậy biên clip khớp tuyệt đối bleed_ring.
                    fp_h_px = sticker_footprint.shape[0]
                    fp_contours, _ = cv2.findContours(sticker_footprint, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                    inv_scale = 1.0 / self.scale
                    clip_ops = []
                    for cnt in fp_contours:
                        pts = cnt.reshape(-1, 2)
                        if len(pts) < 3:
                            continue
                        x0 = shift_x + pts[0][0] * inv_scale
                        y0 = shift_y + (fp_h_px - pts[0][1]) * inv_scale
                        clip_ops.append(f"{x0:.3f} {y0:.3f} m")
                        for px, py in pts[1:]:
                            x = shift_x + px * inv_scale
                            y = shift_y + (fp_h_px - py) * inv_scale
                            clip_ops.append(f"{x:.3f} {y:.3f} l")
                        clip_ops.append("h")
                    if clip_ops:
                        page_content_stream.extend(clip_ops)
                        page_content_stream.append("W n")
                # Form XObject giữ toạ độ gốc của trang (BBox = CropBox, bắt đầu ở
                # crop_x0/crop_y0), trong khi bleed + contour ở "local crop space"
                # (gốc 0,0). Phải dịch thêm -crop_x0/-crop_y0 để artwork khớp bleed;
                # nếu không artwork lệch đúng bằng gốc CropBox và bị footprint clip cắt.
                art_shift_x = max_expansion_pts - crop_x0
                art_shift_y = max_expansion_pts - crop_y0
                page_content_stream.append(f"1 0 0 1 {art_shift_x:.4f} {art_shift_y:.4f} cm")
                page_content_stream.append(f"{str(src_xobj_name)} Do")
                page_content_stream.append("Q")



                # "Tạo đường cắt cho trang đầu": trang 2+ CHỈ bù xén, không vẽ đường
                # cắt → file nhiều loại tem CÙNG khuôn, trang 1 mang khuôn master để
                # tool Bình tem bế/CNC (chế độ đồng nhất) lấy làm dieline chung.
                _cut_page_ok = (not cut_first_page_only) or (page_idx == 0)
                if _cut_page_ok and draw_cut_contour and cut_mode != "none" and cut_poly is not None and not getattr(cut_poly, 'is_empty', True):
                    debug_step = "Draw Cut Contour"
                    
                    page_content_stream.append("q")
                    page_content_stream.append(f"1 0 0 1 {max_expansion_pts:.4f} {max_expansion_pts:.4f} cm")
                    
                    page_content_stream.append("/CutContour CS")
                    page_content_stream.append("1.0 SCN")
                    page_content_stream.append("1.0 w")

                    # cut_poly có thể là Polygon, MultiPolygon, hoặc (khi buffer âm lớn teo
                    # tách shape) GeometryCollection/LineString KHÔNG có .exterior. Gom chỉ
                    # các thành viên là Polygon (có .exterior) → tránh AttributeError crash.
                    if isinstance(cut_poly, MultiPolygon):
                        raw_geoms = list(cut_poly.geoms)
                    elif hasattr(cut_poly, 'geoms'):  # GeometryCollection
                        raw_geoms = list(cut_poly.geoms)
                    else:
                        raw_geoms = [cut_poly]
                    geoms = [g for g in raw_geoms if g.geom_type == 'Polygon' and not g.is_empty]
                    for p in geoms:
                        coords = list(p.exterior.coords)
                        if coords:
                            page_content_stream.extend(
                                build_contour_path_stream(coords, page_in_height, cut_draw_style)
                            )
                        for inter in p.interiors:
                            icoords = list(inter.coords)
                            if icoords:
                                page_content_stream.extend(
                                    build_contour_path_stream(icoords, page_in_height, cut_draw_style)
                                )

                    page_content_stream.append("S")
                    page_content_stream.append("Q")

                full_content = "\n".join(page_content_stream).encode('ascii')
                page_out.contents_add(pikepdf.Stream(doc_out, full_content))
                
                if "/Resources" not in page_out:
                    page_out.Resources = pikepdf.Dictionary()
                if "/ColorSpace" not in page_out.Resources:
                    page_out.Resources.ColorSpace = pikepdf.Dictionary()
                page_out.Resources.ColorSpace.CutContour = cs_arr
                
                page_meta = {"recon": recon_meta}
                if dieline_poly is not None and not getattr(dieline_poly, 'is_empty', True):
                    any_dieline_found = True
                    minx, miny, maxx, maxy = dieline_poly.bounds
                    pdf_miny = page_in_height - maxy
                    pdf_maxy = page_in_height - miny
                    
                    minx += max_expansion_pts
                    pdf_miny += max_expansion_pts
                    maxx += max_expansion_pts
                    pdf_maxy += max_expansion_pts
                    
                    box_arr = pikepdf.Array([minx, pdf_miny, maxx, pdf_maxy])
                    page_out.TrimBox = box_arr
                    page_out.ArtBox = box_arr
                    # Khung trang phải ôm đúng phần có thể nhìn/in: đường bế + mép ngoài
                    # bù xén. Trước đây chỉ có TrimBox, còn MediaBox/CropBox vẫn là canvas
                    # lớn nên nhiều viewer/RIP hiện khoảng trắng quanh tem.
                    visible_geoms = [dieline_poly]
                    if bleed_outer_poly is not None and not getattr(bleed_outer_poly, 'is_empty', True):
                        visible_geoms.append(bleed_outer_poly)
                    visible_bounds = [g.bounds for g in visible_geoms]
                    vis_minx = min(b[0] for b in visible_bounds)
                    vis_miny = min(b[1] for b in visible_bounds)
                    vis_maxx = max(b[2] for b in visible_bounds)
                    vis_maxy = max(b[3] for b in visible_bounds)

                    # CutContour rộng 1pt và stroke nằm giữa path: chừa nửa stroke
                    # để không bị CropBox cắt cụt khi đường bế cũng là mép ngoài cùng.
                    crop_guard = 0.55 if draw_cut_contour and cut_mode != "none" else 0.0
                    crop_box = [
                        max(0.0, vis_minx + max_expansion_pts - crop_guard),
                        max(0.0, page_in_height - vis_maxy + max_expansion_pts - crop_guard),
                        min(new_width, vis_maxx + max_expansion_pts + crop_guard),
                        min(new_height, page_in_height - vis_miny + max_expansion_pts + crop_guard),
                    ]
                    if crop_box[2] > crop_box[0] and crop_box[3] > crop_box[1]:
                        # MediaBox cũng phải siết theo CropBox. Nhiều RIP/renderer mặc
                        # định hiển thị MediaBox (không phải CropBox); nếu chỉ set CropBox
                        # thì chúng vẫn cho thấy canvas trắng kỹ thuật ở bên ngoài.
                        page_out.MediaBox = pikepdf.Array(crop_box)
                        page_out.CropBox = pikepdf.Array(crop_box)
                        page_out.BleedBox = pikepdf.Array(crop_box)
                    
                    # Generate Meta for this page.
                    # Dùng bounds GỐC của dieline_poly (trước khi cộng max_expansion_pts)
                    # để raster shape_mask phục vụ nhận diện hình dạng.
                    scale = 300.0 / 72.0
                    minx_orig, miny_orig, maxx_orig, maxy_orig = dieline_poly.bounds
                    width_pt = maxx_orig - minx_orig
                    height_pt = maxy_orig - miny_orig
                    width_mm = width_pt * (25.4 / 72.0)
                    height_mm = height_pt * (25.4 / 72.0)
                    mask_w = int(np.ceil(width_pt * scale))
                    mask_h = int(np.ceil(height_pt * scale))
                    shape_mask = np.zeros((mask_h, mask_w), dtype=np.uint8)
                    
                    def fill_poly(poly_geom):
                        if poly_geom.is_empty: return
                        if isinstance(poly_geom, MultiPolygon):
                            for p in poly_geom.geoms: fill_poly(p)
                            return
                        exterior = np.array([[(c[0] - minx_orig) * scale, (c[1] - miny_orig) * scale] for c in poly_geom.exterior.coords], dtype=np.int32)
                        cv2.fillPoly(shape_mask, [exterior], color=255)
                        for interior in poly_geom.interiors:
                            inter = np.array([[(c[0] - minx_orig) * scale, (c[1] - miny_orig) * scale] for c in interior.coords], dtype=np.int32)
                            cv2.fillPoly(shape_mask, [inter], color=0)
                    
                    fill_poly(cut_poly if cut_poly is not None else dieline_poly)
                    
                    from app.workers.shape_analyzer import detect_shape, extract_shape_properties
                    shape_type_enum = detect_shape(shape_mask)
                    shape_type_str = shape_type_enum.name
                    shape_params = extract_shape_properties(shape_mask)
                    
                    if shape_type_enum == ShapeType.HAMMER:
                        shape_params['effective_body_w_ratio'] = shape_params.get('bigEndAxisFrac', 0.37)
                    elif shape_type_enum == ShapeType.DUMBBELL:
                        shape_params['effective_body_w_ratio'] = shape_params.get('bigEndAxisFrac', 0.65)
                        
                    shape_params_str = json.dumps(shape_params)
                    
                    boxes = []
                    _meta_poly = cut_poly if cut_poly is not None else dieline_poly
                    geoms = _meta_poly.geoms if isinstance(_meta_poly, MultiPolygon) else [_meta_poly]
                    for p in geoms:
                        p_minx, p_miny, p_maxx, p_maxy = p.bounds
                        p_w_pt = p_maxx - p_minx
                        p_h_pt = p_maxy - p_miny
                        boxes.append({
                            "x_pt": round(p_minx, 2),
                            "y_pt": round(p_miny, 2),
                            "w_pt": round(p_w_pt, 2),
                            "h_pt": round(p_h_pt, 2),
                            "w_mm": round(p_w_pt * 25.4 / 72.0, 2),
                            "h_mm": round(p_h_pt * 25.4 / 72.0, 2)
                        })
                    
                    # Hình học đường cắt đã reconstruct (auto_safe): kind + độ tin cậy.
                    # kind None / reconstructed=False → giữ contour (die phức tạp).
                    _rk = recon_meta.get("kind") if recon_meta.get("reconstructed") else None
                    _res = recon_meta.get("residual_mm")
                    # confidence từ residual: 0mm→1.0, ≥0.35mm→~0.0 (tuyến tính, clamp).
                    if _rk and isinstance(_res, (int, float)):
                        _conf = max(0.0, min(1.0, 1.0 - _res / 0.35))
                    else:
                        _conf = None
                    page_meta = {
                        "width_mm": round(width_mm, 2),
                        "height_mm": round(height_mm, 2),
                        "boxes": boxes,
                        "shape_type": shape_type_str,
                        "shape_params": shape_params_str,
                        "cut_kind": _rk,
                        "cut_confidence": round(_conf, 2) if _conf is not None else None,
                    }
                elif cut_mode != "none":
                    # Yêu cầu tạo đường cắt nhưng không dò được hình trên trang này.
                    pages_no_dieline.append(page_idx + 1)
                
                all_pages_meta.append(page_meta)

            # CHẾ ĐỘ WORKER (song song): trả MẢNH THÔ (bytes + meta các trang của chunk
            # này + pages_no_dieline GLOBAL 1-based + cờ any_dieline) cho orchestrator gộp,
            # KHÔNG finalize (không ghi output_path, không dựng final_meta/error/warning —
            # để orchestrator tổng hợp từ mọi chunk). page_idx trong vòng là index GỐC nên
            # pages_no_dieline đã là số trang GLOBAL, orchestrator không cần offset.
            if _page_subset is not None:
                _buf = io.BytesIO()
                doc_out.save(_buf)
                return (_buf.getvalue(), all_pages_meta, pages_no_dieline, any_dieline_found)

            debug_step = "Save Output PDF"
            doc_out.save(output_path)

            # Watermark (stealth) được áp ở tầng route qua _safe_watermark(license_info),
            # nhất quán với các endpoint pdf-tools khác. Engine KHÔNG có thông tin license
            # nên không tự nhúng ở đây (trước đây gọi `settings` chưa định nghĩa → crash).

            # Instead of returning a single meta dict, we return a dict with a 'pages' array
            # And for backward compatibility, keep the first page's meta at the top level
            final_meta = {}
            if len(all_pages_meta) > 0 and all_pages_meta[0]:
                final_meta = all_pages_meta[0].copy()
            final_meta["pages"] = all_pages_meta

            # Yêu cầu vẽ đường cắt nhưng KHÔNG dò được hình trên BẤT KỲ trang nào →
            # trả lỗi nghiệp vụ rõ ràng (route → 422) thay vì file "thành công" rỗng.
            if cut_mode != "none" and not any_dieline_found:
                try:
                    if os.path.exists(output_path):
                        os.remove(output_path)
                except OSError:
                    pass
                return False, {
                    "error": (
                        "Không dò được hình để tạo đường cắt. Hãy bật 'Bỏ nền trắng' "
                        "nếu nền màu trắng, hoặc kiểm tra lại file (hình quá nhạt/trống)."
                    )
                }
            if pages_no_dieline:
                final_meta["warning"] = (
                    "Một số trang không dò được hình để tạo đường cắt: "
                    + ", ".join(str(p) for p in pages_no_dieline)
                )

            return True, final_meta
            
        except Exception as e:
            logger.error(f"Sticker processing failed at {debug_step}: {e}", exc_info=True)
            # Lấy số dòng trong CHÍNH file này (không phải path hệ thống) để chẩn đoán
            # nhanh dòng nào ném lỗi mà không cần đọc log server.
            import traceback as _tb
            _this = os.path.basename(__file__)
            _line = None
            for _fr in reversed(_tb.extract_tb(e.__traceback__)):
                if os.path.basename(_fr.filename) == _this:
                    _line = _fr.lineno
                    break
            _loc = f"@{_line}" if _line else ""
            raise RuntimeError(f"[{debug_step}{_loc}] {str(e)}")
        finally:
            if doc_in_pdfium:
                try: doc_in_pdfium.close()
                except Exception: pass
            if doc_in_pike:
                try: doc_in_pike.close()
                except Exception: pass
            if doc_out:
                try: doc_out.close()
                except Exception: pass

    def _process_parallel(self, input_path, output_path, **kw) -> tuple:
        """Fan-out xử lý trang ra nhiều tiến trình con rồi merge kết quả.

        Chia N trang thành W dải liền kề (contiguous), mỗi worker tạo StickerEngine
        riêng xử lý một dải (qua _page_subset) và trả file chunk (bytes) + meta. Gộp
        các chunk theo THỨ TỰ (pikepdf pages.extend, tự kéo spot color /CutContour qua
        copy_foreign), concat meta, tổng hợp any_dieline + pages_no_dieline rồi tái
        tạo final_meta/error/warning Y HỆT nhánh tuần tự.
        """
        import math as _math
        from concurrent.futures import ProcessPoolExecutor
        cut_mode = kw["cut_mode"]

        _probe = pdfium.PdfDocument(input_path)
        n_pages = len(_probe)
        _probe.close()

        available = max(1, (os.cpu_count() or 2) - 1)
        cap = int(os.environ.get("STICKER_MAX_WORKERS", "8"))
        n_workers = max(1, min(available, cap, n_pages))
        chunk_size = max(1, _math.ceil(n_pages / n_workers))
        chunks = [list(range(i, min(i + chunk_size, n_pages)))
                  for i in range(0, n_pages, chunk_size)]

        # CHỐNG OVERSUBSCRIPTION LUỒNG: cv2/numpy-BLAS TỰ đa luồng (mặc định = SỐ NHÂN,
        # vd 16). Nếu mỗi worker vẫn dùng full luồng → n_workers × 16 luồng chen trên
        # số nhân có hạn = thrashing, chỉ được ~2x thay vì ~n_workers×. Chia đều luồng
        # cho các worker: mỗi worker ~ tổng_nhân / n_workers (tối thiểu 1). Worker set
        # cv2.setNumThreads + env BLAS theo số này (đọc từ args["threads_per_worker"]).
        _total_cores = os.cpu_count() or 2
        threads_per_worker = max(1, _total_cores // max(1, n_workers))

        args_list = []
        for ci, page_indices in enumerate(chunks):
            args_list.append({
                "chunk_idx": ci, "page_indices": page_indices,
                "threads_per_worker": threads_per_worker,
                "input_path": input_path, "dpi": self.dpi, "debug": self.debug,
                "cut_mode": cut_mode, "offset_mm": kw["offset_mm"],
                "corner_style": kw["corner_style"], "cut_color": kw["cut_color"],
                "bleed_mm": kw["bleed_mm"], "fill_holes": kw["fill_holes"],
                "remove_white_bg": kw["remove_white_bg"],
                "bleed_color_type": kw["bleed_color_type"],
                "solid_bleed_color": kw["solid_bleed_color"],
                "draw_cut_contour": kw["draw_cut_contour"],
                "rectangle_mode": kw["rectangle_mode"],
                "edge_bite_mm": kw["edge_bite_mm"],
                "cut_first_page_only": kw["cut_first_page_only"],
                "shape_mode": kw.get("shape_mode", "auto_safe"),
            })

        # 1 chunk → chạy tại chỗ (không spawn). Nhiều chunk → pool. pool.map giữ thứ tự.
        if len(args_list) == 1:
            results = [_process_sticker_chunk(args_list[0])]
        else:
            with ProcessPoolExecutor(max_workers=n_workers) as pool:
                results = list(pool.map(_process_sticker_chunk, args_list))

        # Sắp theo chunk_idx (phòng thủ) rồi gộp.
        results.sort(key=lambda r: r[0])

        all_pages_meta = []
        pages_no_dieline = []
        any_dieline_found = False
        final_doc = None
        try:
            for _ci, (chunk_bytes, metas, no_dieline, any_die) in results:
                all_pages_meta.extend(metas)
                pages_no_dieline.extend(no_dieline)
                any_dieline_found = any_dieline_found or any_die
                src = pikepdf.Pdf.open(io.BytesIO(chunk_bytes))
                if final_doc is None:
                    final_doc = pikepdf.Pdf.new()
                final_doc.pages.extend(src.pages)
                # KHÔNG close src trước khi save: pikepdf giữ tham chiếu foreign object.

            debug_step = "Save Merged Output"
            with pikepdf.Pdf.open(input_path) as source_catalog:
                _copy_output_intents(source_catalog, final_doc)

            final_doc.save(output_path)
        finally:
            if final_doc is not None:
                try: final_doc.close()
                except Exception: pass

        # Tái tạo final_meta/error/warning Y HỆT nhánh tuần tự.
        final_meta = {}
        if len(all_pages_meta) > 0 and all_pages_meta[0]:
            final_meta = all_pages_meta[0].copy()
        final_meta["pages"] = all_pages_meta

        if cut_mode != "none" and not any_dieline_found:
            try:
                if os.path.exists(output_path):
                    os.remove(output_path)
            except OSError:
                pass
            return False, {
                "error": (
                    "Không dò được hình để tạo đường cắt. Hãy bật 'Bỏ nền trắng' "
                    "nếu nền màu trắng, hoặc kiểm tra lại file (hình quá nhạt/trống)."
                )
            }
        if pages_no_dieline:
            pages_no_dieline.sort()
            final_meta["warning"] = (
                "Một số trang không dò được hình để tạo đường cắt: "
                + ", ".join(str(p) for p in pages_no_dieline)
            )

        return True, final_meta
