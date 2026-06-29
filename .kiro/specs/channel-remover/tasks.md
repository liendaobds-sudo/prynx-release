# Implementation Plan: Channel Remover with color re-separation

## Overview

Triển khai action prepress `REMOVE_CHANNELS` trong `app/core/channel_remover.py` (mới) và đăng ký vào `app/core/action_engine.py`. Cách tiếp cận tăng dần: bắt đầu từ data models + validate, rồi các hàm thuần lõi (ColorMapper, ReSeparationEngine), tiếp đến scanner content stream và image XObject (tái dùng kỹ thuật `overprint_black.py`), sau đó điều phối `remove_channels` (duyệt trang, tổng hợp report), preview OOG, và cuối cùng wiring vào Action_Engine + API. Mỗi Correctness Property (1..14) được hiện thực bằng một property test với Hypothesis (≥100 iterations), chạy bằng `backend\venv\Scripts\python.exe`.

## Tasks

- [x] 1. Tạo khung module và data models
  - [x] 1.1 Tạo file `app/core/channel_remover.py` với hằng số và data models
    - Hằng số (`PROCESS_CHANNELS`, `DEFAULT_TAC_LIMIT=360.0`, `DEFAULT_GAMUT_THRESHOLD=5.0`, `DEFAULT_GRID_STEP=5.0`)
    - Định nghĩa dataclass `ChannelRemovalParams`, `ChannelRemovalReport`, `ColorHit`, `ImageHit`
    - Khai báo chữ ký hàm `remove_channels(input_path, output_path, params) -> ChannelRemovalReport` và `validate_params(params) -> ChannelRemovalParams` (chưa cài đặt đầy đủ)
    - _Requirements: 8.1_

- [x] 2. Validate tham số và chọn kênh giữ/bỏ
  - [x] 2.1 Cài đặt `validate_params`
    - Parse `kept_channels`, `mode`, `tac_limit`, `gamut_threshold`, `spot_handling`, `process_hidden_layers`, `grid_step`
    - Từ chối khi giữ cả 4 kênh ("không có kênh nào bị gỡ"); từ chối khi kept rỗng ("phải giữ ít nhất một kênh"); chấp nhận 1..3 phần tử
    - Áp mặc định TAC=360, gamut_threshold=5, spot_handling="skip"
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 7.1, 8.1_

  - [x]* 2.2 Write property test for kept-channel set validity
    - **Property 14: Kept-channel set validity**
    - **Validates: Requirements 1.2, 1.3, 1.4**
    - `# Feature: channel-remover, Property 14`, ≥100 iterations, generator tập con {C,M,Y,K} gồm cả rỗng và đủ 4

  - [x]* 2.3 Write unit tests for validate_params
    - Test giữ cả 4 / bỏ cả 4 / TAC mặc định 360 / spot_handling hợp lệ
    - _Requirements: 1.3, 1.4, 7.1, 8.1_

- [x] 3. Cài đặt clamp range + TAC và ColorMapper chế độ Direct
  - [x] 3.1 Cài đặt clamp range [0,100] và clamp TAC
    - Mỗi kênh clamp về [0,100]; nếu ΣTAC > tac_limit thì scale giảm đồng đều các kênh > 0 về tac_limit (giữ tỉ lệ)
    - _Requirements: 8.2, 8.3_

  - [x] 3.2 Cài đặt `ColorMapper.map_color` chế độ Direct
    - removed→0, kept giữ nguyên; sau cùng áp clamp range + TAC; trả `(cmyk, delta_e, is_oog)`
    - _Requirements: 2.1, 2.2_

  - [x]* 3.3 Write property test for direct removal
    - **Property 1: Direct removal zeroes removed channels and preserves kept channels**
    - **Validates: Requirements 2.1, 2.2**
    - `# Feature: channel-remover, Property 1`, ≥100 iterations (xét trước bước clamp TAC)

  - [x]* 3.4 Write property test for result color validity invariant
    - **Property 2: Result color validity invariant**
    - **Validates: Requirements 3.2, 8.2, 8.3**
    - `# Feature: channel-remover, Property 2`, ≥100 iterations; mọi mode + tac_limit hợp lệ

