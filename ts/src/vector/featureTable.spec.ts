import { describe, it, expect, vi, afterEach } from "vitest";
import FeatureTable from "./featureTable";
import { GeometryVector } from "./geometry/geometryVector";
import { VertexBufferType } from "./geometry/vertexBufferType";
import TopologyVector from "./geometry/topologyVector";
import { GEOMETRY_TYPE } from "./geometry/geometryType";
import * as geometryVectorConverter from "./geometry/geometryVectorConverter";
import { FlatGeometryVector } from "./geometry/flatGeometryVector";
import Point from "@mapbox/point-geometry";

afterEach(() => {
    vi.restoreAllMocks();
});

// Concrete implementation of GeometryVector for testing
class TestGeometryVector extends GeometryVector {
    constructor(
        private readonly _numGeometries: number,
        private readonly _geometryType: GEOMETRY_TYPE,
        vertexBuffer: Int32Array,
        topologyVector: TopologyVector,
    ) {
        super(VertexBufferType.VEC_2, topologyVector, null, vertexBuffer);
    }

    containsPolygonGeometry(): boolean {
        return this._geometryType === GEOMETRY_TYPE.POLYGON;
    }

    geometryType(_index: number): number {
        return this._geometryType;
    }

    get numGeometries(): number {
        return this._numGeometries;
    }

    containsSingleGeometryType(): boolean {
        return true;
    }
}

// Helper to create a simple test geometry vector with points
function createTestGeometryVector(numPoints: number): GeometryVector {
    // Create vertex buffer: pairs of (x, y) coordinates
    const vertexBuffer = new Int32Array(numPoints * 2);
    for (let i = 0; i < numPoints; i++) {
        vertexBuffer[i * 2] = i * 10; // x
        vertexBuffer[i * 2 + 1] = i * 20; // y
    }

    // For points, we need minimal topology
    const partOffsets = new Int32Array(numPoints + 1);
    for (let i = 0; i <= numPoints; i++) {
        partOffsets[i] = i;
    }

    const topologyVector = new TopologyVector(null, partOffsets, null);

    return new TestGeometryVector(numPoints, GEOMETRY_TYPE.POINT, vertexBuffer, topologyVector);
}

function createMixedPolygonGeometryVector(): GeometryVector {
    const geometryTypes = new Int32Array([GEOMETRY_TYPE.POLYGON, GEOMETRY_TYPE.MULTIPOLYGON]);

    // Feature 0: POLYGON (1 polygon)
    // Feature 1: MULTIPOLYGON (2 polygons)
    const geometryOffsets = new Int32Array([0, 1, 3]);

    // 3 polygons total, each has 1 ring
    const partOffsets = new Int32Array([0, 1, 2, 3]);

    // 3 rings total, each ring has 4 vertices
    const ringOffsets = new Int32Array([0, 4, 8, 12]);

    const vertexBuffer = new Int32Array([
        // polygon 0 ring
        0,
        0,
        10,
        0,
        10,
        10,
        0,
        10,
        // multipolygon polygon 1 ring
        100,
        0,
        110,
        0,
        110,
        10,
        100,
        10,
        // multipolygon polygon 2 ring
        200,
        0,
        210,
        0,
        210,
        10,
        200,
        10,
    ]);

    const topologyVector = new TopologyVector(geometryOffsets, partOffsets, ringOffsets);
    return new FlatGeometryVector(VertexBufferType.VEC_2, geometryTypes, topologyVector, null, vertexBuffer);
}

function createMixedPointGeometryVector(): GeometryVector {
    const geometryTypes = new Int32Array([GEOMETRY_TYPE.POINT, GEOMETRY_TYPE.MULTIPOINT]);

    // Feature 0: POINT (1 point)
    // Feature 1: MULTIPOINT (3 points)
    const geometryOffsets = new Int32Array([0, 1, 4]);

    const vertexBuffer = new Int32Array([
        // point 0
        0,
        0,
        // multipoint 1
        10,
        0,
        20,
        0,
        30,
        0,
    ]);

    const topologyVector = new TopologyVector(geometryOffsets, null, null);
    return new FlatGeometryVector(VertexBufferType.VEC_2, geometryTypes, topologyVector, null, vertexBuffer);
}

