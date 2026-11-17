declare module "pdfmake/build/pdfmake" {
  const pdfMake: {
    addVirtualFileSystem(vfs: unknown): void;
    createPdf(doc: unknown): { getBuffer(): Promise<Uint8Array> };
  };
  export default pdfMake;
}
declare module "pdfmake/build/vfs_fonts" {
  const vfs: unknown;
  export default vfs;
}
declare module "mammoth/mammoth.browser" {
  const mammoth: { extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }> };
  export default mammoth;
}
declare module "*?url" {
  const url: string;
  export default url;
}

/** Set at build time (vite.config.ts): the app version and the CI build it came from. */
declare const __APP_VERSION__: string;
declare const __APP_BUILD__: string;
