#!/usr/bin/env node

import { access, mkdir } from "fs/promises";
import { constants, createWriteStream, readFileSync } from "fs";
import path from "path";
import process from "process";
import { inflateSync, unzipSync } from "fflate";
import { decompress } from "fzstd";
import { compileSchema, decodeBinarySchema } from "kiwi-schema";

const FIG_KIWI_PRELUDE = "fig-kiwi";
const FIGJAM_KIWI_PRELUDE = "fig-jam.";
const FIGDECK_KIWI_PRELUDE = "fig-deck";

const ZIP_SIGNATURE = [80, 75, 3, 4];
const ZSTD_SIGNATURE = [40, 181, 47, 253];

type FigmaFileType = "DESIGN" | "FIGJAM" | "SLIDES";

type RawObject = Record<string, unknown>;

type ParsedFigmaArchive = {
  meta: {
    fileType: FigmaFileType;
    version: number;
    parsedAt: string;
    isZipContainer: boolean;
    embeddedImages: string[];
    file?: unknown;
  };
  document: RawObject;
};

type CliOptions = {
  input?: string;
  out?: string;
  metaOut?: string;
  node?: string;
  path?: string;
  meta: boolean;
  tokens: boolean;
  minify: boolean;
  debug: boolean;
  help: boolean;
  selfTestBigIntJson: boolean;
};

type DebugLogger = (message: string) => void;

type TokenSummary = {
  source: "fig";
  scope: {
    type: "document" | "node" | "path";
    nodeId?: string;
    path?: string;
  };
  tokens: {
    colors: TokenRecord[];
    typography: TokenRecord[];
    effects: TokenRecord[];
    styles: TokenRecord[];
  };
};

type TokenRecord = {
  path: string;
  value: unknown;
};

const helpText = `Usage:
  fig-to-json <input.fig> [--out <path>] [--meta-out <path>] [--node <id>] [--path <path>] [--meta] [--tokens] [--minify]

Options:
  --out <path>       Write document JSON to this file instead of stdout.
  --meta-out <path>  Also write metadata JSON to this file.
  --node <id>        Write the raw node subtree for this Figma node ID.
  --path <path>      Write a raw value by dot path, e.g. nodeChanges.0.
  --meta             Write metadata JSON instead of document JSON.
  --tokens           Extract a token summary from the selected raw document scope.
  --minify           Write compact JSON. Defaults to pretty JSON.
  --debug            Write parse/selection/serialization diagnostics to stderr.
  -h, --help         Show this help message.

Examples:
  npm run convert -- ./design.fig --out ./document.json --meta-out ./meta.json
  npm run convert -- ./design.fig --meta --out ./meta.json
  npm run convert -- ./design.fig --node "1:23" --out ./node.json
  npm run convert -- ./design.fig --path nodeChanges.0
  npm run convert -- ./design.fig --tokens --out ./tokens.json
  npm run convert -- ./design.fig --node "1:23" --tokens --out ./node-tokens.json
`;

