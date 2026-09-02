"""Khoá nguồn text của bước CĂN TRANG sau khi đổi pdfplumber → PDFium.

PERF (audit 2026-08-29 §RS.T1a): `_extract_page_texts_for_alignment` thay
`PDFProcessor.extract_text_blocks` (pdfplumber/pdfminer.six, parser thuần Python
~86 ms/trang) bằng PDFium (~1,4 ms/trang).

Vì sao cần test riêng: test căn trang sẵn có
(`test_compare_pipeline.test_inserted_page_does_not_cascade_false_diffs`) dựng PDF
CHỈ có hình chữ nhật, không có chữ — nên nó đi nhánh `vis`-only của `_sim` và
KHÔNG phủ nhánh text. Các test dưới đây dựng trang DÀY CHỮ để nhánh text thật sự
chạy, rồi đòi kết quả căn trang KHÔNG đổi so với nguồn pdfplumber cũ.

Bất biến được khoá:
  1. Cùng `align_pairs` giữa nguồn PDFium và nguồn pdfplumber (chèn/xoá/giống hệt).
  2. Text trích được đủ dài để nhánh text (`len >= 20`) thật sự chạy — chống test
     xanh giả do cả hai phía đều rỗng.
  3. Trang ảnh (không có text) → "" như đường cũ.
  4. Yêu cầu nhiều trang hơn số trang thật → list vẫn đúng độ dài, phần thừa "".
  5. Hủy hợp tác vẫn hoạt động (ComparisonCancelled).
"""
from __future__ import annotations

import pytest

from app.core.comparison_engine import (
    ComparisonCancelled,
    _extract_page_texts_for_alignment,
)
from app.core.page_aligner import align_pages, normalize_text, text_similarity

# Mỗi "kind" là một trang có nội dung chữ KHÁC BIỆT RÕ để căn trang phân biệt được.
_PAGE_BODIES: dict[object, list[str]] = {
    0: [
        "Chuong mot noi dung ky thuat che ban va binh ban",
        "Muc tieu cua chuong nay la trinh bay quy trinh kiem tra",
        "Cac buoc bao gom kiem font kiem mau va kiem kich thuoc",
    ],
    1: [
        "Chuong hai bang mau va tong luong muc toi da",
        "Gia tri TAC khuyen nghi cho giay couche va giay ford",
        "Bang tra doi chieu giua he mau RGB va he mau CMYK",
    ],
    2: [
        "Chuong ba khuon be va duong cat cho bao bi giay",
        "Quy uoc duong cut duong crease va duong bleed tren ban ve",
        "Kiem tra khoang hoc giua cac khuon truoc khi xuat phim",
    ],
    "X": [
        "Trang phu luc duoc chen them vao ban hai",
        "Noi dung nay khong ton tai trong ban goc dung de kiem tra",
        "Buoc can trang phai nhan ra day la trang duoc THEM",
    ],
}


def _make_text_pdf(path: str, kinds: list[object]) -> None:
    """PDF nhiều trang, mỗi trang dày chữ theo `kinds` (dùng reportlab như các test khác)."""
    from reportlab.lib.pagesizes import A5
    from reportlab.pdfgen import canvas

    c = canvas.Canvas(path, pagesize=A5)
    _w, h = A5
    for kind in kinds:
        c.setFont("Helvetica", 10)
        y = h - 50
        # Lặp thân trang nhiều lần để chắc chắn vượt ngưỡng 20 ký tự của `_sim`.
        for _rep in range(6):
            for line in _PAGE_BODIES[kind]:
                c.drawString(40, y, line)
                y -= 14
        c.showPage()
    c.save()


def _make_image_only_pdf(path: str) -> None:
    """PDF một trang CHỈ có hình vẽ, không có text object nào."""
    from reportlab.lib.pagesizes import A5
    from reportlab.pdfgen import canvas

    c = canvas.Canvas(path, pagesize=A5)
    c.rect(40, 40, 200, 150, stroke=1, fill=1)
    c.showPage()
    c.save()


