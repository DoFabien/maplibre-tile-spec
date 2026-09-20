import { VariableSizeVector } from "../variableSizeVector";
import BitVector from "./bitVector";
import { decodeString } from "../../decoding/decodingUtils";

export class StringFlatVector extends VariableSizeVector<Uint8Array, string> {
    constructor(name: string, offsetBuffer: Uint32Array, dataBuffer: Uint8Array, nullabilityBuffer?: BitVector) {
        super(name, offsetBuffer, dataBuffer, nullabilityBuffer ?? offsetBuffer.length - 1);
    }

    protected getValueFromBuffer(index: number): string {
        const start = this.offsetBuffer[index];
        const end = this.offsetBuffer[index + 1];
        return decodeString(this.dataBuffer, start, end);
    }
}

export function createNullableStringVector(values: (string | null)[], name: string): StringFlatVector {
    const encoder = new TextEncoder();
    const nonNullValues = values.map((v) => (v === null ? new Uint8Array(0) : encoder.encode(v)));
    const totalSize = nonNullValues.reduce((sum, v) => sum + v.length, 0);

    const offsetBuffer = new Uint32Array(values.length + 1);
    const dataBuffer = new Uint8Array(totalSize);
    const nullabilityBytes = new Uint8Array(Math.ceil(values.length / 8));

    let currentOffset = 0;
    offsetBuffer[0] = 0;

    for (let i = 0; i < values.length; i++) {
        const encoded = nonNullValues[i];
        dataBuffer.set(encoded, currentOffset);
        currentOffset += encoded.length;
        offsetBuffer[i + 1] = currentOffset;

        if (values[i] !== null) {
            const byteIndex = Math.floor(i / 8);
            const bitIndex = i % 8;
            nullabilityBytes[byteIndex] |= 1 << bitIndex;
        }
    }

    const bitVector = new BitVector(nullabilityBytes, values.length);
    return new StringFlatVector(name, offsetBuffer, dataBuffer, bitVector);
}

export function createStringFlatVector(values: string[], name: string): StringFlatVector {
    const encoder = new TextEncoder();
    const encodedValues = values.map((v) => encoder.encode(v));
    const totalSize = encodedValues.reduce((sum, v) => sum + v.length, 0);

    const offsetBuffer = new Uint32Array(values.length + 1);
    const dataBuffer = new Uint8Array(totalSize);

    let currentOffset = 0;
    offsetBuffer[0] = 0;

    for (let i = 0; i < encodedValues.length; i++) {
        const encoded = encodedValues[i];
        dataBuffer.set(encoded, currentOffset);
        currentOffset += encoded.length;
        offsetBuffer[i + 1] = currentOffset;
    }

    return new StringFlatVector(name, offsetBuffer, dataBuffer);
}
