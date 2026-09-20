import { describe, it, expect, beforeEach } from "vitest";
import { convertGeometryVector, getSimpleEncodedVertex, getVertex } from "./geometryVectorUtils";
import { GEOMETRY_TYPE } from "./geometryType";
import TopologyVector from "./topologyVector";
import { type MortonSettings } from "./geometryVector";
import Point from "@mapbox/point-geometry";
import { createFlatGeometryVector, createFlatGeometryVectorMortonEncoded } from "./flatGeometryVector";
import { createConstGeometryVector, createMortonEncodedConstGeometryVector } from "./constGeometryVector";
import { encodeZOrderCurve } from "../../encoding/zOrderCurveEncoder";

describe("GeometryVectorUtils", () => {
    let mortonSettings: MortonSettings;

    beforeEach(() => {
        mortonSettings = { numBits: 15, coordinateShift: 0 };
    });

    describe("getSimpleEncodedVertex", () => {
        it("should decode vertex without and with vertexOffsets", () => {
            const vertexBuffer = new Int32Array([10, 20, 30, 40, 50, 60]);
            expect(getSimpleEncodedVertex(1, null, vertexBuffer)).toEqual([30, 40]);

            const vertexOffsets = new Int32Array([0, 2, 1]);
            expect(getSimpleEncodedVertex(1, vertexOffsets, vertexBuffer)).toEqual([50, 60]);
        });
    });

    describe("getVertex", () => {
        it("should decode vertex with different configurations", () => {
            const vertexBuffer = new Int32Array([10, 20, 30, 40, 50, 60]);

            expect(getVertex(1, null, vertexBuffer)).toEqual([30, 40]);
            expect(getVertex(0, null, vertexBuffer, mortonSettings)).toEqual([10, 20]);

            const vertexOffsets = new Int32Array([0, 2, 1]);
            expect(getVertex(1, vertexOffsets, vertexBuffer)).toEqual([50, 60]);

            const morton = encodeZOrderCurve(100, 200, 15, 0);
            expect(getVertex(0, new Int32Array([0]), new Int32Array([morton]), mortonSettings)).toEqual([100, 200]);
        });
    });

    /**
     * Geometry construction from vectors:
     *
     * TopologyVector(geometryOffsets, partOffsets, ringOffsets):
     * - geometryOffsets: Index into partOffsets for each geometry
     * - partOffsets: Index into ringOffsets for each part (multi-geometries have multiple parts)
     * - ringOffsets: Index into vertexBuffer for each ring (polygons can have holes)
     *
     * vertexOffsets: Optional dictionary for vertex deduplication
     * - If null/empty: vertices read sequentially from vertexBuffer
     * - If present: vertexOffsets[i] points to vertex position in vertexBuffer
     *
     * vertexBuffer: Flat array of coordinates
     * - VEC_2: [x1, y1, x2, y2, ...]
     * - MORTON: [morton1, morton2, ...] where morton = interleaved(x, y)
     *
     * Example POLYGON with hole:
     * - geometryOffsets=[0,1]: geometry 0 uses parts [0,1)
     * - partOffsets=[0,2]: part 0 uses rings [0,2)
     * - ringOffsets=[0,4,8]: ring 0 uses vertices [0,4), ring 1 uses vertices [4,8)
     * - vertexBuffer=[0,0,10,0,10,10,0,10, 2,2,8,2,8,8,2,8] (outer + inner ring)
     */
    describe("convertGeometryVector", () => {
        describe("POINT", () => {
            it("should convert points with various encodings", () => {
                const flat = createFlatGeometryVector(
                    new Int32Array([GEOMETRY_TYPE.POINT]),
                    new TopologyVector(new Uint32Array([0, 1]), new Uint32Array([0, 1]), new Uint32Array([0, 1])),
                    new Int32Array([]),
                    new Int32Array([10, 20]),
                );
                expect(convertGeometryVector(flat)[0]).toEqual([[new Point(10, 20)]]);

                const withOffsets = createFlatGeometryVector(
                    new Int32Array([GEOMETRY_TYPE.POINT]),
                    new TopologyVector(new Uint32Array([0, 1]), new Uint32Array([0, 1]), new Uint32Array([0, 1])),
                    new Int32Array([1]),
                    new Int32Array([10, 20, 30, 40]),
                );
                expect(convertGeometryVector(withOffsets)[0]).toEqual([[new Point(30, 40)]]);

                const morton = createFlatGeometryVectorMortonEncoded(
                    new Int32Array([GEOMETRY_TYPE.POINT]),
                    new TopologyVector(new Uint32Array([0, 1]), new Uint32Array([0, 1]), new Uint32Array([0, 1])),
                    new Int32Array([0]),
                    new Int32Array([encodeZOrderCurve(100, 200, 15, 0)]),
                    mortonSettings,
                );
                expect(convertGeometryVector(morton)[0]).toEqual([[new Point(100, 200)]]);
            });
        });

        describe("MULTIPOINT", () => {
            it("should convert multipoints", () => {
                const flat = createFlatGeometryVector(
                    new Int32Array([GEOMETRY_TYPE.MULTIPOINT]),
                    new TopologyVector(new Uint32Array([0, 2]), new Uint32Array([0]), new Uint32Array([0])),
                    new Int32Array([]),
                    new Int32Array([10, 20, 30, 40]),
                );
                expect(convertGeometryVector(flat)[0]).toEqual([[new Point(10, 20)], [new Point(30, 40)]]);

                const withOffsets = createFlatGeometryVector(
                    new Int32Array([GEOMETRY_TYPE.MULTIPOINT]),
                    new TopologyVector(new Uint32Array([0, 2]), new Uint32Array([0]), new Uint32Array([0])),
                    new Int32Array([0, 2]),
                    new Int32Array([10, 20, 30, 40, 50, 60]),
                );
                expect(convertGeometryVector(withOffsets)[0]).toEqual([[new Point(10, 20)], [new Point(50, 60)]]);
            });
        });

        describe("LINESTRING", () => {
            it("should convert linestrings with containsPolygon=false", () => {
                const flat = createFlatGeometryVector(
                    new Int32Array([GEOMETRY_TYPE.LINESTRING]),
                    new TopologyVector(new Uint32Array([0, 1]), new Uint32Array([0, 3]), new Uint32Array([0])),
                    new Int32Array([]),
                    new Int32Array([10, 20, 30, 40, 50, 60]),
                );
                expect(convertGeometryVector(flat)[0]).toEqual([
                    [new Point(10, 20), new Point(30, 40), new Point(50, 60)],
                ]);
            });

            it("should convert linestrings with containsPolygon=true", () => {
                const withPolygon = createFlatGeometryVector(
                    new Int32Array([GEOMETRY_TYPE.POLYGON, GEOMETRY_TYPE.LINESTRING]),
                    new TopologyVector(
                        new Uint32Array([0, 1, 2]),
                        new Uint32Array([0, 1, 2]),
                        new Uint32Array([0, 1, 3]),
                    ),
                    new Int32Array([]),
                    new Int32Array([0, 0, 10, 20, 30, 40]),
                );
                expect(convertGeometryVector(withPolygon)[1]).toEqual([[new Point(10, 20), new Point(30, 40)]]);
            });

            it("should convert linestrings with offsets and Morton", () => {
                const withOffsets = createFlatGeometryVector(
                    new Int32Array([GEOMETRY_TYPE.LINESTRING]),
                    new TopologyVector(new Uint32Array([0, 1]), new Uint32Array([0, 3]), new Uint32Array([0])),
                    new Int32Array([0, 1, 2]),
                    new Int32Array([10, 20, 30, 40, 50, 60]),
                );
                expect(convertGeometryVector(withOffsets)[0]).toEqual([
                    [new Point(10, 20), new Point(30, 40), new Point(50, 60)],
                ]);

                const morton = createFlatGeometryVectorMortonEncoded(
                    new Int32Array([GEOMETRY_TYPE.LINESTRING]),
                    new TopologyVector(new Uint32Array([0, 1]), new Uint32Array([0, 2]), new Uint32Array([0])),
                    new Int32Array([0, 1]),
                    new Int32Array([encodeZOrderCurve(10, 20, 15, 0), encodeZOrderCurve(30, 40, 15, 0)]),
                    mortonSettings,
                );
                expect(convertGeometryVector(morton)[0]).toEqual([[new Point(10, 20), new Point(30, 40)]]);
            });
        });

        describe("POLYGON", () => {
            it("should convert polygon without offsets", () => {
                const poly = createFlatGeometryVector(
                    new Int32Array([GEOMETRY_TYPE.POLYGON]),
                    new TopologyVector(new Uint32Array([0, 1]), new Uint32Array([0, 2]), new Uint32Array([0, 4, 8])),
                    new Int32Array([]),
                    new Int32Array([0, 0, 10, 0, 10, 10, 0, 10, 2, 2, 8, 2, 8, 8, 2, 8]),
                );
                const result = convertGeometryVector(poly);
                expect(result[0][0]).toEqual([
                    new Point(0, 0),
                    new Point(10, 0),
                    new Point(10, 10),
                    new Point(0, 10),
                    new Point(0, 0),
                ]);
                expect(result[0][1]).toEqual([
                    new Point(2, 2),
                    new Point(8, 2),
                    new Point(8, 8),
                    new Point(2, 8),
                    new Point(2, 2),
                ]);
            });

            it("should convert polygon with VEC_2 offsets single ring", () => {
                const poly = createFlatGeometryVector(
                    new Int32Array([GEOMETRY_TYPE.POLYGON]),
                    new TopologyVector(new Uint32Array([0, 1]), new Uint32Array([0, 1]), new Uint32Array([0, 3])),
                    new Int32Array([0, 1, 2]),
                    new Int32Array([0, 0, 10, 0, 10, 10]),
                );
                expect(convertGeometryVector(poly)[0][0]).toEqual([
                    new Point(0, 0),
                    new Point(10, 0),
                    new Point(10, 10),
                    new Point(0, 0),
                ]);
            });

            it("should convert polygon with VEC_2 offsets multiple rings", () => {
                const poly = createFlatGeometryVector(
                    new Int32Array([GEOMETRY_TYPE.POLYGON]),
                    new TopologyVector(new Uint32Array([0, 1]), new Uint32Array([0, 2]), new Uint32Array([0, 4, 8])),
                    new Int32Array([0, 1, 2, 3, 4, 5, 6, 7]),
                    new Int32Array([0, 0, 10, 0, 10, 10, 0, 10, 2, 2, 8, 2, 8, 8, 2, 8]),
                );
                const result = convertGeometryVector(poly);
                expect(result[0][0]).toEqual([
                    new Point(0, 0),
                    new Point(10, 0),
                    new Point(10, 10),
                    new Point(0, 10),
                    new Point(0, 0),
                ]);
                expect(result[0][1]).toEqual([
                    new Point(2, 2),
                    new Point(8, 2),
                    new Point(8, 8),
                    new Point(2, 8),
                    new Point(2, 2),
                ]);
            });

            it("should convert polygon with Morton encoding", () => {
                const singleRing = createFlatGeometryVectorMortonEncoded(
                    new Int32Array([GEOMETRY_TYPE.POLYGON]),
                    new TopologyVector(new Uint32Array([0, 1]), new Uint32Array([0, 1]), new Uint32Array([0, 3])),
                    new Int32Array([0, 1, 2]),
                    new Int32Array([
                        encodeZOrderCurve(0, 0, 15, 0),
                        encodeZOrderCurve(10, 0, 15, 0),
                        encodeZOrderCurve(10, 10, 15, 0),
                    ]),
                    mortonSettings,
                );
                expect(convertGeometryVector(singleRing)[0][0]).toEqual([
                    new Point(0, 0),
                    new Point(10, 0),
                    new Point(10, 10),
                    new Point(0, 0),
                ]);

                const multiRing = createFlatGeometryVectorMortonEncoded(
                    new Int32Array([GEOMETRY_TYPE.POLYGON]),
                    new TopologyVector(new Uint32Array([0, 1]), new Uint32Array([0, 2]), new Uint32Array([0, 4, 8])),
                    new Int32Array([0, 1, 2, 3, 4, 5, 6, 7]),
                    new Int32Array([
                        encodeZOrderCurve(0, 0, 15, 0),
                        encodeZOrderCurve(10, 0, 15, 0),
                        encodeZOrderCurve(10, 10, 15, 0),
                        encodeZOrderCurve(0, 10, 15, 0),
                        encodeZOrderCurve(2, 2, 15, 0),
                        encodeZOrderCurve(8, 2, 15, 0),
                        encodeZOrderCurve(8, 8, 15, 0),
                        encodeZOrderCurve(2, 8, 15, 0),
                    ]),
                    mortonSettings,
                );
                const result = convertGeometryVector(multiRing);
                expect(result[0][0]).toEqual([
                    new Point(0, 0),
                    new Point(10, 0),
                    new Point(10, 10),
                    new Point(0, 10),
                    new Point(0, 0),
                ]);
                expect(result[0][1]).toEqual([
                    new Point(2, 2),
                    new Point(8, 2),
                    new Point(8, 8),
                    new Point(2, 8),
                    new Point(2, 2),
                ]);
            });
        });

        describe("MULTILINESTRING", () => {
            it("should convert multilinestring without polygon", () => {
                const mls = createFlatGeometryVector(
                    new Int32Array([GEOMETRY_TYPE.MULTILINESTRING]),
                    new TopologyVector(new Uint32Array([0, 2]), new Uint32Array([0, 2, 4]), new Uint32Array([0])),
                    new Int32Array([]),
                    new Int32Array([10, 20, 30, 40, 50, 60, 70, 80]),
                );
                const result = convertGeometryVector(mls);
                expect(result[0][0]).toEqual([new Point(10, 20), new Point(30, 40)]);
                expect(result[0][1]).toEqual([new Point(50, 60), new Point(70, 80)]);
            });

            it("should convert multilinestring with polygon", () => {
                const mls = createFlatGeometryVector(
                    new Int32Array([GEOMETRY_TYPE.POLYGON, GEOMETRY_TYPE.MULTILINESTRING]),
                    new TopologyVector(
                        new Uint32Array([0, 1, 3]),
                        new Uint32Array([0, 1, 2, 3]),
                        new Uint32Array([0, 1, 3, 5]),
                    ),
                    new Int32Array([0, 1, 2, 3, 4]),
                    new Int32Array([0, 0, 10, 20, 30, 40, 50, 60, 70, 80]),
                );
                const result = convertGeometryVector(mls);
                expect(result[1][0]).toEqual([new Point(10, 20), new Point(30, 40)]);
                expect(result[1][1]).toEqual([new Point(50, 60), new Point(70, 80)]);
            });

            it("should convert multilinestring with Morton", () => {
                const mls = createFlatGeometryVectorMortonEncoded(
                    new Int32Array([GEOMETRY_TYPE.MULTILINESTRING]),
                    new TopologyVector(new Uint32Array([0, 2]), new Uint32Array([0, 2, 4]), new Uint32Array([0])),
                    new Int32Array([0, 1, 2, 3]),
                    new Int32Array([
                        encodeZOrderCurve(10, 20, 15, 0),
                        encodeZOrderCurve(30, 40, 15, 0),
                        encodeZOrderCurve(50, 60, 15, 0),
                        encodeZOrderCurve(70, 80, 15, 0),
                    ]),
                    mortonSettings,
                );
                const result = convertGeometryVector(mls);
                expect(result[0][0]).toEqual([new Point(10, 20), new Point(30, 40)]);
                expect(result[0][1]).toEqual([new Point(50, 60), new Point(70, 80)]);

                const mlsWithPoly = createFlatGeometryVectorMortonEncoded(
                    new Int32Array([GEOMETRY_TYPE.POLYGON, GEOMETRY_TYPE.MULTILINESTRING]),
                    new TopologyVector(
                        new Uint32Array([0, 1, 2]),
                        new Uint32Array([0, 1, 2]),
                        new Uint32Array([0, 1, 3]),
                    ),
                    new Int32Array([0, 1, 2]),
                    new Int32Array([
                        encodeZOrderCurve(0, 0, 15, 0),
                        encodeZOrderCurve(10, 20, 15, 0),
                        encodeZOrderCurve(30, 40, 15, 0),
                    ]),
                    mortonSettings,
                );
                expect(convertGeometryVector(mlsWithPoly)[1][0]).toEqual([new Point(10, 20), new Point(30, 40)]);
            });
        });

        describe("MULTIPOLYGON", () => {
            it("should convert multipolygon without offsets", () => {
                const mp = createFlatGeometryVector(
                    new Int32Array([GEOMETRY_TYPE.MULTIPOLYGON]),
                    new TopologyVector(new Uint32Array([0, 2]), new Uint32Array([0, 1, 2]), new Uint32Array([0, 4, 8])),
                    new Int32Array([]),
                    new Int32Array([0, 0, 10, 0, 10, 10, 0, 10, 20, 20, 30, 20, 30, 30, 20, 30]),
                );
                const result = convertGeometryVector(mp);
                expect(result[0][0]).toEqual([
                    new Point(0, 0),
                    new Point(10, 0),
                    new Point(10, 10),
                    new Point(0, 10),
                    new Point(0, 0),
                ]);
                expect(result[0][1]).toEqual([
                    new Point(20, 20),
                    new Point(30, 20),
                    new Point(30, 30),
                    new Point(20, 30),
                    new Point(20, 20),
                ]);
            });

            it("should convert multipolygon with offsets and multiple rings", () => {
                const mp = createFlatGeometryVector(
                    new Int32Array([GEOMETRY_TYPE.MULTIPOLYGON]),
                    new TopologyVector(new Uint32Array([0, 1]), new Uint32Array([0, 2]), new Uint32Array([0, 4, 8])),
                    new Int32Array([0, 1, 2, 3, 4, 5, 6, 7]),
                    new Int32Array([0, 0, 10, 0, 10, 10, 0, 10, 2, 2, 8, 2, 8, 8, 2, 8]),
                );
                const result = convertGeometryVector(mp);
                expect(result[0][0]).toEqual([
                    new Point(0, 0),
                    new Point(10, 0),
                    new Point(10, 10),
                    new Point(0, 10),
                    new Point(0, 0),
                ]);
                expect(result[0][1]).toEqual([
                    new Point(2, 2),
                    new Point(8, 2),
                    new Point(8, 8),
                    new Point(2, 8),
                    new Point(2, 2),
                ]);
            });

            it("should convert multipolygon with Morton", () => {
                const mp = createFlatGeometryVectorMortonEncoded(
                    new Int32Array([GEOMETRY_TYPE.MULTIPOLYGON]),
                    new TopologyVector(new Uint32Array([0, 1]), new Uint32Array([0, 1]), new Uint32Array([0, 4])),
                    new Int32Array([0, 1, 2, 3]),
                    new Int32Array([
                        encodeZOrderCurve(0, 0, 15, 0),
                        encodeZOrderCurve(10, 0, 15, 0),
                        encodeZOrderCurve(10, 10, 15, 0),
                        encodeZOrderCurve(0, 10, 15, 0),
                    ]),
                    mortonSettings,
                );
                expect(convertGeometryVector(mp)[0][0]).toEqual([
                    new Point(0, 0),
                    new Point(10, 0),
                    new Point(10, 10),
                    new Point(0, 10),
                    new Point(0, 0),
                ]);

                const mpRings = createFlatGeometryVectorMortonEncoded(
                    new Int32Array([GEOMETRY_TYPE.MULTIPOLYGON]),
                    new TopologyVector(new Uint32Array([0, 1]), new Uint32Array([0, 2]), new Uint32Array([0, 4, 8])),
                    new Int32Array([0, 1, 2, 3, 4, 5, 6, 7]),
                    new Int32Array([
                        encodeZOrderCurve(0, 0, 15, 0),
                        encodeZOrderCurve(10, 0, 15, 0),
                        encodeZOrderCurve(10, 10, 15, 0),
                        encodeZOrderCurve(0, 10, 15, 0),
                        encodeZOrderCurve(2, 2, 15, 0),
                        encodeZOrderCurve(8, 2, 15, 0),
                        encodeZOrderCurve(8, 8, 15, 0),
                        encodeZOrderCurve(2, 8, 15, 0),
                    ]),
                    mortonSettings,
                );
                const result = convertGeometryVector(mpRings);
                expect(result[0][0]).toEqual([
                    new Point(0, 0),
                    new Point(10, 0),
                    new Point(10, 10),
                    new Point(0, 10),
                    new Point(0, 0),
                ]);
                expect(result[0][1]).toEqual([
                    new Point(2, 2),
                    new Point(8, 2),
                    new Point(8, 8),
                    new Point(2, 8),
                    new Point(2, 2),
                ]);
            });
        });

        describe("ConstGeometryVector", () => {
            it("should convert const vectors", () => {
                const vec = createConstGeometryVector(
                    3,
                    GEOMETRY_TYPE.POINT,
                    new TopologyVector(
                        new Uint32Array([0, 1, 2, 3]),
                        new Uint32Array([0, 1, 2, 3]),
                        new Uint32Array([0, 1, 2, 3]),
                    ),
                    new Int32Array([0, 1, 2]),
                    new Int32Array([10, 20, 30, 40, 50, 60]),
                );
                const result = convertGeometryVector(vec);
                expect(result[0]).toEqual([[new Point(10, 20)]]);
                expect(result[1]).toEqual([[new Point(30, 40)]]);
                expect(result[2]).toEqual([[new Point(50, 60)]]);

                const morton = createMortonEncodedConstGeometryVector(
                    2,
                    GEOMETRY_TYPE.POINT,
                    new TopologyVector(
                        new Uint32Array([0, 1, 2]),
                        new Uint32Array([0, 1, 2]),
                        new Uint32Array([0, 1, 2]),
                    ),
                    new Int32Array([0, 1]),
                    new Int32Array([encodeZOrderCurve(10, 20, 15, 0), encodeZOrderCurve(30, 40, 15, 0)]),
                    mortonSettings,
                );
                const mortonResult = convertGeometryVector(morton);
                expect(mortonResult[0]).toEqual([[new Point(10, 20)]]);
                expect(mortonResult[1]).toEqual([[new Point(30, 40)]]);
            });
        });

        it("should throw error for unsupported geometry type", () => {
            const vec = createFlatGeometryVector(
                new Int32Array([99]),
                new TopologyVector(new Uint32Array([0, 1]), new Uint32Array([0, 2]), new Uint32Array([0, 4, 8])),
                new Int32Array([0, 1, 2, 3, 4, 5, 6, 7]),
                new Int32Array([0, 0, 10, 0, 10, 10, 0, 10, 2, 2, 8, 2, 8, 8, 2, 8]),
            );
            expect(() => convertGeometryVector(vec)).toThrow("The specified geometry type is currently not supported.");
        });
    });
});
