# netro-emu

Browser-based GBA and SNES emulators running as Web Workers with an extended API for multiplayer ghost rendering. Each emulator runs in an isolated Worker context, communicating with the host via `postMessage`.

Built on [mGBA](https://github.com/thenick775/mgba) (MPL-2.0) and [byuu-web/bsnes](https://github.com/Wizcorp/byuu-web) (GPL-3), with patches that expose PPU internals for sprite injection.

## What this is

A pair of emulator Web Workers with a defined message protocol:

- **Host → Worker:** `init`, `loadRom`, `tick`, `button`, `peerState`, `peerLeave`, `stateSave`, `stateLoad`
- **Worker → Host:** `ready`, `loaded`, `ownState`, `fps`, `stateSaved`, `stateLoaded`

The `ownState` / `peerState` messages carry opaque byte arrays produced by game-specific **adapters**. Adapters implement the `Adapter` interface (see `src/types.ts`) — they know how to extract player state from emulator memory and inject ghost sprites for peers.

No adapters are included. You write your own for each game.

## Extended API (mplay extras)

The patches add a second OBJ rendering pass to each emulator. The host writes into shadow VRAM/palette/OAM tables via `MemAccess`, and the patched renderer composites them alongside the game's own sprites. This is how ghost players appear — same pixel pipeline as native sprites, same shading and blend math.

## Setup

```bash
git clone --recurse-submodules https://github.com/dans-stuff/netro-emu.git
cd netro-emu
npm install

# Apply mplay patches to the emulator submodules
npm run patch

# Build the emulator WASM binaries (requires Docker for mGBA, emsdk for byuu)
npm run rebuild-mgba
npm run rebuild-byuu

# Bundle the Worker JS
npm run build
```

## Demo

The `dist/` directory is a static site. Serve it locally:

```bash
npx serve dist
```

Or deploy `dist/` to GitHub Pages.

## Writing an adapter

```typescript
import { register } from "./registry";
import type { Adapter, MemAccess } from "./types";

const myAdapter: Adapter = {
  sha8: "abcd1234",  // first 8 chars of ROM SHA-256
  roomGroup: "my-game",
  stateBytes: 16,

  install(mem) { /* one-time setup, e.g. build sprite atlases from ROM */ },
  extract(mem) { /* read player x/y/sprite from emulator memory, return bytes */ },
  applyPeer(peerId, bytes, mem) { /* decode peer state, write ghost sprites */ },
  removePeer(peerId, mem) { /* clear that peer's ghost sprites */ },
  renderPeers(mem) { /* called each frame before emulator runs */ },
};

register("abcd1234", () => myAdapter);
```

## Licenses

| Component | License |
|---|---|
| Worker glue, types, demo (`src/`, `demo/`) | MIT |
| `patches/mgba.patch` | MPL-2.0 (derivative of mGBA) |
| `patches/byuu-web.patch` | GPL-3 (derivative of bsnes/higan) |
| `vendor/mgba/` (submodule) | MPL-2.0 |
| `vendor/byuu-web/` (submodule) | GPL-3 |

The Worker boundary provides process-level isolation between the MIT host application and the emulator cores. The host communicates with the emulator exclusively via `postMessage`.
