# ns-omp-provider-kiro

> Development of this package has stopped. The maintained package is [@ngosangns/ns-bridge](https://www.npmjs.com/package/@ngosangns/ns-bridge).

Kiro (AWS CodeWhisperer/Q) models in [OMP](https://github.com/can1357/oh-my-pi).

The last npm release is `0.5.3`. npm marks it deprecated. Install it with the
maintained CLI, or with OMP directly:

```bash
ns-bridge install omp --apply
omp plugin install ns-omp-provider-kiro
```

`omp plugin install` accepts a bare name or `name@version`.

### From a local build

To load a clone of this repo instead of the npm tarball:

```bash
git clone git@github.com:ngosangns/ns-bridge.git
cd ns-bridge && pnpm install && pnpm -r build
omp plugin install ./packages/omp-provider-kiro
```

Sign in once with kiro-cli — Builder ID, IAM Identity Center, Google, GitHub, or
enterprise OIDC all work, because kiro-cli does them:

```bash
kiro-cli login
```

Then, in OMP:

```
/login kiro
/model
```

`/login kiro` picks up the kiro-cli session and refreshes it when it expires,
writing the refresh back so both tools stay on the same token. With no session
on the machine it prompts for a Kiro API key (`ksk_…`) instead.

`/model` lists the catalog file for the account's region
(`~/.ns-kiro-provider-models-cache.json`). `ns-bridge models refresh kiro --apply`
writes that file from Kiro's management API. While OMP is running it reads the
file and does not fetch a new one.

## Notes

- Reasoning effort maps onto Kiro's own ladder per model — `xhigh` and `max`
  exist only where the model advertises them, and a request for more thinking
  than a model offers is clamped rather than rejected.
- Usage (`/settings`) reports the account's Kiro credit balance — the one the
  host is signed in with, so run `/login kiro` after signing the machine into a
  different account.
- Sessions come from the machine: the kiro-cli store first, the Kiro IDE's token
  file as a fallback. They can be different IdC users of the same Kiro profile,
  so `KIRO_AUTH_SOURCE=ide` switches a machine over to the IDE's login instead.
- `KIRO_API_KEY` is read as a fallback when no session is stored.
- `KIRO_DEBUG=1` writes a full request/response trace to
  `~/.ns-kiro-provider/logs/kiro-debug.log`, with credentials redacted.

This is the recommended Kiro path in OMP. `ns-omp-provider` can also register a
`kiro` provider, but leaves it off by default so the two never fight over the id.

Part of [ns-bridge](https://github.com/ngosangns/ns-bridge).
