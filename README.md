# UniFi Internet Blocker for Five More Minutes

Cuts the internet for the devices you choose on your **UniFi** network (an iPad, a games console, a
phone) when [Five More Minutes](https://fivemoreminutes.app) locks the
computer, and lets them back online the moment you give more time.

It is free, open source (MIT), runs in your home, and talks to nothing outside it.

| | |
|---|---|
| **What it does** | Blocks the devices you tick while the computer is locked (or, if you prefer, whenever no timer is running), and unblocks them again. |
| **What it needs from Five More Minutes** | One permission: `state:read`. It can *see* the computer's state and nothing else. It cannot start, extend or stop time. |
| **What it needs from UniFi** | A local administrator account for the Network application, made for it. |
| **Where it runs** | Anywhere with Docker (or Node 20.3+) that is always on and on your home network: a NAS, a Raspberry Pi, a mini PC. |
| **Language** | The settings page is in English and Swedish, following your browser. |

## How it works

```
Five More Minutes ──(state:read, local network only)──▶ this plugin ──(block / unblock)──▶ UniFi
   the computer's lock                                    decides                          your devices
```

1. The plugin asks Five More Minutes to say the moment anything changes (a long-poll: about two requests a minute while nothing happens, and an answer within a moment when a parent presses a button).
2. When the computer is locked, it tells UniFi to block the devices you chose. When time is given, or the lock ends, it unblocks them.
3. A lock in Five More Minutes always carries its own end time. The plugin uses it, so **the devices come back online when the lock ends even if the plugin can no longer reach Five More Minutes**.

### The promise: it never leaves anyone blocked

A plugin that can cut a child's internet needs to be careful about *not* doing so. These are properties
of the code, each with a test:

- It **only touches the devices you chose**, and only ever sends `block` and `unblock`. There is no way for anything to make it send another command.
- It **only unblocks what it blocked itself**. A device you had already blocked in UniFi by hand stays blocked when the plugin lets go.
- When anything goes wrong it lets devices **back online**: Five More Minutes out of reach for too long, UniFi restarting, the plugin being stopped or updated (a stop lets everyone back online first).
- If it was killed hard while devices were blocked, it remembers (on disk, before it blocks) and lets them go the next time it starts, or when you run `docker compose run --rm unifi node src/main.js --release`.
- Unplugging it, or deleting it, never leaves a permanent block that only it can lift: everything it does can be undone in UniFi under **Clients → the device → Unblock**.

## Install

You need about ten minutes and a computer that is always on.

### 1. Make a UniFi account for it

The plugin signs in to your UniFi console to block devices. Give it **its own account**, not yours, so
you can see what it does and remove it without touching anything else.

1. Open your UniFi console in a browser and go to **Settings → Admins & Users** (on older versions: **Settings → System → Admins**).
2. **Create New Admin.** Give it a name such as `fmm-plugin` and a long random password.
3. Tick **Restrict to local access only** (a local account works without the cloud sign-in and without two-factor prompts, which a plugin cannot answer).
4. Give it the **Administrator** role for the **Network** application. Blocking a device is a change to the network, so the read-only role is not enough.
5. Save it.

> The exact wording moves between UniFi versions. What matters is: a *local* account that can *manage
> clients* on the *Network* application.

### 2. Make a key in Five More Minutes

In the Five More Minutes portal open **Plugins**, choose the computer, name the key `UniFi`, tick only
**`state:read`**, and press **Create key**. Copy the key when it is shown: it is shown once.

Or, if you found this plugin in the marketplace, press **Add** on its page and the portal does this for you.

### 3. Get the plugin and fill in its settings

```bash
git clone https://github.com/Five-More-Minutes-App/fmm-plugin-unifi
cd fmm-plugin-unifi
cp .env.example .env
```

Open `.env` and fill in at least these:

```ini
FMM_URL=http://192.168.1.10:5072        # where Five More Minutes is, from this computer
FMM_API_KEY=fmmk_...                    # the key from step 2
UNIFI_URL=https://192.168.1.1           # your console
UNIFI_USERNAME=fmm-plugin
UNIFI_PASSWORD=...
ADMIN_TOKEN=...                         # a password for this plugin's settings page
```

Make the admin token with `node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"`.
Every setting is explained in [docs/configuration.md](docs/configuration.md).

### 4. Check it, then start it

```bash
docker compose run --rm unifi node src/main.js --check
```

It tells you, line by line, what works and what does not, and what to do about it:

```
OK    Five More Minutes: the key opens "Elliots laptop".
OK    The key can see the computer's state (state:read).
OK    UniFi: signed in as fmm-plugin.
OK    UniFi: 23 devices known on site "default".

Everything needed is working.
```

If it shows a certificate fingerprint instead, read [Trusting the certificate](#trusting-the-certificate) first. Then:

```bash
docker compose up -d
```

Without Docker: `node src/main.js` (Node 20.3 or later; there is nothing to `npm install`).

### 5. Choose the devices

Open **http://the-computer-it-runs-on:8099** in a browser and sign in with the admin token.

- Tick the devices to block. Search by name or address if the list is long. A device you have named in UniFi shows under that name.
- Choose **when**: *while the computer is locked* (the default) or *whenever no time is running*.
- Press **Save**.

To try it: lock the computer from the Five More Minutes portal and watch the device go offline; give
time and watch it come back. The page shows what happened and why.

## Trusting the certificate

Your UniFi console presents a certificate it made itself, so by default the plugin will refuse to send
your UniFi password to it. That is the right behaviour: it means nobody on your network can pretend
to be your console. You have three ways to tell it the console is genuine, in order of preference:

1. **Pin it** (recommended). Run `--check`; it prints the console's fingerprint. If it is your console, put it in `.env`:
   ```ini
   UNIFI_TLS_FINGERPRINT=AB:CD:...
   ```
   The plugin then accepts that certificate and no other, and sends nothing to a different one. (Compare the fingerprint with the one in your console under **Settings → System → Advanced** if you want to be sure.) If you ever reset the console it gets a new certificate and you pin the new one.
2. **Give it your certificate authority**, if you run your own: `UNIFI_CA_FILE=/data/ca.pem`.
3. **Switch checking off** with `UNIFI_INSECURE_TLS=true`. It works, and it is named "insecure" everywhere it appears, because anything on your network could then read your UniFi password. Use it only to get going.

## The settings page

It changes what is blocked on your network, so it is protected:

- Nothing but the page itself is reachable without the **admin token**; sign-in attempts are rate limited.
- The token opens a session cookie that page scripts cannot read (`HttpOnly`) and other websites cannot send (`SameSite=Strict`), and every change also has to carry a header another website cannot add.
- It listens on `127.0.0.1` by default; the Docker setup makes it reachable on your home network (`HOST=0.0.0.0`). **Do not forward its port from the internet.** If you want to reach it away from home, use a VPN, or put it behind an HTTPS proxy and set `COOKIE_SECURE=true`.

More in [docs/security.md](docs/security.md).

## Troubleshooting

Start with `docker compose run --rm unifi node src/main.js --check`, then see
[docs/troubleshooting.md](docs/troubleshooting.md). The most common ones:

| You see | Do this |
|---|---|
| `UniFi did not accept that user name and password` | Check `UNIFI_USERNAME` / `UNIFI_PASSWORD`, and that the account is a *local* one. |
| `certificate was not accepted` | [Trust the certificate](#trusting-the-certificate) (pin the fingerprint). |
| `UniFi refused this account` | The account is not an administrator of the Network application. |
| `answered with something that was not JSON` | `UNIFI_URL` is not the console, or `UNIFI_KIND` is wrong (`classic` for a self-hosted controller on 8443). |
| `Five More Minutes no longer accepts this plugin's key` | The key was revoked or expired. Make a new one and restart. |
| `will only talk to plugins on the local network` | Run the plugin on the same network as Five More Minutes and use its local address. |
| A device is still blocked after you removed the plugin | UniFi → **Clients** → the device → **Unblock**, or run `docker compose run --rm unifi node src/main.js --release`. |

## Uninstall

```bash
docker compose down        # lets everything it blocked back online first
```

Then revoke its key in the Five More Minutes portal (**Plugins → UniFi → Revoke**) and delete its account
in UniFi.

## What has and has not been tested

- **Tested automatically** (`npm test`, 140+ tests): the decision logic (every rule above), the UniFi client against a stand-in that answers the way UniFi OS and classic controllers do (sign-in, cookies, CSRF token, session expiry, block/unblock), certificate pinning against a real TLS server, the service end to end against stand-ins for both Five More Minutes and UniFi (including fail-open and restart), and the settings page's sign-in, cross-site protection and validation.
- **Not tested against real UniFi hardware in CI.** The UniFi calls are the ones the UniFi web app itself makes and that other integrations use, but Ubiquiti does not document or promise them. If a UniFi update changes them, `--check` will say so. Please open an issue with the message.

## Development

```bash
npm test          # everything above
npm run check     # type-check the JavaScript (no build step)
```

The design is in four small, separately tested pieces: `src/reconciler.js` decides (pure, no I/O),
`src/unifi.js` talks to UniFi, `src/service.js` connects the two to Five More Minutes, and `src/web.js`
is the settings page. `src/fmm-client.js` is an unmodified copy of the client from
[fmm-plugin-template-node](https://github.com/Five-More-Minutes-App/fmm-plugin-template-node).

## Licence

MIT. See [LICENSE](LICENSE).
