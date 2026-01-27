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
const INITIAL_PACKED_BUFFER_SIZE_WORDS = (PAGE_SIZE / 32) * 4;
const BYTE_CONTAINER_SIZE = ((3 * PAGE_SIZE) / BLOCK_SIZE + PAGE_SIZE) | 0;

function requiredBits(value: number): number {
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

export function fastPack32(inValues: Int32Array, inPos: number, out: Int32Buf, outPos: number, bitWidth: number): void {
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
        dataToBePacked[k] = new Int32Array(INITIAL_PACKED_BUFFER_SIZE_WORDS);
    }

    return {
        dataToBePacked,
        dataPointers: new Int32Array(33),
        byteContainer: new Uint8Array(BYTE_CONTAINER_SIZE) as Uint8Buf,
        freqs: new Int32Array(33),
        best: new Int32Array(3),
    };
}

function computeBestBitWidthPlan(inValues: Int32Array, pos: number, ws: FastPforEncoderWorkspace): void {
    const freqs = ws.freqs;
    const best = ws.best;
    freqs.fill(0);
    for (let k = pos, kEnd = pos + BLOCK_SIZE; k < kEnd; k++) {
        freqs[requiredBits(inValues[k])]++;
    }

    let maxBitWidth = 32;
    while (freqs[maxBitWidth] === 0) maxBitWidth--;

    let bestBitWidth = maxBitWidth;
    let bestCost = maxBitWidth * BLOCK_SIZE;
    let exceptionCount = 0;
    let bestExceptionCount = exceptionCount;

    for (let candidateBitWidth = maxBitWidth - 1; candidateBitWidth >= 0; candidateBitWidth--) {
        exceptionCount += freqs[candidateBitWidth + 1];
        if (exceptionCount === BLOCK_SIZE) break;

        let thisCost =
            exceptionCount * OVERHEAD_OF_EACH_EXCEPT +
            exceptionCount * (maxBitWidth - candidateBitWidth) +
            candidateBitWidth * BLOCK_SIZE +
            8;
        if (maxBitWidth - candidateBitWidth === 1) thisCost -= exceptionCount;

        if (thisCost < bestCost) {
            bestCost = thisCost;
            bestBitWidth = candidateBitWidth;
            bestExceptionCount = exceptionCount;
        }
    }

    best[0] = bestBitWidth;
    best[1] = bestExceptionCount;
    best[2] = maxBitWidth;
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
    exceptionCount: number,
): void {
    if (exceptionIndex === 1) return;

    const needed = dataPointers[exceptionIndex] + exceptionCount;
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
    exceptionCount: number,
    maxBitWidth: number,
): number {
    byteContainerPos = writeByte(ws, byteContainerPos, bitWidth);
    byteContainerPos = writeByte(ws, byteContainerPos, exceptionCount);
    if (exceptionCount > 0) {
        byteContainerPos = writeByte(ws, byteContainerPos, maxBitWidth);
    }
    return byteContainerPos;
}

function recordBlockExceptions(
    ws: FastPforEncoderWorkspace,
    inValues: Int32Array,
    blockPos: number,
    bitWidth: number,
    exceptionCount: number,
    exceptionIndex: number,
    byteContainerPos: number,
): number {
    if (exceptionCount === 0) return byteContainerPos;

    const dataToBePacked = ws.dataToBePacked;
    const dataPointers = ws.dataPointers;

    ensureExceptionValuesCapacity(dataToBePacked, dataPointers, exceptionIndex, exceptionCount);

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

    if (realExcept !== exceptionCount) {
        throw new Error(`FastPFOR encode: exception count mismatch (got ${realExcept}, expected ${exceptionCount})`);
    }

    return byteContainerPos;
}

type EncodeState = { inPos: number; out: Int32Buf; outPos: number };

function packBlock(
    inValues: Int32Array,
    blockPos: number,
    bitWidth: number,
    state: EncodeState,
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
    state: EncodeState,
    byteContainerPos: number,
): void {
    const howManyInts = byteContainerPos / 4;
    state.out = ensureInt32Capacity(state.out, state.outPos + howManyInts);

    const byteContainer = ws.byteContainer;
    for (let i = 0; i < howManyInts; i++) {
        const base = i * 4;
        const v =
            byteContainer[base] |
            (byteContainer[base + 1] << 8) |
            (byteContainer[base + 2] << 16) |
            (byteContainer[base + 3] << 24) |
            0;
        state.out[state.outPos + i] = v;
    }

    state.outPos += howManyInts;
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
    state: EncodeState,
): void {
    const dataPointers = ws.dataPointers;
    const dataToBePacked = ws.dataToBePacked;

    const bitmap = computeExceptionBitmap(dataPointers);
    state.out = ensureInt32Capacity(state.out, state.outPos + 1);
    state.out[state.outPos++] = bitmap;

    for (let k = 2; k <= 32; k++) {
        const size = dataPointers[k];
        if (size !== 0) {
            state.out = ensureInt32Capacity(state.out, state.outPos + 1);
            state.out[state.outPos++] = size | 0;

            let j = 0;
            for (; j < size; j += 32) {
                state.out = ensureInt32Capacity(state.out, state.outPos + k);
                fastPack32(dataToBePacked[k], j, state.out, state.outPos, k);
                state.outPos += k;
            }

            const overflow = j - size;
            state.outPos -= ((overflow * k) >>> 5);
        }
    }
}

