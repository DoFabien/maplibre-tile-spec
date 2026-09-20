import { expect, it } from "vitest";
import FeatureTable from "../vector/featureTable";
import { createFlatGeometryVector, createFlatGeometryVectorMortonEncoded } from "../vector/geometry/flatGeometryVector";
import { GEOMETRY_TYPE } from "../vector/geometry/geometryType";
import TopologyVector from "../vector/geometry/topologyVector";
import { sliceFeatureTableGeometry } from "./sliceFeatureTable";

it("preserves dense, dictionary and Morton coordinates through transformed clipping", () => {
    const points = [
        [-10, 4],
        [2200, 120],
        [100, 2200],
        [200, 200],
        [2200, -200],
    ];
    const types = new Int32Array([GEOMETRY_TYPE.LINESTRING, GEOMETRY_TYPE.LINESTRING, GEOMETRY_TYPE.LINESTRING]);
    const topology = new TopologyVector(new Uint32Array([0, 1, 2, 3]), new Uint32Array([0, 3, 5, 5]));
    const offsets = new Uint32Array([4, 3, 2, 1, 0]);
    const dictionary = points.slice().reverse();
    const dense = createFlatGeometryVector(types, topology, undefined, new Int32Array(points.flat()));
    const indexed = createFlatGeometryVector(types, topology, offsets, new Int32Array(dictionary.flat()));
    const codes = new Uint32Array(dictionary.map(([x, y]) => mortonCode(x + 4096, y + 4096)));
    const morton = createFlatGeometryVectorMortonEncoded(types, topology, offsets, codes, {
        numBits: 14,
        coordinateShift: 4096,
    });
    const saved = codes.slice();
    for (const buffer of [0, 128])
        for (const child of [
            { z: 1, x: 0, y: 0 },
            { z: 3, x: 2, y: 1 },
        ]) {
            const expected = sliceFeatureTableGeometry(new FeatureTable("roads", dense), { z: 0, x: 0, y: 0 }, child, {
                buffer,
            });
            for (const geometry of [indexed, morton]) {
                expect(
                    sliceFeatureTableGeometry(new FeatureTable("roads", geometry), { z: 0, x: 0, y: 0 }, child, {
                        buffer,
                    }),
                ).toEqual(expected);
            }
        }
    expect(codes).toEqual(saved);
    expect(offsets).toEqual(new Uint32Array([4, 3, 2, 1, 0]));
});

it.each([GEOMETRY_TYPE.LINESTRING, GEOMETRY_TYPE.POLYGON])(
    "keeps empty and singleton parts isolated for geometry type %s",
    (type) => {
        const polygon = type === GEOMETRY_TYPE.POLYGON;
        const geometry = createFlatGeometryVector(
            new Int32Array([type, type, type]),
            new TopologyVector(
                new Uint32Array([0, 1, 2, 3]),
                new Uint32Array(polygon ? [0, 1, 2, 3] : [0, 0, 1, 1]),
                polygon ? new Uint32Array([0, 0, 1, 1]) : undefined,
            ),
            undefined,
            new Int32Array([10, 20]),
        );
        const result = sliceFeatureTableGeometry(
            new FeatureTable("test", geometry),
            { z: 0, x: 0, y: 0 },
            { z: 1, x: 0, y: 0 },
        );
        expect(result.sourceIndices).toEqual(new Uint32Array([1]));
        expect(result.geometryVector.vertexBuffer).toEqual(new Int32Array([20, 40]));
        expect(result.geometryVector.topologyVector.geometryOffsets).toEqual(new Uint32Array([0, 1]));
        expect(result.geometryVector.topologyVector.partOffsets).toEqual(new Uint32Array([0, 1]));
        expect(result.geometryVector.topologyVector.ringOffsets).toEqual(polygon ? new Uint32Array([0, 1]) : undefined);
    },
);

/** Encodes the fixture's nonnegative fourteen-bit coordinates independently of the production reader. */
function mortonCode(x: number, y: number): number {
    let code = 0;
    for (let bit = 0; bit < 14; bit++) code |= (((x >> bit) & 1) << (2 * bit)) | (((y >> bit) & 1) << (2 * bit + 1));
    return code;
}
