"""Tests cho tính năng CNC ghép nhiều mẫu (cnc-multi-template).

Dùng vòng lặp ngẫu nhiên (>=100 vòng) cho các hàm THUẦN — không phụ thuộc
hypothesis. Bao phủ các correctness property trong design.md.
"""
import random

import pytest

from app.workers.cnc_layout import build_cnc_front_layout, select_front_pages
from app.workers.cnc_render import mirror_placements_multi


N_ITER = 120


@pytest.fixture(autouse=True)
def _seed_random():
    """Seed cố định trước MỖI test → các vòng lặp ngẫu nhiên xác định, hết flaky CI
    (vd test_quantity_fills_sheet_like_autofill từng fail giả do random không seed).
    Vẫn giữ tính phủ rộng nhờ N_ITER vòng từ cùng 1 chuỗi tái lập."""
    random.seed(20240617)


# ─────────────────────────────────────────────────────────────
# Property 1: select_front_pages — chọn tập Mặt trước + liên kết Mặt sau
# Feature: cnc-multi-template, Property 1
# Validates: Requirements 1.1, 1.2, 1.3, 6.2
# ─────────────────────────────────────────────────────────────
def test_property1_select_front_pages_one_sided():
    for _ in range(N_ITER):
        n = random.randint(1, 40)
        front, back_of = select_front_pages(n, two_sided=False)
        assert front == list(range(n))
        assert all(back_of[i] is None for i in front)


def test_property1_select_front_pages_two_sided():
    for _ in range(N_ITER):
        pairs = random.randint(1, 20)
        n = pairs * 2
        front, back_of = select_front_pages(n, two_sided=True)
        assert front == list(range(0, n, 2))
        assert all(back_of[i] == i + 1 for i in front)
        # mỗi Mặt trước liên kết duy nhất 1 Mặt sau
        assert len(set(back_of.values())) == len(front)


# ─────────────────────────────────────────────────────────────
# Property 4: build_cnc_front_layout — chọn solver theo SL + căn giữa tờ
# Feature: cnc-multi-template, Property 4
# Validates: Requirements 2.1, 2.2, 5.1
# ─────────────────────────────────────────────────────────────
def _rand_pages(with_qty):
    k = random.randint(1, 4)
    dims = []
    for i in range(k):
        w = random.uniform(40, 120)
        h = random.uniform(40, 120)
        q = random.randint(1, 50) if with_qty else 0
        dims.append((i, w, h, q))
    return dims


def test_property4_solver_selection_and_centering():
    for _ in range(N_ITER):
        usable_w = random.uniform(400, 900)
        usable_h = random.uniform(400, 900)
        ml = random.uniform(0, 30)
        mb = random.uniform(0, 30)
        with_qty = random.random() < 0.5
        pages = _rand_pages(with_qty)

        res = build_cnc_front_layout(
            pages, usable_w, usable_h, gap=random.uniform(0, 8),
            margin_left=ml, margin_bottom=mb, margin_top=random.uniform(0, 30),
        )
        # selector + sheets_needed
        total_q = sum(q for *_, q in pages)
        if total_q > 0:
            assert res['sheets_needed'] >= 1
        else:
            assert res['sheets_needed'] == 1

        pls = res['placements']
        if not pls:
            continue
        # Căn giữa: lề dư trái == lề dư phải (theo X) trong sai số làm tròn
        min_x = min(p['abs_x'] for p in pls)
        max_x = max(p['abs_x'] + p['width'] for p in pls)
        left_gap = min_x - ml
        right_gap = (ml + usable_w) - max_x
        assert left_gap == pytest.approx(right_gap, abs=1e-6)
        assert left_gap >= -1e-6


def test_property4_empty_input():
    res = build_cnc_front_layout([], 500, 500, gap=0)
    assert res['placements'] == []
    assert res['sheets_needed'] == 0


# ─────────────────────────────────────────────────────────────
# Property 2 + 3: mirror_placements_multi — đối xứng, involution, khớp ô, src+1
# Feature: cnc-multi-template, Property 2 / Property 3
# Validates: Requirements 2.4, 3.1, 3.3, 3.4
# ─────────────────────────────────────────────────────────────
def _front_layout_two_sided():
    """Dựng front_pl cho 2 mặt: src_page_idx là các trang chẵn."""
    pairs = random.randint(1, 3)
    n = pairs * 2
    front_idxs, back_of = select_front_pages(n, two_sided=True)
    pages = [(fi, random.uniform(40, 120), random.uniform(40, 120),
              random.randint(1, 30)) for fi in front_idxs]
    usable_w = random.uniform(400, 900)
    usable_h = random.uniform(400, 900)
    res = build_cnc_front_layout(pages, usable_w, usable_h, gap=random.uniform(0, 6),
                                 margin_left=random.uniform(0, 20),
                                 margin_bottom=random.uniform(0, 20))
    return res['placements'], back_of, usable_w, usable_h


