"""Cổng bất biến cho việc tách `run_nup_engine` thành các pha.

PREVIEW (audit 2026-08-28 §SHEET.PLAN.1): view chính của Bình cắt xén sẽ hiển thị
tờ bình thật do **chính** writer sản xuất vẽ, nên `_run_nup_engine_impl` phải tách
được pha solve khỏi pha ghi file. Refactor đó chỉ được coi là an toàn khi output
toàn tài liệu **không đổi một nét nào**.

Vân tay ở đây không băm cả file: pikepdf/PyMuPDF ghi `/ID` và `/ModDate` khác nhau
mỗi lượt lưu nên hash file luôn lệch dù nội dung y hệt. Thay vào đó băm thứ thật sự
quyết định bản in: khổ từng trang, content stream từng trang, và nội dung mọi
XObject mà trang tham chiếu (artwork được đặt qua Form XObject nên bỏ nó là bỏ
đúng phần dễ sai nhất).
"""

from __future__ import annotations

import hashlib
import os
import shutil
from typing import Any

import pikepdf
import pytest

from app.workers import nup_engine
from app.workers.nup_sheet_render import (
    NupSheetRenderError,
    nup_sheet_plan,
    render_nup_sheet,
)


BASE_SETTINGS: dict[str, Any] = {
    "imposerMode": "guillotine",
    "isDieCutMode": False,
    "sheetWidth": 320.0,
    "sheetHeight": 450.0,
    "bleed": 3.0,
    "gapX": 2.0,
    "gapY": 2.0,
    "marginTop": 10.0,
    "marginBottom": 10.0,
    "marginLeft": 10.0,
    "marginRight": 10.0,
    "gripperMargin": 0.0,
    "markType": "corner",
    "markLength": 5.0,
    "markOffset": 3.0,
    "markThickness": 0.25,
    "markStyle": "default",
    "gridStrategy": "optimal_auto",
    "align": "center",
    "targetQuantity": 0,
    "targetQuantitiesByPage": {},
    "pontType": "none",
    "splitGap": 0.0,
}

# Mỗi ca: (tên, kích thước từng trang nguồn, settings ghi đè).
# Phủ đủ năm cách xếp của Bình cắt xén cộng một ca duplex và một ca tem bế —
# tem bế dùng chung đường args_list nên refactor chạm tới nó.
CASES: list[tuple[str, list[tuple[float, float]], dict[str, Any]]] = [
    (
        "binh_trang_repeat",
        [(200.0, 140.0)],
        {"layoutType": "repeat", "targetQuantity": 40},
    ),
    (
        "binh_trang_repeat_nhieu_trang",
        [(200.0, 140.0), (200.0, 140.0), (200.0, 140.0)],
        {"layoutType": "repeat", "targetQuantitiesByPage": {"0": 20, "1": 40, "2": 10}},
    ),
    (
        "dan_sequential",
        [(200.0, 140.0), (200.0, 140.0), (200.0, 140.0)],
        {"layoutType": "sequential", "targetQuantity": 30},
    ),
    (
        "dan_cut_stacks",
        [(200.0, 140.0), (200.0, 140.0), (200.0, 140.0)],
        {"layoutType": "cut_stacks", "targetQuantity": 30},
    ),
    (
        "dan_ratio_stack",
        [(200.0, 140.0), (200.0, 140.0), (200.0, 140.0)],
        {
            "layoutType": "ratio_stack",
            "targetQuantitiesByPage": {"0": 300, "1": 150, "2": 50},
        },
    ),
    (
        "dan_sequential_hai_mat",
        [(200.0, 140.0), (200.0, 140.0)],
        {
            "layoutType": "sequential",
            "duplexFlow": "double",
            "targetQuantitiesByPage": {"0": 40},
        },
    ),
    (
        "dan_nhieu_kich_thuoc",
        [(200.0, 140.0), (150.0, 100.0)],
        {
            "layoutType": "mixed_guillotine",
            "targetQuantitiesByPage": {"0": 200, "1": 120},
        },
    ),
    (
        # Bắt buộc có ca VƯỢT một chunk (mặc định 5 tờ/chunk): chỉ khi tồn tại chunk
        # bắt đầu ở tờ khác 0 thì lỗi lệch offset theo chunk mới lộ ra.
        "binh_trang_nhieu_chunk",
        [(200.0, 140.0)],
        {"layoutType": "repeat", "targetQuantity": 900},
    ),
    (
        # Tờ nhỏ để sức chứa chỉ một con: 12 mẫu thành 12 tờ, tức 3 chunk. Đây là ca
        # duy nhất phủ đồng thời "nhiều chunk" VÀ "placement đã tính trước theo tờ" —
        # tổ hợp mà lỗi lệch offset chunk chỉ lộ ra ở đó.
        "dan_cut_stacks_nhieu_chunk",
        [(200.0, 140.0)] * 12,
        {
            "layoutType": "cut_stacks",
            "sheetWidth": 100.0,
            "sheetHeight": 100.0,
            "targetQuantity": 12,
        },
    ),
    (
        "tem_be_repeat",
        [(200.0, 140.0)],
        {
            "imposerMode": "sticker_imposer",
            "isDieCutMode": True,
            "layoutType": "repeat",
            "markType": "none",
            "cutType": "default",
            "dieSizeMode": "die",
            "dieOffsetMm": 0.0,
            "separateCutPage": False,
            "detectedShapesByPage": {"0": "RECTANGLE"},
            "detectedShapeParamsByPage": {"0": {}},
            "targetQuantity": 40,
        },
    ),
]


