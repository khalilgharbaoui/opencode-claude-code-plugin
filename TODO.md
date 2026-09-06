# Deferred Checks

- 2026-09-06: User said "1 later" for observing `idleProcessTimeoutMs: 900000` in their live opencode window. Confirm the worker exits after 15 idle minutes and the next message resumes the conversation when the user is ready. Do not restart their other window or retry the dropped HTTP fetch.
