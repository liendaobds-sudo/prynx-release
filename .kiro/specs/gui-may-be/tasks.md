# Implementation Plan

## Overview

Kế hoạch hiện thực tính năng "Gửi Máy Bế" theo 4 pha. Nguyên tắc: TẤT CẢ code mới nằm trong module độc lập, KHÔNG sửa file có sẵn.
- Backend: `backend/app/workers/cut_export/`
- Frontend: `desktop/src/components/imposition-tools/cut-export/`

Các điểm bắt buộc phải nối vào file có sẵn (đăng ký router, gắn nút UI) được gom vào nhóm Integration (task 11–12) — additive tối thiểu, làm sau cùng khi đã duyệt, có trình bày diff trước.

## Tasks

### Pha 5 — Song đạo D1/D2/S CHUẨN theo script (phương án B: layout-aware)

> Mục tiêu: chia dao D1(_DTLeft)/D2(_DTRight)/S(_SHARED) đúng TOÁN CỘT của script,
> lấy layout có chỉ số cột/hàng (không trích từ PDF đã merge). Bám `dev campuchia v5.6.jsx`.

- [x] 13. Toán chia dao theo cột (thuần, verify công thức)
  - [x] 13.1 `cut_export/blade_routing.py`: `assign_blade(col_idx, num_cols)` — `half=floor(num/2)`; `<half`→left(D1); `>=num-half`→right(D2); giữa→shared(S); `num<=1`→S
  - [x] 13.2 Test khớp công thức script (chẵn/lẻ cột, fill, ≤1 cột)
  - _Requirements: 4.6_

- [ ] 14. Reconciliation toạ độ (swapXY/flip/offset) — **CHẶN: cần hiệu chỉnh khớp máy**
  - Phép CHIA DAO = theo CỘT (task 13, đã đúng). Việc cột → băng PLT-Y trong file là DO swapXY.
  - [ ] 14.1 Xác định đúng `swap_xy`/`flip_y` để cụm cột (D1/D2) ánh xạ thành băng PLT-Y khớp mẫu (5 mẫu: D1=Y thấp, D2=Y cao, full X)
  - [ ] 14.2 Công thức `dualHeadOffset` (mẫu: ≈ nửa chiều cao, 6011–6916; tính theo tâm 2 cụm)
  - [ ] 14.3 Sort row-by-row + staggered
  - ⚠️ Cần 1 cặp (artwork nguồn → .plt) đã biết HOẶC chạy thử trên máy để khoá swap_xy/flip/offset. KHÔNG ship bản đoán ra máy sản xuất.
  - _Requirements: 4.6, 4.7_

- [ ] 15. Layout-aware cut model (nguồn từ solver, KHÔNG từ PDF merge)
  - [x] 15.1 `layout_cut_model.build_tagged_cut_model_from_cells(...)` — vị trí tuyệt đối từ cells + base/align (khớp công thức nup_engine)
  - [x] 15.2 Tịnh tiến shape/ô theo từng cell + gán blade tag theo cột (task 13); CutModel tagged (8 test)
  - [ ] 15.3 Hook MỎNG trong `nup_engine` truyền (cells, base, die contour) vào builder + xử lý fill/staggered/cluster
  - [ ] 15.4 Golden so với `fixtures/yuty_sample.plt` (sau khi 14 hiệu chỉnh trên máy)
  - _Requirements: 4.6, 4.7_

### Pha 6 — Bộ TRÍCH ĐƯỜNG CẮT MẠNH từ PDF đã bình bất kỳ (Corel/AI/Prynx)

> Mục tiêu chiến lược: Prynx mở file bình sẵn (xuất từ Corel/Illustrator/RIP) → lấy
> đúng đường cắt để gửi máy, không cần bình lại. Bám Requirement 10.

