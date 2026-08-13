// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import GridPreview from "./GridPreview";
import type { CutBorderConfig } from "../types";
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

function MixedPreview({
  cutBorder,
  bleed = 0,
  targetQuantity = 1,
}: {
  cutBorder?: CutBorderConfig;
  bleed?: number;
  targetQuantity?: number;
}) {
  return (
    <GridPreview
      taskMode="nup"
      isDieCut={false}
      layoutType="mixed_guillotine"
      duplexFlow="double"
      duplexFlipEdge="long"
      gridStrategy="optimal_auto"
      alternateRotation="column"
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
      targetQuantity={targetQuantity}
      targetQuantitiesByPage={{ 0: 1 }}
      sourceTotalPages={2}
      filePath="C:\\mixed-materialized.pdf"
      bleed={bleed}
      cutBorder={cutBorder}
    />
  );
}

function renderMixedPreview(cutBorder?: CutBorderConfig, bleed = 0, targetQuantity = 1) {
  return render(
    <MixedPreview cutBorder={cutBorder} bleed={bleed} targetQuantity={targetQuantity} />,
  );
}

function cncMultiSheetResponse() {
  const firstCell = mixedCell(10, 0);
  const secondCell = mixedCell(10, 1);
  const sheet = (cell: ReturnType<typeof mixedCell>, physicalSheetIndex: number) => ({
    cells: [cell],
    overallWidth: pt(30),
    overallHeight: pt(70),
    totalItems: 1,
    runCount: 1,
    physicalSheetIndex,
    placedByPage: { [String(cell.pageIdx)]: 1 },
  });
  return {
    success: true,
    cells: [firstCell],
    overallWidth: pt(30),
    overallHeight: pt(70),
    totalItems: 1,
    sheetsNeeded: 2,
    strategyUsed: "cnc_mixed",
    isMixedPreview: true,
    isCncPreview: true,
    cncTwoSided: false,
    cncFlipEdge: "long",
    absPlacement: true,
    placedByPage: { "0": 1 },
    sheets: [sheet(firstCell, 0), sheet(secondCell, 1)],
  };
}

function CncMultiSheetPreview() {
  return (
    <GridPreview
      taskMode="nup"
      isDieCut
      layoutType="sequential"
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
      filePath="C:\\cnc-two-sheets.pdf"
      imposerMode="cnc"
      cncTwoSided={false}
      cncFlipEdge="long"
    />
  );
}

