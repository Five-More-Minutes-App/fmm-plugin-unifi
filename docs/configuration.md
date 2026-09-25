# Configuration

Everything is set with environment variables, in a `.env` file next to `docker-compose.yml` (or in the
environment when you run `node src/main.js`). The plugin reads them once at start-up and, if anything is
wrong, **lists everything that is wrong at once** and starts nothing.

Any secret can instead be the path to a file that holds it: `FMM_API_KEY_FILE=/run/secrets/fmm_key`.
Set the value or the file, not both. A trailing newline in the file is ignored.

## Five More Minutes

| Variable | Default | |
|---|---|---|
| `FMM_URL` | *required* | Where Five More Minutes is reached from this computer, e.g. `http://192.168.1.10:5072`. No user name or password in it. |
| `FMM_API_KEY` | *required* | A key from the portal's **Plugins** page. It looks like `fmmk_` and 81 characters. It needs only `state:read`. `--check` says if it has more than it needs. |

## UniFi

| Variable | Default | |
|---|---|---|
| `UNIFI_URL` | *required* | Your console, e.g. `https://192.168.1.1`. Must be `https://` (your UniFi password is sent to it), except when it is on this same computer. Anything after the address is ignored. |
| `UNIFI_USERNAME` | *required* | A local administrator made for this plugin. |
| `UNIFI_PASSWORD` | *required* | Its password. |
| `UNIFI_SITE` | `default` | The site's internal name (letters, digits, `-`, `_`). It is `default` unless you made more sites; it is the word in the address after `/site/` in the UniFi web app. |
| `UNIFI_KIND` | `unifi-os` | `unifi-os` for a console (Dream Machine, Cloud Gateway, Cloud Key Gen 2+). `classic` for a self-hosted Network Application (usually port 8443). |
| `UNIFI_TLS_FINGERPRINT` | | Accept only the certificate with this SHA-256 fingerprint. |
| `UNIFI_CA_FILE` | | Accept certificates signed by this authority (a PEM file). |
| `UNIFI_INSECURE_TLS` | `false` | Do not check the certificate at all. Choose **at most one** of these three. |

## The settings page

| Variable | Default | |
|---|---|---|
| `ADMIN_TOKEN` | *required* | The password for the settings page. At least 16 characters, and not a few characters repeated. |
| `PORT` | `8099` | |
| `HOST` | `127.0.0.1` | An IP address to listen on. `127.0.0.1` is this computer only. `0.0.0.0` is your whole network; the Docker image sets this, because the container's own address is not reachable otherwise. |
| `COOKIE_SECURE` | `false` | Mark the session cookie `Secure`. Set it when the page is served over https. |

## Behaviour

| Variable | Default | |
|---|---|---|
| `FAIL_OPEN_SECONDS` | `300` | 30–86400. Only matters in *whenever no time is running* mode: how long Five More Minutes may be out of reach before the plugin lets everything back online. (In *while locked* mode a lock ends at the time Five More Minutes gave it, however long the silence.) |
| `RECONCILE_SECONDS` | `60` | 5–3600. How often the plugin checks that what UniFi says still matches what it should. A change in Five More Minutes is acted on immediately, whatever this is. |
| `DATA_DIR` | `./data` (`/data` in Docker) | Where it remembers your choices and what it has blocked. One small file, readable only by the account running the plugin. |

## The two modes

**While the computer is locked** (default). The devices are blocked when Five More Minutes locks the
computer, and unblocked when the lock ends or when a timer is started (which lifts the lock).

**Whenever no time is running.** The devices are blocked all the time *except* while a timer is running.
That is stricter: it also blocks them before the first timer of the day and after a timer that was
cancelled. Because it has no end time to lean on, it lets everything back online if Five More Minutes has
been out of reach for `FAIL_OPEN_SECONDS`.

## What is stored

`state.json` in `DATA_DIR`:

```json
{
  "version": 1,
  "mode": "locked",
  "selection": [{ "mac": "aa:bb:cc:00:00:01", "label": "Elliot's iPad" }],
  "blockedByUs": ["aa:bb:cc:00:00:01"]
}
```

`blockedByUs` is what this plugin has blocked and not yet let go. It is written *before* a device is
blocked, so a crash never loses track of one. It is safe to delete the file; the plugin then blocks nothing
until you choose devices again (if it had blocked something, unblock it in UniFi).
