import { describe, expect, it } from 'vitest';

import {
    applyPageSubsetAndReverse,
    formatPageSelection,
    pageIndicesToPageNumbers,
    parsePageSelection,
} from './printPageSelection';

describe('printPageSelection', () => {
    it('parse đúng danh sách trang rời rạc người dùng yêu cầu', () => {
        expect(parsePageSelection('27-28,30-33', 40)).toEqual({
            pages: [27, 28, 30, 31, 32, 33],
            error: null,
        });
    });

    it('nhận khoảng trắng/dấu gạch Unicode, chuẩn hóa range đảo và bỏ trùng', () => {
        expect(parsePageSelection(' 33–30, 31, 28 ', 40)).toEqual({
            pages: [30, 31, 32, 33, 28],
            error: null,
        });
    });

    it('fail-closed với chuỗi trống, token lỗi và trang ngoài biên', () => {
        expect(parsePageSelection('', 40).error).toEqual({ code: 'empty' });
        expect(parsePageSelection('27-28,abc', 40).error).toEqual({
            code: 'invalid_token',
            token: 'abc',
        });
        expect(parsePageSelection('27-41', 40).error).toEqual({
            code: 'out_of_range',
            page: 41,
            maxPage: 40,
        });
    });

    it('format lại danh sách canonical thành chuỗi ngắn gọn', () => {
        expect(formatPageSelection([27, 28, 30, 31, 32, 33])).toBe('27-28,30-33');
        expect(formatPageSelection([3, 2, 1])).toBe('3,2,1');
    });

    it('map selection thumbnail 0-based theo thứ tự trang đang hiển thị', () => {
        expect(pageIndicesToPageNumbers([32, 26, 27, 29, 30, 31, 32], 40))
            .toEqual([27, 28, 30, 31, 32, 33]);
    });

    it('lọc subset rồi mới đảo giống Rust', () => {
        const pages = [27, 28, 30, 31, 32, 33];
        expect(applyPageSubsetAndReverse(pages, 'even', true)).toEqual([32, 30, 28]);
    });
});
