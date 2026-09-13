"""
Stealth watermark embedder for PDF output.

Embeds license tracing info invisibly into every output PDF:
  - Layer 1: XMP custom metadata (prynx namespace) — fast forensic lookup
  - Layer 2: Invisible text outside trim box (PDF render mode 3) — survives metadata strip

Usage:
    from app.core.watermark import embed_watermark
    embed_watermark(pikepdf_doc, license_key="xxx", hwid="yyy")
    pikepdf_doc.save(output_path)
"""
import hashlib
import time
import logging
import pikepdf

logger = logging.getLogger(__name__)


def _hash_id(value: str) -> str:
    """SHA-256 truncated to 16 hex chars — never exposes raw license key."""
    return hashlib.sha256(value.encode()).hexdigest()[:16]


def _build_xmp_packet(lid: str, hid: str, ts: str) -> str:
    """Build XMP packet with prynx custom namespace."""
    return (
        '<?xpacket begin="\xef\xbb\xbf" id="W5M0MpCehiHzreSzNTczkc9d"?>'
        '<x:xmpmeta xmlns:x="adobe:ns:meta/">'
        '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        '<rdf:Description rdf:about=""'
        ' xmlns:px="http://prynx.com/ns/1.0/"'
        f' px:lid="{lid}"'
        f' px:hid="{hid}"'
        f' px:ts="{ts}"/>'
        '</rdf:RDF>'
        '</x:xmpmeta>'
        '<?xpacket end="w"?>'
    )


def _ensure_font(pike_page: pikepdf.Page, pdf: pikepdf.Pdf) -> str:
    """Ensure Helvetica font exists in page resources, return font key."""
    resources = pike_page.get("/Resources")
    if resources is None:
        pike_page["/Resources"] = pikepdf.Dictionary()
        resources = pike_page["/Resources"]

    fonts = resources.get("/Font")
    if fonts is None:
        resources["/Font"] = pikepdf.Dictionary()
        fonts = resources["/Font"]

    # Check if Helvetica already registered
    for key, val in fonts.items():
        if isinstance(val, pikepdf.Dictionary):
            bn = str(val.get("/BaseFont", ""))
            if "Helvetica" in bn:
                return str(key).lstrip("/")

    # Register new font
    idx = len(fonts)
    font_key = f"FW{idx}"
    fonts[pikepdf.Name(f"/{font_key}")] = pikepdf.Dictionary({
        "/Type": pikepdf.Name("/Font"),
        "/Subtype": pikepdf.Name("/Type1"),
        "/BaseFont": pikepdf.Name("/Helvetica"),
    })
    return font_key


def _is_cut_page(page: pikepdf.Page) -> bool:
    """Check if page is a die-cut / finishing page (skip text watermark to prevent Corel/plotter crash)."""
    try:
        if "/PSHomogCut" in page:
            return True
        resources = page.get("/Resources")
        if resources and "/Properties" in resources:
            props = resources["/Properties"]
            for _, val in props.items():
                name = str(val.get("/Name", ""))
                if any(k in name for k in ("Cutline", "cut_page", "MarkLine", "Marks_Model_")):
                    return True
    except Exception:
        pass
    return False


