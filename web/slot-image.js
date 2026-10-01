import { MAX_SLOT_IMAGE_BYTES } from "./macro-editor.js";

export function imageChecksum(bytes) {
  let checksum = 2166136261;
  for (const byte of bytes) checksum = Math.imul(checksum ^ byte, 16777619) >>> 0;
  return checksum;
}

export function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export function base64ToImageBytes(encoded) {
  if (typeof encoded !== "string" || encoded.length > 90000) {
    throw new Error("配装图片数据过大或格式错误。");
  }
  let binary;
  try { binary = atob(encoded); }
  catch { throw new Error("配装图片不是有效的 Base64 数据。"); }
  if (!binary.length || binary.length > MAX_SLOT_IMAGE_BYTES) {
    throw new Error("配装图片必须小于 64 KiB。");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("JSON 中的配装图片必须是 JPEG。");
  }
  return bytes;
}

function jpegBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

export async function prepareImage(file) {
  if (!file?.type?.startsWith("image/")) throw new Error("请选择图片文件。");
  if (file.type === "image/jpeg" && file.size <= MAX_SLOT_IMAGE_BYTES) {
    return new Uint8Array(await file.arrayBuffer());
  }
  let bitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error("无法读取这张图片，请换一张 JPEG 或 PNG 图片。"); }
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    for (const longest of [800, 640, 480, 360, 280]) {
      const scale = Math.min(1, longest / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.82, 0.7, 0.58, 0.45]) {
        const blob = await jpegBlob(canvas, quality);
        if (blob && blob.size <= MAX_SLOT_IMAGE_BYTES) {
          return new Uint8Array(await blob.arrayBuffer());
        }
      }
    }
  } finally {
    bitmap.close();
  }
  throw new Error("图片压缩后仍超过 64 KiB，请选择更简单的图片。");
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function uploadSlotImage(request, slot, bytes, onProgress = () => {}) {
  if (!(bytes instanceof Uint8Array) || !bytes.length ||
      bytes.length > MAX_SLOT_IMAGE_BYTES) throw new Error("配装图片超出 64 KiB 限制。");
  await request(`SLOT_IMAGE_BEGIN ${slot} ${bytes.length} ${imageChecksum(bytes)}`, "ack");
  try {
    for (let offset = 0; offset < bytes.length; offset += 96) {
      await request(`SLOT_IMAGE_CHUNK ${bytesToHex(bytes.subarray(offset, offset + 96))}`, "ack");
      onProgress(Math.min(bytes.length, offset + 96), bytes.length);
    }
    await request("SLOT_IMAGE_COMMIT", "ack");
  } catch (error) {
    await request("SLOT_IMAGE_ABORT", "ack").catch(() => {});
    throw error;
  }
}

export async function downloadSlotImage(request, slot, onProgress = () => {}) {
  const info = await request(`SLOT_IMAGE_INFO ${slot}`, "slot_image_info");
  if (!info.exists || !info.bytes) return null;
  if (info.bytes > MAX_SLOT_IMAGE_BYTES) throw new Error("板载图片超过网页支持的大小。");
  const bytes = new Uint8Array(info.bytes);
  for (let offset = 0; offset < bytes.length;) {
    const chunk = await request(`SLOT_IMAGE_READ ${slot} ${offset}`, "slot_image_chunk");
    if (chunk.offset !== offset || !/^(?:[0-9a-f]{2})+$/i.test(chunk.data || "") ||
        offset + chunk.data.length / 2 > bytes.length) {
      throw new Error("板载图片数据不完整。");
    }
    for (let index = 0; index < chunk.data.length; index += 2) {
      bytes[offset++] = parseInt(chunk.data.slice(index, index + 2), 16);
    }
    onProgress(offset, bytes.length);
  }
  return bytes;
}
