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
  resolveToolMenuDividerLayout,
  resolveToolMenuDraftLayout,
  clampToolMenuDraftTotalWidth,
  resolveWorkspaceToolMenuToggle,
  resolveWorkspaceToolPanelClose,
  resizeToolMenuPanel,
  toolMenuTotalWidth,
  toolMenuRailWidth,
} from './rightToolMenuLayout';

describe('rightToolMenuLayout — hai mode', () => {
  it('lưu riêng hai chiều rộng, thu/mở menu không đổi thiết lập khi đủ chỗ', () => {
    for (const preferredMode of ['icons', 'full'] as const) {
      const layout = resolveEffectiveToolMenuLayout({ preferredMode,
        preferredFullWidth: 310, preferredConfigWidth: 530,
        containerWidth: 1500, hasConfigPanel: true });
      expect(layout.configWidth).toBe(530);
      expect(layout.catalogWidth).toBe(preferredMode === 'full' ? 310 : 48);
    }
  });

  it.each(['icons', 'full'] as const)('kéo thiết lập giữ menu ở mode %s qua ngưỡng 560/780 cũ', mode => {
    const initial = resolveEffectiveToolMenuLayout({ preferredMode: mode,
      preferredFullWidth: 310, preferredConfigWidth: 390, containerWidth: 1500, hasConfigPanel: true });
    for (const requested of [280, 400, 512, 650, 750]) {
      const draft = resizeToolMenuPanel(initial, 'config', requested, 1180);
      expect(draft).toMatchObject({ mode, configWidth: requested, catalogWidth: initial.catalogWidth });
      const settled = resolveEffectiveToolMenuLayout({ preferredMode: mode,
        preferredFullWidth: 310, preferredConfigWidth: draft.configWidth,
        containerWidth: 1500, hasConfigPanel: true });
      expect(settled).toEqual(draft);
    }
  });

  it('divider đổi riêng catalog và cặp chốt không giật panel thiết lập đang bị giới hạn', () => {
    const constrained = resolveEffectiveToolMenuLayout({ preferredMode: 'full',
      preferredFullWidth: 800, preferredConfigWidth: 390, containerWidth: 1400, hasConfigPanel: true });
    expect(constrained.configWidth).toBe(280);
    const resized = resizeToolMenuPanel(constrained, 'catalog', 650, 1080);
    expect(resized).toMatchObject({ catalogWidth: 650, configWidth: 280, mode: 'full', totalWidth: 930 });
    expect(resolveEffectiveToolMenuLayout({ preferredMode: resized.mode,
      preferredFullWidth: resized.catalogWidth, preferredConfigWidth: resized.configWidth,
      containerWidth: 1400, hasConfigPanel: true })).toEqual(resized);
  });

  it('thiếu chỗ chỉ giới hạn panel đang kéo, không thu panel kia hoặc đổi mode', () => {
    const layout = { mode: 'full' as const, configWidth: 390, catalogWidth: 310, totalWidth: 700, canExpandFull: true };
    expect(resizeToolMenuPanel(layout, 'config', 900, 900)).toMatchObject({ configWidth: 590, catalogWidth: 310, mode: 'full' });
    expect(resizeToolMenuPanel(layout, 'catalog', 900, 900)).toMatchObject({ configWidth: 390, catalogWidth: 510, mode: 'full' });
    expect(resizeToolMenuPanel(layout, 'config', NaN, 900)).toEqual(layout);
    expect(resizeToolMenuPanel(layout, 'catalog', Infinity, 900)).toEqual(layout);
  });

  it('khung cực hẹp không tràn và mở rộng lại không mất preference của hai panel', () => {
    const input = { preferredMode: 'full' as const, preferredFullWidth: 310, preferredConfigWidth: 530,
      containerWidth: 470, hasConfigPanel: true };
    expect(resolveEffectiveToolMenuLayout(input)).toMatchObject({ mode: 'icons', configWidth: 102, catalogWidth: 48, totalWidth: 150 });
    expect(resolveEffectiveToolMenuLayout({ ...input, containerWidth: 1500 })).toMatchObject({ mode: 'full', configWidth: 530, catalogWidth: 310 });
    expect(input.preferredConfigWidth).toBe(530);
    expect(input.preferredFullWidth).toBe(310);
  });

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
    [670, true, 'full', 335],
    [780, true, 'full', 390],
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

  it('icons active không bị kẹp theo budget catalog khi viewport hẹp', () => {
    expect(resolveToolMenuDrag(559, true, 390, 300)).toEqual({
      mode: 'icons',
      fullWidth: 511,
    });
    expect(resolveEffectiveToolMenuLayout({
      preferredMode: 'icons',
      preferredFullWidth: 511,
      containerWidth: 900,
      hasConfigPanel: true,
      viewerReservedWidth: 320,
    })).toEqual({
      mode: 'icons',
      configWidth: 511,
      catalogWidth: 48,
      totalWidth: 559,
      canExpandFull: true,
    });
  });

  it('thu về icons khi viewport không còn đủ panel full', () => {
    expect(resolveToolMenuDrag(600, true, 390, 250)).toEqual({
      mode: 'icons',
      fullWidth: 390,
    });
  });

  it('tổng width giữ catalog không co khi mở panel thiết lập', () => {
    expect(toolMenuTotalWidth('full', 390, false)).toBe(390);
    expect(toolMenuTotalWidth('full', 280, true)).toBe(560);
    expect(toolMenuTotalWidth('full', 390, true)).toBe(780);
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
      configWidth: 280,
      catalogWidth: 300,
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

  it('responsive full -> icons không nhảy tổng width tại breakpoint', () => {
    const atThreshold = resolveEffectiveToolMenuLayout({
      preferredMode: 'full',
      preferredFullWidth: 390,
      containerWidth: 880,
      hasConfigPanel: true,
      viewerReservedWidth: 320,
    });
    const belowThreshold = resolveEffectiveToolMenuLayout({
      preferredMode: 'full',
      preferredFullWidth: 390,
      containerWidth: 879,
      hasConfigPanel: true,
      viewerReservedWidth: 320,
    });

    expect(atThreshold.totalWidth).toBe(560);
    expect(belowThreshold).toMatchObject({
      mode: 'icons',
      catalogWidth: 48,
      totalWidth: 559,
      canExpandFull: false,
    });
  });


  it('full active giữ catalog rộng đã lưu khi viewport đủ chỗ', () => {
    expect(resolveEffectiveToolMenuLayout({
      preferredMode: 'full',
      preferredFullWidth: 800,
      containerWidth: 1400,
      hasConfigPanel: true,
      viewerReservedWidth: 320,
    })).toEqual({
      mode: 'full',
      configWidth: 280,
      catalogWidth: 800,
      totalWidth: 1080,
      canExpandFull: true,
    });
  });

  it('full active giữ đúng tổng khi preference ở ngưỡng tối thiểu', () => {
    expect(resolveEffectiveToolMenuLayout({
      preferredMode: 'full',
      preferredFullWidth: 280,
      containerWidth: 1400,
      hasConfigPanel: true,
      viewerReservedWidth: 320,
    })).toEqual({
      mode: 'full',
      configWidth: 280,
      catalogWidth: 280,
      totalWidth: 560,
      canExpandFull: true,
    });
  });

  it('divider thu catalog và trả đúng phần chiều rộng cho Viewer', () => {
    const layout = {
      mode: 'full' as const,
      configWidth: 390,
      catalogWidth: 432,
      totalWidth: 822,
      canExpandFull: true,
    };

    expect(resolveToolMenuDividerLayout(layout, 332, 1200)).toEqual({
      mode: 'full',
      configWidth: 390,
      catalogWidth: 332,
      totalWidth: 722,
      canExpandFull: true,
    });
  });

  it('divider giữ giới hạn catalog, budget tổng và bỏ qua mode icons', () => {
    const layout = {
      mode: 'full' as const,
      configWidth: 390,
      catalogWidth: 390,
      totalWidth: 780,
      canExpandFull: true,
    };
    expect(resolveToolMenuDividerLayout(layout, 100)).toMatchObject({
      configWidth: 390,
      catalogWidth: 280,
      totalWidth: 670,
    });
    expect(resolveToolMenuDividerLayout(layout, 900, 900)).toMatchObject({
      configWidth: 390,
      catalogWidth: 510,
      totalWidth: 900,
    });

    const icons = { ...layout, mode: 'icons' as const, catalogWidth: 48 };
    expect(resolveToolMenuDividerLayout(icons, 400)).toBe(icons);
  });

  it('draft resize bám con trỏ quanh threshold', () => {
    expect(clampToolMenuDraftTotalWidth(438, 900, true)).toBe(438);
    expect(clampToolMenuDraftTotalWidth(559, 900, true)).toBe(559);
    expect(clampToolMenuDraftTotalWidth(560, 900, true)).toBe(560);
  });


  it('draft resize giữ tổng width theo quỹ đạo kéo active', () => {
    const widths = [438, 559, 560, 670, 780];
    const draftTotals = widths.map((totalWidth) => {
      const settled = resolveToolMenuDrag(totalWidth, true, 390, 800);
      const draft = resolveToolMenuDraftLayout({
        totalWidth,
        mode: settled.mode,
        hasConfigPanel: true,
        maximumTotalWidth: 900,
      });
      expect(draft.mode).toBe(settled.mode);
      return draft.totalWidth;
    });
    expect(draftTotals).toEqual(widths);
  });

  it('draft active co theo budget viewport hẹp', () => {
    expect(clampToolMenuDraftTotalWidth(328, 160, true)).toBe(160);
    expect(resolveToolMenuDraftLayout({
      totalWidth: 160,
      mode: 'icons',
      hasConfigPanel: true,
      maximumTotalWidth: 160,
    })).toEqual({
      mode: 'icons',
      configWidth: 112,
      catalogWidth: 48,
      totalWidth: 160,
      canExpandFull: false,
    });
  });

  it('draft no-tool thu outer panel cùng catalog khi qua ngưỡng full', () => {
    expect(resolveToolMenuDraftLayout({
      totalWidth: 279,
      mode: 'icons',
      hasConfigPanel: false,
      maximumTotalWidth: 900,
    })).toEqual({
      mode: 'icons',
      configWidth: 0,
      catalogWidth: 48,
      totalWidth: 48,
      canExpandFull: true,
    });
  });

  it('active tool kéo được catalog thay vì khóa ở 280px', () => {
    expect(resolveToolMenuDrag(780, true, 390, 800)).toEqual({
      mode: 'full',
      fullWidth: 390,
    });
    expect(resolveToolMenuDrag(900, true, 390, 800)).toEqual({
      mode: 'full',
      fullWidth: 510,
    });
  });
});
