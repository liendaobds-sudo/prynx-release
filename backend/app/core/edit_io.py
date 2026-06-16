"""
Edit_IO — tiện ích LƯU kết quả chỉnh sửa ra Working_File MỚI (task 8.1).

Ràng buộc kiến trúc (chốt qua spike chạy thật, đồng bộ với `stream_editor.py`):
- **Đường GHI DUY NHẤT là pikepdf** (`pdf.save(...)`). pikepdf serialize TOÀN
  document nên mọi tài nguyên trang KHÔNG liên quan (XObject / font / colorspace
  / OCG layers) được giữ nguyên một cách tự nhiên (Yêu cầu 10.1, 10.2, 10.3).
  Các `Color_Operators` (`k`/`scn`/`OP`/`/ICCBased`…) chỉ phụ thuộc vào nội dung
  object đã được `stream_editor` sửa đúng-mục-tiêu — module này KHÔNG đụng tới
  bất kỳ resource nào.
- **TUYỆT ĐỐI KHÔNG ghi đè file gốc** người dùng tải lên (Yêu cầu 10.4). Mọi
  thao tác lưu đi ra một path MỚI; nếu path đích trùng file gốc → raise, KHÔNG ghi.
- **KHÔNG dùng PDFium** để ghi (cấm `FPDFPage_GenerateContent` — hủy CMYK/spot).

Quy ước Working_File (tái dùng tiền lệ `preflight.delete-object`):
- Thư mục output: `settings.RESULTS_DIR / "edit_output"` (tạo nếu chưa có).
- Tên file: `{original_stem}_{suffix}_{rand6}.pdf` để không đè bản trước.

Hai tầng API:
- `save_working_file(pdf, output_path, original_path=None)`
      Lưu một `pikepdf.Pdf` ĐANG MỞ (đã được `stream_editor` sửa in-place) ra path
      mới, có guard chống ghi đè gốc.
- `apply_and_save(original_path, mutate_fn, ...)`
      Orchestrator: mở file gốc → gọi `mutate_fn(pdf)` (thường bao bọc các hàm
      `stream_editor.*` áp EditOp) → lưu ra Working_File mới (không đè gốc).

_Requirements: 10.1, 10.2, 10.3, 10.4, 4.1_
"""
from __future__ import annotations

import logging
import os
import uuid
from pathlib import Path
from typing import Callable

import pikepdf

from app.config import settings

logger = logging.getLogger(__name__)

# Thư mục con chứa Working_File của tính năng edit (tái dùng quy ước RESULTS_DIR).
DEFAULT_EDIT_OUTPUT_SUBDIR = "edit_output"


def _same_path(a: str | os.PathLike, b: str | os.PathLike) -> bool:
    """
    True nếu hai path TRỎ tới cùng một file. Dùng `os.path.samefile` khi cả hai
    đã tồn tại (chính xác kể cả symlink/hoa-thường trên Windows), fallback về so
    sánh path đã normalize/realpath khi file đích chưa tồn tại.
    """
    try:
        if os.path.exists(a) and os.path.exists(b):
            return os.path.samefile(a, b)
    except OSError:  # pragma: no cover - hệ thống lạ
        pass
    return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def build_working_file_path(
    original_path: str | os.PathLike,
    original_name: str | None = None,
    *,
    suffix: str = "edited",
    output_subdir: str = DEFAULT_EDIT_OUTPUT_SUBDIR,
) -> Path:
    """
    Dựng đường dẫn Working_File MỚI theo quy ước hiện có của backend.

    Tên = `{stem}_{suffix}_{rand6}.pdf`, trong đó `stem` lấy từ `original_name`
    (tên người dùng tải lên, nếu có) hoặc từ `original_path`. Phần `rand6` ngẫu
    nhiên bảo đảm KHÔNG đè bản lưu trước đó của cùng file gốc (10.4).

    Args:
        original_path:  đường dẫn file gốc (để suy ra stem khi thiếu original_name).
        original_name:  tên gốc người dùng tải lên (ưu tiên dùng để đặt stem).
        suffix:         hậu tố mô tả thao tác (vd. "edited", "moved", "deleted").
        output_subdir:  thư mục con dưới RESULTS_DIR (mặc định "edit_output").

    Returns:
        `Path` tuyệt đối tới Working_File mới (CHƯA ghi; chỉ là đường dẫn dự kiến).
    """
    stem_source = original_name if original_name else os.fspath(original_path)
    stem = Path(stem_source).stem or "document"
    output_dir = Path(settings.RESULTS_DIR) / output_subdir
    output_dir.mkdir(parents=True, exist_ok=True)
    name = f"{stem}_{suffix}_{uuid.uuid4().hex[:6]}.pdf"
    return output_dir / name


