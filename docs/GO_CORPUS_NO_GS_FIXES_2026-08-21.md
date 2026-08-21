# Nhật ký gỡ corpus no-GS khỏi pipeline phát hành

**Ngày:** 2026-08-21

**Audit gốc:** `BAO_CAO_AUDIT_GO_CORPUS_NO_GS_2026-08-21.md`

## NGS-L1 — Gỡ bề mặt phát hành

**File:**

- `build_production.ps1`
- `release_update.ps1`
- `scripts/release_controller.ps1`
- `quanly_phathanh.ps1`
- `backend/tests/test_release_no_gs_policy.py`

**Thay đổi:**

- Xóa `RunNoGsAudit`, `ReusePassedNoGs`, checkbox GUI và mọi forwarding.
- Xóa artifact/biến môi trường audit riêng khỏi QA trên native wheel staged.
- Release QA chỉ còn một đường gọi xác định; vùng log GUI được kéo lên lấp chỗ trống.
- Regression test khóa việc các cờ hoặc artifact corpus quay lại.

**Verify:**

- PowerShell parser: 4/4 script đạt.
- Release policy: 54 passed, 1 warning Pydantic không liên quan.
- Quét token trên bề mặt phát hành: không còn consumer; chỉ còn negative assertion trong test.
- `git diff --check`: đạt.

## NGS-L2 — Xóa engine audit và hợp đồng nội bộ

**File:**

- `scripts/run_release_qa.ps1`
- `scripts/gs_dependency_audit.py` (đã xóa)
- `backend/tests/test_gs_dependency_audit.py` (đã xóa)
- `backend/tests/test_release_no_gs_policy.py`
- `docs/PPE_CURRENT_STATE.md`

**Thay đổi:**

- Xóa corpus 18×16, fingerprint, cache, retry và thông báo skip khỏi Release QA.
- Xóa script audit cùng toàn bộ test chuyên dụng.
- Cập nhật SSOT PPE: phép đo corpus chỉ còn là bằng chứng lịch sử, không còn lệnh/pipeline hiện hành.
- Giữ nguyên tripwire subprocess, kiểm payload/NOTICE và record pháp lý `bundled=false`.

**Verify:**

- PowerShell parser `run_release_qa.ps1`: đạt.
- Quét source ngoài docs/test negative assertion: không còn token/consumer audit corpus.
- Các chốt chống Ghostscript trong build, verifier, backend tripwire và component manifest vẫn hiện diện.
- Targeted policy/tripwire/PPE-only: 100 passed, 1 warning Pydantic không liên quan.
- Full backend: 3203 passed; 1 ca DPAPI đỏ do Codex PowerShell 7 làm bẩn `PSModulePath` của Windows PowerShell 5.
- Chạy lại đúng ca DPAPI với `PSModulePath` do Windows PowerShell 5 cung cấp: 1 passed.

## Trạng thái build

Không build lại theo yêu cầu chủ dự án. Source được commit/push trước; rc.8.1 sẽ chỉ build sau khi các sửa đổi tiếp theo hoàn tất.
