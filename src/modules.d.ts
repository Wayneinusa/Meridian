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
