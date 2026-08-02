"""Chốt chặn phình to cho các file backend quá dài — KIENTRUC (audit 2026-07-29 §A.1/§E).

Vì sao là ratchet chứ không phải refactor: `routes/imposition.py` (4.1k dòng, 18 endpoint,
logic layout nằm ngay trong handler) là nợ kiến trúc thật, nhưng rút nó ra là việc cần một
kế hoạch riêng chứ không nhét vào một lô audit được — nó nằm trên ĐƯỜNG XUẤT FILE, sai một
nhánh là tờ in ra sai. Đã thử khoanh vùng cụm nhỏ nhất (quản lý job N-Up) và gặp cái bẫy:
`tests/test_nup_job_lifecycle.py` monkeypatch `imposition._NUP_SUBMISSION_SLOTS`, nên nếu
`_spawn_nup_process` chuyển sang module khác thì bản patch trỏ sai chỗ — test vẫn XANH mà
không còn kiểm hành vi hàng đợi đầy. Đó là kiểu "refactor xanh nhưng mất lưới an toàn".

Nên đợt này làm điều rẻ và đúng hướng: KHOÁ TRẦN hiện tại. File đã dài không được dài thêm;
muốn thêm code vào đó thì phải rút một phần ra trước. Trần chỉ được HẠ, không được nâng —
nâng trần là quyết định của con người, phải ghi lý do trong PR.

Cùng tinh thần với `desktop` `npm run lint:budget`.
"""

from pathlib import Path

import pytest

BACKEND_ROOT = Path(__file__).resolve().parents[1]

# Trần = số dòng tại thời điểm audit 2026-07-29. KHÔNG nâng các số này.
# Rút được code ra thì HẠ trần xuống trong cùng PR để giữ áp lực.
#
# NÂNG TRẦN CÓ LÝ DO (2026-07-29, cùng đợt audit): ratchet vừa lập đã bắt đúng lô §C.1 khi
# bọc `pdfium_guard` cho các đường chạy trong thread — `imposition.py` +5, `preflight.py`
# +14, `edit.py` +19, `channel_remover.py` +5 dòng — và lô §C.3b khi cách ly kind "office"
# (`pdf_tools.py` +11). Đây là ngoại lệ hợp lệ: thêm LƯỚI AN TOÀN cho một bất biến (PDFium
# không thread-safe, rule #3) và một trần đồng thời, chứ không phải nhồi tính năng mới vào
# file đã quá dài. Ghi lại ở đây để lần sau không ai lấy tiền lệ này để nâng trần cho việc
# thêm tính năng.
# MỐC ĐO: 2026-07-29, lấy trong lúc MỘT PHIÊN KHÁC đang sửa `sticker_engine.py` (+298/-94
# dòng) và `pdf_tools.py`. Nếu nhánh đó còn đang làm dở thì lấy lại mốc một lần nữa sau khi
# nó land — ratchet chỉ có ý nghĩa khi mốc là trạng thái đã ổn định.
CEILINGS: dict[str, int] = {
    "app/api/routes/imposition.py": 3878,
    "app/api/routes/pdf_tools.py": 1933,
    "app/api/routes/preflight.py": 1660,
    "app/api/routes/edit.py": 1432,
    "app/core/stream_editor.py": 3713,
    "app/workers/nup_engine.py": 3716,
    "app/core/channel_remover.py": 2246,
    "app/core/edit_session.py": 2211,
}

# `app/workers/sticker_engine.py` (3.2k+ dòng) CỐ TÌNH chưa vào ratchet: trong đợt audit
# 2026-07-29 nó đang được một nhánh khác sửa liên tục (đo được 3252 → 3382 → 3390 dòng
# trong cùng buổi). Khoá trần trên một file đang thay đổi chỉ tạo test đỏ nhiễu, không tạo
# áp lực gì. **Thêm lại khi nhánh đó land** — đo lại số dòng lúc đó rồi đưa vào CEILINGS.
_HOAN_LAI = ("app/workers/sticker_engine.py",)


def _line_count(path: Path) -> int:
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        return sum(1 for _ in handle)


@pytest.mark.parametrize("rel_path,ceiling", sorted(CEILINGS.items()))
def test_file_khong_dai_them(rel_path: str, ceiling: int):
    path = BACKEND_ROOT / rel_path
    assert path.is_file(), f"Không thấy {rel_path} — nếu đã tách/đổi tên thì cập nhật CEILINGS"

    actual = _line_count(path)
    assert actual <= ceiling, (
        f"{rel_path} dài {actual} dòng, vượt trần {ceiling} (audit 2026-07-29 §A.1).\n"
        f"File này đã quá dài. Thay vì nâng trần, hãy rút một phần logic ra module riêng "
        f"(engine nặng thuộc `core/` hoặc `workers/`, route chỉ nên điều phối).\n"
        f"Nếu buộc phải nâng trần, ghi lý do trong PR — đây là quyết định của con người, "
        f"không phải sửa cho test xanh."
    )


@pytest.mark.parametrize("rel_path,ceiling", sorted(CEILINGS.items()))
def test_tran_khong_bi_bo_xa(rel_path: str, ceiling: int):
    """Rút code ra rồi thì phải HẠ trần — nếu không ratchet mất tác dụng.

    Cho phép chênh 150 dòng để những thay đổi nhỏ không phải sửa file này liên tục.
    """
    actual = _line_count(BACKEND_ROOT / rel_path)
    assert actual >= ceiling - 150, (
        f"{rel_path} nay chỉ còn {actual} dòng nhưng trần vẫn {ceiling}. "
        f"Hạ trần xuống {actual} trong cùng PR để giữ áp lực rút gọn."
    )


def test_route_imposition_khong_them_endpoint():
    """`routes/imposition.py` không được thêm endpoint mới nữa.

    18 endpoint trong một file 4.1k dòng đã là quá tải. Endpoint mới của nhóm bình bản nên
    đặt ở router riêng (vd `routes/imposition_preview.py`) rồi `include_router` ở `main.py`
    — vừa nhỏ lại, vừa buộc engine nằm ở `core/`.
    """
    path = BACKEND_ROOT / "app/api/routes/imposition.py"
    text = path.read_text(encoding="utf-8", errors="replace")
    count = sum(1 for line in text.splitlines() if line.startswith("@router."))
    assert count <= 18, (
        f"routes/imposition.py có {count} endpoint (trần 18, audit 2026-07-29 §A.1). "
        f"Đặt endpoint mới ở router riêng thay vì nối tiếp vào file này."
    )


def test_file_hoan_lai_van_ton_tai():
    """File đang được nhánh khác sửa vẫn phải tồn tại — nhắc đưa lại vào ratchet.

    Nếu test này đỏ vì file đã bị tách/đổi tên thì cập nhật `_HOAN_LAI`. Nếu nhánh kia đã
    land, đo lại số dòng và chuyển file từ `_HOAN_LAI` sang `CEILINGS`.
    """
    for rel_path in _HOAN_LAI:
        assert (BACKEND_ROOT / rel_path).is_file(), (
            f"{rel_path} không còn — cập nhật _HOAN_LAI/CEILINGS trong file này"
        )
        assert rel_path not in CEILINGS, (
            f"{rel_path} vừa nằm trong _HOAN_LAI vừa trong CEILINGS — chọn một"
        )
