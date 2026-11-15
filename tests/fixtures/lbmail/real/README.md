The shapes `lbmail --json --agent` printed against a running lumbridge-maild 0.1.0 with four accounts
(two Gmail through gog, one Zoho, one Resend; the daemon on another machine), captured 2026-11-11.
Keys, types, nulls and nesting are the daemon's. Every value that came from mail or from the accounts
(ids, names, addresses, subjects, text, counts) is invented.

`events.jsonl` holds one line per event kind as `lbmail tail --json` prints them
(lumbridge-mail-core rpc.rs `Event`); a tail that times out prints nothing and exits 0.
