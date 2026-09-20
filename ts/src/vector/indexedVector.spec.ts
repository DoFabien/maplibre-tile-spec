import { expect, it, vi } from "vitest";
import { IndexedVector } from "./indexedVector";
import BitVector from "./flat/bitVector";
import { Int32FlatVector } from "./flat/int32FlatVector";
import { Int64FlatVector } from "./flat/int64FlatVector";
import { FloatFlatVector } from "./flat/floatFlatVector";
import { BooleanFlatVector } from "./flat/booleanFlatVector";
import { createNullableStringVector } from "./flat/stringFlatVector";
import { createStringDictionaryVector } from "./dictionary/stringDictionaryVector";
import { createStringFsstDictionaryVector } from "./fsst-dictionary/stringFsstDictionaryVector";

it("shares source columns and row indices without reading values, including nullable and nested selections", () => {
    const present = new BitVector(new Uint8Array([0b1101]), 4);
    const sources = [
        new Int32FlatVector("int", new Int32Array([1, 0, 3, 4]), present),
        new Int64FlatVector("id", new BigInt64Array([9007199254740993n, 0n, -8n, 12n]), present),
        new FloatFlatVector("float", new Float32Array([1.5, 0, -2.5, 3.5]), present),
        new BooleanFlatVector("bool", new BitVector(new Uint8Array([0b1001]), 4), present),
        createNullableStringVector(["é", null, "", "😀"], "flat"),
        createStringDictionaryVector(["é", null, "", "😀"], "dictionary"),
        createStringFsstDictionaryVector(["é", null, "", "😀"], "fsst"),
    ];
    const indices = new Uint32Array([3, 1, 3, 0]);
    for (const source of sources) {
        const read = vi.spyOn(source, "getValue");
        const view = new IndexedVector(source, indices);
        expect(read).not.toHaveBeenCalled();
        expect(view.source).toBe(source);
        expect(view.data).toBe(indices);
        expect(view.size).toBe(4);
        expect(view.name).toBe(source.name);
        expect(Array.from(indices, (_, row) => view.has(row))).toEqual([true, false, true, true]);
        expect(Array.from(indices, (_, row) => view.getValue(row))).toEqual(Array.from(indices, row => source.getValue(row)));
        const nested = new IndexedVector(view, new Uint32Array([1, 2, 0]));
        expect(nested.getValue(0)).toBeNull();
        expect(nested.has(0)).toBe(false);
        expect(nested.getValue(1)).toBe(source.getValue(3));
        expect(nested.getValue(2)).toBe(source.getValue(3));
        expect(new IndexedVector(source, new Uint32Array()).size).toBe(0);
        read.mockRestore();
    }
});
