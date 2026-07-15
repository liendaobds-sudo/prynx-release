import cv2
import numpy as np
import pypdfium2 as pdfium
import pikepdf
import io
import os
import zlib
import math
import time
import tempfile
from concurrent.futures import ProcessPoolExecutor
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


def _bleed_roi_bbox(mask, margin: int = 8):
    """Bounding box (y0, y1, x0, x1) của vùng mask>0, nới thêm `margin` px và
    kẹp trong biên ảnh. Trả None nếu mask rỗng.

    Dùng để giới hạn tính toán bleed (distance_transform_edt / cv2.inpaint)
    quanh mép hình thay vì chạy trên cả canvas (có nhiều vùng trống ở rìa).
    """
    ys, xs = np.where(mask > 0)
    if ys.size == 0:
        return None
    h, w = mask.shape[:2]
    y0 = max(0, int(ys.min()) - margin)
    y1 = min(h, int(ys.max()) + 1 + margin)
    x0 = max(0, int(xs.min()) - margin)
    x1 = min(w, int(xs.max()) + 1 + margin)
    return y0, y1, x0, x1


def _downscale_factor(h: int, w: int, max_dim: int = 1000) -> int:
    """Hệ số hạ mẫu để cạnh dài ≲ max_dim (1 = không hạ)."""
    longest = max(h, w)
    return int(math.ceil(longest / max_dim)) if longest > max_dim else 1


