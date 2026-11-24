import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { parse, join } from "node:path";
import { VectorTile, type VectorTileFeature } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";

import { type FeatureTable, type Feature, decodeTile, encodeTile } from ".";
import { decodeTileLayer, scanTileLayers } from "./mltDecoder";
import IntWrapper from "./decoding/intWrapper";
import { decodeVarintInt32 } from "./decoding/integerDecodingUtils";
import path from "node:path";
import fs from "node:fs";

const ITERATOR_TILE = path.resolve(__dirname, "../../test/expected/0x01/simple/multiline-boolean.mlt");
/** An OpenMapTiles tile whose `place` layer stores its `name:*` properties as the children of a shared dictionary. */
const SHARED_DICTIONARY_TILE = path.resolve(__dirname, "../../test/expected/0x01/omt/10_530_682.mlt");

/** A layer whose vertex m-values have a column type that this decoder does not read. */
const UNREADABLE_LAYER_TILE = path.resolve(__dirname, "../../test/synthetic/0x02/mesh_mvalues_vertex.mlt");

/** A tile of one layer of two points, each with a `rank` and a `height`. */
function pointsTile(): Uint8Array {
    return encodeTile([
        {
            name: "points",
            features: [
                { geometry: { type: "Point", coordinates: [1, 2] }, properties: { rank: 7, height: 10 } },
                { geometry: { type: "Point", coordinates: [3, 4] }, properties: { rank: 8, height: 20 } },
            ],
        },
    ]);
}

describe("MLT Decoder - MVT comparison for SIMPLE tiles", () => {
    const simpleMltTileDir = "../test/expected/0x01/simple";
    const simpleMvtTileDir = "../test/fixtures/simple";
    testTiles(simpleMltTileDir, simpleMvtTileDir);
});

describe("MLT Decoder - MVT comparison for Amazon tiles", () => {
    const amazonMltTileDir = "../test/expected/0x01/amazon";
    const amazonMvtTileDir = "../test/fixtures/amazon";
    testTiles(amazonMltTileDir, amazonMvtTileDir);
});

describe("MLT Decoder - MVT comparison for OMT tiles", () => {
    const omtMltTileDir = "../test/expected/0x01/omt";
    const omtMvtTileDir = "../test/fixtures/omt";
    testTiles(omtMltTileDir, omtMvtTileDir);
}, 150000);

describe("MLT Decoder - MVT comparison for Bing tiles", () => {
    const bingMltTileDir = "../test/expected/0x01/bing";
    const bingMvtTileDir = "../test/fixtures/bing";
    testTiles(bingMltTileDir, bingMvtTileDir);
}, 150000);