def _make_source(path, page_sizes: list[tuple[float, float]]) -> str:
    """Nguồn có nội dung vẽ thật để content stream không rỗng."""
    pdf = pikepdf.Pdf.new()
    for index, (width, height) in enumerate(page_sizes):
        page = pdf.add_blank_page(page_size=(width, height))
        shade = 0.15 + 0.2 * (index % 3)
        page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
            f"q {shade:.2f} 0 0 1 k 5 5 {width - 10:.2f} {height - 10:.2f} re f Q\n"
            f"q 0 0 0 1 k {width / 4:.2f} {height / 4:.2f} "
            f"{width / 2:.2f} {height / 2:.2f} re f Q\n".encode("ascii"),
        )
    pdf.save(str(path))
    pdf.close()
    return str(path)


def _stream_bytes(obj) -> bytes:
    try:
        return bytes(obj.read_bytes())
    except Exception:  # pragma: no cover - object không phải stream
        return repr(obj).encode("utf-8", "replace")


def sheet_fingerprint(path: str) -> list[tuple[Any, ...]]:
    """Vân tay từng trang đầu ra: khổ + content stream + mọi XObject tham chiếu.

    Tên XObject bị chuẩn hoá theo **nội dung** vì `pdf_ops.py:580` đặt tên
    ``/NupXo{uid}_{page}`` với ``uid`` là bộ đếm phạm vi process
    (``_stable_pdf_uid``). Chạy cùng một job hai lượt trong cùng tiến trình cho
    ``/NupXo1_0`` rồi ``/NupXo2_0`` dù byte nội dung y hệt. Nếu không chuẩn hoá thì
    cổng này báo đỏ vì một cái tên nội bộ, không phải vì bản in đổi.
    """
    fingerprint: list[tuple[Any, ...]] = []
    with pikepdf.Pdf.open(path) as pdf:
        for page in pdf.pages:
            media = tuple(round(float(value), 4) for value in page.MediaBox)
            resources = page.obj.get("/Resources") or {}
            xobjects = resources.get("/XObject") or {}
            token_of: dict[str, str] = {}
            digests: list[str] = []
            for key in xobjects.keys():
                name = str(key)
                digest = hashlib.sha256(_stream_bytes(xobjects[key])).hexdigest()
                token_of[name] = f"/Xo{digest[:16]}"
                digests.append(digest)

            contents = page.obj.get("/Contents")
            streams = (
                list(contents) if isinstance(contents, pikepdf.Array) else [contents]
            )
            raw = b"\n".join(
                _stream_bytes(stream) for stream in streams if stream is not None
            )
            # Thay tên DÀI trước: '/NupXo1_0' không được phá '/NupXo1_01'.
            for name in sorted(token_of, key=len, reverse=True):
                raw = raw.replace(
                    name.encode("ascii"), token_of[name].encode("ascii")
                )

            fingerprint.append((
                media,
                hashlib.sha256(raw).hexdigest(),
                tuple(sorted(digests)),
            ))
    return fingerprint


