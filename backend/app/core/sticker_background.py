"""Dò NỀN của ảnh tem/nhãn để tách hình khỏi nền — dùng cho đường cắt.

QUALITY (audit 2026-08-06 §BG.2). Tách khỏi `workers/sticker_engine.py` (đã 3.4k
dòng): logic thuần xử lý ảnh, không chạm PDFium, không chạm request.

Vì sao có module này: trước đây engine có BA nhánh dò nền rời rạc, và nhánh MẶC
ĐỊNH chỉ nhận nền trắng gần tuyệt đối (cả ba kênh ≥ 248). Khách dùng AI sinh tem
thì nền hay là màu phẳng, hoặc trắng ngà do nén JPEG (246/244/245) — trượt ngưỡng
→ không bóc được gì → đường cắt ôm trọn khổ tờ. Ở đây TRẮNG chỉ còn là MỘT CA của
"nền phẳng", không phải một nhánh riêng.

Nguyên tắc giữ nguyên từ nhánh cũ (`_foreground_mask_from_corner_background`):
lấy màu nền ở BỐN GÓC, và chỉ xoá vùng cùng màu khi nó NỐI VỚI BIÊN ảnh. Nhờ vậy
một mảng màu trùng màu nền nhưng nằm kín bên trong artwork vẫn được giữ, không bị
đục lỗ. Nền không đủ đồng nhất thì trả ``None`` để caller báo lỗi rõ ràng, thay vì
đoán rồi cắt sai.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple

import cv2
import numpy as np

# Ngưỡng "mask có thực sự tách được nền hay không", dùng CHUNG cho mọi nhánh dò
# nền. Dưới MIN nghĩa là gần như không có hình; trên MAX nghĩa là gần như KHÔNG
# bóc được gì — cả hai đều dẫn tới đường cắt ôm trọn khổ trang.
BG_FOREGROUND_RATIO_MIN = 0.001
BG_FOREGROUND_RATIO_MAX = 0.98

# Bốn góc phải đồng màu tới mức này thì mới coi là "nền phẳng" (thang 0..255,
# đo bằng phân vị 95 của khoảng cách kênh lớn nhất tới màu nền trung vị).
_CORNER_UNIFORM_P95_MAX = 28.0

# Dung sai so màu quanh màu nền: nới theo độ nhiễu đo được ở góc, nhưng luôn nằm
# trong khoảng an toàn để không nuốt artwork gần màu nền.
_TOLERANCE_PADDING = 8
_TOLERANCE_MIN = 12
_TOLERANCE_MAX = 36

# Ô lấy mẫu ở mỗi góc: 1/40 cạnh ngắn, kẹp trong [2, 12] điểm ảnh.
_CORNER_PATCH_DIVISOR = 40
_CORNER_PATCH_MIN = 2
_CORNER_PATCH_MAX = 12

# Nền càng phẳng, độ tin cậy càng cao. Quy về [0..1] theo p95 đo được.
_CONFIDENCE_FLOOR = 0.35

# --- Nhánh dự phòng: nền KHÔNG phẳng (gradient / hoạ tiết) -------------------
# QUALITY (audit 2026-08-06 §BG.3). Nền gradient thì so màu tuyệt đối với MỘT màu
# nền là vô nghĩa: hai đầu tờ lệch nhau cả trăm mức. Nhưng gradient biến thiên
# CHẬM — chênh lệch giữa hai điểm ảnh kề nhau rất nhỏ, trong khi mép artwork là
# một bậc nhảy. Nên ở đây dùng `cv2.floodFill` KHÔNG cố định dải (so với điểm ảnh
# đã loang tới, không so với điểm gieo): nước loang men theo gradient khắp nền
# nhưng khựng lại ở mép hình.

# Số điểm gieo trên MỖI cạnh. Gieo nhiều để nền bị artwork chạm mép chia cắt
# thành nhiều mảnh thì mảnh nào cũng có hạt.
_FLOOD_SEEDS_PER_EDGE = 24
# Gieo lùi vào trong một chút để tránh viền đen/nhiễu sát mép ảnh.
_FLOOD_SEED_INSET = 1
# Dải loang suy từ độ dốc đo được ở viền (p95 chênh lệch giữa hai điểm kề nhau),
# nới thêm một chút rồi kẹp: quá nhỏ thì không đi hết nền, quá lớn thì tràn qua
# mép artwork và nuốt cả con tem.
_FLOOD_DIFF_PADDING = 2
_FLOOD_DIFF_MIN = 3
_FLOOD_DIFF_MAX = 16
# Nhánh này là phỏng đoán, không phải đo chắc như nền phẳng → tin cậy cố định
# thấp để lớp trên biết mà cảnh báo thợ soi lại đường cắt.
_FLOOD_CONFIDENCE = 0.30


@dataclass(frozen=True)
class BackgroundInfo:
    """Kết quả dò nền cho MỘT ảnh.

    - ``color``: màu nền (R, G, B) thang 0..255.
    - ``tolerance``: dung sai so màu đã dùng (khoảng cách kênh lớn nhất).
    - ``foreground_mask``: mask HÌNH, uint8 0/255, cùng kích thước ảnh.
    - ``confidence``: 0..1, độ phẳng của nền — dùng để quyết định có cảnh báo thợ.
    - ``is_near_white``: nền này có phải trắng/gần trắng không (ca kinh điển).
    - ``is_flat``: nền phẳng một màu (True) hay phải loang theo gradient (False).
      Nhánh gradient là phỏng đoán → lớp trên nên cảnh báo thợ soi lại.
    """

    color: Tuple[int, int, int]
    tolerance: int
    foreground_mask: np.ndarray
    confidence: float
    is_near_white: bool
    is_flat: bool = True
    # QUALITY (feedback 2026-08-16 §WHITE-SHEET.1): giữ độ nhiễu góc thật để nhánh
    # phục hồi tem trắng không phải suy ngược từ confidence đã bị kẹp.
    corner_p95: float | None = None


def foreground_ratio(mask: Optional[np.ndarray]) -> float:
    """Tỉ lệ điểm ảnh thuộc HÌNH (khác 0) trên tổng diện tích mask."""
    if mask is None or mask.size == 0:
        return 0.0
    return float(np.count_nonzero(mask)) / float(mask.size)


def mask_tach_duoc_nen(mask: Optional[np.ndarray]) -> bool:
    """Mask có thực sự tách được nền khỏi hình không."""
    return BG_FOREGROUND_RATIO_MIN <= foreground_ratio(mask) <= BG_FOREGROUND_RATIO_MAX


def has_meaningful_alpha(alpha: Optional[np.ndarray], alpha_threshold: int = 128) -> bool:
    """Kênh Alpha phải có cả nền/hình với diện tích đủ lớn, không chỉ một pixel lạc."""
    if alpha is None or alpha.size == 0:
        return False
    values = np.asarray(alpha, dtype=np.uint8)
    if not np.any(values <= 16) or not np.any(values >= 239):
        return False
    return mask_tach_duoc_nen(values >= int(alpha_threshold))


def _corner_samples(img_rgb: np.ndarray) -> np.ndarray:
    """Gộp điểm ảnh ở bốn góc thành một mảng (N, 3)."""
    height, width = img_rgb.shape[:2]
    patch = max(
        _CORNER_PATCH_MIN,
        min(_CORNER_PATCH_MAX, min(height, width) // _CORNER_PATCH_DIVISOR),
    )
    return np.concatenate((
        img_rgb[:patch, :patch, :3].reshape(-1, 3),
        img_rgb[:patch, -patch:, :3].reshape(-1, 3),
        img_rgb[-patch:, :patch, :3].reshape(-1, 3),
        img_rgb[-patch:, -patch:, :3].reshape(-1, 3),
    )).astype(np.int16)


def _foreground_from_flat_background(
    rgb: np.ndarray,
    background_rgb: np.ndarray,
    tolerance: int,
) -> Optional[np.ndarray]:
    """Xoá vùng cùng màu nền NỐI VỚI BIÊN; trả mask hình (uint8 0/255)."""
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
    return (~background).astype(np.uint8) * 255


def foreground_from_flat_background(
    img_rgb: np.ndarray,
    background_rgb: np.ndarray | tuple[int, int, int],
    tolerance: int,
) -> Optional[np.ndarray]:
    """Tách nền phẳng với dung sai do caller đã đo và vẫn chỉ xóa vùng nối biên.

    Hàm công khai này dành cho nhánh phục hồi có guard riêng. Nó không tự nới dung sai và
    không thay hợp đồng thận trọng của :func:`detect_background`.
    """
    if img_rgb is None or img_rgb.ndim != 3 or img_rgb.shape[2] < 3:
        return None
    color = np.asarray(background_rgb, dtype=np.int16).reshape(-1)
    if color.size < 3:
        return None
    return _foreground_from_flat_background(
        img_rgb[:, :, :3].astype(np.int16, copy=False),
        color[:3],
        max(0, int(tolerance)),
    )


def _border_gradient_p95(img_rgb: np.ndarray) -> float:
    """Độ dốc màu ĐO Ở VIỀN: p95 chênh lệch kênh lớn nhất giữa hai điểm kề nhau.

    QUALITY (audit 2026-08-06 §BG.3): đây là "một bước loang thì màu đổi tối đa
    bao nhiêu" trên chính vùng nền, dùng làm dải cho ``floodFill``.
    """
    rgb = img_rgb[:, :, :3].astype(np.int16)
    diffs = [
        np.max(np.abs(np.diff(rgb[0, :, :], axis=0)), axis=1),
        np.max(np.abs(np.diff(rgb[-1, :, :], axis=0)), axis=1),
        np.max(np.abs(np.diff(rgb[:, 0, :], axis=0)), axis=1),
        np.max(np.abs(np.diff(rgb[:, -1, :], axis=0)), axis=1),
    ]
    joined = np.concatenate([d for d in diffs if d.size])
    if joined.size == 0:
        return 0.0
    return float(np.percentile(joined, 95))


def _edge_seed_points(height: int, width: int) -> list:
    """Điểm gieo dọc bốn mép, lùi vào ``_FLOOD_SEED_INSET`` điểm ảnh."""
    inset = _FLOOD_SEED_INSET
    top, bottom = inset, height - 1 - inset
    left, right = inset, width - 1 - inset
    if top > bottom or left > right:
        return []
    count = _FLOOD_SEEDS_PER_EDGE
    xs = np.unique(np.linspace(left, right, count).round().astype(int))
    ys = np.unique(np.linspace(top, bottom, count).round().astype(int))
    seeds = [(int(x), top) for x in xs] + [(int(x), bottom) for x in xs]
    seeds += [(left, int(y)) for y in ys] + [(right, int(y)) for y in ys]
    return seeds


def _foreground_from_gradient_background(img_rgb: np.ndarray) -> Optional[np.ndarray]:
    """Loang nền từ bốn mép theo dải THÍCH NGHI; trả mask hình (uint8 0/255).

    QUALITY (audit 2026-08-06 §BG.3): dùng cho nền gradient / hoạ tiết mịn, nơi
    nhánh nền phẳng bó tay. So màu theo điểm ảnh KỀ (không đặt
    ``FLOODFILL_FIXED_RANGE``) nên nước đi men theo gradient nhưng khựng ở mép
    artwork. Trả ``None`` khi không tách được — tuyệt đối không đoán tiếp.
    """
    height, width = img_rgb.shape[:2]
    seeds = _edge_seed_points(height, width)
    if not seeds:
        return None

    diff = int(
        np.clip(
            round(_border_gradient_p95(img_rgb)) + _FLOOD_DIFF_PADDING,
            _FLOOD_DIFF_MIN,
            _FLOOD_DIFF_MAX,
        )
    )
    # `floodFill` đòi ảnh liền khối 8-bit 3 kênh; mask lớn hơn ảnh 2 điểm mỗi chiều.
    work = np.ascontiguousarray(img_rgb[:, :, :3], dtype=np.uint8)
    mask = np.zeros((height + 2, width + 2), dtype=np.uint8)
    flags = (
        4  # nối 4-hướng: không rỉ qua góc chéo giữa hai nét mảnh
        | cv2.FLOODFILL_MASK_ONLY
        | (255 << 8)  # giá trị ghi vào mask
    )
    lo = (diff, diff, diff)
    for x, y in seeds:
        # Điểm gieo đã thuộc nền loang trước đó thì bỏ qua, khỏi loang lại.
        if mask[y + 1, x + 1]:
            continue
        cv2.floodFill(work, mask, (x, y), 0, lo, lo, flags)

    background = mask[1:-1, 1:-1] > 0
    if not background.any():
        return None
    return (~background).astype(np.uint8) * 255


def detect_background(img_rgb: np.ndarray) -> Optional[BackgroundInfo]:
    """Dò nền phẳng bất kỳ MÀU GÌ và trả mask hình.

    Trả ``None`` khi: ảnh không hợp lệ, hoặc cả hai nhánh (nền phẳng và nền
    gradient) đều không tách được nền khỏi hình. Caller phải coi ``None`` là
    "chưa dò được" và báo lỗi rõ ràng, KHÔNG được lặng lẽ cắt cả trang.

    Hai nhánh, theo thứ tự tin cậy giảm dần:
    1. **Nền phẳng** — bốn góc đồng màu → so màu tuyệt đối. Chắc chắn nhất.
    2. **Nền gradient / hoạ tiết** (§BG.3) — loang từ bốn mép theo dải thích nghi.
       Đánh dấu ``is_flat=False`` để lớp trên cảnh báo thợ soi lại đường cắt.
    """
    if img_rgb is None or img_rgb.ndim != 3 or img_rgb.shape[2] < 3:
        return None
    height, width = img_rgb.shape[:2]
    if height < 4 or width < 4:
        return None

    corners = _corner_samples(img_rgb)
    background_rgb = np.median(corners, axis=0)
    corner_p95 = float(
        np.percentile(np.max(np.abs(corners - background_rgb), axis=1), 95)
    )
    color = tuple(int(round(float(c))) for c in background_rgb)

    if corner_p95 <= _CORNER_UNIFORM_P95_MAX:
        tolerance = int(
            np.clip(
                round(corner_p95) + _TOLERANCE_PADDING,
                _TOLERANCE_MIN,
                _TOLERANCE_MAX,
            )
        )
        foreground = _foreground_from_flat_background(
            img_rgb[:, :, :3].astype(np.int16), background_rgb, tolerance
        )
        if foreground is not None and mask_tach_duoc_nen(foreground):
            confidence = float(
                np.clip(
                    1.0 - corner_p95 / _CORNER_UNIFORM_P95_MAX,
                    _CONFIDENCE_FLOOR,
                    1.0,
                )
            )
            return BackgroundInfo(
                color=color,  # type: ignore[arg-type]
                tolerance=tolerance,
                foreground_mask=foreground,
                confidence=confidence,
                is_near_white=min(color) >= 240,
                is_flat=True,
                corner_p95=corner_p95,
            )

    # QUALITY (audit 2026-08-06 §BG.3): nền không phẳng (gradient/hoạ tiết), hoặc
    # phẳng nhưng so màu tuyệt đối không tách được → loang theo dải thích nghi.
    foreground = _foreground_from_gradient_background(img_rgb)
    if foreground is None or not mask_tach_duoc_nen(foreground):
        return None
    return BackgroundInfo(
        color=color,  # type: ignore[arg-type]
        tolerance=0,  # nhánh loang không dùng dung sai tuyệt đối
        foreground_mask=foreground,
        confidence=_FLOOD_CONFIDENCE,
        is_near_white=False,
        is_flat=False,
        corner_p95=corner_p95,
    )
