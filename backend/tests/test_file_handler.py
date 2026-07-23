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
