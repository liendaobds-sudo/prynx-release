// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import GridPreview from "./GridPreview";
import { DEFAULT_REPORT_CONFIG, type CutBorderConfig } from "../types";
import { DEFAULT_PONT_CONFIG } from "../pontConfigDefaults";
import {
  createImposerSettingsStore,
  ImposerSettingsContext,
  useImposerSettingsStore,
} from "../useImposerSettingsStore";


const authenticatedFetchMock = vi.fn();
const nestingJobMocks = vi.hoisted(() => ({
  create: vi.fn(),
  status: vi.fn(),
  result: vi.fn(),
  cancel: vi.fn(),
  wait: vi.fn(),
}));

vi.mock("../../../lib/api", () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetchMock(...args),
  getApiUrl: () => "http://127.0.0.1:8321/api",
  uploadPDF: vi.fn(),
}));

vi.mock("../../../lib/previewPerfLog", () => ({
  previewPerfLog: vi.fn(),
}));

vi.mock("../../../lib/mixed-nesting/api", () => ({
  createNestingPreviewJob: (...args: unknown[]) => nestingJobMocks.create(...args),
  getNestingPreviewJobStatus: (...args: unknown[]) => nestingJobMocks.status(...args),
  getNestingPreviewJobResult: (...args: unknown[]) => nestingJobMocks.result(...args),
  cancelNestingPreviewJob: (...args: unknown[]) => nestingJobMocks.cancel(...args),
  waitForNestingPreviewJob: (...args: unknown[]) => nestingJobMocks.wait(...args),
}));

// PARITY (audit 2026-08-29 §NEST-PARITY-1): fixture phải dùng cùng hệ số chính xác
// với frontend/backend; hằng rút gọn từng che việc session preview và export lệch ULP.
const MM_TO_PT = 72 / 25.4;

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

function capacityResponse(totalItems: number, strategyUsed: string) {
  return {
    ...mixedResponse(),
    totalItems,
    strategyUsed,
    isMixedPreview: false,
    duplex: false,
    sheets: undefined,
  };
}

