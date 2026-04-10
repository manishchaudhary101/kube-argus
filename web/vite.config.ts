import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': { target: 'http://localhost:8080', ws: true }, '/auth': 'http://localhost:8080', '/health': 'http://localhost:8080' } },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) return 'react'
          if (id.includes('node_modules/recharts') || id.includes('node_modules/d3-')) return 'recharts'
        },
      },
    },
  },
})
