"""Engine cục bộ cho công cụ Nắn thẻ – Làm trắng scan.

Các hàm trong module này không biết HTTP/artifact. Route chỉ decode/encode và
điều phối scheduler; hình học và xử lý pixel được khóa bằng test thuần tại đây.
"""
from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from typing import Callable, Literal, Sequence

import cv2
import numpy as np
from PIL import Image, ImageOps


ID1_WIDTH_MM = 85.60
ID1_HEIGHT_MM = 53.98
ID1_RATIO = ID1_WIDTH_MM / ID1_HEIGHT_MM

ScanMode = Literal["color", "gray", "bw"]
# DOC-CLEANUP PERF (2026-08-20): chỉ thu nhỏ ảnh dùng để ước lượng nền/góc;
# mọi phép hiệu chỉnh và pixel xuất vẫn chạy ở kích thước người dùng đã chọn.
SCAN_ANALYSIS_MAX_DIMENSION = 1400
# Texture được đo ở cùng một thang để PDF 300 DPI và ảnh xem trước cho kết
# quả phân loại như nhau; 600 px đủ thấy hạt nền nhưng làm mờ xung bụi 1 px.
SCAN_TEXTURE_REFERENCE_DIMENSION = 600


class DocumentCleanupCancelled(RuntimeError):
    """Job làm trắng PDF đã được người dùng hủy giữa hai trang."""


@dataclass(frozen=True)
class CardDetection:
    """Bốn góc theo thứ tự TL, TR, BR, BL trong hệ pixel ảnh gốc."""

    points: tuple[tuple[float, float], ...]
    confidence: float
    method: str


def load_image_bytes(source: bytes) -> Image.Image:
    """Decode ảnh, áp EXIF orientation và chuẩn hóa RGB/RGBA."""

    from io import BytesIO

    with Image.open(BytesIO(source)) as opened:
        corrected = ImageOps.exif_transpose(opened)
        if corrected.mode in ("RGBA", "LA") or "transparency" in corrected.info:
            return corrected.convert("RGBA").copy()
        return corrected.convert("RGB").copy()


def _order_quad(points: np.ndarray) -> np.ndarray:
    pts = np.asarray(points, dtype=np.float32).reshape(4, 2)
    center = pts.mean(axis=0)
    angles = np.arctan2(pts[:, 1] - center[1], pts[:, 0] - center[0])
    circular = pts[np.argsort(angles)]
    # Bắt đầu từ điểm có x+y nhỏ nhất (góc trên-trái), sau đó bảo đảm chiều kim đồng hồ.
    circular = np.roll(circular, -int(np.argmin(circular.sum(axis=1))), axis=0)
    cross = np.cross(circular[1] - circular[0], circular[2] - circular[1])
    if cross < 0:
        circular = circular[[0, 3, 2, 1]]
    return circular.astype(np.float32)


def _quad_confidence(quad: np.ndarray, image_area: float, contour_area: float) -> float:
    ordered = _order_quad(quad)
    polygon_area = abs(float(cv2.contourArea(ordered.reshape(-1, 1, 2))))
    if polygon_area <= 1.0 or image_area <= 1.0:
        return 0.0
    fill = min(1.0, contour_area / polygon_area)
    coverage = min(1.0, polygon_area / image_area)
    sides = [
        float(np.linalg.norm(ordered[(i + 1) % 4] - ordered[i]))
        for i in range(4)
    ]
    opposite = min(sides[0], sides[2]) / max(sides[0], sides[2], 1.0)
    opposite *= min(sides[1], sides[3]) / max(sides[1], sides[3], 1.0)
    # Coverage nhỏ vẫn hợp lệ, nhưng dưới 8% thường là vật thể phụ trong ảnh.
    coverage_score = min(1.0, coverage / 0.35)
    return float(np.clip(0.45 * fill + 0.30 * opposite + 0.25 * coverage_score, 0.0, 1.0))


