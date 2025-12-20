import { describe, expect, it } from "vitest";

import { DictionaryType } from "../metadata/tile/dictionaryType";
import { LogicalLevelTechnique } from "../metadata/tile/logicalLevelTechnique";
import { LogicalStreamType } from "../metadata/tile/logicalStreamType";
import { PhysicalLevelTechnique } from "../metadata/tile/physicalLevelTechnique";
import { PhysicalStreamType } from "../metadata/tile/physicalStreamType";
import {
    decodeStreamMetadata,
    type MortonEncodedStreamMetadata,
    type StreamMetadata,
} from "../metadata/tile/streamMetadataDecoder";
import { encodeIntStream } from "../encoding/integerStreamEncoder";
import { encodeVarintInt32 } from "../encoding/integerEncodingUtils";
import { buildEncodedStream, concatenateBuffers, encodeStreamMetadata } from "./decodingTestUtils";
import { decodeIntStream } from "./integerStreamDecoder";
import IntWrapper from "./intWrapper";

function createGeometryStreamMetadata(numValues: number): StreamMetadata {
    return {
        physicalStreamType: PhysicalStreamType.DATA,
        logicalStreamType: new LogicalStreamType(DictionaryType.VERTEX),
        logicalLevelTechnique1: LogicalLevelTechnique.DELTA,
        logicalLevelTechnique2: LogicalLevelTechnique.NONE,
        physicalLevelTechnique: PhysicalLevelTechnique.VARINT,
        numValues,
        byteLength: 0,
        decompressedCount: numValues,
    };
}

function createMortonGeometryStreamMetadata(numValues: number): StreamMetadata {
    return {
        physicalStreamType: PhysicalStreamType.DATA,
        logicalStreamType: new LogicalStreamType(DictionaryType.MORTON),
        logicalLevelTechnique1: LogicalLevelTechnique.MORTON,
        logicalLevelTechnique2: LogicalLevelTechnique.NONE,
        physicalLevelTechnique: PhysicalLevelTechnique.VARINT,
        numValues,
        byteLength: 0,
        decompressedCount: numValues,
    };
}

function encodeGeometryStream(values: number[]): Uint8Array {
    const metadata = createGeometryStreamMetadata(values.length);
    const encoded = encodeIntStream(new Int32Array(values), metadata, true);
    return buildEncodedStream(metadata, encoded);
}

function encodeMortonGeometryStream(values: number[], numBits: number, coordinateShift: number): Uint8Array {
    const metadata = createMortonGeometryStreamMetadata(values.length);
    const encoded = encodeIntStream(new Int32Array(values), metadata, false);
    const metadataBuffer = encodeStreamMetadata({ ...metadata, byteLength: encoded.length });
    const mortonInfo = encodeVarintInt32(new Int32Array([numBits, coordinateShift]));
    return concatenateBuffers(metadataBuffer, mortonInfo, encoded);
}

function roundTripGeometryStream(values: number[]): {
    decodedValues: Int32Array;
    offset: number;
    streamLength: number;
    expectedDataEnd: number;
} {
    const stream = encodeGeometryStream(values);
    const offset = new IntWrapper(0);
    const metadata = decodeStreamMetadata(stream, offset);

    const streamDataStart = offset.get();
    const decodedValues = decodeIntStream(stream, offset, metadata, true);

    return {
        decodedValues,
        offset: offset.get(),
        streamLength: stream.length,
        expectedDataEnd: streamDataStart + metadata.byteLength,
    };
}

describe("geometry stream round-trip", () => {
    it("round-trips a simple path", () => {
        const values = [0, 10, 10, 20];

        const { decodedValues, offset, streamLength, expectedDataEnd } = roundTripGeometryStream(values);

        expect(Array.from(decodedValues)).toEqual(values);
        expect(offset).toBe(expectedDataEnd);
        expect(offset).toBe(streamLength);
    });

    it("round-trips negative coordinates", () => {
        const values = [0, -1, -50, 100];

        const { decodedValues, offset, streamLength, expectedDataEnd } = roundTripGeometryStream(values);

        expect(Array.from(decodedValues)).toEqual(values);
        expect(offset).toBe(expectedDataEnd);
        expect(offset).toBe(streamLength);
    });

    it("round-trips large coordinate deltas", () => {
        const values = [100000, -200000];

        const { decodedValues, offset, streamLength, expectedDataEnd } = roundTripGeometryStream(values);

        expect(Array.from(decodedValues)).toEqual(values);
        expect(offset).toBe(expectedDataEnd);
        expect(offset).toBe(streamLength);
    });

    it("round-trips morton-encoded coordinates", () => {
        const values = [0, 3, 10, 25];
        const numBits = 16;
        const coordinateShift = 0;

        const stream = encodeMortonGeometryStream(values, numBits, coordinateShift);
        const offset = new IntWrapper(0);
        const metadata = decodeStreamMetadata(stream, offset) as MortonEncodedStreamMetadata;

        const streamDataStart = offset.get();
        const decodedValues = decodeIntStream(stream, offset, metadata, false);

        expect(metadata.numBits).toBe(numBits);
        expect(metadata.coordinateShift).toBe(coordinateShift);
        expect(Array.from(decodedValues)).toEqual(values);
        expect(offset.get()).toBe(streamDataStart + metadata.byteLength);
        expect(offset.get()).toBe(stream.length);
    });

    it("decodes consecutive geometry streams without leaking state", () => {
        const first = [0, 10, 20];
        const second = [5, -5, 15];

        const stream1 = encodeGeometryStream(first);
        const stream2 = encodeGeometryStream(second);
        const combined = concatenateBuffers(stream1, stream2);
        const offset = new IntWrapper(0);

        const meta1 = decodeStreamMetadata(combined, offset);
        const start1 = offset.get();
        const decoded1 = decodeIntStream(combined, offset, meta1, true);
        expect(Array.from(decoded1)).toEqual(first);
        expect(offset.get()).toBe(start1 + meta1.byteLength);

        const meta2 = decodeStreamMetadata(combined, offset);
        const start2 = offset.get();
        const decoded2 = decodeIntStream(combined, offset, meta2, true);
        expect(Array.from(decoded2)).toEqual(second);
        expect(offset.get()).toBe(start2 + meta2.byteLength);
        expect(offset.get()).toBe(combined.length);
    });
});
