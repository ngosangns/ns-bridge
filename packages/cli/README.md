# @ngosangns/ns-bridge

CLI for the [ns-bridge](https://github.com/ngosangns/ns-bridge) providers. It installs the last published host packages and writes model catalogs in its own process. Pi, OMP, and DSH read those files.

```bash
npm install -g @ngosangns/ns-bridge
ns-bridge help
```

## Commands

Mutating commands apply by default. Pass `--dry-run` to preview them.

```bash
ns-bridge install [pi|omp|dsh|all] [--dry-run] [--profile <name>]
ns-bridge update [--dry-run]
ns-bridge update <pi|omp|dsh|all> [--dry-run] [--profile <name>]
ns-bridge uninstall [pi|omp|dsh|all] [--dry-run] [--profile <name>]
ns-bridge providers status [pi|omp|dsh|all] [kiro|devin|grok] [--profile <name>]
ns-bridge providers enable|disable <pi|omp|dsh> <kiro|devin|grok> [--dry-run] [--profile <name>]
ns-bridge usage [--vendor <kiro|devin|grok>] [--day YYYY-MM-DD] [--days <n>] [--json]
ns-bridge usage --session <id> [--vendor <name>] [--json]
ns-bridge models list [kiro|devin|grok|all]
ns-bridge models refresh [kiro|devin|grok|all] [--dry-run]
ns-bridge kiro profile [list]
ns-bridge kiro profile use <name|region|arn> [--dry-run]
ns-bridge kiro profile reset [--dry-run]
ns-bridge serve [--port N] [--host H] [--allow-remote]
ns-bridge zcode setup [--dry-run] [--vendors <list>] [--default <vendor>/<model>]
           [--force] [--no-service]
ns-bridge zcode status
ns-bridge zcode remove [--dry-run] [--force]
ns-bridge status
```

`serve` and `zcode` register the same vendors for the ZCode app through a local Anthropic-Messages server; see the root [README](https://github.com/ngosangns/ns-bridge#zcode).

| Host | Install | Update | Uninstall |
| --- | --- | --- | --- |
| pi | `pi install npm:@ngosangns/ns-pi-provider` | `pi update --extension npm:@ngosangns/ns-pi-provider` | `pi uninstall npm:@ngosangns/ns-pi-provider` |
| omp | `omp plugin install ns-omp-provider-kiro` | `omp plugin upgrade ns-omp-provider-kiro` | `omp plugin uninstall ns-omp-provider-kiro ns-omp-provider` |
| dsh | `dsh plugin --profile <name> add ns-dsh-llm-kiro ns-dsh-llm-devin ns-dsh-llm-grok` | `dsh plugin --profile <name> update …` | `dsh plugin --profile <name> remove …` |

OMP ships `devin`, `xai`, and `xai-oauth` itself, so only `kiro` comes from a plugin there (`/login devin`, `/login xai-oauth`). `ns-omp-provider`, the old plugin that also registered `devin` and `grok`, is no longer installed or upgraded; `uninstall omp` still removes it, or run `omp plugin uninstall ns-omp-provider`. Model ids `devin/…` and `grok/…` in OMP's `config.yml` then resolve to OMP's own `devin` and (for Grok) `xai-oauth/…` or `xai/…`.

DSH requires `--profile`. Profile `desktop` is refused: the Electron app owns it. `install` and `update <host>` without `--profile` skip DSH and still handle Pi and OMP.

`update` with no host updates this CLI, not the host plugins. It asks npm for the latest `@ngosangns/ns-bridge` and runs `npm install -g @ngosangns/ns-bridge@<latest>`. Already current prints the version and does not install. A host argument (`pi`, `omp`, `dsh`, or `all`) updates those plugins instead.

`providers enable` and `providers disable` turn one of `kiro`, `devin`, or `grok` on or off. Pi and OMP share `~/.ns-bridge/providers.json` (`NS_BRIDGE_PROVIDERS` overrides the path); the extension reads it at launch. With no file, all three are on. OMP only takes `kiro` from it: `providers enable omp devin|grok` is refused with the reason, `providers disable omp devin|grok` changes nothing, `providers status omp` shows them as `not provided`, and `devin` or `grok` in the file or in an env list are ignored by the OMP plugin (they still apply to Pi). `NS_OMP_PROVIDERS` replaces the file, `NS_OMP_PROVIDER_ENABLE` adds, and `NS_OMP_PROVIDER_DISABLE` removes. DSH writes `disabled: true` on that plugin's id in the profile's `cordis.patch.yml`. In OMP, `kiro` stays with `ns-omp-provider-kiro` while that plugin is installed, whatever the file or an env list says. Only the key you change is written; defaults never land in the file.

`usage` reads the ledger the plugins write while they work in Pi, OMP, and DSH. Each model response appends one JSON line to `~/.ns-bridge/usage/<day>/<vendor>/<session>.jsonl` (`NS_BRIDGE_USAGE_DIR` moves the root). A response with no session id goes to `_no-session.jsonl`. Plugins record unless `NS_BRIDGE_USAGE=0`. The command makes no network call and writes nothing.

The default view groups the newest 10 days by day and vendor. `--session <id>` lists one session step by step. `hit` is `cacheRead` over prompt tokens (`input + cacheRead + cacheWrite`), summed over the rows, not an average of per-step ratios. `source` says where a row's cache numbers came from. `wire` rows are counters the provider sent (Grok, Devin). A step whose provider sent none has a `null` ratio, is left out of both sides, and counts under `no cache data`. Kiro sends no cache counters, so ns-bridge works them out from the credits Kiro bills. Kiro prices a cached prefix at about half the cold rate, but new tokens appended after it at about ten times the cached rate, so a turn that adds 10% to its prompt costs as much as a cold one. When the bill is under that ceiling it fixes the cached share: those rows are `from credits`, with a `*` after the ratio in `--session`. When the bill is on the ceiling, the share cannot be known and the row shows an upper bound such as `<=90%*` and counts under `credits cap`. Both are a calculation from a bill, not a count. It needs `kiro-cli` installed (for the per-model rate), a model measured in `kiro-core` (auto, haiku-4-5, opus-5, sonnet-5-5, gpt-5-6-luna), a prompt of at least 2,000 tokens, and Kiro reporting credits; otherwise the row says `no cache data`. The DSH Kiro plugin separately guesses a cache read so the Harness can draw a cache-hit bar; the ledger ignores that guess. The ledger keeps 30 days and 50 MB; older day folders are deleted whole.

`cold` counts steps whose bill sits on the no-cache ceiling (`credits cap`) although the prefix should have been cached, over the steps whose bill speaks about the cache (`from credits` plus `credits cap`). It leaves out a session's first step, a step whose prompt is shorter than the step before (compaction rewrites the prefix), and a step after 245 s or more of idle time (the cache expires). What remains means the prompt prefix changed between two close steps. Only rows with credits-derived data have a value; the others show `-`.

`models list` and `status` read the catalog files and do not import the provider cores:

- Kiro: `~/.ns-kiro-provider-models-cache.json`
- Devin: `$NS_DEVIN_MODEL_CACHE`, or `$XDG_DATA_HOME/ns-devin-provider/models.json`
- Grok: `~/.pi/agent/cache/ns-pi-provider/grok.models.json`

`models refresh` writes those files from the bundled refresh. A missing file is reported as missing. The command does not print the in-memory fallback list.

Pi, OMP, and DSH read those files while they run. They do not refresh them.

`kiro profile` lists the Kiro profiles your login can use (it asks Kiro in `us-east-1`, `eu-central-1`, and the login's own region) and marks the one requests run on. `(login)` tags the profile the login carries on its own, which is what Kiro uses when nothing is pinned: kiro-cli's pick at `kiro-cli login`, or for a social (desktop) login the token's own profile. `use` takes a profile name, a region that holds exactly one profile, or an ARN. A well-formed ARN the listing does not show (a profile in another region) is pinned with a warning; Kiro rejects requests if the login cannot use it. The pin lives in `~/.ns-bridge/kiro-profile.json`. It also fetches that profile's catalog the first time. The Kiro cache keeps one catalog per profile, so switching back and forth later needs no fetch. `reset` removes the pin. Pi, OMP, and DSH read the pin on every request, so a switch applies from the next turn. A host's model list reloads when the host restarts. `KIRO_PROFILE_ARN` outranks the pin.
