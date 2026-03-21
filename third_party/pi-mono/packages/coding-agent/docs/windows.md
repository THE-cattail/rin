> Adapted for Rin. Keep the original Pi name only when it refers to the upstream Pi SDK, package, or standalone CLI.
> In this local documentation set, read references to the runtime as Rin unless a quoted upstream package name, path, or command is being preserved verbatim.

# Windows Setup

Rin requires a bash shell on Windows. Checked locations (in order):

1. Custom path from `~/.rin/settings.json`
2. Git Bash (`C:\Program Files\Git\bin\bash.exe`)
3. `bash.exe` on PATH (Cygwin, MSYS2, WSL)

For most users, [Git for Windows](https://git-scm.com/download/win) is sufficient.

## Custom Shell Path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```
