export type ToolMenuMode = 'full' | 'icons';

export const TOOL_MENU_ICON_WIDTH = 48;
export const TOOL_MENU_FULL_MIN_WIDTH = 280;
export const TOOL_MENU_EXPANDED_CATALOG_WIDTH = 280;
export const TOOL_MENU_FULL_DEFAULT_WIDTH = 390;
export const TOOL_MENU_FULL_MAX_WIDTH = 800;
export const TOOL_MENU_VIEWER_MIN_WIDTH = 320;

export interface ToolMenuDragResult {
  mode: ToolMenuMode;
  fullWidth: number;
}

export interface EffectiveToolMenuLayout {
  mode: ToolMenuMode;
  configWidth: number;
  catalogWidth: number;
  totalWidth: number;
  canExpandFull: boolean;
}

export interface WorkspaceToolMenuToggleResult {
  mode: ToolMenuMode;
  keepActiveTool: true;
}

export interface WorkspaceToolPanelCloseResult {
  activeTool: 'none';
  menuMode: ToolMenuMode;
  closeCrop: boolean;
  closeObjectEdit: boolean;
}

/** Nút X chỉ đóng panel thiết lập; trạng thái full/icons của catalog không đổi. */
export function resolveWorkspaceToolPanelClose(
  activeTool: string,
  menuMode: ToolMenuMode,
  isCropMode: boolean,
  isObjectEditMode: boolean,
): WorkspaceToolPanelCloseResult {
  return {
    activeTool: 'none',
    menuMode,
    closeCrop: isCropMode || activeTool === 'crop',
    closeObjectEdit: isObjectEditMode,
  };
}

/**
 * UIUX (audit 2026-08-22 §RM.DUAL-PANEL): toggle chỉ đổi độ rộng catalog;
 * công cụ đang chọn phải còn nguyên để panel thiết lập tồn tại song song.
 */
export function resolveWorkspaceToolMenuToggle(
  isSidebarOpen: boolean,
): WorkspaceToolMenuToggleResult {
  return isSidebarOpen
    ? { mode: 'icons', keepActiveTool: true }
    : { mode: 'full', keepActiveTool: true };
}

export function isToolMenuMode(value: unknown): value is ToolMenuMode {
  return value === 'full' || value === 'icons';
}

export function normalizeFullToolMenuWidth(
  value: unknown,
  fallback = TOOL_MENU_FULL_DEFAULT_WIDTH,
): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  const safe = Number.isFinite(numeric) ? numeric : fallback;
  return Math.round(Math.min(
    TOOL_MENU_FULL_MAX_WIDTH,
    Math.max(TOOL_MENU_FULL_MIN_WIDTH, safe),
  ));
}

/**
 * UIUX (audit 2026-08-22 §RM.SIMPLE-MODE): dữ liệu cũ chỉ có open + width.
 * Trạng thái đóng, kể cả compact cũ, được quy về thanh icon duy nhất.
 */
export function modeFromLegacyLayout(open: unknown, width: unknown): ToolMenuMode {
  void width;
  return open === true ? 'full' : 'icons';
}

export function toolMenuRailWidth(mode: ToolMenuMode): number {
  void mode;
  return TOOL_MENU_ICON_WIDTH;
}

/** Tổng phần ngang menu chiếm trong Workspace/Home. Khi panel cấu hình đang mở,
 * tool active luôn giữ panel thiết lập; catalog đổi giữa đầy đủ 280px và rail 48px. */
export function toolMenuTotalWidth(
  mode: ToolMenuMode,
  fullWidth: number,
  hasActiveTool: boolean,
): number {
  if (mode === 'icons') {
    return hasActiveTool
      ? normalizeFullToolMenuWidth(fullWidth) + TOOL_MENU_ICON_WIDTH
      : TOOL_MENU_ICON_WIDTH;
  }
  return normalizeFullToolMenuWidth(fullWidth)
    + (hasActiveTool ? TOOL_MENU_EXPANDED_CATALOG_WIDTH : 0);
}

