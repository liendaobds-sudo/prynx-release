# PLAYBOOK XỬ LÝ VA CHẠM — Tem bình bế / CNC

> Tổng hợp đầy đủ logic & kịch bản xử lý va chạm cho từng loại hình, để **không phải mò script
> Illustrator (`scripts/illustrator/1. dev - Nô lệ bình bài.jsx`) lần nữa**.
> Cập nhật: 2026-06-22. Code: `backend/app/workers/pont_collision.py` (+ `nup_process_chunk.py`,
> `cnc_render.py`).

---

## 0. CÓ HAI HỆ VA CHẠM KHÁC NHAU — đừng nhầm

| Hệ | File | Va chạm giữa | Khi nào chạy |
|---|---|---|---|
| **Tem ↔ Tem** (sticker-sticker) | `sticker_imposer_pkg/collision.py` `resolve_layout_collisions` | 2 tem đè nhau | Sau khi solver xếp layout (trong orchestrator). Một số chiến lược tất định được SKIP (hex/staggered/triangle/pentagon). |
| **Tem ↔ VÙNG CẤM** (pont/ốc) | `pont_collision.py` `smart_resolve_collisions` | Tem đè dấu boong/ốc 4 góc | Lúc render (`nup_process_chunk.py:459`), và CNC (`cnc_render._resolve_cnc_collisions`). |

**Tài liệu này nói về hệ thứ 2 (VÙNG CẤM).**

---

## 1. VÙNG CẤM (forbidden zones)

- 4 vùng ở 4 góc tờ giấy, quanh dấu boong/ốc. Tính bởi `calculate_forbidden_zones`.
- Kích thước = `mark_size/2 + SAFETY_PADDING(3mm)`; tâm đặt theo lề (`marginTop/Bottom/Left/Right`).
- Hình tròn (`shape='circle'`) → polygon tròn; khác → box vuông.
- **Độ xâm lấn vào vùng in** mỗi cạnh = `occupied − lề giấy` (`layKichThuocVungCamDong` ở JSX). Nếu
  lề giấy đã đủ rộng thì xâm lấn = 0.
- `disableCollision=True` → bỏ qua, không xử lý.
- **CNC ghép nhiều mẫu**: vùng cấm bị LOẠI NGAY lúc bin-pack (`compute_packer_exclude_zones`), không
  qua `smart_resolve_collisions`.

### Phát hiện va chạm theo HÌNH (chính xác, không chỉ bbox)
`detect_collisions` + `get_item_polygon` dựng polygon THẬT của từng tem (xoay/lật theo
`isRotated`/`isRotated180`, Y-flip top-down↔bottom-up) rồi kiểm giao với vùng cấm.
- **Polygon nguồn** lấy bằng `build_shapely_polygon_from_paths` → đã dùng `_path_items_to_polygon`
  (sample bezier chuẩn). CIRCLE_ELLIPSE dùng ellipse toán học riêng (chính xác tuyệt đối).
- Render đọc vị trí từ `abs_x` (X) và **`original_cell_y`** (Y, top-down) — KHÔNG phải `abs_y`. Mọi
  phép dịch/xoay phải cập nhật ĐỒNG THỜI `abs_x/abs_y` (cho collision) và `original_cell_y` (render).
- KHÔNG xử lý mirror: render luôn `mirror_x=mirror_y=False`; duplex mặt sau xử lý bằng toggle
  `isRotated180` trên cùng placement → collision & render nhất quán.

---

## 2. THUẬT TOÁN TỔNG (smart_resolve_collisions) — ƯU TIÊN GIỮ TEM

```
detect va chạm vùng cấm.
nếu không có → trả nguyên.

CÓ "CẶP LỒNG LỆCH HƯỚNG" không?  (xem mục 3)
 ├─ KHÔNG → _resolve_one_orientation: XÓA tối thiểu + canh giữa  (tròn, chữ nhật, tam giác chẵn,
 │          cặp-bằng-nhau...). HẾT.
 └─ CÓ →
      1) XOAY 180° CỤC BỘ trọn cụm lồng giáp vùng cấm (_try_local_pair_flips).
         → nếu hết va chạm: GIỮ TRỌN tem. HẾT.
      2) DỊCH CẢ KHỐI ra xa góc va chạm (_try_whole_block_shift).
         → nếu hết: GIỮ TRỌN tem. HẾT.
      3) XÓA tối thiểu + canh giữa (_resolve_one_orientation) trên layout đã xoay tốt nhất.
```

