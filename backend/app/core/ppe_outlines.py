"""Nguồn hình học chữ từ PPE cho action `OUTLINE_FONTS` (kế hoạch §19.7).

# Phân chia trách nhiệm

Rust (PPE) lo **font / encoding / ma trận chữ** — ba thứ đã được đo song song với
Ghostscript qua bộ golden 53 fixture. Python lo **ghi PDF** bằng pikepdf, thứ Rust
không có. Trước đó `outline_text.py` tự làm cả hai bằng fontTools và vấp đúng ở
phần của Rust: 6 file corpus tra glyph thất bại, 2 file font ngoài phạm vi, Type3
chưa đụng tới.

# Hợp đồng đồng bộ chỉ số — chỗ duy nhất có thể sai lặng lẽ

PPE và bộ ghi PDF đi qua **cùng một** content stream nhưng bằng hai bộ code khác
nhau, nên phải khớp nhau ở ba mốc:

1. `stream` — content stream nào (trang hay Form XObject nào).
2. `text_object_index` — khối `BT … ET` thứ mấy trong stream đó.
3. `glyph_index` — mã ký tự thứ mấy trong khối đó, **đếm cả dấu cách và `Tr 3`**.

Nếu ba mốc này lệch, path của glyph này bị gán cho glyph khác: file vẫn mở được,
vẫn có chữ, chỉ sai chỗ — kiểu hỏng chỉ phát hiện được khi đã in. Vì vậy module
này **không đoán**: thiếu mốc thì trả `None` và bộ ghi tự lùi về đường fontTools,
rồi chốt so-kẽm vẫn chặn ở cuối như trước.

Ngoài ba mốc, engine còn khai **số mã ký tự của từng khối** (`code_count`). Bộ ghi
đếm lại bằng code của chính nó và chỉ tin path của PPE cho những khối khớp số — nhờ
vậy lệch chỉ số trở thành *không thể xảy ra* thay vì *được lưới so-kẽm bắt kịp*, và
không còn phụ thuộc glyph to hay nhỏ (audit lần 3 §3.2).
"""

from __future__ import annotations

import logging
from typing import Any

import pikepdf

logger = logging.getLogger(__name__)

# Mã lệnh do `print_engine/src/text/outlines.rs` phát ra. Đổi bên đó thì phải đổi
# ở đây — hai hằng này là một hợp đồng, không phải hai bản sao độc lập.
_VERB_MOVE = 0
_VERB_LINE = 1
_VERB_CUBIC = 2
_VERB_CLOSE = 3

_COORDS_PER_VERB = {_VERB_MOVE: 2, _VERB_LINE: 2, _VERB_CUBIC: 6, _VERB_CLOSE: 0}
_OPERATOR_OF_VERB = {_VERB_MOVE: "m", _VERB_LINE: "l", _VERB_CUBIC: "c", _VERB_CLOSE: "h"}


class PpeUnavailable(RuntimeError):
    """Native chưa có `ppe_text_outlines` (bản build cũ)."""


def _native():
    import pdfcompare_native  # noqa: PLC0415 — nạp lười: import lúc khởi động sẽ

    # kéo cả extension vào mọi tiến trình backend dù không dùng tới.
    if not hasattr(pdfcompare_native, "ppe_text_outlines"):
        raise PpeUnavailable(
            "pdfcompare_native thiếu ppe_text_outlines — cần rebuild: "
            "maturin develop --release --manifest-path native/Cargo.toml"
        )
    return pdfcompare_native


def stream_key_of(obj) -> tuple[int, int] | str:
    """Khoá stream của một object pikepdf, khớp dạng PPE trả về.

    Form XObject là object gián tiếp ⇒ `(objgen)`. Content stream của trang được
    PPE gọi là `"page"`.
    """
    try:
        if getattr(obj, "is_indirect", False):
            return (int(obj.objgen[0]), int(obj.objgen[1]))
    except Exception:  # noqa: BLE001
        pass
    return "unaddressable"


def _stream_of(entry: dict[str, Any]):
    """Khoá stream trong một mục báo cáo, đưa list `[obj, gen]` về tuple để tra được."""
    stream = entry.get("stream")
    if isinstance(stream, (list, tuple)):
        return (int(stream[0]), int(stream[1]))
    return stream


