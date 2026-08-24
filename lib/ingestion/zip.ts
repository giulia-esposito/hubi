import { inflateRawSync } from "node:zlib";

/**
 * Minimal read-only ZIP reader, sufficient for OOXML containers (.docx, .pptx).
 * Deliberately zero-dependency: DOCX/PPTX parsing shouldn't require an npm
 * package just to unwrap a ZIP file Node can already inflate natively.
 *
 * Does not support ZIP64 (not needed for the document sizes in this project's
 * Content Repository) or multi-disk archives.
 */
export function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();

  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error("Not a valid ZIP/OOXML file (End Of Central Directory record not found)");
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);

  const CDH_SIG = 0x02014b50;
  let offset = centralDirOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (buffer.readUInt32LE(offset) !== CDH_SIG) {
      throw new Error(`Corrupt ZIP central directory at entry ${i}`);
    }
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    const lfhNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const lfhExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lfhNameLength + lfhExtraLength;
    const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);

    if (!name.endsWith("/")) {
      let data: Buffer;
      if (compressionMethod === 0) {
        data = Buffer.from(compressedData);
      } else if (compressionMethod === 8) {
        data = inflateRawSync(compressedData);
      } else {
        throw new Error(`Unsupported ZIP compression method ${compressionMethod} for entry "${name}"`);
      }
      entries.set(name, data);
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}
