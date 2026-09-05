import cv2
import hashlib
import numpy as np
import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
import pikepdf
import io
import os
import tempfile
import zlib
import math
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from concurrent.futures.process import BrokenProcessPool
from typing import Optional, Tuple
from shapely.geometry import Polygon, MultiPolygon
from shapely.ops import unary_union
import logging
from app.core.development_diagnostics import (
    development_diagnostic_enabled,
    development_runtime_enabled,
)
from app.core.pdfium_lock import pdfium_guard
# QUALITY (audit 2026-08-06 §BG.2): bộ dò nền (mọi màu, trắng chỉ là một ca).
from app.core.sticker_background import (
    BG_FOREGROUND_RATIO_MAX,
    BG_FOREGROUND_RATIO_MIN,
    BackgroundInfo,
    detect_background,
    foreground_ratio,
    mask_tach_duoc_nen,
)
from app.core.bleed_sides import (
    ALL_BLEED_SIDES,
    bleed_sides_to_names,
    normalize_bleed_sides,
)
from app.workers.shape_analyzer import ShapeType
from app.workers.pdf_ops import copy_output_intents
from app.workers.page_space_canonicalization import canonicalize_page_space_file
from app.core.color_provenance import (
    COLOR_DEVICE_CMYK_FALLBACK_WARNING,
    COLOR_DEVICEN_FALLBACK_WARNING,
    describe_pdf_color_provenance,
    embed_srgb_output_intent,
)
from app.workers.sticker_bleed_masks import (
    _SEAM_FEATHER_MM,
    _axis_aligned_rectangle_bbox,
    _bleed_roi_bbox,
    _build_feathered_bleed_join_mask,
    _edge_color_adaptive_max_mm,
    _sampled_bleed_overlap_px,
)
import json

logger = logging.getLogger(__name__)


class UnsafeCutlineGeometryError(RuntimeError):
    """Không có ứng viên CutContour nào vừa đúng biên vừa an toàn cho máy bế."""

    def __init__(self, message: str, *, quality: dict[str, object] | None = None):
        super().__init__(message)
        self.quality = quality


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
    # PERF (audit 2026-08-05 §PERF.1): route Sticker nay chạy trong worker thread;
    # mọi lời gọi PDFium phải dùng khóa chung, nhưng nhả khóa trước phần xử lý NumPy.
    with pdfium_guard():
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
        try:
            rgba = np.array(bitmap.to_numpy(), copy=True)
        finally:
            bitmap.close()
    if rgba.ndim != 3 or rgba.shape[2] != 4:
        raise RuntimeError("PDFium không trả về ảnh RGBA cho selection.")
    return rgba


# Hàm hình học đường cắt được tách sang module nhẹ (không deps nặng) để test được.
# Re-export ở đây để giữ tương thích với code cũ import từ sticker_engine.
from app.workers.cutline_geometry import (  # noqa: E402
    _closed_ring_discontinuity_corner_indices,
    build_bezier_segments_path_stream,
    build_corner_locked_catmull_beziers,
    build_contour_path_stream,
    build_filleted_polygon_beziers,
    _catmull_rom_bezier_segments,
    _catmull_rom_chord_deviation_bound,
    _sample_catmull_rom_ring,
    _coords_to_bezier_stream,
    _coords_to_polyline_stream,
    fit_closed_cubic_beziers,
    fit_closed_cubic_beziers_adaptive,
    sample_bezier_segments,
)
from app.workers.cutline_machine_path import (  # noqa: E402
    analyze_machine_path,
    cubic_segments_from_tuples,
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


def _page_box_corner_foreground_for_bleed(
    img_rgb: np.ndarray,
    px_per_mm: float,
) -> tuple[np.ndarray, tuple[int, int, int], int] | None:
    """Tách riêng nền trắng chỉ nằm ở bốn góc để lấy màu bù xén.

    QUALITY (feedback 2026-08-19 §PAGEBOX-BLEED.2): khi người dùng giữ nền
    trang nhưng bo CutContour, tem gốc đã bo sẵn thường vẫn là một hình phủ sát
    bốn cạnh trên nền trắng ở góc. Mask page-box không được dùng làm nguồn màu:
    nó đi qua vùng trắng/AA rồi kéo thành bốn nêm xám. Helper này không thay đổi
    đường cắt hay tuỳ chọn ``Bỏ nền trắng``; nó chỉ nhận ca nền phẳng gần trắng,
    foreground phủ gần kín trang và thật sự chạm cả bốn cạnh ở đoạn giữa.
    """
    if img_rgb is None or img_rgb.ndim != 3 or img_rgb.shape[2] < 3:
        return None
    info = detect_background(img_rgb[:, :, :3])
    if info is None or not info.is_flat or not info.is_near_white:
        return None
    foreground = np.ascontiguousarray(info.foreground_mask, dtype=np.uint8)
    height, width = foreground.shape[:2]
    if min(height, width) < 8:
        return None
    ratio = float(np.count_nonzero(foreground)) / float(foreground.size)
    if not 0.75 <= ratio <= 0.995:
        return None

    points = cv2.findNonZero(foreground)
    if points is None:
        return None
    x, y, box_width, box_height = (
        int(value) for value in cv2.boundingRect(points)
    )
    try:
        resolved_px_per_mm = float(px_per_mm)
    except (TypeError, ValueError):
        resolved_px_per_mm = 0.0
    reach_px = max(
        2,
        int(round(0.20 * resolved_px_per_mm))
        if math.isfinite(resolved_px_per_mm) and resolved_px_per_mm > 0.0
        else 2,
    )
    if (
        x > reach_px
        or y > reach_px
        or width - (x + box_width) > reach_px
        or height - (y + box_height) > reach_px
    ):
        return None

    # Tránh nhận nhầm artwork có viền trắng quanh cả trang: hình bo thật chạm
    # cạnh trên/dưới/trái/phải ở nửa giữa, còn nền trắng chỉ tập trung ở góc.
    strip = min(max(1, reach_px), max(1, min(height, width) // 8))
    x0, x1 = width // 4, width - width // 4
    y0, y1 = height // 4, height - height // 4
    edge_mid_ratios = (
        float(np.mean(foreground[:strip, x0:x1] > 0)),
        float(np.mean(foreground[-strip:, x0:x1] > 0)),
        float(np.mean(foreground[y0:y1, :strip] > 0)),
        float(np.mean(foreground[y0:y1, -strip:] > 0)),
    )
    if min(edge_mid_ratios) < 0.80:
        return None
    return (
        foreground,
        tuple(int(channel) for channel in info.color),
        int(info.tolerance) + _EDGE_BG_TOLERANCE_PADDING,
    )


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

# QUALITY (audit 2026-08-07 §BG.5): mask do `detect_background` dựng là NHỊ PHÂN
# thuần 0/255 — không có dải chuyển tiếp. `measure.find_contours` là marching-
# squares: nó nội suy vị trí cắt BÊN TRONG dải chuyển tiếp để lấy toạ độ dưới mức
# điểm ảnh. Mất dải đó thì mọi điểm cắt rơi đúng giữa cạnh điểm ảnh → biên thành
# bậc thang, tem càng lớn chu vi càng dài càng lộ (đo tem tròn Ø240px: 679 góc bẻ
# >30° so với 184 của nhánh trắng cũ).
#
# Nhánh trắng cũ không gặp lỗi này vì nó trả giá trị LIÊN TỤC theo khoảng cách
# tới trắng, còn alpha thật thì bản thân kênh alpha đã có vành khử răng cưa. Chỉ
# mask TỰ DỰNG mới thiếu, nên chỉ nó cần bù — không đụng hai đường kia.
#
# Bù bằng làm mờ theo BỀ RỘNG VẬT LÝ, không theo số điểm ảnh cố định: cùng một
# con tem quét ở scale khác nhau phải ra cùng một đường cắt. 0,05 mm đủ cho
# marching-squares nội suy mà vẫn nhỏ hơn dung sai bế (~0,1 mm), nên không bo
# tròn được góc nhọn mà thợ nhìn thấy.
_BG_MASK_FEATHER_MM = 0.05
_BG_MASK_FEATHER_KERNEL_MIN = 3
_BG_MASK_FEATHER_KERNEL_MAX = 9

# QUALITY (audit 2026-08-07 §BG.6): lọc contour vụn theo DIỆN TÍCH.
#
# Nhiễu nén JPEG quanh ngưỡng nền (min_channel >= 248) làm vài cụm điểm ảnh nền
# rớt lại thành contour riêng → đường cắt sinh ra những vòng nhỏ và chấm rời rạc
# bám dọc biên tem (khách gọi là "sợi mì tôm"). Đo trên bộ hình tròn/sao/vuông ×
# 15/20/50/200/800 mm, ảnh JPEG q60: contour phụ lớn nhất chỉ 0,346 mm², trong
# khi contour thật nhỏ nhất (tem tròn 20 mm) là 265 mm². Ngưỡng 1 mm² tách sạch
# hai nhóm ở mọi cỡ, và LỖ THẬT nhỏ nhất mà thợ vẽ (lỗ treo r=1 mm ≈ 3,14 mm²)
# vẫn sống sót — đo bằng đối chứng âm.
#
# Bộ lọc chỉ BỎ contour, không chạm điểm ảnh nào của hình → không đổi hình học
# đường cắt của các ca đang chạy đúng.
_MIN_CONTOUR_AREA_MM2 = 1.0
_PT_PER_MM = 72.0 / 25.4

# QUALITY (feedback 2026-08-16 §CUTJAG.1): mask của mô hình AI gần như nhị phân
# (đo trên ảnh nhiều tem của người dùng: chỉ 2,06% pixel là trung gian), nên
# marching-squares chạy trực tiếp trên nó chỉ trả về bậc thang pixel. Đo trên 4 tem
# đầu của ảnh đó: tỉ lệ ĐẢO DẤU độ cong dọc biên là 0,67–0,78 và góc gấp trung bình
# 13–21° — tức đường bế đổi chiều cong gần như mỗi điểm, đúng cảm nhận "răng cưa".
# Làm mượt Alpha bằng Gaussian TRƯỚC khi lấy contour hạ hai số đó xuống 0,24–0,30 và
# 4,1–6,7°, trong khi IoU silhouette trước/sau vẫn 0,9979–0,9989 (lệch dưới một pixel).
# Sigma bị chặn hai lớp: theo pixel (chống làm tròn góc thật) và theo mm (để máy in
# DPI thấp không bị bào mất chi tiết) — 0,12 mm nhỏ hơn một bậc so với dung sai bế.
_CUTLINE_ALPHA_PRESMOOTH_SIGMA_PX_MAX = 1.2
_CUTLINE_ALPHA_PRESMOOTH_SIGMA_PX_MIN = 0.35
_CUTLINE_ALPHA_PRESMOOTH_MAX_MM = 0.12
# Van an toàn cho mask mảnh — xem §CUTJAG.2 trong `_presmooth_cutline_alpha`.
_CUTLINE_PRESMOOTH_MIN_AREA_KEPT = 0.90

# Bộ làm mượt này CHỈ dành cho mask dò từ điểm ảnh. Đo trên fixture góc thật
# (`tests/test_sticker_cutline_tuning.py::_sharp_mask`): với mask "notch" đã sạch,
# Gaussian 1,2 px làm `protected_corner_count` rơi 11 → 0, tức bào mất góc thật.
# Đã thử median 3/5, morph open+close, bilateral để có bộ lọc dùng chung: median 3
# và morph giữ đủ góc (11) nhưng gần như không giảm răng cưa (0,567 so với 0,571);
# bilateral giữ góc nhưng còn làm xấu hơn (0,619). Không có bộ lọc nào thắng cả hai
# mặt, nên cổng theo NGUỒN BIÊN: mask từ mô hình AI và mask dò nền phẳng là hai
# nguồn nhị phân hoá từ điểm ảnh; vector/CutContour/Alpha sạch giữ nguyên.
_CUTLINE_PRESMOOTH_BOUNDARY_SOURCES = frozenset({"ai", "simple-bg"})


def should_presmooth_cutline_alpha(boundary_source: object) -> bool:
    """Chỉ làm mượt Alpha khi biên được nhị phân hoá từ điểm ảnh."""
    if not isinstance(boundary_source, str):
        return False
    return boundary_source.strip().lower() in _CUTLINE_PRESMOOTH_BOUNDARY_SOURCES

# UIUX/QUALITY (audit 2026-08-09 §PV.3): các thanh tinh chỉnh CutContour dùng
# thang 0–100. Mốc 50 giữ profile cũ cho Bám sát/Độ mượt/Sức căng tay nắm;
# riêng Độ bo cong đã chuyển sang bán kính vật lý hiển thị ngay bên dưới.
# Bám sát và độ mượt là hai đại lượng độc lập: bám sát điều khiển ngân sách sai
# lệch hình học; độ mượt điều khiển mức lọc dao động nhỏ trước khi fit Bézier.
_CUTLINE_TUNING_DEFAULT = 50.0
_CUTLINE_SMOOTHNESS_SCALE_MIN = 0.45
_CUTLINE_SMOOTHNESS_SCALE_MAX = 1.90
_CUTLINE_FIDELITY_BUDGET_MIN = 0.55
_CUTLINE_FIDELITY_BUDGET_MAX = 1.65
_CUTLINE_TENSION_HANDLE_MIN = 0.55
_CUTLINE_TENSION_HANDLE_MAX = 1.45
_CUTLINE_TENSION_EXTRA_BUDGET_MM = 0.18
_CUTLINE_TUNING_MAX_HAUSDORFF_MM = 1.0
# QUALITY (feedback 2026-08-19 §CUTROUND.7): độ bo là kích thước thành phẩm,
# không phải số pixel nguồn. Thang tuyến tính giúp preview và PDF cùng hiểu
# 50% = 1,5 mm, 100% = 3 mm ở mọi DPI.
_CUTLINE_ROUND_RADIUS_MAX_MM = 3.0

# QUALITY (audit 2026-08-20 §CUTHYBRID.1): chỉ chuẩn hóa các đoạn thẳng dài
# có bằng chứng hình học rõ ràng. Đây là ngân sách hình học theo mm (không phải
# cap hiệu năng): ảnh hữu cơ/răng cưa thật không được ép thành hình chữ nhật.
# Chỉ khóa cạnh đủ dài để có bằng chứng là rail của thân tem; các mấu/tay ngắn
# thường tình cờ có tiếp tuyến ngang/dọc và không được biến thành line nhân tạo.
_HYBRID_STRAIGHT_MIN_RUN_MM = 12.0
_HYBRID_STRAIGHT_ORIENTATION_TOLERANCE_DEG = 4.5
# Ảnh raster/JPEG có thể để lại rung 2–3 px ở cạnh thẳng. Ngưỡng thực tế sẽ
# scale theo pixel nguồn (floor/cap bên dưới), vẫn cách xa biên lượn thật.
_HYBRID_STRAIGHT_P95_RESIDUAL_MM = 0.10
_HYBRID_STRAIGHT_P95_RESIDUAL_MAX_MM = 0.24
_HYBRID_STRAIGHT_MAX_RESIDUAL_MM = 0.22
_HYBRID_STRAIGHT_MAX_RESIDUAL_CAP_MM = 0.40
_HYBRID_STRAIGHT_GAP_MM = 0.64
# Taper ngắn ở điểm giao line↔cung; taper dài sẽ ăn sang mấu hữu cơ vừa chạm rail.
_HYBRID_STRAIGHT_FEATHER_MM = 0.25
_HYBRID_STRAIGHT_MAX_HAUSDORFF_MM = 0.30


def _clamp_cutline_percent(value: float | int | None) -> float:
    try:
        resolved = float(value)
    except (TypeError, ValueError):
        return _CUTLINE_TUNING_DEFAULT
    if not math.isfinite(resolved):
        return _CUTLINE_TUNING_DEFAULT
    return max(0.0, min(100.0, resolved))


def _cutline_smoothness_scale(value: float | int | None) -> float:
    """Đổi 0–100 sang cường độ lọc; 50 trả đúng 1 để giữ artifact mặc định."""
    resolved = _clamp_cutline_percent(value)
    if resolved <= _CUTLINE_TUNING_DEFAULT:
        ratio = resolved / _CUTLINE_TUNING_DEFAULT
        return _CUTLINE_SMOOTHNESS_SCALE_MIN + (
            1.0 - _CUTLINE_SMOOTHNESS_SCALE_MIN
        ) * ratio
    ratio = (resolved - _CUTLINE_TUNING_DEFAULT) / _CUTLINE_TUNING_DEFAULT
    return 1.0 + (_CUTLINE_SMOOTHNESS_SCALE_MAX - 1.0) * ratio


def _cutline_fidelity_budget_scale(value: float | int | None) -> float:
    """Bám sát càng cao thì fitter càng ít được rời silhouette đã duyệt."""
    resolved = _clamp_cutline_percent(value)
    if resolved <= _CUTLINE_TUNING_DEFAULT:
        ratio = resolved / _CUTLINE_TUNING_DEFAULT
        return _CUTLINE_FIDELITY_BUDGET_MAX + (
            1.0 - _CUTLINE_FIDELITY_BUDGET_MAX
        ) * ratio
    ratio = (resolved - _CUTLINE_TUNING_DEFAULT) / _CUTLINE_TUNING_DEFAULT
    return 1.0 + (_CUTLINE_FIDELITY_BUDGET_MIN - 1.0) * ratio


def _cutline_round_radius_mm(
    value: float | int | None,
    _source_pixel_mm: float | None = None,
) -> float:
    """Đổi mức bo 0–100 sang bán kính vật lý, độc lập độ phân giải nguồn.

    ``_source_pixel_mm`` được giữ tùy chọn để caller cũ không vỡ; nó cố ý
    không tham gia phép tính.
    """
    roundness = _clamp_cutline_percent(value) / 100.0
    return roundness * _CUTLINE_ROUND_RADIUS_MAX_MM


def _cutline_tension_handle_scale(value: float | int | None) -> float:
    """Tăng sức căng bằng cách rút đều tay nắm, vẫn giữ tiếp tuyến G1 tại node."""
    resolved = _clamp_cutline_percent(value)
    if resolved <= _CUTLINE_TUNING_DEFAULT:
        ratio = resolved / _CUTLINE_TUNING_DEFAULT
        return _CUTLINE_TENSION_HANDLE_MAX + (
            1.0 - _CUTLINE_TENSION_HANDLE_MAX
        ) * ratio
    ratio = (resolved - _CUTLINE_TUNING_DEFAULT) / _CUTLINE_TUNING_DEFAULT
    return 1.0 + (_CUTLINE_TENSION_HANDLE_MIN - 1.0) * ratio

# QUALITY (audit 2026-08-07 §NOODLE.1): nhiễu JPEG trên ảnh phóng lớn có thể
# vượt ngưỡng 1 mm² nhưng vẫn là dải rất mảnh, nằm sát silhouette chính. Các
# ngưỡng dưới đây đo theo pixel ẢNH NGUỒN + tỷ lệ thành phần chính; không tăng
# ngưỡng diện tích chung nên lỗ treo/tem nhỏ hợp lệ ở xa vẫn được giữ.
_JPEG_HALO_MAX_MAIN_AREA_FRACTION = 1.0e-4
_JPEG_HALO_MAX_LONG_SPAN_SOURCE_PX = 32.0
_JPEG_HALO_MAX_SHORT_SPAN_SOURCE_PX = 5.0
_JPEG_HALO_MAX_GAP_SOURCE_PX = 6.0

# QUALITY (audit 2026-08-07 §NOODLE.6): ở tem cực lớn, một số mảnh nén nằm cách
# silhouette 6–12 pixel nguồn nên lọt qua lượt lọc bảo thủ phía trên. Chỉ nới khoảng
# cách SAU KHI thành phần chính đã qua guard nhận hình chuẩn, đồng thời siết diện tích
# xuống 10 lần để không nuốt chi tiết thật của hình custom/nhiều tem.
_JPEG_HALO_RECOGNIZED_MAX_MAIN_AREA_FRACTION = 2.0e-5
_JPEG_HALO_RECOGNIZED_MAX_GAP_SOURCE_PX = 12.0
_JPEG_HALO_RECOGNIZED_MAX_SHORT_SPAN_SOURCE_PX = 8.0
_STANDARD_RECONSTRUCTED_KINDS = frozenset({
    "circle", "ellipse", "rounded_rect", "rect", "triangle",
})

# QUALITY (audit 2026-08-07 §NOODLE.7): một dải scale trung gian (~100 mm với
# ảnh mẫu) có thể rơi đúng vùng alias khiến contour đã làm mượt vẫn trượt guard.
# Probe simplify 0,25 mm chỉ được nhận nếu hình chuẩn dựng lại vẫn cách contour
# đầu vào không quá 0,35 mm; notch/chi tiết custom vượt dung sai sẽ bị từ chối.
_AUTO_SAFE_SIMPLIFY_PROBE_MM = 0.25
_AUTO_SAFE_SIMPLIFY_PROBE_MAX_HAUSDORFF_MM = 0.35

# QUALITY (audit 2026-08-07 §NOODLE.9): island nén quanh hình custom không thể
# chờ classifier hình chuẩn. Đối chứng 5 silhouette × 6 cỡ cho thấy island JPEG
# nằm trọn trong bbox ≤8 px nguồn, lấp đầy bbox ≤55%, diện tích ≤2e-5 hình chính
# và cách biên ≤12 px. Chấm/tem phụ thật dạng tròn-vuông có fill ratio cao nên sống.
_JPEG_ISLAND_MAX_MAIN_AREA_FRACTION = 2.0e-5
_JPEG_ISLAND_MAX_SPAN_SOURCE_PX = 8.0
_JPEG_ISLAND_MAX_GAP_SOURCE_PX = 12.0
_JPEG_ISLAND_MAX_BBOX_FILL_RATIO = 0.55
_JPEG_ISLAND_MAX_INK_STRENGTH = 24


def _smooth_round_contour_points(
    contour_pts: np.ndarray,
    *,
    source_pixel_mm: float | None,
    contour_px_per_mm: float,
) -> np.ndarray:
    """Làm mượt theo mm, nới theo pixel nguồn nhưng chặn ở 2% bbox."""
    points = np.asarray(contour_pts, dtype=np.float64)
    if len(points) < 10 or contour_px_per_mm <= 0:
        return points
    smooth_mm = 1.0
    if source_pixel_mm is not None:
        try:
            source_mm = float(source_pixel_mm)
        except (TypeError, ValueError):
            source_mm = 0.0
        if math.isfinite(source_mm) and source_mm > 0:
            bbox_mm = min(
                float(np.ptp(points[:, 0])),
                float(np.ptp(points[:, 1])),
            ) / _PT_PER_MM
            smooth_cap_mm = max(smooth_mm, bbox_mm * 0.02)
            smooth_mm = min(max(smooth_mm, 12.0 * source_mm), smooth_cap_mm)
    window = int(round(smooth_mm * contour_px_per_mm))
    window = max(3, min(window, len(points) // 4))
    padded = np.pad(points, ((window, window), (0, 0)), mode="wrap")
    kernel = np.ones(window, dtype=np.float64) / window
    smoothed_x = np.convolve(padded[:, 0], kernel, mode="same")
    smoothed_y = np.convolve(padded[:, 1], kernel, mode="same")
    return np.column_stack((
        smoothed_x[window:-window],
        smoothed_y[window:-window],
    ))


def _filter_full_page_jpeg_halo_components(
    components: list[Polygon],
    source_pixel_mm: float | None,
    *,
    max_area_fraction: float = _JPEG_HALO_MAX_MAIN_AREA_FRACTION,
    max_gap_source_px: float = _JPEG_HALO_MAX_GAP_SOURCE_PX,
    max_short_span_source_px: float = _JPEG_HALO_MAX_SHORT_SPAN_SOURCE_PX,
    image_rgb: np.ndarray | None = None,
    geometry_px_per_point: float | None = None,
) -> tuple[list[Polygon], int]:
    """Bỏ mảnh nén JPEG mảnh, nhỏ và bám sát thành phần chính.

    Chỉ caller có bằng chứng trang là một ảnh phủ kín mới được gọi helper này.
    Thành phần ở xa, đủ dày hoặc có diện tích đáng kể luôn được giữ để không
    nuốt tem thứ hai/lỗ treo có chủ ý.
    """
    if len(components) < 2 or source_pixel_mm is None:
        return components, 0
    try:
        pixel_mm = float(source_pixel_mm)
    except (TypeError, ValueError):
        return components, 0
    if not math.isfinite(pixel_mm) or pixel_mm <= 0:
        return components, 0

    valid = [part for part in components if not part.is_empty and part.area > 0]
    if len(valid) < 2:
        return components, 0
    dominant = max(valid, key=lambda part: part.area)
    max_area = dominant.area * max_area_fraction
    max_long_span = max(3.0, _JPEG_HALO_MAX_LONG_SPAN_SOURCE_PX * pixel_mm) * _PT_PER_MM
    max_short_span = max(1.0, max_short_span_source_px * pixel_mm) * _PT_PER_MM
    max_gap = max(1.0, max_gap_source_px * pixel_mm) * _PT_PER_MM
    island_max_area = dominant.area * _JPEG_ISLAND_MAX_MAIN_AREA_FRACTION
    island_max_span = max(
        1.0,
        _JPEG_ISLAND_MAX_SPAN_SOURCE_PX * pixel_mm,
    ) * _PT_PER_MM
    island_max_gap = max(
        1.0,
        _JPEG_ISLAND_MAX_GAP_SOURCE_PX * pixel_mm,
    ) * _PT_PER_MM

    kept: list[Polygon] = []
    dropped = 0
    has_ink_evidence = (
        image_rgb is not None
        and image_rgb.ndim == 3
        and image_rgb.shape[2] >= 3
        and geometry_px_per_point is not None
        and math.isfinite(float(geometry_px_per_point))
        and float(geometry_px_per_point) > 0
    )
    for part in components:
        if part is dominant or part.is_empty or part.area <= 0:
            kept.append(part)
            continue
        min_x, min_y, max_x, max_y = part.bounds
        width = max_x - min_x
        height = max_y - min_y
        bbox_area = width * height
        bbox_fill_ratio = part.area / bbox_area if bbox_area > 0 else 1.0
        ink_strength: int | None = None
        if has_ink_evidence:
            representative = part.representative_point()
            scale = float(geometry_px_per_point)
            sample_x = int(round(representative.x * scale))
            sample_y = int(round(representative.y * scale))
            if (
                0 <= sample_y < image_rgb.shape[0]
                and 0 <= sample_x < image_rgb.shape[1]
            ):
                y0 = max(0, sample_y - 1)
                y1 = min(image_rgb.shape[0], sample_y + 2)
                x0 = max(0, sample_x - 1)
                x1 = min(image_rgb.shape[1], sample_x + 2)
                patch = image_rgb[y0:y1, x0:x1, :3]
                if patch.size:
                    ink_strength = 255 - int(np.min(patch))
        is_near_halo = (
            part.area <= max_area
            and max(width, height) <= max_long_span
            and min(width, height) <= max_short_span
            and part.distance(dominant) <= max_gap
        )
        is_compact_compression_island = (
            not has_ink_evidence
            and part.area <= island_max_area
            and max(width, height) <= island_max_span
            and part.distance(dominant) <= island_max_gap
            and bbox_fill_ratio <= _JPEG_ISLAND_MAX_BBOX_FILL_RATIO
        )
        is_weak_compression_island = (
            ink_strength is not None
            and ink_strength <= _JPEG_ISLAND_MAX_INK_STRENGTH
            and part.area <= island_max_area
            and max(width, height) <= island_max_span
            and part.distance(dominant) <= island_max_gap
        )
        if (
            is_near_halo
            or is_compact_compression_island
            or is_weak_compression_island
        ):
            dropped += 1
        else:
            kept.append(part)
    return kept, dropped


def _reconstruct_cut_geometry_parts(
    base_geometry,
    shape_mode: str,
    px_per_mm: float,
    source_pixel_mm: float | None = None,
):
    """Tự nhận từng thành phần; một component xấu không khóa component tốt.

    Polygon có lỗ được giữ nguyên vì dựng lại chỉ từ exterior sẽ làm mất lỗ.
    Metadata `reconstructed` cho biết có thành phần đã được dựng; cờ
    `fully_reconstructed` chỉ bật khi mọi thành phần đều đạt guard.
    """
    from app.workers.sticker_cut_reconstruct import (
        coords_to_shapely_polygon,
        reconstruct_cut_coords,
    )

    if isinstance(base_geometry, Polygon):
        source_parts = [base_geometry]
    elif isinstance(base_geometry, MultiPolygon):
        source_parts = list(base_geometry.geoms)
    else:
        return base_geometry, {"shape_mode": shape_mode, "reconstructed": False}

    rebuilt_parts: list[Polygon] = []
    part_meta: list[dict] = []
    for part in source_parts:
        if part.interiors:
            rebuilt_parts.append(part)
            part_meta.append({
                "shape_mode": shape_mode,
                "reconstructed": False,
                "reason": "has_holes",
            })
            continue
        source_coords = np.asarray(part.exterior.coords[:-1], dtype=np.float64)
        coords, meta = reconstruct_cut_coords(
            source_coords,
            shape_mode,
            px_per_mm,
            source_pixel_mm,
        )
        # §NOODLE.2: preserve không làm mượt geometry custom, nhưng auto_safe
        # được phép dùng một PROBE đã lọc theo pixel nguồn. Chỉ khi probe qua
        # guard nhận hình thì geometry chuẩn mới được nhận; reject vẫn giữ đúng
        # contour gốc của khách.
        if (
            coords is None
            and shape_mode == "auto_safe"
            and source_pixel_mm is not None
        ):
            probe_coords = _smooth_round_contour_points(
                source_coords,
                source_pixel_mm=source_pixel_mm,
                contour_px_per_mm=px_per_mm,
            )
            coords, probe_meta = reconstruct_cut_coords(
                probe_coords,
                shape_mode,
                px_per_mm,
                source_pixel_mm,
            )
            if coords is not None:
                meta = dict(probe_meta)
                meta["source_scaled_probe"] = True

        # §NOODLE.7: probe thứ hai chỉ giảm alias dưới dung sai sản xuất. Candidate
        # vẫn phải qua classifier auto_safe VÀ guard Hausdorff so với contour đầu vào;
        # simplify không bao giờ được tự quyết định thay geometry của khách.
        if coords is None and shape_mode == "auto_safe":
            simplified_part = part.simplify(
                _AUTO_SAFE_SIMPLIFY_PROBE_MM * _PT_PER_MM,
                preserve_topology=True,
            )
            if isinstance(simplified_part, Polygon) and not simplified_part.interiors:
                simplified_source = np.asarray(
                    simplified_part.exterior.coords[:-1],
                    dtype=np.float64,
                )
                simplified_coords, simplified_meta = reconstruct_cut_coords(
                    simplified_source,
                    shape_mode,
                    px_per_mm,
                    source_pixel_mm,
                )
                simplified_fitted = (
                    coords_to_shapely_polygon(simplified_coords)
                    if simplified_coords is not None
                    else None
                )
                if simplified_fitted is not None and not simplified_fitted.is_empty:
                    probe_hausdorff_mm = (
                        part.hausdorff_distance(simplified_fitted) / _PT_PER_MM
                    )
                    if (
                        math.isfinite(probe_hausdorff_mm)
                        and probe_hausdorff_mm
                        <= _AUTO_SAFE_SIMPLIFY_PROBE_MAX_HAUSDORFF_MM
                    ):
                        coords = simplified_coords
                        meta = dict(simplified_meta)
                        meta["simplified_probe"] = True
                        meta["probe_hausdorff_mm"] = probe_hausdorff_mm
        fitted = coords_to_shapely_polygon(coords) if coords is not None else None
        if fitted is not None and not fitted.is_empty:
            rebuilt_parts.append(fitted)
        else:
            rebuilt_parts.append(part)
        part_meta.append(meta)

    rebuilt = unary_union(rebuilt_parts)
    reconstructed_count = sum(bool(meta.get("reconstructed")) for meta in part_meta)
    fully_reconstructed = bool(part_meta) and reconstructed_count == len(part_meta)
    dominant_index = max(
        range(len(source_parts)),
        key=lambda index: source_parts[index].area,
    )
    dominant_meta = part_meta[dominant_index]
    if len(part_meta) == 1:
        meta = dict(part_meta[0])
        meta["component_count"] = 1
        meta["component_reconstructed_count"] = reconstructed_count
        meta["fully_reconstructed"] = fully_reconstructed
        return rebuilt, meta
    return rebuilt, {
        "shape_mode": shape_mode,
        "reconstructed": reconstructed_count > 0,
        "fully_reconstructed": fully_reconstructed,
        "component_count": len(part_meta),
        "component_reconstructed_count": reconstructed_count,
        "dominant_reconstructed": bool(dominant_meta.get("reconstructed")),
        "dominant_kind": dominant_meta.get("kind"),
        # Không gán `kind` cho nhiều thành phần: UI không được mô tả cả trang
        # nhiều tem là một hình tròn/chữ nhật duy nhất.
    }

# QUALITY (audit 2026-08-07 §BG.6b): trả lại dải chuyển tiếp cho mask nhị phân,
# CHỈ trong một dải hẹp quanh biên.
#
# Mask nền trắng/nền màu là nhị phân thuần 0/255. `measure.find_contours` nội suy
# vị trí cắt BÊN TRONG dải chuyển tiếp để lấy toạ độ dưới mức điểm ảnh; mask nhị
# phân không có dải đó nên mọi điểm rơi đúng giữa cạnh điểm ảnh → biên nhảy từng
# điểm ảnh → đường cắt gợn sóng ("sợi mì tôm"), tem càng lớn càng lộ vì bị hạ độ
# phân giải theo trần 6000 px.
#
# Cách bù: lấy lại độ đậm thật của ảnh gốc (dist = 255 - min(R,G,B)) làm giá trị
# xám trong dải biên, ruột giữ nguyên 255. Đo trên hình tròn/sao/vuông ×
# 15/20/50/200/800 mm (JPEG q60, so với bản render sạch): sai số rms giảm ở MỌI ca
# (tròn 800 mm 0,434 → 0,282 mm; sao 20 mm 0,433 → 0,258 mm), không ca nào tệ hơn,
# và đầu nhọn ngôi sao KHÔNG bị bo. Quét bề rộng dải 0,2→1,2 mm: 0,5 mm là điểm
# bão hoà.
#
# Chỉ dùng cho `measure.find_contours`; `aa_mask` gốc giữ nguyên cho nhánh nguồn
# màu bù xén (§BG.4) — đo thấy nếu ghi đè thì diện tích vùng đó lệch tới −5,4%
# trên tem sao 20 mm, tức đổi màu mép bù xén của tem nhỏ.
_BG_BAND_SOFT_MM = 0.5
# Điểm bắt đầu dải xám = đúng ngưỡng nền của `_near_white_background_candidate_rgb`
# (min_channel 248 → dist 7); rộng 12 mức là hết vành AA thực đo trên ảnh nén.
_BG_BAND_SOFT_DIST_MIN = 7.0
_BG_BAND_SOFT_DIST_RANGE = 12.0
# QUALITY (audit 2026-08-07 §NOODLE.9): hình có mực đậm cho phép đặt biên tại
# dist≈24 thay vì dist≈13, loại ringing JPEG nhạt còn DÍNH với silhouette chính.
# Chỉ đổi dải contour; ruột/mask màu bleed giữ nguyên. Hình pastel không đủ mực
# mạnh vẫn dùng profile cũ để không bị co biên.
_BG_BAND_STRONG_INK_PERCENTILE = 90.0
_BG_BAND_STRONG_INK_MIN = 64.0
_BG_BAND_STRONG_DIST_RANGE = 34.0
# QUALITY (audit 2026-08-07 §NOODLE.13): với mực đậm, ngưỡng contour phải theo
# chính độ đậm của artwork. Ngưỡng cố định dist≈24 từng giữ ringing JPEG tới 15 px
# ở hõm hình tim. 0,68 đặt mức cắt khoảng 34% mực mạnh, đủ bỏ ringing nhưng không
# làm đứt nét thật; profile pastel vẫn dùng ngưỡng bảo thủ cũ.
_BG_BAND_STRONG_DIST_FRACTION = 0.68
_BG_BAND_BACKGROUND_CONNECT_GRAY = 250
# QUALITY (feedback 2026-08-11 §STICKER.PASTEL.1/2): chỉ được nối lại nền khi phần
# foreground thực sự bị loại là một vành JPEG rất nhỏ. Mốc 2,1% bao ca hoa 12 cánh
# 1.600 mm đo được 2,048%; fixture pastel bị loại 39,75% nên vẫn bị chặn rất xa.
_BG_BAND_MAX_RECONNECT_FOREGROUND_FRACTION = 0.021
_BG_BAND_SOURCE_DIAMETER_PX = 4.0


def _lam_mem_dai_bien(
    mask: np.ndarray,
    img_rgb: np.ndarray,
    px_per_mm: float,
    source_pixel_mm: float | None = None,
) -> np.ndarray:
    """Trả mask có dải xám quanh biên, ruột và nền giữ nguyên.

    QUALITY (audit 2026-08-07 §BG.6b). Xem chú thích ở `_BG_BAND_SOFT_MM`.
    """
    if mask is None or mask.size == 0 or px_per_mm <= 0:
        return mask
    if img_rgb is None or img_rgb.ndim != 3 or img_rgb.shape[2] < 3:
        return mask
    if img_rgb.shape[:2] != mask.shape[:2]:
        return mask
    source_mm = 0.0
    if source_pixel_mm is not None:
        try:
            source_mm = float(source_pixel_mm)
        except (TypeError, ValueError):
            source_mm = 0.0
        if not math.isfinite(source_mm) or source_mm <= 0:
            source_mm = 0.0
    dist = (255 - img_rgb[:, :, :3].min(axis=2)).astype(np.float32)
    dist_range = _BG_BAND_SOFT_DIST_RANGE
    sample_step = _downscale_factor(mask.shape[0], mask.shape[1], max_dim=1000)
    sampled_mask = mask[::sample_step, ::sample_step] > 0
    sampled_dist = dist[::sample_step, ::sample_step]
    if np.any(sampled_mask):
        strong_ink = float(np.percentile(
            sampled_dist[sampled_mask],
            _BG_BAND_STRONG_INK_PERCENTILE,
        ))
    else:
        strong_ink = 0.0
    strong_profile = strong_ink >= _BG_BAND_STRONG_INK_MIN
    if strong_profile:
        dist_range = max(
            _BG_BAND_STRONG_DIST_RANGE,
            strong_ink * _BG_BAND_STRONG_DIST_FRACTION,
        )
    xam = np.clip(
        (dist - _BG_BAND_SOFT_DIST_MIN) * 255.0 / dist_range, 0, 255
    ).astype(np.uint8)

    contour_base = mask
    band_diameter_mm = _BG_BAND_SOFT_MM
    if strong_profile:
        # §NOODLE.13: mask nền trắng ngưỡng 248 có thể bị một cầu ringing rất mảnh
        # bịt kín hõm sâu. Nối nền bằng profile mực trước, rồi mới đặt biên ở mức
        # xám 127; cách này xử lý toàn hõm mà không cần kernel 24–60 px nguồn.
        background_candidate = (
            xam < _BG_BAND_BACKGROUND_CONNECT_GRAY
        ).astype(np.uint8)
        label_count, labels = cv2.connectedComponents(background_candidate)
        if label_count > 1:
            border_labels = (
                set(labels[0, :])
                | set(labels[-1, :])
                | set(labels[:, 0])
                | set(labels[:, -1])
            )
            border_labels.discard(0)
            if border_labels:
                # §NOODLE.14: mask đầu vào có thể chứa hole kín do
                # `fill_holes=false`. Mở rộng cả component profile mực chạm vào
                # các seed 0 này, không chỉ component nền ngoài chạm mép ảnh.
                selected_background_labels = set(border_labels)
                selected_background_labels.update(
                    int(value) for value in np.unique(labels[mask == 0])
                    if int(value) != 0
                )
                connected_background = np.isin(
                    labels,
                    list(selected_background_labels),
                )
                rebuilt = (~connected_background).astype(np.uint8) * 255
                # `fill_holes=false` đã tạo các vùng 0 kín trong mask đầu vào;
                # tuyệt đối không để phép nối nền phía trên lấp chúng trở lại.
                rebuilt[mask == 0] = 0
                # QUALITY (feedback 2026-08-11 §STICKER.PASTEL.2): đánh giá phần
                # foreground THỰC SỰ bị phép nối nền loại bỏ, không đánh giá mọi
                # pixel sáng trong mask. Cách cũ chặn cả ringing mảnh quanh hoa/hole
                # hợp lệ chỉ vì artwork có nhiều vùng sáng nhưng không hề bị xóa.
                original_foreground = int(np.count_nonzero(mask))
                rebuilt_foreground = int(np.count_nonzero(rebuilt))
                removed_foreground_fraction = float(
                    max(0, original_foreground - rebuilt_foreground)
                    / max(1, original_foreground)
                )
                if (
                    removed_foreground_fraction
                    <= _BG_BAND_MAX_RECONNECT_FOREGROUND_FRACTION
                    and mask_tach_duoc_nen(rebuilt)
                ):
                    contour_base = rebuilt
                    if source_mm > 0:
                        band_diameter_mm = max(
                            band_diameter_mm,
                            _BG_BAND_SOURCE_DIAMETER_PX * source_mm,
                        )

    k = int(round(band_diameter_mm * px_per_mm)) | 1
    k = max(3, k)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    dai_bien = cv2.subtract(
        cv2.dilate(contour_base, kernel),
        cv2.erode(contour_base, kernel),
    )
    ra = contour_base.copy()
    ra[dai_bien > 0] = xam[dai_bien > 0]
    return ra
_ALPHA_SAFE_BEZIER_TENSIONS = (0.15, 0.10, 0.05, 0.03)
_ALPHA_SAFE_BEZIER_SAMPLES = 3
_ALPHA_FIT_TOLERANCES_MM = (0.10, 0.095, 0.08, 0.06)
_ALPHA_FIT_MAX_HAUSDORFF_MM = 0.12
_ALPHA_FIT_SAMPLES = 10
_ALPHA_CORNER_WINDOW_MM = 0.55
_ALPHA_CORNER_MIN_TURN_DEGREES = 38.0
_ALPHA_CORNER_MIN_SEPARATION_MM = 0.50
_ALPHA_ADAPTIVE_REFERENCE_DIAGONAL_MM = 50.0
_ALPHA_ADAPTIVE_MAX_SCALE = 4.0
_ALPHA_ADAPTIVE_MAX_HAUSDORFF_CAP_MM = 0.75
_ALPHA_MULTISCALE_DENSE_COMPARE_SEGMENTS = 192
_EXISTING_CONTOUR_MAX_HAUSDORFF_MM = 0.45
_EXISTING_CONTOUR_SOURCE_PIXEL_BUDGET = 2.0
_EXISTING_CONTOUR_MAX_COMPONENTS = 32
_EXISTING_CONTOUR_MAX_RINGS = 64
# QUALITY (audit 2026-08-07 §MOTION.2): tiếp tuyến góc phải nhìn qua sáu pixel
# ẢNH NGUỒN, không phải sáu pixel render 300 DPI; nếu không tem phóng lớn vẫn
# khóa ringing/nội suy JPEG thành hàng trăm góc giả.
_PRESERVED_CORNER_SOURCE_PIXEL_WINDOW = 6.0
_PRESERVE_FALLBACK_SOURCE_PIXEL_SIMPLIFY = 1.5
_PRESERVE_FALLBACK_SOURCE_PIXEL_BUDGET = 3.0
# QUALITY (audit 2026-08-08 §MOTION.1/3): các ngưỡng này chỉ xếp hạng ứng viên
# theo quỹ đạo chạy dao; chúng không loại contour và không giới hạn số node.
_PRESERVED_MOTION_SMOOTH_JOIN_DEGREES = 1.0
_PRESERVED_MOTION_SHORT_SEGMENT_MM = 0.25
_PRESERVED_MOTION_STRONG_CUSP_DEGREES = 110.0
# Bỏ dao động cong nhỏ hơn 0,10/đường chéo hình: cùng một hình co/phóng vẫn nhận cùng
# kết luận, còn nhiễu lượng tử 4 chữ số của content stream không đổi xếp hạng.
_PRESERVED_MOTION_CURVATURE_NOISE_PER_DIAGONAL = 0.10
_PRESERVED_SMOOTH_CATMULL_TENSION = 0.10
_PRESERVED_ADAPTIVE_TURN_DEGREES = (
    _ALPHA_CORNER_MIN_TURN_DEGREES,
    18.0,
)
# QUALITY (audit 2026-08-10 §CUTSMOOTH.1): cổng cuối đánh giá lệnh chạy dao,
# không đánh giá theo số node. Ngưỡng góc danh nghĩa là 38°; chừa 2° cho sai số
# marching-squares/khử răng cưa để hai vai lõm 37° không bị coi là khớp giả.
_CUTLINE_FINAL_SMOOTH_JOIN_DEGREES = 1.0
_CUTLINE_FINAL_SHORT_SEGMENT_MM = 0.25
_CUTLINE_TRUE_CORNER_TURN_DEGREES = 36.0
_CUTLINE_TRUE_CORNER_BASE_WINDOW_MM = 0.50
_CUTLINE_TRUE_CORNER_PIXEL_WINDOW = 2.50
_CUTLINE_TRUE_CORNER_PIXEL_SUPPORT = 2.00

# QUALITY (feedback 2026-08-16 §CUTHOOK.1): `maximum_join_angle_degrees` chỉ đo độ
# liên tục tiếp tuyến TẠI ANCHOR, nên gai/móc nằm BÊN TRONG một cubic là vô hình với
# nó. Đo được trên `test/1785209372799_..._a00b34db...jpg`: contour của mask và
# `ideal_geometry` sạch (góc quay xấu nhất 90–112°, 0 gai) nhưng path sau fitter quặt
# 158–179,9° với 1–67 gai mỗi tem, mà engine vẫn báo `maximum_join_angle_degrees`
# ≈ 1,2e-06 và `machine_safe = true`. Vì vậy phải đo trên QUỸ ĐẠO ĐƯỢC LẤY MẪU.
#
# 60° cho một bước lấy mẫu (~0,014 mm ở 300 DPI) tương đương bán kính cong ~0,013 mm —
# không một chi tiết bế thật nào cong tới mức đó, nên vượt ngưỡng này là cusp.
# Cusp KHÔNG tự động là lỗi: đầu nhọn của tem hình sao cũng là cusp. Phân biệt bằng
# cách đối chiếu với góc thật trên reference, dùng đúng bộ so khớp đã có cho anchor —
# cusp có trên reference thì được bảo vệ, cusp do fitter tự sinh thì bị loại.
_CUTLINE_TRAJECTORY_CUSP_DEGREES = 60.0
# Nhịp đo bề rộng nêm: lấy hai điểm cách đỉnh 0,35 mm theo chiều dài cung rồi đo dây
# cung giữa chúng. Số đo trung lập, không phải ngưỡng chặn. Đo được: nêm do fitter
# sinh ra rộng 0,04–0,15 mm, còn khe lõm thật của tem rộng 10,3–12,8 mm — cách nhau
# hai bậc độ lớn, nên số này đủ để xếp hạng ứng viên.
_CUTLINE_WEDGE_PROBE_SPAN_MM = 0.35
# PERF §CUTHOOK.2: khi đã có ứng viên dùng được (chỉ vướng gai) thì việc tìm ứng viên
# sạch hơn là TÙY CHỌN, không phải điều kiện đúng/sai — nên nó phải chịu hạn mức thời
# gian của live preview. Đo trên 4 ảnh test: tem bình thường tốn 0,2–0,6 s cho cả chuỗi
# ứng viên, còn ca nhận diện lỗi (một blob phủ cả trang, ring 11 425 điểm) tốn 2,7–2,9 s
# cho MỖI fitter fallback và đẩy cả trang lên 16–50 s. 1,0 s nằm giữa: tem bình thường
# không bao giờ chạm hạn mức, ca bệnh lý dừng sau fitter đầu tiên.
# Đây là hạn mức ĐỘ TRỄ, không phải cap theo cấu hình máy: máy mạnh vẫn chạy hết chuỗi
# vì nó làm xong trước hạn.
_CUTLINE_HOOK_SEARCH_BUDGET_SECONDS = 1.0
# QUALITY (audit 2026-08-21 §RECOGNITION-GUARD.3): một quỹ đạo còn móc/gai
# nghiêm trọng không được phép đi tiếp chỉ vì các guard hình học cơ bản vẫn
# đánh dấu ``machine_safe``. Đây là cổng fail-closed cho nhận diện nhiễu: cho
# phép tối đa một cusp rộng (có thể là đầu nhọn thật), nhưng từ hai cusp chưa
# khớp góc thật trở lên, hoặc nêm quá hẹp/góc quay quá lớn, thì phải yêu cầu
# người dùng tăng khử răng cưa/giữ mép ảnh thay vì xuất một đường dao rác.
_CUTLINE_HOOK_MAX_TOLERATED_UNPROTECTED_CUSPS = 1
_CUTLINE_HOOK_MIN_SAFE_WEDGE_MM = 0.25
_CUTLINE_HOOK_MAX_SAFE_TURN_DEGREES = 90.0

# UIUX (feedback 2026-08-16 §CUTJAG.3): thanh "Khử răng cưa" của công cụ Bù xén.
# 0 = tắt (giữ đúng hành vi cũ, không đổi một byte artifact nào), 100 = 2,5 px.
# Vẫn kẹp theo mm để máy in DPI thấp không bị bào mất chi tiết: 2,5 px ở 300 DPI là
# 0,21 mm, còn ở 72 DPI thì trần mm cắt xuống chỉ còn ~1 px.
_CUTLINE_DENOISE_SIGMA_PX_MAX = 2.5
_CUTLINE_DENOISE_MAX_MM = 0.30
# PERF/QUALITY (audit 2026-08-21 §CANONICAL.SPEED1): ở 72–150 DPI, cap 0,30 mm
# nhỏ hơn 1–1,8 pixel nên slider 70/85/100 bị bão hòa cùng một mask. Cho bộ lọc
# tối đa 2,25 pixel nguồn ở lưới còn đủ dùng; nguồn cực thấp dưới ~51 DPI vẫn giữ
# cap mm cũ để không bào chi tiết mà ảnh vốn không còn khả năng mô tả.
_CUTLINE_DENOISE_SOURCE_CAP_MIN_PX = 2.25
_CUTLINE_DENOISE_SOURCE_CAP_MIN_PX_PER_MM = 2.0
# QUALITY (feedback 2026-08-10 §ROUND-PATH.1): bước ghi PDF không được làm
# quỹ đạo ``Theo hình gốc`` trôi thêm chỉ vì đổi polyline thành cubic. 0,12 mm
# nhỏ hơn sai số một pixel ở 300 DPI và đủ chặt để mắt không thấy đường bế nở.
_ROUND_PATH_MAX_HAUSDORFF_MM = 0.12
_ROUND_PATH_REFERENCE_SIMPLIFY_MM = 0.015
_ROUND_PATH_SPLINE_RMS_PROFILES_MM = (
    0.08,
    0.06,
    0.05,
    0.04,
    0.035,
    0.03,
    0.025,
    0.02,
    0.015,
)
_ROUND_PATH_GUARD_SAMPLES = 32


def _concat_pdf_matrix(current, extra):
    """Ghép ma trận PDF theo thứ tự ``current(extra(point))``."""
    a, b, c, d, e, f = current
    g, h, i, j, k, l = extra
    return (
        a * g + c * h,
        b * g + d * h,
        a * i + c * j,
        b * i + d * j,
        a * k + c * l + e,
        b * k + d * l + f,
    )


def _infer_full_page_image_pixel_mm(page) -> float | None:
    """Suy ra mm/pixel khi trang chắc chắn chỉ là một ảnh phủ kín trang.

    Chỉ chấp nhận XObject ảnh trực tiếp, đúng một lệnh vẽ và không có toán tử
    vẽ chữ/vector khác. PDF phức tạp được trả ``None`` để không suy đoán DPI.
    """
    try:
        crop_box = [float(value) for value in page.cropbox]
        page_width = crop_box[2] - crop_box[0]
        page_height = crop_box[3] - crop_box[1]
        user_unit = float(page.obj.get("/UserUnit", 1.0))
        if page_width <= 0 or page_height <= 0 or user_unit <= 0:
            return None

        resources = page.resources
        xobjects = resources.get("/XObject") if resources is not None else None
        if xobjects is None:
            return None

        current = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
        stack = []
        image_calls = []
        paint_operators = {
            "S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "sh",
            "Tj", "TJ", "'", '"',
        }
        for instruction in pikepdf.parse_content_stream(page):
            operator = str(getattr(instruction, "operator", ""))
            operands = list(getattr(instruction, "operands", ()))
            if operator == "q":
                stack.append(current)
            elif operator == "Q":
                if not stack:
                    return None
                current = stack.pop()
            elif operator == "cm":
                if len(operands) != 6:
                    return None
                current = _concat_pdf_matrix(
                    current,
                    tuple(float(value) for value in operands),
                )
            elif operator == "Do":
                if len(operands) != 1:
                    return None
                xobject = xobjects.get(operands[0])
                if xobject is None or str(xobject.get("/Subtype", "")) != "/Image":
                    return None
                image_calls.append((xobject, current))
            elif operator in paint_operators or not operator:
                return None

        if len(image_calls) != 1 or stack:
            return None
        image, matrix = image_calls[0]
        pixel_width = int(image.get("/Width", 0))
        pixel_height = int(image.get("/Height", 0))
        if pixel_width <= 0 or pixel_height <= 0:
            return None

        a, b, c, d, e, f = matrix
        corners = (
            (e, f),
            (a + e, b + f),
            (c + e, d + f),
            (a + c + e, b + d + f),
        )
        min_x = min(point[0] for point in corners)
        max_x = max(point[0] for point in corners)
        min_y = min(point[1] for point in corners)
        max_y = max(point[1] for point in corners)
        tolerance = max(0.5, max(page_width, page_height) * 0.002)
        if any((
            abs(min_x - crop_box[0]) > tolerance,
            abs(max_x - crop_box[2]) > tolerance,
            abs(min_y - crop_box[1]) > tolerance,
            abs(max_y - crop_box[3]) > tolerance,
        )):
            return None

        placed_width = math.hypot(a, b) * user_unit
        placed_height = math.hypot(c, d) * user_unit
        placed_area = abs(a * d - b * c) * user_unit * user_unit
        if placed_width <= 0 or placed_height <= 0:
            return None
        if placed_area < placed_width * placed_height * 0.995:
            return None

        pixel_mm_x = placed_width * 25.4 / (72.0 * pixel_width)
        pixel_mm_y = placed_height * 25.4 / (72.0 * pixel_height)
        if max(pixel_mm_x, pixel_mm_y) / min(pixel_mm_x, pixel_mm_y) > 1.05:
            return None
        return (pixel_mm_x + pixel_mm_y) * 0.5
    except (ArithmeticError, KeyError, TypeError, ValueError, pikepdf.PdfError):
        return None


def _source_raster_scale_limit(source_pixel_mm: float | None) -> float | None:
    """Đổi mật độ ảnh gốc (mm/pixel) thành trần render px/point đáng tin cậy.

    Đây không phải cap theo cấu hình máy: ảnh raster phủ kín đã được kiểm tra chặt
    không có thêm chi tiết khi nội suy vượt lưới nguồn. PDF vector/mixed trả ``None``
    từ bước suy luận và tiếp tục render đủ DPI như trước.
    """
    try:
        pixel_mm = float(source_pixel_mm)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(pixel_mm) or pixel_mm <= 0.0:
        return None
    scale = 1.0 / (pixel_mm * _PT_PER_MM)
    return scale if math.isfinite(scale) and scale > 0.0 else None


def _infer_document_image_pixel_mm(
    document,
    page_indexes: list[int] | None = None,
) -> float | None:
    """Chỉ trả một DPI nguồn khi mọi trang đích đều suy ra nhất quán."""
    indexes = page_indexes if page_indexes is not None else list(range(len(document.pages)))
    values = [_infer_full_page_image_pixel_mm(document.pages[index]) for index in indexes]
    if not values or any(value is None for value in values):
        return None
    resolved = [float(value) for value in values]
    if max(resolved) / min(resolved) > 1.05:
        return None
    return float(np.median(resolved))


def _page_defines_cut_contour(page) -> bool:
    """Nhận diện tài nguyên CutContour có sẵn để giữ hành vi legacy."""
    try:
        resources = page.resources
        color_spaces = resources.get("/ColorSpace") if resources is not None else None
        if color_spaces is not None:
            for name, definition in color_spaces.items():
                if (
                    str(name).lower() == "/cutcontour"
                    or "/cutcontour" in str(definition).lower()
                ):
                    return True
        return False
    except (AttributeError, KeyError, TypeError, ValueError, pikepdf.PdfError):
        return False


def _document_defines_cut_contour(
    document,
    page_indexes: list[int] | None = None,
) -> bool:
    indexes = page_indexes if page_indexes is not None else list(range(len(document.pages)))
    return any(_page_defines_cut_contour(document.pages[index]) for index in indexes)


def _alpha_adaptive_fit_profile(
    geometry,
    *,
    mm_to_pts: float,
    source_pixel_mm: float | None,
) -> tuple[float, float, float]:
    """Trả ngân sách Hausdorff/cửa sổ góc/khoảng neo theo kích thước thật.

    Ảnh DPI thấp không có chi tiết hình học nhỏ hơn một pixel nguồn; ép guard
    0,12 mm cho pixel 72 DPI (0,353 mm) chỉ làm Bézier bám lại răng cưa giả.
    Scale theo căn bậc hai đường chéo giữ sai số tương đối giảm dần khi tem lớn,
    còn cap 0,75 mm ngăn làm cùn chi tiết in có ý nghĩa.
    """
    min_x, min_y, max_x, max_y = geometry.bounds
    diagonal_mm = math.hypot(max_x - min_x, max_y - min_y) / max(mm_to_pts, 1e-9)
    size_scale = min(
        _ALPHA_ADAPTIVE_MAX_SCALE,
        max(1.0, math.sqrt(max(0.0, diagonal_mm) / _ALPHA_ADAPTIVE_REFERENCE_DIAGONAL_MM)),
    )
    pixel_mm = 0.0
    if source_pixel_mm is not None:
        try:
            candidate = float(source_pixel_mm)
            if math.isfinite(candidate) and candidate > 0:
                pixel_mm = candidate
        except (TypeError, ValueError):
            pass

    hausdorff_mm = min(
        _ALPHA_ADAPTIVE_MAX_HAUSDORFF_CAP_MM,
        max(
            _ALPHA_FIT_MAX_HAUSDORFF_MM * size_scale,
            diagonal_mm * 0.003,
            pixel_mm * 1.85,
        ),
    )
    corner_window_mm = max(_ALPHA_CORNER_WINDOW_MM * size_scale, pixel_mm * 2.5)
    corner_separation_mm = max(
        _ALPHA_CORNER_MIN_SEPARATION_MM * size_scale,
        pixel_mm * 2.0,
    )
    return hausdorff_mm, corner_window_mm, corner_separation_mm


# QUALITY (audit 2026-08-06 §BG.1/§BG.2): ngưỡng "mask có tách được nền hay
# không" nay là MỘT nguồn ở `core/sticker_background`; alias lại để các chỗ gọi
# cũ trong file này khỏi đổi tên hàng loạt.
_BG_FOREGROUND_RATIO_MIN = BG_FOREGROUND_RATIO_MIN
_BG_FOREGROUND_RATIO_MAX = BG_FOREGROUND_RATIO_MAX
_foreground_ratio = foreground_ratio
_foreground_mask_tach_duoc_nen = mask_tach_duoc_nen


def _feather_mask_tu_dung(mask: np.ndarray, px_per_mm: float) -> np.ndarray:
    """Trả lại DẢI CHUYỂN TIẾP cho mask nhị phân tự dựng.

    QUALITY (audit 2026-08-07 §BG.5). Xem chú thích ở `_BG_MASK_FEATHER_MM`:
    `measure.find_contours` cần dải này để nội suy dưới mức điểm ảnh, không có
    thì đường cắt thành bậc thang. Bề rộng tính theo mm nên độc lập scale quét.

    Chỉ dùng cho mask do engine TỰ DỰNG (dò nền theo màu/gradient). Không gọi
    cho alpha thật — silhouette của khách là chủ đích, làm mờ là sửa thiết kế.
    """
    if mask is None or mask.size == 0 or px_per_mm <= 0:
        return mask
    # Nhân đôi rồi ép lẻ: kernel Gauss của OpenCV bắt buộc lẻ. Kẹp trên để tem
    # quét ở scale rất cao không bị làm mờ quá tay thành bo góc thấy được.
    k = int(round(_BG_MASK_FEATHER_MM * px_per_mm)) * 2 + 1
    k = max(_BG_MASK_FEATHER_KERNEL_MIN, min(_BG_MASK_FEATHER_KERNEL_MAX, k))
    return cv2.GaussianBlur(mask, (k, k), 0)


def _loi_khong_do_duoc_hinh(do_nen_khong_trang: bool) -> str:
    """Thông điệp lỗi nghiệp vụ khi KHÔNG trang nào dò được hình.

    QUALITY (audit 2026-08-06 §BG.1): nếu thất bại là do bóc nền trắng không ăn
    thì nói thẳng, đừng bảo thợ bật lại đúng cái vừa hỏng. Dùng CHUNG cho cả
    nhánh tuần tự lẫn nhánh song song để hai đường không nói hai kiểu.

    QUALITY (audit 2026-08-06 §BG.2/§BG.3): cờ này chỉ bật SAU khi cả nhánh nền
    màu phẳng lẫn nhánh nền gradient đã thử và bó tay, nên tuyệt đối không được
    khuyên thợ "dùng chế độ tách nền theo màu" — đó đúng là thứ vừa thất bại.
    """
    if do_nen_khong_trang:
        return (
            "Không tách được nền trên bất kỳ trang nào — đã thử cả nền trắng, nền "
            "màu phẳng và nền chuyển sắc (gradient) nhưng không phân biệt được hình "
            "với nền. Thường gặp khi nền có hoạ tiết/ảnh chụp, hoặc tem chạm sát mép "
            "khổ. Hãy dùng file PNG còn nền trong suốt (Alpha), hoặc tắt 'Bỏ nền "
            "trắng' và cắt theo khổ trang."
        )
    return (
        "Không dò được hình để tạo đường cắt. Hãy bật 'Bỏ nền trắng' "
        "nếu nền màu trắng, hoặc kiểm tra lại file (hình quá nhạt/trống)."
    )


def _foreground_mask_from_corner_background(img: np.ndarray) -> np.ndarray | None:
    """Tách vật thể khỏi nền phẳng nối từ bốn góc khi PDF không còn Alpha.

    ALPHA (audit 2026-08-01 §A.1): đây chỉ là fallback cho PNG đã bị flatten.
    QUALITY (audit 2026-08-06 §BG.2): thân hàm đã chuyển sang
    `core/sticker_background.detect_background` để nhánh nền-trắng dùng chung
    cùng một bộ dò; giữ tên hàm này làm lớp mỏng cho các chỗ gọi cũ.
    """
    info = detect_background(img)
    return info.foreground_mask if info is not None else None


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
        # QUALITY (audit 2026-08-07 §NOODLE.9): closing hình học có thể bẻ
        # tendril raster thành island riêng. Bo góc không được phép đổi số mảnh/lỗ.
        if _polygon_topology_signature(rounded) != _polygon_topology_signature(poly):
            return poly
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


def _budgeted_hausdorff_distance(
    first,
    second,
    max_budget_pts: float,
    *,
    iterations: int = 7,
) -> float:
    """Ước lượng Hausdorff bằng guard buffer, chỉ đo chính xác khi vượt trần.

    GEOS `hausdorff_distance` có chi phí O(n²) trên contour raster dày. Với
    preview live, ta chỉ cần một cận trên để kiểm cổng sai số; tìm nhị phân trên
    phép bao phủ buffer cho kết quả ổn định và rẻ hơn nhiều. Nếu ứng viên không
    nằm trong trần dự kiến thì giữ phép đo chính xác để không đổi quyết định fail.
    """
    try:
        upper = float(max_budget_pts)
    except (TypeError, ValueError, OverflowError):
        upper = 0.0
    if not math.isfinite(upper) or upper <= 0.0:
        return float(first.hausdorff_distance(second))
    if not _geometry_within_hausdorff_budget(first, second, upper):
        return float(first.hausdorff_distance(second))
    if _geometry_within_hausdorff_budget(first, second, 0.0):
        return 0.0
    lower = 0.0
    for _ in range(max(1, int(iterations))):
        middle = (lower + upper) * 0.5
        if _geometry_within_hausdorff_budget(first, second, middle):
            upper = middle
        else:
            lower = middle
    return upper


def _fit_alpha_inset_anchor_paths(
    alpha_geometry,
    ideal_cut_geometry,
    *,
    total_offset_pts: float,
    mm_to_pts: float,
    max_hausdorff_mm: float,
    corner_window_mm: float,
    corner_separation_mm: float,
    use_multiscale_geometry: bool,
):
    """Fallback cho ảnh DPI thấp: tạo headroom trong Alpha rồi fit lại ít node.

    Một pixel 72 DPI rộng 0,353 mm nên không thể tái tạo trung thực đường cong
    sai số 0,12 mm. Neo được lùi tối đa dưới một pixel, nhờ đó cubic không vọt
    ra vùng bóng; topology/Hausdorff/safe-envelope vẫn quyết định cuối cùng.
    """
    # Ảnh DPI thấp không thể biểu diễn ổn định khoảng lùi phụ 0,05 mm. Fallback
    # vẫn bắt buộc nằm trọn trong Alpha (không ăn bóng), nhưng không ép thêm một
    # khoảng nhỏ hơn nhiều so với một pixel nguồn.
    safe_envelope = alpha_geometry if total_offset_pts < 0 else None
    exact_budget_pts = max_hausdorff_mm * mm_to_pts
    ideal_envelope = ideal_cut_geometry.buffer(exact_budget_pts, join_style=1)

    # Thử từ mức gọn node mạnh tới bảo thủ. Mỗi mức đều qua lại toàn bộ guard,
    # nên contour có khe/hole mảnh sẽ tự lùi về mức nhẹ hơn thay vì bị phá topology.
    for inset_fraction in (0.50, 0.45, 0.42, 0.40, 0.35, 0.30, 0.25):
        anchor_tolerance_mm = max(0.08, max_hausdorff_mm * inset_fraction)
        anchor_tolerance_pts = anchor_tolerance_mm * mm_to_pts
        anchor_geometry = ideal_cut_geometry.buffer(
            -anchor_tolerance_pts,
            join_style=2,
        ).simplify(anchor_tolerance_pts, preserve_topology=True)
        if (
            anchor_geometry.is_empty
            or not anchor_geometry.is_valid
            or _polygon_topology_signature(anchor_geometry)
            != _polygon_topology_signature(ideal_cut_geometry)
        ):
            continue
        if isinstance(anchor_geometry, Polygon):
            source_parts = [anchor_geometry]
            return_multi = False
        elif isinstance(anchor_geometry, MultiPolygon):
            source_parts = list(anchor_geometry.geoms)
            return_multi = True
        else:
            continue

        # QUALITY (audit 2026-08-05 §AI2.CUT2): anchor đã được lùi có chủ đích
        # và mọi candidate vẫn qua safe-envelope/Hausdorff. Dùng phần ngân sách
        # toàn cục còn lại để fitter không phải bám lại từng bậc pixel của khổ lớn.
        fit_tolerance_mm = (
            max(0.05, min(0.30, max_hausdorff_mm * 0.40))
            if use_multiscale_geometry
            else max(0.05, min(0.10, anchor_tolerance_mm * 0.40))
        )
        for enforce_monotonic in (True, False):
            all_paths = []
            sampled_parts = []
            try:
                for part in source_parts:
                    exterior_segments = fit_closed_cubic_beziers_adaptive(
                        list(part.exterior.coords),
                        fit_tolerance_mm * mm_to_pts,
                        corner_window=corner_window_mm * mm_to_pts,
                        minimum_turn_degrees=_ALPHA_CORNER_MIN_TURN_DEGREES,
                        minimum_corner_separation=corner_separation_mm * mm_to_pts,
                        enforce_monotonic=enforce_monotonic,
                        validate_corner_persistence=use_multiscale_geometry,
                        smooth_raster_tangents=use_multiscale_geometry,
                    )
                    interior_segments = [
                        fit_closed_cubic_beziers_adaptive(
                            list(interior.coords),
                            fit_tolerance_mm * mm_to_pts,
                            corner_window=corner_window_mm * mm_to_pts,
                            minimum_turn_degrees=_ALPHA_CORNER_MIN_TURN_DEGREES,
                            minimum_corner_separation=corner_separation_mm * mm_to_pts,
                            enforce_monotonic=enforce_monotonic,
                            validate_corner_persistence=use_multiscale_geometry,
                            smooth_raster_tangents=use_multiscale_geometry,
                        )
                        for interior in part.interiors
                    ]
                    if not exterior_segments or any(not path for path in interior_segments):
                        raise ValueError("Không fit được anchor Alpha thích nghi")
                    exterior = sample_bezier_segments(
                        exterior_segments,
                        samples_per_segment=_ALPHA_FIT_SAMPLES,
                    )
                    interiors = [
                        sample_bezier_segments(path, samples_per_segment=_ALPHA_FIT_SAMPLES)
                        for path in interior_segments
                    ]
                    sampled_parts.append(Polygon(exterior, interiors))
                    all_paths.append(exterior_segments)
                    all_paths.extend(interior_segments)
            except (ArithmeticError, RecursionError, ValueError):
                continue

            sampled_geometry = (
                MultiPolygon(sampled_parts) if return_multi else sampled_parts[0]
            )
            if (
                sampled_geometry.is_empty
                or not sampled_geometry.is_valid
                or _polygon_topology_signature(sampled_geometry)
                != _polygon_topology_signature(ideal_cut_geometry)
                or not _geometry_within_hausdorff_budget(
                    ideal_cut_geometry,
                    sampled_geometry,
                    exact_budget_pts,
                    first_envelope=ideal_envelope,
                )
                or (
                    safe_envelope is not None
                    and (
                        safe_envelope.is_empty
                        or not safe_envelope.is_valid
                        or not safe_envelope.covers(sampled_geometry)
                    )
                )
            ):
                continue
            return sampled_geometry, all_paths, anchor_tolerance_mm
    return None


def _resample_closed_ring_by_spacing(
    coords,
    spacing_pts: float,
) -> np.ndarray:
    """Nội suy ring theo độ dài cung để low-pass không phụ thuộc mật độ node raster."""
    points = np.asarray(coords, dtype=np.float64)
    if len(points) > 1 and np.allclose(points[0], points[-1]):
        points = points[:-1]
    if len(points) < 4 or spacing_pts <= 0:
        return points
    closed = np.vstack((points, points[:1]))
    lengths = np.linalg.norm(np.diff(closed, axis=0), axis=1)
    perimeter = float(lengths.sum())
    if not math.isfinite(perimeter) or perimeter <= 0:
        return points
    sample_count = max(12, int(math.ceil(perimeter / spacing_pts)))
    cumulative = np.concatenate((np.asarray((0.0,)), np.cumsum(lengths)))
    targets = np.linspace(0.0, perimeter, sample_count, endpoint=False)
    edge_indexes = np.searchsorted(cumulative, targets, side="right") - 1
    edge_indexes = np.clip(edge_indexes, 0, len(points) - 1)
    edge_lengths = np.maximum(lengths[edge_indexes], 1e-12)
    ratios = (targets - cumulative[edge_indexes]) / edge_lengths
    return closed[edge_indexes] + ratios[:, None] * (
        closed[edge_indexes + 1] - closed[edge_indexes]
    )


def _smooth_closed_ring_source_scale(
    coords,
    *,
    spacing_pts: float,
    sigma_pts: float,
) -> np.ndarray:
    """Lọc Gaussian tuần hoàn theo pixel nguồn, không làm mất seam của ring."""
    points = _resample_closed_ring_by_spacing(coords, spacing_pts)
    if len(points) < 8 or sigma_pts <= 0:
        return points
    closed_lengths = np.linalg.norm(
        np.diff(np.vstack((points, points[:1])), axis=0),
        axis=1,
    )
    actual_spacing = max(float(closed_lengths.sum()) / len(points), 1e-12)
    sigma_samples = sigma_pts / actual_spacing
    radius = max(1, int(math.ceil(sigma_samples * 3.0)))
    offsets = np.arange(-radius, radius + 1, dtype=np.float64)
    weights = np.exp(-0.5 * (offsets / max(sigma_samples, 1e-9)) ** 2)
    weights /= weights.sum()
    padded = np.pad(points, ((radius, radius), (0, 0)), mode="wrap")
    return np.column_stack((
        np.convolve(padded[:, 0], weights, mode="valid"),
        np.convolve(padded[:, 1], weights, mode="valid"),
    ))


def _hybrid_circular_true_runs(mask: np.ndarray, minimum_count: int) -> list[tuple[int, int]]:
    """Lấy các run ``True`` trên ring, gộp đúng seam nhưng không gộp vòng lớn."""
    values = np.asarray(mask, dtype=bool)
    size = int(values.size)
    if size == 0 or not np.any(values):
        return []
    if np.all(values):
        return [(0, size - 1)] if size >= minimum_count else []

    starts = np.flatnonzero(values & ~np.roll(values, 1))
    runs: list[tuple[int, int]] = []
    for start in starts:
        end = int(start)
        while values[(end + 1) % size]:
            end += 1
            if end - int(start) + 1 >= size:
                break
        length = end - int(start) + 1
        if length >= minimum_count:
            # Giữ ``end`` chưa modulo để caller có thể lấy đúng run băng qua
            # seam bằng `arange(... ) % size`.
            runs.append((int(start), int(end)))
    return runs


def _hybrid_tls_line(points: np.ndarray):
    """Fit line TLS và trả (tâm, hướng, pháp tuyến, residual signed)."""
    cloud = np.asarray(points, dtype=np.float64)
    if cloud.ndim != 2 or cloud.shape[0] < 3 or cloud.shape[1] != 2:
        return None
    center = np.mean(cloud, axis=0)
    try:
        _u, _s, vt = np.linalg.svd(cloud - center, full_matrices=False)
    except (ArithmeticError, np.linalg.LinAlgError, ValueError):
        return None
    direction = np.asarray(vt[0], dtype=np.float64)
    norm = float(np.linalg.norm(direction))
    if not math.isfinite(norm) or norm <= 1e-9:
        return None
    direction /= norm
    if direction[0] < -1e-12 or (
        abs(direction[0]) <= 1e-12 and direction[1] < 0.0
    ):
        direction = -direction
    normal = np.asarray((-direction[1], direction[0]), dtype=np.float64)
    residuals = (cloud - center) @ normal
    return center, direction, normal, residuals


def _hybrid_angle_delta(theta: np.ndarray, target: float) -> np.ndarray:
    """Khoảng cách góc modulo 180° (tránh nhảy tại −π/π)."""
    return np.abs(np.angle(np.exp(1j * 2.0 * (theta - target)))) / 2.0


def _regularize_partial_straight_reference(
    ideal_cut_geometry,
    *,
    source_pixel_mm: float | None,
    mm_to_pts: float,
):
    """Chuẩn hóa cục bộ các cạnh thẳng dài trước fitter Bézier.

    Đây là candidate fail-closed cho tem một component không có lỗ. Nó không
    dựng rounded-rect toàn vòng: chỉ chiếu các run thẳng đã qua cổng residual,
    giữ nguyên phần contour tự do và làm feather ngắn ở hai đầu run. Vì vậy cạnh
    trái của tem bo góc được kéo thành một đường duy nhất, còn tay/mấu hữu cơ
    bên phải vẫn đi theo mask nguồn.

    Trả ``(geometry, metadata)`` hoặc ``None``. Metadata chỉ dùng log/test, không
    phải hợp đồng API.
    """
    if (
        not isinstance(ideal_cut_geometry, Polygon)
        or ideal_cut_geometry.is_empty
        or not ideal_cut_geometry.is_valid
        or ideal_cut_geometry.interiors
    ):
        return None
    try:
        pixel_mm = float(source_pixel_mm)
        scale = float(mm_to_pts)
    except (TypeError, ValueError):
        return None
    if (
        not math.isfinite(pixel_mm)
        or pixel_mm <= 0.0
        or not math.isfinite(scale)
        or scale <= 0.0
    ):
        return None

    # Một điểm lấy mẫu xấp xỉ một pixel nguồn; không tạo knot dày giả ở ảnh DPI
    # thấp.  Cùng hàm này được gọi trong preview và PDF nên không lệch quỹ đạo.
    spacing_mm = max(0.05, min(0.12, pixel_mm * 0.95))
    spacing_pts = spacing_mm * scale
    # Dò đầu vào cho phép một lượng jitter tối đa khoảng hai pixel nguồn; sau
    # khi chiếu line, candidate vẫn phải qua Hausdorff/oracle cuối.  300-DPI ca
    # thật dùng ngưỡng xấp xỉ 0,18/0,34 mm; ảnh sạch vẫn giữ cổng 0,10/0,22 mm.
    line_p95_limit_mm = max(
        _HYBRID_STRAIGHT_P95_RESIDUAL_MM,
        min(_HYBRID_STRAIGHT_P95_RESIDUAL_MAX_MM, pixel_mm * 2.20),
    )
    line_max_limit_mm = max(
        _HYBRID_STRAIGHT_MAX_RESIDUAL_MM,
        min(_HYBRID_STRAIGHT_MAX_RESIDUAL_CAP_MM, pixel_mm * 4.10),
    )
    raw = _resample_closed_ring_by_spacing(
        ideal_cut_geometry.exterior.coords,
        spacing_pts,
    )
    if len(raw) < 64:
        return None
    # Chỉ dùng bản làm mượt để đo hướng/residual; helper spline có thể đổi số
    # mẫu sau khi khép vòng, vì vậy nội suy ngược về đúng lưới `raw` thay vì
    # fail-closed oan và không bao giờ kích hoạt nhánh chuẩn hóa.
    smoothed_probe = _smooth_closed_ring_source_scale(
        raw,
        spacing_pts=spacing_pts,
        sigma_pts=min(0.35, pixel_mm * 0.45) * scale,
    )
    if len(smoothed_probe) < 8:
        return None
    probe_positions = np.linspace(
        0.0,
        1.0,
        len(smoothed_probe),
        endpoint=False,
    )
    raw_positions = np.linspace(
        0.0,
        1.0,
        len(raw),
        endpoint=False,
    )
    probe = np.column_stack((
        np.interp(
            raw_positions,
            np.r_[probe_positions, 1.0],
            np.r_[smoothed_probe[:, 0], smoothed_probe[0, 0]],
        ),
        np.interp(
            raw_positions,
            np.r_[probe_positions, 1.0],
            np.r_[smoothed_probe[:, 1], smoothed_probe[0, 1]],
        ),
    ))
    half_window = max(2, int(round(0.90 / spacing_mm)))
    tangent = np.roll(probe, -half_window, axis=0) - np.roll(
        probe,
        half_window,
        axis=0,
    )
    tangent_norm = np.linalg.norm(tangent, axis=1, keepdims=True)
    tangent = tangent / np.maximum(tangent_norm, 1e-9)
    theta = np.mod(np.arctan2(tangent[:, 1], tangent[:, 0]), math.pi)

    # Frame trội lấy bằng histogram 0,5° modulo 90°. Cạnh xoay vẫn được nhận,
    # không giả định tem luôn song song trục trang.
    bin_count = 180
    folded = np.mod(theta, math.pi / 2.0)
    histogram, edges = np.histogram(
        folded,
        bins=bin_count,
        range=(0.0, math.pi / 2.0),
    )
    smoothed_histogram = (
        np.roll(histogram, -3)
        + 2 * np.roll(histogram, -2)
        + 3 * np.roll(histogram, -1)
        + 4 * histogram
        + 3 * np.roll(histogram, 1)
        + 2 * np.roll(histogram, 2)
        + np.roll(histogram, 3)
    )
    peak = int(np.argmax(smoothed_histogram))
    frame_angle = float((edges[peak] + edges[peak + 1]) * 0.5)
    tolerance = math.radians(_HYBRID_STRAIGHT_ORIENTATION_TOLERANCE_DEG)
    straight = np.minimum(
        _hybrid_angle_delta(theta, frame_angle),
        _hybrid_angle_delta(theta, frame_angle + math.pi / 2.0),
    ) <= tolerance

    # Lấp khe do một vài pixel AA nhưng không nuốt một góc thật.  Chỉ lấp các
    # run False ngắn hơn 0,64 mm trên vòng.
    gap_count = max(1, int(round(_HYBRID_STRAIGHT_GAP_MM / spacing_mm)))
    for start, end in _hybrid_circular_true_runs(~straight, 1):
        false_indexes = (
            np.arange(start, end + 1, dtype=np.int64) % len(straight)
        )
        if len(false_indexes) <= gap_count:
            straight[false_indexes] = True

    candidates = _hybrid_circular_true_runs(
        straight,
        max(8, int(round(_HYBRID_STRAIGHT_MIN_RUN_MM / spacing_mm))),
    )
    accepted: list[dict[str, object]] = []
    for start, end in candidates:
        indexes = np.arange(start, end + 1, dtype=np.int64) % len(probe)
        fit = _hybrid_tls_line(probe[indexes])
        if fit is None:
            continue
        center, direction, normal, residuals = fit
        absolute_mm = np.abs(residuals) / scale
        projection = (probe[indexes] - center) @ direction
        run_length_mm = float(np.ptp(projection) / scale)
        if (
            run_length_mm < _HYBRID_STRAIGHT_MIN_RUN_MM
            or float(np.percentile(absolute_mm, 95))
            > line_p95_limit_mm
            or float(np.max(absolute_mm)) > line_max_limit_mm
        ):
            continue
        accepted.append(
            {
                "start": int(start),
                "end": int(end),
                "indexes": indexes,
                "center": center,
                "direction": direction,
                "normal": normal,
                "length_mm": run_length_mm,
                "p95_mm": float(np.percentile(absolute_mm, 95)),
                "max_mm": float(np.max(absolute_mm)),
            }
        )
    if len(accepted) < 2:
        return None

    # Một đường cong hữu cơ dài có thể tình cờ phẳng; yêu cầu tối thiểu một cặp
    # cạnh gần vuông để xác nhận đây là mảnh rounded-rectangle, không phải ép
    # toàn contour theo một hướng duy nhất.
    has_orthogonal_pair = False
    for left_index, first in enumerate(accepted):
        first_angle = math.atan2(
            float(first["direction"][1]),
            float(first["direction"][0]),
        )
        for second in accepted[left_index + 1 :]:
            second_angle = math.atan2(
                float(second["direction"][1]),
                float(second["direction"][0]),
            )
            angular_delta = float(
                _hybrid_angle_delta(
                    np.asarray((first_angle,)),
                    second_angle,
                )[0]
            )
            difference = math.degrees(
                min(angular_delta, math.pi - angular_delta)
            )
            if 65.0 <= difference <= 115.0:
                has_orthogonal_pair = True
                break
        if has_orthogonal_pair:
            break
    if not has_orthogonal_pair:
        return None

    modified = np.asarray(raw, dtype=np.float64).copy()
    changed = np.zeros(len(modified), dtype=bool)
    feather_count = max(1, int(round(_HYBRID_STRAIGHT_FEATHER_MM / spacing_mm)))
    for run in accepted:
        indexes = np.asarray(run["indexes"], dtype=np.int64)
        center = np.asarray(run["center"], dtype=np.float64)
        normal = np.asarray(run["normal"], dtype=np.float64)
        residual = (modified[indexes] - center) @ normal
        weights = np.ones(len(indexes), dtype=np.float64)
        count = min(feather_count, len(indexes) // 3)
        if count > 0:
            weights[:count] = np.linspace(0.0, 1.0, count)
            weights[-count:] = np.linspace(1.0, 0.0, count)
        modified[indexes] -= np.outer(residual * weights, normal)
        changed[indexes] = True

    candidate = Polygon(modified)
    topology = _polygon_topology_signature(ideal_cut_geometry)
    budget_mm = max(
        _HYBRID_STRAIGHT_MAX_HAUSDORFF_MM,
        min(0.45, pixel_mm * 3.50),
    )
    if (
        candidate.is_empty
        or not candidate.is_valid
        or _polygon_topology_signature(candidate) != topology
        # PERF (audit 2026-08-21 §CUTLINE.FAST-GUARD): đây chỉ là cổng
        # đúng/sai, không cần số đo Hausdorff chính xác. Bao phủ buffer hai
        # chiều tương đương với điều kiện Hausdorff và tránh O(n²) trên contour
        # hàng nghìn điểm; số đo chi tiết vẫn được tính ở quality cuối nếu cần.
        or not _geometry_within_hausdorff_budget(
            ideal_cut_geometry,
            candidate,
            budget_mm * scale,
        )
    ):
        return None
    return candidate, {
        "run_count": len(accepted),
        "runs": [
            {
                "length_mm": float(run["length_mm"]),
                "p95_mm": float(run["p95_mm"]),
                "max_mm": float(run["max_mm"]),
            }
            for run in accepted
        ],
        "spacing_mm": spacing_mm,
        "budget_mm": budget_mm,
        "line_p95_limit_mm": line_p95_limit_mm,
        "line_max_limit_mm": line_max_limit_mm,
        "changed_point_count": int(np.count_nonzero(changed)),
    }


def _periodic_smoothing_spline_segments(
    coords,
    *,
    smoothing_rms_pts: float,
    weights=None,
):
    """Đổi ring thành cubic B-spline tuần hoàn C2, không tạo khớp giả tại node.

    ``splprep`` trả B-spline theo miền tham số; mỗi khoảng knot được đổi chính xác
    sang một cubic Bézier để PDF và máy bế nhận đúng quỹ đạo đã kiểm, không phải
    polyline được bọc bằng tay nắm ngắn.
    """
    from scipy.interpolate import BSpline, PPoly, splprep

    points = np.asarray(coords, dtype=np.float64)
    if len(points) > 1 and np.allclose(points[0], points[-1]):
        points = points[:-1]
    if len(points) < 5:
        return []

    closed = np.vstack((points, points[:1]))
    lengths = np.linalg.norm(np.diff(closed, axis=0), axis=1)
    perimeter = float(lengths.sum())
    if not math.isfinite(perimeter) or perimeter <= 0:
        return []
    parameters = np.concatenate((np.asarray((0.0,)), np.cumsum(lengths)))
    parameters /= perimeter
    smoothing = len(closed) * max(0.0, float(smoothing_rms_pts)) ** 2

    fit_weights = None
    if weights is not None:
        fit_weights = np.asarray(weights, dtype=np.float64)
        if len(fit_weights) == len(points):
            fit_weights = np.concatenate((fit_weights, fit_weights[:1]))
        if (
            len(fit_weights) != len(closed)
            or not np.all(np.isfinite(fit_weights))
            or np.any(fit_weights <= 0)
        ):
            raise ValueError("Trọng số B-spline Alpha không hợp lệ")

    knots, coefficients, degree = splprep(
        [closed[:, 0], closed[:, 1]],
        u=parameters,
        w=fit_weights,
        s=smoothing,
        per=True,
        k=3,
    )[0]
    polynomials = []
    domains = None
    for dimension in range(2):
        spline = BSpline(
            knots,
            coefficients[dimension],
            degree,
            extrapolate="periodic",
        )
        polynomial = PPoly.from_spline(spline)
        polynomials.append(polynomial)
        if domains is None:
            domains = polynomial.x
    if domains is None:
        return []

    domain_start = float(knots[degree])
    domain_end = float(knots[-degree - 1])
    segments = []
    for index, (left, right) in enumerate(zip(domains, domains[1:])):
        left = float(left)
        right = float(right)
        span = right - left
        if (
            span <= 1e-12
            or left < domain_start - 1e-10
            or right > domain_end + 1e-10
        ):
            continue
        controls_by_dimension = []
        for polynomial in polynomials:
            cubic, quadratic, linear, constant = polynomial.c[:, index]
            controls_by_dimension.append((
                constant,
                constant + linear * span / 3.0,
                constant
                + 2.0 * linear * span / 3.0
                + quadratic * span * span / 3.0,
                ((cubic * span + quadratic) * span + linear) * span + constant,
            ))
        segments.append(tuple(
            (
                float(controls_by_dimension[0][control_index]),
                float(controls_by_dimension[1][control_index]),
            )
            for control_index in range(4)
        ))
    return segments


def _fit_alpha_periodic_spline_paths(
    alpha_geometry,
    ideal_cut_geometry,
    *,
    total_offset_pts: float,
    mm_to_pts: float,
    max_hausdorff_mm: float,
    source_pixel_mm: float | None,
    allow_high_resolution_fairing: bool = False,
    smoothness_scale: float = 1.0,
):
    """Fairing riêng cho Alpha DPI thấp, khóa topology và vùng cắt an toàn.

    Ảnh 72–100 DPI không mang thông tin hình học dưới một pixel nguồn. Mask đã duyệt
    từ pipeline nhận diện cũng được phép dùng fairing ở DPI cao vì nhiễu nằm trong
    mask AI, không nằm ở lưới render. Các caller Alpha cũ vẫn giữ ngưỡng legacy.
    """
    try:
        pixel_mm = float(source_pixel_mm)
    except (TypeError, ValueError):
        return None
    if (
        not math.isfinite(pixel_mm)
        or (pixel_mm < 0.25 and not allow_high_resolution_fairing)
    ):
        return None
    resolved_smoothness = max(
        _CUTLINE_SMOOTHNESS_SCALE_MIN,
        min(_CUTLINE_SMOOTHNESS_SCALE_MAX, float(smoothness_scale)),
    )
    topology = _polygon_topology_signature(ideal_cut_geometry)
    spline_reference_geometry = ideal_cut_geometry
    if isinstance(ideal_cut_geometry, Polygon):
        # §AI-MOTION.10: dò râu nối bằng cổ gần-zero ở chính reference. Opening
        # 0,03 mm không đụng được feature in thông thường; chỉ khi phần tách ra và
        # toàn sai khác đều ≤1e-4 diện tích mới dùng reference đã bỏ râu cho spline.
        neck_probe_mm = min(0.03, pixel_mm * 0.10)
        eroded_probe = ideal_cut_geometry.buffer(
            -neck_probe_mm * mm_to_pts,
            join_style=1,
        )
        if isinstance(eroded_probe, MultiPolygon):
            probe_components = sorted(
                eroded_probe.geoms,
                key=lambda component: component.area,
                reverse=True,
            )
            dominant_probe = probe_components[0] if probe_components else None
            satellite_area = sum(
                component.area for component in probe_components[1:]
            )
            if (
                dominant_probe is not None
                and satellite_area <= ideal_cut_geometry.area * 1.0e-4
            ):
                regularized_reference = dominant_probe.buffer(
                    neck_probe_mm * mm_to_pts,
                    join_style=1,
                )
                if (
                    isinstance(regularized_reference, Polygon)
                    and not regularized_reference.is_empty
                    and regularized_reference.is_valid
                    and _polygon_topology_signature(regularized_reference)
                    == topology
                    and ideal_cut_geometry.symmetric_difference(
                        regularized_reference
                    ).area
                    <= ideal_cut_geometry.area * 1.0e-4
                ):
                    spline_reference_geometry = regularized_reference
        source_parts = [spline_reference_geometry]
        return_multi = False
    elif isinstance(ideal_cut_geometry, MultiPolygon):
        source_parts = list(spline_reference_geometry.geoms)
        return_multi = True
    else:
        return None

    # QUALITY (audit 2026-08-08 §AI-MOTION.8): profile theo pixel nguồn, không
    # theo số node render 300 DPI. Mỗi profile là sigma, độ lùi và RMS spline.
    profile_pixels = (
        (1.98, 1.13, 0.17),
        (1.98, 0.85, 0.17),
        (1.42, 0.85, 0.26),
        (0.99, 0.85, 0.26),
        (0.99, 0.63, 0.26),
        (0.85, 0.57, 0.20),
        (0.57, 0.85, 0.34),
        (0.57, 0.63, 0.34),
        (0.57, 0.43, 0.26),
        (0.17, 0.57, 0.34),
    )
    spacing_mm = max(
        0.08,
        min(
            0.42,
            max(0.12, min(0.30, pixel_mm * 0.70)) * resolved_smoothness,
        ),
    )
    spline_budget_mm = max(
        max_hausdorff_mm,
        min(1.20, pixel_mm * 3.40),
    )
    exact_budget_pts = spline_budget_mm * mm_to_pts
    ideal_envelope = spline_reference_geometry.buffer(
        exact_budget_pts,
        join_style=1,
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
    min_x, min_y, max_x, max_y = spline_reference_geometry.bounds
    diagonal_mm = math.hypot(max_x - min_x, max_y - min_y) / max(
        mm_to_pts,
        1e-9,
    )

    candidates = []
    smoothed_by_sigma = {}
    for sigma_pixels, inset_pixels, rms_pixels in profile_pixels:
        sigma_mm = sigma_pixels * pixel_mm * resolved_smoothness
        sigma_key = round(sigma_mm, 9)
        smoothed_geometry = smoothed_by_sigma.get(sigma_key)
        if smoothed_geometry is None:
            smoothed_parts = []
            for part in source_parts:
                exterior = _smooth_closed_ring_source_scale(
                    part.exterior.coords,
                    spacing_pts=spacing_mm * mm_to_pts,
                    sigma_pts=sigma_mm * mm_to_pts,
                )
                interiors = [
                    _smooth_closed_ring_source_scale(
                        interior.coords,
                        spacing_pts=spacing_mm * mm_to_pts,
                        sigma_pts=sigma_mm * mm_to_pts,
                    )
                    for interior in part.interiors
                ]
                smoothed_parts.append(Polygon(exterior, interiors))
            smoothed_geometry = (
                MultiPolygon(smoothed_parts) if return_multi else smoothed_parts[0]
            )
            smoothed_by_sigma[sigma_key] = smoothed_geometry
        if (
            smoothed_geometry.is_empty
            or not smoothed_geometry.is_valid
            or _polygon_topology_signature(smoothed_geometry) != topology
        ):
            continue

        # QUALITY (audit 2026-08-08 §UNIFIED.ALPHA4): ``ideal_cut_geometry`` đã
        # mang đúng Offset người dùng. Mask pipeline đã xác nhận không được cộng
        # thêm inset fairing, kể cả Offset âm; nếu không −0,15 mm sẽ bị co hai lần.
        effective_inset_pixels = (
            0.0 if allow_high_resolution_fairing else inset_pixels
        )
        anchor_geometry = smoothed_geometry.buffer(
            -(effective_inset_pixels * pixel_mm) * mm_to_pts,
            join_style=1,
        )
        # §AI-MOTION.9: một râu mask nối bằng cổ gần-zero có thể tách thành đảo
        # vài phần vạn diện tích ngay khi lùi biên. Với nguồn vốn là MỘT Polygon,
        # chỉ bỏ satellite trung gian cực nhỏ; đường spline cuối vẫn phải khớp
        # topology nguồn và qua Hausdorff/safe-envelope ở phía dưới.
        if isinstance(anchor_geometry, MultiPolygon) and not return_multi:
            anchor_components = sorted(
                anchor_geometry.geoms,
                key=lambda component: component.area,
                reverse=True,
            )
            dominant = anchor_components[0] if anchor_components else None
            satellite_area = sum(
                component.area for component in anchor_components[1:]
            )
            if (
                dominant is not None
                and satellite_area
                <= spline_reference_geometry.area * 1.0e-4
            ):
                anchor_geometry = dominant
        if (
            anchor_geometry.is_empty
            or not anchor_geometry.is_valid
            or _polygon_topology_signature(anchor_geometry) != topology
        ):
            continue
        anchor_parts = (
            [anchor_geometry]
            if isinstance(anchor_geometry, Polygon)
            else list(anchor_geometry.geoms)
        )
        all_paths = []
        sampled_parts = []
        try:
            for part in anchor_parts:
                rings = [part.exterior, *part.interiors]
                fitted_rings = [
                    _periodic_smoothing_spline_segments(
                        ring.coords,
                        # §UNIFIED.ALPHA2: riêng mask nhận diện đã chốt cần RMS
                        # tối thiểu theo mm để không đặt knot cực sát quanh nhiễu AI.
                        # Caller Alpha legacy vẫn giữ nguyên profile theo pixel.
                        smoothing_rms_pts=(
                            max(
                                rms_pixels * pixel_mm * resolved_smoothness,
                                min(0.08, max_hausdorff_mm * 0.32),
                            )
                            if allow_high_resolution_fairing
                            else rms_pixels * pixel_mm * resolved_smoothness
                        ) * mm_to_pts,
                    )
                    for ring in rings
                ]
                if any(not path for path in fitted_rings):
                    raise ValueError("Không fit được B-spline Alpha tuần hoàn")
                sampled_rings = [
                    sample_bezier_segments(
                        path,
                        samples_per_segment=max(16, _ALPHA_FIT_SAMPLES),
                    )
                    for path in fitted_rings
                ]
                sampled_parts.append(
                    Polygon(sampled_rings[0], sampled_rings[1:])
                )
                all_paths.extend(fitted_rings)
        except (ArithmeticError, TypeError, ValueError):
            continue
        sampled_geometry = (
            MultiPolygon(sampled_parts) if return_multi else sampled_parts[0]
        )
        if (
            sampled_geometry.is_empty
            or not sampled_geometry.is_valid
            or _polygon_topology_signature(sampled_geometry) != topology
            or not _geometry_within_hausdorff_budget(
                spline_reference_geometry,
                sampled_geometry,
                exact_budget_pts,
                first_envelope=ideal_envelope,
            )
            or (
                safe_envelope is not None
                and (
                    safe_envelope.is_empty
                    or not safe_envelope.is_valid
                    or not safe_envelope.covers(sampled_geometry)
                )
            )
        ):
            continue
        motion_rank = _alpha_candidate_motion_rank(
            all_paths,
            mm_to_pts=mm_to_pts,
            diagonal_mm=diagonal_mm,
            can_protect_sparse_cusps=False,
        )
        candidates.append((motion_rank, sampled_geometry, all_paths))
    if not candidates:
        return None
    _rank, sampled_geometry, all_paths = min(
        candidates,
        key=lambda candidate: candidate[0],
    )
    return sampled_geometry, all_paths, spline_budget_mm


def _remove_short_alpha_anchor_edges(
    coords,
    *,
    minimum_spacing_pts: float,
) -> np.ndarray:
    """Gộp neo do cung buffer sinh quá sát nhau; không giới hạn tổng số neo.

    Ảnh 72 DPI có thể tạo hai neo cách nhau dưới một pixel sau ``buffer``/``simplify``.
    Đó là một lệnh dao cực ngắn chứ không phải thêm độ chính xác. Mỗi lượt chỉ bỏ đầu
    mút ít làm lệch hai cạnh lân cận hơn; topology/Hausdorff/safe-envelope vẫn được kiểm
    lại trên chính đường Bézier sau đó nên chi tiết thật không thể đi tắt qua guard.
    """
    points = np.asarray(coords, dtype=np.float64)
    if len(points) > 1 and np.allclose(points[0], points[-1]):
        points = points[:-1]
    if len(points) <= 4 or minimum_spacing_pts <= 0:
        return np.vstack((points, points[:1])) if len(points) else points

    def point_segment_distance(point, start, end) -> float:
        direction = end - start
        length_squared = float(np.dot(direction, direction))
        if length_squared <= 1e-12:
            return float(np.linalg.norm(point - start))
        ratio = float(np.dot(point - start, direction) / length_squared)
        projection = start + min(1.0, max(0.0, ratio)) * direction
        return float(np.linalg.norm(point - projection))

    while len(points) > 4:
        edge_lengths = np.linalg.norm(
            np.roll(points, -1, axis=0) - points,
            axis=1,
        )
        edge_index = int(np.argmin(edge_lengths))
        if float(edge_lengths[edge_index]) >= minimum_spacing_pts:
            break
        next_index = (edge_index + 1) % len(points)
        previous_index = (edge_index - 1) % len(points)
        after_index = (next_index + 1) % len(points)
        remove_first_error = point_segment_distance(
            points[edge_index],
            points[previous_index],
            points[next_index],
        )
        remove_second_error = point_segment_distance(
            points[next_index],
            points[edge_index],
            points[after_index],
        )
        remove_index = (
            edge_index
            if remove_first_error <= remove_second_error
            else next_index
        )
        points = np.delete(points, remove_index, axis=0)
    return np.vstack((points, points[:1]))


def _fit_alpha_source_smoothed_paths(
    alpha_geometry,
    ideal_cut_geometry,
    *,
    total_offset_pts: float,
    mm_to_pts: float,
    max_hausdorff_mm: float,
    source_pixel_mm: float | None,
    allow_high_resolution_fairing: bool = False,
    smoothness_scale: float = 1.0,
):
    """Lọc bậc thang theo pixel nguồn rồi fit G1 trong đúng safe-envelope Alpha."""
    try:
        pixel_mm = float(source_pixel_mm)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(pixel_mm) or pixel_mm <= 0:
        return None
    # QUALITY (audit 2026-08-08 §AI-MOTION.6/UNIFIED.ALPHA2): caller Alpha cũ chỉ
    # low-pass ảnh thô khoảng 100 DPI trở xuống. Mask nhận diện đã chốt được phép
    # fairing ở DPI cao, nhưng không được cộng inset ẩn vào ``original``.
    if pixel_mm < 0.25 and not allow_high_resolution_fairing:
        return None
    resolved_smoothness = max(
        _CUTLINE_SMOOTHNESS_SCALE_MIN,
        min(_CUTLINE_SMOOTHNESS_SCALE_MAX, float(smoothness_scale)),
    )
    if isinstance(ideal_cut_geometry, Polygon):
        source_parts = [ideal_cut_geometry]
        return_multi = False
    elif isinstance(ideal_cut_geometry, MultiPolygon):
        source_parts = list(ideal_cut_geometry.geoms)
        return_multi = True
    else:
        return None

    topology = _polygon_topology_signature(ideal_cut_geometry)
    spacing_mm = max(
        0.02,
        min(
            0.16,
            max(0.025, min(0.10, pixel_mm * 0.50)) * resolved_smoothness,
        ),
    )

    # QUALITY (audit 2026-08-08 §AI-MOTION.2/5): profile mạnh xử lý biên hữu cơ;
    # hai profile sau dành cho khe/lõm hẹp. Đây không phải chọn theo tên hình: mọi
    # candidate đều phải qua cùng guard hình học nên engine tự chọn theo dữ liệu.
    smoothing_profiles = (
        (0.48, 0.38, 0.38, None, None, None),
        (0.48, 0.28, 0.28, None, None, None),
        (0.31, 0.18, 0.23, 0.20, None, 0.15),
        (0.337, 0.107, 0.138, 0.22, 0.07, 0.09),
        (0.322, 0.107, 0.138, 0.21, 0.07, 0.09),
        (0.276, 0.092, 0.146, 0.18, 0.06, 0.095),
        (0.215, 0.077, 0.169, 0.14, 0.05, 0.11),
    )
    anchor_candidates = []
    smoothed_by_sigma = {}
    for (
        sigma_fraction,
        inset_fraction,
        simplify_fraction,
        sigma_cap_mm,
        inset_cap_mm,
        simplify_cap_mm,
    ) in smoothing_profiles:
        sigma_mm = max(
            0.04,
            max_hausdorff_mm * sigma_fraction * resolved_smoothness,
        )
        if sigma_cap_mm is not None:
            sigma_mm = min(sigma_mm, sigma_cap_mm)
        sigma_key = round(sigma_mm, 9)
        smoothed_geometry = smoothed_by_sigma.get(sigma_key)
        if smoothed_geometry is None:
            smoothed_parts = []
            for part in source_parts:
                exterior = _smooth_closed_ring_source_scale(
                    part.exterior.coords,
                    spacing_pts=spacing_mm * mm_to_pts,
                    sigma_pts=sigma_mm * mm_to_pts,
                )
                interiors = [
                    _smooth_closed_ring_source_scale(
                        interior.coords,
                        spacing_pts=spacing_mm * mm_to_pts,
                        sigma_pts=sigma_mm * mm_to_pts,
                    )
                    for interior in part.interiors
                ]
                smoothed_parts.append(Polygon(exterior, interiors))
            smoothed_geometry = (
                MultiPolygon(smoothed_parts) if return_multi else smoothed_parts[0]
            )
            smoothed_by_sigma[sigma_key] = smoothed_geometry
        if (
            smoothed_geometry.is_empty
            or not smoothed_geometry.is_valid
            or _polygon_topology_signature(smoothed_geometry) != topology
        ):
            continue
        inset_mm = max(0.015, max_hausdorff_mm * inset_fraction)
        simplify_mm = max(
            0.04,
            max(0.075, max_hausdorff_mm * simplify_fraction)
            * resolved_smoothness,
        )
        if inset_cap_mm is not None:
            inset_mm = min(inset_mm, inset_cap_mm)
        if simplify_cap_mm is not None:
            simplify_mm = min(simplify_mm, simplify_cap_mm)
        effective_inset_mm = 0.0 if allow_high_resolution_fairing else inset_mm
        anchor_geometry = smoothed_geometry.buffer(
            -effective_inset_mm * mm_to_pts,
            join_style=1,
        ).simplify(
            simplify_mm * mm_to_pts,
            preserve_topology=True,
        )
        if (
            anchor_geometry.is_empty
            or not anchor_geometry.is_valid
            or _polygon_topology_signature(anchor_geometry) != topology
        ):
            continue
        anchor_candidates.append((anchor_geometry, simplify_mm))
    if not anchor_candidates:
        return None

    minimum_gap_pts = min(
        _ALPHA_SAFE_MIN_GAP_MM * mm_to_pts,
        max(0.0, -float(total_offset_pts)),
    )
    safe_envelope = (
        alpha_geometry.buffer(-minimum_gap_pts, join_style=1)
        if minimum_gap_pts > 0
        else None
    )
    source_budget_mm = max_hausdorff_mm
    if allow_high_resolution_fairing:
        source_budget_mm = max(
            source_budget_mm,
            min(0.40, pixel_mm * 3.40),
        )
    exact_budget_pts = source_budget_mm * mm_to_pts
    ideal_envelope = ideal_cut_geometry.buffer(exact_budget_pts, join_style=1)
    min_x, min_y, max_x, max_y = ideal_cut_geometry.bounds
    diagonal_mm = math.hypot(max_x - min_x, max_y - min_y) / max(
        mm_to_pts,
        1e-9,
    )
    candidates = []
    minimum_anchor_spacing_pts = (
        _PRESERVED_MOTION_SHORT_SEGMENT_MM * 1.08 * mm_to_pts
    )
    if allow_high_resolution_fairing:
        # PERF (audit 2026-08-08 §UNIFIED.ALPHA3): mask đã duyệt không được phép
        # chọn candidate còn anchor cực ngắn. Bỏ hẳn nhánh unmerged bị bộ xếp hạng
        # loại, và giữ bốn mức tension đại diện; guard topology/Hausdorff phía dưới
        # vẫn quyết định candidate nào hợp lệ. Nhánh Alpha legacy giữ ma trận cũ.
        merge_short_options = (True,)
        tension_options = (0.33, 0.22, 0.10, 0.03)
    else:
        merge_short_options = (False, True)
        tension_options = (
            0.33, 0.30, 0.26, 0.22, 0.18, 0.15,
            0.12, 0.10, 0.07, 0.05, 0.03, 0.02, 0.01, 0.005,
        )
    for anchor_geometry, simplify_mm in anchor_candidates:
        anchor_parts = (
            [anchor_geometry]
            if isinstance(anchor_geometry, Polygon)
            else list(anchor_geometry.geoms)
        )
        # Tension lớn thử trước để tay nắm không quá ngắn so với độ làm tròn 4 chữ
        # số của content stream PDF; mọi mức vẫn phải qua cùng guard phía dưới.
        for merge_short_anchors in merge_short_options:
            # QUALITY (audit 2026-08-08 §AI-MOTION.7): tay nắm 0,05–0,10 có
            # thể tạo lệnh cubic hợp lệ nhưng thân đường gần như đoạn thẳng, chỉ
            # bo vi mô ở node. Thử cả dải tay nắm dài để bộ xếp hạng độ cong bên
            # dưới chọn quỹ đạo thật sự mượt; guard hình học vẫn quyết định hợp lệ.
            for tension in tension_options:
                all_paths = []
                sampled_parts = []
                try:
                    for part in anchor_parts:
                        rings = [part.exterior, *part.interiors]
                        fitted_rings = []
                        for ring in rings:
                            coords = list(ring.coords)
                            if merge_short_anchors:
                                coords = _remove_short_alpha_anchor_edges(
                                    coords,
                                    minimum_spacing_pts=minimum_anchor_spacing_pts,
                                )
                            fitted_rings.append(
                                _catmull_rom_bezier_segments(
                                    coords,
                                    tension=tension,
                                )
                            )
                        if any(not path for path in fitted_rings):
                            raise ValueError(
                                "Không fit được ring Alpha đã lọc theo pixel nguồn"
                            )
                        exterior = sample_bezier_segments(
                            fitted_rings[0],
                            samples_per_segment=_ALPHA_FIT_SAMPLES,
                        )
                        interiors = [
                            sample_bezier_segments(
                                path,
                                samples_per_segment=_ALPHA_FIT_SAMPLES,
                            )
                            for path in fitted_rings[1:]
                        ]
                        sampled_parts.append(Polygon(exterior, interiors))
                        all_paths.extend(fitted_rings)
                except (ArithmeticError, RecursionError, ValueError):
                    continue
                sampled_geometry = (
                    MultiPolygon(sampled_parts) if return_multi else sampled_parts[0]
                )
                if (
                    sampled_geometry.is_empty
                    or not sampled_geometry.is_valid
                    or _polygon_topology_signature(sampled_geometry) != topology
                    or not _geometry_within_hausdorff_budget(
                        ideal_cut_geometry,
                        sampled_geometry,
                        exact_budget_pts,
                        first_envelope=ideal_envelope,
                    )
                    or (
                        safe_envelope is not None
                        and (
                            safe_envelope.is_empty
                            or not safe_envelope.is_valid
                            or not safe_envelope.covers(sampled_geometry)
                        )
                    )
                ):
                    continue
                motion_rank = _alpha_candidate_motion_rank(
                    all_paths,
                    mm_to_pts=mm_to_pts,
                    diagonal_mm=diagonal_mm,
                    can_protect_sparse_cusps=False,
                )
                candidates.append(
                    (motion_rank, sampled_geometry, all_paths, simplify_mm)
                )
    if not candidates:
        return None
    _rank, sampled_geometry, all_paths, simplify_mm = min(
        candidates,
        key=lambda candidate: candidate[0],
    )
    return sampled_geometry, all_paths, simplify_mm


def _fit_alpha_simplified_anchor_paths(
    alpha_geometry,
    ideal_cut_geometry,
    *,
    total_offset_pts: float,
    mm_to_pts: float,
    max_hausdorff_mm: float,
    corner_window_mm: float,
    corner_separation_mm: float,
    source_pixel_mm: float | None = None,
    allow_high_resolution_fairing: bool = False,
    smoothness_scale: float = 1.0,
):
    """Fallback cho contour nhiều notch: thử cả khóa góc và quỹ đạo G1 có guard."""
    exact_budget_pts = max_hausdorff_mm * mm_to_pts
    ideal_envelope = ideal_cut_geometry.buffer(exact_budget_pts, join_style=1)
    minimum_gap_pts = min(
        _ALPHA_SAFE_MIN_GAP_MM * mm_to_pts,
        max(0.0, -float(total_offset_pts)),
    )
    safe_envelope = (
        alpha_geometry.buffer(-minimum_gap_pts, join_style=1)
        if minimum_gap_pts > 0
        else None
    )
    topology = _polygon_topology_signature(ideal_cut_geometry)

    # QUALITY (audit 2026-08-05 §AI2.CUT2): cặp lùi/simplify được biểu diễn theo
    # ngân sách Hausdorff vật lý. Candidate mạnh thử trước; mọi trường hợp vẫn phải
    # qua topology, safe-envelope và Hausdorff chính xác trước khi được dùng.
    profiles = (
        # QUALITY (audit 2026-08-08 §AI-MOTION.1): headroom nhỏ + simplify gần
        # hết ngân sách cho phép Catmull G1 đi qua đúng quỹ đạo nhưng không bị
        # safe-envelope loại chỉ vì tay nắm vượt ra ngoài Alpha vài phần pixel.
        (0.16, 0.90, 1),
        (0.13, 0.90, 1),
        (0.37, 0.49, 2),
        (0.43, 0.43, 2),
        (0.31, 0.43, 2),
        (0.37, 0.43, 2),
        (0.31, 0.37, 2),
        (0.25, 0.37, 2),
    )
    min_x, min_y, max_x, max_y = ideal_cut_geometry.bounds
    diagonal_mm = math.hypot(max_x - min_x, max_y - min_y) / max(
        mm_to_pts,
        1e-9,
    )
    candidates = []
    periodic_spline_result = _fit_alpha_periodic_spline_paths(
        alpha_geometry,
        ideal_cut_geometry,
        total_offset_pts=total_offset_pts,
        mm_to_pts=mm_to_pts,
        max_hausdorff_mm=max_hausdorff_mm,
        source_pixel_mm=source_pixel_mm,
        allow_high_resolution_fairing=allow_high_resolution_fairing,
        smoothness_scale=smoothness_scale,
    )
    if periodic_spline_result is not None:
        spline_geometry, spline_paths, spline_tolerance = periodic_spline_result
        candidates.append((
            _alpha_candidate_motion_rank(
                spline_paths,
                mm_to_pts=mm_to_pts,
                diagonal_mm=diagonal_mm,
                can_protect_sparse_cusps=False,
            ),
            spline_geometry,
            spline_paths,
            spline_tolerance,
        ))
    source_smoothed_result = _fit_alpha_source_smoothed_paths(
        alpha_geometry,
        ideal_cut_geometry,
        total_offset_pts=total_offset_pts,
        mm_to_pts=mm_to_pts,
        max_hausdorff_mm=max_hausdorff_mm,
        source_pixel_mm=source_pixel_mm,
        allow_high_resolution_fairing=allow_high_resolution_fairing,
        smoothness_scale=smoothness_scale,
    )
    if source_smoothed_result is not None:
        source_geometry, source_paths, source_tolerance = source_smoothed_result
        candidates.append((
            _alpha_candidate_motion_rank(
                source_paths,
                mm_to_pts=mm_to_pts,
                diagonal_mm=diagonal_mm,
                can_protect_sparse_cusps=False,
            ),
            source_geometry,
            source_paths,
            source_tolerance,
        ))
    for profile_index, (
        inset_fraction,
        simplify_fraction,
        anchor_join_style,
    ) in enumerate(profiles):
        if profile_index < 2:
            inset_cap_mm = 0.025 if profile_index == 0 else 0.02
            inset_mm = max(
                0.01,
                min(inset_cap_mm, max_hausdorff_mm * inset_fraction),
            )
            simplify_mm = max(
                0.08,
                min(0.14, max_hausdorff_mm * simplify_fraction),
            ) * smoothness_scale
        else:
            inset_mm = max(0.01, max_hausdorff_mm * inset_fraction)
            simplify_mm = (
                max(0.08, max_hausdorff_mm * simplify_fraction)
                * smoothness_scale
            )
        simplify_mm = max(0.04, min(0.40, simplify_mm))
        anchor_geometry = ideal_cut_geometry.buffer(
            -inset_mm * mm_to_pts,
            join_style=anchor_join_style,
        ).simplify(
            simplify_mm * mm_to_pts,
            preserve_topology=True,
        )
        if (
            anchor_geometry.is_empty
            or not anchor_geometry.is_valid
            or _polygon_topology_signature(anchor_geometry) != topology
        ):
            continue
        if isinstance(anchor_geometry, Polygon):
            source_parts = [anchor_geometry]
            return_multi = False
        elif isinstance(anchor_geometry, MultiPolygon):
            source_parts = list(anchor_geometry.geoms)
            return_multi = True
        else:
            continue

        builders = [
            ("g1", tension)
            for tension in (
                0.33, 0.30, 0.26, 0.22, 0.18, 0.15, 0.12, 0.10, 0.08,
            )
        ] + [
            ("corner_locked", tension)
            for tension in (0.15, 0.12, 0.10, 0.08, 0.05, 0.03)
        ]
        for builder, tension in builders:
            all_paths = []
            sampled_parts = []
            try:
                for part in source_parts:
                    def fit_ring(coords):
                        if builder == "g1":
                            return _catmull_rom_bezier_segments(
                                coords,
                                tension=tension,
                            )
                        return build_corner_locked_catmull_beziers(
                            coords,
                            tension=tension,
                            corner_window=corner_window_mm * mm_to_pts,
                            minimum_turn_degrees=_ALPHA_CORNER_MIN_TURN_DEGREES,
                            minimum_corner_separation=(
                                corner_separation_mm * mm_to_pts
                            ),
                        )

                    exterior_segments = fit_ring(list(part.exterior.coords))
                    interior_segments = [
                        fit_ring(list(interior.coords))
                        for interior in part.interiors
                    ]
                    if not exterior_segments or any(
                        not segments for segments in interior_segments
                    ):
                        sampled_parts = []
                        break
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
            if not sampled_parts:
                continue
            sampled_geometry = (
                MultiPolygon(sampled_parts) if return_multi else sampled_parts[0]
            )
            if (
                sampled_geometry.is_empty
                or not sampled_geometry.is_valid
                or _polygon_topology_signature(sampled_geometry) != topology
                or not _geometry_within_hausdorff_budget(
                    ideal_cut_geometry,
                    sampled_geometry,
                    exact_budget_pts,
                    first_envelope=ideal_envelope,
                )
                or (
                    safe_envelope is not None
                    and (
                        safe_envelope.is_empty
                        or not safe_envelope.is_valid
                        or not safe_envelope.covers(sampled_geometry)
                    )
                )
            ):
                continue
            motion_rank = _alpha_candidate_motion_rank(
                all_paths,
                mm_to_pts=mm_to_pts,
                diagonal_mm=diagonal_mm,
                can_protect_sparse_cusps=(builder == "corner_locked"),
            )
            candidates.append(
                (motion_rank, sampled_geometry, all_paths, simplify_mm)
            )
    if not candidates:
        return None
    _rank, sampled_geometry, all_paths, simplify_mm = min(
        candidates,
        key=lambda candidate: candidate[0],
    )
    return sampled_geometry, all_paths, simplify_mm


def _polygon_node_count(geometry) -> int:
    """Đếm node thực của mọi ring, không tính điểm đóng lặp lại."""
    rings = _polygon_rings(geometry)
    if rings is None:
        return 0
    return sum(max(0, len(ring.coords) - 1) for ring in rings)


def _preserved_contour_fallback_geometry(
    geometry,
    *,
    mm_to_pts: float,
    source_pixel_mm: float | None,
):
    """Fallback giữ biên nhưng không xuất nguyên bậc raster của ảnh lớn.

    QUALITY (audit 2026-08-07 §NOODLE.12): 0,20 mm từng nhỏ hơn một pixel nguồn
    ở tem lớn nên hoa/bánh răng rơi về 4.804–10.981 lệnh thẳng. Ngưỡng mới đo theo
    pixel ảnh nguồn, vẫn khóa topology và ngân sách Hausdorff; đây là giới hạn
    hình học của dữ liệu đầu vào, không phải cap hiệu năng/phần cứng.
    """
    pixel_mm = 0.0
    if source_pixel_mm is not None:
        try:
            candidate = float(source_pixel_mm)
            if math.isfinite(candidate) and candidate > 0:
                pixel_mm = candidate
        except (TypeError, ValueError):
            pass

    source_parts = (
        [geometry]
        if isinstance(geometry, Polygon)
        else list(geometry.geoms)
    )
    has_interiors = any(len(part.interiors) > 0 for part in source_parts)
    simplify_mm = max(
        0.10 if has_interiors else 0.20,
        pixel_mm * _PRESERVE_FALLBACK_SOURCE_PIXEL_SIMPLIFY,
    )
    budget_mm = max(
        _EXISTING_CONTOUR_MAX_HAUSDORFF_MM,
        pixel_mm * _PRESERVE_FALLBACK_SOURCE_PIXEL_BUDGET,
    )
    topology = _polygon_topology_signature(geometry)
    simplified = geometry.simplify(
        simplify_mm * mm_to_pts,
        preserve_topology=True,
    )
    if (
        simplified.is_empty
        or not simplified.is_valid
        or _polygon_topology_signature(simplified) != topology
    ):
        return geometry, 0.0

    rounded = _round_preserved_corners(
        simplified,
        radius_pts=_PRESERVE_CORNER_RADIUS_MM * mm_to_pts,
        quad_segs=_PRESERVE_CORNER_QUAD_SEGS,
    )
    budget_pts = budget_mm * mm_to_pts
    envelope = geometry.buffer(budget_pts, join_style=1)
    # §NOODLE.14: không bo cả hai phía của interior ring ở tem nhỏ; bán kính
    # 0,40 mm từng làm diện tích lỗ chữ B lệch 6,7% dù topology còn nguyên.
    candidates = (simplified,) if has_interiors else (rounded, simplified)
    for candidate in candidates:
        if (
            not candidate.is_empty
            and candidate.is_valid
            and _polygon_topology_signature(candidate) == topology
            and _geometry_within_hausdorff_budget(
                geometry,
                candidate,
                budget_pts,
                first_envelope=envelope,
            )
        ):
            return candidate, simplify_mm
    return geometry, 0.0


def _preserved_candidate_motion_rank(
    paths,
    *,
    mm_to_pts: float,
    diagonal_mm: float,
    can_protect_sparse_cusps: bool,
):
    """Xếp hạng quỹ đạo mà không biến số node thành điều kiện đúng/sai.

    Một hoặc hai khớp cực nhọn trên nhánh khóa góc được xem là cusp thật (đỉnh
    và hõm của tim). Quy tắc này đứng sau yêu cầu không có lệnh cực ngắn, nhưng
    đứng trước số lần đảo dấu độ cong để nhánh trơn không được phép xóa cusp.
    """
    metrics = [
        analyze_machine_path(
            cubic_segments_from_tuples(path),
            mm_to_units=mm_to_pts,
            smooth_join_threshold_degrees=(
                _PRESERVED_MOTION_SMOOTH_JOIN_DEGREES
            ),
            short_segment_threshold_mm=_PRESERVED_MOTION_SHORT_SEGMENT_MM,
            curvature_noise_floor_per_mm=(
                _PRESERVED_MOTION_CURVATURE_NOISE_PER_DIAGONAL
                / max(diagonal_mm, 1e-9)
            ),
        )
        for path in paths
    ]
    short_segment_count = sum(metric.short_segment_count for metric in metrics)
    sharp_join_count = sum(
        metric.discontinuous_join_count for metric in metrics
    )
    curvature_flip_count = sum(
        metric.curvature_sign_flip_count for metric in metrics
    )
    segment_count = sum(metric.segment_count for metric in metrics)

    strong_cusp_count = 0
    if (
        can_protect_sparse_cusps
        and 1 <= sharp_join_count <= 2
        and max(
            (
                metric.maximum_join_angle_degrees or 0.0
                for metric in metrics
            ),
            default=0.0,
        ) >= _PRESERVED_MOTION_STRONG_CUSP_DEGREES
    ):
        strong_cusp_count = sum(
            analyze_machine_path(
                cubic_segments_from_tuples(path),
                mm_to_units=mm_to_pts,
                smooth_join_threshold_degrees=(
                    _PRESERVED_MOTION_STRONG_CUSP_DEGREES
                ),
                short_segment_threshold_mm=(
                    _PRESERVED_MOTION_SHORT_SEGMENT_MM
                ),
                curvature_noise_floor_per_mm=(
                    _PRESERVED_MOTION_CURVATURE_NOISE_PER_DIAGONAL
                    / max(diagonal_mm, 1e-9)
                ),
            ).discontinuous_join_count
            for path in paths
        )
    protects_sparse_cusps = (
        1 <= strong_cusp_count <= 2
        and strong_cusp_count == sharp_join_count
    )
    artificial_join_count = max(0, sharp_join_count - strong_cusp_count)
    return (
        short_segment_count > 0,
        not protects_sparse_cusps,
        curvature_flip_count,
        artificial_join_count,
        segment_count,
    )


def _alpha_candidate_motion_rank(
    paths,
    *,
    mm_to_pts: float,
    diagonal_mm: float,
    can_protect_sparse_cusps: bool,
):
    """Xếp hạng Alpha sau guard hình học, ưu tiên bỏ khớp gãy do mask raster.

    Contour Alpha của mockup thường có nhiều lượn lõm/lồi hợp lệ trên viền trắng;
    đổi dấu độ cong ở các lượn này không đồng nghĩa với một khớp dao bị gãy. Quan
    trọng hơn, cubic có tay nắm quá ngắn vẫn nhìn như polyline dù góc tiếp tuyến
    bằng 0. Vì vậy Alpha ưu tiên độ nhảy độ cong P95 trước số lần đổi dấu và node.
    """
    preserved_rank = _preserved_candidate_motion_rank(
        paths,
        mm_to_pts=mm_to_pts,
        diagonal_mm=diagonal_mm,
        can_protect_sparse_cusps=can_protect_sparse_cusps,
    )
    (
        has_short_segments,
        loses_sparse_cusps,
        curvature_flip_count,
        artificial_join_count,
        segment_count,
    ) = preserved_rank
    curvature_metrics = [
        analyze_machine_path(
            cubic_segments_from_tuples(path),
            mm_to_units=mm_to_pts,
            smooth_join_threshold_degrees=(
                _PRESERVED_MOTION_SMOOTH_JOIN_DEGREES
            ),
            short_segment_threshold_mm=_PRESERVED_MOTION_SHORT_SEGMENT_MM,
            curvature_noise_floor_per_mm=(
                _PRESERVED_MOTION_CURVATURE_NOISE_PER_DIAGONAL
                / max(diagonal_mm, 1e-9)
            ),
        )
        for path in paths
    ]
    p95_curvature_jump = max(
        (
            metric.p95_curvature_jump_per_mm or 0.0
            for metric in curvature_metrics
        ),
        default=0.0,
    )
    maximum_curvature_jump = max(
        (
            metric.maximum_curvature_jump_per_mm or 0.0
            for metric in curvature_metrics
        ),
        default=0.0,
    )
    # C2 spline có sai số số học quanh 1e-13 tại knot. Chuẩn hóa về 0 để thứ tự
    # ứng viên C2 được quyết định bởi dao động cong thật, không bởi nhiễu float.
    if p95_curvature_jump < 1e-6:
        p95_curvature_jump = 0.0
    if maximum_curvature_jump < 1e-6:
        maximum_curvature_jump = 0.0
    return (
        has_short_segments,
        loses_sparse_cusps,
        artificial_join_count,
        p95_curvature_jump,
        maximum_curvature_jump,
        curvature_flip_count,
        segment_count,
    )


def _fit_preserved_contour_paths(
    ideal_cut_geometry,
    *,
    mm_to_pts: float,
    source_pixel_mm: float | None,
):
    """Làm mượt contour có biên theo mm mà vẫn khóa góc và có guard chính xác.

    Khác nhánh Alpha, đường này không cần safe-envelope lùi vào trong. Geometry
    được simplify trước khi fit để chi phí không tăng theo hàng chục nghìn bậc
    pixel của ảnh lớn; mọi cubic vẫn phải giữ topology và nằm trong ngân sách
    Hausdorff theo mm/pixel nguồn.
    """
    if isinstance(ideal_cut_geometry, Polygon):
        source_parts = [ideal_cut_geometry]
        return_multi = False
    elif isinstance(ideal_cut_geometry, MultiPolygon):
        source_parts = list(ideal_cut_geometry.geoms)
        return_multi = True
    else:
        return None
    if not source_parts or len(source_parts) > _EXISTING_CONTOUR_MAX_COMPONENTS:
        return None

    ring_count = sum(1 + len(part.interiors) for part in source_parts)
    if ring_count > _EXISTING_CONTOUR_MAX_RINGS:
        return None

    min_x, min_y, max_x, max_y = ideal_cut_geometry.bounds
    diagonal_mm = math.hypot(max_x - min_x, max_y - min_y) / max(mm_to_pts, 1e-9)
    pixel_mm = 0.0
    if source_pixel_mm is not None:
        try:
            candidate = float(source_pixel_mm)
            if math.isfinite(candidate) and candidate > 0:
                pixel_mm = candidate
        except (TypeError, ValueError):
            pass
    if pixel_mm > 0:
        # QUALITY (audit 2026-08-07 §NOODLE.9): không khóa fitter dưới kích
        # thước một pixel ảnh nguồn. Ngân sách 2 px đã đo trên sao JPEG
        # 20–1600 mm: 10–16 cubic, giữ topology/độ lõm và ratio chu vi 1,179.
        # Đây là ngân sách hình học theo dữ liệu nguồn, không phải cap tài nguyên.
        max_hausdorff_mm = max(
            0.20,
            pixel_mm * _EXISTING_CONTOUR_SOURCE_PIXEL_BUDGET,
        )
    else:
        max_hausdorff_mm = min(
            _EXISTING_CONTOUR_MAX_HAUSDORFF_MM,
            max(0.20, diagonal_mm * 0.0015),
        )
    fallback_geometry, _fallback_simplify_mm = _preserved_contour_fallback_geometry(
        ideal_cut_geometry,
        mm_to_pts=mm_to_pts,
        source_pixel_mm=pixel_mm or None,
    )
    fallback_nodes = _polygon_node_count(fallback_geometry)
    if fallback_nodes < 16:
        return None
    size_scale = min(
        _ALPHA_ADAPTIVE_MAX_SCALE,
        max(1.0, math.sqrt(max(0.0, diagonal_mm) / _ALPHA_ADAPTIVE_REFERENCE_DIAGONAL_MM)),
    )
    corner_window_mm = max(_ALPHA_CORNER_WINDOW_MM * size_scale, pixel_mm * 2.5)
    corner_separation_mm = max(
        _ALPHA_CORNER_MIN_SEPARATION_MM * size_scale,
        pixel_mm * 2.0,
    )
    corner_discontinuity_window_pts = (
        pixel_mm * _PRESERVED_CORNER_SOURCE_PIXEL_WINDOW * mm_to_pts
        if pixel_mm > 0
        else None
    )
    exact_budget_pts = max_hausdorff_mm * mm_to_pts
    ideal_envelope = ideal_cut_geometry.buffer(exact_budget_pts, join_style=1)
    topology = _polygon_topology_signature(ideal_cut_geometry)

    # Mạnh trước, bảo thủ sau. Reference gốc chỉ dùng để khóa feature và kiểm
    # guard; simplify chỉ tạo tập neo cho fitter, không thay quỹ đạo chuẩn.
    for simplify_fraction in (0.90, 0.75, 0.60, 0.45):
        simplify_mm = max_hausdorff_mm * simplify_fraction
        anchor_geometry = ideal_cut_geometry.simplify(
            simplify_mm * mm_to_pts,
            preserve_topology=True,
        )
        if (
            anchor_geometry.is_empty
            or not anchor_geometry.is_valid
            or _polygon_topology_signature(anchor_geometry) != topology
        ):
            continue
        if isinstance(anchor_geometry, Polygon):
            anchor_parts = [anchor_geometry]
        elif isinstance(anchor_geometry, MultiPolygon):
            anchor_parts = list(anchor_geometry.geoms)
        else:
            continue

        fit_tolerance_pts = max(0.05, max_hausdorff_mm * 0.30) * mm_to_pts
        remaining_reference_parts = list(source_parts)
        paired_parts = []
        try:
            for part in anchor_parts:
                matching_reference_parts = [
                    index
                    for index, candidate in enumerate(remaining_reference_parts)
                    if len(candidate.interiors) == len(part.interiors)
                ]
                reference_part_index = min(
                    matching_reference_parts or range(len(remaining_reference_parts)),
                    key=lambda index: part.centroid.distance(
                        remaining_reference_parts[index].centroid
                    ),
                )
                reference_part = remaining_reference_parts.pop(reference_part_index)
                reference_interiors = list(reference_part.interiors)
                interior_pairs = []
                for interior in part.interiors:
                    reference_interior_index = min(
                        range(len(reference_interiors)),
                        key=lambda index: interior.centroid.distance(
                            reference_interiors[index].centroid
                        ),
                    )
                    reference_interior = reference_interiors.pop(
                        reference_interior_index
                    )
                    interior_pairs.append(
                        (
                            list(interior.coords),
                            list(reference_interior.coords),
                        )
                    )
                paired_parts.append(
                    (
                        (
                            list(part.exterior.coords),
                            list(reference_part.exterior.coords),
                        ),
                        interior_pairs,
                    )
                )
        except (ArithmeticError, RecursionError, ValueError):
            continue

        # QUALITY (audit 2026-08-08 §MOTION.1–4): cùng một tập neo phải thử cả
        # nhánh khóa góc chuẩn, nhánh nhạy cho góc nông và nhánh G1 trơn. Chỉ
        # sau khi qua topology/Hausdorff mới dùng metric chạy dao để chọn.
        profiles = [
            ("adaptive", minimum_turn_degrees)
            for minimum_turn_degrees in _PRESERVED_ADAPTIVE_TURN_DEGREES
        ]
        profiles.append(("catmull", None))
        candidates = []
        for profile, minimum_turn_degrees in profiles:
            all_paths = []
            sampled_parts = []
            try:
                for exterior_pair, interior_pairs in paired_parts:
                    ring_pairs = [exterior_pair, *interior_pairs]
                    fitted_rings = []
                    for anchor_coords, reference_coords in ring_pairs:
                        if minimum_turn_degrees is None:
                            segments = _catmull_rom_bezier_segments(
                                anchor_coords,
                                tension=_PRESERVED_SMOOTH_CATMULL_TENSION,
                            )
                        else:
                            segments = fit_closed_cubic_beziers_adaptive(
                                anchor_coords,
                                fit_tolerance_pts,
                                corner_window=corner_window_mm * mm_to_pts,
                                minimum_turn_degrees=minimum_turn_degrees,
                                minimum_corner_separation=(
                                    corner_separation_mm * mm_to_pts
                                ),
                                enforce_monotonic=True,
                                validate_corner_persistence=True,
                                smooth_raster_tangents=True,
                                reference_coords=reference_coords,
                                corner_discontinuity_window=(
                                    corner_discontinuity_window_pts
                                ),
                            )
                        if not segments:
                            raise ValueError("Không fit được contour giữ góc")
                        fitted_rings.append(segments)

                    exterior = sample_bezier_segments(
                        fitted_rings[0],
                        samples_per_segment=_ALPHA_FIT_SAMPLES,
                    )
                    interiors = [
                        sample_bezier_segments(
                            path,
                            samples_per_segment=_ALPHA_FIT_SAMPLES,
                        )
                        for path in fitted_rings[1:]
                    ]
                    sampled_parts.append(Polygon(exterior, interiors))
                    all_paths.extend(fitted_rings)
            except (ArithmeticError, RecursionError, ValueError):
                continue

            sampled_geometry = (
                MultiPolygon(sampled_parts) if return_multi else sampled_parts[0]
            )
            if (
                sampled_geometry.is_empty
                or not sampled_geometry.is_valid
                or _polygon_topology_signature(sampled_geometry) != topology
                or not _geometry_within_hausdorff_budget(
                    ideal_cut_geometry,
                    sampled_geometry,
                    exact_budget_pts,
                    first_envelope=ideal_envelope,
                )
            ):
                continue
            motion_rank = _preserved_candidate_motion_rank(
                all_paths,
                mm_to_pts=mm_to_pts,
                diagonal_mm=diagonal_mm,
                can_protect_sparse_cusps=(profile == "adaptive"),
            )
            candidates.append(
                (motion_rank, sampled_geometry, all_paths, simplify_mm)
            )

        if candidates:
            _rank, sampled_geometry, all_paths, simplify_mm = min(
                candidates,
                key=lambda candidate: candidate[0],
            )
            return sampled_geometry, all_paths, simplify_mm
    return None


def _fit_round_contour_paths(
    ideal_cut_geometry,
    *,
    mm_to_pts: float,
):
    """Dựng cubic C2 cho ``Góc tròn`` nhưng khóa sát quỹ đạo hình học đã duyệt.

    Catmull–Rom cũ đi qua mọi node nhưng tay nắm có thể vọt khỏi contour ở phần
    lồi và cắt tắt phần lõm. Periodic B-spline giữ liên tục độ cong; profile mạnh
    được thử trước và chỉ nhận khi topology cùng Hausdorff hai chiều đều đạt.
    """
    if isinstance(ideal_cut_geometry, Polygon):
        source_parts = [ideal_cut_geometry]
        return_multi = False
    elif isinstance(ideal_cut_geometry, MultiPolygon):
        source_parts = list(ideal_cut_geometry.geoms)
        return_multi = True
    else:
        return None
    if not source_parts or len(source_parts) > _EXISTING_CONTOUR_MAX_COMPONENTS:
        return None
    ring_count = sum(1 + len(part.interiors) for part in source_parts)
    if ring_count > _EXISTING_CONTOUR_MAX_RINGS:
        return None

    topology = _polygon_topology_signature(ideal_cut_geometry)
    exact_budget_pts = _ROUND_PATH_MAX_HAUSDORFF_MM * mm_to_pts
    ideal_envelope = ideal_cut_geometry.buffer(exact_budget_pts, join_style=1)

    for smoothing_rms_mm in _ROUND_PATH_SPLINE_RMS_PROFILES_MM:
        all_paths = []
        sampled_parts = []
        try:
            for part in source_parts:
                rings = [part.exterior, *part.interiors]
                fitted_rings = [
                    _periodic_smoothing_spline_segments(
                        ring.coords,
                        smoothing_rms_pts=smoothing_rms_mm * mm_to_pts,
                    )
                    for ring in rings
                ]
                if any(not path for path in fitted_rings):
                    raise ValueError("Không fit được spline tuần hoàn cho Góc tròn")
                sampled_rings = [
                    sample_bezier_segments(
                        path,
                        samples_per_segment=_ROUND_PATH_GUARD_SAMPLES,
                    )
                    for path in fitted_rings
                ]
                sampled_parts.append(
                    Polygon(sampled_rings[0], sampled_rings[1:])
                )
                all_paths.extend(fitted_rings)
        except (ArithmeticError, TypeError, ValueError):
            continue

        sampled_geometry = (
            MultiPolygon(sampled_parts) if return_multi else sampled_parts[0]
        )
        if (
            sampled_geometry.is_empty
            or not sampled_geometry.is_valid
            or _polygon_topology_signature(sampled_geometry) != topology
            or not _geometry_within_hausdorff_budget(
                ideal_cut_geometry,
                sampled_geometry,
                exact_budget_pts,
                first_envelope=ideal_envelope,
            )
        ):
            continue
        return sampled_geometry, all_paths, smoothing_rms_mm

    # Contour có góc thật/đoạn thẳng dài không phù hợp với spline C2 toàn vòng.
    # Fit thích nghi sẽ khóa riêng các góc đó, còn các chuỗi trơn vẫn là cubic G1;
    # mọi kết quả tiếp tục phải qua đúng hành lang 0,12 mm phía trên.
    min_x, min_y, max_x, max_y = ideal_cut_geometry.bounds
    diagonal_mm = math.hypot(max_x - min_x, max_y - min_y) / max(
        mm_to_pts,
        1e-9,
    )
    size_scale = min(
        _ALPHA_ADAPTIVE_MAX_SCALE,
        max(
            1.0,
            math.sqrt(
                max(0.0, diagonal_mm) / _ALPHA_ADAPTIVE_REFERENCE_DIAGONAL_MM
            ),
        ),
    )
    corner_window_pts = _ALPHA_CORNER_WINDOW_MM * size_scale * mm_to_pts
    corner_separation_pts = (
        _ALPHA_CORNER_MIN_SEPARATION_MM * size_scale * mm_to_pts
    )
    discontinuity_window_pts = max(
        corner_window_pts * 1.5,
        1.0 * mm_to_pts,
    )
    for tolerance_mm in (0.12, 0.10, 0.08, 0.06, 0.04):
        for minimum_turn_degrees in (24.0, 18.0):
            all_paths = []
            sampled_parts = []
            try:
                for part in source_parts:
                    rings = [part.exterior, *part.interiors]
                    fitted_rings = [
                        fit_closed_cubic_beziers_adaptive(
                            ring.coords,
                            tolerance_mm * mm_to_pts,
                            corner_window=corner_window_pts,
                            minimum_turn_degrees=minimum_turn_degrees,
                            minimum_corner_separation=corner_separation_pts,
                            enforce_monotonic=True,
                            validate_corner_persistence=True,
                            smooth_raster_tangents=True,
                            reference_coords=ring.coords,
                            corner_discontinuity_window=(
                                discontinuity_window_pts
                            ),
                        )
                        for ring in rings
                    ]
                    if any(not path for path in fitted_rings):
                        raise ValueError("Không fit được Bézier khóa góc")
                    sampled_rings = [
                        sample_bezier_segments(
                            path,
                            samples_per_segment=_ROUND_PATH_GUARD_SAMPLES,
                        )
                        for path in fitted_rings
                    ]
                    sampled_parts.append(
                        Polygon(sampled_rings[0], sampled_rings[1:])
                    )
                    all_paths.extend(fitted_rings)
            except (ArithmeticError, RecursionError, TypeError, ValueError):
                continue
            sampled_geometry = (
                MultiPolygon(sampled_parts) if return_multi else sampled_parts[0]
            )
            if (
                sampled_geometry.is_empty
                or not sampled_geometry.is_valid
                or _polygon_topology_signature(sampled_geometry) != topology
                or not _geometry_within_hausdorff_budget(
                    ideal_cut_geometry,
                    sampled_geometry,
                    exact_budget_pts,
                    first_envelope=ideal_envelope,
                )
            ):
                continue
            return sampled_geometry, all_paths, tolerance_mm
    return None


def _fit_alpha_bezier_paths_core(
    alpha_geometry,
    ideal_cut_geometry,
    *,
    total_offset_pts: float,
    mm_to_pts: float,
    corner_policy: str = "legacy",
    source_pixel_mm: float | None = None,
    _use_adaptive_limits: bool | None = None,
    _enforce_monotonic: bool = True,
    _use_multiscale_geometry: bool = True,
    allow_high_resolution_fairing: bool = False,
    smoothness_scale: float = 1.0,
    fidelity_budget_scale: float = 1.0,
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
    use_adaptive_corners = corner_policy == "adaptive"
    use_adaptive_limits = (
        use_adaptive_corners
        if _use_adaptive_limits is None
        else bool(_use_adaptive_limits)
    )
    if use_adaptive_limits:
        max_hausdorff_mm, corner_window_mm, corner_separation_mm = (
            _alpha_adaptive_fit_profile(
                ideal_cut_geometry,
                mm_to_pts=mm_to_pts,
                source_pixel_mm=source_pixel_mm,
            )
        )
    else:
        max_hausdorff_mm = _ALPHA_FIT_MAX_HAUSDORFF_MM
        corner_window_mm = _ALPHA_CORNER_WINDOW_MM
        corner_separation_mm = _ALPHA_CORNER_MIN_SEPARATION_MM
    max_hausdorff_mm = min(
        _CUTLINE_TUNING_MAX_HAUSDORFF_MM,
        max(0.04, max_hausdorff_mm * float(fidelity_budget_scale)),
    )
    remaining_budget_pts = max(
        0.01,
        max_hausdorff_mm - ALPHA_CONTOUR_SIMPLIFY_MM,
    ) * mm_to_pts
    uncertainty_limit_pts = (
        max_hausdorff_mm + ALPHA_CONTOUR_SIMPLIFY_MM
    ) * mm_to_pts
    exact_budget_pts = max_hausdorff_mm * mm_to_pts
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

    min_x, min_y, max_x, max_y = ideal_cut_geometry.bounds
    diagonal_mm = math.hypot(max_x - min_x, max_y - min_y) / max(
        mm_to_pts,
        1e-9,
    )

    def prefer_machine_motion(*results):
        candidates = [result for result in results if result is not None]
        if not candidates:
            return None
        return min(
            candidates,
            key=lambda result: _alpha_candidate_motion_rank(
                result[1],
                mm_to_pts=mm_to_pts,
                diagonal_mm=diagonal_mm,
                can_protect_sparse_cusps=True,
            ),
        )

    if (
        use_adaptive_corners
        and _use_multiscale_geometry
        and (safe_envelope is not None or allow_high_resolution_fairing)
    ):
        # QUALITY/PERF (audit 2026-08-08 §UNIFIED.ALPHA2): cả đường dao lùi lẫn
        # đường ``original`` từ mask đã chốt phải được so với candidate C2. Trước
        # đây nhánh này chỉ chạy khi có safe-envelope âm, nên offset 0 luôn rơi vào
        # fitter khóa góc và sinh nhiều khớp gãy dù periodic spline đã qua guard.
        inset_result = None
        if safe_envelope is not None:
            inset_result = _fit_alpha_inset_anchor_paths(
                alpha_geometry,
                ideal_cut_geometry,
                total_offset_pts=total_offset_pts,
                mm_to_pts=mm_to_pts,
                max_hausdorff_mm=max_hausdorff_mm,
                corner_window_mm=corner_window_mm,
                corner_separation_mm=corner_separation_mm,
                use_multiscale_geometry=True,
            )
        simplified_result = _fit_alpha_simplified_anchor_paths(
            alpha_geometry,
            ideal_cut_geometry,
            total_offset_pts=total_offset_pts,
            mm_to_pts=mm_to_pts,
            max_hausdorff_mm=max_hausdorff_mm,
            corner_window_mm=corner_window_mm,
            corner_separation_mm=corner_separation_mm,
            source_pixel_mm=source_pixel_mm,
            allow_high_resolution_fairing=allow_high_resolution_fairing,
            smoothness_scale=smoothness_scale,
        )
        # QUALITY (audit 2026-08-08 §AI-MOTION.3): 192 segment từng là ngưỡng
        # trả sớm, khiến candidate ít node nhưng có khớp gãy thắng candidate G1.
        # Số node không còn quyền bỏ qua bước so chuyển động; cả ba nhánh phải
        # vào cùng bộ xếp hạng sau khi đã qua guard hình học.
        compatible_result = _fit_alpha_bezier_paths_core(
            alpha_geometry,
            ideal_cut_geometry,
            total_offset_pts=total_offset_pts,
            mm_to_pts=mm_to_pts,
            corner_policy=corner_policy,
            source_pixel_mm=source_pixel_mm,
            _use_adaptive_limits=use_adaptive_limits,
            _enforce_monotonic=True,
            _use_multiscale_geometry=False,
            allow_high_resolution_fairing=allow_high_resolution_fairing,
            smoothness_scale=smoothness_scale,
            fidelity_budget_scale=fidelity_budget_scale,
        )
        return prefer_machine_motion(
            inset_result,
            simplified_result,
            compatible_result,
        )

    def fit_ring(coords, tolerance_mm):
        if use_adaptive_corners:
            # QUALITY (audit 2026-08-05 §AI2.CUT1): đo góc trên cửa sổ mm để
            # bỏ nhiễu bậc pixel, rồi khóa đỉnh lồi/lõm trước khi fit từng span.
            return fit_closed_cubic_beziers_adaptive(
                coords,
                tolerance_mm * mm_to_pts,
                corner_window=corner_window_mm * mm_to_pts,
                minimum_turn_degrees=_ALPHA_CORNER_MIN_TURN_DEGREES,
                minimum_corner_separation=corner_separation_mm * mm_to_pts,
                enforce_monotonic=_enforce_monotonic,
                validate_corner_persistence=_use_multiscale_geometry,
                smooth_raster_tangents=_use_multiscale_geometry,
            )
        return fit_closed_cubic_beziers(
            coords,
            tolerance_mm * mm_to_pts,
            enforce_monotonic=_enforce_monotonic,
        )

    fit_tolerances = (
        (
            max_hausdorff_mm,
            max_hausdorff_mm * 0.85,
            max_hausdorff_mm * 0.67,
            max(0.08, max_hausdorff_mm * 0.50),
        )
        if use_adaptive_limits
        else _ALPHA_FIT_TOLERANCES_MM
    )
    for tolerance_mm in fit_tolerances:
        all_paths = []
        sampled_parts = []
        try:
            for part in source_parts:
                exterior_segments = fit_ring(
                    list(part.exterior.coords), tolerance_mm
                )
                interior_segments = [
                    fit_ring(list(interior.coords), tolerance_mm)
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
        if (
            comparison_nodes > 0
            and segment_count >= comparison_nodes * 0.85
            and not (use_adaptive_corners and segment_count <= 32)
        ):
            continue
        if (
            use_adaptive_corners
            and _use_multiscale_geometry
            and segment_count > _ALPHA_MULTISCALE_DENSE_COMPARE_SEGMENTS
        ):
            # QUALITY (audit 2026-08-05 §AI2.CUT2): tiếp tuyến đa tỉ lệ giúp mạnh
            # ở span cong lớn, nhưng contour pha nhiều góc ngắn đôi khi hợp với fitter
            # cũ hơn. Chỉ trả đường mới khi không dày node hơn candidate tương thích.
            compatible_result = _fit_alpha_bezier_paths_core(
                alpha_geometry,
                ideal_cut_geometry,
                total_offset_pts=total_offset_pts,
                mm_to_pts=mm_to_pts,
                corner_policy=corner_policy,
                source_pixel_mm=source_pixel_mm,
                _use_adaptive_limits=use_adaptive_limits,
                _enforce_monotonic=True,
                _use_multiscale_geometry=False,
                allow_high_resolution_fairing=allow_high_resolution_fairing,
                smoothness_scale=smoothness_scale,
                fidelity_budget_scale=fidelity_budget_scale,
            )
            inset_result = _fit_alpha_inset_anchor_paths(
                alpha_geometry,
                ideal_cut_geometry,
                total_offset_pts=total_offset_pts,
                mm_to_pts=mm_to_pts,
                max_hausdorff_mm=max_hausdorff_mm,
                corner_window_mm=corner_window_mm,
                corner_separation_mm=corner_separation_mm,
                use_multiscale_geometry=True,
            )
            preferred = prefer_machine_motion(
                (sampled_geometry, all_paths, tolerance_mm),
                compatible_result,
                inset_result,
            )
            if preferred is not None:
                return preferred
        return sampled_geometry, all_paths, tolerance_mm
    if _enforce_monotonic:
        return _fit_alpha_bezier_paths_core(
            alpha_geometry,
            ideal_cut_geometry,
            total_offset_pts=total_offset_pts,
            mm_to_pts=mm_to_pts,
            corner_policy=corner_policy,
            source_pixel_mm=source_pixel_mm,
            _use_adaptive_limits=use_adaptive_limits,
            _enforce_monotonic=False,
            _use_multiscale_geometry=_use_multiscale_geometry,
            allow_high_resolution_fairing=allow_high_resolution_fairing,
            smoothness_scale=smoothness_scale,
            fidelity_budget_scale=fidelity_budget_scale,
        )
    if use_adaptive_corners:
        if _use_multiscale_geometry:
            compatible_result = _fit_alpha_bezier_paths_core(
                alpha_geometry,
                ideal_cut_geometry,
                total_offset_pts=total_offset_pts,
                mm_to_pts=mm_to_pts,
                corner_policy=corner_policy,
                source_pixel_mm=source_pixel_mm,
                _use_adaptive_limits=use_adaptive_limits,
                _enforce_monotonic=True,
                _use_multiscale_geometry=False,
                allow_high_resolution_fairing=allow_high_resolution_fairing,
                smoothness_scale=smoothness_scale,
                fidelity_budget_scale=fidelity_budget_scale,
            )
            inset_result = _fit_alpha_inset_anchor_paths(
                alpha_geometry,
                ideal_cut_geometry,
                total_offset_pts=total_offset_pts,
                mm_to_pts=mm_to_pts,
                max_hausdorff_mm=max_hausdorff_mm,
                corner_window_mm=corner_window_mm,
                corner_separation_mm=corner_separation_mm,
                use_multiscale_geometry=True,
            )
            preferred = prefer_machine_motion(compatible_result, inset_result)
            if preferred is not None:
                return preferred
        # QUALITY (audit 2026-08-05 §AI2.CUT1): một contour quá gợn có thể làm
        # các span khóa góc tự cắt nhau dù bộ fit toàn ring vẫn qua đủ guard.
        # Thử bộ fit cũ trước khi rơi về Catmull một-cubic-mỗi-node; không nới
        # topology, Hausdorff hay safe-envelope.
        legacy_result = _fit_alpha_bezier_paths_core(
            alpha_geometry,
            ideal_cut_geometry,
            total_offset_pts=total_offset_pts,
            mm_to_pts=mm_to_pts,
            corner_policy="legacy",
            source_pixel_mm=source_pixel_mm,
            _use_adaptive_limits=True,
            _enforce_monotonic=True,
            _use_multiscale_geometry=False,
            allow_high_resolution_fairing=allow_high_resolution_fairing,
            smoothness_scale=smoothness_scale,
            fidelity_budget_scale=fidelity_budget_scale,
        )
        if legacy_result is not None:
            return legacy_result
        return _fit_alpha_inset_anchor_paths(
            alpha_geometry,
            ideal_cut_geometry,
            total_offset_pts=total_offset_pts,
            mm_to_pts=mm_to_pts,
            max_hausdorff_mm=max_hausdorff_mm,
            corner_window_mm=corner_window_mm,
            corner_separation_mm=corner_separation_mm,
            use_multiscale_geometry=False,
        )
    return None


def _alpha_polygon_parts(geometry):
    if isinstance(geometry, Polygon):
        return [geometry], False
    if isinstance(geometry, MultiPolygon):
        return list(geometry.geoms), True
    return [], False


def _sampled_geometry_from_alpha_paths_like(reference_geometry, paths):
    """Dựng lại Polygon từ các ring Bézier theo đúng thứ tự của geometry gốc."""
    reference_parts, return_multi = _alpha_polygon_parts(reference_geometry)
    if not reference_parts:
        return None
    cursor = 0
    sampled_parts = []
    try:
        for part in reference_parts:
            ring_count = 1 + len(part.interiors)
            ring_paths = paths[cursor:cursor + ring_count]
            if len(ring_paths) != ring_count:
                return None
            sampled_rings = [
                sample_bezier_segments(
                    ring,
                    samples_per_segment=max(16, _ALPHA_FIT_SAMPLES),
                )
                for ring in ring_paths
            ]
            if any(len(ring) < 4 for ring in sampled_rings):
                return None
            sampled_parts.append(Polygon(sampled_rings[0], sampled_rings[1:]))
            cursor += ring_count
    except (ArithmeticError, TypeError, ValueError):
        return None
    if cursor != len(paths):
        return None
    return MultiPolygon(sampled_parts) if return_multi else sampled_parts[0]


def _scale_alpha_bezier_handles(paths, scale: float):
    scaled_paths = []
    for ring in paths:
        scaled_ring = []
        for p0, control1, control2, p3 in ring:
            scaled_ring.append((
                (float(p0[0]), float(p0[1])),
                (
                    float(p0[0]) + (float(control1[0]) - float(p0[0])) * scale,
                    float(p0[1]) + (float(control1[1]) - float(p0[1])) * scale,
                ),
                (
                    float(p3[0]) + (float(control2[0]) - float(p3[0])) * scale,
                    float(p3[1]) + (float(control2[1]) - float(p3[1])) * scale,
                ),
                (float(p3[0]), float(p3[1])),
            ))
        scaled_paths.append(scaled_ring)
    return scaled_paths


def _retension_alpha_fit_result(
    fitted_result,
    *,
    ideal_cut_geometry,
    alpha_geometry,
    total_offset_pts: float,
    mm_to_pts: float,
    curve_tension: float | int | None,
):
    """Đổi sức căng mà vẫn khóa topology, G1 và sai lệch so với candidate an toàn."""
    if fitted_result is None:
        return None
    sampled_geometry, paths, tolerance_mm = fitted_result
    requested_scale = _cutline_tension_handle_scale(curve_tension)
    if abs(requested_scale - 1.0) <= 1e-9:
        return fitted_result

    minimum_gap_pts = min(
        _ALPHA_SAFE_MIN_GAP_MM * mm_to_pts,
        max(0.0, -float(total_offset_pts)),
    )
    safe_envelope = (
        alpha_geometry.buffer(-minimum_gap_pts, join_style=1)
        if minimum_gap_pts > 0
        else None
    )
    topology = _polygon_topology_signature(ideal_cut_geometry)
    scale = requested_scale
    # Nếu cực trị người dùng vượt guard, tiến dần về 1 thay vì trả đường lỗi.
    for _attempt in range(8):
        scaled_paths = _scale_alpha_bezier_handles(paths, scale)
        scaled_geometry = _sampled_geometry_from_alpha_paths_like(
            ideal_cut_geometry,
            scaled_paths,
        )
        extra_budget_pts = (
            _CUTLINE_TENSION_EXTRA_BUDGET_MM
            * abs(scale - 1.0)
            / max(
                abs(_CUTLINE_TENSION_HANDLE_MAX - 1.0),
                abs(_CUTLINE_TENSION_HANDLE_MIN - 1.0),
            )
            * mm_to_pts
        )
        if (
            scaled_geometry is not None
            and not scaled_geometry.is_empty
            and scaled_geometry.is_valid
            and _polygon_topology_signature(scaled_geometry) == topology
            and _geometry_within_hausdorff_budget(
                sampled_geometry,
                scaled_geometry,
                max(0.01 * mm_to_pts, extra_budget_pts),
            )
            and (
                safe_envelope is None
                or (
                    not safe_envelope.is_empty
                    and safe_envelope.is_valid
                    and safe_envelope.covers(scaled_geometry)
                )
            )
        ):
            return scaled_geometry, scaled_paths, tolerance_mm
        scale = 1.0 + (scale - 1.0) * 0.5
    return fitted_result


def _fit_alpha_bezier_paths(
    alpha_geometry,
    ideal_cut_geometry,
    *,
    total_offset_pts: float,
    mm_to_pts: float,
    corner_policy: str = "legacy",
    source_pixel_mm: float | None = None,
    _use_adaptive_limits: bool | None = None,
    _enforce_monotonic: bool = True,
    _use_multiscale_geometry: bool = True,
    allow_high_resolution_fairing: bool = False,
    cutline_smoothness: float | int | None = _CUTLINE_TUNING_DEFAULT,
    cutline_fidelity: float | int | None = _CUTLINE_TUNING_DEFAULT,
    curve_tension: float | int | None = _CUTLINE_TUNING_DEFAULT,
):
    """Fit CutContour có tuning; giá trị 50/50/50 tương thích artifact cũ."""
    fitted = _fit_alpha_bezier_paths_core(
        alpha_geometry,
        ideal_cut_geometry,
        total_offset_pts=total_offset_pts,
        mm_to_pts=mm_to_pts,
        corner_policy=corner_policy,
        source_pixel_mm=source_pixel_mm,
        _use_adaptive_limits=_use_adaptive_limits,
        _enforce_monotonic=_enforce_monotonic,
        _use_multiscale_geometry=_use_multiscale_geometry,
        allow_high_resolution_fairing=allow_high_resolution_fairing,
        smoothness_scale=_cutline_smoothness_scale(cutline_smoothness),
        fidelity_budget_scale=_cutline_fidelity_budget_scale(cutline_fidelity),
    )
    return _retension_alpha_fit_result(
        fitted,
        ideal_cut_geometry=ideal_cut_geometry,
        alpha_geometry=alpha_geometry,
        total_offset_pts=total_offset_pts,
        mm_to_pts=mm_to_pts,
        # QUALITY (audit 2026-08-10 §CUTROUND.1): co tay nắm toàn cục làm tăng
        # curvature jump nhưng gần như không đổi quỹ đạo. Giữ field để tương thích
        # API cũ, còn fitter tự dùng tay nắm C2/G1 đã qua bộ xếp hạng chuyển động.
        curve_tension=_CUTLINE_TUNING_DEFAULT,
    )


def _linear_bezier_ring(coords):
    points = list(coords)
    if len(points) < 4:
        return []
    if points[0] != points[-1]:
        points.append(points[0])
    segments = []
    for start, end in zip(points, points[1:]):
        dx = float(end[0]) - float(start[0])
        dy = float(end[1]) - float(start[1])
        segments.append((
            (float(start[0]), float(start[1])),
            (float(start[0]) + dx / 3.0, float(start[1]) + dy / 3.0),
            (float(start[0]) + dx * 2.0 / 3.0, float(start[1]) + dy * 2.0 / 3.0),
            (float(end[0]), float(end[1])),
        ))
    return segments


def _paths_for_alpha_geometry(geometry, *, tension: float | None = None):
    parts, _return_multi = _alpha_polygon_parts(geometry)
    paths = []
    for part in parts:
        for ring in [part.exterior, *part.interiors]:
            coords = list(ring.coords)
            paths.append(
                _catmull_rom_bezier_segments(coords, tension=tension)
                if tension is not None
                else _linear_bezier_ring(coords)
            )
    return paths


def _group_alpha_paths_like(reference_geometry, paths):
    def normalize_ring(ring):
        """Khóa hợp đồng path về số Python để cache/API không mang ndarray."""
        normalized = []
        try:
            for segment in ring:
                if len(segment) != 4:
                    return None
                points = tuple(
                    (float(point[0]), float(point[1]))
                    for point in segment
                )
                if not all(
                    math.isfinite(value)
                    for point in points
                    for value in point
                ):
                    return None
                normalized.append(points)
        except (IndexError, TypeError, ValueError, OverflowError):
            return None
        return normalized

    parts, _return_multi = _alpha_polygon_parts(reference_geometry)
    cursor = 0
    groups = []
    for part in parts:
        ring_count = 1 + len(part.interiors)
        ring_paths = paths[cursor:cursor + ring_count]
        if len(ring_paths) != ring_count:
            return []
        normalized_rings = [normalize_ring(ring) for ring in ring_paths]
        if any(ring is None or not ring for ring in normalized_rings):
            return []
        groups.append({
            "exterior": normalized_rings[0],
            "interiors": normalized_rings[1:],
        })
        cursor += ring_count
    return groups if cursor == len(paths) else []


def _alpha_override_geometry(payload):
    """Khôi phục geometry + ring Bézier từ payload thuần số dùng qua process pool."""
    if not isinstance(payload, dict):
        return None
    raw_groups = payload.get("path_groups")
    if not isinstance(raw_groups, list) or not raw_groups:
        return None
    paths = []
    polygons = []
    try:
        for group in raw_groups:
            exterior = group["exterior"]
            interiors = list(group.get("interiors") or [])
            sampled = [
                sample_bezier_segments(
                    ring,
                    samples_per_segment=max(16, _ALPHA_FIT_SAMPLES),
                )
                for ring in [exterior, *interiors]
            ]
            polygon = Polygon(sampled[0], sampled[1:])
            if polygon.is_empty or not polygon.is_valid:
                return None
            polygons.append(polygon)
            paths.extend([exterior, *interiors])
    except (ArithmeticError, KeyError, TypeError, ValueError):
        return None
    geometry = polygons[0] if len(polygons) == 1 else MultiPolygon(polygons)
    if geometry.is_empty or not geometry.is_valid:
        return None
    return geometry, paths


def _approved_contour_override(payload, target_shape):
    """Khôi phục đồng thời Alpha và Bézier đã duyệt cho đúng một trang nguồn.

    QUALITY (feedback 2026-08-11 §LEGACY-AI.2): mask và path là một artifact
    nguyên tử. Không nhận riêng một nửa vì như vậy đường bế có thể đúng nhưng
    footprint bù xén vẫn dùng mask nền trắng cũ và tiếp tục xóa sai artwork.
    """
    if not isinstance(payload, dict):
        return None
    fitted = _alpha_override_geometry(payload)
    raw_alpha = payload.get("alpha")
    if fitted is None or raw_alpha is None:
        return None
    # QUALITY (feedback 2026-08-21 §FULLPAGE-OVERRIDE.1): `page-box` là
    # artifact hợp lệ cho ảnh phủ kín trang, vì vậy Alpha toàn 255 là có chủ
    # đích chứ không phải mask không tách được nền. Các nguồn khác vẫn phải
    # qua cổng tách nền để tránh payload cũ/stale làm mất toàn bộ trang.
    boundary_source = str(payload.get("boundary_source") or "approved").strip().lower()
    alpha = np.asarray(raw_alpha, dtype=np.uint8)
    if alpha.ndim != 2 or alpha.size == 0:
        return None
    target_height, target_width = (int(target_shape[0]), int(target_shape[1]))
    if target_height <= 0 or target_width <= 0:
        return None
    if alpha.shape != (target_height, target_width):
        interpolation = (
            cv2.INTER_AREA
            if alpha.shape[0] > target_height or alpha.shape[1] > target_width
            else cv2.INTER_LINEAR
        )
        alpha = cv2.resize(
            alpha,
            (target_width, target_height),
            interpolation=interpolation,
        )
    alpha = np.ascontiguousarray(alpha, dtype=np.uint8)
    foreground_mask = alpha >= ALPHA_CONTOUR_THRESHOLD
    if boundary_source == "page-box":
        # Chỉ chấp nhận page-box thật sự kín trang. Không nới cổng thành
        # ``ratio <= 1`` chung cho mọi nguồn, nếu không Alpha stale gần kín
        # trang sẽ vô tình được coi là artifact đã duyệt.
        if not np.all(foreground_mask):
            return None
    elif not mask_tach_duoc_nen(foreground_mask):
        return None

    try:
        source_pixel_mm = float(payload.get("source_pixel_mm"))
    except (TypeError, ValueError):
        source_pixel_mm = 0.0
    if not math.isfinite(source_pixel_mm) or source_pixel_mm <= 0.0:
        raw_dpi = payload.get("dpi")
        try:
            dpi_x, dpi_y = float(raw_dpi[0]), float(raw_dpi[1])
            source_pixel_mm = max(25.4 / dpi_x, 25.4 / dpi_y)
        except (IndexError, TypeError, ValueError, ZeroDivisionError):
            return None
    return alpha, source_pixel_mm, boundary_source, fitted


def _approved_edge_background(payload) -> tuple[tuple[int, int, int], int] | None:
    """Đọc ngữ cảnh nền scalar từ artifact approved, không mang mask lớn qua pool."""
    if not isinstance(payload, dict):
        return None
    raw_rgb = payload.get("edge_background_rgb")
    if not isinstance(raw_rgb, (list, tuple)) or len(raw_rgb) != 3:
        return None
    try:
        values = tuple(int(round(float(value))) for value in raw_rgb)
        tolerance = int(round(float(payload.get("edge_background_tolerance", 0))))
    except (TypeError, ValueError):
        return None
    if any(value < 0 or value > 255 for value in values):
        return None
    return values, min(255, max(0, tolerance))


def _alpha_live_machine_path_summary(path, *, mm_to_pts: float):
    """Đo ba rủi ro chạy dao theo lô NumPy và giữ vị trí từng khớp gãy."""
    points = np.asarray(path, dtype=np.float64)
    if (
        points.ndim != 3
        or points.shape[0] == 0
        or points.shape[1:] != (4, 2)
        or not np.all(np.isfinite(points))
    ):
        return None

    epsilon = 1e-12
    following_starts = np.roll(points[:, 0, :], -1, axis=0)
    endpoint_gaps = np.linalg.norm(points[:, 3, :] - following_starts, axis=1)
    endpoint_gaps_mm = endpoint_gaps / mm_to_pts

    def normalized_tangents(candidates: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        lengths = np.linalg.norm(candidates, axis=2)
        valid = lengths > epsilon
        has_value = np.any(valid, axis=1)
        first_valid = np.argmax(valid, axis=1)
        selected = candidates[np.arange(len(candidates)), first_valid]
        selected_lengths = lengths[np.arange(len(candidates)), first_valid]
        tangents = np.zeros_like(selected)
        tangents[has_value] = (
            selected[has_value] / selected_lengths[has_value, None]
        )
        return tangents, has_value

    end_tangents, valid_end = normalized_tangents(np.stack((
        points[:, 3, :] - points[:, 2, :],
        points[:, 3, :] - points[:, 1, :],
        points[:, 3, :] - points[:, 0, :],
    ), axis=1))
    start_tangents, valid_start = normalized_tangents(np.stack((
        points[:, 1, :] - points[:, 0, :],
        points[:, 2, :] - points[:, 0, :],
        points[:, 3, :] - points[:, 0, :],
    ), axis=1))
    following_tangents = np.roll(start_tangents, -1, axis=0)
    valid_joins = valid_end & np.roll(valid_start, -1)
    angles = np.zeros(len(points), dtype=np.float64)
    if np.any(valid_joins):
        cosines = np.sum(end_tangents * following_tangents, axis=1)
        angles[valid_joins] = np.degrees(np.arccos(np.clip(
            cosines[valid_joins],
            -1.0,
            1.0,
        )))

    sample_t = np.arange(1, 33, dtype=np.float64) / 32.0
    sample_u = 1.0 - sample_t
    samples = (
        sample_u[None, :, None] ** 3 * points[:, 0, None, :]
        + 3.0 * sample_u[None, :, None] ** 2 * sample_t[None, :, None]
        * points[:, 1, None, :]
        + 3.0 * sample_u[None, :, None] * sample_t[None, :, None] ** 2
        * points[:, 2, None, :]
        + sample_t[None, :, None] ** 3 * points[:, 3, None, :]
    )
    previous = np.concatenate((points[:, 0, None, :], samples[:, :-1, :]), axis=1)
    lengths_mm = np.linalg.norm(samples - previous, axis=2).sum(axis=1) / mm_to_pts
    sharp_join_indices = np.flatnonzero(
        valid_joins & (angles > _CUTLINE_FINAL_SMOOTH_JOIN_DEGREES)
    )
    trajectory = _alpha_trajectory_cusp_summary(
        samples.reshape(-1, 2),
        mm_to_pts=mm_to_pts,
    )
    return {
        "segment_count": int(len(points)),
        "short_segment_count": int(np.count_nonzero(
            lengths_mm < _CUTLINE_FINAL_SHORT_SEGMENT_MM
        )),
        "disconnected_join_count": int(np.count_nonzero(
            endpoint_gaps_mm > epsilon
        )),
        "minimum_segment_length_mm": float(np.min(lengths_mm)),
        "maximum_join_angle_degrees": (
            float(np.max(angles[valid_joins])) if np.any(valid_joins) else None
        ),
        "sharp_join_points": [
            (float(points[index, 3, 0]), float(points[index, 3, 1]))
            for index in sharp_join_indices
        ],
        **trajectory,
    }


def _collapse_cusp_runs(
    indices: np.ndarray,
    turns: np.ndarray,
    count: int,
) -> np.ndarray:
    """Gom các mẫu liền nhau vượt ngưỡng thành một cusp, giữ mẫu gắt nhất."""
    if indices.size == 0:
        return indices
    breaks = np.flatnonzero(np.diff(indices) > 1) + 1
    groups = np.split(indices, breaks)
    # Polyline đóng: dải cuối và dải đầu có thể là cùng một cusp bắc qua chỗ nối.
    if (
        len(groups) > 1
        and int(groups[0][0]) == 0
        and int(groups[-1][-1]) == count - 1
    ):
        groups[0] = np.concatenate((groups[-1], groups[0]))
        groups.pop()
    return np.asarray(
        [int(group[int(np.argmax(turns[group]))]) for group in groups],
        dtype=np.intp,
    )


def _alpha_trajectory_cusp_summary(
    trajectory: np.ndarray,
    *,
    mm_to_pts: float,
) -> dict[str, object]:
    """Đo cusp trên quỹ đạo ĐƯỢC VẼ RA, không chỉ tại anchor (§CUTHOOK.1).

    `trajectory` là polyline đóng đã lấy mẫu dày từ chuỗi cubic. Trả về số đo trung
    lập; việc quyết định cusp nào hợp lệ do tầng chất lượng đối chiếu reference.
    """
    empty: dict[str, object] = {
        "maximum_trajectory_turn_degrees": None,
        "minimum_wedge_width_mm": None,
        "trajectory_cusp_points": [],
    }
    count = len(trajectory)
    if count < 8:
        return empty

    edges = np.roll(trajectory, -1, axis=0) - trajectory
    edge_lengths = np.linalg.norm(edges, axis=1)
    alive = edge_lengths > 1e-12
    if np.count_nonzero(alive) < 4:
        return empty

    # Góc quay tại đỉnh i nằm giữa cạnh (i-1 → i) và cạnh (i → i+1).
    incoming = np.roll(edges, 1, axis=0)
    incoming_lengths = np.roll(edge_lengths, 1)
    usable = alive & (incoming_lengths > 1e-12)
    turns = np.zeros(count, dtype=np.float64)
    if np.any(usable):
        cosines = np.sum(incoming[usable] * edges[usable], axis=1) / (
            incoming_lengths[usable] * edge_lengths[usable]
        )
        turns[usable] = np.degrees(np.arccos(np.clip(cosines, -1.0, 1.0)))

    raw_indices = np.flatnonzero(usable & (turns > _CUTLINE_TRAJECTORY_CUSP_DEGREES))
    maximum_turn = float(np.max(turns[usable])) if np.any(usable) else None
    # Một cái móc thường trải 1–3 mẫu liền nhau. Gom mỗi dải liền thành MỘT cusp,
    # lấy đỉnh gắt nhất làm đại diện: nếu không gom thì đếm sai (đo được 101 "cusp"
    # cho cùng một vùng) và bộ so khớp góc thật phải chạy trên số điểm gấp nhiều lần.
    cusp_indices = _collapse_cusp_runs(raw_indices, turns, count)
    if cusp_indices.size == 0:
        return {
            "maximum_trajectory_turn_degrees": maximum_turn,
            "minimum_wedge_width_mm": None,
            "trajectory_cusp_points": [],
        }

    # Bề rộng nêm: dây cung giữa hai điểm cách đỉnh đúng `span` theo chiều dài cung.
    # Đi thẳng cho ~2·span, góc 90° cho ~1,41·span, còn móc quặt ngược cho ~0.
    span_pts = _CUTLINE_WEDGE_PROBE_SPAN_MM * mm_to_pts
    cumulative = np.concatenate(([0.0], np.cumsum(edge_lengths)))
    total_length = float(cumulative[-1])
    wedge_widths: list[float] = []
    if total_length > 2.0 * span_pts:
        positions = cumulative[cusp_indices]
        before = np.searchsorted(
            cumulative[:-1],
            np.mod(positions - span_pts, total_length),
            side="right",
        ) - 1
        after = np.searchsorted(
            cumulative[:-1],
            np.mod(positions + span_pts, total_length),
            side="right",
        ) - 1
        before = np.clip(before, 0, count - 1)
        after = np.clip(after, 0, count - 1)
        wedge_widths = (
            np.linalg.norm(trajectory[after] - trajectory[before], axis=1) / mm_to_pts
        ).tolist()

    return {
        "maximum_trajectory_turn_degrees": maximum_turn,
        "minimum_wedge_width_mm": (
            float(min(wedge_widths)) if wedge_widths else None
        ),
        "trajectory_cusp_points": [
            (float(trajectory[index, 0]), float(trajectory[index, 1]))
            for index in cusp_indices
        ],
    }


def _alpha_live_machine_path_is_safe(
    path,
    *,
    mm_to_pts: float,
) -> bool:
    """Kiểm nhanh đường C2/G1; góc thật chỉ được miễn tại cổng cuối có reference.

    PERF (audit 2026-08-10 §CUTLINE.LIVE6): ``analyze_machine_path`` còn đo
    curvature, percentile và nhiều số phục vụ báo cáo chất lượng. Live fitter chỉ
    đọc đường hở, góc nối và đoạn <0,25 mm; tính theo lô để slider không bị khựng.
    """
    summary = _alpha_live_machine_path_summary(path, mm_to_pts=mm_to_pts)
    return bool(
        summary is not None
        and summary["disconnected_join_count"] == 0
        and not summary["sharp_join_points"]
        and summary["short_segment_count"] == 0
    )


def _alpha_reference_corner_points(
    reference_geometry,
    *,
    mm_to_pts: float,
    source_pixel_mm: float | None,
):
    """Tìm góc thật bền qua cả reference gốc và reference đã lọc theo mm.

    QUALITY (audit 2026-08-10 §CUTSMOOTH.2): giao của hai phép dò loại bậc raster
    cục bộ nhưng giữ góc sao/notch. Cửa sổ theo pixel nguồn nên cùng artwork đổi
    DPI không biến đường cong thành hàng trăm góc giả.
    """
    pixel_mm = 0.0
    try:
        candidate = float(source_pixel_mm or 0.0)
        if math.isfinite(candidate) and candidate > 0:
            pixel_mm = candidate
    except (TypeError, ValueError):
        pass
    window_mm = max(
        _CUTLINE_TRUE_CORNER_BASE_WINDOW_MM,
        pixel_mm * _CUTLINE_TRUE_CORNER_PIXEL_WINDOW,
    )
    support_mm = max(
        _CUTLINE_TRUE_CORNER_BASE_WINDOW_MM,
        pixel_mm * _CUTLINE_TRUE_CORNER_PIXEL_SUPPORT,
    )
    window_pts = window_mm * mm_to_pts
    support_pts = support_mm * mm_to_pts
    simplified = reference_geometry.simplify(
        window_pts,
        preserve_topology=True,
    )
    simplified_corners = []
    if isinstance(simplified, (Polygon, MultiPolygon)):
        for ring in _polygon_rings(simplified):
            points = [
                (float(point[0]), float(point[1]))
                for point in list(ring.coords)[:-1]
            ]
            for index, point in enumerate(points):
                previous = points[index - 1]
                following = points[(index + 1) % len(points)]
                incoming = (point[0] - previous[0], point[1] - previous[1])
                outgoing = (following[0] - point[0], following[1] - point[1])
                incoming_length = math.hypot(*incoming)
                outgoing_length = math.hypot(*outgoing)
                if incoming_length < support_pts or outgoing_length < support_pts:
                    continue
                cosine = (
                    incoming[0] * outgoing[0] + incoming[1] * outgoing[1]
                ) / (incoming_length * outgoing_length)
                turn_degrees = math.degrees(math.acos(max(-1.0, min(1.0, cosine))))
                if turn_degrees >= _CUTLINE_TRUE_CORNER_TURN_DEGREES:
                    simplified_corners.append(point)
    if not simplified_corners:
        return [], window_pts

    raw_corners = []
    for ring in _polygon_rings(reference_geometry):
        points = [
            (float(point[0]), float(point[1]))
            for point in list(ring.coords)[:-1]
        ]
        try:
            corner_indices = _closed_ring_discontinuity_corner_indices(
                points,
                probe_window=window_pts,
                minimum_turn_degrees=_CUTLINE_TRUE_CORNER_TURN_DEGREES,
            )
        except (ArithmeticError, TypeError, ValueError):
            continue
        raw_corners.extend(points[index] for index in corner_indices)

    window_squared = window_pts * window_pts
    protected = [
        corner
        for corner in raw_corners
        if any(
            (corner[0] - simplified_corner[0]) ** 2
            + (corner[1] - simplified_corner[1]) ** 2
            <= window_squared
            for simplified_corner in simplified_corners
        )
    ]
    return protected, window_pts


def _match_protected_corner_count(join_points, corner_points, radius_pts: float) -> int:
    """Ghép một-một khớp dao với góc reference gần nhất bằng lưới không gian."""
    if not join_points or not corner_points or radius_pts <= 0:
        return 0
    cell_size = radius_pts
    corner_cells: dict[tuple[int, int], list[int]] = {}
    for corner_index, corner in enumerate(corner_points):
        cell = (
            math.floor(float(corner[0]) / cell_size),
            math.floor(float(corner[1]) / cell_size),
        )
        corner_cells.setdefault(cell, []).append(corner_index)

    radius_squared = radius_pts * radius_pts
    candidate_pairs = []
    for join_index, join in enumerate(join_points):
        cell_x = math.floor(float(join[0]) / cell_size)
        cell_y = math.floor(float(join[1]) / cell_size)
        for offset_x in (-1, 0, 1):
            for offset_y in (-1, 0, 1):
                for corner_index in corner_cells.get(
                    (cell_x + offset_x, cell_y + offset_y),
                    (),
                ):
                    corner = corner_points[corner_index]
                    distance_squared = (
                        (float(join[0]) - float(corner[0])) ** 2
                        + (float(join[1]) - float(corner[1])) ** 2
                    )
                    if distance_squared <= radius_squared:
                        candidate_pairs.append((
                            distance_squared,
                            join_index,
                            corner_index,
                        ))
    matched_joins = set()
    matched_corners = set()
    for _distance, join_index, corner_index in sorted(candidate_pairs):
        if join_index in matched_joins or corner_index in matched_corners:
            continue
        matched_joins.add(join_index)
        matched_corners.add(corner_index)
    return len(matched_joins)


def _analytic_fillet_short_line_count(paths, *, mm_to_pts: float) -> int:
    """Đếm riêng lệnh thẳng ngắn; cung fillet ngắn nhưng G1 không phải faceting.

    Ngưỡng 0,25 mm ban đầu nhằm bắt chuỗi chord đổi hướng liên tục. Một cung cubic
    giải tích duy nhất có thể ngắn hơn ngưỡng khi UI yêu cầu bán kính 0,12 mm,
    nhưng vẫn là chuyển động trơn. Đoạn thẳng ngắn vẫn bị chặn như cũ.
    """
    count = 0
    threshold_pts = _CUTLINE_FINAL_SHORT_SEGMENT_MM * mm_to_pts
    for path in paths:
        for raw_segment in path:
            try:
                p0, control1, control2, p3 = (
                    np.asarray(point, dtype=np.float64) for point in raw_segment
                )
            except (TypeError, ValueError):
                return 1
            chord = p3 - p0
            chord_length = float(np.linalg.norm(chord))
            if chord_length <= 1e-12:
                count += 1
                continue
            relative1 = control1 - p0
            relative2 = control2 - p0
            cross1 = abs(float(
                chord[0] * relative1[1] - chord[1] * relative1[0]
            )) / chord_length
            cross2 = abs(float(
                chord[0] * relative2[1] - chord[1] * relative2[0]
            )) / chord_length
            if max(cross1, cross2) <= 1e-8 and chord_length < threshold_pts:
                count += 1
    return count


def _alpha_final_cutline_quality(
    paths,
    *,
    reference_geometry,
    fitted_geometry,
    alpha_geometry,
    total_offset_pts: float,
    mm_to_pts: float,
    source_pixel_mm: float | None,
    fit_mode: str,
    corner_cache: dict[str, object] | None = None,
) -> dict[str, object]:
    """Cổng chất lượng duy nhất áp cho live, retension và mọi fallback.

    `corner_cache` là dict rỗng do caller cấp và dùng lại cho MỌI ứng viên của cùng
    một tem. Bộ dò góc thật đa thang chỉ phụ thuộc `reference_geometry` — vốn bất
    biến suốt chuỗi ứng viên — nên chạy lại cho từng ứng viên là công thừa. PERF
    (feedback 2026-08-16 §CUTHOOK.2): không cache thì một tem nhiều cusp mất 16–68 s.
    """
    summaries = [
        _alpha_live_machine_path_summary(path, mm_to_pts=mm_to_pts)
        for path in paths
    ]
    valid_summaries = [summary for summary in summaries if summary is not None]
    invalid_path_count = len(summaries) - len(valid_summaries)
    sharp_join_points = [
        point
        for summary in valid_summaries
        for point in summary["sharp_join_points"]
    ]
    # §CUTHOOK.1: cusp bên trong cubic cũng phải qua đúng bộ so khớp góc thật.
    trajectory_cusp_points = [
        point
        for summary in valid_summaries
        for point in summary.get("trajectory_cusp_points", ())
    ]
    protected_corner_count = 0
    protected_cusp_count = 0
    if sharp_join_points or trajectory_cusp_points:
        # PERF (audit 2026-08-10 §CUTSMOOTH.5): đường C2 phổ biến không có khớp
        # gãy nên không cần chạy bộ dò góc đa thang trên reference hàng nghìn điểm.
        cached = corner_cache.get("reference_corners") if corner_cache is not None else None
        if cached is None:
            cached = _alpha_reference_corner_points(
                reference_geometry,
                mm_to_pts=mm_to_pts,
                source_pixel_mm=source_pixel_mm,
            )
            if corner_cache is not None:
                corner_cache["reference_corners"] = cached
        corner_points, match_radius_pts = cached
        if sharp_join_points:
            protected_corner_count = _match_protected_corner_count(
                sharp_join_points,
                corner_points,
                match_radius_pts,
            )
        if trajectory_cusp_points:
            protected_cusp_count = _match_protected_corner_count(
                trajectory_cusp_points,
                corner_points,
                match_radius_pts,
            )
    measured_short_segment_count = sum(
        int(summary["short_segment_count"]) for summary in valid_summaries
    )
    if fit_mode == "analytic-fillet":
        short_segment_count = _analytic_fillet_short_line_count(
            paths,
            mm_to_pts=mm_to_pts,
        )
        smooth_short_arc_count = max(
            0,
            measured_short_segment_count - short_segment_count,
        )
    else:
        short_segment_count = measured_short_segment_count
        smooth_short_arc_count = 0
    disconnected_join_count = sum(
        int(summary["disconnected_join_count"]) for summary in valid_summaries
    )
    minimum_lengths = [
        float(summary["minimum_segment_length_mm"])
        for summary in valid_summaries
    ]
    maximum_angles = [
        float(summary["maximum_join_angle_degrees"])
        for summary in valid_summaries
        if summary["maximum_join_angle_degrees"] is not None
    ]
    maximum_trajectory_turns = [
        float(summary["maximum_trajectory_turn_degrees"])
        for summary in valid_summaries
        if summary.get("maximum_trajectory_turn_degrees") is not None
    ]
    minimum_wedge_widths = [
        float(summary["minimum_wedge_width_mm"])
        for summary in valid_summaries
        if summary.get("minimum_wedge_width_mm") is not None
    ]

    geometry_safe = bool(
        isinstance(fitted_geometry, (Polygon, MultiPolygon))
        and not fitted_geometry.is_empty
        and fitted_geometry.is_valid
        and _polygon_topology_signature(fitted_geometry)
        == _polygon_topology_signature(reference_geometry)
        and bool(_group_alpha_paths_like(fitted_geometry, paths))
    )
    minimum_gap_pts = min(
        _ALPHA_SAFE_MIN_GAP_MM * mm_to_pts,
        max(0.0, -float(total_offset_pts)),
    )
    if geometry_safe and minimum_gap_pts > 0:
        safe_envelope = alpha_geometry.buffer(-minimum_gap_pts, join_style=1)
        geometry_safe = bool(
            not safe_envelope.is_empty
            and safe_envelope.is_valid
            and safe_envelope.covers(fitted_geometry)
        )
    try:
        if fit_mode in {"live-bezier", "hybrid-straight-reference"}:
            # PERF (audit 2026-08-21 §CUTLINE.FAST-GUARD): live preview chỉ cần
            # cận trên để xét budget; binary search trên buffer tránh đo GEOS
            # O(n²) ở mọi frame. Candidate vượt trần vẫn rơi về phép đo chính
            # xác trong helper, nên không có đường tắt làm nới sai số.
            probe_budget_mm = min(
                1.30,
                max(0.25, float(source_pixel_mm or 0.0) * 4.50),
            )
            deviation_pts = _budgeted_hausdorff_distance(
                reference_geometry,
                fitted_geometry,
                probe_budget_mm * mm_to_pts,
            )
        else:
            deviation_pts = reference_geometry.hausdorff_distance(fitted_geometry)
        effective_deviation_mm = float(deviation_pts / mm_to_pts)
        if not math.isfinite(effective_deviation_mm):
            effective_deviation_mm = None
    except (ArithmeticError, TypeError, ValueError):
        effective_deviation_mm = None

    unprotected_join_count = len(sharp_join_points) - protected_corner_count
    machine_safe = bool(
        geometry_safe
        and invalid_path_count == 0
        and valid_summaries
        and short_segment_count == 0
        and disconnected_join_count == 0
        and unprotected_join_count == 0
    )
    return {
        "machine_safe": machine_safe,
        "segment_count": sum(
            int(summary["segment_count"]) for summary in valid_summaries
        ),
        "short_segment_count": short_segment_count,
        "smooth_short_arc_count": smooth_short_arc_count,
        "disconnected_join_count": disconnected_join_count,
        "unprotected_join_count": unprotected_join_count,
        "protected_corner_count": protected_corner_count,
        "minimum_segment_length_mm": min(minimum_lengths, default=None),
        "maximum_join_angle_degrees": max(maximum_angles, default=None),
        "effective_deviation_mm": effective_deviation_mm,
        "fit_mode": fit_mode,
        # §CUTHOOK.1 bước 1 — số đo trên quỹ đạo thật. Chưa vào `machine_safe`:
        # bước 3 (chặn xuất khi mọi ứng viên đều có gai) cần duyệt riêng.
        "trajectory_cusp_count": len(trajectory_cusp_points),
        "protected_cusp_count": protected_cusp_count,
        "unprotected_cusp_count": len(trajectory_cusp_points) - protected_cusp_count,
        "maximum_trajectory_turn_degrees": max(maximum_trajectory_turns, default=None),
        "minimum_wedge_width_mm": min(minimum_wedge_widths, default=None),
    }


def _cutline_hook_is_severe(quality: dict[str, object] | None) -> bool:
    """Trả ``True`` khi quỹ đạo có dấu hiệu fitter bẻ thành móc/gai rác.

    ``machine_safe`` chỉ kiểm tra tính kín/topology và các đoạn quá ngắn; nó
    không đủ để nhận ra một cubic tự quay ngược ở giữa đường. Hàm này cố ý
    dùng các số đo đã có trong ``quality`` để làm cổng nhỏ, fail-closed và dễ
    kiểm thử. Một cusp đơn có nêm đủ rộng vẫn được giữ cho hình sao/tai nhọn;
    chỉ khi có nhiều cusp hoặc một cusp có hình học quá hẹp/gắt mới bị chặn.
    """
    if not isinstance(quality, dict):
        return False
    try:
        cusp_count = int(quality.get("unprotected_cusp_count", 0) or 0)
    except (TypeError, ValueError):
        cusp_count = 0
    try:
        wedge = quality.get("minimum_wedge_width_mm")
        wedge_value = float(wedge) if wedge is not None else None
    except (TypeError, ValueError):
        wedge_value = None
    try:
        turn = quality.get("maximum_trajectory_turn_degrees")
        turn_value = float(turn) if turn is not None else None
    except (TypeError, ValueError):
        turn_value = None
    if cusp_count > _CUTLINE_HOOK_MAX_TOLERATED_UNPROTECTED_CUSPS:
        return True
    if wedge_value is not None and (
        not math.isfinite(wedge_value)
        or wedge_value < _CUTLINE_HOOK_MIN_SAFE_WEDGE_MM
    ):
        return True
    if turn_value is not None and (
        not math.isfinite(turn_value)
        or turn_value >= _CUTLINE_HOOK_MAX_SAFE_TURN_DEGREES
    ):
        return True
    return False


def _fit_alpha_live_tuned_paths(
    alpha_geometry,
    ideal_cut_geometry,
    *,
    total_offset_pts: float,
    mm_to_pts: float,
    source_pixel_mm: float,
    cutline_smoothness: float | int | None,
    cutline_fidelity: float | int | None,
    curve_tension: float | int | None,
):
    """Fit C2 nhanh cho slider live, với guard hình học như nhánh tự động.

    Nhánh tự động cũ thử hàng chục tổ hợp để tự chọn profile và phù hợp xử lý
    hàng loạt. Live preview đã có chủ ý người dùng nên chỉ cần một profile xác
    định từ slider, rồi giảm cường độ tối đa ba lần nếu candidate vượt guard.
    """
    source_parts, return_multi = _alpha_polygon_parts(ideal_cut_geometry)
    if not source_parts:
        return None
    fidelity = _clamp_cutline_percent(cutline_fidelity) / 100.0
    requested_smoothness = _clamp_cutline_percent(cutline_smoothness) / 100.0
    # QUALITY (audit 2026-08-10 §CUTROUND.2): nửa trái của trục Bám sát chính là
    # yêu cầu bo mượt kiểu Offset Path + Round. Nó phải tăng fairing thực, không
    # chỉ nới một envelope rồi trả lại nguyên candidate như vùng chết trước đây.
    # Không cho đầu Bám sát tắt hẳn fairing: bám răng cưa pixel không phải là
    # trung thành hình học và chỉ làm tăng lệnh dao. Mốc 50 giữ đúng profile cũ.
    smoothness = max(0.50, requested_smoothness, 1.0 - fidelity)
    pixel_mm = max(0.001, float(source_pixel_mm))
    # Ảnh 72 DPI không mang thông tin dưới 0,353 mm/pixel; khóa 0,10 mm sẽ buộc
    # spline quay lại bám răng cưa giả. Ngân sách theo pixel nguồn, còn slider
    # Bám sát co/nới trong biên 0,08–1,20 mm có hiển thị trực tiếp cho người dùng.
    source_budget_mm = max(0.12, min(1.20, pixel_mm * 3.60))
    max_deviation_mm = source_budget_mm * (1.60 - fidelity * 1.25)
    max_deviation_mm = max(0.08, min(1.20, max_deviation_mm))
    spacing_mm = max(0.08, min(0.32, pixel_mm * 0.68))
    sigma_mm = min(
        max_deviation_mm * 0.78,
        max(0.025, pixel_mm * (0.18 + smoothness * 1.35)),
    )
    simplify_mm = min(
        max_deviation_mm * 0.85,
        max(0.20, pixel_mm * (0.25 + smoothness * 2.10)),
    )
    spline_rms_mm = min(
        max_deviation_mm * 0.62,
        max(0.025, pixel_mm * (0.08 + smoothness * 0.80)),
    )
    exact_budget_pts = max_deviation_mm * mm_to_pts
    ideal_envelope = ideal_cut_geometry.buffer(exact_budget_pts, join_style=1)
    absolute_budget_mm = max(
        max_deviation_mm,
        min(1.20, max(0.25, pixel_mm * 4.50)),
    )
    absolute_budget_pts = absolute_budget_mm * mm_to_pts
    absolute_envelope = ideal_cut_geometry.buffer(
        absolute_budget_pts,
        join_style=1,
    )
    topology = _polygon_topology_signature(ideal_cut_geometry)
    # QUALITY (audit 2026-08-10 §CUTROUND.6): Độ bo cong là một điều khiển
    # hình học độc lập. Lùi vào rồi trả ra với Join Round để tạo fillet ở góc
    # lồi; vòng ra–vào trước đây chỉ khép khe lõm nên tem lồi không hề đổi.
    # Topology và sai lệch vẫn phải qua cùng guard của preview lẫn PDF.
    round_radius_mm = _cutline_round_radius_mm(curve_tension)
    if round_radius_mm > 1e-9:
        rounded_parts = []
        rounded_any = False
        for part in source_parts:
            accepted_part = None
            # Một mấu hẹp có thể vượt guard ở bán kính yêu cầu dù phần còn lại
            # bo được. Hạ bán kính có thứ tự thay vì vô hiệu cả tem ngay lập tức.
            for radius_scale in (1.0, 0.75, 0.50, 0.25, 0.125, 0.0625):
                candidate_radius_mm = round_radius_mm * radius_scale
                candidate_radius_pts = candidate_radius_mm * mm_to_pts
                round_budget_pts = min(
                    max_deviation_mm,
                    max(0.08, candidate_radius_mm * 1.50),
                ) * mm_to_pts
                rounded_part = part.buffer(
                    -candidate_radius_pts,
                    join_style=1,
                ).buffer(
                    candidate_radius_pts,
                    join_style=1,
                )
                part_envelope = part.buffer(round_budget_pts, join_style=1)
                if (
                    isinstance(rounded_part, Polygon)
                    and not rounded_part.is_empty
                    and rounded_part.is_valid
                    and _polygon_topology_signature(rounded_part)
                    == _polygon_topology_signature(part)
                    # PERF (audit 2026-08-21 §CUTLINE.FAST-GUARD):
                    # `_geometry_within_hausdorff_budget` kiểm tra Hausdorff hai
                    # chiều bằng bao phủ buffer GEOS. Phép gọi
                    # `part.hausdorff_distance()` ở đây là cùng một guard nhưng
                    # chạy O(n²), từng làm mỗi ứng viên bo góc mất nhiều giây.
                    # Giữ envelope + topology làm hợp đồng duy nhất; các guard
                    # cuối của fitter vẫn đo quỹ đạo Bézier đã xuất.
                    and _geometry_within_hausdorff_budget(
                        part,
                        rounded_part,
                        round_budget_pts,
                        first_envelope=part_envelope,
                    )
                ):
                    accepted_part = rounded_part
                    break
            if accepted_part is not None:
                rounded_parts.append(accepted_part)
                rounded_any = True
            else:
                # Khe/hốc vẫn vượt guard ở mọi mức thử thì giữ nguyên component.
                rounded_parts.append(part)
        if rounded_any:
            rounded_reference = (
                MultiPolygon(rounded_parts) if return_multi else rounded_parts[0]
            )
            if (
                rounded_reference.is_valid
                and _polygon_topology_signature(rounded_reference) == topology
            ):
                source_parts = rounded_parts
    minimum_gap_pts = min(
        _ALPHA_SAFE_MIN_GAP_MM * mm_to_pts,
        max(0.0, -float(total_offset_pts)),
    )
    safe_envelope = (
        alpha_geometry.buffer(-minimum_gap_pts, join_style=1)
        if minimum_gap_pts > 0
        else None
    )
    minimum_anchor_spacing_pts = max(
        0.45,
        min(0.85, pixel_mm * 1.20),
    ) * mm_to_pts

    def build_candidate(strength: float, builder: str):
        fitted_paths = []
        sampled_parts = []
        try:
            for part in source_parts:
                ring_paths = []
                sampled_rings = []
                for ring in [part.exterior, *part.interiors]:
                    smoothed = _smooth_closed_ring_source_scale(
                        ring.coords,
                        spacing_pts=spacing_mm * mm_to_pts,
                        sigma_pts=sigma_mm * strength * mm_to_pts,
                    )
                    if len(smoothed) < 5:
                        raise ValueError("Ring quá ngắn để fit preview")
                    anchor_ring = Polygon(smoothed).exterior
                    simplified_ring = Polygon(anchor_ring).simplify(
                        max(0.02, simplify_mm * strength) * mm_to_pts,
                        preserve_topology=True,
                    ).exterior
                    coords = _remove_short_alpha_anchor_edges(
                        simplified_ring.coords,
                        minimum_spacing_pts=minimum_anchor_spacing_pts,
                    )
                    if builder == "c2":
                        segments = _periodic_smoothing_spline_segments(
                            coords,
                            smoothing_rms_pts=(
                                max(0.015, spline_rms_mm * strength) * mm_to_pts
                            ),
                        )
                    else:
                        segments = _catmull_rom_bezier_segments(
                            coords,
                            tension=0.18,
                        )
                    if not segments:
                        raise ValueError("Không fit được ring preview")
                    segments = [
                        tuple(
                            (float(point[0]), float(point[1]))
                            for point in segment
                        )
                        for segment in segments
                    ]
                    ring_paths.append(segments)
                    sampled_rings.append(sample_bezier_segments(
                        segments,
                        samples_per_segment=max(16, _ALPHA_FIT_SAMPLES),
                    ))
                polygon = Polygon(sampled_rings[0], sampled_rings[1:])
                if polygon.is_empty or not polygon.is_valid:
                    raise ValueError("Candidate preview tự cắt")
                sampled_parts.append(polygon)
                fitted_paths.extend(ring_paths)
        except (ArithmeticError, TypeError, ValueError):
            return None
        geometry = (
            MultiPolygon(sampled_parts) if return_multi else sampled_parts[0]
        )
        return geometry, fitted_paths

    safe_fallback = None
    for strength in (1.0, 0.70, 0.42, 0.18):
        for builder in ("c2", "g1"):
            candidate = build_candidate(strength, builder)
            if candidate is None:
                continue
            sampled_geometry, fitted_paths = candidate
            machine_paths_are_safe = all(
                _alpha_live_machine_path_is_safe(path, mm_to_pts=mm_to_pts)
                for path in fitted_paths
            )
            if (
                sampled_geometry.is_empty
                or not sampled_geometry.is_valid
                or not machine_paths_are_safe
                or _polygon_topology_signature(sampled_geometry) != topology
                or (
                    safe_envelope is not None
                    and (
                        safe_envelope.is_empty
                        or not safe_envelope.is_valid
                        or not safe_envelope.covers(sampled_geometry)
                    )
                )
            ):
                continue
            if (
                safe_fallback is None
                and _geometry_within_hausdorff_budget(
                    ideal_cut_geometry,
                    sampled_geometry,
                    absolute_budget_pts,
                    first_envelope=absolute_envelope,
                )
            ):
                safe_fallback = (
                    sampled_geometry,
                    fitted_paths,
                    absolute_budget_mm,
                )
            if not _geometry_within_hausdorff_budget(
                ideal_cut_geometry,
                sampled_geometry,
                exact_budget_pts,
                first_envelope=ideal_envelope,
            ):
                continue
            return _retension_alpha_fit_result(
                (sampled_geometry, fitted_paths, max_deviation_mm),
                ideal_cut_geometry=ideal_cut_geometry,
                alpha_geometry=alpha_geometry,
                total_offset_pts=total_offset_pts,
                mm_to_pts=mm_to_pts,
                curve_tension=_CUTLINE_TUNING_DEFAULT,
            )
    if safe_fallback is not None:
        # Độ bám sát cực cao không được phép ép engine quay về polyline dày node.
        # Dùng candidate máy-safe gần nhất trong envelope tuyệt đối; vùng xem cho
        # người dùng thấy đúng quỹ đạo này trước khi xuất.
        return _retension_alpha_fit_result(
            safe_fallback,
            ideal_cut_geometry=ideal_cut_geometry,
            alpha_geometry=alpha_geometry,
            total_offset_pts=total_offset_pts,
            mm_to_pts=mm_to_pts,
            curve_tension=_CUTLINE_TUNING_DEFAULT,
        )
    return None


def denoise_cutline_mask(
    mask: np.ndarray,
    *,
    amount: float | int | None,
    px_per_mm: float,
) -> np.ndarray:
    """Khử răng cưa mask theo thanh kéo người dùng, trước khi lấy contour.

    `amount` là 0–100 từ giao diện; 0 trả nguyên mask nên mặc định không đổi hành vi.
    Dùng chung van an toàn §CUTJAG.2: mask mảnh (dải hairline do nhận diện lỗi) thì
    bỏ qua thay vì bị bào thành rỗng.
    """
    try:
        resolved = float(amount if amount is not None else 0.0)
    except (TypeError, ValueError):
        return mask
    if not math.isfinite(resolved) or resolved <= 0.0:
        return mask
    resolved = min(100.0, resolved)
    if not math.isfinite(px_per_mm) or px_per_mm <= 0:
        return mask

    sigma_cap_px = _CUTLINE_DENOISE_MAX_MM * px_per_mm
    if px_per_mm >= _CUTLINE_DENOISE_SOURCE_CAP_MIN_PX_PER_MM:
        sigma_cap_px = max(
            sigma_cap_px,
            _CUTLINE_DENOISE_SOURCE_CAP_MIN_PX,
        )
    sigma = min(
        _CUTLINE_DENOISE_SIGMA_PX_MAX * resolved / 100.0,
        sigma_cap_px,
    )
    if sigma < 0.30 or min(mask.shape[:2]) < 5:
        return mask
    smoothed = cv2.GaussianBlur(
        mask,
        (0, 0),
        sigmaX=sigma,
        sigmaY=sigma,
        borderType=cv2.BORDER_REPLICATE,
    )
    before = int(np.count_nonzero(mask >= 128))
    after = int(np.count_nonzero(smoothed >= 128))
    if before > 0 and after < before * _CUTLINE_PRESMOOTH_MIN_AREA_KEPT:
        logger.debug(
            "Bỏ khử răng cưa (thanh kéo %.0f): mask quá mảnh (%d → %d pixel).",
            resolved,
            before,
            after,
        )
        return mask
    logger.debug(
        "Khử răng cưa đường cắt: thanh kéo %.0f → sigma %.2f px (%.3f mm).",
        resolved,
        sigma,
        sigma / px_per_mm,
    )
    return smoothed


def _presmooth_cutline_alpha(
    mask: np.ndarray,
    *,
    dpi_x: float,
    dpi_y: float,
) -> np.ndarray:
    """Khử răng cưa cấp pixel của Alpha trước khi lấy contour đường bế.

    Không phải thanh tinh chỉnh của người dùng: đây là bộ khử nhiễu dưới một pixel,
    cố định theo mm nên không nằm trong `geometry_key` của live preview. Sigma theo
    từng trục vì tem có thể được render DPI khác nhau theo chiều ngang/dọc.
    """
    sigma_x = min(
        _CUTLINE_ALPHA_PRESMOOTH_SIGMA_PX_MAX,
        _CUTLINE_ALPHA_PRESMOOTH_MAX_MM * dpi_x / 25.4,
    )
    sigma_y = min(
        _CUTLINE_ALPHA_PRESMOOTH_SIGMA_PX_MAX,
        _CUTLINE_ALPHA_PRESMOOTH_MAX_MM * dpi_y / 25.4,
    )
    if (
        sigma_x < _CUTLINE_ALPHA_PRESMOOTH_SIGMA_PX_MIN
        and sigma_y < _CUTLINE_ALPHA_PRESMOOTH_SIGMA_PX_MIN
    ):
        # DPI quá thấp: một pixel đã lớn hơn ngân sách 0,12 mm, làm mượt sẽ ăn vào
        # chi tiết thật thay vì khử nhiễu.
        return mask
    if min(mask.shape) < 5:
        return mask
    smoothed = cv2.GaussianBlur(
        mask,
        (0, 0),
        sigmaX=max(sigma_x, 1e-3),
        sigmaY=max(sigma_y, 1e-3),
        # REPLICATE giữ nguyên tem chạm sát khung ảnh; BORDER_CONSTANT sẽ bào mất
        # đúng cạnh đó vì crop của caller không còn chỗ đệm.
        borderType=cv2.BORDER_REPLICATE,
    )

    # QUALITY (feedback 2026-08-16 §CUTJAG.2): bộ này chỉ được phép khử nhiễu dưới
    # một pixel. Với mask MẢNH nó phá hình: đo được trên
    # `test/1785209372799_..._a00b34db...jpg` — nhận diện AI sinh vài "tem" là dải
    # hairline (cao 8 px, rộng 1315 px, Alpha đỉnh chỉ 235), Gaussian làm dải đó rơi
    # xuống 0 px và `prepare_alpha_cutline_geometry` trả None → preview 422.
    # Van an toàn: mất quá 10% diện tích silhouette thì đây là mask sai loại cho bộ
    # lọc này, trả nguyên mask. Tem thật đo được giữ 99,79–99,89% nên van không bao
    # giờ chạm vào ca đang chạy đúng.
    before = int(np.count_nonzero(mask >= 128))
    after = int(np.count_nonzero(smoothed >= 128))
    if before > 0 and after < before * _CUTLINE_PRESMOOTH_MIN_AREA_KEPT:
        logger.debug(
            "Bỏ khử răng cưa Alpha: mask quá mảnh (%d → %d pixel silhouette).",
            before,
            after,
        )
        return mask
    return smoothed


def prepare_alpha_cutline_geometry(
    alpha_mask: np.ndarray,
    *,
    dpi: float,
    dpi_y: float | None = None,
    cut_mode: str = "original",
    offset_mm: float = 0.0,
    bleed_mm: float = 0.0,
    corner_style: str = "preserve",
    fill_holes: bool = True,
    min_detail_area_mm2: float = _MIN_CONTOUR_AREA_MM2,
    presmooth_alpha: bool = False,
    cutline_denoise: float | int = 0.0,
) -> dict[str, object] | None:
    """Chuẩn bị silhouette/offset dùng chung cho nhiều lần fit Bézier.

    PERF (audit 2026-08-10 §CUTLINE.LIVE1): bám sát và độ bo không làm đổi
    mask/offset đầu vào. Tách bước này để live preview tái sử dụng phần
    marching-squares + Shapely thay vì dựng lại cho mỗi tick slider.
    """
    mask = np.asarray(alpha_mask)
    if mask.ndim != 2 or mask.size == 0:
        return None
    if mask.dtype != np.uint8:
        mask = np.clip(mask, 0, 255).astype(np.uint8)
    try:
        dpi_x = float(dpi)
        dpi_y_resolved = float(dpi_y if dpi_y is not None else dpi)
    except (TypeError, ValueError):
        return None
    if (
        not math.isfinite(dpi_x)
        or not math.isfinite(dpi_y_resolved)
        or dpi_x <= 0
        or dpi_y_resolved <= 0
    ):
        return None
    cut_mode = str(cut_mode or "original").strip().lower()
    if cut_mode == "none":
        return {
            "disabled": True,
            "dropped_contours": 0,
        }

    from skimage import measure

    # §CUTJAG.1/3: làm mượt Alpha trước marching-squares. Đặt ở đây (không đặt trong
    # fitter) để mọi guard sai lệch ở hạ nguồn đều tham chiếu CÙNG một silhouette.
    # Thanh kéo của người dùng THẮNG cổng tự động; để 0 thì dùng cổng tự động.
    try:
        denoise_amount = float(cutline_denoise or 0.0)
    except (TypeError, ValueError):
        denoise_amount = 0.0
    if math.isfinite(denoise_amount) and denoise_amount > 0.0:
        mask = denoise_cutline_mask(
            mask,
            amount=denoise_amount,
            px_per_mm=min(dpi_x, dpi_y_resolved) / 25.4,
        )
    elif presmooth_alpha:
        mask = _presmooth_cutline_alpha(mask, dpi_x=dpi_x, dpi_y=dpi_y_resolved)

    contours = measure.find_contours(
        np.pad(mask, pad_width=1, mode="constant", constant_values=0),
        127.5,
    )
    point_per_pixel_x = 72.0 / dpi_x
    point_per_pixel_y = 72.0 / dpi_y_resolved
    try:
        detail_area = float(min_detail_area_mm2)
    except (TypeError, ValueError):
        detail_area = _MIN_CONTOUR_AREA_MM2
    if not math.isfinite(detail_area):
        detail_area = _MIN_CONTOUR_AREA_MM2
    detail_area = max(0.0, min(25.0, detail_area))
    min_area_pt2 = detail_area * _PT_PER_MM * _PT_PER_MM
    contour_polygons = []
    for contour in contours:
        contour = contour - 1
        points = np.empty((len(contour), 2), dtype=np.float64)
        points[:, 0] = contour[:, 1] * point_per_pixel_x
        points[:, 1] = contour[:, 0] * point_per_pixel_y
        if len(points) < 3:
            continue
        polygon = Polygon(points)
        if polygon.is_empty or not polygon.is_valid:
            continue
        contour_polygons.append(polygon)
    if not contour_polygons:
        return None

    holes = []
    exteriors = []
    for polygon in contour_polygons:
        is_hole = any(
            other is not polygon
            and other.bounds[0] <= polygon.bounds[0]
            and other.bounds[1] <= polygon.bounds[1]
            and other.bounds[2] >= polygon.bounds[2]
            and other.bounds[3] >= polygon.bounds[3]
            and other.contains(polygon)
            for other in contour_polygons
        )
        (holes if is_hole else exteriors).append(polygon)
    filtered_exteriors = [
        polygon for polygon in exteriors if polygon.area < min_area_pt2
    ]
    exteriors = [
        polygon for polygon in exteriors if polygon.area >= min_area_pt2
    ]
    if not exteriors and filtered_exteriors:
        largest = max(filtered_exteriors, key=lambda polygon: polygon.area)
        exteriors = [largest]
        filtered_exteriors = [
            polygon for polygon in filtered_exteriors if polygon is not largest
        ]
    if not exteriors:
        return None
    base_geometry = unary_union(exteriors)
    if not fill_holes:
        for hole in holes:
            base_geometry = base_geometry.difference(hole)
    if base_geometry.is_empty or not isinstance(base_geometry, (Polygon, MultiPolygon)):
        return None

    effective_offset_mm = float(offset_mm) - (
        ALPHA_CONTOUR_INSET_MM if cut_mode == "alpha" else 0.0
    )
    total_offset_pts, _bleed_outer = compute_cut_bleed_offsets(
        cut_mode,
        max(0.0, float(bleed_mm)) * _PT_PER_MM,
        effective_offset_mm * _PT_PER_MM,
    )
    join_style = 1 if str(corner_style).lower() == "round" else 2
    ideal_geometry = (
        base_geometry.buffer(total_offset_pts, join_style=join_style)
        if abs(total_offset_pts) > 1e-12
        else base_geometry
    )
    if total_offset_pts < 0 and not ideal_geometry.is_empty:
        ideal_geometry = ideal_geometry.buffer(0.01, join_style=join_style)
    if ideal_geometry.is_empty or not isinstance(ideal_geometry, (Polygon, MultiPolygon)):
        return None
    if fill_holes:
        if isinstance(ideal_geometry, MultiPolygon):
            ideal_geometry = MultiPolygon([
                Polygon(part.exterior) for part in ideal_geometry.geoms
            ])
        else:
            ideal_geometry = Polygon(ideal_geometry.exterior)

    return {
        "disabled": False,
        "base_geometry": base_geometry,
        "ideal_geometry": ideal_geometry,
        "total_offset_pts": total_offset_pts,
        "source_pixel_mm": max(25.4 / dpi_x, 25.4 / dpi_y_resolved),
        "corner_style": str(corner_style or "preserve").strip().lower(),
        "dropped_contours": len(filtered_exteriors),
    }


def _collapse_raster_corner_splits(vertices):
    """Gộp cặp node cực ngắn do một đỉnh rơi giữa hai pixel raster."""
    points = [np.asarray(point, dtype=np.float64) for point in vertices]
    while len(points) > 3:
        lengths = np.asarray([
            np.linalg.norm(points[(index + 1) % len(points)] - point)
            for index, point in enumerate(points)
        ])
        median_length = float(np.median(lengths))
        short_index = int(np.argmin(lengths))
        if (
            not math.isfinite(median_length)
            or median_length <= 1e-9
            or float(lengths[short_index]) >= median_length * 0.08
        ):
            break
        rotated = points[short_index:] + points[:short_index]
        first, second = rotated[0], rotated[1]
        previous = rotated[-1]
        following = rotated[2]
        incoming = first - previous
        outgoing = following - second
        denominator = float(
            incoming[0] * outgoing[1] - incoming[1] * outgoing[0]
        )
        intersection = (first + second) / 2.0
        if abs(denominator) > 1e-12:
            delta = second - previous
            factor = float(
                delta[0] * outgoing[1] - delta[1] * outgoing[0]
            ) / denominator
            candidate = previous + incoming * factor
            if (
                np.all(np.isfinite(candidate))
                and np.linalg.norm(candidate - intersection) <= median_length
            ):
                intersection = candidate
        points = [intersection, *rotated[2:]]
    return [(float(point[0]), float(point[1])) for point in points]


def _standard_convex_polygon_vertices(
    geometry,
    *,
    source_pixel_mm: float,
):
    """Nhận polygon lồi 3–8 cạnh từ silhouette raster với guard vật lý.

    Chỉ đường bao gần convex-hull, không lỗ và không gần tròn mới được đưa vào
    fillet giải tích. Hình lõm/custom tiếp tục đi fitter bảo toàn góc hiện có.
    """
    if (
        not isinstance(geometry, Polygon)
        or geometry.is_empty
        or not geometry.is_valid
        or geometry.interiors
    ):
        return None
    perimeter = float(geometry.length)
    area = float(geometry.area)
    if perimeter <= 1e-9 or area <= 1e-9:
        return None
    circularity = 4.0 * math.pi * area / (perimeter * perimeter)
    # Bát giác đều có circularity lý thuyết ≈0,948; ngưỡng cũ 0,94 loại oan
    # tùy góc xoay raster. Tròn/elip thật còn có guard fit elip ngay bên dưới.
    if circularity > 0.97:
        return None

    raw = np.asarray(geometry.exterior.coords[:-1], dtype=np.float32)
    if raw.ndim != 2 or raw.shape[0] < 3 or raw.shape[1] != 2:
        return None

    pixel_mm = max(0.001, float(source_pixel_mm))
    residual_budget_mm = min(0.55, max(0.14, pixel_mm * 1.75))
    # Elip dẹt có circularity thấp nên chỉ ngưỡng trên chưa đủ. Classifier elip
    # là phép fit vector hóa nhẹ; chạy được mỗi tick slider mà không lặp bộ guard
    # rounded-rect/rect/triangle nặng hơn trên toàn contour.
    from app.workers.sticker_cut_reconstruct import try_ellipse_or_circle

    if try_ellipse_or_circle(
        raw,
        force=None,
        max_residual_mm=residual_budget_mm,
        max_defect_mm=residual_budget_mm,
    ) is not None:
        return None
    hull = geometry.convex_hull
    if (
        not isinstance(hull, Polygon)
        or geometry.hausdorff_distance(hull)
        > residual_budget_mm * _PT_PER_MM
    ):
        return None

    epsilon_min_mm = max(0.025, pixel_mm * 0.30)
    epsilon_candidates_mm = np.linspace(
        epsilon_min_mm,
        residual_budget_mm,
        9,
    )
    accepted = []
    for epsilon_mm in epsilon_candidates_mm:
        approximated = cv2.approxPolyDP(
            raw.reshape(-1, 1, 2),
            epsilon_mm * _PT_PER_MM,
            True,
        ).reshape(-1, 2)
        approximated = np.asarray(
            _collapse_raster_corner_splits(approximated),
            dtype=np.float32,
        )
        side_count = len(approximated)
        if not 3 <= side_count <= 8:
            continue
        if not cv2.isContourConvex(approximated.reshape(-1, 1, 2)):
            continue
        candidate = Polygon(np.asarray(approximated, dtype=np.float64))
        if candidate.is_empty or not candidate.is_valid or candidate.area <= 1e-9:
            continue
        area_ratio = area / float(candidate.area)
        residual_mm = geometry.hausdorff_distance(candidate) / _PT_PER_MM
        if (
            not 0.94 <= area_ratio <= 1.06
            or residual_mm > residual_budget_mm
        ):
            continue
        accepted.append((
            float(residual_mm),
            side_count,
            [(float(x), float(y)) for x, y in approximated],
        ))
    if not accepted:
        return None
    # Mọi candidate đều đã nằm trong residual vật lý rất hẹp ở trên. Trong hành
    # lang đó, node phụ chủ yếu là răng cưa nửa pixel tại góc; ưu tiên polygon
    # đơn giản nhất rồi mới so residual. Hình custom nằm ngoài guard không vào đây.
    return min(accepted, key=lambda item: (item[1], item[0]))[2]


def _fit_standard_polygon_fillet(
    base_geometry,
    *,
    total_offset_pts: float,
    source_pixel_mm: float,
    curve_tension: float | int | None,
):
    """Dựng line + cung cubic tiếp tuyến cho polygon chuẩn của mask/AI."""
    vertices = _standard_convex_polygon_vertices(
        base_geometry,
        source_pixel_mm=source_pixel_mm,
    )
    if vertices is None:
        return None
    polygon = Polygon(vertices)
    if abs(total_offset_pts) > 1e-12:
        polygon = polygon.buffer(
            total_offset_pts,
            join_style=2,
            mitre_limit=100.0,
        )
    if not isinstance(polygon, Polygon) or polygon.is_empty or polygon.interiors:
        return None
    radius_pts = (
        _cutline_round_radius_mm(curve_tension) * _PT_PER_MM
    )
    if radius_pts <= 1e-9:
        return None
    segments = build_filleted_polygon_beziers(
        list(polygon.exterior.coords[:-1]),
        radius=radius_pts,
        minimum_straight=_CUTLINE_FINAL_SHORT_SEGMENT_MM * _PT_PER_MM,
    )
    if not segments:
        return None
    sampled = sample_bezier_segments(segments, samples_per_segment=24)
    fitted_geometry = Polygon(sampled)
    if fitted_geometry.is_empty or not fitted_geometry.is_valid:
        return None
    return fitted_geometry, [segments], 0.0


def fit_prepared_alpha_cutline_geometry(
    prepared: dict[str, object],
    *,
    cutline_smoothness: float | int | None = _CUTLINE_TUNING_DEFAULT,
    cutline_fidelity: float | int | None = _CUTLINE_TUNING_DEFAULT,
    curve_tension: float | int | None = _CUTLINE_TUNING_DEFAULT,
) -> dict[str, object] | None:
    """Fit Bézier từ geometry đã chuẩn bị; kết quả dùng chung preview và PDF."""
    if bool(prepared.get("disabled")):
        return {
            "geometry": None,
            "path_groups": [],
            "paths": [],
            "dropped_contours": int(prepared.get("dropped_contours", 0)),
            "fit_tolerance_mm": 0.0,
            "fit_mode": "disabled",
            "quality": {
                "machine_safe": True,
                "segment_count": 0,
                "short_segment_count": 0,
                "disconnected_join_count": 0,
                "unprotected_join_count": 0,
                "protected_corner_count": 0,
                "dropped_component_count": int(prepared.get("dropped_contours", 0)),
                "minimum_segment_length_mm": None,
                "maximum_join_angle_degrees": None,
                "effective_deviation_mm": 0.0,
                "fit_mode": "disabled",
            },
        }

    base_geometry = prepared.get("base_geometry")
    ideal_geometry = prepared.get("ideal_geometry")
    if not isinstance(base_geometry, (Polygon, MultiPolygon)) or not isinstance(
        ideal_geometry,
        (Polygon, MultiPolygon),
    ):
        return None
    try:
        total_offset_pts = float(prepared["total_offset_pts"])
        source_pixel_mm = float(prepared["source_pixel_mm"])
    except (KeyError, TypeError, ValueError):
        return None

    rejected_qualities: list[dict[str, object]] = []
    # §CUTHOOK.1: ứng viên có gai do fitter tự sinh bị đẩy xuống cuối hàng để
    # `live-bezier` nhường cho fallback sạch. Nếu mọi ứng viên đều còn gai, chỉ
    # cusp đơn đủ rộng mới được dung nạp; móc nghiêm trọng bị cổng bước 3 từ chối.
    hooked_candidates: list[dict[str, object]] = []
    hook_search_started: list[float] = []
    # PERF §CUTHOOK.2: `ideal_geometry` bất biến suốt chuỗi ứng viên nên bộ dò góc
    # thật chỉ cần chạy một lần cho cả tem.
    corner_cache: dict[str, object] = {}

    def accept_candidate(fitted, fit_mode: str):
        if fitted is None:
            return None
        fitted_geometry, paths, fit_tolerance_mm = fitted
        quality = _alpha_final_cutline_quality(
            paths,
            reference_geometry=ideal_geometry,
            fitted_geometry=fitted_geometry,
            alpha_geometry=base_geometry,
            total_offset_pts=total_offset_pts,
            mm_to_pts=_PT_PER_MM,
            source_pixel_mm=source_pixel_mm,
            fit_mode=fit_mode,
            corner_cache=corner_cache,
        )
        quality["dropped_component_count"] = int(
            prepared.get("dropped_contours", 0)
        )
        if fit_mode in {"live-bezier", "hybrid-straight-reference"}:
            effective_deviation_mm = quality.get("effective_deviation_mm")
            live_deviation_budget_mm = max(
                float(fit_tolerance_mm),
                min(1.20, max(0.25, source_pixel_mm * 4.50)),
            )
            round_allowance_mm = min(
                0.10,
                _cutline_round_radius_mm(curve_tension) * 0.15,
            )
            live_deviation_budget_mm = min(
                1.30,
                live_deviation_budget_mm + round_allowance_mm,
            )
            fits_live_budget = bool(
                isinstance(effective_deviation_mm, (int, float))
                and math.isfinite(float(effective_deviation_mm))
                and float(effective_deviation_mm)
                <= live_deviation_budget_mm + 1e-7
            )
            if not fits_live_budget:
                # Guard diện tích nhanh ở fitter không đủ bắt một khe lõm sâu bị
                # Round lấp kín. Tận dụng phép đo quỹ đạo cuối đã có, không đo lại
                # trên từng ứng viên nên preview vẫn phản hồi nhanh.
                quality["machine_safe"] = False
                quality["fit_budget_exceeded"] = True
        if not bool(quality["machine_safe"]):
            rejected_qualities.append(quality)
            return None
        path_groups = _group_alpha_paths_like(fitted_geometry, paths)
        if not path_groups:
            rejected_qualities.append({**quality, "machine_safe": False})
            return None
        candidate = {
            "geometry": fitted_geometry,
            "path_groups": path_groups,
            "paths": paths,
            "dropped_contours": int(prepared.get("dropped_contours", 0)),
            "fit_tolerance_mm": float(fit_tolerance_mm),
            "fit_mode": fit_mode,
            "quality": quality,
        }
        if int(quality.get("unprotected_cusp_count", 0)) > 0:
            if not hooked_candidates:
                hook_search_started.append(time.perf_counter())
            hooked_candidates.append(candidate)
            return None
        return candidate

    def best_hooked_candidate():
        """Ứng viên ít gai nhất, nêm rộng nhất — dùng khi không có ứng viên sạch."""
        if not hooked_candidates:
            return None
        best = min(
            hooked_candidates,
            key=lambda candidate: (
                int(candidate["quality"].get("unprotected_cusp_count", 0)),
                -float(candidate["quality"].get("minimum_wedge_width_mm") or 0.0),
                int(candidate["quality"].get("segment_count", 0)),
            ),
        )
        if _cutline_hook_is_severe(best.get("quality")):
            quality = dict(best.get("quality") or {})
            quality["cutline_hook_rejected"] = True
            quality["machine_safe"] = False
            logger.warning(
                "[RECOGNITION-GUARD] từ chối đường bế còn móc/gai: "
                "cusps=%s turn=%s wedge=%smm segments=%s",
                quality.get("unprotected_cusp_count"),
                quality.get("maximum_trajectory_turn_degrees"),
                quality.get("minimum_wedge_width_mm"),
                quality.get("segment_count"),
            )
            raise UnsafeCutlineGeometryError(
                "Nhận diện đường bế còn gai/móc quá nhỏ nên chưa an toàn để xuất. "
                "Hãy tăng Khử răng cưa/Độ mượt hoặc chọn «Giữ mép ảnh» rồi kiểm tra lại.",
                quality=quality,
            )
        best["quality"]["cutline_hook_tolerated"] = True
        logger.debug(
            "Đường bế còn %d gai chưa khớp góc thật (nêm hẹp nhất %s mm, chế độ %s); "
            "đã chọn ứng viên ít gai nhất.",
            int(best["quality"].get("unprotected_cusp_count", 0)),
            best["quality"].get("minimum_wedge_width_mm"),
            best["fit_mode"],
        )
        return best

    def hook_search_exhausted() -> bool:
        """Hết hạn mức tìm ứng viên sạch gai, trong khi đã có ứng viên dùng được."""
        if not hook_search_started:
            return False
        return (
            time.perf_counter() - hook_search_started[0]
            > _CUTLINE_HOOK_SEARCH_BUDGET_SECONDS
        )

    # QUALITY (feedback 2026-08-19 §CUTROUND.4): polygon chuẩn không được bo bằng
    # spline toàn vòng. Cách đó phụ thuộc hướng/loại hình và thường rơi fallback,
    # làm vuông/ngũ giác/lục giác bỏ mất bán kính người dùng. Fillet cục bộ tạo
    # tiếp tuyến G1 thật; hình lõm/custom đã bị guard phía helper loại từ trước.
    if str(prepared.get("corner_style", "preserve")) == "round":
        analytic_fillet = accept_candidate(
            _fit_standard_polygon_fillet(
                base_geometry,
                total_offset_pts=total_offset_pts,
                source_pixel_mm=source_pixel_mm,
                curve_tension=curve_tension,
            ),
            "analytic-fillet",
        )
        if analytic_fillet is not None:
            return analytic_fillet

    # QUALITY (audit 2026-08-20 §CUTHYBRID.1): trước live-bezier, thử chuẩn hóa
    # cục bộ các cạnh thẳng dài đã có bằng chứng là một phần rounded-rectangle.
    # Candidate chỉ chiếu line; không dựng rounded-rect toàn vòng nên mấu/tay tự
    # do vẫn giữ nguyên. Nếu bất kỳ guard nào không đạt, nhánh live cũ chạy tiếp.
    # PERF (audit 2026-08-20 §CUTHYBRID.2): nhận dạng quỹ đạo là bước hình học
    # thuần từ ``prepared``. Preview gọi fitter nhiều lần khi kéo slider; giữ
    # cả kết quả ``None`` để không lặp lại phép resample/TLS nặng ở mỗi tick.
    # ``prepared`` được tạo mới khi mask, DPI, bleed hoặc góc thay đổi nên cache
    # này không làm cũ hình học giữa các phiên.
    if "_hybrid_reference_cache" not in prepared:
        prepared["_hybrid_reference_cache"] = (
            _regularize_partial_straight_reference(
                ideal_geometry,
                source_pixel_mm=source_pixel_mm,
                mm_to_pts=_PT_PER_MM,
            )
        )
    hybrid_reference = prepared.get("_hybrid_reference_cache")
    if hybrid_reference is not None:
        hybrid_geometry, hybrid_metadata = hybrid_reference
        hybrid_result = accept_candidate(
            _fit_alpha_live_tuned_paths(
                base_geometry,
                hybrid_geometry,
                total_offset_pts=total_offset_pts,
                mm_to_pts=_PT_PER_MM,
                source_pixel_mm=source_pixel_mm,
                cutline_smoothness=cutline_smoothness,
                cutline_fidelity=cutline_fidelity,
                curve_tension=curve_tension,
            ),
            "hybrid-straight-reference",
        )
        if hybrid_result is not None:
            hybrid_result["quality"]["hybrid_regularization"] = hybrid_metadata
            return hybrid_result

    # QUALITY (audit 2026-08-10 §CUTSMOOTH.1): cả kết quả live sau retension
    # cũng phải qua oracle cuối; không dựa vào việc ứng viên trước retension đã đạt.
    live_result = accept_candidate(
        _fit_alpha_live_tuned_paths(
            base_geometry,
            ideal_geometry,
            total_offset_pts=total_offset_pts,
            mm_to_pts=_PT_PER_MM,
            source_pixel_mm=source_pixel_mm,
            cutline_smoothness=cutline_smoothness,
            cutline_fidelity=cutline_fidelity,
            curve_tension=curve_tension,
        ),
        "live-bezier",
    )
    if live_result is not None:
        return live_result

    if hook_search_exhausted():
        return best_hooked_candidate()

    # QUALITY (audit 2026-08-10 §CUTSMOOTH.2): fallback này fit trên reference
    # bất biến, khóa đúng góc sao/notch và vẫn có guard topology/Hausdorff theo mm.
    preserved = _fit_preserved_contour_paths(
        ideal_geometry,
        mm_to_pts=_PT_PER_MM,
        source_pixel_mm=source_pixel_mm,
    )
    if preserved is not None:
        preserved = _retension_alpha_fit_result(
            preserved,
            ideal_cut_geometry=ideal_geometry,
            alpha_geometry=base_geometry,
            total_offset_pts=total_offset_pts,
            mm_to_pts=_PT_PER_MM,
            curve_tension=_CUTLINE_TUNING_DEFAULT,
        )
    preserved_result = accept_candidate(preserved, "corner-preserving-fallback")
    if preserved_result is not None:
        return preserved_result

    if hook_search_exhausted():
        return best_hooked_candidate()

    # QUALITY (audit 2026-08-10 §CUTSMOOTH.2): offset miter có thể sinh thêm
    # điểm chia kỹ thuật quanh góc thật. Với một component, thử fitter thích nghi
    # G1/C2 đã có guard để bỏ các khớp đó. Không chạy nhánh đắt này cho
    # MultiPolygon nhiều speck; trường hợp ấy phải lọc nhiễu hoặc fail-closed.
    adaptive_fallback = None
    if isinstance(ideal_geometry, Polygon):
        adaptive_fallback = _fit_alpha_bezier_paths(
            base_geometry,
            ideal_geometry,
            total_offset_pts=total_offset_pts,
            mm_to_pts=_PT_PER_MM,
            corner_policy="adaptive",
            source_pixel_mm=source_pixel_mm,
            allow_high_resolution_fairing=True,
            cutline_smoothness=cutline_smoothness,
            cutline_fidelity=cutline_fidelity,
            curve_tension=_CUTLINE_TUNING_DEFAULT,
        )
    adaptive_result = accept_candidate(
        adaptive_fallback,
        "adaptive-safe-fallback",
    )
    if adaptive_result is not None:
        return adaptive_result

    if hook_search_exhausted():
        return best_hooked_candidate()

    # Giữ fallback cũ như ứng viên cuối cho contour cong đơn giản, nhưng tuyệt đối
    # không còn quyền đi tắt qua oracle như trước đây.
    fallback_geometry, anchor_deviation_pts = _smooth_alpha_cut_contour(
        base_geometry,
        ideal_geometry,
        total_offset_pts=total_offset_pts,
        mm_to_pts=_PT_PER_MM,
    )
    safe_tension = _safe_alpha_bezier_tension(
        base_geometry,
        ideal_geometry,
        fallback_geometry,
        total_offset_pts=total_offset_pts,
        mm_to_pts=_PT_PER_MM,
        anchor_deviation_pts=anchor_deviation_pts,
    )
    fallback_paths = _paths_for_alpha_geometry(
        fallback_geometry,
        tension=safe_tension,
    )
    sampled_fallback = _sampled_geometry_from_alpha_paths_like(
        fallback_geometry,
        fallback_paths,
    )
    legacy_fallback = _retension_alpha_fit_result(
        (
            sampled_fallback if sampled_fallback is not None else fallback_geometry,
            fallback_paths,
            0.0,
        ),
        ideal_cut_geometry=fallback_geometry,
        alpha_geometry=base_geometry,
        total_offset_pts=total_offset_pts,
        mm_to_pts=_PT_PER_MM,
        curve_tension=_CUTLINE_TUNING_DEFAULT,
    )
    fallback_result = accept_candidate(legacy_fallback, "guarded-fallback")
    if fallback_result is not None:
        return fallback_result

    # §CUTHOOK.1 bước 3: không ứng viên nào sạch gai. Ứng viên ít gai nhất vẫn
    # phải qua cổng độ rộng nêm/số cusp/góc quay trong `best_hooked_candidate`;
    # chỉ cusp đơn đủ rộng mới nhận cờ `cutline_hook_tolerated`.
    hooked_result = best_hooked_candidate()
    if hooked_result is not None:
        return hooked_result

    best_quality = min(
        rejected_qualities,
        key=lambda quality: (
            int(quality.get("short_segment_count", 0)),
            int(quality.get("disconnected_join_count", 0)),
            int(quality.get("unprotected_join_count", 0)),
            int(quality.get("segment_count", 0)),
        ),
        default=None,
    )
    issue_parts = []
    if best_quality is not None:
        if int(best_quality.get("short_segment_count", 0)):
            issue_parts.append(
                f"{best_quality['short_segment_count']} đoạn dao ngắn dưới 0,25 mm"
            )
        if int(best_quality.get("disconnected_join_count", 0)):
            issue_parts.append(
                f"{best_quality['disconnected_join_count']} khớp hở"
            )
        if int(best_quality.get("unprotected_join_count", 0)):
            issue_parts.append(
                f"{best_quality['unprotected_join_count']} khớp gãy không khớp góc thật"
            )
    detail = ", ".join(issue_parts) or "quỹ đạo vượt hành lang hình học an toàn"
    raise UnsafeCutlineGeometryError(
        "Không thể tạo đường bế an toàn cho máy "
        f"({detail}). Hãy tăng Độ mượt hoặc Lọc chi tiết nhỏ rồi xem lại đường bao.",
        quality=best_quality,
    )


def build_alpha_cutline_geometry(
    alpha_mask: np.ndarray,
    *,
    dpi: float,
    dpi_y: float | None = None,
    cut_mode: str = "original",
    offset_mm: float = 0.0,
    bleed_mm: float = 0.0,
    corner_style: str = "preserve",
    fill_holes: bool = True,
    cutline_smoothness: float | int | None = _CUTLINE_TUNING_DEFAULT,
    cutline_fidelity: float | int | None = _CUTLINE_TUNING_DEFAULT,
    curve_tension: float | int | None = _CUTLINE_TUNING_DEFAULT,
    min_detail_area_mm2: float = _MIN_CONTOUR_AREA_MM2,
    presmooth_alpha: bool = False,
    cutline_denoise: float | int = 0.0,
):
    """Tạo geometry CutContour trực tiếp từ Alpha nguồn cho preview và export.

    Toạ độ kết quả là point PDF nhưng vẫn dùng gốc trên-trái như ảnh. Caller chỉ
    cần lật Y ở lúc ghi content stream, giống toàn bộ engine hiện tại.
    """
    prepared = prepare_alpha_cutline_geometry(
        alpha_mask,
        dpi=dpi,
        dpi_y=dpi_y,
        cut_mode=cut_mode,
        offset_mm=offset_mm,
        bleed_mm=bleed_mm,
        corner_style=corner_style,
        fill_holes=fill_holes,
        min_detail_area_mm2=min_detail_area_mm2,
        presmooth_alpha=presmooth_alpha,
        cutline_denoise=cutline_denoise,
    )
    if prepared is None:
        return None
    return fit_prepared_alpha_cutline_geometry(
        prepared,
        cutline_smoothness=cutline_smoothness,
        cutline_fidelity=cutline_fidelity,
        curve_tension=curve_tension,
    )


def _erode_px(mask: np.ndarray, px: int, kernel_type: int = cv2.MORPH_ELLIPSE) -> np.ndarray:
    """Erode mask `px` pixels (kernel ellipse/rect 2*px+1). px<=0 → copy."""
    if px is None or px <= 0:
        return mask.copy()
    k = max(1, int(px))
    ker = cv2.getStructuringElement(kernel_type, (k * 2 + 1, k * 2 + 1))
    return cv2.erode(mask, ker)


def _near_background_mask_rgb(
    img: np.ndarray,
    background_rgb: Optional[Tuple[int, int, int]],
    tolerance: int,
) -> np.ndarray:
    """Pixel gần MÀU NỀN đã dò được (RGB uint8 HxWx3).

    QUALITY (audit 2026-08-06 §BG.4): tổng quát hoá `_near_white_mask_rgb`. Viền
    răng cưa (AA) quanh tem bị trộn với NỀN, và nền không nhất thiết là trắng —
    trên nền kem/xanh thì pixel mép bị ám kem/xanh, `_near_white_mask_rgb` không
    thấy nên màu nền bị kéo ra vùng bù xén thành quầng.

    Dung sai nới nhẹ so với lúc dò nền: ở đây mục tiêu là LOẠI pixel pha nền khỏi
    nguồn lấy màu, lọc rộng hơn một chút vẫn an toàn vì đã có chuỗi fallback.
    """
    if img is None or img.ndim != 3 or img.shape[2] < 3:
        return (
            np.zeros(img.shape[:2], dtype=bool)
            if img is not None
            else np.zeros((0, 0), dtype=bool)
        )
    if background_rgb is None:
        return np.zeros(img.shape[:2], dtype=bool)
    bg = np.array(background_rgb, dtype=np.int16).reshape(1, 1, 3)
    delta = np.max(np.abs(img[:, :, :3].astype(np.int16) - bg), axis=2)
    return delta <= max(1, int(tolerance))


def _strip_edge_color_shell_pixels(
    shell: np.ndarray,
    img: np.ndarray,
    *,
    exclude_near_white: bool,
    background_rgb: Optional[Tuple[int, int, int]],
    background_tolerance: int,
) -> np.ndarray:
    """Loại pixel pha nền chỉ trên shell, giữ nguyên kết quả của phép lọc toàn ảnh.

    PERF (audit 2026-08-10 §STICKER-COLOR.1): shell chỉ chiếm một dải rất mỏng
    quanh tem. Dựng các mask H×W cho mọi kênh RGB ở mỗi candidate làm tem lớn
    phải quét hàng chục triệu pixel không liên quan; lấy đúng tọa độ shell giảm
    lượng tính toán mà không đổi pixel nguồn màu nào.
    """
    if (
        not exclude_near_white
        or shell is None
        or img is None
        or img.ndim != 3
        or img.shape[2] < 3
        or shell.shape != img.shape[:2]
    ):
        return shell

    points = cv2.findNonZero(np.ascontiguousarray(shell))
    if points is None:
        return shell
    xs = points[:, 0, 0]
    ys = points[:, 0, 1]
    rgb = img[ys, xs, :3]
    remove = np.zeros(rgb.shape[0], dtype=bool)

    if background_rgb is not None:
        bg = np.asarray(background_rgb, dtype=np.int16).reshape(1, 3)
        rgb_i16 = rgb.astype(np.int16)
        remove |= np.max(np.abs(rgb_i16 - bg), axis=1) <= max(
            1, int(background_tolerance)
        )

    channel_max = np.max(rgb, axis=1)
    channel_min = np.min(rgb, axis=1)
    chroma = channel_max.astype(np.int16) - channel_min.astype(np.int16)
    remove |= (channel_max >= 248) & (chroma <= 18)
    if not np.any(remove) or bool(np.all(remove)):
        # Giữ đúng chuỗi fallback cũ: shell bị lọc rỗng phải quay lại shell gốc.
        return shell

    cleaned = shell.copy()
    cleaned[ys[remove], xs[remove]] = 0
    return cleaned


# Nới dung sai khi LOẠI pixel pha nền khỏi nguồn màu viền (so với lúc dò nền).
_EDGE_BG_TOLERANCE_PADDING = 6


def _build_edge_color_source_mask(
    silhouette: np.ndarray,
    img: np.ndarray,
    *,
    band_px: int,
    peel_px: int = 1,
    edge_bite_px: int = 0,
    kernel_type: int = cv2.MORPH_ELLIPSE,
    exclude_near_white: bool = True,
    background_rgb: Optional[Tuple[int, int, int]] = None,
    background_tolerance: int = 0,
) -> np.ndarray:
    """Nguồn màu bleed = dải VIỀN tem gốc (shell), không hút cả ruột.

    Mục tiêu: 'Lấy theo màu viền tem' phải lấy đúng màu dọc chu vi tem, không
    lấy màu lõi (khi viền mỏng + erode sâu) và không lấy pixel AA trắng mép.

    Pipeline:
      1) edge_bite: co silhouette (bỏ dải trắng mép khi file không tràn lề).
      2) peel: bỏ vài px ngoài cùng (AA trộn nền).
      3) band: dải dày `band_px` ngay sau peel = nguồn nearest/inpaint.
      4) Loại pixel pha NỀN trong dải (near-white, hoặc gần `background_rgb`).
      5) Fallback dần nếu dải rỗng (tem mảnh / viền trắng dày).

    QUALITY (audit 2026-08-06 §BG.4): truyền `background_rgb` (màu nền đã dò ở
    §BG.2/§BG.3) thì bước 4 loại pixel gần MÀU NỀN ĐÓ thay vì chỉ gần trắng.
    Không truyền thì hành vi giữ nguyên từng điểm ảnh như trước.
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
        return _strip_edge_color_shell_pixels(
            shell,
            img,
            exclude_near_white=exclude_near_white,
            background_rgb=background_rgb,
            background_tolerance=background_tolerance,
        )

    shell = _strip_white(_shell(base, peel, band))
    if np.count_nonzero(shell) > 0:
        return shell

    # Fallback 1: bỏ peel, band dày hơn (bám sát viền hình học).
    shell = _strip_white(_shell(base, 0, max(band, 2)))
    if np.count_nonzero(shell) > 0:
        return shell

    # Fallback 2: KHÔNG lọc pha nền — thà lấy AA còn hơn rỗng (tránh bleed
    # padding). QUALITY (audit 2026-08-06 §BG.4): cố ý bỏ qua cờ lọc ở đây, vì
    # tới bước này nghĩa là cả dải viền đều bị coi là pha nền; rỗng sẽ khiến bù
    # xén không có màu để kéo, tệ hơn hẳn màu hơi nhạt.
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
# Ngưỡng sparse bắt đầu từ 0,5%; đo ở p99 sẽ bỏ lọt đúng các cụm 0,5–1% rồi
# nearest phóng từng pixel AA thành nan dài ở góc bo. p99,5 khớp cùng ngân sách.
_EDGE_COLOR_BRIGHT_TAIL_PERCENTILE = 99.5
_EDGE_COLOR_BRIGHT_TAIL_DELTA = 20.0
_EDGE_COLOR_BRIGHT_TAIL_MIN_RATIO = 0.005
_EDGE_COLOR_BRIGHT_TAIL_MAX_RATIO = 0.08
_EDGE_COLOR_ADAPTIVE_ACCEPT_RATIO = 0.75
_EDGE_COLOR_DEPTH_PENALTY = 0.002
_EDGE_COLOR_BACKGROUND_DISTANCE = 72
# QUALITY (feedback 2026-08-10 §EDGE-SAMPLE.3): JPEG 72 DPI có thể tạo thêm
# nhiều lớp đỏ pha trắng trước viền mực thật. Mức 150 vẫn nhận lớp chuyển tiếp
# RGB(130, 76, 74) của ca thật làm nguồn và kéo nó thành vành nâu/hồng. Mức 200
# chỉ dùng khi adaptive đã chứng minh shell còn pha nền; viền sáng có chủ đích
# không tìm thấy shell thay thế sẽ tự rơi về nguồn nông ban đầu.
_EDGE_COLOR_WHITE_FRINGE_DISTANCE = 200
_EDGE_COLOR_BACKGROUND_FRINGE_RATIO = 0.70
_EDGE_COLOR_BACKGROUND_RELEASE_RATIO = 0.25
_EDGE_COLOR_BACKGROUND_COVERAGE_RATIO = 0.90
_EDGE_COLOR_MIN_SOURCE_DENSITY_RATIO = 0.20
_EDGE_COLOR_BACKGROUND_SCORE_WEIGHT = 0.50
_EDGE_COLOR_BROAD_BACKGROUND_MIN_RATIO = 0.05
_EDGE_COLOR_BROAD_BACKGROUND_MIN_LUMA_SPAN = 60.0
_EDGE_COLOR_BROAD_BACKGROUND_MIN_TAIL_SPAN = 40.0
def _edge_color_instability_metrics(
    source_mask: np.ndarray,
    img: np.ndarray,
    *,
    background_rgb: Optional[Tuple[int, int, int]] = None,
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
            "background_close_ratio": 0.0,
            "background_distance_median": 255.0,
        }

    ys, xs = np.where(source_mask > 0)
    if ys.size == 0:
        return {
            "sample_count": 0.0,
            "transition_ratio": 0.0,
            "luma_span": 0.0,
            "bright_tail_span": 0.0,
            "bright_tail_ratio": 0.0,
            "background_close_ratio": 0.0,
            "background_distance_median": 255.0,
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
    background_close_ratio = 0.0
    background_distance_median = 255.0
    if background_rgb is not None:
        background = np.asarray(background_rgb, dtype=np.int16).reshape(1, 3)
        background_distance = np.max(np.abs(rgb - background), axis=1)
        background_close_ratio = float(
            np.mean(background_distance <= _EDGE_COLOR_BACKGROUND_DISTANCE)
        )
        background_distance_median = float(np.median(background_distance))

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
        "background_close_ratio": background_close_ratio,
        "background_distance_median": background_distance_median,
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


def _edge_color_has_background_fringe(metrics: dict[str, float]) -> bool:
    """True khi phần lớn shell vẫn là màu pha gần nền đã biết.

    Khác nhiễu cao tần, halo JPEG trên tem khổ lớn có thể là một dải hồng/trắng
    rất đều nên nhìn "ổn định" theo transition ratio. Tỷ lệ gần nền bắt đúng ca đó.
    """
    return (
        metrics.get("sample_count", 0.0) >= _EDGE_COLOR_MIN_SAMPLES
        and metrics.get("background_close_ratio", 0.0)
        >= _EDGE_COLOR_BACKGROUND_FRINGE_RATIO
    )


def _edge_color_has_broad_background_fringe(metrics: dict[str, float]) -> bool:
    """True khi fringe pha nền trải thành dải rộng, không còn là đuôi sáng thưa.

    QUALITY (feedback 2026-08-19 §STK.EDGE03): ảnh JPEG/AA thấp DPI có thể tạo
    cả một phổ màu liên tục từ mực tới nền. Khi đó tỷ lệ đổi màu từng cặp thấp,
    đuôi sáng vượt trần ``sparse`` và chỉ phần sáng nhất nằm gần nền. Ba bằng
    chứng phải cùng có mặt mới cho phép thử shell sâu; candidate thay thế vẫn
    phải qua guard phủ chu vi + mật độ ở ``_build_adaptive_edge_color_source_mask``.
    """
    return (
        metrics.get("sample_count", 0.0) >= _EDGE_COLOR_MIN_SAMPLES
        and metrics.get("transition_ratio", 0.0)
        < _EDGE_COLOR_TRANSITION_RATIO
        and metrics.get("background_close_ratio", 0.0)
        >= _EDGE_COLOR_BROAD_BACKGROUND_MIN_RATIO
        and metrics.get("luma_span", 0.0)
        >= _EDGE_COLOR_BROAD_BACKGROUND_MIN_LUMA_SPAN
        and metrics.get("bright_tail_span", 0.0)
        >= _EDGE_COLOR_BROAD_BACKGROUND_MIN_TAIL_SPAN
        and metrics.get("bright_tail_ratio", 0.0)
        > _EDGE_COLOR_BRIGHT_TAIL_MAX_RATIO
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


def _edge_color_source_coverage_ratio(
    reference_mask: np.ndarray,
    candidate_mask: np.ndarray,
    max_distance_px: int,
) -> float:
    """Tỷ lệ shell ngoài tìm thấy nguồn màu an toàn ở độ sâu cho phép.

    Đo trên bản hạ tối đa 1000 px để không tạo distance-map lớn cho tem khổ lớn.
    Candidate chỉ tốt khi phủ gần trọn chu vi; vài mảng đỏ cục bộ không được phép
    làm cả trang kết luận rằng halo trắng đã được loại.
    """
    if (
        reference_mask is None
        or candidate_mask is None
        or reference_mask.shape != candidate_mask.shape
        or np.count_nonzero(reference_mask) == 0
        or np.count_nonzero(candidate_mask) == 0
    ):
        return 0.0
    height, width = reference_mask.shape[:2]
    factor = _downscale_factor(height, width, max_dim=1000)
    if factor > 1:
        small_size = (
            max(1, int(math.ceil(width / factor))),
            max(1, int(math.ceil(height / factor))),
        )
        reference = cv2.resize(
            reference_mask,
            small_size,
            interpolation=cv2.INTER_AREA,
        ) > 0
        candidate = cv2.resize(
            candidate_mask,
            small_size,
            interpolation=cv2.INTER_AREA,
        ) > 0
    else:
        reference = reference_mask > 0
        candidate = candidate_mask > 0
    if not np.any(reference) or not np.any(candidate):
        return 0.0
    distance = cv2.distanceTransform(
        np.ascontiguousarray(~candidate, dtype=np.uint8),
        cv2.DIST_L2,
        3,
    )
    allowed = max(1.0, float(max_distance_px) / factor + 0.5)
    return float(np.mean(distance[reference] <= allowed))


def _build_adaptive_edge_color_source_mask(
    silhouette: np.ndarray,
    img: np.ndarray,
    *,
    band_px: int,
    peel_px: int,
    max_peel_px: int,
    max_interpolation_probe_px: int = 0,
    edge_bite_px: int = 0,
    kernel_type: int = cv2.MORPH_ELLIPSE,
    exclude_near_white: bool = True,
    background_rgb: Optional[Tuple[int, int, int]] = None,
    background_tolerance: int = 0,
) -> tuple[np.ndarray, int]:
    """Chọn shell nông nhất đủ ổn định, thay vì kéo halo sát mép ra bleed.

    QUALITY (audit 2026-07-28 §BX.1/§BX.2): mask hình học vẫn giữ nguyên;
    chỉ mask lấy màu được thử sâu dần. Viền gồm các mảng màu dài có tỷ lệ đổi
    pixel thấp nên giữ shell ban đầu. Shell cao tần hoặc shell còn pha màu nền mới
    được dịch vào trong; caller giới hạn theo cả pixel nguồn và mm vật lý.

    QUALITY (audit 2026-08-06 §BG.4): `background_rgb` chuyển tiếp nguyên vẹn
    xuống `_build_edge_color_source_mask` để mọi lần thử sâu đều lọc pha nền
    theo cùng một màu.
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
        background_rgb=background_rgb,
        background_tolerance=background_tolerance,
    )
    initial_metrics = _edge_color_instability_metrics(
        initial,
        img,
        background_rgb=background_rgb,
    )
    sparse_bright_fringe = _edge_color_has_sparse_bright_fringe(initial_metrics)
    background_fringe = (
        _edge_color_has_background_fringe(initial_metrics)
        or _edge_color_has_broad_background_fringe(initial_metrics)
    )
    if not (
        _edge_color_is_unstable(initial_metrics)
        or sparse_bright_fringe
        or background_fringe
    ):
        return initial, initial_peel

    # QUALITY (audit 2026-08-19 §STK.EDGE02): shell tham chiếu phải là HÌNH HỌC
    # nguyên vẹn, chưa lọc trắng/màu nền. Nếu dùng `initial` đã lọc, một dúm pixel
    # tối có thể tự tạo chuẩn phủ rất nhỏ rồi thắng điểm và bị kéo quanh cả tem.
    # Chỉ dựng thêm shell này sau khi initial thật sự cần adaptive để đường ổn
    # định thông thường không chịu thêm một lượt morphology toàn trang.
    coverage_reference = _build_edge_color_source_mask(
        silhouette,
        img,
        band_px=band_px,
        peel_px=initial_peel,
        edge_bite_px=edge_bite_px,
        kernel_type=kernel_type,
        exclude_near_white=False,
        background_rgb=None,
        background_tolerance=0,
    )
    coverage_reference_count = max(1, int(np.count_nonzero(coverage_reference)))

    deepest_peel = max(initial_peel, int(max_peel_px))
    band = max(1, int(band_px))
    step = max(1, int(round(band / 3)))
    candidate_peels = sorted({
        min(deepest_peel, initial_peel + step),
        min(deepest_peel, initial_peel + max(step, (band + 1) // 2)),
        min(deepest_peel, initial_peel + band),
        deepest_peel,
    })
    interpolation_probe_px = max(0, int(max_interpolation_probe_px))
    if background_fringe and interpolation_probe_px > 0:
        # QUALITY (audit 2026-08-19 §STK.EDGE02): render 300 DPI của ảnh nguồn
        # 72 DPI có thể đặt lớp màu sạch ngay SAU trần quy đổi vì nội suy + làm
        # tròn morphology (fixture: peel 29 chỉ có 18,8% coverage, peel 33 mới
        # chạm đủ vòng đỏ). Chỉ thăm dò thêm tối đa hai bề dày shell khi đã xác
        # nhận fringe nền; caller chỉ cấp phần dịch do UPSCALE nội suy, mặc định
        # bằng 0 nên `max_peel_px` vẫn là trần cứng cho ảnh chạy lưới native.
        # Candidate vẫn phải qua coverage 90%, nên không mở cửa cho vài pixel tối.
        candidate_peels.append(deepest_peel + interpolation_probe_px)
        candidate_peels = sorted(set(candidate_peels))
    # Fringe sáng thưa thường chiếm trọn lớp AA đầu tiên. Khi đã nhận ra mẫu này,
    # lùi tối thiểu một bề dày shell để không chọn lại lớp kế cận vẫn còn pha nền.
    minimum_candidate_peel = (
        min(deepest_peel, initial_peel + band)
        if sparse_bright_fringe or background_fringe
        else initial_peel + 1
    )

    best_mask = initial
    best_peel = initial_peel
    initial_score = _edge_color_stability_score(initial_metrics)
    if background_fringe:
        initial_score += (
            _EDGE_COLOR_BACKGROUND_SCORE_WEIGHT
            * initial_metrics.get("background_close_ratio", 0.0)
        )
    best_score = initial_score
    for candidate_peel in candidate_peels:
        if candidate_peel < minimum_candidate_peel:
            continue
        candidate_band = band
        candidate_shell_peel = candidate_peel
        candidate_background_tolerance = background_tolerance
        if background_fringe:
            # Halo nền có bề dày không đều quanh contour. Quét cả dải từ shell
            # nông tới độ sâu candidate rồi bỏ pixel gần nền; nearest-fill sẽ tự
            # chọn pixel an toàn nông nhất tại từng vị trí, thay vì dùng một vòng
            # erode sâu đồng loạt và chọc qua viền màu mảnh ở chỗ khác.
            candidate_band = max(
                band,
                candidate_peel - initial_peel + band,
            )
            candidate_shell_peel = initial_peel
            background_array = np.asarray(background_rgb, dtype=np.int16)
            background_is_near_white = bool(
                background_array.size >= 3
                and int(np.min(background_array[:3])) >= 240
                and int(np.max(background_array[:3]) - np.min(background_array[:3]))
                <= 18
            )
            candidate_background_tolerance = max(
                background_tolerance,
                (
                    _EDGE_COLOR_WHITE_FRINGE_DISTANCE
                    if background_is_near_white
                    else _EDGE_COLOR_BACKGROUND_DISTANCE
                ),
            )
        candidate = _build_edge_color_source_mask(
            silhouette,
            img,
            band_px=candidate_band,
            peel_px=candidate_shell_peel,
            edge_bite_px=edge_bite_px,
            kernel_type=kernel_type,
            exclude_near_white=exclude_near_white,
            background_rgb=background_rgb,
            background_tolerance=candidate_background_tolerance,
        )
        source_density = (
            float(np.count_nonzero(candidate)) / coverage_reference_count
        )
        # Chặn speckle thưa trước metrics/distance-map: ngoài đúng hình
        # học, nhánh lỗi này còn không được tốn thêm một phép quét raster.
        if source_density < _EDGE_COLOR_MIN_SOURCE_DENSITY_RATIO:
            continue
        metrics = _edge_color_instability_metrics(
            candidate,
            img,
            background_rgb=background_rgb,
        )
        source_coverage = _edge_color_source_coverage_ratio(
            coverage_reference,
            candidate,
            candidate_peel,
        )
        # Mọi candidate thay thế đều phải phủ gần trọn chu vi. Không chỉ kiểm ở
        # nhánh `background_released`: candidate dưới 64 mẫu trước đây vẫn được
        # coi ổn định và có thể thắng chỉ nhờ vài pixel màu đậm cục bộ.
        # Distance coverage kết hợp với density đã kiểm phía trên chặn
        # được cả cluster cục bộ lẫn chấm thưa rải đều.
        if source_coverage < _EDGE_COLOR_BACKGROUND_COVERAGE_RATIO:
            continue
        background_released = (
            background_fringe
            and metrics.get("background_close_ratio", 0.0)
            <= initial_metrics.get("background_close_ratio", 0.0)
            * _EDGE_COLOR_BACKGROUND_RELEASE_RATIO
            and source_coverage >= _EDGE_COLOR_BACKGROUND_COVERAGE_RATIO
        )
        if background_released:
            # Candidate được duyệt theo thứ tự nông→sâu; vòng đầu tiên vừa sạch
            # nền vừa phủ đủ chu vi là nguồn đúng gần mép nhất. Không tiếp tục
            # chọc sâu vào màu ruột chỉ để giảm vài phần nghìn điểm stability.
            return candidate, candidate_peel
        if _edge_color_is_unstable(metrics) and not background_released:
            continue
        depth_penalty = (
            _EDGE_COLOR_DEPTH_PENALTY
            * (candidate_peel - initial_peel)
            / band
        )
        score = _edge_color_stability_score(metrics) + depth_penalty
        if background_fringe:
            score += (
                _EDGE_COLOR_BACKGROUND_SCORE_WEIGHT
                * metrics.get("background_close_ratio", 0.0)
            )
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


def _edge_color_sampling_warning(
    source_mask: np.ndarray,
    img: np.ndarray,
    page_number: int,
    *,
    background_rgb: Optional[Tuple[int, int, int]] = None,
) -> str | None:
    """Cảnh báo khi nearest có nguy cơ kéo nhiễu mép thành vệt dài."""
    metrics = _edge_color_instability_metrics(
        source_mask,
        img,
        background_rgb=background_rgb,
    )
    if (
        _edge_color_is_unstable(metrics)
        or _edge_color_has_background_fringe(metrics)
        or _edge_color_has_broad_background_fringe(metrics)
    ):
        return (
            f"Trang {page_number}: chưa tìm được dải màu viền sạch phủ đủ quanh "
            "tem; bù xén có thể còn ám màu nền hoặc xuất hiện vệt. Hãy kiểm tra "
            "bản xem trước hoặc chọn ‘Đổ màu trơn’."
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


def _enforce_rectangle_edge_continuity(
    filled: np.ndarray,
    img: np.ndarray,
    pad_px: int,
    edge_bite_px: int,
    pads: tuple[int, int, int, int] | None = None,
) -> np.ndarray:
    """Giữ màu liên tục ở ranh trim/bleed cho nguồn thiếu ICC.

    Một số PDF DeviceN không có ICC có mép hoa văn rất nhạy: trường quỹ đạo
    đúng hướng nhưng vẫn có thể đổi màu ngay pixel đầu của dải ngoài. Khi
    flatten về RGB, giữ nguyên texture đã suy ra và neo pixel đầu tiên của dải
    ngoài vào đúng mép artwork tạo điểm nối liên tục, đồng thời vẫn giữ nguyên
    phần lõi artwork. Không làm phẳng cả dải về một màu trung bình vì sẽ lộ
    thành sọc trên nền xanh/hoa văn.
    """
    if (
        filled is None
        or img is None
        or filled.ndim != 3
        or img.ndim != 3
        or filled.shape[2] < 3
        or img.shape[2] < 3
    ):
        return filled

    height, width = img.shape[:2]
    pad = max(0, int(pad_px))
    if pads is None:
        pad_left = pad_right = pad_bottom = pad_top = pad
    else:
        pad_left, pad_right, pad_bottom, pad_top = (
            max(0, int(value)) for value in pads
        )
    # edge_bite_px chỉ thay đổi vùng chồng mí/đường cắt; lưới flatten
    # vẫn đặt artwork tại pad_* như padded_img. Không dịch lõi theo
    # edge bite, nếu không dải RGB sẽ lệch đúng một vài pixel ở ranh trim.
    del edge_bite_px
    top = pad_top
    bottom = pad_bottom
    left = pad_left
    right = pad_right
    expected_shape = (
        top + height + bottom,
        left + width + right,
    )
    if filled.shape[:2] != expected_shape:
        return filled

    result = np.array(filled, dtype=filled.dtype, copy=True, order="C")
    # Ghi lại lõi đúng theo render PDFium; phần overlap nếu có cũng cùng màu.
    result[top:top + height, left:left + width] = img
    # Neo đúng pixel kề mép theo bốn hướng. Các pixel còn lại giữ nguyên
    # texture/quỹ đạo do bộ fill sinh ra; vì vậy không xuất hiện sọc phẳng ở
    # vùng bleed nhưng pixel đầu tiên vẫn byte-level khớp màu nguồn.
    if left:
        result[top:top + height, left - 1] = img[:, 0]
    if right:
        result[top:top + height, left + width] = img[:, -1]
    if top:
        result[top - 1, left:left + width] = img[0]
    if bottom:
        result[top + height, left:left + width] = img[-1]

    # Bốn góc có thể được viết bởi hai dải độc lập; lấy đúng pixel góc nguồn
    # để tránh một điểm đổi màu ở giao điểm các cạnh.
    if top and left:
        result[top - 1, left - 1] = img[0, 0]
    if top and right:
        result[top - 1, left + width] = img[0, -1]
    if bottom and left:
        result[top + height, left - 1] = img[-1, 0]
    if bottom and right:
        result[top + height, left + width] = img[-1, -1]
    return result


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


def _compose_rgb_flattened_page(
    artwork_rgb: np.ndarray,
    bleed_rgb: np.ndarray,
    bleed_alpha: np.ndarray,
) -> np.ndarray | None:
    """Ghép artwork và bleed trên cùng lưới RGB để không có seam profile.

    Nguồn CMYK/DeviceN không ICC không thể chuyển ngược chính xác về plate.
    Khi đó, giữ Form CMYK bên dưới ảnh bleed RGB làm viewer/RIP áp hai phép
    diễn giải khác nhau tại đúng ranh giới trim. Nhánh này dùng riêng cho
    fallback đã được kiểm soát: hai lớp đã được PDFium render trên cùng lưới,
    nên ghép một lần ở RGB rồi xuất ảnh ICCBased sRGB duy nhất.
    """
    if (
        artwork_rgb is None
        or bleed_rgb is None
        or bleed_alpha is None
        or artwork_rgb.ndim != 3
        or bleed_rgb.ndim != 3
        or bleed_alpha.ndim != 2
        or artwork_rgb.shape[:2] != bleed_rgb.shape[:2]
        or artwork_rgb.shape[:2] != bleed_alpha.shape
        or artwork_rgb.shape[2] < 3
        or bleed_rgb.shape[2] < 3
    ):
        return None
    # Chỉ tạo một bản sao đích; không dựng thêm mảng alpha float cùng kích thước
    # toàn trang (khổ A0 300 DPI có thể chiếm hàng trăm MB).
    result = np.array(artwork_rgb[..., :3], dtype=np.uint8, copy=True, order="C")
    overlay = np.asarray(bleed_rgb[..., :3], dtype=np.uint8)
    alpha_u8 = np.asarray(bleed_alpha, dtype=np.uint8)
    active = alpha_u8 > 0
    if not np.any(active):
        return result
    # Ring hiện là mask nhị phân; gán trực tiếp là vừa đúng SMask vừa tránh
    # tạo buffer float khổng lồ. Giữ fallback alpha mềm cho fixture/tương lai.
    if np.all(alpha_u8[active] >= 255):
        result[active] = overlay[active]
        return result
    alpha = (alpha_u8[active].astype(np.float32) / 255.0)[:, None]
    blended = np.rint(
        overlay[active].astype(np.float32) * alpha
        + result[active].astype(np.float32) * (1.0 - alpha)
    )
    result[active] = np.clip(blended, 0.0, 255.0).astype(np.uint8)
    return result


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


def _build_bleed_color_work_band(
    bleed_ring: np.ndarray,
    band_radius: int,
) -> np.ndarray:
    """Dựng miền tính màu bao quanh SMask, không tham gia hình học hiển thị.

    PERF (audit 2026-08-10 §STICKER-COLOR.2): miền này chỉ chọn ô cần chạy
    nearest/inpaint; SMask ``bleed_ring`` mới quyết định pixel nhìn thấy. Kernel
    chữ nhật là tập bao của kernel ellipse cũ, giữ đủ toàn bộ miền an toàn nhưng
    OpenCV xử lý tách trục nhanh hơn nhiều trên tem khổ lớn.
    """
    radius = max(1, int(band_radius))
    kernel = cv2.getStructuringElement(
        cv2.MORPH_RECT,
        (radius * 2 + 1, radius * 2 + 1),
    )
    return cv2.dilate(bleed_ring, kernel)


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
        # Dùng profile sRGB đã kiểm tra danh tính; nếu bundle lỗi thì dựng fallback
        # bằng LittleCMS thay vì nhúng bytes không đúng vào vùng bleed.
        cms_profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))
        profile = pikepdf.Stream(pdf, cms_profile.tobytes())
        profile[pikepdf.Name("/N")] = 3
        profile[pikepdf.Name("/Alternate")] = pikepdf.Name.DeviceRGB
        return pikepdf.Array([pikepdf.Name("/ICCBased"), pdf.make_indirect(profile)])
    except Exception:
        logger.warning("Không thể nhúng ICC sRGB; dùng không gian màu dự phòng.")
        return pikepdf.Name.DeviceRGB


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
    join_overlap_pts: float = 0.0,
) -> tuple[list[str], float, float, float, float]:
    """Stretch vector edge/corner strips around a rectangular page.

    Unlike the contour/sticker path, this never filters white pixels and never
    converts process/ICC/spot colors to RGB. ``edge_bite_pts`` both moves the
    sampled strip and replaces the requested inner artwork strip. By contrast,
    ``sample_inset_pts`` only moves the source strip inward; it never widens the
    destination bleed or clips artwork. ``join_overlap_pts`` is a tiny, optional
    overlap used only when the strip is painted after the original artwork; it
    closes viewer/RIP anti-alias hairlines without changing the requested bleed
    size or the destructive edge bite. Returned bite values therefore describe
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
    try:
        join_overlap = float(join_overlap_pts)
    except (TypeError, ValueError):
        join_overlap = 0.0
    join_overlap = max(0.0, min(join_overlap, min(depth_x, depth_y)))
    draw_left = ext_left + (join_overlap if side_l else 0.0)
    draw_right = ext_right + (join_overlap if side_r else 0.0)
    draw_bottom = ext_bottom + (join_overlap if side_b else 0.0)
    draw_top = ext_top + (join_overlap if side_t else 0.0)
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
    place(0.0, ext_bottom, draw_left, out_h - ext_bottom - ext_top,
          sx_left, 1.0, -sx_left * src_left, y_identity_shift)
    place(out_w - draw_right, ext_bottom, draw_right, out_h - ext_bottom - ext_top,
          sx_right, 1.0, dst_right - sx_right * src_right, y_identity_shift)
    place(ext_left, 0.0, out_w - ext_left - ext_right, draw_bottom,
          1.0, sy_bottom, x_identity_shift, -sy_bottom * src_bottom)
    place(ext_left, out_h - draw_top, out_w - ext_left - ext_right, draw_top,
          1.0, sy_top, x_identity_shift, dst_top - sy_top * src_top)

    # Four corners. Keeping them as vector form draws preserves ICC/spot color.
    # ``place`` tự bỏ qua khi w/h <= 0 → cạnh tắt (ext = 0) không sinh góc.
    place(0.0, 0.0, draw_left, draw_bottom,
          sx_left, sy_bottom, -sx_left * src_left, -sy_bottom * src_bottom)
    place(out_w - draw_right, 0.0, draw_right, draw_bottom,
          sx_right, sy_bottom, dst_right - sx_right * src_right, -sy_bottom * src_bottom)
    place(0.0, out_h - draw_top, draw_left, draw_top,
          sx_left, sy_top, -sx_left * src_left, dst_top - sy_top * src_top)
    place(out_w - draw_right, out_h - draw_top, draw_right, draw_top,
          sx_right, sy_top, dst_right - sx_right * src_right, dst_top - sy_top * src_top)

    return commands, bite_left, bite_right, bite_bottom, bite_top


# ── Ngưỡng song song ─────────────────────────────────────────────────────
# Overhead spawn trên Windows ~2-3s/worker (child re-import cv2/scipy/skimage/
# pikepdf/pdfium). Với ~2s/trang, break-even ≈ 6 trang. File < ngưỡng chạy tuần
# tự tại chỗ (không spawn) để không chậm hơn.
_STICKER_PARALLEL_MIN_PAGES = 6

# Trần raster dùng CHUNG cho vòng lặp trang và cho hàm ước lượng RAM/worker. Hai chỗ
# lệch nhau thì ước lượng RAM sai ngay (audit 2026-08-16 §BX.P12).
_STICKER_MAX_LONG_PX = 6000
_STICKER_MAX_MEGAPIXELS = 28_000_000

# Tờ lớn tốn nhiều giây mỗi trang nên overhead spawn (~2–3s/worker) được bù ngay từ
# 2–3 trang. Ngưỡng 6 trang chỉ đúng cho trang cỡ tem/A4 (audit 2026-08-16 §BX.P08).
_STICKER_LARGE_PAGE_PT2 = 500_000.0  # ≈ 700×700 pt ≈ 247×247 mm
_STICKER_PARALLEL_MIN_PAGES_LARGE = 2

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
        # PERF (audit 2026-08-16 §BX.P06): bảng RAM chuẩn của dự án cho tier 8–16GB là
        # `min(cores, 4)`, không phải 2. Máy 12GB/8 nhân trước đây chỉ được 2 worker →
        # gần 2× thời gian, cùng dạng hồi quy §3.14 nhưng ở tier khác. `_cap_sticker_workers`
        # vẫn hạ tiếp theo RAM còn trống thật, nên đây là trần trên chứ không phải cam kết.
        workers, sticky, tier = min(cpu_workers, 4), 600.0, "mid"
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
        logger.debug(
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
        logger.debug(
            "[STICKER] pool crash but sticky disabled (ttl=0) — vẫn thử pool job sau"
        )
        return
    _sticky_sequential_until = time.time() + ttl
    logger.warning("[STICKER] Chuyển sang xử lý tuần tự sau lỗi worker.")


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
    if long_px > _STICKER_MAX_LONG_PX:
        s = float(_STICKER_MAX_LONG_PX) / long_px
        w, h = w * s, h * s
    mp = w * h
    if mp > _STICKER_MAX_MEGAPIXELS:
        s = (_STICKER_MAX_MEGAPIXELS / mp) ** 0.5
        w, h = w * s, h * s
    # ~10 byte/px peak (RGBA + mask + bleed buffers) + overhead process Windows.
    raster_mb = (w * h * 10.0) / (1024.0 * 1024.0)
    return max(200.0, raster_mb + 280.0)


def _n_pages_should_parallelize(
    n_pages: int, *, page_area_pt2: float | None = None
) -> bool:
    """True nếu nên fan-out song song (đủ nhiều trang để bù overhead spawn).

    STICKER_FORCE_SEQUENTIAL=1 → luôn tắt pool (debug OOM / crash worker).
    Sticky sequential sau pool crash → tắt tạm để in liên tục ổn định.

    PERF (audit 2026-08-16 §BX.P08): ngưỡng 6 trang được tính cho trang cỡ tem/A4
    (~2s/trang). Tờ lớn tốn nhiều giây mỗi trang nên trên máy tier ``full`` chỉ cần
    2 trang là đã bù được overhead spawn. Máy yếu vẫn giữ ngưỡng 6 — thêm process
    trên máy 8GB là đường vào swap, không phải tăng tốc.
    """
    if os.environ.get("STICKER_FORCE_SEQUENTIAL", "").lower() in ("1", "true", "yes"):
        return False
    if _sticky_sequential_active():
        left = max(0.0, _sticky_sequential_until - time.time())
        logger.debug(
            "[STICKER] skip parallel (sticky sequential, %.0fs left) pages=%d",
            left, n_pages,
        )
        return False
    threshold = _STICKER_PARALLEL_MIN_PAGES
    if (
        page_area_pt2 is not None
        and page_area_pt2 >= _STICKER_LARGE_PAGE_PT2
        and get_sticker_hw_profile().get("tier") == "full"
        and get_sticker_hw_profile().get("max_workers", 1) > 1
    ):
        threshold = _STICKER_PARALLEL_MIN_PAGES_LARGE
    return n_pages >= threshold


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
            logger.debug(
                "[STICKER] RAM cap workers %d→%d (avail_mb=%.0f per_worker_mb=%.0f "
                "budget_mb=%.0f page=%.0fx%.0fpt light=%s)",
                cap, by_ram, avail, per_worker, budget,
                page_w_pt, page_h_pt, light_path,
            )
        cap = min(cap, by_ram)
        if avail < 900:
            cap = 1
            logger.warning("[STICKER] Bộ nhớ khả dụng thấp; giảm số worker.")

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
    logger.debug(
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
            alpha_corner_policy=args.get("alpha_corner_policy", "legacy"),
            alpha_source_pixel_mm=args.get("alpha_source_pixel_mm"),
            alpha_source_mode=args.get("alpha_source_mode", False),
            cutline_smoothness=args.get("cutline_smoothness", 50),
            cutline_denoise=args.get("cutline_denoise", 0),
            cutline_fidelity=args.get("cutline_fidelity", 50),
            curve_tension=args.get("curve_tension", 50),
            min_detail_area_mm2=args.get(
                "min_detail_area_mm2",
                _MIN_CONTOUR_AREA_MM2,
            ),
            alpha_path_overrides=args.get("alpha_path_overrides"),
            approved_contour_overrides=args.get("approved_contour_overrides"),
            _page_subset=args["page_indices"],
        )
        # result = (bytes, metas, pages_no_dieline, any_dieline)
        logger.debug(
            "[STICKER] chunk done idx=%s pages=%s s=%.2f pid=%s",
            chunk_idx, pages, time.perf_counter() - t0, os.getpid(),
        )
        return (chunk_idx, result)
    except Exception as error:
        logger.error(
            "[STICKER] Xử lý chunk thất bại (loại=%s).",
            type(error).__name__,
        )
        raise


class StickerEngine:
    def __init__(self, dpi: int = 300, debug: bool = False):
        self.dpi = dpi
        self.scale = dpi / 72.0
        # SEC (audit 2026-09-05 §LOG.03): ảnh mask/bleed có thể chứa nội dung
        # khách hàng. Chỉ runtime dev thông dịch mới được bật bằng tham số hoặc
        # STICKER_DEBUG=1; binary release luôn fail-closed.
        self.debug = development_runtime_enabled() and (
            bool(debug) or development_diagnostic_enabled("STICKER_DEBUG")
        )

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
        alpha_corner_policy: str = "legacy",
        alpha_source_pixel_mm: float | None = None,
        alpha_source_mode: bool = False,
        cutline_smoothness: float | int = _CUTLINE_TUNING_DEFAULT,
        cutline_fidelity: float | int = _CUTLINE_TUNING_DEFAULT,
        curve_tension: float | int = _CUTLINE_TUNING_DEFAULT,
        # §CUTJAG.3: 0 = tắt để mọi caller cũ giữ nguyên kết quả từng byte.
        cutline_denoise: float | int = 0.0,
        min_detail_area_mm2: float = _MIN_CONTOUR_AREA_MM2,
        alpha_path_overrides: dict[int, dict] | None = None,
        approved_contour_overrides: dict[int, dict] | None = None,
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
        bleed_color_type = str(bleed_color_type or "image").strip().lower()
        alpha_corner_policy = (
            "adaptive" if alpha_corner_policy == "adaptive" else "legacy"
        )
        try:
            alpha_source_pixel_mm = float(alpha_source_pixel_mm)
            if not math.isfinite(alpha_source_pixel_mm) or alpha_source_pixel_mm <= 0:
                alpha_source_pixel_mm = None
        except (TypeError, ValueError):
            alpha_source_pixel_mm = None
        cutline_smoothness = _clamp_cutline_percent(cutline_smoothness)
        cutline_fidelity = _clamp_cutline_percent(cutline_fidelity)
        curve_tension = _clamp_cutline_percent(curve_tension)
        try:
            min_detail_area_mm2 = float(min_detail_area_mm2)
        except (TypeError, ValueError):
            min_detail_area_mm2 = _MIN_CONTOUR_AREA_MM2
        if not math.isfinite(min_detail_area_mm2):
            min_detail_area_mm2 = _MIN_CONTOUR_AREA_MM2
        min_detail_area_mm2 = max(0.0, min(25.0, min_detail_area_mm2))
        raw_alpha_path_overrides = (
            alpha_path_overrides if isinstance(alpha_path_overrides, dict) else {}
        )
        alpha_path_overrides = {
            int(page_index): payload
            for page_index, payload in raw_alpha_path_overrides.items()
            if isinstance(payload, dict)
        }
        raw_approved_contour_overrides = (
            approved_contour_overrides
            if isinstance(approved_contour_overrides, dict)
            else {}
        )
        approved_contour_overrides = {
            int(page_index): payload
            for page_index, payload in raw_approved_contour_overrides.items()
            if isinstance(payload, dict)
        }
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
        # QUALITY (audit 2026-08-08 §UNIFIED.ALPHA1): nguồn biên và vị trí dao là
        # hai hợp đồng độc lập. Session nhận diện luôn chuyển silhouette thành PNG
        # Alpha; ``original`` phải đọc Alpha đó nhưng không được tự lùi dao 0,15 mm.
        alpha_source_contour = alpha_contour_mode or bool(alpha_source_mode)
        if alpha_contour_mode:
            # Alpha là silhouette đã chủ đích của PNG; không tái dựng thành hình
            # chuẩn và không bo lại contour của khách.
            corner_style = "preserve"
            shape_mode = "contour"

        corner_style = str(corner_style or "round").strip().lower()
        preserve_contour = corner_style in {"preserve", "original"}
        if preserve_contour:
            # QUALITY (audit 2026-08-07 §NOODLE.2): kiểu góc và chế độ nhận hình
            # là hai hợp đồng độc lập. `forceContour`/Alpha đã gửi `contour`; còn
            # `auto_safe + preserve` vẫn phải được thử nhận hình chuẩn như UI mô tả.
            corner_style = "preserve"
        doc_in_pdfium = None
        page_in = None
        doc_in_pike = None
        doc_out = None
        canonical_input_path = None
        canonical_input_is_temp = False
        try:
            debug_step = "Open Original PDF"
            if _page_subset is None:
                # ROTATE (feedback 2026-08-25 §STICKER.ROT1): pdf-lib materialize
                # thao tác xoay bằng `/Rotate`. PDFium nhìn khổ đã xoay, nhưng
                # CropBox/as_form_xobject vẫn ở hệ thô; nếu không bake trước thì
                # canvas và Form lệch 90°, làm mất nội dung và sinh mảng trắng.
                debug_step = "Canonicalize Page Rotation"
                canonical_input_path, canonical_input_is_temp = (
                    canonicalize_page_space_file(
                        input_path,
                        f"sticker-{os.getpid()}",
                    )
                )
                input_path = canonical_input_path

            with pdfium_guard():
                doc_in_pdfium = pdfium.PdfDocument(input_path)
                pdfium_page_count = len(doc_in_pdfium)
            doc_in_pike = pikepdf.Pdf.open(input_path)
            # COLOR (audit 2026-08-24 §BCOLOR.02): nguồn CMYK/DeviceN không ICC
            # không có đủ provenance để dựng lại plate màu. Với bù xén raster,
            # dùng render PDFium RGB chung cho artwork và bleed để tránh mixed-space seam.
            source_color_provenance = describe_pdf_color_provenance(doc_in_pike)
            unprofiled_process_color_fallback = (
                source_color_provenance.get("profile_state")
                in {"untagged-device-cmyk", "malformed"}
                and bool(
                    source_color_provenance.get("has_device_cmyk")
                    or source_color_provenance.get("has_devicen")
                )
                and not bool(source_color_provenance.get("has_embedded_cmyk_profile"))
            )
            if unprofiled_process_color_fallback:
                logger.warning(
                    "[STICKER] %s: nguồn CMYK/DeviceN thiếu ICC; giữ bleed RGB "
                    "theo render PDFium để tránh seam màu",
                    (
                        COLOR_DEVICEN_FALLBACK_WARNING
                        if source_color_provenance.get("has_devicen")
                        else COLOR_DEVICE_CMYK_FALLBACK_WARNING
                    ),
                )
            color_warning_codes = [
                str(item)
                for item in source_color_provenance.get("warnings", [])
                if item
            ]
            if (
                unprofiled_process_color_fallback
                and source_color_provenance.get("has_device_cmyk")
                and not source_color_provenance.get("has_devicen")
                and COLOR_DEVICE_CMYK_FALLBACK_WARNING not in color_warning_codes
            ):
                color_warning_codes.append(COLOR_DEVICE_CMYK_FALLBACK_WARNING)
            if (
                source_color_provenance.get("has_devicen")
                and unprofiled_process_color_fallback
                and COLOR_DEVICEN_FALLBACK_WARNING not in color_warning_codes
            ):
                color_warning_codes.append(COLOR_DEVICEN_FALLBACK_WARNING)
            invalid_pages = sorted(page for page in selection_targets if page >= pdfium_page_count)
            if invalid_pages:
                raise ValueError(
                    "Selection tham chiếu trang không tồn tại: "
                    + ", ".join(str(page + 1) for page in invalid_pages)
                )

            if process_page_indexes is not None:
                invalid_process_pages = sorted(
                    page for page in process_page_indexes if page >= pdfium_page_count
                )
                if invalid_process_pages:
                    raise ValueError("Danh sách trang xử lý tham chiếu trang không tồn tại.")

            adaptive_page_indexes = (
                list(_page_subset)
                if _page_subset is not None
                else (
                    sorted(process_page_indexes)
                    if process_page_indexes is not None
                    else list(range(len(doc_in_pike.pages)))
                )
            )
            if alpha_corner_policy == "adaptive":
                # QUALITY (audit 2026-08-05 §EXISTING.CUT1): file đã có spot
                # CutContour phải giữ đúng hành vi legacy; nâng cấp này chỉ làm
                # mượt contour raster mới sinh, không tái diễn giải khuôn vector.
                if _document_defines_cut_contour(
                    doc_in_pike,
                    adaptive_page_indexes,
                ):
                    alpha_corner_policy = "legacy"
                    logger.debug(
                        "[STICKER] giữ legacy vì PDF nguồn đã có CutContour"
                    )
                elif alpha_source_pixel_mm is None:
                    alpha_source_pixel_mm = _infer_document_image_pixel_mm(
                        doc_in_pike,
                        adaptive_page_indexes,
                    )
                    if alpha_source_pixel_mm is not None:
                        logger.debug(
                            "[STICKER] nhận diện ảnh toàn trang: source_pixel_mm=%.5f",
                            alpha_source_pixel_mm,
                        )
            # ── ORCHESTRATOR: song song hóa khi gọi top-level + file nhiều trang ──
            # _page_subset None = gọi top-level (không phải worker). File >= ngưỡng →
            # chia dải trang liền kề cho nhiều tiến trình con, mỗi con tự mở lại file
            # + xử lý chunk + trả file PDF, rồi merge ở đây. Overhead spawn Windows
            # ~2-3s/worker nên file nhỏ (< ngưỡng) chạy tuần tự tại chỗ (rơi xuống dưới).
            # PERF (audit 2026-08-16 §BX.P08): diện tích trang đầu chỉ để CHỌN NGƯỠNG
            # song song (tờ lớn thì 2 trang đã đáng spawn). Ngân sách RAM/worker vẫn được
            # `_process_parallel` đo lại theo trang lớn nhất, không tin con số này.
            first_page_area_pt2: float | None = None
            if _page_subset is None and pdfium_page_count > 0:
                try:
                    with pdfium_guard():
                        _probe_first = doc_in_pdfium[0]
                        try:
                            _pw, _ph = _probe_first.get_size()
                        finally:
                            _probe_first.close()
                    first_page_area_pt2 = float(_pw) * float(_ph)
                except Exception:
                    first_page_area_pt2 = None
            if (
                _page_subset is None
                and not selection_mode
                and process_page_indexes is None
                and _n_pages_should_parallelize(
                    pdfium_page_count, page_area_pt2=first_page_area_pt2
                )
            ):
                n_pages_probe = pdfium_page_count
                try:
                    input_mb = os.path.getsize(input_path) / (1024 * 1024)
                except OSError:
                    input_mb = 0.0
                logger.debug(
                    "[STICKER] parallel fan-out pages=%d input_mb=%.2f rectangle=%s "
                    "bleed_mm=%s cut_mode=%s dpi=%s",
                    n_pages_probe, input_mb, rectangle_mode, bleed_mm, cut_mode,
                    self.dpi,
                )
                with pdfium_guard():
                    doc_in_pdfium.close()
                doc_in_pdfium = None
                doc_in_pike.close(); doc_in_pike = None
                # Nhãn đúng bước (trước đây lỗi pool vẫn dính "Open Original PDF@…").
                debug_step = "Process Parallel Workers"
                parallel_success, parallel_meta = self._process_parallel(
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
                    alpha_corner_policy=alpha_corner_policy,
                    alpha_source_pixel_mm=alpha_source_pixel_mm,
                    alpha_source_mode=alpha_source_contour,
                    cutline_smoothness=cutline_smoothness,
                    cutline_fidelity=cutline_fidelity,
                    curve_tension=curve_tension,
                    min_detail_area_mm2=min_detail_area_mm2,
                    alpha_path_overrides=alpha_path_overrides,
                    approved_contour_overrides=approved_contour_overrides,
                )
                if isinstance(parallel_meta, dict):
                    parallel_meta["color_provenance"] = dict(source_color_provenance)
                    parallel_meta["color_warnings"] = list(color_warning_codes)
                return parallel_success, parallel_meta

            debug_step = "Create Output PDF"
            doc_out = pikepdf.Pdf.new()
            # Worker chunks are merged into a fresh document later; only the
            # top-level sequential path copies catalog-level output profiles here.
            if _page_subset is None:
                copy_output_intents(doc_in_pike, doc_out)
            
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
            # COLOR (audit 2026-08-24 §BCOLOR.08): hỗn hợp DeviceN + CMYK
            # không có ICC không thể flatten mà vẫn giữ màu nội dung gốc. Với
            # đúng ca này, kéo dải bằng Form/vector cùng colorspace; edge bite
            # vẫn giữ để mối nối ngoài mép không hở.
            safe_vector_process_color_fallback = bool(
                unprofiled_process_color_fallback
                and source_color_provenance.get("has_devicen")
                and source_color_provenance.get("has_device_cmyk")
            )
            use_vector_rectangle_bleed = (
                rectangle_mode
                and bleed_pts > 0
                and (bleed_color_type == "image" or safe_vector_process_color_fallback)
            )
            # Nguồn thiếu ICC nhưng không thuộc fallback vector an toàn vẫn flatten
            # trajectory/inpaint trên cùng lưới RGB; mixed DeviceN+CMYK đã được
            # loại ở trên để không đổi màu phần nội dung chính.
            flatten_unprofiled_process_color = bool(
                unprofiled_process_color_fallback
                and rectangle_mode
                and bleed_color_type in {"trajectory", "inpaint"}
                and not use_vector_rectangle_bleed
            )
            srgb_colorspace = None
            srgb_output_intent_embedded = False
            
            all_pages_meta = []
            any_dieline_found = False
            pages_no_dieline = []
            # QUALITY (audit 2026-08-06 §BG.1): trang thất bại vì nền không trắng.
            pages_white_bg_failed = []

            _n_pages = pdfium_page_count
            # Danh sách trang cần xử lý: subset (worker song song) hoặc toàn bộ.
            _page_list = list(_page_subset) if _page_subset is not None else list(range(_n_pages))

            for page_idx in _page_list:
                page_started = time.perf_counter()
                raster_seconds = 0.0
                contour_seconds = 0.0
                selected_peel_px = None
                gs_seconds = 0.0
                smooth_seconds = 0.0
                compress_seconds = 0.0
                alpha_fallback_used = False
                alpha_contour_warning = None
                # QUALITY (audit 2026-08-06 §BG.1): nhánh bóc nền trắng không tách
                # được nền (nền màu / trắng ngà) → đánh dấu để cảnh báo đúng lý do.
                white_bg_detect_failed = False
                # QUALITY (audit 2026-08-06 §BG.2): nền MÀU dò được (nếu có) —
                # dùng để cảnh báo thợ soi lại đường cắt.
                color_bg_detected: BackgroundInfo | None = None
                # §BG.6b: mask nền trắng do engine tự dựng từ ngưỡng cứng.
                white_bg_mask_built = False
                # QUALITY (feedback 2026-08-19 §PAGEBOX-BLEED.1): ghi riêng nhánh
                # người dùng giữ nền để phần bù xén có thể theo cung CutContour,
                # không biến mọi mask kín trang khác thành page-box.
                page_box_mask_built = False
                page_box_corner_background_rgb = None
                page_box_corner_background_tolerance = 0
                approved_contour_source = None
                approved_alpha_mask = None
                approved_override_result = None
                approved_contour_page = False
                approved_edge_background_rgb = None
                approved_edge_background_tolerance = 0
                alpha_edge_background_rgb = None
                alpha_edge_background_tolerance = 0
                debug_step = f"Rasterize Page {page_idx}"
                with pdfium_guard():
                    if page_in is not None:
                        page_in.close()
                    page_in = doc_in_pdfium[page_idx]
                page_in_pike = doc_in_pike.pages[page_idx]
                selection_page_mode = page_idx in selection_targets
                approved_payload = approved_contour_overrides.get(page_idx)
                alpha_path_payload = alpha_path_overrides.get(page_idx)
                alpha_background = _approved_edge_background(alpha_path_payload)
                if alpha_background is not None:
                    (
                        alpha_edge_background_rgb,
                        alpha_edge_background_tolerance,
                    ) = alpha_background
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
                MAX_LONG_PX = _STICKER_MAX_LONG_PX
                # PERF (audit 2026-08-16 §BX.P12): 40M từng là NHÁNH CHẾT — cạnh dài đã
                # kẹp 6000px nên tổng luôn ≤36M với mọi tỉ lệ trang, tức trần cũ chưa từng
                # ràng buộc. Hằng số dùng chung với `_estimate_worker_ram_mb` để ước lượng
                # RAM/worker không lệch khỏi kích thước raster thật.
                MAX_MEGAPIXELS = _STICKER_MAX_MEGAPIXELS
                base_scale = self.dpi / 72.0
                # PERF (audit 2026-08-19 §STK.MEM01): suy lưới ảnh NGUỒN trước
                # khi chọn scale. Trang một ảnh phủ kín không được nội suy 72 DPI
                # lên 300 DPI chỉ để marching-squares cấp một mảng float64 214 MiB.
                try:
                    source_pixel_mm_page = _infer_full_page_image_pixel_mm(
                        page_in_pike
                    )
                except Exception:
                    source_pixel_mm_page = None
                approved_boundary_source = (
                    str(approved_payload.get("boundary_source") or "").lower()
                    if isinstance(approved_payload, dict)
                    else ""
                )
                source_scale_limit = (
                    _source_raster_scale_limit(source_pixel_mm_page)
                    if approved_boundary_source in {"ai", "simple-bg"}
                    else None
                )
                try:
                    with pdfium_guard():
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
                resource_limited_scale = base_scale * shrink
                source_grid_limited = bool(
                    source_scale_limit is not None
                    and source_scale_limit < resource_limited_scale - 1e-9
                )
                self.scale = (
                    min(resource_limited_scale, source_scale_limit)
                    if source_scale_limit is not None
                    else resource_limited_scale
                )
                # px/mm THỰC TẾ của raster: self.scale là px/point (đã gồm shrink khi trang
                # bị DPI-cap), nên px/mm = scale × 72/25.4. MỌI morphology bù xén PHẢI dùng
                # số này, KHÔNG dùng self.dpi/25.4 (bỏ qua shrink → phóng đại 1/shrink lần khi
                # trang lớn: hút màu quá sâu, đóng lỗ/lẹm mép quá tay, lệch bleed_mask).
                px_per_mm = self.scale * 72.0 / 25.4
                if shrink < 1.0:
                    # PERF (audit 2026-08-16 §BX.P05): trước đây chỉ log khi self.debug,
                    # nên trên bản phát hành không ai biết tờ lớn đang bị hạ về ~95–152 DPI.
                    # DPI thực của đường cắt là thông tin nghiệp vụ, phải có trong log.
                    logger.debug(
                        "[STICKER] DPI cap page %d: %.0f→%.0f DPI (scale %.4f→%.4f, trang %.0fx%.0f pt)",
                        page_idx + 1, float(self.dpi), self.dpi * shrink,
                        base_scale, self.scale, pw_pt, ph_pt,
                    )
                if source_grid_limited:
                    logger.debug(
                        "[STICKER] source-grid page %d: %.0f→%.0f DPI "
                        "(scale %.4f→%.4f, source_pixel_mm=%.6f)",
                        page_idx + 1,
                        resource_limited_scale * 72.0,
                        self.scale * 72.0,
                        resource_limited_scale,
                        self.scale,
                        source_pixel_mm_page,
                    )

                raster_started = time.perf_counter()
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

                    if selection_page_mode:
                        pass
                    elif img_native is not None:
                        img = cv2.cvtColor(img_native, cv2.COLOR_RGB2RGBA)
                        has_alpha = False
                    else:
                        if alpha_source_contour:
                            # PDF trung gian của PNG giữ Alpha trong /SMask. Render
                            # nền trong suốt để lấy lại silhouette, không composite trắng.
                            with pdfium_guard():
                                bitmap = page_in.render(
                                    scale=self.scale,
                                    fill_color=(0, 0, 0, 0),
                                    rev_byteorder=True,
                                )
                                try:
                                    img = np.array(bitmap.to_numpy(), copy=True)
                                finally:
                                    bitmap.close()
                            if img.ndim != 3 or img.shape[2] != 4:
                                raise RuntimeError("PDFium không trả về ảnh RGBA cho contour Alpha.")
                            img_native = img[:, :, :3].copy()
                        else:
                            with pdfium_guard():
                                bitmap = page_in.render(scale=self.scale)
                                try:
                                    img_bgra = np.array(bitmap.to_numpy(), copy=True)
                                finally:
                                    bitmap.close()
                            img = cv2.cvtColor(img_bgra, cv2.COLOR_BGRA2RGBA)
                            img_native = cv2.cvtColor(img_bgra, cv2.COLOR_BGRA2RGB)
                        has_alpha = (
                            img.shape[2] == 4
                            and img[:, :, 3].min() < 255
                            and img[:, :, 3].max() > 10
                        )
                raster_seconds = time.perf_counter() - raster_started
                if approved_payload is not None:
                    approved = _approved_contour_override(
                        approved_payload,
                        img.shape[:2],
                    )
                    if approved is None:
                        raise ValueError(
                            f"Trang {page_idx + 1}: Alpha/đường bế đã duyệt không hợp lệ."
                        )
                    (
                        approved_alpha_mask,
                        source_pixel_mm_page,
                        approved_contour_source,
                        approved_override_result,
                    ) = approved
                    approved_background = _approved_edge_background(
                        approved_payload
                    )
                    if approved_background is not None:
                        (
                            approved_edge_background_rgb,
                            approved_edge_background_tolerance,
                        ) = approved_background
                    approved_contour_page = True
                if page_idx == 0 and self.debug:
                    logger.debug(">>> PARAMS: cut_mode=%s offset_mm=%.2f bleed_mm=%.2f corner_style=%s remove_white_bg=%s bleed_color_type=%s fill_holes=%s", cut_mode, offset_mm, bleed_mm, corner_style, remove_white_bg, bleed_color_type, fill_holes)
                    logger.debug(">>> IMAGE: shape=%s has_alpha=%s", img.shape, has_alpha)
                
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
                    if approved_contour_page:
                        # §LEGACY-AI.2: giữ PDF gốc để không raster hóa/mất màu in;
                        # chỉ thay đúng Alpha hình học bằng artifact AI đã duyệt.
                        base_mask = approved_alpha_mask.copy()
                    elif alpha_source_contour and has_alpha:
                        base_mask = img[:, :, 3].copy()
                    elif alpha_source_contour:
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
                            # Chỉ coi là "trắng nền" khi CẢ BA kênh RGB gần trắng
                            # tuyệt đối. Không dùng saturation HSV: nó không phân biệt
                            # được xám trung tính nhạt với trắng, nên màu nền nhạt
                            # (vẫn LÀ nội dung nhãn) từng bị bóc nhầm.
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
                            # QUALITY (audit 2026-08-07 §NOODLE.14): khi thợ chủ ý
                            # tắt "lấp lỗ", mọi vùng kín cùng màu nền phải là hole.
                            # Mặc định fill_holes=true vẫn giữ logic cũ để mực trắng
                            # nội bộ không bị đục ngoài ý muốn.
                            white_to_remove = white_mask if not fill_holes else bg_white
                            base_mask = cv2.bitwise_not(white_to_remove)
                            # §BG.6b: mask này do engine tự dựng từ ngưỡng cứng
                            # → nhị phân thuần, cần trả lại dải chuyển tiếp.
                            white_bg_mask_built = True
                            # QUALITY (audit 2026-08-06 §BG.1): nếu không bóc được
                            # gì (nền màu, hoặc trắng ngà do nén JPEG) thì bg_white
                            # rỗng → base_mask toàn 255 → contour duy nhất tìm được
                            # là MÉP TRANG, tức đường cắt ôm trọn khổ. Trước đây lỗi
                            # này đi thẳng ra xưởng, không một lời cảnh báo. Nay coi
                            # trang này là KHÔNG dò được hình → trang vào
                            # pages_no_dieline, có cảnh báo; nếu KHÔNG trang nào dò
                            # được thì engine trả lỗi nghiệp vụ 422.
                            #
                            # Đo trên bg_white (phần NỀN bóc được), KHÔNG đo trên
                            # foreground: tem bo góc chiếm gần trọn khổ là ca ĐÚNG
                            # và hợp lệ (nền chỉ còn bốn góc), nên trần "foreground
                            # ≤ 98%" của nhánh dò nền bốn góc sẽ bắt oan nó.
                            if (
                                cut_mode != "none"
                                and _foreground_ratio(bg_white)
                                < _BG_FOREGROUND_RATIO_MIN
                            ):
                                # QUALITY (audit 2026-08-06 §BG.2): trước khi
                                # bỏ cuộc, thử dò nền theo MÀU ở bốn góc — nền
                                # màu phẳng và trắng ngà do nén JPEG đều rơi
                                # vào đây. Đặt SAU nhánh trắng (không đặt
                                # trước) để mọi ca đang chạy đúng giữ nguyên
                                # từng điểm ảnh; chỉ ca trước đây HỎNG mới đi
                                # đường mới.
                                bg_info = detect_background(img[:, :, :3])
                                if bg_info is not None:
                                    base_mask = bg_info.foreground_mask
                                    if not fill_holes and bg_info.is_flat:
                                        rgb = img[:, :, :3].astype(np.int16)
                                        background_rgb = np.asarray(
                                            bg_info.color,
                                            dtype=np.int16,
                                        )
                                        same_background = np.max(
                                            np.abs(rgb - background_rgb),
                                            axis=2,
                                        ) <= bg_info.tolerance
                                        base_mask = (
                                            (~same_background).astype(np.uint8) * 255
                                        )
                                    color_bg_detected = bg_info
                                    logger.debug(
                                        "[STICKER_BG] page=%d dò nền theo màu "
                                        "rgb=%s tolerance=%d confidence=%.2f",
                                        page_idx + 1,
                                        bg_info.color,
                                        bg_info.tolerance,
                                        bg_info.confidence,
                                    )
                                else:
                                    base_mask = np.zeros(
                                        img.shape[:2], dtype=np.uint8
                                    )
                                    white_bg_detect_failed = True
                        else:
                            base_mask = np.ones(img.shape[:2], dtype=np.uint8) * 255
                            page_box_mask_built = True

                    if alpha_source_contour or approved_contour_page:
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
                        # QUALITY (audit 2026-08-07 §BG.5): NGOẠI LỆ — mask do dò
                        # nền theo màu/gradient là do engine TỰ DỰNG, nhị phân
                        # thuần, thiếu dải chuyển tiếp mà marching-squares cần để
                        # nội suy → đường cắt bậc thang trên tem lớn. Trả lại dải
                        # đó. Không phải "bo góc": bề rộng 0,05 mm nhỏ hơn dung
                        # sai bế, và alpha thật KHÔNG đi nhánh này (đã có vành AA
                        # sẵn trong kênh alpha) nên silhouette của khách vẫn nguyên.
                        if color_bg_detected is not None:
                            aa_mask = _feather_mask_tu_dung(aa_mask, px_per_mm)
                    elif corner_style == "round":
                        aa_mask = cv2.GaussianBlur(mask, (7, 7), 0)
                    else:
                        aa_mask = mask.copy()
                        clean_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
                        aa_mask = cv2.morphologyEx(aa_mask, cv2.MORPH_OPEN, clean_kernel)
                        aa_mask = cv2.morphologyEx(aa_mask, cv2.MORPH_CLOSE, clean_kernel)
                        # §BG.5: morphology chỉ dọn đốm, KHÔNG tạo dải chuyển tiếp
                        # — mask vẫn nhị phân. Mask tự dựng vẫn cần bù như trên.
                        if color_bg_detected is not None:
                            aa_mask = _feather_mask_tu_dung(aa_mask, px_per_mm)

                    # §BG.6b: mask riêng cho marching-squares. KHÔNG ghi đè
                    # `aa_mask` — nó còn là nguồn màu cho bù xén (§BG.4), đo thấy
                    # ghi đè làm lệch tới −5,4% diện tích trên tem nhỏ.
                    contour_mask = aa_mask
                    contour_pixel_to_pt = 1.0 / self.scale
                    if (
                        white_bg_mask_built
                        and not alpha_source_contour
                        and not approved_contour_page
                    ):
                        contour_mask = _lam_mem_dai_bien(
                            aa_mask,
                            img,
                            px_per_mm,
                            source_pixel_mm_page,
                        )
                    elif (
                        alpha_source_contour or approved_contour_page
                    ) and source_pixel_mm_page is not None:
                        # QUALITY (audit 2026-08-08 §AI-MOTION.4): PDF trung gian
                        # của Ảnh AI có thể chứa ảnh 72 DPI nhưng được raster lại ở
                        # 300 DPI. Fit trên mask đã phóng 4,17× sẽ khóa từng bậc nội
                        # suy thành node/góc giả. Quy contour về đúng lưới pixel
                        # nguồn; aa_mask độ phân giải render vẫn giữ nguyên cho bleed.
                        source_to_render = source_pixel_mm_page * px_per_mm
                        # §AI-MOTION.6: chỉ quy về lưới nguồn khi ảnh thô bị phóng
                        # ít nhất 3× (xấp xỉ <=100 DPI ở raster 300 DPI). Với ảnh
                        # 150 DPI, việc hạ 2× làm biên lượng tử lệch thêm nửa pixel
                        # nguồn và phá hợp đồng lùi 0,15 mm dù fitter vốn đã đủ sạch.
                        if source_to_render >= 3.0:
                            contour_width = max(
                                3,
                                int(round(contour_mask.shape[1] / source_to_render)),
                            )
                            contour_height = max(
                                3,
                                int(round(contour_mask.shape[0] / source_to_render)),
                            )
                            contour_mask = cv2.resize(
                                contour_mask,
                                (contour_width, contour_height),
                                interpolation=cv2.INTER_AREA,
                            )
                            _, contour_mask = cv2.threshold(
                                contour_mask,
                                127,
                                255,
                                cv2.THRESH_BINARY,
                            )
                            contour_pixel_to_pt = (
                                source_pixel_mm_page * _PT_PER_MM
                            )
                    # §CUTJAG.3: thanh "Khử răng cưa" áp ĐÚNG ở đây — mask đi vào
                    # marching-squares. Không ghi đè `aa_mask` vì nó còn là nguồn màu
                    # cho bù xén (§BG.4, đo thấy ghi đè lệch tới −5,4% diện tích).
                    contour_mask = denoise_cutline_mask(
                        contour_mask,
                        amount=cutline_denoise,
                        # `contour_mask` có thể đã được quy về lưới pixel NGUỒN ở trên,
                        # nên mật độ phải suy từ `contour_pixel_to_pt`, không dùng
                        # `px_per_mm` của khung render.
                        px_per_mm=_PT_PER_MM / max(1e-9, contour_pixel_to_pt),
                    )
                    aa_mask_padded = np.pad(contour_mask, pad_width=1, mode='constant', constant_values=0)

                    debug_step = f"Find Contours Page {page_idx}"
                    from skimage import measure
                    contour_started = time.perf_counter()
                    contours = measure.find_contours(aa_mask_padded, 127.5)
                    contour_seconds = time.perf_counter() - contour_started
                
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
                flattened_page_rgb = None
                flattened_img_name = None
                flattened_img_w_pt = 0.0
                flattened_img_h_pt = 0.0
                flattened_shift_x = 0.0
                flattened_shift_y = 0.0
                color_render_strategy = "vector-original"
                bleed_quality_warning = None
                
                # ============================================================
                # STEP A: Compute dieline_poly FIRST (needed for bleed mask)
                # ============================================================
                dieline_poly = None
                cut_poly = None
                bleed_outer_poly = None
                artwork_footprint_poly = None
                page_box_round_footprint_poly = None
                dieline_polygons = []
                total_offset = 0
                bleed_outer_offset = 0
                page_shape_mode = "contour" if approved_contour_page else shape_mode
                recon_meta = {
                    "shape_mode": page_shape_mode,
                    "reconstructed": False,
                }
                cut_draw_style = corner_style
                cut_draw_tension = 0.33
                cut_fitted_paths = None
                
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
                        logger.debug(
                            ">>> RECTANGLE MODE: page %.1fx%.1f pt, bleed_pts=%.2f, sides=%s",
                            page_in_width, page_in_height, bleed_pts,
                            ",".join(bleed_sides_to_names(bleed_sides_resolved)) or "none",
                        )
                
                elif cut_mode != "none" and len(contours) > 0:
                    debug_step = f"Process Contours Page {page_idx}"
                    poly_scale = contour_pixel_to_pt
                    
                    raw_polys = []
                    # §BG.6: ngưỡng tính trong không gian POINT vì contour_pts đã
                    # đổi sang pt (poly_scale = 1/scale).
                    min_area_pt2 = (
                        min_detail_area_mm2 * _PT_PER_MM * _PT_PER_MM
                    )
                    dropped_specks = 0
                    speck_polys = []
                    for contour in contours:
                        contour = contour - 1
                        contour_pts = contour[:, [1, 0]] * poly_scale
                        
                        # Chỉ làm mượt khi góc TRÒN. Với góc nhọn/vuông (miter),
                        # smoothing sẽ bo mềm các góc đáng lẽ phải sắc → sai kiểu góc.
                        if corner_style == "round" and len(contour_pts) >= 10:
                            # QUALITY (audit 2026-08-07 §NOODLE.1): cửa sổ theo
                            # mm vật lý và pixel ảnh nguồn; helper dùng chung cho
                            # probe auto_safe để mọi nhánh đo cùng một đại lượng.
                            contour_pts = _smooth_round_contour_points(
                                contour_pts,
                                source_pixel_mm=source_pixel_mm_page,
                                contour_px_per_mm=px_per_mm,
                            )

                        if len(contour_pts) >= 3:
                            poly = Polygon(contour_pts)
                            if poly.is_valid:
                                # §BG.6: bỏ contour vụn do nhiễu nén, trước khi
                                # simplify (simplify không đổi thứ hạng diện tích).
                                if poly.area < min_area_pt2:
                                    dropped_specks += 1
                                    speck_polys.append(poly)
                                    continue
                                if not preserve_contour:
                                    # §ROUND-PATH.1: Góc tròn cần giữ đủ mẫu để spline
                                    # C2 bám biên. 0,1 pt cũ làm mất quỹ đạo trước khi
                                    # fitter chạy; kiểu góc thẳng vẫn giữ hợp đồng cũ.
                                    reference_simplify_pts = (
                                        _ROUND_PATH_REFERENCE_SIMPLIFY_MM * _PT_PER_MM
                                        if corner_style == "round"
                                        else 0.1
                                    )
                                    poly = poly.simplify(
                                        reference_simplify_pts,
                                        preserve_topology=True,
                                    )
                                raw_polys.append(poly)
                                
                    if not raw_polys and speck_polys:
                        # §BG.6: mọi contour đều dưới ngưỡng → hoặc tem thật sự
                        # bé hơn 1 mm² (không có thật trong nghề), hoặc mask hỏng.
                        # Giữ lại contour lớn nhất để không mất trắng đường cắt.
                        raw_polys = [max(speck_polys, key=lambda p: p.area)]
                        dropped_specks = max(0, dropped_specks - 1)
                    if raw_polys:
                        if dropped_specks:
                            logger.debug(
                                "[STICKER_BG] page=%d §BG.6 bỏ %d contour vụn "
                                "(< %.2f mm²) do nhiễu nén",
                                page_idx + 1, dropped_specks, min_detail_area_mm2,
                            )
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

                        # QUALITY (audit 2026-08-07 §NOODLE.1): ngưỡng 1 mm²
                        # không đủ cho ảnh JPEG phóng lên ~805 mm. Chỉ lọc halo
                        # khi đã chứng minh trang là một ảnh phủ kín và mask đến
                        # từ nền trắng; ảnh nhiều object/nền màu giữ nguyên.
                        dropped_halo = 0
                        if (
                            white_bg_mask_built
                            and color_bg_detected is None
                            and source_pixel_mm_page is not None
                        ):
                            exteriors, dropped_halo = _filter_full_page_jpeg_halo_components(
                                exteriors,
                                source_pixel_mm_page,
                                image_rgb=img[:, :, :3],
                                geometry_px_per_point=self.scale,
                            )
                        if dropped_halo:
                            logger.debug(
                                "[STICKER_BG] page=%d §NOODLE.1 bỏ %d mảnh JPEG "
                                "mảnh bám sát silhouette chính",
                                page_idx + 1,
                                dropped_halo,
                            )
                                
                        base_dieline = unary_union(exteriors)
                        if not fill_holes:
                            for h in holes:
                                base_dieline = base_dieline.difference(h)
                        # Giữ bản hình học đã bỏ mảnh JPEG nhưng chưa reconstruct để
                        # clip artwork/ghép bleed. Raw mask còn halo rời nên không thể
                        # là nguồn footprint sau khi đường cắt đã dùng contour sạch.
                        artwork_footprint_poly = base_dieline

                        # Reconstruct hình học chuẩn (auto_safe / force_*) theo
                        # TỪNG component; một mảnh xấu không được khóa hình tốt.
                        # Tem tròn khuyết / CUSTOM → reject → giữ contour riêng nó.
                        recon_meta = {
                            "shape_mode": page_shape_mode,
                            "reconstructed": False,
                        }
                        cut_draw_style = corner_style
                        try:
                            if not base_dieline.is_empty:
                                base_dieline, recon_meta = _reconstruct_cut_geometry_parts(
                                    base_dieline,
                                    page_shape_mode,
                                    px_per_mm,
                                    source_pixel_mm_page,
                                )

                                # QUALITY (audit 2026-08-07 §NOODLE.6): lượt hai chỉ
                                # chạy khi silhouette chính đã được guard nhận là hình
                                # chuẩn. Nhờ vậy có thể dọn mảnh JPEG xa hơn ở tem cực
                                # lớn mà hình custom/nhiều tem vẫn giữ nguyên chi tiết.
                                dropped_recognized_halo = 0
                                dominant_kind = recon_meta.get("dominant_kind")
                                if (
                                    isinstance(base_dieline, MultiPolygon)
                                    and white_bg_mask_built
                                    and color_bg_detected is None
                                    and source_pixel_mm_page is not None
                                    and recon_meta.get("dominant_reconstructed")
                                    and dominant_kind in _STANDARD_RECONSTRUCTED_KINDS
                                ):
                                    rebuilt_parts, dropped_recognized_halo = (
                                        _filter_full_page_jpeg_halo_components(
                                            list(base_dieline.geoms),
                                            source_pixel_mm_page,
                                            max_area_fraction=(
                                                _JPEG_HALO_RECOGNIZED_MAX_MAIN_AREA_FRACTION
                                            ),
                                            max_gap_source_px=(
                                                _JPEG_HALO_RECOGNIZED_MAX_GAP_SOURCE_PX
                                            ),
                                            max_short_span_source_px=(
                                                _JPEG_HALO_RECOGNIZED_MAX_SHORT_SPAN_SOURCE_PX
                                            ),
                                            image_rgb=img[:, :, :3],
                                            geometry_px_per_point=self.scale,
                                        )
                                    )
                                    if dropped_recognized_halo:
                                        base_dieline = unary_union(rebuilt_parts)
                                        if len(rebuilt_parts) == 1:
                                            recon_meta = {
                                                "shape_mode": page_shape_mode,
                                                "reconstructed": True,
                                                "fully_reconstructed": True,
                                                "kind": dominant_kind,
                                                "component_count": 1,
                                                "component_reconstructed_count": 1,
                                            }
                                        else:
                                            recon_meta = dict(recon_meta)
                                            recon_meta["component_count"] = len(rebuilt_parts)
                                        logger.debug(
                                            "[STICKER_BG] page=%d §NOODLE.6 bỏ %d mảnh JPEG "
                                            "sau khi nhận dạng hình chính=%s",
                                            page_idx + 1,
                                            dropped_recognized_halo,
                                            dominant_kind,
                                        )
                                if recon_meta.get("kind") in ("rect", "triangle"):
                                    cut_draw_style = "miter"
                                elif recon_meta.get("kind") in (
                                    "circle", "ellipse", "rounded_rect"
                                ):
                                    cut_draw_style = "round"
                        except Exception as _recon_err:
                            logger.warning(
                                "Bỏ qua bước dựng lại hình (loại=%s).",
                                type(_recon_err).__name__,
                            )
                            recon_meta = {
                                "shape_mode": page_shape_mode,
                                "reconstructed": False,
                                "error": type(_recon_err).__name__,
                            }

                        # Vị trí đường cắt + mép ngoài bù xén — xem compute_cut_bleed_offsets.
                        total_offset, bleed_outer_offset = compute_cut_bleed_offsets(
                            cut_mode, bleed_pts, offset_pts
                        )

                        if (
                            alpha_source_contour or approved_contour_page
                        ) and preserve_contour:
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

                        direct_analytic_fillet = None
                        if (
                            not alpha_source_contour
                            and not approved_contour_page
                            and cut_mode != "none"
                            and corner_style == "round"
                        ):
                            direct_source_pixel_mm = source_pixel_mm_page
                            if (
                                direct_source_pixel_mm is None
                                or not math.isfinite(float(direct_source_pixel_mm))
                                or float(direct_source_pixel_mm) <= 0.0
                            ):
                                direct_source_pixel_mm = 1.0 / max(px_per_mm, 1e-9)
                            direct_analytic_fillet = _fit_standard_polygon_fillet(
                                base_dieline,
                                total_offset_pts=total_offset,
                                source_pixel_mm=float(direct_source_pixel_mm),
                                curve_tension=curve_tension,
                            )
                            if direct_analytic_fillet is not None:
                                (
                                    direct_fitted_geometry,
                                    direct_fitted_paths,
                                    _direct_fit_tolerance_mm,
                                ) = direct_analytic_fillet
                                direct_quality = _alpha_final_cutline_quality(
                                    direct_fitted_paths,
                                    reference_geometry=dieline_poly,
                                    fitted_geometry=direct_fitted_geometry,
                                    alpha_geometry=base_dieline,
                                    total_offset_pts=total_offset,
                                    mm_to_pts=mm_to_pts,
                                    source_pixel_mm=float(direct_source_pixel_mm),
                                    fit_mode="analytic-fillet",
                                )
                                if not bool(direct_quality.get("machine_safe")):
                                    raise UnsafeCutlineGeometryError(
                                        "Đường bo góc hình chuẩn chưa an toàn "
                                        f"({int(direct_quality.get('short_segment_count', 0))} "
                                        "đoạn thẳng ngắn, "
                                        f"{int(direct_quality.get('disconnected_join_count', 0))} "
                                        "khớp hở, "
                                        f"{int(direct_quality.get('unprotected_join_count', 0))} "
                                        "khớp gãy).",
                                        quality=direct_quality,
                                    )
                                if page_box_mask_built:
                                    # QUALITY (feedback 2026-08-19 §PAGEBOX-BLEED.1):
                                    # CutContour page-box đã bo nhưng footprint màu vẫn
                                    # là hình vuông làm góc trắng của artwork nằm ngoài
                                    # cung dao không được lớp bleed phủ. Dựng thêm fillet
                                    # tại offset 0 làm biên clip/lấy màu; đường dao có
                                    # offset vẫn dùng candidate riêng ở trên.
                                    source_fillet = _fit_standard_polygon_fillet(
                                        base_dieline,
                                        total_offset_pts=0.0,
                                        source_pixel_mm=float(direct_source_pixel_mm),
                                        curve_tension=curve_tension,
                                    )
                                    if source_fillet is not None:
                                        page_box_round_footprint_poly = source_fillet[0]
                                        artwork_footprint_poly = (
                                            page_box_round_footprint_poly
                                        )

                        override_result = (
                            approved_override_result
                            if approved_contour_page
                            else _alpha_override_geometry(
                                alpha_path_overrides.get(page_idx)
                            )
                        )
                        if (
                            (approved_contour_page or alpha_source_contour)
                            and override_result is not None
                        ):
                            # QUALITY (feedback 2026-08-11 §LEGACY-AI.3): đây là
                            # chính Bézier đã dựng với kiểu góc hiện tại cho live
                            # preview. Cả Giữ nguyên lẫn Góc tròn đều phải dùng
                            # thẳng; fit lần hai từng làm preview đúng nhưng PDF sai.
                            cut_poly, cut_fitted_paths = override_result
                            dieline_poly = cut_poly
                        elif (
                            alpha_source_contour or approved_contour_page
                        ) and preserve_contour:
                            # QUALITY (audit 2026-08-04 §ALPHA.1–2): ưu tiên fit
                            # nhiều điểm raster thành ít cubic. Candidate không qua
                            # topology/Hausdorff/khoảng lùi sẽ tự về Catmull có guard.
                            fitted_alpha = _fit_alpha_bezier_paths(
                                base_dieline,
                                dieline_poly,
                                total_offset_pts=total_offset,
                                mm_to_pts=mm_to_pts,
                                corner_policy=alpha_corner_policy,
                                source_pixel_mm=alpha_source_pixel_mm,
                                allow_high_resolution_fairing=(
                                    bool(alpha_source_mode)
                                    and not alpha_contour_mode
                                ),
                                cutline_smoothness=cutline_smoothness,
                                cutline_fidelity=cutline_fidelity,
                                curve_tension=curve_tension,
                            )
                            if fitted_alpha is not None:
                                cut_poly, cut_fitted_paths, _fit_tolerance_mm = fitted_alpha
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
                        elif direct_analytic_fillet is not None:
                            # QUALITY (feedback 2026-08-19 §CUTROUND.5): luồng
                            # PDF thường phải dùng cùng fillet G1 như workspace AI;
                            # trước đây rect/triangle bị ép miter sau reconstruct.
                            (
                                cut_poly,
                                cut_fitted_paths,
                                _fit_tolerance_mm,
                            ) = direct_analytic_fillet
                            dieline_poly = cut_poly
                        elif (
                            recon_meta.get("reconstructed")
                            and recon_meta.get("fully_reconstructed", True)
                        ):
                            # §NOODLE.2–3: hình đã qua guard nhận dạng thì xuất
                            # trực tiếp geometry chuẩn; không đưa ngược vào fitter
                            # "giữ biên" rồi fallback thành hàng nghìn polyline.
                            cut_poly = dieline_poly.simplify(
                                0.05,
                                preserve_topology=True,
                            )
                        elif preserve_contour and alpha_corner_policy == "adaptive":
                            # QUALITY (audit 2026-08-05 §EXISTING.CUT1): chế độ
                            # PDF/PNG đã có biên simplify theo mm trước rồi mới fit span
                            # cong lớn. Candidate không đạt guard phải quay về đúng
                            # polyline preserve cũ, không âm thầm đổi hình học của khách.
                            fitted_contour = _fit_preserved_contour_paths(
                                dieline_poly,
                                mm_to_pts=mm_to_pts,
                                source_pixel_mm=alpha_source_pixel_mm,
                            )
                            if fitted_contour is not None:
                                cut_poly, cut_fitted_paths, _fit_tolerance_mm = fitted_contour
                            else:
                                # QUALITY (audit 2026-08-07 §NOODLE.12): fitter
                                # reject vẫn phải đi fallback theo pixel nguồn;
                                # không quay về ngưỡng 0,20 mm rồi xuất nghìn node.
                                cut_poly, _fit_tolerance_mm = (
                                    _preserved_contour_fallback_geometry(
                                        dieline_poly,
                                        mm_to_pts=mm_to_pts,
                                        source_pixel_mm=alpha_source_pixel_mm,
                                    )
                                )
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
                            # QUALITY (feedback 2026-08-10 §ROUND-PATH.1): contour
                            # custom + Góc tròn phải fit trên geometry đầy đủ. Đường
                            # cũ simplify 1 pt rồi Catmull 0,33 làm ca thật trôi ra
                            # 0,37 mm và cắt tắt hõm tới hơn 1 mm dù Offset = 0.
                            rounded_fit = (
                                _fit_round_contour_paths(
                                    dieline_poly,
                                    mm_to_pts=mm_to_pts,
                                )
                                if corner_style == "round"
                                else None
                            )
                            if rounded_fit is not None:
                                (
                                    cut_poly,
                                    cut_fitted_paths,
                                    _fit_tolerance_mm,
                                ) = rounded_fit
                            else:
                                # Kiểu góc thẳng giữ nhánh polyline cũ; nếu spline
                                # không đạt guard cũng không nới ngân sách hình học.
                                _cut_simplify = (
                                    0.05 if recon_meta.get("reconstructed") else 1.0
                                )
                                if isinstance(dieline_poly, MultiPolygon):
                                    _cut_parts = []
                                    for p in dieline_poly.geoms:
                                        _s = p.simplify(
                                            _cut_simplify,
                                            preserve_topology=False,
                                        )
                                        if _s.is_empty:
                                            continue
                                        if isinstance(_s, MultiPolygon):
                                            _cut_parts.extend(
                                                g for g in _s.geoms if not g.is_empty
                                            )
                                        else:
                                            _cut_parts.append(_s)
                                    cut_poly = (
                                        MultiPolygon(_cut_parts)
                                        if _cut_parts
                                        else dieline_poly
                                    )
                                else:
                                    cut_poly = dieline_poly.simplify(
                                        _cut_simplify,
                                        preserve_topology=False,
                                    )

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
                        if page_box_round_footprint_poly is not None:
                            page_box_corner_source = (
                                _page_box_corner_foreground_for_bleed(
                                    img_native,
                                    px_per_mm,
                                )
                            )
                            if page_box_corner_source is not None:
                                (
                                    corner_foreground,
                                    page_box_corner_background_rgb,
                                    page_box_corner_background_tolerance,
                                ) = page_box_corner_source
                                padded_original_mask = np.pad(
                                    corner_foreground,
                                    pad_width=(pad_rows, pad_cols),
                                    mode="constant",
                                    constant_values=0,
                                )
                                # Footprint thật của tem bo sẵn phải thắng fillet
                                # page-box: vùng giữa hai cung chính là phần cần bù màu.
                                artwork_footprint_poly = None
                            else:
                                # Cùng hệ toạ độ với `_rasterize_poly` phía dưới. Khi
                                # không chứng minh được tem đã bo sẵn, giữ fillet do
                                # người dùng chọn làm silhouette lấy màu/clip artwork.
                                padded_original_mask.fill(0)

                                def _rasterize_page_box_round(poly_geom):
                                    if isinstance(poly_geom, MultiPolygon):
                                        for part in poly_geom.geoms:
                                            _rasterize_page_box_round(part)
                                        return
                                    exterior = np.asarray(poly_geom.exterior.coords)
                                    exterior_px = np.column_stack([
                                        exterior[:, 0] * self.scale + pad_left,
                                        exterior[:, 1] * self.scale + pad_top,
                                    ]).astype(np.int32)
                                    cv2.fillPoly(
                                        padded_original_mask,
                                        [exterior_px],
                                        255,
                                    )
                                    for interior in poly_geom.interiors:
                                        interior_coords = np.asarray(interior.coords)
                                        interior_px = np.column_stack([
                                            interior_coords[:, 0] * self.scale + pad_left,
                                            interior_coords[:, 1] * self.scale + pad_top,
                                        ]).astype(np.int32)
                                        cv2.fillPoly(
                                            padded_original_mask,
                                            [interior_px],
                                            0,
                                        )

                                _rasterize_page_box_round(
                                    page_box_round_footprint_poly,
                                )
                        
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
                        # QUALITY (audit 2026-08-06 §BG.4): nền đã dò được ở
                        # §BG.2/§BG.3 thì viền AA bị ám MÀU NỀN ĐÓ, không phải
                        # trắng. Truyền xuống để lọc pha nền đúng màu; nền
                        # gradient (is_flat=False) KHÔNG truyền vì một màu đại
                        # diện là vô nghĩa, lọc theo nó sẽ ăn oan artwork.
                        edge_bg_rgb = None
                        edge_bg_tolerance = 0
                        if (
                            approved_contour_page
                            and approved_edge_background_rgb is not None
                        ):
                            # QUALITY (audit 2026-08-19 §STK.EDGE01): approved
                            # contour đã bỏ qua nhánh tự dựng white/color mask,
                            # nên phải lấy lại ngữ cảnh nền scalar từ artifact.
                            edge_bg_rgb = approved_edge_background_rgb
                            edge_bg_tolerance = (
                                approved_edge_background_tolerance
                            )
                        elif (
                            alpha_source_contour
                            and alpha_edge_background_rgb is not None
                        ):
                            # QUALITY (feedback 2026-08-19 §STK.MULTI-EDGE01):
                            # PDF Alpha của chế độ nhiều tem đã xóa nền trước khi
                            # vào engine; lấy lại scalar do exporter đo trên RGB
                            # nguyên tấm để không hút halo JPEG vào màu bù xén.
                            edge_bg_rgb = alpha_edge_background_rgb
                            edge_bg_tolerance = alpha_edge_background_tolerance
                        elif (
                            color_bg_detected is not None
                            and color_bg_detected.is_flat
                            and not color_bg_detected.is_near_white
                        ):
                            edge_bg_rgb = color_bg_detected.color
                            edge_bg_tolerance = (
                                color_bg_detected.tolerance
                                + _EDGE_BG_TOLERANCE_PADDING
                            )
                        elif page_box_corner_background_rgb is not None:
                            # §PAGEBOX-BLEED.2: chỉ dùng nền góc làm ngữ cảnh lọc
                            # màu; tuỳ chọn giữ nền và hình học page-box không đổi.
                            edge_bg_rgb = page_box_corner_background_rgb
                            edge_bg_tolerance = (
                                page_box_corner_background_tolerance
                            )
                        elif remove_white_bg and white_bg_mask_built:
                            # Nền trắng đã được xác nhận bởi connected-component ở
                            # mép trang. Truyền làm màu tham chiếu để adaptive nhận ra
                            # cả dải JPEG hồng/trắng đều, không chỉ pixel gần #FFFFFF.
                            edge_bg_rgb = (255, 255, 255)
                            edge_bg_tolerance = 1
                        # QUALITY (feedback 2026-08-19 §STK.WHITE-EDGE01): màu
                        # trắng chỉ được loại khỏi shell khi đã có bằng chứng đó
                        # là nền ngoài. Nếu người dùng giữ nền và không dò được
                        # ``edge_bg_rgb``, trắng là màu artwork hợp lệ. Lọc trắng
                        # vô điều kiện từng xóa 73% shell thật, rồi nearest-fill
                        # phóng vài pixel AA xanh-xám ra toàn vùng bù xén.
                        exclude_edge_background = edge_bg_rgb is not None
                        if bleed_color_type in ("image", "trajectory") and not rectangle_mode:
                            adaptive_max_mm = _edge_color_adaptive_max_mm(
                                source_pixel_mm_page
                            )
                            max_adaptive_peel_px = max(
                                peel_px,
                                int(round(adaptive_max_mm * px_per_mm)),
                            )
                            # Ảnh nguồn thấp DPI được PDFium nội suy lên lưới render;
                            # biên màu sạch có thể trễ tối đa gần một pixel NGUỒN so
                            # với trần peel sau làm tròn. Chỉ cho phép probe phần lệch
                            # nội suy này; ảnh chạy đúng lưới native nhận 0 và không
                            # bao giờ vượt hợp đồng max_adaptive_peel_px.
                            source_to_render = (
                                source_pixel_mm_page * px_per_mm
                                if source_pixel_mm_page is not None
                                else 1.0
                            )
                            interpolation_probe_px = min(
                                edge_band_px * 2,
                                max(0, int(math.ceil(source_to_render - 1.0))),
                            )
                            color_source_mask, selected_peel_px = (
                                _build_adaptive_edge_color_source_mask(
                                    padded_original_mask,
                                    padded_img,
                                    band_px=edge_band_px,
                                    peel_px=peel_px,
                                    max_peel_px=max_adaptive_peel_px,
                                    max_interpolation_probe_px=(
                                        interpolation_probe_px
                                    ),
                                    edge_bite_px=edge_color_inset_px,
                                    kernel_type=kernel_type,
                                    exclude_near_white=exclude_edge_background,
                                    background_rgb=edge_bg_rgb,
                                    background_tolerance=edge_bg_tolerance,
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
                                exclude_near_white=(
                                    not rectangle_mode and exclude_edge_background
                                ),
                                background_rgb=(
                                    None if rectangle_mode else edge_bg_rgb
                                ),
                                background_tolerance=edge_bg_tolerance,
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
                                background_rgb=edge_bg_rgb,
                            )
                        # Giữ tên inset_px cho log/công thức band cũ (tương đương depth nguồn).
                        inset_px = max(1, source_depth_px)

                        # Generate bleed_mask from bleed_outer_poly (extends BEYOND cut line)
                        if bleed_outer_poly is not None and not getattr(bleed_outer_poly, 'is_empty', True):
                            if self.debug:
                                logger.debug(">>> RASTERIZE METHOD: Using bleed_outer_poly to generate bleed_mask (pad_b=%d, bleed_outer_offset=%.2f, scale=%.4f)", pad_b, bleed_outer_offset, self.scale)
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
                                logger.debug(">>> RASTERIZE DONE: bleed_mask nonzero=%d, padded_mask nonzero=%d", np.count_nonzero(bleed_mask), np.count_nonzero(padded_mask))
                                try:
                                    debug_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'debug_output')
                                    os.makedirs(debug_dir, exist_ok=True)
                                    debug_img = np.zeros((mask_h, mask_w, 3), dtype=np.uint8)
                                    debug_img[bleed_mask > 0] = [0, 255, 0]  # Green = bleed area
                                    debug_img[padded_mask > 0] = [255, 255, 255]  # White = artwork
                                    cv2.imwrite(os.path.join(debug_dir, 'debug_bleed_mask.png'), debug_img)
                                    logger.debug(">>> DEBUG IMAGE SAVED")
                                except Exception as error:
                                    logger.debug(
                                        ">>> DEBUG IMAGE FAILED (type=%s)",
                                        type(error).__name__,
                                    )
                        else:
                            if self.debug:
                                logger.debug(">>> FALLBACK METHOD: Using cv2.dilate (no dieline_poly)")
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

                        sticker_footprint = np.zeros_like(padded_original_mask)
                        if (
                            artwork_footprint_poly is not None
                            and not getattr(artwork_footprint_poly, "is_empty", True)
                        ):
                            # QUALITY (feedback 2026-08-10 §EDGE-SAMPLE.2): cùng
                            # contour sạch đã dùng dựng đường cắt, không dùng raw mask
                            # còn các đảo JPEG trắng/hồng làm SMask bù xén thủng từng mảng.
                            _rasterize_poly(
                                artwork_footprint_poly,
                                sticker_footprint,
                                self.scale,
                                pad_left,
                                pad_top,
                            )
                        else:
                            close_kernel = cv2.getStructuringElement(
                                cv2.MORPH_ELLIPSE,
                                (close_px * 2 + 1, close_px * 2 + 1),
                            )
                            close_guard_px = close_px + 1
                            guarded_footprint_mask = np.pad(
                                padded_original_mask,
                                pad_width=close_guard_px,
                                mode="constant",
                                constant_values=0,
                            )
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
                            foot_contours, _ = cv2.findContours(
                                closed_mask,
                                cv2.RETR_EXTERNAL,
                                cv2.CHAIN_APPROX_SIMPLE,
                            )
                            cv2.drawContours(
                                sticker_footprint,
                                foot_contours,
                                -1,
                                255,
                                cv2.FILLED,
                            )

                        # "Lẹm mép" thật sự chỉ do edge_bite_px: co footprint và clip artwork
                        # để bleed lấn vào dải mép. Lẹm quá tay sẽ ăn nội dung nên mặc định là 0.
                        # edge_color_inset_px có thể sâu hơn để né trắng/khử răng cưa khi lấy màu,
                        # nhưng phần tăng thêm chỉ đổi nguồn màu; tuyệt đối không co footprint.
                        # Nhờ vậy Resize lấy mẫu sâu 0,5 mm mà vẫn giữ nguyên toàn bộ artwork
                        # sau khi auto-trim đã đặt box sát nội dung.
                        if edge_bite_px > 0:
                            bite_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (edge_bite_px*2+1, edge_bite_px*2+1))
                            sticker_footprint = cv2.erode(sticker_footprint, bite_kernel)

                        # bleed_ring = vùng giữa footprint và biên bù xén. Lớp màu lấy
                        # mẫu được vẽ LÊN TRÊN artwork, vì vậy phần chồng mí vào trong là
                        # thay đổi nhìn thấy được. Chỉ cho phép một dải cố định rất hẹp để
                        # bịt khe AA/subpixel; không được lấy độ sâu dò màu làm độ chồng mí.
                        # QUALITY (feedback 2026-08-10 §EDGE-SAMPLE.3): độ sâu dò
                        # màu và độ chồng mí là hai đại lượng độc lập. Trước đây
                        # selected_peel_px=21 (≈2,47 mm) bị dùng làm choke trên
                        # artwork, nên mọi sai màu nguồn đều lộ thành một vành lớn.
                        _tuck_px = _sampled_bleed_overlap_px(
                            px_per_mm,
                            source_pixel_mm=source_pixel_mm_page,
                            selected_peel_px=selected_peel_px,
                            initial_peel_px=peel_px,
                        )
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
                            band = _build_bleed_color_work_band(
                                bleed_ring,
                                band_r,
                            )
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
                            # Lấp góc trong suốt trước khi ngoại suy quỹ đạo. Mask
                            # hình học thô có thể chứa pixel AA pha nền ở cung bo;
                            # nếu dùng nó làm nguồn nearest, một dúm pixel xám bị
                            # phóng thành cả nêm màu ở bốn góc. Dùng shell màu sạch
                            # đã qua adaptive sampling để tạo ảnh lấp, nhưng giữ
                            # nguyên nội dung lõi bên trong vùng co an toàn.
                            clean_rect_mask = color_source_mask[y0:y1, x0:x1]
                            if np.count_nonzero(clean_rect_mask) > 0:
                                clean_rect_fill = _nearest_color_fill(
                                    clean_rect_mask,
                                    rect_core_source,
                                )
                                safe_inset_px = max(
                                    1,
                                    int(edge_color_inset_px + selected_peel_px),
                                )
                                safe_kernel = cv2.getStructuringElement(
                                    cv2.MORPH_ELLIPSE,
                                    (safe_inset_px * 2 + 1, safe_inset_px * 2 + 1),
                                )
                                trusted_core = cv2.erode(
                                    rect_core_mask,
                                    safe_kernel,
                                )
                                rect_core = rect_core_source.copy()
                                replace = trusted_core == 0
                                rect_core[replace] = clean_rect_fill[replace]
                            else:
                                # Fallback giữ hành vi cũ cho artwork quá mảnh,
                                # nơi shell màu sạch không còn điểm hợp lệ.
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
                            # COLOR (audit 2026-08-24 §BCOLOR.06): edge bite chỉ
                            # điều khiển vùng chồng mí/clip. Với nguồn CMYK/DeviceN
                            # thiếu ICC, fill phải chạy trên toàn mép PDFium để
                            # không dịch texture khỏi lưới flatten; pixel neo ở
                            # helper bên dưới vẫn khớp đúng ranh trim.
                            fill_edge_bite_px = (
                                0 if unprofiled_process_color_fallback
                                else edge_color_inset_px
                            )
                            bleed_colors = fill_rectangle(
                                img_native, pad_b, fill_edge_bite_px, px_per_mm,
                                pads=(pad_left, pad_right, pad_bottom, pad_top),
                            )
                            if unprofiled_process_color_fallback:
                                # COLOR (audit 2026-08-24 §BCOLOR.05): nguồn DeviceN
                                # thiếu ICC ưu tiên điểm nối liên tục trên PDFium/RIP;
                                # giữ texture quỹ đạo, không làm phẳng màu ở mép.
                                bleed_colors = _enforce_rectangle_edge_continuity(
                                    bleed_colors,
                                    img_native,
                                    pad_b,
                                    edge_color_inset_px,
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

                        # Sampled bleed giữ ICCBased sRGB vì đó là bytes PDFium đã
                        # render từ chính artwork. Không tự đổi ngược RGB→CMYK khi
                        # nguồn thiếu ICC: phép nghịch không biết black generation/
                        # TAC/profile nên tạo seam màu rõ hơn bản gốc.

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
                                bleed_rgb_for_storage, bleed_ring, perimeter_px
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
                                logger.debug(">>> BLEED DEBUG: bleed_ring nonzero=%d, bleed_rgb mean=%s, bleed_color_type=%s", np.count_nonzero(bleed_ring), np.mean(bleed_rgb[bleed_ring > 0], axis=0) if np.count_nonzero(bleed_ring) > 0 else 'N/A', bleed_color_type)
                            except Exception as error:
                                logger.debug(
                                    ">>> BLEED DEBUG FAILED (type=%s)",
                                    type(error).__name__,
                                )

                # COLOR (audit 2026-08-24 §BCOLOR.04): với nguồn CMYK/DeviceN
                # không ICC, ghép Form gốc cạnh bleed RGB vẫn tạo seam ở viewer.
                # Flatten trên đúng lưới render hiện tại để cả artwork và bleed
                # đi qua một ICCBased RGB image duy nhất.
                if (
                    flatten_unprofiled_process_color
                    and bleed_stream_data
                    and bleed_rgb is not None
                    and bleed_ring is not None
                    and not is_bleed_cmyk
                    and not selection_page_mode
                ):
                    flattened_page_rgb = _compose_rgb_flattened_page(
                        padded_img,
                        bleed_rgb,
                        bleed_ring,
                    )
                    if flattened_page_rgb is not None:
                        if srgb_colorspace is None:
                            srgb_colorspace = _make_srgb_colorspace(doc_out)
                        if not srgb_output_intent_embedded:
                            # COLOR (audit 2026-08-24 §BCOLOR.07): ảnh flatten
                            # là sRGB hoàn chỉnh; khai báo OutputIntent để viewer/RIP
                            # không tự diễn giải lại bytes RGB theo profile mặc định.
                            srgb_output_intent_embedded = embed_srgb_output_intent(
                                doc_out, replace_existing=True
                            )
                        flattened_stream = pikepdf.Stream(
                            doc_out,
                            zlib.compress(flattened_page_rgb.tobytes(), 1),
                        )
                        flattened_stream.Type = pikepdf.Name.XObject
                        flattened_stream.Subtype = pikepdf.Name.Image
                        flattened_stream.Width = flattened_page_rgb.shape[1]
                        flattened_stream.Height = flattened_page_rgb.shape[0]
                        flattened_stream.ColorSpace = srgb_colorspace
                        flattened_stream.BitsPerComponent = 8
                        flattened_stream.Filter = pikepdf.Name.FlateDecode
                        flattened_stream.Interpolate = True
                        flattened_img_name = page_out.add_resource(
                            flattened_stream,
                            pikepdf.Name.XObject,
                        )
                        flattened_img_w_pt = (
                            flattened_page_rgb.shape[1] / self.scale
                        )
                        flattened_img_h_pt = (
                            flattened_page_rgb.shape[0] / self.scale
                        )
                        flattened_content_origin_x = (
                            crop_x0 if selection_page_mode else exp_left
                        )
                        flattened_content_origin_y = (
                            crop_y0 if selection_page_mode else exp_bottom
                        )
                        flattened_shift_x = (
                            flattened_content_origin_x
                            - (pad_left / self.scale)
                        )
                        flattened_shift_y = (
                            flattened_content_origin_y
                            - (pad_bottom / self.scale)
                        )
                        color_render_strategy = "flattened-rgb"
                        logger.debug(
                            "[STICKER] màu flatten RGB trang %d: %dx%d "
                            "(nguồn DeviceCMYK thiếu ICC)",
                            page_idx + 1,
                            flattened_page_rgb.shape[1],
                            flattened_page_rgb.shape[0],
                        )

                # One source Form XObject is reused by the vector bleed strips and
                # by the original artwork layer. Its resources retain CMYK/ICC/spot.
                src_xobj_name = None
                if not selection_page_mode and flattened_img_name is None:
                    src_xobj = page_in_pike.as_form_xobject()
                    src_xobj_name = page_out.add_resource(src_xobj, pikepdf.Name.XObject)

                page_content_stream = []
                sampled_bleed_overlay_stream = []
                # COLOR (audit 2026-08-25 §BCOLOR.09): mixed DeviceN+CMYK
                # thiếu ICC phải vẽ dải Form sau artwork để không lộ hairline
                # do hai CTM/anti-alias khác nhau ở ranh trim.
                vector_bleed_after_artwork = bool(
                    use_vector_rectangle_bleed and safe_vector_process_color_fallback
                )
                vector_ops = []
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
                        join_overlap_pts=(
                            max(0.25, min(0.5, 72.0 / max(1, self.dpi)))
                            if vector_bleed_after_artwork
                            else 0.0
                        ),
                    )
                    if not vector_bleed_after_artwork:
                        page_content_stream.extend(vector_ops)

                # LAYER 1 (BOTTOM): Bleed color with SMask
                if bleed_stream_data and flattened_img_name is None:
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
                        logger.debug(
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
                if vector_bleed_after_artwork and vector_ops:
                    # Vẽ sau Form gốc; overlap nhỏ đã khóa kín hairline nhưng không
                    # đổi footprint, bleed_mm hay edge_bite của người dùng.
                    page_content_stream.extend(vector_ops)

                if flattened_img_name is not None:
                    # Bỏ toàn bộ Form CMYK/bleed SMask vừa dựng ở trên: ảnh flatten
                    # đã chứa đúng cả hai lớp trên cùng lưới RGB. Giữ stream CUT
                    # phía dưới chạy bình thường.
                    page_content_stream = [
                        "q",
                        (
                            f"{flattened_img_w_pt:.4f} 0 0 "
                            f"{flattened_img_h_pt:.4f} "
                            f"{flattened_shift_x:.4f} {flattened_shift_y:.4f} cm"
                        ),
                        f"{str(flattened_img_name)} Do",
                        "Q",
                    ]



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

                    if cut_fitted_paths is not None:
                        for segments in cut_fitted_paths:
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
                
                page_meta = {
                    "recon": recon_meta,
                    "color_render_strategy": color_render_strategy,
                }
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
                        # COLOR (audit 2026-08-24 §BCOLOR.04): giữ chiến lược
                        # render đã chọn ở đầu trang; trước đây khối metadata
                        # hình học ghi đè mất cờ này nên khó kiểm chứng artifact.
                        "color_render_strategy": color_render_strategy,
                        "contour_source": (
                            approved_contour_source
                            if approved_contour_page
                            else ("alpha" if alpha_source_contour else "auto")
                        ),
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
                # QUALITY (audit 2026-08-06 §BG.1): nói rõ nguyên nhân để thợ biết
                # phải đổi gì, thay vì chỉ "không dò được hình".
                # §BG.2/§BG.3: cờ này bật SAU khi nhánh nền màu và nhánh gradient
                # đã thử và trượt — nên không được khuyên "tách nền theo màu".
                white_bg_warning = (
                    f"Trang {page_idx + 1}: không tách được nền — đã thử cả nền "
                    "trắng, nền màu phẳng và nền chuyển sắc nhưng không phân biệt "
                    "được hình với nền (nền hoạ tiết/ảnh chụp, hoặc tem chạm sát "
                    "mép khổ). Hãy dùng file PNG còn nền trong suốt, hoặc tắt "
                    "'Bỏ nền trắng' và cắt theo khổ trang."
                ) if white_bg_detect_failed else None
                if white_bg_detect_failed:
                    pages_white_bg_failed.append(page_idx + 1)
                    # Đánh dấu trong meta để nhánh SONG SONG (gom kết quả từ
                    # process con) cũng biết lý do thất bại, không phải đoán.
                    page_meta["white_bg_detect_failed"] = True
                # QUALITY (audit 2026-08-06 §BG.2/§BG.3): đã phải dò nền theo MÀU
                # — nói rõ đã tách kiểu nào để thợ soi lại đường cắt trước khi bế.
                color_bg_warning = None
                if color_bg_detected is not None:
                    if color_bg_detected.is_flat:
                        color_bg_warning = (
                            f"Trang {page_idx + 1}: nền không phải trắng; đã tách "
                            f"nền theo màu RGB{color_bg_detected.color}. Hãy kiểm "
                            "tra lại đường cắt trước khi bế."
                        )
                    else:
                        # Nhánh loang (§BG.3) là phỏng đoán trên nền gradient/hoạ
                        # tiết → cảnh báo nặng hơn, và gợi ý đường chắc chắn.
                        color_bg_warning = (
                            f"Trang {page_idx + 1}: nền KHÔNG phẳng (gradient/hoạ "
                            "tiết) — đã tách nền bằng cách loang từ mép, kết quả "
                            "là PHỎNG ĐOÁN. Bắt buộc soi lại đường cắt; nếu sai, "
                            "hãy dùng chế độ cắt xén theo hình chữ nhật."
                        )
                    page_meta["background_color"] = list(color_bg_detected.color)
                    page_meta["background_confidence"] = round(
                        color_bg_detected.confidence, 2
                    )
                    page_meta["background_is_flat"] = color_bg_detected.is_flat
                page_meta["render_dpi"] = round(self.scale * 72.0, 2)
                page_meta["raster_width_px"] = int(img.shape[1])
                page_meta["raster_height_px"] = int(img.shape[0])
                page_meta["raster_seconds"] = round(raster_seconds, 4)
                page_meta["find_contours_seconds"] = round(contour_seconds, 4)
                if selected_peel_px is not None:
                    page_meta["edge_sample_peel_px"] = int(selected_peel_px)
                resolved_edge_background_rgb = (
                    approved_edge_background_rgb
                    if approved_edge_background_rgb is not None
                    else alpha_edge_background_rgb
                )
                if resolved_edge_background_rgb is not None:
                    page_meta["edge_background_rgb"] = list(
                        resolved_edge_background_rgb
                    )
                page_warning = " ".join(
                    warning for warning in (
                        alpha_contour_warning, white_bg_warning,
                        color_bg_warning, bleed_quality_warning,
                    )
                    if warning
                )
                if page_warning:
                    page_meta["bleed_warning"] = page_warning
                
                all_pages_meta.append(page_meta)
                logger.debug(
                    "[STICKER_STAGE] page=%d boundary=%s raster_px=%dx%d "
                    "render_dpi=%.2f render_s=%.3f contour_s=%.3f total_s=%.3f",
                    page_idx + 1,
                    (
                        approved_contour_source
                        if approved_contour_page
                        else ("alpha" if alpha_source_contour else "auto")
                    ),
                    int(img.shape[1]),
                    int(img.shape[0]),
                    self.scale * 72.0,
                    raster_seconds,
                    contour_seconds,
                    time.perf_counter() - page_started,
                )
                if rectangle_mode and bleed_color_type in ("inpaint", "trajectory"):
                    logger.debug(
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
            final_meta["color_provenance"] = dict(source_color_provenance)
            final_meta["color_warnings"] = list(color_warning_codes)
            final_meta["color_render_strategy"] = (
                "flattened-rgb"
                if any(
                    isinstance(page, dict)
                    and page.get("color_render_strategy") == "flattened-rgb"
                    for page in all_pages_meta
                )
                else "vector-original"
            )
            if rectangle_mode:
                # QUALITY (feedback 2026-08-19 §BLEED-COLOR.2): Xén vuông góc
                # phải báo đúng mode đã chạy; không được âm thầm đổi lựa chọn của
                # người dùng chỉ vì artwork chứa CMYK/spot/DeviceN.
                final_meta["bleed_color_mode_requested"] = bleed_color_type
                final_meta["bleed_color_mode_applied"] = bleed_color_type
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
                    "error": _loi_khong_do_duoc_hinh(bool(pages_white_bg_failed))
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
            if page_in is not None:
                try:
                    with pdfium_guard():
                        page_in.close()
                except Exception: pass
            if doc_in_pdfium:
                try:
                    with pdfium_guard():
                        doc_in_pdfium.close()
                except Exception: pass
            if doc_in_pike:
                try: doc_in_pike.close()
                except Exception: pass
            if doc_out:
                try: doc_out.close()
                except Exception: pass

            if canonical_input_is_temp and canonical_input_path:
                try:
                    os.remove(canonical_input_path)
                except FileNotFoundError:
                    pass
                except OSError as error:
                    logger.warning(
                        "[STICKER] không xoá được file chuẩn hoá trang %s: %s",
                        canonical_input_path,
                        error,
                    )

    def _run_sticker_chunks(
        self, args_list, n_workers: int, use_pool: bool, spill_dir: str | None = None

    ):
        """Chạy các chunk sticker: in-process tuần tự hoặc ProcessPool.

        Trả list (chunk_idx, result) — không sort. Khi pool chết (OOM/native)
        ném BrokenProcessPool / exception có "terminated abruptly".

        PERF (audit 2026-08-16 §BX.P04): với ``spill_dir``, `chunk_pdf_bytes` của mỗi
        chunk được GHI RA FILE ngay khi nhận và bytes được nhả, nên phần tử đầu của
        result là ĐƯỜNG DẪN thay vì bytes. Trước đây parent gom mọi chunk vào list rồi
        mới merge → peak RAM cha ≈ tổng dung lượng output, đúng lúc worker vừa nhả RAM
        (đo bằng tracemalloc: 5 chunk × ~3 MB giữ đủ 5 lần). Không truyền ``spill_dir``
        thì giữ nguyên hợp đồng bytes cũ.
        """
        import gc

        def _spill(entry):
            """Đổi bytes của một chunk thành file tạm, giữ nguyên phần meta."""
            if spill_dir is None:
                return entry
            chunk_idx, payload = entry
            chunk_bytes, metas, no_dieline, any_die = payload
            if not isinstance(chunk_bytes, (bytes, bytearray)):
                return entry
            chunk_path = os.path.join(spill_dir, f"sticker_chunk_{chunk_idx:04d}.pdf")
            with open(chunk_path, "wb") as chunk_file:
                chunk_file.write(chunk_bytes)
            # Nhả bytes NGAY: đây là mục đích của cả cơ chế spill.
            del chunk_bytes
            return chunk_idx, (chunk_path, metas, no_dieline, any_die)

        if len(args_list) == 1 or not use_pool or n_workers <= 1:
            mode = "in-process"
            logger.info(
                "[STICKER] run chunks mode=%s count=%d workers=%d spill=%s",
                mode, len(args_list), n_workers, spill_dir is not None,
            )
            results = []
            for a in args_list:
                results.append(_spill(_process_sticker_chunk(a)))
                # In liên tục nhiều trang: nhả buffer cv2/numpy giữa chunk.
                gc.collect()
            return results

        logger.info(
            "[STICKER] run chunks mode=pool count=%d workers=%d spill=%s",
            len(args_list), n_workers, spill_dir is not None,
        )
        results = []
        with ProcessPoolExecutor(max_workers=n_workers) as pool:
            future_map = {
                pool.submit(_process_sticker_chunk, a): a for a in args_list
            }
            for fut in as_completed(future_map):
                a = future_map[fut]
                try:
                    results.append(_spill(fut.result()))
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

        # Chỉ giữ khóa trong lúc gọi PDFium; phần lập pool/chia chunk ở ngoài khóa.
        with pdfium_guard():
            _probe = pdfium.PdfDocument(input_path)
            n_pages = len(_probe)
            # PERF (audit 2026-08-16 §BX.P07): ước lượng RAM/worker phải theo trang LỚN
            # NHẤT, không phải trang đầu. File "bìa nhỏ + ruột tờ lớn" từng khiến ước
            # lượng thấp → mở quá nhiều worker → pool crash → sticky tuần tự làm job sau
            # chậm dù máy khỏe. Chỉ probe 32 trang đầu để bước đo này không thành điểm nóng.
            page0_w = page0_h = 0.0
            try:
                probe_limit = min(n_pages, 32)
                max_area = -1.0
                for probe_idx in range(probe_limit):
                    _probe_page = _probe[probe_idx]
                    try:
                        pw, ph = _probe_page.get_size()
                    finally:
                        _probe_page.close()
                    area = float(pw) * float(ph)
                    if area > max_area:
                        max_area, page0_w, page0_h = area, float(pw), float(ph)
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
        # PERF (audit 2026-08-16 §BX.P11): escape hatch phải thắng auto-detect cả hai
        # chiều. `min(available, ...)` cũ kẹp env bởi `cpu-1` nên chỉ giảm được, không nới
        # — lệch nguyên tắc "env luôn thắng" của `prynx-performance`. `_cap_sticker_workers`
        # cũng đã tôn trọng env theo đúng cách này. Vẫn kẹp theo số trang: nhiều worker hơn
        # số chunk là spawn process không có việc.
        env_explicit = _env_int_or_none("STICKER_MAX_WORKERS") is not None
        n_workers = max(1, min(env_cap, n_pages) if env_explicit
                        else min(available, env_cap, n_pages))
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
                "alpha_corner_policy": kw.get("alpha_corner_policy", "legacy"),
                "alpha_source_pixel_mm": kw.get("alpha_source_pixel_mm"),
                "alpha_source_mode": kw.get("alpha_source_mode", False),
                "cutline_smoothness": kw.get("cutline_smoothness", 50),
                "cutline_denoise": kw.get("cutline_denoise", 0),
                "cutline_fidelity": kw.get("cutline_fidelity", 50),
                "curve_tension": kw.get("curve_tension", 50),
                "min_detail_area_mm2": kw.get(
                    "min_detail_area_mm2",
                    _MIN_CONTOUR_AREA_MM2,
                ),
                "alpha_path_overrides": kw.get("alpha_path_overrides"),
                "approved_contour_overrides": kw.get(
                    "approved_contour_overrides"
                ),
                # Tuple 4 bool — picklable, worker không phải parse lại chuỗi.
                "bleed_sides": kw.get("bleed_sides"),
            })

        # 1 chunk / n_workers=1 → in-process. Nhiều chunk → pool; crash → fallback tuần tự.
        workers_started = time.perf_counter()
        use_pool = len(args_list) > 1 and n_workers > 1
        used_pool = False
        # PERF (audit 2026-08-16 §BX.P04): chunk nhận về được ghi ra đây ngay và bytes
        # được nhả, thay vì gom cả bộ trong RAM process cha.
        chunk_spill = tempfile.TemporaryDirectory(prefix="prynx_sticker_chunks_")
        chunk_spill_dir = chunk_spill.name
        try:
            results = self._run_sticker_chunks(
                args_list, n_workers, use_pool=use_pool, spill_dir=chunk_spill_dir
            )
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
                            spill_dir=chunk_spill_dir,
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
                            spill_dir=chunk_spill_dir,
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
        # Handle chunk phải sống tới sau `save` (pikepdf giữ tham chiếu foreign object),
        # nhưng phải được đóng tường minh SAU ĐÓ — trên Windows còn handle mở thì không
        # xoá được file tạm (§BX.P04).
        chunk_docs: list[pikepdf.Pdf] = []
        try:
            for _ci, (chunk_source, metas, no_dieline, any_die) in results:
                all_pages_meta.extend(metas)
                pages_no_dieline.extend(no_dieline)
                any_dieline_found = any_dieline_found or any_die
                # `spill_dir` trả đường dẫn; hợp đồng bytes cũ vẫn được nhận.
                src = pikepdf.Pdf.open(
                    chunk_source if isinstance(chunk_source, str)
                    else io.BytesIO(chunk_source)
                )
                chunk_docs.append(src)
                if final_doc is None:
                    final_doc = pikepdf.Pdf.new()
                final_doc.pages.extend(src.pages)

            with pikepdf.Pdf.open(input_path) as source_catalog:
                copy_output_intents(source_catalog, final_doc)
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
            # Đóng handle chunk TRƯỚC khi xoá thư mục tạm (Windows không xoá file đang mở).
            for chunk_doc in chunk_docs:
                try: chunk_doc.close()
                except Exception: pass
            chunk_docs.clear()
            chunk_spill.cleanup()

        # Tái tạo final_meta/error/warning Y HỆT nhánh tuần tự.
        final_meta = {}
        if len(all_pages_meta) > 0 and all_pages_meta[0]:
            final_meta = all_pages_meta[0].copy()
        final_meta["pages"] = all_pages_meta
        # COLOR (audit 2026-08-24 §BCOLOR.04): worker con chạy flatten độc lập
        # theo từng trang; tổng hợp cờ để API phản ánh đúng artifact cuối.
        final_meta["color_render_strategy"] = (
            "flattened-rgb"
            if any(
                isinstance(page, dict)
                and page.get("color_render_strategy") == "flattened-rgb"
                for page in all_pages_meta
            )
            else "vector-original"
        )
        if kw.get("rectangle_mode"):
            final_meta["bleed_color_mode_requested"] = kw.get("bleed_color_type")
            final_meta["bleed_color_mode_applied"] = kw.get("bleed_color_type")

        if cut_mode != "none" and not any_dieline_found:
            try:
                if os.path.exists(output_path):
                    os.remove(output_path)
            except OSError:
                pass
            return False, {
                "error": _loi_khong_do_duoc_hinh(
                    # Cờ do các process con gắn vào meta từng trang (§BG.1).
                    any(
                        (m or {}).get("white_bg_detect_failed")
                        for m in all_pages_meta
                    )
                )
            }
        combined_warning = _compose_sticker_warning(all_pages_meta, pages_no_dieline)
        if combined_warning:
            final_meta["warning"] = combined_warning

        return True, final_meta
