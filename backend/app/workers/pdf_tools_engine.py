"""
High-Performance PDF Tools Engine (pikepdf).

Provides backend implementations for 4 common PDF operations:
1. Merge  — Ghép nối tiếp / Trộn xen kẽ / Chèn trang
2. Split  — Tách file theo dải / theo số trang / trích trang
3. Resize — Đổi khổ trang hàng loạt (sử dụng Form XObject)
4. Shuffle — Xáo trộn / đảo ngược / tách chẵn-lẻ

All use pikepdf (C++/QPDF) → Faster and completely open-source (MPL), fully open-source (MPL).
"""

import os
import math
import pikepdf
from typing import Callable, List, Optional, Tuple

# RESIZE (audit 2026-08-06 §G.1): dùng chung helper bake /Rotate với đường
# content-aware (resize_background_engine) để hai engine đọc trang nguồn giống nhau.
from app.core.page_boxes import _canonicalize_rotated_page_for_mirror
from app.core.page_selection import parse_page_selection, validate_page_selection

MM_TO_PTS = 2.83465

class PdfOperationCancelled(RuntimeError):
    """Tác vụ PDF đã nhận tín hiệu hủy ở điểm cooperative an toàn."""


def _background_rgb(bg_fill_mode: str, bg_fill_color: str) -> tuple[float, float, float]:
    """Chuẩn hóa màu nền resize; mode khác solid luôn dùng màu giấy trắng."""
    if str(bg_fill_mode or "").strip().lower() != "solid":
        return 1.0, 1.0, 1.0

    value = str(bg_fill_color or "").strip()
    if value.startswith("#"):
        value = value[1:]
    if len(value) != 6:
        return 1.0, 1.0, 1.0
    try:
        channels = tuple(int(value[index:index + 2], 16) / 255.0 for index in (0, 2, 4))
    except ValueError:
        return 1.0, 1.0, 1.0
    return channels




def save_pdf_compat(pdf: "pikepdf.Pdf", path: str, **kwargs) -> None:
    """Lưu PDF ở dạng pdf-lib (frontend) ĐỌC ĐƯỢC.

    Vì sao: QPDF/pikepdf mặc định ghi object stream + cross-reference STREAM (nén
    Flate) cho PDF ≥1.5. pdf-lib (pako) KHÔNG giải nén được các stream này khi nạp
    lại → ném ``Invalid header in flate stream`` (vd: bù xén xong resize lại lỗi).
    Tắt object stream → QPDF ghi XREF CỔ ĐIỂN (bảng, không nén) → pdf-lib nạp OK.
    Nội dung/ảnh vẫn nén Flate/DCT bình thường (pdf-lib đọc được), chỉ cấu trúc
    file là dạng cổ điển. Chi phí dung lượng thêm không đáng kể (chỉ phần cấu trúc)."""
    try:
        pdf.save(path, object_stream_mode=pikepdf.ObjectStreamMode.disable, **kwargs)
    except TypeError:
        # pikepdf quá cũ không có tham số → lưu thường (fallback an toàn).
        pdf.save(path, **kwargs)

# =========================================================================
#  1. MERGE
# =========================================================================

def merge_pdfs(file_paths: List[str], output_path: str, mode: str = 'merge_files',
               interleave_reverse_even: bool = False) -> str:
    out_doc = pikepdf.Pdf.new()

    if mode == 'merge_files':
        for path in file_paths:
            with pikepdf.Pdf.open(path) as src:
                out_doc.pages.extend(src.pages)

    elif mode == 'interleave':
        if len(file_paths) < 2:
            raise ValueError("Interleave requires at least 2 files")
        with pikepdf.Pdf.open(file_paths[0]) as odd_doc, pikepdf.Pdf.open(file_paths[1]) as even_doc:
            max_pages = max(len(odd_doc.pages), len(even_doc.pages))
            for i in range(max_pages):
                if i < len(odd_doc.pages):
                    out_doc.pages.append(odd_doc.pages[i])
                if i < len(even_doc.pages):
                    if interleave_reverse_even:
                        even_idx = len(even_doc.pages) - 1 - i
                        if even_idx >= 0:
                            out_doc.pages.append(even_doc.pages[even_idx])
                    else:
                        out_doc.pages.append(even_doc.pages[i])

    save_pdf_compat(out_doc, output_path)
    return output_path


# =========================================================================
#  2. SPLIT
# =========================================================================


