# Báo cáo audit nợ ESLint toàn kho — 2026-08-23

## 1. Phạm vi và kết luận

Audit lại lint TypeScript/React trong `desktop/` bằng đúng cấu hình đang được
CI sử dụng. Audit chỉ đo và phân loại, không chạy `--fix`, không đổi cấu hình,
không đổi budget và không sửa mã nguồn.

**Kết luận:** khoản nợ hơn 1.000 lỗi vẫn còn, nhưng đã giảm so với snapshot
tháng 7. Baseline hiện tại là **1.469 lỗi + 109 cảnh báo = 1.578 phát hiện**.
Đây không phải 1.578 lỗi runtime; phần lớn là nợ kiểu dữ liệu và các cảnh báo
chất lượng mã. Tuy vậy, cổng CI hiện **đang đỏ** vì hai rule vượt trần riêng,
cho nên không thể gọi trạng thái hiện tại là lint sạch hoặc release-ready ở
tiêu chí lint.

## 2. Cách đo và tính tái lập

Môi trường đo:

- Ngày: 2026-08-23.
- HEAD: `5fa479c`, nhánh `codex/pre-release-audit-2026-08-04`.
- Working tree đang có thay đổi UI/preview chưa commit; số liệu dưới đây là
  trạng thái working tree, không phải một checkout sạch của HEAD.
- Lệnh chính: `cd desktop; npm run lint:budget`.
- Lệnh phân tích: `eslint . --format json`, sau đó tổng hợp theo rule, file và
  nhóm test/source.

Cấu hình áp dụng `tseslint.configs.recommended`, React Hooks và React Refresh
cho mọi `**/*.{ts,tsx}` tại [eslint.config.js](../desktop/eslint.config.js:18).
Một số artifact lớn đã được ignore, nhưng các file TypeScript ngoài `src/`
vẫn nằm trong phạm vi `eslint .` nếu không được ignore riêng.

## 3. Baseline hiện tại

| Chỉ số | 2026-08-23 | Snapshot audit 2026-07-28 | Thay đổi |
|---|---:|---:|---:|
| File được ESLint quét | 733 | 523 | +210 |
| File có phát hiện | 192 | 197 | -5 |
| Errors | 1.469 | 1.526 | -57 |
| Warnings | 109 | 116 | -7 |
| Tổng phát hiện | 1.578 | 1.642 | -64 |
| Phát hiện có thể auto-fix | 19 | 24 | -5 |

Con số hiện tại xác nhận ký ức “hơn 1.000 lỗi”, nhưng snapshot cũ không còn
đủ để đại diện cho tree hiện tại. Số file được quét tăng mạnh do repo đã thêm
nhiều test/helper/config; vì vậy chỉ nên so sánh số phát hiện cùng một commit và
cùng cấu hình.

Để tách ảnh hưởng của working tree bẩn khỏi nợ đã có từ trước, cần nhìn thêm
hai mốc gần đây: snapshot ngày 2026-08-03 là 1.452 lỗi / 106 cảnh báo, còn
snapshot ngày 2026-08-22 là 1.469 lỗi / 109 cảnh báo. Trong phần chênh lệch
gần nhất, đã xác nhận 1 finding `react-refresh` mới tại `shouldCenterVirtuosoList`;
phần lớn các finding ở những file thay đổi nhiều vẫn là nợ tồn tại từ trước,
không phải một đợt phát sinh mới trên diện rộng.

## 4. Phân bố theo rule

| Rule | Tổng | Errors | Warnings | Source | Test | Nhận định |
|---|---:|---:|---:|---:|---:|---|
| `@typescript-eslint/no-explicit-any` | 1.173 | 1.173 | 0 | 1.049 | 124 | Nợ hợp đồng dữ liệu/API lớn nhất |
| `@typescript-eslint/no-unused-vars` | 157 | 157 | 0 | 139 | 18 | Mã/import dư; cần phân biệt chữ ký API |
| `react-hooks/exhaustive-deps` | 99 | 0 | 99 | 99 | 0 | Có thể gây closure cũ hoặc timing sai |
| `react-refresh/only-export-components` | 60 | 60 | 0 | 60 | 0 | Vượt budget, ảnh hưởng Fast Refresh/CI |
| `react-hooks/set-state-in-effect` | 20 | 20 | 0 | 20 | 0 | Có nguy cơ render dây chuyền, cần review hành vi |
| `no-empty` | 18 | 18 | 0 | 18 | 0 | Có thể nuốt lỗi nếu là `catch` rỗng |
| `@typescript-eslint/ban-ts-comment` | 14 | 14 | 0 | 14 | 0 | Vùng TypeScript bị tắt kiểm tra |
| `eslint/unused-disable` | 10 | 0 | 10 | 10 | 0 | Ngoại lệ cũ không còn tác dụng |
| `prefer-const` | 9 | 9 | 0 | 9 | 0 | Ứng viên sửa cơ học, rủi ro thấp |
| Các rule còn lại | 18 | 18 | 0 | 16 | 2 | React refs/memoization/purity và lỗi nhỏ |

