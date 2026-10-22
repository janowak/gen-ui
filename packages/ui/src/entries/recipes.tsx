import "@/runtime/preact";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RecipesView } from "@/views/recipes/RecipesView";
import "@/styles.css";
import "@/app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RecipesView />
  </StrictMode>,
);
