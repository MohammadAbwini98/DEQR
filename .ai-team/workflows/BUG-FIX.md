# Workflow: Bug Fix

## Required Protocol

1. **Reproduction**: Capture exact failure log traceback or write failing automated test case reproducing the bug.
2. **Root Cause Analysis**: Trace upstream data flows or logic errors; avoid fixing symptoms.
3. **Smallest Safe Correction**: Apply surgical fix limited to root cause logic.
4. **Regression Coverage**: Add regression test case covering the exact defect scenario.
5. **Relevant Verification**: Run relevant test suite to confirm fix and zero side-effects.
6. **Documentation**: Record bug fix and any residual risks in `.ai-team/project-control/TASK-LOG.md`.

```text
Defect Report / Log Traceback
→ Reproduce via Test
→ Root Cause Identification
→ Minimal Surgical Fix
→ Regression Test Added
→ Full Test Suite Pass
→ Memory Logged by PM
```
