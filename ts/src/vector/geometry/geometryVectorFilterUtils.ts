import { type SINGLE_PART_GEOMETRY_TYPE, GEOMETRY_TYPE } from "./geometryType";
import { type SelectionVector } from "../filter/selectionVector";
import { ConstSelectionVector } from "../filter/constSelectionVector";
import { FlatSelectionVector } from "../filter/flatSelectionVector";

/**
 * Creates a selection vector for a const geometry vector filtered by type.
 *
 * For const vectors, all geometries have the same type, so either all match or none match.
 * Geometry type matching includes both exact matches and multi-type variants (e.g., POINT matches MULTIPOINT).
 *
 * @param targetType - The single-part geometry type to filter for (POINT, LINESTRING, or POLYGON)
 * @param vectorType - The geometry type of all geometries in the vector
 * @param numVectorGeometries - Total number of geometries in the vector
 * @returns ConstSelectionVector.full if types match, ConstSelectionVector.empty otherwise
 */
export function createSelectionVectorByTypeConst(
    targetType: SINGLE_PART_GEOMETRY_TYPE,
    vectorType: number,
    numVectorGeometries: number,
): SelectionVector {
    if (targetType !== vectorType && targetType + 3 !== vectorType) {
        return ConstSelectionVector.empty(numVectorGeometries);
    }
    return ConstSelectionVector.full(numVectorGeometries);
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
        return ConstSelectionVector.empty(numVectorGeometries);
    }
    if (index === numVectorGeometries) {
        return ConstSelectionVector.full(numVectorGeometries);
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

/**
 * Checks if a const geometry vector contains polygon geometries.
 *
 * @param geometryType - The geometry type (all geometries have this type in a const vector)
 * @returns True if the type is POLYGON or MULTIPOLYGON
 */
export function containsPolygonGeometryConst(geometryType: number): boolean {
    return geometryType === GEOMETRY_TYPE.POLYGON || geometryType === GEOMETRY_TYPE.MULTIPOLYGON;
}

/**
 * Checks if a flat geometry vector contains any polygon geometries.
 *
 * Scans through all geometry types looking for POLYGON or MULTIPOLYGON.
 *
 * @param geometryTypes - Array of geometry types to check
 * @returns True if any geometry is POLYGON or MULTIPOLYGON
 */
export function containsPolygonGeometryFlat(geometryTypes: Int32Array | Uint32Array): boolean {
    for (let i = 0; i < geometryTypes.length; i++) {
        if (containsPolygonGeometryConst(geometryTypes[i])) {
            return true;
        }
    }
    return false;
}
