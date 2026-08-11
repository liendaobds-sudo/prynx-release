"""Chuyển chữ thành đường vector (outline) bằng fontTools — không cần Ghostscript.

Vì sao viết riêng thay vì gọi `-dNoOutputFonts`: Ghostscript làm được việc này,
nhưng nó dựng lại toàn bộ tài liệu và (đã đo ở §16.7) bỏ sót text trong
annotation/AcroForm. Ở đây ta chỉ thay đúng các toán tử chữ trong content
stream, phần còn lại của trang không bị đụng.

# Phạm vi có chủ ý

Chỉ nhận những gì chắc chắn dựng lại đúng; mọi thứ khác trả `supported=False`
để caller dừng an toàn và giữ nguyên file nguồn:

* Font **đã nhúng** (`/FontFile2` TrueType hoặc `/FontFile3` CFF/OpenType).
  Font chưa nhúng phải mượn glyph của font khác — mặt chữ sẽ khác bản gốc.
* **Simple font** (mã 1 byte) và `Type0` Identity-H dùng `CIDFontType2` khi
  `/CIDToGIDMap` cùng tài nguyên bắt buộc đều hợp lệ.
* Chưa hỗ trợ Identity-V, CMap tùy biến, `CIDFontType0` và `Type3` (glyph là
  content stream, cần một bộ nội suy khác).

Sai một phép biến đổi ở đây thì chữ lệch mà **chỉ lộ ra lúc in**, nên caller
bắt buộc phải verify (so kẽm trước/sau) trước khi tin kết quả.
"""

from __future__ import annotations

from decimal import Decimal
import logging
import math
import os

import pikepdf

logger = logging.getLogger(__name__)


def _raise_if_cancelled(cancel_check) -> None:
    """Dừng cooperative giữa các trang/pha hậu kiểm của tác vụ outline."""
    if cancel_check is not None and cancel_check():
        raise InterruptedError("Tác vụ outline chữ đã bị hủy.")

# Toán tử đặt/chỉnh chữ mà bộ chuyển này hiểu. Gặp toán tử chữ NGOÀI danh sách
# nghĩa là có tính năng chưa mô hình hoá → dừng, không đoán.
_TEXT_OPS = {
    "BT", "ET", "Tf", "Td", "TD", "Tm", "T*", "TL", "Tc", "Tw", "Tz", "Ts",
    "Tr", "Tj", "TJ", "'", '"',
}

# Trần độ sâu Form XObject lồng nhau — chặn file tự tham chiếu làm đệ quy vô hạn.
_MAX_FORM_DEPTH = 12


def _deref(obj):
    """Giải tham chiếu gián tiếp, trả nguyên object nếu vốn đã trực tiếp.

    `hasattr(obj, "resolve")` LUÔN đúng với mọi `pikepdf.Object`, nhưng gọi
    `.resolve()` trên object trực tiếp (Name, số, Array) ném `ValueError`. Bẫy
    này đã được ghi ở §17.5 của plan — và vẫn vấp lại khi viết module mới, nên
    dùng helper chứ đừng lặp lại thành ngữ sai.
    """
    try:
        return obj.resolve() if getattr(obj, "is_indirect", False) else obj
    except Exception:  # noqa: BLE001
        return obj


def _is_pdf_number(value) -> bool:
    """Số do pikepdf parse có thể là `Decimal`, không chỉ `int`/`float`."""
    return isinstance(value, (int, float, Decimal))


def _objkey(obj) -> tuple[int, int] | None:
    """Danh tính object, để mỗi Form XObject chỉ được outline một lần."""
    try:
        og = obj.objgen
    except Exception:  # noqa: BLE001
        return None
    return None if og == (0, 0) else tuple(og)


class _Matrix:
    __slots__ = ("a", "b", "c", "d", "e", "f")

    def __init__(self, a=1.0, b=0.0, c=0.0, d=1.0, e=0.0, f=0.0):
        self.a, self.b, self.c, self.d, self.e, self.f = a, b, c, d, e, f

    def then(self, m: "_Matrix") -> "_Matrix":
        return _Matrix(
            self.a * m.a + self.b * m.c,
            self.a * m.b + self.b * m.d,
            self.c * m.a + self.d * m.c,
            self.c * m.b + self.d * m.d,
            self.e * m.a + self.f * m.c + m.e,
            self.e * m.b + self.f * m.d + m.f,
        )

    def apply(self, x: float, y: float) -> tuple[float, float]:
        return (self.a * x + self.c * y + self.e, self.b * x + self.d * y + self.f)


class _OutlinePen:
    """Gom lệnh vẽ glyph thành toán tử path PDF, đã biến đổi sang toạ độ trang."""

    def __init__(self, matrix: _Matrix, out: list):
        self._m = matrix
        self._out = out
        self._start: tuple[float, float] | None = None

    def _pt(self, pt) -> list[float]:
        x, y = self._m.apply(pt[0], pt[1])
        return [round(x, 4), round(y, 4)]

    def moveTo(self, pt):
        self._out.append((self._pt(pt), pikepdf.Operator("m")))
        self._start = pt

    def lineTo(self, pt):
        self._out.append((self._pt(pt), pikepdf.Operator("l")))

    def curveTo(self, *points):
        # BasePen đã quy mọi đường cong về bậc ba trước khi gọi tới đây.
        if len(points) == 3:
            a, b, c = points
            self._out.append((self._pt(a) + self._pt(b) + self._pt(c), pikepdf.Operator("c")))
        elif len(points) == 2:  # quadratic còn sót
            a, b = points
            self._out.append((self._pt(a) + self._pt(b) + self._pt(b), pikepdf.Operator("c")))

    def qCurveTo(self, *points):
        # Quadratic của TrueType: nâng lên bậc ba để PDF vẽ được.
        if not points or self._start is None:
            return
        current = self._start
        for i in range(len(points) - 1):
            ctrl = points[i]
            nxt = points[i + 1]
            if nxt is None:
                continue
            c1 = (current[0] + 2 / 3 * (ctrl[0] - current[0]),
                  current[1] + 2 / 3 * (ctrl[1] - current[1]))
            c2 = (nxt[0] + 2 / 3 * (ctrl[0] - nxt[0]),
                  nxt[1] + 2 / 3 * (ctrl[1] - nxt[1]))
            self._out.append(
                (self._pt(c1) + self._pt(c2) + self._pt(nxt), pikepdf.Operator("c"))
            )
            current = nxt
        self._start = current

    def closePath(self):
        self._out.append(([], pikepdf.Operator("h")))

    def endPath(self):
        pass

    def addComponent(self, name, transform):
        pass  # thành phần ghép được getGlyphSet phẳng hoá sẵn


def _is_bare_cff(data: bytes) -> bool:
    """CFF trần bắt đầu bằng header `major=1, minor=0, hdrSize, offSize`.

    Container OpenType/TrueType bắt đầu bằng `OTTO`, `true`, `ttcf` hoặc
    `0x00010000` — không lẫn với CFF được.
    """
    if len(data) < 4:
        return False
    if data[:4] in (b"OTTO", b"true", b"ttcf", bytes([0, 1, 0, 0])):
        return False
    return data[0] == 1 and data[1] == 0


class _CffGlyphSet:
    """Bọc `CharStrings` của CFF cho giống giao diện glyph set của fontTools."""

    def __init__(self, charstrings):
        self._cs = charstrings

    def __contains__(self, name):
        return name in self._cs

    def __getitem__(self, name):
        return self._cs[name]

    def keys(self):
        return self._cs.keys()


