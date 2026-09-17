"""Validator — kiểm tra cấu hình field và dữ liệu TRƯỚC khi sinh lô VDP.

Module này là một pass thuần dữ liệu chạy trước ``process_chunk``: nó CHỈ trả về
tập ``Issue`` (lỗi/cảnh báo) và KHÔNG sinh bất kỳ trang PDF nào (Req 5.7). Nhờ đó
phần lõi (trừ phần đọc ảnh từ đĩa) dễ kiểm thử bằng property-based testing.

Nội dung kiểm tra (Req 5.1–5.11):
- Mọi placeholder/field tham chiếu đến cột TỒN TẠI trong nguồn dữ liệu
  (cột thiếu ⇒ LỖI mức chặn, nêu tên cột + field) — Req 5.1, 5.2.
- Field ảnh biến đổi có file ảnh tồn tại cho TOÀN BỘ record (không lấy mẫu);
  thiếu file ⇒ CẢNH BÁO nêu chỉ số record + đường dẫn ảnh — Req 5.3, 5.4.
- Giá trị mỗi field barcode hợp lệ với symbology của field: EAN13 đủ 13 chữ số,
  EAN8 đủ 8 chữ số, GS1 AI đúng định dạng; sai ⇒ LỖI nêu chỉ số record + field +
  lý do — Req 5.5, 5.6.
- Nguồn chưa nạp / 0 record ⇒ LỖI mức chặn — Req 5.8, 5.11.

``gating_state(issues)`` quy các issue thành quyết định cổng:
- ``block``              khi có ≥1 lỗi (Req 5.8).
- ``needs_confirmation`` khi chỉ có cảnh báo, không có lỗi (Req 5.9).
- ``allow``              khi không có lỗi và không có cảnh báo (Req 5.10).

Module giữ "thuần" ở mức import: phần phụ thuộc ReportLab (qua ``_substitute`` của
``vdp_engine``) và truy cập đĩa cho ảnh được nạp trễ (lazy import) bên trong hàm,
tương tự ``vdp_conditions``.
"""

from __future__ import annotations

import csv
import io
import os
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple, Union

from app.workers.vdp_conditions import (
    ConditionError,
    _parse_conditional,
    resolve_field_content,
)
from app.workers.vdp_gs1 import GS1Error, parse_gs1

# ─── Issue & gating ──────────────────────────────────────────────────────────


@dataclass
class Issue:
    """Một phát hiện của Validator (Req 5.2, 5.4, 5.6).

    Attributes:
        severity:   ``'error'`` (chặn sinh lô) hoặc ``'warning'`` (cần xác nhận).
        record_idx: Chỉ số dòng record liên quan (0-based); ``None`` cho lỗi cấu
            hình toàn cục (vd cột thiếu, nguồn 0 record).
        field:      Tên field liên quan; ``None`` cho lỗi không gắn field cụ thể.
        reason:     Lý do dạng tiếng Việt để hiển thị cho người dùng.
    """

    severity: str
    record_idx: Optional[int]
    field: Optional[str]
    reason: str


def gating_state(issues: Sequence[Issue]) -> str:
    """Quy tập issue thành quyết định cổng trước khi sinh lô (Req 5.8, 5.9, 5.10).

    - ``block``              ⇔ tồn tại issue mức ``error``.
    - ``needs_confirmation`` ⇔ có ``warning`` nhưng không có ``error``.
    - ``allow``              ⇔ không có issue nào.
    """
    has_error = any(i.severity == "error" for i in issues)
    if has_error:
        return "block"
    has_warning = any(i.severity == "warning" for i in issues)
    if has_warning:
        return "needs_confirmation"
    return "allow"


# ─── Trợ giúp truy xuất field (dict hoặc VdpField pydantic) ───────────────────


def _field_get(field: Union[Mapping[str, Any], object], key: str, default: Any = None) -> Any:
    if isinstance(field, Mapping):
        return field.get(key, default)
    return getattr(field, key, default)


# ─── Trích xuất cột được tham chiếu trong nội dung field ─────────────────────

