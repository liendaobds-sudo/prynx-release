"""Regression tests cho nhóm PDF Tools (File Prep): merge / split / resize / shuffle.

Kiểm chứng bằng ground-truth: mỗi trang nguồn có MediaBox width DUY NHẤT (100+i)
→ đọc lại width để xác minh thứ tự / trích / khổ / chọn-trang.

Bao gồm:
  - Đúng chức năng của engine pdf_tools_engine (merge/split/resize/shuffle).
  - Ca dải trang "a-b" cho resize apply_to (audit fix: trước đây bị bỏ âm thầm).
  - Regression route: /resize và /shuffle KHÔNG còn crash vì thiếu `await
    save_upload` (audit fix). /split dùng làm control (vốn đã có await).
"""
import io
import os
import tempfile
import threading

import pikepdf
import pytest
from fastapi import UploadFile

from app.workers.pdf_tools_engine import (
    PdfOperationCancelled,
    merge_pdfs,
    split_pdf,
    resize_pages,
    shuffle_pages,
)

MM_TO_PTS = 2.83465


# ─── Helpers ──────────────────────────────────────────────────────────────

def _make_pdf(path, n, base_w=100, h=200):
    """PDF n trang; trang i có width = base_w + i (định danh ground-truth)."""
    pdf = pikepdf.Pdf.new()
    for i in range(n):
        pdf.add_blank_page(page_size=(base_w + i, h))
    pdf.save(path)
    pdf.close()


def _widths(path):
    out = []
    with pikepdf.Pdf.open(path) as pdf:
        for pg in pdf.pages:
            mb = pg.MediaBox
            out.append(round(float(mb[2]) - float(mb[0]), 2))
    return out


