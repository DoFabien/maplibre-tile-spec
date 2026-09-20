import { convertGeometryVector as convertGeometryVectorImpl } from "./geometryVectorConverter";
import type { CoordinatesArray, MortonSettings, VertexBuffer, VertexOffsets } from "./geometryVector";
import { decodeZOrderCurve } from "./zOrderCurve";

export function convertGeometryVector(
    ...args: Parameters<typeof convertGeometryVectorImpl>
): ReturnType<typeof convertGeometryVectorImpl> {
    try {
        return convertGeometryVectorImpl(...args);
    } catch (error) {
        if (error instanceof Error && error.message.startsWith("The specified geometry type ")) {
            throw Object.assign(new Error("The specified geometry type is currently not supported."), { cause: error });
        }
        throw error;
    }
}

export function getSimpleEncodedVertex(
    index: number,
    vertexOffsets: VertexOffsets | undefined,
    vertexBuffer: VertexBuffer,
): [number, number] {
    const offset = vertexOffsets && vertexOffsets.length > 0 ? vertexOffsets[index] * 2 : index * 2;
    return [vertexBuffer[offset], vertexBuffer[offset + 1]];
}

export function getVertex(
    index: number,
    vertexOffsets: VertexOffsets | undefined,
    vertexBuffer: VertexBuffer,
    mortonSettings?: MortonSettings,
): [number, number] {
    if (vertexOffsets && vertexOffsets.length > 0 && mortonSettings) {
        const mortonCode = vertexBuffer[vertexOffsets[index]];
        const vertex = decodeZOrderCurve(mortonCode, mortonSettings.numBits, mortonSettings.coordinateShift);
        return [vertex.x, vertex.y];
    }

    return getSimpleEncodedVertex(index, vertexOffsets, vertexBuffer);
}

export type { CoordinatesArray };