class _EmbeddedFont:
    """Font đã nhúng, sẵn sàng tra outline theo mã ký tự."""

    def __init__(self, font_dict, pdf: pikepdf.Pdf):
        from fontTools.ttLib import TTFont

        self.ok = False
        self.glyph_set = None
        self.upem = 1000.0
        self.widths: dict[int, float] = {}
        self.code_to_glyph: dict[int, str] = {}
        # `Type0` dùng mã HAI byte; mọi phép tính advance và tra glyph đều rẽ
        # theo cờ này. Word spacing (`Tw`) cũng KHÔNG áp cho mã 2 byte (§9.3.3)
        # — áp nhầm sẽ giãn chữ ở mọi ký tự chứa byte 0x20.
        self.two_byte = False
        self.default_width = 1000.0

        if str(font_dict.get("/Subtype", "")) == "/Type0":
            self._init_type0(font_dict, TTFont)
            return

        try:
            desc = font_dict.get("/FontDescriptor")
            if desc is None:
                return
            desc = desc if isinstance(desc, pikepdf.Dictionary) else desc.resolve()
            data = None
            for key in ("/FontFile2", "/FontFile3"):
                ff = desc.get(key)
                if ff is not None:
                    data = bytes((ff if isinstance(ff, pikepdf.Stream) else ff.resolve()).read_bytes())
                    break
            if data is None:
                return

            import io

            if _is_bare_cff(data):
                # `/FontFile3` Subtype `/Type1C` là **CFF trần**, không có
                # container OpenType — `TTFont()` không mở được. Đây là dạng
                # chiếm đa số font Type1 nhúng trong file thật (đo corpus:
                # 75/302 font), nên bỏ qua nó là bỏ qua phần lớn công việc.
                if not self._load_cff(data, font_dict):
                    return
            else:
                tt = TTFont(io.BytesIO(data), fontNumber=0, lazy=True)
                self.glyph_set = tt.getGlyphSet()
                self.upem = float(tt["head"].unitsPerEm) if "head" in tt else 1000.0
                self._build_encoding(font_dict, tt)
            self._build_widths(font_dict)
            self.ok = bool(self.code_to_glyph)
        except Exception as exc:  # noqa: BLE001
            logger.debug("không nạp được font nhúng: %s", exc)
            self.ok = False

    def _init_type0(self, font_dict, TTFont) -> None:
        """Nạp `Type0` / `Identity-H` / `CIDFontType2`.

        Ở dạng này mã 2 byte **chính là CID**, và `/CIDToGIDMap /Identity` cho
        GID = CID — nên tra glyph chỉ là chỉ số trong glyph order, không qua
        cmap. Nếu `/CIDToGIDMap` là stream thì đọc bảng 2 byte big-endian.
        """
        import io as _io

        try:
            kid = _descendant_of(font_dict)
            desc = kid.get("/FontDescriptor")
            desc = desc if isinstance(desc, pikepdf.Dictionary) else desc.resolve()
            ff = desc.get("/FontFile2")
            data = bytes((ff if isinstance(ff, pikepdf.Stream) else ff.resolve()).read_bytes())

            tt = TTFont(_io.BytesIO(data), fontNumber=0, lazy=True)
            self.glyph_set = tt.getGlyphSet()
            self.upem = float(tt["head"].unitsPerEm) if "head" in tt else 1000.0
            glyph_order = tt.getGlyphOrder()

            cid_to_gid = None
            c2g = kid.get("/CIDToGIDMap")
            if c2g is not None and not isinstance(c2g, pikepdf.Name):
                raw = bytes((c2g if isinstance(c2g, pikepdf.Stream) else c2g.resolve()).read_bytes())
                cid_to_gid = raw

            self.two_byte = True
            self.default_width = float(kid.get("/DW", 1000))
            self._parse_w(kid.get("/W"))

            # Dựng bảng CID → tên glyph một lần; file thật dùng vài trăm CID nên
            # duyệt hết glyph order rẻ hơn tra từng lần.
            limit = len(glyph_order)
            for cid in range(min(limit, 0x10000)):
                gid = cid
                if cid_to_gid is not None:
                    idx = cid * 2
                    if idx + 1 >= len(cid_to_gid):
                        continue
                    gid = (cid_to_gid[idx] << 8) | cid_to_gid[idx + 1]
                if 0 <= gid < limit:
                    self.code_to_glyph[cid] = glyph_order[gid]
            self.ok = bool(self.code_to_glyph)
        except Exception as exc:  # noqa: BLE001
            logger.debug("không nạp được font Type0: %s", exc)
            self.ok = False

    def _parse_w(self, w_array) -> None:
        """`/W` của CIDFont: `[c [w…]]` hoặc `[cFirst cLast w]`, xen kẽ nhau."""
        if w_array is None:
            return
        try:
            # [OUT-FONT FIX 2026-07-28] Object trực tiếp của pikepdf cũng có
            # `resolve` nhưng gọi vào Array trực tiếp sẽ ném ValueError.
            items = [_deref(x) for x in w_array]
            i = 0
            while i < len(items):
                first = int(items[i])
                if i + 1 >= len(items):
                    break
                nxt = items[i + 1]
                if isinstance(nxt, pikepdf.Array):
                    for offset, width in enumerate(nxt):
                        self.widths[first + offset] = float(width)
                    i += 2
                else:
                    if i + 2 >= len(items):
                        break
                    last = int(nxt)
                    width = float(items[i + 2])
                    # Khoảng CID có thể rất rộng; chỉ ghi khi hợp lý để không
                    # dựng bảng hàng triệu ô cho một font.
                    if 0 <= last - first <= 65535:
                        for cid in range(first, last + 1):
                            self.widths[cid] = width
                    i += 3
        except Exception as exc:  # noqa: BLE001
            logger.debug("không đọc được /W: %s", exc)

    def _load_cff(self, data: bytes, font_dict) -> bool:
        """Nạp CFF trần. Trả `False` nếu không dựng được bảng mã→glyph."""
        import io as _io

        from fontTools.cffLib import CFFFontSet

        try:
            cff = CFFFontSet()
            cff.decompile(_io.BytesIO(data), None)
            top = cff[cff.fontNames[0]]
            # [OUT-FONT FIX 2026-07-28] CFF name-keyed được phép bỏ toán tử
            # `charset`; khi đó chuẩn CFF quy định dùng ISOAdobe (offset 0).
            # fontTools khi đọc CFF trần không tự gắn mặc định này như lúc đọc
            # qua container OpenType, làm `top.CharStrings` ném AttributeError.
            if getattr(top, "charset", None) is None and not hasattr(top, "ROS"):
                from fontTools.cffLib import cffISOAdobeStrings

                glyph_count = int(getattr(top, "numGlyphs", 0))
                if not 0 < glyph_count <= len(cffISOAdobeStrings):
                    return False
                top.charset = cffISOAdobeStrings[:glyph_count]
            charstrings = top.CharStrings
            self.glyph_set = _CffGlyphSet(charstrings)

            # CFF khai tỉ lệ qua `FontMatrix`; mặc định 1/1000 (§9.6.6.2).
            matrix = top.rawDict.get("FontMatrix")
            if matrix and float(matrix[0]) != 0:
                self.upem = 1.0 / float(matrix[0])
            else:
                self.upem = 1000.0

            names = list(charstrings.keys())
            # Encoding: `/Differences` của PDF thắng, rồi tới encoding trong
            # chính CFF, cuối cùng là StandardEncoding.
            self._build_cff_encoding(font_dict, top, names)
            return bool(self.code_to_glyph)
        except Exception as exc:  # noqa: BLE001
            logger.debug("không nạp được CFF: %s", exc)
            return False

    def _build_cff_encoding(self, font_dict, top, names) -> None:
        from fontTools.agl import UV2AGL
        from fontTools.encodings.StandardEncoding import StandardEncoding

        base: dict[int, str] = {}
        try:
            enc = top.rawDict.get("Encoding")
            if isinstance(enc, list):
                for code, gname in enumerate(enc):
                    if gname and gname != ".notdef":
                        base[code] = gname
        except Exception:  # noqa: BLE001
            pass

        encoding = font_dict.get("/Encoding")
        enc_obj = None
        base_name = ""
        if encoding is not None:
            enc_obj = _deref(encoding)
            base_name = (
                str(enc_obj.get("/BaseEncoding", ""))
                if isinstance(enc_obj, pikepdf.Dictionary)
                else str(enc_obj)
            )

        # `/BaseEncoding /WinAnsiEncoding` phải dùng bảng WinAnsi, KHÔNG phải
        # StandardEncoding: hai bảng khác nhau đúng ở vùng mã cao — nơi mọi ký
        # tự có dấu nằm. Dùng nhầm thì chữ tiếng Việt không tra được glyph và
        # cả file bị từ chối (đo được: mã 225/236 trượt trên 3 file corpus).
        if "WinAnsi" in base_name or not base:
            for code in range(32, 256):
                try:
                    uv = ord(bytes([code]).decode("cp1252"))
                except Exception:  # noqa: BLE001
                    continue
                gname = UV2AGL.get(uv)
                if gname:
                    base.setdefault(code, gname)
        if not base:
            for code, gname in enumerate(StandardEncoding):
                if gname and gname != ".notdef":
                    base[code] = gname

        if enc_obj is not None:
            if isinstance(enc_obj, pikepdf.Dictionary):
                differences = enc_obj.get("/Differences")
                if differences is not None:
                    current = 0
                    for item in differences:
                        item = _deref(item)
                        if _is_pdf_number(item):
                            current = int(item)
                        else:
                            base[current] = str(item).lstrip("/")
                            current += 1

        for code, gname in base.items():
            if gname in names:
                self.code_to_glyph[code] = gname

    def _build_encoding(self, font_dict, tt) -> None:
        """Mã 1 byte → tên glyph.

        Ba nguồn, theo đúng thứ tự ưu tiên của §9.6.6: `/Differences` ghi đè
        từng mã; phần còn lại theo base encoding; font symbolic thì tra thẳng
        cmap (3,0) — nơi mã thường nằm ở `0xF0xx`.
        """
        from fontTools.agl import toUnicode

        glyph_order = tt.getGlyphOrder()
        cmap = {}
        try:
            cmap = tt.getBestCmap() or {}
        except Exception:  # noqa: BLE001
            cmap = {}
        # Font subset thường chỉ mang một bảng cmap hẹp. Ngoài (3,0) symbol,
        # (1,0) Mac Roman cũng hay là bảng DUY NHẤT trong subset TrueType —
        # bỏ nó thì phần lớn mã không tra được glyph và chữ biến mất.
        symbol_cmap = {}
        mac_cmap = {}
        try:
            for table in tt["cmap"].tables:
                pair = (table.platformID, table.platEncID)
                if pair == (3, 0) and not symbol_cmap:
                    symbol_cmap = table.cmap
                elif pair == (1, 0) and not mac_cmap:
                    mac_cmap = table.cmap
        except Exception:  # noqa: BLE001
            pass

        base_names: dict[int, str] = {}
        encoding = font_dict.get("/Encoding")
        differences = None
        base_name = ""
        if encoding is not None:
            enc = encoding if isinstance(encoding, (pikepdf.Dictionary, pikepdf.Name)) else encoding.resolve()
            if isinstance(enc, pikepdf.Dictionary):
                base_name = str(enc.get("/BaseEncoding", ""))
                differences = enc.get("/Differences")
            else:
                base_name = str(enc)

        from fontTools.encodings.StandardEncoding import StandardEncoding

        table = StandardEncoding
        if "WinAnsi" in base_name:
            import fontTools.encodings.codecs  # noqa: F401

            table = None  # dùng latin-1 bên dưới

        for code in range(256):
            name = None
            if table is not None and code < len(table):
                name = table[code] or None
            if name in (None, ".notdef"):
                try:
                    char = bytes([code]).decode("cp1252")
                    name = cmap.get(ord(char))
                except Exception:  # noqa: BLE001
                    name = None
            if name:
                base_names[code] = name

        if differences is not None:
            current = 0
            for item in differences:
                item = _deref(item)
                if _is_pdf_number(item):
                    current = int(item)
                else:
                    base_names[current] = str(item).lstrip("/")
                    current += 1

        for code in range(256):
            name = base_names.get(code)
            if name and name in glyph_order:
                self.code_to_glyph[code] = name
                continue
            # Symbolic: cmap (3,0) khoá theo 0xF000|code hoặc chính code;
            # rồi (1,0) Mac Roman khoá thẳng theo mã.
            for source, key in (
                (symbol_cmap, 0xF000 | code),
                (symbol_cmap, code),
                (mac_cmap, code),
            ):
                gname = source.get(key)
                if gname:
                    self.code_to_glyph[code] = gname
                    break
            else:
                if name:
                    try:
                        uni = toUnicode(name)
                        if uni and ord(uni[0]) in cmap:
                            self.code_to_glyph[code] = cmap[ord(uni[0])]
                    except Exception:  # noqa: BLE001
                        pass

    def _build_widths(self, font_dict) -> None:
        try:
            first = int(font_dict.get("/FirstChar", 0))
            widths = font_dict.get("/Widths")
            if widths is None:
                return
            widths = widths if isinstance(widths, pikepdf.Array) else widths.resolve()
            for i, w in enumerate(widths):
                self.widths[first + i] = float(w)
        except Exception:  # noqa: BLE001
            pass

    def width(self, code: int) -> float:
        """Bề rộng theo đơn vị 1/1000 em (quy ước `/Widths` của PDF)."""
        if code in self.widths:
            return self.widths[code]
        if self.two_byte:
            return self.default_width
        name = self.code_to_glyph.get(code)
        if name and self.glyph_set is not None:
            try:
                return self.glyph_set[name].width * 1000.0 / self.upem
            except Exception:  # noqa: BLE001
                return 500.0
        return 500.0  # không tra được: `/Widths` của PDF thường đã phủ hết

    def draw(self, code: int, matrix: _Matrix, out: list) -> bool:
        name = self.code_to_glyph.get(code)
        if not name or self.glyph_set is None:
            return False
        try:
            from fontTools.pens.basePen import BasePen

            class _Adapter(BasePen):
                def __init__(self, glyph_set, pen):
                    super().__init__(glyph_set)
                    self.pen = pen

                def _moveTo(self, pt):
                    self.pen.moveTo(pt)

                def _lineTo(self, pt):
                    self.pen.lineTo(pt)

                def _curveToOne(self, a, b, c):
                    self.pen.curveTo(a, b, c)

                def _closePath(self):
                    self.pen.closePath()

            pen = _OutlinePen(matrix, out)
            self.glyph_set[name].draw(_Adapter(self.glyph_set, pen))
            return True
        except Exception as exc:  # noqa: BLE001
            logger.debug("không vẽ được glyph %s: %s", name, exc)
            return False


