// @app-mcp/registry on Node: the shared registry plus the Node pieces main.ts uses, for tests and embedding.
export { fetchClientMetadataResource } from "@better-auth/cimd/node";
export {
  createRegistryApp,
  Store,
  RegistryError,
  type Assets,
  type Database,
  type Refresher,
  type RegistryAppOptions,
  type Scope,
} from "./app.js";
export { loadAssets } from "./assets-node.js";
export { authConfigFromEnv, type AuthConfig } from "./auth.js";
export { openDatabase } from "./db-node.js";
export { enableManagement } from "./management.js";
