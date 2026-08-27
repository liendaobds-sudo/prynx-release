import { describe, expect, it } from 'vitest';
import { LOGO_REBUILD_ENABLED, PREPROCESS_ROUTER_TOOLS } from '../components/imposition-tools/sections/preprocessRouterTools';
import {
  MIXED_NESTING_BACKEND_FLAG_NAME,
  MIXED_NESTING_ENABLED,
  MIXED_NESTING_FLAG_NAME,
  isMixedNestingEnabled,
} from './mixed-nesting/rollout';
import {
  TOOL_REGISTRY,
  findToolByUniqueKey,
  findToolForLaunch,
  getToolUniqueKey,
  isImpositionFamilyTool,
  toolMatchesQuery,
} from './toolRegistry';

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

// ─────────────────────────────────────────────────────────────────────────────
//  Bình lồng ghép tự do — AppTool standalone (phase P9)
//  Kế hoạch 2026-08-26 §7, §16.4.
// ─────────────────────────────────────────────────────────────────────────────

describe('mixed_nesting — AppTool standalone', () => {
  const entries = TOOL_REGISTRY.filter((tool) => tool.id === 'mixed_nesting');

  it('có ĐÚNG MỘT entry khi cờ rollout bật, và biến mất hoàn toàn khi tắt', () => {
    expect(entries.length).toBe(MIXED_NESTING_ENABLED ? 1 : 0);
  });

  it('KHÔNG thuộc họ Imposition và không dùng component của ImpositionTab', () => {
    // Đây là ranh giới kiến trúc quan trọng nhất của tính năng: lọt vào họ Imposition
    // là dùng chung workspace, menu, và bộ props của ImpositionTab.
    expect(isImpositionFamilyTool('mixed_nesting')).toBe(false);
    for (const tool of entries) {
      expect(tool.component).not.toBe(impositionComponentRef());
    }
  });

  it('không đặt trong ImpositionTab và không mang defaultPayload routing', () => {
    for (const tool of entries) {
      // `defaultPayload.focusFeature`/`lockedMode` là cơ chế routing vào workspace chung.
      expect(tool.defaultPayload).toBeUndefined();
      expect(getToolUniqueKey(tool)).toBe('mixed_nesting');
    }
  });

  it('dùng capability RIÊNG, không mượn quyền của tool cũ', () => {
    for (const tool of entries) {
      expect(tool.featureId).toBe('impo.mixed_nesting');
      expect(tool.featureId).not.toBe('impo.diecut');
      expect(tool.featureId).not.toBe('packaging.dieline');
    }
  });

  it('resolve được qua findToolForLaunch bằng chính appId', () => {
    const resolved = findToolForLaunch('mixed_nesting');
    if (MIXED_NESTING_ENABLED) {
      expect(resolved?.featureId).toBe('impo.mixed_nesting');
      expect(findToolByUniqueKey('mixed_nesting')).toBe(resolved);
    } else {
      // Cờ tắt: registry không có entry → fail-closed, không có đường mở trực tiếp.
      expect(resolved).toBeUndefined();
      expect(findToolByUniqueKey('mixed_nesting')).toBeUndefined();
    }
  });

  it('không chiếm chỗ hay đổi hành vi của tool cũ', () => {
    expect(findToolForLaunch('diecut')?.featureId).toBe('impo.diecut');
    expect(findToolForLaunch('dieline')?.featureId).toBe('packaging.dieline');
    expect(findToolForLaunch('paper_library')?.featureId).toBe('prepress.paper_library');
    // Quyền mới không lọt vào bất kỳ entry nào khác.
    const nhamLan = TOOL_REGISTRY.filter(
      (tool) => tool.featureId === 'impo.mixed_nesting' && tool.id !== 'mixed_nesting',
    );
    expect(nhamLan).toEqual([]);
  });

  it('cờ frontend là quy tắc thuần, mặc định HOLD ở bản phát hành', () => {
    expect(isMixedNestingEnabled(false, false)).toBe(false);
    expect(isMixedNestingEnabled(false, true)).toBe(true);
    expect(isMixedNestingEnabled(true, false)).toBe(true);
    expect(isMixedNestingEnabled(true, true)).toBe(true);
  });

  it('tên hai cờ khớp kế hoạch để pipeline phát hành probe được cặp cờ', () => {
    expect(MIXED_NESTING_FLAG_NAME).toBe('VITE_MIXED_NESTING_ENABLED');
    expect(MIXED_NESTING_BACKEND_FLAG_NAME).toBe('PRYNX_MIXED_NESTING_ENABLED');
  });

  it('có từ khoá tìm kiếm để tìm được bằng cả tiếng Việt và tiếng Anh', () => {
    if (!MIXED_NESTING_ENABLED) return;
    const tool = entries[0];
    for (const query of ['long ghep', 'lồng ghép', 'nesting', 'free angle', 'xoay tu do']) {
      expect(toolMatchesQuery(tool, query), query).toBe(true);
    }
    expect(toolMatchesQuery(tool, 'khong-lien-quan-gi-ca')).toBe(false);
  });
});

function impositionComponentRef() {
  return TOOL_REGISTRY.find((tool) => tool.id === 'imposition')?.component;
}