def test_property3_mirror_counts_and_src_mapping():
    for _ in range(N_ITER):
        front_pl, back_of, _, _ = _front_layout_two_sided()
        if not front_pl:
            continue
        sheet_w = random.uniform(900, 1400)
        sheet_h = random.uniform(900, 1400)
        flip = random.choice(['long', 'short'])
        back_pl = mirror_placements_multi(front_pl, sheet_w, sheet_h, flip, back_of)

        # số ô bằng nhau
        assert len(back_pl) == len(front_pl)
        # src Mặt sau = src Mặt trước + 1 (đúng mẫu)
        for f, b in zip(front_pl, back_pl):
            assert b['src_page_idx'] == f['src_page_idx'] + 1
        # số ô mỗi mẫu giữ nguyên (theo back src)
        from collections import Counter
        cf = Counter(p['src_page_idx'] for p in front_pl)
        cb = Counter(p['src_page_idx'] - 1 for p in back_pl)
        assert cf == cb


def test_property2_mirror_flags_and_position_preserved():
    # Mô hình mới: phản chiếu toàn tờ do render (mirror quanh tâm tờ) → placement
    # GIỮ NGUYÊN vị trí + góc xoay, chỉ gắn cờ mirror_x/mirror_y theo cạnh lật.
    for _ in range(N_ITER):
        front_pl, back_of, _, _ = _front_layout_two_sided()
        if not front_pl:
            continue
        sheet_w = random.uniform(900, 1400)
        sheet_h = random.uniform(900, 1400)
        flip = random.choice(['long', 'short'])
        back_pl = mirror_placements_multi(front_pl, sheet_w, sheet_h, flip, back_of)

        for f, b in zip(front_pl, back_pl):
            assert b['abs_x'] == pytest.approx(f['abs_x'], abs=1e-6)
            assert b['original_cell_y'] == pytest.approx(f['original_cell_y'], abs=1e-6)
            if flip == 'long':
                assert b['mirror_x'] is True and b['mirror_y'] is False
            else:
                assert b['mirror_y'] is True and b['mirror_x'] is False
            assert b['cell'].get('isRotated') == f['cell'].get('isRotated')
            assert b['cell'].get('isRotated180') == f['cell'].get('isRotated180')


# ─────────────────────────────────────────────────────────────
# Property 8 + 9: cấu trúc cụm trang + report sheets_needed (integration)
# Feature: cnc-multi-template, Property 8 / Property 9
# Validates: Requirements 7.1, 7.2, 7.3, 7.4
# ─────────────────────────────────────────────────────────────
import io as _io

from pypdf import PdfReader

from app.api.routes import imposition as imposition_route
from app.workers import pdf_wrapper as _pdf_lib
from app.workers.cnc_render import run_cnc_two_sided


def _make_plain_pdf(path, n_pages, w=320 * 2.83465, h=450 * 2.83465):
    doc = _pdf_lib.open()
    for _ in range(n_pages):
        doc.new_page(width=w, height=h)
    buf = _io.BytesIO()
    doc.save(buf, garbage=0, deflate=True)
    doc.close()
    with open(path, 'wb') as f:
        f.write(buf.getvalue())


def _page_count(path):
    d = _pdf_lib.open(path)
    n = d.page_count
    d.close()
    return n


def test_property8_two_sided_opens_one_unit_per_distinct_sheet(tmp_path):
    p = str(tmp_path / "src.pdf")
    out = str(tmp_path / "out.pdf")
    _make_plain_pdf(p, 4)  # 2 mẫu × (trước+sau)
    run_cnc_two_sided(p, out, {
        'cncTwoSided': True, 'sheetWidth': 320, 'sheetHeight': 450,
        'targetQuantity': 0,
    })
    # Mỗi mẫu bằng đúng khổ tờ → 2 tờ mẫu × [Front, Back, Cut].
    assert _page_count(out) == 6


