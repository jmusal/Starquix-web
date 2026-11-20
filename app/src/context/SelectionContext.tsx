import { recordEditorMetric } from '@/performance/editorMetrics';
import { noteScan } from '@/utils/propOverrides';
import type { ImageFillGeometry } from '@/services/imageFillGeometry';
/**
 * Selection Context
 *
 * Manages the selection and hover state for elements in the editor.
 * Coordinates selection between ElementsTree, Preview iframe, and DesignBar.
 *
 * SPLIT into two contexts for performance:
 * - SelectionContext: selected element, editing state, context drill-down, text selection
 * - ScannedElementsContext: scanned elements, expanded nodes, tree nodes
 *
 * Consumers that only need selection data subscribe to SelectionContext only,
 * avoiding re-renders when scanned elements update (and vice versa).
 */

import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react';
import type { SourceLocation } from '@/core/state/index';
import type { ElementRect } from '@/bridge';
import type { ContainerLayout } from '@/bridge/types';
import { buildTreeFromScannedElements, type TreeNode } from '@/utils/treeUtils';
import { isUserSelectable } from '@/store/keyKind';
import { decideToggle, relinkSameLine, type ToggleDecision } from '@/store/multiSelect';
import { selectOptionsFor } from '@/utils/selectOptions';
import { noteSelectionChanged } from '@/utils/localPendingSelection';
import { createElementGeometryStore, sameElementRect, type ElementGeometryStore } from './elementGeometryStore';
import { stableContext } from '@/utils/stableContext';

