"""Đo BASELINE cho Lô 0 của strategy `true_shape_nesting` (Nesting tối ưu theo đường bế).

Kế hoạch: ``docs/KE_HOACH_TICH_HOP_NESTING_TU_DO_TEM_CNC_CHINH_THUC_2026-08-27.md`` §12 Lô 0.
Corpus:   ``backend/tests/fixtures/nesting_tu_do/corpus_lo0.json``

Script này CHỈ ĐỌC. Nó không sửa file nào trong ``backend/app``, không ghi golden, không
đổi hành vi. Nó tồn tại để Lô 0 có SỐ THẬT trước khi chủ sản phẩm chốt metric/tolerance/
budget, thay vì chốt bằng cảm giác.

Nó làm ba việc:

1. Sinh PDF từ mô tả khai báo trong corpus (pikepdf) — không lưu PDF nhị phân trong repo,
   đúng khuôn mẫu ``backend/tests/fixtures/mixed_nesting_sources/manifest.json``.
2. Chạy BASELINE bằng chính đường sản xuất hiện hữu:
   - S&R (tem bế và CNC): ``compute_sticker_layout_for_page`` + ``finalize_placements``;
   - gang tem bế: ``bin_packing.solve_auto_fill_mixed`` / ``solve_offset_mixed``;
   - gang CNC:    ``cnc_layout.build_cnc_gang_layout``.
3. Chạy SMART bằng kernel Rust ``pdfcompare_native.MixedNestingRun`` trên CÙNG hình học,
   rồi so bằng cùng một bộ metric.

Cách chạy (Windows, venv backend đã có sẵn):

    backend\\venv\\Scripts\\python.exe scripts\\lo0_nesting_baseline.py
    backend\\venv\\Scripts\\python.exe scripts\\lo0_nesting_baseline.py --lap 5 --case ST_SR_AUTOFILL_TRON
    backend\\venv\\Scripts\\python.exe scripts\\lo0_nesting_baseline.py --profile tight --out ket-qua.json

Mặc định kết quả ghi vào ``%TEMP%\\prynx_lo0\\ket_qua_lo0.json`` — CỐ Ý nằm ngoài repo để
lượt đo không tạo file rác cần review.
"""

from __future__ import annotations

import argparse
import ctypes
import io
import json
import math
import os
import statistics
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

# ─────────────────────────────────────────────────────────────────────────────
#  Đường dẫn và hằng số
# ─────────────────────────────────────────────────────────────────────────────

_REPO_ROOT = Path(__file__).resolve().parents[1]
_BACKEND = _REPO_ROOT / "backend"
_CORPUS = _BACKEND / "tests" / "fixtures" / "nesting_tu_do" / "corpus_lo0.json"

# PHẢI khớp MM_TO_PTS của backend (nup_engine/cnc_render dùng đúng số này).
# Đổi số ở đây là làm lệch mọi phép so preview↔export.
MM_TO_PTS = 2.83465
PTS_TO_MM = 1.0 / MM_TO_PTS

# Bước lưới khi đo "hình chữ nhật lớn nhất còn lồng được vào phần dư", mm.
# 1 mm mịn hơn mọi quyết định thực tế của thợ in mà vẫn chạy trong vài ms.
FREE_RECT_GRID_MM = 1.0

if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from app.core.mixed_nesting_service import MIXED_NESTING_PROTOCOL_VERSION

# Console Windows mặc định cp1252 nên mọi chữ có dấu sẽ nổ UnicodeEncodeError.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


# ─────────────────────────────────────────────────────────────────────────────
#  Đo RAM đỉnh (không cần psutil — venv backend chưa có)
# ─────────────────────────────────────────────────────────────────────────────


class _ProcessMemoryCountersEx(ctypes.Structure):
    _fields_ = [
        ("cb", ctypes.c_ulong),
        ("PageFaultCount", ctypes.c_ulong),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
        ("PrivateUsage", ctypes.c_size_t),
    ]


def _doc_counters() -> _ProcessMemoryCountersEx | None:
    """Đọc PROCESS_MEMORY_COUNTERS_EX của chính tiến trình.

    Windows 10+ chuyển ``GetProcessMemoryInfo`` sang ``K32GetProcessMemoryInfo``
    trong kernel32; psapi.dll chỉ còn là shim và không luôn có. Thử cả hai.
    """
    counters = _ProcessMemoryCountersEx()
    counters.cb = ctypes.sizeof(_ProcessMemoryCountersEx)
    for dll_name, func_name in (
        ("kernel32", "K32GetProcessMemoryInfo"),
        ("psapi", "GetProcessMemoryInfo"),
    ):
        try:
            dll = getattr(ctypes.windll, dll_name)
            func = getattr(dll, func_name)
        except (AttributeError, OSError):
            continue
        func.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(_ProcessMemoryCountersEx),
            ctypes.c_ulong,
        ]
        func.restype = ctypes.c_int
        handle = ctypes.c_void_p(ctypes.windll.kernel32.GetCurrentProcess())
        if func(handle, ctypes.byref(counters), counters.cb):
            return counters
    return None


def rss_mb() -> float | None:
    """Working set hiện tại (MB). ``None`` nếu không đọc được."""
    if os.name != "nt":
        try:
            import resource

            return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0
        except Exception:
            return None
    counters = _doc_counters()
    return counters.WorkingSetSize / (1024.0 * 1024.0) if counters else None


def peak_rss_mb() -> float | None:
    """Working set ĐỈNH từ đầu tiến trình (MB)."""
    if os.name != "nt":
        return rss_mb()
    counters = _doc_counters()
    return counters.PeakWorkingSetSize / (1024.0 * 1024.0) if counters else None


def ram_may_mb() -> float | None:
    """Tổng RAM máy (MB) — để đối chiếu quy tắc gating <8/<16/≥16 GB."""
    try:
        from app.core.system_memory import read_memory_status_mb

        total, _available = read_memory_status_mb()
        return total
    except Exception:
        return None


# ─────────────────────────────────────────────────────────────────────────────
#  Sinh PDF từ mô tả khai báo (mm → pt)
# ─────────────────────────────────────────────────────────────────────────────


def _pt(value_mm: float) -> float:
    return round(float(value_mm) * MM_TO_PTS, 6)


def _circle_ops(cx_mm: float, cy_mm: float, r_mm: float) -> list[str]:
    """Bốn cung Bézier xấp xỉ đường tròn (hệ số kappa chuẩn 0,5523)."""
    cx, cy, r = _pt(cx_mm), _pt(cy_mm), _pt(r_mm)
    k = r * 0.5523
    return [
        f"{cx + r:.4f} {cy:.4f} m",
        f"{cx + r:.4f} {cy + k:.4f} {cx + k:.4f} {cy + r:.4f} {cx:.4f} {cy + r:.4f} c",
        f"{cx - k:.4f} {cy + r:.4f} {cx - r:.4f} {cy + k:.4f} {cx - r:.4f} {cy:.4f} c",
        f"{cx - r:.4f} {cy - k:.4f} {cx - k:.4f} {cy - r:.4f} {cx:.4f} {cy - r:.4f} c",
        f"{cx + k:.4f} {cy - r:.4f} {cx + r:.4f} {cy - k:.4f} {cx + r:.4f} {cy:.4f} c",
        "h S",
    ]


