import IntWrapper from "../decoding/intWrapper";
import type { Int32Buf, Uint8Buf } from "../decoding/fastPforShared";
import {
    MASKS,
    DEFAULT_PAGE_SIZE,
    BLOCK_SIZE,
    greatestMultiple,
    roundUpToMultipleOf32,
    normalizePageSize,
} from "../decoding/fastPforShared";

const OVERHEAD_OF_EACH_EXCEPT = 8;
const PAGE_SIZE = normalizePageSize(DEFAULT_PAGE_SIZE);
const INITIAL_PACKED_SIZE_WORDS = (PAGE_SIZE / 32) * 4;
const BYTE_CONTAINER_SIZE = ((3 * PAGE_SIZE) / BLOCK_SIZE + PAGE_SIZE) | 0;

function bits(value: number): number {
    return 32 - Math.clz32(value >>> 0);
}

function ensureInt32Capacity(buffer: Int32Buf, requiredLength: number): Int32Buf {
    if (requiredLength <= buffer.length) return buffer;

    let newLength = buffer.length === 0 ? 1 : buffer.length;
    while (newLength < requiredLength) {
        newLength *= 2;
    }

    const next = new Int32Array(newLength) as Int32Buf;
    next.set(buffer);
    return next;
}

function ensureUint8Capacity(buffer: Uint8Buf, requiredLength: number): Uint8Buf {
    if (requiredLength <= buffer.length) return buffer;

    let newLength = buffer.length === 0 ? 1 : buffer.length;
    while (newLength < requiredLength) {
        newLength *= 2;
    }

    const next = new Uint8Array(newLength) as Uint8Buf;
    next.set(buffer);
    return next;
}

/**
 * Internal workspace for the FastPFOR encoder.
 * Exposed so callers can avoid allocations and safely encode in parallel.
 */
export type FastPforEncoderWorkspace = {
    dataToBePacked: Int32Array[];
    dataPointers: Int32Array;
    byteContainer: Uint8Buf;
    freqs: Int32Array;
    best: Int32Array;
};

/**
 * Generic bit-packing of 32 integers, matching JavaFastPFOR BitPacking.fastpack ordering.
 * Writes exactly `bitWidth` int32 words into `out` starting at `outPos`.
 */
function fastPack32(inValues: Int32Array, inPos: number, out: Int32Buf, outPos: number, bitWidth: number): void {
    if (bitWidth === 0) return;
    if (bitWidth === 32) {
        out.set(inValues.subarray(inPos, inPos + 32), outPos);
        return;
    }

    const mask = MASKS[bitWidth] >>> 0;
    let outputWordIndex = outPos;
    let bitOffset = 0;
    let currentWord = 0;

    for (let i = 0; i < 32; i++) {
        const value = (inValues[inPos + i] >>> 0) & mask;

        if (bitOffset + bitWidth <= 32) {
            currentWord |= value << bitOffset;
            bitOffset += bitWidth;

            if (bitOffset === 32) {
                out[outputWordIndex++] = currentWord | 0;
                bitOffset = 0;
                currentWord = 0;
            }
        } else {
            const lowBits = 32 - bitOffset;
            const lowMask = MASKS[lowBits] >>> 0;
            currentWord |= (value & lowMask) << bitOffset;
            out[outputWordIndex++] = currentWord | 0;
            currentWord = value >>> lowBits;
            bitOffset = bitWidth - lowBits;
        }
    }

    if (bitOffset !== 0) {
        out[outputWordIndex] = currentWord | 0;
    }
}

export function createFastPforEncoderWorkspace(): FastPforEncoderWorkspace {
    const dataToBePacked: Int32Array[] = new Array(33);
    for (let k = 1; k < dataToBePacked.length; k++) {
        dataToBePacked[k] = new Int32Array(INITIAL_PACKED_SIZE_WORDS);
    }

    return {
        dataToBePacked,
        dataPointers: new Int32Array(33),
        byteContainer: new Uint8Array(BYTE_CONTAINER_SIZE) as Uint8Buf,
        freqs: new Int32Array(33),
        best: new Int32Array(3),
    };
}

/**
 * Default encoder workspace, allocated lazily on first use.
 * The encoder is used primarily for tests and is not safe for concurrent calls.
 */
let sharedDefaultWorkspace: FastPforEncoderWorkspace | undefined;