function samePostLinkPaths(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  return a === b || (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((path, index) => path === b?.[index]);
}

/** Root element id derived from a selection key ("el-abc:div-0" → "el-abc").
 *  Dynamic keys are internal to components — they have no addressable root. */
export function deriveSelectedElementId(key: string | null): string | null {
  if (!key) return null;
  const id = key.split(':')[0];
  return id === 'dynamic' ? null : id;
}

// ============================================================================
// Types
// ============================================================================

/** Scanned element from iframe */
export interface ScannedElement {
  key: string;
  sourceKey?: string;
  /**
   * task-159/160 (TRANSITIONAL) — the same element's key under each SUPERSEDED
   * placement chain, MOST RECENT FIRST: `~q…` (task-159's ordinal) then `~p…`
   * (the original coordinate). Consumed by `store/placementKeyMigration.ts`
   * alone, to move an override stored under an old address onto the current one
   * exactly once. Delete together with the tagger's legacy chains after one
   * usage cycle.
   */
  legacyKeys?: readonly string[];
  tagName: string;
  classes: string;
  /** Computed flex/grid layout; absent for ordinary flow containers. */
  layout?: ContainerLayout;
  sourceLocation?: SourceLocation;
  /**
   * task-148 item 7 — the `<Card />` invocation tag that PLACED this element's
   * component, in the placing file. Distinct from `sourceLocation`, which is
   * where the element itself is DEFINED.
   *
   * LOCAL MODE ONLY (undefined elsewhere, by construction in the bridge) and
   * undefined for a page file's own elements. When it names the current surface
   * file it is the one write target that means "remove this component from THIS
   * page"; `utils/localUsageTarget.ts` is the only place that decides that.
   */
  usageLocation?: SourceLocation;
  /** The master's classes when this element's class reads an override prop
   *  (`data-sq-cf`, utils/propOverrides.ts) — `classes` may be a page's override. */
  masterClasses?: string;
  /** Same for text (`data-sq-tf`), trimmed + capped like `textContent`. */
  masterText?: string;
  /** Same for an <img> src (`data-sq-sf`), capped like `imageSrc`. */
  masterSrc?: string;
  rect: { top: number; left: number; width: number; height: number };
  parentKey: string | null;
  parentDisplay?: string;
  hasSourceTracking: boolean;
  /** Direct text-node children only (not full subtree), trimmed, max 200 chars */
  textContent?: string;
  /** Post slug if this element is inside a blog card */
  postSlug?: string;
  /** Same-origin article link paths; read-only post navigation evidence. */
  postLinkPaths?: readonly string[];
  /**
   * task-206: present when the element sits inside a rendered <Media/>
   * (.sq-media). The rehype wrapper's data-sq-body-line/end stamps — the
   * MediaBlock's write target in the post .mdx (local mode stamps them;
   * WC post pages don't, so MediaBlock falls back to read-only there).
   */
  mediaUnit?: { bodyLine: number; bodyEnd: number };
  /** The enclosing post body block's `data-sq-body-line` — where the writing view opens. */
  bodyLine?: number;
  /**
   * Component name when this element represents a component instance whose
   * provenance lives outside Yjs's `componentType` map — currently the first
   * DOM child of a filled drawn slot. Layers uses it as both display label
   * and "is a component" signal so the right icon shows up.
   */
  componentName?: string;
  /**
   * `data-sq-component-src` value when this element is the outer tag of a
   * sub-component expanded inside another component's rendered HTML
   * (e.g. `<CTA />` inside BlogPost.astro renders as `<section ...>`).
   * Used at reorder write-back time to translate rendered selectors
   * (e.g. `section-0`) to the source-tag selector (e.g. `cta-0`) so
   * `mapKeysToPositions` can resolve them in the parent .astro source.
   */
  componentSrc?: string;
  /**
   * The layout slot's name when this element is a layout slot (the filled
   * `<div data-sq-slot>` or an empty chrome `<slot>`). '' = the default slot.
   * Present ⇒ this element is a droppable layout slot; dropping a content root
   * onto it re-homes the root via `SET_ELEMENT_SLOT_NAME` (see utils/slotDrop).
   */
  slotName?: string;
  /** Present when tagName is 'img': its `src` attribute, '' when absent
   *  (capped at 200 chars). '' drives the canvas empty-image receiver frame;
   *  the value is local mode's ↻ `now` half (task-186 FIX-2). */
  imageSrc?: string;
  /** imgs only: the alt attribute, so a Layers selection shows the Fill description. */
  imageAlt?: string;
  /** The link this element is or sits inside (bridge linkAttributesOf): the Link block's truth. */
  linkKey?: string;
  linkHref?: string;
  linkTarget?: string;
  linkAriaLabel?: string;
  /** No link, and an <a> cannot go around this element. */
  linkBlocked?: boolean;
  /** task-143 (imgs only): decoded bound-asset path for astro <Image> output,
   *  so a Layers selection classifies the same as a canvas click */
  boundAssetPath?: string;
  /** task-143 (imgs only, no source location): the owning component's file */
  ownerComponentFile?: string;
  /** task-143 (astro-<Image> imgs only): index among such imgs in the document */
  imageComponentIndex?: number;
}

/** Computed styles from getComputedStyle() - actual rendered values */
export interface ComputedStyles extends ImageFillGeometry {
  fontSize?: string;
  fontWeight?: string;
  fontFamily?: string;
  lineHeight?: string;
  letterSpacing?: string;
  textAlign?: string;
  color?: string;
  width?: string;
  height?: string;
  paddingTop?: string;
  paddingRight?: string;
  paddingBottom?: string;
  paddingLeft?: string;
  marginTop?: string;
  marginRight?: string;
  marginBottom?: string;
  marginLeft?: string;
  backgroundColor?: string;
  backgroundImage?: string;
  bgImagePreviewDataUrl?: string;
}

export interface TextSelectionState {
  /** Whether there is an active text selection in edit mode */
  hasTextSelection: boolean;
  /** The selected text content */
  selectedText: string;
  /** Whether the selection is inside an existing link */
  isInsideLink: boolean;
  /** Existing href if inside a link */
  existingHref?: string;
  /** Existing target if inside a link */
  existingTarget?: '_blank' | '_self';
  /** The data-key of the link element when cursor is inside a link */
  linkKey?: string;
}

// --------------- Selection State ---------------

/** One member of the multi-selection extension set. UI-only: lives in
 *  SelectionContext exclusively and is NEVER mirrored into Yjs meta
 *  (docs/archive/plans/2026-06-11-multi-select-design.md §2). */
export interface MultiSelectionEntry {
  key: string;
  /** TreeNode.elementId captured at click time — group Delete must not lean on
   *  the singular Yjs selectedElementId. Null when the row has none. */
  elementId: string | null;
}

interface SelectionState {
  /** Currently selected element key */
  selectedKey: string | null;
  /** The doc (Yjs page id) the selection belongs to, stamped at select time
   *  from the scope set via setSelectionDocScope. Lets consumers ask "is the
   *  selection inside MY doc?" without key-shape heuristics. */
  selectedDocId: string | null;
  /** Source location of selected element */
  selectedSourceLocation: SourceLocation | null;
  /** Tag name of selected element */
  selectedTagName: string | null;
  /** Current classes of selected element */
  selectedClasses: string | null;
  /** Computed styles of selected element (from getComputedStyle) */
  selectedComputedStyles: ComputedStyles | null;
  /** Parent's computed display property (to detect grid/flex children) */
  selectedParentDisplay: string | null;
  /** Image src attribute (for <img> elements) */
  selectedImageSrc: string | null;
  selectedMediaFill: boolean;
  selectedHasElementChildren: boolean;
  /** task-142: astro <Image> — absolute path of the bound src/ asset */
  selectedBoundAssetPath: string | null;
  /** task-143: index among the document's astro-<Image> imgs (default-image write target) */
  selectedImageComponentIndex: number | null;
  /** task-142: owning component file for prop-driven imgs */
  selectedOwnerComponentFile: string | null;
  /** Image alt attribute (for <img> elements) */
  selectedImageAlt: string | null;
  /** Image preview data URL (cross-origin safe thumbnail) */
  selectedImagePreviewDataUrl: string | null;
  /** Blog post slug (for blog card elements inside a BlogSlot) */
  selectedPostSlug: string | null;
  selectedPostLinkPaths: readonly string[] | null;
  /** Current "editing" container - null means root level (Figma drill-down) */
  contextKey: string | null;
  /** Stack of containers we've drilled into (breadcrumb trail) */
  contextStack: string[];
  /** Text selection state for link editing */
  textSelection: TextSelectionState;
  /** Multi-selection extension set — members beyond the primary selectedKey.
   *  SelectionContext-only; collapsed by any plain select()/clearSelection(). */
  additionalSelections: MultiSelectionEntry[];
}

export interface SelectionPatch {
  tagName?: string; classes?: string; imageSrc?: string | null; imageAlt?: string | null; imagePreviewDataUrl?: string | null;
}
interface SelectionContextValue extends SelectionState {
  /** Root element id derived from selectedKey ("el-abc:div-0" → "el-abc";
   *  dynamic keys → null). Pure derivation — never stored. */
  selectedElementId: string | null;
  /** True when user is editing text content inline */
  isEditingText: boolean;
  /** True when user is interacting with LinkBlock (prevents unmounting) */
  isLinkInteracting: boolean;
  /** Ref for synchronous access to isLinkInteracting (needed in message handlers) */
  isLinkInteractingRef: React.MutableRefObject<boolean>;
  /** Refs for synchronous access in iframe message handlers (task-075).
   *  Every selection mutator maintains them in the same call as the state
   *  update, so handlers firing before the next render never see stale values.
   *  selectedElementIdRef is a read-only getter derived from selectedKeyRef. */
  selectedKeyRef: React.MutableRefObject<string | null>;
  selectedElementIdRef: React.RefObject<string | null>;
  contextKeyRef: React.MutableRefObject<string | null>;
  /** Set link interacting state */
  setLinkInteracting: (value: boolean) => void;
  /** Enter text edit mode for selected element */
  enterEditMode: () => void;
  /** Exit text edit mode */
  exitEditMode: () => void;
  /** Select an element */
  select: (
    key: string | null,
    options?: {
      sourceLocation?: SourceLocation;
      tagName?: string;
      classes?: string;
      computedStyles?: ComputedStyles;
      rect?: ElementRect;
      parentDisplay?: string;
      imageSrc?: string | null;
      imageAlt?: string | null;
      imagePreviewDataUrl?: string | null;
      postSlug?: string | null;
      postLinkPaths?: readonly string[] | null;
      /** task-140: element carries an unresolved data-sq-media fill */
      mediaFill?: boolean;
      /** task-141: element has element children (Media tab: swap vs background) */
      hasElementChildren?: boolean;
      /** task-142: astro <Image> — absolute path of the bound src/ asset */
      boundAssetPath?: string | null;
      /** task-143: index among the document's astro-<Image> imgs */
      imageComponentIndex?: number | null;
      /** task-142: owning component file for prop-driven imgs */
      ownerComponentFile?: string | null;
    }
  ) => void;
  /** Clear selection */
  clearSelection: () => void;
  /** Refresh the facts of the CURRENT selection in place (the rescan after
   *  a write, or the writer itself): tag, classes, image src/alt/thumbnail.
   *  No-op for any other key; never collapses the extension set. */
  patchSelection: (key: string, patch: SelectionPatch) => void;
  /** Add a member to the multi-selection extension set (dedupes by key;
   *  never adds the current primary). */
  addAdditionalSelection: (entry: MultiSelectionEntry) => void;
  /** Remove a member of the extension set by key. */
  removeAdditionalSelection: (key: string) => void;
  /** Collapse to single-select: clear the extension set, keep the primary. */
  clearAdditionalSelections: () => void;
  /** Shift+click (canvas) / ⌘-click (Layers). Performs join / leave / drop-primary /
   *  deselect; returns 'select' or 'none' for the caller (plain select / no-op). */
  toggleInSelection: (key: string, opts: { elementId?: string | null; isLocked: (key: string) => boolean }) => ToggleDecision;
  /** Set the doc (page id) that subsequent select() calls belong to. Called by
   *  ViewportFrame on page change. Ref-based — does not re-render consumers. */
  setSelectionDocScope: (docId: string | null) => void;
  /** Enter a container context (double-click to drill down). Never changes
   *  the selection — callers that want both select explicitly. */
  enterContext: (key: string) => void;
  /** Exit current context (go up one level) */
  exitContext: () => void;
  /** Reset all context drill-down state (used on page change) */
  resetContext: () => void;
  /** Update text selection state (from bridge) */
  setTextSelection: (selection: TextSelectionState) => void;
  /** Clear text selection */
  clearTextSelection: () => void;
  /** Update the background image preview data URL for the selected element */
  updateBgImagePreview: (key: string, dataUrl: string) => void;
  /** Update the image preview data URL for the selected <img> element */
  updateImagePreview: (key: string, dataUrl: string) => void;
  /** Key of element being reparent-dragged outside iframe (null when inactive) */
  reparentDragKey: string | null;
  /** Set reparent drag key (used by ViewportFrame on exit/reenter) */
  setReparentDragKey: (key: string | null) => void;
}

// --------------- Scanned Elements State ---------------

interface ScannedElementsState {
  /** Elements scanned from iframe DOM */
  scannedElements: ScannedElement[];
  /** Expanded nodes in ElementsTree */
  expandedNodes: Set<string>;
}

interface ScannedElementsContextValue extends ScannedElementsState {
  /** Tree nodes built from scanned elements (computed via useMemo) */
  treeNodes: TreeNode[];
  /** O(1) key → element lookup, shared across consumers to avoid repeat O(n) finds */
  scannedByKey: Map<string, ScannedElement>;
  /** Set scanned elements from iframe */
  setScannedElements: (elements: ScannedElement[]) => void;
  /** Update scanned element rects (for layout changes like breakpoint switch) */
  updateScannedElementRects: (rects: Array<{ key: string; rect: { top: number; left: number; width: number; height: number } }>) => void;
  /** Toggle node expansion in tree */
  toggleExpand: (key: string) => void;
  /** Expand multiple nodes (for auto-reveal) */
  expandNodes: (keys: string[]) => void;
  /** Collapse all nodes */
  collapseAll: () => void;
}

// ============================================================================
// Contexts
// ============================================================================

const SelectionContext = stableContext<SelectionContextValue | null>('SelectionContext', null);
const ScannedElementsContext = stableContext<ScannedElementsContextValue | null>('ScannedElementsContext', null);

// High-frequency selection rect updates separated to avoid re-rendering all consumers.
// Hover state (hoveredRect) lives locally in ViewportFrame and is passed directly
// to SelectionOverlay -- it never goes through context.
interface RectHoverContextValue {
  selectedRect: ElementRect | null;
  updateSelectionRect: (rect: ElementRect | null) => void;
  /** The current rect without subscribing (a gesture reads it at apply time). */
  getSelectedRect: () => ElementRect | null;
}

const ElementGeometryContext = stableContext<ElementGeometryStore | null>('ElementGeometryContext', null);
const RectActionsContext = stableContext<Pick<RectHoverContextValue, 'updateSelectionRect' | 'getSelectedRect'> | null>('RectActionsContext', null);

const RectHoverContext = stableContext<RectHoverContextValue | null>('RectHoverContext', null);

// Non-reactive scanned-elements access. The value is created once and NEVER
// changes identity, so consumers of this context never re-render on scans —
// they read .current at event/callback time. For consumers (Editor,
// useKeyboardShortcuts) that only mirror scannedElements into a ref anyway,
// subscribing to ScannedElementsContext was 100% wasted renders.
interface ScannedRefsContextValue {
  scannedElementsRef: React.MutableRefObject<ScannedElement[]>;
  scannedByKeyRef: React.MutableRefObject<Map<string, ScannedElement>>;
  treeNodesRef: React.MutableRefObject<TreeNode[]>;
}

const ScannedRefsContext = stableContext<ScannedRefsContextValue | null>('ScannedRefsContext', null);

// Non-reactive selection access. Same idea as ScannedRefsContext: the value
// never changes identity, so consumers (Editor) that only read selection at
// event/callback time don't re-render on every selection change.
interface SelectionRefsContextValue {
  selectedKeyRef: React.MutableRefObject<string | null>;
  selectedElementIdRef: React.RefObject<string | null>;
  contextKeyRef: React.MutableRefObject<string | null>;
}

const SelectionRefsContext = stableContext<SelectionRefsContextValue | null>('SelectionRefsContext', null);

/** Find all ancestor keys for a given key using a precomputed key→element map. */
function findAncestorKeysFromElements(
  targetKey: string,
  elementMap: Map<string, ScannedElement>
): string[] {
  const ancestors: string[] = [];
  const visited = new Set<string>();

  let current = elementMap.get(targetKey);
  while (current?.parentKey) {
    // Cycle detection: stop if we've seen this parent before
    if (visited.has(current.parentKey)) {
      console.warn('[SelectionContext] Cycle detected in parent chain:', current.parentKey);
      break;
    }
    visited.add(current.parentKey);
    ancestors.push(current.parentKey);
    current = elementMap.get(current.parentKey);
  }

  return ancestors;
}

/**
 * Field-wise equality for two scans. Scans arrive after every structural
 * operation (and some no-op rescans); publishing a new array identity for an
 * identical scan rebuilds treeNodes/scannedByKey and re-renders every
 * ScannedElementsContext consumer for nothing. Compares every field a scan
 * carries (incl. rects and sourceLocation) so a `true` genuinely means
 * "nothing changed".
 */
export function scannedElementsShallowEqual(
  a: ScannedElement[],
  b: ScannedElement[],
  includeRects = true,
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.key !== y.key ||
      x.sourceKey !== y.sourceKey ||
      x.tagName !== y.tagName ||
      x.classes !== y.classes ||
      x.layout !== y.layout ||
      x.parentKey !== y.parentKey ||
      x.parentDisplay !== y.parentDisplay ||
      x.hasSourceTracking !== y.hasSourceTracking ||
      x.textContent !== y.textContent ||
      x.postSlug !== y.postSlug ||
      !samePostLinkPaths(x.postLinkPaths, y.postLinkPaths) ||
      x.componentName !== y.componentName ||
      x.componentSrc !== y.componentSrc ||
      x.slotName !== y.slotName ||
      x.imageSrc !== y.imageSrc ||
      x.imageAlt !== y.imageAlt ||
      x.linkKey !== y.linkKey ||
      x.linkBlocked !== y.linkBlocked ||
      x.linkHref !== y.linkHref ||
      x.linkTarget !== y.linkTarget ||
      x.linkAriaLabel !== y.linkAriaLabel ||
      x.boundAssetPath !== y.boundAssetPath ||
      x.ownerComponentFile !== y.ownerComponentFile ||
      x.imageComponentIndex !== y.imageComponentIndex ||
      !samePostLinkPaths(x.legacyKeys, y.legacyKeys) ||
      x.mediaUnit?.bodyLine !== y.mediaUnit?.bodyLine ||
      x.mediaUnit?.bodyEnd !== y.mediaUnit?.bodyEnd
    ) {
      return false;
    }
    const xr = x.rect;
    const yr = y.rect;
    if (includeRects && !sameElementRect(xr, yr)) {
      return false;
    }
    const xs = x.sourceLocation;
    const ys = y.sourceLocation;
    if (xs !== ys) {
      if (!xs || !ys) return false;
      if (xs.file !== ys.file || xs.line !== ys.line || xs.column !== ys.column || xs.sourceVersion !== ys.sourceVersion || xs.sourceRevision !== ys.sourceRevision) return false;
    }
    // usageLocation feeds the lock-tier badge (limited derivation) — a scan
    // that only changed a usage must not bail out or the badge goes stale.
    const xu = x.usageLocation;
    const yu = y.usageLocation;
    if (xu !== yu) {
      if (!xu || !yu) return false;
      if (xu.file !== yu.file || xu.line !== yu.line || xu.column !== yu.column || xu.sourceVersion !== yu.sourceVersion || xu.sourceRevision !== yu.sourceRevision) return false;
    }
  }
  return true;
}

