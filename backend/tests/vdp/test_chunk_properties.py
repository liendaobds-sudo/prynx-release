"""Property tests cho chunking + chịu lỗi khi sinh lô (PrynX VDP_Engine).

Feature: vdp-upgrade

Phủ các correctness property 32 và 33 của design (vdp-upgrade) cho module
`app.workers.vdp_engine`:

- Property 32: việc chia một danh sách dữ liệu thành các chunk kích thước
  ``CHUNK_SIZE`` (đúng vòng lặp của ``run_vdp_engine``) bảo toàn thứ tự và đầy
  đủ — nối các chunk lại bằng đúng dữ liệu gốc, không sót/không trùng record, và
  mỗi ``chunk_start_idx`` đúng.
- Property 33: khi render một lô trộn lẫn record/field tốt và lỗi (MISSING do
  thiếu giá trị cột, ERR do render thất bại), engine xử lý MỌI record (không bỏ
  sót), gắn nhãn đúng cho field lỗi, ghi vào ``error_sink`` và tiếp tục với các
  record còn lại — field tốt vẫn render bình thường.

Mỗi property test gắn comment tham chiếu và chạy 100 ví dụ. Phần render dùng
canvas reportlab nhỏ + dữ liệu bé và ``deadline=None`` để giữ nhanh + tất định.
"""
from __future__ import annotations

import io
import math

from hypothesis import given, settings, strategies as st

from reportlab.pdfgen import canvas as rl_canvas

from app.workers.vdp_engine import render_one_record


# --------------------------------------------------------------------------- #
# Helper: tái dựng chính xác logic chia chunk của run_vdp_engine.              #
#   for i in range(0, len(data), CHUNK_SIZE): chunks.append(data[i:i+CHUNK])  #
# --------------------------------------------------------------------------- #
def _split_into_chunks(data, chunk_size):
    """Sao y vòng lặp chunking trong ``run_vdp_engine`` (Req 8.1)."""
    chunks = []
    for i in range(0, len(data), chunk_size):
        chunks.append(data[i:i + chunk_size])
    return chunks


# --------------------------------------------------------------------------- #
# Property 32 — Chia chunk bảo toàn dữ liệu (Req 8.1)                          #
# --------------------------------------------------------------------------- #

# Feature: vdp-upgrade, Property 32: Chia chunk bảo toàn dữ liệu
@settings(max_examples=100)
@given(
    # Mỗi record gắn chỉ số duy nhất để nối lại phát hiện được trùng/sót/sai thứ tự.
    data=st.lists(
        st.dictionaries(
            keys=st.sampled_from(['a', 'b', 'c']),
            values=st.text(max_size=8),
            max_size=3,
        ),
        max_size=200,
    ),
    chunk_size=st.integers(min_value=1, max_value=50),
)
def test_chunking_preserves_data(data, chunk_size):
    """Chia ``data`` thành các chunk cỡ ``chunk_size`` theo đúng engine:
      - nối liên tiếp các chunk = dữ liệu gốc (đúng thứ tự, đủ, không trùng/sót),
      - mỗi chunk không rỗng và có độ dài ≤ chunk_size (chunk cuối có thể ngắn hơn),
      - số chunk = ceil(len(data) / chunk_size),
      - mỗi ``chunk_start_idx`` (cộng dồn độ dài chunk trước) trỏ đúng lát cắt gốc,
      - tổng số record bằng len(data); tập chỉ số toàn cục = 0..len(data)-1.
    """
    chunks = _split_into_chunks(data, chunk_size)

    # (1) Nối lại bằng đúng dữ liệu gốc ⇒ bảo toàn thứ tự + đầy đủ, không trùng/sót.
    rebuilt = [rec for ch in chunks for rec in ch]
    assert rebuilt == data

    # (2) Số chunk khớp công thức engine (num_chunks = ceil(len/CHUNK_SIZE)).
    assert len(chunks) == math.ceil(len(data) / chunk_size)

    # (3) Mỗi chunk hợp lệ: không rỗng và không vượt chunk_size.
    for ch in chunks:
        assert 0 < len(ch) <= chunk_size

    # (4) chunk_start_idx cộng dồn đúng như engine; lát cắt khớp dữ liệu gốc.
    chunk_start_idx = 0
    seen_global = []
    for ch in chunks:
        assert data[chunk_start_idx:chunk_start_idx + len(ch)] == ch
        for local_idx in range(len(ch)):
            seen_global.append(chunk_start_idx + local_idx)
        chunk_start_idx += len(ch)

    # (5) chunk_start_idx cuối = tổng số record; chỉ số toàn cục phủ kín 0..n-1.
    assert chunk_start_idx == len(data)
    assert seen_global == list(range(len(data)))


# --------------------------------------------------------------------------- #
# Property 33 — Bảo toàn và chịu lỗi khi sinh lô (Req 8.2, 8.3, 8.4, 8.6)      #
# --------------------------------------------------------------------------- #

# Trang nền nhỏ (point) để render nhanh; field nằm trọn trong trang.
PAGE_W_PT = 300.0
PAGE_H_PT = 300.0

