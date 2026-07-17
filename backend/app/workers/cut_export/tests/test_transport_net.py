"""Test TCP + serial transport (task 7.3). Requirements: 5.2, 5.3, 5.4, 5.5."""

import socket
import threading
import pytest

from app.workers.cut_export.transport.tcp import TcpTransport, probe_tcp
from app.workers.cut_export.transport.serial_port import SerialTransport


def _run_echo_server(received: list, ready: threading.Event):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    port = srv.getsockname()[1]
    ready.port = port  # type: ignore[attr-defined]
    ready.set()
    conn, _ = srv.accept()
    with conn:
        data = b""
        while True:
            chunk = conn.recv(4096)
            if not chunk:
                break
            data += chunk
    received.append(data)
    srv.close()


def test_tcp_sends_to_mock_server():
    received: list = []
    ready = threading.Event()
    t = threading.Thread(target=_run_echo_server, args=(received, ready), daemon=True)
    t.start()
    ready.wait(2.0)
    port = ready.port  # type: ignore[attr-defined]

    r = TcpTransport("127.0.0.1", port).send(b"IN U0,0 D10,10 @ @ ")
    t.join(2.0)

    assert r.ok is True
    assert r.channel == "tcp"
    assert r.bytes_sent == 19
    assert received and received[0] == b"IN U0,0 D10,10 @ @ "


def test_tcp_error_on_unreachable():
    # Cổng không có ai nghe → lỗi rõ, không treo, không ném.
    r = TcpTransport("127.0.0.1", 1, timeout=1.0).send(b"x")
    assert r.ok is False
    assert "Lỗi gửi LAN" in r.detail


def test_tcp_probe_opens_port_without_sending_data():
    received: list = []
    ready = threading.Event()
    t = threading.Thread(target=_run_echo_server, args=(received, ready), daemon=True)
    t.start()
    ready.wait(2.0)

    r = probe_tcp(" 127.0.0.1 ", ready.port, timeout=1.0)  # type: ignore[attr-defined]
    t.join(2.0)

    assert r["ok"] is True
    assert r["resolved_ip"] == "127.0.0.1"
    assert received == [b""]


@pytest.mark.parametrize("host,port", [("", 9100), ("127.0.0.1", 0), ("127.0.0.1", 65536)])
def test_tcp_rejects_invalid_target(host, port):
    with pytest.raises(ValueError):
        probe_tcp(host, port)


def test_serial_missing_pyserial_graceful():
    # pyserial chưa cài trong venv → trả lỗi rõ, không crash.
    r = SerialTransport("COM99").send(b"x")
    assert r.ok is False
    assert "pyserial" in r.detail.lower() or "serial" in r.detail.lower()
