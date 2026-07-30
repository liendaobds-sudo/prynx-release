# Tiến độ sửa audit bảo mật 2026-07-30

Nguồn finding: `docs/BAO_CAO_AUDIT_BAO_MAT_2026-07-30.md`.

## Lô A — RPC tra cứu đơn và resource key

Trạng thái: đã áp thay đổi, đang verify.

- `§SEC.1`: migration mới thu hồi quyền `anon/authenticated/PUBLIC` gọi trực tiếp
  `get_order_by_code(text,text)`; Edge Function dùng service role nên luồng tra cứu hợp
  lệ không đổi.
- `§SEC.2`: mọi release key tồn tại tại thời điểm migration được đánh dấu
  `legacy_fallback=true`. Khi `claim_rk_grant` lỗi, chỉ nhóm bản cũ này còn nhận `rk`;
  release mới fail-closed riêng khóa tài nguyên và vẫn nhận token license bình thường.
- Thêm regression test tĩnh để chặn tái phát quyền RPC public và fail-open toàn bộ `rk`.

### Thứ tự rollout bắt buộc

1. Áp migration `20260730100000_security_audit_round2.sql`.
2. Xác nhận cột `legacy_fallback`, quyền RPC và `claim_rk_grant` trên project đích.
3. Sau đó mới deploy `license-verify` và `order-lookup`.

Không đảo thứ tự 1/3: Edge Function mới cần cột `legacy_fallback` để bảo vệ khách cũ.

### Verify

- Chưa chạy tại thời điểm tạo mục này.

Kết quả cập nhật: `npm run test:run -- src/securityAuditRound2.test.ts` đạt cho Lô A.

## Lô B — Signing key và Supabase CLI

Trạng thái: đã áp thay đổi, đang verify.

- `§SEC.3`: script dùng file env tạm cho `supabase secrets set --env-file`; private key
  không còn xuất hiện trong process argv. File tạm được xóa trong `finally`.
- `§SEC.4`: pin Supabase CLI `2.110.0`, kiểm SHA-256 của ZIP phát hành và của
  `supabase.exe`; bỏ API `releases/latest` và từ chối CLI trong PATH/local sai hash.
- Checksum ZIP được đối chiếu với `checksums.txt` của release chính thức; executable
  hash được tính từ ZIP đã xác minh mà không chạy binary.

### Verify

- Regression test tĩnh đã bổ sung; chưa chạy lại tại thời điểm ghi mục này.

## Lô C — Checkpoint model trên máy build

Trạng thái: đã áp và verify hẹp.

- `§SEC.5`: khóa SHA-256 của ba checkpoint Real-ESRGAN; kiểm cả cache và file vừa
  tải trước khi nạp; tải qua file tạm rồi `os.replace`.
- `torch.load` luôn dùng `weights_only=True`, không cho checkpoint gọi object pickle
  tùy ý trên máy build.

### Verify

- `py_compile`: đạt.
- `pytest -q backend/tests/test_realesrgan_checkpoint_security.py`: đạt.

## Lô D — Migration và artifact hygiene

Trạng thái: đã áp, đang verify tổng hợp.

- `§SEC.6`: thêm `security-manifest.json` liệt kê 10 migration bắt buộc và Edge
  Function chỉ được deploy sau migration; regression test fail nếu clean checkout
  thiếu bất kỳ migration nào.
- `§SEC.7`: ignore toàn bộ `supabase/.temp/`; token/response tạm không còn xuất hiện
  trong `git status` và không bị xóa khỏi máy người dùng.

### Giới hạn vận hành

- Các migration/Edge Function mới chỉ được sửa trong working tree. Chưa áp production,
  chưa stage/commit/push vì đợt sửa không tự ý thay đổi lịch sử Git hoặc hệ thống thật.

## Verify tổng hợp local

- PrintSolutions: `vitest` 5/5 test đạt.
- PrintSolutions: `vite build` production đạt; chỉ còn warning chunk size và
  Browserslist cũ, không liên quan bản vá.
- PrynX: `py_compile` đạt; pytest checkpoint security 3/3 đạt.
- PowerShell deploy script parse đạt; script không được thực thi với secret thật.
- `git diff --check` đạt trên các file đã sửa.
- `supabase/.temp/tok.json` và `resp.json` khớp rule ignore.
- Chưa typecheck Edge Function bằng Deno vì máy không có `deno`/Supabase CLI trong PATH;
  regression test và frontend production build đã đạt, nhưng deploy staging vẫn phải
  là chốt runtime cuối.

Trạng thái local: hoàn tất. Trạng thái production: chờ migration → xác minh → Edge deploy.

## Deploy production — 2026-07-30

- User đã áp migration trên Supabase và cung cấp bằng chứng:
  - `legacy_fallback` tồn tại;
  - `claim_rk_grant` tồn tại;
  - `anon/authenticated` không có quyền gọi direct order RPC;
  - `service_role` có quyền;
  - release key active: tổng `1`, legacy `1`.
- CLI deploy: Supabase CLI `2.110.0`, SHA-256
  `14814afa6fe59081eb9f24709fc077226bf89bc25cf77ee3bcb19565f3ef8899`.
- Project: `ryvyuxjgdcvoxujqmggm`, trạng thái `ACTIVE_HEALTHY`.
- `license-verify`: deploy thành công, production `ACTIVE`, version `13`, bundle SHA-256
  `775ce4be8e01668e70c45fa862645f46864d8e5cc8cd6e368a4b3ff661ebf312`.
- `order-lookup`: deploy thành công, production `ACTIVE`, version `6`, bundle SHA-256
  `9d3f9e8e8e9b93ffb90b70f0ffe40fe3d72fea70ebd299a503fb657f6fb812f3`.
- Smoke test payload rỗng: cả hai function trả HTTP `400` đúng validation boundary.

Chốt còn lại: kiểm tay một bản PrynX cũ có license thật để đóng hoàn toàn compatibility runtime.
