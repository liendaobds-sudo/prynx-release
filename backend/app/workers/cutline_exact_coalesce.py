"""Hoàn nguyên các phép chia cubic dư, giữ điểm bắt đầu và nguồn bất biến."""

from __future__ import annotations

import math

from app.workers.cutline_polyline_reduction import split_cubic
from app.workers.cutline_preview_cancel import check_preview_cancelled


def _restore(first, second):
    if first[-1] != second[0]:
        return None
    before = tuple(a-b for a, b in zip(first[3], first[2]))
    after = tuple(a-b for a, b in zip(second[1], second[0]))
    a, b = math.hypot(*before), math.hypot(*after)
    if min(a, b) <= 1e-15:
        return None
    parameter = a / (a+b)
    if not 1e-12 < parameter < 1.-1e-12:
        return None
    candidate = (first[0],
                 tuple(p+(q-p)/parameter for p, q in zip(first[0], first[1])),
                 tuple(p+(q-p)/(1.-parameter) for p, q in zip(second[3], second[2])),
                 second[3])
    if not all(math.isfinite(v) for point in candidate for v in point):
        return None
    left, right = split_cubic(candidate, parameter)
    error = max(math.dist(actual, expected) for actual, expected in
                zip((*left, *right), (*first, *second)))
    scale = max(1., *(abs(v) for curve in (first, second, candidate) for point in curve for v in point))
    # QUALITY (audit 2026-09-24 §CUT24.03): chỉ nhận sai số số học của phép
    # chia ngược; không dùng dung sai gia công để vô tình nối qua góc thật.
    # Convex-hull của hiệu control points chặn mọi điểm, không chỉ neo/mẫu.
    slack = 128. * math.ulp(scale)
    if error > slack:
        return None
    return candidate, math.nextafter(error + slack, math.inf)


def coalesce_exact_subdivisions(source):
    """Trả cubic thưa và cận hai chiều so với nguồn; không gộp xuyên seam.

    Stack ghép lại cả cặp mới hình thành, nên không phụ thuộc phase chia đôi.
    Cận mỗi lần là hiệu control hull, cộng cận nhánh con; caller trừ phần
    này khỏi budget còn lại và vẫn kiểm topology/độ cong sau writer.
    """
    spans = []
    for curve in source:
        check_preview_cancelled()
        spans.append((curve, 0.))
        while len(spans) > 1:
            merged = _restore(spans[-2][0], spans[-1][0])
            if merged is None:
                break
            candidate, error = merged
            bound = error + max(spans[-2][1], spans[-1][1])
            spans[-2:] = [(candidate, bound)]
    return tuple(curve for curve, _ in spans), max((bound for _, bound in spans), default=0.)
