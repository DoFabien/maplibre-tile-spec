import { describe, expect, it } from "vitest";

import { encodeFastPforInt32 } from "../encoding/fastPforEncoder";
import { decodeFastPforInt32 } from "./fastPforDecoder";
import { BLOCK_SIZE } from "./fastPforShared";

describe("FastPFOR decoder", () => {
    it("throws on invalid alignedLength (negative)", () => {
        expect(() => decodeFastPforInt32(new Int32Array([-1]), 0)).toThrow();
    });

    it("throws on invalid alignedLength (not multiple of 256)", () => {
        expect(() => decodeFastPforInt32(new Int32Array([1]), 0)).toThrow();
    });

    it("throws when alignedLength exceeds output length", () => {
        expect(() => decodeFastPforInt32(new Int32Array([BLOCK_SIZE]), 10)).toThrow();
    });

    it("round-trips empty", () => {
        const values = new Int32Array(0);
        const encoded = encodeFastPforInt32(values);
        const decoded = decodeFastPforInt32(encoded, values.length);
        expect(decoded).toEqual(values);
    });

    it("round-trips VByte-only (<256 values)", () => {
        const values = new Int32Array(100);
        for (let i = 0; i < values.length; i++) values[i] = (i * 7) | 0;
        const encoded = encodeFastPforInt32(values);
        const decoded = decodeFastPforInt32(encoded, values.length);
        expect(decoded).toEqual(values);
    });

    it("round-trips exactly one block (256 values)", () => {
        const values = new Int32Array(BLOCK_SIZE);
        for (let i = 0; i < values.length; i++) values[i] = (i * 31) | 0;
        const encoded = encodeFastPforInt32(values);
        const decoded = decodeFastPforInt32(encoded, values.length);
        expect(decoded).toEqual(values);
    });

    it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 15, 16, 31])("round-trips %d-bit blocks", (bitWidth) => {
        const values = new Int32Array(BLOCK_SIZE);
        if (bitWidth !== 0) {
            const highBit = bitWidth === 31 ? 0x40000000 : 1 << (bitWidth - 1);
            const lowMask = (highBit - 1) >>> 0;
            for (let i = 0; i < values.length; i++) {
                values[i] = highBit | (i & lowMask) | 0;
            }
        }
        const encoded = encodeFastPforInt32(values);
        const decoded = decodeFastPforInt32(encoded, values.length);
        expect(decoded).toEqual(values);
    });

    it("round-trips blocks + VByte tail", () => {
        const values = new Int32Array(BLOCK_SIZE * 2 + 3);
        for (let i = 0; i < values.length; i++) values[i] = (i * 31) | 0;
        const encoded = encodeFastPforInt32(values);
        const decoded = decodeFastPforInt32(encoded, values.length);
        expect(decoded).toEqual(values);
    });

    it("round-trips values with outliers (exercise exceptions path)", () => {
        const values = new Int32Array(BLOCK_SIZE * 2);
        for (let i = 0; i < values.length; i++) values[i] = i & 0x0f;
        values[10] = 0x7fffffff;
        values[200] = 1 << 30;
        values[BLOCK_SIZE + 20] = 0x7fffffff;
        values[BLOCK_SIZE + 210] = 1 << 30;
        const encoded = encodeFastPforInt32(values);
        const decoded = decodeFastPforInt32(encoded, values.length);
        expect(decoded).toEqual(values);
    });

    it.each([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 32])(
        "round-trips exception streams (%d-bit)",
        (exceptionBitWidth) => {
            const values = new Int32Array(BLOCK_SIZE);
            if (exceptionBitWidth === 32) {
                values[0] = -1;
            } else {
                for (let i = 0; i < values.length; i++) values[i] = i & 1;
                const outlier = (1 << exceptionBitWidth) | 0;
                values[10] = outlier;
                values[100] = outlier;
            }
            const encoded = encodeFastPforInt32(values);
            const decoded = decodeFastPforInt32(encoded, values.length);
            expect(decoded).toEqual(values);
        },
    );
});

