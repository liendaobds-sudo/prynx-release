"""Preview và export phải đọc CÙNG hệ quy chiếu trang.

[AUDIT §2.1, §4.4] docs/BAO_CAO_AUDIT_HE_TOA_DO_PARSER_2026-07-28.md

`run_nup_engine` chuẩn hoá `/Rotate` + gốc MediaBox qua `_canonicalize_page_space`
trước khi layout. Route `/imposition/preview-layout` và `/imposition/detect-shape`
trước đây mở file THÔ, nên với trang `/Rotate ≠ 0` chúng thấy khổ chưa hoán w/h.

Lệch đo được trước lô 2:
    Rotate=0   preview (200, 100) | export (200, 100)  KHỚP
    Rotate=90  preview (200, 100) | export (100, 200)  LỆCH
"""
import os
from pathlib import Path

import pikepdf
import pytest

from app.api.routes.imposition import PreviewLayoutRequest, preview_layout
from app.api.routes import imposition
from app.workers import nup_engine
from tests.license_helpers import PRO_LICENSE

MM = 2.83465
# Trang landscape 200×100pt kèm /Rotate=90 → khổ NHÌN THẤY là 100×200pt.
RAW_W, RAW_H = 200.0, 100.0


def _make_rotated(path, rotate, user_unit=1.0):
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(RAW_W, RAW_H))
    page = pdf.pages[0]
    if rotate:
        page.obj[pikepdf.Name("/Rotate")] = rotate
    if user_unit != 1.0:
        page.obj[pikepdf.Name("/UserUnit")] = user_unit
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
        b"0 1 0 0 K 0.5 w 10 10 180 80 re S\n"
    )
    pdf.save(str(path))
    pdf.close()
    return str(path)


def _preview(path, **over):
    kwargs = dict(
        path=path,
        usable_w=500.0,
        usable_h=500.0,
        # Với is_die_cut=True, khổ ô lấy từ ĐƯỜNG BẾ trong file — hai giá trị này chỉ
        # là chỗ giữ tham số, không quyết định kết quả.
        item_w=60.0,
        item_h=30.0,
        gap_x=0.0,
        gap_y=0.0,
        strategy="simple_auto",
        bleed=0.0,
        sheet_w=520.0,
        sheet_h=520.0,
        is_die_cut=True,
    )
    kwargs.update(over)
    return preview_layout(PreviewLayoutRequest(**kwargs), PRO_LICENSE)


def _die_size(path, page_idx=0):
    """Khổ đường bế đọc từ `path` — đúng cách bình bản đọc."""
    from app.workers import pdf_wrapper
    from app.workers.nup_diecut import _find_largest_die_path

    doc = pdf_wrapper.open(path)
    try:
        found = _find_largest_die_path(doc[page_idx])
        assert found is not None, "phải tìm được đường bế"
        return (round(found["rect"].width, 3), round(found["rect"].height, 3))
    finally:
        doc.close()


def _export_die_size(path):
    """Khổ đường bế mà EXPORT thấy (sau chốt chuẩn hoá của run_nup_engine)."""
    with nup_engine.canonical_page_space(path) as canon:
        return _die_size(canon)


@pytest.mark.parametrize("rotate", [0, 90, 180, 270])
def test_preview_cell_matches_export_die_size(tmp_path, rotate):
    """Ô preview phải khớp khổ đường bế mà export dựng, ở MỌI góc /Rotate."""
    src = _make_rotated(tmp_path / f"r{rotate}.pdf", rotate)
    exp_w, exp_h = _export_die_size(src)

    result = _preview(src)
    assert result["success"] is True
    cells = result.get("cells") or []
    assert cells, "preview phải dựng được ít nhất một ô"

    cell = cells[0]
    assert cell["width"] == pytest.approx(exp_w, abs=0.5), (
        f"/Rotate={rotate}: bề ngang ô preview {cell['width']} ≠ export {exp_w}"
    )
    assert cell["height"] == pytest.approx(exp_h, abs=0.5), (
        f"/Rotate={rotate}: bề cao ô preview {cell['height']} ≠ export {exp_h}"
    )


