' =============================================================================
' PRYNX DESIGN BRIDGE FOR CORELDRAW
' Phiên bản: 1.0.0
' Bản quyền (c) PrynX - Print made easy!
' Macro VBA xuất PDF chuẩn in ấn và chuyển sang PrynX chỉ với 1 cú click.
' =============================================================================

Option Explicit

Public Sub SendToPrynX()
    If Documents.Count = 0 Then
        MsgBox "Vui lòng mở một file thiết kế trong CorelDRAW trước khi gửi sang PrynX.", vbExclamation, "PrynX Bridge"
        Exit Sub
    End If

    Dim doc As Document
    Set doc = ActiveDocument

    ' 1. Tạo thư mục tạm an toàn
    Dim fso As Object
    Set fso = CreateObject("Scripting.FileSystemObject")
    
    Dim tempDirPath As String
    tempDirPath = Environ("TEMP") & "\PrynX_Bridge"
    If Not fso.FolderExists(tempDirPath) Then
        fso.CreateFolder tempDirPath
    End If

    ' Tên file tạm
    Dim safeName As String
    safeName = doc.FileName
    If safeName = "" Then
        safeName = "Untitled_" & Format(Now, "yyyymmdd_hhnnss")
    Else
        safeName = Left(safeName, InStrRev(safeName, ".") - 1)
    End If
    
    Dim tempPdfPath As String
    tempPdfPath = tempDirPath & "\" & safeName & "_" & Format(Now, "hhnnss") & ".pdf"

    ' 2. Cấu hình xuất PDF chuẩn in ấn cho CorelDRAW
    Dim pdf As PDFExport
    Set pdf = doc.PublishToPDF
    
    With pdf
        .Reset
        .PublishRange = pdfWholeDocument
        .PDFVersion = pdfVersion16 ' Chuẩn PDF 1.6 tương thích cao
        .ColorMode = pdfCMYK ' Hệ màu CMYK in ấn
        .SpotColors = True ' Bảo toàn 100% Spot Color đường bế CutContour
        .Bleed = True ' Tự động lấy tràn lề Bleed
        .BleedAmount = doc.BleedAmount
        .CompressText = True
        .DownsampleColor = False ' Không hạ độ phân giải ảnh
        .DownsampleGray = False
        .DownsampleMono = False
        .TextAsCurves = False ' Giữ text hoặc embed font
        .EmbedBaseFonts = True
        .EmbedAllFonts = True
        .IncludeHyperlinks = False
        .OutputSpotColorsAsSpot = True
    End With

    ' 3. Xuất file
    On Error Resume Next
    pdf.Save tempPdfPath
    If Err.Number <> 0 Then
        MsgBox "Lỗi xuất PDF sang PrynX: " & Err.Description, vbCritical, "PrynX Bridge"
        Exit Sub
    End If
    On Error GoTo 0

    ' 4. Kích hoạt PrynX mở file
    Dim wsh As Object
    Set wsh = CreateObject("WScript.Shell")
    
    ' Thử tìm file exe PrynX hoặc mở qua giao thức
    Dim cmd As String
    cmd = "cmd.exe /c start """" ""prynx://open?action=bridge&file=" & tempPdfPath & """"
    wsh.Run cmd, 0, False
    
    Set wsh = Nothing
    Set fso = Nothing
End Sub
