"""
cutline_geometry.py
====================
Hàm hình học thuần cho đường cắt (CutContour) của tính năng Tạo viền bế.

Tách riêng khỏi sticker_engine.py để:
  - Không phụ thuộc cv2/pdfium/shapely → unit test nhanh, không cần deps nặng.
  - Tập trung logic dễ sai nhất (vẽ contour theo kiểu góc) vào một chỗ.

Quy ước toạ độ: đầu vào theo gốc top-left (y tăng xuống — như ảnh raster),
xuất ra chuỗi lệnh PDF theo gốc bottom-left (y tăng lên) bằng phép lật
y_pdf = page_h - y.
"""
import math


def _catmull_rom_bezier_segments(coords, tension=0.33):
    """Trả các đoạn Bézier Catmull–Rom trong hệ tọa độ hình học gốc."""
    if len(coords) < 3:
        return []
    pts = coords[:-1]
    n = len(pts)
    segments = []
    for i in range(n):
        p_prev = pts[(i - 1) % n]
        p_curr = pts[i]
        p_next = pts[(i + 1) % n]
        p_next2 = pts[(i + 2) % n]

        seg_len = math.hypot(p_next[0] - p_curr[0], p_next[1] - p_curr[1])
        dx1 = p_next[0] - p_prev[0]
        dy1 = p_next[1] - p_prev[1]
        len1 = math.hypot(dx1, dy1) or 1.0
        dx2 = p_next2[0] - p_curr[0]
        dy2 = p_next2[1] - p_curr[1]
        len2 = math.hypot(dx2, dy2) or 1.0

        cp1 = (
            p_curr[0] + (dx1 / len1) * (seg_len * tension),
            p_curr[1] + (dy1 / len1) * (seg_len * tension),
        )
        cp2 = (
            p_next[0] - (dx2 / len2) * (seg_len * tension),
            p_next[1] - (dy2 / len2) * (seg_len * tension),
        )
        segments.append((p_curr, cp1, cp2, p_next))
    return segments


def _sample_catmull_rom_ring(coords, tension=0.33, samples_per_segment=8):
    """Lấy mẫu đường cong kín để tầng engine kiểm sai lệch trước khi xuất PDF."""
    samples_per_segment = max(2, int(samples_per_segment))
    sampled = []
    for p0, cp1, cp2, p3 in _catmull_rom_bezier_segments(coords, tension):
        for sample_index in range(samples_per_segment):
            t = sample_index / samples_per_segment
            u = 1.0 - t
            sampled.append((
                u ** 3 * p0[0]
                + 3.0 * u * u * t * cp1[0]
                + 3.0 * u * t * t * cp2[0]
                + t ** 3 * p3[0],
                u ** 3 * p0[1]
                + 3.0 * u * u * t * cp1[1]
                + 3.0 * u * t * t * cp2[1]
                + t ** 3 * p3[1],
            ))
    if sampled:
        sampled.append(sampled[0])
    return sampled


def _catmull_rom_chord_deviation_bound(coords, tension=0.33):
    """Chặn trên sai lệch đường cong ↔ polyline, hoặc ``None`` nếu bị quay đầu.

    Bézier luôn nằm trong convex hull của bốn control point. Khi hình chiếu của
    hai control point tăng đơn điệu dọc chord, mỗi điểm trên chord có một điểm
    tương ứng trên cubic; khoảng cách Hausdorff vì thế không vượt quá độ lệch
    vuông góc lớn nhất của control point. Phép kiểm O(n) này dùng cho guard Alpha.
    """
    maximum = 0.0
    for p0, cp1, cp2, p3 in _catmull_rom_bezier_segments(coords, tension):
        dx = p3[0] - p0[0]
        dy = p3[1] - p0[1]
        length = math.hypot(dx, dy)
        if length <= 1e-12:
            return None
        ux = dx / length
        uy = dy / length

        projection1 = (cp1[0] - p0[0]) * ux + (cp1[1] - p0[1]) * uy
        projection2 = (cp2[0] - p0[0]) * ux + (cp2[1] - p0[1]) * uy
        if not (-1e-9 <= projection1 <= projection2 + 1e-9 <= length + 1e-9):
            return None

        deviation1 = abs(dx * (cp1[1] - p0[1]) - dy * (cp1[0] - p0[0])) / length
        deviation2 = abs(dx * (cp2[1] - p0[1]) - dy * (cp2[0] - p0[0])) / length
        maximum = max(maximum, deviation1, deviation2)
    return maximum


