// ============================================================
// Property test — workspaceFileSave: chuẩn hoá path để so cùng-một-file
//
// Feature: save-as-artifact-guard
//   Property 2: Chuẩn hoá path là idempotent              — Validates: Requirements 3.1
//   Property 3: Quan hệ cùng-một-file phản xạ và đối xứng — Validates: Requirements 3.1
//   Property 4: Biến thể path vô hại không đổi kết luận   — Validates: Requirements 3.1, 3.6
//
// Vì sao ba bất biến này đáng test bằng property chứ không chỉ bằng ví dụ: chốt chặn
// Save As lên artifact tạm quyết định bằng `isSameWorkspacePath`, và đầu vào của nó là
// hai chuỗi path đến từ hai nguồn khác nhau — sidecar trả path qua `os.path.abspath`,
// hộp thoại lưu trả path theo shell. Không ai bảo đảm hai bên viết cùng một mặt của
// cùng một file. Test ví dụ chỉ chốt được những mặt mà người viết test nghĩ ra.
//
// Mỗi property chạy tối thiểu 100 iteration.
// ============================================================

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { isSameWorkspacePath, workspacePathCompareKey } from '../workspaceFileSave';

const NUM_RUNS = 100;

// ------------------------------------------------------------
// Generator path Windows
// ------------------------------------------------------------

/**
 * Ký tự cho một đoạn tên thư mục hoặc tên file. Có tiếng Việt tiền tổ hợp (tên job
 * ngoài xưởng luôn có dấu), khoảng trắng giữa tên, và dấu ngoặc kiểu "ban in (1)".
 */
const SEGMENT_CHARS: readonly string[] = [
  ...'abcdefghijklmnopqrstuvwxyz',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'0123456789',
  ...'-_()#&+',
  ' ',
  ' ',
  ...'áàảãạăâêôơưđÁÀẢÃẠĂÂÊÔƠƯĐệếồỗ',
];

/**
 * Một đoạn path hợp lệ.
 *
 * `.trim()` ở đây là thu hẹp miền có chủ đích, không phải nới assert: đoạn path có
 * khoảng trắng ở đầu hoặc cuối không tồn tại trong miền đầu vào thật (Win32 cắt
 * khoảng trắng cuối của mỗi đoạn khi mở file, hộp thoại lưu và `os.path.abspath` đều
 * không trả về dạng đó). Xem ghi chú "Giới hạn miền" ở cuối file để biết vì sao đoạn
 * có khoảng trắng biên phá vỡ Property 2 — đó là finding đã báo, không phải ca cần
 * assert yếu đi.
 */
const segmentArb: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc
      .array(fc.constantFrom(...SEGMENT_CHARS), { minLength: 1, maxLength: 10 })
      .map((chars) => chars.join('').trim())
      .filter((name) => name.length > 0 && name !== '.' && name !== '..'),
  },
  {
    // Tên thật ngoài xưởng: đủ dấu tiếng Việt và khoảng trắng để chạm nhánh hoa/thường
    // của `toLowerCase` trên ký tự ngoài ASCII.
    weight: 1,
    arbitrary: fc.constantFrom(
      'Tai lieu khach',
      'Bản in thử',
      'Hộp bánh 2026',
      'Khuôn bế',
      'uploads',
      'PrynX temp',
    ),
  },
);

/** Ổ đĩa cục bộ, sinh cả hai case vì đây chính là mặt lệch của ca nguy hiểm thật. */
const driveRootArb: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom('c', 'd', 'e', 'z'), fc.boolean())
  .map(([letter, upper]) => `${upper ? letter.toUpperCase() : letter}:`);

/** Share mạng của xưởng in: tiền tố `\\` là phần Requirement 3.6 bắt phải giữ. */
const uncRootArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('may-in', 'MAY-IN-01', 'nas-xuong', 'SRV01'),
    fc.constantFrom('chia-se', 'Cong_viec', 'in-an', 'Bản kẽm'),
  )
  .map(([host, share]) => `\\\\${host}\\${share}`);

interface WindowsPathSample {
  /** Path như người dùng hoặc sidecar đưa vào. */
  readonly path: string;
  /** Đường UNC — cần biết để khẳng định riêng phần tiền tố `\\`. */
  readonly isUnc: boolean;
}

interface PathArbOptions {
  readonly root: 'drive' | 'unc' | 'any';
  /** Cho phép đoạn `..` trong chuỗi thư mục. */
  readonly allowParentSegments: boolean;
}

/**
 * Path tuyệt đối kiểu Windows: gốc + chuỗi thư mục + tên file có đuôi.
 *
 * Luôn có tên file ở cuối nên khoá chuẩn hoá không bao giờ rỗng — điều kiện để
 * `isSameWorkspacePath` nói được gì (nó fail-closed khi khoá rỗng).
 */
