"""
End-to-end tests cho StickerEngine.process_pdf — tính năng "Tạo viền bế (Cutline)".

Khác với test_cutline_contour.py (chỉ test hàm hình học thuần), file này chạy
TOÀN BỘ đường dẫn engine: rasterize → tìm contour → buffer offset/bleed →
xuất PDF có spot color CutContour + TrimBox.

Mục đích chính: chặn các lỗi tích hợp toàn-luồng (vd `NameError: settings`
ở bước "Save Output PDF") mà unit test hình học không thể phát hiện.

Cần deps nặng (cv2, pypdfium2, pikepdf, shapely, skimage) → đánh dấu để có thể
bỏ qua khi môi trường thiếu, nhưng KHÔNG nuốt lỗi crash thật.
"""
import hashlib
import math
import os
import sys

import pytest
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

pikepdf = pytest.importorskip("pikepdf")
pytest.importorskip("cv2")
pytest.importorskip("pypdfium2")
pytest.importorskip("shapely")
pytest.importorskip("skimage")

from shapely.geometry import MultiPolygon, Point, Polygon, box
from app.core.sticker_cutline_policy import resolve_sticker_corner_policy
from app.workers.cutline_machine_path import (
    MachinePathSegment,
    analyze_machine_path,
    cubic_segments_from_tuples,
)
from app.workers.sticker_engine import (
    ALPHA_CONTOUR_INSET_MM,
    ALPHA_CONTOUR_SIMPLIFY_MM,
    ALPHA_CONTOUR_THRESHOLD,
    StickerEngine,
    _ALPHA_SAFE_MAX_HAUSDORFF_MM,
    _ALPHA_SAFE_MIN_GAP_MM,
    _ALPHA_FIT_MAX_HAUSDORFF_MM,
    _alpha_adaptive_fit_profile,
    _PRESERVE_CORNER_QUAD_SEGS,
    _axis_aligned_rectangle_bbox,
    _PRESERVE_CORNER_RADIUS_MM,
    _build_adaptive_edge_color_source_mask,
    _build_feathered_bleed_join_mask,
    _compose_sticker_warning,
    _edge_color_instability_metrics,
    _edge_color_sampling_warning,
    _EXISTING_CONTOUR_SOURCE_PIXEL_BUDGET,
    _fit_alpha_bezier_paths,
    _fit_alpha_simplified_anchor_paths,
    _fit_preserved_contour_paths,
    _geometry_within_hausdorff_budget,
    _infer_document_image_pixel_mm,
    _infer_full_page_image_pixel_mm,
    _filter_full_page_jpeg_halo_components,
    _reconstruct_cut_geometry_parts,
    _PT_PER_MM,
    _round_preserved_corners,
    _safe_alpha_bezier_tension,
    _smooth_round_contour_points,
    _smooth_alpha_cut_contour,
)


