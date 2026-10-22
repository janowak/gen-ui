import "@/runtime/preact";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ManagerView } from "@/views/manager/ManagerView";
import "@/styles.css";
import "@/app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ManagerView />
  </StrictMode>,
);
