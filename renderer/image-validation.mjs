const maxImageBytes = 15 * 1024 * 1024;
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const jpegSignature = [0xff, 0xd8, 0xff];

function imageType(bytes) {
  if (bytes.length >= 33 && pngSignature.every((byte, index) => bytes[index] === byte)) {
    return 'image/png';
  }
  if (bytes.length > 4 && jpegSignature.every((byte, index) => bytes[index] === byte)) {
    return 'image/jpeg';
  }
  return null;
}

export async function readImage(file) {
  if (!file.size || file.size > maxImageBytes ||
      (file.type && file.type !== 'image/png' && file.type !== 'image/jpeg')) {
    throw new Error('请选择 15 MB 以内的 PNG 或 JPEG 图片');
  }

  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new Error('读取图片失败，请重新选择');
  }

  const type = imageType(bytes);
  if (!type) throw new Error('图片的文件头无效，请重新选择 PNG 或 JPEG');
  if (file.type && file.type !== type) throw new Error('图片的文件头与文件类型不一致');

  const source = file.type ? file : new Blob([bytes], { type });
  try {
    const bitmap = await createImageBitmap(source, { resizeWidth: 1, resizeHeight: 1 });
    bitmap.close();
  } catch {
    throw new Error('无法解码这张图片，请重新选择 PNG 或 JPEG');
  }

  // Decode only for validation. The data URL carries the original image bytes.
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reader.onabort = () => reject(new Error('读取图片失败，请重新选择'));
    reader.readAsDataURL(source);
  });
  return { data };
}
