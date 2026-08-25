# Nhật ký sửa/verify — Vector hóa Logo (§LR5.01–§LR5.14), 2026-08-24

**Căn cứ:** `docs/BAO_CAO_AUDIT_LOGO_REBUILD_UIUX_2026-08-23.md` và baseline
`docs/LOGO_REBUILD_FIXES_2026-08-13.md`.

**Phạm vi:** ghi nhận lô thay đổi đang có trong worktree ngày 2026-08-24.
Agent ghi nhật ký này không stage/commit; product code được sửa theo các lô
đã ghi bên dưới. Probe tạm do lượt audit tạo đã được dọn ở bước cuối.

## Thay đổi đã ghi nhận

### Lô A — compare, wheel và accessibility

- `desktop/src/components/preprocess-tools/LogoCompareViewport.tsx:336-369`
  khóa Split/Overlay khi selection là crop hoặc perspective, đưa effective view về Source
  và hiện cảnh báo hệ tọa độ; tránh cho QA hiểu nhầm hai lớp đã căn khớp.
- `desktop/src/components/preprocess-tools/LogoCompareViewport.tsx:117-132`
  chỉ nuốt wheel khi đang zoom hoặc Ctrl+wheel; ở 100% wheel được truyền lên
  panel/trang.
- `desktop/src/components/preprocess-tools/LogoCompareViewport.tsx:209-231,444,462`
  bổ sung điều khiển tay nắm crop/perspective bằng phím mũi tên và bước Shift.
- `desktop/src/components/preprocess-tools/LogoCompareViewport.tsx:389,477`
  thêm `aria-describedby`, nhãn reset zoom và hướng dẫn bàn phím.
- `desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx:1394-1395`
  truyền copy cảnh báo so sánh và hướng dẫn bàn phím; locale VI/EN có khóa tương
  ứng tại `desktop/src/i18n/locales/vi.json:5826-5936` và
  `desktop/src/i18n/locales/en.json:5826-5936`.

### Lô B — lượng tử hóa hình học và kích thước mm

- `backend/app/workers/logo_rebuild.py:186-215,462-465` dùng chung
  `_crop_pixel_bounds` cho target dimensions và `Image.crop`, loại drift giữa
  tỷ lệ liên tục ở UI và box pixel thực tế.
- `desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx:130-132,861-893`
  tính tỷ lệ từ kích thước đã lượng tử hóa và giữ sáu chữ số thập phân cho mm.
- Regression mới ở
  `backend/tests/test_logo_rebuild.py:1028-1060,1120-1135` khóa crop 33% và
  ca mm rất nhỏ.

### Lô C — cảnh báo semantic của ảnh

- `backend/app/workers/logo_rebuild.py:47-48,935-977` phát hiện polarity đơn
  sắc chạm biên và alpha bán trong suốt.
- `backend/app/workers/logo_rebuild.py:1419-1439` chuyển hai trường hợp này
  sang `review` với lý do/hành động rõ ràng. Đây là fail-safe; native core vẫn
  chưa bảo toàn coverage alpha thành opacity SVG, nên chưa được coi là đã đóng
  parity alpha.
- Regression tương ứng ở
  `backend/tests/test_logo_rebuild.py:1139-1153,1237-1263`.

### Lô D — admission tiền kiểm

- `backend/app/workers/logo_rebuild.py:344-359` thêm ước lượng bộ nhớ và ngân
  sách dùng chung cho palette preflight.
- `backend/app/api/routes/logo_rebuild.py:277-301` đưa preflight vào
  `run_scheduled_in_threadpool` và map thiếu RAM/hủy sang lỗi có hướng xử lý.
- Regression admission ở `backend/tests/test_logo_rebuild.py:164-187`.

### Lô E — input, entitlement và review gate

- `desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx:538-548`
  kiểm MIME và giới hạn 500 MB trước preflight.
- `desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx:637-652`
  không đăng ký native-drop listener khi surface đang bị khóa entitlement.
- `desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx:437-440`
  không tự đặt `reviewAccepted=true` cho kết quả `ready`; state chỉ phản ánh
  override do người dùng bấm ở trạng thái `review`.
