function matches(bytes, offset, signature) {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}
const tag = (bytes, offset, value) => matches(bytes, offset, [...value].map(char => char.charCodeAt(0)));
export const MAX_COVER_BYTES = 5242880;

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
    let avif = tag(bytes, 8, 'avif') || tag(bytes, 8, 'avis');
    for (let i = 16; i < length && !avif; i += 4) avif = tag(bytes, i, 'avif') || tag(bytes, i, 'avis');
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

function completePng(view) {
  if (view.getUint32(8) !== 13) return false;
  let data = false;
  for (let offset = 8; offset + 12 <= view.byteLength;) {
    const size = view.getUint32(offset);
    const kind = view.getUint32(offset + 4);
    offset += size + 12;
    if (offset > view.byteLength) return false;
    if (kind === 0x49444154 && size > 0) data = true; // IDAT
    if (kind === 0x49454e44) return data && !size && offset === view.byteLength; // IEND
  }
  return false;
}

function completeJpeg(bytes, view) {
  let offset = 2;
  let scan = false;
  let data = false;
  while (offset < bytes.length) {
    if (scan) {
      const markerOffset = bytes.indexOf(255, offset);
      if (markerOffset < 0) return false;
      data ||= markerOffset > offset;
      offset = markerOffset;
    } else if (bytes[offset] !== 255) return false;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 217) return data;
    if (scan && marker === 0) {
      data = true; // Escaped 0xff in the entropy-coded data.
      continue;
    }
    if (scan && marker >= 208 && marker <= 215) continue;
    if (marker === 1) continue;
    if (!marker || marker === 216 || offset + 2 > bytes.length) return false;
    const size = view.getUint16(offset);
    if (size < 2 || offset + size > bytes.length) return false;
    scan = marker === 218;
    if (scan && size < 6) return false;
    offset += size;
  }
  return false;
}

function skipGifBlocks(bytes, offset) {
  for (;;) {
    const size = bytes[offset++];
    if (size === 0) return offset;
    if (size === undefined || offset + size > bytes.length) return -1;
    offset += size;
  }
}

function completeGif(bytes) {
  let offset = 13 + (bytes[10] & 128 ? 3 * (2 << (bytes[10] & 7)) : 0);
  let frame = false;
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 59) return frame;
    if (marker === 33) {
      offset = skipGifBlocks(bytes, offset + 1); // Extension label.
    } else if (marker === 44 && offset + 9 < bytes.length) {
      const flags = bytes[offset + 8];
      offset += 9 + (flags & 128 ? 3 * (2 << (flags & 7)) : 0);
      const codeSize = bytes[offset++];
      if (codeSize < 2 || codeSize > 8 || !bytes[offset]) return false;
      offset = skipGifBlocks(bytes, offset);
      frame = true;
    } else return false;
    if (offset < 0) return false;
  }
  return false;
}

function webpFrames(view, offset, end, animation = true) {
  let frame = false;
  while (offset + 8 <= end) {
    const type = view.getUint32(offset);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    offset = start + size + (size & 1);
    if (offset > end) return false;
    if ((type === 0x56503820 && size > 10) || (type === 0x5650384c && size > 5)) frame = true; // VP8 / VP8L
    if (animation && type === 0x414e4d46 && size > 16 && webpFrames(view, start + 16, start + size, false)) frame = true; // ANMF
  }
  return frame && offset === end;
}

function avifBoxes(view, offset, end, topLevel = true) {
  let metadata = false;
  let data = false;
  while (offset + 8 <= end) {
    const type = view.getUint32(offset + 4);
    let size = view.getUint32(offset);
    let header = 8;
    if (size === 1) {
      header = 16;
      if (offset + header > end) return null;
      size = Number(view.getBigUint64(offset + 8));
    } else if (size === 0) size = end - offset;
    if (size < header || size > end - offset) return null;
    if (topLevel && type === 0x6d657461) { // meta
      const inner = avifBoxes(view, offset + header + 4, offset + size, false);
      if (!inner) return null;
      metadata = true;
      data ||= inner.data;
    }
    if (topLevel && type === 0x6d6f6f76 && size > header) metadata = true; // moov
    if (type === (topLevel ? 0x6d646174 : 0x69646174) && size > header) data = true; // mdat / idat
    offset += size;
  }
  return offset === end ? { metadata, data } : null;
}

// Bound both the stored bytes and the decoded canvas. Check complete container
// framing without decompressing image pixels in the Worker.
export function validatedCoverInfo(bytes) {
  if (bytes.length > MAX_COVER_BYTES) return null;
  const info = imageInfo(bytes);
  if (!info || info.width > 8192 || info.height > 8192 || info.width * info.height > 40000000) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let complete;
  switch (info.type) {
    case 'image/jpeg': complete = completeJpeg(bytes, view); break;
    case 'image/png': complete = completePng(view); break;
    case 'image/gif': complete = completeGif(bytes); break;
    case 'image/webp': complete = webpFrames(view, 12, view.getUint32(4, true) + 8); break;
    case 'image/avif': {
      const boxes = avifBoxes(view, 0, bytes.length);
      complete = boxes?.metadata && boxes.data;
      break;
    }
  }
  return complete ? info : null;
}