def _descendant_of(font_dict):
    """Font con của một `Type0`, hoặc `None`."""
    try:
        kids = font_dict.get("/DescendantFonts")
        if kids is None or len(kids) == 0:
            return None
        kid = kids[0]
        return kid if isinstance(kid, pikepdf.Dictionary) else kid.resolve()
    except Exception:  # noqa: BLE001
        return None


def _font_is_outlineable(font_dict) -> bool:
    """Font có nằm trong phạm vi dựng lại được không (xem docstring module)."""
    try:
        subtype = str(font_dict.get("/Subtype", ""))
        if subtype == "/Type3":
            return False

        if subtype == "/Type0":
            # Chỉ nhận `Identity-H`: mã 2 byte CHÍNH LÀ CID, không phải qua bảng
            # CMap nào. `Identity-V` bị loại vì viết dọc đổi chiều tiến con chữ —
            # dùng chung công thức advance ngang sẽ xếp chữ sai hẳn.
            if str(font_dict.get("/Encoding", "")) != "/Identity-H":
                return False
            kid = _descendant_of(font_dict)
            if kid is None or str(kid.get("/Subtype", "")) != "/CIDFontType2":
                return False
            desc = kid.get("/FontDescriptor")
            if desc is None:
                return False
            desc = desc if isinstance(desc, pikepdf.Dictionary) else desc.resolve()
            return desc.get("/FontFile2") is not None

        desc = font_dict.get("/FontDescriptor")
        if desc is None:
            return False
        desc = desc if isinstance(desc, pikepdf.Dictionary) else desc.resolve()
        return any(desc.get(k) is not None for k in ("/FontFile2", "/FontFile3"))
    except Exception:  # noqa: BLE001
        return False


def _codes_of(raw: bytes, font) -> int | None:
    """Số mã ký tự trong một chuỗi hiển thị, theo đúng luật của `show()`.

    Phải khớp `show()` từng ca một, kể cả ca hỏng (chuỗi lẻ byte trong font 2 byte trả
    `None` ở cả hai nơi) — nếu hai bên đếm khác nhau thì cổng đối chiếu bên dưới sẽ
    loại oan cả khối chữ đúng.
    """
    if font is None or not getattr(font, "ok", False):
        return None
    if font.two_byte:
        return None if len(raw) % 2 else len(raw) // 2
    return len(raw)


def _count_codes_per_block(instructions, fonts: dict) -> dict[int, int] | None:
    """Số mã ký tự của từng khối `BT … ET` theo cách đếm của BỘ GHI này.

    OUT-FONT (audit lần 3 §3.2). Đây là nửa Python của hợp đồng đồng bộ chỉ số: PPE
    khai số mã mỗi khối, hàm này đếm lại độc lập, và chỉ khối nào **khớp số** mới được
    dùng path của PPE. Khớp số nghĩa là hai bên duyệt cùng một dãy mã ký tự, nên chỉ số
    thứ `n` ở hai bên chắc chắn là cùng một ký tự — không cần suy từ hình học, không
    phụ thuộc glyph to hay nhỏ.

    Vì sao phải là một lượt duyệt riêng, không đếm ngay trong lượt ghi: quyết định
    "tin PPE hay không" phải có **trước** khi ghi glyph đầu tiên của khối, còn tổng số
    mã chỉ biết được khi đã đi hết khối.

    Trả `None` nếu gặp thứ không đếm chắc được — caller khi đó không tin khối nào.
    """
    counts: dict[int, int] = {}
    font_stack: list = []
    font = None
    bt_index = -1
    in_text = False
    for instr in instructions:
        op = str(instr.operator)
        operands = list(instr.operands)
        try:
            if op == "q":
                font_stack.append(font)
            elif op == "Q":
                if not font_stack:
                    return None
                font = font_stack.pop()
            elif op == "BT":
                if in_text:
                    return None
                in_text = True
                bt_index += 1
                counts[bt_index] = 0
            elif op == "ET":
                in_text = False
            elif op == "Tf":
                font = fonts.get(str(operands[0]))
            elif op in ("Tj", "'", '"'):
                n = _codes_of(bytes(operands[-1]), font)
                if n is None or bt_index < 0:
                    return None
                counts[bt_index] += n
            elif op == "TJ":
                for item in operands[0]:
                    if _is_pdf_number(item):
                        continue
                    n = _codes_of(bytes(item), font)
                    if n is None or bt_index < 0:
                        return None
                    counts[bt_index] += n
        except Exception as exc:  # noqa: BLE001
            logger.debug("đếm mã ký tự dừng ở toán tử %s: %s", op, exc)
            return None
    return counts


