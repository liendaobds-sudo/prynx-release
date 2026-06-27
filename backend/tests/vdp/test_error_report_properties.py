"""Property tests cho báo cáo lỗi CSV (VDP_Engine của PrynX).

Feature: vdp-upgrade

Mỗi property test gắn comment tham chiếu và chạy >= 100 ví dụ.
Targets: app.workers.vdp_validate
    (build_error_report_csv, parse_error_report_csv, Issue).
"""
from __future__ import annotations

from hypothesis import given, settings, strategies as st

from app.workers.vdp_validate import (
    Issue,
    _issue_fields,
    build_error_report_csv,
    parse_error_report_csv,
)


# ─── Generators ──────────────────────────────────────────────────────────────

# Ký tự tiếng Việt có dấu để bảo đảm round-trip giữ nguyên Unicode.
_VIET = "ăâđêôơưáàảãạéèẻẽẹíìỉĩịóòỏõọúùủũụýỳỷỹỵ"

# Các chunk văn bản cố ý chèn dấu phẩy, dấu nháy, xuống dòng, tab… để ép CSV
# phải trích dẫn đúng và round-trip qua được. Loại trừ \r và NUL vì chúng gây
# nhập nhằng newline / lỗi reader (không nằm trong phạm vi Req 4.7).
_general = st.text(
    alphabet=st.characters(blacklist_characters="\r\x00", blacklist_categories=("Cs",)),
    max_size=8,
)
_specials = st.sampled_from([",", '"', "\n", ";", "\t", "  ", "'", "{Cot}"])
_chunk = st.one_of(_general, st.sampled_from(list(_VIET)), _specials)

# Chuỗi tổng hợp dùng cho ``field`` và ``reason`` (gồm tiếng Việt + ký tự đặc biệt).
_blob = st.lists(_chunk, max_size=6).map("".join)

# Chỉ số record: None (lỗi cấu hình toàn cục) hoặc số nguyên không âm.
_rec_idx = st.one_of(st.none(), st.integers(min_value=0, max_value=10**6))


@st.composite
def _issues(draw):
    """Sinh danh sách issue trộn ``Issue`` và dict, gồm cả record_idx/field None."""
    n = draw(st.integers(min_value=0, max_value=8))
    out = []
    for _ in range(n):
        rec = draw(_rec_idx)
        field = draw(st.one_of(st.none(), _blob))
        reason = draw(st.one_of(st.none(), _blob))
        if draw(st.booleans()):
            out.append({"record_idx": rec, "field": field, "reason": reason})
        else:
            sev = draw(st.sampled_from(["error", "warning"]))
            out.append(Issue(severity=sev, record_idx=rec, field=field, reason=reason))
    return out


def _expected_record(issue):
    """Bản ghi logic kỳ vọng sau round-trip, theo đúng quy ước build/parse.

    - ``record_idx``: int hoặc None.
    - ``field``: ô rỗng (None hoặc chuỗi rỗng) ⇒ None; còn lại giữ nguyên chuỗi.
    - ``reason``: luôn là chuỗi (None ⇒ "").
    """
    rec, field, reason = _issue_fields(issue)
    return {
        "record_idx": rec,
        "field": None if (field is None or field == "") else field,
        "reason": reason,
    }


# Feature: vdp-upgrade, Property 23: Báo cáo lỗi CSV round-trip
@settings(max_examples=100)
@given(issues=_issues())
def test_property23_error_report_csv_round_trip(issues):
    csv_text = build_error_report_csv(issues)
    parsed = parse_error_report_csv(csv_text)

    # Danh sách rỗng ⇒ sentinel "không phát hiện lỗi" ⇒ parse lại ra [].
    if not issues:
        assert parsed == []
        return

    expected = [_expected_record(i) for i in issues]

    # Đúng một dòng cho mỗi issue, và mỗi bản ghi logic được phục hồi nguyên vẹn
    # (chỉ số dòng record / field / lý do), kể cả tiếng Việt, dấu phẩy, dấu nháy
    # và ký tự xuống dòng nhúng.
    assert len(parsed) == len(issues)
    assert parsed == expected