def _normalize_split_ranges(ranges, max_page: int) -> List[Tuple[int, int]]:
    """Chuẩn hóa đúng cú pháp chuỗi mà SplitTool gửi: ``1-4, 7, 10-``."""
    normalized: List[Tuple[int, int]] = []

    if isinstance(ranges, str):
        if not ranges.strip():
            return [(1, max_page)]
        parts = [part.strip() for part in ranges.split(",") if part.strip()]
        for part in parts:
            try:
                if "-" in part:
                    start_text, end_text = (token.strip() for token in part.split("-", 1))
                    start = int(start_text)
                    end = int(end_text) if end_text else max_page
                    if start >= 1 and end >= start:
                        normalized.append((min(start, max_page), min(end, max_page)))
                else:
                    page = int(part)
                    if 1 <= page <= max_page:
                        normalized.append((page, page))
            except (TypeError, ValueError):
                continue
        return normalized

    if ranges is None:
        return [(1, max_page)]

    for item in ranges or []:
        if not isinstance(item, (list, tuple)) or len(item) != 2:
            continue
        try:
            start, end = int(item[0]), int(item[1])
        except (TypeError, ValueError):
            continue
        if start >= 1 and end >= start:
            normalized.append((min(start, max_page), min(end, max_page)))
    return normalized


def _preserve_split_catalog(src: pikepdf.Pdf, out: pikepdf.Pdf) -> None:
    """Giữ catalog in/layer khi Split dựng một PDF mới từ các trang nguồn."""
    for key in ('/OCProperties', '/OutputIntents'):
        value = src.Root.get(key)
        if value is None:
            continue
        foreign = value if value.is_indirect else src.make_indirect(value)
        out.Root[pikepdf.Name(key)] = out.copy_foreign(foreign)


def split_pdf(source_path: str, output_dir: str, mode: str = 'by_range',
              ranges: List[Tuple[int, int]] = None,
              pages_per_file: int = 1,
              page_list: List[int] = None,
              base_name: str = 'split') -> List[dict]:
    results = []
    os.makedirs(output_dir, exist_ok=True)

    with pikepdf.Pdf.open(source_path) as src:
        if mode == 'by_range':
            normalized_ranges = _normalize_split_ranges(ranges, len(src.pages))
            if not normalized_ranges:
                raise ValueError("Không có dải trang hợp lệ để tách.")
            for idx, (start, end) in enumerate(normalized_ranges):
                out = pikepdf.Pdf.new()
                from_page = max(0, start - 1)
                to_page = min(len(src.pages) - 1, end - 1)
                for i in range(from_page, to_page + 1):
                    out.pages.append(src.pages[i])
                fname = f"{base_name}_{idx + 1:02d}_p{start}-{end}.pdf"
                path = os.path.join(output_dir, fname)
                _preserve_split_catalog(src, out)
                save_pdf_compat(out, path)
                results.append({"filename": fname, "path": path, "pages": to_page - from_page + 1})

        elif mode == 'by_count':
            pages_per_file = int(pages_per_file)
            if pages_per_file < 1:
                raise ValueError("Số trang mỗi file phải lớn hơn 0.")
            total = len(src.pages)
            chunk_idx = 0
            for start in range(0, total, pages_per_file):
                end = min(start + pages_per_file - 1, total - 1)
                out = pikepdf.Pdf.new()
                for i in range(start, end + 1):
                    out.pages.append(src.pages[i])
                fname = f"{base_name}_part{chunk_idx + 1}.pdf"
                path = os.path.join(output_dir, fname)
                _preserve_split_catalog(src, out)
                save_pdf_compat(out, path)
                results.append({"filename": fname, "path": path, "pages": end - start + 1})
                chunk_idx += 1

        elif mode == 'extract_pages':
            valid_pages = []
            for page in page_list or []:
                try:
                    page_number = int(page)
                except (TypeError, ValueError):
                    continue
                if 1 <= page_number <= len(src.pages):
                    valid_pages.append(page_number)
            if not valid_pages:
                raise ValueError("Không có trang hợp lệ để trích xuất.")
            out = pikepdf.Pdf.new()
            # Thứ tự người dùng nhập cũng là thứ tự trang của file kết quả.
            for pg in valid_pages:
                idx = pg - 1
                out.pages.append(src.pages[idx])
            fname = f"{base_name}_extracted.pdf"
            path = os.path.join(output_dir, fname)
            _preserve_split_catalog(src, out)
            save_pdf_compat(out, path)
            results.append({"filename": fname, "path": path, "pages": len(out.pages)})

        else:
            raise ValueError(f"Chế độ tách không được hỗ trợ: {mode}")

    return results


# =========================================================================
#  3. RESIZE
# =========================================================================