**Bất biến quan trọng**: KHÔNG bao giờ ship tem-đè-tem. Mọi phép xoay đều qua chốt
`_creates_sticker_overlap` (polygon thật) — phá khớp lồng → bị từ chối.

---

## 3. "CẶP LỒNG LỆCH HƯỚNG" — chìa khóa quyết định xoay hay xóa

= bản port của `checkIfPentagonRowsAreEqual` (JSX) nhưng đếm theo **HƯỚNG**, không theo vị trí.

- **Cụm lồng** (`_interlocked_clusters`): gom hàng (theo y) hoặc cột (theo x) thành cụm có **bbox đè
  nhau** → 1 cụm lồng. Cụm tách rời (có khe) = ranh giới. Xoay 1 cụm quanh tâm nó KHÔNG đụng cụm khác.
- **Lệch hướng** (`_cluster_unequal_groups`): trong cụm, đếm số tem 2 HƯỚNG (`isRotated180`
  up vs down). **Khác số → LỆCH → xoay được**; bằng số → đối xứng → xoay 180° = no-op (vẫn va chạm)
  → phải xóa.

**Vì sao đếm theo HƯỚNG, không theo hàng-y**: tam giác lồng up/down NGAY TRONG cùng hàng (DUDUDU).
Một hàng 11 tem = 6 ngược + 5 xuôi → đếm theo y ra "11 (bằng)" SAI; đếm theo hướng ra "6≠5 (lệch)" ĐÚNG.

| Ví dụ cụm | Đếm hướng | Kết luận |
|---|---|---|
| Ngũ giác: cặp 2 hàng up(4)+down(3) | 4 ≠ 3 | LỆCH → xoay |
| Tam giác: hàng DUDUDU 11 = 6+5 | 6 ≠ 5 | LỆCH → xoay |
| Tam giác: hàng DUDUDU 6 = 3+3 | 3 = 3 | BẰNG → xóa |
| Ngũ giác: cặp 3+3 | 3 = 3 | BẰNG → xóa |
| Chữ nhật / tròn (đồng hướng) | chỉ 1 hướng | không lồng-lệch → xóa/giữ cũ |

---

## 4. PHÉP XOAY 180° CỤC BỘ (_rotate_pair_180 + _try_local_pair_flips)

- Xoay trọn **một cụm lồng** 180° quanh **tâm bbox của RIÊNG cụm** + toggle `isRotated180`.
- Footprint cụm KHÔNG đổi → không đè cụm khác (các cụm lồng tách rời nhau). Phép quay cứng → không
  sinh chồng lấn nội bộ.
- Hiệu ứng: đảo thứ tự + lật hướng → **đưa hướng/hàng ÍT tem ra mép vùng cấm** → tem ở góc đổi
  hướng, thoát vùng cấm.
- Lặp tham lam qua các cụm va chạm; chỉ NHẬN phép xoay vừa **giảm va chạm vùng cấm** vừa **không
  sinh tem-đè** (chốt `_creates_sticker_overlap`). Thử cả trục hàng và cột.
- ⚠️ Hàng/cụm **đối xứng** (đếm hướng bằng nhau) → xoay là **no-op** (chuỗi cân bằng đảo+lật = chính
  nó) → không nhận → rơi xuống xóa. Đây là lý do "2 hàng bằng nhau thì xóa".

---

## 5. DỊCH CẢ KHỐI (_try_whole_block_shift)

- Dịch MỌI tem cùng một vector ra xa góc va chạm, giữ trọn tem (không xóa).
- Chỉ nhận phép dịch khiến HẾT va chạm VÀ khối vẫn trong vùng in. Tìm phép dịch nhỏ nhất (tới ±20mm).
- Hiệu quả khi 2 góc **cùng phía** (vd TL+BL → dịch sang phải) và còn chỗ trống phía đối diện.
  2 góc đối nhau (TL+BR) hoặc khối kín khổ → không dịch được → None.
- (Tương ứng Scenario 0a–0d của JSX, nhưng tìm kiếm thay vì tất định.)

---

## 6. XÓA TỐI THIỂU + CANH GIỮA (_resolve_one_orientation)

Khi không xoay/dịch được. Theo HÀNG:
- Phát hiện va chạm từng hàng; hàng sạch → giữ nguyên.
- Hàng va chạm: thử **xóa 1 tem** rồi dịch/căn-giữa hàng còn lại (ưu tiên căn giữa nếu là điều chỉnh
  nhỏ; teleport ngang lớn bị bỏ để khỏi phá canh so le). Không được → thử **xóa 2 tem**. Cùng lắm
  xóa hết tem va chạm trong hàng.
