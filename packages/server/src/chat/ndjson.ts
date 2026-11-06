/** Longest line kept while waiting for its newline; a longer partial line is dropped (protects memory). */
export const MAX_NDJSON_LINE_CHARS = 32 * 1024 * 1024;

/**
 * Splits a byte/char stream into newline-delimited JSON values. Chunks may cut lines anywhere (also
 * inside a multi-byte UTF-8 character: decoding is streaming). Lines that are blank are skipped; lines
 * that are not JSON go to `onInvalid` (Claude Code may print plain text warnings on stdout).
 */
export class NdjsonParser {
  private buffer = "";
  private readonly decoder = new TextDecoder("utf-8");

  constructor(
    private readonly onValue: (value: unknown) => void,
    private readonly onInvalid: (line: string) => void = () => undefined,
  ) {}

  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.emit(line);
      newline = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > MAX_NDJSON_LINE_CHARS) {
      this.onInvalid(`${this.buffer.slice(0, 200)}… (line too long, dropped)`);
      this.buffer = "";
    }
  }

  /** Parses a trailing line without newline (end of stream). */
  flush(): void {
    this.buffer += this.decoder.decode();
    const rest = this.buffer;
    this.buffer = "";
    this.emit(rest);
  }

  private emit(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return this.onInvalid(trimmed);
    }
    this.onValue(value);
  }
}
