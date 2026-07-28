// UIUX (audit 2026-07-27 §M-1+C-05): Thanh trạng thái đáy viewer — [Trang n/tổng] ·
// [W × H đơn vị] · [Zoom %] · [đơn vị ▾] (+ toạ độ chuột X/Y gốc mép trang, §C-03).
// Dùng lại plumbing sẵn có: hoveredPdfPosition (LivePageFrame bắn ratio 0-1 theo mép
// trang vào useWorkspaceStore) + measurementUnit từ useAppSettingsStore.
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { useAppSettingsStore } from '../../stores/appSettingsStore';

// px@96 → mm, đồng bộ badge hover cũ trong AcrobatViewer (d.w * 25.4/96).
const PX_TO_MM = 25.4 / 96;
// UIUX (audit 2026-07-27 §M-1) fix-verify: kích thước trang nhận theo POINT từ
// activePagePhysical (đã map pageOrder + hoán w/h khi xoay) → pt → mm.
const PT_TO_MM = 25.4 / 72;

type Unit = 'mm' | 'cm' | 'inch';
const UNIT_ORDER: Unit[] = ['mm', 'cm', 'inch'];

// mm → chuỗi theo đơn vị chọn: mm 1 số lẻ, cm 2, inch 2.
const formatByUnit = (mm: number, unit: Unit): string => {
    if (unit === 'cm') return (mm / 10).toFixed(2);
    if (unit === 'inch') return (mm / 25.4).toFixed(2);
    return mm.toFixed(1);
};

interface StatusBarProps {
    activePage: number;
    totalPages: number;
    zoom: number;
    /** UIUX (audit 2026-07-27 §M-1) fix-verify: kích thước trang đang xem (POINT) từ
     *  activePagePhysical của AcrobatViewer — đã map qua pageOrder (đảo thứ tự trang)
     *  và hoán w/h khi xoay 90/270. KHÔNG tra allPageDims[activePage] (key = số trang GỐC). */
    widthPt: number;
    heightPt: number;
    /** Fallback kích thước (px@96) cho cụm toạ độ hover X/Y (key theo số trang gốc — đúng
     *  vì hovered.pageNum là originalPageNum). */
    pageDim: { w: number; h: number } | null;
    allPageDims: Record<number, { w: number; h: number; widthPt?: number }>;
}

export function StatusBar({ activePage, totalPages, zoom, widthPt, heightPt, pageDim, allPageDims }: StatusBarProps) {
    const { t } = useTranslation();
    const { measurementUnit, setMeasurementUnit } = useAppSettingsStore();
    // Toạ độ chuột trên trang (ratio 0-1, gốc = mép trang hiện hành — cùng gốc thước).
    const hovered = useWorkspaceStore(s => s.hoveredPdfPosition);

    const cycleUnit = useCallback(() => {
        const next = UNIT_ORDER[(UNIT_ORDER.indexOf(measurementUnit) + 1) % UNIT_ORDER.length];
        setMeasurementUnit(next);
    }, [measurementUnit, setMeasurementUnit]);

    // UIUX (audit 2026-07-27 §M-1) fix-verify: kích thước hiển thị dùng widthPt/heightPt
    // (activePagePhysical) — không tra allPageDims[activePage] như badge hover cũ nữa.
    const hoverDim = hovered ? (allPageDims[hovered.pageNum] || pageDim) : null;
    const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

    return (
        <div className="h-6 w-full shrink-0 flex items-center gap-1.5 px-3 bg-app-2 border-t border-app-line text-app-text-2 text-[11px] select-none">
            <span className="whitespace-nowrap">
                {t('misc.acrobatViewer:status_trang', 'Trang')}{' '}
                <span className="num">{activePage}</span>/<span className="num">{totalPages}</span>
            </span>
            {widthPt > 0 && heightPt > 0 && (
                <>
                    <span className="text-app-text-3">·</span>
                    <span className="num whitespace-nowrap">
                        {formatByUnit(widthPt * PT_TO_MM, measurementUnit)} × {formatByUnit(heightPt * PT_TO_MM, measurementUnit)} {measurementUnit}
                    </span>
                </>
            )}
            <span className="text-app-text-3">·</span>
            <span className="whitespace-nowrap">
                {t('misc.acrobatViewer:status_zoom', 'Zoom')} <span className="num">{Math.round(zoom * 100)}%</span>
            </span>
            <span className="text-app-text-3">·</span>
            <button
                type="button"
                className="px-1 h-5 rounded-app-sm hover:text-app-accent hover:bg-app-accent-soft transition-colors"
                onClick={cycleUnit}
                title={t('misc.acrobatViewer:status_doi_don_vi', 'Đổi đơn vị đo (mm → cm → inch)')}
                aria-label={t('misc.acrobatViewer:status_doi_don_vi', 'Đổi đơn vị đo (mm → cm → inch)')}
            >
                {measurementUnit} ▾
            </button>
            {hovered && hoverDim && (
                <span className="ml-auto num whitespace-nowrap" title={t('misc.acrobatViewer:status_toa_do_chuot', 'Tọa độ chuột — gốc là mép trang hiện hành')}>
                    X: {formatByUnit(clamp01(hovered.x) * hoverDim.w * PX_TO_MM, measurementUnit)}{' '}
                    Y: {formatByUnit(clamp01(hovered.y) * hoverDim.h * PX_TO_MM, measurementUnit)} {measurementUnit}
                </span>
            )}
        </div>
    );
}
