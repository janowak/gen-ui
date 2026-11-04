import "@/runtime/preact";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConnectorView } from "@/views/workspace/ConnectorView";
import "@/styles.css";
import "@/app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConnectorView />
  </StrictMode>,
);
