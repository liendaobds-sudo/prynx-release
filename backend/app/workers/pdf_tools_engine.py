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
from typing import List, Tuple

MM_TO_PTS = 2.83465


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

def split_pdf(source_path: str, output_dir: str, mode: str = 'by_range',
              ranges: List[Tuple[int, int]] = None,
              pages_per_file: int = 1,
              page_list: List[int] = None,
              base_name: str = 'split') -> List[dict]:
    results = []
    os.makedirs(output_dir, exist_ok=True)

    with pikepdf.Pdf.open(source_path) as src:
        if mode == 'by_range' and ranges:
            for idx, (start, end) in enumerate(ranges):
                out = pikepdf.Pdf.new()
                from_page = max(0, start - 1)
                to_page = min(len(src.pages) - 1, end - 1)
                for i in range(from_page, to_page + 1):
                    out.pages.append(src.pages[i])
                fname = f"{base_name}_p{start}-{end}.pdf"
                path = os.path.join(output_dir, fname)
                save_pdf_compat(out, path)
                results.append({"filename": fname, "path": path, "pages": to_page - from_page + 1})

        elif mode == 'by_count':
            total = len(src.pages)
            chunk_idx = 0
            for start in range(0, total, pages_per_file):
                end = min(start + pages_per_file - 1, total - 1)
                out = pikepdf.Pdf.new()
                for i in range(start, end + 1):
                    out.pages.append(src.pages[i])
                fname = f"{base_name}_part{chunk_idx + 1}.pdf"
                path = os.path.join(output_dir, fname)
                save_pdf_compat(out, path)
                results.append({"filename": fname, "path": path, "pages": end - start + 1})
                chunk_idx += 1

        elif mode == 'extract_pages' and page_list:
            out = pikepdf.Pdf.new()
            for pg in sorted(page_list):
                idx = pg - 1
                if 0 <= idx < len(src.pages):
                    out.pages.append(src.pages[idx])
            fname = f"{base_name}_extracted.pdf"
            path = os.path.join(output_dir, fname)
            save_pdf_compat(out, path)
            results.append({"filename": fname, "path": path, "pages": len(out.pages)})

    return results


# =========================================================================
#  3. RESIZE
# =========================================================================

