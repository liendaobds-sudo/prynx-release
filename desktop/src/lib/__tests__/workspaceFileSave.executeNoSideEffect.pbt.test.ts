// ============================================================
// Property test — workspaceFileSave: executor bước ghi của Save As
//
// Feature: save-as-artifact-guard, Property 1: Từ chối không có tác dụng phụ
// **Validates: Requirements 1.1, 2.1, 2.2**
//
// Với mọi input mà plan là `rejectArtifactDestination`, số lần gọi mỗi cổng của
// executor bằng 0. Không đọc bytes, không chạm đĩa.
//
// Vì sao cần property test bên cạnh test ví dụ: hậu quả của ca nguy hiểm không phải
// một nhãn sai. Nếu bước ghi chạy rồi mới từ chối — hoặc chạy rồi trả về thành công —
// thì lệnh copy đĩa→đĩa tự thay chính artifact tạm, luồng lưu gắn identity "nguồn sạch"
// lên nó, vé thuê artifact bị tước, và vòng dọn artifact được phép xoá đúng file người
// dùng vừa tưởng là đã lưu. Test ví dụ chỉ khoá được những mặt path đã nghĩ ra; miền
// path Windows thì rộng hơn thế (hoa/thường, `/` và `\`, dấu phân cách trùng, `.`,
// `..`, UNC) và ca nguy hiểm chỉ cần **một** mặt lọt là mất dữ liệu.
//
// Đi qua `planWorkspaceSaveWrite` rồi `executeWorkspaceSaveWrite` chứ không dựng plan
// bằng tay: hợp đồng cần chứng minh là chuỗi thật, không phải một nhánh `switch` xử lý
// đúng giá trị đưa sẵn.
//
// Mỗi property chạy tối thiểu 100 iteration.
// ============================================================

import { describe, expect, it, vi, type Mock } from 'vitest';
import * as fc from 'fast-check';
import { markGeneratedWorkspaceFile } from '../nativeFileAccess';
import {
  executeWorkspaceSaveWrite,
  planWorkspaceSaveWrite,
  WORKSPACE_SAVE_ARTIFACT_DESTINATION_MESSAGE_KEY,
  type WorkspaceSaveWritePlan,
  type WorkspaceSaveWritePorts,
} from '../workspaceFileSave';

const NUM_RUNS = 100;

// ------------------------------------------------------------
// Cổng giả: đếm mọi lời gọi, không có tác dụng phụ thật
// ------------------------------------------------------------

/** Bytes giả của bản đã bake. Nội dung không quan trọng; điều quan trọng là ai gọi. */
const BAKED_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

/** Tên cổng đã bị gọi, kèm đối số — để counterexample nói rõ lệnh nào đã lọt xuống đĩa. */
type WorkspaceSaveWritePortCall =
  | { readonly port: 'copyOnDisk'; readonly sourcePath: string; readonly destPath: string }
  | { readonly port: 'writeBytes'; readonly destPath: string; readonly byteLength: number }
  | { readonly port: 'readBytes' };

interface SpyWorkspaceSaveWritePorts {
  readonly ports: WorkspaceSaveWritePorts;
  /** Log tuần tự mọi lời gọi. Hợp đồng của Property 1 là log này rỗng. */
  readonly calls: readonly WorkspaceSaveWritePortCall[];
  readonly copyOnDisk: Mock<(sourcePath: string, destPath: string) => Promise<void>>;
  readonly writeBytes: Mock<(destPath: string, bytes: Uint8Array) => Promise<void>>;
  readonly readBytes: Mock<() => Promise<Uint8Array>>;
}

/**
 * Cổng giả cho một lượt chạy. Tạo mới mỗi iteration: dùng lại giữa các iteration thì
 * số đếm cộng dồn và một lần gọi lọt ở iteration sau bị che bởi iteration trước.
 */
function makeSpyPorts(): SpyWorkspaceSaveWritePorts {
  const calls: WorkspaceSaveWritePortCall[] = [];
  const copyOnDisk = vi.fn(async (sourcePath: string, destPath: string): Promise<void> => {
    calls.push({ port: 'copyOnDisk', sourcePath, destPath });
  });
  const writeBytes = vi.fn(async (destPath: string, bytes: Uint8Array): Promise<void> => {
    calls.push({ port: 'writeBytes', destPath, byteLength: bytes.byteLength });
  });
  const readBytes = vi.fn(async (): Promise<Uint8Array> => {
    calls.push({ port: 'readBytes' });
    return BAKED_BYTES;
  });
  return { ports: { copyOnDisk, writeBytes, readBytes }, calls, copyOnDisk, writeBytes, readBytes };
}

