import { describe, it, expect } from 'vitest';
import { parsePastedQuantities } from './parsePastedQuantities';

describe('parsePastedQuantities', () => {
  it('đọc cột số lượng thuần', () => {
    const r = parsePastedQuantities('720\n30\n480\n185');
    expect(r).toEqual({ ok: true, quantities: [720, 30, 480, 185] });
  });

  it('bỏ dòng trống thừa Ở CUỐI (Excel hay thêm newline)', () => {
    const r = parsePastedQuantities('720\n30\n\n');
    expect(r).toEqual({ ok: true, quantities: [720, 30] });
  });

  it('hiểu ngăn nghìn dấu chấm kiểu VN ("1.234" = 1234)', () => {
    const r = parsePastedQuantities('1.234\n56');
    expect(r).toEqual({ ok: true, quantities: [1234, 56] });
  });

  it('hiểu ngăn nghìn dấu phẩy ("12,345")', () => {
    const r = parsePastedQuantities('12,345');
    expect(r).toEqual({ ok: true, quantities: [12345] });
  });

  it('hiểu ngăn nghìn bằng space ("1 234")', () => {
    const r = parsePastedQuantities('1 234');
    expect(r).toEqual({ ok: true, quantities: [1234] });
  });

  // ── Các ca hiểm: PHẢI báo lỗi, không được nuốt ──

  it('CHẶN dán nhầm cột kích thước ("5x10cm")', () => {
    const r = parsePastedQuantities('720\n5x10cm\n480');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Dòng 2');
  });

  it('CHẶN cột kích thước có số thập phân ("3.7x6.4cm")', () => {
    const r = parsePastedQuantities('3.7x6.4cm');
    expect(r.ok).toBe(false);
  });

  it('CHẶN dán 2 cột (có tab)', () => {
    const r = parsePastedQuantities('720\t3.7x6.4cm\n30\t5x10cm');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('nhiều cột');
  });

  it('CHẶN ô trống Ở GIỮA (làm lệch trang) — chỉ rõ dòng', () => {
    const r = parsePastedQuantities('720\n\n480');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Dòng 2');
  });

  it('CHẶN số thập phân thật ("1.5" không đủ 3 số sau dấu) thay vì đoán 15', () => {
    const r = parsePastedQuantities('1.5');
    expect(r.ok).toBe(false);
  });

  it('CHẶN text hoàn toàn không phải số', () => {
    const r = parsePastedQuantities('abc\n30');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Dòng 1');
  });

  it('rỗng → báo chưa có dữ liệu', () => {
    const r = parsePastedQuantities('\n\n');
    expect(r.ok).toBe(false);
  });

  // ── Guard đếm dòng ──

  it('lệch số dòng vs số trang → báo lỗi', () => {
    const r = parsePastedQuantities('720\n30', 3);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('2 dòng');
  });

  it('khớp số dòng vs số trang → ok', () => {
    const r = parsePastedQuantities('720\n30\n480', 3);
    expect(r).toEqual({ ok: true, quantities: [720, 30, 480] });
  });

  it('ưu tiên lỗi "dán nhầm cột" (rõ dòng) hơn lỗi lệch tổng', () => {
    // 3 dòng, expected 3, nhưng dòng 2 là size → phải báo lỗi dòng 2, không báo lệch tổng
    const r = parsePastedQuantities('720\n5x10cm\n480', 3);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Dòng 2');
  });
});
