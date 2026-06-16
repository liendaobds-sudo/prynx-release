# Design Document

## Overview

Tính năng "Gửi Máy Bế" thêm một **đường ống xuất dữ liệu cắt** vào Prynx: từ kết quả bình bài (Bình Tem Bế / Bình Bế Rớt CNC) → dựng **Cut Model** trung gian (độc lập máy) → qua **Emitter** (theo Machine Profile) → **Transport** (file/LAN/serial) → tới máy cắt.

Thiết kế bám 3 trục mở rộng độc lập (Requirement 2): **Machine Profile** (khai báo phương ngữ máy) × **Emitter** (định dạng đầu ra) × **Transport** (kênh truyền). Thêm máy mới = thêm dữ liệu profile, không sửa lõi.

Nguyên tắc cốt lõi đã chốt ở Requirements:
- Lõi sinh đường cắt ở **hệ mét tuyệt đối (mm)**; mọi khác biệt máy (đơn vị PLU, gốc toạ độ, lệnh) dồn vào Emitter/Profile.
- Đọc thẳng toạ độ đường cắt từ layout bình (không phụ thuộc spot-color); tuân thủ tên nhóm/ô từ cài đặt ốc (`PontConfig`).
- Khớp bản in 3 chế độ: (a) cảm biến onboard/khung, (b) thủ công 3–4 điểm + affine, (c) computer vision (ngoài phạm vi).
- OSS chỉ tham khảo (GPL), không copy code vào sản phẩm đóng.

## Architecture

```
[Bình bài: nup_engine.run_nup_engine / nup_diecut]
        │  (đã có: extract_page_die_cut_polygon → Shapely Polygon, vị trí ốc, layout)
        ▼
[CutModelBuilder]  (backend/app/workers/cut_export/cut_model.py)
        │  → CutModel { paths[], marks[], sheet, toolTags } ở đơn vị mm
        ▼
[Registration]  (cut_export/registration.py)  ─ chế độ (a)/(b)
        │  (b): nhận 3–4 điểm đo thực → tính affine → warp paths
        ▼
[Emitter]  (cut_export/emitters/*)  ── chọn theo MachineProfile.emitter
        ├─ command_stream  (HPGL PU/PD, Yuty U/D, …)
        ├─ vector_file      (DXF / PDF-EPS spot-color / SVG)
        └─ gcode            (mở rộng sau)
        ▼
[Transport]  (cut_export/transport/*)  ── theo MachineProfile.transport
        ├─ file   (.plt/.dxf/.svg/.pdf/.nc)
        ├─ tcp    (LAN, cổng cấu hình; mặc định 9100)
        └─ serial (COM, baud + flow control)
        ▼
        [Máy bế]
```

Điểm tích hợp UI: nút "Xuất/Gửi máy bế" ở `ImpositionTab`/`ImposerDashboard` (Requirement 6) → gọi route mới `POST /imposition/cut-export` (FastAPI, cạnh `imposition.py`).

## Components and Interfaces

### 1. CutModel (mô hình cắt nội bộ — độc lập máy)
File: `backend/app/workers/cut_export/cut_model.py`

```python
@dataclass
class CutPath:
    points: list[tuple[float, float]]  # mm, đã làm phẳng (polyline), gốc dưới-trái
    closed: bool
    tool_tag: str | None       # 'shared' | 'left' | 'right' | tên dao tuỳ cấu hình
    block_id: int              # cụm/loại (phục vụ thứ tự cắt, song đạo)

@dataclass
class RegMark:
    x: float; y: float          # mm, tâm ốc
    kind: str                   # 'L' | 'cross' | 'circle' | 'square'

@dataclass
class CutModel:
    paths: list[CutPath]
    marks: list[RegMark]
    sheet_w_mm: float; sheet_h_mm: float
    frame: tuple[float, float, float, float] | None  # bbox tâm ốc (cho FSIZE)
    source_names: dict          # tên group/item/layer từ PontConfig (hợp đồng đặt tên)
```

Builder `build_cut_model(impose_result, pont_config) -> CutModel`:
- Lấy polygon đường cắt từ `nup_diecut.extract_page_die_cut_polygon` cho từng con + vị trí theo layout bình (Requirement 1.1, 1.4).
- Làm phẳng bezier ≤ 0.2mm + nén RDP ~0.03mm (Requirement 1.2). Tái dùng thuật toán flatten/RDP đã có trong script JSX (port sang Python/Rust).
- Gắn `tool_tag`/`block_id` và `source_names` theo `PontConfig.groupName/itemName/layerName` (Requirement 1.5).
- `frame` = bbox tâm các `marks` (cho chế độ FSIZE).

