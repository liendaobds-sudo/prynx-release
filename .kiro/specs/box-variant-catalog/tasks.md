# Implementation Plan

## Overview

Thi công theo **6 lô, mỗi lô ≤5 file**, verify xong lô trước mới sang lô sau (quy ước audit trong `AGENTS.md`). Lô 1 chỉ làm 2 `boxType` mẫu để chứng minh hướng đi đúng trước khi phủ hết catalog.

Ràng buộc xuyên suốt: KHÔNG sửa generator, `engine.ts`, `nesting*.ts`, `validateParams.ts`, và KHÔNG chạy `vitest -u` trên `goldenMaster.test.ts`. Snapshot đỏ = sai hướng, dừng soi diff.

## Tasks

### Lô 1 — Catalog + test, phủ 2 boxType mẫu

- [x] 1. Tạo module catalog biến thể
  - [x] 1.1 `desktop/src/lib/dieline/variants.ts`: `BoxGroup`, `BoxVariant`, `BOX_GROUPS`, và `BOX_VARIANTS` với 4 mục mẫu (PRYNX-SLB-01/-02, PRYNX-HW-01/-02) — chọn hai loại này vì `lockTab` và `hgbWindow` là hai kiểu chốt khác nhau (đổi nét đáy vs đổi lỗ khoét mặt trước)
  - [x] 1.2 Hàm tra cứu: `getVariant`, `getVariantByCode`, `defaultVariantFor`, `isParamLocked`, `isSectionLocked`, `isDeviated`, `countByGroup`, `variantsInGroup`
  - [x] 1.3 `variantMatchesQuery` dùng lại `normalizeSearch` — hàm đã được TÁCH từ `lib/toolRegistry.ts` sang module thuần `lib/textSearch.ts` (toolRegistry re-export, mọi chỗ gọi cũ giữ nguyên). Lý do: `lib/dieline/*` được bundle vào sidecar chạy trên Boa không có DOM; import toolRegistry vào đó sẽ kéo React vào bundle và vỡ
  - [x] 1.4 Comment đầu file ghi QUY TẮC TÁCH CARD (đổi hình thấy được trên ảnh = tách; số đo/trang trí = để trong form)
  - _Requirements: 1.1, 1.2, 1.6, 3.5, 7.4_

- [x] 2. Test toàn vẹn + chống hồi quy
  - [x] 2.1 `variants.test.ts` tầng 1: `id`/`code` duy nhất, `groups` hợp lệ, `image` đúng quy ước đường dẫn, alias không dấu, `preset` ∩ `lockedParams` = ∅
  - [x] 2.2 Tầng 2: mỗi biến thể → `generateDieline` không throw, không NaN, `boundingBox` bao đúng `allPaths`; thêm Property 2 (`validateParams` không ghi đè thuộc tính đã chốt)
  - [x] 2.3 Tầng 3: `validateParams` trên params mỗi biến thể trả `wasClamped === false`
  - [x] 2.4 Tầng 4: mỗi cặp biến thể cùng `boxType` phải khác nhau ít nhất một chỉ số (số nét CUT / CREASE / số panel / bbox)
  - [x] 2.5 Chạy `cd desktop && npx vitest run src/lib/dieline` — 29 tệp / 483 xanh, 2 skip; golden master xanh KHÔNG `-u`. `npm run typecheck` sạch
  - _Requirements: 1.5, 6.1, 6.5, 6.6_

### Lô 2 — Store

