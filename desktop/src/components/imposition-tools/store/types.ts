// Combined store state = giao của tất cả slice (state PHẲNG, giữ nguyên hình dạng cũ).
import type { PaperSlice } from './slices/paperSlice';
import type { MarksSlice } from './slices/marksSlice';
import type { BookletSlice } from './slices/bookletSlice';
import type { NupSlice } from './slices/nupSlice';
import type { FoldSlice } from './slices/foldSlice';
import type { CatalogSlice } from './slices/catalogSlice';
import type { ReportSlice } from './slices/reportSlice';
import type { CncSlice } from './slices/cncSlice';
import type { UiSlice } from './slices/uiSlice';
import type { PreprocSlice } from './slices/preprocSlice';
import type { WorkspaceSlice } from './slices/workspaceSlice';

export type ImposerSettingsState =
    & WorkspaceSlice
    & PaperSlice
    & MarksSlice
    & ReportSlice
    & CncSlice
    & BookletSlice
    & NupSlice
    & FoldSlice
    & CatalogSlice
    & UiSlice
    & PreprocSlice;
