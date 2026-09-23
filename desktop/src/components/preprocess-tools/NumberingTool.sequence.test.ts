import { describe, expect, it } from 'vitest';

import { computeSequenceFromConfig, type FieldSequenceConfig } from './NumberingTool';

const config: FieldSequenceConfig = {
  genMethod: 'range',
  startNum: 1,
  endNum: 20,
  increment: 1,
  padZero: true,
  padLength: 3,
  prefix: 'T-',
  suffix: '',
  isShuffle: true,
  setTotal: 1,
  setStartStr: 'A',
  seqTotal: 1,
  seqStart: 1,
  formatTemplate: '{%b}-{%t}',
};

describe('Numbering sequence parity', () => {
  it('Shuffle giữ cùng một hoán vị giữa preview và output', () => {
    const first = computeSequenceFromConfig(config);
    const second = computeSequenceFromConfig({ ...config });

    expect(second).toEqual(first);
    expect(new Set(first)).toEqual(new Set(
      Array.from({ length: 20 }, (_, index) => `T-${String(index + 1).padStart(3, '0')}`),
    ));
  });
});