def resize_pages(source_path: str, output_path: str,
                 target_w_mm: float, target_h_mm: float,
                 scale_mode: str = 'fit',
                 apply_to: str = 'all') -> str:
    target_w = target_w_mm * MM_TO_PTS
    target_h = target_h_mm * MM_TO_PTS

    out_doc = pikepdf.Pdf.new()
    
    with pikepdf.Pdf.open(source_path) as src:
        total = len(src.pages)
        pages_to_resize = set()
        if apply_to == 'all':
            pages_to_resize = set(range(total))
        elif apply_to == 'even':
            pages_to_resize = set(range(1, total, 2))
        elif apply_to == 'odd':
            pages_to_resize = set(range(0, total, 2))
        else:
            # Parse danh sách trang tùy biến: hỗ trợ cả dải "a-b" lẫn số lẻ "n"
            # (1-based, inclusive) — đồng bộ với client parseRanges. Trước đây chỉ
            # nhận số lẻ (x.isdigit()) nên dải có dấu '-' bị bỏ âm thầm (audit fix).
            pages_to_resize = set()
            for part in apply_to.split(','):
                part = part.strip()
                if not part:
                    continue
                if '-' in part:
                    a, _, b = part.partition('-')
                    a, b = a.strip(), b.strip()
                    if a.isdigit():
                        start = int(a)
                        end = int(b) if b.isdigit() else total
                        for p in range(start, end + 1):
                            if 1 <= p <= total:
                                pages_to_resize.add(p - 1)
                elif part.isdigit():
                    p = int(part)
                    if 1 <= p <= total:
                        pages_to_resize.add(p - 1)

        for i in range(total):
            src_page = src.pages[i]
            
            if i in pages_to_resize:
                # Add a blank page with target dimensions
                new_page = out_doc.add_blank_page(page_size=(target_w, target_h))

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

                # Ép CropBox = MediaBox để chắc chắn BBox form = MediaBox (gồm trọn bleed).
                try:
                    src_page.CropBox = src_page.MediaBox
                except Exception:
                    pass

                # Copy foreign the source page as an XObject
                xobj = src_page.as_form_xobject()
                xobj_name = new_page.add_resource(xobj, pikepdf.Name.XObject)
                xobj_name_str = str(xobj_name)
                
                # Calculate scale and offset
                try:
                    # pikepdf mediabox is [llx, lly, urx, ury]
                    mb = src_page.mediabox
                    src_w = float(mb[2] - mb[0])
                    src_h = float(mb[3] - mb[1])
                except Exception:
                    src_w, src_h = 595.28, 841.89

                # 4 mode PHẢI khớp frontend PageResizer.ts (đường không-downsample):
                #  - fit: scale ĐỀU nhỏ nhất, vừa khít, có viền → KHÔNG cắt.
                #  - fill: scale ĐỀU lớn nhất, lấp đầy → CẮT phần thừa.
                #  - stretch (Ép bóp méo): scale X/Y RIÊNG → méo hình, KHÔNG cắt.
                #  - center_no_scale (Giữ nguyên ở giữa): scale=1, canh giữa.
                # Bug cũ: chỉ có fit + else(=fill) → stretch & center_no_scale RƠI vào
                # fill → phóng to giữ tỉ lệ + cắt mất hình (user báo "ép bóp méo mà lại
                # thu khung cắt hình").
                if scale_mode == 'fit':
                    scale = min(target_w / src_w, target_h / src_h)
                    scale_x = scale_y = scale
                elif scale_mode == 'stretch':
                    scale_x = target_w / src_w
                    scale_y = target_h / src_h
                elif scale_mode == 'center_no_scale':
                    scale_x = scale_y = 1.0
                else:
                    # fill/crop
                    scale = max(target_w / src_w, target_h / src_h)
                    scale_x = scale_y = scale

                new_w = src_w * scale_x
                new_h = src_h * scale_y
                offset_x = (target_w - new_w) / 2
                offset_y = (target_h - new_h) / 2

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
                    nx0, nx1 = max(0.0, min(nx0, nx1)), min(target_w, max(nx0, nx1))
                    ny0, ny1 = max(0.0, min(ny0, ny1)), min(target_h, max(ny0, ny1))
                    return [round(nx0, 3), round(ny0, 3), round(nx1, 3), round(ny1, 3)]

                for _bk, _box in _orig_boxes.items():
                    try:
                        new_page[pikepdf.Name(_bk)] = pikepdf.Array(_tx_box(_box))
                    except Exception:
                        pass
            else:
                out_doc.pages.append(src_page)

    save_pdf_compat(out_doc, output_path)
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
#   - mode='vector' (mặc định, AN TOÀN IN ẤN): resize hình học rồi Ghostscript
#     downsample ẢNH theo effective-DPI (giống PDF Optimizer của Acrobat). Giữ
#     nguyên vector/text/CMYK.
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


