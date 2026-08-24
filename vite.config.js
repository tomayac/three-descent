import { defineConfig } from 'vite';
import { cosPlugin } from 'vite-plugin-cross-origin-storage';

export default defineConfig({
  assetsInclude: ['**/*.hog', '**/*.pig'],
  base: '/three-descent/',
  plugins: [
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
