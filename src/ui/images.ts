// Item images (SPEC §13 Step 3). `virtual:item-images` (vite.config.ts) bundles one image per item (the
// first candidate that exists and fits the size cap), as item key → URL. A missing or broken image never
// shows a broken-image icon: the <img> removes itself and the name next to it remains.
import urls from 'virtual:item-images';

/** URL of an item's bundled image (by item key), or undefined when it has none. */
export function imageUrl(itemKey: string): string | undefined {
  return urls[itemKey];
}

/** Fixed-size, lazy-loaded icon HTML for an item, or '' (name only) when there is no image. */
export function icon(itemKey: string, size = 28): string {
  const url = imageUrl(itemKey);
  if (!url) return '';
  const safe = url.replace(/"/g, '%22');
  return `<img class="ico" src="${safe}" width="${size}" height="${size}" loading="lazy" decoding="async" alt="" onerror="this.remove()">`;
}