def _gs_downsample(input_path: str, output_path: str, target_dpi: int) -> bool:
    """Ghostscript downsample ảnh về target_dpi, GIỮ vector/text/CMYK. Trả True
    nếu thành công. Mọi lỗi (thiếu GS, GS fail) → False (caller fallback).

    Downsample của pdfwrite tính theo ĐỘ PHÂN GIẢI HIỆU DỤNG (pixel thực đặt trên
    trang) — sau khi resize A1→A5, ảnh có effective-DPI rất cao nên bị hạ mạnh."""
    from app.config import settings
    from app.utils.subprocess_utils import run_hidden
    import subprocess

    gs_path = getattr(settings, "GHOSTSCRIPT_PATH", None)
    if not gs_path or not os.path.isfile(gs_path):
        _pt_logger.warning("resize downsample: không tìm thấy Ghostscript (%r) → bỏ qua downsample.", gs_path)
        return False

    mono_dpi = min(int(target_dpi) * 2, 1200)
    cmd = [
        gs_path,
        "-dNOSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET",
        "-sDEVICE=pdfwrite",
        "-dAutoRotatePages=/None",
        "-dColorConversionStrategy=/LeaveColorUnchanged",  # KHÔNG đổi màu → giữ CMYK/spot
        "-dDownsampleColorImages=true",
        "-dColorImageDownsampleType=/Bicubic",
        f"-dColorImageResolution={int(target_dpi)}",
        "-dDownsampleGrayImages=true",
        "-dGrayImageDownsampleType=/Bicubic",
        f"-dGrayImageResolution={int(target_dpi)}",
        "-dDownsampleMonoImages=true",
        f"-dMonoImageResolution={mono_dpi}",
        "-dDetectDuplicateImages=true",  # ảnh lặp (poster) → gom 1 lần
        "-dCompatibilityLevel=1.6",
        f"-sOutputFile={output_path}",
        input_path,
    ]
    try:
        result = run_hidden(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1800)
        if result.returncode != 0 or not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
            _pt_logger.warning("resize downsample: Ghostscript trả mã %s → fallback.", getattr(result, "returncode", "?"))
            return False
        # Chuẩn hoá cấu trúc GS-output về xref cổ điển cho pdf-lib đọc được (chỉ
        # đổi CẤU TRÚC, KHÔNG đổi render). Lỗi chuẩn hoá → giữ nguyên GS-output.
        try:
            tmp = output_path + ".compat.pdf"
            with pikepdf.open(output_path) as _p:
                save_pdf_compat(_p, tmp)
            os.replace(tmp, output_path)
        except Exception as _e:  # noqa: BLE001
            _pt_logger.debug("Không chuẩn hoá được GS-output (giữ nguyên): %s", _e)
        return True
    except Exception as e:  # noqa: BLE001
        _pt_logger.warning("resize downsample: lỗi chạy Ghostscript (%s) → fallback.", e)
        return False


def _raster_resize(source_path: str, output_path: str,
                   target_w_mm: float, target_h_mm: float,
                   scale_mode: str, target_dpi: int) -> str:
    """Render mỗi trang ở đúng DPI đích rồi dựng lại PDF khổ mới (pypdfium2 + PIL).

    NHANH & NHỎ nhất cho trang thuần ảnh. Raster hoá → mất vector/text, ra RGB.
    Chỉ hỗ trợ apply_to='all' (caller đã đảm bảo)."""
    import pypdfium2 as pdfium
    from PIL import Image

    tw_pt = target_w_mm * MM_TO_PTS
    th_pt = target_h_mm * MM_TO_PTS
    px_w = max(1, round(target_w_mm / 25.4 * target_dpi))
    px_h = max(1, round(target_h_mm / 25.4 * target_dpi))

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
            canvas = Image.new("RGB", (px_w, px_h), "white")
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
                       target_dpi: int = 0, mode: str = "auto") -> str:
    """Resize trang + (tuỳ chọn) giảm dữ liệu theo khổ mới.

    target_dpi<=0 hoặc mode='xobject' → chỉ đổi hình học (hành vi cũ).
    Xem block chú thích 3b để biết các mode."""
    # Không downsample → hành vi cũ nguyên vẹn.
    if target_dpi <= 0 or mode == "xobject":
        return resize_pages(source_path, output_path, target_w_mm, target_h_mm, scale_mode, apply_to)

    chosen = mode
    if mode == "auto":
        chosen = _choose_auto_mode(
            apply_to=apply_to,
            has_text=_doc_has_text_fonts(source_path),
            has_non_rgb_images=_doc_has_non_rgb_images(source_path),
        )

    if chosen == "raster" and apply_to == "all":
        try:
            return _raster_resize(source_path, output_path, target_w_mm, target_h_mm, scale_mode, target_dpi)
        except Exception as e:  # noqa: BLE001
            _pt_logger.warning("raster resize lỗi (%s) → fallback sang vector.", e)
            chosen = "vector"

    # ── Vector: đổi hình học (XObject) rồi Ghostscript downsample ảnh ──
    tmp_geom = output_path + ".geom.pdf"
    resize_pages(source_path, tmp_geom, target_w_mm, target_h_mm, scale_mode, apply_to)
    try:
        if _gs_downsample(tmp_geom, output_path, int(target_dpi)):
            # Chỉ giữ kết quả downsample nếu THỰC SỰ nhỏ hơn; GS đôi khi phình file.
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