function absoluteWindowsPathArb(options: PathArbOptions): fc.Arbitrary<WindowsPathSample> {
  const rootArb: fc.Arbitrary<WindowsPathSample> = (() => {
    const drive = driveRootArb.map((root) => ({ path: root, isUnc: false }));
    const unc = uncRootArb.map((root) => ({ path: root, isUnc: true }));
    if (options.root === 'drive') return drive;
    if (options.root === 'unc') return unc;
    return fc.oneof(drive, unc);
  })();

  const dirSegmentArb: fc.Arbitrary<string> = options.allowParentSegments
    ? fc.oneof(
      { weight: 6, arbitrary: segmentArb },
      { weight: 1, arbitrary: fc.constant('.') },
      { weight: 1, arbitrary: fc.constant('..') },
    )
    : fc.oneof(
      { weight: 6, arbitrary: segmentArb },
      { weight: 1, arbitrary: fc.constant('.') },
    );

  const fileNameArb: fc.Arbitrary<string> = fc
    .tuple(segmentArb, fc.constantFrom('pdf', 'PDF', 'ai', 'indd', 'tif'))
    .map(([stem, ext]) => `${stem}.${ext}`);

  return fc
    .tuple(rootArb, fc.array(dirSegmentArb, { minLength: 0, maxLength: 3 }), fileNameArb)
    .map(([root, dirs, fileName]) => ({
      path: [root.path, ...dirs, fileName].join('\\'),
      isUnc: root.isUnc,
    }));
}

// ------------------------------------------------------------
// Tập biến đổi path vô hại (Property 4)
// ------------------------------------------------------------

interface PathTransform {
  readonly name: string;
  readonly apply: (path: string) => string;
}

/**
 * Năm phép biến đổi trong Property 4. Tất cả đều là những mặt khác nhau của **cùng một
 * file** mà Windows mở ra như nhau, nên kết luận cùng-một-file không được đổi.
 *
 * "Chèn `\.\`" cố ý chèn ngay trước tên file chứ không chèn ở vị trí bất kỳ: chèn sau
 * tiền tố UNC sẽ tạo ra `\\.\` — đó là không gian tên thiết bị của Win32, một path
 * hoàn toàn khác chứ không phải biến thể vô hại. Đây là thu hẹp miền cho đúng nghĩa
 * của phép biến đổi, không phải hạ yêu cầu.
 */
// Không đánh dấu `readonly` cho mảng: chữ ký `fc.shuffledSubarray` đòi mảng mutable
// (nó tự copy bên trong, không sửa đầu vào). Từng phần tử vẫn readonly.
const HARMLESS_TRANSFORMS: PathTransform[] = [
  { name: 'đổi sang chữ hoa', apply: (path) => path.toUpperCase() },
  { name: 'đổi sang chữ thường', apply: (path) => path.toLowerCase() },
  { name: 'đổi \\ thành /', apply: (path) => path.replace(/\\/g, '/') },
  { name: 'nhân đôi dấu phân cách', apply: (path) => path.replace(/[\\/]/g, (sep) => sep + sep) },
  {
    name: 'chèn đoạn "." trước tên file',
    apply: (path) => path.replace(/([\\/])([^\\/]+)$/, '$1.$1$2'),
  },
  { name: 'thêm dấu phân cách cuối', apply: (path) => `${path}\\` },
];

/** Path "bẩn" như thực tế: đã đi qua vài phép biến đổi vô hại trước khi tới hàm. */
const messyWindowsPathArb: fc.Arbitrary<WindowsPathSample> = fc
  .tuple(
    absoluteWindowsPathArb({ root: 'any', allowParentSegments: true }),
    fc.shuffledSubarray(HARMLESS_TRANSFORMS),
  )
  .map(([sample, transforms]) => ({
    path: transforms.reduce((current, transform) => transform.apply(current), sample.path),
    isUnc: sample.isUnc,
  }));

/** Tách khoá chuẩn hoá thành các đoạn, bỏ tiền tố UNC ra ngoài. */
function keySegments(key: string): readonly string[] {
  const body = key.startsWith('\\\\') ? key.slice(2) : key;
  return body.length === 0 ? [] : body.split('\\');
}

// ------------------------------------------------------------
// Property 2
// ------------------------------------------------------------

