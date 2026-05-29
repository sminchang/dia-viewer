# Diagram Manifest — spec

The **manifest** is the single contract between the diagram-generating skills and dia-viewer:

```
[skill]  source code  ──►  manifest.json   (create-erd / create-diagram)
                              │
[dia-viewer]  manifest.json  ──►  render · drag · export PNG/SVG
```

One manifest = **one diagram (one view)**. Skills generate it from source code; dia-viewer (a pure web app, optionally Tauri-wrapped) consumes it. The renderer never touches DB credentials and has no save-to-server — it only loads a manifest and exports an image.

## Files

| File | Role |
|------|------|
| `src/manifest.ts` | Canonical TypeScript types (the app imports these) |
| `manifest.schema.json` | JSON Schema (draft 2020-12) — skills target it, renderer validates on load |
| `public/examples/erd.coral_ai.json` | ERD example — exercises composite PK, composite UK, 1:1, 0..1:N, soft-ref notes, domains |
| `public/examples/architecture.coral_ai.json` | C4 container view — boundary group, external nodes, labelled edges |

## Design principles

1. **One schema, two kinds.** `kind: "erd" | "architecture"`. A `nodeType` discriminator and a type-specific `data` object cover both. The renderer picks a node component per `nodeType`; layout (d3-force = central, ELK = hierarchical) is generic to node+edge graphs, so both kinds get the same layout toggle for free.

2. **Structure here, layout elsewhere.** The manifest carries **no positions**. Node positions live in a separate `layout.json` sidecar keyed by `node.id`. Re-running a skill overwrites the manifest (structure) but the renderer re-applies saved positions for surviving ids — so the user's manual layout survives regeneration. Keep `node.id` deterministic (use the table/element name).

3. **Skills extract, humans arrange.** The LLM does relationship extraction (what it's good at); the renderer does layout/presentation (what needs a human eye). Neither owns the other's concern.

## Field reference

See `manifest.ts` for the authoritative, commented types. Highlights:

**Envelope** — `version` (`"1.0"`), `kind`, `title?`, `meta?`, `nodes[]`, `edges[]`, `groups?[]`.

**ERD specifics**
- Column markers: `pk` (multiple = composite PK), `fk`, `unique` (single-col UK), `uniqueGroup` (composite UK — columns sharing a value form one constraint, rendered as `UK*`), `nullable` (default true; set false for NOT NULL), `default`, `note`.
- Edge `data`: `sourceColumn` / `targetColumn` (column-level attachment), `cardinality` (`1:N` `0..1:N` `1:1` `0..1:0..1` `N:M`), `onDelete`.
- **Soft references** (FK-looking columns with no DB constraint, e.g. cross-DB ids) are NOT edges — record them as `column.note` only.

**Architecture specifics**
- `nodeType`: `person` | `softwareSystem` | `container` | `component`.
- `data`: `technology`, `description`, `external` (outside the system boundary).
- The system-of-interest is a `group` with `kind: "boundary"`; containers reference it via `node.group`. Boundaries may nest via `group.parent`.
- Edge `label` = relationship verb; edge `data.technology` = protocol.

## Validating a manifest

```bash
npx ajv-cli validate -s manifest.schema.json -d public/examples/erd.coral_ai.json --spec=draft2020
```

(Both bundled examples are verified to pass.)

## How the two skills target this

- **create-erd**: currently emits dbml — to be reworked to emit this manifest. Cardinality / onDelete / composite constraints map directly from the existing Phase 2 mapping tables.
- **create-diagram**: currently emits Structurizr DSL — to add manifest output (DSL optional secondary). C4 elements map to `nodeType`; boundaries to `groups`.
