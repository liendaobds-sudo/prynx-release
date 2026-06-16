"""serial_port.py — Transport gửi qua cổng COM/serial.

Requirements: 5.3 (baud cấu hình), 5.5 (flow control RTS/CTS hoặc XON/XOFF + tiết lưu
chống tràn buffer), 5.4 (lỗi báo rõ).

pyserial là DEPENDENCY TUỲ CHỌN — import lazy; nếu thiếu trả lỗi rõ thay vì crash.
File đặt tên `serial_port.py` (không phải serial.py) để tránh che khuất module `serial`.
"""

from __future__ import annotations

import time

from app.workers.cut_export.cut_model import SendResult


class SerialTransport:
    channel = "serial"

    def __init__(
        self,
        port: str,
        baud: int = 9600,
        flow_control: str = "rtscts",   # 'rtscts' | 'xonxoff' | 'none'
        chunk_size: int = 1024,
        chunk_delay: float = 0.0,
        timeout: float = 10.0,
    ):
        self.port = port
        self.baud = int(baud)
        self.flow_control = flow_control
        self.chunk_size = chunk_size
        self.chunk_delay = chunk_delay
        self.timeout = timeout

    def send(self, data: bytes) -> SendResult:
        try:
            import serial  # type: ignore
        except ImportError:
            return SendResult(
                ok=False, channel=self.channel,
                detail="Thiếu thư viện 'pyserial'. Cài: pip install pyserial",
                bytes_sent=0,
            )

        rtscts = self.flow_control == "rtscts"
        xonxoff = self.flow_control == "xonxoff"
        try:
            with serial.Serial(
                self.port, self.baud, timeout=self.timeout,
                rtscts=rtscts, xonxoff=xonxoff,
            ) as ser:
                sent = 0
                # Gửi theo khối + tiết lưu để tránh tràn buffer máy (Req 5.5).
                for i in range(0, len(data), self.chunk_size):
                    chunk = data[i:i + self.chunk_size]
                    ser.write(chunk)
                    ser.flush()
                    sent += len(chunk)
                    if self.chunk_delay > 0:
                        time.sleep(self.chunk_delay)
            return SendResult(
                ok=True, channel=self.channel, detail=self.port, bytes_sent=sent,
            )
        except Exception as e:  # serial.SerialException + OSError
            return SendResult(
                ok=False, channel=self.channel,
                detail=f"Lỗi gửi serial {self.port}: {e}", bytes_sent=0,
            )
