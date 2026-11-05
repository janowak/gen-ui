// worker.ts imports views and pages as text (the "Text" rule in wrangler.jsonc).
declare module "*.html" {
  const html: string;
  export default html;
}

declare module "*.txt" {
  const content: string;
  export default content;
}
