import type { Adapter, MemAccess } from "../types";
import { lookup } from "../registry";

export { register } from "../registry";

type Cwrap = (name: string, ret: string | null, args: string[]) => (...a: number[]) => any;

interface MGBAModule {
  HEAPU8: Uint8Array;
  cwrap: Cwrap;
  FS: any;
  FSInit(): Promise<void>;
  filePaths(): { gamePath: string; saveStatePath: string };
  loadGame(path: string): boolean;
  quickReload(): void;
  pauseGame(): void;
  resumeGame(): void;
  setVolume(v: number): void;
  getVolume(): number;
  buttonPress(key: string): void;
  buttonUnpress(key: string): void;
  saveState(slot: number): boolean;
  loadState(slot: number): boolean;
  addCoreCallbacks(cbs: { videoFrameEndedCallback?: () => void }): void;
  toggleInput?(on: boolean): void;
  setFastForwardMultiplier?(n: number): void;
}

const KEY: Record<string, string> = {
  a: "A", b: "B", l: "L", r: "R", select: "Select", start: "Start",
  right: "Right", left: "Left", up: "Up", down: "Down", x: "", y: "",
};

const post = (self as unknown as {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
}).postMessage.bind(self);

let Mod: MGBAModule | null = null;
let adapter: Adapter | null = null;
let loaded = false;
let lastOwnState: Uint8Array | null = null;
let prevExtractedFull: Uint8Array | null = null;
let lastKeyframeMs = 0;
let frameCount = 0;
let lastFpsPost = 0;
let framesSinceLastSend = 0;
const KEYFRAME_INTERVAL_MS = 5000;

let ramWatchList: { addr: number; label: string; size: number }[] = [];
let lastRamWatchPost = 0;

let cRead8: ((addr: number) => number) | null = null;
let cWrite8: ((addr: number, v: number) => void) | null = null;
let cExtrasSetObj: ((slot: number, a: number, b: number, c: number) => void) | null = null;
let cExtrasClearObjs: (() => void) | null = null;
let cRomPtr: (() => number) | null = null;
let cRomSize: (() => number) | null = null;
let cExtrasVramPtr: (() => number) | null = null;
let cExtrasVramSize: (() => number) | null = null;
let cExtrasPalettePtr: (() => number) | null = null;
let cExtrasPaletteSize: (() => number) | null = null;

function memAccess(): MemAccess {
  const m = Mod!;
  const heap = m.HEAPU8;
  const romP = cRomPtr!();
  const romSz = cRomSize!();
  const vramP = cExtrasVramPtr!();
  const palP = cExtrasPalettePtr!();

  return {
    readU8: (a) => cRead8!(a >>> 0) & 0xFF,
    readU16: (a) => (cRead8!(a >>> 0) & 0xFF) | ((cRead8!((a + 1) >>> 0) & 0xFF) << 8),
    readU32: (a) => {
      const r = cRead8!;
      return ((r(a >>> 0) & 0xFF) | ((r((a+1) >>> 0) & 0xFF) << 8) |
              ((r((a+2) >>> 0) & 0xFF) << 16) | ((r((a+3) >>> 0) & 0xFF) << 24)) >>> 0;
    },
    readBytes: (a, n) => {
      if (a >= 0x08000000 && a + n <= 0x0A000000) {
        const off = (a - 0x08000000) >>> 0;
        return heap.slice(romP + off, romP + off + n);
      }
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = cRead8!((a + i) >>> 0) & 0xFF;
      return out;
    },
    writeBytes: (a, bytes) => {
      for (let i = 0; i < bytes.length; i++) cWrite8!((a + i) >>> 0, bytes[i] & 0xFF);
    },
    romPtr: () => romP, romSize: () => romSz,
    ramPtr: () => 0, ramSize: () => 0,
    setExtraObj: (slot, _x, _y, _tile, _pal, _pri, _hf, _vf, _w, _h) => {
      // GBA extras use hardware OAM format (3 x uint16 attrs)
      const a = ((_y & 0xFF) | ((_h > 32 ? 2 : _h > 16 ? 1 : 0) << 14));
      const b = ((_x & 0x1FF) | ((_w > 32 ? 2 : _w > 16 ? 1 : 0) << 14) | (_hf ? 0x1000 : 0) | (_vf ? 0x2000 : 0));
      const c = (_tile & 0x3FF) | ((_pri & 3) << 10) | ((_pal & 0xF) << 12);
      cExtrasSetObj!(slot, a, b, c);
    },
    writeExtrasTile: (vramAddr, bytes) => { heap.set(bytes, vramP + vramAddr); },
    writeExtrasPalette: (cgramIdx, bgr555) => {
      const base = palP + cgramIdx * 2;
      heap[base] = bgr555 & 0xff;
      heap[base + 1] = (bgr555 >> 8) & 0xff;
    },
    clearExtras: () => { cExtrasClearObjs!(); },
  };
}

