import React, { useState, useEffect } from 'react';
import { authenticatedFetch, getApiUrl, uploadPDF } from '../../lib/api';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';
import { recipeRecorder } from '../../lib/recipe/RecipeRecorder';
import { ToolSectionLabel, ToolCardOption, ToolCheckboxOption, ToolNumberInput, ToolInfo } from './ToolUI';
import { RichSelect, ToolItem } from '../imposition-tools/SharedUI';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { useImposerSettingsStore } from '../imposition-tools/useImposerSettingsStore';
import { useTranslation } from 'react-i18next';
import { tv } from '../../i18n';
import { computeStickerBleedGeometry, formatSignedMm } from '../../lib/stickerBleedGeometry';
import {
    ALPHA_CONTOUR_INSET_MM,
    BLEED_COLOR_MODES_STICKER,
    CUT_MODES_RICH,
    DEFAULT_CROP_TO_STICKER,
    normalizeStickerBleedColorType,
    shouldCropStickerPage,
} from './stickerToolPolicy';

interface Props {
    pdfFile: File | null;
    onFileFixed?: (blob: Blob, filename: string, path?: string) => void;
}

interface CutlineRunOverrides {
    cornerStyle?: string;
    forceContour?: boolean;
}

const CORNER_STYLES = [
    { id: 'preserve', label: '🎯 Giữ nguyên', desc: '' },
    { id: 'round', label: '🟢 Góc tròn', desc: '' },
    { id: 'miter', label: '🔺 Góc nhọn', desc: '' },
];

const BLEED_COLOR_MODES_RECTANGLE = [
    { value: 'mirror', title: '🪞 Lật gương tự động', desc: 'Lật ngược mép ảnh siêu tốc. Giữ nguyên 100% độ sắc nét ban đầu.' },
    { value: 'trajectory', title: '🧭 Theo quỹ đạo dải màu', desc: 'Tiếp tục dải màu theo đúng hướng tại mép xén. Phù hợp cánh quạt, tia tỏa, sọc nghiêng và hoa văn có hướng; ưu tiên giữ ranh giới màu sắc nét.' },
    { value: 'inpaint', title: '✨ Làm mượt vùng ảnh', desc: 'Phù hợp ảnh chụp và gradient mềm; ưu tiên chuyển tiếp êm. Với logo hoặc nan màu phẳng, hãy chọn "Theo quỹ đạo dải màu" để hạn chế loang màu.' },
    { value: 'image', title: '🖼️ Kéo thẳng mép ảnh', desc: 'Kéo dải màu sát mép theo phương vuông góc với đường xén.' },
    { value: 'solid', title: '🎨 Đổ màu trơn', desc: 'Bo viền nền bằng hệ màu in ấn chuyên nghiệp (CMYK).' },
];

// Cạnh nào được bù xén (chỉ tab XÉN VUÔNG GÓC). Bế tem nhãn bù xén quanh đường
// contour nên "trên/dưới/trái/phải" không có nghĩa hình học ở đó.
type BleedSideKey = 'top' | 'right' | 'bottom' | 'left';
type BleedSides = Record<BleedSideKey, boolean>;
const BLEED_SIDE_KEYS: readonly BleedSideKey[] = ['top', 'right', 'bottom', 'left'];
const ALL_BLEED_SIDES: BleedSides = { top: true, right: true, bottom: true, left: true };

/** Một nút bật/tắt bù xén cho MỘT cạnh, đặt quanh ô khổ thành phẩm ở giữa. */
const BleedSideToggle = ({ active, label, arrow, lockHint, onToggle }: {
    active: boolean;
    label: string;
    arrow: string;
    lockHint?: string;
    onToggle: () => void;
}) => (
    <button
        type="button"
        onClick={onToggle}
        aria-pressed={active}
        title={lockHint}
        className={`h-9 px-1 rounded-lg border text-[11.5px] font-bold flex items-center justify-center gap-1 transition-all
            ${active
                ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                : 'border-dashed border-slate-300 dark:border-zinc-600 text-slate-400 dark:text-zinc-500 hover:bg-slate-100 dark:hover:bg-zinc-800'}`}
    >
        <span aria-hidden="true">{arrow}</span>
        <span className="truncate">{label}</span>
    </button>
);

const STICKER_STORAGE_PREFIX = 'ps_sticker_';
const STICKER_PREFERENCE_KEYS = [
    'productType', 'cutMode', 'offsetMm', 'cornerStyle', 'fillHoles', 'bleedMm',
    'removeWhiteBg', 'trimWhiteEdge', 'bleedColorType', 'bleedColorHex',
    'edgeBiteMm', 'edgeBiteVersion', 'cutFirstPageOnly', 'cropToSticker', 'bleedSides',
] as const;
let warnedAboutStickerStorage = false;

function warnStickerStorage(error: unknown) {
    if (warnedAboutStickerStorage) return;
    warnedAboutStickerStorage = true;
    console.warn('[StickerTool] Saved preferences are unavailable; using safe defaults.', error);
}

function getStickerStorage(): Storage | null {
    if (typeof window === 'undefined') return null;
    try {
        return window.localStorage;
    } catch (error) {
        warnStickerStorage(error);
        return null;
    }
}

function readStickerRaw(key: string): string | null {
    try {
        return getStickerStorage()?.getItem(`${STICKER_STORAGE_PREFIX}${key}`) ?? null;
    } catch (error) {
        warnStickerStorage(error);
        return null;
    }
}

function removeStickerPreference(key: string): void {
    try {
        getStickerStorage()?.removeItem(`${STICKER_STORAGE_PREFIX}${key}`);
    } catch (error) {
        warnStickerStorage(error);
    }
}

function readStickerJson(key: string): unknown {
    const raw = readStickerRaw(key);
    if (raw === null) return undefined;
    try {
        return JSON.parse(raw);
    } catch {
        removeStickerPreference(key);
        return undefined;
    }
}

function readStickerEnum(key: string, defaultValue: string, allowed: readonly string[]): string {
    const value = readStickerJson(key);
    if (typeof value === 'string' && allowed.includes(value)) return value;
    if (value !== undefined) removeStickerPreference(key);
    return defaultValue;
}

function readStickerBoolean(key: string, defaultValue: boolean): boolean {
    const value = readStickerJson(key);
    if (typeof value === 'boolean') return value;
    if (value !== undefined) removeStickerPreference(key);
    return defaultValue;
}

function readStickerNumber(key: string, defaultValue: number, min: number, max: number): number {
    const value = readStickerJson(key);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        if (value !== undefined) removeStickerPreference(key);
        return defaultValue;
    }
    return Math.min(max, Math.max(min, value));
}

function readStickerColor(): string {
    const value = readStickerJson('bleedColorHex');
    if (typeof value !== 'string') {
        if (value !== undefined) removeStickerPreference('bleedColorHex');
        return '#FFFFFF';
    }
    if (/^#[0-9a-f]{6}$/i.test(value)) return value.toUpperCase();
    const cmyk = value.split(',').map(part => Number(part.trim()));
    if (cmyk.length === 4 && cmyk.every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 100)) {
        return cmyk.map(channel => String(Math.round(channel))).join(',');
    }
    removeStickerPreference('bleedColorHex');
    return '#FFFFFF';
}

