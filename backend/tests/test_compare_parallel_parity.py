"""Parity + policy cho pipeline so sánh song song (PERF audit 2026-08-13 §P25.1).

Bất biến phải giữ:

1. Kết quả (PageResult + result_summary) của đường pipeline PHẢI trùng đường
   tuần tự cũ trên cùng dữ liệu — song song hóa chỉ đổi tốc độ, không đổi đầu ra.
2. Cặp trang chỉ được xác định trước khi KHÔNG thể kích hoạt vòng dò tờ bình
   theo diện tích (ImageComparator Case B, ngưỡng 1.8) — ca đó giữ tuần tự.
3. Máy yếu (planner trả 1 worker) đi đúng đường tuần tự cũ, không mở pool.
"""
import io
import hashlib
import threading

import numpy as np
import pytest


# ── Helpers dựng PDF (độc lập với test_compare_pipeline để tránh phụ thuộc chéo) ──

def _mkpdf(path, n_pages=3, modify_page2=False, page_w=300, page_h=400):
    from app.workers import pdf_wrapper as pdf_lib
    d = pdf_lib.open()
    for i in range(n_pages):
        pg = d.new_page(width=page_w, height=page_h)
        sh = pg.new_shape()
        sh.draw_rect(pdf_lib.Rect(30, 30 + i * 40, 270, 120 + i * 40))
        sh.finish(color=(0, 0, 0), fill=(0, 0, 0))
        sh.commit()
        if modify_page2 and i == 1:
            sh2 = pg.new_shape()
            sh2.draw_rect(pdf_lib.Rect(180, 300, 260, 360))
            sh2.finish(color=(0, 0, 0), fill=(0, 0, 0))
            sh2.commit()
    buf = io.BytesIO(); d.save(buf); d.close()
    open(path, "wb").write(buf.getvalue())


