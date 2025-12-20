import { describe, expect, it } from "vitest";

import { PhysicalLevelTechnique } from "../metadata/tile/physicalLevelTechnique";
import { PhysicalStreamType } from "../metadata/tile/physicalStreamType";
import { decodeStreamMetadata } from "../metadata/tile/streamMetadataDecoder";
import { LogicalStreamType } from "../metadata/tile/logicalStreamType";
import { LengthType } from "../metadata/tile/lengthType";
import { encodeVarintInt32 } from "../encoding/integerEncodingUtils";
import { createStream } from "./decodingTestUtils";
import { decodeLengthStreamToOffsetBuffer } from "./integerStreamDecoder";
import IntWrapper from "./intWrapper";

/**
 * Encodes an array of length values into a MLT LENGTH stream using VARINT technique.
 * @param values Array of individual length values to encode
 * @returns Encoded stream as Uint8Array containing metadata and encoded data
 */
function encodeLengthStream(values: number[]): Uint8Array {
    return createStream(PhysicalStreamType.LENGTH, encodeVarintInt32(new Int32Array(values)), {
        logical: new LogicalStreamType(undefined, undefined, LengthType.VAR_BINARY),
        technique: PhysicalLevelTechnique.VARINT,
        count: values.length,
    });
}

/**
 * Converts an array of lengths to cumulative offsets.
 * The output array has one more element than the input, starting at 0.
 * 
 * @example
 * toOffsets([2, 3, 1]) returns [0, 2, 5, 6]
 * 
 * @param values Array of length values (non-negative integers)
 * @returns Array of cumulative offsets (one more element than input)
 */
function toOffsets(values: number[]): number[] {
    const offsets = new Array(values.length + 1);
    offsets[0] = 0;
    for (let i = 0; i < values.length; i++) {
        offsets[i + 1] = offsets[i] + values[i];
    }
    return offsets;
}

/**
 * Performs a round-trip encoding and decoding of length values.
 * Encodes the values into a LENGTH stream, then decodes them back to verify correctness.
 * 
 * @param values Array of length values to test
 * @returns Object containing decoded offsets, final offset position, stream length, and expected data end position
 */
function roundTripLengthStream(values: number[]): {
    decodedOffsets: Int32Array;
    offset: number;
    streamLength: number;
    expectedDataEnd: number;
} {
    const stream = encodeLengthStream(values);
    const offset = new IntWrapper(0);
    const metadata = decodeStreamMetadata(stream, offset);

    const streamDataStart = offset.get();
    const decodedOffsets = decodeLengthStreamToOffsetBuffer(stream, offset, metadata);

    return {
        decodedOffsets,
        offset: offset.get(),
        streamLength: stream.length,
        expectedDataEnd: streamDataStart + metadata.byteLength,
    };
}

describe("length stream round-trip", () => {
    it("round-trips standard lengths", () => {
        const values = [10, 5, 20];

        const { decodedOffsets, offset, streamLength, expectedDataEnd } = roundTripLengthStream(values);

        expect(Array.from(decodedOffsets)).toEqual(toOffsets(values));
        expect(offset).toBe(expectedDataEnd);
        expect(offset).toBe(streamLength);
    });

    it("handles zero-length entries", () => {
        const values = [5, 0, 0, 3];

        const { decodedOffsets, offset, streamLength, expectedDataEnd } = roundTripLengthStream(values);

        expect(Array.from(decodedOffsets)).toEqual(toOffsets(values));
        expect(offset).toBe(expectedDataEnd);
        expect(offset).toBe(streamLength);
    });

    it("handles large values", () => {
        const values = [1000, 500];

        const { decodedOffsets, offset, streamLength, expectedDataEnd } = roundTripLengthStream(values);

        expect(Array.from(decodedOffsets)).toEqual(toOffsets(values));
        expect(offset).toBe(expectedDataEnd);
        expect(offset).toBe(streamLength);
    });

    it("handles empty lengths", () => {
        const values: number[] = [];

        const { decodedOffsets, offset, streamLength, expectedDataEnd } = roundTripLengthStream(values);

        expect(Array.from(decodedOffsets)).toEqual(toOffsets(values));
        expect(offset).toBe(expectedDataEnd);
        expect(offset).toBe(streamLength);
    });

    it("handles max int values", () => {
        const values = [2147483647];

        const { decodedOffsets, offset, streamLength, expectedDataEnd } = roundTripLengthStream(values);

        expect(Array.from(decodedOffsets)).toEqual(toOffsets(values));
        expect(offset).toBe(expectedDataEnd);
        expect(offset).toBe(streamLength);
    });

    it("handles mixed sequence with zeros and large values", () => {
        const values = [100, 0, 500, 0, 25];

        const { decodedOffsets, offset, streamLength, expectedDataEnd } = roundTripLengthStream(values);

        expect(Array.from(decodedOffsets)).toEqual(toOffsets(values));
        expect(offset).toBe(expectedDataEnd);
        expect(offset).toBe(streamLength);
    });

    it("handles single element", () => {
        const values = [42];

        const { decodedOffsets, offset, streamLength, expectedDataEnd } = roundTripLengthStream(values);

        expect(Array.from(decodedOffsets)).toEqual(toOffsets(values));
        expect(offset).toBe(expectedDataEnd);
        expect(offset).toBe(streamLength);
    });
});
