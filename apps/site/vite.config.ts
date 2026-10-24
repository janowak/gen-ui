import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss()],
  build: {
    // 404.html is served by Cloudflare for unknown paths (assets.not_found_handling in wrangler.jsonc)
    rolldownOptions: { input: ["index.html", "404.html"] },
  },
});
