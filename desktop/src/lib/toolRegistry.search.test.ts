import { describe, expect, it } from 'vitest';

import {
  TOOL_KEYWORDS,
  TOOL_REGISTRY,
  getToolUniqueKey,
  toolMatchesQuery,
} from './toolRegistry';

function findTool(key: string) {
  const tool = TOOL_REGISTRY.find((entry) => getToolUniqueKey(entry) === key);
  if (!tool) throw new Error(`Không tìm thấy công cụ ${key}`);
  return tool;
}

describe('toolMatchesQuery — tìm công cụ song ngữ', () => {
  it('mọi công cụ đang bật đều có bộ từ khóa bổ sung', () => {
    const missingKeys = TOOL_REGISTRY
      .filter((tool) => tool.isEnabled)
      .map(getToolUniqueKey)
      .filter((key) => !TOOL_KEYWORDS[key]?.trim());

    expect(missingKeys).toEqual([]);
  });

  it.each([
    ['resize', 'page scaling'],
    ['crop', 'cut page canvas'],
    ['preflight', 'print ready validation'],
    ['font_tools', 'font embedding'],
    ['inkmanager', 'ink separations'],
    ['sticker_imposer', 'die cut label'],
    ['booklet', 'signature imposition'],
    ['encrypt', 'password protection'],
    ['office_convert', 'spreadsheet export'],
    ['document_cleanup', 'deskew card'],
  ])('giao diện Việt vẫn tìm %s bằng tiếng Anh: %s', (key, query) => {
    expect(toolMatchesQuery(findTool(key), query)).toBe(true);
  });

  it.each([
    ['resize', 'đổi kích thước trang'],
    ['font_tools', 'nhúng phông chữ'],
    ['inkmanager', 'tách màu mực'],
    ['sticker_imposer', 'bình tem nhãn'],
    ['encrypt', 'bảo vệ mật khẩu'],
    ['document_cleanup', 'nắn thẻ làm trắng'],
  ])('vẫn tìm %s bằng tiếng Việt có dấu: %s', (key, query) => {
    expect(toolMatchesQuery(findTool(key), query)).toBe(true);
  });

  it('cho phép kết hợp từ khóa tiếng Việt và tiếng Anh trong cùng truy vấn', () => {
    expect(toolMatchesQuery(findTool('pages'), 'quản lý page')).toBe(true);
    expect(toolMatchesQuery(findTool('sticker'), 'tạo cutline tem')).toBe(true);
  });
});
