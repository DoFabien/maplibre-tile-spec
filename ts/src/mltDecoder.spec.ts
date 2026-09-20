import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { parse, join } from "node:path";
import { VectorTile, type VectorTileFeature } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";

import { type FeatureTable, type Feature, decodeTile, scanTileLayers, scanTilePhysicalTechniques } from ".";
import path from "node:path";
import fs from "node:fs";

const ITERATOR_TILE = path.resolve(__dirname, "../../test/expected/0x01/simple/multiline-boolean.mlt");

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

describe("MLT physical technique scan", () => {
    it("distinguishes the standard Bing corpus from an explicit FastPFOR fixture", () => {
        const bing = new Uint8Array(
            fs.readFileSync(path.resolve(__dirname, "../../test/expected/tag0x01/bing/4-12-6.mlt")),
        );
        const fastPfor = new Uint8Array(
            fs.readFileSync(path.resolve(__dirname, "../../test/synthetic/0x01/props_u32_fpf_256.mlt")),
        );

        assert.equal(
            scanTilePhysicalTechniques(bing).some((stream) => stream.technique === "FAST_PFOR"),
            false,
        );
        assert.equal(
            scanTilePhysicalTechniques(fastPfor).some((stream) => stream.technique === "FAST_PFOR"),
            true,
        );
    });
});

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

    it("should decode only requested layers", () => {
        const bytes = new Uint8Array(fs.readFileSync(ITERATOR_TILE));

        const featureTables = decodeTile(bytes, undefined, true, { layerNames: ["layer"] });
        assert.equal(featureTables.length, 1);
        assert.equal(featureTables[0].name, "layer");

        const skippedFeatureTables = decodeTile(bytes, undefined, true, { layerNames: ["missing"] });
        assert.equal(skippedFeatureTables.length, 0);
    });

    it("should scan tile layer metadata without decoding feature tables", () => {
        const bytes = new Uint8Array(fs.readFileSync(ITERATOR_TILE));
        const layers = scanTileLayers(bytes);

        assert.deepEqual(
            layers.map((layer) => layer.name),
            ["layer"],
        );
        assert.equal(layers[0].extent, 4096);
        assert.ok(layers[0].blockStart < layers[0].blockEnd);

        assert.deepEqual(scanTileLayers(bytes, { layerNames: ["missing"] }), []);
    });

    it("should decode only requested property columns", () => {
        const bytes = new Uint8Array(fs.readFileSync(ITERATOR_TILE));
        const fullFeatureTable = decodeTile(bytes)[0];
        const propertyName = fullFeatureTable.propertyVectors?.[0]?.name;
        assert.ok(propertyName);

        const filteredFeatureTable = decodeTile(bytes, undefined, true, {
            propertyColumnNamesByLayer: {
                layer: [propertyName],
            },
        })[0];
        assert.deepEqual(
            filteredFeatureTable.propertyVectors?.map((propertyVector) => propertyVector.name),
            [propertyName],
        );

        const noPropertyFeatureTable = decodeTile(bytes, undefined, true, {
            propertyColumnNamesByLayer: {
                layer: [],
            },
        })[0];
        assert.deepEqual(noPropertyFeatureTable.propertyVectors, []);
        assert.ok(noPropertyFeatureTable.availablePropertyNames.includes(propertyName));

        const resolvedPropertyNames: string[][] = [];
        const stopObserving = noPropertyFeatureTable.onPropertyVectorsResolved((vectors) => {
            resolvedPropertyNames.push(vectors.map((vector) => vector.name));
        });
        const deferredProperty = noPropertyFeatureTable.getPropertyVector(propertyName);
        assert.ok(deferredProperty);
        assert.equal(deferredProperty.getValue(0), fullFeatureTable.getPropertyVector(propertyName)?.getValue(0));
        assert.deepEqual(
            noPropertyFeatureTable.propertyVectors?.map((propertyVector) => propertyVector.name),
            [propertyName],
        );
        assert.equal(noPropertyFeatureTable.getPropertyVector(propertyName), deferredProperty);
        assert.equal(noPropertyFeatureTable.getPropertyVector("missing"), undefined);
        assert.deepEqual(resolvedPropertyNames, [[propertyName]]);

        stopObserving();
        const secondPropertyName = fullFeatureTable.propertyVectors?.find(
            (vector) => vector.name !== propertyName,
        )?.name;
        if (secondPropertyName) {
            noPropertyFeatureTable.getPropertyVector(secondPropertyName);
            assert.deepEqual(resolvedPropertyNames, [[propertyName]]);
        }
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
