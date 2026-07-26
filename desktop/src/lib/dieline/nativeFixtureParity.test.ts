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
});
