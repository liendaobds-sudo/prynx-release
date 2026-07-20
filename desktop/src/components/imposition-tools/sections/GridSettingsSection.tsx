import React from "react";
import { createPortal } from "react-dom";
import { RichSelect, SectionLabel, Divider, inputCls } from "../SharedUI";
import { useImposerSettingsStore } from "../useImposerSettingsStore";
import { useShallow } from "zustand/react/shallow";
import { useAppSettingsStore } from "../../../stores/appSettingsStore";
import { parsePastedQuantities } from "../../../lib/parsePastedQuantities";
import { useTranslation } from 'react-i18next';

export interface GridSettingsProps {
  taskMode: string;
  setTaskMode: (v: string) => void;
  activeTool: string;
  duplexFlow: string;
  setDuplexFlow: (v: string) => void;
  gridStrategy: string;
  setGridStrategy: (v: string) => void;

  targetQuantity: number;
  setTargetQuantity: (v: number) => void;
  targetQuantitiesByPage: Record<number, number>;
  setTargetQuantitiesByPage: (v: Record<number, number>) => void;
  previewCapacity?: number;
  previewCapacities?: Record<number, number>;
  mixedPlacedByPage?: Record<number, number>;
  sourceTotalPages: number;
  columns: number;
  setColumns: (v: number) => void;
  rows: number;
  setRows: (v: number) => void;
  gapX: number;
  setGapX: (v: number) => void;
  gapY: number;
  setGapY: (v: number) => void;
  showGapSettings: boolean;
  setShowGapSettings: (v: boolean) => void;

  // For sticker imposer shape
  detectedShapesByPage: Record<number, string>;
  setDetectedShapesByPage: (v: Record<number, string>) => void;
  viewerActivePage: number;
  viewerPageOrder: number[] | null;
  paperSectionJSX?: React.ReactNode;
}

