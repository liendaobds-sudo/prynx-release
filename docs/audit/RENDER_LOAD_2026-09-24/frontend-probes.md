# Bằng chứng frontend render — 2026-09-24

Đây là probe audit, không phải sửa production. Chạy trên Windows thật, Vitest 4.1.6, working tree đang có nâng cấp chưa commit của user.

## Kết quả

- Bộ có sẵn: **3 file / 118 test đạt**, chạy lúc 21:03:31, 2,20 s:
  - `desktop/src/components/workspace/LivePageFrame.liveTile.test.tsx`
  - `desktop/src/components/workspace/viewportTilePolicy.test.ts`
  - `desktop/src/hooks/viewer/useTileRenderer.test.ts`
- Probe bổ sung: **2 file / 5 test không đạt**, chạy lúc 21:07:01, 1,67 s. Đây là assertion mô tả invariant cần có; failure là bằng chứng tái hiện, không phải test suite cũ bị đỏ.
- Log gốc: `frontend-probes.log`. Probe dùng React component/hook thật, mock IPC và thời điểm bitmap/decode. Chưa chứng minh runtime bản cài hoặc pixel so với Acrobat.
- Lần chạy sandbox đầu tiên gặp `spawn EPERM` trong Vite; chạy lại ngoài sandbox được auto-review cho phép và thực thi bình thường.

## Các ca

1. Base display: 100% đã vẽ → xin 130% → đổi về 120% khi 130% đang chạy → 130% về → request 120% bị loại bởi chất lượng thấp hơn → đổi 140%. Request 140% không bao giờ phát; tổng call vẫn 3 thay vì 4. Nhánh loại ở `LivePageFrame.tsx:963-972` giữ dấu in-flight, trong khi nhánh nối stream `:1010-1019` phát lại target thấp hơn mà không đi qua guard sharper-surface của effect.
2. PNG fallback: request đã có URL, `new Image` chưa decode → zoom đổi. Cleanup `:1301-1304` xóa callback decode trong khi `:1282` giữ in-flight. Tổng call vẫn 1 thay vì 2; không có callback để tiếp tục.
3. Accurate viewport đã có accurateCommitted: display target vẽ trước PPE. `:1990-1992` retire target; `:1909-1917` chuyển useDisplayLayer sang false. Canvas display vừa vẽ bị unmount trước khi PPE trả pixel.
4. Cùng ca 3 nhưng bắt đầu với **PPE cũ đã vẽ**: zoom tạo target mới → display mới xong trước PPE mới. Cả PPE cũ và display mới đều biến mất. Xác nhận không chỉ lỗi first mount.
5. PXRG valid 2×2 nhưng `createImageBitmap` reject: `getTileUrl` vẫn resolve GIF 1×1, bitmap undefined, cacheable true. `useTileRenderer.ts:275-291` nuốt lỗi decode. Đây là nhánh lỗi có điều kiện; probe không khẳng định WebView hiện tại luôn fail decode.

## Chạy lại

Hai file `.probe` giữ import tương đối của vị trí test ban đầu. Tạm sao chép từng file về:

- `LivePageFrame.audit.probe.tsx` → `desktop/src/components/workspace/LivePageFrame.audit.tmp.test.tsx`
- `useTileRenderer.audit.probe.ts` → `desktop/src/hooks/viewer/useTileRenderer.audit.tmp.test.ts`

Từ `desktop/` trên Windows, chạy:

```powershell
.\node_modules\.bin\vitest.cmd run src/components/workspace/LivePageFrame.audit.tmp.test.tsx src/hooks/viewer/useTileRenderer.audit.tmp.test.ts
```

Sau khi thu log, xóa đúng hai file tạm đã sao chép. Bản audit hiện tại đã xóa chúng khỏi production test suite, giữ bản sao và SHA-256 đối chiếu trước khi xóa.

## Hành vi không ghi thành finding

- `viewportTilePolicy.ts` giữ tile cũ khi đủ coverage: phù hợp mục đích và test hiện có đạt.
- Guard 12 MP/toàn trang không tự nó là cap chất lượng; viewport tiếp tục giữ raster mục tiêu.
- `imageSmoothingEnabled=false` tại phép `drawImage(bitmap, 0, 0)` 1:1 không điều khiển bước scale CSS; canvas vẫn dùng `imageRendering: auto`. Comment “vector sharp” hoặc chu kỳ 16 ms không phải bằng chứng đạt 60 FPS hay ngang Acrobat.
