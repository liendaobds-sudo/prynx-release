"""Chuyển chữ thành đường vector (outline) bằng fontTools — không cần Ghostscript.

Vì sao viết riêng thay vì gọi `-dNoOutputFonts`: Ghostscript làm được việc này,
nhưng nó dựng lại toàn bộ tài liệu và (đã đo ở §16.7) bỏ sót text trong
annotation/AcroForm. Ở đây ta chỉ thay đúng các toán tử chữ trong content
stream, phần còn lại của trang không bị đụng.

# Phạm vi có chủ ý

Chỉ nhận những gì chắc chắn dựng lại đúng; mọi thứ khác trả `supported=False`
để caller fallback Ghostscript:

* Font **đã nhúng** (`/FontFile2` TrueType hoặc `/FontFile3` CFF/OpenType).
  Font chưa nhúng phải mượn glyph của font khác — mặt chữ sẽ khác bản gốc.
* **Simple font** (mã 1 byte). `Type0`/CID cần giải CMap và `/CIDToGIDMap`;
  làm sai ở đó là ra glyph khác hẳn chứ không phải lệch nhẹ.
* Không có `Type3` (glyph là content stream, phải nội suy khác).

Sai một phép biến đổi ở đây thì chữ lệch mà **chỉ lộ ra lúc in**, nên caller
bắt buộc phải verify (so kẽm trước/sau) trước khi tin kết quả.
"""

from __future__ import annotations

import logging

import pikepdf

logger = logging.getLogger(__name__)

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

    def __init__(self, matrix: _Matrix, out: list[str]):
        self._m = matrix
        self._out = out
        self._start: tuple[float, float] | None = None

    def _pt(self, pt) -> str:
        x, y = self._m.apply(pt[0], pt[1])
        return f"{x:.4f} {y:.4f}"

    def moveTo(self, pt):
        self._out.append(f"{self._pt(pt)} m")
        self._start = pt

    def lineTo(self, pt):
        self._out.append(f"{self._pt(pt)} l")

    def curveTo(self, *points):
        # BasePen đã quy mọi đường cong về bậc ba trước khi gọi tới đây.
        if len(points) == 3:
            a, b, c = points
            self._out.append(f"{self._pt(a)} {self._pt(b)} {self._pt(c)} c")
        elif len(points) == 2:  # quadratic còn sót
            a, b = points
            self._out.append(f"{self._pt(a)} {self._pt(b)} {self._pt(b)} c")

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
            self._out.append(f"{self._pt(c1)} {self._pt(c2)} {self._pt(nxt)} c")
            current = nxt
        self._start = current

    def closePath(self):
        self._out.append("h")

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
            items = [x if not hasattr(x, "resolve") else x.resolve() for x in w_array]
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
        if not base:
            for code, gname in enumerate(StandardEncoding):
                if gname and gname != ".notdef":
                    base[code] = gname

        encoding = font_dict.get("/Encoding")
        if encoding is not None:
            enc_obj = encoding if isinstance(encoding, (pikepdf.Dictionary, pikepdf.Name)) else encoding.resolve()
            if isinstance(enc_obj, pikepdf.Dictionary):
                differences = enc_obj.get("/Differences")
                if differences is not None:
                    current = 0
                    for item in differences:
                        item = _deref(item)
                        if isinstance(item, (int, float)):
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
                item = item if not hasattr(item, "resolve") else item.resolve()
                if isinstance(item, (int, float)):
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

    def draw(self, code: int, matrix: _Matrix, out: list[str]) -> bool:
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