// ============================================================================
// Provider
// ============================================================================

interface SelectionProviderProps {
  children: React.ReactNode;
}

/** Cleared selection fields (reusable for clearSelection) */
const CLEARED_SELECTION = {
  selectedKey: null,
  selectedDocId: null,
  selectedSourceLocation: null,
  selectedTagName: null,
  selectedClasses: null,
  selectedComputedStyles: null,
  selectedParentDisplay: null,
  selectedImageSrc: null,
  selectedMediaFill: false,
  selectedHasElementChildren: false,
  selectedBoundAssetPath: null,
  selectedImageComponentIndex: null,
  selectedOwnerComponentFile: null,
  selectedImageAlt: null,
  selectedImagePreviewDataUrl: null,
  selectedPostSlug: null,
  selectedPostLinkPaths: null,
  contextKey: null,
  contextStack: [] as string[],
  additionalSelections: [] as MultiSelectionEntry[],
} as const;


/** A message from this page or from one of its own iframes (the canvas, wherever its preview is served: 127.0.0.1 on
 *  desktop, a public preview port in the web build). Matching on host names let `*localhost*` look-alikes through and
 *  shut out a canvas on a real host name. */
export function fromOwnFrameOrSelf(event: MessageEvent): boolean {
  if (event.origin === window.location.origin) return true;
  if (!event.source) return false;
  for (const frame of Array.from(document.querySelectorAll('iframe'))) if (frame.contentWindow === event.source) return true;
  return false;
}

