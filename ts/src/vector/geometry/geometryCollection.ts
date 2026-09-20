import { type SINGLE_PART_GEOMETRY_TYPE } from "./geometryType";
import { type SelectionVector } from "../filter/selectionVector";

export interface IGeometryCollection {
    geometryType(index: number): number;

    readonly numGeometries: number;

    containsSingleGeometryType(): boolean;

    filter(geometryType: SINGLE_PART_GEOMETRY_TYPE): SelectionVector;

    filterSelected(geometryType: SINGLE_PART_GEOMETRY_TYPE, selectionVector: SelectionVector): void;
}
