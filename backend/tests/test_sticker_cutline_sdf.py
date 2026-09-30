"""Unit tests cho Signed Distance Field (SDF) module trong Live Cutline Preview."""

import time
import numpy as np
import pytest

from app.workers.sticker_cutline_sdf import (
    compute_signed_distance_field,
    query_sdf_offset_mask,
    query_sdf_fast_contours,
    InstanceDistanceFieldCache,
)


def test_sdf_circle_distances():
    """Kiểm tra độ chính xác của SDF trên hình tròn chuẩn."""
    size = 100
    mask = np.zeros((size, size), dtype=np.uint8)
    center = (50, 50)
    radius_px = 25
    px_per_mm = 10.0  # 10 px = 1 mm

    y, x = np.ogrid[:size, :size]
    dist_from_center = np.sqrt((x - center[0]) ** 2 + (y - center[1]) ** 2)
    mask[dist_from_center <= radius_px] = 255

    sdf_mm = compute_signed_distance_field(mask, px_per_mm=px_per_mm)

    assert sdf_mm.shape == (size, size)
    # Tại tâm: khoảng cách tới mép xấp xỉ 25px = 2.5 mm
    center_val = sdf_mm[center[1], center[0]]
    assert 2.3 <= center_val <= 2.7, f"Tâm hình tròn phải có SDF ~2.5mm, thực tế: {center_val}"

    # Tại điểm ngoài cách tâm 35px: SDF âm, ~ -10px = -1.0 mm
    outer_val = sdf_mm[50, 85]
    assert -1.2 <= outer_val <= -0.8, f"Điểm ngoài phải có SDF ~ -1.0mm, thực tế: {outer_val}"


def test_sdf_offset_expansion_and_shrinkage():
    """Kiểm tra query_sdf_offset_mask co giãn chính xác theo offset_mm."""
    size = 100
    mask = np.zeros((size, size), dtype=np.uint8)
    mask[25:75, 25:75] = 255  # Vuông 50x50 px
    px_per_mm = 10.0

    sdf_mm = compute_signed_distance_field(mask, px_per_mm=px_per_mm)

    orig_count = np.count_nonzero(mask)
    # Nở thêm 0.5 mm (+5 px mỗi phía)
    dilated_mask = query_sdf_offset_mask(sdf_mm, offset_mm=0.5)
    dilated_count = np.count_nonzero(dilated_mask)
    assert dilated_count > orig_count, "Offset dương phải làm tăng diện tích mask"

    # Co lại 0.5 mm (-5 px mỗi phía)
    eroded_mask = query_sdf_offset_mask(sdf_mm, offset_mm=-0.5)
    eroded_count = np.count_nonzero(eroded_mask)
    assert eroded_count < orig_count, "Offset âm phải làm giảm diện tích mask"


def test_sdf_query_speed_benchmark():
    """Kiểm chứng trần công nghệ: truy vấn SDF đạt tốc độ siêu tốc (< 1.0 ms)."""
    # Ảnh kích thước chuẩn tem 1000x1000
    size = 1000
    mask = np.zeros((size, size), dtype=np.uint8)
    mask[200:800, 200:800] = 255
    px_per_mm = 11.81  # 300 DPI

    sdf_mm = compute_signed_distance_field(mask, px_per_mm=px_per_mm)

    # Đo thời gian truy vấn threshold
    trials = 50
    start = time.perf_counter()
    for i in range(trials):
        _ = query_sdf_offset_mask(sdf_mm, offset_mm=(i % 10) * 0.2 - 1.0)
    total_time = time.perf_counter() - start
    avg_ms = (total_time / trials) * 1000.0

    print(f"\n[BENCHMARK] SDF Query trung bình: {avg_ms:.3f} ms trên ảnh 1000x1000")
    # Phải đạt tốc độ dưới 1.0 ms
    assert avg_ms < 1.0, f"SDF Query quá chậm: {avg_ms:.3f} ms"


def test_sdf_fast_contours():
    """Kiểm tra trích xuất contour nhanh từ SDF."""
    size = 100
    mask = np.zeros((size, size), dtype=np.uint8)
    mask[20:80, 20:80] = 255
    sdf_mm = compute_signed_distance_field(mask, px_per_mm=10.0)

    contours = query_sdf_fast_contours(sdf_mm, offset_mm=0.0)
    assert len(contours) >= 1
    # Contour xấp xỉ chu vi hình vuông
    pts = contours[0]
    assert len(pts) >= 4


def test_sdf_cache_lru():
    """Kiểm tra hoạt động của InstanceDistanceFieldCache."""
    cache = InstanceDistanceFieldCache(max_entries=3)
    dummy = np.zeros((10, 10), dtype=np.float32)

    cache.put("k1", dummy)
    cache.put("k2", dummy)
    cache.put("k3", dummy)
    assert cache.get("k1") is not None

    # Thêm k4 làm đầy bộ nhớ, k1 bị xóa (FIFO/LRU)
    cache.put("k4", dummy)
    assert cache.get("k1") is None
    assert cache.get("k4") is not None