export function resolveEffectiveToolMenuLayout(input: {
  preferredMode: ToolMenuMode;
  preferredFullWidth: number;
  containerWidth: number;
  hasConfigPanel: boolean;
  viewerReservedWidth?: number;
}): EffectiveToolMenuLayout {
  const viewerReservedWidth = Math.max(
    0,
    input.viewerReservedWidth ?? TOOL_MENU_VIEWER_MIN_WIDTH,
  );
  const maximumTotalWidth = Math.max(
    TOOL_MENU_ICON_WIDTH,
    Math.floor(input.containerWidth - viewerReservedWidth),
  );
  const fullThreshold = input.hasConfigPanel
    ? TOOL_MENU_FULL_MIN_WIDTH + TOOL_MENU_EXPANDED_CATALOG_WIDTH
    : TOOL_MENU_FULL_MIN_WIDTH;
  const canExpandFull = maximumTotalWidth >= fullThreshold;
  const mode = input.preferredMode === 'full' && canExpandFull ? 'full' : 'icons';

  if (!input.hasConfigPanel) {
    const catalogWidth = mode === 'full'
      ? Math.min(normalizeFullToolMenuWidth(input.preferredFullWidth), maximumTotalWidth)
      : TOOL_MENU_ICON_WIDTH;
    return { mode, configWidth: 0, catalogWidth, totalWidth: catalogWidth, canExpandFull };
  }

  const catalogWidth = mode === 'full'
    ? TOOL_MENU_EXPANDED_CATALOG_WIDTH
    : TOOL_MENU_ICON_WIDTH;
  const configWidth = Math.max(
    0,
    Math.min(normalizeFullToolMenuWidth(input.preferredFullWidth), maximumTotalWidth - catalogWidth),
  );
  return {
    mode,
    configWidth,
    catalogWidth,
    totalWidth: configWidth + catalogWidth,
    canExpandFull,
  };
}

export function clampToolMenuDraftTotalWidth(
  requestedTotalWidth: number,
  maximumTotalWidth: number,
  hasConfigPanel: boolean,
): number {
  const minimumTotalWidth = hasConfigPanel
    ? TOOL_MENU_FULL_MIN_WIDTH + TOOL_MENU_ICON_WIDTH
    : TOOL_MENU_ICON_WIDTH;
  return Math.round(Math.min(
    Math.max(minimumTotalWidth, maximumTotalWidth),
    Math.max(minimumTotalWidth, requestedTotalWidth),
  ));
}

export function maxFullToolMenuWidth(
  containerWidth: number,
  hasActiveTool: boolean,
  minimumViewerWidth = TOOL_MENU_VIEWER_MIN_WIDTH,
): number {
  const railWidth = hasActiveTool ? TOOL_MENU_EXPANDED_CATALOG_WIDTH : 0;
  return Math.min(
    TOOL_MENU_FULL_MAX_WIDTH,
    Math.max(0, Math.floor(containerWidth - minimumViewerWidth - railWidth)),
  );
}

/**
 * Chốt mode ở CUỐI gesture. Trong lúc kéo component chỉ dùng draftWidth;
 * mọi độ rộng dưới ngưỡng full đều thu thẳng về thanh icon, không có mode giữa.
 */
export function resolveToolMenuDrag(
  totalWidth: number,
  hasActiveTool: boolean,
  currentFullWidth: number,
  maximumFullWidth: number,
): ToolMenuDragResult {
  const minimumTotal = hasActiveTool
    ? TOOL_MENU_FULL_MIN_WIDTH + TOOL_MENU_ICON_WIDTH
    : TOOL_MENU_ICON_WIDTH;
  const safeTotal = Math.max(minimumTotal, Math.round(totalWidth));
  const fullThreshold = TOOL_MENU_FULL_MIN_WIDTH
    + (hasActiveTool ? TOOL_MENU_EXPANDED_CATALOG_WIDTH : 0);

  if (maximumFullWidth < TOOL_MENU_FULL_MIN_WIDTH) {
    return { mode: 'icons', fullWidth: normalizeFullToolMenuWidth(currentFullWidth) };
  }
  if (safeTotal < fullThreshold) {
    return {
      mode: 'icons',
      fullWidth: hasActiveTool
        ? Math.min(
          normalizeFullToolMenuWidth(safeTotal - TOOL_MENU_ICON_WIDTH),
          Math.max(TOOL_MENU_FULL_MIN_WIDTH, maximumFullWidth),
        )
        : normalizeFullToolMenuWidth(currentFullWidth),
    };
  }

  const requestedFullWidth = safeTotal - (hasActiveTool ? TOOL_MENU_EXPANDED_CATALOG_WIDTH : 0);
  return {
    mode: 'full',
    fullWidth: Math.min(
      normalizeFullToolMenuWidth(requestedFullWidth),
      Math.max(TOOL_MENU_FULL_MIN_WIDTH, maximumFullWidth),
    ),
  };
}
