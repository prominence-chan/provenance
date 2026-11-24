<div align="center">

<img src=".github/banner.png" alt="Provenance" width="100%" />

<h1>Provenance</h1>

**A local coding agent for macOS and your terminal, powered by pooled free-tier models.**<br />
Pick a strength, not a model.

<br />

<a href="https://github.com/prominence-chan/provenance/releases/tag/provenance-app-v0.1.0"><img src="https://img.shields.io/badge/download-macOS%20arm64-111111?style=flat-square&logo=apple&logoColor=white" alt="Download for macOS arm64" /></a>
<a href="https://github.com/prominence-chan/provenance-core"><img src="https://img.shields.io/badge/router-provenance--core-111111?style=flat-square" alt="provenance-core" /></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-111111?style=flat-square" alt="Apache-2.0 License" /></a>

<br />

<img src=".github/provenance-ui.png" alt="The Provenance desktop app" width="90%" />

</div>

<br />

## Why Provenance?

Most coding agents lock you into a single paid subscription or make you babysit API keys and rate limits. Provenance takes a different approach: it runs locally on your machine and routes every request through [provenance-core](https://github.com/prominence-chan/provenance-core), which pools free-tier capacity from across a dozen providers (plus web chat accounts you sign into) behind one endpoint.

Instead of picking a provider or swapping models when one hits a quota wall, you pick how much horsepower the task needs:

<div align="center">

<table>
<tr>
<th><img src="https://img.shields.io/badge/spark-9cc8ff?style=for-the-badge" alt="spark" /></th>
<th><img src="https://img.shields.io/badge/ember-c9663f?style=for-the-badge" alt="ember" /></th>
<th><img src="https://img.shields.io/badge/solstice-ff6a3d?style=for-the-badge" alt="solstice" /></th>
<th><img src="https://img.shields.io/badge/nova-ff4fa3?style=for-the-badge" alt="nova" /></th>
</tr>
<tr>
<td align="center">fast &amp; small</td>
<td align="center">strong mid-size</td>
<td align="center">frontier</td>
<td align="center">the very strongest</td>
</tr>
<tr>
<td align="center"><sub>quick checks, bulk work</sub></td>
<td align="center"><sub>everyday edits, summaries</sub></td>
<td align="center"><sub>coding (default)</sub></td>
<td align="center"><sub>the hardest problems</sub></td>
</tr>
</table>

</div>

## Highlights

- **Desktop app & CLI** — A native macOS app with multi-project threads, live diffs, command approvals, and folder switching, paired with a fast `provenance` terminal client that shares the same engine.
- **Built-in routing & failover** — Conversations stay on the same model inside your chosen tier and automatically fail over when a provider rate-limits or goes down.
- **Guided account & key setup** — Connect free web chat accounts or API keys right inside **Models & accounts**; the desktop app bundles and manages its own local router automatically.
- **Keep working on big threads** — Optional fallbacks let you hand off threads that outgrow free-tier context limits to local coding CLIs you already use, without losing context.

## Get started

1. Download `Provenance-0.1.0-arm64.dmg` from the [latest release](https://github.com/prominence-chan/provenance/releases/tag/provenance-app-v0.1.0) (Apple Silicon) and drag **Provenance** into **Applications**.
2. Because the app is ad-hoc signed rather than notarized, right-click it and choose **Open** the first time (or clear quarantine once — see [SETUP.md](SETUP.md)).
3. Open **Models & accounts** in the app to sign into a chat site or add free-tier API keys, then start a thread.

Want to build from source, run the CLI (`provenance`), use the browser UI, or tune configuration and environment variables? Head over to **[SETUP.md](SETUP.md)**.

## Docs

- **[SETUP.md](SETUP.md)** — Building the desktop app and CLI, running from the terminal, configuration, and environment variables
- **[ui/README.md](ui/README.md)** — Desktop shell, web UI architecture, orchestrators, and test scripts
- **[docs/UPSTREAM.md](docs/UPSTREAM.md)** — Harness customization (`harness.toml`) and upstream maintenance

---

<div align="center">
<sub>Licensed under <a href="LICENSE">Apache-2.0</a> (see <a href="NOTICE">NOTICE</a>). Agent runtime adapted from <a href="https://github.com/openai/codex">openai/codex</a>; not affiliated with or endorsed by OpenAI.</sub>
</div>
