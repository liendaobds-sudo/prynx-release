import cv2
import hashlib
import numpy as np
import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
import pikepdf
import io
import os
import zlib
import math
import time
import tempfile
from concurrent.futures import ProcessPoolExecutor, as_completed
from concurrent.futures.process import BrokenProcessPool
from shapely.geometry import Polygon, MultiPolygon
from shapely.ops import unary_union
import logging
from app.core.bleed_sides import (
    ALL_BLEED_SIDES,
    bleed_sides_to_names,
    normalize_bleed_sides,
)
from app.workers.shape_analyzer import ShapeType
import json

logger = logging.getLogger(__name__)


def _pdfium_object_id(obj, draw_index: int) -> str:
    """Return the same stable id used by geometry_reader.list_objects()."""
    raw_type = int(pdfium_c.FPDFPageObj_GetType(obj))
    if raw_type == pdfium_c.FPDF_PAGEOBJ_TEXT:
        kind = "text"
    elif raw_type == pdfium_c.FPDF_PAGEOBJ_IMAGE:
        kind = "image"
    else:
        # PATH, FORM, SHADING and unknown non-text objects are exposed as vector.
        kind = "vector"
    return f"{kind}-{draw_index}"


def _render_selected_objects_rgba(page, object_ids: list[str], scale: float) -> np.ndarray:
    """Render only selected top-level PDFium objects on a transparent canvas.

    The page belongs to the engine's disposable PDFium document. Removing objects
    here is used only to derive a mask; the pikepdf source page copied to output is
    never mutated or rasterized.
    """
    page_raw = page.raw
    count = int(pdfium_c.FPDFPage_CountObjects(page_raw))
    available: dict[str, int] = {}
    for draw_index in range(count):
        obj = pdfium_c.FPDFPage_GetObject(page_raw, draw_index)
        if obj:
            available[_pdfium_object_id(obj, draw_index)] = draw_index

    requested = list(dict.fromkeys(str(obj_id) for obj_id in object_ids if str(obj_id)))
    missing = [obj_id for obj_id in requested if obj_id not in available]
    if missing:
        raise ValueError(
            "Selection không còn khớp với bản PDF hiện tại: " + ", ".join(missing)
        )
    selected_indices = {available[obj_id] for obj_id in requested}
    if not selected_indices:
        raise ValueError("Selection không chứa đối tượng hợp lệ.")

    # Reverse order keeps lower draw indices stable while objects are removed.
    for draw_index in range(count - 1, -1, -1):
        if draw_index in selected_indices:
            continue
        obj = pdfium_c.FPDFPage_GetObject(page_raw, draw_index)
        if not obj:
            continue
        if not pdfium_c.FPDFPage_RemoveObject(page_raw, obj):
            raise RuntimeError(f"Không thể cô lập object PDFium #{draw_index}.")
        # RemoveObject transfers ownership to the caller.
        pdfium_c.FPDFPageObj_Destroy(obj)

    bitmap = page.render(
        scale=scale,
        fill_color=(0, 0, 0, 0),
        draw_annots=False,
        rev_byteorder=True,
    )
    rgba = bitmap.to_numpy()
    if rgba.ndim != 3 or rgba.shape[2] != 4:
        raise RuntimeError("PDFium không trả về ảnh RGBA cho selection.")
    return rgba