@pytest.mark.parametrize(
    ("rotate", "expected_size"),
    [
        (0, (400.0, 200.0)),
        (90, (200.0, 400.0)),
        (180, (400.0, 200.0)),
        (270, (200.0, 400.0)),
    ],
)
def test_user_unit_is_baked_with_rotation(tmp_path, rotate, expected_size):
    """`/UserUnit` phải được bake một lần rồi bỏ, kể cả khi trang có `/Rotate`."""
    src = _make_rotated(tmp_path / f"unit2-r{rotate}.pdf", rotate, user_unit=2.0)

    with nup_engine.canonical_page_space(src, f"unit2-r{rotate}") as canon:
        assert canon != src
        with pikepdf.Pdf.open(canon) as pdf:
            page = pdf.pages[0].obj
            media = [float(value) for value in page["/MediaBox"]]
            assert (media[2] - media[0], media[3] - media[1]) == pytest.approx(
                expected_size,
                abs=1e-4,
            )
            assert int(page.get("/Rotate", 0)) == 0
            assert "/UserUnit" not in page


def test_rotated_page_is_the_case_that_used_to_diverge(tmp_path):
    """Ghim ca hồi quy, kèm BASELINE của hành vi cũ.

    Trước lô 2b, preview mở file THÔ nên đọc đường bế 180×80; export chuẩn hoá trước
    rồi đọc nên thấy 80×180. Test này giữ cả hai con số để lệch không âm thầm quay lại.
    """
    src = _make_rotated(tmp_path / "r90.pdf", 90)

    raw = _die_size(src)               # hành vi ĐỌC THÔ (preview cũ)
    export = _export_die_size(src)     # hành vi export
    assert raw != export, "ca này phải thực sự lệch, nếu không test vô nghĩa"
    assert raw == (180.0, 80.0)
    assert export == (80.0, 180.0)

    cell = (_preview(src)["cells"] or [])[0]
    assert (cell["width"], cell["height"]) == pytest.approx(export, abs=0.5)


def test_preview_does_not_leak_canonical_temp_files(tmp_path, monkeypatch):
    """ExitStack phải dọn file tạm ở MỌI đường ra của preview_layout."""
    monkeypatch.setattr(nup_engine.tempfile, "gettempdir", lambda: str(tmp_path))
    src = _make_rotated(tmp_path / "r90.pdf", 90)

    _preview(src)

    leaked = list(tmp_path.glob("nup_canon_*.pdf"))
    assert leaked == [], f"rò rỉ file tạm: {leaked}"


def test_preview_does_not_leak_temp_on_error(tmp_path, monkeypatch):
    """Nhánh ném HTTPException cũng không được để lại file tạm."""
    from fastapi import HTTPException

    monkeypatch.setattr(nup_engine.tempfile, "gettempdir", lambda: str(tmp_path))
    src = _make_rotated(tmp_path / "r90.pdf", 90)

    # usable nhỏ hơn tem → engine báo lỗi 422 ở giữa thân hàm.
    with pytest.raises((HTTPException, ValueError, Exception)):
        _preview(src, usable_w=1.0, usable_h=1.0, strategy="manual", cols=0, rows=0)

    leaked = list(tmp_path.glob("nup_canon_*.pdf"))
    assert leaked == [], f"rò rỉ file tạm ở nhánh lỗi: {leaked}"


def test_unrotated_file_is_not_rewritten(tmp_path, monkeypatch):
    """File đã chuẩn: preview KHÔNG được tạo file tạm (giữ nguyên hiệu năng)."""
    monkeypatch.setattr(nup_engine.tempfile, "gettempdir", lambda: str(tmp_path))
    src = _make_rotated(tmp_path / "r0.pdf", 0)

    _preview(src)

    assert list(tmp_path.glob("nup_canon_*.pdf")) == []