def resize_pages(source_path: str, output_path: str,
                 target_w_mm: float, target_h_mm: float,
                 scale_mode: str = 'fit',
                 apply_to: str = 'all',
                 auto_orientation: bool = False,
                 bg_fill_mode: str = "white",
                 bg_fill_color: str = "#ffffff",
                 cancel_event: Optional[object] = None,
                 progress_callback: Optional[Callable[[int, int], None]] = None) -> str:
    target_w = target_w_mm * MM_TO_PTS
    bg_r, bg_g, bg_b = _background_rgb(bg_fill_mode, bg_fill_color)
    target_h = target_h_mm * MM_TO_PTS

    out_doc = pikepdf.Pdf.new()

    def check_cancelled() -> None:
        if cancel_event is not None and bool(cancel_event.is_set()):
            out_doc.close()
            raise PdfOperationCancelled("Đã hủy chuẩn hóa khổ PDF.")

    with pikepdf.Pdf.open(source_path) as src:
        total = len(src.pages)
        # RESIZE (audit 2026-08-06 §G.6): dùng parser CHUNG với đường nền động,
        # trước đây hai bản copy lệch nhau ở dải hở/token rác.
        pages_to_resize = parse_page_selection(apply_to, total)

        for i in range(total):
            check_cancelled()
            src_page = src.pages[i]
            
            if i in pages_to_resize:
                # RESIZE (audit 2026-08-06 §G.1): trang có /Rotate≠0 phải được BAKE
                # góc xoay vào content stream TRƯỚC khi đo MediaBox và tạo Form
                # XObject. Nếu không, as_form_xobject() sinh /BBox theo khổ CHƯA xoay
                # kèm /Matrix lật → nội dung sau khi lật vượt BBox và bị CLIP (đo được:
                # mất 2/4 dấu góc), đồng thời src_w/src_h đọc sai chiều nên tỉ lệ fit
                # tính trên khổ chưa xoay. Sau khi bake: /Rotate=0, MediaBox đã hoán
                # chiều, mọi box phụ đã biến đổi theo — khớp đường content-aware
                # (resize_background_engine.py) và đường frontend pdf-lib.
                try:
                    _canonicalize_rotated_page_for_mirror(src, src_page)
                except Exception:
                    # Góc xoay lạ (không bội số 90) → giữ nguyên hành vi cũ, không chặn tác vụ.
                    pass

                # GIỮ BOX BLEED/TRIM: đọc TrimBox/BleedBox/ArtBox GỐC trước khi đụng
                # CropBox — resize phải mang các box này sang trang mới (scale theo
                # cùng biến đổi nội dung), nếu không file kết quả MẤT định nghĩa bleed
                # → in cắt theo mép = bleed thành trắng.
                _orig_boxes = {}
                for _bk in ("/TrimBox", "/BleedBox", "/ArtBox"):
                    _b = src_page.get(_bk)
                    if _b is not None:
                        try:
                            _orig_boxes[_bk] = [float(_b[0]), float(_b[1]), float(_b[2]), float(_b[3])]
                        except Exception:
                            pass
                        # XÓA box hạn chế trên trang NGUỒN: as_form_xobject() lấy /BBox
                        # theo box NHỎ NHẤT (thường TrimBox) → CLIP mất vùng NGOÀI trim
                        # (chính là bleed) → resize xong bleed thành TRẮNG. Xoá đi để BBox
                        # = MediaBox (gồm TRỌN bleed). Đã lưu _orig_boxes để set lại (scaled)
                        # trên trang ĐÍCH. Mutate in-memory, KHÔNG lưu vào file nguồn.
                        try:
                            del src_page[pikepdf.Name(_bk)]
                        except Exception:
                            pass

                # Resize for print production always uses the full MediaBox. CropBox is a
                # viewing boundary and must not discard bleed/marks outside that boundary.
                # A destructive crop already synchronizes MediaBox to the cropped size.
                try:
                    mb = src_page.mediabox
                    src_w = float(mb[2] - mb[0])
                    src_h = float(mb[3] - mb[1])
                except Exception:
                    src_w, src_h = 595.28, 841.89

                page_target_w, page_target_h = target_w, target_h
                orientation_w, orientation_h = src_w, src_h
                try:
                    if int(src_page.get('/Rotate', 0)) % 180:
                        orientation_w, orientation_h = orientation_h, orientation_w
                except Exception:
                    pass
                if auto_orientation and ((orientation_w > orientation_h) != (target_w > target_h)):
                    page_target_w, page_target_h = target_h, target_w
                # Create the destination only after choosing its per-page orientation.
                new_page = out_doc.add_blank_page(page_size=(page_target_w, page_target_h))
                if (
                    str(bg_fill_mode or "").strip().lower() == "solid"
                    and scale_mode in {"fit", "center_no_scale"}
                ):
                    # RESIZE (audit 2026-07-31 §B.1): nền phải được vẽ cả trên
                    # đường backend để file lớn/downsample không đổi hành vi.
                    background = (
                        f"q {bg_r:.6f} {bg_g:.6f} {bg_b:.6f} rg "
                        f"0 0 {page_target_w:.4f} {page_target_h:.4f} re f Q"
                    )
                    new_page.contents_add(pikepdf.Stream(out_doc, background.encode("ascii")))

                # Force the form BBox to the full MediaBox so bleed remains renderable.
                try:
                    src_page.CropBox = src_page.MediaBox
                except Exception:
                    pass

                # Copy foreign the source page as an XObject
                xobj = src_page.as_form_xobject()
                xobj_name = new_page.add_resource(xobj, pikepdf.Name.XObject)
                xobj_name_str = str(xobj_name)

                # 4 mode PHẢI khớp frontend PageResizer.ts (đường không-downsample):
                #  - fit: scale ĐỀU nhỏ nhất, vừa khít, có viền → KHÔNG cắt.
                #  - fill: scale ĐỀU lớn nhất, lấp đầy → CẮT phần thừa.
                #  - stretch (Ép bóp méo): scale X/Y RIÊNG → méo hình, KHÔNG cắt.
                #  - center_no_scale (Giữ nguyên ở giữa): scale=1, canh giữa.
                # Bug cũ: chỉ có fit + else(=fill) → stretch & center_no_scale RƠI vào
                # fill → phóng to giữ tỉ lệ + cắt mất hình (user báo "ép bóp méo mà lại
                # thu khung cắt hình").
                if scale_mode == 'fit':
                    scale = min(page_target_w / src_w, page_target_h / src_h)
                    scale_x = scale_y = scale
                elif scale_mode == 'stretch':
                    scale_x = page_target_w / src_w
                    scale_y = page_target_h / src_h
                elif scale_mode == 'center_no_scale':
                    scale_x = scale_y = 1.0
                else:
                    # fill/crop
                    scale = max(page_target_w / src_w, page_target_h / src_h)
                    scale_x = scale_y = scale

                new_w = src_w * scale_x
                new_h = src_h * scale_y
                offset_x = (page_target_w - new_w) / 2
                offset_y = (page_target_h - new_h) / 2

                # Inject Matrix drawing command (a=scale_x, d=scale_y — stretch méo hình).
                content = f"q {scale_x:.4f} 0 0 {scale_y:.4f} {offset_x:.4f} {offset_y:.4f} cm {xobj_name_str} Do Q"
                new_page.contents_add(pikepdf.Stream(out_doc, content.encode('ascii')))

                # Mang TrimBox/BleedBox/ArtBox sang trang mới, biến đổi theo ĐÚNG cm
                # nội dung: điểm nguồn (px,py) → (px*scale+offset_x, py*scale+offset_y).
                # Nhờ đó output vẫn là PDF CHUẨN có định nghĩa bleed/trim (không mất
                # bleed như trước). Kẹp trong MediaBox mới để box không thò ra ngoài.
                def _tx_box(box):
                    x0, y0, x1, y1 = box
                    nx0 = x0 * scale_x + offset_x
                    ny0 = y0 * scale_y + offset_y
                    nx1 = x1 * scale_x + offset_x
                    ny1 = y1 * scale_y + offset_y
                    nx0, nx1 = max(0.0, min(nx0, nx1)), min(page_target_w, max(nx0, nx1))
                    ny0, ny1 = max(0.0, min(ny0, ny1)), min(page_target_h, max(ny0, ny1))
                    return [round(nx0, 3), round(ny0, 3), round(nx1, 3), round(ny1, 3)]

                for _bk, _box in _orig_boxes.items():
                    try:
                        new_page[pikepdf.Name(_bk)] = pikepdf.Array(_tx_box(_box))
                    except Exception:
                        pass
            else:
                out_doc.pages.append(src_page)

            if progress_callback is not None:
                progress_callback(i + 1, total)

    check_cancelled()
    save_pdf_compat(out_doc, output_path)
    out_doc.close()
    return output_path


