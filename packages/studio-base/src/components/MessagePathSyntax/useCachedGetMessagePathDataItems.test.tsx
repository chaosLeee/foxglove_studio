/** @jest-environment jsdom */
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/
//
// This file incorporates work covered by the following copyright and
// permission notice:
//
//   Copyright 2018-2021 Cruise LLC
//
//   This source code is licensed under the Apache License, Version 2.0,
//   found at http://www.apache.org/licenses/LICENSE-2.0
//   You may not use this file except in compliance with the License.
import { act, renderHook } from "@testing-library/react-hooks";
import { cloneDeep } from "lodash";
import { useMemo } from "react";

import parseRosPath from "@foxglove/studio-base/components/MessagePathSyntax/parseRosPath";
import MockMessagePipelineProvider from "@foxglove/studio-base/components/MessagePipeline/MockMessagePipelineProvider";
import CurrentLayoutContext from "@foxglove/studio-base/context/CurrentLayoutContext";
import { GlobalVariables } from "@foxglove/studio-base/hooks/useGlobalVariables";
import { Topic, MessageEvent } from "@foxglove/studio-base/players/types";
import CurrentLayoutState, {
  DEFAULT_LAYOUT_FOR_TESTS,
} from "@foxglove/studio-base/providers/CurrentLayoutProvider/CurrentLayoutState";
import { RosDatatypes } from "@foxglove/studio-base/types/RosDatatypes";

import {
  fillInGlobalVariablesInPath,
  getMessagePathDataItems,
  useCachedGetMessagePathDataItems,
  useDecodeMessagePathsForMessagesByTopic,
} from "./useCachedGetMessagePathDataItems";

function addValuesWithPathsToItems(
  messages: MessageEvent<unknown>[],
  messagePath: string,
  providerTopics: Topic[],
  datatypes: RosDatatypes,
) {
  return messages.map((message) => {
    const rosPath = parseRosPath(messagePath);
    if (!rosPath) {
      return undefined;
    }
    const items = getMessagePathDataItems(message, rosPath, providerTopics, datatypes);
    return items?.map(({ value, path, constantName }) => ({
      value,
      path,
      constantName,
    }));
  });
}