# Bản sao cú pháp placeholder của ``vdp_engine._TOKEN_RE`` dùng để TRÍCH tên cột
# mà không phải import ``vdp_engine`` (kéo theo ReportLab) ở mức module. Group 1
# luôn là tên cột (vd ``{Cot}``, ``{Cot[2|-]}``, ``{Cot|func:arg}`` → ``Cot``).
_PLACEHOLDER_RE = re.compile(
    r"\{([^{}|\[\]]+)(?:\[(\d+)(?:\|([^\]]*))?\])?(?:\|([a-zA-Z]+)(?::([^}]*))?)?\}"
)


def _extract_referenced_columns(text: Optional[str]) -> set[str]:
    """Trích tập cột được tham chiếu trong ``text`` (placeholder + token điều kiện).

    - Token điều kiện nội tuyến ``{Cot?A:B}`` chỉ tham chiếu cột ``Cot``; các
      nhánh ``A``/``B`` là VĂN BẢN LITERAL nên KHÔNG quét đệ quy (Req 2.3, 2.4).
    - Placeholder thường ``{Cot}``, ``{Cot[2|-]}``, ``{Cot|func:arg}`` tham chiếu
      cột ở group 1 của :data:`_PLACEHOLDER_RE`.
    """
    cols: set[str] = set()
    if not text:
        return cols

    residual: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "{":
            parsed = _parse_conditional(text, i)
            if parsed is not None:
                column, _branch_a, _branch_b, end = parsed
                cols.add(column)
                i = end  # bỏ qua token điều kiện (nhánh là literal, không quét)
                continue
        residual.append(ch)
        i += 1

    for m in _PLACEHOLDER_RE.finditer("".join(residual)):
        cols.add(m.group(1))
    return cols


def _collect_field_columns(field: Union[Mapping[str, Any], object]) -> set[str]:
    """Tập mọi cột mà một field tham chiếu (nội dung, điều kiện, rule) — Req 5.1.

    - ``textContent``: trích placeholder + token điều kiện.
    - Khi ``textContent`` rỗng và field KHÔNG phải ảnh: engine dùng mặc định
      ``{name}`` nên field tham chiếu ngầm cột trùng tên field.
    - Mỗi điều kiện ẩn/hiện và mỗi rule tham chiếu cột ``column``.
    - ``rule.result`` là nội dung thay thế nên cũng có thể chứa placeholder.
    """
    cols: set[str] = set()

    ftype = (_field_get(field, "type", "") or "").lower()
    text = _field_get(field, "textContent", None)
    if text:
        extracted = _extract_referenced_columns(text)
        if extracted:
            cols |= extracted
        elif ftype != "image":
            name = _field_get(field, "name", None)
            if name:
                cols.add(str(name))
    elif ftype != "image":
        # Field động không có textContent ⇒ ngầm dùng cột trùng tên field.
        name = _field_get(field, "name", None)
        if name:
            cols.add(str(name))

    for cond in _field_get(field, "conditions", None) or []:
        col = _field_get(cond, "column", None)
        if col:
            cols.add(str(col))

    for rule in _field_get(field, "rules", None) or []:
        col = _field_get(rule, "column", None)
        if col:
            cols.add(str(col))
        cols |= _extract_referenced_columns(_field_get(rule, "result", None))

    return cols


# ─── Kiểm tra giá trị barcode theo symbology ─────────────────────────────────

_EAN13_RE = re.compile(r"^\d{13}$")
_EAN8_RE = re.compile(r"^\d{8}$")

# Các symbology GS1 cần parse Application Identifier (Req 5.5).
_GS1_TYPES: frozenset[str] = frozenset(
    {
        "gs1-128", "gs1128", "gs1_128",
        "gs1-datamatrix", "gs1datamatrix", "gs1_datamatrix", "gs1-dm",
    }
)


def _barcode_symbology(field: Union[Mapping[str, Any], object]) -> str:
    """Loại barcode hiệu lực: ưu tiên ``barcodeType`` rồi ``barType`` (lowercase)."""
    return (
        _field_get(field, "barcodeType", None)
        or _field_get(field, "barType", None)
        or ""
    ).lower()


