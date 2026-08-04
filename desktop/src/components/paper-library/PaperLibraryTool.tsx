// ============================================================
// Thư viện vật tư in — công cụ tra cứu vật tư cho nhà in
//
// Điều hướng bằng SIDEBAR bên trái, 4 mục theo 4 sheet của workbook:
//   📄 Định lượng giấy  ← mục CHA, xổ ra 9 họ giấy (click họ nào hiện họ đó)
//   📕 Độ dày gáy sách
//   🎞 Màng cán
//   🧵 May chỉ
//
// Dữ liệu và công thức lấy từ workbook của xưởng, xem
// desktop/src/lib/paperLibrary/.
// ============================================================

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
    BINDING_AVAILABILITY,
    BINDING_LABELS,
    calcSpineThickness,
    LAMINATION_FILMS,
    LAMINATION_LABELS,
    lookupThickness,
    PAPER_FAMILY_LABELS,
    PAPER_STOCKS,
    stackThicknessMm,
    THREAD_SEWING_LIMITS,
    type BindingMethod,
    type LaminationSide,
    type PaperFamily,
} from '../../lib/paperLibrary';
import { NavItem, NavSubItem, NumberField, ResultTile, SectionLabel, SelectField } from './parts';
import { FAMILY_COUNTS, FAMILY_ORDER, FilmTable, fmt, fmtFull, PaperStockTable, ThreadSewingTable } from './tables';
import { FAMILY_TONES } from './familyColors';
import { canUse } from '../../lib/license/features';
import { useAuthStore } from '../../stores/useAuthStore';
import FeatureAccessOverlay from '../license/FeatureAccessOverlay';

type Section = 'stock' | 'spine' | 'film' | 'thread';

// ─────────────────────────────────────────────────────────────
// Thẻ tính độ dày gáy sách
// ─────────────────────────────────────────────────────────────

