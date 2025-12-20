import { describe, expect, it } from "vitest";

import TopologyVector from "./topologyVector";
import { createFlatGeometryVector } from "./flatGeometryVector";
import { GEOMETRY_TYPE } from "./geometryType";

function toPairs(points: Array<{ x: number; y: number }>): Array<[number, number]> {
    return points.map((p) => [p.x, p.y]);
}

describe("geometry vector conversion", () => {
    it("uses the correct vertex count for multipolygon rings with vertex offsets", () => {
        const geometryTypes = new Int32Array([GEOMETRY_TYPE.MULTIPOLYGON]);
        const geometryOffsets = new Int32Array([0, 1]);
        const partOffsets = new Int32Array([0, 2]);
        const ringOffsets = new Int32Array([0, 4, 7]);

        const vertexOffsets = new Int32Array([0, 1, 2, 3, 4, 5, 6]);
        const vertexBuffer = new Int32Array([
            0,
            0,
            10,
            0,
            10,
            10,
            0,
            10,
            2,
            2,
            5,
            2,
            3,
            5,
        ]);

        const topology = new TopologyVector(geometryOffsets, partOffsets, ringOffsets);
        const vector = createFlatGeometryVector(geometryTypes, topology, vertexOffsets, vertexBuffer);
        const geometries = vector.getGeometries();

        expect(geometries.length).toBe(1);

        const rings = geometries[0];
        expect(rings.length).toBe(2);

        const shell = rings[0];
        const hole = rings[1];

        expect(shell.length).toBe(5);
        expect(hole.length).toBe(4);

        expect(toPairs(shell)).toEqual([
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
        ]);
        expect(toPairs(hole)).toEqual([
            [2, 2],
            [5, 2],
            [3, 5],
            [2, 2],
        ]);
    });

    it("handles multiple polygons with varying ring sizes", () => {
        const geometryTypes = new Int32Array([GEOMETRY_TYPE.MULTIPOLYGON]);
        const geometryOffsets = new Int32Array([0, 2]);
        const partOffsets = new Int32Array([0, 2, 3]);
        const ringOffsets = new Int32Array([0, 4, 7, 12]);

        const vertexOffsets = new Int32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
        const vertexBuffer = new Int32Array([
            0,
            0,
            10,
            0,
            10,
            10,
            0,
            10,
            2,
            2,
            5,
            2,
            3,
            5,
            20,
            20,
            30,
            20,
            30,
            30,
            25,
            35,
            20,
            30,
        ]);

        const topology = new TopologyVector(geometryOffsets, partOffsets, ringOffsets);
        const vector = createFlatGeometryVector(geometryTypes, topology, vertexOffsets, vertexBuffer);
        const geometries = vector.getGeometries();

        expect(geometries.length).toBe(1);

        const rings = geometries[0];
        expect(rings.length).toBe(3);

        const shell1 = rings[0];
        const hole1 = rings[1];
        const shell2 = rings[2];

        expect(shell1.length).toBe(5);
        expect(hole1.length).toBe(4);
        expect(shell2.length).toBe(6);

        expect(toPairs(shell1)).toEqual([
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
        ]);
        expect(toPairs(hole1)).toEqual([
            [2, 2],
            [5, 2],
            [3, 5],
            [2, 2],
        ]);
        expect(toPairs(shell2)).toEqual([
            [20, 20],
            [30, 20],
            [30, 30],
            [25, 35],
            [20, 30],
            [20, 20],
        ]);
    });

    it("respects non-sequential vertex offsets", () => {
        const geometryTypes = new Int32Array([GEOMETRY_TYPE.MULTIPOLYGON]);
        const geometryOffsets = new Int32Array([0, 1]);
        const partOffsets = new Int32Array([0, 2]);
        const ringOffsets = new Int32Array([0, 4, 7]);

        const vertexBuffer = new Int32Array([
            0,
            0,
            10,
            0,
            10,
            10,
            0,
            10,
            2,
            2,
            5,
            2,
            3,
            5,
        ]);
        const vertexOffsets = new Int32Array([1, 0, 3, 2, 6, 4, 5]);

        const topology = new TopologyVector(geometryOffsets, partOffsets, ringOffsets);
        const vector = createFlatGeometryVector(geometryTypes, topology, vertexOffsets, vertexBuffer);
        const geometries = vector.getGeometries();

        const rings = geometries[0];
        const shell = rings[0];
        const hole = rings[1];

        expect(toPairs(shell)).toEqual([
            [10, 0],
            [0, 0],
            [0, 10],
            [10, 10],
            [10, 0],
        ]);
        expect(toPairs(hole)).toEqual([
            [3, 5],
            [2, 2],
            [5, 2],
            [3, 5],
        ]);
    });

    it("handles three polygons with mixed ring sizes", () => {
        const geometryTypes = new Int32Array([GEOMETRY_TYPE.MULTIPOLYGON]);
        const geometryOffsets = new Int32Array([0, 3]);
        const partOffsets = new Int32Array([0, 1, 3, 4]);
        const ringOffsets = new Int32Array([0, 4, 7, 10, 15]);

        const vertexOffsets = new Int32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
        const vertexBuffer = new Int32Array([
            0,
            0,
            10,
            0,
            10,
            10,
            0,
            10,
            2,
            2,
            5,
            2,
            3,
            5,
            20,
            20,
            30,
            20,
            25,
            25,
            40,
            40,
            45,
            40,
            45,
            45,
            40,
            45,
            42,
            47,
        ]);

        const topology = new TopologyVector(geometryOffsets, partOffsets, ringOffsets);
        const vector = createFlatGeometryVector(geometryTypes, topology, vertexOffsets, vertexBuffer);
        const geometries = vector.getGeometries();

        const rings = geometries[0];
        expect(rings.length).toBe(4);

        expect(rings[0].length).toBe(5);
        expect(rings[1].length).toBe(4);
        expect(rings[2].length).toBe(4);
        expect(rings[3].length).toBe(6);
    });
});
