// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as base64 from "@protobufjs/base64";
import { Mutex } from "async-mutex";
import EventEmitter from "eventemitter3";

// foxglove-depcheck-used: @types/dom-webcodecs

const MAX_DECODE_WAIT_MS = 50;

type KeyValuePair = { key: string; value: string };

export type VideoPlayerEventTypes = {
  frame: (frame: VideoFrame) => void;
  debug: (message: string) => void;
  warn: (message: string) => void;
  error: (error: Error) => void;
};

/**
 * A wrapper around the WebCodecs VideoDecoder API that is safe to use from
 * multiple asynchronous contexts, is keyframe-aware, exposes a simple decode
 * method that takes a chunk of encoded video bitstream representing a single
 * frame and returns the decoded VideoFrame, and emits events for debugging
 * and error handling.
 */
export class VideoPlayer extends EventEmitter<VideoPlayerEventTypes> {
  #decoderInit: VideoDecoderInit;
  #decoder: VideoDecoder;
  #decoderConfig: VideoDecoderConfig | undefined;
  #hasKeyframe = false;
  #mutex = new Mutex();
  #pendingFrame: VideoFrame | undefined;
  #codedSize: { width: number; height: number } | undefined;
  #displaySize: { width: number; height: number } | undefined;

  /** Reports whether video decoding is supported in this browser session */
  public static IsSupported(): boolean {
    return self.isSecureContext && "VideoDecoder" in globalThis;
  }

  /**
   * Takes metadata from a `foxglove.CompressedVideo` message and returns a
   * VideoDecoderConfig object that can be passed to init().
   * @param metadata Metadata from a `foxglove.CompressedVideo` message
   * @returns A VideoDecoderConfig object or undefined if required keys are
   *   missing or parsing failed
   */
  public static ParseDecoderConfig(metadata: KeyValuePair[]): VideoDecoderConfig | undefined {
    // Convert the key=value pairs into a Map
    const params = new Map<string, string>();
    for (const { key, value } of metadata) {
      params.set(key, value);
    }

    const codec = params.get("codec");
    // const codec = "hev1.1.6.L150.B0";
    const codedWidthStr = params.get("codedWidth") ?? params.get("coded_width");
    const codedHeightStr = params.get("codedHeight") ?? params.get("coded_height");
    // const codedWidthStr = "3840";
    // const codedHeightStr = "2176";
    const displayAspectWidthStr =
      params.get("displayAspectWidth") ?? params.get("display_aspect_width");
    const displayAspectHeightStr =
      params.get("displayAspectHeight") ?? params.get("display_aspect_height");
    const descriptionStr = params.get("configuration") ?? params.get("description");
    // const descriptionStr = "";

    if (!codec) {
      return undefined;
    }

    const description = descriptionStr ? base64ToBytes(descriptionStr) : undefined;
    // const description = undefined;
    let codedWidth = codedWidthStr ? parseInt(codedWidthStr, 10) : undefined;
    let codedHeight = codedHeightStr ? parseInt(codedHeightStr, 10) : undefined;
    let displayAspectWidth = displayAspectWidthStr
      ? parseInt(displayAspectWidthStr, 10)
      : undefined;
    let displayAspectHeight = displayAspectHeightStr
      ? parseInt(displayAspectHeightStr, 10)
      : undefined;
    codedWidth ||= undefined;
    codedHeight ||= undefined;
    displayAspectWidth ||= undefined;
    displayAspectHeight ||= undefined;

    return {
      codec,
      codedHeight,
      codedWidth,
      description,
      displayAspectHeight,
      displayAspectWidth,
    };
  }