// ------------------------------------------------------------
// Generator: artifact tạm + đích trùng path dưới nhiều mặt khác nhau
// ------------------------------------------------------------

/** Ổ đĩa cục bộ và share mạng của xưởng in. Cả hai đều là gốc thật của path artifact. */
const LOCAL_ROOTS = ['C:', 'D:', 'E:', 'Z:'] as const;
const UNC_ROOTS = ['\\\\may-in\\san-xuat', '\\\\nas-xuong-in\\chia-se'] as const;

// Thư mục thật trên đường đi của artifact: `uploads` của sidecar, TEMP, thư mục kết quả.
const DIR_SEGMENTS: readonly string[] = [
  'pdfcompare',
  'uploads',
  'PrynX',
  'temp',
  'results',
  'Ket qua',
  'Tài liệu',
];

// Tên artifact thật: uuid do sidecar sinh, và tên có dấu do công cụ đặt.
const FILE_NAMES: readonly string[] = [
  '9f2c8ad1.pdf',
  'artifact.pdf',
  'Working.pdf',
  'ket-qua-binh-ban.pdf',
  'Bản in thử.pdf',
];

interface WindowsPathParts {
  readonly root: string;
  readonly segments: readonly string[];
  readonly name: string;
}

function renderWindowsPath(parts: WindowsPathParts): string {
  return [parts.root, ...parts.segments, parts.name].join('\\');
}

const pathPartsArb: fc.Arbitrary<WindowsPathParts> = fc.record({
  root: fc.constantFrom<string>(...LOCAL_ROOTS, ...UNC_ROOTS),
  // Tối thiểu một thư mục: đoạn `..` trong biến thể cần có cha để leo lên, và path
  // artifact thật luôn nằm trong ít nhất một thư mục (`uploads`, `temp`).
  segments: fc.array(fc.constantFrom(...DIR_SEGMENTS), { minLength: 1, maxLength: 3 }),
  name: fc.constantFrom(...FILE_NAMES),
});

/**
 * Phép biến đổi sinh ra một **mặt khác của cùng một file**. Đây là miền đầu vào thật:
 * path artifact do sidecar trả về đi qua `os.path.abspath` nên giữ case của cwd process,
 * còn hộp thoại lưu của Tauri trả case và dấu phân cách theo shell. Không bên nào bảo
 * đảm hai chuỗi giống nhau.
 */
type SamePathFace =
  | 'nguyenBan'
  | 'hoaTatCa'
  | 'thuongTatCa'
  | 'dauGachXuoi'
  | 'nhanDoiDauPhanCach'
  | 'chenDoanChamTruocTenFile'
  | 'chenDoanChaConVeLai'
  | 'themKhoangTrangBien';

const SAME_PATH_FACES: readonly SamePathFace[] = [
  'nguyenBan',
  'hoaTatCa',
  'thuongTatCa',
  'dauGachXuoi',
  'nhanDoiDauPhanCach',
  'chenDoanChamTruocTenFile',
  'chenDoanChaConVeLai',
  'themKhoangTrangBien',
];

/**
 * Áp một mặt path lên `parts`.
 *
 * `chenDoanChamTruocTenFile` chèn `\.\` ngay trước tên file, không chèn ở vị trí bất kỳ:
 * chèn ngay sau tiền tố UNC sẽ tạo `\\.\` — không gian tên thiết bị của Win32, một path
 * hoàn toàn khác chứ không phải biến thể vô hại của cùng file.
 *
 * `chenDoanChaConVeLai` dựng dạng `...\<thư mục lạ>\..\<tên file>`: đúng hình dạng mà
 * người dùng gõ tay khi điều hướng lòng vòng trong hộp thoại lưu.
 */