- [x] 4. Cài đặt ReSeparationEngine (FOGRA39 CMYK↔Lab + LUT + argmin)
  - [x] 4.1 Cài đặt chuyển đổi CMYK→Lab qua ImageCms FOGRA39
    - `to_lab` dùng `ImageCms.getOpenProfile` + `buildTransform("CMYK","LAB", RELATIVE_COLORIMETRIC)` (đồng bộ `softproof.py`)
    - Load profile từ `settings.ICC_PROFILE_DIR / settings.DEFAULT_CMYK_PROFILE`; ném `FileNotFoundError` rõ ràng nếu thiếu
    - Cài `delta_e_cie76`
    - _Requirements: 3.1_

  - [x] 4.2 Build LUT kênh-giữ + tìm argmin ΔE
    - Liệt kê tổ hợp CMYK chỉ-dùng-Kept_Channel theo grid_step (kênh bỏ = 0), map sang Lab, cache theo (tập kênh-giữ, grid_step)
    - `best_kept_only(target_lab) -> (cmyk_kept_only, delta_e_min)` argmin trên LUT
    - _Requirements: 3.1_

  - [x] 4.3 Tích hợp Re-separation vào `ColorMapper.map_color`
    - Chế độ reseparate: chọn argmin ΔE kênh-giữ, removed→0, set cờ `out_of_gamut = (delta_e_min > gamut_threshold)`, rồi clamp
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [x]* 4.4 Write property test for minimum Delta_E selection
    - **Property 3: Re-separation chooses the minimum Delta_E kept-only combination**
    - **Validates: Requirements 3.1**
    - `# Feature: channel-remover, Property 3`, ≥100 iterations

  - [x]* 4.5 Write property test for in-gamut reproduction
    - **Property 4: In-gamut colors reproduce within threshold**
    - **Validates: Requirements 3.3, 13.1**
    - `# Feature: channel-remover, Property 4`, ≥100 iterations; generator màu kept-only; ΔE đo bằng littleCMS FOGRA39 thật

  - [x]* 4.6 Write property test for out-of-gamut classification
    - **Property 5: Out-of-gamut classification, warning, and honesty** (phần phân loại + argmin)
    - **Validates: Requirements 3.4, 4.2, 4.4**
    - `# Feature: channel-remover, Property 5`, ≥100 iterations

  - [x]* 4.7 Write property test for re-separation idempotence
    - **Property 11: Re-separation is idempotent on kept-only colors**
    - **Validates: Requirements 13.3**
    - `# Feature: channel-remover, Property 11`, ≥100 iterations; `map(map(x)) == map(x)`

- [x] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Cài đặt ContentStreamTransformer (vector k/K, scn/SCN)
  - [x] 6.1 Tổng quát hoá scanner byte-level từ `overprint_black.py`
    - Tái dùng vòng quét token an toàn: bỏ qua string literal `( )`, hex `< >`, dict `<< >>`, comment `%`, inline image `BI…EI`; stack `q`/`Q`
    - Theo dõi color space hiện hành (`cs`/`CS` + `/Resources/ColorSpace`) để xác định DeviceCMYK / ICCBased N=4
    - _Requirements: 5.1, 5.2_

  - [x] 6.2 Biến đổi toán hạng màu CMYK tại chỗ
    - Với `k`/`K` (4 toán hạng) và `scn`/`SCN` DeviceCMYK/ICCBased-4 (4 toán hạng): thay chính xác khoảng byte 4 toán hạng bằng `map_color`; nhân/chia 100 ở biên (0..1 ↔ 0..100)
    - Không sửa byte ngoài khoảng toán hạng; thu thập `ColorHit`
    - Spot/Separation/DeviceN xử lý theo `spot_handling` (skip = giữ nguyên)
    - _Requirements: 5.3, 5.4, 5.5, 7.2, 7.3_

  - [x]* 6.3 Write property test for scanner safety
    - **Property 7: Scanner only modifies CMYK color operands**
    - **Validates: Requirements 5.2, 5.5**
    - `# Feature: channel-remover, Property 7`, ≥100 iterations; chèn token màu giả trong `( )`, `BI…EI`, `%`

  - [x]* 6.4 Write property test for vector operator transform
    - **Property 8: Vector CMYK color operators are transformed**
    - **Validates: Requirements 5.3, 5.4**
    - `# Feature: channel-remover, Property 8`, ≥100 iterations

  - [x]* 6.5 Write property test for spot skip preservation
    - **Property 10: Skip option preserves spot colors**
    - **Validates: Requirements 7.2**
    - `# Feature: channel-remover, Property 10`, ≥100 iterations; content stream chứa Separation/DeviceN

  - [x]* 6.6 Write unit tests for spot convert-first
    - Spot đã biết → convert sang CMYK rồi gỡ kênh
    - _Requirements: 7.3_

