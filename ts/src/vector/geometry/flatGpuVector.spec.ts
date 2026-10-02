import { describe, it, expect } from "vitest";
import { FlatGpuVector, createFlatGpuVector } from "./flatGpuVector";
import { GEOMETRY_TYPE, SINGLE_PART_GEOMETRY_TYPE } from "./geometryType";
import { FlatSelectionVector } from "../filter/flatSelectionVector";
import TopologyVector from "./topologyVector";

describe("FlatGpuVector", () => {
    it("creates vector via factory with all properties", () => {
        const geometryTypes = new Int32Array([GEOMETRY_TYPE.POLYGON, GEOMETRY_TYPE.POLYGON]);
        const { triangleOffsets, indexBuffer, vertexBuffer } = createTriangleData(2);
        const topology = createPolygonTopology(2, 3);

        const vector = createFlatGpuVector(geometryTypes, triangleOffsets, indexBuffer, vertexBuffer, topology);

        expect(vector).toBeInstanceOf(FlatGpuVector);
        expect(vector.numGeometries).toBe(2);
        expect(vector.triangleOffsets).toBe(triangleOffsets);
        expect(vector.indexBuffer).toBe(indexBuffer);
        expect(vector.vertexBuffer).toBe(vertexBuffer);
        expect(vector.topologyVector).toBe(topology);
    });

    it("creates vector without topology", () => {
        const { triangleOffsets, indexBuffer, vertexBuffer } = createTriangleData(1);
        const vector = createFlatGpuVector(
            new Int32Array([GEOMETRY_TYPE.POLYGON]),
            triangleOffsets,
            indexBuffer,
            vertexBuffer,
        );

        expect(vector.topologyVector).toBeFalsy();
    });

    it("handles empty geometry", () => {
        const vector = createFlatGpuVector(
            new Int32Array([]),
            new Uint32Array([]),
            new Int32Array([]),
            new Int32Array([]),
        );

        expect(vector.numGeometries).toBe(0);
    });

    it("geometryType returns type at specified index", () => {
        const geometryTypes = new Int32Array([GEOMETRY_TYPE.POLYGON, GEOMETRY_TYPE.MULTIPOLYGON]);
        const { triangleOffsets, indexBuffer, vertexBuffer } = createTriangleData(2);
        const vector = createFlatGpuVector(geometryTypes, triangleOffsets, indexBuffer, vertexBuffer);

        expect(vector.geometryType(0)).toBe(GEOMETRY_TYPE.POLYGON);
        expect(vector.geometryType(1)).toBe(GEOMETRY_TYPE.MULTIPOLYGON);
    });

    it("getGeometries delegates to utility", () => {
        const topology = createPolygonTopology(1, 3);
        const vector = createFlatGpuVector(
            new Int32Array([GEOMETRY_TYPE.POLYGON]),
            new Uint32Array([0, 3]),
            new Int32Array([0, 1, 2]),
            new Int32Array([0, 0, 10, 0, 5, 10]),
            topology,
        );

        expect(vector.getGeometries()).toHaveLength(1);
    });

    it("getGeometries throws without topology", () => {
        const { triangleOffsets, indexBuffer, vertexBuffer } = createTriangleData(1);
        const vector = createFlatGpuVector(
            new Int32Array([GEOMETRY_TYPE.POLYGON]),
            triangleOffsets,
            indexBuffer,
            vertexBuffer,
        );

        expect(() => vector.getGeometries()).toThrow(
            "Cannot convert GpuVector to coordinates without topology information",
        );
    });

    it("filter delegates to utility", () => {
        const { triangleOffsets, indexBuffer, vertexBuffer } = createTriangleData(1);
        const vector = createFlatGpuVector(
            new Int32Array([GEOMETRY_TYPE.POLYGON]),
            triangleOffsets,
            indexBuffer,
            vertexBuffer,
        );

        expect(vector.filter(SINGLE_PART_GEOMETRY_TYPE.POLYGON).limit).toBe(1);
    });

    it("filterSelected delegates to utility", () => {
        const { triangleOffsets, indexBuffer, vertexBuffer } = createTriangleData(1);
        const vector = createFlatGpuVector(
            new Int32Array([GEOMETRY_TYPE.POLYGON]),
            triangleOffsets,
            indexBuffer,
            vertexBuffer,
        );
        const selection = new FlatSelectionVector(new Uint32Array([0]));

        vector.filterSelected(SINGLE_PART_GEOMETRY_TYPE.POLYGON, selection);

        expect(selection.limit).toBe(1);
    });

    it("containsSingleGeometryType always returns false", () => {
        const { triangleOffsets, indexBuffer, vertexBuffer } = createTriangleData(1);
        const vector = createFlatGpuVector(
            new Int32Array([GEOMETRY_TYPE.POLYGON]),
            triangleOffsets,
            indexBuffer,
            vertexBuffer,
        );

        expect(vector.containsSingleGeometryType()).toBe(false);
    });
});

function createPolygonTopology(numPolygons: number, verticesPerPolygon: number): TopologyVector {
    const geomOffsets = new Uint32Array(numPolygons + 1);
    const partOffsets = new Uint32Array(numPolygons + 1);
    const ringOffsets = new Uint32Array(numPolygons + 1);
    for (let i = 0; i <= numPolygons; i++) {
        geomOffsets[i] = i;
        partOffsets[i] = i;
        ringOffsets[i] = i * verticesPerPolygon;
    }
    return new TopologyVector(geomOffsets, partOffsets, ringOffsets);
}

function createTriangleData(numTriangles: number) {
    const triangleOffsets = new Uint32Array(numTriangles + 1);
    const indexBuffer = new Int32Array(numTriangles * 3);
    const vertexBuffer = new Int32Array(numTriangles * 6);

    for (let i = 0; i <= numTriangles; i++) {
        triangleOffsets[i] = i * 3;
    }
    for (let i = 0; i < numTriangles; i++) {
        const base = i * 3;
        indexBuffer[base] = base;
        indexBuffer[base + 1] = base + 1;
        indexBuffer[base + 2] = base + 2;
        const vBase = i * 6;
        vertexBuffer[vBase] = i * 10;
        vertexBuffer[vBase + 1] = 0;
        vertexBuffer[vBase + 2] = i * 10 + 10;
        vertexBuffer[vBase + 3] = 0;
        vertexBuffer[vBase + 4] = i * 10 + 5;
        vertexBuffer[vBase + 5] = 10;
    }
    return { triangleOffsets, indexBuffer, vertexBuffer };
}