def test_cache_key_uses_original_path_not_temp(tmp_path):
    """Khoá cache preview phải bám đường GỐC, nếu không cache không bao giờ hit.

    Đường chuẩn hoá là file tạm mang uuid + mtime mới mỗi request. Nếu nó lọt vào
    `_sticker_nest_cache_key` thì mọi request đều miss → preview nesting chậm hẳn.
    Test đo bằng cách gọi hai lần và đối chiếu kết quả: cùng đầu vào phải cùng đầu ra
    và lần hai không được sinh thêm file tạm nào còn sót.
    """
    src = _make_rotated(tmp_path / "r90.pdf", 90)

    first = _preview(src)
    second = _preview(src)

    assert first["cells"][0]["width"] == second["cells"][0]["width"]
    assert first["cells"][0]["height"] == second["cells"][0]["height"]
    assert len(first["cells"]) == len(second["cells"])
    # Đường gốc vẫn còn nguyên (không bị hàm chuẩn hoá xoá).
    assert os.path.exists(src)


def _make_independent_pages(path, rotate, user_unit=1.0, origin=(0.0, 0.0), crop=False):
    """Hai khuôn khác khổ, không dùng chung content stream để ép nhánh multi-mold."""
    with pikepdf.Pdf.new() as pdf:
        for page_idx, (width, height) in enumerate(((RAW_W, RAW_H), (160.0, 110.0))):
            page = pdf.add_blank_page(page_size=(width, height))
            x0, y0 = origin if page_idx == 0 else (0.0, 0.0)
            page.obj[pikepdf.Name("/MediaBox")] = pikepdf.Array(
                [x0, y0, x0 + width, y0 + height]
            )
            if page_idx == 0:
                if rotate:
                    page.obj[pikepdf.Name("/Rotate")] = rotate
                if user_unit != 1.0:
                    page.obj[pikepdf.Name("/UserUnit")] = user_unit
                if crop:
                    page.obj[pikepdf.Name("/CropBox")] = pikepdf.Array(
                        [x0 + 5.0, y0 + 5.0, x0 + width - 5.0, y0 + height - 5.0]
                    )
            page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
                (
                    f"0 1 0 0 K 0.5 w {x0 + 10} {y0 + 10} "
                    f"{width - 20} {height - 20} re S\n"
                ).encode("ascii")
            )
        assert pdf.pages[0].obj["/Contents"].objgen != pdf.pages[1].obj["/Contents"].objgen
        pdf.save(str(path))
    return str(path)


def _canonical_preview_requests(path):
    """Lấy kích thước như export thật; giữ cùng khóa layout giữa đơn và batch."""
    with nup_engine.canonical_page_space(path) as canon:
        sizes = [_die_size(canon, page_idx) for page_idx in range(2)]
    common = dict(
        path=path,
        usable_w=500.0,
        usable_h=400.0,
        sheet_w=520.0,
        sheet_h=420.0,
        gap_x=0.0,
        gap_y=0.0,
        strategy="simple_auto",
        task_mode="step_repeat",
        grouping_strategy="none",
        is_die_cut=True,
    )
    pages = [
        dict(page_idx=page_idx, shape_type="RECTANGLE", shape_props={}, item_w=width, item_h=height)
        for page_idx, (width, height) in enumerate(sizes)
    ]
    singles = [PreviewLayoutRequest(**common, layout_type="repeat", **page) for page in pages]
    batch = imposition.PreviewLayoutBatchRequest(**common, pages=pages)
    return singles, batch


@pytest.fixture
def isolated_raw_layout_cache(monkeypatch):
    """Mỗi ca có cache riêng, không làm bẩn trạng thái của các test khác."""
    from collections import OrderedDict

    cache = OrderedDict()
    monkeypatch.setattr(imposition, "_NEST_A_CACHE", cache)
    return cache