- [x] 3. Thêm trạng thái biến thể vào store
  - [x] 3.1 `stores/useBoxStore.ts` (lưu ý: thư mục là `stores/`, số nhiều): trường `variantId`, `isAdvancedMode` + `setAdvancedMode`
  - [x] 3.2 `applyVariant` + `setVariant(id)`: áp theo thứ tự `applyBoxTypeDefaults` → `preset` → `lockedParams`; tái sử dụng `applyBoxTypeDefaults`, không viết lại logic mặc định. Bước (a)+(b) chỉ chạy khi đổi họ hộp — xem bẫy ghi trong design
  - [x] 3.3 Truyền `changedKey: 'boxType'` vào `scheduleGeneration` để `clampVersion` tăng kể cả khi hai biến thể cùng `boxType` (ô nhập phải remount)
  - [x] 3.4 `setParam('boxType', …)` đồng bộ `variantId = defaultVariantFor(value).id` — state không được trỏ hai nơi khác nhau
  - [x] 3.5 `id` rác → rơi về `defaultVariantFor(params.boxType)`, không throw; `boxType` chưa được catalog phủ → `variantId = null`, giữ nguyên hành vi cũ
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [x] 4. Test store
  - [x] 4.1 Bổ sung `useBoxStore.test.ts`: thứ tự áp (a)(b)(c); `lockedParams` thắng mặc định boxType; đổi biến thể cùng `boxType` giữ số đo người dùng và vẫn tăng `clampVersion`
  - [x] 4.2 Test `id` không tồn tại → về mặc định; `boxType` ngoài catalog → `variantId` null; `setAdvancedMode`
  - [x] 4.3 `npx vitest run src/stores/useBoxStore.test.ts` — 14/14 xanh
  - _Requirements: 2.1, 2.2, 2.3, 2.5_

### Lô 3 — Thư viện: sidebar nhóm + tìm kiếm + card

- [x] 5. Dựng lại DielineGallery theo catalog
  - [x] 5.1 Thay mảng `BOX_TYPES` cứng bằng `BOX_VARIANTS`; card hiện ảnh, `nameVi`, `descVi`, `code`
  - [x] 5.2 Sidebar nhóm với số đếm từ `countByGroup()` + mục "Tất cả"; nhóm chồng lấn (một biến thể ở nhiều nhóm)
  - [x] 5.3 Ô tìm kiếm dùng `variantMatchesQuery` (bỏ dấu, nhiều từ rời, khớp cả `code` và `aliases`)
  - [x] 5.4 Trạng thái rỗng khi tìm không ra + nút "Xem tất cả"
  - [x] 5.5 Card dùng MỘT ảnh sinh tự động (script ghép dọc: hình hộp 3D TRÊN, khuôn 2D DƯỚI — đảo so với Pacdora, nhận diện bằng hình khối); `onError` → khung giữ chỗ hiện mã khuôn
  - [x] 5.6 `DielineGallery.test.tsx` (8 test): đủ card, mã khuôn hiện trên card, số đếm sidebar khớp catalog, lọc nhóm, tìm kiếm bỏ dấu + theo mã, trạng thái rỗng, `onSelect` trả `variant.id`, ảnh lỗi ra khung giữ chỗ
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 5.4_

- [x] 6. Nối luồng chọn biến thể
  - [x] 6.1 `DielineTool.tsx`: `handleSelectType(type)` → `handleSelectVariant(id)` gọi `setVariant`; cập nhật mock trong `DielineTool.sidebar.test.tsx` (mock store thiếu `setVariant` làm 2 test đỏ)
  - [x] 6.2 CSS sidebar + ô tìm kiếm + lưới card + khung giữ chỗ trong `styles/dieline-tool.css` (không inline style mới)
  - [x] 6.3 Kiểm tay trong app — **CHƯA LÀM ĐƯỢC**: môi trường agent không chạy được `run_dev.bat`. Thay bằng `DielineGallery.test.tsx` cho phần đấu nối React. Vẫn cần người kiểm mắt: bố cục sidebar/lưới, và ảnh minh hoạ (hiện toàn bộ 21 card đang ở khung giữ chỗ vì chưa chạy task 11)
  - _Requirements: 2.4, 3.1, 3.7_

### Lô 4 — Form ẩn thuộc tính đã chốt

