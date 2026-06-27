"""Property tests cho Validator (VDP_Engine của PrynX).

Feature: vdp-upgrade

Mỗi property test gắn comment tham chiếu và chạy >= 100 ví dụ.
Targets: app.workers.vdp_validate (validate_batch, gating_state, Issue)
và app.workers.vdp_datasource.RecordTable.
"""
from __future__ import annotations

import os
import re
import tempfile

from hypothesis import given, settings, strategies as st

from app.workers.vdp_datasource import RecordTable
from app.workers.vdp_validate import Issue, gating_state, validate_batch


# Pool tên cột ASCII đơn giản dùng cho các property tham chiếu cột.
_COLPOOL = ["A", "B", "Code", "Status", "Ten", "Gia"]


# Feature: vdp-upgrade, Property 27: Validate cột tham chiếu tồn tại
@settings(max_examples=100)
@given(
    existing=st.lists(st.sampled_from(_COLPOOL), min_size=0, max_size=6, unique=True),
    ref=st.sampled_from(_COLPOOL),
)
def test_property27_validate_referenced_column_exists(existing, ref):
    columns = list(existing)
    row = {c: "x" for c in columns}
    table = RecordTable(columns=columns, rows=[row])
    # Field text tham chiếu tường minh cột ``ref`` qua placeholder.
    field = {"name": "f1", "type": "text", "textContent": "{" + ref + "}"}

    issues = validate_batch([field], table)
    missing_for_field = [
        i
        for i in issues
        if i.severity == "error" and i.record_idx is None and i.field == "f1"
    ]

    if ref not in columns:
        # Cột thiếu ⇒ phải có lỗi nêu đúng tên cột thiếu.
        assert any(repr(ref) in i.reason for i in missing_for_field)
    else:
        # Mọi cột tham chiếu tồn tại ⇒ không có lỗi cột-thiếu nào cho cột này.
        assert all(repr(ref) not in i.reason for i in issues)


# Feature: vdp-upgrade, Property 28: Kiểm tra ảnh biến đổi trên TOÀN BỘ record
@settings(max_examples=100)
@given(
    filenames=st.lists(
        st.text(alphabet="abcdefABCDEF0123456789", min_size=1, max_size=8),
        min_size=1,
        max_size=6,
    )
)
def test_property28_image_validation_checks_every_record(filenames):
    # Base dir chắc chắn KHÔNG tồn tại để os.path.exists luôn False (deterministic).
    base_dir = os.path.join(
        tempfile.gettempdir(), "___vdp_no_such_dir___", "deeper_missing"
    )
    # Tên file có tiền tố độc nhất ⇒ không trùng file thật trong cwd.
    rows = [{"img": "___vdp_missing___" + fn + ".png"} for fn in filenames]
    columns = ["img"]
    table = RecordTable(columns=columns, rows=rows)
    field = {
        "name": "pic",
        "type": "image",
        "textContent": "{img}",
        "imageBaseDir": base_dir,
        "imagePath": None,
    }

    issues = validate_batch([field], table)
    warnings = [i for i in issues if i.severity == "warning"]

    # Quét TOÀN BỘ record (không lấy mẫu): đúng một cảnh báo cho mỗi record.
    assert len(warnings) == len(rows)
    assert {i.record_idx for i in warnings} == set(range(len(rows)))
    assert all(i.field == "pic" for i in warnings)
    # Không phát sinh lỗi (chỉ là cảnh báo ảnh thiếu).
    assert not any(i.severity == "error" for i in issues)


# Feature: vdp-upgrade, Property 29: Validate giá trị barcode theo symbology
@settings(max_examples=100)
@given(
    symbology=st.sampled_from(["ean13", "ean8"]),
    values=st.lists(
        st.one_of(
            st.text(alphabet="0123456789", min_size=0, max_size=15),
            st.text(alphabet="ABCxyz0123456789", min_size=1, max_size=15),
        ),
        min_size=1,
        max_size=6,
    ),
)
def test_property29_barcode_value_matches_symbology(symbology, values):
    pattern = r"\d{13}" if symbology == "ean13" else r"\d{8}"
    columns = ["code"]
    rows = [{"code": v} for v in values]
    table = RecordTable(columns=columns, rows=rows)
    field = {
        "name": "bc",
        "type": "barcode",
        "barcodeType": symbology,
        "textContent": "{code}",
    }

    issues = validate_batch([field], table)
    error_indices = {i.record_idx for i in issues if i.severity == "error"}

    for idx, val in enumerate(values):
        valid = re.fullmatch(pattern, val) is not None
        if valid:
            assert idx not in error_indices
        else:
            assert idx in error_indices

    assert all(i.field == "bc" for i in issues if i.severity == "error")


# Feature: vdp-upgrade, Property 30: Quyết định cổng (gating) trước khi sinh lô
@settings(max_examples=100)
@given(
    severities=st.lists(
        st.sampled_from(["error", "warning"]), min_size=0, max_size=10
    )
)
def test_property30_gating_state_from_issues(severities):
    issues = [
        Issue(severity=s, record_idx=None, field=None, reason="r") for s in severities
    ]
    state = gating_state(issues)

    if any(s == "error" for s in severities):
        assert state == "block"
    elif any(s == "warning" for s in severities):
        assert state == "needs_confirmation"
    else:
        assert state == "allow"
