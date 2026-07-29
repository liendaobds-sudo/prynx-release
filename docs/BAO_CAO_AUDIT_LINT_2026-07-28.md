# Báo cáo audit nợ ESLint toàn kho — 2026-07-28

## 1. Phạm vi và kết luận

Audit phần TypeScript/React trong `desktop/` bằng đúng cấu hình ESLint hiện hành, không sửa mã nguồn và không chạy `--fix`.

**Kết luận:** cần xử lý, nhưng không được coi 1.526 lỗi là một lô sửa cơ học. Phần lớn là nợ kiểu dữ liệu lâu năm; nhóm React Hooks nhỏ hơn nhưng có rủi ro hành vi cao hơn và phải được sửa kèm test theo miền chức năng. Không nên tắt rule hoặc nâng budget để làm xanh giả.

Hiện lint **không chứng minh có lỗi runtime tức thời**, nhưng đã mất vai trò cổng chất lượng: `npm run lint` luôn đỏ, còn `npm run lint:budget` cũng đang đỏ do phát sinh mới vượt baseline.

## 2. Baseline có thể tái hiện

Lệnh audit:

```powershell
cd desktop
npx eslint . --format json
```

| Chỉ số | Kết quả |
|---|---:|
| File được quét | 523 |
| File có phát hiện | 197 |
| Lỗi | 1.526 |
| Cảnh báo | 116 |
| Phát hiện có thể auto-fix | 24 (15 lỗi + 9 cảnh báo) |
| Phát hiện trong test | 127 |
| Phát hiện trong mã ngoài test | 1.515 |
| File có `@ts-nocheck` | 15 |
| File có `eslint-disable` | 19 |

### Phân bố theo rule

| Rule | Số lượng | Mức độ | Nhận định |
|---|---:|---|---|
| `@typescript-eslint/no-explicit-any` | 1.195 | lỗi | 78,3% tổng lỗi; nợ hợp đồng dữ liệu/API |
| `@typescript-eslint/no-unused-vars` | 200 | lỗi | mã chết, import/biến dư hoặc API đang dở |
| `react-hooks/exhaustive-deps` | 107 | cảnh báo | có thể gây closure cũ hoặc effect chạy sai |
| `react-refresh/only-export-components` | 32 | lỗi | chủ yếu ảnh hưởng vòng dev/Fast Refresh |
| `react-hooks/set-state-in-effect` | 27 | lỗi | cần xem lại luồng state; không sửa máy móc |
| `no-empty` | 19 | lỗi | có thể đang nuốt lỗi |
| `prefer-const` | 15 | lỗi | sửa cơ học, rủi ro thấp |
| `@typescript-eslint/ban-ts-comment` | 15 | lỗi | trùng đúng 15 file `@ts-nocheck` |
| `eslint/unused-disable` | 9 | cảnh báo | ngoại lệ cũ không còn tác dụng |
| Các rule React khác | 20 | lỗi | refs, memoization, immutability, purity |
| Các rule còn lại | 3 | lỗi | unused expression và async promise executor |

Các điểm tập trung lớn nhất:

- `ImpositionTab.tsx`: 168 phát hiện.
- `processHandlers.ts`: 97.
- `LivePageFrame.tsx`: 85.
- `pdfImposer.ts`: 78.
- `AcrobatViewer.tsx`: 63.
- Nhóm bình bản (`components/imposition-tools` và `lib/imposerEngine`) chiếm ít nhất 293 phát hiện, chưa tính `ImpositionTab.tsx` và `pdfImposer.ts`.

## 3. Tình trạng lint budget

Budget hiện tại lưu baseline cũ là 1.549 lỗi / 113 cảnh báo. Tổng lỗi thực tế đã giảm 23, nhưng gate vẫn thất bại vì budget được kiểm soát theo từng rule:

| Chỉ số vượt budget | Thực tế | Budget | Chênh |
|---|---:|---:|---:|
| Cảnh báo | 116 | 113 | +3 |
| `no-unused-vars` | 200 | 194 | +6 |
| `exhaustive-deps` | 107 | 104 | +3 |
| `set-state-in-effect` | 27 | 26 | +1 |
| `prefer-const` | 15 | 14 | +1 |

Điều này cho thấy budget đang làm đúng nhiệm vụ phát hiện hồi quy, nhưng các thay đổi gần đây đã tạo thêm nợ ở năm chỉ số. Việc đầu tiên phải là đưa các chỉ số này về baseline hoặc thấp hơn, không cập nhật budget lên số mới.

## 4. Phát hiện và ưu tiên

### P1 — Khôi phục cổng lint budget

