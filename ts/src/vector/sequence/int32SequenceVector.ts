import { SequenceVector } from "./sequenceVector";
import type { MltColumnType } from "../../columns";

export class Int32SequenceVector extends SequenceVector<Int32Array | Uint32Array, number> {
    public constructor(name: string, baseValue: number, delta: number, size: number, isSigned: boolean) {
        super(name, isSigned ? Int32Array.of(baseValue) : Uint32Array.of(baseValue), delta, size);
    }
    protected getValueFromBuffer(index: number): number {
        return this.dataBuffer[0] + index * this.delta;
    }

    protected columnType(): MltColumnType {
        return this.dataBuffer instanceof Uint32Array ? "u32" : "i32";
    }
}