def _vec_add(a, b):
    return a[0] + b[0], a[1] + b[1]


def _vec_sub(a, b):
    return a[0] - b[0], a[1] - b[1]


def _vec_scale(vector, scalar):
    return vector[0] * scalar, vector[1] * scalar


def _vec_dot(a, b):
    return a[0] * b[0] + a[1] * b[1]


def _vec_length(vector):
    return math.hypot(vector[0], vector[1])


def _vec_normalize(vector):
    length = _vec_length(vector)
    return (vector[0] / length, vector[1] / length) if length > 1e-12 else (0.0, 0.0)


def _bezier_point(control_points, t):
    """Đánh giá Bézier bậc 1–3 bằng de Casteljau."""
    work = [(float(point[0]), float(point[1])) for point in control_points]
    while len(work) > 1:
        work = [
            (
                work[index][0] * (1.0 - t) + work[index + 1][0] * t,
                work[index][1] * (1.0 - t) + work[index + 1][1] * t,
            )
            for index in range(len(work) - 1)
        ]
    return work[0]


def _bezier_derivative(control_points):
    degree = len(control_points) - 1
    return [
        _vec_scale(_vec_sub(control_points[index + 1], control_points[index]), degree)
        for index in range(degree)
    ]


def _chord_length_parameters(points):
    parameters = [0.0]
    for index in range(1, len(points)):
        parameters.append(
            parameters[-1] + _vec_length(_vec_sub(points[index], points[index - 1]))
        )
    total = parameters[-1]
    if total <= 1e-12:
        return [index / max(1, len(points) - 1) for index in range(len(points))]
    return [value / total for value in parameters]


def _generate_fitted_bezier(
    points,
    parameters,
    left_tangent,
    right_tangent,
    *,
    enforce_monotonic=True,
):
    p0 = points[0]
    p3 = points[-1]
    c00 = c01 = c11 = x0 = x1 = 0.0
    for point, parameter in zip(points, parameters):
        u = 1.0 - parameter
        b0 = u ** 3
        b1 = 3.0 * parameter * u * u
        b2 = 3.0 * parameter * parameter * u
        b3 = parameter ** 3
        a0 = _vec_scale(left_tangent, b1)
        a1 = _vec_scale(right_tangent, b2)
        fixed = _vec_add(_vec_scale(p0, b0 + b1), _vec_scale(p3, b2 + b3))
        residual = _vec_sub(point, fixed)
        c00 += _vec_dot(a0, a0)
        c01 += _vec_dot(a0, a1)
        c11 += _vec_dot(a1, a1)
        x0 += _vec_dot(a0, residual)
        x1 += _vec_dot(a1, residual)

    determinant = c00 * c11 - c01 * c01
    if abs(determinant) > 1e-12:
        alpha_left = (x0 * c11 - x1 * c01) / determinant
        alpha_right = (c00 * x1 - c01 * x0) / determinant
    else:
        alpha_left = alpha_right = 0.0

    chord = _vec_length(_vec_sub(p3, p0))
    epsilon = 1e-6 * chord
    if alpha_left < epsilon or alpha_right < epsilon:
        alpha_left = alpha_right = chord / 3.0
    # QUALITY (audit 2026-08-04 §ALPHA.2): contour raster có các cụm điểm gần
    # suy biến làm nghiệm bình phương tối thiểu phóng tay nắm dài hơn cả chord.
    # Cubic khi đó tự vòng/cắt nhau dù sai số tại các điểm mẫu vẫn nhỏ. Giới hạn
    # mỗi tay nắm bằng chord buộc fitter chia thêm đúng nơi cần, nhưng vẫn giảm
    # node mạnh và tránh phải fallback cả contour chỉ vì một đoạn bị loop.
    alpha_left = min(alpha_left, chord)
    alpha_right = min(alpha_right, chord)
    control1 = _vec_add(p0, _vec_scale(left_tangent, alpha_left))
    control2 = _vec_add(p3, _vec_scale(right_tangent, alpha_right))

    if enforce_monotonic and chord > 1e-12:
        chord_unit = _vec_scale(_vec_sub(p3, p0), 1.0 / chord)
        projection1 = _vec_dot(_vec_sub(control1, p0), chord_unit)
        projection2 = _vec_dot(_vec_sub(control2, p0), chord_unit)
        if not (-1e-9 <= projection1 <= projection2 + 1e-9 <= chord + 1e-9):
            # QUALITY (audit 2026-08-04 §ALPHA.2): tay nắm quay ngược theo
            # hướng chord tạo loop cục bộ. Đặt đoạn này về tay nắm thẳng; vòng
            # đệ quy sẽ tự chia thêm đến khi vẫn đạt sai số hình học yêu cầu.
            control1 = _vec_add(p0, _vec_scale(chord_unit, chord / 3.0))
            control2 = _vec_add(p0, _vec_scale(chord_unit, 2.0 * chord / 3.0))

    return p0, control1, control2, p3


