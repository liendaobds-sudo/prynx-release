"""
Rust Native Bridge — Python interface to the pdfcompare_native Rust module.

This module provides a clean API that:
1. Tries the Rust native module first (fast, precise PDFium FFI)
2. Falls back to pikepdf/pypdfium2/pdfplumber if Rust module is unavailable

Usage:
    from app.core.rust_bridge import RustBridge
    bridge = RustBridge()
    
    objects = bridge.get_page_objects("input.pdf", page=1)
    svg = bridge.render_page_svg("input.pdf", page=1, dpi=200)
    pdf_bytes = bridge.delete_objects("input.pdf", page=1, indices=[0, 3, 5])
"""
import logging
import os
import tempfile
import base64

logger = logging.getLogger(__name__)

# Auto-detect pdfium.dll location before importing Rust module
if "PDFIUM_DLL_PATH" not in os.environ:
    # Check native/pdfium_lib/bin/ (bblanchon official binary)
    _native_pdfium = os.path.normpath(
        os.path.join(os.path.dirname(__file__), "..", "..", "..", "native", "pdfium_lib", "bin")
    )
    if os.path.isfile(os.path.join(_native_pdfium, "pdfium.dll")):
        os.environ["PDFIUM_DLL_PATH"] = _native_pdfium
    elif "VIRTUAL_ENV" not in os.environ:
        # Try to detect venv from sys.prefix
        import sys
        os.environ["VIRTUAL_ENV"] = sys.prefix

# Try to import Rust native module
try:
    import pdfcompare_native as _native
    RUST_AVAILABLE = True
    logger.info("Rust native module loaded successfully")
except ImportError:
    RUST_AVAILABLE = False
    logger.warning("Rust native module not available — using Python fallback")


