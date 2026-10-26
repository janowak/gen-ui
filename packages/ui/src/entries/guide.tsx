import "@/runtime/preact";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GuideView } from "@/views/guide/GuideView";
import "@/styles.css";
import "@/app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GuideView />
  </StrictMode>,
);
