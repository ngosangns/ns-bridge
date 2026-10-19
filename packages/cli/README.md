# @ngosangns/ns-bridge

CLI for the [ns-bridge](https://github.com/ngosangns/ns-bridge) providers. It installs host packages and refreshes model catalogs in its own process, so Pi and OMP only read the files those commands write.

The package is private until its first hand publish. Trusted publishing cannot create a package npm has never seen. From this repo:

```bash
pnpm --filter @ngosangns/ns-bridge build
pnpm exec ns-bridge help
```

## Commands

Mutating commands preview. `--apply` runs them. `--dry-run` is the default.

```bash
ns-bridge install [pi|omp|dsh|all] [--apply] [--profile <name>]
ns-bridge update [pi|omp|dsh|all] [--apply] [--profile <name>]
ns-bridge uninstall [pi|omp|dsh|all] [--apply] [--profile <name>]
ns-bridge models list [kiro|devin|grok|all]
ns-bridge models refresh [kiro|devin|grok|all] [--apply]
ns-bridge status
```

| Host | Install | Update | Uninstall |
| --- | --- | --- | --- |
| pi | `pi install npm:@ngosangns/ns-pi-provider` | `pi update --extension npm:@ngosangns/ns-pi-provider` | `pi uninstall npm:@ngosangns/ns-pi-provider` |
| omp | `omp plugin install ns-omp-provider ns-omp-provider-kiro` | `omp plugin upgrade ns-omp-provider ns-omp-provider-kiro` | `omp plugin uninstall ns-omp-provider ns-omp-provider-kiro` |
| dsh | `dsh plugin --profile <name> add ns-dsh-llm-kiro ns-dsh-llm-devin ns-dsh-llm-grok` | `dsh plugin --profile <name> update …` | `dsh plugin --profile <name> remove …` |

DSH requires `--profile`. Profile `desktop` is refused: the Electron app owns it. `install` and `update` without `--profile` skip DSH and still preview Pi and OMP.

`models list` and `status` read the catalog files and do not import the provider cores:

- Kiro: `~/.ns-kiro-provider-models-cache.json`
- Devin: `$NS_DEVIN_MODEL_CACHE`, or `$XDG_DATA_HOME/ns-devin-provider/models.json`
- Grok: `~/.pi/agent/cache/ns-pi-provider/grok.models.json`

`models refresh --apply` loads `@ngosangns/ns-pi-provider` and writes those files. A missing file is reported as missing. The command does not print the in-memory fallback list.

Pi, OMP, and DSH read those files while they run. They do not refresh them.
