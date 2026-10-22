import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./site.css";
import { setupDemo } from "./demo";
import { setupLane } from "./lane";
import { setupThemeToggle } from "./theme";

setupThemeToggle(document.querySelector("[data-theme-toggle]")!);
setupDemo(document.getElementById("demo")!);
setupLane(document.getElementById("lane")!);
