import { describe, expect, it } from "vitest";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import IntWrapper from "./intWrapper";
import { encodeBigEndianInt32s } from "../encoding/bigEndianEncode";
import { decodeFastPforInt32 } from "./fastPforDecoder";
import { decodeFastPfor } from "./integerDecodingUtils";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(__dirname, "../../../test/fixtures/fastpfor");

function loadBigEndianInt32Fixture(name: string): Int32Array {
    const filepath = path.join(FIXTURES_DIR, name);
    if (!fs.existsSync(filepath)) {
        throw new Error(`Missing FastPFOR fixture: ${filepath}`);
    }

    const buffer = fs.readFileSync(filepath);
    const values = new Int32Array(buffer.length / 4);
    for (let i = 0; i < values.length; i++) {
        values[i] = buffer.readInt32BE(i * 4);
    }
    return values;
}

describe("FastPFOR Integration: C++ encoded -> TS decoded", () => {
    const fixtureVectorIndices = [1, 2, 3, 4];

    for (const vectorIndex of fixtureVectorIndices) {
        it(`decodes C++ vector${vectorIndex}_encoded -> vector${vectorIndex}_decoded`, () => {
            const encodedWords = loadBigEndianInt32Fixture(`vector${vectorIndex}_encoded.bin`);
            const expectedValues = loadBigEndianInt32Fixture(`vector${vectorIndex}_decoded.bin`);

            const decoded = decodeFastPforInt32(encodedWords, expectedValues.length);
            expect(decoded).toEqual(expectedValues);

            const encodedBytes = encodeBigEndianInt32s(encodedWords);
            const offset = new IntWrapper(0);
            const decodedFromBytes = decodeFastPfor(encodedBytes, expectedValues.length, encodedBytes.length, offset);
            expect(decodedFromBytes).toEqual(expectedValues);
            expect(offset.get()).toBe(encodedBytes.length);
        });
    }
});
