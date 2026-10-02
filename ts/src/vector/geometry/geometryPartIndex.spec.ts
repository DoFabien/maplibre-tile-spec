import { describe, expect, it } from "vitest";
import { GEOMETRY_TYPE } from "./geometryType";
import { createGeometryPartIndex, type TopologyGeometryVector } from "./geometryPartIndex";

/** The vertex ranges of the parts of each feature. */
function featureParts(vector: TopologyGeometryVector): number[][][] {
    const { featureParts, partVertices } = createGeometryPartIndex(vector);
    return Array.from({ length: vector.numGeometries }, (_, feature) => {
        const parts: number[][] = [];
        for (let part = featureParts[feature]; part < featureParts[feature + 1]; part++) {
            parts.push([partVertices[part], partVertices[part + 1]]);
        }
        return parts;
    });
}

describe("createGeometryPartIndex", () => {
    it("indexes the parts of every geometry type", () => {
        const geometryTypes = [
            GEOMETRY_TYPE.POINT,
            GEOMETRY_TYPE.MULTIPOINT,
            GEOMETRY_TYPE.LINESTRING,
            GEOMETRY_TYPE.POLYGON,
            GEOMETRY_TYPE.MULTILINESTRING,
            GEOMETRY_TYPE.MULTIPOLYGON,
        ];
        const vector: TopologyGeometryVector = {
            numGeometries: geometryTypes.length,
            geometryType: (index) => geometryTypes[index],
            topologyVector: {
                geometryOffsets: new Uint32Array([0, 1, 3, 4, 5, 7, 9]),
                partOffsets: new Uint32Array([0, 1, 2, 3, 4, 6, 7, 8, 9, 11]),
                ringOffsets: new Uint32Array([0, 1, 2, 3, 6, 10, 13, 15, 19, 23, 28, 31]),
            },
        };

        expect(featureParts(vector)).toEqual([
            [[0, 1]],
            [
                [1, 2],
                [2, 3],
            ],
            [[3, 6]],
            [
                [6, 10],
                [10, 13],
            ],
            [
                [13, 15],
                [15, 19],
            ],
            [
                [19, 23],
                [23, 28],
                [28, 31],
            ],
        ]);
    });

    it("counts the vertices of line strings in the part offsets without polygons", () => {
        const vector: TopologyGeometryVector = {
            numGeometries: 2,
            geometryType: (index) => (index === 0 ? GEOMETRY_TYPE.LINESTRING : GEOMETRY_TYPE.MULTILINESTRING),
            topologyVector: {
                geometryOffsets: new Uint32Array([0, 1, 3]),
                partOffsets: new Uint32Array([0, 3, 5, 9]),
            },
        };

        expect(featureParts(vector)).toEqual([
            [[0, 3]],
            [
                [3, 5],
                [5, 9],
            ],
        ]);
    });

    it("counts the line strings of a multi line string in the part offsets without geometry offsets", () => {
        const vector: TopologyGeometryVector = {
            numGeometries: 2,
            geometryType: (index) => (index === 0 ? GEOMETRY_TYPE.MULTILINESTRING : GEOMETRY_TYPE.POINT),
            topologyVector: {
                partOffsets: new Uint32Array([0, 2, 5, 6]),
            },
        };

        expect(featureParts(vector)).toEqual([
            [
                [0, 2],
                [2, 5],
            ],
            [[5, 6]],
        ]);
    });
});