def _capsule_ops(rect_mm: list[float]) -> list[str]:
    x0, y0, x1, y1 = (_pt(v) for v in rect_mm)
    radius = (y1 - y0) / 2.0
    k = radius * 0.5523
    mid_y = (y0 + y1) / 2.0
    return [
        f"{x0 + radius:.4f} {y0:.4f} m",
        f"{x1 - radius:.4f} {y0:.4f} l",
        f"{x1 - radius + k:.4f} {y0:.4f} {x1:.4f} {mid_y - k:.4f} {x1:.4f} {mid_y:.4f} c",
        f"{x1:.4f} {mid_y + k:.4f} {x1 - radius + k:.4f} {y1:.4f} {x1 - radius:.4f} {y1:.4f} c",
        f"{x0 + radius:.4f} {y1:.4f} l",
        f"{x0 + radius - k:.4f} {y1:.4f} {x0:.4f} {mid_y + k:.4f} {x0:.4f} {mid_y:.4f} c",
        f"{x0:.4f} {mid_y - k:.4f} {x0 + radius - k:.4f} {y0:.4f} {x0 + radius:.4f} {y0:.4f} c",
        "h S",
    ]


def _artwork_ops(artwork: dict[str, Any] | None) -> list[str]:
    """Nền xám + landmark F/R/B/L.

    Landmark là bốn dấu ĐẶC ở bốn cạnh, không dùng font: nét vẽ đọc được bằng
    ``extract_vector_paths`` và soi được bằng raster, nên artifact test không phụ
    thuộc việc nhúng font.
    """
    if not artwork:
        return []
    kind = artwork.get("kind")
    x0, y0, x1, y1 = (_pt(v) for v in artwork["boxMm"])
    gray = float(artwork.get("fillGray", 0.85))
    ops = [
        "q",
        f"{gray:.3f} g",
        f"{x0:.4f} {y0:.4f} {x1 - x0:.4f} {y1 - y0:.4f} re f",
    ]
    if kind == "landmark_frbl":
        w = x1 - x0
        h = y1 - y0
        # Dấu ở mỗi cạnh có kích thước KHÁC nhau để phân biệt được cả bốn.
        marks = [
            ("F", (x0 + w / 2 - w * 0.10, y1 - h * 0.16, w * 0.20, h * 0.10)),
            ("R", (x1 - w * 0.16, y0 + h / 2 - h * 0.06, w * 0.10, h * 0.12)),
            ("B", (x0 + w / 2 - w * 0.06, y0 + h * 0.06, w * 0.12, h * 0.10)),
            ("L", (x0 + w * 0.06, y0 + h / 2 - h * 0.10, w * 0.10, h * 0.20)),
        ]
        ops.append("0 g")
        for _ten, (mx, my, mw, mh) in marks:
            ops.append(f"{mx:.4f} {my:.4f} {mw:.4f} {mh:.4f} re f")
    ops.append("Q")
    return ops


def _die_ops(die_paths: list[dict[str, Any]]) -> list[str]:
    """Đường bế: NÉT THUẦN, màu MAGENTA RGB.

    Hai điều kiện này là cổng cứng của ``die_detection``: path phải stroke-only
    (``_is_stroke_only_path``) VÀ có tín hiệu bế mạnh — tên kênh spot, hoặc màu
    thuộc ``DetectionConfig.die_colors``. Magenta RGB ``(1,0,1)`` nằm trong bảng đó
    và đúng quy ước thợ bế Việt Nam. Đỏ ``(1,0,0)`` KHÔNG nằm trong bảng, dùng nó
    thì detection trả None và layout rơi về khung trang — sai baseline.
    """
    ops = ["q", f"{0.25 * MM_TO_PTS:.4f} w", "1 0 1 RG"]
    for path in die_paths:
        kind = path["kind"]
        if kind in {"closed_polyline", "open_polyline"}:
            points = path["pointsMm"]
            ops.append(f"{_pt(points[0][0]):.4f} {_pt(points[0][1]):.4f} m")
            for x_mm, y_mm in points[1:]:
                ops.append(f"{_pt(x_mm):.4f} {_pt(y_mm):.4f} l")
            ops.append("h S" if kind == "closed_polyline" else "S")
        elif kind == "circle":
            cx, cy = path["centerMm"]
            ops.extend(_circle_ops(cx, cy, path["radiusMm"]))
        elif kind == "closed_bezier_capsule":
            ops.extend(_capsule_ops(path["rectMm"]))
        else:
            raise SystemExit(f"corpus có kind lạ: {kind}")
    ops.append("Q")
    return ops


def _expand_generator(source: dict[str, Any]) -> list[dict[str, Any]]:
    """Nở `generator` thành danh sách trang. Chỉ hỗ trợ `series_rect`."""
    gen = source["generator"]
    if gen["kind"] != "series_rect":
        raise SystemExit(f"generator chưa hỗ trợ: {gen['kind']}")
    pad = float(gen.get("paddingMm", 2))
    pages: list[dict[str, Any]] = []
    for i in range(int(gen["count"])):
        w = eval(gen["widthMm"], {"__builtins__": {}}, {"i": i})  # noqa: S307
        h = eval(gen["heightMm"], {"__builtins__": {}}, {"i": i})  # noqa: S307
        pages.append(
            {
                "mediaBoxMm": [0, 0, w + 2 * pad, h + 2 * pad],
                "rotate": 0,
                "nhan": f"{gen.get('labelPrefix', 'X')}{i}",
                "diePaths": [
                    {
                        "kind": "closed_polyline",
                        "pointsMm": [
                            [pad, pad],
                            [pad + w, pad],
                            [pad + w, pad + h],
                            [pad, pad + h],
                        ],
                    }
                ],
                "artwork": {
                    "kind": "fill_rect",
                    "boxMm": [pad, pad, pad + w, pad + h],
                    "fillGray": 0.9,
                },
            }
        )
    return pages


def pages_of(source: dict[str, Any]) -> list[dict[str, Any]]:
    if "generator" in source:
        return _expand_generator(source)
    return source["pages"]


def build_pdf(source: dict[str, Any]) -> bytes:
    """Sinh PDF nhiều trang theo mô tả khai báo. mm → pt tại đúng chỗ này."""
    import pikepdf

    pdf = pikepdf.Pdf.new()
    for page_desc in pages_of(source):
        ops: list[str] = []
        ops.extend(_artwork_ops(page_desc.get("artwork")))
        ops.extend(_die_ops(page_desc.get("diePaths", [])))
        stream = pdf.make_stream("\n".join(ops).encode("latin-1"))

        media = [_pt(v) for v in page_desc["mediaBoxMm"]]
        entries: dict[str, Any] = {
            "Type": pikepdf.Name.Page,
            "MediaBox": media,
            "Resources": pikepdf.Dictionary(),
            "Contents": stream,
        }
        if "cropBoxMm" in page_desc:
            entries["CropBox"] = [_pt(v) for v in page_desc["cropBoxMm"]]
        if "trimBoxMm" in page_desc:
            entries["TrimBox"] = [_pt(v) for v in page_desc["trimBoxMm"]]
        rotate = int(page_desc.get("rotate", 0) or 0)
        if rotate:
            entries["Rotate"] = rotate
        page = pdf.make_indirect(pikepdf.Dictionary(**entries))
        pdf.pages.append(pikepdf.Page(page))

    buffer = io.BytesIO()
    pdf.save(buffer)
    return buffer.getvalue()


