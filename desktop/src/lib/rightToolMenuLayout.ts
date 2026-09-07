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

/**
 * Preference width là độ rộng pane đang mở: catalog khi full + active,
 * panel thiết lập khi icons + active, và catalog khi không có tool.
 * Cách ghi rõ này giúp chuyển mode không làm mất khả năng kéo pane đang dùng.
 */
function resolveConfigWidthForCatalog(catalogWidth: number): number {
  return Math.max(
    TOOL_MENU_FULL_MIN_WIDTH,
    Math.min(TOOL_MENU_FULL_DEFAULT_WIDTH, Math.round(catalogWidth)),
  );
}

function maximumCatalogWidthForBudget(maximumTotalWidth: number): number {
  const safeTotal = Math.max(TOOL_MENU_ICON_WIDTH, Math.floor(maximumTotalWidth));
  if (safeTotal < TOOL_MENU_FULL_MIN_WIDTH * 2) return 0;
  return Math.min(
    TOOL_MENU_FULL_MAX_WIDTH,
    Math.max(0, safeTotal - TOOL_MENU_FULL_MIN_WIDTH),
  );
}

function resolveActiveFullSplit(
  catalogPreference: number,
  maximumTotalWidth: number,
): Pick<EffectiveToolMenuLayout, 'configWidth' | 'catalogWidth' | 'totalWidth'> {
  const safeTotal = Math.max(
    TOOL_MENU_FULL_MIN_WIDTH * 2,
    Math.floor(maximumTotalWidth),
  );
  const maximumCatalogWidth = maximumCatalogWidthForBudget(safeTotal);
  if (maximumCatalogWidth < TOOL_MENU_FULL_MIN_WIDTH) {
    return { configWidth: 0, catalogWidth: 0, totalWidth: 0 };
  }
  const catalogWidth = Math.min(
    normalizeFullToolMenuWidth(catalogPreference),
    maximumCatalogWidth,
  );
  const configWidth = Math.min(
    resolveConfigWidthForCatalog(catalogWidth),
    safeTotal - catalogWidth,
  );
  return {
    configWidth,
    catalogWidth,
    totalWidth: configWidth + catalogWidth,
  };
}

export function toolMenuTotalWidth(
  mode: ToolMenuMode,
  catalogWidth: number,
  hasActiveTool: boolean,
): number {
  const normalizedCatalogWidth = normalizeFullToolMenuWidth(catalogWidth);
  if (mode === 'icons') {
    return hasActiveTool
      ? normalizedCatalogWidth + TOOL_MENU_ICON_WIDTH
      : TOOL_MENU_ICON_WIDTH;
  }
  return normalizedCatalogWidth
    + (hasActiveTool ? resolveConfigWidthForCatalog(normalizedCatalogWidth) : 0);
}

