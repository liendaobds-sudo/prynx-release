"""OutputIntent của PDF/X phải khai đúng điều kiện in mà app đã kiểm.

Vì sao đáng một file test riêng: OutputIntent là lời khai gửi cho nhà in —
"file này đã được chuẩn bị cho điều kiện in X". Nếu nó khai một profile khác
với profile mà separations / soft-proof / TAC dùng để kiểm, thì mọi con số đã
đo trở nên vô nghĩa với người nhận, và sai lệch đó không hiện ra ở bất kỳ đâu
trong UI.
"""

import os

from app.core.pdfx_export import PdfxExportEngine


def test_output_intent_uses_app_cmyk_profile_not_ghostscript_default():
    """Phải là profile CMYK của app, không phải ICC generic cạnh binary GS.

    Lỗi đã xảy ra: nhánh tìm profile gọi `softproof.KNOWN_PROFILES`, biểu tượng
    đó bị bỏ trong một lần refactor, và `except Exception: pass` nuốt trọn
    ImportError — PDF/X lặng lẽ khai "Generic CMYK (Ghostscript default)" trong
    khi FOGRA39 vẫn nằm sẵn trong app/assets/icc/.
    """
    path, cond_id, cond_name = PdfxExportEngine()._resolve_output_intent_icc()

    assert path, "không tìm được ICC nào cho OutputIntent"
    assert os.path.isfile(path)
    normalized = path.replace("\\", "/").lower()
    assert "/assets/icc/" in normalized, (
        f"OutputIntent phải dùng ICC bundled của app, đang dùng: {path}"
    )
    assert "iccprofiles" not in normalized, (
        f"ICC đang lấy từ thư mục Ghostscript: {path}"
    )
    assert cond_id and cond_name


def test_output_intent_matches_the_profile_used_for_measurement():
    """Cùng một profile với đường đo mực — nếu lệch, số đã kiểm nói về file khác."""
    from app.core import icc_profiles

    path, _cond_id, _cond_name = PdfxExportEngine()._resolve_output_intent_icc()
    assert os.path.normcase(path) == os.path.normcase(
        icc_profiles.resolve_cmyk_profile_path()
    )
