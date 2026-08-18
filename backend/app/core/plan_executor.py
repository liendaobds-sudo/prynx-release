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
import contextlib
import math
import logging
import os
from typing import List, Optional, Tuple

from app.workers import pdf_wrapper as pdf_lib
from app.core.imposition_page_box import effective_imposition_box
from app.workers.pdf_ops import copy_output_intents

logger = logging.getLogger(__name__)


class PlanExecutionError(Exception):
    pass


def _read_source_page_space(source_pdf_path: str) -> tuple[list[int], bool]:
    """Đọc góc gốc và xác định file có cần chuẩn hóa sang point vật lý không."""
    import pikepdf

    rotations: list[int] = []
    needs_canonicalization = False
    with pikepdf.Pdf.open(source_pdf_path) as pdf:
        for page_number, page in enumerate(pdf.pages, start=1):
            raw_rotation = page.get('/Rotate', 0) or 0
            try:
                rotation_value = float(raw_rotation)
            except (TypeError, ValueError, OverflowError) as exc:
                raise PlanExecutionError(
                    f"Trang {page_number} có /Rotate không hợp lệ: {raw_rotation}"
                ) from exc
            rounded_rotation = round(rotation_value)
            if (
                not math.isfinite(rotation_value)
                or abs(rotation_value - rounded_rotation) > 1e-9
            ):
                raise PlanExecutionError(
                    f"Trang {page_number} có /Rotate không hợp lệ: {raw_rotation}"
                )
            rotation = int(rounded_rotation) % 360
            if rotation not in (0, 90, 180, 270):
                raise PlanExecutionError(
                    f"Trang {page_number} có /Rotate không hợp lệ: {raw_rotation}"
                )
            rotations.append(rotation)

            try:
                user_unit = float(page.get('/UserUnit', 1) or 1)
            except (TypeError, ValueError, OverflowError):
                user_unit = 1.0
            if not math.isfinite(user_unit) or user_unit <= 0:
                user_unit = 1.0

            try:
                media_box = [float(value) for value in page.MediaBox]
                has_shifted_origin = (
                    abs(media_box[0]) > 0.01 or abs(media_box[1]) > 0.01
                )
            except Exception:
                has_shifted_origin = False

            if rotation or abs(user_unit - 1.0) > 1e-12 or has_shifted_origin:
                needs_canonicalization = True

    return rotations, needs_canonicalization