async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const debug = createDebugLogger(options.debug);

  if (options.selfTestBigIntJson) {
    await runBigIntJsonSelfTest();
    return;
  }

  if (options.help) {
    process.stdout.write(helpText);
    return;
  }

  if (!options.input) {
    throw new CliError("Missing required input .fig path.\n\n" + helpText);
  }

  assertFigExtension(options.input);
  await assertReadableFile(options.input);
  debug(`input=${options.input}`);

  const archive = loadParsedFigmaArchive(options.input, debug);

  if (options.meta && (options.node || options.path || options.tokens)) {
    throw new CliError("--meta cannot be combined with --node, --path, or --tokens.");
  }

  if (options.metaOut) {
    debug(`streaming meta output: ${summarizeValue(archive.meta)}`);
    await writeJsonOutput(options.metaOut, archive.meta, options.minify, "metadata output", debug);
  }

  const selected = selectRawScope(archive.document, options);
  debug(`selected scope=${scopeLabel(selected.scope)} value=${summarizeValue(selected.value)}`);
  const value = options.meta
    ? archive.meta
    : options.tokens
      ? extractTokens(selected.value, selected.scope)
      : selected.value;
  debug(`final output value=${summarizeValue(value)}`);
  const outputMode = outputModeLabel(options);
  debug(`streaming output mode=${outputMode}`);

  if (options.out) {
    await writeJsonOutput(options.out, value, options.minify, `${outputMode} output`, debug);
    return;
  }

  await writeJsonToWritable(process.stdout, value, options.minify, `${outputMode} output`);
  process.stdout.write("\n");
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    meta: false,
    tokens: false,
    minify: false,
    debug: false,
    help: false,
    selfTestBigIntJson: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }

    if (arg === "--self-test-bigint-json") {
      options.selfTestBigIntJson = true;
      continue;
    }

    if (arg === "--minify") {
      options.minify = true;
      continue;
    }

    if (arg === "--debug") {
      options.debug = true;
      continue;
    }

    if (arg === "--tokens") {
      options.tokens = true;
      continue;
    }

    if (arg === "--meta") {
      options.meta = true;
      continue;
    }

    if (arg === "--raw") {
      continue;
    }

    if (arg === "--out" || arg === "--meta-out" || arg === "--node" || arg === "--path") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CliError(`Missing value for ${arg}.`);
      }

      if (arg === "--out") {
        options.out = value;
      } else if (arg === "--meta-out") {
        options.metaOut = value;
      } else if (arg === "--node") {
        options.node = value;
      } else {
        options.path = value;
      }

      index += 1;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new CliError(`Unknown option: ${arg}`);
    }

    if (options.input) {
      throw new CliError(`Unexpected extra argument: ${arg}`);
    }

    options.input = arg;
  }

  return options;
}

function assertFigExtension(filePath: string): void {
  if (path.extname(filePath).toLowerCase() !== ".fig") {
    throw new CliError(`Input must be a .fig file: ${filePath}`);
  }
}

async function assertReadableFile(filePath: string): Promise<void> {
  try {
    await access(filePath, constants.R_OK);
  } catch {
    throw new CliError(`Input file is not readable or does not exist: ${filePath}`);
  }
}

function loadParsedFigmaArchive(filePath: string, debug: DebugLogger): ParsedFigmaArchive {
  try {
    const fileBytes = readFileSync(filePath);
    debug(`input bytes=${fileBytes.length}`);
    return parseFigmaArchive(fileBytes, debug);
  } catch (error) {
    throw new CliError(`Failed to load raw .fig JSON: ${messageFrom(error)}`);
  }
}

function parseFigmaArchive(fileBytes: Uint8Array, debug: DebugLogger): ParsedFigmaArchive {
  const { archiveBytes, zipFiles } = unwrapZipContainer(fileBytes, debug);
  debug(
    `container=${zipFiles ? "zip" : "kiwi"} archive bytes=${archiveBytes.length}${
      zipFiles ? ` zip entries=${Object.keys(zipFiles).length}` : ""
    }`,
  );
  const { header, files } = parseKiwiArchive(archiveBytes);
  debug(`kiwi prelude=${header.prelude} version=${header.version} files=${files.length}`);
  const [schemaFile, dataFile] = files;

  if (!schemaFile || !dataFile) {
    throw new Error("Figma archive did not contain schema and data files");
  }

  debug(`schema compressed bytes=${schemaFile.length} data compressed bytes=${dataFile.length}`);
  const schemaBytes = inflateSync(schemaFile);
  debug(`schema inflated bytes=${schemaBytes.length}`);
  const fileSchema = decodeBinarySchema(schemaBytes);
  const compiledSchema = compileSchema(fileSchema) as {
    decodeMessage(data: Uint8Array): RawObject;
  };
  const dataBytes = hasSignature(dataFile, ZSTD_SIGNATURE)
    ? decompress(dataFile)
    : inflateSync(dataFile);
  debug(`data inflated bytes=${dataBytes.length}`);
  const message = compiledSchema.decodeMessage(dataBytes);
  debug(`decoded document=${summarizeValue(message)}`);

  return {
    meta: {
      fileType: fileTypeFromPrelude(header.prelude),
      version: header.version,
      parsedAt: new Date().toISOString(),
      isZipContainer: zipFiles !== undefined,
      embeddedImages: embeddedImagesFromZip(zipFiles),
      file: metadataFromZip(zipFiles) ?? message.metadata ?? null,
    },
    document: message,
  };
}

