; NSIS installer hooks cho PrynX (Tauri v2).
; Mục đích: TRƯỚC khi cài/ghi đè file, DIỆT tiến trình đang giữ file để tránh
; lỗi "Error opening file for writing: ...\pdf-inspector-backend.exe".
;
; Vì sao cần: sidecar Python (pdf-inspector-backend.exe) do app spawn có thể còn
; treo ngầm (app crash, hoặc user chạy trình cài lúc app đang mở). NSIS không ghi
; đè được file đang chạy → trình cài kẹt ở nút Abort/Retry/Ignore. Kill ở đây để
; update chạy trơn, không cần mở Task Manager tay.
;
; Tauri v2 gọi macro NSIS_HOOK_PREINSTALL ngay trước khi giải nén file vào đích.

; [PROC-LIFECYCLE FIX 2026-08-28 §UP.1/§UP.2] Biến đếm cho vòng chờ tiến trình chết.
Var PrynxKillTries

; Diệt một tiến trình theo tên rồi CHỜ ĐẾN KHI nó thật sự biến mất.
;
; Vì sao không dùng `Sleep` cố định như trước (Sleep 800 rồi ghi file luôn): trong khoảng
; chờ đó, supervisor sidecar bên trong app CÒN SỐNG kịp respawn sidecar vừa bị diệt (giãn
; cách restart lần đầu chỉ 250 ms — xem sidecar_restart_delay trong src/lib.rs). NSIS ghi
; vào file vừa bị chiếm lại → "Error opening file for writing" → user thấy cập nhật kẹt →
; bấm Ignore ⇒ bản cài LAI (exe mới + sidecar cũ) ⇒ verify_sidecar_integrity lệch hash ⇒
; app từ chối khởi động, phải gỡ cài rồi cài lại. Audit 2026-08-28 §UP.2.
;
; Trần 12 × 250 ms = 3 s. Hết trần vẫn đi tiếp, KHÔNG tự Abort: template Tauri còn một
; lớp CheckIfAppIsRunning ngay sau hook này, tự ý Abort ở đây chỉ làm trình cài tệ hơn.
!macro PRYNX_KILL_UNTIL_GONE EXENAME LABEL
  StrCpy $PrynxKillTries 0
prynx_kill_${LABEL}:
  ; /T diệt cả cây tiến trình con (Nuitka --onefile spawn python thật làm child).
  ; /F buộc kết thúc. Bỏ qua nếu tiến trình không chạy (exit 128 là bình thường).
  nsExec::Exec 'taskkill /IM "${EXENAME}" /T /F'
  Pop $0
  Sleep 250
  ; Kiểm lại bằng exit code của `find`: 0 = CÒN dòng khớp, khác 0 = đã sạch.
  ; Dùng exit code thay vì parse chuỗi để không phụ thuộc StrFunc/WordFunc.
  nsExec::Exec 'cmd /c tasklist /FI "IMAGENAME eq ${EXENAME}" /NH | find /I "${EXENAME}" > NUL'
  Pop $0
  StrCmp $0 "0" 0 prynx_kill_done_${LABEL}
  IntOp $PrynxKillTries $PrynxKillTries + 1
  IntCmp $PrynxKillTries 12 prynx_kill_done_${LABEL} prynx_kill_${LABEL} prynx_kill_done_${LABEL}
prynx_kill_done_${LABEL}:
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; THỨ TỰ BẮT BUỘC: app chính TRƯỚC, sidecar SAU.
  ; Diệt sidecar trước là vô nghĩa khi app còn sống — supervisor sẽ respawn nó ngay.
  ;
  ; Tên tiến trình phải là pdf-inspector.exe: đó là MAINBINARYNAME Tauri sinh từ
  ; [package].name trong Cargo.toml. "PrynX" chỉ là productName (tên hiển thị + tên thư
  ; mục cài), KHÔNG có file PrynX.exe nào — lệnh taskkill cũ luôn trả "not found" nên app
  ; chính và display/print worker (cùng tên exe) sống sót qua hook. Audit 2026-08-28 §UP.1.
  !insertmacro PRYNX_KILL_UNTIL_GONE "pdf-inspector.exe" "app_pre"
  !insertmacro PRYNX_KILL_UNTIL_GONE "pdf-inspector-backend.exe" "sidecar_pre"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Template Tauri chỉ kiểm pdf-inspector.exe khi gỡ cài; sidecar sót lại sẽ khóa
  ; $INSTDIR làm gỡ cài không sạch, rồi lần cài lại vẫn gặp file cũ. Dọn cả hai.
  !insertmacro PRYNX_KILL_UNTIL_GONE "pdf-inspector.exe" "app_unin"
  !insertmacro PRYNX_KILL_UNTIL_GONE "pdf-inspector-backend.exe" "sidecar_unin"
!macroend

