# U1/U2 workspace editor

The gateway integration seam is `index.ts`:

- `WorkspaceClient.read(atVersion?)` and `mutate(action, expectedVersion, idempotencyKey)` are synchronous, typed application calls. All mutations return the acknowledged `WorkspaceViewV1`.
- Optional `WorkspaceClient.editText(text: string): string` is a trusted host callback, invoked for the focused field only while Ink has suspended terminal ownership. The host owns editor execution, temporary-file security and cleanup; UI components never execute a shell. Returning text updates the buffer only; throwing (including cancellation) retains the original text and cursor.
- `runWorkspaceEditor(client, initial): Promise<void>` is interactive only. It rejects non-TTY stdin/stdout and `TERM=dumb`, without reading stdin, prompting, or printing a fallback. The gateway must select human/plain/JSON output before calling it.
- `renderWorkspacePlain(view): string` returns a linear, terminal-safe rendering, without reads, prompts or terminal state changes. It does not load React/Ink. The gateway owns writing the returned string and preserving its existing JSON transport.

No application, repository, database, canonical hashing or historical-validation code is imported. The editor uses `view.changes` for readable effects and `view.prerequisites` for each group's prerequisite choices; it does not derive either from operations. The generic form produces an explicit `put-proposal` containing a typed `write-prose` operation. Only `succession-demo` offers the labelled, service-defined `add-regency` template. Neither route selects its new proposal.

Existing-document replacements and document pins require `view.documents[].sha256`, supplied by the service. An older gateway without that metadata fails closed; no hash is derived from displayed (possibly truncated) text. A new document uses `beforeSha256: null`, with existence/path validation left to the service.

## Interaction

80x24 is the baseline; 100+ columns show list and inspector panes. Smaller terminals show a bounded resize state without recreating the controller or buffers. Arrow keys, Tab/Shift+Tab, Enter and Esc provide navigation. Right focuses the wide inspector; Left returns to the list. Page keys operate on the focused list/inspector. Raw JSON is secondary (`d`), and every readable pane has bounded scrolling with a More indicator.

Forms use a grapheme-indexed reducer with cursor movement, Home/End, deletion, multiline editing and paste. Tab changes fields; Enter adds a newline in multiline fields. Ctrl+Enter saves; Ctrl+S is the explicit save fallback for terminals that cannot distinguish Ctrl+Enter. Page keys move through long input buffers. `usePaste` is always active, including outside forms, so even a pasted `q` cannot invoke Quit. Imported text is sanitized only at presentation time, preserving stored source bytes. When the host supplies `editText`, Ctrl+E opens the external-editor route. Without a callback, Ctrl+E retains its original end-of-buffer behavior. External edits require a separate Ctrl+Enter/Ctrl+S to save; fields, proposal structure and version preconditions are otherwise unchanged.

Rationale revisions preserve the proposal's structured operations, title, author, dependencies and exclusions. Pins and restoration require explicit confirmation; restoration requests `undecided`, never `selected`. Rejected prerequisites cannot be silently included by the dependency menu.

## Save failures

No durable result is optimistic. A failure retains the original action, expected version, key and form buffer, and attempts a fresh read without automatically submitting or merging anything.

- Unknown outcome: Enter/y explicitly retries the identical attempt with the original expected version and idempotency key, even if the read observed a newer workspace version.
- Stale outcome: the original outgoing action is scrollable for review. Enter/y explicitly resubmits that original action against the refreshed version with a new key. This is not an automatic merge and may replace newer authoring data.
- If a rationale's structured proposal changed, that stale retry is blocked. The dialog displays the current proposal as well. `b` explicitly loads the current structure into the retained rationale form **without saving**; a separate Ctrl+Enter/Ctrl+S is then required. Esc simply returns to the original retained buffer.
- `r` in the failure dialog refreshes only, allowing recovery when the first post-failure read also failed.

Ink owns raw-mode, cursor, bracketed-paste and alternate-screen lifecycle. External editing uses Ink 8's `suspendTerminal(callback)` API, whose `finally` resumes the terminal even when the callback throws. Buffer updates wait until suspension has resumed; input and reentrant editor requests are ignored during handoff. The interactive-only entrypoint explicitly enables Ink's interactive mode after checking both TTYs, so CI detection cannot silently disable suspension. Quit, Ctrl+C and SIGINT/SIGTERM/SIGHUP unmount the renderer, with cleanup in `finally`. The UI has no animations, forced background or color-dependent meaning; all symbols/statuses are readable with `NO_COLOR`.

## Authority and verification boundary

Validation `NOT RUN`, approval `unavailable`, and canon `unchanged` are rendered from the service contract. Selection diagnostics are never labelled historical validity. There is no validation, approval, commit, generation, inference or persistence implementation in this directory.

Focused tests are in `apps/cli/test/workspace-ui.test.ts` and `apps/cli/test/workspace-presentation.test.ts`:

```sh
pnpm exec vitest run apps/cli/test/workspace-presentation.test.ts apps/cli/test/workspace-ui.test.ts
```

They cover the renderer, width bounds, long content, terminal controls, Unicode editing, paste isolation, explicit dependency/pin/restoration choices, acknowledgement/failure recovery, resize and optional host editing. The resize test supplies both stream dimensions rather than relying on the host terminal's height. Host-editor tests exercise real Ink with simulated interactive TTY streams to check terminal-mode restoration on success and failure, retained buffers/cursors, input isolation and explicit saving. No dependency/package/tsconfig changes were made here.

Remaining integration checks: exercise the real gateway/service and restart durability, wire a concrete host editor callback if desired, and run real OS PTY/signal/terminal and screen-reader checks. Simulated streams and component tests do not replace real terminal and accessibility checks. The optional callback route is implemented; no concrete editor launcher is supplied, and the built-in multiline editor remains fully supported. World inspection is limited to the base documents and record descriptors supplied by the wire view; it invents no timeline or provenance metadata.