function unwrapZipContainer(
  fileBytes: Uint8Array,
  debug: DebugLogger,
): {
  archiveBytes: Uint8Array;
  zipFiles?: Record<string, Uint8Array>;
} {
  if (!hasSignature(fileBytes, ZIP_SIGNATURE)) {
    return { archiveBytes: fileBytes };
  }

  const zipFiles = unzipSync(fileBytes);
  debug(
    `zip entries: ${Object.entries(zipFiles)
      .slice(0, 20)
      .map(([name, bytes]) => `${name}=${bytes.length}`)
      .join(", ")}${Object.keys(zipFiles).length > 20 ? ", ..." : ""}`,
  );
  const mainFileName =
    Object.keys(zipFiles).find((key) => isKiwiArchive(zipFiles[key])) ??
    Object.keys(zipFiles).find((key) => key.endsWith(".fig") || key.endsWith(".deck"));

  if (!mainFileName) {
    throw new Error(
      `ZIP archive found but no valid Figma file inside. Files: ${Object.keys(zipFiles).join(", ")}`,
    );
  }

  return {
    archiveBytes: zipFiles[mainFileName],
    zipFiles,
  };
}

function parseKiwiArchive(archiveBytes: Uint8Array): {
  header: { prelude: string; version: number };
  files: Uint8Array[];
} {
  let offset = 0;

  const preludeBytes = readArchiveBytes(archiveBytes, offset, FIG_KIWI_PRELUDE.length);
  offset += FIG_KIWI_PRELUDE.length;
  const prelude = String.fromCharCode(...preludeBytes);

  if (!isKiwiArchivePrelude(prelude)) {
    throw new Error(`Unexpected Figma archive prelude: "${prelude}"`);
  }

  const version = readUint32LE(archiveBytes, offset);
  offset += 4;

  const files: Uint8Array[] = [];
  while (offset + 4 < archiveBytes.length) {
    const size = readUint32LE(archiveBytes, offset);
    offset += 4;
    files.push(readArchiveBytes(archiveBytes, offset, size));
    offset += size;
  }

  return {
    header: { prelude, version },
    files,
  };
}

function readArchiveBytes(bytes: Uint8Array, offset: number, length: number): Uint8Array {
  if (offset + length > bytes.length) {
    throw new Error(`Archive read past end of data at offset ${offset}`);
  }
  return bytes.slice(offset, offset + length);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) {
    throw new Error(`Archive uint32 read past end of data at offset ${offset}`);
  }
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function hasSignature(bytes: Uint8Array, signature: number[]): boolean {
  return bytes.length > signature.length && signature.every((byte, index) => bytes[index] === byte);
}

function isKiwiArchive(bytes: Uint8Array | undefined): boolean {
  if (!bytes || bytes.length <= FIG_KIWI_PRELUDE.length) {
    return false;
  }

  const prelude = String.fromCharCode(...bytes.slice(0, FIG_KIWI_PRELUDE.length));
  return isKiwiArchivePrelude(prelude);
}

function isKiwiArchivePrelude(prelude: string): boolean {
  return (
    prelude === FIG_KIWI_PRELUDE ||
    prelude === FIGJAM_KIWI_PRELUDE ||
    prelude === FIGDECK_KIWI_PRELUDE
  );
}

function fileTypeFromPrelude(prelude: string): FigmaFileType {
  if (prelude === FIGJAM_KIWI_PRELUDE) {
    return "FIGJAM";
  }
  if (prelude === FIGDECK_KIWI_PRELUDE) {
    return "SLIDES";
  }
  return "DESIGN";
}

function embeddedImagesFromZip(zipFiles: Record<string, Uint8Array> | undefined): string[] {
  if (!zipFiles) {
    return [];
  }

  return Object.keys(zipFiles)
    .filter((key) => isImagePath(key))
    .sort();
}

function metadataFromZip(zipFiles: Record<string, Uint8Array> | undefined): unknown {
  const metadataBytes = zipFiles?.["meta.json"];
  if (!metadataBytes) {
    return undefined;
  }

  try {
    return JSON.parse(new TextDecoder().decode(metadataBytes)) as unknown;
  } catch {
    return undefined;
  }
}

function isImagePath(filePath: string): boolean {
  return /\.(png|jpe?g|webp|gif|svg)$/i.test(filePath);
}

