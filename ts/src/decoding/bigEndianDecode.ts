/**
 * Decodes big-endian bytes into `out` without allocating the output buffer.
 *
 * This function does not copy `bytes`; it writes decoded words into the provided `out` array.
 * `DataView` reads big-endian words at any alignment and is faster in V8 than swapping bytes by hand.
 *
 * If `byteLength` is not a multiple of 4, the final word is padded with zeros.
 *
 * @returns Number of int32 words written.
 * @throws RangeError If `(offset, byteLength)` is out of bounds, or if `out` is too small.
 */
export function decodeBigEndianInt32sInto(
    bytes: Uint8Array,
    offset: number,
    byteLength: number,
    out: Uint32Array,
): number {
    if (offset < 0 || byteLength < 0 || offset + byteLength > bytes.length) {
        throw new RangeError(
            `decodeBigEndianInt32sInto: out of bounds (offset=${offset}, byteLength=${byteLength}, bytes.length=${bytes.length})`,
        );
    }

    const numCompleteInts = Math.floor(byteLength / 4);
    const hasTrailingBytes = byteLength % 4 !== 0;
    const numInts = hasTrailingBytes ? numCompleteInts + 1 : numCompleteInts;

    if (out.length < numInts) {
        throw new RangeError(`decodeBigEndianInt32sInto: out.length=${out.length} < ${numInts}`);
    }

    if (numCompleteInts > 0) {
        const view = new DataView(bytes.buffer, bytes.byteOffset + offset, numCompleteInts * 4);
        for (let i = 0; i < numCompleteInts; i++) {
            out[i] = view.getUint32(i * 4);
        }
    }

    if (hasTrailingBytes) {
        const base = offset + numCompleteInts * 4;
        const remaining = byteLength - numCompleteInts * 4;
        let v = 0;
        for (let i = 0; i < remaining; i++) {
            v |= bytes[base + i] << (24 - i * 8);
        }
        out[numCompleteInts] = v | 0;
    }

    return numInts;
}