def _fitted_bezier_max_error(points, segment, parameters):
    split = len(points) // 2
    maximum = -1.0
    for index in range(1, len(points) - 1):
        delta = _vec_sub(_bezier_point(segment, parameters[index]), points[index])
        error = _vec_dot(delta, delta)
        if error > maximum:
            maximum = error
            split = index
    return max(0.0, maximum), split


def _newton_reparameterize(segment, point, parameter):
    first = _bezier_derivative(segment)
    second = _bezier_derivative(first)
    curve_point = _bezier_point(segment, parameter)
    first_point = _bezier_point(first, parameter)
    second_point = _bezier_point(second, parameter)
    delta = _vec_sub(curve_point, point)
    denominator = _vec_dot(first_point, first_point) + _vec_dot(delta, second_point)
    if abs(denominator) <= 1e-12:
        return parameter
    updated = parameter - _vec_dot(delta, first_point) / denominator
    return max(0.0, min(1.0, updated))


def _open_chain_samples(points, index, direction, distance):
    """Lấy dải điểm trên chuỗi mở trong một khoảng cung cho trước."""
    current = index
    walked = 0.0
    samples = [points[current]]
    while 0 <= current + direction < len(points):
        nxt = current + direction
        walked += _vec_length(_vec_sub(points[nxt], points[current]))
        current = nxt
        samples.append(points[current])
        if walked >= distance:
            break
    return samples


def _principal_chain_direction(samples, preferred_direction):
    """Ước lượng hướng tiếp tuyến bằng trục chính để khử nhiễu một cạnh pixel."""
    preferred = _vec_normalize(preferred_direction)
    if len(samples) < 3:
        return preferred
    center = (
        sum(point[0] for point in samples) / len(samples),
        sum(point[1] for point in samples) / len(samples),
    )
    xx = yy = xy = 0.0
    for point in samples:
        dx = point[0] - center[0]
        dy = point[1] - center[1]
        xx += dx * dx
        yy += dy * dy
        xy += dx * dy
    if xx + yy <= 1e-12:
        return preferred
    angle = 0.5 * math.atan2(2.0 * xy, xx - yy)
    direction = (math.cos(angle), math.sin(angle))
    if _vec_dot(direction, preferred) < 0:
        direction = _vec_scale(direction, -1.0)
    return direction


def _open_chain_endpoint_tangent(points, index, direction, distance):
    samples = _open_chain_samples(points, index, direction, distance)
    return _principal_chain_direction(
        samples,
        _vec_sub(samples[-1], samples[0]),
    )


def _open_chain_center_tangent(points, index, distance):
    before = _open_chain_samples(points, index, -1, distance)
    after = _open_chain_samples(points, index, 1, distance)
    samples = before[1:] + after
    return _principal_chain_direction(
        samples,
        _vec_sub(before[-1], after[-1]),
    )


