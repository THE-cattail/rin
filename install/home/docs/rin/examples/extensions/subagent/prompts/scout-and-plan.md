> Adapted for Rin. Keep the original Pi name only when it refers to the upstream Pi SDK, package, or standalone CLI.
> In this local documentation set, read references to the runtime as Rin unless a quoted upstream package name, path, or command is being preserved verbatim.

---
description: Scout gathers context, planner creates implementation plan (no implementation)
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "scout" agent to find all code relevant to: $@
2. Then, use the "planner" agent to create an implementation plan for "$@" using the context from the previous step (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}. Do NOT implement - just return the plan.
