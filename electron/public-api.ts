import type { ApiRequest } from "./types.js";

export function toPublicApiRequest(request: ApiRequest) {
  return {
    requestId: request.requestId,
    status: request.status,
    message: request.message,
    model: request.model,
    cleanVideoUrl: request.cleanVideoUrl,
    outputVideoPath: request.outputVideoPath,
    imageUrls: request.imageUrls,
    outputImagePaths: request.outputImagePaths,
    aspectRatio: request.aspectRatio,
    durationSeconds: request.durationSeconds ?? null,
    resolution: request.resolution,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    finishedAt: request.finishedAt
  };
}
