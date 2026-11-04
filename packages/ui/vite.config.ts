import path from "node:path";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const input = process.env.INPUT;

export default defineConfig({
  plugins: [preact(), tailwindcss(), ...(input ? [viteSingleFile()] : [])],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
    // @app-mcp/kit/react imports react (aliased to preact/compat): resolve it from here, so views keep one Preact.
    dedupe: ["preact", "react", "react-dom"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: input ? { input } : undefined,
  },
});
