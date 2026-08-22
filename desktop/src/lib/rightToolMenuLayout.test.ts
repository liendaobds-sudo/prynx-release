import { describe, expect, it } from 'vitest';
import {
  TOOL_MENU_EXPANDED_CATALOG_WIDTH,
  TOOL_MENU_FULL_MAX_WIDTH,
  TOOL_MENU_FULL_MIN_WIDTH,
  TOOL_MENU_ICON_WIDTH,
  maxFullToolMenuWidth,
  modeFromLegacyLayout,
  normalizeFullToolMenuWidth,
  resolveToolMenuDrag,
  resolveEffectiveToolMenuLayout,
  clampToolMenuDraftTotalWidth,
  resolveWorkspaceToolMenuToggle,
  resolveWorkspaceToolPanelClose,
  toolMenuTotalWidth,
  toolMenuRailWidth,
} from './rightToolMenuLayout';

describe('rightToolMenuLayout — hai mode', () => {
  it.each([
    [true, 48, 'full'],
    [true, 220, 'full'],
    [false, 48, 'icons'],
    [false, 220, 'icons'],
    [false, 800, 'icons'],
  ] as const)('migrate open=%s width=%s thành %s', (open, width, expected) => {
    expect(modeFromLegacyLayout(open, width)).toBe(expected);
  });

  it.each([
    [48, false, 'icons', 390],
    [279, false, 'icons', 390],
    [280, false, 'full', 280],
    [559, true, 'icons', 511],
    [560, true, 'full', 280],
    [800, false, 'full', 800],
  ] as const)('chốt width=%s active=%s thành %s', (width, active, mode, fullWidth) => {
    expect(resolveToolMenuDrag(width, active, 390, 800)).toEqual({ mode, fullWidth });
  });

  it('mở rộng catalog nhưng vẫn giữ công cụ đang chọn', () => {
    expect(resolveWorkspaceToolMenuToggle(false)).toEqual({
      mode: 'full',
      keepActiveTool: true,
    });
    expect(resolveWorkspaceToolMenuToggle(true)).toEqual({
      mode: 'icons',
      keepActiveTool: true,
    });
  });

  it('nút X đóng thiết lập nhưng giữ nguyên trạng thái catalog', () => {
    expect(resolveWorkspaceToolPanelClose('preflight', 'full', false, false)).toEqual({
      activeTool: 'none',
      menuMode: 'full',
      closeCrop: false,
      closeObjectEdit: false,
    });
    expect(resolveWorkspaceToolPanelClose('crop', 'icons', true, false)).toEqual({
      activeTool: 'none',
      menuMode: 'icons',
      closeCrop: true,
      closeObjectEdit: false,
    });
    expect(resolveWorkspaceToolPanelClose('none', 'full', false, true).closeObjectEdit).toBe(true);
  });

  it('thu về icons khi viewport không còn đủ panel full', () => {
    expect(resolveToolMenuDrag(600, true, 390, 250)).toEqual({
      mode: 'icons',
      fullWidth: 390,
    });
  });

  it('tính tổng width chỉ còn full hoặc rail icon', () => {
    expect(toolMenuTotalWidth('full', 390, false)).toBe(390);
    expect(toolMenuTotalWidth('full', 390, true)).toBe(670);
    expect(toolMenuTotalWidth('icons', 390, true)).toBe(438);
    expect(toolMenuTotalWidth('icons', 390, false)).toBe(48);
    expect(toolMenuRailWidth('full')).toBe(TOOL_MENU_ICON_WIDTH);
    expect(toolMenuRailWidth('icons')).toBe(TOOL_MENU_ICON_WIDTH);
  });

  it('chuẩn hóa preferred full width trong biên 280..800', () => {
    expect(normalizeFullToolMenuWidth(48)).toBe(280);
    expect(normalizeFullToolMenuWidth(999)).toBe(800);
    expect(normalizeFullToolMenuWidth(Number.NaN)).toBe(390);
    expect(maxFullToolMenuWidth(1400, true)).toBe(800);
    expect(TOOL_MENU_FULL_MIN_WIDTH).toBe(280);
    expect(TOOL_MENU_EXPANDED_CATALOG_WIDTH).toBe(280);
    expect(TOOL_MENU_FULL_MAX_WIDTH).toBe(800);
  });

  it('derive width theo viewport nhưng không ghi đè preference', () => {
    expect(resolveEffectiveToolMenuLayout({
      preferredMode: 'full',
      preferredFullWidth: 800,
      containerWidth: 900,
      hasConfigPanel: true,
      viewerReservedWidth: 320,
    })).toEqual({
      mode: 'full',
      configWidth: 300,
      catalogWidth: 280,
      totalWidth: 580,
      canExpandFull: true,
    });
    expect(resolveEffectiveToolMenuLayout({
      preferredMode: 'full',
      preferredFullWidth: 800,
      containerWidth: 900,
      hasConfigPanel: true,
      viewerReservedWidth: 576,
    })).toEqual({
      mode: 'icons',
      configWidth: 276,
      catalogWidth: 48,
      totalWidth: 324,
      canExpandFull: false,
    });
  });

  it('draft resize bám con trỏ quanh threshold', () => {
    expect(clampToolMenuDraftTotalWidth(438, 900, true)).toBe(438);
    expect(clampToolMenuDraftTotalWidth(559, 900, true)).toBe(559);
    expect(clampToolMenuDraftTotalWidth(560, 900, true)).toBe(560);
  });
});
