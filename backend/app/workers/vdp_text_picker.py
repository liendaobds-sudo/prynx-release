"""
vdp_text_picker.py — Module hỗ trợ bóc tách Text Object từ file thiết kế PDF để chuyển thành trường VDP (Click-to-Convert).

Chức năng:
1. Đọc thuộc tính chính xác của một Text Object (BBox, cỡ chữ, màu sắc, font, nội dung).
2. Quy đổi BBox (point, bottom-left) sang hệ mm (top-left) khớp chuẩn VdpToolField.
3. Tự động bóc tách / xóa text object gốc khỏi file PDF phôi bằng stream_editor (pikepdf color-safe).
4. Hỗ trợ quét tự động các chuỗi Tag ({{...}}, [[...]]) trên trang.
"""
from __future__ import annotations

import os
import re
import uuid
import logging
from typing import Optional, List, Dict, Any

import pikepdf
from app.core import geometry_reader, stream_editor
from app.core.vietnamese_text_repair import repair_vietnamese_pdf_text
from app.core.font_downloader import get_prynx_fonts_dir, download_google_font_if_available
from app.schemas.edit import ObjMeta

logger = logging.getLogger(__name__)

VALID_FONT_EXTENSIONS = ('.ttf', '.otf', '.ttc')

COMMON_PDF_FONT_MAP = {
    'arial': 'arial.ttf',
    'helvetica': 'arial.ttf',
    'times': 'times.ttf',
    'times-roman': 'times.ttf',
    'timesroman': 'times.ttf',
    'times new roman': 'times.ttf',
    'timesnewroman': 'times.ttf',
    'courier': 'cour.ttf',
    'courier new': 'cour.ttf',
    'couriernew': 'cour.ttf',
    'tahoma': 'tahoma.ttf',
    'calibri': 'calibri.ttf',
    'verdana': 'verdana.ttf',
    'segoe ui': 'segoeui.ttf',
    'segoeui': 'segoeui.ttf',
    'georgia': 'georgia.ttf',
    'trebuchet ms': 'trebuc.ttf',
    'trebuchet': 'trebuc.ttf',
    'impact': 'impact.ttf',
    'comic sans ms': 'comic.ttf',
    'comic sans': 'comic.ttf',
}


def _is_bold_font_name(name: str) -> bool:
    n = (name or "").lower()
    return any(k in n for k in ("bold", "black", "heavy", "700", "800", "900", "semibold", "demibold", "600"))


