import type BitVector from "./flat/bitVector";
import type { MltColumn, MltColumnType, MltPropertyColumn } from "../columns";

export default abstract class Vector<T extends ArrayBufferView = ArrayBufferView, K = unknown> {
    protected nullabilityBuffer: BitVector | null;
    protected _size: number;

    constructor(
        private readonly _name: string,
        protected readonly dataBuffer: T,
        sizeOrNullabilityBuffer: number | BitVector,
    ) {
        if (typeof sizeOrNullabilityBuffer === "number") {
            this._size = sizeOrNullabilityBuffer;
        } else {
            this.nullabilityBuffer = sizeOrNullabilityBuffer;
            this._size = sizeOrNullabilityBuffer.size();
        }
    }

    getValue(index: number): K | null {
        return this.nullabilityBuffer && !this.nullabilityBuffer.get(index) ? null : this.getValueFromBuffer(index);
    }

    has(index: number): boolean {
        return this.nullabilityBuffer?.get(index) || !this.nullabilityBuffer;
    }

    get name(): string {
        return this._name;
    }

    get size(): number {
        return this._size;
    }

    /**
     * The vector as a property column of the type {@link columnType} gives it, read value by value: a 64-bit
     * integer as a double. A vector of values that are not scalars has no column. A vector that holds one value
     * per feature in a typed array, or its strings as a dictionary, hands that over instead.
     */
    toColumn(_stringCodes: boolean): MltPropertyColumn | undefined {
        const name = this.name;
        const present = this.nullabilityBuffer?.getBuffer();
        const size = this.size;
        switch (this.columnType()) {
            case "string": {
                const values = new Array<string>(size);
                for (let row = 0; row < size; row++) values[row] = (this.getValue(row) as string | null) ?? "";
                return { name, type: "string", values, present };
            }
            case "bool": {
                const values = new Uint8Array(size);
                for (let row = 0; row < size; row++) values[row] = this.getValue(row) ? 1 : 0;
                return { name, type: "bool", values, present };
            }
            case "i32":
                return { name, type: "i32", values: this.numericValues(new Int32Array(size)), present };
            case "u32":
                return { name, type: "u32", values: this.numericValues(new Uint32Array(size)), present };
            case "f32":
                return { name, type: "f32", values: this.numericValues(new Float32Array(size)), present };
            case "i64":
                return { name, type: "i64", values: this.numericValues(new Float64Array(size)), present };
            case "f64":
                return { name, type: "f64", values: this.numericValues(new Float64Array(size)), present };
            case undefined:
                return undefined;
        }
    }

    /**
     * The type of the column {@link toColumn} gives the vector, which the scalar type of the vector sets whatever
     * values it holds, or undefined for a vector of values that are not scalars.
     */
    protected abstract columnType(): MltColumnType | undefined;

    /** Fills `values` with the value of each feature as a number, `0` for a feature without one. */
    private numericValues<A extends Int32Array | Uint32Array | Float32Array | Float64Array>(values: A): A {
        for (let row = 0; row < values.length; row++) values[row] = Number(this.getValue(row) ?? 0);
        return values;
    }

    /** The values of the vector as doubles, a negative integer as the unsigned 64-bit number it is stored as. */
    toUnsignedColumn(): MltColumn<Float64Array> {
        const values = new Float64Array(this.size);
        for (let row = 0; row < values.length; row++) values[row] = unsigned(this.getValue(row));
        return { values, present: this.nullabilityBuffer?.getBuffer() };
    }

    protected abstract getValueFromBuffer(index: number): K;
}

/**
 * A value of a vector as the unsigned 64-bit integer it is stored as, in a double: a negative integer stands for
 * the unsigned one of the same 64 bits, and an absent value is `0`.
 */
function unsigned(value: unknown): number {
    if (typeof value === "bigint") return Number(BigInt.asUintN(64, value));
    if (typeof value !== "number") return 0;
    return Number.isInteger(value) && value < 0 ? Number(BigInt.asUintN(64, BigInt(value))) : value;
}