function createMixedLineGeometryVector(): GeometryVector {
    const geometryTypes = new Int32Array([GEOMETRY_TYPE.LINESTRING, GEOMETRY_TYPE.MULTILINESTRING]);

    // Feature 0: LINESTRING (1 line)
    // Feature 1: MULTILINESTRING (2 lines)
    const geometryOffsets = new Int32Array([0, 1, 3]);

    // 3 line strings total, with vertex counts: 2, 3, 2
    const partOffsets = new Int32Array([0, 2, 5, 7]);

    const vertexBuffer = new Int32Array([
        // line 0 (2 vertices)
        0,
        0,
        10,
        0,
        // line 1 (3 vertices)
        100,
        0,
        110,
        0,
        120,
        0,
        // line 2 (2 vertices)
        200,
        0,
        210,
        0,
    ]);

    const topologyVector = new TopologyVector(geometryOffsets, partOffsets, null);
    return new FlatGeometryVector(VertexBufferType.VEC_2, geometryTypes, topologyVector, null, vertexBuffer);
}

describe("FeatureTable Lazy Geometry", () => {
    describe("getLayer()", () => {
        it("does not materialize geometry coordinates until accessed", () => {
            const geometryVector = createTestGeometryVector(5);
            const featureTable = new FeatureTable("test", geometryVector, undefined, []);

            const convertSingleSpy = vi.spyOn(geometryVectorConverter, "convertSingleGeometry");
            const convertSpy = vi.spyOn(geometryVectorConverter, "convertGeometryVector");

            const features = featureTable.getLayer();

            expect(features).toHaveLength(5);
            expect(convertSingleSpy).toHaveBeenCalledTimes(0);
            expect(convertSpy).toHaveBeenCalledTimes(0);

            // Accessing the type must not require coordinates materialization.
            const feature = features.feature(2);
            const _type = feature.geometry.type;
            expect(_type).toBe(GEOMETRY_TYPE.POINT);
            expect(convertSingleSpy).toHaveBeenCalledTimes(0);
            expect(convertSpy).toHaveBeenCalledTimes(0);

            // Coordinates are materialized on demand.
            const coords = feature.geometry.coordinates;
            expect(convertSingleSpy).toHaveBeenCalledTimes(1);
            expect(convertSpy).toHaveBeenCalledTimes(0);
            expect(coords).toEqual(geometryVector.getGeometries()[2]);

            // Cached per feature/geometry instance.
            const coordsAgain = feature.geometry.coordinates;
            expect(coordsAgain).toBe(coords);
            expect(convertSingleSpy).toHaveBeenCalledTimes(1);

            convertSingleSpy.mockRestore();
            convertSpy.mockRestore();
        });

        it("keeps lazy coordinates for mixed POLYGON/MULTIPOLYGON (FlatGeometryVector)", () => {
            const geometryVector = createMixedPolygonGeometryVector();
            const featureTable = new FeatureTable("test", geometryVector, undefined, []);

            const convertSingleSpy = vi.spyOn(geometryVectorConverter, "convertSingleGeometry");
            const convertSpy = vi.spyOn(geometryVectorConverter, "convertGeometryVector");

            const features = featureTable.getLayer();

            expect(features).toHaveLength(2);
            expect(convertSingleSpy).toHaveBeenCalledTimes(0);
            expect(convertSpy).toHaveBeenCalledTimes(0);

            const coords = features.feature(1).geometry.coordinates;
            expect(convertSingleSpy).toHaveBeenCalledTimes(1);
            expect(convertSpy).toHaveBeenCalledTimes(0);

            // MultiPolygon returns a flat list of rings (same as convertGeometryVector).
            const ring1 = [
                new Point(100, 0),
                new Point(110, 0),
                new Point(110, 10),
                new Point(100, 10),
                new Point(100, 0),
            ];
            const ring2 = [
                new Point(200, 0),
                new Point(210, 0),
                new Point(210, 10),
                new Point(200, 10),
                new Point(200, 0),
            ];
            expect(coords).toEqual([ring1, ring2]);

            convertSingleSpy.mockRestore();
            convertSpy.mockRestore();
        });

        it("keeps lazy coordinates for mixed POINT/MULTIPOINT (FlatGeometryVector)", () => {
            const geometryVector = createMixedPointGeometryVector();
            const featureTable = new FeatureTable("test", geometryVector, undefined, []);

            const convertSingleSpy = vi.spyOn(geometryVectorConverter, "convertSingleGeometry");
            const convertSpy = vi.spyOn(geometryVectorConverter, "convertGeometryVector");

            const features = featureTable.getLayer();

            const coords = features.feature(1).geometry.coordinates;
            expect(convertSingleSpy).toHaveBeenCalledTimes(1);
            expect(convertSpy).toHaveBeenCalledTimes(0);

            expect(coords).toEqual([
                [new Point(10, 0)],
                [new Point(20, 0)],
                [new Point(30, 0)],
            ]);

            convertSingleSpy.mockRestore();
            convertSpy.mockRestore();
        });

        it("keeps lazy coordinates for mixed LINESTRING/MULTILINESTRING (FlatGeometryVector)", () => {
            const geometryVector = createMixedLineGeometryVector();
            const featureTable = new FeatureTable("test", geometryVector, undefined, []);

            const convertSingleSpy = vi.spyOn(geometryVectorConverter, "convertSingleGeometry");
            const convertSpy = vi.spyOn(geometryVectorConverter, "convertGeometryVector");

            const features = featureTable.getLayer();

            const coords = features.feature(1).geometry.coordinates;
            expect(convertSingleSpy).toHaveBeenCalledTimes(1);
            expect(convertSpy).toHaveBeenCalledTimes(0);

            expect(coords).toEqual([
                [new Point(100, 0), new Point(110, 0), new Point(120, 0)],
                [new Point(200, 0), new Point(210, 0)],
            ]);

            convertSingleSpy.mockRestore();
            convertSpy.mockRestore();
        });

        it("should return correct geometry when accessed", () => {
            const geometryVector = createTestGeometryVector(3);
            const featureTable = new FeatureTable("test", geometryVector, undefined, []);

            const features = featureTable.getLayer();

            // Access geometry and verify it matches direct access
            const directGeometries = geometryVector.getGeometries();

            for (let i = 0; i < features.length; i++) {
                const lazyGeom = features.feature(i).geometry;
                expect(lazyGeom.type).toBe(geometryVector.geometryType(i));
                expect(lazyGeom.coordinates).toEqual(directGeometries[i]);
            }
        });

        it("should maintain correct properties alongside lazy geometry", () => {
            const geometryVector = createTestGeometryVector(2);

            // Create property vector mock
            const propertyVector = {
                name: "testProp",
                getValue: vi.fn((i: number) => `value${i}`),
            };

            const featureTable = new FeatureTable(
                "test",
                geometryVector,
                undefined, // idVector
                [propertyVector as any],
            );

            const features = featureTable.getLayer();

            expect(features.feature(0).properties).toEqual({ testProp: "value0" });
            expect(features.feature(1).properties).toEqual({ testProp: "value1" });
        });
    });

    describe("GeometryVector.getGeometry()", () => {
        it("should return correct geometry for given index", () => {
            const geometryVector = createTestGeometryVector(5);

            for (let i = 0; i < 5; i++) {
                const geom = geometryVector.getGeometry(i);
                expect(geom.type).toBe(GEOMETRY_TYPE.POINT);
                expect(geom.coordinates).toEqual(geometryVector.getGeometries()[i]);
            }
        });

        it("should throw RangeError for negative index", () => {
            const geometryVector = createTestGeometryVector(3);

            expect(() => geometryVector.getGeometry(-1)).toThrow(RangeError);
        });

        it("should throw RangeError for index >= numGeometries", () => {
            const geometryVector = createTestGeometryVector(3);

            expect(() => geometryVector.getGeometry(3)).toThrow(RangeError);
            expect(() => geometryVector.getGeometry(100)).toThrow(RangeError);
        });
    });

    describe("convertSingleGeometry()", () => {
        it("should return correct geometry for given index", () => {
            const geometryVector = createTestGeometryVector(5);
            const allGeometries = geometryVector.getGeometries();

            for (let i = 0; i < 5; i++) {
                const singleGeom = geometryVectorConverter.convertSingleGeometry(geometryVector, i);
                expect(singleGeom).toEqual(allGeometries[i]);
            }
        });

        it("decodes POLYGON and MULTIPOLYGON without eager fallback for FlatGeometryVector", () => {
            const geometryVector = createMixedPolygonGeometryVector();

            const convertSpy = vi.spyOn(geometryVectorConverter, "convertGeometryVector");

            const polygon = geometryVectorConverter.convertSingleGeometry(geometryVector, 0);
            const multipolygon = geometryVectorConverter.convertSingleGeometry(geometryVector, 1);

            expect(convertSpy).toHaveBeenCalledTimes(0);

            const polygonRing = [
                new Point(0, 0),
                new Point(10, 0),
                new Point(10, 10),
                new Point(0, 10),
                new Point(0, 0),
            ];
            expect(polygon).toEqual([polygonRing]);

            const ring1 = [
                new Point(100, 0),
                new Point(110, 0),
                new Point(110, 10),
                new Point(100, 10),
                new Point(100, 0),
            ];
            const ring2 = [
                new Point(200, 0),
                new Point(210, 0),
                new Point(210, 10),
                new Point(200, 10),
                new Point(200, 0),
            ];
            expect(multipolygon).toEqual([ring1, ring2]);

            convertSpy.mockRestore();
        });

        it("decodes POINT and MULTIPOINT without eager fallback for FlatGeometryVector", () => {
            const geometryVector = createMixedPointGeometryVector();

            const convertSpy = vi.spyOn(geometryVectorConverter, "convertGeometryVector");

            const point = geometryVectorConverter.convertSingleGeometry(geometryVector, 0);
            const multipoint = geometryVectorConverter.convertSingleGeometry(geometryVector, 1);

            expect(convertSpy).toHaveBeenCalledTimes(0);
            expect(point).toEqual([[new Point(0, 0)]]);
            expect(multipoint).toEqual([
                [new Point(10, 0)],
                [new Point(20, 0)],
                [new Point(30, 0)],
            ]);

            convertSpy.mockRestore();
        });

        it("decodes LINESTRING and MULTILINESTRING without eager fallback for FlatGeometryVector", () => {
            const geometryVector = createMixedLineGeometryVector();

            const convertSpy = vi.spyOn(geometryVectorConverter, "convertGeometryVector");

            const line = geometryVectorConverter.convertSingleGeometry(geometryVector, 0);
            const multiline = geometryVectorConverter.convertSingleGeometry(geometryVector, 1);

            expect(convertSpy).toHaveBeenCalledTimes(0);
            expect(line).toEqual([[new Point(0, 0), new Point(10, 0)]]);
            expect(multiline).toEqual([
                [new Point(100, 0), new Point(110, 0), new Point(120, 0)],
                [new Point(200, 0), new Point(210, 0)],
            ]);

            convertSpy.mockRestore();
        });

        it("should throw RangeError for invalid indices", () => {
            const geometryVector = createTestGeometryVector(3);

            expect(() => geometryVectorConverter.convertSingleGeometry(geometryVector, -1)).toThrow(RangeError);
            expect(() => geometryVectorConverter.convertSingleGeometry(geometryVector, 3)).toThrow(RangeError);
        });
    });

    describe("LazyGeometryCoordinatesResolver heuristic", () => {
        it("should stay in lazy mode for sparse access pattern", () => {
            const geometryVector = createTestGeometryVector(100);
            const featureTable = new FeatureTable("test", geometryVector, undefined, []);

            const convertSingleSpy = vi.spyOn(geometryVectorConverter, "convertSingleGeometry");
            const convertBulkSpy = vi.spyOn(geometryVector, "getGeometries");

            const features = featureTable.getLayer();

            // Sparse access: indices 0, 50, 99
            const _coords0 = features.feature(0).geometry.coordinates;
            const _coords50 = features.feature(50).geometry.coordinates;
            const _coords99 = features.feature(99).geometry.coordinates;

            // Should use single-geometry conversion (lazy mode)
            expect(convertSingleSpy).toHaveBeenCalledTimes(3);
            expect(convertBulkSpy).toHaveBeenCalledTimes(0);

            convertSingleSpy.mockRestore();
            convertBulkSpy.mockRestore();
        });

        it("should switch to bulk mode after sequential access threshold", () => {
            const geometryVector = createTestGeometryVector(100);
            const featureTable = new FeatureTable("test", geometryVector, undefined, []);

            const convertSingleSpy = vi.spyOn(geometryVectorConverter, "convertSingleGeometry");
            const convertBulkSpy = vi.spyOn(geometryVector, "getGeometries");

            const features = featureTable.getLayer();

            // Sequential access: 0, 1, 2, ..., 35
            // After 32 sequential accesses, should switch to bulk mode
            for (let i = 0; i <= 35; i++) {
                const _coords = features.feature(i).geometry.coordinates;
            }

            // First ~32 calls use single-geometry, then switches to bulk
            expect(convertBulkSpy).toHaveBeenCalledTimes(1);

            convertSingleSpy.mockRestore();
            convertBulkSpy.mockRestore();
        });

        it("should switch to bulk mode after absolute access threshold", () => {
            const geometryVector = createTestGeometryVector(1000);
            const featureTable = new FeatureTable("test", geometryVector, undefined, []);

            const convertBulkSpy = vi.spyOn(geometryVector, "getGeometries");

            const features = featureTable.getLayer();

            // Access 520 features with delta=2 (near-sequential but not quite)
            // This should trigger the absoluteAccessThreshold (512)
            for (let i = 0; i < 520; i += 2) {
                const _coords = features.feature(i).geometry.coordinates;
            }

            // Should have switched to bulk mode due to absolute threshold
            expect(convertBulkSpy).toHaveBeenCalled();

            convertBulkSpy.mockRestore();
        });

        it("should reset sequential counter on non-sequential access", () => {
            const geometryVector = createTestGeometryVector(100);
            const featureTable = new FeatureTable("test", geometryVector, undefined, []);

            const convertSingleSpy = vi.spyOn(geometryVectorConverter, "convertSingleGeometry");
            const convertBulkSpy = vi.spyOn(geometryVector, "getGeometries");

            const features = featureTable.getLayer();

            // Sequential: 0, 1, 2, 3, 4
            for (let i = 0; i <= 4; i++) {
                const _coords = features.feature(i).geometry.coordinates;
            }

            // Non-sequential jump: 50 (resets counter)
            const _coords50 = features.feature(50).geometry.coordinates;

            // Continue sequential: 51, 52, ..., 60
            for (let i = 51; i <= 60; i++) {
                const _coords = features.feature(i).geometry.coordinates;
            }

            // Should still be in lazy mode (counter was reset)
            expect(convertBulkSpy).toHaveBeenCalledTimes(0);
            expect(convertSingleSpy.mock.calls.length).toBeGreaterThan(0);

            convertSingleSpy.mockRestore();
            convertBulkSpy.mockRestore();
        });
    });
});
