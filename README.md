# Offline Figma Raw JSON

Small Node CLI for converting a local `.fig` export to raw parsed JSON using
`@grida/refig`, without calling the Figma API.

## Install

```sh
npm install
```

## Usage

```sh
npm run convert -- ./design.fig --out ./raw.json
npm run convert -- ./design.fig --node "1:23" --out ./node.json
npm run convert -- ./design.fig --path pages.0.rootNodes.0
npm run convert -- ./design.fig --tokens --out ./tokens.json
npm run convert -- ./design.fig --node "1:23" --tokens --out ./node-tokens.json
```

Options:

- `--out <path>` writes JSON to a file. Without it, JSON is written to stdout.
- `--node <id>` writes the raw node subtree for a Figma node ID, including its
  children.
- `--path <path>` writes a raw value by dot path, for example
  `pages.0.rootNodes.0`. It cannot be combined with `--node`.
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
npm run convert -- ./design.fig --path pages.0 --tokens
```

## Notes

This CLI relies on `@grida/refig` to parse the `.fig` file, then serializes the
internal parsed `.fig` document object. It does not output Grida scene JSON.

The tool is offline-only: it reads `.fig` files from disk, does not accept Figma
tokens, and does not fetch REST API file data or images.

## Development

```sh
npm run typecheck
npm run build
npm run convert -- --help
```
