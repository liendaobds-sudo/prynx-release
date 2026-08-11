# Báo cáo audit đường dẫn mở khuôn bằng CorelDRAW / Illustrator

> Ngày audit: 2026-08-11
> Baseline: commit `5e22f8e` trên branch `codex/pre-release-audit-2026-08-04`
> Audit unit: `W2-U07` — **Bế → chọn ứng dụng → PDF khuôn → mở CorelDRAW/Illustrator**
> Trạng thái: `AUTO`; Lô A đã sửa `§OPENAPP.1` và khóa regression `§OPENAPP.2`
> Mức runtime: chưa tự mở ứng dụng thiết kế thật trong lượt audit này

## 1. Kết luận điều hành

Đã xác nhận đúng lỗi người dùng báo: khi PrynX **tự dò được** CorelDRAW hoặc Illustrator,
nút **Chọn lại** vẫn mở hộp chọn `.exe` và vẫn lưu đường dẫn mới vào `localStorage`, nhưng
đường dẫn hiệu lực lại ưu tiên kết quả tự dò. Hệ quả là:

- giao diện tiếp tục hiển thị đường dẫn tự dò cũ;
- bấm vào CorelDRAW/Illustrator vẫn truyền đường dẫn tự dò cũ xuống Tauri;
- đóng rồi mở lại hộp thoại vẫn không dùng lựa chọn đã lưu nếu bộ dò tiếp tục tìm thấy app;
- cùng lỗi áp dụng đối xứng cho cả Illustrator và CorelDRAW.

Lỗi nằm ở frontend, không nằm ở bộ chọn file, backend hoặc lệnh native. Harness hồi quy tạm
đã chứng minh: lựa chọn `D:\Adobe\Illustrator.exe` được lưu thành công, nhưng
`launch_external_app` thực nhận `C:\Detected\Illustrator.exe`.

Lô A được duyệt và triển khai cùng ngày: path thủ công nay ưu tiên trước path tự dò; suite
modal tăng từ 4 lên 9 test và kiểm tới payload `launch_external_app`. Không đổi PDF, backend
hoặc command native.

## 2. Hợp đồng người dùng cần giữ

1. Kết quả tự dò chỉ là **fallback ban đầu**.
2. Khi người dùng bấm **Chọn lại** và chọn một `.exe`, lựa chọn thủ công là ý định mới nhất,
   phải được hiển thị và dùng cho lần mở hiện tại.
3. Lựa chọn đã lưu phải tiếp tục có hiệu lực khi mở lại hộp thoại.
4. Illustrator và CorelDRAW có override độc lập; chọn app này không đổi app kia.
5. Sink native phải nhận đúng cặp `{ appPath, filePath }` đã chốt ở UI.

## 3. Đường chạy sống đã truy vết

| Mắt xích | Bằng chứng | Hành vi |
|---|---|---|
| Entry | `desktop/src/components/ImpositionTab.tsx:2904-2911` | Nút **Bế** mở hộp thoại. |
| Mount modal | `desktop/src/components/ImpositionTab.tsx:2747-2757` | Truyền file kết quả, chế độ tách khuôn và trang đang xem. |
| Tự dò app | `desktop/src/components/imposition-tools/OpenInDesignModal.tsx:118-139` | Gọi `detect_design_apps`, ghi kết quả vào state `detected`. |
| Nạp/lưu lựa chọn thủ công | `OpenInDesignModal.tsx:72-87, 103-105, 234-246` | Đọc/ghi `prynx.designApps.v1`; picker cập nhật state `custom`. |
| Chọn đường dẫn hiệu lực | `OpenInDesignModal.tsx:193-194` | Hiện dùng `detected.* || custom.*`. Đây là điểm làm mất quyền ưu tiên của lựa chọn mới. |
| UI + hành động mở | `OpenInDesignModal.tsx:321-350, 439-440` | Cùng biến hiệu lực được dùng để hiển thị và truyền vào `doOpen`. |
| Payload Tauri | `OpenInDesignModal.tsx:300-319` | Gọi `launch_external_app({ appPath, filePath })`. |
| Đăng ký command | `desktop/src-tauri/src/lib.rs:4660` | Command đang nằm trong invoke handler sống. |
| Consumer cuối | `desktop/src-tauri/src/external_app.rs:130-168` | Kiểm `.pdf`, `.exe`, file tồn tại rồi `Command::new(&app_path).arg(&file_path).spawn()`. Native dùng nguyên path frontend gửi, không tự đổi lại. |

Nhánh **Chỉ trang khuôn** vẫn đi qua `OpenInDesignModal.tsx:252-298`; phần chuyển OCG/layer
đã được sửa và khóa bằng artifact trong audit 2026-08-07. Lỗi đường dẫn xảy ra sau bước này
và cũng xảy ra với nhánh **Cả khuôn + in**, nên không phụ thuộc nội dung PDF.

