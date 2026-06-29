"""Property test (file-level): mọi trang đều được xử lý; trang no-op giữ nguyên.

Feature: channel-remover

Property 12 — All pages are processed; no-op pages preserved.
*For any* PDF nhiều trang (trộn các loại trang: trang có nội dung DeviceCMYK cần
biến đổi và trang chỉ có nội dung gray/không-CMYK không cần biến đổi), sau khi
``remove_channels`` chạy ở Direct_Removal_Mode:

  - File kết quả có ĐÚNG số trang như đầu vào (mọi trang đều có mặt — Req 11.3),
  - Trang CMYK: toán hạng của Removed_Channel trong toán tử ``k`` bị đưa về 0,
    còn Kept_Channel giữ nguyên giá trị gốc,
  - Trang no-op (gray-only / không CMYK): content stream được GIỮ NGUYÊN bytewise
    (Req 11.4) và trang vẫn xuất hiện trong file kết quả.

Cách kiểm chứng: Hypothesis chọn số trang / thứ tự / loại trang + tập kênh giữ.
Dựng PDF nhiều trang nhỏ bằng pikepdf trong file tạm, chạy ``remove_channels``
chế độ direct, mở lại output bằng pikepdf và khẳng định các bất biến trên.

Validates: Requirements 11.3, 11.4
"""
import os
import tempfile

import pikepdf
from hypothesis import HealthCheck, given, settings, strategies as st

from app.core.channel_remover import PROCESS_CHANNELS, remove_channels

_ALL_CHANNELS = list(PROCESS_CHANNELS)

# Sai số khi so sánh toán hạng đã định dạng lại (rstrip 6 chữ số thập phân).
_EPS = 1e-6

# Toán hạng màu PDF DeviceCMYK trên thang 0..1, dạng chuỗi cố định (round-trip
# parse chính xác, không chứa delimiter PDF). Gồm cả 0 và 1 ở hai biên.
_operand_str = st.sampled_from(
    ["0", "0.1", "0.25", "0.4", "0.5", "0.6", "0.75", "0.9", "1"]
)

# Nội dung trang gray-only (không có toán tử/màu CMYK) → trang no-op, phải được
# giữ nguyên bytewise sau khi gỡ kênh.
_GRAY_CONTENT = b"0.5 g\n0 0 100 100 re\nf\n"

# Spec một trang: ("cmyk", (c, m, y, k)) hoặc ("gray", None).
_cmyk_page = st.tuples(
    st.just("cmyk"),
    st.tuples(_operand_str, _operand_str, _operand_str, _operand_str),
)
_gray_page = st.tuples(st.just("gray"), st.none())
_page_spec = st.one_of(_cmyk_page, _gray_page)


def _cmyk_content(operands) -> bytes:
    """Content stream của một trang CMYK: '<c> <m> <y> <k> k' + một hình chữ nhật."""
    ops = " ".join(operands)
    return (f"{ops} k\n0 0 100 100 re\nf\n").encode("latin-1")


def _build_pdf(page_specs, path) -> list[bytes]:
    """Dựng PDF nhiều trang theo ``page_specs``; trả list content bytes gốc theo trang."""
    pdf = pikepdf.new()
    original_contents: list[bytes] = []
    for kind, operands in page_specs:
        if kind == "cmyk":
            content = _cmyk_content(operands)
        else:
            content = _GRAY_CONTENT
        original_contents.append(content)

        page = pdf.add_blank_page(page_size=(200, 200))
        page.Contents = pdf.make_stream(content)
        page.Resources = pikepdf.Dictionary()
    pdf.save(path)
    pdf.close()
    return original_contents


def _read_page_content(page) -> bytes:
    """Đọc & nối content stream (đã decode) của một trang (đồng bộ module core)."""
    contents = page.get("/Contents")
    if contents is None:
        return b""
    if isinstance(contents, pikepdf.Array):
        return b"\n".join(bytes(ref.read_bytes()) for ref in contents)
    return bytes(contents.read_bytes())


def _parse_k_operands(content: bytes):
    """Tìm toán tử ``k`` đầu tiên và trả 4 toán hạng (float) đứng trước nó."""
    for line in content.decode("latin-1").splitlines():
        toks = line.split()
        if len(toks) >= 5 and toks[-1] == "k":
            return [float(t) for t in toks[-5:-1]]
    return None


# Feature: channel-remover, Property 12: All pages are processed; no-op pages preserved
# For any PDF nhiều trang, phép gỡ kênh được áp cho mọi trang; với trang không
# chứa Process_Channel cần biến đổi, nội dung trang giữ nguyên và trang vẫn xuất
# hiện trong file kết quả.
# Validates: Requirements 11.3, 11.4
@settings(max_examples=100, deadline=None,
          suppress_health_check=[HealthCheck.too_slow])
@given(
    page_specs=st.lists(_page_spec, min_size=1, max_size=5),
    kept=st.lists(st.sampled_from(_ALL_CHANNELS), min_size=1, max_size=3,
                  unique=True),
)
def test_all_pages_processed_and_noop_pages_preserved(page_specs, kept):
    kept_indices = {PROCESS_CHANNELS.index(ch) for ch in kept}

    tmpdir = tempfile.mkdtemp(prefix="chrm_pages_")
    in_path = os.path.join(tmpdir, "in.pdf")
    out_path = os.path.join(tmpdir, "out.pdf")
    try:
        original_contents = _build_pdf(page_specs, in_path)

        report = remove_channels(in_path, out_path, {
            "kept_channels": list(kept),
            "mode": "direct",
        })

        assert report.output_filename == "out.pdf"
        assert os.path.isfile(out_path)

        with pikepdf.open(out_path) as out_pdf:
            # (Req 11.3) Mọi trang có mặt: số trang đầu ra == đầu vào.
            assert len(out_pdf.pages) == len(page_specs), (
                f"page count mismatch: got {len(out_pdf.pages)} "
                f"expected {len(page_specs)}"
            )

            for idx, ((kind, operands), original) in enumerate(
                zip(page_specs, original_contents)
            ):
                out_content = _read_page_content(out_pdf.pages[idx])

                if kind == "gray":
                    # (Req 11.4) Trang no-op giữ nguyên content bytewise.
                    assert out_content == original, (
                        f"trang gray #{idx} bị thay đổi: {out_content!r} "
                        f"!= {original!r}"
                    )
                    continue

                # Trang CMYK: toán hạng k được biến đổi đúng (direct removal).
                nums = _parse_k_operands(out_content)
                assert nums is not None, (
                    f"không tìm thấy toán tử k ở trang #{idx}: {out_content!r}"
                )
                src = [float(v) for v in operands]
                for i in range(4):
                    if i in kept_indices:
                        # Kept_Channel giữ nguyên giá trị gốc.
                        assert abs(nums[i] - src[i]) <= _EPS, (
                            f"trang #{idx} kênh giữ {i}: got {nums[i]} "
                            f"expected {src[i]}"
                        )
                    else:
                        # Removed_Channel bị đưa về 0.
                        assert abs(nums[i]) <= _EPS, (
                            f"trang #{idx} kênh bỏ {i} không bằng 0: {nums[i]}"
                        )
    finally:
        for p in (in_path, out_path):
            try:
                os.remove(p)
            except OSError:
                pass
        try:
            os.rmdir(tmpdir)
        except OSError:
            pass
