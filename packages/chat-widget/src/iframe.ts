/**
 * @oxpulse/chat-widget — iframe embed entry point.
 *
 * This module is the entry point for the sandboxed iframe loaded at
 * `${baseUrl}/widget/embed.html`. It:
 *   1. Reads `?origin=` query param and initialises postMessage security (M1+M2).
 *   2. Listens for the 'init' postMessage from the parent page.
 *   3. Runs the origin check with the received config.
 *   4. Mounts the widget inside the iframe's DOM.
 *   5. Relays widget events back to the parent via postMessage.
 *
 * The iframe is always sandboxed (allow-scripts allow-same-origin) —
 * the parent element.ts enforces this via the sandbox attribute.
 */

import { sendToParent, setParentOrigin, onParentMessage } from './postmessage.js';
import { checkOrigin } from './bootstrap.js';
import { WidgetError, type WidgetConfig } from './types.js';

const WIDGET_VERSION = typeof __WIDGET_VERSION__ !== 'undefined' ? __WIDGET_VERSION__ : '0.0.0-dev';

/**
 * Bootstrap the iframe-mode widget.
 *
 * Waits for the 'init' message from the parent, then:
 * - Runs origin check
 * - Renders placeholder (W2.2 will mount real UI)
 * - Relays events to parent
 */
export function initIframe(): void {
  // Guard: only run in a browser context
  if (typeof window === 'undefined') return;

  // M1+M2: extract parent origin from URL and wire postMessage security
  const parentOrigin = new URLSearchParams(location.search).get('origin');
  if (parentOrigin) {
    setParentOrigin(parentOrigin);
  } else {
    // eslint-disable-next-line no-console
    console.warn('[oxpulse-chat-widget] iframe loaded without ?origin= query param — postMessage security degraded');
  }

  const unsubscribe = onParentMessage(async (msg) => {
    if (msg.type !== 'init') return;

    // Only handle the first init message
    unsubscribe();

    const config: WidgetConfig = msg.config;

    try {
      await checkOrigin(config);
    } catch (err) {
      const widgetErr =
        err instanceof WidgetError
          ? err
          : new WidgetError('UNKNOWN', String(err));
      sendToParent({
        type: 'error',
        code: widgetErr.code,
        message: widgetErr.message,
      });
      renderError(widgetErr.message);
      return;
    }

    // Origin check passed
    // eslint-disable-next-line no-console
    console.log(`OxpulseChatWidget ${WIDGET_VERSION} iframe initialized`);

    // Render placeholder (W2.2: real UI goes here)
    renderPlaceholder('Chat loading…');

    // Notify parent that we're ready
    sendToParent({ type: 'ready', roomId: config.roomId });

    // Report initial height
    const height = document.documentElement.scrollHeight || 400;
    sendToParent({ type: 'resize', height });

    // Listen for subsequent parent messages (token refresh, theme)
    const unsubNext = onParentMessage((next) => {
      if (next.type === 'refresh-token') {
        // W2.2: reconnect logic goes here
        // For now just acknowledge
      } else if (next.type === 'set-theme') {
        document.documentElement.dataset['theme'] = next.theme;
      }
    });

    // Clean up on page unload
    window.addEventListener('unload', unsubNext, { once: true });
  });
}

function renderPlaceholder(text: string): void {
  const div = document.createElement('div');
  div.style.cssText = 'font-family:sans-serif;padding:16px;color:#666;';
  div.textContent = text;
  document.body.appendChild(div);
}

function renderError(message: string): void {
  const div = document.createElement('div');
  div.style.cssText = 'font-family:sans-serif;padding:16px;color:#c00;';
  div.textContent = `OxPulse Chat error: ${message}`;
  document.body.appendChild(div);
}

// Auto-init when this file is loaded as the iframe entry point
initIframe();