def _texts_via_pdfplumber(pdf_path: str, n_pages: int) -> list[str]:
    """Nguồn text CŨ, dựng lại nguyên văn trong test làm mốc đối chiếu.

    Đây là bản sao logic của `_page_texts` trước lô §RS.T1a (nối `text` của các
    block do `PDFProcessor.extract_text_blocks` trả về, rồi `normalize_text`).
    Giữ trong test — KHÔNG đưa lại vào production.
    """
    from app.core.pdf_processor import PDFProcessor

    processor = PDFProcessor()
    out: list[str] = []
    for page in range(1, n_pages + 1):
        try:
            blocks = processor.extract_text_blocks(pdf_path, page)
            joined = " ".join(b.get("text", "") for b in blocks)
        except Exception:
            joined = ""
        out.append(normalize_text(joined))
    return out


def _align_with_text_only(txt_a: list[str], txt_b: list[str]):
    """Căn trang CHỈ dùng text (bỏ thumbnail) để cô lập ảnh hưởng của nguồn text.

    Cố ý không blend thumbnail như `_sim` production: thumbnail giống nhau sẽ CHE
    khác biệt của nguồn text và làm test mất tác dụng.
    """
    def sim(i: int, j: int) -> float:
        ta, tb = txt_a[i], txt_b[j]
        if len(ta) >= 20 and len(tb) >= 20:
            return text_similarity(ta, tb)
        return 0.0

    return align_pages(len(txt_a), len(txt_b), sim)


@pytest.mark.parametrize(
    "kinds_a, kinds_b",
    [
        ([0, 1, 2], [0, "X", 1, 2]),   # B chèn 1 trang ở giữa
        ([0, 1, 2], [0, 2]),           # B xoá trang giữa
        ([0, 1, 2], [0, 1, 2, "X"]),   # B thêm trang ở cuối
        (["X", 0, 1], [0, 1]),         # A có trang đầu mà B không có
    ],
)
def test_pdfium_text_source_gives_same_alignment_as_pdfplumber(tmp_path, kinds_a, kinds_b):
    """Bất biến 1: đổi nguồn text KHÔNG đổi kết quả căn trang."""
    path_a = str(tmp_path / "A.pdf")
    path_b = str(tmp_path / "B.pdf")
    _make_text_pdf(path_a, kinds_a)
    _make_text_pdf(path_b, kinds_b)

    new_a = _extract_page_texts_for_alignment(path_a, len(kinds_a))
    new_b = _extract_page_texts_for_alignment(path_b, len(kinds_b))
    old_a = _texts_via_pdfplumber(path_a, len(kinds_a))
    old_b = _texts_via_pdfplumber(path_b, len(kinds_b))

    assert _align_with_text_only(new_a, new_b) == _align_with_text_only(old_a, old_b)


def test_extracts_enough_text_to_engage_text_branch(tmp_path):
    """Bất biến 2: chống test xanh giả — nhánh text phải THẬT SỰ chạy.

    Nếu PDFium trả rỗng thì test parity ở trên vẫn xanh một cách vô nghĩa (mọi
    similarity = 0). Test này chốt cả hai nguồn đều vượt ngưỡng 20 ký tự, và
    nội dung hai nguồn tương đồng cao trên CÙNG một trang.
    """
    path = str(tmp_path / "T.pdf")
    _make_text_pdf(path, [0, 1, 2])

    new = _extract_page_texts_for_alignment(path, 3)
    old = _texts_via_pdfplumber(path, 3)

    assert len(new) == 3
    for page_idx, (n_text, o_text) in enumerate(zip(new, old)):
        assert len(n_text) >= 20, f"PDFium không trích được text trang {page_idx + 1}"
        assert len(o_text) >= 20, f"pdfplumber không trích được text trang {page_idx + 1}"
        # Cùng trang, hai parser → nội dung phải rất giống nhau (không đòi byte-exact:
        # thứ tự đọc và cách gộp khoảng trắng của hai parser khác nhau có chủ đích).
        assert text_similarity(n_text, o_text) >= 0.9

    # Trang khác nhau phải phân biệt được, nếu không thì căn trang vô nghĩa.
    assert text_similarity(new[0], new[1]) < 0.9


