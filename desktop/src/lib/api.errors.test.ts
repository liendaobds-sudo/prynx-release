import { describe, expect, it } from 'vitest';
import { formatApiErrorDetail } from './api';

describe('formatApiErrorDetail', () => {
  it('preserves strings, objects and FastAPI validation messages', () => {
    expect(formatApiErrorDetail('bad request', 'fallback')).toBe('bad request');
    expect(formatApiErrorDetail({ code: 'bad' }, 'fallback')).toBe('{"code":"bad"}');
    expect(formatApiErrorDetail([
      { loc: ['body', 'rows'], msg: 'rows is required' },
      { msg: 'invalid value' },
    ], 'fallback')).toBe('rows is required, invalid value');
  });

  it('uses the fallback for empty and primitive-only arrays', () => {
    expect(formatApiErrorDetail([], 'fallback')).toBe('fallback');
    expect(formatApiErrorDetail([null, undefined, false, 0], 'fallback')).toBe('fallback');
    expect(formatApiErrorDetail(['', { msg: '' }], 'fallback')).toBe('fallback');
  });

  it('does not throw for circular detail objects', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatApiErrorDetail(circular, 'fallback')).toBe('fallback');
  });
});
