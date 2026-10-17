/**
 * Hermes (the Android/iOS JS engine) ships TextEncoder but not TextDecoder or DOMException,
 * and livekit-client uses both while its module loads. Without these the session screen fails
 * to load on the app and renders blank. Must be imported before anything that loads LiveKit.
 * No-op in browsers, which already provide both.
 */

const g = globalThis as any;

if (typeof g.DOMException === "undefined") {
  class DOMExceptionPolyfill extends Error {
    code = 0;
    constructor(message = "", name = "Error") {
      super(message);
      this.name = name;
      Object.setPrototypeOf(this, DOMExceptionPolyfill.prototype);
    }
  }
  g.DOMException = DOMExceptionPolyfill;
}

if (typeof g.TextDecoder === "undefined") {
  const UTF8_LABELS = new Set(["utf-8", "utf8", "unicode-1-1-utf-8"]);

  class TextDecoderPolyfill {
    readonly encoding = "utf-8";
    readonly fatal = false;
    readonly ignoreBOM = false;

    constructor(label = "utf-8") {
      if (!UTF8_LABELS.has(String(label).trim().toLowerCase())) {
        throw new RangeError(`TextDecoder polyfill only supports UTF-8, got "${label}"`);
      }
    }

    decode(input?: ArrayBuffer | ArrayBufferView | null): string {
      if (!input) return "";
      const bytes =
        input instanceof ArrayBuffer
          ? new Uint8Array(input)
          : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      const len = bytes.length;
      const isCont = (i: number) => i < len && (bytes[i] & 0xc0) === 0x80;

      let out = "";
      let units: number[] = [];
      let i = len >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;

      while (i < len) {
        const b = bytes[i++];
        let cp = 0xfffd;
        if (b < 0x80) {
          cp = b;
        } else if (b >= 0xc2 && b <= 0xdf && isCont(i)) {
          cp = ((b & 0x1f) << 6) | (bytes[i] & 0x3f);
          i += 1;
        } else if (b >= 0xe0 && b <= 0xef && isCont(i) && isCont(i + 1)) {
          const v = ((b & 0x0f) << 12) | ((bytes[i] & 0x3f) << 6) | (bytes[i + 1] & 0x3f);
          if (v >= 0x800 && (v < 0xd800 || v > 0xdfff)) cp = v;
          i += 2;
        } else if (b >= 0xf0 && b <= 0xf4 && isCont(i) && isCont(i + 1) && isCont(i + 2)) {
          const v =
            ((b & 0x07) << 18) |
            ((bytes[i] & 0x3f) << 12) |
            ((bytes[i + 1] & 0x3f) << 6) |
            (bytes[i + 2] & 0x3f);
          if (v >= 0x10000 && v <= 0x10ffff) cp = v;
          i += 3;
        }

        if (cp > 0xffff) {
          cp -= 0x10000;
          units.push(0xd800 | (cp >> 10), 0xdc00 | (cp & 0x3ff));
        } else {
          units.push(cp);
        }
        if (units.length >= 8192) {
          out += String.fromCharCode.apply(null, units);
          units = [];
        }
      }
      return out + String.fromCharCode.apply(null, units);
    }
  }
  g.TextDecoder = TextDecoderPolyfill;
}

export {};
