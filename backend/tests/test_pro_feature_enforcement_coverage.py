"""Ratchet: MỌI quyền trong PRO_FEATURES phải được cưỡng chế ở backend.

SEC (audit 2026-08-28 §SEC.01/§SEC.14)
─────────────────────────────────────────────────────────────────────────────────
Lỗ đã tìm được: router `cut_export` chỉ có `require_license`, không hề cưỡng chế
`impo.cnc`. Quyền đó khai là PRO ở ba nơi (`feature_entitlements.PRO_FEATURES`,
`desktop/src/lib/license/features.ts`, `desktop/src/lib/toolRegistry.ts`) và bị gate ở
UI — nhưng UI là máy của người khác, không phải biên cưỡng chế. Kết quả: một license
FREE hợp lệ xuất được luồng cắt và đẩy trực tiếp tới máy bế.

Vì sao cần ratchet chứ không chỉ vá một chỗ: độ phủ entitlement của dự án dựa vào QUY
ƯỚC ("nhớ gắn dependency"), và audit 2026-07-26 §1.5 đã cảnh báo đúng câu đó nhưng
không có gì chặn. Thêm một router mới mà quên `require_feature` thì KHÔNG test nào đỏ,
KHÔNG tính năng nào gãy — lỗ im lặng cho tới lần audit sau. Test này biến quy ước thành
cưỡng chế: thêm quyền Pro vào catalog mà không enforce ở đâu ⇒ CI đỏ ngay.

Test này KHÔNG chứng minh gate nằm ở ĐÚNG route (một quyền có thể được enforce ở chỗ
sai). Nó chỉ đóng ca "khai Pro nhưng chưa bao giờ được kiểm". Phần đúng-chỗ do test
hành vi lo: `test_free_token_e2e.py`, `test_mixed_nesting_feature_gate.py`,
`test_dieline_feature_gate.py`, `test_logo_rebuild_feature_gate.py`,
`app/workers/cut_export/tests/test_api.py`.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.core.feature_entitlements import FREE_FEATURES, PRO_FEATURES

BACKEND_APP = Path(__file__).resolve().parents[1] / "app"

#: Chuỗi enforce được coi là hợp lệ. `require_feature("x")` là dạng khai báo ở router/
#: route; `enforce_feature(...)` là dạng động (route tự chọn quyền theo body).
_ENFORCE_PATTERNS = (
    'require_feature("{feature}")',
    "require_feature('{feature}')",
    'assert_feature("{feature}")',
    "assert_feature('{feature}')",
    'enforce_feature("{feature}"',
    "enforce_feature('{feature}'",
)

#: Quyền Pro KHÔNG có bề mặt backend, cưỡng chế chỉ ở client — ACCEPTED RISK ĐÃ GHI.
#:
#: `docs/audit/PRYNX_THREAT_MODEL.md` §6: "Paper Library hiện chạy hoàn toàn trong
#: WebView. App có guard/downgrade overlay nhưng KHÔNG coi đây là biên chống patch; đây
#: là accepted commercial risk cho tới khi capability có giá trị được chuyển sang
#: authority native/server."
#:
#: Cưỡng chế thật hiện tại: `desktop/src/components/paper-library/PaperLibraryTool.tsx`
#: (`canUse('prepress.paper_library', ...)` + `FeatureAccessOverlay`). Renderer bị patch
#: là mở được — đó là cái giá đã chấp nhận, không phải điều test này bỏ sót.
#:
#: Danh sách này CỐ Ý ngắn và có kiểm hai chiều (xem
#: `test_accepted_risk_client_only_khong_am_tham_lech`): thêm route backend cho một quyền
#: ở đây mà không xoá khỏi danh sách ⇒ test đỏ, buộc cập nhật cả threat model.
_CLIENT_ONLY_ACCEPTED_RISK = frozenset({"prepress.paper_library"})


def _python_sources() -> list[Path]:
    return [
        path
        for path in BACKEND_APP.rglob("*.py")
        if "__pycache__" not in path.parts and "tests" not in path.parts
    ]


@pytest.fixture(scope="module")
def backend_source_text() -> str:
    """Gộp toàn bộ source backend (trừ test) thành một chuỗi để quét."""
    chunks: list[str] = []
    for path in _python_sources():
        try:
            chunks.append(path.read_text(encoding="utf-8", errors="ignore"))
        except OSError:  # pragma: no cover - đọc lỗi là bất thường
            continue
    return "\n".join(chunks)


@pytest.fixture(scope="module")
def dynamic_feature_literals() -> set[str]:
    """Quyền được nhắc trong bảng/map động (vd bảng path→feature của preflight).

    `require_feature` không phải cách duy nhất: `preflight.py` và `imposition.py` chọn
    quyền theo runtime rồi đưa vào `enforce_feature`. Những quyền đó xuất hiện dưới dạng
    literal chuỗi trong source, nên coi là đã được cưỡng chế nếu literal có mặt CÙNG với
    một lời gọi enforce động trong cùng file.
    """
    literals: set[str] = set()
    for path in _python_sources():
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:  # pragma: no cover
            continue
        if "enforce_feature(" not in text and "require_feature(" not in text:
            continue
        for match in re.finditer(r"""["']([a-z][a-z0-9_]*\.[a-z0-9_]+)["']""", text):
            literals.add(match.group(1))
    return literals


def _is_enforced(feature: str, source: str, dynamic: set[str]) -> bool:
    for pattern in _ENFORCE_PATTERNS:
        if pattern.format(feature=feature) in source:
            return True
    return feature in dynamic


@pytest.mark.parametrize(
    "feature", sorted(PRO_FEATURES - _CLIENT_ONLY_ACCEPTED_RISK)
)
def test_moi_quyen_pro_deu_duoc_cuong_che_o_backend(
    feature: str, backend_source_text: str, dynamic_feature_literals: set[str]
) -> None:
    assert _is_enforced(feature, backend_source_text, dynamic_feature_literals), (
        f"Quyền PRO '{feature}' khai trong PRO_FEATURES nhưng KHÔNG xuất hiện trong bất kỳ "
        f"require_feature/enforce_feature/assert_feature nào ở backend/app.\n"
        f"Đây đúng là hình dạng của lỗ §SEC.01 (cut_export thiếu 'impo.cnc'): quyền được "
        f"gate ở UI nhưng backend không kiểm ⇒ license Free gọi API là dùng được.\n"
        f"Cách sửa: gắn Depends(require_feature('{feature}')) ở CẤP ROUTER của module phục "
        f"vụ tính năng đó, rồi thêm một test 403 cho nó."
    )


@pytest.mark.parametrize("feature", sorted(_CLIENT_ONLY_ACCEPTED_RISK))
def test_accepted_risk_client_only_khong_am_tham_lech(
    feature: str, backend_source_text: str, dynamic_feature_literals: set[str]
) -> None:
    """Kiểm chiều NGƯỢC lại của danh sách accepted risk.

    Nếu một ngày quyền này CÓ bề mặt backend (ai đó thêm route Paper Library phía server)
    thì nó không còn là "client-only" nữa: phải xoá khỏi `_CLIENT_ONLY_ACCEPTED_RISK` để
    nó quay vào diện ratchet, và cập nhật §6 của threat model. Không có kiểm này thì danh
    sách miễn trừ chỉ phình ra và âm thầm che mất các lỗ thật.
    """
    assert not _is_enforced(feature, backend_source_text, dynamic_feature_literals), (
        f"'{feature}' đang nằm trong _CLIENT_ONLY_ACCEPTED_RISK nhưng backend ĐÃ cưỡng chế "
        f"nó. Hãy xoá khỏi danh sách miễn trừ (để ratchet phủ lại) và cập nhật "
        f"docs/audit/PRYNX_THREAT_MODEL.md §6 — accepted risk này không còn đúng."
    )


def test_danh_sach_mien_tru_nam_trong_catalog_pro() -> None:
    """Miễn trừ một quyền không tồn tại là dấu hiệu catalog đã đổi tên mà quên đồng bộ."""
    unknown = _CLIENT_ONLY_ACCEPTED_RISK - PRO_FEATURES
    assert unknown == set(), (
        f"_CLIENT_ONLY_ACCEPTED_RISK nhắc quyền không có trong PRO_FEATURES: {sorted(unknown)}"
    )


def test_catalog_khong_giao_nhau_giua_free_va_pro() -> None:
    """Một quyền vừa Free vừa Pro thì `FEATURE_MIN_PLAN` sẽ lấy giá trị sau — im lặng."""
    overlap = FREE_FEATURES & PRO_FEATURES
    assert overlap == set(), f"quyền vừa Free vừa Pro: {sorted(overlap)}"


def test_ratchet_that_su_phat_hien_duoc_quyen_chua_enforce(
    backend_source_text: str, dynamic_feature_literals: set[str]
) -> None:
    """Độ nhạy: nếu `_is_enforced` luôn trả True thì test trên xanh vĩnh viễn."""
    assert not _is_enforced(
        "impo.khong_ton_tai_bao_gio", backend_source_text, dynamic_feature_literals
    )
    # Và một quyền có thật thì phải nhận ra được.
    assert _is_enforced("impo.cnc", backend_source_text, dynamic_feature_literals)


def test_cut_export_router_cuong_che_impo_cnc() -> None:
    """Neo trực tiếp cho §SEC.01 — đọc file thật, không qua chuỗi gộp.

    Giữ riêng vì đây là lỗ đã xảy ra: nếu ai đó gỡ dependency ở router này thì test trên
    vẫn có thể xanh (quyền `impo.cnc` còn được nhắc ở `imposition.py`), nên cần neo hẹp.
    """
    source = (BACKEND_APP / "workers" / "cut_export" / "api.py").read_text(encoding="utf-8")
    assert "require_feature" in source, "cut_export/api.py không import require_feature"
    assert 'require_feature("impo.cnc")' in source, (
        "router cut_export không còn cưỡng chế 'impo.cnc'. 10 endpoint CNC/máy bế sẽ mở "
        "cho mọi license hợp lệ, gồm Free (§SEC.01)."
    )
    # Gate phải ở CẤP ROUTER: thêm endpoint mới thì tự động có quyền.
    router_declaration = source[source.index("router = APIRouter(") :]
    router_declaration = router_declaration[: router_declaration.index(")\n")]
    assert 'require_feature("impo.cnc")' in router_declaration, (
        "gate 'impo.cnc' không nằm trong khai báo APIRouter — đặt ở từng decorator sẽ hở "
        "khi thêm endpoint mới."
    )
