"""
overprint_black — Bật Overprint cho object màu ĐEN trong PDF (pikepdf, không RIP).

Vì sao không dùng Ghostscript: ``-dOverprint``/``-dOPM`` của GS chỉ điều khiển cách
RIP *mô phỏng* overprint khi render, KHÔNG ghi cờ ``/OP``/``/op`` vào object trong
file pdfwrite. Kết quả: object đen vẫn knockout → vẫn lỗi viền trắng. Module này
tự chèn ExtGState ``/OP true /op true /OPM 1`` ngay trước thao tác tô/nét của các
object đen (gần như nguyên K), để overprint thực sự được bật trong file xuất.

Quy ước "đen" (chỉ đen gần như thuần để overprint an toàn, KHÔNG đụng rich-black):
  - CMYK (k/K): K >= 0.95 và C,M,Y <= 0.10
  - Gray  (g/G): mức xám <= 0.05
  - RGB   (rg/RG): cả 3 kênh <= 0.05
Màu Spot/Separation (sc/scn/SC/SCN) KHÔNG bao giờ coi là đen (giữ nguyên).

Phương pháp ghi: quét content stream ở mức byte, chỉ CHÈN thêm token
``/<name> gs`` tại biên toán tử (không tái định dạng phần còn lại) → giữ nguyên
byte gốc, an toàn với string literal, inline image (BI…EI), comment.
"""
import logging

import pikepdf

logger = logging.getLogger(__name__)

_WS = b" \t\r\n\f\x00"
_DELIM = b"()<>[]{}/%"

# Ngưỡng nhận màu đen
_K_MIN = 0.95
_NEAR_ZERO = 0.05
_CMY_MAX = 0.10


def _is_black_cmyk(c, m, y, k):
    return k >= _K_MIN and c <= _CMY_MAX and m <= _CMY_MAX and y <= _CMY_MAX


def _is_black_gray(g):
    return g <= _NEAR_ZERO


def _is_black_rgb(r, g, b):
    return r <= _NEAR_ZERO and g <= _NEAR_ZERO and b <= _NEAR_ZERO


_PAINT_OPS = {b"S", b"s", b"f", b"F", b"f*", b"B", b"B*", b"b", b"b*"}
_STROKE_PAINT = {b"S", b"s"}
_FILL_PAINT = {b"f", b"F", b"f*"}


def _scan_and_insert(data: bytes, on_name: bytes, off_name: bytes,
                     enabled: bool, preserve: bool):
    """Quét content stream, trả (bytes_mới, số_lần_chèn).

    Theo dõi trạng thái màu đen của fill/stroke (có stack cho q/Q) và chèn
    ``/on gs`` trước thao tác tô/nét của object đen; chèn ``/off gs`` chỉ để
    HOÀN TÁC overprint do chính module bật (không tắt overprint sẵn có của file
    khi ``preserve=True``). Khi ``preserve=False`` cũng ép tắt trước object
    không-đen để chuẩn hoá knockout.
    """
    n = len(data)
    i = 0
    num_operands = []
    fill_black = False
    stroke_black = False
    applied_op = False           # overprint ĐANG bật do module này chèn
    gstack = []
    inserts = []  # (pos, bytes)

    on_token = b"/" + on_name + b" gs\n"
    off_token = b"/" + off_name + b" gs\n"

    while i < n:
        c = data[i:i + 1]

        if c in _WS:
            i += 1
            continue

        if c == b"%":  # comment tới hết dòng
            while i < n and data[i:i + 1] not in (b"\r", b"\n"):
                i += 1
            continue

        if c == b"(":  # literal string — bỏ qua, cân bằng ngoặc + escape
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
            if data[i + 1:i + 2] == b"<":  # dict mở
                i += 2
            else:                          # hex string
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

        if c == b"/":  # /Name (toán hạng) — bỏ qua nội dung tên
            i += 1
            while i < n and data[i:i + 1] not in _WS and data[i:i + 1] not in _DELIM:
                i += 1
            continue

        # token thường: số hoặc toán tử
        start = i
        while i < n and data[i:i + 1] not in _WS and data[i:i + 1] not in _DELIM:
            i += 1
        tok = data[start:i]

        # số?
        try:
            num_operands.append(float(tok))
            continue
        except ValueError:
            pass

        op = tok

        if op == b"BI":  # inline image — nhảy tới 'EI' (có whitespace bao quanh)
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

        if op == b"q":
            gstack.append((fill_black, stroke_black, applied_op))
        elif op == b"Q":
            if gstack:
                fill_black, stroke_black, applied_op = gstack.pop()
        elif op == b"k":
            if len(num_operands) >= 4:
                fill_black = _is_black_cmyk(*num_operands[-4:])
        elif op == b"K":
            if len(num_operands) >= 4:
                stroke_black = _is_black_cmyk(*num_operands[-4:])
        elif op == b"g":
            if num_operands:
                fill_black = _is_black_gray(num_operands[-1])
        elif op == b"G":
            if num_operands:
                stroke_black = _is_black_gray(num_operands[-1])
        elif op == b"rg":
            if len(num_operands) >= 3:
                fill_black = _is_black_rgb(*num_operands[-3:])
        elif op == b"RG":
            if len(num_operands) >= 3:
                stroke_black = _is_black_rgb(*num_operands[-3:])
        elif op in (b"sc", b"scn"):
            fill_black = False   # Spot/Pattern/Separation → không overprint
        elif op in (b"SC", b"SCN"):
            stroke_black = False
        elif op in _PAINT_OPS:
            if op in _STROKE_PAINT:
                need = stroke_black
            elif op in _FILL_PAINT:
                need = fill_black
            else:  # B/b/B*/b* — tô + nét
                need = stroke_black or fill_black
            need = bool(need) and enabled

            if need and not applied_op:
                inserts.append((start, on_token))
                applied_op = True
            elif applied_op and not need:
                inserts.append((start, off_token))
                applied_op = False
            elif (not preserve) and (not need) and (not applied_op) and enabled:
                # preserve=False: ép tắt overprint trước object không-đen.
                inserts.append((start, off_token))

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


