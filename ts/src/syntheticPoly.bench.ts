import { bench, describe } from "vitest";
import FeatureTable from "./vector/featureTable";
import { GeometryVector } from "./vector/geometry/geometryVector";
import { VertexBufferType } from "./vector/geometry/vertexBufferType";
import TopologyVector from "./vector/geometry/topologyVector";
import { GEOMETRY_TYPE } from "./vector/geometry/geometryType";

// Concrete implementation for synthetic polygon geometry
class SyntheticPolygonVector extends GeometryVector {
    constructor(
        private readonly _numGeometries: number,
        vertexBuffer: Int32Array,
        topologyVector: TopologyVector,
    ) {
        super(VertexBufferType.VEC_2, topologyVector, null, vertexBuffer);
    }

    containsPolygonGeometry(): boolean {
        return true;
    }

    geometryType(_index: number): number {
        return GEOMETRY_TYPE.POLYGON;
    }

    get numGeometries(): number {
        return this._numGeometries;
    }

    containsSingleGeometryType(): boolean {
        return true;
    }
}

/**
 * Creates a synthetic geometry vector with N polygons.
 * Each polygon is a square with 4 vertices (different positions).
 */
function createSyntheticPolygons(numPolygons: number): GeometryVector {
    const verticesPerPolygon = 4;
    const totalVertices = numPolygons * verticesPerPolygon;

    const vertexBuffer = new Int32Array(totalVertices * 2);
    for (let i = 0; i < numPolygons; i++) {
        const baseX = (i % 100) * 50;
        const baseY = Math.floor(i / 100) * 50;
        const size = 40;

        const offset = i * verticesPerPolygon * 2;
        vertexBuffer[offset + 0] = baseX;
        vertexBuffer[offset + 1] = baseY;
        vertexBuffer[offset + 2] = baseX + size;
        vertexBuffer[offset + 3] = baseY;
        vertexBuffer[offset + 4] = baseX + size;
        vertexBuffer[offset + 5] = baseY + size;
        vertexBuffer[offset + 6] = baseX;
        vertexBuffer[offset + 7] = baseY + size;
    }

    const partOffsets = new Int32Array(numPolygons + 1);
    for (let i = 0; i <= numPolygons; i++) {
        partOffsets[i] = i;
    }

    const ringOffsets = new Int32Array(numPolygons + 1);
    for (let i = 0; i <= numPolygons; i++) {
        ringOffsets[i] = i * verticesPerPolygon;
    }

    const topologyVector = new TopologyVector(null, partOffsets, ringOffsets);
    return new SyntheticPolygonVector(numPolygons, vertexBuffer, topologyVector);
}

const NUM_POLYGONS = 10000;

// Create geometry vector ONCE - shared across benchmarks
// Each benchmark creates a NEW FeatureTable which has its own LazyGeometryCoordinatesResolver
const sharedGeometryVector = createSyntheticPolygons(NUM_POLYGONS);

describe(`Synthetic Polygons (${NUM_POLYGONS} features) - Lazy vs Eager`, () => {
    bench("Lazy: Single geometry access (1 feature)", () => {
        // New FeatureTable = new LazyGeometryCoordinatesResolver (no cache)
        const featureTable = new FeatureTable("test", sharedGeometryVector, undefined, []);
        const features = featureTable.getLayer();

        // Access only 1 geometry out of 10,000
        const coords = features.feature(500).geometry.coordinates;
        if (!coords) throw new Error("Bench guard");
    });

    bench("Lazy: Sparse access (10 features = 1%)", () => {
        const featureTable = new FeatureTable("test", sharedGeometryVector, undefined, []);
        const features = featureTable.getLayer();

        // Access 10 evenly distributed features
        const step = Math.floor(NUM_POLYGONS / 10);
        for (let i = 0; i < NUM_POLYGONS; i += step) {
            const coords = features.feature(i).geometry.coordinates;
            if (!coords) throw new Error("Bench guard");
        }
    });

    bench("Lazy: Sparse access (50 features = 5%)", () => {
        const featureTable = new FeatureTable("test", sharedGeometryVector, undefined, []);
        const features = featureTable.getLayer();

        const step = Math.floor(NUM_POLYGONS / 50);
        for (let i = 0; i < NUM_POLYGONS; i += step) {
            const coords = features.feature(i).geometry.coordinates;
            if (!coords) throw new Error("Bench guard");
        }
    });

    bench("Lazy: Type-only access (no coordinates)", () => {
        const featureTable = new FeatureTable("test", sharedGeometryVector, undefined, []);
        const features = featureTable.getLayer();

        // Only access geometry.type, never coordinates
        let sum = 0;
        for (const feature of features) {
            sum += feature.geometry.type;
        }
        if (sum === -999999) throw new Error("Bench guard");
    });

    bench("Lazy: Full sequential access (all 10000)", () => {
        const featureTable = new FeatureTable("test", sharedGeometryVector, undefined, []);
        const features = featureTable.getLayer();

        // Access ALL geometries - triggers bulk materialization after threshold
        for (const feature of features) {
            const coords = feature.geometry.coordinates;
            if (!coords) throw new Error("Bench guard");
        }
    });

    bench("Eager: Direct getGeometries() (baseline)", () => {
        // Directly call getGeometries() - no lazy wrapper, immediate bulk conversion
        const allGeometries = sharedGeometryVector.getGeometries();
        if (allGeometries.length !== NUM_POLYGONS) throw new Error("Bench guard");
    });
});

describe(`Filter Simulation (${NUM_POLYGONS} features)`, () => {
    bench("Filter: id = 500 (1 match)", () => {
        const featureTable = new FeatureTable("test", sharedGeometryVector, undefined, []);
        const features = featureTable.getLayer();

        // Simulate filter that matches only 1 feature at index 500
        const targetId = 500;
        const coords = features.feature(targetId).geometry.coordinates;
        if (!coords) throw new Error("Bench guard");
    });

    bench("Filter: first 10 (sequential)", () => {
        const featureTable = new FeatureTable("test", sharedGeometryVector, undefined, []);
        const features = featureTable.getLayer();

        for (let i = 0; i < 10; i++) {
            const coords = features.feature(i).geometry.coordinates;
            if (!coords) throw new Error("Bench guard");
        }
    });

    bench("Filter: every 20th (5% = 50 features)", () => {
        const featureTable = new FeatureTable("test", sharedGeometryVector, undefined, []);
        const features = featureTable.getLayer();

        for (let i = 0; i < features.length; i += 20) {
            const coords = features.feature(i).geometry.coordinates;
            if (!coords) throw new Error("Bench guard");
        }
    });
});

import { convertSingleGeometry, convertGeometryVector } from "./vector/geometry/geometryVectorConverter";

describe(`Raw Low-Level Performance (No FeatureTable Overhead)`, () => {
    bench("Raw Lazy: convertSingleGeometry(0)", () => {
        const coords = convertSingleGeometry(sharedGeometryVector, 0);
        if (!coords) throw new Error("Guard");
    });

    bench("Raw Eager: convertGeometryVector()", () => {
        const all = convertGeometryVector(sharedGeometryVector);
        if (all.length !== NUM_POLYGONS) throw new Error("Guard");
    });
});
