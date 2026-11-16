/// <reference types="vite/client" />
declare module '*.yaml?raw' {
  const content: string;
  export default content;
}

/** Item images bundled by vite.config.ts (itemImagesPlugin): package-relative path → URL. */
declare module 'virtual:item-images' {
  const urls: Record<string, string>;
  export default urls;
}