def run_case(source: str, output, overrides: dict[str, Any], job_id: str) -> str:
    nup_engine.run_nup_engine(
        source, str(output), {**BASE_SETTINGS, **overrides}, job_id=job_id,
    )
    return str(output)


@pytest.mark.parametrize("name,page_sizes,overrides", CASES, ids=[c[0] for c in CASES])
def test_output_fingerprint_is_deterministic(tmp_path, name, page_sizes, overrides):
    """Tiền đề của cổng: cùng đầu vào phải cho cùng vân tay ở hai lượt chạy.

    Nếu ca nào không xác định thì cổng byte-identical vô nghĩa với ca đó, và ta
    phải biết điều đó ngay bây giờ chứ không phải lúc refactor đang dở.
    """
    source = _make_source(tmp_path / f"{name}-src.pdf", page_sizes)

    first = sheet_fingerprint(
        run_case(source, tmp_path / f"{name}-a.pdf", overrides, f"{name}-a")
    )
    second = sheet_fingerprint(
        run_case(source, tmp_path / f"{name}-b.pdf", overrides, f"{name}-b")
    )

    assert first, "Job không sinh trang nào; ca kiểm thử này vô dụng."
    assert first == second


# ═══════════════════════════════════════════════════════════════════════════
#  Bất biến chính: preview một tờ ≡ tờ đó trong đường xuất
# ═══════════════════════════════════════════════════════════════════════════


def _capture_export_chunks(source: str, output, overrides: dict, job_id: str, tmp_path):
    """Chạy đường xuất với chunking TỰ NHIÊN và giữ lại từng chunk PDF.

    Chunk mặc định gộp tới 5 tờ. Giữ nguyên con số đó là chủ đích: nếu ép
    ``CHUNK_SIZE=1`` thì hai bên so sánh đi cùng một đường và phép so trở nên vô
    nghĩa. Ở đây ta thật sự kiểm "tờ 3 nằm trong chunk 0–4" có bằng "tờ 3 render
    một mình" hay không.
    """
    captured: list[tuple[int, int, str]] = []
    original_chunk = nup_engine.process_chunk
    original_plan = nup_engine._plan_nup_chunking

    def capturing_chunk(args):
        chunk_path = original_chunk(args)
        if chunk_path and os.path.exists(chunk_path):
            keep = tmp_path / f"{job_id}-chunk{len(captured)}.pdf"
            shutil.copyfile(chunk_path, keep)
            captured.append((int(args[3]), int(args[4]), str(keep)))
        return chunk_path

    # GIỮ nguyên kích thước chunk 5 tờ nhưng ép chạy NỘI TUYẾN: job nhiều tờ vốn
    # đi ProcessPoolExecutor, mà hàm wrap cục bộ của test không pickle được. Ép số
    # worker về 1 chỉ đổi nơi chạy, không đổi dải tờ của từng chunk — đúng thứ đang
    # cần kiểm.
    nup_engine.process_chunk = capturing_chunk
    nup_engine._plan_nup_chunking = lambda total, cores: (
        max(1, min(5, int(total or 1))),
        1,
    )
    try:
        nup_engine.run_nup_engine(
            source, str(output), {**BASE_SETTINGS, **overrides}, job_id=job_id,
        )
    finally:
        nup_engine.process_chunk = original_chunk
        nup_engine._plan_nup_chunking = original_plan

    captured.sort(key=lambda item: item[0])
    return captured


