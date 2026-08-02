# Báo cáo audit — Dấu xén của Bình cắt xén / Dàn nhiều kích thước

Ngày: 2026-08-01  
Phạm vi: `Bình cắt xén → Dàn nhiều mẫu → Dàn nhiều kích thước`, từ payload `markType` đến hai tầng vẽ dấu trong export PDF.  
Trạng thái: **đã duyệt Phương án A và hoàn tất lô sửa ngày 2026-08-01** — xem `docs/DAU_XEN_MIXED_GUILLOTINE_FIXES_2026-08-01.md`.

## Tóm tắt điều hành

Hiện tượng “hàng loạt dấu xén chạy quanh viền giấy” là có thật và không đến từ solver xếp sai tem. Export đang vẽ **hai lớp dấu độc lập trên cùng một tờ**:

1. Rust `compute_mark_coords` vẽ dấu xén theo mép thành phẩm của từng cụm/sản phẩm. Probe xác nhận lớp này đã phủ đủ mọi mép trim.
2. `draw_tile_cut_marks` nhận tập đường cắt cấp vùng/tờ do `mixed_guillotine` đưa vào `cluster_tile_cuts`, rồi vẽ thêm dấu quanh bốn cạnh và tại các giao điểm. Lớp này chạy **vô điều kiện, bất kể `markType`**.

`draw_tile_cut_marks` được thiết kế cho một lưới tile hình chữ nhật. Khi nhận projection của cây cắt mixed-guillotine, nó nhân chéo mọi toạ độ dọc × ngang. Vì vậy một mặt chỉ có `2` toạ độ dọc và `21` toạ độ ngang vẫn sinh tới **152 nét tile**; cộng với dấu thành phẩm từ Rust tạo cảm giác viền giấy bị phủ dày đặc dấu xén.

Kết luận: dấu thành phẩm không thiếu; lỗi nằm ở **phân quyền vẽ dấu bị chồng lấn** và contract `cluster_tile_cuts` không phù hợp với cây cắt mixed-guillotine.

## Bằng chứng runtime

Chạy lại `backend/scratch/probe_marks_union.py` trên runtime hiện tại:

```text
CA 1, mặt 0, mark_type='guillotine'
mép trim: x=35 y=17
Rust:      v=35 h=17
tile:      v=2  h=21
mép trim thiếu dấu: x=0 y=0
toạ độ tile không trùng mép trim: y=10.0, 378.8, 736.6, 1078.0mm
```

Các ca còn lại đều có `mép trim THIẾU dấu: x=0 y=0`, nhưng có thêm 2–6 toạ độ chỉ do tile sinh. Hai toạ độ ngoài thường là mép `usableRect`; các toạ độ giữa là biên zone.

Với `v=2`, `h=21`, số nét mặc định của `draw_tile_cut_marks` là:

```text
cạnh trái/phải                         = 2 × (21 - 2) = 38
19 đường ngang nội bộ × (2×v + 2)    = 19 × 6       = 114
tổng                                  = 152 nét
```

Đây là lý do vài toạ độ logic lại xuất hiện thành “hàng loạt” dấu quanh viền.

Baseline test hiện tại vẫn xanh:

```text
pytest test_cut_marks.py test_mixed_guillotine_adapter.py test_mixed_guillotine_export.py
16 passed, 2 warnings
```

Test xanh không bác bỏ lỗi vì test chỉ khoá thuật toán lưới tile riêng lẻ và placements/export; chưa test hợp của hai tầng marks trên một trang mixed-guillotine.

## Luồng gây lỗi

1. UI mặc định `markType='guillotine'` tại `desktop/src/components/imposition-tools/store/slices/marksSlice.ts:50`.
2. Payload giữ nguyên `markType` tại `desktop/src/lib/processHandlers.ts:103`.
3. `mixed_guillotine` materialize placements, lấy các đường full-span và **tự thêm bốn mép root** vào `_face_cuts` tại `backend/app/workers/nup_engine.py:2431-2449`, rồi gán vào `cluster_tile_cuts`.
4. Renderer vẽ dấu thành phẩm Rust tại `backend/app/workers/nup_process_chunk.py:905-918`.
5. Ngay sau đó renderer gọi `draw_tile_cut_marks` tại `backend/app/workers/nup_process_chunk.py:919-930`; comment và điều kiện hiện tại xác nhận đường này chạy “always, regardless of mark_type”.
6. `draw_tile_cut_marks` lặp trên bốn cạnh và nhân chéo các đường nội bộ tại `backend/app/workers/cluster_tile_engine.py:671-717`.

Đoạn marks này không nằm trong diff chưa commit hiện tại của `nup_engine.py`; đây là hành vi baseline, không phải thay đổi đang làm dở ngày 2026-08-01.

## Phát hiện

### §DXM.1 · P1 · Hai tầng marks cùng chịu trách nhiệm cho mixed-guillotine · effort M