# ─────────────────────────────────────────────────────────────────────────────
#  Hình học: polygon canonical (mm, gốc trái-dưới) từ mô tả corpus
# ─────────────────────────────────────────────────────────────────────────────


def _ring_of_die_path(path: dict[str, Any], steps: int = 24) -> list[tuple[float, float]]:
    kind = path["kind"]
    if kind in {"closed_polyline", "open_polyline"}:
        return [(float(x), float(y)) for x, y in path["pointsMm"]]
    if kind == "circle":
        cx, cy = (float(v) for v in path["centerMm"])
        r = float(path["radiusMm"])
        return [
            (cx + r * math.cos(2 * math.pi * k / steps),
             cy + r * math.sin(2 * math.pi * k / steps))
            for k in range(steps)
        ]
    if kind == "closed_bezier_capsule":
        x0, y0, x1, y1 = (float(v) for v in path["rectMm"])
        r = (y1 - y0) / 2.0
        cy = (y0 + y1) / 2.0
        left_c = (x0 + r, cy)
        right_c = (x1 - r, cy)
        half = steps // 2
        pts: list[tuple[float, float]] = []
        for k in range(half + 1):  # nửa phải, từ -90° lên +90°
            ang = -math.pi / 2 + math.pi * k / half
            pts.append((right_c[0] + r * math.cos(ang), right_c[1] + r * math.sin(ang)))
        for k in range(half + 1):  # nửa trái, từ +90° xuống -90°
            ang = math.pi / 2 + math.pi * k / half
            pts.append((left_c[0] + r * math.cos(ang), left_c[1] + r * math.sin(ang)))
        return pts
    raise SystemExit(f"không dựng được ring cho kind {kind}")


def canonical_part(page_desc: dict[str, Any]) -> dict[str, Any]:
    """Contour ngoài + lỗ, dịch về gốc trái-dưới của chính nó. Đơn vị mm."""
    outer_desc = None
    holes_desc: list[dict[str, Any]] = []
    for path in page_desc.get("diePaths", []):
        if path.get("role") == "hole":
            holes_desc.append(path)
        elif path["kind"] != "open_polyline" and outer_desc is None:
            outer_desc = path
    if outer_desc is None:
        return {"outer": [], "holes": [], "widthMm": 0.0, "heightMm": 0.0}

    outer = _ring_of_die_path(outer_desc)
    holes = [_ring_of_die_path(h) for h in holes_desc]
    min_x = min(p[0] for p in outer)
    min_y = min(p[1] for p in outer)
    outer = [(x - min_x, y - min_y) for x, y in outer]
    holes = [[(x - min_x, y - min_y) for x, y in ring] for ring in holes]
    return {
        "outer": outer,
        "holes": holes,
        "widthMm": max(p[0] for p in outer),
        "heightMm": max(p[1] for p in outer),
    }


# ─────────────────────────────────────────────────────────────────────────────
#  Metric — ĐỀ XUẤT của Lô 0, tính giống nhau cho baseline và smart
# ─────────────────────────────────────────────────────────────────────────────


def _shapely():
    from shapely import affinity
    from shapely.geometry import Polygon, box
    from shapely.ops import unary_union

    return Polygon, box, unary_union, affinity


def part_polygon_at(part: dict[str, Any], x_mm: float, y_mm: float,
                    rotation_deg: float = 0.0,
                    ref_mm: tuple[float, float] | None = None):
    """Đặt contour vào hệ tờ theo pose authoritative.

    ``p_sheet = R(theta) * (p_local - ref) + (tx, ty)`` — đúng công thức kế hoạch §3
    và đúng ``imposition_core::mixed_nesting::transform``.
    """
    Polygon, _box, _union, affinity = _shapely()
    poly = Polygon(part["outer"], part["holes"] or None)
    rx, ry = ref_mm if ref_mm else (0.0, 0.0)
    poly = affinity.translate(poly, xoff=-rx, yoff=-ry)
    if rotation_deg:
        poly = affinity.rotate(poly, rotation_deg, origin=(0, 0), use_radians=False)
    return affinity.translate(poly, xoff=x_mm, yoff=y_mm)


def max_inscribed_rect_mm2(free_geom, usable_w_mm: float, usable_h_mm: float,
                           step_mm: float = FREE_RECT_GRID_MM) -> dict[str, float]:
    """Hình chữ nhật TRỤC CHUẨN lớn nhất còn lồng được vào phần dư của tờ.

    Đây là ĐỀ XUẤT metric "chừa vùng hữu dụng" của Lô 0. Lý do chọn nó:
    phần trăm diện tích không phân biệt được "dư 3 dải mỏng vô dụng" với "dư một
    khoảng vuông đủ chạy đơn khác", mà đúng cái sau mới là thứ nhà in bán được.

    Lưới ``step_mm`` = 1 mm; thuật toán là maximal-rectangle-in-histogram nên
    O(W×H) và xác định (không phụ thuộc thứ tự hình học).
    """
    if free_geom is None or free_geom.is_empty:
        return {"rongMm": 0.0, "caoMm": 0.0, "dienTichMm2": 0.0}

    import numpy as np
    import shapely

    cols = max(1, int(usable_w_mm / step_mm))
    rows = max(1, int(usable_h_mm / step_mm))

    # Rasterize bằng TÂM Ô, vector hoá một lần (shapely.contains_xy). Cách này
    # xác định và nhanh: 300×430 ô là một lời gọi, không phải 129.000 phép boolean.
    xs = (np.arange(cols) + 0.5) * step_mm
    ys = (np.arange(rows) + 0.5) * step_mm
    grid_x, grid_y = np.meshgrid(xs, ys)
    free_mask = shapely.contains_xy(free_geom, grid_x.ravel(), grid_y.ravel())
    free_mask = free_mask.reshape(rows, cols)

    heights = np.zeros(cols, dtype=np.int64)
    best = (0.0, 0.0, 0.0)  # (dienTich, rong, cao)

    for r in range(rows):
        heights = np.where(free_mask[r], heights + 1, 0)
        # Maximal rectangle trong histogram `heights` (stack, O(cols)).
        stack: list[int] = []
        for c in range(cols + 1):
            cur = int(heights[c]) if c < cols else 0
            while stack and int(heights[stack[-1]]) >= cur:
                top = stack.pop()
                left = stack[-1] + 1 if stack else 0
                width_cells = c - left
                cao = int(heights[top])
                area = cao * width_cells * step_mm * step_mm
                if area > best[0]:
                    best = (area, width_cells * step_mm, cao * step_mm)
            stack.append(c)

    return {"rongMm": round(best[1], 2), "caoMm": round(best[2], 2),
            "dienTichMm2": round(best[0], 2)}


