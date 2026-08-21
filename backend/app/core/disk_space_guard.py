"""Chốt dung lượng trống dùng chung cho các job tạo PDF lớn.

Mỗi job khai báo hai đỉnh sử dụng tuần tự: thư mục tạm và thư mục output. Nếu
chúng nằm trên cùng volume, chỉ lấy đỉnh lớn hơn; nếu khác volume, kiểm riêng
từng ổ. Helper chỉ từ chối khi đọc được trạng thái đĩa và chắc chắn không đủ.
"""

from __future__ import annotations

from dataclasses import dataclass
import logging
import os
import shutil


logger = logging.getLogger(__name__)

MIB = 1024 * 1024
GIB = 1024 * MIB
_MIN_AUTO_RESERVE_BYTES = 2 * GIB
_MAX_AUTO_RESERVE_BYTES = 20 * GIB
_MIN_ESTIMATE_BYTES = 64 * MIB

# PERF (audit 2026-08-13 §PB-1): hệ số artifact Compare đo từ benchmark P-B
# (BAO_CAO_AUDIT_COMPARE_P_B_TAI_LIEU_DAI_2026-08-13.md mục 5): PNG diff + GIF
# mỗi trang khác biệt ~0,25 B/pixel @300 DPI, nhân biên an toàn 1,5. Trang DPI
# thấp nén kém hiệu quả hơn theo pixel nên chặn thêm floor 2 MiB/trang — mức
# floor này dư ~1,5× so với số đo 1,33 MiB/trang @150 DPI.
_COMPARE_BYTES_PER_PIXEL = 0.25 * 1.5
_COMPARE_MIN_BYTES_PER_PAGE = 2 * MIB


@dataclass(frozen=True, slots=True)
class JobDiskEstimate:
    """Dung lượng cực đại theo hai giai đoạn tuần tự của một job."""

    temp_bytes: int
    output_bytes: int


class InsufficientDiskSpaceError(ValueError):
    """Ổ đĩa đọc được nhưng không đủ cho job và phần dung lượng dự phòng."""


def estimate_nup_disk(*, source_bytes: int, total_sheets: int) -> JobDiskEstimate:
    """Ước lượng đỉnh đĩa N-Up theo file nguồn và số tờ kết quả."""
    source = max(0, int(source_bytes or 0))
    sheets = max(1, int(total_sheets or 0))
    rendered_bytes = max(
        _MIN_ESTIMATE_BYTES,
        # Không nhân file nguồn với mọi chunk: PDF nhiều trang tuần tự thường chỉ
        # mang tài nguyên tương ứng, nhân mù sẽ chặn nhầm các job hoàn toàn hợp lệ.
        source * 2 + sheets * 256 * 1024,
    )
    return JobDiskEstimate(
        temp_bytes=rendered_bytes,
        # Output có lúc tồn tại đồng thời với bản ghi atomic hậu xử lý.
        output_bytes=rendered_bytes * 2,
    )


def estimate_vdp_disk(
    *,
    template_bytes: int,
    record_count: int,
    chunk_count: int,
    variable_image_bytes: int,
) -> JobDiskEstimate:
    """Ước lượng đỉnh đĩa VDP, kể cả ảnh biến đổi của từng record."""
    template = max(0, int(template_bytes or 0))
    records = max(0, int(record_count or 0))
    chunks = max(1, int(chunk_count or 0))
    images = max(0, int(variable_image_bytes or 0))
    rendered_bytes = max(
        _MIN_ESTIMATE_BYTES,
        template * chunks + records * 128 * 1024 + images * 2,
    )
    return JobDiskEstimate(
        # Có thể có thêm một bản canonical của template trong thư mục tạm.
        temp_bytes=rendered_bytes + template,
        output_bytes=rendered_bytes * 2,
    )


def estimate_compare_disk(
    *,
    total_render_pixels: int,
    page_count: int,
    max_page_pixels: int = 0,
) -> JobDiskEstimate:
    """Ước lượng đỉnh đĩa artifact của một job Compare (PNG diff + GIF).

    PERF (audit 2026-08-13 §PB-1): giả định XẤU NHẤT mọi trang đều khác biệt —
    Artifact ghi thẳng ``RESULTS_DIR/<job_id>``. Riêng comparator tile dùng thêm
    một mask uint8 disk-backed ở TEMP; caller truyền ``max_page_pixels`` để admission
    volume staging. Ước lượng dư không gây hại: guard chỉ từ chối khi volume chắc
    chắn thiếu cả reserve.
    """
    pages = max(1, int(page_count or 0))
    pixels = max(0, int(total_render_pixels or 0))
    output = max(
        _MIN_ESTIMATE_BYTES,
        pages * _COMPARE_MIN_BYTES_PER_PAGE,
        int(pixels * _COMPARE_BYTES_PER_PIXEL),
    )
    # PERF (audit 2026-08-19 §CL.3): comparator tile giữ mask uint8 disk-backed
    # của đúng một trang. Admission phần staging riêng để volume TEMP cũng được
    # kiểm tra khi khác volume RESULTS_DIR; trang full-frame truyền 0 để giữ cũ.
    temp = max(0, int(max_page_pixels or 0))
    return JobDiskEstimate(temp_bytes=temp, output_bytes=output)


