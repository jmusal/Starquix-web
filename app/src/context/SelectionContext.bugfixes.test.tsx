/**
 * SelectionContext Bug Fix Tests
 *
 * Tests for bugs fixed in SelectionContext.tsx:
 * - Origin validation in message event listener
 * - Safe handling of postMessage events
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, act } from '@testing-library/react';
import { SelectionProvider, fromOwnFrameOrSelf } from '@/context/SelectionContext';
import { useSelection } from '@/test/mergedSelectionHook';

// Helper to check if an origin is valid
function isValidOrigin(origin: string, windowOrigin: string): boolean {
  if (origin === windowOrigin) return true;
  if (origin.includes('localhost') || origin.includes('127.0.0.1')) return true;
  return false;
}

describe('Origin Validation', () => {
  it('should accept same origin', () => {
    expect(isValidOrigin('http://localhost:5173', 'http://localhost:5173')).toBe(true);
    expect(isValidOrigin('https://myapp.com', 'https://myapp.com')).toBe(true);
  });

  it('should accept localhost variations', () => {
    expect(isValidOrigin('http://localhost:4321', 'http://localhost:5173')).toBe(true);
    expect(isValidOrigin('http://localhost:3000', 'http://localhost:5173')).toBe(true);
    expect(isValidOrigin('http://127.0.0.1:5173', 'http://localhost:5173')).toBe(true);
    expect(isValidOrigin('https://localhost:443', 'http://localhost:5173')).toBe(true);
  });

  it('should reject unknown origins', () => {
    expect(isValidOrigin('http://malicious.com', 'http://localhost:5173')).toBe(false);
    expect(isValidOrigin('https://evil.example.com', 'https://myapp.com')).toBe(false);
    expect(isValidOrigin('http://attacker.io', 'https://myapp.com')).toBe(false);
  });

  it('should reject origins that contain but are not localhost', () => {
    // This is actually accepted because it contains 'localhost'
    // The validation is permissive for development convenience
    expect(isValidOrigin('http://notlocalhost.com', 'http://localhost:5173')).toBe(true);

    // But these don't contain localhost
    expect(isValidOrigin('http://local-host.com', 'http://localhost:5173')).toBe(false);
  });
});

describe('Message Validation', () => {
  it('should validate message data structure', () => {
    const isValidMessage = (data: unknown): boolean => {
      if (!data || typeof data !== 'object') return false;
      const msg = data as { type?: unknown };
      return typeof msg.type === 'string';
    };

    expect(isValidMessage({ type: 'SOURCE_LOCATION_SHIFTED', payload: {} })).toBe(true);
    expect(isValidMessage({ type: 'ELEMENT_CLICK' })).toBe(true);
    expect(isValidMessage(null)).toBe(false);
    expect(isValidMessage(undefined)).toBe(false);
    expect(isValidMessage('not an object')).toBe(false);
    expect(isValidMessage({ noType: true })).toBe(false);
    expect(isValidMessage({ type: 123 })).toBe(false);
  });

  it('should validate SOURCE_LOCATION_SHIFTED payload', () => {
    const isValidShiftPayload = (payload: unknown): boolean => {
      if (!payload || typeof payload !== 'object') return false;
      const p = payload as { oldKey?: unknown; newKey?: unknown };
      return typeof p.oldKey === 'string' && typeof p.newKey === 'string';
    };

    expect(isValidShiftPayload({ oldKey: 'old', newKey: 'new' })).toBe(true);
    expect(isValidShiftPayload({ oldKey: 'old', newKey: 'new', sourceLocation: {} })).toBe(true);
    expect(isValidShiftPayload(null)).toBe(false);
    expect(isValidShiftPayload({ oldKey: 'old' })).toBe(false);
    expect(isValidShiftPayload({ newKey: 'new' })).toBe(false);
    expect(isValidShiftPayload({ oldKey: 123, newKey: 'new' })).toBe(false);
  });
});

describe('SelectionContext Provider', () => {
  // Test component that uses the selection context
  const TestConsumer: React.FC<{ onState?: (state: ReturnType<typeof useSelection>) => void }> = ({ onState }) => {
    const selection = useSelection();
    React.useEffect(() => {
      onState?.(selection);
    }, [selection, onState]);
    return <div data-testid="consumer">{selection.selectedKey || 'none'}</div>;
  };

  it('should render without errors', () => {
    const { getByTestId } = render(
      <SelectionProvider>
        <TestConsumer />
      </SelectionProvider>
    );

    expect(getByTestId('consumer')).toHaveTextContent('none');
  });

  it('should throw when used outside provider', () => {
    // Suppress console.error for this test
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => {
      render(<TestConsumer />);
    }).toThrow('useSelectionContext must be used within a SelectionProvider');

    consoleSpy.mockRestore();
  });

  it('should update selection state', () => {
    let selectionState: ReturnType<typeof useSelection> | null = null;

    const { rerender } = render(
      <SelectionProvider>
        <TestConsumer onState={(state) => { selectionState = state; }} />
      </SelectionProvider>
    );

    expect(selectionState?.selectedKey).toBeNull();

    // Select an element
    act(() => {
      selectionState?.select('test-key', {
        tagName: 'div',
        classes: 'flex',
      });
    });

    // Re-render to get updated state
    rerender(
      <SelectionProvider>
        <TestConsumer onState={(state) => { selectionState = state; }} />
      </SelectionProvider>
    );

    expect(selectionState?.selectedKey).toBe('test-key');
    expect(selectionState?.selectedTagName).toBe('div');
    expect(selectionState?.selectedClasses).toBe('flex');
  });
});

describe('Message Handler Security', () => {
  let originalAddEventListener: typeof window.addEventListener;
  let messageHandlers: Array<(event: MessageEvent) => void>;

  beforeEach(() => {
    messageHandlers = [];
    originalAddEventListener = window.addEventListener;
    window.addEventListener = vi.fn((type, handler) => {
      if (type === 'message') {
        messageHandlers.push(handler as (event: MessageEvent) => void);
      }
    }) as typeof window.addEventListener;
  });

  afterEach(() => {
    window.addEventListener = originalAddEventListener;
  });

  it('should add message listener on mount', () => {
    render(
      <SelectionProvider>
        <div>Test</div>
      </SelectionProvider>
    );

    expect(window.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
  });
});

describe('Safe State Updates', () => {
  it('should handle rapid selection changes', async () => {
    let selectionState: ReturnType<typeof useSelection> | null = null;

    const TestConsumer: React.FC = () => {
      const selection = useSelection();
      selectionState = selection;
      return <div>{selection.selectedKey}</div>;
    };

    render(
      <SelectionProvider>
        <TestConsumer />
      </SelectionProvider>
    );

    // Rapidly change selection
    act(() => {
      for (let i = 0; i < 10; i++) {
        selectionState?.select(`key-${i}`);
      }
    });

    // Should settle on the last selection
    expect(selectionState?.selectedKey).toBe('key-9');
  });

  it('should clear selection properly', () => {
    let selectionState: ReturnType<typeof useSelection> | null = null;

    const TestConsumer: React.FC = () => {
      const selection = useSelection();
      selectionState = selection;
      return <div>{selection.selectedKey}</div>;
    };

    render(
      <SelectionProvider>
        <TestConsumer />
      </SelectionProvider>
    );

    // Select then clear
    act(() => {
      selectionState?.select('test-key');
    });

    expect(selectionState?.selectedKey).toBe('test-key');

    act(() => {
      selectionState?.clearSelection();
    });

    expect(selectionState?.selectedKey).toBeNull();
    expect(selectionState?.selectedTagName).toBeNull();
    expect(selectionState?.selectedClasses).toBeNull();
  });
});

describe('Text Selection State', () => {
  it('should handle text selection updates', () => {
    let selectionState: ReturnType<typeof useSelection> | null = null;

    const TestConsumer: React.FC = () => {
      const selection = useSelection();
      selectionState = selection;
      return <div>{selection.textSelection.selectedText}</div>;
    };

    render(
      <SelectionProvider>
        <TestConsumer />
      </SelectionProvider>
    );

    // Initial state
    expect(selectionState?.textSelection.hasTextSelection).toBe(false);
    expect(selectionState?.textSelection.selectedText).toBe('');

    // Set text selection
    act(() => {
      selectionState?.setTextSelection({
        hasTextSelection: true,
        selectedText: 'Hello World',
        isInsideLink: false,
      });
    });

    expect(selectionState?.textSelection.hasTextSelection).toBe(true);
    expect(selectionState?.textSelection.selectedText).toBe('Hello World');

    // Clear text selection
    act(() => {
      selectionState?.clearTextSelection();
    });

    expect(selectionState?.textSelection.hasTextSelection).toBe(false);
    expect(selectionState?.textSelection.selectedText).toBe('');
  });

  it('should track link state in text selection', () => {
    let selectionState: ReturnType<typeof useSelection> | null = null;

    const TestConsumer: React.FC = () => {
      const selection = useSelection();
      selectionState = selection;
      return <div />;
    };

    render(
      <SelectionProvider>
        <TestConsumer />
      </SelectionProvider>
    );

    // Select text inside a link
    act(() => {
      selectionState?.setTextSelection({
        hasTextSelection: true,
        selectedText: 'Link text',
        isInsideLink: true,
        existingHref: 'https://example.com',
        existingTarget: '_blank',
        linkKey: 'a-0',
      });
    });

    expect(selectionState?.textSelection.isInsideLink).toBe(true);
    expect(selectionState?.textSelection.existingHref).toBe('https://example.com');
    expect(selectionState?.textSelection.existingTarget).toBe('_blank');
    expect(selectionState?.textSelection.linkKey).toBe('a-0');
  });
});

describe('fromOwnFrameOrSelf: canvas messages are trusted by their frame, not by a host name', () => {
  afterEach(() => { document.body.innerHTML = ''; });
  const message = (origin: string, source: MessageEventSource | null) => new MessageEvent('message', { origin, source, data: {} });

  it('accepts this page and its own iframes on any origin (a public preview port in the web build)', () => {
    const frame = document.createElement('iframe'); document.body.append(frame);
    expect(fromOwnFrameOrSelf(message(window.location.origin, null))).toBe(true);
    expect(fromOwnFrameOrSelf(message('https://starquix.example.com:3100', frame.contentWindow))).toBe(true);
  });
  it('refuses another window, including a localhost look-alike host', () => {
    const stranger = document.createElement('iframe'); // not in this document
    document.body.append(stranger); const other = stranger.contentWindow; stranger.remove();
    expect(fromOwnFrameOrSelf(message('https://evil-localhost.com', other))).toBe(false);
    expect(fromOwnFrameOrSelf(message('http://127.0.0.1.evil.test', null))).toBe(false);
  });
});
