# Kiến Trúc Dự Án & Hướng Dẫn Phát Triển (Architecture & Dev Guide)

Tài liệu này mô tả cấu trúc hiện tại của dự án `prynx/desktop` và các quy chuẩn phát triển nhằm duy trì một codebase sạch, dễ bảo trì, và **ngăn chặn tình trạng phình to code (God Components)** như đã từng xảy ra với `ImpositionTab.tsx` và `AcrobatViewer.tsx`.

---

## 1. Cấu Trúc Thư Mục (Directory Structure)

Dự án tuân theo kiến trúc phân tách rõ ràng giữa UI (Giao diện), Logic (Trạng thái) và Service (Xử lý nền):

```text
desktop/src/
├── components/           # Toàn bộ UI Components của React
│   ├── imposition-tools/ # Các công cụ bên phải (Menu, Nup, Booklet, PaperSettings...)
│   ├── preprocess-tools/ # Các công cụ xử lý trước in (DataMerge, Split, Shuffle...)
│   ├── workspace/        # Các phần tử hiển thị chính (ViewerHelpers, SaveModal, LivePageFrame...)
│   ├── AcrobatViewer.tsx # Giao diện xem PDF chính
│   └── ImpositionTab.tsx # Component điều phối (Controller) chính của Tab Imposition
├── stores/               # Quản lý Trạng thái Toàn cục (Global State - Zustand)
│   └── useWorkspaceStore.ts # Lưu trữ mọi state của ImpositionTab
├── lib/                  # Các hàm tiện ích, cấu hình và giao tiếp API
│   ├── api.ts            # Gọi RPC xuống Python Backend
│   └── presetManager.ts  # Quản lý các cấu hình lưu sẵn
├── hooks/                # React Custom Hooks (Logic tái sử dụng)
├── engine/               # Logic cốt lõi (nếu có xử lý PDF nặng ở Frontend)
└── assets/               # Hình ảnh, font chữ tĩnh
```

---

## 2. Nguyên Tắc Cốt Lõi: Chống "God Component"

Trước đây, `ImpositionTab.tsx` chứa hơn 31 `useState` và truyền (prop drilling) xuống `AcrobatViewer` qua 28 props. Điều này gây ra:
- **Ác mộng bảo trì**: Thêm 1 tính năng mới phải sửa ở 4-5 file nối tiếp nhau.
- **Rác render (Re-render hell)**: Một state nhỏ thay đổi làm toàn bộ cây UI render lại.
- **Khó đọc**: File phình to lên hơn 1500 dòng code.

### ✅ Giải pháp đã áp dụng & Quy chuẩn mới:
1. **Component Nhỏ Nhất Có Thể (Single Responsibility):** Nếu một đoạn UI (ví dụ: Save Modal, Layers Panel) có thể đứng độc lập, **hãy tách nó ra thành 1 file riêng** đặt trong thư mục phù hợp (VD: `workspace/`).
2. **Không Prop Drilling:** Nếu một state phải truyền qua hơn 2 lớp Component con, **PHẢI** đưa state đó vào thư mục `stores/`.
3. **Phân biệt Smart vs Dumb Components:** 
   - **Smart Component** (như `ImpositionTab`): Chỉ dùng để đọc Store và phân bổ các Dumb Components. Không chứa giao diện chi tiết.
   - **Dumb Component** (như `LivePageFrame`): Chỉ nhận dữ liệu và render UI, logic xử lý phức tạp gọi ngược lại Store hoặc file tĩnh ngoài (`ViewerHelpers.ts`).

**Cập nhật Phase 1 (P1-T03):** Một số state liên quan imposition (activeDashboardTool, batchOutput, confirmBookletSettings) đã được di cư sang useImposerSettingsStore để giảm God Store và tuân thủ spec unification. Workspace store vẫn giữ tạm thời cho compatibility trong quá trình di trú. Xem PR Plan cho chi tiết.

---

## 3. Quản Lý Trạng Thái (State Management) với Zustand

