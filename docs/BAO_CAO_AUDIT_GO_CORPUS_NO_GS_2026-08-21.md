# BÁO CÁO AUDIT GỠ CORPUS NO-GS KHỎI PIPELINE PHÁT HÀNH

**Ngày:** 2026-08-21
**Baseline:** `119f739` — branch `codex/pre-release-audit-2026-08-04` khớp upstream, worktree sạch trước báo cáo
**Phạm vi:** audit corpus 18 PDF × 16 thao tác, cache/reuse và mọi điểm gọi từ build/phát hành
**Ngoài phạm vi:** hàng rào cấm chạy/đóng gói Ghostscript, verifier artifact, test chức năng PPE-only và công cụ golden đối chứng dành cho dev

## 1. Kết luận điều hành

Audit corpus no-GS **chưa được loại bỏ**. Commit `f70e594` chỉ đổi nó từ gate mặc định thành tùy chọn. Vì vậy QA vẫn in `Skipped optional no-GS corpus audit...`; checkbox phát hành vẫn có thể truyền `ReusePassedNoGs`, từ đó `build_production.ps1` tự bật lại `RunNoGsAudit` và chạy đủ corpus.

Mục tiêu đề xuất là xóa trọn audit corpus 18×16, gồm code thực thi, cache/fingerprint, cờ CLI, checkbox GUI, artifact riêng và test khóa hợp đồng cũ. Các chốt bảo đảm sản phẩm không chứa Ghostscript vẫn được giữ.

## 2. Baseline đã kiểm

- PowerShell parser: 5/5 script liên quan đạt.
- `test_release_no_gs_policy.py` + `test_gs_dependency_audit.py`: **64 passed**, 1 warning Pydantic không liên quan.
- Build rc.8.1 đang chạy đã bị dừng; không còn tiến trình Nuitka, SCons, Tauri, MSVC hoặc NSIS của lượt đó.

## 3. Phát hiện

### [P1][CONFIRMED] §NGS.1 — Pipeline chỉ bỏ qua mặc định, chưa xóa audit

**Bằng chứng:**

- `build_production.ps1:29-30` còn `RunNoGsAudit` và `ReusePassedNoGs`.
- `build_production.ps1:402-407` tự bật audit khi caller yêu cầu reuse.
- `scripts/run_release_qa.ps1:17-303` còn toàn bộ corpus, fingerprint và cache.
- `scripts/run_release_qa.ps1:381-434` còn nhánh chạy audit và log “Skipped optional”.

**Tác động:** build vẫn mang hợp đồng, code và log của tính năng đã yêu cầu loại bỏ; audit có thể chạy lại thật.

### [P1][CONFIRMED] §NGS.2 — Bề mặt phát hành vẫn bật lại được audit

**Bằng chứng:**

- `quanly_phathanh.ps1:124-129` còn checkbox reuse kết quả 18×16.
- `release_update.ps1:17,427` và `scripts/release_controller.ps1:10,287` còn nhận/chuyển tiếp cờ.

**Tác động:** người vận hành có thể vô tình kích hoạt lại tác vụ dài; việc “bỏ qua mặc định” không đáp ứng yêu cầu “loại bỏ”.

### [P2][CONFIRMED] §NGS.3 — QA staged-native còn tạo artifact riêng cho audit đã bỏ

**Bằng chứng:** `build_production.ps1:1027-1053` tạo `release_no_gs_audit-native-*.json`, đặt `PRYNX_NO_GS_AUDIT_OUT` và phục hồi biến môi trường sau QA.

**Tác động:** pipeline phức tạp hơn, tiếp tục mang state/cache không còn giá trị.

### [P2][CONFIRMED] §NGS.4 — Test đang bắt buộc hợp đồng cũ tồn tại

**Bằng chứng:**

- `backend/tests/test_gs_dependency_audit.py` chỉ kiểm script audit corpus.
- `backend/tests/test_release_no_gs_policy.py:225-326` yêu cầu gate, retry, cache, artifact, cờ và checkbox còn tồn tại.

**Tác động:** xóa code đúng ý định sẽ làm test đỏ nếu không sửa đồng bộ; lần bảo trì sau dễ phục hồi nhầm tính năng.

### [P2][CONFIRMED] §NGS.5 — Tài liệu trạng thái hiện hành còn trỏ tới audit

**Bằng chứng:** `docs/PPE_CURRENT_STATE.md:38,81` vẫn mô tả corpus 18×16 và biến môi trường phát hành.

**Tác động:** tài liệu SSOT sẽ sai sau khi xóa code nếu không cập nhật.

## 4. Phần phải giữ

- Chốt từ chối payload Ghostscript trong `build_production.ps1`.
- Quét artifact/NOTICE trong `scripts/verify_installed_artifact.ps1`.
- Tripwire subprocess, `test_no_ghostscript_survival.py`, `test_gs_usage_telemetry.py` và CI tương ứng.
- Record `ghostscript` với `bundled=false` trong `scripts/bundled_components.json`.
- `scripts/ppe_golden_compare.py` và báo cáo audit lịch sử; đây là công cụ/bằng chứng đối chứng, không nằm trong runtime hay pipeline release.

## 5. Kế hoạch sửa theo lô

### Lô 1 — Gỡ mọi bề mặt phát hành (5 file)

1. `build_production.ps1`
2. `release_update.ps1`
3. `scripts/release_controller.ps1`
4. `quanly_phathanh.ps1`
5. `backend/tests/test_release_no_gs_policy.py`

Xóa cờ, checkbox, forwarding, nhánh staged artifact và rút lời gọi QA về một đường duy nhất. Verify: PowerShell parser, policy test phạm vi release, quét token cấm.

### Lô 2 — Xóa engine audit và hợp đồng nội bộ (5 file)

1. `scripts/run_release_qa.ps1`
2. Xóa `scripts/gs_dependency_audit.py`
3. Xóa `backend/tests/test_gs_dependency_audit.py`
4. Hoàn tất `backend/tests/test_release_no_gs_policy.py`
5. `docs/PPE_CURRENT_STATE.md`

Xóa corpus/cache/fingerprint/retry/log skip và cập nhật SSOT. Verify: PowerShell parser, targeted pytest, `git grep` bảo đảm không còn consumer audit ngoài tài liệu lịch sử, `git diff --check`.

## 6. Điều kiện nghiệm thu

1. Build/QA/release/GUI không còn `RunNoGsAudit`, `ReusePassedNoGs`, `PRYNX_NO_GS_*`, artifact/cache 18×16 hoặc log skip.
2. `scripts/gs_dependency_audit.py` và test chuyên dụng đã bị xóa.
3. Chốt chống bundle/chạy Ghostscript vẫn xanh.
4. Release QA vẫn chạy đầy đủ backend, frontend và Rust như trước, chỉ bỏ corpus audit đã loại.
5. Source được commit/push, sau đó mới build lại rc.8.1; không upload GitHub nếu chưa có yêu cầu riêng.

## 7. Chốt duyệt

Chủ dự án đã duyệt triển khai ngày 2026-08-21. Hai lô đã được thực hiện theo phạm
vi trên; kết quả verify và commit được ghi tại `GO_CORPUS_NO_GS_FIXES_2026-08-21.md`.