- [x] 7. ParamPanel theo biến thể
  - [x] 7.1 Thêm helper cục bộ `show(key)` / `showSection(keys)` dựa trên `isParamLocked` + `isAdvancedMode`
  - [x] 7.2 Bọc các control của khoá bị chốt: `lockTab`, `hgbWindow`, `gableStyle`, `handleHoles`, `cupFlapPosition`, `envStyle`, `envFlapShape`, `envWindow`, cụm 3 công tắc pizza
  - [x] 7.3 Cụm pizza: ẩn cả tiêu đề section khi cả 3 khoá bị chốt (không để lại nhãn rỗng)
  - [x] 7.4 Thay `select` boxType bằng `select` biến thể có `<optgroup>` theo nhóm đầu tiên; giữ nút quay lại thư viện; thêm dòng mã khuôn dưới ô chọn
  - [x] 7.5 Công tắc "Tuỳ chỉnh nâng cao" (chỉ hiện khi biến thể có chốt gì) + chip "đã tuỳ chỉnh" khi `isDeviated`
  - [x] 7.6 i18n 5 khoá mới của form (`chua_chon_mau_khuon`, `da_tuy_chinh`, `hop_da_lech_khoi_mau_khuon_chuan`, `tuy_chinh_nang_cao`, `mo_khoa_thuoc_tinh_da_chot_cua_mau_khuon`) + CSS `dt-variant-meta`/`dt-variant-code`/`dt-variant-deviated`
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

- [x] 8. Test UI form — `ParamPanel.variant.test.tsx` (13 test)
  - [x] 8.1 Control bị chốt không render; bật chế độ chuyên gia thì render lại VÀ sửa được thật (Property 7)
  - [x] 8.2 Chip "đã tuỳ chỉnh" xuất hiện sau khi sửa khoá bị chốt
  - [x] 8.3 Phủ đủ 7 trục chốt: slb/auto_bottom `lockTab`, hanging_window `hgbWindow`, pizza gói 3 công tắc, envelope `envStyle`/`envFlapShape`/`envWindow`, gable `gableStyle`, paper_bag `handleHoles`, cup_sleeve `cupFlapPosition`
  - [x] 8.4 Khẳng định control CÓ khi chưa chốt (chống pass giả do mục thu gọn chưa mở), và biến thể không chốt gì thì không hiện công tắc chuyên gia
  - [x] 8.5 Ô chọn mẫu khuôn đổi được biến thể và áp `lockedParams`
  - _Requirements: 4.1, 4.3, 4.4_

### Lô 5 — Phủ nốt catalog + i18n

- [x] 9. Bổ sung 17 biến thể còn lại — **KÉO LÊN LÔ 3**
  - [x] 9.1 Thêm PRYNX-RTE-01, AB-01/-02, GB-01/-02, PB-01/-02, CS-01/-02, PZ-01/-02, EV-01…-04, TR-01, DT-01 theo bảng Requirement 7.1
  - [x] 9.2 Gán `groups` theo bảng trong design; `preset` khai cho paper_bag/pizza/tray/double_tray/hanging_window
  - [x] 9.3 `aliases` viết KHÔNG dấu, gồm cả tên phương ngữ ("hop am duong" ↔ "hop nap chup", "boc ly" ↔ "sleeve ly")
  - [x] 9.4 Test tầng 1 siết lại bằng `Record<BoxParams['boxType'], true>` — chốt ở tầng TYPECHECK, thêm loại hộp mà quên biến thể là `tsc` đỏ. Không phải chạm allow-list ở `runtimeValidation.ts` (Req 6.4 cấm)
  - _Lý do kéo lên_: gallery đọc thẳng catalog, nếu catalog còn 4 mục thì thư viện mất 9 loại hộp trong suốt lô 3–4. Không được để app hỏng nửa vời giữa các lô.
  - _Requirements: 1.3, 1.4, 7.1, 7.2, 7.3_

