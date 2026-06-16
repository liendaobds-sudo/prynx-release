# Design Document

> Thiết kế kỹ thuật — Công cụ "Bình Bế Rớt (CNC)"

> ⚠️ **CẬP NHẬT — TRẠNG THÁI THỰC TẾ (đồng bộ với code).**
> Thiết kế gốc này đã được **thay thế** bởi spec `cnc-multi-template` (xem thư mục
> `.kiro/specs/cnc-multi-template/`). Code hiện tại KHÁC thiết kế gốc ở các điểm:
> - Render KHÔNG nằm trong nhánh repeat của `nup_engine`. `nup_engine.run_nup_engine`
>   chỉ **định tuyến** `imposerMode=='cnc'` sang module riêng `cnc_render.run_cnc_two_sided`.
> - Layout Mặt trước: chế độ **Bình trang (S&R, layoutType=='repeat')** dùng
>   `compute_sticker_layout_for_page` (đúng solver Bình Tem Bế); chế độ **Dàn nhiều mẫu**
>   dùng `build_cnc_front_layout` (bin-pack trộn, `cnc_layout.py`).
> - Lật gương Mặt sau do `cnc_render.mirror_placements_multi` đảm nhiệm.
>   **Module `cnc_geometry.py` đã bị XÓA** (từng là code chết).
> - Dấu canh: KHÔNG có `cncMarkType` nhiều loại / `draw_cnc_marks`. Thực tế chỉ có
>   **một** loại dấu canh 2 mặt — cờ boolean `cncDuplexMarks` → `cnc_marks.draw_duplex_marks`.
> Phần dưới giữ nguyên làm lịch sử thiết kế ban đầu.

## Overview

Thêm công cụ **Bình Bế Rớt (CNC)** dưới dạng **card mới** + **chế độ riêng** (`cnc_imposer`) tái dùng toàn bộ dashboard/engine/report/lưu-file của Bình Tem Bế. Khác biệt khu trú vào 3 điểm:
1. **Bình 2 mặt**: ghép cặp trang (trước/sau), mặt sau **lật gương**.
2. **Dấu canh CNC** (nhiều loại) thay cho pont/ốc của tem.
3. **Xuất 3 trang/đơn vị**: Mặt trước → Mặt sau → Khuôn (1 mặt → 2 trang).

Nguyên tắc: **không fork solver** — layout vẫn do `compute_sticker_layout_for_page` (Rust) tính cho mặt trước; mặt sau suy ra bằng phép lật gương trên cùng tập vị trí ô; trang khuôn tái dùng cơ chế `separate_cut_page` sẵn có.

## Architecture

```
Menu: card "Bình Bế Rớt (CNC)"  (toolRegistry: id 'diecut', defaultPayload.lockedMode='cnc_imposer')
        │
ImposerDashboard (activeTool='cnc_imposer')  → tái dùng GridSettings/Advanced/Output sections
   UI riêng CNC: [In 2 mặt] [Cạnh lật] [Dấu canh CNC]
        │  handleExecute → onStartNup({ ...settings, imposerMode:'cnc', cncTwoSided, cncFlipEdge, cncMarkType })
        ▼
processHandlers.runProcessEngine → backendSettings (thêm khóa cnc*)  → /imposition/impose-start
        ▼
nup_engine.run_nup_engine  (nhánh repeat, isDieCut)
   với mỗi cặp (front_idx, back_idx):
     layout = compute_sticker_layout_for_page(front_page)        # solver Rust dùng chung
     Trang 1 (Mặt trước): đặt artwork front theo layout
     Trang 2 (Mặt sau):   đặt artwork back theo layout ĐÃ LẬT GƯƠNG (theo cncFlipEdge)
     Trang 3 (Khuôn):     đường bế (tái dùng separate_cut_page)
   + vẽ dấu canh CNC trên các trang
        ▼
SavePrintFilesModal (tái dùng): tách In/Sau/Khuôn ra file, đặt tên theo report
```

## Components and Interfaces

### 1. Frontend — Tool registry & capability
- `toolRegistry.ts`: thêm entry card "Bình Bế Rớt (CNC)" (icon riêng, `defaultPayload: { lockedMode: 'cnc_imposer' }`).
- `types.ts`: thêm `'cnc_imposer'` vào `TaskMode`/`ActiveToolType`; `getImposerCapability('cnc')` khai báo: `supportsTwoSided=true`, `supportsCncMarks=true`, `supportsPont=false`, `supportsHexNesting=true` (xếp giống tem).

### 2. Frontend — Store
Thêm (persist):
```ts
cncTwoSided: boolean;          // bật bình 2 mặt
cncFlipEdge: 'long' | 'short'; // cạnh lật, default 'long'
cncMarkType: string;           // loại dấu canh CNC
```

### 3. Frontend — UI (sections, chỉ hiện khi activeTool==='cnc_imposer')
- Khối "BÌNH 2 MẶT": checkbox **In 2 mặt** + select **Cạnh lật** (Cạnh dài/Cạnh ngắn) + **preview ghép cặp** (Trang 1=Trước, Trang 2=Sau…).
- Select **Dấu canh CNC** (danh sách bên dưới).
- Ẩn các option của tem: pont/ốc, 1 Dao.