export function resolveEffectiveToolMenuLayout(input: {
  preferredMode: ToolMenuMode;
  /** Độ rộng pane đang mở; full+active là catalog, icons+active là panel thiết lập. */
  preferredFullWidth: number;
  /** Khi có mặt, hai panel dùng preference độc lập; caller cũ/Home giữ hợp đồng cũ. */
  preferredConfigWidth?: number;
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
  const preferredWidth = normalizeFullToolMenuWidth(input.preferredFullWidth);

  // UIUX (feedback 2026-09-07 §PANEL.WIDTH): menu được cấp chỗ riêng;
  // đổi số đo thiết lập không chia lại catalog hoặc tự đổi mode.
  if (input.hasConfigPanel && input.preferredConfigWidth !== undefined) {
    const canExpandFull = maximumTotalWidth >= TOOL_MENU_FULL_MIN_WIDTH * 2;
    const mode = input.preferredMode === 'full' && canExpandFull ? 'full' : 'icons';
    const catalogWidth = mode === 'full'
      ? Math.min(preferredWidth, maximumTotalWidth - TOOL_MENU_FULL_MIN_WIDTH)
      : TOOL_MENU_ICON_WIDTH;
    const configWidth = Math.max(0, Math.min(
      normalizeFullToolMenuWidth(input.preferredConfigWidth),
      maximumTotalWidth - catalogWidth,
    ));
    return { mode, configWidth, catalogWidth, totalWidth: configWidth + catalogWidth, canExpandFull };
  }

  if (!input.hasConfigPanel) {
    const canExpandFull = maximumTotalWidth >= TOOL_MENU_FULL_MIN_WIDTH;
    const mode = input.preferredMode === 'full' && canExpandFull ? 'full' : 'icons';
    const catalogWidth = mode === 'full'
      ? Math.min(preferredWidth, maximumTotalWidth)
      : TOOL_MENU_ICON_WIDTH;
    return {
      mode,
      configWidth: 0,
      catalogWidth,
      totalWidth: catalogWidth,
      canExpandFull,
    };
  }

  const configMinWidth = TOOL_MENU_FULL_MIN_WIDTH;
  const catalogMinWidth = TOOL_MENU_FULL_MIN_WIDTH;
  const fullThreshold = configMinWidth + catalogMinWidth;
  const canExpandFull = maximumTotalWidth >= fullThreshold;
  const mode = input.preferredMode === 'full' && canExpandFull ? 'full' : 'icons';

  if (mode === 'icons') {
    // UIUX (audit 2026-08-25): khi viewport tự ép full -> icons, giữ tổng width
    // liên tục tại breakpoint (560 -> 559px), tránh panel nhảy lùi hơn 100px.
    // Icons do người dùng chủ động chọn vẫn tôn trọng độ rộng config đã lưu.
    const wasForcedByViewport = input.preferredMode === 'full' && !canExpandFull;
    const configWidth = Math.max(
      0,
      wasForcedByViewport
        ? maximumTotalWidth - TOOL_MENU_ICON_WIDTH
        : Math.min(preferredWidth, maximumTotalWidth - TOOL_MENU_ICON_WIDTH),
    );
    return {
      mode,
      configWidth,
      catalogWidth: TOOL_MENU_ICON_WIDTH,
      totalWidth: configWidth + TOOL_MENU_ICON_WIDTH,
      canExpandFull,
    };
  }

  const split = resolveActiveFullSplit(preferredWidth, maximumTotalWidth);
  return {
    mode,
    configWidth: split.configWidth,
    catalogWidth: split.catalogWidth,
    totalWidth: split.totalWidth,
    canExpandFull,
  };
}

/** Kéo đúng một panel, giữ số đo panel kia và mode; draft cũng chính là số đo chốt. */
export function resizeToolMenuPanel(
  layout: EffectiveToolMenuLayout,
  target: 'config' | 'catalog',
  requestedWidth: number,
  maximumTotalWidth: number,
): EffectiveToolMenuLayout {
  if (target === 'config' && layout.configWidth <= 0
    || target === 'catalog' && layout.mode !== 'full') return layout;
  const otherWidth = target === 'config' ? layout.catalogWidth : layout.configWidth;
  const available = Math.max(0, Math.floor(maximumTotalWidth) - otherWidth);
  const minimum = Math.min(TOOL_MENU_FULL_MIN_WIDTH, available);
  const maximum = Math.min(TOOL_MENU_FULL_MAX_WIDTH, available);
  const current = target === 'config' ? layout.configWidth : layout.catalogWidth;
  const width = Math.round(Math.max(minimum, Math.min(
    maximum, Number.isFinite(requestedWidth) ? requestedWidth : current,
  )));
  const configWidth = target === 'config' ? width : layout.configWidth;
  const catalogWidth = target === 'catalog' ? width : layout.catalogWidth;
  return { ...layout, configWidth, catalogWidth, totalWidth: configWidth + catalogWidth };
}

/**
 * UIUX (audit 2026-08-29): divider nằm đúng ở mép trái catalog nên phải resize
 * catalog theo con trỏ. Giữ nguyên panel thiết lập và trả/chiếm chỗ từ Viewer;
 * nếu giữ tổng width thì divider có thể bị khóa ngay tại vị trí ban đầu.
 */
export function resolveToolMenuDividerLayout(
  layout: EffectiveToolMenuLayout,
  requestedCatalogWidth: number,
  maximumTotalWidth = layout.configWidth + TOOL_MENU_FULL_MAX_WIDTH,
): EffectiveToolMenuLayout {
  if (layout.mode !== 'full' || layout.configWidth <= 0) return layout;

  const maximumCatalogWidth = Math.min(
    TOOL_MENU_FULL_MAX_WIDTH,
    Math.floor(maximumTotalWidth) - layout.configWidth,
  );
  if (maximumCatalogWidth < TOOL_MENU_FULL_MIN_WIDTH) return layout;

  const catalogWidth = Math.round(Math.min(
    maximumCatalogWidth,
    Math.max(TOOL_MENU_FULL_MIN_WIDTH, requestedCatalogWidth),
  ));
  return {
    ...layout,
    catalogWidth,
    totalWidth: layout.configWidth + catalogWidth,
  };
}

export function resolveToolMenuDraftLayout(input: {
  totalWidth: number;
  mode: ToolMenuMode;
  hasConfigPanel: boolean;
  maximumTotalWidth: number;
  /** Preference width lúc bắt đầu gesture, dùng để giữ plateau viewport. */
  preferredWidth?: number;
}): EffectiveToolMenuLayout {
  const maximumTotalWidth = Math.max(
    TOOL_MENU_ICON_WIDTH,
    Math.floor(input.maximumTotalWidth),
  );
  const safeTotal = Math.min(
    maximumTotalWidth,
    Math.max(TOOL_MENU_ICON_WIDTH, Math.round(input.totalWidth)),
  );
  const canExpandFull = input.hasConfigPanel
    ? maximumTotalWidth >= TOOL_MENU_FULL_MIN_WIDTH * 2
    : maximumTotalWidth >= TOOL_MENU_FULL_MIN_WIDTH;

  if (!input.hasConfigPanel) {
    const mode = input.mode === 'full' && safeTotal >= TOOL_MENU_FULL_MIN_WIDTH
      ? 'full'
      : 'icons';
    const catalogWidth = mode === 'full' ? safeTotal : TOOL_MENU_ICON_WIDTH;
    return {
      mode,
      configWidth: 0,
      catalogWidth,
      totalWidth: catalogWidth,
      canExpandFull,
    };
  }

  const configMinWidth = TOOL_MENU_FULL_MIN_WIDTH;
  const catalogMinWidth = TOOL_MENU_FULL_MIN_WIDTH;
  const fullThreshold = configMinWidth + catalogMinWidth;
  if (input.mode !== 'full' || safeTotal < fullThreshold || !canExpandFull) {
    const configWidth = Math.max(0, safeTotal - TOOL_MENU_ICON_WIDTH);
    return {
      mode: 'icons',
      configWidth,
      catalogWidth: TOOL_MENU_ICON_WIDTH,
      totalWidth: configWidth + TOOL_MENU_ICON_WIDTH,
      canExpandFull,
    };
  }

  const currentSplit = input.preferredWidth === undefined
    ? null
    : resolveActiveFullSplit(input.preferredWidth, maximumTotalWidth);
  if (currentSplit && currentSplit.totalWidth === safeTotal) {
    return {
      mode: 'full',
      ...currentSplit,
      canExpandFull,
    };
  }

  const requestedCatalogWidth = safeTotal <= TOOL_MENU_FULL_DEFAULT_WIDTH * 2
    ? Math.max(catalogMinWidth, Math.floor(safeTotal / 2))
    : Math.max(catalogMinWidth, safeTotal - TOOL_MENU_FULL_DEFAULT_WIDTH);
  const split = resolveActiveFullSplit(requestedCatalogWidth, maximumTotalWidth);
  return {
    mode: 'full',
    ...split,
    canExpandFull,
  };
}

export function maxFullToolMenuWidth(
  containerWidth: number,
  hasActiveTool: boolean,
  minimumViewerWidth = TOOL_MENU_VIEWER_MIN_WIDTH,
): number {
  const maximumTotalWidth = Math.max(
    TOOL_MENU_ICON_WIDTH,
    Math.floor(containerWidth - minimumViewerWidth),
  );
  return hasActiveTool
    ? maximumCatalogWidthForBudget(maximumTotalWidth)
    : Math.min(TOOL_MENU_FULL_MAX_WIDTH, maximumTotalWidth);
}

/**
 * Chốt mode ở CUỐI gesture. Trong lúc kéo component dùng draft layout có tổng
 * khớp raw width; pointerup mới ghi mode/width vào preference.
 */
export function resolveToolMenuDrag(
  totalWidth: number,
  hasActiveTool: boolean,
  currentFullWidth: number,
  maximumFullWidth: number,
): ToolMenuDragResult {
  const configMinWidth = hasActiveTool ? TOOL_MENU_FULL_MIN_WIDTH : 0;
  const catalogMinWidth = hasActiveTool ? TOOL_MENU_FULL_MIN_WIDTH : 0;
  const minimumTotal = hasActiveTool
    ? configMinWidth + TOOL_MENU_ICON_WIDTH
    : TOOL_MENU_ICON_WIDTH;
  const safeTotal = Math.max(minimumTotal, Math.round(totalWidth));

  if (maximumFullWidth < catalogMinWidth) {
    return {
      mode: 'icons',
      fullWidth: normalizeFullToolMenuWidth(currentFullWidth),
    };
  }

  const fullThreshold = hasActiveTool
    ? configMinWidth + catalogMinWidth
    : TOOL_MENU_FULL_MIN_WIDTH;
  if (safeTotal < fullThreshold) {
    const maximumConfigWidth = hasActiveTool
      ? Math.max(
        TOOL_MENU_FULL_MIN_WIDTH,
        maximumFullWidth + configMinWidth - TOOL_MENU_ICON_WIDTH,
      )
      : maximumFullWidth;
    return {
      mode: 'icons',
      fullWidth: hasActiveTool
        ? Math.min(
          normalizeFullToolMenuWidth(Math.max(
            TOOL_MENU_ICON_WIDTH,
            safeTotal - TOOL_MENU_ICON_WIDTH,
          )),
          maximumConfigWidth,
        )
        : normalizeFullToolMenuWidth(currentFullWidth),
    };
  }

  if (hasActiveTool) {
    const maximumTotalWidth = maximumFullWidth + configMinWidth;
    const currentSplit = resolveActiveFullSplit(currentFullWidth, maximumTotalWidth);
    if (currentSplit.totalWidth === safeTotal) {
      return {
        mode: 'full',
        fullWidth: normalizeFullToolMenuWidth(currentFullWidth),
      };
    }
    const requestedCatalogWidth = safeTotal <= TOOL_MENU_FULL_DEFAULT_WIDTH * 2
      ? Math.max(catalogMinWidth, Math.floor(safeTotal / 2))
      : Math.max(catalogMinWidth, safeTotal - TOOL_MENU_FULL_DEFAULT_WIDTH);
    return {
      mode: 'full',
      fullWidth: Math.min(
        normalizeFullToolMenuWidth(requestedCatalogWidth),
        Math.max(catalogMinWidth, maximumFullWidth),
      ),
    };
  }

  return {
    mode: 'full',
    fullWidth: Math.min(
      normalizeFullToolMenuWidth(safeTotal),
      Math.max(TOOL_MENU_FULL_MIN_WIDTH, maximumFullWidth),
    ),
  };
}

export function clampToolMenuDraftTotalWidth(
  requestedTotalWidth: number,
  maximumTotalWidth: number,
  hasConfigPanel: boolean,
): number {
  const safeMaximumTotalWidth = Math.max(
    TOOL_MENU_ICON_WIDTH,
    Math.floor(maximumTotalWidth),
  );
  const requestedMinimumTotalWidth = hasConfigPanel
    ? TOOL_MENU_FULL_MIN_WIDTH + TOOL_MENU_ICON_WIDTH
    : TOOL_MENU_ICON_WIDTH;
  const minimumTotalWidth = Math.min(requestedMinimumTotalWidth, safeMaximumTotalWidth);
  return Math.round(Math.min(
    safeMaximumTotalWidth,
    Math.max(minimumTotalWidth, requestedTotalWidth),
  ));
}
