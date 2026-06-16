"""tcp.py — Transport gửi qua mạng LAN (raw TCP socket, mặc định cổng 9100).

Requirements: 5.2 (gửi tới IP:port cấu hình), 5.4 (lỗi báo rõ, không treo), 5.6 (chỉ tới đích cấu hình).
"""

from __future__ import annotations

import socket

from app.workers.cut_export.cut_model import SendResult


class TcpTransport:
    channel = "tcp"

    def __init__(self, host: str, port: int = 9100, timeout: float = 10.0):
        self.host = host
        self.port = int(port)
        self.timeout = timeout

    def send(self, data: bytes) -> SendResult:
        try:
            with socket.create_connection((self.host, self.port), timeout=self.timeout) as s:
                s.settimeout(self.timeout)
                s.sendall(data)
            return SendResult(
                ok=True, channel=self.channel,
                detail=f"{self.host}:{self.port}", bytes_sent=len(data),
            )
        except (OSError, socket.timeout) as e:
            return SendResult(
                ok=False, channel=self.channel,
                detail=f"Lỗi gửi LAN {self.host}:{self.port}: {e}", bytes_sent=0,
            )