def save_working_file(
    pdf: pikepdf.Pdf,
    output_path: str | os.PathLike,
    *,
    original_path: str | os.PathLike | None = None,
) -> str:
    """
    Lưu một `pikepdf.Pdf` ĐANG MỞ ra Working_File MỚI tại `output_path`.

    pikepdf serialize toàn document nên mọi tài nguyên KHÔNG liên quan
    (XObject/font/colorspace/OCG) được giữ nguyên (Yêu cầu 10.1–10.3); chỉ những
    object đã được `stream_editor` sửa đúng-mục-tiêu là khác đi. Hàm này KHÔNG
    chạm bất kỳ resource nào — chỉ ghi ra đĩa qua đường pikepdf (Yêu cầu 4.1).

    GUARD (Yêu cầu 10.4): nếu `output_path` trỏ tới cùng file `original_path`
    (khi cung cấp), raise `ValueError` và KHÔNG ghi — tránh ghi đè file gốc.

    Args:
        pdf:           document pikepdf đang mở (đã áp chỉnh sửa in-place).
        output_path:   đường dẫn Working_File mới cần ghi.
        original_path: (tùy chọn) file gốc để chặn ghi đè.

    Returns:
        Đường dẫn tuyệt đối (str) của Working_File đã ghi.

    Raises:
        ValueError: nếu `output_path` trùng file gốc (10.4).
    """
    out = Path(output_path)

    if original_path is not None and _same_path(out, original_path):
        raise ValueError(
            "TỪ CHỐI ghi đè file gốc do người dùng tải lên (Yêu cầu 10.4): "
            f"output_path trùng original_path ({out}). Hãy lưu ra path MỚI."
        )

    out.parent.mkdir(parents=True, exist_ok=True)

    # Đường GHI DUY NHẤT: pikepdf.save (color-safe). Mặc định là đủ — giữ object
    # stream/xref hợp lý, KHÔNG cần recompress/normalize gì thêm.
    pdf.save(str(out))
    logger.info("Đã lưu Working_File mới: %s", out)
    return str(out)


def apply_and_save(
    original_path: str | os.PathLike,
    mutate_fn: Callable[[pikepdf.Pdf], object] | None = None,
    *,
    original_name: str | None = None,
    suffix: str = "edited",
    output_path: str | os.PathLike | None = None,
    output_subdir: str = DEFAULT_EDIT_OUTPUT_SUBDIR,
) -> tuple[str, object]:
    """
    Orchestrator: mở file gốc → áp chỉnh sửa qua `mutate_fn(pdf)` → LƯU ra
    Working_File MỚI (KHÔNG đè gốc — Yêu cầu 10.4).

    `mutate_fn` là chỗ caller (vd. API route ở task 9) bọc các hàm
    `stream_editor.*` (delete/move/resize/rotate/edit_text/add) áp `EditOp` lên
    `pdf` đang mở. Giá trị trả về của `mutate_fn` (vd. `DeleteResult`,
    `MoveResult`…) được truyền nguyên vẹn ra ngoài để caller dùng.

    Nếu `mutate_fn` là None → chỉ Round_Trip mở→lưu (hữu ích để kiểm Yêu cầu
    10.2: trang không sửa vẫn tương đương qua Round_Trip).

    Args:
        original_path:  đường dẫn file gốc người dùng tải lên (CHỈ ĐỌC).
        mutate_fn:      callable nhận `pikepdf.Pdf` và áp chỉnh sửa in-place.
        original_name:  tên gốc (đặt tên Working_File đẹp hơn).
        suffix:         hậu tố tên Working_File.
        output_path:    nếu cung cấp, ghi đúng path này (vẫn chặn trùng gốc);
                        nếu None → tự dựng theo `build_working_file_path`.
        output_subdir:  thư mục con dưới RESULTS_DIR.

    Returns:
        `(output_path, op_result)` — đường dẫn Working_File mới và kết quả mutate.

    Raises:
        FileNotFoundError: nếu file gốc không tồn tại.
        ValueError:        nếu output trùng file gốc (10.4) hoặc do mutate_fn ném.
    """
    src = os.fspath(original_path)
    if not os.path.exists(src):
        raise FileNotFoundError(f"File gốc không tồn tại: {src}")

    if output_path is None:
        output_path = build_working_file_path(
            src, original_name, suffix=suffix, output_subdir=output_subdir
        )

    # Mở file gốc CHỈ-ĐỌC trong context manager; mọi thay đổi nằm trên đối tượng
    # pikepdf trong bộ nhớ, chỉ vật chất hóa khi save ra path MỚI.
    with pikepdf.Pdf.open(src) as pdf:
        op_result = mutate_fn(pdf) if mutate_fn is not None else None
        saved = save_working_file(pdf, output_path, original_path=src)

    return saved, op_result


__all__ = [
    "DEFAULT_EDIT_OUTPUT_SUBDIR",
    "build_working_file_path",
    "save_working_file",
    "apply_and_save",
]
