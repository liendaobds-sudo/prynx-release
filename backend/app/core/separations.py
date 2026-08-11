import re
import asyncio
import logging
import base64
import zlib
import numpy as np
from app.core.print_engine import facade as ppe_facade

logger = logging.getLogger(__name__)

# ══════════════════════════════════════════════════════════════
#  PANTONE → RGB LOOKUP TABLE  (50+ most common printing inks)
#  Source: ISO 12647-2 / industry approximations
# ══════════════════════════════════════════════════════════════

PANTONE_RGB_MAP: dict[str, list[int]] = {
    # Reds / Oranges
    "PANTONE Warm Red C": [249, 66, 58],
    "PANTONE Warm Red U": [239, 96, 85],
    "PANTONE Red 032 C": [239, 51, 64],
    "PANTONE 185 C": [228, 0, 43],
    "PANTONE 186 C": [200, 16, 46],
    "PANTONE 199 C": [213, 43, 30],
    "PANTONE 485 C": [218, 41, 28],
    "PANTONE 021 C": [254, 80, 0],
    "PANTONE Orange 021 C": [254, 80, 0],
    "PANTONE 1505 C": [255, 105, 0],
    "PANTONE 1655 C": [252, 76, 2],
    "PANTONE 1788 C": [238, 49, 36],
    "PANTONE 1797 C": [203, 51, 59],
    # Blues
    "PANTONE 286 C": [0, 51, 160],
    "PANTONE 287 C": [0, 56, 168],
    "PANTONE 288 C": [0, 38, 100],
    "PANTONE 289 C": [0, 32, 91],
    "PANTONE 072 C": [16, 6, 159],
    "PANTONE Blue 072 C": [16, 6, 159],
    "PANTONE Reflex Blue C": [0, 20, 137],
    "PANTONE 293 C": [0, 70, 173],
    "PANTONE 300 C": [0, 94, 184],
    "PANTONE 301 C": [0, 75, 135],
    "PANTONE 2935 C": [0, 87, 184],
    "PANTONE 2728 C": [48, 71, 209],
    "PANTONE 7462 C": [0, 78, 124],
    "PANTONE 541 C": [0, 48, 87],
    "PANTONE 7685 C": [30, 67, 150],
    "PANTONE 7455 C": [58, 93, 174],
    "PANTONE Process Blue C": [0, 133, 202],
    # Greens
    "PANTONE 348 C": [0, 132, 61],
    "PANTONE 349 C": [0, 107, 56],
    "PANTONE 356 C": [0, 122, 51],
    "PANTONE 347 C": [0, 155, 72],
    "PANTONE 3425 C": [0, 118, 91],
    "PANTONE 7482 C": [0, 155, 119],
    "PANTONE 7739 C": [66, 143, 41],
    "PANTONE 361 C": [67, 176, 42],
    "PANTONE 369 C": [100, 179, 44],
    # Yellows
    "PANTONE Yellow C": [254, 221, 0],
    "PANTONE Process Yellow C": [246, 214, 0],
    "PANTONE 109 C": [255, 209, 0],
    "PANTONE 116 C": [255, 205, 0],
    "PANTONE 123 C": [255, 196, 37],
    "PANTONE 1235 C": [255, 181, 21],
    "PANTONE 130 C": [242, 169, 0],
    "PANTONE 7548 C": [255, 199, 44],
    "PANTONE 7549 C": [255, 183, 28],
    "PANTONE 7405 C": [245, 225, 81],
    "PANTONE 7406 C": [241, 196, 0],
    # Purples / Violets
    "PANTONE 2685 C": [86, 0, 160],
    "PANTONE 2627 C": [81, 45, 109],
    "PANTONE 269 C": [107, 31, 116],
    "PANTONE 2593 C": [135, 75, 176],
    "PANTONE Violet C": [68, 0, 153],
    "PANTONE Purple C": [187, 41, 187],
    "PANTONE 513 C": [147, 62, 142],
    "PANTONE 519 C": [100, 41, 108],
    # Browns / Golds
    "PANTONE 469 C": [111, 62, 40],
    "PANTONE 478 C": [78, 39, 25],
    "PANTONE 1545 C": [114, 50, 19],
    "PANTONE 7519 C": [92, 76, 61],
    "PANTONE 871 C": [132, 117, 78],
    "PANTONE 872 C": [140, 117, 62],
    "PANTONE 873 C": [132, 109, 60],
    "PANTONE 874 C": [136, 115, 75],
    "PANTONE 10120 C": [154, 132, 94],
    # Special / Metallic
    "PANTONE 877 C": [155, 155, 155],  # Silver
    "PANTONE Silver C": [169, 169, 169],
    "PANTONE Gold C": [164, 137, 75],
    # Neutrals
    "PANTONE Black C": [29, 29, 27],
    "PANTONE Process Black C": [29, 29, 27],
    "PANTONE Cool Gray 1 C": [214, 210, 196],
    "PANTONE Cool Gray 5 C": [177, 179, 179],
    "PANTONE Cool Gray 9 C": [117, 120, 123],
    "PANTONE Cool Gray 11 C": [83, 86, 90],
    "PANTONE Warm Gray 1 C": [215, 210, 203],
    "PANTONE Warm Gray 5 C": [183, 176, 168],
    "PANTONE Warm Gray 9 C": [131, 120, 111],
    "PANTONE Warm Gray 11 C": [110, 98, 89],
    "PANTONE 7540 C": [77, 81, 86],
    "PANTONE 7544 C": [120, 133, 142],
    "PANTONE 7545 C": [66, 85, 99],
    "PANTONE 426 C": [37, 40, 42],
    "PANTONE 432 C": [51, 63, 72],
    "PANTONE 433 C": [29, 37, 45],
}


