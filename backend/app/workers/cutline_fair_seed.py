"""Tạo nhịp Bézier thưa để bộ làm mượt thả neo tiếp tục tối ưu.

QUALITY (audit 2026-09-10 §FAIR.1): đây chỉ là bộ sinh ứng viên. Dung sai
fit lớn hơn dung sai gia công là chủ đích để mở miền nghiệm; caller phải
refit và kiểm độc lập với nguồn bất biến trước khi nhận vào đường CUT.
Không đọc corpus/thư mục thử và không cần DLL hay bộ trace bitmap.
"""

from __future__ import annotations

import heapq
import math
from collections.abc import Iterable, Sequence

import numpy as np


Point = tuple[float, float]
Cubic = tuple[Point, Point, Point, Point]
Ring = tuple[Cubic, ...]


def _unit(vector: np.ndarray) -> np.ndarray:
    length = float(np.linalg.norm(vector))
    return vector / length if length > 1e-14 else np.zeros(2)


def _evaluate(curve: np.ndarray, parameters: np.ndarray, *, derivatives: bool = True):
    t, u = parameters[:, None], 1.0 - parameters[:, None]
    position = u**3 * curve[0] + 3 * u**2 * t * curve[1] + 3 * u * t**2 * curve[2] + t**3 * curve[3]
    # PERF (audit 2026-09-11 §CUTRUNTIME.CORE): lấy mẫu cung chỉ đọc vị trí;
    # giữ nguyên biểu thức/từng phép tính, không cấp mảng đạo hàm bị bỏ đi.
    if not derivatives:
        return position
    first = 3 * u**2 * (curve[1] - curve[0]) + 6 * u * t * (curve[2] - curve[1]) + 3 * t**2 * (curve[3] - curve[2])
    second = 6 * u * (curve[2] - 2 * curve[1] + curve[0]) + 6 * t * (curve[3] - 2 * curve[2] + curve[1])
    return position, first, second


def _sample_run(curves: np.ndarray, spacing: float) -> np.ndarray:
    """Mẫu đều dọc cung, gồm cả hai đầu; không lấy riêng neo bỏ mất handles."""
    pieces = []
    for curve in curves:
        speed_bound = 3 * float(np.linalg.norm(np.diff(curve, axis=0), axis=1).max())
        steps = max(2, math.ceil(speed_bound / (spacing / 2)))
        t = np.linspace(0, 1, steps, endpoint=False)
        pieces.append(_evaluate(curve, t, derivatives=False))
    dense = np.vstack([*pieces, curves[-1, 3][None, :]])
    lengths = np.linalg.norm(np.diff(dense, axis=0), axis=1)
    dense = dense[np.r_[True, lengths > 1e-14]]
    if len(dense) < 2:
        return dense
    arc = np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(dense, axis=0), axis=1))]
    locations = np.linspace(0, arc[-1], max(2, math.ceil(arc[-1] / spacing) + 1))
    points = np.column_stack([np.interp(locations, arc, dense[:, axis]) for axis in range(2)])
    points[0], points[-1] = curves[0, 0], curves[-1, 3]
    return points


