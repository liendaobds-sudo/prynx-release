"""Kết xuất chunk và hoàn tất file PDF cho engine N-Up.

Module này chỉ nhận kế hoạch đã được ``nup_engine`` dựng xong. Nó không quyết định
hình học, số worker hay số tờ cần in; nhờ vậy phần điều phối chính không tiếp tục
phình to và các bước ghi file có thể được kiểm thử độc lập.
"""

from __future__ import annotations

from dataclasses import dataclass
import logging
import os
import shutil
import tempfile
from typing import Any, Callable


logger = logging.getLogger(__name__)


@dataclass(slots=True)
class NupOutputContext:
    """Dữ liệu đã chốt để render và hoàn tất một job N-Up."""

    args_list: list[tuple]
    planned_worker_count: int
    output_path: str
    prog_file: str | None
    perf_stages: Any
    is_die_cut: bool
    page_sheet_mode: bool
    homogeneous_master_idx: int | None
    single_mold_master_idx: int | None
    layout_type: str
    settings: dict[str, Any]
    reports_by_sheet: dict[int, str]
    report_rows: list[dict[str, Any]]
    total_sheets: int
    page_count: int
    capacity: int
    precalculated_placements: dict | None
    page_sheet_report_fields: Callable[[str], dict[str, Any]]
    progress_callback: Callable[[int, int, str], None] | None
    ratio_stack_template_count: int
    ratio_stack_export_unique: bool
    ratio_stack_duplex: bool
    ratio_stack_warnings: list[str]
    layout: dict[str, Any]
    strategy: str
    total_capacity: int


def _mark(context: NupOutputContext, stage: str) -> None:
    if context.perf_stages is not None:
        context.perf_stages.mark(stage)


def _write_stage(prog_file: str | None, message: str) -> None:
    """Ghi mốc chẩn đoán; lỗi file tiến trình không được làm hỏng bản in."""
    if not prog_file:
        return
    try:
        with open(prog_file, "w", encoding="utf-8") as handle:
            handle.write(message)
    except OSError:
        pass


