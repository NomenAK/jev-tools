# Contributing

Issues and external pull requests are welcome. Use English for issues, pull requests, documentation, comments, and test descriptions; keep non-English fixtures when they test language or encoding behavior. For vulnerabilities, follow [SECURITY.md](SECURITY.md).

## Issues or pull requests?

Open an issue for a reproducible product bug or a feature request. Include the package and host versions, expected and actual behavior, and a minimal sanitized reproduction. Small, focused fixes or documentation corrections can go straight to a pull request. Discuss new tools, contract changes, and research-dependent features in an issue before implementing them.

An issue may describe an unmet need without claiming that a method already works. Features such as co-change suggestions are not accepted for implementation without a new, validated method. Propose the method, its evaluation protocol, and reproducible evidence in an issue first; an unvalidated heuristic or a renamed version of it is not enough.

## Local checks

Use Node.js 24 or newer and npm. From a checkout, with development dependencies enabled:

```sh
npm ci --include=optional
npm run typecheck
npm run build
npm run check:imports
npm run lint
node scripts/generate-instructions.ts --check
npm test
```

`npm run build` compiles only the MCP server into `dist/` (git-ignored); `npm pack` runs it automatically. To try the server against a checkout, see [From a clone](docs/mcp.md#from-a-clone). CI packs the package and runs `node scripts/check-mcp-package.ts <tarball>`: it installs the tarball into an empty directory, checks modern discovery and all advertised legacy handshakes, lists the six tools with their schemas and caching fields, and runs `jev_ask` through a local synthetic HTTP endpoint. This verifies installed integration, not live model accuracy. Linux runs the full offline suite; native Windows and macOS jobs run targeted MCP, process, configuration and packaging checks.

Agent policy and result-reading guidance are versioned in `src/texts/instructions.ts`. After changing them, run `node scripts/generate-instructions.ts` to update the checked-in omp rule and MCP project block; `--check` verifies that those copies remain synchronized. Keep host differences explicit rather than maintaining independent policy text.

## Releases

Maintainers release by pushing a `vX.Y.Z` tag on reviewed `main`. Before tagging, set the same version in `package.json`, in both `version` fields of `server.json`, and in a `CHANGELOG.md` section; `test/server-json.test.ts` fails if they drift. [`publish.yml`](.github/workflows/publish.yml) then packs once, checks the packed MCP server, publishes the approved tarball to npm with trusted publishing, publishes `server.json` to the MCP Registry with GitHub OIDC, and creates a draft GitHub Release. Each publication step skips a version that already exists with the same content and fails on anything inconclusive.

Keep optional native dependencies enabled for development. These checks make no Jev API calls and need no Jev key. Dependency installation may use the network. Some runner-identity tests skip when additional runners are unavailable locally; CI provisions those runners in [.github/workflows/ci.yml](.github/workflows/ci.yml).

Maintainers run a private regression probe on reviewed release candidates before release and on the published package before announcing it. Contributors do not need access to that probe or its credentials.

## Pull request expectations

Keep changes focused. Explain the user-visible behavior, link the relevant issue when there is one, and report the checks you actually ran, including skips or limitations. Add or update deterministic tests for changed behavior and regressions, and update affected documentation. Public CI must pass without service credentials.

Do not make accuracy, recall, speed, or other measurement claims without describing the method, baseline, data, and limitations sufficiently to reproduce and review them. Do not include credentials, raw service responses, private data, or personal configuration in issues, patches, or logs. Use synthetic or sanitized examples.

Check the name and email attached to your commits before submitting; GitHub's noreply email is an option if you do not want to publish a personal email address.