- `other_items` luôn phản ánh trạng thái HIỆN TẠI (hàng đã dịch) để không tạo đè giữa các hàng đã dịch.

(JSX có nhiều biến thể: `handleCollisionScenario_DeleteOne/TwoLastRow/FirstAndLast`,
`canhChinhHangCuoi/CotCuoi`, `removeItemsAndCenter`, quyết định theo `remH/remV` so với độ xâm lấn
vùng cấm + cờ `safeEdgeAlign`. Bản Python hiện gộp lại thành xóa-theo-hàng + canh giữa.)

---

## 7. BẢNG TAXONOMY THEO LOẠI HÌNH

| Loại hình | Lồng? | Bất đối xứng? | Xử lý va chạm vùng cấm |
|---|---|---|---|
| **Ngũ giác** | Có (cặp 2 hàng) | Có | Cặp lệch (4≠3) → **xoay**; cặp bằng → xóa+canh |
| **Tam giác** | Có (DUDUDU trong hàng) | Có | Hàng lẻ (6≠5) → **xoay**; hàng chẵn (3=3) → xóa+canh |
| **Hình thang** | Có (cặp up/down) | Có | Cặp lệch → **xoay**; bằng → xóa+canh |
| **Bình hành** | Có (cặp up/down) | Có | Như hình thang |
| **Tạ tay / Búa** | Có (cặp cột) | Có | Cặp lệch → **xoay**; bằng → xóa+canh |
| **Tròn / Elip** | (hex bbox đè) | KHÔNG (đồng hướng) | **Giữ hành vi cũ**: xóa+canh. Xoay vô nghĩa (đối xứng) |
| **Chữ nhật / tứ giác đều** | KHÔNG | (inking có thể bật) | **Giữ hành vi cũ**: xóa+canh. Không lồng nên không xoay |
| **Lục giác** | (hex) | thường đồng hướng | Giữ hành vi cũ |

> Cổng chặn `has_flippable` = "có cụm lồng nào 2 hướng lệch số lượng không". Tròn (đồng hướng) và chữ
> nhật (không lồng) đều **không** thỏa → tự động dùng hành vi cũ, KHÔNG bị xoay/dịch đụng tới.

---

## 8. BẢN ĐỒ HÀM (pont_collision.py)

| Hàm | Vai trò |
|---|---|
| `calculate_forbidden_zones` | Tính 4 vùng cấm góc |
| `compute_packer_exclude_zones` | Vùng cấm → toạ độ packer (loại lúc bin-pack CNC) |
| `build_shapely_polygon_from_paths` | Polygon tem từ PDF paths (sample bezier) |
| `get_item_polygon` | Dựng polygon tem đã đặt (xoay/lật/scale/translate) |
| `detect_collisions` | Tem nào đè vùng cấm |
| `_interlocked_clusters` | Nhận cụm lồng theo bbox đè nhau (row/col) |
| `_cluster_unequal_groups` | Cụm có 2 hướng lệch số lượng? (chìa khóa) |
| `_rotate_pair_180` | Xoay 180° cục bộ trọn cụm |
| `_creates_sticker_overlap` | Chốt an toàn: xoay có sinh tem-đè không |
| `_try_local_pair_flips` | Chiến lược 1: xoay cục bộ |
| `_try_whole_block_shift` | Chiến lược 2: dịch cả khối |
| `_resolve_one_orientation` | Chiến lược 3: xóa + canh giữa theo hàng |
| `smart_resolve_collisions` | Điều phối 3 chiến lược (mục 2) |

## 9. THAM CHIẾU JSX GỐC (nếu cần đào sâu)
`scripts/illustrator/1. dev -  Nô lệ bình bài.jsx`:
- `phanTichVaChamLayout` (~2896): phát hiện, theo hình (SAT/ellipse/bbox).
- Dispatch (~15619+): cây quyết định theo số góc va chạm + `zoneSet` + `remH/remV` + ngưỡng vùng cấm.
- Scenario 0a–0d (~15645): dịch khối khi 2 góc cùng phía.
- Scenario 0.5 (~15714): xóa 1 + canh giữa CHỈ hàng đó.
- `handleCollisionScenario_*` (~3384+): các kịch bản xóa.
- `checkIfPentagonRowsAreEqual` (~4038): kiểm cặp bằng/lệch (port = `_cluster_unequal_groups`).
