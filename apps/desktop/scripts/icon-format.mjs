/**
 * Wraps one PNG-compressed 256 px image in a single-entry Windows ICO file.
 *
 * @param {Buffer} png Complete PNG payload.
 * @returns {Buffer} ICO bytes accepted by Electron Builder and Windows Explorer.
 */
export function createWindowsIco(png) {
  const header = Buffer.alloc(22)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  header.writeUInt8(0, 6)
  header.writeUInt8(0, 7)
  header.writeUInt8(0, 8)
  header.writeUInt8(0, 9)
  header.writeUInt16LE(1, 10)
  header.writeUInt16LE(32, 12)
  header.writeUInt32LE(png.length, 14)
  header.writeUInt32LE(header.length, 18)
  return Buffer.concat([header, png])
}