export const SelectionProvider: React.FC<SelectionProviderProps> = ({
  children,
}) => {
  const [geometryStore] = useState(createElementGeometryStore);
  // --------------- Selection State ---------------
  const [selectionState, setSelectionState] = useState<SelectionState>({
    ...CLEARED_SELECTION,
    contextKey: null,
    contextStack: [],
    textSelection: {
      hasTextSelection: false,
      selectedText: '',
      isInsideLink: false,
    },
  });

  // High-frequency selection rect state separated to avoid re-rendering all consumers
  const [selectedRect, setSelectedRect] = useState<ElementRect | null>(null);

  // Doc scope for new selections (Phase 3 of the selection-key memo). Ref-based:
  // changing the scope alone never re-stamps or re-renders — it only affects
  // future select() calls.
  const docScopeRef = useRef<string | null>(null);
  const setSelectionDocScope = useCallback((docId: string | null) => {
    docScopeRef.current = docId;
  }, []);

  // --------------- Scanned Elements State ---------------
  const [scannedState, setScannedState] = useState<ScannedElementsState>({
    scannedElements: [],
    expandedNodes: new Set<string>(),
  });

  // --------------- Shared boolean states ---------------
  const [isEditingText, setIsEditingText] = useState(false);
  const [isLinkInteracting, setIsLinkInteracting] = useState(false);
  const [reparentDragKey, setReparentDragKey] = useState<string | null>(null);

  // Refs for synchronous cross-context access
  const isLinkInteractingRef = useRef(false);
  const selectedKeyRef = useRef<string | null>(null);
  // Synchronous mirror of selectionState.additionalSelections: every writer
  // below keeps the two equal in the same call, so several toggles in one tick
  // (canvas Shift+click / Layers ⌘-click) read the truth, not a stale render.
  const additionalSelectionsRef = useRef<MultiSelectionEntry[]>([]);
  // Derived synchronously from selectedKeyRef — never written, can't desync.
  const selectedElementIdRef = useMemo<React.RefObject<string | null>>(
    () => ({ get current() { return deriveSelectedElementId(selectedKeyRef.current); } }),
    []
  );
  const contextKeyRef = useRef<string | null>(null);
  // Internal mirror of contextStack so exitContext can compute its result
  // synchronously (state updaters run at render time, too late for refs).
  const contextStackRef = useRef<string[]>([]);
  const scannedElementsRef = useRef<ScannedElement[]>([]);
  // Mirrors scannedElementsRef as a key→element Map. Maintained in lockstep
  // by setScannedElements / updateScannedElementRects so select() doesn't
  // rebuild a new Map on every click.
  const scannedByKeyRef = useRef<Map<string, ScannedElement>>(new Map());
  const initialExpandDoneRef = useRef(false);

  // --------------- Selection Callbacks ---------------

  const enterEditMode = useCallback(() => {
    setIsEditingText(true);
  }, []);

  const exitEditMode = useCallback(() => {
    setIsEditingText(false);
    // DON'T reset isLinkInteracting here - it's controlled by LinkBlock
    setSelectionState(prev => ({
      ...prev,
      textSelection: {
        hasTextSelection: false,
        selectedText: '',
        isInsideLink: false,
      }
    }));
  }, []);

  const handleSetLinkInteracting = useCallback((value: boolean) => {
    isLinkInteractingRef.current = value;
    setIsLinkInteracting(value);
  }, []);

  const select = useCallback(
    (
      key: string | null,
      options?: {
        sourceLocation?: SourceLocation;
        tagName?: string;
        classes?: string;
        computedStyles?: ComputedStyles;
        rect?: ElementRect;
        parentDisplay?: string;
        imageSrc?: string | null;
        imageAlt?: string | null;
        imagePreviewDataUrl?: string | null;
        postSlug?: string | null;
        postLinkPaths?: readonly string[] | null;
        mediaFill?: boolean;
        hasElementChildren?: boolean;
        boundAssetPath?: string | null;
        imageComponentIndex?: number | null;
        ownerComponentFile?: string | null;
      }
    ) => {
      // Infrastructure (the #sq-components wrapper) is never a meaningful
      // selection — refuse it here so no consumer has to guard individually.
      // `select(null)` stays a valid deselect.
      if (key !== null && !isUserSelectable(key)) return;

      // Exit edit mode when selecting different element
      if (key !== selectedKeyRef.current) {
        setIsEditingText(false);
        noteSelectionChanged();
      }
      // Mirrors the updater's own rule below: re-anchoring the same primary
      // without a payload keeps the extension set; anything else collapses it.
      const keepsExtras = selectedKeyRef.current === key && !options;
      selectedKeyRef.current = key;
      if (!keepsExtras) additionalSelectionsRef.current = [];

      // Compute parentDisplay fallback from scanned elements ref
      let parentDisplay = options?.parentDisplay ?? null;
      if (!parentDisplay && key) {
        const scannedElement = scannedElementsRef.current.find(el => el.key === key);
        if (scannedElement?.parentDisplay) {
          parentDisplay = scannedElement.parentDisplay;
        }
      }

      // Auto-expand ancestors in scanned elements state
      if (key) {
        const ancestors = findAncestorKeysFromElements(key, scannedByKeyRef.current);
        if (ancestors.length > 0) {
          setScannedState(prev => {
            const newExpanded = new Set(prev.expandedNodes);
            let changed = false;
            for (const k of ancestors) {
              if (!newExpanded.has(k)) {
                newExpanded.add(k);
                changed = true;
              }
            }
            return changed ? { ...prev, expandedNodes: newExpanded } : prev;
          });
        }
      }

      // Update selection state
      setSelectionState(prev => {
        if (prev.selectedKey === key && !options) {
          // Re-anchoring the same primary keeps the extension set — the
          // multi-select toggle path relies on this.
          return prev;
        }
        return {
          ...prev,
          // Any plain select collapses the multi-selection extension set.
          additionalSelections: [],
          selectedKey: key,
          selectedDocId: key === null ? null : docScopeRef.current,
          selectedSourceLocation: options?.sourceLocation ?? null,
          selectedTagName: options?.tagName ?? null,
          selectedClasses: options?.classes ?? null,
          selectedComputedStyles: options?.computedStyles ?? null,
          selectedParentDisplay: parentDisplay,
          selectedImageSrc: options?.imageSrc ?? null,
          selectedMediaFill: options?.mediaFill ?? false,
          selectedHasElementChildren: options?.hasElementChildren ?? false,
          selectedBoundAssetPath: options?.boundAssetPath ?? null,
          selectedImageComponentIndex: options?.imageComponentIndex ?? null,
          selectedOwnerComponentFile: options?.ownerComponentFile ?? null,
          selectedImageAlt: options?.imageAlt ?? null,
          selectedImagePreviewDataUrl: options?.imagePreviewDataUrl ?? null,
          selectedPostSlug: options?.postSlug ?? null,
          selectedPostLinkPaths: key === null ? null : options?.postLinkPaths ?? null,
        };
      });

      // Update rect in separate state (high-frequency, doesn't trigger main context re-render)
      setSelectedRect(options?.rect ?? null);
    },
    []
  );

  const clearSelection = useCallback(() => {
    setIsEditingText(false);
    if (selectedKeyRef.current !== null) noteSelectionChanged();
    selectedKeyRef.current = null;
    additionalSelectionsRef.current = [];
    contextKeyRef.current = null;
    contextStackRef.current = [];
    setSelectionState(prev => ({ ...prev, ...CLEARED_SELECTION }));
    selectedRectRef.current = null; setSelectedRect(null);
  }, []);

  const patchSelection = useCallback((key: string, patch: SelectionPatch) => {
    setSelectionState(prev => {
      if (prev.selectedKey !== key) return prev;
      const next = { ...prev };
      if (patch.tagName !== undefined) next.selectedTagName = patch.tagName;
      if (patch.classes !== undefined) next.selectedClasses = patch.classes;
      if ('imageSrc' in patch) next.selectedImageSrc = patch.imageSrc ?? null;
      if ('imageAlt' in patch) next.selectedImageAlt = patch.imageAlt ?? null;
      if ('imagePreviewDataUrl' in patch) next.selectedImagePreviewDataUrl = patch.imagePreviewDataUrl ?? null;
      return (Object.keys(next) as (keyof typeof next)[]).every(k => next[k] === prev[k]) ? prev : next;
    });
  }, []);

  const selectedRectRef = useRef<ElementRect | null>(null);
  const updateSelectionRect = useCallback((rect: ElementRect | null) => {
    selectedRectRef.current = rect;
    setSelectedRect(rect);
  }, []);
  const getSelectedRect = useCallback(() => selectedRectRef.current, []);

  // --------------- Multi-selection extension set ---------------
  // UI-only state (never mirrored into Yjs meta); membership policy lives in
  // store/multiSelect.ts and is enforced by the callers (Layers panel).

  const addAdditionalSelection = useCallback((entry: MultiSelectionEntry) => {
    const extras = additionalSelectionsRef.current;
    if (entry.key === selectedKeyRef.current || extras.some(e => e.key === entry.key)) return;
    const next = [...extras, entry];
    additionalSelectionsRef.current = next;
    setSelectionState(prev => ({ ...prev, additionalSelections: next }));
  }, []);

  const removeAdditionalSelection = useCallback((key: string) => {
    const extras = additionalSelectionsRef.current;
    if (!extras.some(e => e.key === key)) return;
    const next = extras.filter(e => e.key !== key);
    additionalSelectionsRef.current = next;
    setSelectionState(prev => ({ ...prev, additionalSelections: next }));
  }, []);

  const clearAdditionalSelections = useCallback(() => {
    if (additionalSelectionsRef.current.length === 0) return;
    additionalSelectionsRef.current = [];
    setSelectionState(prev => ({ ...prev, additionalSelections: [] }));
  }, []);

  // ONE toggle rule for canvas Shift+click and Layers ⌘-click (store/multiSelect.ts
  // decideToggle). Reads refs, so several toggles in one tick stay consistent.
  const toggleInSelection = useCallback((
    key: string,
    opts: { elementId?: string | null; isLocked: (key: string) => boolean },
  ): ToggleDecision => {
    const extras = additionalSelectionsRef.current;
    const decision = decideToggle({
      clickedKey: key, primaryKey: selectedKeyRef.current, extraKeys: extras.map(e => e.key), isLocked: opts.isLocked,
    });
    if (decision === 'join') addAdditionalSelection({ key, elementId: opts.elementId ?? null });
    else if (decision === 'leave') removeAdditionalSelection(key);
    else if (decision === 'deselect') clearSelection();
    else if (decision === 'drop-primary') {
      // The earliest-added member still in the scan becomes primary (full payload); the rest stay.
      const next = extras.find(e => scannedByKeyRef.current.has(e.key));
      if (!next) clearSelection();
      else {
        select(next.key, selectOptionsFor(scannedByKeyRef.current.get(next.key)!));
        for (const e of extras) if (e.key !== next.key) addAdditionalSelection(e);
      }
    }
    return decision;
  }, [select, clearSelection, addAdditionalSelection, removeAdditionalSelection]);

  const updateBgImagePreview = useCallback((key: string, dataUrl: string) => {
    setSelectionState(prev => {
      if (prev.selectedKey !== key) return prev;
      return {
        ...prev,
        selectedComputedStyles: {
          ...prev.selectedComputedStyles,
          bgImagePreviewDataUrl: dataUrl,
        },
      };
    });
  }, []);

  const updateImagePreview = useCallback((key: string, dataUrl: string) => {
    setSelectionState(prev => {
      if (prev.selectedKey !== key) return prev;
      return { ...prev, selectedImagePreviewDataUrl: dataUrl };
    });
  }, []);

  // Context management for Figma-like drill-down selection.
  // Context (drill-down location) and selection are ORTHOGONAL: entering a
  // context never implies selection. Every drill-down caller selects the
  // target explicitly via select()/selectInContext() with the full payload —
  // and the auto-entered infrastructure wrapper (#sq-components /
  // [pageId].astro) must never be selected at all.
  const enterContext = useCallback((key: string) => {
    // Compute the transition ONCE from the refs (the synchronous truth); the
    // state updater consumes the captured values so the two can never diverge.
    if (contextKeyRef.current !== key) {
      const newStack = contextKeyRef.current
        ? [...contextStackRef.current, contextKeyRef.current]
        : [];
      contextStackRef.current = newStack;
      contextKeyRef.current = key;
      setSelectionState(prev => ({
        ...prev,
        contextKey: key,
        contextStack: newStack,
      }));
    }
    // Expand this node in scanned elements state
    setScannedState(prev => {
      if (prev.expandedNodes.has(key)) return prev;
      const newExpanded = new Set(prev.expandedNodes);
      newExpanded.add(key);
      return { ...prev, expandedNodes: newExpanded };
    });
  }, []);

  const exitContext = useCallback(() => {
    // Compute the transition ONCE from the refs, synchronously — message
    // handlers can fire before the next render and must see the post-exit
    // values (task-044). The state updater consumes the captured values so
    // the ref and state transitions can never diverge.
    const exitedContext = contextKeyRef.current;
    if (!exitedContext) return;
    const newStack = [...contextStackRef.current];
    const parentContext = newStack.pop() || null;
    // Drill-up selects the container being exited — unless it's the infra
    // wrapper (the auto-entered outermost context), which must never leak
    // into the selection.
    const nextSelected = isUserSelectable(exitedContext) ? exitedContext : null;
    if (nextSelected !== selectedKeyRef.current) noteSelectionChanged();
    selectedKeyRef.current = nextSelected;
    contextKeyRef.current = parentContext;
    contextStackRef.current = newStack;
    setSelectionState(prev => ({
      ...prev,
      contextKey: parentContext,
      contextStack: newStack,
      selectedKey: nextSelected,
      selectedDocId: nextSelected ? docScopeRef.current : null,
      selectedPostLinkPaths: nextSelected ? scannedByKeyRef.current.get(nextSelected)?.postLinkPaths ?? null : null,
    }));
  }, []);

  const resetContext = useCallback(() => {
    contextKeyRef.current = null;
    contextStackRef.current = [];
    setSelectionState(prev => {
      if (!prev.contextKey && prev.contextStack.length === 0) return prev;
      return { ...prev, contextKey: null, contextStack: [] };
    });
  }, []);

  // task-120 (5.3): selectionchange-rate callers — bail when the text
  // selection is content-identical so no consumer re-renders.
  const setTextSelection = useCallback((selection: TextSelectionState) => {
    setSelectionState(prev => {
      const t = prev.textSelection;
      if (
        t.hasTextSelection === selection.hasTextSelection &&
        t.selectedText === selection.selectedText &&
        t.isInsideLink === selection.isInsideLink &&
        t.existingHref === selection.existingHref &&
        t.existingTarget === selection.existingTarget &&
        t.linkKey === selection.linkKey
      ) {
        return prev;
      }
      return { ...prev, textSelection: selection };
    });
  }, []);

  const clearTextSelection = useCallback(() => {
    setSelectionState(prev => {
      const t = prev.textSelection;
      if (!t.hasTextSelection && t.selectedText === '' && !t.isInsideLink &&
          t.existingHref === undefined && t.linkKey === undefined) return prev;
      return {
        ...prev,
        textSelection: {
          hasTextSelection: false,
          selectedText: '',
          isInsideLink: false,
        },
      };
    });
  }, []);

  // --------------- Scanned Elements Callbacks ---------------

  const setScannedElements = useCallback((elements: ScannedElement[]) => {
    // No-op rescan: identical content (incl. rects) ⇒ publish nothing.
    // Keeping the old identity skips the treeNodes/scannedByKey rebuilds and
    // every ScannedElementsContext consumer re-render.
    if (scannedElementsShallowEqual(scannedElementsRef.current, elements)) return;

    const structureChanged = !scannedElementsShallowEqual(scannedElementsRef.current, elements, false);
    const previousElements = scannedElementsRef.current;
    const previousByKey = scannedByKeyRef.current;
    // Refresh an actual card's read-only identity on href-only HMR. A legacy
    // clicked clone may share its template key but carry different links;
    // that click must not be replaced by the first template's scan.
    setSelectionState(prev => {
      if (!prev.selectedKey) return prev;
      const next = elements.find(el => el.key === prev.selectedKey);
      const previous = previousByKey.get(prev.selectedKey);
      if (next && prev.selectedPostSlug && prev.selectedPostSlug !== previous?.postSlug) return prev;
      const paths = next?.postLinkPaths ?? null;
      return samePostLinkPaths(prev.selectedPostLinkPaths, paths) ? prev : { ...prev, selectedPostLinkPaths: paths };
    });

    // Update ref synchronously for cross-context access
    scannedElementsRef.current = elements;
    noteScan(elements);
    const map = new Map<string, ScannedElement>();
    for (const el of elements) map.set(el.key, el);
    scannedByKeyRef.current = map;
    geometryStore.replace(elements);
    if (!structureChanged) return;

    // While ≥2 are selected, members follow same-line key shifts (a class save
    // lengthens one element's attribute and moves every later element on that
    // source line — store/multiSelect.ts relinkSameLine, design ledger E7).
    if (additionalSelectionsRef.current.length > 0) {
      const primary = selectedKeyRef.current;
      const extras = additionalSelectionsRef.current;
      const renames = relinkSameLine([primary, ...extras.map(e => e.key)].filter((k): k is string => !!k), previousElements, elements);
      if (renames.size > 0) {
        const nextPrimary = primary && renames.has(primary) ? renames.get(primary)! : primary;
        const nextExtras = extras.map(e => (renames.has(e.key) ? { ...e, key: renames.get(e.key)! } : e));
        selectedKeyRef.current = nextPrimary;
        additionalSelectionsRef.current = nextExtras;
        setSelectionState(prev => ({
          ...prev,
          selectedKey: nextPrimary,
          selectedSourceLocation: nextPrimary !== primary
            ? map.get(nextPrimary!)?.sourceLocation ?? prev.selectedSourceLocation : prev.selectedSourceLocation,
          additionalSelections: nextExtras,
        }));
      }
    }

    setScannedState(prev => {
      let newExpandedNodes = prev.expandedNodes;

      // Auto-expand root nodes on initial load
      if (!initialExpandDoneRef.current && elements.length > 0) {
        initialExpandDoneRef.current = true;
        const rootKeys = elements
          .filter(el => el.parentKey === null)
          .map(el => el.key);
        newExpandedNodes = new Set(rootKeys);
      }

      // Auto-expand drawn parent elements so nested drawn children are visible.
      // Drawn elements (key starts with 'drawn-') that have children should always
      // be expanded — users expect to see nesting immediately after drawing.
      const drawnParentKeys = new Set<string>();
      for (const el of elements) {
        if (el.parentKey?.startsWith('drawn-')) {
          drawnParentKeys.add(el.parentKey);
        }
      }
      if (drawnParentKeys.size > 0) {
        let changed = false;
        const merged = new Set(newExpandedNodes);
        for (const k of drawnParentKeys) {
          if (!merged.has(k)) {
            merged.add(k);
            changed = true;
          }
        }
        if (changed) newExpandedNodes = merged;
      }

      return {
        ...prev,
        scannedElements: elements,
        expandedNodes: newExpandedNodes
      };
    });
  }, [geometryStore]);

  const updateScannedElementRects = useCallback((rects: Array<{ key: string; rect: ElementRect }>) => {
    const rectMap = new Map(rects.map(({ key, rect }) => [key, rect]));
    let changed = false;
    const updatedElements = scannedElementsRef.current.map(el => {
      const rect = rectMap.get(el.key);
      if (!rect || sameElementRect(el.rect, rect)) return el;
      changed = true;
      return { ...el, rect: Object.freeze({ ...rect }) };
    });
    if (!changed) return;
    // Both action refs are fresh BEFORE any geometry subscriber can run.
    scannedElementsRef.current = updatedElements;
    scannedByKeyRef.current = new Map(updatedElements.map(el => [el.key, el]));
    geometryStore.update(updatedElements.filter(el => rectMap.has(el.key)));
  }, [geometryStore]);

  const toggleExpand = useCallback((key: string) => {
    setScannedState(prev => {
      const next = new Set(prev.expandedNodes);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return { ...prev, expandedNodes: next };
    });
  }, []);

  const expandNodes = useCallback((keys: string[]) => {
    setScannedState(prev => {
      const next = new Set(prev.expandedNodes);
      keys.forEach(key => next.add(key));
      return { ...prev, expandedNodes: next };
    });
  }, []);

  const collapseAll = useCallback(() => {
    setScannedState(prev => ({ ...prev, expandedNodes: new Set<string>() }));
  }, []);

  // --------------- Effects ---------------

  // Hook text selection and edit mode to test helper for E2E testing
  useEffect(() => {
    if (typeof window !== 'undefined' && window.__STARQUIX_TEST__) {
      window.__STARQUIX_TEST__._setTextSelectionFn = setTextSelection;
      window.__STARQUIX_TEST__._clearTextSelectionFn = clearTextSelection;
      window.__STARQUIX_TEST__._getTextSelectionStateFn = () => selectionState.textSelection;
      window.__STARQUIX_TEST__._enterEditModeFn = enterEditMode;
      window.__STARQUIX_TEST__._exitEditModeFn = exitEditMode;
      window.__STARQUIX_TEST__._isEditingTextFn = () => isEditingText;
      window.__STARQUIX_TEST__._getSelectedElementIdFn = () => selectedElementIdRef.current;
    }
  }, [setTextSelection, clearTextSelection, selectionState.textSelection, enterEditMode, exitEditMode, isEditingText]);

  // Compute tree nodes when scanned elements change
  const treeNodes = useMemo(
    () => {
      recordEditorMetric('tree-build');
      return buildTreeFromScannedElements(scannedState.scannedElements);
    },
    [scannedState.scannedElements]
  );

  // Mirror treeNodes for non-reactive consumers (ScannedRefsContext)
  const treeNodesRef = useRef<TreeNode[]>(treeNodes);
  treeNodesRef.current = treeNodes;

  // Created once — never re-renders its consumers (see ScannedRefsContext)
  // Created once — never re-renders its consumers (see SelectionRefsContext)
  const selectionRefsValue = useMemo<SelectionRefsContextValue>(
    () => ({ selectedKeyRef, selectedElementIdRef, contextKeyRef }),
    [selectedElementIdRef]
  );

  const scannedRefsValue = useMemo<ScannedRefsContextValue>(
    () => ({ scannedElementsRef, scannedByKeyRef, treeNodesRef }),
    []
  );

  // Shared O(1) lookup so DesignBar / ElementsTree / etc. don't each rebuild it.
  const scannedByKey = useMemo(() => {
    const map = new Map<string, ScannedElement>();
    for (const el of scannedState.scannedElements) map.set(el.key, el);
    return map;
  }, [scannedState.scannedElements]);

  // Listen for source location shifts and update selected key if needed
  useEffect(() => {
    const handleSourceLocationShift = (event: MessageEvent) => {
      if (!fromOwnFrameOrSelf(event)) return;

      const data = event.data;
      if (!data || data.type !== 'SOURCE_LOCATION_SHIFTED') return;

      const { oldKey, newKey, sourceLocation } = data.payload as {
        oldKey: string;
        newKey: string;
        sourceLocation?: SourceLocation;
      };

      if (selectedKeyRef.current !== oldKey) return;
      selectedKeyRef.current = newKey;
      setSelectionState(prev => ({
        ...prev,
        selectedKey: newKey,
        selectedSourceLocation: sourceLocation || prev.selectedSourceLocation
      }));
    };

    window.addEventListener('message', handleSourceLocationShift);
    return () => window.removeEventListener('message', handleSourceLocationShift);
  }, []);

  // High-frequency selection rect context (changes on every rect update, only consumed by overlays)
  const rectActionsValue = useMemo(() => ({ updateSelectionRect, getSelectedRect }), [updateSelectionRect, getSelectedRect]);
  const rectHoverValue = useMemo<RectHoverContextValue>(
    () => ({
      selectedRect,
      updateSelectionRect,
      getSelectedRect,
    }),
    [selectedRect, updateSelectionRect]
  );

  // --------------- Context Values (memoized separately) ---------------

  const selectionValue = useMemo<SelectionContextValue>(
    () => ({
      ...selectionState,
      selectedElementId: deriveSelectedElementId(selectionState.selectedKey),
      isEditingText,
      isLinkInteracting,
      isLinkInteractingRef,
      selectedKeyRef,
      selectedElementIdRef,
      contextKeyRef,
      setLinkInteracting: handleSetLinkInteracting,
      enterEditMode,
      exitEditMode,
      select,
      patchSelection,
      clearSelection,
      addAdditionalSelection,
      removeAdditionalSelection,
      clearAdditionalSelections,
      toggleInSelection,
      setSelectionDocScope,
      enterContext,
      exitContext,
      resetContext,
      setTextSelection,
      clearTextSelection,
      updateBgImagePreview,
      updateImagePreview,
      reparentDragKey,
      setReparentDragKey,
    }),
    [selectionState, isEditingText, isLinkInteracting, handleSetLinkInteracting, enterEditMode, exitEditMode, select,
      patchSelection, clearSelection, addAdditionalSelection, removeAdditionalSelection, clearAdditionalSelections, toggleInSelection, setSelectionDocScope, enterContext, exitContext, resetContext, setTextSelection, clearTextSelection, updateBgImagePreview, updateImagePreview, reparentDragKey]
  );

  const scannedValue = useMemo<ScannedElementsContextValue>(
    () => ({
      ...scannedState,
      treeNodes,
      scannedByKey,
      setScannedElements,
      updateScannedElementRects,
      toggleExpand,
      expandNodes,
      collapseAll,
    }),
    [scannedState, treeNodes, scannedByKey, setScannedElements, updateScannedElementRects, toggleExpand, expandNodes, collapseAll]
  );

  return (
    <ElementGeometryContext.Provider value={geometryStore}>
    <RectActionsContext.Provider value={rectActionsValue}>
    <RectHoverContext.Provider value={rectHoverValue}>
      <SelectionContext.Provider value={selectionValue}>
        <ScannedElementsContext.Provider value={scannedValue}>
          <ScannedRefsContext.Provider value={scannedRefsValue}>
            <SelectionRefsContext.Provider value={selectionRefsValue}>
              {children}
            </SelectionRefsContext.Provider>
          </ScannedRefsContext.Provider>
        </ScannedElementsContext.Provider>
      </SelectionContext.Provider>
    </RectHoverContext.Provider>
    </RectActionsContext.Provider>
    </ElementGeometryContext.Provider>
  );
};

