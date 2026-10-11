import { describe, it, expect } from "vitest";
import { VertexBufferType } from "./vertexBufferType";
import type { MortonSettings } from "./geometryVector";
import type { TopologyVector } from "./topologyVector";
import { createConstGeometryVector, createMortonEncodedConstGeometryVector } from "./constGeometryVector";
import { GEOMETRY_TYPE, SINGLE_PART_GEOMETRY_TYPE } from "./geometryType";
import { FlatSelectionVector } from "../filter/flatSelectionVector";

describe("ConstGeometryVector", () => {
    const mortonSettings: MortonSettings = { numBits: 0, coordinateShift: 8 };

    describe("construction", () => {
        it("creates VEC_2 vector via factory", () => {
            const topology = createSimpleTopology(3);
            const vector = createConstGeometryVector(
                3,
                GEOMETRY_TYPE.POINT,
                topology,
                new Int32Array([]),
                createVertexBuffer(3),
            );

            expect(vector.numGeometries).toBe(3);
            expect(vector.geometryType(0)).toBe(GEOMETRY_TYPE.POINT);
            expect(vector.vertexBufferType).toBe(VertexBufferType.VEC_2);
            expect(vector.mortonSettings).toBeUndefined();
        });

        it("creates MORTON vector via factory", () => {
            const topology = createSimpleTopology(3);
            const vector = createMortonEncodedConstGeometryVector(
                3,
                GEOMETRY_TYPE.LINESTRING,
                topology,
                new Int32Array([]),
                createVertexBuffer(3),
                mortonSettings,
            );

            expect(vector.vertexBufferType).toBe(VertexBufferType.MORTON);
            expect(vector.mortonSettings).toBe(mortonSettings);
        });

        it("handles empty geometry", () => {
            const emptyTopology = createSimpleTopology(0);
            expect(() =>
                createConstGeometryVector(
                    0,
                    GEOMETRY_TYPE.POINT,
                    emptyTopology,
                    new Int32Array([]),
                    new Int32Array([]),
                ),
            ).not.toThrow();
        });
    });

    describe("vertex access", () => {
        it("getVertex returns [x, y] coordinates", () => {
            const vector = createConstGeometryVector(
                3,
                GEOMETRY_TYPE.POINT,
                createSimpleTopology(3),
                createVertexOffsets(3),
                createVertexBuffer(3),
            );

            expect(vector.getVertex(0)).toEqual([10, 20]);
            expect(vector.getVertex(1)).toEqual([20, 40]);
        });

        it("getSimpleEncodedVertex bypasses morton decoding", () => {
            const vector = createMortonEncodedConstGeometryVector(
                1,
                GEOMETRY_TYPE.POINT,
                createSimpleTopology(1),
                createVertexOffsets(1),
                new Int32Array([100, 200]),
                { numBits: 8, coordinateShift: 0 },
            );

            // getSimpleEncodedVertex returns raw values regardless of morton settings
            expect(vector.getSimpleEncodedVertex(0)).toEqual([100, 200]);
        });
    });

    describe("getGeometries", () => {
        it("returns point geometry as Point[][][]", () => {
            const vertexBuffer = new Int32Array([100, 200]);
            const vector = createConstGeometryVector(
                1,
                GEOMETRY_TYPE.POINT,
                createSimpleTopology(1),
                new Int32Array([]),
                vertexBuffer,
            );

            const geometries = vector.getGeometries();

            expect(geometries).toHaveLength(1);
            expect(geometries[0][0][0]).toMatchObject({ x: 100, y: 200 });
        });
    });

    describe("containsPolygonGeometry", () => {
        it.each([
            [GEOMETRY_TYPE.POLYGON, true],
            [GEOMETRY_TYPE.MULTIPOLYGON, true],
            [GEOMETRY_TYPE.POINT, false],
            [GEOMETRY_TYPE.LINESTRING, false],
        ])("returns %s for geometry type %i", (geometryType, expected) => {
            const vector = createConstGeometryVector(
                1,
                geometryType,
                createSimpleTopology(1),
                new Int32Array([]),
                createVertexBuffer(1),
            );
            expect(vector.containsPolygonGeometry()).toBe(expected);
        });
    });

    describe("filter", () => {
        it("returns full selection when type matches", () => {
            const vector = createConstGeometryVector(
                5,
                GEOMETRY_TYPE.POINT,
                createSimpleTopology(5),
                new Int32Array([]),
                createVertexBuffer(5),
            );

            const selection = vector.filter(SINGLE_PART_GEOMETRY_TYPE.POINT);

            expect(selection.limit).toBe(5);
        });

        it("matches MULTIPOINT to POINT filter", () => {
            const vector = createConstGeometryVector(
                3,
                GEOMETRY_TYPE.MULTIPOINT,
                createSimpleTopology(3),
                new Int32Array([]),
                createVertexBuffer(3),
            );

            expect(vector.filter(SINGLE_PART_GEOMETRY_TYPE.POINT).limit).toBe(3);
        });

        it("returns empty selection when type does not match", () => {
            const vector = createConstGeometryVector(
                3,
                GEOMETRY_TYPE.POLYGON,
                createSimpleTopology(3),
                new Int32Array([]),
                createVertexBuffer(3),
            );

            expect(vector.filter(SINGLE_PART_GEOMETRY_TYPE.POINT).limit).toBe(0);
        });
    });

    describe("filterSelected", () => {
        it("clears selection when type does not match", () => {
            const vector = createConstGeometryVector(
                4,
                GEOMETRY_TYPE.LINESTRING,
                createSimpleTopology(4),
                new Int32Array([]),
                createVertexBuffer(4),
            );
            const selection = new FlatSelectionVector(new Uint32Array([0, 1, 2, 3]));

            vector.filterSelected(SINGLE_PART_GEOMETRY_TYPE.POINT, selection);

            expect(selection.limit).toBe(0);
        });

        it("preserves selection when type matches", () => {
            const vector = createConstGeometryVector(
                4,
                GEOMETRY_TYPE.POINT,
                createSimpleTopology(4),
                new Int32Array([]),
                createVertexBuffer(4),
            );
            const selection = new FlatSelectionVector(new Uint32Array([0, 1, 2, 3]));

            vector.filterSelected(SINGLE_PART_GEOMETRY_TYPE.POINT, selection);

            expect(selection.limit).toBe(4);
        });
    });

    it("containsSingleGeometryType always returns true", () => {
        const vector = createConstGeometryVector(
            1,
            GEOMETRY_TYPE.POINT,
            createSimpleTopology(1),
            new Int32Array([]),
            createVertexBuffer(1),
        );
        expect(vector.containsSingleGeometryType()).toBe(true);
    });
});

// Helper to create a minimal topology for n geometries with 1 vertex each
function createSimpleTopology(numGeometries: number): TopologyVector {
    const offsets = new Uint32Array(numGeometries + 1);
    for (let i = 0; i <= numGeometries; i++) offsets[i] = i;
    return topology(offsets, offsets, offsets);
}

// Helper to create identity vertex offsets [0, 1, 2, ...n-1]
function createVertexOffsets(numVertices: number): Int32Array {
    const offsets = new Int32Array(numVertices);
    for (let i = 0; i < numVertices; i++) offsets[i] = i;
    return offsets;
}

// Helper to create a vertex buffer with n vertices at (10*i, 20*i)
function createVertexBuffer(numVertices: number): Int32Array {
    const buffer = new Int32Array(numVertices * 2);
    for (let i = 0; i < numVertices; i++) {
        buffer[i * 2] = 10 * (i + 1);
        buffer[i * 2 + 1] = 20 * (i + 1);
    }
    return buffer;
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