def _barcode_value_error(symbology: str, value: str) -> Optional[str]:
    """Trả lý do (tiếng Việt) nếu ``value`` KHÔNG hợp lệ với ``symbology``, else None.

    Chỉ ràng buộc các symbology mà Req 5.5 yêu cầu kiểm: EAN13 (13 chữ số),
    EAN8 (8 chữ số), và GS1 AI (parse_gs1 phải thành công). Các symbology khác
    không bị ràng buộc ở bước validate.
    """
    s = str(value)
    if symbology == "ean13":
        if not _EAN13_RE.match(s):
            return f"EAN13 cần đúng 13 chữ số, nhận {s!r}"
        return None
    if symbology == "ean8":
        if not _EAN8_RE.match(s):
            return f"EAN8 cần đúng 8 chữ số, nhận {s!r}"
        return None
    if symbology in _GS1_TYPES:
        try:
            parse_gs1(s)
        except GS1Error as exc:
            return f"GS1 AI không hợp lệ: {exc.message}"
        except ValueError as exc:
            return f"GS1 AI không hợp lệ: {exc}"
        return None
    return None


# ─── Trợ giúp giải nội dung field cho một record (parity với engine) ─────────


def _resolved_value(field: Union[Mapping[str, Any], object], row: Mapping[str, object]):
    """Giải nội dung field cho một record dùng CHUNG ``resolve_field_content``.

    Trả ``(visible, content)``. ``visible=False`` ⇒ field bị ẩn cho record này
    (bỏ qua kiểm tra giá trị/ảnh). Có thể raise ``ConditionError`` nếu điều kiện/
    rule tham chiếu cột không tồn tại — caller đã loại field như vậy trước đó.
    """
    resolved = resolve_field_content(field, row)
    return resolved.visible, resolved.content


# ─── Hàm validate chính ──────────────────────────────────────────────────────


def validate_batch(
    fields: Sequence[Union[Mapping[str, Any], object]],
    table: Optional[object],
) -> List[Issue]:
    """Kiểm tra cấu hình field + dữ liệu, trả về tập ``Issue`` (Req 5.1–5.11).

    KHÔNG sinh bất kỳ trang nào (Req 5.7). Caller dùng :func:`gating_state` để
    quyết định chặn / yêu cầu xác nhận / cho phép sinh lô.

    Args:
        fields: Danh sách field (dict hoặc ``VdpField``).
        table:  ``RecordTable`` (có ``columns`` và ``rows``) hoặc ``None`` khi
            nguồn chưa được nạp.

    Returns:
        Danh sách ``Issue`` (có thể rỗng). Thứ tự: lỗi nguồn (nếu có) → theo field.
    """
    issues: List[Issue] = []

    # (A) Nguồn chưa nạp / 0 record ⇒ LỖI mức chặn (Req 5.8, 5.11).
    if table is None:
        issues.append(
            Issue(
                severity="error",
                record_idx=None,
                field=None,
                reason="Nguồn dữ liệu chưa được nạp (chưa có bảng record).",
            )
        )
        return issues

    columns = set(getattr(table, "columns", []) or [])
    rows = list(getattr(table, "rows", []) or [])
    if not rows:
        issues.append(
            Issue(
                severity="error",
                record_idx=None,
                field=None,
                reason="Nguồn dữ liệu có 0 record; không thể sinh lô.",
            )
        )
        # Vẫn tiếp tục kiểm cột tham chiếu (nếu có header) để báo thêm lỗi cấu hình.

    for field in fields:
        fname = _field_get(field, "name", None)
        ftype = (_field_get(field, "type", "") or "").lower()

        # (B) Cột tham chiếu tồn tại — LỖI mức chặn (Req 5.1, 5.2).
        referenced = _collect_field_columns(field)
        missing_cols = sorted(c for c in referenced if c not in columns)
        for col in missing_cols:
            issues.append(
                Issue(
                    severity="error",
                    record_idx=None,
                    field=fname,
                    reason=f"Cột {col!r} được tham chiếu nhưng không tồn tại trong nguồn dữ liệu.",
                )
            )

        # Không có record để duyệt, hoặc field thiếu cột ⇒ bỏ kiểm tra theo record
        # (tránh lỗi dây chuyền/giải nội dung không tin cậy).
        if not rows or missing_cols:
            continue

        # (C) Field ảnh biến đổi: kiểm file ảnh cho TOÀN BỘ record (Req 5.3, 5.4).
        if ftype == "image":
            _validate_image_field(field, fname, rows, issues)
            continue

        # (D) Field barcode: kiểm giá trị theo symbology cho TỪNG record (Req 5.5, 5.6).
        if ftype == "barcode":
            symbology = _barcode_symbology(field)
            # Chỉ kiểm các symbology có ràng buộc; bỏ qua nếu không ràng buộc.
            if symbology != "ean13" and symbology != "ean8" and symbology not in _GS1_TYPES:
                continue
            _validate_barcode_field(field, fname, symbology, rows, issues)

    return issues


