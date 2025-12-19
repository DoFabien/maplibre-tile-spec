import { describe, expect, it } from "vitest";

import { PhysicalLevelTechnique } from "../metadata/tile/physicalLevelTechnique";
import { PhysicalStreamType } from "../metadata/tile/physicalStreamType";
import { decodeStreamMetadata } from "../metadata/tile/streamMetadataDecoder";
import BitVector from "../vector/flat/bitVector";
import { encodeBooleanRle } from "../encoding/encodingUtils";
import { decodeBooleanRle } from "./decodingUtils";
import { concatenateBuffers, createStream } from "./decodingTestUtils";
import IntWrapper from "./intWrapper";

function encodePresentStream(values: boolean[]): Uint8Array {
    return createStream(PhysicalStreamType.PRESENT, encodeBooleanRle(values), {
        technique: PhysicalLevelTechnique.VARINT,
        count: values.length,
    });
}

function roundTripPresentStream(values: boolean[]): { decodedValues: boolean[]; offset: number; streamLength: number } {
    const stream = encodePresentStream(values);
    const offset = new IntWrapper(0);
    const metadata = decodeStreamMetadata(stream, offset);

    const streamDataStart = offset.get();
    const decodedBytes = decodeBooleanRle(stream, metadata.numValues, offset);

    // Advance to the end of the stream using metadata.byteLength, matching prod decoders.
    offset.set(streamDataStart + metadata.byteLength);

    const bitVector = new BitVector(decodedBytes, metadata.numValues);
    const decodedValues = Array.from({ length: metadata.numValues }, (_, i) => bitVector.get(i));

    return { decodedValues, offset: offset.get(), streamLength: stream.length };
}

describe("present stream round-trip", () => {
    it("round-trips a mixed presence mask", () => {
        const values = [true, false, true, true, false, false, true, false, true, false, true];

        const { decodedValues, offset, streamLength } = roundTripPresentStream(values);

        expect(decodedValues).toEqual(values);
        expect(offset).toBe(streamLength);
    });

    it("handles all-true and all-false sequences", () => {
        const count = 100;
        const cases = [new Array(count).fill(true), new Array(count).fill(false)];

        for (const values of cases) {
            const { decodedValues, offset, streamLength } = roundTripPresentStream(values);

            expect(decodedValues).toEqual(values);
            expect(offset).toBe(streamLength);
        }
    });

    it("handles large sequences", () => {
        const values = new Array(1000).fill(true);

        const { decodedValues, offset, streamLength } = roundTripPresentStream(values);

        expect(decodedValues).toEqual(values);
        expect(offset).toBe(streamLength);
    });

    it("correctly advances offset when followed by another stream", () => {
        const presentValues = [true, false, true, false];
        const dataBytes = new Uint8Array([42, 100, 255, 0]);

        // Create both streams
        const presentStream = encodePresentStream(presentValues);
        const dataStream = createStream(PhysicalStreamType.DATA, dataBytes, {
            technique: PhysicalLevelTechnique.NONE,
            count: dataBytes.length,
        });

        // Concatenate: present stream followed by data stream
        const combined = concatenateBuffers(presentStream, dataStream);
        const offset = new IntWrapper(0);

        // Decode first stream (present)
        const meta1 = decodeStreamMetadata(combined, offset);
        const start1 = offset.get();
        decodeBooleanRle(combined, meta1.numValues, offset);
        offset.set(start1 + meta1.byteLength);

        // Decode second stream (data)
        const meta2 = decodeStreamMetadata(combined, offset);
        const start2 = offset.get();
        const decodedData = combined.slice(start2, start2 + meta2.byteLength);
        offset.set(start2 + meta2.byteLength);

        // Verify offset consumed entire buffer
        expect(offset.get()).toBe(combined.length);
        // Verify data stream content is intact
        expect(Array.from(decodedData)).toEqual(Array.from(dataBytes));
    });
});