def _fit_open_cubic(
    points,
    left_tangent,
    right_tangent,
    error_sq,
    output,
    depth=0,
    *,
    enforce_monotonic=True,
    tangent_window=0.0,
):
    if len(points) == 2:
        distance = _vec_length(_vec_sub(points[1], points[0])) / 3.0
        output.append((
            points[0],
            _vec_add(points[0], _vec_scale(left_tangent, distance)),
            _vec_add(points[1], _vec_scale(right_tangent, distance)),
            points[1],
        ))
        return
    if depth > 64:
        # Fail-safe: chia đôi thay vì để contour bất thường làm tràn recursion.
        split = len(points) // 2
    else:
        parameters = _chord_length_parameters(points)
        segment = _generate_fitted_bezier(
            points,
            parameters,
            left_tangent,
            right_tangent,
            enforce_monotonic=enforce_monotonic,
        )
        maximum, split = _fitted_bezier_max_error(points, segment, parameters)
        if maximum <= error_sq:
            output.append(segment)
            return
        if maximum <= error_sq * 4.0:
            for _ in range(4):
                parameters = [
                    _newton_reparameterize(segment, point, parameter)
                    for point, parameter in zip(points, parameters)
                ]
                segment = _generate_fitted_bezier(
                    points,
                    parameters,
                    left_tangent,
                    right_tangent,
                    enforce_monotonic=enforce_monotonic,
                )
                maximum, split = _fitted_bezier_max_error(
                    points, segment, parameters
                )
                if maximum <= error_sq:
                    output.append(segment)
                    return

    split = max(1, min(len(points) - 2, split))
    if tangent_window > 0:
        center_tangent = _open_chain_center_tangent(
            points,
            split,
            tangent_window,
        )
    else:
        center_tangent = _vec_normalize(
            _vec_sub(points[split - 1], points[split + 1])
        )
    if center_tangent == (0.0, 0.0):
        center_tangent = _vec_normalize(
            _vec_sub(points[split - 1], points[split])
        )
    _fit_open_cubic(
        points[:split + 1],
        left_tangent,
        center_tangent,
        error_sq,
        output,
        depth + 1,
        enforce_monotonic=enforce_monotonic,
        tangent_window=tangent_window,
    )
    _fit_open_cubic(
        points[split:],
        _vec_scale(center_tangent, -1.0),
        right_tangent,
        error_sq,
        output,
        depth + 1,
        enforce_monotonic=enforce_monotonic,
        tangent_window=tangent_window,
    )


def fit_closed_cubic_beziers(
    coords,
    tolerance,
    *,
    enforce_monotonic=True,
    tangent_window=0.0,
):
    """Fit contour kín thành ít cubic hơn, theo thuật toán Schneider có guard ngoài."""
    points = [(float(x), float(y)) for x, y in coords]
    if len(points) > 1 and points[0] == points[-1]:
        points.pop()
    deduplicated = []
    for point in points:
        if not deduplicated or _vec_length(_vec_sub(point, deduplicated[-1])) > 1e-12:
            deduplicated.append(point)
    points = deduplicated
    if len(points) < 3 or tolerance <= 0:
        return []

    start = points[0]
    split = max(
        range(1, len(points)),
        key=lambda index: _vec_dot(_vec_sub(points[index], start), _vec_sub(points[index], start)),
    )
    chains = (
        points[:split + 1],
        points[split:] + [points[0]],
    )
    output = []
    for chain in chains:
        if tangent_window > 0:
            left_tangent = _open_chain_endpoint_tangent(
                chain,
                0,
                1,
                tangent_window,
            )
            right_tangent = _open_chain_endpoint_tangent(
                chain,
                len(chain) - 1,
                -1,
                tangent_window,
            )
        else:
            left_tangent = _vec_normalize(_vec_sub(chain[1], chain[0]))
            right_tangent = _vec_normalize(_vec_sub(chain[-2], chain[-1]))
        _fit_open_cubic(
            chain,
            left_tangent,
            right_tangent,
            tolerance * tolerance,
            output,
            enforce_monotonic=enforce_monotonic,
            tangent_window=tangent_window,
        )
    return output


_ADAPTIVE_CORNER_VALIDATION_SCALES = (2.0, 3.0)
_ADAPTIVE_CORNER_PERSISTENCE_RATIO = 0.50
_ADAPTIVE_TANGENT_MIN_SPAN_RATIO = 5.0


