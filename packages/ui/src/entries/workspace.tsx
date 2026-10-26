import "@/runtime/preact";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceView } from "@/views/workspace/WorkspaceView";
import "@/styles.css";
import "@/app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorkspaceView />
  </StrictMode>,
);
