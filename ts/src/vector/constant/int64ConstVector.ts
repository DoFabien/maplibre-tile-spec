import type BitVector from "../flat/bitVector";
import Vector from "../vector";
import type { MltColumnType } from "../../columns";

export class Int64ConstVector extends Vector<BigInt64Array | BigUint64Array, bigint> {
    public constructor(name: string, value: bigint, sizeOrNullabilityBuffer: number | BitVector, isSigned: boolean) {
        super(name, isSigned ? BigInt64Array.of(value) : BigUint64Array.of(value), sizeOrNullabilityBuffer);
    }

    protected getValueFromBuffer(_index: number): bigint {
        return this.dataBuffer[0];
    }

    protected columnType(): MltColumnType {
        return "i64";
    }
}