# =========================================================================
#  3b. SMART RESIZE (content-aware resize + downsample)
# =========================================================================
#
# Vì sao cần: resize_pages() ở trên chỉ đổi HÌNH HỌC (bọc trang gốc thành Form
# XObject + ma trận tỉ lệ). Toàn bộ ảnh độ phân giải gốc VẪN nằm trong file →
# đổi A1→A5 mà dung lượng không giảm (vẫn ~300MB) → mọi tác vụ sau (trim/bình)
# đều chậm. resize_pages_smart bổ sung bước GIẢM DỮ LIỆU theo khổ mới:
#
#   - mode='vector' (mặc định, AN TOÀN IN ẤN): resize hình học rồi hạ ẢNH theo
#     effective-DPI ở cấp XObject. Giữ nguyên vector/text và không dựng lại toàn bộ PDF.
#   - mode='raster' (nhanh nhất, cho trang THUẦN ẢNH): pypdfium2 render mỗi trang
#     ở đúng DPI đích rồi dựng lại. Nhỏ & nhanh nhất NHƯNG raster hoá (mất vector/
#     text sắc nét) và ra RGB (mất CMYK/spot) → chỉ dùng khi hợp.
#   - mode='auto': chọn raster CHỈ KHI an toàn (không có text-font và không có ảnh
#     CMYK/DeviceN); còn lại dùng vector.
#   - mode='xobject' hoặc target_dpi<=0: giữ hành vi cũ (chỉ đổi hình học).

import logging as _logging

_pt_logger = _logging.getLogger(__name__)


def _doc_has_text_fonts(path: str) -> bool:
    """True nếu BẤT KỲ trang nào tham chiếu /Font (có text vector) — heuristic
    để 'auto' tránh raster hoá làm mất chữ."""
    try:
        with pikepdf.Pdf.open(path) as pdf:
            for page in pdf.pages:
                res = page.get("/Resources")
                if res is not None and "/Font" in res:
                    fonts = res["/Font"]
                    try:
                        if len(fonts.keys()) > 0:
                            return True
                    except Exception:
                        return True
    except Exception:
        # Không đọc được → coi như CÓ text (chọn đường an toàn: vector).
        return True
    return False


