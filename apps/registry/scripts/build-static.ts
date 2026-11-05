import { mkdir, writeFile } from "node:fs/promises";
import { loadAssets } from "../src/assets-node.js";
import { fileAssetStore } from "../src/static-assets-node.js";
import { hostViews } from "../src/views.js";

// The deployment includes built-ins as static files: cold isolates never upload them to R2.
const hosting = { baseURL: "https://app-mcp-assets.invalid/assets/", store: fileAssetStore("dist-static/assets") };
const assets = await hostViews(await loadAssets(), hosting);
await mkdir("dist-static", { recursive: true });
await writeFile("dist-static-views.txt", JSON.stringify({ views: assets.views, viewMetadata: assets.viewMetadata }));