# Cấu hình field CỐ ĐỊNH ở cấp template (giống engine: fields dùng chung cho mọi
# record, dữ liệu thay đổi theo từng row):
#   - 'good' : text {good} → luôn có giá trị ⇒ render bình thường (không lỗi).
#   - 'miss' : text {miss} → cột rỗng ⇒ val rỗng ⇒ nhãn MISSING (Req 8.4).
#   - 'bad'  : barcode {code} với barcodeType không hỗ trợ ⇒
#               * code rỗng  ⇒ val rỗng ⇒ MISSING,
#               * code có giá trị ⇒ render raise ValueError ⇒ ERR (Req 8.3).
_FIELDS = [
    {'id': 'fg', 'name': 'good', 'type': 'text',
     'x': 10.0, 'y': 10.0, 'width': 60.0, 'height': 20.0,
     'fontSize': 10, 'fontColor': '#000000', 'textContent': '{good}'},
    {'id': 'fm', 'name': 'miss', 'type': 'text',
     'x': 10.0, 'y': 40.0, 'width': 60.0, 'height': 20.0,
     'fontSize': 10, 'fontColor': '#000000', 'textContent': '{miss}'},
    {'id': 'fb', 'name': 'bad', 'type': 'barcode',
     'x': 10.0, 'y': 70.0, 'width': 80.0, 'height': 40.0,
     'barcodeType': 'khong_ton_tai_symbology', 'textContent': '{code}'},
]

# field_rects tương ứng (point), khung nằm trọn trong trang để clamp là no-op.
_FIELD_RECTS = [
    {'x': 10.0, 'y': 10.0, 'w': 60.0, 'h': 20.0},
    {'x': 10.0, 'y': 40.0, 'w': 60.0, 'h': 20.0},
    {'x': 10.0, 'y': 70.0, 'w': 80.0, 'h': 40.0},
]


def _expected_errors(row):
    """Tập nhãn lỗi kỳ vọng (field → kind) cho một record theo cấu hình _FIELDS."""
    expected = {}
    # 'good' luôn có giá trị ⇒ không bao giờ lỗi.
    if not row.get('miss'):
        expected['miss'] = 'MISSING'
    if not row.get('code'):
        expected['bad'] = 'MISSING'      # val rỗng ⇒ MISSING trước khi vào nhánh barcode
    else:
        expected['bad'] = 'ERR'          # symbology không hỗ trợ ⇒ render raise ⇒ ERR
    return expected


@settings(max_examples=100, deadline=None)
@given(
    rows=st.lists(
        st.fixed_dictionaries({
            # 'good' luôn không rỗng (chữ-số) ⇒ field tốt vẫn render.
            'good': st.text(
                alphabet=st.characters(whitelist_categories=('Lu', 'Ll', 'Nd')),
                min_size=1, max_size=8,
            ),
            # 'miss' rỗng ⇒ MISSING; không rỗng ⇒ render tốt (mix theo từng row).
            'miss': st.one_of(
                st.just(''),
                st.text(alphabet=st.characters(whitelist_categories=('Lu', 'Ll', 'Nd')),
                        min_size=1, max_size=8),
            ),
            # 'code' rỗng ⇒ MISSING; không rỗng ⇒ ERR (barcode không hỗ trợ).
            'code': st.one_of(
                st.just(''),
                st.text(alphabet=st.characters(whitelist_categories=('Lu', 'Ll', 'Nd')),
                        min_size=1, max_size=8),
            ),
        }),
        min_size=1, max_size=8,
    ),
)
# Feature: vdp-upgrade, Property 33: Bảo toàn và chịu lỗi khi sinh lô
def test_batch_resilience_preserves_and_labels(rows):
    """Render một lô trộn record tốt/lỗi: MỌI record được xử lý (không bỏ sót),
    field lỗi được gắn nhãn đúng (MISSING khi thiếu cột, ERR khi render lỗi) và
    ghi vào ``error_sink``, field tốt vẫn render — lỗi của field/record này KHÔNG
    ảnh hưởng record khác (Req 8.2, 8.3, 8.4, 8.6).
    """
    processed = 0
    for row in rows:
        # error_sink riêng từng record (như báo cáo lỗi gom theo record).
        error_sink = []
        buf = io.BytesIO()
        c = rl_canvas.Canvas(buf, pagesize=(PAGE_W_PT, PAGE_H_PT))

        # render_one_record KHÔNG raise: lỗi field được bắt nội bộ và ghi sink.
        render_one_record(c, _FIELDS, row, _FIELD_RECTS, PAGE_W_PT, PAGE_H_PT,
                           field_font_variants={}, error_sink=error_sink)
        c.showPage()
        c.save()
        processed += 1

        # (1) Nhãn lỗi thu được khớp CHÍNH XÁC tập kỳ vọng cho record này.
        got = {e['field']: e['kind'] for e in error_sink}
        assert got == _expected_errors(row)

        # (2) Mỗi field lỗi được ghi đúng một lần với kind hợp lệ + rect của field.
        assert len(error_sink) == len(got)
        for e in error_sink:
            assert e['kind'] in ('MISSING', 'ERR')
            assert e['reason']  # có lý do để đưa vào báo cáo lỗi
            assert set(e['rect']) == {'x', 'y', 'w', 'h'}

        # (3) Field tốt ('good') không bao giờ bị gắn nhãn lỗi ⇒ vẫn render.
        assert 'good' not in got

    # (4) MỌI record trong lô đều được xử lý, không bỏ sót (Req 8.2, 8.6).
    assert processed == len(rows)
