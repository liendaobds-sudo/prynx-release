import { describe, expect, it } from 'vitest';
import { LOGO_REBUILD_ENABLED, PREPROCESS_ROUTER_TOOLS } from '../components/imposition-tools/sections/preprocessRouterTools';
import { TOOL_REGISTRY, findToolForLaunch, isImpositionFamilyTool } from './toolRegistry';

describe('TOOL_REGISTRY — routing công cụ vào workspace chung', () => {
  const impositionComponent = TOOL_REGISTRY.find((tool) => tool.id === 'imposition')?.component;

  it('Preflight mở từ màn hình chính bằng đúng workspace và đúng menu Preflight', () => {
    const preflight = TOOL_REGISTRY.find((tool) => tool.id === 'preflight');

    expect(preflight?.component).toBe(impositionComponent);
    expect(preflight?.defaultPayload).toEqual({ focusFeature: 'preflight' });
    expect(isImpositionFamilyTool('preflight')).toBe(true);
  });

  it('Chữ & Font mở đúng workspace và đúng panel chuyên dụng', () => {
    const fontTools = TOOL_REGISTRY.find((tool) => tool.defaultPayload?.focusFeature === 'font_tools');

    expect(fontTools?.component).toBe(impositionComponent);
    expect(fontTools?.defaultPayload).toEqual({ focusFeature: 'font_tools' });
    expect(PREPROCESS_ROUTER_TOOLS).toContain('font_tools');
  });
  it('mọi shortcut tới công cụ tiền xử lý đều dùng ImpositionTab, không tạo menu thứ hai', () => {
    const routerTools = new Set<string>(PREPROCESS_ROUTER_TOOLS);
    const integratedShortcuts = TOOL_REGISTRY.filter((tool) => {
      const focusFeature = tool.defaultPayload?.focusFeature;
      return tool.isEnabled && typeof focusFeature === 'string' && routerTools.has(focusFeature);
    });

    expect(integratedShortcuts.length).toBeGreaterThan(0);
    for (const tool of integratedShortcuts) {
      expect(tool.component, tool.title + ' dùng component khác workspace chung').toBe(impositionComponent);
      expect(isImpositionFamilyTool(tool.id), tool.title + ' thiếu props workspace chung').toBe(true);
    }
  });

  it('mọi thành viên họ Imposition dùng cùng một component', () => {
    for (const tool of TOOL_REGISTRY.filter((entry) => entry.isEnabled && isImpositionFamilyTool(entry.id))) {
      expect(tool.component, tool.title + ' bị tách sang component riêng').toBe(impositionComponent);
    }
  });
  it('chỉ đưa Logo Rebuild vào registry trong môi trường dev', () => {
    const logoRebuild = TOOL_REGISTRY.find((tool) => tool.defaultPayload?.focusFeature === 'logo_rebuild');
    expect(Boolean(logoRebuild)).toBe(LOGO_REBUILD_ENABLED);
    if (logoRebuild) {
      expect(logoRebuild.component).toBe(impositionComponent);
      expect(logoRebuild.isEnabled).toBe(true);
    }
  });

  it('fail-closed tool key lạ nhưng không gán nhầm quyền cho tab kết quả chung', () => {
    expect(findToolForLaunch('imposition', { focusFeature: 'unknown_xyz' })).toBeUndefined();
    expect(findToolForLaunch('imposition')).toBeUndefined();
    expect(findToolForLaunch('diecut')?.featureId).toBe('impo.diecut');
    expect(findToolForLaunch('paper_library')?.featureId).toBe('prepress.paper_library');
  });
});