async function init(_offscreen: OffscreenCanvas, _audioSAB: SharedArrayBuffer) {
  // GBA worker: mgba runs its own canvas via emscripten GL, driven by
  // emscripten_set_main_loop. The offscreen canvas is used by the host
  // to create the worker; mgba needs a real canvas element. For the
  // worker-based architecture, mgba uses its internal rendering loop.
  const dynImport = new Function("u", "return import(u)") as (u: string) => Promise<any>;
  const mgbaModule = await dynImport("/mgba.js");
  const mgbaFactory = mgbaModule.default as (opts: object) => Promise<MGBAModule>;
  Mod = await mgbaFactory({ canvas: _offscreen });
  await Mod.FSInit();

  const cwrap = Mod.cwrap;
  cRead8 = cwrap("wasm_read_u8", "number", ["number"]);
  cWrite8 = cwrap("wasm_write_u8", null, ["number", "number"]);
  cExtrasSetObj = cwrap("wasm_extras_set_obj", null, ["number","number","number","number"]);
  cExtrasClearObjs = cwrap("wasm_extras_clear_objs", null, []);
  cRomPtr = cwrap("wasm_rom_ptr", "number", []);
  cRomSize = cwrap("wasm_rom_size", "number", []);
  cExtrasVramPtr = cwrap("wasm_extras_vram_ptr", "number", []);
  cExtrasVramSize = cwrap("wasm_extras_vram_size", "number", []);
  cExtrasPalettePtr = cwrap("wasm_extras_palette_ptr", "number", []);
  cExtrasPaletteSize = cwrap("wasm_extras_palette_size", "number", []);

  try { Mod.toggleInput?.(false); } catch { /* */ }
  postMessage({ type: "ready" });
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function loadRom(bytes: Uint8Array, filename: string) {
  if (!Mod) return postMessage({ type: "loaded", ok: false, error: "not initialized" });
  const sha = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  const shaHex = Array.from(new Uint8Array(sha)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const factoryFn = lookup(shaHex);

  const paths = Mod.filePaths();
  const dir = paths.gamePath || "/data/games";
  const path = `${dir}/${filename || "rom.gba"}`;
  const FS = Mod.FS;
  try { FS.mkdir("/data"); } catch { /* */ }
  for (const d of ["/data/games", "/data/saves", "/data/states", "/data/cheats", "/data/screenshots", "/data/patches"]) {
    try { FS.mkdir(d); } catch { /* */ }
  }
  FS.writeFile(path, bytes);
  const ok = Mod.loadGame(path);
  if (!ok) {
    postMessage({ type: "loaded", ok: false, sha: shaHex, error: "mGBA loadGame failed" });
    return;
  }
  if (factoryFn) {
    adapter = factoryFn();
    await adapter.install(memAccess());
  }
  prevExtractedFull = null;
  lastKeyframeMs = 0;
  lastOwnState = null;
  loaded = true;

  Mod.addCoreCallbacks({
    videoFrameEndedCallback: () => { frame(); },
  });

  postMessage({
    type: "loaded", ok: true, sha: shaHex,
    adapterId: adapter?.sha8, roomGroup: adapter?.roomGroup, stateBytes: adapter?.stateBytes,
  });
}

function frame() {
  if (!loaded || !Mod) return;
  if (adapter) {
    const mem = memAccess();
    mem.clearExtras();
    adapter.renderPeers(mem);
  }
  if (adapter) {
    const fullState = adapter.extract(memAccess());
    const nowMs = Date.now();
    const needKeyframe = !prevExtractedFull || (nowMs - lastKeyframeMs) >= KEYFRAME_INTERVAL_MS;
    if (fullState) {
      const changed = !lastOwnState || !bytesEq(fullState, lastOwnState);
      if (changed || needKeyframe) {
        const packet = adapter.encodePacket
          ? adapter.encodePacket(fullState, prevExtractedFull, needKeyframe)
          : fullState;
        lastOwnState = fullState.slice();
        prevExtractedFull = fullState.slice();
        if (needKeyframe) lastKeyframeMs = nowMs;
        const fsl = Math.min(framesSinceLastSend, 65535);
        framesSinceLastSend = 0;
        post({ type: "ownState", bytes: packet, framesSince: fsl }, [packet.buffer]);
      }
    }
  }
  frameCount++;
  framesSinceLastSend++;
  const now = performance.now();
  if (now - lastFpsPost >= 1000) {
    postMessage({ type: "fps", fps: frameCount });
    frameCount = 0;
    lastFpsPost = now;
  }
  if (ramWatchList.length > 0 && Mod && now - lastRamWatchPost >= 200) {
    lastRamWatchPost = now;
    const ma = memAccess();
    const values = ramWatchList.map(({ addr, label, size }) => ({
      label, value: size === 2 ? ma.readU16(addr) : ma.readU8(addr),
    }));
    postMessage({ type: "ramWatch", values });
  }
}

self.onerror = (e) => { postMessage({ type: "log", msg: "[gba-worker] uncaught: " + e }); };
self.onunhandledrejection = (e: any) => { postMessage({ type: "log", msg: "[gba-worker] unhandled rejection: " + e?.reason }); };

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  switch (msg.type) {
    case "init": await init(msg.offscreen, msg.audioSAB); break;
    case "loadRom": await loadRom(msg.bytes, msg.filename); break;
    case "tick": /* GBA: mGBA drives its own loop via emscripten_set_main_loop */ break;
    case "button":
      if (msg.pressed) Mod?.buttonPress(KEY[msg.btn] || "");
      else Mod?.buttonUnpress(KEY[msg.btn] || "");
      break;
    case "peerState":
      if (adapter && Mod) adapter.applyPeer(msg.peerId, msg.bytes, memAccess());
      break;
    case "peerLeave":
      if (adapter && Mod) adapter.removePeer(msg.peerId, memAccess());
      break;
    case "stateSave":
      if (Mod) {
        const ok = Mod.saveState(0);
        if (ok) {
          try {
            const dir = Mod.filePaths().saveStatePath;
            const files = Mod.FS.readdir(dir) as string[];
            const slot0 = files.find((n: string) => n.endsWith(".ss0"));
            if (slot0) {
              const bytes = new Uint8Array(Mod.FS.readFile(`${dir}/${slot0}`) as Uint8Array);
              post({ type: "stateSaved", bytes }, [bytes.buffer]);
              break;
            }
          } catch { /* */ }
        }
        post({ type: "stateSaved", bytes: null });
      } else {
        post({ type: "stateSaved", bytes: null });
      }
      break;
    case "stateLoad":
      if (Mod && msg.bytes instanceof Uint8Array) {
        try {
          const dir = Mod.filePaths().saveStatePath;
          Mod.FS.writeFile(`${dir}/rom.ss0`, msg.bytes);
          const ok = Mod.loadState(0);
          post({ type: "stateLoaded", ok });
        } catch {
          post({ type: "stateLoaded", ok: false });
        }
      } else {
        post({ type: "stateLoaded", ok: false });
      }
      break;
    case "ramWatch":
      ramWatchList = msg.addrs ?? [];
      break;
  }
};