def _make_simple_pdf(path: str) -> None:
    """Tạo 1 trang ~105x148mm: nền trắng + 1 hình chữ nhật đen ở giữa."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(297.6, 419.5))
    content = (
        b"1 1 1 rg 0 0 297.6 419.5 re f\n"   # nền trắng
        b"0 0 0 rg 80 120 140 180 re f\n"     # khối đen
    )
    page.Contents = pdf.make_stream(content)
    pdf.save(path)


def _make_radial_halo_pdf(path: str) -> None:
    """Fixture 300 DPI mô phỏng logo tròn có halo cyan sát mép."""
    import io
    import numpy as np
    from PIL import Image
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas

    height = width = 260
    center_y = center_x = 130
    yy, xx = np.ogrid[:height, :width]
    radius = np.sqrt((xx - center_x) ** 2 + (yy - center_y) ** 2)
    angle = (np.arctan2(yy - center_y, xx - center_x) + 2 * np.pi) % (2 * np.pi)
    blue = np.array([55, 126, 200], np.uint8)
    pale_cyan = np.array([210, 245, 250], np.uint8)
    image = np.full((height, width, 3), 255, np.uint8)
    image[radius <= 80] = blue
    fringe = (radius > 77) & (radius <= 80)
    alternating = ((angle * 24 / (2 * np.pi)).astype(int) % 2) == 0
    image[fringe & alternating] = pale_cyan

    png = io.BytesIO()
    Image.fromarray(image).save(png, format="PNG")
    png.seek(0)
    page_pts = width * 72.0 / 300.0
    pdf = canvas.Canvas(path, pagesize=(page_pts, page_pts), pageCompression=0)
    pdf.drawImage(
        ImageReader(png),
        0,
        0,
        width=page_pts,
        height=page_pts,
        mask="auto",
    )
    pdf.showPage()
    pdf.save()


def _make_large_jpeg_shape_pdf(path: str, shape: str, long_side_mm: float) -> None:
    """§NOODLE.8–11: một ảnh JPEG phủ trang, không DPI, ở scale sản xuất lớn."""
    import io
    import math
    from PIL import Image, ImageDraw
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas

    width, height = 2281, 2275
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    color = (18, 92, 168)
    if shape == "ellipse":
        draw.ellipse((260, 560, 2020, 1715), fill=color)
    elif shape == "rectangle":
        draw.rectangle((300, 510, 1980, 1765), fill=color)
    elif shape == "rounded_rectangle":
        draw.rounded_rectangle((300, 510, 1980, 1765), radius=230, fill=color)
    elif shape == "triangle":
        draw.polygon([(1140, 250), (2050, 1900), (230, 1900)], fill=color)
    elif shape == "star_custom":
        points = []
        for index in range(10):
            radius = 930 if index % 2 == 0 else 410
            angle = -math.pi / 2 + index * math.pi / 5
            points.append((
                1140 + radius * math.cos(angle),
                1137 + radius * math.sin(angle),
            ))
        draw.polygon(points, fill=color)
    elif shape == "heart":
        raw_points = []
        for index in range(720):
            t = 2 * math.pi * index / 720
            x = 16 * math.sin(t) ** 3
            y = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
            raw_points.append((x, -y))
        min_x = min(point[0] for point in raw_points)
        max_x = max(point[0] for point in raw_points)
        min_y = min(point[1] for point in raw_points)
        max_y = max(point[1] for point in raw_points)
        points = [
            (
                240 + (x - min_x) * 1800 / (max_x - min_x),
                260 + (y - min_y) * 1700 / (max_y - min_y),
            )
            for x, y in raw_points
        ]
        draw.polygon(points, fill=color)
    elif shape == "flower_12":
        points = []
        for index in range(720):
            angle = -math.pi / 2 + 2 * math.pi * index / 720
            radius = 720 + 190 * math.cos(12 * angle)
            points.append((
                1140 + radius * math.cos(angle),
                1137 + radius * math.sin(angle),
            ))
        draw.polygon(points, fill=color)
    elif shape == "gear_20":
        points = []
        for index in range(80):
            angle = -math.pi / 2 + 2 * math.pi * index / 80
            radius = 880 if index % 4 in (0, 1) else 690
            points.append((
                1140 + radius * math.cos(angle),
                1137 + radius * math.sin(angle),
            ))
        draw.polygon(points, fill=color)
    elif shape == "hourglass_narrow_neck":
        draw.polygon(
            [
                (300, 260), (1980, 260), (1370, 930), (1280, 1137),
                (1370, 1344), (1980, 2010), (300, 2010), (910, 1344),
                (1000, 1137), (910, 930),
            ],
            fill=color,
        )
    elif shape == "donut_one_hole":
        draw.ellipse((230, 210, 2050, 2050), fill=color)
        draw.ellipse((720, 700, 1560, 1560), fill="white")
    elif shape == "letter_b_two_holes":
        draw.rounded_rectangle((360, 180, 1840, 2080), radius=540, fill=color)
        draw.rectangle((360, 180, 1030, 2080), fill=color)
        draw.ellipse((850, 440, 1500, 1010), fill="white")
        draw.ellipse((850, 1260, 1500, 1840), fill="white")
    else:  # pragma: no cover - fixture chỉ gọi bằng param cố định
        raise ValueError(f"Hình test không hỗ trợ: {shape}")

    jpeg = io.BytesIO()
    image.save(jpeg, "JPEG", quality=82, subsampling=2, optimize=True)
    jpeg.seek(0)
    height_mm = long_side_mm * height / width
    pdf = canvas.Canvas(
        path,
        pagesize=(long_side_mm * _PT_PER_MM, height_mm * _PT_PER_MM),
        pageCompression=0,
    )
    pdf.drawImage(
        ImageReader(jpeg),
        0,
        0,
        width=long_side_mm * _PT_PER_MM,
        height=height_mm * _PT_PER_MM,
    )
    pdf.showPage()
    pdf.save()


def _make_rounded_rectangle_sticker_pdf(path: str) -> None:
    """Fixture tem chữ nhật bo góc có alpha và nền vàng-xanh chạy dọc."""
    import io
    import numpy as np
    from PIL import Image, ImageDraw
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas

    width, height = 360, 520
    rgba = np.zeros((height, width, 4), dtype=np.uint8)
    yy, xx = np.mgrid[:height, :width]
    rgba[:, :, 0] = np.clip(190 + xx * 40 / width, 0, 255).astype(np.uint8)
    rgba[:, :, 1] = np.clip(205 + yy * 25 / height, 0, 255).astype(np.uint8)
    rgba[:, :, 2] = 28
    alpha = Image.new("L", (width, height), 0)
    ImageDraw.Draw(alpha).rounded_rectangle(
        (0, 0, width - 1, height - 1),
        radius=30,
        fill=255,
    )
    rgba[:, :, 3] = np.asarray(alpha)

    png = io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(png, format="PNG")
    png.seek(0)
    source_dpi = 150.0
    page_width = width * 72.0 / source_dpi
    page_height = height * 72.0 / source_dpi
    pdf = canvas.Canvas(path, pagesize=(page_width, page_height), pageCompression=0)
    pdf.drawImage(
        ImageReader(png),
        0,
        0,
        width=page_width,
        height=page_height,
        mask="auto",
    )
    pdf.showPage()
    pdf.save()


def _make_white_outline_pdf(path: str, *, transparent: bool) -> None:
    """Fixture tem tròn có viền trắng; ngoài viền trong suốt hoặc nền tối phẳng."""
    import io
    import numpy as np
    from PIL import Image
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas

    size = 300
    source_dpi = 150.0
    yy, xx = np.ogrid[:size, :size]
    radius = np.sqrt((xx - 150) ** 2 + (yy - 150) ** 2)
    outer = radius <= 110
    artwork = radius <= 75

    rgb = np.full((size, size, 3), (24, 28, 24), dtype=np.uint8)
    rgb[outer] = (255, 255, 255)
    rgb[artwork] = (210, 42, 35)
    if transparent:
        rgba = np.dstack((rgb, np.where(outer, 255, 0).astype(np.uint8)))
        image = Image.fromarray(rgba, mode="RGBA")
    else:
        image = Image.fromarray(rgb, mode="RGB")

    png = io.BytesIO()
    image.save(png, format="PNG")
    png.seek(0)
    page_pts = size * 72.0 / source_dpi
    pdf = canvas.Canvas(path, pagesize=(page_pts, page_pts), pageCompression=0)
    pdf.drawImage(
        ImageReader(png),
        0,
        0,
        width=page_pts,
        height=page_pts,
        mask="auto",
    )
    pdf.showPage()
    pdf.save()


def _make_wavy_shell_alpha_pdf(path: str) -> None:
    """Fixture viền trắng hữu cơ nhiều lượn, có Alpha thật ở đúng 300 DPI."""
    import io
    from PIL import Image
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas

    width, height = 900, 700
    source_dpi = 300.0
    yy, xx = np.mgrid[:height, :width]
    center_x = (width - 1) / 2.0
    center_y = (height - 1) / 2.0
    nx = (xx - center_x) / 380.0
    ny = (yy - center_y) / 270.0
    angle = np.arctan2(ny, nx)
    radial = np.sqrt(nx * nx + ny * ny)
    shell = radial <= 1.0 + 0.06 * np.sin(12.0 * angle)
    artwork = radial <= 0.78
    rgb = np.full((height, width, 3), 255, dtype=np.uint8)
    rgb[artwork] = (42, 151, 72)
    rgba = np.dstack((rgb, np.where(shell, 255, 0).astype(np.uint8)))

    png = io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(png, format="PNG", dpi=(300, 300))
    png.seek(0)
    page_width = width * 72.0 / source_dpi
    page_height = height * 72.0 / source_dpi
    pdf = canvas.Canvas(path, pagesize=(page_width, page_height), pageCompression=0)
    pdf.drawImage(
        ImageReader(png),
        0,
        0,
        width=page_width,
        height=page_height,
        mask="auto",
    )
    pdf.showPage()
    pdf.save()


def _make_low_dpi_notched_alpha_pdf(path: str) -> None:
    """Fixture 72 DPI có nhiều hõm nông và gợn nhỏ như trang AI tách nhiều tem."""
    import io
    import cv2
    from PIL import Image
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas

    width, height = 386, 318
    source_dpi = 72.0
    angles = np.linspace(0.0, 2.0 * math.pi, 720, endpoint=False)
    radial = (
        1.0
        + 0.045 * np.sin(7.0 * angles + 0.4)
        + 0.025 * np.sin(19.0 * angles - 0.7)
        + 0.012 * np.sin(43.0 * angles + 0.2)
    )
    xs = width * 0.5 + 172.0 * radial * np.cos(angles)
    ys = height * 0.5 + 135.0 * radial * np.sin(angles)
    contour = np.rint(np.column_stack((xs, ys))).astype(np.int32)
    alpha = np.zeros((height, width), dtype=np.uint8)
    cv2.fillPoly(alpha, [contour], 255)
    # §AI-MOTION.10: râu nhỏ nối bằng cổ một pixel giống phần mask thừa của tem
    # AI thật. Fairing được phép bỏ râu này nhưng không được đổi số component.
    center_column = width // 2
    top_y = int(np.flatnonzero(alpha[:, center_column]).min())
    cv2.rectangle(
        alpha,
        (center_column - 1, max(1, top_y - 6)),
        (center_column, max(2, top_y - 5)),
        255,
        thickness=-1,
    )
    cv2.line(
        alpha,
        (center_column, max(2, top_y - 5)),
        (center_column, top_y),
        255,
        thickness=1,
    )
    rgb = np.full((height, width, 3), 255, dtype=np.uint8)
    inset = cv2.erode(alpha, np.ones((15, 15), dtype=np.uint8)) > 0
    rgb[inset] = (238, 45, 118)
    rgba = np.dstack((rgb, alpha))

    png = io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(png, format="PNG", dpi=(72, 72))
    png.seek(0)
    pdf = canvas.Canvas(path, pagesize=(width, height), pageCompression=0)
    pdf.drawImage(
        ImageReader(png),
        0,
        0,
        width=width,
        height=height,
        mask="auto",
    )
    pdf.showPage()
    pdf.save()


def _make_page_touching_circle_pdf(path: str, *, transparent: bool) -> None:
    """Tem tròn xanh chạm đúng bốn mép trang, nền trắng hoặc trong suốt."""
    import io
    import numpy as np
    from PIL import Image
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas

    size = 600
    page_points = 144.0
    yy, xx = np.mgrid[:size, :size]
    center = (size - 1) / 2.0
    radius = (size - 1) / 2.0
    circle = (xx - center) ** 2 + (yy - center) ** 2 <= radius ** 2
    rgb = np.full((size, size, 3), 255, dtype=np.uint8)
    rgb[circle] = (12, 125, 203)

    if transparent:
        alpha = np.where(circle, 255, 0).astype(np.uint8)
        image = Image.fromarray(np.dstack((rgb, alpha)), mode="RGBA")
    else:
        image = Image.fromarray(rgb, mode="RGB")

    png = io.BytesIO()
    image.save(png, format="PNG")
    png.seek(0)
    pdf = canvas.Canvas(
        path,
        pagesize=(page_points, page_points),
        pageCompression=0,
    )
    pdf.drawImage(
        ImageReader(png),
        0,
        0,
        width=page_points,
        height=page_points,
        mask="auto",
    )
    pdf.showPage()
    pdf.save()


def _make_full_page_raster_pdf(
    path: str,
    *,
    dpi: float,
    draw_twice: bool = False,
) -> None:
    """Tạo PDF ảnh toàn trang có DPI biết trước để kiểm hợp đồng suy luận."""
    import io
    import numpy as np
    from PIL import Image
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas

    width, height = 720, 360
    image = np.zeros((height, width, 3), dtype=np.uint8)
    image[:, :, 0] = 40
    image[:, :, 1] = 120
    image[:, :, 2] = 220
    payload = io.BytesIO()
    Image.fromarray(image, mode="RGB").save(payload, format="PNG")
    page_width = width * 72.0 / dpi
    page_height = height * 72.0 / dpi
    pdf = canvas.Canvas(path, pagesize=(page_width, page_height), pageCompression=0)
    if draw_twice:
        payload.seek(0)
        pdf.drawImage(
            ImageReader(payload),
            0,
            0,
            width=page_width * 0.5,
            height=page_height,
        )
        payload.seek(0)
        pdf.drawImage(
            ImageReader(payload),
            page_width * 0.5,
            0,
            width=page_width * 0.5,
            height=page_height,
        )
    else:
        payload.seek(0)
        pdf.drawImage(
            ImageReader(payload),
            0,
            0,
            width=page_width,
            height=page_height,
        )
    pdf.showPage()
    pdf.save()


def _read_all_content(page) -> bytes:
    raw = page.obj.get("/Contents")
    if isinstance(raw, pikepdf.Array):
        return b"\n".join(bytes(s.read_bytes()) for s in raw)
    return bytes(page.Contents.read_bytes())


def _parse_cut_machine_paths(page):
    """Đọc lại chính lệnh PDF đã lượng tử hóa để metric bám artifact giao máy."""
    cut = _read_all_content(page).split(b"/CutContour CS", 1)[1]
    paths = []
    segments = []
    current = None
    start = None
    for raw_line in cut.splitlines():
        tokens = raw_line.split()
        if not tokens:
            continue
        operation = tokens[-1]
        values = [float(value) for value in tokens[:-1]]
        if operation == b"m":
            if segments:
                paths.append(segments)
            segments = []
            current = (values[0], values[1])
            start = current
        elif operation == b"l" and current is not None:
            following = (values[0], values[1])
            segments.append(MachinePathSegment.line(current, following))
            current = following
        elif operation == b"c" and current is not None:
            following = (values[4], values[5])
            segments.append(MachinePathSegment.cubic(
                current,
                (values[0], values[1]),
                (values[2], values[3]),
                following,
            ))
            current = following
        elif operation == b"h" and current is not None and start is not None:
            if math.dist(current, start) > 1e-9:
                segments.append(MachinePathSegment.line(current, start))
            if segments:
                paths.append(segments)
            segments = []
            current = None
            start = None
    if segments:
        paths.append(segments)
    return paths


def _summarize_machine_paths(paths, *, join_threshold_degrees=1.0):
    """Gộp metric từng ring và lọc nhiễu lượng tử theo tỷ lệ kích thước hình."""
    metrics = [
        analyze_machine_path(
            path,
            mm_to_units=_PT_PER_MM,
            smooth_join_threshold_degrees=join_threshold_degrees,
            short_segment_threshold_mm=0.25,
            curvature_noise_floor_per_mm=(
                0.10
                / max(
                    math.hypot(
                        max(point[0] for segment in path for point in (segment.p0, segment.p3))
                        - min(point[0] for segment in path for point in (segment.p0, segment.p3)),
                        max(point[1] for segment in path for point in (segment.p0, segment.p3))
                        - min(point[1] for segment in path for point in (segment.p0, segment.p3)),
                    ) / _PT_PER_MM,
                    1e-9,
                )
            ),
        )
        for path in paths
    ]
    return {
        "segments": sum(metric.segment_count for metric in metrics),
        "short": sum(metric.short_segment_count for metric in metrics),
        "sharp_joins": sum(
            metric.discontinuous_join_count for metric in metrics
        ),
        "curvature_flips": sum(
            metric.curvature_sign_flip_count for metric in metrics
        ),
        "p95_curvature_jump": max(
            (metric.p95_curvature_jump_per_mm or 0.0 for metric in metrics),
            default=0.0,
        ),
        "maximum_curvature_jump": max(
            (metric.maximum_curvature_jump_per_mm or 0.0 for metric in metrics),
            default=0.0,
        ),
    }


@pytest.fixture()
def src_pdf(tmp_path):
    p = tmp_path / "src.pdf"
    _make_simple_pdf(str(p))
    return str(p)


def test_process_pdf_original_round_succeeds(src_pdf, tmp_path):
    """Ca cơ bản: cắt theo hình gốc, góc tròn, offset dương.

    Đây là REGRESSION TEST cho lỗi crash ở bước 'Save Output PDF'
    (`NameError: name 'settings' is not defined`) khiến tính năng luôn trả 500.
    """
    out = str(tmp_path / "out.pdf")
    engine = StickerEngine(dpi=300)

    success, meta = engine.process_pdf(
        input_path=src_pdf, output_path=out,
        cut_mode="original", offset_mm=1.0, corner_style="round", bleed_mm=0.0,
    )

    assert success is True
    assert os.path.exists(out) and os.path.getsize(out) > 0
    assert meta.get("width_mm", 0) > 0 and meta.get("height_mm", 0) > 0
    assert "pages" in meta

    with pikepdf.Pdf.open(out) as o:
        page = o.pages[0]
        cs = page.obj.get("/Resources", {}).get("/ColorSpace", {})
        assert "/CutContour" in cs, "Phải đăng ký spot color CutContour"
        assert b"/CutContour CS" in _read_all_content(page), "Phải vẽ đường cắt CutContour"
        assert "/TrimBox" in page.obj, "Phải gắn TrimBox theo viền cắt"



def test_preserve_corner_rounding_is_softer_without_node_explosion():
    contour = Polygon([
        (0, 0), (20, 0), (20, 20), (12, 20),
        (12, 6), (8, 6), (8, 20), (0, 20),
    ])
    mm_to_pts = 72.0 / 25.4
    previous = _round_preserved_corners(
        contour, radius_pts=0.20 * mm_to_pts, quad_segs=2
    )
    softened = _round_preserved_corners(
        contour,
        radius_pts=_PRESERVE_CORNER_RADIUS_MM * mm_to_pts,
        quad_segs=_PRESERVE_CORNER_QUAD_SEGS,
    )

    assert softened.is_valid
    assert softened.bounds == pytest.approx(contour.bounds)
    assert softened.area > previous.area + 0.10
    assert len(softened.exterior.coords) <= 32


def test_alpha_safe_smoothing_reduces_raster_nodes_within_error_budget():
    """Alpha cong/lỗ phải bớt node nhưng không vượt biên hoặc đổi topology."""
    import cv2
    import numpy as np
    from skimage import measure

    size = 600
    mask = np.zeros((size, size), dtype=np.uint8)
    cv2.circle(mask, (300, 300), 220, 255, cv2.FILLED)
    cv2.circle(mask, (300, 300), 75, 0, cv2.FILLED)

    rings = [
        Polygon((contour - 1)[:, [1, 0]] * (72.0 / 300.0))
        for contour in measure.find_contours(np.pad(mask, 1), 127.5)
    ]
    rings.sort(key=lambda polygon: polygon.area, reverse=True)
    alpha_geometry = Polygon(
        rings[0].exterior.coords,
        [rings[1].exterior.coords],
    )
    mm_to_pts = 72.0 / 25.4
    total_offset_pts = -ALPHA_CONTOUR_INSET_MM * mm_to_pts
    ideal_cut = alpha_geometry.buffer(total_offset_pts, join_style=1).buffer(
        0.01, join_style=1
    )
    legacy = ideal_cut.simplify(
        ALPHA_CONTOUR_SIMPLIFY_MM * mm_to_pts,
        preserve_topology=True,
    )
    smoothed, anchor_deviation_pts = _smooth_alpha_cut_contour(
        alpha_geometry,
        ideal_cut,
        total_offset_pts=total_offset_pts,
        mm_to_pts=mm_to_pts,
    )

    def node_count(polygon) -> int:
        return (
            len(polygon.exterior.coords) - 1
            + sum(len(interior.coords) - 1 for interior in polygon.interiors)
        )

    assert smoothed.is_valid
    assert len(smoothed.interiors) == len(ideal_cut.interiors) == 1
    assert node_count(smoothed) <= node_count(legacy) * 0.40
    assert ideal_cut.hausdorff_distance(smoothed) / mm_to_pts <= (
        _ALPHA_SAFE_MAX_HAUSDORFF_MM + 1e-6
    )
    assert alpha_geometry.boundary.distance(smoothed.boundary) / mm_to_pts >= (
        _ALPHA_SAFE_MIN_GAP_MM - 1e-6
    )
    assert smoothed.difference(alpha_geometry).area <= 1e-9
    assert _safe_alpha_bezier_tension(
        alpha_geometry,
        ideal_cut,
        smoothed,
        total_offset_pts=total_offset_pts,
        mm_to_pts=mm_to_pts,
        anchor_deviation_pts=anchor_deviation_pts,
    ) is not None

    fitted = _fit_alpha_bezier_paths(
        alpha_geometry,
        ideal_cut,
        total_offset_pts=total_offset_pts,
        mm_to_pts=mm_to_pts,
    )
    assert fitted is not None
    fitted_geometry, fitted_paths, _tolerance_mm = fitted
    assert fitted_geometry.is_valid
    assert len(fitted_geometry.interiors) == 1
    assert ideal_cut.hausdorff_distance(fitted_geometry) / mm_to_pts <= (
        _ALPHA_FIT_MAX_HAUSDORFF_MM + 1e-6
    )
    assert alpha_geometry.boundary.distance(fitted_geometry.boundary) / mm_to_pts >= (
        _ALPHA_SAFE_MIN_GAP_MM - 1e-6
    )
    assert sum(len(path) for path in fitted_paths) < node_count(smoothed)


def test_adaptive_alpha_fit_locks_convex_and_concave_star_corners():
    """Đỉnh sao phải là neo thật; Bézier không được lướt qua làm cùn góc lõm."""
    import math

    center = (60.0, 60.0)
    vertices = []
    for index in range(10):
        angle = -math.pi / 2.0 + index * math.pi / 5.0
        radius = 42.0 if index % 2 == 0 else 18.0
        vertices.append((
            center[0] + math.cos(angle) * radius,
            center[1] + math.sin(angle) * radius,
        ))

    # Mô phỏng contour raster dày node trên từng cạnh; simplify vật lý sẽ bỏ
    # các điểm thẳng này nhưng phải giữ nguyên 10 đỉnh lồi/lõm.
    dense = []
    for start, end in zip(vertices, vertices[1:] + vertices[:1]):
        for step in range(18):
            ratio = step / 18.0
            dense.append((
                start[0] + (end[0] - start[0]) * ratio,
                start[1] + (end[1] - start[1]) * ratio,
            ))
    ideal_cut = Polygon(dense)
    mm_to_pts = 72.0 / 25.4

    fitted = _fit_alpha_bezier_paths(
        ideal_cut,
        ideal_cut,
        total_offset_pts=0.0,
        mm_to_pts=mm_to_pts,
        corner_policy="adaptive",
    )

    assert fitted is not None
    fitted_geometry, fitted_paths, _tolerance_mm = fitted
    assert fitted_geometry.is_valid
    assert len(fitted_paths) == 1
    assert 10 <= len(fitted_paths[0]) <= 20
    anchors = [segment[0] for segment in fitted_paths[0]]
    for vertex in vertices:
        assert min(math.dist(vertex, anchor) for anchor in anchors) <= 1e-6
    assert ideal_cut.hausdorff_distance(fitted_geometry) / mm_to_pts <= (
        _ALPHA_FIT_MAX_HAUSDORFF_MM + 1e-6
    )


def test_adaptive_alpha_fit_uses_guarded_whole_ring_before_node_fallback(monkeypatch):
    """Span góc lỗi không được đẩy contour trơn về một cubic cho mỗi node."""
    import math
    from app.workers import sticker_engine as sticker_module

    contour = Polygon([
        (50.0 + 30.0 * math.cos(index * 2.0 * math.pi / 180.0),
         50.0 + 30.0 * math.sin(index * 2.0 * math.pi / 180.0))
        for index in range(180)
    ])
    monkeypatch.setattr(
        sticker_module,
        "fit_closed_cubic_beziers_adaptive",
        lambda *_args, **_kwargs: [],
    )

    fitted = _fit_alpha_bezier_paths(
        contour,
        contour,
        total_offset_pts=0.0,
        mm_to_pts=72.0 / 25.4,
        corner_policy="adaptive",
    )

    assert fitted is not None
    assert sum(len(path) for path in fitted[1]) < 20


def test_adaptive_alpha_fit_scales_with_large_low_dpi_artwork():
    """Ảnh lớn/72 DPI phải giảm răng cưa theo pixel nguồn, không giữ ngưỡng 0,12 mm."""
    import cv2
    import numpy as np
    from skimage import measure

    source = np.zeros((300, 300), dtype=np.uint8)
    cv2.circle(source, (150, 150), 110, 255, cv2.FILLED)
    render_scale = 300.0 / 72.0
    rendered = cv2.resize(
        source,
        None,
        fx=render_scale,
        fy=render_scale,
        interpolation=cv2.INTER_LINEAR,
    )
    _, rendered = cv2.threshold(rendered, 64, 255, cv2.THRESH_BINARY)
    alpha_geometry = max(
        (
            Polygon((contour - 1)[:, [1, 0]] / render_scale)
            for contour in measure.find_contours(np.pad(rendered, 1), 127.5)
        ),
        key=lambda polygon: polygon.area,
    )
    mm_to_pts = 72.0 / 25.4
    total_offset_pts = -ALPHA_CONTOUR_INSET_MM * mm_to_pts
    ideal_cut = alpha_geometry.buffer(total_offset_pts, join_style=1)
    max_hausdorff_mm, _window_mm, _separation_mm = _alpha_adaptive_fit_profile(
        ideal_cut,
        mm_to_pts=mm_to_pts,
        source_pixel_mm=25.4 / 72.0,
    )

    fitted = _fit_alpha_bezier_paths(
        alpha_geometry,
        ideal_cut,
        total_offset_pts=total_offset_pts,
        mm_to_pts=mm_to_pts,
        corner_policy="adaptive",
        source_pixel_mm=25.4 / 72.0,
    )

    assert max_hausdorff_mm > _ALPHA_FIT_MAX_HAUSDORFF_MM
    assert fitted is not None
    fitted_geometry, fitted_paths, _tolerance_mm = fitted
    assert sum(len(path) for path in fitted_paths) < 120
    assert ideal_cut.hausdorff_distance(fitted_geometry) / mm_to_pts <= (
        max_hausdorff_mm + 1e-6
    )
    assert alpha_geometry.buffer(
        -_ALPHA_SAFE_MIN_GAP_MM * mm_to_pts,
        join_style=1,
    ).covers(fitted_geometry)


def test_adaptive_alpha_fit_does_not_multiply_nodes_with_physical_size():
    """Cùng một biên tròn 72 DPI không được khóa bậc pixel thành node khi khổ tăng."""
    import cv2
    import numpy as np

    mm_to_pts = 72.0 / 25.4
    source_pixel_mm = 25.4 / 72.0
    segment_limits = {
        50: 8,
        200: 12,
        500: 16,
        1_000: 24,
    }
    segment_counts = []

    for diameter_mm, segment_limit in segment_limits.items():
        diameter_px = max(12, round(diameter_mm / source_pixel_mm))
        padding = 8
        mask = np.zeros(
            (diameter_px + padding * 2, diameter_px + padding * 2),
            dtype=np.uint8,
        )
        cv2.circle(
            mask,
            (diameter_px // 2 + padding, diameter_px // 2 + padding),
            diameter_px // 2,
            255,
            cv2.FILLED,
        )
        contour = max(
            cv2.findContours(
                mask,
                cv2.RETR_EXTERNAL,
                cv2.CHAIN_APPROX_NONE,
            )[0],
            key=cv2.contourArea,
        )
        alpha_geometry = Polygon(
            (float(x), float(y)) for x, y in contour[:, 0, :]
        )
        max_hausdorff_mm, _window_mm, _separation_mm = (
            _alpha_adaptive_fit_profile(
                alpha_geometry,
                mm_to_pts=mm_to_pts,
                source_pixel_mm=source_pixel_mm,
            )
        )

        fitted = _fit_alpha_bezier_paths(
            alpha_geometry,
            alpha_geometry,
            total_offset_pts=0.0,
            mm_to_pts=mm_to_pts,
            corner_policy="adaptive",
            source_pixel_mm=source_pixel_mm,
        )

        assert fitted is not None
        fitted_geometry, fitted_paths, _tolerance_mm = fitted
        segment_count = sum(len(path) for path in fitted_paths)
        segment_counts.append(segment_count)
        assert fitted_geometry.is_valid
        assert len(fitted_paths) == 1
        assert segment_count <= segment_limit
        assert alpha_geometry.hausdorff_distance(fitted_geometry) / mm_to_pts <= (
            max_hausdorff_mm + 1e-6
        )

    # Tăng đường kính 20 lần có thể cần thêm cubic vì ngân sách sai lệch vẫn tuyệt
    # đối theo mm, nhưng không được quay lại mức tăng gần tuyến tính theo số pixel.
    assert segment_counts[-1] <= segment_counts[0] * 6


def test_adaptive_alpha_fallback_smooths_dense_notches_without_losing_them():
    """Contour nhiều góc phải giảm node nhưng vẫn giữ từng đỉnh lồi/lõm và biên an toàn."""
    import math

    mm_to_pts = 72.0 / 25.4
    vertices = []
    for index in range(96):
        angle = index * 2.0 * math.pi / 96.0
        radius = 300.0 if index % 2 == 0 else 268.0
        vertices.append((
            340.0 + math.cos(angle) * radius,
            340.0 + math.sin(angle) * radius,
        ))
    dense = []
    for start, end in zip(vertices, vertices[1:] + vertices[:1]):
        for step in range(8):
            ratio = step / 8.0
            dense.append((
                start[0] + (end[0] - start[0]) * ratio,
                start[1] + (end[1] - start[1]) * ratio,
            ))
    alpha_geometry = Polygon(dense)
    total_offset_pts = -ALPHA_CONTOUR_INSET_MM * mm_to_pts
    ideal_cut = alpha_geometry.buffer(total_offset_pts, join_style=1)
    max_hausdorff_mm, corner_window_mm, corner_separation_mm = (
        _alpha_adaptive_fit_profile(
            ideal_cut,
            mm_to_pts=mm_to_pts,
            source_pixel_mm=25.4 / 72.0,
        )
    )

    fitted = _fit_alpha_simplified_anchor_paths(
        alpha_geometry,
        ideal_cut,
        total_offset_pts=total_offset_pts,
        mm_to_pts=mm_to_pts,
        max_hausdorff_mm=max_hausdorff_mm,
        corner_window_mm=corner_window_mm,
        corner_separation_mm=corner_separation_mm,
    )

    assert fitted is not None
    fitted_geometry, fitted_paths, _simplify_mm = fitted
    segment_count = sum(len(path) for path in fitted_paths)
    assert fitted_geometry.is_valid
    assert len(fitted_paths) == 1
    assert 90 <= segment_count <= 120
    assert ideal_cut.hausdorff_distance(fitted_geometry) / mm_to_pts <= (
        max_hausdorff_mm + 1e-6
    )
    assert alpha_geometry.buffer(
        -_ALPHA_SAFE_MIN_GAP_MM * mm_to_pts,
        join_style=1,
    ).covers(fitted_geometry)


def test_adaptive_alpha_machine_selector_keeps_wavy_shell_g1_and_long_commands():
    """Viền hữu cơ nhiều lượn phải giữ quỹ đạo nhưng không khóa lượn thành khớp gãy."""
    mm_to_pts = 72.0 / 25.4
    points = []
    for index in range(360):
        angle = index * 2.0 * math.pi / 360.0
        radius = 1.0 + 0.06 * math.sin(12.0 * angle)
        points.append((
            (50.0 + 42.0 * radius * math.cos(angle)) * mm_to_pts,
            (38.0 + 28.0 * radius * math.sin(angle)) * mm_to_pts,
        ))
    alpha_geometry = Polygon(points)
    total_offset_pts = -ALPHA_CONTOUR_INSET_MM * mm_to_pts
    ideal_cut = alpha_geometry.buffer(total_offset_pts, join_style=1)
    max_hausdorff_mm, _window_mm, _separation_mm = (
        _alpha_adaptive_fit_profile(
            ideal_cut,
            mm_to_pts=mm_to_pts,
            source_pixel_mm=25.4 / 300.0,
        )
    )

    fitted = _fit_alpha_bezier_paths(
        alpha_geometry,
        ideal_cut,
        total_offset_pts=total_offset_pts,
        mm_to_pts=mm_to_pts,
        corner_policy="adaptive",
        source_pixel_mm=25.4 / 300.0,
    )

    assert fitted is not None
    fitted_geometry, fitted_paths, _tolerance_mm = fitted
    diagonal_mm = math.hypot(
        fitted_geometry.bounds[2] - fitted_geometry.bounds[0],
        fitted_geometry.bounds[3] - fitted_geometry.bounds[1],
    ) / mm_to_pts
    metrics = [
        analyze_machine_path(
            cubic_segments_from_tuples(path),
            mm_to_units=mm_to_pts,
            smooth_join_threshold_degrees=1.0,
            short_segment_threshold_mm=0.25,
            curvature_noise_floor_per_mm=0.10 / diagonal_mm,
        )
        for path in fitted_paths
    ]

    assert sum(metric.short_segment_count for metric in metrics) == 0
    assert sum(metric.discontinuous_join_count for metric in metrics) == 0
    assert max(
        metric.maximum_join_angle_degrees or 0.0
        for metric in metrics
    ) < 0.001
    assert ideal_cut.hausdorff_distance(fitted_geometry) / mm_to_pts <= (
        max_hausdorff_mm + 1e-6
    )
    assert alpha_geometry.buffer(
        -_ALPHA_SAFE_MIN_GAP_MM * mm_to_pts,
        join_style=1,
    ).covers(fitted_geometry)


@pytest.mark.parametrize("dpi", [72.0, 300.0])
def test_full_page_image_dpi_inference_is_physical_and_strict(tmp_path, dpi):
    source = tmp_path / f"full_page_{int(dpi)}.pdf"
    _make_full_page_raster_pdf(str(source), dpi=dpi)

    with pikepdf.Pdf.open(source) as document:
        expected = 25.4 / dpi
        assert _infer_full_page_image_pixel_mm(document.pages[0]) == pytest.approx(
            expected,
            rel=0.01,
        )
        assert _infer_document_image_pixel_mm(document) == pytest.approx(
            expected,
            rel=0.01,
        )


def test_full_page_image_dpi_inference_rejects_vector_and_multi_image(tmp_path):
    vector_source = tmp_path / "vector.pdf"
    multi_source = tmp_path / "multi_image.pdf"
    page_72 = tmp_path / "page_72.pdf"
    page_300 = tmp_path / "page_300.pdf"
    inconsistent_source = tmp_path / "inconsistent_dpi.pdf"
    _make_simple_pdf(str(vector_source))
    _make_full_page_raster_pdf(str(multi_source), dpi=72.0, draw_twice=True)
    _make_full_page_raster_pdf(str(page_72), dpi=72.0)
    _make_full_page_raster_pdf(str(page_300), dpi=300.0)
    combined = pikepdf.Pdf.new()
    with pikepdf.Pdf.open(page_72) as first, pikepdf.Pdf.open(page_300) as second:
        combined.pages.extend(first.pages)
        combined.pages.extend(second.pages)
    combined.save(inconsistent_source)
    combined.close()

    with pikepdf.Pdf.open(vector_source) as document:
        assert _infer_document_image_pixel_mm(document) is None
    with pikepdf.Pdf.open(multi_source) as document:
        assert _infer_document_image_pixel_mm(document) is None
    with pikepdf.Pdf.open(inconsistent_source) as document:
        assert _infer_document_image_pixel_mm(document) is None


def test_preserved_large_raster_contour_scales_smoothing_by_physical_size():
    """Tem 72 DPI khổ lớn phải ít cubic, không giữ một node cho mỗi bậc pixel."""
    import cv2
    import numpy as np

    mm_to_pts = 72.0 / 25.4
    source_pixel_mm = 25.4 / 72.0
    diameter_mm = 500.0
    diameter_px = round(diameter_mm / source_pixel_mm)
    padding = 8
    mask = np.zeros(
        (diameter_px + padding * 2, diameter_px + padding * 2),
        dtype=np.uint8,
    )
    cv2.circle(
        mask,
        (diameter_px // 2 + padding, diameter_px // 2 + padding),
        diameter_px // 2,
        255,
        cv2.FILLED,
    )
    contour = max(
        cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)[0],
        key=cv2.contourArea,
    )
    geometry = Polygon(
        (float(x), float(y)) for x, y in contour[:, 0, :]
    )

    fitted = _fit_preserved_contour_paths(
        geometry,
        mm_to_pts=mm_to_pts,
        source_pixel_mm=source_pixel_mm,
    )

    assert fitted is not None
    fitted_geometry, fitted_paths, _simplify_mm = fitted
    assert fitted_geometry.is_valid
    assert len(fitted_paths) == 1
    assert sum(len(path) for path in fitted_paths) <= 24
    max_hausdorff_mm = max(
        0.45,
        source_pixel_mm * _EXISTING_CONTOUR_SOURCE_PIXEL_BUDGET,
    )
    assert geometry.hausdorff_distance(fitted_geometry) / mm_to_pts <= (
        max_hausdorff_mm + 1e-6
    )


def test_preserved_large_smooth_flower_has_no_artificial_machine_joins():
    """Cực trị cong của hoa không được biến thành góc gãy khi tem phóng lớn."""
    import cv2
    import math
    import numpy as np
    from app.workers.cutline_machine_path import (
        analyze_machine_path,
        cubic_segments_from_tuples,
    )

    source_size = 1200
    center = source_size * 0.5
    vertices = []
    for index in range(720):
        angle = index * 2.0 * math.pi / 720.0
        radius = 380.0 + 100.0 * math.cos(12.0 * angle)
        vertices.append((
            round(center + math.cos(angle) * radius),
            round(center + math.sin(angle) * radius),
        ))
    mask = np.zeros((source_size, source_size), dtype=np.uint8)
    cv2.fillPoly(mask, [np.asarray(vertices, dtype=np.int32)], 255)
    render_scale = 4.0
    rendered = cv2.resize(
        mask,
        None,
        fx=render_scale,
        fy=render_scale,
        interpolation=cv2.INTER_LINEAR,
    )
    _, rendered = cv2.threshold(rendered, 64, 255, cv2.THRESH_BINARY)
    contour = max(
        cv2.findContours(rendered, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)[0],
        key=cv2.contourArea,
    )

    mm_to_pts = 72.0 / 25.4
    long_side_mm = 1600.0
    source_pixel_mm = long_side_mm / source_size
    pixel_to_pts = source_pixel_mm / render_scale * mm_to_pts
    geometry = Polygon(
        (float(x) * pixel_to_pts, float(y) * pixel_to_pts)
        for x, y in contour[:, 0, :]
    )

    fitted = _fit_preserved_contour_paths(
        geometry,
        mm_to_pts=mm_to_pts,
        source_pixel_mm=source_pixel_mm,
    )

    assert fitted is not None
    fitted_geometry, fitted_paths, _simplify_mm = fitted
    assert fitted_geometry.is_valid
    assert len(fitted_paths) == 1
    metrics = analyze_machine_path(
        cubic_segments_from_tuples(fitted_paths[0]),
        mm_to_units=mm_to_pts,
        smooth_join_threshold_degrees=1.0,
        short_segment_threshold_mm=0.25,
    )
    assert metrics.discontinuous_join_count == 0
    assert metrics.maximum_join_angle_degrees is not None
    assert metrics.maximum_join_angle_degrees <= 1.0
    max_hausdorff_mm = max(
        0.20,
        source_pixel_mm * _EXISTING_CONTOUR_SOURCE_PIXEL_BUDGET,
    )
    assert geometry.hausdorff_distance(fitted_geometry) / mm_to_pts <= (
        max_hausdorff_mm + 1e-6
    )


def test_preserved_large_raster_star_keeps_convex_and_concave_corners():
    """Làm mượt tem lớn không được lướt qua đỉnh lồi/lõm của hình sao."""
    import cv2
    import math
    import numpy as np

    mm_to_pts = 72.0 / 25.4
    source_pixel_mm = 25.4 / 72.0
    size = 900
    center = size * 0.5
    expected_vertices = []
    for index in range(10):
        angle = -math.pi / 2.0 + index * math.pi / 5.0
        radius = 390.0 if index % 2 == 0 else 165.0
        expected_vertices.append((
            center + math.cos(angle) * radius,
            center + math.sin(angle) * radius,
        ))
    mask = np.zeros((size, size), dtype=np.uint8)
    cv2.fillPoly(mask, [np.asarray(expected_vertices, dtype=np.int32)], 255)
    contour = max(
        cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)[0],
        key=cv2.contourArea,
    )
    geometry = Polygon(
        (float(x), float(y)) for x, y in contour[:, 0, :]
    )

    fitted = _fit_preserved_contour_paths(
        geometry,
        mm_to_pts=mm_to_pts,
        source_pixel_mm=source_pixel_mm,
    )

    assert fitted is not None
    fitted_geometry, fitted_paths, _simplify_mm = fitted
    assert fitted_geometry.is_valid
    assert 10 <= len(fitted_paths[0]) <= 24
    anchors = [segment[0] for segment in fitted_paths[0]]
    for vertex in expected_vertices:
        assert min(math.dist(vertex, anchor) for anchor in anchors) / mm_to_pts <= 0.55
    max_hausdorff_mm = max(
        0.45,
        source_pixel_mm * _EXISTING_CONTOUR_SOURCE_PIXEL_BUDGET,
    )
    assert geometry.hausdorff_distance(fitted_geometry) / mm_to_pts <= (
        max_hausdorff_mm + 1e-6
    )


@pytest.mark.parametrize("budget", [0.05, 0.20])
def test_buffer_guard_matches_exact_hausdorff_for_polygon_with_hole(budget):
    """Guard nhanh phải cùng kết luận với Hausdorff GEOS, kể cả geometry có lỗ."""
    geometry = Polygon(
        [(0, 0), (10, 0), (10, 10), (0, 10)],
        [[(3, 3), (7, 3), (7, 7), (3, 7)]],
    )
    candidate = geometry.buffer(-0.10, join_style=1)
    expected = geometry.hausdorff_distance(candidate) <= budget

    assert _geometry_within_hausdorff_budget(
        geometry,
        candidate,
        budget,
        first_envelope=geometry.buffer(budget, join_style=1),
    ) is expected


def test_preserve_mode_keeps_auto_safe_shape_contract(src_pdf, tmp_path):
    """Giữ góc không được âm thầm tắt auto_safe; forceContour mới làm việc đó."""
    out = str(tmp_path / "preserve.pdf")
    success, meta = StickerEngine(dpi=300).process_pdf(
        input_path=src_pdf,
        output_path=out,
        cut_mode="original",
        offset_mm=0.0,
        corner_style="preserve",
        bleed_mm=0.0,
        fill_holes=True,
        remove_white_bg=True,
        draw_cut_contour=True,
        shape_mode="auto_safe",
    )

    assert success is True
    assert meta["pages"][0]["cut_kind"] == "rect"
    with pikepdf.Pdf.open(out) as result:
        page = result.pages[0]
        cut_stream = _read_all_content(page).split(b"/CutContour CS", 1)[1]
        line_count = cut_stream.count(b" l\n")
        assert line_count == 3, "hình chữ nhật chuẩn phải chỉ có bốn cạnh kể cả lệnh close"
        assert b" c\n" not in cut_stream
        trim = [float(v) for v in page.TrimBox]
        assert abs((trim[2] - trim[0]) - 140.0) < 0.6
        assert abs((trim[3] - trim[1]) - 180.0) < 0.6


def test_noodle_filter_bo_halo_sat_nhung_giu_component_o_xa():
    """§NOODLE.1: mảnh JPEG sát tem lớn bị bỏ; component thật ở xa vẫn giữ."""
    source_pixel_mm = 25.4 / 72.0
    main = Point(0, 0).buffer(400 * _PT_PER_MM, resolution=64)
    near_halo = box(
        401.6 * _PT_PER_MM,
        -4 * _PT_PER_MM,
        402.1 * _PT_PER_MM,
        4 * _PT_PER_MM,
    )
    distant_component = box(
        430 * _PT_PER_MM,
        0,
        430.5 * _PT_PER_MM,
        8 * _PT_PER_MM,
    )

    kept, dropped = _filter_full_page_jpeg_halo_components(
        [main, near_halo, distant_component],
        source_pixel_mm,
    )

    assert dropped == 1
    assert main in kept
    assert distant_component in kept
    assert near_halo not in kept


def test_noodle_filter_giu_component_day_va_fail_safe_khi_thieu_dpi():
    """Tem phụ đủ dày và PDF không có bằng chứng ảnh phủ trang đều được giữ."""
    main = Point(0, 0).buffer(400 * _PT_PER_MM, resolution=64)
    meaningful = box(
        400.2 * _PT_PER_MM,
        -3 * _PT_PER_MM,
        406.2 * _PT_PER_MM,
        3 * _PT_PER_MM,
    )
    kept, dropped = _filter_full_page_jpeg_halo_components(
        [main, meaningful],
        25.4 / 72.0,
    )
    assert dropped == 0
    assert kept == [main, meaningful]

    unchanged, dropped_without_evidence = _filter_full_page_jpeg_halo_components(
        [main, meaningful],
        None,
    )
    assert dropped_without_evidence == 0
    assert unchanged == [main, meaningful]


def test_noodle_luot_hai_chi_bo_manh_rat_nho_o_khoang_cach_mo_rong():
    """§NOODLE.6: ngưỡng rộng chỉ ăn mảnh cực nhỏ, không ăn chi tiết có nghĩa."""
    source_pixel_mm = 0.4
    main = Point(0, 0).buffer(400 * _PT_PER_MM, resolution=64)
    far_halo = box(
        403.5 * _PT_PER_MM,
        -1.4 * _PT_PER_MM,
        405.0 * _PT_PER_MM,
        1.4 * _PT_PER_MM,
    )
    meaningful = box(
        403.5 * _PT_PER_MM,
        -1.0 * _PT_PER_MM,
        407.5 * _PT_PER_MM,
        1.0 * _PT_PER_MM,
    )

    conservative, dropped_conservative = _filter_full_page_jpeg_halo_components(
        [main, far_halo, meaningful],
        source_pixel_mm,
    )
    assert dropped_conservative == 0
    assert conservative == [main, far_halo, meaningful]

    recognized, dropped_recognized = _filter_full_page_jpeg_halo_components(
        [main, far_halo, meaningful],
        source_pixel_mm,
        max_area_fraction=1.0e-5,
        max_gap_source_px=12.0,
    )
    assert dropped_recognized == 1
    assert far_halo not in recognized
    assert meaningful in recognized


def test_noodle_island_muc_yeu_bi_bo_nhung_cham_muc_that_duoc_giu():
    """§NOODLE.9: cùng kích thước/vị trí, chỉ ringing gần trắng bị loại."""
    source_pixel_mm = 0.35
    main = box(10, 10, 2010, 2010)
    weak_island = box(2017, 50, 2023, 56)
    dark_dot = box(2017, 100, 2023, 106)
    image = np.full((2050, 2050, 3), 255, dtype=np.uint8)
    image[49:58, 2016:2025] = 245
    image[99:108, 2016:2025] = 20

    kept, dropped = _filter_full_page_jpeg_halo_components(
        [main, weak_island, dark_dot],
        source_pixel_mm,
        image_rgb=image,
        geometry_px_per_point=1.0,
    )

    assert dropped == 1
    assert weak_island not in kept
    assert dark_dot in kept


def test_noodle_simplified_probe_nhan_alias_nhung_giu_guard_hausdorff():
    """§NOODLE.7: dải alias trung gian được nhận hình chỉ trong sai số 0,35 mm."""
    count = 5272
    angles = np.linspace(0.0, 2.0 * np.pi, count, endpoint=False)
    radii = (50.0 + 0.15 * np.sin(160.0 * angles)) * _PT_PER_MM
    raster_alias = np.column_stack((
        radii * np.cos(angles),
        radii * np.sin(angles),
    ))
    pre_smoothed = _smooth_round_contour_points(
        raster_alias,
        source_pixel_mm=0.04384042,
        contour_px_per_mm=11.811,
    )

    rebuilt, meta = _reconstruct_cut_geometry_parts(
        Polygon(pre_smoothed),
        "auto_safe",
        11.811,
        0.04384042,
    )

    assert meta["kind"] == "circle"
    assert meta["simplified_probe"] is True
    assert meta["probe_hausdorff_mm"] <= 0.35
    assert len(rebuilt.exterior.coords) == 97


def test_noodle_reconstruct_tung_component_va_probe_theo_pixel_nguon():
    """§NOODLE.2–3: component xấu không khóa hình tốt; probe lọc nhận tem lớn."""
    circle = Point(0, 0).buffer(100 * _PT_PER_MM, resolution=64)
    custom = Polygon([(1000, 0), (1050, 10), (1030, 70), (960, 58), (950, 16)])
    rebuilt, meta = _reconstruct_cut_geometry_parts(
        MultiPolygon([circle, custom]),
        "auto_safe",
        12.0,
    )
    assert meta["component_count"] == 2
    assert meta["component_reconstructed_count"] == 1
    assert meta["dominant_reconstructed"] is True
    assert meta["dominant_kind"] == "circle"
    parts = sorted(rebuilt.geoms, key=lambda part: part.area, reverse=True)
    assert len(parts[0].exterior.coords) == 97
    assert len(parts[1].exterior.coords) == len(custom.exterior.coords)

    count = 4096
    angles = np.linspace(0.0, 2.0 * np.pi, count, endpoint=False)
    radii = (400.0 + 4.0 * np.sin(320.0 * angles)) * _PT_PER_MM
    noisy_circle = Polygon(np.column_stack((
        radii * np.cos(angles),
        radii * np.sin(angles),
    )))
    rebuilt_circle, circle_meta = _reconstruct_cut_geometry_parts(
        noisy_circle,
        "auto_safe",
        7.45,
        25.4 / 72.0,
    )
    assert circle_meta["kind"] == "circle"
    assert circle_meta["source_scaled_probe"] is True
    assert len(rebuilt_circle.exterior.coords) == 97


@pytest.mark.parametrize(
    ("shape", "expected_kind", "expected_lines", "max_cubics"),
    [
        ("ellipse", "ellipse", 0, 96),
        ("rectangle", "rect", 3, 0),
        ("rounded_rectangle", "rounded_rect", 0, 68),
        ("triangle", "triangle", 2, 0),
        ("star_custom", None, 0, 24),
    ],
)
def test_noodle_da_hinh_jpeg_1600mm_chi_con_mot_cutcontour(
    tmp_path,
    shape,
    expected_kind,
    expected_lines,
    max_cubics,
):
    """§NOODLE.8–11: khóa điểm scale xấu nhất cho hình chuẩn và custom."""
    source = str(tmp_path / f"source_{shape}.pdf")
    output = str(tmp_path / f"cut_{shape}.pdf")
    _make_large_jpeg_shape_pdf(source, shape, 1600.0)

    success, meta = StickerEngine(dpi=300).process_pdf(
        input_path=source,
        output_path=output,
        cut_mode="original",
        offset_mm=0.0,
        corner_style="preserve",
        bleed_mm=0.0,
        fill_holes=True,
        remove_white_bg=True,
        bleed_color_type="image",
        draw_cut_contour=True,
        rectangle_mode=False,
        shape_mode="auto_safe",
        alpha_corner_policy="adaptive",
    )

    assert success is True
    assert meta["cut_kind"] == expected_kind
    assert len(meta["boxes"]) == 1
    with pikepdf.Pdf.open(output) as result:
        cut_stream = _read_all_content(result.pages[0]).split(
            b"/CutContour CS", 1
        )[1]
        assert cut_stream.count(b" m\n") == 1
        assert cut_stream.count(b" l\n") == expected_lines
        cubic_count = cut_stream.count(b" c\n")
        if max_cubics == 0:
            assert cubic_count == 0
        else:
            assert 1 <= cubic_count <= max_cubics


@pytest.mark.parametrize(
    ("shape", "fill_holes", "expected_kind", "expected_paths", "expected_lines"),
    [
        ("heart", True, None, 1, 0),
        ("flower_12", True, None, 1, 0),
        ("gear_20", True, None, 1, 0),
        ("hourglass_narrow_neck", True, None, 1, 0),
        ("donut_one_hole", False, None, 2, 0),
        ("letter_b_two_holes", False, None, 3, 0),
        # Mặc định vẫn lấp lỗ, không biến mọi mảng trắng nội bộ thành đường cắt.
        ("donut_one_hole", True, "circle", 1, 0),
    ],
)
def test_noodle_custom_topology_1600mm_khong_roi_ve_mi_tom(
    tmp_path,
    shape,
    fill_holes,
    expected_kind,
    expected_paths,
    expected_lines,
):
    """§NOODLE.12–15: hình tự do/lỗ phải giữ topology và không nổ node theo scale."""
    source = str(tmp_path / f"source_{shape}_{fill_holes}.pdf")
    output = str(tmp_path / f"cut_{shape}_{fill_holes}.pdf")
    _make_large_jpeg_shape_pdf(source, shape, 1600.0)

    success, meta = StickerEngine(dpi=300).process_pdf(
        input_path=source,
        output_path=output,
        cut_mode="original",
        offset_mm=0.0,
        corner_style="preserve",
        bleed_mm=0.0,
        fill_holes=fill_holes,
        remove_white_bg=True,
        bleed_color_type="image",
        draw_cut_contour=True,
        rectangle_mode=False,
        shape_mode="auto_safe",
        alpha_corner_policy="adaptive",
    )

    assert success is True
    assert meta["cut_kind"] == expected_kind
    with pikepdf.Pdf.open(output) as result:
        cut_stream = _read_all_content(result.pages[0]).split(
            b"/CutContour CS", 1
        )[1]
        path_count = cut_stream.count(b" m\n")
        line_count = cut_stream.count(b" l\n")
        cubic_count = cut_stream.count(b" c\n")
        assert path_count == expected_paths
        assert line_count == expected_lines
        assert 1 <= line_count + cubic_count <= 512
        machine_paths = _parse_cut_machine_paths(result.pages[0])

    if shape in {"heart", "flower_12", "gear_20", "hourglass_narrow_neck"}:
        machine = _summarize_machine_paths(machine_paths)
        assert machine["short"] == 0
        if shape == "flower_12":
            assert machine["sharp_joins"] == 0
        elif shape == "hourglass_narrow_neck":
            assert machine["sharp_joins"] == 10
            assert machine["curvature_flips"] == 0
        elif shape == "gear_20":
            assert machine["sharp_joins"] >= 80
        else:
            strong_cusps = _summarize_machine_paths(
                machine_paths,
                join_threshold_degrees=120.0,
            )
            assert strong_cusps["sharp_joins"] == 2


@pytest.mark.parametrize("shape", ["heart", "flower_12", "gear_20"])
def test_preserved_motion_policy_20mm_giu_cusp_va_bo_goc_gia(
    tmp_path,
    shape,
):
    """§MOTION.1–4: tem nhỏ phải chọn theo chuyển động, không theo ít node."""
    source = str(tmp_path / f"source_{shape}_20mm.pdf")
    output = str(tmp_path / f"cut_{shape}_20mm.pdf")
    _make_large_jpeg_shape_pdf(source, shape, 20.0)
    success, meta = StickerEngine(dpi=300).process_pdf(
        input_path=source,
        output_path=output,
        cut_mode="original",
        offset_mm=0.0,
        corner_style="preserve",
        bleed_mm=0.0,
        fill_holes=True,
        remove_white_bg=True,
        bleed_color_type="image",
        draw_cut_contour=True,
        rectangle_mode=False,
        shape_mode="contour",
        alpha_corner_policy="adaptive",
    )

    assert success is True
    assert meta["cut_kind"] is None
    with pikepdf.Pdf.open(output) as result:
        machine_paths = _parse_cut_machine_paths(result.pages[0])
    assert len(machine_paths) == 1
    assert all(segment.kind == "cubic" for segment in machine_paths[0])
    machine = _summarize_machine_paths(machine_paths)
    assert machine["short"] == 0
    if shape == "flower_12":
        assert machine["sharp_joins"] == 0
    elif shape == "gear_20":
        assert machine["sharp_joins"] >= 72
        assert machine["curvature_flips"] <= 12
    else:
        assert machine["sharp_joins"] == 2
        strong_cusps = _summarize_machine_paths(
            machine_paths,
            join_threshold_degrees=110.0,
        )
        assert strong_cusps["sharp_joins"] == 2


@pytest.mark.parametrize("shape_mode", ["contour", "auto_safe"])
def test_preserve_adaptive_policy_cho_ca_auto_va_force_contour(shape_mode):
    assert resolve_sticker_corner_policy(
        "original",
        False,
        False,
        shape_mode,
        "preserve",
    ) == "adaptive"


def test_preserve_policy_giu_legacy_cho_force_shape_va_selection():
    assert resolve_sticker_corner_policy(
        "original", False, False, "force_circle", "preserve"
    ) == "legacy"
    assert resolve_sticker_corner_policy(
        "original", False, True, "auto_safe", "preserve"
    ) == "legacy"


def test_preserve_adaptive_rejection_returns_exact_legacy_cut_path(
    src_pdf,
    tmp_path,
    monkeypatch,
):
    """Candidate bị guard loại phải rơi về đúng path preserve cũ."""
    from app.workers import sticker_engine as sticker_module

    legacy_path = str(tmp_path / "preserve_legacy.pdf")
    adaptive_path = str(tmp_path / "preserve_adaptive_fallback.pdf")
    common = {
        "input_path": src_pdf,
        "cut_mode": "original",
        "offset_mm": 0.0,
        "corner_style": "preserve",
        "bleed_mm": 0.0,
        "fill_holes": True,
        "remove_white_bg": True,
        "draw_cut_contour": True,
        "shape_mode": "contour",
    }
    success, _meta = StickerEngine(dpi=150).process_pdf(
        output_path=legacy_path,
        alpha_corner_policy="legacy",
        **common,
    )
    assert success is True

    monkeypatch.setattr(
        sticker_module,
        "_fit_preserved_contour_paths",
        lambda *_args, **_kwargs: None,
    )
    success, _meta = StickerEngine(dpi=150).process_pdf(
        output_path=adaptive_path,
        alpha_corner_policy="adaptive",
        **common,
    )
    assert success is True

    with pikepdf.Pdf.open(legacy_path) as legacy, pikepdf.Pdf.open(adaptive_path) as adaptive:
        legacy_cut = _read_all_content(legacy.pages[0]).split(b"/CutContour CS", 1)[1]
        adaptive_cut = _read_all_content(adaptive.pages[0]).split(b"/CutContour CS", 1)[1]
        assert adaptive_cut == legacy_cut


def test_existing_cut_contour_keeps_legacy_path(tmp_path, monkeypatch):
    """PDF đã có CutContour không được đi qua fitter raster thích ứng mới."""
    from app.workers import sticker_engine as sticker_module

    source = tmp_path / "existing_cut.pdf"
    output = tmp_path / "existing_cut_output.pdf"
    _make_simple_pdf(str(source))
    with pikepdf.Pdf.open(source, allow_overwriting_input=True) as document:
        page = document.pages[0]
        if "/Resources" not in page:
            page.Resources = pikepdf.Dictionary()
        if "/ColorSpace" not in page.Resources:
            page.Resources.ColorSpace = pikepdf.Dictionary()
        page.Resources.ColorSpace.CutContour = pikepdf.Name.DeviceCMYK
        document.save(source)

    def fail_if_called(*_args, **_kwargs):
        raise AssertionError("Không được fit lại PDF đã có CutContour")

    monkeypatch.setattr(
        sticker_module,
        "_fit_preserved_contour_paths",
        fail_if_called,
    )
    success, _meta = StickerEngine(dpi=150).process_pdf(
        input_path=str(source),
        output_path=str(output),
        cut_mode="original",
        corner_style="preserve",
        remove_white_bg=True,
        shape_mode="contour",
        alpha_corner_policy="adaptive",
    )

    assert success is True
    assert output.exists()


@pytest.mark.parametrize(
    "corner_style,offset_mm,bleed_mm,bleed_color_type",
    [
        ("round", 1.0, 0.0, "image"),
        ("miter", -0.5, 2.0, "image"),
        ("round", 0.0, 2.0, "inpaint"),
    ],
)
def test_process_pdf_modes_succeed(src_pdf, tmp_path, corner_style, offset_mm, bleed_mm, bleed_color_type):
    """Nhiều tổ hợp tham số đều phải xuất file hợp lệ, không crash."""
    out = str(tmp_path / "out.pdf")
    engine = StickerEngine(dpi=300)

    success, meta = engine.process_pdf(
        input_path=src_pdf, output_path=out,
        cut_mode="original", offset_mm=offset_mm, corner_style=corner_style,
        bleed_mm=bleed_mm, bleed_color_type=bleed_color_type,
    )

    assert success is True
    assert os.path.exists(out) and os.path.getsize(out) > 0
    with pikepdf.Pdf.open(out) as o:
        assert b"/CutContour CS" in _read_all_content(o.pages[0])



def test_rectangle_trajectory_mode_succeeds(src_pdf, tmp_path):
    """Mode quỹ đạo phải đi trọn luồng PDF và tạo được lớp bù xén hợp lệ."""
    out = str(tmp_path / "rectangle_trajectory.pdf")
    success, _meta = StickerEngine(dpi=150).process_pdf(
        input_path=src_pdf,
        output_path=out,
        cut_mode="none",
        bleed_mm=2.0,
        bleed_color_type="trajectory",
        draw_cut_contour=False,
        rectangle_mode=True,
    )

    assert success is True
    assert os.path.exists(out) and os.path.getsize(out) > 0
    with pikepdf.Pdf.open(out) as result:
        xobjects = result.pages[0].Resources.get("/XObject", {})
        assert any(
            str(xobjects[name].get("/Subtype")) == "/Image"
            and str(xobjects[name].get("/ColorSpace")) != "/DeviceGray"
            for name in xobjects
        )


def test_trajectory_auto_detects_rectangular_sticker_contour(
    src_pdf, tmp_path, monkeypatch
):
    """Bế tem nhãn chữ nhật phải gọi engine quỹ đạo dù rectangle_mode=False."""
    from app.workers import sticker_engine as sticker_module

    captured = []
    real_fill = sticker_module._rectangle_trajectory_color_fill

    def tracked_fill(img, pad_px, edge_bite_px, px_per_mm, pads=None):
        captured.append({"shape": img.shape[:2], "pads": pads})
        return real_fill(
            img,
            pad_px,
            edge_bite_px,
            px_per_mm,
            pads=pads,
        )

    monkeypatch.setattr(
        sticker_module,
        "_rectangle_trajectory_color_fill",
        tracked_fill,
    )
    out = str(tmp_path / "sticker_trajectory_rectangle.pdf")
    success, meta = StickerEngine(dpi=150).process_pdf(
        input_path=src_pdf,
        output_path=out,
        cut_mode="original",
        bleed_mm=2.0,
        bleed_color_type="trajectory",
        remove_white_bg=True,
        rectangle_mode=False,
    )

    assert success is True
    assert len(captured) == 1
    assert min(captured[0]["shape"]) > 0
    assert captured[0]["pads"] is not None
    assert all(value >= 0 for value in captured[0]["pads"])
    assert "contour hiện tại dùng" not in meta.get("warning", "")
    with pikepdf.Pdf.open(out) as result:
        page = result.pages[0]
        xobjects = page.obj.get("/Resources", {}).get("/XObject", {})
        subtypes = [str(xobjects[name].get("/Subtype")) for name in xobjects]
        assert "/Image" in subtypes
        assert "/Form" in subtypes
        assert b"/CutContour CS" in _read_all_content(page)


def test_trajectory_curved_sticker_uses_safe_edge_color_fallback(
    tmp_path, monkeypatch
):
    """Contour cong không được gọi nhầm engine bốn cạnh của tem chữ nhật."""
    from app.workers import sticker_engine as sticker_module

    src = str(tmp_path / "trajectory_round_source.pdf")
    out = str(tmp_path / "trajectory_round_output.pdf")
    _make_radial_halo_pdf(src)

    def reject_rectangle_fill(*_args, **_kwargs):
        raise AssertionError("Contour cong bị nhận nhầm là hình chữ nhật")

    monkeypatch.setattr(
        sticker_module,
        "_rectangle_trajectory_color_fill",
        reject_rectangle_fill,
    )
    success, meta = StickerEngine(dpi=150).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="original",
        bleed_mm=2.0,
        bleed_color_type="trajectory",
        remove_white_bg=True,
        rectangle_mode=False,
    )

    assert success is True
    assert os.path.exists(out) and os.path.getsize(out) > 0
    assert "contour hiện tại dùng Lấy màu viền tem" in meta.get("warning", "")


def test_trajectory_rectangle_detector_accepts_rounded_not_round_footprint():
    """Bộ nhận dạng chỉ nhận một footprint phủ gần kín bbox."""
    import cv2
    import numpy as np

    rectangle = np.zeros((80, 100), dtype=np.uint8)
    rectangle[12:68, 20:80] = 255
    assert _axis_aligned_rectangle_bbox(rectangle) == (20, 12, 80, 68)

    rounded = np.zeros((80, 100), dtype=np.uint8)
    cv2.rectangle(rounded, (30, 12), (69, 67), 255, cv2.FILLED)
    cv2.rectangle(rounded, (20, 22), (79, 57), 255, cv2.FILLED)
    for center in ((30, 22), (69, 22), (30, 57), (69, 57)):
        cv2.circle(rounded, center, 10, 255, cv2.FILLED)
    assert _axis_aligned_rectangle_bbox(rounded) == (20, 12, 80, 68)

    circle = np.zeros((80, 100), dtype=np.uint8)
    cv2.circle(circle, (50, 40), 25, 255, cv2.FILLED)
    assert _axis_aligned_rectangle_bbox(circle) is None

    rotated = np.zeros((80, 100), dtype=np.uint8)
    corners = cv2.boxPoints(((50, 40), (60, 35), 15)).astype(np.int32)
    cv2.fillPoly(rotated, [corners], 255)
    assert _axis_aligned_rectangle_bbox(rotated) is None


def test_trajectory_rounded_rectangle_fills_all_output_corners(
    tmp_path, monkeypatch
):
    """Trajectory phải phủ màu cả bốn góc bleed của tem chữ nhật bo góc."""
    import numpy as np
    import pypdfium2 as pdfium
    from app.workers import sticker_engine as sticker_module

    calls = []
    real_fill = sticker_module._rectangle_trajectory_color_fill

    def tracked_fill(*args, **kwargs):
        calls.append(args[0].shape[:2])
        return real_fill(*args, **kwargs)

    monkeypatch.setattr(
        sticker_module, "_rectangle_trajectory_color_fill", tracked_fill
    )

    src = str(tmp_path / "rounded_rectangle_source.pdf")
    out = str(tmp_path / "rounded_rectangle_trajectory.pdf")
    _make_rounded_rectangle_sticker_pdf(src)

    success, meta = StickerEngine(dpi=150).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="original",
        corner_style="preserve",
        bleed_mm=3.0,
        bleed_color_type="trajectory",
        remove_white_bg=True,
        rectangle_mode=False,
        draw_cut_contour=False,
    )
    assert success is True
    assert len(calls) == 1
    assert calls[0][0] >= 520
    assert calls[0][1] >= 360
    assert "contour hiện tại dùng" not in meta.get("warning", "")

    with pikepdf.Pdf.open(out) as result:
        result_page = result.pages[0]
        media = [float(value) for value in result_page.MediaBox]
        trim = [float(value) for value in result_page.TrimBox]

    document = pdfium.PdfDocument(out)
    page = bitmap = None
    try:
        page = document[0]
        bitmap = page.render(scale=300.0 / 72.0, rev_byteorder=True)
        pixels = bitmap.to_numpy()[:, :, :3].copy()
    finally:
        if bitmap is not None:
            bitmap.close()
        if page is not None:
            page.close()
        document.close()

    render_scale = 300.0 / 72.0
    left = int(round((trim[0] - media[0]) * render_scale))
    right = int(round((trim[2] - media[0]) * render_scale)) - 1
    top = int(round((media[3] - trim[3]) * render_scale))
    bottom = int(round((media[3] - trim[1]) * render_scale)) - 1
    inset = int(round(0.45 * 300.0 / 25.4))
    patch_size = 5

    def sample_patch(cx: int, cy: int) -> np.ndarray:
        half = patch_size // 2
        return pixels[
            max(0, cy - half):min(pixels.shape[0], cy + half + 1),
            max(0, cx - half):min(pixels.shape[1], cx + half + 1),
        ]

    trim_corner_patches = (
        sample_patch(left + inset, top + inset),
        sample_patch(right - inset, top + inset),
        sample_patch(left + inset, bottom - inset),
        sample_patch(right - inset, bottom - inset),
    )
    trim_white_fractions = [
        float(np.all(corner >= 245, axis=2).mean())
        for corner in trim_corner_patches
    ]
    assert max(trim_white_fractions) < 0.10, trim_white_fractions

    # Theo quỹ đạo của chữ nhật bo góc phải phủ kín cả ô bù xén, nhưng đường bế
    # vẫn lấy từ cut_poly bo góc và được kiểm riêng ở các test contour hiện có.
    media_corner_patches = (
        pixels[2:2 + patch_size, 2:2 + patch_size],
        pixels[2:2 + patch_size, -2 - patch_size:-2],
        pixels[-2 - patch_size:-2, 2:2 + patch_size],
        pixels[-2 - patch_size:-2, -2 - patch_size:-2],
    )
    media_white_fractions = [
        float(np.all(corner >= 245, axis=2).mean())
        for corner in media_corner_patches
    ]
    assert max(media_white_fractions) < 0.10, media_white_fractions


def test_alpha_cut_mode_uses_pdf_smask_and_keeps_white_outline(tmp_path):
    """PDF trung gian phải dùng Alpha PNG làm contour và lùi khoảng 0,15 mm."""
    import numpy as np
    import pypdfium2 as pdfium

    src = str(tmp_path / "alpha_white_outline.pdf")
    out = str(tmp_path / "alpha_white_outline_cut.pdf")
    _make_white_outline_pdf(src, transparent=True)

    with pikepdf.Pdf.open(src) as source:
        xobjects = source.pages[0].Resources.get("/XObject", {})
        assert any(xobjects[name].get("/SMask") is not None for name in xobjects)

    source_doc = pdfium.PdfDocument(src)
    source_bitmap = None
    try:
        source_bitmap = source_doc[0].render(
            scale=300.0 / 72.0,
            fill_color=(0, 0, 0, 0),
            rev_byteorder=True,
        )
        source_alpha = source_bitmap.to_numpy()[:, :, 3].copy()
    finally:
        if source_bitmap is not None:
            source_bitmap.close()
        source_doc.close()
    ys, xs = np.where(source_alpha > ALPHA_CONTOUR_THRESHOLD)
    assert xs.size > 0 and ys.size > 0
    alpha_width_mm = (int(xs.max()) - int(xs.min()) + 1) * 25.4 / 300.0
    alpha_height_mm = (int(ys.max()) - int(ys.min()) + 1) * 25.4 / 300.0

    success, meta = StickerEngine(dpi=300).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="alpha",
        offset_mm=0.0,
        corner_style="round",
        bleed_mm=0.0,
        fill_holes=True,
        remove_white_bg=False,
        draw_cut_contour=True,
        shape_mode="auto_safe",
    )

    assert success is True
    assert meta["contour_source"] == "alpha"
    assert meta["alpha_fallback"] is False
    box = meta["boxes"][0]
    inset_x_mm = (alpha_width_mm - box["w_mm"]) / 2.0
    inset_y_mm = (alpha_height_mm - box["h_mm"]) / 2.0
    assert inset_x_mm == pytest.approx(ALPHA_CONTOUR_INSET_MM, abs=0.03)
    assert inset_y_mm == pytest.approx(ALPHA_CONTOUR_INSET_MM, abs=0.03)
    assert box["w_pt"] < 120.0, "không được lấy nguyên trang 144 pt làm contour"
    with pikepdf.Pdf.open(out) as result:
        assert b"/CutContour CS" in _read_all_content(result.pages[0])


def test_alpha_cutline_filters_raster_steps_in_exported_pdf(tmp_path):
    """Circle 300 DPI không được xuất nguyên hàng trăm bậc pixel thành điểm dao."""
    src = str(tmp_path / "alpha_raster_circle.pdf")
    out = str(tmp_path / "alpha_raster_circle_cut.pdf")
    _make_page_touching_circle_pdf(src, transparent=True)

    success, _meta = StickerEngine(dpi=300).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="alpha",
        offset_mm=0.0,
        corner_style="round",
        bleed_mm=0.0,
        fill_holes=True,
        remove_white_bg=False,
        draw_cut_contour=True,
        shape_mode="contour",
    )

    assert success is True
    with pikepdf.Pdf.open(out) as result:
        cut_stream = _read_all_content(result.pages[0]).split(
            b"/CutContour CS", 1
        )[1]
        line_count = cut_stream.count(b" l\n")
        curve_count = cut_stream.count(b" c\n")
        assert line_count == 0
        assert 8 < curve_count < 100


def test_alpha_wavy_shell_pdf_has_no_artificial_joins_or_short_commands(tmp_path):
    """Regression đọc lại lệnh PDF thật của viền hữu cơ ở chế độ Ảnh AI."""
    src = str(tmp_path / "alpha_wavy_shell.pdf")
    out = str(tmp_path / "alpha_wavy_shell_cut.pdf")
    _make_wavy_shell_alpha_pdf(src)

    success, _meta = StickerEngine(dpi=300).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="alpha",
        offset_mm=0.0,
        corner_style="preserve",
        bleed_mm=0.0,
        fill_holes=True,
        remove_white_bg=False,
        draw_cut_contour=True,
        shape_mode="contour",
        alpha_corner_policy="adaptive",
        alpha_source_pixel_mm=25.4 / 300.0,
    )

    assert success is True
    with pikepdf.Pdf.open(out) as result:
        machine_paths = _parse_cut_machine_paths(result.pages[0])
    assert len(machine_paths) == 1
    assert all(segment.kind == "cubic" for segment in machine_paths[0])
    machine = _summarize_machine_paths(machine_paths)
    assert machine["short"] == 0
    assert machine["sharp_joins"] == 0


def test_alpha_72dpi_notched_pdf_stays_cubic_without_short_commands(tmp_path):
    """§AI-MOTION.4–10: 72 DPI phải là C2 thật, kể cả khi mask có râu cổ hẹp."""
    src = str(tmp_path / "alpha_72dpi_notched.pdf")
    out = str(tmp_path / "alpha_72dpi_notched_cut.pdf")
    _make_low_dpi_notched_alpha_pdf(src)

    success, _meta = StickerEngine(dpi=300).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="alpha",
        offset_mm=0.0,
        corner_style="preserve",
        bleed_mm=0.0,
        fill_holes=True,
        remove_white_bg=False,
        draw_cut_contour=True,
        shape_mode="contour",
        alpha_corner_policy="adaptive",
        alpha_source_pixel_mm=25.4 / 72.0,
    )

    assert success is True
    with pikepdf.Pdf.open(out) as result:
        machine_paths = _parse_cut_machine_paths(result.pages[0])
    assert len(machine_paths) == 1
    assert all(segment.kind == "cubic" for segment in machine_paths[0])
    machine = _summarize_machine_paths(machine_paths)
    assert machine["short"] == 0
    assert machine["sharp_joins"] == 0
    # Regression cũ chỉ kiểm join G1 nên Bézier tay nắm ngắn vẫn lọt dù nhìn như
    # đa giác. Đọc lại PDF thật và khóa cả độ nhảy độ cong sau lượng tử hóa.
    assert machine["p95_curvature_jump"] < 0.02
    assert machine["maximum_curvature_jump"] < 0.02


def test_alpha_cut_mode_keeps_rgb_order_for_image_bleed(tmp_path):
    """Render Alpha phải giữ đúng RGB khi lấy màu ảnh kéo ra vùng bù xén."""
    import numpy as np
    import pypdfium2 as pdfium

    src = str(tmp_path / "alpha_rgb_source.pdf")
    out = str(tmp_path / "alpha_rgb_bleed.pdf")
    _make_rounded_rectangle_sticker_pdf(src)

    success, _meta = StickerEngine(dpi=150).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="alpha",
        offset_mm=0.0,
        corner_style="round",
        bleed_mm=3.0,
        fill_holes=True,
        remove_white_bg=False,
        bleed_color_type="image",
        draw_cut_contour=True,
        shape_mode="auto_safe",
    )
    assert success is True

    document = pdfium.PdfDocument(out)
    bitmap = None
    try:
        bitmap = document[0].render(scale=150.0 / 72.0, rev_byteorder=True)
        pixels = bitmap.to_numpy()[:, :, :3].copy()
    finally:
        if bitmap is not None:
            bitmap.close()
        document.close()

    width = pixels.shape[1]
    top_bleed = pixels[3:10, width // 4:3 * width // 4]
    median_rgb = np.median(top_bleed, axis=(0, 1))
    assert float(median_rgb[0]) > float(median_rgb[2]) + 100.0, median_rgb.tolist()
    assert float(median_rgb[1]) > float(median_rgb[2]) + 100.0, median_rgb.tolist()


@pytest.mark.parametrize(
    "cut_mode,transparent,remove_white_bg",
    [
        ("alpha", True, False),
        ("original", False, True),
    ],
    ids=["alpha", "original-remove-white"],
)
def test_narrow_image_bleed_keeps_cardinal_points_closed(
    tmp_path, cut_mode, transparent, remove_white_bg
):
    """Bleed hẹp hơn close-mask 1,5 mm không được thủng ở bốn tiếp tuyến."""
    import numpy as np

    src = str(tmp_path / f"page_touching_circle_{cut_mode}_source.pdf")
    out = str(tmp_path / f"page_touching_circle_{cut_mode}_bleed.pdf")
    _make_page_touching_circle_pdf(src, transparent=transparent)

    dpi = 300
    bleed_mm = 1.0
    success, meta = StickerEngine(dpi=dpi).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode=cut_mode,
        offset_mm=0.0,
        corner_style="preserve",
        bleed_mm=bleed_mm,
        fill_holes=True,
        remove_white_bg=remove_white_bg,
        bleed_color_type="image",
        draw_cut_contour=False,
        rectangle_mode=False,
        shape_mode="contour",
    )
    assert success is True
    assert meta.get("warning") is None

    with pikepdf.Pdf.open(out) as result:
        xobjects = result.pages[0].Resources.get("/XObject", {})
        bleed_images = [
            xobjects[name]
            for name in xobjects
            if str(xobjects[name].get("/Subtype")) == "/Image"
            and xobjects[name].get("/SMask") is not None
        ]
        assert len(bleed_images) == 1
        bleed_image = bleed_images[0]
        width = int(bleed_image.get("/Width"))
        height = int(bleed_image.get("/Height"))
        bleed_rgb = np.frombuffer(
            bleed_image.read_bytes(), dtype=np.uint8
        ).reshape(height, width, 3)
        bleed_alpha = np.frombuffer(
            bleed_image.get("/SMask").read_bytes(), dtype=np.uint8
        ).reshape(height, width)

    center_y, center_x = height // 2, width // 2
    cardinal_rays = {
        "trên": (bleed_alpha[:center_y, center_x], bleed_rgb[:center_y, center_x]),
        "dưới": (bleed_alpha[center_y:, center_x], bleed_rgb[center_y:, center_x]),
        "trái": (bleed_alpha[center_y, :center_x], bleed_rgb[center_y, :center_x]),
        "phải": (bleed_alpha[center_y, center_x:], bleed_rgb[center_y, center_x:]),
    }
    minimum_opaque_pixels = int(np.ceil(bleed_mm * dpi / 25.4))
    gaps = {}
    wrong_colors = {}
    for direction, (alpha_ray, rgb_ray) in cardinal_rays.items():
        opaque = alpha_ray >= 128
        if np.count_nonzero(opaque) < minimum_opaque_pixels:
            gaps[direction] = alpha_ray.tolist()
            continue
        median_rgb = np.median(rgb_ray[opaque], axis=0).tolist()
        if not (median_rgb[0] < 80 and median_rgb[1] > 90 and median_rgb[2] > 170):
            wrong_colors[direction] = median_rgb
    assert not gaps, gaps
    assert not wrong_colors, wrong_colors


def test_alpha_cut_mode_falls_back_to_uniform_corner_background(tmp_path):
    """PNG đã phẳng nền tối vẫn được tách bằng nền nối từ bốn góc và có cảnh báo."""
    src = str(tmp_path / "opaque_white_outline.pdf")
    out = str(tmp_path / "opaque_white_outline_cut.pdf")
    _make_white_outline_pdf(src, transparent=False)

    success, meta = StickerEngine(dpi=150).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="alpha",
        offset_mm=0.0,
        corner_style="round",
        bleed_mm=0.0,
        fill_holes=True,
        remove_white_bg=False,
        draw_cut_contour=True,
        shape_mode="auto_safe",
    )

    assert success is True
    assert meta["contour_source"] == "alpha"
    assert meta["alpha_fallback"] is True
    assert "tách nền theo màu ở bốn góc" in meta.get("warning", "")
    box = meta["boxes"][0]
    expected_pt = (220.0 / 150.0) * 72.0 - (2 * 0.15 * 72.0 / 25.4)
    assert box["w_pt"] == pytest.approx(expected_pt, abs=1.4)
    assert box["h_pt"] == pytest.approx(expected_pt, abs=1.4)


@pytest.mark.parametrize("bleed_color_type", ["image", "inpaint", "trajectory", "solid"])
@pytest.mark.parametrize(
    "bleed_sides",
    [
        ["left", "right", "bottom", "top"],
        ["left"],
        ["right"],
        ["bottom"],
        ["top"],
    ],
    ids=["all", "left", "right", "bottom", "top"],
)
def test_rectangle_bleed_sides_keep_artwork_ink_to_page_edges(
    tmp_path, bleed_color_type, bleed_sides
):
    """CBS.1: cạnh tắt vẫn phải giữ artwork kín tới biên, không lộ giấy trắng."""
    import numpy as np
    import pypdfium2 as pdfium

    source = str(tmp_path / "rectangle_blue_source.pdf")
    output = str(tmp_path / f"rectangle_{bleed_color_type}_{bleed_sides[0]}.pdf")
    with pikepdf.Pdf.new() as pdf:
        page = pdf.add_blank_page(page_size=(120.0, 80.0))
        page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
            b"0 0 1 rg 0 0 120 80 re f\n"
        )
        pdf.save(source)

    success, _meta = StickerEngine(dpi=300).process_pdf(
        input_path=source,
        output_path=output,
        cut_mode="none",
        offset_mm=0.0,
        corner_style="miter",
        bleed_mm=5.0,
        fill_holes=True,
        remove_white_bg=False,
        bleed_color_type=bleed_color_type,
        solid_bleed_color=(255, 0, 0, 0),
        draw_cut_contour=False,
        rectangle_mode=True,
        shape_mode="force_rect",
        bleed_sides=bleed_sides,
    )
    assert success is True

    document = pdfium.PdfDocument(output)
    try:
        rendered = np.array(
            document[0].render(scale=600 / 72).to_pil().convert("RGB")
        )
    finally:
        document.close()

    # Soi hai pixel cuối ở giữa cạnh dưới. Trước fix, ba mode raster lộ
    # RGB(255,255,255), tương đương dải trắng 0,0847 mm ở 300 DPI.
    bottom_edge = rendered[-2:, rendered.shape[1] // 2]
    assert np.all(np.min(bottom_edge, axis=1) < 245), bottom_edge.tolist()


def test_sticker_output_page_fits_actual_bleed_without_white_safety_margin(src_pdf, tmp_path):
    """Bế tem phải xuất trang ôm mép bleed, không cộng canvas trắng 50pt/cạnh."""
    out = str(tmp_path / "sticker_tight_page.pdf")
    bleed_mm = 2.0

    success, _meta = StickerEngine(dpi=300).process_pdf(
        input_path=src_pdf,
        output_path=out,
        cut_mode="original",
        offset_mm=0.0,
        corner_style="miter",
        bleed_mm=bleed_mm,
        fill_holes=True,
        remove_white_bg=True,
        bleed_color_type="image",
        draw_cut_contour=True,
        rectangle_mode=False,
    )
    assert success is True

    with pikepdf.Pdf.open(out) as result:
        page = result.pages[0]
        media = [float(v) for v in page.MediaBox]
        crop = [float(v) for v in page.CropBox]
        trim = [float(v) for v in page.TrimBox]

        assert media == pytest.approx(crop, abs=0.01)
        media_w = media[2] - media[0]
        media_h = media[3] - media[1]
        trim_w = trim[2] - trim[0]
        trim_h = trim[3] - trim[1]
        # 2×bleed + 2×0.55pt guard cho stroke CutContour 1pt.
        expected_extra = 2 * bleed_mm * 72.0 / 25.4 + 1.10
        assert media_w - trim_w == pytest.approx(expected_extra, abs=0.6)
        assert media_h - trim_h == pytest.approx(expected_extra, abs=0.6)
        # Fixture có trang 297.6×419.5pt nhưng tem chỉ ở giữa: trang đầu ra phải
        # ôm tem, không giữ nguyên canvas nguồn hay cộng 100pt safety.
        assert media_w < 200
        assert media_h < 240

def test_process_pdf_none_mode_no_cutline(src_pdf, tmp_path):
    """cut_mode='none' + draw_cut_contour=False: chỉ tràn màu, KHÔNG vẽ đường cắt."""
    out = str(tmp_path / "out.pdf")
    engine = StickerEngine(dpi=300)

    success, meta = engine.process_pdf(
        input_path=src_pdf, output_path=out,
        cut_mode="none", offset_mm=0.0, bleed_mm=2.0,
        bleed_color_type="solid", solid_bleed_color=(255, 0, 0, 0),
        draw_cut_contour=False,
    )

    assert success is True
    assert os.path.exists(out) and os.path.getsize(out) > 0
    with pikepdf.Pdf.open(out) as o:
        assert b"/CutContour CS" not in _read_all_content(o.pages[0])


def test_process_pdf_bleed_preserves_vector_artwork(src_pdf, tmp_path):
    """Khi CÓ bleed, artwork gốc phải GIỮ NGUYÊN VECTOR (Form XObject),
    KHÔNG bị raster hoá thành ảnh JPEG.

    REGRESSION cho yêu cầu 'bảo toàn hình gốc, không tự chuyển thành ảnh'.
    Trước đây bleed_mm>0 khiến artwork bị render JPEG 300 DPI DeviceRGB (mất nét
    vector + lệch màu). Nay artwork luôn vẽ lại bằng form XObject (vector), chỉ
    vành bleed là ảnh.
    """
    out = str(tmp_path / "out_vec.pdf")
    engine = StickerEngine(dpi=300)

    success, _meta = engine.process_pdf(
        input_path=src_pdf, output_path=out,
        cut_mode="original", offset_mm=1.0, corner_style="round", bleed_mm=2.0,
        bleed_color_type="image",
    )

    assert success is True and os.path.exists(out)
    with pikepdf.Pdf.open(out) as o:
        page = o.pages[0]
        xobjs = page.obj.get("/Resources", {}).get("/XObject", {})
        subtypes = [str(xobjs[k].get("/Subtype")) for k in xobjs.keys()]
        # Phải có ÍT NHẤT 1 Form XObject = artwork gốc giữ vector.
        assert "/Form" in subtypes, (
            f"Artwork phải là Form XObject (vector), không raster hoá. Subtypes: {subtypes}"
        )
        # Vẫn có vẽ artwork lên trang (toán tử Do trong content).
        assert b" Do" in _read_all_content(page)


@pytest.mark.parametrize("bleed_color_type", ["image", "inpaint"])
def test_sampled_bleed_stays_lossless_icc_rgb(src_pdf, tmp_path, bleed_color_type):
    """Bleed lấy mẫu từ artwork phải giữ RGB, không giả lập CMYK với K=0.

    RGB đã là kết quả render màu của artwork. Đổi ngược bằng 255-R/G/B không thể
    phục hồi CMYK gốc và gây khác màu giữa bleed với viền tem trên RIP.
    """
    out = str(tmp_path / f"out_{bleed_color_type}.pdf")
    engine = StickerEngine(dpi=150)

    success, _meta = engine.process_pdf(
        input_path=src_pdf, output_path=out,
        cut_mode="original", offset_mm=0.0, bleed_mm=2.0,
        bleed_color_type=bleed_color_type,
    )

    assert success is True
    with pikepdf.Pdf.open(out) as o:
        xobjs = o.pages[0].obj.get("/Resources", {}).get("/XObject", {})
        images = [xobjs[k] for k in xobjs.keys() if str(xobjs[k].get("/Subtype")) == "/Image"]
        color_images = [img for img in images if str(img.get("/ColorSpace")) != "/DeviceGray"]
        assert color_images, "Phải có image XObject cho vành bù xén"
        for img in color_images:
            cs = img.get("/ColorSpace")
            assert isinstance(cs, pikepdf.Array)
            assert str(cs[0]) == "/ICCBased"
            profile = cs[1]
            assert int(profile.get("/N")) == 3
            assert len(profile.read_bytes()) > 0
            import io
            from PIL import ImageCms
            profile_name = ImageCms.getProfileName(
                ImageCms.getOpenProfile(io.BytesIO(profile.read_bytes()))
            ).lower()
            assert "srgb" in profile_name
            assert "adobe" not in profile_name
        assert all(str(img.get("/Filter")) == "/FlateDecode" for img in color_images)


def test_process_pdf_image_bleed_removes_radial_halo(tmp_path):
    """Quality oracle PDF→raster: bleed ngoài phải bám xanh, không còn nan cyan."""
    import numpy as np
    import pypdfium2 as pdfium

    source = str(tmp_path / "radial_halo.pdf")
    output = str(tmp_path / "radial_halo_bleed.pdf")
    _make_radial_halo_pdf(source)

    success, meta = StickerEngine(dpi=300).process_pdf(
        input_path=source,
        output_path=output,
        cut_mode="original",
        offset_mm=0.0,
        corner_style="round",
        bleed_mm=3.0,
        fill_holes=True,
        remove_white_bg=True,
        bleed_color_type="image",
        draw_cut_contour=False,
        rectangle_mode=False,
    )
    assert success is True
    assert meta.get("warning") is None

    document = pdfium.PdfDocument(output)
    try:
        rendered = np.array(
            document[0].render(scale=300 / 72).to_pil().convert("RGB")
        )
    finally:
        document.close()

    height, width = rendered.shape[:2]
    yy, xx = np.ogrid[:height, :width]
    radius = np.sqrt((xx - width / 2) ** 2 + (yy - height / 2) ** 2)
    outer_bleed = (radius > 92) & (radius < 108)
    blue = np.array([55, 126, 200], np.int16)
    pale_cyan = np.array([210, 245, 250], np.int16)
    colors = rendered[outer_bleed].astype(np.int16)
    blue_share = float(np.mean(np.max(np.abs(colors - blue), axis=1) < 12))
    pale_share = float(np.mean(np.max(np.abs(colors - pale_cyan), axis=1) < 12))
    assert blue_share > 0.95
    assert pale_share < 0.01

    # SMask phải có alpha trung gian ở mép trong; mask nhị phân 0/255 tạo bậc
    # thang nhìn thành răng cưa/sợi sáng khi viewer nội suy đường cong.
    with pikepdf.Pdf.open(output) as pdf:
        xobjects = pdf.pages[0].Resources.get("/XObject", {})
        soft_masks = [
            xobjects[name].get("/SMask")
            for name in xobjects.keys()
            if str(xobjects[name].get("/Subtype")) == "/Image"
            and xobjects[name].get("/SMask") is not None
        ]
        assert len(soft_masks) == 1
        alpha = np.frombuffer(soft_masks[0].read_bytes(), dtype=np.uint8)
        assert np.count_nonzero((alpha > 0) & (alpha < 255)) > 0


def test_feathered_bleed_join_mask_is_opaque_then_smooth():
    """Mép ngoài đục, chồng mí kín halo, rồi alpha giảm đều vào nền tem."""
    import cv2
    import numpy as np

    size = 180
    center = size // 2
    bleed = np.zeros((size, size), np.uint8)
    footprint = np.zeros((size, size), np.uint8)
    cv2.circle(bleed, (center, center), 70, 255, -1)
    cv2.circle(footprint, (center, center), 55, 255, -1)
    alpha = _build_feathered_bleed_join_mask(
        bleed,
        footprint,
        solid_overlap_px=4,
        feather_px=3,
    )

    assert alpha[center, center + 60] == 255
    assert alpha[center, center + 52] == 255
    assert 0 < alpha[center, center + 49] < 255
    assert alpha[center, center + 46] == 0
    assert np.count_nonzero((alpha > 0) & (alpha < 255)) > 0
    radial = alpha[center, center:center + 61].astype(np.int16)
    assert np.all(np.diff(radial) >= 0)


def test_nearest_color_fill_propagates_and_keeps_shape():
    """_nearest_color_fill: lấp màu từ vùng có màu ra nền, giữ đúng kích thước —
    cả đường thường (f=1) lẫn đường HẠ MẪU (f>1) cho ROI lớn."""
    import numpy as np
    from app.workers.sticker_engine import _nearest_color_fill, _downscale_factor

    # Nhỏ → f=1: góc nền phải lấy đúng màu ô vuông (nearest, không nội suy).
    src = np.zeros((100, 100), np.uint8); src[40:60, 40:60] = 255
    img = np.zeros((100, 100, 3), np.uint8); img[40:60, 40:60] = (10, 20, 30)
    assert _downscale_factor(100, 100) == 1
    out = _nearest_color_fill(src, img)
    assert out.shape == img.shape
    assert tuple(int(v) for v in out[0, 0]) == (10, 20, 30)

    # Lớn → f>1 (kích hoạt hạ mẫu): vẫn giữ shape & lấp màu (khác 0) ở nền.
    big_src = np.zeros((1400, 1400), np.uint8); big_src[600:800, 600:800] = 255
    big_img = np.zeros((1400, 1400, 3), np.uint8); big_img[600:800, 600:800] = (5, 60, 7)
    assert _downscale_factor(1400, 1400) > 1
    out2 = _nearest_color_fill(big_src, big_img)
    assert out2.shape == big_img.shape
    assert int(out2[0, 0].sum()) > 0


def test_compute_cut_bleed_offsets_no_double_bleed():
    """cut_mode=bleed: cut == outer == 1×bleed (không gấp đôi; cắt không nằm giữa vành)."""
    from app.workers.sticker_engine import compute_cut_bleed_offsets

    mm = 2.834645669  # ~1mm in pts
    bleed, offset = 3 * mm, 0.0

    # Theo mép tràn lề: cắt bao lề → cut = outer = 3mm, không 6mm.
    cut, outer = compute_cut_bleed_offsets("bleed", bleed, offset)
    assert abs(cut - bleed) < 1e-9
    assert abs(outer - bleed) < 1e-9
    assert abs(outer - cut) < 1e-9

    # Theo hình gốc: cắt tại 0, bù xén ra ngoài 3mm.
    cut_o, outer_o = compute_cut_bleed_offsets("original", bleed, offset)
    assert abs(cut_o - 0.0) < 1e-9
    assert abs(outer_o - bleed) < 1e-9

    # original + co/giãn: cut = offset, outer = offset + bleed.
    cut2, outer2 = compute_cut_bleed_offsets("original", bleed, -0.5 * mm)
    assert abs(cut2 - (-0.5 * mm)) < 1e-9
    assert abs(outer2 - (bleed - 0.5 * mm)) < 1e-9

    # bleed + offset dương: cả hai dịch cùng offset.
    cut3, outer3 = compute_cut_bleed_offsets("bleed", bleed, 1.0 * mm)
    assert abs(cut3 - (bleed + mm)) < 1e-9
    assert abs(outer3 - cut3) < 1e-9


def test_edge_color_source_uses_rim_not_core():
    """Nguồn màu viền phải là shell mép (đỏ), không hút ruột (xanh).

    REGRESSION: erode cả silhouette sâu hơn viền màu → nearest kéo màu lõi ra
    bleed (lệch 'màu viền tem').
    """
    import cv2
    import numpy as np
    from app.workers.sticker_engine import (
        _build_edge_color_source_mask,
        _nearest_color_fill,
    )

    h = w = 120
    mask = np.zeros((h, w), np.uint8)
    mask[20:100, 20:100] = 255
    img = np.zeros((h, w, 3), np.uint8)
    # Viền đỏ ~6px, ruột xanh.
    img[20:100, 20:100] = (220, 30, 30)
    img[26:94, 26:94] = (20, 40, 200)

    csm = _build_edge_color_source_mask(
        mask, img, band_px=3, peel_px=1, edge_bite_px=0, kernel_type=cv2.MORPH_RECT,
    )
    assert np.count_nonzero(csm) > 0
    rim = img[csm > 0]
    # Pixel nguồn: R cao, B thấp (đỏ viền, không xanh ruột).
    assert float(rim[:, 0].mean()) > 150
    assert float(rim[:, 2].mean()) < 80

    filled = _nearest_color_fill(csm, img)
    # Điểm ngoài tem, gần cạnh trái → phải nhận đỏ viền.
    sample = filled[50, 5]
    assert int(sample[0]) > 150 and int(sample[2]) < 80, f"bleed lấy sai màu: {sample}"


def test_edge_color_source_skips_near_white_aa():
    """Pixel AA gần trắng trên mép không được làm nguồn → tránh bleed nhạt."""
    import cv2
    import numpy as np
    from app.workers.sticker_engine import _build_edge_color_source_mask

    mask = np.zeros((80, 80), np.uint8)
    mask[20:60, 20:60] = 255
    img = np.zeros((80, 80, 3), np.uint8)
    img[20:60, 20:60] = (180, 40, 40)
    # 1px viền ngoài cùng = gần trắng (giả AA).
    img[20, 20:60] = (252, 250, 250)
    img[59, 20:60] = (252, 250, 250)
    img[20:60, 20] = (252, 250, 250)
    img[20:60, 59] = (252, 250, 250)

    csm = _build_edge_color_source_mask(
        mask, img, band_px=3, peel_px=0, edge_bite_px=0, kernel_type=cv2.MORPH_RECT,
    )
    assert np.count_nonzero(csm) > 0
    rim = img[csm > 0]
    assert float(rim.min(axis=1).mean()) < 240, "nguồn vẫn toàn pixel trắng/AA"
    assert float(rim[:, 0].mean()) > 100


def test_adaptive_edge_color_peels_sparse_bright_fringe():
    """Fringe xanh pha trắng thưa phải tự lùi thêm, không bị kéo thành nan bù xén."""
    import cv2
    import numpy as np
    from app.workers.sticker_engine import _build_edge_color_source_mask

    height = width = 240
    center_y = center_x = 120
    yy, xx = np.ogrid[:height, :width]
    radius = np.sqrt((xx - center_x) ** 2 + (yy - center_y) ** 2)
    angle = (
        np.degrees(np.arctan2(yy - center_y, xx - center_x)) + 360.0
    ) % 360.0
    silhouette = np.zeros((height, width), np.uint8)
    silhouette[radius <= 80] = 255
    blue = np.array([10, 124, 200], np.uint8)
    pale_blue = np.array([90, 165, 208], np.uint8)
    image = np.full((height, width, 3), 255, np.uint8)
    image[radius <= 80] = blue

    # Mô phỏng vài cụm AA bị pha nền trắng ở lớp pixel thứ hai. Chúng chỉ chiếm
    # khoảng 2% shell nên ngưỡng nhiễu cao tần cũ không kích hoạt dò sâu.
    sparse_arcs = (angle % 30.0) < 2.0
    fringe = (radius > 77.5) & (radius <= 79.5) & sparse_arcs
    image[fringe] = pale_blue

    initial = _build_edge_color_source_mask(
        silhouette,
        image,
        band_px=3,
        peel_px=1,
        kernel_type=cv2.MORPH_RECT,
    )
    initial_metrics = _edge_color_instability_metrics(initial, image)
    assert initial_metrics["transition_ratio"] < 0.05
    assert initial_metrics["luma_span"] < 30.0
    assert np.any(np.all(image[initial > 0] == pale_blue, axis=1))

    adaptive, selected_peel = _build_adaptive_edge_color_source_mask(
        silhouette,
        image,
        band_px=3,
        peel_px=1,
        max_peel_px=7,
        kernel_type=cv2.MORPH_RECT,
    )
    assert selected_peel == 4
    assert not np.any(np.all(image[adaptive > 0] == pale_blue, axis=1))

    # Một cung xanh nhạt có chủ đích kéo dài vào trong phải được giữ: shell sâu
    # không ổn định hơn shell nông nên adaptive không được tự ăn mất dải màu đó.
    intentional = np.full((height, width, 3), 255, np.uint8)
    intentional[radius <= 80] = blue
    intentional[(radius <= 80) & (angle < 8.0)] = pale_blue
    intentional_initial = _build_edge_color_source_mask(
        silhouette,
        intentional,
        band_px=3,
        peel_px=1,
        kernel_type=cv2.MORPH_RECT,
    )
    intentional_adaptive, intentional_peel = (
        _build_adaptive_edge_color_source_mask(
            silhouette,
            intentional,
            band_px=3,
            peel_px=1,
            max_peel_px=7,
            kernel_type=cv2.MORPH_RECT,
        )
    )
    assert intentional_peel == 1
    assert np.array_equal(intentional_adaptive, intentional_initial)
    assert np.any(
        np.all(intentional[intentional_adaptive > 0] == pale_blue, axis=1)
    )


def test_edge_color_warning_detects_radial_halo_but_keeps_long_color_segments():
    """Dò sâu qua halo nhưng giữ shell đầu tiên cho mảng màu dài có chủ đích."""
    import cv2
    import numpy as np
    from app.workers.sticker_engine import (
        _build_edge_color_source_mask,
        _nearest_color_fill,
    )

    height = width = 240
    center_y = center_x = 120
    yy, xx = np.ogrid[:height, :width]
    radius = np.sqrt((xx - center_x) ** 2 + (yy - center_y) ** 2)
    angle = (np.arctan2(yy - center_y, xx - center_x) + 2 * np.pi) % (2 * np.pi)
    silhouette = np.zeros((height, width), np.uint8)
    silhouette[radius <= 80] = 255
    blue = np.array([55, 126, 200], np.uint8)
    red = np.array([220, 30, 30], np.uint8)
    pale_cyan = np.array([210, 245, 250], np.uint8)

    halo = np.full((height, width, 3), 255, np.uint8)
    halo[radius <= 80] = blue
    fringe = (radius > 77) & (radius <= 80)
    alternating = ((angle * 24 / (2 * np.pi)).astype(int) % 2) == 0
    halo[fringe & alternating] = pale_cyan
    halo_source = _build_edge_color_source_mask(
        silhouette,
        halo,
        band_px=3,
        peel_px=1,
        kernel_type=cv2.MORPH_ELLIPSE,
    )
    halo_metrics = _edge_color_instability_metrics(halo_source, halo)
    assert halo_metrics["transition_ratio"] > 0.10
    assert halo_metrics["luma_span"] > 100
    assert _edge_color_sampling_warning(halo_source, halo, 1) is not None

    adaptive_source, selected_peel = _build_adaptive_edge_color_source_mask(
        silhouette,
        halo,
        band_px=3,
        peel_px=1,
        max_peel_px=7,
        kernel_type=cv2.MORPH_ELLIPSE,
    )
    assert selected_peel >= 4
    assert _edge_color_sampling_warning(adaptive_source, halo, 1) is None
    filled = _nearest_color_fill(adaptive_source, halo)
    outer_bleed = (radius > 84) & (radius <= 90)
    outer_colors = filled[outer_bleed].astype(np.int16)
    mean_error = float(np.abs(outer_colors - blue.astype(np.int16)).mean())
    pale_share = float(np.mean(np.all(outer_colors == pale_cyan, axis=1)))
    assert mean_error < 1.0
    assert pale_share < 0.01

    long_segments = np.full((height, width, 3), 255, np.uint8)
    long_segments[(radius <= 80) & (xx < center_x)] = red
    long_segments[(radius <= 80) & (xx >= center_x)] = blue
    segment_source = _build_edge_color_source_mask(
        silhouette,
        long_segments,
        band_px=3,
        peel_px=1,
        kernel_type=cv2.MORPH_ELLIPSE,
    )
    adaptive_segments, segment_peel = _build_adaptive_edge_color_source_mask(
        silhouette,
        long_segments,
        band_px=3,
        peel_px=1,
        max_peel_px=7,
        kernel_type=cv2.MORPH_ELLIPSE,
    )
    segment_metrics = _edge_color_instability_metrics(segment_source, long_segments)
    assert segment_metrics["transition_ratio"] < 0.01
    assert segment_peel == 1
    assert np.array_equal(adaptive_segments, segment_source)

    # Nếu nhiễu kéo dài xuyên vào ruột, không tự đoán màu: giữ cảnh báo fail-loud.
    noisy = np.full((height, width, 3), 255, np.uint8)
    checker = ((xx + yy) % 2) == 0
    noisy[(radius <= 80) & checker] = red
    noisy[(radius <= 80) & ~checker] = blue
    noisy_source, _ = _build_adaptive_edge_color_source_mask(
        silhouette,
        noisy,
        band_px=3,
        peel_px=1,
        max_peel_px=7,
        kernel_type=cv2.MORPH_ELLIPSE,
    )
    assert _edge_color_sampling_warning(noisy_source, noisy, 1) is not None


def test_sticker_warning_combines_bleed_quality_and_missing_dieline():
    quality_warning = "Trang 1: màu viền không ổn định."
    warning = _compose_sticker_warning(
        [{"bleed_warning": quality_warning}, {}, {"bleed_warning": quality_warning}],
        [4, 2],
    )
    assert warning == (
        quality_warning
        + " Một số trang không dò được hình để tạo đường cắt: 2, 4"
    )


def test_near_white_background_does_not_classify_light_neutral_gray_as_white():
    """Neutral gray artwork must survive background detection.

    The swatch reported by the audit is approximately RGB(213, 215, 214).
    Its OpenCV HSV saturation quantizes to 2, which used to fall exactly on
    the inclusive S<=2 background threshold.
    """
    import cv2
    import numpy as np
    from app.workers.sticker_engine import _near_white_background_candidate_rgb

    img = np.full((20, 20, 3), 255, dtype=np.uint8)
    img[5:15, 5:15] = (213, 215, 214)

    hsv = cv2.cvtColor(img, cv2.COLOR_RGB2HSV)
    legacy_near_white = cv2.inRange(
        hsv, np.array([0, 0, 200]), np.array([180, 2, 255])
    )
    strict_background = _near_white_background_candidate_rgb(img)

    assert bool(legacy_near_white[10, 10]) is True
    assert bool(strict_background[10, 10]) is False
    assert bool(strict_background[0, 0]) is True


def test_process_pdf_keeps_neutral_cmyk_gray_artwork(tmp_path):
    """A light neutral CMYK object must still produce a non-empty cutline."""
    src = str(tmp_path / "neutral_gray.pdf")
    out = str(tmp_path / "neutral_gray_out.pdf")

    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(100, 60))
    page.Contents = pdf.make_stream(
        b"1 1 1 rg 0 0 100 60 re f\n"
        b"0.1569 0.1059 0.1216 0 k 20 15 60 30 re f\n"
    )
    pdf.save(src)

    success, _meta = StickerEngine(dpi=150).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="original",
        offset_mm=0.0,
        corner_style="miter",
        bleed_mm=0.0,
        fill_holes=True,
        remove_white_bg=True,
        draw_cut_contour=True,
        shape_mode="contour",
    )
    assert success is True

    with pikepdf.Pdf.open(out) as result:
        trim = [float(v) for v in result.pages[0].TrimBox]
        assert trim[2] - trim[0] > 40.0
        assert trim[3] - trim[1] > 15.0
        assert b"/CutContour CS" in _read_all_content(result.pages[0])


def _make_rectangle_white_edge_pdf(path: str, *, output_intent: bool = False):
    """Vector page with legitimate white trim edges and green artwork inside."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(100, 60))
    page.Contents = pdf.make_stream(
        b"1 1 1 rg 0 0 100 60 re f\n"
        b"0 0.6 0 rg 12 10 76 40 re f\n"
    )
    profile_bytes = None
    if output_intent:
        profile_path = os.path.join(
            os.path.dirname(__file__), "..", "app", "assets", "icc", "FOGRA39.icc"
        )
        with open(profile_path, "rb") as fh:
            profile_bytes = fh.read()
        profile = pdf.make_stream(profile_bytes)
        profile[pikepdf.Name("/N")] = 4
        intent = pdf.make_indirect(pikepdf.Dictionary({
            "/Type": pikepdf.Name("/OutputIntent"),
            "/S": pikepdf.Name("/GTS_PDFX"),
            "/OutputConditionIdentifier": "FOGRA39",
            "/DestOutputProfile": profile,
        }))
        pdf.Root[pikepdf.Name("/OutputIntents")] = pikepdf.Array([intent])
    pdf.save(path)
    return profile_bytes


