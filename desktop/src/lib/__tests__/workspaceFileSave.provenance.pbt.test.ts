// ============================================================
// Property test — workspaceFileSave: provenance quanh biên lưu Save As
//
// Feature: save-as-artifact-guard, Property 6: Provenance sạch chỉ sinh ra khi ghi thành công
// **Validates: Requirements 2.3, 2.4, 2.5**
//
// Revision mất `isGenerated`, `isTempUploadPath`, cờ chờ path native và vé thuê artifact
// chỉ ở đường outcome `written` hoặc `reused`. Đường `rejected` giữ nguyên mọi metadata
// của working file.
//
// Vì sao bất biến này đáng một property test riêng, không phải chuyện nhãn cho đẹp:
// vé thuê artifact là thứ duy nhất giữ file tạm khỏi vòng dọn phía backend. Chuỗi thật
// đã truy vết bằng `file:dòng`:
//   token trên `File`            — `artifactLease.ts:14`  `readArtifactLeaseToken`
//   → tab gom token              — `ImpositionTab.tsx:1350` `collectArtifactLeaseTokens([file, ...history, ...])`
//   → owner đồng bộ tập token    — `ImpositionTab.tsx:1394` `owner.sync(artifactLeaseTokens)`
//   → claim/renew/release        — `artifactLease.ts:44`  `POST /artifacts/{action}`
// `createSavedWorkspaceRevision` **tước** token. Nên nếu nhánh từ chối lại công bố
// revision, token rơi khỏi tập trên, owner release nó, và vòng dọn artifact được phép
// xoá đúng file mà người dùng vừa tưởng là đã lưu. Đây là đường mất dữ liệu, và nó chỉ
// cần **một** tổ hợp provenance lọt là xảy ra — đúng loại việc mà test ví dụ không phủ
// hết được: bốn dấu vết × hai giá trị, nhân với bốn nhánh plan.
//
// Cách phát biểu bất biến cho đúng phạm vi: `executeWorkspaceSaveWrite` KHÔNG tự tạo
// revision — việc công bố nằm ở call site. Nên property được chẻ thành hai nửa kiểm được:
//   1. Sau khi executor trả về, object `File` gốc không bị mutate ở bất kỳ nhánh nào.
//   2. `createSavedWorkspaceRevision` — hàm chỉ được gọi trên đường `written`/`reused` —
//      cho ra `File` sạch cả bốn dấu vết.
// Xem mục "Giới hạn bằng chứng" ở cuối file để biết phần nào của Requirement 2 vẫn nằm
// ngoài tầm khoá của property này.
//
// Mỗi property chạy tối thiểu 100 iteration.
// ============================================================

import { describe, expect, it, vi, type Mock } from 'vitest';
import * as fc from 'fast-check';
import { isGeneratedWorkspaceFile, markGeneratedWorkspaceFile } from '../nativeFileAccess';
import {
  collectArtifactLeaseTokens,
  readArtifactLeaseToken,
  tagArtifactLeaseToken,
} from '../artifactLease';
import {
  createSavedWorkspaceRevision,
  executeWorkspaceSaveWrite,
  planWorkspaceSaveWrite,
  type WorkspaceSaveWriteOutcome,
  type WorkspaceSaveWritePlan,
  type WorkspaceSaveWritePorts,
} from '../workspaceFileSave';

const NUM_RUNS = 100;

// ------------------------------------------------------------
// Cổng giả: executor phải chạy được mà không chạm đĩa
// ------------------------------------------------------------

const BAKED_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

interface SpyWorkspaceSaveWritePorts {
  readonly ports: WorkspaceSaveWritePorts;
  readonly copyOnDisk: Mock<(sourcePath: string, destPath: string) => Promise<void>>;
  readonly writeBytes: Mock<(destPath: string, bytes: Uint8Array) => Promise<void>>;
  readonly readBytes: Mock<() => Promise<Uint8Array>>;
}