class PlanExecutor:
    """
    Reads a JSON Instruction Set produced by the TypeScript Planner
    and renders the imposed PDF using pikepdf's native C++ engine.
    """

    @staticmethod
    async def execute(instruction_json: dict, source_pdf_path: str = None) -> str:
        """Run the synchronous PDF renderer off the event loop with a heavy slot."""
        from app.core.heavy_job_scheduler import run_scheduled_in_threadpool

        return await run_scheduled_in_threadpool(
            "booklet", PlanExecutor._execute_sync,
            instruction_json, source_pdf_path,
        )


    @staticmethod
    def _execute_sync(instruction_json: dict, source_pdf_path: str = None) -> str:
        """
        Execute an imposition plan.

        Args:
            instruction_json: The parsed JSON instruction set from the TypeScript Planner.
            source_pdf_path: Override path for the source PDF (optional).

        Returns:
            Absolute path to the output PDF file.
        """
        perf_stages = None
        cleanup_stack = contextlib.ExitStack()
        src_doc = None
        output_doc = None
        temp_doc = None
        try:
            from app.core.perf_sampler import PerfStages, perf_enabled
            if perf_enabled():
                perf_stages = PerfStages()
        except Exception:
            perf_stages = None

        try:
            version = instruction_json.get("version", "1.0")
            src_path = source_pdf_path or instruction_json["source_pdf_path"]
            # Ép TUYỆT ĐỐI: output_path được trả về frontend và Rust native renderer
            # (cwd khác backend) mở để hiển thị. Mặc định "results" tương đối sẽ gây
            # "cannot find path" ở Rust. Mặc định dùng settings.RESULTS_DIR (đã tuyệt đối).
            from app.config import settings as _settings
            output_dir = os.path.abspath(instruction_json.get("output_dir") or _settings.RESULTS_DIR)
            sheets = instruction_json["sheets"]

            if not os.path.exists(src_path):
                raise PlanExecutionError(f"Source PDF not found: {src_path}")

            os.makedirs(output_dir, exist_ok=True)

            # PAGEBOX (audit 2026-08-04 §W1.PB3): pikepdf đưa `/UserUnit` và
            # `/Rotate` vào Matrix của Form XObject. Planner cũng đã tính hai giá
            # trị này vào kích thước/góc, nên mở file thô ở đây sẽ phóng và xoay
            # lần hai rồi clip mất nội dung. Chuẩn hóa một lần trước mọi nhánh render.
            source_native_rotations, source_needs_canonicalization = (
                _read_source_page_space(src_path)
            )
            from app.workers.nup_engine import canonical_page_space
            canonical_src_path = cleanup_stack.enter_context(
                canonical_page_space(src_path, "booklet-plan")
            )
            if (
                source_needs_canonicalization
                and os.path.normcase(os.path.abspath(canonical_src_path))
                == os.path.normcase(os.path.abspath(src_path))
            ):
                raise PlanExecutionError(
                    "Không thể chuẩn hóa hệ tọa độ PDF; đã dừng để tránh xuất sai kích thước."
                )

            logger.info(f"PlanExecutor: Loading source PDF from {canonical_src_path}")
            src_doc = pdf_lib.open(canonical_src_path)
            total_src_pages = src_doc.page_count

            logger.info(f"PlanExecutor: Source has {total_src_pages} pages. Rendering {len(sheets)} sheets.")

            # Create output PDF
            output_doc = pdf_lib.open()
            # [BLEED-COLOR FIX 2026-08-18] Bình sách tạo catalog PDF mới. Giữ
            # OutputIntent/ICC của file nguồn để artwork CMYK và phần bù xén đã
            # lấy mẫu không bị diễn giải bằng hai profile khác nhau sau khi bình.
            copy_output_intents(src_doc._pdf, output_doc._pdf)
            if perf_stages is not None:
                perf_stages.mark("source_open_s")

            phase2 = instruction_json.get("phase2")
            if phase2:
                # ── Phase-2 (Step&Repeat / Fold Pattern / Cut&Stack) ──
                # 1) Render từng "spread" (mỗi sheet.front) ra doc tạm.
                # 2) Đặt spread lên các tờ kẽm lớn (plates) qua show_pdf_page.
                spread_w = float(phase2["spread_w_pt"])
                spread_h = float(phase2["spread_h_pt"])
                temp_doc = pdf_lib.open()
                for sheet_data in sheets:
                    front = sheet_data.get("front") or {"placements": [], "marks": []}
                    tp = temp_doc.new_page(width=spread_w, height=spread_h)
                    _render_placements(
                        tp,
                        src_doc,
                        front,
                        spread_h,
                        total_src_pages,
                        source_native_rotations,
                    )

                n_spreads = len(sheets)
                plates = phase2.get("plates", [])
                logger.info(f"PlanExecutor: phase2={phase2.get('mode')} {n_spreads} spreads -> {len(plates)} plates.")
                for plate in plates:
                    pw = float(plate["width_pt"])
                    ph = float(plate["height_pt"])
                    op = output_doc.new_page(width=pw, height=ph)
                    for pl in plate.get("placements", []):
                        si = pl.get("spread_index")
                        if si is None or si < 0 or si >= n_spreads:
                            continue
                        x = float(pl["x_pt"])
                        y = float(pl["y_pt"])
                        rot = int(pl.get("rotation_deg", 0)) % 360
                        # Box bbox: xoay 90/270 thì hoán chiều rộng/cao.
                        if rot in (90, 270):
                            box_w, box_h = spread_h, spread_w
                        else:
                            box_w, box_h = spread_w, spread_h
                        # x_pt/y_pt theo gốc PDF bottom-left của bbox → đổi sang top-left.
                        pike_y = ph - y - box_h
                        dest = pdf_lib.Rect(x, pike_y, x + box_w, pike_y + box_h)
                        op.show_pdf_page(dest, temp_doc, si, rotate=rot, clip=None)
                    if plate.get("marks"):
                        _draw_marks_batched(op, plate["marks"], ph)
            else:
                for sheet_data in sheets:
                    sheet_idx = sheet_data["sheet_index"]
                    sheet_w = sheet_data["width_pt"]
                    sheet_h = sheet_data["height_pt"]

                    # Render front side
                    front = sheet_data.get("front")
                    if front and (front.get("placements") or front.get("marks")):
                        _render_side(
                            output_doc, src_doc, sheet_w, sheet_h,
                            front, total_src_pages, source_native_rotations,
                        )

                    # Render back side
                    back = sheet_data.get("back")
                    if back and (back.get("placements") or back.get("marks")):
                        _render_side(
                            output_doc, src_doc, sheet_w, sheet_h,
                            back, total_src_pages, source_native_rotations,
                        )

            # Save output — tên file UNIQUE (uuid) để 2 job booklet đồng thời / nhiều
            # tab KHÔNG ghi đè cùng 1 file trong results/ (audit #C1). FileResponse trả
            # theo NỘI DUNG file nên tên đĩa không ảnh hưởng phía client.
            # Product report belongs to imposed press sheets. Detached cover pages
            # are copied at final size and have no safe report margin.
            report_page_count = output_doc.page_count
            # Append separately handled source pages (for example, detached covers).
            for item in instruction_json.get('append_source_pages', []):
                if isinstance(item, int):
                    src_idx, user_rotation = item, 0
                else:
                    src_idx = int(item.get('source_page', -1))
                    user_rotation = int(item.get('rotation_deg', 0)) % 360
                if src_idx < 0 or src_idx >= total_src_pages:
                    continue
                src_page = src_doc[src_idx]
                src_box = effective_imposition_box(src_page)
                # File nguồn đã canonicalize: box ở point vật lý và /Rotate = 0.
                src_w = float(src_box.width)
                src_h = float(src_box.height)
                native_rotation = int(getattr(src_page, 'rotation', 0) or 0) % 360
                total_rotation = (native_rotation + user_rotation) % 360
                if total_rotation in (90, 270):
                    out_w, out_h = src_h, src_w
                else:
                    out_w, out_h = src_w, src_h
                out_page = output_doc.new_page(width=out_w, height=out_h)
                out_page.show_pdf_page(
                    pdf_lib.Rect(0, 0, out_w, out_h), src_doc, src_idx,
                    rotate=total_rotation, clip=src_box,
                )

            import uuid as _uuid
            output_filename = f"imposed_plan_{_uuid.uuid4().hex[:8]}.pdf"
            output_path = os.path.join(output_dir, output_filename)

            if perf_stages is not None:
                perf_stages.mark("render_s")
            logger.info(f"PlanExecutor: Saving output to {output_path}")
            output_doc.save(output_path, garbage=4, deflate=True)
            if perf_stages is not None:
                perf_stages.mark("save_s")

            # Stealth watermark
            _wm_license = instruction_json.get('_license_key', '')
            _wm_hwid = instruction_json.get('_hwid', '')
            if _wm_license:
                try:
                    import pikepdf
                    import os as _os, tempfile as _tempfile
                    from app.core.watermark import embed_watermark
                    with pikepdf.Pdf.open(output_path, allow_overwriting_input=True) as _wm_pdf:
                        embed_watermark(_wm_pdf, _wm_license, _wm_hwid)
                        # Ghi atomic: temp cùng thư mục rồi os.replace.
                        _fd, _tmp = _tempfile.mkstemp(suffix=".pdf", dir=_os.path.dirname(output_path) or ".")
                        _os.close(_fd)
                        _wm_pdf.save(_tmp)
                    _os.replace(_tmp, output_path)
                except Exception as _wm_e:
                    logger.warning(f"PlanExecutor watermark failed: {_wm_e}")

            # Cleanup
            src_doc.close()
            src_doc = None
            output_doc.close()
            output_doc = None
            if temp_doc is not None:
                temp_doc.close()
                temp_doc = None
            cleanup_stack.close()
            if perf_stages is not None:
                perf_stages.mark("watermark_cleanup_s")

            # Optional book/magazine product report. Stamp only after all PDF
            # handles are closed so the same path is safe on Windows as well.
            book_report = instruction_json.get("book_report") or {}
            report_text = str(book_report.get("text") or "").strip()
            if book_report.get("enabled") and report_text and report_page_count > 0:
                report_tmp = None
                try:
                    import tempfile
                    from app.workers.nup_report import stamp_reports_on_pdf

                    fd, report_tmp = tempfile.mkstemp(
                        suffix=".pdf",
                        dir=os.path.dirname(output_path) or ".",
                    )
                    os.close(fd)
                    reports_by_page = {
                        page_index: report_text
                        for page_index in range(report_page_count)
                    }
                    stamped = stamp_reports_on_pdf(
                        output_path,
                        report_tmp,
                        reports_by_page,
                        position=book_report.get("position", "top"),
                        offset_x_mm=max(0.0, float(book_report.get("offset_x_mm", 5.0))),
                        offset_y_mm=max(0.0, float(book_report.get("offset_y_mm", 5.0))),
                        font_size=max(4.0, float(book_report.get("font_size", 7.0))),
                        centered=book_report.get("centered", True) is not False,
                    )
                    if stamped:
                        os.replace(report_tmp, output_path)
                        report_tmp = None
                except Exception as report_error:
                    logger.warning("PlanExecutor book report failed: %s", report_error)
                finally:
                    if report_tmp and os.path.exists(report_tmp):
                        try:
                            os.unlink(report_tmp)
                        except OSError:
                            pass

            logger.info(f"PlanExecutor: Done. Output at {output_path}")
            if perf_stages is not None:
                try:
                    perf_stages.mark("report_s")
                    from app.core.perf_sampler import write_job_perf
                    perf_record = {
                        "job": "book",
                        "source_pages": total_src_pages,
                        "sheets": len(sheets),
                        "output_mb": round(os.path.getsize(output_path) / (1024.0 * 1024.0), 1),
                    }
                    perf_record.update(perf_stages.finish())
                    write_job_perf(perf_record)
                except Exception:
                    pass

            return os.path.abspath(output_path)

        except PlanExecutionError:
            raise
        except Exception as e:
            logger.error(f"PlanExecutor failed: {e}", exc_info=True)
            raise PlanExecutionError(f"Execution failed: {str(e)}")
        finally:
            for document in (temp_doc, output_doc, src_doc):
                if document is None:
                    continue
                try:
                    document.close()
                except Exception:
                    pass
            cleanup_stack.close()