def _doc_has_non_rgb_images(path: str) -> bool:
    """True nếu có ảnh dùng colorspace CMYK/DeviceN/Separation/ICC — raster hoá
    (pypdfium2 → RGB) sẽ phá tách kênh in, nên 'auto' phải né raster khi gặp."""
    try:
        with pikepdf.Pdf.open(path) as pdf:
            for page in pdf.pages:
                res = page.get("/Resources")
                if res is None or "/XObject" not in res:
                    continue
                for _name, xobj in res["/XObject"].items():
                    try:
                        if xobj.get("/Subtype") != pikepdf.Name.Image:
                            continue
                        cs = xobj.get("/ColorSpace")
                        cs_str = str(cs)
                        if any(tok in cs_str for tok in (
                            "DeviceCMYK", "DeviceN", "Separation", "ICCBased", "Indexed"
                        )):
                            return True
                    except Exception:
                        return True  # nghi ngờ → coi là non-RGB (an toàn)
    except Exception:
        return True
    return False


def _native_downsample(input_path: str, output_path: str, target_dpi: int) -> bool:
    """Hạ độ phân giải ảnh bằng pikepdf/Pillow. `False` ⇒ caller giữ bản hình học.

    Dùng chung `pdf_actions_native.downscale_images` với action DOWNSCALE_IMAGES
    — cùng cách tính DPI hiệu dụng (CTM, đệ quy Form XObject) và cùng danh sách
    ảnh bỏ qua vì không an toàn.

    Ngưỡng giữ **1.5×** để chỉ hạ ảnh vượt DPI hiệu dụng đủ xa. Hạ mọi ảnh chỉ
    hơn ngưỡng một chút sẽ làm mờ mà gần như không giảm dung lượng.
    """
    try:
        from app.core import pdf_actions_native
    except Exception as exc:  # noqa: BLE001
        _pt_logger.debug("resize downsample: không nạp được pdf_actions_native (%s)", exc)
        return False
    try:
        result = pdf_actions_native.downscale_images(
            input_path, output_path, float(target_dpi), float(target_dpi) * 1.5
        )
    except Exception as exc:  # noqa: BLE001
        _pt_logger.warning("Hạ ảnh ở cấp XObject lỗi (%s) → giữ bản chỉ đổi hình học.", exc)
        return False
    if result.get("changed", 0) > 0:
        _pt_logger.info(
            "resize downsample: hạ %d ảnh bằng pikepdf/Pillow.",
            result["changed"],
        )
        return True
    return False


def _raster_resize(source_path: str, output_path: str,
                   target_w_mm: float, target_h_mm: float,
                   scale_mode: str, target_dpi: int,
                   bg_fill_mode: str = "white",
                   bg_fill_color: str = "#ffffff") -> str:
    """Render mỗi trang ở đúng DPI đích rồi dựng lại PDF khổ mới (pypdfium2 + PIL).

    NHANH & NHỎ nhất cho trang thuần ảnh. Raster hoá → mất vector/text, ra RGB.
    Chỉ hỗ trợ apply_to='all' (caller đã đảm bảo)."""
    import pypdfium2 as pdfium
    from PIL import Image

    tw_pt = target_w_mm * MM_TO_PTS
    th_pt = target_h_mm * MM_TO_PTS
    px_w = max(1, round(target_w_mm / 25.4 * target_dpi))
    px_h = max(1, round(target_h_mm / 25.4 * target_dpi))
    background_rgb = tuple(
        max(0, min(255, round(channel * 255)))
        for channel in _background_rgb(bg_fill_mode, bg_fill_color)
    )

    pdf = pdfium.PdfDocument(source_path)
    pages_img: List["Image.Image"] = []
    try:
        for i in range(len(pdf)):
            page = pdf[i]
            sw, sh = page.get_size()  # points
            if sw <= 0 or sh <= 0:
                sw, sh = tw_pt, th_pt
            # 4 mode PHẢI khớp resize_pages (vector) + frontend PageResizer.ts:
            #  - fit: scale ĐỀU nhỏ nhất, có viền, KHÔNG cắt.
            #  - fill/crop: scale ĐỀU lớn nhất, lấp đầy, CẮT phần thừa.
            #  - stretch (Ép bóp méo): kéo X/Y RIÊNG lấp đầy canvas → méo, KHÔNG cắt.
            #  - center_no_scale (Giữ nguyên ở giữa): scale=1, canh giữa.
            # Bug cũ: chỉ fit + else(=fill) → stretch & center_no_scale rơi vào fill
            # → phóng to giữ tỉ lệ + cắt mất hình (user báo "ép bóp méo mà lại cắt").
            if scale_mode == "stretch":
                # Render native theo DPI rồi kéo bitmap khít px_w×px_h (méo).
                _rs = max(0.01, min(target_dpi / 72.0, target_dpi / 72.0 * 8))
                bmp = page.render(scale=_rs).to_pil().convert("RGB")
                canvas = bmp.resize((px_w, px_h), Image.LANCZOS)
                pages_img.append(canvas)
                continue
            if scale_mode == "center_no_scale":
                _rs = max(0.01, min(target_dpi / 72.0, target_dpi / 72.0 * 8))
                bmp = page.render(scale=_rs).to_pil().convert("RGB")
            else:
                if scale_mode == "fit":
                    fit = min(tw_pt / sw, th_pt / sh)
                else:  # fill/crop
                    fit = max(tw_pt / sw, th_pt / sh)
                render_scale = (target_dpi / 72.0) * fit
                # Chặn scale phi lý (trang lỗi) → tránh OOM.
                render_scale = max(0.01, min(render_scale, target_dpi / 72.0 * 8))
                bmp = page.render(scale=render_scale).to_pil().convert("RGB")
            canvas = Image.new("RGB", (px_w, px_h), background_rgb)
            off_x = (px_w - bmp.width) // 2
            off_y = (px_h - bmp.height) // 2
            # fill/crop có thể tràn canvas → paste vẫn cắt đúng phần trong canvas.
            canvas.paste(bmp, (off_x, off_y))
            pages_img.append(canvas)
    finally:
        pdf.close()

    if not pages_img:
        raise ValueError("Không render được trang nào để raster resize.")

    pages_img[0].save(
        output_path, format="PDF", save_all=True,
        append_images=pages_img[1:], resolution=float(target_dpi),
    )
    return output_path


