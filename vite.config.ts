import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      '__APP_VERSION__': JSON.stringify(process.env.npm_package_version)
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      }
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            // React core libraries
            'vendor-react': ['react', 'react-dom'],
            // Drag and drop libraries
            'vendor-dnd': [
              '@dnd-kit/core',
              '@dnd-kit/sortable',
              '@dnd-kit/utilities'
            ],
            // 注意：不要给 lucide-react 设 manualChunks。
            // 一旦把整包 lucide 固定成单一 chunk，入口就必然静态依赖它，
            // 863KB 的完整图标库会被重新拖回首屏关键路径。交给 Rollup 自动拆分后，
            // 入口只保留 Icon.tsx 里显式引用的少量图标，其余进入按需加载的 chunk。
            // AI library
            'vendor-ai': ['@google/genai'],
          }
        }
      },
      // Increase chunk size warning limit to reduce warnings
      chunkSizeWarningLimit: 1000
    }
  };
});