def _validate_image_field(
    field: Union[Mapping[str, Any], object],
    fname: Optional[str],
    rows: Sequence[Mapping[str, object]],
    issues: List[Issue],
) -> None:
    """Kiểm file ảnh tồn tại cho mọi record của một field ảnh (Req 5.3, 5.4)."""
    # Nạp trễ resolver đường dẫn ảnh (ở vdp_engine, kéo theo ReportLab).
    from app.workers.vdp_engine import _resolve_image_path  # noqa: PLC0415

    base_dir = _field_get(field, "imageBaseDir", None)
    static_path = _field_get(field, "imagePath", None)

    for idx, row in enumerate(rows):
        try:
            visible, content = _resolved_value(field, row)
        except ConditionError as exc:
            # Cột thiếu lẽ ra đã bị loại ở (B); phòng hờ vẫn ghi nhận.
            issues.append(
                Issue(severity="error", record_idx=idx, field=fname, reason=exc.reason)
            )
            continue
        if not visible:
            continue

        img_path = _resolve_image_path(str(content) if content else "", base_dir, static_path)
        if not img_path or not os.path.exists(img_path):
            shown = str(content).strip() if content else (static_path or "")
            issues.append(
                Issue(
                    severity="warning",
                    record_idx=idx,
                    field=fname,
                    reason=f"Không tìm thấy file ảnh cho record {idx}: {shown!r}",
                )
            )


def _validate_barcode_field(
    field: Union[Mapping[str, Any], object],
    fname: Optional[str],
    symbology: str,
    rows: Sequence[Mapping[str, object]],
    issues: List[Issue],
) -> None:
    """Kiểm giá trị barcode theo symbology cho mọi record (Req 5.5, 5.6)."""
    for idx, row in enumerate(rows):
        try:
            visible, content = _resolved_value(field, row)
        except ConditionError as exc:
            issues.append(
                Issue(severity="error", record_idx=idx, field=fname, reason=exc.reason)
            )
            continue
        if not visible:
            continue

        reason = _barcode_value_error(symbology, content)
        if reason is not None:
            issues.append(
                Issue(severity="error", record_idx=idx, field=fname, reason=reason)
            )


# ─── Sinh báo cáo lỗi CSV (Req 4.7, 4.8) ─────────────────────────────────────

# Header CSV của báo cáo lỗi (tiếng Việt). Mỗi dòng dữ liệu gồm đúng 3 cột theo
# Req 4.7: chỉ số dòng record, tên field liên quan, lý do.
ERROR_REPORT_HEADER: Tuple[str, str, str] = ("Dòng record", "Field", "Lý do")

# Dòng thông báo khi KHÔNG có record lỗi nào (Req 4.8). Được ghi như một CSV
# một-cột để báo cáo vẫn là tệp CSV hợp lệ, và :func:`parse_error_report_csv`
# nhận diện được sentinel này để phục hồi tập issue rỗng.
NO_ERRORS_MESSAGE: str = "Không phát hiện lỗi trong dữ liệu."