def test_rectangle_image_bleed_preserves_true_white_edge_and_stays_vector(tmp_path):
    """Rectangle edge stretch must not discard legitimate white page-edge pixels."""
    import numpy as np
    import pypdfium2 as pdfium

    src = str(tmp_path / "rect_white.pdf")
    out = str(tmp_path / "rect_white_bleed.pdf")
    _make_rectangle_white_edge_pdf(src)

    success, _meta = StickerEngine(dpi=300).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="none",
        bleed_mm=3.0,
        bleed_color_type="image",
        draw_cut_contour=False,
        rectangle_mode=True,
        edge_bite_mm=0.0,
    )
    assert success is True

    with pikepdf.Pdf.open(out) as pdf:
        page = pdf.pages[0]
        xobjects = page.Resources.get("/XObject", {})
        assert xobjects
        assert all(str(xobjects[name].get("/Subtype")) == "/Form" for name in xobjects)
        assert _read_all_content(page).count(b" Do") >= 9  # 8 edge/corner strips + artwork

    rendered = pdfium.PdfDocument(out)
    pixels = rendered[0].render(scale=4, rev_byteorder=True).to_numpy()
    mid_y, mid_x = pixels.shape[0] // 2, pixels.shape[1] // 2
    # Far inside the left bleed: exact source edge is white, not green from the core.
    assert np.all(pixels[mid_y, 5, :3] >= 250), pixels[mid_y, 5, :3]
    # Original center artwork remains green and vector-sharp.
    center = pixels[mid_y, mid_x, :3]
    assert int(center[1]) > 120 and int(center[0]) < 20 and int(center[2]) < 20