### 2. MachineProfile (schema khai báo máy)
File: profiles JSON ở `backend/app/workers/cut_export/profiles/*.json`; loader `profile.py`.

```jsonc
{
  "id": "yuty_a3_max",
  "vendor": "Yuty/Skycut",
  "model": "A3 Max",
  "emitter": "command_stream",         // command_stream | vector_file | gcode
  "dialect": "skycut_ud",              // skycut_ud | hpgl_pupd | gpgl | dmpl ...
  "resolution_plu_per_mm": 40.0,       // BẮT BUỘC (Req 2.6)
  "origin": "bottom_left",             // bottom_left | top_left | blade_current
  "flip_y": false,
  "swap_xy": false,
  "separator": " ",                    // " " (Yuty) | ";" (HPGL)
  "header_template": "IN FSIZE{fw},{fh} CMD:32,{aw},{ah},360,360; CMD:18,1; CMD:103,5; CMD:35,{tool},{pressure},{offset}; TB26,{fw},{fh} ",
  "footer_template": "U0,0 @ @ ",
  "pen_up": "U{x},{y} ",
  "pen_down": "D{x},{y} ",
  "registration": { "mode": "onboard_frame", "frame_cmd": "FSIZE" },  // onboard_frame | manual_affine | cv
  "blade": { "embed_force_speed": false, "blade_offset_plu": 0, "overcut_plu": 0 },
  "dual_head": { "enabled": false, "switch_cmd": "CMD:35,{slot};" },
  "filename": { "pattern": "{barcode}", "ext": "plt", "encoding": "ascii" },
  "transport": { "default": "file", "tcp_port": 9100, "serial_baud": 9600, "flow_control": "rtscts" },
  "limits": { "max_w_mm": 297, "max_h_mm": 420 },
  "source_ref": "scripts/illustrator/dev campuchia v5.6.jsx (exportCutLayerToPLT)"
}
```

Loader (Requirement 2.5): validate trường bắt buộc (`resolution_plu_per_mm`, `emitter`, `dialect`/format) → từ chối + báo lỗi cụ thể nếu thiếu.

Profile sẵn có (Requirement 2.4): `yuty_a3_max.json` (port từ JSX), `generic_hpgl.json` (PU/PD, `;`, IN/SP1).

### 3. Registration (khớp bản in)
File: `cut_export/registration.py` (Requirement 4.8–4.9)

- **(a) onboard_frame**: chỉ tính `frame` (FSIZE) từ tâm ốc; máy tự dò. Không biến đổi toạ độ paths.
- **(b) manual_affine**: API nhận **toạ độ thiết kế của N ốc** và **toạ độ đo thực** (do thợ rê dao báo về). Tính ma trận affine 2D (least-squares cho ≥3 điểm) rồi `warp(path)` toàn bộ paths trước khi emit.
  ```python
  def solve_affine(design_pts, measured_pts) -> Affine2x3: ...
  def apply_affine(cut_model, M) -> CutModel: ...
  ```
- **(c) cv**: interface để mở rộng; không hiện thực giai đoạn này.

### 4. Emitter (interface chung)
File: `cut_export/emitters/base.py`

```python
class Emitter(Protocol):
    def emit(self, model: CutModel, profile: MachineProfile) -> bytes: ...
```

- `command_stream.py`:
  - Đổi mm → PLU bằng `resolution_plu_per_mm`; áp `origin`/`flip_y`/`swap_xy`.
  - Sắp thứ tự cắt (bottom→top, left→right) + định tuyến song đạo theo `tool_tag` (Requirement 4.6).
  - Sinh header/footer/pen_up/pen_down từ template profile; chèn `frame` cho FSIZE (Requirement 4.1–4.3, 4.5).
  - Dialect `skycut_ud` ⇒ `U/D`, separator space; `hpgl_pupd` ⇒ `PU/PD;`. Đối chiếu mẫu PLT JSX để khớp cấu trúc (Requirement 4.7).
