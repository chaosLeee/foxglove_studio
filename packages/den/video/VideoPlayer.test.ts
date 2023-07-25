// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { VideoPlayer } from ".";

describe("VideoPlayer", () => {
  it("ParseDecoderConfig", () => {
    const metadata = [
      { key: "codec", value: "avc1.64001f" },
      { key: "codedWidth", value: "1200" },
      { key: "codedHeight", value: "720" },
      { key: "configuration", value: "qrvM" },
    ];

    const config = VideoPlayer.ParseDecoderConfig(metadata);
    expect(config).toEqual({
      codec: "avc1.64001f",
      codedWidth: 1280,
      codedHeight: 720,
      displayAspectWidth: undefined,
      displayAspectHeight: undefined,
      description: new Uint8Array([0xaa, 0xbb, 0xcc]),
    });

    const config2 = VideoPlayer.ParseDecoderConfig([]);
    expect(config2).toBeUndefined();
  });
});
