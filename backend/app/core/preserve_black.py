"""
preserve_black — Ép màu ĐEN RGB thuần (0 0 0 rg/RG) sang DeviceGray đen trước khi
chuyển hệ màu, để sau khi GS convert sang CMYK nó ra 100%K (0,0,0,K) thay vì
rich-black 4 màu (gây lệch chồng màu trên text/nét đen mảnh khi in offset).

Cơ sở (đã đo bằng GS 10.04 + tiff32nc):
  - RGB '0 0 0 rg'   → CMYK rich (72,67,67,88) ❌  (cả khi gắn FOGRA39)
  - Gray '0 g'       → CMYK (0,0,0,100) ✅
  - CMYK '0 0 0 1 k' → CMYK (0,0,0,100) ✅ (giữ nguyên)
⇒ chỉ cần đổi nét/tô đen RGB-thuần thành DeviceGray đen; màu khác giữ nguyên.

Kỹ thuật: quét content stream ở mức byte, CHÈN token ``0 g`` / ``0 G`` ngay SAU
toán tử ``rg`` / ``RG`` khi 3 toán hạng ≈ 0 (đè không gian màu về DeviceGray đen).
An toàn với string literal, inline image (BI…EI), comment — không tái định dạng.
"""
import logging

import pikepdf

logger = logging.getLogger(__name__)

_WS = b" \t\r\n\f\x00"
_DELIM = b"()<>[]{}/%"
_EPS = 0.02  # coi như 0 (đen thuần)


def _scan_and_insert(data: bytes) -> tuple[bytes, int]:
    n = len(data)
    i = 0
    num_operands = []
    inserts = []  # (pos, bytes)

    while i < n:
        c = data[i:i + 1]
        if c in _WS:
            i += 1
            continue
        if c == b"%":
            while i < n and data[i:i + 1] not in (b"\r", b"\n"):
                i += 1
            continue
        if c == b"(":
            depth = 1
            i += 1
            while i < n and depth > 0:
                ch = data[i:i + 1]
                if ch == b"\\":
                    i += 2
                    continue
                if ch == b"(":
                    depth += 1
                elif ch == b")":
                    depth -= 1
                i += 1
            num_operands = []
            continue
        if c == b"<":
            if data[i + 1:i + 2] == b"<":
                i += 2
            else:
                i += 1
                while i < n and data[i:i + 1] != b">":
                    i += 1
                i += 1
            num_operands = []
            continue
        if c == b">":
            i += 2 if data[i + 1:i + 2] == b">" else 1
            continue
        if c in b"[]{}":
            i += 1
            continue
        if c == b"/":
            i += 1
            while i < n and data[i:i + 1] not in _WS and data[i:i + 1] not in _DELIM:
                i += 1
            continue

        start = i
        while i < n and data[i:i + 1] not in _WS and data[i:i + 1] not in _DELIM:
            i += 1
        tok = data[start:i]

        try:
            num_operands.append(float(tok))
            continue
        except ValueError:
            pass

        op = tok
        if op == b"BI":  # inline image → nhảy tới EI
            j = i
            while j < n - 1:
                if (data[j:j + 1] == b"E" and data[j + 1:j + 2] == b"I"
                        and (j == 0 or data[j - 1:j] in _WS)
                        and (j + 2 >= n or data[j + 2:j + 3] in _WS)):
                    j += 2
                    break
                j += 1
            i = j
            num_operands = []
            continue

        if op in (b"rg", b"RG") and len(num_operands) >= 3:
            r, g, b = num_operands[-3:]
            if abs(r) <= _EPS and abs(g) <= _EPS and abs(b) <= _EPS:
                # Chèn override DeviceGray đen ngay sau toán tử màu RGB đen.
                inserts.append((i, b" 0 g" if op == b"rg" else b" 0 G"))
        num_operands = []

    if not inserts:
        return data, 0

    out = bytearray()
    prev = 0
    for pos, b in inserts:
        out += data[prev:pos]
        out += b
        prev = pos
    out += data[prev:]
    return bytes(out), len(inserts)


def _page_content_bytes(page):
    contents = page.get("/Contents")
    if contents is None:
        return None
    try:
        if isinstance(contents, pikepdf.Array):
            chunks = []
            for ref in contents:
                try:
                    chunks.append(ref.read_bytes())
                except Exception:
                    pass
            return b"\n".join(chunks) if chunks else b""
        return contents.read_bytes()
    except Exception:
        return None


def force_pure_black_to_gray(input_path: str, output_path: str) -> int:
    """Đổi mọi màu RGB đen thuần (rg/RG = 0,0,0) sang DeviceGray đen.

    Trả tổng số lần chèn. Luôn ghi ``output_path`` (kể cả khi 0 thay đổi → bản sao).
    """
    total = 0
    with pikepdf.open(input_path) as pdf:
        for page in pdf.pages:
            data = _page_content_bytes(page)
            if data is None:
                continue
            new_data, ninserts = _scan_and_insert(data)
            if ninserts > 0:
                page.Contents = pdf.make_stream(new_data)
                total += ninserts
        pdf.save(output_path)
    logger.info("force_pure_black_to_gray: %d màu RGB-đen → DeviceGray (%s)", total, output_path)
    return total
