# CrewCode

CrewCode is a T3 Code desktop fork configured to run [Crew](https://github.com/nourhelmi/crew) through ACP. Crew owns the advisor/CoS workflow, worker routing, packets, mail, and settlement. T3 owns the app, project navigation, conversation display, permissions UI, and workspace tools.

You talk to your **root advisor or CoS**. Workers are read-only child views: inspect their transcripts and tools, and resolve native approval/question prompts. Give changes and follow-ups to the root; it decides how to instruct its workers. There is no worker chat composer or direct human-to-worker mail endpoint.

## Desktop use

Open `CrewCode.app`, add a project, choose **Crew**, select a lead model, and select **Advisor** or **Chief of staff** before your first message. The model list comes from your enabled Crew roster entries whose native CLI is installed. Choose your Astra or Opus entry when it is configured and available to your account. Advisor and CoS choose the workflow; they do not choose the lead model.

**Default** resolves to the session's selected roster model. The obsolete `crew-auto` bridge model is no longer used. Worker models still follow Crew's roster/router and explicit pins. View the roster with `crew roster`.

The app starts its own local server. Crew, Node 24+, and authenticated Codex/Claude CLIs are separate installations. No browser is required. Native Codex and Claude providers remain available for ordinary conversations; selecting one does not activate this ACP integration.

Change the lead model or switch between Advisor and Chief of staff in the same chat using the composer controls. Changes apply on the next root turn, once the current turn finishes or is interrupted. The root keeps its native conversation and existing workers keep their assignments. After launch, model choices stay within the root's provider: switch Codex models within a Codex-led chat, or Claude models within a Claude-led chat. Start a new chat to change between Codex and Claude.

Effort follows the selected model's supported values. Native permissions remain fixed after launch. If Crew rejects a configuration change, the next prompt fails visibly instead of running under an unacknowledged choice. Existing native conversations retain their history, but the old T3-owned Crew worker launcher has been removed.

## Stock T3 or another ACP client

Crew itself needs no fork. In a stock T3 installation, add a **Local ACP command** provider with your installed Crew executable as the command and `acp` as its argument. Use an absolute path such as `/Users/you/.local/bin/crew` if the GUI cannot find it on PATH. `CREW_NODE` can point to a Node 24+ executable.

Standard ACP provides root chat, model/workflow configuration, streamed text/tools, permissions, session history, and MCP configuration. Generic clients receive worker output in the root stream. This fork adds two Crew-specific behaviors: it maps worker metadata into T3's existing read-only child-chat display, and it lets Crew supply the delegation workflow without T3 adding competing delegation instructions. T3's other tools remain available; its core orchestrator still runs the app's conversations, events, and permissions.

The current child views are listed under the root; nested Crew advisor lineage remains metadata rather than a nested visual tree. Separate child views are a client feature, not a standard ACP guarantee. Stock T3 can run the Crew root through its Local ACP provider, but it does not recognize Crew's worker metadata or workflow ownership. This fork also reports rejected Crew configuration changes as errors. Its branding, separate profile, startup configuration, and general lifecycle fixes are conveniences rather than requirements of the Crew protocol. No T3 session IDs, credentials, or launcher API belong in the Crew CLI.

## Permissions, mail, and lifecycle

Approvals stay correlated to the exact pending native root or worker request. An ordinary chat message or Crew inbox message cannot approve a tool. Questions use negotiated structured elicitation; clients without a compatible question UI receive an explicit unsupported notice rather than an invented answer.

Crew mail is durable before any wake attempt. Active/idle native pipes deliver a pointer to the inbox; recipient consumption remains separate from delivery. You do not need to message or steer workers manually. Ask the root to change scope, and it uses Crew's packet/amendment workflow.

The root ACP prompt remains active while managed descendants are working or awaiting approval. Cancel interrupts the owned root and workers, including idle workers with unread mail. A new root instruction explicitly continues the workflow. Disconnect suspends owned processes and preserves their exact native identities; loading the session and sending another prompt resumes the recorded root. Worker continuation remains the root's decision.

## Current boundaries

- Text and resource links are accepted; images, audio, and embedded resources are rejected before native delivery.
- Native tools stream text output; the adapter does not synthesize client terminals or structured tool diffs. T3's workspace diff/checkpoint features remain client responsibilities.
- Stdio and HTTP MCP servers configured by the client pass through privately to native hosts. SSE is unsupported. Reconnecting with changed MCP configuration suspends the owned tree before refreshing it.
- Managed live transcripts/approvals cover Codex and Claude. OpenCode and pre-existing external sessions do not become owned ACP workers.
- Model-generated titles and app-side generation actions still need a suitable native provider.

## State and migration

Desktop data lives in `~/.crewcode`, separate from `~/.t3`. Crew ACP sessions live under `$CREW_HOME/adapters/acp` (normally `~/.crew/adapters/acp`). The adapter takes an exclusive claim when loading a session; do not remove claims held by a live connection.

Startup migrates the old generated `acp.mjs`/`crew-auto` provider configuration to `crew acp` and removes the obsolete native integration environment flags. Unrelated settings and explicit model choices are preserved. JSONC and custom agent commands are left to the normal settings loader. For a custom profile, add the local ACP provider manually.

Local CrewCode builds do not poll upstream T3 releases. Update Crew separately and replace the desktop app with a newer CrewCode build when updating this fork.

## Development and build

Install Node 24.13.1+ and pnpm 11, then run:

```bash
pnpm install --frozen-lockfile
pnpm crewcode --crew /absolute/path/to/crew/bin/crew
```

This development command prints a web URL. It uses `.crewcode` in this checkout by default; `--home /absolute/path` selects another profile. Repeating setup preserves user settings.

Build the native macOS app with repository dependencies, Xcode Command Line Tools, and Rust available:

```bash
pnpm crewcode:build:mac
```

The unsigned zip is written under `release/`. Add `--arch arm64` or `--arch x64` to select the architecture. The app invokes your separate Crew installation; it does not bundle another orchestration bridge. Signing, mobile branding, and hosted deployment are outside this fork's local build workflow.

For protocol behavior, run the tests in Crew's `test/acp*.test.ts`; this repository tests its ACP metadata presentation and desktop configuration separately. Fixture tests do not establish native authentication or desktop rendering. Real-provider and desktop evidence must be reported separately.
