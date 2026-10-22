import { defineConfig } from "vite";

// The genui dev host page's script, bundled with its dependencies so a component's dev server
// can serve it as-is (no resolving or pre-bundling on the user's side).
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    copyPublicDir: false,
    target: "es2022",
    lib: { entry: "src/harness/main.ts", formats: ["es"], fileName: () => "harness.js" },
  },
});
