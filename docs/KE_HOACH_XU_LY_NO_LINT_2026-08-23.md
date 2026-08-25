# Kế hoạch xử lý nợ ESLint PrynX — 2026-08-23

## 1. Mục tiêu và phạm vi

Mục tiêu là đưa cổng lint frontend về xanh mà không đổi hành vi PDF, bình bản,
Viewer, preprocess hoặc Tauri IPC; sau đó giảm dần nợ tới 0 finding có lý do.

Phạm vi là desktop/ — TypeScript/React ESLint. Python, Rust, dependency audit
và refactor nghiệp vụ không nằm trong cùng chiến dịch.

### Baseline

Đo ngày 2026-08-23 trên working tree hiện tại:

- 1.469 errors, 109 warnings, 1.578 findings.
- 192 file có finding / 733 file được ESLint quét.
- no-explicit-any: 1.173; no-unused-vars: 157.
- exhaustive-deps: 99; only-export-components: 60.
- set-state-in-effect: 20; no-empty: 18; ban-ts-comment: 14.
- unused-disable: 10; prefer-const: 9.

Mục tiêu đầu tiên là đưa only-export-components về <=32 và unused-disable về
<=9. Không tăng lint budget để làm xanh giả.

## 2. Nguyên tắc bất biến

1. Không chạy eslint --fix toàn kho.
2. Mỗi lô tối đa 5 file, cùng một miền chức năng.
3. Không trộn lô lint với feature/bugfix đang dang dở.
4. Không tắt rule mới hoặc thêm eslint-disable nếu chưa có lý do và test.
5. Không thay any hàng loạt bằng unknown hoặc ép kiểu để né lint.
6. Không thêm dependency Hook máy móc; phải xác định owner, vòng đời và ý định
   của effect.
7. Sau mỗi lô phải có số đo trước/sau và test tương ứng.
8. Nếu có regression, dừng chiến dịch và rollback đúng lô gây ra.
9. Chỉ hạ lint-budget.json sau khi finding đã giảm và verify xanh.
10. Suppression có chủ đích phải có tag LINT (audit 2026-08-23 §LINT.x).

## 3. Chốt 0 — khóa baseline

Mục tiêu: tách nợ lịch sử khỏi thay đổi hiện tại.

- Ghi git status, HEAD, nhánh và thời gian đo.
- Chạy eslint . --format json và tổng hợp theo rule, file, thư mục, test/source.
- Chạy lại trên checkout sạch của commit mục tiêu trước khi dùng số liệu làm mốc
  release chính thức.
- Đếm finding nằm trên dòng mới của diff để không quy nợ cũ cho lô mới.
- Không sửa code trong chốt này.

Điều kiện qua: baseline có command, commit, số liệu và trạng thái working tree.

## 4. Chốt 1 — khôi phục lint budget (P1)

Phạm vi: 60 only-export-components và 10 unused-disable.

### Lô 1A — finding mới

Xử lý helper shouldCenterVirtuosoList trong AcrobatViewer.tsx trước. Sau review,
hoặc đưa helper sang module thuần riêng, hoặc dùng suppression hẹp có lý do nếu
export cùng file là bắt buộc. Không đổi layout/scroll behavior ngoài mục tiêu
tách export.

### Lô 1B — unused-disable

- Liệt kê 10 directive không còn tác dụng.
- Xóa directive thật sự thừa.
- Nếu vẫn cần, thu hẹp đúng dòng và ghi lý do.
- Không xóa suppression đang che lỗi behavior-sensitive chỉ để giảm số đếm.

### Lô 1C–1F — React Refresh

Nhóm các file theo Viewer/workspace, imposition, preprocess và utility. Mỗi lô
tối đa 5 file; tách constant/helper khỏi component chỉ khi không đổi import cycle
và public API.

Verify từng lô:

    cd desktop
    npx eslint <tối-đa-5-file>
    npm run typecheck
    npx vitest run <test-liên-quan>
    npm run lint:budget
    git diff --check

Điều kiện qua Chốt 1: lint budget exit 0, không tăng tổng findings, test miền
liên quan xanh. Độ chắc chắn mục tiêu: 90–95%.

## 5. Chốt 2 — vệ sinh rủi ro thấp (P2/P3)

Thứ tự:

1. prefer-const (9).
2. unused-vars rõ ràng (157), bắt đầu ở test/helper nhỏ.
3. no-empty (18), phân loại catch best-effort/cancellation trước khi sửa.
4. ban-ts-comment (14), gỡ từng ts-nocheck sau khi thêm type tối thiểu.