function stepRepeatSheetsResponse(pageIndices: number[]) {
  const sheets = pageIndices.map((pageIdx, physicalSheetIndex) => {
    const cell = mixedCell(10, pageIdx);
    return {
      cells: [cell],
      overallWidth: pt(320),
      overallHeight: pt(430),
      totalItems: 1,
      physicalSheetIndex,
      runCount: 1,
    };
  });
  return {
    success: true,
    totalItems: 1,
    overallWidth: pt(320),
    overallHeight: pt(430),
    strategyUsed: "true_shape_nesting",
    cells: sheets[0]?.cells || [],
    absPlacement: true,
    isMixedPreview: false,
    sheetsNeeded: sheets.length,
    coordinateSpace: "sheet_abs_pt",
    sheets,
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
      // §B10: test này khoá điều hướng nhiều tờ trên ĐƯỜNG LƯỚI (authenticatedFetch).
      // Hình có tên (RECTANGLE) ⇒ usesTrueShape=false ⇒ đi lưới; nếu để CUSTOM thì nay
      // auto-route sang nesting (đường khác, mock khác) — đúng hành vi mới nhưng lệch test này.
      shapeType="RECTANGLE"
      shapesByPage={{ 0: "RECTANGLE", 1: "RECTANGLE" }}
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

function TrueShapeParityPreview({
  reportOrderCode = "DH-001",
  reportLabelName = "TEM",
  reportMaterial = "Decal PP",
  taskMode = "nup",
  layoutType,
  duplexFlow = "normal",
  isActive = true,
  previewSourceKey,
  getWorkingFile,
  onCapacityChange,
  onDiagnosticEvent,
  pageIdx = 0,
  sourceTotalPages = 1,
  shapesByPage = { 0: "CUSTOM" },
  shapeParamsByPage,
  targetQuantitiesByPage = { 0: 6 },
  targetQuantity,
  itemW = 20,
  itemH = 20,
  gapX = 2,
  gridStrategy = "optimal_auto",
  imposerMode,
  cncTwoSided = false,
  cncDuplexMarks = false,
}: {
  reportOrderCode?: string;
  reportLabelName?: string;
  reportMaterial?: string;
  taskMode?: string;
  layoutType?: string;
  duplexFlow?: "normal" | "double";
  isActive?: boolean;
  previewSourceKey?: string;
  getWorkingFile?: () => Promise<File>;
  onCapacityChange?: (capacity: number) => void;
  onDiagnosticEvent?: React.ComponentProps<typeof GridPreview>["onDiagnosticEvent"];
  pageIdx?: number;
  sourceTotalPages?: number;
  shapesByPage?: Record<number, string>;
  shapeParamsByPage?: Record<number, Record<string, unknown>>;
  targetQuantitiesByPage?: Record<number, number>;
  targetQuantity?: number;
  itemW?: number;
  itemH?: number;
  gapX?: number;
  gridStrategy?: React.ComponentProps<typeof GridPreview>["gridStrategy"];
  imposerMode?: string;
  cncTwoSided?: boolean;
  cncDuplexMarks?: boolean;
} = {}) {
  const activeShapeParams = shapeParamsByPage?.[pageIdx];
  const effectiveLayoutType = layoutType
    ?? (taskMode === "step_repeat" ? "repeat" : "sequential");
  return (
    <GridPreview
      isActive={isActive}
      activeTool={imposerMode === "cnc" ? "cnc_imposer" : "sticker_imposer"}
      taskMode={taskMode}
      isDieCut
      layoutType={effectiveLayoutType}
      duplexFlow={duplexFlow}
      imposerMode={imposerMode}
      cncTwoSided={cncTwoSided}
      cncFlipEdge="long"
      cncDuplexMarks={cncDuplexMarks}
      // §B10: mặc định auto-route; test explicit truyền token để khóa intent fallback.
      gridStrategy={gridStrategy}
      columns={0}
      rows={0}
      gapX={gapX}
      gapY={2}
      sheetWidth={320}
      sheetHeight={430}
      marginTop={3}
      marginBottom={3}
      marginLeft={3}
      marginRight={3}
      align="center"
      shapeType={shapesByPage[pageIdx] || "CUSTOM"}
      shapesByPage={shapesByPage}
      shapeParams={activeShapeParams ? JSON.stringify(activeShapeParams) : null}
      shapeParamsByPage={shapeParamsByPage}
      itemW={itemW}
      itemH={itemH}
      targetQuantity={targetQuantity}
      targetQuantitiesByPage={targetQuantitiesByPage}
      sourceTotalPages={sourceTotalPages}
      filePath="C:\\nesting-parity.pdf"
      pageIdx={pageIdx}
      previewSourceKey={previewSourceKey}
      getWorkingFile={getWorkingFile}
      pontType="5mm"
      pontConfig={{ ...DEFAULT_PONT_CONFIG, size: 5 }}
      cutType="default"
      fillBlockGap={0}
      dieSizeMode="die"
      dieOffsetMm={0}
      separateCutPage
      pontsOnCutFile
      exportUniqueSheets
      reportDisplay={{ ...DEFAULT_REPORT_CONFIG, labelNameText: reportLabelName }}
      reportMaterial={reportMaterial}
      reportLamination={1}
      reportLaminationSides={1}
      reportOrderCode={reportOrderCode}
      onCapacityChange={onCapacityChange}
      onDiagnosticEvent={onDiagnosticEvent}
    />
  );
}

function StrictWorkingSourcePreview({
  previewSourceKey,
  getWorkingFile,
  requiresWorkingSource = false,
}: {
  previewSourceKey: string;
  getWorkingFile: () => Promise<File>;
  requiresWorkingSource?: boolean;
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
      requiresWorkingSource={requiresWorkingSource}
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
      // §B10: tem bế thật luôn có shapesByPage (previewDetectedShapesByPage). Hình có tên
      // ⇒ usesTrueShape=false ⇒ đi lưới (nơi Inking sống). Không truyền map thì bản sao
      // route_true_shape coi "chưa dò = CUSTOM = đặc biệt" và nhầm sang nesting.
      shapesByPage={isDieCut ? { 0: shapeType } : undefined}
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
    nestingJobMocks.create.mockReset();
    nestingJobMocks.status.mockReset();
    nestingJobMocks.result.mockReset();
    nestingJobMocks.cancel.mockReset();
    nestingJobMocks.wait.mockReset();
    nestingJobMocks.cancel.mockResolvedValue({
      job_id: "nest-preview",
      status: "cancelled",
      cancelled: true,
      already_cancelled: false,
      terminal: true,
    });
    nestingJobMocks.create.mockResolvedValue({ job_id: "nest-preview", status: "queued" });
    nestingJobMocks.wait.mockResolvedValue({
      job_id: "nest-preview",
      status: "completed",
      terminal: true,
      cancel_requested: false,
      created_at: 1,
      started_at: 1,
      completed_at: 2,
      progress: { phase: "completed", progress: 1, elapsedMs: 100 },
      error_code: null,
      message: null,
      has_result: true,
    });
    nestingJobMocks.result.mockResolvedValue(mixedResponse());
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
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

  it("không ghi request PDF/hình học hoặc raw response khi preview API lỗi", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rawEngineResponse = JSON.stringify({
      detail: "Không thể tính preview thử nghiệm.",
      internal: "engine-private-detail",
    });
    authenticatedFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => rawEngineResponse,
    });

    renderMixedPreview();
    await waitFor(() => {
      expect(authenticatedFetchMock).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Không thể tính preview thử nghiệm.")).toBeTruthy();
    }, { timeout: 3_000 });

    expect(errorLog).toHaveBeenCalledWith(
      "[GridPreview] Preview layout API failed:",
      { status: 500 },
    );
    const serializedLogs = JSON.stringify(errorLog.mock.calls);
    expect(serializedLogs).not.toContain("mixed-materialized.pdf");
    expect(serializedLogs).not.toContain("engine-private-detail");
    errorLog.mockRestore();
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

  it("CNC S&R refetch theo trang và giữ đúng hình dạng khuôn từng trang", async () => {
    // CNC S&R (step_repeat/repeat) là một khuôn trên mỗi mẫu, không phải multi-pack.
    // Nếu GridPreview gộp mọi CNC nhiều trang vào _multiPackLayout, lần xem trang 2
    // sẽ không refetch và request vẫn dùng page_idx/shape của trang 1.
    authenticatedFetchMock.mockReset();
    authenticatedFetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => capacityResponse(12, "optimal_auto"),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => capacityResponse(8, "optimal_auto"),
      });

    const shapesByPage = { 0: "RECTANGLE", 1: "PENTAGON" };
    const shapeParamsByPage = {
      0: { bodyW: pt(20), bodyH: pt(20) },
      1: { bodyW: pt(30), bodyH: pt(25) },
    };
    const previewAt = (pageIdx: number) => (
      <TrueShapeParityPreview
        taskMode="step_repeat"
        layoutType="repeat"
        imposerMode="cnc"
        pageIdx={pageIdx}
        sourceTotalPages={2}
        shapesByPage={shapesByPage}
        shapeParamsByPage={shapeParamsByPage}
        targetQuantitiesByPage={{ 0: 6, 1: 6 }}
        itemW={pageIdx === 0 ? 20 : 30}
      />
    );

    const view = render(previewAt(0));
    await waitFor(() => expect(authenticatedFetchMock).toHaveBeenCalledTimes(1), {
      timeout: 3_000,
    });

    view.rerender(previewAt(1));
    await waitFor(() => expect(authenticatedFetchMock).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });

    const secondBody = JSON.parse(String(authenticatedFetchMock.mock.calls[1]?.[1]?.body));
    expect(secondBody.imposer_mode).toBe("cnc");
    expect(secondBody.task_mode).toBe("step_repeat");
    expect(secondBody.layout_type).toBe("repeat");
    expect(secondBody.page_idx).toBe(1);
    expect(secondBody.shape_type).toBe("PENTAGON");
    expect(secondBody.shape_props).toEqual(shapeParamsByPage[1]);
  });

  it("CNC alias SR không bị gom thành multi-pack khi layout cũ còn là sequential", async () => {
    authenticatedFetchMock.mockReset();
    authenticatedFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => capacityResponse(8, "optimal_auto"),
    });

    render(
      <TrueShapeParityPreview
        taskMode="sr"
        layoutType="sequential"
        imposerMode="cnc"
        pageIdx={1}
        sourceTotalPages={2}
        shapesByPage={{ 0: "RECTANGLE", 1: "PENTAGON" }}
        shapeParamsByPage={{
          0: { bodyW: pt(20), bodyH: pt(20) },
          1: { bodyW: pt(30), bodyH: pt(25) },
        }}
        targetQuantitiesByPage={{ 0: 6, 1: 6 }}
        itemW={30}
      />,
    );

    await waitFor(() => expect(authenticatedFetchMock).toHaveBeenCalledTimes(1), {
      timeout: 3_000,
    });
    const body = JSON.parse(String(authenticatedFetchMock.mock.calls[0]?.[1]?.body));
    expect(body.page_idx).toBe(1);
    expect(body.shape_type).toBe("PENTAGON");
  });

  it("gửi đúng hợp đồng nesting để preview và export dùng chung identity", async () => {
    render(<TrueShapeParityPreview />);

    await waitFor(() => expect(nestingJobMocks.create).toHaveBeenCalledTimes(1), {
      timeout: 3_000,
    });
    const requestBody = nestingJobMocks.create.mock.calls[0]?.[0];

    // §B10: dù "Cách xếp" của người dùng là optimal_auto, body gửi token giao thức
    // true_shape_nesting để endpoint preview nhận đúng nhánh nesting (parity với export).
    expect(requestBody.strategy).toBe("true_shape_nesting");
    expect(requestBody.allow_legacy_fallback).toBe(true);
    expect(requestBody.sheet_w).toBe(320 * (72 / 25.4));
    expect(requestBody.sheet_h).toBe(430 * (72 / 25.4));
    expect(requestBody.margin_left).toBe(3 * (72 / 25.4));
    expect(requestBody.gap_x).toBe(2 * (72 / 25.4));
    expect(requestBody.pont_type).toBe("5mm");
    expect(requestBody.pont_config.size).toBe(5);
    expect(requestBody.separate_cut_page).toBe(true);
    expect(requestBody.ponts_on_cut_file).toBe(true);
    expect(requestBody.export_unique_sheets).toBe(true);
    expect(requestBody.report_display.fieldOrder).toHaveLength(13);
    expect(requestBody.report_order_code).toBe("DH-001");
    expect(requestBody.cnc_duplex_marks).toBe(false);
    expect(authenticatedFetchMock).not.toHaveBeenCalled();
  });

  it("PARITY §NEST26.1: gửi dấu canh CNC hai mặt và đổi cờ làm mới cache", async () => {
    const view = render(
      <TrueShapeParityPreview
        sourceTotalPages={2}
        imposerMode="cnc"
        cncTwoSided
        cncDuplexMarks
      />,
    );

    await waitFor(() => expect(nestingJobMocks.create).toHaveBeenCalledTimes(1), {
      timeout: 3_000,
    });
    expect(nestingJobMocks.create.mock.calls[0]?.[0]?.cnc_two_sided).toBe(true);
    expect(nestingJobMocks.create.mock.calls[0]?.[0]?.cnc_duplex_marks).toBe(true);

    view.rerender(
      <TrueShapeParityPreview
        sourceTotalPages={2}
        imposerMode="cnc"
        cncTwoSided
        cncDuplexMarks={false}
      />,
    );
    await waitFor(() => expect(nestingJobMocks.create).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });
    expect(nestingJobMocks.create.mock.calls[1]?.[0]?.cnc_duplex_marks).toBe(false);
  });

  it("metadata report không làm chạy lại preview của token nesting tường minh", async () => {
    const view = render(
      <TrueShapeParityPreview
        gridStrategy="true_shape_nesting"
        reportOrderCode="DH-001"
      />,
    );

    await waitFor(() => expect(authenticatedFetchMock).toHaveBeenCalledTimes(1), {
      timeout: 3_000,
    });
    const firstRequestBody = JSON.parse(
      String(authenticatedFetchMock.mock.calls[0]?.[1]?.body),
    );
    expect(firstRequestBody.strategy).toBe("true_shape_nesting");
    expect(firstRequestBody.allow_legacy_fallback).toBe(false);
    expect(firstRequestBody.report_order_code).toBe("DH-001");
    expect(nestingJobMocks.create).not.toHaveBeenCalled();

    view.rerender(
      <TrueShapeParityPreview
        gridStrategy="true_shape_nesting"
        reportOrderCode="DH-002"
        reportLabelName="TEM MỚI"
      />,
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 350));
    });
    expect(authenticatedFetchMock).toHaveBeenCalledTimes(1);
    expect(nestingJobMocks.create).not.toHaveBeenCalled();
  });

  it("B10-6: lưới bắt đầu ở 250ms nhưng nesting chỉ bắt đầu ở 750ms", async () => {
    vi.useFakeTimers();
    nestingJobMocks.wait.mockImplementation(() => new Promise(() => undefined));
    const view = render(<TrueShapeParityPreview taskMode="step_repeat" />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(249);
    });
    expect(authenticatedFetchMock).not.toHaveBeenCalled();
    expect(nestingJobMocks.create).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(authenticatedFetchMock).toHaveBeenCalledTimes(1);
    expect(nestingJobMocks.create).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(nestingJobMocks.create).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(nestingJobMocks.create).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("B10-6: Bình trang hiện lưới trước trong khi nesting tiếp tục chạy nền", async () => {
    const onCapacityChange = vi.fn();
    authenticatedFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => capacityResponse(54, "optimal_auto"),
    });
    nestingJobMocks.wait.mockImplementation(() => new Promise(() => undefined));

    render(
      <TrueShapeParityPreview
        taskMode="step_repeat"
        onCapacityChange={onCapacityChange}
      />,
    );

    await waitFor(() => expect(screen.getByText("1 / 54")).toBeTruthy(), {
      timeout: 3_000,
    });
    await waitFor(() => expect(nestingJobMocks.create).toHaveBeenCalledTimes(1), {
      timeout: 3_000,
    });
    const provisionalBody = JSON.parse(
      String(authenticatedFetchMock.mock.calls[0]?.[1]?.body),
    );
    const nestingBody = JSON.parse(JSON.stringify(nestingJobMocks.create.mock.calls[0]?.[0]));
    expect(provisionalBody.strategy).toBe("optimal_auto");
    expect(nestingBody).toEqual({ ...provisionalBody, strategy: "true_shape_nesting" });
    expect(onCapacityChange).toHaveBeenLastCalledWith(54);
    expect(screen.getByTestId("nesting-preview-progress")).toBeTruthy();
    expect(screen.queryByTestId("layout-engine-indicator")).toBeNull();
  });

  it("B10-6: nesting thắng thì nâng cấp provisional lên layout true-shape", async () => {
    let finishNesting!: (value: unknown) => void;
    authenticatedFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => capacityResponse(54, "optimal_auto"),
    });
    nestingJobMocks.wait.mockImplementation(() => new Promise((resolve) => {
      finishNesting = resolve;
    }));
    nestingJobMocks.result.mockResolvedValue(capacityResponse(60, "true_shape_nesting"));

    render(
      <TrueShapeParityPreview
        taskMode="step_repeat"
        targetQuantitiesByPage={{}}
      />,
    );
    await waitFor(() => expect(screen.getByText("1 / 54")).toBeTruthy(), {
      timeout: 3_000,
    });
    await waitFor(() => expect(finishNesting).toBeTypeOf("function"), { timeout: 3_000 });
    await act(async () => {
      finishNesting({
        job_id: "nest-preview",
        status: "completed",
        terminal: true,
        progress: { phase: "completed", progress: 1, elapsedMs: 10 },
        has_result: true,
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByText("1 / 60")).toBeTruthy());
    expect(screen.queryByText("1 / 54")).toBeNull();
    expect(screen.queryByTestId("layout-engine-indicator")).toBeNull();
    expect(document.body.textContent).not.toContain("Kiểu xếp:");
    expect(document.body.textContent).not.toContain("Theo đường bế");
    const capacityRow = screen.getByText("1 / 60").parentElement?.parentElement;
    expect(capacityRow?.textContent).toContain("Sức chứa:");
    expect(capacityRow?.children).toHaveLength(1);
    expect(capacityRow?.querySelector(".w-px")).toBeNull();
  });

  it("B10-7: contour nhiều vòng giữ lỗ rỗng và dùng cùng đường bế ở hai mặt", async () => {
    const outerRing = [
      [pt(10), pt(10)],
      [pt(30), pt(10)],
      [pt(30), pt(30)],
      [pt(10), pt(30)],
    ];
    const innerRing = [
      [pt(16), pt(16)],
      [pt(24), pt(16)],
      [pt(24), pt(24)],
      [pt(16), pt(24)],
    ];
    nestingJobMocks.result.mockResolvedValue({
      ...capacityResponse(1, "true_shape_nesting"),
      cells: [
        {
          ...mixedCell(10, 0),
          diePolylines: [outerRing, innerRing],
        },
      ],
    });

    render(<TrueShapeParityPreview duplexFlow="double" />);

    await waitFor(() => {
      expect(screen.getAllByTestId("true-shape-contour")).toHaveLength(2);
    }, { timeout: 3_000 });
    const contours = screen.getAllByTestId("true-shape-contour");
    expect(contours.map((contour) => contour.getAttribute("data-side"))).toEqual([
      "front",
      "back",
    ]);
    expect(contours[1].getAttribute("d")).toBe(contours[0].getAttribute("d"));
    expect(contours[0].closest("g[transform]")).toBeNull();
    expect(contours[1].closest("g[transform]")?.getAttribute("transform"))
      .toContain("scale(-1, 1)");
    for (const contour of contours) {
      expect(contour.getAttribute("data-ring-count")).toBe("2");
      expect(contour.getAttribute("fill-rule")).toBe("evenodd");
      expect(contour.getAttribute("clip-rule")).toBe("evenodd");
      expect(contour.getAttribute("d")?.match(/\bM\b/g)).toHaveLength(2);
    }
  });

  it("NEST26.2: nối các đoạn CUT legacy và không đóng giả đoạn Bézier hở", async () => {
    const p = (mm: number) => pt(mm);
    const cubic = (x0: number, y0: number, x1: number, y1: number) =>
      Array.from({ length: 11 }, (_unused, index) => {
        const t = index / 10;
        return [p(x0 + (x1 - x0) * t), p(y0 + (y1 - y0) * t)];
      });
    const diePolylines = [
      [[p(10), p(10)], [p(30), p(10)]],
      cubic(30, 10, 30, 30),
      [[p(30), p(30)], [p(10), p(30)]],
      cubic(10, 30, 10, 10),
      cubic(50, 10, 60, 15), // đoạn hở cô lập: chỉ stroke, không Z/fill
    ];
    nestingJobMocks.result.mockResolvedValue({
      ...capacityResponse(1, "true_shape_nesting"),
      cells: [{ ...mixedCell(10, 0), diePolylines }],
    });

    render(<TrueShapeParityPreview />);

    const contour = await waitFor(() => screen.getByTestId("true-shape-contour"), {
      timeout: 3_000,
    });
    expect(contour.getAttribute("data-ring-count")).toBe("1");
    expect(contour.getAttribute("d")?.match(/\bM\b/g)).toHaveLength(1);
    expect(contour.getAttribute("d")?.trimEnd().endsWith("Z")).toBe(true);

    const openContour = screen.getByTestId("true-shape-open-contour");
    expect(openContour.getAttribute("fill")).toBe("none");
    expect(openContour.getAttribute("d")?.includes(" Z")).toBe(false);
  });

  it("NEST26.3: ring true-shape 11 điểm dùng metadata kín, không bị coi là Bézier hở", async () => {
    const p = (mm: number) => pt(mm);
    const ring = Array.from({ length: 11 }, (_unused, index) => {
      const angle = (Math.PI * 2 * index) / 11;
      return [p(20 + Math.cos(angle) * 10), p(20 + Math.sin(angle) * 10)];
    });
    nestingJobMocks.result.mockResolvedValue({
      ...capacityResponse(1, "true_shape_nesting"),
      cells: [{
        ...mixedCell(10, 0),
        diePolylines: [ring],
        diePolylineKinds: ["ring"],
      }],
    });

    render(<TrueShapeParityPreview />);

    const contour = await waitFor(() => screen.getByTestId("true-shape-contour"), {
      timeout: 3_000,
    });
    expect(contour.getAttribute("data-ring-count")).toBe("1");
    expect(contour.getAttribute("d")?.trimEnd().endsWith("Z")).toBe(true);
    expect(screen.queryByTestId("true-shape-open-contour")).toBeNull();
  });

  it("B10-6: quality gate chọn grid thì kết quả muộn không được downgrade provisional", async () => {
    const onDiagnosticEvent = vi.fn();
    let finishNesting!: (value: unknown) => void;
    authenticatedFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => capacityResponse(54, "optimal_auto"),
    });
    nestingJobMocks.wait.mockImplementation(() => new Promise((resolve) => {
      finishNesting = resolve;
    }));
    // Cố tình cho terminal legacy mang số thấp để khóa nguyên tắc không repaint/downgrade;
    // backend thật trả lại cùng baseline 54 sau quality gate.
    nestingJobMocks.result.mockResolvedValue(capacityResponse(43, "optimal_auto"));

    render(
      <TrueShapeParityPreview
        taskMode="step_repeat"
        onDiagnosticEvent={onDiagnosticEvent}
      />,
    );
    await waitFor(() => expect(screen.getByText("1 / 54")).toBeTruthy(), {
      timeout: 3_000,
    });
    await waitFor(() => expect(finishNesting).toBeTypeOf("function"), { timeout: 3_000 });
    await act(async () => {
      finishNesting({
        job_id: "nest-preview",
        status: "completed",
        terminal: true,
        progress: { phase: "completed", progress: 1, elapsedMs: 10 },
        has_result: true,
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(nestingJobMocks.result).toHaveBeenCalledTimes(1));
    expect(screen.getByText("1 / 54")).toBeTruthy();
    expect(screen.queryByText("1 / 43")).toBeNull();
    expect(onDiagnosticEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "applied",
      capacity: 54,
      forceLegacyGrid: true,
    }));
    expect(screen.queryByTestId("layout-engine-indicator")).toBeNull();
    expect(document.body.textContent).not.toContain("Kiểu xếp:");
  });

  it("B10-6: đổi metadata và SL dương giữ preview; đổi hình học vẫn tính lại", async () => {
    const onDiagnosticEvent = vi.fn();
    authenticatedFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => capacityResponse(54, "optimal_auto"),
    });
    nestingJobMocks.result.mockResolvedValue(capacityResponse(43, "optimal_auto"));

    const view = render(
      <TrueShapeParityPreview
        taskMode="step_repeat"
        reportOrderCode="A"
        reportLabelName="TEM A"
        targetQuantitiesByPage={{ 0: 6 }}
        onDiagnosticEvent={onDiagnosticEvent}
      />,
    );
    await waitFor(() => expect(onDiagnosticEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: "applied",
        capacity: 54,
        forceLegacyGrid: true,
      }),
    ), { timeout: 3_000 });
    expect(screen.getByTestId("needed-sheets-count").textContent).toBe("1");

    view.rerender(
      <TrueShapeParityPreview
        taskMode="step_repeat"
        reportOrderCode="B"
        reportLabelName="TEM B"
        reportMaterial="Giấy mới"
        targetQuantitiesByPage={{ 0: 120 }}
        onDiagnosticEvent={onDiagnosticEvent}
      />,
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 850));
    });
    expect(authenticatedFetchMock).toHaveBeenCalledTimes(1);
    expect(nestingJobMocks.create).toHaveBeenCalledTimes(1);
    expect(screen.getByText("1 / 54")).toBeTruthy();
    expect(screen.getByTestId("needed-sheets-count").textContent).toBe("3");

    view.rerender(
      <TrueShapeParityPreview
        taskMode="step_repeat"
        reportOrderCode="B"
        reportLabelName="TEM B"
        reportMaterial="Giấy mới"
        targetQuantitiesByPage={{ 0: 120 }}
        gapX={3}
        onDiagnosticEvent={onDiagnosticEvent}
      />,
    );
    await waitFor(() => expect(nestingJobMocks.create).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });
  });

  it("Bình trang lưới: đổi metadata và SL dương không gọi lại preview", async () => {
    const namedShape = { 0: "RECTANGLE" };
    authenticatedFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => capacityResponse(4, "optimal_auto"),
    });
    const view = render(
      <TrueShapeParityPreview
        taskMode="step_repeat"
        shapesByPage={namedShape}
        reportOrderCode="A"
        reportLabelName="TEM A"
        targetQuantitiesByPage={{ 0: 6 }}
      />,
    );

    await waitFor(() => expect(authenticatedFetchMock).toHaveBeenCalledTimes(1), {
      timeout: 3_000,
    });
    expect(nestingJobMocks.create).not.toHaveBeenCalled();
    expect(screen.getByTestId("needed-sheets-count").textContent).toBe("2");

    view.rerender(
      <TrueShapeParityPreview
        taskMode="step_repeat"
        shapesByPage={namedShape}
        reportOrderCode="B"
        reportLabelName="TEM B"
        reportMaterial="Vật liệu mới"
        targetQuantitiesByPage={{ 0: 12 }}
      />,
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 350));
    });

    expect(authenticatedFetchMock).toHaveBeenCalledTimes(1);
    expect(nestingJobMocks.create).not.toHaveBeenCalled();
    expect(screen.getByTestId("needed-sheets-count").textContent).toBe("3");
  });

  it("Bình trang lưới: đổi tập trang có SL dương vẫn phải tính lại preview", async () => {
    const namedShapes = { 0: "RECTANGLE", 1: "RECTANGLE" };
    const view = render(
      <TrueShapeParityPreview
        taskMode="step_repeat"
        sourceTotalPages={2}
        shapesByPage={namedShapes}
        targetQuantitiesByPage={{ 0: 6, 1: 6 }}
      />,
    );

    await waitFor(() => expect(authenticatedFetchMock).toHaveBeenCalledTimes(1), {
      timeout: 3_000,
    });

    view.rerender(
      <TrueShapeParityPreview
        taskMode="step_repeat"
        sourceTotalPages={2}
        shapesByPage={namedShapes}
        targetQuantitiesByPage={{ 0: 6, 1: 0 }}
      />,
    );

    await waitFor(() => expect(authenticatedFetchMock).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });
  });

  it("N-Up: đổi số lượng vẫn phải tính lại preview", async () => {
    const namedShape = { 0: "RECTANGLE" };
    const view = render(
      <TrueShapeParityPreview
        taskMode="nup"
        shapesByPage={namedShape}
        targetQuantitiesByPage={{ 0: 6 }}
      />,
    );

    await waitFor(() => expect(authenticatedFetchMock).toHaveBeenCalledTimes(1), {
      timeout: 3_000,
    });

    view.rerender(
      <TrueShapeParityPreview
        taskMode="nup"
        shapesByPage={namedShape}
        targetQuantitiesByPage={{ 0: 12 }}
      />,
    );

    await waitFor(() => expect(authenticatedFetchMock).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });
  });

  it("B10-6: provisional về sau terminal cùng generation không được ghi đè", async () => {
    let resolveGrid!: (value: unknown) => void;
    const lateGrid = new Promise((resolve) => {
      resolveGrid = resolve;
    });
    authenticatedFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => lateGrid,
    });
    nestingJobMocks.result.mockResolvedValue(capacityResponse(60, "true_shape_nesting"));

    render(<TrueShapeParityPreview taskMode="step_repeat" />);
    await waitFor(() => expect(screen.getByText("1 / 60")).toBeTruthy(), {
      timeout: 3_000,
    });
    await act(async () => {
      resolveGrid(capacityResponse(54, "optimal_auto"));
      await Promise.resolve();
    });

    expect(screen.getByText("1 / 60")).toBeTruthy();
    expect(screen.queryByText("1 / 54")).toBeNull();
  });

  it("B10-6: Hủy tối ưu nền vẫn giữ provisional hợp lệ", async () => {
    const onCapacityChange = vi.fn();
    const onDiagnosticEvent = vi.fn();
    nestingJobMocks.cancel.mockRejectedValueOnce(new Error("localhost tạm lỗi"));
    authenticatedFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => capacityResponse(54, "optimal_auto"),
    });
    nestingJobMocks.wait.mockImplementation(() => new Promise(() => undefined));

    render(
      <TrueShapeParityPreview
        taskMode="step_repeat"
        onCapacityChange={onCapacityChange}
        onDiagnosticEvent={onDiagnosticEvent}
      />,
    );
    await waitFor(() => expect(screen.getByText("1 / 54")).toBeTruthy(), {
      timeout: 3_000,
    });
    await waitFor(() => expect(nestingJobMocks.create).toHaveBeenCalledTimes(1), {
      timeout: 3_000,
    });

    fireEvent.click(screen.getByRole("button", { name: "Hủy preview" }));
    expect(nestingJobMocks.cancel).toHaveBeenCalledWith(
      "nest-preview",
      expect.any(AbortSignal),
    );
    expect(screen.getByText("1 / 54")).toBeTruthy();
    expect(onCapacityChange).toHaveBeenLastCalledWith(54);
    await act(async () => {
      await Promise.resolve();
    });
    expect(onDiagnosticEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "applied",
      capacity: 54,
      forceLegacyGrid: true,
    }));
    await waitFor(() => expect(nestingJobMocks.cancel).toHaveBeenCalledTimes(2));
    expect(nestingJobMocks.cancel).toHaveBeenLastCalledWith(
      "nest-preview",
      expect.any(AbortSignal),
    );
  });

  it("B10-6: cuộn rồi hủy không cache provisional trang cũ dưới trang mới", async () => {
    const onCapacityChange = vi.fn();
    authenticatedFetchMock.mockReset();
    authenticatedFetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => capacityResponse(54, "optimal_auto"),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => capacityResponse(48, "optimal_auto"),
      });
    nestingJobMocks.wait.mockImplementation(() => new Promise(() => undefined));
    const shapesByPage = { 0: "CUSTOM", 1: "CUSTOM" };
    const shapeParamsByPage = {
      0: { bodyW: pt(20), bodyH: pt(20) },
      1: { bodyW: pt(25), bodyH: pt(20) },
    };
    const targetQuantitiesByPage = { 0: 6, 1: 6 };
    const previewAt = (pageIdx: number) => (
      <TrueShapeParityPreview
        taskMode="step_repeat"
        pageIdx={pageIdx}
        sourceTotalPages={2}
        shapesByPage={shapesByPage}
        shapeParamsByPage={shapeParamsByPage}
        targetQuantitiesByPage={targetQuantitiesByPage}
        itemW={pageIdx === 0 ? 20 : 25}
        onCapacityChange={onCapacityChange}
      />
    );
    const view = render(previewAt(0));

    await waitFor(() => expect(screen.getByText("1 / 54")).toBeTruthy(), {
      timeout: 3_000,
    });
    await waitFor(() => expect(nestingJobMocks.create).toHaveBeenCalledTimes(1));
    view.rerender(previewAt(1));
    expect(authenticatedFetchMock).toHaveBeenCalledTimes(1);
    onCapacityChange.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Hủy preview" }));
    expect(onCapacityChange).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("1 / 48")).toBeTruthy(), {
      timeout: 3_000,
    });
    const secondGridBody = JSON.parse(
      String(authenticatedFetchMock.mock.calls[1]?.[1]?.body),
    );
    expect(secondGridBody.strategy).toBe("optimal_auto");
    expect(secondGridBody.page_idx).toBe(1);
    expect(onCapacityChange).toHaveBeenLastCalledWith(48);
    expect(nestingJobMocks.create).toHaveBeenCalledTimes(1);
  });

  it("B10-6: legacy page probe giữ forceLegacyGrid qua pending và failure", async () => {
    const onDiagnosticEvent = vi.fn();
    let failPagePreview!: (response: unknown) => void;
    authenticatedFetchMock.mockReset();
    authenticatedFetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => capacityResponse(54, "optimal_auto"),
      })
      .mockImplementationOnce(() => new Promise((resolve) => {
        failPagePreview = resolve;
      }));
    nestingJobMocks.result.mockResolvedValue(capacityResponse(43, "optimal_auto"));
    const shapesByPage = { 0: "CUSTOM", 1: "CUSTOM" };
    const shapeParamsByPage = {
      0: { bodyW: pt(20), bodyH: pt(20) },
      1: { bodyW: pt(25), bodyH: pt(20) },
    };
    const previewAt = (pageIdx: number) => (
      <TrueShapeParityPreview
        taskMode="step_repeat"
        pageIdx={pageIdx}
        sourceTotalPages={2}
        shapesByPage={shapesByPage}
        shapeParamsByPage={shapeParamsByPage}
        targetQuantitiesByPage={{ 0: 6, 1: 6 }}
        itemW={pageIdx === 0 ? 20 : 25}
        onDiagnosticEvent={onDiagnosticEvent}
      />
    );
    const view = render(previewAt(0));

    await waitFor(() => expect(onDiagnosticEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "applied", forceLegacyGrid: true }),
    ), { timeout: 3_000 });
    view.rerender(previewAt(1));
    await waitFor(() => expect(onDiagnosticEvent).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "pending", forceLegacyGrid: true }),
    ));
    await waitFor(() => expect(authenticatedFetchMock).toHaveBeenCalledTimes(2));
    // PV26.2: đã chốt lưới thì vẫn có trạng thái chờ, nhưng không tái dùng %
    // hay nút hủy của job nesting đã kết thúc trước đó.
    expect(screen.getByTestId("layout-preview-progress").textContent).not.toContain("%");
    expect(screen.queryByTestId("nesting-preview-progress")).toBeNull();
    expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false);
    expect(screen.queryByRole("button", { name: "Hủy preview" })).toBeNull();
    await act(async () => {
      failPagePreview({ ok: false, status: 500, text: async () => "grid probe failed" });
    });
    await waitFor(() => expect(onDiagnosticEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "failed", forceLegacyGrid: true }),
    ));
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(authenticatedFetchMock).toHaveBeenCalledTimes(2);
    expect(nestingJobMocks.create).toHaveBeenCalledTimes(1);
  });

  it("B10-6: request hủy treo vẫn timeout, retry hữu hạn và nhả trạng thái UI", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    authenticatedFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => capacityResponse(54, "optimal_auto"),
    });
    nestingJobMocks.wait.mockImplementation(() => new Promise(() => undefined));
    nestingJobMocks.cancel.mockImplementation((_jobId: string, signal?: AbortSignal) => (
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("Đã hết hạn hủy.", "AbortError"));
        }, { once: true });
      })
    ));

    render(<TrueShapeParityPreview taskMode="step_repeat" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    expect(screen.getByText("1 / 54")).toBeTruthy();
    expect(nestingJobMocks.create).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Hủy preview" }));
    expect(screen.getByTestId("nesting-preview-progress")).toBeTruthy();
    await act(async () => {
      // 3 × timeout 2.000 ms + 2 × khoảng retry 120 ms.
      await vi.advanceTimersByTimeAsync(6_240);
    });

    expect(nestingJobMocks.cancel).toHaveBeenCalledTimes(3);
    for (const call of nestingJobMocks.cancel.mock.calls) {
      expect(call[1]).toBeInstanceOf(AbortSignal);
      expect((call[1] as AbortSignal).aborted).toBe(true);
    }
    expect(screen.queryByTestId("nesting-preview-progress")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("B10-6: nesting lỗi không chờ vô hạn một provisional đang treo", async () => {
    const onDiagnosticEvent = vi.fn();
    authenticatedFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => new Promise(() => undefined),
    });
    nestingJobMocks.wait.mockResolvedValueOnce({
      job_id: "nest-preview",
      status: "failed",
      terminal: true,
      cancel_requested: false,
      created_at: 1,
      started_at: 1,
      completed_at: 2,
      progress: { phase: "failed", progress: 0.3, elapsedMs: 20 },
      error_code: "NESTING_FAILED",
      message: "solver failed",
      has_result: false,
    });

    render(
      <TrueShapeParityPreview
        taskMode="step_repeat"
        onDiagnosticEvent={onDiagnosticEvent}
      />,
    );

    await waitFor(() => {
      expect(onDiagnosticEvent).toHaveBeenLastCalledWith(expect.objectContaining({
        phase: "failed",
      }));
    }, { timeout: 3_000 });
    expect(screen.queryByTestId("nesting-preview-progress")).toBeNull();
    expect(document.body.textContent).toContain("solver failed");
  });

  it("B10-6: Hủy trước 202 đóng diagnostic và hủy job ngay khi job_id về muộn", async () => {
    const onDiagnosticEvent = vi.fn();
    let acceptJob!: (value: { job_id: string; status: string }) => void;
    authenticatedFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => new Promise(() => undefined),
    });
    nestingJobMocks.create.mockImplementationOnce(() => new Promise((resolve) => {
      acceptJob = resolve;
    }));

    render(
      <TrueShapeParityPreview
        taskMode="step_repeat"
        onDiagnosticEvent={onDiagnosticEvent}
      />,
    );
    await waitFor(() => expect(nestingJobMocks.create).toHaveBeenCalledTimes(1), {
      timeout: 3_000,
    });

    expect(screen.getByTestId("nesting-preview-progress").textContent).not.toContain("%");
    expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Hủy preview" }));
    expect(onDiagnosticEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "aborted",
    }));

    await act(async () => {
      acceptJob({ job_id: "late-job", status: "queued" });
      await Promise.resolve();
    });
    await waitFor(() => expect(nestingJobMocks.cancel).toHaveBeenCalledWith(
      "late-job",
      expect.any(AbortSignal),
    ));
    expect(onDiagnosticEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "aborted",
    }));
  });

  it.each([undefined, "cnc"])("PV26.2: nhánh lưới có trạng thái chờ không giả phần trăm (%s)", async (imposerMode) => {
    let finishPreview!: (response: unknown) => void;
    authenticatedFetchMock.mockImplementationOnce(() => new Promise((resolve) => {
      finishPreview = resolve;
    }));

    render(
      <TrueShapeParityPreview
        taskMode="step_repeat"
        imposerMode={imposerMode}
        shapesByPage={{ 0: "PENTAGON" }}
      />,
    );

    const indicator = screen.getByTestId("layout-preview-progress");
    expect(indicator.textContent).toContain("Đang tính toán bố cục");
    expect(indicator.textContent).not.toContain("%");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false);
    expect(screen.queryByTestId("nesting-preview-progress")).toBeNull();
    expect(screen.queryByRole("button", { name: "Hủy preview" })).toBeNull();

    await waitFor(() => expect(authenticatedFetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      finishPreview({ ok: true, status: 200, json: async () => capacityResponse(32, "optimal_auto") });
    });
    await waitFor(() => expect(screen.queryByTestId("layout-preview-progress")).toBeNull());
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(nestingJobMocks.create).not.toHaveBeenCalled();
  });

  it("PV26.2: tab nền không giữ trạng thái chờ hoặc nhận kết quả lưới muộn", async () => {
    const onCapacityChange = vi.fn();
    let finishPreview!: (response: unknown) => void;
    authenticatedFetchMock.mockImplementationOnce(() => new Promise((resolve) => {
      finishPreview = resolve;
    }));
    const preview = (isActive: boolean) => (
      <TrueShapeParityPreview
        taskMode="step_repeat"
        imposerMode="cnc"
        shapesByPage={{ 0: "PENTAGON" }}
        isActive={isActive}
        onCapacityChange={onCapacityChange}
      />
    );

    const view = render(preview(false));
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(authenticatedFetchMock).not.toHaveBeenCalled();
    view.rerender(preview(true));
    expect(screen.getByTestId("layout-preview-progress")).toBeTruthy();
    await waitFor(() => expect(authenticatedFetchMock).toHaveBeenCalledTimes(1));

    view.rerender(preview(false));
    expect(screen.queryByRole("progressbar")).toBeNull();
    await act(async () => {
      finishPreview({ ok: true, status: 200, json: async () => capacityResponse(32, "optimal_auto") });
    });
    expect(onCapacityChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId("layout-preview-progress")).toBeNull();
  });

  it("PV26.2: nhận mã job chưa đồng nghĩa đã biết phần trăm", async () => {
    type Progress = { phase: string; progress: number; elapsedMs: number };
    let publishStatus!: (progress?: Progress) => void;
    nestingJobMocks.wait.mockImplementation((_jobId, options) => {
      publishStatus = (progress) => options.onStatus({
        job_id: "nest-preview",
        status: "running",
        terminal: false,
        progress,
        has_result: false,
      });
      return new Promise(() => undefined);
    });

    render(<TrueShapeParityPreview imposerMode="cnc" />);
    await waitFor(() => expect(nestingJobMocks.wait).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("nesting-preview-progress").textContent).not.toContain("%");
    expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false);

    act(() => publishStatus());
    expect(screen.getByTestId("nesting-preview-progress").textContent).not.toContain("%");
    act(() => publishStatus({ phase: "baseline", progress: 0, elapsedMs: 10 }));
    expect(screen.getByText("0%")).toBeTruthy();
    act(() => publishStatus({ phase: "baseline", progress: 0.42, elapsedMs: 30 }));
    expect(screen.getByText("42%")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("42");
  });

  it.each([undefined, "cnc"])("PV26.2: hiển thị phase/progress thật của job cho Tem/CNC (%s)", async (imposerMode) => {
    nestingJobMocks.wait.mockImplementation(async (_jobId, options) => {
      options.onStatus({
        job_id: "nest-preview",
        status: "running",
        terminal: false,
        cancel_requested: false,
        created_at: 1,
        started_at: 1,
        completed_at: null,
        progress: { phase: "baseline", progress: 0.42, elapsedMs: 30 },
        error_code: null,
        message: null,
        has_result: false,
      });
      return new Promise(() => undefined);
    });

    render(<TrueShapeParityPreview imposerMode={imposerMode} />);

    await waitFor(() => {
      expect(screen.getByTestId("nesting-preview-progress").getAttribute("data-phase"))
        .toBe("baseline");
      expect(screen.getByText("42%")).toBeTruthy();
    }, { timeout: 3_000 });
    expect(screen.getByTestId("nesting-preview-progress-bar").getAttribute("style"))
      .toContain("42%");
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
    const progressbar = screen.getByRole("progressbar");
    expect(progressbar.getAttribute("aria-valuemin")).toBe("0");
    expect(progressbar.getAttribute("aria-valuemax")).toBe("100");
    expect(progressbar.getAttribute("aria-valuenow")).toBe("42");
  });

  it("§B10-4: kết quả nesting nhiều tờ (S&R mỗi mẫu một tờ) hiện pager và lật được", async () => {
    // Mỗi mẫu một tờ ⇒ result nesting mang sheets[]; frontend phải hiện thanh ◄ / ►.
    const cellAt = (pageIdx: number, x: number) => ({
      x,
      y: 0,
      absX: x,
      absY: 0,
      width: 20 * MM_TO_PT,
      height: 20 * MM_TO_PT,
      isRotated: false,
      isRotated180: false,
      blockId: 0,
      pageIdx,
      diePolylines: [
        [
          [x, 0],
          [x + 20 * MM_TO_PT, 0],
          [x + 20 * MM_TO_PT, 20 * MM_TO_PT],
          [x, 20 * MM_TO_PT],
        ],
      ],
    });
    const mkSheet = (pageIdx: number, count: number) => ({
      cells: Array.from({ length: count }, (_unused, i) =>
        cellAt(pageIdx, 10 + i * 25 * MM_TO_PT),
      ),
      overallWidth: 320 * MM_TO_PT,
      overallHeight: 430 * MM_TO_PT,
      totalItems: count,
      physicalSheetIndex: pageIdx,
      runCount: 1,
    });
    const sheets = [mkSheet(0, 2), mkSheet(1, 1)];
    nestingJobMocks.result.mockResolvedValue({
      success: true,
      totalItems: 2,
      overallWidth: 320 * MM_TO_PT,
      overallHeight: 430 * MM_TO_PT,
      strategyUsed: "true_shape_nesting",
      cells: sheets[0].cells,
      absPlacement: true,
      isMixedPreview: false,
      sheetsNeeded: 2,
      coordinateSpace: "sheet_abs_pt",
      sheets,
    });

    render(<TrueShapeParityPreview />);

    // Nhiều tờ ⇒ thanh chuyển tờ xuất hiện (chỉ render khi sheets.length > 1).
    const nextButton = await waitFor(
      () => screen.getByRole("button", { name: "►" }),
      { timeout: 3_000 },
    );
    expect(screen.getByRole("button", { name: "◄" })).toBeTruthy();
    // Lật sang tờ mẫu kế tiếp không crash; pager vẫn còn.
    fireEvent.click(nextButton);
    expect(screen.getByRole("button", { name: "►" })).toBeTruthy();
  });

  it("B10-6: true-shape 13 trang chỉ solve một lượt và cuộn chỉ chọn sheet đã có", async () => {
    const pageIndices = Array.from({ length: 13 }, (_unused, index) => index);
    const shapesByPage: Record<number, string> = Object.fromEntries(
      pageIndices.map((index) => [index, "CUSTOM"]),
    );
    const shapeParamsByPage: Record<number, Record<string, unknown>> = Object.fromEntries(
      pageIndices.map((index) => [index, { bodyW: pt(20 + index), bodyH: pt(20) }]),
    );
    const targetQuantitiesByPage: Record<number, number> = Object.fromEntries(
      pageIndices.map((index) => [index, 6]),
    );
    nestingJobMocks.result.mockResolvedValue(stepRepeatSheetsResponse(pageIndices));

    const previewAt = (pageIdx: number) => (
      <TrueShapeParityPreview
        taskMode="step_repeat"
        pageIdx={pageIdx}
        sourceTotalPages={13}
        shapesByPage={shapesByPage}
        shapeParamsByPage={shapeParamsByPage}
        targetQuantitiesByPage={targetQuantitiesByPage}
        itemW={20 + pageIdx}
        itemH={20}
      />
    );
    const view = render(previewAt(0));

    await waitFor(() => expect(screen.getByText(/1 \/ 13/)).toBeTruthy(), {
      timeout: 3_000,
    });
    expect(nestingJobMocks.create).toHaveBeenCalledTimes(1);
    expect(nestingJobMocks.result).toHaveBeenCalledTimes(1);
    expect(authenticatedFetchMock).toHaveBeenCalledTimes(1);

    // Pager tay không bị effect kéo lại nếu viewer vẫn ở cùng trang.
    fireEvent.click(screen.getByRole("button", { name: "►" }));
    await waitFor(() => expect(screen.getByText(/2 \/ 13/)).toBeTruthy());
    view.rerender(previewAt(0));
    await waitFor(() => expect(screen.getByText(/2 \/ 13/)).toBeTruthy());

    // Cuộn viewer tới trang 13 phải chọn sheet chứa cell.pageIdx=12 tại chỗ.
    view.rerender(previewAt(12));
    await waitFor(() => expect(screen.getByText(/13 \/ 13/)).toBeTruthy());
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 850));
    });
    expect(nestingJobMocks.create).toHaveBeenCalledTimes(1);
    expect(nestingJobMocks.result).toHaveBeenCalledTimes(1);
    expect(authenticatedFetchMock).toHaveBeenCalledTimes(1);
  });

  it("B10-6: map sheet theo cell.pageIdx, bỏ qua trang SL=0 và không dùng ordinal", async () => {
    const shapesByPage = { 0: "CUSTOM", 1: "CUSTOM", 2: "CUSTOM" };
    const shapeParamsByPage = {
      0: { bodyW: pt(20), bodyH: pt(20) },
      1: { bodyW: pt(21), bodyH: pt(20) },
      2: { bodyW: pt(22), bodyH: pt(20) },
    };
    const targetQuantitiesByPage = { 0: 6, 1: 0, 2: 3 };
    nestingJobMocks.result.mockResolvedValue(stepRepeatSheetsResponse([0, 2]));
    const previewAt = (pageIdx: number) => (
      <TrueShapeParityPreview
        taskMode="step_repeat"
        pageIdx={pageIdx}
        sourceTotalPages={3}
        shapesByPage={shapesByPage}
        shapeParamsByPage={shapeParamsByPage}
        targetQuantitiesByPage={targetQuantitiesByPage}
        itemW={20 + pageIdx}
      />
    );
    const { container, rerender } = render(previewAt(0));

    await waitFor(() => expect(screen.getByText(/1 \/ 2/)).toBeTruthy(), {
      timeout: 3_000,
    });
    rerender(previewAt(2));
    await waitFor(() => {
      expect(screen.getByText(/2 \/ 2/)).toBeTruthy();
      expect(container.querySelector(
        'rect[fill="rgba(245, 158, 11, 0.20)"]',
      )).not.toBeNull();
    });

    // Trang 2 (pageIdx=1) không có representative sheet: giữ nguyên sheet trang 3.
    rerender(previewAt(1));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(/2 \/ 2/)).toBeTruthy();
    expect(container.querySelector(
      'rect[fill="rgba(245, 158, 11, 0.20)"]',
    )).not.toBeNull();
    expect(nestingJobMocks.create).toHaveBeenCalledTimes(1);
    expect(authenticatedFetchMock).toHaveBeenCalledTimes(1);
  });

  it("B10-6: quality gate legacy chỉ probe grid trang mới, không tạo lại nesting job", async () => {
    const onDiagnosticEvent = vi.fn();
    authenticatedFetchMock.mockReset();
    authenticatedFetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => capacityResponse(54, "optimal_auto"),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => capacityResponse(48, "optimal_auto"),
      });
    nestingJobMocks.result.mockResolvedValue(capacityResponse(43, "optimal_auto"));
    const shapesByPage = { 0: "CUSTOM", 1: "CUSTOM" };
    const shapeParamsByPage = {
      0: { bodyW: pt(20), bodyH: pt(20) },
      1: { bodyW: pt(25), bodyH: pt(20) },
    };
    const previewAt = (pageIdx: number) => (
      <TrueShapeParityPreview
        taskMode="step_repeat"
        pageIdx={pageIdx}
        sourceTotalPages={2}
        shapesByPage={shapesByPage}
        shapeParamsByPage={shapeParamsByPage}
        targetQuantitiesByPage={{ 0: 6, 1: 6 }}
        itemW={pageIdx === 0 ? 20 : 25}
        onDiagnosticEvent={onDiagnosticEvent}
      />
    );
    const view = render(previewAt(0));

    await waitFor(() => expect(screen.getByText("1 / 54")).toBeTruthy(), {
      timeout: 3_000,
    });
    await waitFor(() => expect(onDiagnosticEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "applied", forceLegacyGrid: true }),
    ));
    expect(nestingJobMocks.result).toHaveBeenCalledTimes(1);
    expect(nestingJobMocks.create).toHaveBeenCalledTimes(1);

    view.rerender(previewAt(1));
    await waitFor(() => expect(screen.getByText("1 / 48")).toBeTruthy(), {
      timeout: 3_000,
    });
    const secondGridBody = JSON.parse(
      String(authenticatedFetchMock.mock.calls[1]?.[1]?.body),
    );
    expect(secondGridBody.strategy).toBe("optimal_auto");
    expect(secondGridBody.page_idx).toBe(1);

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 850));
    });
    expect(authenticatedFetchMock).toHaveBeenCalledTimes(2);
    expect(nestingJobMocks.create).toHaveBeenCalledTimes(1);
    expect(nestingJobMocks.result).toHaveBeenCalledTimes(1);
  });

  it("B10-6: hình named per-page vẫn refetch grid khi viewer đổi trang", async () => {
    authenticatedFetchMock.mockReset();
    authenticatedFetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => capacityResponse(12, "optimal_auto"),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => capacityResponse(8, "optimal_auto"),
      });
    const shapesByPage = { 0: "RECTANGLE", 1: "RECTANGLE" };
    const shapeParamsByPage = {
      0: { bodyW: pt(20), bodyH: pt(20) },
      1: { bodyW: pt(30), bodyH: pt(20) },
    };
    const previewAt = (pageIdx: number) => (
      <TrueShapeParityPreview
        taskMode="step_repeat"
        pageIdx={pageIdx}
        sourceTotalPages={2}
        shapesByPage={shapesByPage}
        shapeParamsByPage={shapeParamsByPage}
        targetQuantitiesByPage={{ 0: 6, 1: 6 }}
        itemW={pageIdx === 0 ? 20 : 30}
      />
    );
    const view = render(previewAt(0));

    await waitFor(() => expect(authenticatedFetchMock).toHaveBeenCalledTimes(1), {
      timeout: 3_000,
    });
    expect(nestingJobMocks.create).not.toHaveBeenCalled();
    view.rerender(previewAt(1));
    await waitFor(() => expect(authenticatedFetchMock).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });
    const secondBody = JSON.parse(String(authenticatedFetchMock.mock.calls[1]?.[1]?.body));
    expect(secondBody.page_idx).toBe(1);
    expect(nestingJobMocks.create).not.toHaveBeenCalled();
  });

  it("nguồn PDF trả chậm sau supersede không được tạo job stale", async () => {
    let resolveOldSource!: (file: File) => void;
    const oldSource = new Promise<File>((resolve) => { resolveOldSource = resolve; });
    const fileAt = (path: string): File => {
      const file = new File([new Uint8Array(128)], "source.pdf", { type: "application/pdf" });
      Object.defineProperty(file, "path", { value: path });
      return file;
    };
    const getWorkingFile = vi.fn()
      .mockImplementationOnce(() => oldSource)
      .mockResolvedValue(fileAt("C:\\new-source.pdf"));

    const { rerender } = render(
      <TrueShapeParityPreview
        previewSourceKey="source-old"
        getWorkingFile={getWorkingFile}
      />,
    );
    await waitFor(() => expect(getWorkingFile).toHaveBeenCalledTimes(1), { timeout: 3_000 });

    rerender(
      <TrueShapeParityPreview
        reportOrderCode="DH-NEW"
        previewSourceKey="source-new"
        getWorkingFile={getWorkingFile}
      />,
    );
    resolveOldSource(fileAt("C:\\old-source.pdf"));

    await waitFor(() => expect(nestingJobMocks.create).toHaveBeenCalledTimes(1), {
      timeout: 3_000,
    });
    expect(nestingJobMocks.create.mock.calls[0][0]).toMatchObject({
      path: "C:\\new-source.pdf",
      report_order_code: "DH-NEW",
    });
  });

  it("supersede hủy job cũ và kết quả cũ không ghi đè", async () => {
    const waits = new Map<string, { resolve: (value: unknown) => void; onStatus: (value: unknown) => unknown }>();
    nestingJobMocks.create
      .mockResolvedValueOnce({ job_id: "old-job", status: "queued" })
      .mockResolvedValueOnce({ job_id: "new-job", status: "queued" });
    nestingJobMocks.wait.mockImplementation((jobId, options) => new Promise((resolve) => {
      waits.set(jobId, { resolve, onStatus: options.onStatus });
    }));
    nestingJobMocks.result.mockImplementation(async (jobId) => ({
      ...mixedResponse(),
      sheets: undefined,
      totalItems: jobId === "new-job" ? 45 : 7,
    }));

    const { rerender } = render(
      <TrueShapeParityPreview
        shapeParamsByPage={{ 0: { bodyW: pt(20), bodyH: pt(20) } }}
      />,
    );
    await waitFor(() => expect(waits.has("old-job")).toBe(true), { timeout: 3_000 });
    rerender(
      <TrueShapeParityPreview
        shapeParamsByPage={{ 0: { bodyW: pt(21), bodyH: pt(20) } }}
      />,
    );
    await waitFor(() => expect(waits.has("new-job")).toBe(true), { timeout: 3_000 });
    expect(nestingJobMocks.cancel).toHaveBeenCalledWith(
      "old-job",
      expect.any(AbortSignal),
    );

    waits.get("new-job")?.resolve({
      job_id: "new-job", status: "completed", terminal: true,
      progress: { phase: "completed", progress: 1, elapsedMs: 10 }, has_result: true,
    });

    await waitFor(() => expect(screen.getByText("1 / 45")).toBeTruthy());
    // Kết quả cũ cố tình về SAU kết quả mới: generation fence phải giữ nguyên 45.
    waits.get("old-job")?.resolve({
      job_id: "old-job", status: "completed", terminal: true,
      progress: { phase: "completed", progress: 1, elapsedMs: 10 }, has_result: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText("1 / 45")).toBeTruthy();
    expect(screen.queryByText("1 / 7")).toBeNull();
    expect(nestingJobMocks.result).toHaveBeenCalledWith("new-job", expect.any(AbortSignal));
    expect(nestingJobMocks.result).not.toHaveBeenCalledWith("old-job", expect.anything());
  });

  it("nút Hủy xóa preview/cache/capacity cũ và result tới trễ không được áp", async () => {
    const onCapacityChange = vi.fn();
    const { rerender } = render(
      <TrueShapeParityPreview onCapacityChange={onCapacityChange} />,
    );
    await waitFor(() => expect(onCapacityChange).toHaveBeenLastCalledWith(1), {
      timeout: 3_000,
    });
    expect(document.body.textContent).toContain("Sức chứa:");
    nestingJobMocks.result.mockClear();

    let finish!: (value: unknown) => void;
    nestingJobMocks.create.mockResolvedValueOnce({ job_id: "cancel-job", status: "queued" });
    nestingJobMocks.wait.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    rerender(
      <TrueShapeParityPreview
        previewSourceKey="cancel-layout"
        onCapacityChange={onCapacityChange}
      />,
    );
    await waitFor(() => expect(nestingJobMocks.wait).toHaveBeenCalledWith(
      "cancel-job",
      expect.any(Object),
    ), {
      timeout: 3_000,
    });

    fireEvent.click(screen.getByRole("button", { name: "Hủy preview" }));
    expect(nestingJobMocks.cancel).toHaveBeenCalledWith(
      "cancel-job",
      expect.any(AbortSignal),
    );
    expect(document.body.textContent).not.toContain("Sức chứa:");
    expect(onCapacityChange).toHaveBeenLastCalledWith(0);
    await act(async () => {
      finish({
        job_id: "cancel-job", status: "completed", terminal: true,
        progress: { phase: "completed", progress: 1, elapsedMs: 10 }, has_result: true,
      });
      await Promise.resolve();
    });
    expect(nestingJobMocks.result).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Sức chứa:");
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

  it("OCG explicit dừng preview identity khi PDF làm việc không materialize được", async () => {
    // PARITY (audit 2026-08-29 §MAP-NEST-10): explicit show-all vẫn phải bake `/D`;
    // cấm rơi về filePath gốc dù thứ tự và góc xoay trang hoàn toàn identity.
    const getWorkingFile = vi.fn().mockRejectedValue(new Error("forced OCG bake failure"));

    render(
      <StrictWorkingSourcePreview
        previewSourceKey={JSON.stringify({
          o: [1, 2],
          r: [0, 0],
          ocg: "explicit:",
        })}
        getWorkingFile={getWorkingFile}
        requiresWorkingSource
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Không thể tạo PDF làm việc/)).toBeTruthy();
    }, { timeout: 3_000 });
    expect(getWorkingFile).toHaveBeenCalledTimes(1);
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

  // §B10: CUSTOM nay auto-route sang nesting (không còn đi lưới), nên bỏ khỏi danh sách này
  // và thay bằng HEXAGON — vẫn là hình CÓ TÊN không-chữ-nhật đi lưới, phải ép Inking = none.
  it.each(['CIRCLE_ELLIPSE', 'HEXAGON'])('ép Inking về none cho tem bế %s', async (shapeType) => {
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