def _closed_ring_corner_indices(
    points,
    *,
    corner_window,
    minimum_turn_degrees,
    minimum_corner_separation,
    validate_persistence=True,
):
    """Tìm đỉnh có chủ đích theo góc quay đo trên một cửa sổ vật lý.

    Cửa sổ theo độ dài cung làm nhiễu bậc pixel tự triệt tiêu, còn đỉnh lồi/lõm
    của ngôi sao hoặc notch vẫn tạo góc quay lớn. Một góc chỉ được khóa khi cùng
    chiều quay còn tồn tại ở hai cửa sổ lớn hơn; nhờ vậy bậc pixel cục bộ không
    trở thành hàng trăm neo giả trên artwork kích thước lớn. Non-maximum
    suppression theo chu vi giữ đúng một neo cho mỗi góc.
    """
    count = len(points)
    if count < 4 or corner_window <= 0:
        return []

    edge_lengths = [
        _vec_length(_vec_sub(points[(index + 1) % count], points[index]))
        for index in range(count)
    ]
    perimeter = sum(edge_lengths)
    if perimeter <= corner_window * 4.0:
        return []

    arc_positions = [0.0]
    for edge_length in edge_lengths[:-1]:
        arc_positions.append(arc_positions[-1] + edge_length)

    def neighbor(index, direction, window):
        walked = 0.0
        current = index
        for _ in range(count - 1):
            nxt = (current + direction) % count
            walked += _vec_length(_vec_sub(points[nxt], points[current]))
            current = nxt
            if walked >= window:
                return points[current]
        return points[current]

    def signed_turn(index, window):
        point = points[index]
        before = neighbor(index, -1, window)
        after = neighbor(index, 1, window)
        incoming = _vec_normalize(_vec_sub(point, before))
        outgoing = _vec_normalize(_vec_sub(after, point))
        if incoming == (0.0, 0.0) or outgoing == (0.0, 0.0):
            return 0.0
        cross = incoming[0] * outgoing[1] - incoming[1] * outgoing[0]
        return math.atan2(cross, _vec_dot(incoming, outgoing))

    # QUALITY (audit 2026-08-05 §AI2.CUT2): góc thật bền qua nhiều thang đo,
    # còn một bậc pixel chỉ quay mạnh ở cửa sổ nhỏ. Giới hạn ở 1/4 chu vi để hai
    # phía của điểm đo không gặp nhau trên contour rất nhỏ.
    validation_windows = []
    if validate_persistence:
        for scale in _ADAPTIVE_CORNER_VALIDATION_SCALES:
            window = min(corner_window * scale, perimeter * 0.25)
            if window >= corner_window * 1.25 and all(
                abs(window - existing) > 1e-9 for existing in validation_windows
            ):
                validation_windows.append(window)

    candidates = []
    threshold = math.radians(float(minimum_turn_degrees))
    persistent_threshold = threshold * _ADAPTIVE_CORNER_PERSISTENCE_RATIO
    for index in range(count):
        fine_turn = signed_turn(index, corner_window)
        if abs(fine_turn) < threshold:
            continue
        score = abs(fine_turn)
        persistent = True
        for window in validation_windows:
            coarse_turn = signed_turn(index, window)
            if (
                fine_turn * coarse_turn <= 0.0
                or abs(coarse_turn) < persistent_threshold
            ):
                persistent = False
                break
            score = min(score, abs(coarse_turn))
        if persistent:
            candidates.append((score, index))

    selected = []
    separation = max(0.0, float(minimum_corner_separation))
    for _turn, index in sorted(candidates, reverse=True):
        position = arc_positions[index]
        if all(
            min(abs(position - other), perimeter - abs(position - other)) >= separation
            for other in selected
        ):
            selected.append(position)

    position_to_index = {position: index for index, position in enumerate(arc_positions)}
    return sorted(position_to_index[position] for position in selected)