/** Cổng mới cho từng iteration: dùng lại thì số đếm cộng dồn và ca lọt bị che. */
function makeSpyPorts(): SpyWorkspaceSaveWritePorts {
  const copyOnDisk = vi.fn(async (): Promise<void> => undefined);
  const writeBytes = vi.fn(async (): Promise<void> => undefined);
  const readBytes = vi.fn(async (): Promise<Uint8Array> => BAKED_BYTES);
  return { ports: { copyOnDisk, writeBytes, readBytes }, copyOnDisk, writeBytes, readBytes };
}

// ------------------------------------------------------------
// Generator: working file với mọi tổ hợp provenance
// ------------------------------------------------------------

const LOCAL_ROOTS = ['C:', 'D:', 'E:', 'Z:'] as const;
// Share mạng thật của xưởng in: đưa vào để chuẩn hoá path không được gộp mất tiền tố `\\`.
const UNC_ROOTS = ['\\\\may-in\\san-xuat', '\\\\nas-xuong-in\\chia-se'] as const;
const ALL_ROOTS: readonly string[] = [...LOCAL_ROOTS, ...UNC_ROOTS];

// Thư mục thật trên đường đi của artifact: `uploads` của sidecar, TEMP, thư mục kết quả,
// và thư mục khách. Có dấu cách và dấu tiếng Việt để không giả định ASCII.
const DIR_SEGMENTS: readonly string[] = [
  'pdfcompare',
  'uploads',
  'PrynX',
  'temp',
  'results',
  'Khach',
  'Ket qua',
  'Tài liệu',
];

const FILE_NAMES: readonly string[] = [
  '9f2c8ad1.pdf',
  'artifact.pdf',
  'Working.pdf',
  'Hop_dong.pdf',
  'ket-qua-binh-ban.pdf',
  'Bản in thử.pdf',
];

const pathArb: fc.Arbitrary<string> = fc
  .record({
    root: fc.constantFrom<string>(...ALL_ROOTS),
    segments: fc.array(fc.constantFrom<string>(...DIR_SEGMENTS), {
      minLength: 0,
      maxLength: 3,
    }),
    name: fc.constantFrom<string>(...FILE_NAMES),
  })
  .map(({ root, segments, name }) => [root, ...segments, name].join('\\'));

/** Path đĩa của working file: thiếu hẳn, rỗng, hoặc một path Windows thật. */
const sourcePathArb: fc.Arbitrary<string | undefined> = fc.oneof(
  { weight: 1, arbitrary: fc.constant<string | undefined>(undefined) },
  { weight: 1, arbitrary: fc.constant<string | undefined>('') },
  { weight: 6, arbitrary: pathArb },
);

const HEX_DIGITS: readonly string[] = [...'0123456789abcdef'];

/** Token phải khớp `ARTIFACT_LEASE_TOKEN_PATTERN` (/^[0-9a-f]{64}$/) mới đọc lại được. */
const leaseTokenArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom<string>(...HEX_DIGITS), { minLength: 64, maxLength: 64 })
  .map((digits) => digits.join(''));

/**
 * Bốn dấu vết mà revision nguồn sạch phải tước bỏ, sinh độc lập nhau.
 *
 * Sinh độc lập chứ không gói thành vài "hồ sơ" định sẵn: runtime tới được cả tổ hợp lệch
 * như generated nhưng không temp (kết quả công cụ đã ghi ra thư mục results) hoặc temp
 * nhưng không generated (file khách vừa upload để render). Gói lại là bỏ mất chính những
 * tổ hợp ít ai nghĩ tới.
 */
interface WorkingFileProvenance {
  readonly isGenerated: boolean;
  readonly isTransientPath: boolean;
  readonly nativePathPending: boolean;
  readonly leaseToken: string | undefined;
}

