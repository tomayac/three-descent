import { defineConfig } from 'vite';
import { cosPlugin } from 'vite-plugin-cross-origin-storage';

// src/opl_synth.js loads its AudioWorklet with
// `new URL('./opl_worklet.js', import.meta.url)`. Vite treats that as a static
// asset and copies it verbatim, so the worklet's own
// `import { HmiOpl3Synth } from './opl3_hmi.js'` never gets resolved: inlined
// under assetsInlineLimit it becomes a data: URL ("base scheme isn't
// hierarchical"), and emitted as a file it 404s. Either way the OPL3 worklet
// fails to load and music falls back to the Web Audio synth.
//
// Rewriting the reference to `?worker&url` makes Vite bundle the worklet into a
// self-contained chunk. Done here rather than in src/ so the sources stay
// identical to upstream and don't conflict when merging mrdoob/three-descent.
function bundleAudioWorklet() {
  const needle = "new URL( './opl_worklet.js', import.meta.url )";
  return {
    name: 'bundle-audio-worklet',
    transform( code, id ) {
      if ( ! id.endsWith( '/src/opl_synth.js' ) ) return null;
      if ( ! code.includes( needle ) ) {
        this.warn( 'opl_worklet.js reference not found — did upstream change it?' );
        return null;
      }
      return {
        code: `import __oplWorkletUrl from './opl_worklet.js?worker&url';\n${ code.replace( needle, '__oplWorkletUrl' ) }`,
        map: null,
      };
    },
  };
}

export default defineConfig({
  assetsInclude: ['**/*.hog', '**/*.pig'],
  base: '/three-descent/',
  plugins: [
    bundleAudioWorklet(),
    cosPlugin({
      packages: [/^three(\/|$)/],
    }),
  ],
  build: {
    outDir: 'docs',
    target: 'esnext',
  },
  server: {
    open: true,
  },
});