def outline_content_stream(
    pdf: pikepdf.Pdf, data: bytes, resources, fonts: dict
) -> tuple[bytes | None, int]:
    """Thay mọi toán tử chữ bằng đường vector. Trả `(content mới, số glyph)`.

    Trả `(None, 0)` khi gặp thứ chưa mô hình hoá — caller phải fallback, tuyệt
    đối không ghi ra bản thiếu chữ.
    """
    try:
        instructions = pikepdf.parse_content_stream(pikepdf.Stream(pdf, data))
    except Exception:  # noqa: BLE001
        return (None, 0)

    out: list[str] = []
    glyphs = 0

    ctm_stack: list[_Matrix] = []
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

    def emit(instr) -> None:
        ops = " ".join(_fmt(o) for o in instr.operands)
        out.append(f"{ops} {instr.operator}".strip())

    def show(raw: bytes) -> bool:
        nonlocal tm, glyphs
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
            if render_mode not in (3, 7):  # 3/7 = ẩn, không lên mực
                # KHÔNG nhân CTM vào đây: path được chèn vào ĐÚNG vị trí cũ
                # trong stream, nên lệnh `cm` phía trước vẫn còn hiệu lực và sẽ
                # tự áp. Nhân thêm ở đây là áp CTM hai lần — trang không có
                # `cm` thì không lộ, trang có thì lệch hẳn (đo được: kẽm Cyan
                # lệch 233/255 trên một file corpus).
                trm = _Matrix(size * hscale, 0.0, 0.0, size, 0.0, rise).then(tm)
                scale = 1.0 / font.upem
                glyph_matrix = _Matrix(scale, 0.0, 0.0, scale, 0.0, 0.0).then(trm)
                if font.draw(code, glyph_matrix, out):
                    glyphs += 1
                else:
                    # Không tra được glyph nghĩa là chữ đó sẽ BIẾN MẤT. Bỏ qua
                    # âm thầm là kiểu hỏng tệ nhất ở đây — file trông vẫn có
                    # chữ, chỉ thiếu vài ký tự, và không ai thấy tới lúc in.
                    return False
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
            ctm_stack.append(ctm)
            emit(instr)
            continue
        if op == "Q":
            ctm = ctm_stack.pop() if ctm_stack else _Matrix()
            emit(instr)
            continue
        if op == "cm":
            try:
                vals = [float(v) for v in operands]
                if len(vals) == 6:
                    ctm = _Matrix(*vals).then(ctm)
            except Exception:  # noqa: BLE001
                return (None, 0)
            emit(instr)
            continue

        if op not in _TEXT_OPS:
            emit(instr)
            continue

        # ── Từ đây là toán tử chữ: KHÔNG phát lại, thay bằng path ──
        try:
            if op == "BT":
                in_text = True
                tm = tlm = _Matrix()
            elif op == "ET":
                in_text = False
            elif op == "Tf":
                name = str(operands[0])
                size = float(operands[1])
                font = fonts.get(name)
                if font is None or not font.ok:
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
                render_mode = int(operands[0])
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
                    if isinstance(item, (int, float)):
                        # Số trong TJ dịch chuyển NGƯỢC chiều, đơn vị 1/1000 em.
                        adv = -float(item) / 1000.0 * size * hscale
                        tm = _Matrix(1.0, 0.0, 0.0, 1.0, adv, 0.0).then(tm)
                    else:
                        if not show(bytes(item)):
                            return (None, 0)
        except Exception as exc:  # noqa: BLE001
            logger.debug("toán tử chữ %s không xử lý được: %s", op, exc)
            return (None, 0)

        # Glyph vừa vẽ được tô ngay: gom nhiều glyph vào một `f` sẽ sai quy tắc
        # even-odd giữa các chữ chồng nhau.
        if op in ("Tj", "TJ", "'", '"') and glyphs:
            out.append("f")

    _ = in_text
    return ("\n".join(out).encode("latin-1", "replace"), glyphs)


def _fmt(obj) -> str:
    if isinstance(obj, pikepdf.Array):
        return "[" + " ".join(_fmt(o) for o in obj) + "]"
    if isinstance(obj, pikepdf.String):
        return f"({bytes(obj).decode('latin-1')})"
    if isinstance(obj, (int,)):
        return str(obj)
    if isinstance(obj, float):
        return f"{obj:.6g}"
    return str(obj)


# Ngưỡng verify sau khi outline. Con số từ đo thật: một trang chữ TrueType
# nhúng cho meanΔ 0.47/255 và phủ +0.19 điểm % (path outline được raster với
# vành fill-adjust nên dày hơn glyph gốc chút ít ở biên). Chữ ĐẶT SAI CHỖ thì
# hai vệt không chồng nhau và phủ gần như gấp đôi — ngưỡng dưới bắt được ngay.
_VERIFY_MEAN_LIMIT = 3.0
_VERIFY_COVERAGE_LIMIT = 1.5


def _plate_stats(pdf_path: str, dpi: int) -> dict[str, tuple[float, "object"]]:
    import base64
    import zlib

    import numpy as np

    from app.core.print_engine import facade

    sep = facade.separations(pdf_path, 1, dpi, ink_accurate=True)
    out = {}
    for plate in sep["plates"]:
        raw = zlib.decompress(base64.b64decode(plate["alpha_data"]))
        arr = np.frombuffer(raw, dtype=np.uint8).reshape(sep["height"], sep["width"])
        out[plate["name"]] = (float((arr > 127).mean() * 100.0), arr.astype(np.int32))
    return out


def verify_outline(original: str, outlined: str, dpi: int = 150) -> tuple[bool, str]:
    """So kẽm trước/sau khi outline. `(False, lý do)` ⇒ KHÔNG được dùng kết quả.

    Đây là chốt an toàn bắt buộc của đường này: một ma trận chữ sai cho ra file
    trông vẫn "có chữ", và lỗi chỉ lộ khi bản in đã chạy. So diện tích phủ và
    sai lệch trung bình trên từng kẽm là cách rẻ nhất bắt được nó.
    """
    try:
        import numpy as np

        before = _plate_stats(original, dpi)
        after = _plate_stats(outlined, dpi)
    except Exception as exc:  # noqa: BLE001
        return (False, f"không render được để verify: {exc}")

    if set(before) != set(after):
        return (False, f"số kẽm đổi: {sorted(before)} → {sorted(after)}")

    for name, (cov_before, arr_before) in before.items():
        cov_after, arr_after = after[name]
        if arr_before.shape != arr_after.shape:
            return (False, f"khổ raster đổi ở kẽm {name}")
        mean_delta = float(np.abs(arr_before - arr_after).mean())
        if mean_delta > _VERIFY_MEAN_LIMIT:
            return (False, f"kẽm {name} lệch {mean_delta:.2f}/255 sau outline")
        if abs(cov_after - cov_before) > _VERIFY_COVERAGE_LIMIT:
            return (
                False,
                f"kẽm {name} đổi diện tích phủ {cov_before:.2f}% → {cov_after:.2f}%",
            )
    return (True, "")


