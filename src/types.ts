export type Button =
  | "up" | "down" | "left" | "right"
  | "a"  | "b"
  | "x"  | "y"
  | "l"  | "r"
  | "start" | "select";

// Host → Worker messages
export type WorkerInMessage =
  | { type: "init"; offscreen: OffscreenCanvas; audioSAB: SharedArrayBuffer }
  | { type: "loadRom"; bytes: Uint8Array; filename: string }
  | { type: "tick" }
  | { type: "button"; port: string; btn: string; pressed: boolean }
  | { type: "peerState"; peerId: string; bytes: Uint8Array }
  | { type: "peerLeave"; peerId: string }
  | { type: "stateSave" }
  | { type: "stateLoad"; bytes: Uint8Array }
  | { type: "ramWatch"; addrs: { addr: number; label: string; size: number }[] };

// Worker → Host messages
export type WorkerOutMessage =
  | { type: "ready" }
  | { type: "loaded"; ok: boolean; sha?: string; adapterId?: string; roomGroup?: string; stateBytes?: number; error?: string }
  | { type: "ownState"; bytes: Uint8Array; framesSince: number }
  | { type: "fps"; fps: number }
  | { type: "stateSaved"; bytes: Uint8Array | null }
  | { type: "stateLoaded"; ok: boolean }
  | { type: "ramWatch"; values: { label: string; value: number }[] }
  | { type: "log"; msg: string };

export interface MemAccess {
  readU8(addr: number): number;
  readU16(addr: number): number;
  readU32(addr: number): number;
  readBytes(addr: number, len: number): Uint8Array;
  writeBytes(addr: number, bytes: Uint8Array): void;

  romPtr(): number; romSize(): number;
  ramPtr(): number; ramSize(): number;

  setExtraObj(
    slot: number,
    hpos: number, vpos: number,
    tile: number, palette: number, priority: number,
    hflip: boolean, vflip: boolean,
    width: number, height: number,
  ): void;
  writeExtrasTile(vramAddr: number, bytes: Uint8Array): void;
  writeExtrasPalette(cgramIdx: number, bgr555: number): void;
  clearExtras(): void;
}

export interface Adapter {
  readonly sha8: string;
  readonly roomGroup: string;
  readonly stateBytes: number;
  readonly settleFrames?: number;
  readonly skipReload?: boolean;

  install(mem: MemAccess): void | Promise<void>;
  extract(mem: MemAccess): Uint8Array | null;
  applyPeer(peerId: string, bytes: Uint8Array, mem: MemAccess): void;
  removePeer(peerId: string, mem: MemAccess): void;
  renderPeers(mem: MemAccess): void;
  encodePacket?(fullState: Uint8Array, prevFullState: Uint8Array | null, keyframe: boolean): Uint8Array;
  getMapKey?(fullState: Uint8Array): number;
}

export type AdapterFactory = () => Adapter;
