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


def merge_manifest(
    file_paths: List[str],
    manifest: List[Dict[str, Any]],
    output_path: str,
) -> str:
    """Assemble a PDF from a bounded list of source-page operations.

    Each item is either ``{"blank": true, "width": ..., "height": ...}`` or
    references a source by ``file_index`` and an optional zero-based
    ``page_index``. ``rotation`` is an additional clockwise quarter-turn value
    and is composed with the source page's existing /Rotate value.
    """
    if not file_paths or len(file_paths) > MAX_MANIFEST_FILES:
        raise ValueError("Manifest file count is outside the allowed range")
    if not manifest or len(manifest) > MAX_MANIFEST_ITEMS:
        raise ValueError("Manifest item count is outside the allowed range")

    out_doc = pikepdf.Pdf.new()
    with ExitStack() as stack:
        sources = [stack.enter_context(pikepdf.Pdf.open(path)) for path in file_paths]
        for item in manifest:
            if not isinstance(item, dict):
                raise ValueError("Manifest item must be an object")

            if item.get("blank"):
                width = float(item.get("width") or DEFAULT_BLANK_PAGE_SIZE[0])
                height = float(item.get("height") or DEFAULT_BLANK_PAGE_SIZE[1])
                if width <= 0 or height <= 0 or width > 20_000 or height > 20_000:
                    raise ValueError("Blank page dimensions are invalid")
                page = out_doc.add_blank_page(page_size=(width, height))
            else:
                try:
                    file_index = int(item["file_index"])
                    page_index = int(item.get("page_index", 0))
                except (KeyError, TypeError, ValueError) as exc:
                    raise ValueError("Manifest page reference is invalid") from exc
                if not 0 <= file_index < len(sources):
                    raise ValueError("Manifest file index is out of range")
                source = sources[file_index]
                if not 0 <= page_index < len(source.pages):
                    raise ValueError("Manifest page index is out of range")
                page = source.pages[page_index]
                out_doc.pages.append(page)
                page = out_doc.pages[-1]

            rotation = int(item.get("rotation", 0) or 0) % 360
            if rotation % 90 != 0:
                raise ValueError("Manifest rotation must be a multiple of 90")
            if rotation:
                current = int(page.obj.get("/Rotate", 0) or 0) % 360
                page.obj["/Rotate"] = (current + rotation) % 360

    save_pdf_compat(out_doc, output_path)
    return output_path

