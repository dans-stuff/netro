import type { Adapter, MemAccess } from "../types";
import { lookup } from "../registry";

// To register game adapters, import this worker entry and call register()
// before loading a ROM. See src/registry.ts.
export { register } from "../registry";

// @ts-expect-error emitted JS module, no .d.ts
import factoryImport from "/byuu-web-lib.js";
const factory = factoryImport as (opts: object) => Promise<ByuuModule>;

interface ByuuModule {
  HEAPU8: Uint8Array;
  HEAPU16: Uint16Array;
  _malloc(size: number): number;
  _free(ptr: number): void;

  _mplay_getPixelPtr(): number;
  _mplay_getPixelMaxW(): number;
  _mplay_getPixelMaxH(): number;
  _mplay_getActiveW(): number;
  _mplay_getActiveH(): number;
  _mplay_getAudioRingPtr(): number;
  _mplay_getAudioRingCapacity(): number;
  _mplay_getAudioWriteIdx(): number;
  _mplay_runOneFrame(): void;
  _mplay_getRomPtr(): number; _mplay_getRomSize(): number;
  _mplay_getRamPtr(): number; _mplay_getRamSize(): number;
  _mplay_getVramPtr(): number; _mplay_getVramSize(): number;
  _mplay_getCgramPtr(): number; _mplay_getCgramSize(): number;
  _mplay_getOamPtr(): number; _mplay_getOamSize(): number;
  _mplay_callSubroutine(addr: number): void;
  _mplay_powerCycle(): void;
  _mplay_extras_obj_ptr(): number;
  _mplay_extras_obj_count(): number;
  _mplay_extras_vram_ptr(): number;
  _mplay_extras_vram_size(): number;
  _mplay_extras_cgram_ptr(): number;
  _mplay_extras_cgram_size(): number;
  _mplay_extras_clear(): void;
  _mplay_videoClear(): void;
  _mplay_videoResetDebug(): void;
  _mplay_stateLoadRaw(ptr: number, len: number): boolean;

  configure(name: string, value: number): void;
  initialize(title: string): void;
  setEmulatorForFilename(filename: string): boolean;
  load(rom: Uint8Array, files: object): any;
  unload(): void;
  setButton(port: string, btn: string, val: number): void;
  connectPeripheral(port: string, peripheral: string): boolean;
  stateSave(callback: (bytes: Uint8Array) => void): void;
  stateLoad(data: string): boolean;
}

const post = (self as unknown as {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
}).postMessage.bind(self);

let Mod: ByuuModule | null = null;
let adapter: Adapter | null = null;
let gl: WebGL2RenderingContext | null = null;
let tex: WebGLTexture | null = null;
let uvScaleLoc: WebGLUniformLocation | null = null;
let pxMaxW = 0, pxMaxH = 0;
let pxPtr = 0;
let audioHeader: Int32Array | null = null;
let audioData: Int16Array | null = null;
let audioOutCap = 0;
let audioRingPtr = 0;
let audioRingCap = 0;
let audioReadIdx = 0;
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

const VRAM_PREFIX  = 0x10000000;
const CGRAM_PREFIX = 0x11000000;
const OAM_PREFIX   = 0x12000000;
const ROM_PREFIX   = 0x13000000;