@pytest.mark.parametrize("edge_bite_mm", [0.0, 0.6, 2.0])
def test_rectangle_edge_bite_never_changes_finished_size(tmp_path, edge_bite_mm):
    """Edge inset may replace only the configured inner strip; it must never crop the page."""
    pt_per_mm = 72.0 / 25.4
    src = str(tmp_path / f"card_{edge_bite_mm}.pdf")
    out = str(tmp_path / f"card_bleed_{edge_bite_mm}.pdf")

    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(89.0 * pt_per_mm, 51.0 * pt_per_mm))
    page.Contents = pdf.make_stream(
        b"1 1 1 rg 0 0 252.283 144.567 re f\n"
        b"0 0.6 0 rg 126.142 0 126.142 144.567 re f\n"
    )
    pdf.save(src)

    success, _meta = StickerEngine(dpi=300).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="none",
        bleed_mm=2.0,
        bleed_color_type="image",
        draw_cut_contour=False,
        rectangle_mode=True,
        edge_bite_mm=edge_bite_mm,
    )
    assert success is True

    with pikepdf.Pdf.open(out) as result:
        media = [float(v) for v in result.pages[0].MediaBox]
        width_mm = (media[2] - media[0]) / pt_per_mm
        height_mm = (media[3] - media[1]) / pt_per_mm
        assert width_mm == pytest.approx(93.0, abs=0.02)
        assert height_mm == pytest.approx(55.0, abs=0.02)

