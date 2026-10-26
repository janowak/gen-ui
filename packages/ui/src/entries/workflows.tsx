import "@/runtime/preact";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WorkflowsView } from "@/views/workflows/WorkflowsView";
import "@/styles.css";
import "@/app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorkflowsView />
  </StrictMode>,
);