def _lookup_spot_rgb(spot_name: str) -> list[int]:
    """
    Find best-match RGB color for a spot ink name.
    Uses fuzzy matching: strips whitespace, normalizes case, tries substring.
    Falls back to a hash-based deterministic color.
    """
    # Direct match
    if spot_name in PANTONE_RGB_MAP:
        return PANTONE_RGB_MAP[spot_name]

    # Case-insensitive + normalized
    norm = spot_name.strip().upper().replace("  ", " ")
    for key, val in PANTONE_RGB_MAP.items():
        if key.upper() == norm:
            return val

    # Substring match (e.g. "485 C" matches "PANTONE 485 C")
    for key, val in PANTONE_RGB_MAP.items():
        # Extract just the number+suffix part
        key_core = key.replace("PANTONE ", "").strip().upper()
        if key_core and key_core in norm:
            return val

    # Also try: if spot_name contains a number, try PANTONE {number} C
    num_match = re.search(r'(\d{3,4})', spot_name)
    if num_match:
        num = num_match.group(1)
        for suffix in ["C", "U", "CP", "UP"]:
            trial = f"PANTONE {num} {suffix}"
            if trial in PANTONE_RGB_MAP:
                return PANTONE_RGB_MAP[trial]

    # Deterministic hash-based fallback (avoid random for reproducibility)
    import hashlib
    h = hashlib.md5(spot_name.encode()).hexdigest()
    r = int(h[0:2], 16)
    g = int(h[2:4], 16)
    b = int(h[4:6], 16)
    # Ensure it's visually distinct (not too dark, not too light)
    r = max(60, min(220, r))
    g = max(60, min(220, g))
    b = max(60, min(220, b))
    return [r, g, b]


