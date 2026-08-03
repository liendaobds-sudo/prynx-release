// ============================================================
// ParamPanel — Bảng nhập thông số hộp
// Sliders + numeric inputs với debounce 150ms
// ============================================================

import React from 'react';
import { useBoxStore } from '../../stores/useBoxStore';
import { BoxParams } from '../../lib/dieline/types';
// [VARIANT 2026-07-29] Lớp biến thể: quyết định tham số nào bị CHỐT (ẩn khỏi form)
import {
    BOX_GROUPS,
    BOX_VARIANTS,
    getVariant,
    isDeviated,
    isParamLocked,
    isSectionLocked,
} from '../../lib/dieline/variants';
import MockupArtworkPanel from './MockupArtworkPanel';
import { useTranslation } from 'react-i18next';
import { tv } from '../../i18n';


/** Only numeric params for sliders */
type NumericParamKey = Exclude<keyof BoxParams, 'glueSide' | 'boxType' | 'panelOrder' | 'handleShape' | 'handleY' | 'lockTab' | 'handleHoles'>;

interface ParamConfig {
    key: NumericParamKey;
    label: string;
    min: number;
    max: number;
    step: number;
    unit: string;
    description: string;
}

const MAIN_PARAMS: ParamConfig[] = [
    { key: 'L', label: 'Dài (L)', min: 30, max: 500, step: 1, unit: 'mm', description: 'Chiều dài lọt lòng hộp' },
    { key: 'W', label: 'Rộng (W)', min: 20, max: 300, step: 1, unit: 'mm', description: 'Chiều rộng hông lọt lòng' },
    { key: 'D', label: 'Cao (D)', min: 10, max: 500, step: 1, unit: 'mm', description: 'Chiều cao lọt lòng hộp' },
    { key: 'T', label: 'Dày (T)', min: 0.2, max: 3, step: 0.05, unit: 'mm', description: 'Độ dày vật liệu' },
];

const ADVANCED_PARAMS: ParamConfig[] = [
    { key: 'C', label: 'Dung sai (C)', min: 0.2, max: 2, step: 0.1, unit: 'mm', description: 'Khe hở gập/đút nắp' },
    { key: 'G', label: 'Mép keo (G)', min: 8, max: 25, step: 1, unit: 'mm', description: 'Rộng mép dán keo' },
    { key: 'TH', label: 'Tai đút (TH)', min: 8, max: 30, step: 1, unit: 'mm', description: 'Chiều cao lưỡi gài' },
];