function StrictWorkingSourcePreview({
  previewSourceKey,
  getWorkingFile,
}: {
  previewSourceKey: string;
  getWorkingFile: () => Promise<File>;
}) {
  return (
    <GridPreview
      taskMode="nup"
      isDieCut={false}
      layoutType="mixed_guillotine"
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
      filePath="C:\\original-three-pages.pdf"
      previewSourceKey={previewSourceKey}
      getWorkingFile={getWorkingFile}
    />
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

function inkingDirectionResponse() {
  const cells = [
    { isRotated: false, isRotated180: false },
    { isRotated: true, isRotated180: false },
    { isRotated: false, isRotated180: true },
    { isRotated: true, isRotated180: true },
  ].map((rotation, index) => ({
    x: pt(index * 20),
    y: 0,
    width: pt(20),
    height: pt(10),
    blockId: 0,
    ...rotation,
  }));

  return {
    success: true,
    cells,
    overallWidth: pt(80),
    overallHeight: pt(10),
    totalItems: 4,
    strategyUsed: "optimal_auto",
    isMixedPreview: false,
    absPlacement: false,
    sheetsNeeded: 1,
  };
}

function InkingDirectionPreview({
  alternateRotation,
  duplexFlow = "normal",
  activeTool = "nup",
  isDieCut = false,
  shapeType = "RECTANGLE",
}: {
  alternateRotation: "none" | "row" | "column";
  duplexFlow?: "normal" | "double";
  activeTool?: "nup" | "sticker_imposer" | "cnc_imposer";
  isDieCut?: boolean;
  shapeType?: string;
}) {
  return (
    <GridPreview
      activeTool={activeTool}
      taskMode="nup"
      isDieCut={isDieCut}
      layoutType="sequential"
      duplexFlow={duplexFlow}
      gridStrategy="optimal_auto"
      alternateRotation={alternateRotation}
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
      shapeType={shapeType}
      itemW={20}
      itemH={10}
      sourceTotalPages={1}
      filePath="C:\\inking-direction.pdf"
    />
  );
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
    expect(requestBody.alternate_rotation).toBe("none");
    expect(requestBody.duplex_flip_edge).toBe("long");

    fireEvent.click(screen.getByRole("button", { name: "►" }));
    await waitFor(() => expect(screen.getByText("1b")).toBeTruthy());

    // scale = min((260-16)/100, (160-16)/80) = 1,8; x = pad 8 + 70×1,8.
    expect(Number(renderedProductRect(container).getAttribute("x"))).toBeCloseTo(134, 5);
    expect(container.querySelectorAll("svg")).toHaveLength(1);
    expect(container.querySelector('g[transform*="scale(-1, 1)"]')).toBeNull();
    expect(authenticatedFetchMock).toHaveBeenCalledTimes(1);
  });

  it("CNC chuyển được qua mọi tờ mẫu backend trả về", async () => {
    authenticatedFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => cncMultiSheetResponse(),
    });

    const { container } = render(<CncMultiSheetPreview />);
    await waitFor(() => {
      expect(container.querySelector("svg text")?.textContent).toBe("1");
      expect(screen.getByText(/1 \/ 2/)).toBeTruthy();
    });

    const requestBody = JSON.parse(
      String(authenticatedFetchMock.mock.calls[0]?.[1]?.body),
    );
    expect(requestBody.imposer_mode).toBe("cnc");

    fireEvent.click(screen.getByRole("button", { name: "►" }));
    await waitFor(() => {
      expect(container.querySelector("svg text")?.textContent).toBe("2");
      expect(screen.getByText(/2 \/ 2/)).toBeTruthy();
    });
    expect(authenticatedFetchMock).toHaveBeenCalledTimes(1);
  });

  it("vẽ viền từ cell thật, đổi Trim sang Bleed không gọi lại layout", async () => {
    const trimBorder: CutBorderConfig = {
      enabled: true,
      position: "trim",
      color: "#000000",
      thickness: 0.3,
    };
    const { rerender } = renderMixedPreview(trimBorder, 3);

    await waitFor(() => expect(screen.getByTestId("cut-border-preview")).toBeTruthy());
    const trimGroup = screen.getByTestId("cut-border-preview");
    const trimRect = trimGroup.querySelector("rect") as SVGRectElement;
    expect(Number(trimRect.getAttribute("x"))).toBeCloseTo(26, 4);
    expect(Number(trimRect.getAttribute("y"))).toBeCloseTo(26, 4);
    expect(Number(trimRect.getAttribute("width"))).toBeCloseTo(36, 4);

    rerender(
      <MixedPreview
        bleed={3}
        cutBorder={{ ...trimBorder, position: "bleed", color: "#FF0000", thickness: 0.6 }}
      />,
    );
    await waitFor(() => {
      const group = screen.getByTestId("cut-border-preview");
      expect(group.getAttribute("data-position")).toBe("bleed");
      expect(group.getAttribute("stroke")).toBe("#FF0000");
    });
    const bleedRect = screen.getByTestId("cut-border-preview").querySelector("rect") as SVGRectElement;
    expect(Number(bleedRect.getAttribute("x"))).toBeCloseTo(20.6, 4);
    expect(Number(bleedRect.getAttribute("width"))).toBeCloseTo(46.8, 4);
    expect(authenticatedFetchMock).toHaveBeenCalledTimes(1);
  });

  it("giữ đúng kích thước viền cho cell xoay trong layout nhiều kích thước", async () => {
    const response = mixedResponse();
    const rotated = {
      ...mixedCell(40, 1),
      absY: pt(20),
      width: pt(30),
      height: pt(10),
      isRotated: true,
    };
    response.cells = [response.cells[0], rotated];
    response.totalItems = 2;
    response.sheets[0].cells = response.cells;
    authenticatedFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => response,
    });

    renderMixedPreview({
      enabled: true,
      position: "trim",
      color: "#000000",
      thickness: 0.3,
    }, 0, 2);
    await waitFor(() => {
      expect(screen.getByTestId("cut-border-preview").querySelectorAll("rect")).toHaveLength(2);
    });
    const rects = screen.getByTestId("cut-border-preview").querySelectorAll("rect");
    expect(Number(rects[1].getAttribute("width"))).toBeCloseTo(54, 4);
    expect(Number(rects[1].getAttribute("height"))).toBeCloseTo(18, 4);
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

  it.each([
    ["reorder", { o: [3, 1], r: [0, 0] }],
    ["rotation", { o: [1, 2], r: [90, 0] }],
  ])("dừng preview khi %s cần bake nhưng tạo PDF làm việc thất bại", async (_label, state) => {
    const getWorkingFile = vi.fn().mockRejectedValue(new Error("forced bake failure"));

    render(
      <StrictWorkingSourcePreview
        previewSourceKey={JSON.stringify(state)}
        getWorkingFile={getWorkingFile}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Không thể tạo PDF làm việc/)).toBeTruthy();
    }, { timeout: 3_000 });
    expect(getWorkingFile).toHaveBeenCalled();
    expect(authenticatedFetchMock).not.toHaveBeenCalled();
  });
});

