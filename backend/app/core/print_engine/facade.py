"""PrintEngineFacade — cửa duy nhất để lớp Python gọi PrynX Print Engine (PPE).

PPE là engine prepress clean-room viết bằng Rust (`print_engine/`), nối vào Python
qua `pdfcompare_native.ppe_separations`. Facade này KHÔNG chứa logic prepread: nó
chỉ dịch contract và quyết định *có được phép tin kết quả hay không*.

# Vì sao cần một facade thay vì gọi native trực tiếp

Ba việc phải làm giống nhau ở mọi caller (`separations.py`, `softproof.py`,
`preflight_rules/ink.py`). Rải ra từng nơi thì chắc chắn có nơi làm thiếu, và
nơi làm thiếu sẽ là nơi báo "đạt ngưỡng mực" trên dữ liệu không đủ tin:

1. **Dịch plate sang contract sẵn có** — `alpha_data` = zlib + base64 của mảng
   `u8`, `255 = 100% mực`. Đây đúng contract `SeparationEngine._create_colored_plate`
   đang trả cho frontend, nên đổi engine không phải đổi API hay code frontend.
2. **Cấp `fallback_font`** — thiếu nó, trang chữ dùng font không nhúng báo
   **0% mực**, tức báo *thiếu* mực. Đó là chiều sai làm hỏng lô in: file quá
   ngưỡng bị coi là đạt.
3. **Map hai trục hỏng sang `accuracy`** — xem bên dưới.

# Hai trục hỏng, và vì sao không gộp

`RenderWarnings` của PPE tách theo *hệ quả với lượng mực* (xem
`print_engine/src/error.rs`):

* `ink_unsound` — có nội dung đáng lẽ phải lên mực mà chưa lên, hoặc lên sai
  lượng (object bị bỏ, transparency chưa dựng, màu phải xấp xỉ, `/OC` có thể
  đang ẩn nội dung). Đỉnh TAC đo được **không** dùng để chốt kẽm ⇒ facade coi
  như PPE thất bại và nhường cho Ghostscript.
* `geometry_approximate` — nội dung *đã* lên mực nhưng hình khác bản gốc (font
  thay thế). Đỉnh mực vùng đặc vẫn đúng; chỉ **diện tích phủ** là ước lượng ⇒
  dùng được cho TAC, nhưng hạ nhãn `accuracy`.

Gộp hai trục thành một cờ nghe an toàn hơn nhưng lại phá chính mục tiêu: gần như
mọi file xưởng thật đều có một nhãn chữ font không nhúng, nên cờ gộp sẽ bật trên
gần hết file và PPE không bao giờ được dùng — trong khi đỉnh mực của nó đúng.

# Ranh giới

Facade là **READ/raster only**. Không ghi PDF ở đây; mọi đường ghi vẫn là pikepdf.
"""

from __future__ import annotations

import base64
import logging
import zlib
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Nhãn `accuracy` trả về. Giữ nguyên chuỗi mà `separations.py` đang dùng để
# frontend không phải biết PPE tồn tại.
ACCURACY_RIP = "rip_separations"
ACCURACY_RIP_APPROX_GEOMETRY = "rip_separations_approx_geometry"


class PpeUnavailable(RuntimeError):
    """Native chưa build, hoặc build cũ chưa có PPE."""


class PpeResultUntrusted(RuntimeError):
    """PPE chạy xong nhưng lượng mực không đủ tin để dùng.

    Không phải lỗi kỹ thuật — engine đã trung thực khai báo giới hạn của chính nó
    (thiếu shading, transparency chưa dựng, `/OC`…). Caller nên nhường cho
    Ghostscript thay vì hạ ngưỡng.
    """

    def __init__(self, reason: str, detail: dict[str, Any] | None = None):
        super().__init__(reason)
        self.reason = reason
        self.detail = detail or {}


def _native():
    try:
        import pdfcompare_native  # type: ignore
    except ImportError as e:  # pragma: no cover - phụ thuộc build
        raise PpeUnavailable(f"pdfcompare_native chưa cài: {e}") from e
    if not hasattr(pdfcompare_native, "ppe_separations"):
        raise PpeUnavailable(
            "pdfcompare_native thiếu ppe_separations — cần rebuild: "
            "maturin develop --release --manifest-path native/Cargo.toml"
        )
    return pdfcompare_native


