import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('PreprocessingRouter — resolver Working PDF', () => {
    it('Upscale dùng resolver execution có Edit barrier, Resize preview giữ resolver không commit nền', () => {
        const source = readFileSync(
            resolve(process.cwd(), 'src/components/imposition-tools/sections/PreprocessingRouter.tsx'),
            'utf8',
        );
        const resizeBlock = source.match(/<PageResizerTool[\s\S]*?\/>/)?.[0] || '';
        const cleanupBlock = source.match(/<DocumentCleanupTool[\s\S]*?\/>/)?.[0] || '';
        const upscaleBlock = source.match(/<UpscaleTool[\s\S]*?\/>/)?.[0] || '';

        expect(resizeBlock).toContain('getWorkingFile={getWorkingFile}');
        expect(resizeBlock).not.toContain('getPreparedWorkingFile');
        expect(cleanupBlock).toContain('getWorkingFile={getPreparedWorkingFile}');
        expect(upscaleBlock).toContain('getWorkingFile={getPreparedWorkingFile}');
        expect(upscaleBlock).not.toContain('getWorkingFile={getWorkingFile}');
    });
});