const provenanceArb: fc.Arbitrary<WorkingFileProvenance> = fc.record({
  isGenerated: fc.boolean(),
  isTransientPath: fc.boolean(),
  nativePathPending: fc.boolean(),
  leaseToken: fc.oneof(
    { weight: 1, arbitrary: fc.constant<string | undefined>(undefined) },
    { weight: 3, arbitrary: leaseTokenArb },
  ),
});

type RuntimeWorkspaceFile = File & {
  path?: string;
  isTempUploadPath?: boolean;
  __nativePathPending?: boolean;
};

interface WorkingFileFixture {
  readonly sourcePath: string | undefined;
  readonly provenance: WorkingFileProvenance;
}

/**
 * Working file dựng bằng đúng cơ chế của runtime: `markGeneratedWorkspaceFile`,
 * `tagArtifactLeaseToken`, và property gắn qua `Object.defineProperty`. Tên file cố tình
 * không liên quan tới provenance — hợp đồng của dự án là provenance không suy từ tên file.
 */
function makeWorkingFile(fixture: WorkingFileFixture): RuntimeWorkspaceFile {
  const base = new File(['pdf'], 'working.pdf', { type: 'application/pdf' });
  const file: File = fixture.provenance.isGenerated ? markGeneratedWorkspaceFile(base) : base;
  if (fixture.sourcePath !== undefined) {
    Object.defineProperty(file, 'path', { value: fixture.sourcePath, configurable: true });
  }
  if (fixture.provenance.isTransientPath) {
    Object.defineProperty(file, 'isTempUploadPath', { value: true, configurable: true });
  }
  if (fixture.provenance.nativePathPending) {
    Object.defineProperty(file, '__nativePathPending', { value: true, configurable: true });
  }
  tagArtifactLeaseToken(file, fixture.provenance.leaseToken);
  return file as RuntimeWorkspaceFile;
}

// ------------------------------------------------------------
// Ảnh chụp provenance để so trước/sau
// ------------------------------------------------------------

interface ProvenanceSnapshot {
  readonly isGenerated: boolean;
  readonly isTempUploadPath: boolean | undefined;
  readonly nativePathPending: boolean | undefined;
  readonly leaseToken: string | undefined;
  readonly path: string | undefined;
  readonly name: string;
  readonly size: number;
}

function readProvenance(file: File): ProvenanceSnapshot {
  const runtime = file as RuntimeWorkspaceFile;
  return {
    isGenerated: isGeneratedWorkspaceFile(file),
    isTempUploadPath: runtime.isTempUploadPath,
    nativePathPending: runtime.__nativePathPending,
    leaseToken: readArtifactLeaseToken(file),
    path: runtime.path,
    name: file.name,
    size: file.size,
  };
}

/** "Sạch provenance" phát biểu thành một vị từ, dùng chung cho mọi ca. */
function isCleanProvenance(file: File): boolean {
  const snapshot = readProvenance(file);
  return (
    snapshot.isGenerated === false
    && snapshot.isTempUploadPath === undefined
    && snapshot.nativePathPending === undefined
    && snapshot.leaseToken === undefined
  );
}

// ------------------------------------------------------------
// Một lượt Save As đầy đủ
// ------------------------------------------------------------

interface SaveScenario {
  readonly fixture: WorkingFileFixture;
  readonly destPath: string;
  readonly didBake: boolean;
  /**
   * Call site có hai cách công bố: kèm `path` (bytes ở lại trên đĩa) hoặc không kèm
   * (giữ bytes trong WebView). Đi cả hai vì `createSavedWorkspaceRevision` rẽ nhánh
   * theo `options.path` khi chọn `parts` cho `File` mới.
   */
  readonly publishWithPath: boolean;
}

function hasDiskSourcePath(sourcePath: string | undefined): sourcePath is string {
  return typeof sourcePath === 'string' && sourcePath.length > 0;
}

