"""
command_stream.py — Emitter sinh chuỗi lệnh máy (HPGL PU/PD, Skycut/Yuty U/D...).

Requirements: 4.1–4.7. Đọc THẲNG toạ độ đường cắt từ CutModel (không spot-color),
đổi mm→PLU theo profile, áp origin/flip_y/swap_xy, sinh header/footer/pen từ template.

Khung khớp dấu (FSIZE) tính từ bbox tâm ốc khi registration.mode == onboard_frame.
Toạ độ tương đối gốc khung (origin = góc dưới-trái bbox ốc) — khớp cách JSX làm.

LƯU Ý: đối chiếu byte-chính-xác với file PLT của script JSX cần fixture mẫu thật
(task 6.4) — ở đây kiểm thử cấu trúc; khớp tuyệt đối hoàn thiện khi có fixture + máy.
"""

from __future__ import annotations

from typing import Optional

from app.workers.cut_export.cut_model import CutModel
from app.workers.cut_export.profile import MachineProfile


class CommandStreamEmitter:
    name = "command_stream"

    def __init__(self, profile: MachineProfile):
        self.profile = profile

    def emit(self, model: CutModel) -> bytes:
        p = self.profile
        res = p.resolution_plu_per_mm

        frame = model.frame or model.compute_frame_from_marks()
        use_frame_origin = (p.reg_mode == "onboard_frame") and frame is not None
        if use_frame_origin:
            ox, oy, fx2, fy2 = frame
            fw = round((fx2 - ox) * res)
            fh = round((fy2 - oy) * res)
        else:
            # manual_affine / none: dùng toạ độ tuyệt đối theo khổ (không re-origin theo ốc,
            # nếu không phép warp affine sẽ bị triệt tiêu).
            ox = oy = 0.0
            fw = round(model.sheet_w_mm * res)
            fh = round(model.sheet_h_mm * res)

        aw = round(model.sheet_w_mm * res)
        ah = round(model.sheet_h_mm * res)
        if p.swap_xy:
            aw, ah = ah, aw

        def tx(x: float, y: float) -> tuple[int, int]:
            px = round((x - ox) * res)
            py = round((y - oy) * res)
            if p.flip_y:
                py = fh - py
            if p.swap_xy:
                px, py = py, px
            return px, py

        blade = p.blade or {}
        dh0 = p.dual_head or {}
        _offset = blade.get("offset", blade.get("blade_offset_plu", 0))
        if dh0.get("enabled") and dh0.get("offset") is not None:
            _offset = dh0.get("offset")
        fmt = {
            "fw": fw, "fh": fh, "aw": aw, "ah": ah,
            "tool": blade.get("tool", 1),
            "pressure": blade.get("pressure", 1),
            "offset": _offset,
        }

        parts: list[str] = []
        if p.header_template:
            parts.append(_safe_format(p.header_template, fmt))

        ordered = self._ordered_paths(model)
        dh = p.dual_head or {}
        if dh.get("enabled"):
            parts.append(self._emit_dual_head(ordered, tx, model))
        else:
            for path in ordered:
                parts.append(self._emit_path(path, tx))

        if p.footer_template:
            parts.append(_safe_format(p.footer_template, fmt))

        text = "".join(parts)
        encoding = (p.filename or {}).get("encoding", "ascii")
        return text.encode(encoding, errors="replace")

    def _split_heads(self, paths, model: CutModel, tx):
        """Chia path cho 2 đầu dao THEO CỘT (nguồn chân lý = nhãn tool_tag từ toán cột,
        task 13 — khớp mắt nhìn trực quan giấy đứng).

        - left  (D1, CMD:35,1) = cụm cột trái
        - right (D2, CMD:35,2) = cụm cột phải
        - shared(S,  CMD:35,0) = cột giữa (khi số cột lẻ)

        Việc cột → hiện thành băng PLT-Y trong file là DO swapXY ở transform (không xử ở đây).
        Nếu path CHƯA gắn nhãn → fallback tách theo X centroid quanh trục giữa tờ (cột).
        """
        tagged = any(pt.tool_tag in ("left", "right", "shared") for pt in paths)
        shared, left, right = [], [], []
        if tagged:
            for pt in paths:
                if pt.tool_tag == "left":
                    left.append(pt)
                elif pt.tool_tag == "right":
                    right.append(pt)
                else:
                    shared.append(pt)
            return shared, left, right
        # Fallback chưa gắn nhãn: tách theo CỘT (X centroid) quanh trục giữa tờ.
        mid_x = model.sheet_w_mm / 2.0
        for pt in paths:
            cx = sum(x for x, _ in pt.points) / len(pt.points)
            (left if cx < mid_x else right).append(pt)
        return [], left, right

    def _emit_dual_head(self, paths, tx, model: CutModel) -> str:
        """Phát thân song đạo: CMD:35,0; + mồi + shared, rồi U;CMD:35,1; (cột trái=D1) /
        U;CMD:35,2; (cột phải=D2). Khớp cấu trúc file PLT thật Yuty/Skycut.
        """
        shared, left, right = self._split_heads(paths, model, tx)
        seg: list[str] = []
        # Đầu dao chung + chuỗi mồi dấu (khớp mẫu thật).
        seg.append("CMD:35,0;")
        seg.append("U-39,440 D-39,440 D-31,479 ")
        for pt in shared:
            seg.append(self._emit_path(pt, tx))
        if left:
            seg.append("U;CMD:35,1;")
            for pt in left:
                seg.append(self._emit_path(pt, tx))
        if right:
            seg.append("U;CMD:35,2;")
            for pt in right:
                seg.append(self._emit_path(pt, tx))
        return "".join(seg)

    def _ordered_paths(self, model: CutModel):
        """Thứ tự cắt: theo block_id, rồi trái→phải, dưới→lên (theo centroid mm)."""
        def key(path):
            pts = path.points
            cx = sum(x for x, _ in pts) / len(pts)
            cy = sum(y for _, y in pts) / len(pts)
            return (path.block_id, round(cx, 2), round(cy, 2))
        return sorted((p for p in model.paths if not p.is_empty), key=key)

    def _emit_path(self, path, tx) -> str:
        p = self.profile
        pts = path.points
        seg: list[str] = []
        x0, y0 = tx(*pts[0])
        seg.append(p.pen_up.format(x=x0, y=y0))
        seg.append(p.pen_down.format(x=x0, y=y0))
        for x, y in pts[1:]:
            px, py = tx(x, y)
            seg.append(p.pen_down.format(x=px, y=py))
        if path.closed:
            seg.append(p.pen_down.format(x=x0, y=y0))
        return "".join(seg)


def _safe_format(template: str, values: dict) -> str:
    """str.format nhưng không vỡ nếu template có ký tự '{' '}' không phải placeholder."""
    try:
        return template.format(**values)
    except (KeyError, IndexError, ValueError):
        out = template
        for k, v in values.items():
            out = out.replace("{" + k + "}", str(v))
        return out
