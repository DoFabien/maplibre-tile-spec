import { describe, it, expect } from "vitest";
import { ConstGpuVector, createConstGpuVector } from "./constGpuVector";
import { GEOMETRY_TYPE, SINGLE_PART_GEOMETRY_TYPE } from "./geometryType";
import { FlatSelectionVector } from "../filter/flatSelectionVector";
import type { TopologyVector } from "./topologyVector";

describe("ConstGpuVector", () => {
    describe("construction", () => {
        it("creates vector via factory", () => {
            const { triangleOffsets, indexBuffer, vertexBuffer } = createTriangleData();
            const topology = createPolygonTopology(3);

            const vector = createConstGpuVector(
                1,
                GEOMETRY_TYPE.POLYGON,
                triangleOffsets,
                indexBuffer,
                vertexBuffer,
                topology,
            );

            expect(vector).toBeInstanceOf(ConstGpuVector);
            expect(vector.numGeometries).toBe(1);
            expect(vector.geometryType(0)).toBe(GEOMETRY_TYPE.POLYGON);
            expect(vector.triangleOffsets).toBe(triangleOffsets);
            expect(vector.indexBuffer).toBe(indexBuffer);
            expect(vector.vertexBuffer).toBe(vertexBuffer);
            expect(vector.topologyVector).toBe(topology);
        });

        it("creates vector without topology", () => {
            const { triangleOffsets, indexBuffer, vertexBuffer } = createTriangleData();

            const vector = createConstGpuVector(1, GEOMETRY_TYPE.POLYGON, triangleOffsets, indexBuffer, vertexBuffer);

            expect(vector.topologyVector).toBeNull();
        });

        it("handles empty geometry", () => {
            expect(() =>
                createConstGpuVector(
                    0,
                    GEOMETRY_TYPE.POLYGON,
                    new Uint32Array([]),
                    new Int32Array([]),
                    new Int32Array([]),
                ),
            ).not.toThrow();
        });
    });

    it("geometryType returns constant type regardless of index", () => {
        const { triangleOffsets, indexBuffer, vertexBuffer } = createTriangleData();
        const vector = createConstGpuVector(5, GEOMETRY_TYPE.POLYGON, triangleOffsets, indexBuffer, vertexBuffer);

        expect(vector.geometryType(0)).toBe(GEOMETRY_TYPE.POLYGON);
        expect(vector.geometryType(999)).toBe(GEOMETRY_TYPE.POLYGON);
    });

    describe("getGeometries", () => {
        it("converts polygon to coordinate array", () => {
            const topology = createPolygonTopology(3);
            const vertexBuffer = new Int32Array([0, 0, 10, 0, 5, 10]); // triangle vertices
            const vector = createConstGpuVector(
                1,
                GEOMETRY_TYPE.POLYGON,
                new Uint32Array([0, 3]),
                new Int32Array([0, 1, 2]),
                vertexBuffer,
                topology,
            );

            const geometries = vector.getGeometries();

            expect(geometries).toHaveLength(1);
            expect(geometries[0]).toHaveLength(1); // 1 ring
            // Ring should be closed (4 points: 3 vertices + closing point)
            expect(geometries[0][0]).toHaveLength(4);
            expect(geometries[0][0][0]).toMatchObject({ x: 0, y: 0 });
            expect(geometries[0][0][1]).toMatchObject({ x: 10, y: 0 });
            expect(geometries[0][0][2]).toMatchObject({ x: 5, y: 10 });
            expect(geometries[0][0][3]).toMatchObject({ x: 0, y: 0 }); // closed
        });

        it("throws without topology vector", () => {
            const { triangleOffsets, indexBuffer, vertexBuffer } = createTriangleData();
            const vector = createConstGpuVector(1, GEOMETRY_TYPE.POLYGON, triangleOffsets, indexBuffer, vertexBuffer);

            expect(() => vector.getGeometries()).toThrow(
                "Cannot convert GpuVector to coordinates without topology information",
            );
        });
    });

    describe("filter", () => {
        it("returns full selection when type matches", () => {
            const { triangleOffsets, indexBuffer, vertexBuffer } = createTriangleData();
            const vector = createConstGpuVector(5, GEOMETRY_TYPE.POLYGON, triangleOffsets, indexBuffer, vertexBuffer);

            const selection = vector.filter(SINGLE_PART_GEOMETRY_TYPE.POLYGON);

            expect(selection.limit).toBe(5);
        });

        it("matches MULTIPOLYGON to POLYGON filter", () => {
            const { triangleOffsets, indexBuffer, vertexBuffer } = createTriangleData();
            const vector = createConstGpuVector(
                3,
                GEOMETRY_TYPE.MULTIPOLYGON,
                triangleOffsets,
                indexBuffer,
                vertexBuffer,
            );

            expect(vector.filter(SINGLE_PART_GEOMETRY_TYPE.POLYGON).limit).toBe(3);
        });

        it("returns empty selection when type does not match", () => {
            const { triangleOffsets, indexBuffer, vertexBuffer } = createTriangleData();
            const vector = createConstGpuVector(3, GEOMETRY_TYPE.POLYGON, triangleOffsets, indexBuffer, vertexBuffer);

            expect(vector.filter(SINGLE_PART_GEOMETRY_TYPE.POINT).limit).toBe(0);
        });
    });

    describe("filterSelected", () => {
        it("clears selection when type does not match", () => {
            const { triangleOffsets, indexBuffer, vertexBuffer } = createTriangleData();
            const vector = createConstGpuVector(4, GEOMETRY_TYPE.POLYGON, triangleOffsets, indexBuffer, vertexBuffer);
            const selection = new FlatSelectionVector(new Uint32Array([0, 1, 2, 3]));

            vector.filterSelected(SINGLE_PART_GEOMETRY_TYPE.POINT, selection);

            expect(selection.limit).toBe(0);
        });

        it("preserves selection when type matches", () => {
            const { triangleOffsets, indexBuffer, vertexBuffer } = createTriangleData();
            const vector = createConstGpuVector(4, GEOMETRY_TYPE.POLYGON, triangleOffsets, indexBuffer, vertexBuffer);
            const selection = new FlatSelectionVector(new Uint32Array([0, 1, 2, 3]));

            vector.filterSelected(SINGLE_PART_GEOMETRY_TYPE.POLYGON, selection);

            expect(selection.limit).toBe(4);
        });
    });

    it("containsSingleGeometryType always returns true", () => {
        const { triangleOffsets, indexBuffer, vertexBuffer } = createTriangleData();
        const vector = createConstGpuVector(1, GEOMETRY_TYPE.POLYGON, triangleOffsets, indexBuffer, vertexBuffer);

        expect(vector.containsSingleGeometryType()).toBe(true);
    });
});

// Helper to create a simple polygon topology (1 polygon, 1 ring, n vertices)
function createPolygonTopology(numVertices: number): TopologyVector {
    return topology(
        new Uint32Array([0, 1]), // 1 geometry
        new Uint32Array([0, 1]), // 1 part (ring)
        new Uint32Array([0, numVertices]), // vertices in ring
    );
}

// Helper to create triangle data for a simple triangle
function createTriangleData() {
    return {
        triangleOffsets: new Uint32Array([0, 3]), // 1 triangle (3 indices)
        indexBuffer: new Int32Array([0, 1, 2]), // triangle indices
        vertexBuffer: new Int32Array([0, 0, 10, 0, 5, 10]), // 3 vertices: (0,0), (10,0), (5,10)
    };
}

function topology(
    geometryOffsets?: Uint32Array | null,
    partOffsets?: Uint32Array | null,
    ringOffsets?: Uint32Array | null,
): TopologyVector {
    return {
        geometryOffsets: geometryOffsets ?? undefined,
        partOffsets: partOffsets ?? undefined,
        ringOffsets: ringOffsets ?? undefined,
    };
}