const saveScenarioArb: fc.Arbitrary<SaveScenario> = fc
  .record({
    sourcePath: sourcePathArb,
    provenance: provenanceArb,
    didBake: fc.boolean(),
    otherPath: pathArb,
    chonLaiChinhNguon: fc.boolean(),
    publishWithPath: fc.boolean(),
  })
  .map(({ sourcePath, provenance, didBake, otherPath, chonLaiChinhNguon, publishWithPath }) => ({
    fixture: { sourcePath, provenance },
    // Ép một phần số ca chọn lại đúng path nguồn. Để hai path sinh độc lập thì chúng
    // gần như không bao giờ trùng (miền path ở đây rộng hơn hai vạn giá trị), nhánh
    // `reuseExistingSource` và `rejectArtifactDestination` không bao giờ được chạm tới,
    // và property trở thành kiểm rỗng cho đúng hai nhánh quan trọng nhất.
    destPath: chonLaiChinhNguon && hasDiskSourcePath(sourcePath) ? sourcePath : otherPath,
    didBake,
    publishWithPath,
  }));

function planFor(scenario: SaveScenario, file: File): WorkspaceSaveWritePlan {
  return planWorkspaceSaveWrite({
    file,
    destPath: scenario.destPath,
    isTransientPath: scenario.fixture.provenance.isTransientPath,
    didBake: scenario.didBake,
  });
}

/**
 * Mô hình bước công bố của call site, viết theo hợp đồng trong design.md
 * §"Tách quyết định ghi thành plan + executor":
 *   `rejectArtifactDestination` → không công bố gì, working file ở nguyên;
 *   `written` / `reused`        → công bố revision nguồn sạch tại đích.
 *
 * Vì sao là mô hình chứ không phải hàm thật: `handleSaveFile` là `useCallback` tại
 * `ImpositionTab.tsx:3370` với khoảng ba mươi dependency, trong component đọc năm store,
 * `useEditSession`, `AcrobatViewer` và loader PDF. Mount nó để kiểm một nhánh là đắt và
 * giòn. Đây là giới hạn đã biết của bằng chứng, ghi rõ ở cuối file.
 */
function publishAfterOutcome(
  working: File,
  outcome: WorkspaceSaveWriteOutcome,
  scenario: SaveScenario,
): File {
  if (outcome.kind === 'rejected') return working;
  const destName = scenario.destPath.split('\\').pop() || 'Ket-qua.pdf';
  return createSavedWorkspaceRevision(
    working,
    destName,
    scenario.publishWithPath
      ? { path: scenario.destPath, size: working.size, pathRebaseOnly: true }
      : {},
  );
}

// ============================================================
// Feature: save-as-artifact-guard, Property 6: Provenance sạch chỉ sinh ra khi ghi thành công
//
// **Validates: Requirements 2.3, 2.4, 2.5**
// ============================================================

