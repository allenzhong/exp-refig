# Offline Figma Raw JSON

Small Node CLI for converting a local `.fig` export to raw parsed JSON using
`kiwi-schema`, without calling the Figma API.

## Install

```sh
npm install
```

## Usage

```sh
npm run convert -- ./design.fig --out ./document.json --meta-out ./meta.json
npm run convert -- ./design.fig --meta --out ./meta.json
npm run convert -- ./design.fig --node "1:23" --out ./node.json
npm run convert -- ./design.fig --path nodeChanges.0
npm run convert -- ./design.fig --node "1:23" --path children.0
npm run convert -- ./design.fig --tokens --out ./tokens.json
npm run convert -- ./design.fig --node "1:23" --tokens --out ./node-tokens.json
```

Options:

- `--out <path>` writes document JSON to a file. Without it, JSON is written to
  stdout.
- `--meta` writes metadata JSON instead of document JSON.
- `--meta-out <path>` writes metadata JSON to a separate file in the same run as
  the document output.
- `--node <id>` writes the raw node subtree for a Figma node ID, including its
  children.
- `--path <path>` writes a raw value by dot path, for example
  `nodeChanges.0`. When combined with `--node`, the path is resolved from the
  extracted node subtree.
- `--tokens` extracts a best-effort token summary from the selected raw scope.
- `--minify` writes compact JSON. The default is pretty-printed JSON.
- `--help` prints CLI help.

The legacy `--raw` flag is accepted as a no-op because raw JSON is now the only
output mode.

## Token Extraction

Token extraction is intentionally conservative and works from whatever fields
exist in the parsed `.fig` data. It currently groups likely values into:

- `colors`
- `typography`
- `effects`
- `styles`

You can scope token extraction to a node:

```sh
npm run convert -- ./design.fig --node "1:23" --tokens
```

Or to any raw path:

```sh
npm run convert -- ./design.fig --path nodeChanges.0 --tokens
npm run convert -- ./design.fig --node "1:23" --path children.0 --tokens
```

## Notes

This CLI directly decodes the `.fig` Kiwi archive and outputs the low-level
`NODE_CHANGES` document shape by default. Metadata is intentionally separate and
can be written with `--meta` or `--meta-out`. It does not output Grida scene JSON.

The tool is offline-only: it reads `.fig` files from disk, does not accept Figma
tokens, and does not fetch REST API file data or images.

## Development

```sh
npm run typecheck
npm run build
npm run convert -- --help
```