# Hàm hình học đường cắt được tách sang module nhẹ (không deps nặng) để test được.
# Re-export ở đây để giữ tương thích với code cũ import từ sticker_engine.
from app.workers.cutline_geometry import (  # noqa: E402
    build_bezier_segments_path_stream,
    build_contour_path_stream,
    _catmull_rom_chord_deviation_bound,
    _sample_catmull_rom_ring,
    _coords_to_bezier_stream,
    _coords_to_polyline_stream,
    fit_closed_cubic_beziers,
    sample_bezier_segments,
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


def _near_white_background_candidate_rgb(
    img: np.ndarray, *, min_channel: int = 248, max_chroma: int = 18
) -> np.ndarray:
    """Candidate pixels for the actual white page background.

    A light neutral artwork color must not be classified as background merely
    because its HSV saturation is low. Requiring every RGB channel to be near
    white keeps neutral grays such as RGB(213, 215, 214) in the silhouette,
    while still recognizing white/near-white anti-aliased page edges.
    """
    if img is None or img.ndim != 3 or img.shape[2] < 3:
        return np.zeros(img.shape[:2], dtype=bool) if img is not None else np.zeros((0, 0), dtype=bool)
    rgb = img[:, :, :3]
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    chroma = mx.astype(np.int16) - mn.astype(np.int16)
    return (mn >= min_channel) & (chroma <= max_chroma)


ALPHA_CONTOUR_INSET_MM = 0.15
ALPHA_CONTOUR_SIMPLIFY_MM = 0.02
ALPHA_CONTOUR_THRESHOLD = 64

# QUALITY (audit 2026-08-04 §ALPHA.1–2): Alpha bắt nguồn từ raster nên cần lọc
# bậc pixel theo mm vật lý, nhưng candidate chỉ được nhận khi vẫn nằm trong ngân
# sách sai lệch của đường lùi lý tưởng. 0,02 mm giữ làm fallback tương thích.
_ALPHA_SAFE_SIMPLIFY_MM = 0.05
_ALPHA_SAFE_MAX_HAUSDORFF_MM = 0.08
_ALPHA_SAFE_CURVE_HAUSDORFF_MM = 0.08
_ALPHA_SAFE_MIN_GAP_MM = 0.05
_ALPHA_SAFE_BEZIER_TENSIONS = (0.15, 0.10, 0.05, 0.03)
_ALPHA_SAFE_BEZIER_SAMPLES = 3
_ALPHA_FIT_TOLERANCES_MM = (0.10, 0.095, 0.08, 0.06)
_ALPHA_FIT_MAX_HAUSDORFF_MM = 0.12
_ALPHA_FIT_SAMPLES = 10


def _foreground_mask_from_corner_background(img: np.ndarray) -> np.ndarray | None:
    """Tách vật thể khỏi nền phẳng nối từ bốn góc khi PDF không còn Alpha.

    ALPHA (audit 2026-08-01 §A.1): đây chỉ là fallback cho PNG đã bị flatten.
    Bốn góc phải đồng màu đủ chắc; candidate nền chỉ bị xóa khi nối với biên,
    nên màu tương tự nằm kín bên trong artwork vẫn được giữ. Nền phức tạp trả
    ``None`` để caller báo lỗi thay vì âm thầm cắt cả trang.
    """
    if img is None or img.ndim != 3 or img.shape[2] < 3:
        return None
    height, width = img.shape[:2]
    if height < 4 or width < 4:
        return None

    patch = max(2, min(12, min(height, width) // 40))
    corners = np.concatenate((
        img[:patch, :patch, :3].reshape(-1, 3),
        img[:patch, -patch:, :3].reshape(-1, 3),
        img[-patch:, :patch, :3].reshape(-1, 3),
        img[-patch:, -patch:, :3].reshape(-1, 3),
    )).astype(np.int16)
    background_rgb = np.median(corners, axis=0)
    corner_distance = np.max(np.abs(corners - background_rgb), axis=1)
    corner_p95 = float(np.percentile(corner_distance, 95))
    if corner_p95 > 28.0:
        return None
    tolerance = int(np.clip(round(corner_p95) + 8, 12, 36))

    rgb = img[:, :, :3].astype(np.int16)
    candidate = (
        np.max(np.abs(rgb - background_rgb), axis=2) <= tolerance
    ).astype(np.uint8)
    num_labels, labels = cv2.connectedComponents(candidate)
    if num_labels <= 1:
        return None
    border_labels = (
        set(labels[0, :]) | set(labels[-1, :])
        | set(labels[:, 0]) | set(labels[:, -1])
    )
    border_labels.discard(0)
    if not border_labels:
        return None
    background = np.isin(labels, list(border_labels))
    foreground = (~background).astype(np.uint8) * 255
    foreground_ratio = float(np.count_nonzero(foreground)) / float(height * width)
    if foreground_ratio < 0.001 or foreground_ratio > 0.98:
        return None
    return foreground


_PRESERVE_CORNER_RADIUS_MM = 0.40
_PRESERVE_CORNER_QUAD_SEGS = 3


def _round_preserved_corners(geometry, radius_pts: float, quad_segs: int = 3):
    """Bo nhẹ các góc sau khi đã lọc răng cưa, không tạo spline dày node.

    Buffer dương/âm cùng bán kính là phép bo góc hình học có kiểm soát:
    cạnh thẳng và bbox được giữ gần như nguyên, còn góc lồi/lõm được thay
    bằng cung rất ngắn. ``quad_segs=3`` giữ cung mềm hơn nhưng vẫn chỉ thêm rất ít node,
    phù hợp đường cắt sản xuất hơn Catmull-Rom toàn contour.
    """
    if geometry is None or getattr(geometry, "is_empty", True) or radius_pts <= 0:
        return geometry

    def _round_one(poly):
        rounded = poly.buffer(radius_pts, join_style=1, quad_segs=quad_segs)
        rounded = rounded.buffer(-radius_pts, join_style=1, quad_segs=quad_segs)
        return rounded if not rounded.is_empty else poly

    if isinstance(geometry, MultiPolygon):
        parts = []
        for part in geometry.geoms:
            rounded = _round_one(part)
            if isinstance(rounded, MultiPolygon):
                parts.extend(g for g in rounded.geoms if not g.is_empty)
            elif isinstance(rounded, Polygon) and not rounded.is_empty:
                parts.append(rounded)
        return MultiPolygon(parts) if parts else geometry

    rounded = _round_one(geometry)
    return rounded if isinstance(rounded, (Polygon, MultiPolygon)) else geometry


def _polygon_topology_signature(geometry):
    """Chữ ký số mảnh/số lỗ để chặn làm mượt Alpha đổi topology."""
    if isinstance(geometry, Polygon):
        parts = [geometry]
    elif isinstance(geometry, MultiPolygon):
        parts = list(geometry.geoms)
    else:
        return None
    return len(parts), tuple(sorted(len(part.interiors) for part in parts))


def _polygon_rings(geometry):
    """Duyệt exterior/interior của Polygon/MultiPolygon mà không đổi thứ tự."""
    if isinstance(geometry, Polygon):
        parts = [geometry]
    elif isinstance(geometry, MultiPolygon):
        parts = list(geometry.geoms)
    else:
        return
    for part in parts:
        yield part.exterior
        yield from part.interiors


def _alpha_minimum_gap_pts(
    total_offset_pts: float,
    mm_to_pts: float,
    max_deviation_mm: float,
) -> float:
    """Khoảng cách Alpha còn phải giữ sau khi trừ ngân sách làm mượt."""
    intended_inset_pts = max(0.0, -float(total_offset_pts))
    return min(
        _ALPHA_SAFE_MIN_GAP_MM * mm_to_pts,
        max(0.0, intended_inset_pts - max_deviation_mm * mm_to_pts),
    )


def _alpha_smoothing_candidate_is_safe(
    alpha_geometry,
    ideal_cut_geometry,
    candidate,
    *,
    total_offset_pts: float,
    mm_to_pts: float,
    max_deviation_mm: float = _ALPHA_SAFE_MAX_HAUSDORFF_MM,
    measured_deviation_pts: float | None = None,
) -> bool:
    """Kiểm candidate không đổi topology hoặc ăn hết khoảng lùi Alpha.

    Hausdorff khóa sai lệch hai chiều so với đường cắt lý tưởng. Khi đường cắt
    đang lùi vào trong, một safe envelope bổ sung giữ candidate cách biên Alpha
    tối thiểu 0,05 mm ở cấu hình mặc định. Offset dương do người dùng chủ động
    không bị ép quay vào trong silhouette.
    """
    if (
        candidate is None
        or getattr(candidate, "is_empty", True)
        or not getattr(candidate, "is_valid", False)
        or not isinstance(candidate, (Polygon, MultiPolygon))
    ):
        return False
    if _polygon_topology_signature(candidate) != _polygon_topology_signature(
        ideal_cut_geometry
    ):
        return False

    max_deviation_pts = max_deviation_mm * mm_to_pts
    if measured_deviation_pts is None:
        measured_deviation_pts = ideal_cut_geometry.hausdorff_distance(candidate)
    if measured_deviation_pts > max_deviation_pts + 1e-9:
        return False

    minimum_gap_pts = _alpha_minimum_gap_pts(
        total_offset_pts,
        mm_to_pts,
        max_deviation_mm,
    )
    if minimum_gap_pts <= 0:
        return True

    safe_envelope = alpha_geometry.buffer(-minimum_gap_pts, join_style=1)
    return (
        not safe_envelope.is_empty
        and safe_envelope.is_valid
        and safe_envelope.covers(candidate)
    )


def _smooth_alpha_cut_contour(
    alpha_geometry,
    ideal_cut_geometry,
    *,
    total_offset_pts: float,
    mm_to_pts: float,
):
    """Trả ``(geometry, Hausdorff pts)``; lỗi thì lùi về mức cũ 0,02 mm."""
    legacy = ideal_cut_geometry.simplify(
        ALPHA_CONTOUR_SIMPLIFY_MM * mm_to_pts,
        preserve_topology=True,
    )

    simplified = ideal_cut_geometry.simplify(
        _ALPHA_SAFE_SIMPLIFY_MM * mm_to_pts,
        preserve_topology=True,
    )
    simplified_deviation_pts = ideal_cut_geometry.hausdorff_distance(simplified)
    if _alpha_smoothing_candidate_is_safe(
        alpha_geometry,
        ideal_cut_geometry,
        simplified,
        total_offset_pts=total_offset_pts,
        mm_to_pts=mm_to_pts,
        measured_deviation_pts=simplified_deviation_pts,
    ):
        return simplified, simplified_deviation_pts
    return legacy, ideal_cut_geometry.hausdorff_distance(legacy)


def _sample_alpha_bezier_geometry(geometry, tension: float):
    """Dựng polygon lấy mẫu đúng đường Bézier sẽ ghi vào PDF để chạy guard."""
    if isinstance(geometry, Polygon):
        source_parts = [geometry]
        return_multi = False
    elif isinstance(geometry, MultiPolygon):
        source_parts = list(geometry.geoms)
        return_multi = True
    else:
        return None

    sampled_parts = []
    for part in source_parts:
        exterior = _sample_catmull_rom_ring(
            list(part.exterior.coords),
            tension=tension,
            samples_per_segment=_ALPHA_SAFE_BEZIER_SAMPLES,
        )
        interiors = [
            _sample_catmull_rom_ring(
                list(interior.coords),
                tension=tension,
                samples_per_segment=_ALPHA_SAFE_BEZIER_SAMPLES,
            )
            for interior in part.interiors
        ]
        if len(exterior) < 4 or any(len(interior) < 4 for interior in interiors):
            return None
        sampled_parts.append(Polygon(exterior, interiors))

    if return_multi:
        return MultiPolygon(sampled_parts)
    return sampled_parts[0] if sampled_parts else None


def _safe_alpha_bezier_tension(
    alpha_geometry,
    ideal_cut_geometry,
    anchor_geometry,
    *,
    total_offset_pts: float,
    mm_to_pts: float,
    anchor_deviation_pts: float,
):
    """Chọn độ căng Bézier mạnh nhất qua guard O(n); lỗi thì trả ``None``."""
    curve_budget_pts = _ALPHA_SAFE_CURVE_HAUSDORFF_MM * mm_to_pts
    if anchor_deviation_pts > curve_budget_pts + 1e-9:
        return None

    minimum_gap_pts = _alpha_minimum_gap_pts(
        total_offset_pts,
        mm_to_pts,
        _ALPHA_SAFE_CURVE_HAUSDORFF_MM,
    )
    for tension in _ALPHA_SAFE_BEZIER_TENSIONS:
        ring_bounds = [
            _catmull_rom_chord_deviation_bound(
                list(ring.coords),
                tension=tension,
            )
            for ring in _polygon_rings(anchor_geometry)
        ]
        if not ring_bounds or any(bound is None for bound in ring_bounds):
            continue
        curve_deviation_pts = max(ring_bounds)
        # PERF (audit 2026-08-04 §ALPHA.2): dùng bất đẳng thức tam giác
        # Hausdorff ideal↔anchor↔cubic thay vì so mọi điểm O(n²).
        if anchor_deviation_pts + curve_deviation_pts > curve_budget_pts + 1e-9:
            continue

        sampled_curve = _sample_alpha_bezier_geometry(anchor_geometry, tension)
        if (
            sampled_curve is None
            or sampled_curve.is_empty
            or not sampled_curve.is_valid
            or _polygon_topology_signature(sampled_curve)
            != _polygon_topology_signature(ideal_cut_geometry)
        ):
            continue

        if minimum_gap_pts > 0:
            # Anchor phải nằm sâu thêm đúng độ lệch tối đa của cubic. Khi đó
            # toàn đường cong vẫn nằm trong safe envelope cách Alpha 0,05 mm.
            anchor_envelope = alpha_geometry.buffer(
                -(minimum_gap_pts + curve_deviation_pts),
                join_style=1,
            )
            if (
                anchor_envelope.is_empty
                or not anchor_envelope.is_valid
                or not anchor_envelope.covers(anchor_geometry)
            ):
                continue
        return tension
    return None


def _geometry_within_hausdorff_budget(
    first,
    second,
    budget_pts: float,
    *,
    first_envelope=None,
) -> bool:
    """Kiểm Hausdorff ``<= budget`` bằng hai phép bao phủ buffer tương đương."""
    if budget_pts < 0:
        return False
    envelope = first_envelope
    if envelope is None:
        envelope = first.buffer(budget_pts, join_style=1)
    return envelope.covers(second) and second.buffer(
        budget_pts,
        join_style=1,
    ).covers(first)


def _fit_alpha_bezier_paths(
    alpha_geometry,
    ideal_cut_geometry,
    *,
    total_offset_pts: float,
    mm_to_pts: float,
    _enforce_monotonic: bool = True,
):
    """Fit nhiều điểm raster thành ít cubic; mọi candidate phải qua guard artifact.

    Ưu tiên tay nắm đơn điệu để tránh loop. Nếu toàn contour không phù hợp,
    thử lại tay nắm giới hạn chord nhưng thoáng hơn trước khi về Catmull.
    """
    reference = ideal_cut_geometry.simplify(
        ALPHA_CONTOUR_SIMPLIFY_MM * mm_to_pts,
        preserve_topology=True,
    )
    comparison = ideal_cut_geometry.simplify(
        _ALPHA_SAFE_SIMPLIFY_MM * mm_to_pts,
        preserve_topology=True,
    )
    if isinstance(reference, Polygon):
        source_parts = [reference]
        return_multi = False
    elif isinstance(reference, MultiPolygon):
        source_parts = list(reference.geoms)
        return_multi = True
    else:
        return None

    comparison_nodes = sum(
        len(ring.coords) - 1 for ring in _polygon_rings(comparison)
    )
    minimum_gap_pts = min(
        _ALPHA_SAFE_MIN_GAP_MM * mm_to_pts,
        max(0.0, -float(total_offset_pts)),
    )
    safe_envelope = (
        alpha_geometry.buffer(-minimum_gap_pts, join_style=1)
        if minimum_gap_pts > 0
        else None
    )
    remaining_budget_pts = (
        _ALPHA_FIT_MAX_HAUSDORFF_MM - ALPHA_CONTOUR_SIMPLIFY_MM
    ) * mm_to_pts
    uncertainty_limit_pts = (
        _ALPHA_FIT_MAX_HAUSDORFF_MM + ALPHA_CONTOUR_SIMPLIFY_MM
    ) * mm_to_pts
    exact_budget_pts = _ALPHA_FIT_MAX_HAUSDORFF_MM * mm_to_pts
    # PERF (audit 2026-08-05 §ALPHA.P1): với hai tập đóng A/B,
    # H(A,B) <= r tương đương A nằm trong buffer(B,r) và ngược lại. Buffer +
    # covers cho cùng guard Hausdorff nhưng tránh phép đo O(n×m) trên contour
    # raster 8–12 nghìn điểm ở từng tolerance.
    reference_remaining_envelope = reference.buffer(
        remaining_budget_pts,
        join_style=1,
    )
    reference_uncertainty_envelope = reference.buffer(
        uncertainty_limit_pts,
        join_style=1,
    )
    ideal_exact_envelope = ideal_cut_geometry.buffer(
        exact_budget_pts,
        join_style=1,
    )

    for tolerance_mm in _ALPHA_FIT_TOLERANCES_MM:
        all_paths = []
        sampled_parts = []
        try:
            for part in source_parts:
                exterior_segments = fit_closed_cubic_beziers(
                    list(part.exterior.coords),
                    tolerance_mm * mm_to_pts,
                    enforce_monotonic=_enforce_monotonic,
                )
                interior_segments = [
                    fit_closed_cubic_beziers(
                        list(interior.coords),
                        tolerance_mm * mm_to_pts,
                        enforce_monotonic=_enforce_monotonic,
                    )
                    for interior in part.interiors
                ]
                if not exterior_segments or any(
                    not segments for segments in interior_segments
                ):
                    raise ValueError("Không fit được đầy đủ các ring Alpha")

                exterior = sample_bezier_segments(
                    exterior_segments,
                    samples_per_segment=_ALPHA_FIT_SAMPLES,
                )
                interiors = [
                    sample_bezier_segments(
                        segments,
                        samples_per_segment=_ALPHA_FIT_SAMPLES,
                    )
                    for segments in interior_segments
                ]
                sampled_parts.append(Polygon(exterior, interiors))
                all_paths.append(exterior_segments)
                all_paths.extend(interior_segments)
        except (ArithmeticError, RecursionError, ValueError):
            continue

        sampled_geometry = (
            MultiPolygon(sampled_parts)
            if return_multi
            else sampled_parts[0]
        )
        if (
            sampled_geometry.is_empty
            or not sampled_geometry.is_valid
            or _polygon_topology_signature(sampled_geometry)
            != _polygon_topology_signature(ideal_cut_geometry)
        ):
            continue
        # PERF (audit 2026-08-04 §ALPHA.2): reference đã nằm trong 0,02 mm
        # của ideal theo bảo đảm Douglas–Peucker. Phần lớn candidate được quyết
        # định bằng bất đẳng thức tam giác; vùng sát ngưỡng mới đo contour gốc
        # để tránh loại nhầm đường fit an toàn chỉ vì bound bảo thủ.
        if not _geometry_within_hausdorff_budget(
            reference,
            sampled_geometry,
            remaining_budget_pts,
            first_envelope=reference_remaining_envelope,
        ):
            if not _geometry_within_hausdorff_budget(
                reference,
                sampled_geometry,
                uncertainty_limit_pts,
                first_envelope=reference_uncertainty_envelope,
            ) or not _geometry_within_hausdorff_budget(
                ideal_cut_geometry,
                sampled_geometry,
                exact_budget_pts,
                first_envelope=ideal_exact_envelope,
            ):
                continue
        if (
            safe_envelope is not None
            and (
                safe_envelope.is_empty
                or not safe_envelope.is_valid
                or not safe_envelope.covers(sampled_geometry)
            )
        ):
            continue

        segment_count = sum(len(segments) for segments in all_paths)
        if comparison_nodes > 0 and segment_count >= comparison_nodes * 0.85:
            continue
        return sampled_geometry, all_paths, tolerance_mm
    if _enforce_monotonic:
        return _fit_alpha_bezier_paths(
            alpha_geometry,
            ideal_cut_geometry,
            total_offset_pts=total_offset_pts,
            mm_to_pts=mm_to_pts,
            _enforce_monotonic=False,
        )
    return None


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


_EDGE_COLOR_MAX_SAMPLES = 100_000
_EDGE_COLOR_TRANSITION_RGB = 48
_EDGE_COLOR_TRANSITION_RATIO = 0.05
_EDGE_COLOR_LUMA_SPAN = 30.0
_EDGE_COLOR_MIN_SAMPLES = 64
_EDGE_COLOR_BRIGHT_TAIL_PERCENTILE = 99.0
_EDGE_COLOR_BRIGHT_TAIL_DELTA = 20.0
_EDGE_COLOR_BRIGHT_TAIL_MIN_RATIO = 0.005
_EDGE_COLOR_BRIGHT_TAIL_MAX_RATIO = 0.08
_EDGE_COLOR_ADAPTIVE_MAX_MM = 0.60
_EDGE_COLOR_ADAPTIVE_ACCEPT_RATIO = 0.75
_EDGE_COLOR_DEPTH_PENALTY = 0.002
_SEAM_FEATHER_MM = 0.15
_TRAJECTORY_RECT_MIN_FILL_RATIO = 0.82
_TRAJECTORY_RECT_CORE_MIN_FILL_RATIO = 0.995
_TRAJECTORY_RECT_MIN_CONVEXITY_RATIO = 0.99


def _axis_aligned_rectangle_bbox(
    footprint: np.ndarray,
) -> tuple[int, int, int, int] | None:
    """Trả bbox khi footprint là hình chữ nhật thẳng trục, có thể bo góc.

    TRAJECTORY (audit 2026-08-01 §BT.1): engine quỹ đạo hiện tiếp tục màu theo
    bốn cạnh. Một contour lồi, phủ đủ bbox và kín cả hai dải lõi ngang/dọc là
    chữ nhật hoặc chữ nhật bo góc; hình tròn, hình xoay và contour tự do không
    có hai dải lõi kín nên vẫn fallback sang lấy màu viền.
    """
    if footprint is None or footprint.ndim != 2 or footprint.size == 0:
        return None
    if footprint.dtype == np.uint8 and footprint.flags.c_contiguous:
        binary = footprint
    else:
        binary = np.ascontiguousarray(footprint > 0, dtype=np.uint8)
    contours, _ = cv2.findContours(
        binary,
        cv2.RETR_EXTERNAL,
        cv2.CHAIN_APPROX_SIMPLE,
    )
    if len(contours) != 1:
        return None
    contour_area = float(cv2.contourArea(contours[0]))
    convex_area = float(cv2.contourArea(cv2.convexHull(contours[0])))
    # Contour raster của cung tròn có lõm giả cỡ một pixel, nên
    # ``isContourConvex`` quá nghiêm. Tỷ lệ này vẫn loại notch thật.
    if convex_area <= 0.0 or (
        contour_area / convex_area < _TRAJECTORY_RECT_MIN_CONVEXITY_RATIO
    ):
        return None
    x, y, width, height = (int(value) for value in cv2.boundingRect(contours[0]))
    if width < 3 or height < 3:
        return None
    # Chỉ dựng mask cục bộ trong bbox; tránh thêm một label-map int32 cỡ cả tờ PDF.
    local = np.zeros((height, width), dtype=np.uint8)
    shifted = contours[0].copy()
    shifted[:, 0, 0] -= x
    shifted[:, 0, 1] -= y
    cv2.drawContours(local, [shifted], -1, 255, cv2.FILLED)
    fill_ratio = float(cv2.countNonZero(local)) / float(width * height)
    if fill_ratio < _TRAJECTORY_RECT_MIN_FILL_RATIO:
        return None

    # Góc bo chỉ làm thiếu bốn góc bbox; phần giữa của cả bốn cạnh vẫn tạo hai
    # dải chữ thập kín. Gate này chặn ellipse, hình thoi và chữ nhật bị xoay dù
    # chỉ số diện tích của chúng có thể gần ngưỡng.
    inset = max(1, min(width, height) // 4)
    horizontal_core = local[inset:height - inset, :]
    vertical_core = local[:, inset:width - inset]
    if horizontal_core.size == 0 or vertical_core.size == 0:
        return None
    horizontal_fill = float(np.count_nonzero(horizontal_core)) / horizontal_core.size
    vertical_fill = float(np.count_nonzero(vertical_core)) / vertical_core.size
    if min(horizontal_fill, vertical_fill) < _TRAJECTORY_RECT_CORE_MIN_FILL_RATIO:
        return None
    return x, y, x + width, y + height


def _edge_color_instability_metrics(
    source_mask: np.ndarray,
    img: np.ndarray,
) -> dict[str, float]:
    """Đo nhiễu màu cao tần trên shell dùng để kéo bù xén.

    Chỉ lấy mẫu tối đa 100k pixel của shell, không quét/chuyển kiểu cả raster lớn.
    Một viền đổi màu theo các đoạn dài vẫn có rất ít cặp kề nhau đổi gắt; halo
    AA/JPEG lốm đốm có tỷ lệ chuyển màu cao và sẽ bị nearest kéo thành nan quạt.
    """
    if (
        source_mask is None
        or img is None
        or source_mask.size == 0
        or img.ndim != 3
        or img.shape[2] < 3
    ):
        return {
            "sample_count": 0.0,
            "transition_ratio": 0.0,
            "luma_span": 0.0,
            "bright_tail_span": 0.0,
            "bright_tail_ratio": 0.0,
        }

    ys, xs = np.where(source_mask > 0)
    if ys.size == 0:
        return {
            "sample_count": 0.0,
            "transition_ratio": 0.0,
            "luma_span": 0.0,
            "bright_tail_span": 0.0,
            "bright_tail_ratio": 0.0,
        }

    stride = max(1, int(math.ceil(ys.size / _EDGE_COLOR_MAX_SAMPLES)))
    ys = ys[::stride]
    xs = xs[::stride]
    rgb = img[ys, xs, :3].astype(np.int16)
    luma = (
        0.2126 * rgb[:, 0]
        + 0.7152 * rgb[:, 1]
        + 0.0722 * rgb[:, 2]
    )
    luma_span = float(np.percentile(luma, 90) - np.percentile(luma, 10))
    luma_median = float(np.percentile(luma, 50))
    bright_tail_span = float(
        np.percentile(luma, _EDGE_COLOR_BRIGHT_TAIL_PERCENTILE) - luma_median
    )
    bright_tail_ratio = float(
        np.mean(luma >= luma_median + _EDGE_COLOR_BRIGHT_TAIL_DELTA)
    )

    changed_pairs = 0
    total_pairs = 0
    height, width = source_mask.shape[:2]
    for dy, dx in ((0, 1), (1, 0)):
        valid = (ys + dy < height) & (xs + dx < width)
        if not np.any(valid):
            continue
        y0 = ys[valid]
        x0 = xs[valid]
        neighbor_is_source = source_mask[y0 + dy, x0 + dx] > 0
        if not np.any(neighbor_is_source):
            continue
        y0 = y0[neighbor_is_source]
        x0 = x0[neighbor_is_source]
        current = img[y0, x0, :3].astype(np.int16)
        neighbor = img[y0 + dy, x0 + dx, :3].astype(np.int16)
        delta = np.max(np.abs(current - neighbor), axis=1)
        changed_pairs += int(np.count_nonzero(delta >= _EDGE_COLOR_TRANSITION_RGB))
        total_pairs += int(delta.size)

    return {
        "sample_count": float(ys.size),
        "transition_ratio": changed_pairs / total_pairs if total_pairs else 0.0,
        "luma_span": luma_span,
        "bright_tail_span": bright_tail_span,
        "bright_tail_ratio": bright_tail_ratio,
    }


def _edge_color_is_unstable(metrics: dict[str, float]) -> bool:
    """True khi shell có đủ mẫu và đổi màu cao tần đủ gây nan quạt."""
    return (
        metrics.get("sample_count", 0.0) >= _EDGE_COLOR_MIN_SAMPLES
        and metrics.get("transition_ratio", 0.0) >= _EDGE_COLOR_TRANSITION_RATIO
        and metrics.get("luma_span", 0.0) >= _EDGE_COLOR_LUMA_SPAN
    )


def _edge_color_has_sparse_bright_fringe(metrics: dict[str, float]) -> bool:
    """True khi chỉ một ít pixel shell sáng vọt lên như AA bị pha nền trắng.

    QUALITY (fix 2026-08-03 §EDGE-SAMPLE.1): dùng cả độ lệch sáng và tỷ lệ thưa.
    Mảng màu sáng có chủ đích kéo dài quanh viền sẽ vượt trần tỷ lệ; nếu nó chỉ là
    một cung nhỏ nhưng tiếp tục vào sâu, điểm ổn định của các shell sau không giảm
    đủ nên adaptive vẫn giữ shell nông ban đầu.
    """
    sample_count = metrics.get("sample_count", 0.0)
    bright_tail_span = metrics.get("bright_tail_span", 0.0)
    bright_tail_ratio = metrics.get("bright_tail_ratio", 0.0)
    return (
        sample_count >= _EDGE_COLOR_MIN_SAMPLES
        and bright_tail_span >= _EDGE_COLOR_BRIGHT_TAIL_DELTA
        and _EDGE_COLOR_BRIGHT_TAIL_MIN_RATIO
        <= bright_tail_ratio
        <= _EDGE_COLOR_BRIGHT_TAIL_MAX_RATIO
    )


def _edge_color_stability_score(metrics: dict[str, float]) -> float:
    """Điểm thấp hơn = shell ổn định hơn; ưu tiên giảm đổi màu từng pixel."""
    transition = max(0.0, float(metrics.get("transition_ratio", 0.0)))
    luma = min(255.0, max(0.0, float(metrics.get("luma_span", 0.0)))) / 255.0
    bright_tail = (
        min(255.0, max(0.0, float(metrics.get("bright_tail_span", 0.0))))
        / 255.0
    )
    return transition + 0.02 * luma + 0.02 * bright_tail


def _build_adaptive_edge_color_source_mask(
    silhouette: np.ndarray,
    img: np.ndarray,
    *,
    band_px: int,
    peel_px: int,
    max_peel_px: int,
    edge_bite_px: int = 0,
    kernel_type: int = cv2.MORPH_ELLIPSE,
    exclude_near_white: bool = True,
) -> tuple[np.ndarray, int]:
    """Chọn shell nông nhất đủ ổn định, thay vì kéo halo sát mép ra bleed.

    QUALITY (audit 2026-07-28 §BX.1/§BX.2): mask hình học vẫn giữ nguyên;
    chỉ mask lấy màu được thử sâu dần. Viền gồm các mảng màu dài có tỷ lệ đổi
    pixel thấp nên giữ shell ban đầu. Chỉ shell cao tần mới được dịch vào trong,
    tối đa 0,60 mm do caller quy đổi sang pixel.
    """
    initial_peel = max(0, int(peel_px))
    initial = _build_edge_color_source_mask(
        silhouette,
        img,
        band_px=band_px,
        peel_px=initial_peel,
        edge_bite_px=edge_bite_px,
        kernel_type=kernel_type,
        exclude_near_white=exclude_near_white,
    )
    initial_metrics = _edge_color_instability_metrics(initial, img)
    sparse_bright_fringe = _edge_color_has_sparse_bright_fringe(initial_metrics)
    if not (
        _edge_color_is_unstable(initial_metrics)
        or sparse_bright_fringe
    ):
        return initial, initial_peel

    deepest_peel = max(initial_peel, int(max_peel_px))
    band = max(1, int(band_px))
    step = max(1, int(round(band / 3)))
    candidate_peels = sorted({
        min(deepest_peel, initial_peel + step),
        min(deepest_peel, initial_peel + max(step, (band + 1) // 2)),
        min(deepest_peel, initial_peel + band),
        deepest_peel,
    })
    # Fringe sáng thưa thường chiếm trọn lớp AA đầu tiên. Khi đã nhận ra mẫu này,
    # lùi tối thiểu một bề dày shell để không chọn lại lớp kế cận vẫn còn pha nền.
    minimum_candidate_peel = (
        min(deepest_peel, initial_peel + band)
        if sparse_bright_fringe
        else initial_peel + 1
    )

    best_mask = initial
    best_peel = initial_peel
    initial_score = _edge_color_stability_score(initial_metrics)
    best_score = initial_score
    for candidate_peel in candidate_peels:
        if candidate_peel < minimum_candidate_peel:
            continue
        candidate = _build_edge_color_source_mask(
            silhouette,
            img,
            band_px=band,
            peel_px=candidate_peel,
            edge_bite_px=edge_bite_px,
            kernel_type=kernel_type,
            exclude_near_white=exclude_near_white,
        )
        metrics = _edge_color_instability_metrics(candidate, img)
        if _edge_color_is_unstable(metrics):
            continue
        depth_penalty = (
            _EDGE_COLOR_DEPTH_PENALTY
            * (candidate_peel - initial_peel)
            / band
        )
        score = _edge_color_stability_score(metrics) + depth_penalty
        if score < best_score:
            best_mask = candidate
            best_peel = candidate_peel
            best_score = score

    if (
        best_peel > initial_peel
        and best_score <= initial_score * _EDGE_COLOR_ADAPTIVE_ACCEPT_RATIO
    ):
        return best_mask, best_peel
    return initial, initial_peel


def _build_feathered_bleed_join_mask(
    bleed_mask: np.ndarray,
    sticker_footprint: np.ndarray,
    *,
    solid_overlap_px: int,
    feather_px: int,
) -> np.ndarray:
    """Tạo alpha mềm ở mép trong của lớp bleed chồng lên artwork.

    QUALITY (audit 2026-07-28 §BX.5): phía ngoài tem vẫn đục hoàn toàn; bleed
    chồng kín qua vùng halo trong ``solid_overlap_px``, rồi giảm alpha bằng
    smoothstep ở dải feather. Nhờ vậy đường cong không còn biên mask 0/255 dạng
    bậc thang và phần chuyển màu nằm sâu trong vùng màu nguồn đã ổn định.
    """
    if (
        bleed_mask is None
        or sticker_footprint is None
        or bleed_mask.shape != sticker_footprint.shape
        or np.count_nonzero(bleed_mask) == 0
        or np.count_nonzero(sticker_footprint) == 0
    ):
        return bleed_mask.copy() if bleed_mask is not None else bleed_mask

    roi = _bleed_roi_bbox(bleed_mask)
    if roi is None:
        return bleed_mask.copy()
    y0, y1, x0, x1 = roi
    coverage = bleed_mask[y0:y1, x0:x1] > 0
    footprint = sticker_footprint[y0:y1, x0:x1] > 0
    sub_alpha = np.zeros(coverage.shape, dtype=np.uint8)
    sub_alpha[coverage & ~footprint] = 255

    solid = max(0, int(solid_overlap_px))
    feather = max(1, int(feather_px))
    # Chỉ EDT trên bbox bleed; không tạo thêm float32 cỡ cả tờ PDF.
    distance_inside = cv2.distanceTransform(
        footprint.astype(np.uint8), cv2.DIST_L2, 5
    )
    transition = np.clip(
        (solid + feather - distance_inside) / float(feather),
        0.0,
        1.0,
    )
    transition = transition * transition * (3.0 - 2.0 * transition)
    inside = coverage & footprint
    sub_alpha[inside] = np.rint(transition[inside] * 255.0).astype(np.uint8)

    alpha = np.zeros_like(bleed_mask, dtype=np.uint8)
    alpha[y0:y1, x0:x1] = sub_alpha
    return alpha


def _edge_color_sampling_warning(
    source_mask: np.ndarray,
    img: np.ndarray,
    page_number: int,
) -> str | None:
    """Cảnh báo khi nearest có nguy cơ kéo nhiễu mép thành vệt dài."""
    metrics = _edge_color_instability_metrics(source_mask, img)
    if _edge_color_is_unstable(metrics):
        return (
            f"Trang {page_number}: màu viền lấy mẫu thay đổi gắt theo từng pixel; "
            "bù xén có thể xuất hiện vệt. Hãy kiểm tra bản xem trước hoặc chọn "
            "‘Đổ màu trơn’."
        )
    return None


def _compose_sticker_warning(
    all_pages_meta: list[dict],
    pages_no_dieline: list[int],
) -> str | None:
    """Gộp cảnh báo chất lượng và hình học mà không làm rơi cảnh báo nào."""
    warnings: list[str] = []
    for page_meta in all_pages_meta:
        warning = page_meta.get("bleed_warning") if isinstance(page_meta, dict) else None
        if warning and warning not in warnings:
            warnings.append(str(warning))
    if pages_no_dieline:
        warnings.append(
            "Một số trang không dò được hình để tạo đường cắt: "
            + ", ".join(str(page) for page in sorted(pages_no_dieline))
        )
    return " ".join(warnings) if warnings else None


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


# BX-03/BX-08 (audit bù xén lần 2, 2026-07-30): TRẦN ĐỘ DỐC của quỹ đạo. 1.25 ≈ 51°,
# tức nét được phép đi chéo tối đa 51° so với phương vuông góc mép.
#
# Đo trên hoa văn tổng hợp có ground truth (sai số dốc nội vùng, mép 1200px, dải 35px):
#
#   trần   d=0.2  d=0.4  d=0.6  d=0.8  d=1.0  d=1.25
#   1.00   0.058  0.081  0.102  0.082  0.178   0.298
#   1.25   0.058  0.081  0.102  0.082  0.178   0.090
#   2.00   0.058  0.081  0.102  0.082  0.178   0.090
#
# Đọc bảng: nới 1.00 → 1.25 chỉ ảnh hưởng hoa văn dốc hơn 45° (0.298 → 0.090) và KHÔNG
# đổi một số nào ở dốc thấp — ở đó trần không phải ràng buộc. Nới tiếp lên 2.00 không
# lợi thêm, nên 1.25 là điểm dừng. Sai số 0.178 còn lại ở d=1.0 KHÔNG do trần (giữ
# nguyên ở cả ba trần) mà do làm trơn hướng — xem BX-10, thuộc lô B.
_TRAJ_MAX_SLOPE = 1.25

# BX-07/BX-08 — tầm với tối đa của quỹ đạo, tính theo BỀ RỘNG DẢI bù xén: màu bù xén
# chỉ được lấy lệch tối đa ``factor × amount`` theo phương dọc mép. Đây là bảo hiểm
# chống HƯỚNG ƯỚC LƯỢNG SAI, khác bản chất với trần dốc ở trên (hình học thật của nét)
# — lần 1 gộp lẫn hai khái niệm này nên vô tình kẹp trần dốc xuống 0.6.
#
# BX-09 — hằng này phải áp lên ``slopes`` MỘT LẦN (trước vòng lặp), KHÔNG áp lên
# ``offset`` theo từng ``step``. Clip theo bước biến quỹ đạo thành đường HAI ĐOẠN: đi
# đúng dốc tới bước ``factor/|slope|`` rồi BẺ NGANG song song mép cho hết dải — đo
# được khuỷu 31° và tới 48.6% bề rộng dải đi ngang ở hoa văn dốc 1.25. Clip một lần
# giữ quỹ đạo THẲNG mà tầm với vẫn bị chặn đúng ``factor × amount``.
_TRAJ_MAX_REACH_FACTOR = 1.25

# BX-11 (audit bù xén lô B, 2026-07-30) — trần dốc CỐ ĐỊNH 1.25 vẫn còn bẻ khúc.
#
# Đo trên file thật (sticker chữ nhật, hoa văn diamond, bù xén 3mm @300DPI): mép DƯỚI
# có độ dốc nét THẬT trung vị 2,72 (≈70° so với mép), p90 = 4,32 và 91,8% hàng vượt
# trần 1.25 (≈51,3°). Trong tờ dải màu chạy 70°, vừa qua đường trim bị ép về 51,3° ⇒
# ĐỔI HƯỚNG ĐỘT NGỘT NGAY TẠI ĐƯỜNG TRIM. Đo góc bẻ: trung vị 27,0°, p90 47,3°. Đây
# là "dải màu gấp khúc" người dùng thấy — KHÔNG phải slopes nhảy bậc giữa hàng kề
# (sau bộ làm trơn của BX-07, |Δs| hàng-kề-hàng chỉ còn 0,009 ở mép này).
#
# Lô A không bắt được vì oracle ``chevron()`` chỉ chạy tới dốc 1.25 — đúng bằng giá
# trị trần — nên chưa bao giờ chạm vùng bão hoà.
#
# Không nới trần vô điều kiện: trần còn nhiệm vụ BẢO HIỂM chống hướng ước lượng SAI
# (nền trơn, nhiễu, giao điểm hai họ nét), ở đó vươn xa sẽ lùa màu vùng khác vào dải.
# Nên có HAI trần và ``_trusted_slope_cap()`` chọn một trong hai cho cả dải: sàn = giá
# trị cũ, và trần nới dùng khi mép thật sự bị nét dốc SONG SONG cắt qua.
#
# Hoa văn tỏa tia trong bộ test có 0,0% hàng vượt trần (dốc thật vốn < 1.25) nên trần
# nới không ảnh hưởng tới nó.
_TRAJ_SLOPE_CAP_FLOOR = _TRAJ_MAX_SLOPE
_TRAJ_SLOPE_CAP_TRUSTED = 8.0

# BX-11 — coherence MỘT MÌNH chưa đủ để nới trần, và trần theo TỪNG HÀNG cũng không
# được. Đo được: nới trần chỉ theo coherence xoá được khuỷu mép dưới (27,0° → 9,2°)
# nhưng HỒI QUY mép phải — ở đó chỉ 12% hàng vượt trần và chúng nằm RẢI RÁC giữa các
# hàng dốc 0,19, nên chính chỗ trần chuyển giá trị làm trường hướng nhảy bậc
# (|Δs| hàng-kề-hàng 0,034 → 0,543) và kéo dãn 20× (vệt nhoè). Quét hệ số hoà giải
# không có điểm nào tốt cho cả hai mép.
#
# Điều kiện thứ hai phải là ĐỘ ĐỒNG THUẬN của trường hướng — cũng chính là điều kiện
# KHÔNG GẤP: ánh xạ thuận đơn điệu ⇔ ``|ds/dr| ≤ (1 − min_spacing)/amount``. Dốc cao mà
# các hàng kề ĐỒNG Ý (dải song song) thì đi theo là đúng và không gấp; dốc cao mà các
# hàng kề LỆCH nhau (tia phân kỳ, giao hai họ nét) thì đi theo sẽ xé dải.
#
# Đo trên cùng file, thống kê CẤP MÉP của các hàng vượt trần cũ:
#     mép dưới (ca lỗi): 91,8% hàng, |ds/dr| 0,034, coherence 0,70 → nới
#     mép trên:          22,8% hàng, |ds/dr| 0,112, coherence 0,22 → giữ
#     mép phải:          12,0% hàng, |ds/dr| 0,160, coherence 0,76 → giữ
#     mép trái:           5,7% hàng, |ds/dr| 0,211, coherence 0,42 → giữ
# Tách sạch 3-6× ở |ds/dr|, nên ngưỡng lấy bội số ngân sách gấp; thêm hai điều kiện phụ
# (tỉ lệ hàng dốc cao và coherence của chính các hàng đó) để không nới vì vài hàng lẻ.
#
# Hệ số 4.0 chọn để lấy BIÊN AN TOÀN, không phải để vừa khít: ngân sách gấp ở bù xén 3mm
# @300DPI là 0,0186 nên ngưỡng thành 0,074 — nằm giữa mép dưới (0,034, cần nới) và mép
# gần nhất không được nới (mép trên 0,112). Hệ số 2.0 cũng phân loại đúng cả 4 mép của
# file này nhưng chỉ hở 10% so với mép dưới, file khác lệch chút là bản vá không kích
# hoạt; 4.0 cho hở 2,2× mà vẫn còn cách mép trên 1,5×.
_TRAJ_TRUST_FOLD_SLACK = 4.0
_TRAJ_TRUST_MIN_FRACTION = 0.40
_TRAJ_TRUST_MIN_COHERENCE = 0.55

# Khoảng cách tối thiểu giữa hai hàng kề của ánh xạ thuận. Trước BX-11 đây là biến cục
# bộ trong vòng ``for step``; nâng thành hằng module vì cả trần dốc (ngân sách gấp) lẫn
# phép chiếu không-gấp đều cần đúng con số này.
#
# BX-11 — nới 0.05 → 0.35. Hằng này là trần KÉO DÃN: một hàng nguồn được phép trải ra
# tối đa ``1/min_spacing`` hàng đích, nên 0.05 cho phép dãn 20× (vệt nhoè). Thời còn
# cưỡng chế tham lam nó gần như không bao giờ chạm biên nên trần lỏng cũng vô hại; phép
# chiếu L2 thì CHẠM ĐÚNG biên, nên trần lỏng lập tức thành nhoè thật. Đo trên oracle:
# 0.05 → 0.35 hạ kéo dãn 20,00× → 2,86× mà KHÔNG đổi một số sai số dốc / góc khuỷu nào
# ở mọi dốc thử (0,4 / 0,8 / 1,25 / 2,72 / 4,3). Nới tiếp lên 0.50 bắt đầu mất bám nét
# (dốc 2,72 mép 583px: sai số 0,612 → 0,860, khuỷu 5,2° → 8,1°) nên 0.35 là điểm dừng.
_TRAJ_MIN_SPACING = 0.35

# BX-07 — hệ số sigma làm trơn hướng theo bề rộng dải. Sai hướng bị nhân lên theo
# ``step`` nên dải càng rộng càng phải trơn; 0.35×amount dập được dao động hàng-kề-hàng
# mà vẫn giữ được phân kỳ tổng thể (tia tỏa vẫn loe, chỉ không còn xé đoạn).
_TRAJ_SMOOTH_PER_AMOUNT = 0.35

# BX-07 — mép DÀI cần sigma lớn hơn: đo trên mép trên 1738px, sigma 12 vẫn để quỹ đạo
# xé thành 26 đoạn (gãy 19px), sigma ~24 hạ còn 10 đoạn và gãy 2,5px. Trần cũ 24 chính
# là nút thắt nên nới lên 64. Hệ số 0.03 là điểm ngọt đo được: gãy về ~1-2px và số đoạn
# giảm mạnh (mép phải 6→4, mép trên 10→2) mà tầm với vẫn giữ 0.51-0.60 (còn phân kỳ);
# nới tiếp lên 0.05-0.08 gần như không lợi thêm mà bắt đầu làm phẳng quỹ đạo.
_TRAJ_SMOOTH_PER_EDGE = 0.03
_TRAJ_SMOOTH_MAX_SIGMA = 64.0


def _trusted_slope_cap(
    direction_x: np.ndarray,
    direction_y: np.ndarray,
    coherence: np.ndarray,
    valid: np.ndarray,
    amount: int,
) -> float:
    """Chọn trần độ dốc cho CẢ dải: sàn cũ, hoặc trần nới nếu mép có nét dốc song song.

    BX-11 (audit bù xén lô B, 2026-07-30). Trần cố định 1.25 (≈51,3° so với mép) làm
    hoa văn dốc hơn bị ép về đúng 51,3° ngay khi qua đường trim ⇒ dải màu ĐỔI HƯỚNG
    ĐỘT NGỘT TẠI ĐƯỜNG TRIM. Đo trên file thật: mép dưới có dốc thật trung vị 2,72
    (≈70°), 91,8% hàng vượt trần, góc bẻ trung vị 27,0°.

    Nới trần vô điều kiện thì hỏng chỗ khác: trần còn là bảo hiểm chống hướng ước lượng
    SAI. Nới theo từng hàng cũng hỏng: chính chỗ trần chuyển giá trị lại tạo bậc mới
    trong trường hướng (đo được mép phải |Δs| 0,034 → 0,543, kéo dãn 20×). Nên quyết
    định ở CẤP MÉP — trần là một số cho cả dải, không thêm biến thiên nào vào trường.

    Ba điều kiện phải cùng đạt mới nới:
      1. Đa số hàng dốc cao (``_TRAJ_TRUST_MIN_FRACTION``) — không nới vì vài hàng lẻ.
      2. Chính các hàng đó có coherence cao (``_TRAJ_TRUST_MIN_COHERENCE``) — hướng rõ.
      3. Trường hướng ĐỒNG THUẬN: ``|ds/dr|`` nhỏ so với ngân sách gấp
         ``(1 − min_spacing)/amount``. Đây đúng là điều kiện ánh xạ thuận không gấp:
         dải SONG SONG thoả (đo 0,034), tia PHÂN KỲ không thoả (đo 0,112-0,211).
    """
    if not bool(valid.any()) or amount < 1:
        return float(_TRAJ_SLOPE_CAP_FLOOR)

    raw = np.abs(direction_x[valid] / direction_y[valid]).astype(np.float32)
    steep = raw > _TRAJ_SLOPE_CAP_FLOOR
    if float(np.mean(steep)) < _TRAJ_TRUST_MIN_FRACTION:
        return float(_TRAJ_SLOPE_CAP_FLOOR)
    if float(np.median(coherence[valid][steep])) < _TRAJ_TRUST_MIN_COHERENCE:
        return float(_TRAJ_SLOPE_CAP_FLOOR)

    # Đồng thuận đo trên trường ĐÃ trơn nhẹ, để bỏ nhiễu pixel mà giữ xu thế.
    probe = np.zeros(direction_x.size, dtype=np.float32)
    probe[valid] = np.clip(
        -direction_x[valid] / direction_y[valid],
        -_TRAJ_SLOPE_CAP_TRUSTED, _TRAJ_SLOPE_CAP_TRUSTED,
    ).astype(np.float32)
    if probe.size >= 3:
        probe = cv2.GaussianBlur(probe[:, None], (1, 0), 4.0).ravel()
    steep_full = np.zeros(probe.size, dtype=bool)
    steep_full[np.flatnonzero(valid)] = steep
    grad = np.abs(np.diff(probe))
    pair = steep_full[:-1] & steep_full[1:]
    if not bool(pair.any()):
        return float(_TRAJ_SLOPE_CAP_FLOOR)

    fold_budget = (1.0 - _TRAJ_MIN_SPACING) / float(amount)
    if float(np.median(grad[pair])) > _TRAJ_TRUST_FOLD_SLACK * fold_budget:
        return float(_TRAJ_SLOPE_CAP_FLOOR)
    return float(_TRAJ_SLOPE_CAP_TRUSTED)


def _project_no_fold(
    slopes: np.ndarray,
    amount: int,
    min_spacing: float,
) -> np.ndarray:
    """Chiếu trường dốc lên tập KHÔNG GẤP gần nhất theo L2 (isotonic/PAVA).

    BX-11 (audit bù xén lô B, 2026-07-30). Trước bản vá, tính đơn điệu của ánh xạ
    thuận được cưỡng chế bằng ``np.maximum.accumulate`` NGAY TRONG vòng ``for step``.
    Đó là cưỡng chế THAM LAM MỘT PHÍA: chỗ nào ``forward_y`` giảm thì cả một DÃY hàng
    bị ép về giá trị max đang chạy ⇒ dãy đó thành CAO NGUYÊN (nhiều hàng nguồn dồn vào
    một hàng đích, nhìn ra là vệt bị nén/nhoè). Sai lệch dồn hết về một bên vì nó chỉ
    biết kéo hàng lên, không bao giờ hạ hàng trước xuống. Đo trên oracle dốc 4,3: kẹp
    tới 46,8% hàng, cao nguyên dài 305 hàng.

    Điều kiện không gấp là ``1 + Δs·amount ≥ min_spacing`` ⇔ ``Δs ≥ −τ`` với
    ``τ = (1 − min_spacing)/amount``. Đặt ``u[r] = s[r] + τ·r`` thì nó thành "``u``
    không giảm", nên nghiệm GẦN NHẤT theo L2 đúng bằng isotonic regression (PAVA, O(h)).
    Vì ràng buộc được thoả ở bước LỚN NHẤT nên tự thoả ở mọi bước nhỏ hơn.

    Cùng bản chất với bài học BX-09: cưỡng chế MỘT LẦN trên ``slopes``, không cưỡng chế
    theo từng ``step``. Đo được: kẹp 6,8-46,8% → 0%, độ bám nét giữ nguyên, và ở dốc
    4,3 còn hạ sai số dốc 2,516 → 1,957 vì sai lệch được chia đều hai phía thay vì dồn.
    """
    count = int(slopes.size)
    if count < 2 or amount < 1:
        return slopes
    tau = (1.0 - float(min_spacing)) / float(amount)
    rows = np.arange(count, dtype=np.float64)
    lifted = slopes.astype(np.float64) + tau * rows
    # scipy>=1.12 (đã ghim trong requirements.txt) có sẵn PAVA.
    from scipy.optimize import isotonic_regression

    fitted = isotonic_regression(lifted, increasing=True).x
    return (fitted - tau * rows).astype(np.float32)


def _edge_tensor_field(
    img: np.ndarray,
    amount: int,
    px_per_mm: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Structure tensor của dải sát mép phải, gộp theo hàng và đã làm trơn.

    Tách khỏi ``_trajectory_right_strip`` (BX-12) để đo được riêng bước ƯỚC LƯỢNG
    HƯỚNG: mọi bước sau (góc, coherence, trần dốc, làm trơn, chiếu không-gấp, remap)
    chỉ tiêu thụ ba tensor này. Hành vi giữ nguyên từng byte so với bản gộp trong một
    hàm; việc tách chỉ mở một điểm thay thế để thử các bộ ước lượng bền hơn.
    """
    h, w = img.shape[:2]
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
    return tensor_xx, tensor_xy, tensor_yy


def _fit_fan_slopes_from_edge_segments(
    img: np.ndarray,
    amount: int,
    px_per_mm: float,
    analysis_rows: tuple[int, int] | None = None,
) -> np.ndarray | None:
    """Fit phối cảnh quạt từ các biên màu thực sự giao với mép trim.

    TRAJECTORY (2026-08-01): tensor gộp theo toàn dải nhìn cả các họ nét nằm sâu
    bên trong, nên trên lưới phối cảnh Binder162 nó ép gần như mọi nét ở mép dưới
    về cùng một dốc âm. Hough chỉ lấy đoạn thẳng chạm (hoặc ngoại suy ngắn tới)
    trim, sau đó IRLS/Huber loại chữ và họ nét cắt ngang. Fan đúng có quan hệ
    tuyến tính giữa vị trí giao mép và độ dốc; mẫu xung đột sẽ bị quality gate
    từ chối và quay về trường cục bộ cũ.
    """
    full_h, w = img.shape[:2]
    if analysis_rows is None:
        row_start, row_end = 0, full_h
    else:
        row_start = max(0, min(full_h, int(analysis_rows[0])))
        row_end = max(row_start, min(full_h, int(analysis_rows[1])))
    analysis_h = row_end - row_start
    if analysis_h < 24 or w < 12 or amount < 2:
        return None

    # TRAJECTORY: nhận diện hình học phải độc lập với độ dày bleed. Dải nhìn
    # 12 mm đủ để fit tiếp tuyến, còn amount chỉ quyết định kéo xa bao nhiêu.
    ppm = max(0.1, float(px_per_mm))
    lookback = min(w, max(24, int(round(12.0 * ppm))))
    band = np.ascontiguousarray(img[row_start:row_end, -lookback:])
    edge_maps = [
        cv2.Canny(band[:, :, channel], 25, 70)
        for channel in range(min(3, band.shape[2]))
    ]
    edges = edge_maps[0]
    for channel_edges in edge_maps[1:]:
        edges = cv2.bitwise_or(edges, channel_edges)

    lines = cv2.HoughLinesP(
        edges,
        1,
        np.pi / 720.0,
        threshold=max(10, int(round(1.00 * ppm))),
        minLineLength=max(8, int(round(0.85 * ppm))),
        maxLineGap=max(2, int(round(0.18 * ppm))),
    )
    if lines is None:
        return None

    row_samples = []
    slope_samples = []
    weight_samples = []
    min_dx = max(4.0, 0.50 * ppm)
    max_reach = max(8.0, 0.45 * lookback)
    edge_x = float(lookback - 1)
    for x1, y1, x2, y2 in lines[:, 0]:
        dx = float(x2 - x1)
        dy = float(y2 - y1)
        if abs(dx) < min_dx:
            continue
        slope = dy / dx
        if not np.isfinite(slope) or abs(slope) > _TRAJ_SLOPE_CAP_TRUSTED:
            continue
        reach = edge_x - float(max(x1, x2))
        if reach > max_reach:
            continue
        row_at_edge = float(y1) + slope * (edge_x - float(x1))
        if row_at_edge < -amount or row_at_edge > (analysis_h - 1 + amount):
            continue
        row_samples.append(row_at_edge + row_start)
        slope_samples.append(slope)
        weight_samples.append(max(1.0, abs(dx)))

    if len(row_samples) < max(8, int(np.ceil(analysis_h * 0.004))):
        return None
    rows = np.asarray(row_samples, dtype=np.float64)
    raw = np.asarray(slope_samples, dtype=np.float64)
    if float(np.ptp(rows)) < max(24.0, 0.45 * analysis_h):
        return None

    centre = 0.5 * (row_start + row_end - 1)
    scale = max(1.0, 0.5 * (analysis_h - 1))
    design = np.column_stack(((rows - centre) / scale, np.ones_like(rows)))
    base_weights = np.sqrt(np.asarray(weight_samples, dtype=np.float64))
    weights = base_weights.copy()
    coef = np.zeros(2, dtype=np.float64)
    for _ in range(8):
        root_w = np.sqrt(weights)
        coef = np.linalg.lstsq(
            design * root_w[:, None], raw * root_w, rcond=None,
        )[0]
        residual = raw - design @ coef
        mad = float(np.median(np.abs(residual - np.median(residual))))
        huber = max(0.06, 2.5 * 1.4826 * mad)
        robust = np.minimum(1.0, huber / np.maximum(np.abs(residual), 1e-9))
        weights = base_weights * robust

    predicted = design @ coef
    angle_error = np.abs(np.arctan(raw) - np.arctan(predicted))
    inliers = angle_error <= np.deg2rad(6.0)
    if (
        float(np.mean(inliers)) < 0.65
        or float(np.median(angle_error)) > np.deg2rad(3.0)
        or float(np.percentile(angle_error, 80)) > np.deg2rad(8.0)
    ):
        return None

    all_rows = np.arange(full_h, dtype=np.float64)
    fitted = coef[0] * ((all_rows - centre) / scale) + coef[1]
    return np.clip(
        fitted,
        -_TRAJ_SLOPE_CAP_TRUSTED,
        _TRAJ_SLOPE_CAP_TRUSTED,
    ).astype(np.float32)


def _fit_fan_trajectory_slopes(
    direction_x: np.ndarray,
    direction_y: np.ndarray,
    coherence: np.ndarray,
    valid: np.ndarray,
    slope_cap: float,
) -> np.ndarray | None:
    """Fit trường dốc tuyến tính khi các biên màu cùng xòe từ một tâm.

    TRAJECTORY (2026-07-31): với cánh quạt/tia tỏa, độ dốc tại mép là hàm tuyến
    tính theo vị trí dọc mép. Fit một mô hình chung giúp từng nan giữ đúng hướng
    mà không phải Gaussian trải hướng qua ranh giới hai màu. Nếu mẫu không phủ đủ
    mép hoặc sai số góc lớn, trả None để caller dùng trường cục bộ an toàn cũ.
    """
    rows = np.flatnonzero(valid)
    count = int(direction_x.size)
    if rows.size < max(8, int(np.ceil(count * 0.015))):
        return None
    if float(np.ptp(rows)) < max(12.0, 0.35 * count):
        return None

    raw = np.clip(
        -direction_x[valid] / direction_y[valid],
        -float(slope_cap),
        float(slope_cap),
    ).astype(np.float64)
    centre = 0.5 * max(1, count - 1)
    scale = max(1.0, centre)
    x = (rows.astype(np.float64) - centre) / scale
    design = np.column_stack((x, np.ones_like(x)))
    base_weights = np.clip(coherence[valid].astype(np.float64), 0.05, 1.0) ** 2
    weights = base_weights.copy()
    coef = np.zeros(2, dtype=np.float64)

    # IRLS/Huber: chữ, viền và nhiễu cục bộ không được kéo lệch tâm chung của quạt.
    for _ in range(5):
        root_w = np.sqrt(weights)
        coef = np.linalg.lstsq(
            design * root_w[:, None], raw * root_w, rcond=None,
        )[0]
        residual = raw - design @ coef
        mad = float(np.median(np.abs(residual - np.median(residual))))
        huber = max(0.08, 2.5 * 1.4826 * mad)
        robust = np.minimum(1.0, huber / np.maximum(np.abs(residual), 1e-9))
        weights = base_weights * robust

    predicted = design @ coef
    angle_error = np.abs(np.arctan(raw) - np.arctan(predicted))
    if (
        float(np.median(angle_error)) > np.deg2rad(6.0)
        or float(np.percentile(angle_error, 80)) > np.deg2rad(12.0)
        or float(np.median(coherence[valid])) < 0.20
    ):
        return None

    all_x = (np.arange(count, dtype=np.float64) - centre) / scale
    fitted = coef[0] * all_x + coef[1]
    return np.clip(fitted, -float(slope_cap), float(slope_cap)).astype(np.float32)


def _trajectory_right_strip(
    img: np.ndarray,
    amount: int,
    px_per_mm: float,
    preserve_color_bands: bool = False,
    analysis_rows: tuple[int, int] | None = None,
) -> np.ndarray:
    """Extrapolate the right edge by advecting colours along local isophotes."""
    amount = max(0, int(amount))
    h, w = img.shape[:2]
    if amount == 0:
        return np.empty((h, 0, 3), dtype=np.uint8)

    edge = np.ascontiguousarray(img[:, -1:])
    if h < 3 or w < 3:
        return np.repeat(edge, amount, axis=1)

    tensor_xx, tensor_xy, tensor_yy = _edge_tensor_field(
        img, amount, float(px_per_mm)
    )

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

    # BX-11 — trần dốc là quyết định CẤP MÉP, không phải cấp hàng. Đã thử trần biến
    # thiên theo từng hàng (nội suy theo coherence): nó xoá được khuỷu mép dưới nhưng
    # chính chỗ TRẦN CHUYỂN GIÁ TRỊ lại tạo bậc mới trong trường hướng — mép phải
    # |Δs| hàng-kề-hàng 0,034 → 0,543 và kéo dãn 20×. Trần một giá trị cho cả dải thì
    # không đưa thêm biến thiên nào vào trường, nên không sinh khuỷu mới.
    slope_cap = _trusted_slope_cap(
        direction_x, direction_y, coherence, valid, amount
    )

    slopes = np.zeros(h, dtype=np.float32)
    valid_rows = np.flatnonzero(valid)
    fan_slopes = None
    if preserve_color_bands:
        fan_slopes = _fit_fan_slopes_from_edge_segments(
            img, amount, float(px_per_mm), analysis_rows=analysis_rows,
        )
        if fan_slopes is None:
            fan_slopes = _fit_fan_trajectory_slopes(
                direction_x, direction_y, coherence, valid, slope_cap,
            )
    if fan_slopes is not None:
        slopes = fan_slopes
    elif valid_rows.size:
        valid_slopes = np.clip(
            -direction_x[valid] / direction_y[valid],
            -slope_cap, slope_cap,
        )
        slopes = np.interp(
            np.arange(h), valid_rows, valid_slopes
        ).astype(np.float32)
        # BX-07 (audit bù xén 2026-07-30) — điểm 2: làm trơn hướng theo BỀ RỘNG DẢI
        # VÀ chiều dài mép, không chỉ theo DPI. Đo trên file hoa văn tỏa thật: sigma cũ
        # (0.18×px_per_mm ≈ 2.1px @300DPI, trần 4) quá yếu — structure tensor dao động
        # giữa các hàng lân cận → trường dịch đổi dấu 7-26 lần, gãy 19px/hàng. Sai hướng
        # bị nhân lên theo ``step`` nên dải càng rộng càng phải trơn; mép DÀI cũng cần
        # sigma lớn hơn (mép 1738px mà sigma 12 vẫn xé thành 26 đoạn).
        sigma = max(
            0.8,
            min(
                _TRAJ_SMOOTH_MAX_SIGMA,
                max(
                    0.18 * max(0.1, px_per_mm),
                    _TRAJ_SMOOTH_PER_AMOUNT * amount,
                    _TRAJ_SMOOTH_PER_EDGE * h,
                ),
            ),
        )
        # Dập BẬC RỜI RẠC trước: nét dọc cắt ngang mép (chữ, viền, khung) tạo vài hàng
        # có hướng lệch hẳn so với lân cận. Gaussian chỉ trải bậc đó ra, còn median cắt
        # hẳn — và vì median bảo toàn xu thế đơn điệu, phân kỳ tổng thể của tia vẫn còn.
        med_k = int(min(31, max(3, round(sigma)))) | 1
        if h >= med_k:
            # cv2.medianBlur chỉ nhận uint8 khi ksize>5 → dùng scipy cho float32.
            from scipy.ndimage import median_filter
            slopes = median_filter(slopes, size=med_k, mode="nearest").astype(np.float32)
        slopes = cv2.GaussianBlur(slopes[:, None], (1, 0), sigma).ravel()

        # BX-07 — điểm 3: hàng KHÔNG valid (nền trơn, coherence thấp) trước đây được
        # ``np.interp`` bắc cầu tuyến tính qua khoảng trống lớn, tạo bậc giả giữa hai
        # cụm nét rời nhau. Sau khi làm trơn, kéo các hàng đó về 0 (đi thẳng) theo mức
        # độ "xa vùng có nét" để chúng không thừa hưởng độ dốc của cụm nét ở xa.
        if valid_rows.size < h:
            trust = np.zeros(h, dtype=np.float32)
            trust[valid_rows] = 1.0
            trust = cv2.GaussianBlur(trust[:, None], (1, 0), sigma).ravel()
            peak = float(trust.max())
            if peak > 1e-6:
                slopes *= np.clip(trust / peak, 0.0, 1.0)

        slopes = np.clip(slopes, -slope_cap, slope_cap)

    source_y = np.arange(h, dtype=np.float32)
    output_y = source_y.copy()
    # Build the exact same per-column inverse maps, then run one OpenCV remap
    # instead of ``amount`` separate 1-pixel calls. Interpolation is pixel-local,
    # so batching the maps does not alter output colours.
    map_x = np.zeros((h, amount), dtype=np.float32)
    map_y_all = np.empty((h, amount), dtype=np.float32)
    # BX-09 (audit bù xén lần 2, 2026-07-30) — chặn TẦM VỚI bằng cách kẹp ``slopes``
    # MỘT LẦN ở đây, không kẹp ``offset`` trong vòng lặp. Tầm với xa nhất của một hàng
    # là ``|slope| × amount``, nên điều kiện "không lấy màu xa hơn factor×amount" tương
    # đương "|slope| ≤ factor". Kẹp một lần ⇒ quỹ đạo là đường THẲNG suốt dải; kẹp theo
    # từng bước (bản cũ) làm nó gập khuỷu rồi chạy song song mép — chính là "gãy khúc"
    # người dùng thấy.
    # BX-11 — tầm với vẫn bị chặn, nhưng theo trần THEO HÀNG ở trên (đã gate bằng
    # coherence) thay vì một hằng số duy nhất. Giữ ``_TRAJ_MAX_REACH_FACTOR`` làm trần
    # cứng tuyệt đối cho hàng KHÔNG đáng tin — chính là giá trị cũ.
    min_spacing = _TRAJ_MIN_SPACING
    slopes = _project_no_fold(slopes, amount, min_spacing)
    for step in range(1, amount + 1):
        # Forward-warp source rows, enforce a monotone mapping to prevent local
        # trajectory crossings, then invert it for cv2.remap. This avoids pointed
        # wedges and duplicated bands when neighbouring tangent estimates differ.
        forward_y = source_y + slopes * float(step)
        # Phép chiếu ở trên đã bảo đảm đơn điệu ở bước XA NHẤT, nên tự bảo đảm ở mọi
        # bước nhỏ hơn; giữ lại accumulate làm lưới an toàn cho sai số float32.
        forward_y = np.maximum.accumulate(
            forward_y - source_y * min_spacing
        ) + source_y * min_spacing
        map_y_all[:, step - 1] = np.interp(
            output_y, forward_y, source_y, left=0.0, right=float(h - 1)
        ).astype(np.float32)
    return cv2.remap(
        edge,
        map_x,
        map_y_all,
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REPLICATE,
    )


def _trajectory_extension_strips(
    img: np.ndarray,
    before: int,
    after: int,
    px_per_mm: float,
    preserve_color_bands: bool = False,
    analysis_rows: tuple[int, int] | None = None,
) -> tuple[np.ndarray | None, np.ndarray | None]:
    """Tạo hai dải nở trước/sau mà không sao chép phần lõi của ảnh."""
    before = max(0, int(before))
    after = max(0, int(after))
    before_strip = None
    if before:
        # PERF (audit 2026-08-01 §RT.13): nhánh inpaint chỉ đọc dải tensor
        # tối đa 64 px sát mép. Đảo đúng dải đó thay vì sao chép cả raster 300 DPI.
        # Trajectory vẫn giữ toàn ảnh vì bộ fit fan dùng cửa sổ phân tích rộng hơn.
        reverse_source = img
        if not preserve_color_bands:
            lookback = min(
                img.shape[1],
                max(
                    8,
                    min(
                        64,
                        int(round(max(before, 1.5 * max(0.1, px_per_mm)))),
                    ),
                ),
            )
            reverse_source = img[:, :lookback]
        near_to_far = _trajectory_right_strip(
            np.ascontiguousarray(reverse_source[:, ::-1]),
            before,
            px_per_mm,
            preserve_color_bands=preserve_color_bands,
            analysis_rows=analysis_rows,
        )
        before_strip = near_to_far[:, ::-1]

    after_strip = None
    if after:
        after_strip = _trajectory_right_strip(
            img,
            after,
            px_per_mm,
            preserve_color_bands=preserve_color_bands,
            analysis_rows=analysis_rows,
        )
    return before_strip, after_strip


def _trajectory_extend_axis(
    img: np.ndarray,
    before: int,
    after: int,
    px_per_mm: float,
    preserve_color_bands: bool = False,
    analysis_rows: tuple[int, int] | None = None,
) -> np.ndarray:
    """Extend both ends of the image x-axis; callers transpose for top/bottom."""
    before = max(0, int(before))
    after = max(0, int(after))
    if before == 0 and after == 0:
        return img

    before_strip, after_strip = _trajectory_extension_strips(
        img,
        before,
        after,
        px_per_mm,
        preserve_color_bands=preserve_color_bands,
        analysis_rows=analysis_rows,
    )
    parts = []
    if before_strip is not None:
        parts.append(before_strip)
    parts.append(img)
    if after_strip is not None:
        parts.append(after_strip)
    return np.concatenate(parts, axis=1)


def _rectangle_smooth_color_fill(
    img: np.ndarray,
    pad_px: int,
    edge_bite_px: int,
    px_per_mm: float,
    pads: tuple[int, int, int, int] | None = None,
    preserve_color_bands: bool = False,
) -> np.ndarray:
    """Continue local edge trajectories into the rectangular bleed sides.

    ``pads`` (trái, phải, dưới, trên, tính bằng px) cho phép bù xén KHÔNG đều —
    dùng khi người dùng chỉ chọn một vài cạnh. Để ``None`` giữ nguyên hành vi cũ:
    cả 4 cạnh nở đúng ``pad_px``.

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
    if pads is None:
        pad_left = pad_right = pad_bottom = pad_top = pad
    else:
        pad_left, pad_right, pad_bottom, pad_top = (max(0, int(p)) for p in pads)
    bite_x = min(max(0, int(edge_bite_px)), max(0, (w - 1) // 2))
    bite_y = min(max(0, int(edge_bite_px)), max(0, (h - 1) // 2))
    core = img[bite_y:h - bite_y if bite_y else h,
               bite_x:w - bite_x if bite_x else w]
    if core.size == 0:
        core = img
        bite_x = bite_y = 0

    top = pad_top + bite_y
    bottom = pad_bottom + bite_y
    left = pad_left + bite_x
    right = pad_right + bite_x

    # PERF (audit 2026-08-01 §RT.13): cấp đúng một canvas đầu ra rồi ghi các
    # dải cạnh trực tiếp vào đó. Trước đây hai lần concatenate và hai lần
    # ascontiguousarray/transpose sao chép toàn canvas nhiều lần trên mỗi trang.
    core_h, core_w = core.shape[:2]
    out = np.empty(
        (top + core_h + bottom, left + core_w + right, core.shape[2]),
        dtype=core.dtype,
    )
    middle = out[top:top + core_h]
    left_strip, right_strip = _trajectory_extension_strips(
        core,
        left,
        right,
        float(px_per_mm),
        preserve_color_bands=preserve_color_bands,
    )
    if left_strip is not None:
        middle[:, :left] = left_strip
    middle[:, left:left + core_w] = core
    if right_strip is not None:
        middle[:, left + core_w:] = right_strip

    # Transpose chỉ là view. Top/bottom đọc cả dải ngang vừa tạo nên các góc vẫn
    # kế thừa đúng quỹ đạo hai cạnh như thuật toán cũ.
    vertical_input = np.transpose(middle, (1, 0, 2))
    top_strip, bottom_strip = _trajectory_extension_strips(
        vertical_input,
        top,
        bottom,
        float(px_per_mm),
        preserve_color_bands=preserve_color_bands,
        analysis_rows=(left, left + core_w),
    )
    if top_strip is not None:
        out[:top] = np.transpose(top_strip, (1, 0, 2))
    if bottom_strip is not None:
        out[top + core_h:] = np.transpose(bottom_strip, (1, 0, 2))

    # ``core`` and OpenCV's uint8 bilinear interpolation are already bounded by
    # their source samples. Avoid three full-canvas min/max/clip passes.
    return out


def _rectangle_trajectory_color_fill(
    img: np.ndarray,
    pad_px: int,
    edge_bite_px: int,
    px_per_mm: float,
    pads: tuple[int, int, int, int] | None = None,
) -> np.ndarray:
    """Bù xén theo quỹ đạo, ưu tiên giữ ranh giới nan/dải màu sắc nét."""
    return _rectangle_smooth_color_fill(
        img,
        pad_px,
        edge_bite_px,
        px_per_mm,
        pads=pads,
        preserve_color_bands=True,
    )


def _sparsify_rectangle_bleed(
    colors: np.ndarray,
    mask: np.ndarray,
    perimeter_px: int,
) -> np.ndarray:
    """Zero only invisible centre RGB pixels to make Flate compression cheap.

    The smart-bleed colours and SMask have already been calculated by the same
    300-DPI colour-managed algorithm. The PDF still stores one full-size image at
    the original CTM, avoiding any tile-boundary resampling. Visible pixels and a
    safety halo remain byte-identical. If the centre unexpectedly contains alpha,
    safely return the original image.
    """
    if (
        colors is None
        or mask is None
        or colors.ndim != 3
        or mask.ndim != 2
        or colors.shape[:2] != mask.shape
    ):
        return colors

    height, width = mask.shape
    edge = max(1, int(perimeter_px))
    edge = min(edge, max(1, height // 2), max(1, width // 2))
    if height <= 2 * edge or width <= 2 * edge:
        return colors

    # The caller includes a two-pixel safety halo in ``edge``. Keep the original
    # RGB everywhere close to non-zero alpha so PDF interpolation remains exact.
    if np.count_nonzero(mask[edge:height - edge, edge:width - edge]) != 0:
        return colors

    sparse = colors.copy()
    sparse[edge:height - edge, edge:width - edge] = 0
    return sparse


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


def _stable_pdf_object_signature(
    value,
    *,
    cache: dict | None = None,
    active: set | None = None,
    depth: int = 0,
):
    """Build an object-number-independent signature for a PDF resource.

    Worker PDFs assign new object numbers to copied images. The signature includes
    the complete stream dictionary (except /Length), nested ICC profiles and soft
    masks, so only byte-for-byte equivalent resources can be merged. Cyclic or
    unexpectedly deep graphs are rejected instead of being deduplicated.
    """
    if cache is None:
        cache = {}
    if active is None:
        active = set()
    if depth > 8:
        raise ValueError("PDF resource graph is too deep to deduplicate safely")

    if isinstance(value, pikepdf.Stream):
        object_id = ("stream", value.objgen)
        if value.objgen != (0, 0) and object_id in cache:
            return cache[object_id]
        if object_id in active:
            raise ValueError("Cyclic PDF stream resource")
        active.add(object_id)
        try:
            entries = tuple(sorted(
                (
                    str(key),
                    _stable_pdf_object_signature(
                        value.get(key), cache=cache, active=active, depth=depth + 1
                    ),
                )
                for key in value.keys()
                if str(key) != "/Length"
            ))
            signature = (
                "stream",
                entries,
                hashlib.sha256(value.read_raw_bytes()).digest(),
            )
        finally:
            active.remove(object_id)
        if value.objgen != (0, 0):
            cache[object_id] = signature
        return signature

    if isinstance(value, pikepdf.Array):
        return (
            "array",
            tuple(
                _stable_pdf_object_signature(
                    item, cache=cache, active=active, depth=depth + 1
                )
                for item in value
            ),
        )

    if isinstance(value, pikepdf.Dictionary):
        object_id = ("dict", value.objgen)
        if value.objgen != (0, 0) and object_id in cache:
            return cache[object_id]
        if object_id in active:
            raise ValueError("Cyclic PDF dictionary resource")
        active.add(object_id)
        try:
            signature = (
                "dict",
                tuple(sorted(
                    (
                        str(key),
                        _stable_pdf_object_signature(
                            value.get(key),
                            cache=cache,
                            active=active,
                            depth=depth + 1,
                        ),
                    )
                    for key in value.keys()
                    if str(key) != "/Length"
                )),
            )
        finally:
            active.remove(object_id)
        if value.objgen != (0, 0):
            cache[object_id] = signature
        return signature

    return (type(value).__name__, str(value))


def _deduplicate_image_xobjects(pdf: pikepdf.Pdf) -> dict:
    """Rewire identical image resources introduced by cross-worker PDF merges."""
    started = time.perf_counter()
    signature_cache = {}
    canonical_by_signature = {}
    replacements = {}
    duplicate_bytes = 0
    image_count = 0

    for obj in list(pdf.objects):
        try:
            if not (
                isinstance(obj, pikepdf.Stream)
                and str(obj.get("/Subtype", "")) == "/Image"
                and obj.objgen != (0, 0)
            ):
                continue
            image_count += 1
            signature = _stable_pdf_object_signature(obj, cache=signature_cache)
            canonical = canonical_by_signature.get(signature)
            if canonical is None:
                canonical_by_signature[signature] = obj
            else:
                replacements[obj.objgen] = canonical
                duplicate_bytes += int(obj.get("/Length", 0) or 0)
        except Exception as exc:
            logger.debug("Skip unsafe image dedup candidate: %s", exc)

    rewired = 0
    if replacements:
        for obj in list(pdf.objects):
            try:
                if (
                    isinstance(obj, pikepdf.Stream)
                    and str(obj.get("/Subtype", "")) == "/Image"
                ):
                    for key in ("/SMask", "/Mask"):
                        ref = obj.get(key, None)
                        if isinstance(ref, pikepdf.Stream):
                            canonical = replacements.get(ref.objgen)
                            if canonical is not None:
                                obj[pikepdf.Name(key)] = canonical
                                rewired += 1

                if not isinstance(obj, (pikepdf.Dictionary, pikepdf.Stream)):
                    continue
                resources = obj.get("/Resources", None)
                if not isinstance(resources, pikepdf.Dictionary):
                    continue
                xobjects = resources.get("/XObject", None)
                if not isinstance(xobjects, pikepdf.Dictionary):
                    continue
                for name in list(xobjects.keys()):
                    ref = xobjects.get(name)
                    if not isinstance(ref, pikepdf.Stream):
                        continue
                    canonical = replacements.get(ref.objgen)
                    if canonical is not None:
                        xobjects[name] = canonical
                        rewired += 1
            except Exception as exc:
                logger.debug("Cannot rewrite one PDF image resource: %s", exc)

        pdf.remove_unreferenced_resources()

    return {
        "images": image_count,
        "unique": len(canonical_by_signature),
        "duplicates": len(replacements),
        "rewired": rewired,
        "candidate_bytes": duplicate_bytes,
        "seconds": time.perf_counter() - started,
    }

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
    sample_inset_pts: float = 0.0,
    sides=None,
) -> tuple[list[str], float, float, float, float]:
    """Stretch vector edge/corner strips around a rectangular page.

    Unlike the contour/sticker path, this never filters white pixels and never
    converts process/ICC/spot colors to RGB. ``edge_bite_pts`` both moves the
    sampled strip and replaces the requested inner artwork strip. By contrast,
    ``sample_inset_pts`` only moves the source strip inward; it never widens the
    destination bleed or clips artwork. Returned bite values therefore describe
    only the explicit, destructive edge bite.

    ``sides`` chọn cạnh nào được bù xén (mặc định cả 4, xem
    ``app.core.bleed_sides``). Cạnh TẮT không nở khổ, không lẹm mép và không
    sinh dải kéo giãn; góc chỉ được vẽ khi CẢ HAI cạnh kề đều bật — nếu không,
    dải cạnh còn lại đã tự phủ hết chiều dài nên vẽ góc sẽ đè chồng sai màu.
    Trả về: ``(commands, bite_trái, bite_phải, bite_dưới, bite_trên)``.
    """
    side_l, side_r, side_b, side_t = normalize_bleed_sides(sides)
    if bleed_pts <= 0 or page_width <= 0 or page_height <= 0:
        return [], 0.0, 0.0, 0.0, 0.0
    if not (side_l or side_r or side_b or side_t):
        return [], 0.0, 0.0, 0.0, 0.0

    depth_x = min(max(0.01, sample_depth_pts), max(0.01, page_width / 2.0))
    depth_y = min(max(0.01, sample_depth_pts), max(0.01, page_height / 2.0))
    bite_x = min(max(0.0, edge_bite_pts), max(0.0, page_width / 2.0 - depth_x))
    bite_y = min(max(0.0, edge_bite_pts), max(0.0, page_height / 2.0 - depth_y))
    sample_inset_x = min(
        max(0.0, sample_inset_pts), max(0.0, page_width / 2.0 - depth_x - bite_x)
    )
    sample_inset_y = min(
        max(0.0, sample_inset_pts), max(0.0, page_height / 2.0 - depth_y - bite_y)
    )

    # Lẹm mép chỉ có nghĩa ở cạnh ĐANG bù xén: cạnh không bù mà vẫn lẹm thì
    # artwork bị cắt bớt mà không có gì kéo ra bù lại → mất nội dung sát mép.
    bite_left = bite_x if side_l else 0.0
    bite_right = bite_x if side_r else 0.0
    bite_bottom = bite_y if side_b else 0.0
    bite_top = bite_y if side_t else 0.0

    bleed_left = bleed_pts if side_l else 0.0
    bleed_right = bleed_pts if side_r else 0.0
    bleed_bottom = bleed_pts if side_b else 0.0
    bleed_top = bleed_pts if side_t else 0.0

    out_w = page_width + bleed_left + bleed_right
    out_h = page_height + bleed_bottom + bleed_top
    # ext = bề rộng dải phải lấp ở mỗi cạnh = phần nở ra ngoài + phần lẹm vào trong.
    ext_left = bleed_left + bite_left
    ext_right = bleed_right + bite_right
    ext_bottom = bleed_bottom + bite_bottom
    ext_top = bleed_top + bite_top
    sx_left = ext_left / depth_x
    sx_right = ext_right / depth_x
    sy_bottom = ext_bottom / depth_y
    sy_top = ext_top / depth_y
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

    src_left = crop_x0 + bite_left + (sample_inset_x if side_l else 0.0)
    src_right = (
        crop_x0 + page_width - bite_right - (sample_inset_x if side_r else 0.0) - depth_x
    )
    src_bottom = crop_y0 + bite_bottom + (sample_inset_y if side_b else 0.0)
    src_top = crop_y0 + page_height - bite_top - (sample_inset_y if side_t else 0.0) - depth_y
    # Artwork được đặt ở gốc (bleed_left, bleed_bottom) trên khổ mới, nên phép
    # dịch "giữ nguyên tỉ lệ" của trục còn lại phải theo đúng 2 số này.
    x_identity_shift = bleed_left - crop_x0
    y_identity_shift = bleed_bottom - crop_y0
    dst_right = out_w - ext_right
    dst_top = out_h - ext_top

    # Four sides, excluding corner squares.
    place(0.0, ext_bottom, ext_left, out_h - ext_bottom - ext_top,
          sx_left, 1.0, -sx_left * src_left, y_identity_shift)
    place(dst_right, ext_bottom, ext_right, out_h - ext_bottom - ext_top,
          sx_right, 1.0, dst_right - sx_right * src_right, y_identity_shift)
    place(ext_left, 0.0, out_w - ext_left - ext_right, ext_bottom,
          1.0, sy_bottom, x_identity_shift, -sy_bottom * src_bottom)
    place(ext_left, dst_top, out_w - ext_left - ext_right, ext_top,
          1.0, sy_top, x_identity_shift, dst_top - sy_top * src_top)

    # Four corners. Keeping them as vector form draws preserves ICC/spot color.
    # ``place`` tự bỏ qua khi w/h <= 0 → cạnh tắt (ext = 0) không sinh góc.
    place(0.0, 0.0, ext_left, ext_bottom,
          sx_left, sy_bottom, -sx_left * src_left, -sy_bottom * src_bottom)
    place(dst_right, 0.0, ext_right, ext_bottom,
          sx_right, sy_bottom, dst_right - sx_right * src_right, -sy_bottom * src_bottom)
    place(0.0, dst_top, ext_left, ext_top,
          sx_left, sy_top, -sx_left * src_left, dst_top - sy_top * src_top)
    place(dst_right, dst_top, ext_right, ext_top,
          sx_right, sy_top, dst_right - sx_right * src_right, dst_top - sy_top * src_top)

    return commands, bite_left, bite_right, bite_bottom, bite_top


# ── Ngưỡng song song ─────────────────────────────────────────────────────
# Overhead spawn trên Windows ~2-3s/worker (child re-import cv2/scipy/skimage/
# pikepdf/pdfium). Với ~2s/trang, break-even ≈ 6 trang. File < ngưỡng chạy tuần
# tự tại chỗ (không spawn) để không chậm hơn.
_STICKER_PARALLEL_MIN_PAGES = 6

# Sau khi pool crash (OOM), giữ chế độ tuần tự một lúc để in liên tục không
# lặp crash→fallback mỗi file (lãng phí thời gian + RAM).
# TTL auto theo cấu hình máy; override: STICKER_STICKY_SEQ_SEC (0 = tắt sticky).
_sticky_sequential_until: float = 0.0
# Cache profile phần cứng (total RAM/CPU không đổi trong process).
_hw_profile_cache: dict | None = None
_hw_profile_logged: bool = False


def _env_float_or_none(name: str) -> float | None:
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == "":
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def _env_int_or_none(name: str) -> int | None:
    v = _env_float_or_none(name)
    if v is None:
        return None
    return int(v)


def _read_memory_status() -> tuple[float | None, float | None]:
    """(total_mb, available_mb) dùng chung chính sách toàn backend."""
    from app.core.system_memory import read_memory_status_mb

    return read_memory_status_mb()


def _available_ram_mb() -> float | None:
    """RAM vật lý còn trống (MB). None nếu không đọc được."""
    _total, avail = _read_memory_status()
    return avail


def _total_ram_mb() -> float | None:
    total, _avail = _read_memory_status()
    return total


def _auto_sticker_hw_profile(
    *,
    total_ram_mb: float | None = None,
    cpu_count: int | None = None,
) -> dict:
    """Suy ra max_workers + sticky TTL theo cấu hình máy.

    Bảng theo rule phần cứng của dự án:
      RAM < 8GB            → workers 1, sticky 15'
      8–16GB               → tối đa 2 workers, sticky 10'
      ≥16GB                → CPU-1 workers, sticky tắt

    Env STICKER_MAX_WORKERS / STICKER_STICKY_SEQ_SEC ghi đè khi set.
    Không cache ở đây — dùng get_sticker_hw_profile() cho production cache.
    """
    global _hw_profile_logged

    if total_ram_mb is None:
        total_ram_mb = _total_ram_mb()
    if cpu_count is None:
        cpu_count = os.cpu_count() or 2
    cpu_count = max(1, int(cpu_count))
    ram = float(total_ram_mb) if total_ram_mb is not None else 8192.0  # giả định 8GB

    # ── Workers theo RAM + CPU ──
    cpu_workers = max(1, cpu_count - 1)
    if ram < 8 * 1024:
        workers, sticky, tier = 1, 900.0, "low"
    elif ram < 16 * 1024:
        workers, sticky, tier = min(cpu_workers, 2), 600.0, "mid"
    else:
        # PERF (audit 2026-08-05 §ALPHA.P1): máy mạnh không bị cap theo bảng
        # cứng. Fitter Alpha chủ yếu chạy một luồng Python/GEOS mỗi process;
        # CPU-1 mới dùng hết phần cứng mà vẫn chừa một nhân cho UI/backend.
        workers, sticky, tier = cpu_workers, 0.0, "full"

    env_workers = _env_int_or_none("STICKER_MAX_WORKERS")
    env_sticky = _env_float_or_none("STICKER_STICKY_SEQ_SEC")
    workers_src = "env" if env_workers is not None else "auto"
    sticky_src = "env" if env_sticky is not None else "auto"
    if env_workers is not None:
        workers = max(1, env_workers)
    if env_sticky is not None:
        sticky = max(0.0, env_sticky)

    profile = {
        "max_workers": workers,
        "sticky_seq_sec": sticky,
        "tier": tier,
        "total_ram_mb": ram,
        "cpu_count": cpu_count,
        "workers_src": workers_src,
        "sticky_src": sticky_src,
    }

    if not _hw_profile_logged:
        logger.info(
            "[STICKER] hw auto profile tier=%s workers=%d (%s) sticky_sec=%.0f (%s) "
            "ram_total_mb=%.0f cpu=%d",
            tier, workers, workers_src, sticky, sticky_src, ram, cpu_count,
        )
        _hw_profile_logged = True

    return profile


def get_sticker_hw_profile(*, refresh: bool = False) -> dict:
    """Profile phần cứng (cache 1 lần/process). refresh=True để đọc lại env/hw."""
    global _hw_profile_cache
    if refresh or _hw_profile_cache is None:
        _hw_profile_cache = _auto_sticker_hw_profile()
    return _hw_profile_cache


def _sticky_seq_seconds() -> float:
    """TTL sticky sequential. Env ghi đè; không set → auto theo máy."""
    return float(get_sticker_hw_profile()["sticky_seq_sec"])


def _mark_pool_crash_sticky() -> None:
    """Ghi nhận pool crash → job tiếp theo ưu tiên tuần tự trong TTL."""
    global _sticky_sequential_until
    ttl = _sticky_seq_seconds()
    if ttl <= 0:
        logger.info(
            "[STICKER] pool crash but sticky disabled (ttl=0) — vẫn thử pool job sau"
        )
        return
    _sticky_sequential_until = time.time() + ttl
    logger.warning(
        "[STICKER] sticky sequential ON for %.0fs (pool crash) — "
        "in liên tục sẽ không spawn pool lại cho đến khi hết TTL "
        "hoặc set STICKER_STICKY_SEQ_SEC=0",
        ttl,
    )


def _sticky_sequential_active() -> bool:
    return time.time() < _sticky_sequential_until


def _default_sticker_max_workers() -> int:
    """Max workers mặc định: auto theo RAM/CPU, hoặc STICKER_MAX_WORKERS nếu set."""
    return int(get_sticker_hw_profile()["max_workers"])


def _estimate_worker_ram_mb(
    page_w_pt: float,
    page_h_pt: float,
    dpi: int = 300,
    *,
    light_path: bool = False,
) -> float:
    """Ước lượng peak RAM (MB) cho 1 worker xử lý 1 trang sticker.

    light_path=True: xén thằng + bleed vector (không raster full page) → nhẹ.
    """
    if light_path:
        # pikepdf + pdfium open + form XObject copy — không bitmap khổ lớn.
        return 250.0
    if page_w_pt <= 0 or page_h_pt <= 0:
        return 400.0
    scale = dpi / 72.0
    w = page_w_pt * scale
    h = page_h_pt * scale
    long_px = max(w, h)
    if long_px > 6000:
        s = 6000.0 / long_px
        w, h = w * s, h * s
    mp = w * h
    if mp > 40_000_000:
        s = (40_000_000 / mp) ** 0.5
        w, h = w * s, h * s
    # ~10 byte/px peak (RGBA + mask + bleed buffers) + overhead process Windows.
    raster_mb = (w * h * 10.0) / (1024.0 * 1024.0)
    return max(200.0, raster_mb + 280.0)


def _n_pages_should_parallelize(n_pages: int) -> bool:
    """True nếu nên fan-out song song (đủ nhiều trang để bù overhead spawn).

    STICKER_FORCE_SEQUENTIAL=1 → luôn tắt pool (debug OOM / crash worker).
    Sticky sequential sau pool crash → tắt tạm để in liên tục ổn định.
    """
    if os.environ.get("STICKER_FORCE_SEQUENTIAL", "").lower() in ("1", "true", "yes"):
        return False
    if _sticky_sequential_active():
        left = max(0.0, _sticky_sequential_until - time.time())
        logger.info(
            "[STICKER] skip parallel (sticky sequential, %.0fs left) pages=%d",
            left, n_pages,
        )
        return False
    return n_pages >= _STICKER_PARALLEL_MIN_PAGES


def _is_process_pool_crash(exc: BaseException) -> bool:
    """True khi worker pool bị kill (OOM / native crash) thay vì raise Python."""
    if isinstance(exc, BrokenProcessPool):
        return True
    name = type(exc).__name__
    if name in ("BrokenProcessPool", "BrokenExecutor"):
        return True
    msg = str(exc).lower()
    return (
        "terminated abruptly" in msg
        or "brokenprocesspool" in msg
        or "broken executor" in msg
    )


def _cap_sticker_workers(
    n_workers: int,
    n_pages: int,
    input_path: str,
    *,
    page_w_pt: float = 0.0,
    page_h_pt: float = 0.0,
    dpi: int = 300,
    light_path: bool = False,
) -> int:
    """Chỉ giảm worker trên máy <16GB; máy mạnh giữ full theo profile."""
    cap = n_workers
    if _env_int_or_none("STICKER_MAX_WORKERS") is not None:
        # Escape hatch vận hành luôn thắng auto/RAM gate. Caller đã chặn theo
        # số trang và CPU khả dụng trước khi vào đây.
        return max(1, cap)
    total, avail = _read_memory_status()
    per_worker = _estimate_worker_ram_mb(
        page_w_pt, page_h_pt, dpi, light_path=light_path,
    )
    is_weak = total is not None and total < 16 * 1024
    if is_weak and avail is not None and per_worker > 0:
        # Giữ ~35% RAM cho OS + app UI + backend cha; không dùng hết free RAM.
        budget = max(0.0, avail * 0.65)
        by_ram = max(1, int(budget // per_worker))
        if by_ram < cap:
            logger.info(
                "[STICKER] RAM cap workers %d→%d (avail_mb=%.0f per_worker_mb=%.0f "
                "budget_mb=%.0f page=%.0fx%.0fpt light=%s)",
                cap, by_ram, avail, per_worker, budget,
                page_w_pt, page_h_pt, light_path,
            )
        cap = min(cap, by_ram)
        if avail < 900:
            cap = 1
            logger.warning(
                "[STICKER] low RAM avail_mb=%.0f → force 1 worker", avail,
            )

    # ``input_path`` và ``n_pages`` được giữ trong signature vì caller/test cũ,
    # nhưng dung lượng file/số trang không phản ánh peak RAM của MỘT worker.
    # File 288MB/72 trang từng bị ép 1 worker trên máy 32GB và chậm 86 giây.
    _ = input_path, n_pages
    return max(1, cap)


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
    pages = args.get("page_indices") or []
    t0 = time.perf_counter()
    logger.info(
        "[STICKER] chunk start idx=%s pages=%s pid=%s",
        chunk_idx, pages, os.getpid(),
    )
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
    try:
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
            edge_sample_inset_mm=args.get("edge_sample_inset_mm", 0.0),
            cut_first_page_only=args["cut_first_page_only"],
            shape_mode=args.get("shape_mode", "auto_safe"),
            bleed_sides=args.get("bleed_sides"),
            _page_subset=args["page_indices"],
        )
        # result = (bytes, metas, pages_no_dieline, any_dieline)
        logger.info(
            "[STICKER] chunk done idx=%s pages=%s s=%.2f pid=%s",
            chunk_idx, pages, time.perf_counter() - t0, os.getpid(),
        )
        return (chunk_idx, result)
    except Exception:
        logger.error(
            "[STICKER] chunk FAILED idx=%s pages=%s s=%.2f pid=%s",
            chunk_idx, pages, time.perf_counter() - t0, os.getpid(),
            exc_info=True,
        )
        raise


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
        edge_sample_inset_mm: float = 0.0,
        cut_first_page_only: bool = False,
        shape_mode: str = "auto_safe",
        bleed_sides=None,
        selected_objects_by_page: dict | None = None,
        process_pages: list[int] | None = None,
        _page_subset: list = None,
    ) -> tuple:
        # _page_subset: khi != None, CHỈ xử lý các trang có index trong list (theo
        # đúng thứ tự truyền vào) và lưu output ra output_path. Dùng cho worker song
        # song — mỗi tiến trình con xử lý một dải trang liền kề rồi trả file chunk.
        # output_path lúc đó là file chunk tạm. page_idx trong log/meta vẫn là index
        # GLOBAL (index thật trong file gốc) để concat + cảnh báo trang đúng số.
        debug_step = "Init"
        selection_targets: dict[int, list[str]] = {}
        if selected_objects_by_page:
            for raw_page, raw_ids in selected_objects_by_page.items():
                page_number = int(raw_page)
                object_ids = list(dict.fromkeys(
                    str(obj_id).strip() for obj_id in (raw_ids or []) if str(obj_id).strip()
                ))
                if page_number < 0 or not object_ids:
                    raise ValueError("Selection object không hợp lệ.")
                selection_targets[page_number] = object_ids
        selection_mode = bool(selection_targets)
        # Chỉ dịch nguồn lấy màu; tuyệt đối không dùng giá trị này để co footprint/clip.
        try:
            edge_sample_inset_mm = float(edge_sample_inset_mm)
        except (TypeError, ValueError):
            edge_sample_inset_mm = 0.0
        if not math.isfinite(edge_sample_inset_mm):
            edge_sample_inset_mm = 0.0
        edge_sample_inset_mm = max(0.0, min(5.0, edge_sample_inset_mm))
        if selection_mode and rectangle_mode:
            raise ValueError("Selection object chỉ hỗ trợ chế độ Bế tem nhãn.")

        process_page_indexes: set[int] | None = None
        if process_pages is not None:
            try:
                process_page_indexes = {int(page) - 1 for page in process_pages}
            except (TypeError, ValueError):
                raise ValueError("Danh sách trang xử lý không hợp lệ.") from None
            if not process_page_indexes or min(process_page_indexes) < 0:
                raise ValueError("Danh sách trang xử lý không hợp lệ.")
            if selection_mode:
                raise ValueError("Không dùng đồng thời phạm vi trang và selection object.")

        # ── Cạnh bù xén (chỉ Xén vuông góc) ────────────────────────────────
        # Bế tem nhãn bù xén quanh ĐƯỜNG CONTOUR nên "cạnh trên/dưới/trái/phải"
        # không có nghĩa hình học ở đó → chỉ rectangle_mode mới áp lựa chọn cạnh,
        # nhánh tem luôn nở đều như trước (không hồi quy).
        if rectangle_mode:
            bleed_sides_resolved = normalize_bleed_sides(bleed_sides)
            if not any(bleed_sides_resolved):
                # Không chọn cạnh nào = không bù xén. Hạ bleed về 0 NGAY tại đây để
                # mọi nhánh dưới (vector/raster/pad/page box) tự bỏ qua, thay vì
                # sinh canvas y hệt khổ gốc kèm một lớp ảnh ring vô hình.
                if bleed_mm > 0:
                    # Log để truy vết: client gửi giá trị lạ cũng rơi vào đây, và khi
                    # đó người dùng sẽ thấy file KHÔNG có bù xén dù đã nhập số mm.
                    logger.warning(
                        "[STICKER] bleed_sides=%r không chọn cạnh nào → bỏ bù xén "
                        "(bleed_mm=%.2f bị hạ về 0)",
                        bleed_sides, bleed_mm,
                    )
                bleed_mm = 0.0
        else:
            bleed_sides_resolved = ALL_BLEED_SIDES
        bleed_side_l, bleed_side_r, bleed_side_b, bleed_side_t = bleed_sides_resolved
        cut_mode = str(cut_mode or "original").strip().lower()
        alpha_contour_mode = cut_mode == "alpha"
        if alpha_contour_mode:
            # Alpha là silhouette đã chủ đích của PNG; không tái dựng thành hình
            # chuẩn và không bo lại contour của khách.
            corner_style = "preserve"
            shape_mode = "contour"

        corner_style = str(corner_style or "round").strip().lower()
        preserve_contour = corner_style in {"preserve", "original"}
        if preserve_contour:
            # "Giữ nguyên" luôn theo contour raster gốc; không tự tái dựng hình chuẩn.
            corner_style = "preserve"
            shape_mode = "contour"
        doc_in_pdfium = None
        doc_in_pike = None
        doc_out = None
        try:
            debug_step = "Open Original PDF"
            doc_in_pdfium = pdfium.PdfDocument(input_path)
            doc_in_pike = pikepdf.Pdf.open(input_path)
            invalid_pages = sorted(page for page in selection_targets if page >= len(doc_in_pdfium))
            if invalid_pages:
                raise ValueError(
                    "Selection tham chiếu trang không tồn tại: "
                    + ", ".join(str(page + 1) for page in invalid_pages)
                )

            if process_page_indexes is not None:
                invalid_process_pages = sorted(
                    page for page in process_page_indexes if page >= len(doc_in_pdfium)
                )
                if invalid_process_pages:
                    raise ValueError("Danh sách trang xử lý tham chiếu trang không tồn tại.")
            # ── ORCHESTRATOR: song song hóa khi gọi top-level + file nhiều trang ──
            # _page_subset None = gọi top-level (không phải worker). File >= ngưỡng →
            # chia dải trang liền kề cho nhiều tiến trình con, mỗi con tự mở lại file
            # + xử lý chunk + trả file PDF, rồi merge ở đây. Overhead spawn Windows
            # ~2-3s/worker nên file nhỏ (< ngưỡng) chạy tuần tự tại chỗ (rơi xuống dưới).
            if (
                _page_subset is None
                and not selection_mode
                and process_page_indexes is None
                and _n_pages_should_parallelize(len(doc_in_pdfium))
            ):
                n_pages_probe = len(doc_in_pdfium)
                try:
                    input_mb = os.path.getsize(input_path) / (1024 * 1024)
                except OSError:
                    input_mb = 0.0
                logger.info(
                    "[STICKER] parallel fan-out pages=%d input_mb=%.2f rectangle=%s "
                    "bleed_mm=%s cut_mode=%s dpi=%s path=%s",
                    n_pages_probe, input_mb, rectangle_mode, bleed_mm, cut_mode,
                    self.dpi, os.path.basename(input_path),
                )
                doc_in_pdfium.close(); doc_in_pdfium = None
                doc_in_pike.close(); doc_in_pike = None
                # Nhãn đúng bước (trước đây lỗi pool vẫn dính "Open Original PDF@…").
                debug_step = "Process Parallel Workers"
                return self._process_parallel(
                    input_path=input_path, output_path=output_path,
                    cut_mode=cut_mode, offset_mm=offset_mm, corner_style=corner_style,
                    cut_color=cut_color, bleed_mm=bleed_mm, fill_holes=fill_holes,
                    remove_white_bg=remove_white_bg, bleed_color_type=bleed_color_type,
                    solid_bleed_color=solid_bleed_color, draw_cut_contour=draw_cut_contour,
                    rectangle_mode=rectangle_mode, edge_bite_mm=edge_bite_mm,
                    edge_sample_inset_mm=edge_sample_inset_mm,
                    cut_first_page_only=cut_first_page_only,
                    shape_mode=shape_mode,
                    bleed_sides=bleed_sides_resolved,
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
            # Lùi 0,15 mm để dao nằm trong vùng mực chắc chắn ở mép Alpha bán trong suốt.
            effective_offset_mm = offset_mm - (ALPHA_CONTOUR_INSET_MM if alpha_contour_mode else 0.0)
            offset_pts = effective_offset_mm * mm_to_pts
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
                page_started = time.perf_counter()
                gs_seconds = 0.0
                smooth_seconds = 0.0
                compress_seconds = 0.0
                alpha_fallback_used = False
                alpha_contour_warning = None
                debug_step = f"Rasterize Page {page_idx}"
                page_in = doc_in_pdfium[page_idx]
                page_in_pike = doc_in_pike.pages[page_idx]
                selection_page_mode = page_idx in selection_targets
                if process_page_indexes is not None and page_idx not in process_page_indexes:
                    doc_out.pages.append(page_in_pike)
                    all_pages_meta.append({
                        "process_skipped": True,
                        "page": page_idx + 1,
                    })
                    continue

                if selection_mode and not selection_page_mode:
                    doc_out.pages.append(page_in_pike)
                    all_pages_meta.append({
                        "selection_skipped": True,
                        "page": page_idx + 1,
                    })
                    continue

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
                    if selection_page_mode:
                        img = _render_selected_objects_rgba(
                            page_in,
                            selection_targets[page_idx],
                            self.scale,
                        )
                        img_native = img[:, :, :3].copy()
                        has_alpha = True

                    use_color_managed_rectangle_raster = (
                        rectangle_mode
                        and bleed_color_type in ("inpaint", "trajectory")
                        and bleed_pts > 0
                    )
                    if not selection_page_mode and use_color_managed_rectangle_raster:
                        gs_started = time.perf_counter()
                        img_native = _render_page_rgb_ghostscript(
                            input_path,
                            page_idx,
                            self.scale,
                            max(1, int(round(float(pw_pt) * self.scale))),
                            max(1, int(round(float(ph_pt) * self.scale))),
                        )
                        gs_seconds = time.perf_counter() - gs_started
                        if img_native is None:
                            logger.warning(
                                "Smart rectangle bleed page %d is falling back to PDFium RGB",
                                page_idx + 1,
                            )

                    if selection_page_mode:
                        pass
                    elif img_native is not None:
                        img = cv2.cvtColor(img_native, cv2.COLOR_RGB2RGBA)
                        has_alpha = False
                    else:
                        if alpha_contour_mode:
                            # PDF trung gian của PNG giữ Alpha trong /SMask. Render
                            # nền trong suốt để lấy lại silhouette, không composite trắng.
                            bitmap = page_in.render(
                                scale=self.scale,
                                fill_color=(0, 0, 0, 0),
                                rev_byteorder=True,
                            )
                            img = np.ascontiguousarray(bitmap.to_numpy())
                            if img.ndim != 3 or img.shape[2] != 4:
                                raise RuntimeError("PDFium không trả về ảnh RGBA cho contour Alpha.")
                            img_native = img[:, :, :3].copy()
                        else:
                            bitmap = page_in.render(scale=self.scale)
                            img_bgra = bitmap.to_numpy()
                            img = cv2.cvtColor(img_bgra, cv2.COLOR_BGRA2RGBA)
                            img_native = cv2.cvtColor(img_bgra, cv2.COLOR_BGRA2RGB)
                        has_alpha = (
                            img.shape[2] == 4
                            and img[:, :, 3].min() < 255
                            and img[:, :, 3].max() > 10
                        )
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
                    if alpha_contour_mode and has_alpha:
                        base_mask = img[:, :, 3].copy()
                    elif alpha_contour_mode:
                        base_mask = _foreground_mask_from_corner_background(
                            img[:, :, :3]
                        )
                        if base_mask is None:
                            raise ValueError(
                                "PDF không còn nền trong suốt và màu nền bốn góc "
                                "không đủ đồng nhất để tạo đường cắt."
                            )
                        alpha_fallback_used = True
                        alpha_contour_warning = (
                            f"Trang {page_idx + 1}: PDF không còn Alpha; đã tách nền "
                            "theo màu ở bốn góc. Hãy kiểm tra lại đường cắt."
                        )
                    elif has_alpha:
                        base_mask = img[:, :, 3].copy()
                    else:
                        if remove_white_bg:
                            hsv = cv2.cvtColor(img[:,:,:3], cv2.COLOR_RGB2HSV)
                            # Ngưỡng SIẾT MẠNH: chỉ coi là "trắng nền" khi RẤT sáng
                            # (V>=200) VÀ GẦN NHƯ VÔ SẮC TUYỆT ĐỐI (S<=2 ≈ 0.8%). Lý do:
                            # màu nền gần-trung-tính rất nhạt vẫn LÀ NỘI DUNG nhãn, phải GIỮ.
                            # Thực tế các màu như C9.8 M7.06 Y7.84 (S≈7.5) và C3.92 M2.35 Y5.1
                            # (S≈7.2) — CMY xúm gần nhau nên chroma thấp — từng bị ngưỡng S<=8
                            # bóc nhầm như nền trắng. Hạ xuống S<=2 để mọi màu gần-xám nhạt
                            # (S>2) được giữ; chỉ trắng gần tuyệt đối (S<=2) mới bị bóc.
                            # ĐÁNH ĐỔI: nền trắng-JPEG ám màu nhẹ (S>2) sẽ KHÔNG còn bị bóc.
                            lower_white = np.array([0, 0, 200])
                            upper_white = np.array([180, 2, 255])
                            white_mask = cv2.inRange(hsv, lower_white, upper_white)
                            # HSV saturation alone cannot distinguish a light neutral gray
                            # from white. Use strict RGB near-white candidates instead:
                            # all channels must be near white, so RGB(213,215,214) survives.
                            white_mask = (
                                _near_white_background_candidate_rgb(
                                    img[:, :, :3], min_channel=248, max_chroma=18
                                ).astype(np.uint8)
                                * 255
                            )
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

                    if alpha_contour_mode:
                        # ALPHA (audit 2026-08-01 §A.3): lấy biên tại khoảng 25% độ đục.
                        # Ngưỡng >10 trước đây tính cả halo gần trong suốt, làm mất
                        # phần lớn khoảng lùi 0,15 mm so với mép nhìn thấy.
                        _, base_mask = cv2.threshold(
                            base_mask, ALPHA_CONTOUR_THRESHOLD, 255, cv2.THRESH_BINARY
                        )

                    raw_mask = base_mask.copy()

                    if fill_holes:
                        contours_mask, _ = cv2.findContours(base_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                        cv2.drawContours(base_mask, contours_mask, -1, 255, cv2.FILLED)

                    _, mask = cv2.threshold(base_mask, 10, 255, cv2.THRESH_BINARY)

                    if preserve_contour:
                        # Không blur/morphology: giữ nguyên cả góc, khe và chi tiết của mask.
                        aa_mask = mask.copy()
                    elif corner_style == "round":
                        aa_mask = cv2.GaussianBlur(mask, (7, 7), 0)
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
                if selection_page_mode:
                    # Keep the original sheet dimensions. Bleed at the physical
                    # page edge is clipped instead of expanding/cropping the A5.
                    max_expansion_pts = 0.0
                elif rectangle_mode:
                    max_expansion_pts = max(0.0, bleed_pts)
                elif cut_mode == "none":
                    max_expansion_pts = max(0.0, bleed_pts)
                else:
                    _cut_edge, _outer_edge = compute_cut_bleed_offsets(
                        cut_mode, bleed_pts, offset_pts
                    )
                    max_expansion_pts = max(0.0, _cut_edge, _outer_edge)

                # Nở theo TỪNG cạnh. Xén vuông góc cho người dùng chọn cạnh nào
                # được bù xén; mọi nhánh khác (bế tem, selection) nở đều như cũ.
                # Từ đây trở xuống KHÔNG dùng max_expansion_pts làm gốc toạ độ —
                # gốc artwork là (exp_left, exp_bottom), còn max_expansion_pts chỉ
                # còn dùng cho các phép tính "cạnh nở nhiều nhất" (pad an toàn).
                if rectangle_mode:
                    exp_left = max_expansion_pts if bleed_side_l else 0.0
                    exp_right = max_expansion_pts if bleed_side_r else 0.0
                    exp_bottom = max_expansion_pts if bleed_side_b else 0.0
                    exp_top = max_expansion_pts if bleed_side_t else 0.0
                else:
                    exp_left = exp_right = exp_bottom = exp_top = max_expansion_pts
                new_width = page_in_width + exp_left + exp_right
                new_height = page_in_height + exp_bottom + exp_top
                
                if selection_page_mode:
                    doc_out.pages.append(page_in_pike)
                    page_out = doc_out.pages[-1]
                else:
                    page_out = doc_out.add_blank_page(page_size=(new_width, new_height))
                
                bleed_stream_data = None
                mask_bytes_data = None
                img_pil = None
                bleed_ring = None
                sticker_footprint = None
                is_bleed_cmyk = False
                bleed_quality_warning = None
                
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
                cut_draw_tension = 0.33
                alpha_fitted_paths = None
                
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
                        # KHÔNG dùng rect_poly.buffer(): buffer nở ĐỀU cả 4 cạnh.
                        # Dựng thẳng hình chữ nhật mép ngoài theo từng cạnh.
                        # LƯU Ý hệ trục: poly ở "image space" (y hướng XUỐNG, y=0 là
                        # MÉP TRÊN của trang) — vì bên dưới quy đổi bằng
                        # pdf_y = page_in_height - poly_y. Nên cạnh TRÊN của trang
                        # nở về phía y ÂM, cạnh DƯỚI nở về phía y lớn hơn.
                        bleed_outer_poly = Polygon([
                            (-exp_left, -exp_top),
                            (page_in_width + exp_right, -exp_top),
                            (page_in_width + exp_right, page_in_height + exp_bottom),
                            (-exp_left, page_in_height + exp_bottom),
                        ])
                    else:
                        bleed_outer_poly = rect_poly
                    if self.debug:
                        logger.warning(
                            ">>> RECTANGLE MODE: page %.1fx%.1f pt, bleed_pts=%.2f, sides=%s",
                            page_in_width, page_in_height, bleed_pts,
                            ",".join(bleed_sides_to_names(bleed_sides_resolved)) or "none",
                        )
                
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
                                if not preserve_contour:
                                    # Các kiểu cũ vẫn dọn nhẹ contour trước khi buffer.
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

                        if alpha_contour_mode:
                            # ALPHA (audit 2026-08-01 §A.2): buffer tròn giữ phép lùi
                            # đều quanh biên raster, không tạo mũi nhọn tại bậc pixel.
                            join_style = 1
                        elif recon_meta.get("reconstructed") and recon_meta.get("kind") in ("circle", "ellipse", "rounded_rect"):
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

                        if alpha_contour_mode:
                            # QUALITY (audit 2026-08-04 §ALPHA.1–2): ưu tiên fit
                            # nhiều điểm raster thành ít cubic. Candidate không qua
                            # topology/Hausdorff/khoảng lùi sẽ tự về Catmull có guard.
                            fitted_alpha = _fit_alpha_bezier_paths(
                                base_dieline,
                                dieline_poly,
                                total_offset_pts=total_offset,
                                mm_to_pts=mm_to_pts,
                            )
                            if fitted_alpha is not None:
                                cut_poly, alpha_fitted_paths, _fit_tolerance_mm = fitted_alpha
                            else:
                                cut_poly, alpha_anchor_deviation_pts = _smooth_alpha_cut_contour(
                                    base_dieline,
                                    dieline_poly,
                                    total_offset_pts=total_offset,
                                    mm_to_pts=mm_to_pts,
                                )
                                alpha_bezier_tension = _safe_alpha_bezier_tension(
                                    base_dieline,
                                    dieline_poly,
                                    cut_poly,
                                    total_offset_pts=total_offset,
                                    mm_to_pts=mm_to_pts,
                                    anchor_deviation_pts=alpha_anchor_deviation_pts,
                                )
                                if alpha_bezier_tension is not None:
                                    cut_draw_style = "alpha_smooth"
                                    cut_draw_tension = alpha_bezier_tension
                        elif preserve_contour:
                            # Giữ hình học/góc gốc nhưng loại răng cưa raster dưới ngưỡng
                            # sản xuất. 0,20 mm lớn hơn nhiễu một pixel ở 300 DPI, nhưng
                            # nhỏ hơn các notch/góc có ý nghĩa trên tem thông thường.
                            preserve_simplify_pts = 0.20 * mm_to_pts
                            cut_poly = dieline_poly.simplify(
                                preserve_simplify_pts, preserve_topology=True
                            )
                            # Bo rất nhẹ sau khi lọc node; vẫn dùng polyline ở bước
                            # xuất PDF nên không quay lại lỗi Bezier/overshoot trước đây.
                            cut_poly = _round_preserved_corners(
                                cut_poly,
                                radius_pts=_PRESERVE_CORNER_RADIUS_MM * mm_to_pts,
                                quad_segs=_PRESERVE_CORNER_QUAD_SEGS,
                            )
                        else:
                            # Reconstruct → nén nhẹ; contour kiểu cũ → 1.0 pt.
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

                        # Pad THEO TỪNG CẠNH: cạnh không bù xén thì không nới canvas
                        # đệm, nhờ vậy khổ ảnh bleed khớp đúng khổ trang mới và không
                        # tốn RAM/thời gian cho dải sẽ không bao giờ được dùng.
                        # np.pad với ảnh: trục 0 là HÀNG, hàng 0 = mép TRÊN trang.
                        if rectangle_mode:
                            pad_left = pad_b if bleed_side_l else 0
                            pad_right = pad_b if bleed_side_r else 0
                            pad_bottom = pad_b if bleed_side_b else 0
                            pad_top = pad_b if bleed_side_t else 0
                        else:
                            pad_left = pad_right = pad_bottom = pad_top = pad_b
                        pad_rows = (pad_top, pad_bottom)
                        pad_cols = (pad_left, pad_right)
                        pad_max = max(pad_left, pad_right, pad_bottom, pad_top)

                        _, aa_mask_bin = cv2.threshold(aa_mask, 127, 255, cv2.THRESH_BINARY)
                        padded_mask = np.pad(aa_mask_bin, pad_width=(pad_rows, pad_cols), mode='constant', constant_values=0)
                        
                        # Original (unsmoothed) mask for bleed_ring inner boundary
                        # Prevents bleed from entering artwork at smoothing-shrunken edges
                        padded_original_mask = np.pad(mask, pad_width=(pad_rows, pad_cols), mode='constant', constant_values=0)
                        
                        _, raw_mask_bin = cv2.threshold(raw_mask, 10, 255, cv2.THRESH_BINARY)
                        padded_raw_mask = np.pad(raw_mask_bin, pad_width=(pad_rows, pad_cols), mode='constant', constant_values=0)
                        
                        padded_img = np.pad(img_native, pad_width=(pad_rows, pad_cols, (0, 0)), mode='constant', constant_values=255)
                        
                        # Nguồn màu tách khỏi mask hình học đường cắt. Với mode image,
                        # shell cao tần được dò sâu dần để bỏ halo AA/JPEG; các mảng
                        # màu dài vẫn giữ đúng shell 0,08 mm ban đầu.
                        edge_bite_px = max(0, int(edge_bite_mm * px_per_mm))
                        edge_sample_inset_px = max(0, int(round(edge_sample_inset_mm * px_per_mm)))
                        edge_color_inset_px = edge_bite_px + edge_sample_inset_px
                        peel_px = max(1, int(0.08 * px_per_mm))
                        edge_band_px = max(2, int(0.25 * px_per_mm))
                        selected_peel_px = peel_px
                        if bleed_color_type in ("image", "trajectory") and not rectangle_mode:
                            max_adaptive_peel_px = max(
                                peel_px,
                                int(round(_EDGE_COLOR_ADAPTIVE_MAX_MM * px_per_mm)),
                            )
                            color_source_mask, selected_peel_px = (
                                _build_adaptive_edge_color_source_mask(
                                    padded_original_mask,
                                    padded_img,
                                    band_px=edge_band_px,
                                    peel_px=peel_px,
                                    max_peel_px=max_adaptive_peel_px,
                                    edge_bite_px=edge_color_inset_px,
                                    kernel_type=kernel_type,
                                    exclude_near_white=True,
                                )
                            )
                        else:
                            color_source_mask = _build_edge_color_source_mask(
                                padded_original_mask,
                                padded_img,
                                band_px=edge_band_px,
                                peel_px=peel_px,
                                edge_bite_px=edge_color_inset_px,
                                kernel_type=kernel_type,
                                exclude_near_white=not rectangle_mode,
                            )
                        # Halo tile phải đủ sâu tới shell thực tế đã chọn.
                        source_depth_px = edge_color_inset_px + selected_peel_px + edge_band_px
                        # QUALITY (audit 2026-07-28 §BX.1/§BX.4): chỉ cảnh báo
                        # khi dò sâu vẫn không loại được nguồn màu bất ổn.
                        if bleed_color_type in ("image", "trajectory") and not rectangle_mode:
                            bleed_quality_warning = _edge_color_sampling_warning(
                                color_source_mask,
                                padded_img,
                                page_idx + 1,
                            )
                        # Giữ tên inset_px cho log/công thức band cũ (tương đương depth nguồn).
                        inset_px = max(1, source_depth_px)

                        # Generate bleed_mask from bleed_outer_poly (extends BEYOND cut line)
                        if bleed_outer_poly is not None and not getattr(bleed_outer_poly, 'is_empty', True):
                            if self.debug:
                                logger.warning(">>> RASTERIZE METHOD: Using bleed_outer_poly to generate bleed_mask (pad_b=%d, bleed_outer_offset=%.2f, scale=%.4f)", pad_b, bleed_outer_offset, self.scale)
                            mask_h, mask_w = padded_mask.shape
                            bleed_mask = np.zeros((mask_h, mask_w), dtype=np.uint8)
                            
                            # pad_x/pad_y RIÊNG: poly nằm ở toạ độ trang gốc (có thể
                            # âm khi cạnh đó được bù xén), canvas đệm lệch đúng
                            # pad_left theo cột và pad_top theo hàng.
                            def _rasterize_poly(poly_geom, target_mask, scale, pad_x, pad_y):
                                if isinstance(poly_geom, MultiPolygon):
                                    for p in poly_geom.geoms:
                                        _rasterize_poly(p, target_mask, scale, pad_x, pad_y)
                                    return
                                ext = np.array(poly_geom.exterior.coords)
                                ext_px = np.column_stack([
                                    ext[:, 0] * scale + pad_x,
                                    ext[:, 1] * scale + pad_y
                                ]).astype(np.int32)
                                cv2.fillPoly(target_mask, [ext_px], 255)
                                for interior in poly_geom.interiors:
                                    int_coords = np.array(interior.coords)
                                    int_px = np.column_stack([
                                        int_coords[:, 0] * scale + pad_x,
                                        int_coords[:, 1] * scale + pad_y
                                    ]).astype(np.int32)
                                    cv2.fillPoly(target_mask, [int_px], 0)
                            
                            _rasterize_poly(bleed_outer_poly, bleed_mask, self.scale, pad_left, pad_top)
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
                        trajectory_rect_bbox = None
                        if bleed_color_type == "trajectory" and not rectangle_mode:
                            # TRAJECTORY §BT.1: nhận dạng trên footprint GỐC; không dùng
                            # mask đã close 1,5 mm vì close có thể lấp notch rồi nhận nhầm hình.
                            trajectory_rect_bbox = _axis_aligned_rectangle_bbox(
                                padded_original_mask
                            )
                            if trajectory_rect_bbox is not None:
                                rect_x0, rect_y0, rect_x1, rect_y1 = trajectory_rect_bbox
                                min_rect_side = 2 * (
                                    edge_color_inset_px + selected_peel_px
                                ) + 3
                                if (
                                    rect_x1 - rect_x0 < min_rect_side
                                    or rect_y1 - rect_y0 < min_rect_side
                                ):
                                    trajectory_rect_bbox = None
                            if trajectory_rect_bbox is not None:
                                # TRAJECTORY (audit 2026-08-01 §BT.2): phủ kín
                                # ô bù xén màu; dieline/cut_poly vẫn giữ cung bo.
                                bleed_points = cv2.findNonZero(bleed_mask)
                                if bleed_points is not None:
                                    bx, by, bw, bh = (
                                        int(value)
                                        for value in cv2.boundingRect(bleed_points)
                                    )
                                    bleed_mask[by:by + bh, bx:bx + bw] = 255
                            else:
                                fallback_warning = (
                                    f"Trang {page_idx + 1}: Theo quỹ đạo chỉ áp dụng trực tiếp "
                                    "cho tem chữ nhật thẳng hoặc bo góc; contour hiện tại "
                                    "dùng Lấy màu viền tem."
                                )
                                bleed_quality_warning = " ".join(
                                    warning for warning in
                                    (fallback_warning, bleed_quality_warning) if warning
                                )

                        close_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close_px*2+1, close_px*2+1))
                        # QUALITY (fix 2026-08-03 §CARDINAL.1): khi tem chạm mép trang và
                        # bleed < bán kính close 1,5 mm, kernel bị cắt bởi biên canvas đệm.
                        # Phép erode sau dilation khi đó để lại bốn gai ở các tiếp tuyến;
                        # các gai đục thủng bleed_ring thành bốn khe trắng. Đóng mask trên
                        # một vành 0 tạm đủ rộng rồi cắt về kích thước cũ để morphology
                        # không phụ thuộc độ dày bleed/padding của ảnh màu.
                        close_guard_px = close_px + 1
                        guarded_footprint_mask = np.pad(
                            padded_original_mask,
                            pad_width=close_guard_px,
                            mode="constant",
                            constant_values=0,
                        )
                        # Tái dùng chính buffer có guard để không giữ thêm một mask
                        # full-page trong suốt phần xử lý còn lại của trang.
                        cv2.morphologyEx(
                            guarded_footprint_mask,
                            cv2.MORPH_CLOSE,
                            close_kernel,
                            dst=guarded_footprint_mask,
                        )
                        closed_mask = np.ascontiguousarray(
                            guarded_footprint_mask[
                                close_guard_px:-close_guard_px,
                                close_guard_px:-close_guard_px,
                            ]
                        )
                        del guarded_footprint_mask
                        foot_contours, _ = cv2.findContours(closed_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                        sticker_footprint = np.zeros_like(padded_original_mask)
                        cv2.drawContours(sticker_footprint, foot_contours, -1, 255, cv2.FILLED)

                        # "Lẹm mép" thật sự chỉ do edge_bite_px: co footprint và clip artwork
                        # để bleed lấn vào dải mép. Lẹm quá tay sẽ ăn nội dung nên mặc định là 0.
                        # edge_color_inset_px có thể sâu hơn để né trắng/khử răng cưa khi lấy màu,
                        # nhưng phần tăng thêm chỉ đổi nguồn màu; tuyệt đối không co footprint.
                        # Nhờ vậy Resize lấy mẫu sâu 0,5 mm mà vẫn giữ nguyên toàn bộ artwork
                        # sau khi auto-trim đã đặt box sát nội dung.
                        if edge_bite_px > 0:
                            bite_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (edge_bite_px*2+1, edge_bite_px*2+1))
                            sticker_footprint = cv2.erode(sticker_footprint, bite_kernel)

                        # bleed_ring = vùng giữa footprint và đường cắt. NỚI mép trong
                        # VÀO TRONG vài px: SMask lùa xuống DƯỚI artwork (layer trên phủ
                        # footprint) → bịt khe hở subpixel ở mối nối raster(SMask)↔clip-vector,
                        # tránh hở nền tạo sợi mảnh. Phần nới nằm dưới artwork nên vô hình.
                        _seam_clean_px = (
                            selected_peel_px
                            if bleed_color_type in ("image", "trajectory") and not rectangle_mode
                            else 0
                        )
                        _tuck_px = max(1, int(0.2 * px_per_mm), _seam_clean_px)
                        _sampled_seam_overlay = (
                            bleed_color_type in ("image", "trajectory", "inpaint")
                            and not rectangle_mode
                            and not selection_page_mode
                        )
                        _seam_feather_px = 0
                        if _sampled_seam_overlay:
                            _seam_feather_px = max(
                                1, int(round(_SEAM_FEATHER_MM * px_per_mm))
                            )
                            bleed_ring = _build_feathered_bleed_join_mask(
                                bleed_mask,
                                sticker_footprint,
                                solid_overlap_px=_tuck_px,
                                feather_px=_seam_feather_px,
                            )
                        else:
                            _fp_inner = cv2.erode(
                                sticker_footprint,
                                cv2.getStructuringElement(
                                    cv2.MORPH_ELLIPSE,
                                    (_tuck_px * 2 + 1, _tuck_px * 2 + 1),
                                ),
                            )
                            bleed_ring = cv2.subtract(bleed_mask, _fp_inner)
                        
                        # PERF (audit 2026-08-01 §RT.6): rectangle inpaint/trajectory
                        # tự kéo màu từ bốn cạnh và không đọc `band`. Dilation với kernel
                        # đường kính ≈ 2×bleed từng tốn 44,9 s ở bleed 31 mm dù kết quả bỏ đi.
                        needs_banded_fill = (
                            bleed_color_type == "image"
                            or (bleed_color_type == "inpaint" and not rectangle_mode)
                            or (
                                bleed_color_type == "trajectory"
                                and not rectangle_mode
                                and trajectory_rect_bbox is None
                            )
                        )
                        if needs_banded_fill:
                            # Band đủ chứa nguồn màu + bleed ngoài + tuck/feather.
                            _SAFETY = 4
                            band_r = int(
                                bleed_px
                                + inset_px
                                + _tuck_px
                                + _seam_feather_px
                                + 1
                                + _SAFETY
                            )
                            band_kernel = cv2.getStructuringElement(
                                cv2.MORPH_ELLIPSE, (band_r * 2 + 1, band_r * 2 + 1)
                            )
                            band = cv2.dilate(bleed_ring, band_kernel)
                        else:
                            band_r = 0
                            band = None

                        is_bleed_cmyk = False
                        if (
                            bleed_color_type == "trajectory"
                            and not rectangle_mode
                            and trajectory_rect_bbox is not None
                        ):
                            smooth_started = time.perf_counter()
                            x0, y0, x1, y1 = trajectory_rect_bbox
                            roi_x0 = max(0, x0 - pad_b)
                            roi_y0 = max(0, y0 - pad_b)
                            roi_x1 = min(padded_img.shape[1], x1 + pad_b)
                            roi_y1 = min(padded_img.shape[0], y1 + pad_b)
                            rect_pads = (
                                x0 - roi_x0,
                                roi_x1 - x1,
                                roi_y1 - y1,
                                y0 - roi_y0,
                            )
                            rect_core_source = padded_img[y0:y1, x0:x1]
                            rect_core_mask = padded_original_mask[y0:y1, x0:x1]
                            # Lấp góc trong suốt trước khi ngoại suy quỹ đạo;
                            # pixel artwork thật vẫn giữ nguyên từng byte.
                            rect_core = _nearest_color_fill(
                                rect_core_mask,
                                rect_core_source,
                            )
                            # Pad đúng phạm vi bleed cục bộ, không kéo màu qua cả tờ PDF.
                            rect_fill = _rectangle_trajectory_color_fill(
                                rect_core,
                                max(rect_pads),
                                edge_color_inset_px + selected_peel_px,
                                px_per_mm,
                                pads=rect_pads,
                            )
                            bleed_colors = np.zeros_like(padded_img)
                            bleed_colors[roi_y0:roi_y1, roi_x0:roi_x1] = rect_fill
                            smooth_seconds = time.perf_counter() - smooth_started
                        elif bleed_color_type == "image" or (
                            bleed_color_type == "trajectory" and not rectangle_mode
                        ):
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
                        elif bleed_color_type in ("inpaint", "trajectory") and rectangle_mode:
                            smooth_started = time.perf_counter()
                            fill_rectangle = (
                                _rectangle_trajectory_color_fill
                                if bleed_color_type == "trajectory"
                                else _rectangle_smooth_color_fill
                            )
                            bleed_colors = fill_rectangle(
                                img_native, pad_b, edge_color_inset_px, px_per_mm,
                                pads=(pad_left, pad_right, pad_bottom, pad_top),
                            )
                            smooth_seconds = time.perf_counter() - smooth_started
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
                        bleed_rgb_for_storage = bleed_rgb
                        compression_level = 6
                        if rectangle_mode and bleed_color_type in ("inpaint", "trajectory"):
                            # Keep the same full-size image and CTM. Only deep,
                            # fully transparent centre RGB is zeroed so Flate can
                            # skip it without changing any visible colour.
                            perimeter_px = pad_max + edge_color_inset_px + _tuck_px + 2
                            bleed_rgb_for_storage = _sparsify_rectangle_bleed(
                                bleed_rgb, bleed_ring, perimeter_px
                            )
                            compression_level = 1

                        compress_started = time.perf_counter()
                        bleed_stream_data = zlib.compress(
                            bleed_rgb_for_storage.tobytes(), compression_level
                        )
                        img_w, img_h = (
                            bleed_rgb_for_storage.shape[1],
                            bleed_rgb_for_storage.shape[0],
                        )
                        mask_bytes_data = zlib.compress(
                            bleed_ring.tobytes(), compression_level
                        )
                        compress_seconds = time.perf_counter() - compress_started
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
                src_xobj_name = None
                if not selection_page_mode:
                    src_xobj = page_in_pike.as_form_xobject()
                    src_xobj_name = page_out.add_resource(src_xobj, pikepdf.Name.XObject)

                page_content_stream = []
                sampled_bleed_overlay_stream = []
                vector_bite_left = 0.0
                vector_bite_right = 0.0
                vector_bite_bottom = 0.0
                vector_bite_top = 0.0
                if use_vector_rectangle_bleed:
                    (
                        vector_ops,
                        vector_bite_left,
                        vector_bite_right,
                        vector_bite_bottom,
                        vector_bite_top,
                    ) = _rectangle_vector_bleed_commands(
                        src_xobj_name,
                        crop_x0=crop_x0,
                        crop_y0=crop_y0,
                        page_width=page_in_width,
                        page_height=page_in_height,
                        bleed_pts=bleed_pts,
                        edge_bite_pts=max(0.0, edge_bite_mm * mm_to_pts),
                        sample_depth_pts=72.0 / max(1, self.dpi),
                        sample_inset_pts=max(0.0, edge_sample_inset_mm * mm_to_pts),
                        sides=bleed_sides_resolved,
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
                    mask_obj.Interpolate = True
                    
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
                    img_obj.Interpolate = True
                    
                    img_name = page_out.add_resource(img_obj, pikepdf.Name.XObject)
                    
                    content_origin_x = crop_x0 if selection_page_mode else exp_left
                    content_origin_y = crop_y0 if selection_page_mode else exp_bottom
                    # Ảnh bleed neo theo pad TRÁI (trục x) và pad DƯỚI (trục y):
                    # PDF đặt ảnh từ góc dưới-trái nên mép dưới ảnh = gốc artwork
                    # trừ đúng phần đã đệm phía dưới.
                    shift_x = content_origin_x - (pad_left / self.scale)
                    shift_y = content_origin_y - (pad_bottom / self.scale)

                    if self.debug:
                        # So khớp 2 layer: bleed (raster, neo self.scale) vs artwork
                        # (vector 1:1, neo crop_x0). artwork phải rộng ĐÚNG page_in_width;
                        # bleed artwork-portion rộng img_native_px/self.scale. Lệch ⇒ pdfium
                        # render khác box ta giả định (CropBox) hoặc self.scale sai.
                        _art_px_w = img_w - pad_left - pad_right
                        _art_px_h = img_h - pad_top - pad_bottom
                        logger.warning(
                            ">>> ALIGN p%d: page_in=%.3fx%.3f pt | render_px=%dx%d → /scale=%.3fx%.3f pt | scale=%.5f (base=%.5f) | crop0=(%.3f,%.3f) | img_w_pt=%.3f shift=(%.3f,%.3f) exp=(l%.3f r%.3f b%.3f t%.3f) pad=(l%d r%d b%d t%d)",
                            page_idx, page_in_width, page_in_height,
                            _art_px_w, _art_px_h, _art_px_w / self.scale, _art_px_h / self.scale,
                            self.scale, base_scale, crop_x0, crop_y0,
                            img_w_pt, shift_x, shift_y,
                            exp_left, exp_right, exp_bottom, exp_top,
                            pad_left, pad_right, pad_bottom, pad_top,
                        )

                    bleed_draw_ops = [
                        "q",
                        f"{img_w_pt:.4f} 0 0 {img_h_pt:.4f} {shift_x:.4f} {shift_y:.4f} cm",
                        f"{str(img_name)} Do",
                        "Q",
                    ]
                    if (
                        bleed_color_type in ("image", "trajectory", "inpaint")
                        and not rectangle_mode
                        and not selection_page_mode
                    ):
                        sampled_bleed_overlay_stream.extend(bleed_draw_ops)
                    else:
                        page_content_stream.extend(bleed_draw_ops)

                selection_bleed_content_stream = []
                if selection_page_mode:
                    selection_bleed_content_stream = list(page_content_stream)
                    page_content_stream = []
                artwork_ops_start = len(page_content_stream)

                # LAYER 2 (TOP): Artwork gốc — GIỮ NGUYÊN VECTOR, KHÔNG raster hoá.
                # Trước đây artwork bị render thành JPEG 300 DPI (mất nét vector + lệch
                # màu RGB). Nay luôn vẽ lại form XObject gốc. Khi có bleed: clip artwork
                # vào đúng footprint (CÙNG biên với bleed_ring → không hở mép trắng),
                # phần ngoài footprint để lộ bleed bên dưới.

                page_content_stream.append("q")
                if use_vector_rectangle_bleed and (
                    vector_bite_left > 0 or vector_bite_right > 0
                    or vector_bite_bottom > 0 or vector_bite_top > 0
                ):
                    clip_x = exp_left + vector_bite_left
                    clip_y = exp_bottom + vector_bite_bottom
                    clip_w = max(0.01, page_in_width - vector_bite_left - vector_bite_right)
                    clip_h = max(0.01, page_in_height - vector_bite_bottom - vector_bite_top)
                    page_content_stream.append(
                        f"{clip_x:.4f} {clip_y:.4f} {clip_w:.4f} {clip_h:.4f} re W n"
                    )
                elif rectangle_mode and bleed_stream_data:
                    # [BLEED-SIDES FIX 2026-08-01 §CBS.1] Rectangle đã có biên
                    # vật lý chính xác, không trace mask full-page qua OpenCV. Contour
                    # pixel kết thúc ở H-1 nên phép đổi cũ hụt 1 pixel nguồn tại đáy;
                    # bật bleed dưới che khe, còn chọn cạnh riêng lẻ thì lộ giấy trắng.
                    # Dùng lượng lẹm đã lượng tử theo raster để clip vẫn khớp SMask.
                    raster_bite_pts = max(0.0, edge_bite_px / self.scale)
                    clip_bite_left = raster_bite_pts if bleed_side_l else 0.0
                    clip_bite_right = raster_bite_pts if bleed_side_r else 0.0
                    clip_bite_bottom = raster_bite_pts if bleed_side_b else 0.0
                    clip_bite_top = raster_bite_pts if bleed_side_t else 0.0
                    clip_x = exp_left + clip_bite_left
                    clip_y = exp_bottom + clip_bite_bottom
                    clip_w = max(
                        0.01, page_in_width - clip_bite_left - clip_bite_right
                    )
                    clip_h = max(
                        0.01, page_in_height - clip_bite_bottom - clip_bite_top
                    )
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
                art_shift_x = exp_left - crop_x0
                art_shift_y = exp_bottom - crop_y0
                page_content_stream.append(f"1 0 0 1 {art_shift_x:.4f} {art_shift_y:.4f} cm")
                page_content_stream.append(f"{str(src_xobj_name)} Do")
                page_content_stream.append("Q")
                if selection_page_mode:
                    # The original sheet is already present because the source page
                    # was copied intact. Drop the legacy re-draw layer to avoid
                    # changing transparency/overprint by painting it twice.
                    del page_content_stream[artwork_ops_start:]
                elif sampled_bleed_overlay_stream:
                    # QUALITY (audit 2026-07-28 §BX.5): phủ choke màu lấy mẫu lên
                    # dải mép rất hẹp sau artwork để che halo/AA trắng của nguồn.
                    page_content_stream.extend(sampled_bleed_overlay_stream)



                # "Tạo đường cắt cho trang đầu": trang 2+ CHỈ bù xén, không vẽ đường
                # cắt → file nhiều loại tem CÙNG khuôn, trang 1 mang khuôn master để
                # tool Bình tem bế/CNC (chế độ đồng nhất) lấy làm dieline chung.
                _cut_page_ok = (not cut_first_page_only) or (page_idx == 0)
                if _cut_page_ok and draw_cut_contour and cut_mode != "none" and cut_poly is not None and not getattr(cut_poly, 'is_empty', True):
                    debug_step = "Draw Cut Contour"
                    
                    page_content_stream.append("q")
                    cut_origin_x = crop_x0 if selection_page_mode else exp_left
                    cut_origin_y = crop_y0 if selection_page_mode else exp_bottom
                    page_content_stream.append(f"1 0 0 1 {cut_origin_x:.4f} {cut_origin_y:.4f} cm")
                    
                    page_content_stream.append("/CutContour CS")
                    page_content_stream.append("1.0 SCN")
                    page_content_stream.append("1.0 w")

                    if alpha_fitted_paths is not None:
                        for segments in alpha_fitted_paths:
                            page_content_stream.extend(
                                build_bezier_segments_path_stream(
                                    segments,
                                    page_in_height,
                                )
                            )
                    else:
                        # cut_poly có thể là Polygon, MultiPolygon, hoặc (khi buffer âm lớn teo
                        # tách shape) GeometryCollection/LineString KHÔNG có .exterior. Gom chỉ
                        # các thành viên là Polygon → tránh AttributeError crash.
                        if isinstance(cut_poly, MultiPolygon):
                            raw_geoms = list(cut_poly.geoms)
                        elif hasattr(cut_poly, 'geoms'):  # GeometryCollection
                            raw_geoms = list(cut_poly.geoms)
                        else:
                            raw_geoms = [cut_poly]
                        geoms = [
                            g for g in raw_geoms
                            if g.geom_type == 'Polygon' and not g.is_empty
                        ]
                        for p in geoms:
                            coords = list(p.exterior.coords)
                            if coords:
                                page_content_stream.extend(
                                    build_contour_path_stream(
                                        coords,
                                        page_in_height,
                                        cut_draw_style,
                                        tension=cut_draw_tension,
                                    )
                                )
                            for inter in p.interiors:
                                icoords = list(inter.coords)
                                if icoords:
                                    page_content_stream.extend(
                                        build_contour_path_stream(
                                            icoords,
                                            page_in_height,
                                            cut_draw_style,
                                            tension=cut_draw_tension,
                                        )
                                    )

                    page_content_stream.append("S")
                    page_content_stream.append("Q")

                if selection_page_mode:
                    if selection_bleed_content_stream:
                        bleed_content = "\n".join(selection_bleed_content_stream).encode("ascii")
                        # The copied sheet may contain a full-page white
                        # background. Append the ring above that background so
                        # bleed remains visible; its SMask excludes the selected
                        # sticker footprint, and CutContour is appended afterward.
                        page_out.contents_add(
                            pikepdf.Stream(doc_out, bleed_content),
                        )
                    if page_content_stream:
                        cut_content = "\n".join(page_content_stream).encode("ascii")
                        page_out.contents_add(pikepdf.Stream(doc_out, cut_content))
                else:
                    full_content = "\n".join(page_content_stream).encode("ascii")
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
                    
                    minx += exp_left
                    pdf_miny += exp_bottom
                    maxx += exp_left
                    pdf_maxy += exp_bottom
                    
                    box_arr = pikepdf.Array([minx, pdf_miny, maxx, pdf_maxy])
                    if not selection_page_mode:
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
                        max(0.0, vis_minx + exp_left - crop_guard),
                        max(0.0, page_in_height - vis_maxy + exp_bottom - crop_guard),
                        min(new_width, vis_maxx + exp_left + crop_guard),
                        min(new_height, page_in_height - vis_miny + exp_bottom + crop_guard),
                    ]
                    if (
                        not selection_page_mode
                        and crop_box[2] > crop_box[0]
                        and crop_box[3] > crop_box[1]
                    ):
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
                        "contour_source": "alpha" if alpha_contour_mode else "auto",
                        "alpha_fallback": bool(alpha_fallback_used),
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
                page_warning = " ".join(
                    warning for warning in (alpha_contour_warning, bleed_quality_warning)
                    if warning
                )
                if page_warning:
                    page_meta["bleed_warning"] = page_warning
                
                all_pages_meta.append(page_meta)
                if rectangle_mode and bleed_color_type in ("inpaint", "trajectory"):
                    logger.info(
                        "[STICKER_TIMING] page=%d gs_s=%.3f smooth_s=%.3f "
                        "compress_s=%.3f total_s=%.3f",
                        page_idx + 1,
                        gs_seconds,
                        smooth_seconds,
                        compress_seconds,
                        time.perf_counter() - page_started,
                    )

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
            for candidate in all_pages_meta:
                if candidate and candidate.get("boxes"):
                    final_meta = candidate.copy()
                    break
            if not final_meta and len(all_pages_meta) > 0 and all_pages_meta[0]:
                final_meta = all_pages_meta[0].copy()
            final_meta["pages"] = all_pages_meta
            if selection_mode:
                final_meta["selection_count"] = sum(
                    len(object_ids) for object_ids in selection_targets.values()
                )
                final_meta["selection_pages"] = sorted(page + 1 for page in selection_targets)

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
            combined_warning = _compose_sticker_warning(all_pages_meta, pages_no_dieline)
            if combined_warning:
                final_meta["warning"] = combined_warning

            return True, final_meta
            
        except Exception as e:
            logger.error(f"Sticker processing failed at {debug_step}: {e}", exc_info=True)
            # RuntimeError đã gắn tag [Bước] từ nhánh parallel/fallback → giữ nguyên.
            if isinstance(e, RuntimeError) and str(e).startswith("["):
                raise
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

    def _run_sticker_chunks(self, args_list, n_workers: int, use_pool: bool):
        """Chạy các chunk sticker: in-process tuần tự hoặc ProcessPool.

        Trả list (chunk_idx, result) — không sort. Khi pool chết (OOM/native)
        ném BrokenProcessPool / exception có "terminated abruptly".
        """
        import gc

        if len(args_list) == 1 or not use_pool or n_workers <= 1:
            mode = "in-process"
            logger.info(
                "[STICKER] run chunks mode=%s count=%d workers=%d",
                mode, len(args_list), n_workers,
            )
            results = []
            for a in args_list:
                results.append(_process_sticker_chunk(a))
                # In liên tục nhiều trang: nhả buffer cv2/numpy giữa chunk.
                gc.collect()
            return results

        logger.info(
            "[STICKER] run chunks mode=pool count=%d workers=%d",
            len(args_list), n_workers,
        )
        results = []
        with ProcessPoolExecutor(max_workers=n_workers) as pool:
            future_map = {
                pool.submit(_process_sticker_chunk, a): a for a in args_list
            }
            for fut in as_completed(future_map):
                a = future_map[fut]
                try:
                    results.append(fut.result())
                except Exception as e:
                    # Python exception từ worker (không phải process kill).
                    logger.error(
                        "[STICKER] pool future failed chunk_idx=%s pages=%s: %s",
                        a.get("chunk_idx"), a.get("page_indices"), e,
                        exc_info=True,
                    )
                    raise
        return results

    def _process_parallel(self, input_path, output_path, **kw) -> tuple:
        """Fan-out xử lý trang ra nhiều tiến trình con rồi merge kết quả.

        Chia N trang thành W dải liền kề (contiguous), mỗi worker tạo StickerEngine
        riêng xử lý một dải (qua _page_subset) và trả file chunk (bytes) + meta. Gộp
        các chunk theo THỨ TỰ (pikepdf pages.extend, tự kéo spot color /CutContour qua
        copy_foreign), concat meta, tổng hợp any_dieline + pages_no_dieline rồi tái
        tạo final_meta/error/warning Y HỆT nhánh tuần tự.

        Khi process pool bị kill (OOM / crash native) → log chi tiết + fallback
        tuần tự in-process (peak RAM thấp hơn nhiều worker đồng thời).
        """
        import math as _math
        parallel_started = time.perf_counter()
        cut_mode = kw["cut_mode"]

        try:
            input_mb = os.path.getsize(input_path) / (1024 * 1024)
        except OSError:
            input_mb = 0.0

        _probe = pdfium.PdfDocument(input_path)
        n_pages = len(_probe)
        # Probe kích thước trang đầu (gợi ý RAM/trang); không fail nếu PDF lạ.
        page0_w = page0_h = 0.0
        try:
            if n_pages > 0:
                page0_w, page0_h = _probe[0].get_size()
        except Exception:
            pass
        _probe.close()

        available = max(1, (os.cpu_count() or 2) - 1)
        try:
            env_cap = int(os.environ.get(
                "STICKER_MAX_WORKERS", str(_default_sticker_max_workers())
            ))
        except ValueError:
            env_cap = _default_sticker_max_workers()
        # Xén thằng + bleed image vector: không raster full page → đường nhẹ.
        light_path = bool(
            kw.get("rectangle_mode")
            and kw.get("bleed_color_type") == "image"
            and float(kw.get("bleed_mm") or 0) > 0
        )
        n_workers = max(1, min(available, env_cap, n_pages))
        n_workers = _cap_sticker_workers(
            n_workers, n_pages, input_path,
            page_w_pt=page0_w, page_h_pt=page0_h, dpi=self.dpi,
            light_path=light_path,
        )
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
        avail_ram = _available_ram_mb()
        per_w_ram = _estimate_worker_ram_mb(
            page0_w, page0_h, self.dpi, light_path=light_path,
        )

        logger.info(
            "[STICKER] parallel plan pages=%d workers=%d chunks=%d "
            "chunk_sizes=%s threads/worker=%d input_mb=%.2f page0_pt=%.1fx%.1f "
            "rectangle=%s bleed_mm=%s cut_mode=%s light=%s avail_ram_mb=%s "
            "est_per_worker_mb=%.0f",
            n_pages, n_workers, len(chunks),
            [len(c) for c in chunks], threads_per_worker, input_mb,
            page0_w, page0_h, kw.get("rectangle_mode"), kw.get("bleed_mm"),
            cut_mode, light_path,
            f"{avail_ram:.0f}" if avail_ram is not None else "?",
            per_w_ram,
        )

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
                "edge_sample_inset_mm": kw.get("edge_sample_inset_mm", 0.0),
                "cut_first_page_only": kw["cut_first_page_only"],
                "shape_mode": kw.get("shape_mode", "auto_safe"),
                # Tuple 4 bool — picklable, worker không phải parse lại chuỗi.
                "bleed_sides": kw.get("bleed_sides"),
            })

        # 1 chunk / n_workers=1 → in-process. Nhiều chunk → pool; crash → fallback tuần tự.
        workers_started = time.perf_counter()
        use_pool = len(args_list) > 1 and n_workers > 1
        used_pool = False
        try:
            results = self._run_sticker_chunks(args_list, n_workers, use_pool=use_pool)
            used_pool = use_pool
        except Exception as pool_err:
            if use_pool and _is_process_pool_crash(pool_err):
                logger.error(
                    "[STICKER] process pool CRASH (OOM/native?). "
                    "pages=%d workers=%d chunks=%d input_mb=%.2f page0_pt=%.1fx%.1f "
                    "rectangle=%s err=%s — fallback sequential in-process",
                    n_pages, n_workers, len(chunks), input_mb, page0_w, page0_h,
                    kw.get("rectangle_mode"), pool_err,
                    exc_info=True,
                )
                retry_error = pool_err
                retry_workers = max(2, n_workers // 2)
                if retry_workers < n_workers:
                    try:
                        # PERF (audit 2026-08-05 §ALPHA.P1): pool lớn chết không
                        # được rơi thẳng về 1 worker. Thử lại nửa pool để vẫn tận
                        # dụng máy mạnh; cùng args/chunk nên artifact không đổi.
                        results = self._run_sticker_chunks(
                            args_list,
                            n_workers=retry_workers,
                            use_pool=True,
                        )
                        used_pool = True
                        logger.info(
                            "[STICKER] reduced pool retry completed workers=%d "
                            "chunks=%d s=%.2f",
                            retry_workers,
                            len(results),
                            time.perf_counter() - workers_started,
                        )
                    except Exception as reduced_err:
                        if not _is_process_pool_crash(reduced_err):
                            raise
                        retry_error = reduced_err
                        logger.error(
                            "[STICKER] reduced pool retry CRASH workers=%d: %s",
                            retry_workers,
                            reduced_err,
                            exc_info=True,
                        )

                if not used_pool:
                    # Chỉ sticky sau khi cả pool đầy và pool giảm đều chết.
                    _mark_pool_crash_sticky()
                    try:
                        # Peak RAM thấp hơn: một chunk một lúc trong process cha.
                        results = self._run_sticker_chunks(
                            args_list, n_workers=1, use_pool=False,
                        )
                    except Exception as seq_err:
                        logger.error(
                            "[STICKER] sequential fallback ALSO failed: %s",
                            seq_err, exc_info=True,
                        )
                        raise RuntimeError(
                            f"[Process Parallel Workers] worker pool crashed "
                            f"({retry_error}); sequential retry also failed ({seq_err}). "
                            f"pages={n_pages} input_mb={input_mb:.1f}. "
                            f"Thử giảm số trang/khổ, đóng app khác giải phóng RAM, "
                            f"hoặc set STICKER_FORCE_SEQUENTIAL=1."
                        ) from seq_err
                    used_pool = False
                    logger.info(
                        "[STICKER] sequential fallback completed chunks=%d s=%.2f",
                        len(results), time.perf_counter() - workers_started,
                    )
            else:
                # Lỗi Python thật từ chunk — giữ nguyên để outer wrap debug_step.
                raise
        worker_seconds = time.perf_counter() - workers_started

        # Sắp theo chunk_idx (phòng thủ) rồi gộp.
        results.sort(key=lambda r: r[0])
        merge_started = time.perf_counter()

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

            with pikepdf.Pdf.open(input_path) as source_catalog:
                _copy_output_intents(source_catalog, final_doc)
            merge_seconds = time.perf_counter() - merge_started

            dedup_stats = _deduplicate_image_xobjects(final_doc)
            save_started = time.perf_counter()
            final_doc.save(output_path)
            save_seconds = time.perf_counter() - save_started
            logger.info(
                "[STICKER_TIMING] parallel pages=%d workers=%d chunks=%d used_pool=%s "
                "worker_s=%.3f merge_s=%.3f dedup_s=%.3f save_s=%.3f total_s=%.3f "
                "images=%d duplicates=%d rewired=%d reclaimed_candidate_mb=%.2f output_mb=%.2f",
                n_pages,
                n_workers,
                len(chunks),
                used_pool,
                worker_seconds,
                merge_seconds,
                dedup_stats["seconds"],
                save_seconds,
                time.perf_counter() - parallel_started,
                dedup_stats["images"],
                dedup_stats["duplicates"],
                dedup_stats["rewired"],
                dedup_stats["candidate_bytes"] / (1024 * 1024),
                os.path.getsize(output_path) / (1024 * 1024),
            )
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
        combined_warning = _compose_sticker_warning(all_pages_meta, pages_no_dieline)
        if combined_warning:
            final_meta["warning"] = combined_warning

        return True, final_meta