- `vector_file.py`: DXF (`LWPOLYLINE`, mm, R12/R14, KHÔNG spline), PDF/EPS (đường cắt trên spot-color đặt tên — Req 3.2, stroke-only, 1:1), SVG (path phân lớp theo dao). Vẽ ốc nếu cần (Req 3.4).
- `gcode.py`: placeholder (ngoài phạm vi).

### 5. Transport (interface chung)
File: `cut_export/transport/base.py`

```python
class Transport(Protocol):
    def send(self, data: bytes, profile: MachineProfile) -> SendResult: ...
```

- `file.py`: ghi đuôi đúng + đặt tên theo `filename.pattern` (Req 5.1).
- `tcp.py`: socket tới `IP:port` (mặc định 9100), timeout, trả trạng thái (Req 5.2, 5.4).
- `serial.py`: baud + **flow control RTS/CTS hoặc XON/XOFF**, tiết lưu tốc độ chống tràn buffer (Req 5.5).
- Bảo vệ: chỉ gửi tới đích người dùng cấu hình, chạy nền không chặn UI (Req 5.6, 8.5).

### 6. API & UI
- Route: `POST /imposition/cut-export` (backend `app/api/routes/imposition.py`), body: `{ impose_job_id | layout_payload, profile_id, emitter?, transport?, registration_points? }`. Trả preview cells + (file path | trạng thái gửi).
- Route phụ: `GET /imposition/cut-profiles` (liệt kê profile), `POST /imposition/cut-profiles` (tạo/sửa — Req 7).
- UI: nút "Xuất/Gửi máy bế" trong `ImposerDashboard` (chỉ hiện ở mode Tem Bế/CNC — Req 6.1); modal chọn Profile/Emitter/Transport + xem trước (Req 6.2, 8.1); chế độ một chạm khi đã có mặc định (Req 6.4).

## User Workflow (trải nghiệm người dùng sau khi hoàn thành)

### Cài đặt một lần (mỗi máy)
1. Mục "Máy bế" → **Thêm máy** → chọn profile có sẵn (Yuty A3 Max / Generic HPGL) hoặc tạo mới.
2. Khai báo kết nối: LAN (IP + cổng, mặc định 9100) / COM (cổng + baud) / Lưu file.
3. Chọn chế độ khớp dấu: cảm biến onboard / dò thủ công 3–4 điểm / không khớp dấu.
4. Đặt máy mặc định để lần sau chạy một chạm.

### Thao tác hằng ngày
1. **Bình bài** như hiện tại (Tem Bế / Bế Rớt CNC).
2. **In tờ**: in file in (hình + dấu định vị) bằng máy in.
3. **Bấm "Gửi máy bế"**: hộp thoại → chọn máy → xem trước đường cắt + ốc → chọn cách đưa (gửi LAN / lưu `.plt` / xuất vector).
4. **Đưa tờ đã in vào máy, cắt** theo loại máy:
   - Yuty (onboard): gửi LAN kèm FSIZE → máy tự dò ốc + cắt.
   - Dò thủ công: app hướng dẫn rê dao tới 3–4 ốc → tính affine → cắt khớp.
   - Máy chưa có profile: xuất DXF/PDF `CutContour` → mở bằng phần mềm máy.

### Khác biệt so với hiện tại
- Trước: bình → lưu file khuôn → mở Corel/Illustrator + plugin hãng → cắt.
- Sau: bình → **một nút "Gửi máy bế"** → cắt thẳng (hoặc xuất file chuẩn). Bỏ bước qua Corel/plugin.
- Vì Prynx bình cả phần in lẫn đường cắt cùng lúc → dữ liệu cắt luôn khớp toạ độ bản in.

## Data Models
Xem CutModel & MachineProfile ở trên. Bổ sung:

```python
@dataclass
class SendResult:
    ok: bool
    channel: str            # 'file'|'tcp'|'serial'
    detail: str             # path hoặc thông điệp lỗi
    bytes_sent: int
```

## Error Handling
- Không có đường cắt hợp lệ → lỗi rõ, không xuất file rỗng (Req 1.5).
- Profile thiếu/không hợp lệ → từ chối nạp, nêu trường lỗi (Req 2.5).
- Tên nhóm/ô không khớp `PontConfig` → báo lỗi hợp đồng đặt tên (Req 1.5).
- Khổ/khung vượt `limits` → cảnh báo trước khi gửi (Req 8.2).
- Gửi LAN/serial thất bại (timeout, mất kết nối) → báo lỗi, không treo im lặng (Req 5.4).
- Mọi job ghi log: profile, emitter, transport, thời điểm, kết quả (Req 8.3).

