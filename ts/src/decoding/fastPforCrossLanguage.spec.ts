/**
 * Cross-Language Integration Tests for FastPFOR
 *
 * These tests validate that the TypeScript decoder produces results compatible
 * with the C++ reference implementation by loading pre-generated binary fixtures.
 */

import { describe, expect, it } from "vitest";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import IntWrapper from "./intWrapper";
import { int32sToBigEndianBytes } from "./byteIO";
import { decodeFastPforInt32 } from "./fastPforDecoder";
import { decodeFastPfor } from "./integerDecodingUtils";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(__dirname, "../../../test/fixtures/fastpfor");

function loadBinaryFixture(name: string): Int32Array {
    const filepath = path.join(FIXTURES_DIR, name);
    const buffer = fs.readFileSync(filepath);
    const values = new Int32Array(buffer.length / 4);
    for (let i = 0; i < values.length; i++) {
        values[i] = buffer.readInt32BE(i * 4);
    }
    return values;
}

function discoverFixtureVectors(): number[] {
    if (!fs.existsSync(FIXTURES_DIR)) return [];
    return fs
        .readdirSync(FIXTURES_DIR)
        .map((f) => f.match(/^vector(\d+)_compressed\.bin$/)?.[1])
        .filter((v): v is string => v !== undefined)
        .map((v) => parseInt(v, 10))
        .sort((a, b) => a - b);
}

describe("FastPFOR Integration: C++ encoded → TS decoded", () => {
    const vectorIndices = discoverFixtureVectors();

    it("has at least one fixture vector", () => {
        expect(vectorIndices.length).toBeGreaterThan(0);
    });

    for (const idx of vectorIndices) {
        it(`decodes C++ vector${idx}_compressed → vector${idx}_uncompressed`, () => {
            const encoded = loadBinaryFixture(`vector${idx}_compressed.bin`);
            const expected = loadBinaryFixture(`vector${idx}_uncompressed.bin`);

            const decoded = decodeFastPforInt32(encoded, expected.length);
            expect(decoded).toEqual(expected);

            const bytes = int32sToBigEndianBytes(encoded);
            const offset = new IntWrapper(0);
            const decodedFromBytes = decodeFastPfor(bytes, expected.length, bytes.length, offset);
            expect(decodedFromBytes).toEqual(expected);
            expect(offset.get()).toBe(bytes.length);
        });
    }
});

