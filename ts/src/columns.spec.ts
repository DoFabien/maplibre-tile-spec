import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import decodeTile from "./mltDecoder";
import { GEOMETRY_TYPE } from "./vector/geometry/geometryType";
import type { Feature } from "./vector/featureTable";
import { decodeTileColumns, type MltColumnLayer, type MltPropertyColumn } from "./columns";
import { encodeTile, type Layer, type PropertyValue } from "./encoding/mltEncoder";

const FIXTURE_TILES = path.resolve(__dirname, "../../test/expected/0x01");
const SHARED_DICTIONARY_TILE = path.join(FIXTURE_TILES, "omt/10_530_682.mlt");
/** In milliseconds. The largest fixture tiles take seconds to compare value by value on a slow machine. */
const FIXTURE_TILE_TIMEOUT = 150000;

function readTile(file: string): Uint8Array {
    return new Uint8Array(readFileSync(file));
}

/** The fixture tiles, each as its path below `FIXTURE_TILES`. */
function fixtureTiles(): string[] {
    return readdirSync(FIXTURE_TILES, { recursive: true, encoding: "utf8" })
        .filter((file) => file.endsWith(".mlt"))
        .sort();
}

/** A tile of one layer of points, a point for each of the given sets of properties. */
function pointTile(...properties: Record<string, PropertyValue>[]): Uint8Array {
    const layer: Layer = {
        name: "points",
        features: properties.map((properties, i) => ({ geometry: { type: "Point", coordinates: [i, i] }, properties })),
    };
    return encodeTile([layer]);
}

/** Whether a row of a column has a value. */
function hasValue(column: { present?: Uint8Array }, row: number): boolean {
    return !column.present || (column.present[row >> 3] & (1 << (row & 7))) !== 0;
}

/** The value of a row of a column, as the feature tables of `decodeTile` read it. */
function valueAt(column: MltPropertyColumn, row: number): unknown {
    if (!hasValue(column, row)) return null;
    if ("codes" in column) return column.dictionary[column.codes[row]];
    if (column.type === "bool") return column.values[row] === 1;
    return column.values[row];
}

/** The vertices of each feature, flattened from the offset levels of the layer. */
function featureVertices(layer: MltColumnLayer): number[][] {
    const { vertices, geometryOffsets, partOffsets, ringOffsets } = layer.geometry;
    const levels = [geometryOffsets, partOffsets, ringOffsets].filter((offsets) => offsets !== undefined);
    return Array.from({ length: layer.featureCount }, (_, feature) => {
        let [start, end] = [feature, feature + 1];
        for (const offsets of levels) [start, end] = [offsets[start], offsets[end]];
        return Array.from(vertices.subarray(start * 2, end * 2));
    });
}

/** The id of each feature, `null` for a feature without one. */
function featureIds(layer: MltColumnLayer): (number | null)[] {
    const ids = layer.ids;
    return Array.from({ length: layer.featureCount }, (_, row) => (ids && hasValue(ids, row) ? ids.values[row] : null));
}

/** The id of a feature as `decodeTile` reads it, turned into the unsigned 64-bit number a column holds it as. */
function decodedId(feature: Feature): number | null {
    return feature.id === undefined ? null : Number(BigInt.asUintN(64, BigInt(feature.id)));
}

/** The vertices of a feature as `decodeTile` reads them, without the closing vertex of each polygon ring. */
function decodedVertices(feature: Feature): number[] {
    const { type, coordinates } = feature.geometry;
    const closed = type === GEOMETRY_TYPE.POLYGON || type === GEOMETRY_TYPE.MULTIPOLYGON;
    return coordinates.flatMap((part) => (closed ? part.slice(0, -1) : part).flatMap((point) => [point.x, point.y]));
}

/** Everything a layer of columns holds, value by value, so that two layers holding the same features compare equal. */
function readLayer(layer: MltColumnLayer): Record<string, unknown> {
    const rows = Array.from({ length: layer.featureCount }, (_, row) => row);
    const properties: Record<string, unknown[]> = {};
    for (const column of layer.properties) properties[column.name] = rows.map((row) => valueAt(column, row));
    return {
        name: layer.name,
        extent: layer.extent,
        types: Array.from(layer.geometry.types),
        vertices: featureVertices(layer),
        ids: layer.ids && featureIds(layer),
        properties,
    };
}

