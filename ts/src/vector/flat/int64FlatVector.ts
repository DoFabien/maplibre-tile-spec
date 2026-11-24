import { FixedSizeVector } from "../fixedSizeVector";
import type { MltColumnType } from "../../columns";

export class Int64FlatVector extends FixedSizeVector<BigInt64Array | BigUint64Array, bigint> {
    protected getValueFromBuffer(index: number): bigint {
        return this.dataBuffer[index];
    }

    protected columnType(): MltColumnType {
        return "i64";
    }
}