describe("FeatureTable", () => {
    it("should iterate through features correctly", () => {
        const bytes = new Uint8Array(fs.readFileSync(ITERATOR_TILE));
        const featureTables = decodeTile(bytes);

        const table = featureTables[0];

        assert.equal(table.name, "layer");
        assert.equal(table.extent, 4096);

        let featureCount = 0;
        for (const feature of table.getFeatures()) {
            assert.ok(feature.geometry);
            assert.ok(Array.isArray(feature.geometry.coordinates));
            assert.ok(feature.geometry.coordinates.length > 0);
            assert.equal(typeof feature.geometry.type, "number");

            featureCount++;
        }
        assert.equal(featureCount, table.numFeatures);
    });

    it("should scan tile layers and decode one of them alone", () => {
        const bytes = new Uint8Array(fs.readFileSync(ITERATOR_TILE));
        const layers = scanTileLayers(bytes);

        assert.deepEqual(
            layers.map((layer) => layer.name),
            ["layer"],
        );
        assert.deepEqual(decodeTileLayer(bytes, layers[0]).getFeatures(), decodeTile(bytes)[0].getFeatures());
    });

    it("should scan the layers of a tile and decode one of them next to a layer whose columns it cannot read", () => {
        const points = pointsTile();
        const unreadable = new Uint8Array(fs.readFileSync(UNREADABLE_LAYER_TILE));
        const bytes = new Uint8Array(points.length + unreadable.length);
        bytes.set(points);
        bytes.set(unreadable, points.length);

        const layers = scanTileLayers(bytes);

        assert.deepEqual(
            layers.map((layer) => layer.name),
            ["points", scanTileLayers(unreadable)[0].name],
        );
        assert.deepEqual(decodeTileLayer(bytes, layers[0]).getFeatures(), decodeTile(points)[0].getFeatures());
        assert.throws(() => decodeTileLayer(bytes, layers[1]));
    });

    it("should read the layers of tag 2 blocks as those of tag 1 blocks", () => {
        const bytes = new Uint8Array(fs.readFileSync(ITERATOR_TILE));
        const tag2Bytes = bytes.slice();
        const tagOffset = new IntWrapper(0);
        decodeVarintInt32(tag2Bytes, tagOffset, 1);
        tag2Bytes[tagOffset.get()] = 2;

        assert.deepEqual(
            scanTileLayers(tag2Bytes).map((layer) => layer.name),
            ["layer"],
        );
        assert.deepEqual(decodeTile(tag2Bytes)[0].getFeatures(), decodeTile(bytes)[0].getFeatures());
    });

    it("should decode only the requested property columns with the layer", () => {
        const bytes = pointsTile();
        const [layer] = scanTileLayers(bytes);

        const featureTable = decodeTileLayer(bytes, layer, undefined, true, new Set(["height"]));

        assert.deepEqual(
            featureTable.propertyVectors.map((vector) => vector.name),
            ["height"],
        );
    });

    it("should decode no property column with the layer when none is requested, and still name them all", () => {
        const bytes = pointsTile();
        const [layer] = scanTileLayers(bytes);

        const featureTable = decodeTileLayer(bytes, layer, undefined, true, new Set());

        assert.deepEqual(featureTable.propertyVectors, []);
        assert.deepEqual(featureTable.availablePropertyNames, ["rank", "height"]);
    });

    it("should decode a property column left aside when it is asked for, and return the same vector afterwards", () => {
        const bytes = pointsTile();
        const [layer] = scanTileLayers(bytes);
        const featureTable = decodeTileLayer(bytes, layer, undefined, true, new Set());

        const height = featureTable.getPropertyVector("height");

        assert.deepEqual([height?.getValue(0), height?.getValue(1)], [10, 20]);
        assert.deepEqual(featureTable.propertyVectors, [height]);
        assert.equal(featureTable.getPropertyVector("height"), height);
    });

    it("should return no vector for a property the layer does not have", () => {
        const bytes = pointsTile();
        const [layer] = scanTileLayers(bytes);
        const featureTable = decodeTileLayer(bytes, layer, undefined, true, new Set());

        assert.equal(featureTable.getPropertyVector("missing"), undefined);
    });

    it("should skip both streams of a nullable column that is not requested and has no stream count", () => {
        const bytes = encodeTile([
            {
                name: "points",
                features: [
                    { geometry: { type: "Point", coordinates: [1, 2] }, properties: { rank: 7, height: 10 } },
                    { geometry: { type: "Point", coordinates: [3, 4] }, properties: { rank: null, height: 20 } },
                ],
            },
        ]);
        const [layer] = scanTileLayers(bytes);

        const featureTable = decodeTileLayer(bytes, layer, undefined, true, new Set(["height"]));

        assert.deepEqual(
            featureTable.getFeatures().map((feature) => feature.properties),
            [{ height: 10 }, { height: 20 }],
        );
    });

    it("should decode a deferred shared dictionary once for all its properties", () => {
        const bytes = new Uint8Array(fs.readFileSync(SHARED_DICTIONARY_TILE));
        const layer = scanTileLayers(bytes).find((entry) => entry.name === "place");
        assert.ok(layer);
        const fullFeatureTable = decodeTileLayer(bytes, layer);
        const names = fullFeatureTable.propertyVectors.map((vector) => vector.name);
        const [kept, first, second] = names.filter((name) => name.startsWith("name:"));
        assert.ok(second);

        const featureTable = decodeTileLayer(bytes, layer, undefined, true, new Set([kept]));
        const keptVector = featureTable.getPropertyVector(kept);
        const firstVector = featureTable.getPropertyVector(first);

        assert.ok(firstVector);
        assert.ok(featureTable.propertyVectors.some((vector) => vector.name === second));
        assert.equal(firstVector.getValue(0), fullFeatureTable.getPropertyVector(first)?.getValue(0));
        assert.equal(featureTable.getPropertyVector(kept), keptVector);
        assert.equal(featureTable.propertyVectors.filter((vector) => vector.name === kept).length, 1);
    });
});

function testTiles(mltSearchDir: string, mvtSearchDir: string) {
    const mltFileNames = readdirSync(mltSearchDir)
        .filter((file) => parse(file).ext === ".mlt")
        .map((file) => parse(file).name);
    for (const fileName of mltFileNames) {
        it(`should compare ${fileName} tile`, () => {
            const mltFileName = `${fileName}.mlt`;
            const mltPath = join(mltSearchDir, mltFileName);
            const mvtPath = join(mvtSearchDir, `${fileName}.mvt`);

            const encodedMvt = readFileSync(mvtPath);
            const encodedMlt = readFileSync(mltPath);
            const buf = new PbfReader(encodedMvt);
            const decodedMvt = new VectorTile(buf);

            const decodedMlt = decodeTile(encodedMlt, undefined, true);
            comparePlainGeometryEncodedTile(decodedMlt, decodedMvt);
        });
    }
}