function memAccess(): MemAccess {
  const m = Mod!;
  const ramP   = m._mplay_getRamPtr();
  const ramSz  = m._mplay_getRamSize();
  const vramP  = m._mplay_getVramPtr();
  const cgramP = m._mplay_getCgramPtr();
  const oamP   = m._mplay_getOamPtr();
  const romP   = m._mplay_getRomPtr();
  const romSz  = m._mplay_getRomSize();
  const heap = m.HEAPU8;

  const resolve = (addr: number): number => {
    if (addr >= ROM_PREFIX)   return romP + (addr - ROM_PREFIX);
    if (addr >= OAM_PREFIX)   return oamP + (addr - OAM_PREFIX);
    if (addr >= CGRAM_PREFIX) return cgramP + (addr - CGRAM_PREFIX);
    if (addr >= VRAM_PREFIX)  return vramP + (addr - VRAM_PREFIX);
    if (addr >= 0x7E0000 && addr < 0x800000) return ramP + (addr & 0x1FFFF);
    const bank = (addr >> 16) & 0xff;
    const off  = addr & 0xffff;
    if ((bank <= 0x3F || (bank >= 0x80 && bank <= 0xBF)) && off < 0x2000) return ramP + off;
    return romP + (addr & 0xFFFFFF);
  };

  return {
    readU8: (a) => heap[resolve(a)],
    readU16: (a) => { const i = resolve(a); return heap[i] | (heap[i+1] << 8); },
    readU32: (a) => { const i = resolve(a); return (heap[i] | (heap[i+1] << 8) | (heap[i+2] << 16) | (heap[i+3] << 24)) >>> 0; },
    readBytes: (a, n) => { const i = resolve(a); return heap.slice(i, i + n); },
    writeBytes: (a, bytes) => { const i = resolve(a); heap.set(bytes, i); },
    romPtr: () => romP, romSize: () => romSz,
    ramPtr: () => ramP, ramSize: () => ramSz,
    setExtraObj: (slot, x, y, tile, palette, priority, hflip, vflip, w, h) => {
      const base = m._mplay_extras_obj_ptr() + slot * 12;
      const dv = new DataView(heap.buffer, base, 12);
      dv.setInt16(0, x, true); dv.setInt16(2, y, true);
      dv.setUint16(4, tile, true);
      heap[base + 6] = palette; heap[base + 7] = priority;
      heap[base + 8] = hflip ? 1 : 0; heap[base + 9] = vflip ? 1 : 0;
      heap[base + 10] = w; heap[base + 11] = h;
    },
    writeExtrasTile: (vramAddr, bytes) => {
      const base = m._mplay_extras_vram_ptr() + vramAddr;
      heap.set(bytes, base);
    },
    writeExtrasPalette: (cgramIdx, bgr555) => {
      const base = m._mplay_extras_cgram_ptr() + cgramIdx * 2;
      heap[base] = bgr555 & 0xff;
      heap[base + 1] = (bgr555 >> 8) & 0xff;
    },
    clearExtras: () => { m._mplay_extras_clear(); },
  };
}

function initGL(canvas: OffscreenCanvas) {
  gl = canvas.getContext("webgl2", { alpha: false, antialias: false, premultipliedAlpha: false, desynchronized: true });
  if (!gl) throw new Error("webgl2 not available");
  const vsSrc = `#version 300 es
in vec2 a; uniform vec2 uvScale; out vec2 v;
void main() { vec2 uv = a * 0.5 + 0.5; uv.y = 1.0 - uv.y; v = uv * uvScale; gl_Position = vec4(a, 0.0, 1.0); }`;
  const fsSrc = `#version 300 es
precision mediump float; in vec2 v; uniform sampler2D t; out vec4 o;
void main() { vec4 c = texture(t, v); o = vec4(c.b, c.g, c.r, 1.0); }`;
  const compile = (kind: number, src: string) => {
    const sh = gl!.createShader(kind)!;
    gl!.shaderSource(sh, src); gl!.compileShader(sh);
    if (!gl!.getShaderParameter(sh, gl!.COMPILE_STATUS)) throw new Error("shader: " + gl!.getShaderInfoLog(sh));
    return sh;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  uvScaleLoc = gl.getUniformLocation(prog, "uvScale");
  const buf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  const aLoc = gl.getAttribLocation(prog, "a");
  gl.enableVertexAttribArray(aLoc);
  gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);
  tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

async function init(offscreen: OffscreenCanvas, audioSAB: SharedArrayBuffer) {
  initGL(offscreen);
  Mod = await factory({});
  if (!Mod) throw new Error("byuu module failed to instantiate");
  Mod.initialize("byuu");
  pxPtr = Mod._mplay_getPixelPtr();
  pxMaxW = Mod._mplay_getPixelMaxW();
  pxMaxH = Mod._mplay_getPixelMaxH();
  audioRingPtr = Mod._mplay_getAudioRingPtr();
  audioRingCap = Mod._mplay_getAudioRingCapacity();
  audioHeader = new Int32Array(audioSAB, 0, 4);
  audioData = new Int16Array(audioSAB, 16);
  audioOutCap = audioHeader[2];
  gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, pxMaxW, pxMaxH, 0, gl!.RGBA, gl!.UNSIGNED_BYTE, null);
  postMessage({ type: "ready" });
}