def do_metric(placements_mm: list[dict[str, Any]], usable_w_mm: float,
              usable_h_mm: float, dien_tich_min_mm2: float) -> dict[str, Any]:
    """Bộ metric dùng chung cho baseline và smart.

    ``placements_mm``: list ``{"poly": shapely Polygon (đã ở hệ tờ), "sheet": int}``.
    """
    _Polygon, box, unary_union, _affinity = _shapely()
    if not placements_mm:
        return {
            "placedCount": 0,
            "sheetCount": 0,
            "envelopeToCuoiMm2": 0.0,
            "boKhongTrongEnvelopeMm2": 0.0,
            "hcnLonNhatConLai": {"rongMm": 0.0, "caoMm": 0.0, "dienTichMm2": 0.0},
            "soManhDuHuuDung": 0,
            "utilizationPhanTram": 0.0,
        }

    by_sheet: dict[int, list[Any]] = {}
    for item in placements_mm:
        by_sheet.setdefault(int(item["sheet"]), []).append(item["poly"])

    usable = box(0.0, 0.0, usable_w_mm, usable_h_mm)
    tong_dien_tich_part = 0.0
    bo_khong = 0.0
    envelope_to_cuoi = 0.0
    for sheet_idx in sorted(by_sheet):
        polys = by_sheet[sheet_idx]
        dien_tich = sum(p.area for p in polys)
        tong_dien_tich_part += dien_tich
        merged = unary_union(polys)
        x0, y0, x1, y1 = merged.bounds
        env = (x1 - x0) * (y1 - y0)
        bo_khong += max(0.0, env - dien_tich)
        envelope_to_cuoi = env  # sheet cuối = chỉ số lớn nhất

    to_cuoi = sorted(by_sheet)[-1]
    free_to_cuoi = usable.difference(unary_union(by_sheet[to_cuoi]))
    manh_du = [
        g for g in getattr(free_to_cuoi, "geoms", [free_to_cuoi])
        if not g.is_empty and g.area >= dien_tich_min_mm2
    ]

    so_to = len(by_sheet)
    return {
        "placedCount": len(placements_mm),
        "sheetCount": so_to,
        "envelopeToCuoiMm2": round(envelope_to_cuoi, 2),
        "boKhongTrongEnvelopeMm2": round(bo_khong, 2),
        "hcnLonNhatConLai": max_inscribed_rect_mm2(
            free_to_cuoi, usable_w_mm, usable_h_mm
        ),
        "soManhDuHuuDung": len(manh_du),
        "utilizationPhanTram": round(
            100.0 * tong_dien_tich_part / (so_to * usable_w_mm * usable_h_mm), 2
        ),
    }


# ─────────────────────────────────────────────────────────────────────────────
#  Baseline: chạy đúng đường sản xuất hiện hữu
# ─────────────────────────────────────────────────────────────────────────────


def _sheet_of(corpus: dict[str, Any], case: dict[str, Any]) -> dict[str, float]:
    preset = dict(corpus["sheetPresets"][case["sheet"]])
    s = case.get("settingsMm", {})
    for key in ("marginTopMm", "marginBottomMm", "marginLeftMm", "marginRightMm"):
        if key in s:
            preset[key] = s[key]
    preset["usableWMm"] = (
        preset["sheetWidthMm"] - preset["marginLeftMm"] - preset["marginRightMm"]
    )
    preset["usableHMm"] = (
        preset["sheetHeightMm"] - preset["marginTopMm"] - preset["marginBottomMm"]
    )
    return preset


def _settings_effective(corpus: dict[str, Any], case: dict[str, Any]) -> dict[str, Any]:
    """Nở `keThuaSettingsTu` để ca kịch bản dùng đúng settings của ca gốc."""
    base: dict[str, Any] = {}
    parent_id = case.get("keThuaSettingsTu")
    if parent_id:
        for other in corpus["cases"]:
            if other["id"] == parent_id:
                base = dict(other.get("settingsMm", {}))
                break
    base.update(case.get("settingsMm", {}))
    return base


def baseline_sr(pdf_bytes: bytes, page_idx: int, sheet: dict[str, float],
                settings: dict[str, Any], part: dict[str, Any]) -> dict[str, Any]:
    """Baseline S&R — dùng CHUNG hàm mà preview và export đang dùng."""
    from app.workers import pdf_wrapper as pdf_lib
    from app.workers.imposition_finalize import finalize_placements
    from app.workers.sticker_imposer_pkg.layout_compute import (
        compute_sticker_layout_for_page,
    )

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as handle:
        handle.write(pdf_bytes)
        path = handle.name
    try:
        doc = pdf_lib.open(path)
        try:
            shapes = settings.get("detectedShapesByPage") or {}
            shape_override = shapes.get(str(page_idx)) or shapes.get(page_idx)
            layout = compute_sticker_layout_for_page(
                doc[page_idx],
                _pt(sheet["usableWMm"]),
                _pt(sheet["usableHMm"]),
                _pt(settings.get("gapXMm", 0)),
                _pt(settings.get("gapYMm", 0)),
                strategy=settings.get("gridStrategy", "optimal_auto"),
                shape_type_override=shape_override or None,
                bleed_pt=_pt(settings.get("bleedMm", 0)),
                secondary_gap=None,
                cut_type=settings.get("cutType", "default"),
                die_size_mode=settings.get("dieSizeMode", "die"),
                alternate_rotation=settings.get("alternateRotation", "none"),
            )
            items = layout.get("items", []) or []
            placements = finalize_placements(
                items,
                _pt(sheet["usableWMm"]),
                _pt(sheet["usableHMm"]),
                _pt(sheet["marginLeftMm"]),
                _pt(sheet["marginBottomMm"]),
                _pt(sheet["marginTopMm"]),
                page_idx,
            )
        finally:
            doc.close()
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass

    # Cờ cardinal → góc, rồi dựng polygon ở hệ tờ (mm, gốc trái-dưới).
    polys: list[dict[str, Any]] = []
    for placement in placements:
        cell = placement["cell"]
        angle = (90.0 if cell.get("isRotated") else 0.0) + (
            180.0 if cell.get("isRotated180") else 0.0
        )
        x_mm = (placement["abs_x"] - _pt(sheet["marginLeftMm"])) * PTS_TO_MM
        y_mm = (placement["abs_y"] - _pt(sheet["marginBottomMm"])) * PTS_TO_MM
        # Xoay quanh tâm mẫu rồi neo vào bbox của ô — đúng cách renderer đặt ô.
        cx = part["widthMm"] / 2.0
        cy = part["heightMm"] / 2.0
        poly = part_polygon_at(part, 0.0, 0.0, angle, (cx, cy))
        px0, py0, _px1, _py1 = poly.bounds
        from shapely import affinity

        poly = affinity.translate(poly, xoff=x_mm - px0, yoff=y_mm - py0)
        polys.append({"poly": poly, "sheet": 0})

    return {
        "placements": polys,
        "strategyUsed": layout.get("strategyUsed", ""),
        "shapeType": layout.get("shapeType"),
        "trimMm": [
            round(float(layout.get("trimW", 0)) * PTS_TO_MM, 2),
            round(float(layout.get("trimH", 0)) * PTS_TO_MM, 2),
        ],
        "isPageFallback": bool(layout.get("isPageFallback")),
        "widthUsedMm": round(float(layout.get("widthUsed", 0)) * PTS_TO_MM, 2),
        "heightUsedMm": round(float(layout.get("heightUsed", 0)) * PTS_TO_MM, 2),
        "itemsPerSheet": len(placements),
    }