function renderSamePathFace(parts: WindowsPathParts, face: SamePathFace): string {
  const base = renderWindowsPath(parts);
  switch (face) {
    case 'nguyenBan':
      return base;
    case 'hoaTatCa':
      return base.toUpperCase();
    case 'thuongTatCa':
      return base.toLowerCase();
    case 'dauGachXuoi':
      return base.replace(/\\/g, '/');
    case 'nhanDoiDauPhanCach':
      // Giữ nguyên tiền tố UNC `\\` rồi mới nhân đôi phần còn lại: nhân đôi cả tiền tố
      // thành `\\\\` là một dạng path khác, không còn là biến thể vô hại.
      return base.slice(0, 2) + base.slice(2).replace(/\\/g, '\\\\');
    case 'chenDoanChamTruocTenFile':
      return renderWindowsPath({ ...parts, segments: [...parts.segments, '.'] });
    case 'chenDoanChaConVeLai':
      return renderWindowsPath({
        ...parts,
        segments: [...parts.segments, 'don-hang-2026', '..'],
      });
    case 'themKhoangTrangBien':
      // Hộp thoại và clipboard hay kèm khoảng trắng biên; `workspacePathCompareKey`
      // trim đầu vào nên đây vẫn là cùng một file.
      return `  ${base} `;
  }
}

/** Tổ hợp provenance khiến file là app-owned — điều kiện để chốt chặn được phép nổ. */
type ArtifactProvenance =
  | { readonly isGenerated: true; readonly isTransientPath: false }
  | { readonly isGenerated: false; readonly isTransientPath: true }
  | { readonly isGenerated: true; readonly isTransientPath: true };

const artifactProvenanceArb: fc.Arbitrary<ArtifactProvenance> = fc.constantFrom<ArtifactProvenance>(
  { isGenerated: true, isTransientPath: false },
  { isGenerated: false, isTransientPath: true },
  { isGenerated: true, isTransientPath: true },
);

type RuntimeWorkspaceFile = File & {
  path?: string;
  isTempUploadPath?: boolean;
};

/**
 * Working file dựng bằng đúng cơ chế của runtime: `markGeneratedWorkspaceFile` và
 * property `isTempUploadPath` trên `File`. Tên file cố tình không liên quan tới
 * provenance — hợp đồng của dự án là provenance không được suy từ tên file.
 */
function makeArtifactWorkingFile(
  sourcePath: string,
  provenance: ArtifactProvenance,
): RuntimeWorkspaceFile {
  const base = new File(['pdf'], 'working.pdf', { type: 'application/pdf' });
  const file: File = provenance.isGenerated ? markGeneratedWorkspaceFile(base) : base;
  Object.defineProperty(file, 'path', { value: sourcePath, configurable: true });
  if (provenance.isTransientPath) {
    Object.defineProperty(file, 'isTempUploadPath', { value: true, configurable: true });
  }
  return file as RuntimeWorkspaceFile;
}

/** Một lượt Save As mà đích trỏ cùng file với artifact tạm đang làm việc. */
interface RejectScenario {
  readonly sourcePath: string;
  readonly destPath: string;
  readonly provenance: ArtifactProvenance;
  readonly didBake: boolean;
}

const rejectScenarioArb: fc.Arbitrary<RejectScenario> = fc
  .record({
    parts: pathPartsArb,
    sourceFace: fc.constantFrom(...SAME_PATH_FACES),
    destFace: fc.constantFrom(...SAME_PATH_FACES),
    provenance: artifactProvenanceArb,
    // `didBake` đi cả hai giá trị: bake xoay trang / thứ tự trang không được là cửa hậu
    // đưa lượt lưu xuống nhánh `writeBytes` ghi đè chính file đang làm việc.
    didBake: fc.boolean(),
  })
  .map(({ parts, sourceFace, destFace, provenance, didBake }) => ({
    sourcePath: renderSamePathFace(parts, sourceFace),
    destPath: renderSamePathFace(parts, destFace),
    provenance,
    didBake,
  }));

function planFor(scenario: RejectScenario): WorkspaceSaveWritePlan {
  return planWorkspaceSaveWrite({
    file: makeArtifactWorkingFile(scenario.sourcePath, scenario.provenance),
    destPath: scenario.destPath,
    isTransientPath: scenario.provenance.isTransientPath,
    didBake: scenario.didBake,
  });
}

// ============================================================
// Feature: save-as-artifact-guard, Property 1: Từ chối không có tác dụng phụ
//
// **Validates: Requirements 1.1, 2.1, 2.2**
// ============================================================