// ============================================================================
// Hooks
// ============================================================================

/**
 * Access the full SelectionContext (selection state + actions).
 * Only subscribes to SelectionContext — does NOT re-render on scannedElements changes.
 * Use when you need selection actions (select, enterContext, etc.) without scannedElements.
 */
export const useSelectionContext = (): SelectionContextValue => {
  const context = useContext(SelectionContext);
  if (!context) {
    throw new Error('useSelectionContext must be used within a SelectionProvider');
  }
  return context;
};

/** The selected element's rendered rect (canvas CSS px), or null — also outside a provider (panels under test). */
export const useSelectedRectOptional = (): ElementRect | null => useContext(RectHoverContext)?.selectedRect ?? null;

/**
 * Access high-frequency selection rect state without triggering re-renders of the main context.
 * Use this instead of useSelection() when you only need selectedRect or updateSelectionRect.
 */
export const useRectHover = (): RectHoverContextValue => {
  const context = useContext(RectHoverContext);
  if (!context) {
    throw new Error('useRectHover must be used within a SelectionProvider');
  }
  return context;
};

/**
 * Get selection info for DesignBar.
 * Only subscribes to SelectionContext — does NOT re-render on scannedElements changes.
 */
export const useSelectedElement = () => {
  const context = useContext(SelectionContext);
  if (!context) {
    throw new Error('useSelectedElement must be used within a SelectionProvider');
  }

  return {
    key: context.selectedKey,
    sourceLocation: context.selectedSourceLocation,
    tagName: context.selectedTagName,
    classes: context.selectedClasses,
    computedStyles: context.selectedComputedStyles,
    parentDisplay: context.selectedParentDisplay,
    imageSrc: context.selectedImageSrc,
    mediaFill: context.selectedMediaFill,
    hasElementChildren: context.selectedHasElementChildren,
    boundAssetPath: context.selectedBoundAssetPath,
    imageComponentIndex: context.selectedImageComponentIndex,
    ownerComponentFile: context.selectedOwnerComponentFile,
    imageAlt: context.selectedImageAlt,
    imagePreviewDataUrl: context.selectedImagePreviewDataUrl,
    postSlug: context.selectedPostSlug,
    postLinkPaths: context.selectedPostLinkPaths,
    hasSelection: context.selectedKey !== null,
    isEditingText: context.isEditingText,
  };
};

