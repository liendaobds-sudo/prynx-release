"""End-to-end regression test cho run_comparison_pipeline (tính năng so sánh phiên bản).

Chốt lỗi CĂN TRANG đã sửa: trước đây con trỏ trang B không tiến → MỌI trang A so với
B[0] → trang giống hệt vẫn báo khác biệt giả. Test dựng 2 PDF 3 trang (B sửa đúng
trang 2) và yêu cầu: trang 1 & 3 PASS sạch, chỉ trang 2 phát hiện khác biệt.
"""
import io
import os

import pytest


def _mkpdf(path, modify_page2=False):
    from app.workers import pdf_wrapper as pdf_lib
    d = pdf_lib.open()
    for i in range(3):
        pg = d.new_page(width=300, height=400)
        sh = pg.new_shape()
        sh.draw_rect(pdf_lib.Rect(30, 30 + i * 40, 270, 120 + i * 40))
        sh.finish(color=(0, 0, 0), fill=(0, 0, 0))
        sh.commit()
        if modify_page2 and i == 1:
            sh2 = pg.new_shape()
            sh2.draw_rect(pdf_lib.Rect(180, 300, 260, 360))  # ô thêm CHỈ ở B trang 2
            sh2.finish(color=(0, 0, 0), fill=(0, 0, 0))
            sh2.commit()
    buf = io.BytesIO(); d.save(buf); d.close()
    open(path, 'wb').write(buf.getvalue())


