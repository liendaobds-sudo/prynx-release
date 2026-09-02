# SPEC — Lô B8: Đường nhanh lưới/kệ (grid/shelf) cho nesting tem bế

Ngày: **2026-08-30**. Đơn vị: `W7-U12`. Nối tiếp: `B6` (O(N² difference nội tại) + `B7`
(clash-index, đã giao). Trạng thái: **CHỐT 1 — SPEC, chưa đụng engine. CHỜ DUYỆT.**

Liên quan: `docs/SPEC_NEST_B6_SPATIAL_INDEX_2026-08-30.md` §10 (vì sao O(N²) là nội tại),
`docs/nesting-algorithms-esko-icut.md`.

## 1. Vấn đề & vì sao cần đường khác (không phải tối ưu NFP nữa)

`B6` đã CHỨNG MINH (đo): pha `difference` của nesting NFP là **O(N²) nội tại** — ở 457 tem
tốn 32s và không có phép bỏ-blocker chính xác nào cứu được (trần 0,04%). `B7` đã cắt phần
clash O(N²) (47,6s → 35,8s) nhưng 32s difference vẫn còn. **Không thể** đẩy NFP-đầy-đủ
xuống dưới ngưỡng đó mà giữ byte-exact.

Muốn preview nhanh cho tờ nhiều tem thì phải đổi **thuật toán xếp**, chấp nhận **đổi layout**
(nên cần golden mới + cổng chất lượng + duyệt — khác hẳn B6/B7 giữ nguyên layout).

## 2. Grounding đã đo (test nesting.pdf, autofill, khổ 650×850mm)

| Chỉ số | Giá trị |
|---|---|
| Số mẫu distinct | **13** (trang-1…trang-13) |
| Bội số mỗi mẫu | **cân bằng** (~15 mỗi mẫu ở cap 195; ~35 ở cap 457) |
| Góc xoay thực tế | **100% ở 0°** (histogram `{0.0: 195}`) |
| materialUtilization | **0,6228 (62,3%)** |
| baseline (sau B7) | ~7,8s ở 195; ~35,8s ở 457 |

Hai điều rút ra:

1. **Không phải một-hình-nhân-bản.** Đây là nesting TRỘN 13 mẫu cân bằng ⇒ đường lưới cho
   "một hình" không áp thẳng. Cần chiến lược đa-mẫu.
2. **Ngưỡng cần vượt THẤP: 62,3%.** Kết quả hiện tại là xếp 0°-thuần khá lỏng (không xoay,
   interlock lõm yếu). Một đường kệ/lưới có xoay 0°/90° theo mẫu **hoàn toàn có thể ≥ 62,3%**
   mà chạy O(N log N). Tức B8 vừa nhanh vừa có cơ hội **đặc hơn** VÀ **fix luôn xoay**
   (khiếu nại gốc của người dùng: "không con tem nào xoay").

> **Cảnh báo chưa đo:** độ lõm của 13 mẫu (true-area / bbox-area). Nếu tem lõm sâu và
> interlock thật sự ăn tiền thì kệ theo-bbox sẽ thua mật độ ⇒ cổng utilization sẽ tự loại
> B8 cho mẫu đó. Đo độ lõm là **BƯỚC 1** của chốt 2 (xem §6), quyết B8 có đáng làm cho
> workload này không TRƯỚC khi viết engine.

## 3. Mục tiêu & phi mục tiêu

**Mục tiêu:** với tờ tem (die-cut) nhiều bản, cho ra layout **nhanh (O(N log N), mục tiêu
< 1–2s cho ~400 tem)**, **utilization ≥ đường NFP hiện tại**, và **có xoay khi xoay giúp**.

**Phi mục tiêu:** không thay đường NFP cho ca lõm-phức-tạp mà kệ thua mật độ (cổng tự lùi về
NFP). Không đụng schema manifest/provenance. Không phá golden NFP hiện có (đường NFP giữ
nguyên, B8 là đường SONG SONG có cổng).

## 4. Thiết kế đề xuất

### 4.1 Kiến trúc: đường nhanh có cổng, KHÔNG thay NFP

```
solve():
  fast = try_grid_fastpath(request)      # O(N log N), có xoay 0/90 theo mẫu
  base = run_baseline(...)               # NFP hiện hành (sàn an toàn, đã có B7)
  publish = argmax_utilization_valid(fast, base)   # cổng: chỉ chọn fast nếu HỢP LỆ và ≥ base
```

Cổng bảo toàn: fast chỉ được công bố khi (a) qua **cùng validator độc lập** như baseline
(không overlap, đủ gap) và (b) `utilization(fast) ≥ utilization(base) − eps`. Nếu không,
công bố baseline. ⇒ **không hồi quy mật độ trong mọi trường hợp.**

### 4.2 Thuật toán đường nhanh (ứng viên, chốt 2 A/B)

- **G-shelf (kệ Bottom-Left theo bbox).** Với mỗi mẫu chọn hướng {0°,90°} có bbox xếp dày
  hơn; xếp mọi bản bằng shelf/skyline BL dùng va chạm **bbox** (không NFP) ⇒ O(N log N).
  Đặc cho hình gần chữ nhật (tem nhãn phổ biến). Xoay có sẵn.
- **G-lattice (mạng tịnh tiến từ self-NFP).** Cho mẫu chiếm ưu thế, tính mạng 2D đặc nhất từ
  `NFP(S,S)` (đúng cách Esko/iCut — xem doc), tile. Đặc hơn cho hình lặp, nhưng phức tạp.
- **G-supercell (giải một lần rồi tile).** Bội số cân bằng ⇒ gói "một-của-mỗi-mẫu" thành
  super-cell (nesting nhỏ N≈13, chạy một lần), rồi tile super-cell khắp tờ. O(N) sau lần
  giải nhỏ. Hợp đúng với quan sát 13-mẫu-cân-bằng.

Chốt 2 prototype G-shelf trước (đơn giản, phủ ca chữ nhật) + đo; thêm G-lattice/G-supercell
nếu cần đặc hơn cho ca lõm/lặp.

### 4.3 Tái dùng hạ tầng lưới sẵn có (điều tra ở chốt 2)

`imposition_core/src/` đã có bộ giải lưới bình tem cũ: `sticker.rs`, `ratio_stack.rs`
(xếp NHIỀU mẫu theo TỈ LỆ — hợp ca đa-mẫu cân bằng), `orchestrator.rs`, `shape.rs`. Chốt 2
**bước 0**: đọc kỹ các module này để tái dùng thay vì viết lại; kiểm hợp đồng đơn vị (mm/pt)
và toạ độ. `desktop/src/lib/imposerEngine/NupGridSolver.ts` là bản lưới phía UI — phải bảo
đảm preview (sidecar/engine) KHỚP kết quả bình (yêu cầu người dùng: preview == thực thi).

### 4.4 Xoay (giải luôn khiếu nại gốc)

Đường nhanh chọn hướng theo mẫu trong {0°,90°} (và ±miền cho phép) bằng mật độ bbox ⇒ tem
THUÔN sẽ xoay để xếp dày. Đây là cách rẻ và đúng để đưa xoay vào — khác pha search NFP
(NEST-AUD-11/12) chưa bao giờ chạy xong.

## 5. Cổng chất lượng & golden (bắt buộc)

1. **Utilization gate:** `utilization(fast) ≥ utilization(baseline)` trên bộ ca đo (test
   nesting.pdf ở nhiều khổ). Có số trước/sau trong báo cáo.
2. **Validator độc lập:** layout fast PHẢI qua `validator::validate_layout` (không overlap,
   đủ gap) y như baseline — không có ngoại lệ.
3. **Golden MỚI cho đường fast** (fixtures riêng, bless CÓ CHỦ ĐÍCH kèm lý do + số
   utilization). **Golden NFP hiện có (`test_nesting_layout_golden.py`) GIỮ NGUYÊN** cho
   đường fallback — B8 không được làm đỏ nó.
4. **Preview == thực thi:** cùng engine/manifest cho cả hai; test parity khớp pose.
5. **Máy yếu:** đường nhanh giảm tải nên không vi phạm rule #1; vẫn đo để chắc.

## 6. Verify plan (chốt 2)

- **Bước 0 (QUYẾT ĐỊNH ĐI/DỪNG):** đo độ lõm 13 mẫu (true/bbox) + ước utilization G-shelf.
  Nếu G-shelf không thể ≥ 62,3% (lõm sâu) ⇒ báo cáo, cân nhắc G-lattice hoặc DỪNG B8 cho
  workload này (NFP+B7 là tốt nhất khả thi). Không viết engine trước bước 0.
- Prototype G-shelf sau `orchestrator`/`ratio_stack`; đo utilization + thời gian vs NFP ở
  cap 46/195/457.
- `cargo test imposition_core` xanh; thêm test đơn vị cho grid/shelf + xoay chọn hướng.
- Golden fast mới; parity preview/thực thi; benchmark máy rảnh trước/sau.

## 7. Phạm vi file (chốt 2, dự kiến, ≤5 file/lô — có thể tách nhiều lô)

1. `imposition_core/src/mixed_nesting/` — module đường nhanh mới (vd `grid_fastpath.rs`) +
   `mod.rs`; hoặc adapter gọi `sticker`/`ratio_stack`.
2. `imposition_core/src/mixed_nesting/solver.rs` hoặc `multi_start.rs` — cắm cổng chọn
   fast-vs-baseline.
3. `imposition_core/tests/` — test grid/shelf + xoay + cổng utilization.
4. `backend/tests/` — golden fast mới + parity.
5. Rebuild native.

## 8. Rủi ro & rollback

- **Kệ thua mật độ trên hình lõm** ⇒ cổng tự lùi về NFP; không hồi quy nhưng cũng không
  nhanh cho ca đó. Đo ở bước 0 để biết trước.
- **Preview ≠ thực thi** nếu chỉ một đường dùng fast ⇒ bắt buộc cùng engine + test parity.
- **Rollback:** đường fast sau cờ; tắt cờ ⇒ về NFP+B7 nguyên trạng. Không đụng schema.

## 9. Quy trình 2 chốt

- **Chốt 1 (bản này):** spec + grounding đo được. **Chờ duyệt.**
- **Chốt 2 (sau duyệt):** bước 0 đo độ lõm (đi/dừng) → prototype G-shelf → cổng + golden mới
  → benchmark máy rảnh → báo cáo số trước/sau. Đổi layout nên **golden mới bless có lý do**,
  KHÔNG bless để giấu hồi quy; golden NFP cũ giữ xanh.
