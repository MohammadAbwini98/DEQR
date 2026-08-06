# DEQR Known Issues Log

## Active Issues

- **BUG-001**: **LT Codes Fail at Low Block Counts (K)**
  - **Date**: 2026-08-06
  - **Component**: `FountainDecoder` (`src/core/fountain-decoder.ts`)
  - **Description**: The Robust Soliton degree distribution requires proportionally more frame overhead when the block count (K) is very small.
  - **Workaround**: Implemented Systematic Fountain Mode prefix in the core encoder. Frames 0 through K-1 emit exact source blocks. Frames K+ emit LT repair symbols.
  - **Status**: RESOLVED (ADR-004)