def _issue_fields(
    issue: Union[Issue, Mapping[str, Any], object],
) -> Tuple[Optional[int], Optional[str], str]:
    """Trích ``(record_idx, field, reason)`` từ một issue (Issue / dict / object).

    Chấp nhận cả ``Issue`` của :func:`validate_batch`, dict có khoá
    ``record_idx``/``field``/``reason``, hoặc object bất kỳ có các thuộc tính
    cùng tên. ``reason`` luôn được ép về ``str``.
    """
    if isinstance(issue, Issue):
        rec_idx, field, reason = issue.record_idx, issue.field, issue.reason
    elif isinstance(issue, Mapping):
        rec_idx = issue.get("record_idx")
        field = issue.get("field")
        reason = issue.get("reason", "")
    else:
        rec_idx = getattr(issue, "record_idx", None)
        field = getattr(issue, "field", None)
        reason = getattr(issue, "reason", "")

    rec_out = rec_idx if rec_idx is None else int(rec_idx)
    field_out = field if field is None else str(field)
    return rec_out, field_out, "" if reason is None else str(reason)


def build_error_report_csv(
    issues: Sequence[Union[Issue, Mapping[str, Any], object]],
) -> str:
    """Sinh nội dung CSV báo cáo lỗi cho các record MISSING/ERR (Req 4.7, 4.8).

    Mỗi issue trong ``issues`` sinh ĐÚNG một dòng gồm chỉ số dòng record, tên
    field và lý do (Req 4.7). Khi ``issues`` rỗng, báo cáo chứa một dòng thông
    báo không phát hiện lỗi (Req 4.8).

    CSV được sinh bằng module ``csv`` chuẩn (có trích dẫn đúng cho dấu phẩy,
    xuống dòng, dấu nháy…), đảm bảo round-trip được qua
    :func:`parse_error_report_csv` (kể cả tiếng Việt có dấu).

    Args:
        issues: Danh sách issue (``Issue`` từ :func:`validate_batch`, hoặc dict/
            object có ``record_idx``/``field``/``reason``).

    Returns:
        Chuỗi nội dung CSV (dùng ``\\n`` làm ký tự xuống dòng).
    """
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")

    if not issues:
        writer.writerow([NO_ERRORS_MESSAGE])
        return buf.getvalue()

    writer.writerow(list(ERROR_REPORT_HEADER))
    for issue in issues:
        rec_idx, field, reason = _issue_fields(issue)
        writer.writerow(
            [
                "" if rec_idx is None else str(rec_idx),
                "" if field is None else field,
                reason,
            ]
        )
    return buf.getvalue()


def parse_error_report_csv(text: str) -> List[Dict[str, Any]]:
    """Đọc lại báo cáo lỗi CSV → danh sách dict ``{record_idx, field, reason}``.

    Hàm nghịch đảo của :func:`build_error_report_csv` phục vụ round-trip
    (Property 23). Nhận diện sentinel "không phát hiện lỗi" và trả về danh sách
    rỗng trong trường hợp đó.

    Quy ước round-trip:
    - Ô ``record_idx`` rỗng ⇒ ``None``; ngược lại ép về ``int``.
    - Ô ``field`` rỗng ⇒ ``None``; ngược lại giữ nguyên chuỗi.
    - ``reason`` giữ nguyên chuỗi.
    """
    reader = csv.reader(io.StringIO(text))
    rows = [row for row in reader]
    if not rows:
        return []

    # Sentinel "không có lỗi": đúng một dòng, một cột, đúng thông báo (Req 4.8).
    if len(rows) == 1 and len(rows[0]) == 1 and rows[0][0] == NO_ERRORS_MESSAGE:
        return []

    out: List[Dict[str, Any]] = []
    for row in rows[1:]:  # bỏ dòng header
        if not row:
            continue
        rec_raw = row[0] if len(row) > 0 else ""
        field_raw = row[1] if len(row) > 1 else ""
        reason_raw = row[2] if len(row) > 2 else ""
        out.append(
            {
                "record_idx": None if rec_raw == "" else int(rec_raw),
                "field": None if field_raw == "" else field_raw,
                "reason": reason_raw,
            }
        )
    return out