  public constructor() {
    super();
    this.#decoderInit = {
      output: (videoFrame) => {
        this.#pendingFrame?.close();
        this.#pendingFrame = videoFrame;
        this.emit("frame", videoFrame);
      },
      error: (error) => this.emit("error", error),
    };
    this.#decoder = new VideoDecoder(this.#decoderInit);
  }

  /**
   * Configures the VideoDecoder with the given VideoDecoderConfig. This must
   * be called before decode() will return a VideoFrame.
   */
  public async init(decoderConfig: VideoDecoderConfig): Promise<void> {
    await this.#mutex.acquire();

    // Optimize for latency means we do not have to call flush() in every decode() call
    // See <https://github.com/w3c/webcodecs/issues/206>
    decoderConfig.optimizeForLatency = true;
    decoderConfig.hardwareAcceleration = "prefer-hardware";

    const support = await VideoDecoder.isConfigSupported(decoderConfig);
    if (support.supported !== true) {
      const err = new Error(
        `VideoDecoder does not support configuration ${JSON.stringify(decoderConfig)}`,
      );
      this.emit("error", err);
      this.#mutex.release();
    }

    this.emit("debug", `Configuring VideoDecoder with ${JSON.stringify(decoderConfig)}`);
    this.#decoder.configure(decoderConfig);
    this.#decoderConfig = decoderConfig;
    this.#codedSize = undefined;
    this.#displaySize = undefined;
    if (decoderConfig.codedWidth != undefined && decoderConfig.codedHeight != undefined) {
      this.#codedSize = { width: decoderConfig.codedWidth, height: decoderConfig.codedHeight };
    }

    this.#mutex.release();
  }

  /** Returns true if the VideoDecoder is open and configured, ready for decoding. */
  public isInitialized(): boolean {
    return this.#decoder.state === "configured";
  }

  /** Returns true if the VideoDecoder has received a keyframe since the last reset. */
  public hasKeyframe(): boolean {
    return this.#hasKeyframe;
  }

  /** Returns the dimensions of the coded video frames, if known. */
  public codedSize(): { width: number; height: number } | undefined {
    return this.#codedSize;
  }

  /** Returns the display dimensions of the last decoded video frame, if known. */
  public displaySize(): { width: number; height: number } | undefined {
    return this.#displaySize;
  }

  /**
   * Takes a chunk of encoded video bitstream, sends it to the VideoDecoder,
   * and returns a Promise that resolves to the decoded VideoFrame. If the
   * VideoDecoder is not yet configured, we are waiting on a keyframe, or we
   * time out waiting for the decoder to return a frame, this will return
   * undefined.
   *
   * @param data A chunk of encoded video bitstream
   * @param timestampMicros The timestamp of the chunk of encoded video
   *   bitstream in microseconds relative to the start of the stream
   * @param type "key" if this chunk contains a keyframe, "delta" otherwise
   * @returns A VideoFrame or undefined if no frame was decoded
   */
  public async decode(
    data: Uint8Array,
    timestampMicros: number,
    type: "key" | "delta",
  ): Promise<VideoFrame | undefined> {
    await this.#mutex.acquire();

    if (this.#decoder.state === "closed") {
      this.emit("warn", "VideoDecoder is closed, creating a new one");
      this.#decoder = new VideoDecoder(this.#decoderInit);
    }

    if (this.#decoder.state === "unconfigured") {
      this.emit("debug", "Waiting for initialization...");
      this.#mutex.release();
      return undefined;
    }

    if (!this.#hasKeyframe) {
      if (type === "key") {
        this.#hasKeyframe = true;
      } else {
        this.emit("debug", `Waiting for keyframe...`);
        this.#mutex.release();
        return undefined;
      }
    }

    const decoding = new Promise<void>((resolve) => {
      const timeoutId = setTimeout(() => {
        this.emit(
          "warn",
          `Timed out decoding ${data.byteLength} byte chunk at time ${timestampMicros}`,
        );
        resolve(undefined);
      }, MAX_DECODE_WAIT_MS);
      this.once("frame", (_videoFrame) => {
        clearTimeout(timeoutId);
        resolve();
      });

      try {
        this.#decoder.decode(new EncodedVideoChunk({ type, data, timestamp: timestampMicros }));
      } catch (unk) {
        const err = unk as Error;
        this.emit(
          "error",
          new Error(
            `Failed to decode ${data.byteLength} byte chunk at time ${timestampMicros}: ${err.message}`,
          ),
        );
        resolve();
      }
    });

    await decoding;
    const maybeVideoFrame = this.#pendingFrame;
    this.#pendingFrame = undefined;

    // Update the coded and display sizes if we have a new frame
    if (maybeVideoFrame) {
      if (!this.#codedSize) {
        this.#codedSize = { width: 0, height: 0 };
      }
      this.#codedSize.width = maybeVideoFrame.codedWidth;
      this.#codedSize.height = maybeVideoFrame.codedHeight;

      if (!this.#displaySize) {
        this.#displaySize = { width: 0, height: 0 };
      }
      this.#displaySize.width = maybeVideoFrame.displayWidth;
      this.#displaySize.height = maybeVideoFrame.displayHeight;
    }

    this.#mutex.release();
    return maybeVideoFrame;
  }

  /**
   * Reset the VideoDecoder and clear any pending frames, but do not clear any
   * cached stream information or decoder configuration. This should be called
   * when seeking to a new position in the stream.
   */
  public resetForSeek(): void {
    this.#decoder.reset();
    if (this.#decoderConfig) {
      this.#decoder.configure(this.#decoderConfig);
    }
    this.#pendingFrame?.close();
    this.#pendingFrame = undefined;
    this.#hasKeyframe = false;
  }

  /**
   * Close the VideoDecoder and clear any pending frames. Also clear any cached
   * stream information or decoder configuration.
   */
  public close(): void {
    this.#decoder.close();
    this.#pendingFrame?.close();
    this.#pendingFrame = undefined;
  }
}

function base64ToBytes(b64Str: string): Uint8Array {
  const length = base64.length(b64Str);
  let bytes = new Uint8Array(length);
  const written = base64.decode(b64Str, bytes, 0);
  if (written !== length) {
    bytes = bytes.subarray(0, written);
  }
  return bytes;
}
