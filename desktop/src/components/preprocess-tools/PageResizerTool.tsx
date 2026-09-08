import type { BackgroundFillMode, ResizeOptions, ScaleMode } from '../../lib/preprocessEngine/PageResizer';
import {
    applyPageSizeMode,
    allowedScaleModes,
    shouldShowBackgroundFill,
    type PageResizerSettings,
    type PageSizeMode,
} from './pageResizerViewLogic';
import { 
    ToolSectionLabel, ToolCardOption,
    ToolCheckboxOption, ToolNumberInput,
} from './ToolUI';
import { RichSelect } from '../imposition-tools/SharedUI';
import { useTranslation } from 'react-i18next';
import { tv } from '../../i18n';
import { useEffect, useState } from 'react';
import { inspectResizeTransparency } from '../../lib/api';
import { isSupportedImageFileName, readImageDpi } from '../../lib/imageNormalizer';
import { getFileArrayBuffer } from '../../lib/utils';

const inputCls = "w-full h-8 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500";

// UIUX (audit 2026-08-01 §R.11): đồng bộ engine với Xén vuông góc, đồng thời
// cho phép giữ vùng giấy trống thay vì ép người dùng phải sinh thêm màu nền.
const BG_FILL_MODES: Array<{ value: BackgroundFillMode; title: string; desc: string }> = [
    { value: 'white', title: '⬜ Không tạo nền', desc: 'Giữ vùng trống của khổ mới theo màu giấy; không lật, kéo, làm mượt hoặc đổ thêm màu.' },
    { value: 'mirror', title: '🪞 Lật gương tự động', desc: 'Lật ngược mép ảnh siêu tốc. Giữ nguyên 100% độ sắc nét ban đầu.' },
    { value: 'trajectory', title: '🧭 Theo quỹ đạo dải màu', desc: 'Tiếp tục dải màu theo đúng hướng tại mép nội dung. Phù hợp tia tỏa, sọc nghiêng và hoa văn có hướng.' },
    { value: 'inpaint', title: '✨ Làm mượt thông minh', desc: 'CHỈ hợp mép ảnh chụp/gradient mềm. KHÔNG hợp dải màu phẳng — sẽ loang.' },
    { value: 'image', title: '🖼️ Kéo giãn mép ảnh', desc: 'Tự động kéo giãn dải màu sát mép ảnh ra ngoài lề.' },
    { value: 'solid', title: '🎨 Đổ màu trơn', desc: 'Đổ một màu đồng nhất vào vùng trống.' },
];

const COMMON_SIZES = [
    { id: 'A4', name: 'A4', desc: '210 × 297 mm', w: 210, h: 297 },
    { id: 'A3', name: 'A3', desc: '297 × 420 mm', w: 297, h: 420 },
    { id: 'A5', name: 'A5', desc: '148 × 210 mm', w: 148, h: 210 },
    { id: 'SRA3', name: 'SRA3', desc: '320 × 450 mm', w: 320, h: 450 },
    { id: 'B2', name: 'B2', desc: '500 × 707 mm', w: 500, h: 707 },
    { id: 'B3', name: 'B3', desc: '353 × 500 mm', w: 353, h: 500 },
    // UIUX (audit 2026-08-04 §DIM.2): giữ đúng kích thước Letter chuẩn khi xuất PDF.
    { id: 'Letter', name: 'Letter', desc: '215.9 × 279.4 mm', w: 215.9, h: 279.4 },
    { id: 'custom', name: 'Tùy chỉnh', desc: 'Nhập W × H', w: 0, h: 0 },
];