def outline_content_stream(
    pdf: pikepdf.Pdf,
    data: bytes,
    resources,
    fonts: dict,
    glyph_source=None,
    stream_key: object = "page",
) -> tuple[bytes | None, int]:
    """Thay mọi toán tử chữ bằng đường vector. Trả `(content mới, số glyph)`.

    Trả `(None, 0)` khi gặp thứ chưa mô hình hoá — caller phải fallback, tuyệt
    đối không ghi ra bản thiếu chữ.

    `glyph_source` (kế hoạch §19.7) là nguồn hình học chữ từ PPE — xem
    `app.core.ppe_outlines`. Nó **cộng thêm**, không thay thế: glyph nào PPE có thì
    dùng path của PPE (font/encoding/ma trận của nó đã được đo song song với
    renderer tham chiếu), glyph nào không có thì vẫn đi đường fontTools như trước. Nhờ vậy
    bật nguồn này không thể làm mất chữ so với bản cũ, và chốt so-kẽm ở cuối vẫn là
    lưới chặn cuối cùng.
    """
    try:
        instructions = pikepdf.parse_content_stream(pikepdf.Stream(pdf, data))
    except Exception:  # noqa: BLE001
        return (None, 0)

    out: list = []
    glyphs = 0

    graphics_state_stack: list[tuple] = []
    ctm = _Matrix()
    tm = _Matrix()
    tlm = _Matrix()
    font: _EmbeddedFont | None = None
    size = 0.0
    char_sp = 0.0
    word_sp = 0.0
    hscale = 1.0
    leading = 0.0
    rise = 0.0
    render_mode = 0
    in_text = False
    text_clip_paths: list = []
    # Ba mốc đồng bộ với PPE (xem `ppe_outlines`): stream, khối `BT … ET` thứ mấy,
    # mã ký tự thứ mấy trong khối. Đếm MỌI mã ký tự kể cả dấu cách và `Tr 3` —
    # đúng như phía Rust — nếu không thì path bị gán cho glyph khác.
    bt_index = -1
    glyph_ord = 0
    ppe_used = 0
    ppe_rejected = 0

    # OUT-FONT (audit lần 3 §3.2): cổng tin theo khối. Chỉ khối nào bộ ghi và PPE đếm
    # ra CÙNG số mã ký tự mới được dùng path của PPE; khối lệch số (hoặc PPE không khai)
    # đi đường fontTools như trước. Lệch chỉ số vì thế không còn là chuyện lưới so-kẽm
    # phải bắt kịp — nó không thể xảy ra.
    trusted_blocks: set[int] = set()
    if glyph_source is not None:
        local_counts = _count_codes_per_block(instructions, fonts)
        if local_counts is None:
            logger.info(
                "outline: không đếm chắc được mã ký tự (stream %s) → không dùng PPE",
                stream_key,
            )
        else:
            for bt, n in local_counts.items():
                declared = None
                try:
                    declared = glyph_source.code_count(stream_key, bt)
                except AttributeError:
                    # Nguồn cũ chưa có `code_count` (native chưa rebuild). Không tin
                    # khối nào — an toàn hơn là tin rồi dựa vào lưới so-kẽm.
                    declared = None
                if declared == n:
                    trusted_blocks.add(bt)
                else:
                    logger.info(
                        "outline: khối BT %d lệch số mã (bộ ghi %d, PPE %s) "
                        "→ dùng đường fontTools",
                        bt, n, declared,
                    )

    def finish_text_clip() -> None:
        """Áp text clipping một lần ở cuối BT…ET.

        PDF gom outline của mọi glyph dùng Tr=4..7 rồi mới giao với clipping
        path hiện tại khi kết thúc text object. Áp ``W n`` sau từng glyph sẽ
        giao các glyph rời nhau thành vùng rỗng.
        """
        nonlocal text_clip_paths
        if not text_clip_paths:
            return
        out.extend(text_clip_paths)
        out.append(([], pikepdf.Operator("W")))
        out.append(([], pikepdf.Operator("n")))
        text_clip_paths = []

    def ppe_path_for(ordinal: int, trm: _Matrix) -> list | None:
        """Path của PPE cho một glyph, nếu khối chữ này đã qua cổng đối chiếu.

        Chốt chính chống lệch chỉ số là **so số mã ký tự của khối** (`trusted_blocks`,
        xem `_count_codes_per_block`) — nó không phụ thuộc glyph to hay nhỏ. Phần kiểm
        vị trí dưới đây là chốt cũ, giữ lại sau cờ `PRYNX_OUTLINE_TRUST_PPE=0` để đối
        chiếu khi cần chứ không còn là lưới chặn mặc định.

        Kiểm vị trí từng là chốt chống **lệch chỉ số**: hai bên đi qua cùng content stream
        bằng hai bộ code khác nhau, và nếu chỉ số lệch thì path của glyph này bị gán
        cho glyph khác — file vẫn mở được, vẫn có chữ, chỉ sai chỗ. Một glyph luôn
        phải nằm quanh vị trí bút của nó, nên khoảng cách tới `(trm.e, trm.f)` là dấu
        hiệu rẻ và chắc. Nghi ngờ thì trả `None` để lùi về đường fontTools.

        Dung sai lấy theo **cỡ chữ hiệu dụng** — độ dài vector cơ sở của `trm` — chứ
        KHÔNG theo toán tử `Tf`. File thật rất hay khai `Tf 1` rồi đặt cỡ trong `Tm`
        (đo trên corpus: dung sai theo `Tf` làm chốt loại oan glyph lệch 2,5pt trên
        chữ cỡ ~20pt, tức mất sạch phần cải thiện của PPE).
        """
        nonlocal ppe_used, ppe_rejected
        if glyph_source is None:
            return None
        if bt_index not in trusted_blocks:
            # Khối này không khớp số mã ký tự (lý do đã ghi nhật ký một lần ở trên).
            return None
        # OUT-FONT (audit 2026-07-27 lần 2): hình học của PPE là CHUẨN, không phải
        # thứ phải xin phép bộ ghi Python.
        #
        # Chốt cũ so path của PPE với vị trí bút mà bộ ghi Python tự tính — hợp lý chỉ
        # khi bộ ghi đúng. Đo trên `2 - rúp.pdf` bằng trọng tài so-kẽm cho thấy nó
        # SAI: giữ chốt cũ thì 91 ô mực lệch (mean 2,51/255), tin PPE thì còn 1 ô và
        # mean 0,53/255 — và ô đó chỉ là outline dày thêm, không mất pixel nào.
        #
        # Lưới chặn lệch chỉ số vì thế chuyển sang chốt so-kẽm từng trang: lệch chỉ số
        # làm mực rời khỏi chỗ cũ, đúng thứ `_local_ink_mismatch` đo. Đặt
        # `PRYNX_OUTLINE_TRUST_PPE=0` để quay lại chốt cũ khi cần đối chiếu.
        trust_ppe = os.environ.get("PRYNX_OUTLINE_TRUST_PPE", "1") not in {"0", "false", "no"}
        try:
            path = glyph_source.path_for(stream_key, bt_index, ordinal)
        except Exception as exc:  # noqa: BLE001 — nguồn phụ không được làm hỏng job
            logger.debug("PPE outline: không tra được glyph %d: %s", ordinal, exc)
            return None
        if not path:
            return None
        xs: list[float] = []
        ys: list[float] = []
        for operands, _op in path:
            for i in range(0, len(operands) - 1, 2):
                xs.append(float(operands[i]))
                ys.append(float(operands[i + 1]))
        if not xs:
            return None
        # Cỡ chữ hiệu dụng theo hai trục của ma trận chữ.
        eff_x = math.hypot(trm.a, trm.b)
        eff_y = math.hypot(trm.c, trm.d)
        eff = max(eff_x, eff_y)
        tol_x = max(4.0, eff * 2.0)
        tol_y = max(4.0, eff * 3.0)
        cx = (min(xs) + max(xs)) / 2.0
        cy = (min(ys) + max(ys)) / 2.0
        if trust_ppe:
            ppe_used += 1
            return path
        if abs(cx - trm.e) > tol_x or abs(cy - trm.f) > tol_y:
            ppe_rejected += 1
            logger.info(
                "PPE outline: glyph %d lệch vị trí bút (%.2f,%.2f) vs (%.2f,%.2f) "
                "→ dùng đường fontTools",
                ordinal, cx, cy, trm.e, trm.f,
            )
            return None
        ppe_used += 1
        return path

    def show(raw: bytes) -> bool:
        nonlocal tm, glyphs, text_clip_paths, glyph_ord
        if font is None or not font.ok:
            return False
        if font.two_byte:
            if len(raw) % 2:
                return False  # chuỗi lẻ byte trong font 2-byte: dữ liệu hỏng
            codes = [
                (raw[i] << 8) | raw[i + 1] for i in range(0, len(raw), 2)
            ]
        else:
            codes = list(raw)
        for code in codes:
            ordinal = glyph_ord
            glyph_ord += 1
            # OUT-FONT (audit 2026-07-27 §4.2): giữ đúng Tr=0..7. Tr=3
            # hoàn toàn ẩn; Tr=7 không lên mực nhưng vẫn phải dựng path để clip.
            needs_path = render_mode != 3
            if needs_path:
                # KHÔNG nhân CTM vào đây: path được chèn vào ĐÚNG vị trí cũ
                # trong stream, nên lệnh `cm` phía trước vẫn còn hiệu lực và sẽ
                # tự áp. Nhân thêm ở đây là áp CTM hai lần — trang không có
                # `cm` thì không lộ, trang có thì lệch hẳn (đo được: kẽm Cyan
                # lệch 233/255 trên một file corpus).
                trm = _Matrix(size * hscale, 0.0, 0.0, size, 0.0, rise).then(tm)
                scale = 1.0 / font.upem
                glyph_matrix = _Matrix(scale, 0.0, 0.0, scale, 0.0, 0.0).then(trm)
                glyph_path: list = []
                from_ppe = ppe_path_for(ordinal, trm)
                if from_ppe is not None:
                    # PPE đã lo font/encoding/ma trận chữ; ở đây chỉ ghi ra PDF.
                    glyph_path = list(from_ppe)
                    glyphs += 1
                elif font.draw(code, glyph_matrix, glyph_path):
                    glyphs += 1
                else:
                    # Không tra được glyph nghĩa là chữ đó sẽ BIẾN MẤT. Bỏ qua
                    # âm thầm là kiểu hỏng tệ nhất ở đây — file trông vẫn có
                    # chữ, chỉ thiếu vài ký tự, và không ai thấy tới lúc in.
                    logger.info(
                        "outline dừng: không tra được glyph cho mã %d (font %d glyph đã map)",
                        code, len(font.code_to_glyph),
                    )
                    return False

                paint_mode = render_mode % 4
                paint_op = {
                    0: "f",  # fill
                    1: "S",  # stroke
                    2: "B",  # fill + stroke
                }.get(paint_mode)
                if paint_op is not None:
                    # Paint từng glyph riêng: gom contour của nhiều glyph vào
                    # một path có thể đổi winding khi chúng chồng nhau.
                    out.extend(glyph_path)
                    out.append(([], pikepdf.Operator(paint_op)))

                if render_mode >= 4:
                    # Toán tử paint đã consume path; giữ một bản operand để
                    # dựng clipping path hợp nhất tại ET.
                    text_clip_paths.extend(glyph_path)

            w0 = font.width(code) / 1000.0
            # `Tw` chỉ áp cho mã MỘT byte bằng 32 (§9.3.3) — với font 2 byte,
            # áp nhầm sẽ giãn chữ ở mọi ký tự có byte 0x20 bên trong.
            word = word_sp if (code == 32 and not font.two_byte) else 0.0
            adv = (w0 * size + char_sp + word) * hscale
            tm = _Matrix(1.0, 0.0, 0.0, 1.0, adv, 0.0).then(tm)
        return True

    for instr in instructions:
        op = str(instr.operator)
        operands = list(instr.operands)

        if op == "q":
            if in_text:
                return (None, 0)
            # OUT-FONT (audit 2026-07-27 §4.2): q/Q lưu cả text state, không
            # chỉ CTM. Bỏ font/size khỏi stack làm text sau Q dùng nhầm state.
            graphics_state_stack.append((
                ctm, font, size, char_sp, word_sp, hscale,
                leading, rise, render_mode,
            ))
            out.append(instr)
            continue
        if op == "Q":
            if in_text or not graphics_state_stack:
                return (None, 0)
            (
                ctm,
                font,
                size,
                char_sp,
                word_sp,
                hscale,
                leading,
                rise,
                render_mode,
            ) = graphics_state_stack.pop()
            out.append(instr)
            continue
        if op == "cm":
            try:
                vals = [float(v) for v in operands]
                if len(vals) == 6:
                    ctm = _Matrix(*vals).then(ctm)
            except Exception:  # noqa: BLE001
                return (None, 0)
            out.append(instr)
            continue

        if op not in _TEXT_OPS:
            out.append(instr)
            continue

        # ── Từ đây là toán tử chữ: KHÔNG phát lại, thay bằng path ──
        try:
            if op == "BT":
                if in_text:
                    return (None, 0)
                in_text = True
                text_clip_paths = []
                tm = tlm = _Matrix()
                bt_index += 1
                glyph_ord = 0
            elif op == "ET":
                finish_text_clip()
                in_text = False
            elif op == "Tf":
                name = str(operands[0])
                size = float(operands[1])
                font = fonts.get(name)
                if font is None or not font.ok:
                    # Nói rõ font nào: "chưa hỗ trợ" chung chung làm người sau
                    # phải dò lại từ đầu.
                    logger.info("outline dừng: không có font %s trong resources", name)
                    return (None, 0)
            elif op in ("Td", "TD"):
                tx, ty = float(operands[0]), float(operands[1])
                if op == "TD":
                    leading = -ty
                tlm = _Matrix(1.0, 0.0, 0.0, 1.0, tx, ty).then(tlm)
                tm = tlm
            elif op == "Tm":
                vals = [float(v) for v in operands]
                tm = tlm = _Matrix(*vals)
            elif op == "T*":
                tlm = _Matrix(1.0, 0.0, 0.0, 1.0, 0.0, -leading).then(tlm)
                tm = tlm
            elif op == "TL":
                leading = float(operands[0])
            elif op == "Tc":
                char_sp = float(operands[0])
            elif op == "Tw":
                word_sp = float(operands[0])
            elif op == "Tz":
                hscale = float(operands[0]) / 100.0
            elif op == "Ts":
                rise = float(operands[0])
            elif op == "Tr":
                candidate = int(operands[0])
                if not 0 <= candidate <= 7:
                    return (None, 0)
                render_mode = candidate
            elif op == "Tj":
                if not show(bytes(operands[0])):
                    return (None, 0)
            elif op in ("'", '"'):
                if op == '"':
                    word_sp = float(operands[0])
                    char_sp = float(operands[1])
                tlm = _Matrix(1.0, 0.0, 0.0, 1.0, 0.0, -leading).then(tlm)
                tm = tlm
                if not show(bytes(operands[-1])):
                    return (None, 0)
            elif op == "TJ":
                for item in operands[0]:
                    if _is_pdf_number(item):
                        # Số trong TJ dịch chuyển NGƯỢC chiều, đơn vị 1/1000 em.
                        adv = -float(item) / 1000.0 * size * hscale
                        tm = _Matrix(1.0, 0.0, 0.0, 1.0, adv, 0.0).then(tm)
                    else:
                        if not show(bytes(item)):
                            return (None, 0)
        except Exception as exc:  # noqa: BLE001
            logger.debug("toán tử chữ %s không xử lý được: %s", op, exc)
            return (None, 0)

    if in_text or graphics_state_stack:
        return (None, 0)
    if glyph_source is not None and (ppe_used or ppe_rejected):
        logger.info(
            "outline: %d glyph dùng hình học PPE, %d lùi về fontTools (stream %s)",
            ppe_used, ppe_rejected, stream_key,
        )
    try:
        # Để pikepdf serialise toàn bộ: tự nối chuỗi thì operand không phải số
        # — dictionary của `BDC`, ảnh nội tuyến — bị `str()` ra repr Python và
        # phá hỏng cả stream, làm trang trắng trơn (đo được trên một file
        # corpus: phủ 93% → 0%).
        return (pikepdf.unparse_content_stream(out), glyphs)
    except Exception as exc:  # noqa: BLE001
        logger.debug("không serialise được content stream: %s", exc)
        return (None, 0)




