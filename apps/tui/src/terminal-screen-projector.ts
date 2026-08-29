const DEFAULT_MAXIMUM_LINES = 2_000;
const DEFAULT_MAXIMUM_BYTES = 512 * 1_024;
const MAXIMUM_ESCAPE_CHARACTERS = 4_096;
const TRUNCATION_MARKER = "[… older terminal output rotated away …]";

export interface TerminalScreenProjectorOptions {
  width: number;
  maximumLines?: number;
  maximumBytes?: number;
}

type ParserState = "text" | "escape" | "csi" | "control_string";

export class TerminalScreenProjector {
  private readonly decoder = new TextDecoder("utf-8");
  private readonly maximumLines: number;
  private readonly maximumBytes: number;
  private lines: string[] = [""];
  private cursorRow = 0;
  private cursorColumn = 0;
  private savedCursor = { row: 0, column: 0 };
  private width: number;
  private parserState: ParserState = "text";
  private escapeBuffer = "";
  private controlStringEscape = false;
  private truncated = false;

  public constructor(options: TerminalScreenProjectorOptions) {
    this.width = validBoundedInteger(options.width, 1, 500, "width");
    this.maximumLines = validBoundedInteger(
      options.maximumLines ?? DEFAULT_MAXIMUM_LINES,
      1,
      20_000,
      "maximumLines",
    );
    this.maximumBytes = validBoundedInteger(
      options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES,
      1_024,
      4 * 1_024 * 1_024,
      "maximumBytes",
    );
  }

  public push(bytes: Uint8Array): void {
    this.consume(this.decoder.decode(bytes, { stream: true }));
  }

  public finish(): void {
    this.consume(this.decoder.decode());
    this.parserState = "text";
    this.escapeBuffer = "";
    this.controlStringEscape = false;
  }

  public resize(width: number): void {
    this.width = validBoundedInteger(width, 1, 500, "width");
    this.lines = this.lines.map((line) =>
      [...line].slice(0, this.width).join(""),
    );
    this.cursorColumn = Math.min(this.cursorColumn, this.width - 1);
    this.enforceBounds();
  }

  public clear(): void {
    this.lines = [""];
    this.cursorRow = 0;
    this.cursorColumn = 0;
    this.savedCursor = { row: 0, column: 0 };
    this.parserState = "text";
    this.escapeBuffer = "";
    this.controlStringEscape = false;
    this.truncated = false;
  }

  public renderRows(height: number): readonly string[] {
    const boundedHeight = validBoundedInteger(height, 1, 500, "height");
    const rows = this.lines.map((line) => sanitizeProjectedLine(line));
    const withMarker = this.truncated ? [TRUNCATION_MARKER, ...rows] : rows;
    return withMarker.slice(Math.max(0, withMarker.length - boundedHeight));
  }

  public snapshot(): {
    rows: readonly string[];
    cursorRow: number;
    cursorColumn: number;
    truncated: boolean;
  } {
    return {
      rows: this.lines.map((line) => sanitizeProjectedLine(line)),
      cursorRow: this.cursorRow,
      cursorColumn: this.cursorColumn,
      truncated: this.truncated,
    };
  }

  private consume(text: string): void {
    for (const character of text) {
      this.consumeCharacter(character);
    }
    this.enforceBounds();
  }

  private consumeCharacter(character: string): void {
    if (this.parserState === "control_string") {
      if (character === "\u0007") {
        this.finishControlString();
      } else if (this.controlStringEscape && character === "\\") {
        this.finishControlString();
      } else {
        this.controlStringEscape = character === "\u001b";
        this.boundEscapeBuffer();
      }
      return;
    }
    if (this.parserState === "escape") {
      this.consumeEscape(character);
      return;
    }
    if (this.parserState === "csi") {
      this.escapeBuffer += character;
      if (/[@-~]/u.test(character)) {
        this.applyCsi(this.escapeBuffer);
        this.parserState = "text";
        this.escapeBuffer = "";
      } else {
        this.boundEscapeBuffer();
      }
      return;
    }
    if (character === "\u001b") {
      this.parserState = "escape";
      return;
    }
    switch (character) {
      case "\n":
        this.cursorRow += 1;
        this.ensureCursorRow();
        return;
      case "\r":
        this.cursorColumn = 0;
        return;
      case "\b":
        this.cursorColumn = Math.max(0, this.cursorColumn - 1);
        return;
      case "\t":
        this.cursorColumn = Math.min(
          this.width - 1,
          Math.floor(this.cursorColumn / 8 + 1) * 8,
        );
        return;
      default:
        if (isDisplayCharacter(character)) this.writeCharacter(character);
    }
  }

  private consumeEscape(character: string): void {
    this.parserState = "text";
    if (character === "[") {
      this.parserState = "csi";
      this.escapeBuffer = "";
      return;
    }
    if (["]", "P", "_", "^"].includes(character)) {
      this.parserState = "control_string";
      this.escapeBuffer = "";
      this.controlStringEscape = false;
      return;
    }
    if (character === "7") {
      this.savedCursor = { row: this.cursorRow, column: this.cursorColumn };
    } else if (character === "8") {
      this.cursorRow = Math.min(this.savedCursor.row, this.lines.length - 1);
      this.cursorColumn = Math.min(this.savedCursor.column, this.width - 1);
    } else if (character === "c") {
      this.clear();
    }
  }

