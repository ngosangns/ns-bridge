# @ngosangns/ns-bridge

CLI for the [ns-bridge](https://github.com/ngosangns/ns-bridge) providers. It installs the last published host packages and writes model catalogs in its own process. Pi, OMP, and DSH read those files.

```bash
npm install -g @ngosangns/ns-bridge
ns-bridge help
```

## Commands

Mutating commands preview. `--apply` runs them. `--dry-run` is the default.

```bash
ns-bridge install [pi|omp|dsh|all] [--apply] [--profile <name>]
ns-bridge update [--apply]
ns-bridge update <pi|omp|dsh|all> [--apply] [--profile <name>]
ns-bridge uninstall [pi|omp|dsh|all] [--apply] [--profile <name>]
ns-bridge providers status [pi|omp|dsh|all] [kiro|devin|grok] [--profile <name>]
ns-bridge providers enable|disable <pi|omp|dsh> <kiro|devin|grok> [--apply] [--profile <name>]
ns-bridge usage [--vendor <kiro|devin|grok>] [--day YYYY-MM-DD] [--days <n>] [--json]
ns-bridge usage --session <id> [--vendor <name>] [--json]
ns-bridge models list [kiro|devin|grok|all]
ns-bridge models refresh [kiro|devin|grok|all] [--apply]
ns-bridge kiro profile [list]
ns-bridge kiro profile use <name|region|arn> [--apply]
ns-bridge kiro profile reset [--apply]
ns-bridge status
```

| Host | Install | Update | Uninstall |
| --- | --- | --- | --- |
| pi | `pi install npm:@ngosangns/ns-pi-provider` | `pi update --extension npm:@ngosangns/ns-pi-provider` | `pi uninstall npm:@ngosangns/ns-pi-provider` |
| omp | `omp plugin install ns-omp-provider ns-omp-provider-kiro` | `omp plugin upgrade ns-omp-provider ns-omp-provider-kiro` | `omp plugin uninstall ns-omp-provider ns-omp-provider-kiro` |
| dsh | `dsh plugin --profile <name> add ns-dsh-llm-kiro ns-dsh-llm-devin ns-dsh-llm-grok` | `dsh plugin --profile <name> update …` | `dsh plugin --profile <name> remove …` |

DSH requires `--profile`. Profile `desktop` is refused: the Electron app owns it. `install` and `update <host>` without `--profile` skip DSH and still preview Pi and OMP.

`update` with no host updates this CLI, not the host plugins. It asks npm for the latest `@ngosangns/ns-bridge` and, with `--apply`, runs `npm install -g @ngosangns/ns-bridge@<latest>`. Already current prints the version and does not install. A host argument (`pi`, `omp`, `dsh`, or `all`) updates those plugins instead.

`providers enable` and `providers disable` turn one of `kiro`, `devin`, or `grok` on or off. Pi and OMP share `~/.ns-bridge/providers.json` (`NS_BRIDGE_PROVIDERS` overrides the path); the extension reads it at launch. With no file, all three are on. `NS_OMP_PROVIDERS` replaces the file, `NS_OMP_PROVIDER_ENABLE` adds, and `NS_OMP_PROVIDER_DISABLE` removes. DSH writes `disabled: true` on that plugin's id in the profile's `cordis.patch.yml`. In OMP, `kiro` stays with `ns-omp-provider-kiro` while that plugin is installed, unless the file or an env list names it.

`usage` reads the ledger the plugins write while they work in Pi, OMP, and DSH. Each model response appends one JSON line to `~/.ns-bridge/usage/<day>/<vendor>/<session>.jsonl` (`NS_BRIDGE_USAGE_DIR` moves the root). A response with no session id goes to `_no-session.jsonl`. Plugins record unless `NS_BRIDGE_USAGE=0`. The command makes no network call and writes nothing.

The default view groups the newest 10 days by day and vendor. `--session <id>` lists one session step by step. `hit` is `cacheRead` over prompt tokens (`input + cacheRead + cacheWrite`), summed over the rows, not an average of per-step ratios. `source` says where a row's cache numbers came from. `wire` rows are counters the provider sent (Grok, Devin). A step whose provider sent none has a `null` ratio, is left out of both sides, and counts under `no cache data`. Kiro sends no cache counters, so ns-bridge works them out from the credits Kiro bills. Kiro prices a cached prefix at about half the cold rate, but new tokens appended after it at about ten times the cached rate, so a turn that adds 10% to its prompt costs as much as a cold one. When the bill is under that ceiling it fixes the cached share: those rows are `from credits`, with a `*` after the ratio in `--session`. When the bill is on the ceiling, the share cannot be known and the row shows an upper bound such as `<=90%*` and counts under `credits cap`. Both are a calculation from a bill, not a count. It needs `kiro-cli` installed (for the per-model rate), a model measured in `kiro-core` (haiku, sonnet, opus), a prompt of at least 2,000 tokens, and Kiro reporting credits; otherwise the row says `no cache data`. The DSH Kiro plugin separately guesses a cache read so the Harness can draw a cache-hit bar; the ledger ignores that guess. The ledger keeps 30 days and 50 MB; older day folders are deleted whole.

`models list` and `status` read the catalog files and do not import the provider cores:

- Kiro: `~/.ns-kiro-provider-models-cache.json`
- Devin: `$NS_DEVIN_MODEL_CACHE`, or `$XDG_DATA_HOME/ns-devin-provider/models.json`
- Grok: `~/.pi/agent/cache/ns-pi-provider/grok.models.json`

`models refresh --apply` writes those files from the bundled refresh. A missing file is reported as missing. The command does not print the in-memory fallback list.

Pi, OMP, and DSH read those files while they run. They do not refresh them.

`kiro profile` lists the Kiro profiles your login can use (it asks Kiro in `us-east-1`, `eu-central-1`, and the login's own region) and marks the one requests run on. `(kiro-cli)` tags the profile kiro-cli picked at `kiro-cli login`, which is what Kiro uses when nothing is pinned. `use` takes a profile name, a region that holds exactly one profile, or an ARN, and pins it in `~/.ns-bridge/kiro-profile.json`. With `--apply` it also fetches that profile's catalog the first time. The Kiro cache keeps one catalog per profile, so switching back and forth later needs no fetch. `reset --apply` removes the pin. Pi, OMP, and DSH read the pin on every request, so a switch applies from the next turn. A host's model list reloads when the host restarts. `KIRO_PROFILE_ARN` outranks the pin.