def fit_closed_cubic_beziers_adaptive(
    coords,
    tolerance,
    *,
    corner_window,
    minimum_turn_degrees=32.0,
    minimum_corner_separation=None,
    enforce_monotonic=True,
    validate_corner_persistence=True,
    smooth_raster_tangents=True,
):
    """Fit ring theo từng span trơn và giữ neo tại mọi góc lồi/lõm có ý nghĩa.

    Hai span kề nhau dùng tiếp tuyến riêng tại neo, vì vậy đường cong được phép
    gián đoạn tiếp tuyến đúng ở đỉnh nhọn. Nếu ring không có đủ góc rõ ràng, dùng
    bộ fit kín cũ để giữ nguyên hành vi cho contour cong hoàn toàn.
    """
    points = [(float(x), float(y)) for x, y in coords]
    if len(points) > 1 and points[0] == points[-1]:
        points.pop()
    deduplicated = []
    for point in points:
        if not deduplicated or _vec_length(_vec_sub(point, deduplicated[-1])) > 1e-12:
            deduplicated.append(point)
    points = deduplicated
    if len(points) < 3 or tolerance <= 0:
        return []

    separation = (
        float(minimum_corner_separation)
        if minimum_corner_separation is not None
        else float(corner_window)
    )
    perimeter = sum(
        _vec_length(_vec_sub(points[(index + 1) % len(points)], points[index]))
        for index in range(len(points))
    )
    tangent_window = min(
        float(corner_window) * _ADAPTIVE_CORNER_VALIDATION_SCALES[-1],
        perimeter * 0.25,
    )
    corners = _closed_ring_corner_indices(
        points,
        corner_window=float(corner_window),
        minimum_turn_degrees=minimum_turn_degrees,
        minimum_corner_separation=separation,
        validate_persistence=validate_corner_persistence,
    )
    if len(corners) < 2:
        return fit_closed_cubic_beziers(
            points,
            tolerance,
            enforce_monotonic=enforce_monotonic,
            tangent_window=tangent_window if smooth_raster_tangents else 0.0,
        )

    output = []
    count = len(points)
    for corner_offset, start in enumerate(corners):
        end = corners[(corner_offset + 1) % len(corners)]
        if end > start:
            chain = points[start:end + 1]
        else:
            chain = points[start:] + points[:end + 1]
        if len(chain) < 2:
            continue
        chain_length = sum(
            _vec_length(_vec_sub(chain[index + 1], chain[index]))
            for index in range(len(chain) - 1)
        )
        smooth_chain_tangents = (
            smooth_raster_tangents
            and chain_length >= tangent_window * _ADAPTIVE_TANGENT_MIN_SPAN_RATIO
        )
        if smooth_chain_tangents:
            left_tangent = _open_chain_endpoint_tangent(
                chain,
                0,
                1,
                tangent_window,
            )
            right_tangent = _open_chain_endpoint_tangent(
                chain,
                len(chain) - 1,
                -1,
                tangent_window,
            )
        else:
            left_tangent = _vec_normalize(_vec_sub(chain[1], chain[0]))
            right_tangent = _vec_normalize(_vec_sub(chain[-2], chain[-1]))
        _fit_open_cubic(
            chain,
            left_tangent,
            right_tangent,
            tolerance * tolerance,
            output,
            enforce_monotonic=enforce_monotonic,
            tangent_window=tangent_window if smooth_chain_tangents else 0.0,
        )
    return output


def build_corner_locked_catmull_beziers(
    coords,
    *,
    tension,
    corner_window,
    minimum_turn_degrees=32.0,
    minimum_corner_separation=None,
):
    """Làm mượt ring đã simplify nhưng giữ tiếp tuyến độc lập tại góc thật.

    Đường cong vẫn đi qua mọi anchor. Ở node trơn dùng Catmull–Rom; ở góc lồi/lõm
    tay nắm được đặt dọc theo hai cạnh kề nên đỉnh không bị lướt qua hoặc bo cùn.
    """
    points = [(float(x), float(y)) for x, y in coords]
    if len(points) > 1 and points[0] == points[-1]:
        points.pop()
    deduplicated = []
    for point in points:
        if not deduplicated or _vec_length(_vec_sub(point, deduplicated[-1])) > 1e-12:
            deduplicated.append(point)
    points = deduplicated
    if len(points) < 3:
        return []

    separation = (
        float(minimum_corner_separation)
        if minimum_corner_separation is not None
        else float(corner_window)
    )
    corners = _closed_ring_corner_indices(
        points,
        corner_window=float(corner_window),
        minimum_turn_degrees=minimum_turn_degrees,
        minimum_corner_separation=separation,
        # Anchor đã simplify mạnh; giữ cả góc nhỏ còn lại để không làm mất notch.
        validate_persistence=False,
    )
    segments = list(
        _catmull_rom_bezier_segments(points + [points[0]], tension=tension)
    )
    count = len(points)
    for corner in corners:
        previous = (corner - 1) % count
        following = (corner + 1) % count
        incoming_length = _vec_length(_vec_sub(points[corner], points[previous]))
        outgoing_length = _vec_length(_vec_sub(points[following], points[corner]))
        incoming_tangent = _vec_normalize(
            _vec_sub(points[corner], points[previous])
        )
        outgoing_tangent = _vec_normalize(
            _vec_sub(points[following], points[corner])
        )

        incoming_segment = list(segments[previous])
        incoming_segment[2] = _vec_sub(
            points[corner],
            _vec_scale(incoming_tangent, incoming_length * tension),
        )
        segments[previous] = tuple(incoming_segment)

        outgoing_segment = list(segments[corner])
        outgoing_segment[1] = _vec_add(
            points[corner],
            _vec_scale(outgoing_tangent, outgoing_length * tension),
        )
        segments[corner] = tuple(outgoing_segment)
    return segments


