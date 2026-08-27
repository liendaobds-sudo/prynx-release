// @vitest-environment jsdom
/**
 * Chống trôi hình thức giữa `PanelPrimitives.tsx` và `imposition-tools/SharedUI.tsx`.
 *
 * `PanelPrimitives` **nhân bản** `Divider`/`Checkbox`/`Accordion` thay vì import, vì import
 * `SharedUI` kéo cả `ToolItem` → `ToolHelpModal` → `ProFeatureBadge` → `useAuthStore` vào
 * lazy chunk của một tool standalone (đo được: một test render tab nền vượt 5 giây rồi
 * timeout chỉ vì phải nạp lại cây đó).
 *
 * Đánh đổi của nhân bản là nguy cơ lệch hình thức. Test này đọc **chính** `SharedUI.tsx` và
 * đòi từng chuỗi class còn nguyên ở đó. Ai sửa SharedUI mà quên bên này sẽ thấy test đỏ,
 * thay vì để người dùng phát hiện hai công cụ nhìn khác nhau.
 */
import fs from 'node:fs';
import path from 'node:path';

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SharedUiClassProbe } from './PanelPrimitives';

const SHARED_UI_PATH = path.resolve(
  process.cwd(),
  'src',
  'components',
  'imposition-tools',
  'SharedUI.tsx',
);

function classProbe(): Record<string, string> {
  const { container } = render(<SharedUiClassProbe />);
  const node = container.querySelector('span');
  expect(node).toBeTruthy();
  const values: Record<string, string> = {};
  for (const attribute of node!.getAttributeNames()) {
    if (attribute.startsWith('data-')) values[attribute] = node!.getAttribute(attribute) ?? '';
  }
  return values;
}

describe('PanelPrimitives khớp SharedUI', () => {
  const source = fs.readFileSync(SHARED_UI_PATH, 'utf8');

  it('SharedUI vẫn là file có thật và vẫn export ba primitive được nhân bản', () => {
    for (const name of ['Divider', 'Checkbox', 'Accordion']) {
      expect(source).toContain(`export const ${name}`);
    }
  });

  it('mọi chuỗi class đã nhân bản còn nguyên trong SharedUI', () => {
    const probe = classProbe();
    // Bản nhân đôi phải là chuỗi con của SharedUI. So từng cái để báo lỗi chỉ đúng chỗ lệch.
    const lech: string[] = [];
    for (const [attribute, value] of Object.entries(probe)) {
      if (!value) {
        lech.push(`${attribute}: rỗng`);
        continue;
      }
      if (!source.includes(value)) lech.push(`${attribute}: "${value}"`);
    }
    expect(lech).toEqual([]);
  });

  it('KHÔNG import SharedUI vào tool standalone — đó là lý do phải nhân bản', () => {
    const folder = path.resolve(process.cwd(), 'src', 'components', 'mixed-nesting');
    // Bắt CÂU LỆNH import, không bắt chuỗi con: chính file này có tên đó trong comment
    // giải thích, và một test bắt substring sẽ tự tố cáo phần tài liệu của nó.
    const importPattern = /(?:^|\n)\s*import[^;]*from\s*['"][^'"]*imposition-tools\/SharedUI['"]/;
    const offenders = fs
      .readdirSync(folder)
      .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
      .filter((name) => importPattern.test(fs.readFileSync(path.join(folder, name), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
