// ============================================================
// Property test — workspaceFileSave.planWorkspaceSaveWrite
//
// Feature: save-as-artifact-guard, Property 5: Không chặn oan
// **Validates: Requirements 3.2, 4.4**
//
// Feature: save-as-artifact-guard, Property 8: Hai đường ghi loại trừ nhau
// **Validates: Requirements 4.5**
//
// Vì sao cần property test bên cạnh test ví dụ: chốt chặn artifact được thắt bằng
// cách chuẩn hoá path (hạ hoa/thường, gộp dấu phân cách, giải `.` và `..`). Mỗi lần
// nới chuẩn hoá để bắt thêm một mặt path là một lần có nguy cơ chặn oan lượt lưu hợp
// lệ của khách. Test ví dụ chỉ khoá được các mặt path đã nghĩ ra; property test dò
// toàn miền path Windows nên bắt được ca chặn oan mà không ai nghĩ tới.
//
// Mỗi property chạy tối thiểu 100 iteration.
// ============================================================

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { markGeneratedWorkspaceFile } from '../nativeFileAccess';
import {
  planWorkspaceSaveWrite,
  workspacePathCompareKey,
  type WorkspaceSaveWritePlan,
} from '../workspaceFileSave';

const NUM_RUNS = 100;

// ------------------------------------------------------------
// Generator path Windows
// ------------------------------------------------------------

/**
 * Path Windows dạng thành phần để biến đổi được từng phần một.
 *
 * `root` gộp cả hai dạng gốc thật: ổ cục bộ (`D:`) và share mạng (`\\may-in\san-xuat`).
 * Gộp như vậy vì phần sau gốc thì hai dạng hoàn toàn giống nhau, còn tách thành union
 * thì mọi phép biến đổi phải viết hai lần mà không kiểm thêm được gì.
 */
interface WindowsPathParts {
  root: string;
  segments: readonly string[];
  name: string;
}

const LOCAL_ROOTS = ['C:', 'D:', 'E:', 'Z:'] as const;
// Share mạng thật của xưởng in: chuẩn hoá phải giữ tiền tố `\\`, nếu gộp mất nó thì
// path share biến thành path tương đối và hai file khác nhau bị coi là một.
const UNC_ROOTS = ['\\\\may-in\\san-xuat', '\\\\nas-xuong-in\\chia-se'] as const;
const ALL_ROOTS: readonly string[] = [...LOCAL_ROOTS, ...UNC_ROOTS];

// Thư mục có dấu cách và dấu tiếng Việt để chuẩn hoá không được dựa vào giả định ASCII.
const DIR_SEGMENTS: readonly string[] = [
  'PrynX',
  'uploads',
  'temp',
  'Khach',
  'Ket qua',
  'don-hang-2026',
  'results',
  'Tài liệu',
];

// Gồm cả cặp tên gần giống nhau (`artifact.pdf` vs `artifact_2.pdf`) vì đó là hình
// dạng dễ chặn oan nhất: cùng thư mục, cùng đuôi, khác đúng một hậu tố.
const FILE_NAMES: readonly string[] = [
  'artifact.pdf',
  'artifact_2.pdf',
  '9f2c8ad1.pdf',
  'Hop_dong.pdf',
  'ket-qua-binh-ban.pdf',
  'Tài liệu.pdf',
];

function renderWindowsPath(parts: WindowsPathParts): string {
  return [parts.root, ...parts.segments, parts.name].join('\\');
}

const pathPartsArb: fc.Arbitrary<WindowsPathParts> = fc.record({
  root: fc.constantFrom(...ALL_ROOTS),
  segments: fc.array(fc.constantFrom(...DIR_SEGMENTS), { minLength: 0, maxLength: 3 }),
  name: fc.constantFrom(...FILE_NAMES),
});

const pathArb: fc.Arbitrary<string> = pathPartsArb.map(renderWindowsPath);

/** Cặp path chắc chắn khác khoá chuẩn hoá — tiền đề của Property 5. */
interface DistinctPathPair {
  sourcePath: string;
  destPath: string;
}

function hasDistinctCompareKey(pair: DistinctPathPair): boolean {
  return workspacePathCompareKey(pair.sourcePath) !== workspacePathCompareKey(pair.destPath);
}

const distinctPathPairArb: fc.Arbitrary<DistinctPathPair> = fc
  .record({ sourcePath: pathArb, destPath: pathArb })
  .filter(hasDistinctCompareKey);