def _candidate_masks(rgb: np.ndarray, foreground_mask: np.ndarray | None) -> list[tuple[str, np.ndarray]]:
    height, width = rgb.shape[:2]
    minimum = max(3, int(round(min(width, height) * 0.006)))
    if minimum % 2 == 0:
        minimum += 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (minimum, minimum))
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    median = float(np.median(blurred))
    lower = int(max(12, 0.55 * median))
    upper = int(min(245, max(lower + 30, 1.45 * median)))
    edges = cv2.Canny(blurred, lower, upper)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=2)
    masks: list[tuple[str, np.ndarray]] = [("edges", edges)]
    if foreground_mask is not None:
        mask = np.asarray(foreground_mask)
        if mask.ndim == 3:
            mask = mask[:, :, 0]
        if mask.shape != gray.shape:
            mask = cv2.resize(mask, (width, height), interpolation=cv2.INTER_LINEAR)
        mask = np.where(mask > 96, 255, 0).astype(np.uint8)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
        masks.insert(0, ("ai-mask", mask))
    return masks


def detect_card_quad(
    image: Image.Image | np.ndarray,
    foreground_mask: np.ndarray | None = None,
) -> CardDetection | None:
    """Tìm tứ giác thẻ; mask AI chỉ khoanh vùng, cạnh cuối vẫn fit bằng OpenCV."""

    rgb = np.asarray(image.convert("RGB") if isinstance(image, Image.Image) else image)
    if rgb.ndim != 3 or rgb.shape[2] < 3:
        raise ValueError("Ảnh nắn thẻ phải là RGB/RGBA")
    rgb = np.ascontiguousarray(rgb[:, :, :3].astype(np.uint8, copy=False))
    height, width = rgb.shape[:2]
    image_area = float(width * height)
    if min(width, height) < 48:
        return None

    best: CardDetection | None = None
    best_score = 0.0
    for method, mask in _candidate_masks(rgb, foreground_mask):
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:12]:
            area = float(cv2.contourArea(contour))
            if area < image_area * 0.06 or area > image_area * 0.98:
                continue
            hull = cv2.convexHull(contour)
            perimeter = float(cv2.arcLength(hull, True))
            if perimeter <= 0:
                continue
            candidates: list[tuple[str, np.ndarray]] = []
            for epsilon in (0.015, 0.025, 0.04, 0.06):
                approx = cv2.approxPolyDP(hull, epsilon * perimeter, True)
                if len(approx) == 4 and cv2.isContourConvex(approx):
                    candidates.append((method, approx.reshape(4, 2)))
                    break
            # Góc bo/lóa có thể không còn bốn đỉnh rõ. minAreaRect là fallback
            # confidence thấp để UI yêu cầu người dùng kiểm tra lại bốn điểm.
            if not candidates:
                candidates.append((method + ":box", cv2.boxPoints(cv2.minAreaRect(hull))))
            for candidate_method, quad in candidates:
                ordered = _order_quad(quad)
                score = _quad_confidence(ordered, image_area, area)
                if candidate_method.endswith(":box"):
                    score *= 0.72
                if score > best_score:
                    best_score = score
                    best = CardDetection(
                        points=tuple((float(x), float(y)) for x, y in ordered),
                        confidence=score,
                        method=candidate_method,
                    )
    return best


def normalized_points(detection: CardDetection, width: int, height: int) -> list[dict[str, float]]:
    if width <= 1 or height <= 1:
        raise ValueError("Kích thước ảnh không hợp lệ")
    return [
        {"x": float(x / (width - 1)), "y": float(y / (height - 1))}
        for x, y in detection.points
    ]


def rectify_card(
    image: Image.Image | np.ndarray,
    points: Sequence[Sequence[float]],
    *,
    target_ratio: float | None = ID1_RATIO,
) -> Image.Image:
    """Nắn bốn điểm về hình chữ nhật; target_ratio là cạnh dài/cạnh ngắn."""

    source_image = image.convert("RGB") if isinstance(image, Image.Image) else Image.fromarray(image).convert("RGB")
    source = _order_quad(np.asarray(points, dtype=np.float32))
    if not cv2.isContourConvex(source.reshape(-1, 1, 2)):
        raise ValueError("Bốn góc thẻ phải tạo thành một tứ giác lồi")
    polygon_area = abs(float(cv2.contourArea(source.reshape(-1, 1, 2))))
    if polygon_area < source_image.width * source_image.height * 0.005:
        raise ValueError("Vùng thẻ quá nhỏ để nắn ổn định")

    top = float(np.linalg.norm(source[1] - source[0]))
    bottom = float(np.linalg.norm(source[2] - source[3]))
    right = float(np.linalg.norm(source[2] - source[1]))
    left = float(np.linalg.norm(source[3] - source[0]))
    measured_width = max(top, bottom, 2.0)
    measured_height = max(left, right, 2.0)
    landscape = measured_width >= measured_height
    if target_ratio is not None:
        if not np.isfinite(target_ratio) or target_ratio < 1.05 or target_ratio > 10.0:
            raise ValueError("Tỷ lệ thẻ không hợp lệ")
        long_side = max(measured_width, measured_height)
        short_side = long_side / target_ratio
        output_width, output_height = (
            (long_side, short_side) if landscape else (short_side, long_side)
        )
    else:
        output_width, output_height = measured_width, measured_height
    width = max(2, int(round(output_width)))
    height = max(2, int(round(output_height)))
    destination = np.float32(
        [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]]
    )
    matrix = cv2.getPerspectiveTransform(source, destination)
    corrected = cv2.warpPerspective(
        np.asarray(source_image),
        matrix,
        (width, height),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )
    return Image.fromarray(corrected, mode="RGB")


