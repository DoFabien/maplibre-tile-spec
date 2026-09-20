import { describe, expect, it } from "vitest";
import { GEOMETRY_TYPE } from "./geometryType";
import { GeometryTopologyCursor, type TopologyGeometryVector } from "./geometryTopologyCursor";

function createMixedGeometryVector(): TopologyGeometryVector {
    const geometryTypes = [
        GEOMETRY_TYPE.POINT,
        GEOMETRY_TYPE.MULTIPOINT,
        GEOMETRY_TYPE.LINESTRING,
        GEOMETRY_TYPE.POLYGON,
        GEOMETRY_TYPE.MULTILINESTRING,
        GEOMETRY_TYPE.MULTIPOLYGON,
    ];

    return {
        numGeometries: geometryTypes.length,
        geometryType: (index) => geometryTypes[index],
        containsPolygonGeometry: () => true,
        topologyVector: {
            geometryOffsets: new Uint32Array([0, 1, 3, 4, 5, 7, 9]),
            partOffsets: new Uint32Array([0, 1, 2, 3, 4, 6, 7, 8, 9, 11]),
            ringOffsets: new Uint32Array([0, 1, 2, 3, 6, 10, 13, 15, 19, 23, 28, 31]),
        },
    };
}

describe("GeometryTopologyCursor", () => {
    it("streams every geometry type without retaining per-feature ranges", () => {
        const cursor = new GeometryTopologyCursor(createMixedGeometryVector());
        const expected = [
            [[0, 1, false, -1]],
            [
                [1, 2, false, -1],
                [2, 3, false, -1],
            ],
            [[3, 6, false, -1]],
            [
                [6, 10, true, 0],
                [10, 13, true, 0],
            ],
            [
                [13, 15, false, -1],
                [15, 19, false, -1],
            ],
            [
                [19, 23, true, 0],
                [23, 28, true, 1],
                [28, 31, true, 1],
            ],
        ];

        for (let featureIndex = 0; featureIndex < expected.length; featureIndex++) {
            const parts: Array<[number, number, boolean, number]> = [];
            cursor.seek(featureIndex).forEachPart((_partIndex, start, end, close, polygonIndex) => {
                parts.push([start, end, close, polygonIndex]);
            });
            expect(parts).toEqual(expected[featureIndex]);
            expect(cursor.partCount).toBe(expected[featureIndex].length);
        }
    });

    it("reuses the cursor for selected parts and backward seeks", () => {
        const cursor = new GeometryTopologyCursor(createMixedGeometryVector());

        expect(cursor.seek(5).selectPart(2)).toBe(cursor);
        expect({
            featureIndex: cursor.featureIndex,
            partIndex: cursor.partIndex,
            start: cursor.start,
            end: cursor.end,
            close: cursor.close,
            polygonIndex: cursor.polygonIndex,
        }).toEqual({ featureIndex: 5, partIndex: 2, start: 28, end: 31, close: true, polygonIndex: 1 });

        expect(cursor.seek(2).selectPart(0)).toBe(cursor);
        expect([cursor.start, cursor.end, cursor.close]).toEqual([3, 6, false]);
        expect(() => cursor.selectPart(1)).toThrow("Geometry part 1 is out of range");
        expect(() => cursor.seek(6)).toThrow("Geometry feature 6 is out of range");
    });

    it("streams backwards without replaying topology from the first feature", () => {
        const vector = createMixedGeometryVector();
        let geometryTypeCalls = 0;
        const geometryType = vector.geometryType;
        vector.geometryType = (index) => {
            geometryTypeCalls++;
            return geometryType(index);
        };
        const cursor = new GeometryTopologyCursor(vector);
        const expected = [
            [[0, 1, false, -1]],
            [
                [1, 2, false, -1],
                [2, 3, false, -1],
            ],
            [[3, 6, false, -1]],
            [
                [6, 10, true, 0],
                [10, 13, true, 0],
            ],
            [
                [13, 15, false, -1],
                [15, 19, false, -1],
            ],
            [
                [19, 23, true, 0],
                [23, 28, true, 1],
                [28, 31, true, 1],
            ],
        ];

        cursor.seek(expected.length - 1);
        for (let featureIndex = expected.length - 1; featureIndex >= 0; featureIndex--) {
            const parts: Array<[number, number, boolean, number]> = [];
            cursor.seek(featureIndex).forEachPart((_partIndex, start, end, close, polygonIndex) => {
                parts.push([start, end, close, polygonIndex]);
            });
            expect(parts).toEqual(expected[featureIndex]);
        }

        expect(geometryTypeCalls).toBe(expected.length * 2 - 1);
    });

    it("keeps forward state valid after non-contiguous backward seeks", () => {
        const cursor = new GeometryTopologyCursor(createMixedGeometryVector());
        const expectedFirstParts = [
            [0, 1],
            [1, 2],
            [3, 6],
            [6, 10],
            [13, 15],
            [19, 23],
        ];

        for (const featureIndex of [5, 2, 4, 1, 3, 0, 5]) {
            cursor.seek(featureIndex).selectPart(0);
            expect([cursor.start, cursor.end]).toEqual(expectedFirstParts[featureIndex]);
        }
    });

    it("supports line-only topology without ring offsets", () => {
        const vector: TopologyGeometryVector = {
            numGeometries: 2,
            geometryType: (index) => (index === 0 ? GEOMETRY_TYPE.LINESTRING : GEOMETRY_TYPE.MULTILINESTRING),
            containsPolygonGeometry: () => false,
            topologyVector: {
                geometryOffsets: new Uint32Array([0, 1, 3]),
                partOffsets: new Uint32Array([0, 3, 5, 9]),
            },
        };
        const cursor = new GeometryTopologyCursor(vector);
        const parts: Array<[number, number]> = [];

        cursor.seek(0).forEachPart((_partIndex, start, end) => parts.push([start, end]));
        cursor.seek(1).forEachPart((_partIndex, start, end) => parts.push([start, end]));
        cursor.seek(0).forEachPart((_partIndex, start, end) => parts.push([start, end]));

        expect(parts).toEqual([
            [0, 3],
            [3, 5],
            [5, 9],
            [0, 3],
        ]);
    });

    it("finds multiline part offsets while seeking backwards without geometry offsets", () => {
        const vector: TopologyGeometryVector = {
            numGeometries: 2,
            geometryType: (index) => (index === 0 ? GEOMETRY_TYPE.MULTILINESTRING : GEOMETRY_TYPE.POINT),
            containsPolygonGeometry: () => false,
            topologyVector: {
                partOffsets: new Uint32Array([0, 2, 5, 6]),
            },
        };
        const cursor = new GeometryTopologyCursor(vector);
        const parts: Array<[number, number]> = [];

        cursor.seek(1).selectPart(0);
        expect([cursor.start, cursor.end]).toEqual([5, 6]);
        cursor.seek(0).forEachPart((_partIndex, start, end) => parts.push([start, end]));

        expect(parts).toEqual([
            [0, 2],
            [2, 5],
        ]);
    });
});
