import { describe, expect, it } from "vitest";
import { StringDictionaryVector, createStringDictionaryVector } from "./stringDictionaryVector";

describe("StringDictionaryVector", () => {
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
        expect(vector.decodedStringCount).toBe(2);
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
        expect(vector.decodedStringCount).toBe(2);
    });

    it("does not retain a decoded-string cache for an excessive dictionary byte budget", () => {
        const dictionary = new Uint8Array(1024 * 1024 + 1);
        dictionary[0] = "a".charCodeAt(0);
        const vector = new StringDictionaryVector("bounded-bytes", Uint32Array.of(0), Uint32Array.of(0, 1), dictionary);

        expect(vector.getValue(0)).toBe("a");
        vector.data[0] = "b".charCodeAt(0);
        expect(vector.getValue(0)).toBe("b");
        expect(vector.decodedStringCount).toBe(2);
    });
});