# Ngưỡng verify sau khi outline. Hai tiêu chí có VAI TRÒ KHÁC NHAU, và đó là lý
# do chúng không cùng độ chặt:
#
# * **Diện tích phủ** là lưới chính. Chữ đặt sai chỗ hay mất chữ đều đổi phủ
#   ngay; đo được: một trang mất 1.95 điểm % Cyan vì lỗi thật, trong khi trang
#   outline đúng chỉ lệch 0.03–0.11 điểm %. Giữ chặt.
# * **Sai lệch trung bình** chỉ là lưới phụ, và nó tăng tự nhiên theo mật độ
#   chữ: path outline được raster với vành fill-adjust nên dày hơn glyph gốc
#   một chút ở MỌI biên. Đo: trang 5 glyph cho 0.47/255, trang đặc chữ cho
#   3.02/255 dù phủ chỉ lệch 0.1 điểm % — tức chữ hoàn toàn đúng chỗ. Ngưỡng
#   3.0 vì thế loại oan trang dày chữ; 5.0 vẫn thấp hơn nhiều so với mọi ca sai
#   thật đã đo (47–233/255).
_VERIFY_MEAN_LIMIT = 5.0
_VERIFY_COVERAGE_LIMIT = 1.5

# OUT-FONT (audit 2026-07-27 §4.2): mean/coverage toàn trang bị nền trắng
# pha loãng. Kiểm theo tile để bắt chữ nhỏ bị lệch mà không phạt sai số vành
# raster tự nhiên của outline đúng.
_VERIFY_TILE_SIZE = 64

