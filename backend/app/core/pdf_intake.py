"""Khám PDF vừa nhận vào — phần CHẠM PARSER, tách riêng để chạy trong process con.

Bối cảnh (pentest 2026-08-28 §ATK.04): `/upload` là bề mặt đầu tiên chạm file khách gửi,
và nó parse ngay bằng qpdf (`pikepdf`) + `pypdf`/`pypdfium2`. Đó là parser C/C++; một lỗi
bộ nhớ ở đây giết cả sidecar. Module này chứa đúng phần cần cách ly, và **cố ý không
import FastAPI/SQLAlchemy**: process con phải nạp lại module theo tên khi spawn, nên kéo
theo cả web framework sẽ làm warm-up chậm và mở rộng vùng code trong sandbox vô ích.

Hợp đồng: hàm `inspect_pdf_for_intake` KHÔNG raise lỗi nghiệp vụ. Nó trả **dict
JSON-an-toàn** có khoá `status` để tầng route dịch sang HTTPException. Lý do: mã lỗi và
câu chữ tiếng Việt là hợp đồng với frontend (và có test bám theo), nên chúng phải sống ở
tầng route — còn đây chỉ báo "chuyện gì đã xảy ra".
"""

from __future__ import annotations

from typing import Any

# Các trạng thái trả về. Đặt hằng để route và test không phải viết chuỗi tay hai nơi.
STATUS_OK = "ok"
STATUS_PASSWORD = "password"
STATUS_ENCRYPTED = "encrypted"
STATUS_CORRUPT = "corrupt"
STATUS_NO_PAGES = "no_pages"
STATUS_METADATA_FAILED = "metadata_failed"
STATUS_METADATA_MISMATCH = "metadata_mismatch"


def inspect_pdf_for_intake(file_path: str) -> dict[str, Any]:
    """Mở PDF, xác nhận dùng được và lấy metadata. Chạy được trong process con.

    Import nằm TRONG hàm để lúc spawn, việc nạp module này không tự kéo theo toàn bộ
    tầng parser trước khi cần (worker chỉ trả giá đúng một lần, ở lần gọi đầu).
    """
    import pikepdf

    from app.core.pdf_processor import PDFProcessor

    # FILEIO (audit 2026-08-02 §BE.3): mở nghiêm ngặt để không nhận PDF hỏng rồi
    # trả 200; tắt recovery vì file được sửa ngầm vẫn có thể hỏng ở bước render sau.
    try:
        with pikepdf.Pdf.open(file_path, attempt_recovery=False) as pdf:
            if pdf.is_encrypted:
                return {"status": STATUS_ENCRYPTED}
            page_count = len(pdf.pages)
    except pikepdf.PasswordError:
        return {"status": STATUS_PASSWORD}
    except pikepdf.PdfError as exc:
        return {"status": STATUS_CORRUPT, "detail": str(exc)}

    if page_count == 0:
        return {"status": STATUS_NO_PAGES}

    try:
        metadata = PDFProcessor().get_metadata(file_path)
    except Exception as exc:  # noqa: BLE001 — mọi lỗi đọc metadata quy về một trạng thái
        return {"status": STATUS_METADATA_FAILED, "detail": f"{type(exc).__name__}: {exc}"}

    metadata_page_count = metadata.get("page_count") if isinstance(metadata, dict) else None
    if (
        not isinstance(metadata_page_count, int)
        or isinstance(metadata_page_count, bool)
        or metadata_page_count != page_count
    ):
        return {
            "status": STATUS_METADATA_MISMATCH,
            "page_count": page_count,
            "metadata_page_count": metadata_page_count,
        }

    return {"status": STATUS_OK, "metadata": metadata, "page_count": page_count}
