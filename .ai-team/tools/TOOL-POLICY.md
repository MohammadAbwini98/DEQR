# Tool Policy & Least Privilege Enforcement

## Principles
1. **Least Privilege**: Each specialist role is granted access strictly to the tools required for its contract.
2. **Approval Gates**:
   - Package Installation (`npm install <pkg>`): Requires PM authorization.
   - Destructive Operations (`git reset --hard`, deleting source files): Prohibited without PM & Human approval.
   - External Network Commands: Forbidden under strict offline policy.
3. **Execution Verification**: No tool output may be assumed or hallucinated. Command execution logs must be captured and verified.