def _page_content_bytes(page, pdf):
    """Đọc & nối toàn bộ content stream của trang (giữ ngữ nghĩa nối)."""
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


def _unique_name(existing_keys, base):
    name = base
    idx = 0
    while ("/" + name) in existing_keys:
        idx += 1
        name = f"{base}{idx}"
    return name


def _ensure_extgstate(page, pdf, on_name, off_name):
    """Đăng ký 2 ExtGState (bật/tắt overprint) vào /Resources của trang."""
    res = page.get("/Resources")
    if res is None:
        page["/Resources"] = pikepdf.Dictionary()
        res = page["/Resources"]
    egs = res.get("/ExtGState")
    if egs is None:
        res["/ExtGState"] = pikepdf.Dictionary()
        egs = res["/ExtGState"]

    egs[pikepdf.Name("/" + on_name)] = pdf.make_indirect(pikepdf.Dictionary({
        "/Type": pikepdf.Name("/ExtGState"),
        "/OP": True,    # overprint nét
        "/op": True,    # overprint tô
        "/OPM": 1,      # overprint mode 1 (đúng cho mực CMYK)
    }))
    egs[pikepdf.Name("/" + off_name)] = pdf.make_indirect(pikepdf.Dictionary({
        "/Type": pikepdf.Name("/ExtGState"),
        "/OP": False,
        "/op": False,
    }))


def apply_black_overprint(input_path: str, output_path: str, params: dict | None = None) -> int:
    """Bật overprint cho object đen trong toàn file. Trả tổng số lần chèn gs.

    params:
      - overprint_black (bool, mặc định True): công tắc chính. False → chỉ lưu bản sao.
      - preserve_overprint (bool, mặc định True): True = không tắt overprint sẵn có
        của object khác; False = ép knockout cho object không-đen.
    """
    params = params or {}
    enabled = params.get("overprint_black", True)
    preserve = params.get("preserve_overprint", True)

    total = 0
    with pikepdf.open(input_path) as pdf:
        for page in pdf.pages:
            data = _page_content_bytes(page, pdf)
            if data is None:
                continue

            res = page.get("/Resources")
            egs_keys = set()
            if res is not None and res.get("/ExtGState") is not None:
                egs_keys = {str(k) for k in res["/ExtGState"].keys()}
            on_name = _unique_name(egs_keys, "PSOPon")
            off_name = _unique_name(egs_keys | {"/" + on_name}, "PSOPoff")

            new_data, ninserts = _scan_and_insert(
                data, on_name.encode("latin-1"), off_name.encode("latin-1"),
                enabled, preserve,
            )
            if ninserts > 0:
                _ensure_extgstate(page, pdf, on_name, off_name)
                page.Contents = pdf.make_stream(new_data)
                total += ninserts

        pdf.save(output_path)

    logger.info("apply_black_overprint: enabled=%s preserve=%s inserts=%d -> %s",
                enabled, preserve, total, output_path)
    return total