class SeparationEngine:
    def __init__(self):
        # Base colors for the process plates (RGB, approximate ISO Coated v2 ink colors)
        self.PLATE_COLORS = {
            "Cyan": [0, 158, 224],      # #009EE0
            "Magenta": [226, 0, 122],   # #E2007A
            "Yellow": [255, 237, 0],    # #FFED00
            "Black": [29, 29, 27]       # #1D1D1B
        }

    # ──────────────────────────────────────────────────────────
    #  PUBLIC API
    # ──────────────────────────────────────────────────────────

    async def extract_separations(
        self, pdf_path: str, page_num: int, dpi: int = 72,
        cmyk_profile_id: str | None = "fogra39",
        *,
        rendering_intent: str = "relative",
        render_mode: str = "accurate",
        ink_accurate: bool = False,
        use_ppe: bool = True,
        output_preview_filter: str = "all",
    ) -> dict:
        """
        Extract separation plates (Acrobat Output Preview style).

        Strategy (theo thứ tự ưu tiên):
        1. **PrynX Print Engine (PPE)** — tách kẽm trong không gian mực n kênh.
        2. Nếu PPE không đủ tin cậy: PDFium RGB → CMYK xấp xỉ và ghi rõ độ tin cậy.

        ``render_mode=accurate`` ưu tiên PPE; ``render_mode=approximate`` buộc
        đường PDFium RGB xấp xỉ.

        ``use_ppe=False`` buộc đường xấp xỉ để phục vụ kiểm tra chéo.

        ``ink_accurate``:
          - True → DeviceCMYK ink coverage (no ICC, no AA) for TAC / ink-limit.
            Color-managed FOGRA soft-proof plates under-report solid TAC and must
            not be used for total-area-coverage gates.
        """
        if render_mode not in {"accurate", "approximate"}:
            raise ValueError(f"Chế độ tách kẽm không hợp lệ: {render_mode}")
        # PREFLIGHT (audit 2026-08-10 §OP.8): cùng intent phải đi xuyên suốt PPE,
        # alternate spot swatch và fallback metadata; không hard-code Relative ở giữa.
        intent_codes = {
            "perceptual": 0,
            "relative": 1,
            "saturation": 2,
            "absolute": 3,
        }
        normalized_intent = (rendering_intent or "relative").strip().lower()
        if normalized_intent not in intent_codes:
            raise ValueError(f"Rendering intent không hợp lệ: {rendering_intent}")
        force_approximate = render_mode == "approximate"
        try_ppe = bool(use_ppe) and not force_approximate
        normalized_filter = (output_preview_filter or "all").strip().lower()
        if normalized_filter != "all" and not try_ppe:
            raise ppe_facade.PpeUnavailable(
                f"Show={normalized_filter} cần đường tách kẽm PPE chính xác"
            )

        # ── Nhánh 1: PrynX Print Engine (PPE) ───────────────────────────────
        # PPE là engine chính duy nhất; chỉ nhận kết quả khi chính engine khai
        # là lượng mực đáng tin (`ink_unsound=False`). PPE tách kẽm trong không
        # gian mực n kênh nên spot/overprint là mô hình gốc, không phải mô phỏng;
        # bù lại nó chưa vẽ được shading/transparency, và những trang đó bị facade
        # loại thẳng thay vì trả số thấp hơn thực tế.
        #
        # Chế độ approximate là yêu cầu kiểm tra chéo có chủ đích nên KHÔNG được
        # lặng lẽ đưa PPE vào thay.
        if try_ppe:
            try:
                result = await asyncio.to_thread(
                    ppe_facade.separations,
                    pdf_path,
                    page_num,
                    dpi,
                    ink_accurate=ink_accurate,
                    cmyk_profile_id=cmyk_profile_id,
                    render_intent=intent_codes[normalized_intent],
                    output_preview_filter=normalized_filter,
                )
                if result.get("plates"):
                    # PREFLIGHT (audit 2026-08-10 §OP.E1): frontend đổi cỡ mẫu
                    # mm → pixel từ chính DPI artifact, không được ngầm đoán 150.
                    result["render_dpi"] = int(dpi)
                    return result
            except ppe_facade.PpeResultUntrusted as e:
                if normalized_filter != "all":
                    raise ppe_facade.PpeUnavailable(
                        f"PPE không thể lọc kẽm theo Show={normalized_filter}: {e}"
                    ) from e
                # Không phải lỗi: engine tự khai giới hạn; chuyển sang kết quả xấp xỉ có nhãn.
                logger.info("PPE không đủ tin cậy (trang %d), chuyển sang xấp xỉ: %s", page_num, e)
                # Không suy TAC từ bản dựng RGB: chuyển ngược RGB → CMYK phụ thuộc
                # profile, GCR/UCR và không khôi phục được lượng mực gốc. Chỉ trả
                # "không kiểm được" khi chính nguyên nhân PPE từ chối là không gian
                # màu đã phải xấp xỉ; các giới hạn dựng hình khác vẫn đi fallback có nhãn.
                if ink_accurate and e.detail.get("approximated_colorspaces"):
                    spot_names = await asyncio.to_thread(
                        self._detect_spot_inks, pdf_path
                    )
                    result = self._tac_unverifiable(
                        spot_names,
                        reason=str(e),
                        approximated=list(e.detail.get("approximated_colorspaces") or []),
                    )
                    result["render_dpi"] = int(dpi)
                    return result
            except ppe_facade.PpeUnavailable as e:
                if normalized_filter != "all":
                    raise
                logger.debug("PPE chưa khả dụng: %s", e)
            except Exception as e:  # noqa: BLE001
                if normalized_filter != "all":
                    raise
                logger.warning("PPE lỗi (trang %d): %s. Chuyển sang xấp xỉ.", page_num, e)

        # PDFium render + resource traversal đều là I/O/CPU blocking. Không chạy
        # trực tiếp trên event loop của route Preflight.
        result = await asyncio.to_thread(
            self._run_pikepdf_fallback,
            pdf_path,
            page_num,
            dpi,
            cmyk_profile_id,
            normalized_intent,
        )
        result["engine"] = "pdfium_approx"
        result["accuracy"] = "approximate"
        result["render_dpi"] = int(dpi)
        result["quality_note"] = (
            "Xấp xỉ: PDF→RGB→tách CMYK giả (không ICC). PrynX PPE chưa dựng "
            "được trang này đủ tin cậy; không dùng kết quả để chốt kẽm."
        )
        return result

    def _tac_unverifiable(
        self, spot_names: list[str], *, reason: str, approximated: list[str]
    ) -> dict:
        """Kết quả "không kiểm được tổng mực" — KHÔNG kèm plate nào.

        Cố ý trả `plates = []`: nếu trả kẽm xấp xỉ từ RGB, `ink.py` sẽ tính TAC
        trên dữ liệu không còn phản ánh lượng mực gốc. Không có plate thì không thể
        kết luận sai.

        `engine` KHÔNG nằm trong `TAC_TRUSTED_ENGINES`, nên `ink.py` tự động phát
        issue "chưa kiểm được TAC" thay vì coi trang là đạt ngưỡng — đường fail-loud
        đã có sẵn, không cần nhánh riêng.
        """
        return {
            "width": 0,
            "height": 0,
            "plates": [],
            "has_spot_colors": bool(spot_names),
            "detected_spots": spot_names,
            "engine": "unverifiable_ink",
            "accuracy": "unverifiable",
            "quality_note": (
                "Chưa kiểm được tổng mực: nội dung dùng màu chưa quản lý được "
                f"({', '.join(approximated) or 'không rõ'}). "
                "PrynX Print Engine cần dữ liệu màu đầu vào đủ tin cậy; bản dựng "
                "RGB không thể khôi phục chính xác lượng mực gốc. Thà không kết luận "
                "còn hơn kết luận sai."
            ),
            "ppe_reject_reason": reason,
        }

    # ──────────────────────────────────────────────────────────
    #  SPOT COLOR DETECTION (Quick Scan)
    # ──────────────────────────────────────────────────────────

    def _detect_spot_inks(self, pdf_path: str) -> list[str]:
        """Inventory spot toàn tài liệu từ resource traversal dùng chung."""
        from app.core.ink_manager import analyze_ink_inventory

        inventory = analyze_ink_inventory(pdf_path)
        return [
            item["name"]
            for item in inventory.get("document_colorants", [])
            if item.get("is_spot")
        ]

    # ──────────────────────────────────────────────────────────
    #  PYPDFIUM2 FALLBACK (CMYK Process only — fast)
    # ──────────────────────────────────────────────────────────

    def _run_pikepdf_fallback(
        self,
        pdf_path: str,
        page_num: int,
        dpi: int,
        cmyk_profile_id: str | None = "fogra39",
        rendering_intent: str = "relative",
    ) -> dict:
        """Fallback: render page via pypdfium2 and split into pseudo-CMYK plates."""
        import pypdfium2 as pdfium
        from app.core.pdfium_lock import pdfium_guard

        # KIENTRUC (audit 2026-07-29 §C.1): tách kẽm chạy qua `asyncio.to_thread`.
        # Khóa CHỈ bao phần PDFium (mở + render + to_pil); toán numpy phía dưới nặng
        # nhưng thuần Python/BLAS nên để ngoài khóa cho vẫn song song được.
        with pdfium_guard("separations_pdfium_fallback"):
            pdf_doc = pdfium.PdfDocument(pdf_path)
            page = pdf_doc[page_num - 1]
            scale = dpi / 72.0
            bitmap = page.render(scale=scale)
            img = bitmap.to_pil()  # RGB PIL Image
        arr_rgb = np.array(img)
        width, height = img.size

        # XẤP XỈ: RGB → CMYK bằng công thức GCR/UCR đơn giản (KHÔNG ICC, dot gain
        # hoặc FOGRA). Đường này chỉ phục vụ xem nhanh; % mực C/M/Y/K có thể lệch
        # xa RIP/Acrobat. Kết quả LUÔN gắn accuracy="approximate" (xem caller).
        r = arr_rgb[:, :, 0].astype(np.float32) / 255.0
        g = arr_rgb[:, :, 1].astype(np.float32) / 255.0
        b = arr_rgb[:, :, 2].astype(np.float32) / 255.0

        k = 1.0 - np.maximum(np.maximum(r, g), b)
        denom = np.where(k < 1.0, 1.0 - k, 1.0)
        c = (1.0 - r - k) / denom
        m = (1.0 - g - k) / denom
        y = (1.0 - b - k) / denom

        cmyk_channels = {
            "Cyan": (np.clip(c * 255, 0, 255)).astype(np.uint8),
            "Magenta": (np.clip(m * 255, 0, 255)).astype(np.uint8),
            "Yellow": (np.clip(y * 255, 0, 255)).astype(np.uint8),
            "Black": (np.clip(k * 255, 0, 255)).astype(np.uint8),
        }

        plates = []
        for name in ["Cyan", "Magenta", "Yellow", "Black"]:
            plate_info = self._create_colored_plate(name, cmyk_channels[name])
            plates.append(plate_info)

        # PREFLIGHT (audit 2026-08-10 §OP.4/5): fallback vẫn phải trả cùng
        # contract inventory/metadata như PPE, không tự điền DeviceCMYK/false.
        inventory = None
        inventory_error = None
        page_inventory: dict = {}
        document_colorants: list[dict] = []
        spot_inks: list[dict] = []
        try:
            from app.core.ink_manager import analyze_ink_inventory, colorant_rgb_map

            inventory = analyze_ink_inventory(pdf_path)
            document_colorants = list(inventory.get("document_colorants", []))
            page_inventory = next(
                (
                    item for item in inventory.get("pages", [])
                    if int(item.get("page", 0)) == page_num
                ),
                {},
            )
            display = colorant_rgb_map(
                document_colorants,
                cmyk_profile_id or "fogra39",
                rendering_intent=rendering_intent,
            )
            for colorant in document_colorants:
                if not colorant.get("is_spot"):
                    continue
                name = colorant["name"]
                swatch = display.get(name, {})
                spot_inks.append({
                    "name": name,
                    "rgb": swatch.get("rgb") or _lookup_spot_rgb(name),
                    "coverage_pct": 0.0,
                    "is_pantone": "pantone" in name.lower(),
                    "present_on_page": name in page_inventory.get("spot_colorants", []),
                    "pages": list(colorant.get("pages") or []),
                    "alternate_space": colorant.get("alternate_space"),
                    "alternate_cmyk": colorant.get("alternate_cmyk"),
                    "color_source": swatch.get("source") or "name_fallback",
                })
        except Exception as exc:  # noqa: BLE001
            inventory_error = str(exc)
            logger.warning("Không đọc được inventory ở separations fallback: %s", exc)

        # KIENTRUC (audit 2026-07-29 §C.1): `close()` cũng là lời gọi PDFium → phải
        # trong guard. Giữ nguyên thứ tự cũ (đóng SAU khi đã dùng xong `img`) vì
        # `bitmap.to_pil()` có thể tham chiếu bộ đệm của bitmap.
        with pdfium_guard("separations_pdfium_close"):
            pdf_doc.close()

        return {
            "width": width,
            "height": height,
            "plates": plates,
            "spot_inks": spot_inks,
            "has_spot_colors": bool(spot_inks),
            "detected_spots": [item["name"] for item in spot_inks],
            "document_colorants": document_colorants,
            "page_colorants": list(page_inventory.get("colorants") or []),
            "page_spot_colorants": list(page_inventory.get("spot_colorants") or []),
            "page_has_transparency": page_inventory.get("page_has_transparency"),
            "blending_color_space": page_inventory.get("blending_color_space"),
            "inventory_source": (inventory or {}).get("metadata_source"),
            "inventory_error": inventory_error,
        }

    # ──────────────────────────────────────────────────────────
    #  SHARED: Create plate data with compressed alpha
    # ──────────────────────────────────────────────────────────

    def _create_colored_plate(
        self, name: str, ink_density: np.ndarray, is_spot: bool = False
    ) -> dict:
        """
        Returns plate info with compressed alpha channel data.
        Frontend reconstructs the RGBA image from color + alpha.
        This is 10-50x faster than PNG encoding.
        """
        # Determine RGB color for the plate
        if name in self.PLATE_COLORS:
            base_color = self.PLATE_COLORS[name]
        else:
            # Use Pantone lookup for spot colors
            base_color = _lookup_spot_rgb(name)

        # Compress raw alpha bytes with fast zlib (level 1)
        raw_bytes = ink_density.astype(np.uint8).tobytes()
        compressed = zlib.compress(raw_bytes, level=1)
        alpha_b64 = base64.b64encode(compressed).decode("utf-8")

        return {
            "name": name,
            "color": base_color,
            "alpha_data": alpha_b64,  # zlib-compressed, base64-encoded alpha channel
            "is_spot": is_spot,
        }