function getOrCreateDefaultWorkspace(): FastPforEncoderWorkspace {
    if (!sharedDefaultWorkspace) {
        sharedDefaultWorkspace = createFastPforEncoderWorkspace();
    }
    return sharedDefaultWorkspace;
}

function computeBestBitWidthPlan(inValues: Int32Array, pos: number, ws: FastPforEncoderWorkspace): void {
    const freqs = ws.freqs;
    const best = ws.best;
    freqs.fill(0);
    for (let k = pos, kEnd = pos + BLOCK_SIZE; k < kEnd; k++) {
        freqs[bits(inValues[k])]++;
    }

    let maxBits = 32;
    while (freqs[maxBits] === 0) maxBits--;

    let bestBitWidth = maxBits;
    let bestCost = maxBits * BLOCK_SIZE;
    let cExcept = 0;
    let bestCExcept = cExcept;

    for (let b = maxBits - 1; b >= 0; b--) {
        cExcept += freqs[b + 1];
        if (cExcept === BLOCK_SIZE) break;

        let thisCost = cExcept * OVERHEAD_OF_EACH_EXCEPT + cExcept * (maxBits - b) + b * BLOCK_SIZE + 8;
        if (maxBits - b === 1) thisCost -= cExcept;

        if (thisCost < bestCost) {
            bestCost = thisCost;
            bestBitWidth = b;
            bestCExcept = cExcept;
        }
    }

    best[0] = bestBitWidth;
    best[1] = bestCExcept;
    best[2] = maxBits;
}

function writeByte(ws: FastPforEncoderWorkspace, byteContainerPos: number, byteValue: number): number {
    if (byteContainerPos >= ws.byteContainer.length) {
        ws.byteContainer = ensureUint8Capacity(ws.byteContainer, byteContainerPos + 1);
    }
    ws.byteContainer[byteContainerPos] = byteValue & 0xff;
    return byteContainerPos + 1;
}

function ensureExceptionValuesCapacity(
    dataToBePacked: Int32Array[],
    dataPointers: Int32Array,
    exceptionIndex: number,
    cExcept: number,
): void {
    if (exceptionIndex === 1) return;

    const needed = dataPointers[exceptionIndex] + cExcept;
    if (needed >= dataToBePacked[exceptionIndex].length) {
        let newSize = 2 * needed;
        newSize = roundUpToMultipleOf32(newSize);
        const next = new Int32Array(newSize);
        next.set(dataToBePacked[exceptionIndex]);
        dataToBePacked[exceptionIndex] = next;
    }
}

function writeBlockHeader(
    ws: FastPforEncoderWorkspace,
    byteContainerPos: number,
    bitWidth: number,
    cExcept: number,
    maxBits: number,
): number {
    byteContainerPos = writeByte(ws, byteContainerPos, bitWidth);
    byteContainerPos = writeByte(ws, byteContainerPos, cExcept);
    if (cExcept > 0) {
        byteContainerPos = writeByte(ws, byteContainerPos, maxBits);
    }
    return byteContainerPos;
}

function recordBlockExceptions(
    ws: FastPforEncoderWorkspace,
    inValues: Int32Array,
    blockPos: number,
    bitWidth: number,
    cExcept: number,
    exceptionIndex: number,
    byteContainerPos: number,
): number {
    if (cExcept === 0) return byteContainerPos;

    const dataToBePacked = ws.dataToBePacked;
    const dataPointers = ws.dataPointers;

    ensureExceptionValuesCapacity(dataToBePacked, dataPointers, exceptionIndex, cExcept);

    let realExcept = 0;
    for (let k = 0; k < BLOCK_SIZE; k++) {
        const value = inValues[blockPos + k] >>> 0;
        if (value >>> bitWidth !== 0) {
            realExcept++;
            byteContainerPos = writeByte(ws, byteContainerPos, k);
            if (exceptionIndex !== 1) {
                dataToBePacked[exceptionIndex][dataPointers[exceptionIndex]++] = (value >>> bitWidth) | 0;
            }
        }
    }

    if (realExcept !== cExcept) {
        throw new Error(`FastPFOR encode: exception count mismatch (got ${realExcept}, expected ${cExcept})`);
    }

    return byteContainerPos;
}

type PackBlockState = { out: Int32Buf; outPos: number };

