"""
pdf_wrapper — Backward-compatible bridge to pdf_types, pdf_ops, pdf_content_parser.

This file re-exports all symbols so existing `from app.workers import pdf_wrapper as pdf_lib`
imports continue to work during migration. Once all callers are migrated to
use pdf_types/pdf_ops/pdf_content_parser directly, this file can be deleted.
"""
import pikepdf
import logging

# Re-export geometry types
from app.workers.pdf_types import Point, Rect, Matrix

# Re-export PDF operations
from app.workers.pdf_ops import (
    ShapeBuilder as Shape,
    page_rect, page_width, page_height,
    get_box, new_shape, show_pdf_page,
    insert_text, set_trimbox, set_artbox,
    add_ocg, get_pixmap,
)

# Re-export content parser
from app.workers.pdf_content_parser import (
    parse_content_stream as _parse_content_stream,
    extract_vector_paths,
)

logger = logging.getLogger(__name__)


class Page:
    """Backward-compatible Page wrapper. Delegates to pdf_ops functions."""

    def __init__(self, doc, pikepdf_page):
        self.doc = doc
        self._page = pikepdf_page

    @property
    def rect(self):
        return page_rect(self._page)

    @property
    def trimbox(self): return get_box(self._page, "/TrimBox")

    @property
    def cropbox(self): return get_box(self._page, "/CropBox")

    @property
    def artbox(self): return get_box(self._page, "/ArtBox")

    @property
    def bleedbox(self): return get_box(self._page, "/BleedBox")

    @property
    def mediabox(self): return get_box(self._page, "/MediaBox")

    @property
    def width(self):
        return page_width(self._page)

    @property
    def height(self):
        return page_height(self._page)

    @property
    def xref(self):
        try:
            return self._page.obj.objgen[0]
        except Exception:
            return 0

    @property
    def rotation(self):
        return int(self._page.get("/Rotate", 0))

    def clean_contents(self):
        try:
            self._page.contents_coalesce()
        except Exception:
            pass

    def get_contents(self):
        xrefs = []
        try:
            contents = self._page.get("/Contents")
            if contents is None:
                return []
            if isinstance(contents, pikepdf.Array):
                for ref in contents:
                    if isinstance(ref, pikepdf.Object) and hasattr(ref, 'objgen'):
                        xrefs.append(ref.objgen[0])
            elif hasattr(contents, 'objgen'):
                xrefs.append(contents.objgen[0])
        except Exception:
            pass
        return xrefs

    def extract_vector_paths(self):
        return extract_vector_paths(self._page, self.doc._pdf)

    def get_pixmap(self, matrix=None, alpha=False, dpi=None, colorspace=None):
        scale = 1.0
        if matrix:
            scale = matrix.a
        if dpi:
            scale = dpi / 72.0
        doc_path = self.doc._path
        if not doc_path:
            raise NotImplementedError("get_pixmap requires a file-backed document")
        page_idx = 0
        for idx in range(len(self.doc._pdf.pages)):
            if self.doc._pdf.pages[idx] is self._page:
                page_idx = idx
                break
        return get_pixmap(self._page, doc_path, page_idx, scale)

    def show_pdf_page(self, rect, src_doc, page_idx, rotate=0, clip=None, keep_proportion=False, out_clip=None, mirror_x=False, mirror_y=False):
        show_pdf_page(self.doc._pdf, self._page, rect, src_doc._pdf, page_idx, rotate, clip, keep_proportion, out_clip, mirror_x, mirror_y)

    def new_shape(self):
        return new_shape(self.doc._pdf, self._page)

    def insert_text(self, point=None, text="", fontsize=11, fontname="helv",
                    color=(0, 0, 0, 1), render_mode=0, oc=None):
        return insert_text(self.doc._pdf, self._page, point, text, fontsize, fontname, color, render_mode, oc)

    def set_trimbox(self, rect):
        set_trimbox(self._page, rect)

    def set_artbox(self, rect):
        set_artbox(self._page, rect)


class Document:
    def __init__(self, pikepdf_doc, path=None):
        self._pdf = pikepdf_doc
        self._path = path

    def __len__(self):
        return len(self._pdf.pages)

    @property
    def page_count(self):
        return len(self._pdf.pages)

    def __getitem__(self, i):
        return Page(self, self._pdf.pages[i])

    def __iter__(self):
        for i in range(len(self)):
            yield self[i]

    def new_page(self, width=-1, height=-1):
        if width == -1: width = 595.0
        if height == -1: height = 842.0
        p = self._pdf.add_blank_page(page_size=(width, height))
        return Page(self, p)

    def save(self, path, garbage=0, deflate=True):
        self._pdf.save(path)

    def close(self):
        self._pdf.close()

    def add_ocg(self, name, on=True, add_to_order=True, **kwargs):
        return add_ocg(self._pdf, name, on, add_to_order)

    def xref_object(self, xref):
        try:
            obj = self._pdf.get_object((xref, 0))
            return str(obj)
        except Exception:
            return ""

    def xref_stream(self, xref):
        try:
            obj = self._pdf.get_object((xref, 0))
            if hasattr(obj, 'read_bytes'):
                return obj.read_bytes()
            return b""
        except Exception:
            return b""

    def update_stream(self, xref, stream):
        try:
            obj = self._pdf.get_object((xref, 0))
            if hasattr(obj, 'write'):
                obj.write(stream)
            else:
                new_stream = pikepdf.Stream(self._pdf, stream)
                if isinstance(obj, pikepdf.Stream):
                    for key in obj.keys():
                        if key not in ('/Length', '/Filter', '/DecodeParms'):
                            new_stream[key] = obj[key]
                self._pdf._replace_object((xref, 0), new_stream)
        except Exception as e:
            logger.warning(f"update_stream failed for xref {xref}: {e}")

    def get_new_xref(self):
        return 0


def open(path=None, stream=None, filetype=None):
    """Drop-in replacement for pdf_lib.open()."""
    if path:
        return Document(pikepdf.Pdf.open(path), path)
    elif stream:
        import io
        return Document(pikepdf.Pdf.open(io.BytesIO(stream)))
    else:
        return Document(pikepdf.Pdf.new())