@pytest.mark.parametrize("bleed_color_type", ["image", "inpaint"])
def test_rectangle_sample_inset_keeps_edge_artwork(
    tmp_path, bleed_color_type, monkeypatch
):
    """Lấy màu sâu 0,5 mm phải né dải mép nhưng không được xóa dải đó."""
    import numpy as np
    import pypdfium2 as pdfium
    from app.workers import sticker_engine as sticker_module

    dilate_kernel_sizes = []
    real_dilate = sticker_module.cv2.dilate

    def tracked_dilate(src, kernel, *args, **kwargs):
        dilate_kernel_sizes.append(kernel.shape)
        return real_dilate(src, kernel, *args, **kwargs)

    monkeypatch.setattr(sticker_module.cv2, "dilate", tracked_dilate)

    pt_per_mm = 72.0 / 25.4
    src = str(tmp_path / f"sample_inset_{bleed_color_type}.pdf")
    out = str(tmp_path / f"sample_inset_{bleed_color_type}_bleed.pdf")

    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(20.0 * pt_per_mm, 20.0 * pt_per_mm))
    page.Contents = pdf.make_stream(
        b"1 0 0 rg 0 0 56.693 56.693 re f\n"
        b"0 0 0 rg 0 0 0.709 56.693 re f\n"
    )
    pdf.save(src)

    success, _meta = StickerEngine(dpi=300).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="none",
        bleed_mm=2.0,
        bleed_color_type=bleed_color_type,
        draw_cut_contour=False,
        rectangle_mode=True,
        edge_bite_mm=0.0,
        edge_sample_inset_mm=0.5,
    )
    assert success is True

    rendered = pdfium.PdfDocument(out)
    pixels = rendered[0].render(scale=8, rev_byteorder=True).to_numpy()
    px_per_mm = 8.0 * pt_per_mm
    mid_y = pixels.shape[0] // 2
    bleed_rgb = pixels[mid_y, int(1.0 * px_per_mm), :3]
    artwork_rgb = pixels[mid_y, int(2.1 * px_per_mm), :3]

    # Bleed lấy màu đỏ ở sâu 0,5 mm, không kéo dải đen sát mép ra ngoài.
    assert int(bleed_rgb[0]) > 180
    assert int(bleed_rgb[1]) < 80 and int(bleed_rgb[2]) < 80
    # Dải đen 0,25 mm trong artwork gốc vẫn còn nguyên tại mép thành phẩm.
    assert np.all(artwork_rgb < 80), artwork_rgb
    if bleed_color_type == "inpaint":
        # Rectangle đã biết hình học; kernel lớn theo bleed là phép tính thừa O(r²).
        assert not [shape for shape in dilate_kernel_sizes if max(shape) > 3]