- [x] 16. Content-stream walker (đệ quy XObject + CTM)
  - [x] 16.1 `cut_export/cut_layer_extractor.py`: parse content stream (pikepdf), CTM (cm/q/Q), dựng path (m/l/c/v/y/re + flatten bezier), bắt operator vẽ (S/s/f/B/n)
  - [x] 16.2 Đệ quy Form XObject (`Do`) với CTM nhân dồn + Matrix + /OC của XObject
  - [x] 16.3 Test: ma trận/CTM, bezier flatten, loại khung full-trang, đóng path
  - _Requirements: 10.1, 10.7_

- [x] 17. Nhận diện đường cắt đa chiến lược (cấu hình được)
  - [x] 17.1 Theo OCG layer: BDC `/OC` → resolve tên qua Properties; khớp mẫu (cutline/cutcontour/die...); loại trừ markline/marks
  - [x] 17.2 Theo spot-color (Separation/DeviceN `CutContour`) cho stroke/fill — verify trên `corel_cut_spot_sample.pdf` (spot độc lập ra 64, không nhân đôi khi trùng OCG)
  - [x] 17.3 Config tên lớp/spot ngoài lõi (`ExtractConfig`)
  - [x] 17.4 Test mẫu THẬT: Corel OCG (75 tem) + Corel spot (64 tem) — 12 test extractor
  - _Requirements: 10.2, 10.3, 10.4, 10.5, 10.6_

- [x] 18. Nối extractor vào luồng "Gửi Máy Bế"
  - [x] 18.1 `build_cut_model_from_pdf` dùng extractor mới → CutModel đúng số tem (75); preview/from-file/api test cập nhật
  - [x] 18.2 UI chọn lớp thủ công: endpoint `/cut-layers` + `force_layer` (preview/export); modal hiện dropdown lớp/spot khi auto-dò fail. Backend liệt kê OCG+spot; `force_layer` ép theo lựa chọn (16 test extractor)
  - _Requirements: 10.4, 10.6_

### Pha 1 — CutModel + vector-file + transport file (không cần máy)

- [x] 1. Khởi tạo module + kiểu dữ liệu lõi
  - [x] 1.1 Tạo `cut_export/__init__.py` và `cut_export/cut_model.py` với dataclass `CutPath`, `RegMark`, `CutModel`, `SendResult`
  - [x] 1.2 Viết unit test `cut_export/tests/test_cut_model.py` cho khởi tạo/round-trip dataclass
  - _Requirements: 1.1, 1.3_

- [x] 2. CutModelBuilder (trích từ kết quả bình)
  - [x] 2.1 `cut_export/cut_model_builder.py`: `build_cut_model(...)` nhận polygon/coords (gồm Shapely Polygon từ `nup_diecut.extract_page_die_cut_polygon`) — chỉ đọc, không sửa
  - [x] 2.2 Port flatten Bezier (≤0.2mm) + RDP (~0.03mm) sang `cut_export/geometry.py` (dịch từ logic JSX, viết mới trong module)
  - [x] 2.3 Gắn `tool_tag`/`block_id` + `source_names` từ `PontConfig.groupName/itemName/layerName`; tính `frame` = bbox tâm ốc
  - [x] 2.4 Test: sai số flatten, giữ vị trí layout, lỗi khi tên không khớp PontConfig, lỗi khi rỗng
  - _Requirements: 1.1, 1.2, 1.4, 1.5_

- [x] 3. Emitter vector-file
  - [x] 3.1 `cut_export/emitters/base.py` (Protocol `Emitter`) + `cut_export/emitters/dxf.py` (LWPOLYLINE, mm, R12/R14, KHÔNG spline)
  - [x] 3.2 `cut_export/emitters/pdf_spot.py`: đường cắt trên spot-color đặt tên cấu hình (mặc định `CutContour`), stroke-only, 1:1, vẽ ốc (reportlab, invariant → đơn định)
  - [x] 3.3 `cut_export/emitters/svg.py`: path phân lớp theo dao
  - [x] 3.4 Test: DXF chỉ LWPOLYLINE; PDF đúng tên spot-color + 1:1; SVG đúng lớp
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 4. Transport file
  - [x] 4.1 `cut_export/transport/base.py` (Protocol `Transport`) + `cut_export/transport/file.py`: ghi đuôi đúng + đặt tên theo `filename.pattern`
  - [x] 4.2 Test: tên/đuôi file, nội dung byte ổn định (đơn định)
  - _Requirements: 5.1, 8.4_