def _scan_analysis_image(channel: np.ndarray) -> tuple[np.ndarray, float]:
    """Ảnh phân tích nhỏ hơn; pixel đầu ra vẫn giữ nguyên độ phân giải gốc."""

    height, width = channel.shape[:2]
    longest = max(height, width)
    if longest <= SCAN_ANALYSIS_MAX_DIMENSION:
        return channel, 1.0
    scale = SCAN_ANALYSIS_MAX_DIMENSION / float(longest)
    resized = cv2.resize(
        channel,
        (max(1, round(width * scale)), max(1, round(height * scale))),
        interpolation=cv2.INTER_AREA,
    )
    return resized, scale


def _estimate_background(channel: np.ndarray, strength: float) -> np.ndarray:
    height, width = channel.shape
    analysis, _ = _scan_analysis_image(channel)
    analysis_height, analysis_width = analysis.shape
    # Kernel lớn hơn nét chữ để chỉ mô hình hóa giấy/bóng/sọc chậm.
    span = max(15, int(round(min(analysis_width, analysis_height) * (0.035 + 0.045 * strength))))
    if span % 2 == 0:
        span += 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (span, span))
    closed = cv2.morphologyEx(analysis, cv2.MORPH_CLOSE, kernel)
    sigma = max(3.0, span / 4.0)
    background = cv2.GaussianBlur(closed, (0, 0), sigmaX=sigma, sigmaY=sigma)
    if background.shape != (height, width):
        background = cv2.resize(background, (width, height), interpolation=cv2.INTER_LINEAR)
    return background