function encodePage(
    inValues: Int32Array,
    thisSize: number,
    state: EncodeState,
    ws: FastPforEncoderWorkspace,
): void {
    const headerPos = state.outPos;
    state.out = ensureInt32Capacity(state.out, headerPos + 1);
    state.outPos = (state.outPos + 1) | 0;

    const dataPointers = ws.dataPointers;
    dataPointers.fill(0);

    let byteContainerPos = 0;

    let tmpInPos = state.inPos;
    const finalInPos = tmpInPos + thisSize - BLOCK_SIZE;

    for (; tmpInPos <= finalInPos; tmpInPos += BLOCK_SIZE) {
        computeBestBitWidthPlan(inValues, tmpInPos, ws);

        const best = ws.best;
        const bitWidth = best[0];
        const exceptionCount = best[1];
        const maxBitWidth = best[2];

        const exceptionBitWidth = exceptionCount > 0 ? (maxBitWidth - bitWidth) : 0;
        if (exceptionCount > 0 && (exceptionBitWidth < 1 || exceptionBitWidth > 32)) {
            throw new Error(
                `FastPFOR encode: invalid exceptionBitWidth=${exceptionBitWidth} (bitWidth=${bitWidth}, maxBitWidth=${maxBitWidth})`,
            );
        }

        byteContainerPos = writeBlockHeader(ws, byteContainerPos, bitWidth, exceptionCount, maxBitWidth);
        byteContainerPos = recordBlockExceptions(
            ws,
            inValues,
            tmpInPos,
            bitWidth,
            exceptionCount,
            exceptionBitWidth,
            byteContainerPos,
        );

        packBlock(inValues, tmpInPos, bitWidth, state);
    }

    const pageEndOutPos = state.outPos;
    state.inPos = tmpInPos;
    state.out[headerPos] = (pageEndOutPos - headerPos) | 0;

    const byteSize = byteContainerPos;
    byteContainerPos = padByteContainerToInt32(ws, byteContainerPos);

    state.out = ensureInt32Capacity(state.out, state.outPos + 1);
    state.out[state.outPos++] = byteSize | 0;

    writeByteContainerInts(ws, state, byteContainerPos);

    writeExceptionStreams(ws, state);
}

function headlessEncode(
    inValues: Int32Array,
    inLength: number,
    state: EncodeState,
    ws: FastPforEncoderWorkspace,
): void {
    const alignedLength = greatestMultiple(inLength, BLOCK_SIZE);
    const finalInPos = state.inPos + alignedLength;

    while (state.inPos !== finalInPos) {
        const thisSize = Math.min(PAGE_SIZE, finalInPos - state.inPos);
        encodePage(inValues, thisSize, state, ws);
    }
}

function encode(
    inValues: Int32Array,
    inLength: number,
    state: EncodeState,
    ws: FastPforEncoderWorkspace,
): void {
    const alignedLength = greatestMultiple(inLength, BLOCK_SIZE);
    state.out = ensureInt32Capacity(state.out, state.outPos + 1);
    state.out[state.outPos++] = alignedLength;

    if (alignedLength === 0) return;
    headlessEncode(inValues, alignedLength, state, ws);
}

/**
 * VByte encoding for FastPFOR tail values (MSB=1 terminator).
 * Note: Inverts standard Protobuf Varint (MSB=0 terminator), so we cannot reuse generic methods.
 */
function encodeVByte(
    inValues: Int32Array,
    inLength: number,
    state: EncodeState,
    ws: FastPforEncoderWorkspace,
): void {
    if (inLength === 0) return;

    if (inLength > 255) {
        throw new Error(`encodeVByte: inLength=${inLength} exceeds expected max of 255`);
    }

    const requiredBytes = inLength * 5 + 3;
    ws.byteContainer = ensureUint8Capacity(ws.byteContainer, requiredBytes);

    const start = state.inPos;
    let bytePos = 0;
    for (let k = start; k < start + inLength; k++) {
        let v = inValues[k] >>> 0;
        while (v >= 0x80) {
            ws.byteContainer[bytePos++] = v & 0x7f;
            v >>>= 7;
        }
        ws.byteContainer[bytePos++] = (v | 0x80) & 0xff;
    }

    while ((bytePos & 3) !== 0) ws.byteContainer[bytePos++] = 0;

    const intsToWrite = bytePos / 4;
    state.out = ensureInt32Capacity(state.out, state.outPos + intsToWrite);

    let outIdx = state.outPos;
    for (let i = 0; i < bytePos; i += 4) {
        const v =
            ws.byteContainer[i] |
            (ws.byteContainer[i + 1] << 8) |
            (ws.byteContainer[i + 2] << 16) |
            (ws.byteContainer[i + 3] << 24) |
            0;
        state.out[outIdx++] = v;
    }

    state.outPos = outIdx;
    state.inPos = (state.inPos + inLength) | 0;
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
 * If `workspace` is omitted, a new workspace is created per call.
 */
export function encodeFastPforInt32WithWorkspace(
    values: Int32Array,
    workspace: FastPforEncoderWorkspace | undefined,
): Int32Buf {
    const ws = workspace ?? createFastPforEncoderWorkspace();
    const state: EncodeState = { inPos: 0, outPos: 0, out: new Int32Array(values.length + 1024) as Int32Buf };

    encode(values, values.length, state, ws);

    const remaining = values.length - state.inPos;
    encodeVByte(values, remaining, state, ws);

    return state.out.subarray(0, state.outPos);
}