### Pha 2 — Machine Profile + command-stream + transport LAN/serial

- [x] 5. Machine Profile
  - [x] 5.1 `cut_export/profile.py`: schema + loader + validate (thiếu trường bắt buộc → từ chối, nêu lỗi); trường `resolution_plu_per_mm` BẮT BUỘC
  - [x] 5.2 `cut_export/profiles/yuty_a3_max.json` (port từ `dev campuchia v5.6.jsx`) + `cut_export/profiles/generic_hpgl.json`
  - [x] 5.3 Test: nạp profile hợp lệ; từ chối profile thiếu trường/PLU
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

- [x] 6. Emitter command-stream
  - [x] 6.1 `cut_export/emitters/command_stream.py`: đổi mm→PLU theo profile, áp origin/flip_y/swap_xy; sinh header/footer/pen_up/pen_down từ template
  - [x] 6.2 Sắp thứ tự cắt (bottom→top, left→right) + định tuyến song đạo theo `tool_tag` (CMD:35,0/1/2 + chuỗi mồi) + chèn `frame` (FSIZE). Profile `yuty_a3_max_dual.json` (offset 6344). Khớp cấu trúc mẫu thật.
  - [x] 6.3 Hỗ trợ dialect `skycut_ud` (U/D, space) và `hpgl_pupd` (PU/PD, `;`); đọc toạ độ trực tiếp (không spot-color)
  - [x] 6.4 **Golden test**: đối chiếu CẤU TRÚC với mẫu PLT thật `fixtures/yuty_sample.plt` (header tokens, separator, FSIZE, U/D, footer) — `test_golden_yuty.py`. Đã sửa header profile khớp mẫu (bỏ space thừa giữa các CMD). _(Byte-exact cần artwork nguồn của mẫu; mẫu này là dual-head — bản single-head khớp cấu trúc.)_
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

- [x] 7. Transport LAN + serial
  - [x] 7.1 `cut_export/transport/tcp.py`: gửi tới IP:port (mặc định 9100), timeout, trả `SendResult`
  - [x] 7.2 `cut_export/transport/serial_port.py`: baud + flow control (RTS/CTS hoặc XON/XOFF) + tiết lưu chống tràn buffer (pyserial lazy)
  - [x] 7.3 Test: tcp dùng mock server loopback; serial mock; lỗi → báo, không treo
  - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6_

### Pha 3 — Khớp bản in (registration)

- [x] 8. Registration
  - [x] 8.1 `cut_export/registration.py`: chế độ `onboard_frame` (chỉ tính frame, không warp)
  - [x] 8.2 Chế độ `manual_affine`: `solve_affine(design_pts, measured_pts)` (least-squares ≥3 điểm) + `apply_affine(cut_model, M)`
  - [x] 8.3 Test affine: bộ điểm lệch/xoay/co giãn đã biết → ma trận đúng, sai số tại ốc ≈ 0; warp nhất quán
  - _Requirements: 4.8, 4.9_

### Pha 4 — Onboarding profile + an toàn/log

- [x] 9. Quản lý profile + tiện ích đối chiếu
  - [x] 9.1 `cut_export/profile_store.py`: tạo/sửa/lưu profile (file JSON); không cho lưu thiếu trường
  - [x] 9.2 `cut_export/diff_sample.py`: nạp file mẫu thật (.plt) + đối chiếu cấu trúc với đầu ra Prynx (báo khác biệt)
  - [x] 9.3 Test: lưu/nạp profile; phát hiện khác biệt mẫu
  - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [x] 10. Orchestrator + an toàn
  - [x] 10.1 `cut_export/service.py`: `export_cut(...)` — ghép Builder→Registration→Emitter→Transport
  - [x] 10.2 Cảnh báo vượt `limits`; ghi log job; đảm bảo đơn định
  - [x] 10.3 Test tích hợp service end-to-end (transport file) cho Yuty + generic + DXF + affine
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 9.3_

