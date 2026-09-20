import { describe, it, expect } from "vitest";
import { GEOMETRY_TYPE, SINGLE_PART_GEOMETRY_TYPE } from "./geometryType";
import { FlatSelectionVector } from "../filter/flatSelectionVector";
import {
    createSelectionVectorByTypeConst,
    filterSelectedByTypeConst,
    createSelectionVectorByTypeFlat,
    filterSelectedByTypeFlat,
    containsPolygonGeometryFlat,
} from "./geometryVectorFilterUtils";
import { createConstGeometryVector } from "./constGeometryVector";
import { createFlatGeometryVector } from "./flatGeometryVector";
import TopologyVector from "./topologyVector";

describe("GeometryVectorFilterUtils", () => {
    describe("createSelectionVectorByTypeConst", () => {
        it("should return full selection for exact match", () => {
            const vector = createConstVector(10, GEOMETRY_TYPE.POINT);
            const result = createSelectionVectorByTypeConst(
                SINGLE_PART_GEOMETRY_TYPE.POINT,
                vector.geometryType(),
                vector.numGeometries,
            );
            expect(result.limit).toBe(10);
            expect(result.capacity).toBe(10);
        });

        it("should return full selection for multi-type match", () => {
            const vector = createConstVector(5, GEOMETRY_TYPE.MULTIPOINT);
            const result = createSelectionVectorByTypeConst(
                SINGLE_PART_GEOMETRY_TYPE.POINT,
                vector.geometryType(),
                vector.numGeometries,
            );
            expect(result.limit).toBe(5);
            expect(result.capacity).toBe(5);
        });

        it("should return empty selection for no match", () => {
            const vector = createConstVector(10, GEOMETRY_TYPE.LINESTRING);
            const result = createSelectionVectorByTypeConst(
                SINGLE_PART_GEOMETRY_TYPE.POINT,
                vector.geometryType(),
                vector.numGeometries,
            );
            expect(result.limit).toBe(0);
            expect(result.capacity).toBe(10);
        });
    });

    describe("filterSelectedByTypeConst", () => {
        it("should not modify limit for exact match", () => {
            const vector = createConstVector(5, GEOMETRY_TYPE.POINT);
            // Selected feature indices
            const selectionVector = new FlatSelectionVector(new Uint32Array([0, 1, 2, 3, 4]));
            filterSelectedByTypeConst(SINGLE_PART_GEOMETRY_TYPE.POINT, vector.geometryType(), selectionVector);
            expect(selectionVector.limit).toBe(5);
        });

        it("should not modify limit for multi-type match", () => {
            const vector = createConstVector(3, GEOMETRY_TYPE.MULTIPOINT);
            // Selected feature indices
            const selectionVector = new FlatSelectionVector(new Uint32Array([0, 1, 2]));
            filterSelectedByTypeConst(SINGLE_PART_GEOMETRY_TYPE.POINT, vector.geometryType(), selectionVector);
            expect(selectionVector.limit).toBe(3);
        });

        it("should set limit to 0 for no match", () => {
            const vector = createConstVector(4, GEOMETRY_TYPE.LINESTRING);
            // Selected feature indices
            const selectionVector = new FlatSelectionVector(new Uint32Array([0, 1, 2, 3]));
            filterSelectedByTypeConst(SINGLE_PART_GEOMETRY_TYPE.POINT, vector.geometryType(), selectionVector);
            expect(selectionVector.limit).toBe(0);
        });
    });

    describe("createSelectionVectorByTypeFlat", () => {
        it("should return ConstSelectionVector.full when all match exactly", () => {
            const vector = createFlatVector(
                new Int32Array([GEOMETRY_TYPE.POINT, GEOMETRY_TYPE.POINT, GEOMETRY_TYPE.POINT]),
            );
            const result = createSelectionVectorByTypeFlat(
                SINGLE_PART_GEOMETRY_TYPE.POINT,
                vector.geometryTypes,
                vector.numGeometries,
            );
            expect(result.limit).toBe(3);
            expect(result.capacity).toBe(3);
        });

        it("should return ConstSelectionVector.full when all match with multi-types", () => {
            const vector = createFlatVector(new Int32Array([GEOMETRY_TYPE.MULTIPOINT, GEOMETRY_TYPE.MULTIPOINT]));
            const result = createSelectionVectorByTypeFlat(
                SINGLE_PART_GEOMETRY_TYPE.POINT,
                vector.geometryTypes,
                vector.numGeometries,
            );
            expect(result.limit).toBe(2);
        });

        it("should return ConstSelectionVector.full when all match with mixed exact and multi-type", () => {
            const vector = createFlatVector(
                new Int32Array([GEOMETRY_TYPE.POINT, GEOMETRY_TYPE.MULTIPOINT, GEOMETRY_TYPE.POINT]),
            );
            const result = createSelectionVectorByTypeFlat(
                SINGLE_PART_GEOMETRY_TYPE.POINT,
                vector.geometryTypes,
                vector.numGeometries,
            );
            expect(result.limit).toBe(3);
        });

        it("should return ConstSelectionVector.empty when none match", () => {
            const vector = createFlatVector(
                new Int32Array([GEOMETRY_TYPE.LINESTRING, GEOMETRY_TYPE.POLYGON, GEOMETRY_TYPE.MULTILINESTRING]),
            );
            const result = createSelectionVectorByTypeFlat(
                SINGLE_PART_GEOMETRY_TYPE.POINT,
                vector.geometryTypes,
                vector.numGeometries,
            );
            expect(result.limit).toBe(0);
            expect(result.capacity).toBe(3);
        });

        it("should return FlatSelectionVector with correct indices for partial match", () => {
            const vector = createFlatVector(
                new Int32Array([
                    GEOMETRY_TYPE.POINT,
                    GEOMETRY_TYPE.LINESTRING,
                    GEOMETRY_TYPE.MULTIPOINT,
                    GEOMETRY_TYPE.POLYGON,
                    GEOMETRY_TYPE.POINT,
                ]),
            );
            const result = createSelectionVectorByTypeFlat(
                SINGLE_PART_GEOMETRY_TYPE.POINT,
                vector.geometryTypes,
                vector.numGeometries,
            );
            expect(result.limit).toBe(3);
            expect(result.getIndex(0)).toBe(0);
            expect(result.getIndex(1)).toBe(2);
            expect(result.getIndex(2)).toBe(4);
        });
    });

    describe("filterSelectedByTypeFlat", () => {
        it("should filter selection vector correctly with all matching", () => {
            const vector = createFlatVector(
                new Int32Array([
                    GEOMETRY_TYPE.POINT,
                    GEOMETRY_TYPE.LINESTRING,
                    GEOMETRY_TYPE.POINT,
                    GEOMETRY_TYPE.POLYGON,
                ]),
            );
            // Selected feature indices
            const selectionVector = new FlatSelectionVector(new Uint32Array([0, 2]));

            filterSelectedByTypeFlat(SINGLE_PART_GEOMETRY_TYPE.POINT, vector.geometryTypes, selectionVector);

            expect(selectionVector.limit).toBe(2);
            expect(selectionVector.getIndex(0)).toBe(0);
            expect(selectionVector.getIndex(1)).toBe(2);
        });

        it("should filter selection vector correctly with partial matching", () => {
            const vector = createFlatVector(
                new Int32Array([
                    GEOMETRY_TYPE.POINT,
                    GEOMETRY_TYPE.LINESTRING,
                    GEOMETRY_TYPE.MULTIPOINT,
                    GEOMETRY_TYPE.POLYGON,
                    GEOMETRY_TYPE.POINT,
                ]),
            );
            // Selected feature indices
            const selectionVector = new FlatSelectionVector(new Uint32Array([0, 1, 2, 3, 4]));

            filterSelectedByTypeFlat(SINGLE_PART_GEOMETRY_TYPE.POINT, vector.geometryTypes, selectionVector);

            expect(selectionVector.limit).toBe(3);
            expect(selectionVector.getIndex(0)).toBe(0);
            expect(selectionVector.getIndex(1)).toBe(2);
            expect(selectionVector.getIndex(2)).toBe(4);
        });

        it("should set limit to 0 when no geometries match", () => {
            const vector = createFlatVector(
                new Int32Array([GEOMETRY_TYPE.LINESTRING, GEOMETRY_TYPE.POLYGON, GEOMETRY_TYPE.MULTILINESTRING]),
            );
            // Selected feature indices
            const selectionVector = new FlatSelectionVector(new Uint32Array([0, 1, 2]));

            filterSelectedByTypeFlat(SINGLE_PART_GEOMETRY_TYPE.POINT, vector.geometryTypes, selectionVector);

            expect(selectionVector.limit).toBe(0);
        });

        it("should handle multi-type matches", () => {
            const vector = createFlatVector(
                new Int32Array([GEOMETRY_TYPE.MULTIPOINT, GEOMETRY_TYPE.LINESTRING, GEOMETRY_TYPE.POINT]),
            );
            // Selected feature indices
            const selectionVector = new FlatSelectionVector(new Uint32Array([0, 1, 2]));

            filterSelectedByTypeFlat(SINGLE_PART_GEOMETRY_TYPE.POINT, vector.geometryTypes, selectionVector);

            expect(selectionVector.limit).toBe(2);
            expect(selectionVector.getIndex(0)).toBe(0);
            expect(selectionVector.getIndex(1)).toBe(2);
        });

        it("should respect selectionVector", () => {
            const vector = createFlatVector(
                new Int32Array([
                    GEOMETRY_TYPE.POINT,
                    GEOMETRY_TYPE.LINESTRING,
                    GEOMETRY_TYPE.POLYGON,
                    GEOMETRY_TYPE.MULTILINESTRING,
                ]),
            );
            // Selected feature indices
            const selectionVector = new FlatSelectionVector(new Uint32Array([1, 2]));

            filterSelectedByTypeFlat(SINGLE_PART_GEOMETRY_TYPE.LINESTRING, vector.geometryTypes, selectionVector);

            expect(selectionVector.limit).toBe(1);
            expect(selectionVector.getIndex(0)).toBe(1);
        });
    });

    describe("containsPolygonGeometryFlat", () => {
        it("should return true when array contains POLYGON or MULTIPOLYGON", () => {
            const geometryTypes1 = new Int32Array([
                GEOMETRY_TYPE.POINT,
                GEOMETRY_TYPE.POLYGON,
                GEOMETRY_TYPE.LINESTRING,
            ]);
            const geometryTypes2 = new Int32Array([
                GEOMETRY_TYPE.POINT,
                GEOMETRY_TYPE.MULTIPOLYGON,
                GEOMETRY_TYPE.LINESTRING,
            ]);

            expect(containsPolygonGeometryFlat(geometryTypes1)).toBe(true);
            expect(containsPolygonGeometryFlat(geometryTypes2)).toBe(true);
        });

        it("should return true when array contains both POLYGON and MULTIPOLYGON", () => {
            const geometryTypes = new Int32Array([GEOMETRY_TYPE.POLYGON, GEOMETRY_TYPE.MULTIPOLYGON]);
            expect(containsPolygonGeometryFlat(geometryTypes)).toBe(true);
        });

        it("should return false when array contains no polygons", () => {
            const geometryTypes = new Int32Array([
                GEOMETRY_TYPE.POINT,
                GEOMETRY_TYPE.LINESTRING,
                GEOMETRY_TYPE.MULTIPOINT,
                GEOMETRY_TYPE.MULTILINESTRING,
            ]);
            expect(containsPolygonGeometryFlat(geometryTypes)).toBe(false);
        });

        it("should return false for empty array", () => {
            const geometryTypes = new Int32Array([]);
            expect(containsPolygonGeometryFlat(geometryTypes)).toBe(false);
        });
    });
});

/**
 * Creates a constGeometryVector for testing purposes
 *
 * @returns constGeometryVector with custom length and type
 *
 * @param numGeometries - number of geometries
 * @param geometryType - type of geometries
 */
function createConstVector(numGeometries: number, geometryType: number) {
    return createConstGeometryVector(
        numGeometries,
        geometryType,
        createSimpleTopology(numGeometries),
        new Int32Array([]),
        new Int32Array([]),
    );
}

/**
 * Creates a flatGeometryVector for testing purposes
 *
 * @returns flatGeometryVector with custom length and types
 *
 * @param geometryTypes - array of geometryTypes of Geometries in the vector
 */
function createFlatVector(geometryTypes: Int32Array) {
    return createFlatGeometryVector(
        geometryTypes,
        createSimpleTopology(geometryTypes.length),
        new Int32Array([]),
        new Int32Array([]),
    );
}

function createSimpleTopology(numGeometries: number): TopologyVector {
    const offsets = new Uint32Array(numGeometries + 1);
    for (let i = 0; i <= numGeometries; i++) {
        offsets[i] = i;
    }
    return new TopologyVector(offsets, offsets, offsets);
}
