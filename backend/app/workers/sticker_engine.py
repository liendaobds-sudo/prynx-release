import cv2
import numpy as np
import pypdfium2 as pdfium
import pikepdf
import io
import os
import zlib
import math
from shapely.geometry import Polygon, MultiPolygon
from shapely.ops import unary_union
import logging
from app.workers.shape_analyzer import ShapeType
import json

logger = logging.getLogger(__name__)


# Hàm hình học đường cắt được tách sang module nhẹ (không deps nặng) để test được.
# Re-export ở đây để giữ tương thích với code cũ import từ sticker_engine.
from app.workers.cutline_geometry import (  # noqa: E402
    build_contour_path_stream,
    _coords_to_bezier_stream,
    _coords_to_polyline_stream,
)


class StickerEngine:
    def __init__(self, dpi: int = 300, debug: bool = False):
        self.dpi = dpi
        self.scale = dpi / 72.0
        # Khi False (mặc định/production): KHÔNG ghi ảnh debug ra đĩa & KHÔNG log spam.
        # Bật qua tham số hoặc biến môi trường STICKER_DEBUG=1.
        self.debug = debug or os.environ.get("STICKER_DEBUG", "").lower() in ("1", "true", "yes")

    def process_pdf(
        self,
        input_path: str,
        output_path: str,
        cut_mode: str = "original",
        offset_mm: float = 0.0,
        corner_style: str = "round",
        cut_color: tuple = (0, 1, 0, 0),  
        bleed_mm: float = 0.0,
        fill_holes: bool = True,
        remove_white_bg: bool = False,
        bleed_color_type: str = "image", 
        solid_bleed_color: tuple = (255, 255, 255), 
        draw_cut_contour: bool = True
    ) -> tuple:
        debug_step = "Init"
        doc_in_pdfium = None
        doc_in_pike = None
        doc_out = None
        try:
            debug_step = "Open Original PDF"
            doc_in_pdfium = pdfium.PdfDocument(input_path)
            doc_in_pike = pikepdf.Pdf.open(input_path)
            
            debug_step = "Create Output PDF"
            doc_out = pikepdf.Pdf.new()
            
            debug_step = "Inject Spot Color Definition"
            c, m, y, k = cut_color
            func_dict = doc_out.make_indirect(pikepdf.Dictionary({
                '/FunctionType': 2,
                '/Domain': [0.0, 1.0],
                '/C0': [0.0, 0.0, 0.0, 0.0],
                '/C1': [c, m, y, k],
                '/N': 1.0
            }))

            cs_arr = pikepdf.Array([pikepdf.Name.Separation, pikepdf.Name.CutContour, pikepdf.Name.DeviceCMYK, func_dict])
            
            mm_to_pts = 2.83465
            offset_pts = offset_mm * mm_to_pts
            bleed_pts = bleed_mm * mm_to_pts
            
            all_pages_meta = []
            
            for page_idx in range(len(doc_in_pdfium)):
                debug_step = f"Rasterize Page {page_idx}"
                page_in = doc_in_pdfium[page_idx]
                page_in_pike = doc_in_pike.pages[page_idx]

                # ── Chặn OOM: giới hạn độ phân giải raster theo kích thước trang ──
                # Khổ tem nhỏ vẫn render full DPI; sheet lớn (SRA3+) tự hạ scale để
                # cạnh dài ≲ MAX_LONG_PX và tổng ≲ MAX_MEGAPIXELS, tránh treo/hết RAM.
                MAX_LONG_PX = 6000
                MAX_MEGAPIXELS = 40_000_000
                base_scale = self.dpi / 72.0
                try:
                    pw_pt, ph_pt = page_in.get_size()
                except Exception:
                    pw_pt, ph_pt = 0, 0
                shrink = 1.0
                if pw_pt and ph_pt:
                    est_w, est_h = pw_pt * base_scale, ph_pt * base_scale
                    long_px = max(est_w, est_h)
                    if long_px > MAX_LONG_PX:
                        shrink = min(shrink, MAX_LONG_PX / long_px)
                    mp = est_w * est_h
                    if mp > MAX_MEGAPIXELS:
                        shrink = min(shrink, (MAX_MEGAPIXELS / mp) ** 0.5)
                self.scale = base_scale * shrink
                if shrink < 1.0 and self.debug:
                    logger.warning(">>> DPI CAP page %d: scale %.4f→%.4f (page %.0fx%.0f pt)", page_idx, base_scale, self.scale, pw_pt, ph_pt)

                bitmap = page_in.render(scale=self.scale)
                img_bgra = bitmap.to_numpy()
                img = cv2.cvtColor(img_bgra, cv2.COLOR_BGRA2RGBA)
                img_native = cv2.cvtColor(img_bgra, cv2.COLOR_BGRA2RGB)
                
                has_alpha = img.shape[2] == 4 and img[:, :, 3].min() < 255
                if page_idx == 0 and self.debug:
                    logger.warning(">>> PARAMS: cut_mode=%s offset_mm=%.2f bleed_mm=%.2f corner_style=%s remove_white_bg=%s bleed_color_type=%s fill_holes=%s", cut_mode, offset_mm, bleed_mm, corner_style, remove_white_bg, bleed_color_type, fill_holes)
                    logger.warning(">>> IMAGE: shape=%s has_alpha=%s", img.shape, has_alpha)
                
                if has_alpha:
                    base_mask = img[:, :, 3].copy()
                else:
                    if remove_white_bg:
                        hsv = cv2.cvtColor(img[:,:,:3], cv2.COLOR_RGB2HSV)
                        lower_white = np.array([0, 0, 200])
                        upper_white = np.array([180, 30, 255])
                        white_mask = cv2.inRange(hsv, lower_white, upper_white)
                        base_mask = cv2.bitwise_not(white_mask)
                    else:
                        base_mask = np.ones(img.shape[:2], dtype=np.uint8) * 255
                
                if remove_white_bg:
                    fringe_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
                    base_mask = cv2.erode(base_mask, fringe_kernel)
                    
                raw_mask = base_mask.copy()
                    
                if fill_holes:
                    contours_mask, _ = cv2.findContours(base_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                    cv2.drawContours(base_mask, contours_mask, -1, 255, cv2.FILLED)

                _, mask = cv2.threshold(base_mask, 10, 255, cv2.THRESH_BINARY)

                blur_size = 7 if corner_style == "round" else 1
                if blur_size > 1:
                    aa_mask = cv2.GaussianBlur(mask, (blur_size, blur_size), 0)
                else:
                    aa_mask = mask.copy()
                    clean_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
                    aa_mask = cv2.morphologyEx(aa_mask, cv2.MORPH_OPEN, clean_kernel)
                    aa_mask = cv2.morphologyEx(aa_mask, cv2.MORPH_CLOSE, clean_kernel)
                
                aa_mask_padded = np.pad(aa_mask, pad_width=1, mode='constant', constant_values=0)
                
                debug_step = f"Find Contours Page {page_idx}"
                from skimage import measure
                contours = measure.find_contours(aa_mask_padded, 127.5)
                
                page_in_width = float(page_in_pike.mediabox[2] - page_in_pike.mediabox[0])
                page_in_height = float(page_in_pike.mediabox[3] - page_in_pike.mediabox[1])
                
                if cut_mode == "none":
                    max_expansion_pts = bleed_pts
                else:
                    # bleed extends bleed_pts beyond the cut line (cut = bleed+offset from artwork)
                    cut_line_offset = bleed_pts + offset_pts if bleed_pts > 0 else offset_pts
                    bleed_outer_extent = abs(cut_line_offset) + bleed_pts if bleed_pts > 0 else abs(offset_pts)
                    max_expansion_pts = max(abs(offset_pts), bleed_outer_extent, bleed_pts) + 50
                new_width = page_in_width + 2 * max_expansion_pts
                new_height = page_in_height + 2 * max_expansion_pts
                
                page_out = doc_out.add_blank_page(page_size=(new_width, new_height))
                
                bleed_stream_data = None
                mask_bytes_data = None
                img_pil = None
                bleed_ring = None
                is_bleed_cmyk = False
                
                # ============================================================
                # STEP A: Compute dieline_poly FIRST (needed for bleed mask)
                # ============================================================
                dieline_poly = None
                cut_poly = None
                bleed_outer_poly = None
                dieline_polygons = []
                total_offset = 0
                bleed_outer_offset = 0
                
                if cut_mode != "none" and len(contours) > 0:
                    debug_step = f"Process Contours Page {page_idx}"
                    poly_scale = 1.0 / self.scale
                    
                    raw_polys = []
                    for contour in contours:
                        contour = contour - 1
                        contour_pts = contour[:, [1, 0]] * poly_scale
                        
                        if len(contour_pts) >= 10:
                            window = min(200, max(15, len(contour_pts) // 30))
                            padded = np.pad(contour_pts, ((window, window), (0, 0)), mode='wrap')
                            kernel = np.ones(window) / window
                            sm_x = np.convolve(padded[:, 0], kernel, mode='same')
                            sm_y = np.convolve(padded[:, 1], kernel, mode='same')
                            contour_pts = np.column_stack((sm_x[window:-window], sm_y[window:-window]))

                        if len(contour_pts) >= 3:
                            poly = Polygon(contour_pts)
                            if poly.is_valid:
                                # KHÔNG nén điểm ở đây nữa! Nếu nén ở đây, hàm buffer() ở dưới sẽ khóa cứng các đường thẳng.
                                # Chỉ dọn dẹp nhẹ để giữ topology
                                poly = poly.simplify(0.1, preserve_topology=True)
                                raw_polys.append(poly)
                                
                    if raw_polys:
                        holes = []
                        exteriors = []
                        for p in raw_polys:
                            is_hole = False
                            pb = p.bounds
                            for other in raw_polys:
                                if p != other:
                                    ob = other.bounds
                                    if ob[0] <= pb[0] and ob[1] <= pb[1] and ob[2] >= pb[2] and ob[3] >= pb[3]:
                                        if other.contains(p):
                                            is_hole = True
                                            break
                            if is_hole:
                                holes.append(p)
                            else:
                                exteriors.append(p)
                                
                        base_dieline = unary_union(exteriors)
                        if not fill_holes:
                            for h in holes:
                                base_dieline = base_dieline.difference(h)
                        
                        # Save artwork shape for clipping (expanded to avoid clipping artwork edges)
                        
                        if cut_mode in ("bleed", "none") and bleed_pts > 0:
                            total_offset = bleed_pts + offset_pts  # Cut line position
                        else:
                            total_offset = offset_pts
                            
                        join_style = 1 if corner_style == "round" else 2
                        
                        # dieline_poly = CUT LINE position
                        if total_offset != 0:
                            dieline_poly = base_dieline.buffer(total_offset, join_style=join_style)
                            if total_offset < 0:
                                dieline_poly = dieline_poly.buffer(0.01, join_style=join_style)
                        else:
                            dieline_poly = base_dieline
                        
                        # bleed_outer_poly = bleed extends bleed_pts OUTWARD from cut line
                        # So bleed is ALWAYS outside the cut line, even with negative offset
                        bleed_outer_offset = total_offset + bleed_pts
                        if bleed_outer_offset != 0:
                            bleed_outer_poly = base_dieline.buffer(bleed_outer_offset, join_style=join_style)
                        else:
                            bleed_outer_poly = base_dieline
                        
                        if fill_holes:
                            if dieline_poly.geom_type == 'MultiPolygon':
                                dieline_poly = MultiPolygon([Polygon(p.exterior) for p in dieline_poly.geoms])
                            elif dieline_poly.geom_type == 'Polygon':
                                dieline_poly = Polygon(dieline_poly.exterior)
                            if bleed_outer_poly.geom_type == 'MultiPolygon':
                                bleed_outer_poly = MultiPolygon([Polygon(p.exterior) for p in bleed_outer_poly.geoms])
                            elif bleed_outer_poly.geom_type == 'Polygon':
                                bleed_outer_poly = Polygon(bleed_outer_poly.exterior)

                        # cut_poly = dieline_poly nhưng đã được nén (1.0 pt) để dọn dẹp điểm thừa mà vẫn giữ form cong chuẩn
                        if isinstance(dieline_poly, MultiPolygon):
                            cut_poly = MultiPolygon([p.simplify(1.0, preserve_topology=False) for p in dieline_poly.geoms])
                        else:
                            cut_poly = dieline_poly.simplify(1.0, preserve_topology=False)

                # ============================================================
                # STEP B: Generate bleed using dieline_poly for perfect alignment
                # ============================================================
                if bleed_mm > 0.0:
                    debug_step = f"Generate Bleed Page {page_idx}"
                    bleed_px = math.ceil(bleed_mm * (self.dpi / 25.4))
                    if bleed_px > 0:
                        kernel_type = cv2.MORPH_ELLIPSE if (corner_style == "round" and cut_mode != "none") else cv2.MORPH_RECT
                        
                        # Determine pad_b: must be large enough for the bleed outer boundary
                        if bleed_outer_poly is not None and not getattr(bleed_outer_poly, 'is_empty', True):
                            pad_b = math.ceil(abs(bleed_outer_offset) * self.scale) + 2
                        elif dieline_poly is not None and not getattr(dieline_poly, 'is_empty', True):
                            pad_b = math.ceil(abs(total_offset) * self.scale) + 2
                        else:
                            pad_b = bleed_px
                        # Ensure pad_b is at least bleed_px
                        pad_b = max(pad_b, bleed_px)
                        
                        _, aa_mask_bin = cv2.threshold(aa_mask, 127, 255, cv2.THRESH_BINARY)
                        padded_mask = np.pad(aa_mask_bin, pad_width=pad_b, mode='constant', constant_values=0)
                        
                        # Original (unsmoothed) mask for bleed_ring inner boundary
                        # Prevents bleed from entering artwork at smoothing-shrunken edges
                        padded_original_mask = np.pad(mask, pad_width=pad_b, mode='constant', constant_values=0)
                        
                        _, raw_mask_bin = cv2.threshold(raw_mask, 10, 255, cv2.THRESH_BINARY)
                        padded_raw_mask = np.pad(raw_mask_bin, pad_width=pad_b, mode='constant', constant_values=0)
                        
                        # Check if CMYK (simple heuristic)
                        is_cmyk = False
                        
                        if is_cmyk:
                            padded_img = np.pad(img_native, pad_width=((pad_b, pad_b), (pad_b, pad_b), (0, 0)), mode='constant', constant_values=0)
                        else:
                            padded_img = np.pad(img_native, pad_width=((pad_b, pad_b), (pad_b, pad_b), (0, 0)), mode='constant', constant_values=255)
                        
                        inset_px = int(0.15 * (self.dpi / 25.4))
                        if inset_px < 1: inset_px = 1
                        inset_kernel = cv2.getStructuringElement(kernel_type, (inset_px*2+1, inset_px*2+1))
                        color_source_mask = cv2.erode(padded_original_mask, inset_kernel)
                        
                        # Generate bleed_mask from bleed_outer_poly (extends BEYOND cut line)
                        if bleed_outer_poly is not None and not getattr(bleed_outer_poly, 'is_empty', True):
                            if self.debug:
                                logger.warning(">>> RASTERIZE METHOD: Using bleed_outer_poly to generate bleed_mask (pad_b=%d, bleed_outer_offset=%.2f, scale=%.4f)", pad_b, bleed_outer_offset, self.scale)
                            mask_h, mask_w = padded_mask.shape
                            bleed_mask = np.zeros((mask_h, mask_w), dtype=np.uint8)
                            
                            def _rasterize_poly(poly_geom, target_mask, scale, pad):
                                if isinstance(poly_geom, MultiPolygon):
                                    for p in poly_geom.geoms:
                                        _rasterize_poly(p, target_mask, scale, pad)
                                    return
                                ext = np.array(poly_geom.exterior.coords)
                                ext_px = np.column_stack([
                                    ext[:, 0] * scale + pad,
                                    ext[:, 1] * scale + pad
                                ]).astype(np.int32)
                                cv2.fillPoly(target_mask, [ext_px], 255)
                                for interior in poly_geom.interiors:
                                    int_coords = np.array(interior.coords)
                                    int_px = np.column_stack([
                                        int_coords[:, 0] * scale + pad,
                                        int_coords[:, 1] * scale + pad
                                    ]).astype(np.int32)
                                    cv2.fillPoly(target_mask, [int_px], 0)
                            
                            _rasterize_poly(bleed_outer_poly, bleed_mask, self.scale, pad_b)
                            # 1px safety dilate to cover sub-pixel rounding at polygon edges
                            raster_safety = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
                            bleed_mask = cv2.dilate(bleed_mask, raster_safety)

                            if self.debug:
                                logger.warning(">>> RASTERIZE DONE: bleed_mask nonzero=%d, padded_mask nonzero=%d", np.count_nonzero(bleed_mask), np.count_nonzero(padded_mask))
                                try:
                                    debug_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'debug_output')
                                    os.makedirs(debug_dir, exist_ok=True)
                                    debug_img = np.zeros((mask_h, mask_w, 3), dtype=np.uint8)
                                    debug_img[bleed_mask > 0] = [0, 255, 0]  # Green = bleed area
                                    debug_img[padded_mask > 0] = [255, 255, 255]  # White = artwork
                                    cv2.imwrite(os.path.join(debug_dir, 'debug_bleed_mask.png'), debug_img)
                                    logger.warning(">>> DEBUG IMAGE SAVED to %s", debug_dir)
                                except Exception as e:
                                    logger.warning(">>> DEBUG IMAGE FAILED: %s", e)
                        else:
                            if self.debug:
                                logger.warning(">>> FALLBACK METHOD: Using cv2.dilate (no dieline_poly)")
                            kernel = cv2.getStructuringElement(kernel_type, (bleed_px*2+1, bleed_px*2+1))
                            bleed_mask = cv2.dilate(padded_mask, kernel)
                        
                        if fill_holes:
                            # Fill any holes/bays that were bridged so the bleed color covers everything inside.
                            b_contours, _ = cv2.findContours(bleed_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                            cv2.drawContours(bleed_mask, b_contours, -1, 255, cv2.FILLED)
                            
                        # Create "sticker footprint" - a SOLID mask covering the entire sticker
                        # including internal white gaps (between rainbow arcs, inside letters, etc.)
                        # This prevents bleed from appearing in internal white areas of the design.
                        close_px = max(10, int(1.5 * (self.dpi / 25.4)))  # ~1.5mm closing radius
                        close_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close_px*2+1, close_px*2+1))
                        closed_mask = cv2.morphologyEx(padded_original_mask, cv2.MORPH_CLOSE, close_kernel)
                        foot_contours, _ = cv2.findContours(closed_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                        sticker_footprint = np.zeros_like(padded_original_mask)
                        cv2.drawContours(sticker_footprint, foot_contours, -1, 255, cv2.FILLED)
                        
                        # bleed_ring = area between sticker footprint and cut line
                        bleed_ring = cv2.subtract(bleed_mask, sticker_footprint)
                        
                        is_bleed_cmyk = False
                        if bleed_color_type == "image":
                            from scipy.ndimage import distance_transform_edt
                            bg_mask = (color_source_mask == 0)
                            dist, indices = distance_transform_edt(bg_mask, return_indices=True)
                            bleed_colors = padded_img[indices[0], indices[1], :]
                        elif bleed_color_type == "inpaint":
                            # Pre-fill padding area with nearest artwork colors to prevent
                            # white fringe from the white padding pixels biasing cv2.inpaint
                            from scipy.ndimage import distance_transform_edt
                            bg_fill = (padded_mask == 0)
                            _, fill_indices = distance_transform_edt(bg_fill, return_indices=True)
                            padded_img_filled = padded_img.copy()
                            padded_img_filled[bg_fill] = padded_img[fill_indices[0][bg_fill], fill_indices[1][bg_fill]]
                            
                            mask_for_inpaint = cv2.subtract(bleed_mask, color_source_mask)
                            inpainted = cv2.inpaint(padded_img_filled, mask_for_inpaint, 3, cv2.INPAINT_NS)
                            bleed_colors = inpainted
                        else:
                            if len(solid_bleed_color) == 4:
                                is_bleed_cmyk = True
                                bg_canvas = np.zeros((padded_img.shape[0], padded_img.shape[1], 4), dtype=np.uint8)
                                bg_canvas[:] = solid_bleed_color
                            else:
                                bg_canvas = np.zeros_like(padded_img)
                                bg_canvas[:] = solid_bleed_color
                            bleed_colors = bg_canvas
                            
                        if is_bleed_cmyk:
                            bleed_result = np.zeros((padded_img.shape[0], padded_img.shape[1], 4), dtype=np.uint8)
                        else:
                            bleed_result = np.zeros_like(padded_img)
                            
                        bleed_result[bleed_ring > 0] = bleed_colors[bleed_ring > 0]
                        
                        bleed_rgb = bleed_result # It's already RGB (or CMYK)
                        
                        from PIL import Image
                        if is_bleed_cmyk:
                            # Solid CMYK compresses extremely well with zlib and avoids Adobe JPEG inversion bugs
                            bleed_stream_data = zlib.compress(bleed_rgb.tobytes())
                            img_w, img_h = bleed_rgb.shape[1], bleed_rgb.shape[0]
                        else:
                            img_byte_arr = io.BytesIO()
                            img_pil = Image.fromarray(bleed_rgb, mode='RGB')
                            img_pil.save(img_byte_arr, format='JPEG', quality=90)
                            bleed_stream_data = img_byte_arr.getvalue()
                            img_w, img_h = img_pil.width, img_pil.height
                            
                        mask_bytes_data = zlib.compress(bleed_ring.tobytes())
                        
                        # Save comprehensive debug images for first page
                        if page_idx == 0 and self.debug:
                            try:
                                debug_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'debug_output')
                                os.makedirs(debug_dir, exist_ok=True)
                                cv2.imwrite(os.path.join(debug_dir, 'debug_bleed_ring.png'), bleed_ring)
                                cv2.imwrite(os.path.join(debug_dir, 'debug_bleed_result.png'), cv2.cvtColor(bleed_result[:,:,:3], cv2.COLOR_RGB2BGR) if not is_bleed_cmyk else bleed_result)
                                cv2.imwrite(os.path.join(debug_dir, 'debug_padded_mask.png'), padded_mask)
                                cv2.imwrite(os.path.join(debug_dir, 'debug_sticker_footprint.png'), sticker_footprint)
                                logger.warning(">>> BLEED DEBUG: bleed_ring nonzero=%d, bleed_result mean=%s, bleed_color_type=%s", np.count_nonzero(bleed_ring), np.mean(bleed_result[bleed_ring > 0], axis=0) if np.count_nonzero(bleed_ring) > 0 else 'N/A', bleed_color_type)
                            except Exception as e:
                                logger.warning(">>> BLEED DEBUG FAILED: %s", e)

                page_content_stream = []

                # LAYER 1 (BOTTOM): Bleed color with SMask
                if bleed_stream_data:
                    img_w_pt = float(img_w) / self.scale
                    img_h_pt = float(img_h) / self.scale
                    
                    mask_obj = pikepdf.Stream(doc_out, mask_bytes_data)
                    mask_obj.Type = pikepdf.Name.XObject
                    mask_obj.Subtype = pikepdf.Name.Image
                    mask_obj.Width = bleed_ring.shape[1]
                    mask_obj.Height = bleed_ring.shape[0]
                    mask_obj.ColorSpace = pikepdf.Name.DeviceGray
                    mask_obj.BitsPerComponent = 8
                    mask_obj.Filter = pikepdf.Name.FlateDecode
                    
                    img_obj = pikepdf.Stream(doc_out, bleed_stream_data)
                    img_obj.Type = pikepdf.Name.XObject
                    img_obj.Subtype = pikepdf.Name.Image
                    img_obj.Width = img_w
                    img_obj.Height = img_h
                    img_obj.ColorSpace = pikepdf.Name.DeviceCMYK if is_bleed_cmyk else pikepdf.Name.DeviceRGB
                    img_obj.BitsPerComponent = 8
                    img_obj.Filter = pikepdf.Name.FlateDecode if is_bleed_cmyk else pikepdf.Name.DCTDecode
                    img_obj.SMask = mask_obj
                    
                    img_name = page_out.add_resource(img_obj, pikepdf.Name.XObject)
                    
                    shift_x = max_expansion_pts - (pad_b / self.scale)
                    shift_y = max_expansion_pts - (pad_b / self.scale)
                    
                    page_content_stream.append("q")
                    page_content_stream.append(f"{img_w_pt:.4f} 0 0 {img_h_pt:.4f} {shift_x:.4f} {shift_y:.4f} cm")
                    page_content_stream.append(f"{str(img_name)} Do")
                    page_content_stream.append("Q")

                # LAYER 2 (TOP): Original artwork with transparency mask
                if bleed_stream_data and padded_original_mask is not None:
                    # Use raster artwork with SMask to make white bg transparent
                    # This preserves artwork content while allowing bleed to show through
                    from PIL import Image as PILImage
                    art_byte_arr = io.BytesIO()
                    art_pil = PILImage.fromarray(padded_img, mode='RGB')
                    art_pil.save(art_byte_arr, format='JPEG', quality=95)
                    art_stream_data = art_byte_arr.getvalue()
                    
                    art_mask_data = zlib.compress(sticker_footprint.tobytes())
                    art_mask_obj = pikepdf.Stream(doc_out, art_mask_data)
                    art_mask_obj.Type = pikepdf.Name.XObject
                    art_mask_obj.Subtype = pikepdf.Name.Image
                    art_mask_obj.Width = sticker_footprint.shape[1]
                    art_mask_obj.Height = sticker_footprint.shape[0]
                    art_mask_obj.ColorSpace = pikepdf.Name.DeviceGray
                    art_mask_obj.BitsPerComponent = 8
                    art_mask_obj.Filter = pikepdf.Name.FlateDecode
                    
                    art_obj = pikepdf.Stream(doc_out, art_stream_data)
                    art_obj.Type = pikepdf.Name.XObject
                    art_obj.Subtype = pikepdf.Name.Image
                    art_obj.Width = art_pil.width
                    art_obj.Height = art_pil.height
                    art_obj.ColorSpace = pikepdf.Name.DeviceRGB
                    art_obj.BitsPerComponent = 8
                    art_obj.Filter = pikepdf.Name.DCTDecode
                    art_obj.SMask = art_mask_obj
                    
                    art_name = page_out.add_resource(art_obj, pikepdf.Name.XObject)
                    
                    page_content_stream.append("q")
                    page_content_stream.append(f"{img_w_pt:.4f} 0 0 {img_h_pt:.4f} {shift_x:.4f} {shift_y:.4f} cm")
                    page_content_stream.append(f"{str(art_name)} Do")
                    page_content_stream.append("Q")
                else:
                    # No bleed: use original form XObject (preserves vector quality)
                    src_xobj = page_in_pike.as_form_xobject()
                    src_xobj_name = page_out.add_resource(src_xobj, pikepdf.Name.XObject)
                    
                    page_content_stream.append("q")
                    page_content_stream.append(f"1 0 0 1 {max_expansion_pts:.4f} {max_expansion_pts:.4f} cm")
                    page_content_stream.append(f"{str(src_xobj_name)} Do")
                    page_content_stream.append("Q")



                if draw_cut_contour and cut_mode != "none" and cut_poly is not None and not getattr(cut_poly, 'is_empty', True):
                    debug_step = "Draw Cut Contour"
                    
                    page_content_stream.append("q")
                    page_content_stream.append(f"1 0 0 1 {max_expansion_pts:.4f} {max_expansion_pts:.4f} cm")
                    
                    page_content_stream.append("/CutContour CS")
                    page_content_stream.append("1.0 SCN")
                    page_content_stream.append("1.0 w")

                    geoms = cut_poly.geoms if isinstance(cut_poly, MultiPolygon) else [cut_poly]
                    for p in geoms:
                        coords = list(p.exterior.coords)
                        if coords:
                            page_content_stream.extend(build_contour_path_stream(coords, page_in_height, corner_style))
                        for inter in p.interiors:
                            icoords = list(inter.coords)
                            if icoords:
                                page_content_stream.extend(build_contour_path_stream(icoords, page_in_height, corner_style))

                    page_content_stream.append("S")
                    page_content_stream.append("Q")

                full_content = "\n".join(page_content_stream).encode('ascii')
                page_out.contents_add(pikepdf.Stream(doc_out, full_content))
                
                if "/Resources" not in page_out:
                    page_out.Resources = pikepdf.Dictionary()
                if "/ColorSpace" not in page_out.Resources:
                    page_out.Resources.ColorSpace = pikepdf.Dictionary()
                page_out.Resources.ColorSpace.CutContour = cs_arr
                
                page_meta = {}
                if dieline_poly is not None and not getattr(dieline_poly, 'is_empty', True):
                    minx, miny, maxx, maxy = dieline_poly.bounds
                    pdf_miny = page_in_height - maxy
                    pdf_maxy = page_in_height - miny
                    
                    minx += max_expansion_pts
                    pdf_miny += max_expansion_pts
                    maxx += max_expansion_pts
                    pdf_maxy += max_expansion_pts
                    
                    box_arr = pikepdf.Array([minx, pdf_miny, maxx, pdf_maxy])
                    page_out.TrimBox = box_arr
                    page_out.ArtBox = box_arr
                    
                    # Generate Meta for this page.
                    # Dùng bounds GỐC của dieline_poly (trước khi cộng max_expansion_pts)
                    # để raster shape_mask phục vụ nhận diện hình dạng.
                    scale = 300.0 / 72.0
                    minx_orig, miny_orig, maxx_orig, maxy_orig = dieline_poly.bounds
                    width_pt = maxx_orig - minx_orig
                    height_pt = maxy_orig - miny_orig
                    width_mm = width_pt * (25.4 / 72.0)
                    height_mm = height_pt * (25.4 / 72.0)
                    mask_w = int(np.ceil(width_pt * scale))
                    mask_h = int(np.ceil(height_pt * scale))
                    shape_mask = np.zeros((mask_h, mask_w), dtype=np.uint8)
                    
                    def fill_poly(poly_geom):
                        if poly_geom.is_empty: return
                        if isinstance(poly_geom, MultiPolygon):
                            for p in poly_geom.geoms: fill_poly(p)
                            return
                        exterior = np.array([[(c[0] - minx_orig) * scale, (c[1] - miny_orig) * scale] for c in poly_geom.exterior.coords], dtype=np.int32)
                        cv2.fillPoly(shape_mask, [exterior], color=255)
                        for interior in poly_geom.interiors:
                            inter = np.array([[(c[0] - minx_orig) * scale, (c[1] - miny_orig) * scale] for c in interior.coords], dtype=np.int32)
                            cv2.fillPoly(shape_mask, [inter], color=0)
                    
                    fill_poly(cut_poly if cut_poly is not None else dieline_poly)
                    
                    from app.workers.shape_analyzer import detect_shape, extract_shape_properties
                    shape_type_enum = detect_shape(shape_mask)
                    shape_type_str = shape_type_enum.name
                    shape_params = extract_shape_properties(shape_mask)
                    
                    if shape_type_enum == ShapeType.HAMMER:
                        shape_params['effective_body_w_ratio'] = shape_params.get('bigEndAxisFrac', 0.37)
                    elif shape_type_enum == ShapeType.DUMBBELL:
                        shape_params['effective_body_w_ratio'] = shape_params.get('bigEndAxisFrac', 0.65)
                        
                    shape_params_str = json.dumps(shape_params)
                    
                    boxes = []
                    _meta_poly = cut_poly if cut_poly is not None else dieline_poly
                    geoms = _meta_poly.geoms if isinstance(_meta_poly, MultiPolygon) else [_meta_poly]
                    for p in geoms:
                        p_minx, p_miny, p_maxx, p_maxy = p.bounds
                        p_w_pt = p_maxx - p_minx
                        p_h_pt = p_maxy - p_miny
                        boxes.append({
                            "x_pt": round(p_minx, 2),
                            "y_pt": round(p_miny, 2),
                            "w_pt": round(p_w_pt, 2),
                            "h_pt": round(p_h_pt, 2),
                            "w_mm": round(p_w_pt * 25.4 / 72.0, 2),
                            "h_mm": round(p_h_pt * 25.4 / 72.0, 2)
                        })
                    
                    page_meta = {
                        "width_mm": round(width_mm, 2),
                        "height_mm": round(height_mm, 2),
                        "boxes": boxes,
                        "shape_type": shape_type_str,
                        "shape_params": shape_params_str
                    }
                
                all_pages_meta.append(page_meta)
                    
            debug_step = "Save Output PDF"
            doc_out.save(output_path)

            # Watermark (stealth) được áp ở tầng route qua _safe_watermark(license_info),
            # nhất quán với các endpoint pdf-tools khác. Engine KHÔNG có thông tin license
            # nên không tự nhúng ở đây (trước đây gọi `settings` chưa định nghĩa → crash).

            # Instead of returning a single meta dict, we return a dict with a 'pages' array
            # And for backward compatibility, keep the first page's meta at the top level
            final_meta = {}
            if len(all_pages_meta) > 0 and all_pages_meta[0]:
                final_meta = all_pages_meta[0].copy()
            final_meta["pages"] = all_pages_meta
                
            return True, final_meta
            
        except Exception as e:
            logger.error(f"Sticker processing failed at {debug_step}: {e}", exc_info=True)
            raise RuntimeError(f"[{debug_step}] {str(e)}")
        finally:
            if doc_in_pdfium:
                try: doc_in_pdfium.close()
                except Exception: pass
            if doc_in_pike:
                try: doc_in_pike.close()
                except Exception: pass
            if doc_out:
                try: doc_out.close()
                except Exception: pass
