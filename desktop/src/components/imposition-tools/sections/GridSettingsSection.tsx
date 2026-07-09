import React from "react";
import { createPortal } from "react-dom";
import { RichSelect, SectionLabel, Divider, inputCls } from "../SharedUI";
import { useImposerSettingsStore } from "../useImposerSettingsStore";
import { useShallow } from "zustand/react/shallow";
import { useAppSettingsStore } from "../../../stores/appSettingsStore";

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
    // Mỗi dòng = 1 số; strip dấu phẩy ngăn nghìn + khoảng trắng; bỏ dòng trống.
    const qtys = pasteText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const n = parseInt(line.replace(/[,\s]/g, ""), 10);
        return isNaN(n) ? null : Math.max(0, n);
      });

    if (qtys.length === 0) {
      setPasteStatus({ ok: false, msg: "Chưa có dữ liệu — dán cột số lượng từ Excel vào ô trên." });
      return;
    }
    if (qtys.some((q) => q === null)) {
      setPasteStatus({ ok: false, msg: "Có dòng không phải số — kiểm tra lại cột đã dán (chỉ dán cột số lượng)." });
      return;
    }
    if (qtys.length !== productCount) {
      setPasteStatus({
        ok: false,
        msg: `Dán ${qtys.length} dòng nhưng có ${productCount} trang — kiểm tra lại rồi dán lại.`,
      });
      return;
    }

    const obj: Record<number, number> = {};
    qtys.forEach((q, productIdx) => {
      const idx = twoSided ? productIdx * 2 : productIdx;
      obj[idx] = q as number;
    });
    setTargetQuantitiesByPage(obj);
    setPasteStatus({ ok: true, msg: `Đã điền ${qtys.length} trang.` });
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
              TÁC VỤ
            </label>
            <div className="flex flex-1 items-center gap-2 min-w-0">
              <select
                value={taskMode === "sticker_imposer" ? "nup" : taskMode}
                onChange={(e) => setTaskMode(e.target.value)}
                className="flex-1 min-w-0 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
              >
                <option value="step_repeat">Bình trang (S&R)</option>
                <option value="nup">Dàn nhiều mẫu (N-Up)</option>
              </select>
              <div
                className="shrink-0 w-8 h-8 flex items-center justify-center text-slate-400 hover:text-indigo-600 dark:text-zinc-500 dark:hover:text-indigo-400 cursor-pointer transition-colors"
                onClick={() =>
                  setInfoModal({
                    title: "Tác vụ",
                    content: (
                      <div className="space-y-4">
                        <div className="space-y-1">
                          <h4 className="font-bold text-slate-800 dark:text-white">
                            Bình trang (S&R)
                          </h4>
                          <p className="text-slate-600 dark:text-zinc-300">
                            Nhân bản một mẫu thiết kế lặp lại nhiều lần trên
                            cùng một tờ in (VD: in 1 loại tem, 1 loại card visit
                            lấp đầy tờ in).
                          </p>
                        </div>
                        <div className="space-y-1">
                          <h4 className="font-bold text-slate-800 dark:text-white">
                            Dàn nhiều mẫu (N-Up)
                          </h4>
                          <p className="text-slate-600 dark:text-zinc-300">
                            Ghép nhiều mẫu thiết kế hoặc nhiều trang tài liệu
                            khác nhau vào cùng một tờ in (VD: in ghép nhiều loại
                            card visit của nhiều người khác nhau).
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
                CÁCH THỨC RÁP
              </label>
              <div className="flex flex-1 items-center gap-2 min-w-0">
                <select
                  value={s.layoutType}
                  onChange={(e) => {
                    s.setLayoutType(e.target.value as any);
                  }}
                  className="flex-1 min-w-0 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                >
                  <option value="sequential">Xếp lần lượt</option>
                  <option value="cut_stacks">Xếp chồng (Úp xấp đúng thứ tự)</option>
                </select>
                <div
                  className="shrink-0 w-8 h-8 flex items-center justify-center text-slate-400 hover:text-indigo-600 dark:text-zinc-500 dark:hover:text-indigo-400 cursor-pointer transition-colors"
                  onClick={() =>
                    setInfoModal({
                      title: "Cách thức ráp",
                      content: (
                        <div className="space-y-4">
                          <div className="space-y-1">
                            <h4 className="font-bold text-slate-800 dark:text-white">
                              Xếp lần lượt
                            </h4>
                            <p className="text-slate-600 dark:text-zinc-300">
                              Dàn trang thứ tự 1, 2, 3, 4 liên tiếp nhau trên tờ in.
                            </p>
                          </div>
                          <div className="space-y-1">
                            <h4 className="font-bold text-slate-800 dark:text-white">
                              Xếp chồng (Úp xấp đúng thứ tự)
                            </h4>
                            <p className="text-slate-600 dark:text-zinc-300">
                              In xong tất cả tờ → cắt rời → úp các xấp lên nhau là tự đúng thứ tự trang 1, 2, 3... (collation). Dùng để in sách, ruột sổ bằng máy in nhanh.
                            </p>
                            <p className="text-amber-600 dark:text-amber-400 text-[12px]">
                              Khác với <strong>“Chia cọc xén”</strong> ở Thiết lập mở rộng: cái đó chia tờ thành nhiều cọc + chừa rãnh dao để máy xén chém ít nhát, KHÔNG liên quan thứ tự trang.
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
                title={`Trang hiện tại: ${viewerActivePage}`}
              >
                HÌNH DẠNG TEM
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
                  <option value="CIRCLE_ELLIPSE">Tròn / Elip</option>
                  <option value="RECTANGLE">Vuông / Chữ nhật</option>
                  <option value="TRIANGLE">Tam giác</option>
                  <option value="PENTAGON">Ngũ giác</option>
                  <option value="HEXAGON">Lục giác</option>
                  <option value="DUMBBELL">Tạ tay</option>
                  <option value="HAMMER">Búa</option>
                  <option value="TRAPEZOID">Hình thang</option>
                  <option value="PARALLELOGRAM">Bình hành</option>
                  <option value="ARROW">Mũi tên</option>
                  <option value="CUSTOM">Đặc biệt</option>
                </select>
                <div
                  className="shrink-0 w-8 h-8 flex items-center justify-center text-slate-400 hover:text-indigo-600 dark:text-zinc-500 dark:hover:text-indigo-400 cursor-pointer transition-colors"
                  onClick={() =>
                    setInfoModal({
                      title: "Hình dạng tem",
                      content: (
                        <div className="space-y-4">
                          <p className="text-slate-600 dark:text-zinc-300">
                            Tool sẽ tự động nhận diện đa số các loại hình dạng
                            tem từ file thiết kế PDF của bạn.
                          </p>
                          <p className="text-slate-600 dark:text-zinc-300">
                            Nếu thấy hình dạng tự nhận diện chưa chính xác, bạn
                            có thể tự chọn lại trong danh sách này để quá trình
                            bình trang hoạt động chính xác nhất.
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
              CÁCH XẾP
            </label>
            <div className="flex flex-1 items-center gap-2 min-w-0">
              <select
                value={gridStrategy}
                onChange={(e) => setGridStrategy(e.target.value)}
                className="flex-1 min-w-0 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
              >
                <option value="optimal_auto">Xếp tối ưu</option>
                <option value="simple_auto">Lưới đơn giản</option>
                <option value="manual">Tùy chỉnh</option>
              </select>
              <div
                className="shrink-0 w-8 h-8 flex items-center justify-center text-slate-400 hover:text-indigo-600 dark:text-zinc-500 dark:hover:text-indigo-400 cursor-pointer transition-colors"
                onClick={() =>
                  setInfoModal({
                    title: "Cách xếp",
                    content: (
                      <div className="space-y-4">
                        <div className="space-y-1">
                          <h4 className="font-bold text-slate-800 dark:text-white">
                            Xếp tối ưu
                          </h4>
                          <p className="text-slate-600 dark:text-zinc-300">
                            Tự động tính toán số hàng, cột và hướng xoay tối ưu nhất để lấp đầy tờ in với số lượng tem nhiều nhất có thể.
                          </p>
                        </div>
                        <div className="space-y-1">
                          <h4 className="font-bold text-slate-800 dark:text-white">
                            Lưới đơn giản
                          </h4>
                          <p className="text-slate-600 dark:text-zinc-300">
                            Tự động tính hàng, cột nhưng không xoay tem. Phù hợp khi bạn muốn giữ nguyên hướng thiết kế gốc.
                          </p>
                        </div>
                        <div className="space-y-1">
                          <h4 className="font-bold text-slate-800 dark:text-white">
                            Tùy chỉnh
                          </h4>
                          <p className="text-slate-600 dark:text-zinc-300">
                            Tự nhập số hàng và cột theo ý muốn.
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
                  Cột
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
                  Dòng
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
              HỞ TEM
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
                        title="Khoảng hở giữa các nhãn (Gap)"
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
                        title={s.showBleedView ? "Tắt Xem trước Bleed" : "Bật Xem trước Bleed"}
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
            <div className="flex items-center gap-3">
              <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]">
                SỐ MẶT
              </label>
              <div className="flex flex-1 items-center gap-3 min-w-0">
                <select
                  value={duplexFlow}
                  onChange={(e) => setDuplexFlow(e.target.value)}
                  className="flex-1 min-w-0 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                >
                  <option value="normal">1 Mặt</option>
                  <option value="double">2 Mặt</option>
                </select>
              </div>
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
                ? "SL MỖI LOẠI"
                : "SỐ LƯỢNG"}
            </label>
            <div className="flex flex-1 items-center gap-2 min-w-0">
              <input
                type="number"
                min="0"
                value={targetQuantity === 0 ? "" : targetQuantity}
                onChange={(e) =>
                  setTargetQuantity(Math.max(0, parseInt(e.target.value) || 0))
                }
                className="flex-1 min-w-0 h-8 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                style={{ paddingLeft: "9px", paddingRight: "8px" }}
                placeholder={
                  taskMode === "nup" || taskMode === "sticker_imposer"
                    ? "Trống = Tự động lấp đầy 1 tờ"
                    : "0 = Xếp tối đa trên 1 tờ"
                }
              />
              {sourceTotalPages > 1 ? (
                <button
                  onClick={() => setShowPageQuantities(!showPageQuantities)}
                  className={`shrink-0 w-8 h-8 rounded flex items-center justify-center transition-colors ${showPageQuantities ? "bg-indigo-100 text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-400" : "bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"}`}
                  title="Cài đặt số lượng in riêng cho từng trang"
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

          {showPageQuantities && sourceTotalPages > 1 && (
            <div className="mt-1 animate-in slide-in-from-top-2 duration-200">
              <div className="p-3 bg-slate-50 dark:bg-zinc-800/50 border border-slate-200 dark:border-white/10 rounded-lg space-y-2 max-h-60 overflow-y-auto custom-scrollbar">
                {/* Dán cột số lượng từ Excel → điền theo thứ tự trang (bỏ gõ tay từng ô) */}
                <div className="pb-2 mb-1 border-b border-slate-200 dark:border-white/10 space-y-1.5">
                  <div className="text-[10px] font-bold text-slate-500 uppercase">
                    Dán số lượng từ Excel
                  </div>
                  <textarea
                    value={pasteText}
                    onChange={(e) => setPasteText(e.target.value)}
                    rows={3}
                    placeholder={"Bôi cột số lượng trong Excel → Ctrl+C → dán vào đây\n(mỗi dòng 1 số, theo đúng thứ tự trang)"}
                    className={`${inputCls} h-auto py-1.5 resize-y font-mono text-[11px] leading-snug`}
                  />
                  <div className="flex items-center gap-2">
                    <button
                      onClick={fillQuantitiesFromPaste}
                      className="px-3 h-7 rounded bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-bold transition-colors"
                    >
                      Điền số lượng
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
                  Để trống để dùng chung số lượng (
                  {targetQuantity === 0 ? "Mặc định" : targetQuantity})
                </div>

                {/* Header: N-Up mode hides T/Tờ and Số Tờ columns (sticker_imposer vẫn hiện để biết số tờ cần in) */}
                {taskMode === "nup" ? (
                  <div className="grid grid-cols-[60px_1fr] gap-2 mb-1 border-b border-slate-200 dark:border-white/10 pb-1">
                    <div className="text-[10px] font-bold text-slate-500 uppercase">
                      Trang
                    </div>
                    <div className="text-[10px] font-bold text-slate-500 uppercase">
                      Số lượng
                    </div>
                  </div>
                ) : (
                  <div className={`grid ${_isCnc ? "grid-cols-[52px_1fr_34px_30px_60px]" : "grid-cols-[60px_1fr_40px_40px]"} gap-2 mb-1 border-b border-slate-200 dark:border-white/10 pb-1`}>
                    <div className="text-[10px] font-bold text-slate-500 uppercase">
                      Trang
                    </div>
                    <div className="text-[10px] font-bold text-slate-500 uppercase">
                      Số lượng
                    </div>
                    <div
                      className="text-[10px] font-bold text-slate-500 uppercase text-center"
                      title="Số tem (sản phẩm) bình được trên mỗi tờ in"
                    >
                      Tem/tờ
                    </div>
                    <div className="text-[10px] font-bold text-slate-500 uppercase text-right">
                      Số tờ
                    </div>
                    {_isCnc && (
                      <div
                        className="text-[10px] font-bold text-slate-500 uppercase text-right"
                        title="Số con in thực tế = Tem/tờ × số tờ in (luôn dư so với SL đặt)"
                      >
                        SL thực
                      </div>
                    )}
                  </div>
                )}

                {Array.from({ length: (duplexFlow === "double" && activeTool !== "sticker_imposer") ? Math.ceil(sourceTotalPages / 2) : sourceTotalPages }).map((_, productIdx) => {
                  const twoSided = duplexFlow === "double" && activeTool !== "sticker_imposer";
                  const idx = twoSided ? productIdx * 2 : productIdx;

                  const label = twoSided
                      ? (idx + 1 === sourceTotalPages ? `SP ${productIdx + 1} (trang ${idx + 1})` : `SP ${productIdx + 1} (mặt ${idx + 1}–${idx + 2})`)
                      : `Trang ${idx + 1}`;

                  const rawQty = targetQuantitiesByPage[idx];
                  const qty = rawQty !== undefined ? rawQty : targetQuantity;
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
                              : "Mặc định"
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
                              title="Số con in thực tế = Tem/tờ × số tờ in (luôn dư so với SL đặt)"
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
                      TỔNG SỐ TỜ DỰ KIẾN:
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
                  Đã hiểu
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
