import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { appendVdpExecutionFeature, VDP_EXECUTION_FEATURE_IDS } from './api';

describe('VDP execution entitlement contract', () => {
  it('khóa đúng ba capability mà backend chấp nhận', () => {
    expect(VDP_EXECUTION_FEATURE_IDS).toEqual([
      'vdp.datamerge',
      'vdp.numbering',
      'vdp.cover_numbering',
    ]);
  });

  it.each(VDP_EXECUTION_FEATURE_IDS)('gửi feature_id=%s trong multipart job', (featureId) => {
    const formData = new FormData();
    appendVdpExecutionFeature(formData, featureId);
    expect(formData.get('feature_id')).toBe(featureId);
  });

  it.each([
    ['components/preprocess-tools/DataMergeTool.tsx', 'vdp.datamerge', 2],
    ['components/preprocess-tools/NumberingTool.tsx', 'vdp.numbering', 1],
    ['components/preprocess-tools/CoverNumberingTool.tsx', 'vdp.cover_numbering', 1],
  ] as const)('khóa caller %s vào đúng capability %s', (relativePath, featureId, expectedCalls) => {
    const source = readFileSync(resolve(process.cwd(), 'src', relativePath), 'utf8');
    const callLines = source
      .split(/\r?\n/)
      .filter((line) => line.includes('startVdpJobBackend(') && !line.includes('import'));

    expect(callLines).toHaveLength(expectedCalls);
    for (const line of callLines) expect(line).toContain(`'${featureId}'`);
    for (const sibling of VDP_EXECUTION_FEATURE_IDS.filter((id) => id !== featureId)) {
      for (const line of callLines) expect(line).not.toContain(`'${sibling}'`);
    }
  });
});
