import { defineConfig } from 'vite';
import crossOriginStorage from 'vite-plugin-cross-origin-storage';

export default defineConfig({
  assetsInclude: ['**/*.hog', '**/*.pig'],
  plugins: [
    crossOriginStorage({
      include: [/vendor-three-.*.js/],
    }),
  ],
  build: {
    outDir: 'docs',
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/three/")) {
            return "vendor-three";
          }
        }
      }
    },
  },
  server: {
    open: true,
  },
});