def _choose_auto_mode(apply_to: str, has_text: bool, has_non_rgb_images: bool) -> str:
    """Quyết định mode cho 'auto' (thuần hàm, dễ test).

    Raster (nhanh/nhỏ nhất nhưng mất vector & CMYK) CHỈ an toàn khi: xử lý TOÀN BỘ
    trang, KHÔNG có text-font (không mất chữ), và KHÔNG có ảnh non-RGB (không phá
    tách kênh in). Mọi trường hợp khác → vector (giữ vector/text/CMYK)."""
    if apply_to == "all" and not has_text and not has_non_rgb_images:
        return "raster"
    return "vector"


def resize_pages_smart(source_path: str, output_path: str,
                       target_w_mm: float, target_h_mm: float,
                       scale_mode: str = "fit", apply_to: str = "all",
                       target_dpi: int = 0, mode: str = "auto",
                       bg_fill_mode: str = "white",
                       bg_fill_color: str = "#ffffff",
                       page_size_mode: str = "fixed",
                       resize_by_content: bool = False) -> str:
    """Resize trang + (tuỳ chọn) giảm dữ liệu theo khổ mới.

    target_dpi<=0 hoặc mode='xobject' → chỉ đổi hình học (hành vi cũ).
    Xem block chú thích 3b để biết các mode."""
    from app.workers.resize_background_engine import (
        is_dynamic_background_mode,
        normalize_page_size_mode,
        resize_pages_with_background,
    )

    target_dpi = int(target_dpi or 0)
    # RESIZE (audit 2026-08-06 §G.5): chuỗi chọn trang sai cú pháp trước đây ra tập
    # RỖNG → trả file y nguyên, người dùng tưởng đã đổi khổ. ValueError ở đây được
    # route /resize map thành HTTP 422.
    if isinstance(apply_to, str):
        validate_page_selection(apply_to)
    page_size_mode = normalize_page_size_mode(page_size_mode)
    variable_page_size = page_size_mode != "fixed"
    from app.core.pdf_actions_native import detect_transparent_pages

    transparent_page_indexes = {
        page_number - 1
        for page_number in detect_transparent_pages(source_path)
        if page_number > 0
    }
    has_transparency = bool(transparent_page_indexes)
    dynamic_background = (
        is_dynamic_background_mode(bg_fill_mode)
        and scale_mode in {"fit", "center_no_scale"}
    )
    content_aware_resize = (
        dynamic_background
        or variable_page_size
        or (bool(resize_by_content) and has_transparency)
    )
    background_dpi = target_dpi if target_dpi > 0 else 300

    def _resize_geometry(destination_path: str) -> str:
        if content_aware_resize:
            return resize_pages_with_background(
                source_path,
                destination_path,
                target_w_mm,
                target_h_mm,
                scale_mode=scale_mode,
                apply_to=apply_to,
                background_mode=bg_fill_mode,
                background_dpi=background_dpi,
                background_color=bg_fill_color,
                page_size_mode=page_size_mode,
                resize_by_content=bool(resize_by_content),
                transparent_page_indexes=transparent_page_indexes,
            )
        return resize_pages(
            source_path, destination_path, target_w_mm, target_h_mm, scale_mode, apply_to,
            bg_fill_mode=bg_fill_mode, bg_fill_color=bg_fill_color,
        )

    # DPI=0 chỉ giữ artwork gốc; lớp nền động vẫn dựng ở 300 DPI.
    if target_dpi <= 0 or mode == "xobject":
        return _resize_geometry(output_path)

    # RESIZE (audit 2026-08-01 §B.1): artwork đã là Form vector nằm trên
    # nền raster; không được rơi vào _raster_resize dù UI chọn "raster".
    # RESIZE (audit 2026-08-01 §R.4): khóa một chiều luôn dựng geometry vector
    # trước rồi mới giảm mẫu ảnh; §TR.1 quyết định contentBox hay page box theo alpha.
    # RESIZE (audit 2026-08-03 §TR.3): raster RGB có thể flatten
    # alpha. Kể cả user còn preset "raster" cũ, trang có transparency phải đi
    # Form/XObject; downsample object-level bên dưới hạ ảnh và SMask cùng tỷ lệ.
    chosen = "vector" if content_aware_resize or has_transparency else mode
    if mode == "auto" and not content_aware_resize and not has_transparency:
        chosen = _choose_auto_mode(
            apply_to=apply_to,
            has_text=_doc_has_text_fonts(source_path),
            has_non_rgb_images=_doc_has_non_rgb_images(source_path),
        )

    if chosen == "raster" and apply_to == "all":
        try:
            return _raster_resize(
                source_path, output_path, target_w_mm, target_h_mm,
                scale_mode, target_dpi, bg_fill_mode, bg_fill_color,
            )
        except Exception as e:  # noqa: BLE001
            _pt_logger.warning("raster resize lỗi (%s) → fallback sang vector.", e)
            chosen = "vector"

    # ── Vector: đổi hình học (XObject) rồi hạ độ phân giải ảnh ──
    tmp_geom = output_path + ".geom.pdf"
    _resize_geometry(tmp_geom)
    try:
        # GS-SUNSET (audit 2026-08-08 §GS.3): chỉ dùng đường object-level vì nó
        # ghi đè đúng ảnh vượt ngưỡng, giữ nguyên vector, page box, transparency
        # và các colorspace mà engine đánh giá là an toàn. Không hạ được thì giữ
        # nguyên bản chỉ đổi hình học — đúng fallback thực tế trước khi dọn GS.
        if _native_downsample(tmp_geom, output_path, int(target_dpi)):
            try:
                if os.path.getsize(output_path) < os.path.getsize(tmp_geom):
                    return output_path
            except OSError:
                return output_path
        # Fallback: dùng bản chỉ-đổi-hình-học.
        os.replace(tmp_geom, output_path)
        tmp_geom = None
        return output_path
    finally:
        if tmp_geom and os.path.exists(tmp_geom):
            try:
                os.remove(tmp_geom)
            except OSError:
                pass