  private applyCsi(sequence: string): void {
    const final = sequence.at(-1);
    if (final === undefined) return;
    const body = sequence.slice(0, -1).replace(/^[?>!]/u, "");
    const parameters = body
      .split(";")
      .map((value) => (value.length === 0 ? 0 : Number.parseInt(value, 10)))
      .map((value) => (Number.isFinite(value) ? value : 0));
    const parameter = (index: number, fallback = 1) => {
      const value = parameters[index] ?? 0;
      return value === 0 ? fallback : value;
    };
    switch (final) {
      case "A":
        this.cursorRow = Math.max(0, this.cursorRow - parameter(0));
        break;
      case "B":
        this.cursorRow += parameter(0);
        this.ensureCursorRow();
        break;
      case "C":
        this.cursorColumn = Math.min(
          this.width - 1,
          this.cursorColumn + parameter(0),
        );
        break;
      case "D":
        this.cursorColumn = Math.max(0, this.cursorColumn - parameter(0));
        break;
      case "E":
        this.cursorRow += parameter(0);
        this.cursorColumn = 0;
        this.ensureCursorRow();
        break;
      case "F":
        this.cursorRow = Math.max(0, this.cursorRow - parameter(0));
        this.cursorColumn = 0;
        break;
      case "G":
      case "`":
        this.cursorColumn = Math.min(this.width - 1, parameter(0) - 1);
        break;
      case "H":
      case "f":
        this.cursorRow = Math.max(0, parameter(0) - 1);
        this.cursorColumn = Math.min(this.width - 1, parameter(1) - 1);
        this.ensureCursorRow();
        break;
      case "J":
        this.eraseDisplay(parameters[0] ?? 0);
        break;
      case "K":
        this.eraseLine(parameters[0] ?? 0);
        break;
      case "s":
        this.savedCursor = { row: this.cursorRow, column: this.cursorColumn };
        break;
      case "u":
        this.cursorRow = Math.min(this.savedCursor.row, this.lines.length - 1);
        this.cursorColumn = Math.min(this.savedCursor.column, this.width - 1);
        break;
      default:
        // SGR, mode changes, reports, and unknown CSI are intentionally consumed.
        break;
    }
  }

  private eraseLine(mode: number): void {
    const line = [...(this.lines[this.cursorRow] ?? "")];
    if (mode === 2) {
      this.lines[this.cursorRow] = "";
    } else if (mode === 1) {
      for (let index = 0; index <= this.cursorColumn; index += 1)
        line[index] = " ";
      this.lines[this.cursorRow] = line.join("").trimEnd();
    } else {
      this.lines[this.cursorRow] = line.slice(0, this.cursorColumn).join("");
    }
  }

  private eraseDisplay(mode: number): void {
    if (mode === 2 || mode === 3) {
      this.lines = [""];
      this.cursorRow = 0;
      this.cursorColumn = 0;
      return;
    }
    if (mode === 1) {
      for (let row = 0; row < this.cursorRow; row += 1) this.lines[row] = "";
      this.eraseLine(1);
      return;
    }
    this.eraseLine(0);
    this.lines = this.lines.slice(0, this.cursorRow + 1);
  }

  private writeCharacter(character: string): void {
    if (this.cursorColumn >= this.width) {
      this.cursorRow += 1;
      this.cursorColumn = 0;
    }
    this.ensureCursorRow();
    const line = [...(this.lines[this.cursorRow] ?? "")];
    while (line.length < this.cursorColumn) line.push(" ");
    line[this.cursorColumn] = character;
    this.lines[this.cursorRow] = line.slice(0, this.width).join("");
    this.cursorColumn += 1;
  }

  private ensureCursorRow(): void {
    while (this.lines.length <= this.cursorRow) this.lines.push("");
  }

  private enforceBounds(): void {
    let removeCount = Math.max(0, this.lines.length - this.maximumLines);
    let bytes = projectedBytes(this.lines);
    while (removeCount < this.lines.length - 1 && bytes > this.maximumBytes) {
      bytes -= Buffer.byteLength(this.lines[removeCount] ?? "", "utf8") + 1;
      removeCount += 1;
    }
    if (removeCount > 0) {
      this.lines.splice(0, removeCount);
      this.cursorRow = Math.max(0, this.cursorRow - removeCount);
      this.savedCursor.row = Math.max(0, this.savedCursor.row - removeCount);
      this.truncated = true;
    }
    this.ensureCursorRow();
    this.cursorRow = Math.min(this.cursorRow, this.lines.length - 1);
    this.cursorColumn = Math.min(
      Math.max(0, this.cursorColumn),
      this.width - 1,
    );
  }

  private boundEscapeBuffer(): void {
    if (this.escapeBuffer.length > MAXIMUM_ESCAPE_CHARACTERS) {
      this.parserState = "text";
      this.escapeBuffer = "";
      this.controlStringEscape = false;
    }
  }

  private finishControlString(): void {
    this.parserState = "text";
    this.escapeBuffer = "";
    this.controlStringEscape = false;
  }
}

function projectedBytes(lines: readonly string[]): number {
  return lines.reduce(
    (total, line) => total + Buffer.byteLength(line, "utf8") + 1,
    0,
  );
}

function isDisplayCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    codePoint >= 0x20 &&
    codePoint !== 0x7f &&
    !(codePoint >= 0x80 && codePoint <= 0x9f)
  );
}

function sanitizeProjectedLine(line: string): string {
  return [...line].filter(isDisplayCharacter).join("").slice(0, 500);
}

function validBoundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return value;
}

export { TRUNCATION_MARKER as TERMINAL_TRUNCATION_MARKER };