// Feature: save-as-artifact-guard, Property 2: Chuẩn hoá path là idempotent
//
// **Validates: Requirements 3.1**
describe('workspacePathCompareKey — Property 2: Chuẩn hoá path là idempotent', () => {
  it('khoá của khoá bằng chính khoá với mọi path Windows sinh ra', () => {
    fc.assert(
      fc.property(messyWindowsPathArb, ({ path }) => {
        const once = workspacePathCompareKey(path);
        expect(workspacePathCompareKey(once)).toBe(once);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('áp nhiều lần cũng không dao động: lần thứ ba bằng lần thứ nhất', () => {
    // Idempotent thật thì khoá là điểm bất động. Kiểm ba lần để bắt ca dao động
    // chu kỳ 2 (áp lần nữa thì đổi, áp thêm lần nữa thì về chỗ cũ).
    fc.assert(
      fc.property(messyWindowsPathArb, ({ path }) => {
        const once = workspacePathCompareKey(path);
        const twice = workspacePathCompareKey(once);
        const thrice = workspacePathCompareKey(twice);
        expect(twice).toBe(once);
        expect(thrice).toBe(once);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('khoá ra ở dạng chuẩn nên không còn gì để chuẩn hoá thêm', () => {
    // Đây là lý do idempotent đúng, phát biểu dưới dạng kiểm được: khoá đã hạ
    // hoa/thường, chỉ dùng `\`, không còn đoạn rỗng hay đoạn `.`, và tiền tố `\\`
    // của UNC còn hay mất đúng theo đầu vào (Requirement 3.6).
    fc.assert(
      fc.property(messyWindowsPathArb, ({ path, isUnc }) => {
        const key = workspacePathCompareKey(path);
        expect(key).toBe(key.toLowerCase());
        expect(key.includes('/')).toBe(false);
        expect(key.startsWith('\\\\')).toBe(isUnc);
        for (const segment of keySegments(key)) {
          expect(segment).not.toBe('');
          expect(segment).not.toBe('.');
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ------------------------------------------------------------
// Property 3
// ------------------------------------------------------------

// Feature: save-as-artifact-guard, Property 3: Quan hệ cùng-một-file phản xạ và đối xứng
//
// **Validates: Requirements 3.1**
describe('isSameWorkspacePath — Property 3: Quan hệ cùng-một-file phản xạ và đối xứng', () => {
  it('phản xạ: mọi path Windows tuyệt đối cùng-một-file với chính nó', () => {
    // Phản xạ không phải chuyện hiển nhiên: hàm fail-closed khi khoá chuẩn hoá rỗng,
    // nên nó chỉ đúng trên miền path thật. Xem "Giới hạn miền" ở cuối file.
    fc.assert(
      fc.property(messyWindowsPathArb, ({ path }) => {
        expect(isSameWorkspacePath(path, path)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('đối xứng: đổi chỗ hai vế không đổi kết luận, kể cả với chuỗi rác', () => {
    // Miền rộng có chủ đích: `undefined`, chuỗi rỗng, path suy biến như `.` hay `\`.
    // Đối xứng phải đúng trên toàn miền vì call site không kiểm soát được thứ tự
    // truyền: có chỗ so `file.path` với đích, có chỗ so đích với `file.path`.
    const anyPathArb: fc.Arbitrary<string | undefined> = fc.oneof(
      { weight: 4, arbitrary: messyWindowsPathArb.map(({ path }) => path) },
      { weight: 1, arbitrary: fc.string() },
      {
        weight: 1,
        arbitrary: fc.constantFrom<string | undefined>(
          '',
          '   ',
          '.',
          '..',
          '\\',
          '/',
          '\\\\',
          'D:',
          undefined,
        ),
      },
    );

    fc.assert(
      fc.property(anyPathArb, anyPathArb, (left, right) => {
        expect(isSameWorkspacePath(left, right)).toBe(isSameWorkspacePath(right, left));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('đối xứng cả trên cặp thật sự cùng-một-file, không chỉ trên cặp khác nhau', () => {
    // Nếu chỉ sinh cặp độc lập thì gần như mọi iteration đều cho `false === false`,
    // và đối xứng của nhánh `true` không được kiểm. Cặp dưới đây luôn cùng một file.
    fc.assert(
      fc.property(
        absoluteWindowsPathArb({ root: 'any', allowParentSegments: true }),
        fc.shuffledSubarray(HARMLESS_TRANSFORMS, { minLength: 1 }),
        ({ path }, transforms) => {
          const variant = transforms.reduce(
            (current, transform) => transform.apply(current),
            path,
          );
          expect(isSameWorkspacePath(path, variant)).toBe(true);
          expect(isSameWorkspacePath(variant, path)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ------------------------------------------------------------
// Property 4
// ------------------------------------------------------------

// Feature: save-as-artifact-guard, Property 4: Biến thể path vô hại không đổi kết luận
//
// **Validates: Requirements 3.1, 3.6**
describe('isSameWorkspacePath — Property 4: Biến thể path vô hại không đổi kết luận', () => {
  it('mỗi phép biến đổi vô hại đơn lẻ vẫn cho ra cùng-một-file', () => {
    fc.assert(
      fc.property(
        absoluteWindowsPathArb({ root: 'any', allowParentSegments: true }),
        fc.constantFrom(...HARMLESS_TRANSFORMS),
        ({ path }, transform) => {
          expect(isSameWorkspacePath(path, transform.apply(path))).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('chuỗi nhiều phép biến đổi ghép lại vẫn cho ra cùng-một-file', () => {
    // Ca thật hay là ca ghép: hộp thoại trả `d:/uploads//9f2c.PDF\` chứ ít khi trả
    // đúng một mặt lệch duy nhất.
    fc.assert(
      fc.property(
        absoluteWindowsPathArb({ root: 'any', allowParentSegments: true }),
        fc.shuffledSubarray(HARMLESS_TRANSFORMS, { minLength: 2 }),
        ({ path }, transforms) => {
          const variant = transforms.reduce(
            (current, transform) => transform.apply(current),
            path,
          );
          expect(isSameWorkspacePath(path, variant)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('path UNC giữ tiền tố \\\\ sau mọi biến đổi, không thành path tương đối', () => {
    // Requirement 3.6. Sinh riêng không có đoạn `..` vì `..` có thể ăn mất tên máy
    // chủ (`\\may-in\..\a.pdf`), khi đó ca không nói được gì về việc giữ tiền tố.
    fc.assert(
      fc.property(
        absoluteWindowsPathArb({ root: 'unc', allowParentSegments: false }),
        fc.shuffledSubarray(HARMLESS_TRANSFORMS, { minLength: 1 }),
        ({ path }, transforms) => {
          const variant = transforms.reduce(
            (current, transform) => transform.apply(current),
            path,
          );
          const originalKey = workspacePathCompareKey(path);
          const variantKey = workspacePathCompareKey(variant);

          expect(originalKey.startsWith('\\\\')).toBe(true);
          expect(variantKey.startsWith('\\\\')).toBe(true);
          // Tên máy chủ vẫn là đoạn đầu: gộp mất `\\` sẽ biến nó thành thư mục con
          // của thư mục hiện tại, và hai share khác máy sẽ trùng khoá.
          expect(keySegments(variantKey)[0]).toBe(keySegments(originalKey)[0]);
          expect(variantKey).toBe(originalKey);
          expect(isSameWorkspacePath(path, variant)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ------------------------------------------------------------
// Giới hạn miền — hai ca đã cố tình để ngoài generator
// ------------------------------------------------------------
//
// 1. Đoạn cuối kết thúc bằng khoảng trắng, kèm dấu phân cách cuối, phá vỡ Property 2.
//    `workspacePathCompareKey` gọi `path.trim()` đúng một lần ở đầu, nên khoảng trắng
//    đó không bị cắt (nó nằm giữa chuỗi), lọt vào khoá ở vị trí biên, rồi mới bị cắt ở
//    lần áp thứ hai. Counterexample đã đo trên chính hàm export:
//      key('c:\\a\\ten file \\') === 'c:\\a\\ten file '
//      key('c:\\a\\ten file ')   === 'c:\\a\\ten file'   ← đổi ở lần thứ hai
//    Vì sao để ngoài miền chứ không hạ assert: khoá chỉ dùng để so hai path với nhau,
//    không bao giờ được đưa lại vào hàm, nên bất biến bị vỡ không đổi kết luận nào ở
//    call site. Miền thật cũng không tới được dạng này — đích lưu luôn kết thúc bằng
//    tên file có đuôi, và Win32 cắt khoảng trắng cuối của từng đoạn khi mở file.
//    Generator ở trên chặn dạng này bằng hai lớp: `segmentArb` trim mỗi đoạn, và tên
//    file luôn có đuôi nên đoạn cuối không thể kết thúc bằng khoảng trắng.
//    Sửa `workspaceFileSave.ts` là việc cần duyệt riêng, không làm trong task test.
//
// 2. Path chuẩn hoá về rỗng (`.`, `\`, `/`, chuỗi toàn khoảng trắng) không phản xạ:
//    `isSameWorkspacePath(p, p)` trả `false` vì `leftKey.length > 0` không thoả. Đó
//    là fail-closed đúng hướng cho việc bỏ ghi (`canReuseExistingWorkspaceSource`),
//    nhưng là hướng lỏng cho việc từ chối (`isUnsafeWorkspaceArtifactDestination`).
//    Không tới được trong thực tế vì mọi path vào plan đều là path tuyệt đối, nên
//    Property 3 chạy trên miền path tuyệt đối; nhánh đối xứng vẫn phủ cả ca suy biến.