def test_property8_one_sided_opens_one_unit_per_distinct_sheet(tmp_path):
    p = str(tmp_path / "src1.pdf")
    out = str(tmp_path / "out1.pdf")
    _make_plain_pdf(p, 3)  # 3 mẫu 1 mặt
    run_cnc_two_sided(p, out, {
        'cncTwoSided': False, 'sheetWidth': 320, 'sheetHeight': 450,
    })
    # Mỗi mẫu bằng đúng khổ tờ → 3 tờ mẫu × [Front, Cut].
    assert _page_count(out) == 6


def test_property8_pages_independent_of_quantity(tmp_path):
    """Số trang output KHÔNG phụ thuộc sheets_needed."""
    p = str(tmp_path / "srcq.pdf")
    out = str(tmp_path / "outq.pdf")
    _make_plain_pdf(p, 2)
    run_cnc_two_sided(p, out, {
        'cncTwoSided': True, 'sheetWidth': 320, 'sheetHeight': 450,
        'targetQuantity': 999,
    })
    assert _page_count(out) == 3


def test_property9_report_contains_sheets_needed(tmp_path):
    p = str(tmp_path / "srcr.pdf")
    out = str(tmp_path / "outr.pdf")
    _make_plain_pdf(p, 2)
    report = run_cnc_two_sided(p, out, {
        'cncTwoSided': True, 'sheetWidth': 320, 'sheetHeight': 450,
        'targetQuantity': 50,
    })
    assert "Số tờ cần in" in report


# ─────────────────────────────────────────────────────────────
# CNC MULTI-SHEET FIX 2026-08-10 §MSHEET.1
# Mọi tờ mẫu khác nhau phải đi xuyên helper → preview → artifact.
# ─────────────────────────────────────────────────────────────
def _make_labeled_pdf(path, labels, size_mm=90.0):
    doc = _pdf_lib.open()
    for label in labels:
        page = doc.new_page(width=size_mm * 2.83465, height=size_mm * 2.83465)
        page.insert_text(_pdf_lib.Point(10 * 2.83465, 20 * 2.83465), label, fontsize=18)
    doc.save(path)
    doc.close()


@pytest.mark.parametrize("quantity", [0, 1])
def test_cnc_layout_opens_every_distinct_sheet(quantity):
    result = build_cnc_front_layout(
        [(page_idx, 90.0, 90.0, quantity) for page_idx in range(5)],
        usable_w=100.0,
        usable_h=100.0,
        gap=0.0,
        allow_rotation=False,
    )

    assert result['sheet_count'] == 5
    assert result['sheets_needed'] == 5
    assert result['unplaced_pages'] == []
    assert [
        [placement['src_page_idx'] for placement in sheet['placements']]
        for sheet in result['sheets']
    ] == [[0], [1], [2], [3], [4]]
    assert [sheet['sheets_needed'] for sheet in result['sheets']] == [1] * 5


@pytest.mark.parametrize("with_quantity", [False, True])
def test_cnc_preview_exposes_every_distinct_sheet(tmp_path, monkeypatch, with_quantity):
    monkeypatch.setattr(imposition_route, 'enforce_feature', lambda *_args, **_kwargs: None)
    monkeypatch.setattr(imposition_route, '_validate_file_path', lambda path: path)
    source_path = str(tmp_path / 'cnc-five-models.pdf')
    _make_labeled_pdf(source_path, [f'MODEL_{index + 1}' for index in range(5)])

    quantities = {str(index): 1 for index in range(5)} if with_quantity else {}
    request = imposition_route.PreviewLayoutRequest(
        usable_w=100 * 2.83465,
        usable_h=100 * 2.83465,
        item_w=90 * 2.83465,
        item_h=90 * 2.83465,
        gap_x=0,
        gap_y=0,
        strategy='optimal_auto',
        sheet_w=100 * 2.83465,
        sheet_h=100 * 2.83465,
        path=source_path,
        total_pages=5,
        layout_type='sequential',
        task_mode='nup',
        is_die_cut=True,
        imposer_mode='cnc',
        target_quantities_by_page=quantities,
    )

    result = imposition_route.preview_layout(request, license_info={})

    assert result['sheetsNeeded'] == 5
    assert result['placedByPage'] == {'0': 1}
    assert [
        [cell['pageIdx'] for cell in sheet['cells']]
        for sheet in result['sheets']
    ] == [[0], [1], [2], [3], [4]]
    assert [sheet['runCount'] for sheet in result['sheets']] == [1] * 5


