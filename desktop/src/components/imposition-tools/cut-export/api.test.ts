import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  getApiUrl: vi.fn(() => "http://127.0.0.1:8321/api"),
}));

vi.mock("../../../lib/api", () => apiMocks);

import { CutInspectUnavailableError, inspectCutFile } from "./api";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("cut-export inspect API", () => {
  beforeEach(() => {
    apiMocks.authenticatedFetch.mockReset();
    apiMocks.getApiUrl.mockReturnValue("http://127.0.0.1:8321/api");
  });

  it("gửi đúng endpoint/payload và chuyển tiếp AbortSignal", async () => {
    apiMocks.authenticatedFetch.mockResolvedValue(jsonResponse({
      ok: true,
      cut_pages: [1],
      selected_page_idx: 1,
      preview: { page_idx: 1, total_items: 3 },
    }));
    const controller = new AbortController();

    const result = await inspectCutFile(
      { path: "D:\\jobs\\sheet.pdf", page_idx: 0, force_layer: "CutContour" },
      controller.signal,
    );

    expect(result.ok).toBe(true);
    expect(apiMocks.authenticatedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = apiMocks.authenticatedFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8321/api/imposition/cut-inspect");
    expect(init.method).toBe("POST");
    expect(init.signal).toBe(controller.signal);
    expect(JSON.parse(String(init.body))).toEqual({
      path: "D:\\jobs\\sheet.pdf",
      page_idx: 0,
      force_layer: "CutContour",
    });
  });

  it("phân biệt endpoint inspect chưa có để modal mới fallback legacy", async () => {
    apiMocks.authenticatedFetch.mockResolvedValue(jsonResponse("legacy sidecar", 404));

    await expect(inspectCutFile({ path: "missing.pdf" })).rejects.toMatchObject({
      name: CutInspectUnavailableError.name,
      status: 404,
      message: expect.stringContaining("404"),
    });
  });
});