def baseline_gang_sticker(sheet: dict[str, float], settings: dict[str, Any],
                          parts: list[dict[str, Any]]) -> dict[str, Any]:
    """Baseline gang tem bế — MaxRects theo bbox (bin_packing)."""
    from app.workers.sticker_imposer_pkg.bin_packing import (
        solve_auto_fill_mixed,
        solve_offset_mixed,
    )

    gap = _pt(max(settings.get("gapXMm", 0), settings.get("gapYMm", 0)))
    tqbp = settings.get("targetQuantitiesByPage") or {}
    co_sl = any(int(v or 0) > 0 for v in tqbp.values())

    dims = [(i, _pt(p["widthMm"]), _pt(p["heightMm"])) for i, p in enumerate(parts)]
    if co_sl:
        dims_qty = [
            (i, _pt(p["widthMm"]), _pt(p["heightMm"]),
             int(tqbp.get(str(i), tqbp.get(i, 0)) or 0))
            for i, p in enumerate(parts)
        ]
        result = solve_offset_mixed(
            _pt(sheet["usableWMm"]), _pt(sheet["usableHMm"]), dims_qty, gap, True
        )
    else:
        result = solve_auto_fill_mixed(
            _pt(sheet["usableWMm"]), _pt(sheet["usableHMm"]), dims, gap, True
        )

    sheets = result.get("sheets") or [result]
    polys: list[dict[str, Any]] = []
    for sheet_idx, one in enumerate(sheets):
        for placement in one.get("placements", []):
            idx = int(placement["page_idx"])
            angle = 90.0 if placement.get("is_rotated") else 0.0
            part = parts[idx]
            cx = part["widthMm"] / 2.0
            cy = part["heightMm"] / 2.0
            poly = part_polygon_at(part, 0.0, 0.0, angle, (cx, cy))
            px0, py0, _a, _b = poly.bounds
            from shapely import affinity

            poly = affinity.translate(
                poly,
                xoff=placement["x"] * PTS_TO_MM - px0,
                yoff=placement["y"] * PTS_TO_MM - py0,
            )
            polys.append({"poly": poly, "sheet": sheet_idx})

    return {
        "placements": polys,
        "strategyUsed": "maxrects_bbox",
        "itemsPerSheet": len(sheets[0].get("placements", [])),
        "sheetsNeeded": result.get("sheets_needed", result.get("sheet_count", 1)),
        "placedByPage": result.get("placed_by_page", {}),
    }


def baseline_gang_cnc(sheet: dict[str, float], settings: dict[str, Any],
                      parts: list[dict[str, Any]],
                      page_indexes: list[int]) -> dict[str, Any]:
    """Baseline gang CNC — build_cnc_gang_layout (cũng MaxRects bbox)."""
    from app.workers.cnc_layout import build_cnc_gang_layout
    from app.workers.die_detection import MAX_TRIM_PT, DetectedShape, Trim
    from app.workers.shape_types import coerce_shape_type

    shapes = settings.get("detectedShapesByPage") or {}
    tqbp = settings.get("targetQuantitiesByPage") or {}
    gap = _pt(max(settings.get("gapXMm", 0), settings.get("gapYMm", 0)))

    items = []
    for local_idx, page_idx in enumerate(page_indexes):
        part = parts[local_idx]
        raw = shapes.get(str(page_idx)) or shapes.get(page_idx) or "CUSTOM"
        try:
            stype = coerce_shape_type(raw)
        except Exception:
            stype = coerce_shape_type("CUSTOM")
        w = min(MAX_TRIM_PT, max(0.001, _pt(part["widthMm"])))
        h = min(MAX_TRIM_PT, max(0.001, _pt(part["heightMm"])))
        qty = int(tqbp.get(str(page_idx), tqbp.get(page_idx, 0)) or 0)
        items.append(
            (
                DetectedShape(
                    page=page_idx, type=stype, props={}, trim=Trim(w, h),
                    poly=(), source="custom", confidence=0.0,
                ),
                qty,
            )
        )

    result = build_cnc_gang_layout(
        items,
        _pt(sheet["usableWMm"]),
        _pt(sheet["usableHMm"]),
        gap,
        margin_left=_pt(sheet["marginLeftMm"]),
        margin_bottom=_pt(sheet["marginBottomMm"]),
        margin_top=_pt(sheet["marginTopMm"]),
    )

    by_page = {p: i for i, p in enumerate(page_indexes)}
    sheets = result.get("sheets") or [result]
    polys: list[dict[str, Any]] = []
    for sheet_idx, one in enumerate(sheets):
        for placement in one.get("placements", []):
            cell = placement["cell"]
            part = parts[by_page[int(placement["src_page_idx"])]]
            angle = 90.0 if cell.get("isRotated") else 0.0
            cx = part["widthMm"] / 2.0
            cy = part["heightMm"] / 2.0
            poly = part_polygon_at(part, 0.0, 0.0, angle, (cx, cy))
            px0, py0, _a, _b = poly.bounds
            from shapely import affinity

            poly = affinity.translate(
                poly,
                xoff=cell["x"] * PTS_TO_MM - px0,
                yoff=cell["y"] * PTS_TO_MM - py0,
            )
            polys.append({"poly": poly, "sheet": sheet_idx})

    return {
        "placements": polys,
        "strategyUsed": "maxrects_bbox_cnc",
        "itemsPerSheet": len(sheets[0].get("placements", [])),
        "sheetsNeeded": result.get("sheets_needed", 1),
        "sheetCount": result.get("sheet_count", len(sheets)),
        "unplacedPages": result.get("unplaced_pages", []),
    }


# ─────────────────────────────────────────────────────────────────────────────
#  Smart: kernel Rust hiện hữu, cùng hình học
# ─────────────────────────────────────────────────────────────────────────────


