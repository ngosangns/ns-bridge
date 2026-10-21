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
ns-bridge models list [kiro|devin|grok|all]
ns-bridge models refresh [kiro|devin|grok|all] [--apply]
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

`models list` and `status` read the catalog files and do not import the provider cores:

- Kiro: `~/.ns-kiro-provider-models-cache.json`
- Devin: `$NS_DEVIN_MODEL_CACHE`, or `$XDG_DATA_HOME/ns-devin-provider/models.json`
- Grok: `~/.pi/agent/cache/ns-pi-provider/grok.models.json`

`models refresh --apply` writes those files from the bundled refresh. A missing file is reported as missing. The command does not print the in-memory fallback list.

Pi, OMP, and DSH read those files while they run. They do not refresh them.
