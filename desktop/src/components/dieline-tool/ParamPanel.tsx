// ============================================================
// ParamPanel — Bảng nhập thông số hộp
// Sliders + numeric inputs với debounce 150ms
// ============================================================

import React from 'react';
import { useBoxStore } from '../../store/useBoxStore';
import { BoxParams } from '../../lib/dieline/types';


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


export default function ParamPanel() {
    const { params, setParam, setParams, dieline, clampVersion, mockupTextureUrl, setMockupTextureUrl } = useBoxStore();
    const [showAdvanced, setShowAdvanced] = React.useState(false);
    const [showExtra, setShowExtra] = React.useState(false);

    // Cảnh báo hiển thị được dẫn xuất DUY NHẤT từ model.warnings (Requirement 3.4)
    const snapLockWarning = dieline?.warnings && dieline.warnings.length > 0
        ? dieline.warnings.join('. ')
        : null;




    const isRTE = params.boxType === 'rte';
    const isSLB = params.boxType === 'slb';
    const isGable = params.boxType === 'gable';
    const isPaperBag = params.boxType === 'paper_bag';
    const isCupSleeve = params.boxType === 'cup_sleeve';
    const isPizza = params.boxType === 'pizza';
    const isEnvelope = params.boxType === 'envelope';
    const isTray = params.boxType === 'tray';
    const isBox = isRTE || isSLB || isGable || isPizza || isTray; // Traditional box types


    return (
        <div className="dt-param-panel">


            {/* Box Type Selector */}
            <div className="dt-box-type-section">
                <label className="dt-section-label">Loại khuôn</label>
                <select
                    className="dt-param-select"
                    value={params.boxType}
                    onChange={(e) => setParam('boxType', e.target.value as BoxParams['boxType'])}
                >
                    <option value="rte">📦 Hộp nắp cài sole</option>
                    <option value="slb">🔒 Hộp đáy gài</option>
                    <option value="gable">🏠 Hộp quai xách</option>
                    <option value="paper_bag">🛍️ Túi giấy</option>
                    <option value="cup_sleeve">🥤 Bọc ly</option>
                    <option value="pizza">🍕 Hộp pizza</option>
                    <option value="envelope">✉️ Bì thư</option>
                    <option value="tray">🗃️ Hộp diêm / Khay</option>
                </select>
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
                        <label className="dt-param-label">Vị trí tai dán (G)</label>
                    </div>
                    <div className="dt-glue-side-toggle">
                        <button
                            className={`dt-glue-side-btn ${params.glueSide === 'left' ? 'active' : ''}`}
                            onClick={() => setParam('glueSide', 'left')}
                        >
                            ◀ Trái
                        </button>
                        <button
                            className={`dt-glue-side-btn ${params.glueSide === 'right' ? 'active' : ''}`}
                            onClick={() => setParam('glueSide', 'right')}
                        >
                            Phải ▶
                        </button>
                    </div>
                    <p className="dt-param-desc">Tai dán keo nằm bên trái hoặc phải khuôn</p>
                </div>
            )}

            {/* Panel Order Toggle */}
            {(isBox || isPaperBag) && !isCupSleeve && !isPizza && !isEnvelope && !isTray && (<>
                <div className="dt-param-slider">
                    <div className="dt-param-header">
                        <label className="dt-param-label">Thứ tự mặt</label>
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
                    <p className="dt-param-desc">Hông trước (WLWL) hay Mặt chính trước (LWLW)</p>
                </div>
            </>)}

            {/* ─── Cup Sleeve Params ─── */}
            {isCupSleeve && (
                <div className="dt-params-section">
                    <label className="dt-section-label">Thông số ly</label>
                    <div className="dt-param-grid">
                        {[
                            { key: 'cupD1' as const, label: '⌀ Đáy (D1)', min: 30, max: 200, step: 1 },
                            { key: 'cupD2' as const, label: '⌀ Miệng (D2)', min: 40, max: 250, step: 1 },
                            { key: 'cupH' as const, label: 'Cao (H)', min: 20, max: 300, step: 1 },
                            { key: 'G' as const, label: 'Mí dán (G)', min: 0, max: 30, step: 1 },
                        ].map((cfg) => (
                            <div key={cfg.key} className="dt-param-cell">
                                <label className="dt-param-cell-label">{cfg.label}</label>
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
                            <label className="dt-param-cell-label">% Bao phủ</label>
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
                            <label className="dt-param-label">Loại chiều cao</label>
                        </div>
                        <div className="dt-glue-side-toggle">
                            <button
                                className={`dt-glue-side-btn ${params.cupHeightType === 'slant' ? 'active' : ''}`}
                                onClick={() => setParam('cupHeightType', 'slant')}
                            >
                                Chiều nghiêng
                            </button>
                            <button
                                className={`dt-glue-side-btn ${params.cupHeightType === 'vertical' ? 'active' : ''}`}
                                onClick={() => setParam('cupHeightType', 'vertical')}
                            >
                                Chiều thẳng đứng
                            </button>
                        </div>
                    </div>
                    <div className="dt-param-slider" style={{ marginTop: '0.5rem' }}>
                        <div className="dt-param-header">
                            <label className="dt-param-label">Vị trí vạt dán</label>
                        </div>
                        <div className="dt-glue-side-toggle">
                            <button
                                className={`dt-glue-side-btn ${params.cupFlapPosition === 'right' ? 'active' : ''}`}
                                onClick={() => setParam('cupFlapPosition', 'right')}
                            >
                                Bên phải
                            </button>
                            <button
                                className={`dt-glue-side-btn ${params.cupFlapPosition === 'left' ? 'active' : ''}`}
                                onClick={() => setParam('cupFlapPosition', 'left')}
                            >
                                Bên trái
                            </button>
                            <button
                                className={`dt-glue-side-btn ${params.cupFlapPosition === 'none' ? 'active' : ''}`}
                                onClick={() => setParam('cupFlapPosition', 'none')}
                            >
                                Không có
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ─── Envelope Params ─── */}
            {isEnvelope && (
                <div className="dt-params-section">
                    <label className="dt-section-label">Kích thước có sẵn</label>
                    <select
                        className="dt-param-select"
                        style={{ marginBottom: '0.75rem' }}
                        value={
                            [
                                { label: '12×22 (nắp 30)', w: 220, h: 120, fh: 30, style: 'wallet' as const },
                                { label: '16×23 (nắp 30)', w: 230, h: 160, fh: 30, style: 'wallet' as const },
                                { label: '11×19 (nắp 25)', w: 190, h: 110, fh: 25, style: 'wallet' as const },
                                { label: '25×34 (nắp 30)', w: 340, h: 250, fh: 30, style: 'pocket' as const },
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
                        <option value={-1}>Tùy chỉnh</option>
                        <option value={0}>12×22 cm — nắp 3cm (Ngang)</option>
                        <option value={1}>16×23 cm — nắp 3cm (Ngang)</option>
                        <option value={2}>11×19 cm — nắp 2.5cm (Ngang)</option>
                        <option value={3}>25×34 cm — nắp 3cm (Dọc)</option>
                    </select>

                    <label className="dt-section-label">Kích thước tùy chỉnh</label>
                    <div className="dt-param-grid">
                        {(() => {
                            const flapRef = params.envH; // Cả ngang lẫn dọc đều dùng envH làm flapRef
                            const autoFH = params.envFlapShape === 'straight' ? 30 : Math.round(flapRef * 0.45);
                            const autoSF = Math.max(10, Math.min(15, Math.round(flapRef * 0.12)));
                            return [
                                { key: 'envW' as const, label: 'Rộng (W)', min: 80, max: 500, step: 1 },
                                { key: 'envH' as const, label: 'Cao (H)', min: 50, max: 400, step: 1 },
                                { key: 'envFH' as const, label: 'Nắp dán (FH)', min: 0, max: 200, step: 1 },
                                { key: 'envSF' as const, label: 'Tai hông (SF)', min: 0, max: 100, step: 1 },
                                { key: 'T' as const, label: 'Dày (T)', min: 0.2, max: 3, step: 0.05 },
                            ].map((cfg) => {
                                const rawVal = params[cfg.key] as number;
                                const isAuto = (cfg.key === 'envFH' || cfg.key === 'envSF') && rawVal === 0;
                                const displayVal = isAuto ? (cfg.key === 'envFH' ? autoFH : autoSF) : rawVal;
                                return (
                                    <div key={cfg.key} className="dt-param-cell">
                                        <label className="dt-param-cell-label">{cfg.label}</label>
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

                    {/* Flap Shape */}
                    <div className="dt-param-slider" style={{ marginTop: '0.5rem' }}>
                        <div className="dt-param-header">
                            <label className="dt-param-label">Dạng nắp dán</label>
                        </div>
                        <div className="dt-glue-side-toggle">
                            <button
                                className={`dt-glue-side-btn ${params.envFlapShape === 'pointed' ? 'active' : ''}`}
                                onClick={() => setParam('envFlapShape', 'pointed')}
                            >
                                △ Nhọn
                            </button>
                            <button
                                className={`dt-glue-side-btn ${params.envFlapShape === 'rounded' ? 'active' : ''}`}
                                onClick={() => setParam('envFlapShape', 'rounded')}
                            >
                                ◠ Tròn
                            </button>
                            <button
                                className={`dt-glue-side-btn ${params.envFlapShape === 'straight' ? 'active' : ''}`}
                                onClick={() => setParam('envFlapShape', 'straight')}
                            >
                                ▭ Thẳng
                            </button>
                        </div>
                    </div>

                    {/* Envelope Style */}
                    <div className="dt-param-slider" style={{ marginTop: '0.5rem' }}>
                        <div className="dt-param-header">
                            <label className="dt-param-label">Kiểu bì thư</label>
                        </div>
                        <div className="dt-glue-side-toggle">
                            <button
                                className={`dt-glue-side-btn ${params.envStyle === 'wallet' ? 'active' : ''}`}
                                onClick={() => setParam('envStyle', 'wallet')}
                            >
                                Ngang
                            </button>
                            <button
                                className={`dt-glue-side-btn ${params.envStyle === 'pocket' ? 'active' : ''}`}
                                onClick={() => setParam('envStyle', 'pocket')}
                            >
                                Dọc
                            </button>
                        </div>
                        <p className="dt-param-desc">Ngang (phổ biến) hoặc Dọc (mặt trước/sau trái-phải)</p>
                    </div>

                    {/* Window Toggle */}
                    <div className="dt-param-slider" style={{ marginTop: '0.5rem' }}>
                        <div className="dt-param-cell" style={{ cursor: 'pointer' }} onClick={() => setParam('envWindow', !params.envWindow)}>
                            <label className="dt-param-cell-label" style={{ cursor: 'pointer' }}>Cửa sổ trong suốt</label>
                            <input type="checkbox" checked={params.envWindow as boolean} readOnly style={{ accentColor: 'var(--dt-accent)' }} />
                        </div>
                    </div>

                    {/* Window Dimensions */}
                    {
                        params.envWindow && (
                            <div className="dt-param-grid" style={{ marginTop: '0.25rem' }}>
                                {[
                                    { key: 'envWindowW' as const, label: 'Rộng cửa sổ', min: 10, max: 300 },
                                    { key: 'envWindowH' as const, label: 'Cao cửa sổ', min: 10, max: 200 },
                                    { key: 'envWindowX' as const, label: 'Cách trái (X)', min: 5, max: 400 },
                                    { key: 'envWindowY' as const, label: 'Cách dưới (Y)', min: 5, max: 300 },
                                ].map((cfg) => (
                                    <div key={cfg.key} className="dt-param-cell">
                                        <label className="dt-param-cell-label">{cfg.label}</label>
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
                    <label className="dt-section-label">Kích thước chính</label>
                    <p className="dt-param-desc" style={{ marginBottom: '0.5rem', opacity: 0.7 }}>
                        L = Dài · W = Rộng · D = Cao vách · G = Dầm · TH = Mí gập · Mí vỏ = Mí dán vỏ bao
                    </p>
                    <div className="dt-param-grid">
                        {[
                            { key: 'L' as const, label: 'Dài (L)', min: 30, max: 500, step: 1 },
                            { key: 'W' as const, label: 'Rộng (W)', min: 20, max: 400, step: 1 },
                            { key: 'D' as const, label: 'Cao vách (D)', min: 10, max: 200, step: 1 },
                            { key: 'T' as const, label: 'Dày giấy (T)', min: 0.2, max: 3, step: 0.05 },
                            { key: 'G' as const, label: 'Dầm (G)', min: 3, max: 30, step: 1 },
                            { key: 'TH' as const, label: 'Mí gập (TH)', min: 5, max: 40, step: 1 },
                            { key: 'sleeveGlue' as const, label: 'Mí dán vỏ', min: 5, max: 30, step: 1 },
                        ].map((cfg) => (
                            <div key={cfg.key} className="dt-param-cell">
                                <label className="dt-param-cell-label">{cfg.label}</label>
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
            {!isCupSleeve && !isEnvelope && !isTray && (
                <div className="dt-params-section">
                    <label className="dt-section-label">Kích thước chính</label>
                    <p className="dt-param-desc" style={{ marginBottom: '0.5rem', opacity: 0.7 }}>
                        {isPaperBag ? 'L = Rộng mặt · W = Rộng hông · D = Cao thân túi' : 'L = Dài · W = Rộng · D = Cao'}
                    </p>
                    <div className="dt-param-grid">
                        {MAIN_PARAMS.map((cfg) => (
                            <div key={cfg.key} className="dt-param-cell">
                                <label className="dt-param-cell-label">{cfg.label}</label>
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

            {/* Advanced Toggle — not for cup sleeve */}
            {!isCupSleeve && !isEnvelope && !isTray && (
                <button
                    className="dt-advanced-toggle"
                    onClick={() => setShowAdvanced(!showAdvanced)}
                >
                    {showAdvanced ? '▼' : '▶'} Thông số nâng cao
                </button>
            )}

            {showAdvanced && (
                <div className="dt-params-section">
                    <div className="dt-param-grid">
                        {(isPaperBag
                            ? [
                                { key: 'C' as const, label: 'Dung sai (C)', min: 0.2, max: 2, step: 0.1, unit: 'mm' },
                                { key: 'G' as const, label: 'Mép keo (G)', min: 8, max: 25, step: 1, unit: 'mm' },
                                { key: 'TH' as const, label: 'Mí gập miệng', min: 0, max: 80, step: 1, unit: 'mm' },
                            ]
                            : isGable
                                ? ADVANCED_PARAMS.filter(p => p.key !== 'TH') // Gable không có tai đút
                                : ADVANCED_PARAMS
                        ).map((cfg) => (
                            <div key={cfg.key} className="dt-param-cell">
                                <label className="dt-param-cell-label">{cfg.label}</label>
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

                    {/* Dust Flap Height — chỉ hiện cho RTE, SLB (có tai bụi) */}
                    {(isRTE || isSLB) && (() => {
                        const defDFH = Math.round(Math.min(params.L / 2 - 1, params.W + params.T));
                        return (
                            <div className="dt-param-grid" style={{ marginTop: '0.25rem' }}>
                                <div className="dt-param-cell">
                                    <label className="dt-param-cell-label">Cao tai bụi (DFH)</label>
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

            {(isSLB || isGable) && (<>
                <button
                    className="dt-advanced-toggle"
                    onClick={() => setShowExtra(!showExtra)}
                >
                    {showExtra ? '▼' : '▶'} Thông số đáy & nắp
                </button>

                {showExtra && (
                    <div className="dt-params-section">
                        <div className="dt-param-grid">
                            {/* SLP Input */}
                            <div className="dt-param-cell">
                                <label className="dt-param-cell-label">Số cặp đáy</label>
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
                            </div>

                            {/* Lock Tab Toggle + Params — chỉ SLB */}
                            {isSLB && (
                                <div className="dt-param-cell" style={{ cursor: 'pointer' }} onClick={() => setParam('lockTab', !params.lockTab)}>
                                    <label className="dt-param-cell-label" style={{ cursor: 'pointer' }}>Lưỡi khóa nắp</label>
                                    <input type="checkbox" checked={params.lockTab as boolean} readOnly style={{ accentColor: 'var(--dt-accent)' }} />
                                </div>
                            )}
                            {isSLB && params.lockTab && (() => {
                                const lockParams: { key: 'LTW' | 'LTH'; label: string; min: number; max: number }[] = [
                                    { key: 'LTW', label: 'Rộng lưỡi khóa', min: 5, max: 40 },
                                    { key: 'LTH', label: 'Cao lưỡi khóa', min: 5, max: 40 },
                                ];
                                return lockParams.map((lp) => (
                                    <div key={lp.key} className="dt-param-cell">
                                        <label className="dt-param-cell-label">{lp.label}</label>
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

                            {/* Gable Params (HH, HW, HHL) */}
                            {isGable && (() => {
                                const h1 = Math.round(params.W / 2);
                                const h2 = Math.round(0.9 * h1);
                                const defHH = h1 + h2;
                                const defHW = Math.round(2 / 5 * params.L);
                                const defHHL = Math.round(h2 / 2);
                                const gableParams: { key: 'HH' | 'HW' | 'HHL' | 'HFH' | 'SLW' | 'SLH' | 'TRW'; label: string; defVal: number; min: number; max: number }[] = [
                                    { key: 'HH', label: 'Cao tai hộp', defVal: defHH, min: 0, max: 120 },
                                    { key: 'HFH', label: 'Cao tay cầm', defVal: Math.round(0.9 * h1), min: 0, max: 100 },
                                    { key: 'HW', label: 'Rộng lỗ quai', defVal: defHW, min: 0, max: Math.max(20, params.L - 20) },
                                    { key: 'HHL', label: 'Cao lỗ quai', defVal: defHHL, min: 0, max: 60 },
                                    { key: 'SLW', label: 'Rộng rãnh', defVal: 3, min: 1, max: 10 },
                                    { key: 'SLH', label: 'Sâu rãnh (%)', defVal: 85, min: 50, max: 100 },
                                    { key: 'TRW', label: 'Rộng ngàm', defVal: Math.round(params.L / 9), min: 0, max: Math.round(params.L / 4) },
                                ];
                                return gableParams.map((gp) => (
                                    <div key={gp.key} className="dt-param-cell">
                                        <label className="dt-param-cell-label">{gp.label}</label>
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


                        {isGable && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
                                <div className="dt-param-slider">
                                    <div className="dt-param-header">
                                        <label className="dt-param-label">Kiểu mái</label>
                                    </div>
                                    <div className="dt-glue-side-toggle">
                                        <button
                                            className={`dt-glue-side-btn ${params.gableStyle === 'flat' ? 'active' : ''}`}
                                            onClick={() => setParam('gableStyle', 'flat')}
                                        >
                                            Mái bằng
                                        </button>
                                        <button
                                            className={`dt-glue-side-btn ${params.gableStyle === 'pitched' ? 'active' : ''}`}
                                            onClick={() => setParam('gableStyle', 'pitched')}
                                        >
                                            Mái dốc
                                        </button>
                                    </div>
                                </div>

                                <div className="dt-param-slider">
                                    <div className="dt-param-header">
                                        <label className="dt-param-label">Dạng lỗ quai</label>
                                    </div>
                                    <div className="dt-glue-side-toggle">
                                        <button
                                            className={`dt-glue-side-btn ${params.handleShape === 'oval' ? 'active' : ''}`}
                                            onClick={() => setParam('handleShape', 'oval')}
                                        >
                                            ⬭ Oval
                                        </button>
                                        <button
                                            className={`dt-glue-side-btn ${params.handleShape === 'roundRect' ? 'active' : ''}`}
                                            onClick={() => setParam('handleShape', 'roundRect')}
                                        >
                                            ▢ Bo tròn
                                        </button>
                                    </div>
                                </div>

                                <div className="dt-param-slider">
                                    <div className="dt-param-header">
                                        <label className="dt-param-label">Vị trí lỗ</label>
                                    </div>
                                    <div className="dt-glue-side-toggle">
                                        <button
                                            className={`dt-glue-side-btn ${params.handleY === 'bottom' ? 'active' : ''}`}
                                            onClick={() => setParam('handleY', 'bottom')}
                                        >
                                            Sát đáy
                                        </button>
                                        <button
                                            className={`dt-glue-side-btn ${params.handleY === 'center' ? 'active' : ''}`}
                                            onClick={() => setParam('handleY', 'center')}
                                        >
                                            Giữa
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </>)}

            {/* ─── Paper Bag Specific Params ─── */}
            {isPaperBag && (<>
                <button
                    className="dt-advanced-toggle"
                    onClick={() => setShowExtra(!showExtra)}
                >
                    {showExtra ? '▼' : '▶'} Thông số túi giấy
                </button>

                {showExtra && (
                    <div className="dt-params-section">
                        <div className="dt-param-grid">
                            {/* Handle Holes Toggle */}
                            <div className="dt-param-cell" style={{ cursor: 'pointer' }} onClick={() => setParam('handleHoles', !params.handleHoles)}>
                                <label className="dt-param-cell-label" style={{ cursor: 'pointer' }}>Lỗ xỏ dây</label>
                                <input type="checkbox" checked={params.handleHoles as boolean} readOnly style={{ accentColor: 'var(--dt-accent)' }} />
                            </div>

                            {/* BF */}
                            <div className="dt-param-cell">
                                <label className="dt-param-cell-label">Cao đáy (BF)</label>
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
                                    <label className="dt-param-cell-label">⌀ Lỗ quai (HR)</label>
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
                                    <label className="dt-param-cell-label">Cách mép trên (HM)</label>
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
                                    <label className="dt-param-cell-label">K/c 2 lỗ (HS)</label>
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

            {/* ─── 3D Mockup Settings ─── */}
            <div className="dt-params-section" style={{ marginTop: '1rem', borderTop: '1px dashed var(--dt-border)', paddingTop: '1rem' }}>
                <label className="dt-section-label">🎨 Thiết kế 3D (Mockup)</label>
                <p className="dt-param-desc" style={{ marginBottom: '0.75rem' }}>
                    Tải ảnh thiết kế (JPEG/PNG) để dán lên mặt ngoài của hộp.
                </p>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <label className="dt-glue-side-btn active" style={{ cursor: 'pointer', textAlign: 'center', flex: 1 }}>
                        🖼️ Tải ảnh lên
                        <input
                            type="file"
                            accept="image/png, image/jpeg, image/webp"
                            style={{ display: 'none' }}
                            onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) {
                                    const url = URL.createObjectURL(file);
                                    setMockupTextureUrl(url);
                                }
                            }}
                        />
                    </label>
                    {mockupTextureUrl && (
                        <button
                            className="dt-glue-side-btn"
                            onClick={() => setMockupTextureUrl(null)}
                            style={{ flex: '0 0 auto', padding: '0.5rem', color: 'var(--dt-danger)' }}
                            title="Xoá ảnh mockup"
                        >
                            ✖
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
