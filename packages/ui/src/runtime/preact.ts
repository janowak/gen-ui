import { options, type VNode } from "preact";

/**
 * Views run on Preact 10 (react/react-dom are aliased to @preact/compat), but the code is written
 * for React 19, which passes `ref` to function components as a regular prop. shadcn relies on that:
 * Base UI hands its ref to the element in `render={<Button />}`, and wrappers like `Input` spread it
 * onto the primitive. Preact 10 keeps the ref on the vnode instead (and fills it with the component
 * instance), so move it into props for every function component, as Preact 11 does natively.
 * Class components keep their instance ref. Import this before the first render.
 */
const previous = options.vnode;
options.vnode = (vnode: VNode) => {
  const type: unknown = vnode.type;
  if (typeof type === "function" && !type.prototype?.render && vnode.ref) {
    (vnode.props as { ref?: unknown }).ref = vnode.ref;
    vnode.ref = null;
  }
  previous?.(vnode);
};
