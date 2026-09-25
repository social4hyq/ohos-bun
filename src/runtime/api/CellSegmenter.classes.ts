import { define } from "../../codegen/class-definitions.ts";

export default [
  define({
    name: "CellSegmenter",
    construct: true,
    finalize: true,
    configurable: false,
    klass: {},
    JSType: "0b11101110",
    proto: {
      graphemes: {
        getter: "getGraphemes",
      },
      sgrKeys: {
        getter: "getSgrKeys",
      },
      sgrCloseKeys: {
        getter: "getSgrCloseKeys",
      },
      uris: {
        getter: "getUris",
      },
      segment: {
        fn: "segment",
        length: 4,
      },
      setCell: {
        fn: "setCell",
        length: 6,
      },
      paint: {
        fn: "paint",
        length: 9,
      },
    },
  }),
];
