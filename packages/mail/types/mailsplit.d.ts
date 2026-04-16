declare module "@zone-eu/mailsplit" {
  import { Transform } from "node:stream";

  /**
   * MIME header parser and manager.
   *
   * Handles RFC 5322 header parsing, encoding/decoding, folding, and
   * CRLF normalization. Accessed via the `headers` property on node
   * objects emitted by {@link Splitter}.
   */
  class Headers {
    /** Remove all headers matching the key (case-insensitive). */
    remove(key: string): void;
    /** Return all raw header rows matching the key, including the key name. */
    get(key: string): string[];
    /** Return the decoded value of the first matching header (without the key name). */
    getFirst(key: string): string;
    /**
     * Add a header with the given key and value.
     * @param index Insertion position - 0 (default) inserts at the top, >= length appends.
     */
    add(key: string, value: string, index?: number): void;
  }

  /** A MIME part node emitted by {@link Splitter}. One per MIME part in the message. */
  interface SplitterNodeChunk {
    type: "node";
    /** True only for the top-level message node (where envelope headers like BCC live). */
    root: boolean;
    headers: Headers;
    contentType: string | false;
    encoding: string | false;
  }

  /** A body or boundary data chunk emitted by {@link Splitter}. */
  interface SplitterDataChunk {
    type: "data" | "body";
    value: Buffer;
  }

  /** Objects that flow through the Splitter -> transform -> Joiner pipeline. */
  type SplitterChunk = SplitterNodeChunk | SplitterDataChunk;

  /**
   * Transform stream that parses raw email bytes into structured MIME objects.
   *
   * Readable side emits {@link SplitterChunk} objects. Node chunks carry
   * headers and metadata; data/body chunks carry raw content bytes. Pipe
   * through a transform to modify headers, then into {@link Joiner} to
   * reconstruct.
   */
  class Splitter extends Transform {
    constructor();
  }

  /**
   * Transform stream that reconstructs raw email bytes from {@link Splitter} output.
   *
   * Accepts the {@link SplitterChunk} stream produced by Splitter (or a
   * transform sitting between them), emits binary email data. If no
   * modifications were made, the output is byte-identical to the original.
   */
  class Joiner extends Transform {
    constructor();
  }
}
