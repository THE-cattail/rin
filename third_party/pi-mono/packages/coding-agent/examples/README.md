> Adapted for Rin. Keep the original Pi name only when it refers to the upstream Pi SDK, package, or standalone CLI.
> In this local documentation set, read references to the runtime as Rin unless a quoted upstream package name, path, or command is being preserved verbatim.

# Examples

Example code for Rin SDK and extensions.

## Directories

### [sdk/](sdk/)
Programmatic usage via `createAgentSession()`. Shows how to customize models, prompts, tools, extensions, and session management.

### [extensions/](extensions/)
Example extensions demonstrating:
- Lifecycle event handlers, tool interception, and safety gates
- Custom tools, commands, and keyboard shortcuts
- Custom UI such as footers, headers, editors, and overlays
- Git integration, system prompt changes, and custom compaction
- External integrations and custom providers

## Documentation

- [SDK Reference](sdk/README.md)
- [Extensions Documentation](../docs/extensions.md)
- [Skills Documentation](../docs/skills.md)