- [x] 10. i18n
  - [x] 10.1 Khoá của CHÍNH gallery (`nhom_khuon`, `tat_ca`, `tim_theo_ten_ma_khuon_hoac_nhom`, `khong_tim_thay_khuon_nao_phu_hop`, `xem_tat_ca`) — thêm ở lô 3 cùng lúc với UI, nếu không giao diện hiện raw key
  - [x] 10.2 Namespace mới `dieline.variant` với 50 khoá (21 name + 21 desc + 8 nhóm) trong `vi.json`. **Không** dùng `t('ns:key')` mà đi qua `tv(str, 'dieline.variant')` — cơ chế tra NGƯỢC từ chuỗi tiếng Việt đã có sẵn của repo, giữ catalog là dữ liệu thuần không biết gì về i18n. Ép namespace tường minh vì vài chuỗi (vd "Hộp treo có cửa sổ") còn tồn tại ở namespace gallery cũ ⇒ `tv()` không ns sẽ không đơn định
  - [x] 10.3 `en.json` đủ 50 khoá tương ứng
  - [x] 10.4 Test trong `i18nCatalog.test.ts`: mọi `nameVi`/`descVi`/tên nhóm phải có mặt trong `vi.json`, và mọi khoá của namespace phải có bản EN không rỗng. Cần test riêng vì các khoá này là ĐỘNG (qua `tv`), không phải khoá tĩnh `t('ns:key')` nên test có sẵn không quét được
  - _Requirements: 4.6_

### Lô 6 — Ảnh minh hoạ + verify phát hành

- [x] 11. Script sinh ảnh — **PHƯƠNG ÁN B** (đã dùng, xem 11.4)
  - [x] 11.1 `desktop/scripts/gen/variantThumbs.gen.ts`: lặp catalog → `generateDieline` → khuôn 2D dạng **SVG** vào `public/images/dieline/variants/<id>.svg`. Tái dùng `buildChains`/`chainToSvgD` của `sharedGeometry`, không viết lại geometry. Màu theo chú giải (CUT `#111827`, CREASE đỏ nét đứt); BLEED cố ý bỏ vì ở cỡ thumbnail chỉ làm rối
  - [x] 11.2 Đơn định: mọi hằng khung/nét cố định trong script, làm tròn 3 chữ số, chỉ ghi tệp khi nội dung thật sự đổi; có test khẳng định chạy hai lần ra chuỗi y hệt
  - [x] 11.3 npm script `gen:variant-thumbs` + `vitest.gen.config.ts` riêng. **Runner là vitest, không phải node**: engine là TS import không đuôi tệp (Node không resolve được) và repo KHÔNG có tsx/vite-node/esbuild trong `node_modules`; vitest có sẵn và resolve y như khi chạy test ⇒ không thêm dependency mới. Tệp nằm ngoài `src/` nên `npm run test` không chạm
  - [x] 11.4 **Không render được 3D headless** (three.js cần WebGL context; Playwright có sẵn nhưng phải boot cả app — ngoài phạm vi lô này). Đã qua ba vòng, ghi lại cả hai lần bị loại:
    - **Thử 1 (LOẠI):** card ghép hai tầng — ảnh hộp theo `boxType` + dải khuôn 2D SVG bên dưới. Sai vì bộ ảnh `/images/dieline/<boxType>.png` **đã** gồm cả nét khuôn lẫn hộp 3D cạnh nhau ⇒ nét khuôn hiện HAI LẦN trên một card. Bài học: đọc nội dung ảnh trước khi thiết kế layout dựa vào nó.
    - **Thử 2 (LOẠI):** một ảnh, chuỗi dự phòng 3 tầng trong `public/`, script copy ảnh `boxType` thành 21 tệp `variants/<mã>.png` để ghi đè. Sai ở hai điểm: (a) 21 tệp copy = ~16 MB, ~8 MB trùng lặp trong git; (b) khi tệp chưa có thì mỗi lần mở thư viện là 21 request 404 kèm nháy ảnh.
    - **Chốt:** ảnh mặc định là **khuôn 2D SVG nhẹ** (~1–10 KB/tệp, tổng ~90 KB) trong `public/images/dieline/variants/<mã>.svg`. Ảnh thay thủ công đặt ở **`src/assets/dieline/variants/<mã>.png`** và được `import.meta.glob` quét lúc build/dev ⇒ Vite biết trước tệp nào tồn tại nên **không có request 404 nào**, và trong dev kéo tệp vào là tự nhận (không cần chạy lệnh, không cần F5 nhờ Vite watch `src/`). Nhận `.png/.jpg/.jpeg/.webp/.avif`.
    - Tệp Vite-specific đặt ở `components/dieline-tool/variantThumbs.ts`, **không** đặt trong `lib/dieline` — thư mục đó phải sạch `import.meta.glob` vì được bundle vào sidecar chạy trên Boa.
    - Hệ quả được chấp nhận: chưa thay ảnh thì card hiện nét khuôn 2D (khác nhau chính xác giữa các biến thể) chứ không phải ảnh hộp 3D.
  - [x] 11.5 Test: `variants.test.ts` kiểm 21 tệp SVG CÓ MẶT thật trong `public/` (thiếu thì đỏ CI kèm hướng dẫn chạy script) và kiểm thư mục assets không chứa tệp lệch mã (tệp sai tên sẽ im lặng không hiện); `DielineGallery.test.tsx` kiểm card chỉ có MỘT ảnh, ưu tiên ảnh thay thủ công, và rơi về khung giữ chỗ khi lỗi
  - [x] 11.6 Script thêm bước dọn SVG mồ côi (mã khuôn đổi / biến thể bị bỏ), chỉ xoá `.svg` do chính nó sinh — không chạm định dạng khác
  - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [x] 13. Sửa cách gán nhóm sau phản hồi "xếp lung tung" (2026-07-29)
  - [x] 13.1 Nguyên nhân: cho hộp đáy gài / đáy dán / hộp treo mang THÊM nhóm `nap_cai` vì thân giống Reverse Tuck End ⇒ "Hộp nắp cài" phình lên 7 mục lẫn đủ loại, nhóm mất nghĩa. Giống về kết cấu thân KHÔNG có nghĩa là cùng họ hộp khi đi mua hàng
  - [x] 13.2 Nguyên tắc mới: mỗi biến thể ĐÚNG MỘT nhóm họ hộp; chồng lấn chỉ dành cho nhóm CẮT NGANG (`CROSS_CUT_GROUPS`, hiện chỉ có `cua_so`). Còn đúng 2 chỗ chồng lấn: hộp treo có cửa sổ, bì thư có cửa sổ
  - [x] 13.3 Số đếm sau sửa: nắp cài 1 (từ 7), đáy gài & dán 4, khay 2, thực phẩm 4 (từ 8), túi & bọc 4 (từ 6), bì thư 4, treo kệ 2, cửa sổ 2. Thứ tự sidebar: họ hộp trước, `cua_so` cuối
  - [x] 13.4 Hai test chốt nguyên tắc: mỗi biến thể đúng một nhóm họ hộp, và nhóm cắt ngang không đứng một mình
  - [x] 13.5 CSS: bỏ `.dt-gallery-card-dieline*`, trả `min-height` ảnh về 180px, thêm `min-height` cho header để ảnh mọi card bắt đầu cùng mốc (hết so le)
  - _Requirements: 3.3, 3.7, 5.4_

