import { appMcp } from "@app-mcp/kit/vite";
import { defineConfig } from "vite";

// Single-file dist/index.html plus dist/app-mcp.component.json generated from src/component.ts.
export default defineConfig({ plugins: [appMcp()] });
