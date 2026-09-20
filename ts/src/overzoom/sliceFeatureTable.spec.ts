import { describe, expect, it, vi } from "vitest";
import FeatureTable from "../vector/featureTable";
import { GEOMETRY_TYPE } from "../vector/geometry/geometryType";
import { createFlatGeometryVector } from "../vector/geometry/flatGeometryVector";
import TopologyVector from "../vector/geometry/topologyVector";
import BitVector from "../vector/flat/bitVector";
import { Int32FlatVector } from "../vector/flat/int32FlatVector";
import { Int64FlatVector } from "../vector/flat/int64FlatVector";
import { createStringFlatVector } from "../vector/flat/stringFlatVector";
import { StringDictionaryVector, createStringDictionaryVector } from "../vector/dictionary/stringDictionaryVector";
import { sliceFeatureTable, sliceFeatureTableGeometry, applyFeatureTableSlice } from "./sliceFeatureTable";
import { IndexedVector } from "../vector/indexedVector";
import { FloatFlatVector } from "../vector/flat/floatFlatVector";
import { createNullableStringVector } from "../vector/flat/stringFlatVector";
import { encodeFeatureTables } from "../mltEncoder";
import decodeTile from "../mltDecoder";

describe("sliceFeatureTable", () => {
    it("binds only requested columns as indexed views and preserves types when explicitly reencoded", () => {
        const geometry = createFlatGeometryVector(
            new Int32Array([GEOMETRY_TYPE.POINT, GEOMETRY_TYPE.POINT]),
            new TopologyVector(new Uint32Array([0, 1, 2]), new Uint32Array([0, 1, 2])),
            undefined, new Int32Array([3000, 3000, 100, 100]),
        );
        const name = createStringDictionaryVector(["dropped", "kept"], "name");
        const source = new FeatureTable("places", geometry,
            new Int64FlatVector("id", new BigInt64Array([1n, 9007199254740993n]), 2), [
                name, new FloatFlatVector("height", new Float32Array([3, 2.5]), 2),
                createNullableStringVector(["dropped", null], "missing"),
            ]);
        const slice = sliceFeatureTableGeometry(source, {z: 0, x: 0, y: 0}, {z: 1, x: 0, y: 0});
        const child = applyFeatureTableSlice(source, slice, {
            deferProperties: true, propertyNames: new Set(["name"]), columnMode: "indexed",
        });
        expect(child.propertyVectors.map(vector => vector.name)).toEqual(["name"]);
        expect(name.decodedStringCount).toBe(0);
        const column = child.getPropertyVector("name") as IndexedVector;
        expect(column.source).toBe(name);
        expect(column.data).toBe(slice.sourceIndices);
        expect(child.idVector).toBeInstanceOf(IndexedVector);
        expect(child.idVector?.getValue(0)).toBe(9007199254740993n);
        expect(child.getPropertyVector("height")?.getValue(0)).toBe(2.5);
        expect(child.getPropertyVector("missing")?.has(0)).toBe(false);
        const encoded = decodeTile(new Uint8Array(encodeFeatureTables([child])), undefined, false)[0];
        expect(encoded.getFeatures()).toEqual(child.getFeatures());
        expect(encoded.getPropertyVector("height")).toBeInstanceOf(FloatFlatVector);
        expect(encoded.getPropertyVector("missing")?.getValue(0)).toBeNull();
    });

    it("reuses geometry with fresh projected columns and resolves unstyled properties only on demand", () => {
        const geometry = createFlatGeometryVector(
            new Int32Array([GEOMETRY_TYPE.POINT, GEOMETRY_TYPE.POINT]),
            new TopologyVector(new Uint32Array([0, 1, 2]), new Uint32Array([0, 1, 2])),
            undefined,
            new Int32Array([3000, 3000, 100, 200]),
        );
        const resolver = vi.fn((name: string) =>
            name === "name" ? createStringFlatVector(["dropped", "kept"], "name") : undefined,
        );
        const source = new FeatureTable(
            "places",
            geometry,
            undefined,
            [new Int32FlatVector("rank", new Int32Array([99, 7]), 2)],
            4096,
            resolver,
            ["rank", "name"],
        );
        const slice = sliceFeatureTableGeometry(source, { z: 14, x: 0, y: 0 }, { z: 15, x: 0, y: 0 });
        const child = applyFeatureTableSlice(source, slice, { deferProperties: true });
        expect(resolver).not.toHaveBeenCalled();
        expect(child.getPropertyVector("rank")?.getValue(0)).toBe(7);
        expect(child.getPropertyVector("name")?.getValue(0)).toBe("kept");
        expect(child.materializePropertyVectors().map((vector) => vector.name)).toEqual(["rank", "name"]);
        expect(child.getPropertyVector("name")?.getValue(0)).toBe("kept");
        expect(resolver).toHaveBeenCalledTimes(1);
        expect(child.availablePropertyNames).toEqual(["rank", "name"]);
        const changed = new FeatureTable("places", geometry, undefined, [
            new Int32FlatVector("height", new Int32Array([10, 20]), 2),
        ]);
        const rebound = applyFeatureTableSlice(changed, slice, { deferProperties: true });
        expect(rebound.geometryVector).toBe(child.geometryVector);
        expect(rebound.getPropertyVector("rank")).toBeUndefined();
        expect(rebound.getPropertyVector("height")?.getValue(0)).toBe(20);
    });

    it("overzooms, clips, and keeps a columnar FeatureTable", () => {
        const geometryVector = createFlatGeometryVector(
            new Int32Array([GEOMETRY_TYPE.LINESTRING, GEOMETRY_TYPE.LINESTRING]),
            new TopologyVector(new Uint32Array([0, 1, 2]), new Uint32Array([0, 2, 4])),
            undefined,
            new Int32Array([1800, 10, 2300, 10, 3000, 20, 3300, 20]),
        ) as any;
        geometryVector.getGeometries = vi.fn(() => {
            throw new Error("getGeometries should not be called");
        });
        const source = new FeatureTable("roads", geometryVector, new Int32FlatVector("id", new Int32Array([7, 9]), 2), [
            new Int32FlatVector("rank", new Int32Array([1, 2]), 2),
            createStringFlatVector(["kept", "dropped"], "name"),
        ]);

        const sliced = sliceFeatureTable(source, { z: 14, x: 0, y: 0 }, { z: 15, x: 0, y: 0 });

        expect(sliced).toBeInstanceOf(FeatureTable);
        expect(sliced.name).toBe("roads");
        expect(sliced.numFeatures).toBe(1);
        expect(sliced.idVector?.getValue(0)).toBe(7);
        expect(sliced.getPropertyVector("rank")?.getValue(0)).toBe(1);
        expect(sliced.getPropertyVector("name")?.getValue(0)).toBe("kept");
        expect(sliced.geometryVector.geometryType(0)).toBe(GEOMETRY_TYPE.LINESTRING);
        expect(sliced.geometryVector.topologyVector.partOffsets).toEqual(new Uint32Array([0, 2]));
        expect(sliced.geometryVector.getVertex(0)).toEqual([3600, 20]);
        expect(sliced.geometryVector.getVertex(1)).toEqual([4224, 20]);
        expect(geometryVector.getGeometries).not.toHaveBeenCalled();
    });

    it("clips points independently and normalizes a reduced multipoint", () => {
        const geometryVector = forbidMaterialization(
            createFlatGeometryVector(
                new Int32Array([GEOMETRY_TYPE.POINT, GEOMETRY_TYPE.MULTIPOINT]),
                new TopologyVector(new Uint32Array([0, 1, 4]), new Uint32Array([0, 1, 2, 3, 4])),
                undefined,
                new Int32Array([100, 100, 200, 200, 5000, 100, 100, -500]),
            ),
        );
        const source = new FeatureTable("places", geometryVector);

        const sliced = sliceFeatureTable(source, { z: 14, x: 0, y: 0 }, { z: 14, x: 0, y: 0 }, { buffer: 0 });

        expect(sliced.numFeatures).toBe(2);
        expect(sliced.geometryVector.geometryType(0)).toBe(GEOMETRY_TYPE.POINT);
        expect(sliced.geometryVector.geometryType(1)).toBe(GEOMETRY_TYPE.POINT);
        expect(sliced.geometryVector.topologyVector.geometryOffsets).toEqual(new Uint32Array([0, 1, 2]));
        expect(sliced.geometryVector.vertexBuffer).toEqual(new Int32Array([100, 100, 200, 200]));
        expect(geometryVector.getGeometries).not.toHaveBeenCalled();
    });

    it("emits typed multiline topology when clipping splits a line", () => {
        const geometryVector = forbidMaterialization(
            createFlatGeometryVector(
                new Int32Array([GEOMETRY_TYPE.LINESTRING]),
                new TopologyVector(new Uint32Array([0, 1]), new Uint32Array([0, 3])),
                undefined,
                new Int32Array([100, 100, 5000, 100, 100, 200]),
            ),
        );
        const source = new FeatureTable("roads", geometryVector);

        const sliced = sliceFeatureTable(source, { z: 14, x: 0, y: 0 }, { z: 14, x: 0, y: 0 }, { buffer: 0 });

        expect(sliced.geometryVector.geometryType(0)).toBe(GEOMETRY_TYPE.MULTILINESTRING);
        expect(sliced.geometryVector.topologyVector.geometryOffsets).toEqual(new Uint32Array([0, 2]));
        expect(sliced.geometryVector.topologyVector.partOffsets).toEqual(new Uint32Array([0, 2, 4]));
        expect(sliced.geometryVector.vertexBuffer).toEqual(new Int32Array([100, 100, 4096, 100, 4096, 118, 100, 200]));
        expect(geometryVector.getGeometries).not.toHaveBeenCalled();
    });

    it("clips a virtually closed polygon without storing a duplicate closing vertex", () => {
        const geometryVector = forbidMaterialization(
            createFlatGeometryVector(
                new Int32Array([GEOMETRY_TYPE.POLYGON]),
                new TopologyVector(new Uint32Array([0, 1]), new Uint32Array([0, 1]), new Uint32Array([0, 4])),
                undefined,
                new Int32Array([-100, 0, 100, 0, 100, 100, -100, 100]),
            ),
        );
        const source = new FeatureTable("land", geometryVector);

        const sliced = sliceFeatureTable(source, { z: 14, x: 0, y: 0 }, { z: 14, x: 0, y: 0 }, { buffer: 0 });

        expect(sliced.geometryVector.topologyVector.partOffsets).toEqual(new Uint32Array([0, 1]));
        expect(sliced.geometryVector.topologyVector.ringOffsets).toEqual(new Uint32Array([0, 4]));
        expect(sliced.geometryVector.vertexBuffer).toEqual(new Int32Array([0, 0, 100, 0, 100, 100, 0, 100]));
        const materializedRing = sliced.geometryVector.getGeometries()[0][0];
        expect(materializedRing).toHaveLength(5);
        expect(materializedRing[0]).toEqual(materializedRing[4]);
        expect(geometryVector.getGeometries).not.toHaveBeenCalled();
    });

    it("keeps multipolygon grouping when one polygon is rejected", () => {
        const geometryVector = forbidMaterialization(
            createFlatGeometryVector(
                new Int32Array([GEOMETRY_TYPE.MULTIPOLYGON]),
                new TopologyVector(new Uint32Array([0, 2]), new Uint32Array([0, 1, 2]), new Uint32Array([0, 4, 8])),
                undefined,
                new Int32Array([10, 10, 100, 10, 100, 100, 10, 100, 5000, 5000, 5100, 5000, 5100, 5100, 5000, 5100]),
            ),
        );
        const source = new FeatureTable("land", geometryVector);

        const sliced = sliceFeatureTable(source, { z: 14, x: 0, y: 0 }, { z: 14, x: 0, y: 0 }, { buffer: 0 });

        expect(sliced.geometryVector.geometryType(0)).toBe(GEOMETRY_TYPE.MULTIPOLYGON);
        expect(sliced.geometryVector.topologyVector.geometryOffsets).toEqual(new Uint32Array([0, 1]));
        expect(sliced.geometryVector.topologyVector.partOffsets).toEqual(new Uint32Array([0, 1]));
        expect(sliced.geometryVector.topologyVector.ringOffsets).toEqual(new Uint32Array([0, 4]));
        expect(sliced.geometryVector.getGeometries()[0]).toHaveLength(1);
        expect(geometryVector.getGeometries).not.toHaveBeenCalled();
    });

    it("preserves nullable Int64 ids and dictionary strings for selected rows", () => {
        const geometryVector = forbidMaterialization(
            createFlatGeometryVector(
                new Int32Array([GEOMETRY_TYPE.POINT, GEOMETRY_TYPE.POINT, GEOMETRY_TYPE.POINT]),
                new TopologyVector(new Uint32Array([0, 1, 2, 3]), new Uint32Array([0, 1, 2, 3])),
                undefined,
                new Int32Array([100, 100, 5000, 100, 200, 200]),
            ),
        );
        const nullability = new BitVector(new Uint8Array([0b00000011]), 3);
        const source = new FeatureTable(
            "places",
            geometryVector,
            new Int64FlatVector("id", new BigInt64Array([9007199254740993n, 22n, 0n]), nullability),
            [createStringDictionaryVector(["kept", "dropped", null], "name")],
        );

        const sliced = sliceFeatureTable(source, { z: 14, x: 0, y: 0 }, { z: 14, x: 0, y: 0 }, { buffer: 0 });

        expect(sliced.idVector).toBeInstanceOf(Int64FlatVector);
        expect(sliced.idVector?.getValue(0)).toBe(9007199254740993n);
        expect(sliced.idVector?.getValue(1)).toBeNull();
        expect(sliced.getPropertyVector("name")).toBeInstanceOf(StringDictionaryVector);
        expect(sliced.getPropertyVector("name")?.getValue(0)).toBe("kept");
        expect(sliced.getPropertyVector("name")?.getValue(1)).toBeNull();
        expect(geometryVector.getGeometries).not.toHaveBeenCalled();
    });
});

function forbidMaterialization<T extends ReturnType<typeof createFlatGeometryVector>>(
    geometryVector: T,
): T & { getGeometries: ReturnType<typeof vi.fn> } {
    const guarded = geometryVector as T & { getGeometries: ReturnType<typeof vi.fn> };
    guarded.getGeometries = vi.fn(() => {
        throw new Error("getGeometries should not be called");
    });
    return guarded;
}
