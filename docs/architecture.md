# Starquix Architecture

Visual editor for Astro websites. Desktop (Electron) app, or a local web app (`web/`, see [web.md](web.md)): a Node server stands in for Electron main and gives the editor the same `window.sqDesktop` API over a WebSocket.

## System Overview

Each project is a plain Astro folder under `~/Starquix/<id>/`. The Electron main process (`desktop/src/`) runs that project's own `astro dev` as a child process (`instance.mjs`, `supervisor.mjs`) and serves the editor. The editor talks to main over IPC (`window.sqDesktop` from `preload.cjs`; `app/src/services/desktopDriver.ts`) and shows the site in iframes with `bridge.js` injected.

```
┌──────────────────────────────┐   IPC    ┌──────────────────────────────┐  spawns  ┌──────────────────────────┐
│ Editor (React, app/)         │◄────────►│ Electron main (desktop/src/) │─────────►│ Project's `astro dev`    │
│ packaged: starquix://app     │          │ files, git, publish, MCP     │          │ 127.0.0.1:<random port>  │
│ dev: http://127.0.0.1:3061   │          └──────────────────────────────┘          └──────────────────────────┘
└──────────────────────────────┘                                                                ▲
               │  postMessage (bridge.js inside the iframes)                                     │
               └─────────────────────────────────────────────────────────────────────────────────┘
```

## Core Concepts

### Source Keys

Elements are identified by their location in source files: `file:line:column`

Example: `src/components/Hero.astro:5:1`
- File: `src/components/Hero.astro`
- Line: 5
- Column: 1 (where the `<` starts)

**Why:** This ties DOM elements back to their Astro source for editing.

**How they're created:**
1. Vite plugin parses `.astro` files during build
2. Injects `data-sq-source="file:line:column"` on each element
3. Bridge.js reads these to identify clickable elements

**Key files:**
- `app/src/vite-plugin/index.ts` - injects the attributes
- `preview-template/public/scripts/bridge.js` - reads them

### Yjs Document (Single Source of Truth)

All editor state lives in a Yjs CRDT document. This enables:
- Collaborative editing (future)
- Unified undo/redo across all operations
- Reactive React updates

**Document structure:**
```typescript
doc.getMap('meta')           // projectId, selectedSourceKey, currentBreakpoint
doc.getMap('pages')          // page data by ID
doc.getMap('elements')       // element data by ID
doc.getArray('rootPages')    // root page IDs in order
doc.getMap('sourceClasses')  // file:line:col → breakpoint → classes[]
doc.getMap('sourceText')     // file:line:col → textContent
```

**Key files:**
- `app/src/store/createEditorDoc.ts` - creates the doc structure
- `app/src/store/commands.ts` - `applyCommand()` mutates the doc
- `app/src/store/hooks.ts` - React hooks to subscribe to state

### Commands Pattern

All mutations go through `applyCommand(doc, command)`:

```typescript
// Don't mutate directly:
meta.set('selectedSourceKey', key);  // BAD

// Use commands:
dispatch({ type: 'SELECT_SOURCE_ELEMENT', sourceKey: key });  // GOOD
```

**Why:** Commands are tracked by `Y.UndoManager` for undo/redo.

**Key command types:**
- `SELECT_SOURCE_ELEMENT` - select an element
- `UPDATE_SOURCE_CLASSES` - change Tailwind classes
- `UPDATE_SOURCE_TEXT` - change text content
- `REGISTER_SOURCE_ELEMENT` / `UNREGISTER_SOURCE_ELEMENT` - track elements

## Component Map

### Canvas Layer
- `Canvas/ViewportFrame.tsx` - 6 iframe previews (base/sm/md/lg/xl/2xl breakpoints)
- Each iframe loads the Astro preview server with bridge.js injected

### Selection & Editing
- `context/SelectionContext.tsx` - tracks what's selected, hovered, context stack
- `DesignBar/` - contextual toolbar above selected element
- `LayersPanel/` - element tree view

### State Management
- `store/` - Yjs document, commands, hooks
- `context/UndoContext.tsx` - undo/redo UI state
- `core/classes/` - Tailwind class parsing and manipulation

### Bridge Communication
- `bridge/types.ts` - message type definitions
- `bridge/BridgeMiddleware.ts` - injects bridge.js into iframe HTML
- `preview-template/public/scripts/bridge.js` - runs inside iframe

## Data Flow Summary

```
User clicks element in iframe
        │
        ▼
bridge.js sends ELEMENT_CLICK message
        │
        ▼
ViewportFrame receives via postMessage
        │
        ▼
Dispatches SELECT_SOURCE_ELEMENT command
        │
        ▼
Yjs document updates (with undo tracking)
        │
        ▼
React hooks rerender UI (DesignBar, LayersPanel, etc.)
```

```
User changes class in DesignBar
        │
        ▼
Dispatches UPDATE_SOURCE_CLASSES command
        │
        ▼
Yjs sourceClasses map updates
        │
        ▼
Observer in ViewportFrame fires
        │
        ▼
Sends UPDATE_CLASSES to iframe + writes file via Vite plugin
        │
        ▼
Astro HMR updates preview (suppressed to prevent jank)
```

See `docs/data-flows/` for detailed flow documentation.

## Key Files Quick Reference

| Task | Files |
|------|-------|
| Add new command type | `store/commands.ts`, `store/types.ts` |
| Change selection behavior | `context/SelectionContext.tsx`, `ViewportFrame.tsx` |
| Modify class editing | `core/classes/`, `DesignBar/` |
| Change iframe communication | `bridge/types.ts`, `bridge.js` |
| Modify file writing | `vite-plugin/index.ts`, `vite-plugin/ast-updater.ts` |
| Add undo/redo support | `context/UndoContext.tsx`, wrap in `doc.transact()` |

## 6 Breakpoints

The editor shows 6 viewports for responsive design:

| Breakpoint | Tailwind | Width |
|------------|----------|-------|
| base | (none) | 320px |
| sm | sm: | 640px |
| md | md: | 768px |
| lg | lg: | 1024px |
| xl | xl: | 1280px |
| 2xl | 2xl: | 1536px |

Each has its own iframe. Class changes target the current breakpoint.
