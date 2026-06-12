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

    out_doc.save(output_path)
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
                out.save(path)
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
                out.save(path)
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
            out.save(path)
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
            try:
                pages_to_resize = set(int(x.strip()) - 1 for x in apply_to.split(',') if x.strip().isdigit())
            except:
                pages_to_resize = set(range(total))

        for i in range(total):
            src_page = src.pages[i]
            
            if i in pages_to_resize:
                # Add a blank page with target dimensions
                new_page = out_doc.add_blank_page(page_size=(target_w, target_h))
                
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
                except:
                    src_w, src_h = 595.28, 841.89

                if scale_mode == 'fit':
                    scale_x = target_w / src_w
                    scale_y = target_h / src_h
                    scale = min(scale_x, scale_y)
                else:
                    # crop/fill
                    scale_x = target_w / src_w
                    scale_y = target_h / src_h
                    scale = max(scale_x, scale_y)
                
                new_w = src_w * scale
                new_h = src_h * scale
                offset_x = (target_w - new_w) / 2
                offset_y = (target_h - new_h) / 2
                
                # Inject Matrix drawing command
                content = f"q {scale:.4f} 0 0 {scale:.4f} {offset_x:.4f} {offset_y:.4f} cm {xobj_name_str} Do Q"
                new_page.contents_add(pikepdf.Stream(out_doc, content.encode('ascii')))
            else:
                out_doc.pages.append(src_page)

    out_doc.save(output_path)
    return output_path


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

        out_doc.save(output_path)
    return output_path