describe("useCachedGetMessagePathDataItems", () => {
  const initialTopics = [{ name: "/topic", datatype: "datatype" }];
  const initialDatatypes: RosDatatypes = new Map(
    Object.entries({
      datatype: {
        definitions: [{ name: "an_array", type: "uint32", isArray: true, isComplex: false }],
      },
    }),
  );

  function setup(initialPaths: string[], initialGlobalVariables?: GlobalVariables) {
    const initialProps = {
      paths: initialPaths,
      topics: initialTopics,
      datatypes: initialDatatypes,
    };

    let setGlobalVariables = (_: GlobalVariables) => {};

    const { result, rerender } = renderHook(
      ({ paths }) => useCachedGetMessagePathDataItems(paths),
      {
        initialProps,
        wrapper: function Wrapper({ topics, datatypes, children }) {
          const currentLayout = useMemo(() => {
            const state = new CurrentLayoutState(DEFAULT_LAYOUT_FOR_TESTS);
            setGlobalVariables = state.actions.setGlobalVariables;
            if (initialGlobalVariables != undefined) {
              state.actions.setGlobalVariables(initialGlobalVariables);
            }
            return state;
          }, []);
          return (
            <CurrentLayoutContext.Provider value={currentLayout}>
              <MockMessagePipelineProvider topics={topics} datatypes={datatypes}>
                {children}
              </MockMessagePipelineProvider>
            </CurrentLayoutContext.Provider>
          );
        },
      },
    );

    return {
      result,
      rerender,
      initialProps,
      setGlobalVariables,
    };
  }

  it("clears the cache whenever any inputs to getMessagePathDataItems change", async () => {
    const message: MessageEvent<unknown> = {
      topic: "/topic",
      receiveTime: { sec: 0, nsec: 0 },
      message: { an_array: [5, 10, 15, 20] },
    };

    const { result, rerender, initialProps } = setup(["/topic.an_array[0]", "/topic.an_array[1]"]);

    const data0 = result.current("/topic.an_array[0]", message);
    const data1 = result.current("/topic.an_array[1]", message);
    expect(data0).toEqual([{ path: "/topic.an_array[0]", value: 5 }]);
    expect(data1).toEqual([{ path: "/topic.an_array[1]", value: 10 }]);

    // Calling again returns cached version.
    expect(result.current("/topic.an_array[0]", message)).toBe(data0);

    // Throws when asking for a path not in the list.
    expect(() => result.current("/topic.an_array[2]", message)).toThrow(
      "not in the list of cached paths",
    );

    // Using the exact same paths but with a new array instance will keep the returned function exactly the same.
    const originalCachedGetMessage = result.current;
    rerender({ ...initialProps, paths: ["/topic.an_array[0]", "/topic.an_array[1]"] });
    expect(result.current).toBe(originalCachedGetMessage);

    // Changing paths maintains cache for the remaining path.
    rerender({ ...initialProps, paths: ["/topic.an_array[0]"] });
    expect(result.current("/topic.an_array[0]", message)).toBe(data0);
    expect(() => result.current("/topic.an_array[1]", message)).toThrow(
      "not in the list of cached paths",
    );
    expect(result.current).not.toBe(originalCachedGetMessage); // Function should also be different.
    // Change it back to make sure that we indeed cleared the cache for the path that we removed.
    rerender({ ...initialProps, paths: ["/topic.an_array[0]", "/topic.an_array[1]"] });
    expect(result.current("/topic.an_array[1]", message)).not.toBe(data1);
    expect(result.current("/topic.an_array[0]", message)).toBe(data0); // Another sanity check.

    // Invalidate cache with topics.
    const data0BeforeProviderTopicsChange = result.current("/topic.an_array[0]", message);
    rerender({ ...initialProps, topics: cloneDeep(initialTopics) });
    expect(result.current("/topic.an_array[0]", message)).not.toBe(data0BeforeProviderTopicsChange);

    // Invalidate cache with datatypes.
    const data0BeforeDatatypesChange = result.current("/topic.an_array[0]", message);
    rerender({ ...initialProps, datatypes: cloneDeep(initialDatatypes) });
    expect(result.current("/topic.an_array[0]", message)).not.toBe(data0BeforeDatatypesChange);
  });

  it("clears the cache only when relevant global variables change", async () => {
    const message: MessageEvent<unknown> = {
      topic: "/topic",
      receiveTime: { sec: 0, nsec: 0 },
      message: { an_array: [5, 10, 15, 20] },
    };
    const { result, setGlobalVariables } = setup(["/topic.an_array[$foo]"], { foo: 0 });

    const data0 = result.current("/topic.an_array[$foo]", message);
    expect(data0).toEqual([{ path: "/topic.an_array[0]", value: 5 }]);

    // Sanity check.
    expect(result.current("/topic.an_array[$foo]", message)).toBe(data0);

    // Changing an unrelated global variable should not invalidate the cache.
    act(() => setGlobalVariables({ bar: 0 }));
    expect(result.current("/topic.an_array[$foo]", message)).toBe(data0);

    // Changing a relevant global variable.
    act(() => setGlobalVariables({ foo: 1 }));
    expect(result.current("/topic.an_array[$foo]", message)).toEqual([
      { path: "/topic.an_array[1]", value: 10 },
    ]);
  });

  describe("getMessagePathDataItems", () => {
    it("traverses down the path for every item", () => {
      const messages: MessageEvent<unknown>[] = [
        {
          topic: "/some/topic",
          receiveTime: { sec: 0, nsec: 0 },
          message: { some_array: [{ some_id: 10, some_message: { x: 10, y: 20 } }] },
        },
        {
          topic: "/some/topic",
          receiveTime: { sec: 0, nsec: 0 },
          message: {
            some_array: [
              { some_id: 10, some_message: { x: 10, y: 20 } },
              { some_id: 50, some_message: { x: 50, y: 60 } },
            ],
          },
        },
      ];
      const topics: Topic[] = [{ name: "/some/topic", datatype: "some_datatype" }];
      const datatypes: RosDatatypes = new Map(
        Object.entries({
          some_datatype: {
            definitions: [{ name: "some_array", type: "some_other_datatype", isArray: true }],
          },
          some_other_datatype: {
            definitions: [
              { name: "some_id", type: "uint32" },
              { name: "some_message", type: "yet_another_datatype" },
            ],
          },
          yet_another_datatype: {
            definitions: [
              { name: "x", type: "uint32" },
              { name: "y", type: "uint32" },
            ],
          },
        }),
      );

      expect(
        addValuesWithPathsToItems(
          messages,
          "/some/topic.some_array[:].some_message",
          topics,
          datatypes,
        ),
      ).toEqual([
        [
          {
            value: { x: 10, y: 20 },
            path: "/some/topic.some_array[0].some_message",
            constantName: undefined,
          },
        ],
        [
          {
            value: { x: 10, y: 20 },
            path: "/some/topic.some_array[0].some_message",
            constantName: undefined,
          },
          {
            value: { x: 50, y: 60 },
            path: "/some/topic.some_array[1].some_message",
            constantName: undefined,
          },
        ],
      ]);
    });
    describe("JSON", () => {
      it("traverses JSON fields", () => {
        const messages: MessageEvent<unknown>[] = [
          {
            topic: "/some/topic",
            receiveTime: { sec: 0, nsec: 0 },
            message: { someJson: { someId: 10 } },
          },
          {
            topic: "/some/topic",
            receiveTime: { sec: 0, nsec: 0 },
            message: { someJson: { someId: 11, anotherId: 12 } },
          },
        ];
        const topics: Topic[] = [{ name: "/some/topic", datatype: "some_datatype" }];
        const datatypes: RosDatatypes = new Map(
          Object.entries({
            some_datatype: { definitions: [{ name: "someJson", type: "json", isArray: false }] },
          }),
        );

        expect(
          addValuesWithPathsToItems(messages, "/some/topic.someJson", topics, datatypes),
        ).toEqual([
          [{ value: { someId: 10 }, path: "/some/topic.someJson", constantName: undefined }],
          [
            {
              value: { someId: 11, anotherId: 12 },
              path: "/some/topic.someJson",
              constantName: undefined,
            },
          ],
        ]);
        expect(
          addValuesWithPathsToItems(messages, "/some/topic.someJson.someId", topics, datatypes),
        ).toEqual([
          [{ value: 10, path: "/some/topic.someJson.someId", constantName: undefined }],
          [{ value: 11, path: "/some/topic.someJson.someId", constantName: undefined }],
        ]);
      });

      it("traverses nested JSON arrays", () => {
        const messages: MessageEvent<unknown>[] = [
          {
            topic: "/some/topic",
            receiveTime: { sec: 0, nsec: 0 },
            message: { jsonArr: [{ foo: { bar: 42 } }] },
          },
        ];
        const topics: Topic[] = [{ name: "/some/topic", datatype: "some_datatype" }];
        const datatypes: RosDatatypes = new Map(
          Object.entries({
            some_datatype: { definitions: [{ name: "jsonArr", type: "json", isArray: false }] },
          }),
        );

        expect(
          addValuesWithPathsToItems(messages, "/some/topic.jsonArr[0].foo.bar", topics, datatypes),
        ).toEqual([
          [{ value: 42, path: "/some/topic.jsonArr[0].foo.bar", constantName: undefined }],
        ]);
      });

      it("filters JSON arrays", () => {
        const messages: MessageEvent<unknown>[] = [
          {
            topic: "/some/topic",
            receiveTime: { sec: 0, nsec: 0 },
            message: { jsonArr: [{ id: 1, val: 42 }, { id: 2 }] },
          },
        ];
        const topics: Topic[] = [{ name: "/some/topic", datatype: "some_datatype" }];
        const datatypes: RosDatatypes = new Map(
          Object.entries({
            some_datatype: { definitions: [{ name: "jsonArr", type: "json", isArray: false }] },
          }),
        );
        const path = "/some/topic.jsonArr[:]{id==1}.val";
        expect(addValuesWithPathsToItems(messages, path, topics, datatypes)).toEqual([
          [{ value: 42, path, constantName: undefined }],
        ]);
      });

      it("traverses arrays of JSON", () => {
        const messages: MessageEvent<unknown>[] = [
          {
            topic: "/some/topic",
            receiveTime: { sec: 0, nsec: 0 },
            message: { jsonArr: [{ foo: 42 }] },
          },
        ];
        const topics: Topic[] = [{ name: "/some/topic", datatype: "some_datatype" }];
        const datatypes: RosDatatypes = new Map(
          Object.entries({
            some_datatype: { definitions: [{ name: "jsonArr", type: "json", isArray: true }] },
          }),
        );

        expect(
          addValuesWithPathsToItems(messages, "/some/topic.jsonArr[0].foo", topics, datatypes),
        ).toEqual([[{ value: 42, path: "/some/topic.jsonArr[0].foo", constantName: undefined }]]);
      });

      it("gracefully handles non-existent JSON fields", () => {
        const messages: MessageEvent<unknown>[] = [
          {
            topic: "/some/topic",
            receiveTime: { sec: 0, nsec: 0 },
            message: { someJson: { someId: 11, anotherId: 12 } },
          },
        ];
        const topics: Topic[] = [{ name: "/some/topic", datatype: "some_datatype" }];
        const datatypes: RosDatatypes = new Map(
          Object.entries({
            some_datatype: { definitions: [{ name: "someJson", type: "json", isArray: false }] },
          }),
        );

        expect(
          addValuesWithPathsToItems(messages, "/some/topic.someJson.badPath", topics, datatypes),
        ).toEqual([[]]);
        expect(
          addValuesWithPathsToItems(
            messages,
            "/some/topic.someJson.someId.badPath",
            topics,
            datatypes,
          ),
        ).toEqual([[]]);
        expect(
          addValuesWithPathsToItems(
            messages,
            "/some/topic.someJson[0].someId.badPath",
            topics,
            datatypes,
          ),
        ).toEqual([[]]);
      });
    });

    it("works with negative slices", () => {
      const messages: MessageEvent<unknown>[] = [
        {
          topic: "/some/topic",
          receiveTime: { sec: 0, nsec: 0 },
          message: { some_array: [1, 2, 3, 4, 5] },
        },
      ];
      const topics: Topic[] = [{ name: "/some/topic", datatype: "some_datatype" }];
      const datatypes: RosDatatypes = new Map(
        Object.entries({
          some_datatype: { definitions: [{ name: "some_array", type: "int32", isArray: true }] },
        }),
      );

      expect(
        addValuesWithPathsToItems(messages, "/some/topic.some_array[-2:-1]", topics, datatypes),
      ).toEqual([
        [
          { constantName: undefined, path: "/some/topic.some_array[-2]", value: 4 },
          { constantName: undefined, path: "/some/topic.some_array[-1]", value: 5 },
        ],
      ]);
    });

    it("returns nothing for invalid topics", () => {
      const messages: MessageEvent<unknown>[] = [
        {
          topic: "/some/topic",
          receiveTime: { sec: 0, nsec: 0 },
          message: { value: 1 },
        },
      ];
      // Topic not present
      expect(addValuesWithPathsToItems(messages, "/some/topic", [], new Map())).toEqual([
        undefined,
      ]);
    });

    it("handles fields inside times", () => {
      const topics: Topic[] = [{ name: "/some/topic", datatype: "std_msgs/Header" }];
      const datatypes: RosDatatypes = new Map(
        Object.entries({
          "std_msgs/Header": { definitions: [{ name: "stamp", type: "time", isArray: false }] },
        }),
      );
      const messages: MessageEvent<unknown>[] = [
        {
          topic: "/some/topic",
          receiveTime: { sec: 0, nsec: 0 },
          message: { stamp: { sec: 1, nsec: 2 } },
        },
      ];
      expect(
        addValuesWithPathsToItems(messages, "/some/topic.stamp.nsec", topics, datatypes),
      ).toEqual([[{ constantName: undefined, path: "/some/topic.stamp.nsec", value: 2 }]]);
    });

    it("filters properly, and uses the filter name in the path", () => {
      const messages: MessageEvent<unknown>[] = [
        {
          topic: "/some/topic",
          receiveTime: { sec: 0, nsec: 0 },
          message: {
            some_array: [
              {
                some_filter_value: 0,
                some_id: 10,
              },
              {
                some_filter_value: 1,
                some_id: 50,
              },
            ],
          },
        },
      ];
      const topics: Topic[] = [{ name: "/some/topic", datatype: "some_datatype" }];
      const datatypes: RosDatatypes = new Map(
        Object.entries({
          some_datatype: {
            definitions: [
              {
                name: "some_array",
                type: "some_other_datatype",
                isArray: true,
              },
            ],
          },
          some_other_datatype: {
            definitions: [
              {
                name: "some_filter_value",
                type: "uint32",
              },
              {
                name: "some_id",
                type: "uint32",
              },
            ],
          },
        }),
      );

      expect(
        addValuesWithPathsToItems(
          messages,
          "/some/topic.some_array[:]{some_filter_value==0}.some_id",
          topics,
          datatypes,
        ),
      ).toEqual([
        [
          {
            constantName: undefined,
            value: 10,
            path: "/some/topic.some_array[:]{some_filter_value==0}.some_id",
          },
        ],
      ]);
    });

    it("filters entire messages", () => {
      const messages: MessageEvent<unknown>[] = [
        {
          topic: "/some/topic",
          receiveTime: { sec: 0, nsec: 0 },
          message: {
            str_field: "A",
            num_field: 1,
          },
        },
        {
          topic: "/some/topic",
          receiveTime: { sec: 0, nsec: 0 },
          message: {
            str_field: "A",
            num_field: 2,
          },
        },
        {
          topic: "/some/topic",
          receiveTime: { sec: 0, nsec: 0 },
          message: {
            str_field: "B",
            num_field: 2,
          },
        },
      ];
      const topics: Topic[] = [{ name: "/some/topic", datatype: "some_datatype" }];
      const datatypes: RosDatatypes = new Map(
        Object.entries({
          some_datatype: {
            definitions: [
              {
                name: "str_field",
                type: "string",
              },
              {
                name: "num_field",
                type: "uint32",
              },
            ],
          },
        }),
      );

      expect(
        addValuesWithPathsToItems(
          messages,
          "/some/topic{str_field=='A'}.num_field",
          topics,
          datatypes,
        ),
      ).toEqual([
        [{ value: 1, path: "/some/topic{str_field=='A'}.num_field" }],
        [{ value: 2, path: "/some/topic{str_field=='A'}.num_field" }],
        [],
      ]);

      expect(
        addValuesWithPathsToItems(
          messages,
          "/some/topic{str_field=='B'}.num_field",
          topics,
          datatypes,
        ),
      ).toEqual([[], [], [{ value: 2, path: "/some/topic{str_field=='B'}.num_field" }]]);

      expect(
        addValuesWithPathsToItems(
          messages,
          "/some/topic{num_field==2}.num_field",
          topics,
          datatypes,
        ),
      ).toEqual([
        [],
        [{ value: 2, path: "/some/topic{num_field==2}.num_field" }],
        [{ value: 2, path: "/some/topic{num_field==2}.num_field" }],
      ]);

      expect(
        addValuesWithPathsToItems(
          messages,
          "/some/topic{str_field=='A'}{num_field==2}.num_field",
          topics,
          datatypes,
        ),
      ).toEqual([
        [],
        [{ value: 2, path: "/some/topic{str_field=='A'}{num_field==2}.num_field" }],
        [],
      ]);

      expect(
        addValuesWithPathsToItems(
          messages,
          "/some/topic{str_field=='C'}.num_field",
          topics,
          datatypes,
        ),
      ).toEqual([[], [], []]);
    });

    it("returns matching constants", () => {
      const messages: MessageEvent<unknown>[] = [
        {
          topic: "/some/topic",
          receiveTime: { sec: 0, nsec: 0 },
          message: {
            state: 0,
          },
        },
        {
          topic: "/some/topic",
          receiveTime: { sec: 0, nsec: 0 },
          message: {
            state: 1,
          },
        },
      ];
      const topics: Topic[] = [{ name: "/some/topic", datatype: "some_datatype" }];
      const datatypes: RosDatatypes = new Map(
        Object.entries({
          some_datatype: {
            definitions: [
              {
                name: "OFF",
                type: "uint32",
                isConstant: true,
                value: 0,
              },
              {
                name: "ON",
                type: "uint32",
                isConstant: true,
                value: 1,
              },
              {
                name: "state",
                type: "uint32",
              },
            ],
          },
        }),
      );

      expect(addValuesWithPathsToItems(messages, "/some/topic.state", topics, datatypes)).toEqual([
        [
          {
            value: 0,
            path: "/some/topic.state",
            constantName: "OFF",
          },
        ],
        [
          {
            value: 1,
            path: "/some/topic.state",
            constantName: "ON",
          },
        ],
      ]);
    });

    it("filters correctly with bigints", () => {
      const messages: MessageEvent<unknown>[] = [
        {
          topic: "/some/topic",
          receiveTime: { sec: 0, nsec: 0 },
          message: { str_field: "A", num_field: 18446744073709551616n },
        },
        {
          topic: "/some/topic",
          receiveTime: { sec: 0, nsec: 0 },
          message: { str_field: "B", num_field: 18446744073709552020n },
        },
      ];
      const topics: Topic[] = [{ name: "/some/topic", datatype: "some_datatype" }];
      const datatypes: RosDatatypes = new Map(
        Object.entries({
          some_datatype: {
            definitions: [{ name: "num_field", type: "uint64" }],
          },
        }),
      );

      expect(
        addValuesWithPathsToItems(
          messages,
          "/some/topic{num_field==18446744073709551616}.num_field",
          topics,
          datatypes,
        ),
      ).toEqual([
        [
          {
            value: 18446744073709551616n,
            path: "/some/topic{num_field==18446744073709551616}.num_field",
          },
        ],
        [],
      ]);

      expect(
        addValuesWithPathsToItems(
          messages,
          "/some/topic{num_field==18446744073709552020}.num_field",
          topics,
          datatypes,
        ),
      ).toEqual([
        [],
        [
          {
            value: 18446744073709552020n,
            path: "/some/topic{num_field==18446744073709552020}.num_field",
          },
        ],
      ]);
    });
  });
});

