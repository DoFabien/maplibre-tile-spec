import { VariableSizeVector } from "../variableSizeVector";
import BitVector from "../flat/bitVector";
import { decodeString } from "../../decoding/decodingUtils";

const MAX_DECODED_STRING_CACHE_ENTRIES = 65_536;
const MAX_DECODED_STRING_CACHE_BYTES = 1024 * 1024;

export class StringDictionaryVector extends VariableSizeVector<Uint8Array, string> {
    private decodedValueCache?: Array<string | undefined> | null;

    constructor(
        name: string,
        private readonly indexBuffer: Uint32Array,
        offsetBuffer: Uint32Array,
        dictionaryBuffer: Uint8Array,
        nullabilityBuffer?: BitVector,
    ) {
        super(name, offsetBuffer, dictionaryBuffer, nullabilityBuffer ?? indexBuffer.length);
        this.indexBuffer = indexBuffer;
    }

    protected getValueFromBuffer(index: number): string {
        return this.getDictionaryValue(this.indexBuffer[index]);
    }

    /** The string of a dictionary entry, which rows refer to by {@link index}. */
    getDictionaryValue(offset: number): string {
        const start = this.offsetBuffer[offset];
        const end = this.offsetBuffer[offset + 1];
        const cache = this.getDecodedValueCache();
        if (!cache) {
            return decodeString(this.dataBuffer, start, end);
        }

        const cached = cache[offset];
        if (cached !== undefined) return cached;

        const decoded = decodeString(this.dataBuffer, start, end);
        cache[offset] = decoded;
        return decoded;
    }

    /**
     * The cache is allocated only on first string access and is bounded by
     * both dictionary cardinality and encoded bytes. Large/high-cardinality
     * dictionaries keep the previous decode-on-read behavior instead of
     * retaining an unbounded array of JavaScript strings.
     */
    private getDecodedValueCache(): Array<string | undefined> | null {
        if (this.decodedValueCache !== undefined) return this.decodedValueCache;

        const dictionarySize = this.offsetBuffer.length - 1;
        this.decodedValueCache =
            dictionarySize <= MAX_DECODED_STRING_CACHE_ENTRIES &&
            this.dataBuffer.byteLength <= MAX_DECODED_STRING_CACHE_BYTES
                ? new Array<string | undefined>(dictionarySize)
                : null;
        return this.decodedValueCache;
    }

    /** Number of dictionary entries. */
    get dictionarySize(): number {
        return this.offsetBuffer.length - 1;
    }

    get index(): Uint32Array {
        return this.indexBuffer;
    }
}

export function createStringDictionaryVector(values: (string | null)[], name: string): StringDictionaryVector {
    const encoder = new TextEncoder();
    const nonNullValues = values.filter((v): v is string => v !== null);
    const uniqueValues = Array.from(new Set(nonNullValues));
    const encodedDict = uniqueValues.map((value) => encoder.encode(value));

    const dictionarySize = encodedDict.reduce((sum, value) => sum + value.length, 0);
    const offsetBuffer = new Uint32Array(uniqueValues.length + 1);
    const dictionaryBuffer = new Uint8Array(dictionarySize);

    let currentOffset = 0;
    for (let i = 0; i < encodedDict.length; i++) {
        dictionaryBuffer.set(encodedDict[i], currentOffset);
        currentOffset += encodedDict[i].length;
        offsetBuffer[i + 1] = currentOffset;
    }

    const indexBuffer = new Uint32Array(values.length);
    const hasNulls = values.some((value) => value === null);
    const nullabilityBytes = hasNulls ? new Uint8Array(Math.ceil(values.length / 8)) : undefined;

    for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (value !== null) {
            indexBuffer[i] = uniqueValues.indexOf(value);
            if (nullabilityBytes) {
                nullabilityBytes[Math.floor(i / 8)] |= 1 << (i % 8);
            }
        }
    }

    const nullabilityBuffer = nullabilityBytes ? new BitVector(nullabilityBytes, values.length) : undefined;
    return new StringDictionaryVector(name, indexBuffer, offsetBuffer, dictionaryBuffer, nullabilityBuffer);
}
