// ============================================================
// Fixture của crate `native` phải ĐỦ THAM SỐ so với DEFAULT_PARAMS.
//
// VÌ SAO (audit 2026-07-26): `runtimeValidation.ts` yêu cầu request có ĐỦ MỌI key của
// `DEFAULT_PARAMS` (`Thiếu params.<key>.`). Khi thêm tham số mới cho một loại hộp (vd
// `ABD` của auto_bottom), `native/tests/fixtures/dieline_default_request.json` không
// được cập nhật theo ⇒ hai test Rust `bundled_engine_warms_then_generates_default_dieline`
// và `bundled_slb_has_only_one_visible_tuck_fold` fail với lý do khó hiểu, và chỉ phát
// hiện khi ai đó chạy được `cargo test` (vốn cần toolchain Python + native).
//
// Test này chạy trong vitest nên bắt lệch NGAY ở CI frontend, không cần Rust.
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_PARAMS } from './types';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, '../../../../native/tests/fixtures/dieline_default_request.json');

describe('fixture engine của native khớp DEFAULT_PARAMS', () => {
    it('có đủ mọi key mà runtimeValidation yêu cầu', () => {
        const raw = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as { params: Record<string, unknown> };
        const missing = Object.keys(DEFAULT_PARAMS).filter((key) => !(key in raw.params));
        expect(
            missing,
            `Thiếu key trong ${FIXTURE}: ${missing.join(', ')} — cập nhật fixture khi thêm tham số mới`,
        ).toEqual([]);
    });

    it('không chứa key lạ (fixture không lệch khỏi hợp đồng params)', () => {
        const raw = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as { params: Record<string, unknown> };
        const unknown = Object.keys(raw.params).filter((key) => !(key in DEFAULT_PARAMS));
        expect(unknown, `Key lạ trong fixture: ${unknown.join(', ')}`).toEqual([]);
    });

    // [HANGING-WINDOW 2026-07-27] Cùng TẬP KHOÁ, không chỉ "đủ" hay "không lạ":
    // hai chiều kiểm ở trên đã bao trùm nhau, nhưng ràng buộc tập khoá bằng nhau
    // nói rõ ý định cho người đọc sau và chốt yêu cầu parity 7.5.
    it('có cùng tập khoá với DEFAULT_PARAMS', () => {
        const raw = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as { params: Record<string, unknown> };
        expect(Object.keys(raw.params).sort()).toEqual(Object.keys(DEFAULT_PARAMS).sort());
    });

    // [HANGING-WINDOW 2026-07-27] Chốt riêng bốn khoá của hộp treo có cửa sổ.
    // Nếu ai đó xoá/đổi tên khoá ở một phía, test này chỉ đúng tên khoá bị lệch
    // thay vì để lẫn trong danh sách chung.
    it('có đủ bốn khoá riêng của hộp treo có cửa sổ và đúng kiểu dữ liệu', () => {
        const raw = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as { params: Record<string, unknown> };
        const hangingKeys = ['hgbWindow', 'WNW', 'WNH', 'HTH'] as const;

        const missing = hangingKeys.filter((key) => !(key in raw.params));
        expect(
            missing,
            `Fixture thiếu khoá hộp treo: ${missing.join(', ')} — cập nhật ${FIXTURE}`,
        ).toEqual([]);

        // Kiểu dữ liệu phải khớp DEFAULT_PARAMS, vì runtimeValidation ở phía Rust
        // từ chối request sai kiểu (bool ↔ number) trước khi vào engine.
        for (const key of hangingKeys) {
            expect(
                typeof raw.params[key],
                `Khoá ${key} trong fixture sai kiểu so với DEFAULT_PARAMS`,
            ).toBe(typeof DEFAULT_PARAMS[key]);
        }
    });
});