/**
 * Phép biến đổi tạo cặp path "gần trùng": khác đúng một điểm so với nguồn.
 *
 * Cặp path ngẫu nhiên hoàn toàn thường khác nhau ở nhiều chỗ nên quá dễ để phân biệt.
 * Ca chặn oan thật nằm ở đây: người dùng lưu kết quả vào đúng thư mục đang chứa
 * artifact, chỉ đổi tên file, hoặc lưu xuống một thư mục con của nó.
 */
type PathMutation =
  | 'doiTenFile'
  | 'doiGoc'
  | 'themThuMucCon'
  | 'boThuMucCuoi'
  | 'doiThuMucCuoi';

const PATH_MUTATIONS: readonly PathMutation[] = [
  'doiTenFile',
  'doiGoc',
  'themThuMucCon',
  'boThuMucCuoi',
  'doiThuMucCuoi',
];

interface MutationPicks {
  altName: string;
  altRoot: string;
  altSegment: string;
}

/** Trả `null` khi phép biến đổi không áp được (ví dụ bỏ thư mục cuối của path ở gốc). */
function applyPathMutation(
  source: WindowsPathParts,
  mutation: PathMutation,
  picks: MutationPicks,
): WindowsPathParts | null {
  switch (mutation) {
    case 'doiTenFile':
      return source.name === picks.altName ? null : { ...source, name: picks.altName };
    case 'doiGoc':
      return source.root === picks.altRoot ? null : { ...source, root: picks.altRoot };
    case 'themThuMucCon':
      return { ...source, segments: [...source.segments, picks.altSegment] };
    case 'boThuMucCuoi':
      return source.segments.length === 0
        ? null
        : { ...source, segments: source.segments.slice(0, -1) };
    case 'doiThuMucCuoi': {
      if (source.segments.length === 0) return null;
      if (source.segments[source.segments.length - 1] === picks.altSegment) return null;
      return { ...source, segments: [...source.segments.slice(0, -1), picks.altSegment] };
    }
  }
}

const nearMissPathPairArb: fc.Arbitrary<DistinctPathPair> = fc
  .record({
    source: pathPartsArb,
    mutation: fc.constantFrom(...PATH_MUTATIONS),
    altName: fc.constantFrom(...FILE_NAMES),
    altRoot: fc.constantFrom(...ALL_ROOTS),
    altSegment: fc.constantFrom(...DIR_SEGMENTS),
  })
  .map(({ source, mutation, altName, altRoot, altSegment }) => {
    const dest = applyPathMutation(source, mutation, { altName, altRoot, altSegment });
    return {
      sourcePath: renderWindowsPath(source),
      destPath: dest === null ? null : renderWindowsPath(dest),
    };
  })
  .filter((pair): pair is DistinctPathPair => pair.destPath !== null)
  .filter(hasDistinctCompareKey);

// ------------------------------------------------------------
// Fixture working file
// ------------------------------------------------------------

type RuntimeWorkspaceFile = File & {
  path?: string;
  isTempUploadPath?: boolean;
};

/** Tổ hợp provenance của working file; `undefined` path nghĩa là bytes chỉ có trong WebView. */
interface WorkingFileFixture {
  sourcePath?: string;
  isGenerated: boolean;
  isTransientPath: boolean;
}

/**
 * Provenance gắn bằng đúng cơ chế của runtime: `markGeneratedWorkspaceFile` và property
 * `isTempUploadPath` trên `File`. Tên file cố tình không liên quan tới provenance —
 * hợp đồng của dự án là provenance không được suy từ tên file.
 */
function makeWorkingFile(fixture: WorkingFileFixture): RuntimeWorkspaceFile {
  const base = new File([], 'working.pdf', { type: 'application/pdf' });
  const file: File = fixture.isGenerated ? markGeneratedWorkspaceFile(base) : base;
  if (fixture.sourcePath !== undefined) {
    Object.defineProperty(file, 'path', { value: fixture.sourcePath, configurable: true });
  }
  if (fixture.isTransientPath) {
    Object.defineProperty(file, 'isTempUploadPath', { value: true, configurable: true });
  }
  return file as RuntimeWorkspaceFile;
}

const provenanceArb = fc.record({
  isGenerated: fc.boolean(),
  isTransientPath: fc.boolean(),
});

const didBakeArb = fc.boolean();

function planFor(
  fixture: WorkingFileFixture,
  destPath: string,
  didBake: boolean,
): WorkspaceSaveWritePlan {
  return planWorkspaceSaveWrite({
    file: makeWorkingFile(fixture),
    destPath,
    isTransientPath: fixture.isTransientPath,
    didBake,
  });
}

