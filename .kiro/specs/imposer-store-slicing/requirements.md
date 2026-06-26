# Requirements Document

## Introduction

`useImposerSettingsStore.ts` hiện là một store Zustand **monolith ~650 dòng** chứa
state của *tất cả* công cụ bình (paper, marks, report-tem, CNC, booklet, N-up,
auto-catalog, fold, UI, preprocessing, tool-profiles). Vì mọi tính năng đều sửa
chung 1 file (và 1 `persist version` + 1 `migrate` + 1 `partialize`), các thay đổi
của những tính năng KHÁC NHAU bị **trộn diff trong cùng file** — đúng vấn đề "lẫn
lộn" vừa gặp (booklet `blankPlacement` lẫn report `gangCount`).

Spec này tách store thành các **slice theo domain** đặt ở **file riêng**, để mỗi
tính năng chỉ chạm file slice của nó → diff không còn đè nhau. Đây là **refactor
thuần (không đổi hành vi)**: giữ nguyên API hook công khai và hình dạng state phẳng
để KHÔNG phải sửa hàng loạt consumer, giữ nguyên dữ liệu persist + migration.

### Mục tiêu cốt lõi (bất biến)
> **Tách file theo tính năng nhưng KHÔNG đổi hành vi.** Sau refactor: cùng API,
> cùng state phẳng, cùng dữ liệu localStorage (persist), cùng kết quả test. Người
> dùng và các component không nhận ra khác biệt; chỉ cấu trúc mã thay đổi.

## Glossary
- **Slice**: một mảnh state + actions của một domain, viết dạng
  `(set, get) => ({...})`, đặt ở file riêng (`bookletSlice.ts`…).
- **Combined store**: store cuối cùng ghép tất cả slice lại + bọc `persist` +
  Context/Provider + hook.
- **Public hook API**: `useImposerSettingsStore(selector)` + Provider hiện có —
  phải giữ nguyên chữ ký để consumer không phải sửa.
- **Profiled keys**: các field "thuật toán" lưu riêng theo công cụ
  (`ALGO_PROFILE_KEYS`) qua `switchToolProfile` — hành vi phải giữ nguyên.

## Requirements

### Requirement 1: Tách slice theo domain, mỗi domain một file
**User Story:** Là người bảo trì, tôi muốn mỗi domain state nằm ở file riêng, để
sửa một tính năng không đụng diff của tính năng khác.

#### Acceptance Criteria
1. WHEN refactor hoàn tất THEN store SHALL được ghép từ các slice file riêng theo
   domain: `paper`, `marks`, `report`, `cnc`, `booklet`, `nup`, `catalog`, `fold`,
   `ui`, `preprocessing`, `workspace`, `taskMode/toolProfiles`.
2. WHEN một tính năng thêm/sửa field THEN thay đổi SHALL khu trú trong file slice
   của domain đó (không sửa file slice domain khác).
3. WHERE một field hiện dùng chung nhiều công cụ (vd khổ giấy, lề — "vật lý") THE
   field đó SHALL nằm ở slice dùng chung (`paper`/`marks`), không nhân bản.

### Requirement 2: Giữ nguyên API hook & hình dạng state (không sửa consumer)
**User Story:** Là dev đang dùng store ở nhiều component, tôi muốn không phải sửa
lời gọi nào sau refactor.

#### Acceptance Criteria
1. WHEN refactor hoàn tất THEN `useImposerSettingsStore(selector)` và Provider/Context
   SHALL giữ nguyên chữ ký và đường import công khai.
2. THE hình dạng state tổng SHALL vẫn **phẳng** (cùng tên field/action như hiện tại),
   để mọi selector `s => s.signatureMode`… vẫn chạy y nguyên.
3. WHEN typecheck toàn dự án THEN SHALL không phát sinh lỗi do đổi cấu trúc store.
4. IF buộc phải sửa consumer THEN chỉ được sửa đường import (không đổi logic), và
   liệt kê rõ các file bị chạm.

### Requirement 3: Bảo toàn persistence & migration
**User Story:** Là người dùng đã có thiết lập lưu trong localStorage, tôi muốn
refactor không làm mất hay hỏng thiết lập đã lưu.

#### Acceptance Criteria
1. THE khoá persist (`name: 'ps_imposer_settings'`) SHALL giữ nguyên.
2. THE tập field được `partialize` (đưa vào localStorage) SHALL không đổi (cùng tập
   key như trước refactor).
3. THE chuỗi `migrate` v1→v7 SHALL được bảo toàn nguyên vẹn về hành vi (state cũ nạp
   lên ra kết quả y như trước).
4. WHEN thêm slice mới sau này THEN mỗi slice SHOULD khai báo phần `partialize` và
   bước `migrate` của riêng nó để compose, tránh sửa một hàm trung tâm khổng lồ.

### Requirement 4: Bảo toàn hành vi Tool Profiles
**User Story:** Là người dùng chuyển qua lại giữa N-up / Bế tem / Booklet, tôi muốn
state thuật toán mỗi công cụ vẫn được giữ riêng như hiện tại.

#### Acceptance Criteria
1. THE `switchToolProfile` + tập `ALGO_PROFILE_KEYS` SHALL giữ nguyên hành vi
   (lưu/khôi phục đúng các field thuật toán theo công cụ).
2. WHERE các profiled key trải trên nhiều slice THE việc gom chúng SHALL không làm
   sót/đổi field nào so với danh sách hiện tại.

### Requirement 5: An toàn bằng test (không hồi quy)
**User Story:** Là người bảo trì, tôi muốn có test chứng minh refactor không đổi
hành vi trước khi tin tưởng.

#### Acceptance Criteria
1. WHEN bắt đầu refactor THEN SHALL có (hoặc thêm) test "characterization" chụp hành
   vi store hiện tại: default state, partialize keys, migrate v6→v7, switchToolProfile.
2. WHEN refactor hoàn tất THEN toàn bộ test imposerEngine + store SHALL vẫn xanh và
   typecheck sạch.
3. THE test SHALL khẳng định tập `partialize` keys và default values KHÔNG đổi.

### Requirement 6: Phạm vi — chỉ cấu trúc, không tính năng
**User Story:** Là chủ dự án, tôi muốn refactor này không lén thêm/sửa tính năng.

#### Acceptance Criteria
1. THE refactor SHALL KHÔNG thêm field/tính năng mới, KHÔNG đổi default, KHÔNG đổi
   logic action (chỉ di chuyển + ghép lại).
2. IF phát hiện code chết trong store THEN SHALL chỉ ghi nhận/đề xuất, không xóa lẫn
   trong commit refactor (tách commit riêng nếu cần).
3. THE refactor SHALL thực hiện trên nền sạch (sau khi việc đang dở của report-tem
   đã được commit/tách riêng) để diff refactor không lẫn tính năng.

## Non-goals
- Không đổi UI, không đổi luồng bình.
- Không gộp/đổi tên field (chỉ di chuyển định nghĩa sang file slice).
- Không xử lý report-tem `gangCount` (đó là tính năng riêng, commit riêng).
