import { describe, it, expect } from "vitest";
import { VertexBufferType } from "./vertexBufferType";
import type { MortonSettings } from "./geometryVector";
import {
    createFlatGeometryVector,
    createFlatGeometryVectorMortonEncoded,
    FlatGeometryVector,
} from "./flatGeometryVector";
import { GEOMETRY_TYPE, SINGLE_PART_GEOMETRY_TYPE } from "./geometryType";
import TopologyVector from "./topologyVector";
import { encodeZOrderCurve } from "../../encoding/zOrderCurveEncoder";
import { FlatSelectionVector } from "../filter/flatSelectionVector";

describe("FlatGeometryVector", () => {
    const mortonSettings: MortonSettings = { numBits: 15, coordinateShift: 0 };

    it("creates VEC_2 vector via factory", () => {
        const geometryTypes = new Int32Array([GEOMETRY_TYPE.POINT, GEOMETRY_TYPE.LINESTRING]);
        const vector = createFlatGeometryVector(
            geometryTypes,
            createSimpleTopology(2),
            new Int32Array([]),
            createVertexBuffer(2),
        );

        expect(vector).toBeInstanceOf(FlatGeometryVector);
        expect(vector.numGeometries).toBe(2);
        expect(vector.vertexBufferType).toBe(VertexBufferType.VEC_2);
        expect(vector.mortonSettings).toBeUndefined();
    });

    it("creates MORTON vector via factory", () => {
        const geometryTypes = new Int32Array([GEOMETRY_TYPE.POINT]);
        const vertexBuffer = new Int32Array([encodeZOrderCurve(10, 20, 15, 0)]);
        const vector = createFlatGeometryVectorMortonEncoded(
            geometryTypes,
            createSimpleTopology(1),
            createVertexOffsets(1),
            vertexBuffer,
            mortonSettings,
        );

        expect(vector.vertexBufferType).toBe(VertexBufferType.MORTON);
        expect(vector.mortonSettings).toBe(mortonSettings);
    });

    it("handles empty geometry", () => {
        const emptyTopology = createSimpleTopology(0);
        const vector = createFlatGeometryVector(
            new Int32Array([]),
            emptyTopology,
            new Int32Array([]),
            new Int32Array([]),
        );

        expect(vector.numGeometries).toBe(0);
        expect(vector.containsSingleGeometryType()).toBe(false);
    });

    it("geometryType returns type at specified index", () => {
        const geometryTypes = new Int32Array([GEOMETRY_TYPE.POINT, GEOMETRY_TYPE.LINESTRING, GEOMETRY_TYPE.POLYGON]);
        const vector = createFlatGeometryVector(
            geometryTypes,
            createSimpleTopology(3),
            new Int32Array([]),
            createVertexBuffer(3),
        );

        expect(vector.geometryType(0)).toBe(GEOMETRY_TYPE.POINT);
        expect(vector.geometryType(1)).toBe(GEOMETRY_TYPE.LINESTRING);
        expect(vector.geometryType(2)).toBe(GEOMETRY_TYPE.POLYGON);
    });

    it("getVertex delegates to utility", () => {
        const vector = createFlatGeometryVector(
            new Int32Array([GEOMETRY_TYPE.POINT]),
            createSimpleTopology(1),
            createVertexOffsets(1),
            new Int32Array([10, 20]),
        );

        expect(vector.getVertex(0)).toEqual([10, 20]);
    });

    it("getSimpleEncodedVertex delegates to utility", () => {
        const vector = createFlatGeometryVector(
            new Int32Array([GEOMETRY_TYPE.POINT]),
            createSimpleTopology(1),
            createVertexOffsets(1),
            new Int32Array([10, 20]),
        );

        expect(vector.getSimpleEncodedVertex(0)).toEqual([10, 20]);
    });

    it("getGeometries delegates to converter", () => {
        const vector = createFlatGeometryVector(
            new Int32Array([GEOMETRY_TYPE.POINT]),
            createSimpleTopology(1),
            new Int32Array([]),
            new Int32Array([10, 20]),
        );

        expect(vector.getGeometries()).toHaveLength(1);
    });

    it("filter delegates to utility", () => {
        const vector = createFlatGeometryVector(
            new Int32Array([GEOMETRY_TYPE.POINT]),
            createSimpleTopology(1),
            new Int32Array([]),
            createVertexBuffer(1),
        );

        expect(vector.filter(SINGLE_PART_GEOMETRY_TYPE.POINT).limit).toBe(1);
    });

    it("filterSelected delegates to utility", () => {
        const vector = createFlatGeometryVector(
            new Int32Array([GEOMETRY_TYPE.POINT]),
            createSimpleTopology(1),
            new Int32Array([]),
            createVertexBuffer(1),
        );
        const selection = new FlatSelectionVector(new Uint32Array([0]));

        vector.filterSelected(SINGLE_PART_GEOMETRY_TYPE.POINT, selection);

        expect(selection.limit).toBe(1);
    });

    it("containsSingleGeometryType always returns false", () => {
        const vector = createFlatGeometryVector(
            new Int32Array([GEOMETRY_TYPE.POINT]),
            createSimpleTopology(1),
            new Int32Array([]),
            createVertexBuffer(1),
        );

        expect(vector.containsSingleGeometryType()).toBe(false);
    });
});

function createSimpleTopology(numGeometries: number): TopologyVector {
    const offsets = new Uint32Array(numGeometries + 1);
    for (let i = 0; i <= numGeometries; i++) offsets[i] = i;
    return new TopologyVector(offsets, offsets, offsets);
}

function createVertexBuffer(numVertices: number): Int32Array {
    const buffer = new Int32Array(numVertices * 2);
    for (let i = 0; i < numVertices; i++) {
        buffer[i * 2] = 10 * (i + 1);
        buffer[i * 2 + 1] = 20 * (i + 1);
    }
    return buffer;
}

function createVertexOffsets(numVertices: number): Int32Array {
    const offsets = new Int32Array(numVertices);
    for (let i = 0; i < numVertices; i++) offsets[i] = i;
    return offsets;
}