# =========================================================================
#  4. SHUFFLE
# =========================================================================

def shuffle_pages(source_path: str, output_path: str,
                  action: str = 'reverse',
                  mapping: List[int] = None) -> str:
    with pikepdf.Pdf.open(source_path) as src:
        out_doc = pikepdf.Pdf.new()
        total = len(src.pages)

        if action == 'reverse':
            order = list(range(total - 1, -1, -1))
        elif action == 'odd_first':
            odds = list(range(0, total, 2))
            evens = list(range(1, total, 2))
            order = odds + evens
        elif action == 'even_first':
            evens = list(range(1, total, 2))
            odds = list(range(0, total, 2))
            order = evens + odds
        elif action == 'custom' and mapping:
            order = [p - 1 for p in mapping if 0 < p <= total]
        else:
            order = list(range(total))

        for idx in order:
            out_doc.pages.append(src.pages[idx])

        save_pdf_compat(out_doc, output_path)
    return output_path


# =========================================================================
#  5. ENCRYPT / DECRYPT  (B1/B2 — isolated; does not alter merge/split/etc.)
# =========================================================================

def pdf_is_encrypted(source_path: str) -> bool:
    """True if the PDF has an encryption dictionary (may still open empty-password)."""
    try:
        with pikepdf.Pdf.open(source_path) as pdf:
            return bool(pdf.is_encrypted)
    except pikepdf.PasswordError:
        return True
    except Exception:
        # Corrupt / non-PDF: let caller surface a clearer error on open.
        return False