function SpineCalculator() {
    const { t, i18n } = useTranslation();
    const lang = i18n.language;

    const [family, setFamily] = useState<PaperFamily>('couche');
    const [stockId, setStockId] = useState('couche-100');
    const [totalPages, setTotalPages] = useState(26);
    const [binding, setBinding] = useState<BindingMethod>('thread');
    const [lamination, setLamination] = useState<LaminationSide>('none');

    // Giấy trong họ đang chọn — đổi họ thì tự nhảy về tờ đầu danh sách
    const stocksInFamily = useMemo(
        () => PAPER_STOCKS.filter(s => s.family === family).sort((a, b) => a.gsm - b.gsm),
        [family],
    );
    const stock = stocksInFamily.find(s => s.id === stockId) ?? stocksInFamily[0];

    const handleFamily = (f: PaperFamily) => {
        setFamily(f);
        const first = PAPER_STOCKS.filter(s => s.family === f).sort((a, b) => a.gsm - b.gsm)[0];
        if (first) setStockId(first.id);
        // Kiểu đóng đang chọn có thể không dùng cho họ giấy mới → về kiểu đầu tiên hợp lệ
        const allowed = BINDING_AVAILABILITY[f];
        if (allowed.length > 0 && !allowed.includes(binding)) setBinding(allowed[0]);
    };

    const allowedBindings = BINDING_AVAILABILITY[family];
    const bindingUnsupported = allowedBindings.length > 0 && !allowedBindings.includes(binding);
    const familyHasNoData = allowedBindings.length === 0;

    // Tra sẵn độ dày đo thực — truyền cho calcSpineThickness (bấm ghim dùng số này)
    const measuredLookup = useMemo(() => {
        if (!stock) return null;
        return lookupThickness(family, stock.gsm, stock.coating);
    }, [family, stock]);

    const result = stock
        ? calcSpineThickness({
            family, gsm: stock.gsm, totalPages, binding, lamination,
            measuredPerSheetMm: measuredLookup?.thicknessMm,
        })
        : null;

    // Đường thứ hai: nhân độ dày ĐO THỰC với số tờ. Lệch với công thức xưởng
    // (xem chú thích trong spine.ts) — hiện cả hai để thợ tự đối chiếu.
    const measured = useMemo(() => {
        if (!stock) return null;
        const look = lookupThickness(family, stock.gsm, stock.coating);
        if (!look) return null;
        const sheets = Math.ceil(totalPages / 2);
        return {
            perSheetMm: look.thicknessMm,
            totalMm: stackThicknessMm(sheets, look.thicknessMm),
        };
    }, [family, stock, totalPages]);

    return (
        <div className="flex-1 min-h-0 overflow-auto">
            <div className="p-3 grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
                {/* Cột nhập tham số */}
                <div className="rounded-app-md border border-app-line bg-app-2 p-3 space-y-3">
                    <SelectField
                        id="sp-family"
                        label={t('paperLibrary:ho_giay')}
                        value={family}
                        onChange={handleFamily}
                        options={FAMILY_ORDER.map(f => ({
                            value: f,
                            label: PAPER_FAMILY_LABELS[f],
                        }))}
                    />

                    <SelectField
                        id="sp-stock"
                        label={t('paperLibrary:loai_giay_ruot')}
                        value={stock?.id ?? ''}
                        onChange={setStockId}
                        options={stocksInFamily.map(s => ({ value: s.id, label: s.name }))}
                    />

                    <NumberField
                        id="sp-pages"
                        label={t('paperLibrary:tong_so_trang_ruot')}
                        value={totalPages}
                        onChange={v => setTotalPages(Math.max(2, Math.round(v)))}
                        min={2}
                        step={2}
                        suffix={t('paperLibrary:trang')}
                    />

                    <SelectField
                        id="sp-binding"
                        label={t('paperLibrary:kieu_dong')}
                        value={binding}
                        onChange={setBinding}
                        options={(Object.keys(BINDING_LABELS) as BindingMethod[]).map(b => ({
                            value: b,
                            label: BINDING_LABELS[b],
                        }))}
                    />

                    <SelectField
                        id="sp-lam"
                        label={t('paperLibrary:can_mang_bia')}
                        value={lamination}
                        onChange={setLamination}
                        options={(Object.keys(LAMINATION_LABELS) as LaminationSide[]).map(l => ({
                            value: l,
                            label: LAMINATION_LABELS[l],
                        }))}
                    />
                </div>

                {/* Cột kết quả */}
                <div className="space-y-3">
                    {familyHasNoData && (
                        <p className="px-3 py-2 text-xs font-medium rounded-app-md bg-app-2 border border-app-line text-app-warning leading-snug">
                            {t('paperLibrary:canh_bao_ho_giay_khong_co_so')}
                        </p>
                    )}
                    {!familyHasNoData && bindingUnsupported && (
                        <p className="px-3 py-2 text-xs font-medium rounded-app-md bg-app-2 border border-app-line text-app-warning leading-snug">
                            {t('paperLibrary:canh_bao_kieu_dong_khong_dung', {
                                bindings: allowedBindings.map(b => BINDING_LABELS[b]).join(', '),
                            })}
                        </p>
                    )}

                    {result && (
                        <>
                            <div className="grid gap-2 sm:grid-cols-2">
                                <ResultTile
                                    label={result.hasSpine
                                        ? t('paperLibrary:do_day_gay')
                                        : t('paperLibrary:do_day_cuon')}
                                    value={fmtFull(result.spineMm, 3, lang)}
                                    unit="mm"
                                    tone={result.thinWarning || result.thickWarning ? 'warning' : 'accent'}
                                />
                                <ResultTile
                                    label={t('paperLibrary:so_to_ruot')}
                                    value={String(result.sheetCount)}
                                    unit={t('paperLibrary:to')}
                                />
                            </div>

                            {result.thinWarning && (
                                <p className="px-3 py-2 text-xs font-medium rounded-app-md bg-app-2 border border-app-line text-app-warning leading-snug">
                                    {t('paperLibrary:canh_bao_gay_mong', { min: result.thinWarning.minMm })}
                                </p>
                            )}

                            {result.thickWarning && (
                                <p className="px-3 py-2 text-xs font-medium rounded-app-md bg-app-2 border border-app-line text-app-warning leading-snug">
                                    {t('paperLibrary:canh_bao_cuon_day', { max: result.thickWarning.maxMm })}
                                </p>
                            )}


                            {measured && (
                                <div className="px-3 py-2.5 rounded-app-md bg-app-2 border border-app-line">
                                    <SectionLabel>{t('paperLibrary:doi_chieu_do_thuc')}</SectionLabel>
                                    <div className="grid gap-2 sm:grid-cols-2 mb-2">
                                        <ResultTile
                                            label={t('paperLibrary:do_day_mot_to_do')}
                                            value={fmt(measured.perSheetMm, 3, lang)}
                                            unit="mm"
                                        />
                                        <ResultTile
                                            label={t('paperLibrary:chong_giay_do')}
                                            value={fmtFull(measured.totalMm, 3, lang)}
                                            unit="mm"
                                        />
                                    </div>
                                    <p className="text-xs text-app-text-2 leading-snug">
                                        {t('paperLibrary:giai_thich_hai_duong')}
                                    </p>
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

// ─────────────────────────────────────────────────────────────
// Shell công cụ + sidebar
// ─────────────────────────────────────────────────────────────

export default function PaperLibraryTool({
    isActive,
    onRequestHome,
}: { tabId?: string; isActive?: boolean; onRequestHome?: () => void } = {}) {
    const { t } = useTranslation();
    const [section, setSection] = useState<Section>('stock');
    const [family, setFamily] = useState<PaperFamily | 'all'>('all');
    const [stockOpen, setStockOpen] = useState(true);
    const licensePlan = useAuthStore(state => state.licensePlan);
    const licenseFeatures = useAuthStore(state => state.licenseFeatures);
    const accessLocked = !canUse('prepress.paper_library', licensePlan, licenseFeatures);

    const onBackground = isActive === false;

    const heading = useMemo(() => {
        switch (section) {
            case 'stock':
                return family === 'all'
                    ? t('paperLibrary:tab_dinh_luong')
                    : `${t('paperLibrary:tab_dinh_luong')} — ${PAPER_FAMILY_LABELS[family]}`;
            case 'spine':
                return t('paperLibrary:tab_gay_sach');
            case 'film':
                return t('paperLibrary:tab_mang_can');
            case 'thread':
                return t('paperLibrary:tab_may_chi');
        }
    }, [section, family, t]);

    return (
        <div className="relative flex h-full min-h-0 bg-app-1">
            {/* ── Sidebar điều hướng ── */}
            <nav
                aria-label={t('paperLibrary:dieu_huong')}
                className="w-56 shrink-0 flex flex-col border-r border-app-line bg-app-2 overflow-y-auto"
            >
                <div className="px-3 pt-3 pb-2">
                    <h1 className="text-sm font-bold text-app-text-1">{t('paperLibrary:tieu_de')}</h1>
                    <p className="text-[11px] text-app-text-2 mt-0.5 leading-snug">
                        {t('paperLibrary:mo_ta_ngan')}
                    </p>
                </div>

                <div className="px-2 pb-3 space-y-0.5">
                    {/* Mục cha: định lượng giấy */}
                    <NavItem
                        label={t('paperLibrary:tab_dinh_luong')}
                        icon="📄"
                        count={PAPER_STOCKS.length}
                        active={section === 'stock'}
                        expandable
                        expanded={stockOpen}
                        ariaControls="pl-family-list"
                        onClick={() => {
                            // Bấm mục cha: mở/đóng danh sách họ giấy VÀ về bảng tất cả
                            setSection('stock');
                            setStockOpen(o => (section === 'stock' ? !o : true));
                        }}
                    />

                    {stockOpen && (
                        <div id="pl-family-list" className="space-y-0.5 mt-0.5 mb-1">
                            <NavSubItem
                                label={t('paperLibrary:tat_ca_ho_giay')}
                                count={PAPER_STOCKS.length}
                                active={section === 'stock' && family === 'all'}
                                onClick={() => {
                                    setSection('stock');
                                    setFamily('all');
                                }}
                            />
                            {FAMILY_ORDER.map(f => (
                                <NavSubItem
                                    key={f}
                                    label={PAPER_FAMILY_LABELS[f]}
                                    count={FAMILY_COUNTS[f]}
                                    active={section === 'stock' && family === f}
                                    dotClass={FAMILY_TONES[f].dot}
                                    barClass={FAMILY_TONES[f].bar}
                                    onClick={() => {
                                        setSection('stock');
                                        setFamily(f);
                                    }}
                                />
                            ))}
                        </div>
                    )}

                    <NavItem
                        label={t('paperLibrary:tab_gay_sach')}
                        icon="📕"
                        active={section === 'spine'}
                        onClick={() => setSection('spine')}
                    />
                    <NavItem
                        label={t('paperLibrary:tab_mang_can')}
                        icon="🎞"
                        count={LAMINATION_FILMS.length}
                        active={section === 'film'}
                        onClick={() => setSection('film')}
                    />
                    <NavItem
                        label={t('paperLibrary:tab_may_chi')}
                        icon="🧵"
                        count={THREAD_SEWING_LIMITS.length}
                        active={section === 'thread'}
                        onClick={() => setSection('thread')}
                    />
                </div>
            </nav>

            {/* ── Vùng nội dung ── */}
            <div className="flex-1 min-w-0 flex flex-col min-h-0">
                <header className="px-3 py-2 border-b border-app-line">
                    <h2 className="text-sm font-bold text-app-text-1">{heading}</h2>
                </header>

                {/*
                  [PAPER-LIB FIX 2026-07-30] Bất đối xứng CÓ CHỦ ĐÍCH:

                  · 3 bảng CHỈ-ĐỌC gỡ khỏi cây khi tab ở nền — dựng lại tức thì
                    từ hằng số nên không mất gì, mà tránh giữ 208 hàng DOM vô ích
                    (mọi tab của app luôn mounted, xem bất biến điều hướng).

                  · Thẻ gáy sách thì GIỮ MOUNTED, chỉ ẩn bằng CSS. Bản đầu tôi gỡ
                    cả nó theo isActive → thợ nhập 240 trang, sang tab khác tra
                    file, quay lại thì số reset về 26. Tham số người dùng nhập
                    không được phép mất vì lý do tối ưu DOM.
                */}
                <div className="flex-1 min-h-0 flex flex-col">
                    {!onBackground && section === 'stock' && <PaperStockTable family={family} />}
                    {!onBackground && section === 'film' && <FilmTable />}
                    {!onBackground && section === 'thread' && <ThreadSewingTable />}

                    <div
                        className={section === 'spine' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}
                        aria-hidden={section !== 'spine'}
                    >
                        <SpineCalculator />
                    </div>
                </div>
            </div>
            {/* SEC/UIUX (audit 2026-08-04 §UI.03/§BE.02): capability client-only
                tự re-check; không unmount calculator để giữ số trang/kiểu đóng. */}
            {isActive !== false && accessLocked && (
                <FeatureAccessOverlay featureId="prepress.paper_library" onLeave={onRequestHome} />
            )}
        </div>
    );
}