describe("decodeTileColumns", () => {
    for (const file of fixtureTiles()) {
        it(`reads the features decodeTile reads from ${file}`, { timeout: FIXTURE_TILE_TIMEOUT }, () => {
            const tile = readTile(path.join(FIXTURE_TILES, file));
            const tables = decodeTile(tile);
            const { layers } = decodeTileColumns(tile);

            expect(layers.map((layer) => layer.name)).toEqual(tables.map((table) => table.name));
            for (const [i, layer] of layers.entries()) {
                const features = tables[i].getFeatures();
                expect(layer.featureCount).toBe(features.length);
                expect(featureVertices(layer), layer.name).toEqual(features.map(decodedVertices));
                expect(featureIds(layer), layer.name).toEqual(features.map(decodedId));
                for (const column of layer.properties) {
                    const values = features.map((_, row) => valueAt(column, row));
                    expect(values, `${layer.name}.${column.name}`).toEqual(
                        features.map((feature) => feature.properties[column.name] ?? null),
                    );
                }
            }
        });
    }

    it("reads a column of 64-bit integers as doubles, with `0` where a feature has no value", () => {
        const tile = pointTile({ population: 2n ** 40n }, { population: null }, { population: -5n });

        const [layer] = decodeTileColumns(tile).layers;

        expect(layer.properties).toEqual([
            { name: "population", type: "i64", values: Float64Array.of(2 ** 40, 0, -5), present: Uint8Array.of(0b101) },
        ]);
    });

    it("marks every value absent in a column no feature has a value for, which keeps the type of the column", () => {
        const [layer] = decodeTileColumns(pointTile({ name: null }, { name: null })).layers;
        const [column] = layer.properties;

        expect(column.type).toBe("string");
        expect([valueAt(column, 0), valueAt(column, 1)]).toEqual([null, null]);
    });

    it("gives a column of run-length encoded integers the type its metadata gives them, unsigned 32-bit here", () => {
        const [layer] = decodeTileColumns(readTile(path.join(FIXTURE_TILES, "amazon/10_518_352.mlt")), {
            layers: ["Road"],
        }).layers;

        expect(layer.properties.find((column) => column.name === "Viz")?.type).toBe("u32");
    });

    it("reads a property named by the empty string", () => {
        const tile = pointTile({ "": true, kind: "tower" });

        const [layer] = decodeTileColumns(tile).layers;

        expect(layer.properties.map((column) => [column.name, column.type, valueAt(column, 0)])).toEqual([
            ["", "bool", true],
            ["kind", "string", "tower"],
        ]);
    });

    it("leaves out a column whose values are not scalars", () => {
        const tile = pointTile({ kind: "tower", tags: { height: 1 } }, { kind: "mast", tags: { height: 2 } });

        const [layer] = decodeTileColumns(tile).layers;

        expect(layer.properties.map((column) => column.name)).toEqual(["kind"]);
    });

    it("keeps only the listed layers and properties", () => {
        const { layers } = decodeTileColumns(readTile(SHARED_DICTIONARY_TILE), {
            layers: ["place"],
            properties: new Map([["place", ["class", "name:de"]]]),
        });

        expect(layers.map((layer) => layer.name)).toEqual(["place"]);
        expect(layers[0].properties.map((column) => column.name).sort()).toEqual(["class", "name:de"]);
    });

    it("passes dictionary strings on as codes into one dictionary that a shared dictionary's columns share", () => {
        const [place] = decodeTileColumns(readTile(SHARED_DICTIONARY_TILE), {
            layers: ["place"],
            properties: new Map([["place", ["name:de", "name:en"]]]),
            stringCodes: true,
        }).layers;
        const [german, english] = place.properties;

        expect("codes" in german && "codes" in english).toBe(true);
        expect("codes" in german && "codes" in english && german.dictionary).toBe(
            "codes" in english && english.dictionary,
        );
    });
});
