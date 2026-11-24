import { VariableSizeVector } from "../variableSizeVector";
import type BitVector from "../flat/bitVector";
import { decodeString } from "../../decoding/decodingUtils";
import { dictionaryStrings } from "./dictionaryStrings";
import type { MltColumnType, MltPropertyColumn } from "../../columns";

export class StringDictionaryVector extends VariableSizeVector<Uint8Array, string> {
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
        const offset = this.indexBuffer[index];
        const start = this.offsetBuffer[offset];
        const end = this.offsetBuffer[offset + 1];
        return decodeString(this.dataBuffer, start, end);
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
            dictionary: dictionaryStrings(this.dataBuffer, this.offsetBuffer),
            present: this.nullabilityBuffer?.getBuffer(),
        };
    }
}