def is_available() -> bool:
    """`True` khi native có PPE. Dùng để quyết định thứ tự engine, không throw."""
    try:
        _native()
        return True
    except PpeUnavailable:
        return False


def capabilities() -> dict[str, Any]:
    """Capability matrix lấy TỪ Rust, không hardcode ở Python.

    Nguồn duy nhất là code thật: khi một tính năng xong, cờ đổi cùng lúc với code
    nên không thể quên cập nhật ở lớp Python.
    """
    return dict(_native().ppe_capabilities())


def _fallback_font_path() -> str | None:
    """Font TrueType thay cho font PDF không nhúng.

    Rust không tự tìm font: layout assets do lớp đóng gói quyết định (dev chạy từ
    repo, bản phát hành nằm trong sidecar), nên chỉ Python biết font ở đâu.

    Trả `None` khi không có font — khi đó chữ không nhúng font sẽ không được vẽ và
    PPE bật `ink_unsound`, nên kết quả bị loại chứ không lặng lẽ báo thiếu mực.
    """
    here = Path(__file__).resolve()
    for base in (here.parents[2] / "assets" / "fonts", Path.cwd() / "app" / "assets" / "fonts"):
        cand = base / "DejaVuSans.ttf"
        if cand.is_file():
            return str(cand)
    return None


# Màu hiển thị của kẽm process. Đọc từ `SeparationEngine` lúc chạy (xem
# `_plate_color`) chứ không copy hằng số sang đây: hai bảng màu song song sẽ lệch
# nhau khi một bên đổi, và preview đổi màu theo engine là bug người dùng thấy ngay.
def _plate_color(name: str, is_spot: bool) -> list[int]:
    """Màu hiển thị của kẽm. Dùng chung bảng với `SeparationEngine` để preview
    không đổi màu khi đổi engine.

    `PLATE_COLORS` là thuộc tính *instance*, nên phải dựng engine để đọc — không
    có bản class-level nào để tham chiếu.
    """
    from app.core.separations import _lookup_spot_rgb

    if not is_spot:
        table = _process_plate_colors()
        if name in table:
            return table[name]
    return _lookup_spot_rgb(name)


_PROCESS_COLORS_CACHE: dict[str, list[int]] | None = None


def _process_plate_colors() -> dict[str, list[int]]:
    """Bảng màu 4 kẽm process, đọc một lần rồi giữ lại.

    Dựng `SeparationEngine()` mỗi plate sẽ gọi `mkdir` thư mục kết quả 4–5 lần cho
    mỗi trang — công vô ích trên đường chạy nóng.
    """
    global _PROCESS_COLORS_CACHE
    if _PROCESS_COLORS_CACHE is None:
        from app.core.separations import SeparationEngine

        _PROCESS_COLORS_CACHE = dict(SeparationEngine().PLATE_COLORS)
    return _PROCESS_COLORS_CACHE


