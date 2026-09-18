import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from './Button';
import { toast } from './ui/Toast';
import {
    RefreshCw,
    CheckCircle2,
    AlertCircle,
    Sparkles,
    FolderOpen,
    Copy,
    ChevronDown,
    ChevronUp,
    HelpCircle,
    Check,
} from 'lucide-react';

interface BridgeSyncStatus {
    illustratorFound: boolean;
    illustratorSynced: boolean;
    illustratorPath?: string | null;
    corelFound: boolean;
    corelSynced: boolean;
    corelPath?: string | null;
    details: string[];
}

const COREL_VBA_CODE = `' =============================================================================
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
    tempDirPath = Environ("TEMP") & "\\PrynX_Bridge"
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
    tempPdfPath = tempDirPath & "\\" & safeName & "_" & Format(Now, "hhnnss") & ".pdf"

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
    
    Dim cmd As String
    cmd = "cmd.exe /c start """" ""prynx://open?action=bridge&file=" & tempPdfPath & """"
    wsh.Run cmd, 0, False
    
    Set wsh = Nothing
    Set fso = Nothing
End Sub`;

export default function DesignBridgeSettings() {
    const [status, setStatus] = useState<BridgeSyncStatus | null>(null);
    const [loading, setLoading] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [exportMode, setExportMode] = useState<'adaptive' | 'strict'>('adaptive');
    const [showCorelGuide, setShowCorelGuide] = useState(false);
    const [copiedMacro, setCopiedMacro] = useState(false);

    const loadStatus = useCallback(async () => {
        setLoading(true);
        try {
            const res = await invoke<BridgeSyncStatus>('get_design_bridge_status');
            setStatus(res);
        } catch (err) {
            console.error('Không thể đọc trạng thái cầu nối:', err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadStatus();
    }, [loadStatus]);

    const handleSync = async () => {
        setSyncing(true);
        try {
            const res = await invoke<BridgeSyncStatus>('sync_design_bridges');
            setStatus(res);
            toast.success('Đã đồng bộ cầu nối Illustrator & CorelDRAW thành công!');
        } catch (err) {
            toast.error(`Lỗi đồng bộ cầu nối: ${String(err)}`);
        } finally {
            setSyncing(false);
        }
    };

    const handleCopyMacro = async () => {
        try {
            await navigator.clipboard.writeText(COREL_VBA_CODE);
            setCopiedMacro(true);
            toast.success('Đã sao chép mã Macro CorelDRAW vào bộ nhớ tạm!');
            setTimeout(() => setCopiedMacro(false), 3000);
        } catch {
            toast.error('Không thể sao chép vào bộ nhớ tạm.');
        }
    };

    const handleOpenCorelGmsFolder = async () => {
        try {
            const { appDataDir, join } = await import('@tauri-apps/api/path');
            const { open } = await import('@tauri-apps/plugin-shell');
            const appData = await appDataDir();
            const corelFolder = await join(appData, '..', 'Corel');
            await open(corelFolder);
            toast.info('Đang mở thư mục Corel trong File Explorer...');
        } catch (err) {
            console.warn('Không thể mở thư mục Corel:', err);
            toast.error('Không thể mở tự động thư mục CorelDRAW.');
        }
    };

    return (
        <div className="animate-fade-in flex flex-col h-full space-y-6">
            <div>
                <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">
                    🌉 Cầu nối Thiết kế (Illustrator & CorelDRAW)
                </h3>
                <p className="text-sm text-slate-500 dark:text-zinc-400 leading-relaxed">
                    Tự động kết nối 2 chiều giữa PrynX và phần mềm đồ họa. Xuất file chuyển sang PrynX chỉ với 1 cú click chuột, bảo toàn 100% đường bế Spot Color và tràn lề Bleed.
                </p>
            </div>

            {/* Trạng thái kết nối các ứng dụng */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Adobe Illustrator */}
                <div className="p-4 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50/50 dark:bg-zinc-800/40 flex flex-col justify-between">
                    <div>
                        <div className="flex items-center justify-between mb-2">
                            <span className="font-bold text-slate-800 dark:text-zinc-200 flex items-center gap-2">
                                <span className="text-orange-500 font-extrabold text-base">Ai</span> Adobe Illustrator
                            </span>
                            {status?.illustratorSynced ? (
                                <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-500/20 px-2 py-0.5 rounded-full">
                                    <CheckCircle2 className="w-3.5 h-3.5" /> Đã kết nối
                                </span>
                            ) : status?.illustratorFound ? (
                                <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-500/20 px-2 py-0.5 rounded-full">
                                    <AlertCircle className="w-3.5 h-3.5" /> Chưa đồng bộ
                                </span>
                            ) : (
                                <span className="text-xs text-slate-400 dark:text-zinc-500">Chưa phát hiện</span>
                            )}
                        </div>
                        <p className="text-xs text-slate-500 dark:text-zinc-400 line-clamp-2">
                            {status?.illustratorPath || 'Không tìm thấy cài đặt Illustrator trên máy.'}
                        </p>
                        {status?.illustratorSynced && (
                            <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-2">
                                ✓ Đã cài sẵn script vào menu: <b>File &gt; Scripts &gt; PrynX Bridge</b>
                            </p>
                        )}
                    </div>
                </div>

                {/* CorelDRAW */}
                <div className="p-4 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50/50 dark:bg-zinc-800/40 flex flex-col justify-between">
                    <div>
                        <div className="flex items-center justify-between mb-2">
                            <span className="font-bold text-slate-800 dark:text-zinc-200 flex items-center gap-2">
                                <span className="text-emerald-500 font-extrabold text-base">CDR</span> CorelDRAW
                            </span>
                            {status?.corelSynced ? (
                                <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-500/20 px-2 py-0.5 rounded-full">
                                    <CheckCircle2 className="w-3.5 h-3.5" /> Đã kết nối GMS
                                </span>
                            ) : status?.corelFound ? (
                                <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-500/20 px-2 py-0.5 rounded-full">
                                    <AlertCircle className="w-3.5 h-3.5" /> Chưa đồng bộ
                                </span>
                            ) : (
                                <span className="text-xs text-slate-400 dark:text-zinc-500">Chưa phát hiện</span>
                            )}
                        </div>
                        <p className="text-xs text-slate-500 dark:text-zinc-400 line-clamp-2">
                            {status?.corelPath || 'Không tìm thấy cài đặt CorelDRAW trên máy.'}
                        </p>
                        {status?.corelSynced && (
                            <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-2">
                                ✓ Đã đồng bộ tài nguyên macro sang thư mục Corel GMS.
                            </p>
                        )}
                    </div>

                    {/* Action buttons cho CorelDRAW */}
                    <div className="flex items-center gap-2 mt-3 pt-2.5 border-t border-slate-200/60 dark:border-white/5">
                        <button
                            type="button"
                            onClick={handleCopyMacro}
                            className="flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-zinc-700/60 border border-slate-200 dark:border-white/10 hover:bg-slate-100 dark:hover:bg-zinc-700 transition-colors text-slate-700 dark:text-zinc-200"
                            title="Sao chép toàn bộ mã Macro SendToPrynX vào bộ nhớ tạm"
                        >
                            {copiedMacro ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                            {copiedMacro ? 'Đã sao chép' : 'Sao chép Macro'}
                        </button>
                        <button
                            type="button"
                            onClick={handleOpenCorelGmsFolder}
                            className="flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-zinc-700/60 border border-slate-200 dark:border-white/10 hover:bg-slate-100 dark:hover:bg-zinc-700 transition-colors text-slate-700 dark:text-zinc-200"
                            title="Mở thư mục Macro Corel GMS trong File Explorer"
                        >
                            <FolderOpen className="w-3.5 h-3.5" /> Thư mục GMS
                        </button>
                        <button
                            type="button"
                            onClick={() => setShowCorelGuide(!showCorelGuide)}
                            className="flex items-center justify-center p-1.5 rounded-lg text-xs font-medium bg-white dark:bg-zinc-700/60 border border-slate-200 dark:border-white/10 hover:bg-slate-100 dark:hover:bg-zinc-700 transition-colors text-slate-700 dark:text-zinc-200"
                            title="Xem hướng dẫn cài đặt nút 1-Click"
                        >
                            {showCorelGuide ? <ChevronUp className="w-3.5 h-3.5" /> : <HelpCircle className="w-3.5 h-3.5" />}
                        </button>
                    </div>
                </div>
            </div>

            {/* Hướng dẫn cài đặt Macro CorelDRAW 1-Click (Expandable) */}
            {showCorelGuide && (
                <div className="p-4 rounded-xl border border-indigo-200 dark:border-indigo-500/20 bg-indigo-50/50 dark:bg-indigo-950/20 space-y-3">
                    <div className="font-semibold text-sm text-indigo-900 dark:text-indigo-200 flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-indigo-500" /> 3 Bước tạo nút bấm 1-Click trong CorelDRAW
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                        <div className="p-3 bg-white/80 dark:bg-zinc-900/60 rounded-lg border border-indigo-100 dark:border-indigo-500/10 flex flex-col gap-1">
                            <span className="font-bold text-indigo-600 dark:text-indigo-400">1. Mở Script Editor</span>
                            <span className="text-slate-600 dark:text-zinc-300">
                                Trong CorelDRAW, nhấn <b>Alt + F11</b> (hoặc menu <i>Tools &gt; Scripts &gt; Script Editor</i>).
                            </span>
                        </div>
                        <div className="p-3 bg-white/80 dark:bg-zinc-900/60 rounded-lg border border-indigo-100 dark:border-indigo-500/10 flex flex-col gap-1">
                            <span className="font-bold text-indigo-600 dark:text-indigo-400">2. Nạp Macro Bridge</span>
                            <span className="text-slate-600 dark:text-zinc-300">
                                Chuột phải vào <b>GlobalMacros</b> &gt; chọn <b>Import File...</b> &gt; chọn tệp <code>PrynX_Bridge.bas</code> (hoặc bấm Sao chép Macro và dán vào).
                            </span>
                        </div>
                        <div className="p-3 bg-white/80 dark:bg-zinc-900/60 rounded-lg border border-indigo-100 dark:border-indigo-500/10 flex flex-col gap-1">
                            <span className="font-bold text-indigo-600 dark:text-indigo-400">3. Kéo nút ra Toolbar</span>
                            <span className="text-slate-600 dark:text-zinc-300">
                                Vào <i>Tools &gt; Options &gt; Customization &gt; Commands</i> &gt; chọn nhóm <b>Macros</b> &gt; kéo lệnh <b>SendToPrynX</b> ra thanh công cụ.
                            </span>
                        </div>
                    </div>
                </div>
            )}

            {/* Thiết lập chế độ xuất PDF */}
            <div className="p-4 rounded-xl border border-slate-200 dark:border-white/10 space-y-3">
                <div className="font-semibold text-sm text-slate-800 dark:text-zinc-200 flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-indigo-500" /> Chế độ xuất PDF từ Illustrator
                </div>
                <div className="space-y-2">
                    <label className="flex items-start gap-3 cursor-pointer p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-zinc-800/60 transition-colors">
                        <input
                            type="radio"
                            name="exportMode"
                            checked={exportMode === 'adaptive'}
                            onChange={() => setExportMode('adaptive')}
                            className="mt-1 text-indigo-600"
                        />
                        <div>
                            <div className="text-sm font-medium text-slate-800 dark:text-zinc-200">
                                Kế thừa thiết lập lần xuất gần nhất + Chốt an toàn (Khuyên dùng)
                            </div>
                            <div className="text-xs text-slate-500 dark:text-zinc-400">
                                Giữ nguyên thói quen xuất file của bạn, đồng thời tự động bảo vệ đường bế Spot Color và bật tràn lề Bleed.
                            </div>
                        </div>
                    </label>
                    <label className="flex items-start gap-3 cursor-pointer p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-zinc-800/60 transition-colors">
                        <input
                            type="radio"
                            name="exportMode"
                            checked={exportMode === 'strict'}
                            onChange={() => setExportMode('strict')}
                            className="mt-1 text-indigo-600"
                        />
                        <div>
                            <div className="text-sm font-medium text-slate-800 dark:text-zinc-200">
                                Ép chuẩn in ấn PrynX Print Standard (PDF/X-4)
                            </div>
                            <div className="text-xs text-slate-500 dark:text-zinc-400">
                                Xuất chất lượng cao nhất, không suy hao ảnh, giữ nguyên vector và độ trong suốt chuẩn nhà in.
                            </div>
                        </div>
                    </label>
                </div>
            </div>

            {/* Nút hành động */}
            <div className="flex items-center justify-between pt-2">
                <div className="text-xs text-slate-400 dark:text-zinc-500">
                    {loading ? 'Đang kiểm tra kết nối...' : 'Cầu nối tự động kích hoạt mỗi khi PrynX khởi động.'}
                </div>
                <Button
                    onClick={handleSync}
                    disabled={syncing}
                    className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm px-4 py-2 rounded-lg"
                >
                    <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
                    {syncing ? 'Đang đồng bộ...' : 'Đồng bộ lại Cầu nối ngay'}
                </Button>
            </div>
        </div>
    );
}
