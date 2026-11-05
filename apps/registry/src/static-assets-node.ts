import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { StaticAssetStore } from "./static-assets.js";

/** Only content-addressed JS/CSS keys are accepted, never paths supplied by a publisher. */
export function fileAssetStore(directory: string): StaticAssetStore {
  const path = (key: string) => {
    if (!/^[a-f0-9]{64}\.(js|css)$/.test(key)) throw new Error("Invalid asset key");
    return join(directory, key);
  };
  return {
    async put(key, body) {
      await mkdir(directory, { recursive: true });
      const destination = path(key);
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, body, { flag: "wx" });
        try {
          await link(temporary, destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      } finally {
        await unlink(temporary).catch(() => {});
      }
    },
    async get(key) {
      try {
        return {
          body: await readFile(path(key)),
          contentType: key.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
  };
}
