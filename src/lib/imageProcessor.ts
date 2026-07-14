import { CUSTOM_DESIGNS_CONFIG } from './customDesigns';

export interface ProcessedImage {
  backgroundBlob: Blob;
  thumbnailBlob: Blob;
  previewUrl: string;
}

export const validateAndProcessImage = async (file: File): Promise<ProcessedImage> => {
  // 1. Validate file size and type
  if (file.size > CUSTOM_DESIGNS_CONFIG.MAX_UPLOAD_BYTES) {
    throw new Error('La imagen no puede superar los 5 MB.');
  }

  if (!CUSTOM_DESIGNS_CONFIG.ACCEPTED_FORMATS.includes(file.type)) {
    throw new Error('Usá una imagen JPG, PNG o WEBP.');
  }

  // 2. Load image into memory
  const img = await loadImage(file);

  // 3. Process Background (max 1080px width)
  const bgCanvas = document.createElement('canvas');
  let bgWidth = img.width;
  let bgHeight = img.height;

  if (bgWidth > 1080) {
    const ratio = 1080 / bgWidth;
    bgWidth = 1080;
    bgHeight = Math.round(bgHeight * ratio);
  }

  bgCanvas.width = bgWidth;
  bgCanvas.height = bgHeight;
  const bgCtx = bgCanvas.getContext('2d');
  if (!bgCtx) throw new Error('No pudimos procesar la imagen.');
  bgCtx.drawImage(img, 0, 0, bgWidth, bgHeight);

  const backgroundBlob = await new Promise<Blob>((resolve, reject) => {
    bgCanvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('Falló compresión de fondo')),
      'image/webp',
      0.82
    );
  });

  // 4. Process Thumbnail (max 400px width)
  const thumbCanvas = document.createElement('canvas');
  let thumbWidth = img.width;
  let thumbHeight = img.height;

  if (thumbWidth > 400) {
    const ratio = 400 / thumbWidth;
    thumbWidth = 400;
    thumbHeight = Math.round(thumbHeight * ratio);
  }

  thumbCanvas.width = thumbWidth;
  thumbCanvas.height = thumbHeight;
  const thumbCtx = thumbCanvas.getContext('2d');
  if (!thumbCtx) throw new Error('No pudimos procesar la imagen.');
  thumbCtx.drawImage(img, 0, 0, thumbWidth, thumbHeight);

  const thumbnailBlob = await new Promise<Blob>((resolve, reject) => {
    thumbCanvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('Falló compresión de miniatura')),
      'image/webp',
      0.75
    );
  });

  // 5. Generate a local preview URL
  const previewUrl = URL.createObjectURL(backgroundBlob);

  return {
    backgroundBlob,
    thumbnailBlob,
    previewUrl
  };
};

const loadImage = (file: File): Promise<HTMLImageElement> => {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('No pudimos cargar la imagen. Probá con otra.'));
    };
    img.src = url;
  });
};