- [x] 7. Cài đặt ImageXObjectTransformer (ảnh CMYK FlateDecode)
  - [x] 7.1 Decode → map pixel → encode lại
    - Chỉ xử lý FlateDecode + DeviceCMYK/ICCBased-4; decode → numpy (H,W,4); áp LUT/map vector hoá; encode lại FlateDecode giữ nguyên Width/Height/4 kênh/filter
    - DCTDecode (JPEG-CMYK) → trả None + warning; thu `ImageHit`
    - _Requirements: 6.1, 6.2, 6.3_

  - [x]* 7.2 Write property test for image transform
    - **Property 9: Image XObject transform maps pixels and preserves structure**
    - **Validates: Requirements 6.1, 6.2**
    - `# Feature: channel-remover, Property 9`, ≥100 iterations; numpy (H,W,4) ngẫu nhiên encode FlateDecode

  - [x]* 7.3 Write unit test for DCTDecode skip
    - Ảnh DCTDecode bị bỏ qua + warning
    - _Requirements: 6.3_

- [x] 8. Điều phối `remove_channels` (duyệt trang, edge cases, report)
  - [x] 8.1 Cài đặt validate input + mở/ghi PDF qua pikepdf
    - File 0 byte → lỗi "file rỗng"; PDF không hợp lệ → lỗi; luôn ghi `output_path` kể cả no-op (bản sao hợp lệ); không CMYK → warning "không có kênh nào bị thay đổi"
    - _Requirements: 11.1, 11.2, 11.5, 9.1_

  - [x] 8.2 Duyệt mọi trang + áp content/image transformer
    - Áp cho mọi trang; trang không chứa Process_Channel cần biến đổi → giữ nguyên & vẫn xuất hiện trong output
    - Tùy chọn `process_hidden_layers`: tắt giữ nguyên nội dung OCG ẩn / bật áp gỡ kênh
    - _Requirements: 11.3, 11.4, 12.1, 12.2, 12.3_

  - [x] 8.3 Tổng hợp report
    - `max_delta_e`, `avg_delta_e` trên toàn bộ ColorHit + đại diện pixel ảnh; `out_of_gamut_count`; cảnh báo OOG; `identical_to_original = (out_of_gamut_count == 0)`
    - _Requirements: 4.1, 4.2, 4.4_

  - [x]* 8.4 Write property test for aggregate Delta_E statistics
    - **Property 6: Aggregate Delta_E statistics are correct**
    - **Validates: Requirements 4.1**
    - `# Feature: channel-remover, Property 6`, ≥100 iterations

  - [x]* 8.5 Write property test for OOG warning honesty (file-level)
    - **Property 5: Out-of-gamut classification, warning, and honesty** (phần report + identical_to_original)
    - **Validates: Requirements 4.2, 4.4**
    - `# Feature: channel-remover, Property 5 (file-level)`, ≥100 iterations

  - [x]* 8.6 Write property test for all pages processed
    - **Property 12: All pages are processed; no-op pages preserved**
    - **Validates: Requirements 11.3, 11.4**
    - `# Feature: channel-remover, Property 12`, ≥100 iterations; PDF nhiều trang tổng hợp

  - [x]* 8.7 Write unit tests for input edge cases & hidden layers
    - File 0 byte / PDF không hợp lệ / không CMYK → bản sao + warning; OCG ẩn option tắt/bật
    - _Requirements: 11.1, 11.2, 11.5, 12.2, 12.3_