def _make_pdf_with_print_catalog(path):
    """PDF có layer ẩn + OutputIntent để khóa parity khi Split dựng tài liệu mới."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    ocg = pdf.make_indirect(
        pikepdf.Dictionary(Type=pikepdf.Name('/OCG'), Name='Hidden Layer')
    )
    pdf.Root[pikepdf.Name('/OCProperties')] = pikepdf.Dictionary(
        OCGs=pikepdf.Array([ocg]),
        D=pikepdf.Dictionary(
            Order=pikepdf.Array([ocg]),
            ON=pikepdf.Array([]),
            OFF=pikepdf.Array([ocg]),
        ),
    )
    page.obj[pikepdf.Name('/Resources')] = pikepdf.Dictionary(
        Properties=pikepdf.Dictionary(MC0=ocg),
    )
    page.obj[pikepdf.Name('/Contents')] = pdf.make_stream(
        b'/OC /MC0 BDC\n1 0 0 rg 0 0 200 200 re f\nEMC\n'
    )
    profile = pdf.make_stream(b'test-output-profile')
    profile[pikepdf.Name('/N')] = 4
    intent = pdf.make_indirect(pikepdf.Dictionary({
        '/Type': pikepdf.Name('/OutputIntent'),
        '/S': pikepdf.Name('/GTS_PDFX'),
        '/OutputConditionIdentifier': 'TEST',
        '/DestOutputProfile': profile,
    }))
    pdf.Root[pikepdf.Name('/OutputIntents')] = pikepdf.Array([intent])
    pdf.save(path)
    pdf.close()


@pytest.fixture
def workdir():
    d = tempfile.mkdtemp(prefix="test_pdftools_")
    yield d
    # dọn dẹp best-effort
    for root, _dirs, files in os.walk(d, topdown=False):
        for f in files:
            try: os.remove(os.path.join(root, f))
            except OSError: pass
        try: os.rmdir(root)
        except OSError: pass


# ═══════════════════════════════════════════════════════════════════════
#  ENGINE: merge_pdfs
# ═══════════════════════════════════════════════════════════════════════

def test_merge_files_preserves_order(workdir):
    a = os.path.join(workdir, "a.pdf"); _make_pdf(a, 3, base_w=100)
    b = os.path.join(workdir, "b.pdf"); _make_pdf(b, 2, base_w=200)
    out = os.path.join(workdir, "merged.pdf")
    merge_pdfs([a, b], out, mode="merge_files")
    assert _widths(out) == [100, 101, 102, 200, 201]


def test_merge_interleave(workdir):
    a = os.path.join(workdir, "a.pdf"); _make_pdf(a, 3, base_w=100)
    b = os.path.join(workdir, "b.pdf"); _make_pdf(b, 2, base_w=200)
    out = os.path.join(workdir, "inter.pdf")
    merge_pdfs([a, b], out, mode="interleave")
    # odd=a(100,101,102), even=b(200,201) → 100,200,101,201,102
    assert _widths(out) == [100, 200, 101, 201, 102]


def test_merge_interleave_reverse_even(workdir):
    a = os.path.join(workdir, "a.pdf"); _make_pdf(a, 3, base_w=100)
    b = os.path.join(workdir, "b.pdf"); _make_pdf(b, 2, base_w=200)
    out = os.path.join(workdir, "inter_rev.pdf")
    merge_pdfs([a, b], out, mode="interleave", interleave_reverse_even=True)
    # even đảo ngược: 201,200 → 100,201,101,200,102
    assert _widths(out) == [100, 201, 101, 200, 102]


# ═══════════════════════════════════════════════════════════════════════
#  ENGINE: split_pdf
# ═══════════════════════════════════════════════════════════════════════

def test_split_by_range(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 8, base_w=100)
    res = split_pdf(src, os.path.join(workdir, "r"), mode="by_range",
                    ranges=[(1, 4), (5, 8)], base_name="r")
    assert [_widths(x["path"]) for x in res] == [
        [100, 101, 102, 103], [104, 105, 106, 107]
    ]


def test_split_by_count(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 8, base_w=100)
    res = split_pdf(src, os.path.join(workdir, "c"), mode="by_count",
                    pages_per_file=3, base_name="c")
    assert [_widths(x["path"]) for x in res] == [
        [100, 101, 102], [103, 104, 105], [106, 107]
    ]


def test_split_extract_pages(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 8, base_w=100)
    res = split_pdf(src, os.path.join(workdir, "e"), mode="extract_pages",
                    page_list=[1, 3, 5], base_name="e")
    assert _widths(res[0]["path"]) == [100, 102, 104]


def test_split_extract_pages_preserves_requested_order(workdir):
    """Parity frontend/backend: danh sách trang là thứ tự output, không tự sort."""
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 8, base_w=100)
    res = split_pdf(src, os.path.join(workdir, "ordered"), mode="extract_pages",
                    page_list=[5, 1, 3], base_name="ordered")
    assert _widths(res[0]["path"]) == [104, 100, 102]


def test_split_by_range_accepts_ui_string(workdir):
    """UI gửi ranges dạng chuỗi; engine phải parse cùng cú pháp với frontend."""
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 8, base_w=100)
    res = split_pdf(src, os.path.join(workdir, "string_ranges"), mode="by_range",
                    ranges="1-2, 5, 7-8", base_name="ranges")
    assert [_widths(item["path"]) for item in res] == [
        [100, 101], [104], [106, 107],
    ]


def test_split_by_range_empty_uses_full_document_like_frontend(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 4, base_w=100)
    res = split_pdf(src, os.path.join(workdir, "default_range"), mode="by_range",
                    ranges="", base_name="default")
    assert len(res) == 1
    assert _widths(res[0]["path"]) == [100, 101, 102, 103]


def test_split_duplicate_ranges_get_unique_filenames(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 4, base_w=100)
    res = split_pdf(src, os.path.join(workdir, "duplicates"), mode="by_range",
                    ranges="1-2, 1-2", base_name="dup")
    assert len({item["filename"] for item in res}) == 2
    assert len({item["path"] for item in res}) == 2


def test_split_rejects_empty_extract_result(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 3, base_w=100)
    with pytest.raises(ValueError, match="trang hợp lệ"):
        split_pdf(src, os.path.join(workdir, "empty"), mode="extract_pages",
                  page_list=[0, 99], base_name="empty")


@pytest.mark.parametrize(
    ('mode', 'kwargs'),
    [
        ('by_range', {'ranges': '1-1'}),
        ('by_count', {'pages_per_file': 1}),
        ('extract_pages', {'page_list': [1]}),
    ],
)
def test_split_preserves_ocg_state_and_output_intent(workdir, mode, kwargs):
    src = os.path.join(workdir, 'catalog.pdf')
    _make_pdf_with_print_catalog(src)
    result = split_pdf(
        src,
        os.path.join(workdir, f'catalog_{mode}'),
        mode=mode,
        base_name='catalog',
        **kwargs,
    )[0]

    with pikepdf.Pdf.open(result['path']) as output:
        oc_props = output.Root.get('/OCProperties')
        assert oc_props is not None
        root_ocg = oc_props['/OCGs'][0]
        assert oc_props['/D']['/OFF'][0].objgen == root_ocg.objgen
        page_ocg = output.pages[0].Resources['/Properties']['/MC0']
        assert page_ocg.objgen == root_ocg.objgen

        intents = output.Root.get('/OutputIntents')
        assert intents is not None and len(intents) == 1
        assert bytes(intents[0]['/DestOutputProfile'].read_bytes()) == b'test-output-profile'


# ═══════════════════════════════════════════════════════════════════════
#  ENGINE: resize_pages
# ═══════════════════════════════════════════════════════════════════════

def test_resize_all_to_a4(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 8, base_w=100)
    out = os.path.join(workdir, "r.pdf")
    resize_pages(src, out, 210, 297, scale_mode="fit", apply_to="all")
    with pikepdf.Pdf.open(out) as pdf:
        assert len(pdf.pages) == 8
        mb = pdf.pages[0].MediaBox
        w = float(mb[2]) - float(mb[0]); h = float(mb[3]) - float(mb[1])
    assert abs(w - 210 * MM_TO_PTS) < 1 and abs(h - 297 * MM_TO_PTS) < 1


def test_resize_even_only(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 8, base_w=100)
    out = os.path.join(workdir, "r.pdf")
    resize_pages(src, out, 210, 297, scale_mode="fit", apply_to="even")
    w = _widths(out)
    # 'even' → idx 1,3,5,7 resized (~595.3pt); idx 0,2,4,6 giữ nguyên 100,102,104,106
    assert abs(w[0] - 100) < 1 and abs(w[2] - 102) < 1
    assert abs(w[1] - 210 * MM_TO_PTS) < 1 and abs(w[3] - 210 * MM_TO_PTS) < 1


def test_resize_apply_to_range_string(workdir):
    """Audit fix: dải 'a-b' trong apply_to phải được resize (trước đây bị bỏ qua)."""
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 8, base_w=100)
    out = os.path.join(workdir, "r.pdf")
    # "1-3,5" → resize trang 1,2,3,5 (idx 0,1,2,4); trang 4,6,7,8 (idx 3,5,6,7) giữ nguyên
    resize_pages(src, out, 210, 297, scale_mode="fit", apply_to="1-3,5")
    w = _widths(out)
    target = round(210 * MM_TO_PTS, 2)
    for idx in (0, 1, 2, 4):
        assert abs(w[idx] - target) < 1, f"idx {idx} phải resize, got {w[idx]}"
    for idx, orig in ((3, 103), (5, 105), (6, 106), (7, 107)):
        assert abs(w[idx] - orig) < 1, f"idx {idx} phải giữ nguyên, got {w[idx]}"


def test_resize_cancel_before_first_page(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 8, base_w=100)
    out = os.path.join(workdir, "cancelled.pdf")
    cancel = threading.Event()
    cancel.set()

    with pytest.raises(PdfOperationCancelled):
        resize_pages(src, out, 210, 297, cancel_event=cancel)

    assert not os.path.exists(out)


def test_resize_cancel_between_pages_reports_real_progress(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 8, base_w=100)
    out = os.path.join(workdir, "cancelled.pdf")
    cancel = threading.Event()
    progress = []

    def on_progress(completed, total):
        progress.append((completed, total))
        if completed == 2:
            cancel.set()

    with pytest.raises(PdfOperationCancelled):
        resize_pages(
            src,
            out,
            210,
            297,
            cancel_event=cancel,
            progress_callback=on_progress,
        )

    assert progress == [(1, 8), (2, 8)]
    assert not os.path.exists(out)


def test_resize_cancel_after_last_page_still_blocks_save(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 3, base_w=100)
    out = os.path.join(workdir, "cancelled.pdf")
    cancel = threading.Event()

    def on_progress(completed, total):
        if completed == total:
            cancel.set()

    with pytest.raises(PdfOperationCancelled):
        resize_pages(
            src,
            out,
            210,
            297,
            cancel_event=cancel,
            progress_callback=on_progress,
        )

    assert not os.path.exists(out)

# ═══════════════════════════════════════════════════════════════════════
#  ENGINE: shuffle_pages
# ═══════════════════════════════════════════════════════════════════════

def test_shuffle_reverse(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 8, base_w=100)
    out = os.path.join(workdir, "rev.pdf")
    shuffle_pages(src, out, action="reverse")
    assert _widths(out) == [107, 106, 105, 104, 103, 102, 101, 100]


def test_shuffle_odd_first(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 8, base_w=100)
    out = os.path.join(workdir, "odd.pdf")
    shuffle_pages(src, out, action="odd_first")
    assert _widths(out) == [100, 102, 104, 106, 101, 103, 105, 107]


def test_shuffle_even_first(workdir):
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 8, base_w=100)
    out = os.path.join(workdir, "even.pdf")
    shuffle_pages(src, out, action="even_first")
    assert _widths(out) == [101, 103, 105, 107, 100, 102, 104, 106]


def test_shuffle_custom_mapping(workdir):
    """Custom mapping = danh sách SỐ TRANG 1-based (đúng định dạng frontend gửi sau fix)."""
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 8, base_w=100)
    out = os.path.join(workdir, "custom.pdf")
    shuffle_pages(src, out, action="custom", mapping=[8, 1, 2, 7])
    assert _widths(out) == [107, 100, 101, 106]


# ═══════════════════════════════════════════════════════════════════════
#  ROUTE regression: /resize & /shuffle không crash (audit fix: thiếu await)
# ═══════════════════════════════════════════════════════════════════════

def _uploadfile(path, name="big.pdf"):
    data = open(path, "rb").read()
    return UploadFile(filename=name, file=io.BytesIO(data))


_DEV_LICENSE = {"license_key": "DEV_MODE"}


async def test_route_resize_does_not_crash(workdir):
    from app.api.routes import pdf_tools
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 6, base_w=100)
    resp = await pdf_tools.resize_pages_endpoint(
        file=_uploadfile(src), target_w=210, target_h=297,
        scale_mode="fit", apply_to="all", target_dpi=0, mode="auto",
        license_info=_DEV_LICENSE,
    )
    # FileResponse với file kết quả tồn tại trên đĩa.
    assert os.path.exists(resp.path)
    with pikepdf.Pdf.open(resp.path) as pdf:
        assert len(pdf.pages) == 6
    try: os.remove(resp.path)
    except OSError: pass


async def test_route_resize_file_path_preserves_source(workdir):
    """PERF §RT.10: fast-path đọc file gốc tại chỗ và không được xóa nó."""
    from app.api.routes import pdf_tools

    src = os.path.join(workdir, "local_source.pdf")
    _make_pdf(src, 2, base_w=100)
    resp = await pdf_tools.resize_pages_endpoint(
        file=None,
        file_path=src,
        target_w=40,
        target_h=60,
        scale_mode="fit",
        apply_to="all",
        target_dpi=0,
        mode="auto",
        license_info=_DEV_LICENSE,
    )
    assert os.path.isfile(src), "endpoint đã xóa nhầm file PDF gốc"
    assert os.path.isfile(resp.path)
    os.remove(resp.path)


async def test_route_resize_can_transfer_native_result_path(workdir):
    """Desktop nhận ownership artifact, không tải về rồi upload lại cho PDFium."""
    from app.api.routes import pdf_tools

    src = os.path.join(workdir, "native_source.pdf")
    _make_pdf(src, 2, base_w=100)
    result = await pdf_tools.resize_pages_endpoint(
        file=None,
        file_path=src,
        target_w=40,
        target_h=60,
        scale_mode="fit",
        apply_to="all",
        target_dpi=0,
        mode="xobject",
        page_size_mode="fixed",
        resize_by_content=False,
        return_path=True,
        license_info=_DEV_LICENSE,
    )

    output_path = result["path"]
    assert os.path.isabs(output_path)
    assert os.path.isfile(output_path)
    assert os.path.isfile(src), "endpoint đã xóa nhầm file PDF nguồn"
    assert result["size"] == os.path.getsize(output_path)
    assert result["timing"]["output_bytes"] == result["size"]
    os.remove(output_path)


async def test_route_shuffle_does_not_crash(workdir):
    from app.api.routes import pdf_tools
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 6, base_w=100)
    resp = await pdf_tools.shuffle_pages_endpoint(
        file=_uploadfile(src), action="reverse", mapping="[]",
        license_info=_DEV_LICENSE,
    )
    assert os.path.exists(resp.path)
    assert _widths(resp.path) == [105, 104, 103, 102, 101, 100]
    try: os.remove(resp.path)
    except OSError: pass


async def test_route_shuffle_custom_numeric_mapping(workdir):
    from app.api.routes import pdf_tools
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 6, base_w=100)
    resp = await pdf_tools.shuffle_pages_endpoint(
        file=_uploadfile(src), action="custom", mapping="[6, 1, 2, 5]",
        license_info=_DEV_LICENSE,
    )
    assert os.path.exists(resp.path)
    assert _widths(resp.path) == [105, 100, 101, 104]
    try: os.remove(resp.path)
    except OSError: pass


async def test_route_split_control(workdir):
    """Control: /split vốn đã có await — vẫn hoạt động."""
    from app.api.routes import pdf_tools
    src = os.path.join(workdir, "s.pdf"); _make_pdf(src, 6, base_w=100)
    resp = await pdf_tools.split_pdf_endpoint(
        file=_uploadfile(src), mode="by_count",
        config='{"pagesPerFile": 3}', license_info=_DEV_LICENSE,
    )
    assert resp is not None


async def test_route_split_accepts_range_string_from_ui(workdir):
    from app.api.routes import pdf_tools
    src = os.path.join(workdir, "range_ui.pdf"); _make_pdf(src, 6, base_w=100)
    resp = await pdf_tools.split_pdf_endpoint(
        file=_uploadfile(src), mode="by_range",
        config='{"ranges": "2-4"}', license_info=_DEV_LICENSE,
    )

    assert _widths(resp.path) == [101, 102, 103]
    output_dir = os.path.dirname(resp.path)
    os.remove(resp.path)
    os.rmdir(output_dir)


async def test_route_shuffle_file_path_preserves_source(workdir):
    """RECIPE §PLAY.PATH: path lớn đi thẳng sidecar và không bị xóa như upload tạm."""
    from app.api.routes import pdf_tools

    src = os.path.join(workdir, "shuffle_path.pdf")
    _make_pdf(src, 6, base_w=100)
    resp = await pdf_tools.shuffle_pages_endpoint(
        file=None,
        file_path=src,
        action="reverse",
        mapping="[]",
        license_info=_DEV_LICENSE,
    )

    assert os.path.isfile(src), "endpoint đã xóa nhầm file PDF nguồn"
    assert _widths(resp.path) == [105, 104, 103, 102, 101, 100]
    os.remove(resp.path)


async def test_route_split_file_path_preserves_source(workdir):
    """RECIPE §PLAY.PATH: Split không tạo bản upload 500 MB khi đã có native path."""
    from app.api.routes import pdf_tools

    src = os.path.join(workdir, "split_path.pdf")
    _make_pdf(src, 6, base_w=100)
    resp = await pdf_tools.split_pdf_endpoint(
        file=None,
        file_path=src,
        mode="by_count",
        config='{"pagesPerFile": 6}',
        license_info=_DEV_LICENSE,
    )

    assert os.path.isfile(src), "endpoint đã xóa nhầm file PDF nguồn"
    assert _widths(resp.path) == [100, 101, 102, 103, 104, 105]
    output_dir = os.path.dirname(resp.path)
    os.remove(resp.path)
    os.rmdir(output_dir)
