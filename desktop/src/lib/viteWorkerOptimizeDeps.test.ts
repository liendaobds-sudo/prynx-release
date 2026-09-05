import { describe, expect, it } from 'vitest';

import {
  createViteConfig,
  PRODUCTION_MINIFY_OPTIONS,
  WORKER_ONLY_OPTIMIZED_DEPS,
} from '../../vite.config';

describe('Vite — prebundle dependency chỉ dùng trong Web Worker', () => {
  it('không để lần mở worker đầu tiên kích hoạt optimize rồi reload trang dev', () => {
    const config = createViteConfig(false);
    const includes = config.optimizeDeps?.include || [];

    expect(WORKER_ONLY_OPTIMIZED_DEPS).toEqual(['pako', 'diff']);
    expect(includes).toEqual(expect.arrayContaining([...WORKER_ONLY_OPTIMIZED_DEPS]));
  });

  it('loại console và debugger khỏi bundle phát hành nhưng giữ vòng dev', () => {
    const productionConfig = createViteConfig(true);
    const developmentConfig = createViteConfig(false);

    expect(PRODUCTION_MINIFY_OPTIONS).toMatchObject({
      compress: {
        dropConsole: true,
        dropDebugger: true,
      },
    });
    expect(productionConfig.build?.rollupOptions?.output).toMatchObject({
      minify: PRODUCTION_MINIFY_OPTIONS,
    });
    expect(productionConfig.worker?.rolldownOptions?.output).toMatchObject({
      minify: PRODUCTION_MINIFY_OPTIONS,
    });
    expect(developmentConfig.build?.rollupOptions?.output).not.toHaveProperty('minify');
    expect(developmentConfig.worker?.rolldownOptions?.output).not.toHaveProperty('minify');
  });
});