function removeEmptyStrings(mvtProperties: Record<string, any>) {
    for (const key of Object.keys(mvtProperties)) {
        const value = mvtProperties[key];
        if (typeof value === "string" && !value.length) {
            delete mvtProperties[key];
        }
    }
}

function comparePlainGeometryEncodedTile(mlt: FeatureTable[], mvt: VectorTile) {
    for (const featureTable of mlt) {
        const layer = mvt.layers[featureTable.name];

        // Use getFeatures() instead of iterator (like C++ and Java implementations)
        const mltFeatures = featureTable.getFeatures();

        assert.equal(mltFeatures.length, layer.length);

        for (let j = 0; j < layer.length; j++) {
            const mvtFeature = layer.feature(j);
            const mltFeature = mltFeatures[j];

            compareId(mltFeature, mvtFeature, true);

            const mltGeometry = mltFeature.geometry?.coordinates;
            const mvtGeometry = mvtFeature.loadGeometry();
            assert.deepEqual(mltGeometry, mvtGeometry);

            const mltProperties = mltFeature.properties;
            // vector-tile v3 returns a null-prototype object; copy to a plain object so
            // assert.deepEqual's prototype check passes.
            const mvtProperties = { ...mvtFeature.properties };
            transformPropertyNames(mltProperties);
            transformPropertyNames(mvtProperties);
            convertBigIntPropertyValues(mltProperties);
            //TODO: fix -> since a change in the java converter shared dictionary encoding empty strings are not
            //encoded anymore
            removeEmptyStrings(mvtProperties);
            removeEmptyStrings(mltProperties);
            assert.deepEqual(mltProperties, mvtProperties);
        }
    }
}

function compareId(mltFeature: Feature, mvtFeature: VectorTileFeature, idWithinMaxSafeInteger: boolean) {
    if (!mvtFeature.id) {
        /* Java MVT library in the MVT converter decodes zero for undefined ids */
        /* The Rust encoder writes no id column when the MVT has none, which decodes to undefined */
        assert.ok(mltFeature.id === 0 || mltFeature.id === null || mltFeature.id === undefined || mltFeature.id === 0n);
    } else {
        const mltFeatureId = mltFeature.id;
        /* For const and sequence vectors the decoder can return bigint compared to the vector-tile-js library */
        const actualId =
            idWithinMaxSafeInteger && typeof mltFeatureId !== "bigint" ? mltFeatureId : Number(mltFeatureId);
        /*
         * The id check can fail for two known reasons:
         * - The java-vector-tile library used in the Java converter returns negative integers for the
         *   unoptimized tileset in some tiles
         * - The vector-tile-js library is using number types for the id so there can only be stored
         *   values up to 53 bits without loss of precision
         **/
        if (mltFeatureId < 0 || mltFeatureId > Number.MAX_SAFE_INTEGER) {
            /* Expected to fail in some/most cases */
            try {
                assert.equal(actualId, mvtFeature.id);
            } catch (_e) {
                //console.info("id mismatch", featureTableName, mltFeatureId, mvtFeature.id);
            }
            return;
        }

        if (!Number.isSafeInteger(mvtFeature.id)) {
            return;
        }

        assert.equal(actualId, mvtFeature.id);
    }
}

/* Change bigint to number for comparison with MVT */
function convertBigIntPropertyValues(mltProperties: Record<string, any>) {
    for (const key of Object.keys(mltProperties)) {
        if (typeof mltProperties[key] === "bigint") {
            mltProperties[key] = Number(mltProperties[key]);
        }
    }
}

function transformPropertyNames(properties: Record<string, any>) {
    const propertyNames = Object.keys(properties);
    for (let k = 0; k < propertyNames.length; k++) {
        const key = propertyNames[k];

        let newKey = key;
        /* rename the property names which are separated with : in mlt to match _ in omt mvts */
        if (key.startsWith("name") && key.includes(":")) {
            newKey = (key as any).replaceAll(":", "_");
            properties[newKey] = properties[key];
            delete properties[key];
        }

        /* Currently id is not supported as a property name in a FeatureTable,
         *  so this quick workaround is implemented */
        if (newKey === "_id") {
            properties.id = properties[newKey];
            delete properties[newKey];
        }
    }
}
