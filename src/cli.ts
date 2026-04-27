#!/usr/bin/env node

import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { FigmaDocument } from "@grida/refig";

type RefigResolvedScene = {
  sceneJson: string;
  images?: Record<string, Uint8Array>;
  imageRefsUsed?: string[];
};

type RefigRawRuntimeDocument = {
  _resolve(rootNodeId?: string): RefigResolvedScene;
  _figFile?: RawObject;
};

type FigmaDocumentConstructorWithFile = typeof FigmaDocument & {
  fromFile(filePath: string): FigmaDocument;
};

type RawObject = Record<string, unknown>;

type CliOptions = {
  input?: string;
  out?: string;
  node?: string;
  path?: string;
  tokens: boolean;
  minify: boolean;
  help: boolean;
};

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
  fig-to-json <input.fig> [--out <path>] [--node <id>] [--path <path>] [--tokens] [--minify]

Options:
  --out <path>   Write JSON to this file instead of stdout.
  --node <id>    Write the raw node subtree for this Figma node ID.
  --path <path>  Write a raw value by dot path, e.g. pages.0.rootNodes.0.
  --tokens       Extract a token summary from the selected raw scope.
  --minify       Write compact JSON. Defaults to pretty JSON.
  -h, --help     Show this help message.

Examples:
  npm run convert -- ./design.fig --out ./raw.json
  npm run convert -- ./design.fig --node "1:23" --out ./node.json
  npm run convert -- ./design.fig --path pages.0.rootNodes.0
  npm run convert -- ./design.fig --tokens --out ./tokens.json
  npm run convert -- ./design.fig --node "1:23" --tokens --out ./node-tokens.json
`;

async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);

  if (options.help) {
    process.stdout.write(helpText);
    return;
  }

  if (!options.input) {
    throw new CliError("Missing required input .fig path.\n\n" + helpText);
  }

  if (options.node && options.path) {
    throw new CliError("--node cannot be combined with --path.");
  }

  assertFigExtension(options.input);
  await assertReadableFile(options.input);

  const rawDocument = loadRawFigDocument(options.input);
  const selected = selectRawScope(rawDocument, options);
  const value = options.tokens
    ? extractTokens(selected.value, selected.scope)
    : selected.value;
  const output = formatJsonValue(value, options.minify);

  if (options.out) {
    await writeOutput(options.out, output);
    return;
  }

  process.stdout.write(output);
  process.stdout.write("\n");
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    tokens: false,
    minify: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }

    if (arg === "--minify") {
      options.minify = true;
      continue;
    }

    if (arg === "--tokens") {
      options.tokens = true;
      continue;
    }

    if (arg === "--raw") {
      continue;
    }

    if (arg === "--out" || arg === "--node" || arg === "--path") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CliError(`Missing value for ${arg}.`);
      }

      if (arg === "--out") {
        options.out = value;
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

function loadRawFigDocument(filePath: string): RawObject {
  try {
    const loader = FigmaDocument as FigmaDocumentConstructorWithFile;
    const document = loader.fromFile(filePath) as unknown as RefigRawRuntimeDocument;

    if (!document._figFile) {
      document._resolve();
    }

    if (!document._figFile) {
      throw new Error("parsed .fig document was not available");
    }

    return document._figFile;
  } catch (error) {
    throw new CliError(`Failed to load raw .fig JSON: ${messageFrom(error)}`);
  }
}

function selectRawScope(
  rawDocument: RawObject,
  options: CliOptions,
): { value: unknown; scope: TokenSummary["scope"] } {
  if (options.node) {
    const node = findRawNode(rawDocument, options.node);
    if (!node) {
      throw new CliError(`Raw node with id "${options.node}" was not found.`);
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

function findRawNode(value: unknown, nodeId: string): unknown {
  const seen = new Set<unknown>();

  function visit(current: unknown): unknown {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    if (seen.has(current)) {
      return undefined;
    }
    seen.add(current);

    if (hasMatchingNodeId(current, nodeId)) {
      return current;
    }

    if (Array.isArray(current)) {
      for (const item of current) {
        const found = visit(item);
        if (found !== undefined) {
          return found;
        }
      }
      return undefined;
    }

    for (const child of Object.values(current)) {
      const found = visit(child);
      if (found !== undefined) {
        return found;
      }
    }

    return undefined;
  }

  return visit(value);
}

function hasMatchingNodeId(value: object, nodeId: string): boolean {
  if (!("id" in value)) {
    return false;
  }

  const id = (value as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number"
    ? String(id) === nodeId
    : false;
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
    return JSON.stringify(value);
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

function formatJsonValue(value: unknown, minify: boolean): string {
  try {
    const output = JSON.stringify(value, null, minify ? 0 : 2);
    if (output === undefined) {
      throw new Error("value cannot be represented as JSON");
    }
    return output;
  } catch (error) {
    throw new CliError(`Failed to serialize JSON: ${messageFrom(error)}`);
  }
}

async function writeOutput(outPath: string, output: string): Promise<void> {
  try {
    const outDir = path.dirname(outPath);
    if (outDir && outDir !== ".") {
      await mkdir(outDir, { recursive: true });
    }

    await writeFile(outPath, output + "\n", "utf8");
  } catch (error) {
    throw new CliError(`Failed to write output file "${outPath}": ${messageFrom(error)}`);
  }
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
