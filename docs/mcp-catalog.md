# MCP sibling catalogue and next interface review

Current implementation: 2026-09-05. The LiveSync MCP exposes 15 tools for
write-authorized callers and 9 for read-only callers, including bounded
`read_files` (1–10 reads, 1 MiB combined result), tool-selection/subtree
instructions, and permission-aware registration. The storage contract remains 5.
Property queries, pagination, outlines, line reads, JSON text results and
immutable-ID authorization are implemented; do not plan them as new features.

Personal-use checks have exercised batch reads, creation and copy/delete
organisation. They exposed client-side latency and partial completion; the full
acceptance exercise below remains outstanding. Local source does not establish
what is currently deployed or cached by an MCP client.

## Reference checkouts

Paths below are relative to this document; sibling links require those local
checkouts and are not dependencies of this project.

| Project | Current surface | Best use as a reference |
| --- | --- | --- |
| [This LiveSync MCP](../apps/cloudflare-obsidian-mcp/src/vault-tools.ts) | 15 tools for write-authorized callers; 9 for read-only callers. One fixed vault, revision-checked mutations. | Keep the small surface and LiveSync-specific safety contract. |
| [obsidian-web-mcp](../../obsidian-web-mcp/src/obsidian_vault_mcp/server.py), `cd88fdf` | 20 explicitly registered tools, including Canvas, daily notes and analytics. Filesystem-backed. | Concise intent-oriented descriptions, exact-edit previews, batch reads and practical daily capture. |
| [obsidian-mcp](../../obsidian-mcp/src/obsidian_mcp/tool_profiles.py), `a7f4471` | Focused is now the default: 33 eligible base tools, 31 registered with default feature flags. Full permits 48 base tools; optional formats are separately enabled. | Focused workflow instructions, conventions, graph navigation and optional groups; not a target tool count. |

`obsidian-web-mcp` is tighter than the broad sibling, but it is not smaller than
this project's current interface. Its FastMCP constructor supplies no explicit
server instructions; guidance lives mainly in individual tool descriptions.
The broad sibling now supplies focused instructions, so its old full catalogue
alone is no longer a fair description of the default experience.

## Capability mapping

| Intent | LiveSync contract 5 | obsidian-web-mcp | Recommendation here |
| --- | --- | --- | --- |
| Discover paths | `list_files`, `list_attachments` | `vault_list` with depth/globs | Keep existing tools; explain Markdown versus other files and prefix semantics. |
| Find content/properties | `search_files` combines literal AND text, typed AND filters, selected properties and cursor | `vault_search`, `vault_search_frontmatter` | Keep the combined tool; provide separate text, property-only and combined examples. |
| Read context | `read_file`, `read_files`, `get_file_outline`, `read_frontmatter` | `vault_read`, `vault_batch_read` | Use bounded batch reads for selected notes; keep range/outline support for sections. |
| Create/replace | `create_file`, `edit_file` | `vault_write` creates or overwrites | Preserve separate create-only and revision-checked replacement operations. |
| Small changes | `patch_file`, `append_file`, `patch_frontmatter` | `vault_edit` has ordered replacements and dry-run diff; `vault_append`; `vault_batch_frontmatter_update` | Teach selection first. Consider several exact replacements in one CAS commit only after a demonstrated need. |
| Delete/move | `delete_file`; documented non-atomic copy/delete recipe | `vault_delete` moves to trash; `vault_move` | Do not imply equivalent deletion/recovery semantics or port filesystem moves directly. |
| Binary files | `list_attachments`, `read_attachment` (bounded base64) | `vault_write_binary` | Defer writes until placement/link/settings behaviour is decided. |
| Daily capture | Existing generic read/create/append tools | `vault_daily_note_path`, `vault_daily_note_read`, `vault_daily_note_append` | Establish the user's folder, filename format, timezone and template before adding a shortcut. |
| Canvas | No semantic tools | `vault_canvas_read`, `vault_canvas_add_node`, `vault_canvas_add_edge` | Defer unless personal use demonstrates a need. |
| Vault hygiene | Existing listings/search | `vault_analytics_summary`, `vault_analytics_findings` | Defer a dedicated reporting surface. |

Do not transfer write semantics just because names look similar. The web
sibling's public text-write signatures have no expected revision; filesystem
atomic replacement is not a substitute for LiveSync revision CAS. Its append
can create a missing file and inserts a default separator; this project's
append requires an existing revision and appends literal bytes. Likewise,
`vault_edit` means exact patch there, while `edit_file` means full replacement
here. Make that distinction explicit in descriptions before considering renames.

## Next step: measure client latency with the existing surface

Keep the 15-tool surface; no new profile framework, aliases or generic operation
dispatcher are needed. Current server instructions and descriptions cover:

- Obsidian Markdown synced via LiveSync: wikilinks for note references and
  backlinks, aliases, heading/block links, embeds, callouts, valid frontmatter,
  inline/nested/property tags, and meaningful file paths and titles.
- `list_files` for path discovery and inventory; `search_files` for content or
  property conditions, including recursive subtree prefixes.
- `read_file` for a known path; `read_files` for several selected notes; an
  outline and revision-bound range for a section.
- `edit_file` for complete replacement, `patch_file` for a small exact change,
  `append_file` for an addition, and `patch_frontmatter` for metadata.
- Scope, untrusted content, revision recovery, partial-read safety, pagination,
  and non-atomic copy/delete moves without link rewriting or attachment moves.

Per-tool timing and outcome logs now distinguish handler duration from time
outside the handler. Create and append are marked additive writes. Continue
measuring avoidable model round trips and approval delays before adding tools.
A dedicated move tool remains deferred: wrapping copy/verify/delete does not
make it atomic or remove the destructive nature of source deletion.

Vault conventions should be explicitly user-approved context, not arbitrary
note text promoted to privileged instructions. Initially use the user's task
instructions and existing notes as examples. Add configuration or a conventions
tool only if repeating those details becomes a practical problem.

## Personal-use acceptance exercise

Use a disposable note/folder with the actual MCP client after confirming its
tools/list reflects contract 5. The complete exercise has not yet been recorded.

1. Find a note by topic; query notes by a typed property; exhaust a paginated
   query and distinguish no matches from incomplete index coverage.
2. Read one section via an outline, patch an exact sentence, append a finding,
   and change one frontmatter field while preserving unrelated content.
3. Create a note without overwriting an existing path; replace an entire note
   only after a complete read. Check the result in Obsidian.
4. Introduce a stale revision and verify reread/reassessment without duplicate
   appends or silent full-file replacement from a snippet.
5. Ask for daily capture without configured conventions: verify the model does
   not invent the path/timezone. Exercise an attachment read separately.

Record wrong tool choices, avoidable calls, response size, confusing errors and
whether the result matches the request. Revise descriptions/instructions first.
Only add a tool when a recurring workflow cannot be served well by the existing
surface. Batch reads are implemented; multi-replacement patches and daily-note
convenience remain candidates to evaluate, not committed scope.