def _fit(points: np.ndarray, left: np.ndarray, right: np.ndarray):
    """Giải hai độ dài tay nắm, rồi cập nhật tham số theo phép chiếu Newton."""
    origin = points[0]
    local = points - origin
    arc = np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(local, axis=0), axis=1))]
    if arc[-1] <= 1e-14:
        return None, math.inf, len(points) // 2
    parameters = arc / arc[-1]
    endpoint = local[-1]
    best = (None, math.inf, len(points) // 2)
    # Chặn hội tụ số học, không cắt chất lượng hay số nhịp theo tài nguyên.
    for _ in range(10):
        t, u = parameters, 1.0 - parameters
        b1, b2, b3 = 3 * u * u * t, 3 * u * t * t, t**3
        matrix = np.column_stack([(b1[:, None] * left).ravel(), (-b2[:, None] * right).ravel()])
        residual = (local - (b2 + b3)[:, None] * endpoint).ravel()
        alpha, beta = np.linalg.lstsq(matrix, residual, rcond=None)[0]
        if min(alpha, beta) <= 1e-12 or max(alpha, beta) > arc[-1]:
            alpha = beta = float(np.linalg.norm(endpoint)) / 3
        curve = np.array([[0.0, 0.0], alpha * left, endpoint - beta * right, endpoint])
        position, first, second = _evaluate(curve, parameters)
        delta = position - local
        errors = np.linalg.norm(delta, axis=1)
        split = int(np.argmax(errors[1:-1])) + 1 if len(points) > 2 else 1
        error = float(errors.max())
        if error < best[1]:
            translated = curve + origin
            translated[0], translated[-1] = points[0], points[-1]
            best = (translated, error, split)
        denominator = np.sum(first * first + delta * second, axis=1)
        correction = np.divide(np.sum(delta * first, axis=1), denominator,
                               out=np.zeros_like(parameters), where=np.abs(denominator) > 1e-16)
        updated = np.clip(parameters - correction, 0.0, 1.0)
        updated[0], updated[-1] = 0.0, 1.0
        if np.any(np.diff(updated) <= 0) or float(np.max(np.abs(updated - parameters))) < 1e-6:
            break
        parameters = updated
    return best


def _fit_run(points: np.ndarray, tolerance: float, left: np.ndarray, right: np.ndarray):
    tangents = np.vstack([left, [_unit(vector) for vector in points[2:] - points[:-2]], right])
    # PERF (audit 2026-09-11 §CUTRUNTIME.CORE): cây chia và hàng đợi gộp có
    # thể hỏi lại cùng một nhịp. Mẫu/hướng nguồn bất biến trong đúng lượt này;
    # dùng lại cả nghiệm bị loại, không đổi thứ tự gộp hay dung sai.
    fitted_ranges = {}

    def fit_range(start, end):
        key = (start, end)
        fitted = fitted_ranges.get(key)
        if fitted is None:
            fitted = _fit(points[start:end + 1], tangents[start], tangents[end])
            fitted_ranges[key] = fitted
        return fitted

    spans = []
    pending = [(0, len(points) - 1)]
    while pending:
        start, end = pending.pop()
        curve, error, split = fit_range(start, end)
        if error <= tolerance or end == start + 1:
            if curve is None:
                return []
            spans.append((start, end, curve))
        else:
            middle = start + split
            pending.extend([(middle, end), (start, middle)])
    if len(spans) < 2:
        return [span[2] for span in spans]

    # Gộp ưu tiên sai số thấp nhưng luôn fit lại trên mẫu nguồn bất biến,
    # không dùng candidate trước làm nguồn và không cộng dồn sai lệch.
    entries = {index: [start, end, curve, index - 1, index + 1, 0]
               for index, (start, end, curve) in enumerate(spans)}
    entries[0][3], entries[len(spans) - 1][4] = None, None
    queue = []

    def propose(index):
        if index is None or index not in entries:
            return
        a = entries[index]
        following = a[4]
        if following is None or following not in entries:
            return
        b = entries[following]
        curve, error, _ = fit_range(a[0], b[1])
        if curve is not None and error <= tolerance:
            heapq.heappush(queue, (error, index, following, a[5], b[5], curve))

    for index in entries:
        propose(index)
    while queue:
        _error, index, following, version_a, version_b, curve = heapq.heappop(queue)
        if index not in entries or following not in entries:
            continue
        a, b = entries[index], entries[following]
        if a[4] != following or a[5] != version_a or b[5] != version_b:
            continue
        a[1], a[2], a[4], a[5] = b[1], curve, b[4], a[5] + 1
        if b[4] is not None:
            entries[b[4]][3] = index
        del entries[following]
        propose(a[3])
        propose(index)
    result, index = [], 0
    while index is not None:
        entry = entries[index]
        result.append(entry[2])
        index = entry[4]
    return result


def _validated(source: Sequence[Cubic], tolerance_mm: float, protected_indices: Iterable[int]):
    try:
        valid_tolerance = math.isfinite(tolerance_mm) and tolerance_mm > 0
    except TypeError:
        valid_tolerance = False
    if not valid_tolerance:
        raise ValueError("Dung sai tạo nhịp phải hữu hạn và lớn hơn 0 mm")
    values = np.asarray(source, dtype=np.float64)
    if values.ndim == 0:
        raise ValueError("Nguồn tạo nhịp phải là chuỗi cubic hữu hạn trong đơn vị mm")
    if not len(values):
        return values, []
    if values.shape != (len(values), 4, 2) or not np.isfinite(values).all():
        raise ValueError("Nguồn tạo nhịp phải là chuỗi cubic hữu hạn trong đơn vị mm")
    if not np.array_equal(values[:, 3], np.roll(values[:, 0], -1, axis=0)):
        raise ValueError("Nguồn tạo nhịp phải liên tục và đóng chính xác")
    cuts = set(protected_indices)
    if any(not isinstance(index, (int, np.integer)) or not 0 <= index < len(values) for index in cuts):
        raise ValueError("Chỉ số góc cần giữ nằm ngoài đường nguồn")
    return values, sorted(cuts)


def fit_seed_ring(source: Sequence[Cubic], fit_tolerance_mm: float, *,
                  protected_indices: Iterable[int] = ()) -> Ring:
    """Tạo một seed đóng; giữ tọa độ và hai hướng tại góc được caller khóa.

    ``protected_indices`` là chỉ số đầu cubic nguồn. Những vị trí này chia
    ring thành các run mở độc lập, nên không có phép gộp nối tắt qua góc.
    Những neo khác là điểm khởi tạo, không phải ràng buộc solver downstream.
    Không có đảm bảo sai số liên tục, topology hay độ cong ở tầng seed.
    """
    values, cuts = _validated(source, fit_tolerance_mm, protected_indices)
    if not len(values):
        return ()
    origin = values[0, 0].copy()
    local = values - origin
    # Khoảng mẫu là thông số hình học theo mm, không phải cap tài nguyên.
    spacing = min(fit_tolerance_mm / 6, 0.03)
    if not cuts:
        cuts = [0]
    result, run_boundaries = [], []
    for cut_index, start in enumerate(cuts):
        end = cuts[(cut_index + 1) % len(cuts)]
        run = local[start:end] if end > start else np.concatenate([local[start:], local[:end]])
        points = _sample_run(run, spacing)
        if len(points) < 2:
            return tuple(tuple(tuple(point) for point in curve) for curve in values)
        incoming, outgoing = _unit(run[-1, 3] - run[-1, 2]), _unit(run[0, 1] - run[0, 0])
        if np.linalg.norm(incoming) < 0.5:
            incoming = _unit(points[-1] - points[-2])
        if np.linalg.norm(outgoing) < 0.5:
            outgoing = _unit(points[1] - points[0])
        if np.array_equal(points[0], points[-1]):
            # Không fit cả vòng bằng một cubic có chord bằng 0. Seam kỹ
            # thuật dùng tangent chung, nhưng vẫn không được khóa ở solver.
            middle = int(np.argmax(np.linalg.norm(points - points[0], axis=1)))
            shared = _unit(points[middle + 1] - points[middle - 1])
            fitted = [*_fit_run(points[:middle + 1], fit_tolerance_mm, outgoing, shared),
                      *_fit_run(points[middle:], fit_tolerance_mm, shared, incoming)]
        else:
            fitted = _fit_run(points, fit_tolerance_mm, outgoing, incoming)
        if not fitted:
            return tuple(tuple(tuple(point) for point in curve) for curve in values)
        run_boundaries.append((len(result), len(result) + len(fitted) - 1, start, end))
        result.extend(fitted)
    translated = np.asarray(result) + origin
    for first, last, start, end in run_boundaries:
        # Phép dịch gốc có thể làm trôi vài ulp; góc khóa phải đúng bit với
        # nguồn để caller nhận lại vị trí, không chỉ so gần đúng theo ε.
        translated[first, 0] = values[start, 0]
        translated[last, 3] = values[end, 0]
    return tuple(tuple(tuple(float(value) for value in point) for point in curve) for curve in translated)


def build_fair_seeds(source: Sequence[Cubic], tolerance_mm: float, *,
                     protected_indices: Iterable[int] = ()) -> tuple[Ring, ...]:
    """Ưu tiên seed 1,1×, rồi 1× và 1,25× dung sai; chưa dùng để cắt.

    Lựa chọn vừa thưa trước, dự phòng seed gần nguồn hơn. Seed quá thưa
    không tự là ưu điểm: probe Binder2 2×/3× mất thêm thời gian refit nhưng
    khó qua chốt sai lệch/độ cong, nên không thử mặc định các mức đó.
    """
    values, cuts = _validated(source, tolerance_mm, protected_indices)
    if not len(values):
        return ()
    candidates = []
    for multiplier in (1.1, 1.0, 1.25):
        candidate = fit_seed_ring(values, tolerance_mm * multiplier, protected_indices=cuts)
        if 2 <= len(candidate) < len(values) and candidate not in candidates:
            candidates.append(candidate)
    return tuple(candidates)
