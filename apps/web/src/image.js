const MAX_SIDE = 1024;

/**
 * Decodes the picked file in the browser (HEIC works where the browser can read it, e.g. Safari on
 * iPhone), shrinks it to 1024 px and re-encodes it as PNG so transparency is kept. The server then
 * checks the bytes and stores a 512 px WebP.
 * @param {File} file
 * @returns {Promise<Blob>}
 */
export async function prepareLogo(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    const heic = /hei[cf]$/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
    throw Object.assign(new Error('decode'), { code: heic ? 'IMAGE_HEIC_UNSUPPORTED' : 'IMAGE_TYPE_INVALID' });
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d')).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const png = await encode(canvas, 'image/png');
  // A photo rather than a flat logo: PNG can get close to the 4 MB upload limit, JPEG will not.
  return png.size <= 3 * 1024 * 1024 ? png : encode(canvas, 'image/jpeg', 0.9);
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {string} type
 * @param {number} [quality]
 * @returns {Promise<Blob>}
 */
function encode(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), type, quality));
}
