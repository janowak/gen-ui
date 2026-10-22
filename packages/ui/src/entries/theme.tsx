import "@/runtime/preact";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeView } from "@/views/theme/ThemeView";
import "@/styles.css";
import "@/app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeView />
  </StrictMode>,
);
