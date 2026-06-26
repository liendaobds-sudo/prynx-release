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
