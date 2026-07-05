r"""Path-traversal containment cho GET /api/preflight/download/{filename}.

Regression cho fix bảo mật: `filename` tới thẳng từ URL. Trên Windows `%5C`
decode thành `\` nên `..%5C..%5CWindows%5Cwin.ini` từng thoát được thư mục
preflight_output → đọc file hệ thống bất kỳ. Fix confine path đã-resolve phải
nằm TRONG output_dir. Test xác nhận: file hợp lệ tải được, mọi mẹo traversal
(`..`, `%5C`, tuyệt đối) bị 400.
"""
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.config import settings
from app.core.license_guard import require_license


# Bỏ guard license để test riêng logic containment (guard đã có test khác).
app.dependency_overrides[require_license] = lambda: {"license_key": "TEST", "hwid": "TEST", "verified": True}
client = TestClient(app)


@pytest.fixture
def output_dir():
    d = Path(settings.RESULTS_DIR) / "preflight_output"
    d.mkdir(parents=True, exist_ok=True)
    return d


def test_valid_filename_downloads(output_dir):
    """File trần hợp lệ trong output_dir tải được (200 + đúng nội dung)."""
    fname = "fixed_sample.pdf"
    (output_dir / fname).write_bytes(b"%PDF-1.4\n%test\n")
    try:
        resp = client.get(f"/api/preflight/download/{fname}")
        assert resp.status_code == 200
        assert resp.content.startswith(b"%PDF")
    finally:
        (output_dir / fname).unlink(missing_ok=True)


def test_nonexistent_file_404(output_dir):
    """Tên hợp lệ nhưng file không tồn tại → 404 (không phải 400)."""
    resp = client.get("/api/preflight/download/khong_ton_tai.pdf")
    assert resp.status_code == 404


def test_backslash_traversal_rejected(output_dir):
    """`%5C` (backslash encode) không được thoát output_dir trên Windows → 400."""
    # Gieo file mồi ngoài output_dir để nếu containment hỏng thì có cái mà đọc.
    parent = output_dir.parent
    bait = parent / "bait_secret.txt"
    bait.write_bytes(b"SECRET")
    try:
        resp = client.get("/api/preflight/download/..%5Cbait_secret.txt")
        assert resp.status_code == 400
        assert b"SECRET" not in resp.content
    finally:
        bait.unlink(missing_ok=True)


def test_dotdot_slash_traversal_rejected(output_dir):
    """`../` traversal cổ điển → 400 (hoặc bị router chặn trước, vẫn không 200)."""
    resp = client.get("/api/preflight/download/..%2F..%2Fbait.txt")
    assert resp.status_code != 200


def test_absolute_path_rejected(output_dir):
    """Đường dẫn tuyệt đối kiểu Windows → không thoát được output_dir."""
    resp = client.get("/api/preflight/download/C:%5CWindows%5Cwin.ini")
    assert resp.status_code != 200