/**
 * Structural scan snapshot for ElementsTree and metadata consumers.
 * Rects here are not live: use useElementGeometry for paint, or fresh refs in actions.
 * Only subscribes to ScannedElementsContext — does NOT re-render on selection changes.
 */
export const useScannedElements = () => {
  const context = useContext(ScannedElementsContext);
  if (!context) {
    throw new Error('useScannedElements must be used within a SelectionProvider');
  }
  return context;
};

/**
 * Non-reactive access to scanned elements / tree nodes via stable refs.
 * NEVER re-renders the consumer on scans — read `.current` at event or
 * callback time. Use this instead of useScannedElements()/useSelection()
 * when the component only reads scan data inside handlers (Editor,
 * useKeyboardShortcuts). Reading `.current` during render is a bug —
 * the component would not update when the scan changes.
 */
export const useScannedElementsRef = (): ScannedRefsContextValue => {
  const context = useContext(ScannedRefsContext);
  if (!context) {
    throw new Error('useScannedElementsRef must be used within a SelectionProvider');
  }
  return context;
};

/**
 * Non-reactive access to the selection via stable refs. NEVER re-renders the
 * consumer on selection changes — read `.current` at event or callback time.
 * Use instead of useSelectionContext() when the component only reads selection
 * inside handlers (Editor's picker-replace flow). Reading `.current` during
 * render is a bug — the component would not update when selection changes.
 */