- [x] 12. Verify chuẩn trước khi báo xong
  - [x] 12.1 `npm run typecheck` — sạch
  - [x] 12.2 `npm run test` — **146 tệp / 1351 xanh / 2 skip**, `goldenMaster` xanh KHÔNG `-u`
  - [x] 12.3 `npm run lint:budget` — **gate passed** (errors=1480, warnings=111; nợ có sẵn). Ghi chú: chỉ thị `eslint-disable-next-line no-console` tôi thêm ban đầu làm `unused-disable` 9→10 và vỡ budget; đã bỏ chỉ thị đó
  - [x] 12.4 `npm run build:dieline-sidecar` + `check:dieline-webview` — pass, và `git diff` của `native/src/generated/dieline_engine.bundle.js` **RỖNG** ⇒ bằng chứng lớp biến thể không lọt vào bundle engine
  - [x] 12.5 Đối chiếu Requirement 6.2–6.4: `git status -- desktop/src/lib/dieline` chỉ có 2 tệp MỚI (`variants.ts`, `variants.test.ts`); allow-list ba tầng và `__snapshots__/` KHÔNG bị sửa
  - [ ] 12.6 Kiểm tay trong app — **CHƯA LÀM ĐƯỢC** (môi trường agent không chạy `run_dev.bat`). Còn cần người kiểm: bố cục thư viện, hình dạng 21 card, và xuất PDF hai biến thể cùng `boxType` để đo thấy khác nhau thật
  - _Requirements: 6.1, 6.2, 6.3, 6.4_

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1"], "rationale": "Catalog + hàm tra cứu — mọi việc sau đều đọc từ đây" },
    { "wave": 2, "tasks": ["2"], "rationale": "Test toàn vẹn + chốt golden master không nhích, gate cho toàn bộ hướng đi" },
    { "wave": 3, "tasks": ["3"], "rationale": "Store: setVariant + isAdvancedMode, cần catalog đã có" },
    { "wave": 4, "tasks": ["4"], "rationale": "Test store — cùng tệp test với store nên tách khỏi task 3" },
    { "wave": 5, "tasks": ["5", "6"], "rationale": "Gallery và wiring DielineTool: khác tệp, làm song song được" },
    { "wave": 6, "tasks": ["7"], "rationale": "ParamPanel ẩn thuộc tính chốt, cần store có isAdvancedMode" },
    { "wave": 7, "tasks": ["8"], "rationale": "Test UI form, sau khi form đã đổi" },
    { "wave": 8, "tasks": ["9", "10"], "rationale": "Phủ nốt catalog và i18n — khác tệp, song song" },
    { "wave": 9, "tasks": ["11"], "rationale": "Script ảnh, cần catalog đầy đủ mới sinh đủ ảnh" },
    { "wave": 10, "tasks": ["12"], "rationale": "Verify tổng + kiểm tay 21 biến thể + chứng minh không sửa engine" }
  ]
}
```

```
1 (variants.ts) ──► 2 (test toàn vẹn, GATE) ──┬──► 3 (store) ──► 4 (test store)
                                              │                      │
                                              ├──► 5 (gallery) ──► 6 (wiring)
                                              │                      │
                                              └──────────────► 7 (ParamPanel) ──► 8 (test UI)
                                                                     │
