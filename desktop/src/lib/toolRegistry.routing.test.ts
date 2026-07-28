import { describe, expect, it } from 'vitest';
import { PREPROCESS_ROUTER_TOOLS } from '../components/imposition-tools/sections/preprocessRouterTools';
import { TOOL_REGISTRY, isImpositionFamilyTool } from './toolRegistry';

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
});