export default function GridSettingsSection(props: GridSettingsProps) {
  const { t } = useTranslation();
  const { measurementUnit } = useAppSettingsStore();
  const {
    taskMode,
    setTaskMode,
    activeTool,
    duplexFlow,
    setDuplexFlow,
    gridStrategy,
    setGridStrategy,

    targetQuantity,
    setTargetQuantity,
    targetQuantitiesByPage,
    setTargetQuantitiesByPage,
    previewCapacity = 0,
    previewCapacities = {},
    mixedPlacedByPage = {},
    sourceTotalPages,
    columns,
    setColumns,
    rows,
    setRows,
    gapX,
    setGapX,
    gapY,
    setGapY,
    showGapSettings,
    setShowGapSettings,
    detectedShapesByPage,
    setDetectedShapesByPage,
    viewerActivePage,
    viewerPageOrder,
    paperSectionJSX,
  } = props;

  // CNC ghép nhiều mẫu: số tờ in thực tế = MAX số tờ cần của từng mẫu (tất cả
  // mẫu nằm chung 1 tờ). Dùng để tính "SL thực" mỗi mẫu = con/tờ × số tờ.
  const _isCnc = activeTool === "cnc_imposer";
  const cncGlobalSheets = (() => {
    if (!_isCnc) return 1;
    const twoSided = duplexFlow === "double";
    const count = twoSided ? Math.ceil(sourceTotalPages / 2) : sourceTotalPages;
    let mx = 1;
    for (let p = 0; p < count; p++) {
      const idx = twoSided ? p * 2 : p;
      const rawQty = targetQuantitiesByPage[idx];
      const qty = rawQty !== undefined ? rawQty : targetQuantity;
      const cap = mixedPlacedByPage[idx] || 0;
      if (qty > 0 && cap > 0) mx = Math.max(mx, Math.ceil(qty / cap));
    }
    return mx;
  })();

  const s = useImposerSettingsStore(
    useShallow((state) => ({
      clusterSizingMode: state.clusterSizingMode,
      setClusterSizingMode: state.setClusterSizingMode,
      clusterCols: state.clusterCols,
      setClusterCols: state.setClusterCols,
      clusterRows: state.clusterRows,
      setClusterRows: state.setClusterRows,
      tileGapX: state.tileGapX,
      setTileGapX: state.setTileGapX,
      tileGapY: state.tileGapY,
      setTileGapY: state.setTileGapY,
      clusterNesting: state.clusterNesting,
      setClusterNesting: state.setClusterNesting,
      layoutType: state.layoutType,
      setLayoutType: state.setLayoutType,
      bleed: state.bleed,
      setBleed: state.setBleed,
      showBleedView: state.showBleedView,
      setShowBleedView: state.setShowBleedView,
    })),
  );
  const quantityApplies = !(taskMode === "nup" && s.layoutType === "cut_stacks");


  // Derived variables for shape selector
  const actualIndex = viewerPageOrder
    ? viewerPageOrder[viewerActivePage - 1] - 1
    : viewerActivePage - 1;
  const currentShape = detectedShapesByPage[actualIndex] || "CUSTOM";

  const [showPageQuantities, setShowPageQuantities] = React.useState(false);
  const [pasteText, setPasteText] = React.useState("");
  const [pasteStatus, setPasteStatus] = React.useState<{ ok: boolean; msg: string } | null>(null);
  const [infoModal, setInfoModal] = React.useState<{
    title: string;
    content: React.ReactNode;
  } | null>(null);

  // Dán cột số lượng từ Excel → điền theo THỨ TỰ trang. Người dùng bôi cột số
  // lượng trong Excel (Ctrl+C) rồi dán vào đây. Số sản phẩm hiển thị theo chế độ
  // duplex (2 mặt gộp còn ceil(n/2) sản phẩm, key = productIdx*2 — khớp bảng dưới).
  const fillQuantitiesFromPaste = () => {
    const twoSided = duplexFlow === "double" && activeTool !== "sticker_imposer";
    const productCount = twoSided ? Math.ceil(sourceTotalPages / 2) : sourceTotalPages;

    const parsed = parsePastedQuantities(pasteText, productCount);
    if (!parsed.ok) {
      setPasteStatus({ ok: false, msg: parsed.error });
      return;
    }

    const obj: Record<number, number> = {};
    parsed.quantities.forEach((q, productIdx) => {
      const idx = twoSided ? productIdx * 2 : productIdx;
      obj[idx] = q;
    });
    setTargetQuantitiesByPage(obj);
    setPasteStatus({ ok: true, msg: t('imposition.gridSettings:da_dien_n_trang', { n: parsed.quantities.length }) });
  };

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setInfoModal(null);
    };
    if (infoModal) {
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [infoModal]);

  return (
    <div className="animate-in fade-in duration-200 relative z-[50]">
      {/* Grid Settings */}
      <div className="space-y-3">
        <div className="flex flex-col gap-3">
          {/* === TÁC VỤ — First in workflow === */}
          <div className="flex items-center gap-3">
            <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]">
              {t('imposition.gridSettings:tac_vu')}
            </label>
            <div className="flex flex-1 items-center gap-2 min-w-0">
              <select
                // Legacy: sticker_imposer/cnc_imposer từng bị nhầm làm taskMode (= dàn nhiều mẫu)
                value={
                  taskMode === "step_repeat"
                    ? "step_repeat"
                    : "nup"
                }
                onChange={(e) => setTaskMode(e.target.value)}
                className="flex-1 min-w-0 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
              >
                <option value="step_repeat">{t('imposition.gridSettings:binh_trang_s_r')}</option>
                <option value="nup">{t('imposition.gridSettings:dan_nhieu_mau_n_up')}</option>
              </select>
              <div
                className="shrink-0 w-8 h-8 flex items-center justify-center text-slate-400 hover:text-indigo-600 dark:text-zinc-500 dark:hover:text-indigo-400 cursor-pointer transition-colors"
                onClick={() =>
                  setInfoModal({
                    title: t('imposition.gridSettings:tac_vu_2'),
                    content: (
                      <div className="space-y-4">
                        <div className="space-y-1">
                          <h4 className="font-bold text-slate-800 dark:text-white">
                            {t('imposition.gridSettings:binh_trang_s_r')}
                          </h4>
                          <p className="text-slate-600 dark:text-zinc-300">
                            {t('imposition.gridSettings:nhan_ban_mot_mau_thiet_ke_lap_lai')}
                          </p>
                        </div>
                        <div className="space-y-1">
                          <h4 className="font-bold text-slate-800 dark:text-white">
                            {t('imposition.gridSettings:dan_nhieu_mau_n_up')}
                          </h4>
                          <p className="text-slate-600 dark:text-zinc-300">
                            {t('imposition.gridSettings:ghep_nhieu_mau_thiet_ke_hoac_nhieu_trang')}
                          </p>
                        </div>
                      </div>
                    ),
                  })
                }
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              </div>
            </div>
          </div>

          {/* === CÁCH THỨC RÁP === */}
          {taskMode === "nup" && activeTool !== "sticker_imposer" && (
            <div className="flex items-center gap-3">
              <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]">
                {t('imposition.gridSettings:cach_thuc_rap')}
              </label>
              <div className="flex flex-1 items-center gap-2 min-w-0">
                <select
                  value={s.layoutType}
                  onChange={(e) => {
                    const v = e.target.value as typeof s.layoutType;
                    s.setLayoutType(v);
                    // cut_stacks không hỗ trợ 2 mặt → tự về 1 mặt (mirror tờ lẻ phá
                    // collate). ratio_stack GIỜ hỗ trợ 2 mặt (cặp trang trước/sau).
                    if (v === "cut_stacks" && duplexFlow === "double") {
                      setDuplexFlow("normal");
                    }
                  }}
                  className="flex-1 min-w-0 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                >
                  <option value="sequential">{t('imposition.gridSettings:xep_lan_luot')}</option>
                  <option value="cut_stacks">{t('imposition.gridSettings:xep_chong_up_xap_dung_thu_tu')}</option>
                  <option value="ratio_stack">{t('imposition.gridSettings:chia_ty_le_xep_chong_nhieu_mau_sl_rieng')}</option>
                </select>
                <div
                  className="shrink-0 w-8 h-8 flex items-center justify-center text-slate-400 hover:text-indigo-600 dark:text-zinc-500 dark:hover:text-indigo-400 cursor-pointer transition-colors"
                  onClick={() =>
                    setInfoModal({
                      title: t('imposition.gridSettings:cach_thuc_rap_2'),
                      content: (
                        <div className="space-y-4">
                          <div className="space-y-1">
                            <h4 className="font-bold text-slate-800 dark:text-white">
                              {t('imposition.gridSettings:xep_lan_luot')}
                            </h4>
                            <p className="text-slate-600 dark:text-zinc-300">
                              <strong>{t('imposition.gridSettings:1_mat')}</strong> {t('imposition.gridSettings:trang_1_2_3_lien_tiep_theo_sl_het_loai')}
                            </p>
                            <p className="text-slate-600 dark:text-zinc-300">
                              <strong>{t('imposition.gridSettings:2_mat')}</strong> {t('imposition.gridSettings:moi_san_pham_cap_trang_cung_o_mat_truoc')} <strong>{t('imposition.gridSettings:chan')}</strong>.
                            </p>
                          </div>
                          <div className="space-y-1">
                            <h4 className="font-bold text-slate-800 dark:text-white">
                              {t('imposition.gridSettings:xep_chong_up_xap_dung_thu_tu')}
                            </h4>
                            <p className="text-slate-600 dark:text-zinc-300">
                              {t('imposition.gridSettings:bo_tri_cut_stack_cung_mot_vi_tri_o_tren')}
                            </p>
                            <p className="text-amber-600 dark:text-amber-400 text-[12px]">
                              {t('imposition.gridSettings:khac_voi')} <strong>{t('imposition.gridSettings:chia_coc_xen')}</strong> {t('imposition.gridSettings:o_thiet_lap_mo_rong_cai_do_chia_to')}
                            </p>
                          </div>
                          <div className="space-y-1">
                            <h4 className="font-bold text-slate-800 dark:text-white">
                              {t('imposition.gridSettings:chia_ty_le_xep_chong')}
                            </h4>
                            <p className="text-slate-600 dark:text-zinc-300">
                              {t('imposition.gridSettings:nhieu_mau_cung_co_so_luong_khac_nhau_moi')}
                            </p>
                          </div>
                        </div>
                      ),
                    })
                  }
                >
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                </div>
              </div>
            </div>
          )}

          {/* === HÌNH DẠNG TEM (sticker_imposer + cnc_imposer) === */}
          {(activeTool === "sticker_imposer" || activeTool === "cnc_imposer") && (
            <div className="flex items-center gap-3">
              <label
                className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]"
                title={t('imposition.gridSettings:trang_hien_tai', { n: viewerActivePage })}
              >
                {t('imposition.gridSettings:hinh_dang_tem')}
              </label>
              <div className="flex flex-1 items-center gap-2 min-w-0">
                <select
                  value={currentShape}
                  onChange={(e) => {
                    setDetectedShapesByPage({
                      ...detectedShapesByPage,
                      [actualIndex]: e.target.value,
                    });
                  }}
                  className="flex-1 min-w-0 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                >
                  <option value="CIRCLE_ELLIPSE">{t('imposition.gridSettings:tron_elip')}</option>
                  <option value="RECTANGLE">{t('imposition.gridSettings:vuong_chu_nhat')}</option>
                  <option value="TRIANGLE">{t('imposition.gridSettings:tam_giac')}</option>
                  <option value="PENTAGON">{t('imposition.gridSettings:ngu_giac')}</option>
                  <option value="HEXAGON">{t('imposition.gridSettings:luc_giac')}</option>
                  <option value="DUMBBELL">{t('imposition.gridSettings:ta_tay')}</option>
                  <option value="HAMMER">{t('imposition.gridSettings:bua')}</option>
                  <option value="TRAPEZOID">{t('imposition.gridSettings:hinh_thang')}</option>
                  <option value="PARALLELOGRAM">{t('imposition.gridSettings:binh_hanh')}</option>
                  <option value="ARROW">{t('imposition.gridSettings:mui_ten')}</option>
                  <option value="CUSTOM">{t('imposition.gridSettings:dac_biet')}</option>
                </select>
                <div
                  className="shrink-0 w-8 h-8 flex items-center justify-center text-slate-400 hover:text-indigo-600 dark:text-zinc-500 dark:hover:text-indigo-400 cursor-pointer transition-colors"
                  onClick={() =>
                    setInfoModal({
                      title: t('imposition.gridSettings:hinh_dang_tem_2'),
                      content: (
                        <div className="space-y-4">
                          <p className="text-slate-600 dark:text-zinc-300">
                            {t('imposition.gridSettings:tool_se_tu_dong_nhan_dien_da_so_cac_loai')}
                          </p>
                          <p className="text-slate-600 dark:text-zinc-300">
                            {t('imposition.gridSettings:neu_thay_hinh_dang_tu_nhan_dien_chua')}
                          </p>
                        </div>
                      ),
                    })
                  }
                >
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                </div>
              </div>
            </div>
          )}





          <div className="flex items-center gap-3">
            <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]">
              {t('imposition.gridSettings:cach_xep')}
            </label>
            <div className="flex flex-1 items-center gap-2 min-w-0">
              <select
                value={gridStrategy}
                onChange={(e) => setGridStrategy(e.target.value)}
                className="flex-1 min-w-0 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
              >
                <option value="optimal_auto">{t('imposition.gridSettings:xep_toi_uu')}</option>
                <option value="simple_auto">{t('imposition.gridSettings:luoi_don_gian')}</option>
                <option value="manual">{t('imposition.gridSettings:tuy_chinh')}</option>
              </select>
              <div
                className="shrink-0 w-8 h-8 flex items-center justify-center text-slate-400 hover:text-indigo-600 dark:text-zinc-500 dark:hover:text-indigo-400 cursor-pointer transition-colors"
                onClick={() =>
                  setInfoModal({
                    title: t('imposition.gridSettings:cach_xep_2'),
                    content: (
                      <div className="space-y-4">
                        <div className="space-y-1">
                          <h4 className="font-bold text-slate-800 dark:text-white">
                            {t('imposition.gridSettings:xep_toi_uu')}
                          </h4>
                          <p className="text-slate-600 dark:text-zinc-300">
                            {t('imposition.gridSettings:tu_dong_tinh_toan_so_hang_cot_va_huong')}
                          </p>
                        </div>
                        <div className="space-y-1">
                          <h4 className="font-bold text-slate-800 dark:text-white">
                            {t('imposition.gridSettings:luoi_don_gian')}
                          </h4>
                          <p className="text-slate-600 dark:text-zinc-300">
                            {t('imposition.gridSettings:tu_dong_tinh_hang_cot_nhung_khong_xoay')}
                          </p>
                        </div>
                        <div className="space-y-1">
                          <h4 className="font-bold text-slate-800 dark:text-white">
                            {t('imposition.gridSettings:tuy_chinh')}
                          </h4>
                          <p className="text-slate-600 dark:text-zinc-300">
                            {t('imposition.gridSettings:tu_nhap_so_hang_va_cot_theo_y_muon')}
                          </p>
                        </div>
                      </div>
                    ),
                  })
                }
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              </div>
            </div>
          </div>
          
          {gridStrategy === "manual" && (
            <div className="grid grid-cols-2 gap-x-3 gap-y-3">
              <div>
                <label className="text-[11px] text-slate-500 block mb-1 font-medium">
                  {t('imposition.gridSettings:cot')}
                </label>
                <input
                  type="number"
                  value={columns}
                  onChange={(e) => setColumns(Number(e.target.value))}
                  className={inputCls}
                  style={{ paddingLeft: "9px" }}
                />
              </div>
              <div>
                <label className="text-[11px] text-slate-500 block mb-1 font-medium">
                  {t('imposition.gridSettings:dong')}
                </label>
                <input
                  type="number"
                  value={rows}
                  onChange={(e) => setRows(Number(e.target.value))}
                  className={inputCls}
                  style={{ paddingLeft: "9px" }}
                />
              </div>
            </div>
          )}
          <div className="flex items-center gap-3">
            <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]">
              {t('imposition.gridSettings:ho_tem')}
            </label>
            <div className="flex flex-1 items-center gap-3 min-w-0">
                <div className="relative flex-1 min-w-0">
                    <input
                        type="number" step="1"
                        value={gapX} 
                        onChange={(e) => {
                            setGapX(Number(e.target.value));
                            setGapY(Number(e.target.value));
                        }}
                        className="w-full h-8 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium pr-7"
                        style={{ paddingLeft: "9px" }}
                        title={t('imposition.gridSettings:khoang_ho_giua_cac_nhan_gap')}
                    />
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 font-medium pointer-events-none uppercase">
                        {measurementUnit}
                    </div>
                </div>

                {/* Moved Bleed here — ẩn cho Bế tem & CNC (kích thước lấy từ ĐƯỜNG KHUÔN BẾ, bleed không tác dụng) */}
                {activeTool !== "sticker_imposer" && activeTool !== "cnc_imposer" && (
                  <>
                    <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide whitespace-nowrap shrink-0 pl-1">
                      BLEED
                    </label>
                    <div className="relative flex-1 min-w-0">
                      <input
                        type="number"
                        step="0.1"
                        value={s.bleed}
                        onChange={(e) => s.setBleed(Number(e.target.value))}
                        className="w-full h-8 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium pr-7"
                        style={{ paddingLeft: "9px" }}
                      />
                      <button
                        onClick={() => s.setShowBleedView(!s.showBleedView)}
                        className={`absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 rounded flex items-center justify-center transition-colors ${
                          s.showBleedView
                            ? "text-rose-600 dark:text-rose-400"
                            : "text-slate-400 hover:text-slate-600 dark:hover:text-zinc-300"
                        }`}
                        title={s.showBleedView ? t('imposition.gridSettings:tat_xem_truoc_bleed') : t('imposition.gridSettings:bat_xem_truoc_bleed')}
                      >
                        {s.showBleedView ? (
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                          </svg>
                        ) : (
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                          </svg>
                        )}
                      </button>
                    </div>
                  </>
                )}
            </div>
          </div>
          {/* moved gridStrategy === "manual" block above */}



          {/* Duplex Flow — ẩn cho Bế tem (1 mặt) & CNC (CNC dùng checkbox "In 2 mặt" riêng) */}
          {activeTool !== "sticker_imposer" && activeTool !== "cnc_imposer" && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-3">
                <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]">
                  {t('imposition.gridSettings:so_mat')}
                </label>
                <div className="flex flex-1 items-center gap-3 min-w-0">
                  <select
                    value={duplexFlow}
                    onChange={(e) => {
                      const v = e.target.value;
                      setDuplexFlow(v);
                      // Guard đối xứng: chọn 2 Mặt khi đang «Xếp chồng» (cut_stacks không
                      // hỗ trợ 2 mặt — mirror tờ lẻ phá thứ tự úp xấp) → tự đổi cách ráp về
                      // «Xếp lần lượt» (mode gần nhất có 2 mặt), tránh preview≠output.
                      if (v === "double" && taskMode === "nup" && s.layoutType === "cut_stacks") {
                        s.setLayoutType("sequential");
                      }
                    }}
                    className="flex-1 min-w-0 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                  >
                    <option value="normal">{t('imposition.gridSettings:1_mat_2')}</option>
                    <option value="double">{t('imposition.gridSettings:2_mat_2')}</option>
                  </select>
                </div>
              </div>
              {duplexFlow === "double" && sourceTotalPages > 0 && sourceTotalPages % 2 !== 0 && (
                <div className="text-[11px] text-red-600 dark:text-red-400 pl-[107px] leading-snug">
                  {t('imposition.gridSettings:binh_2_mat_bat_buoc_so_trang')} <strong>{t('imposition.gridSettings:chan')}</strong>. {t('imposition.gridSettings:file_hien_n_trang_le_them_xoa_1_trang', { n: sourceTotalPages })}
                </div>
              )}
              {duplexFlow === "double" &&
                taskMode === "nup" &&
                s.layoutType === "cut_stacks" && (
                <div className="text-[11px] text-red-600 dark:text-red-400 pl-[107px] leading-snug">
                  {t('imposition.gridSettings:xep_chong_chua_ho_tro_2_mat_chon')} <strong>{t('imposition.gridSettings:1_mat_2')}</strong>{t('imposition.gridSettings:hoac_doi_sang')}{" "}
                  <strong>{t('imposition.gridSettings:xep_lan_luot')}</strong> / <strong>{t('imposition.gridSettings:chia_ty_le')}</strong>.
                </div>
              )}
            </div>
          )}

          {/* === INJECT PAPER SECTION HERE === */}
          {paperSectionJSX && (
            <div className="-my-1">{paperSectionJSX}</div>
          )}

          {/* === SỐ LƯỢNG — Adapts label based on TÁC VỤ === */}
          <div className="flex items-center gap-3">
            <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]">
              {taskMode === "nup" || taskMode === "sticker_imposer"
                ? t('imposition.gridSettings:sl_moi_loai')
                : t('imposition.gridSettings:so_luong')}
            </label>
            <div className="flex flex-1 items-center gap-2 min-w-0">
              <input
                type="number"
                min="0"
                value={quantityApplies ? (targetQuantity === 0 ? "" : targetQuantity) : ""}
                disabled={!quantityApplies}
                onChange={(e) =>
                  setTargetQuantity(Math.max(0, parseInt(e.target.value) || 0))
                }
                className="flex-1 min-w-0 h-8 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium disabled:opacity-60 disabled:cursor-not-allowed"
                style={{ paddingLeft: "9px", paddingRight: "8px" }}
                placeholder={
                  !quantityApplies
                    ? "Kh\u00f4ng \u00e1p d\u1ee5ng cho X\u1ebfp ch\u1ed3ng"
                    : taskMode === "nup" || taskMode === "sticker_imposer"
                    ? t('imposition.gridSettings:trong_tu_dong_lap_day_1_to')
                    : t('imposition.gridSettings:0_xep_toi_da_tren_1_to')
                }
              />
              {sourceTotalPages > 1 && quantityApplies ? (
                <button
                  onClick={() => setShowPageQuantities(!showPageQuantities)}
                  className={`shrink-0 w-8 h-8 rounded flex items-center justify-center transition-colors ${showPageQuantities ? "bg-indigo-100 text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-400" : "bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"}`}
                  title={t('imposition.gridSettings:cai_dat_so_luong_in_rieng_cho_tung')}
                >
                  <svg
                    className={`w-4 h-4 transition-transform duration-200 ${showPageQuantities ? "rotate-180" : ""}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 9l-7 7-7-7"
                    />
                  </svg>
                </button>
              ) : (
                <div className="shrink-0 w-8" />
              )}
            </div>
          </div>

          {!quantityApplies && (
            <div className="pl-[107px] text-[11px] leading-snug text-slate-500 dark:text-zinc-400">
              {"X\u1ebfp ch\u1ed3ng d\u00f9ng m\u1ed7i trang PDF \u0111\u00fang m\u1ed9t l\u1ea7n; s\u1ed1 l\u01b0\u1ee3ng kh\u00f4ng \u00e1p d\u1ee5ng."}
            </div>
          )}
          {quantityApplies && showPageQuantities && sourceTotalPages > 1 && (
            <div className="mt-1 animate-in slide-in-from-top-2 duration-200">
              <div className="p-3 bg-slate-50 dark:bg-zinc-800/50 border border-slate-200 dark:border-white/10 rounded-lg space-y-2 max-h-60 overflow-y-auto custom-scrollbar">
                {/* Dán cột số lượng từ Excel → điền theo thứ tự trang (bỏ gõ tay từng ô) */}
                <div className="pb-2 mb-1 border-b border-slate-200 dark:border-white/10 space-y-1.5">
                  <div className="text-[10px] font-bold text-slate-500 uppercase">
                    {t('imposition.gridSettings:dan_so_luong_tu_excel')}
                  </div>
                  <textarea
                    value={pasteText}
                    onChange={(e) => setPasteText(e.target.value)}
                    rows={3}
                    placeholder={t('imposition.gridSettings:boi_cot_so_luong_trong_excel_ctrlc_dan_vao_day')}
                    className={`${inputCls} h-auto py-1.5 resize-y font-mono text-[11px] leading-snug`}
                  />
                  <div className="flex items-center gap-2">
                    <button
                      onClick={fillQuantitiesFromPaste}
                      className="px-3 h-7 rounded bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-bold transition-colors"
                    >
                      {t('imposition.gridSettings:dien_so_luong')}
                    </button>
                    {pasteStatus && (
                      <span
                        className={`text-[10px] font-medium ${
                          pasteStatus.ok
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-red-600 dark:text-red-400"
                        }`}
                      >
                        {pasteStatus.ok ? "✓ " : "⚠ "}
                        {pasteStatus.msg}
                      </span>
                    )}
                  </div>
                </div>

                <div className="text-[10px] text-slate-500 mb-2 italic">
                  {t('imposition.gridSettings:de_trong_de_dung_chung_so_luong')} (
                  {targetQuantity === 0 ? t('imposition.gridSettings:mac_dinh') : targetQuantity})
                </div>

                {/* Header: N-Up mode hides T/Tờ and Số Tờ columns (sticker_imposer vẫn hiện để biết số tờ cần in) */}
                {taskMode === "nup" ? (
                  <div className="grid grid-cols-[60px_1fr] gap-2 mb-1 border-b border-slate-200 dark:border-white/10 pb-1">
                    <div className="text-[10px] font-bold text-slate-500 uppercase">
                      {t('imposition.gridSettings:trang')}
                    </div>
                    <div className="text-[10px] font-bold text-slate-500 uppercase">
                      {t('imposition.gridSettings:so_luong_2')}
                    </div>
                  </div>
                ) : (
                  <div className={`grid ${_isCnc ? "grid-cols-[52px_1fr_34px_30px_60px]" : "grid-cols-[60px_1fr_40px_40px]"} gap-2 mb-1 border-b border-slate-200 dark:border-white/10 pb-1`}>
                    <div className="text-[10px] font-bold text-slate-500 uppercase">
                      {t('imposition.gridSettings:trang')}
                    </div>
                    <div className="text-[10px] font-bold text-slate-500 uppercase">
                      {t('imposition.gridSettings:so_luong_2')}
                    </div>
                    <div
                      className="text-[10px] font-bold text-slate-500 uppercase text-center"
                      title={t('imposition.gridSettings:so_tem_san_pham_binh_duoc_tren_moi_to')}
                    >
                      {t('imposition.gridSettings:tem_to')}
                    </div>
                    <div className="text-[10px] font-bold text-slate-500 uppercase text-right">
                      {t('imposition.gridSettings:so_to')}
                    </div>
                    {_isCnc && (
                      <div
                        className="text-[10px] font-bold text-slate-500 uppercase text-right"
                        title={t('imposition.gridSettings:so_con_in_thuc_te_tem_to_so_to_in_luon')}
                      >
                        {t('imposition.gridSettings:sl_thuc')}
                      </div>
                    )}
                  </div>
                )}

                {Array.from({ length: (duplexFlow === "double" && activeTool !== "sticker_imposer") ? Math.ceil(sourceTotalPages / 2) : sourceTotalPages }).map((_, productIdx) => {
                  const twoSided = duplexFlow === "double" && activeTool !== "sticker_imposer";
                  const idx = twoSided ? productIdx * 2 : productIdx;

                  const label = twoSided
                      ? (idx + 1 === sourceTotalPages ? t('imposition.gridSettings:sp_n_trang_m', { n: productIdx + 1, m: idx + 1 }) : t('imposition.gridSettings:sp_n_mat_a_b', { n: productIdx + 1, a: idx + 1, b: idx + 2 }))
                      : t('imposition.gridSettings:trang_n', { n: idx + 1 });

                  const rawQty = targetQuantitiesByPage[idx];
                  const qty = rawQty !== undefined ? rawQty : targetQuantity;
                  // TEM/TỜ = capacity RIÊNG của loại này khi in đầy 1 tờ (khớp export
                  // items_per_sheet_type). CNC dùng số ĐÃ XẾP trên tờ trộn (mixedPlacedByPage).
                  // previewCapacities điền cho MỌI trang qua batch (không chỉ trang đang xem).
                  const cap = (_isCnc ? (mixedPlacedByPage[idx] || 0) : 0) || previewCapacities[idx] || previewCapacity || 0;
                  const sheets = _isCnc
                    ? cncGlobalSheets
                    : qty > 0 ? (cap > 0 ? Math.ceil(qty / cap) : "?") : 1;
                  const isNup =
                    taskMode === "nup";

                  return (
                    <div
                      key={idx}
                      className={`grid ${isNup ? "grid-cols-[60px_1fr]" : _isCnc ? "grid-cols-[52px_1fr_34px_30px_60px]" : "grid-cols-[60px_1fr_40px_40px]"} gap-2 items-center`}
                    >
                      <span className="text-[11px] font-medium text-slate-600 dark:text-zinc-400 whitespace-nowrap">
                        {label}
                      </span>
                      <input
                        type="number"
                        min="0"
                        value={
                          targetQuantitiesByPage[idx] === undefined
                            ? ""
                            : targetQuantitiesByPage[idx]
                        }
                        onChange={(e) => {
                          const val =
                            e.target.value === ""
                              ? undefined
                              : Math.max(0, parseInt(e.target.value) || 0);
                          const newVals = { ...targetQuantitiesByPage };
                          if (val === undefined) {
                            delete newVals[idx];
                          } else {
                            newVals[idx] = val;
                          }
                          setTargetQuantitiesByPage(newVals);
                        }}
                        placeholder={
                          targetQuantity === 0
                            ? isNup
                              ? "1"
                              : t('imposition.gridSettings:mac_dinh')
                            : targetQuantity.toString()
                        }
                        className="w-full h-7 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-xs focus:outline-none focus:border-indigo-500"
                        style={{ paddingLeft: "9px", paddingRight: "8px" }}
                      />
                      {!isNup && (
                        <>
                          <div className="text-[11px] text-slate-500 text-center font-mono bg-white dark:bg-zinc-900 border border-slate-200 dark:border-white/10 rounded h-7 flex items-center justify-center">
                            {cap > 0 ? cap : "-"}
                          </div>
                          <div className="text-[11px] font-bold text-indigo-600 dark:text-indigo-400 text-right">
                            {sheets}
                          </div>
                          {_isCnc && (
                            <div
                              className="text-[10px] text-right leading-tight"
                              title={t('imposition.gridSettings:so_con_in_thuc_te_tem_to_so_to_in_luon')}
                            >
                              {cap > 0 && qty > 0 ? (
                                <>
                                  <span className="font-bold text-emerald-600 dark:text-emerald-400">
                                    {cap * cncGlobalSheets}
                                  </span>
                                  <span className="text-slate-400">
                                    {" "}
                                    (+{cap * cncGlobalSheets - qty})
                                  </span>
                                </>
                              ) : (
                                "-"
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}

                {!(taskMode === "nup") && (
                  <div className="mt-2 pt-2 border-t border-slate-200 dark:border-white/10 flex justify-between items-center">
                    <span className="text-[11px] font-bold text-slate-600 dark:text-zinc-400">
                      {t('imposition.gridSettings:tong_so_to_du_kien')}
                    </span>
                    <span className="text-[13px] font-bold text-indigo-600 dark:text-indigo-400">
                      {_isCnc ? cncGlobalSheets : Array.from({ length: (duplexFlow === "double" && activeTool !== "sticker_imposer") ? Math.ceil(sourceTotalPages / 2) : sourceTotalPages }).reduce(
                        (acc: number, _, productIdx) => {
                          const idx = (duplexFlow === "double" && activeTool !== "sticker_imposer") ? productIdx * 2 : productIdx;
                          const rawQty = targetQuantitiesByPage[idx];
                          const qty =
                            rawQty !== undefined ? rawQty : targetQuantity;
                          const cap =
                            previewCapacities[idx] || previewCapacity || 0;
                          const sheets =
                            qty > 0
                              ? cap > 0
                                ? Math.ceil(qty / cap)
                                : "?"
                              : 1;
                          return acc + (sheets === "?" ? 0 : Number(sheets));
                        },
                        0,
                      )}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Info Modal */}
      {infoModal &&
        createPortal(
          <div
            className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in duration-200"
            onClick={() => setInfoModal(null)}
          >
            <div
              className="bg-white dark:bg-zinc-900 rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-white/10">
                <h3 className="text-lg font-bold text-slate-800 dark:text-white">
                  {infoModal.title}
                </h3>
                <button
                  onClick={() => setInfoModal(null)}
                  className="text-slate-400 hover:text-slate-600 dark:hover:text-zinc-300 transition-colors"
                >
                  <svg
                    className="w-5 h-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
              <div className="p-5 text-sm">{infoModal.content}</div>
              <div className="px-5 py-4 bg-slate-50 dark:bg-zinc-800/50 border-t border-slate-200 dark:border-white/10 flex justify-end">
                <button
                  onClick={() => setInfoModal(null)}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg transition-colors"
                >
                  {t('imposition.gridSettings:da_hieu')}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
