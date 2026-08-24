# Pure-JavaScript OPL3 emulator

This directory contains a source-visible ES-module adaptation of the OPL3
emulator from `doomjs/opl3`, commit
`a6656741f28bf3cf29dfa31a6b833dced6daf555`. That JavaScript implementation
is a port of Robson Cozendey's JavaOPL3 emulator.

The upstream Java implementation is licensed under LGPL-2.1-or-later. This
copy conservatively preserves that license and the original attribution even
though the later npm package metadata labels its JavaScript port as MIT.

Local changes are intentionally mechanical:

- replaced the CommonJS `util` and `extend` dependencies with local helpers;
- exported the emulator as an ES module;
- kept the full, modifiable source in the browser distribution.

No WebAssembly or native binary is used.
