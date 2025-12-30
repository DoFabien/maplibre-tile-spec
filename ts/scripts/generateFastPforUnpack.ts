import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_OUT_FILE = resolve(process.cwd(), "src/decoding/fastPforUnpack.ts");

function hexMask(bits: number): string {
    if (bits === 0) return "0x0";
    if (bits >= 32) return "0xffffffff";
    const mask = (1n << BigInt(bits)) - 1n;
    return `0x${mask.toString(16)}`;
}

type ExtractExpr = { expr: string; maxWord: number };

function extractExpr(bitWidth: number, bitPos: number, inVarPrefix: string): ExtractExpr {
    const word = Math.floor(bitPos / 32);
    const offset = bitPos % 32;
    const mask = hexMask(bitWidth);

    if (offset + bitWidth <= 32) {
        return { expr: `(${inVarPrefix}${word} >>> ${offset}) & ${mask}`, maxWord: word };
    }

    const lowBits = 32 - offset;
    const highBits = bitWidth - lowBits;
    const highMask = hexMask(highBits);
    return {
        expr: `((${inVarPrefix}${word} >>> ${offset}) | ((${inVarPrefix}${word + 1} & ${highMask}) << ${lowBits})) & ${mask}`,
        maxWord: word + 1,
    };
}

function genFastUnpack32(bitWidth: number): string {
    if (bitWidth === 1) {
        return [
            "export function fastUnpack32_1(inValues: Int32Array, inPos: number, out: Int32Array, outPos: number): void {",
            "    const in0 = inValues[inPos] >>> 0;",
            "    for (let i = 0; i < 32; i++) {",
            "        out[outPos + i] = (in0 >>> i) & 1;",
            "    }",
            "}",
        ].join("\n");
    }

    const words = bitWidth;
    const inDecls = Array.from({ length: words }, (_, i) => {
        const idx = i === 0 ? "inPos" : `inPos + ${i}`;
        return `    const in${i} = inValues[${idx}] >>> 0;`;
    }).join("\n");

    const lines: string[] = [];
    lines.push(`export function fastUnpack32_${bitWidth}(inValues: Int32Array, inPos: number, out: Int32Array, outPos: number): void {`);
    lines.push("    let op = outPos;");
    lines.push(inDecls);

    let maxWord = 0;
    let bitPos = 0;
    for (let i = 0; i < 32; i++) {
        const { expr, maxWord: mw } = extractExpr(bitWidth, bitPos, "in");
        maxWord = Math.max(maxWord, mw);
        lines.push(`    out[op++] = ${expr};`);
        bitPos += bitWidth;
    }
    if (maxWord !== words - 1) {
        throw new Error(`internal: expected maxWord=${words - 1}, got maxWord=${maxWord} for bitWidth=${bitWidth}`);
    }

    lines.push("}");
    return lines.join("\n");
}

function genFastUnpack256(bitWidth: number): string {
    const words = bitWidth;

    const lines: string[] = [];
    lines.push(`export function fastUnpack256_${bitWidth}(inValues: Int32Array, inPos: number, out: Int32Array, outPos: number): void {`);
    lines.push("    let op = outPos;");
    lines.push("    let ip = inPos;");
    lines.push("    for (let c = 0; c < 8; c++) {");
    for (let i = 0; i < words; i++) {
        lines.push(`        const in${i} = inValues[ip++] >>> 0;`);
    }

    let maxWord = 0;
    let bitPos = 0;
    for (let i = 0; i < 32; i++) {
        const { expr, maxWord: mw } = extractExpr(bitWidth, bitPos, "in");
        maxWord = Math.max(maxWord, mw);
        lines.push(`        out[op++] = ${expr};`);
        bitPos += bitWidth;
    }
    if (maxWord !== words - 1) {
        throw new Error(`internal: expected maxWord=${words - 1}, got maxWord=${maxWord} for bitWidth=${bitWidth}`);
    }

    lines.push("    }");
    lines.push("}");
    return lines.join("\n");
}