function selectRawScope(
  rawDocument: RawObject,
  options: CliOptions,
): { value: unknown; scope: TokenSummary["scope"] } {
  if (options.node) {
    const node = findRawNodeSubtree(rawDocument, options.node);
    if (!node) {
      throw new CliError(`Raw node with id "${options.node}" was not found.`);
    }

    if (options.path) {
      return {
        value: selectByDotPath(node, options.path),
        scope: { type: "path", nodeId: options.node, path: options.path },
      };
    }

    return {
      value: node,
      scope: { type: "node", nodeId: options.node },
    };
  }

  if (options.path) {
    return {
      value: selectByDotPath(rawDocument, options.path),
      scope: { type: "path", path: options.path },
    };
  }

  return {
    value: rawDocument,
    scope: { type: "document" },
  };
}

function findRawNodeSubtree(value: unknown, nodeId: string): unknown {
  const nodeChanges = getNodeChanges(value);
  if (!nodeChanges) {
    return undefined;
  }

  const nodeByGuid = new Map<string, RawObject>();
  const childrenByParentGuid = new Map<string, RawObject[]>();

  for (const node of nodeChanges) {
    const guid = guidToString(node.guid);
    if (!guid) {
      continue;
    }
    nodeByGuid.set(guid, node);

    const parentGuid = guidToString(asRawObject(node.parentIndex)?.guid);
    if (parentGuid) {
      const children = childrenByParentGuid.get(parentGuid) ?? [];
      children.push(node);
      childrenByParentGuid.set(parentGuid, children);
    }
  }

  const root = nodeByGuid.get(nodeId);
  if (!root) {
    return undefined;
  }

  function buildSubtree(node: RawObject): RawObject {
    const guid = guidToString(node.guid);
    const children = guid ? childrenByParentGuid.get(guid) ?? [] : [];
    const cloned = cloneJson(node);
    if (children.length > 0) {
      cloned.children = children
        .sort(compareParentPosition)
        .map((child) => buildSubtree(child));
    }
    return cloned;
  }

  return buildSubtree(root);
}

function getNodeChanges(value: unknown): RawObject[] | undefined {
  const document = asRawObject(asRawObject(value)?.document);
  const nodeChanges = document?.nodeChanges;
  if (!Array.isArray(nodeChanges)) {
    return undefined;
  }
  return nodeChanges.filter((node): node is RawObject => Boolean(node) && typeof node === "object");
}

function guidToString(guid: unknown): string | undefined {
  const object = asRawObject(guid);
  if (!object) {
    return undefined;
  }

  const sessionID = object.sessionID;
  const localID = object.localID;
  if (typeof sessionID !== "number" || typeof localID !== "number") {
    return undefined;
  }

  return `${sessionID}:${localID}`;
}

function compareParentPosition(left: RawObject, right: RawObject): number {
  const leftPosition = String(asRawObject(left.parentIndex)?.position ?? "");
  const rightPosition = String(asRawObject(right.parentIndex)?.position ?? "");
  return leftPosition.localeCompare(rightPosition);
}

function asRawObject(value: unknown): RawObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RawObject)
    : undefined;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function cloneJson(value: unknown): RawObject {
  return JSON.parse(JSON.stringify(value, jsonReplacer)) as RawObject;
}

function selectByDotPath(value: unknown, dotPath: string): unknown {
  const parts = dotPath.split(".").filter(Boolean);
  let current = value;

  for (const part of parts) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new CliError(`Path segment "${part}" is not a valid array index in "${dotPath}".`);
      }
      current = current[index];
      continue;
    }

    if (!current || typeof current !== "object" || !(part in current)) {
      throw new CliError(`Path "${dotPath}" was not found.`);
    }

    current = (current as RawObject)[part];
  }

  return current;
}

