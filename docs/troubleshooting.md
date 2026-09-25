# Troubleshooting

Always start here:

```bash
docker compose run --rm unifi node src/main.js --check
```

It changes nothing, and says for each part whether it works and what to do if not. Logs:

```bash
docker compose logs -f unifi
```

The settings page shows the same problems in words (top card, and under **What happened**).

## Five More Minutes

| Message | Meaning and fix |
|---|---|
| `That does not look like a Five More Minutes API key` | It starts with `fmmk_` and is 81 characters. Copy all of it, with nothing before or after and no quotes. |
| `no longer accepts this plugin's key` | Revoked or expired. Make a new one in the portal under **Plugins** and restart the plugin. A key's permissions cannot be edited; make a new one. |
| `missing the permission to see the computer's state` | Make a new key with `state:read` ticked. |
| `will only talk to plugins on the local network` | The plugin must run on the same network as Five More Minutes and use its local address in `FMM_URL`. Five More Minutes refuses plugin keys from the internet on purpose. If it runs on a different subnet, the Five More Minutes service needs that subnet in its `Integrations:AllowedNetworks`. |
| `Could not reach Five More Minutes` | Is it running? Can this computer open `FMM_URL` in a browser? In Docker, `localhost` means the container itself: use the computer's real address. |

## UniFi

| Message | Meaning and fix |
|---|---|
| `did not accept that user name and password` | Wrong `UNIFI_USERNAME`/`UNIFI_PASSWORD`, or not a **local** account. Also: UniFi locks sign-ins for a while after several wrong ones. |
| `refused this account` | The account signs in but is not an administrator of the Network application. |
| `certificate was not accepted` | See [Trusting the certificate](../README.md#trusting-the-certificate). |
| `presented a different certificate from the one pinned` | The console's certificate changed (a reset or an update can do it). Run `--check`, confirm the new fingerprint, and update `UNIFI_TLS_FINGERPRINT`. |
| `answered with something that was not JSON` | `UNIFI_URL` is not the console (a router page?), or `UNIFI_KIND` is wrong. |
| `accepted the sign-in but did not start a session` | Wrong `UNIFI_KIND`: use `classic` for a self-hosted controller. |
| `answered 404` on every call | Wrong `UNIFI_KIND` or `UNIFI_SITE`. |
| `too many requests` / `refusing sign-ins` | Wait a few minutes. The plugin retries by itself. |

## Behaviour

**A device is not blocked when the computer is locked.**
Is it ticked and saved? Is the mode right? Does the page say *Blocking N devices*? If it says the
computer is not locked, Five More Minutes and this plugin disagree; check that the key is for the right
computer (`--check` prints its name). Some devices use a different address when they are on a VPN or use
"private Wi-Fi address" features: UniFi blocks the address it sees, so choose that device's current entry.

**A device is still blocked after the lock ended.**
It was blocked by someone else, or by this plugin and could not be released (UniFi unreachable). The page
says which. Fix the cause, or unblock it in UniFi (**Clients → the device → Unblock**), or:

```bash
docker compose run --rm unifi node src/main.js --release
```

**It blocks and unblocks in a loop.**
Something else (another tool, a UniFi schedule) is unblocking it. The plugin puts the block back while the
rule says so. Remove the other automation.

**I forgot the admin token.**
It is in your `.env`. Change it there and restart: `docker compose up -d`.

**The page says "Too many wrong tries".**
Wait 15 minutes, or restart the plugin.

## Still stuck?

Open an issue with the output of `--check` (it never prints secrets) and the last lines of the log.