describe("fillInGlobalVariablesInPath", () => {
  it("fills in global variables in slices", () => {
    expect(
      fillInGlobalVariablesInPath(
        {
          topicName: "/foo",
          messagePath: [
            { type: "name", name: "bar" },
            {
              type: "slice",
              start: { variableName: "start", startLoc: 0 },
              end: { variableName: "end", startLoc: 0 },
            },
          ],
          modifier: undefined,
        },
        { start: 10, end: "123" },
      ),
    ).toEqual({
      topicName: "/foo",
      messagePath: [
        { name: "bar", type: "name" },
        { type: "slice", start: 10, end: 123 },
      ],
    });

    // Non-numbers
    expect(
      fillInGlobalVariablesInPath(
        {
          topicName: "/foo",
          messagePath: [
            { type: "name", name: "bar" },
            {
              type: "slice",
              start: { variableName: "start", startLoc: 0 },
              end: { variableName: "end", startLoc: 0 },
            },
          ],
          modifier: undefined,
        },
        { end: "blah" },
      ),
    ).toEqual({
      topicName: "/foo",
      messagePath: [
        { name: "bar", type: "name" },
        { type: "slice", start: 0, end: Infinity },
      ],
    });
  });

  it("fills in global variables in filters", () => {
    expect(
      fillInGlobalVariablesInPath(
        {
          topicName: "/foo",
          messagePath: [
            {
              type: "filter",
              path: ["bar"],
              value: { variableName: "var", startLoc: 0 },
              nameLoc: 0,
              valueLoc: 0,
              repr: "",
            },
          ],
          modifier: undefined,
        },
        { var: 123 },
      ),
    ).toEqual({
      topicName: "/foo",
      messagePath: [
        { type: "filter", path: ["bar"], value: 123, nameLoc: 0, valueLoc: 0, repr: "" },
      ],
    });
  });
});

