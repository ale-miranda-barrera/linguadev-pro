// Comprime una imagen antes de guardarla como data URI. Downscale + reencode a JPEG/webp.
// Devuelve data URI listo para almacenar en Dexie.

export async function compressImageToDataUrl(
  file: File,
  opts: { maxDim?: number; quality?: number } = {},
): Promise<string> {
  const { maxDim = 800, quality = 0.8 } = opts;
  const dataUrl = await readAsDataUrl(file);
  const img = await loadImage(dataUrl);
  const { width, height } = fitInto(img.width, img.height, maxDim);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl; // fallback
  ctx.drawImage(img, 0, 0, width, height);
  // Preferimos JPEG (más pequeño) salvo que sea PNG con transparencia (raro).
  return canvas.toDataURL('image/jpeg', quality);
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('FileReader failed'));
    r.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = src;
  });
}

function fitInto(w: number, h: number, maxDim: number): { width: number; height: number } {
  if (w <= maxDim && h <= maxDim) return { width: w, height: h };
  const ratio = w / h;
  if (w >= h) {
    return { width: maxDim, height: Math.round(maxDim / ratio) };
  }
  return { width: Math.round(maxDim * ratio), height: maxDim };
}
