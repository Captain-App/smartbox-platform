import type { Sandbox } from '@cloudflare/sandbox';
import { MOLTBOT_PORT } from '../config';
import { deriveUserGatewayToken, getGatewayMasterToken } from '../gateway';
import type { AuthenticatedUser, MoltbotEnv } from '../types';

export interface ProxyHttpOptions {
  sandbox: Sandbox;
  request: Request;
  env: MoltbotEnv;
  user?: AuthenticatedUser;
}

/**
 * Proxy an HTTP request to the container gateway.
 * Handles header rewriting and gateway token injection for HTML responses.
 */
export async function proxyHttp(options: ProxyHttpOptions): Promise<Response> {
  const { sandbox, request, env, user } = options;
  const url = new URL(request.url);

  console.log('[HTTP] Proxying:', url.pathname + url.search);
  const httpResponse = await sandbox.containerFetch(request, MOLTBOT_PORT);
  console.log('[HTTP] Response status:', httpResponse.status);

  // Add debug header to verify worker handled the request
  const newHeaders = new Headers(httpResponse.headers);
  newHeaders.set('X-Worker-Debug', 'proxy-to-moltbot');
  newHeaders.set('X-Debug-Path', url.pathname);

  // For HTML responses, inject gateway token and logout button
  const contentType = httpResponse.headers.get('content-type') || '';
  if (contentType.includes('text/html') && user) {
    const html = await httpResponse.text();

    // Derive the gateway token for this user
    let gatewayToken = '';
    const masterToken = getGatewayMasterToken(env);
    if (masterToken) {
      gatewayToken = await deriveUserGatewayToken(masterToken, user.id);
    }

    const injectedScript = `
<script>
// Gateway token for WebSocket authentication - store in localStorage for Control UI
window.__GATEWAY_TOKEN__ = '${gatewayToken}';
if ('${gatewayToken}') {
  // Store token in localStorage where Control UI looks for it
  try {
    localStorage.setItem('openclaw-gateway-token', '${gatewayToken}');
    localStorage.setItem('gateway-token', '${gatewayToken}');
    // Also try the Control UI's config storage format (both old and new keys for compat)
    var config = JSON.parse(localStorage.getItem('openclaw-control-ui-config') || localStorage.getItem('clawdbot-control-ui-config') || '{}');
    config.gatewayToken = '${gatewayToken}';
    config.token = '${gatewayToken}';
    localStorage.setItem('openclaw-control-ui-config', JSON.stringify(config));
    localStorage.setItem('clawdbot-control-ui-config', JSON.stringify(config)); // legacy compat
    console.log('[Injected] Set gateway token in localStorage');
  } catch(e) { console.error('[Injected] localStorage error:', e); }
}

// Logout button
(function() {
  var btn = document.createElement('a');
  btn.href = '/logout';
  btn.innerHTML = 'Logout (${user.email || 'User'})';
  btn.style.cssText = 'position:fixed;top:10px;right:10px;z-index:99999;background:#1a1a2e;color:#f97316;padding:8px 16px;border-radius:6px;text-decoration:none;font-family:system-ui,sans-serif;font-size:13px;border:1px solid #f97316;';
  btn.onmouseover = function() { this.style.background='#f97316'; this.style.color='#fff'; };
  btn.onmouseout = function() { this.style.background='#1a1a2e'; this.style.color='#f97316'; };
  document.addEventListener('DOMContentLoaded', function() { document.body.appendChild(btn); });
  if (document.body) document.body.appendChild(btn);
})();

// Emergency reset button
(function() {
  var btn = document.createElement('button');
  btn.innerHTML = 'Reset';
  btn.title = 'Emergency container reset';
  btn.style.cssText = 'position:fixed;top:10px;right:200px;z-index:99999;background:#1a1a2e;color:#ef4444;padding:8px 16px;border-radius:6px;font-family:system-ui,sans-serif;font-size:13px;border:1px solid #ef4444;cursor:pointer;';
  btn.onmouseover = function() { this.style.background='#ef4444'; this.style.color='#fff'; };
  btn.onmouseout = function() { this.style.background='#1a1a2e'; this.style.color='#ef4444'; };
  btn.onclick = async function() {
    if (!confirm('Reset container? This will restart the gateway.')) return;
    btn.disabled = true;
    btn.innerHTML = 'Resetting...';
    try {
      var res = await fetch('/emergency-reset');
      var data = await res.json();
      if (data.success) {
        btn.innerHTML = 'Done!';
        setTimeout(function() { window.location.reload(); }, 2000);
      } else {
        alert('Reset failed: ' + (data.error || 'Unknown error'));
        btn.disabled = false;
        btn.innerHTML = 'Reset';
      }
    } catch(e) {
      alert('Reset failed: ' + e.message);
      btn.disabled = false;
      btn.innerHTML = 'Reset';
    }
  };
  document.addEventListener('DOMContentLoaded', function() { document.body.appendChild(btn); });
  if (document.body) document.body.appendChild(btn);
})();

// Patch WebSocket to auto-add token to gateway connections
(function() {
  var OriginalWebSocket = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    var token = window.__GATEWAY_TOKEN__;
    if (token && url && (url.includes('://') || url.startsWith('/'))) {
      try {
        var wsUrl = new URL(url, window.location.origin);
        // Only add token if not already present and it's a local connection
        if (!wsUrl.searchParams.has('token') && wsUrl.host === window.location.host) {
          wsUrl.searchParams.set('token', token);
          url = wsUrl.toString();
          console.log('[WS-Patch] Added token to WebSocket URL');
        }
      } catch(e) {
        console.error('[WS-Patch] Error:', e);
      }
    }
    return new OriginalWebSocket(url, protocols);
  };
  window.WebSocket.prototype = OriginalWebSocket.prototype;
  window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  window.WebSocket.OPEN = OriginalWebSocket.OPEN;
  window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
  window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;
})();
</script>`;
    // Inject before </head> or </body> or at end
    let modifiedHtml = html;
    if (html.includes('</head>')) {
      modifiedHtml = html.replace('</head>', injectedScript + '</head>');
    } else if (html.includes('</body>')) {
      modifiedHtml = html.replace('</body>', injectedScript + '</body>');
    } else {
      modifiedHtml = html + injectedScript;
    }
    newHeaders.delete('content-length');
    return new Response(modifiedHtml, {
      status: httpResponse.status,
      statusText: httpResponse.statusText,
      headers: newHeaders,
    });
  }

  return new Response(httpResponse.body, {
    status: httpResponse.status,
    statusText: httpResponse.statusText,
    headers: newHeaders,
  });
}