; ─── Context menu "Ghép trong PrynX" (chuột phải PDF/JPG/PNG) ───
; Trước đây CHỈ run_dev.bat đăng ký verb này (trỏ target\debug\pdf-inspector.exe) →
; chỉ máy dev có menu, KHÁCH cài bản release KHÔNG có. Chuyển sang installer hook để
; khách cũng có, trỏ đúng exe đã cài ($INSTDIR) và tự gỡ khi uninstall.
;
; Install mode = currentUser (RequestExecutionLevel user) → ghi HKCU (không cần admin),
; đúng nhánh SystemFileAssociations\<ext>\shell mà Explorer đọc cho menu chuột phải.
; MultiSelectModel=Player: cho chọn NHIỀU file → Windows gọi 1 tiến trình/file, app
; gom lại bằng single-instance (get_pending_system_files) → mở tab Ghép với đủ file.

!define CTXVERB "pdf-inspector-combine"
!define CTXLABEL "Combine in PrynX"

; Verb "Convert to PDF" — CHỈ cho ảnh (jpg/jpeg/png), KHÔNG cho .pdf (pdf→pdf vô nghĩa).
; Truyền cờ --prynx-action=convert để app phân biệt với Combine (cả 2 verb đều gọi cùng
; exe): app đọc cờ qua get_startup_args → 1 ảnh mở thẳng Viewer sau khi đổi sang PDF;
; nhiều ảnh vào tab Ghép để kiểm tra thứ tự. Combine mang cờ --prynx-action=combine để
; PDF không bị router Acrobat mặc định tách thành nhiều tab trước khi vào tab Ghép.
!define CVTVERB "pdf-inspector-convert"
!define CVTLABEL "Convert to PDF (PrynX)"
!define PDFPROGID "PrynX.PDF"
!define PDFICONREL "icons\file-pdf.ico"

; Đăng ký verb cho 1 phần mở rộng. %1 là literal trong NSIS (khác batch, không cần %%).
!macro REGISTER_COMBINE_VERB EXT
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\${CTXVERB}" "" "${CTXLABEL}"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\${CTXVERB}" "Icon" '"$INSTDIR\pdf-inspector.exe",0'
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\${CTXVERB}" "MultiSelectModel" "Player"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\${CTXVERB}\command" "" '"$INSTDIR\pdf-inspector.exe" --prynx-action=combine "%1"'
!macroend

!macro REGISTER_CONVERT_VERB EXT
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\${CVTVERB}" "" "${CVTLABEL}"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\${CVTVERB}" "Icon" '"$INSTDIR\pdf-inspector.exe",0'
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\${CVTVERB}" "MultiSelectModel" "Player"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\${CVTVERB}\command" "" '"$INSTDIR\pdf-inspector.exe" --prynx-action=convert "%1"'
!macroend

!macro UNREGISTER_COMBINE_VERB EXT
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\${CTXVERB}"
!macroend

!macro UNREGISTER_CONVERT_VERB EXT
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\${CVTVERB}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Tauri registers the PDF ProgID first using the application icon. Override
  ; only the document icon so Explorer can distinguish a PDF from the PrynX app.
  WriteRegStr SHCTX "Software\Classes\${PDFPROGID}\DefaultIcon" "" '"$INSTDIR\${PDFICONREL}",0'

  ; Migrate the backup created by older PrynX installers. The old generic
  ; ProgID was "PDF Document"; keeping it as the new backup would restore a
  ; stale PrynX association after uninstall instead of the user's prior app.
  ReadRegStr $0 SHCTX "Software\Classes\.pdf" "${PDFPROGID}_backup"
  StrCmp $0 "PDF Document" 0 prynx_pdf_backup_done
  ReadRegStr $1 SHCTX "Software\Classes\.pdf" "PDF Document_backup"
  WriteRegStr SHCTX "Software\Classes\.pdf" "${PDFPROGID}_backup" "$1"
prynx_pdf_backup_done:

  !insertmacro UPDATEFILEASSOC

  !insertmacro REGISTER_COMBINE_VERB ".pdf"
  !insertmacro REGISTER_COMBINE_VERB ".jpg"
  !insertmacro REGISTER_COMBINE_VERB ".jpeg"
  !insertmacro REGISTER_COMBINE_VERB ".png"
  ; Convert CHỈ cho ảnh.
  !insertmacro REGISTER_CONVERT_VERB ".jpg"
  !insertmacro REGISTER_CONVERT_VERB ".jpeg"
  !insertmacro REGISTER_CONVERT_VERB ".png"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro UNREGISTER_COMBINE_VERB ".pdf"
  !insertmacro UNREGISTER_COMBINE_VERB ".jpg"
  !insertmacro UNREGISTER_COMBINE_VERB ".jpeg"
  !insertmacro UNREGISTER_COMBINE_VERB ".png"
  !insertmacro UNREGISTER_CONVERT_VERB ".jpg"
  !insertmacro UNREGISTER_CONVERT_VERB ".jpeg"
  !insertmacro UNREGISTER_CONVERT_VERB ".png"
  !insertmacro UPDATEFILEASSOC
!macroend
