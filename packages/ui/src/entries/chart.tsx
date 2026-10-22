import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChartView } from "@/views/chart/ChartView";
import "@/styles.css";
import "@/app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ChartView />
  </StrictMode>,
);