describe("useDecodeMessagePathsForMessagesByTopic", () => {
  it("results in missing entries when no array is provided for a topic", () => {
    const topics = [
      { name: "/topic1", datatype: "datatype" },
      { name: "/topic2", datatype: "datatype" },
      { name: "/topic3", datatype: "datatype" },
    ];
    const datatypes: RosDatatypes = new Map(
      Object.entries({
        datatype: {
          definitions: [{ name: "value", type: "uint32", isArray: false, isComplex: false }],
        },
      }),
    );
    const currentLayout = new CurrentLayoutState(DEFAULT_LAYOUT_FOR_TESTS);
    const { result } = renderHook((paths) => useDecodeMessagePathsForMessagesByTopic(paths), {
      initialProps: ["/topic1.value", "/topic2.value", "/topic3.value", "/topic3..value"],
      wrapper({ children }) {
        return (
          <CurrentLayoutContext.Provider value={currentLayout}>
            <MockMessagePipelineProvider topics={topics} datatypes={datatypes}>
              {children}
            </MockMessagePipelineProvider>
          </CurrentLayoutContext.Provider>
        );
      },
    });

    const message = {
      topic: "/topic1",
      receiveTime: { sec: 0, nsec: 0 },
      message: { value: 1 },
    };
    const messagesByTopic = {
      "/topic1": [message],
      "/topic2": [],
    };
    expect(result.current(messagesByTopic)).toEqual({
      // Value for /topic1.value
      "/topic1.value": [{ message, queriedData: [{ path: "/topic1.value", value: 1 }] }],
      // Empty array for /topic2.value
      "/topic2.value": [],
      // No array for /topic3.value because the path is valid but the data is missing.
      // Empty array for /topic3..value because path is invalid.
      "/topic3..value": [],
    });
  });
});
