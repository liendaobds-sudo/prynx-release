from pathlib import Path

import pytest

from app.utils import file_handler


class InterruptedUpload:
    filename = "interrupted.pdf"

    def __init__(self) -> None:
        self._reads = 0

    async def read(self, _size: int) -> bytes:
        self._reads += 1
        if self._reads == 1:
            return b"%PDF-1.7 partial"
        raise RuntimeError("client disconnected")


@pytest.mark.asyncio
async def test_interrupted_upload_removes_partial_file(tmp_path, monkeypatch):
    monkeypatch.setattr(file_handler.settings, "UPLOAD_DIR", str(tmp_path))

    with pytest.raises(RuntimeError, match="client disconnected"):
        await file_handler.save_upload_file(InterruptedUpload())

    assert list(Path(tmp_path).iterdir()) == []


@pytest.mark.asyncio
async def test_unsupported_extension_never_creates_file(tmp_path, monkeypatch):
    upload = InterruptedUpload()
    upload.filename = "payload.exe"
    monkeypatch.setattr(file_handler.settings, "UPLOAD_DIR", str(tmp_path))

    with pytest.raises(ValueError):
        await file_handler.save_upload_file(upload)

    assert list(Path(tmp_path).iterdir()) == []


class SizedUpload:
    """Upload giả phát ra đúng ``total_bytes`` theo từng chunk 1MB (như route thật)."""

    filename = "big.pdf"

    def __init__(self, total_bytes: int) -> None:
        self._remaining = total_bytes

    async def read(self, size: int) -> bytes:
        if self._remaining <= 0:
            return b""
        n = min(size, self._remaining)
        self._remaining -= n
        return b"\x00" * n


@pytest.mark.asyncio
async def test_oversize_upload_is_rejected_and_removes_partial(tmp_path, monkeypatch):
    # SEC (pentest 2026-08-28 §ATK.03): trần MAX_FILE_SIZE_MB là FAIL-OPEN — nếu ai gỡ
    # kiểm tra thì không tính năng nào gãy, chỉ mở lại đường DoS bằng file khổng lồ.
    # Ratchet giữ cho lần "dọn dẹp" sau không âm thầm bỏ trần.
    monkeypatch.setattr(file_handler.settings, "UPLOAD_DIR", str(tmp_path))
    monkeypatch.setattr(file_handler.settings, "MAX_FILE_SIZE_MB", 1)

    upload = SizedUpload(total_bytes=3 * 1024 * 1024)  # 3MB > trần 1MB

    with pytest.raises(ValueError, match="giới hạn"):
        await file_handler.save_upload_file(upload)

    # Không để lại file dở trên đĩa theo đường tấn công.
    assert list(Path(tmp_path).iterdir()) == []


@pytest.mark.asyncio
async def test_upload_within_limit_still_succeeds(tmp_path, monkeypatch):
    # Chốt trần KHÔNG phá upload hợp lệ dưới ngưỡng (không hard-cap oan máy mạnh).
    monkeypatch.setattr(file_handler.settings, "UPLOAD_DIR", str(tmp_path))
    monkeypatch.setattr(file_handler.settings, "MAX_FILE_SIZE_MB", 5)

    upload = SizedUpload(total_bytes=2 * 1024 * 1024)  # 2MB < trần 5MB
    _stored_name, file_path, file_size = await file_handler.save_upload_file(upload)

    assert file_size == 2 * 1024 * 1024
    assert Path(file_path).is_file()
    assert len(list(Path(tmp_path).iterdir())) == 1
