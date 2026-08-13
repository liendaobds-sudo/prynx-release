"""Hồi quy cho chốt dung lượng trước các job PDF nặng."""

from collections import namedtuple

import pytest

from app.core.disk_space_guard import (
    JobDiskEstimate,
    ensure_job_disk_space,
    estimate_compare_disk,
    estimate_nup_disk,
    estimate_vdp_disk,
)
from app.workers.vdp_engine import _estimate_vdp_variable_image_bytes


MIB = 1024 * 1024
GIB = 1024 * MIB
DiskUsage = namedtuple("DiskUsage", "total used free")


def test_nup_estimate_uses_source_margin_and_sheet_count():
    estimate = estimate_nup_disk(source_bytes=100 * MIB, total_sheets=11)

    # Dành 2 lần file nguồn và thêm 256 KiB metadata cho mỗi tờ kết quả.
    expected_rendered = 200 * MIB + 11 * 256 * 1024
    assert estimate.temp_bytes == expected_rendered
    assert estimate.output_bytes == expected_rendered * 2


def test_vdp_estimate_includes_template_records_and_variable_images():
    estimate = estimate_vdp_disk(
        template_bytes=10 * MIB,
        record_count=1_000,
        chunk_count=4,
        variable_image_bytes=100 * MIB,
    )

    expected_rendered = 40 * MIB + 1_000 * 128 * 1024 + 200 * MIB
    assert estimate.temp_bytes == expected_rendered + 10 * MIB
    assert estimate.output_bytes == expected_rendered * 2


def test_compare_estimate_scales_with_pixels_and_keeps_page_floor():
    """PERF (audit 2026-08-13 §PB-1): hệ số 0,25 B/px × biên 1,5; floor 2 MiB/trang."""
    # 250 trang A4 @300 DPI ≈ 8,7 Mpx/trang → nhánh theo pixel thắng floor.
    pixels_a4_300 = 2481 * 3509
    estimate = estimate_compare_disk(
        total_render_pixels=250 * pixels_a4_300, page_count=250
    )
    assert estimate.temp_bytes == 0
    assert estimate.output_bytes == int(250 * pixels_a4_300 * 0.375)

    # 250 trang A4 @150 DPI ≈ 2,2 Mpx/trang → floor 2 MiB/trang thắng.
    pixels_a4_150 = 1241 * 1755
    estimate_low = estimate_compare_disk(
        total_render_pixels=250 * pixels_a4_150, page_count=250
    )
    assert estimate_low.output_bytes == 250 * 2 * MIB

    # Job nhỏ không được ước lượng dưới sàn chung 64 MiB.
    tiny = estimate_compare_disk(total_render_pixels=1000, page_count=1)
    assert tiny.output_bytes == 64 * MIB


def test_vdp_variable_image_estimate_counts_each_embedding(tmp_path):
    image_path = tmp_path / "photo.jpg"
    image_path.write_bytes(b"image-bytes")
    fields = [{
        "type": "image",
        "name": "photo",
        "textContent": "{photo}",
        "imageBaseDir": str(tmp_path),
        "imagePath": None,
        "conditions": None,
        "rules": None,
    }]

    total = _estimate_vdp_variable_image_bytes(
        fields,
        [{"photo": "photo.jpg"}, {"photo": "photo.jpg"}],
    )

    assert total == image_path.stat().st_size * 2


def test_same_volume_uses_peak_phase_instead_of_adding_all_phases(
    tmp_path, monkeypatch,
):
    monkeypatch.setenv("PRYNX_MIN_FREE_DISK_MB", "0")
    monkeypatch.setattr(
        "app.core.disk_space_guard.shutil.disk_usage",
        lambda _path: DiskUsage(100 * GIB, 0, 150 * MIB),
    )

    ensure_job_disk_space(
        "tạo bản bình",
        output_path=str(tmp_path / "result" / "out.pdf"),
        temp_path=str(tmp_path),
        estimate=JobDiskEstimate(temp_bytes=100 * MIB, output_bytes=120 * MIB),
    )


def test_rejects_with_vietnamese_actionable_message(tmp_path, monkeypatch):
    monkeypatch.setenv("PRYNX_MIN_FREE_DISK_MB", "0")
    monkeypatch.setattr(
        "app.core.disk_space_guard.shutil.disk_usage",
        lambda _path: DiskUsage(100 * GIB, 0, 90 * MIB),
    )

    with pytest.raises(ValueError) as error:
        ensure_job_disk_space(
            "tạo dữ liệu biến đổi",
            output_path=str(tmp_path / "out.pdf"),
            temp_path=str(tmp_path),
            estimate=JobDiskEstimate(temp_bytes=80 * MIB, output_bytes=100 * MIB),
        )

    message = str(error.value)
    assert "Không đủ dung lượng đĩa" in message
    assert "tạo dữ liệu biến đổi" in message
    assert "cần trống ít nhất" in message
    assert "hiện còn" in message
    assert "giải phóng dung lượng" in message


def test_env_reserve_is_added_and_zero_disables_it(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "app.core.disk_space_guard.shutil.disk_usage",
        lambda _path: DiskUsage(100 * GIB, 0, 250 * MIB),
    )
    estimate = JobDiskEstimate(temp_bytes=100 * MIB, output_bytes=100 * MIB)

    monkeypatch.setenv("PRYNX_MIN_FREE_DISK_MB", "200")
    with pytest.raises(ValueError):
        ensure_job_disk_space(
            "tạo PDF", str(tmp_path / "out.pdf"), str(tmp_path), estimate,
        )

    monkeypatch.setenv("PRYNX_MIN_FREE_DISK_MB", "0")
    ensure_job_disk_space(
        "tạo PDF", str(tmp_path / "out.pdf"), str(tmp_path), estimate,
    )


def test_distinct_volumes_are_checked_independently(tmp_path, monkeypatch):
    output_parent = tmp_path / "output"
    temp_parent = tmp_path / "temp"
    output_parent.mkdir()
    temp_parent.mkdir()
    monkeypatch.setenv("PRYNX_MIN_FREE_DISK_MB", "0")
    monkeypatch.setattr(
        "app.core.disk_space_guard._volume_identity",
        lambda path: ("output" if "output" in str(path) else "temp", str(path)),
    )

    def fake_usage(path):
        free = 200 * MIB if "output" in str(path) else 50 * MIB
        return DiskUsage(100 * GIB, 0, free)

    monkeypatch.setattr("app.core.disk_space_guard.shutil.disk_usage", fake_usage)

    with pytest.raises(ValueError, match="Không đủ dung lượng đĩa"):
        ensure_job_disk_space(
            "tạo PDF",
            str(output_parent / "out.pdf"),
            str(temp_parent),
            JobDiskEstimate(temp_bytes=60 * MIB, output_bytes=150 * MIB),
        )


def test_disk_status_read_error_fails_open_with_warning(
    tmp_path, monkeypatch, caplog,
):
    monkeypatch.setenv("PRYNX_MIN_FREE_DISK_MB", "0")
    monkeypatch.setattr(
        "app.core.disk_space_guard.shutil.disk_usage",
        lambda _path: (_ for _ in ()).throw(OSError("unavailable")),
    )

    ensure_job_disk_space(
        "tạo PDF",
        str(tmp_path / "nested" / "out.pdf"),
        str(tmp_path),
        JobDiskEstimate(temp_bytes=GIB, output_bytes=GIB),
    )

    assert "không đọc được dung lượng trống" in caplog.text