# OUT-FONT (audit lần 3 §3.2): trần cũ 64 px làm chốt BỎ QUA HẲN mọi ô ít mực, tức
# đúng những glyph nhỏ nhất. Đo được trên trang 612×792 @150 DPI, dịch nội dung 30pt:
# dấu `.` 12pt (9 px mực), chữ `i` 12pt (34 px), chữ `A` 8pt (49 px) đều cho
# `verify=True` — action báo thành công trên bản in đã sai chỗ. Chỉ `A` 10pt (75 px)
# mới bị bắt.
#
# Hạ trần xuống 6 px: một dấu chấm 12pt ở 150 DPI đã là ~9 px, nên 6 px là mức dưới
# đó mà vẫn loại được nhiễu một-hai pixel lẻ ở biên.
_VERIFY_TILE_MIN_INK_PIXELS = 6

# Vì sao hạ trần được mà không sinh báo động giả: `recall` được đo với mực sau khi
# **nở 1 px**. Sai số thực tế của outline đúng là lệch dưới một pixel (vành
# fill-adjust, làm tròn khi raster) — nở 1 px hấp thụ hết phần đó. Còn chữ đặt sai
# chỗ thì lệch hàng chục pixel (30pt ở 150 DPI là 62 px), nở 1 px không cứu được.
# Không có bước nở này thì một dấu chấm 9 px lệch đúng 1 px sẽ tụt recall xuống 0.
_VERIFY_TILE_DILATE_PX = 1

# Chiều "thêm mực" giữ trần 64 px: mực lạ xuất hiện ở vùng trước đó trắng thường là
# cả một glyph (ô đo được: 0 px → 127 px), còn vài pixel lẻ thì đã có hai lưới
# mean/coverage toàn trang lo. Hạ trần ở chiều này chỉ mua thêm báo động giả.
_VERIFY_PRECISION_MIN_INK_PIXELS = 64

# OUT-FONT (audit 2026-07-28 §3.1): chiều precision theo ô ở trên cố ý bỏ qua
# dưới 64 px để không phạt vành raster dày thêm quanh glyph nhỏ. Nhưng vì thế một
# dấu chấm 12 pt được VẼ THÊM (9 px) cũng lọt. Chốt mới chỉ xét mực sau nằm ngoài
# vùng mực gốc đã nở 1 px theo cả 8 hướng; vành dày hợp lệ nằm trong vùng đó, còn
# một contour/glyph mới tách rời thì thành một cụm không được giải thích.
_VERIFY_UNEXPLAINED_COMPONENT_MIN_PIXELS = 6

# OUT-FONT (audit 2026-07-27 lần 2): thước đo theo tile đổi từ IoU sang cặp
# **recall / precision**, vì IoU đối xứng còn thứ cần chặn thì không.
#
# Điều cần chặn là **mất chữ** và **lệch chỗ**; điều phải bỏ qua là outline dày hơn
# glyph gốc một chút — path outline đi qua vành fill-adjust của raster nên nở ra ở
# MỌI biên, và với glyph nhỏ thì phần nở đó lớn so với diện tích chữ. IoU trộn hai
# thứ đó vào một số: đo được trên `2 - rúp.pdf`, ô cuối cùng còn lại có 40 px mực
# trước, 83 px sau, giao đúng 40 — tức KHÔNG mất một pixel nào, chỉ dày thêm — mà
# IoU vẫn chỉ 0,48 và chặn cả file.
#
# * `recall = giao / mực_trước` — phần mực gốc còn được phủ. Chữ mất hoặc dịch chỗ
#   làm nó sụp ngay: mọi ca sai thật đã đo đều cho 0,00, còn ca đúng cho 1,00.
# * `precision = giao / mực_sau` — chặn chiều còn lại: vẽ THÊM mực vào chỗ trước
#   đó trắng (ô đo được: trước 0 px, sau 127 px ⇒ precision 0,00). Ngưỡng để rộng
#   vì phần nở hợp lệ hạ precision một cách vô hại (ô nói trên: 0,48).
_VERIFY_TILE_RECALL_MIN = 0.80
_VERIFY_TILE_PRECISION_MIN = 0.25


# Các toán tử có thể đổi màu/tách kẽm. Nhánh object-level phải giữ nguyên chuỗi
# này; outline chỉ được thay toán tử chữ bằng path.
_COLOR_STATE_OPS = frozenset({
    "q", "Q", "g", "G", "rg", "RG", "k", "K", "cs", "CS",
    "sc", "SC", "scn", "SCN", "gs", "ri",
})


def _signature_operand(value):
    """Dạng ổn định của operand màu, không phụ thuộc cách ghi số của pikepdf."""
    value = _deref(value)
    if _is_pdf_number(value):
        return ("number", str(Decimal(str(value)).normalize()))
    if isinstance(value, pikepdf.Array):
        return ("array", tuple(_signature_operand(item) for item in value))
    return ("token", str(value))


def _combined_stream_bytes(contents) -> bytes:
    if contents is None:
        return b""
    streams = list(contents) if isinstance(contents, pikepdf.Array) else [contents]
    chunks = []
    for stream in streams:
        stream = _deref(stream)
        if not isinstance(stream, pikepdf.Stream):
            raise TypeError("Contents không phải stream")
        chunks.append(bytes(stream.read_bytes()))
    return b"\n".join(chunks)


def _color_state_signature(pdf_path: str) -> tuple | None:
    """Chuỗi trạng thái màu của trang và Form, dùng cho outline object-level.

    [OUT-FONT FIX 2026-07-28] So-kẽm raster có thể thấy viền chữ đậm thêm 1 px
    do text hinting biến mất sau outline. Chữ ký này chứng minh writer không đổi
    toán tử màu trong khi lưới cục bộ chịu trách nhiệm bắt mất/thêm/lệch hình.
    """
    try:
        records = []
        with pikepdf.open(pdf_path) as pdf:
            def scan(contents, resources, label: str, depth: int, seen: set) -> None:
                if depth > _MAX_FORM_DEPTH:
                    raise ValueError("Form XObject lồng quá sâu")
                data = _combined_stream_bytes(contents)
                instructions = pikepdf.parse_content_stream(pikepdf.Stream(pdf, data))
                color_ops = tuple(
                    (
                        str(instruction.operator),
                        tuple(_signature_operand(item) for item in instruction.operands),
                    )
                    for instruction in instructions
                    if str(instruction.operator) in _COLOR_STATE_OPS
                )
                records.append((label, color_ops))

                resources = _deref(resources) if resources is not None else None
                if not isinstance(resources, pikepdf.Dictionary):
                    return
                xobjects = _deref(resources.get("/XObject"))
                if not isinstance(xobjects, pikepdf.Dictionary):
                    return
                for name, ref in sorted(dict(xobjects).items(), key=lambda pair: str(pair[0])):
                    form = _deref(ref)
                    if not isinstance(form, pikepdf.Stream):
                        continue
                    if str(form.get("/Subtype", "")) != "/Form":
                        continue
                    key = _objkey(form)
                    if key is not None:
                        if key in seen:
                            continue
                        seen.add(key)
                    inner_resources = form.get("/Resources") or resources
                    scan(form, inner_resources, f"{label}/{name}", depth + 1, seen)

            for page_number, page in enumerate(pdf.pages, start=1):
                scan(
                    page.get("/Contents"),
                    page.get("/Resources"),
                    f"page:{page_number}",
                    0,
                    set(),
                )
        return tuple(records)
    except Exception as exc:  # noqa: BLE001
        logger.warning("không lập được chữ ký trạng thái màu: %s", exc)
        return None


def _plate_stats(
    pdf_path: str, page_number: int, dpi: int
) -> dict[str, tuple[float, "object"]]:
    import base64
    import zlib

    import numpy as np

    from app.core.print_engine import facade

    sep = facade.separations(pdf_path, page_number, dpi, ink_accurate=True)
    out = {}
    for plate in sep["plates"]:
        raw = zlib.decompress(base64.b64decode(plate["alpha_data"]))
        arr = np.frombuffer(raw, dtype=np.uint8).reshape(sep["height"], sep["width"])
        out[plate["name"]] = (float((arr > 127).mean() * 100.0), arr.astype(np.int32))
    return out


