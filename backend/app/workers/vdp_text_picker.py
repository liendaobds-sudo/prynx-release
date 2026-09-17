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
from app.schemas.edit import ObjMeta

logger = logging.getLogger(__name__)

def _find_font_in_windows_registry(clean_name: str) -> Optional[str]:
    """Tra cứu font đã đăng ký trong Windows Registry (cả hệ thống và user)."""
    if not clean_name:
        return None
    try:
        import winreg
    except ImportError:
        return None

    target = clean_name.lower().replace("-", "").replace("_", "").replace(" ", "")
    base_dirs = [
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
                    clean_reg = re.sub(r"\s*\([^)]*\)", "", reg_name).lower().replace("-", "").replace("_", "").replace(" ", "")
                    if clean_reg == target:
                        if os.path.isabs(val) and os.path.isfile(val):
                            return val
                        for bdir in base_dirs:
                            p = os.path.join(bdir, val)
                            if os.path.isfile(p):
                                return p
                # Pass 2: Khớp chứa (substring)
                for i in range(num_values):
                    reg_name, val, _ = winreg.EnumValue(key, i)
                    clean_reg = re.sub(r"\s*\([^)]*\)", "", reg_name).lower().replace("-", "").replace("_", "").replace(" ", "")
                    if target in clean_reg or clean_reg in target:
                        if os.path.isabs(val) and os.path.isfile(val):
                            return val
                        for bdir in base_dirs:
                            p = os.path.join(bdir, val)
                            if os.path.isfile(p):
                                return p
        except Exception:
            continue
    return None


def _resolve_font_file(font_name: Optional[str]) -> Optional[str]:
    """Tìm file font (.ttf, .otf, .ttc) trên hệ thống khớp với fontName."""
    if not font_name:
        return None
    clean_name = re.sub(r"^[A-Z]{6}\+", "", font_name)

    # 1. Tra cứu Windows Registry (chuẩn xác nhất cho mọi font cài đặt)
    reg_path = _find_font_in_windows_registry(clean_name) or _find_font_in_windows_registry(font_name)
    if reg_path:
        return reg_path

    # 2. Quét các thư mục font chuẩn
    dirs = [
        r"C:\Windows\Fonts",
        os.path.expanduser(r"~\AppData\Local\Microsoft\Windows\Fonts"),
        r"C:\Program Files\Common Files\Adobe\Fonts",
        r"C:\Program Files (x86)\Common Files\Adobe\Fonts",
    ]
    target = clean_name.lower().replace("-", "").replace("_", "").replace(" ", "")

    for d in dirs:
        if not os.path.isdir(d):
            continue
        try:
            for f in os.listdir(d):
                stem, ext = os.path.splitext(f)
                if ext.lower() not in (".ttf", ".otf", ".ttc"):
                    continue
                clean_stem = stem.lower().replace("-", "").replace("_", "").replace(" ", "")
                if clean_stem == target:
                    return os.path.join(d, f)
        except Exception:
            continue

    for d in dirs:
        if not os.path.isdir(d):
            continue
        try:
            for f in os.listdir(d):
                stem, ext = os.path.splitext(f)
                if ext.lower() not in (".ttf", ".otf", ".ttc"):
                    continue
                clean_stem = stem.lower().replace("-", "").replace("_", "").replace(" ", "")
                if target in clean_stem or clean_stem in target:
                    return os.path.join(d, f)
        except Exception:
            continue
    return None


def _extract_embedded_font_from_pdf(
    pdf_path: str,
    page_index: int,
    font_name: Optional[str],
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

                    # Khớp tên font
                    matched = (
                        not clean_target
                        or clean_target in clean_bf
                        or clean_bf in clean_target
                        or (len(fonts_dict) == 1)
                    )
                    if not matched:
                        continue

                    # Lấy descriptor (trực tiếp hoặc qua DescendantFonts cho Type0)
                    desc = font_dict.get("/FontDescriptor")
                    if desc is None and "/DescendantFonts" in font_dict:
                        descendants = font_dict["/DescendantFonts"]
                        if len(descendants) > 0:
                            desc_font = descendants[0]
                            desc_font_dict = desc_font if isinstance(desc_font, pikepdf.Dictionary) else desc_font.resolve()
                            desc = desc_font_dict.get("/FontDescriptor")

                    if desc is None:
                        continue
                    desc = desc if isinstance(desc, pikepdf.Dictionary) else desc.resolve()

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
                                        ext = ".otf"
                                elif k == "/FontFile2":
                                    ext = ".ttf"
                                break
                            except Exception:
                                continue

                    if data and len(data) > 100:
                        import tempfile, hashlib
                        vdp_font_dir = os.path.join(tempfile.gettempdir(), "PrynX-dev", "vdp_fonts")
                        os.makedirs(vdp_font_dir, exist_ok=True)
                        h = hashlib.md5(data[:512]).hexdigest()[:8]
                        safe_name = re.sub(r"[^\w-]", "_", clean_target or "vdp_font")[:24]
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

    # 2. Lấy thuộc tính chi tiết
    text_props = geometry_reader.get_text_object_props(pdf_path, page_index, draw_index)
    content = text_props.get("content") or target_obj.content or ""
    raw_font_name = text_props.get("fontName") or target_obj.fontName or "Helvetica"
    clean_font_name = re.sub(r"^[A-Z]{6}\+", "", raw_font_name)
    font_name = clean_font_name
    font_size = text_props.get("fontSize")
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

    # BBox trong PDFium là [x0, y0, x1, y1] theo point (gốc bottom-left)
    bx0, by0, bx1, by1 = target_obj.bbox
    pt_w = max(5.0, bx1 - bx0)
    pt_h_tight = max(1.0, by1 - by0)
    pt_left = bx0 - cx0

    # Tính cỡ chữ chuẩn xác (kết hợp Tf và Text Matrix scale của Illustrator/Corel)
    font_size = _calculate_actual_font_size(font_size, target_obj.matrix, pt_h_tight)
    effective_fs = font_size or 12.0

    # Khung Bounding Box bao trọn toàn bộ con chữ (gồm cả dấu ngã, mũ, ascender, descender)
    # để chữ không bao giờ bị cắt ở mép trên hoặc mép dưới:
    matrix = target_obj.matrix
    f_val = matrix[5] if matrix and len(matrix) >= 6 else None
    if f_val is not None and (by0 - 5.0) <= f_val <= (by1 + 5.0):
        baseline_y = f_val
    else:
        has_descender = any(c in "gjyqp" for c in content)
        baseline_y = by0 + (effective_fs * 0.22 if has_descender else 0.0)

    # Đọc font file từ hệ thống hoặc trích xuất nhúng từ PDF
    font_file_path = (
        _resolve_font_file(clean_font_name)
        or _resolve_font_file(raw_font_name)
        or _extract_embedded_font_from_pdf(pdf_path, page_index, raw_font_name)
    )

    has_descender = any(c in "gjyqp" for c in content)
    has_ascender_or_accent = any(
        c in "AĂÂBCDĐEÊGHIKLMNOÔƠPQRSTUƯVXY1234567890?/~`!@#$%^&*()_+"
        for c in content.upper()
    )
    # Đỉnh cao nhất của chữ
    top_pdf = max(by1, baseline_y + (effective_fs * 0.95 if has_ascender_or_accent else effective_fs * 0.75))
    # Đáy thấp nhất của chữ
    bottom_pdf = min(by0, baseline_y - (effective_fs * 0.28 if has_descender else 0.05 * effective_fs))

    raw_h = max(1.0, top_pdf - bottom_pdf)
    target_h = max(raw_h, effective_fs * 1.25)
    diff = target_h - raw_h
    top_pdf += diff / 2.0
    bottom_pdf -= diff / 2.0

    pt_h = target_h
    pt_top = cy1 - top_pdf
    pt_w = max(5.0, (bx1 - bx0) + 2.0)
    pt_left = max(0.0, bx0 - cx0 - 1.0)

    # Đổi pt sang đơn vị mm của VDP PrynX:
    # Khung VDP dùng CSS-mm (pt * 96/72 * 25.4/72 = pt * 25.4 / 54.0) để bảo đảm
    # parity tuyệt đối giữa overlay frontend và ReportLab backend.
    pt_to_vdp_mm = (96.0 / 72.0) * (25.4 / 72.0)
    x_mm = round(max(0.0, pt_left * pt_to_vdp_mm), 2)
    y_mm = round(max(0.0, pt_top * pt_to_vdp_mm), 2)
    w_mm = round(max(5.0, pt_w * pt_to_vdp_mm), 2)
    h_mm = round(max(3.0, pt_h * pt_to_vdp_mm), 2)

    # Kiểm tra xem đối tượng có thuộc chuỗi chữ uốn cong (Curved Text) hay không
    curved_group = _detect_curved_text_group(target_obj, all_objects, pdf_path, page_index)
    is_curved = False
    curve_mode = "none"
    curve_radius_mm = 0.0

    if len(curved_group) >= 2:
        angles = [g["angle"] for g in curved_group]
        angle_span = max(angles) - min(angles)
        is_curved = angle_span > 10.0 or len(curved_group) >= 3

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
        content = "".join(text_parts).strip()

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
        "alignment": "center" if is_curved else "left",
        "autoFit": True,
        **({
            "curveMode": curve_mode,
            "curveRadius": curve_radius_mm,
            "curveOrientation": "outward",
        } if is_curved else {}),
    }

    cleaned_path: Optional[str] = None
    removed_draw_indices = [target_obj.drawIndex]
    if remove_original and output_path:
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
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
                    stream_editor.delete_objects(
                        target_page,
                        [g["obj"] for g in curved_group],
                        pdf,
                        all_obj_metas=all_objects,
                    )
                    removed_draw_indices = [g["obj"].drawIndex for g in curved_group]
            else:
                stream_editor.delete_objects(
                    target_page,
                    [target_obj],
                    pdf,
                    all_obj_metas=all_objects,
                )
            pdf.save(output_path)
        cleaned_path = output_path

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
        content = props.get("content") or obj.content or ""
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
        f_val = matrix[5] if matrix and len(matrix) >= 6 else None
        if f_val is not None and (by0 - 5.0) <= f_val <= (by1 + 5.0):
            baseline_y = f_val
        has_descender = any(c in "gjyqp" for c in content)
        has_ascender_or_accent = any(
            c in "AĂÂBCDĐEÊGHIKLMNOÔƠPQRSTUƯVXY1234567890?/~`!@#$%^&*()_+"
            for c in content.upper()
        )
        top_pdf = max(by1, baseline_y + (effective_fs * 0.95 if has_ascender_or_accent else effective_fs * 0.75))
        bottom_pdf = min(by0, baseline_y - (effective_fs * 0.28 if has_descender else 0.05 * effective_fs))

        raw_h = max(1.0, top_pdf - bottom_pdf)
        target_h = max(raw_h, effective_fs * 1.25)
        diff = target_h - raw_h
        top_pdf += diff / 2.0
        bottom_pdf -= diff / 2.0

        pt_h = target_h
        pt_top = cy1 - top_pdf
        pt_w = max(5.0, (bx1 - bx0) + 2.0)
        pt_left = max(0.0, bx0 - cx0 - 1.0)

        pt_to_vdp_mm = (96.0 / 72.0) * (25.4 / 72.0)
        x_mm = round(max(0.0, pt_left * pt_to_vdp_mm), 2)
        y_mm = round(max(0.0, pt_top * pt_to_vdp_mm), 2)
        w_mm = round(max(5.0, pt_w * pt_to_vdp_mm), 2)
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
            "alignment": "left",
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
            pdf.save(output_path)
        cleaned_path = output_path

    return {
        "success": True,
        "fields": fields,
        "detectedCount": len(fields),
        "cleanedPdfPath": cleaned_path,
    }
