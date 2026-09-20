import { describe, expect, it, vi } from "vitest";
import decodeTile from "./mltDecoder";
import { encodeFeatureTables } from "./mltEncoder";
import FeatureTable from "./vector/featureTable";
import BitVector from "./vector/flat/bitVector";
import { BooleanFlatVector } from "./vector/flat/booleanFlatVector";
import { DoubleFlatVector } from "./vector/flat/doubleFlatVector";
import { FloatFlatVector } from "./vector/flat/floatFlatVector";
import { Int32FlatVector } from "./vector/flat/int32FlatVector";
import { Int64FlatVector } from "./vector/flat/int64FlatVector";
import { Int32ConstVector } from "./vector/constant/int32ConstVector";
import { Int64ConstVector } from "./vector/constant/int64ConstVector";
import { Int32SequenceVector } from "./vector/sequence/int32SequenceVector";
import { Int64SequenceVector } from "./vector/sequence/int64SequenceVector";
import { createNullableStringVector } from "./vector/flat/stringFlatVector";
import { createStringDictionaryVector } from "./vector/dictionary/stringDictionaryVector";
import { createFlatGeometryVector } from "./vector/geometry/flatGeometryVector";
import { GEOMETRY_TYPE } from "./vector/geometry/geometryType";
import TopologyVector from "./vector/geometry/topologyVector";

