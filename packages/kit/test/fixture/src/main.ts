import { mount } from "../../../src/index.js";
import badge from "./component.js";

const out = document.getElementById("out")!;

mount(badge, (ctx) => {
  out.textContent = ctx.props?.label ?? ctx.partial?.label ?? "…";
});
