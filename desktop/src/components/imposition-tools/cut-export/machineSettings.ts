// machineSettings.ts — Cấu hình KẾT NỐI máy bế theo TỪNG MÁY (profile), lưu localStorage.
//
// Kết nối (kênh/IP/cổng/thư mục/định dạng) là thuộc tính của MÁY, cấu hình một lần
// trong Preferences → "Máy bế". Modal "Gửi Máy Bế" chỉ cần chọn máy là tự nạp kết nối.

export type CutChannel = "file" | "tcp";
export type CutEmitter = "command_stream" | "dxf" | "svg" | "pdf";

export interface MachineConn {
  channel: CutChannel;
  emitter: CutEmitter;
  tcpHost?: string;
  tcpPort?: number;
  destDir?: string;
}

const LS_KEY = "prynx.cutMachines.v1";

export const DEFAULT_CONN: MachineConn = {
  channel: "file",
  emitter: "command_stream",
  tcpHost: "",
  tcpPort: 9100,
  destDir: "",
};

export function loadAllMachineConns(): Record<string, MachineConn> {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}") as Record<string, MachineConn>;
  } catch {
    return {};
  }
}

export function getMachineConn(profileId: string): MachineConn | undefined {
  if (!profileId) return undefined;
  const all = loadAllMachineConns();
  return all[profileId];
}

export function saveMachineConn(profileId: string, conn: MachineConn) {
  if (!profileId) return;
  const all = loadAllMachineConns();
  all[profileId] = conn;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}