Dự án dùng **Zustand** làm trung tâm lưu trữ thay vì React Context hay Redux vì tính gọn nhẹ và hiệu năng (không bọc Provider).

- **Vị trí:** `src/stores/useWorkspaceStore.ts`
- **Khi nào dùng `useState` (Local State)?**
  - Chỉ dùng cho các trạng thái UI tạm thời **chỉ tồn tại bên trong 1 component**. Ví dụ: `isHovered`, `dropdownOpen`, `inputText` (khi đang gõ).
- **Khi nào dùng `useWorkspaceStore` (Global State)?**
  - Khi dữ liệu cần chia sẻ cho nhiều Component (VD: `file`, `pdfUrl`, `selectedObjectIds`).
  - Khi một state ảnh hưởng đến giao diện gốc nhưng được kích hoạt từ Component con sâu bên trong.

**Cách dùng Store đúng chuẩn:**
```tsx
// ❌ SAI: Truyền qua props từ cha xuống con
<AcrobatViewer isSelectionMode={isSelectionMode} />

// ✅ ĐÚNG: Con tự gọi store để lấy state
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
const isSelectionMode = useWorkspaceStore(state => state.isSelectionMode);
```
*(Mẹo: Hãy trích xuất đích danh state cần dùng `state => state.abc` để tránh component re-render khi các state khác thay đổi).*

---

## 4. Hướng Dẫn Thêm Tính Năng Mới (Workflow)

Giả sử bạn cần phát triển thêm tính năng **"Watermark Tool"**:

**Bước 1: Khai báo State (nếu cần chia sẻ)**
Mở `src/stores/useWorkspaceStore.ts`, thêm state cho công cụ mới:
```typescript
interface WorkspaceState {
  // ...
  watermarkText: string;
  setWatermarkText: (text: string) => void;
}
```

**Bước 2: Tạo Component Độc Lập**
Tạo file mới tại `src/components/preprocess-tools/WatermarkTool.tsx`. Component này sẽ import `useWorkspaceStore` để tự đọc và ghi state.
Lưu ý: Không khai báo CSS style nội tuyến lằng nhằng, hãy dùng Tailwind CSS sẵn có. 

**Bước 3: Tích hợp vào Menu & Dashboard**
- Khai báo nút bật tính năng trong `ToolMenuList.tsx` (hoặc nơi phù hợp).
- Thêm điều kiện render trong `ImposerDashboard.tsx` hoặc `ImpositionTab.tsx` dựa theo `activeDashboardTool`.

**Bước 4: Logic Nặng Để Ở Đâu?**
- Nếu logic liên quan đến tính toán tọa độ, sinh mảng (array manipulation) không dính tới UI: Viết các hàm thuần (Pure Functions) `export const ...` đặt trong thư mục `lib/` hoặc dưới cùng của file (ngoài Component).
- **Tuyệt đối không nhét logic xử lý mảng khổng lồ vào trong `useEffect` của Component UI.**
- Nếu logic liên quan đến chỉnh sửa cấu trúc file PDF thật: Gửi API qua `lib/api.ts` để cho Python Backend (pikepdf) xử lý. Frontend chỉ đóng vai trò xem trước (Preview).

---

## 5. Quy Tắc "Code Sạch" Của Dự Án
1. **Không Dùng Export Bên Trong Hàm:** Các hàm `export const` tiện ích phải để ở ngoài cùng của File (Module-level). Vite/SWC Bundler sẽ crash nếu bạn để `export const helper = ...` ở trong thân của một React Component.
2. **Kiểm Tra TypeScript Thường Xuyên:** Chạy lệnh `npx tsc --noEmit` trước khi commit để đảm bảo không bị lỗi sai kiểu dữ liệu.
3. **Thanh Lý Component Chết:** Bất cứ file UI nào vượt quá 800 - 1000 dòng code là dấu hiệu cảnh báo đỏ (Red Flag). Khi đó, hãy dừng viết tính năng mới, phân tích và chia file đó thành 3-4 file nhỏ hơn trong cùng một thư mục con.
