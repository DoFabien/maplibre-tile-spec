import { describe, expect, it } from "vitest";

import IntWrapper from "../decoding/intWrapper";
import { decodeFastPfor } from "../decoding/integerDecodingUtils";
import { encodeFastPfor } from "./integerEncodingUtils";

describe("integerEncodingUtils", () => {
    describe("encodeFastPfor", () => {
        it("round-trips through decodeFastPfor", () => {
            const values = new Int32Array([0, 1, 2, 3, 5, 8, 13, 21]);
            const encoded = encodeFastPfor(values);

            const offset = new IntWrapper(0);
            const decoded = decodeFastPfor(encoded, values.length, encoded.length, offset);

            expect(decoded).toEqual(values);
            expect(offset.get()).toBe(encoded.length);
        });

        it("round-trips block-aligned and vbyte-tail lengths", () => {
            const values = new Int32Array(256 + 3);
            for (let i = 0; i < values.length; i++) {
                values[i] = (i * 7) | 0;
            }

            const encoded = encodeFastPfor(values);

            const offset = new IntWrapper(0);
            const decoded = decodeFastPfor(encoded, values.length, encoded.length, offset);

            expect(decoded).toEqual(values);
            expect(offset.get()).toBe(encoded.length);
        });
    });
});