## 4. Phát hiện

### §OPENAPP.1 — `[CONFIRMED → FIXED 2026-08-11]` P1 / effort S — Lựa chọn thủ công bị kết quả tự dò ghi đè về mặt hiệu lực

**Điều kiện chạm tới:** máy có ít nhất một bản Illustrator/CorelDRAW mà bộ dò trả về path,
sau đó người dùng bấm **Chọn lại** để trỏ sang bản khác, thường là bản đang cài đúng plugin
máy bế.

**Nguyên nhân trực tiếp trước sửa:**

```ts
const illustratorPath = detected.illustrator || custom.illustrator;
const corelPath = detected.corel || custom.corel;
```

Picker ghi vào `custom` (`OpenInDesignModal.tsx:242-245`), nhưng cả text hiển thị và nút mở
đều đọc hai biến phía trên. Khi `detected.*` có giá trị, `custom.*` không bao giờ trở thành
consumer hiệu lực.

**Consumer sống:** `appRow` gọi `doOpen(path)` tại `OpenInDesignModal.tsx:333-340`; sau đó
`launch_external_app` nhận path tại dòng `311`, và Rust dùng path này ở
`external_app.rs:165-167`.

**Bằng chứng thực thi:** harness Vitest dựng đúng chuỗi:

1. `detect_design_apps` trả `C:\Detected\Illustrator.exe`;
2. picker trả `D:\Adobe\Illustrator.exe`;
3. chờ đến khi `localStorage['prynx.designApps.v1'].illustrator` đúng bằng path mới;
4. bấm mở Illustrator.

Kỳ vọng `launch_external_app.appPath = D:\Adobe\Illustrator.exe`; thực tế nhận
`C:\Detected\Illustrator.exe`. Test đỏ đúng duy nhất field `appPath`; `filePath` khớp.

**Ảnh hưởng:** mở sai phiên bản ứng dụng, đặc biệt sai bản có plugin máy bế; lựa chọn của người
dùng trông như không cập nhật và không có cách ép dùng bản đã chọn. Không mất dữ liệu, nhưng
sai đích của hành động chính nên xếp P1.

**Phạm vi:** cả Illustrator và CorelDRAW dùng cùng biểu thức và cùng handler; quét toàn
`desktop/src` không thấy pattern `detected.* || custom.*` nào khác.

**Bản sửa:** đổi cả hai resolver thành `custom.* || detected.*`; cùng biến hiệu lực tiếp tục
được dùng cho text UI và `doOpen`, nên không tạo thêm nguồn trạng thái. Tag truy vết:
`UIUX (audit 2026-08-11 §OPENAPP.1)`.

### §OPENAPP.2 — `[CONFIRMED → FIXED 2026-08-11]` P2 / effort S — Suite hiện tại không kiểm picker hoặc ưu tiên path

`OpenInDesignModal.test.tsx:18` có mock `@tauri-apps/plugin-dialog`, nhưng không test nào gọi
picker. Bốn test hiện tại chỉ phủ:

- trạng thái trong lúc bộ dò chạy;
- thumbnail nền;
- mở bằng path tự dò;
- trích đúng trang khuôn và giữ OCG/layer.

Kết quả baseline **4/4 pass** trong khi §OPENAPP.1 vẫn tái hiện chắc chắn. Chưa có oracle cho:

- tự dò có path → chọn lại path khác;
- lựa chọn còn hiệu lực sau khi đóng/mở modal;
- Illustrator và CorelDRAW độc lập;
- hủy picker không thay đổi lựa chọn;
- tự dò không có kết quả → path thủ công vẫn dùng được.

Khoảng trống này đã để lỗi tồn tại từ commit khởi tạo tính năng `9e800ca` ngày 2026-07-17.
Sau sửa, mock picker được nối vào suite chính và 5 test mới phủ đủ danh sách trên; bảng
Illustrator/CorelDRAW tạo hai ca độc lập, đưa tổng suite modal lên 9 test.

## 5. Phát hiện bổ sung cần quyết định sản phẩm

### §OPENAPP.S1 — `[SUSPECTED / CONTRACT DECISION]` — Scope mặc định không khả thi khi không tách trang khuôn

Modal luôn mặc định `scope='cut_only'` (`OpenInDesignModal.tsx:107`) và luôn hiển thị lựa chọn
**Chỉ trang khuôn** (`:367-374`). Tuy nhiên khi `separateCut=false`, `buildSavePlan` không tạo
item `kind==='cut'` (`desktop/src/lib/printFileNaming.ts:108-124`), nên danh sách `cutPages`
rỗng và nhánh mở sẽ báo `khong_tim_thay_trang_khuon` tại `OpenInDesignModal.tsx:267-271`.

