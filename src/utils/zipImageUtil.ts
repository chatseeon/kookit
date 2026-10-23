import { Inflate } from "fflate";

// ZIP 中央目录条目
export interface ZipEntryInfo {
  path: string;
  method: number;
  compressedOffset: number;
  compressedSize: number;
  uncompressedSize: number;
  encrypted: boolean;
}

export interface ImageSize {
  width: number;
  height: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

const normalizeZipPath = (path: string) => {
  try {
    path = decodeURIComponent(path);
  } catch (error) {}
  return path.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/^\/+/, "");
};

// 只读中央目录，不解压文件内容
export const readZipDirectory = (
  buffer: ArrayBuffer
): Map<string, ZipEntryInfo> => {
  const entries = new Map<string, ZipEntryInfo>();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length < 22) return entries;
  const minOffset = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= minOffset; offset--) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) return entries;
  const entryCount = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  // ZIP64 不支持，回退普通布局
  if (entryCount === 0xffff || centralOffset === 0xffffffff) return entries;
  if (centralOffset + 4 > bytes.length) return entries;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > bytes.length) break;
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) break;
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.length) break;
    const path = normalizeZipPath(
      new TextDecoder("utf-8").decode(bytes.subarray(nameStart, nameEnd))
    );
    if (!path.endsWith("/") && localOffset + 30 <= bytes.length) {
      // 带 data descriptor 时本地头大小字段为 0，以中央目录为准
      if (view.getUint32(localOffset, true) === LOCAL_SIGNATURE) {
        const localNameLength = view.getUint16(localOffset + 26, true);
        const localExtraLength = view.getUint16(localOffset + 28, true);
        const dataOffset =
          localOffset + 30 + localNameLength + localExtraLength;
        entries.set(path, {
          path,
          method,
          compressedOffset: dataOffset,
          compressedSize,
          uncompressedSize,
          encrypted: (flags & 0x1) === 1,
        });
      }
    }
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
};

export const findZipEntry = (
  entries: Map<string, ZipEntryInfo>,
  path: string
): ZipEntryInfo | undefined => {
  const normalized = normalizeZipPath(path.split("#")[0].split("?")[0]);
  const direct = entries.get(normalized);
  if (direct) return direct;
  const lower = normalized.toLowerCase();
  for (const [name, entry] of entries) {
    if (name.toLowerCase() === lower) return entry;
  }
  return undefined;
};

const parseJpegSize = (bytes: Uint8Array, length: number): ImageSize | null => {
  if (length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    let marker = bytes[offset + 1];
    offset += 2;
    while (marker === 0xff && offset < length) {
      marker = bytes[offset];
      offset++;
    }
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    if (offset + 1 >= length) return null;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2) {
      offset++;
      continue;
    }
    const isStartOfFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isStartOfFrame) {
      if (offset + 6 >= length) return null;
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += segmentLength;
  }
  return null;
};

const parsePngSize = (bytes: Uint8Array, length: number): ImageSize | null => {
  if (
    length < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    return null;
  }
  const width =
    ((bytes[16] << 24) >>> 0) +
    (bytes[17] << 16) +
    (bytes[18] << 8) +
    bytes[19];
  const height =
    ((bytes[20] << 24) >>> 0) +
    (bytes[21] << 16) +
    (bytes[22] << 8) +
    bytes[23];
  return width > 0 && height > 0 ? { width, height } : null;
};

const parseGifSize = (bytes: Uint8Array, length: number): ImageSize | null => {
  if (length < 10 || bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) {
    return null;
  }
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  return width > 0 && height > 0 ? { width, height } : null;
};

const parseWebpSize = (bytes: Uint8Array, length: number): ImageSize | null => {
  if (
    length < 16 ||
    bytes[0] !== 0x52 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x46 ||
    bytes[8] !== 0x57 ||
    bytes[9] !== 0x45 ||
    bytes[10] !== 0x42 ||
    bytes[11] !== 0x50
  ) {
    return null;
  }
  const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (chunk === "VP8 " && length >= 30) {
    const width = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
    const height = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (chunk === "VP8L" && length >= 25) {
    if (bytes[20] !== 0x2f) return null;
    const b0 = bytes[21];
    const b1 = bytes[22];
    const b2 = bytes[23];
    const b3 = bytes[24];
    const width = (b0 | ((b1 & 0x3f) << 8)) + 1;
    const height =
      (((b1 >> 6) & 0x3) | (b2 << 2) | ((b3 & 0x0f) << 10)) + 1;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (chunk === "VP8X" && length >= 30) {
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
};

export const getImageSizeFromPrefix = (
  bytes: Uint8Array,
  length: number
): ImageSize | null => {
  return (
    parseJpegSize(bytes, length) ||
    parsePngSize(bytes, length) ||
    parseGifSize(bytes, length) ||
    parseWebpSize(bytes, length)
  );
};

// 只解压头部，图片尺寸都在前几 KB
export const readZipEntryPrefix = (
  buffer: ArrayBuffer,
  entry: ZipEntryInfo,
  maxOutput = 262144,
  maxCompressed = 262144
): Uint8Array | null => {
  if (entry.encrypted) return null;
  const bytes = new Uint8Array(buffer);
  const compressedEnd = Math.min(
    entry.compressedOffset + entry.compressedSize,
    bytes.length,
    entry.compressedOffset + maxCompressed
  );
  if (entry.compressedOffset >= compressedEnd) return null;
  if (entry.method === 0) {
    return bytes.subarray(
      entry.compressedOffset,
      Math.min(compressedEnd, entry.compressedOffset + maxOutput)
    );
  }
  if (entry.method !== 8) return null;
  const outputLength = Math.max(
    1,
    Math.min(entry.uncompressedSize || maxOutput, maxOutput)
  );
  const output = new Uint8Array(outputLength);
  let written = 0;
  let failed = false;
  const inflater = new Inflate((chunk) => {
    if (!chunk || written >= output.length) return;
    const take = Math.min(chunk.length, output.length - written);
    output.set(chunk.subarray(0, take), written);
    written += take;
  });
  const chunkSize = 16384;
  for (
    let offset = entry.compressedOffset;
    offset < compressedEnd && !failed && written < output.length;
    offset += chunkSize
  ) {
    const end = Math.min(offset + chunkSize, compressedEnd);
    try {
      inflater.push(bytes.subarray(offset, end), end === compressedEnd);
    } catch (error) {
      failed = true;
      break;
    }
    if (getImageSizeFromPrefix(output, written)) break;
  }
  if (written === 0) return null;
  return output.subarray(0, written);
};

export const getZipImageSize = (
  buffer: ArrayBuffer,
  entry: ZipEntryInfo
): ImageSize | null => {
  const prefix = readZipEntryPrefix(buffer, entry);
  if (!prefix) return null;
  const size = getImageSizeFromPrefix(prefix, prefix.length);
  if (!size) return null;
  return size;
};