def _nearest_existing_parent(path: str) -> str:
    candidate = os.path.abspath(os.fspath(path))
    while not os.path.exists(candidate):
        parent = os.path.dirname(candidate)
        if parent == candidate:
            break
        candidate = parent
    return candidate


def _volume_identity(path: str) -> tuple[object, str]:
    """Trả khoá volume và thư mục hiện hữu dùng cho ``disk_usage``."""
    parent = _nearest_existing_parent(path)
    try:
        return ("device", os.stat(parent).st_dev), parent
    except OSError:
        drive = os.path.normcase(os.path.splitdrive(parent)[0])
        return ("drive", drive or os.path.normcase(parent)), parent


def minimum_free_disk_bytes(total_bytes: int) -> int:
    """Dung lượng phải chừa lại trên một volume, dùng chung guard và cleanup."""
    raw = os.environ.get("PRYNX_MIN_FREE_DISK_MB")
    if raw is not None:
        try:
            value_mb = int(raw.strip())
            if value_mb < 0 or value_mb > (2**63 - 1) // MIB:
                raise ValueError
            return value_mb * MIB
        except (TypeError, ValueError):
            logger.warning(
                "[DISK-GUARD] PRYNX_MIN_FREE_DISK_MB không hợp lệ (%r); "
                "dùng policy tự động.",
                raw,
            )
    automatic = int(max(0, total_bytes) * 0.02)
    return min(
        _MAX_AUTO_RESERVE_BYTES,
        max(_MIN_AUTO_RESERVE_BYTES, automatic),
    )


def _format_bytes(value: int) -> str:
    amount = max(0, int(value))
    if amount >= GIB:
        return f"{amount / GIB:.2f} GB"
    return f"{amount / MIB:.0f} MB"


def ensure_job_disk_space(
    job_label: str,
    output_path: str,
    temp_path: str,
    estimate: JobDiskEstimate,
) -> None:
    """Từ chối sớm khi chắc chắn volume không đủ cho job.

    PERF (audit 2026-08-05 §PERF.7): không xóa file và không giảm chất lượng.
    Lỗi đọc trạng thái đĩa chỉ ghi cảnh báo rồi cho chạy để tránh false-positive.
    """
    targets = (
        (temp_path, max(0, int(estimate.temp_bytes))),
        (output_path, max(0, int(estimate.output_bytes))),
    )
    volumes: dict[object, dict[str, object]] = {}
    for path, required_bytes in targets:
        try:
            volume_key, usage_path = _volume_identity(path)
        except (OSError, TypeError, ValueError) as error:
            logger.warning(
                "[DISK-GUARD] không xác định được volume cho %s: %s; cho job chạy.",
                path,
                error,
            )
            continue
        current = volumes.get(volume_key)
        if current is None:
            volumes[volume_key] = {
                "path": usage_path,
                "required": required_bytes,
            }
        else:
            # Hai giai đoạn không đồng thời; cùng volume chỉ lấy đỉnh lớn hơn.
            current["required"] = max(int(current["required"]), required_bytes)

    for volume in volumes.values():
        usage_path = os.fspath(volume["path"])
        required_bytes = int(volume["required"])
        try:
            usage = shutil.disk_usage(usage_path)
        except (OSError, TypeError, ValueError) as error:
            logger.warning(
                "[DISK-GUARD] không đọc được dung lượng trống tại %s: %s; "
                "cho job chạy.",
                usage_path,
                error,
            )
            continue
        reserve_bytes = minimum_free_disk_bytes(usage.total)
        needed_bytes = required_bytes + reserve_bytes
        if usage.free >= needed_bytes:
            continue
        raise InsufficientDiskSpaceError(
            f"Không đủ dung lượng đĩa để {job_label}: cần trống ít nhất "
            f"{_format_bytes(needed_bytes)} (dữ liệu công việc "
            f"{_format_bytes(required_bytes)} + dự phòng "
            f"{_format_bytes(reserve_bytes)}), hiện còn "
            f"{_format_bytes(usage.free)}. Hãy giải phóng dung lượng hoặc chia "
            "công việc thành nhiều lượt nhỏ hơn."
        )
