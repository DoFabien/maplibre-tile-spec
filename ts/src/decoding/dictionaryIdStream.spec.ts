import { describe, expect, it } from "vitest";

import { LogicalLevelTechnique } from "../metadata/tile/logicalLevelTechnique";
import { LogicalStreamType } from "../metadata/tile/logicalStreamType";
import { OffsetType } from "../metadata/tile/offsetType";
import { PhysicalLevelTechnique } from "../metadata/tile/physicalLevelTechnique";
import { PhysicalStreamType } from "../metadata/tile/physicalStreamType";
import { decodeStreamMetadata, type RleEncodedStreamMetadata } from "../metadata/tile/streamMetadataDecoder";
import { encodeUnsignedRleInt32, encodeVarintInt32 } from "../encoding/integerEncodingUtils";
import { buildEncodedStream } from "./decodingTestUtils";
import { decodeIntStream } from "./integerStreamDecoder";
import IntWrapper from "./intWrapper";

function encodeDictionaryIdStream(values: number[]): Uint8Array {
    const { data, runs } = encodeUnsignedRleInt32(new Int32Array(values));
    const encodedData = encodeVarintInt32(data);
    const metadata: RleEncodedStreamMetadata = {
        physicalStreamType: PhysicalStreamType.OFFSET,
        logicalStreamType: new LogicalStreamType(undefined, OffsetType.STRING),
        logicalLevelTechnique1: LogicalLevelTechnique.RLE,
        logicalLevelTechnique2: LogicalLevelTechnique.NONE,
        physicalLevelTechnique: PhysicalLevelTechnique.VARINT,
        numValues: data.length,
        byteLength: encodedData.length,
        decompressedCount: values.length,
        runs,
        numRleValues: values.length,
    };

    return buildEncodedStream(metadata, encodedData);
}

function roundTripDictionaryIdStream(values: number[]): {
    decodedValues: Int32Array;
    offset: number;
    streamLength: number;
    expectedDataEnd: number;
} {
    const stream = encodeDictionaryIdStream(values);
    const offset = new IntWrapper(0);
    const metadata = decodeStreamMetadata(stream, offset);

    const streamDataStart = offset.get();
    const decodedValues = decodeIntStream(stream, offset, metadata, false);

    return {
        decodedValues,
        offset: offset.get(),
        streamLength: stream.length,
        expectedDataEnd: streamDataStart + metadata.byteLength,
    };
}

describe("dictionary id stream round-trip", () => {
    it("round-trips mixed ids", () => {
        const values = [1, 2, 1, 3];

        const { decodedValues, offset, streamLength, expectedDataEnd } = roundTripDictionaryIdStream(values);

        expect(Array.from(decodedValues)).toEqual(values);
        expect(offset).toBe(expectedDataEnd);
        expect(offset).toBe(streamLength);
    });

    it("round-trips RLE-heavy ids", () => {
        const values = new Array(50).fill(5);

        const { decodedValues, offset, streamLength, expectedDataEnd } = roundTripDictionaryIdStream(values);

        expect(Array.from(decodedValues)).toEqual(values);
        expect(offset).toBe(expectedDataEnd);
        expect(offset).toBe(streamLength);
    });

    it("round-trips large ids", () => {
        const values = [10000, 20000];

        const { decodedValues, offset, streamLength, expectedDataEnd } = roundTripDictionaryIdStream(values);

        expect(Array.from(decodedValues)).toEqual(values);
        expect(offset).toBe(expectedDataEnd);
        expect(offset).toBe(streamLength);
    });
});