def _find_font_in_windows_registry(clean_name: str) -> Optional[str]:
    """Tra cứu font đã đăng ký trong Windows Registry (cả hệ thống và user).
    Chỉ chấp nhận file định dạng vector (.ttf, .otf, .ttc), bỏ qua file bitmap (.fon).
    """
    if not clean_name:
        return None
    try:
        import winreg
    except ImportError:
        return None

    target = clean_name.lower().replace("-", "").replace("_", "").replace(" ", "")
    prynx_dir = get_prynx_fonts_dir()
    base_dirs = [
        prynx_dir,
        os.path.expanduser(r"~\AppData\Local\PrynX\fonts"),
        r"C:\Windows\Fonts",
        os.path.expanduser(r"~\AppData\Local\Microsoft\Windows\Fonts"),
        r"C:\Program Files\Common Files\Adobe\Fonts",
        r"C:\Program Files (x86)\Common Files\Adobe\Fonts",
    ]

    for hkey in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        try:
            with winreg.OpenKey(hkey, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts") as key:
                num_values = winreg.QueryInfoKey(key)[1]
                # Pass 1: Khớp chính xác tên font
                for i in range(num_values):
                    reg_name, val, _ = winreg.EnumValue(key, i)
                    val_str = str(val)
                    if not any(val_str.lower().endswith(ext) for ext in VALID_FONT_EXTENSIONS):
                        continue
                    clean_reg = re.sub(r"\s*\([^)]*\)", "", reg_name).lower().replace("-", "").replace("_", "").replace(" ", "")
                    if clean_reg == target:
                        if os.path.isabs(val_str) and os.path.isfile(val_str):
                            return val_str
                        for bdir in base_dirs:
                            p = os.path.join(bdir, val_str)
                            if os.path.isfile(p):
                                return p
                # Pass 2: Khớp chứa (substring) có bảo vệ kiểu dáng (Style Parity)
                for i in range(num_values):
                    reg_name, val, _ = winreg.EnumValue(key, i)
                    val_str = str(val)
                    if not any(val_str.lower().endswith(ext) for ext in VALID_FONT_EXTENSIONS):
                        continue
                    clean_reg = re.sub(r"\s*\([^)]*\)", "", reg_name).lower().replace("-", "").replace("_", "").replace(" ", "")
                    if (target in clean_reg or clean_reg in target) and (_is_bold_font_name(target) == _is_bold_font_name(clean_reg)):
                        if os.path.isabs(val_str) and os.path.isfile(val_str):
                            return val_str
                        for bdir in base_dirs:
                            p = os.path.join(bdir, val_str)
                            if os.path.isfile(p):
                                return p
        except Exception:
            continue
    return None


def resolve_font_file(font_name: Optional[str]) -> Optional[str]:
    """Tìm file font (.ttf, .otf, .ttc) trên hệ thống khớp với fontName.
    Trả về đường dẫn tuyệt đối nếu tìm thấy, hoặc None nếu không có trên máy."""
    if not font_name:
        return None
    raw_name = str(font_name).strip()
    clean_name = re.sub(r"^[A-Z]{6}\+", "", raw_name).strip()
    clean_target = clean_name.lower().replace("-", "").replace("_", "").replace(" ", "")

    prynx_dir = get_prynx_fonts_dir()
    base_dirs = [
        prynx_dir,
        os.path.expanduser(r"~\AppData\Local\PrynX\fonts"),
        r"C:\Windows\Fonts",
        os.path.expanduser(r"~\AppData\Local\Microsoft\Windows\Fonts"),
        r"C:\Program Files\Common Files\Adobe\Fonts",
        r"C:\Program Files (x86)\Common Files\Adobe\Fonts",
    ]

    # 1. Kiểm tra bảng font PDF tiêu chuẩn (Standard PDF fonts) để tránh nhầm font biến thể phụ
    common_target = COMMON_PDF_FONT_MAP.get(clean_target) or COMMON_PDF_FONT_MAP.get(clean_name.lower())
    if common_target:
        for bdir in base_dirs:
            p = os.path.join(bdir, common_target)
            if os.path.isfile(p):
                return p

    # 2. Tra cứu Windows Registry (chuẩn xác nhất cho mọi font cài đặt kể cả tên có dấu cách)
    reg_path = _find_font_in_windows_registry(clean_name) or _find_font_in_windows_registry(raw_name)
    if reg_path:
        return reg_path

    # 3. Quét các thư mục font chuẩn - Pass 1: Khớp chính xác tên file (stem)
    for d in base_dirs:
        if not os.path.isdir(d):
            continue
        try:
            for f in os.listdir(d):
                stem, ext = os.path.splitext(f)
                if ext.lower() not in VALID_FONT_EXTENSIONS:
                    continue
                clean_stem = stem.lower().replace("-", "").replace("_", "").replace(" ", "")
                if clean_stem == clean_target:
                    return os.path.join(d, f)
        except Exception:
            continue

    # 4. Quét các thư mục font chuẩn - Pass 2: Khớp chứa (substring) có bảo vệ kiểu dáng
    for d in base_dirs:
        if not os.path.isdir(d):
            continue
        try:
            for f in os.listdir(d):
                stem, ext = os.path.splitext(f)
                if ext.lower() not in VALID_FONT_EXTENSIONS:
                    continue
                clean_stem = stem.lower().replace("-", "").replace("_", "").replace(" ", "")
                if (clean_target in clean_stem or clean_stem in clean_target) and (_is_bold_font_name(clean_target) == _is_bold_font_name(clean_stem)):
                    return os.path.join(d, f)
        except Exception:
            continue

    # 5. Nếu chưa có trên máy, thử tải tự động từ Google Fonts / font cache
    downloaded = (
        download_google_font_if_available(clean_name)
        or download_google_font_if_available(raw_name)
    )
    if downloaded and os.path.isfile(downloaded):
        return downloaded

    return None


_resolve_font_file = resolve_font_file


def _extract_t2_charstring_width(cs, nominal_w: int = 0, default_w: int = 1000) -> int:
    """Trích xuất advance width chuẩn xác từ Type 2 CharString (CFF) theo Adobe Spec #5177."""
    try:
        cs.decompile()
        prog = cs.program
        first_op_idx = None
        for idx, token in enumerate(prog):
            if isinstance(token, str):
                first_op_idx = idx
                break
        if first_op_idx is not None and first_op_idx > 0:
            op = prog[first_op_idx]
            args = prog[:first_op_idx]
            has_width = False
            if op in ("hstem", "vstem", "hstemhm", "vstemhm", "hintmask", "cntrmask"):
                has_width = (len(args) % 2 == 1)
            elif op in ("rmoveto",):
                has_width = (len(args) == 3)
            elif op in ("hmoveto", "vmoveto"):
                has_width = (len(args) == 2)
            elif op in ("endchar",):
                has_width = (len(args) in (1, 5))
            if has_width and len(args) > 0:
                return int(nominal_w + args[0])
    except Exception:
        pass
    return int(default_w)


def wrap_cff_to_otf(
    cff_data: bytes,
    font_family: str = "VdpFont",
    is_bold: bool = False,
    is_italic: bool = False,
    differences_map: Optional[Dict[str, int]] = None,
) -> bytes:
    """Đóng gói raw CFF stream (Compact Font Format / Type1C) thành file OpenType (.otf) hợp lệ hoàn chỉnh (OTTO sfnt header).
    Đảm bảo 100% chuẩn OpenType Sanitizer (OTS) của Chromium/WebView2:
    - Bảng name: đầy đủ familyName, styleName, fullName, uniqueFontIdentifier, psName, version.
    - Bảng OS/2: usWinAscent, usWinDescent, fsType=0 (Installable), sCapHeight, achVendID.
    - Bảng cmap: hỗ trợ AGL, uniXXXX, uXXXX và differences_map.
    - Bảng hmtx: trích xuất chính xác advance width của từng glyph từ Type 2 CharStrings.
    """
    try:
        from fontTools.ttLib import TTFont, newTable
        from fontTools.cffLib import CFFFontSet
        from fontTools.agl import toUnicode
        from fontTools.fontBuilder import FontBuilder
        import io

        cff = CFFFontSet()
        cff.decompile(io.BytesIO(cff_data), None)

        font = TTFont(sfntVersion="OTTO")
        fb = FontBuilder(font=font)

        # 1. Bảng CFF
        cff_table = newTable("CFF ")
        cff_table.cff = cff
        font["CFF "] = cff_table

        top_dict = cff[0]
        ps_name = getattr(top_dict, "FontName", font_family.replace(" ", "")) or font_family.replace(" ", "")

        char_strings = top_dict.CharStrings
        glyph_names = list(char_strings.keys())
        fb.setupGlyphOrder(glyph_names)

        # 2. Bounding Box & UPM
        bbox = getattr(top_dict, "FontBBox", [-200, -200, 1000, 1000])
        x_min, y_min, x_max, y_max = [int(v) for v in bbox]

        # 3. Metrics (hmtx): giải mã chính xác advance width từ CFF CharStrings
        priv = getattr(top_dict, "Private", None)
        nominal_w = getattr(priv, "nominalWidthX", 0) if priv else 0
        default_w = getattr(priv, "defaultWidthX", 1000) if priv else 1000

        metrics = {}
        for gn in glyph_names:
            cs = char_strings[gn]
            w = _extract_t2_charstring_width(cs, nominal_w, default_w)
            metrics[gn] = (int(w), 0)

        ascent = max(y_max, 800)
        descent = min(y_min, -200)

        fb.setupHorizontalMetrics(metrics)
        fb.setupHorizontalHeader(ascent=ascent, descent=descent)
        fb.setupHead(
            unitsPerEm=1000,
            xMin=x_min,
            yMin=y_min,
            xMax=x_max,
            yMax=y_max,
            macStyle=(1 if is_bold else 0) | (2 if is_italic else 0),
        )
        fb.setupMaxp()

        # 4. Character Map (cmap)
        cmap = {}
        for gn in glyph_names:
            uni = toUnicode(gn)
            if not uni:
                # Phân giải định dạng tên glyph unicode (uniXXXX hoặc uXXXX)
                if gn.startswith("uni") and len(gn) == 7:
                    try:
                        uni = chr(int(gn[3:], 16))
                    except Exception:
                        pass
                elif gn.startswith("u") and len(gn) in (5, 6):
                    try:
                        uni = chr(int(gn[1:], 16))
                    except Exception:
                        pass
            if uni:
                cmap[ord(uni)] = gn

        if differences_map:
            for gname, code in differences_map.items():
                if gname in char_strings and code not in cmap:
                    cmap[code] = gname

        if len(cmap) < len(glyph_names) // 2:
            for idx, gn in enumerate(glyph_names):
                if idx > 0 and idx not in cmap:
                    cmap[idx] = gn
        fb.setupCharacterMap(cmap)

        # 5. Name Table
        style = "Bold" if is_bold else ("Italic" if is_italic else "Regular")
        name_strings = {
            "familyName": font_family,
            "styleName": style,
            "fullName": f"{font_family} {style}".strip(),
            "psName": ps_name,
            "uniqueFontIdentifier": f"PrynX;{font_family} {style};2026",
            "version": "Version 1.000",
        }
        fb.setupNameTable(name_strings)

        # 6. OS/2
        weight_class = 700 if is_bold else 400
        fb.setupOS2(
            sTypoAscender=ascent,
            sTypoDescender=descent,
            sTypoLineGap=0,
            usWinAscent=ascent,
            usWinDescent=abs(descent),
            usWeightClass=weight_class,
            fsSelection=(0x20 if is_bold else 0) | (0x01 if is_italic else 0),
            fsType=0,  # 0 = Installable embedding (bắt buộc cho Chromium OTS)
            achVendID=b"PRYN",
            sCapHeight=int(ascent * 0.7),
        )

        # 7. Post & Dummy DSIG
        fb.setupPost()
        fb.setupDummyDSIG()

        buf = io.BytesIO()
        font.save(buf)
        return buf.getvalue()
    except Exception as exc:
        logger.warning("Không thể wrap raw CFF thành OTF bằng fontTools: %s", exc)
        return cff_data


def _extract_embedded_font_from_pdf(
    pdf_path: str,
    page_index: int,
    font_name: Optional[str],
    content: Optional[str] = None,
) -> Optional[str]:
    """
    Trích xuất font nhúng (FontFile2 TrueType, FontFile3 CFF/OTF, FontFile Type1)
    trực tiếp từ file PDF gốc nếu font không được cài trên máy tính.
    Lưu vào thư mục cache VDP để frontend hiển thị đúng 100% font gốc.
    """
    if not pdf_path or not os.path.isfile(pdf_path):
        return None

    try:
        clean_target = (
            re.sub(r"^[A-Z]{6}\+", "", font_name or "")
            .lower()
            .replace("-", "")
            .replace("_", "")
            .replace(" ", "")
        )

        with pikepdf.open(pdf_path) as pdf:
            if page_index < 0 or page_index >= len(pdf.pages):
                pages_to_check = list(pdf.pages)
            else:
                target_p = pdf.pages[page_index]
                pages_to_check = [target_p] + [p for i, p in enumerate(pdf.pages) if i != page_index]

            # Thu thập tất cả các font descriptor khả dĩ
            candidates = []
            for page in pages_to_check:
                res = page.get("/Resources")
                if not res or "/Font" not in res:
                    continue
                fonts_dict = res["/Font"]
                for _font_key, font_obj in fonts_dict.items():
                    font_dict = font_obj if isinstance(font_obj, pikepdf.Dictionary) else font_obj.resolve()
                    base_font = str(font_dict.get("/BaseFont", ""))
                    clean_bf = (
                        re.sub(r"^/[A-Z]{6}\+", "", base_font)
                        .lstrip("/")
                        .lower()
                        .replace("-", "")
                        .replace("_", "")
                        .replace(" ", "")
                    )

                    desc = font_dict.get("/FontDescriptor")
                    if desc is None and "/DescendantFonts" in font_dict:
                        descendants = font_dict["/DescendantFonts"]
                        if len(descendants) > 0:
                            desc_font = descendants[0]
                            desc_font_dict = desc_font if isinstance(desc_font, pikepdf.Dictionary) else desc_font.resolve()
                            desc = desc_font_dict.get("/FontDescriptor")

                    if desc is not None:
                        desc = desc if isinstance(desc, pikepdf.Dictionary) else desc.resolve()
                        candidates.append((clean_bf, base_font, desc, font_dict))

            if not candidates:
                return None

            def _score_candidate(cand_clean: str) -> int:
                t = clean_target
                c = cand_clean
                if t == c:
                    return 1000
                if t + "regular" == c or c + "regular" == t:
                    return 950

                def get_cat(n: str) -> str:
                    if any(k in n for k in ("black", "heavy", "extrabold", "900", "800")):
                        return "black"
                    if any(k in n for k in ("semibold", "demibold", "600")):
                        return "semibold"
                    if any(k in n for k in ("bold", "700")):
                        return "bold"
                    if any(k in n for k in ("medium", "500")):
                        return "medium"
                    if any(k in n for k in ("light", "thin", "300", "200", "100")):
                        return "light"
                    return "regular"

                t_cat = get_cat(t)
                c_cat = get_cat(c)

                tokens = ("regular", "bold", "semibold", "demibold", "black", "heavy", "extrabold", "medium", "light", "thin", "italic", "oblique")
                t_fam = t
                c_fam = c
                for tok in tokens:
                    t_fam = t_fam.replace(tok, "")
                    c_fam = c_fam.replace(tok, "")

                if not (t_fam == c_fam or t_fam in c_fam or c_fam in t_fam):
                    return -100

                sc = 500
                if t_fam == c_fam:
                    sc += 200
                if t_cat == c_cat:
                    sc += 250
                else:
                    sc -= 400
                return sc

            candidates.sort(key=lambda c: _score_candidate(c[0]), reverse=True)
            if not candidates or _score_candidate(candidates[0][0]) <= 0:
                if len(candidates) == 1:
                    selected_candidate = candidates[0]
                else:
                    return None
            else:
                selected_candidate = candidates[0]

            clean_bf, base_font, desc, selected_font_dict = selected_candidate

            diff_map = {}
            if selected_font_dict and "/Encoding" in selected_font_dict:
                enc = selected_font_dict["/Encoding"]
                try:
                    enc_dict = enc if isinstance(enc, pikepdf.Dictionary) else enc.resolve() if hasattr(enc, "resolve") else None
                    if enc_dict and "/Differences" in enc_dict:
                        diffs = enc_dict["/Differences"]
                        curr_code = 0
                        for item in diffs:
                            if isinstance(item, (int, pikepdf.Integer)):
                                curr_code = int(item)
                            else:
                                gn_item = str(item).lstrip("/")
                                diff_map[gn_item] = curr_code
                                curr_code += 1
                except Exception:
                    pass

            data = None
            ext = ".ttf"
            for k in ("/FontFile2", "/FontFile3", "/FontFile"):
                ff = desc.get(k)
                if ff is not None:
                    try:
                        stream = ff if isinstance(ff, pikepdf.Stream) else ff.resolve()
                        data = bytes(stream.read_bytes())
                        if k == "/FontFile3":
                            if data[:4] == b"OTTO":
                                ext = ".otf"
                            elif data[:4] == b"\x00\x01\x00\x00":
                                ext = ".ttf"
                            else:
                                # Raw CFF stream: bọc thành valid OpenType (.otf)
                                ext = ".otf"
                                cand_lower = clean_bf.lower()
                                is_bold = any(kw in cand_lower for kw in ("bold", "heavy", "black", "700", "800", "900"))
                                is_italic = any(kw in cand_lower for kw in ("italic", "oblique"))
                                clean_family = re.sub(r"^[A-Z]{6}\+", "", base_font.lstrip("/"))
                                data = wrap_cff_to_otf(
                                    data,
                                    font_family=clean_family,
                                    is_bold=is_bold,
                                    is_italic=is_italic,
                                    differences_map=diff_map,
                                )
                        elif k == "/FontFile2":
                            ext = ".ttf"
                        break
                    except Exception:
                        continue

            if data and len(data) > 100:
                # Kiểm tra độ phủ ký tự của font nhúng đối với nội dung cần hiển thị
                try:
                    from fontTools.ttLib import TTFont
                    import io
                    tt_check = TTFont(io.BytesIO(data))
                    cmap = tt_check.getBestCmap() or {}

                    if content and str(content).strip():
                        missing_content = [ch for ch in str(content) if ord(ch) not in cmap and not ch.isspace()]
                        if missing_content:
                            logger.info(
                                "Font nhúng '%s' thiếu %d ký tự cho nội dung ('%s'). Thử tìm font đầy đủ trên hệ thống...",
                                clean_bf, len(missing_content), "".join(missing_content[:5])
                            )
                            installed_alt = (
                                _find_font_in_windows_registry(clean_bf)
                                or _find_font_in_windows_registry(clean_target)
                                or _find_font_in_windows_registry(font_name)
                            )
                            if installed_alt and os.path.isfile(installed_alt):
                                return installed_alt
                        else:
                            logger.info(
                                "Font nhúng '%s' phủ đầy đủ 100%% các ký tự của nội dung ('%s').",
                                clean_bf, str(content)[:30]
                            )
                except Exception as cov_err:
                    logger.debug("Không thể kiểm tra coverage glyph: %s", cov_err)

                import tempfile, hashlib
                vdp_font_dir = os.path.join(tempfile.gettempdir(), "PrynX-dev", "vdp_fonts")
                os.makedirs(vdp_font_dir, exist_ok=True)
                h = hashlib.md5(data[:512]).hexdigest()[:8]
                safe_name = re.sub(r"[^\w-]", "_", clean_bf or "vdp_font")[:24]
                saved_path = os.path.join(vdp_font_dir, f"{safe_name}_{h}{ext}")
                if not os.path.isfile(saved_path) or os.path.getsize(saved_path) != len(data):
                    with open(saved_path, "wb") as f_out:
                        f_out.write(data)
                return saved_path
    except Exception as e:
        logger.warning("Không thể trích xuất font nhúng từ PDF: %s", e)
    return None

TAG_PATTERN = re.compile(r"\{\{([^}]+)\}\}|\[\[([^\]]+)\]\]|<<([^>]+)>>")

import math

def _calculate_actual_font_size(raw_size: Optional[float], matrix: Optional[List[float]], pt_h: float) -> float:
    """
    Tính cỡ chữ thực tế có tính đến Text Matrix (CTM / Tm).
    Trong PDF (đặc biệt từ Illustrator/Corel), toán tử Tf có thể chỉ đặt cỡ 1.0pt,
    trong khi toàn bộ độ phóng đại thực sự nằm trong ma trận [a, b, c, d, e, f],
    với scale_y = sqrt(c^2 + d^2) và scale_x = sqrt(a^2 + b^2).
    """
    scale_y = 1.0
    scale_x = 1.0
    if matrix and len(matrix) >= 4:
        a, b, c, d = matrix[0], matrix[1], matrix[2], matrix[3]
        scale_x = math.sqrt(a * a + b * b)
        scale_y = math.sqrt(c * c + d * d)

    base_size = raw_size if (raw_size and raw_size > 0.1) else 1.0
    scale = scale_y if scale_y > 0.01 else (scale_x if scale_x > 0.01 else 1.0)
    actual_size = base_size * scale

    if actual_size <= 2.0:
        actual_size = pt_h * 1.0

    return round(actual_size, 1)



def _sanitize_field_name(raw: str, fallback_idx: int = 1) -> str:
    """Tạo tên trường hợp lệ, gọn gàng từ nội dung text."""
    # Kiểm tra nếu là tag
    m = TAG_PATTERN.search(raw)
    if m:
        name = m.group(1) or m.group(2) or m.group(3)
        clean = re.sub(r"[^\w\s-]", "", name).strip()
        clean = re.sub(r"[-\s]+", "_", clean)
        if clean:
            return clean

    # Nếu là text thông thường (ví dụ: 'Nguyễn Văn A' -> 'Nguyen_Van_A' hoặc 'Truong_X')
    # Bỏ các ký tự đặc biệt
    clean = re.sub(r"[^\w\s-]", "", raw).strip()
    clean = re.sub(r"[-\s]+", "_", clean)
    if len(clean) > 20:
        clean = clean[:20].rstrip("_")
    if clean and not clean.isdigit():
        return clean
    return f"Truong_{fallback_idx}"


def _get_page_cropbox(pdf_page) -> tuple[float, float, float, float]:
    """Lấy [x0, y0, x1, y1] của CropBox (fallback MediaBox)."""
    try:
        b = pdf_page.cropbox
    except Exception:
        b = pdf_page.mediabox
    return float(b[0]), float(b[1]), float(b[2]), float(b[3])


def _detect_clockwise_rotation(matrix: Optional[List[float]]) -> int:
    """
    Trích xuất góc xoay chuẩn của PrynX (0, 90, 180, 270 độ theo chiều kim đồng hồ)
    từ ma trận biến đổi của Text Object trong PDF.

    Quy đổi từ hệ PDF (gốc dưới-trái, góc dương ngược chiều kim đồng hồ):
    - Text ngang chuẩn (hướng +X, sang phải): a > 0, b = 0 -> angle = 0°   -> Clockwise = 0°
    - Text dọc từ trên xuống (hướng -Y, xuống dưới): a = 0, b < 0 -> angle = 270° -> Clockwise = 90°
    - Text ngược từ phải sang trái (hướng -X): a < 0, b = 0 -> angle = 180° -> Clockwise = 180°
    - Text dọc từ dưới lên (hướng +Y, lên trên): a = 0, b > 0 -> angle = 90°  -> Clockwise = 270°
    """
    if not matrix or len(matrix) < 2:
        return 0
    import math
    a, b = float(matrix[0]), float(matrix[1])
    if abs(a) < 1e-4 and abs(b) < 1e-4:
        return 0
    angle_rad = math.atan2(b, a)
    angle_deg = (round(math.degrees(angle_rad)) % 360 + 360) % 360

    # Tìm bước 90 độ gần nhất (0, 90, 180, 270)
    steps = [0, 90, 180, 270]
    nearest = min(steps, key=lambda s: min(abs(angle_deg - s), abs(angle_deg - (s + 360)), abs(angle_deg - (s - 360))))
    diff = min(abs(angle_deg - nearest), abs(angle_deg - (nearest + 360)), abs(angle_deg - (nearest - 360)))
    if diff <= 15.0:
        return (360 - nearest) % 360
    return 0


def _detect_text_alignment(
    bx0: float,
    bx1: float,
    page_cropbox: tuple[float, float, float, float],
    all_objects: List[Any],
    target_obj: Any,
) -> str:
    """Xác định căn lề (left, center, right) của đoạn văn bản dựa trên bố cục trang và các dòng lân cận."""
    cx0, cy0, cx1, cy1 = page_cropbox
    page_w = cx1 - cx0
    text_cx = (bx0 + bx1) / 2.0

    # 1. So sánh với các trục đối xứng của trang (tâm trang, tâm 1/4 trang, tâm 3/4 trang)
    anchors = [
        cx0 + page_w * 0.5,
        cx0 + page_w * 0.25,
        cx0 + page_w * 0.75,
    ]
    for anc in anchors:
        if abs(text_cx - anc) <= 4.0:
            return "center"

    # 2. So sánh với các dòng text lân cận trong cùng khu vực dọc (cùng khối)
    text_objs = [
        o for o in all_objects
        if getattr(o, "type", None) == "text" and getattr(o, "drawIndex", None) != getattr(target_obj, "drawIndex", None)
    ]
    # Tìm các text object nằm gần theo trục dọc (+/- 120pt)
    target_bbox = getattr(target_obj, "bbox", [0, 0, 0, 0])
    nearby = [
        o for o in text_objs
        if abs(o.bbox[1] - target_bbox[1]) <= 120.0 and (o.bbox[2] - o.bbox[0]) > 8.0
    ]
    if nearby:
        center_matches = sum(1 for o in nearby if abs((o.bbox[0] + o.bbox[2]) / 2.0 - text_cx) <= 3.0)
        left_matches = sum(1 for o in nearby if abs(o.bbox[0] - bx0) <= 3.0)
        right_matches = sum(1 for o in nearby if abs(o.bbox[2] - bx1) <= 3.0)
        if center_matches > left_matches and center_matches > right_matches:
            return "center"
        if right_matches > left_matches and right_matches >= center_matches:
            return "right"
        if left_matches >= right_matches and left_matches >= center_matches and left_matches > 0:
            return "left"

    return "left"


def _get_font_cap_height_ratio(font_path: Optional[str]) -> float:
    if not font_path or not os.path.isfile(font_path):
        return 0.68
    try:
        import struct
        with open(font_path, 'rb') as f:
            data = f.read()
        num_tables, = struct.unpack('>H', data[4:6])
        tables = {}
        for i in range(num_tables):
            tag = data[12 + i*16 : 16 + i*16].decode('latin1', 'ignore')
            offset, length = struct.unpack('>II', data[12 + i*16 + 8 : 12 + i*16 + 16])
            tables[tag] = (offset, length)
        
        if 'head' in tables and 'OS/2' in tables:
            head_off = tables['head'][0]
            upm, = struct.unpack('>H', data[head_off + 18 : head_off + 20])
            os2_off = tables['OS/2'][0]
            version, = struct.unpack('>H', data[os2_off : os2_off + 2])
            if version >= 2 and tables['OS/2'][1] >= 90:
                cap_height, = struct.unpack('>h', data[os2_off + 88 : os2_off + 90])
                if cap_height > 0 and upm > 0:
                    return cap_height / upm
    except Exception:
        pass
    return 0.68


def _detect_curved_text_group(
    target_obj: ObjMeta,
    all_objects: List[ObjMeta],
    pdf_path: str,
    page_index: int,
) -> List[Dict[str, Any]]:
    """
    Phát hiện chuỗi ký tự uốn cong (Type on a Path / Text Warp từ Illustrator/Corel).
    Khi text cong xuất bản sang PDF, mỗi ký tự trở thành 1 text object riêng lẻ với matrix xoay riêng.
    Hàm này nhóm toàn bộ các ký tự liên tiếp cùng font, cùng màu, cùng cỡ chữ trên cung đường cong.
    """
    text_objs = [o for o in all_objects if o.type == "text"]
    if not text_objs:
        return []

    enriched = []
    target_idx = None
    for o in text_objs:
        p = geometry_reader.get_text_object_props(pdf_path, page_index, o.drawIndex)
        m = o.matrix or [1.0, 0.0, 0.0, 1.0, o.bbox[0], o.bbox[1]]
        a, b, c, d, e, f = m
        pt_h_char = max(1.0, o.bbox[3] - o.bbox[1])
        actual_fs = _calculate_actual_font_size(p.get("fontSize"), m, pt_h_char)
        scale = actual_fs if actual_fs > 2.0 else math.hypot(a, b)
        angle = math.degrees(math.atan2(b, a))
        content = p.get("content") or o.content or ""
        font_name = p.get("fontName") or o.fontName or ""
        color = p.get("color") or o.color or [0, 0, 0]
        item = {
            "obj": o,
            "props": p,
            "content": content,
            "fontName": font_name,
            "color": color,
            "scale": scale,
            "angle": angle,
            "e": e,
            "f": f,
            "drawIndex": o.drawIndex,
            "bbox": o.bbox,
        }
        if o.drawIndex == target_obj.drawIndex:
            target_idx = len(enriched)
        enriched.append(item)

    if target_idx is None:
        return []

    target_item = enriched[target_idx]

    # Tìm lùi về trước (backward)
    left_items = []
    curr = target_item
    for j in range(target_idx - 1, -1, -1):
        prev = enriched[j]
        if prev["fontName"] != curr["fontName"] or abs(prev["scale"] - curr["scale"]) > curr["scale"] * 0.18:
            break
        dist = math.hypot(curr["e"] - prev["e"], curr["f"] - prev["f"])
        if dist > curr["scale"] * 2.5:
            break
        if curr["drawIndex"] - prev["drawIndex"] > 2:
            break
        left_items.insert(0, prev)
        curr = prev

    # Tìm tiến về sau (forward)
    right_items = []
    curr = target_item
    for j in range(target_idx + 1, len(enriched)):
        nxt = enriched[j]
        if nxt["fontName"] != curr["fontName"] or abs(nxt["scale"] - curr["scale"]) > curr["scale"] * 0.18:
            break
        dist = math.hypot(nxt["e"] - curr["e"], nxt["f"] - curr["f"])
        if dist > curr["scale"] * 2.5:
            break
        if nxt["drawIndex"] - curr["drawIndex"] > 2:
            break
        right_items.append(nxt)
        curr = nxt

    full_group = left_items + [target_item] + right_items
    return full_group


def pick_text_to_vdp_field(
    pdf_path: str,
    page_index: int,
    draw_index: int,
    remove_original: bool = True,
    output_path: Optional[str] = None,
    member_draw_indices: Optional[List[int]] = None,
) -> Dict[str, Any]:
    """
    Trích xuất một text object tại (page_index, draw_index) thành trường VDP.
    Nếu remove_original=True, xóa object đó khỏi PDF và lưu vào output_path.
    """
    if not os.path.isfile(pdf_path):
        raise FileNotFoundError(f"File PDF không tồn tại: {pdf_path}")

    # 1. Liệt kê object của trang
    all_objects = geometry_reader.list_objects(pdf_path, page_index, include_text_props=True)
    target_obj: Optional[ObjMeta] = None
    for obj in all_objects:
        if obj.type == "text" and obj.drawIndex == draw_index:
            target_obj = obj
            break

    if not target_obj:
        # Thử tìm theo drawIndex chung
        for obj in all_objects:
            if obj.drawIndex == draw_index:
                target_obj = obj
                break

    if not target_obj:
        raise ValueError(f"Không tìm thấy Text Object tại trang {page_index}, drawIndex {draw_index}")

    # Thu thập toàn bộ các objects thuộc cụm (nếu có member_draw_indices từ frontend)
    member_indices_set = set(member_draw_indices or [])
    member_indices_set.add(draw_index)
    cluster_objects = [o for o in all_objects if o.drawIndex in member_indices_set]
    cluster_text_objs = [o for o in cluster_objects if o.type == "text"]
    if not cluster_text_objs:
        cluster_text_objs = [target_obj]

    # 2. Lấy thuộc tính chi tiết & ghép nối nội dung đầy đủ
    text_props = geometry_reader.get_text_object_props(pdf_path, page_index, draw_index)
    clockwise_rot = _detect_clockwise_rotation(target_obj.matrix)

    if len(cluster_text_objs) > 1:
        # Ghép nội dung theo dòng/cột tuỳ theo góc xoay (rotation-aware):
        ref_fs = _calculate_actual_font_size(text_props.get("fontSize"), target_obj.matrix, max(1.0, target_obj.bbox[3] - target_obj.bbox[1]))
        fs_val = ref_fs or 12.0

        if clockwise_rot in (90, 270):
            # Text xoay dọc: nhóm các object có cùng toạ độ X thành từng cột (tolerance ~ 0.4 * fontSize)
            x_tol = max(3.0, fs_val * 0.4)
            objs_by_x = sorted(cluster_text_objs, key=lambda o: o.bbox[0])
            cols: list[list[ObjMeta]] = []
            for o in objs_by_x:
                placed = False
                for col in cols:
                    rep = col[0]
                    if abs(o.bbox[0] - rep.bbox[0]) <= x_tol or abs(o.bbox[2] - rep.bbox[2]) <= x_tol:
                        col.append(o)
                        placed = True
                        break
                if not placed:
                    cols.append([o])

            col_texts = []
            for col in cols:
                # 90° (đọc từ trên xuống): giảm dần theo Y (-o.bbox[3])
                # 270° (đọc từ dưới lên): tăng dần theo Y (o.bbox[1])
                sorted_col = sorted(col, key=lambda o: -o.bbox[3] if clockwise_rot == 90 else o.bbox[1])
                col_str = ""
                for k, o in enumerate(sorted_col):
                    oprops = geometry_reader.get_text_object_props(pdf_path, page_index, o.drawIndex)
                    c_text = oprops.get("content") or o.content or ""
                    if not c_text:
                        continue
                    if k > 0:
                        prev_o = sorted_col[k - 1]
                        gap = (prev_o.bbox[1] - o.bbox[3]) if clockwise_rot == 90 else (o.bbox[1] - prev_o.bbox[3])
                        if gap > fs_val * 0.15 and not col_str.endswith(" ") and not c_text.startswith(" "):
                            col_str += " "
                    col_str += c_text
                if col_str.strip():
                    col_texts.append(col_str.strip())
            raw_content = "\n".join(col_texts)
        else:
            # Text ngang chuẩn: nhóm các object có cùng toạ độ Y thành từng dòng (tolerance ~ 0.4 * fontSize)
            y_tol = max(3.0, fs_val * 0.4)
            objs_by_y = sorted(cluster_text_objs, key=lambda o: -o.bbox[3])
            lines: list[list[ObjMeta]] = []
            for o in objs_by_y:
                placed = False
                for line in lines:
                    rep = line[0]
                    if abs(o.bbox[3] - rep.bbox[3]) <= y_tol or abs(o.bbox[1] - rep.bbox[1]) <= y_tol:
                        line.append(o)
                        placed = True
                        break
                if not placed:
                    lines.append([o])

            line_texts = []
            for line in lines:
                # 180°: từ phải sang trái (-o.bbox[2]); 0°: từ trái sang phải (o.bbox[0])
                sorted_line = sorted(line, key=lambda o: -o.bbox[2] if clockwise_rot == 180 else o.bbox[0])
                line_str = ""
                for k, o in enumerate(sorted_line):
                    oprops = geometry_reader.get_text_object_props(pdf_path, page_index, o.drawIndex)
                    c_text = oprops.get("content") or o.content or ""
                    if not c_text:
                        continue
                    if k > 0:
                        prev_o = sorted_line[k - 1]
                        gap = (prev_o.bbox[0] - o.bbox[2]) if clockwise_rot == 180 else (o.bbox[0] - prev_o.bbox[2])
                        if gap > fs_val * 0.15 and not line_str.endswith(" ") and not c_text.startswith(" "):
                            line_str += " "
                    line_str += c_text
                if line_str.strip():
                    line_texts.append(line_str.strip())
            raw_content = "\n".join(line_texts)
    else:
        raw_content = text_props.get("content") or target_obj.content or ""
    content = repair_vietnamese_pdf_text(raw_content)

    # Đọc stroke properties (viền chữ)
    stroke_color = text_props.get("strokeColor") or getattr(target_obj, "strokeColor", None)
    stroke_width = text_props.get("strokeWidth") or getattr(target_obj, "strokeWidth", None)
    stroke_line_join = text_props.get("strokeLineJoin") or getattr(target_obj, "strokeLineJoin", None) or "round"
    stroke_line_cap = text_props.get("strokeLineCap") or getattr(target_obj, "strokeLineCap", None) or "round"
    if not stroke_color or not stroke_width:
        for o in cluster_text_objs:
            oprops = geometry_reader.get_text_object_props(pdf_path, page_index, o.drawIndex)
            sc = oprops.get("strokeColor")
            sw = oprops.get("strokeWidth")
            if sc and sw:
                stroke_color = sc
                stroke_width = sw
                stroke_line_join = oprops.get("strokeLineJoin") or stroke_line_join
                stroke_line_cap = oprops.get("strokeLineCap") or stroke_line_cap
                break

    stroke_color_hex = None
    stroke_width_val = None
    if stroke_color and stroke_width and float(stroke_width) > 0.05:
        if isinstance(stroke_color, (list, tuple)) and len(stroke_color) >= 3:
            stroke_color_hex = f"#{int(stroke_color[0]):02X}{int(stroke_color[1]):02X}{int(stroke_color[2]):02X}"
        stroke_width_val = round(float(stroke_width), 2)
    raw_font_name = text_props.get("fontName") or target_obj.fontName or "Helvetica"
    clean_font_name = re.sub(r"^[A-Z]{6}\+", "", raw_font_name)
    font_name = clean_font_name
    font_size = text_props.get("fontSize")
    font_style = text_props.get("fontStyle") or getattr(target_obj, "fontStyle", None)
    font_weight = text_props.get("fontWeight") or getattr(target_obj, "fontWeight", None)
    if not font_style or not font_weight:
        fn_lower = (raw_font_name or "").lower()
        if not font_style:
            if "italic" in fn_lower or "oblique" in fn_lower:
                font_style = "bolditalic" if any(k in fn_lower for k in ("bold", "black", "heavy", "900", "800", "700")) else "italic"
            elif any(k in fn_lower for k in ("bold", "black", "heavy", "semibold", "demibold", "extrabold", "900", "800", "700", "600")):
                font_style = "bold"
            else:
                font_style = "regular"
        if not font_weight:
            if any(k in fn_lower for k in ("black", "heavy", "900")):
                font_weight = 900
            elif any(k in fn_lower for k in ("extrabold", "800")):
                font_weight = 800
            elif any(k in fn_lower for k in ("bold", "700")):
                font_weight = 700
            elif any(k in fn_lower for k in ("semibold", "demibold", "600")):
                font_weight = 600
            elif any(k in fn_lower for k in ("medium", "500")):
                font_weight = 500
            elif any(k in fn_lower for k in ("light", "300")):
                font_weight = 300
            else:
                font_weight = 400
    color_rgb = text_props.get("color") or target_obj.color or [0, 0, 0]
    # Chuẩn hóa màu đen in ấn: CMYK (0,0,0,1) qua PDFium map thành [35,31,32] (#231F20).
    # Chữ đen trên thiết kế phải là #000000 tuyệt đối.
    if color_rgb and max(color_rgb) <= 40:
        font_color_hex = "#000000"
    else:
        font_color_hex = f"#{color_rgb[0]:02X}{color_rgb[1]:02X}{color_rgb[2]:02X}" 

    # 3. Đọc CropBox để quy đổi tọa độ point -> mm (gốc trên-trái)
    with pikepdf.open(pdf_path) as source_pdf:
        if page_index < 0 or page_index >= len(source_pdf.pages):
            raise IndexError(f"Trang {page_index} ngoài phạm vi tài liệu")
        page = source_pdf.pages[page_index]
        cx0, cy0, cx1, cy1 = _get_page_cropbox(page)

    # BBox trong PDFium là [x0, y0, x1, y1] theo point (gốc bottom-left).
    # Hợp nhất bounding box cho toàn bộ các ký tự trong cụm text:
    bx0 = min(o.bbox[0] for o in cluster_text_objs)
    by0 = min(o.bbox[1] for o in cluster_text_objs)
    bx1 = max(o.bbox[2] for o in cluster_text_objs)
    by1 = max(o.bbox[3] for o in cluster_text_objs)
    pt_w = max(5.0, bx1 - bx0)
    pt_h_tight = max(1.0, by1 - by0)
    pt_left = bx0 - cx0

    # Tính cỡ chữ chuẩn xác (kết hợp Tf và Text Matrix scale của Illustrator/Corel)
    font_size = _calculate_actual_font_size(font_size, target_obj.matrix, pt_h_tight)
    effective_fs = font_size or 12.0

    # Tìm baseline_y chính xác từ matrix của toàn bộ các text objects trong cụm:
    candidate_f_vals = []
    for o in cluster_text_objs:
        m = o.matrix
        if m and len(m) >= 6:
            f_cand = m[5]
            if (by0 - 5.0) <= f_cand <= (by1 + 5.0):
                candidate_f_vals.append(f_cand)
    if candidate_f_vals:
        import statistics
        baseline_y = float(statistics.median(candidate_f_vals))
    else:
        # Fallback nhận diện đầy đủ các ký tự kéo xuống dưới baseline (descenders và dấu nặng tiếng Việt)
        DESCENDER_CHARS = "gjyqpQç@ạặậẹệịọộợụựỵ,;()[]_{}§"
        has_descender = any(c in DESCENDER_CHARS for c in content)
        baseline_y = by0 + (effective_fs * 0.22 if has_descender else 0.0)

    # Đọc font file từ hệ thống hoặc trích xuất nhúng từ PDF
    # Ưu tiên 1: Tra cứu font cài đặt trên hệ thống thật (Windows Registry / C:\Windows\Fonts)
    installed_font = (
        _find_font_in_windows_registry(clean_font_name)
        or _find_font_in_windows_registry(raw_font_name)
    )
    if not installed_font:
        clean_target_stem = clean_font_name.lower().replace("-", "").replace("_", "").replace(" ", "")
        for bdir in (r"C:\Windows\Fonts", os.path.expanduser(r"~\AppData\Local\Microsoft\Windows\Fonts"), r"C:\Program Files\Common Files\Adobe\Fonts"):
            if not os.path.isdir(bdir):
                continue
            for f in os.listdir(bdir):
                stem, ext = os.path.splitext(f)
                if ext.lower() in VALID_FONT_EXTENSIONS:
                    if stem.lower().replace("-", "").replace("_", "").replace(" ", "") == clean_target_stem:
                        installed_font = os.path.join(bdir, f)
                        break
            if installed_font:
                break

    # Ưu tiên 2: Trích xuất font nhúng trực tiếp từ file PDF (chuẩn xác 100% từ Illustrator/Corel)
    # Ưu tiên 3: Fallback qua resolve_font_file (Google Fonts)
    font_file_path = (
        installed_font
        or _extract_embedded_font_from_pdf(pdf_path, page_index, raw_font_name, content=content)
        or _extract_embedded_font_from_pdf(pdf_path, page_index, clean_font_name, content=content)
        or _resolve_font_file(clean_font_name)
        or _resolve_font_file(raw_font_name)
    )

    if clockwise_rot in (90, 270):
        # [VDP ROTATED TEXT] Text xoay dọc (90° hoặc 270° theo chiều kim đồng hồ):
        # Trục X trong PDF là bề ngang / độ dày của glyphs (font height/thickness).
        # Trục Y trong PDF là chiều dài của dòng chữ (line length).
        glyph_thickness = max(effective_fs * 1.15, bx1 - bx0)
        pt_w = glyph_thickness
        pt_left = max(0.0, (bx0 + bx1) / 2.0 - pt_w / 2.0 - cx0)
        pt_h = max(5.0, by1 - by0)
        pt_top = cy1 - by1
        det_align = "left"
    else:
        det_align = _detect_text_alignment(bx0, bx1, (cx0, cy0, cx1, cy1), all_objects, target_obj)
        DESCENDER_CHARS = "gjyqpQç@ạặậẹệịọộợụựỵ,;()[]_{}§"
        has_descender = any(c in DESCENDER_CHARS for c in content)
        has_ascender_or_accent = any(
            c in "AĂÂBCDĐEÊGHIKLMNOÔƠPQRSTUƯVXY1234567890?/~`!@#$%^&*()_+"
            for c in content.upper()
        )
        # [VDP BASELINE PARITY] Neo khung quanh baseline_y theo đúng công thức của ReportLab:
        need_top = max(by1, baseline_y + (effective_fs * 0.95 if has_ascender_or_accent else effective_fs * 0.75))
        need_bottom = min(by0, baseline_y - effective_fs * 0.28) if has_descender else (baseline_y - 0.05 * effective_fs)

        target_h = max(
            effective_fs * 1.25,
            2.0 * (need_top - baseline_y) - effective_fs,
            2.0 * (baseline_y - need_bottom) + effective_fs,
        )
        bottom_pdf = baseline_y - (target_h - effective_fs) / 2.0
        top_pdf = baseline_y + (target_h + effective_fs) / 2.0

        pt_h = target_h
        pt_top = cy1 - top_pdf
        pt_w = max(5.0, bx1 - bx0)
        if det_align == "left":
            # Khi căn trái: nếu tìm được text insertion origin e từ matrix của ký tự đầu tiên
            # thì neo pt_left theo e để vị trí xuất phát của con chữ đầu tiên trùng khít 100%
            sorted_objs = sorted(cluster_text_objs, key=lambda o: o.bbox[0])
            first_m = sorted_objs[0].matrix if sorted_objs else None
            e_val = first_m[4] if first_m and len(first_m) >= 6 else None
            if e_val is not None and (bx0 - 3.0) <= e_val <= (bx0 + 1.0):
                pt_left = max(0.0, e_val - cx0)
            else:
                pt_left = max(0.0, bx0 - cx0)
        else:
            pt_left = max(0.0, bx0 - cx0)

    # Đổi pt sang đơn vị mm của VDP PrynX:
    # Khung VDP dùng CSS-mm (pt * 96/72 * 25.4/72 = pt * 25.4 / 54.0) để bảo đảm
    # parity tuyệt đối giữa overlay frontend và ReportLab backend.
    pt_to_vdp_mm = (96.0 / 72.0) * (25.4 / 72.0)
    x_mm = round(max(0.0, pt_left * pt_to_vdp_mm), 2)
    y_mm = round(max(0.0, pt_top * pt_to_vdp_mm), 2)
    w_mm = round(max(3.0, pt_w * pt_to_vdp_mm), 2)
    h_mm = round(max(3.0, pt_h * pt_to_vdp_mm), 2)

    # Kiểm tra xem đối tượng có thuộc chuỗi chữ uốn cong (Curved Text) hay không
    curved_group = _detect_curved_text_group(target_obj, all_objects, pdf_path, page_index)
    is_curved = False
    curve_mode = "none"
    curve_radius_mm = 0.0

    if len(curved_group) >= 2:
        angles = [g["angle"] for g in curved_group]
        angle_span = max(angles) - min(angles)
        # Chỉ coi là uốn cong khi góc xoay giữa các ký tự có sự thay đổi rõ rệt (>= 8°),
        # tránh phân loại nhầm text thẳng đứng/ngang của Illustrator thành curved text.
        is_curved = angle_span >= 8.0 and (len(curved_group) >= 3 or angle_span >= 15.0)

    if is_curved and len(curved_group) >= 2:
        # 1. Ghép chuỗi chữ hoàn chỉnh với phát hiện dấu cách tự động
        dists = [math.hypot(curved_group[k+1]["e"] - curved_group[k]["e"], curved_group[k+1]["f"] - curved_group[k]["f"]) for k in range(len(curved_group) - 1)]
        import numpy as np
        median_dist = float(np.median(dists)) if dists else 20.0
        space_thresh = median_dist * 1.45

        text_parts = []
        for k, g in enumerate(curved_group):
            c = g["content"]
            text_parts.append(c)
            if k < len(curved_group) - 1:
                if dists[k] > space_thresh and not c.endswith(" "):
                    text_parts.append(" ")
        content = repair_vietnamese_pdf_text("".join(text_parts).strip())

        # 2. Khớp đường tròn (Circle Fit) để tính bán kính cong R và hướng cong
        xs = [g["e"] for g in curved_group]
        ys = [g["f"] for g in curved_group]
        A = []
        B = []
        for x, y in zip(xs, ys):
            A.append([2*x, 2*y, 1])
            B.append(x**2 + y**2)
        res_fit, _, _, _ = np.linalg.lstsq(A, B, rcond=None)
        cx_fit, cy_fit, c_const = res_fit
        R = math.sqrt(max(1.0, c_const + cx_fit**2 + cy_fit**2))
        mean_y = float(np.mean(ys))
        curve_mode = "arc_top" if cy_fit < mean_y else "arc_bottom"
        curve_radius_mm = round(R * 25.4 / 72.0, 1)

        # Tính font_size chuẩn xác từ trung bình cỡ chữ thực tế của từng ký tự
        char_font_sizes = []
        for g in curved_group:
            raw_fs = g["props"].get("fontSize")
            m = g["obj"].matrix
            pt_h_char = max(1.0, g["bbox"][3] - g["bbox"][1])
            fs = _calculate_actual_font_size(raw_fs, m, pt_h_char)
            if fs > 2.0:
                char_font_sizes.append(fs)
        if char_font_sizes:
            avg_fs = sum(char_font_sizes) / len(char_font_sizes)
            if abs(avg_fs - round(avg_fs)) <= 0.35:
                font_size = float(round(avg_fs))
            else:
                font_size = round(avg_fs, 1)


        # 3. Hộp bao hợp nhất (Union Bounding Box) cho toàn bộ chuỗi chữ cong
        bx0 = min(g["bbox"][0] for g in curved_group)
        by0 = min(g["bbox"][1] for g in curved_group)
        bx1 = max(g["bbox"][2] for g in curved_group)
        by1 = max(g["bbox"][3] for g in curved_group)
        pt_w = max(10.0, bx1 - bx0)
        pt_h = max(10.0, by1 - by0)
        pt_left = bx0 - cx0
        pt_top = cy1 - by1

        pt_to_vdp_mm = (96.0 / 72.0) * (25.4 / 72.0)
        x_mm = round(max(0.0, pt_left * pt_to_vdp_mm), 2)
        y_mm = round(max(0.0, pt_top * pt_to_vdp_mm), 2)
        w_mm = round(max(5.0, pt_w * pt_to_vdp_mm), 2)
        h_mm = round(max(3.0, pt_h * pt_to_vdp_mm), 2)

    field_name = _sanitize_field_name(content, fallback_idx=draw_index + 1)
    field_id = f"vdp_pick_{uuid.uuid4().hex[:8]}"

    # [SHADOW & 3D & OUTLINE EFFECT DETECTION]
    # Quét các object hiệu ứng (shadow text, vector outline paths, bevels/extrusions) xung quanh cụm chữ để:
    # 1. Trích xuất shadowColor / offset nếu có
    # 2. Trích xuất strokeColor / strokeWidth / strokeLineJoin nếu text object chưa có viền
    # 3. Xóa sạch khỏi PDF mẫu khi remove_original=True (không để viền trắng/hiệu ứng nằm lại tách lớp)
    shadow_color_hex = None
    shadow_ox = None
    shadow_oy = None

    to_delete_objects = list(cluster_objects)
    delete_indices_set = set(member_indices_set)

    eff_margin = max(10.0, effective_fs * 0.8)
    min_di = min(o.drawIndex for o in cluster_text_objs)
    max_di = max(o.drawIndex for o in cluster_text_objs)

    for o in all_objects:
        if o.drawIndex in delete_indices_set:
            continue
        ob = o.bbox
        if (ob[0] >= bx0 - eff_margin and ob[2] <= bx1 + eff_margin and
            ob[1] >= by0 - eff_margin and ob[3] <= by1 + eff_margin):
            if min_di - 40 <= o.drawIndex <= max_di + 40:
                if getattr(o, "type", None) == "text":
                    o_props = geometry_reader.get_text_object_props(pdf_path, page_index, o.drawIndex)
                    o_content = o_props.get("content") or o.content or ""
                    if not content and o_content:
                        content = repair_vietnamese_pdf_text(o_content)
                        field_name = _sanitize_field_name(content, fallback_idx=draw_index + 1)
                    is_matching = bool(o_content and (not content or o_content in content or content in o_content or abs(len(o_content) - len(content)) <= 2))
                    if is_matching:
                        o_color = o_props.get("color") or o.color
                        if o_color and not shadow_color_hex:
                            shadow_color_hex = f"#{int(o_color[0]):02X}{int(o_color[1]):02X}{int(o_color[2]):02X}"
                            shadow_ox = round((o.bbox[0] - bx0) * pt_to_vdp_mm, 2)
                            shadow_oy = round((by1 - o.bbox[3]) * pt_to_vdp_mm, 2)
                        if not stroke_color_hex and o_props.get("strokeColor") and o_props.get("strokeWidth"):
                            sc = o_props["strokeColor"]
                            stroke_color_hex = f"#{int(sc[0]):02X}{int(sc[1]):02X}{int(sc[2]):02X}"
                            stroke_width_val = round(float(o_props["strokeWidth"]), 2)
                            stroke_line_join = o_props.get("strokeLineJoin") or stroke_line_join
                            stroke_line_cap = o_props.get("strokeLineCap") or stroke_line_cap
                        to_delete_objects.append(o)
                        delete_indices_set.add(o.drawIndex)
                elif getattr(o, "type", None) == "vector":
                    # Vector outline path hoặc extrusion/shadow thuộc cụm chữ
                    if not stroke_color_hex and getattr(o, "strokeColor", None) and getattr(o, "strokeWidth", None):
                        sc = o.strokeColor
                        stroke_color_hex = f"#{int(sc[0]):02X}{int(sc[1]):02X}{int(sc[2]):02X}"
                        stroke_width_val = round(float(o.strokeWidth), 2)
                        stroke_line_join = getattr(o, "strokeLineJoin", None) or stroke_line_join
                        stroke_line_cap = getattr(o, "strokeLineCap", None) or stroke_line_cap
                    to_delete_objects.append(o)
                    delete_indices_set.add(o.drawIndex)

    font_data_url = None
    if font_file_path and os.path.isfile(font_file_path):
        try:
            fsize = os.path.getsize(font_file_path)
            if fsize <= 4 * 1024 * 1024:
                import base64
                with open(font_file_path, "rb") as f_font:
                    font_bytes = f_font.read()
                b64 = base64.b64encode(font_bytes).decode("ascii")
                mime = "font/otf" if font_file_path.lower().endswith(".otf") else "font/ttf"
                font_data_url = f"data:{mime};base64,{b64}"
        except Exception as e_b64:
            logger.debug("Không thể tạo font_data_url: %s", e_b64)

    vdp_field = {
        "id": field_id,
        "name": field_name,
        "type": "text",
        "textContent": content,
        "pageNum": page_index + 1,
        "x": x_mm,
        "y": y_mm,
        "width": w_mm,
        "height": h_mm,
        "fontSize": font_size,
        "fontColor": font_color_hex,
        "fontName": clean_font_name,
        "fontFile": font_file_path,
        "fontDataUrl": font_data_url,
        "fontStyle": font_style,
        "fontWeight": font_weight,
        "alignment": det_align,
        "rotation": clockwise_rot,
        "autoFit": True,
        **({
            "strokeColor": stroke_color_hex,
            "strokeWidth": stroke_width_val,
            "strokeLineJoin": stroke_line_join or "round",
            "strokeLineCap": stroke_line_cap or "round",
        } if stroke_color_hex and stroke_width_val else {}),
        **({
            "shadowColor": shadow_color_hex,
            "shadowOffsetX": shadow_ox or 1.0,
            "shadowOffsetY": shadow_oy or 1.0,
            "shadowBlur": 0.0,
        } if shadow_color_hex else {}),
        **({
            "curveMode": curve_mode,
            "curveRadius": curve_radius_mm,
            "curveOrientation": "outward",
        } if is_curved else {}),
    }

    cleaned_path: Optional[str] = None
    removed_draw_indices = list(delete_indices_set)
    if remove_original and output_path:
        out_dir = os.path.dirname(os.path.abspath(output_path))
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
        with pikepdf.open(pdf_path) as pdf:
            target_page = pdf.pages[page_index]
            if is_curved and len(curved_group) >= 2:
                stream_editor.contents_coalesce(pdf, target_page)
                instructions = stream_editor.parse_page_ops(target_page)
                first_m = curved_group[0]["obj"].matrix
                last_m = curved_group[-1]["obj"].matrix
                first_op_idx = None
                last_op_idx = None
                for i, instr in enumerate(instructions):
                    op = stream_editor._instr_op_name(instr)
                    if op == 'Tm' and len(instr.operands) >= 6:
                        vals = [float(v) for v in instr.operands]
                        if first_op_idx is None and all(abs(v - m) < 0.1 for v, m in zip(vals, first_m)):
                            first_op_idx = i
                            if i > 0 and stream_editor._instr_op_name(instructions[i-1]) == 'Tf':
                                first_op_idx = i - 1
                        if all(abs(v - m) < 0.1 for v, m in zip(vals, last_m)):
                            for k in range(i + 1, min(len(instructions), i + 4)):
                                if stream_editor._instr_op_name(instructions[k]) in ('Tj', 'TJ'):
                                    last_op_idx = k
                                    break
                if first_op_idx is not None and last_op_idx is not None:
                    new_instructions = [instr for i, instr in enumerate(instructions) if i < first_op_idx or i > last_op_idx]
                    target_page.Contents = pdf.make_stream(pikepdf.unparse_content_stream(new_instructions))
                    removed_draw_indices = [g["obj"].drawIndex for g in curved_group]
                else:
                    delete_result = stream_editor.delete_objects(
                        target_page,
                        [g["obj"] for g in curved_group],
                        pdf,
                        all_obj_metas=all_objects,
                    )
                    if not getattr(delete_result, "changed", True):
                        raise ValueError("Không xoá được chữ cong khỏi phôi.")
                    removed_draw_indices = [g["obj"].drawIndex for g in curved_group]

                # Nhánh chữ cong cũng phải hoàn tất cùng hợp đồng với nhánh chữ
                # thường: dọn operator/font chết rồi ghi ra template sạch. Trước
                # đây fallback delete_objects chỉ sửa PDF trong bộ nhớ, nhưng
                # không save nên API trả field thành công trong khi nền vẫn còn
                # chữ cũ (field mới bị đắp chồng và trông như nhân bản).
                from app.workers.vdp_engine import _clean_template_dead_text_ops_and_fonts
                _clean_template_dead_text_ops_and_fonts(target_page, pdf)
                pdf.save(output_path)
                cleaned_path = output_path
            else:
                # Tiền kiểm tra ánh xạ an toàn: chỉ xóa các object map được duy nhất,
                # tránh ObjectMapError làm dừng cả quá trình tạo trường VDP.
                verified_delete_objs = []
                for o in to_delete_objects:
                    if getattr(o, "type", None) == "text":
                        verified_delete_objs.append(o)
                    else:
                        try:
                            spans = stream_editor.map_object_spans(target_page, o, pdf=pdf)
                            if spans:
                                verified_delete_objs.append(o)
                            else:
                                logger.debug("Bỏ qua vector object không map được duy nhất: %s", o.id)
                        except Exception:
                            pass

                try:
                    delete_result = stream_editor.delete_objects(
                        target_page,
                        verified_delete_objs,
                        pdf,
                        all_obj_metas=all_objects,
                    )
                    if not getattr(delete_result, "changed", True):
                        raise ValueError("Không xoá được placeholder khỏi phôi.")
                    removed_draw_indices = [o.drawIndex for o in verified_delete_objs]
                    # [VDP-TYPE0-LIVE-TEXT] Dọn dẹp dead Tf và ghost fonts trong template sạch
                    from app.workers.vdp_engine import _clean_template_dead_text_ops_and_fonts
                    _clean_template_dead_text_ops_and_fonts(target_page, pdf)
                    pdf.save(output_path)
                    cleaned_path = output_path
                except Exception as exc:
                    logger.warning("Không thể xóa text khỏi PDF phôi: %s. Giữ phôi gốc an toàn.", exc)
                    cleaned_path = None
                    removed_draw_indices = [target_obj.drawIndex]
        if cleaned_path is None and output_path and os.path.isfile(output_path):
            try:
                os.remove(output_path)
            except OSError:
                pass

        # Không được coi là thành công nếu remove_original đã yêu cầu template
        # sạch nhưng thao tác xoá/ghi file thất bại. Frontend chỉ được thêm field
        # sau khi có working template mới; nếu không sẽ tạo đúng lỗi nhân bản.
        if cleaned_path is None:
            raise ValueError("Không tạo được template VDP đã làm sạch.")

    return {
        "success": True,
        "field": vdp_field,
        "cleanedPdfPath": cleaned_path,
        "removedDrawIndex": target_obj.drawIndex,
        "removedDrawIndices": removed_draw_indices,
    }


def auto_detect_vdp_tags(
    pdf_path: str,
    page_index: int,
    remove_original: bool = True,
    output_path: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Quét tự động toàn bộ text objects trên trang có chứa tag {{...}}, [[...]], <<...>>.
    Tạo danh sách VdpToolField và tùy chọn xóa text gốc khỏi PDF template.
    """
    if not os.path.isfile(pdf_path):
        raise FileNotFoundError(f"File PDF không tồn tại: {pdf_path}")

    all_objects = geometry_reader.list_objects(pdf_path, page_index, include_text_props=True)
    with pikepdf.open(pdf_path) as source_pdf:
        if page_index < 0 or page_index >= len(source_pdf.pages):
            raise IndexError(f"Trang {page_index} ngoài phạm vi tài liệu")
        page = source_pdf.pages[page_index]
        cx0, cy0, cx1, cy1 = _get_page_cropbox(page)

    pt_to_mm = 25.4 / 72.0
    tag_objects: List[ObjMeta] = []
    fields: List[Dict[str, Any]] = []

    for obj in all_objects:
        if obj.type != "text":
            continue
        props = geometry_reader.get_text_object_props(pdf_path, page_index, obj.drawIndex)
        raw_content = props.get("content") or obj.content or ""
        content = repair_vietnamese_pdf_text(raw_content)
        if not TAG_PATTERN.search(content):
            continue

        tag_objects.append(obj)
        raw_font_name = props.get("fontName") or obj.fontName or "Helvetica"
        clean_font_name = re.sub(r"^[A-Z]{6}\+", "", raw_font_name)
        font_file_path = (
            _resolve_font_file(clean_font_name)
            or _resolve_font_file(raw_font_name)
            or _extract_embedded_font_from_pdf(pdf_path, page_index, raw_font_name)
        )
        font_name = clean_font_name
        font_size = props.get("fontSize")
        font_style = props.get("fontStyle") or getattr(obj, "fontStyle", None)
        font_weight = props.get("fontWeight") or getattr(obj, "fontWeight", None)
        if not font_style or not font_weight:
            fn_lower = (raw_font_name or "").lower()
            if not font_style:
                if "italic" in fn_lower or "oblique" in fn_lower:
                    font_style = "bolditalic" if any(k in fn_lower for k in ("bold", "black", "heavy", "900", "800", "700")) else "italic"
                elif any(k in fn_lower for k in ("bold", "black", "heavy", "semibold", "demibold", "extrabold", "900", "800", "700", "600")):
                    font_style = "bold"
                else:
                    font_style = "regular"
            if not font_weight:
                if any(k in fn_lower for k in ("black", "heavy", "900")):
                    font_weight = 900
                elif any(k in fn_lower for k in ("extrabold", "800")):
                    font_weight = 800
                elif any(k in fn_lower for k in ("bold", "700")):
                    font_weight = 700
                elif any(k in fn_lower for k in ("semibold", "demibold", "600")):
                    font_weight = 600
                elif any(k in fn_lower for k in ("medium", "500")):
                    font_weight = 500
                elif any(k in fn_lower for k in ("light", "300")):
                    font_weight = 300
                else:
                    font_weight = 400
        color_rgb = props.get("color") or obj.color or [0, 0, 0]
        # Chuẩn hóa màu đen in ấn: CMYK (0,0,0,1) qua PDFium map thành [35,31,32] (#231F20).
        # Chữ đen trên thiết kế phải là #000000 tuyệt đối.
        if color_rgb and max(color_rgb) <= 40:
            font_color_hex = "#000000"
        else:
            font_color_hex = f"#{color_rgb[0]:02X}{color_rgb[1]:02X}{color_rgb[2]:02X}" 

        bx0, by0, bx1, by1 = obj.bbox
        pt_w = max(1.0, bx1 - bx0)
        pt_h = max(1.0, by1 - by0)
        pt_left = bx0 - cx0
        pt_top = cy1 - by1

        if not font_size or font_size <= 0:
            font_size = round(pt_h * 0.85, 1)

        effective_fs = font_size or 12.0
        matrix = obj.matrix
        clockwise_rot = _detect_clockwise_rotation(matrix)

        if clockwise_rot in (90, 270):
            glyph_thickness = max(effective_fs * 1.15, bx1 - bx0)
            pt_w = glyph_thickness
            pt_left = max(0.0, (bx0 + bx1) / 2.0 - pt_w / 2.0 - cx0)
            pt_h = max(5.0, by1 - by0)
            pt_top = cy1 - by1
            det_align = "left"
        else:
            det_align = _detect_text_alignment(bx0, bx1, (cx0, cy0, cx1, cy1), all_objects, obj)
            DESCENDER_CHARS = "gjyqpQç@ạặậẹệịọộợụựỵ,;()[]_{}§"
            has_descender = any(c in DESCENDER_CHARS for c in content)
            f_val = matrix[5] if matrix and len(matrix) >= 6 else None
            if f_val is not None and (by0 - 5.0) <= f_val <= (by1 + 5.0):
                baseline_y = f_val
            else:
                baseline_y = by0 + (effective_fs * 0.22 if has_descender else 0.0)

            has_ascender_or_accent = any(
                c in "AĂÂBCDĐEÊGHIKLMNOÔƠPQRSTUƯVXY1234567890?/~`!@#$%^&*()_+"
                for c in content.upper()
            )
            # [VDP BASELINE PARITY] Neo khung quanh baseline_y theo đúng công thức của ReportLab:
            need_top = max(by1, baseline_y + (effective_fs * 0.95 if has_ascender_or_accent else effective_fs * 0.75))
            need_bottom = min(by0, baseline_y - effective_fs * 0.28) if has_descender else (baseline_y - 0.05 * effective_fs)

            target_h = max(
                effective_fs * 1.25,
                2.0 * (need_top - baseline_y) - effective_fs,
                2.0 * (baseline_y - need_bottom) + effective_fs,
            )
            bottom_pdf = baseline_y - (target_h - effective_fs) / 2.0
            top_pdf = baseline_y + (target_h + effective_fs) / 2.0

            pt_h = target_h
            pt_top = cy1 - top_pdf
            pt_w = max(5.0, bx1 - bx0)
            if det_align == "left":
                e_val = matrix[4] if matrix and len(matrix) >= 6 else None
                if e_val is not None and (bx0 - 3.0) <= e_val <= (bx0 + 1.0):
                    pt_left = max(0.0, e_val - cx0)
                else:
                    pt_left = max(0.0, bx0 - cx0)
            else:
                pt_left = max(0.0, bx0 - cx0)

        pt_to_vdp_mm = (96.0 / 72.0) * (25.4 / 72.0)
        x_mm = round(max(0.0, pt_left * pt_to_vdp_mm), 2)
        y_mm = round(max(0.0, pt_top * pt_to_vdp_mm), 2)
        w_mm = round(max(3.0, pt_w * pt_to_vdp_mm), 2)
        h_mm = round(max(3.0, pt_h * pt_to_vdp_mm), 2)

        field_name = _sanitize_field_name(content, fallback_idx=len(fields) + 1)
        fields.append({
            "id": f"vdp_tag_{uuid.uuid4().hex[:8]}",
            "name": field_name,
            "type": "text",
            "textContent": content,
            "pageNum": page_index + 1,
            "x": x_mm,
            "y": y_mm,
            "width": w_mm,
            "height": h_mm,
            "fontSize": font_size,
            "fontColor": font_color_hex,
            "fontName": clean_font_name,
            "fontFile": font_file_path,
            "fontStyle": font_style,
            "fontWeight": font_weight,
            "alignment": det_align,
            "rotation": clockwise_rot,
            "autoFit": True,
        })

    cleaned_path: Optional[str] = None
    if remove_original and tag_objects and output_path:
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        with pikepdf.open(pdf_path) as pdf:
            target_page = pdf.pages[page_index]
            stream_editor.delete_objects(
                target_page,
                tag_objects,
                pdf,
                all_obj_metas=all_objects,
            )
            # [VDP-TYPE0-LIVE-TEXT] Dọn dẹp dead Tf và ghost fonts trong template sạch
            from app.workers.vdp_engine import _clean_template_dead_text_ops_and_fonts
            _clean_template_dead_text_ops_and_fonts(target_page, pdf)
            pdf.save(output_path)
        cleaned_path = output_path

    return {
        "success": True,
        "fields": fields,
        "detectedCount": len(fields),
        "cleanedPdfPath": cleaned_path,
    }
