import Point from "@mapbox/point-geometry";
import { GEOMETRY_TYPE } from "./geometryType";
import { type CoordinatesArray } from "./geometryVector";
import { type IGpuVector } from "./gpuVector";

/**
 * Converts a GPU vector to an array of coordinate arrays.
 *
 * Only supports POLYGON and MULTIPOLYGON geometry types, as GPU vectors
 * are specifically designed for tessellated polygon rendering.
 *
 * The vertex buffer contains flattened x,y coordinates that are reconstructed
 * into rings using the topology vector offsets. Polygon rings are automatically
 * closed (last vertex duplicates first) per MVT format requirements.
 *
 * @param gpuVector - The GPU vector containing tessellated geometry data
 * @returns Array of coordinate arrays, one per geometry
 * @throws Error if the GPU vector lacks topology information
 *
 * @example
 * ```typescript
 * // GPU vector with one polygon (outer ring + hole)
 * const geometries = getGeometries(gpuVector);
 * // geometries[0] = [outerRing, holeRing]
 * ```
 */
export function getGeometries(gpuVector: IGpuVector): CoordinatesArray[] {
    const topologyVector = gpuVector.topologyVector;
    if (!topologyVector) {
        throw new Error("Cannot convert GpuVector to coordinates without topology information");
    }

    const geometries: CoordinatesArray[] = new Array(gpuVector.numGeometries);
    const partOffsets = topologyVector.partOffsets;
    const ringOffsets = topologyVector.ringOffsets;
    const geometryOffsets = topologyVector.geometryOffsets;
    const vertexBuffer = gpuVector.vertexBuffer;

    // Use counters to track position in offset arrays (like Java implementation)
    let vertexBufferOffset = 0;
    let partOffsetCounter = 1;
    let ringOffsetsCounter = 1;
    let geometryOffsetsCounter = 1;

    for (let i = 0; i < gpuVector.numGeometries; i++) {
        const geometryType = gpuVector.geometryType(i);

        switch (geometryType) {
            case GEOMETRY_TYPE.POLYGON:
                {
                    // Get number of rings for this polygon
                    const numRings = partOffsets[partOffsetCounter] - partOffsets[partOffsetCounter - 1];
                    partOffsetCounter++;
                    const rings: Point[][] = [];

                    for (let j = 0; j < numRings; j++) {
                        // Get number of vertices in this ring
                        const numVertices = ringOffsets[ringOffsetsCounter] - ringOffsets[ringOffsetsCounter - 1];
                        ringOffsetsCounter++;
                        const ring: Point[] = [];

                        for (let k = 0; k < numVertices; k++) {
                            const x = vertexBuffer[vertexBufferOffset++];
                            const y = vertexBuffer[vertexBufferOffset++];
                            ring.push(new Point(x, y));
                        }
                        // Close the ring by duplicating the first vertex (MVT format requirement)
                        if (ring.length > 0) {
                            ring.push(ring[0]);
                        }
                        rings.push(ring);
                    }

                    geometries[i] = rings;
                    if (geometryOffsets) geometryOffsetsCounter++;
                }
                break;
            case GEOMETRY_TYPE.MULTIPOLYGON:
                {
                    // Get number of polygons in this multipolygon
                    const numPolygons =
                        geometryOffsets[geometryOffsetsCounter] - geometryOffsets[geometryOffsetsCounter - 1];
                    geometryOffsetsCounter++;
                    const allRings: Point[][] = [];

                    for (let p = 0; p < numPolygons; p++) {
                        // Get number of rings in this polygon
                        const numRings = partOffsets[partOffsetCounter] - partOffsets[partOffsetCounter - 1];
                        partOffsetCounter++;

                        for (let j = 0; j < numRings; j++) {
                            // Get number of vertices in this ring
                            const numVertices = ringOffsets[ringOffsetsCounter] - ringOffsets[ringOffsetsCounter - 1];
                            ringOffsetsCounter++;
                            const ring: Point[] = [];

                            for (let k = 0; k < numVertices; k++) {
                                const x = vertexBuffer[vertexBufferOffset++];
                                const y = vertexBuffer[vertexBufferOffset++];
                                ring.push(new Point(x, y));
                            }
                            // Close the ring by duplicating the first vertex (MVT format requirement)
                            if (ring.length > 0) {
                                ring.push(ring[0]);
                            }
                            allRings.push(ring);
                        }
                    }

                    geometries[i] = allRings;
                }
                break;
        }
    }
    return geometries;
}