def _run_job(
    tmp_path,
    tag,
    pa,
    pb,
    config=None,
    *,
    on_progress=None,
    cancel_check=None,
):
    """Chạy run_comparison_pipeline trên một DB SQLite riêng, trả (job, pages)."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.database import Base
    from app.models.job import UploadedFile, ComparisonJob, PageResult
    from app.core.comparison_engine import run_comparison_pipeline

    engine = create_engine(
        f"sqlite:///{tmp_path / f'parity_{tag}.db'}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    try:
        fa = UploadedFile(filename="A.pdf", original_name="A.pdf", file_path=str(pa), page_count=0)
        fb = UploadedFile(filename="B.pdf", original_name="B.pdf", file_path=str(pb), page_count=0)
        db.add(fa); db.add(fb); db.commit(); db.refresh(fa); db.refresh(fb)
        job = ComparisonJob(
            file_a_id=fa.id, file_b_id=fb.id,
            config=config or {"comparison_mode": "full", "tolerance": "NORMAL", "dpi": 100},
        )
        db.add(job); db.commit(); db.refresh(job)
        jid = job.id
        run_comparison_pipeline(
            jid,
            db,
            on_progress=on_progress,
            cancel_check=cancel_check,
        )
        job = db.query(ComparisonJob).filter(ComparisonJob.id == jid).first()
        pages = (
            db.query(PageResult)
            .filter(PageResult.job_id == jid)
            .order_by(PageResult.page_number)
            .all()
        )
        return job, pages
    finally:
        db.close()


def _page_snapshot(p):
    """Các trường quyết định của một PageResult — dùng so parity."""
    return {
        "page_number": p.page_number,
        "status": p.status,
        "similarity_score": round(float(p.similarity_score or 0.0), 4),
        "diff_count": p.diff_count,
        "diff_regions": p.diff_regions,
        "is_imposition_mode": bool(p.is_imposition_mode),
        "has_highlight": p.highlighted_image_path is not None,
    }


def _summary_snapshot(job):
    s = dict(job.result_summary or {})
    # visual_similarity/average_similarity là trung bình float — so sau khi làm tròn.
    for key in ("average_similarity", "visual_similarity"):
        if key in s:
            s[key] = round(float(s[key]), 3)
    return s


# ── 1. Parity end-to-end: tuần tự (ép 1 worker) vs pipeline (ép nhiều worker) ──

def test_parity_sequential_vs_pipeline_1to1(tmp_path, monkeypatch):
    pa = tmp_path / "A.pdf"; pb = tmp_path / "B.pdf"
    _mkpdf(pa, n_pages=4, modify_page2=False)
    _mkpdf(pb, n_pages=4, modify_page2=True)

    monkeypatch.setenv("PRYNX_COMPARE_WORKERS", "1")
    job_seq, pages_seq = _run_job(tmp_path, "seq", pa, pb)

    monkeypatch.setenv("PRYNX_COMPARE_WORKERS", "4")
    job_par, pages_par = _run_job(tmp_path, "par", pa, pb)

    assert job_seq.status == job_par.status == "completed"
    assert [_page_snapshot(p) for p in pages_seq] == [_page_snapshot(p) for p in pages_par]
    assert _summary_snapshot(job_seq) == _summary_snapshot(job_par)
    # Sanity: đúng 1 trang khác biệt như thiết kế dữ liệu.
    assert job_par.result_summary["pages_fail"] == 1


def test_tile_engine_keeps_verdict_regions_and_artifact_parity(tmp_path, monkeypatch):
    """PERF (audit 2026-08-19 §CL.3): ép trang nhỏ qua tile để test E2E."""
    import cv2
    from app.config import settings

    pa = tmp_path / "tile-A.pdf"
    pb = tmp_path / "tile-B.pdf"
    _mkpdf(pa, n_pages=2, modify_page2=False)
    _mkpdf(pb, n_pages=2, modify_page2=True)
    config = {"comparison_mode": "full", "tolerance": "NORMAL", "dpi": 100}
    monkeypatch.setenv("PRYNX_COMPARE_WORKERS", "1")
    monkeypatch.setenv("PRYNX_COMPARE_TILE_SIZE", "256")

    full_results = tmp_path / "results-full"
    monkeypatch.setattr(settings, "RESULTS_DIR", str(full_results))
    monkeypatch.setenv("PRYNX_MAX_COMPARE_PAGE_PIXELS", "10000000")
    full_job, full_pages = _run_job(tmp_path, "tile-full", pa, pb, config=config)

    tiled_results = tmp_path / "results-tiled"
    monkeypatch.setattr(settings, "RESULTS_DIR", str(tiled_results))
    monkeypatch.setenv("PRYNX_MAX_COMPARE_PAGE_PIXELS", "1")
    tiled_job, tiled_pages = _run_job(tmp_path, "tile-stream", pa, pb, config=config)

    assert [_page_snapshot(page) for page in tiled_pages] == [
        _page_snapshot(page) for page in full_pages
    ]
    assert _summary_snapshot(tiled_job) == _summary_snapshot(full_job)

    full_artifact = cv2.imread(
        str(full_results / str(full_job.id) / "page_2_diff.png"),
        cv2.IMREAD_UNCHANGED,
    )
    tiled_artifact = cv2.imread(
        str(tiled_results / str(tiled_job.id) / "page_2_diff.png"),
        cv2.IMREAD_UNCHANGED,
    )
    assert full_artifact is not None
    assert np.array_equal(tiled_artifact, full_artifact)


@pytest.mark.parametrize("page_b_size", [(280, 373), (260, 400)])
def test_tile_engine_different_page_sizes_keep_full_frame_parity(
    tmp_path, monkeypatch, page_b_size
):
    """Forced tile giữ parity E2E cho cả resize cùng aspect và pad khác aspect."""
    import cv2
    from app.config import settings

    pa = tmp_path / f"different-A-{page_b_size[0]}.pdf"
    pb = tmp_path / f"different-B-{page_b_size[0]}.pdf"
    _mkpdf(pa, n_pages=2, modify_page2=False, page_w=300, page_h=400)
    _mkpdf(
        pb,
        n_pages=2,
        modify_page2=True,
        page_w=page_b_size[0],
        page_h=page_b_size[1],
    )
    config = {"comparison_mode": "full", "tolerance": "STRICT", "dpi": 100}
    monkeypatch.setenv("PRYNX_COMPARE_WORKERS", "1")
    monkeypatch.setenv("PRYNX_COMPARE_TILE_SIZE", "256")

    full_results = tmp_path / f"results-different-full-{page_b_size[0]}"
    monkeypatch.setattr(settings, "RESULTS_DIR", str(full_results))
    monkeypatch.setenv("PRYNX_MAX_COMPARE_PAGE_PIXELS", "10000000")
    full_job, full_pages = _run_job(
        tmp_path, f"different-full-{page_b_size[0]}", pa, pb, config=config
    )

    tiled_results = tmp_path / f"results-different-tile-{page_b_size[0]}"
    monkeypatch.setattr(settings, "RESULTS_DIR", str(tiled_results))
    monkeypatch.setenv("PRYNX_MAX_COMPARE_PAGE_PIXELS", "1")
    monkeypatch.setenv("PRYNX_COMPARE_WORKERS", "4")
    monkeypatch.setenv("PRYNX_COMPARE_PROCESS_MIN_PAGES", "2")
    monkeypatch.setenv("PRYNX_COMPARE_PROCESS_MIN_PIXELS", "1")
    tiled_job, tiled_pages = _run_job(
        tmp_path, f"different-tile-{page_b_size[0]}", pa, pb, config=config
    )

    assert [_page_snapshot(page) for page in tiled_pages] == [
        _page_snapshot(page) for page in full_pages
    ]
    assert _summary_snapshot(tiled_job) == _summary_snapshot(full_job)
    full_artifact = cv2.imread(
        str(full_results / str(full_job.id) / "page_2_diff.png"),
        cv2.IMREAD_UNCHANGED,
    )
    tiled_artifact = cv2.imread(
        str(tiled_results / str(tiled_job.id) / "page_2_diff.png"),
        cv2.IMREAD_UNCHANGED,
    )
    assert full_artifact is not None
    assert np.array_equal(tiled_artifact, full_artifact)


@pytest.mark.parametrize("pixel_threshold", ["10000000", "1"])
def test_multiprocess_1to1_keeps_result_and_artifact_parity(
    tmp_path, monkeypatch, pixel_threshold
):
    """PERF (audit 2026-08-19 §CL.4): process tự mở PDF, main chỉ commit DB."""
    from app.config import settings

    pa = tmp_path / "process-A.pdf"
    pb = tmp_path / "process-B.pdf"
    _mkpdf(pa, n_pages=4, modify_page2=False)
    _mkpdf(pb, n_pages=4, modify_page2=True)
    results_root = tmp_path / "process-results"
    monkeypatch.setattr(settings, "RESULTS_DIR", str(results_root))
    monkeypatch.setenv("PRYNX_COMPARE_PROCESS_MIN_PAGES", "2")
    monkeypatch.setenv("PRYNX_COMPARE_PROCESS_MIN_PIXELS", "1")
    monkeypatch.setenv("PRYNX_MAX_COMPARE_PAGE_PIXELS", pixel_threshold)
    suffix = "full" if pixel_threshold != "1" else "tile"

    def hashes(job_id):
        return {
            path.name: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted((results_root / str(job_id)).iterdir())
        }

    monkeypatch.setenv("PRYNX_COMPARE_WORKERS", "1")
    monkeypatch.setenv("PRYNX_COMPARE_PROCESS_WORKERS", "1")
    sequential_job, sequential_pages = _run_job(
        tmp_path, f"process-sequential-{suffix}", pa, pb
    )
    sequential_hashes = hashes(sequential_job.id)

    monkeypatch.setenv("PRYNX_COMPARE_WORKERS", "2")
    monkeypatch.setenv("PRYNX_COMPARE_PROCESS_WORKERS", "2")
    process_job, process_pages = _run_job(
        tmp_path, f"process-parallel-{suffix}", pa, pb
    )

    assert [_page_snapshot(page) for page in process_pages] == [
        _page_snapshot(page) for page in sequential_pages
    ]
    assert _summary_snapshot(process_job) == _summary_snapshot(sequential_job)
    assert hashes(process_job.id) == sequential_hashes


def test_large_mixed_size_pair_uses_pad_tile_without_full_frame_render(
    tmp_path, monkeypatch
):
    """Cặp khác aspect chạy pad-tile, không dựng raster full DPI trong RAM."""
    from app.core.pdf_processor import PDFDocumentReader

    pa = tmp_path / "mixed-A.pdf"
    pb = tmp_path / "mixed-B.pdf"
    _mkpdf(pa, n_pages=1, page_w=3000, page_h=4000)
    _mkpdf(pb, n_pages=1, page_w=3200, page_h=4000)
    original_render_page = PDFDocumentReader.render_page

    def reject_full_dpi_render(reader, page_index):
        if reader.scale > 0.4:
            raise AssertionError("không được full-render ở DPI đối chiếu")
        return original_render_page(reader, page_index)

    monkeypatch.setenv("PRYNX_COMPARE_WORKERS", "1")
    monkeypatch.setenv("PRYNX_COMPARE_PROCESS_WORKERS", "1")
    monkeypatch.setenv("PRYNX_MAX_COMPARE_PAGE_PIXELS", "1")
    monkeypatch.setattr(PDFDocumentReader, "render_page", reject_full_dpi_render)

    job, pages = _run_job(tmp_path, "mixed-size-pad-tile", pa, pb)
    assert job.status == "completed"
    assert pages[0].status == "pass"


def test_large_imposition_uses_preview_detection_and_sheet_roi_reads(
    tmp_path, monkeypatch
):
    """Tờ bình lớn không gọi render_page full; chỉ preview + render_page_region."""
    from app.core.pdf_processor import PDFDocumentReader
    from app.workers import pdf_wrapper as pdf_lib

    template_path = tmp_path / "imposition-template.pdf"
    sheet_path = tmp_path / "imposition-sheet.pdf"

    def write_template(path, sheet=False):
        width, height = (6000, 8000) if sheet else (3000, 4000)
        document = pdf_lib.open()
        page = document.new_page(width=width, height=height)
        offsets = [(0, 0), (3000, 0), (0, 4000), (3000, 4000)] if sheet else [(0, 0)]
        for offset_x, offset_y in offsets:
            shape = page.new_shape()
            shape.draw_rect(
                pdf_lib.Rect(offset_x + 300, offset_y + 500, offset_x + 1800, offset_y + 2300)
            )
            shape.finish(color=(0, 0, 0), fill=(0, 0, 0))
            shape.commit()
            shape = page.new_shape()
            shape.draw_rect(
                pdf_lib.Rect(offset_x + 2100, offset_y + 2900, offset_x + 2700, offset_y + 3600)
            )
            shape.finish(color=(0, 0, 0), fill=(0.2, 0.2, 0.2))
            shape.commit()
        buffer = io.BytesIO()
        document.save(buffer)
        document.close()
        path.write_bytes(buffer.getvalue())

    write_template(template_path)
    write_template(sheet_path, sheet=True)

    original_render_page = PDFDocumentReader.render_page

    def reject_full_sheet_render(reader, page_index):
        if reader.scale > 0.4:
            raise AssertionError("không được dựng full raster tờ bình")
        return original_render_page(reader, page_index)

    monkeypatch.setattr(PDFDocumentReader, "render_page", reject_full_sheet_render)
    monkeypatch.setenv("PRYNX_MAX_COMPARE_PAGE_PIXELS", "1")
    monkeypatch.setenv("PRYNX_COMPARE_WORKERS", "1")
    monkeypatch.setenv("PRYNX_COMPARE_PROCESS_WORKERS", "1")
    config = {
        "comparison_mode": "full",
        "page_matching_mode": "auto",
        "tolerance": "NORMAL",
        "dpi": 100,
    }

    job, pages = _run_job(
        tmp_path,
        "large-imposition-roi",
        template_path,
        sheet_path,
        config=config,
    )

    assert job.status == "completed"
    assert pages[0].is_imposition_mode is True
    assert job.result_summary["total_instances"] >= 4


def test_parity_sequential_vs_pipeline_alignment_inserted_page(tmp_path, monkeypatch):
    """Lệch số trang → nhánh căn trang; cặp đã chốt trước nên pipeline phải bật
    và cho kết quả trùng tuần tự (kể cả nhãn trang THÊM)."""
    from app.workers import pdf_wrapper as pdf_lib

    def mk(path, kinds):
        d = pdf_lib.open()
        boxes = {
            0: (20, 20, 140, 120),
            1: (160, 20, 280, 120),
            2: (20, 280, 280, 380),
            "X": (120, 160, 200, 240),
        }
        for k in kinds:
            pg = d.new_page(width=300, height=400)
            sh = pg.new_shape()
            x0, y0, x1, y1 = boxes[k]
            sh.draw_rect(pdf_lib.Rect(x0, y0, x1, y1))
            sh.finish(color=(0, 0, 0), fill=(0, 0, 0))
            sh.commit()
        buf = io.BytesIO(); d.save(buf); d.close()
        open(path, "wb").write(buf.getvalue())

    pa = tmp_path / "A.pdf"; pb = tmp_path / "B.pdf"
    mk(pa, [0, 1, 2])
    mk(pb, [0, "X", 1, 2])

    monkeypatch.setenv("PRYNX_COMPARE_WORKERS", "1")
    job_seq, pages_seq = _run_job(tmp_path, "alseq", pa, pb)
    monkeypatch.setenv("PRYNX_COMPARE_WORKERS", "4")
    job_par, pages_par = _run_job(tmp_path, "alpar", pa, pb)

    assert [_page_snapshot(p) for p in pages_seq] == [_page_snapshot(p) for p in pages_par]
    assert _summary_snapshot(job_seq) == _summary_snapshot(job_par)
    # Trang chèn phải giữ đúng nhãn "THÊM" ở cả hai đường.
    added = [p for p in pages_par if p.diff_regions and "THÊM" in p.diff_regions[0]["description"]]
    assert len(added) == 1


def test_parity_cmyk_mode(tmp_path, monkeypatch):
    pa = tmp_path / "A.pdf"; pb = tmp_path / "B.pdf"
    _mkpdf(pa, n_pages=3, modify_page2=False)
    _mkpdf(pb, n_pages=3, modify_page2=True)
    cfg = {"comparison_mode": "cmyk", "tolerance": "NORMAL", "dpi": 100}

    monkeypatch.setenv("PRYNX_COMPARE_WORKERS", "1")
    job_seq, pages_seq = _run_job(tmp_path, "cmseq", pa, pb, config=cfg)
    monkeypatch.setenv("PRYNX_COMPARE_WORKERS", "4")
    job_par, pages_par = _run_job(tmp_path, "cmpar", pa, pb, config=cfg)

    assert job_seq.status == job_par.status == "completed"
    assert [_page_snapshot(p) for p in pages_seq] == [_page_snapshot(p) for p in pages_par]
    assert _summary_snapshot(job_seq) == _summary_snapshot(job_par)


def test_render_page_bundle_matches_separate_rgb_and_cmyk_renders(tmp_path):
    """PERF (audit 2026-08-19 §COMPARE.CMYK.1): gộp raster không đổi bitmap."""
    from app.core.pdf_processor import PDFProcessor

    source = tmp_path / "bundle.pdf"
    _mkpdf(source, n_pages=1)
    processor = PDFProcessor()

    with processor.open_document(str(source), dpi=100) as bundled:
        rgb_bundle, cmyk_bundle = bundled.render_page_bundle(0, include_cmyk=True)

    with processor.open_document(str(source), dpi=100) as separate:
        rgb_separate = separate.render_page(0)
        cmyk_separate = separate.render_page_cmyk(0)

    assert cmyk_bundle is not None
    assert np.array_equal(rgb_bundle, rgb_separate)
    assert np.array_equal(cmyk_bundle, cmyk_separate)


# ── 2. Policy lập cặp trước (_plan_pipeline_pairs) ──

class _FakeDoc:
    def __init__(self, sizes):
        self._sizes = sizes

    def page_size(self, i):
        return self._sizes[i]


def test_plan_pairs_identity_when_all_pages_same_area():
    from app.core.comparison_engine import _plan_pipeline_pairs

    doc = _FakeDoc([(300, 400)] * 3)
    work_seq = [(i, None) for i in range(3)]
    pairs = _plan_pipeline_pairs(
        doc, doc, 3, 3, work_seq,
        document_imposition=False, use_alignment=False, is_cmyk_mode=False,
    )
    assert pairs == [(0, 0, 0, True), (1, 1, 1, True), (2, 2, 2, True)]


def test_plan_pairs_bails_to_sequential_when_area_ratio_can_trigger_imposition():
    """Tờ B rộng gấp đôi (tỉ lệ diện tích 2.0 ≥ 1.8) → comparator sẽ vào chế độ dò
    tờ bình và con trỏ B ngừng tiến; pipeline PHẢI từ chối để giữ vòng hunting."""
    from app.core.comparison_engine import _plan_pipeline_pairs

    doc_a = _FakeDoc([(300, 400)] * 2)
    doc_b = _FakeDoc([(600, 400)] * 2)
    work_seq = [(i, None) for i in range(2)]
    pairs = _plan_pipeline_pairs(
        doc_a, doc_b, 2, 2, work_seq,
        document_imposition=False, use_alignment=False, is_cmyk_mode=False,
    )
    assert pairs is None


def test_plan_pairs_bails_when_page_counts_differ_without_alignment():
    from app.core.comparison_engine import _plan_pipeline_pairs

    doc = _FakeDoc([(300, 400)] * 5)
    work_seq = [(i, None) for i in range(5)]
    pairs = _plan_pipeline_pairs(
        doc, doc, 5, 3, work_seq,
        document_imposition=False, use_alignment=False, is_cmyk_mode=False,
    )
    assert pairs is None


def test_plan_pairs_cmyk_saturating_cursor_matches_sequential_semantics():
    """CMYK: con trỏ B bão hòa ở trang cuối của B (min(i, pages_b-1)) và trang
    thiếu giữ found_b = giá trị con trỏ — đúng semantics vòng tuần tự cũ."""
    from app.core.comparison_engine import _plan_pipeline_pairs

    doc = _FakeDoc([(300, 400)] * 4)
    work_seq = [(i, None) for i in range(4)]
    pairs = _plan_pipeline_pairs(
        doc, doc, 4, 2, work_seq,
        document_imposition=False, use_alignment=False, is_cmyk_mode=True,
    )
    assert pairs == [
        (0, 0, 0, True),
        (1, 1, 1, True),
        (2, 1, 1, True),
        (3, 1, 1, True),
    ]


def test_plan_pairs_alignment_freezes_missing_row_semantics():
    from app.core.comparison_engine import _plan_pipeline_pairs

    doc = _FakeDoc([(300, 400)] * 4)
    work_seq = [(0, 0), (None, 1), (1, 2), (2, None)]
    pairs = _plan_pipeline_pairs(
        doc, doc, 3, 4, work_seq,
        document_imposition=False, use_alignment=True, is_cmyk_mode=False,
    )
    assert pairs == [
        (0, 0, 0, True),
        (None, 1, 1, False),   # trang THÊM: found_b = b
        (1, 2, 2, True),
        (2, None, 0, False),   # trang XOÁ: current_b_idx đóng băng 0 (quirk cũ giữ nguyên)
    ]


def test_plan_pairs_document_imposition_unmapped_page():
    from app.core.comparison_engine import _plan_pipeline_pairs

    doc = _FakeDoc([(300, 400)] * 3)
    work_seq = [(0, 1), (1, None), (2, 0)]
    pairs = _plan_pipeline_pairs(
        doc, doc, 3, 2, work_seq,
        document_imposition=True, use_alignment=False, is_cmyk_mode=False,
    )
    assert pairs == [
        (0, 1, 1, True),
        (1, None, -1, False),  # không tìm thấy trên tờ nào: found_b = -1 → b_page None
        (2, 0, 0, True),
    ]


# ── 3. Máy yếu: 1 worker → không mở pool, đi đường tuần tự ──

def test_single_worker_uses_sequential_path(tmp_path, monkeypatch):
    import app.core.comparison_engine as ce

    pa = tmp_path / "A.pdf"; pb = tmp_path / "B.pdf"
    _mkpdf(pa, n_pages=2)
    _mkpdf(pb, n_pages=2)

    monkeypatch.setenv("PRYNX_COMPARE_WORKERS", "1")
    called = {"plan": 0}
    original_plan = ce._plan_pipeline_pairs

    def spy_plan(*args, **kwargs):
        called["plan"] += 1
        return original_plan(*args, **kwargs)

    monkeypatch.setattr(ce, "_plan_pipeline_pairs", spy_plan)
    job, pages = _run_job(tmp_path, "weak", pa, pb)
    assert job.status == "completed"
    # workers == 1 → không được lập kế hoạch pipeline (đường cũ nguyên vẹn).
    assert called["plan"] == 0


def test_pipeline_restores_opencv_thread_budget(tmp_path, monkeypatch):
    import cv2

    pa = tmp_path / "A.pdf"; pb = tmp_path / "B.pdf"
    _mkpdf(pa, n_pages=3)
    _mkpdf(pb, n_pages=3, modify_page2=True)
    monkeypatch.setenv("PRYNX_COMPARE_WORKERS", "4")
    monkeypatch.setenv("PRYNX_COMPARE_CV_THREADS", "1")

    original = cv2.getNumThreads()
    job, _pages = _run_job(tmp_path, "cvthreads", pa, pb)

    assert job.status == "completed"
    assert cv2.getNumThreads() == original


def test_pipeline_restores_opencv_threads_when_compare_fails(tmp_path, monkeypatch):
    import cv2
    from app.core.image_comparator import ImageComparator

    pa = tmp_path / "A.pdf"; pb = tmp_path / "B.pdf"
    _mkpdf(pa, n_pages=3)
    _mkpdf(pb, n_pages=3, modify_page2=True)
    monkeypatch.setenv("PRYNX_COMPARE_WORKERS", "4")
    monkeypatch.setenv("PRYNX_COMPARE_CV_THREADS", "1")
    original_compare = ImageComparator.compare
    calls_by_instance = {}

    def fail_first(self, *args, **kwargs):
        calls = calls_by_instance.get(id(self), 0) + 1
        calls_by_instance[id(self)] = calls
        if calls == 1:
            raise RuntimeError("opencv-budget-fault")
        return original_compare(self, *args, **kwargs)

    original_threads = cv2.getNumThreads()
    monkeypatch.setattr(ImageComparator, "compare", fail_first)

    with pytest.raises(RuntimeError, match="opencv-budget-fault"):
        _run_job(tmp_path, "cvthreads-fault", pa, pb)
    assert cv2.getNumThreads() == original_threads


def test_pipeline_progress_is_monotonic_and_reports_first_page_early(tmp_path, monkeypatch):
    pa = tmp_path / "A.pdf"; pb = tmp_path / "B.pdf"
    _mkpdf(pa, n_pages=5)
    _mkpdf(pb, n_pages=5, modify_page2=True)
    monkeypatch.setenv("PRYNX_COMPARE_WORKERS", "4")

    updates = []

    def capture(job_id, progress, status, current_page, total_pages, message):
        updates.append((progress, status, current_page, total_pages, message))

    job, _pages = _run_job(
        tmp_path, "progress", pa, pb, on_progress=capture,
    )
    page_updates = [item for item in updates if item[2] > 0]

    assert job.status == "completed"
    assert [item[0] for item in updates] == sorted(item[0] for item in updates)
    assert page_updates[0][2:] == (1, 5, "Đang so sánh trang 1/5...")
    assert [item[2] for item in page_updates] == [1, 2, 3, 4, 5]
    assert all(item[3] == 5 for item in page_updates)


def test_cancel_cleans_partial_rows_and_artifacts(tmp_path, monkeypatch):
    from app.config import settings

    pa = tmp_path / "A.pdf"; pb = tmp_path / "B.pdf"
    _mkpdf(pa, n_pages=4)
    _mkpdf(pb, n_pages=4, modify_page2=True)
    results_root = tmp_path / "cancel-results"
    monkeypatch.setattr(settings, "RESULTS_DIR", str(results_root))
    monkeypatch.setenv("PRYNX_COMPARE_WORKERS", "1")

    cancel_event = threading.Event()

    def request_cancel_on_second_page(
        job_id, progress, status, current_page, total_pages, message,
    ):
        if current_page == 2:
            cancel_event.set()

    job, pages = _run_job(
        tmp_path,
        "cancel",
        pa,
        pb,
        on_progress=request_cancel_on_second_page,
        cancel_check=cancel_event.is_set,
    )

    assert job.status == "cancelled"
    assert job.result_summary is None
    assert pages == []
    assert not (results_root / job.id).exists()


def test_fault_cleans_partial_rows_and_artifacts(tmp_path, monkeypatch):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.config import settings
    from app.core.image_comparator import ImageComparator
    from app.models.job import ComparisonJob, PageResult

    pa = tmp_path / "A.pdf"; pb = tmp_path / "B.pdf"
    _mkpdf(pa, n_pages=4)
    _mkpdf(pb, n_pages=4, modify_page2=True)
    results_root = tmp_path / "fault-results"
    monkeypatch.setattr(settings, "RESULTS_DIR", str(results_root))
    monkeypatch.setenv("PRYNX_COMPARE_WORKERS", "1")

    original_compare = ImageComparator.compare
    calls_by_instance = {}

    def fail_second_compare(self, *args, **kwargs):
        calls = calls_by_instance.get(id(self), 0) + 1
        calls_by_instance[id(self)] = calls
        if calls == 2:
            raise RuntimeError("fault-injection-page-2")
        return original_compare(self, *args, **kwargs)

    monkeypatch.setattr(ImageComparator, "compare", fail_second_compare)
    with pytest.raises(RuntimeError, match="fault-injection-page-2"):
        _run_job(tmp_path, "fault", pa, pb)

    engine = create_engine(f"sqlite:///{tmp_path / 'parity_fault.db'}")
    db = sessionmaker(bind=engine)()
    try:
        job = db.query(ComparisonJob).one()
        assert job.status == "failed"
        assert job.result_summary is None
        assert db.query(PageResult).filter(PageResult.job_id == job.id).count() == 0
        assert not (results_root / job.id).exists()
    finally:
        db.close()
        engine.dispose()


def test_png_write_failure_rolls_back_page_and_artifact(tmp_path, monkeypatch):
    import cv2
    from app.config import settings

    pa = tmp_path / "A.pdf"; pb = tmp_path / "B.pdf"
    _mkpdf(pa, n_pages=2)
    _mkpdf(pb, n_pages=2, modify_page2=True)
    results_root = tmp_path / "png-write-fault"
    monkeypatch.setattr(settings, "RESULTS_DIR", str(results_root))
    monkeypatch.setenv("PRYNX_COMPARE_WORKERS", "1")
    monkeypatch.setattr(cv2, "imwrite", lambda *args, **kwargs: False)

    with pytest.raises(OSError, match="Không ghi được ảnh khác biệt"):
        _run_job(tmp_path, "png-write-fault", pa, pb)

    assert not results_root.exists() or not any(results_root.iterdir())


def test_pipeline_worker_png_encode_failure_cleans_partial_output(tmp_path, monkeypatch):
    """PB-2: encode PNG chạy trong worker — lỗi encode phải có cùng semantics với
    lỗi ghi PNG cũ: job failed, không còn PageResult/artifact dở dang."""
    import cv2
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.config import settings
    from app.models.job import ComparisonJob, PageResult

    pa = tmp_path / "A.pdf"; pb = tmp_path / "B.pdf"
    _mkpdf(pa, n_pages=3)
    _mkpdf(pb, n_pages=3, modify_page2=True)
    results_root = tmp_path / "encode-fault-results"
    monkeypatch.setattr(settings, "RESULTS_DIR", str(results_root))
    monkeypatch.setenv("PRYNX_COMPARE_WORKERS", "4")
    monkeypatch.setattr(cv2, "imencode", lambda *args, **kwargs: (False, None))

    with pytest.raises(OSError, match="Không encode được ảnh khác biệt"):
        _run_job(tmp_path, "encode-fault", pa, pb)

    engine = create_engine(f"sqlite:///{tmp_path / 'parity_encode-fault.db'}")
    db = sessionmaker(bind=engine)()
    try:
        job = db.query(ComparisonJob).one()
        assert job.status == "failed"
        assert db.query(PageResult).filter(PageResult.job_id == job.id).count() == 0
        assert not (results_root / job.id).exists()
    finally:
        db.close()
        engine.dispose()


def test_commit_batching_flushes_all_pages_at_end(tmp_path, monkeypatch):
    """PB-2: dù ngưỡng lô đặt lớn hơn tổng số trang, mọi PageResult vẫn phải được
    chốt (force-flush cuối vòng) và job hoàn tất bình thường."""
    import app.core.comparison_engine as ce

    pa = tmp_path / "A.pdf"; pb = tmp_path / "B.pdf"
    _mkpdf(pa, n_pages=5)
    _mkpdf(pb, n_pages=5, modify_page2=True)
    monkeypatch.setenv("PRYNX_COMPARE_WORKERS", "4")
    monkeypatch.setattr(ce, "_COMPARE_COMMIT_BATCH_PAGES", 999)
    monkeypatch.setattr(ce, "_COMPARE_COMMIT_MAX_LAG_S", 999.0)

    job, pages = _run_job(tmp_path, "batch-flush", pa, pb)

    assert job.status == "completed"
    assert len(pages) == 5
    assert job.result_summary["total_pages"] == 5


def test_png_and_gif_bytes_match_between_sequential_and_pipeline(tmp_path, monkeypatch):
    from app.config import settings

    pa = tmp_path / "A.pdf"; pb = tmp_path / "B.pdf"
    _mkpdf(pa, n_pages=4)
    _mkpdf(pb, n_pages=4, modify_page2=True)
    results_root = tmp_path / "artifact-results"
    monkeypatch.setattr(settings, "RESULTS_DIR", str(results_root))

    def hashes(job_id):
        return {
            path.name: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted((results_root / job_id).iterdir())
        }

    monkeypatch.setenv("PRYNX_COMPARE_WORKERS", "1")
    seq_job, _ = _run_job(tmp_path, "artifact-seq", pa, pb)
    seq_hashes = hashes(seq_job.id)

    monkeypatch.setenv("PRYNX_COMPARE_WORKERS", "4")
    par_job, _ = _run_job(tmp_path, "artifact-par", pa, pb)
    par_hashes = hashes(par_job.id)

    assert any(name.endswith(".png") for name in seq_hashes)
    assert any(name.endswith(".gif") for name in seq_hashes)
    assert seq_hashes == par_hashes