Năm chỉ số trên đang vượt baseline. Nếu CI/release gọi `lint:budget`, pipeline sẽ thất bại; nếu không gọi, dự án đang thiếu cổng ngăn nợ mới. Cần truy nguồn từng phát hiện mới trong các file vừa thay đổi và sửa trước.

**Công sức:** S–M. **Rủi ro sửa:** thấp đến vừa.

### P1 — 154 phát hiện React Hooks có khả năng đổi hành vi

Gồm `exhaustive-deps`, `set-state-in-effect`, `refs`, `preserve-manual-memoization`, `immutability` và `purity`. Tập trung ở các màn hình lớn như bình bản, trình xem PDF và workspace. Thêm dependency một cách máy móc có thể tạo vòng lặp render; bỏ effect hoặc memoization có thể thay đổi timing.

**Công sức:** L–XL. **Rủi ro sửa:** cao; bắt buộc test theo màn hình/luồng.

### P2 — 1.195 `any` trong 150 file

Đây là nợ lớn nhất nhưng không nên sửa bằng thay thế hàng loạt sang `unknown` hoặc ép kiểu. Nên bắt đầu từ biên dữ liệu: kết quả `invoke`, API sidecar, cấu trúc PDF/bình bản và event payload; sau đó để kiểu lan vào phần UI.

**Công sức:** XL. **Rủi ro sửa:** vừa đến cao ở các engine cũ.

### P2 — 200 biến/import không dùng trong 71 file

Phần lớn có thể làm theo lô nhỏ, nhưng các callback/tham số giao diện có thể được giữ để tương thích. Cần phân biệt mã chết thật với chữ ký API bắt buộc.

**Công sức:** M. **Rủi ro sửa:** thấp.

### P2 — 15 vùng tắt kiểm tra TypeScript

`@ts-nocheck` đang che lỗi ở barcode, bình bản và modal lưu file. ESLint vẫn báo `ban-ts-comment`, nên đây không phải ngoại lệ đã được quản trị. Gỡ từng file chỉ sau khi bổ sung kiểu và chạy test miền tương ứng.

**Công sức:** L. **Rủi ro sửa:** vừa.

### P3 — Ngoại lệ và lỗi cơ học

Có 9 `eslint-disable` không còn tác dụng, 15 `prefer-const`, 19 khối rỗng và một số lỗi nhỏ khác. Đây là ứng viên cho lô mở đầu, nhưng khối `catch` rỗng phải được xem xét vì có thể đang cố ý best-effort.

**Công sức:** S. **Rủi ro sửa:** thấp.

## 5. Kế hoạch xử lý đề xuất

Mỗi lô tối đa 5 file, không trộn với chiến dịch Upscale đang nằm trong worktree.

1. **Lô 0 — khóa baseline:** xác định chính xác năm nhóm phát sinh vượt budget trong các file vừa thay đổi; đưa `lint:budget` về xanh mà không nâng ngưỡng.
2. **Lô 1 — vệ sinh rủi ro thấp:** `prefer-const`, unused disable, unused import/biến rõ ràng; chạy lint file + typecheck + test liên quan sau mỗi lô.
3. **Lô 2 — lỗi bị nuốt và TypeScript suppression:** xử lý `no-empty`, rồi gỡ `@ts-nocheck` theo từng miền, ưu tiên file nhỏ trước.
4. **Lô 3 — React Hooks theo miền:** workspace/viewer, preprocess, bình bản, dieline; mỗi miền có test hồi quy riêng, không auto-fix dependency toàn kho.
5. **Lô 4 — kiểu dữ liệu tại biên:** định nghĩa type cho API/Tauri/PDF engine, sau đó giảm `any` từ lớp lib sang component.
6. **Lô 5 — ratchet:** sau mỗi lô giảm `lint-budget.json` đúng bằng baseline mới; mục tiêu cuối cùng là 0 lỗi, không tăng lại budget.

### Verify bắt buộc cho mỗi lô

```powershell
cd desktop
npx eslint <tối đa-5-file-đã-sửa>
npm run typecheck
npx vitest run <test-liên-quan>
npm run lint:budget
```

Mốc kết thúc chiến dịch: `npm run lint`, `npm run lint:budget`, typecheck và toàn bộ vitest đều xanh; không còn `@ts-nocheck` không có lý do/issue truy vết.

## 6. Ngoài phạm vi audit này

- Chưa sửa bất kỳ lỗi lint nào trong đợt audit.
- Chưa thay đổi cấu hình ESLint hoặc budget.
- Chưa đánh giá lint Python/Rust; con số 1.526 chỉ thuộc frontend TypeScript/React.
- Các thay đổi Upscale và thay đổi của người dùng trong `.agents` được giữ nguyên.