def _remove_file(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def _render_chunks(
    context: NupOutputContext,
    chunk_processor: Callable[[tuple], str],
    executor_factory: Callable[..., Any] | None,
) -> list[str]:
    chunk_paths: list[str] = []
    try:
        if not context.args_list:
            return chunk_paths
        if len(context.args_list) == 1 or context.planned_worker_count <= 1:
            # Job nhỏ chạy nội tuyến để tránh chi phí khởi tạo process.
            for args in context.args_list:
                chunk_paths.append(chunk_processor(args))
            return chunk_paths

        if executor_factory is None:
            # Import tại lúc chạy để test và runtime có thể thay executor an toàn.
            from concurrent.futures import ProcessPoolExecutor

            executor_factory = ProcessPoolExecutor
        worker_count = min(len(context.args_list), context.planned_worker_count)
        with executor_factory(max_workers=worker_count) as pool:
            return list(pool.map(chunk_processor, context.args_list))
    except BaseException:
        # BUILD (audit 2026-08-03 §REL.03): không để chunk đã trả về sót lại khi
        # một chunk sau thất bại; ngoại lệ gốc vẫn được truyền nguyên vẹn.
        for path in chunk_paths:
            _remove_file(path)
        raise


def _copy_order_item(item, pikepdf, final_doc, ocg_remap):
    if isinstance(item, pikepdf.Array):
        return pikepdf.Array([
            _copy_order_item(sub, pikepdf, final_doc, ocg_remap)
            for sub in item
        ])
    if hasattr(item, "objgen") and item.objgen in ocg_remap:
        return ocg_remap[item.objgen]
    return final_doc.copy_foreign(item)


def _merge_layered_chunks(chunk_paths: list[str], output_path: str) -> None:
    """Ghép bằng pikepdf để bảo toàn OCG của khuôn bế/nguyên tấm."""
    import pikepdf

    final_doc = pikepdf.Pdf.open(chunk_paths[0])
    try:
        for chunk_path in chunk_paths[1:]:
            src_pdf = pikepdf.Pdf.open(chunk_path)
            try:
                src_oc_props = src_pdf.Root.get("/OCProperties")
                chunk_ocg_map = {}
                if src_oc_props:
                    final_oc_props = final_doc.Root.get("/OCProperties")
                    if final_oc_props:
                        ocg_remap = {}
                        for src_ocg in src_oc_props.get("/OCGs", []):
                            try:
                                new_ocg = final_doc.copy_foreign(src_ocg)
                                final_oc_props["/OCGs"].append(new_ocg)
                                default_cfg = final_oc_props.get("/D", {})
                                if "/ON" in default_cfg:
                                    default_cfg["/ON"].append(new_ocg)
                                if hasattr(src_ocg, "objgen"):
                                    ocg_remap[src_ocg.objgen] = new_ocg
                                name = str(src_ocg.get("/Name", ""))
                                if name:
                                    chunk_ocg_map[name] = new_ocg
                            except Exception:
                                pass

                        src_default = src_oc_props.get("/D", {})
                        src_order = src_default.get("/Order", [])
                        final_default = final_oc_props.get("/D", {})
                        if "/Order" in final_default and src_order:
                            for item in src_order:
                                try:
                                    final_default["/Order"].append(
                                        _copy_order_item(
                                            item, pikepdf, final_doc, ocg_remap
                                        )
                                    )
                                except Exception:
                                    pass

                start_idx = len(final_doc.pages)
                final_doc.pages.extend(src_pdf.pages)
                if src_oc_props:
                    for page in final_doc.pages[start_idx:]:
                        try:
                            if (
                                "/Resources" in page
                                and "/Properties" in page.Resources
                            ):
                                props = page.Resources["/Properties"]
                                for key in list(props.keys()):
                                    value = props[key]
                                    if (
                                        isinstance(value, pikepdf.Dictionary)
                                        and value.get("/Type") == "/OCG"
                                    ):
                                        name = str(value.get("/Name", ""))
                                        if name in chunk_ocg_map:
                                            props[key] = chunk_ocg_map[name]
                        except Exception:
                            pass
            finally:
                src_pdf.close()
            _remove_file(chunk_path)

        final_doc.save(output_path)
    finally:
        final_doc.close()
    _remove_file(chunk_paths[0])
    chunk_paths.clear()


def _merge_pdfium_chunks(chunk_paths: list[str], output_path: str) -> None:
    """Ghép nhanh job thường bằng PDFium, tránh QPDF khử trùng bậc hai."""
    import pypdfium2 as pdfium
    from app.core.pdfium_lock import pdfium_guard

    final_doc = None
    # BUILD (audit 2026-08-03 §REL.03): chỉ khóa đúng các lời gọi PDFium;
    # xóa file chunk nằm ngoài vùng khóa để không giữ nút cổ chai khi I/O.
    with pdfium_guard("nup-output-new"):
        final_doc = pdfium.PdfDocument.new()
    try:
        for chunk_path in chunk_paths:
            with pdfium_guard("nup-output-import"):
                src_pdf = pdfium.PdfDocument(chunk_path)
                try:
                    final_doc.import_pages(src_pdf)
                finally:
                    src_pdf.close()
            _remove_file(chunk_path)
        with pdfium_guard("nup-output-save"):
            final_doc.save(output_path)
    finally:
        if final_doc is not None:
            with pdfium_guard("nup-output-close"):
                final_doc.close()
    chunk_paths.clear()


def _assemble_chunks(context: NupOutputContext, chunk_paths: list[str]) -> None:
    if len(chunk_paths) == 1:
        shutil.copyfile(chunk_paths[0], context.output_path)
        _remove_file(chunk_paths[0])
        chunk_paths.clear()
    elif context.is_die_cut or context.page_sheet_mode:
        _merge_layered_chunks(chunk_paths, context.output_path)
    else:
        _merge_pdfium_chunks(chunk_paths, context.output_path)


def _sanitize_portable_pdf(output_path: str) -> None:
    """Loại liên kết file ngoài mà Illustrator có thể giữ lại trong PDF nguồn.

    [PDF-PORTABILITY FIX 2026-08-17] Một số PDF từ Illustrator chứa ``/PieceInfo``
    (AIPDFPrivateData) hoặc ``/OPI`` trỏ tới file PDF gốc. Khi bình bản rồi chép
    file sang máy khác, Illustrator đọc lại dấu này như một linked file và báo
    thiếu ``nup_*.pdf`` dù nội dung đã nằm trong PDF kết quả. OCG/layer CUT,
    CREASE và nội dung đã nhúng không đi qua các trường này nên được giữ nguyên.
    """
    try:
        import pikepdf

        removed_piece_info = 0
        removed_opi = 0
        removed_file_links = 0
        with pikepdf.Pdf.open(output_path, allow_overwriting_input=True) as pdf:
            seen: set[tuple[int, int] | int] = set()

            def walk(obj) -> None:
                nonlocal removed_piece_info, removed_opi, removed_file_links
                if not isinstance(obj, (pikepdf.Dictionary, pikepdf.Stream)):
                    return
                objgen = getattr(obj, "objgen", None)
                marker: tuple[int, int] | int = (
                    objgen if objgen and objgen != (0, 0) else id(obj)
                )
                if marker in seen:
                    return
                seen.add(marker)
                if "/PieceInfo" in obj:
                    del obj["/PieceInfo"]
                    removed_piece_info += 1
                if "/OPI" in obj:
                    del obj["/OPI"]
                    removed_opi += 1

                annots = obj.get("/Annots")
                if isinstance(annots, pikepdf.Array):
                    kept = pikepdf.Array([])
                    for annot in annots:
                        if not isinstance(annot, pikepdf.Dictionary):
                            kept.append(annot)
                            continue
                        action = annot.get("/A")
                        action_type = (
                            str(action.get("/S", ""))
                            if isinstance(action, pikepdf.Dictionary)
                            else ""
                        )
                        subtype = str(annot.get("/Subtype", ""))
                        if (
                            action_type in ("/GoToR", "/Launch")
                            or subtype == "/FileAttachment"
                        ):
                            removed_file_links += 1
                            continue
                        kept.append(annot)
                    if len(kept) != len(annots):
                        if len(kept):
                            obj["/Annots"] = kept
                        else:
                            del obj["/Annots"]

                for _, value in list(obj.items()):
                    if isinstance(value, (pikepdf.Dictionary, pikepdf.Stream)):
                        walk(value)
                    elif isinstance(value, pikepdf.Array):
                        for item in value:
                            walk(item)

            walk(pdf.Root)
            for page in pdf.pages:
                walk(page.obj)

            if removed_piece_info or removed_opi or removed_file_links:
                pdf.save(output_path)

        logger.info(
            "[PDF-PORTABILITY] %s: removed_piece_info=%d removed_opi=%d "
            "removed_file_links=%d",
            os.path.basename(output_path),
            removed_piece_info,
            removed_opi,
            removed_file_links,
        )
    except Exception as error:
        # Không chặn job chỉ vì PDF có cấu trúc riêng mà pikepdf không sửa được.
        logger.warning("[PDF-PORTABILITY] làm sạch liên kết ngoài thất bại: %s", error)


def _uses_shared_master_cut(context: NupOutputContext) -> bool:
    return (
        context.homogeneous_master_idx is not None
        or (
            context.layout_type == "repeat"
            and context.single_mold_master_idx is not None
        )
    )


def _move_shared_master_cut(context: NupOutputContext) -> None:
    if not (
        context.is_die_cut
        and _uses_shared_master_cut(context)
        and context.settings.get("separateCutPage", False)
    ):
        return
    try:
        import pikepdf

        with pikepdf.Pdf.open(
            context.output_path, allow_overwriting_input=True
        ) as pdf:
            cut_idx = None
            for index, page in enumerate(pdf.pages):
                if page.obj.get("/PSHomogCut"):
                    cut_idx = index
                    break
            if cut_idx is not None:
                cut_page = pdf.pages[cut_idx]
                try:
                    del cut_page.obj["/PSHomogCut"]
                except Exception:
                    pass
                if cut_idx != len(pdf.pages) - 1:
                    pdf.pages.remove(cut_page)
                    pdf.pages.append(cut_page)
                    pdf.save(context.output_path)
    except Exception as error:
        logger.warning(
            "[SHARED-MASTER] dời trang khuôn xuống cuối thất bại (%s); "
            "giữ nguyên vị trí.",
            error,
        )


def _embed_license_watermark(context: NupOutputContext) -> None:
    license_key = (
        context.settings.get("_license_key", "")
        or context.settings.get("watermarkKey", "")
    )
    if not license_key:
        return
    _write_stage(context.prog_file, "Đang đóng dấu bản quyền...")
    temp_path = None
    try:
        import pikepdf

        from app.core.watermark import embed_watermark

        with pikepdf.Pdf.open(
            context.output_path, allow_overwriting_input=True
        ) as pdf:
            embed_watermark(pdf, license_key, context.settings.get("_hwid", ""))
            descriptor, temp_path = tempfile.mkstemp(
                suffix=".pdf",
                dir=os.path.dirname(context.output_path) or ".",
            )
            os.close(descriptor)
            pdf.save(temp_path)
        os.replace(temp_path, context.output_path)
        temp_path = None
    except Exception as error:
        logger.error("[WATERMARK] ghi dấu bản quyền thất bại: %s", error)
    finally:
        if temp_path:
            _remove_file(temp_path)


def _write_completed_progress(context: NupOutputContext) -> None:
    if not context.prog_file:
        return
    try:
        with open(context.prog_file, "w", encoding="utf-8") as handle:
            handle.write(f"{context.page_count}/{context.page_count}")
    except OSError:
        pass


def _build_report_fallback(context: NupOutputContext) -> None:
    if context.reports_by_sheet:
        return
    try:
        report_cfg = context.settings.get("reportDisplay") or {}
        if not (report_cfg.get("enabled") and context.total_sheets):
            return

        from app.workers import nup_report

        paper = (
            f"{context.settings.get('sheetWidth', 0)}x"
            f"{context.settings.get('sheetHeight', 0)}mm"
        )
        label = report_cfg.get("labelNameText") or ""
        capacity = int(context.capacity or 0)
        page_sheet_fields = (
            context.page_sheet_report_fields("")
            if context.page_sheet_mode
            else {}
        )
        mode = (
            "Bình nguyên tấm decal"
            if context.page_sheet_mode
            else ("Bế tem" if context.is_die_cut else "Cắt xén")
        )
        logical_sheets = int(context.total_sheets)
        if context.is_die_cut and context.precalculated_placements:
            logical_sheets = (
                max(context.precalculated_placements.keys()) + 1
                if context.precalculated_placements
                else logical_sheets
            )
            capacity = max(
                (len(value) for value in context.precalculated_placements.values()),
                default=capacity,
            )
        duplex = (
            not context.is_die_cut
            and context.settings.get("duplexFlow", "single") == "double"
            and logical_sheets >= 2
            and logical_sheets % 2 == 0
        )
        physical_sheets = logical_sheets // 2 if duplex else logical_sheets
        for sheet_idx in range(max(1, physical_sheets)):
            identifier = f"Tờ {sheet_idx + 1}/{max(1, physical_sheets)}"
            if context.page_sheet_mode:
                identifier = " · ".join(filter(None, (
                    page_sheet_fields.get("identifier", ""), identifier,
                )))
            report_data = nup_report.compute_report_data(
                label_name=label,
                width_mm=page_sheet_fields.get("width_mm", 0),
                height_mm=page_sheet_fields.get("height_mm", 0),
                paper_size=paper,
                items_per_sheet=capacity,
                requested_qty=page_sheet_fields.get("requested_qty", 0),
                material=context.settings.get("reportMaterial", "") or "",
                lamination_type=context.settings.get("reportLamination", 0) or 0,
                lamination_sides=context.settings.get("reportLaminationSides", 1) or 1,
                mode_label=mode,
                order_code=context.settings.get("reportOrderCode", "") or "",
                identifier=identifier,
                gang_count=page_sheet_fields.get("gang_count", 0),
                sheet_count_override=max(1, physical_sheets),
            )
            report_key = sheet_idx * 2 if duplex else sheet_idx
            context.reports_by_sheet[report_key] = nup_report.build_report_string(
                report_cfg, report_data
            )
        if context.page_sheet_mode:
            context.report_rows.append({
                "label": label or "Bình nguyên tấm decal",
                "items_per_sheet": capacity,
                "requested_qty": page_sheet_fields.get("requested_qty", 0),
                "sheet_count": max(1, physical_sheets),
            })
    except Exception as error:
        logger.warning("[REPORT] fallback dựng report lỗi: %s", error)


def _stamp_reports(context: NupOutputContext) -> None:
    if not context.reports_by_sheet:
        return
    _write_stage(context.prog_file, "Đang ghi report lên tờ...")
    try:
        from app.workers import nup_report

        display = context.settings.get("reportDisplay") or {}
        separate_cut = bool(context.settings.get("separateCutPage")) and (
            context.is_die_cut or context.page_sheet_mode
        )
        shared_cut = separate_cut and _uses_shared_master_cut(context)
        reports_to_stamp = (
            {
                sheet_idx * 2: text
                for sheet_idx, text in context.reports_by_sheet.items()
            }
            if separate_cut and not shared_cut
            else context.reports_by_sheet
        )
        nup_report.stamp_reports_on_pdf(
            context.output_path,
            context.output_path,
            reports_to_stamp,
            position=display.get("position", "top"),
            offset_x_mm=float(display.get("offsetX", 5.0)),
            offset_y_mm=float(display.get("offsetY", 5.0)),
            font_size=float(display.get("fontSize", 8.0)),
            centered=bool(display.get("centered", True)),
        )
    except Exception as error:
        logger.warning("[REPORT] stamp lỗi: %s", error)


def _append_print_summary(context: NupOutputContext, report_lines: list[str]) -> None:
    if not context.report_rows:
        return
    total_sheets = sum(row["sheet_count"] for row in context.report_rows)
    report_lines.extend(("", "📋 LỆNH IN (tổng hợp):"))
    product_unit = "tấm decal" if context.page_sheet_mode else "tem"
    for row in context.report_rows:
        report_lines.append(
            f"  • {row['label']}: {row['requested_qty']} {product_unit} — "
            f"SL/tờ {row['items_per_sheet']} → in {row['sheet_count']} tờ"
        )
    report_lines.append(f"  ⇒ Tổng số tờ cần in: {total_sheets}")
    if context.layout_type != "ratio_stack" or total_sheets <= 1:
        return
    if context.ratio_stack_export_unique and context.ratio_stack_template_count > 1:
        if context.ratio_stack_duplex:
            report_lines.append(
                f"  (File gồm {context.ratio_stack_template_count} CẶP tờ mẫu "
                f"trước/sau — in theo số bản ghi trên từng tờ; tổng "
                f"{total_sheets} lượt duplex.)"
            )
        else:
            report_lines.append(
                f"  (File gồm {context.ratio_stack_template_count} tờ mẫu — "
                f"in theo số bản ghi trên từng tờ; tổng {total_sheets} tờ.)"
            )
    elif context.ratio_stack_export_unique and context.ratio_stack_duplex:
        report_lines.append(
            f"  (File chỉ 1 CẶP tờ mẫu (mặt trước + sau) — máy in chạy "
            f"{total_sheets} lượt duplex giống hệt.)"
        )
    elif context.ratio_stack_export_unique:
        report_lines.append(
            f"  (File chỉ 1 tờ mẫu — máy in chạy {total_sheets} bản giống hệt.)"
        )


def _append_strategy_summary(context: NupOutputContext, report_lines: list[str]) -> None:
    if not (context.is_die_cut and "strategyUsed" in context.layout):
        return
    strategy_used = context.layout["strategyUsed"]
    names = {
        "dumbbell_illustrator": "Khuôn tạ (Đầu đuôi xen kẽ)",
        "hammer_illustrator": "Khuôn búa (Chữ T xen kẽ)",
        "grid": "Lưới đơn giản",
        "staggered": "So le (Tổ ong)",
        "head_to_tail": "Đầu đuôi (Ghép ngàm)",
        "l_shape": "Ghép L-Shape",
        "row_alt": "Xoay xen kẽ dòng",
        "col_alt": "Xoay xen kẽ cột",
        "pentagon_advanced": "Ghép Ngũ Giác (Đầu đuôi ngàm)",
    }
    vietnamese_strategy = strategy_used
    for key, value in names.items():
        if key in strategy_used:
            vietnamese_strategy = strategy_used.replace(key, value)
            break
    if context.strategy == "optimal_auto":
        report_lines.append(
            f"🤖 Máy tính đã tự động tối ưu và chọn kiểu: {vietnamese_strategy}"
        )
    else:
        report_lines.append(f"Chiến lược dàn: {vietnamese_strategy}")
    report_lines.append(
        f"Hiệu suất: {context.total_capacity} tem / tấm kẽm."
    )


def finalize_nup_output(
    context: NupOutputContext,
    *,
    chunk_processor: Callable[[tuple], str],
    executor_factory: Callable[..., Any] | None = None,
) -> str:
    """Render các chunk rồi hoàn tất output, trả thông báo tổng hợp cho UI."""
    _mark(context, "plan_s")
    chunk_paths = _render_chunks(context, chunk_processor, executor_factory)
    _mark(context, "render_chunks_s")
    try:
        _write_stage(context.prog_file, "Đang gộp các tờ in...")
        _assemble_chunks(context, chunk_paths)
        _mark(context, "merge_save_s")
        _move_shared_master_cut(context)
        _embed_license_watermark(context)
        _write_completed_progress(context)
        _build_report_fallback(context)
        _stamp_reports(context)
        _sanitize_portable_pdf(context.output_path)

        if context.progress_callback:
            context.progress_callback(
                context.page_count, context.page_count, "Hoàn tất"
            )

        report_lines = ["✅ Hoàn tất! Xuất thành công file kẽm."]
        _append_print_summary(context, report_lines)
        report_lines.extend(context.ratio_stack_warnings)
        _append_strategy_summary(context, report_lines)
        _mark(context, "postprocess_s")
        return "\n".join(report_lines)
    finally:
        # Bao phủ cả lỗi ghép/stamp để job không bỏ lại file chunk trong thư mục tạm.
        for chunk_path in chunk_paths:
            _remove_file(chunk_path)
