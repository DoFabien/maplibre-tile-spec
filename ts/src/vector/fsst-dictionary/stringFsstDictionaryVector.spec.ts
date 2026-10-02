import { describe, it, expect, beforeEach, vi } from "vitest";
import BitVector from "../flat/bitVector";
import type * as decodingUtils from "../../decoding/decodingUtils";
import { decodeString } from "../../decoding/decodingUtils";

vi.mock("../../decoding/decodingUtils", async (importOriginal) => {
    const original = await importOriginal<typeof decodingUtils>();
    return { ...original, decodeString: vi.fn(original.decodeString) };
});
import { StringFsstDictionaryVector, createStringFsstDictionaryVector } from "./stringFsstDictionaryVector";

describe("StringFsstDictionaryVector", () => {
    let indexBuffer: Uint32Array;
    let offsetBuffer: Uint32Array;
    let dictionaryBuffer: Uint8Array;
    let symbolOffsetBuffer: Uint32Array;
    let symbolTableBuffer: Uint8Array;
    let nullabilityBuffer: BitVector;

    beforeEach(() => {
        indexBuffer = new Uint32Array([0, 1, 2]);
        offsetBuffer = new Uint32Array([0, 5, 10]);
        dictionaryBuffer = new Uint8Array([
            /* mock data */
        ]);
        symbolOffsetBuffer = new Uint32Array([0, 3, 6]);
        symbolTableBuffer = new Uint8Array([
            /* mock data */
        ]);
        nullabilityBuffer = new BitVector(new Uint8Array([0b00000001]), 2);
    });

    it("should create an instance of StringFsstDictionaryVector", () => {
        const vector = new StringFsstDictionaryVector(
            "testVector",
            indexBuffer,
            offsetBuffer,
            dictionaryBuffer,
            symbolOffsetBuffer,
            symbolTableBuffer,
            nullabilityBuffer,
        );
        expect(vector).toBeInstanceOf(StringFsstDictionaryVector);
    });

    it("reads dictionary entries without a row, before any row is read", () => {
        const vector = createStringFsstDictionaryVector([null, "café", "", "café"], "name");

        expect(vector.dictionarySize).toBe(2);
        expect([0, 1].map((entry) => vector.getDictionaryValue(entry))).toEqual(["café", ""]);
        expect(vector.getValue(3)).toBe(vector.getDictionaryValue(vector.index[3]));
    });

    it("caches repeated UTF-8, empty, and nullable dictionary values", () => {
        const vector = createStringFsstDictionaryVector(["café", "", "café", null], "name");

        expect(vector.getValue(0)).toBe("café");
        expect(vector.getValue(1)).toBe("");
        expect(vector.getValue(3)).toBeNull();

        vi.mocked(decodeString).mockClear();
        expect(vector.getValue(2)).toBe("café");
        expect(vector.getValue(1)).toBe("");
        expect(decodeString).not.toHaveBeenCalled();
    });

    it("does not retain a decoded-string cache for excessive cardinality", () => {
        const dictionaryEntries = 65_537;
        const offsets = new Uint32Array(dictionaryEntries + 1);
        offsets.fill(1, 1);
        const vector = new StringFsstDictionaryVector(
            "bounded",
            Uint32Array.of(0),
            offsets,
            Uint8Array.of(255, "a".charCodeAt(0)),
            Uint32Array.of(0),
            new Uint8Array(),
            undefined,
        );

        vi.mocked(decodeString).mockClear();
        expect(vector.getValue(0)).toBe("a");
        expect(vector.getValue(0)).toBe("a");
        expect(decodeString).toHaveBeenCalledTimes(2);
    });

    it("does not retain a decoded-string cache for an excessive decoded byte budget", () => {
        const decodedBytes = 1024 * 1024 + 1;
        const symbolTable = new Uint8Array(decodedBytes);
        symbolTable.fill("a".charCodeAt(0));
        const vector = new StringFsstDictionaryVector(
            "bounded-bytes",
            Uint32Array.of(0),
            Uint32Array.of(0, decodedBytes),
            Uint8Array.of(0),
            Uint32Array.of(0, decodedBytes),
            symbolTable,
            undefined,
        );

        vi.mocked(decodeString).mockClear();
        expect(vector.getValue(0)?.charCodeAt(0)).toBe("a".charCodeAt(0));
        expect(vector.getValue(0)?.charCodeAt(0)).toBe("a".charCodeAt(0));
        expect(decodeString).toHaveBeenCalledTimes(2);
    });
});
