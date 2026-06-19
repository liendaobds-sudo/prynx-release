"""
Plan Executor — Backend engine that reads a JSON Instruction Set
and executes PDF imposition using pikepdf.

Rewritten from pypdfium2 raw API to pikepdf for:
  - Reliable page placement with show_pdf_page() (handles clipping + transform natively)
  - Batched marks rendering via pdf_lib.Shape (single commit per page)
  - Zero-copy memory mapping for large PDFs

This module replaces the role of pdf-lib's Renderer/SpreadPlacer
on the Frontend, enabling near-zero RAM usage for large PDFs.
"""
import math
import logging
import os
from typing import List, Optional, Tuple

from app.workers import pdf_wrapper as pdf_lib

logger = logging.getLogger(__name__)


class PlanExecutionError(Exception):
    pass


class PlanExecutor:
    """
    Reads a JSON Instruction Set produced by the TypeScript Planner
    and renders the imposed PDF using pikepdf's native C++ engine.
    """

    @staticmethod
    async def execute(instruction_json: dict, source_pdf_path: str = None) -> str:
        """
        Execute an imposition plan.

        Args:
            instruction_json: The parsed JSON instruction set from the TypeScript Planner.
            source_pdf_path: Override path for the source PDF (optional).

        Returns:
            Absolute path to the output PDF file.
        """
        try:
            version = instruction_json.get("version", "1.0")
            src_path = source_pdf_path or instruction_json["source_pdf_path"]
            output_dir = instruction_json.get("output_dir", "results")
            global_cfg = instruction_json["global"]
            sheets = instruction_json["sheets"]

            if not os.path.exists(src_path):
                raise PlanExecutionError(f"Source PDF not found: {src_path}")

            os.makedirs(output_dir, exist_ok=True)

            logger.info(f"PlanExecutor: Loading source PDF from {src_path}")
            src_doc = pdf_lib.open(src_path)
            total_src_pages = src_doc.page_count

            logger.info(f"PlanExecutor: Source has {total_src_pages} pages. Rendering {len(sheets)} sheets.")

            # Create output PDF
            output_doc = pdf_lib.open()

            for sheet_data in sheets:
                sheet_idx = sheet_data["sheet_index"]
                sheet_w = sheet_data["width_pt"]
                sheet_h = sheet_data["height_pt"]

                # Render front side
                front = sheet_data.get("front")
                if front and (front.get("placements") or front.get("marks")):
                    _render_side(
                        output_doc, src_doc, sheet_w, sheet_h,
                        front, global_cfg, total_src_pages
                    )

                # Render back side
                back = sheet_data.get("back")
                if back and (back.get("placements") or back.get("marks")):
                    _render_side(
                        output_doc, src_doc, sheet_w, sheet_h,
                        back, global_cfg, total_src_pages
                    )

            # Save output — tên file UNIQUE (uuid) để 2 job booklet đồng thời / nhiều
            # tab KHÔNG ghi đè cùng 1 file trong results/ (audit #C1). FileResponse trả
            # theo NỘI DUNG file nên tên đĩa không ảnh hưởng phía client.
            import uuid as _uuid
            output_filename = f"imposed_plan_{_uuid.uuid4().hex[:8]}.pdf"
            output_path = os.path.join(output_dir, output_filename)

            logger.info(f"PlanExecutor: Saving output to {output_path}")
            output_doc.save(output_path, garbage=4, deflate=True)

            # Stealth watermark
            _wm_license = instruction_json.get('_license_key', '')
            _wm_hwid = instruction_json.get('_hwid', '')
            if _wm_license:
                try:
                    import pikepdf
                    from app.core.watermark import embed_watermark
                    with pikepdf.Pdf.open(output_path, allow_overwriting_input=True) as _wm_pdf:
                        embed_watermark(_wm_pdf, _wm_license, _wm_hwid)
                        _wm_pdf.save(output_path)
                except Exception as _wm_e:
                    logger.warning(f"PlanExecutor watermark failed: {_wm_e}")

            # Cleanup
            src_doc.close()
            output_doc.close()

            logger.info(f"PlanExecutor: Done. Output at {output_path}")
            return os.path.abspath(output_path)

        except PlanExecutionError:
            raise
        except Exception as e:
            logger.error(f"PlanExecutor failed: {e}", exc_info=True)
            raise PlanExecutionError(f"Execution failed: {str(e)}")