describe("FastPFOR decoder error cases", () => {
    function getSinglePageWordLayout(encodedWords: Int32Array) {
        const firstPageHeaderWordIndex = 1;
        const metadataOffsetWordCount = encodedWords[firstPageHeaderWordIndex] | 0;
        const packedDataEndWordIndex = (firstPageHeaderWordIndex + metadataOffsetWordCount) | 0;
        const metadataByteLength = encodedWords[packedDataEndWordIndex] >>> 0;
        const metadataWordCount = (metadataByteLength + 3) >>> 2;
        const byteContainerStartWordIndex = (packedDataEndWordIndex + 1) | 0;
        const exceptionBitmapWordIndex = (byteContainerStartWordIndex + metadataWordCount) | 0;
        return { packedDataEndWordIndex, byteContainerStartWordIndex, exceptionBitmapWordIndex };
    }

    it("throws on truncated input (missing page data)", () => {
        const values = new Int32Array(BLOCK_SIZE);
        for (let i = 0; i < values.length; i++) values[i] = (i * 31) | 0;
        const encoded = encodeFastPforInt32(values);
        const truncated = encoded.subarray(0, 5);
        expect(() => decodeFastPforInt32(truncated, values.length)).toThrow();
    });

    it("throws on invalid page metadata offset word count (whereMeta field)", () => {
        const values = new Int32Array(BLOCK_SIZE);
        for (let i = 0; i < values.length; i++) values[i] = (i * 3) | 0;
        const encoded = encodeFastPforInt32(values);
        const corruptedEncoded = encoded.slice();
        corruptedEncoded[1] = 0;

        expect(() => decodeFastPforInt32(corruptedEncoded, values.length)).toThrow(/invalid whereMeta/);
    });

    it("throws on invalid block bitWidth in byte container", () => {
        const values = new Int32Array(BLOCK_SIZE);
        for (let i = 0; i < values.length; i++) values[i] = (i * 7) | 0;
        const encoded = encodeFastPforInt32(values);
        const { byteContainerStartWordIndex } = getSinglePageWordLayout(encoded);
        const corruptedEncoded = encoded.slice();
        const blockHeaderWord = corruptedEncoded[byteContainerStartWordIndex] >>> 0;
        corruptedEncoded[byteContainerStartWordIndex] = ((blockHeaderWord & 0xffffff00) | 33) | 0;

        expect(() => decodeFastPforInt32(corruptedEncoded, values.length)).toThrow(/invalid bitWidth/);
    });

    it("throws on invalid maxBits in exception metadata", () => {
        const values = new Int32Array(BLOCK_SIZE);
        for (let i = 0; i < values.length; i++) values[i] = i & 1;
        values[10] = 1 << 20;
        values[100] = 1 << 20;

        const encoded = encodeFastPforInt32(values);
        const { byteContainerStartWordIndex } = getSinglePageWordLayout(encoded);
        const corruptedEncoded = encoded.slice();
        const blockHeaderWord = corruptedEncoded[byteContainerStartWordIndex] >>> 0;
        const blockBitWidth = blockHeaderWord & 0xff;
        const exceptionCount = (blockHeaderWord >>> 8) & 0xff;
        expect(exceptionCount).toBeGreaterThan(0);

        const invalidMaxBits = (blockBitWidth - 1) & 0xff;
        corruptedEncoded[byteContainerStartWordIndex] = ((blockHeaderWord & 0xff00ffff) | (invalidMaxBits << 16)) | 0;

        expect(() => decodeFastPforInt32(corruptedEncoded, values.length)).toThrow(/invalid maxBits/);
    });

    it("throws on invalid byteSize pointing bitmap out of bounds", () => {
        const values = new Int32Array(BLOCK_SIZE);
        for (let i = 0; i < values.length; i++) values[i] = i;
        const encoded = encodeFastPforInt32(values);
        const { packedDataEndWordIndex } = getSinglePageWordLayout(encoded);
        const corruptedEncoded = encoded.slice();
        corruptedEncoded[packedDataEndWordIndex] = 0x7fffffff;

        expect(() => decodeFastPforInt32(corruptedEncoded, values.length)).toThrow(/invalid byteSize/);
    });

    it("throws on truncated exception stream header", () => {
        const values = new Int32Array(BLOCK_SIZE);
        for (let i = 0; i < values.length; i++) values[i] = (i * 11) | 0;
        const encoded = encodeFastPforInt32(values);
        const { exceptionBitmapWordIndex } = getSinglePageWordLayout(encoded);
        const corruptedEncoded = encoded.slice();
        corruptedEncoded[exceptionBitmapWordIndex] = corruptedEncoded[exceptionBitmapWordIndex] | (1 << 1);
        const truncatedEncoded = corruptedEncoded.subarray(0, exceptionBitmapWordIndex + 1);

        expect(() => decodeFastPforInt32(truncatedEncoded, values.length)).toThrow(/truncated exception stream header/);
    });

    it("throws on truncated exception stream payload", () => {
        const values = new Int32Array(BLOCK_SIZE);
        for (let i = 0; i < values.length; i++) values[i] = (i * 13) | 0;
        const encoded = encodeFastPforInt32(values);
        const { exceptionBitmapWordIndex } = getSinglePageWordLayout(encoded);

        const corruptedEncoded = new Int32Array(encoded.length + 1);
        corruptedEncoded.set(encoded);
        corruptedEncoded[exceptionBitmapWordIndex] = corruptedEncoded[exceptionBitmapWordIndex] | (1 << 1);
        corruptedEncoded[exceptionBitmapWordIndex + 1] = 1;

        expect(() => decodeFastPforInt32(corruptedEncoded, values.length)).toThrow(/truncated exception stream/);
    });

    it("throws on unterminated VByte value", () => {
        const encoded = new Int32Array([0, 0x7f7f7f7f, 0x0000007f]);
        expect(() => decodeFastPforInt32(encoded, 1)).toThrow(/unterminated value/);
    });

    it("throws when numValues exceeds decoded count", () => {
        const values = new Int32Array(100);
        for (let i = 0; i < values.length; i++) values[i] = i;
        const encoded = encodeFastPforInt32(values);
        expect(() => decodeFastPforInt32(encoded, 200)).toThrow();
    });
});