// ============================================================
// Feature: save-as-artifact-guard, Property 5: Không chặn oan
//
// **Validates: Requirements 3.2, 4.4**
//
// Nếu hai path có khoá chuẩn hoá khác nhau thì plan không bao giờ là
// `rejectArtifactDestination`, bất kể working file mang provenance nào.
//
// Phần "và không trỏ cùng một file trên đĩa" của Property 5 không kiểm được ở đây:
// `planWorkspaceSaveWrite` là hàm thuần trong WebView, không có handle file. Junction,
// symlink, hardlink và ổ map là việc của `resolves_to_same_disk_file` ở tầng native.
// ============================================================

describe('planWorkspaceSaveWrite — Property 5: Không chặn oan', () => {
  it('cặp path khác khoá chuẩn hoá không bao giờ bị từ chối, với mọi tổ hợp provenance', () => {
    fc.assert(
      fc.property(
        distinctPathPairArb,
        provenanceArb,
        didBakeArb,
        ({ sourcePath, destPath }, provenance, didBake) => {
          const plan = planFor({ sourcePath, ...provenance }, destPath, didBake);

          expect(plan.kind).not.toBe('rejectArtifactDestination');
          // Khác khoá thì cũng không thể là reuse (reuse đòi cùng một file), nên lượt
          // lưu phải thật sự ghi. Khẳng định cả điều này để "không chặn" không bị hiểu
          // thành "im lặng bỏ qua việc ghi" — mất dữ liệu cũng tệ như chặn oan.
          expect(['copyOnDisk', 'writeBytes']).toContain(plan.kind);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('cặp path gần trùng (khác đúng một điểm) cũng không bị từ chối', () => {
    fc.assert(
      fc.property(
        nearMissPathPairArb,
        provenanceArb,
        didBakeArb,
        ({ sourcePath, destPath }, provenance, didBake) => {
          const plan = planFor({ sourcePath, ...provenance }, destPath, didBake);

          expect(plan.kind).not.toBe('rejectArtifactDestination');
          expect(['copyOnDisk', 'writeBytes']).toContain(plan.kind);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('working file không có path đĩa thì không có gì để trùng, nên không bị từ chối', () => {
    // Ca thật: kết quả công cụ còn nằm trong WebView, chưa có path native. Chốt chặn
    // artifact so path với path; thiếu một phía thì phải cho ghi, không được chặn.
    fc.assert(
      fc.property(
        fc.constantFrom<string | undefined>(undefined, ''),
        pathArb,
        provenanceArb,
        didBakeArb,
        (sourcePath, destPath, provenance, didBake) => {
          const plan = planFor({ sourcePath, ...provenance }, destPath, didBake);

          expect(plan.kind).not.toBe('rejectArtifactDestination');
          expect(plan).toEqual({ kind: 'writeBytes', destPath });
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ============================================================
// Feature: save-as-artifact-guard, Property 8: Hai đường ghi loại trừ nhau
//
// **Validates: Requirements 4.5**
//
// `copyOnDisk` chỉ khi `didBake` sai và `file.path` là chuỗi không rỗng; `writeBytes`
// trong mọi ca ghi còn lại. Không input nào dùng cả hai.
//
// Vì sao quan trọng: bake xoay trang / thứ tự trang mà đi đường copy đĩa→đĩa thì phần
// bake bị bỏ mất — bytes trên đĩa vẫn là bytes cũ trong khi giao diện báo đã lưu.
// Chiều còn lại: chưa bake mà đọc cả file vào Uint8Array rồi đẩy qua IPC thì kết quả
// bình bản hàng trăm MB làm vỡ serialize.
// ============================================================

/** Path đĩa của working file: thiếu hẳn, rỗng, hoặc một path Windows thật. */
const sourcePathArb: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constant<string | undefined>(undefined),
  fc.constant<string | undefined>(''),
  pathArb,
);

/** Đúng điều kiện mà `planWorkspaceSaveWrite` dùng để chọn đường copy đĩa→đĩa. */
function hasDiskSourcePath(sourcePath: string | undefined): sourcePath is string {
  return typeof sourcePath === 'string' && sourcePath.length > 0;
}

/** Một lượt Save As đầy đủ: working file, đích, và có bake hay không. */
interface SaveWriteScenario {
  fixture: WorkingFileFixture;
  destPath: string;
  didBake: boolean;
}

const saveWriteScenarioArb: fc.Arbitrary<SaveWriteScenario> = fc
  .record({
    sourcePath: sourcePathArb,
    provenance: provenanceArb,
    didBake: didBakeArb,
    otherPath: pathArb,
    chonLaiChinhNguon: fc.boolean(),
  })
  .map(({ sourcePath, provenance, didBake, otherPath, chonLaiChinhNguon }) => ({
    fixture: { sourcePath, ...provenance },
    // Ép một phần số ca chọn lại đúng path nguồn. Nếu để hai path sinh độc lập thì
    // chúng gần như không bao giờ trùng (miền path ở đây rộng hơn hai vạn giá trị),
    // nhánh reuse và reject không bao giờ được chạm tới, và mệnh đề "trong phạm vi
    // lượt ghi" của Property 8 trở thành luôn đúng — tức kiểm rỗng.
    destPath: chonLaiChinhNguon && hasDiskSourcePath(sourcePath) ? sourcePath : otherPath,
    didBake,
  }));

describe('planWorkspaceSaveWrite — Property 8: Hai đường ghi loại trừ nhau', () => {
  it('nhánh ghi được chọn đúng bằng điều kiện (chưa bake && có path đĩa)', () => {
    fc.assert(
      fc.property(saveWriteScenarioArb, ({ fixture, destPath, didBake }) => {
        const plan = planFor(fixture, destPath, didBake);

        // Đích có thể trùng nguồn nên plan còn có thể là reuse hoặc reject; điều kiện
        // chọn đường ghi chỉ được phát biểu trong phạm vi các lượt thật sự ghi.
        const isWriteBranch = plan.kind === 'copyOnDisk' || plan.kind === 'writeBytes';
        const expectCopyOnDisk = (
          isWriteBranch && !didBake && hasDiskSourcePath(fixture.sourcePath)
        );

        expect(plan.kind === 'copyOnDisk').toBe(expectCopyOnDisk);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('mọi lượt ghi tới đích khác file đều rơi vào đúng một nhánh, kèm đủ tham số', () => {
    fc.assert(
      fc.property(
        distinctPathPairArb,
        provenanceArb,
        didBakeArb,
        ({ sourcePath, destPath }, provenance, didBake) => {
          const plan = planFor({ sourcePath, ...provenance }, destPath, didBake);

          if (didBake) {
            expect(plan).toEqual({ kind: 'writeBytes', destPath });
          } else {
            expect(plan).toEqual({ kind: 'copyOnDisk', sourcePath, destPath });
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('plan không bao giờ mang chỉ dẫn của cả hai đường ghi', () => {
    // `toEqual` ở các ca trên đã khoá hình dạng cho từng nhánh; ca này khoá bất biến
    // "loại trừ" một cách trực tiếp: plan ghi bytes không được kèm `sourcePath` để
    // copy, và plan copy phải có đủ cặp nguồn/đích.
    fc.assert(
      fc.property(saveWriteScenarioArb, ({ fixture, destPath, didBake }) => {
        const plan = planFor(fixture, destPath, didBake);
        const keys = Object.keys(plan).sort();

        if (plan.kind === 'copyOnDisk') {
          expect(keys).toEqual(['destPath', 'kind', 'sourcePath']);
        } else if (plan.kind === 'writeBytes') {
          expect(keys).toEqual(['destPath', 'kind']);
        } else {
          // reuse / reject không ghi gì nên không được mang tham số ghi nào.
          expect(keys).toEqual(['kind']);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('đã bake thì không lượt nào đi đường copy, dù có path đĩa', () => {
    fc.assert(
      fc.property(
        saveWriteScenarioArb.filter(({ fixture }) => hasDiskSourcePath(fixture.sourcePath)),
        ({ fixture, destPath }) => {
          const plan = planFor(fixture, destPath, true);

          expect(plan.kind).not.toBe('copyOnDisk');
          // Bake xong thì cũng không được reuse: bytes trên đĩa không còn là bytes
          // người dùng đang thấy.
          expect(plan.kind).not.toBe('reuseExistingSource');
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('generator phủ đủ bốn nhánh plan — chống kiểm rỗng', () => {
    // Chốt chặn cho chính bộ test này: mệnh đề "trong phạm vi lượt ghi" của Property 8
    // chỉ có giá trị nếu generator thật sự sinh cả ca không-ghi. Không có ca này thì
    // một thay đổi vô tình làm hẹp generator sẽ biến property thành luôn xanh.
    const kinds = new Set<WorkspaceSaveWritePlan['kind']>();
    fc.assert(
      fc.property(saveWriteScenarioArb, ({ fixture, destPath, didBake }) => {
        kinds.add(planFor(fixture, destPath, didBake).kind);
      }),
      { numRuns: 1_000 },
    );

    expect([...kinds].sort()).toEqual([
      'copyOnDisk',
      'rejectArtifactDestination',
      'reuseExistingSource',
      'writeBytes',
    ]);
  });
});