Mỗi lô tối đa 5 file. Giữ tham số nếu chữ ký callback/API cần tương thích.
Không đụng god-file lớn trong lô đầu nếu chưa có test miền đủ mạnh.

Điều kiện qua: rule không vượt budget, typecheck và test phạm vi xanh.
Độ chắc chắn mục tiêu: 85–95%; no-empty có rủi ro cao hơn lỗi cơ học.

## 6. Chốt 3 — React Hooks theo miền hành vi

Nhóm behavior-sensitive gồm 99 exhaustive-deps, 20 set-state-in-effect và các
rule refs/immutability/memoization/purity. Không chạy autofix toàn kho.

### 3A — Viewer/workspace

Ứng viên: AcrobatViewer, LivePageFrame, usePdfLoader, App và hook viewer.

- Khóa regression cho zoom, scroll, page switch, overlay, thumbnail và tab nền.
- Phân biệt dependency ổn định với dependency tạo vòng render.
- Nếu effect chỉ tạo state dẫn xuất, xem xét render/event handler thay vì thêm
  dependency mù quáng.

### 3B — Imposition

Ứng viên: ImpositionTab, ImposerDashboard, GridPreview, pdfImposer và serializer.

- Khóa số tem, layout, preview và cancellation.
- Kiểm tra không gọi lại job nặng khi dependency đổi.
- Nếu effect chạm backend/worker, kiểm tra lifecycle và cancellation.

### 3C — Preprocess/sticker

Ứng viên: StickerTool, StickerSheet*, hook preview và store.

- Khóa race preview cũ/mới, AbortController, canonical reference và nút Thực thi.
- Test cả local page-box và canonical server preview.
- Không đổi debounce/worker trong chiến dịch lint nếu chưa có audit hiệu năng riêng.

Mỗi lô Hooks phải có test behavior và smoke runtime. Dừng ngay nếu có loop,
render churn, preview gọi lặp hoặc job nhân đôi. Độ chắc chắn mục tiêu: 70–85%
mỗi lô.

## 7. Chốt 4 — giảm any tại boundary dữ liệu

Đây là chiến dịch dài hạn, không làm theo số dòng. Chia theo contract:

1. API sidecar/FastAPI response và error payload.
2. Tauri invoke, event và native drop payload.
3. PDF/imposition/dieline model và serializer.
4. Viewer object/overlay/thumbnail state.
5. Test fixture và helper.

Quy tắc:

- Định nghĩa type/interface/schema ở boundary.
- Dùng unknown + type guard khi dữ liệu không tin cậy.
- Giữ adapter tương thích khi backend còn nhiều shape.
- Thêm contract test trước khi lan type vào component.
- Không đổi đơn vị mm/pt/px hoặc JSON key chỉ vì lint.

Mỗi lô tối đa 5 file, mục tiêu giảm 25–100 finding. Độ chắc chắn mục tiêu:
85–95% mỗi boundary batch; 55–75% nếu cố dọn toàn bộ 1.173 finding một lần.

## 8. Chốt 5 — ratchet và đóng chiến dịch

Sau mỗi lô:

- Hạ lint-budget.json đúng bằng baseline mới, không nâng trần.
- Ghi docs/<CHU_DE>_FIXES_2026-08-23.md với file, lý do, test và số đo.
- Chụp lại git status, git diff --check và danh sách test.
- Chỉ stage/commit file thuộc lô đã verify.

Definition of Done:

- npm run lint exit 0.
- npm run lint:budget exit 0 với budget giảm dần.
- npm run typecheck exit 0.
- Vitest toàn bộ xanh, skip được giải thích.
- Smoke Tauri cho Viewer, bình bản và preprocess đạt.
- Không còn ts-nocheck/eslint-disable không có lý do.
- Không có finding mới trên diff cuối.

## 9. Tiêu chí dừng và rollback

Dừng lô nếu:

- finding tăng ngoài rule đang xử lý;
- test hoặc typecheck fail;
- Viewer bị loop, preview gọi lặp hoặc job nhân đôi;
- payload API/PDF thay đổi ngoài chủ đích;
- RAM/latency tăng rõ trên workload có baseline.

Rollback đúng lô đang làm, không reset toàn working tree. Cập nhật log audit rồi
mới mở lô kế tiếp.

## 10. Chốt phê duyệt

1. User duyệt Chốt 1 và danh sách file lô đầu.
2. Thực hiện một lô <=5 file, verify và báo số đo.
3. User xác nhận runtime; sau đó mới mở lô tiếp theo.
4. Chỉ khi P1 ổn định mới bắt đầu Chốt 2–4.

Lượt lập kế hoạch này chưa sửa mã nguồn, chưa build và chưa commit/push.
