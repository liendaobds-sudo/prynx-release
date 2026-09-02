// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CutExportModal from "./CutExportModal";

const mocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  getApiUrl: vi.fn(() => "http://127.0.0.1:8321/api"),
  translate: (key: string): string => key.split(":").pop() || key,
}));

vi.mock("../../../lib/api", () => mocks);
vi.mock("../../../i18n", () => ({ default: { t: mocks.translate } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.translate }),
}));
vi.mock("./machineSettings", () => ({ getMachineConn: () => null }));

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function endpointCalls(suffix: string): Array<unknown[]> {
  return mocks.authenticatedFetch.mock.calls.filter(([url]) => String(url).endsWith(suffix));
}

function renderModal(overrides: Partial<React.ComponentProps<typeof CutExportModal>> = {}) {
  const props: React.ComponentProps<typeof CutExportModal> = {
    open: true,
    onClose: vi.fn(),
    sheetWmm: 320,
    sheetHmm: 450,
    paths: [],
    sourcePdfPath: "D:\\jobs\\cut.pdf",
    sourceName: "cut.pdf",
    currentPage: 1,
    ...overrides,
  };
  return { ...render(<CutExportModal {...props} />), props };
}

function installBackend(
  inspect: (init?: RequestInit) => Promise<Response> | Response,
  exportFromFile: (init?: RequestInit) => Promise<Response> | Response = () => jsonResponse({
    ok: true,
    channel: "file",
    detail: "cut.plt",
    bytes_sent: 10,
  }),
): void {
  mocks.authenticatedFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url.endsWith("/cut-profiles")) {
      return Promise.resolve(jsonResponse({
        profiles: [{
          id: "generic_hpgl",
          vendor: "Generic",
          model: "HPGL",
          emitter: "command_stream",
          dialect: null,
          reg_mode: "none",
          transport_default: "file",
        }],
      }));
    }
    if (url.endsWith("/cut-inspect")) return inspect(init);
    if (url.endsWith("/cut-export-from-file")) return exportFromFile(init);
    if (url.endsWith("/cut-pages")) return Promise.resolve(jsonResponse({ ok: true, pages: [1] }));
    if (url.endsWith("/cut-preview-from-file")) {
      return Promise.resolve(jsonResponse({
        ok: true,
        svg: "<svg viewBox=\"0 0 10 10\"></svg>",
        total_items: 7,
        page_idx: 1,
        num_pages: 2,
      }));
    }
    throw new Error(`Endpoint test chưa khai báo: ${url}`);
  });
}