describe('Property 6: Provenance sạch chỉ sinh ra khi ghi thành công', () => {
  it('executor không mutate provenance của working file ở bất kỳ nhánh plan nào', async () => {
    // Nửa thứ nhất của bất biến. Nếu executor tự xoá cờ hoặc tự tước vé thì Requirement
    // 2.3 và 2.4 vỡ ngay cả khi call site làm đúng — object mà tab đang giữ đã bị đổi.
    await fc.assert(
      fc.asyncProperty(saveScenarioArb, async (scenario) => {
        const working = makeWorkingFile(scenario.fixture);
        const before = readProvenance(working);
        const plan = planFor(scenario, working);

        const outcome = await executeWorkspaceSaveWrite(plan, makeSpyPorts().ports);

        // Ảnh chụp gồm cả `path`, `name`, `size`: bước ghi không được đổi bất cứ thứ gì
        // trên object đang là nguồn của tab, kể cả khi nó ghi thành công ra đích khác.
        expect(readProvenance(working)).toEqual(before);
        // Chống kiểm rỗng cục bộ: outcome phải là một trong ba giá trị hợp lệ, nếu
        // executor trả về thứ khác thì phần dưới của bộ test này không nói được gì.
        expect(['written', 'reused', 'rejected']).toContain(outcome.kind);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('outcome rejected tương đương plan rejectArtifactDestination, không nhánh nào khác', async () => {
    // Cầu nối giữa hai nửa: "chỉ ở đường written/reused" chỉ có nghĩa nếu ba lớp outcome
    // phân hoạch đúng theo nhánh plan. Tương đương hai chiều nên không có ca ghi thành
    // công nào bị coi là từ chối, và không ca từ chối nào lọt sang đường công bố.
    await fc.assert(
      fc.asyncProperty(saveScenarioArb, async (scenario) => {
        const working = makeWorkingFile(scenario.fixture);
        const plan = planFor(scenario, working);
        const spy = makeSpyPorts();

        const outcome = await executeWorkspaceSaveWrite(plan, spy.ports);

        expect(outcome.kind === 'rejected').toBe(plan.kind === 'rejectArtifactDestination');
        if (outcome.kind === 'rejected') {
          // Requirement 2.1/2.2 ở tầng frontend, nhắc lại ở đây vì nó là tiền đề cho
          // "working file còn nguyên": không lệnh nào chạm đĩa thì không gì để hoàn tác.
          expect(spy.copyOnDisk).toHaveBeenCalledTimes(0);
          expect(spy.writeBytes).toHaveBeenCalledTimes(0);
          expect(spy.readBytes).toHaveBeenCalledTimes(0);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('revision sạch provenance khi và chỉ khi outcome là written hoặc reused', async () => {
    // Nửa thứ hai, phát biểu dưới dạng tương đương chứ không phải suy một chiều. Chiều
    // "rejected thì không sạch" mới là chiều chặn đường mất dữ liệu; chiều còn lại chặn
    // ca ngược: lưu thành công mà vẫn giữ vé thì artifact tạm không bao giờ được dọn.
    await fc.assert(
      fc.asyncProperty(saveScenarioArb, async (scenario) => {
        const working = makeWorkingFile(scenario.fixture);
        const before = readProvenance(working);
        const plan = planFor(scenario, working);

        const outcome = await executeWorkspaceSaveWrite(plan, makeSpyPorts().ports);
        const published = publishAfterOutcome(working, outcome, scenario);

        if (outcome.kind === 'rejected') {
          // Không có object mới nào được tạo: đúng nghĩa "không công bố revision".
          expect(published).toBe(working);
          expect(readProvenance(published)).toEqual(before);
          // Vé thuê là mắt xích tới vòng dọn artifact của backend. Phát biểu ở mức tập
          // token mà `owner.sync` nhận, đúng tầng mà `ImpositionTab.tsx:1350` dùng.
          expect(collectArtifactLeaseTokens([published]))
            .toEqual(collectArtifactLeaseTokens([working]));
          if (before.leaseToken !== undefined) {
            expect(collectArtifactLeaseTokens([published])).toEqual([before.leaseToken]);
          }
        } else {
          expect(published).not.toBe(working);
          expect(isCleanProvenance(published)).toBe(true);
          expect(collectArtifactLeaseTokens([published])).toEqual([]);
          // Working file cũ vẫn nguyên vé: artifact còn trong history của tab thì owner
          // vẫn giữ được nó, việc tước vé chỉ áp cho identity mới.
          expect(readProvenance(working)).toEqual(before);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('generator phủ đủ bốn nhánh plan, cả ba lớp outcome và cả hai kiểu công bố — chống kiểm rỗng', async () => {
    // Chốt chặn cho chính bộ test này. Ba property trên đều là mệnh đề có điều kiện;
    // nếu generator không sinh tới nhánh `rejectArtifactDestination` hoặc không sinh ca
    // có vé thuê thì chúng vẫn xanh mà không khoá được gì.
    const kinds = new Set<WorkspaceSaveWritePlan['kind']>();
    const outcomes = new Set<WorkspaceSaveWriteOutcome['kind']>();
    const provenanceShapes = new Set<string>();
    const publishModes = new Set<boolean>();
    let rejectedWithLease = 0;
    let cleanedWithLease = 0;

    await fc.assert(
      fc.asyncProperty(saveScenarioArb, async (scenario) => {
        const working = makeWorkingFile(scenario.fixture);
        const plan = planFor(scenario, working);
        const outcome = await executeWorkspaceSaveWrite(plan, makeSpyPorts().ports);
        const hasLease = readArtifactLeaseToken(working) !== undefined;

        kinds.add(plan.kind);
        outcomes.add(outcome.kind);
        publishModes.add(scenario.publishWithPath);
        provenanceShapes.add([
          scenario.fixture.provenance.isGenerated,
          scenario.fixture.provenance.isTransientPath,
          scenario.fixture.provenance.nativePathPending,
          hasLease,
        ].join('|'));
        if (hasLease && outcome.kind === 'rejected') rejectedWithLease += 1;
        if (hasLease && outcome.kind !== 'rejected') cleanedWithLease += 1;
      }),
      { numRuns: 2_000 },
    );

    expect([...kinds].sort()).toEqual([
      'copyOnDisk',
      'rejectArtifactDestination',
      'reuseExistingSource',
      'writeBytes',
    ]);
    expect([...outcomes].sort()).toEqual(['rejected', 'reused', 'written']);
    expect([...publishModes].sort()).toEqual([false, true]);
    // Cả mười sáu tổ hợp bốn dấu vết đều phải tới được, kể cả tổ hợp lệch như generated
    // nhưng không temp, hay temp nhưng không generated.
    expect(provenanceShapes.size).toBe(16);
    // Hai đếm này là phần "có điều kiện" của Property 6 nói bằng số: phải có ca vé thuê
    // sống sót qua từ chối, và có ca vé thuê bị tước sau khi ghi thành công. Thiếu một
    // trong hai thì bất biến chưa được kiểm ở cả hai chiều.
    expect(rejectedWithLease).toBeGreaterThan(0);
    expect(cleanedWithLease).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------
// Giới hạn bằng chứng — phần Requirement 2 property này KHÔNG khoá
// ------------------------------------------------------------
//
// 1. Bước công bố là **mô hình** (`publishAfterOutcome`), viết theo hợp đồng trong
//    design.md. Property này chứng minh: executor không mutate working file, và
//    `createSavedWorkspaceRevision` tước đủ bốn dấu vết. Nó KHÔNG chứng minh
//    `ImpositionTab.handleSaveFile` gọi đúng thứ tự đó — cụ thể là không chứng minh
//    được nhánh `rejected` ở call site thật không gọi `createSavedWorkspaceRevision`,
//    không đổi `isSaved` và không đổi tiêu đề tab. Phần đó thuộc task 5.3 của spec.
//
// 2. Thời điểm và điều kiện xoá thật của vòng dọn artifact phía backend chưa được đo.
//    Chuỗi "mất vé → owner release → backend xoá" là đọc code (`artifactLease.ts`,
//    `ImpositionTab.tsx:1350/1394`), không phải quan sát runtime. Requirement 2.4 vì
//    vậy được kiểm ở mức bất biến frontend: vé còn đọc được trên working file sau khi
//    từ chối, và tập token mà `owner.sync` nhận không đổi. Đây là proof gap đã ghi
//    trong design.md và phải vào ma trận audit.
//
// 3. Requirement 2.1 và 2.2 (artifact nguyên bytes, không `.tmp` rơi lại) chỉ được kiểm
//    ở mức "không cổng nào được gọi". Bằng chứng trên đĩa thật là việc của test Rust
//    trong task 4.4.
