import { VariableSizeVector } from "../variableSizeVector";
import type BitVector from "../flat/bitVector";
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
