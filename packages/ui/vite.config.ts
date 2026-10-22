import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const input = process.env.INPUT;

export default defineConfig({
  plugins: [react(), tailwindcss(), ...(input ? [viteSingleFile()] : [])],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: input ? { input } : undefined,
  },
});