Hai nhóm chi phối là `no-explicit-any` (74,3% tổng phát hiện) và
`no-unused-vars`. Không nên thay `any` hàng loạt bằng `unknown`; cần bắt đầu ở
biên API/Tauri/PDF rồi để type lan vào UI.

## 5. File và khu vực tập trung

Tổng phát hiện theo khu vực:

| Khu vực | Phát hiện |
|---|---:|
| `src/components` | 867 |
| `src/lib` | 538 |
| `src/hooks` | 94 |
| `src/stores` | 32 |
| phần còn lại | 47 |

Các file đứng đầu:

| File | Phát hiện |
|---|---:|
| `src/components/ImpositionTab.tsx` | 127 |
| `src/lib/processHandlers.ts` | 114 |
| `src/components/workspace/LivePageFrame.tsx` | 103 |
| `src/lib/pdfImposer.ts` | 80 |
| `src/components/AcrobatViewer.tsx` | 62 |
| `src/components/imposition-tools/ImposerDashboard.tsx` | 50 |
| `src/components/imposition-tools/sections/GridPreview.tsx` | 44 |
| `src/hooks/viewer/usePdfLoader.ts` | 38 |
| `src/lib/imposerEngine/InstructionSerializer.ts` | 37 |

Nhóm bình bản (`components/imposition-tools` và `lib/imposerEngine`) vẫn là
vùng rủi ro cao vì vừa nhiều `any` vừa có hook/state ảnh hưởng kết quả nghiệp vụ.

## 6. Budget và CI

Budget lưu tại [lint-budget.json](../desktop/scripts/lint/lint-budget.json:1):
1.549 errors, 113 warnings và giới hạn riêng cho từng rule. Script kiểm tra
không chỉ tổng số mà còn từng rule tại
[check-budget.mjs](../desktop/scripts/lint/check-budget.mjs:29).

Kết quả chạy hiện tại:

| Chỉ số vượt budget | Thực tế | Budget | Chênh |
|---|---:|---:|---:|
| `react-refresh/only-export-components` | 60 | 32 | +28 |
| `eslint/unused-disable` | 10 | 9 | +1 |

Tổng errors và warnings hiện thấp hơn trần, nhưng gate vẫn trả exit code 1 do
rule ratchet. CI gọi trực tiếp `npm run lint:budget` tại
[ci.yml](../.github/workflows/ci.yml:73), nên đây là lỗi gate thực tế, không chỉ
là cảnh báo nội bộ.

## 7. Ưu tiên xử lý đề xuất

### P1 — Đưa lint budget về xanh

Truy nguồn 60 `react-refresh/only-export-components` và 10
`eslint/unused-disable`; sửa theo lô nhỏ, không nâng budget. Rule Refresh thường
cần tách constant/helper khỏi component, còn unused-disable có thể xử lý cơ học
sau khi xác minh.

### P1/P2 — Review React Hooks theo miền

99 cảnh báo `exhaustive-deps` và 20 lỗi `set-state-in-effect` có khả năng đổi
hành vi. Không chạy autofix toàn kho; ưu tiên viewer, workspace, bình bản và
preprocess, mỗi lô tối đa 5 file kèm test hồi quy.

### P2 — Giảm nợ kiểu dữ liệu tại biên

1.173 `no-explicit-any` là chiến dịch dài hạn. Ưu tiên payload API/sidecar,
Tauri invoke, PDF/imposition contract; không sửa cơ học trong một commit.

### P2/P3 — Dọn mã chết và suppression

Xử lý `no-unused-vars`, `no-empty`, `prefer-const` và `ban-ts-comment` theo miền,
đặc biệt kiểm tra các `catch` rỗng trước khi thêm log hoặc throw mới.

## 8. Giới hạn audit

- Chỉ audit ESLint frontend TypeScript/React; chưa audit Python, Rust hoặc
  dependency vulnerability.
- Chưa chạy `--fix`, chưa sửa code, chưa đổi budget.
- Chưa tuyên bố runtime sạch; số liệu này là bằng chứng tĩnh/tự động mức 1–2.
- Vì working tree đang dirty, cần chạy lại trên commit sạch trước khi dùng số
  liệu làm mốc phát hành chính thức.

## 9. Kết luận chốt

Nợ lint cũ **vẫn tồn tại**, hiện ở mức **1.469 errors / 109 warnings** và cổng
CI đang fail theo rule. Con số “hơn 1.000 lỗi” trước đây là đúng, nhưng baseline
đã thay đổi; báo cáo này là mốc mới để bắt đầu xử lý có kiểm soát.

Chưa sửa hàng loạt trong lượt audit này. Bước tiếp theo cần user duyệt phạm vi
P1 (khôi phục budget) trước khi mở các lô sửa tiếp theo.