@pytest.mark.parametrize("name,page_sizes,overrides", CASES, ids=[c[0] for c in CASES])
def test_single_sheet_render_matches_export_chunk(
    tmp_path, name, page_sizes, overrides
):
    """Render một tờ qua đường preview phải cho ĐÚNG nội dung tờ đó của đường xuất."""
    source = _make_source(tmp_path / f"{name}-src.pdf", page_sizes)

    chunks = _capture_export_chunks(
        source, tmp_path / f"{name}-full.pdf", overrides, f"{name}-cap", tmp_path,
    )
    assert chunks, "Đường xuất không sinh chunk nào."
    if "nhieu_chunk" in name:
        # Chốt corpus: ca này tồn tại để phủ chunk bắt đầu ở tờ khác 0. Nếu một
        # thay đổi sau này làm nó co lại thành một chunk thì phép so mất ý nghĩa
        # mà vẫn xanh — phải báo đỏ ngay tại đây.
        assert len(chunks) > 1, (
            f"Ca {name} chỉ có {len(chunks)} chunk; không còn phủ được lỗi lệch "
            "offset theo chunk."
        )
    expected = [
        page
        for _start, _end, chunk_path in chunks
        for page in sheet_fingerprint(chunk_path)
    ]

    actual: list[Any] = []
    with nup_sheet_plan(source, {**BASE_SETTINGS, **overrides}) as plan:
        # Số tờ của kế hoạch phải khớp dải tờ mà đường xuất đã render.
        assert plan.total_sheets == chunks[-1][1]
        for sheet_index in range(plan.total_sheets):
            out = tmp_path / f"{name}-sheet{sheet_index}.pdf"
            render_nup_sheet(plan, sheet_index, str(out))
            actual.extend(sheet_fingerprint(str(out)))

    assert len(actual) == len(expected)
    for position, (got, want) in enumerate(zip(actual, expected)):
        assert got == want, f"Trang {position} của tờ bình lệch so với đường xuất."


@pytest.mark.parametrize("name,page_sizes,overrides", CASES, ids=[c[0] for c in CASES])
def test_plan_renders_same_sheet_twice_without_resolving(
    tmp_path, name, page_sizes, overrides
):
    """Đổi tờ đang xem rồi quay lại không được cho nội dung khác."""
    source = _make_source(tmp_path / f"{name}-src.pdf", page_sizes)

    with nup_sheet_plan(source, {**BASE_SETTINGS, **overrides}) as plan:
        first = tmp_path / f"{name}-again-a.pdf"
        second = tmp_path / f"{name}-again-b.pdf"
        render_nup_sheet(plan, 0, str(first))
        if plan.total_sheets > 1:
            render_nup_sheet(plan, plan.total_sheets - 1, str(tmp_path / f"{name}-mid.pdf"))
        render_nup_sheet(plan, 0, str(second))

        assert sheet_fingerprint(str(first)) == sheet_fingerprint(str(second))


def test_sheet_index_out_of_range_is_refused(tmp_path):
    """Tờ ngoài dải phải báo lỗi, không được im lặng trả tờ khác."""
    source = _make_source(tmp_path / "range-src.pdf", [(200.0, 140.0)])
    with nup_sheet_plan(source, {**BASE_SETTINGS, "layoutType": "repeat"}) as plan:
        for bad in (-1, plan.total_sheets):
            with pytest.raises(NupSheetRenderError):
                render_nup_sheet(plan, bad, str(tmp_path / "range-out.pdf"))


def test_sheet_to_source_page_mapping_only_exists_for_binh_trang(tmp_path):
    """Bình trang là 1 tờ / 1 trang nguồn; các cách dàn thì tờ gom nhiều mẫu."""
    pages = [(200.0, 140.0)] * 3
    source = _make_source(tmp_path / "map-src.pdf", pages)

    with nup_sheet_plan(
        source,
        {
            **BASE_SETTINGS,
            "layoutType": "repeat",
            "targetQuantitiesByPage": {"0": 10, "1": 10, "2": 10},
        },
    ) as plan:
        assert plan.total_sheets == 3
        assert [plan.source_page_for_sheet(n) for n in range(3)] == [0, 1, 2]

    with nup_sheet_plan(
        source, {**BASE_SETTINGS, "layoutType": "ratio_stack", "targetQuantity": 300},
    ) as plan:
        # Mọi tờ trộn cả ba mẫu theo tỉ lệ → không có ánh xạ đơn trị sang trang nguồn.
        assert all(
            plan.source_page_for_sheet(n) is None for n in range(plan.total_sheets)
        )
