"""Đối chiếu preview whole-page và Execute AUTO có mang memo thật."""
from pathlib import Path
from io import BytesIO
import hashlib
import json
import sys
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / "backend"), str(ROOT / "backend/tests")]
import pikepdf
from app.workers.sticker_classic_page_preview import _render_classic_page, _pdf_cut_svg
from app.workers.sticker_engine import StickerEngine
from app.workers import cutline_cubic_simplify as simplify


def main():
    source = ROOT / "test/Binder2.pdf"
    geometry = dict(cut_mode="original", offset_mm=2, bleed_mm=0,
                    corner_style="preserve", fill_holes=True, cutline_smoothness=50,
                    cutline_fidelity=50, curve_tension=50, cutline_denoise=30,
                    min_detail_area_mm2=1, cutline_simplify_mm=.1, shape_mode="auto_safe")
    started = time.perf_counter()
    svg, count, quality, memo = _render_classic_page(
        str(source), 12, (600, 600), geometry, collect_memo=True)
    cold_s = time.perf_counter()-started
    started = time.perf_counter()
    warm = _render_classic_page(str(source), 12, (600, 600), geometry, collect_memo=True)
    warm_s = time.perf_counter()-started
    started = time.perf_counter()
    with patch.object(simplify, "simplify_cubic_path_groups", wraps=simplify.simplify_cubic_path_groups) as spy:
        result = StickerEngine(dpi=300).process_pdf(
            str(source), "", _page_subset=[11], remove_white_bg=True,
            draw_cut_contour=True, alpha_corner_policy="adaptive",
            cutline_simplify_auto=True, _simplify_memo=memo, **geometry)
    execute_s = time.perf_counter()-started
    destination = ROOT / "output/pdf/Cutline-quality-audit-2026-09-24/Binder2_p12_auto_with_preview_memo.pdf"
    with destination.open("xb") as stream:
        stream.write(result[0])
    with pikepdf.Pdf.open(source) as pdf:
        box = pdf.pages[11].cropbox
        width, height = float(box[2]-box[0]), float(box[3]-box[1])
    with pikepdf.Pdf.open(BytesIO(result[0])) as pdf:
        output_svg, output_count = _pdf_cut_svg(pdf.pages[0], width, height, 600, 600)
    evidence = dict(source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
                    geometry=geometry, preview_count=count, execute_count=output_count,
                    equal=svg == output_svg, warm_equal=(warm[:3] == (svg,count,quality)),
                    preview_cold_seconds=cold_s, preview_warm_seconds=warm_s,
                    execute_seconds=execute_s, memo_entries=len(memo),
                    simplify_calls_during_execute=spy.call_count, quality=quality,
                    preview_svg=svg, execute_svg=output_svg,
                    output=str(destination), scope="Worker inline + PDF artifact, không HTTP/Tauri/ProcessPool")
    target = Path(__file__).with_name("preview_auto_parity.json")
    with target.open("x", encoding="utf-8") as stream:
        json.dump(evidence, stream, ensure_ascii=False, indent=2)
    print(json.dumps({k:v for k,v in evidence.items() if not k.endswith("svg")}), flush=True)


if __name__ == "__main__":
    main()