def outline_fonts(input_path: str, output_path: str) -> dict:
    """Chuyển toàn bộ chữ thành vector. `supported=False` ⇒ caller fallback GS.

    Kết quả **luôn được verify** bằng cách so kẽm với bản gốc trước khi trả về;
    verify hỏng thì coi như không làm được, vì một file chữ lệch còn tệ hơn
    file chưa outline.
    """
    result: dict = {"supported": True, "glyphs": 0, "warnings": []}

    # Text nằm trong annotation / AcroForm field cũng lên bản in, và outline chỉ
    # content stream sẽ bỏ sót đúng phần đó — lỗi này đã được sửa một lần cho
    # đường Ghostscript (§16.7), đường native không được để nó quay lại.
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
            source = tmp_flat
        except Exception as exc:  # noqa: BLE001
            result["supported"] = False
            result["warnings"].append(f"không bake được annotation: {exc}")
            os.path.exists(tmp_flat) and os.remove(tmp_flat)
            return result
    try:
        return _outline_document(source, output_path, input_path, result)
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


def _outline_forms(pdf, resources, inherited_fonts, result, depth: int) -> bool:
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
            if key is not None and key in _outlined_forms:
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

            if not _outline_forms(pdf, inner_res, own_fonts, result, depth + 1):
                return False

            data = bytes(form.read_bytes())
            new, count = outline_content_stream(pdf, data, target_res, own_fonts)
            if new is None:
                result["supported"] = False
                result["warnings"].append(
                    "Form XObject có tính năng chữ chưa hỗ trợ"
                )
                return False
            form.write(new)
            result["_form_glyphs"] = result.get("_form_glyphs", 0) + count
            if key is not None:
                _outlined_forms.add(key)
            if inner_res is not None and "/Font" in inner_res:
                del inner_res["/Font"]
        except Exception as exc:  # noqa: BLE001
            result["supported"] = False
            result["warnings"].append(f"không outline được Form XObject: {exc}")
            return False
    return True


_outlined_forms: set = set()


def _outline_document(
    input_path: str, output_path: str, verify_against: str, result: dict
) -> dict:
    # Form dùng lại ở nhiều trang chỉ được outline MỘT lần; chạy hai lần trên
    # cùng stream sẽ nhân đôi path và làm chữ dày lên.
    _outlined_forms.clear()
    with pikepdf.open(input_path) as pdf:
        total = 0
        for page in pdf.pages:
            resources = page.get("/Resources")
            if resources is None:
                continue
            font_dict = resources.get("/Font")
            if font_dict is None:
                continue

            fonts = _load_fonts(font_dict, pdf, result)
            if fonts is None:
                return result

            # Chữ cũng nằm trong Form XObject — outline chúng TRƯỚC, vì sau đó
            # `/Font` của trang bị xoá và Form kế thừa resources của trang khi
            # tự nó không khai (§8.10.1); bỏ sót thì chữ trong Form mất hẳn
            # (đo được: kẽm Cyan lệch 233/255 trên một file corpus).
            if not _outline_forms(pdf, resources, fonts, result, 0):
                return result
            total += result.pop("_form_glyphs", 0)

            contents = page.get("/Contents")
            streams = (
                [c for c in contents]
                if isinstance(contents, pikepdf.Array)
                else [contents]
            )
            data = b"\n".join(
                bytes((s if isinstance(s, pikepdf.Stream) else s.resolve()).read_bytes())
                for s in streams
            )
            new, count = outline_content_stream(pdf, data, resources, fonts)
            if new is None:
                result["supported"] = False
                result["warnings"].append("content stream có tính năng chữ chưa hỗ trợ")
                return result
            total += count
            page["/Contents"] = pdf.make_indirect(pikepdf.Stream(pdf, new))
            # Bỏ hẳn tài nguyên font: còn để lại thì file vẫn "phụ thuộc font"
            # đúng thứ người dùng bấm nút để thoát khỏi.
            del resources["/Font"]

        result["glyphs"] = total
        pdf.remove_unreferenced_resources()
        pdf.save(output_path)

    ok, reason = verify_outline(verify_against, output_path)
    if not ok:
        result["supported"] = False
        result["warnings"].append(f"verify thất bại: {reason}")
    return result
