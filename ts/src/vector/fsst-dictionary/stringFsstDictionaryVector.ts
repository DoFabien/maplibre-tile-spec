import { VariableSizeVector } from "../variableSizeVector";
import type BitVector from "../flat/bitVector";
import { decodeFsst } from "../../decoding/fsstDecoder";
import { decodeString } from "../../decoding/decodingUtils";
import { dictionaryStrings } from "../dictionary/dictionaryStrings";
import type { MltColumnType, MltPropertyColumn } from "../../columns";

/** Mutable cache shared by the FSST child columns of one SharedDict. */
export type FsstDictionaryCache = {
    /** Undefined until one member of the SharedDict group decodes the dictionary on first access. */
    decodedDictionary?: Uint8Array;
};

export class StringFsstDictionaryVector extends VariableSizeVector<Uint8Array, string> {
    // TODO: extend from StringVector
    private symbolLengthBuffer?: Uint32Array;
    private decodedDictionary?: Uint8Array;

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
        const offset = this.indexBuffer[index];
        return decodeString(this.dictionaryBytes(), this.offsetBuffer[offset], this.offsetBuffer[offset + 1]);
    }

    protected columnType(): MltColumnType {
        return "string";
    }

    /** With `stringCodes`, the vector as codes into its dictionary, which the vectors of a shared dictionary share. */
    toColumn(stringCodes: boolean): MltPropertyColumn | undefined {
        if (!stringCodes) return super.toColumn(stringCodes);
        return {
            name: this.name,
            type: "string",
            codes: this.indexBuffer,
            dictionary: dictionaryStrings(this.dictionaryBytes(), this.offsetBuffer),
            present: this.nullabilityBuffer?.getBuffer(),
        };
    }

    /** The decoded dictionary, decoded on first use once for all the vectors of a shared dictionary. */
    private dictionaryBytes(): Uint8Array {
        this.decodedDictionary ??= this.sharedDictionaryCache?.decodedDictionary ?? this.decodeDictionary();
        if (this.sharedDictionaryCache) this.sharedDictionaryCache.decodedDictionary = this.decodedDictionary;
        return this.decodedDictionary;
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
}
