"""file.py — Transport ghi đầu ra ra file (.plt/.dxf/.svg/.pdf/.nc).

Requirements: 5.1 (lưu file đúng đuôi + tên theo profile), 8.4 (đơn định).
Tên file đã được service phân giải sẵn và truyền qua dest_path.
"""

from __future__ import annotations

import os

from app.workers.cut_export.cut_model import SendResult


class FileTransport:
    channel = "file"

    def __init__(self, dest_path: str):
        self.dest_path = dest_path

    def send(self, data: bytes) -> SendResult:
        try:
            parent = os.path.dirname(self.dest_path)
            if parent and not os.path.isdir(parent):
                os.makedirs(parent, exist_ok=True)
            with open(self.dest_path, "wb") as f:
                f.write(data)
            return SendResult(
                ok=True,
                channel=self.channel,
                detail=self.dest_path,
                bytes_sent=len(data),
            )
        except OSError as e:
            return SendResult(
                ok=False,
                channel=self.channel,
                detail=f"Lỗi ghi file {self.dest_path}: {e}",
                bytes_sent=0,
            )