**Bằng chứng:** `nup_process_chunk.py:905-930` vẽ Rust marks rồi tile marks trên cùng trang. Rust đã phủ đủ mép trim; tile thêm biên zone/root và nhân chúng thành nhiều nét.

**Tác động:** PDF khó đọc, thợ có thể hiểu dấu cấp vùng/tờ là dấu xén thành phẩm, và số path vector tăng không cần thiết. Đây không phải lỗi thiếu dấu hoặc solver xếp sai.

**Hướng xử lý đề nghị:** Rust tiếp tục là nguồn dấu thành phẩm. Mixed-guillotine cần renderer riêng cho **segment phân tách zone thực sự** từ `cutTree/cutLines`; không đi qua renderer lưới `draw_tile_cut_marks`.

### §DXM.2 · P1 · `markType='none'` không tắt được tile marks · effort S

**Bằng chứng:** điều kiện Rust tôn trọng `mark_type`, nhưng nhánh tile tại `nup_process_chunk.py:919-930` không kiểm tra `mark_type`. Test export mixed hiện còn đặt `markType: 'none'`, nhưng không assert content stream của marks nên vẫn xanh.

**Tác động:** lựa chọn UI “Không vẽ dấu xén” không đúng hợp đồng đối với Dàn nhiều kích thước.

**Hướng xử lý đề nghị:** mọi tầng vẽ marks phải dừng khi `markType='none'`. Thêm test âm bắt content stream không có nét mark.

### §DXM.3 · P2 · `draw_tile_cut_marks` áp mô hình lưới Cartesian lên cây cắt zone · effort M

**Bằng chứng:** `cluster_tile_engine.py:697-717` vẽ tại mọi giao điểm `int_v × h_cuts` và `int_h × v_cuts`. Contract đầu vào chỉ còn các tập toạ độ, đã làm mất `start/end` của từng cut segment.

**Tác động:** không thể phân biệt đường cắt toàn tờ, đường chỉ giới hạn trong một zone và mép root; số nét tăng theo `O(V×H)`.

**Hướng xử lý đề nghị:** giữ `axis/coordinate/start/end` đến tầng render. Mỗi segment zone chỉ sinh tick ở hai đầu thật; không dựng tích Descartes từ hai tập toạ độ.

### §DXM.4 · P2 · Thiếu regression test ở điểm hợp hai nguồn marks · effort S

**Bằng chứng:** `test_cut_marks.py` khoá đúng hành vi lưới 3×3 (20 nét), adapter chỉ kiểm projection full-span, export mixed chủ yếu kiểm số trang/placements. Không test nào kiểm:

- `markType='none'` thực sự không có marks;
- mỗi mép trim có dấu nhưng không bị vẽ trùng;
- zone separator không nở thành lưới dấu quanh viền;
- số path/tọa độ tile-only nằm trong ngân sách cho phép.

## Phương án sửa đề xuất

### Phương án A — khuyến nghị

- Giữ Rust `compute_mark_coords` cho dấu xén từng cụm/sản phẩm.
- Bỏ việc đưa mixed-guillotine qua `draw_tile_cut_marks`.
- Vẽ riêng chỉ các cut segment phân tách zone cần cho quy trình xén, mỗi segment có hai tick ở endpoint thật.
- Không thêm bốn mép `usableRect` như một lưới marks thứ hai.
- Tôn trọng `markType='none'` ở toàn bộ pipeline.

Ưu điểm: giữ đủ thông tin tách zone nhưng loại bỏ dấu trùng và bùng nổ Cartesian. Nhược điểm: cần renderer segment nhỏ và test PDF content stream mới.

### Phương án B — sửa tối thiểu

- Với `mixed_guillotine`, không gọi `draw_tile_cut_marks`; chỉ giữ Rust marks.
- Chặn toàn bộ marks khi `markType='none'`.

Ưu điểm: thay đổi nhỏ, giải quyết ngay hiện tượng. Nhược điểm: mất dấu riêng cho đường tách zone nếu xưởng vẫn cần đường đó dù không trùng mép thành phẩm.

## Lô sửa dự kiến sau khi duyệt

Một lô tối đa 4 file:

1. `backend/app/workers/nup_process_chunk.py` — định tuyến marks theo mode và `markType`.
2. `backend/app/workers/nup_engine.py` — không ép root edges vào contract tile của mixed.
3. `backend/app/workers/cluster_tile_engine.py` hoặc helper segment mới — chỉ khi chọn Phương án A.
4. Test regression mixed marks mới — kiểm `none`, không trùng và ngân sách số nét.

Verify dự kiến: pytest hẹp marks/mixed export → nhóm mixed-guillotine đầy đủ → xuất PDF mẫu và kiểm tay content/viền trên ứng dụng thật.

## Chốt duyệt — đã hoàn tất

Chủ dự án đã duyệt **Phương án A**:

- Giữ dấu xén thành phẩm của từng cụm từ Rust.
- Dấu tách zone chỉ vẽ tại hai endpoint của segment thật.
- Không dùng renderer lưới tile cho mixed-guillotine.
- `markType='none'` tắt toàn bộ dấu.
