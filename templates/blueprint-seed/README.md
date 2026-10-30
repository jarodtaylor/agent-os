# blueprint/

This is your project's **provisioning blueprint** — the single source of truth for the role files that Agent
OS pushes into each harness's native surfaces. Edit here; never edit a provisioned file directly, because the
next `apply` overwrites it.

## Layout

| Path | What it is |
|---|---|
| `manifest.json` | The map: which role, which harness, which files go where. |
| `shared/` | Content composed into more than one role's output. |
| `roles/<role>/` | One role's files. |
| `runtime/RUN_STATE.seed.md` | The initial `RUN_STATE.md`, written once by `init`. Never provisioned. |

## The loop

```
edit blueprint/  →  plan (see what would change)  →  apply (write it)
```

`status` reports where a live surface has drifted from the blueprint. `undo` reverses the last apply.

## Rules the engine enforces

- **No credentials and no machine-specific absolute paths** in any blueprint file — both fail the gate loudly
  before anything is written.
- Every destination must be a surface Agent OS knows for that harness. One writer per whole-file destination;
  only merge rows may share a config file.
- `RUN_STATE.md` and `FRICTION.md` are runtime files. They are never provisioning targets.

## Tuning

This seed is a starting point, not a standard. The roles get good through use: run the loop, record what got
in the way in `FRICTION.md`, and fold it back in here.
