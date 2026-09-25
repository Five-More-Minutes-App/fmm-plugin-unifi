# Security

This plugin holds the keys to two things: a **Five More Minutes key** that can only *read* one computer's
state, and a **UniFi administrator account**. It is written so that neither can be misused through it.

## What it can and cannot do

- **In Five More Minutes**: `state:read` on one computer. It cannot start, extend, stop or cancel time, cannot see other computers or the household, and the key only works from your local network. If the key leaked, it would reveal whether one computer is locked, to someone already on your network.
- **In UniFi**: it can block and unblock a client by MAC address, and list clients. Those are the only calls in the code (`src/unifi.js`): no method takes a command, path or body from a caller, and the address is checked to be a real device address (not empty, not broadcast, not a group address) immediately before it is sent. The UniFi account itself can do more, which is why it should be a separate account you can delete.

## Secrets

- Read once at start-up, from the environment or a file (`*_FILE`). Held in a wrapper that prints as `[hidden]` in logs, errors, JSON and `console.log`; the only way to the value is an explicit call. Logging additionally scrubs any secret it was given.
- Never written to disk by the plugin, never returned by the settings page or its API.
- The Five More Minutes key is validated for shape before use, the client refuses redirects (it would send the key wherever the redirect pointed), and it never appears in an error message.
- Docker: runs as the unprivileged `node` user, read-only root file system, all Linux capabilities dropped, `no-new-privileges`.

## The UniFi connection

The UniFi password is sent only over a connection whose certificate has been accepted, **and the
certificate is checked before anything is written to the connection**. With a pinned fingerprint, a
connection to a different certificate is dropped before the sign-in is sent (there is a test that
proves the sign-in never arrives). Plain `http://` to the console is refused unless it is on the same
computer. See [Trusting the certificate](../README.md#trusting-the-certificate).

## The settings page

| Threat | Defence |
|---|---|
| Someone on the network opens it | Everything except the page's own files needs the admin token. Compared in constant time. |
| Guessing the token | 5 wrong tries per address and 40 in all per 15 minutes, then it refuses even the right one for a while. Tokens under 16 characters are refused at start-up. |
| Stealing the session | The cookie is `HttpOnly` and `SameSite=Strict`; only its hash is kept in memory; sessions end after 8 hours and on sign-out; at most 20 at once. |
| Another website making your browser change settings (CSRF) | Every change needs a custom header a page on another origin cannot send without a permission this server never grants; `Origin` and `Sec-Fetch-Site` are checked; no CORS headers are ever sent. |
| Script injection through a device name (`<script>`) | Names are put on the page with `textContent` only, never as HTML. A test fails the build if the page's script uses `innerHTML` or similar. The content security policy allows only the page's own scripts and styles (no inline, no `eval`) and no framing. |
| Reading other files | Five files are served, from a fixed list read at start-up. There is no path handling to get wrong. |
| Oversized or malformed requests | Bodies over 16 KB are refused; only JSON objects are accepted; header and request timeouts are set. |
| Error messages leaking things | The page says what a service said in general terms. Unexpected errors return a fixed message and log only their type. |

**What it does not do**: it does not use TLS itself. It is a page for your home network; do not expose
it to the internet. To use it from elsewhere, use a VPN or an HTTPS reverse proxy and set
`COOKIE_SECURE=true`.

## Files on disk

`state.json` (choices and what is blocked) is written atomically, readable only by its owner, and read
back as untrusted input: only real device addresses, known modes and sane sizes survive, so a
hand-edited file cannot make the plugin do more than the settings page could.

## Reporting a problem

Please report a vulnerability privately, by email to the address on the maintainers' GitHub profile
or through GitHub's private vulnerability reporting on this repository, rather than in a public issue.