function extractTokens(value: unknown, scope: TokenSummary["scope"]): TokenSummary {
  const colors = new Map<string, TokenRecord>();
  const typography = new Map<string, TokenRecord>();
  const effects = new Map<string, TokenRecord>();
  const styles = new Map<string, TokenRecord>();
  const seen = new Set<unknown>();

  function visit(current: unknown, currentPath: string): void {
    if (!current || typeof current !== "object") {
      return;
    }

    if (seen.has(current)) {
      return;
    }
    seen.add(current);

    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${currentPath}.${index}`));
      return;
    }

    const object = current as RawObject;
    collectColorToken(object, currentPath, colors);
    collectTypographyToken(object, currentPath, typography);
    collectEffectToken(object, currentPath, effects);
    collectStyleToken(object, currentPath, styles);

    for (const [key, child] of Object.entries(object)) {
      visit(child, currentPath ? `${currentPath}.${key}` : key);
    }
  }

  visit(value, "$");

  return {
    source: "fig",
    scope,
    tokens: {
      colors: Array.from(colors.values()),
      typography: Array.from(typography.values()),
      effects: Array.from(effects.values()),
      styles: Array.from(styles.values()),
    },
  };
}

function collectColorToken(
  object: RawObject,
  currentPath: string,
  colors: Map<string, TokenRecord>,
): void {
  for (const [key, value] of Object.entries(object)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey.includes("color") ||
      normalizedKey.includes("fill") ||
      normalizedKey.includes("stroke") ||
      normalizedKey.includes("paint")
    ) {
      addIfColorLike(colors, `${currentPath}.${key}`, value);
    }
  }
}

function addIfColorLike(tokens: Map<string, TokenRecord>, tokenPath: string, value: unknown): void {
  if (!isColorLike(value)) {
    return;
  }
  addToken(tokens, tokenPath, value);
}

function isColorLike(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length >= 3 && value.length <= 4 && value.every(isColorChannel);
  }

  if (!value || typeof value !== "object") {
    return false;
  }

  const object = value as RawObject;
  const keys = Object.keys(object).map((key) => key.toLowerCase());
  const hasRgb = ["r", "g", "b"].every((key) => keys.includes(key));
  const hasColor = "color" in object && isColorLike(object.color);
  const hasPaintColor = typeof object.type === "string" && hasRgb;

  return hasRgb || hasColor || hasPaintColor;
}

function isColorChannel(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 255;
}

function collectTypographyToken(
  object: RawObject,
  currentPath: string,
  typography: Map<string, TokenRecord>,
): void {
  const typographyKeys = [
    "fontFamily",
    "fontPostScriptName",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "letterSpacing",
    "lineHeight",
    "textAlignHorizontal",
    "textAlignVertical",
    "textAutoResize",
  ];

  const token: RawObject = {};
  for (const key of typographyKeys) {
    if (key in object) {
      token[key] = object[key];
    }
  }

  if (Object.keys(token).length > 0) {
    addToken(typography, currentPath, token);
  }
}

function collectEffectToken(
  object: RawObject,
  currentPath: string,
  effects: Map<string, TokenRecord>,
): void {
  for (const [key, value] of Object.entries(object)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey.includes("effect") ||
      normalizedKey.includes("shadow") ||
      normalizedKey.includes("blur")
    ) {
      addToken(effects, `${currentPath}.${key}`, value);
    }
  }
}

function collectStyleToken(
  object: RawObject,
  currentPath: string,
  styles: Map<string, TokenRecord>,
): void {
  const style: RawObject = {};

  for (const [key, value] of Object.entries(object)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey === "style" ||
      normalizedKey.includes("styleid") ||
      normalizedKey.includes("stylekey") ||
      normalizedKey.includes("styletype") ||
      normalizedKey.includes("styledescription")
    ) {
      style[key] = value;
    }
  }

  if (Object.keys(style).length > 0) {
    addToken(styles, currentPath, style);
  }
}

function addToken(tokens: Map<string, TokenRecord>, tokenPath: string, value: unknown): void {
  const key = stableKey(value);
  if (!tokens.has(key)) {
    tokens.set(key, { path: tokenPath, value });
  }
}

function stableKey(value: unknown): string {
  try {
    return stableStringify(value);
  } catch {
    return String(value);
  }
}

function stableStringify(value: unknown): string {
  if (!value || typeof value !== "object") {
    return JSON.stringify(value, jsonReplacer);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const object = value as RawObject;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

function formatJsonValue(value: unknown, minify: boolean, context = "value"): string {
  try {
    const output = JSON.stringify(value, jsonReplacer, minify ? 0 : 2);
    if (output === undefined) {
      throw new Error("value cannot be represented as JSON");
    }
    return output;
  } catch (error) {
    throw new CliError(
      `Failed to serialize JSON for ${context}: ${messageFrom(error)}\n${summarizeValue(value)}`,
    );
  }
}

async function runBigIntJsonSelfTest(): Promise<void> {
  const value = {
    maxInt64: 9223372036854775807n,
    nested: {
      minInt64: -9223372036854775808n,
    },
  };

  const prettyJson = formatJsonValue(value, false);
  const minifiedJson = formatJsonValue(value, true);
  const cloned = cloneJson(value);
  const stableKey = stableStringify(value);
  const streamedJson = await collectStreamedJson(value, true);

  if (!prettyJson.includes('"maxInt64": "9223372036854775807"')) {
    throw new CliError("BigInt JSON self-test failed: pretty output did not stringify BigInt.");
  }

  if (minifiedJson !== '{"maxInt64":"9223372036854775807","nested":{"minInt64":"-9223372036854775808"}}') {
    throw new CliError("BigInt JSON self-test failed: minified output did not match.");
  }

  if (cloned.maxInt64 !== "9223372036854775807") {
    throw new CliError("BigInt JSON self-test failed: cloned output did not stringify BigInt.");
  }

  if (!stableKey.includes('"maxInt64":"9223372036854775807"')) {
    throw new CliError("BigInt JSON self-test failed: stable key did not stringify BigInt.");
  }

  if (streamedJson !== minifiedJson) {
    throw new CliError("BigInt JSON self-test failed: streamed output did not match.");
  }

  process.stdout.write("BigInt JSON self-test passed.\n");
}

async function writeJsonOutput(
  outPath: string,
  value: unknown,
  minify: boolean,
  context: string,
  debug: DebugLogger,
): Promise<void> {
  try {
    const outDir = path.dirname(outPath);
    if (outDir && outDir !== ".") {
      await mkdir(outDir, { recursive: true });
    }

    debug(`streaming output path=${outPath}`);
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(outPath, { encoding: "utf8" });
      stream.on("finish", resolve);
      stream.on("error", (error: Error) => {
        reject(new CliError(`Failed to write output file "${outPath}": ${messageFrom(error)}`));
      });

      writeJsonToWritable(stream, value, minify, context)
        .then(() => {
          stream.write("\n");
          stream.end();
        })
        .catch((error: unknown) => {
          stream.destroy();
          reject(error);
        });
    });
    debug(`streamed output path=${outPath}`);
  } catch (error) {
    throw new CliError(`Failed to write output file "${outPath}": ${messageFrom(error)}`);
  }
}

async function writeJsonToWritable(
  stream: { write(chunk: string): void },
  value: unknown,
  minify: boolean,
  context = "value",
): Promise<void> {
  const indent = minify ? "" : "  ";
  const chunkSize = 65_536;
  let buffer = "";
  const seen = new Set<object>();

  function flush(): void {
    if (buffer) {
      stream.write(buffer);
      buffer = "";
    }
  }

  function write(chunk: string): void {
    buffer += chunk;
    if (buffer.length >= chunkSize) {
      flush();
    }
  }

  function serialize(current: unknown, depth: number, inArray: boolean): void {
    if (typeof current === "bigint") {
      writeString(current.toString());
      return;
    }

    if (current === null) {
      write("null");
      return;
    }

    switch (typeof current) {
      case "string":
        writeString(current);
        return;
      case "number":
        write(Number.isFinite(current) ? String(current) : "null");
        return;
      case "boolean":
        write(current ? "true" : "false");
        return;
      case "undefined":
      case "function":
      case "symbol":
        if (inArray) {
          write("null");
          return;
        }
        throw new Error("value cannot be represented as JSON");
      case "object":
        break;
      default:
        throw new Error(`unsupported JSON value type: ${typeof current}`);
    }

    const object = current as object;
    if (seen.has(object)) {
      throw new Error("Converting circular structure to JSON");
    }
    seen.add(object);

    try {
      if (Array.isArray(current)) {
        serializeArray(current, depth);
        return;
      }

      serializeObject(current as RawObject, depth);
    } finally {
      seen.delete(object);
    }
  }

  function serializeArray(values: unknown[], depth: number): void {
    if (values.length === 0) {
      write("[]");
      return;
    }

    const childIndent = indent ? `\n${indent.repeat(depth + 1)}` : "";
    const closingIndent = indent ? `\n${indent.repeat(depth)}` : "";
    write("[");

    for (let index = 0; index < values.length; index += 1) {
      if (index > 0) {
        write(",");
      }
      if (indent) {
        write(childIndent);
      }
      serialize(values[index], depth + 1, true);
    }

    if (indent) {
      write(closingIndent);
    }
    write("]");
  }

  function serializeObject(object: RawObject, depth: number): void {
    const keys = Object.keys(object).filter((key) => isJsonObjectProperty(object[key]));
    if (keys.length === 0) {
      write("{}");
      return;
    }

    const childIndent = indent ? `\n${indent.repeat(depth + 1)}` : "";
    const closingIndent = indent ? `\n${indent.repeat(depth)}` : "";
    write("{");

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (index > 0) {
        write(",");
      }
      if (indent) {
        write(childIndent);
      }
      writeString(key);
      write(indent ? ": " : ":");
      serialize(object[key], depth + 1, false);
    }

    if (indent) {
      write(closingIndent);
    }
    write("}");
  }

  function writeString(value: string): void {
    const output = JSON.stringify(value);
    if (output === undefined) {
      throw new Error("value cannot be represented as JSON");
    }
    write(output);
  }

  try {
    serialize(value, 0, false);
    flush();
  } catch (error) {
    logJsonDiagnostics(value);
    throw new CliError(
      `Failed to stream JSON for ${context}: ${messageFrom(error)}\n${summarizeValue(value)}`,
    );
  }
}

function isJsonObjectProperty(value: unknown): boolean {
  return value !== undefined && typeof value !== "function" && typeof value !== "symbol";
}

function estimateSize(value: unknown, depth = 0): number {
  if (value === null || value === undefined) {
    return 4;
  }
  if (typeof value === "boolean") {
    return 5;
  }
  if (typeof value === "number") {
    return 16;
  }
  if (typeof value === "bigint") {
    return value.toString().length + 2;
  }
  if (typeof value === "string") {
    return value.length + 2;
  }
  if (depth >= 4) {
    return 8;
  }
  if (Array.isArray(value)) {
    return 2 + value.reduce((sum, item) => sum + estimateSize(item, depth + 1) + 1, 0);
  }
  if (typeof value === "object") {
    const object = value as RawObject;
    return (
      2 +
      Object.entries(object).reduce(
        (sum, [key, child]) => sum + key.length + 4 + estimateSize(child, depth + 1) + 1,
        0,
      )
    );
  }
  return 8;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) {
    return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  }
  if (bytes >= 1_048_576) {
    return `${(bytes / 1_048_576).toFixed(1)} MB`;
  }
  if (bytes >= 1_024) {
    return `${(bytes / 1_024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function logJsonDiagnostics(value: unknown): void {
  process.stderr.write("[debug] JSON serialization diagnostics:\n");

  if (value === null || value === undefined || typeof value !== "object") {
    process.stderr.write(`  type: ${typeof value}, value: ${String(value)}\n`);
    return;
  }

  if (Array.isArray(value)) {
    const estimatedSize = estimateSize(value);
    process.stderr.write(
      `  type: array, length: ${value.length}, estimated size: ~${formatBytes(estimatedSize)}\n`,
    );
    return;
  }

  const object = value as RawObject;
  const keys = Object.keys(object);
  const totalEstimatedSize = estimateSize(object);
  process.stderr.write(
    `  type: object, top-level keys: ${keys.length}, estimated size: ~${formatBytes(totalEstimatedSize)}\n`,
  );

  for (const key of keys) {
    const child = object[key];
    const estimatedSize = estimateSize(child);
    const typeSuffix = Array.isArray(child)
      ? `array(${child.length})`
      : child === null
        ? "null"
        : typeof child;
    process.stderr.write(`  key "${key}": ${typeSuffix}, ~${formatBytes(estimatedSize)}\n`);
  }
}

async function collectStreamedJson(value: unknown, minify: boolean): Promise<string> {
  let output = "";
  await writeJsonToWritable(
    {
      write(chunk: string): void {
        output += chunk;
      },
    },
    value,
    minify,
    "self-test output",
  );
  return output;
}

function createDebugLogger(enabled: boolean): DebugLogger {
  return enabled
    ? (message: string): void => {
        process.stderr.write(`[fig-to-json debug] ${message}\n`);
      }
    : (): void => {};
}

function outputModeLabel(options: CliOptions): string {
  if (options.meta) {
    return "metadata";
  }
  if (options.tokens) {
    return "token";
  }
  if (options.node) {
    return options.path ? "node path" : "node";
  }
  if (options.path) {
    return "path";
  }
  return "document";
}

function scopeLabel(scope: TokenSummary["scope"]): string {
  const parts: string[] = [scope.type];
  if (scope.nodeId) {
    parts.push(`node=${scope.nodeId}`);
  }
  if (scope.path) {
    parts.push(`path=${scope.path}`);
  }
  return parts.join(" ");
}

function summarizeValue(value: unknown): string {
  const stats = collectValueStats(value);
  return [
    `summary type=${stats.rootType}`,
    `arrays=${stats.arrays}`,
    `objects=${stats.objects}`,
    `properties=${stats.properties}`,
    `strings=${stats.strings}`,
    `maxStringLength=${stats.maxStringLength}`,
    `bigints=${stats.bigints}`,
    `numbers=${stats.numbers}`,
    `booleans=${stats.booleans}`,
    `nulls=${stats.nulls}`,
    `undefined=${stats.undefinedValues}`,
    `maxDepth=${stats.maxDepth}`,
    `truncated=${stats.truncated}`,
    stats.topKeys.length > 0 ? `topKeys=${stats.topKeys.join(",")}` : undefined,
    stats.rootArrayLength !== undefined ? `rootArrayLength=${stats.rootArrayLength}` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

type ValueStats = {
  rootType: string;
  rootArrayLength?: number;
  arrays: number;
  objects: number;
  properties: number;
  strings: number;
  maxStringLength: number;
  bigints: number;
  numbers: number;
  booleans: number;
  nulls: number;
  undefinedValues: number;
  maxDepth: number;
  truncated: boolean;
  topKeys: string[];
};

function collectValueStats(value: unknown): ValueStats {
  const maxVisits = 25_000;
  const seen = new Set<object>();
  const stats: ValueStats = {
    rootType: valueTypeLabel(value),
    rootArrayLength: Array.isArray(value) ? value.length : undefined,
    arrays: 0,
    objects: 0,
    properties: 0,
    strings: 0,
    maxStringLength: 0,
    bigints: 0,
    numbers: 0,
    booleans: 0,
    nulls: 0,
    undefinedValues: 0,
    maxDepth: 0,
    truncated: false,
    topKeys: [],
  };
  const topKeyCounts = new Map<string, number>();
  let visits = 0;

  function visit(current: unknown, depth: number): void {
    if (visits >= maxVisits) {
      stats.truncated = true;
      return;
    }
    visits += 1;
    stats.maxDepth = Math.max(stats.maxDepth, depth);

    if (current === null) {
      stats.nulls += 1;
      return;
    }

    switch (typeof current) {
      case "string":
        stats.strings += 1;
        stats.maxStringLength = Math.max(stats.maxStringLength, current.length);
        return;
      case "bigint":
        stats.bigints += 1;
        return;
      case "number":
        stats.numbers += 1;
        return;
      case "boolean":
        stats.booleans += 1;
        return;
      case "undefined":
        stats.undefinedValues += 1;
        return;
      case "object":
        break;
      default:
        return;
    }

    const object = current as object;
    if (seen.has(object)) {
      return;
    }
    seen.add(object);

    if (Array.isArray(current)) {
      stats.arrays += 1;
      for (const item of current) {
        visit(item, depth + 1);
        if (stats.truncated) {
          return;
        }
      }
      return;
    }

    stats.objects += 1;
    for (const [key, child] of Object.entries(current as RawObject)) {
      stats.properties += 1;
      topKeyCounts.set(key, (topKeyCounts.get(key) ?? 0) + 1);
      visit(child, depth + 1);
      if (stats.truncated) {
        return;
      }
    }
  }

  visit(value, 0);
  stats.topKeys = Array.from(topKeyCounts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([key, count]) => `${key}:${count}`);
  return stats;
}

function valueTypeLabel(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = messageFrom(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