export default function ParamPanel({ onBack }: { onBack?: () => void } = {}) {
  const { t } = useTranslation();
    const {
        params, setParam, setParams, dieline, clampVersion,
        // [VARIANT 2026-07-29]
        variantId, setVariant, isAdvancedMode, setAdvancedMode,
    } = useBoxStore();
    const [showAdvanced, setShowAdvanced] = React.useState(false);
    const [showExtra, setShowExtra] = React.useState(false);

    // [VARIANT 2026-07-29] Biến thể đang chọn quyết định control nào ẩn.
    // `show(key)`: hiện khi ở chế độ chuyên gia HOẶC khoá không bị biến thể chốt.
    // `showSection(keys)`: cả cụm bị chốt thì ẩn luôn tiêu đề, tránh nhãn rỗng.
    const variant = variantId ? getVariant(variantId) : undefined;
    const show = (key: keyof BoxParams) => isAdvancedMode || !isParamLocked(variantId, key);
    const showSection = (keys: (keyof BoxParams)[]) =>
        isAdvancedMode || !isSectionLocked(variantId, keys);
    const deviated = isDeviated(variantId, params);

    // Cảnh báo hiển thị được dẫn xuất DUY NHẤT từ model.warnings (Requirement 3.4)
    const snapLockWarning = dieline?.warnings && dieline.warnings.length > 0
        ? dieline.warnings.join('. ')
        : null;




    const isRTE = params.boxType === 'rte';
    const isSLB = params.boxType === 'slb';
    const isAutoBottom = params.boxType === 'auto_bottom';
    const isGable = params.boxType === 'gable';
    const isPaperBag = params.boxType === 'paper_bag';
    const isCupSleeve = params.boxType === 'cup_sleeve';
    const isPizza = params.boxType === 'pizza';
    const isEnvelope = params.boxType === 'envelope';
    const isTray = params.boxType === 'tray';
    const isDoubleTray = params.boxType === 'double_tray'; // [DOUBLE-TRAY 2026-07-26]
    const isHangingWindow = params.boxType === 'hanging_window'; // [HANGING-WINDOW 2026-07-27]
    const isFlipTopTuck = params.boxType === 'flip_top_tuck'; // [FLIP-TOP-TUCK 2026-08-02 §FTT.4]
    // [HANGING-WINDOW 2026-07-27] Hộp treo dùng chung thân/mí keo/thứ tự mặt với RTE
    // nên vào cùng nhóm "hộp truyền thống" để hiện toggle vị trí tai dán & thứ tự mặt.
    const isBox = isRTE || isSLB || isAutoBottom || isGable || isPizza || isTray || isHangingWindow; // Traditional box types


    return (
        <div className="dt-param-panel">


            {/* Box Type Selector */}
            <div className="dt-box-type-section">
                <label className="dt-section-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>{t('dieline.param:loai_khuon')}</span>
                    {onBack && (
                        <button
                            type="button"
                            onClick={onBack}
                            title={t('dieline.param:chon_lai_loai_hop')}
                            style={{
                                background: 'transparent', border: 'none', cursor: 'pointer',
                                color: 'var(--dt-accent)', fontSize: '18px', lineHeight: 1, padding: '0 2px',
                            }}
                        >
                            ←
                        </button>
                    )}
                </label>
                {/* [VARIANT 2026-07-29] Chọn BIẾN THỂ (không phải boxType nữa) —
                    gom theo nhóm đầu tiên của biến thể để danh sách dễ đọc. */}
                <select
                    className="dt-param-select"
                    value={variantId ?? ''}
                    onChange={(e) => setVariant(e.target.value)}
                >
                    {variantId === null && (
                        <option value="">{t('dieline.param:chua_chon_mau_khuon')}</option>
                    )}
                    {BOX_GROUPS.map((g) => {
                        const items = BOX_VARIANTS.filter((v) => v.groups[0] === g.id);
                        if (items.length === 0) return null;
                        return (
                            <optgroup key={g.id} label={tv(g.nameVi, 'dieline.variant')}>
                                {items.map((v) => (
                                    <option key={v.id} value={v.id}>{tv(v.nameVi, 'dieline.variant')}</option>
                                ))}
                            </optgroup>
                        );
                    })}
                </select>
                {variant && (
                    <p className="dt-variant-meta">
                        <span className="dt-variant-code">{variant.code}</span>
                        {deviated && (
                            <span
                                className="dt-variant-deviated"
                                title={t('dieline.param:hop_da_lech_khoi_mau_khuon_chuan')}
                            >
                                {t('dieline.param:da_tuy_chinh')}
                            </span>
                        )}
                    </p>
                )}
            </div>

            {/* Cảnh báo kích thước snap-lock */}
            {snapLockWarning && (
                <div className="dt-warning">
                    <span style={{ fontSize: '1rem' }}>⚠️</span>
                    {snapLockWarning}
                </div>
            )}
            {/* Glue side */}
            {(isBox || isPaperBag) && !isCupSleeve && !isPizza && !isEnvelope && !isTray && (
                <div className="dt-param-slider">
                    <div className="dt-param-header">
                        <label className="dt-param-label">{t('dieline.param:vi_tri_tai_dan_g')}</label>
                    </div>
                    <div className="dt-glue-side-toggle">
                        <button
                            className={`dt-glue-side-btn ${params.glueSide === 'left' ? 'active' : ''}`}
                            onClick={() => setParam('glueSide', 'left')}
                        >
                            {t('dieline.param:trai')}
                        </button>
                        <button
                            className={`dt-glue-side-btn ${params.glueSide === 'right' ? 'active' : ''}`}
                            onClick={() => setParam('glueSide', 'right')}
                        >
                            {t('dieline.param:phai')}
                        </button>
                    </div>
                    <p className="dt-param-desc">{t('dieline.param:tai_dan_keo_nam_ben_trai_hoac_phai')}</p>
                </div>
            )}

            {/* Panel Order Toggle */}
            {(isBox || isPaperBag) && !isCupSleeve && !isPizza && !isEnvelope && !isTray && (<>
                <div className="dt-param-slider">
                    <div className="dt-param-header">
                        <label className="dt-param-label">{t('dieline.param:thu_tu_mat')}</label>
                    </div>
                    <div className="dt-glue-side-toggle">
                        <button
                            className={`dt-glue-side-btn ${params.panelOrder === 'WLWL' ? 'active' : ''}`}
                            onClick={() => setParam('panelOrder', 'WLWL')}
                        >
                            W•L•W•L
                        </button>
                        <button
                            className={`dt-glue-side-btn ${params.panelOrder === 'LWLW' ? 'active' : ''}`}
                            onClick={() => setParam('panelOrder', 'LWLW')}
                        >
                            L•W•L•W
                        </button>
                    </div>
                    <p className="dt-param-desc">{t('dieline.param:hong_truoc_wlwl_hay_mat_chinh_truoc')}</p>
                </div>
            </>)}

            {/* ─── Cup Sleeve Params ─── */}
            {isCupSleeve && (
                <div className="dt-params-section">
                    <label className="dt-section-label">{t('dieline.param:thong_so_ly')}</label>
                    <div className="dt-param-grid">
                        {[
                            { key: 'cupD1' as const, label: t('dieline.param:day_d1'), min: 30, max: 200, step: 1 },
                            { key: 'cupD2' as const, label: t('dieline.param:mieng_d2'), min: 40, max: 250, step: 1 },
                            { key: 'cupH' as const, label: 'Cao (H)', min: 20, max: 300, step: 1 },
                            { key: 'G' as const, label: t('dieline.param:mi_dan_g'), min: 0, max: 30, step: 1 },
                        ].map((cfg) => (
                            <div key={cfg.key} className="dt-param-cell">
                                <label className="dt-param-cell-label">{tv(cfg.label)}</label>
                                <input
                                    type="number"
                                    defaultValue={params[cfg.key] as number}
                                    key={`${cfg.key}-${params[cfg.key]}-${clampVersion}`}
                                    min={cfg.min}
                                    max={cfg.max}
                                    step={cfg.step}
                                    className="dt-param-input"
                                    style={{ textAlign: 'right' }}
                                    onBlur={(e) => {
                                        const v = parseFloat(e.target.value);
                                        if (!isNaN(v)) setParam(cfg.key, v);
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            const v = parseFloat((e.target as HTMLInputElement).value);
                                            if (!isNaN(v)) setParam(cfg.key, v);
                                            (e.target as HTMLInputElement).blur();
                                        }
                                    }}
                                />
                                <span className="dt-param-cell-unit">mm</span>
                            </div>
                        ))}
                    </div>
                    <div className="dt-param-grid" style={{ marginTop: '0.25rem' }}>
                        <div className="dt-param-cell">
                            <label className="dt-param-cell-label">{t('dieline.param:bao_phu')}</label>
                            <input
                                type="number"
                                defaultValue={params.cupCoverage}
                                key={`cupCoverage-${params.cupCoverage}`}
                                min={10}
                                max={110}
                                step={5}
                                className="dt-param-input"
                                style={{ textAlign: 'right' }}
                                onBlur={(e) => {
                                    const v = parseFloat(e.target.value);
                                    if (!isNaN(v)) setParam('cupCoverage', v);
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        const v = parseFloat((e.target as HTMLInputElement).value);
                                        if (!isNaN(v)) setParam('cupCoverage', v);
                                        (e.target as HTMLInputElement).blur();
                                    }
                                }}
                            />
                            <span className="dt-param-cell-unit">%</span>
                        </div>
                    </div>
                    <div className="dt-param-slider" style={{ marginTop: '0.5rem' }}>
                        <div className="dt-param-header">
                            <label className="dt-param-label">{t('dieline.param:loai_chieu_cao')}</label>
                        </div>
                        <div className="dt-glue-side-toggle">
                            <button
                                className={`dt-glue-side-btn ${params.cupHeightType === 'slant' ? 'active' : ''}`}
                                onClick={() => setParam('cupHeightType', 'slant')}
                            >
                                {t('dieline.param:chieu_nghieng')}
                            </button>
                            <button
                                className={`dt-glue-side-btn ${params.cupHeightType === 'vertical' ? 'active' : ''}`}
                                onClick={() => setParam('cupHeightType', 'vertical')}
                            >
                                {t('dieline.param:chieu_thang_dung')}
                            </button>
                        </div>
                    </div>
                    {/* [VARIANT 2026-07-29] Vị trí vạt dán do biến thể chốt (bọc ly
                        dán vòng vs bọc ly rời) — ẩn khi đã chốt. */}
                    {show('cupFlapPosition') && (
                    <div className="dt-param-slider" style={{ marginTop: '0.5rem' }}>
                        <div className="dt-param-header">
                            <label className="dt-param-label">{t('dieline.param:vi_tri_vat_dan')}</label>
                        </div>
                        <div className="dt-glue-side-toggle">
                            <button
                                className={`dt-glue-side-btn ${params.cupFlapPosition === 'right' ? 'active' : ''}`}
                                onClick={() => setParam('cupFlapPosition', 'right')}
                            >
                                {t('dieline.param:ben_phai')}
                            </button>
                            <button
                                className={`dt-glue-side-btn ${params.cupFlapPosition === 'left' ? 'active' : ''}`}
                                onClick={() => setParam('cupFlapPosition', 'left')}
                            >
                                {t('dieline.param:ben_trai')}
                            </button>
                            <button
                                className={`dt-glue-side-btn ${params.cupFlapPosition === 'none' ? 'active' : ''}`}
                                onClick={() => setParam('cupFlapPosition', 'none')}
                            >
                                {t('dieline.param:khong_co')}
                            </button>
                        </div>
                    </div>
                    )}
                </div>
            )}

            {/* ─── Envelope Params ─── */}
            {isEnvelope && (
                <div className="dt-params-section">
                    <label className="dt-section-label">{t('dieline.param:kich_thuoc_co_san')}</label>
                    <select
                        className="dt-param-select"
                        style={{ marginBottom: '0.75rem' }}
                        value={
                            [
                                { label: t('dieline.param:12_22_nap_30'), w: 220, h: 120, fh: 30, style: 'wallet' as const },
                                { label: t('dieline.param:16_23_nap_30'), w: 230, h: 160, fh: 30, style: 'wallet' as const },
                                { label: t('dieline.param:11_19_nap_25'), w: 190, h: 110, fh: 25, style: 'wallet' as const },
                                { label: t('dieline.param:25_34_nap_30'), w: 340, h: 250, fh: 30, style: 'pocket' as const },
                            ].findIndex(p => p.w === params.envW && p.h === params.envH && p.style === params.envStyle)
                        }
                        onChange={(e) => {
                            const presets = [
                                { w: 220, h: 120, fh: 30, style: 'wallet' as const },
                                { w: 230, h: 160, fh: 30, style: 'wallet' as const },
                                { w: 190, h: 110, fh: 25, style: 'wallet' as const },
                                { w: 340, h: 250, fh: 30, style: 'pocket' as const },
                            ];
                            const idx = parseInt(e.target.value);
                            if (idx >= 0) {
                                setParams({
                                    envW: presets[idx].w,
                                    envH: presets[idx].h,
                                    envFH: presets[idx].fh,
                                    envStyle: presets[idx].style,
                                });
                            }
                        }}
                    >
                        <option value={-1}>{t('dieline.param:tuy_chinh')}</option>
                        <option value={0}>{t('dieline.param:12_22_cm_nap_3cm_ngang')}</option>
                        <option value={1}>{t('dieline.param:16_23_cm_nap_3cm_ngang')}</option>
                        <option value={2}>{t('dieline.param:11_19_cm_nap_2_5cm_ngang')}</option>
                        <option value={3}>{t('dieline.param:25_34_cm_nap_3cm_doc')}</option>
                    </select>

                    <label className="dt-section-label">{t('dieline.param:kich_thuoc_tuy_chinh')}</label>
                    <div className="dt-param-grid">
                        {(() => {
                            const flapRef = params.envH; // Cả ngang lẫn dọc đều dùng envH làm flapRef
                            const autoFH = params.envFlapShape === 'straight' ? 30 : Math.round(flapRef * 0.45);
                            const autoSF = Math.max(10, Math.min(15, Math.round(flapRef * 0.12)));
                            return [
                                { key: 'envW' as const, label: t('dieline.param:rong_w'), min: 80, max: 500, step: 1 },
                                { key: 'envH' as const, label: 'Cao (H)', min: 50, max: 400, step: 1 },
                                { key: 'envFH' as const, label: t('dieline.param:nap_dan_fh'), min: 0, max: 200, step: 1 },
                                { key: 'envSF' as const, label: t('dieline.param:tai_hong_sf'), min: 0, max: 100, step: 1 },
                                { key: 'T' as const, label: t('dieline.param:day_t'), min: 0.2, max: 3, step: 0.05 },
                            ].map((cfg) => {
                                const rawVal = params[cfg.key] as number;
                                const isAuto = (cfg.key === 'envFH' || cfg.key === 'envSF') && rawVal === 0;
                                const displayVal = isAuto ? (cfg.key === 'envFH' ? autoFH : autoSF) : rawVal;
                                return (
                                    <div key={cfg.key} className="dt-param-cell">
                                        <label className="dt-param-cell-label">{tv(cfg.label)}</label>
                                        <input
                                            type="number"
                                            defaultValue={displayVal}
                                            key={`${cfg.key}-${rawVal}-${clampVersion}-${params.envFlapShape}-${params.envStyle}`}
                                            min={cfg.min}
                                            max={cfg.max}
                                            step={cfg.step}
                                            className="dt-param-input"
                                            style={{ textAlign: 'right', opacity: isAuto ? 0.5 : 1 }}
                                            onFocus={(e) => { if (isAuto) e.target.value = ''; }}
                                            onBlur={(e) => {
                                                const v = parseFloat(e.target.value);
                                                if (!isNaN(v)) setParam(cfg.key, v);
                                                else if (e.target.value === '' && (cfg.key === 'envFH' || cfg.key === 'envSF')) {
                                                    setParam(cfg.key, 0);
                                                }
                                            }}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    const v = parseFloat((e.target as HTMLInputElement).value);
                                                    if (!isNaN(v)) setParam(cfg.key, v);
                                                    (e.target as HTMLInputElement).blur();
                                                }
                                            }}
                                        />
                                        <span className="dt-param-cell-unit">{isAuto ? 'Auto' : 'mm'}</span>
                                    </div>
                                );
                            });
                        })()}
                    </div>

                    {/* Flap Shape — [VARIANT 2026-07-29] biến thể "nắp nhọn"/"nắp thẳng" chốt sẵn */}
                    {show('envFlapShape') && (
                    <div className="dt-param-slider" style={{ marginTop: '0.5rem' }}>
                        <div className="dt-param-header">
                            <label className="dt-param-label">{t('dieline.param:dang_nap_dan')}</label>
                        </div>
                        <div className="dt-glue-side-toggle">
                            <button
                                className={`dt-glue-side-btn ${params.envFlapShape === 'pointed' ? 'active' : ''}`}
                                onClick={() => setParam('envFlapShape', 'pointed')}
                            >
                                {t('dieline.param:nhon')}
                            </button>
                            <button
                                className={`dt-glue-side-btn ${params.envFlapShape === 'rounded' ? 'active' : ''}`}
                                onClick={() => setParam('envFlapShape', 'rounded')}
                            >
                                {t('dieline.param:tron')}
                            </button>
                            <button
                                className={`dt-glue-side-btn ${params.envFlapShape === 'straight' ? 'active' : ''}`}
                                onClick={() => setParam('envFlapShape', 'straight')}
                            >
                                {t('dieline.param:thang')}
                            </button>
                        </div>
                    </div>
                    )}

                    {/* Envelope Style — [VARIANT 2026-07-29] bì ngang/dọc là hai card riêng */}
                    {show('envStyle') && (
                    <div className="dt-param-slider" style={{ marginTop: '0.5rem' }}>
                        <div className="dt-param-header">
                            <label className="dt-param-label">{t('dieline.param:kieu_bi_thu')}</label>
                        </div>
                        <div className="dt-glue-side-toggle">
                            <button
                                className={`dt-glue-side-btn ${params.envStyle === 'wallet' ? 'active' : ''}`}
                                onClick={() => setParam('envStyle', 'wallet')}
                            >
                                {t('dieline.param:ngang')}
                            </button>
                            <button
                                className={`dt-glue-side-btn ${params.envStyle === 'pocket' ? 'active' : ''}`}
                                onClick={() => setParam('envStyle', 'pocket')}
                            >
                                {t('dieline.param:doc')}
                            </button>
                        </div>
                        <p className="dt-param-desc">{t('dieline.param:ngang_pho_bien_hoac_doc_mat_truoc_sau')}</p>
                    </div>
                    )}

                    {/* Window Toggle — [VARIANT 2026-07-29] "Bì thư có cửa sổ" là card riêng.
                        Số đo cửa sổ bên dưới VẪN hiện, chỉ ẩn công tắc bật/tắt. */}
                    {show('envWindow') && (
                    <div className="dt-param-slider" style={{ marginTop: '0.5rem' }}>
                        <div className="dt-param-cell" style={{ cursor: 'pointer' }} onClick={() => setParam('envWindow', !params.envWindow)}>
                            <label className="dt-param-cell-label" style={{ cursor: 'pointer' }}>{t('dieline.param:cua_so_trong_suot')}</label>
                            <input type="checkbox" checked={params.envWindow as boolean} readOnly style={{ accentColor: 'var(--dt-accent)' }} />
                        </div>
                    </div>
                    )}

                    {/* Window Dimensions */}
                    {
                        params.envWindow && (
                            <div className="dt-param-grid" style={{ marginTop: '0.25rem' }}>
                                {[
                                    { key: 'envWindowW' as const, label: t('dieline.param:rong_cua_so'), min: 10, max: 300 },
                                    { key: 'envWindowH' as const, label: t('dieline.param:cao_cua_so'), min: 10, max: 200 },
                                    { key: 'envWindowX' as const, label: t('dieline.param:cach_trai_x'), min: 5, max: 400 },
                                    { key: 'envWindowY' as const, label: t('dieline.param:cach_duoi_y'), min: 5, max: 300 },
                                ].map((cfg) => (
                                    <div key={cfg.key} className="dt-param-cell">
                                        <label className="dt-param-cell-label">{tv(cfg.label)}</label>
                                        <input
                                            type="number"
                                            defaultValue={params[cfg.key] as number}
                                            key={`${cfg.key}-${params[cfg.key]}-${clampVersion}`}
                                            min={cfg.min}
                                            max={cfg.max}
                                            step={1}
                                            className="dt-param-input"
                                            style={{ textAlign: 'right' }}
                                            onBlur={(e) => {
                                                const v = parseFloat(e.target.value);
                                                if (!isNaN(v)) setParam(cfg.key, v);
                                            }}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    const v = parseFloat((e.target as HTMLInputElement).value);
                                                    if (!isNaN(v)) setParam(cfg.key, v);
                                                    (e.target as HTMLInputElement).blur();
                                                }
                                            }}
                                        />
                                        <span className="dt-param-cell-unit">mm</span>
                                    </div>
                                ))}
                            </div>
                        )
                    }
                </div>
            )}

            {/* ─── Tray Params ─── L, W, D, T + G (dầm) + TH (mí gập) */}
            {isTray && (
                <div className="dt-params-section">
                    <label className="dt-section-label">{t('dieline.param:kich_thuoc_chinh')}</label>
                    <p className="dt-param-desc" style={{ marginBottom: '0.5rem', opacity: 0.7 }}>
                        {t('dieline.param:l_dai_w_rong_d_cao_vach_g_dam_th_mi_gap')}
                    </p>
                    <div className="dt-param-grid">
                        {[
                            { key: 'L' as const, label: t('dieline.param:dai_l'), min: 30, max: 500, step: 1 },
                            { key: 'W' as const, label: t('dieline.param:rong_w'), min: 20, max: 400, step: 1 },
                            { key: 'D' as const, label: t('dieline.param:cao_vach_d'), min: 10, max: 200, step: 1 },
                            { key: 'T' as const, label: t('dieline.param:day_giay_t'), min: 0.2, max: 3, step: 0.05 },
                            { key: 'G' as const, label: t('dieline.param:dam_g'), min: 3, max: 30, step: 1 },
                            { key: 'TH' as const, label: t('dieline.param:mi_gap_th'), min: 5, max: 40, step: 1 },
                            { key: 'sleeveGlue' as const, label: t('dieline.param:mi_dan_vo'), min: 5, max: 30, step: 1 },
                        ].map((cfg) => (
                            <div key={cfg.key} className="dt-param-cell">
                                <label className="dt-param-cell-label">{tv(cfg.label)}</label>
                                <input
                                    type="number"
                                    defaultValue={params[cfg.key] as number}
                                    key={`${cfg.key}-${clampVersion}`}
                                    min={cfg.min}
                                    max={cfg.max}
                                    step={cfg.step}
                                    className="dt-param-input"
                                    style={{ textAlign: 'right' }}
                                    onBlur={(e) => {
                                        const v = parseFloat(e.target.value);
                                        if (!isNaN(v)) setParam(cfg.key, v);
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            const v = parseFloat((e.target as HTMLInputElement).value);
                                            if (!isNaN(v)) setParam(cfg.key, v);
                                            (e.target as HTMLInputElement).blur();
                                        }
                                    }}
                                />
                                <span className="dt-param-cell-unit">mm</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* ─── Double Tray (Hộp âm dương) Params ─── [DOUBLE-TRAY 2026-07-26] */}
            {isDoubleTray && (
                <div className="dt-params-section">
                    <label className="dt-section-label">{t('dieline.param:kich_thuoc_chinh')}</label>
                    <p className="dt-param-desc" style={{ marginBottom: '0.5rem', opacity: 0.7 }}>
                        {t('dieline.param:than_day_l_w_thanh_d_nap_tu_sinh_8t_2khe')}
                    </p>
                    <div className="dt-param-grid">
                        {[
                            { key: 'L' as const, label: t('dieline.param:dai_l'), min: 30, max: 500, step: 1 },
                            { key: 'W' as const, label: t('dieline.param:rong_w'), min: 15, max: 400, step: 1 },
                            { key: 'D' as const, label: t('dieline.param:cao_vach_d'), min: 10, max: 200, step: 1 },
                            { key: 'T' as const, label: t('dieline.param:day_giay_t'), min: 0.2, max: 3, step: 0.05 },
                            { key: 'C' as const, label: 'Dung sai (C)', min: 0.2, max: 3, step: 0.1 },
                            { key: 'G' as const, label: t('dieline.param:dam_g'), min: 5, max: 30, step: 1 },
                            { key: 'TH' as const, label: t('dieline.param:mi_gap_th'), min: 2, max: 40, step: 1 },
                            { key: 'lidD' as const, label: t('dieline.param:cao_thanh_nap_lidd'), min: 0, max: 200, step: 1 },
                            { key: 'lidGap' as const, label: t('dieline.param:khe_long_nap_lidgap'), min: 0, max: 5, step: 0.5 },
                        ].map((cfg) => (
                            <div key={cfg.key} className="dt-param-cell">
                                <label className="dt-param-cell-label">{tv(cfg.label)}</label>
                                <input
                                    type="number"
                                    defaultValue={params[cfg.key] as number}
                                    key={`${cfg.key}-${clampVersion}`}
                                    min={cfg.min}
                                    max={cfg.max}
                                    step={cfg.step}
                                    className="dt-param-input"
                                    style={{ textAlign: 'right' }}
                                    onBlur={(e) => {
                                        const v = parseFloat(e.target.value);
                                        if (!isNaN(v)) setParam(cfg.key, v);
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            const v = parseFloat((e.target as HTMLInputElement).value);
                                            if (!isNaN(v)) setParam(cfg.key, v);
                                            (e.target as HTMLInputElement).blur();
                                        }
                                    }}
                                />
                                <span className="dt-param-cell-unit">mm</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Main Params — 2×2 grid (box/bag types only) */}
            {!isCupSleeve && !isEnvelope && !isTray && !isDoubleTray && (
                <div className="dt-params-section">
                    <label className="dt-section-label">{t('dieline.param:kich_thuoc_chinh')}</label>
                    <p className="dt-param-desc" style={{ marginBottom: '0.5rem', opacity: 0.7 }}>
                        {isPaperBag ? t('dieline.param:l_rong_mat_w_rong_hong_d_cao_than_tui') : t('dieline.param:l_dai_w_rong_d_cao')}
                    </p>
                    <div className="dt-param-grid">
                        {MAIN_PARAMS.map((cfg) => (
                            <div key={cfg.key} className="dt-param-cell">
                                <label className="dt-param-cell-label">{tv(cfg.label)}</label>
                                <input
                                    type="number"
                                    defaultValue={params[cfg.key] as number}
                                    key={`${cfg.key}-${clampVersion}`}
                                    min={cfg.min}
                                    max={cfg.max}
                                    step={cfg.step}
                                    className="dt-param-input"
                                    style={{ textAlign: 'right' }}
                                    onBlur={(e) => {
                                        const v = parseFloat(e.target.value);
                                        if (!isNaN(v)) setParam(cfg.key, v);
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            const v = parseFloat((e.target as HTMLInputElement).value);
                                            if (!isNaN(v)) setParam(cfg.key, v);
                                            (e.target as HTMLInputElement).blur();
                                        }
                                    }}
                                />
                                <span className="dt-param-cell-unit">{cfg.unit}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* ─── Gable: Kiểu nắp & quai xách (thiết kế chính, luôn hiện) ─── */}
            {isGable && (() => {
                const gh1 = Math.round(params.W / 2);
                const gh2 = Math.round(0.9 * gh1);
                const designNums: { key: 'HFH' | 'HW' | 'HHL'; label: string; defVal: number; min: number; max: number }[] = [
                    { key: 'HFH', label: t('dieline.param:cao_tay_cam'), defVal: gh2, min: 0, max: 100 },
                    { key: 'HW', label: t('dieline.param:rong_lo_quai'), defVal: Math.round(2 / 5 * params.L), min: 0, max: Math.max(20, params.L - 20) },
                    { key: 'HHL', label: t('dieline.param:cao_lo_quai'), defVal: Math.round(gh2 / 2), min: 0, max: 60 },
                ];
                return (
                    <div className="dt-params-section">
                        <label className="dt-section-label">{t('dieline.param:kieu_nap_quai_xach')}</label>
                        {/* [VARIANT 2026-07-29] Mái dốc / mái bằng là hai card riêng */}
                        {show('gableStyle') && (
                        <div className="dt-param-slider">
                            <div className="dt-param-header"><label className="dt-param-label">{t('dieline.param:kieu_mai')}</label></div>
                            <div className="dt-glue-side-toggle">
                                <button className={`dt-glue-side-btn ${params.gableStyle === 'flat' ? 'active' : ''}`} onClick={() => setParam('gableStyle', 'flat')}>{t('dieline.param:mai_bang')}</button>
                                <button className={`dt-glue-side-btn ${params.gableStyle === 'pitched' ? 'active' : ''}`} onClick={() => setParam('gableStyle', 'pitched')}>{t('dieline.param:mai_doc')}</button>
                            </div>
                        </div>
                        )}
                        <div className="dt-param-grid" style={{ marginTop: '0.5rem' }}>
                            {designNums.map((gp) => (
                                <div key={gp.key} className="dt-param-cell">
                                    <label className="dt-param-cell-label">{tv(gp.label)}</label>
                                    <input
                                        type="number"
                                        defaultValue={params[gp.key] === 0 ? gp.defVal : params[gp.key] as number}
                                        key={`${gp.key}-${params[gp.key]}-${clampVersion}`}
                                        min={gp.min} max={gp.max} step={1}
                                        className="dt-param-input" style={{ textAlign: 'right' }}
                                        onBlur={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) setParam(gp.key, v === gp.defVal ? 0 : v); }}
                                        onKeyDown={(e) => { if (e.key === 'Enter') { const v = parseFloat((e.target as HTMLInputElement).value); if (!isNaN(v)) setParam(gp.key, v === gp.defVal ? 0 : v); (e.target as HTMLInputElement).blur(); } }}
                                    />
                                    <span className="dt-param-cell-unit">{params[gp.key] === 0 ? 'Auto' : 'mm'}</span>
                                </div>
                            ))}
                        </div>
                        <div className="dt-param-slider" style={{ marginTop: '0.5rem' }}>
                            <div className="dt-param-header"><label className="dt-param-label">{t('dieline.param:dang_lo_quai')}</label></div>
                            <div className="dt-glue-side-toggle">
                                <button className={`dt-glue-side-btn ${params.handleShape === 'oval' ? 'active' : ''}`} onClick={() => setParam('handleShape', 'oval')}>⬭ Oval</button>
                                <button className={`dt-glue-side-btn ${params.handleShape === 'roundRect' ? 'active' : ''}`} onClick={() => setParam('handleShape', 'roundRect')}>{t('dieline.param:bo_tron')}</button>
                            </div>
                        </div>
                        <div className="dt-param-slider" style={{ marginTop: '0.5rem' }}>
                            <div className="dt-param-header"><label className="dt-param-label">{t('dieline.param:vi_tri_lo')}</label></div>
                            <div className="dt-glue-side-toggle">
                                <button className={`dt-glue-side-btn ${params.handleY === 'bottom' ? 'active' : ''}`} onClick={() => setParam('handleY', 'bottom')}>{t('dieline.param:sat_day')}</button>
                                <button className={`dt-glue-side-btn ${params.handleY === 'center' ? 'active' : ''}`} onClick={() => setParam('handleY', 'center')}>{t('dieline.param:giua')}</button>
                            </div>
                        </div>
                    </div>
                );
            })()}

            {/* ─── Pizza: tính năng riêng (luôn hiện khi chọn hộp pizza) ─── */}
            {/* [VARIANT 2026-07-29] Hai card pizza chốt cả GÓI 3 công tắc ⇒ cả cụm bị
                chốt thì ẩn luôn tiêu đề section, không để lại nhãn rỗng. Đường kính
                lỗ thông hơi vẫn hiện khi lỗ đang bật (đó là số đo, không phải công tắc). */}
            {isPizza && showSection(['pizzaVent', 'pizzaFrontLock', 'pizzaCornerLock']) && (
                <div className="dt-params-section">
                    <label className="dt-section-label">{t('dieline.param:tinh_nang_hop_pizza')}</label>
                    <div className="dt-param-grid">
                        {show('pizzaVent') && (
                        <div className="dt-param-cell" style={{ cursor: 'pointer' }} onClick={() => setParam('pizzaVent', !params.pizzaVent)}>
                            <label className="dt-param-cell-label" style={{ cursor: 'pointer' }}>{t('dieline.param:lo_thong_hoi')}</label>
                            <input type="checkbox" checked={params.pizzaVent as boolean} readOnly style={{ accentColor: 'var(--dt-accent)' }} />
                        </div>
                        )}
                        {params.pizzaVent && (
                            <div className="dt-param-cell">
                                <label className="dt-param-cell-label">{t('dieline.param:lo_thong_hoi_2')}</label>
                                <input
                                    type="number"
                                    defaultValue={params.pizzaVentD === 0 ? 6 : params.pizzaVentD}
                                    key={`pizzaVentD-${params.pizzaVentD}`}
                                    min={2} max={20} step={1}
                                    className="dt-param-input" style={{ textAlign: 'right' }}
                                    onBlur={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) setParam('pizzaVentD', v === 6 ? 0 : v); }}
                                    onKeyDown={(e) => { if (e.key === 'Enter') { const v = parseFloat((e.target as HTMLInputElement).value); if (!isNaN(v)) setParam('pizzaVentD', v === 6 ? 0 : v); (e.target as HTMLInputElement).blur(); } }}
                                />
                                <span className="dt-param-cell-unit">{params.pizzaVentD === 0 ? 'Auto' : 'mm'}</span>
                            </div>
                        )}
                        {show('pizzaFrontLock') && (
                        <div className="dt-param-cell" style={{ cursor: 'pointer' }} onClick={() => setParam('pizzaFrontLock', !params.pizzaFrontLock)}>
                            <label className="dt-param-cell-label" style={{ cursor: 'pointer' }}>{t('dieline.param:luoi_gai_khoa_nap')}</label>
                            <input type="checkbox" checked={params.pizzaFrontLock as boolean} readOnly style={{ accentColor: 'var(--dt-accent)' }} />
                        </div>
                        )}
                        {show('pizzaCornerLock') && (
                        <div className="dt-param-cell" style={{ cursor: 'pointer' }} onClick={() => setParam('pizzaCornerLock', !params.pizzaCornerLock)}>
                            <label className="dt-param-cell-label" style={{ cursor: 'pointer' }}>{t('dieline.param:khoa_goc_xep_chong')}</label>
                            <input type="checkbox" checked={params.pizzaCornerLock as boolean} readOnly style={{ accentColor: 'var(--dt-accent)' }} />
                        </div>
                        )}
                    </div>
                </div>
            )}

            {/* ─── Hộp treo có cửa sổ: cửa sổ mặt trước + tai treo euro ─── [HANGING-WINDOW 2026-07-27] */}
            {isHangingWindow && (() => {
                // 0 = tự động, đúng hằng HGB_* của generator: cửa sổ 0.5×L / 0.5×D,
                // cao MỘT lớp tai treo 0.25×D kẹp trong 20–40mm.
                const defWNW = Math.round(0.5 * params.L);
                const defWNH = Math.round(0.5 * params.D);
                const defHTH = Math.round(Math.min(40, Math.max(20, 0.25 * params.D)));
                const hgbParams: { key: 'WNW' | 'WNH' | 'HTH'; label: string; defVal: number; min: number; max: number }[] = [
                    ...(params.hgbWindow ? [
                        { key: 'WNW' as const, label: t('dieline.param:rong_cua_so'), defVal: defWNW, min: 0, max: Math.max(10, Math.round(params.L)) },
                        { key: 'WNH' as const, label: t('dieline.param:cao_cua_so'), defVal: defWNH, min: 0, max: Math.max(10, Math.round(params.D)) },
                    ] : []),
                    { key: 'HTH', label: t('dieline.param:cao_tai_treo'), defVal: defHTH, min: 0, max: 40 },
                ];
                return (
                    <div className="dt-params-section">
                        <label className="dt-section-label">{t('dieline.param:thong_so_hop_treo')}</label>
                        <div className="dt-param-grid">
                            {/* Công tắc cửa sổ — theo khuôn envWindow của bì thư.
                                [VARIANT 2026-07-29] "Hộp treo có cửa sổ" và "Hộp treo kín"
                                là hai card riêng ⇒ ẩn công tắc khi đã chốt. */}
                            {show('hgbWindow') && (
                            <div className="dt-param-cell" style={{ cursor: 'pointer' }} onClick={() => setParam('hgbWindow', !params.hgbWindow)}>
                                <label className="dt-param-cell-label" style={{ cursor: 'pointer' }}>{t('dieline.param:cua_so_mat_truoc')}</label>
                                <input type="checkbox" checked={params.hgbWindow as boolean} readOnly style={{ accentColor: 'var(--dt-accent)' }} />
                            </div>
                            )}
                            {hgbParams.map((hp) => (
                                <div key={hp.key} className="dt-param-cell">
                                    <label className="dt-param-cell-label">{tv(hp.label)}</label>
                                    <input
                                        type="number"
                                        defaultValue={params[hp.key] === 0 ? hp.defVal : params[hp.key] as number}
                                        key={`${hp.key}-${params[hp.key]}-${clampVersion}`}
                                        min={hp.min}
                                        max={hp.max}
                                        step={1}
                                        className="dt-param-input"
                                        style={{ textAlign: 'right' }}
                                        onBlur={(e) => {
                                            const v = parseFloat(e.target.value);
                                            if (!isNaN(v)) setParam(hp.key, v === hp.defVal ? 0 : v);
                                        }}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                const v = parseFloat((e.target as HTMLInputElement).value);
                                                if (!isNaN(v)) setParam(hp.key, v === hp.defVal ? 0 : v);
                                                (e.target as HTMLInputElement).blur();
                                            }
                                        }}
                                    />
                                    <span className="dt-param-cell-unit">{params[hp.key] === 0 ? 'Auto' : 'mm'}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                );
            })()}

            {/* Advanced Toggle — not for cup sleeve */}
            {!isCupSleeve && !isEnvelope && !isTray && !isDoubleTray && (
                <button
                    className="dt-advanced-toggle"
                    onClick={() => setShowAdvanced(!showAdvanced)}
                >
                    {showAdvanced ? '▼' : '▶'} {t('dieline.param:thong_so_nang_cao')}
                </button>
            )}

            {showAdvanced && (
                <div className="dt-params-section">
                    <div className="dt-param-grid">
                        {(isPaperBag
                            ? [
                                { key: 'C' as const, label: 'Dung sai (C)', min: 0.2, max: 2, step: 0.1, unit: 'mm' },
                                { key: 'G' as const, label: t('dieline.param:mep_keo_g'), min: 8, max: 25, step: 1, unit: 'mm' },
                                { key: 'TH' as const, label: t('dieline.param:mi_gap_mieng'), min: 0, max: 80, step: 1, unit: 'mm' },
                            ]
                            : isFlipTopTuck
                                ? ADVANCED_PARAMS.filter(p => p.key === 'C')
                            : isGable
                                ? ADVANCED_PARAMS.filter(p => p.key !== 'TH') // Gable không có tai đút
                                : ADVANCED_PARAMS
                        // [PAPER-BAG FIX 2026-08-03 §PB.1] TH là quyết định hình
                        // của biến thể túi; ẩn khi đã khóa, mở lại ở chế độ chuyên gia.
                        ).filter((cfg) => show(cfg.key)).map((cfg) => (
                            <div key={cfg.key} className="dt-param-cell">
                                <label className="dt-param-cell-label">{tv(cfg.label)}</label>
                                <input
                                    type="number"
                                    defaultValue={params[cfg.key] as number}
                                    key={`${cfg.key}-${params[cfg.key]}-${clampVersion}`}
                                    min={cfg.min}
                                    max={cfg.max}
                                    step={cfg.step}
                                    className="dt-param-input"
                                    style={{ textAlign: 'right' }}
                                    onBlur={(e) => {
                                        const v = parseFloat(e.target.value);
                                        if (!isNaN(v)) setParam(cfg.key, v);
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            const v = parseFloat((e.target as HTMLInputElement).value);
                                            if (!isNaN(v)) setParam(cfg.key, v);
                                            (e.target as HTMLInputElement).blur();
                                        }
                                    }}
                                />
                                <span className="dt-param-cell-unit">{cfg.unit}</span>
                            </div>
                        ))}
                    </div>

                    {/* Dust Flap Height — chỉ hiện cho RTE, SLB, Đáy dán (có tai bụi) */}
                    {(isRTE || isSLB || isAutoBottom) && (() => {
                        const defDFH = Math.round(Math.min(params.L / 2 - 1, params.W + params.T));
                        return (
                            <div className="dt-param-grid" style={{ marginTop: '0.25rem' }}>
                                <div className="dt-param-cell">
                                    <label className="dt-param-cell-label">{t('dieline.param:cao_tai_bui_dfh')}</label>
                                    <input
                                        type="number"
                                        defaultValue={params.DFH === 0 ? defDFH : params.DFH}
                                        key={params.DFH === 0 ? `DFH-auto-${defDFH}` : `DFH-${params.DFH}-${clampVersion}`}
                                        min={0}
                                        max={Math.floor(params.L / 2)}
                                        step={1}
                                        className="dt-param-input"
                                        style={{ textAlign: 'right' }}
                                        onBlur={(e) => {
                                            const v = parseFloat(e.target.value);
                                            if (!isNaN(v)) setParam('DFH', v);
                                        }}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                const v = parseFloat((e.target as HTMLInputElement).value);
                                                if (!isNaN(v)) setParam('DFH', v);
                                                (e.target as HTMLInputElement).blur();
                                            }
                                        }}
                                    />
                                    <span className="dt-param-cell-unit">{params.DFH === 0 ? 'Auto' : 'mm'}</span>
                                </div>
                            </div>
                        );
                    })()}
                </div>
            )}

            {(isSLB || isGable || isAutoBottom) && (<>
                <button
                    className="dt-advanced-toggle"
                    onClick={() => setShowExtra(!showExtra)}
                >
                    {showExtra ? '▼' : '▶'} {isGable ? t('dieline.param:tinh_chinh_khoa_ngam_nang_cao') : t('dieline.param:thong_so_day_nap')}
                </button>

                {showExtra && (
                    <div className="dt-params-section">
                        <div className="dt-param-grid">
                            {/* ABD — chiều sâu mảnh đáy dán, chỉ hộp đáy dán */}
                            {isAutoBottom && (() => {
                                const defABD = Math.round(params.W * 0.7);
                                return (
                                    <div className="dt-param-cell">
                                        <label className="dt-param-cell-label">{t('dieline.param:sau_day_dan_abd')}</label>
                                        <input
                                            type="number"
                                            defaultValue={params.ABD === 0 ? defABD : params.ABD}
                                            key={params.ABD === 0 ? `ABD-auto-${defABD}` : `ABD-${params.ABD}-${clampVersion}`}
                                            min={0}
                                            max={Math.floor(params.W)}
                                            step={1}
                                            className="dt-param-input"
                                            style={{ textAlign: 'right' }}
                                            onBlur={(e) => {
                                                const v = parseFloat(e.target.value);
                                                if (!isNaN(v)) setParam('ABD', v);
                                            }}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    const v = parseFloat((e.target as HTMLInputElement).value);
                                                    if (!isNaN(v)) setParam('ABD', v);
                                                    (e.target as HTMLInputElement).blur();
                                                }
                                            }}
                                        />
                                        <span className="dt-param-cell-unit">{params.ABD === 0 ? 'Auto' : 'mm'}</span>
                                    </div>
                                );
                            })()}

                            {/* SLP Input — chỉ đáy gài / quai xách */}
                            {(isSLB || isGable) && (<div className="dt-param-cell">
                                <label className="dt-param-cell-label">{t('dieline.param:so_cap_day')}</label>
                                <input
                                    type="number"
                                    defaultValue={params.SLP}
                                    key={`SLP-${params.SLP}`}
                                    min={0}
                                    max={5}
                                    step={1}
                                    className="dt-param-input"
                                    style={{ textAlign: 'right' }}
                                    onBlur={(e) => {
                                        const v = parseFloat(e.target.value);
                                        if (!isNaN(v)) setParam('SLP', v);
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            const v = parseFloat((e.target as HTMLInputElement).value);
                                            if (!isNaN(v)) setParam('SLP', v);
                                            (e.target as HTMLInputElement).blur();
                                        }
                                    }}
                                />
                                <span className="dt-param-cell-unit">{params.SLP === 0 ? 'Auto' : ''}</span>
                            </div>)}

                            {/* Lock Tab Toggle + Params — đáy gài & đáy dán.
                                [VARIANT 2026-07-29] "có lưỡi khoá nắp" đã là card riêng ⇒ ẩn
                                công tắc; hai ô số đo lưỡi khoá bên dưới vẫn hiện. */}
                            {(isSLB || isAutoBottom) && show('lockTab') && (
                                <div className="dt-param-cell" style={{ cursor: 'pointer' }} onClick={() => setParam('lockTab', !params.lockTab)}>
                                    <label className="dt-param-cell-label" style={{ cursor: 'pointer' }}>{t('dieline.param:luoi_khoa_nap')}</label>
                                    <input type="checkbox" checked={params.lockTab as boolean} readOnly style={{ accentColor: 'var(--dt-accent)' }} />
                                </div>
                            )}
                            {(isSLB || isAutoBottom) && params.lockTab && (() => {
                                const lockParams: { key: 'LTW' | 'LTH'; label: string; min: number; max: number }[] = [
                                    { key: 'LTW', label: t('dieline.param:rong_luoi_khoa'), min: 5, max: 40 },
                                    { key: 'LTH', label: t('dieline.param:cao_luoi_khoa'), min: 5, max: 40 },
                                ];
                                return lockParams.map((lp) => (
                                    <div key={lp.key} className="dt-param-cell">
                                        <label className="dt-param-cell-label">{tv(lp.label)}</label>
                                        <input
                                            type="number"
                                            defaultValue={params[lp.key] as number}
                                            key={`${lp.key}-${params[lp.key]}`}
                                            min={lp.min}
                                            max={lp.max}
                                            step={1}
                                            className="dt-param-input"
                                            style={{ textAlign: 'right' }}
                                            onBlur={(e) => {
                                                const v = parseFloat(e.target.value);
                                                if (!isNaN(v)) setParam(lp.key, v);
                                            }}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    const v = parseFloat((e.target as HTMLInputElement).value);
                                                    if (!isNaN(v)) setParam(lp.key, v);
                                                    (e.target as HTMLInputElement).blur();
                                                }
                                            }}
                                        />
                                        <span className="dt-param-cell-unit">mm</span>
                                    </div>
                                ));
                            })()}

                            {/* Gable — chỉ tham số khóa/ngàm nâng cao (đa số Auto); thiết kế chính ở mục trên */}
                            {isGable && (() => {
                                const h1 = Math.round(params.W / 2);
                                const h2 = Math.round(0.9 * h1);
                                const defHH = h1 + h2;
                                const gableParams: { key: 'HH' | 'SLW' | 'SLH' | 'TRW'; label: string; defVal: number; min: number; max: number }[] = [
                                    { key: 'HH', label: t('dieline.param:cao_tai_hop'), defVal: defHH, min: 0, max: 120 },
                                    { key: 'TRW', label: t('dieline.param:rong_ngam'), defVal: Math.round(params.L / 9), min: 0, max: Math.round(params.L / 4) },
                                    { key: 'SLH', label: t('dieline.param:sau_ranh'), defVal: 85, min: 50, max: 100 },
                                    { key: 'SLW', label: t('dieline.param:rong_ranh'), defVal: 3, min: 1, max: 10 },
                                ];
                                return gableParams.map((gp) => (
                                    <div key={gp.key} className="dt-param-cell">
                                        <label className="dt-param-cell-label">{tv(gp.label)}</label>
                                        <input
                                            type="number"
                                            defaultValue={params[gp.key] === 0 ? gp.defVal : params[gp.key] as number}
                                            key={`${gp.key}-${params[gp.key]}`}
                                            min={gp.min}
                                            max={gp.max}
                                            step={1}
                                            className="dt-param-input"
                                            style={{ textAlign: 'right' }}
                                            onBlur={(e) => {
                                                const v = parseFloat(e.target.value);
                                                if (!isNaN(v)) setParam(gp.key, v === gp.defVal ? 0 : v);
                                            }}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    const v = parseFloat((e.target as HTMLInputElement).value);
                                                    if (!isNaN(v)) setParam(gp.key, v === gp.defVal ? 0 : v);
                                                    (e.target as HTMLInputElement).blur();
                                                }
                                            }}
                                        />
                                        <span className="dt-param-cell-unit">{gp.key === 'SLH' ? '%' : 'mm'}</span>
                                    </div>
                                ));
                            })()}
                        </div>


                        {/* Kiểu mái + dạng/vị trí lỗ quai đã chuyển lên mục "Kiểu nắp & quai xách" */}
                    </div>
                )}
            </>)}

            {/* ─── Paper Bag Specific Params ─── */}
            {isPaperBag && (<>
                <button
                    className="dt-advanced-toggle"
                    onClick={() => setShowExtra(!showExtra)}
                >
                    {showExtra ? '▼' : '▶'} {t('dieline.param:thong_so_tui_giay')}
                </button>

                {showExtra && (
                    <div className="dt-params-section">
                        <div className="dt-param-grid">
                            {/* Handle Holes Toggle — [VARIANT 2026-07-29] túi có quai /
                                túi trơn là hai card riêng ⇒ ẩn công tắc khi đã chốt */}
                            {show('handleHoles') && (
                            <div className="dt-param-cell" style={{ cursor: 'pointer' }} onClick={() => setParam('handleHoles', !params.handleHoles)}>
                                <label className="dt-param-cell-label" style={{ cursor: 'pointer' }}>{t('dieline.param:lo_xo_day')}</label>
                                <input type="checkbox" checked={params.handleHoles as boolean} readOnly style={{ accentColor: 'var(--dt-accent)' }} />
                            </div>
                            )}

                            {/* BF */}
                            <div className="dt-param-cell">
                                <label className="dt-param-cell-label">{t('dieline.param:cao_day_bf')}</label>
                                <input
                                    type="number"
                                    defaultValue={params.BF === 0 ? Math.round(params.W * 0.85) : params.BF}
                                    key={`BF-${params.BF}`}
                                    min={0}
                                    max={Math.floor(params.D / 2)}
                                    step={1}
                                    className="dt-param-input"
                                    style={{ textAlign: 'right' }}
                                    onBlur={(e) => {
                                        const v = parseFloat(e.target.value);
                                        if (!isNaN(v)) setParam('BF', v === Math.round(params.W * 0.85) ? 0 : v);
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            const v = parseFloat((e.target as HTMLInputElement).value);
                                            if (!isNaN(v)) setParam('BF', v === Math.round(params.W * 0.85) ? 0 : v);
                                            (e.target as HTMLInputElement).blur();
                                        }
                                    }}
                                />
                                <span className="dt-param-cell-unit">mm</span>
                            </div>

                            {/* Handle Hole Params — only if handleHoles is on */}
                            {params.handleHoles && (<>
                                <div className="dt-param-cell">
                                    <label className="dt-param-cell-label">{t('dieline.param:lo_quai_hr')}</label>
                                    <input
                                        type="number"
                                        defaultValue={params.HR === 0 ? 2.5 : params.HR}
                                        key={`HR-${params.HR}`}
                                        min={1}
                                        max={10}
                                        step={0.5}
                                        className="dt-param-input"
                                        style={{ textAlign: 'right' }}
                                        onBlur={(e) => {
                                            const v = parseFloat(e.target.value);
                                            if (!isNaN(v)) setParam('HR', v === 2.5 ? 0 : v);
                                        }}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                const v = parseFloat((e.target as HTMLInputElement).value);
                                                if (!isNaN(v)) setParam('HR', v === 2.5 ? 0 : v);
                                                (e.target as HTMLInputElement).blur();
                                            }
                                        }}
                                    />
                                    <span className="dt-param-cell-unit">mm</span>
                                </div>
                                <div className="dt-param-cell">
                                    <label className="dt-param-cell-label">{t('dieline.param:cach_mep_tren_hm')}</label>
                                    <input
                                        type="number"
                                        defaultValue={params.HM === 0 ? 25 : params.HM}
                                        key={`HM-${params.HM}`}
                                        min={10}
                                        max={100}
                                        step={1}
                                        className="dt-param-input"
                                        style={{ textAlign: 'right' }}
                                        onBlur={(e) => {
                                            const v = parseFloat(e.target.value);
                                            if (!isNaN(v)) setParam('HM', v === 25 ? 0 : v);
                                        }}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                const v = parseFloat((e.target as HTMLInputElement).value);
                                                if (!isNaN(v)) setParam('HM', v === 25 ? 0 : v);
                                                (e.target as HTMLInputElement).blur();
                                            }
                                        }}
                                    />
                                    <span className="dt-param-cell-unit">mm</span>
                                </div>
                                <div className="dt-param-cell">
                                    <label className="dt-param-cell-label">{t('dieline.param:k_c_2_lo_hs')}</label>
                                    <input
                                        type="number"
                                        defaultValue={params.HS === 0 ? Math.round(params.L * 0.35) : params.HS}
                                        key={`HS-${params.HS}`}
                                        min={20}
                                        max={Math.max(40, params.L - 20)}
                                        step={1}
                                        className="dt-param-input"
                                        style={{ textAlign: 'right' }}
                                        onBlur={(e) => {
                                            const v = parseFloat(e.target.value);
                                            if (!isNaN(v)) setParam('HS', v === Math.round(params.L * 0.35) ? 0 : v);
                                        }}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                const v = parseFloat((e.target as HTMLInputElement).value);
                                                if (!isNaN(v)) setParam('HS', v === Math.round(params.L * 0.35) ? 0 : v);
                                                (e.target as HTMLInputElement).blur();
                                            }
                                        }}
                                    />
                                    <span className="dt-param-cell-unit">mm</span>
                                </div>
                            </>)}
                        </div>
                    </div>
                )}
            </>)}

            {/* ─── 3D Mockup Settings — GỘP 1 NƠI: tải ảnh + chỉnh transform/mask ─── */}
            <div className="dt-params-section" style={{ marginTop: '1rem', borderTop: '1px dashed var(--dt-border)', paddingTop: '1rem' }}>
                <label className="dt-section-label">{t('dieline.param:thiet_ke_3d_mockup')}</label>
                <p className="dt-param-desc" style={{ marginBottom: '0.5rem' }}>
                    {t('dieline.param:tai_anh_thiet_ke_jpeg_png_dan_len_mat')}
                </p>
                <MockupArtworkPanel />
            </div>

            {/* ─── [VARIANT 2026-07-29] Chế độ chuyên gia ───
                Mẫu khuôn chốt sẵn một số thuộc tính và ẩn chúng khỏi form để người
                dùng không phải mò. Công tắc này mở khoá lại TẤT CẢ — đường lùi để
                không tính năng nào bị mất so với bản trước, và để xử lý ca hiếm. */}
            {variant && Object.keys(variant.lockedParams).length > 0 && (
                <div className="dt-params-section" style={{ marginTop: '0.75rem' }}>
                    <div
                        className="dt-param-cell"
                        style={{ cursor: 'pointer' }}
                        onClick={() => setAdvancedMode(!isAdvancedMode)}
                    >
                        <label className="dt-param-cell-label" style={{ cursor: 'pointer' }}>
                            {t('dieline.param:tuy_chinh_nang_cao')}
                        </label>
                        <input
                            type="checkbox"
                            checked={isAdvancedMode}
                            readOnly
                            style={{ accentColor: 'var(--dt-accent)' }}
                        />
                    </div>
                    <p className="dt-param-desc">
                        {t('dieline.param:mo_khoa_thuoc_tinh_da_chot_cua_mau_khuon')}
                    </p>
                </div>
            )}
        </div>
    );
}