def _local_ink_mismatch(before, after) -> tuple[int, int, float, str] | None:
    """Tile đầu tiên bị **mất mực** hoặc **thêm mực sai chỗ**, nếu có.

    Trả `(x, y, tỉ lệ, loại)` với `loại` là `"mat_muc"` hoặc `"them_muc"`. Xem khối
    hằng `_VERIFY_TILE_*` về vì sao thước đo không đối xứng.
    """
    import numpy as np

    before_ink = before > 127
    after_ink = after > 127
    # Nở 1 px cho mực SAU rồi mới đo recall — xem `_VERIFY_TILE_DILATE_PX`. Dùng phép
    # dịch mảng thay vì scipy: không thêm phụ thuộc, và bán kính 1 px chỉ là 4 lần OR.
    after_grown = after_ink.copy()
    for _ in range(_VERIFY_TILE_DILATE_PX):
        grown = after_grown.copy()
        grown[1:, :] |= after_grown[:-1, :]
        grown[:-1, :] |= after_grown[1:, :]
        grown[:, 1:] |= after_grown[:, :-1]
        grown[:, :-1] |= after_grown[:, 1:]
        after_grown = grown

    # Ưu tiên giữ chẩn đoán mất/dịch mực của chốt cũ. Cụm mực mới chỉ là lưới
    # bổ sung cho những ca recall/precision theo ô không phát hiện.
    height, width = before_ink.shape
    tile = _VERIFY_TILE_SIZE

    for y in range(0, height, tile):
        for x in range(0, width, tile):
            old = before_ink[y:y + tile, x:x + tile]
            new = after_ink[y:y + tile, x:x + tile]
            n_old = int(np.count_nonzero(old))
            n_new = int(np.count_nonzero(new))
            if n_old >= _VERIFY_TILE_MIN_INK_PIXELS:
                kept = int(np.count_nonzero(old & after_grown[y:y + tile, x:x + tile]))
                recall = kept / n_old
                if recall < _VERIFY_TILE_RECALL_MIN:
                    return (x, y, recall, "mat_muc")
            if n_new >= _VERIFY_PRECISION_MIN_INK_PIXELS:
                intersection = int(np.count_nonzero(old & new))
                precision = intersection / n_new
                if precision < _VERIFY_TILE_PRECISION_MIN:
                    return (x, y, precision, "them_muc")

    # OUT-FONT (audit 2026-07-28 §3.1): bắt chiều THÊM mực nhỏ mà precision theo
    # ô không xét tới. Nở mực gốc 1 px theo 8 hướng để hấp thụ vành fill-adjust
    # hợp lệ (dấu chấm 3x3 thành tối đa 5x5), rồi chỉ tìm cụm mực thực sự mới.
    before_allowed = before_ink.copy()
    grown = before_allowed.copy()
    grown[1:, :] |= before_allowed[:-1, :]
    grown[:-1, :] |= before_allowed[1:, :]
    grown[:, 1:] |= before_allowed[:, :-1]
    grown[:, :-1] |= before_allowed[:, 1:]
    grown[1:, 1:] |= before_allowed[:-1, :-1]
    grown[1:, :-1] |= before_allowed[:-1, 1:]
    grown[:-1, 1:] |= before_allowed[1:, :-1]
    grown[:-1, :-1] |= before_allowed[1:, 1:]
    unexplained = after_ink & ~grown

    # Không kéo scipy/OpenCV chỉ để gắn nhãn component. Với output đúng,
    # `unexplained` thường rỗng; set chỉ chứa các pixel nghi ngờ nên vòng lặp này
    # nhỏ hơn rất nhiều so với duyệt toàn trang bằng Python.
    points = {tuple(map(int, p)) for p in np.argwhere(unexplained)}
    while points:
        seed = points.pop()
        stack = [seed]
        size = 0
        min_y, min_x = seed
        while stack:
            cy, cx = stack.pop()
            size += 1
            min_y = min(min_y, cy)
            min_x = min(min_x, cx)
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    neighbour = (cy + dy, cx + dx)
                    if neighbour in points:
                        points.remove(neighbour)
                        stack.append(neighbour)
        if size >= _VERIFY_UNEXPLAINED_COMPONENT_MIN_PIXELS:
            return (min_x, min_y, 0.0, "them_muc")

    return None


def verify_outline(
    original: str,
    outlined: str,
    dpi: int = 150,
    *,
    native_object_level: bool = False,
    cancel_check=None,
) -> tuple[bool, str]:
    """So kẽm từng trang; nhánh native cho phép riêng sai số viền 1 px.

    ``native_object_level=True`` chỉ dùng sau writer object-level: màu phải giữ
    nguyên theo chữ ký content stream và hình mực phải qua lưới cục bộ. Nhánh GS
    vẫn giữ ngưỡng mean/coverage chặt vì nó dựng lại toàn bộ PDF.
    """
    _raise_if_cancelled(cancel_check)
    try:
        import numpy as np

        with pikepdf.open(original) as before_pdf:
            before_pages = len(before_pdf.pages)
        with pikepdf.open(outlined) as after_pdf:
            after_pages = len(after_pdf.pages)
    except Exception as exc:  # noqa: BLE001
        return (False, f"không render được để verify: {exc}")

    if before_pages != after_pages:
        return (False, f"số trang đổi: {before_pages} → {after_pages}")

    if native_object_level:
        _raise_if_cancelled(cancel_check)
        before_color = _color_state_signature(original)
        _raise_if_cancelled(cancel_check)
        after_color = _color_state_signature(outlined)
        if before_color is None or after_color is None:
            return (False, "không chứng minh được trạng thái màu trước/sau outline")
        if before_color != after_color:
            return (False, "toán tử hoặc trạng thái màu đã thay đổi sau outline")

    for page_number in range(1, before_pages + 1):
        _raise_if_cancelled(cancel_check)
        try:
            before = _plate_stats(original, page_number, dpi)
            _raise_if_cancelled(cancel_check)
            after = _plate_stats(outlined, page_number, dpi)
        except Exception as exc:  # noqa: BLE001
            return (False, f"không render được trang {page_number} để verify: {exc}")

        if set(before) != set(after):
            return (
                False,
                f"trang {page_number} đổi số kẽm: {sorted(before)} → {sorted(after)}",
            )

        for name, (cov_before, arr_before) in before.items():
            cov_after, arr_after = after[name]
            if arr_before.shape != arr_after.shape:
                return (False, f"trang {page_number} đổi khổ raster ở kẽm {name}")
            mean_delta = float(np.abs(arr_before - arr_after).mean())
            if not native_object_level and mean_delta > _VERIFY_MEAN_LIMIT:
                return (
                    False,
                    f"trang {page_number}, kẽm {name} lệch "
                    f"{mean_delta:.2f}/255 sau outline",
                )
            if (
                not native_object_level
                and abs(cov_after - cov_before) > _VERIFY_COVERAGE_LIMIT
            ):
                return (
                    False,
                    f"trang {page_number}, kẽm {name} đổi diện tích phủ "
                    f"{cov_before:.2f}% → {cov_after:.2f}%",
                )
            local = _local_ink_mismatch(arr_before, arr_after)
            if local is not None:
                x, y, ratio, kind = local
                what = (
                    f"mất mực (chỉ còn {ratio:.0%} mực gốc)"
                    if kind == "mat_muc"
                    else f"thêm mực sai chỗ (chỉ {ratio:.0%} trùng mực gốc)"
                )
                return (
                    False,
                    f"trang {page_number}, kẽm {name} {what} tại ô ({x}, {y})",
                )
    return (True, "")


def outline_fonts(input_path: str, output_path: str, *, cancel_check=None) -> dict:
    """Chuyển toàn bộ chữ thành vector. `supported=False` ⇒ caller dừng an toàn.

    Kết quả **luôn được verify** bằng cách so kẽm với bản gốc trước khi trả về;
    verify hỏng thì coi như không làm được, vì một file chữ lệch còn tệ hơn
    file chưa outline.
    """
    result: dict = {"supported": True, "glyphs": 0, "warnings": []}
    _raise_if_cancelled(cancel_check)

    # Text nằm trong annotation / AcroForm field cũng lên bản in, và outline chỉ
    # content stream sẽ bỏ sót đúng phần đó — lỗi này đã được sửa một lần cho
    # pipeline cũ (§16.7), đường native không được để nó quay lại.
    # `flatten_annotations_and_forms` chạy bằng pypdfium2, không cần GS.
    import os
    import tempfile as _tempfile

    source = input_path
    tmp_flat = None
    if _has_annotations(input_path):
        from app.core.outline_fonts import flatten_annotations_and_forms

        fd, tmp_flat = _tempfile.mkstemp(suffix="_annotflat.pdf")
        os.close(fd)
        try:
            flatten_annotations_and_forms(input_path, tmp_flat)
            _raise_if_cancelled(cancel_check)
            source = tmp_flat
        except Exception as exc:  # noqa: BLE001
            result["supported"] = False
            result["warnings"].append(f"không bake được annotation: {exc}")
            os.path.exists(tmp_flat) and os.remove(tmp_flat)
            return result
    try:
        return _outline_document(
            source,
            output_path,
            input_path,
            result,
            cancel_check=cancel_check,
        )
    finally:
        if tmp_flat and os.path.exists(tmp_flat):
            try:
                os.remove(tmp_flat)
            except OSError:
                pass