def test_rectangle_source_mask_can_preserve_legitimate_white():
    """White suppression is sticker-only; rectangle raster modes keep true white."""
    import cv2
    import numpy as np
    from app.workers.sticker_engine import _build_edge_color_source_mask

    mask = np.zeros((40, 40), np.uint8)
    mask[5:35, 5:35] = 255
    img = np.full((40, 40, 3), 255, np.uint8)
    img[5:8, 10:15] = (20, 150, 30)  # ensure white-filtered shell is not empty

    keep_white = _build_edge_color_source_mask(
        mask, img, band_px=3, peel_px=0, kernel_type=cv2.MORPH_RECT,
        exclude_near_white=False,
    )
    strip_white = _build_edge_color_source_mask(
        mask, img, band_px=3, peel_px=0, kernel_type=cv2.MORPH_RECT,
        exclude_near_white=True,
    )
    assert keep_white[5, 20] > 0
    assert strip_white[5, 20] == 0


def test_rectangle_vector_bleed_preserves_output_intent(tmp_path):
    """Rebuilding the PDF must retain the source printing/output ICC profile."""
    src = str(tmp_path / "rect_output_intent.pdf")
    out = str(tmp_path / "rect_output_intent_bleed.pdf")
    expected_profile = _make_rectangle_white_edge_pdf(src, output_intent=True)

    success, _meta = StickerEngine(dpi=150).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="none",
        bleed_mm=2.0,
        bleed_color_type="image",
        draw_cut_contour=False,
        rectangle_mode=True,
        edge_bite_mm=0.0,
    )
    assert success is True

    with pikepdf.Pdf.open(out) as pdf:
        intents = pdf.Root.get("/OutputIntents")
        assert intents and len(intents) == 1
        assert str(intents[0].get("/OutputConditionIdentifier")) == "FOGRA39"
        assert intents[0].get("/DestOutputProfile").read_bytes() == expected_profile


