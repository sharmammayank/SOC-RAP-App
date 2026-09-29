/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  worker: { format: "es" },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: { echarts: ["echarts"], pptx: ["pptxgenjs"], supabase: ["@supabase/supabase-js"] },
      },
    },
  },
  test: { environment: "node", include: ["tests/**/*.test.ts"], testTimeout: 60000 },
});
