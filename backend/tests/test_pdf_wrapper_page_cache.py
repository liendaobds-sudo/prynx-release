import pytest

from app.workers import pdf_wrapper as pdf_lib


def _make_pdf(path, page_count=3):
    doc = pdf_lib.open()
    try:
        for index in range(page_count):
            doc.new_page(width=100 + index, height=200 + index)
        doc.save(path)
    finally:
        doc.close()


def test_file_backed_document_reuses_page_wrappers(tmp_path):
    source = tmp_path / "source.pdf"
    _make_pdf(source)

    doc = pdf_lib.open(source)
    try:
        first = doc[0]
        assert doc[0] is first
        assert doc[-3] is first
        assert list(doc)[0] is first
        assert doc[-1] is doc[2]
    finally:
        doc.close()


def test_file_backed_document_preserves_index_errors(tmp_path):
    source = tmp_path / "source.pdf"
    _make_pdf(source, page_count=1)

    doc = pdf_lib.open(source)
    try:
        with pytest.raises(IndexError):
            _ = doc[1]
        with pytest.raises(IndexError):
            _ = doc[-2]
    finally:
        doc.close()


def test_new_document_remains_mutable_and_uncached():
    doc = pdf_lib.open()
    try:
        first = doc.new_page(width=100, height=200)
        second = doc.new_page(width=200, height=300)

        assert doc.page_count == 2
        assert doc[0] is not first
        assert doc[0] is not doc[0]
        assert doc[1].rect.width == second.rect.width
    finally:
        doc.close()


def test_source_page_wrapper_cache_is_bounded(tmp_path):
    source = tmp_path / "many-pages.pdf"
    _make_pdf(source, page_count=520)

    doc = pdf_lib.open(source)
    try:
        first = doc[0]
        for index in range(doc.page_count):
            _ = doc[index]

        assert len(doc._source_page_wrappers) == doc._SOURCE_PAGE_WRAPPER_CACHE_LIMIT
        assert doc[0] is not first
    finally:
        doc.close()
