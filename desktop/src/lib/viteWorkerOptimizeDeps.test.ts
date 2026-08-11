import type { UserConfig } from 'vite';
import { describe, expect, it } from 'vitest';

import viteConfig, { WORKER_ONLY_OPTIMIZED_DEPS } from '../../vite.config';

describe('Vite — prebundle dependency chỉ dùng trong Web Worker', () => {
  it('không để lần mở worker đầu tiên kích hoạt optimize rồi reload trang dev', () => {
    const config = viteConfig as UserConfig;
    const includes = config.optimizeDeps?.include || [];

    expect(WORKER_ONLY_OPTIMIZED_DEPS).toEqual(['pako', 'diff']);
    expect(includes).toEqual(expect.arrayContaining([...WORKER_ONLY_OPTIMIZED_DEPS]));
  });
});