def _run_pipeline(tmp_path, comparison_mode="full"):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.database import Base
    from app.models.job import UploadedFile, ComparisonJob, PageResult
    from app.core.comparison_engine import run_comparison_pipeline

    pa = str(tmp_path / "A.pdf"); pb = str(tmp_path / "B.pdf")
    _mkpdf(pa, modify_page2=False)
    _mkpdf(pb, modify_page2=True)

    engine = create_engine(f"sqlite:///{tmp_path / 'cmp.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    try:
        fa = UploadedFile(filename="A.pdf", original_name="A.pdf", file_path=pa, page_count=3)
        fb = UploadedFile(filename="B.pdf", original_name="B.pdf", file_path=pb, page_count=3)
        db.add(fa); db.add(fb); db.commit(); db.refresh(fa); db.refresh(fb)
        job = ComparisonJob(file_a_id=fa.id, file_b_id=fb.id,
                            config={"comparison_mode": comparison_mode, "tolerance": "NORMAL", "dpi": 100})
        db.add(job); db.commit(); db.refresh(job)
        jid = job.id
        run_comparison_pipeline(jid, db)
        job = db.query(ComparisonJob).filter(ComparisonJob.id == jid).first()
        results = db.query(PageResult).filter(PageResult.job_id == jid).order_by(PageResult.page_number).all()
        return job, {r.page_number: r for r in results}
    finally:
        db.close()


def test_pipeline_completes_and_saves_per_page(tmp_path):
    job, pages = _run_pipeline(tmp_path)
    assert job.status == "completed"
    assert job.progress == 100
    assert job.total_pages == 3
    assert len(pages) == 3


def test_pages_aligned_1to1_only_changed_page_flagged(tmp_path):
    """REGRESSION: trang giống hệt (1 & 3) phải PASS 0 diff; chỉ trang 2 (B thêm ô) khác."""
    job, pages = _run_pipeline(tmp_path)
    p1, p2, p3 = pages[1], pages[2], pages[3]
    # Trang 1 & 3 giống hệt → KHÔNG được báo khác biệt (lỗi cũ: bị so với B[0] → fail giả).
    assert p1.diff_count == 0 and p1.similarity_score >= 99.0, "Trang 1 phải sạch"
    assert p3.diff_count == 0 and p3.similarity_score >= 99.0, "Trang 3 phải sạch (căn 1:1 đúng)"
    # Trang 2 có ô thêm → phải phát hiện khác biệt.
    assert p2.diff_count >= 1 and p2.similarity_score < 99.0, "Trang 2 phải bị phát hiện khác"


def test_summary_reflects_single_changed_page(tmp_path):
    job, pages = _run_pipeline(tmp_path)
    s = job.result_summary
    assert s["total_pages"] == 3
    assert s["pages_fail"] + s["pages_warning"] == 1   # đúng 1 trang có vấn đề
    assert s["pages_pass"] == 2
    # In ấn: có lỗi → FAIL + KHÔNG ĐẠT (không còn WARNING vì SSIM cao)
    assert s["overall_status"] == "FAIL"
    assert s.get("print_verdict") == "KHÔNG ĐẠT"
    assert s.get("total_diff_count", 0) >= 1
    assert s.get("compare_method") == "pixel"
    assert "visual_similarity" in s


# ── Căn trang khi LỆCH SỐ TRANG (audit so-sánh #4) ──

def _draw_kind(d, kind):
    """Vẽ 1 trang theo 'kind' (0/1/2 = 3 mẫu khác nhau rõ rệt; 'X' = trang lạ)."""
    from app.workers import pdf_wrapper as pdf_lib
    pg = d.new_page(width=300, height=400)
    sh = pg.new_shape()
    boxes = {
        0: (20, 20, 140, 120),      # góc trên-trái
        1: (160, 20, 280, 120),     # góc trên-phải
        2: (20, 280, 280, 380),     # dải dưới
        "X": (120, 160, 200, 240),  # ô giữa (trang chèn, khác hẳn)
    }
    x0, y0, x1, y1 = boxes[kind]
    sh.draw_rect(pdf_lib.Rect(x0, y0, x1, y1))
    sh.finish(color=(0, 0, 0), fill=(0, 0, 0))
    sh.commit()


def _mkpdf_kinds(path, kinds):
    import io as _io
    from app.workers import pdf_wrapper as pdf_lib
    d = pdf_lib.open()
    for k in kinds:
        _draw_kind(d, k)
    buf = _io.BytesIO(); d.save(buf); d.close()
    open(path, "wb").write(buf.getvalue())


def _run_pipeline_files(tmp_path, kinds_a, kinds_b):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.database import Base
    from app.models.job import UploadedFile, ComparisonJob, PageResult
    from app.core.comparison_engine import run_comparison_pipeline

    pa = str(tmp_path / "A.pdf"); pb = str(tmp_path / "B.pdf")
    _mkpdf_kinds(pa, kinds_a)
    _mkpdf_kinds(pb, kinds_b)

    engine = create_engine(f"sqlite:///{tmp_path / 'cmp2.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    try:
        fa = UploadedFile(filename="A.pdf", original_name="A.pdf", file_path=pa, page_count=len(kinds_a))
        fb = UploadedFile(filename="B.pdf", original_name="B.pdf", file_path=pb, page_count=len(kinds_b))
        db.add(fa); db.add(fb); db.commit(); db.refresh(fa); db.refresh(fb)
        job = ComparisonJob(file_a_id=fa.id, file_b_id=fb.id,
                            config={"comparison_mode": "full", "tolerance": "NORMAL", "dpi": 100})
        db.add(job); db.commit(); db.refresh(job)
        jid = job.id
        run_comparison_pipeline(jid, db)
        results = db.query(PageResult).filter(PageResult.job_id == jid).order_by(PageResult.page_number).all()
        job = db.query(ComparisonJob).filter(ComparisonJob.id == jid).first()
        return job, {r.page_number: r for r in results}
    finally:
        db.close()


def test_inserted_page_does_not_cascade_false_diffs(tmp_path):
    """B chèn thêm 1 trang lạ ở giữa → các trang khớp vẫn SẠCH (không cascade),
    chỉ trang chèn bị báo 'được THÊM'. Trước khi có căn trang: mọi trang sau điểm
    chèn đều báo khác biệt giả."""
    # A: 3 mẫu ; B: chèn trang 'X' vào sau mẫu 0 → [0, X, 1, 2]
    job, pages = _run_pipeline_files(tmp_path, [0, 1, 2], [0, "X", 1, 2])
    assert job.status == "completed"
    assert len(pages) == 4

    # Thứ tự căn: (0,0)=sạch, (None,1)=X thêm, (1,2)=sạch, (2,3)=sạch
    assert pages[1].diff_count == 0, "Mẫu 0 phải khớp sạch"
    assert pages[3].diff_count == 0, "Mẫu 1 phải khớp sạch (không bị lệch do trang chèn)"
    assert pages[4].diff_count == 0, "Mẫu 2 phải khớp sạch (không cascade)"

    added = pages[2]
    assert added.status == "fail"
    assert "THÊM" in added.diff_regions[0]["description"]


def _mk_booklet_source(path, changed_page=None):
    """Create four unique source pages with an explicit 10pt bleed/TrimBox."""
    from app.workers import pdf_wrapper as pdf_lib

    doc = pdf_lib.open()
    for index in range(4):
        page = doc.new_page(width=300, height=400)
        page.set_trimbox(pdf_lib.Rect(10, 10, 290, 390))
        shape = page.new_shape()
        # Unique, high-contrast geometry fully inside TrimBox.
        x0 = 35 + index * 35
        y0 = 45 + index * 55
        shape.draw_rect(pdf_lib.Rect(x0, y0, min(x0 + 105, 270), min(y0 + 85, 365)))
        shape.finish(color=(0, 0, 0), fill=(0.12 * index, 0.05, 0.08))
        shape.commit()
        page.insert_text(
            pdf_lib.Point(35, 350),
            text=f"SOURCE PAGE {index + 1}",
            fontsize=18,
            color=(0, 0, 0, 1),
        )
        if changed_page == index:
            changed = page.new_shape()
            changed.draw_rect(pdf_lib.Rect(205, 305, 260, 350))
            changed.finish(color=(0, 0, 0), fill=(0, 0, 0))
            changed.commit()
    doc.save(str(path))
    doc.close()


def _impose_booklet(source_path, output_path):
    """Impose [4,1] and [2,3], clipping the source bleed to TrimBox."""
    from app.workers import pdf_wrapper as pdf_lib

    source = pdf_lib.open(str(source_path))
    output = pdf_lib.open()
    trim = pdf_lib.Rect(10, 10, 290, 390)
    for left_page, right_page in ((3, 0), (1, 2)):
        sheet = output.new_page(width=560, height=380)
        sheet.show_pdf_page(
            pdf_lib.Rect(0, 0, 280, 380),
            source,
            left_page,
            clip=trim,
            keep_proportion=False,
        )
        sheet.show_pdf_page(
            pdf_lib.Rect(280, 0, 560, 380),
            source,
            right_page,
            clip=trim,
            keep_proportion=False,
        )
    output.save(str(output_path))
    output.close()
    source.close()


def _run_pipeline_paths(tmp_path, source_path, imposed_path):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.core.comparison_engine import run_comparison_pipeline
    from app.database import Base
    from app.models.job import ComparisonJob, PageResult, UploadedFile

    engine = create_engine(
        f"sqlite:///{tmp_path / 'booklet_compare.db'}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    try:
        file_a = UploadedFile(
            filename="source.pdf",
            original_name="source.pdf",
            file_path=str(source_path),
            page_count=4,
        )
        file_b = UploadedFile(
            filename="booklet.pdf",
            original_name="booklet.pdf",
            file_path=str(imposed_path),
            page_count=2,
        )
        db.add(file_a)
        db.add(file_b)
        db.commit()
        db.refresh(file_a)
        db.refresh(file_b)
        job = ComparisonJob(
            file_a_id=file_a.id,
            file_b_id=file_b.id,
            config={
                "comparison_mode": "full",
                "page_matching_mode": "auto",
                "tolerance": "NORMAL",
                "dpi": 100,
            },
        )
        db.add(job)
        db.commit()
        db.refresh(job)
        run_comparison_pipeline(job.id, db)
        db.refresh(job)
        pages = (
            db.query(PageResult)
            .filter(PageResult.job_id == job.id)
            .order_by(PageResult.page_number)
            .all()
        )
        return job, pages
    finally:
        db.close()


def test_booklet_reorder_and_trimbox_bleed_do_not_create_false_diffs(tmp_path):
    source = tmp_path / "source.pdf"
    booklet = tmp_path / "booklet.pdf"
    _mk_booklet_source(source)
    _impose_booklet(source, booklet)

    job, pages = _run_pipeline_paths(tmp_path, source, booklet)

    assert job.status == "completed"
    assert job.result_summary["page_matching_mode"] == "imposition"
    assert job.result_summary["page_mapping"] == [1, 2, 2, 1]
    assert len(pages) == 4
    assert all(page.is_imposition_mode for page in pages)
    assert all(page.diff_count == 0 for page in pages)
    assert all(page.status == "pass" for page in pages)

    from app.api.routes.results import _build_page_response

    responses = [_build_page_response(page, job.result_summary) for page in pages]
    assert [response.matched_b_page for response in responses] == [1, 2, 2, 1]
    assert all(response.is_imposition_mode for response in responses)


def test_booklet_reports_only_the_source_page_with_real_artwork_change(tmp_path):
    source = tmp_path / "source.pdf"
    changed_source = tmp_path / "changed_source.pdf"
    booklet = tmp_path / "booklet.pdf"
    _mk_booklet_source(source)
    _mk_booklet_source(changed_source, changed_page=1)
    _impose_booklet(changed_source, booklet)

    job, pages = _run_pipeline_paths(tmp_path, source, booklet)

    assert job.status == "completed"
    assert pages[1].diff_count >= 1
    assert pages[1].status == "fail"
    assert all(page.diff_count == 0 for page in (pages[0], pages[2], pages[3]))


# ── Trần lượt dò bình bài + tín hiệu sống trong lúc dò (audit 2026-08-13 §PB-3) ──

def _setup_booklet_job(tmp_path):
    """Dựng job booklet (4 trang nguồn × 2 tờ bình) nhưng CHƯA chạy pipeline."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.database import Base
    from app.models.job import ComparisonJob, UploadedFile

    source = tmp_path / "source.pdf"
    booklet = tmp_path / "booklet.pdf"
    _mk_booklet_source(source)
    _impose_booklet(source, booklet)

    engine = create_engine(
        f"sqlite:///{tmp_path / 'booklet_cap.db'}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    file_a = UploadedFile(
        filename="source.pdf", original_name="source.pdf",
        file_path=str(source), page_count=4,
    )
    file_b = UploadedFile(
        filename="booklet.pdf", original_name="booklet.pdf",
        file_path=str(booklet), page_count=2,
    )
    db.add(file_a); db.add(file_b); db.commit()
    db.refresh(file_a); db.refresh(file_b)
    job = ComparisonJob(
        file_a_id=file_a.id,
        file_b_id=file_b.id,
        config={
            "comparison_mode": "full",
            "page_matching_mode": "auto",
            "tolerance": "NORMAL",
            "dpi": 100,
        },
    )
    db.add(job); db.commit(); db.refresh(job)
    return db, job.id


def test_imposition_map_over_cap_fails_fast_with_guidance(tmp_path, monkeypatch):
    """Job bình bài vượt trần A×B phải fail NGAY với hướng dẫn tiếng Việt — chặn
    bùng nổ O(A×B) hàng giờ trên tài liệu dài (audit 2026-08-13 §PB-3)."""
    from app.core.comparison_engine import run_comparison_pipeline
    from app.models.job import ComparisonJob, PageResult

    db, jid = _setup_booklet_job(tmp_path)
    # Booklet chuẩn: 4 trang nguồn × 2 tờ = 8 lượt dò; hạ trần xuống 7 để kích hoạt.
    monkeypatch.setenv("PRYNX_MAX_IMPOSITION_MAP_CELLS", "7")
    try:
        with pytest.raises(ValueError, match="so bình bài"):
            run_comparison_pipeline(jid, db)
        job = db.query(ComparisonJob).filter(ComparisonJob.id == jid).first()
        assert job.status == "failed"
        assert "PRYNX_MAX_IMPOSITION_MAP_CELLS" in (job.error_message or "")
        assert db.query(PageResult).filter(PageResult.job_id == jid).count() == 0
    finally:
        db.close()


def test_imposition_map_reports_progress_while_scanning(tmp_path, monkeypatch):
    """Trong lúc dò bình bài phải phát tín hiệu sống (status_message + notify) để
    UI local và watchdog theo tiến độ không tưởng job treo (§PB-3)."""
    import app.core.comparison_engine as ce
    from app.models.job import ComparisonJob

    monkeypatch.setattr(ce, "_MAP_PROGRESS_MIN_INTERVAL_S", 0.0)
    db, jid = _setup_booklet_job(tmp_path)
    messages = []

    def on_progress(job_id, progress, status, current_page, total_pages, message):
        messages.append(message or "")

    try:
        ce.run_comparison_pipeline(jid, db, on_progress=on_progress)
        job = db.query(ComparisonJob).filter(ComparisonJob.id == jid).first()
        assert job.status == "completed"
        assert any("Đang định vị trang nguồn" in m for m in messages), messages
    finally:
        db.close()