## Testing Strategy
- **Đơn vị (không cần máy):**
  - CutModelBuilder: flatten/RDP sai số, giữ vị trí layout, gắn tên từ PontConfig.
  - command_stream: đối chiếu **byte-cấu trúc với mẫu PLT do JSX xuất** trên cùng đầu vào (Req 4.7) — golden test.
  - affine: bộ điểm lệch/xoay/co giãn đã biết → kiểm ma trận + warp đúng.
  - vector_file: DXF chỉ `LWPOLYLINE`, PDF spot-color đúng tên, 1:1.
  - profile loader: thiếu trường → từ chối.
  - đơn định: cùng input+profile → cùng bytes (Req 8.4).
- **Tích hợp (giả lập):** transport file; tcp/serial dùng loopback/mock server.
- **Trên máy thật (sau, ngoài CI):** hiệu chỉnh lực/tốc/offset, sai số dò dấu chế độ (a)/(b).

## Lộ trình hiện thực (map sang Requirements)
1. **Pha 1** — CutModel + vector_file (DXF/PDF spot-color/SVG) + transport file. Phủ phổ quát, không cần máy. (Req 1,3,5.1,8)
2. **Pha 2** — command_stream (Yuty `skycut_ud` + Generic HPGL) + transport file/tcp; golden test đối chiếu JSX. (Req 2,4.1–4.7,5)
3. **Pha 3** — registration manual_affine + onboard_frame hoàn chỉnh; UI dò dấu 3–4 điểm. (Req 4.8–4.9)
4. **Pha 4** — quản lý/onboarding profile + đối chiếu file mẫu. (Req 7)

## Correctness Properties

### Property 1: Đơn định (Determinism)
Cùng (CutModel + Profile) → cùng chuỗi bytes đầu ra. Cho phép golden test và đối chiếu với mẫu PLT của JSX.
**Validates: Requirements 8.4, 4.7**

### Property 2: Bảo toàn tỉ lệ
Với mọi path, `output_coord = round(mm * resolution_plu_per_mm)` sau khi áp origin/flip/swap; không méo tỉ lệ (sai PLU bị chặn bởi profile bắt buộc).
**Validates: Requirements 2.6, 3.5**

### Property 3: Bảo toàn vị trí layout
Vị trí từng con trong đầu ra trùng vị trí đã bình (không tự căn lại) → cắt khớp bản in.
**Validates: Requirements 1.4, 6.3**

### Property 4: Khớp dấu chính xác (chế độ manual_affine)
Sau khi áp affine từ ≥3 điểm đo, sai số tại các điểm ốc tiệm cận 0 (nội suy đúng); toàn bộ paths được warp nhất quán bằng cùng một ma trận.
**Validates: Requirements 4.9**

### Property 5: Toàn vẹn hợp đồng tên
Đường cắt/ốc trong CutModel phải mang đúng tên từ `PontConfig`; lệch tên → lỗi, không xuất.
**Validates: Requirements 1.5, 4.3**

### Property 6: Không rò rỉ dữ liệu
Transport chỉ gửi tới đích người dùng cấu hình; không gửi ra ngoài ngoài ý muốn.
**Validates: Requirements 5.6**

## Quyết định thiết kế & lý do
- **Đơn vị nội bộ mm, đẩy khác biệt vào Emitter/Profile:** tránh nhân bản logic; thêm máy = thêm dữ liệu (Req 2). [nguồn: cách RIP/CAM — Caldera, InkCut]
- **Đọc toạ độ trực tiếp, không spot-color cho command-stream:** Prynx kiểm soát pipeline nên biết đường cắt; spot-color chỉ cho nhánh vector-file bàn giao phần mềm thứ ba (đối chiếu chính script Yuty).
- **manual_affine là đường khớp dấu phủ rộng nhất:** không cần camera/CV, không cần phần mềm hãng (đã xác minh: SignCut/SignLab/SignMaster dùng dò thủ công 3 điểm).
- **Port flatten/RDP/U-D từ JSX:** tận dụng logic đã chạy thật cho Yuty, giảm rủi ro.
- **Không copy code GPL:** chỉ tham khảo cách làm (Req 9).
