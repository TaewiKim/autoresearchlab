# Long-Run Multi-Agent Blueprint

Target:

- minimum 10 agents
- runtime at least 8 hours
- asynchronous orchestration
- Chronicle-mediated supervision

Recommended live roster:

1. `lab-director-01`
2. `chronicle-01`
3. `scout-01`
4. `scout-02`
5. `analyst-01`
6. `analyst-02`
7. `lab-runner-01`
8. `lab-runner-02`
9. `lab-runner-03`
10. `lab-runner-04`
11. `illustrator-01`
12. `author-01`
13. `author-02`

Runtime structure:

- `0h-2h`: exploration-heavy
- `2h-6h`: experiment-heavy
- `4h-8h`: synthesis-heavy

Chronicle cadence:

- brief every 20 minutes
- dialogue review every 30 minutes
- strategy checkpoint roughly every 1-2 hours

Decision policy:

- prefer `nudge` and `refine` early
- allow `pivot` only after repeated weak signals or conflict accumulation
- keep at least 4 experiment lanes active after hour 2