describe("GridPreview — hướng xoay Inking", () => {
  beforeEach(() => {
    authenticatedFetchMock.mockReset();
    authenticatedFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => inkingDirectionResponse(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("hiển thị đủ hướng 0/90/180/270 ở cả mặt trước và mặt sau", async () => {
    const { container } = render(
      <InkingDirectionPreview alternateRotation="row" duplexFlow="double" />,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("cell-direction-indicator")).toHaveLength(8);
    }, { timeout: 3_000 });

    const indicators = screen.getAllByTestId("cell-direction-indicator");
    const rotationsFor = (side: "front" | "back") =>
      indicators
        .filter((indicator) => indicator.getAttribute("data-side") === side)
        .map((indicator) => indicator.getAttribute("data-rotation"));

    expect(rotationsFor("front")).toEqual(["0", "90", "180", "270"]);
    expect(rotationsFor("back")).toEqual(["0", "90", "180", "270"]);

    const expectedDirectionColors = ["#047857", "#1d4ed8", "#c2410c", "#7e22ce"];
    const frontIndicators = indicators.filter(
      (indicator) => indicator.getAttribute("data-side") === "front",
    );
    expect(
      frontIndicators.map((indicator) =>
        indicator.getAttribute("data-direction-color"),
      ),
    ).toEqual(expectedDirectionColors);
    expect(new Set(expectedDirectionColors)).toHaveLength(4);
    expect(
      frontIndicators.every(
        (indicator) => Number(indicator.getAttribute("data-indicator-diameter")) >= 10,
      ),
    ).toBe(true);

    expect(screen.getByTestId("inking-direction-legend")).toBeTruthy();

    const backMirrorGroup = container.querySelector('g[transform*="scale(-1, 1)"]');
    expect(backMirrorGroup).not.toBeNull();
    expect(
      backMirrorGroup?.querySelectorAll('[data-testid="cell-direction-indicator"]'),
    ).toHaveLength(4);
  });

  it("không hiển thị marker và chú thích khi Inking tắt", async () => {
    render(
      <InkingDirectionPreview alternateRotation="none" />,
    );

    await waitFor(() => expect(authenticatedFetchMock).toHaveBeenCalled(), {
      timeout: 3_000,
    });
    expect(screen.queryByTestId("cell-direction-indicator")).toBeNull();
    expect(screen.queryByTestId("inking-direction-legend")).toBeNull();
  });

  it('gửi Inking và hiển thị hướng cho tem bế chữ nhật', async () => {
    render(
      <InkingDirectionPreview
        activeTool="sticker_imposer"
        isDieCut
        shapeType="RECTANGLE"
        alternateRotation="column"
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("cell-direction-indicator")).toHaveLength(4);
    }, { timeout: 3_000 });
    const body = JSON.parse(String(authenticatedFetchMock.mock.calls[0]?.[1]?.body));
    expect(body.is_die_cut).toBe(true);
    expect(body.shape_type).toBe('RECTANGLE');
    expect(body.alternate_rotation).toBe('column');
  });

  it.each(['CIRCLE_ELLIPSE', 'CUSTOM'])('ép Inking về none cho tem bế %s', async (shapeType) => {
    render(
      <InkingDirectionPreview
        activeTool="sticker_imposer"
        isDieCut
        shapeType={shapeType}
        alternateRotation="row"
      />,
    );

    await waitFor(() => expect(authenticatedFetchMock).toHaveBeenCalled(), {
      timeout: 3_000,
    });
    const body = JSON.parse(String(authenticatedFetchMock.mock.calls[0]?.[1]?.body));
    expect(body.alternate_rotation).toBe('none');
    expect(screen.queryByTestId("cell-direction-indicator")).toBeNull();
  });
});
