import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { bench, describe } from "vitest";
import decodeTile from "./mltDecoder";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

// Amazon tile with polygon layer "Park or farming" (219 features, deferred)
const tilePath = path.resolve(currentDir, "../../test/expected/tag0x01/amazon/11_1037_704.mlt");
const tileBuffer = new Uint8Array(readFileSync(tilePath));

describe("Lazy Geometry - Amazon POLYGONS (Deferred, 219 Parks)", () => {
    const tables = decodeTile(tileBuffer);
    const polygonTable = tables.find(t => t.name === "Park or farming");
    if (!polygonTable) throw new Error("Park or farming layer not found");

    // EAGER: Access ALL geometries (baseline)
    bench("EAGER: Full access - ALL 219 polygons", () => {
        const tables = decodeTile(tileBuffer);
        const table = tables.find((t) => t.name === "Park or farming");
        if (!table) throw new Error("Park or farming layer not found");
        const layer = table.getLayer();
        let sum = 0;
        for (let i = 0; i < layer.length; i++) {
            const coords = layer.feature(i).geometry.coordinates;
            if (coords) sum += coords.length;
        }
        if (sum === -1) throw new Error("Guard");
    });

    // LAZY: Access only 1 polygon
    bench("LAZY: Single polygon (1 feature = 0.5%)", () => {
        const tables = decodeTile(tileBuffer);
        const table = tables.find((t) => t.name === "Park or farming");
        if (!table) throw new Error("Park or farming layer not found");
        const layer = table.getLayer();
        const coords = layer.feature(0).geometry.coordinates;
        if (!coords) throw new Error("Guard");
    });

    // LAZY: Access 10 polygons
    bench("LAZY: 10 polygons (4.5%)", () => {
        const tables = decodeTile(tileBuffer);
        const table = tables.find((t) => t.name === "Park or farming");
        if (!table) throw new Error("Park or farming layer not found");
        const layer = table.getLayer();
        let sum = 0;
        for (let i = 0; i < 10; i++) {
            const coords = layer.feature(i).geometry.coordinates;
            if (coords) sum += coords.length;
        }
        if (sum === -1) throw new Error("Guard");
    });

    // LAZY: Access 50 polygons (~23%)
    bench("LAZY: 50 polygons (23%)", () => {
        const tables = decodeTile(tileBuffer);
        const table = tables.find((t) => t.name === "Park or farming");
        if (!table) throw new Error("Park or farming layer not found");
        const layer = table.getLayer();
        let sum = 0;
        for (let i = 0; i < 50; i++) {
            const coords = layer.feature(i).geometry.coordinates;
            if (coords) sum += coords.length;
        }
        if (sum === -1) throw new Error("Guard");
    });
});

// Also benchmark POIs from amazon_here for comparison
const poiTilePath = path.resolve(currentDir, "../../test/expected/tag0x01/amazon_here/4_8_5.mlt");
const poiTileBuffer = new Uint8Array(readFileSync(poiTilePath));

describe("Lazy Geometry - Amazon HERE POIs (Deferred, 3289 Points)", () => {
    // EAGER: Access ALL geometries
    bench("EAGER: Full access - ALL 3289 points", () => {
        const tables = decodeTile(poiTileBuffer);
        const table = tables.find((t) => t.name === "pois");
        if (!table) throw new Error("pois layer not found");
        const layer = table.getLayer();
        let sum = 0;
        for (let i = 0; i < layer.length; i++) {
            const coords = layer.feature(i).geometry.coordinates;
            if (coords) sum += 1;
        }
        if (sum === -1) throw new Error("Guard");
    });

    // LAZY: Access only 1 point
    bench("LAZY: Single point (1 feature)", () => {
        const tables = decodeTile(poiTileBuffer);
        const table = tables.find((t) => t.name === "pois");
        if (!table) throw new Error("pois layer not found");
        const layer = table.getLayer();
        const coords = layer.feature(0).geometry.coordinates;
        if (!coords) throw new Error("Guard");
    });

    // LAZY: Access 10 points
    bench("LAZY: 10 points (0.3%)", () => {
        const tables = decodeTile(poiTileBuffer);
        const table = tables.find((t) => t.name === "pois");
        if (!table) throw new Error("pois layer not found");
        const layer = table.getLayer();
        let sum = 0;
        for (let i = 0; i < 10; i++) {
            const coords = layer.feature(i).geometry.coordinates;
            if (coords) sum += 1;
        }
        if (sum === -1) throw new Error("Guard");
    });
});
