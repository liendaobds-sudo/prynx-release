"""
service.py — Orchestrator: ghép CutModel → Registration → Emitter → Transport.

Requirements: 6.2, 8.1–8.4, 9.3. Cung cấp factory chọn emitter/transport theo
MachineProfile + override, kiểm tra giới hạn khổ, ghi log job, đảm bảo đơn định.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

from app.workers.cut_export.cut_model import CutModel, SendResult
from app.workers.cut_export.profile import MachineProfile
from app.workers.cut_export import registration as reg
from app.workers.cut_export.emitters.command_stream import CommandStreamEmitter
from app.workers.cut_export.emitters.dxf import DxfEmitter
from app.workers.cut_export.emitters.svg import SvgEmitter
from app.workers.cut_export.emitters.pdf_spot import PdfSpotEmitter
from app.workers.cut_export.transport.file import FileTransport
from app.workers.cut_export.transport.tcp import TcpTransport
from app.workers.cut_export.transport.serial_port import SerialTransport

logger = logging.getLogger(__name__)

_VECTOR_KINDS = ("dxf", "svg", "pdf")


def make_emitter(profile: MachineProfile, kind: Optional[str] = None):
    """Dựng emitter theo profile + override kind ('dxf'|'svg'|'pdf'|'command_stream')."""
    k = kind
    if k is None:
        k = "command_stream" if profile.emitter == "command_stream" else "dxf"
    if k == "command_stream":
        return CommandStreamEmitter(profile)
    if k == "dxf":
        return DxfEmitter()
    if k == "svg":
        return SvgEmitter()
    if k == "pdf":
        return PdfSpotEmitter()
    raise ValueError(f"Loại emitter không hỗ trợ: {k!r}")


def make_transport(kind: str, **params):
    if kind == "file":
        return FileTransport(params["dest_path"])
    if kind == "tcp":
        return TcpTransport(params["host"], params.get("port", 9100),
                            params.get("timeout", 10.0))
    if kind == "serial":
        return SerialTransport(
            params["port"], params.get("baud", 9600),
            params.get("flow_control", "rtscts"),
        )
    raise ValueError(f"Loại transport không hỗ trợ: {kind!r}")


def check_limits(model: CutModel, profile: MachineProfile):
    """ĐÃ BỎ: không chặn theo giới hạn khổ máy nữa (khổ do thực tế quyết định).

    Giữ hàm trả None để tương thích nếu nơi khác còn gọi.
    """
    return None


def resolve_filename(profile: MachineProfile, name: str = "cut", barcode: str = "") -> str:
    fn = profile.filename or {}
    pattern = fn.get("pattern", "{name}")
    ext = fn.get("ext", "plt")
    base = pattern.format(name=name, barcode=barcode or name)
    return f"{base}.{ext}"


def export_cut(
    model: CutModel,
    profile: MachineProfile,
    *,
    emitter_kind: Optional[str] = None,
    transport_kind: Optional[str] = None,
    transport_params: Optional[dict] = None,
    reg_mode: Optional[str] = None,
    design_pts: Optional[list] = None,
    measured_pts: Optional[list] = None,
    dest_dir: Optional[str] = None,
    name: str = "cut",
    barcode: str = "",
    ignore_limits: bool = False,
    copies: int = 1,
) -> SendResult:
    """Xuất/gửi dữ liệu cắt end-to-end.

    Trả SendResult.

    `copies`: số TỜ cần cắt (= số lượng in). Với lệnh máy (command_stream), chương
    trình cắt 1 tờ được lặp lại `copies` lần (mỗi lần máy dò dấu + cắt 1 tờ) — đúng
    quy trình "in 100 tờ → cắt 100 lần". Với file vector (DXF/SVG/PDF) thì bỏ qua
    (file thiết kế chỉ mô tả 1 tờ).

    Ghi chú: KHÔNG chặn theo "giới hạn khổ máy" — khổ tờ do thực tế quyết định, máy tự
    xử lý vùng cắt của nó. `ignore_limits` giữ lại cho tương thích API nhưng không còn
    tác dụng chặn.
    """
    transport_params = dict(transport_params or {})

    # 1) Khớp dấu.
    mode = reg_mode or profile.reg_mode
    model = reg.register(model, mode, design_pts=design_pts, measured_pts=measured_pts)

    # 2) Sinh đầu ra.
    emitter = make_emitter(profile, emitter_kind)
    data = emitter.emit(model)

    # 2b) Lặp theo số tờ in (chỉ với lệnh máy command_stream).
    eff_copies = max(1, int(copies or 1))
    if eff_copies > 1 and isinstance(emitter, CommandStreamEmitter):
        data = data * eff_copies

    # 4) Transport.
    tkind = transport_kind or (profile.transport or {}).get("default", "file")
    if tkind == "file":
        if "dest_path" not in transport_params:
            base_dir = dest_dir or transport_params.get("dir") or os.getcwd()
            ext = profile.filename.get("ext", "plt") if profile.emitter != "vector_file" else (emitter_kind or "dxf")
            # Với emitter vector, đuôi theo loại emitter.
            if emitter_kind in _VECTOR_KINDS:
                ext = emitter_kind
            fname = resolve_filename(profile, name=name, barcode=barcode)
            # Ép đuôi đúng loại đầu ra.
            fname = os.path.splitext(fname)[0] + f".{ext}"
            transport_params["dest_path"] = os.path.join(base_dir, fname)
        transport = make_transport("file", **transport_params)
    else:
        transport = make_transport(tkind, **transport_params)

    result = transport.send(data)

    # 5) Log job (Req 8.3).
    logger.info(
        "[cut_export] job profile=%s emitter=%s transport=%s bytes=%d copies=%d ok=%s detail=%s",
        profile.id, emitter.name, result.channel, len(data), eff_copies, result.ok, result.detail,
    )
    return result