def _render_side(
    output_doc: pdf_lib.Document,
    src_doc: pdf_lib.Document,
    sheet_w: float,
    sheet_h: float,
    side_data: dict,
    global_cfg: dict,
    total_src_pages: int,
):
    """Render one side (front or back) of a press sheet using pikepdf."""

    # Add a new blank page to the output
    out_page = output_doc.new_page(width=sheet_w, height=sheet_h)

    placements = side_data.get("placements", [])
    marks = side_data.get("marks", [])

    # --- Phase 1: Place source pages ---
    for placement in placements:
        src_page_idx = placement.get("source_page")
        if src_page_idx is None or src_page_idx < 0 or src_page_idx >= total_src_pages:
            continue  # Skip blank/padding pages

        x = placement["x_pt"]
        y = placement["y_pt"]
        rotation = placement.get("rotation_deg", 0)
        scale_factor = placement.get("scale", 1.0)
        native_angle = placement.get("native_angle", 0)
        clip_data = placement.get("clip")

        # Get source page dimensions (TrimBox > CropBox > MediaBox)
        src_page = src_doc[src_page_idx]
        
        # In pdf_wrapper, Page has trimbox, cropbox properties
        src_box = src_page.trimbox or src_page.cropbox or src_page.mediabox or src_page.rect
        src_w = src_box.width
        src_h = src_box.height
        
        # Read UserUnit if present in the page dictionary
        user_unit = 1.0
        try:
            if "/UserUnit" in src_page._page:
                user_unit = float(src_page._page["/UserUnit"])
        except Exception:
            pass
        
        src_w *= user_unit
        src_h *= user_unit

        # Build clip rect for source page (what area of the source to show)
        clip_rect = None
        if clip_data:
            # Clip coordinates are in output space — convert to source space
            # clip defines the visible area on the output sheet
            clip_rect = src_box  # Default: show entire source page based on our chosen box
        else:
            clip_rect = src_box  # Pass chosen box to show_pdf_page to crop out printer marks

        # Calculate the destination rectangle on the output page
        # The placement coordinates (x, y) define where the page goes
        # in the output coordinate system (origin bottom-left in PDF,
        # but top-left origin used here)
        dest_w = src_w * scale_factor
        dest_h = src_h * scale_factor

        # top-left origin used here, PDF instructions use bottom-left
        # Convert: pike_y = sheet_h - y - dest_h
        pike_y = sheet_h - y - dest_h

        dest_rect = pdf_lib.Rect(x, pike_y, x + dest_w, pike_y + dest_h)

        # Handle clipping in output space
        if clip_data:
            clip_x = clip_data["x_pt"]
            clip_y_pdf = clip_data["y_pt"]
            clip_w = clip_data["w_pt"]
            clip_h = clip_data["h_pt"]

            # Convert clip from PDF coords to top-left coords
            clip_pike_y = sheet_h - clip_y_pdf - clip_h
            clip_output_rect = pdf_lib.Rect(
                clip_x, clip_pike_y,
                clip_x + clip_w, clip_pike_y + clip_h
            )

            # Intersect destination with clip to get actual visible area
            visible_rect = dest_rect & clip_output_rect
            if visible_rect.is_empty:
                continue

            # Calculate the corresponding clip in source space
            # Map visible_rect back to source page coordinates
            sx0 = (visible_rect.x0 - dest_rect.x0) / scale_factor
            sy0 = (visible_rect.y0 - dest_rect.y0) / scale_factor
            sx1 = sx0 + visible_rect.width / scale_factor
            sy1 = sy0 + visible_rect.height / scale_factor

            clip_rect = pdf_lib.Rect(sx0, sy0, sx1, sy1)
            dest_rect = visible_rect

        # Compute total rotation
        total_rotation = int((native_angle + rotation) % 360)

        # Use show_pdf_page — handles clipping + rotation natively
        out_page.show_pdf_page(
            dest_rect,
            src_doc,
            src_page_idx,
            rotate=total_rotation,
            clip=clip_rect,
        )

    # --- Phase 2: Draw marks (batched via pdf_lib.Shape) ---
    if marks:
        _draw_marks_batched(out_page, marks, sheet_h)


def _draw_marks_batched(page: pdf_lib.Page, marks: list, sheet_h: float):
    """
    Draw all marks on a page using pdf_lib.Shape for batched rendering.
    Groups marks by color to minimize finish() calls.

    Marks giữ NGUYÊN màu CMYK do planner chỉ định (vd registration K-only
    [0,0,0,1]) thay vì quy đổi sang RGB — để dấu xén/gấp xuất đúng trên bản
    tách kẽm offset (ShapeBuilder.finish nhận tuple 4 phần tử → toán tử `K`).
    """
    if not marks:
        return

    # Group marks by CMYK color + thickness for efficient rendering
    color_groups: dict[tuple, list] = {}
    for mark in marks:
        cmyk = mark.get("color", [0, 0, 0, 1])
        thickness = mark.get("thickness_pt", 0.25)
        # Chuẩn hoá về CMYK 4 phần tử (nếu thiếu → registration K-only).
        if len(cmyk) == 4:
            col = (round(float(cmyk[0]), 4), round(float(cmyk[1]), 4),
                   round(float(cmyk[2]), 4), round(float(cmyk[3]), 4))
        elif len(cmyk) == 3:
            # RGB hiếm gặp → giữ nguyên 3 phần tử (finish ghi RG).
            col = (round(float(cmyk[0]), 4), round(float(cmyk[1]), 4), round(float(cmyk[2]), 4))
        else:
            col = (0, 0, 0, 1)

        key = (col, round(thickness, 3))
        color_groups.setdefault(key, []).append(mark)

    # Render each color group in a single shape batch (CMYK preserved)
    for (col, thickness), group_marks in color_groups.items():
        shape = page.new_shape()

        for mark in group_marks:
            x1, y1_pdf = mark["x1"], mark["y1"]
            x2, y2_pdf = mark["x2"], mark["y2"]

            # Convert from PDF bottom-left to top-left coordinates
            y1_pike = sheet_h - y1_pdf
            y2_pike = sheet_h - y2_pdf

            shape.draw_line(
                pdf_lib.Point(x1, y1_pike),
                pdf_lib.Point(x2, y2_pike),
            )

        shape.finish(color=col, width=thickness)
        shape.commit()