describe('executeWorkspaceSaveWrite — Property 1: Từ chối không có tác dụng phụ', () => {
  it('mọi mặt path trùng của artifact tạm đều bị từ chối mà không gọi cổng nào', async () => {
    await fc.assert(
      fc.asyncProperty(rejectScenarioArb, async (scenario) => {
        const plan = planFor(scenario);
        // Tiền đề của property. Đây cũng là phần Requirement 1.1 nói "từ chối TRƯỚC khi
        // gọi bất kỳ lệnh ghi hoặc copy nào": plan quyết định xong mới tới executor.
        expect(plan).toEqual({ kind: 'rejectArtifactDestination' });

        const spy = makeSpyPorts();
        const outcome = await executeWorkspaceSaveWrite(plan, spy.ports);

        expect(outcome).toEqual({
          kind: 'rejected',
          messageKey: WORKSPACE_SAVE_ARTIFACT_DESTINATION_MESSAGE_KEY,
        });
        // Requirement 2.1 và 2.2 ở tầng frontend: không lệnh nào chạm đĩa nên artifact
        // tạm không thể bị thay bytes và không có file `.tmp` trung gian nào được sinh.
        // So log trước khi đếm: nếu đỏ thì counterexample chỉ ra luôn cổng nào đã lọt.
        expect(spy.calls).toEqual([]);
        expect(spy.copyOnDisk).toHaveBeenCalledTimes(0);
        expect(spy.writeBytes).toHaveBeenCalledTimes(0);
        // `readBytes` cũng bằng 0: kết quả bình bản/VDP có thể hàng trăm MB, đọc vào
        // WebView rồi mới từ chối vừa vô ích vừa là rủi ro "Invalid array length".
        expect(spy.readBytes).toHaveBeenCalledTimes(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('từ chối là kết quả trả về bình thường, không phải throw', async () => {
    // Vì sao đáng khoá riêng: nếu nhánh này throw thì nó rơi vào `catch` của call site —
    // đúng chỗ nhận diện lỗi phạm vi ghi rồi mở lại hộp thoại chọn vị trí (Requirement
    // 1.3). Người dùng sẽ thấy hộp thoại nhảy lại thay vì một thông báo giải thích.
    await fc.assert(
      fc.asyncProperty(rejectScenarioArb, async (scenario) => {
        const spy = makeSpyPorts();
        await expect(executeWorkspaceSaveWrite(planFor(scenario), spy.ports))
          .resolves.toMatchObject({ kind: 'rejected' });
        expect(spy.calls).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('generator thật sự sinh ra plan từ chối — chống kiểm rỗng', () => {
    // Chốt chặn cho chính bộ test này. Nếu một thay đổi vô tình làm generator không còn
    // sinh cặp path trùng (ví dụ một mặt path mới không round-trip) thì `expect` tiền đề
    // ở trên sẽ đỏ — nhưng ca này nói rõ hơn: cả tám mặt path và cả ba tổ hợp provenance
    // đều phải thật sự tới được nhánh `rejectArtifactDestination`.
    const facesSeen = new Set<SamePathFace>();
    const provenancesSeen = new Set<string>();
    const kindsSeen = new Set<WorkspaceSaveWritePlan['kind']>();
    const didBakeSeen = new Set<boolean>();

    fc.assert(
      fc.property(
        fc.record({
          parts: pathPartsArb,
          sourceFace: fc.constantFrom(...SAME_PATH_FACES),
          destFace: fc.constantFrom(...SAME_PATH_FACES),
          provenance: artifactProvenanceArb,
          didBake: fc.boolean(),
        }),
        ({ parts, sourceFace, destFace, provenance, didBake }) => {
          const scenario: RejectScenario = {
            sourcePath: renderSamePathFace(parts, sourceFace),
            destPath: renderSamePathFace(parts, destFace),
            provenance,
            didBake,
          };
          facesSeen.add(sourceFace);
          facesSeen.add(destFace);
          provenancesSeen.add(JSON.stringify(provenance));
          didBakeSeen.add(didBake);
          kindsSeen.add(planFor(scenario).kind);
        },
      ),
      { numRuns: 1_000 },
    );

    expect([...facesSeen].sort()).toEqual([...SAME_PATH_FACES].sort());
    expect(provenancesSeen.size).toBe(3);
    expect([...didBakeSeen].sort()).toEqual([false, true]);
    // Chỉ đúng một nhánh: mọi input của generator này đều phải là ca từ chối. Nếu lọt
    // thêm `copyOnDisk` hay `writeBytes` thì có một mặt path trùng không được nhận ra —
    // đó chính là ca nguy hiểm, không phải lỗi generator.
    expect([...kindsSeen]).toEqual(['rejectArtifactDestination']);
  });
});