// RESIZE (audit 2026-08-06 §G.10): danh sách kiểu tỷ lệ tách ra hàm để khối
// "Kiểu tỷ lệ" luôn hiển thị được, kể cả khi khổ khóa một chiều chỉ còn 1 lựa chọn.
const SCALE_MODE_OPTIONS = (
    t: (key: string) => string,
): Array<{ value: ScaleMode; title: string; desc: string }> => [
    { value: 'fit', title: t('preprocess.pageResizer:thu_vua_khit'), desc: t('preprocess.pageResizer:thu_phong_noi_dung_vua_khit_vao_kho') },
    { value: 'fill', title: t('preprocess.pageResizer:phong_lap_day'), desc: t('preprocess.pageResizer:phong_to_noi_dung_lap_day_kho_moi_phan') },
    { value: 'stretch', title: t('preprocess.pageResizer:ep_bop_meo'), desc: t('preprocess.pageResizer:ep_noi_dung_vua_dung_kho_moi_nhung') },
    { value: 'center_no_scale', title: t('preprocess.pageResizer:giu_nguyen_o_giua'), desc: t('preprocess.pageResizer:giu_nguyen_kich_thuoc_noi_dung_goc_chi') },
];

const DPI_PRESETS = [150, 300, 600];

function pixelsAtDpi(mm: number, dpi: number): number {
    if (!(mm > 0) || !(dpi > 0)) return 0;
    return Math.max(1, Math.round((mm / 25.4) * dpi));
}

type DpiChoice = 'auto' | 'off' | 'custom';
type ResizeRasterMode = 'auto' | 'vector' | 'raster';

interface Props {
    settings: PageResizerSettings;
    onChange: (settings: PageResizerSettings) => void;
    pdfFile?: File | null;
    sourceImageFile?: File | null;
    getWorkingFile?: () => Promise<File>;
    viewerPageOrder?: number[];
    viewerPageRotations?: number[];
}

