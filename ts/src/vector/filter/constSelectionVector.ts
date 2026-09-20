import { type SelectionVector } from "./selectionVector";

/**
 * Minimal selection vector representing either a full or empty selection.
 * Uses minimal RAM by storing only state (full/empty) and length.
 */
export class ConstSelectionVector implements SelectionVector {
    /**
     * @param _kind Selection state: 0 = empty selection (no items selected), 1 = full selection (all items selected)
     * @param _length The capacity of the selection vector, representing the total number of items
     */
    constructor(
        private readonly _kind: 0 | 1,
        private readonly _length: number,
    ) {}

    /** @inheritdoc */
    getIndex(index: number): number {
        return this._kind === 1 ? index : -1;
    }

    /** @inheritdoc */
    setIndex(index: number, value: number): void {
        throw new Error("ConstSelectionVector is immutable");
    }

    /** @inheritdoc */
    setLimit(limit: number): void {
        throw new Error("ConstSelectionVector is immutable");
    }

    /** @inheritdoc */
    selectionValues(): Uint32Array {
        if (this._kind === 0) {
            return new Uint32Array(0);
        }

        const values = new Uint32Array(this._length);
        for (let i = 0; i < this._length; i++) {
            values[i] = i;
        }
        return values;
    }

    /** @inheritdoc */
    get limit(): number {
        return this._kind === 0 ? 0 : this._length;
    }

    /** @inheritdoc */
    get capacity(): number {
        return this._length;
    }

    /**
     * Creates a full selection vector where all items are selected.
     * @param length The capacity of the selection vector
     * @returns A ConstSelectionVector with all items selected
     */
    static full(length: number): ConstSelectionVector {
        return new ConstSelectionVector(1, length);
    }

    /**
     * Creates an empty selection vector where no items are selected.
     * @param length The capacity of the selection vector
     * @returns A ConstSelectionVector with no items selected
     */
    static empty(length: number): ConstSelectionVector {
        return new ConstSelectionVector(0, length);
    }
}