9 (phủ 17 biến thể còn lại) ──► 10 (i18n) ──► 11 (script ảnh) ───────┴──► 12 (verify tổng)
```

- Task 2 là **chốt gate**: nếu golden master đỏ ở đây thì hướng thiết kế sai (đã chạm hình học),
  dừng lại chứ không đi tiếp các lô sau.
- Task 5 và 7 đều đọc `isParamLocked` nhưng ở hai tệp khác nhau ⇒ song song được; task 6 sửa
  `DielineTool.tsx` nên phải sau task 5 (gallery đổi chữ ký `onSelect`).
- Task 9 chỉ cần task 1 về mặt kỹ thuật, nhưng cố ý đặt sau task 7 để mô hình UI đã được kiểm
  chứng trên 4 biến thể mẫu rồi mới nhân lên 21 — tránh sửa 21 mục hai lần.
- Task 11 cần task 9 xong (ảnh sinh theo catalog đầy đủ).

## Notes

- Test chỉ chạy trên máy Windows thật của dự án (`node_modules` chứa binary Windows) — xem `prynx-testing`.
- **Không `-u` golden master trong bất kỳ task nào.** Tính năng này là dữ liệu + UI; snapshot đổi
  nghĩa là đã chạm hình học ngoài ý muốn.
- Không refactor `ParamPanel.tsx` trong đợt này (tệp lớn, đang dùng cờ `isSLB`/`isPizza`…): chỉ
  thêm một tầng điều kiện `show()`. Refactor để riêng, tránh trộn hai loại thay đổi trong một diff.
- Không thêm `boxType` mới ⇒ không chạm allow-list ở `runtimeValidation.ts`,
  `dieline_validation.py`, `dieline_request.rs`, và không cần build lại Rust cho catalog.
- Số đếm nhóm ở sidebar cộng lại lớn hơn tổng "Tất cả" là **đúng** — nhóm chồng lấn có chủ ý.
- Nếu render 3D headless trong Node quá tốn công ở task 11, hạ phạm vi xuống ảnh 2D + chụp tay
  3D và ghi rõ lựa chọn; card đã có khung giữ chỗ nên thiếu ảnh không chặn lô nào.