@pytest.mark.parametrize("rotate", [0, 90, 180, 270])
@pytest.mark.parametrize(
    ("user_unit", "origin", "crop"),
    [
        (1.0, (0.0, 0.0), False),
        (2.0, (0.0, 0.0), False),
        (1.0, (37.0, -19.0), True),
        (2.0, (37.0, -19.0), True),
    ],
    ids=["plain", "user-unit", "origin-crop", "unit-origin-crop"],
)
def test_batch_and_single_share_canonical_geometry_in_both_orders(
    tmp_path, monkeypatch, isolated_raw_layout_cache, rotate, user_unit, origin, crop,
):
    """PERF (audit 2026-09-07 §TEMPERF.C1): batch không được làm bẩn hướng nét bế."""
    monkeypatch.setattr(nup_engine.tempfile, "gettempdir", lambda: str(tmp_path))
    src = _make_independent_pages(
        tmp_path / "hai-khuon.pdf", rotate, user_unit=user_unit, origin=origin, crop=crop,
    )
    original_bytes = Path(src).read_bytes()
    singles, batch = _canonical_preview_requests(src)
    cache = isolated_raw_layout_cache

    cold = {}
    for page_idx, request in enumerate(singles):
        cache.clear()
        cold[page_idx] = preview_layout(request, PRO_LICENSE)
        assert cold[page_idx]["success"] is True
        assert cold[page_idx]["cells"], "ca chuẩn phải có tem và đường bế thật"
    expected_capacities = {page_idx: len(result["cells"]) for page_idx, result in cold.items()}

    cache.clear()
    batch_first = imposition.preview_layouts_batch(batch, PRO_LICENSE)
    after_batch = {
        page_idx: preview_layout(request, PRO_LICENSE)
        for page_idx, request in enumerate(singles)
    }
    batch_first_keys = set(cache)

    cache.clear()
    single_first = {
        page_idx: preview_layout(request, PRO_LICENSE)
        for page_idx, request in enumerate(singles)
    }
    batch_after_single = imposition.preview_layouts_batch(batch, PRO_LICENSE)
    single_first_keys = set(cache)

    assert Path(src).read_bytes() == original_bytes, "chuẩn hóa không được ghi vào PDF nguồn"
    assert list(tmp_path.glob("nup_canon_*.pdf")) == [], "cả hai thứ tự phải dọn PDF tạm"
    assert len(batch_first_keys) == len(single_first_keys) == 2
    assert batch_first_keys == single_first_keys, "batch và đơn phải dùng chung khóa hình học"
    assert {key[0] for key in batch_first_keys} == {src}, "khóa phải dùng nguồn gốc, không dùng UUID tạm"
    assert batch_first["capacities"] == expected_capacities
    assert batch_after_single["capacities"] == expected_capacities
    assert single_first == cold
    assert after_batch == cold, "batch chạy trước không được đổi ô, isRotated hoặc diePolylines"


def _track_canonical_document_lifetime(monkeypatch):
    """Quan sát tài liệu thật; ghi lại thứ tự đóng handle trước khi xóa PDF tạm."""
    from contextlib import contextmanager
    from app.workers import pdf_wrapper

    trace = {"paths": [], "active": set(), "documents": [], "cleanup": []}
    real_canonical = nup_engine.canonical_page_space
    real_open = pdf_wrapper.open

    @contextmanager
    def tracked_canonical(*args, **kwargs):
        with real_canonical(*args, **kwargs) as canonical:
            trace["paths"].append(canonical)
            trace["active"].add(canonical)
            try:
                yield canonical
            finally:
                trace["cleanup"].append(
                    all(record["closed"] for record in trace["documents"])
                )
                trace["active"].remove(canonical)

    def tracked_open(path=None, *args, **kwargs):
        document = real_open(path, *args, **kwargs)
        record = dict(
            path=str(path),
            active_at_open=str(path) in trace["active"],
            closed=False,
            active_at_close=False,
            exists_at_close=False,
        )
        trace["documents"].append(record)
        real_close = document.close

        def tracked_close():
            record["active_at_close"] = str(path) in trace["active"]
            record["exists_at_close"] = Path(path).exists()
            try:
                return real_close()
            finally:
                record["closed"] = True

        document.close = tracked_close
        return document

    monkeypatch.setattr(nup_engine, "canonical_page_space", tracked_canonical)
    monkeypatch.setattr(pdf_wrapper, "open", tracked_open)
    return trace


