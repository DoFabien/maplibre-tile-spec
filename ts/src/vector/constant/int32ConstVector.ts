import type BitVector from "../flat/bitVector";
import Vector from "../vector";
import type { MltColumnType } from "../../columns";

export class Int32ConstVector extends Vector<Int32Array | Uint32Array, number> {
    public constructor(name: string, value: number, sizeOrNullabilityBuffer: number | BitVector, isSigned: boolean) {
        super(name, isSigned ? Int32Array.of(value) : Uint32Array.of(value), sizeOrNullabilityBuffer);
    }

    protected getValueFromBuffer(_index: number): number {
        return this.dataBuffer[0];
    }

    protected columnType(): MltColumnType {
        return this.dataBuffer instanceof Uint32Array ? "u32" : "i32";
    }
}