class RustBridge:
    """Unified interface to PDF operations with Rust/Python fallback."""

    @property
    def is_rust_available(self) -> bool:
        return RUST_AVAILABLE

    # ─── Page Object Enumeration ────────────────────────────────

    def get_page_objects(self, pdf_path: str, page: int) -> list[dict]:
        """
        Enumerate all objects (text, image, drawing) on a page with precise bboxes.
        
        Returns list of dicts:
            [{"type": "text"|"image"|"drawing", "bbox": [x0,y0,x1,y1], "content": str?, "index": int}]
        """
        if RUST_AVAILABLE:
            try:
                return _native.enumerate_page_objects(pdf_path, page)
            except Exception as e:
                logger.warning(f"Rust enumerate_page_objects failed: {e}, falling back to Python")

        return self._fallback_get_objects(pdf_path, page)

    def _fallback_get_objects(self, pdf_path: str, page: int) -> list[dict]:
        """Fallback using pdfplumber + pikepdf."""
        objects = []
        idx = 0

        # Text via pdfplumber
        try:
            import pdfplumber
            with pdfplumber.open(pdf_path) as plumber:
                p = plumber.pages[page - 1]
                for w in (p.extract_words() or []):
                    objects.append({
                        "type": "text",
                        "bbox": [w["x0"], w["top"], w["x1"], w["bottom"]],
                        "content": w.get("text", ""),
                        "index": idx,
                    })
                    idx += 1
        except Exception as e:
            logger.debug(f"pdfplumber fallback failed: {e}")

        # Images via pikepdf
        try:
            import pikepdf
            doc = pikepdf.Pdf.open(pdf_path)
            pike_page = doc.pages[page - 1]
            resources = pike_page.get("/Resources")
            if resources:
                xobjects = resources.get("/XObject")
                if xobjects:
                    for name, ref in xobjects.items():
                        try:
                            obj = ref
                            if hasattr(ref, 'resolve'):
                                obj = ref.resolve() if callable(getattr(ref, 'resolve', None)) else ref
                            if str(obj.get("/Subtype", "")) == "/Image":
                                w = int(obj.get("/Width", 0))
                                h = int(obj.get("/Height", 0))
                                if w <= 1 and h <= 1:
                                    continue
                                mb = pike_page.get("/MediaBox")
                                if mb:
                                    bbox = [float(mb[0]), float(mb[1]), float(mb[2]), float(mb[3])]
                                else:
                                    bbox = [0, 0, 595, 842]
                                objects.append({
                                    "type": "image",
                                    "bbox": bbox,
                                    "index": idx,
                                })
                                idx += 1
                        except Exception:
                            pass
            doc.close()
        except Exception as e:
            logger.debug(f"pikepdf image fallback failed: {e}")

        return objects

    # ─── SVG Rendering ──────────────────────────────────────────

    def render_page_svg(self, pdf_path: str, page: int, dpi: int = 200) -> str:
        """Render page as SVG string with vector paths + raster background."""
        if RUST_AVAILABLE:
            try:
                return _native.render_page_svg(pdf_path, page, dpi)
            except Exception as e:
                logger.warning(f"Rust render_page_svg failed: {e}, falling back to Python")

        return self._fallback_render_svg(pdf_path, page, dpi)

    def _fallback_render_svg(self, pdf_path: str, page: int, dpi: int) -> str:
        """Fallback: render via pypdfium2 and wrap in SVG."""
        import pypdfium2 as pdfium
        pdf_doc = pdfium.PdfDocument(pdf_path)
        p = pdf_doc[page - 1]
        scale = dpi / 72.0
        bitmap = p.render(scale=scale)
        img = bitmap.to_pil()
        pdf_doc.close()

        import io
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        png_b64 = base64.b64encode(buf.getvalue()).decode("utf-8")

        w, h = img.size
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}">'
            f'<image href="data:image/png;base64,{png_b64}" width="{w}" height="{h}"/>'
            f'</svg>'
        )

    # ─── Object Deletion ────────────────────────────────────────

    def delete_objects(self, pdf_path: str, page: int, indices: list[int]) -> bytes | None:
        """
        Delete objects at given indices from a page.
        Returns modified PDF bytes, or None if failed.
        """
        if RUST_AVAILABLE:
            try:
                return _native.delete_page_objects(pdf_path, page, indices)
            except Exception as e:
                logger.warning(f"Rust delete_page_objects failed: {e}, falling back to Python")

        return self._fallback_delete_objects(pdf_path, page, indices)

    def _fallback_delete_objects(self, pdf_path: str, page: int, indices: list[int]) -> bytes | None:
        """Fallback: limited deletion via pikepdf (images only)."""
        try:
            import pikepdf
            doc = pikepdf.Pdf.open(pdf_path)
            pike_page = doc.pages[page - 1]
            resources = pike_page.get("/Resources")
            if resources:
                xobjects = resources.get("/XObject")
                if xobjects:
                    for name in list(xobjects.keys()):
                        try:
                            obj = xobjects[name]
                            if hasattr(obj, 'resolve'):
                                obj = obj.resolve()
                            if str(obj.get("/Subtype", "")) == "/Image":
                                del xobjects[name]
                        except Exception:
                            pass
            import io
            buf = io.BytesIO()
            doc.save(buf)
            doc.close()
            return buf.getvalue()
        except Exception as e:
            logger.error(f"Fallback delete failed: {e}")
            return None

    # ─── Page Image Rendering ───────────────────────────────────

    def render_page_image(self, pdf_path: str, page: int, dpi: int = 200) -> bytes | None:
        """Render page to JPEG bytes."""
        if RUST_AVAILABLE:
            try:
                return _native.render_page_image(pdf_path, page, dpi)
            except Exception as e:
                logger.warning(f"Rust render_page_image failed: {e}, falling back to Python")

        return self._fallback_render_image(pdf_path, page, dpi)

    def _fallback_render_image(self, pdf_path: str, page: int, dpi: int) -> bytes | None:
        """Fallback: render via pypdfium2."""
        try:
            import pypdfium2 as pdfium
            pdf_doc = pdfium.PdfDocument(pdf_path)
            p = pdf_doc[page - 1]
            bitmap = p.render(scale=dpi / 72.0)
            img = bitmap.to_pil()
            pdf_doc.close()

            import io
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=92)
            return buf.getvalue()
        except Exception as e:
            logger.error(f"Fallback render failed: {e}")
            return None

    # ─── OCG Layer Management ───────────────────────────────────

    def get_ocg_layers(self, pdf_path: str) -> list[dict]:
        """Get OCG layers from PDF."""
        # Always use pikepdf for OCG listing (better dict access)
        return self._pikepdf_get_layers(pdf_path)

    def _pikepdf_get_layers(self, pdf_path: str) -> list[dict]:
        """Parse OCG layers via pikepdf."""
        try:
            import pikepdf
            doc = pikepdf.Pdf.open(pdf_path)
            layers = []
            oc_props = doc.Root.get("/OCProperties")
            if oc_props:
                ocgs = oc_props.get("/OCGs", [])
                d_dict = oc_props.get("/D", {})
                off_list = d_dict.get("/OFF", [])
                off_refs = set()
                for item in off_list:
                    try:
                        off_refs.add(id(item))
                    except Exception:
                        pass

                for i, ocg_ref in enumerate(ocgs):
                    try:
                        ocg = ocg_ref
                        if hasattr(ocg_ref, 'resolve'):
                            ocg = ocg_ref.resolve()
                        name = str(ocg.get("/Name", f"Layer {i}"))
                        visible = id(ocg_ref) not in off_refs
                        layers.append({
                            "name": name,
                            "index": i,
                            "visible": visible,
                            "ref": ocg_ref,  # Keep reference for toggle
                        })
                    except Exception:
                        pass
            doc.close()
            return layers
        except Exception as e:
            logger.error(f"OCG layer parsing failed: {e}")
            return []

    def render_with_hidden_layers(
        self, pdf_path: str, page: int, dpi: int, hidden_indices: list[int]
    ) -> bytes | None:
        """
        Render page with specific OCG layers hidden.
        
        Strategy:
        1. pikepdf modifies /OCProperties → /D → /OFF array
        2. Save to temp file
        3. Rust (or pypdfium2 fallback) renders the modified PDF
        """
        try:
            import pikepdf

            doc = pikepdf.Pdf.open(pdf_path)
            oc_props = doc.Root.get("/OCProperties")
            if not oc_props:
                doc.close()
                return self.render_page_image(pdf_path, page, dpi)

            ocgs = list(oc_props.get("/OCGs", []))
            d_dict = oc_props.get("/D")
            if d_dict is None:
                d_dict = pikepdf.Dictionary()
                oc_props[pikepdf.Name("/D")] = d_dict

            # Build new /OFF array with hidden layer refs
            off_array = pikepdf.Array()
            for idx in hidden_indices:
                if idx < len(ocgs):
                    off_array.append(ocgs[idx])

            d_dict[pikepdf.Name("/OFF")] = off_array

            # Save to temp
            tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
            doc.save(tmp.name)
            doc.close()

            # Render the modified PDF
            result = self.render_page_image(tmp.name, page, dpi)

            try:
                os.unlink(tmp.name)
            except Exception:
                pass

            return result

        except Exception as e:
            logger.error(f"Layer toggle render failed: {e}")
            return self.render_page_image(pdf_path, page, dpi)