def _has_form_xobject(resources) -> bool:
    try:
        xobjects = resources.get("/XObject")
        if xobjects is None:
            return False
        for _n, xo in dict(xobjects).items():
            xo = xo if isinstance(xo, pikepdf.Stream) else xo.resolve()
            if str(xo.get("/Subtype", "")) == "/Form":
                return True
    except Exception:  # noqa: BLE001
        return True  # không đọc được ⇒ coi như có, để từ chối cho an toàn
    return False


def _has_annotations(pdf_path: str) -> bool:
    try:
        with pikepdf.open(pdf_path) as pdf:
            return any(page.get("/Annots") for page in pdf.pages)
    except Exception:  # noqa: BLE001
        return False


def _load_fonts(font_dict, pdf, result) -> dict | None:
    """Nạp mọi font trong một bộ resources. `None` ⇒ ngoài phạm vi, đã ghi lý do."""
    fonts: dict[str, _EmbeddedFont] = {}
    for name, ref in dict(font_dict).items():
        fd = ref if isinstance(ref, pikepdf.Dictionary) else ref.resolve()
        if not _font_is_outlineable(fd):
            result["supported"] = False
            result["warnings"].append(
                f"font {str(fd.get('/BaseFont', name))} ngoài phạm vi "
                "(chưa nhúng, Type1 /FontFile, Type0 không Identity-H, hoặc Type3)"
            )
            return None
        loaded = _EmbeddedFont(fd, pdf)
        if not loaded.ok:
            result["supported"] = False
            result["warnings"].append(f"không đọc được font {name}")
            return None
        fonts[str(name)] = loaded
    return fonts


def _ppe_source_for_page(input_path: str, page_number: int, result: dict):
    """Nguồn hình học chữ từ PPE cho một trang, `None` nếu không lấy được.

    Kế hoạch §19.7: Rust lo font/encoding/ma trận chữ, Python lo ghi PDF. Nguồn này
    **cộng thêm** vào đường fontTools chứ không thay thế, nên mọi lỗi ở đây chỉ làm
    mất phần cải thiện — không được làm hỏng tác vụ.
    """
    try:
        from app.core.ppe_outlines import PpeGlyphSource, PpeUnavailable
    except Exception as exc:  # noqa: BLE001
        logger.debug("PPE outline: không nạp được module (%s)", exc)
        return None
    try:
        from app.core.print_engine.facade import _fallback_font_path

        fallback = _fallback_font_path()
    except Exception:  # noqa: BLE001
        fallback = None
    try:
        source = PpeGlyphSource.for_page(input_path, page_number, fallback)
    except PpeUnavailable as exc:
        logger.info("PPE outline: %s", exc)
        return None
    except Exception as exc:  # noqa: BLE001
        logger.info("PPE outline: trang %d không lấy được hình học (%s)", page_number, exc)
        return None
    why = source.why_incomplete()
    if why:
        # Không từ chối tác vụ ở đây: glyph nào PPE có vẫn dùng được, phần còn lại
        # đi đường fontTools, và chốt so-kẽm vẫn chặn ở cuối.
        result.setdefault("warnings", []).append(
            f"PPE chỉ cấp được một phần hình học chữ trang {page_number}: {why}"
        )
    return source


def _outline_forms(
    pdf, resources, inherited_fonts, result, depth: int, outlined_forms: set,
    glyph_source=None,
) -> bool:
    """Outline chữ trong mọi Form XObject của một bộ resources (đệ quy).

    Form không khai `/Resources` thì kế thừa của cha (§8.10.1) — nên font phải
    được truyền xuống, không tra lại từ đầu.
    """
    if depth > _MAX_FORM_DEPTH or resources is None:
        return True
    try:
        xobjects = resources.get("/XObject")
        if xobjects is None:
            return True
        items = list(dict(xobjects).items())
    except Exception:  # noqa: BLE001
        return True

    for _name, ref in items:
        try:
            form = ref if isinstance(ref, pikepdf.Stream) else ref.resolve()
            if str(form.get("/Subtype", "")) != "/Form":
                continue
            key = _objkey(form)
            if key is not None and key in outlined_forms:
                continue
            inner_res = form.get("/Resources")
            own_fonts = dict(inherited_fonts)
            if inner_res is not None:
                inner_font_dict = inner_res.get("/Font")
                if inner_font_dict is not None:
                    loaded = _load_fonts(inner_font_dict, pdf, result)
                    if loaded is None:
                        return False
                    own_fonts.update(loaded)
            target_res = inner_res if inner_res is not None else resources

            if not _outline_forms(
                pdf, inner_res, own_fonts, result, depth + 1, outlined_forms,
                glyph_source,
            ):
                return False

            data = bytes(form.read_bytes())
            new, count = outline_content_stream(
                pdf, data, target_res, own_fonts,
                glyph_source=glyph_source,
                # PPE đánh dấu chữ trong form bằng objgen của chính stream form.
                stream_key=key if key is not None else "unaddressable",
            )
            if new is None:
                result["supported"] = False
                result["warnings"].append(
                    "Form XObject có tính năng chữ chưa hỗ trợ"
                )
                return False
            form.write(new)
            result["_form_glyphs"] = result.get("_form_glyphs", 0) + count
            if key is not None:
                outlined_forms.add(key)
            if inner_res is not None and "/Font" in inner_res:
                del inner_res["/Font"]
        except Exception as exc:  # noqa: BLE001
            result["supported"] = False
            result["warnings"].append(f"không outline được Form XObject: {exc}")
            return False
    return True




def _outline_document(
    input_path: str,
    output_path: str,
    verify_against: str,
    result: dict,
    *,
    cancel_check=None,
) -> dict:
    # Form dùng lại ở nhiều trang chỉ được outline MỘT lần; chạy hai lần trên
    # cùng stream sẽ nhân đôi path và làm chữ dày lên.
    outlined_forms: set = set()
    _raise_if_cancelled(cancel_check)
    with pikepdf.open(input_path) as pdf:
        total = 0
        for page_number, page in enumerate(pdf.pages, start=1):
            _raise_if_cancelled(cancel_check)
            # Đọc hình học chữ từ file GỐC (input_path): PPE phải thấy đúng trang
            # chưa bị sửa, còn pikepdf đang giữ bản đang sửa trong bộ nhớ.
            glyph_source = _ppe_source_for_page(input_path, page_number, result)
            resources = page.get("/Resources")
            if resources is None:
                continue
            font_dict = resources.get("/Font")
            fonts: dict = {}
            if font_dict is not None:
                loaded = _load_fonts(font_dict, pdf, result)
                if loaded is None:
                    return result
                fonts.update(loaded)

            # OUT-FONT (audit 2026-07-27 §4.1): Form có thể sở hữu /Font riêng
            # dù trang không có /Font. Không được continue trước traversal:
            # nhánh cũ từng báo success với glyphs=0 và còn nguyên text sống.
            if not _outline_forms(
                pdf, resources, fonts, result, 0, outlined_forms, glyph_source
            ):
                return result
            total += result.pop("_form_glyphs", 0)

            contents = page.get("/Contents")
            if contents is None:
                if font_dict is not None and "/Font" in resources:
                    del resources["/Font"]
                continue
            streams = (
                [c for c in contents]
                if isinstance(contents, pikepdf.Array)
                else [contents]
            )
            data = b"\n".join(
                bytes((s if isinstance(s, pikepdf.Stream) else s.resolve()).read_bytes())
                for s in streams
            )
            new, count = outline_content_stream(
                pdf, data, resources, fonts,
                glyph_source=glyph_source,
                stream_key="page",
            )
            if new is None:
                result["supported"] = False
                result["warnings"].append("content stream có tính năng chữ chưa hỗ trợ")
                return result
            total += count
            page["/Contents"] = pdf.make_indirect(pikepdf.Stream(pdf, new))
            # Font riêng của Form đã được gỡ khi Form được outline.
            if font_dict is not None and "/Font" in resources:
                del resources["/Font"]

        result["glyphs"] = total
        _raise_if_cancelled(cancel_check)
        pdf.remove_unreferenced_resources()
        pdf.save(output_path)
        _raise_if_cancelled(cancel_check)

    # OUT-FONT (audit 2026-07-27 §4.1): visual parity không chứng minh text đã
    # thành path — output giống bản gốc vẫn có thể còn nguyên toán tử Tj.
    try:
        from app.core.outline_fonts import count_live_text

        _raise_if_cancelled(cancel_check)
        live = count_live_text(output_path)
    except Exception as exc:  # noqa: BLE001
        result["supported"] = False
        result["warnings"].append(f"không hậu kiểm được text sống: {exc}")
        return result
    if live.get("total", 0) > 0:
        result["supported"] = False
        result["warnings"].append(
            f"còn {live.get('content_chars', 0)} ký tự text sống sau outline"
        )
        return result

    ok, reason = verify_outline(
        verify_against,
        output_path,
        native_object_level=True,
        cancel_check=cancel_check,
    )
    if not ok:
        result["supported"] = False
        result["warnings"].append(f"verify thất bại: {reason}")
    return result