export default function PageResizerTool({
    settings,
    onChange,
    pdfFile,
    sourceImageFile,
    getWorkingFile,
    viewerPageOrder,
    viewerPageRotations,
}: Props) {
    const { t, i18n } = useTranslation();
    const pageSizeMode: PageSizeMode = settings.pageSizeMode || 'fixed';
    // Chỉ nhận ảnh còn khớp revision do workspace cấp, không dùng ảnh tham
    // chiếu cũ sau khi tài liệu đã resize/edit rồi gắn nhãn là "hiện tại".
    const inputImageFile = sourceImageFile
        ?? (pdfFile && isSupportedImageFileName(pdfFile.name) ? pdfFile : null);
    const [imageResolution, setImageResolution] = useState<{
        file: File;
        dpi: ReturnType<typeof readImageDpi>;
        readFailed: boolean;
    } | null>(null);
    const currentImageResolution = imageResolution?.file === inputImageFile
        ? imageResolution
        : null;

    useEffect(() => {
        if (!inputImageFile) return;
        let cancelled = false;
        void (async () => {
            try {
                // getFileArrayBuffer đọc đúng cả File rỗng có path của Tauri.
                const bytes = await getFileArrayBuffer(inputImageFile);
                if (cancelled) return;
                const dpi = readImageDpi(new Uint8Array(bytes));
                setImageResolution({ file: inputImageFile, dpi, readFailed: false });
            } catch {
                if (!cancelled) {
                    setImageResolution({ file: inputImageFile, dpi: null, readFailed: true });
                }
            }
        })();
        return () => { cancelled = true; };
    }, [inputImageFile]);

    const formatDpi = (value: number) => new Intl.NumberFormat(i18n.resolvedLanguage || i18n.language, {
        maximumFractionDigits: 2,
    }).format(value);
    const sourceDpi = currentImageResolution?.dpi;
    const currentResolutionLabel = !currentImageResolution
        ? t('preprocess.pageResizer:do_phan_giai_dang_doc', {
            defaultValue: 'Độ phân giải hiện tại: đang đọc…',
        })
        : currentImageResolution.readFailed
            ? t('preprocess.pageResizer:do_phan_giai_khong_doc_duoc', {
                defaultValue: 'Độ phân giải hiện tại: không đọc được metadata ảnh.',
            })
            : sourceDpi
                ? t('preprocess.pageResizer:do_phan_giai_hien_tai', {
                    dpi: formatDpi(sourceDpi.x) === formatDpi(sourceDpi.y)
                        ? formatDpi(sourceDpi.x)
                        : `${formatDpi(sourceDpi.x)} × ${formatDpi(sourceDpi.y)}`,
                    defaultValue: 'Độ phân giải hiện tại: {{dpi}} DPI.',
                })
                : t('preprocess.pageResizer:do_phan_giai_khong_xac_dinh', {
                    defaultValue: 'Độ phân giải hiện tại: không xác định (ảnh không có metadata DPI).',
                });
    const [transparencyInspection, setTransparencyInspection] = useState<{
        file: File;
        pageOrder?: number[];
        pageRotations?: number[];
        pages: number[];
    } | null>(null);
    const transparentPages = transparencyInspection !== null
        && transparencyInspection.file === pdfFile
        && transparencyInspection.pageOrder === viewerPageOrder
        && transparencyInspection.pageRotations === viewerPageRotations
        ? transparencyInspection.pages
        : [];

    useEffect(() => {
        if (!pdfFile) return;
        const controller = new AbortController();
        void (async () => {
            try {
                // REVISION (audit 2026-08-25 §REV.12): policy transparency phải
                // inspect cùng Working PDF mà nút Chạy sẽ dùng, không đọc backing file.
                const inspectionFile = getWorkingFile
                    ? await getWorkingFile()
                    : pdfFile;
                controller.signal.throwIfAborted();
                const isTauri = !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
                const nativePath = isTauri
                    ? (inspectionFile as File & { path?: string }).path
                    : undefined;
                const result = await inspectResizeTransparency(
                    inspectionFile,
                    nativePath,
                    controller.signal,
                );
                controller.signal.throwIfAborted();
                setTransparencyInspection({
                    file: pdfFile,
                    pageOrder: viewerPageOrder,
                    pageRotations: viewerPageRotations,
                    pages: result.transparent_pages,
                });
            } catch (error: unknown) {
                if ((error as { name?: string })?.name !== 'AbortError') {
                    // Inspection chỉ điều khiển lựa chọn bổ sung; backend Resize vẫn
                    // tự kiểm tra alpha để không làm giảm chất lượng nếu UI không tải được.
                    setTransparencyInspection({
                        file: pdfFile,
                        pageOrder: viewerPageOrder,
                        pageRotations: viewerPageRotations,
                        pages: [],
                    });
                }
            }
        })();
        return () => controller.abort();
    }, [getWorkingFile, pdfFile, viewerPageOrder, viewerPageRotations]);
    
    const handlePresetChange = (presetId: string) => {
        const preset = COMMON_SIZES.find(p => p.id === presetId);
        if (preset) {
            onChange({
                ...settings,
                sizePresetId: presetId,
                targetW: preset.id === 'custom' ? settings.targetW : preset.w,
                targetH: preset.id === 'custom' ? settings.targetH : preset.h
            });
        }
    };

    const handlePageSizeModeChange = (mode: PageSizeMode) => {
        onChange(applyPageSizeMode(settings, mode));
    };

    const handleApplyToChange = (val: string) => {
        let applyTo: ResizeOptions['applyTo'] = 'all';
        if (val === 'all' || val === 'even' || val === 'odd') {
            applyTo = val;
        } else {
            // parse custom pages on execution, keep as 'all' for now in type but we use applyToStr
            applyTo = 'all'; 
        }

        onChange({
            ...settings,
            applyToStr: val,
            applyTo
        });
    };

    return (
        <div className="flex flex-col gap-4 animate-in fade-in duration-200 relative z-[60]">



            <div className="flex flex-col gap-2">
                <ToolSectionLabel>{t('preprocess.pageResizer:1_kich_thuoc_trang_dich')}</ToolSectionLabel>
                <div className="relative z-[75]">
                    <RichSelect
                        value={pageSizeMode}
                        onChange={(v: string) => handlePageSizeModeChange(v as PageSizeMode)}
                        options={[
                            { value: 'fixed', title: t('preprocess.pageResizer:kho_co_dinh', { defaultValue: 'Khổ cố định (W × H)' }), desc: t('preprocess.pageResizer:kho_co_dinh_desc', { defaultValue: 'Mọi trang có cùng chiều rộng và chiều cao.' }) },
                            { value: 'fixed_width', title: t('preprocess.pageResizer:cung_chieu_rong', { defaultValue: 'Cùng chiều rộng' }), desc: t('preprocess.pageResizer:cung_chieu_rong_desc', { defaultValue: 'Chiều cao tự tính theo tỷ lệ từng tem.' }) },
                            { value: 'fixed_height', title: t('preprocess.pageResizer:cung_chieu_cao', { defaultValue: 'Cùng chiều cao' }), desc: t('preprocess.pageResizer:cung_chieu_cao_desc', { defaultValue: 'Chiều rộng tự tính theo tỷ lệ từng tem.' }) },
                        ]}
                    />
                </div>

                {pageSizeMode === 'fixed' && (
                <div className="relative z-[70]">
                    <RichSelect
                        value={settings.sizePresetId || 'A4'}
                        onChange={(v: string) => handlePresetChange(v)}
                        options={COMMON_SIZES.map(p => ({
                            value: p.id,
                            title: p.id === 'custom' ? tv(p.name) : p.name,
                            desc: p.id === 'custom' ? undefined : p.desc
                        }))}
                    />
                </div>
                )}
                
                {(pageSizeMode !== 'fixed' || settings.sizePresetId === 'custom') && (
                    <div className={`${pageSizeMode === 'fixed' ? 'grid-cols-2' : 'grid-cols-1'} grid gap-3 mt-1 p-3 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5`}>
                        {pageSizeMode !== 'fixed_height' && (
                        <ToolNumberInput 
                            label={t('preprocess.pageResizer:chieu_rong', { defaultValue: 'Chiều rộng' })}
                            value={settings.targetW}
                            onChange={val => onChange({ ...settings, targetW: val })}
                            suffix="mm" step={0.1}
                        />
                        )}
                        {pageSizeMode !== 'fixed_width' && (
                        <ToolNumberInput 
                            label={t('preprocess.pageResizer:chieu_cao', { defaultValue: 'Chiều cao' })}
                            value={settings.targetH}
                            onChange={val => onChange({ ...settings, targetH: val })}
                            suffix="mm" step={0.1}
                        />
                        )}
                        {pageSizeMode !== 'fixed' && (
                            <>
                            <div className="text-[10.5px] leading-snug text-slate-500 dark:text-zinc-400">
                                {t('preprocess.pageResizer:kich_thuoc_con_lai_tu_dong', { defaultValue: 'Kích thước còn lại tự động theo nội dung từng trang sau khi xén viền trắng.' })}
                            </div>
                            <div className="text-[10.5px] leading-snug text-amber-700 dark:text-amber-300">
                                {t('preprocess.pageResizer:canh_bao_nhieu_kho', { defaultValue: 'PDF đầu ra sẽ có nhiều khổ trang; một số chế độ dàn chỉ nhận các trang cùng kích thước.' })}
                            </div>
                            </>
                        )}
                    </div>
                )}
            </div>


            {transparentPages.length > 0 && (
                <div className="relative z-[65]">
                    <ToolCheckboxOption
                        selected={settings.resizeByContent === true}
                        onClick={() => onChange({
                            ...settings,
                            resizeByContent: settings.resizeByContent !== true,
                        })}
                        label={t('preprocess.pageResizer:resize_theo_noi_dung', {
                            defaultValue: 'Resize theo nội dung',
                        })}
                        desc={t('preprocess.pageResizer:resize_theo_noi_dung_desc', {
                            count: transparentPages.length,
                            defaultValue: 'Chỉ áp dụng cho trang có vùng trong suốt: bỏ phần trong suốt bên ngoài và tính tỷ lệ theo con tem. Tắt để giữ toàn bộ khổ trang.',
                        })}
                    />
                </div>
            )}



            {/* RESIZE (audit 2026-08-06 §G.10): khổ khoá một chiều trước đây ẨN HẲN
                khối "Kiểu tỷ lệ" → người dùng tưởng mất lựa chọn. Nay vẫn hiện, chỉ
                thu về đúng lựa chọn engine hỗ trợ kèm ghi chú lý do.
                RESIZE (audit 2026-08-06 §G.11): value không còn ép cứng 'fit' —
                'center_no_scale' là lựa chọn hợp lệ ở khổ khóa một chiều. */}
            <div className="flex flex-col gap-2 relative z-[60]">
                <ToolSectionLabel>{t('preprocess.pageResizer:2_kieu_ty_le')}</ToolSectionLabel>
                <RichSelect
                    value={allowedScaleModes(pageSizeMode).includes(settings.scaleMode)
                        ? settings.scaleMode
                        : 'fit'}
                    onChange={(v: string) => onChange({...settings, scaleMode: v as ScaleMode})}
                    options={SCALE_MODE_OPTIONS(t).filter(
                        o => allowedScaleModes(pageSizeMode).includes(o.value),
                    )}
                />
                {pageSizeMode !== 'fixed' && (
                    <div className="text-[10.5px] leading-snug text-slate-500 dark:text-zinc-400">
                        {t('preprocess.pageResizer:khoa_mot_chieu_giai_thich_ty_le', { defaultValue: 'Khổ khóa một chiều suy chiều còn lại theo tỷ lệ trang gốc. "Thu vừa khít" phóng nội dung theo khổ mới; "Giữ nguyên ở giữa" giữ nội dung đúng cỡ gốc và đặt vào giữa trang mới.' })}
                    </div>
                )}
            </div>

            {/* RESIZE (audit 2026-08-01 §RT.11): mode nền tự dò mép, không phụ thuộc cờ auto-trim cũ. */}
            {shouldShowBackgroundFill(settings.autoTrimBefore, settings.scaleMode, pageSizeMode) && (
                <div className="mt-1 p-3 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5 relative z-[50]">
                    <div className="text-[11px] font-medium text-slate-500 dark:text-zinc-400 mb-1.5">{t('preprocess.pageResizer:mau_nen_vung_trong')}</div>
                    <div className="flex flex-col gap-1.5">
                        <RichSelect
                            value={settings.bgFillMode || 'mirror'}
                            onChange={(v: string) => onChange({ ...settings, bgFillMode: v as BackgroundFillMode })}
                            options={BG_FILL_MODES}
                        />
                    </div>

                    {settings.bgFillMode === 'mirror' && (
                        <div className="flex items-start gap-2 mt-2 px-2.5 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40">
                            <span className="text-amber-500 text-sm leading-none mt-0.5">⚠️</span>
                            <p className="text-[10.5px] text-amber-700 dark:text-amber-300 leading-snug">
                                {/* RESIZE (audit 2026-08-06 §G.8): tách chuỗi cứng ra i18n; nhấn mạnh
                                    giữ bằng 3 mảnh <strong> nên chia thành các key riêng. */}
                                {t('preprocess.pageResizer:canh_bao_lat_guong_1')}{' '}
                                <strong>{t('preprocess.pageResizer:canh_bao_lat_guong_soi_nguoc')}</strong>{' '}
                                {t('preprocess.pageResizer:canh_bao_lat_guong_2')}{' '}
                                <strong>{t('preprocess.pageResizer:canh_bao_lat_guong_sai_noi_dung')}</strong>
                                {t('preprocess.pageResizer:canh_bao_lat_guong_3')}{' '}
                                <strong>{t('preprocess.pageResizer:canh_bao_lat_guong_keo_gian_mep')}</strong>.
                            </p>
                        </div>
                    )}

                    {settings.bgFillMode === 'solid' && (
                        <div className="mt-2 flex items-center gap-2">
                            <input
                                type="color"
                                value={settings.bgFillColor || '#ffffff'}
                                onChange={e => onChange({ ...settings, bgFillColor: e.target.value })}
                                className="w-8 h-8 rounded border border-slate-300 dark:border-white/20 cursor-pointer"
                            />
                            <input
                                type="text"
                                value={settings.bgFillColor || '#ffffff'}
                                onChange={e => onChange({ ...settings, bgFillColor: e.target.value })}
                                placeholder="#ffffff"
                                className={inputCls + ' !w-28'}
                            />
                        </div>
                    )}
                </div>
            )}



            <div className="flex flex-col gap-2 relative z-[40]">
                <ToolSectionLabel>{t('preprocess.pageResizer:3_ap_dung_cho')}</ToolSectionLabel>
                <RichSelect
                    value={['all', 'even', 'odd'].includes(settings.applyToStr) ? settings.applyToStr : 'custom'}
                    onChange={(v: string) => handleApplyToChange(v)}
                    options={[
                        { value: 'all', title: t('preprocess.pageResizer:tat_ca_trang') },
                        { value: 'even', title: t('preprocess.pageResizer:trang_chan') },
                        { value: 'odd', title: t('preprocess.pageResizer:trang_le') },
                        { value: 'custom', title: t('preprocess.pageResizer:tuy_chinh') }
                    ]}
                />

                {!['all', 'even', 'odd'].includes(settings.applyToStr) && (
                    <div className="mt-1">
                        <input
                            type="text"
                            value={settings.applyToStr === 'custom' ? '' : settings.applyToStr}
                            onChange={e => handleApplyToChange(e.target.value)}
                            placeholder="VD: 1, 3, 5-10"
                            className={inputCls}
                        />
                        <div className="text-[10px] text-slate-400 mt-1.5 ml-1">{t('preprocess.pageResizer:nhap_so_trang_cach_nhau_bang_dau_phay')}</div>
                    </div>
                )}
            </div>



            {/* 4. Giảm dung lượng theo khổ mới */}
            <div className="flex flex-col gap-2 relative z-[30]">
                <ToolSectionLabel>{t('preprocess.pageResizer:4_giam_dung_luong_theo_kho_moi')}</ToolSectionLabel>
                {(() => {
                    const dpiChoice: 'auto' | 'off' | 'custom' =
                        settings.targetDpi === undefined ? 'auto'
                            : settings.targetDpi === 0 ? 'off' : 'custom';
                    const setChoice = (c: 'auto' | 'off' | 'custom') => {
                        if (c === 'auto') onChange({ ...settings, targetDpi: undefined });
                        else if (c === 'off') onChange({ ...settings, targetDpi: 0 });
                        else onChange({ ...settings, targetDpi: settings.targetDpi && settings.targetDpi > 0 ? settings.targetDpi : 300 });
                    };
                    const mode = settings.resizeMode || 'auto';
                    const displayDpi = settings.targetDpi === undefined ? 300 : settings.targetDpi;
                    const outputWidthPx = pixelsAtDpi(settings.targetW, displayDpi);
                    const outputHeightPx = pixelsAtDpi(settings.targetH, displayDpi);
                    return (
                        <>
                            <RichSelect
                                value={dpiChoice}
                                onChange={(v: string) => {
                                    const choice: DpiChoice = v === 'off' || v === 'custom' ? v : 'auto';
                                    setChoice(choice);
                                }}
                                options={[
                                    { value: 'auto', title: t('preprocess.pageResizer:tu_dong'), desc: t('preprocess.pageResizer:giam_mau_300_dpi_khi_thu_nho_kho_khuyen') },
                                    { value: 'custom', title: t('preprocess.pageResizer:chon_dpi'), desc: t('preprocess.pageResizer:tu_dat_do_phan_giai_dich_cho_anh') },
                                    { value: 'off', title: t('preprocess.pageResizer:giu_nguyen'), desc: t('preprocess.pageResizer:khong_giam_mau_chat_luong_toi_da_file') },
                                ]}
                            />

                            {dpiChoice === 'custom' && (
                                <div className="mt-1 flex items-center gap-2">
                                    {DPI_PRESETS.map(d => (
                                        <ToolCardOption
                                            key={d}
                                            selected={settings.targetDpi === d}
                                            onClick={() => onChange({ ...settings, targetDpi: d })}
                                            label={`${d}`}
                                            desc={d === 150 ? t('preprocess.pageResizer:xem_man_hinh') : d === 300 ? 'In offset' : t('preprocess.pageResizer:in_net_cao')}
                                        />
                                    ))}
                                    <div className="w-28">
                                        <ToolNumberInput
                                            label="DPI"
                                            value={settings.targetDpi ?? 300}
                                            onChange={val => onChange({ ...settings, targetDpi: Math.max(1, Math.round(val)) })}
                                            step={10}
                                        />
                                    </div>
                                </div>
                            )}

                            {inputImageFile && (
                                <div className="text-[10.5px] leading-snug text-slate-600 dark:text-zinc-300">
                                    {currentResolutionLabel}
                                </div>
                            )}

                            {dpiChoice === 'off' ? (
                                <div className="text-[10.5px] leading-snug text-emerald-700 dark:text-emerald-300">
                                    {t('preprocess.pageResizer:giu_nguyen_pixel_nguon', {
                                        defaultValue: 'Giữ nguyên toàn bộ pixel ảnh nguồn; file có thể lớn.',
                                    })}
                                </div>
                            ) : (
                                <>
                                    {!inputImageFile && <div className="text-[10.5px] leading-snug text-slate-600 dark:text-zinc-300">
                                        {pageSizeMode === 'fixed'
                                            ? t('preprocess.pageResizer:du_kien_pixel_dau_ra', {
                                                width: outputWidthPx,
                                                height: outputHeightPx,
                                                dpi: displayDpi,
                                                defaultValue: 'Khi giảm mẫu: khoảng {{width}} × {{height}} px ở {{dpi}} DPI.',
                                            })
                                            : t('preprocess.pageResizer:du_kien_pixel_mot_chieu', {
                                                axis: pageSizeMode === 'fixed_width'
                                                    ? t('preprocess.pageResizer:chieu_rong', { defaultValue: 'chiều rộng' })
                                                    : t('preprocess.pageResizer:chieu_cao', { defaultValue: 'chiều cao' }),
                                                pixels: pageSizeMode === 'fixed_width' ? outputWidthPx : outputHeightPx,
                                                dpi: displayDpi,
                                                defaultValue: 'Trục {{axis}} khi giảm mẫu: khoảng {{pixels}} px ở {{dpi}} DPI.',
                                            })}
                                    </div>}
                                    <div className="text-[10.5px] leading-snug text-amber-700 dark:text-amber-300">
                                        {mode === 'raster'
                                            ? t('preprocess.pageResizer:canh_bao_raster_giam_net', {
                                                defaultValue: 'Raster sẽ dựng lại toàn trang và có thể làm mềm chữ/logo; chỉ dùng khi chấp nhận mất vector.',
                                            })
                                            : t('preprocess.pageResizer:canh_bao_giam_mau_co_the_mem', {
                                                defaultValue: 'Giảm mẫu sẽ bỏ bớt pixel nguồn và có thể làm mềm chi tiết raster. Muốn giữ nguyên hãy chọn “Giữ nguyên”.',
                                            })}
                                    </div>
                                </>
                            )}

                            {dpiChoice !== 'off' && (
                                <div className="mt-1 relative z-[20]">
                                    <div className="text-[11px] font-medium text-slate-500 dark:text-zinc-400 mb-1.5 ml-0.5">{t('preprocess.pageResizer:che_do_xu_ly')}</div>
                                    <RichSelect
                                        value={mode}
                                        onChange={(v: string) => {
                                            const resizeMode: ResizeRasterMode = v === 'vector' || v === 'raster' ? v : 'auto';
                                            onChange({ ...settings, resizeMode });
                                        }}
                                        options={[
                                            { value: 'auto', title: t('preprocess.pageResizer:tu_dong'), desc: t('preprocess.pageResizer:tu_chon_theo_noi_dung_trang') },
                                            { value: 'vector', title: t('preprocess.pageResizer:uu_tien_chat_luong'), desc: t('preprocess.pageResizer:giu_chu_vector_mau_cmyk_chi_giam_anh') },
                                            { value: 'raster', title: t('preprocess.pageResizer:nhanh_nhat'), desc: t('preprocess.pageResizer:dung_lai_theo_anh_mat_vector_ra_rgb') },
                                        ]}
                                    />
                                </div>
                            )}
                        </>
                    );
                })()}
            </div>

        </div>
    );
}