function readStickerBleedSides(): BleedSides {
    const value = readStickerJson('bleedSides');
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        if (value !== undefined) removeStickerPreference('bleedSides');
        return { ...ALL_BLEED_SIDES };
    }
    const raw = value as Record<string, unknown>;
    const resolved = { ...ALL_BLEED_SIDES };
    for (const key of BLEED_SIDE_KEYS) {
        if (typeof raw[key] === 'boolean') resolved[key] = raw[key] as boolean;
    }
    // Bỏ hết 4 cạnh = không bù xén; việc đó đã có ô "Bù xén = 0". Cấu hình rỗng
    // (build cũ, sửa tay) coi như hỏng → về mặc định nở đều thay vì âm thầm bỏ bù xén.
    if (!BLEED_SIDE_KEYS.some(side => resolved[side])) return { ...ALL_BLEED_SIDES };
    return resolved;
}

// Payload backend: danh sách cạnh ĐANG bật. Thiếu field = nở đều 4 cạnh.
function bleedSidesToParam(sides: BleedSides): string {
    return BLEED_SIDE_KEYS.filter(side => sides[side]).join(',') || 'none';
}

function writeStickerPreference(key: string, value: unknown): void {
    try {
        getStickerStorage()?.setItem(`${STICKER_STORAGE_PREFIX}${key}`, JSON.stringify(value));
    } catch (error) {
        warnStickerStorage(error);
    }
}

// Error boundary dùng hàm thuần này để tự phục hồi cấu hình lỗi.
// eslint-disable-next-line react-refresh/only-export-components
export function resetStickerPreferences(): boolean {
    const storage = getStickerStorage();
    if (!storage) return false;
    try {
        for (const key of STICKER_PREFERENCE_KEYS) storage.removeItem(`${STICKER_STORAGE_PREFIX}${key}`);
        return true;
    } catch (error) {
        warnStickerStorage(error);
        return false;
    }
}

