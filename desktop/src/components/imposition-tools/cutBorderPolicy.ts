import type { ActiveToolType, TaskMode } from './types';

export interface CutBorderPolicyInput {
    activeTool: ActiveToolType | string;
    taskMode: TaskMode | string;
    pageSheetMode?: boolean;
}

/**
 * UIUX (audit 2026-08-04 §CB.6): viền cắt chỉ thuộc hai tác vụ xén của N-Up.
 * Policy dùng chung giữ phần thiết lập, preview và payload không lệch nhau.
 */
export function canUseCutBorder({
    activeTool,
    taskMode,
    pageSheetMode = false,
}: CutBorderPolicyInput): boolean {
    return activeTool === 'nup'
        && !pageSheetMode
        && (taskMode === 'nup' || taskMode === 'step_repeat');
}