function genFastUnpack256_16(): string {
    return [
        "export function fastUnpack256_16(inValues: Int32Array, inPos: number, out: Int32Array, outPos: number): void {",
        "    let op = outPos;",
        "    let ip = inPos;",
        "    for (let i = 0; i < 128; i++) {",
        "        const in0 = inValues[ip++] >>> 0;",
        "        out[op++] = in0 & 0xffff;",
        "        out[op++] = (in0 >>> 16) & 0xffff;",
        "    }",
        "}",
    ].join("\n");
}

function genFastUnpack256_Generic(): string {
    return [
        "export function fastUnpack256_Generic(inValues: Int32Array, inPos: number, out: Int32Array, outPos: number, bitWidth: number): void {",
        "    const mask = MASKS[bitWidth] >>> 0;",
        "",
        "    let inputWordIndex = inPos;",
        "    let bitOffset = 0;",
        "    let currentWord = inValues[inputWordIndex] >>> 0;",
        "    let op = outPos;",
        "",
        "    for (let c = 0; c < 8; c++) {",
        "        for (let i = 0; i < 32; i++) {",
        "            if (bitOffset + bitWidth <= 32) {",
        "                const value = (currentWord >>> bitOffset) & mask;",
        "                out[op + i] = value | 0;",
        "                bitOffset += bitWidth;",
        "",
        "                if (bitOffset === 32) {",
        "                    bitOffset = 0;",
        "                    inputWordIndex++;",
        "                    if (i !== 31) {",
        "                        currentWord = inValues[inputWordIndex] >>> 0;",
        "                    }",
        "                }",
        "            } else {",
        "                const lowBits = 32 - bitOffset;",
        "                const low = currentWord >>> bitOffset;",
        "",
        "                inputWordIndex++;",
        "                currentWord = inValues[inputWordIndex] >>> 0;",
        "",
        "                const highBits = bitWidth - lowBits;",
        "                const highMask = (-1 >>> (32 - highBits)) >>> 0;",
        "",
        "                const high = currentWord & highMask;",
        "",
        "                const value = (low | (high << lowBits)) & mask;",
        "                out[op + i] = value | 0;",
        "                bitOffset = highBits;",
        "            }",
        "        }",
        "        op += 32;",
        "",
        "        bitOffset = 0;",
        "        if (c < 7) {",
        "            currentWord = inValues[inputWordIndex] >>> 0;",
        "        }",
        "    }",
        "}",
    ].join("\n");
}

function generateFile(): string {
    const bw32 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 16];
    const bw256 = [1, 2, 3, 4, 5, 6, 7, 8];

    const parts: string[] = [];
    parts.push(
        [
            "/**",
            " * Optimized bit-unpacking routines for FastPFOR decoding.",
            " *",
            " * This file is auto-generated by `scripts/generateFastPforUnpack.ts`.",
            " * Do not edit by hand; edit the generator instead.",
            " */",
            "",
            `import { MASKS } from "./fastPforShared";`,
            "",
        ].join("\n"),
    );

    for (const bw of bw32) {
        parts.push(genFastUnpack32(bw));
        parts.push("");
    }

    for (const bw of bw256) {
        parts.push(genFastUnpack256(bw));
        parts.push("");
    }

    parts.push(genFastUnpack256_16());
    parts.push("");
    parts.push("");
    parts.push(genFastUnpack256_Generic());
    parts.push("");

    return parts.join("\n");
}

function main(): void {
    const args = process.argv.slice(2);
    const outFile = resolve(process.cwd(), args.find((a) => a.startsWith("--out="))?.slice("--out=".length) ?? DEFAULT_OUT_FILE);
    const check = args.includes("--check");

    const content = generateFile();
    const prev = readFileSync(outFile, "utf8");

    if (prev === content) {
        process.stdout.write("fastPforUnpack.ts is up to date.\n");
        return;
    }

    if (check) {
        process.stderr.write(`fastPforUnpack.ts is out of date: ${outFile}\n`);
        process.exit(1);
    }

    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, content, "utf8");
    process.stdout.write(`Updated ${outFile}\n`);
}

main();