def test_rectangle_vector_bleed_keeps_spot_colorspace(tmp_path):
    """Vector edge strips must retain Separation/spot resources without RGB flattening."""
    src = str(tmp_path / "rect_spot.pdf")
    out = str(tmp_path / "rect_spot_bleed.pdf")

    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(100, 60))
    tint = pdf.make_indirect(pikepdf.Dictionary({
        "/FunctionType": 2,
        "/Domain": [0.0, 1.0],
        "/C0": [0.0, 0.0, 0.0, 0.0],
        "/C1": [0.8, 0.0, 0.9, 0.1],
        "/N": 1.0,
    }))
    spot = pikepdf.Array([
        pikepdf.Name("/Separation"),
        pikepdf.Name("/BrandGreen"),
        pikepdf.Name("/DeviceCMYK"),
        tint,
    ])
    page.Resources = pikepdf.Dictionary({
        "/ColorSpace": pikepdf.Dictionary({"/SpotEdge": spot}),
    })
    page.Contents = pdf.make_stream(b"/SpotEdge cs 1 scn 0 0 100 60 re f\n")
    pdf.save(src)

    success, _meta = StickerEngine(dpi=150).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="none",
        bleed_mm=2.0,
        bleed_color_type="image",
        draw_cut_contour=False,
        rectangle_mode=True,
        edge_bite_mm=0.0,
    )
    assert success is True

    with pikepdf.Pdf.open(out) as result:
        xobjects = result.pages[0].Resources.get("/XObject", {})
        forms = [xobjects[name] for name in xobjects if str(xobjects[name].get("/Subtype")) == "/Form"]
        assert len(forms) == 1
        source_form = forms[0]
        spot_out = source_form.Resources.get("/ColorSpace").get("/SpotEdge")
        assert str(spot_out[0]) == "/Separation"
        assert str(spot_out[1]) == "/BrandGreen"
        assert str(spot_out[2]) == "/DeviceCMYK"
        assert b"/SpotEdge cs 1 scn" in source_form.read_bytes()