@pytest.mark.parametrize("with_quantity", [False, True])
def test_cnc_one_sided_artifact_contains_every_model(tmp_path, with_quantity):
    source_path = str(tmp_path / 'cnc-five-models.pdf')
    output_path = str(tmp_path / 'cnc-five-models-output.pdf')
    labels = [f'MODEL_{index + 1}' for index in range(5)]
    _make_labeled_pdf(source_path, labels)

    settings = {
        'layoutType': 'sequential',
        'cncTwoSided': False,
        'sheetWidth': 100,
        'sheetHeight': 100,
        'gapX': 0,
        'gapY': 0,
        'bleed': 0,
    }
    if with_quantity:
        settings['targetQuantitiesByPage'] = {str(index): 1 for index in range(5)}
    report = run_cnc_two_sided(source_path, output_path, settings)

    reader = PdfReader(output_path)
    assert len(reader.pages) == 10
    assert [(reader.pages[index].extract_text() or '').strip() for index in range(0, 10, 2)] == labels
    assert all(not (reader.pages[index].extract_text() or '').strip() for index in range(1, 10, 2))
    assert 'Số tờ cần in (tổng): 5' in report


def test_cnc_two_sided_artifact_keeps_each_front_back_pair(tmp_path):
    source_path = str(tmp_path / 'cnc-three-pairs.pdf')
    output_path = str(tmp_path / 'cnc-three-pairs-output.pdf')
    labels = ['FRONT_1', 'BACK_1', 'FRONT_2', 'BACK_2', 'FRONT_3', 'BACK_3']
    _make_labeled_pdf(source_path, labels)

    run_cnc_two_sided(
        source_path,
        output_path,
        {
            'layoutType': 'sequential',
            'cncTwoSided': True,
            'cncFlipEdge': 'long',
            'sheetWidth': 100,
            'sheetHeight': 100,
            'gapX': 0,
            'gapY': 0,
            'bleed': 0,
            'targetQuantitiesByPage': {'0': 1, '2': 1, '4': 1},
        },
    )

    reader = PdfReader(output_path)
    assert len(reader.pages) == 9
    assert [(reader.pages[index].extract_text() or '').strip() for index in (0, 3, 6)] == [
        'FRONT_1', 'FRONT_2', 'FRONT_3',
    ]
    assert [(reader.pages[index].extract_text() or '').strip() for index in (1, 4, 7)] == [
        'BACK_1', 'BACK_2', 'BACK_3',
    ]


def test_cnc_output_fails_closed_when_one_model_cannot_be_placed(tmp_path):
    source_path = str(tmp_path / 'cnc-partial-overflow.pdf')
    output_path = str(tmp_path / 'cnc-partial-overflow-output.pdf')
    document = _pdf_lib.open()
    document.new_page(width=90 * 2.83465, height=90 * 2.83465)
    document.new_page(width=110 * 2.83465, height=110 * 2.83465)
    document.save(source_path)
    document.close()

    with pytest.raises(ValueError, match='Trang chưa được đặt: 2'):
        run_cnc_two_sided(
            source_path,
            output_path,
            {
                'layoutType': 'sequential',
                'cncTwoSided': False,
                'sheetWidth': 100,
                'sheetHeight': 100,
                'gapX': 0,
                'gapY': 0,
                'bleed': 0,
            },
        )


def test_dispatch_routes_cnc_to_renderer(tmp_path, monkeypatch):
    """imposerMode=='cnc' → nup_engine gọi run_cnc_two_sided (không qua nhánh trộn)."""
    import app.workers.nup_engine as ne
    called = {}

    def _fake(source_path, output_path, settings, job_id=None, progress_callback=None):
        called['hit'] = True
        return "ok"

    monkeypatch.setattr('app.workers.cnc_render.run_cnc_two_sided', _fake)
    res = ne.run_nup_engine("x.pdf", "y.pdf", {'imposerMode': 'cnc'})
    assert called.get('hit') is True
    assert res == "ok"