class PpeGlyphSource:
    """Đường viền glyph của MỘT trang, tra theo ba mốc đồng bộ."""

    def __init__(self, report: dict[str, Any]):
        self._by_key: dict[tuple[Any, int, int], dict] = {}
        for g in report.get("glyphs", []):
            stream = _stream_of(g)
            key = (stream, int(g.get("text_object_index", 0)), int(g.get("glyph_index", 0)))
            self._by_key[key] = g
        # OUT-FONT (audit lần 3 §3.2): số mã ký tự mỗi khối `BT … ET` theo khai báo của
        # engine. Đây là chốt chống lệch chỉ số bằng SỐ LƯỢNG — xem `code_count`.
        self._block_codes: dict[tuple[Any, int], int] = {}
        for b in report.get("blocks", []):
            self._block_codes[(_stream_of(b), int(b.get("text_object_index", 0)))] = int(
                b.get("code_count", 0)
            )
        self.has_type3 = bool(report.get("has_type3"))
        self.has_unsupported_context = bool(report.get("has_unsupported_context"))
        self.missing_glyphs = int(report.get("missing_glyphs", 0))
        self.complete = bool(report.get("complete"))
        self.substituted_fonts = list(report.get("substituted_fonts") or [])

    # ── Nạp ─────────────────────────────────────────────────────────────────
    @classmethod
    def for_page(
        cls,
        pdf_path: str,
        page: int,
        fallback_font: str | None = None,
    ) -> "PpeGlyphSource":
        """Thu thập đường viền chữ của một trang (1-based).

        Raises:
            PpeUnavailable: native chưa có hàm.
            RuntimeError: PPE không đọc được trang.
        """
        native = _native()
        report = native.ppe_text_outlines(
            pdf_path,
            page=page,
            fallback_font=fallback_font or None,
        )
        return cls(dict(report))

    # ── Tra cứu ─────────────────────────────────────────────────────────────
    def why_incomplete(self) -> str | None:
        """Lý do không dùng được nguồn này cho cả trang, hoặc `None` nếu dùng được."""
        if self.has_type3:
            return "trang có font Type3 (glyph là content stream, không phải đường viền)"
        if self.has_unsupported_context:
            return "có chữ trong soft mask / tiling pattern / form không địa chỉ hoá được"
        if self.missing_glyphs:
            return f"{self.missing_glyphs} glyph không tra được đường viền"
        return None

    def code_count(self, stream: Any, text_object_index: int) -> int | None:
        """Số mã ký tự engine đã đi qua trong một khối `BT … ET`, hoặc `None`.

        `None` nghĩa là engine không khai gì cho khối đó (bản native cũ, hoặc khối
        engine không tới được). Caller phải coi đó là "không đối chiếu được" và lùi về
        đường fontTools, chứ KHÔNG được suy ra "khối rỗng".

        Vì sao đối chiếu bằng số lượng: hai bên đi qua cùng content stream bằng hai bộ
        code khác nhau, nên rủi ro thật là **lệch chỉ số** — path glyph này bị gán cho
        glyph khác. Khớp số mã trong cùng một khối ⇒ chỉ số khớp theo cấu trúc, không
        phụ thuộc glyph to hay nhỏ và không cần ngưỡng nào. Chốt hình học trước đó phụ
        thuộc kích thước: dấu chấm 12pt chỉ 9 px mực nên lưới so-kẽm bỏ qua, và chữ
        dịch 30pt vẫn báo hậu kiểm thành công (audit lần 3 §3.2).
        """
        return self._block_codes.get((stream, int(text_object_index)))

    def path_for(
        self,
        stream: Any,
        text_object_index: int,
        glyph_index: int,
    ) -> list | None:
        """Instruction pikepdf cho một glyph, hoặc `None` nếu PPE không có nó.

        `None` có hai nghĩa hợp lệ — glyph rỗng (dấu cách) và `Tr 3` — nên caller
        KHÔNG được coi đây là lỗi; nó chỉ có nghĩa "không có gì để vẽ".
        """
        g = self._by_key.get((stream, int(text_object_index), int(glyph_index)))
        if g is None:
            return None
        return instructions_from_glyph(g)


def instructions_from_glyph(glyph: dict[str, Any]) -> list:
    """Đổi `(verbs, coords)` của PPE thành instruction pikepdf.

    Toạ độ đã nằm trong không gian người dùng của stream, nên **không** biến đổi
    thêm gì ở đây: mọi `cm` phía trước vẫn còn hiệu lực trong stream và sẽ tự áp.
    """
    verbs = bytes(glyph.get("verbs") or b"")
    coords = [float(v) for v in (glyph.get("coords") or [])]
    out: list = []
    i = 0
    for v in verbs:
        n = _COORDS_PER_VERB.get(v)
        op = _OPERATOR_OF_VERB.get(v)
        if n is None or op is None:
            raise ValueError(f"mã lệnh path không hợp lệ từ PPE: {v}")
        if i + n > len(coords):
            raise ValueError("chuỗi toạ độ từ PPE ngắn hơn chuỗi mã lệnh")
        operands = [round(coords[i + k], 4) for k in range(n)]
        out.append((operands, pikepdf.Operator(op)))
        i += n
    if i != len(coords):
        raise ValueError("còn toạ độ chưa dùng — verbs và coords không khớp")
    return out
