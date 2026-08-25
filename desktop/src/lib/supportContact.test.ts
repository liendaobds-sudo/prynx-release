import { describe, expect, it } from 'vitest';
import { SUPPORT } from './supportContact';

describe('SUPPORT', () => {
  it('giữ nguyên các kênh hỗ trợ chính thức của PrynX', () => {
    expect(SUPPORT).toEqual({
      website: 'https://printsolutions.vn',
      product: 'https://printsolutions.vn/product/prynx',
      email: 'khanhpham.print@gmail.com',
      phone: '0862160492',
      zalo: 'https://zalo.me/0862160492',
    });
  });
});