def test_rectangle_smooth_fill_is_bounded_and_preserves_page_size():
    """Smart smoothing must not invent saturated colors outside the source gamut."""
    import numpy as np
    from app.workers.sticker_engine import _rectangle_smooth_color_fill

    img = np.full((24, 40, 3), 255, dtype=np.uint8)
    img[4:20, 6:34] = (82, 169, 51)
    img[:, -4:] = (44, 132, 16)
    pad = 7
    out = _rectangle_smooth_color_fill(
        img, pad_px=pad, edge_bite_px=2, px_per_mm=12.0
    )

    assert out.shape == (img.shape[0] + 2 * pad, img.shape[1] + 2 * pad, 3)
    src_min = img.reshape(-1, 3).min(axis=0)
    src_max = img.reshape(-1, 3).max(axis=0)
    assert np.all(out.reshape(-1, 3).min(axis=0) >= src_min)
    assert np.all(out.reshape(-1, 3).max(axis=0) <= src_max)
    # A real white trim edge remains white instead of being replaced by core color.
    assert np.all(out[out.shape[0] // 2, 0] == 255)


def test_rectangle_smooth_optimization_is_pixel_identical_to_legacy():
    """Golden output from the former per-column cv2.remap implementation."""
    import numpy as np
    from app.workers.sticker_engine import _rectangle_smooth_color_fill

    rng = np.random.default_rng(20260721)
    image = rng.integers(0, 256, size=(121, 183, 3), dtype=np.uint8)
    output = _rectangle_smooth_color_fill(
        image, pad_px=31, edge_bite_px=2, px_per_mm=12.0
    )

    assert hashlib.sha256(output.tobytes()).hexdigest() == (
        "36dc38a6c14b2fbc00320645dd4e277b667dee37d4748255e7e2a8555df7f4bf"
    )


def test_sparse_rectangle_bleed_preserves_visible_pixels_and_safety_halo():
    import numpy as np
    from app.workers.sticker_engine import _sparsify_rectangle_bleed

    rng = np.random.default_rng(17)
    height, width, edge = 120, 180, 14
    colors = rng.integers(1, 256, size=(height, width, 3), dtype=np.uint8)
    mask = np.full((height, width), 255, dtype=np.uint8)
    mask[edge:height - edge, edge:width - edge] = 0

    sparse = _sparsify_rectangle_bleed(colors, mask, edge)
    assert np.array_equal(sparse[mask > 0], colors[mask > 0])
    assert np.array_equal(sparse[:edge], colors[:edge])
    assert np.array_equal(sparse[-edge:], colors[-edge:])
    assert np.array_equal(sparse[:, :edge], colors[:, :edge])
    assert np.array_equal(sparse[:, -edge:], colors[:, -edge:])
    assert np.count_nonzero(sparse[edge:height - edge, edge:width - edge]) == 0

    unsafe_mask = mask.copy()
    unsafe_mask[height // 2, width // 2] = 255
    fallback = _sparsify_rectangle_bleed(colors, unsafe_mask, edge)
    assert fallback is colors


def test_image_dedup_rewires_resources_without_render_change(tmp_path):
    import zlib

    import numpy as np
    import pypdfium2 as pdfium
    from app.workers.sticker_engine import _deduplicate_image_xobjects

    before = tmp_path / "duplicate_images.pdf"
    after = tmp_path / "deduplicated_images.pdf"
    width, height = 300, 200
    pixels = np.random.default_rng(42).integers(
        0, 256, size=(height, width, 4), dtype=np.uint8
    ).tobytes()
    alpha = bytes([255]) * (width * height)

    pdf = pikepdf.Pdf.new()
    for _ in range(2):
        page = pdf.add_blank_page(page_size=(300, 200))
        smask = pikepdf.Stream(pdf, zlib.compress(alpha, 1))
        smask.Type = pikepdf.Name.XObject
        smask.Subtype = pikepdf.Name.Image
        smask.Width = width
        smask.Height = height
        smask.ColorSpace = pikepdf.Name.DeviceGray
        smask.BitsPerComponent = 8
        smask.Filter = pikepdf.Name.FlateDecode

        image = pikepdf.Stream(pdf, zlib.compress(pixels, 1))
        image.Type = pikepdf.Name.XObject
        image.Subtype = pikepdf.Name.Image
        image.Width = width
        image.Height = height
        image.ColorSpace = pikepdf.Name.DeviceCMYK
        image.BitsPerComponent = 8
        image.Filter = pikepdf.Name.FlateDecode
        image.SMask = smask
        name = page.add_resource(image, pikepdf.Name.XObject)
        page.Contents = pdf.make_stream(
            f"q 300 0 0 200 0 0 cm {name} Do Q".encode("ascii")
        )
    pdf.save(before)
    pdf.close()

    with pikepdf.Pdf.open(before) as result:
        stats = _deduplicate_image_xobjects(result)
        assert stats["duplicates"] == 2
        assert stats["rewired"] >= 2
        result.save(after)

    assert after.stat().st_size < before.stat().st_size * 0.60
    with pikepdf.Pdf.open(after) as result:
        image_refs = [
            next(
                page.Resources.XObject[name]
                for name in page.Resources.XObject
            ).objgen
            for page in result.pages
        ]
        assert image_refs[0] == image_refs[1]

    rendered_before = pdfium.PdfDocument(str(before))
    rendered_after = pdfium.PdfDocument(str(after))
    for page_index in range(2):
        pixels_before = rendered_before[page_index].render(
            scale=1, rev_byteorder=True
        ).to_numpy()
        pixels_after = rendered_after[page_index].render(
            scale=1, rev_byteorder=True
        ).to_numpy()
        assert np.array_equal(pixels_before, pixels_after)

def test_sticker_endpoint_uses_local_pdf_without_deleting_source(tmp_path, monkeypatch):
    import asyncio
    import shutil

    from app.api.routes import pdf_tools
    from app.workers import sticker_engine

    source = tmp_path / "source.pdf"
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(300, 200))
    pdf.save(source)
    pdf.close()
    captured = {}

    class StubEngine:
        def __init__(self, dpi=300):
            self.dpi = dpi

        def process_pdf(self, input_path, output_path, **kwargs):
            captured.update(kwargs)
            shutil.copyfile(input_path, output_path)
            return True, {
                "pages": [{"page": 1}],
                "warning": "Màu viền lấy mẫu không ổn định.",
            }

    class FakeRequest:
        async def form(self):
            return {
                "file_path": str(source),
                "rectangle_mode": "true",
                "bleed_color_type": "inpaint",
                "edge_sample_inset_mm": "0.5",
            }

    monkeypatch.setattr(sticker_engine, "StickerEngine", StubEngine)
    monkeypatch.setattr(pdf_tools, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(pdf_tools, "_safe_watermark", lambda *args: None)

    response = asyncio.run(
        pdf_tools.sticker_dieline_endpoint(FakeRequest(), license_info={})
    )

    assert source.exists()
    assert response.headers["X-Sticker-Output-Path"].lower().endswith(".pdf")
    assert response.headers["X-Sticker-Warning"] == (
        "M%C3%A0u%20vi%E1%BB%81n%20l%E1%BA%A5y%20m%E1%BA%ABu%20kh%C3%B4ng%20%E1%BB%95n%20%C4%91%E1%BB%8Bnh."
    )
    assert os.path.exists(response.path)
    assert captured["edge_sample_inset_mm"] == pytest.approx(0.5)


@pytest.mark.parametrize(
    "extra_form,expected_policy",
    [
        ({
            "cut_mode": "original",
            "corner_style": "preserve",
            "shape_mode": "contour",
        }, "adaptive"),
        ({
            "cut_mode": "original",
            "corner_style": "round",
            "shape_mode": "auto_safe",
        }, "legacy"),
        ({
            "cut_mode": "none",
            "corner_style": "miter",
            "shape_mode": "contour",
            "rectangle_mode": "true",
        }, "legacy"),
        ({
            "cut_mode": "original",
            "corner_style": "preserve",
            "shape_mode": "contour",
            "selection_json": '{"pages":[{"page":0,"object_ids":["image-0"]}]}',
        }, "legacy"),
    ],
)
def test_sticker_endpoint_enables_adaptive_only_for_preserved_contour(
    tmp_path,
    monkeypatch,
    extra_form,
    expected_policy,
):
    import asyncio
    import shutil

    from app.api.routes import pdf_tools
    from app.workers import sticker_engine, sticker_page_canvas

    source = tmp_path / "adaptive_route.pdf"
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(300, 200))
    pdf.save(source)
    pdf.close()
    captured = {}

    class StubEngine:
        def __init__(self, dpi=300):
            self.dpi = dpi

        def process_pdf(self, input_path, output_path, **kwargs):
            captured.update(kwargs)
            shutil.copyfile(input_path, output_path)
            return True, {"pages": [{"page": 1}]}

    class FakeRequest:
        async def form(self):
            return {"file_path": str(source), **extra_form}

    monkeypatch.setattr(sticker_engine, "StickerEngine", StubEngine)
    monkeypatch.setattr(
        sticker_page_canvas,
        "restore_sticker_page_canvas",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(pdf_tools, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(pdf_tools, "_safe_watermark", lambda *args: None)

    response = asyncio.run(
        pdf_tools.sticker_dieline_endpoint(FakeRequest(), license_info={})
    )

    assert os.path.exists(response.path)
    assert captured["alpha_corner_policy"] == expected_policy


@pytest.mark.parametrize("crop_to_sticker", [None, False, True])
def test_sticker_endpoint_alpha_respects_crop_to_sticker_contract(
    tmp_path, monkeypatch, crop_to_sticker
):
    """Bật crop giữ canvas tight; tắt crop khôi phục khổ nguồn đúng offset Alpha."""
    import asyncio
    import shutil

    from app.api.routes import pdf_tools
    from app.workers import sticker_engine, sticker_page_canvas

    source = tmp_path / "alpha_route_source.pdf"
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(300, 200))
    pdf.save(source)
    pdf.close()
    captured = {}

    class StubEngine:
        def __init__(self, dpi=300):
            self.dpi = dpi

        def process_pdf(self, input_path, output_path, **kwargs):
            captured["engine"] = kwargs
            shutil.copyfile(input_path, output_path)
            return True, {"pages": [{"page": 1}]}

    def fake_restore(_source_path, _output_path, *, expansion_pts):
        captured["expansion_pts"] = expansion_pts

    class FakeRequest:
        async def form(self):
            payload = {
                "file_path": str(source),
                "cut_mode": "alpha",
                "offset_mm": "0",
                "bleed_mm": "2",
                "rectangle_mode": "false",
            }
            if crop_to_sticker is not None:
                payload["crop_to_sticker"] = str(crop_to_sticker).lower()
            return payload

    monkeypatch.setattr(sticker_engine, "StickerEngine", StubEngine)
    monkeypatch.setattr(
        sticker_page_canvas,
        "restore_sticker_page_canvas",
        fake_restore,
    )
    monkeypatch.setattr(pdf_tools, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(pdf_tools, "_safe_watermark", lambda *args: None)

    response = asyncio.run(
        pdf_tools.sticker_dieline_endpoint(FakeRequest(), license_info={})
    )

    assert os.path.exists(response.path)
    assert captured["engine"]["cut_mode"] == "alpha"
    if crop_to_sticker:
        assert "expansion_pts" not in captured
    else:
        expected_expansion = (2.0 - 0.15) * 2.83465
        assert captured["expansion_pts"] == pytest.approx(
            expected_expansion,
            abs=1e-6,
        )

def test_rectangle_smooth_fill_continues_diagonal_color_trajectory():
    """Smart smoothing should follow an oblique band better than edge extrusion."""
    import cv2
    import numpy as np
    from app.workers.sticker_engine import _rectangle_smooth_color_fill

    h, w, pad = 120, 180, 30
    yy, xx = np.mgrid[-pad:h + pad, -pad:w + pad]
    phase = (xx + 0.65 * yy) / 18.0
    ideal = np.stack([
        128 + 100 * np.sin(phase),
        128 + 95 * np.sin(phase + 2.1),
        128 + 90 * np.sin(phase + 4.2),
    ], axis=2).clip(0, 255).astype(np.uint8)
    core = ideal[pad:pad + h, pad:pad + w]

    smart = _rectangle_smooth_color_fill(core, pad, 0, 12.0)
    stretched = cv2.copyMakeBorder(core, pad, pad, pad, pad, cv2.BORDER_REPLICATE)
    ring = np.ones(ideal.shape[:2], dtype=bool)
    ring[pad:pad + h, pad:pad + w] = False
    smart_error = np.abs(smart.astype(np.int16) - ideal.astype(np.int16))[ring].mean()
    stretch_error = np.abs(stretched.astype(np.int16) - ideal.astype(np.int16))[ring].mean()
    assert smart_error < stretch_error * 0.60, (smart_error, stretch_error)


def test_rectangle_inpaint_uses_true_srgb_and_keeps_white_edge(tmp_path):
    """Rectangle smart smoothing should render predictably without Adobe-RGB cast."""
    import io
    import numpy as np
    import pypdfium2 as pdfium
    from PIL import ImageCms

    src = str(tmp_path / "rect_smooth.pdf")
    out = str(tmp_path / "rect_smooth_bleed.pdf")
    _make_rectangle_white_edge_pdf(src)

    success, _meta = StickerEngine(dpi=300).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="none",
        bleed_mm=3.0,
        bleed_color_type="inpaint",
        draw_cut_contour=False,
        rectangle_mode=True,
        edge_bite_mm=0.0,
    )
    assert success is True

    with pikepdf.Pdf.open(out) as result:
        xobjects = result.pages[0].Resources.get("/XObject", {})
        color_images = [
            xobjects[name]
            for name in xobjects
            if str(xobjects[name].get("/Subtype")) == "/Image"
            and str(xobjects[name].get("/ColorSpace")) != "/DeviceGray"
        ]
        assert len(color_images) == 1
        color_image = color_images[0]
        raw_stream_size = len(color_image.read_raw_bytes())
        uncompressed_size = (
            int(color_image.get("/Width")) * int(color_image.get("/Height")) * 3
        )
        assert raw_stream_size < 0.25 * uncompressed_size
        cs = color_images[0].get("/ColorSpace")
        assert isinstance(cs, pikepdf.Array) and str(cs[0]) == "/ICCBased"
        profile_name = ImageCms.getProfileName(
            ImageCms.getOpenProfile(io.BytesIO(cs[1].read_bytes()))
        ).lower()
        assert "srgb" in profile_name
        assert "adobe" not in profile_name

    rendered = pdfium.PdfDocument(out)
    pixels = rendered[0].render(scale=4, rev_byteorder=True).to_numpy()
    mid_y, mid_x = pixels.shape[0] // 2, pixels.shape[1] // 2
    assert np.all(pixels[mid_y, 5, :3] >= 250), pixels[mid_y, 5, :3]
    center = pixels[mid_y, mid_x, :3]
    assert int(center[1]) > 120 and int(center[0]) < 20 and int(center[2]) < 20


def test_rectangle_inpaint_uses_color_managed_page_renderer(monkeypatch, tmp_path):
    """The smart rectangle path must sample the composited page, not PDFium RGB."""
    import numpy as np
    import app.workers.sticker_engine as sticker_module

    src = str(tmp_path / "rect_renderer.pdf")
    out = str(tmp_path / "rect_renderer_bleed.pdf")
    _make_rectangle_white_edge_pdf(src)
    sampled_rgb = np.array([23, 101, 207], dtype=np.uint8)
    calls = []

    def fake_renderer(input_path, page_index, scale, expected_width, expected_height):
        calls.append((input_path, page_index, scale, expected_width, expected_height))
        return np.full(
            (expected_height, expected_width, 3), sampled_rgb, dtype=np.uint8
        )

    monkeypatch.setattr(
        sticker_module, "_render_page_rgb_ghostscript", fake_renderer
    )
    success, _meta = sticker_module.StickerEngine(dpi=150).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="none",
        bleed_mm=2.0,
        bleed_color_type="inpaint",
        draw_cut_contour=False,
        rectangle_mode=True,
        edge_bite_mm=0.0,
    )
    assert success is True
    assert calls and calls[0][1] == 0
    assert calls[0][3] > 0 and calls[0][4] > 0

    with pikepdf.Pdf.open(out) as result:
        xobjects = result.pages[0].Resources.get("/XObject", {})
        color_images = [
            xobjects[name]
            for name in xobjects
            if str(xobjects[name].get("/Subtype")) == "/Image"
            and str(xobjects[name].get("/ColorSpace")) != "/DeviceGray"
        ]
        assert color_images
        image = color_images[0]
        pixels = np.frombuffer(image.read_bytes(), dtype=np.uint8).reshape(
            int(image.get("/Height")), int(image.get("/Width")), 3
        )
        assert np.all(pixels[0, 0] == sampled_rgb)
        assert np.all(pixels[-1, -1] == sampled_rgb)


def test_rectangle_inpaint_falls_back_when_ghostscript_is_unavailable(
    monkeypatch, tmp_path
):
    """Missing Ghostscript must degrade to PDFium instead of failing the job."""
    import app.workers.sticker_engine as sticker_module

    src = str(tmp_path / "rect_fallback.pdf")
    out = str(tmp_path / "rect_fallback_bleed.pdf")
    _make_rectangle_white_edge_pdf(src)
    monkeypatch.setattr(
        sticker_module,
        "_render_page_rgb_ghostscript",
        lambda *_args, **_kwargs: None,
    )

    success, _meta = sticker_module.StickerEngine(dpi=150).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="none",
        bleed_mm=2.0,
        bleed_color_type="inpaint",
        draw_cut_contour=False,
        rectangle_mode=True,
        edge_bite_mm=0.0,
    )
    assert success is True
    with pikepdf.Pdf.open(out) as result:
        xobjects = result.pages[0].Resources.get("/XObject", {})
        assert any(
            str(xobjects[name].get("/Subtype")) == "/Image"
            and str(xobjects[name].get("/ColorSpace")) != "/DeviceGray"
            for name in xobjects
        )



def _make_selected_sticker_sheet(path: str, *, two_pages: bool = False) -> bytes:
    """A5 sheet with decoration plus two independent Form-XObject stickers."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(419.53, 595.28))

    def make_form(color_ops: bytes):
        form = pdf.make_stream(color_ops + b"0 0 48 48 re f\n")
        form.Type = pikepdf.Name.XObject
        form.Subtype = pikepdf.Name.Form
        form.BBox = pikepdf.Array([0, 0, 48, 48])
        form.Resources = pikepdf.Dictionary()
        return form

    sticker_one = make_form(b"0 0.75 0.2 rg ")
    sticker_two = make_form(b"0.95 0.55 0 rg ")
    page.Resources = pikepdf.Dictionary({
        "/XObject": pikepdf.Dictionary({
            "/StickerOne": sticker_one,
            "/StickerTwo": sticker_two,
        }),
    })
    original_content = (
        b"1 1 1 rg 0 0 419.53 595.28 re f\n"
        b"0.1 0.25 0.95 rg 340 520 32 32 re f\n"
        b"q 1 0 0 1 55 420 cm /StickerOne Do Q\n"
        b"q 1 0 0 1 155 420 cm /StickerTwo Do Q\n"
    )
    page.Contents = pdf.make_stream(original_content)

    if two_pages:
        page_two = pdf.add_blank_page(page_size=(419.53, 595.28))
        page_two.Contents = pdf.make_stream(
            b"0.88 0.88 0.88 rg 0 0 419.53 595.28 re f\n"
            b"0.75 0.1 0.35 rg 40 40 80 80 re f\n"
        )

    pdf.save(path)
    return original_content


def _selection_ids_for_sheet(path: str) -> dict[str, str]:
    from app.core import geometry_reader

    objects = geometry_reader.list_objects(path, 0)
    by_left = {
        round(float(obj.bbox[0])): obj.id
        for obj in objects
        if obj.type == "vector"
    }
    assert 55 in by_left and 155 in by_left
    return {"one": by_left[55], "two": by_left[155]}


def _box_lefts(meta: dict) -> list[float]:
    return sorted(float(box["x_pt"]) for box in meta["boxes"])


def test_object_selection_creates_two_cutlines_and_preserves_entire_sheet(tmp_path):
    src = str(tmp_path / "selected_sheet.pdf")
    out = str(tmp_path / "selected_sheet_out.pdf")
    original_content = _make_selected_sticker_sheet(src, two_pages=True)
    selection_ids = _selection_ids_for_sheet(src)

    with pikepdf.Pdf.open(src) as source:
        source_page_two = _read_all_content(source.pages[1])
        source_boxes = {
            name: [float(v) for v in source.pages[0].obj.get(name)]
            for name in ("/MediaBox", "/CropBox")
            if source.pages[0].obj.get(name) is not None
        }
        source_form_bytes = {
            name: source.pages[0].Resources.XObject[name].read_bytes()
            for name in ("/StickerOne", "/StickerTwo")
        }

    success, meta = StickerEngine(dpi=120).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="original",
        offset_mm=0.0,
        corner_style="preserve",
        bleed_mm=0.0,
        fill_holes=True,
        remove_white_bg=True,
        draw_cut_contour=True,
        shape_mode="contour",
        selected_objects_by_page={0: [selection_ids["one"], selection_ids["two"]]},
    )

    assert success is True
    assert meta["selection_count"] == 2
    assert meta["selection_pages"] == [1]
    assert len(meta["boxes"]) == 2
    assert _box_lefts(meta) == pytest.approx([55.0, 155.0], abs=1.2)
    assert all(left < 250 for left in _box_lefts(meta)), "decoration must not become a cutline"

    with pikepdf.Pdf.open(out) as result:
        assert len(result.pages) == 2
        page = result.pages[0]
        for name, expected in source_boxes.items():
            assert [float(v) for v in page.obj.get(name)] == pytest.approx(expected, abs=0.001)
        assert "/TrimBox" not in page.obj
        all_content = _read_all_content(page)
        assert original_content in all_content
        cut_content = all_content.split(b"/CutContour CS", 1)[1]
        assert cut_content.count(b" m\n") == 2
        for name, expected in source_form_bytes.items():
            assert page.Resources.XObject[name].read_bytes() == expected
        assert _read_all_content(result.pages[1]) == source_page_two
        assert b"/CutContour CS" not in _read_all_content(result.pages[1])


def test_object_selection_bleeds_only_target_and_leaves_other_artwork_unchanged(tmp_path):
    import numpy as np
    import pypdfium2 as pdfium

    src = str(tmp_path / "one_selected_sheet.pdf")
    out = str(tmp_path / "one_selected_sheet_out.pdf")
    _make_selected_sticker_sheet(src)
    selection_ids = _selection_ids_for_sheet(src)

    success, meta = StickerEngine(dpi=120).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="original",
        offset_mm=0.0,
        corner_style="preserve",
        bleed_mm=2.0,
        fill_holes=True,
        remove_white_bg=True,
        bleed_color_type="image",
        draw_cut_contour=True,
        shape_mode="contour",
        selected_objects_by_page={0: [selection_ids["one"]]},
    )

    assert success is True
    assert meta["selection_count"] == 1
    assert len(meta["boxes"]) == 1
    assert _box_lefts(meta) == pytest.approx([55.0], abs=1.2)

    source_doc = pdfium.PdfDocument(src)
    result_doc = pdfium.PdfDocument(out)
    source_pixels = source_doc[0].render(scale=2, rev_byteorder=True).to_numpy()
    result_pixels = result_doc[0].render(scale=2, rev_byteorder=True).to_numpy()

    # Centers of the unselected sticker and top-right decoration remain pixel-identical.
    height = source_pixels.shape[0]
    probes_pdf = [(179, 444), (356, 536)]
    for x_pt, y_pt in probes_pdf:
        x_px = int(round(x_pt * 2))
        y_px = int(round((595.28 - y_pt) * 2))
        assert np.array_equal(
            source_pixels[y_px, x_px, :3],
            result_pixels[y_px, x_px, :3],
        )

    # The bleed ring must remain visible over a full-page white background.
    bleed_x_px = int(round(52.0 * 2))
    bleed_y_px = int(round((595.28 - 444.0) * 2))
    assert np.all(source_pixels[bleed_y_px, bleed_x_px, :3] >= 250)
    bleed_pixel = result_pixels[bleed_y_px, bleed_x_px, :3]
    assert int(bleed_pixel[1]) > 120 and int(bleed_pixel[0]) < 100, bleed_pixel

    # Every rendered pixel outside the selected sticker + bleed/cut guard stays
    # identical, catching black boxes, lost decorations and accidental page clips.
    changed = np.any(source_pixels[:, :, :3] != result_pixels[:, :, :3], axis=2)
    allowed = np.zeros_like(changed, dtype=bool)
    x0, x1 = int(47 * 2), int(111 * 2)
    y0 = int((595.28 - 478) * 2)
    y1 = int((595.28 - 410) * 2)
    allowed[y0:y1 + 1, x0:x1 + 1] = True
    assert np.count_nonzero(changed & ~allowed) == 0

    with pikepdf.Pdf.open(out) as result:
        page = result.pages[0]
        assert [float(v) for v in page.MediaBox] == pytest.approx(
            [0.0, 0.0, 419.53, 595.28], abs=0.001
        )
        assert page.Resources.XObject["/StickerTwo"].read_bytes().startswith(
            b"0.95 0.55 0 rg"
        )



def test_sticker_endpoint_forwards_valid_object_selection(tmp_path, monkeypatch):
    import asyncio
    import json
    import shutil

    from app.api.routes import pdf_tools
    from app.workers import sticker_engine

    source = tmp_path / "selection_route.pdf"
    _make_selected_sticker_sheet(str(source))
    selection_ids = _selection_ids_for_sheet(str(source))
    captured = {}

    class StubEngine:
        def __init__(self, dpi=300):
            self.dpi = dpi

        def process_pdf(self, input_path, output_path, **kwargs):
            captured.update(kwargs)
            shutil.copyfile(input_path, output_path)
            return True, {
                "selection_count": 1,
                "pages": [{"page": 1}],
            }

    class FakeRequest:
        async def form(self):
            return {
                "file_path": str(source),
                "selection_json": json.dumps({
                    "pages": [{
                        "page": 0,
                        "object_ids": [selection_ids["one"]],
                    }],
                }),
            }

    monkeypatch.setattr(sticker_engine, "StickerEngine", StubEngine)
    monkeypatch.setattr(pdf_tools, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(pdf_tools, "_safe_watermark", lambda *args: None)

    response = asyncio.run(
        pdf_tools.sticker_dieline_endpoint(FakeRequest(), license_info={})
    )

    assert captured["selected_objects_by_page"] == {
        0: [selection_ids["one"]],
    }
    assert response.headers["X-Sticker-Selection-Count"] == "1"


def test_nen_mau_duoc_tach_dung_khong_cat_ca_trang(tmp_path):
    """QUALITY (audit 2026-08-06 §BG.1/§BG.2): nền màu phải tách ĐÚNG.

    Trước đây `white_mask` rỗng → `base_mask` toàn 255 → contour duy nhất là MÉP
    TRANG, tức đường cắt ôm trọn khổ, và đi thẳng ra xưởng không một lời cảnh
    báo. §BG.1 chặn hỏng âm thầm; §BG.2 dò nền theo MÀU nên ca này nay chạy đúng:
    đường cắt phải ôm con tem, KHÔNG ôm cả trang, và có cảnh báo nêu màu nền.
    """
    src = str(tmp_path / "nen_mau.pdf")
    out = str(tmp_path / "nen_mau_out.pdf")

    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(100, 60))
    # Nền #F2E9DC (trắng ngà/kem) + tem đỏ ở giữa.
    page.Contents = pdf.make_stream(
        b"0.949 0.914 0.863 rg 0 0 100 60 re f\n"
        b"0.8 0.1 0.1 rg 25 15 50 30 re f\n"
    )
    pdf.save(src)

    success, meta = StickerEngine(dpi=150).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="original",
        offset_mm=0.0,
        corner_style="miter",
        bleed_mm=0.0,
        fill_holes=True,
        remove_white_bg=True,
        draw_cut_contour=True,
        shape_mode="contour",
    )

    assert success is True, meta.get("error")
    with pikepdf.Pdf.open(out) as result:
        trim = [float(v) for v in result.pages[0].TrimBox]
        width = trim[2] - trim[0]
        height = trim[3] - trim[1]
        # Ôm con tem 50×30 pt, KHÔNG phải cả trang 100×60.
        assert 45.0 < width < 58.0, f"TrimBox rộng {width:.1f}pt — nghi cắt cả trang"
        assert 25.0 < height < 38.0, f"TrimBox cao {height:.1f}pt — nghi cắt cả trang"
        assert b"/CutContour CS" in _read_all_content(result.pages[0])
    assert "nền" in (meta.get("warning") or "").lower()


def test_nen_gradient_bao_loi_thay_vi_cat_ca_trang(tmp_path):
    """QUALITY (audit 2026-08-06 §BG.1): nền KHÔNG phẳng thì phải BÁO LỖI.

    Đây là lưới an toàn cuối: dò nền theo màu bốn góc cũng bó tay (bốn góc lệch
    màu nhau), nên engine phải trả lỗi nghiệp vụ (route đổi thành 422) chứ không
    được lặng lẽ trả đường cắt ôm trọn khổ tờ.
    """
    import io as _io

    import numpy as _np
    from PIL import Image as _Image

    src = str(tmp_path / "nen_gradient.pdf")
    out = str(tmp_path / "nen_gradient_out.pdf")

    w, h = 300, 200
    yy, xx = _np.mgrid[:h, :w]
    rgb = _np.zeros((h, w, 3), dtype=_np.uint8)
    # Gradient chéo mạnh: bốn góc bốn màu khác nhau rõ rệt.
    rgb[:, :, 0] = (xx * 255 // (w - 1)).astype(_np.uint8)
    rgb[:, :, 1] = (yy * 255 // (h - 1)).astype(_np.uint8)
    rgb[:, :, 2] = 90
    buf = _io.BytesIO()
    _Image.fromarray(rgb, mode="RGB").save(buf, format="PNG")
    buf.seek(0)

    from reportlab.lib.utils import ImageReader as _ImageReader
    from reportlab.pdfgen import canvas as _canvas

    page_w, page_h = w * 72.0 / 150.0, h * 72.0 / 150.0
    c = _canvas.Canvas(src, pagesize=(page_w, page_h), pageCompression=0)
    c.drawImage(_ImageReader(buf), 0, 0, width=page_w, height=page_h)
    c.showPage()
    c.save()

    success, meta = StickerEngine(dpi=150).process_pdf(
        input_path=src,
        output_path=out,
        cut_mode="original",
        offset_mm=0.0,
        corner_style="miter",
        bleed_mm=0.0,
        fill_holes=True,
        remove_white_bg=True,
        draw_cut_contour=True,
        shape_mode="contour",
    )

    assert success is False, "nền gradient phải báo lỗi, không được cắt cả trang"
    assert "nền" in meta.get("error", "").lower()
    assert not os.path.exists(out), "file lỗi phải bị dọn, không để thợ mở nhầm"
