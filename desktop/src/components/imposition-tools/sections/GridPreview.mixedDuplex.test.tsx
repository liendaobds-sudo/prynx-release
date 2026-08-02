// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import GridPreview from "./GridPreview";
import {
  createImposerSettingsStore,
  ImposerSettingsContext,
  useImposerSettingsStore,
} from "../useImposerSettingsStore";


const authenticatedFetchMock = vi.fn();

vi.mock("../../../lib/api", () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetchMock(...args),
  getApiUrl: () => "http://127.0.0.1:8321/api",
  uploadPDF: vi.fn(),
}));

vi.mock("../../../lib/previewPerfLog", () => ({
  previewPerfLog: vi.fn(),
}));

const MM_TO_PT = 2.83465;

function pt(mm: number): number {
  return mm * MM_TO_PT;
}

function mixedCell(absX: number, pageIdx: number) {
  return {
    x: pt(absX),
    y: pt(10),
    absX: pt(absX),
    absY: pt(50),
    width: pt(20),
    height: pt(20),
    isRotated: false,
    isRotated180: false,
    blockId: 0,
    pageIdx,
  };
}

function mixedResponse() {
  const frontCell = mixedCell(10, 0);
  // Backend đã materialize mặt sau theo cạnh dài: x' = 100 - 10 - 20 = 70 mm.
  const backCell = mixedCell(70, 1);
  const baseSheet = {
    overallWidth: pt(90),
    overallHeight: pt(70),
    totalItems: 1,
    cutLines: { v: [], h: [] },
    cutSegments: [],
    cutTree: { rect: { x: 0, y: 0, width: pt(100), height: pt(80) } },
    physicalSheetIndex: 0,
    runCount: 1,
    planHash: "mixed-materialized-plan",
    planVersion: "mixed-guillotine/v1",
    coordinateSpace: "canonical_top_left_sheet_pt",
  };
  return {
    success: true,
    cells: [frontCell],
    overallWidth: pt(90),
    overallHeight: pt(70),
    totalItems: 1,
    strategyUsed: "mixed_guillotine",
    isMixedPreview: true,
    absPlacement: true,
    sheetsNeeded: 1,
    duplex: true,
    flipEdge: "long",
    planHash: "mixed-materialized-plan",
    planVersion: "mixed-guillotine/v1",
    coordinateSpace: "canonical_top_left_sheet_pt",
    cutLines: { v: [], h: [] },
    cutSegments: [],
    sheets: [
      { ...baseSheet, side: "front", cells: [frontCell] },
      { ...baseSheet, side: "back", cells: [backCell] },
    ],
  };
}

function renderMixedPreview() {
  return render(
    <GridPreview
      taskMode="nup"
      isDieCut={false}
      layoutType="mixed_guillotine"
      duplexFlow="double"
      duplexFlipEdge="long"
      gridStrategy="optimal_auto"
      columns={0}
      rows={0}
      gapX={0}
      gapY={0}
      sheetWidth={100}
      sheetHeight={80}
      marginTop={0}
      marginBottom={0}
      marginLeft={0}
      marginRight={0}
      align="center"
      shapeType="CUSTOM"
      itemW={20}
      itemH={20}
      targetQuantity={1}
      targetQuantitiesByPage={{ 0: 1 }}
      sourceTotalPages={2}
      filePath="C:\\mixed-materialized.pdf"
    />,
  );
}

function AutoDetectPreviewHarness() {
  const layoutType = useImposerSettingsStore((state) => state.layoutType);
  return (
    <GridPreview
      taskMode="nup"
      isDieCut={false}
      layoutType={layoutType}
      duplexFlow="normal"
      gridStrategy="optimal_auto"
      columns={0}
      rows={0}
      gapX={0}
      gapY={0}
      sheetWidth={100}
      sheetHeight={80}
      marginTop={0}
      marginBottom={0}
      marginLeft={0}
      marginRight={0}
      align="center"
      shapeType="CUSTOM"
      itemW={20}
      itemH={20}
      sourceTotalPages={2}
      filePath="C:\\mixed-size-auto.pdf"
    />
  );
}

function renderAutoDetectPreview() {
  localStorage.clear();
  const store = createImposerSettingsStore();
  store.setState({ taskMode: "nup", layoutType: "sequential" });
  const view = render(
    <ImposerSettingsContext.Provider value={store}>
      <AutoDetectPreviewHarness />
    </ImposerSettingsContext.Provider>,
  );
  return { store, ...view };
}
function renderedProductRect(container: HTMLElement): SVGRectElement {
  const rect = container.querySelector<SVGRectElement>(
    'rect[fill="rgba(99, 102, 241, 0.20)"]',
  );
  expect(rect).not.toBeNull();
  return rect as SVGRectElement;
}

describe("GridPreview — mặt sau mixed đã được backend materialize", () => {
  beforeEach(() => {
    authenticatedFetchMock.mockReset();
    authenticatedFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mixedResponse(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("dùng nguyên sheet back và không áp legacy mirror lần hai", async () => {
    const { container } = renderMixedPreview();

    await waitFor(() => expect(screen.getByText("1a")).toBeTruthy(), {
      timeout: 3_000,
    });
    expect(Number(renderedProductRect(container).getAttribute("x"))).toBeCloseTo(26, 5);

    const requestBody = JSON.parse(
      String(authenticatedFetchMock.mock.calls[0]?.[1]?.body),
    );
    expect(requestBody.layout_type).toBe("mixed_guillotine");
    expect(requestBody.duplex_flip_edge).toBe("long");

    fireEvent.click(screen.getByRole("button", { name: "►" }));
    await waitFor(() => expect(screen.getByText("1b")).toBeTruthy());

    // scale = min((260-16)/100, (160-16)/80) = 1,8; x = pad 8 + 70×1,8.
    expect(Number(renderedProductRect(container).getAttribute("x"))).toBeCloseTo(134, 5);
    expect(container.querySelectorAll("svg")).toHaveLength(1);
    expect(container.querySelector('g[transform*="scale(-1, 1)"]')).toBeNull();
    expect(authenticatedFetchMock).toHaveBeenCalledTimes(1);
  });
  it("tự chuyển sang mixed-size và gọi lại preview khi backend phát hiện nhiều khổ", async () => {
    authenticatedFetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: async () => JSON.stringify({
          detail: "Dàn nhiều mẫu cắt xén chỉ hỗ trợ các trang cùng kích thước.",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mixedResponse(),
      });

    const { store } = renderAutoDetectPreview();

    await waitFor(() => {
      expect(store.getState().layoutType).toBe("mixed_guillotine");
      expect(authenticatedFetchMock).toHaveBeenCalledTimes(2);
    }, { timeout: 3_000 });

    const retryBody = JSON.parse(
      String(authenticatedFetchMock.mock.calls[1]?.[1]?.body),
    );
    expect(retryBody.layout_type).toBe("mixed_guillotine");
  });
});
