// @vitest-environment jsdom

import React from "react";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import GridPreview from "./GridPreview";
import { DEFAULT_PONT_CONFIG } from "../pontConfigDefaults";

const authenticatedFetchMock = vi.fn();

vi.mock("../../../lib/api", () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetchMock(...args),
  getApiUrl: () => "http://127.0.0.1:8321/api",
  uploadPDF: vi.fn(),
}));

vi.mock("../../../lib/previewPerfLog", () => ({
  previewPerfLog: vi.fn(),
}));

vi.mock("../../../lib/mixed-nesting/api", () => ({
  createNestingPreviewJob: vi.fn(),
  getNestingPreviewJobStatus: vi.fn(),
  getNestingPreviewJobResult: vi.fn(),
  cancelNestingPreviewJob: vi.fn(),
  waitForNestingPreviewJob: vi.fn(),
}));

const mockLayoutResponse = {
  success: true,
  strategyUsed: "simple_auto",
  totalItems: 1,
  overallWidth: 100,
  overallHeight: 100,
  cells: [
    {
      x: 20,
      y: 20,
      width: 50,
      height: 50,
      isRotated: false,
      isRotated180: false,
      blockId: 0,
      pageIdx: 0,
    },
  ],
};

describe("GridPreview pont marks (ốc bế) rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticatedFetchMock.mockResolvedValue({
      ok: true,
      json: async () => mockLayoutResponse,
    });
  });

  it("không hiển thị ốc bế khi pontType='none'", async () => {
    const { container } = render(
      <GridPreview
        taskMode="nup"
        isDieCut
        layoutType="sequential"
        gridStrategy="simple_auto"
        columns={1}
        rows={1}
        gapX={2}
        gapY={2}
        sheetWidth={320}
        sheetHeight={450}
        marginTop={10}
        marginBottom={10}
        marginLeft={10}
        marginRight={10}
        align="center"
        shapeType="RECTANGLE"
        itemW={50}
        itemH={50}
        filePath="C:\\test.pdf"
        pontType="none"
      />
    );

    await waitFor(() => expect(authenticatedFetchMock).toHaveBeenCalled());
    const pontGroup = container.querySelector("#preview-pont-marks");
    expect(pontGroup).toBeNull();
  });

  it("hiển thị đúng 4 chấm tròn đặc khi pontType='5mm' hoặc shape='circle'", async () => {
    const { container } = render(
      <GridPreview
        taskMode="nup"
        isDieCut
        layoutType="sequential"
        gridStrategy="simple_auto"
        columns={1}
        rows={1}
        gapX={2}
        gapY={2}
        sheetWidth={320}
        sheetHeight={450}
        marginTop={10}
        marginBottom={10}
        marginLeft={10}
        marginRight={10}
        align="center"
        shapeType="RECTANGLE"
        itemW={50}
        itemH={50}
        filePath="C:\\test.pdf"
        pontType="5mm"
        pontConfig={{
          ...DEFAULT_PONT_CONFIG,
          shape: "circle",
          size: 5.0,
          marginLeft: 7,
          marginRight: 7,
          marginTop: 7,
          marginBottom: 7,
        }}
      />
    );

    await waitFor(() => expect(authenticatedFetchMock).toHaveBeenCalled());
    const pontGroup = container.querySelector("#preview-pont-marks");
    expect(pontGroup).not.toBeNull();

    const circles = pontGroup?.querySelectorAll("circle");
    expect(circles?.length).toBe(4);
  });

  it("hiển thị đúng 4 polyline L-corner khi pontType='corner'", async () => {
    const { container } = render(
      <GridPreview
        taskMode="nup"
        isDieCut
        layoutType="sequential"
        gridStrategy="simple_auto"
        columns={1}
        rows={1}
        gapX={2}
        gapY={2}
        sheetWidth={320}
        sheetHeight={450}
        marginTop={10}
        marginBottom={10}
        marginLeft={10}
        marginRight={10}
        align="center"
        shapeType="RECTANGLE"
        itemW={50}
        itemH={50}
        filePath="C:\\test.pdf"
        pontType="corner"
        pontConfig={{
          ...DEFAULT_PONT_CONFIG,
          shape: "l_corner",
          size: 5.0,
        }}
      />
    );

    await waitFor(() => expect(authenticatedFetchMock).toHaveBeenCalled());
    const pontGroup = container.querySelector("#preview-pont-marks");
    expect(pontGroup).not.toBeNull();

    const polylines = pontGroup?.querySelectorAll("polyline");
    expect(polylines?.length).toBe(4);
  });

  it("hiển thị thanh canh giấy (paper guides) khi guide1Enabled hoặc guide2Enabled = true", async () => {
    const { container } = render(
      <GridPreview
        taskMode="nup"
        isDieCut
        layoutType="sequential"
        gridStrategy="simple_auto"
        columns={1}
        rows={1}
        gapX={2}
        gapY={2}
        sheetWidth={320}
        sheetHeight={450}
        marginTop={10}
        marginBottom={10}
        marginLeft={10}
        marginRight={10}
        align="center"
        shapeType="RECTANGLE"
        itemW={50}
        itemH={50}
        filePath="C:\\test.pdf"
        pontType="custom"
        pontConfig={{
          ...DEFAULT_PONT_CONFIG,
          shape: "circle",
          guide1Enabled: true,
          guide1Pos: "BL",
          guide1Length: 25,
          guide2Enabled: true,
          guide2Pos: "BR",
          guide2Length: 25,
        }}
      />
    );

    await waitFor(() => expect(authenticatedFetchMock).toHaveBeenCalled());
    const pontGroup = container.querySelector("#preview-pont-marks");
    expect(pontGroup).not.toBeNull();

    const lines = pontGroup?.querySelectorAll("line");
    expect(lines?.length).toBe(2);
  });
});