def embed_watermark(doc, license_key: str, hwid: str = "") -> bool:
    """
    Embed invisible watermark into a pikepdf.Pdf or pdf_wrapper.Document.

    Args:
        doc: pikepdf.Pdf instance OR pdf_wrapper.Document (has ._pdf attribute)
        license_key: The user's license key (will be hashed, never stored raw)
        hwid: Hardware ID (will be hashed)

    Returns:
        True if watermark was embedded, False if skipped
    """
    if not license_key:
        return False

    # Support both pikepdf.Pdf and pdf_wrapper.Document
    pdf = doc._pdf if hasattr(doc, '_pdf') else doc

    try:
        lid = _hash_id(license_key)
        hid = _hash_id(hwid) if hwid else "0"
        ts = str(int(time.time()))
        tag = f"PX_{lid}_{hid}_{ts}"

        # ── Layer 1: XMP Metadata ──
        # Ghi THẲNG gói XMP đã dựng vào catalog /Metadata, thay vì dùng API typed
        # của pikepdf (open_metadata[...] suy luận kiểu cho khoá lạ → log ERROR
        # "prynx:ts should be set to a list of strings" mỗi lần chạy và có thể bỏ
        # qua giá trị). Cách này không gây lỗi và nhúng đúng lid/hid/ts.
        try:
            xmp_packet = _build_xmp_packet(lid, hid, ts)
            meta_stream = pdf.make_stream(xmp_packet.encode('utf-8'))
            meta_stream[pikepdf.Name("/Type")] = pikepdf.Name("/Metadata")
            meta_stream[pikepdf.Name("/Subtype")] = pikepdf.Name("/XML")
            pdf.Root[pikepdf.Name("/Metadata")] = meta_stream
        except Exception as e:
            logger.debug(f"[WATERMARK] XMP write skipped: {e}")

        # ── Layer 2: Invisible text on each page ──
        for page in pdf.pages:
            try:
                if _is_cut_page(page):
                    continue
                mb = page.mediabox
                page_h = float(mb[3] - mb[1])

                font_key = _ensure_font(page, pdf)

                # Escape text for PDF string
                escaped = tag.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

                # Position: bottom-left corner, below mediabox origin (in bleed zone)
                x = float(mb[0]) + 1.0
                y = float(mb[1]) + 1.0  # 1pt above bottom edge

                # PDF render mode 3 = invisible (no fill, no stroke)
                stream_ops = (
                    f"q\n"
                    f"BT\n"
                    f"3 Tr\n"
                    f"/{font_key} 0.10 Tf\n"
                    f"{x:.4f} {y:.4f} Td\n"
                    f"({escaped}) Tj\n"
                    f"ET\n"
                    f"Q\n"
                )

                page.contents_add(pikepdf.Stream(pdf, stream_ops.encode('latin-1')))
            except Exception as e:
                logger.debug(f"[WATERMARK] Skip page: {e}")
                continue

        return True
    except Exception as e:
        # Watermark must NEVER block PDF output
        logger.warning(f"[WATERMARK] Failed (non-blocking): {e}")
        return False


def verify_watermark(pdf_path: str) -> dict:
    """
    Utility: read watermark from a PDF file (for forensic verification).

    Returns dict with lid, hid, ts if found, empty dict otherwise.
    """
    result = {}
    try:
        pdf = pikepdf.Pdf.open(pdf_path)

        # Check XMP metadata — đọc THẲNG packet raw rồi regex theo namespace
        # px:* (không phụ thuộc ánh xạ prefix của pikepdf, khớp _build_xmp_packet).
        try:
            xmp_obj = pdf.Root.get("/Metadata")
            if xmp_obj is not None:
                raw_xmp = bytes(xmp_obj.read_bytes()).decode('utf-8', errors='replace')
                import re as _re
                def _xmp(attr):
                    m = _re.search(rf'px:{attr}="([^"]*)"', raw_xmp)
                    return m.group(1) if m else ""
                lid = _xmp("lid")
                hid = _xmp("hid")
                ts = _xmp("ts")
                if lid:
                    result = {"lid": lid, "hid": hid, "ts": ts, "source": "xmp"}
        except Exception:
            pass

        # Check invisible text (Layer 2) on first page
        if not result and len(pdf.pages) > 0:
            page = pdf.pages[0]
            try:
                raw = page.contents_coalesce().read_bytes().decode('latin-1', errors='replace')
                import re
                match = re.search(r'\(PX_([a-f0-9]+)_([a-f0-9]+)_(\d+)\)', raw)
                if match:
                    result = {
                        "lid": match.group(1),
                        "hid": match.group(2),
                        "ts": match.group(3),
                        "source": "invisible_text",
                    }
            except Exception:
                pass

        pdf.close()
    except Exception as e:
        logger.warning(f"[WATERMARK] Verify failed: {e}")

    return result
