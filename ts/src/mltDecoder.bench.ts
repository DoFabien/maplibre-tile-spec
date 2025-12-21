import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { bench, describe } from "vitest";
import decodeTile from "./mltDecoder";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const tilePaths = [
    path.resolve(currentDir, "../../test/expected/tag0x01/omt/14_8298_10748.mlt"),
    path.resolve(currentDir, "../../test/expected/tag0x01/omt/11_1063_1367.mlt"),
    path.resolve(currentDir, "../../test/expected/tag0x01/amazon/9_259_176.mlt"), // Deferred Geometry
];
const tileBuffers = tilePaths.map((tilePath) => new Uint8Array(readFileSync(tilePath)));

describe("MLT decoder performance", () => {
    bench("Iterate properties only (no coordinates)", () => {
        let sum = 0;

        for (const buffer of tileBuffers) {
            const tables = decodeTile(buffer);
            for (const table of tables) {
                const layer = table.getLayer();
                for (let i = 0; i < layer.length; i++) {
                    const feature = layer.feature(i);
                    sum += feature.geometry.type;
                    sum += Object.keys(feature.properties).length;
                }
            }
        }

        if (sum === -1) {
            throw new Error("Bench guard");
        }
    });

    bench("Decode full (geometry + properties)", () => {
        let sum = 0;

        for (const buffer of tileBuffers) {
            const tables = decodeTile(buffer);
            for (const table of tables) {
                const layer = table.getLayer();
                for (let i = 0; i < layer.length; i++) {
                    const feature = layer.feature(i);
                    sum += feature.geometry.coordinates.length;
                    sum += Object.keys(feature.properties).length;
                }
            }
        }

        if (sum === -1) {
            throw new Error("Bench guard");
        }
    });
});