def smart_kernel(sheet: dict[str, float], settings: dict[str, Any],
                 parts: list[dict[str, Any]], quantities: list[int],
                 profile: str, seed: int,
                 time_budget_ms: int | None,
                 max_sheets: int = 1,
                 rotation: str = "free") -> dict[str, Any] | None:
    """Chạy ``MixedNestingRun`` trên cùng hình học. ``None`` nếu native thiếu.

    LƯU Ý HỢP ĐỒNG: kernel hiện chỉ nhận MỘT ``gapMm`` vô hướng, không có
    ``fixedObstacles``. Lô 0 dùng ``quantity_fulfillment`` để so cùng số con với
    baseline hiện hữu. Ở đây ta nén gap về
    ``max(gapX, gapY)`` đúng như nhánh gang CNC đang làm — và chính chỗ nén này là
    một trong những quyết định Lô 0 phải trình duyệt.
    """
    try:
        import pdfcompare_native
    except Exception:
        return None

    # `cardinal` là preset THU HẸP miền góc về {0,90,180,270}. Nó tồn tại để trả lời
    # đúng một câu: phần lãi ở nhánh gang đến từ "xếp theo hình thật" hay từ "góc tự
    # do"? Nếu cardinal giữ được phần lớn lãi thì đường render hiện hữu
    # (isRotated/isRotated180) đã đủ và không phải nâng 9 điểm affine.
    if rotation == "cardinal":
        default_rotation: dict[str, Any] = {
            "mode": "discrete",
            "anglesDeg": [0.0, 90.0, 180.0, 270.0],
        }
    elif rotation == "free":
        default_rotation = {"mode": "free"}
    else:
        raise SystemExit(f"rotation lạ: {rotation}")

    request = {
        "protocolVersion": MIXED_NESTING_PROTOCOL_VERSION,
        "seed": seed,
        "profile": profile,
        "sheet": {
            "widthMm": sheet["sheetWidthMm"],
            "heightMm": sheet["sheetHeightMm"],
            "marginMm": {
                "left": sheet["marginLeftMm"],
                "right": sheet["marginRightMm"],
                "top": sheet["marginTopMm"],
                "bottom": sheet["marginBottomMm"],
            },
            "maxSheets": int(max_sheets),
        },
        "gapMm": float(max(settings.get("gapXMm", 0), settings.get("gapYMm", 0))),
        "layoutIntent": "quantity_fulfillment",
        "orientationPolicy": {
            "defaultRotation": default_rotation,
            "reflection": "forbidden",
        },
        "parts": [
            {
                "partId": f"p{i}",
                "quantity": max(1, int(quantities[i])),
                "outer": [[round(x, 6), round(y, 6)] for x, y in part["outer"]],
                "holes": [
                    [[round(x, 6), round(y, 6)] for x, y in ring]
                    for ring in part["holes"]
                ],
                "rotationConstraint": {"mode": "inherit"},
            }
            for i, part in enumerate(parts)
        ],
        "jobId": "lo0-baseline",
    }
    if time_budget_ms:
        request["timeBudgetMs"] = int(time_budget_ms)

    run = pdfcompare_native.MixedNestingRun()
    t0 = time.perf_counter()
    try:
        manifest = json.loads(run.solve(json.dumps(request)))
    except Exception as error:  # hợp đồng/hình học sai là thông tin, không phải crash
        return {"loi": str(error)[:400]}
    giay = time.perf_counter() - t0

    polys: list[dict[str, Any]] = []
    goc_khong_cardinal = 0
    for record in manifest.get("placements", []):
        idx = int(record["partId"][1:])
        pose = record["pose"]
        angle = float(pose["rotationDeg"])
        if min(angle % 90.0, 90.0 - (angle % 90.0)) > 1e-6:
            goc_khong_cardinal += 1
        poly = part_polygon_at(
            parts[idx], float(pose["translateXmm"]), float(pose["translateYmm"]), angle,
        )
        polys.append({"poly": poly, "sheet": int(record["sheetIndex"])})

    stats = manifest.get("stats", {})
    return {
        "placements": polys,
        "rotation": rotation,
        "giay": round(giay, 3),
        "engineVersion": manifest.get("engineVersion"),
        "status": manifest.get("status"),
        "terminationReason": stats.get("terminationReason"),
        "attempts": stats.get("attempts"),
        "orientationEvaluations": stats.get("orientationEvaluations"),
        "poseRefinements": stats.get("poseRefinements"),
        "materialUtilization": stats.get("materialUtilization"),
        "unplacedCount": stats.get("unplacedCount"),
        "validatorValid": manifest.get("validation", {}).get("valid"),
        "gocKhongCardinal": goc_khong_cardinal,
    }


# ─────────────────────────────────────────────────────────────────────────────
#  Chạy một ca
# ─────────────────────────────────────────────────────────────────────────────


def _parts_of_case(corpus: dict[str, Any], case: dict[str, Any],
                   settings: dict[str, Any]) -> tuple[list[dict[str, Any]], list[int], list[int], bytes]:
    """Trả (parts, page_indexes, quantities, pdf_bytes)."""
    src_ids = case.get("sources") or [case["source"]]
    by_id = {s["id"]: s for s in corpus["sources"]}

    pages: list[dict[str, Any]] = []
    for src_id in src_ids:
        pages.extend(pages_of(by_id[src_id]))
    merged_source = {"id": "+".join(src_ids), "pages": pages}
    pdf_bytes = build_pdf(merged_source)

    flow = case["flow"]
    if flow == "cnc_gang" and settings.get("cncTwoSided"):
        page_indexes = list(range(0, len(pages), 2))
    elif flow == "cnc_sr" and settings.get("cncTwoSided"):
        page_indexes = [0]
    elif flow in {"sticker_sr", "cnc_sr"}:
        page_indexes = [0]
    else:
        page_indexes = list(range(len(pages)))

    parts = [canonical_part(pages[i]) for i in page_indexes]
    tqbp = settings.get("targetQuantitiesByPage") or {}
    quantities = [
        int(tqbp.get(str(i), tqbp.get(i, settings.get("targetQuantity", 0))) or 0)
        for i in page_indexes
    ]
    return parts, page_indexes, quantities, pdf_bytes


