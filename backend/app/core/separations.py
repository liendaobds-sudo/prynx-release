import os
import re
import uuid
import asyncio
import logging
import base64
import zlib
import numpy as np
import pikepdf
from PIL import Image
from pathlib import Path
from app.config import settings

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
        self.gs_path = settings.GHOSTSCRIPT_PATH
        self.output_dir = Path(settings.RESULTS_DIR) / "separations"
        self.output_dir.mkdir(parents=True, exist_ok=True)

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
        use_ghostscript: bool = False
    ) -> dict:
        """
        Extracts separation plates for a specific page.

        Strategy (Hybrid Auto-Detect):
        1. If use_ghostscript=True → force Ghostscript mode
        2. Else → quick-scan for Spot inks in the PDF:
           - If Spot found → auto-use Ghostscript (with fallback)
           - If CMYK only → use fast pikepdf
        """
        has_spots = False
        spot_names: list[str] = []

        if not use_ghostscript:
            # Quick scan for spot colors (< 50ms)
            spot_names = self._detect_spot_inks(pdf_path)
            has_spots = len(spot_names) > 0
            if has_spots:
                logger.info(f"Auto-detected {len(spot_names)} spot inks: {spot_names}. Switching to Ghostscript.")
                use_ghostscript = True

        if use_ghostscript:
            try:
                result = await self._run_ghostscript_tiffsep(pdf_path, page_num, dpi)
                if result and len(result.get("plates", [])) > 0:
                    result["has_spot_colors"] = True
                    result["detected_spots"] = spot_names
                    result["engine"] = "ghostscript"
                    return result
            except Exception as e:
                logger.warning(f"Ghostscript tiffsep failed: {e}. Falling back to pikepdf.")

        # pikepdf is the fast default (Process CMYK only)
        result = self._run_pikepdf_fallback(pdf_path, page_num, dpi)
        result["has_spot_colors"] = has_spots
        result["detected_spots"] = spot_names
        result["engine"] = "pikepdf"
        return result

    # ──────────────────────────────────────────────────────────
    #  SPOT COLOR DETECTION (Quick Scan)
    # ──────────────────────────────────────────────────────────

    def _detect_spot_inks(self, pdf_path: str) -> list[str]:
        """
        Quick scan PDF for Separation/DeviceN color spaces.
        Uses pikepdf xref_object text parsing — very fast (< 50ms).
        Returns list of spot ink names found.
        """
        spot_names = []
        seen = set()

        try:
            doc = pikepdf.Pdf.open(pdf_path)
            for page_idx in range(len(doc.pages)):
                page = doc.pages[page_idx]
                try:
                    page_obj = str(page.obj)

                    # Find /Separation /SpotName entries
                    sep_matches = re.findall(r'/Separation\s*/([^\s/\[\]]+)', page_obj)
                    for spot_name in sep_matches:
                        # Decode PDF name encoding (#XX → char)
                        decoded = re.sub(
                            r'#([0-9A-Fa-f]{2})',
                            lambda m: chr(int(m.group(1), 16)),
                            spot_name
                        )
                        if decoded not in seen and decoded not in ("All", "None"):
                            seen.add(decoded)
                            spot_names.append(decoded)

                    # Also check ColorSpace dict refs for deeper scan
                    cs_refs = re.findall(r'/CS\d+\s+(\d+)\s+\d+\s+R', page_obj)
                    for ref in cs_refs:
                        try:
                            obj_str = str(doc.get_object(int(ref)))
                            sep_names = re.findall(r'/Separation\s*/([^\s/\[\]]+)', obj_str)
                            for sn in sep_names:
                                decoded = re.sub(
                                    r'#([0-9A-Fa-f]{2})',
                                    lambda m: chr(int(m.group(1), 16)),
                                    sn
                                )
                                if decoded not in seen and decoded not in ("All", "None"):
                                    seen.add(decoded)
                                    spot_names.append(decoded)
                        except Exception:
                            pass

                    # Also scan DeviceN arrays for spot names
                    devicen_matches = re.findall(r'/DeviceN\s*\[([^\]]+)\]', page_obj)
                    for dn_match in devicen_matches:
                        names = re.findall(r'/([^\s/\[\]]+)', dn_match)
                        for n in names:
                            decoded = re.sub(
                                r'#([0-9A-Fa-f]{2})',
                                lambda m: chr(int(m.group(1), 16)),
                                n
                            )
                            if decoded not in seen and decoded not in ("Cyan", "Magenta", "Yellow", "Black", "All", "None"):
                                seen.add(decoded)
                                spot_names.append(decoded)

                except Exception as e:
                    logger.debug(f"Spot scan failed for page {page_idx}: {e}")

            doc.close()
        except Exception as e:
            logger.warning(f"Spot ink detection failed: {e}")

        return spot_names

    # ──────────────────────────────────────────────────────────
    #  GHOSTSCRIPT TIFFSEP (supports Spot Colors)
    # ──────────────────────────────────────────────────────────

    async def _run_ghostscript_tiffsep(self, pdf_path: str, page_num: int, dpi: int) -> dict:
        """Run Ghostscript tiffsep to generate plate TIFFs, then convert to base64 PNGs."""
        import subprocess
        import shutil
        from app.utils.subprocess_utils import run_hidden

        job_id = uuid.uuid4().hex[:8]
        job_dir = self.output_dir / job_id
        job_dir.mkdir(exist_ok=True)

        output_base = str(job_dir / "plate")

        cmd = [
            self.gs_path,
            "-sDEVICE=tiffsep",
            "-dNOPAUSE", "-dBATCH", "-dSAFER",
            f"-dFirstPage={page_num}", f"-dLastPage={page_num}",
            f"-r{dpi}",
            "-dGraphicsAlphaBits=4",
            "-dTextAlphaBits=4",
            "-dMaxSpots=32",
            f"-sOutputFile={output_base}.tif",
            pdf_path
        ]

        def _run_sync():
            return run_hidden(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=120,
            )

        res = await asyncio.to_thread(_run_sync)

        # Parse stderr for %%SeparationName lines (Ghostscript reports spot names here)
        stderr_text = res.stderr.decode("utf-8", errors="ignore")
        gs_spot_names = re.findall(r'%%SeparationName:\s*(.+)', stderr_text)
        gs_spot_names = [n.strip() for n in gs_spot_names if n.strip()]
        if gs_spot_names:
            logger.info(f"GS detected spot inks from stderr: {gs_spot_names}")

        if res.returncode != 0:
            logger.error(f"GS tiffsep stderr: {stderr_text[:500]}")
            raise RuntimeError(f"GS exited with {res.returncode}")

        plates = []
        width, height = 0, 0
        spot_inks_meta = []

        # tiffsep output patterns vary by Ghostscript version:
        #   Pattern A: plate(Cyan).tif, plate(PANTONE 485 C).tif
        #   Pattern B: plate.Cyan.tif, plate.PANTONE 485 C.tif
        #   Composite: plate.tif (skip this)
        for file in os.listdir(job_dir):
            if not file.endswith(".tif"):
                continue

            # Skip the composite file
            if file == "plate.tif":
                continue

            # Extract ink name from filename
            name_part = None

            # Pattern A: plate(Name).tif
            match_a = re.match(r'^plate\((.+)\)\.tif$', file)
            if match_a:
                name_part = match_a.group(1)

            # Pattern B: plate.Name.tif  (but NOT plate.tif itself)
            if not name_part:
                match_b = re.match(r'^plate\.(.+)\.tif$', file)
                if match_b:
                    name_part = match_b.group(1)

            # Pattern C: plate%d(Name).tif  (multi-page output)
            if not name_part:
                match_c = re.match(r'^plate\d*\((.+)\)\.tif$', file)
                if match_c:
                    name_part = match_c.group(1)

            if not name_part:
                logger.debug(f"Skipping unrecognized tiffsep output: {file}")
                continue

            # Read TIFF
            tif_path = job_dir / file
            try:
                img = Image.open(tif_path)
                if width == 0:
                    width, height = img.size

                arr = np.array(img)

                # tiffsep is inverted: 255 = no ink, 0 = 100% ink
                ink_density = 255 - arr

                # Determine if this is a spot color
                is_spot = name_part not in ("Cyan", "Magenta", "Yellow", "Black")

                plate_info = self._create_colored_plate(name_part, ink_density, is_spot=is_spot)
                plates.append(plate_info)

                # Build spot metadata
                if is_spot:
                    rgb = plate_info["color"]
                    total_ink = int(np.sum(ink_density > 5))
                    coverage_pct = round(total_ink / (width * height) * 100, 1) if width > 0 else 0
                    spot_inks_meta.append({
                        "name": name_part,
                        "rgb": rgb,
                        "coverage_pct": coverage_pct,
                        "is_pantone": "pantone" in name_part.lower(),
                    })

            except Exception as e:
                logger.warning(f"Failed to read tiffsep plate '{file}': {e}")
                continue

        # Cleanup
        shutil.rmtree(job_dir, ignore_errors=True)

        # Sort plates: Cyan, Magenta, Yellow, Black, then Spots alphabetically
        order = {"Cyan": 0, "Magenta": 1, "Yellow": 2, "Black": 3}
        plates.sort(key=lambda p: (order.get(p["name"], 99), p["name"]))

        if not plates:
            raise RuntimeError("No plates generated by Ghostscript tiffsep")

        # Page metadata (using pikepdf — fast, just reads dictionary)
        page_has_transparency = False
        blending_cs = "DeviceCMYK"
        try:
            doc = pikepdf.Pdf.open(pdf_path)
            page = doc.pages[page_num - 1]
            group = page.get("/Group")
            if group:
                page_has_transparency = True
                cs = group.get("/CS")
                if cs:
                    cs_name = str(cs)
                    if "CMYK" in cs_name:
                        blending_cs = "DeviceCMYK"
                    elif "RGB" in cs_name:
                        blending_cs = "DeviceRGB"
                    elif "Gray" in cs_name:
                        blending_cs = "DeviceGray"
            doc.close()
        except Exception:
            pass

        return {
            "width": width,
            "height": height,
            "plates": plates,
            "spot_inks": spot_inks_meta,
            "page_has_transparency": page_has_transparency,
            "blending_color_space": blending_cs,
        }

    # ──────────────────────────────────────────────────────────
    #  PYPDFIUM2 FALLBACK (CMYK Process only — fast)
    # ──────────────────────────────────────────────────────────

    def _run_pikepdf_fallback(self, pdf_path: str, page_num: int, dpi: int) -> dict:
        """Fallback: render page via pypdfium2 and split into pseudo-CMYK plates."""
        import pypdfium2 as pdfium

        pdf_doc = pdfium.PdfDocument(pdf_path)
        page = pdf_doc[page_num - 1]
        scale = dpi / 72.0
        bitmap = page.render(scale=scale)
        img = bitmap.to_pil()  # RGB PIL Image
        arr_rgb = np.array(img)
        width, height = img.size

        # Simple RGB → CMYK conversion (same as Ghostscript's formula)
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

        # Page metadata via pikepdf
        page_has_transparency = False
        blending_cs = "DeviceCMYK"
        try:
            pike_doc = pikepdf.Pdf.open(pdf_path)
            pike_page = pike_doc.pages[page_num - 1]
            group = pike_page.get("/Group")
            if group:
                page_has_transparency = True
                cs = group.get("/CS")
                if cs:
                    cs_name = str(cs)
                    if "CMYK" in cs_name:
                        blending_cs = "DeviceCMYK"
                    elif "RGB" in cs_name:
                        blending_cs = "DeviceRGB"
                    elif "Gray" in cs_name:
                        blending_cs = "DeviceGray"
            pike_doc.close()
        except Exception:
            pass

        pdf_doc.close()

        return {
            "width": width,
            "height": height,
            "plates": plates,
            "spot_inks": [],
            "page_has_transparency": page_has_transparency,
            "blending_color_space": blending_cs,
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