Ca này reachable vì người dùng Bình tem bế có thể tắt **Tách trang khuôn bế riêng** tại
`AdvancedSettingsSection.tsx:1343-1349`. Chưa xếp severity vì cần chốt hành vi mong muốn:

- tự chuyển mặc định sang **Cả khuôn + in** khi không có trang khuôn riêng; hoặc
- ẩn/disable **Chỉ trang khuôn** và giải thích lý do.

Không nên ngầm trích trang in thành “trang khuôn” nếu chưa chốt hợp đồng nghiệp vụ.

## 6. Những phần đã đối chứng không phải nguyên nhân

- Bộ dò native chạy qua `spawn_blocking` và kiểm path tồn tại
  (`external_app.rs:94-122`), nên không khóa UI trong lúc PowerShell dò app.
- Picker Tauri được cấp quyền `dialog:default`; người dùng báo hộp chọn mở được, và harness
  xác nhận callback picker đã hoàn tất + path mới đã lưu.
- Native kiểm phần mở rộng, file tồn tại và vị trí nhạy cảm trước khi spawn
  (`external_app.rs:132-163`). Nó không thay path đã nhận.
- Nhánh PDF tạm giữ OCG/layer đã có regression; sau sửa, modal + helper OCG đạt 29/29 test.
- Không có backend FastAPI trong đường mở app này.

## 7. Kết quả verify

| Kiểm tra | Kết quả |
|---|---|
| Baseline suite hiện hữu | **4/4 pass** dù lỗi còn tồn tại |
| Regression thêm trước code fix | **3 fail đúng §OPENAPP.1**; fallback/cancel và test cũ vẫn pass |
| `OpenInDesignModal.test.tsx` sau sửa | **9/9 pass** |
| Modal + `pdfOptionalContent` | **2 file / 29 test pass** |
| Frontend typecheck | **PASS** |
| ESLint hai file chạm | **0 error**; 1 warning hook có sẵn ngoài vùng sửa |
| Rust unit test `parse_design_apps` | Không chạy lại vì lô không đổi Rust; lượt audit trước gặp `os error 32` do resource đang được process khác giữ |
| Runtime Tauri + Illustrator/CorelDRAW thật | Chưa chạy trong lượt audit này |

Mức bằng chứng của audit unit là `AUTO`: regression component đi tới consumer Tauri mock,
typecheck và test OCG liên quan đều xanh. Chưa nâng `RUNTIME`.

## 8. Lô sửa

### Lô A — `[ĐÃ XONG 2026-08-11]` Sửa ưu tiên path và khóa hồi quy (2 file)

1. `desktop/src/components/imposition-tools/OpenInDesignModal.tsx`
   - coi path thủ công là override rõ ràng: `custom.*` ưu tiên trước `detected.*`;
   - dùng cùng một resolver cho hiển thị và `doOpen`;
   - giữ độc lập state Illustrator/CorelDRAW và giữ cấu hình cũ trong localStorage;
   - gắn tag `UIUX (audit 2026-08-11 §OPENAPP.1)`.
2. `desktop/src/components/imposition-tools/OpenInDesignModal.test.tsx`
   - thêm regression cho chọn lại khi tự dò đã có kết quả;
   - phủ cả Illustrator/CorelDRAW, lưu qua lần mở lại, cancel và fallback không tự dò;
   - test phải assert payload cuối cùng của `launch_external_app`, không chỉ text UI.

Kết quả: typecheck pass; modal 9/9; modal + `pdfOptionalContent` 29/29; ESLint 0 error.
Không cần sửa Rust/backend cho §OPENAPP.1. Chi tiết ở
`docs/DUONG_DAN_COREL_ILLUSTRATOR_FIXES_2026-08-11.md`.

### Lô B — Quyết định và khóa §OPENAPP.S1 (tối đa cùng 2 file)

Chỉ làm nếu người dùng duyệt hành vi khi `separateCut=false`. Khuyến nghị mặc định sang
**Cả khuôn + in**, vì đây là artifact duy nhất thực sự tồn tại trong cấu hình đó.

### Nghiệm thu runtime

1. Máy có nhiều phiên bản Illustrator/CorelDRAW hoặc một path tự dò khác path mong muốn.
2. Chọn lại `.exe`, xác nhận text đổi ngay.
3. Mở file và xác nhận đúng process/version nhận PDF.
4. Đóng/mở modal rồi thử lại để xác nhận persistence.
5. Lặp riêng cho Illustrator và CorelDRAW; kiểm cả **Chỉ trang khuôn** và **Cả khuôn + in**.

## 9. Chốt sau sửa

Lô A đã đóng `§OPENAPP.1` và `§OPENAPP.2` ở mức `AUTO`, không đổi format PDF hay lệnh native.
`§OPENAPP.S1` vẫn tách thành quyết định riêng và chưa sửa. Cổng còn lại là smoke Tauri với
CorelDRAW/Illustrator thật để nâng audit unit lên `RUNTIME`.