def test_image_only_page_returns_empty_text(tmp_path):
    """Bất biến 3: trang ảnh → "" (giữ nguyên hành vi cũ, `_sim` rơi về thumbnail)."""
    path = str(tmp_path / "IMG.pdf")
    _make_image_only_pdf(path)

    assert _extract_page_texts_for_alignment(path, 1) == [""]


def test_requested_pages_beyond_document_are_padded(tmp_path):
    """Bất biến 4: yêu cầu quá số trang thật vẫn trả đúng độ dài, phần thừa ""."""
    path = str(tmp_path / "S.pdf")
    _make_text_pdf(path, [0])

    out = _extract_page_texts_for_alignment(path, 4)
    assert len(out) == 4
    assert len(out[0]) >= 20
    assert out[1:] == ["", "", ""]


def test_zero_pages_returns_empty_list(tmp_path):
    path = str(tmp_path / "S.pdf")
    _make_text_pdf(path, [0])

    assert _extract_page_texts_for_alignment(path, 0) == []


def test_cancel_check_stops_extraction(tmp_path):
    """Bất biến 5: hủy hợp tác vẫn hoạt động sau khi đổi nguồn text."""
    path = str(tmp_path / "C.pdf")
    _make_text_pdf(path, [0, 1, 2])

    with pytest.raises(ComparisonCancelled):
        _extract_page_texts_for_alignment(path, 3, cancel_check=lambda: True)


def test_text_heavy_inserted_page_does_not_cascade(tmp_path):
    """Đầu-cuối qua pipeline thật với trang DÀY CHỮ.

    Bổ khuyết cho `test_inserted_page_does_not_cascade_false_diffs` (chỉ có hình
    chữ nhật, không chạm nhánh text). Ở đây nhánh text của `_sim` thật sự tham gia.
    """
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.core.comparison_engine import run_comparison_pipeline
    from app.database import Base
    from app.models.job import ComparisonJob, PageResult, UploadedFile

    kinds_a = [0, 1, 2]
    kinds_b = [0, "X", 1, 2]
    path_a = str(tmp_path / "A.pdf")
    path_b = str(tmp_path / "B.pdf")
    _make_text_pdf(path_a, kinds_a)
    _make_text_pdf(path_b, kinds_b)

    engine = create_engine(
        f"sqlite:///{tmp_path / 'align_text.db'}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    try:
        file_a = UploadedFile(filename="A.pdf", original_name="A.pdf",
                              file_path=path_a, page_count=len(kinds_a))
        file_b = UploadedFile(filename="B.pdf", original_name="B.pdf",
                              file_path=path_b, page_count=len(kinds_b))
        db.add(file_a); db.add(file_b); db.commit()
        db.refresh(file_a); db.refresh(file_b)
        job = ComparisonJob(
            file_a_id=file_a.id,
            file_b_id=file_b.id,
            config={"comparison_mode": "full", "tolerance": "NORMAL", "dpi": 100},
        )
        db.add(job); db.commit(); db.refresh(job)
        job_id = job.id

        run_comparison_pipeline(job_id, db)

        job = db.query(ComparisonJob).filter(ComparisonJob.id == job_id).first()
        results = (
            db.query(PageResult)
            .filter(PageResult.job_id == job_id)
            .order_by(PageResult.page_number)
            .all()
        )
        pages = {r.page_number: r for r in results}
    finally:
        db.close()

    assert job.status == "completed"
    assert len(pages) == 4
    # Thứ tự căn kỳ vọng: (0,0) sạch, (None,1) trang X được THÊM, (1,2) sạch, (2,3) sạch.
    assert pages[1].diff_count == 0, "Trang chữ 0 phải khớp sạch"
    assert pages[3].diff_count == 0, "Trang chữ 1 phải khớp sạch (không lệch do trang chèn)"
    assert pages[4].diff_count == 0, "Trang chữ 2 phải khớp sạch (không cascade)"
    assert pages[2].status == "fail"
    assert "THÊM" in pages[2].diff_regions[0]["description"]
