import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FormView } from "@/views/form/FormView";
import "@/styles.css";
import "@/app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FormView />
  </StrictMode>,
);
