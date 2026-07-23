"""Manifest-based PDF assembly for large Combine jobs.

The manifest keeps page selection and rotation decisions out of the browser's
PDF object graph. Source PDFs are opened once and pages are appended directly
to the output document, so the request only carries files plus a small plan.
"""

from contextlib import ExitStack
from typing import Any, Dict, List

import pikepdf

from app.workers.pdf_tools_engine import save_pdf_compat


MAX_MANIFEST_ITEMS = 20_000
MAX_MANIFEST_FILES = 256
DEFAULT_BLANK_PAGE_SIZE = (595.28, 841.89)


def _visible_page_size(page) -> tuple[float, float]:
    """Return page dimensions after its effective quarter-turn rotation."""
    box = [float(value) for value in page.mediabox]
    width = box[2] - box[0]
    height = box[3] - box[1]
    rotation = int(page.obj.get("/Rotate", 0) or 0) % 360
    return (height, width) if rotation in (90, 270) else (width, height)


def merge_manifest(
    file_paths: List[str],
    manifest: List[Dict[str, Any]],
    output_path: str,
) -> str:
    """Assemble a PDF from a bounded list of source-page operations.

    Each item is either ``{"blank": true, "width": ..., "height": ...}`` or
    references a source by ``file_index``. A page reference either carries a
    zero-based ``page_index`` (a single page) or omits it entirely, which means
    "append every page of the source in order". ``rotation`` is an additional
    clockwise quarter-turn value composed with each page's existing /Rotate.
    """
    if not file_paths or len(file_paths) > MAX_MANIFEST_FILES:
        raise ValueError("Manifest file count is outside the allowed range")
    if not manifest or len(manifest) > MAX_MANIFEST_ITEMS:
        raise ValueError("Manifest item count is outside the allowed range")

    out_doc = pikepdf.Pdf.new()
    # Mirror the old frontend behavior: a blank page with no explicit size takes
    # the size of the first page in the output (or A4 if the blank comes first).
    first_page_size = None
    with ExitStack() as stack:
        sources = [stack.enter_context(pikepdf.Pdf.open(path)) for path in file_paths]
        for item in manifest:
            if not isinstance(item, dict):
                raise ValueError("Manifest item must be an object")

            rotation = int(item.get("rotation", 0) or 0) % 360
            if rotation % 90 != 0:
                raise ValueError("Manifest rotation must be a multiple of 90")

            appended_pages = []
            if item.get("blank"):
                if item.get("width") is not None or item.get("height") is not None:
                    width = float(item.get("width") or DEFAULT_BLANK_PAGE_SIZE[0])
                    height = float(item.get("height") or DEFAULT_BLANK_PAGE_SIZE[1])
                elif first_page_size is not None:
                    width, height = first_page_size
                else:
                    width, height = DEFAULT_BLANK_PAGE_SIZE
                if width <= 0 or height <= 0 or width > 20_000 or height > 20_000:
                    raise ValueError("Blank page dimensions are invalid")
                out_doc.add_blank_page(page_size=(width, height))
                appended_pages.append(out_doc.pages[-1])
            else:
                try:
                    file_index = int(item["file_index"])
                except (KeyError, TypeError, ValueError) as exc:
                    raise ValueError("Manifest page reference is invalid") from exc
                if not 0 <= file_index < len(sources):
                    raise ValueError("Manifest file index is out of range")
                source = sources[file_index]

                # A missing page_index means "the whole file, in order". This is
                # how a non-expanded multi-page PDF node is represented — omitting
                # it previously defaulted to page 0 and silently dropped pages.
                if "page_index" not in item:
                    page_indices = range(len(source.pages))
                else:
                    try:
                        single = int(item["page_index"])
                    except (TypeError, ValueError) as exc:
                        raise ValueError("Manifest page reference is invalid") from exc
                    if not 0 <= single < len(source.pages):
                        raise ValueError("Manifest page index is out of range")
                    page_indices = [single]

                for pi in page_indices:
                    out_doc.pages.append(source.pages[pi])
                    appended_pages.append(out_doc.pages[-1])

            if rotation:
                for page in appended_pages:
                    current = int(page.obj.get("/Rotate", 0) or 0) % 360
                    page.obj["/Rotate"] = (current + rotation) % 360

            if first_page_size is None and appended_pages:
                try:
                    first_page_size = _visible_page_size(appended_pages[0])
                except Exception:
                    first_page_size = None

    save_pdf_compat(out_doc, output_path)
    return output_path

