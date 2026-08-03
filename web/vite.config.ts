import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// /api 요청은 FastAPI 백엔드(:8000)로 프록시
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
})
