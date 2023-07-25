// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  decodeBGR8,
  decodeBGRA8,
  decodeBayerBGGR8,
  decodeBayerGBRG8,
  decodeBayerGRBG8,
  decodeBayerRGGB8,
  decodeFloat1c,
  decodeMono16,
  decodeMono8,
  decodeRGB8,
  decodeRGBA8,
  decodeYUV,
  decodeYUYV,
} from "@foxglove/den/image";
import { VideoPlayer } from "@foxglove/den/video";
import { toMicroSec } from "@foxglove/rostime";
import { RawImage } from "@foxglove/schemas";

import { CompressedImageTypes, CompressedVideo } from "./ImageTypes";
import { Image as RosImage } from "../../ros";

export async function decodeCompressedImageToBitmap(
  image: CompressedImageTypes,
  resizeWidth?: number,
): Promise<ImageBitmap> {
  const bitmapData = new Blob([image.data], { type: `image/${image.format}` });
  return await createImageBitmap(bitmapData, { resizeWidth });
}

export async function decodeCompressedVideoToBitmap(
  frameMsg: CompressedVideo,
  videoPlayer?: VideoPlayer,
  firstMessageTime?: bigint,
  resizeWidth?: number,
): Promise<ImageBitmap> {
  if (
    videoPlayer?.isInitialized() !== true ||
    (!videoPlayer.hasKeyframe() && !frameMsg.keyframe) ||
    firstMessageTime == undefined
  ) {
    return await emptyVideoFrame(videoPlayer, resizeWidth);
  }

  // Get the timestamp of this frame as microseconds relative to the first frame
  const firstTimestampMicros = Number(firstMessageTime / 1000n);
  const timestampMicros = toMicroSec(frameMsg.timestamp) - firstTimestampMicros;

  const videoFrame = await videoPlayer.decode(
    frameMsg.data,
    timestampMicros,
    frameMsg.keyframe ? "key" : "delta",
  );
  if (videoFrame) {
    const imageBitmap = await self.createImageBitmap(videoFrame, { resizeWidth });
    videoFrame.close();
    return imageBitmap;
  }
  return await emptyVideoFrame(videoPlayer, resizeWidth);
}

export type RawImageOptions = {
  minValue?: number;
  maxValue?: number;
};

export function decodeRawImage(
  image: RosImage | RawImage,
  options: RawImageOptions,
  output: Uint8ClampedArray,
): void {
  const { encoding, width, height } = image;
  const is_bigendian = "is_bigendian" in image ? image.is_bigendian : false;
  const rawData = image.data as Uint8Array;
  switch (encoding) {
    case "yuv422":
    case "uyuv":
      decodeYUV(image.data as Int8Array, width, height, output);
      break;
    case "yuyv":
      decodeYUYV(image.data as Int8Array, width, height, output);
      break;
    case "rgb8":
      decodeRGB8(rawData, width, height, output);
      break;
    case "rgba8":
      decodeRGBA8(rawData, width, height, output);
      break;
    case "bgra8":
      decodeBGRA8(rawData, width, height, output);
      break;
    case "bgr8":
    case "8UC3":
      decodeBGR8(rawData, width, height, output);
      break;
    case "32FC1":
      decodeFloat1c(rawData, width, height, is_bigendian, output);
      break;
    case "bayer_rggb8":
      decodeBayerRGGB8(rawData, width, height, output);
      break;
    case "bayer_bggr8":
      decodeBayerBGGR8(rawData, width, height, output);
      break;
    case "bayer_gbrg8":
      decodeBayerGBRG8(rawData, width, height, output);
      break;
    case "bayer_grbg8":
      decodeBayerGRBG8(rawData, width, height, output);
      break;
    case "mono8":
    case "8UC1":
      decodeMono8(rawData, width, height, output);
      break;
    case "mono16":
    case "16UC1":
      decodeMono16(rawData, width, height, is_bigendian, output, options);
      break;
    default:
      throw new Error(`Unsupported encoding ${encoding}`);
  }
}

// Performance sensitive, skip the extra await when returning a blank image
// eslint-disable-next-line @typescript-eslint/promise-function-async
function emptyVideoFrame(videoPlayer?: VideoPlayer, resizeWidth?: number): Promise<ImageBitmap> {
  const width = resizeWidth ?? 32;
  const size = videoPlayer?.codedSize() ?? { width, height: width };
  const data = new ImageData(size.width, size.height);
  return createImageBitmap(data, { resizeWidth });
}