async function loadRom(bytes: Uint8Array, filename: string) {
  if (!Mod) return postMessage({ type: "loaded", ok: false, error: "not initialized" });
  const sha = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  const shaHex = Array.from(new Uint8Array(sha)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const factoryFn = lookup(shaHex);
  if (!factoryFn) {
    postMessage({ type: "loaded", ok: false, sha: shaHex, error: "no adapter for this SHA" });
    return;
  }
  Mod.setEmulatorForFilename(filename || "rom.sfc");
  const info = Mod.load(bytes, {});
  if (!info) {
    postMessage({ type: "loaded", ok: false, sha: shaHex, error: "byuu rejected ROM" });
    return;
  }
  Mod.connectPeripheral("Controller Port 1", "Gamepad");
  Mod.configure("cpu/lockstep", 1);
  Mod.configure("smp/lockstep", 1);
  adapter = factoryFn();
  prevExtractedFull = null;
  lastKeyframeMs = 0;
  lastOwnState = null;
  const settleFrames = adapter.settleFrames ?? 0;
  for (let i = 0; i < settleFrames; i++) Mod._mplay_runOneFrame();
  try { await adapter.install(memAccess()); }
  catch (err) {
    postMessage({ type: "loaded", ok: false, sha: shaHex, error: "adapter install threw: " + err });
    return;
  }
  if (!adapter.skipReload) {
    Mod._mplay_videoClear();
    Mod.unload();
    Mod.setEmulatorForFilename(filename || "rom.sfc");
    const reloadInfo = Mod.load(bytes, {});
    if (!reloadInfo) {
      postMessage({ type: "loaded", ok: false, sha: shaHex, error: "byuu rejected ROM on reload" });
      return;
    }
    Mod.connectPeripheral("Controller Port 1", "Gamepad");
    Mod.configure("cpu/lockstep", 1);
    Mod.configure("smp/lockstep", 1);
  } else {
    Mod._mplay_videoClear();
  }
  audioReadIdx = Mod._mplay_getAudioWriteIdx();
  loaded = true;
  postMessage({
    type: "loaded", ok: true, sha: shaHex,
    adapterId: adapter.sha8, roomGroup: adapter.roomGroup, stateBytes: adapter.stateBytes,
  });
}

function pumpAudio() {
  if (!Mod || !audioHeader || !audioData) return;
  const writeIdx = Mod._mplay_getAudioWriteIdx();
  let available = (writeIdx - audioReadIdx + audioRingCap) % audioRingCap;
  if (!available) return;
  const ring = new Int16Array(Mod.HEAPU8.buffer, audioRingPtr, audioRingCap);
  let sabWrite = Atomics.load(audioHeader, 0);
  const sabRead = Atomics.load(audioHeader, 1);
  const sabFree = (sabRead - sabWrite - 2 + audioOutCap) % audioOutCap;
  const toWrite = Math.min(available, sabFree);
  for (let i = 0; i < toWrite; i++) {
    audioData[sabWrite] = ring[audioReadIdx];
    sabWrite = (sabWrite + 1) % audioOutCap;
    audioReadIdx = (audioReadIdx + 1) % audioRingCap;
  }
  Atomics.store(audioHeader, 0, sabWrite);
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function frame() {
  if (!loaded || !Mod || !gl) return;
  if (adapter) {
    const mem = memAccess();
    mem.clearExtras();
    adapter.renderPeers(mem);
  }
  Mod._mplay_runOneFrame();
  const activeW = Mod._mplay_getActiveW();
  const activeH = Mod._mplay_getActiveH();
  const pxView = new Uint8Array(Mod.HEAPU8.buffer, pxPtr, pxMaxW * activeH * 4);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, pxMaxW);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, activeW, activeH, gl.RGBA, gl.UNSIGNED_BYTE, pxView);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  gl.uniform2f(uvScaleLoc!, activeW / pxMaxW, activeH / pxMaxH);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.flush();
  pumpAudio();
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

self.onerror = (e) => { postMessage({ type: "log", msg: "[snes-worker] uncaught: " + e }); };
self.onunhandledrejection = (e: any) => { postMessage({ type: "log", msg: "[snes-worker] unhandled rejection: " + e?.reason }); };

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  switch (msg.type) {
    case "init": await init(msg.offscreen, msg.audioSAB); break;
    case "loadRom": await loadRom(msg.bytes, msg.filename); break;
    case "tick": frame(); break;
    case "button": Mod?.setButton(msg.port, msg.btn, msg.pressed ? 1 : 0); break;
    case "peerState":
      if (adapter && Mod) adapter.applyPeer(msg.peerId, msg.bytes, memAccess());
      break;
    case "peerLeave":
      if (adapter && Mod) adapter.removePeer(msg.peerId, memAccess());
      break;
    case "stateSave":
      if (Mod) {
        Mod.stateSave((bytes: Uint8Array) => {
          const copy = new Uint8Array(bytes);
          post({ type: "stateSaved", bytes: copy }, [copy.buffer]);
        });
      } else {
        post({ type: "stateSaved", bytes: null });
      }
      break;
    case "stateLoad":
      if (Mod && msg.bytes instanceof Uint8Array) {
        const bytes = msg.bytes as Uint8Array;
        const ptr = Mod._malloc(bytes.length);
        Mod.HEAPU8.set(bytes, ptr);
        const ok = Mod._mplay_stateLoadRaw(ptr, bytes.length);
        Mod._free(ptr);
        post({ type: "stateLoaded", ok });
      } else {
        post({ type: "stateLoaded", ok: false });
      }
      break;
    case "ramWatch":
      ramWatchList = msg.addrs ?? [];
      break;
  }
};
