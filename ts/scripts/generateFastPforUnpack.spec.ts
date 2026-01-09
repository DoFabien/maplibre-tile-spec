import { describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TS_ROOT = resolve(__dirname, "..");

function runGenerator(args: string[]) {
    const script = resolve(TS_ROOT, "scripts/generateFastPforUnpack.ts");
    return spawnSync("node", ["--experimental-strip-types", "--no-warnings", script, ...args], {
        cwd: TS_ROOT,
        encoding: "utf8",
        env: process.env,
    });
}

describe("generateFastPforUnpack (CLI contract)", () => {
    it("supports --check and missing file without crashing", () => {
        const dir = mkdtempSync(join(tmpdir(), "fastpfor-unpack-"));
        try {
            const outFile = join(dir, "fastPforUnpack.ts");

            const checkMissing = runGenerator([`--out=${outFile}`, "--check"]);
            expect(checkMissing.status).toBe(1);
            expect(checkMissing.stderr).toContain("missing");

            const generate = runGenerator([`--out=${outFile}`]);
            expect(generate.status).toBe(0);

            const content = readFileSync(outFile, "utf8");
            expect(content).toContain("auto-generated");
            expect(content).toContain("export function fastUnpack32_1(");
            expect(content).toContain("export function fastUnpack256_16(");
            expect(content).toContain('import { MASKS } from "./fastPforShared"');

            const checkUpToDate = runGenerator([`--out=${outFile}`, "--check"]);
            expect(checkUpToDate.status).toBe(0);

            appendFileSync(outFile, "\n// mutated\n", "utf8");
            const checkOutdated = runGenerator([`--out=${outFile}`, "--check"]);
            expect(checkOutdated.status).toBe(1);
            expect(checkOutdated.stderr).toContain("out of date");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

