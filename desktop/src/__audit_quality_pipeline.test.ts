// @vitest-environment jsdom
import { describe, it } from 'vitest';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { imageBytesToPdfDoc } from './lib/imageNormalizer';

describe('audit quality pipeline artifact', () => {
  it('writes current JPG-to-PDF artifact', async () => {
    const input = resolve(process.cwd(), '..', 'test', 'Tem thuc pham sach Duc An.jpg');
    const outDir = resolve(process.cwd(), '..', 'tmp', 'quality_audit');
    await mkdir(outDir, { recursive: true });
    const bytes = await readFile(input);
    const doc = await imageBytesToPdfDoc(new Uint8Array(bytes), 'Tem thuc pham sach Duc An.jpg');
    const pdfBytes = await doc.save({ useObjectStreams: false });
    await writeFile(resolve(outDir, 'current_image_normalizer.pdf'), pdfBytes);
  });
});