def _nearest_color_fill(sub_src, sub_img, max_dim: int = 4000):
    """Lấp màu nearest-neighbor từ vùng có màu (sub_src>0) ra toàn ROI
    ('Kéo giãn mép ảnh'). Chạy FULL-RES để giữ NÉT — nhân bản pixel mép vuông
    góc ra ngoài, không nội suy nên không mờ.

    Chỉ hạ mẫu khi ROI CỰC lớn (> max_dim, vd sheet SRA3+) để chặn OOM; khi đó
    dùng INTER_NEAREST ở CẢ hạ mẫu lẫn phóng lại (KHÔNG dùng INTER_AREA/LINEAR:
    chúng trộn trung bình pixel trắng+màu ở ranh giới → loang/mờ như bản cũ).
    """
    from scipy.ndimage import distance_transform_edt
    sh, sw = sub_src.shape[:2]
    f = _downscale_factor(sh, sw, max_dim)
    if f > 1:
        small_src = cv2.resize(sub_src, (max(1, sw // f), max(1, sh // f)), interpolation=cv2.INTER_NEAREST)
        if np.count_nonzero(small_src) > 0:
            small_img = cv2.resize(sub_img, (small_src.shape[1], small_src.shape[0]), interpolation=cv2.INTER_NEAREST)
            _, idx = distance_transform_edt(small_src == 0, return_indices=True)
            small_colors = small_img[idx[0], idx[1], :]
            return cv2.resize(small_colors, (sw, sh), interpolation=cv2.INTER_NEAREST)
    _, idx = distance_transform_edt(sub_src == 0, return_indices=True)
    return sub_img[idx[0], idx[1], :]


def _inpaint_color_fill(sub_img, sub_csm, sub_bleed, max_dim: int = 4000):
    """'Làm mượt thông minh' — seed nền từ color_source_mask (dải màu THẬT đã co
    vào trong, bỏ qua mép trắng) bằng nearest, rồi cv2.inpaint (NS) làm mượt mối
    nối màu trong vùng ring. Chạy FULL-RES cho ring hẹp (bleed 1-3mm = vài chục px)
    để giữ nét; chỉ hạ mẫu khi ROI CỰC lớn (chặn OOM), khi đó resize NEAREST ở CẢ
    hai chiều để không nội suy làm mờ.

    Sửa 2 bug bản cũ: (1) nền cũ lấp bằng pixel mép TRANG (thường TRẮNG với file
    không tràn lề) → inpaint hút trắng ngược vào ring = ra trắng/nhạt; nay seed từ
    csm (màu sâu bên trong). (2) hạ mẫu về ≤900px + INTER_AREA/LINEAR phóng lại →
    mờ; nay full-res + NEAREST.
    """
    from scipy.ndimage import distance_transform_edt
    sh, sw = sub_img.shape[:2]
    f = _downscale_factor(sh, sw, max_dim)
    if f > 1:
        nw, nh = max(1, sw // f), max(1, sh // f)
        s_img = cv2.resize(sub_img, (nw, nh), interpolation=cv2.INTER_NEAREST)
        s_csm = cv2.resize(sub_csm, (nw, nh), interpolation=cv2.INTER_NEAREST)
        s_bleed = cv2.resize(sub_bleed, (nw, nh), interpolation=cv2.INTER_NEAREST)
    else:
        s_img, s_csm, s_bleed = sub_img, sub_csm, sub_bleed

    # Seed sạch: mọi pixel NGOÀI color_source_mask lấp bằng màu csm gần nhất (màu
    # THẬT sâu bên trong, KHÔNG phải mép trắng). Đây là nền cho inpaint diffuse.
    src = (s_csm > 0)
    s_filled = s_img.copy()
    if src.any() and (~src).any():
        _, fi = distance_transform_edt(~src, return_indices=True)
        s_filled = s_img[fi[0], fi[1]]
    # Chỉ inpaint vùng ring (bleed NGOÀI csm) → NS diffuse màu từ biên csm ra, mượt.
    mask_for_inpaint = cv2.subtract(s_bleed, s_csm)
    out = cv2.inpaint(s_filled, mask_for_inpaint, 3, cv2.INPAINT_NS)
    if f > 1:
        out = cv2.resize(out, (sw, sh), interpolation=cv2.INTER_NEAREST)
    return out


def _rgb_to_cmyk(rgb):
    """Chuyển ảnh RGB (H,W,3) uint8 → CMYK (H,W,4) uint8, K=0 (không sinh đen).

    Dùng cho vành bù xén (bleed): màu bleed lấy từ ảnh pdfium render (RGB), nhưng
    artwork gốc + đầu ra in là CMYK. Ghi bleed ở DeviceRGB → RIP nong RGB→CMYK bằng
    phép KHÁC lúc raster → lệch màu ở mép nối bleed↔artwork. Nghịch đảo đơn giản
    C=255−R, M=255−G, Y=255−B, K=0 giữ ĐÚNG mặt CMY (không chèn đen vào màu nhạt như
    nền kem) → mép khớp màu. K=0 vì nền tem thường không có thành phần đen; đen/rich-
    black ở mép (hiếm với tem bế) sẽ thành CMY nặng nhưng vành bleed bị cắt bỏ nên
    không hại. Byte layout (C,M,Y,K straight, 0=không mực) khớp nhánh solid-CMYK.
    """
    h, w = rgb.shape[:2]
    cmyk = np.empty((h, w, 4), dtype=np.uint8)
    cmyk[:, :, 0] = 255 - rgb[:, :, 0]
    cmyk[:, :, 1] = 255 - rgb[:, :, 1]
    cmyk[:, :, 2] = 255 - rgb[:, :, 2]
    cmyk[:, :, 3] = 0
    return cmyk


def _band_tiles(band, band_radius: int, tile: int = 1024):
    """Sinh (crop_slice, core_slice) cho MỖI ô tile×tile GIAO với band.

    Mỗi ô lõi (core) là khối tile×tile; crop = core NỚI halo `band_radius` mọi phía
    (clamp trong biên). Chỉ trả ô mà band THỰC SỰ chạm (bỏ ô ruột → tăng tốc).
    core_slice trả về Ở TOẠ ĐỘ TUYỆT ĐỐI (để ghi vào out); kèm offset của core
    TRONG crop để driver ánh xạ index.

    Trả: (crop_y0, crop_y1, crop_x0, crop_x1, core_y0, core_y1, core_x0, core_x1).
    """
    ys, xs = np.where(band > 0)
    if ys.size == 0:
        return
    h, w = band.shape[:2]
    by0, by1 = int(ys.min()), int(ys.max()) + 1
    bx0, bx1 = int(xs.min()), int(xs.max()) + 1
    for cy0 in range(by0, by1, tile):
        cy1 = min(cy0 + tile, by1)
        for cx0 in range(bx0, bx1, tile):
            cx1 = min(cx0 + tile, bx1)
            # Bỏ ô nếu band không chạm khối core này (ô ruột) → không tính.
            if np.count_nonzero(band[cy0:cy1, cx0:cx1]) == 0:
                continue
            gy0 = max(0, cy0 - band_radius)
            gy1 = min(h, cy1 + band_radius)
            gx0 = max(0, cx0 - band_radius)
            gx1 = min(w, cx1 + band_radius)
            yield (gy0, gy1, gx0, gx1, cy0, cy1, cx0, cx1)


def _banded_nearest_fill(csm, img, ring, band, band_radius: int, out, tile: int = 1024) -> bool:
    """'Kéo giãn mép ảnh' giới hạn theo band (dải quanh ring) thay vì cả trang.

    Với mỗi ô có band: crop nới halo `band_radius`, chạy distance_transform_edt trên
    crop, GHI màu nearest chỉ vào vùng band[core]>0. Guard: nếu pixel band trong core
    có khoảng cách tới nguồn ≥ band_radius → nguồn thật có thể NGOÀI halo → trả False
    (caller fallback về _nearest_color_fill full-ROI, KHÔNG bao giờ tệ hơn).

    CHỨNG MINH giống hệt: pixel hiển thị = ring>0 ⊂ band; band[core] luôn ⊂ band nên
    được ghi. Guard đảm bảo crop chứa trọn nguồn gần nhất toàn cục → idx trùng bản full.
    """
    from scipy.ndimage import distance_transform_edt
    for (gy0, gy1, gx0, gx1, cy0, cy1, cx0, cx1) in _band_tiles(band, band_radius, tile):
        sub_src = csm[gy0:gy1, gx0:gx1]
        # Không có nguồn màu trong crop → không thể nearest-fill đúng → fallback.
        if np.count_nonzero(sub_src) == 0:
            return False
        dist, idx = distance_transform_edt(sub_src == 0, return_indices=True)
        # Vùng band cần ghi trong toạ độ crop.
        cyl, cyr = cy0 - gy0, cy1 - gy0
        cxl, cxr = cx0 - gx0, cx1 - gx0
        core_band = band[cy0:cy1, cx0:cx1] > 0
        if not core_band.any():
            continue
        # Guard CHỈ trên RING (pixel HIỂN THỊ) — KHÔNG phải band. Band rộng thêm
        # band_radius ngoài ring nên pixel band ngoài cùng luôn cách nguồn ≥ band_radius
        # → guard-trên-band LUÔN trip (tối ưu vô dụng, vd tem tròn có lỗ). Chỉ ring cần
        # khớp global (cách nguồn < band_radius). Pixel band ngoài-ring KHÔNG hiển thị
        # (SMask=ring), chỉ lấp màu liên tục chống sợi xám → không cần khớp global.
        core_ring = ring[cy0:cy1, cx0:cx1] > 0
        core_dist = dist[cyl:cyr, cxl:cxr]
        if core_ring.any() and float(core_dist[core_ring].max()) >= band_radius:
            return False
        sub_img = img[gy0:gy1, gx0:gx1]
        filled = sub_img[idx[0], idx[1]]
        core_out = out[cy0:cy1, cx0:cx1]
        core_filled = filled[cyl:cyr, cxl:cxr]
        core_out[core_band] = core_filled[core_band]
    return True


def _banded_inpaint_fill(img, csm, bleed, ring, band, band_radius: int, out, tile: int = 1024) -> bool:
    """'Làm mượt thông minh' giới hạn theo band. Mỗi ô gọi lại _inpaint_color_fill
    trên crop (nới halo band_radius), ghi kết quả chỉ vào band[core]>0.

    KHÔNG bitwise-identical (NS là PDE) nhưng giống thị giác: mask inpaint =
    bleed−csm nằm trong band_radius của ring; halo đủ xa (~45px ≫ radius 3) để nhiễu
    biên không chạm pixel ring. Guard EDT (như nearest) → fallback full-ROI khi rủi ro.
    """
    from scipy.ndimage import distance_transform_edt
    for (gy0, gy1, gx0, gx1, cy0, cy1, cx0, cx1) in _band_tiles(band, band_radius, tile):
        sub_csm = csm[gy0:gy1, gx0:gx1]
        if np.count_nonzero(sub_csm) == 0:
            return False
        core_band = band[cy0:cy1, cx0:cx1] > 0
        if not core_band.any():
            continue
        # Guard CHỈ trên RING (pixel hiển thị), KHÔNG phải band — xem giải thích ở
        # _banded_nearest_fill. Guard-trên-band luôn trip vì band rộng hơn ring band_radius.
        core_ring = ring[cy0:cy1, cx0:cx1] > 0
        dist = distance_transform_edt(sub_csm == 0)
        cyl, cyr = cy0 - gy0, cy1 - gy0
        cxl, cxr = cx0 - gx0, cx1 - gx0
        if core_ring.any() and float(dist[cyl:cyr, cxl:cxr][core_ring].max()) >= band_radius:
            return False
        sub_img = img[gy0:gy1, gx0:gx1]
        sub_bleed = bleed[gy0:gy1, gx0:gx1]
        filled = _inpaint_color_fill(sub_img, sub_csm, sub_bleed)
        core_out = out[cy0:cy1, cx0:cx1]
        core_filled = filled[cyl:cyr, cxl:cxr]
        core_out[core_band] = core_filled[core_band]
    return True


# ── Ngưỡng song song ─────────────────────────────────────────────────────
# Overhead spawn trên Windows ~2-3s/worker (child re-import cv2/scipy/skimage/
# pikepdf/pdfium). Với ~2s/trang, break-even ≈ 6 trang. File < ngưỡng chạy tuần
# tự tại chỗ (không spawn) để không chậm hơn.
_STICKER_PARALLEL_MIN_PAGES = 6


def _n_pages_should_parallelize(n_pages: int) -> bool:
    """True nếu nên fan-out song song (đủ nhiều trang để bù overhead spawn)."""
    return n_pages >= _STICKER_PARALLEL_MIN_PAGES


def _process_sticker_chunk(args: dict):
    """Worker top-level (BẮT BUỘC picklable + importable cho Windows spawn).

    Mỗi tiến trình con tạo StickerEngine RIÊNG (self.scale mutate per-trang nên
    KHÔNG chia sẻ instance) và gọi lại process_pdf với _page_subset = dải trang
    của chunk. process_pdf ở chế độ worker trả MẢNH THÔ:
        (chunk_pdf_bytes, all_pages_meta, pages_no_dieline_global, any_dieline)
    Trả kèm chunk_idx để orchestrator sắp đúng thứ tự (dù pool.map đã giữ thứ tự,
    vẫn trả để phòng thủ + dễ log).
    """
    chunk_idx = args["chunk_idx"]
    # OVERSUBSCRIPTION FIX: OpenCV/BLAS tự đa luồng (cv2.getNumThreads=số nhân). Chạy
    # W worker mà mỗi worker vẫn dùng full nhân → W×nhân luồng chen nhau trên số nhân
    # có hạn → thrashing (đo thực: 6 worker chỉ nhanh 2x thay vì ~6x). Ghim mỗi worker
    # về ÍT luồng (orchestrator tính threads_per_worker ≈ nhân/W) để tổng luồng ≈ nhân.
    _tpw = str(args.get("threads_per_worker", 1))
    for _var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
                 "NUMEXPR_NUM_THREADS", "OPENCV_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
        os.environ[_var] = _tpw
    try:
        cv2.setNumThreads(int(_tpw))
    except Exception:
        pass
    engine = StickerEngine(dpi=args["dpi"], debug=args["debug"])
    result = engine.process_pdf(
        input_path=args["input_path"],
        output_path="",  # worker mode: KHÔNG ghi ra đĩa, trả bytes
        cut_mode=args["cut_mode"],
        offset_mm=args["offset_mm"],
        corner_style=args["corner_style"],
        cut_color=args["cut_color"],
        bleed_mm=args["bleed_mm"],
        fill_holes=args["fill_holes"],
        remove_white_bg=args["remove_white_bg"],
        bleed_color_type=args["bleed_color_type"],
        solid_bleed_color=args["solid_bleed_color"],
        draw_cut_contour=args["draw_cut_contour"],
        rectangle_mode=args["rectangle_mode"],
        edge_bite_mm=args["edge_bite_mm"],
        cut_first_page_only=args["cut_first_page_only"],
        _page_subset=args["page_indices"],
    )
    # result = (bytes, metas, pages_no_dieline, any_dieline)
    return (chunk_idx, result)


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
        draw_cut_contour: bool = True,
        rectangle_mode: bool = False,
        edge_bite_mm: float = 0.0,
        cut_first_page_only: bool = False,
        _page_subset: list = None,
    ) -> tuple:
        # _page_subset: khi != None, CHỈ xử lý các trang có index trong list (theo
        # đúng thứ tự truyền vào) và lưu output ra output_path. Dùng cho worker song
        # song — mỗi tiến trình con xử lý một dải trang liền kề rồi trả file chunk.
        # output_path lúc đó là file chunk tạm. page_idx trong log/meta vẫn là index
        # GLOBAL (index thật trong file gốc) để concat + cảnh báo trang đúng số.
        debug_step = "Init"
        doc_in_pdfium = None
        doc_in_pike = None
        doc_out = None
        try:
            debug_step = "Open Original PDF"
            doc_in_pdfium = pdfium.PdfDocument(input_path)
            doc_in_pike = pikepdf.Pdf.open(input_path)

            # ── ORCHESTRATOR: song song hóa khi gọi top-level + file nhiều trang ──
            # _page_subset None = gọi top-level (không phải worker). File >= ngưỡng →
            # chia dải trang liền kề cho nhiều tiến trình con, mỗi con tự mở lại file
            # + xử lý chunk + trả file PDF, rồi merge ở đây. Overhead spawn Windows
            # ~2-3s/worker nên file nhỏ (< ngưỡng) chạy tuần tự tại chỗ (rơi xuống dưới).
            if _page_subset is None and _n_pages_should_parallelize(len(doc_in_pdfium)):
                doc_in_pdfium.close(); doc_in_pdfium = None
                doc_in_pike.close(); doc_in_pike = None
                return self._process_parallel(
                    input_path=input_path, output_path=output_path,
                    cut_mode=cut_mode, offset_mm=offset_mm, corner_style=corner_style,
                    cut_color=cut_color, bleed_mm=bleed_mm, fill_holes=fill_holes,
                    remove_white_bg=remove_white_bg, bleed_color_type=bleed_color_type,
                    solid_bleed_color=solid_bleed_color, draw_cut_contour=draw_cut_contour,
                    rectangle_mode=rectangle_mode, edge_bite_mm=edge_bite_mm,
                    cut_first_page_only=cut_first_page_only,
                )

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
            any_dieline_found = False
            pages_no_dieline = []

            _n_pages = len(doc_in_pdfium)
            # Danh sách trang cần xử lý: subset (worker song song) hoặc toàn bộ.
            _page_list = list(_page_subset) if _page_subset is not None else list(range(_n_pages))

            for page_idx in _page_list:
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
                # px/mm THỰC TẾ của raster: self.scale là px/point (đã gồm shrink khi trang
                # bị DPI-cap), nên px/mm = scale × 72/25.4. MỌI morphology bù xén PHẢI dùng
                # số này, KHÔNG dùng self.dpi/25.4 (bỏ qua shrink → phóng đại 1/shrink lần khi
                # trang lớn: hút màu quá sâu, đóng lỗ/lẹm mép quá tay, lệch bleed_mask).
                px_per_mm = self.scale * 72.0 / 25.4
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
                
                # RECTANGLE MODE: shape ĐÃ biết là cả page rect (nhánh dòng ~404 dựng
                # dieline/cut/bleed_outer từ page bbox). Toàn bộ pipeline mask dưới đây
                # (HSV/connectedComponents/fill_holes/GaussianBlur/skimage find_contours)
                # là THỪA — chỉ cần mask full-page. `contours` không dùng ở nhánh rect.
                # Bỏ qua giúp rectangle nhanh hẳn (audit tốc độ 2026-07-08).
                # LƯU Ý: rect mode bỏ qua remove_white_bg/alpha — đúng ngữ nghĩa "shape
                # là cả trang"; đừng dựa auto-trim trắng khi rectangle_mode=True.
                if rectangle_mode:
                    _full = np.full(img.shape[:2], 255, dtype=np.uint8)
                    base_mask = raw_mask = mask = aa_mask = _full
                    contours = []
                else:
                    if has_alpha:
                        base_mask = img[:, :, 3].copy()
                    else:
                        if remove_white_bg:
                            hsv = cv2.cvtColor(img[:,:,:3], cv2.COLOR_RGB2HSV)
                            # Ngưỡng SIẾT MẠNH: chỉ coi là "trắng nền" khi RẤT sáng
                            # (V>=200) VÀ GẦN NHƯ VÔ SẮC TUYỆT ĐỐI (S<=8 ≈ 3%). Lý do:
                            # nền kem/ngà CMYK rất nhạt (vd C4 M5 Y10 → RGB≈(243,237,227),
                            # S≈17 ≈ 6.6%) LÀ NỘI DUNG của nhãn, phải GIỮ. Ngưỡng cũ S<=25
                            # ăn nhầm cả nền kem đó (bóc mất nửa nhãn). Chỉ trắng gần tuyệt
                            # đối (S<3%) mới bị bóc; mọi ám màu nhẹ đều được giữ.
                            # ĐÁNH ĐỔI: nền trắng-JPEG có ám vàng nhẹ sẽ KHÔNG còn bị bóc.
                            lower_white = np.array([0, 0, 200])
                            upper_white = np.array([180, 8, 255])
                            white_mask = cv2.inRange(hsv, lower_white, upper_white)
                            # CHỈ bỏ vùng trắng NỐI với biên ảnh (nền thật) — dùng connected-components,
                            # giữ lại các mảng trắng chạm mép. Chi tiết sáng/pastel/xám nhạt NẰM GIỮA
                            # artwork (không chạm biên) được GIỮ → không đục lỗ nội dung như ngưỡng cứng
                            # cũ (nới ngưỡng mà không lọc-theo-biên sẽ đục thủng artwork nhạt màu).
                            num_lbl, labels = cv2.connectedComponents(white_mask)
                            if num_lbl > 1:
                                border_labels = set(labels[0, :]) | set(labels[-1, :]) | set(labels[:, 0]) | set(labels[:, -1])
                                border_labels.discard(0)
                                if border_labels:
                                    bg_white = np.isin(labels, list(border_labels)).astype(np.uint8) * 255
                                else:
                                    bg_white = np.zeros_like(white_mask)
                            else:
                                bg_white = np.zeros_like(white_mask)
                            base_mask = cv2.bitwise_not(bg_white)
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
                
                # Hình học phải theo CROPBOX, KHÔNG phải MediaBox: pdfium render và
                # page.as_form_xobject() đều dùng CropBox (đã verify). Khi file có
                # CropBox ≠ MediaBox (vd sau auto-trim chỉ set CropBox), lấy MediaBox
                # sẽ lệch cả kích thước lẫn gốc toạ độ → bleed/đường cắt vẽ sai chỗ.
                # pikepdf .cropbox tự fallback về MediaBox khi trang không có CropBox.
                crop_x0 = float(page_in_pike.cropbox[0])
                crop_y0 = float(page_in_pike.cropbox[1])
                page_in_width = float(page_in_pike.cropbox[2]) - crop_x0
                page_in_height = float(page_in_pike.cropbox[3]) - crop_y0
                
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
                sticker_footprint = None
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
                
                # ── RECTANGLE MODE: dùng page bbox làm shape, skip contour detection ──
                if rectangle_mode:
                    debug_step = f"Rectangle Mode Page {page_idx}"
                    rect_poly = Polygon([
                        (0, 0), (page_in_width, 0),
                        (page_in_width, page_in_height), (0, page_in_height)
                    ])
                    dieline_poly = rect_poly
                    cut_poly = rect_poly
                    any_dieline_found = True
                    if bleed_pts > 0:
                        bleed_outer_offset = bleed_pts
                        bleed_outer_poly = rect_poly.buffer(bleed_pts, join_style=2)  # miter
                    else:
                        bleed_outer_poly = rect_poly
                    if self.debug:
                        logger.warning(">>> RECTANGLE MODE: page %.1fx%.1f pt, bleed_pts=%.2f", page_in_width, page_in_height, bleed_pts)
                
                elif cut_mode != "none" and len(contours) > 0:
                    debug_step = f"Process Contours Page {page_idx}"
                    poly_scale = 1.0 / self.scale
                    
                    raw_polys = []
                    for contour in contours:
                        contour = contour - 1
                        contour_pts = contour[:, [1, 0]] * poly_scale
                        
                        # Chỉ làm mượt khi góc TRÒN. Với góc nhọn/vuông (miter),
                        # smoothing sẽ bo mềm các góc đáng lẽ phải sắc → sai kiểu góc.
                        if corner_style == "round" and len(contour_pts) >= 10:
                            # Window gắn theo ĐỘ DÀI VẬT LÝ cố định (~1mm chu vi), KHÔNG
                            # theo số điểm. Bản cũ (n_pts/30) tỉ lệ độ phân giải: nhãn to +
                            # scale cao (3901 điểm) đẩy window lên 130 điểm ≈ 11mm → trung
                            # bình trượt 11mm bo góc nhãn thành cung bán kính vài mm (đường
                            # cắt không bám viền). 1mm đủ khử răng cưa marching-square mà
                            # KHÔNG bo góc thấy được, độc lập scale/kích thước nhãn.
                            SMOOTH_MM = 1.0
                            window = int(round(SMOOTH_MM * mm_to_pts * self.scale))
                            window = max(3, min(window, len(contour_pts) // 4))
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

                        # cut_poly = dieline_poly nhưng đã được nén (1.0 pt) để dọn dẹp điểm thừa mà vẫn giữ form cong chuẩn.
                        # simplify(preserve_topology=False) trên 1 Polygon CÓ THỂ trả MultiPolygon
                        # (hình mảnh/eo hẹp bị đứt) → nếu nhồi thẳng vào MultiPolygon([...]) sẽ
                        # crash "'MultiPolygon' object is not subscriptable" (constructor tưởng
                        # phần tử là spec (shell, holes) rồi index nó). Gom PHẲNG mọi Polygon con.
                        if isinstance(dieline_poly, MultiPolygon):
                            _cut_parts = []
                            for p in dieline_poly.geoms:
                                _s = p.simplify(1.0, preserve_topology=False)
                                if _s.is_empty:
                                    continue
                                if isinstance(_s, MultiPolygon):
                                    _cut_parts.extend(g for g in _s.geoms if not g.is_empty)
                                else:
                                    _cut_parts.append(_s)
                            cut_poly = MultiPolygon(_cut_parts) if _cut_parts else dieline_poly
                        else:
                            cut_poly = dieline_poly.simplify(1.0, preserve_topology=False)

                # ============================================================
                # STEP B: Generate bleed using dieline_poly for perfect alignment
                # ============================================================
                if bleed_mm > 0.0:
                    debug_step = f"Generate Bleed Page {page_idx}"
                    bleed_px = math.ceil(bleed_mm * px_per_mm)
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
                        
                        inset_px = int(0.15 * px_per_mm)
                        if inset_px < 1: inset_px = 1
                        # "Lẹm mép": hút màu sâu vào trong thêm edge_bite_mm để bỏ qua viền
                        # trắng mảnh ở mép nguồn (file khách không tràn lề). Nearest/inpaint
                        # sẽ kéo màu SÂU bên trong (đỏ) phủ ra cả viền trắng lẫn vùng bleed.
                        edge_bite_px = max(0, int(edge_bite_mm * px_per_mm))
                        inset_px += edge_bite_px
                        inset_kernel = cv2.getStructuringElement(kernel_type, (inset_px*2+1, inset_px*2+1))
                        color_source_mask = cv2.erode(padded_original_mask, inset_kernel)
                        # FALLBACK viền-trắng: chi tiết mảnh hơn 2×inset_px bị erode ăn SẠCH →
                        # color_source_mask rỗng → nearest/inpaint không có nguồn màu, distance
                        # transform trả pixel góc ROI = padding TRẮNG → vành bù xén ra trắng
                        # (trái mục tiêu). Nếu rỗng: thử co nhẹ dần; vẫn rỗng thì dùng mask gốc
                        # (chưa erode) — thà lấy màu gồm cả mép còn hơn ra trắng.
                        if np.count_nonzero(color_source_mask) == 0:
                            for _shrink_px in (max(1, inset_px // 2), 1):
                                _k = cv2.getStructuringElement(kernel_type, (_shrink_px*2+1, _shrink_px*2+1))
                                color_source_mask = cv2.erode(padded_original_mask, _k)
                                if np.count_nonzero(color_source_mask) > 0:
                                    break
                            if np.count_nonzero(color_source_mask) == 0:
                                color_source_mask = padded_original_mask.copy()

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
                        close_px = max(10, int(1.5 * px_per_mm))  # ~1.5mm closing radius
                        close_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close_px*2+1, close_px*2+1))
                        closed_mask = cv2.morphologyEx(padded_original_mask, cv2.MORPH_CLOSE, close_kernel)
                        foot_contours, _ = cv2.findContours(closed_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                        sticker_footprint = np.zeros_like(padded_original_mask)
                        cv2.drawContours(sticker_footprint, foot_contours, -1, 255, cv2.FILLED)

                        # "Lẹm mép" (doa nền kiểu Photoshop): co footprint vào trong edge_bite_px.
                        # Artwork (layer trên) bị clip theo footprint → co vào để lộ dải bleed bên
                        # dưới ở đúng viền trắng mảnh của file nguồn. bleed_ring = bleed_mask − footprint
                        # nên footprint co lại thì ring TỰ lan vào trong phủ viền trắng đó. Kết hợp với
                        # color_source_mask đã co thêm edge_bite (ở trên) → màu hút từ SÂU bên trong
                        # (bỏ qua viền trắng) rồi kéo phủ ra. CẢNH BÁO: lẹm quá tay ăn vào nội dung
                        # sát mép — mặc định nhỏ, cho khách chỉnh/tắt (0).
                        if edge_bite_px > 0:
                            bite_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (edge_bite_px*2+1, edge_bite_px*2+1))
                            sticker_footprint = cv2.erode(sticker_footprint, bite_kernel)

                        # bleed_ring = vùng giữa footprint và đường cắt. NỚI mép trong
                        # VÀO TRONG vài px: SMask lùa xuống DƯỚI artwork (layer trên phủ
                        # footprint) → bịt khe hở subpixel ở mối nối raster(SMask)↔clip-vector,
                        # tránh hở nền tạo sợi mảnh. Phần nới nằm dưới artwork nên vô hình.
                        _tuck_px = max(1, int(0.2 * px_per_mm))
                        _fp_inner = cv2.erode(sticker_footprint, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (_tuck_px*2+1, _tuck_px*2+1)))
                        bleed_ring = cv2.subtract(bleed_mask, _fp_inner)
                        
                        # Band = dải quanh ring, đủ rộng để chứa nguồn màu gần nhất của MỌI
                        # pixel ring (bleed_px ngoài + inset_px trong + tuck + slack). Chỉ tính
                        # fill trong band thay vì cả trang → nhanh 5-8x mà pixel HIỂN THỊ (ring)
                        # giống hệt. edge_bite_px ĐÃ nằm trong inset_px (dòng ~570) → KHÔNG cộng lại.
                        _SAFETY = 4
                        band_r = int(bleed_px + inset_px + _tuck_px + 1 + _SAFETY)
                        band_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (band_r*2+1, band_r*2+1))
                        band = cv2.dilate(bleed_ring, band_kernel)

                        is_bleed_cmyk = False
                        if bleed_color_type == "image":
                            # 'Kéo giãn mép ảnh' — nearest-color giới hạn theo band (tile + bỏ ô ruột).
                            bleed_colors = np.zeros_like(padded_img)
                            if not _banded_nearest_fill(color_source_mask, padded_img, bleed_ring, band, band_r, out=bleed_colors):
                                # Guard tripped (artwork mảnh / nguồn ngoài halo) → full-ROI (không tệ hơn).
                                roi = _bleed_roi_bbox(bleed_mask, margin=8)
                                bleed_colors = np.zeros_like(padded_img)
                                if roi is not None:
                                    y0, y1, x0, x1 = roi
                                    bleed_colors[y0:y1, x0:x1] = _nearest_color_fill(
                                        color_source_mask[y0:y1, x0:x1], padded_img[y0:y1, x0:x1]
                                    )
                                else:
                                    bleed_colors = _nearest_color_fill(color_source_mask, padded_img)
                        elif bleed_color_type == "inpaint":
                            # 'Làm mượt thông minh' — inpaint giới hạn theo band (tile + bỏ ô ruột).
                            bleed_colors = np.zeros_like(padded_img)
                            if not _banded_inpaint_fill(padded_img, color_source_mask, bleed_mask, bleed_ring, band, band_r, out=bleed_colors):
                                roi = _bleed_roi_bbox(bleed_mask, margin=8)
                                bleed_colors = np.zeros_like(padded_img)
                                if roi is not None:
                                    y0, y1, x0, x1 = roi
                                    bleed_colors[y0:y1, x0:x1] = _inpaint_color_fill(
                                        padded_img[y0:y1, x0:x1],
                                        color_source_mask[y0:y1, x0:x1], bleed_mask[y0:y1, x0:x1],
                                    )
                                else:
                                    bleed_colors = _inpaint_color_fill(padded_img, color_source_mask, bleed_mask)
                        else:
                            if len(solid_bleed_color) == 4:
                                is_bleed_cmyk = True
                                bg_canvas = np.zeros((padded_img.shape[0], padded_img.shape[1], 4), dtype=np.uint8)
                                bg_canvas[:] = solid_bleed_color
                            else:
                                bg_canvas = np.zeros_like(padded_img)
                                bg_canvas[:] = solid_bleed_color
                            bleed_colors = bg_canvas

                        # KHÔNG mask màu về canvas ĐEN nữa: trước đây bleed_result=zeros
                        # rồi chỉ copy ring → vùng interior (ngoài ring) là ĐEN, tạo cạnh
                        # màu↔đen ở biên trong ring. Khi PDF render nội suy ảnh+SMask ở cạnh
                        # đó → pixel alpha-một-phần = màu TRỘN đen = SỢI XÁM mảnh (lộ cả khi
                        # bleed trắng: 255↔0 = xám). bleed_colors đã có màu LIÊN TỤC toàn ROI
                        # (nearest/inpaint/solid fill) → dùng trực tiếp, cạnh chỉ còn màu↔màu.
                        bleed_rgb = bleed_colors

                        # Đồng bộ HỆ MÀU với artwork gốc (CMYK): màu bleed image/inpaint
                        # lấy từ ảnh pdfium render (RGB). Ghi ở DeviceRGB → RIP nong RGB→CMYK
                        # bằng phép KHÁC lúc raster → lệch màu ở mép nối bleed↔artwork. Chuyển
                        # sang CMYK (K=0) để mép khớp: nghịch đảo C=255−R… tái tạo gần đúng CMY
                        # gốc (vd nền kem RGB(243,237,227) → C5 M7 Y11 K0 ≈ C4 M5 Y10 gốc).
                        # Nhánh solid-CMYK (4 kênh) đã là CMYK; chỉ chuyển khi còn 3 kênh.
                        if not is_bleed_cmyk and bleed_rgb.ndim == 3 and bleed_rgb.shape[2] == 3:
                            bleed_rgb = _rgb_to_cmyk(bleed_rgb)
                            is_bleed_cmyk = True

                        # LOSSLESS (zlib/FlateDecode) cho CẢ RGB lẫn CMYK. TRƯỚC đây RGB
                        # lưu JPEG q90 → ringing (Gibbs) ở mọi ranh giới tương phản cao:
                        # dải pixel bị kéo về trung tính = VIỀN XÁM nhạt ở biên hình↔bleed,
                        # lộ cả khi bleed trắng (255↔0 qua JPEG thành xám). Ring hẹp (bleed
                        # 1-3mm) + vùng ngoài ring = 0 nên zlib nén rất tốt, dung lượng không
                        # đáng ngại. Nhánh CMYK vốn đã né JPEG (Adobe inversion) — nay RGB cũng vậy.
                        bleed_stream_data = zlib.compress(bleed_rgb.tobytes())
                        img_w, img_h = bleed_rgb.shape[1], bleed_rgb.shape[0]
                            
                        mask_bytes_data = zlib.compress(bleed_ring.tobytes())
                        
                        # Save comprehensive debug images for first page
                        if page_idx == 0 and self.debug:
                            try:
                                debug_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'debug_output')
                                os.makedirs(debug_dir, exist_ok=True)
                                cv2.imwrite(os.path.join(debug_dir, 'debug_bleed_ring.png'), bleed_ring)
                                cv2.imwrite(os.path.join(debug_dir, 'debug_bleed_result.png'), cv2.cvtColor(bleed_rgb[:,:,:3], cv2.COLOR_RGB2BGR) if not is_bleed_cmyk else bleed_rgb)
                                cv2.imwrite(os.path.join(debug_dir, 'debug_padded_mask.png'), padded_mask)
                                cv2.imwrite(os.path.join(debug_dir, 'debug_sticker_footprint.png'), sticker_footprint)
                                logger.warning(">>> BLEED DEBUG: bleed_ring nonzero=%d, bleed_rgb mean=%s, bleed_color_type=%s", np.count_nonzero(bleed_ring), np.mean(bleed_rgb[bleed_ring > 0], axis=0) if np.count_nonzero(bleed_ring) > 0 else 'N/A', bleed_color_type)
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
                    # Cả 2 nhánh nay đều zlib (lossless) → FlateDecode. Trước RGB là DCTDecode (JPEG).
                    img_obj.Filter = pikepdf.Name.FlateDecode
                    img_obj.SMask = mask_obj
                    
                    img_name = page_out.add_resource(img_obj, pikepdf.Name.XObject)
                    
                    shift_x = max_expansion_pts - (pad_b / self.scale)
                    shift_y = max_expansion_pts - (pad_b / self.scale)

                    if self.debug:
                        # So khớp 2 layer: bleed (raster, neo self.scale) vs artwork
                        # (vector 1:1, neo crop_x0). artwork phải rộng ĐÚNG page_in_width;
                        # bleed artwork-portion rộng img_native_px/self.scale. Lệch ⇒ pdfium
                        # render khác box ta giả định (CropBox) hoặc self.scale sai.
                        _art_px_w = img_w - 2 * pad_b
                        _art_px_h = img_h - 2 * pad_b
                        logger.warning(
                            ">>> ALIGN p%d: page_in=%.3fx%.3f pt | render_px=%dx%d → /scale=%.3fx%.3f pt | scale=%.5f (base=%.5f) | crop0=(%.3f,%.3f) | img_w_pt=%.3f shift=(%.3f,%.3f) max_exp=%.3f pad_b=%d",
                            page_idx, page_in_width, page_in_height,
                            _art_px_w, _art_px_h, _art_px_w / self.scale, _art_px_h / self.scale,
                            self.scale, base_scale, crop_x0, crop_y0,
                            img_w_pt, shift_x, shift_y, max_expansion_pts, pad_b,
                        )

                    page_content_stream.append("q")
                    page_content_stream.append(f"{img_w_pt:.4f} 0 0 {img_h_pt:.4f} {shift_x:.4f} {shift_y:.4f} cm")
                    page_content_stream.append(f"{str(img_name)} Do")
                    page_content_stream.append("Q")

                # LAYER 2 (TOP): Artwork gốc — GIỮ NGUYÊN VECTOR, KHÔNG raster hoá.
                # Trước đây artwork bị render thành JPEG 300 DPI (mất nét vector + lệch
                # màu RGB). Nay luôn vẽ lại form XObject gốc. Khi có bleed: clip artwork
                # vào đúng footprint (CÙNG biên với bleed_ring → không hở mép trắng),
                # phần ngoài footprint để lộ bleed bên dưới.
                src_xobj = page_in_pike.as_form_xobject()
                src_xobj_name = page_out.add_resource(src_xobj, pikepdf.Name.XObject)

                page_content_stream.append("q")
                if bleed_stream_data and sticker_footprint is not None:
                    # Trace footprint (đã đóng kín, hole-filled) thành đường clip vector.
                    # footprint là raster trong KHÔNG GIAN ẢNH ĐỆM (padded); ánh xạ về
                    # toạ độ trang giống vị trí đặt ảnh bleed: (shift_x + px/scale,
                    # shift_y + (h - py)/scale). Nhờ vậy biên clip khớp tuyệt đối bleed_ring.
                    fp_h_px = sticker_footprint.shape[0]
                    fp_contours, _ = cv2.findContours(sticker_footprint, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                    inv_scale = 1.0 / self.scale
                    clip_ops = []
                    for cnt in fp_contours:
                        pts = cnt.reshape(-1, 2)
                        if len(pts) < 3:
                            continue
                        x0 = shift_x + pts[0][0] * inv_scale
                        y0 = shift_y + (fp_h_px - pts[0][1]) * inv_scale
                        clip_ops.append(f"{x0:.3f} {y0:.3f} m")
                        for px, py in pts[1:]:
                            x = shift_x + px * inv_scale
                            y = shift_y + (fp_h_px - py) * inv_scale
                            clip_ops.append(f"{x:.3f} {y:.3f} l")
                        clip_ops.append("h")
                    if clip_ops:
                        page_content_stream.extend(clip_ops)
                        page_content_stream.append("W n")
                # Form XObject giữ toạ độ gốc của trang (BBox = CropBox, bắt đầu ở
                # crop_x0/crop_y0), trong khi bleed + contour ở "local crop space"
                # (gốc 0,0). Phải dịch thêm -crop_x0/-crop_y0 để artwork khớp bleed;
                # nếu không artwork lệch đúng bằng gốc CropBox và bị footprint clip cắt.
                art_shift_x = max_expansion_pts - crop_x0
                art_shift_y = max_expansion_pts - crop_y0
                page_content_stream.append(f"1 0 0 1 {art_shift_x:.4f} {art_shift_y:.4f} cm")
                page_content_stream.append(f"{str(src_xobj_name)} Do")
                page_content_stream.append("Q")



                # "Tạo đường cắt cho trang đầu": trang 2+ CHỈ bù xén, không vẽ đường
                # cắt → file nhiều loại tem CÙNG khuôn, trang 1 mang khuôn master để
                # tool Bình tem bế/CNC (chế độ đồng nhất) lấy làm dieline chung.
                _cut_page_ok = (not cut_first_page_only) or (page_idx == 0)
                if _cut_page_ok and draw_cut_contour and cut_mode != "none" and cut_poly is not None and not getattr(cut_poly, 'is_empty', True):
                    debug_step = "Draw Cut Contour"
                    
                    page_content_stream.append("q")
                    page_content_stream.append(f"1 0 0 1 {max_expansion_pts:.4f} {max_expansion_pts:.4f} cm")
                    
                    page_content_stream.append("/CutContour CS")
                    page_content_stream.append("1.0 SCN")
                    page_content_stream.append("1.0 w")

                    # cut_poly có thể là Polygon, MultiPolygon, hoặc (khi buffer âm lớn teo
                    # tách shape) GeometryCollection/LineString KHÔNG có .exterior. Gom chỉ
                    # các thành viên là Polygon (có .exterior) → tránh AttributeError crash.
                    if isinstance(cut_poly, MultiPolygon):
                        raw_geoms = list(cut_poly.geoms)
                    elif hasattr(cut_poly, 'geoms'):  # GeometryCollection
                        raw_geoms = list(cut_poly.geoms)
                    else:
                        raw_geoms = [cut_poly]
                    geoms = [g for g in raw_geoms if g.geom_type == 'Polygon' and not g.is_empty]
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
                    any_dieline_found = True
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
                elif cut_mode != "none":
                    # Yêu cầu tạo đường cắt nhưng không dò được hình trên trang này.
                    pages_no_dieline.append(page_idx + 1)
                
                all_pages_meta.append(page_meta)

            # CHẾ ĐỘ WORKER (song song): trả MẢNH THÔ (bytes + meta các trang của chunk
            # này + pages_no_dieline GLOBAL 1-based + cờ any_dieline) cho orchestrator gộp,
            # KHÔNG finalize (không ghi output_path, không dựng final_meta/error/warning —
            # để orchestrator tổng hợp từ mọi chunk). page_idx trong vòng là index GỐC nên
            # pages_no_dieline đã là số trang GLOBAL, orchestrator không cần offset.
            if _page_subset is not None:
                _buf = io.BytesIO()
                doc_out.save(_buf)
                return (_buf.getvalue(), all_pages_meta, pages_no_dieline, any_dieline_found)

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

            # Yêu cầu vẽ đường cắt nhưng KHÔNG dò được hình trên BẤT KỲ trang nào →
            # trả lỗi nghiệp vụ rõ ràng (route → 422) thay vì file "thành công" rỗng.
            if cut_mode != "none" and not any_dieline_found:
                try:
                    if os.path.exists(output_path):
                        os.remove(output_path)
                except OSError:
                    pass
                return False, {
                    "error": (
                        "Không dò được hình để tạo đường cắt. Hãy bật 'Bỏ nền trắng' "
                        "nếu nền màu trắng, hoặc kiểm tra lại file (hình quá nhạt/trống)."
                    )
                }
            if pages_no_dieline:
                final_meta["warning"] = (
                    "Một số trang không dò được hình để tạo đường cắt: "
                    + ", ".join(str(p) for p in pages_no_dieline)
                )

            return True, final_meta
            
        except Exception as e:
            logger.error(f"Sticker processing failed at {debug_step}: {e}", exc_info=True)
            # Lấy số dòng trong CHÍNH file này (không phải path hệ thống) để chẩn đoán
            # nhanh dòng nào ném lỗi mà không cần đọc log server.
            import traceback as _tb
            _this = os.path.basename(__file__)
            _line = None
            for _fr in reversed(_tb.extract_tb(e.__traceback__)):
                if os.path.basename(_fr.filename) == _this:
                    _line = _fr.lineno
                    break
            _loc = f"@{_line}" if _line else ""
            raise RuntimeError(f"[{debug_step}{_loc}] {str(e)}")
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

    def _process_parallel(self, input_path, output_path, **kw) -> tuple:
        """Fan-out xử lý trang ra nhiều tiến trình con rồi merge kết quả.

        Chia N trang thành W dải liền kề (contiguous), mỗi worker tạo StickerEngine
        riêng xử lý một dải (qua _page_subset) và trả file chunk (bytes) + meta. Gộp
        các chunk theo THỨ TỰ (pikepdf pages.extend, tự kéo spot color /CutContour qua
        copy_foreign), concat meta, tổng hợp any_dieline + pages_no_dieline rồi tái
        tạo final_meta/error/warning Y HỆT nhánh tuần tự.
        """
        import math as _math
        from concurrent.futures import ProcessPoolExecutor
        cut_mode = kw["cut_mode"]

        _probe = pdfium.PdfDocument(input_path)
        n_pages = len(_probe)
        _probe.close()

        available = max(1, (os.cpu_count() or 2) - 1)
        cap = int(os.environ.get("STICKER_MAX_WORKERS", "8"))
        n_workers = max(1, min(available, cap, n_pages))
        chunk_size = max(1, _math.ceil(n_pages / n_workers))
        chunks = [list(range(i, min(i + chunk_size, n_pages)))
                  for i in range(0, n_pages, chunk_size)]

        # CHỐNG OVERSUBSCRIPTION LUỒNG: cv2/numpy-BLAS TỰ đa luồng (mặc định = SỐ NHÂN,
        # vd 16). Nếu mỗi worker vẫn dùng full luồng → n_workers × 16 luồng chen trên
        # số nhân có hạn = thrashing, chỉ được ~2x thay vì ~n_workers×. Chia đều luồng
        # cho các worker: mỗi worker ~ tổng_nhân / n_workers (tối thiểu 1). Worker set
        # cv2.setNumThreads + env BLAS theo số này (đọc từ args["threads_per_worker"]).
        _total_cores = os.cpu_count() or 2
        threads_per_worker = max(1, _total_cores // max(1, n_workers))

        args_list = []
        for ci, page_indices in enumerate(chunks):
            args_list.append({
                "chunk_idx": ci, "page_indices": page_indices,
                "threads_per_worker": threads_per_worker,
                "input_path": input_path, "dpi": self.dpi, "debug": self.debug,
                "cut_mode": cut_mode, "offset_mm": kw["offset_mm"],
                "corner_style": kw["corner_style"], "cut_color": kw["cut_color"],
                "bleed_mm": kw["bleed_mm"], "fill_holes": kw["fill_holes"],
                "remove_white_bg": kw["remove_white_bg"],
                "bleed_color_type": kw["bleed_color_type"],
                "solid_bleed_color": kw["solid_bleed_color"],
                "draw_cut_contour": kw["draw_cut_contour"],
                "rectangle_mode": kw["rectangle_mode"],
                "edge_bite_mm": kw["edge_bite_mm"],
                "cut_first_page_only": kw["cut_first_page_only"],
            })

        # 1 chunk → chạy tại chỗ (không spawn). Nhiều chunk → pool. pool.map giữ thứ tự.
        if len(args_list) == 1:
            results = [_process_sticker_chunk(args_list[0])]
        else:
            with ProcessPoolExecutor(max_workers=n_workers) as pool:
                results = list(pool.map(_process_sticker_chunk, args_list))

        # Sắp theo chunk_idx (phòng thủ) rồi gộp.
        results.sort(key=lambda r: r[0])

        all_pages_meta = []
        pages_no_dieline = []
        any_dieline_found = False
        final_doc = None
        try:
            for _ci, (chunk_bytes, metas, no_dieline, any_die) in results:
                all_pages_meta.extend(metas)
                pages_no_dieline.extend(no_dieline)
                any_dieline_found = any_dieline_found or any_die
                src = pikepdf.Pdf.open(io.BytesIO(chunk_bytes))
                if final_doc is None:
                    final_doc = pikepdf.Pdf.new()
                final_doc.pages.extend(src.pages)
                # KHÔNG close src trước khi save: pikepdf giữ tham chiếu foreign object.

            debug_step = "Save Merged Output"
            final_doc.save(output_path)
        finally:
            if final_doc is not None:
                try: final_doc.close()
                except Exception: pass

        # Tái tạo final_meta/error/warning Y HỆT nhánh tuần tự.
        final_meta = {}
        if len(all_pages_meta) > 0 and all_pages_meta[0]:
            final_meta = all_pages_meta[0].copy()
        final_meta["pages"] = all_pages_meta

        if cut_mode != "none" and not any_dieline_found:
            try:
                if os.path.exists(output_path):
                    os.remove(output_path)
            except OSError:
                pass
            return False, {
                "error": (
                    "Không dò được hình để tạo đường cắt. Hãy bật 'Bỏ nền trắng' "
                    "nếu nền màu trắng, hoặc kiểm tra lại file (hình quá nhạt/trống)."
                )
            }
        if pages_no_dieline:
            pages_no_dieline.sort()
            final_meta["warning"] = (
                "Một số trang không dò được hình để tạo đường cắt: "
                + ", ".join(str(p) for p in pages_no_dieline)
            )

        return True, final_meta