@pytest.mark.parametrize("compute_error", [False, True], ids=["success", "worker-error"])
def test_batch_keeps_canonical_pdf_alive_until_all_workers_close(
    tmp_path, monkeypatch, isolated_raw_layout_cache, compute_error,
):
    """Hai worker dùng chung file chuẩn, nhưng có handle riêng và dọn cả nhánh lỗi."""
    import threading
    from app.workers import nup_sticker

    monkeypatch.setattr(nup_engine.tempfile, "gettempdir", lambda: str(tmp_path))
    src = _make_independent_pages(
        tmp_path / "multi-worker.pdf", 90, user_unit=2.0, origin=(37.0, -19.0), crop=True,
    )
    source_bytes = Path(src).read_bytes()
    _, batch = _canonical_preview_requests(src)
    trace = _track_canonical_document_lifetime(monkeypatch)
    real_compute = nup_sticker.compute_sticker_layout_for_page
    barrier = threading.Barrier(2)
    calls = []

    def observed_compute(*args, **kwargs):
        document = kwargs["page"].doc
        calls.append(dict(
            thread=threading.get_ident(),
            document=id(document),
            path=document._path,
            active=document._path in trace["active"],
            exists=Path(document._path).exists(),
        ))
        barrier.wait(timeout=5.0)
        if compute_error:
            raise RuntimeError("Lỗi tính thử nghiệm sau khi mở nguồn chuẩn")
        return real_compute(*args, **kwargs)

    monkeypatch.setattr(nup_sticker, "compute_sticker_layout_for_page", observed_compute)
    result = imposition.preview_layouts_batch(batch, PRO_LICENSE)

    assert result["success"] is True
    assert len(trace["paths"]) == 1, "batch chỉ chuẩn hóa một lần, không một lần mỗi worker"
    canonical = trace["paths"][0]
    assert canonical != src
    assert len(calls) == 2
    assert len({call["thread"] for call in calls}) == 2, "phải thực sự đi qua hai worker"
    assert len({call["document"] for call in calls}) == 2, "không chia sẻ handle QPDF giữa worker"
    assert all(call["path"] == canonical and call["active"] and call["exists"] for call in calls)
    assert all(
        record["path"] == canonical
        and record["active_at_open"]
        and record["active_at_close"]
        and record["exists_at_close"]
        and record["closed"]
        for record in trace["documents"]
    )
    assert trace["cleanup"] == [True], "mọi handle phải đóng trước khi context xóa file"
    assert not Path(canonical).exists()
    assert list(tmp_path.glob("nup_canon_*.pdf")) == []
    assert Path(src).read_bytes() == source_bytes
    if compute_error:
        assert result["capacities"] == {0: 0, 1: 0}
        assert isolated_raw_layout_cache == {}, "lỗi tính không được xuất bản cache"
    else:
        assert all(capacity > 0 for capacity in result["capacities"].values())


