import { describe, expect, it } from "vitest";
import BitVector from "../flat/bitVector";
import { StringDictionaryVector } from "./stringDictionaryVector";

describe("StringDictionaryVector", () => {
    it("reads dictionary entries without a row, before any row is read", () => {
        const vector = createStringDictionaryVector([null, "café", "", "café"], "name");

        expect(vector.dictionarySize).toBe(2);
        expect([0, 1].map((entry) => vector.getDictionaryValue(entry))).toEqual(["café", ""]);
        expect(vector.getValue(3)).toBe(vector.getDictionaryValue(vector.index[3]));
    });

    it("caches repeated UTF-8, empty, and nullable dictionary values", () => {
        const vector = createStringDictionaryVector(["café", "", "café", null], "name");

        expect(vector.getValue(0)).toBe("café");
        expect(vector.getValue(1)).toBe("");
        expect(vector.getValue(3)).toBeNull();

        // Repeated logical values share a dictionary index. Mutating the
        // backing bytes proves that both the non-empty and empty values came
        // from the decoded-string cache on their second access.
        vector.data.fill("x".charCodeAt(0));
        expect(vector.getValue(2)).toBe("café");
        expect(vector.getValue(1)).toBe("");
    });

    it("does not retain a decoded-string cache for excessive cardinality", () => {
        const dictionaryEntries = 65_537;
        const offsets = new Uint32Array(dictionaryEntries + 1);
        offsets.fill(1, 1);
        const vector = new StringDictionaryVector(
            "bounded",
            Uint32Array.of(0),
            offsets,
            Uint8Array.of("a".charCodeAt(0)),
        );

        expect(vector.getValue(0)).toBe("a");
        vector.data[0] = "b".charCodeAt(0);
        expect(vector.getValue(0)).toBe("b");
    });

    it("does not retain a decoded-string cache for an excessive dictionary byte budget", () => {
        const dictionary = new Uint8Array(1024 * 1024 + 1);
        dictionary[0] = "a".charCodeAt(0);
        const vector = new StringDictionaryVector("bounded-bytes", Uint32Array.of(0), Uint32Array.of(0, 1), dictionary);

        expect(vector.getValue(0)).toBe("a");
        vector.data[0] = "b".charCodeAt(0);
        expect(vector.getValue(0)).toBe("b");
    });
});

function createStringDictionaryVector(values: (string | null)[], name: string): StringDictionaryVector {
    const encoder = new TextEncoder();
    const nonNullValues = values.filter((v): v is string => v !== null);
    const uniqueValues = Array.from(new Set(nonNullValues));
    const encodedDict = uniqueValues.map((value) => encoder.encode(value));

    const dictionarySize = encodedDict.reduce((sum, value) => sum + value.length, 0);
    const offsetBuffer = new Uint32Array(uniqueValues.length + 1);
    const dictionaryBuffer = new Uint8Array(dictionarySize);

    let currentOffset = 0;
    for (let i = 0; i < encodedDict.length; i++) {
        dictionaryBuffer.set(encodedDict[i], currentOffset);
        currentOffset += encodedDict[i].length;
        offsetBuffer[i + 1] = currentOffset;
    }

    const indexBuffer = new Uint32Array(values.length);
    const hasNulls = values.some((value) => value === null);
    const nullabilityBytes = hasNulls ? new Uint8Array(Math.ceil(values.length / 8)) : undefined;

    for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (value !== null) {
            indexBuffer[i] = uniqueValues.indexOf(value);
            if (nullabilityBytes) {
                nullabilityBytes[Math.floor(i / 8)] |= 1 << (i % 8);
            }
        }
    }

    const nullabilityBuffer = nullabilityBytes ? new BitVector(nullabilityBytes, values.length) : undefined;
    return new StringDictionaryVector(name, indexBuffer, offsetBuffer, dictionaryBuffer, nullabilityBuffer);
}