def sample_bezier_segments(segments, samples_per_segment=8):
    """Lấy mẫu danh sách cubic kín để kiểm geometry trước khi ghi PDF."""
    samples_per_segment = max(2, int(samples_per_segment))
    sampled = []
    for segment in segments:
        for sample_index in range(samples_per_segment):
            sampled.append(
                _bezier_point(segment, sample_index / samples_per_segment)
            )
    if sampled:
        sampled.append(sampled[0])
    return sampled


def build_bezier_segments_path_stream(segments, page_h):
    """Ghi các cubic đã fit/verify thành path PDF kín."""
    if not segments:
        return []
    first = segments[0][0]
    stream = [f"{first[0]:.4f} {page_h - first[1]:.4f} m"]
    for _p0, cp1, cp2, p3 in segments:
        stream.append(
            f"{cp1[0]:.4f} {page_h - cp1[1]:.4f} "
            f"{cp2[0]:.4f} {page_h - cp2[1]:.4f} "
            f"{p3[0]:.4f} {page_h - p3[1]:.4f} c"
        )
    stream.append("h")
    return stream


def _coords_to_bezier_stream(coords, page_h, tension=0.33):
    """Vẽ contour KÍN bằng đường cong Bézier (Catmull–Rom) — cho góc tròn.

    Tham số tension co giãn vector tiếp tuyến theo độ dài cạnh để tránh tạo
    "thắt nút" khi các điểm thưa/không đều.
    """
    segments = _catmull_rom_bezier_segments(coords, tension)
    if not segments:
        return []
    stream = [f"{segments[0][0][0]:.4f} {page_h - segments[0][0][1]:.4f} m"]
    for _p0, cp1, cp2, p3 in segments:
        stream.append(
            f"{cp1[0]:.4f} {page_h - cp1[1]:.4f} "
            f"{cp2[0]:.4f} {page_h - cp2[1]:.4f} "
            f"{p3[0]:.4f} {page_h - p3[1]:.4f} c"
        )
    stream.append("h")
    return stream


def _coords_to_polyline_stream(coords, page_h):
    """Vẽ contour KÍN bằng các ĐOẠN THẲNG — cho góc vuông/vát (square/bevel).

    KHÔNG làm mượt: giữ đúng đỉnh polygon đã buffer để góc ra đúng như yêu cầu.
    """
    if len(coords) < 3:
        return []
    pts = coords[:-1]
    stream = [f"{pts[0][0]:.4f} {page_h - pts[0][1]:.4f} m"]
    for x, y in pts[1:]:
        stream.append(f"{x:.4f} {page_h - y:.4f} l")
    stream.append("h")
    return stream


def build_contour_path_stream(coords, page_h, corner_style="round", tension=0.33):
    """Chọn cách vẽ contour theo kiểu góc.

    - 'round'/'alpha_smooth' → Bézier mượt; Alpha chỉ dùng sau guard hình học.
    - 'preserve' và các kiểu khác (square/bevel/mitre…) → đường thẳng giữ đúng đỉnh.
    """
    if corner_style in {"round", "alpha_smooth"}:
        return _coords_to_bezier_stream(coords, page_h, tension=tension)
    return _coords_to_polyline_stream(coords, page_h)
