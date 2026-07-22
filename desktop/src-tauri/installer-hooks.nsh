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

!macro NSIS_HOOK_PREINSTALL
  ; /T diệt cả cây tiến trình con (Nuitka --onefile spawn python thật làm child).
  ; /F buộc kết thúc. Nuốt output (>NUL) và bỏ qua nếu tiến trình không chạy.
  nsExec::Exec 'taskkill /IM "pdf-inspector-backend.exe" /T /F'
  Pop $0
  ; Diệt luôn app chính nếu đang mở (nếu không, file exe app cũng bị khóa ghi đè).
  nsExec::Exec 'taskkill /IM "PrynX.exe" /T /F'
  Pop $0
  ; Chờ ngắn cho OS nhả handle file trước khi NSIS bắt đầu ghi.
  Sleep 800
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
; exe): app đọc cờ qua get_startup_args → 1 ảnh + convert đi thẳng tab Ghép (xuất PDF)
; thay vì tab Bình bài. Combine KHÔNG mang cờ → giữ nguyên luồng cũ đã chạy tốt.
!define CVTVERB "pdf-inspector-convert"
!define CVTLABEL "Convert to PDF (PrynX)"
!define PDFPROGID "PrynX.PDF"
!define PDFICONREL "icons\file-pdf.ico"

; Đăng ký verb cho 1 phần mở rộng. %1 là literal trong NSIS (khác batch, không cần %%).
!macro REGISTER_COMBINE_VERB EXT
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\${CTXVERB}" "" "${CTXLABEL}"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\${CTXVERB}" "Icon" '"$INSTDIR\pdf-inspector.exe",0'
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\${CTXVERB}" "MultiSelectModel" "Player"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\${CTXVERB}\command" "" '"$INSTDIR\pdf-inspector.exe" "%1"'
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
