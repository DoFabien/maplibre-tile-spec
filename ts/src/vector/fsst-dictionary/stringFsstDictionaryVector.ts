import { VariableSizeVector } from "../variableSizeVector";
import BitVector from "../flat/bitVector";
import { decodeFsst } from "../../decoding/fsstDecoder";
import { decodeString } from "../../decoding/decodingUtils";

const MAX_DECODED_STRING_CACHE_ENTRIES = 65_536;
const MAX_DECODED_STRING_CACHE_BYTES = 1024 * 1024;

/** Mutable cache shared by the FSST child columns of one SharedDict. */
export type FsstDictionaryCache = {
    /** Undefined until one member of the SharedDict group decodes the dictionary on first access. */
    decodedDictionary?: Uint8Array;
};

export class StringFsstDictionaryVector extends VariableSizeVector<Uint8Array, string> {
    // TODO: extend from StringVector
    private symbolLengthBuffer?: Uint32Array;
    private decodedDictionary!: Uint8Array;
    private decodedValueCache?: Array<string | undefined> | null;

    constructor(
        name: string,
        private readonly indexBuffer: Uint32Array,
        offsetBuffer: Uint32Array,
        dictionaryBuffer: Uint8Array,
        private readonly symbolOffsetBuffer: Uint32Array,
        private readonly symbolTableBuffer: Uint8Array,
        nullabilityBuffer?: BitVector,
        /** Cache shared by the FSST child columns of one SharedDict. */
        private readonly sharedDictionaryCache?: FsstDictionaryCache,
    ) {
        super(name, offsetBuffer, dictionaryBuffer, nullabilityBuffer ?? indexBuffer.length);
    }

    protected getValueFromBuffer(index: number): string {
        return this.getDictionaryValue(this.indexBuffer[index]);
    }

    /** The string of a dictionary entry, which rows refer to by {@link index}. */
    getDictionaryValue(offset: number): string {
        this.ensureDecodedDictionary();

        const start = this.offsetBuffer[offset];
        const end = this.offsetBuffer[offset + 1];
        const cache = this.getDecodedValueCache();
        if (!cache) {
            return decodeString(this.decodedDictionary, start, end);
        }

        const cached = cache[offset];
        if (cached !== undefined) return cached;

        const decoded = decodeString(this.decodedDictionary, start, end);
        cache[offset] = decoded;
        return decoded;
    }

    private ensureDecodedDictionary(): void {
        if (this.decodedDictionary != null) return;
        this.decodedDictionary = this.sharedDictionaryCache?.decodedDictionary;
        if (this.decodedDictionary == null) {
            this.decodedDictionary = this.decodeDictionary();
            if (this.sharedDictionaryCache) {
                this.sharedDictionaryCache.decodedDictionary = this.decodedDictionary;
            }
        }
    }

    /** See StringDictionaryVector for the matching cache policy. */
    private getDecodedValueCache(): Array<string | undefined> | null {
        if (this.decodedValueCache !== undefined) return this.decodedValueCache;

        const dictionarySize = this.offsetBuffer.length - 1;
        this.decodedValueCache =
            dictionarySize <= MAX_DECODED_STRING_CACHE_ENTRIES &&
            this.decodedDictionary.byteLength <= MAX_DECODED_STRING_CACHE_BYTES
                ? new Array<string | undefined>(dictionarySize)
                : null;
        return this.decodedValueCache;
    }

    private decodeDictionary(): Uint8Array {
        if (this.symbolLengthBuffer == null) {
            this.symbolLengthBuffer = this.offsetToLengthBuffer(this.symbolOffsetBuffer);
        }
        return decodeFsst(this.symbolTableBuffer, this.symbolLengthBuffer, this.dataBuffer);
    }

    // TODO: get rid of that conversion
    private offsetToLengthBuffer(offsetBuffer: Uint32Array): Uint32Array {
        const lengthBuffer = new Uint32Array(offsetBuffer.length - 1);
        let previousOffset = offsetBuffer[0];
        for (let i = 1; i < offsetBuffer.length; i++) {
            const offset = offsetBuffer[i];
            lengthBuffer[i - 1] = offset - previousOffset;
            previousOffset = offset;
        }

        return lengthBuffer;
    }

    /** Number of dictionary entries. */
    get dictionarySize(): number {
        return this.offsetBuffer.length - 1;
    }

    get index() {
        return this.indexBuffer;
    }
}

export function createStringFsstDictionaryVector(values: (string | null)[], name: string): StringFsstDictionaryVector {
    const encoder = new TextEncoder();
    const nonNullValues = values.filter((v): v is string => v !== null);
    const uniqueValues = Array.from(new Set(nonNullValues));
    const encodedDict = uniqueValues.map((v) => encoder.encode(v));

    // Create FSST-compressed dictionary
    const compressedSize = encodedDict.reduce((sum, v) => sum + v.length * 2, 0);
    const dictionaryBuffer = new Uint8Array(compressedSize);
    const offsetBuffer = new Uint32Array(uniqueValues.length + 1);
    let compressedOffset = 0;
    let decompressedOffset = 0;
    offsetBuffer[0] = 0;

    for (let i = 0; i < encodedDict.length; i++) {
        const encoded = encodedDict[i];
        for (let j = 0; j < encoded.length; j++) {
            dictionaryBuffer[compressedOffset++] = 255; // Escape code
            dictionaryBuffer[compressedOffset++] = encoded[j];
        }
        decompressedOffset += encoded.length;
        offsetBuffer[i + 1] = decompressedOffset;
    }

    // Create index and nullability buffers
    const indexBuffer = new Uint32Array(values.length);
    const nullabilityBytes = new Uint8Array(Math.ceil(values.length / 8));

    for (let i = 0; i < values.length; i++) {
        if (values[i] !== null) {
            indexBuffer[i] = uniqueValues.indexOf(values[i]);
            const byteIndex = Math.floor(i / 8);
            const bitIndex = i % 8;
            nullabilityBytes[byteIndex] |= 1 << bitIndex;
        } else {
            indexBuffer[i] = 0;
        }
    }

    const symbolOffsetBuffer = new Uint32Array([0, 0]);
    const symbolTableBuffer = new Uint8Array(0);
    const bitVector = new BitVector(nullabilityBytes, values.length);

    return new StringFsstDictionaryVector(
        name,
        indexBuffer,
        offsetBuffer,
        dictionaryBuffer,
        symbolOffsetBuffer,
        symbolTableBuffer,
        bitVector,
    );
}