def test_batch_does_not_leak_canonical_temp_when_document_open_fails(
    tmp_path, monkeypatch, isolated_raw_layout_cache,
):
    """Lỗi mở QPDF sau chuẩn hóa vẫn phải thoát context và xóa file tạm."""
    from app.workers import pdf_wrapper

    monkeypatch.setattr(nup_engine.tempfile, "gettempdir", lambda: str(tmp_path))
    src = _make_independent_pages(tmp_path / "open-error.pdf", 90)
    source_bytes = Path(src).read_bytes()
    _, batch = _canonical_preview_requests(src)
    trace = _track_canonical_document_lifetime(monkeypatch)
    attempted_paths = []

    def fail_open(path=None, *args, **kwargs):
        attempted_paths.append(str(path))
        raise RuntimeError("Không mở được tài liệu thử nghiệm")

    monkeypatch.setattr(pdf_wrapper, "open", fail_open)
    with pytest.raises(RuntimeError, match="Không mở được tài liệu thử nghiệm"):
        imposition.preview_layouts_batch(batch, PRO_LICENSE)

    assert len(trace["paths"]) == 1
    assert attempted_paths == trace["paths"]
    assert attempted_paths[0] != src
    assert trace["cleanup"] == [True]
    assert not Path(attempted_paths[0]).exists()
    assert list(tmp_path.glob("nup_canon_*.pdf")) == []
    assert Path(src).read_bytes() == source_bytes
    assert isolated_raw_layout_cache == {}


def test_batch_does_not_leak_canonical_temp_when_worker_open_fails(
    tmp_path, monkeypatch, isolated_raw_layout_cache,
):
    """Worker lỗi trước khi có handle vẫn phải join xong rồi mới dọn nguồn chung."""
    import threading
    from app.workers import pdf_wrapper

    monkeypatch.setattr(nup_engine.tempfile, "gettempdir", lambda: str(tmp_path))
    src = _make_independent_pages(tmp_path / "worker-open-error.pdf", 90)
    source_bytes = Path(src).read_bytes()
    _, batch = _canonical_preview_requests(src)
    trace = _track_canonical_document_lifetime(monkeypatch)
    tracked_open = pdf_wrapper.open
    caller_thread = threading.get_ident()
    failed_opens = []

    def fail_worker_open(path=None, *args, **kwargs):
        if threading.get_ident() != caller_thread:
            failed_opens.append((str(path), str(path) in trace["active"], Path(path).exists()))
            raise RuntimeError("Không mở được nguồn trong worker thử nghiệm")
        return tracked_open(path, *args, **kwargs)

    monkeypatch.setattr(pdf_wrapper, "open", fail_worker_open)
    result = imposition.preview_layouts_batch(batch, PRO_LICENSE)

    assert result["capacities"] == {0: 0, 1: 0}
    assert len(trace["paths"]) == 1
    canonical = trace["paths"][0]
    assert canonical != src
    assert failed_opens == [(canonical, True, True), (canonical, True, True)]
    assert len(trace["documents"]) == 1
    assert trace["documents"][0]["closed"] is True
    assert trace["cleanup"] == [True]
    assert not Path(canonical).exists()
    assert list(tmp_path.glob("nup_canon_*.pdf")) == []
    assert Path(src).read_bytes() == source_bytes
    assert isolated_raw_layout_cache == {}


def test_batch_already_canonical_source_is_not_rewritten(
    tmp_path, monkeypatch, isolated_raw_layout_cache,
):
    """File đã chuẩn phải đi thẳng vào mọi worker, không tạo UUID tạm rồi xóa."""
    monkeypatch.setattr(nup_engine.tempfile, "gettempdir", lambda: str(tmp_path))
    src = _make_independent_pages(tmp_path / "already-canonical.pdf", 0)
    source_bytes = Path(src).read_bytes()
    _, batch = _canonical_preview_requests(src)
    trace = _track_canonical_document_lifetime(monkeypatch)

    result = imposition.preview_layouts_batch(batch, PRO_LICENSE)

    assert all(capacity > 0 for capacity in result["capacities"].values())
    assert trace["paths"] == [src]
    assert all(record["path"] == src and record["closed"] for record in trace["documents"])
    assert trace["cleanup"] == [True]
    assert list(tmp_path.glob("nup_canon_*.pdf")) == []
    assert Path(src).read_bytes() == source_bytes