function packBlock(
    inValues: Int32Array,
    blockPos: number,
    bitWidth: number,
    state: PackBlockState,
): void {
    for (let k = 0; k < BLOCK_SIZE; k += 32) {
        state.out = ensureInt32Capacity(state.out, state.outPos + bitWidth);
        fastPack32(inValues, blockPos + k, state.out, state.outPos, bitWidth);
        state.outPos += bitWidth;
    }
}

function padByteContainerToInt32(ws: FastPforEncoderWorkspace, byteContainerPos: number): number {
    while ((byteContainerPos & 3) !== 0) {
        byteContainerPos = writeByte(ws, byteContainerPos, 0);
    }
    return byteContainerPos;
}

function writeByteContainerInts(
    ws: FastPforEncoderWorkspace,
    out: Int32Buf,
    outPos: number,
    byteContainerPos: number,
): { out: Int32Buf; outPos: number } {
    const howManyInts = byteContainerPos / 4;
    out = ensureInt32Capacity(out, outPos + howManyInts);

    const byteContainer = ws.byteContainer;
    for (let i = 0; i < howManyInts; i++) {
        const base = i * 4;
        const v =
            byteContainer[base] |
            (byteContainer[base + 1] << 8) |
            (byteContainer[base + 2] << 16) |
            (byteContainer[base + 3] << 24) |
            0;
        out[outPos + i] = v;
    }

    return { out, outPos: outPos + howManyInts };
}

function computeExceptionBitmap(dataPointers: Int32Array): number {
    let bitmap = 0;
    for (let k = 2; k <= 32; k++) {
        if (dataPointers[k] !== 0) {
            bitmap |= (k === 32) ? 0x80000000 : (1 << (k - 1));
        }
    }
    return bitmap;
}

function writeExceptionStreams(
    ws: FastPforEncoderWorkspace,
    out: Int32Buf,
    outPos: number,
): { out: Int32Buf; outPos: number } {
    const dataPointers = ws.dataPointers;
    const dataToBePacked = ws.dataToBePacked;

    const bitmap = computeExceptionBitmap(dataPointers);
    out = ensureInt32Capacity(out, outPos + 1);
    out[outPos++] = bitmap;

    for (let k = 2; k <= 32; k++) {
        const size = dataPointers[k];
        if (size !== 0) {
            out = ensureInt32Capacity(out, outPos + 1);
            out[outPos++] = size | 0;

            let j = 0;
            for (; j < size; j += 32) {
                out = ensureInt32Capacity(out, outPos + k);
                fastPack32(dataToBePacked[k], j, out, outPos, k);
                outPos += k;
            }

            const overflow = j - size;
            outPos -= ((overflow * k) >>> 5);
        }
    }

    return { out, outPos };
}

function encodePage(
    inValues: Int32Array,
    inPos: IntWrapper,
    thisSize: number,
    out: Int32Buf,
    outPos: IntWrapper,
    ws: FastPforEncoderWorkspace,
): Int32Buf {
    const headerPos = outPos.get();
    out = ensureInt32Capacity(out, headerPos + 1);
    outPos.increment();
    let tmpOutPos = outPos.get();

    const dataPointers = ws.dataPointers;
    dataPointers.fill(0);

    let byteContainerPos = 0;

    let tmpInPos = inPos.get();
    const finalInPos = tmpInPos + thisSize - BLOCK_SIZE;

    const packState: PackBlockState = { out, outPos: tmpOutPos };

    for (; tmpInPos <= finalInPos; tmpInPos += BLOCK_SIZE) {
        computeBestBitWidthPlan(inValues, tmpInPos, ws);

        const best = ws.best;
        const b = best[0];
        const cExcept = best[1];
        const maxBits = best[2];

        const exceptionIndex = cExcept > 0 ? (maxBits - b) : 0;
        if (cExcept > 0 && (exceptionIndex < 1 || exceptionIndex > 32)) {
            throw new Error(`FastPFOR encode: invalid exception index=${exceptionIndex} (b=${b}, maxBits=${maxBits})`);
        }

        byteContainerPos = writeBlockHeader(ws, byteContainerPos, b, cExcept, maxBits);
        byteContainerPos = recordBlockExceptions(ws, inValues, tmpInPos, b, cExcept, exceptionIndex, byteContainerPos);

        packState.out = out;
        packState.outPos = tmpOutPos;
        packBlock(inValues, tmpInPos, b, packState);
        out = packState.out;
        tmpOutPos = packState.outPos;
    }

    inPos.set(tmpInPos);
    out[headerPos] = (tmpOutPos - headerPos) | 0;

    const byteSize = byteContainerPos;
    byteContainerPos = padByteContainerToInt32(ws, byteContainerPos);

    out = ensureInt32Capacity(out, tmpOutPos + 1);
    out[tmpOutPos++] = byteSize | 0;

    const byteContainerWritten = writeByteContainerInts(ws, out, tmpOutPos, byteContainerPos);
    out = byteContainerWritten.out;
    tmpOutPos = byteContainerWritten.outPos;

    const exceptionWritten = writeExceptionStreams(ws, out, tmpOutPos);
    out = exceptionWritten.out;
    tmpOutPos = exceptionWritten.outPos;

    outPos.set(tmpOutPos);
    return out;
}