### 4. Backend — `nup_engine` nhánh repeat (mở rộng cho CNC 2 mặt)
- Đọc settings: `cnc_two_sided`, `cnc_flip_edge`, `cnc_mark_type`, `imposer_mode=='cnc'`.
- Khi `cnc_two_sided`:
  - Lặp theo **cặp** `(p_front, p_back)` = (trang 2k, 2k+1). Nếu số trang lẻ → báo lỗi.
  - Dùng `full_layouts[p_front]` (đã tính bằng solver) cho Mặt trước.
  - **Mặt sau**: cùng layout, mỗi ô lật gương (mục 5) + đặt artwork của `p_back`.
  - **Khuôn**: tái dùng `separate_cut_page` (đường bế của layout).
  - Thứ tự trang output: Trước, Sau, Khuôn.
- Khi tắt 2 mặt: Mặt trước + Khuôn (2 trang).

### 5. Backend — phép lật gương mặt sau (`nup_marks`/util mới `cnc_geometry.py`)
Cho mỗi ô `(x, y, w, h)` trên vùng dùng được rộng `W`, cao `H`:
- **Lật cạnh dài (long-edge, mặc định)** = lật ngang: `x' = W - (x + w)`, `y' = y`, kèm cờ mirror cho nội dung.
- **Lật cạnh ngắn (short-edge)** = lật dọc: `x' = x`, `y' = H - (y + h)`.
- Đảm bảo ô sau khi lật **đối xứng** ô mặt trước → bế 2 mặt trùng. (Unit test thuần được — không cần PDF.)

### 6. Backend — Dấu canh CNC (`cnc_marks.py`)
Vẽ dấu canh theo `cnc_mark_type`; danh sách khởi đầu (chốt khi code):
- `graphtec` (dấu đăng ký Graphtec: 3-4 dấu vuông góc),
- `corner` (4 góc),
- `circle` (dấu tròn camera),
- `none`.
Vẽ nhất quán trên Mặt trước & Mặt sau (vị trí khớp sau lật).

### 7. Tái dùng Report & Lưu file
- Report + tờ duy nhất + bảng tổng hợp: dùng nguyên `nup_report`. Số tờ tính theo mặt trước.
- `SavePrintFilesModal`: bố cục trang giờ là bộ 3 (Trước/Sau/Khuôn) → builder tách 3 loại file; tái dùng `buildSavePlan` (mở rộng nhận "kind" = front/back/cut).

## Data Models

### Settings bổ sung (FE store → backendSettings → engine)
```
imposerMode: 'cnc'
cncTwoSided: bool
cncFlipEdge: 'long' | 'short'   # default 'long'
cncMarkType: 'graphtec'|'corner'|'circle'|'none'
```

### Bố cục trang output
- 2 mặt: `[Front_A, Back_A, Cut_A, Front_B, Back_B, Cut_B, ...]`
- 1 mặt: `[Front_A, Cut_A, ...]`

## Error Handling
- Số trang lẻ khi bật 2 mặt → báo lỗi rõ, dừng job an toàn (Yêu cầu 2.2).
- Mặt sau thiếu (file chỉ có mặt trước) → cảnh báo, cho phép chạy 1 mặt.
- `cnc_mark_type` không hợp lệ → fallback 'none', log cảnh báo.
- Lật gương khi layout rỗng → bỏ qua an toàn.

## Testing Strategy
- **Unit thuần (`cnc_geometry`):** phép lật gương long/short-edge — đối xứng đúng, không âm toạ độ.
- **Integration engine:** file 2 trang (trước/sau) + 2 mặt → output 3 trang đúng thứ tự; ô mặt sau đối xứng ô mặt trước; số trang lẻ → lỗi.
- **Regression:** Bình Tem Bế/N-Up/Booklet không đổi; `tests/` giữ pass.
- **Frontend:** `tsc --noEmit` pass; card mới mở đúng dashboard với option CNC.

## Correctness Properties

### Property 1: Đối xứng mặt sau (long-edge)
Với lật cạnh dài, mọi ô: `x_back = W - (x_front + w)` và `y_back = y_front`; tâm ô sau = phản chiếu tâm ô trước qua trục dọc giữa tờ.
**Validates: Requirements 3.1, 3.3**

### Property 2: Đối xứng mặt sau (short-edge)
Với lật cạnh ngắn: `y_back = H - (y_front + h)`, `x_back = x_front`.
**Validates: Requirements 3.2, 3.3**

### Property 3: Số trang output đúng
2 mặt → mỗi cặp sinh đúng 3 trang theo thứ tự Trước/Sau/Khuôn; 1 mặt → 2 trang (Trước/Khuôn).
**Validates: Requirements 5.1, 5.3**

### Property 4: Bảo toàn số lượng (tái dùng)
Số tờ cần in tính theo mặt trước = `ceil(qty / SL_trên_tờ)` (như Bình Tem Bế).
**Validates: Requirements 6.1**