def _render_side(
    output_doc: pdf_lib.Document,
    src_doc: pdf_lib.Document,
    sheet_w: float,
    sheet_h: float,
    side_data: dict,
    total_src_pages: int,
    source_native_rotations: list[int],
):
    """Render one side (front or back) of a press sheet using pikepdf."""
    out_page = output_doc.new_page(width=sheet_w, height=sheet_h)
    _render_placements(
        out_page,
        src_doc,
        side_data,
        sheet_h,
        total_src_pages,
        source_native_rotations,
    )


def _render_placements(
    out_page: pdf_lib.Page,
    src_doc: pdf_lib.Document,
    side_data: dict,
    sheet_h: float,
    total_src_pages: int,
    source_native_rotations: list[int],
):
    """Render source-page placements + marks onto an EXISTING output page."""

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

        # Get source page dimensions.
        # PARITY: dùng đúng cùng effective box với /imposition/pdf-meta. MediaBox
        # giữ bleed nhỏ; CropBox thắng khi MediaBox là canvas nhiều trang.
        src_page = src_doc[src_page_idx]

        # In pdf_wrapper, Page has mediabox, cropbox, trimbox properties
        src_box = effective_imposition_box(src_page)
        src_w = src_box.width
        src_h = src_box.height
        
        # Build clip rect for source page (what area of the source to show)
        clip_rect = src_box
        output_clip_rect = None

        # Calculate the destination rectangle on the output page
        # The placement coordinates (x, y) define where the page goes
        # in the output coordinate system (origin bottom-left in PDF,
        # but top-left origin used here)
        # `native_angle` trong plan = /Rotate gốc + góc người dùng. /Rotate gốc
        # đã bake vào file canonical, nên chỉ giữ phần góc người dùng tại sink.
        source_native_rotation = (
            source_native_rotations[src_page_idx]
            if src_page_idx < len(source_native_rotations)
            else 0
        )
        user_rotation = (
            int(native_angle - source_native_rotation)
            if "native_angle" in placement
            else 0
        )
        total_rotation = int((user_rotation + rotation) % 360)
        if total_rotation in (90, 270):
            dest_w = src_h * scale_factor
            dest_h = src_w * scale_factor
        else:
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

            # Keep the full source transform and clip in OUTPUT space.  Converting
            # this rectangle back into source coordinates loses a non-zero CropBox
            # origin and also breaks rotated pages.
            output_clip_rect = clip_output_rect

        # Use show_pdf_page — handles clipping + rotation natively
        out_page.show_pdf_page(
            dest_rect,
            src_doc,
            src_page_idx,
            rotate=total_rotation,
            clip=clip_rect,
            out_clip=output_clip_rect,
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
