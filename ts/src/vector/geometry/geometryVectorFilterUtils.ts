import type { SINGLE_PART_GEOMETRY_TYPE } from "./geometryType";
import { type SelectionVector } from "../filter/selectionVector";
import { FlatSelectionVector } from "../filter/flatSelectionVector";
import { SequenceSelectionVector } from "../filter/sequenceSelectionVector";

/**
 * Creates a selection vector for a const geometry vector filtered by type.
 *
 * For const vectors, all geometries have the same type, so either all match or none match.
 * Geometry type matching includes both exact matches and multi-type variants (e.g., POINT matches MULTIPOINT).
 *
 * @param targetType - The single-part geometry type to filter for (POINT, LINESTRING, or POLYGON)
 * @param vectorType - The geometry type of all geometries in the vector
 * @param numVectorGeometries - Total number of geometries in the vector
 * @returns A selection of every geometry if the types match, an empty selection otherwise
 */
export function createSelectionVectorByTypeConst(
    targetType: SINGLE_PART_GEOMETRY_TYPE,
    vectorType: number,
    numVectorGeometries: number,
): SelectionVector {
    if (targetType !== vectorType && targetType + 3 !== vectorType) {
        return new FlatSelectionVector(new Uint32Array(0));
    }
    return new SequenceSelectionVector(0, 1, numVectorGeometries);
}

/**
 * Filters an already-selected const geometry vector by type, modifying the selection in-place.
 *
 * For const vectors, either all selected geometries match or none match.
 * If types don't match, sets selection limit to 0.
 *
 * @param targetType - The single-part geometry type to filter for
 * @param vectorType - The geometry type of all geometries in the vector
 * @param selectionVector - Selection vector to modify in-place
 */
export function filterSelectedByTypeConst(
    targetType: SINGLE_PART_GEOMETRY_TYPE,
    vectorType: number,
    selectionVector: SelectionVector,
): void {
    if (targetType !== vectorType && targetType + 3 !== vectorType) {
        selectionVector.setLimit(0);
    }
}

/**
 * Creates a selection vector for a flat geometry vector filtered by type.
 *
 * Scans through all geometries and collects indices where the type matches.
 * Optimizes return type based on match count (empty, full, or flat selection).
 * Geometry type matching includes both exact matches and multi-type variants (e.g., POINT matches MULTIPOINT).
 *
 * @param targetType - The single-part geometry type to filter for
 * @param vectorGeometryTypes - Array of geometry types (one per geometry)
 * @param numVectorGeometries - Total number of geometries in the vector
 * @returns Selection vector containing indices of matching geometries
 */
export function createSelectionVectorByTypeFlat(
    targetType: SINGLE_PART_GEOMETRY_TYPE,
    vectorGeometryTypes: Int32Array | Uint32Array,
    numVectorGeometries: number,
): SelectionVector {
    const selectionVector = new Uint32Array(numVectorGeometries);
    let index = 0;

    for (let i = 0; i < numVectorGeometries; i++) {
        const type = vectorGeometryTypes[i];
        if (type === targetType || type === targetType + 3) {
            selectionVector[index++] = i;
        }
    }

    if (index === 0) {
        return new FlatSelectionVector(new Uint32Array(0));
    }
    if (index === numVectorGeometries) {
        return new SequenceSelectionVector(0, 1, numVectorGeometries);
    }
    return new FlatSelectionVector(selectionVector.subarray(0, index));
}

/**
 * Filters an already-selected flat geometry vector by type, modifying the selection in-place.
 *
 * Only checks geometries currently in the selection, compacting matching indices
 * to the front of the selection array and updating the limit.
 *
 * @param targetType - The single-part geometry type to filter for
 * @param vectorGeometryTypes - Array of geometry types (one per geometry)
 * @param selectionVector - Selection vector to modify in-place
 */
export function filterSelectedByTypeFlat(
    targetType: SINGLE_PART_GEOMETRY_TYPE,
    vectorGeometryTypes: Int32Array | Uint32Array,
    selectionVector: SelectionVector,
): void {
    let limit = 0;
    const vector = selectionVector.selectionValues();

    for (let i = 0; i < selectionVector.limit; i++) {
        const index = vector[i];
        const geometryType = vectorGeometryTypes[index];
        if (targetType === geometryType || targetType + 3 === geometryType) {
            vector[limit++] = index;
        }
    }

    selectionVector.setLimit(limit);
}