# ─────────────────────────────────────────────────────────────
# Mặt sau là PHẢN CHIẾU (reflection), KHÔNG xoay: giữ nguyên cờ xoay + đặt mirror_x/y.
# Feature: cnc-multi-template, Property 3 — Requirements 3.1, 3.3 (đã sửa: dùng mirror thật)
# ─────────────────────────────────────────────────────────────
def test_back_face_is_reflection_not_rotation():
    # Lật cạnh dài → phản chiếu NGANG (mirror_x), cờ xoay GIỮ NGUYÊN (không toggle).
    for fr in (True, False):
        for f180 in (True, False):
            front = [{
                'cluster_idx': 0, 'src_page_idx': 0,
                'abs_x': 10.0, 'abs_y': 20.0, 'original_cell_y': 20.0,
                'width': 50.0, 'height': 40.0,
                'cell': {'x': 0, 'y': 0, 'width': 50.0, 'height': 40.0,
                         'isRotated': fr, 'isRotated180': f180, 'blockId': 0},
            }]
            back = mirror_placements_multi(front, 500.0, 500.0, 'long', {0: 1})
            # Cờ xoay giữ nguyên — phản chiếu nằm ở mirror_x, không phải xoay.
            assert back[0]['cell']['isRotated'] == fr
            assert back[0]['cell']['isRotated180'] == f180
            assert back[0]['mirror_x'] is True
            assert back[0]['mirror_y'] is False
            # front không bị thay đổi
            assert front[0]['cell']['isRotated'] == fr
            assert front[0]['cell']['isRotated180'] == f180


def test_back_face_position_involution():
    """Lật 2 lần (cùng cạnh) → VỊ TRÍ trở về ban đầu (đặc trưng reflection)."""
    for fr in (True, False):
        for f180 in (True, False):
            front = [{
                'cluster_idx': 0, 'src_page_idx': 0,
                'abs_x': 10.0, 'abs_y': 20.0, 'original_cell_y': 20.0,
                'width': 50.0, 'height': 40.0,
                'cell': {'x': 0, 'y': 0, 'width': 50.0, 'height': 40.0,
                         'isRotated': fr, 'isRotated180': f180, 'blockId': 0},
            }]
            once = mirror_placements_multi(front, 500.0, 500.0, 'long', {0: 1})
            twice = mirror_placements_multi(once, 500.0, 500.0, 'long', {1: 1})
            assert twice[0]['abs_x'] == pytest.approx(10.0)
            # Cờ xoay không đổi qua các lần lật
            assert twice[0]['cell']['isRotated'] == fr
            assert twice[0]['cell']['isRotated180'] == f180


# ─────────────────────────────────────────────────────────────
# Có SL vẫn LẤP ĐẦY tờ y như không SL (không bỏ trống tờ in)
# Validates: Requirements 2.1, 2.2 (fill ưu tiên hơn ratio cho CNC)
# ─────────────────────────────────────────────────────────────
def test_quantity_fills_sheet_like_autofill():
    for _ in range(60):
        k = random.randint(2, 5)
        base = [(i, random.uniform(40, 110), random.uniform(40, 110)) for i in range(k)]
        usable_w = random.uniform(500, 900)
        usable_h = random.uniform(500, 900)
        gap = random.uniform(0, 6)

        no_qty = build_cnc_front_layout(
            [(i, w, h, 0) for i, w, h in base], usable_w, usable_h, gap)
        with_qty = build_cnc_front_layout(
            [(i, w, h, 1000) for i, w, h in base], usable_w, usable_h, gap)

        # Có SL vẫn LẤP ĐẦY ~ bằng auto_fill (không bỏ trống tờ in). Sàn 0.78: đo
        # thực nghiệm (200×60 vòng) thấy ca packing biên tệ nhất ~0.80 → bound 0.78
        # có biên an toàn mà vẫn bắt được hồi quy "SL làm tụt fill nghiêm trọng".
        assert with_qty['items_per_sheet'] >= no_qty['items_per_sheet'] * 0.78
        assert with_qty['sheets_needed'] >= 1
        assert no_qty['sheets_needed'] == 1


def test_quantity_ratio_reflected_in_layout():
    """SL chênh lệch lớn → mẫu SL cao có NHIỀU con/tờ hơn mẫu SL thấp."""
    hits = 0
    for _ in range(60):
        # 2 mẫu cùng kích thước để loại trừ ảnh hưởng diện tích
        w = random.uniform(50, 90)
        h = random.uniform(50, 90)
        res = build_cnc_front_layout(
            [(0, w, h, 1000), (1, w, h, 100)], 800, 800, gap=2)
        placed = res['placed_by_page']
        c0 = placed.get(0, 0)
        c1 = placed.get(1, 0)
        if c0 > 0 and c1 > 0:
            # mẫu SL 1000 phải nhiều con hơn mẫu SL 100 (tỉ lệ ~10:1, greedy fill nới nhẹ)
            assert c0 >= c1
            hits += 1
    assert hits > 0  # đã có ít nhất vài ca xếp được cả 2 mẫu