def _suppress_scan_speckles(
    channel: np.ndarray,
    strength: float,
    *,
    eligible: np.ndarray | None = None,
) -> np.ndarray:
    """Xóa hạt bụi rời nhưng giữ nét chữ/dấu nằm cạnh nội dung có cấu trúc.

    Scanner điện thoại thường sinh các chấm đen/ghi nhỏ trên vùng giấy trống.
    Median blur toàn trang sẽ làm mờ chữ viết tay; thay vào đó chỉ thay thế các
    thành phần mực nhỏ, xa mọi nét mực có diện tích đủ lớn. Chấm của chữ i, dấu
    câu và nét mảnh nằm cạnh chữ vẫn được giữ nhờ vùng đệm quanh cấu trúc mực.
    """

    if channel.ndim != 2 or strength <= 0.05:
        return channel
    if eligible is not None and eligible.shape != channel.shape:
        raise ValueError("Mặt nạ khử nhiễu không cùng kích thước ảnh scan")

    # DOC-CLEANUP FIX (2026-08-20): ngưỡng tăng theo mức làm sạch, nhưng chỉ
    # dùng cho thành phần rời; không làm nhòe nguyên trang như NLM màu full-res.
    component_limit = max(6, min(28, int(round(5 + 22 * strength))))
    proximity = max(4, min(10, int(round(3 + 7 * strength))))
    # PDF 300 DPI có thể lớn hơn 8 MP. Phân loại bụi theo ảnh analysis đủ để
    # nhận các hạt rời, rồi mới thay đúng pixel tương ứng ở ảnh gốc. Cách này
    # tránh sáu lượt connected-components full-resolution cho mỗi trang PDF.
    analysis, scale = _scan_analysis_image(channel)
    analysis_height, analysis_width = analysis.shape
    analysis_limit = max(2, int(round(component_limit * scale * scale)))
    analysis_proximity = max(2, int(round(proximity * scale)))
    cleaned_analysis = analysis.copy()
    removed_analysis = np.zeros_like(analysis, dtype=bool)
    eligible_analysis: np.ndarray | None = None
    if eligible is not None:
        eligible_analysis = cv2.resize(
            eligible.astype(np.uint8),
            (analysis_width, analysis_height),
            interpolation=cv2.INTER_NEAREST,
        ).astype(bool)
    kernel_size = analysis_proximity * 2 + 1
    structure_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    # Tách theo ba mức tối từ đậm tới nhạt. Lớp bụi dày có thể dính thành một
    # khối ở ngưỡng nhạt; xóa các hạt đậm trước sẽ phá khối đó ở lượt sau.
    for dark_limit in (60, 90, 120, 145, 175, 205):
        dark_ink = np.asarray(cleaned_analysis < dark_limit, dtype=np.uint8)
        labels_count, labels, stats, _ = cv2.connectedComponentsWithStats(dark_ink, 8)
        if labels_count <= 1:
            continue
        areas = stats[:, cv2.CC_STAT_AREA]
        structural_labels = areas > analysis_limit
        structural_labels[0] = False
        structural_ink = structural_labels[labels].astype(np.uint8)
        nearby_structure = cv2.dilate(structural_ink, structure_kernel).astype(bool)
        isolated_ink = (labels > 0) & ~structural_labels[labels] & ~nearby_structure
        if eligible_analysis is not None:
            isolated_ink &= eligible_analysis
        if np.any(isolated_ink):
            # Median 5×5 thay thế đúng chấm nhỏ, còn cấu trúc không thuộc noise không bị đụng tới.
            local_paper = cv2.medianBlur(cleaned_analysis, 5)
            cleaned_analysis[isolated_ink] = local_paper[isolated_ink]
            removed_analysis |= isolated_ink
    removed = cv2.resize(
        removed_analysis.astype(np.uint8),
        (channel.shape[1], channel.shape[0]),
        interpolation=cv2.INTER_NEAREST,
    ).astype(bool)
    # Hạt 1–3 px trên PDF 300 DPI có thể bị trung bình hóa khi thu nhỏ ảnh
    # analysis. Bắt thêm các xung tối so với lân cận ngay ở độ phân giải gốc;
    # đây chỉ là một lượt component thay vì sáu lượt full-resolution.
    local_paper = cv2.medianBlur(channel, 5)
    impulse_limit = max(28, int(round(66.0 - 34.0 * strength)))
    impulses = (local_paper.astype(np.int16) - channel.astype(np.int16)) >= impulse_limit
    if eligible is not None:
        impulses &= eligible.astype(bool, copy=False)
    labels_count, labels, stats, _ = cv2.connectedComponentsWithStats(
        impulses.astype(np.uint8),
        8,
    )
    if labels_count > 1:
        areas = stats[:, cv2.CC_STAT_AREA]
        structural_labels = areas > component_limit
        structural_labels[0] = False
        structural_ink = structural_labels[labels].astype(np.uint8)
        full_kernel_size = proximity * 2 + 1
        full_structure_kernel = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE,
            (full_kernel_size, full_kernel_size),
        )
        nearby_structure = cv2.dilate(structural_ink, full_structure_kernel).astype(bool)
        removed |= (labels > 0) & ~structural_labels[labels] & ~nearby_structure
    if eligible is not None:
        # Mặt nạ analysis đã được nội suy; áp lại ở ảnh gốc để không làm mờ
        # một pixel dấu màu nằm trong ô analysis gần trung tính.
        removed &= eligible.astype(bool, copy=False)
    if not np.any(removed):
        return channel

    cleaned = channel.copy()
    cleaned[removed] = local_paper[removed]
    return cleaned