describe("encodeFeatureTables", () => {
    it("round-trips mixed columnar geometry, ids, and scalar properties", () => {
        const vertices = new Int32Array([
            1, 1, 10, 10, 20, 20, 30, 30, 40, 30, 40, 40, 30, 40, 50, 50, 60, 60, 70, 70, 80, 80, 90, 90, 100, 100, 110,
            110, 120, 110, 120, 120, 110, 120, 130, 130, 140, 130, 140, 140, 130, 140,
        ]);
        const geometryVector = createFlatGeometryVector(
            new Int32Array([
                GEOMETRY_TYPE.POINT,
                GEOMETRY_TYPE.LINESTRING,
                GEOMETRY_TYPE.POLYGON,
                GEOMETRY_TYPE.MULTIPOINT,
                GEOMETRY_TYPE.MULTILINESTRING,
                GEOMETRY_TYPE.MULTIPOLYGON,
            ]),
            new TopologyVector(
                new Uint32Array([0, 1, 2, 3, 5, 7, 9]),
                new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
                new Uint32Array([0, 1, 3, 7, 8, 9, 11, 13, 17, 21]),
            ),
            undefined,
            vertices,
        ) as ReturnType<typeof createFlatGeometryVector> & { getGeometries: ReturnType<typeof vi.fn> };
        geometryVector.getGeometries = vi.fn(() => {
            throw new Error("The encoder must not materialize geometry");
        });

        const featureCount = 6;
        const table = new FeatureTable(
            "mixed",
            geometryVector,
            new Int64FlatVector(
                "id",
                new BigUint64Array([1n, 2n, 0n, 4n, 5n, 18446744073709551615n]),
                bitVector([true, true, false, true, true, true]),
            ),
            [
                new BooleanFlatVector(
                    "visible",
                    bitVector([true, false, true, false, true, false]),
                    bitVector([true, true, false, true, true, true]),
                ),
                new Int32FlatVector("rank", new Int32Array([-3, -2, -1, 0, 1, 2]), featureCount),
                new Int32FlatVector("population", new Uint32Array([0, 1, 2, 3, 4, 0xffffffff]), featureCount),
                new Int64FlatVector("signed64", new BigInt64Array([-4n, -3n, -2n, -1n, 0n, 1n]), featureCount),
                new Int64FlatVector(
                    "unsigned64",
                    new BigUint64Array([0n, 1n, 2n, 3n, 4n, 18446744073709551615n]),
                    featureCount,
                ),
                new Int32ConstVector("const32", -7, featureCount, true),
                new Int64ConstVector("const64", 9007199254740993n, featureCount, false),
                new Int32SequenceVector("sequence32", 2, 2, featureCount),
                new Int64SequenceVector("sequence64", 3n, 3n, featureCount),
                new FloatFlatVector("ratio", new Float32Array([0.5, 1.5, 2.5, 3.5, 4.5, 5.5]), featureCount),
                new DoubleFlatVector("precise", new Float64Array([0.1, 1.1, 2.1, 3.1, 4.1, 5.1]), featureCount),
                createNullableStringVector(["a", null, "c", "d", "e", "f"], "label"),
                createStringDictionaryVector(["road", "road", null, "water", "road", "water"], "class"),
            ],
            8192,
        );

        const pointTable = new FeatureTable(
            "points",
            createFlatGeometryVector(
                new Int32Array([GEOMETRY_TYPE.POINT]),
                new TopologyVector(),
                undefined,
                new Int32Array([7, 8]),
            ),
            undefined,
            [new DoubleFlatVector("weight", new Float64Array([12.25]), 1)],
            4096,
        );

        const encoded = encodeFeatureTables([table, pointTable]);
        const decoded = decodeTile(new Uint8Array(encoded), undefined, false);

        expect(encoded.byteLength).toBeGreaterThan(0);
        expect(decoded.map((featureTable) => featureTable.name)).toEqual(["mixed", "points"]);
        const mixed = decoded[0];
        expect(mixed.extent).toBe(8192);
        expect(Array.from({ length: featureCount }, (_, index) => mixed.geometryVector.geometryType(index))).toEqual([
            GEOMETRY_TYPE.POINT,
            GEOMETRY_TYPE.LINESTRING,
            GEOMETRY_TYPE.POLYGON,
            GEOMETRY_TYPE.MULTIPOINT,
            GEOMETRY_TYPE.MULTILINESTRING,
            GEOMETRY_TYPE.MULTIPOLYGON,
        ]);
        expect(mixed.geometryVector.topologyVector.geometryOffsets).toEqual(new Uint32Array([0, 1, 2, 3, 5, 7, 9]));
        expect(mixed.geometryVector.topologyVector.partOffsets).toEqual(
            new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
        );
        expect(mixed.geometryVector.topologyVector.ringOffsets).toEqual(
            new Uint32Array([0, 1, 3, 7, 8, 9, 11, 13, 17, 21]),
        );
        expect(mixed.geometryVector.vertexBuffer).toEqual(vertices);
        expect(values(mixed.idVector, featureCount)).toEqual([1n, 2n, null, 4n, 5n, 18446744073709551615n]);
        expect(values(mixed.getPropertyVector("visible"), featureCount)).toEqual([
            true,
            false,
            null,
            false,
            true,
            false,
        ]);
        expect(values(mixed.getPropertyVector("rank"), featureCount)).toEqual([-3, -2, -1, 0, 1, 2]);
        expect(values(mixed.getPropertyVector("population"), featureCount)).toEqual([0, 1, 2, 3, 4, 0xffffffff]);
        expect(values(mixed.getPropertyVector("signed64"), featureCount)).toEqual([-4n, -3n, -2n, -1n, 0n, 1n]);
        expect(values(mixed.getPropertyVector("unsigned64"), featureCount)).toEqual([
            0n,
            1n,
            2n,
            3n,
            4n,
            18446744073709551615n,
        ]);
        expect(mixed.getPropertyVector("const32")).toBeInstanceOf(Int32ConstVector);
        expect(values(mixed.getPropertyVector("const32"), featureCount)).toEqual([-7, -7, -7, -7, -7, -7]);
        expect(mixed.getPropertyVector("const64")).toBeInstanceOf(Int64ConstVector);
        expect(values(mixed.getPropertyVector("const64"), featureCount)).toEqual(
            Array(featureCount).fill(9007199254740993n),
        );
        expect(mixed.getPropertyVector("sequence32")).toBeInstanceOf(Int32SequenceVector);
        expect(values(mixed.getPropertyVector("sequence32"), featureCount)).toEqual([2, 4, 6, 8, 10, 12]);
        expect(mixed.getPropertyVector("sequence64")).toBeInstanceOf(Int64SequenceVector);
        expect(values(mixed.getPropertyVector("sequence64"), featureCount)).toEqual([3n, 6n, 9n, 12n, 15n, 18n]);
        expect(values(mixed.getPropertyVector("ratio"), featureCount)).toEqual([0.5, 1.5, 2.5, 3.5, 4.5, 5.5]);
        expect(values(mixed.getPropertyVector("precise"), featureCount)).toEqual([0.1, 1.1, 2.1, 3.1, 4.1, 5.1]);
        expect(values(mixed.getPropertyVector("label"), featureCount)).toEqual(["a", null, "c", "d", "e", "f"]);
        expect(values(mixed.getPropertyVector("class"), featureCount)).toEqual([
            "road",
            "road",
            null,
            "water",
            "road",
            "water",
        ]);
        expect(decoded[1].geometryVector.getVertex(0)).toEqual([7, 8]);
        expect(decoded[1].getPropertyVector("weight")?.getValue(0)).toBe(12.25);
        expect(geometryVector.getGeometries).not.toHaveBeenCalled();
    });
});

function bitVector(values: boolean[]): BitVector {
    const bytes = new Uint8Array(Math.ceil(values.length / 8));
    const result = new BitVector(bytes, values.length);
    values.forEach((value, index) => result.set(index, value));
    return result;
}

function values(vector: { getValue(index: number): unknown } | undefined, size: number): unknown[] {
    if (!vector) throw new Error("Expected vector");
    return Array.from({ length: size }, (_value, index) => vector.getValue(index));
}