- Regression UI ở
  `desktop/src/components/preprocess-tools/LogoRebuildWorkspace.test.tsx:285-323,720-742,1096-1141`.
- `desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx:139`
  hiển thị coverage palette nhỏ bằng `<0.5%` thay vì làm tròn thành `0%`.

### Lô F — race của hàng đợi save

- `desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx:826-830`
  cập nhật `exportSvgRef` trong `useLayoutEffect`, ngay sau commit DOM. Trước đó
  passive effect có thể chạy sau event `app-trigger-save`, khiến queue nhận handler
  mặc định và trả `failed` dù preview đã hiện. Regression `save bị hủy hoặc lỗi...`
  đã chạy ổn định ba lần liên tiếp.

## Verify đã chạy

| Cổng | Lệnh | Kết quả |
|---|---|---|
| Python syntax | `backend\venv\Scripts\python.exe -m py_compile app\workers\logo_rebuild.py app\api\routes\logo_rebuild.py` (cwd `backend`) | **exit 0** |
| Backend logo + feature gate | `backend\venv\Scripts\python.exe -m pytest tests\test_logo_rebuild.py tests\test_logo_rebuild_feature_gate.py -q -ra` | **71 passed**, 2 warnings, 5.80 s |
| Frontend targeted | `npx vitest run src/components/preprocess-tools/LogoRebuildWorkspace.test.tsx src/i18n/i18nCatalog.test.ts src/lib/toolRegistry.routing.test.ts src/components/imposition-tools/toolPanel.test.ts src/lib/tabNavigation.test.ts` | **5 files / 80 passed**, 4.03 s |
| ESLint hẹp | `npx eslint src/components/preprocess-tools/LogoRebuildWorkspace.tsx src/components/preprocess-tools/LogoCompareViewport.tsx` | **pass** |
| TypeScript | `npm run typecheck` (cwd `desktop`) | **blocked ngoài phạm vi** — `BookReportSettings.tsx:159` (TS7053, file/worktree thay đổi song song) |
| Native logo | `cargo test logo --lib` (cwd `native`) | **69 passed**, 34 filtered, 0 failed |

Pytest vẫn có hai cảnh báo dependency/deprecation đã biết:

- `StarletteDeprecationWarning` từ `fastapi\testclient.py`.
- `PydanticDeprecatedSince20` tại `backend/app/config.py:16`.

## Kiểm tra worktree và probe tạm

- `git status --short` cho thấy worktree đang có nhiều thay đổi song song; các
  file product/test logo và locale là thay đổi liên quan lô này, chưa commit.
- `git diff --check` riêng 8 file logo sau khi dọn dòng trống cuối file: **exit 0**.
- `git diff --check` toàn worktree vẫn bị chặn bởi thay đổi ngoài phạm vi:
  `desktop/src/components/ImpositionTab.tsx:4143`,
  `desktop/src/components/dieline-tool/SolidPanelMesh.tsx:60-62`,
  `desktop/src/lib/fileContext.tsx:136`.
- Hai probe tạm `_patch_probe.txt` và `_patch_probe2.txt` đã được xóa đúng phạm
  vi; không đụng các file untracked khác.

## Proof gap còn mở

1. Chưa có Tauri runtime thật: picker/native-drop → preflight → native preview
   → save bytes → mở/render SVG 1:1.
2. Chưa có JPEG holdout khách kèm vector ground truth; fixture JPEG hiện có chỉ
   kiểm gợi ý palette.
3. Alpha mới được chuyển sang `review`; chưa có contract/output opacity được
   chứng minh bằng artifact renderer độc lập.
4. Chưa có installer/release-sidecar smoke và chưa nâng `W3-U03` lên `RUNTIME`.
5. `git diff --check` riêng các file logo đã sạch; toàn worktree còn các dòng trống/trailing
   whitespace ngoài phạm vi ở `ImpositionTab.tsx`, `SolidPanelMesh.tsx` và
   `fileContext.tsx`, cần xử lý trong lô riêng.

**Kết luận:** các cổng code-level hiện xanh ở mức AUTO, nhưng production tiếp
tục **HOLD/NO-GO** cho tới khi có artifact/runtime/holdout độc lập.
