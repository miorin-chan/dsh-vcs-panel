/**
 * esbuild's `text` loader in `scripts/build.mjs` inlines each stylesheet as its
 * text, so a stylesheet import has a string default export.
 */
declare module '*.css' {
  const text: string
  export default text
}
