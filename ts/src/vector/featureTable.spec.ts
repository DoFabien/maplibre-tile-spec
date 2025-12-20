import { describe, it, expect, vi } from "vitest";
import FeatureTable from "./featureTable";
import { GeometryVector } from "./geometry/geometryVector";
import { VertexBufferType } from "./geometry/vertexBufferType";
import TopologyVector from "./geometry/topologyVector";
import { GEOMETRY_TYPE } from "./geometry/geometryType";
import * as geometryVectorConverter from "./geometry/geometryVectorConverter";

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

describe("FeatureTable Lazy Geometry", () => {
    describe("getFeatures()", () => {
        it("does not materialize geometry coordinates until accessed", () => {
            const geometryVector = createTestGeometryVector(5);
            const featureTable = new FeatureTable("test", geometryVector, undefined, []);

            const convertSingleSpy = vi.spyOn(geometryVectorConverter, "convertSingleGeometry");
            const convertSpy = vi.spyOn(geometryVectorConverter, "convertGeometryVector");

            const features = featureTable.getFeatures();

            expect(features).toHaveLength(5);
            expect(convertSingleSpy).toHaveBeenCalledTimes(0);
            expect(convertSpy).toHaveBeenCalledTimes(0);

            // Accessing the type must not require coordinates materialization.
            const _type = features[2].geometry.type;
            expect(_type).toBe(GEOMETRY_TYPE.POINT);
            expect(convertSingleSpy).toHaveBeenCalledTimes(0);
            expect(convertSpy).toHaveBeenCalledTimes(0);

            // Coordinates are materialized on demand.
            const coords = features[2].geometry.coordinates;
            expect(convertSingleSpy).toHaveBeenCalledTimes(1);
            expect(convertSpy).toHaveBeenCalledTimes(0);
            expect(coords).toEqual(geometryVector.getGeometries()[2]);

            // Cached per feature/geometry instance.
            const coordsAgain = features[2].geometry.coordinates;
            expect(coordsAgain).toBe(coords);
            expect(convertSingleSpy).toHaveBeenCalledTimes(1);

            convertSingleSpy.mockRestore();
            convertSpy.mockRestore();
        });

        it("should return correct geometry when accessed", () => {
            const geometryVector = createTestGeometryVector(3);
            const featureTable = new FeatureTable("test", geometryVector, undefined, []);

            const features = featureTable.getFeatures();

            // Access geometry and verify it matches direct access
            const directGeometries = geometryVector.getGeometries();

            for (let i = 0; i < features.length; i++) {
                const lazyGeom = features[i].geometry;
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

            const features = featureTable.getFeatures();

            expect(features[0].properties).toEqual({ testProp: "value0" });
            expect(features[1].properties).toEqual({ testProp: "value1" });
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

            const features = featureTable.getFeatures();

            // Sparse access: indices 0, 50, 99
            const _coords0 = features[0].geometry.coordinates;
            const _coords50 = features[50].geometry.coordinates;
            const _coords99 = features[99].geometry.coordinates;

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

            const features = featureTable.getFeatures();

            // Sequential access: 0, 1, 2, ..., 35
            // After 32 sequential accesses, should switch to bulk mode
            for (let i = 0; i <= 35; i++) {
                const _coords = features[i].geometry.coordinates;
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

            const features = featureTable.getFeatures();

            // Access 520 features with delta=2 (near-sequential but not quite)
            // This should trigger the absoluteAccessThreshold (512)
            for (let i = 0; i < 520; i += 2) {
                const _coords = features[i].geometry.coordinates;
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

            const features = featureTable.getFeatures();

            // Sequential: 0, 1, 2, 3, 4
            for (let i = 0; i <= 4; i++) {
                const _coords = features[i].geometry.coordinates;
            }

            // Non-sequential jump: 50 (resets counter)
            const _coords50 = features[50].geometry.coordinates;

            // Continue sequential: 51, 52, ..., 60
            for (let i = 51; i <= 60; i++) {
                const _coords = features[i].geometry.coordinates;
            }

            // Should still be in lazy mode (counter was reset)
            expect(convertBulkSpy).toHaveBeenCalledTimes(0);
            expect(convertSingleSpy.mock.calls.length).toBeGreaterThan(0);

            convertSingleSpy.mockRestore();
            convertBulkSpy.mockRestore();
        });
    });
});