def chay_ca(corpus: dict[str, Any], case: dict[str, Any], *, lap: int,
            profile: str, seed: int, time_budget_ms: int | None,
            bo_qua_smart: bool,
            rotations: list[str] | None = None) -> dict[str, Any]:
    rotations = rotations or ["free"]
    settings = _settings_effective(corpus, case)
    sheet = _sheet_of(corpus, case)
    flow = case["flow"]

    ket_qua: dict[str, Any] = {
        "id": case["id"],
        "flow": flow,
        "intent": case["intent"],
        "batBuoc": bool(case.get("batBuoc")),
        "nhom": case.get("nhom", "flow"),
        "sheet": {
            "khoMm": [sheet["sheetWidthMm"], sheet["sheetHeightMm"]],
            "vungInMm": [round(sheet["usableWMm"], 3), round(sheet["usableHMm"], 3)],
        },
    }

    try:
        parts, page_indexes, quantities, pdf_bytes = _parts_of_case(
            corpus, case, settings
        )
    except Exception as error:
        ket_qua["loi"] = f"dựng nguồn thất bại: {error}"
        return ket_qua

    if not parts or not parts[0]["outer"]:
        ket_qua["ghiChu"] = "nguồn không có contour kín — ca thất bại có chủ đích"

    dien_tich_min = min(
        (p["widthMm"] * p["heightMm"] for p in parts if p["widthMm"] > 0), default=1.0
    )

    # ── BASELINE, đo `lap` lần ──
    thoi_gian: list[float] = []
    baseline: dict[str, Any] | None = None
    loi_baseline: str | None = None
    for _ in range(lap):
        t0 = time.perf_counter()
        try:
            if flow in {"sticker_sr", "cnc_sr"}:
                baseline = baseline_sr(
                    pdf_bytes, page_indexes[0], sheet, settings, parts[0]
                )
            elif flow == "sticker_gang":
                baseline = baseline_gang_sticker(sheet, settings, parts)
            elif flow == "cnc_gang":
                baseline = baseline_gang_cnc(sheet, settings, parts, page_indexes)
            else:
                raise SystemExit(f"flow lạ: {flow}")
        except Exception as error:
            loi_baseline = f"{type(error).__name__}: {error}"
            break
        thoi_gian.append(time.perf_counter() - t0)

    if baseline is None:
        ket_qua["baseline"] = {"loi": loi_baseline or "không chạy"}
    else:
        metric = do_metric(
            baseline["placements"], sheet["usableWMm"], sheet["usableHMm"], dien_tich_min
        )
        ket_qua["baseline"] = {
            **{k: v for k, v in baseline.items() if k != "placements"},
            "metric": metric,
            "giay": _phan_vi(thoi_gian),
        }
        if loi_baseline:
            ket_qua["baseline"]["loi"] = loi_baseline

    # ── SMART (kernel Rust) — LUÔN giải ĐÚNG MỘT TỜ ──
    #
    # Vì sao một tờ: cả hai intent của đường sản xuất đều là bài toán MỘT TỜ.
    #   - autofill_single_sheet: định nghĩa là một tờ.
    #   - quantity_fulfillment: production dựng MỘT template rồi nhân
    #     (`sheets_needed = ceil(qty / items_per_sheet)`), chứ KHÔNG xếp 5.000
    #     instance rời. Nạp thẳng 5.000 vào kernel là dịch sai bài toán và đo được
    #     là nó nổ deadline ngay ở pha baseline (xem báo cáo Lô 0).
    # Nên ở đây ta đo MẬT ĐỘ MỘT TỜ ở cả hai bên, rồi SUY RA số tờ.
    if bo_qua_smart:
        ket_qua["smart"] = {"boQua": True}
    else:
        bm = (ket_qua.get("baseline", {}).get("metric", {}) or {})
        n_baseline = int(bm.get("placedCount", 0) or 0)
        n_probe = max(len(parts), int(math.ceil(n_baseline * 1.3)) if n_baseline else 8)
        # Chia theo tỉ lệ SL nếu có, không thì chia đều.
        tong_sl = sum(quantities)
        if tong_sl > 0:
            so_luong = [
                max(1, int(round(n_probe * q / tong_sl))) for q in quantities
            ]
        else:
            so_luong = [
                max(1, n_probe // max(1, len(parts))) for _ in parts
            ]

        for rotation in rotations:
            khoa = f"smart_{rotation}"
            rss_truoc = rss_mb()
            smart = smart_kernel(
                sheet, settings, parts, so_luong, profile, seed, time_budget_ms,
                max_sheets=1, rotation=rotation,
            )
            if smart is None:
                ket_qua[khoa] = {
                    "loi": "pdfcompare_native chưa build (maturin develop)"
                }
                continue
            if "loi" in smart:
                ket_qua[khoa] = smart
                continue
            ket_qua[khoa] = {
                **{k: v for k, v in smart.items() if k != "placements"},
                "metric": do_metric(
                    smart["placements"], sheet["usableWMm"], sheet["usableHMm"],
                    dien_tich_min,
                ),
                "quantityProbe": so_luong,
                "rssTruocMb": round(rss_truoc, 1) if rss_truoc else None,
                "rssSauMb": round(rss_mb() or 0.0, 1),
            }
            ket_qua[f"soSanh_{rotation}"] = _so_sanh(
                case, ket_qua["baseline"], ket_qua[khoa], quantities
            )

        # `smart` giữ nguyên nghĩa cũ = miền góc đầu tiên được yêu cầu.
        ket_qua["smart"] = ket_qua.get(f"smart_{rotations[0]}", {})
        ket_qua["soSanh"] = ket_qua.get(f"soSanh_{rotations[0]}", {})

        # Câu hỏi trung tâm: cardinal giữ được bao nhiêu phần lãi của free?
        if len(rotations) > 1 and all(
            "metric" in (ket_qua.get(f"smart_{r}") or {}) for r in rotations
        ):
            b = int((ket_qua["baseline"].get("metric") or {}).get("placedCount", 0) or 0)
            n_card = int(ket_qua["smart_cardinal"]["metric"]["placedCount"])
            n_free = int(ket_qua["smart_free"]["metric"]["placedCount"])
            lai_free = n_free - b
            lai_card = n_card - b
            ket_qua["gocTuDoCoDangKhong"] = {
                "baseline": b,
                "cardinal": n_card,
                "free": n_free,
                "laiCardinal": lai_card,
                "laiFree": lai_free,
                # Cardinal giữ được bao nhiêu % phần lãi mà free đạt được.
                "cardinalGiuDuocPhanTramLai": (
                    round(100.0 * lai_card / lai_free, 1) if lai_free > 0 else None
                ),
                "gocTuDoThemGiaTri": lai_free > lai_card,
            }

    return ket_qua


def _so_sanh(case: dict[str, Any], base: dict[str, Any], smart: dict[str, Any],
             quantities: list[int]) -> dict[str, Any]:
    """So baseline vs smart theo objective lexicographic của kế hoạch §7."""
    bm = base.get("metric", {}) or {}
    sm = smart.get("metric", {}) or {}
    b_placed = int(bm.get("placedCount", 0) or 0)
    s_placed = int(sm.get("placedCount", 0) or 0)

    ket: dict[str, Any] = {
        "motTo_placed_baseline": b_placed,
        "motTo_placed_smart": s_placed,
        "chenhLechPhanTram": (
            round(100.0 * (s_placed - b_placed) / b_placed, 1) if b_placed else None
        ),
        "smartKhongKemBaseline": s_placed >= b_placed,
    }
    if case["intent"] == "quantity_fulfillment":
        tong = sum(quantities)
        ket["tongSlYeuCau"] = tong
        if tong > 0 and b_placed > 0:
            ket["soToSuyRa_baseline"] = math.ceil(tong / b_placed)
        if tong > 0 and s_placed > 0:
            ket["soToSuyRa_smart"] = math.ceil(tong / s_placed)
        if ket.get("soToSuyRa_baseline") and ket.get("soToSuyRa_smart"):
            ket["smartKhongTonThemTo"] = (
                ket["soToSuyRa_smart"] <= ket["soToSuyRa_baseline"]
            )
    else:
        ket["compactness_hcnDuMm2_baseline"] = (
            bm.get("hcnLonNhatConLai", {}).get("dienTichMm2")
        )
        ket["compactness_hcnDuMm2_smart"] = (
            sm.get("hcnLonNhatConLai", {}).get("dienTichMm2")
        )
    return ket


def _phan_vi(mau: list[float]) -> dict[str, Any]:
    if not mau:
        return {"n": 0}
    sorted_mau = sorted(mau)
    return {
        "n": len(mau),
        "p50": round(statistics.median(sorted_mau), 4),
        "p95": round(sorted_mau[min(len(sorted_mau) - 1, int(0.95 * len(sorted_mau)))], 4),
        "min": round(sorted_mau[0], 4),
        "max": round(sorted_mau[-1], 4),
    }


# ─────────────────────────────────────────────────────────────────────────────
#  main
# ─────────────────────────────────────────────────────────────────────────────


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Đo baseline Lô 0 cho true_shape_nesting (chỉ đọc, không sửa gì)."
    )
    parser.add_argument("--lap", type=int, default=3, help="số lần chạy baseline mỗi ca")
    parser.add_argument("--case", action="append", default=None, help="chỉ chạy ca này")
    parser.add_argument("--nhom", default=None, help="chỉ chạy nhóm này")
    parser.add_argument("--chi-bat-buoc", action="store_true", help="chỉ 8 ô ma trận phủ")
    parser.add_argument("--profile", default="balanced",
                        choices=["fast", "balanced", "tight"])
    parser.add_argument("--seed", type=int, default=20260827)
    parser.add_argument("--time-budget-ms", type=int, default=None,
                        help="đặt deadline wall-clock cho kernel (mặc định: work-plan cố định)")
    parser.add_argument("--bo-qua-smart", action="store_true",
                        help="chỉ đo baseline, không chạy kernel Rust")
    parser.add_argument(
        "--rotation", default="free", choices=["free", "cardinal", "ca-hai"],
        help="miền góc của kernel. 'ca-hai' chạy cardinal rồi free để so phần lãi.",
    )
    parser.add_argument("--out", default=None, help="đường dẫn file JSON kết quả")
    args = parser.parse_args()

    with open(_CORPUS, "r", encoding="utf-8") as handle:
        corpus = json.load(handle)

    cases = corpus["cases"]
    if args.case:
        chon = set(args.case)
        cases = [c for c in cases if c["id"] in chon]
    if args.nhom:
        cases = [c for c in cases if c.get("nhom", "flow") == args.nhom]
    if args.chi_bat_buoc:
        cases = [c for c in cases if c.get("batBuoc")]
    if not cases:
        print("Không có ca nào khớp bộ lọc.", file=sys.stderr)
        return 2

    args_rotations = (
        ["cardinal", "free"] if args.rotation == "ca-hai" else [args.rotation]
    )

    ram_tong = ram_may_mb()
    print("=" * 78)
    print("LÔ 0 — ĐO BASELINE true_shape_nesting")
    print(f"corpus v{corpus['corpusVersion']} · {len(cases)} ca · lặp {args.lap} · "
          f"profile {args.profile} · seed {args.seed} · "
          f"miền góc {'+'.join(args_rotations)}")
    if ram_tong:
        nhom_ram = "<8GB" if ram_tong < 8192 else ("<16GB" if ram_tong < 16384 else ">=16GB")
        print(f"RAM máy: {ram_tong:.0f} MB ({nhom_ram}) — quy tắc gating AGENTS.md #1")
    print("=" * 78)

    ket_qua = []
    for thu_tu, case in enumerate(cases, start=1):
        print(f"\n[{thu_tu}/{len(cases)}] đang chạy {case['id']} ...", flush=True)
        row = chay_ca(
            corpus, case,
            lap=args.lap, profile=args.profile, seed=args.seed,
            time_budget_ms=args.time_budget_ms, bo_qua_smart=args.bo_qua_smart,
            rotations=args_rotations,
        )
        ket_qua.append(row)

        base = row.get("baseline", {})
        smart = row.get("smart", {})
        bm = base.get("metric", {})
        sm = smart.get("metric", {})
        dau = "!" if row["batBuoc"] else " "
        print(f"\n{dau} {row['id']}  [{row['flow']} / {row['intent']}]")
        if "loi" in row:
            print(f"    LỖI: {row['loi']}")
            continue
        if "loi" in base:
            print(f"    baseline LỖI: {base['loi']}")
        else:
            print(f"    baseline: {bm.get('placedCount')} con / {bm.get('sheetCount')} tờ"
                  f" · strategy={base.get('strategyUsed')}"
                  f" · util={bm.get('utilizationPhanTram')}%"
                  f" · hcn dư={bm.get('hcnLonNhatConLai', {}).get('rongMm')}×"
                  f"{bm.get('hcnLonNhatConLai', {}).get('caoMm')}mm"
                  f" · p50={base.get('giay', {}).get('p50')}s"
                  f" p95={base.get('giay', {}).get('p95')}s")
        if smart.get("boQua"):
            print("    smart:    (bỏ qua)")
        else:
            for rotation in args_rotations:
                khoi = row.get(f"smart_{rotation}") or {}
                if "loi" in khoi:
                    print(f"    {rotation:<9} LỖI: {khoi['loi']}")
                    continue
                m = khoi.get("metric") or {}
                ss = row.get(f"soSanh_{rotation}") or {}
                dau_hieu = "OK " if ss.get("smartKhongKemBaseline") else "KÉM"
                print(f"    {rotation:<9} {m.get('placedCount')} con"
                      f" · util={m.get('utilizationPhanTram')}%"
                      f" · hcn dư={m.get('hcnLonNhatConLai', {}).get('rongMm')}×"
                      f"{m.get('hcnLonNhatConLai', {}).get('caoMm')}mm"
                      f" · góc lẻ={khoi.get('gocKhongCardinal')}"
                      f" · {khoi.get('giay')}s · {khoi.get('terminationReason')}"
                      f" · [{dau_hieu}] {ss.get('chenhLechPhanTram')}%"
                      + (f" · tờ {ss.get('soToSuyRa_baseline')}→"
                         f"{ss.get('soToSuyRa_smart')}"
                         if "soToSuyRa_baseline" in ss else ""))
            gtd = row.get("gocTuDoCoDangKhong")
            if gtd:
                phan_tram = gtd.get("cardinalGiuDuocPhanTramLai")
                print(f"    KẾT LUẬN: baseline {gtd['baseline']} → cardinal "
                      f"{gtd['cardinal']} (+{gtd['laiCardinal']}) → free "
                      f"{gtd['free']} (+{gtd['laiFree']})"
                      f" · cardinal giữ "
                      f"{phan_tram if phan_tram is not None else 'n/a'}% phần lãi"
                      f" · góc tự do thêm giá trị: "
                      f"{'CÓ' if gtd['gocTuDoThemGiaTri'] else 'KHÔNG'}")

    out_path = Path(args.out) if args.out else (
        Path(tempfile.gettempdir()) / "prynx_lo0" / "ket_qua_lo0.json"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "corpusVersion": corpus["corpusVersion"],
                "profile": args.profile,
                "rotations": args_rotations,
                "seed": args.seed,
                "lap": args.lap,
                "timeBudgetMs": args.time_budget_ms,
                "ramMayMb": ram_tong,
                "peakRssMb": round(peak_rss_mb() or 0.0, 1),
                "cases": ket_qua,
            },
            handle,
            ensure_ascii=False,
            indent=2,
        )
    _peak = peak_rss_mb()
    print(f"\nPeak RSS tiến trình đo: "
          f"{f'{_peak:.1f} MB' if _peak else 'không đọc được'}")
    print(f"Kết quả chi tiết: {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
