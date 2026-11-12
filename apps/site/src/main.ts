import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./site.css";
import { setupCopy } from "./copy";
import { setupDemo } from "./demo";
import { setupThemeToggle } from "./theme";

setupThemeToggle(document.querySelector("[data-theme-toggle]")!);
setupDemo(document.getElementById("demos")!);
setupCopy(document);