def encrypt_pdf(
    source_path: str,
    output_path: str,
    *,
    user_password: str = "",
    owner_password: str = "",
    allow_print: bool = True,
    allow_copy: bool = True,
    allow_modify: bool = False,
    allow_annotate: bool = True,
    allow_form: bool = True,
    allow_assembly: bool = False,
    open_password: str = "",
) -> str:
    """Encrypt PDF with AES (R=6) via pikepdf.

    In-place structural save (no Pdf.new + pages.extend) so Outlines, forms,
    attachments and other catalog objects are preserved.

    - user_password: required to open (empty = open freely, restrictions still apply with owner)
    - owner_password: required to change permissions (falls back to user if empty)
    - open_password: if source is already encrypted, password to open it first
    """
    user_password = user_password or ""
    owner_password = owner_password or user_password or ""
    if not user_password and not owner_password:
        raise ValueError("Cần ít nhất mật khẩu người dùng hoặc mật khẩu chủ sở hữu.")

    perms = pikepdf.Permissions(
        accessibility=True,
        extract=bool(allow_copy),
        modify_annotation=bool(allow_annotate),
        modify_assembly=bool(allow_assembly),
        modify_form=bool(allow_form),
        modify_other=bool(allow_modify),
        print_lowres=bool(allow_print),
        print_highres=bool(allow_print),
    )
    encryption = pikepdf.Encryption(
        user=user_password,
        owner=owner_password,
        R=6,
        allow=perms,
        aes=True,
        metadata=True,
    )

    open_kw: dict = {}
    if open_password:
        open_kw["password"] = open_password
    # Same-path overwrite (rare; routes use RESULTS_DIR) needs this flag.
    if os.path.abspath(source_path) == os.path.abspath(output_path):
        open_kw["allow_overwriting_input"] = True

    try:
        with pikepdf.Pdf.open(source_path, **open_kw) as pdf:
            # Save THE SAME document graph — keep Outlines / AcroForm / EmbeddedFiles.
            save_pdf_compat(pdf, output_path, encryption=encryption)
    except pikepdf.PasswordError as e:
        raise ValueError("Sai mật khẩu hoặc file đã khóa — không mở được để khóa lại.") from e

    return output_path


def decrypt_pdf(source_path: str, output_path: str, *, password: str = "") -> str:
    """Remove encryption and save a plain PDF. Requires correct password when locked.

    In-place structural save — preserves Outlines and catalog (no page-only clone).
    """
    open_kw: dict = {"password": password or ""}
    if os.path.abspath(source_path) == os.path.abspath(output_path):
        open_kw["allow_overwriting_input"] = True
    try:
        with pikepdf.Pdf.open(source_path, **open_kw) as pdf:
            # Saving without encryption= strips encryption while keeping structure.
            save_pdf_compat(pdf, output_path)
    except pikepdf.PasswordError as e:
        raise ValueError("Sai mật khẩu — không mở được file đã khóa.") from e

    return output_path


# =========================================================================
#  6. METADATA  (B6 — isolated; does not alter optimize strip checkbox)
# =========================================================================

# Standard Info dict keys we expose in the editor UI.
_META_KEYS = (
    "Title",
    "Author",
    "Subject",
    "Keywords",
    "Creator",
    "Producer",
)


def _docinfo_to_dict(pdf: "pikepdf.Pdf") -> dict:
    out: dict = {k: "" for k in _META_KEYS}
    try:
        if not pdf.docinfo:
            return out
        for k, v in pdf.docinfo.items():
            name = str(k).lstrip("/")
            if name in out or name in _META_KEYS:
                try:
                    out[name] = str(v) if v is not None else ""
                except Exception:
                    out[name] = ""
            # Keep only standard keys in response for a stable UI contract.
    except Exception:
        pass
    return {k: out.get(k, "") for k in _META_KEYS}


def read_pdf_metadata(source_path: str, *, password: str = "") -> dict:
    """Return standard Info dictionary fields (Title, Author, …)."""
    try:
        with pikepdf.Pdf.open(source_path, password=password or "") as pdf:
            return _docinfo_to_dict(pdf)
    except pikepdf.PasswordError as e:
        raise ValueError("Sai mật khẩu — không đọc được metadata.") from e


def write_pdf_metadata(
    source_path: str,
    output_path: str,
    *,
    fields: dict | None = None,
    clear_all: bool = False,
    password: str = "",
) -> str:
    """Update or clear PDF Info metadata in-place (preserves Outlines / structure)."""
    fields = fields or {}
    open_kw: dict = {"password": password or ""}
    if os.path.abspath(source_path) == os.path.abspath(output_path):
        open_kw["allow_overwriting_input"] = True
    try:
        with pikepdf.Pdf.open(source_path, **open_kw) as pdf:
            if clear_all:
                try:
                    for k in list(pdf.docinfo.keys()):
                        del pdf.docinfo[k]
                except Exception:
                    pass
                for key in _META_KEYS:
                    try:
                        del pdf.docinfo[pikepdf.Name(f"/{key}")]
                    except Exception:
                        pass
            else:
                for key in _META_KEYS:
                    if key not in fields:
                        continue
                    val = fields.get(key)
                    name = pikepdf.Name(f"/{key}")
                    if val is None or str(val).strip() == "":
                        try:
                            if name in pdf.docinfo:
                                del pdf.docinfo[name]
                        except Exception:
                            pass
                    else:
                        pdf.docinfo[name] = str(val)

            save_pdf_compat(pdf, output_path)
    except pikepdf.PasswordError as e:
        raise ValueError("Sai mật khẩu — không ghi được metadata.") from e

    return output_path