export const useSelectionRefs = (): SelectionRefsContextValue => {
  const context = useContext(SelectionRefsContext);
  if (!context) {
    throw new Error('useSelectionRefs must be used within a SelectionProvider');
  }
  return context;
};

/**
 * Get text selection state for link editing.
 * Only subscribes to SelectionContext.
 */
export const useTextSelection = () => {
  const context = useContext(SelectionContext);
  if (!context) {
    throw new Error('useTextSelection must be used within a SelectionProvider');
  }
  return {
    ...context.textSelection,
    setTextSelection: context.setTextSelection,
    clearTextSelection: context.clearTextSelection,
    isLinkInteracting: context.isLinkInteracting,
    isLinkInteractingRef: context.isLinkInteractingRef,
    setLinkInteracting: context.setLinkInteracting,
  };
};

/** Stable rect actions; does not subscribe the iframe host to rect data. */
export function useRectActions(): Pick<RectHoverContextValue, 'updateSelectionRect' | 'getSelectedRect'> {
  const context = useContext(RectActionsContext);
  if (!context) throw new Error('useRectActions must be used within a SelectionProvider');
  return context;
}

export function useElementGeometry(key: string | null): ElementRect | null {
  const store = useContext(ElementGeometryContext);
  if (!store) throw new Error('useElementGeometry must be used within a SelectionProvider');
  const subscribe = useCallback((listener: () => void) => key === null ? () => {} : store.subscribe(key, listener), [store, key]);
  const getSnapshot = useCallback(() => key === null ? null : store.get(key), [store, key]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Atomic, cached snapshot for a derived overlay that spans several keyed rects. */
export function useElementGeometries(keys: readonly string[]): readonly (ElementRect | null)[] {
  const store = useContext(ElementGeometryContext);
  if (!store) throw new Error('useElementGeometries must be used within a SelectionProvider');
  const keySignature = JSON.stringify(keys);
  const subscription = useMemo(() => {
    const subscribedKeys: string[] = JSON.parse(keySignature);
    let snapshot: (ElementRect | null)[] = [];
    return {
      subscribe(listener: () => void) {
        const off = subscribedKeys.map(key => store.subscribe(key, listener));
        return () => off.forEach(unsubscribe => unsubscribe());
      },
      getSnapshot() {
        const next = subscribedKeys.map(key => store.get(key));
        if (snapshot.length !== next.length || next.some((rect, index) => rect !== snapshot[index])) snapshot = next;
        return snapshot;
      },
    };
  }, [store, keySignature]);
  return useSyncExternalStore(subscription.subscribe, subscription.getSnapshot, subscription.getSnapshot);
}