def separations(
    pdf_path: str,
    page_num: int,
    dpi: int = 100,
    *,
    ink_accurate: bool = False,
    cmyk_profile_id: str | None = "fogra39",
    allow_geometry_approximation: bool = True,
) -> dict[str, Any]:
    """Tách kẽm một trang bằng PPE, trả contract giống `SeparationEngine`.

    `ink_accurate=True` → đo lượng mực DeviceCMYK: **không** ICC, **không** khử
    răng cưa, để vùng đặc đọc đúng 100% mực mỗi kênh. Đây là chế độ cho TAC.
    Quản lý màu ở chế độ này sẽ nén vùng đặc 400% xuống ~292% và biến một file
    vượt giới hạn mực thành "đạt" — nên ICC bị bỏ *có chủ đích*, không phải quên.

    `allow_geometry_approximation=False` → loại cả trang có font thay thế. Dùng
    khi cần con số diện tích phủ chính xác (ví dụ báo giá mực), không cần cho TAC.

    Raises:
        PpeUnavailable: native chưa có PPE.
        PpeResultUntrusted: lượng mực không đủ tin (caller nên fallback GS).
    """
    native = _native()

    cmyk_profile = None
    rgb_profile = None
    if not ink_accurate and cmyk_profile_id:
        # Chỉ đường xem trước mới quản lý màu. Xem docstring: TAC phải đo mực thô.
        from app.core.icc_profiles import resolve_cmyk_profile_path, resolve_srgb_profile_path

        cmyk_profile = resolve_cmyk_profile_path(cmyk_profile_id)
        rgb_profile = resolve_srgb_profile_path()

    raw = native.ppe_separations(
        pdf_path,
        page=page_num,
        dpi=float(dpi),
        ink_accurate=ink_accurate,
        page_box="crop",
        cmyk_profile=cmyk_profile,
        rgb_profile=rgb_profile,
        fallback_font=_fallback_font_path(),
    )

    # ── Cổng tin cậy ────────────────────────────────────────────────────────
    # Đặt TRƯỚC khi dựng plate: dựng xong rồi mới loại là tốn công vô ích, và
    # nguy hiểm hơn — dễ có nhánh trả plate ra ngoài mà bỏ qua cổng này.
    if raw.get("ink_unsound"):
        raise PpeResultUntrusted(
            _explain_unsound(raw),
            {
                "dropped_objects": raw.get("dropped_objects"),
                "unsupported_transparency": raw.get("unsupported_transparency"),
                "hidden_content_risk": raw.get("hidden_content_risk"),
                "approximated_colorspaces": raw.get("approximated_colorspaces"),
                "skipped_ops": raw.get("skipped_ops"),
            },
        )

    geometry_approx = bool(raw.get("geometry_approximate"))
    if geometry_approx and not allow_geometry_approximation:
        raise PpeResultUntrusted(
            "font không nhúng đã phải thay thế nên diện tích phủ chỉ là xấp xỉ",
            {"substituted_fonts": raw.get("substituted_fonts")},
        )

    plates: list[dict[str, Any]] = []
    for p in raw.get("plates", []):
        ink: bytes = p["ink"]
        # zlib level 1: khớp đúng lựa chọn của `_create_colored_plate` — nén nhanh
        # quan trọng hơn nén nhỏ vì payload này đi thẳng ra frontend mỗi lần xem.
        plates.append({
            "name": p["name"],
            "color": _plate_color(p["name"], bool(p.get("is_spot"))),
            "alpha_data": base64.b64encode(zlib.compress(ink, level=1)).decode("utf-8"),
            "is_spot": bool(p.get("is_spot")),
        })

    spot_names = [p["name"] for p in plates if p["is_spot"]]
    result: dict[str, Any] = {
        "width": raw["width"],
        "height": raw["height"],
        "plates": plates,
        "max_tac_pct": raw.get("max_tac_pct"),
        "has_spot_colors": bool(spot_names),
        "detected_spots": spot_names,
        "engine": "ppe",
        "accuracy": ACCURACY_RIP_APPROX_GEOMETRY if geometry_approx else ACCURACY_RIP,
        "quality_note": _quality_note(raw, geometry_approx, ink_accurate),
        # Vết chẩn đoán: giữ để UI giải thích được vì sao accuracy bị hạ.
        "ppe_substituted_fonts": list(raw.get("substituted_fonts") or []),
        "ppe_colorspaces_used": list(raw.get("colorspaces_used") or []),
        "ppe_skipped_ops": list(raw.get("skipped_ops") or []),
    }
    return result


def _explain_unsound(raw: dict[str, Any]) -> str:
    """Lý do người đọc hiểu được, thay vì một cờ boolean."""
    parts: list[str] = []
    if raw.get("dropped_objects"):
        parts.append(f"{raw['dropped_objects']} object chưa vẽ được")
    if raw.get("unsupported_transparency"):
        parts.append("transparency/soft mask chưa dựng")
    if raw.get("hidden_content_risk"):
        parts.append("có optional content (/OC) chưa xét trạng thái bật/tắt")
    approx = raw.get("approximated_colorspaces") or []
    if approx:
        parts.append("màu phải xấp xỉ: " + ", ".join(approx))
    return "PPE: lượng mực chưa đủ tin (" + "; ".join(parts) + ")" if parts else "PPE: lượng mực chưa đủ tin"


def _quality_note(raw: dict[str, Any], geometry_approx: bool, ink_accurate: bool) -> str:
    mode = "đo lượng mực DeviceCMYK" if ink_accurate else "xem trước color-managed"
    note = f"PrynX Print Engine — kẽm process/spot trong không gian mực ({mode})."
    if geometry_approx:
        fonts = ", ".join(raw.get("substituted_fonts") or []) or "không rõ"
        note += (
            f" Font không nhúng đã thay ({fonts}): đỉnh mực vẫn đúng, "
            "nhưng phần trăm diện tích phủ là xấp xỉ."
        )
    return note
