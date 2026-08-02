// ============================================================
// Thư viện vật tư in — điểm nhập duy nhất
//
// Dùng: import { lookupThickness, calcSpineThickness } from '@/lib/paperLibrary';
//
// Nguồn dữ liệu: workbook 'Bảng Tra Định Lượng Giấy.xlsm' của xưởng
// (5 sheet), bóc bằng openpyxl 2026-07-30.
// ============================================================

export type {
    CoatingSides,
    PaperFamily,
    PaperStock,
    ThicknessLookup,
} from './types';

export { PAPER_FAMILY_LABELS, PAPER_STOCKS } from './paperStock';

export {
    findStockById,
    findStockByName,
    listStocksByFamily,
    lookupThickness,
    stackThicknessMm,
} from './lookup';

// --- Độ dày gáy sách ---
export type {
    BindingMethod,
    LaminationSide,
    SpineInput,
    SpineResult,
} from './spine';

export {
    BINDING_AVAILABILITY,
    BINDING_LABELS,
    calcSpineThickness,
    LAMINATION_LABELS,
    MAX_SADDLE_MM,
    MIN_SPINE_BY_BINDING,
    PAGES_PER_SHEET,
} from './spine';

// --- Màng cán ---
export type { LaminationFilm } from './laminationFilm';

export {
    FILM_MECHANICAL_PROPERTIES,
    FILM_NYLON_PROPERTIES,
    FILM_OPTICAL_PROPERTIES,
    FILM_PE_PROPERTIES,
    FILM_PERMEABILITY,
    FILM_PET_PROPERTIES,
    FILM_PP_PVC_PROPERTIES,
    FILM_SURFACE_TENSION,
    filmThicknessMm,
    findFilm,
    LAMINATION_FILMS,
    listHeatSealableFilms,
} from './laminationFilm';

// --- Số tờ tối đa may chỉ ---
export type { ThreadSewingLimit } from './threadSewing';

export {
    canThreadSew,
    findThreadSewingLimit,
    maxSheetsForThreadSewing,
    THREAD_SEWING_LIMITS,
} from './threadSewing';
