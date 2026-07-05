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
