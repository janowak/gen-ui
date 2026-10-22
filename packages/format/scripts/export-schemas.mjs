// Writes the built-in tool input schemas as JSON Schema files, for SDKs in other languages
// (packages/sdk-python ships them). Runs after tsc, from dist.
import { mkdirSync, writeFileSync } from "node:fs";
import { builtInJsonSchemas } from "../dist/index.js";

const dir = new URL("../schemas/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const [name, schema] of Object.entries(builtInJsonSchemas())) {
  writeFileSync(new URL(`${name}.json`, dir), `${JSON.stringify(schema, null, 2)}\n`);
}