describe("CutExportModal inspect", () => {
  beforeEach(() => {
    mocks.authenticatedFetch.mockReset();
    mocks.getApiUrl.mockReturnValue("http://127.0.0.1:8321/api");
    localStorage.clear();
  });

  afterEach(cleanup);

  it("không gọi legacy khi endpoint mới trả lỗi nghiệp vụ HTTP 200", async () => {
    installBackend(() => jsonResponse({ ok: false, error: "Không tìm thấy file nguồn." }));

    renderModal();

    await screen.findAllByText(/Không tìm thấy file nguồn/);
    await act(async () => { await Promise.resolve(); });
    expect(endpointCalls("/cut-inspect")).toHaveLength(1);
    expect(endpointCalls("/cut-pages")).toHaveLength(0);
    expect(endpointCalls("/cut-preview-from-file")).toHaveLength(0);
    expect((screen.getByRole("button", { name: "gui" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("chỉ fallback legacy khi sidecar cũ chưa có endpoint inspect", async () => {
    installBackend(() => jsonResponse("Not Found", 404));

    renderModal();

    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());
    expect(endpointCalls("/cut-inspect")).toHaveLength(1);
    expect(endpointCalls("/cut-pages")).toHaveLength(1);
    expect(endpointCalls("/cut-preview-from-file")).toHaveLength(1);
  });

  it("không cho gửi khi PDF không có trang CUT và selected page là null", async () => {
    installBackend(() => jsonResponse({
      ok: true,
      cut_pages: [],
      num_pages: 5,
      selected_page_idx: null,
      candidates: { layers: [], spots: [] },
      preview: null,
    }));

    renderModal();

    await screen.findByText("Không tìm thấy đường cắt trong file PDF.");
    expect(screen.queryByRole("button", { name: "gui_tat_ca_n" })).toBeNull();
    expect((screen.getByRole("button", { name: "gui" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("endpoint mới có trang CUT nhưng thiếu proof thì vẫn khóa nút Gửi", async () => {
    installBackend(() => jsonResponse({
      ok: true,
      cut_pages: [0],
      num_pages: 1,
      selected_page_idx: 0,
      candidates: { layers: [], spots: [] },
      preview: { svg: "<svg viewBox=\"0 0 10 10\"></svg>", total_items: 4, page_idx: 0 },
      inspect_proof: null,
    }));

    renderModal();

    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());
    expect((screen.getByRole("button", { name: "gui" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("không request lần hai khi backend tự chọn trang CUT khác trang viewer", async () => {
    installBackend(() => jsonResponse({
      ok: true,
      cut_pages: [2],
      num_pages: 3,
      selected_page_idx: 2,
      candidates: { layers: [], spots: [] },
      preview: {
        svg: "<svg viewBox=\"0 0 10 10\"></svg>",
        total_items: 9,
        page_idx: 2,
      },
    }));

    // Viewer đang ở trang 2 (zero-based 1), backend chọn trang CUT 3. State ban
    // đầu vẫn là trang 1 nên ca này bắt được effect tự request lại sau response.
    renderModal({ currentPage: 2 });

    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());
    await act(async () => { await Promise.resolve(); });
    expect(endpointCalls("/cut-inspect")).toHaveLength(1);
  });

  it("giữ preview khi currentPage đổi biểu diễn nhưng vẫn là cùng trang zero-based", async () => {
    installBackend(() => jsonResponse({
      ok: true,
      cut_pages: [0],
      num_pages: 1,
      selected_page_idx: 0,
      candidates: { layers: [], spots: [] },
      preview: {
        svg: "<svg viewBox=\"0 0 10 10\"></svg>",
        total_items: 4,
        page_idx: 0,
      },
    }));
    const { rerender, props } = renderModal({ currentPage: undefined });
    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());

    rerender(<CutExportModal {...props} currentPage={1} />);

    expect(document.querySelector("img")).not.toBeNull();
    expect(endpointCalls("/cut-inspect")).toHaveLength(1);
  });

  it("bỏ response cũ đến muộn sau khi user chuyển trang", async () => {
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<Response>((resolve) => { resolveSecond = resolve; });
    let inspectIndex = 0;
    installBackend(() => (inspectIndex++ === 0 ? first : second));
    const { rerender, props } = renderModal({ currentPage: 1 });
    await waitFor(() => expect(endpointCalls("/cut-inspect")).toHaveLength(1));

    rerender(<CutExportModal {...props} currentPage={2} />);
    await waitFor(() => expect(endpointCalls("/cut-inspect")).toHaveLength(2));
    const firstSignal = (endpointCalls("/cut-inspect")[0][1] as RequestInit).signal;
    expect(firstSignal?.aborted).toBe(true);

    resolveSecond(jsonResponse({
      ok: true,
      cut_pages: [1],
      num_pages: 2,
      selected_page_idx: 1,
      candidates: { layers: [], spots: [] },
      preview: { svg: "<svg viewBox=\"0 0 10 10\"></svg>", total_items: 22, page_idx: 1 },
    }));
    await screen.findAllByText("22");

    resolveFirst(jsonResponse({
      ok: true,
      cut_pages: [0],
      num_pages: 2,
      selected_page_idx: 0,
      candidates: { layers: [], spots: [] },
      preview: { svg: "<svg viewBox=\"0 0 10 10\"></svg>", total_items: 11, page_idx: 0 },
    }));
    await act(async () => { await first; await Promise.resolve(); });

    expect(screen.queryByText("11")).toBeNull();
    expect(screen.getAllByText("22").length).toBeGreaterThan(0);
    expect(endpointCalls("/cut-inspect")).toHaveLength(2);
  });

  it("chuyển tiếp proof inspect nguyên vẹn vào export của đúng trang", async () => {
    installBackend(() => jsonResponse({
      ok: true,
      cut_pages: [0],
      num_pages: 1,
      selected_page_idx: 0,
      candidates: { layers: [], spots: [] },
      preview: { svg: "<svg viewBox=\"0 0 10 10\"></svg>", total_items: 4, page_idx: 0 },
      inspect_proof: "proof-page-0",
    }));
    renderModal();
    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "gui" }));

    await waitFor(() => expect(endpointCalls("/cut-export-from-file")).toHaveLength(1));
    const init = endpointCalls("/cut-export-from-file")[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      page_idx: 0,
      inspect_proof: "proof-page-0",
    });
  });

  it("sidecar unified đời cũ không có proof vẫn đi đúng một export legacy", async () => {
    installBackend(() => jsonResponse({
      ok: true,
      cut_pages: [0],
      num_pages: 1,
      selected_page_idx: 0,
      candidates: { layers: [], spots: [] },
      preview: { svg: "<svg viewBox=\"0 0 10 10\"></svg>", total_items: 4, page_idx: 0 },
    }));
    renderModal();
    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "gui" }));

    await waitFor(() => expect(endpointCalls("/cut-export-from-file")).toHaveLength(1));
    expect(endpointCalls("/cut-inspect")).toHaveLength(1);
    const init = endpointCalls("/cut-export-from-file")[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).not.toHaveProperty("inspect_proof");
  });

  it("proof stale thì làm mới preview nhưng không tự gửi lại trước khi user xác nhận", async () => {
    let inspectCount = 0;
    let exportCount = 0;
    installBackend(
      () => {
        const proof = inspectCount++ === 0 ? "proof-stale" : "proof-fresh";
        return jsonResponse({
          ok: true,
          cut_pages: [0],
          num_pages: 1,
          selected_page_idx: 0,
          candidates: { layers: [], spots: [] },
          preview: { svg: "<svg viewBox=\"0 0 10 10\"></svg>", total_items: 4, page_idx: 0 },
          inspect_proof: proof,
        });
      },
      () => exportCount++ === 0
        ? jsonResponse({ ok: false, proof_error: "source-stale", error: "proof stale" })
        : jsonResponse({ ok: true, channel: "file", detail: "cut.plt", bytes_sent: 10 }),
    );
    renderModal();
    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "gui" }));

    await waitFor(() => expect(endpointCalls("/cut-inspect")).toHaveLength(2));
    expect(endpointCalls("/cut-export-from-file")).toHaveLength(1);

    // Preview mới đã hiện, nhưng lệnh thứ hai chỉ được phát sau một click mới.
    fireEvent.click(screen.getByRole("button", { name: "gui" }));
    await waitFor(() => expect(endpointCalls("/cut-export-from-file")).toHaveLength(2));
    const proofs = endpointCalls("/cut-export-from-file").map(([, init]) => (
      JSON.parse(String((init as RequestInit).body)).inspect_proof
    ));
    expect(proofs).toEqual(["proof-stale", "proof-fresh"]);
  });

  it("Gửi tất cả lấy proof riêng và xuất đúng từng trang CUT", async () => {
    installBackend(() => jsonResponse({
      ok: true,
      cut_pages: [0, 2],
      num_pages: 3,
      selected_page_idx: 0,
      candidates: { layers: [], spots: [] },
      preview: { svg: "<svg viewBox=\"0 0 10 10\"></svg>", total_items: 4, page_idx: 0 },
      inspect_proof: "proof-page-0",
      inspect_proofs: { "0": "proof-page-0", "2": "proof-page-2" },
    }));
    renderModal();
    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "gui_tat_ca_n" }));

    await waitFor(() => expect(endpointCalls("/cut-export-from-file")).toHaveLength(2));
    const requests = endpointCalls("/cut-export-from-file").map(([, init]) => (
      JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>
    ));
    expect(requests.map(({ page_idx, inspect_proof }) => ({ page_idx, inspect_proof }))).toEqual([
      { page_idx: 0, inspect_proof: "proof-page-0" },
      { page_idx: 2, inspect_proof: "proof-page-2" },
    ]);
    await waitFor(() => expect(endpointCalls("/cut-inspect")).toHaveLength(2));
  });

  it("Gửi tất cả dừng ngay lỗi đầu tiên và không trộn revision", async () => {
    installBackend(
      () => jsonResponse({
        ok: true,
        cut_pages: [0, 2],
        num_pages: 3,
        selected_page_idx: 0,
        candidates: { layers: [], spots: [] },
        preview: { svg: "<svg viewBox=\"0 0 10 10\"></svg>", total_items: 4, page_idx: 0 },
        inspect_proof: "proof-page-0",
        inspect_proofs: { "0": "proof-page-0", "2": "proof-page-2" },
      }),
      () => jsonResponse({ ok: false, proof_error: "source-stale", error: "File đã đổi." }),
    );
    renderModal();
    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "gui_tat_ca_n" }));

    await waitFor(() => expect(endpointCalls("/cut-inspect")).toHaveLength(2));
    expect(endpointCalls("/cut-export-from-file")).toHaveLength(1);
  });

  it("giữ ledger khi Gửi tất cả lỗi giữa chừng và chỉ gửi lại các tờ còn thiếu", async () => {
    let inspectCount = 0;
    let exportCount = 0;
    const requests: Array<Record<string, unknown>> = [];
    installBackend(
      () => {
        const revision = inspectCount++;
        return jsonResponse({
          ok: true,
          cut_pages: [0, 1, 2],
          num_pages: 3,
          selected_page_idx: 0,
          candidates: { layers: [], spots: [] },
          preview: { svg: "<svg viewBox=\"0 0 10 10\"></svg>", total_items: 4, page_idx: 0 },
          inspect_proof: `proof-${revision}-0`,
          inspect_proofs: {
            "0": `proof-${revision}-0`,
            "1": `proof-${revision}-1`,
            "2": `proof-${revision}-2`,
          },
        });
      },
      (init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push(body);
        if (exportCount++ === 1) {
          return jsonResponse({ ok: false, error: "Máy bế từ chối tờ 2." });
        }
        return jsonResponse({ ok: true, channel: "file", detail: "cut.plt", bytes_sent: 10 });
      },
    );
    renderModal();
    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "gui_tat_ca_n" }));
    await waitFor(() => expect(endpointCalls("/cut-inspect")).toHaveLength(2));
    expect(requests.map(({ page_idx }) => page_idx)).toEqual([0, 1]);

    const ledger = screen.getByTestId("cut-export-batch-status");
    expect(ledger.getAttribute("data-sent-pages")).toBe("0");
    expect(ledger.getAttribute("data-pending-pages")).toBe("1,2");
    const retry = screen.getByRole("button", { name: "gui_cac_to_con_lai" });
    expect((retry as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(retry);
    await waitFor(() => expect(endpointCalls("/cut-export-from-file")).toHaveLength(4));
    expect(requests.map(({ page_idx }) => page_idx)).toEqual([0, 1, 1, 2]);
    expect(requests[2].inspect_proof).toBe("proof-1-1");
    expect(requests[3].inspect_proof).toBe("proof-1-2");
  });

  it("khóa tiếp tục khi proof lỗi sau một tờ đã tới máy", async () => {
    let exportCount = 0;
    installBackend(
      () => jsonResponse({
        ok: true,
        cut_pages: [0, 1, 2],
        num_pages: 3,
        selected_page_idx: 0,
        candidates: { layers: [], spots: [] },
        preview: { svg: "<svg viewBox=\"0 0 10 10\"></svg>", total_items: 4, page_idx: 0 },
        inspect_proof: "proof-page-0",
        inspect_proofs: {
          "0": "proof-page-0",
          "1": "proof-page-1",
          "2": "proof-page-2",
        },
      }),
      () => exportCount++ === 0
        ? jsonResponse({ ok: true, channel: "tcp", detail: "máy-bế", bytes_sent: 10 })
        : jsonResponse({ ok: false, proof_error: "bad-signature", error: "Sidecar đã đổi phiên." }),
    );
    renderModal();
    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "gui_tat_ca_n" }));

    await waitFor(() => expect(endpointCalls("/cut-inspect")).toHaveLength(2));
    expect(endpointCalls("/cut-export-from-file")).toHaveLength(2);
    const ledger = screen.getByTestId("cut-export-batch-status");
    expect(ledger.getAttribute("data-sent-pages")).toBe("0");
    expect(ledger.getAttribute("data-pending-pages")).toBe("1,2");
    expect(screen.getByText("lo_gui_mot_phan_da_doi_revision")).not.toBeNull();
    expect((screen.getByRole("button", { name: "gui_cac_to_con_lai" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "gui_to_nay" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("khóa double-click và không cho đóng modal khi lệnh máy đang chạy", async () => {
    let resolveExport!: (response: Response) => void;
    const pendingExport = new Promise<Response>((resolve) => { resolveExport = resolve; });
    installBackend(
      () => jsonResponse({
        ok: true,
        cut_pages: [0],
        num_pages: 1,
        selected_page_idx: 0,
        candidates: { layers: [], spots: [] },
        preview: { svg: "<svg viewBox=\"0 0 10 10\"></svg>", total_items: 4, page_idx: 0 },
        inspect_proof: "proof-page-0",
      }),
      () => pendingExport,
    );
    const { props } = renderModal();
    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());
    const send = screen.getByRole("button", { name: "gui" });

    fireEvent.click(send);
    fireEvent.click(send);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("dialog"));

    expect(endpointCalls("/cut-export-from-file")).toHaveLength(1);
    expect(props.onClose).not.toHaveBeenCalled();
    resolveExport(jsonResponse({ ok: true, channel: "file", detail: "cut.plt", bytes_sent: 10 }));
    await waitFor(() => expect(endpointCalls("/cut-inspect")).toHaveLength(2));
  });
});