def _suppress_binary_speckles(binary: np.ndarray, strength: float) -> np.ndarray:
    """Dọn chấm đen rời trong output BW mà không xóa nét chữ mảnh.

    Diện tích bụi và bán kính bảo vệ đều tỷ lệ theo kích thước trang. Các
    component nhỏ nằm gần chữ/bảng lớn được xem là dấu câu hoặc nét đứt và giữ
    lại; chỉ component nhỏ cô lập trên nền giấy mới bị xóa.
    """

    if binary.ndim != 2 or strength <= 0.05:
        return binary
    ink = np.asarray(binary == 0, dtype=np.uint8)
    labels_count, labels, stats, _ = cv2.connectedComponentsWithStats(ink, 8)
    if labels_count <= 1:
        return binary

    scale = max(binary.shape) / 650.0
    area_limit = max(2, int(round(2.0 * (1.0 + strength) * scale * scale)))
    proximity = max(3, int(round(4.0 * scale)))
    areas = stats[:, cv2.CC_STAT_AREA]
    structural_labels = areas > area_limit
    structural_labels[0] = False
    structural_ink = structural_labels[labels].astype(np.uint8)
    kernel_size = proximity * 2 + 1
    structure_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    nearby_structure = cv2.dilate(structural_ink, structure_kernel).astype(bool)
    isolated = (labels > 0) & ~structural_labels[labels] & ~nearby_structure
    if not np.any(isolated):
        return binary
    cleaned = binary.copy()
    cleaned[isolated] = 255
    return cleaned


def _suppress_flattened_speckles(
    channel: np.ndarray,
    strength: float,
    *,
    eligible: np.ndarray | None = None,
) -> np.ndarray:
    """Dọn hạt còn lại sau flat-field bằng một ngưỡng, giữ component chữ."""

    if channel.ndim != 2 or strength <= 0.05:
        return channel
    if eligible is not None and eligible.shape != channel.shape:
        raise ValueError("Mặt nạ khử nhiễu không cùng kích thước ảnh scan")
    dark_limit = int(round(200.0 - 15.0 * strength))
    ink = channel < dark_limit
    if eligible is not None:
        ink &= eligible.astype(bool, copy=False)
    labels_count, labels, stats, _ = cv2.connectedComponentsWithStats(ink.astype(np.uint8), 8)
    if labels_count <= 1:
        return channel

    scale = max(channel.shape) / 650.0
    area_limit = max(3, int(round(2.7 * (1.0 + strength) * scale * scale)))
    proximity = max(3, int(round(4.0 * scale)))
    areas = stats[:, cv2.CC_STAT_AREA]
    structural_labels = areas > area_limit
    structural_labels[0] = False
    structural_ink = structural_labels[labels].astype(np.uint8)
    kernel_size = proximity * 2 + 1
    structure_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    nearby_structure = cv2.dilate(structural_ink, structure_kernel).astype(bool)
    isolated = (labels > 0) & ~structural_labels[labels] & ~nearby_structure
    if not np.any(isolated):
        return channel
    local_paper = cv2.medianBlur(channel, 5)
    cleaned = channel.copy()
    cleaned[isolated] = np.maximum(local_paper[isolated], dark_limit + 25)
    return cleaned


def _scan_texture_score(channel: np.ndarray) -> float:
    """Điểm hạt tối ổn định theo DPI; nền giấy sạch thường gần 0."""

    height, width = channel.shape
    longest = max(height, width)
    if longest > SCAN_TEXTURE_REFERENCE_DIMENSION:
        scale = SCAN_TEXTURE_REFERENCE_DIMENSION / float(longest)
        analysis = cv2.resize(
            channel,
            (max(1, round(width * scale)), max(1, round(height * scale))),
            interpolation=cv2.INTER_AREA,
        )
    else:
        analysis = channel
    local_median = cv2.medianBlur(analysis, 3)
    difference = np.abs(analysis.astype(np.int16) - local_median.astype(np.int16))
    return float(np.percentile(difference, 82))


def _odd_kernel_length(value: float, minimum: int) -> int:
    """Làm tròn kích thước kernel theo DPI và luôn trả về số lẻ."""

    length = max(minimum, int(round(value)))
    return length if length % 2 == 1 else length + 1


