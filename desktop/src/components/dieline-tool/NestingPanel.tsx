// ============================================================
// NestingPanel — Panel cấu hình xếp khuôn vào khổ in
// Hiển thị trong sidebar khi tab "Xếp khuôn" active
// ============================================================

import React from 'react';
import { useBoxStore } from '../../store/useBoxStore';
import { SHEET_PRESETS, RotationMode, TrayNestingMode } from '../../lib/dieline/nestingTypes';

export default function NestingPanel() {
    const { nestingConfig, nestingResult, sleeveNestingResult, setNestingConfig, params } = useBoxStore();
    const [customSheet, setCustomSheet] = React.useState(false);
    const [orderQty, setOrderQty] = React.useState(1000);

    // Check if current sheet matches a preset
    const currentPreset = SHEET_PRESETS.find(
        p => (p.width === nestingConfig.sheet.width && p.height === nestingConfig.sheet.height) ||
            (p.height === nestingConfig.sheet.width && p.width === nestingConfig.sheet.height)
    );

    const handlePresetChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const val = e.target.value;
        if (val === 'custom') {
            setCustomSheet(true);
            return;
        }
        setCustomSheet(false);
        const preset = SHEET_PRESETS[parseInt(val)];
        if (preset) {
            setNestingConfig({ sheet: { width: preset.width, height: preset.height } });
        }
    };

    // MISS-4: Tính số tờ cần cho đơn hàng
    const sheetsNeeded = nestingResult && nestingResult.countPerSheet > 0
        ? Math.ceil(orderQty / nestingResult.countPerSheet)
        : 0;
    const totalPrinted = sheetsNeeded * (nestingResult?.countPerSheet ?? 0);
    const waste = totalPrinted - orderQty;

    return (
        <div className="dt-param-panel">

            {/* Chế độ xếp khuôn */}
            <div className="dt-params-section">
                <label className="dt-section-label">🧠 Chế độ xếp</label>
                <div className="dt-glue-side-toggle">
                    <button
                        className={`dt-glue-side-btn ${nestingConfig.nestingMode === 'grid' ? 'active' : ''}`}
                        onClick={() => setNestingConfig({ nestingMode: 'grid' })}
                    >
                        ▦ Grid (lưới đều)
                    </button>
                    <button
                        className={`dt-glue-side-btn ${nestingConfig.nestingMode === 'smart' ? 'active' : ''}`}
                        onClick={() => setNestingConfig({ nestingMode: 'smart' })}
                    >
                        ✨ Xếp tối ưu
                    </button>
                </div>
            </div>

            {/* Chế độ chất liệu — chỉ hiện cho tray */}
            {params.boxType === 'tray' && (
                <div className="dt-params-section">
                    <label className="dt-section-label">🧵 Chất liệu khay & vỏ</label>
                    <div className="dt-glue-side-toggle">
                        <button
                            className={`dt-glue-side-btn ${nestingConfig.trayNestingMode === 'combined' ? 'active' : ''}`}
                            onClick={() => setNestingConfig({ trayNestingMode: 'combined' as TrayNestingMode })}
                        >
                            🟰 Cùng chất liệu
                        </button>
                        <button
                            className={`dt-glue-side-btn ${nestingConfig.trayNestingMode === 'split' ? 'active' : ''}`}
                            onClick={() => setNestingConfig({ trayNestingMode: 'split' as TrayNestingMode })}
                        >
                            ✂️ Khác chất liệu
                        </button>
                    </div>
                    <p className="dt-param-hint" style={{ fontSize: '0.65rem', opacity: 0.5, marginTop: '0.25rem' }}>
                        {nestingConfig.trayNestingMode === 'combined'
                            ? 'Khay và vỏ xếp chung trên 1 tờ'
                            : 'Khay và vỏ xếp riêng, khổ giấy độc lập'}
                    </p>
                </div>
            )}

            <div className="dt-params-section">
                <label className="dt-section-label">📋 Khổ giấy in</label>
                <select
                    className="dt-param-select"
                    value={customSheet ? 'custom' : (SHEET_PRESETS.findIndex(
                        p => (p.width === nestingConfig.sheet.width && p.height === nestingConfig.sheet.height) ||
                            (p.height === nestingConfig.sheet.width && p.width === nestingConfig.sheet.height)
                    ).toString())}
                    onChange={handlePresetChange}
                >
                    {SHEET_PRESETS.map((p, i) => (
                        <option key={i} value={i}>{p.name}</option>
                    ))}
                    <option value="custom">✏️ Tùy chỉnh...</option>
                </select>

                {/* Custom sheet size inputs */}
                {(customSheet || !currentPreset) && (
                    <div className="dt-param-grid" style={{ marginTop: '0.5rem' }}>
                        <div className="dt-param-cell">
                            <label className="dt-param-cell-label">Rộng</label>
                            <input
                                type="number"
                                defaultValue={nestingConfig.sheet.width}
                                key={`sw-${nestingConfig.sheet.width}`}
                                min={100} max={2000} step={1}
                                className="dt-param-input"
                                style={{ textAlign: 'right' }}
                                onBlur={(e) => {
                                    const v = parseFloat(e.target.value);
                                    if (!isNaN(v) && v > 0) setNestingConfig({ sheet: { ...nestingConfig.sheet, width: v } });
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        const v = parseFloat((e.target as HTMLInputElement).value);
                                        if (!isNaN(v) && v > 0) setNestingConfig({ sheet: { ...nestingConfig.sheet, width: v } });
                                        (e.target as HTMLInputElement).blur();
                                    }
                                }}
                            />
                            <span className="dt-param-cell-unit">mm</span>
                        </div>
                        <div className="dt-param-cell">
                            <label className="dt-param-cell-label">Cao</label>
                            <input
                                type="number"
                                defaultValue={nestingConfig.sheet.height}
                                key={`sh-${nestingConfig.sheet.height}`}
                                min={100} max={2000} step={1}
                                className="dt-param-input"
                                style={{ textAlign: 'right' }}
                                onBlur={(e) => {
                                    const v = parseFloat(e.target.value);
                                    if (!isNaN(v) && v > 0) setNestingConfig({ sheet: { ...nestingConfig.sheet, height: v } });
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        const v = parseFloat((e.target as HTMLInputElement).value);
                                        if (!isNaN(v) && v > 0) setNestingConfig({ sheet: { ...nestingConfig.sheet, height: v } });
                                        (e.target as HTMLInputElement).blur();
                                    }
                                }}
                            />
                            <span className="dt-param-cell-unit">mm</span>
                        </div>
                    </div>
                )}
            </div>

            {/* Khổ giấy vỏ bao — chỉ hiện khi split mode */}
            {params.boxType === 'tray' && nestingConfig.trayNestingMode === 'split' && (
                <div className="dt-params-section">
                    <label className="dt-section-label">📋 Khổ giấy vỏ bao</label>
                    <select
                        className="dt-param-select"
                        value={SHEET_PRESETS.findIndex(
                            p => (p.width === nestingConfig.sleeveSheet.width && p.height === nestingConfig.sleeveSheet.height) ||
                                (p.height === nestingConfig.sleeveSheet.width && p.width === nestingConfig.sleeveSheet.height)
                        ).toString()}
                        onChange={(e) => {
                            const idx = parseInt(e.target.value);
                            if (idx >= 0) {
                                const preset = SHEET_PRESETS[idx];
                                setNestingConfig({ sleeveSheet: { width: preset.width, height: preset.height } });
                            }
                        }}
                    >
                        {SHEET_PRESETS.map((p, i) => (
                            <option key={i} value={i}>{p.name}</option>
                        ))}
                        <option value="-1">✏️ Tùy chỉnh...</option>
                    </select>
                    <div className="dt-param-grid" style={{ marginTop: '0.5rem' }}>
                        <div className="dt-param-cell">
                            <label className="dt-param-cell-label">Rộng</label>
                            <input
                                type="number"
                                defaultValue={nestingConfig.sleeveSheet.width}
                                key={`ssw-${nestingConfig.sleeveSheet.width}`}
                                min={100} max={2000} step={1}
                                className="dt-param-input"
                                style={{ textAlign: 'right' }}
                                onBlur={(e) => {
                                    const v = parseFloat(e.target.value);
                                    if (!isNaN(v) && v > 0) setNestingConfig({ sleeveSheet: { ...nestingConfig.sleeveSheet, width: v } });
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        const v = parseFloat((e.target as HTMLInputElement).value);
                                        if (!isNaN(v) && v > 0) setNestingConfig({ sleeveSheet: { ...nestingConfig.sleeveSheet, width: v } });
                                        (e.target as HTMLInputElement).blur();
                                    }
                                }}
                            />
                            <span className="dt-param-cell-unit">mm</span>
                        </div>
                        <div className="dt-param-cell">
                            <label className="dt-param-cell-label">Cao</label>
                            <input
                                type="number"
                                defaultValue={nestingConfig.sleeveSheet.height}
                                key={`ssh-${nestingConfig.sleeveSheet.height}`}
                                min={100} max={2000} step={1}
                                className="dt-param-input"
                                style={{ textAlign: 'right' }}
                                onBlur={(e) => {
                                    const v = parseFloat(e.target.value);
                                    if (!isNaN(v) && v > 0) setNestingConfig({ sleeveSheet: { ...nestingConfig.sleeveSheet, height: v } });
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        const v = parseFloat((e.target as HTMLInputElement).value);
                                        if (!isNaN(v) && v > 0) setNestingConfig({ sleeveSheet: { ...nestingConfig.sleeveSheet, height: v } });
                                        (e.target as HTMLInputElement).blur();
                                    }
                                }}
                            />
                            <span className="dt-param-cell-unit">mm</span>
                        </div>
                    </div>
                </div>
            )}

            {/* Ràng buộc máy in */}
            <div className="dt-params-section">
                <label className="dt-section-label">🏭 Ràng buộc máy in</label>
                <div className="dt-param-grid">
                    <div className="dt-param-cell">
                        <label className="dt-param-cell-label" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer' }}
                            onClick={() => setNestingConfig({ gripperMargin: nestingConfig.gripperMargin > 0 ? 0 : 12 })}
                        >
                            <span style={{
                                display: 'inline-block', width: 14, height: 14, borderRadius: 3,
                                border: '2px solid var(--dt-accent, #f97316)',
                                background: nestingConfig.gripperMargin > 0 ? 'var(--dt-accent, #f97316)' : 'transparent',
                                transition: 'background 0.15s',
                            }} />
                            🔴 Cắn nhíp
                        </label>
                        {nestingConfig.gripperMargin > 0 && (
                            <>
                                <input type="number" defaultValue={nestingConfig.gripperMargin}
                                    key={`gm-${nestingConfig.gripperMargin}`}
                                    min={8} max={20} step={1}
                                    className="dt-param-input" style={{ textAlign: 'right' }}
                                    onBlur={(e) => {
                                        const v = parseFloat(e.target.value);
                                        if (!isNaN(v) && v >= 0) setNestingConfig({ gripperMargin: v });
                                    }}
                                    onKeyDown={(e) => { if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); } }}
                                />
                                <span className="dt-param-cell-unit">mm</span>
                            </>
                        )}
                    </div>
                    <div className="dt-param-cell">
                        <label className="dt-param-cell-label">🔪 Hở dao bế</label>
                        <input type="number" defaultValue={nestingConfig.dieGap}
                            key={`dg-${nestingConfig.dieGap}`}
                            min={2} max={8} step={0.5}
                            className="dt-param-input" style={{ textAlign: 'right' }}
                            onBlur={(e) => {
                                const v = parseFloat(e.target.value);
                                if (!isNaN(v) && v >= 0) setNestingConfig({ dieGap: v });
                            }}
                            onKeyDown={(e) => { if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); } }}
                        />
                        <span className="dt-param-cell-unit">mm</span>
                    </div>
                </div>
            </div>

            {/* Lề tay kê — 4 cạnh */}
            <div className="dt-params-section">
                <label className="dt-section-label">📏 Lề tay kê</label>
                <div className="dt-param-grid">
                    <div className="dt-param-cell">
                        <label className="dt-param-cell-label">Trên</label>
                        <input type="number" defaultValue={nestingConfig.margin.top}
                            key={`mt-${nestingConfig.margin.top}`}
                            min={0} max={50} step={1}
                            className="dt-param-input" style={{ textAlign: 'right' }}
                            onBlur={(e) => {
                                const v = parseFloat(e.target.value);
                                if (!isNaN(v)) setNestingConfig({ margin: { ...nestingConfig.margin, top: v } });
                            }}
                            onKeyDown={(e) => { if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); } }}
                        />
                        <span className="dt-param-cell-unit">mm</span>
                    </div>
                    {/* BUG-5 FIX: Thêm lề dưới input */}
                    <div className="dt-param-cell">
                        <label className="dt-param-cell-label">Dưới</label>
                        <input type="number" defaultValue={nestingConfig.margin.bottom}
                            key={`mb-${nestingConfig.margin.bottom}`}
                            min={0} max={50} step={1}
                            className="dt-param-input" style={{ textAlign: 'right' }}
                            onBlur={(e) => {
                                const v = parseFloat(e.target.value);
                                if (!isNaN(v)) setNestingConfig({ margin: { ...nestingConfig.margin, bottom: v } });
                            }}
                            onKeyDown={(e) => { if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); } }}
                        />
                        <span className="dt-param-cell-unit">mm</span>
                    </div>
                    <div className="dt-param-cell">
                        <label className="dt-param-cell-label">Trái</label>
                        <input type="number" defaultValue={nestingConfig.margin.left}
                            key={`ml-${nestingConfig.margin.left}`}
                            min={0} max={50} step={1}
                            className="dt-param-input" style={{ textAlign: 'right' }}
                            onBlur={(e) => {
                                const v = parseFloat(e.target.value);
                                if (!isNaN(v)) setNestingConfig({ margin: { ...nestingConfig.margin, left: v } });
                            }}
                            onKeyDown={(e) => { if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); } }}
                        />
                        <span className="dt-param-cell-unit">mm</span>
                    </div>
                    <div className="dt-param-cell">
                        <label className="dt-param-cell-label">Phải</label>
                        <input type="number" defaultValue={nestingConfig.margin.right}
                            key={`mr-${nestingConfig.margin.right}`}
                            min={0} max={50} step={1}
                            className="dt-param-input" style={{ textAlign: 'right' }}
                            onBlur={(e) => {
                                const v = parseFloat(e.target.value);
                                if (!isNaN(v)) setNestingConfig({ margin: { ...nestingConfig.margin, right: v } });
                            }}
                            onKeyDown={(e) => { if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); } }}
                        />
                        <span className="dt-param-cell-unit">mm</span>
                    </div>
                </div>
                <p className="dt-param-hint" style={{ fontSize: '0.65rem', opacity: 0.5, marginTop: '0.25rem' }}>
                    Lề dưới ≥ cắn nhíp sẽ được tự động điều chỉnh
                </p>
            </div>

            {/* Chế độ xoay — chỉ hiện cho grid mode */}
            {nestingConfig.nestingMode === 'grid' && (
                <div className="dt-params-section">
                    <label className="dt-section-label">🔄 Chế độ xoay</label>
                    <select
                        className="dt-param-select"
                        value={nestingConfig.rotation}
                        onChange={(e) => setNestingConfig({ rotation: e.target.value as RotationMode })}
                    >
                        <option value="none">— Không xoay</option>
                        <option value="90">↰ Xoay 90°</option>
                        <option value="auto">✨ Tự động</option>
                    </select>
                </div>
            )}

            {/* Hướng tờ giấy */}
            <div className="dt-params-section">
                <label className="dt-section-label">📄 Hướng giấy</label>
                <div className="dt-glue-side-toggle">
                    <button
                        className={`dt-glue-side-btn ${nestingConfig.sheetOrientation === 'portrait' ? 'active' : ''}`}
                        onClick={() => setNestingConfig({ sheetOrientation: 'portrait' })}
                    >
                        ▯ Dọc
                    </button>
                    <button
                        className={`dt-glue-side-btn ${nestingConfig.sheetOrientation === 'landscape' || nestingConfig.sheetOrientation === 'auto' ? 'active' : ''}`}
                        onClick={() => setNestingConfig({ sheetOrientation: 'landscape' })}
                    >
                        ▭ Ngang
                    </button>
                </div>
            </div>

            {/* Kết quả */}
            {nestingResult && (
                <div className="dt-nesting-result">
                    <label className="dt-section-label">
                        📊 {params.boxType === 'tray' && nestingConfig.trayNestingMode === 'split'
                            ? 'Khay'
                            : 'Kết quả xếp khuôn'}
                    </label>
                    <div className="dt-nesting-stats">
                        <div className="dt-nesting-stat-main">
                            <span className="dt-nesting-stat-value">{nestingResult.countPerSheet}</span>
                            <span className="dt-nesting-stat-label">khuôn / tờ</span>
                        </div>
                        <div className="dt-nesting-stat-row">
                            <span>Bố cục:</span>
                            <span>{nestingResult.cols} × {nestingResult.rows}</span>
                        </div>
                        <div className="dt-nesting-stat-row">
                            <span>% sử dụng:</span>
                            <span style={{
                                color: nestingResult.utilization > 70 ? 'var(--dt-success, #22c55e)' :
                                    nestingResult.utilization > 50 ? 'var(--dt-warning, #eab308)' :
                                        'var(--dt-error, #ef4444)'
                            }}>
                                {nestingResult.utilization}%
                            </span>
                        </div>
                        <div className="dt-nesting-stat-row">
                            <span>Tờ giấy:</span>
                            <span>{nestingResult.actualSheet.width} × {nestingResult.actualSheet.height} mm</span>
                        </div>

                    </div>
                </div>
            )}

            {/* Kết quả riêng cho vỏ bao (split mode) */}
            {sleeveNestingResult && nestingConfig.trayNestingMode === 'split' && (
                <div className="dt-nesting-result" style={{ borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '0.5rem' }}>
                    <label className="dt-section-label">📊 Vỏ bao ({nestingConfig.sleeveSheet.width}×{nestingConfig.sleeveSheet.height})</label>
                    <div className="dt-nesting-stats">
                        <div className="dt-nesting-stat-main">
                            <span className="dt-nesting-stat-value">{sleeveNestingResult.countPerSheet}</span>
                            <span className="dt-nesting-stat-label">vỏ / tờ</span>
                        </div>
                        <div className="dt-nesting-stat-row">
                            <span>Bố cục:</span>
                            <span>{sleeveNestingResult.cols} × {sleeveNestingResult.rows}</span>
                        </div>
                        <div className="dt-nesting-stat-row">
                            <span>% sử dụng:</span>
                            <span style={{
                                color: sleeveNestingResult.utilization > 70 ? 'var(--dt-success, #22c55e)' :
                                    sleeveNestingResult.utilization > 50 ? 'var(--dt-warning, #eab308)' :
                                        'var(--dt-error, #ef4444)'
                            }}>
                                {sleeveNestingResult.utilization}%
                            </span>
                        </div>
                    </div>
                </div>
            )}

            {/* MISS-4: Ước lượng số tờ cho đơn hàng */}
            {nestingResult && nestingResult.countPerSheet > 0 && (
                <div className="dt-params-section">
                    <label className="dt-section-label">🧮 Ước lượng đơn hàng</label>
                    <div className="dt-param-grid">
                        <div className="dt-param-cell" style={{ gridColumn: '1 / -1' }}>
                            <label className="dt-param-cell-label">Số lượng hộp</label>
                            <input type="number"
                                value={orderQty}
                                min={1} max={1000000} step={100}
                                className="dt-param-input" style={{ textAlign: 'right' }}
                                onChange={(e) => {
                                    const v = parseInt(e.target.value);
                                    if (!isNaN(v) && v > 0) setOrderQty(v);
                                }}
                            />
                            <span className="dt-param-cell-unit">hộp</span>
                        </div>
                    </div>
                    <div className="dt-nesting-stats" style={{ marginTop: '0.5rem' }}>
                        <div className="dt-nesting-stat-row">
                            <span>Số tờ cần:</span>
                            <span style={{ fontWeight: 700, color: 'var(--dt-accent)' }}>
                                {sheetsNeeded.toLocaleString()} tờ
                            </span>
                        </div>
                        <div className="dt-nesting-stat-row">
                            <span>Tổng in:</span>
                            <span>{totalPrinted.toLocaleString()} hộp</span>
                        </div>
                        {waste > 0 && (
                            <div className="dt-nesting-stat-row">
                                <span>Dư thừa:</span>
                                <span style={{ color: 'var(--dt-warning, #eab308)' }}>
                                    +{waste.toLocaleString()} hộp ({Math.round(waste / totalPrinted * 100)}%)
                                </span>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
