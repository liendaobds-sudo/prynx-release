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
    assert s["overall_status"] in ("FAIL", "WARNING")