def _directional_open(candidate: np.ndarray, length: int) -> np.ndarray:
    """Giữ các nét liên tục theo bốn hướng, loại hạt rời không tạo thành nét."""

    opened = np.zeros_like(candidate, dtype=np.uint8)
    horizontal = np.zeros((length, length), dtype=np.uint8)
    horizontal[length // 2, :] = 1
    vertical = np.zeros((length, length), dtype=np.uint8)
    vertical[:, length // 2] = 1
    diagonal = np.eye(length, dtype=np.uint8)
    anti_diagonal = np.fliplr(diagonal).copy()
    for kernel in (horizontal, vertical, diagonal, anti_diagonal):
        opened |= cv2.morphologyEx(candidate, cv2.MORPH_OPEN, kernel)
    return opened


def _bw_structural_ink(channel: np.ndarray) -> np.ndarray:
    """Tìm nét chữ/bảng cần giữ trước khi cân bằng nền làm mất tương phản."""

    scale = max(channel.shape) / 3509.0

    # Nét tối và đủ dài được bảo vệ ngay cả trong vùng hạt dày. Kernel tối thiểu
    # 9 px tránh biến các cụm noise của ảnh xem trước thành nét giả.
    dark = np.asarray(channel < 150, dtype=np.uint8)
    dense_length = _odd_kernel_length(17.0 * scale, 9)
    dense_seed = _directional_open(dark, dense_length)
    if scale >= 0.75:
        dense_seed = cv2.dilate(
            dense_seed,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
        )
    protected = (dense_seed > 0) & (dark > 0)

    # DOC-CLEANUP FIX (2026-08-20 §SCAN.TEXT.03): chữ nhỏ 1 px ở PDF 300 DPI
    # thường nằm trong vùng tương đối sạch và bị bilateral/flat-field hòa vào
    # nền. Chỉ phục hồi nét ngắn tại ô có mật độ mực thấp để không cứu mảng hạt.
    if max(channel.shape) >= 2000:
        fine = np.asarray(channel < 210, dtype=np.uint8)
        fine_length = _odd_kernel_length(7.0 * scale, 7)
        density_window = max(32, int(round(64.0 * scale)))
        density = cv2.boxFilter(
            fine.astype(np.float32),
            -1,
            (density_window, density_window),
            normalize=True,
        )
        fine_seed = _directional_open(fine, fine_length)
        fine_radius = max(1, int(round(2.0 * scale)))
        fine_seed = cv2.dilate(
            fine_seed,
            cv2.getStructuringElement(
                cv2.MORPH_ELLIPSE,
                (2 * fine_radius + 1, 2 * fine_radius + 1),
            ),
        )
        # Chỉ vùng có dưới 10% pixel tối mới được coi là chữ nhỏ; ngưỡng rộng
        # hơn sẽ phục hồi nhầm texture của giấy thành bụi đen trong ô bảng.
        protected |= (fine_seed > 0) & (fine > 0) & (density < 0.10)
    return protected


def _flatten_dense_scan_noise(
    channel: np.ndarray,
    strength: float,
    *,
    eligible: np.ndarray | None = None,
) -> tuple[np.ndarray, float]:
    """Cân bằng nền hạt dày và trả kèm điểm nhiễu đầu vào."""

    if channel.ndim != 2:
        return channel, 0.0
    if eligible is not None and eligible.shape != channel.shape:
        raise ValueError("Mặt nạ khử nhiễu không cùng kích thước ảnh scan")
    texture_score = _scan_texture_score(channel)
    # DOC-CLEANUP FIX (2026-08-20): chỉ vào nhánh cân bằng hạt dày khi mức
    # nhiễu cục bộ thật sự cao; giấy có bóng mượt hoặc chữ nhạt không bị ép trắng.
    if texture_score < 10.0 or min(channel.shape) < 48:
        return channel, texture_score

    smoothed = cv2.bilateralFilter(channel, 11, 100, 100)
    analysis, _ = _scan_analysis_image(smoothed)
    sigma = max(5.0, min(analysis.shape) * (0.025 + 0.015 * strength))
    shade = cv2.GaussianBlur(analysis, (0, 0), sigmaX=sigma, sigmaY=sigma)
    if shade.shape != channel.shape:
        shade = cv2.resize(shade, (channel.shape[1], channel.shape[0]), interpolation=cv2.INTER_LINEAR)
    fully_flattened = np.clip(
        smoothed.astype(np.float32) + (253.0 - shade.astype(np.float32)),
        0,
        255,
    )
    # Mức làm sạch là mức can thiệp thật: 55% giữ thêm nét bút chì nhạt, 100%
    # mới dùng toàn bộ cân bằng nền cho ảnh hạt rất nặng.
    flatten_gain = 0.45 + 0.55 * strength
    flattened = np.clip(
        channel.astype(np.float32) + (fully_flattened - channel.astype(np.float32)) * flatten_gain,
        0,
        255,
    ).astype(np.uint8)
    if eligible is not None:
        flattened[~eligible.astype(bool, copy=False)] = channel[~eligible.astype(bool, copy=False)]
    return flattened, texture_score


def _deskew_scan(array: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(array, cv2.COLOR_RGB2GRAY) if array.ndim == 3 else array
    analysis, _ = _scan_analysis_image(gray)
    ink = cv2.threshold(analysis, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    lines = cv2.HoughLinesP(
        ink,
        1,
        np.pi / 1800,
        threshold=max(30, min(analysis.shape) // 8),
        minLineLength=max(30, analysis.shape[1] // 5),
        maxLineGap=max(5, analysis.shape[1] // 100),
    )
    if lines is None:
        return array
    angles = []
    for x1, y1, x2, y2 in lines[:, 0]:
        angle = float(np.degrees(np.arctan2(y2 - y1, x2 - x1)))
        while angle <= -90:
            angle += 180
        while angle > 90:
            angle -= 180
        if abs(angle) <= 12:
            angles.append(angle)
    if not angles:
        return array
    angle = float(np.median(angles))
    if abs(angle) < 0.25:
        return array
    height, width = gray.shape
    matrix = cv2.getRotationMatrix2D((width / 2.0, height / 2.0), angle, 1.0)
    border = (255, 255, 255) if array.ndim == 3 else 255
    return cv2.warpAffine(
        array,
        matrix,
        (width, height),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=border,
    )


def clean_scan(
    image: Image.Image | np.ndarray,
    *,
    mode: ScanMode = "color",
    strength: float = 0.55,
    remove_shadows: bool = True,
    deskew: bool = True,
) -> Image.Image:
    """Làm sạch nền scan, giữ nội dung nhạt ở cấu hình mặc định."""

    if mode not in ("color", "gray", "bw"):
        raise ValueError("Chế độ làm trắng scan không hợp lệ")
    if not np.isfinite(strength) or not 0.0 <= strength <= 1.0:
        raise ValueError("Mức làm sạch phải nằm trong khoảng 0–1")
    source = image.convert("RGB") if isinstance(image, Image.Image) else Image.fromarray(image).convert("RGB")
    rgb = np.asarray(source, dtype=np.uint8)
    if min(rgb.shape[:2]) < 16:
        return source if mode == "color" else source.convert("L")
    if deskew:
        rgb = _deskew_scan(rgb)

    if mode == "color":
        lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB)
        lightness = lab[:, :, 0].astype(np.float32)
        if remove_shadows:
            background = _estimate_background(lab[:, :, 0], strength).astype(np.float32)
            amount = 0.45 + 0.50 * strength
            # Chỉ nâng vùng tối tương đối với nền; không ép toàn trang trắng tuyệt đối.
            corrected = lightness + (245.0 - background) * amount
        else:
            corrected = lightness
        low = 1.0 + 0.08 * strength
        corrected = np.clip((corrected - 128.0) * low + 128.0, 0, 255).astype(np.uint8)
        # Dấu đỏ/xanh có chroma cao không phải bụi scan; chỉ xử lý hạt gần trung tính.
        chroma = np.abs(lab[:, :, 1].astype(np.int16) - 128) + np.abs(lab[:, :, 2].astype(np.int16) - 128)
        neutral = chroma < 28
        corrected, texture_score = _flatten_dense_scan_noise(corrected, strength, eligible=neutral)
        if texture_score < 10.0:
            corrected = _suppress_scan_speckles(corrected, strength, eligible=neutral)
        else:
            corrected = _suppress_flattened_speckles(corrected, strength, eligible=neutral)
        lab[:, :, 0] = corrected
        return Image.fromarray(cv2.cvtColor(lab, cv2.COLOR_LAB2RGB), mode="RGB")

    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    if remove_shadows:
        background = _estimate_background(gray, strength).astype(np.float32)
        normalized = gray.astype(np.float32) + (248.0 - background) * (0.55 + 0.45 * strength)
        gray = np.clip(normalized, 0, 255).astype(np.uint8)
    gray_before_flatten = gray
    gray, texture_score = _flatten_dense_scan_noise(gray, strength)
    structural_ink = (
        _bw_structural_ink(gray_before_flatten)
        if mode == "bw" and texture_score >= 10.0
        else None
    )
    if texture_score < 10.0:
        gray = _suppress_scan_speckles(gray, strength)
        gray = cv2.fastNlMeansDenoising(
            gray,
            None,
            h=2.0 + 5.0 * strength,
            templateWindowSize=7,
            searchWindowSize=21,
        )
    elif mode == "gray":
        gray = _suppress_flattened_speckles(gray, strength)
    # PERF (audit 2026-08-20 §DOC-CLEANUP): NLM không trị hiệu quả hạt dày
    # nhưng tốn ~giây/trang A4; bilateral ở nhánh dense đã làm nhiệm vụ này.
    if mode == "gray":
        contrast = 1.02 + 0.20 * strength
        gray = np.clip((gray.astype(np.float32) - 128.0) * contrast + 128.0, 0, 255).astype(np.uint8)
        return Image.fromarray(gray, mode="L")

    block = max(15, int(round(min(gray.shape) * (0.025 + 0.02 * strength))))
    if block % 2 == 0:
        block += 1
    threshold_bias = min(55.0, 5.0 + 8.0 * strength + max(0.0, texture_score - 8.0) * (1.0 + strength))
    binary = cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        block,
        threshold_bias,
    )
    if texture_score >= 10.0:
        # Dọn component đen rời trước, rồi phục hồi nét xám có cấu trúc đã lưu
        # từ ảnh trước flat-field. Thứ tự này tránh helper hiểu nét mảnh là bụi.
        binary = _suppress_binary_speckles(binary, strength)
        if structural_ink is not None:
            binary[structural_ink] = 0
    return Image.fromarray(binary, mode="L")


def clean_scan_pdf(
    source: bytes,
    *,
    mode: ScanMode = "color",
    strength: float = 0.55,
    remove_shadows: bool = True,
    deskew: bool = True,
    dpi: int = 300,
    progress_callback: Callable[[int, int, str], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> bytes:
    """Raster từng trang PDF, làm sạch rồi dựng lại đúng khổ trang ban đầu.

    PDFium chỉ được giữ khóa trong lúc mở/render/đóng. OpenCV và ReportLab chạy
    ngoài khóa để các preview PDF khác không bị chặn lâu.
    """

    import pypdfium2 as pdfium
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas

    from app.core.pdfium_lock import pdfium_guard

    if not source.startswith(b"%PDF-"):
        raise ValueError("Dữ liệu đầu vào không phải PDF")
    if not 72 <= dpi <= 1200:
        raise ValueError("DPI đầu ra phải nằm trong khoảng 72–1200")

    with pdfium_guard("document_cleanup_pdf_open"):
        pdf = pdfium.PdfDocument(source)
        page_count = len(pdf)
    if page_count <= 0:
        with pdfium_guard("document_cleanup_pdf_close_empty"):
            pdf.close()
        raise ValueError("PDF không có trang để xử lý")

    output = BytesIO()
    writer = canvas.Canvas(output, pagesize=(1, 1), pageCompression=1)
    scale = dpi / 72.0
    if progress_callback is not None:
        progress_callback(0, page_count, "rendering")
    try:
        for page_index in range(page_count):
            if cancel_check is not None and cancel_check():
                raise DocumentCleanupCancelled("Đã hủy làm trắng PDF.")
            with pdfium_guard("document_cleanup_pdf_render"):
                page = pdf[page_index]
                try:
                    page_width, page_height = page.get_size()
                    bitmap = page.render(scale=scale, rev_byteorder=True)
                    try:
                        rendered = bitmap.to_pil().convert("RGB").copy()
                    finally:
                        bitmap.close()
                finally:
                    page.close()

            cleaned = clean_scan(
                rendered,
                mode=mode,
                strength=strength,
                remove_shadows=remove_shadows,
                deskew=deskew,
            )
            encoded = BytesIO()
            if mode == "bw":
                cleaned.save(encoded, format="PNG", optimize=True)
            else:
                cleaned.convert("RGB").save(
                    encoded,
                    format="JPEG",
                    quality=92,
                    optimize=True,
                    dpi=(dpi, dpi),
                )
            encoded.seek(0)
            writer.setPageSize((float(page_width), float(page_height)))
            writer.drawImage(
                ImageReader(encoded),
                0,
                0,
                width=float(page_width),
                height=float(page_height),
            )
            writer.showPage()
            if progress_callback is not None:
                progress_callback(page_index + 1, page_count, "cleaning")
    finally:
        with pdfium_guard("document_cleanup_pdf_close"):
            pdf.close()
    writer.save()
    return output.getvalue()
