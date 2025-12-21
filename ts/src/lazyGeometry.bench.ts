import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { bench, describe } from "vitest";
import decodeTile from "./mltDecoder";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const tilePaths = [
    path.resolve(currentDir, "../../test/expected/tag0x01/omt/14_8298_10748.mlt"),
];
const tileBuffers = tilePaths.map((tilePath) => new Uint8Array(readFileSync(tilePath)));

describe("Lazy Geometry - Random Access Performance (OMT POI Layer)", () => {
    // Scenario 1: Access a single geometry (simulates highly selective filter like id = 500)
    bench("Single geometry access (index 0)", () => {
        let sum = 0;

        for (const buffer of tileBuffers) {
            const tables = decodeTile(buffer);
            for (const table of tables) {
                if (table.name !== "poi") continue;
                const features = table.getLayer();
                if (features.length > 0) {
                    // Access only the first feature's geometry
                    const geom = features.feature(0).geometry;
                    if (geom && geom.coordinates) {
                        sum += Array.isArray(geom.coordinates) ? geom.coordinates.length : 1;
                    }
                }
            }
        }

        if (sum === -1) throw new Error("Bench guard");
    });

    // Scenario 2: Access geometry at middle index
    bench("Single geometry access (middle index)", () => {
        let sum = 0;

        for (const buffer of tileBuffers) {
            const tables = decodeTile(buffer);
            for (const table of tables) {
                if (table.name !== "poi") continue;
                const features = table.getLayer();
                if (features.length > 10) {
                    // Access only the middle feature's geometry
                    const midIndex = Math.floor(features.length / 2);
                    const geom = features.feature(midIndex).geometry;
                    if (geom && geom.coordinates) {
                        sum += Array.isArray(geom.coordinates) ? geom.coordinates.length : 1;
                    }
                }
            }
        }

        if (sum === -1) throw new Error("Bench guard");
    });

    // Scenario 3: Sparse access (simulates filter that selects 10% of features)
    bench("Sparse access (10% of features)", () => {
        let sum = 0;

        for (const buffer of tileBuffers) {
            const tables = decodeTile(buffer);
            for (const table of tables) {
                if (table.name !== "poi") continue;
                const features = table.getLayer();
                // Access only every 10th feature
                for (let i = 0; i < features.length; i += 10) {
                    const geom = features.feature(i).geometry;
                    if (geom && geom.coordinates) {
                        sum += Array.isArray(geom.coordinates) ? geom.coordinates.length : 1;
                    }
                }
            }
        }

        if (sum === -1) throw new Error("Bench guard");
    });

    // Scenario 4: Properties only (no geometry access) - best case for lazy
    bench("Properties only (no geometry)", () => {
        let sum = 0;

        for (const buffer of tileBuffers) {
            const tables = decodeTile(buffer);
            for (const table of tables) {
                if (table.name !== "poi") continue;
                const features = table.getLayer();
                for (const feature of features) {
                    // Only access properties, never geometry
                    const props = feature.properties;
                    if (props && Object.keys(props).length > 0) {
                        sum++;
                    }
                }
            }
        }

        if (sum === -1) throw new Error("Bench guard");
    });

    // Scenario 5: Full access (all geometries) - baseline comparison
    bench("Full access (all geometries)", () => {
        let sum = 0;

        for (const buffer of tileBuffers) {
            const tables = decodeTile(buffer);
            for (const table of tables) {
                if (table.name !== "poi") continue;
                const features = table.getLayer();
                for (const feature of features) {
                    const geom = feature.geometry;
                    if (geom && geom.coordinates) {
                        sum += Array.isArray(geom.coordinates) ? geom.coordinates.length : 1;
                    }
                }
            }
        }

        if (sum === -1) throw new Error("Bench guard");
    });
});

describe("Lazy Geometry - Filter Simulation (OMT POI Layer)", () => {
    // Simulates realistic filter: "height > 100" keeping only 5% of features
    bench("Filter simulation: 5% pass rate", () => {
        let sum = 0;

        for (const buffer of tileBuffers) {
            const tables = decodeTile(buffer);
            for (const table of tables) {
                if (table.name !== "poi") continue;
                const features = table.getLayer();
                let passCount = 0;
                const targetPassRate = Math.max(1, Math.floor(features.length * 0.05));

                for (const feature of features) {
                    // Simulate filter based on properties
                    if (passCount < targetPassRate) {
                        // Feature passes filter - access geometry
                        const geom = feature.geometry;
                        if (geom && geom.coordinates) {
                            sum += Array.isArray(geom.coordinates) ? geom.coordinates.length : 1;
                        }
                        passCount++;
                    }
                    // Features that don't pass filter: geometry never accessed (lazy benefit!)
                }
            }
        }

        if (sum === -1) throw new Error("Bench guard");
    });

    // Simulates a scan where only 1 feature matches late in the iteration.
    bench("Filter simulation: single match (late match)", () => {
        let sum = 0;

        for (const buffer of tileBuffers) {
            const tables = decodeTile(buffer);
            for (const table of tables) {
                if (table.name !== "poi") continue;
                const features = table.getLayer();
                const targetIndex = Math.max(0, features.length - 1);

                for (let i = 0; i < features.length; i++) {
                    const feature = features.feature(i);

                    // Simulate filter evaluation using properties (no geometry access).
                    sum += Object.keys(feature.properties).length;

                    if (i === targetIndex) {
                        const coords = feature.geometry.coordinates;
                        sum += Array.isArray(coords) ? coords.length : 1;
                        break;
                    }
                }
            }
        }

        if (sum === -1) throw new Error("Bench guard");
    });
});