export default function StickerTool({ pdfFile, onFileFixed }: Props) {
  const { t } = useTranslation();
    const getWorkingFile = useWorkingPdf();
    const {
        setDetectedShapeType,
        setDetectedShapeParams,
        objectSelectionContext,
        isObjectEditMode,
        setIsObjectEditMode,
        setIsCropMode,
        setViewerToolMode,
    } = useWorkspaceStore();
    const { setActiveDashboardTool } = useImposerSettingsStore();
    
    // Tab State
    const [productType, setProductType] = useState<'sticker' | 'rectangle'>(() =>
        readStickerEnum('productType', 'sticker', ['sticker', 'rectangle']) as 'sticker' | 'rectangle'
    );
    const setTaskMode = useImposerSettingsStore(s => s.setTaskMode);

    // Số từ localStorage PHẢI ép về number hợp lệ + clamp [min,max] ngay lúc khởi tạo.
    // Build cũ (hoặc sửa tay) có thể lưu giá trị vượt giới hạn UI mới, hoặc "null"/"true"
    // → nếu không sanitize, handleRun gửi thẳng giá trị sai/non-number xuống backend.
    const getSavedEdgeBite = () => {
        const saved = readStickerNumber('edgeBiteMm', 0.0, 0, 5);
        const version = readStickerRaw('edgeBiteVersion');
        // Migrate the former 0.4 mm default once, while preserving deliberate
        // user values such as 0.2, 0.5 or 1.5 mm.
        if (version !== '2' && saved === 0.4) return 0.0;
        return saved;
    };

    // UI State for Sticker
    const [cutMode, setCutMode] = useState(() => readStickerEnum('cutMode', 'original', ['original', 'alpha', 'bleed', 'none']));
    const [offsetMm, setOffsetMm] = useState<number>(() => readStickerNumber('offsetMm', 0.0, -10, 10));
    const [cornerStyle, setCornerStyle] = useState(() => readStickerEnum('cornerStyle', 'preserve', ['preserve', 'round', 'miter']));
    const [fillHoles, setFillHoles] = useState<boolean>(() => readStickerBoolean('fillHoles', true));
    // "Tạo đường cắt cho trang đầu": file nhiều loại tem CÙNG khuôn → chỉ trang 1 mang
    // đường cắt (khuôn master), trang 2+ chỉ bù xén. Bước đệm sang Bình tem bế/CNC đồng nhất.
    const [cutFirstPageOnly, setCutFirstPageOnly] = useState<boolean>(() => readStickerBoolean('cutFirstPageOnly', false));
    // UIUX (audit 2026-08-02 §CROP-STICKER.1): file tem mở trên canvas lớn
    // mặc định thu khổ theo kết quả; người dùng vẫn có thể bỏ tick để giữ khổ nguồn.
    const [cropToSticker, setCropToSticker] = useState<boolean>(() =>
        readStickerBoolean('cropToSticker', DEFAULT_CROP_TO_STICKER)
    );
    // Hình học đường cắt: backend tự nhận (auto_safe). "Hình cắt sai?" → forceContour
    // ép giữ mép ảnh. KHÔNG lưu localStorage: mỗi file khác hình, mặc định luôn auto.
    const [forceContour, setForceContour] = useState<boolean>(false);
    // Tên hình backend đã nhận (đọc từ header X-Sticker-Cut-Kind) → hiện làm van an toàn.
    const [detectedCutKind, setDetectedCutKind] = useState<string | null>(null);
    const [useObjectSelection, setUseObjectSelection] = useState(true);
    const activeObjectSelection = (
        productType === 'sticker'
        && useObjectSelection
        && objectSelectionContext
        && objectSelectionContext.objectIds.length > 0
    ) ? objectSelectionContext : null;

    // A fresh Edit PDF selection becomes the safe default. The user can still
    // turn it off here to intentionally process the whole page.
    useEffect(() => {
        if (objectSelectionContext?.objectIds.length) setUseObjectSelection(true);
    }, [
        objectSelectionContext?.fileId,
        objectSelectionContext?.pageIndex,
        objectSelectionContext?.objectIds,
    ]);

    // Shared State
    const [bleedMm, setBleedMm] = useState<number>(() => readStickerNumber('bleedMm', 0.0, 0, 10));
    const [removeWhiteBg, setRemoveWhiteBg] = useState<boolean>(() => readStickerBoolean('removeWhiteBg', true));
    const [bleedColorType, setBleedColorType] = useState(() => {
        const saved = readStickerEnum('bleedColorType', 'image', ['mirror', 'image', 'trajectory', 'inpaint', 'solid']);
        return normalizeStickerBleedColorType(saved, productType);
    });
    const [bleedColorHex, setBleedColorHex] = useState(readStickerColor);
    // "Lẹm mép" (rectangle): hút màu sâu vào trong để doa viền trắng mảnh của file không tràn lề.
    // Con dao 2 lưỡi — lẹm quá ăn vào nội dung sát mép → default nhỏ, cho chỉnh/tắt (0).
    const [edgeBiteMm, setEdgeBiteMm] = useState<number>(getSavedEdgeBite);
    // Cạnh được bù xén (chỉ Xén vuông góc). Mặc định cả 4 cạnh = hành vi cũ.
    // Dùng khi bài đã có sẵn lề một phía: tem cắt cuộn (chỉ bù trái/phải), mép dán
    // hộp, gáy sách — bù thêm cạnh đó là lệch khổ thành phẩm.
    const [bleedSides, setBleedSides] = useState<BleedSides>(readStickerBleedSides);
    const activeBleedSideCount = BLEED_SIDE_KEYS.filter(side => bleedSides[side]).length;

    const toggleBleedSide = (side: BleedSideKey) => {
        setBleedSides(prev => {
            const next = { ...prev, [side]: !prev[side] };
            // Chặn trạng thái 0 cạnh: người dùng muốn tắt hẳn bù xén thì đặt Bù xén = 0,
            // như vậy khổ trang và các nhánh màu đều đi đúng đường "không bù xén".
            if (!BLEED_SIDE_KEYS.some(key => next[key])) return prev;
            return next;
        });
    };

    // Đổi kiểu màu nền: khi chọn "Đổ màu trơn" mà giá trị hiện tại chưa ở dạng CMYK
    // ("C,M,Y,K"), khởi tạo về "0,0,0,0" để khung CMYK và giá trị gửi backend khớp
    // nhau (tránh hiển thị 0,0,0,0 nhưng lại gửi RGB #FFFFFF).
    const handleBleedColorTypeChange = (v: string) => {
        setBleedColorType(v);
        if (v === 'solid' && bleedColorHex.split(',').length !== 4) {
            setBleedColorHex('0,0,0,0');
        }
    };


    // Save to localStorage whenever state changes
    useEffect(() => {
        writeStickerPreference('productType', productType);
        writeStickerPreference('cutMode', cutMode);
        writeStickerPreference('offsetMm', offsetMm);
        writeStickerPreference('cornerStyle', cornerStyle);
        writeStickerPreference('fillHoles', fillHoles);
        writeStickerPreference('bleedMm', bleedMm);
        writeStickerPreference('removeWhiteBg', removeWhiteBg);
        writeStickerPreference('bleedColorType', bleedColorType);
        writeStickerPreference('bleedColorHex', bleedColorHex);
        writeStickerPreference('edgeBiteMm', edgeBiteMm);
        try { getStickerStorage()?.setItem(`${STICKER_STORAGE_PREFIX}edgeBiteVersion`, '2'); } catch (error) { warnStickerStorage(error); }
        writeStickerPreference('cutFirstPageOnly', cutFirstPageOnly);
        writeStickerPreference('cropToSticker', cropToSticker);
        writeStickerPreference('bleedSides', bleedSides);
    }, [productType, cutMode, offsetMm, cornerStyle, fillHoles, bleedMm, removeWhiteBg, bleedColorType, bleedColorHex, edgeBiteMm, cutFirstPageOnly, cropToSticker, bleedSides]);
    
    // Process state
    const [isProcessing, setIsProcessing] = useState(false);
    const [error, setError] = useState('');
    const [warning, setWarning] = useState('');
    const [isSuccess, setIsSuccess] = useState(false);

    const runVectorMirror = async () => {
        // Step 1: Upload
        const uploadRes = await uploadPDF((await getWorkingFile()) || pdfFile!);
        const currentFid = uploadRes.id;
        
        // Khổ trang hiện tại là khổ thành phẩm. Không pixel-auto-trim trước khi
        // bù xén vì vùng trắng sát mép có thể là một phần hợp lệ của thiết kế.
        const bleedRes = await authenticatedFetch(`${getApiUrl()}/preflight/mirror-bleed`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                file_id: currentFid,
                bleed_mm: bleedMm,
                pages: null,
                bleed_sides: BLEED_SIDE_KEYS.filter(side => bleedSides[side]),
            }),
        });
        const bleedData = await bleedRes.json();
        if (!bleedData.success) throw new Error(bleedData.detail || t('preprocess.sticker:loi_tao_bu_xen_vector'));
        
        // Final Output
        const finalRes = await authenticatedFetch(`${getApiUrl()}/preflight/download/${bleedData.output_filename}`);
        return await finalRes.blob();
    };

    const runOpenCVBleed = async (overrides?: CutlineRunOverrides) => {
        const requestedCornerStyle = overrides?.cornerStyle ?? cornerStyle;
        const requestedForceContour = overrides?.forceContour ?? forceContour;
        const targetFile = (await getWorkingFile()) || pdfFile!;
        const localPath = (
            (window as any).__TAURI_INTERNALS__
            && typeof (targetFile as any).path === 'string'
            && (targetFile as any).path.length > 0
        ) ? (targetFile as any).path as string : undefined;

        // An unchanged desktop working file already exists on the same machine as
        // the sidecar. Use its path directly; baked page edits have no path and
        // retain the upload fallback so their modified bytes are never skipped.
        const uploadRes = localPath ? null : await uploadPDF(targetFile);
        
        const formData = new FormData();
        if (localPath) formData.append('file_path', localPath);
        else formData.append('file_id', String(uploadRes!.id));
        formData.append('cut_mode', productType === 'rectangle' ? 'none' : cutMode);
        formData.append('offset_mm', productType === 'rectangle' ? '0' : String(offsetMm));
        formData.append('corner_style', productType === 'rectangle' ? 'miter' : (cutMode === 'alpha' ? 'preserve' : requestedCornerStyle));
        formData.append('bleed_mm', String(bleedMm));
        formData.append('fill_holes', productType === 'rectangle' ? 'true' : (fillHoles ? 'true' : 'false'));
        formData.append('remove_white_bg', productType === 'rectangle' || cutMode === 'alpha' ? 'false' : (removeWhiteBg ? 'true' : 'false'));
        formData.append('draw_cut_contour', productType === 'rectangle' ? 'false' : (cutMode !== 'none' ? 'true' : 'false'));
        formData.append('bleed_color_type', bleedColorType); // image | trajectory | inpaint | solid
        formData.append('bleed_color_hex', bleedColorHex);
        // Lẹm mép CHỈ tab Xén vuông (không có “Bỏ nền trắng” dò mask).
        // Tab Bế tem: một nút “Bỏ nền trắng” + sample viền (shell/AA) — không thêm ô lẹm.
        formData.append('edge_bite_mm', productType === 'rectangle' ? String(edgeBiteMm) : '0');
        // Chọn cạnh bù xén CHỈ có nghĩa với Xén vuông góc; Bế tem nhãn bù quanh
        // đường contour nên luôn gửi "all" để backend nở đều như trước.
        formData.append('bleed_sides', productType === 'rectangle' ? bleedSidesToParam(bleedSides) : 'all');
        // "Tạo đường cắt cho trang đầu": chỉ tab Bế tem nhãn. Trang 1 mang khuôn
        // CutContour, trang 2+ chỉ bù xén → bước đệm cho Bình tem bế/CNC đồng nhất.
        formData.append('cut_first_page_only', productType === 'sticker' && cutFirstPageOnly ? 'true' : 'false');
        formData.append('crop_to_sticker', shouldCropStickerPage(productType, cutMode, cropToSticker) ? 'true' : 'false');
        formData.append(
            'shape_mode',
            productType === 'sticker'
                ? (cutMode === 'alpha'
                    ? 'contour'
                    : ((requestedCornerStyle === 'preserve' || requestedForceContour) ? 'contour' : 'auto_safe'))
                : 'contour',
        );
        if (productType === 'rectangle') {
            formData.append('rectangle_mode', 'true');
        }
        if (activeObjectSelection) {
            formData.append('selection_json', JSON.stringify({
                pages: [{
                    page: activeObjectSelection.pageIndex,
                    object_ids: activeObjectSelection.objectIds,
                }],
            }));
        }
        
        const response = await authenticatedFetch(`${getApiUrl()}/pdf-tools/sticker-dieline`, {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => null);
            throw new Error(errData?.detail || t('preprocess.sticker:loi_server', { status: response.status }));
        }
        
        if (productType === 'sticker') {
            const shapeType = response.headers.get('X-Sticker-Shape-Type');
            const shapeParams = response.headers.get('X-Sticker-Shape-Params');
            setDetectedShapeType(shapeType);
            setDetectedShapeParams(shapeParams);
            // Hình học đường cắt máy tự nhận (van an toàn thay dropdown đã ẩn):
            // có kind → tên hình; không có (die phức tạp / forceContour) → 'contour'.
            const cutKind = response.headers.get('X-Sticker-Cut-Kind');
            setDetectedCutKind(cutKind || ((requestedCornerStyle === 'preserve' || requestedForceContour) ? 'contour' : null));
        }

        // Cảnh báo nghiệp vụ (vd một số trang không dò được hình) — header được
        // percent-encode ở backend để giữ tiếng Việt.
        const warnHeader = response.headers.get('X-Sticker-Warning');
        if (warnHeader) {
            try { setWarning(decodeURIComponent(warnHeader)); } catch { setWarning(warnHeader); }
        }
        
        const outputPath = response.headers.get('X-Sticker-Output-Path') || undefined;
        return { blob: await response.blob(), path: outputPath };
    };

    const handleRun = async (overrides?: CutlineRunOverrides) => {
        if (!pdfFile) return;
        const requestedCornerStyle = overrides?.cornerStyle ?? cornerStyle;
        const requestedForceContour = overrides?.forceContour ?? forceContour;

        setIsSuccess(false);
        setIsProcessing(true);
        setError('');
        setWarning('');

        // Selection ids belong to one concrete PDF revision and must not be
        // replayed by a recipe on another file.
        const recordedRecipeOperation = !activeObjectSelection;
        if (recordedRecipeOperation) {
            recipeRecorder.noteOperation('sticker_dieline', {
                productType, cutMode, offsetMm, cornerStyle: requestedCornerStyle, fillHoles,
                bleedMm, removeWhiteBg, bleedColorType, bleedColorHex, edgeBiteMm,
                cutFirstPageOnly, cropToSticker,
                bleedSides: { ...bleedSides },
                shapeMode: (requestedCornerStyle === 'preserve' || requestedForceContour) ? 'contour' : 'auto_safe',
            });
        }

        try {
            let resultBlob: Blob;
            let resultPath: string | undefined;

            if (productType === 'rectangle' && bleedColorType === 'mirror') {
                resultBlob = await runVectorMirror();
            } else {
                const result = await runOpenCVBleed(overrides);
                resultBlob = result.blob;
                resultPath = result.path;
            }

            if (onFileFixed) {
                const prefix = productType === 'rectangle' ? 'autobleed' : 'sticker';
                const baseName = pdfFile.name.replace(/\.[^/.]+$/, "");
                onFileFixed(resultBlob, `${prefix}_${baseName}.pdf`, resultPath);
                setIsSuccess(true);
            }
        } catch (e: any) {
            if (recordedRecipeOperation) recipeRecorder.discardPending();
            setError(e.message || t('preprocess.sticker:da_xay_ra_loi_khong_xac_dinh'));
        } finally {
            setIsProcessing(false);
        }
    };

    // Auto-fix bleedColorType when switching tabs
    const handleProductTypeChange = (type: 'sticker' | 'rectangle') => {
        setProductType(type);
        const normalizedBleedColorType = normalizeStickerBleedColorType(bleedColorType, type);
        if (normalizedBleedColorType !== bleedColorType) {
            setBleedColorType(normalizedBleedColorType);
        }
        // Removing the aggressive override when switching to rectangle to preserve user choice
    };

    // UIUX (audit 2026-07-28 §BX.6): cho thấy rõ bleed được đo từ đường cắt,
    // không đổi công thức backend đã chốt.
    // UIUX (audit 2026-08-01 §ALPHA.1): Alpha tự lùi 0,15 mm; phần tóm tắt
    // phải phản chiếu đúng hình học backend thay vì vẫn báo offset 0 mm.
    const bleedGeometry = computeStickerBleedGeometry(
        cutMode,
        cutMode === 'alpha' ? offsetMm - ALPHA_CONTOUR_INSET_MM : offsetMm,
        bleedMm,
    );

    return (
        <div className="flex flex-col gap-4">
            {/* TABS SELECTOR */}
            <div className="flex bg-slate-100 dark:bg-zinc-800/50 p-1 rounded-xl shadow-inner border border-slate-200 dark:border-white/5 relative z-10">
                <button
                    onClick={() => handleProductTypeChange('sticker')}
                    aria-pressed={productType === 'sticker'}
                    className={`flex-1 flex flex-row items-center justify-center gap-2 py-2.5 rounded-lg text-[11px] font-bold transition-all relative z-10 ${
                        productType === 'sticker'
                            ? 'bg-white dark:bg-zinc-800 text-indigo-600 dark:text-indigo-400 shadow-md ring-1 ring-indigo-100 dark:ring-indigo-500/30'
                            : 'text-slate-500 hover:text-slate-700 dark:hover:text-zinc-300 hover:bg-slate-200/50 dark:hover:bg-zinc-700/50'
                    }`}
                >
                    <span className="text-lg">🔵</span>
                    {t('preprocess.sticker:be_tem_nhan')}
                </button>
                <button
                    onClick={() => handleProductTypeChange('rectangle')}
                    aria-pressed={productType === 'rectangle'}
                    className={`flex-1 flex flex-row items-center justify-center gap-2 py-2.5 rounded-lg text-[11px] font-bold transition-all relative z-10 ${
                        productType === 'rectangle'
                            ? 'bg-white dark:bg-zinc-800 text-indigo-600 dark:text-indigo-400 shadow-md ring-1 ring-indigo-100 dark:ring-indigo-500/30'
                            : 'text-slate-500 hover:text-slate-700 dark:hover:text-zinc-300 hover:bg-slate-200/50 dark:hover:bg-zinc-700/50'
                    }`}
                >
                    <span className="text-lg">🟦</span>
                    {t('preprocess.sticker:xen_vuong_goc')}
                </button>
            </div>

            {/* --- TAB 1: BẾ TEM NHÃN --- */}
            {productType === 'sticker' && (
                <div className="animate-in slide-in-from-left-4 fade-in duration-300 space-y-4">
                    <div className={`rounded-xl border px-3 py-2 transition-colors ${
                        isObjectEditMode
                            ? 'border-emerald-500 bg-emerald-500/10'
                            : 'border-slate-200 bg-slate-50 dark:border-zinc-700 dark:bg-zinc-900'
                    }`}>
                        <div className="flex items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-1.5">
                                <span className="text-[11px] font-bold text-slate-700 dark:text-zinc-200">
                                    Chọn sticker cần bù xén
                                </span>
                                <span
                                    role="note"
                                    tabIndex={0}
                                    aria-label="Chọn sticker trực tiếp trên trang. Bấm “Bắt đầu chọn”, rồi chọn các sticker cần xử lý trên cùng một trang; panel này luôn được giữ nguyên. Khi đã chọn, chỉ các đối tượng được tick mới được bù xén/đường cắt — bỏ tick để xử lý toàn trang."
                                    className="relative group/help flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-slate-300 bg-white text-[10px] font-bold leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-300 cursor-help"
                                >
                                    ?
                                    <span
                                        role="tooltip"
                                        className="pointer-events-none absolute bottom-full left-1/2 z-[100] mb-2 w-max max-w-[280px] -translate-x-1/2 rounded-lg bg-slate-800 px-3 py-2.5 text-left text-[12px] font-normal leading-relaxed text-white opacity-0 shadow-xl transition-all invisible group-hover/help:visible group-hover/help:opacity-100 group-focus-within/help:visible group-focus-within/help:opacity-100 dark:bg-zinc-700 whitespace-normal break-words"
                                    >
                                        Chọn sticker trực tiếp trên trang. Bấm “Bắt đầu chọn”, rồi chọn các sticker cần xử lý trên cùng một trang; panel này luôn được giữ nguyên.
                                        Khi đã chọn, chỉ các đối tượng được tick mới được bù xén/đường cắt — bỏ tick để xử lý toàn trang.
                                        <span
                                            aria-hidden="true"
                                            className="absolute top-full left-1/2 -mt-1 h-2 w-2 -translate-x-1/2 rotate-45 bg-slate-800 dark:bg-zinc-700"
                                        />
                                    </span>
                                </span>
                            </div>
                            <button
                                type="button"
                                onClick={() => {
                                    const next = !isObjectEditMode;
                                    setIsObjectEditMode(next);
                                    if (next) {
                                        setIsCropMode(false);
                                        setViewerToolMode('pointer');
                                    }
                                }}
                                aria-pressed={isObjectEditMode}
                                className={`h-8 shrink-0 rounded-lg border px-3 text-[11px] font-bold transition-colors ${
                                    isObjectEditMode
                                        ? 'border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700'
                                        : 'border-emerald-500 bg-white text-emerald-700 hover:bg-emerald-50 dark:bg-zinc-950 dark:text-emerald-300'
                                }`}
                            >
                                {isObjectEditMode ? 'Xong chọn' : (objectSelectionContext?.objectIds.length ? 'Chọn lại' : 'Bắt đầu chọn')}
                            </button>
                        </div>
                    </div>

                    {objectSelectionContext?.objectIds.length ? (
                        <label
                            className={`flex items-center gap-2.5 rounded-xl border px-3 py-2 cursor-pointer select-none transition-colors ${
                                useObjectSelection
                                    ? 'border-teal-500 bg-teal-500/10 text-teal-800 dark:text-teal-200'
                                    : 'border-slate-200 bg-slate-50 text-slate-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400'
                            }`}
                        >
                            <input
                                type="checkbox"
                                checked={useObjectSelection}
                                onChange={(event) => setUseObjectSelection(event.target.checked)}
                                className="h-4 w-4 shrink-0 accent-teal-600"
                            />
                            <span className="min-w-0 flex-1 text-[11px] font-bold leading-tight">
                                Chỉ xử lý {objectSelectionContext.objectIds.length} đối tượng đã chọn
                                {' · '}trang {objectSelectionContext.pageIndex + 1}
                            </span>
                            <span
                                role="note"
                                tabIndex={0}
                                aria-label="Giữ nguyên khổ trang và toàn bộ hình/trang trí không được chọn. Bỏ tick để xử lý toàn trang."
                                onClick={(event) => event.preventDefault()}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' || event.key === ' ') {
                                        event.preventDefault();
                                    }
                                }}
                                className="relative group/help flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-current/25 bg-black/5 text-[10px] font-bold leading-none text-current/70 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15 cursor-help"
                            >
                                ?
                                <span
                                    role="tooltip"
                                    className="pointer-events-none absolute bottom-full right-0 z-[100] mb-2 w-max max-w-[280px] rounded-lg bg-slate-800 px-3 py-2.5 text-left text-[12px] font-normal leading-relaxed text-white opacity-0 shadow-xl transition-all invisible group-hover/help:visible group-hover/help:opacity-100 group-focus-within/help:visible group-focus-within/help:opacity-100 dark:bg-zinc-700 whitespace-normal break-words"
                                >
                                    Giữ nguyên khổ trang và toàn bộ hình/trang trí không được chọn. Bỏ tick để xử lý toàn trang.
                                    <span
                                        aria-hidden="true"
                                        className="absolute top-full right-2 -mt-1 h-2 w-2 rotate-45 bg-slate-800 dark:bg-zinc-700"
                                    />
                                </span>
                            </span>
                        </label>
                    ) : null}
                    {/* 1. Đường cắt */}
                    <div>
                        <ToolSectionLabel>{t('preprocess.sticker:1_duong_cat_dieline')}</ToolSectionLabel>
                        <div className="flex flex-col gap-1.5 mb-4 relative z-[60]">
                            <RichSelect
                                value={cutMode}
                                onChange={(v) => setCutMode(v)}
                                options={CUT_MODES_RICH}
                            />
                        </div>
                        
                        {cutMode !== 'none' && (
                            <>
                                <div className="flex gap-2 mt-2 items-end">
                                    <ToolNumberInput
                                        label={t('preprocess.sticker:co_gian_vien')}
                                        value={offsetMm}
                                        onChange={setOffsetMm}
                                        suffix="mm"
                                        step={0.5}
                                        min={-10}
                                        max={10}
                                        className="w-[90px] shrink-0"
                                    />
                                    <label
                                        className={`flex-1 h-[32px] rounded-lg border px-3 flex items-center gap-2 cursor-pointer select-none transition-all ${
                                            cutFirstPageOnly
                                                ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                                                : 'border-slate-300 bg-white hover:border-slate-400 hover:bg-slate-50 text-slate-700 dark:border-zinc-600 dark:bg-zinc-900 dark:hover:border-zinc-500 dark:hover:bg-zinc-800 dark:text-zinc-300'
                                        }`}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={cutFirstPageOnly}
                                            onChange={(event) => setCutFirstPageOnly(event.target.checked)}
                                            className="peer sr-only"
                                        />
                                        <span
                                            aria-hidden="true"
                                            className={`h-[18px] w-[18px] shrink-0 rounded border-2 flex items-center justify-center transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-teal-500 peer-focus-visible:ring-offset-2 dark:peer-focus-visible:ring-offset-zinc-900 ${
                                                cutFirstPageOnly
                                                    ? 'border-teal-600 bg-teal-600 text-white'
                                                    : 'border-slate-400 bg-white dark:border-zinc-500 dark:bg-zinc-950'
                                            }`}
                                        >
                                            {cutFirstPageOnly && (
                                                <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5">
                                                    <path d="M3 8.25 6.5 11.5 13 4.5" strokeLinecap="round" strokeLinejoin="round" />
                                                </svg>
                                            )}
                                        </span>
                                        <span className="min-w-0 flex-1 text-[11px] font-bold leading-tight">
                                            {t('preprocess.sticker:tao_duong_cat_cho_trang_dau_2')}
                                        </span>
                                        <span
                                            role="note"
                                            tabIndex={0}
                                            aria-label={t('preprocess.sticker:file_nhieu_loai_tem_dung_chung_1_khuon')}
                                            onClick={(event) => event.preventDefault()}
                                            onKeyDown={(event) => {
                                                if (event.key === 'Enter' || event.key === ' ') {
                                                    event.preventDefault();
                                                }
                                            }}
                                            className="relative group/help ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-current/25 bg-black/5 text-[10px] font-bold leading-none text-current/70 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15 cursor-help"
                                        >
                                            ?
                                            <span
                                                role="tooltip"
                                                className="pointer-events-none absolute bottom-full right-0 z-[100] mb-2 w-max max-w-[280px] rounded-lg bg-slate-800 px-3 py-2.5 text-left text-[12px] font-normal leading-relaxed text-white opacity-0 shadow-xl transition-all invisible group-hover/help:visible group-hover/help:opacity-100 group-focus-within/help:visible group-focus-within/help:opacity-100 dark:bg-zinc-700 whitespace-normal break-words"
                                            >
                                                {t('preprocess.sticker:file_nhieu_loai_tem_dung_chung_1_khuon')}
                                                <span
                                                    aria-hidden="true"
                                                    className="absolute top-full right-2 -mt-1 h-2 w-2 rotate-45 bg-slate-800 dark:bg-zinc-700"
                                                />
                                            </span>
                                        </span>
                                    </label>
                                </div>
                                <p className="text-[10px] text-slate-400 mt-1">{t('preprocess.sticker:so_am_vd_0_5_ep_duong_cat_lun_vao_trong')}</p>
                                {cutMode !== 'alpha' && <div className="flex gap-1.5 mt-2 mb-4">
                                    {CORNER_STYLES.map(opt => (
                                        <button
                                            key={opt.id}
                                            onClick={() => setCornerStyle(opt.id)}
                                            aria-pressed={cornerStyle === opt.id}
                                            className={`flex-1 h-[32px] rounded border text-[12px] transition-all flex items-center justify-center font-bold ${
                                                cornerStyle === opt.id
                                                    ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                                                    : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'
                                            }`}
                                        >
                                            {tv(opt.label)}
                                        </button>
                                    ))}
                                </div>}
                                {!activeObjectSelection && (
                                    <div className="mt-2 mb-4">
                                        <ToolCheckboxOption
                                            selected={cropToSticker}
                                            onClick={() => setCropToSticker(value => !value)}
                                            label="Crop trang theo tem"
                                            desc="Thu khổ trang sát đường bế và phần bù xén; TrimBox giữ đúng kích thước thật của tem. Bỏ tick để giữ nguyên khổ trang nguồn."
                                        />
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                    {/* 2. Tràn lề */}
                    <div>
                        <ToolSectionLabel>{t('preprocess.sticker:2_tran_le_dac_ruot')}</ToolSectionLabel>
                        <div className="flex gap-2 mb-4 items-end">
                            <ToolNumberInput
                                label={cutMode === 'original' || cutMode === 'alpha'
                                    ? t('preprocess.sticker:bu_xen_ngoai_duong_cat')
                                    : t('preprocess.sticker:tran_mau')}
                                value={bleedMm}
                                onChange={setBleedMm}
                                suffix="mm"
                                step={0.5}
                                min={0}
                                max={10}
                                className="w-[145px] shrink-0"
                            />
                            <div className="flex gap-1.5 flex-1">
                                <button
                                    onClick={() => setFillHoles(!fillHoles)}
                                    aria-pressed={fillHoles}
                                    title={t('preprocess.sticker:bo_qua_cac_lo_rong_ben_trong_khoi_hinh')}
                                    className={`flex-1 h-[32px] rounded border text-[11px] transition-all flex items-center justify-center font-bold px-1 whitespace-nowrap overflow-hidden ${
                                        fillHoles
                                            ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                                            : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'
                                    }`}
                                >
                                    {fillHoles ? t('preprocess.sticker:dac_ruot') : t('preprocess.sticker:dac_ruot_2')}
                                </button>
                                {cutMode !== 'alpha' && (
                                <button
                                    onClick={() => setRemoveWhiteBg(!removeWhiteBg)}
                                    aria-pressed={removeWhiteBg}
                                    title={t('preprocess.sticker:chi_do_vien_cua_chi_tiet_bo_qua_mang')}
                                    className={`flex-1 h-[32px] rounded border text-[11px] transition-all flex items-center justify-center font-bold px-1 whitespace-nowrap overflow-hidden ${
                                        removeWhiteBg
                                            ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                                            : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'
                                    }`}
                                >
                                    {removeWhiteBg ? t('preprocess.sticker:bo_nen_trang') : t('preprocess.sticker:bo_nen_trang_2')}
                                </button>
                                )}
                            </div>
                        </div>

                        {(cutMode === 'original' || cutMode === 'alpha') && bleedMm > 0 && (
                            <div
                                role="note"
                                data-testid="sticker-bleed-geometry-summary"
                                className="-mt-2 mb-4 rounded-lg border border-sky-200 bg-sky-50 px-2.5 py-2 text-[10px] leading-relaxed text-sky-800 dark:border-sky-800/60 dark:bg-sky-950/30 dark:text-sky-200"
                            >
                                ℹ️ {t('preprocess.sticker:tom_tat_hinh_hoc_bu_xen', {
                                    cut: formatSignedMm(bleedGeometry.cutOffsetMm ?? 0),
                                    outer: formatSignedMm(bleedGeometry.outerOffsetMm),
                                    bleed: Number((bleedGeometry.bleedOutsideCutMm ?? 0).toFixed(2)),
                                })}
                            </div>
                        )}
                        
                        {(cutMode === 'bleed' || cutMode === 'none' || bleedMm > 0) && (
                            <div className="mt-6 p-3 bg-slate-50 dark:bg-zinc-800/50 rounded-xl border border-slate-200 dark:border-zinc-700/50">
                                <label className="block text-xs font-bold text-slate-700 dark:text-zinc-300 mb-2">{t('preprocess.sticker:mau_nen_bu_xen')}</label>
                                <div className="flex flex-col gap-1.5 mb-2 relative z-[50]">
                                    <RichSelect
                                        value={bleedColorType}
                                        onChange={handleBleedColorTypeChange}
                                        options={BLEED_COLOR_MODES_STICKER}
                                    />
                                </div>
                                {bleedColorType === 'solid' && (
                                    <div className="mt-2 flex flex-col gap-2 bg-white dark:bg-zinc-800 p-3 rounded-lg border border-slate-200 dark:border-zinc-700">
                                        <div className="grid grid-cols-4 gap-2">
                                            {['C', 'M', 'Y', 'K'].map((ch, idx) => {
                                                const val = bleedColorHex.split(',').length === 4 ? bleedColorHex.split(',')[idx] : (ch === 'K' ? '0' : '0');
                                                return (
                                                    <div key={ch} className="flex flex-col gap-1">
                                                        <label className="text-[10px] font-bold text-center text-slate-700 dark:text-zinc-300">{ch}</label>
                                                        <input 
                                                            type="number" min="0" max="100" 
                                                            value={val}
                                                            onChange={(e) => {
                                                                const v = Math.min(100, Math.max(0, parseInt(e.target.value) || 0));
                                                                const current = bleedColorHex.split(',').length === 4 ? bleedColorHex.split(',') : ['0','0','0','0'];
                                                                current[idx] = String(v);
                                                                setBleedColorHex(current.join(','));
                                                            }}
                                                            className="w-full text-center text-xs h-8 border border-slate-200 dark:border-zinc-600 rounded bg-slate-50 dark:bg-zinc-900"
                                                        />
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* --- TAB 2: XÉN VUÔNG GÓC --- */}
            {productType === 'rectangle' && (
                <div className="animate-in slide-in-from-right-4 fade-in duration-300 space-y-4">
                    <div>
                        <div className="flex items-end gap-3 mb-4">
                            <ToolNumberInput
                                label={t('preprocess.sticker:do_day_bleed')}
                                value={bleedMm}
                                onChange={setBleedMm}
                                suffix="mm"
                                step={0.5}
                                min={0}
                                max={10}
                                className="flex-1 min-w-0"
                            />
                            {(bleedColorType === 'image' || bleedColorType === 'trajectory' || bleedColorType === 'inpaint') && (
                                <ToolNumberInput
                                    label={t('preprocess.sticker:do_lem_mep')}
                                    value={edgeBiteMm}
                                    onChange={setEdgeBiteMm}
                                    suffix="mm"
                                    step={0.1}
                                    min={0}
                                    max={5}
                                    className="flex-1 min-w-0"
                                />
                            )}
                        </div>

                        {/* Cạnh bù xén: bài đã có sẵn lề một phía (tem cắt cuộn, mép dán
                            hộp, gáy sách) thì bù thêm cạnh đó là lệch khổ thành phẩm.
                            Chỉ hiện khi thực sự có bù xén để không làm rối panel. */}
                        {bleedMm > 0 && (
                            <div className="mb-4 p-3 bg-slate-50 dark:bg-zinc-800/50 rounded-xl border border-slate-200 dark:border-zinc-700/50">
                                <div className="flex items-center justify-between gap-2 mb-1">
                                    <label className="text-xs font-bold text-slate-700 dark:text-zinc-300">{t('preprocess.sticker:canh_bu_xen')}</label>
                                    <button
                                        type="button"
                                        onClick={() => setBleedSides({ ...ALL_BLEED_SIDES })}
                                        disabled={activeBleedSideCount === 4}
                                        className="text-[10.5px] font-bold text-teal-600 dark:text-teal-400 hover:underline disabled:opacity-40 disabled:no-underline disabled:cursor-default"
                                    >
                                        {t('preprocess.sticker:canh_bu_xen_ca_4')}
                                    </button>
                                </div>
                                <p className="text-[10.5px] text-slate-500 dark:text-zinc-400 leading-snug mb-2.5">
                                    {t('preprocess.sticker:canh_bu_xen_mo_ta')}
                                </p>
                                <div className="grid grid-cols-3 gap-1.5 w-full max-w-[250px] mx-auto">
                                    <span />
                                    <BleedSideToggle
                                        active={bleedSides.top}
                                        label={t('preprocess.sticker:canh_tren')}
                                        arrow="↑"
                                        lockHint={activeBleedSideCount === 1 && bleedSides.top ? t('preprocess.sticker:canh_bu_xen_giu_it_nhat_mot') : undefined}
                                        onToggle={() => toggleBleedSide('top')}
                                    />
                                    <span />
                                    <BleedSideToggle
                                        active={bleedSides.left}
                                        label={t('preprocess.sticker:canh_trai')}
                                        arrow="←"
                                        lockHint={activeBleedSideCount === 1 && bleedSides.left ? t('preprocess.sticker:canh_bu_xen_giu_it_nhat_mot') : undefined}
                                        onToggle={() => toggleBleedSide('left')}
                                    />
                                    <div className="h-9 rounded-lg bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 flex flex-col items-center justify-center leading-none">
                                        <span className="text-[12px] font-bold text-slate-700 dark:text-zinc-200">{bleedMm} mm</span>
                                        <span className="text-[9.5px] text-slate-400 dark:text-zinc-500">{activeBleedSideCount}/4</span>
                                    </div>
                                    <BleedSideToggle
                                        active={bleedSides.right}
                                        label={t('preprocess.sticker:canh_phai')}
                                        arrow="→"
                                        lockHint={activeBleedSideCount === 1 && bleedSides.right ? t('preprocess.sticker:canh_bu_xen_giu_it_nhat_mot') : undefined}
                                        onToggle={() => toggleBleedSide('right')}
                                    />
                                    <span />
                                    <BleedSideToggle
                                        active={bleedSides.bottom}
                                        label={t('preprocess.sticker:canh_duoi')}
                                        arrow="↓"
                                        lockHint={activeBleedSideCount === 1 && bleedSides.bottom ? t('preprocess.sticker:canh_bu_xen_giu_it_nhat_mot') : undefined}
                                        onToggle={() => toggleBleedSide('bottom')}
                                    />
                                    <span />
                                </div>
                            </div>
                        )}

                        <div className="p-3 bg-slate-50 dark:bg-zinc-800/50 rounded-xl border border-slate-200 dark:border-zinc-700/50">
                            <label className="block text-xs font-bold text-slate-700 dark:text-zinc-300 mb-2">{t('preprocess.sticker:mau_nen_bu_xen')}</label>
                            <div className="flex flex-col gap-1.5 mb-2 relative z-[50]">
                                <RichSelect
                                    value={bleedColorType}
                                    onChange={handleBleedColorTypeChange}
                                    options={BLEED_COLOR_MODES_RECTANGLE}
                                />
                            </div>

                            {bleedColorType === 'mirror' && (
                                <div className="flex items-start gap-2 mb-2 px-2.5 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40">
                                    <span className="text-amber-500 text-sm leading-none mt-0.5">⚠️</span>
                                    <p className="text-[10.5px] text-amber-700 dark:text-amber-300 leading-snug">
                                        {t('preprocess.sticker:lat_guong')} <strong>{t('preprocess.sticker:soi_nguoc_noi_dung_sat_mep')}</strong> {t('preprocess.sticker:ra_vung_bu_xen_vd_chu_n_m')} <strong>{t('preprocess.sticker:sai_noi_dung')}</strong>{t('preprocess.sticker:chi_nen_dung_cho_nen_truu_tuong_hoa_van')} <strong>{t('preprocess.sticker:keo_gian_mep_anh_quoted')}</strong>.
                                    </p>
                                </div>
                            )}
                            
                            {bleedColorType === 'solid' && (
                                <div className="mt-3 flex flex-col gap-2 bg-white dark:bg-zinc-800 p-3 rounded-lg border border-slate-200 dark:border-zinc-700">
                                    <div className="grid grid-cols-4 gap-2">
                                        {['C', 'M', 'Y', 'K'].map((ch, idx) => {
                                            const val = bleedColorHex.split(',').length === 4 ? bleedColorHex.split(',')[idx] : (ch === 'K' ? '0' : '0');
                                            return (
                                                <div key={ch} className="flex flex-col gap-1">
                                                    <label className="text-[10px] font-bold text-center text-slate-700 dark:text-zinc-300">{ch}</label>
                                                    <input 
                                                        type="number" min="0" max="100" 
                                                        value={val}
                                                        onChange={(e) => {
                                                            const v = Math.min(100, Math.max(0, parseInt(e.target.value) || 0));
                                                            const current = bleedColorHex.split(',').length === 4 ? bleedColorHex.split(',') : ['0','0','0','0'];
                                                            current[idx] = String(v);
                                                            setBleedColorHex(current.join(','));
                                                        }}
                                                        className="w-full text-center text-xs h-8 border border-slate-200 dark:border-zinc-600 rounded bg-slate-50 dark:bg-zinc-900"
                                                    />
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>

                    </div>
                </div>
            )}
            {/* Execute */}
            {!isSuccess ? (
                <button
                    onClick={() => { void handleRun(); }}
                    disabled={isProcessing || !pdfFile}
                    className={`w-full h-12 rounded-xl text-[14px] font-bold transition-all mt-2 flex items-center justify-center gap-2 ${
                        isProcessing || !pdfFile
                            ? 'bg-slate-300 dark:bg-zinc-700 text-slate-500 cursor-not-allowed'
                            : 'bg-indigo-600 hover:bg-indigo-700 text-white'
                    }`}
                >
                    {t('preprocess.common:run')}{isProcessing ? '…' : ''}
                </button>
            ) : (
                <div className="mt-4 bg-white dark:bg-zinc-800 p-4 rounded-xl shadow-sm border border-emerald-200 dark:border-emerald-800/50 animate-in fade-in slide-in-from-bottom-2 duration-300">
                    <div className="flex items-center gap-2 mb-4">
                        <div className="w-8 h-8 bg-emerald-100 dark:bg-emerald-900/50 rounded-full flex items-center justify-center shrink-0">
                            <span className="text-sm">✅</span>
                        </div>
                        <div className="flex flex-col">
                            <h3 className="text-[13px] font-bold text-emerald-700 dark:text-emerald-400">{t('preprocess.sticker:da_tao_bu_xen_thanh_cong')}</h3>
                            <p className="text-[10px] text-slate-500 leading-tight">{t('preprocess.sticker:buoc_tiep_theo_chon_kieu_dan_trang')}</p>
                        </div>
                    </div>
                    {/* Van an toàn: hiện tên hình cắt máy đã tự nhận + 1 toggle lật về giữ mép
                        ảnh khi nhận sai — thay cho dropdown shape_mode đã ẩn. Chỉ tab bế tem. */}
                    {productType === 'sticker' && cutMode !== 'none' && detectedCutKind && (
                        <div className="mb-3 flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg bg-slate-50 dark:bg-zinc-800/60 border border-slate-200 dark:border-zinc-700/50">
                            <span className="text-[11px] text-slate-600 dark:text-zinc-300">
                                {t('preprocess.sticker:duong_cat_da_nhan')}{' '}
                                <strong>{t(`preprocess.sticker:cut_kind_${detectedCutKind}`)}</strong>
                            </span>
                            {!forceContour && detectedCutKind !== 'contour' && (
                                <button
                                    onClick={() => {
                                        setCornerStyle('preserve');
                                        setForceContour(true);
                                        void handleRun({ cornerStyle: 'preserve', forceContour: true });
                                    }}
                                    className="text-[10.5px] font-bold text-amber-600 dark:text-amber-400 hover:underline shrink-0"
                                >
                                    {t('preprocess.sticker:hinh_cat_sai_giu_mep_anh')}
                                </button>
                            )}
                            {forceContour && (
                                <span className="text-[10.5px] font-bold text-teal-600 dark:text-teal-400 shrink-0">
                                    {t('preprocess.sticker:dang_giu_mep_anh')}
                                </span>
                            )}
                        </div>
                    )}
                    <div className="flex flex-col gap-2">
                        {/* Rule in ấn: Xén vuông góc = cắt thẳng → bình guillotine (Booklet/N-Up).
                            Bế tem nhãn = có đường bế contour → Bình Bế Tem.
                            Route theo productType (KHÔNG theo cutMode vì cutMode dùng chung 2 tab). */}
                        {productType === 'rectangle' && (
                            <>
                                <ToolItem 
                                    icon="📚" label={t('preprocess.sticker:binh_sach_tap_chi')} desc={t('preprocess.sticker:khau_chi_long_doi_bu_gay')}
                                    onClick={() => { setActiveDashboardTool('booklet'); setTaskMode('booklet'); }} 
                                    hoverColor="hover:border-emerald-400 dark:hover:border-emerald-500" 
                                />
                                <ToolItem 
                                    icon="🎴" label={t('preprocess.sticker:binh_bai_xen_n_up')} desc={t('preprocess.sticker:n_up_nhan_ban_s_r')}
                                    onClick={() => { setActiveDashboardTool('nup'); setTaskMode('nup'); }} 
                                    hoverColor="hover:border-rose-400 dark:hover:border-rose-500" 
                                />
                            </>
                        )}
                        {productType === 'sticker' && (
                            <ToolItem 
                                icon="✂️" label={t('preprocess.sticker:binh_bai_be_tem')} desc={t('preprocess.sticker:xep_tem_be_to_ong')}
                                onClick={() => { setActiveDashboardTool('sticker_imposer'); setTaskMode('sticker_imposer'); }} 
                                hoverColor="hover:border-pink-400 dark:hover:border-pink-500" 
                            />
                        )}
                    </div>
                    <button
                        onClick={() => setIsSuccess(false)}
                        className="mt-4 w-full text-xs font-bold text-slate-400 hover:text-slate-600 dark:hover:text-zinc-300 py-1 transition-colors"
                    >
                        {t('preprocess.sticker:quay_lai_chinh_sua_bu_xen')}
                    </button>
                </div>
            )}

            {/* Warning (nghiệp vụ, không phải lỗi chặn) */}
            {warning && (
                <div className="bg-amber-50 dark:bg-amber-900/20 p-3 rounded-lg border border-amber-200 dark:border-amber-800/50 mt-2">
                    <span className="text-[12px] text-amber-700 dark:text-amber-300 font-medium">⚠️ {warning}</span>
                </div>
            )}

            {/* Error */}
            {error && (
                <div className="bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-200 dark:border-red-800/50 mt-2">
                    <span className="text-[12px] text-red-600 dark:text-red-400 font-medium">❌ {error}</span>
                </div>
            )}
        </div>
    );
}
