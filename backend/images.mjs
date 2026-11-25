function matches(bytes, offset, signature) {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}
const tag = (bytes, offset, value) => matches(bytes, offset, [...value].map(char => char.charCodeAt(0)));

export function imageInfo(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let type, width, height;
  if (bytes.length >= 24 && matches(bytes, 0, [137,80,78,71,13,10,26,10]) && tag(bytes, 12, 'IHDR')) {
    type = 'image/png';
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (bytes.length >= 13 && (tag(bytes, 0, 'GIF87a') || tag(bytes, 0, 'GIF89a'))) {
    type = 'image/gif';
    width = view.getUint16(6, true);
    height = view.getUint16(8, true);
  } else if (bytes.length >= 26 && tag(bytes, 0, 'RIFF') && tag(bytes, 8, 'WEBP') && view.getUint32(4, true) + 8 <= bytes.length) {
    type = 'image/webp';
    if (bytes.length >= 30 && tag(bytes, 12, 'VP8X')) {
      const size = offset => 1 + bytes[offset] + 256 * bytes[offset + 1] + 65536 * bytes[offset + 2];
      width = size(24);
      height = size(27);
    } else if (tag(bytes, 12, 'VP8L') && bytes[20] === 47) {
      const bits = view.getUint32(21, true);
      width = 1 + (bits & 0x3fff);
      height = 1 + ((bits >>> 14) & 0x3fff);
    } else if (bytes.length >= 30 && tag(bytes, 12, 'VP8 ') && matches(bytes, 23, [0x9d,0x01,0x2a])) {
      width = view.getUint16(26, true) & 0x3fff;
      height = view.getUint16(28, true) & 0x3fff;
    }
  } else if (bytes.length >= 12 && matches(bytes, 0, [255,216,255])) {
    type = 'image/jpeg';
    let offset = 2;
    while (offset + 8 < bytes.length && bytes[offset] === 255) {
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 218 || marker === 217 || offset + 2 > bytes.length) break;
      const size = view.getUint16(offset);
      if (size < 2 || offset + size > bytes.length) break;
      if (size >= 8 && marker >= 192 && marker <= 207 && ![196,200,204].includes(marker)) {
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
        break;
      }
      offset += size;
    }
  } else if (bytes.length >= 32 && tag(bytes, 4, 'ftyp')) {
    const length = view.getUint32(0);
    if (length < 16 || length > 128 || length > bytes.length) return null;
    let avif = tag(bytes, 8, 'avif');
    for (let i = 16; i < length && !avif; i += 4) avif = tag(bytes, i, 'avif');
    if (avif) {
      type = 'image/avif';
      for (let i = length + 4; i + 16 <= bytes.length; i++) {
        if (bytes[i] !== 105 || !tag(bytes, i, 'ispe') || view.getUint32(i - 4) < 20) continue;
        width = view.getUint32(i + 8);
        height = view.getUint32(i + 12);
        break;
      }
    }
  }
  return type && width > 0 && height > 0 ? { type, width, height } : null;
}