- [x] 9. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Preview tô đỏ vùng Out-Of-Gamut
  - [x] 10.1 Render trang + tô đỏ Out_Of_Gamut_Region
    - Tái dùng raster `softproof`/`separations`; highlight vùng OOG; đảm bảo parity preview/output
    - _Requirements: 4.3, 10.1_

  - [x]* 10.2 Write property test for preview/output parity
    - **Property 13: Preview/output parity within threshold**
    - **Validates: Requirements 10.2**
    - `# Feature: channel-remover, Property 13`, ≥100 iterations; ΔE per-region preview vs output ≤ Gamut_Threshold

  - [x]* 10.3 Write unit test for OOG highlight
    - Preview tô đỏ đúng vùng OOG
    - _Requirements: 4.3_

- [x] 11. Đăng ký action và wiring vào Action_Engine + API
  - [x] 11.1 Thêm `REMOVE_CHANNELS` vào `AVAILABLE_ACTIONS` và handler `_action_remove_channels`
    - Theo mẫu `_action_set_black_overprint`: gọi `remove_channels` qua `asyncio.to_thread`; đính report (max/avg ΔE, OOG, warnings) vào log
    - Ghi output vào `RESULTS_DIR/preflight_output`; trả `output_filename`
    - _Requirements: 9.1, 9.2, 9.3_

  - [x] 11.2 Bổ sung trường report vào `FixResponse`
    - Thêm max/avg ΔE, OOG count, warnings để UI hiển thị cảnh báo
    - _Requirements: 4.1, 4.2_

  - [x]* 11.3 Write integration & smoke tests
    - `POST /preflight/fix` action_id=REMOVE_CHANNELS → ghi preflight_output, tải qua `GET /preflight/download/{filename}`; smoke `REMOVE_CHANNELS` có trong AVAILABLE_ACTIONS + handler
    - Raster pypdfium2: render output, tách separations, kênh bỏ ≈ 0
    - _Requirements: 9.1, 9.2, 9.3, 13.2_

- [x] 12. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass (chạy bằng `backend\venv\Scripts\python.exe`), ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (test tasks) và có thể bỏ qua cho MVP nhanh, nhưng nên chạy để bảo đảm correctness.
- Mỗi task tham chiếu requirement cụ thể để truy vết.
- 14 Correctness Property đều được phủ bởi một property test riêng (Property 5 tách thành phần màu-level ở 4.6 và file-level ở 8.5).
- Property tests dùng Hypothesis (đã có trong dự án), ≥100 iterations, mỗi test gắn comment `# Feature: channel-remover, Property {number}`.
- Toàn bộ test chạy bằng venv dự án `backend\venv\Scripts\python.exe` (Req 13.4).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "2.3", "4.1"] },
    { "id": 2, "tasks": ["2.2", "3.1", "4.2"] },
    { "id": 3, "tasks": ["3.2", "4.3"] },
    { "id": 4, "tasks": ["3.3", "3.4", "4.4", "4.5", "4.6", "4.7", "6.1", "7.1"] },
    { "id": 5, "tasks": ["6.2", "7.2", "7.3"] },
    { "id": 6, "tasks": ["6.3", "6.4", "6.5", "6.6", "8.1"] },
    { "id": 7, "tasks": ["8.2"] },
    { "id": 8, "tasks": ["8.3", "10.1"] },
    { "id": 9, "tasks": ["8.4", "8.5", "8.6", "8.7", "10.2", "10.3", "11.1"] },
    { "id": 10, "tasks": ["11.2"] },
    { "id": 11, "tasks": ["11.3"] }
  ]
}
```