function headlessEncode(
    inValues: Int32Array,
    inPos: IntWrapper,
    inLength: number,
    out: Int32Buf,
    outPos: IntWrapper,
    ws: FastPforEncoderWorkspace,
): Int32Buf {
    const alignedLength = greatestMultiple(inLength, BLOCK_SIZE);
    const finalInPos = inPos.get() + alignedLength;

    while (inPos.get() !== finalInPos) {
        const thisSize = Math.min(PAGE_SIZE, finalInPos - inPos.get());
        out = encodePage(inValues, inPos, thisSize, out, outPos, ws);
    }

    return out;
}

function encode(
    inValues: Int32Array,
    inPos: IntWrapper,
    inLength: number,
    out: Int32Buf,
    outPos: IntWrapper,
    ws: FastPforEncoderWorkspace,
): Int32Buf {
    const alignedLength = greatestMultiple(inLength, BLOCK_SIZE);
    out = ensureInt32Capacity(out, outPos.get() + 1);
    out[outPos.get()] = alignedLength;
    outPos.increment();

    if (alignedLength === 0) return out;
    return headlessEncode(inValues, inPos, alignedLength, out, outPos, ws);
}

/**
 * VByte encoding for FastPFOR tail values (MSB=1 terminator).
 * Note: Inverts standard Protobuf Varint (MSB=0 terminator), so we cannot reuse generic methods.
 */
function encodeVByte(
    inValues: Int32Array,
    inPos: IntWrapper,
    inLength: number,
    out: Int32Buf,
    outPos: IntWrapper,
): Int32Buf {
    if (inLength === 0) return out;

    if (inLength > 255) {
        throw new Error(`encodeVByte: inLength=${inLength} exceeds expected max of 255`);
    }
    const bytes: number[] = [];

    const start = inPos.get();
    for (let k = start; k < start + inLength; k++) {
        let v = inValues[k] >>> 0;
        while (v >= 0x80) {
            bytes.push(v & 0x7f);
            v >>>= 7;
        }
        bytes.push(v | 0x80);
    }

    while (bytes.length % 4 !== 0) bytes.push(0);

    const intsToWrite = bytes.length / 4;
    out = ensureInt32Capacity(out, outPos.get() + intsToWrite);

    let outIdx = outPos.get();
    for (let i = 0; i < bytes.length; i += 4) {
        const v = bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24) | 0;
        out[outIdx++] = v;
    }

    outPos.set(outIdx);
    inPos.add(inLength);
    return out;
}

/**
 * Encodes an int32 stream using the FastPFOR wire format (pages + VByte tail).
 * Intended for tests and reference output.
 */
export function encodeFastPforInt32(values: Int32Array): Int32Buf {
    return encodeFastPforInt32WithWorkspace(values, undefined);
}

/**
 * Encodes an int32 stream using the FastPFOR wire format (pages + VByte tail).
 *
 * If `workspace` is omitted, a shared module-level workspace is used (faster, but not safe for overlapping calls).
 * If `workspace` is provided, the call is safe for parallel usage.
 */
export function encodeFastPforInt32WithWorkspace(
    values: Int32Array,
    workspace: FastPforEncoderWorkspace | undefined,
): Int32Buf {
    const inPos = new IntWrapper(0);
    const outPos = new IntWrapper(0);
    let out = new Int32Array(values.length + 1024) as Int32Buf;

    out = encode(values, inPos, values.length, out, outPos, workspace ?? getOrCreateDefaultWorkspace());

    const remaining = values.length - inPos.get();
    out = encodeVByte(values, inPos, remaining, out, outPos);

    return out.subarray(0, outPos.get());
}