### Integration (ĐỘNG vào file có sẵn — chỉ làm sau khi duyệt riêng)

- [x] 11. Nối API (additive, tối thiểu)
  - [x] 11.1 Tạo router mới `cut_export/api.py` (APIRouter `/imposition/cut-export`, `/cut-profiles`) — file mới trong module + test cô lập
  - [x] 11.2 [CHẠM FILE CÓ SẴN] Đăng ký router vào `app/main.py` (2 dòng `include_router`, prefix `/api`) → route `/api/imposition/cut-export` + `/cut-profiles` đã hoạt động
  - _Requirements: 6.2, 7.1_

- [x] 12. Nối UI (additive, tối thiểu)
  - [x] 12.1 Tạo component mới `cut-export/CutExportModal.tsx` + `cut-export/api.ts` (gọi route mới) — file mới, typecheck pass
  - [x] 12.2 [CHẠM FILE CÓ SẴN] Gắn nút "✂️ Gửi Máy Bế" vào `ImposerDashboard` (chỉ hiện mode Tem Bế/CNC) + modal vào DIALOGS → typecheck + build pass
  - [x] 12.3 Modal: chọn Profile/Emitter/Transport + **nguồn từ file đã bình** + **preview SVG đường cắt/ốc** + **chọn tờ (page)** + hiển thị tên nguồn (Req 8.1). Endpoint `/cut-preview-from-file` + `/cut-export-from-file`.
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 8.1_

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1"], "parallel": false, "rationale": "Kiểu dữ liệu lõi CutModel — nền cho mọi thứ" },
    { "wave": 2, "tasks": ["2", "4"], "parallel": true, "rationale": "Builder và transport file độc lập nhau, cùng dựa trên task 1" },
    { "wave": 3, "tasks": ["3", "5"], "parallel": true, "rationale": "Emitter vector-file và Machine Profile độc lập; vector-file đủ cho Pha 1" },
    { "wave": 4, "tasks": ["6", "7", "8", "9"], "parallel": true, "rationale": "command-stream (cần 5), transport LAN/serial, registration, onboarding profile — độc lập tương đối" },
    { "wave": 5, "tasks": ["10"], "parallel": false, "rationale": "Orchestrator ghép toàn bộ + test E2E" },
    { "wave": 6, "tasks": ["11", "12"], "parallel": false, "rationale": "Integration chạm file có sẵn — làm sau cùng, cần duyệt diff" }
  ]
}
```

Sơ đồ phụ thuộc (tham khảo):
```
1 → (2, 4) → (3, 5) → (6 cần 5; 7; 8; 9 cần 5) → 10 → 11 → 12
```
Pha 1 (task 1–4) giao được giá trị sớm (xuất file vector) mà không cần máy.

## Notes

- Mọi task đánh `[CHẠM FILE CÓ SẴN]` PHẢI trình bày diff và xin duyệt trước khi sửa (task 11.2, 12.2).
- Golden test (6.4) cần một file `.plt` mẫu do script JSX xuất trên một đầu vào cố định — chuẩn bị sẵn fixture trong `cut_export/tests/fixtures/`.
- Hiệu chỉnh trên máy thật (lực/tốc/offset, sai số dò dấu) nằm NGOÀI CI — đánh dấu là kiểm thử thủ công.
- Không sao chép mã GPL (InkCut/inkscape-silhouette) vào module; chỉ tham khảo cách làm (Requirement 9).
- Profile Yuty port từ `scripts/illustrator/dev campuchia v5.6.jsx` (`exportCutLayerToPLT`); giữ tham chiếu nguồn trong `source_ref`.
